"""Support reports: execute backend methods without Decky or account access."""
import json
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from test_audio_overlay_regressions import methods


class SupportDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.updater = types.SimpleNamespace(get_current_version=lambda: '1.44.0')
        self.p = methods({'_diagnostic_system', 'get_game_diagnostics', 'get_video_diagnostics'},
                         updater=self.updater, dumps=json.dumps)
        self.host = self.p._diagnostic_system.__func__.__globals__['host']
        self.host.NAME = 'linux'
        self.p.get_share_env = AsyncMock(return_value={'env': 'gamescope'})
        self.p._rpc_pref = Mock(return_value=True)
        self.p._rpc_detect_pref = Mock(return_value=True)
        self.p._rpc_override_pref = Mock(return_value='private manual title')
        self.p._rpc_payload = AsyncMock(return_value={'game': 'GeForce NOW', 'procs': ['private.exe']})
        self.p.get_cloud_game_status = AsyncMock(return_value={
            'game': 'private game', 'reason': 'detected', 'source': 'x11-title'})
        self.cloud = types.SimpleNamespace(is_geforce_launcher=lambda title: title == 'GeForce NOW')

    async def test_linux_reports_only_distribution_id_and_version(self):
        with patch('platform.release', return_value='fixture-kernel'), patch(
                'platform.freedesktop_os_release', return_value={
                    'ID': 'steamos', 'VERSION_ID': '3.9.5', 'HOME_URL': 'private-url'}):
            report = self.p._diagnostic_system()
        self.assertEqual(report, {'host': 'linux', 'kernel': 'fixture-kernel',
                                  'steamcord_version': '1.44.0',
                                  'distribution': {'ID': 'steamos', 'VERSION_ID': '3.9.5'}})

    async def test_missing_linux_release_file_does_not_break_support_report(self):
        with patch('platform.freedesktop_os_release', side_effect=OSError):
            self.assertNotIn('distribution', self.p._diagnostic_system())

    async def test_windows_reports_build_without_querying_linux_release(self):
        self.host.WINDOWS, self.host.NAME = True, 'windows'
        with patch('platform.win32_ver', return_value=('11', '10.0.26300', '', '')), patch(
                'platform.freedesktop_os_release') as distro:
            report = self.p._diagnostic_system()
        self.assertEqual(report['windows'], {'release': '11', 'version': '10.0.26300'})
        self.assertNotIn('distribution', report)
        distro.assert_not_called()

    async def test_windows_build_fallback_when_win32_version_is_empty(self):
        self.host.WINDOWS = True
        with patch('platform.win32_ver', return_value=('', '', '', '')), patch(
                'platform.version', return_value='10.0.26300'):
            self.assertEqual(self.p._diagnostic_system()['windows']['version'], '10.0.26300')

    async def test_game_report_preserves_state_without_titles_or_executable_paths(self):
        with patch.dict('sys.modules', {'discord_client.cloud_game': self.cloud}):
            report = await self.p.get_game_diagnostics()
        self.assertEqual(report['steam_application'], 'geforce_now')
        self.assertTrue(report['manual_title_set'])
        self.assertEqual(report['geforce_now'], {
            'reason': 'detected', 'source': 'x11-title', 'game_detected': True})
        self.assertNotIn('private', json.dumps(report))
        self.p._rpc_payload.assert_awaited_once()

    async def test_unknown_status_and_unrelated_steam_app_cannot_leak_values(self):
        self.p.get_cloud_game_status.return_value = {
            'game': None, 'reason': 'private error', 'source': 'private path'}
        for game, expected in [('private game', 'other'), (None, 'none')]:
            self.p._rpc_payload.return_value = {'game': game}
            with patch.dict('sys.modules', {'discord_client.cloud_game': self.cloud}):
                report = await self.p.get_game_diagnostics()
            self.assertEqual(report['steam_application'], expected)
            self.assertEqual(report['geforce_now'], {
                'reason': 'unavailable', 'source': None, 'game_detected': False})
            self.assertNotIn('private', json.dumps(report))

    async def test_game_report_keeps_only_whitelisted_window_counts(self):
        self.p.get_cloud_game_status.return_value = {
            'game': None, 'reason': 'no_game', 'source': 'x11-title', 'windows': 7, 'gfn_windows': True,
            'title_kinds': {'branding': 1, 'private title': 3, 'page': 'private'}}
        with patch.dict('sys.modules', {'discord_client.cloud_game': self.cloud}):
            report = await self.p.get_game_diagnostics()
        self.assertEqual(report['geforce_now'], {
            'reason': 'no_game', 'source': 'x11-title', 'game_detected': False,
            'windows': 7, 'title_kinds': {'branding': 1}})
        self.assertNotIn('private', json.dumps(report))

    async def test_video_report_retains_capture_data_and_adds_windows_build(self):
        self.host.WINDOWS, self.host.NAME = True, 'windows'
        video = {'backend': 'windows-native', 'capture': [{'width': 1920}], 'relays': []}
        request = AsyncMock(return_value=video)
        self.p.evt_handler = types.SimpleNamespace(api=types.SimpleNamespace(_store_access_request=request))
        with patch('platform.win32_ver', return_value=('11', '10.0.26300', '', '')):
            report = await self.p.get_video_diagnostics()
        self.assertEqual(report['video'], video)
        self.assertEqual(report['windows']['version'], '10.0.26300')
        request.assert_awaited_once_with('$get_video_diagnostics')
