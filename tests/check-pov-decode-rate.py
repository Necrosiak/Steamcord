"""Measure decoded POV frames per second without saving the video."""

import asyncio
import importlib.util
import pathlib
import sys
import time

import aiohttp


async def main():
    spec = importlib.util.spec_from_file_location("overlay_test", pathlib.Path(sys.argv[1]))
    overlay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(overlay)
    times = []
    dimensions = set()

    def got_frame(_uid, _pixels, width, height):
        times.append(time.monotonic())
        dimensions.add((width, height))

    decoder = overlay.PovDecoder("rate", got_frame)
    init_count = 0
    chunk_count = 0
    started = time.monotonic()
    try:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(sys.argv[2], timeout=7) as ws:
                while time.monotonic() - started < 6:
                    try:
                        msg = await asyncio.wait_for(ws.receive(), timeout=1)
                    except asyncio.TimeoutError:
                        continue
                    if msg.type != aiohttp.WSMsgType.BINARY:
                        continue
                    data = msg.data
                    if not data:
                        continue
                    uid_len = data[0]
                    if len(data) <= uid_len + 2:
                        continue
                    init_count += bool(data[uid_len + 1])
                    decoder.push(data[uid_len + 2:])
                    chunk_count += 1
        await asyncio.sleep(0.2)
    finally:
        decoder.close()
    duration = time.monotonic() - started
    print({"seconds": round(duration, 1), "chunks": chunk_count,
           "inits": init_count, "decoded_frames": len(times),
           "decoded_fps": round(len(times) / duration, 1),
           "dimensions": sorted(dimensions)})


asyncio.run(main())
