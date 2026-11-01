import ast
import pathlib
import unittest
from unittest.mock import AsyncMock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'main.py'
class VisibilityAPI(unittest.IsolatedAsyncioTestCase):
    def make_plugin(self):
        tree = ast.parse(SOURCE.read_text())
        original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Plugin')
        method = next(n for n in original.body if getattr(n, 'name', None) == 'set_video_visibility')
        node = ast.ClassDef(name='Plugin', bases=[], keywords=[], body=[method], decorator_list=[])
        module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
        namespace = {}
        exec(compile(module, str(SOURCE), 'exec'), namespace)
        plugin = namespace['Plugin']
        plugin.evt_handler = type('Events', (), {'send_client': AsyncMock()})()
        return plugin
    async def test_valid_ids_are_deduplicated(self):
        p = self.make_plugin()
        self.assertTrue(await p.set_video_visibility(['123', '456', '123'], True))
        p.evt_handler.send_client.assert_awaited_once_with({'type': '$VIDEO_VISIBILITY', 'userIds': ['123', '456'], 'enabled': True})
    async def test_unload_can_disable_policy(self):
        p = self.make_plugin()
        self.assertTrue(await p.set_video_visibility([], False))
        p.evt_handler.send_client.assert_awaited_once_with({'type': '$VIDEO_VISIBILITY', 'userIds': [], 'enabled': False})
    async def test_invalid_payloads_never_reach_discord(self):
        for ids, enabled in [(None, True), ('123', True), (['12x'], True), (['１２３'], True), (['1'*25], True), ([''], True), (['123']*65, True), (['123'], 1)]:
            with self.subTest(ids=type(ids).__name__, enabled=enabled):
                p = self.make_plugin()
                self.assertFalse(await p.set_video_visibility(ids, enabled))
                p.evt_handler.send_client.assert_not_awaited()
if __name__ == '__main__': unittest.main()
