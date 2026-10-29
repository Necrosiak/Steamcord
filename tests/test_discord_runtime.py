import os
import ast
import asyncio
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tested_runtime', ROOT / 'defaults/discord_client/runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_backend_defaults_to_on(self):
        runtime = module.DiscordRuntime()
        self.assertTrue(runtime.enabled)
        self.assertEqual(await runtime.run_start(AsyncMock(return_value=42)), 42)

    async def test_off_suspends_start_without_retries_until_resume(self):
        runtime = module.DiscordRuntime()
        await runtime.pause()
        start = AsyncMock(return_value=42)
        owner = asyncio.create_task(runtime.run_start(start))
        await asyncio.sleep(.01)
        start.assert_not_awaited()
        self.assertFalse(owner.done())
        runtime.resume()
        self.assertEqual(await asyncio.wait_for(owner, 1), 42)
        start.assert_awaited_once()

    async def test_off_cancels_inflight_start_and_resume_uses_normal_factory(self):
        runtime = module.DiscordRuntime()
        entered, cancelled = asyncio.Event(), asyncio.Event()
        calls = 0

        async def start():
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
            return 'injected-tab'

        owner = asyncio.create_task(runtime.run_start(start))
        await entered.wait()
        await runtime.pause()
        self.assertTrue(cancelled.is_set())
        self.assertFalse(owner.done())
        await asyncio.sleep(.01)
        self.assertEqual(calls, 1)
        runtime.resume()
        self.assertEqual(await asyncio.wait_for(owner, 1), 'injected-tab')
        self.assertEqual(calls, 2)

    async def test_external_owner_cancellation_does_not_restart(self):
        runtime = module.DiscordRuntime()
        entered = asyncio.Event()

        async def start():
            entered.set()
            await asyncio.Event().wait()

        owner = asyncio.create_task(runtime.run_start(start))
        await entered.wait()
        owner.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await owner
        self.assertIsNone(runtime._start)

    async def test_parallel_start_factories_are_serialized(self):
        runtime = module.DiscordRuntime()
        active = maximum = 0

        async def start():
            nonlocal active, maximum
            active += 1
            maximum = max(active, maximum)
            await asyncio.sleep(0)
            active -= 1

        await asyncio.gather(runtime.run_start(start), runtime.run_start(start))
        self.assertEqual(maximum, 1)

    async def test_failed_start_does_not_poison_retry(self):
        runtime = module.DiscordRuntime()
        with self.assertRaises(RuntimeError):
            await runtime.run_start(AsyncMock(side_effect=RuntimeError('fixture')))
        self.assertEqual(await runtime.run_start(AsyncMock(return_value=42)), 42)


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    def methods(self, names, namespace):
        if 'set_discord_runtime' in names:
            names = names | {'_set_discord_runtime', '_emit_runtime_state'}
        namespace.setdefault('wait_for', asyncio.wait_for)
        namespace.setdefault('emit', AsyncMock())
        tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
        plugin = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Plugin')
        methods = [n for n in plugin.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
        isolated = ast.Module(body=[ast.ClassDef(name='Plugin', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
        exec(compile(ast.fix_missing_locations(isolated), '<actual-plugin-methods>', 'exec'), namespace)
        if 'set_discord_runtime' in names:
            # Never write the real ~/.config file from a test.
            namespace['Plugin']._save_voice_env = Mock(return_value=None)
        return namespace['Plugin']

    async def test_switch_is_remembered_across_restarts(self):
        runtime = module.DiscordRuntime()
        vesktop = types.SimpleNamespace(stop_managed=AsyncMock())
        plugin = self.methods({'set_discord_runtime'}, {'discord_runtime': runtime, 'logger': Mock()})
        plugin.evt_handler = types.SimpleNamespace(state_changed_event=Mock(), streaming_users=set(), remote_auth=Mock())
        plugin.discord_tab = None
        for name in ('stop_game_audio', 'stop_voice_overlay', 'stop_pov_overlay'):
            setattr(plugin, name, AsyncMock())
        with patch.dict(sys.modules, {'vesktop': vesktop}):
            await plugin.set_discord_runtime(False)
        plugin._save_voice_env.assert_called_with({'discord_off': True})
        await plugin.set_discord_runtime(True)
        plugin._save_voice_env.assert_called_with({'discord_off': False})
        await plugin.set_discord_runtime('false')
        self.assertEqual(plugin._save_voice_env.call_count, 2)

    def test_saving_keeps_the_other_settings(self):
        import tempfile, json
        tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
        plugin = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Plugin')
        methods = [n for n in plugin.body if isinstance(n, ast.FunctionDef)
                   and n.name in ('_save_voice_env', '_voice_env_cfg')]
        namespace = {'os': os, 'logger': Mock()}
        isolated = ast.Module(body=[ast.ClassDef(name='Plugin', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
        exec(compile(ast.fix_missing_locations(isolated), '<actual-plugin-methods>', 'exec'), namespace)
        Plugin = namespace['Plugin']
        with tempfile.TemporaryDirectory() as tmp:
            Plugin._VOICE_ENV_CFG = os.path.join(tmp, 'steamcord-voice-env.json')
            self.assertIsNone(Plugin._save_voice_env({'vesktop_desktop_off': True}))
            self.assertIsNone(Plugin._save_voice_env({'discord_off': True}))
            with open(Plugin._VOICE_ENV_CFG) as f:
                self.assertEqual(json.load(f), {'vesktop_desktop_off': True, 'discord_off': True})
            self.assertTrue(Plugin._voice_env_cfg()['discord_off'])

    async def test_stop_gates_recovery_before_process_and_keeps_login_storage(self):
        order = []
        runtime = module.DiscordRuntime()
        original_pause = runtime.pause

        async def pause():
            order.append('pause')
            await original_pause()

        runtime.pause = pause
        vesktop = types.SimpleNamespace(stop_managed=AsyncMock(side_effect=lambda: order.append('stop')))
        plugin = self.methods({'set_discord_runtime'}, {'discord_runtime': runtime, 'logger': Mock()})
        handler = types.SimpleNamespace(state_changed_event=Mock(), streaming_users=set(), remote_auth=Mock())
        plugin.evt_handler = handler
        plugin.discord_tab = types.SimpleNamespace(close_websocket=AsyncMock())
        for name in ('stop_game_audio', 'stop_voice_overlay', 'stop_pov_overlay'):
            setattr(plugin, name, AsyncMock())
        with patch.dict(sys.modules, {'vesktop': vesktop}):
            result = await plugin.set_discord_runtime(False)
        self.assertEqual(order, ['pause', 'stop'])
        self.assertEqual(result, {'ok': True, 'enabled': False})
        self.assertFalse(handler.discord_enabled)
        handler.remote_auth.start.assert_not_called()
        self.assertTrue((await plugin.set_discord_runtime(True))['enabled'])
        self.assertTrue(handler.discord_enabled)

    async def test_runtime_rpc_rejects_non_boolean(self):
        runtime = module.DiscordRuntime()
        plugin = self.methods({'set_discord_runtime'}, {'discord_runtime': runtime, 'logger': Mock()})
        self.assertFalse((await plugin.set_discord_runtime('false'))['ok'])
        self.assertTrue(runtime.enabled)

    async def test_overlapping_off_on_requests_are_serialized(self):
        runtime = module.DiscordRuntime()
        entered, release = asyncio.Event(), asyncio.Event()

        async def stop():
            entered.set()
            await release.wait()

        vesktop = types.SimpleNamespace(stop_managed=AsyncMock(side_effect=stop))
        plugin = self.methods({'set_discord_runtime'}, {'discord_runtime': runtime, 'logger': Mock()})
        plugin.evt_handler = types.SimpleNamespace(state_changed_event=Mock(), streaming_users=set(), remote_auth=Mock())
        plugin.discord_tab = None
        for name in ('stop_game_audio', 'stop_voice_overlay', 'stop_pov_overlay'):
            setattr(plugin, name, AsyncMock())
        with patch.dict(sys.modules, {'vesktop': vesktop}):
            off = asyncio.create_task(plugin.set_discord_runtime(False))
            await asyncio.wait_for(entered.wait(), 1)
            on = asyncio.create_task(plugin.set_discord_runtime(True))
            await asyncio.sleep(0)
            self.assertFalse(on.done())
            self.assertFalse(runtime.enabled)
            release.set()
            self.assertTrue((await off)['ok'])
            self.assertTrue((await on)['enabled'])

    async def test_media_cleanup_failure_still_stops_vesktop(self):
        runtime = module.DiscordRuntime()
        vesktop = types.SimpleNamespace(stop_managed=AsyncMock())
        plugin = self.methods({'set_discord_runtime'}, {'discord_runtime': runtime, 'logger': Mock()})
        plugin.evt_handler = types.SimpleNamespace(state_changed_event=Mock(), streaming_users=set(), remote_auth=Mock())
        plugin.discord_tab = None
        plugin.stop_game_audio = AsyncMock(side_effect=RuntimeError('fixture'))
        plugin.stop_voice_overlay = AsyncMock()
        plugin.stop_pov_overlay = AsyncMock()
        with patch.dict(sys.modules, {'vesktop': vesktop}):
            self.assertTrue((await plugin.set_discord_runtime(False))['ok'])
        vesktop.stop_managed.assert_awaited_once()

    async def test_captcha_rpc_times_out_without_private_exception_text(self):
        wait = AsyncMock(side_effect=asyncio.TimeoutError())
        plugin = self.methods({'captcha_frame'}, {'wait_for': wait, 'logger': Mock()})
        plugin._captcha_frame = Mock(return_value='fixture-awaitable')
        self.assertIsNone(await plugin.captcha_frame())
        wait.assert_awaited_once_with('fixture-awaitable', 12)

    async def test_runtime_state_broadcast_failure_does_not_abort_stop(self):
        runtime = module.DiscordRuntime()
        emit = AsyncMock(side_effect=RuntimeError('fixture'))
        vesktop = types.SimpleNamespace(stop_managed=AsyncMock())
        plugin = self.methods({'set_discord_runtime'}, {
            'discord_runtime': runtime, 'logger': Mock(), 'emit': emit})
        plugin.evt_handler = types.SimpleNamespace(state_changed_event=Mock(), streaming_users=set(),
            remote_auth=Mock(), build_state_dict=Mock(return_value={'loaded': False}))
        plugin.discord_tab = None
        for name in ('stop_game_audio', 'stop_voice_overlay', 'stop_pov_overlay'):
            setattr(plugin, name, AsyncMock())
        with patch.dict(sys.modules, {'vesktop': vesktop}):
            self.assertTrue((await plugin.set_discord_runtime(False))['ok'])
        emit.assert_awaited_once()
        vesktop.stop_managed.assert_awaited_once()

    async def test_actual_watchdog_waits_quietly_then_reinitializes_on_resume(self):
        runtime = module.DiscordRuntime()
        await runtime.pause()
        tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
        method = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'watchdog')
        initialize = AsyncMock()
        vesktop = types.SimpleNamespace(is_up=AsyncMock(return_value=False))
        namespace = {'discord_runtime': runtime, 'Tab': object, 'sleep': asyncio.sleep,
                     'initialize': initialize, 'logger': Mock(),
                     'Plugin': types.SimpleNamespace(evt_handler=types.SimpleNamespace(reset_stream_state=Mock()))}
        exec(compile(ast.Module(body=[method], type_ignores=[]), '<actual-watchdog>', 'exec'), namespace)
        tab = types.SimpleNamespace(websocket=types.SimpleNamespace(closed=True))
        with patch.dict(sys.modules, {'vesktop': vesktop}):
            task = asyncio.create_task(namespace['watchdog'](tab))
            await asyncio.sleep(.01)
            vesktop.is_up.assert_not_awaited()
            initialize.assert_not_awaited()
            runtime.resume()
            await asyncio.wait_for(task, 1)
        initialize.assert_awaited_once()

    def test_all_account_relaunches_and_watchdog_use_runtime_gate(self):
        tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
        direct = [n for n in ast.walk(tree) if isinstance(n, ast.Await)
                  and isinstance(n.value, ast.Call) and ast.unparse(n.value.func) == 'vesktop.launch']
        self.assertEqual(direct, [])
        watchdog = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'watchdog')
        self.assertIn('await discord_runtime.wait_enabled()', ast.unparse(watchdog))

    def test_new_modules_live_inside_existing_updatable_directory(self):
        for name in ('runtime.py', 'overlay_environment.py'):
            self.assertTrue((ROOT / 'defaults/discord_client' / name).is_file())
        main = (ROOT / 'main.py').read_text(encoding='utf-8')
        self.assertIn('from discord_client.runtime import DiscordRuntime', main)
        self.assertIn('from discord_client.overlay_environment import overlay_environment', main)


if __name__ == '__main__':
    unittest.main()
