"""New Go Live return streams must not inherit an old mix attenuation."""
import json
import types
import unittest
from unittest.mock import AsyncMock
from test_audio_overlay_regressions import methods


class GoLiveGainTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_bridge_resets_its_sink_and_return_once_without_changing_game_volume(self):
        p = methods({'_golive_share_bridge'})
        p._golive_bridge_mods, p._MONITOR_LOOP = [], ()
        p._SHARE_LABEL, p._BRIDGE_TAG = 'vencord-screen-share', 'steamcord-bridge'
        p._audio_out, p._ga_active = 'physical-headset', False
        p._golive_route_game, p._golive_bridge_unity = AsyncMock(), AsyncMock()
        modules = iter(['1', '2', '3'])
        async def pactl(*args, **kwargs):
            return next(modules) if args[0] == 'load-module' else ''
        p._pactl = AsyncMock(side_effect=pactl)
        await p._golive_share_bridge(True)
        p._golive_bridge_unity.assert_awaited_once_with('3')
        p._golive_route_game.assert_awaited_once_with(True)
        self.assertEqual([c.args for c in p._pactl.await_args_list if c.args[0].startswith('set-')],
                         [('set-sink-volume', 'steamcord_share_sink', '100%')])
        await p._golive_share_bridge(True)
        self.assertEqual(p._golive_bridge_unity.await_count, 1)

    async def test_only_new_bridge_module_streams_are_reset(self):
        p = methods({'_golive_bridge_unity'})
        calls = []
        async def pactl(*args, **kwargs):
            calls.append(args)
            if args[:2] == ('list', 'sink-inputs'):
                return json.dumps([{'index': 10, 'owner_module': 42},
                                   {'index': 11, 'owner_module': 43}, {'index': 12}])
            if args[:2] == ('list', 'source-outputs'):
                return json.dumps([{'index': 20, 'owner_module': '42'},
                                   {'index': 21, 'owner_module': 43}])
            return ''
        p._pactl = AsyncMock(side_effect=pactl)
        await p._golive_bridge_unity('42')
        self.assertEqual([c for c in calls if c[0].startswith('set-')], [
            ('set-sink-input-volume', '10', '100%'),
            ('set-source-output-volume', '20', '100%')])

    async def test_missing_bridge_never_changes_other_streams(self):
        p = methods({'_golive_bridge_unity'})
        p._pactl = AsyncMock(return_value=json.dumps([{'index': 1, 'owner_module': 9}]))
        await p._golive_bridge_unity('42')
        self.assertFalse(any(call.args[0].startswith('set-') for call in p._pactl.await_args_list))
