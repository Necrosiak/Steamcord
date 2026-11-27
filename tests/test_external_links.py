import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch
spec = importlib.util.spec_from_file_location('sc_external_links', Path(__file__).parents[1] / 'defaults/external_links.py')
links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(links)

class ExternalLinks(unittest.TestCase):
    def test_linux_opens_web_url_as_one_argument_without_shell(self):
        proc = Mock(); proc.wait.return_value = 0
        with patch.object(links.sys, 'platform', 'linux'), patch.object(links.subprocess, 'Popen', return_value=proc) as launch:
            self.assertTrue(links.open_link('https://example.org/a?q=$(touch%20bad)&x=1', {'DBUS_SESSION_BUS_ADDRESS': 'test-session'}))
            self.assertEqual(launch.call_args.args[0], ['xdg-open', 'https://example.org/a?q=$(touch%20bad)&x=1'])
            self.assertNotIn('shell', launch.call_args.kwargs)
            self.assertEqual(launch.call_args.kwargs['env'], {'DBUS_SESSION_BUS_ADDRESS': 'test-session'})
    def test_windows_uses_default_url_handler(self):
        with patch.object(links.sys, 'platform', 'win32'), patch.object(links.os, 'startfile', create=True) as launch:
            self.assertTrue(links.open_link('https://example.org'))
            launch.assert_called_once_with('https://example.org')
    def test_rejects_unsafe_schemes_credentials_and_malformed_values(self):
        with patch.object(links.subprocess, 'Popen') as launch:
            for url in [None, 'file:///tmp/test', 'javascript:alert(1)', '--help', 'https://user:secret@example.org', 'https://example.org:bad', 'https://example.org\n', 'https://']:
                self.assertFalse(links.open_link(url), url)
            launch.assert_not_called()
    def test_missing_browser_and_nonzero_exit_are_reported(self):
        with patch.object(links.sys, 'platform', 'linux'), patch.object(links.subprocess, 'Popen', side_effect=FileNotFoundError):
            self.assertFalse(links.open_link('https://example.org'))
        proc=Mock(); proc.wait.return_value=1
        with patch.object(links.sys, 'platform', 'linux'), patch.object(links.subprocess, 'Popen', return_value=proc):
            self.assertFalse(links.open_link('https://example.org'))

class BackendLinkBoundary(unittest.IsolatedAsyncioTestCase):
    async def test_linux_backend_supplies_desktop_session_environment(self):
        import sys
        import types
        from test_audio_overlay_regressions import methods
        p = methods({'open_external_link'})
        opener = Mock(return_value=True)
        environment = {'DBUS_SESSION_BUS_ADDRESS': 'session-test'}
        with patch.dict(sys.modules, {'external_links': types.SimpleNamespace(open_link=opener),
                                     'vesktop': types.SimpleNamespace(_user_env=lambda: environment)}):
            self.assertTrue(await p.open_external_link('https://example.org'))
        opener.assert_called_once_with('https://example.org', environment)

    async def test_windows_backend_does_not_load_linux_session_helpers(self):
        import sys
        import types
        from test_audio_overlay_regressions import methods
        p = methods({'open_external_link'})
        p.open_external_link.__func__.__globals__['host'].WINDOWS = True
        opener = Mock(return_value=True)
        with patch.dict(sys.modules, {'external_links': types.SimpleNamespace(open_link=opener), 'vesktop': None}):
            self.assertTrue(await p.open_external_link('https://example.org'))
        opener.assert_called_once_with('https://example.org', None)
