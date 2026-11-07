"""Execute the actual backend methods without Decky, devices or account data."""
import ast
import asyncio
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock

ROOT = Path(__file__).resolve().parents[1]


def methods(names, source='main.py', klass='Plugin', **namespace):
    tree = ast.parse((ROOT / source).read_text(encoding='utf-8'))
    cls = next(x for x in tree.body if isinstance(x, ast.ClassDef) and x.name == klass)
    body = [x for x in cls.body if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef)) and x.name in names]
    assert len(body) == len(names), names - {x.name for x in body}
    namespace.update(os=os, time=types.SimpleNamespace(time=lambda: 0), logger=Mock(),
                     host=types.SimpleNamespace(WINDOWS=False), linux_only=lambda _: lambda fn: fn)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(
        name=klass, bases=[], keywords=[], body=body, decorator_list=[])], type_ignores=[])), '<backend>', 'exec'), namespace)
    return namespace[klass]


class ChatMixTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = methods({'_apply_chat_mix', '_apply_chat_mix_locked', '_chat_mix_levels',
                          'get_chat_mix', 'set_chat_mix_enabled'})
        self.p._chat_mix, self.p._chat_mix_enabled = 75, True
        self.p._mix_touched, self.p._chat_mix_lock = {}, None
        self.p._in_call = Mock(return_value=True)
        self.p._chat_mix_game_mode = Mock(return_value=True)
        self.p._real_output_sink = AsyncMock(return_value='speakers')
        self.p._save_audio_cfg = Mock()
        self.p._is_vesktop_stream = lambda si: si['properties']['application.process.binary'] == 'vesktop'
        self.inputs = [self.stream(1, 'game', [60, 40]), self.stream(2, 'vesktop', [75, 75])]
        self.writes = []

        async def pactl(*args, **kwargs):
            if args[0] == 'set-sink-input-volume':
                self.writes.append(args)
                si = next(x for x in self.inputs if str(x['index']) == args[1])
                for channel, value in zip(si['volume'].values(), args[2:]):
                    raw = round(float(value[:-1]) / 100 * 65536) if value.endswith('%') else int(value)
                    channel.update(value=raw, value_percent=f'{round(raw / 65536 * 100)}%')
                return ''
            if args[:2] == ('list', 'sink-inputs'):
                return json.dumps(self.inputs)
            if args[:2] == ('list', 'sinks'):
                return json.dumps([{'name': 'speakers', 'index': 7}])
            return ''
        self.p._pactl = AsyncMock(side_effect=pactl)

    @staticmethod
    def stream(idx, binary, volumes):
        return {'index': idx, 'client': idx, 'sink': 7, 'properties': {
            'application.process.id': str(idx), 'application.process.binary': binary, 'media.name': 'audio'},
            'volume': {str(i): {'value': round(v / 100 * 65536), 'value_percent': f'{v}%'} for i, v in enumerate(volumes)}}

    async def test_desktop_and_disabled_do_not_touch_unowned_streams(self):
        self.p._chat_mix_game_mode.return_value = False
        await self.p._apply_chat_mix()
        self.p._pactl.assert_not_awaited()
        self.p._chat_mix_game_mode.return_value = True
        await self.p.set_chat_mix_enabled(False)
        self.p._pactl.assert_not_awaited()
        self.assertFalse((await self.p.get_chat_mix())['enabled'])

    async def test_mix_preserves_channel_baseline_and_restores_exact_original(self):
        originals = [[v['value'] for v in x['volume'].values()] for x in self.inputs]
        await self.p._apply_chat_mix()
        self.assertEqual(self.writes, [('set-sink-input-volume', '1', '30%', '20%')])
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertEqual(self.writes, [])
        await self.p.set_chat_mix_enabled(False)
        self.assertEqual([[v['value'] for v in x['volume'].values()] for x in self.inputs], originals)
        self.assertFalse(self.p._mix_touched)

    async def test_manual_mixer_change_is_not_overwritten_when_leaving_game_mode(self):
        await self.p._apply_chat_mix()
        self.inputs[0]['volume'] = self.stream(1, 'game', [65, 65])['volume']
        self.p._chat_mix_game_mode.return_value = False
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertFalse(any(x[1] == '1' for x in self.writes))

    async def test_recycled_input_id_does_not_restore_another_application(self):
        await self.p._apply_chat_mix()
        self.inputs[0] = self.stream(1, 'other-app', [20, 20])
        self.p._in_call.return_value = False
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertFalse(any(x[1] == '1' for x in self.writes))

    async def test_repeated_fractional_gain_does_not_attenuate_again(self):
        self.inputs[0]['volume'] = self.stream(1, 'game', [69, 43])['volume']
        await self.p._apply_chat_mix()
        self.writes.clear()
        for _ in range(4):
            await self.p._apply_chat_mix()
        self.assertFalse(self.writes)

    async def test_volume_calls_are_serialized(self):
        await asyncio.gather(*(self.p._apply_chat_mix() for _ in range(3)))
        self.assertEqual(len(self.writes), 1)

    async def test_disable_rejects_ambiguous_string(self):
        self.assertEqual(await self.p.set_chat_mix_enabled('false'), {'ok': False})
        self.p._save_audio_cfg.assert_not_called()


class OverlayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = methods({'_load_overlay_settings', '_save_overlay_settings',
                          'start_voice_overlay', 'stop_voice_overlay', '_sync_overlay_state', '_write_overlay_state'})
        self.p._OVERLAY_CFG = os.path.join(self.tmp.name, 'prefs.json')
        self.p._overlay_settings = None
        self.p._voice_ov_on = False
        self.p._pov_ov_on = False
        self.p._voice_restore_channel = None
        self.p._ensure_overlay_window = AsyncMock(return_value=True)
        self.p._maybe_stop_overlay_window = AsyncMock()
        self.p._overlay_running = lambda: self.p._voice_ov_on
        self.p.stop_pov_overlay = AsyncMock()
        self.p._sync_pov_users = AsyncMock()
        self.p._overlay_dir = lambda: self.tmp.name
        self.p._ov_track_members = lambda *args: []
        self.p.OV_EVENT_MS = 5000
        self.p.POV_FEED_URL = 'local-test'
        self.p.evt_handler = types.SimpleNamespace(build_state_dict=lambda: {'vc': None})

    async def test_activation_survives_call_end_and_restart_but_explicit_off_is_saved(self):
        await self.p.start_voice_overlay()
        await self.p._sync_overlay_state({'vc': None})
        self.assertFalse(self.p._voice_ov_on)
        self.p._overlay_settings = None
        self.assertTrue(self.p._load_overlay_settings()['voice']['enabled'])
        await self.p._sync_overlay_state({'vc': {'channel_id': 'next-call'}})
        self.assertTrue(self.p._voice_ov_on)
        await self.p.stop_voice_overlay()
        await self.p._sync_overlay_state({'vc': {'channel_id': 'next-call'}})
        self.assertFalse(self.p._voice_ov_on)
        self.p._overlay_settings = None
        self.assertFalse(self.p._load_overlay_settings()['voice']['enabled'])

    async def test_failed_helper_is_not_retried_on_every_speaking_event(self):
        self.p._ensure_overlay_window.return_value = False
        await self.p.start_voice_overlay()
        self.p._ensure_overlay_window.reset_mock()
        for _ in range(3):
            await self.p._sync_overlay_state({'vc': {'channel_id': 'a'}})
        self.assertEqual(self.p._ensure_overlay_window.await_count, 1)
        await self.p._sync_overlay_state({'vc': None})
        await self.p._sync_overlay_state({'vc': {'channel_id': 'b'}})
        self.assertEqual(self.p._ensure_overlay_window.await_count, 2)

    async def test_overlay_uses_authoritative_self_mute_deaf_and_preserves_live(self):
        self.p._write_overlay_state({'me': {'id': 'self', 'is_muted': True, 'is_deafened': True},
            'vc': {'channel_id': 'a', 'users': [{'id': 'self', 'is_muted': False, 'is_live': True}]}})
        payload = json.loads(Path(self.tmp.name, 'voice_state.json').read_text(encoding="utf-8"))
        self.assertTrue(payload['voice']['users'][0]['is_muted'])
        self.assertTrue(payload['voice']['users'][0]['is_deafened'])
        self.assertTrue(payload['voice']['users'][0]['is_live'])

    def test_self_member_uses_current_media_flags_without_losing_camera(self):
        handler = methods({'_build_vc_dict'}, source='defaults/discord_client/event_handler.py', klass='EventHandler')()
        handler.me = types.SimpleNamespace(id='self', is_muted=True, is_deafened=True, is_speaking=True, is_live=True)
        cached = types.SimpleNamespace(id='self', is_muted=False, is_deafened=False, is_video=True)
        cached.to_dict = lambda: vars(cached)
        handler.vc_channel_id = 'a'
        handler.vc_members = {'self': cached}
        handler.streaming_users = set()
        handler.api = types.SimpleNamespace(_channel_name='voice', _guild_name='server')
        user = handler._build_vc_dict()['users'][0]
        for flag in ('is_muted', 'is_deafened', 'is_speaking', 'is_live', 'is_video'):
            self.assertTrue(user[flag], flag)


class OverlayCairoTests(unittest.TestCase):
    def test_centered_cairo_roster_tracks_participant_count_and_both_badges(self):
        renderer = methods({'on_draw'}, source='defaults/game_overlay/overlay.py', klass='RosterArea',
                           cairo=Mock(), PangoCairo=Mock())()
        tree = ast.parse((ROOT / 'defaults/game_overlay/overlay.py').read_text(encoding="utf-8"))
        actual = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'RosterArea')
        for n in actual.body:
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant):
                setattr(renderer, n.targets[0].id, n.value.value)
        renderer.get_allocated_width = lambda: 1280
        renderer.get_allocated_height = lambda: 800
        renderer._layout = lambda *args: types.SimpleNamespace(get_pixel_size=lambda: (40, 13))
        renderer._draw_pov = Mock()
        renderer._draw_avatar, renderer._draw_badge = Mock(), Mock()
        renderer._avatar = lambda _: None
        renderer._rounded = Mock()
        for count in (1, 3):
            for pos in ('center-left', 'center-right'):
                renderer._rounded.reset_mock()
                renderer._draw_badge.reset_mock()
                renderer.voice = {'enabled': True, 'settings': {'pos': pos, 'opacity': 60},
                                  'users': [{'username': 'self', 'is_deafened': True, 'is_live': True}] * count}
                cr = Mock()
                renderer.on_draw(None, cr)
                rows = [call.args for call in renderer._rounded.call_args_list]
                self.assertEqual(len(rows), count)
                row_h = rows[0][4]
                self.assertAlmostEqual((rows[0][2] + rows[-1][2] + row_h) / 2, 400)
                self.assertEqual(renderer._draw_badge.call_count, count * 2)
                cr.paint_with_alpha.assert_called_once_with(.6)


class AudioSettingsTests(unittest.TestCase):
    def test_toggle_and_mix_persist_without_losing_device_and_mic_preferences(self):
        p = methods({'_load_audio_cfg', '_save_audio_cfg'})
        with tempfile.TemporaryDirectory() as tmp:
            p._AUDIO_CFG = os.path.join(tmp, 'audio.json')
            p._audio_out, p._audio_in = 'headphones', 'microphone'
            p._mic_prefs, p._ga_vol = {'noise': 'krisp'}, {'voice': 80, 'game': 55}
            p._chat_mix, p._chat_mix_enabled = 75, False
            p._save_audio_cfg()
            p._chat_mix, p._chat_mix_enabled = 50, True
            p._load_audio_cfg()
            self.assertEqual(p._chat_mix, 75)
            self.assertFalse(p._chat_mix_enabled)
            self.assertEqual(p._audio_out, 'headphones')
            self.assertEqual(p._mic_prefs, {'noise': 'krisp'})
