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
    namespace.update(os=os, tempfile=tempfile, time=types.SimpleNamespace(time=lambda: 0), logger=Mock(),
                     host=types.SimpleNamespace(WINDOWS=False), linux_only=lambda _: lambda fn: fn)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(
        name=klass, bases=[], keywords=[], body=body, decorator_list=[])], type_ignores=[])), '<backend>', 'exec'), namespace)
    return namespace[klass]


class ChatMixTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = methods({'_apply_chat_mix', '_apply_chat_mix_locked', '_chat_mix_levels',
                          'get_chat_mix', 'set_chat_mix_enabled', '_mix_app_key',
                          '_load_mix_apps', '_save_mix_apps'})
        self.p._chat_mix, self.p._chat_mix_enabled = 75, True
        self.p._mix_touched, self.p._chat_mix_lock = {}, None
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p._mix_apps, self.p._MIX_APPS_CFG = None, os.path.join(self.tmp.name, 'chatmix-apps.json')
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

    async def test_transient_missing_output_does_not_restore_loud_game_volume(self):
        await self.p._apply_chat_mix()
        reduced = [v['value'] for v in self.inputs[0]['volume'].values()]
        self.writes.clear()
        self.p._real_output_sink.return_value = None
        await self.p._apply_chat_mix()
        self.assertEqual(self.writes, [])
        self.assertEqual([v['value'] for v in self.inputs[0]['volume'].values()], reduced)
        self.assertIn('1', self.p._mix_touched)
        self.p._real_output_sink.return_value = 'speakers'
        await self.p._apply_chat_mix()
        self.assertEqual(self.writes, [])
        await self.p.set_chat_mix_enabled(False)
        self.assertTrue(self.writes)  # Explicit disable still restores the baseline.

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

    async def test_reopened_app_is_not_reduced_again_and_is_restored_after_the_call(self):
        # #96: WirePlumber gives an application's next stream the volume we set
        # on its previous one. That must not become a new, lower baseline.
        self.inputs = [self.stream(1, 'edge', [100, 100])]
        await self.p._apply_chat_mix()                       # mix 75 -> game at 50 %
        self.assertEqual(self.inputs[0]['volume']['0']['value_percent'], '50%')
        for idx in (2, 3, 4):                                # Edge closed, reopened 3 times
            self.inputs = [self.stream(idx, 'edge', [50, 50])]
            await self.p._apply_chat_mix()
            self.assertEqual([v['value_percent'] for v in self.inputs[0]['volume'].values()], ['50%', '50%'])
        self.p._in_call.return_value = False                 # call ends: back to 100 %
        await self.p._apply_chat_mix()
        self.assertEqual([v['value_percent'] for v in self.inputs[0]['volume'].values()], ['100%', '100%'])
        self.assertFalse(self.p._mix_apps)

    async def test_inherited_volume_is_restored_after_a_restart_when_the_call_is_over(self):
        self.inputs = [self.stream(1, 'edge', [100, 100])]
        await self.p._apply_chat_mix()
        self.p._mix_apps, self.p._mix_touched = None, {}     # plugin restarted
        self.p._in_call.return_value = False
        self.inputs = [self.stream(5, 'edge', [50, 50])]     # Edge reopened later
        await self.p._apply_chat_mix()
        self.assertEqual([v['value_percent'] for v in self.inputs[0]['volume'].values()], ['100%', '100%'])

    async def test_a_user_chosen_volume_is_not_mistaken_for_ours(self):
        self.inputs = [self.stream(1, 'edge', [100, 100])]
        await self.p._apply_chat_mix()
        self.inputs = [self.stream(2, 'edge', [30, 30])]     # user set 30 % meanwhile
        self.p._in_call.return_value = False
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertFalse(self.writes)

    async def test_volume_calls_are_serialized(self):
        await asyncio.gather(*(self.p._apply_chat_mix() for _ in range(3)))
        self.assertEqual(len(self.writes), 1)

    async def test_interface_events_are_not_attenuated_or_given_another_steam_baseline(self):
        self.inputs = [self.stream(1, 'steam', [100, 100])]
        await self.p._apply_chat_mix()
        ui = self.stream(2, 'steam', [50, 50])
        ui['properties']['media.role'] = 'event'
        self.inputs = [ui]
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertFalse(self.writes)
        self.assertEqual(ui['volume']['0']['value_percent'], '50%')

    async def test_owned_stream_becoming_an_interface_event_is_restored_once(self):
        await self.p._apply_chat_mix()
        self.inputs[0]['properties']['media.role'] = 'event'
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertEqual(self.inputs[0]['volume']['0']['value_percent'], '60%')
        self.writes.clear()
        await self.p._apply_chat_mix()
        self.assertFalse(self.writes)

    async def test_disable_rejects_ambiguous_string(self):
        self.assertEqual(await self.p.set_chat_mix_enabled('false'), {'ok': False})
        self.p._save_audio_cfg.assert_not_called()


class OverlayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = methods({'_load_overlay_settings', '_save_overlay_settings', 'set_voice_overlay_settings',
                          'start_voice_overlay', 'stop_voice_overlay', '_sync_overlay_state', '_write_overlay_state',
                          '_overlay_name'})
        self.p.OV_NAME_MODES = ('nick', 'global', 'username')
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

    async def test_overlay_names_follow_discord_unless_another_name_is_chosen(self):
        users = [{'id': 'a', 'username': 'login_a', 'global_name': 'Display A', 'nick': 'Server A'},
                 {'id': 'b', 'username': 'login_b', 'global_name': 'Display B', 'nick': ''},
                 {'id': 'c', 'username': 'login_c', 'global_name': '', 'nick': ''}]
        expected = {'nick': ['Server A', 'Display B', 'login_c'],
                    'global': ['Display A', 'Display B', 'login_c'],
                    'username': ['login_a', 'login_b', 'login_c']}
        self.p._voice_ov_on = True
        self.assertEqual(self.p._load_overlay_settings()['voice']['names'], 'nick')
        for mode, names in expected.items():
            self.assertTrue((await self.p.set_voice_overlay_settings({'names': mode}))['ok'])
            self.p._write_overlay_state({'me': {}, 'vc': {'channel_id': 'a', 'users': users}})
            payload = json.loads(Path(self.tmp.name, 'voice_state.json').read_text(encoding="utf-8"))
            self.assertEqual([u['username'] for u in payload['voice']['users']], names, mode)
        self.assertFalse((await self.p.set_voice_overlay_settings({'names': 'junk'}))['ok'])
        self.assertEqual(self.p._load_overlay_settings()['voice']['names'], 'username')

    def test_voice_members_get_display_name_and_server_nickname(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('sc_store_access', ROOT / 'defaults/discord_client/store_access.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        api = types.SimpleNamespace(
            get_user=AsyncMock(return_value={'username': 'login', 'discriminator': '0', 'avatar': None,
                                             'globalName': 'Display'}),
            get_nick=AsyncMock(return_value='Server'))
        member = mod.User({'id': '1', 'username': '', 'discriminator': None, 'avatar': ''})
        asyncio.run(member.populate(api, 'guild'))
        api.get_nick.assert_awaited_once_with('guild', '1')
        self.assertEqual((member.to_dict()['username'], member.global_name, member.to_dict()['nick']),
                         ('login', 'Display', 'Server'))
        api.get_nick.reset_mock()
        dm = mod.User({'id': '2', 'username': '', 'discriminator': None, 'avatar': ''})
        asyncio.run(dm.populate(api))
        api.get_nick.assert_not_awaited()
        self.assertEqual((dm.global_name, dm.nick), ('Display', ''))

        access = mod.StoreAccess()
        access._store_access_request = AsyncMock(side_effect=Exception('discord_reconnecting'))
        self.assertEqual(asyncio.run(access.get_nick('guild', '1')), '')
        access._store_access_request = AsyncMock(return_value=None)
        self.assertEqual(asyncio.run(access.get_nick('guild', '1')), '')

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


    def test_viewers_of_my_stream_are_flagged_only_while_i_stream(self):
        # #92 : l'overlay vocal montre qui regarde mon Go Live.
        handler = methods({'_build_vc_dict', '_stream_viewers'}, source='defaults/discord_client/event_handler.py',
                          klass='EventHandler')()
        handler.me = types.SimpleNamespace(id='self', is_muted=False, is_deafened=False, is_speaking=False, is_live=True)
        members = {}
        for uid in ('self', 'a', 'b'):
            m = types.SimpleNamespace(id=uid, is_muted=False, is_deafened=False, is_video=False)
            m.to_dict = (lambda m: lambda: vars(m))(m)
            members[uid] = m
        handler.vc_channel_id, handler.vc_members, handler.streaming_users = 'c', members, set()
        handler.api = types.SimpleNamespace(_channel_name='voice', _guild_name='server')
        asyncio.run(handler._stream_viewers({'ids': ['a', 42, None]}))
        self.assertEqual(handler.stream_viewers, {'a', '42'})
        users = {u['id']: u for u in handler._build_vc_dict()['users']}
        self.assertTrue(users['a']['is_watching_me'])
        self.assertFalse(users['b']['is_watching_me'])
        handler.me.is_live = False
        self.assertFalse({u['id']: u for u in handler._build_vc_dict()['users']}['a']['is_watching_me'])
        asyncio.run(handler._stream_viewers({'ids': 'junk'}))
        self.assertEqual(handler.stream_viewers, set())

class OverlayCairoTests(unittest.TestCase):
    def test_centered_cairo_roster_tracks_participant_count_and_both_badges(self):
        import math
        renderer = methods({'on_draw', '_display_scale'}, source='defaults/game_overlay/overlay.py', klass='RosterArea',
                           cairo=Mock(), PangoCairo=Mock(), math=math)()
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
        # #103 : haut / bas au centre, rangées centrées horizontalement.
        for pos, top in (('top-center', True), ('bottom-center', False)):
            renderer._rounded.reset_mock()
            renderer.voice = {'enabled': True, 'settings': {'pos': pos},
                              'users': [{'username': 'self'}] * 2}
            renderer.on_draw(None, Mock())
            rows = [call.args for call in renderer._rounded.call_args_list]
            self.assertEqual(len(rows), 2)
            for row in rows:
                self.assertAlmostEqual(row[1] + row[3] / 2, 640)
            self.assertEqual(rows[0][2] < 400, top)


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
