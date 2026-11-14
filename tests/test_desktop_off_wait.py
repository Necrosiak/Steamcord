"""#99: waiting for Game Mode (option #66) is reported, and can be left."""
import ast
import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock

from test_audio_overlay_regressions import methods

ROOT = Path(__file__).resolve().parents[1]


class Stop(Exception):
    pass


def load_initialize(namespace):
    tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
    fn = next(x for x in tree.body if isinstance(x, ast.AsyncFunctionDef) and x.name == '_initialize_discord')
    exec(compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<init>', 'exec'), namespace)
    return namespace['_initialize_discord']


class DesktopOffWaitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        sys.modules.setdefault('vesktop', types.ModuleType('vesktop'))
        self.p = methods({'_set_waiting_game_mode'})
        self.p.evt_handler = types.SimpleNamespace(state_changed_event=Mock())
        self.option = True
        self.p._vesktop_desktop_off = classmethod(lambda cls: self.option).__get__(None, self.p)
        self.seen = []

        async def fake_sleep(_):
            self.seen.append(self.p.evt_handler.waiting_game_mode)
            if len(self.seen) == 2:
                self.option = False   # the user presses "turn this option off"

        def stop():
            raise Stop()

        self.init = load_initialize({
            'Plugin': self.p, '_desktop_session': lambda: True, 'sleep': fake_sleep,
            'logger': Mock(), 'host': types.SimpleNamespace(WINDOWS=False), '_log_tool_report': stop,
            '__builtins__': __builtins__,
        })

    async def test_waiting_is_reported_then_cleared_when_option_is_turned_off(self):
        with self.assertRaises(Stop):           # reached the real start-up
            await self.init()
        self.assertEqual(self.seen, [True, True])
        self.assertFalse(self.p.evt_handler.waiting_game_mode)
        self.assertGreaterEqual(self.p.evt_handler.state_changed_event.set.call_count, 2)

    async def test_waiting_flag_cleared_if_start_up_is_cancelled(self):
        blocked = asyncio.Event()

        async def block(_):
            blocked.set()
            await asyncio.Event().wait()
        self.init.__globals__['sleep'] = block
        task = asyncio.ensure_future(self.init())
        await blocked.wait()
        self.assertTrue(self.p.evt_handler.waiting_game_mode)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.p.evt_handler.waiting_game_mode)

    async def test_no_wait_outside_desktop_or_without_option(self):
        self.option = False
        with self.assertRaises(Stop):
            await self.init()
        self.assertEqual(self.seen, [])
        self.assertFalse(hasattr(self.p.evt_handler, 'waiting_game_mode'))


class StateDictTests(unittest.TestCase):
    def build(self, **attrs):
        handler = methods({'build_state_dict'}, source='defaults/discord_client/event_handler.py', klass='EventHandler')
        obj = handler.__new__(handler)
        obj.loaded, obj.logged_in, obj._qr_scanned, obj._captcha_needed = True, True, False, False
        obj.me = types.SimpleNamespace(to_dict=lambda: {})
        obj._build_vc_dict = lambda: None
        obj.remote_auth = types.SimpleNamespace(qr_b64=None)
        for k, v in attrs.items():
            setattr(obj, k, v)
        return obj.build_state_dict()

    def test_waiting_hides_a_stale_loaded_state(self):
        # Measured on the BC-250: switching to Desktop Mode kept loaded=True.
        state = self.build(waiting_game_mode=True)
        self.assertEqual((state['waiting_game_mode'], state['loaded'], state['logged_in']), (True, False, False))

    def test_normal_state_unchanged(self):
        state = self.build()
        self.assertEqual((state['waiting_game_mode'], state['loaded'], state['logged_in']), (False, True, True))
        self.assertFalse(self.build(discord_enabled=False)['loaded'])


if __name__ == '__main__':
    unittest.main()
