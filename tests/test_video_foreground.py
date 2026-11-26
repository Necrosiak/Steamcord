import asyncio
import json
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from test_audio_overlay_regressions import methods


class VideoForeground(unittest.IsolatedAsyncioTestCase):
    async def test_foreground_hides_pov_without_changing_preference_or_voice(self):
        p = methods({'set_video_foreground', '_write_overlay_state'})
        with tempfile.TemporaryDirectory() as directory:
            p._overlay_dir = lambda: directory
            p.evt_handler = types.SimpleNamespace(build_state_dict=lambda: {'vc': None})
            settings = {'voice': {'enabled': True}, 'pov': {'enabled': True}}
            p._load_overlay_settings = lambda: settings
            p._voice_ov_on = p._pov_ov_on = True
            p._ov_track_members = lambda *_: []
            p.OV_EVENT_MS, p.POV_FEED_URL = 5000, 'local'
            callbacks = []
            loop = Mock()
            loop.call_later.side_effect = lambda seconds, callback: (callbacks.append(callback) or Mock())
            def read():
                with open(directory + '/voice_state.json') as f: return json.load(f)
            with patch('asyncio.get_running_loop', return_value=loop):
                self.assertTrue(await p.set_video_foreground(True))
                self.assertFalse(read()['pov']['enabled'])
                self.assertEqual(__import__('os').stat(directory+'/voice_state.json').st_mode & 0o777, 0o600)
                self.assertTrue(read()['voice']['enabled'])
                self.assertTrue(settings['pov']['enabled'])
                handle = p._video_foreground_timer
                await p.set_video_foreground(False)
                handle.cancel.assert_called_once()
                self.assertTrue(read()['pov']['enabled'])
                await p.set_video_foreground(True)
                callbacks[-1]()  # frontend disappears, renewable lease expires
                self.assertTrue(read()['pov']['enabled'])
                self.assertFalse(await p.set_video_foreground('true'))

    async def test_windows_does_not_create_linux_overlay_state(self):
        p = methods({'set_video_foreground'})
        p.set_video_foreground.__func__.__globals__['host'].WINDOWS = True
        p._write_overlay_state = Mock()
        self.assertFalse(await p.set_video_foreground(True))
        p._write_overlay_state.assert_not_called()
