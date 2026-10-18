import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tested_overlay_env', Path(__file__).resolve().parents[1] / 'defaults/discord_client/overlay_environment.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OverlayEnvironmentTests(unittest.TestCase):
    def test_game_mode_uses_steam_display_and_cookie_not_stale_manager(self):
        base = {'PATH': '/fixture', 'DISPLAY': ':0', 'XAUTHORITY': '/stale'}
        steam = {'DISPLAY': ':3', 'XAUTHORITY': '/current-cookie'}
        result = module.overlay_environment(base, {'DISPLAY': ':1'}, steam)
        self.assertEqual(result['DISPLAY'], ':3')
        self.assertEqual(result['XAUTHORITY'], '/current-cookie')
        self.assertEqual(base['DISPLAY'], ':0')

    def test_cookie_less_game_display_does_not_keep_stale_desktop_cookie(self):
        result = module.overlay_environment({'XAUTHORITY': '/stale'}, {}, {'DISPLAY': ':2'})
        self.assertEqual(result['DISPLAY'], ':2')
        self.assertNotIn('XAUTHORITY', result)

    def test_desktop_keeps_its_own_display(self):
        result = module.overlay_environment({}, {'DISPLAY': ':1'}, {'DISPLAY': ':3'}, desktop=True)
        self.assertEqual(result['DISPLAY'], ':1')

    def test_missing_steam_metadata_keeps_existing_display_and_fallback(self):
        self.assertEqual(module.overlay_environment({'DISPLAY': ':5'}, {}, {})['DISPLAY'], ':5')
        self.assertEqual(module.overlay_environment({}, {}, {})['DISPLAY'], ':0')

    def test_pyinstaller_library_path_does_not_reach_system_gtk(self):
        result = module.overlay_environment({'LD_LIBRARY_PATH': '/tmp/_MEIfixture'}, {}, {})
        self.assertNotIn('LD_LIBRARY_PATH', result)


if __name__ == '__main__':
    unittest.main()
