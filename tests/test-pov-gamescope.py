"""Temporary live Gamescope smoke test of the Steamcord Cairo POV overlay.

Runs a synthetic VP8/WebM feed on a private localhost port, launches the
overlay in a temporary state directory, captures one screenshot, then cleans
up. It does not restart Steamcord, Vesktop, or Gamescope.
"""

import asyncio
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

from aiohttp import web


async def main():
    import importlib.util

    overlay_path = pathlib.Path(sys.argv[1]).resolve()
    screenshot = pathlib.Path(sys.argv[2]).resolve()
    spec = importlib.util.spec_from_file_location("steamcord_overlay_test", overlay_path)
    overlay = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(overlay)
    gst = overlay.Gst
    producer = gst.parse_launch(
        "videotestsrc num-buffers=90 pattern=ball ! "
        "video/x-raw,width=320,height=180,framerate=12/1 ! "
        "vp8enc deadline=1 keyframe-max-dist=12 ! "
        "webmmux streamable=true ! appsink name=encoded sync=false")
    sink = producer.get_by_name("encoded")
    buffers = []
    producer.set_state(gst.State.PLAYING)
    try:
        misses = 0
        while misses < 3:
            sample = await asyncio.to_thread(sink.emit, "try-pull-sample", gst.SECOND)
            if sample is None:
                misses += 1
                continue
            misses = 0
            buf = sample.get_buffer()
            ok, mapped = buf.map(gst.MapFlags.READ)
            if ok:
                buffers.append(bytes(mapped.data))
                buf.unmap(mapped)
    finally:
        producer.set_state(gst.State.NULL)
    assert buffers, "No synthetic WebM buffers"

    async def feed(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        for index, data in enumerate(buffers):
            if ws.closed:
                break
            try:
                await ws.send_bytes(b"\x04test" + bytes([1 if index == 0 else 0]) + data)
            except (ConnectionError, OSError):
                break
            await asyncio.sleep(1 / 12)
        await asyncio.sleep(2)
        return ws

    app = web.Application()
    app.router.add_get("/pov_feed", feed)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    with tempfile.TemporaryDirectory(prefix="steamcord-pov-gamescope-") as state_dir:
        pathlib.Path(state_dir, "voice_state.json").write_text(json.dumps({
            "voice": {"enabled": False, "users": [{"id": "test", "username": "Test POV"}]},
            "pov": {"enabled": True, "feed": f"ws://127.0.0.1:{port}/pov_feed",
                    "settings": {"layout": "right", "opacity": 90, "scale": 100}},
        }))
        env = dict(os.environ, DISPLAY=":0")
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(overlay_path), "--backend", "cairo",
            "--state-dir", state_dir, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            await asyncio.sleep(3)
            assert proc.returncode is None, "Overlay exited before capture"
            window = await asyncio.create_subprocess_exec(
                "xwininfo", "-name", "Steamcord Overlay", env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            win_out, win_err = await window.communicate()
            assert window.returncode == 0, win_err.decode()
            window_id = re.search(rb"Window id: (0x[0-9a-f]+)", win_out)
            assert window_id, win_out.decode()
            capture = await asyncio.create_subprocess_exec(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "x11grab", "-window_id", window_id.group(1).decode(),
                "-video_size", "1920x1080", "-i", ":0",
                "-frames:v", "1", str(screenshot), env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            _, err = await capture.communicate()
            print("Capture:", capture.returncode, err.decode().strip())
            await asyncio.sleep(3)
        finally:
            if proc.returncode is None:
                proc.terminate()
            out, _ = await proc.communicate()
            print("Overlay output:\n" + out.decode(errors="replace"))
            await runner.cleanup()
    print("Encoded WebM buffers:", len(buffers))
    print("Screenshot:", screenshot)


asyncio.run(main())
