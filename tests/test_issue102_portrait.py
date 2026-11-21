"""Regression from #102: decoded portrait frames must reach Cairo."""
import types
import unittest
from unittest.mock import Mock
from test_audio_overlay_regressions import methods


class PortraitFramesTests(unittest.TestCase):
    def setUp(self):
        self.cairo = Mock()
        self.area = methods({'set_pov_frame'}, source='defaults/game_overlay/overlay.py',
                            klass='RosterArea', cairo=self.cairo)()
        self.area.pov = {'enabled': True}
        self.area.pov_frames = {}
        self.area._pov_first_surface_logged = False
        self.area._pov_first_reject_logged = False
        self.area.queue_draw = Mock()
        self.area.set_pov_frame.__func__.__globals__['time'] = types.SimpleNamespace(monotonic=lambda: 1)

    def test_reported_portrait_and_landscape_frames_reach_surface(self):
        for w, h in [(640, 1424), (1080, 1920), (1920, 1080), (640, 360)]:
            with self.subTest(size=(w, h)):
                data = bytearray(w * h * 4)
                self.area.set_pov_frame('fixture', data, w, h)
                self.assertEqual(self.area.pov_frames['fixture'][2:4], (w, h))
                self.cairo.ImageSurface.create_for_data.assert_called_with(data, self.cairo.FORMAT_RGB24, w, h, w * 4)

    def test_invalid_dimensions_stride_and_memory_budget_remain_rejected(self):
        for w, h, data in [(0, 1, b''), (1, 0, b''), (1921, 1, b''),
                           (1920, 1920, b''), (640, 1424, bytearray(640 * 1424)),
                           (2, 2, bytearray(17)), (1, 1, bytearray(1920 * 1080 * 4 + 4))]:
            with self.subTest(size=(w, h), length=len(data)):
                self.area.set_pov_frame('fixture', data, w, h)
                self.assertFalse(self.area.pov_frames)
        self.cairo.ImageSurface.create_for_data.assert_not_called()

    def test_disabled_overlay_does_not_allocate_a_surface(self):
        self.area.pov['enabled'] = False
        self.area.set_pov_frame('fixture', bytearray(4), 1, 1)
        self.cairo.ImageSurface.create_for_data.assert_not_called()
