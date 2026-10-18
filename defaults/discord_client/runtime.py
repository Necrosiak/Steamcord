"""Session-only Discord pause gate, shared by startup and recovery paths.

No credentials or persistent setting: a backend restart defaults to On.
"""
import asyncio


class DiscordRuntime:
    def __init__(self):
        self.enabled = True
        self._gate = asyncio.Event()
        self._gate.set()
        self._lock = asyncio.Lock()
        self.transition_lock = asyncio.Lock()
        self._start = None
        self._generation = 0

    async def wait_enabled(self):
        await self._gate.wait()

    async def run_start(self, factory):
        async with self._lock:
            while True:
                await self.wait_enabled()
                generation = self._generation
                task = asyncio.create_task(factory())
                self._start = task
                try:
                    result = await task
                except asyncio.CancelledError:
                    if generation != self._generation:
                        continue  # Explicit stop cancelled startup, not its owner.
                    raise
                finally:
                    if self._start is task:
                        self._start = None
                if self.enabled and generation == self._generation:
                    return result

    async def pause(self):
        self.enabled = False
        self._gate.clear()
        self._generation += 1
        task = self._start
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def resume(self):
        self.enabled = True
        self._gate.set()
