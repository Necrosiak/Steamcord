import types
import unittest
from unittest.mock import AsyncMock, Mock
from test_audio_overlay_regressions import methods


class PovSelectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = methods({'_sync_pov_users', 'set_pov_overlay_settings'})
        self.p._pov_ov_on, self.p.POV_MAX = True, 4
        self.p._pov_users, self.p._pov_init, self.p._pov_media_seen = set(), {}, set()
        self.settings = {'pov': {'source': 'auto', 'layout': 'right'}}
        self.p._load_overlay_settings = lambda: self.settings
        self.p._save_overlay_settings, self.p._write_overlay_state = Mock(), Mock()
        self.p._overlay_running = lambda: True
        self.p._overlay_caps = AsyncMock(return_value={'pov_format': 'webm'})
        self.send = AsyncMock()
        self.p.evt_handler = types.SimpleNamespace(send_client=self.send)
        self.state = {'me': {'id':'me'}, 'vc': {'users': [
            {'id':'me','is_live':True,'is_video':True}, {'id':'screen','is_live':True},
            {'id':'camera','is_video':True}, {'id':'both','is_live':True,'is_video':True}]}}

    async def test_selection_excludes_self_and_filters_sources(self):
        for source, expected in [('auto', {'screen','camera','both'}),
                                  ('screen', {'screen','both'}), ('camera', {'camera','both'})]:
            self.p._pov_users = set()
            self.settings['pov']['source'] = source
            self.send.reset_mock()
            await self.p._sync_pov_users(self.state)
            self.assertEqual(self.p._pov_users, expected)
            for call in self.send.await_args_list:
                self.assertEqual(call.args[0]['source'], source)

    async def test_change_restarts_recorders_and_invalid_source_preserves_settings(self):
        self.p.stop_pov_overlay, self.p.start_pov_overlay = AsyncMock(), AsyncMock(return_value={'ok':True})
        result = await self.p.set_pov_overlay_settings({'source':'camera'})
        self.assertTrue(result['ok'])
        self.p.stop_pov_overlay.assert_awaited_once()
        self.p.start_pov_overlay.assert_awaited_once()
        await self.p.set_pov_overlay_settings({'opacity':80})
        self.assertEqual(self.p.stop_pov_overlay.await_count,1)
        self.assertFalse((await self.p.set_pov_overlay_settings({'source':'invalid'}))['ok'])
        self.assertEqual(self.settings['pov']['source'],'camera')
