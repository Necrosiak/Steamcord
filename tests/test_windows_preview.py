"""Run the real Windows preview methods without importing Decky or Linux helpers."""
import ast
import asyncio
import base64
from pathlib import Path
import types
import unittest
from unittest.mock import AsyncMock

SOURCE = Path(__file__).resolve().parents[1] / "main.py"
JPEG = base64.b64encode(b"\xff\xd8test-frame\xff\xd9").decode()


def plugin():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    original = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Plugin")
    names = {"_windows_share_preview", "get_golive_preview", "start_golive_preview",
             "refresh_golive_preview", "stop_golive_preview"}
    cls = ast.ClassDef(name="Plugin", bases=[], keywords=[],
                       body=[n for n in original.body if getattr(n, "name", None) in names],
                       decorator_list=[])
    namespace = {"host": types.SimpleNamespace(WINDOWS=True),
                 "create_task": asyncio.create_task, "wait_for": asyncio.wait_for}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), str(SOURCE), "exec"), namespace)
    return namespace["Plugin"]


class WindowsPreviewTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = plugin()
        self.reader = AsyncMock(return_value=JPEG)
        self.plugin.evt_handler = types.SimpleNamespace(api=types.SimpleNamespace(grab_preview_frame=self.reader))

    async def test_frame_comes_from_existing_share(self):
        result = await self.plugin.get_golive_preview()
        self.assertEqual(result, {"running": True, "pending": False, "oneshot": True, "jpg": JPEG})
        self.reader.assert_awaited_once_with(640)

    async def test_closed_or_invalid_share_has_no_old_image(self):
        await self.plugin.get_golive_preview()
        for value in ("", None, "invalid-image", "x" * (1024 * 1024 + 1)):
            self.reader.return_value = value
            result = await self.plugin.get_golive_preview()
            self.assertFalse(result["running"])
            self.assertEqual(result["jpg"], "")

    async def test_missing_client_is_safe(self):
        self.plugin.evt_handler = types.SimpleNamespace(api=None)
        self.assertEqual((await self.plugin.get_golive_preview())["jpg"], "")

    async def test_failed_frame_request_can_retry(self):
        self.reader.side_effect = RuntimeError("client reconnecting")
        self.assertEqual((await self.plugin.get_golive_preview())["jpg"], "")
        self.reader.side_effect = None
        self.assertEqual((await self.plugin.get_golive_preview())["jpg"], JPEG)

    async def test_qam_and_expanded_share_pending_request(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def read(_width):
            started.set()
            await release.wait()
            return JPEG
        self.reader.side_effect = read
        first = asyncio.create_task(self.plugin.get_golive_preview())
        second = asyncio.create_task(self.plugin.get_golive_preview())
        await started.wait()
        release.set()
        self.assertTrue(all(r["jpg"] == JPEG for r in await asyncio.gather(first, second)))
        self.assertEqual(self.reader.await_count, 1)

    async def test_preview_lifecycle_needs_no_linux_capture_helper(self):
        self.assertEqual(await self.plugin.start_golive_preview(), {"ok": True})
        self.assertEqual(await self.plugin.refresh_golive_preview(), {"ok": True})
        self.assertTrue(await self.plugin.stop_golive_preview())
        self.reader.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
