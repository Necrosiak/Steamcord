import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch
from test_audio_overlay_regressions import methods


class MixEvents(unittest.IsolatedAsyncioTestCase):
    async def watch(self, line):
        p = methods({'_chat_mix_event_watcher'}, sleep=asyncio.sleep, DEVNULL=-3)
        p._chat_mix_wanted = lambda: True
        applied = asyncio.Event()
        async def apply(): applied.set()
        p._apply_chat_mix = AsyncMock(side_effect=apply)
        queue = asyncio.Queue()
        queue.put_nowait(line)
        proc = types.SimpleNamespace(stdout=types.SimpleNamespace(readline=queue.get),
                                     returncode=None, kill=lambda: None, wait=AsyncMock())
        with patch.dict(sys.modules, vesktop=types.SimpleNamespace(_user_env=lambda: {})), patch(
                'asyncio.create_subprocess_exec', AsyncMock(return_value=proc)):
            task = asyncio.create_task(p._chat_mix_event_watcher())
            try:
                await asyncio.wait_for(applied.wait(), .25)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
        return p

    async def test_existing_stream_change_is_handled_without_four_second_poll(self):
        await self.watch(b"Event 'change' on sink-input #12\n")

    async def test_new_stream_is_still_handled(self):
        await self.watch(b"Event 'new' on sink-input #12\n")
