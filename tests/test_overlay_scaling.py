import math
import unittest
from test_audio_overlay_regressions import methods


class OverlayScalingTests(unittest.TestCase):
    def setUp(self):
        self.renderer = methods({'_display_scale'}, source='defaults/game_overlay/overlay.py',
                                klass='RosterArea', math=math)

    def test_scale_tracks_resolution_without_changing_the_saved_percentage(self):
        for width, height, expected in [(1280, 800, 1), (1280, 720, 1),
                                         (1920, 1080, 1.35), (3840, 2160, 2.7)]:
            with self.subTest(screen=(width, height)):
                self.assertAlmostEqual(self.renderer._display_scale(width, height, 100), expected)
                self.assertAlmostEqual(self.renderer._display_scale(width, height, 180), expected * 1.8)
                self.assertAlmostEqual(self.renderer._display_scale(width, height, 400), expected * 4)

    def test_corrupt_settings_cannot_create_unbounded_or_nan_geometry(self):
        for value in (None, '400', float('nan'), float('inf')):
            self.assertAlmostEqual(self.renderer._display_scale(3840, 2160, value), 2.7)
        self.assertEqual(self.renderer._display_scale(1280, 800, 100000), 4)
        self.assertEqual(self.renderer._display_scale(1280, 800, -10), .6)
