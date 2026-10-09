"""End-to-end VP8/WebM smoke test with the running Vesktop MediaRecorder.

Generates a harmless canvas video in Vesktop, relays its *real* MediaRecorder
fragments over localhost WebSocket, and displays them in the Steamcord Cairo
overlay on the active Gamescope X11 display. No Discord call is started.
"""

import asyncio
import json
import os
import pathlib
import re
import sys
import tempfile

import aiohttp
from aiohttp import web


async def eval_cdp(session, page, expression, command_id):
    async with session.ws_connect(page["webSocketDebuggerUrl"]) as ws:
        await ws.send_json({"id": command_id, "method": "Runtime.evaluate", "params": {
            "expression": expression, "returnByValue": True}})
        async for message in ws:
            data = json.loads(message.data)
            if data.get("id") == command_id:
                return data.get("result", {})
    raise RuntimeError("CDP disconnected")


async def main():
    overlay_path = pathlib.Path(sys.argv[1]).resolve()
    screenshot = pathlib.Path(sys.argv[2]).resolve()
    viewers = set()
    stats = {"chunks": 0, "bytes": 0}
    init_frame = None

    async def ingest(request):
        nonlocal init_frame
        ws = web.WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.BINARY:
                continue
            frame = msg.data
            if len(frame) < 7 or frame[:5] != b"\x04test":
                continue
            stats["chunks"] += 1
            stats["bytes"] += len(frame) - 6
            if frame[5]:
                init_frame = frame
            for viewer in tuple(viewers):
                await viewer.send_bytes(frame)
        return ws

    async def feed(request):
        ws = web.WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        viewers.add(ws)
        if init_frame:
            await ws.send_bytes(init_frame)
        try:
            async for _ in ws:
                pass
        finally:
            viewers.discard(ws)
        return ws

    app = web.Application()
    app.router.add_get("/ingest", ingest)
    app.router.add_get("/pov_feed", feed)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    env = dict(os.environ, DISPLAY=":0")

    async with aiohttp.ClientSession() as session:
        async with session.get("http://127.0.0.1:9223/json") as response:
            pages = await response.json()
        page = next(p for p in pages if p.get("type") == "page" and
                    p.get("url", "").startswith("https://discord.com/"))
        with tempfile.TemporaryDirectory(prefix="steamcord-pov-vesktop-") as state_dir:
            pathlib.Path(state_dir, "voice_state.json").write_text(json.dumps({
                "voice": {"enabled": False, "users": [{"id": "test", "username": "Vesktop VP8"}]},
                "pov": {"enabled": True,
                        "feed": f"ws://127.0.0.1:{port}/pov_feed",
                        "settings": {"layout": "right", "opacity": 90, "scale": 100}},
            }))
            proc = await asyncio.create_subprocess_exec(
                sys.executable, str(overlay_path), "--backend", "cairo",
                "--state-dir", state_dir, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            try:
                await asyncio.sleep(1)
                assert proc.returncode is None, "Overlay exited early"
                start_js = """(() => {
                  if (window.__steamcordPovTest) return 'already running';
                  const canvas = document.createElement('canvas');
                  canvas.width = 320; canvas.height = 180;
                  const ctx = canvas.getContext('2d');
                  const stream = canvas.captureStream(12);
                  const rec = new MediaRecorder(stream, {
                    mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 1500000
                  });
                  const ws = new WebSocket('ws://127.0.0.1:PORT/ingest');
                  let first = true, n = 0, sendChain = Promise.resolve();
                  const timer = setInterval(() => {
                    ctx.fillStyle = '#1b294d'; ctx.fillRect(0,0,320,180);
                    ctx.fillStyle = '#62e4aa'; ctx.fillRect((n++ * 4) % 280,65,40,40);
                    ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif';
                    ctx.fillText('Vesktop MediaRecorder',18,33);
                  }, 80);
                  rec.ondataavailable = event => {
                    if (!event.data.size) return;
                    const init = first; first = false;
                    sendChain = sendChain.then(async () => {
                      const bytes = new Uint8Array(await event.data.arrayBuffer());
                      const frame = new Uint8Array(bytes.length + 6);
                      frame.set([4,116,101,115,116,init ? 1 : 0]);
                      frame.set(bytes,6);
                      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
                    });
                  };
                  ws.onopen = () => rec.start(250);
                  window.__steamcordPovTest = { stop() {
                    clearInterval(timer); if (rec.state !== 'inactive') rec.stop();
                    stream.getTracks().forEach(t => t.stop());
                    setTimeout(() => ws.close(), 500);
                    delete window.__steamcordPovTest;
                  }};
                  return 'started';
                })()""".replace("PORT", str(port))
                print("Vesktop start:", await eval_cdp(session, page, start_js, 1))
                await asyncio.sleep(4)
                assert stats["chunks"] > 0, "No MediaRecorder chunks received"
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
                assert capture.returncode == 0, err.decode()
            finally:
                try:
                    stop_js = "window.__steamcordPovTest?.stop(); 'stopped'"
                    print("Vesktop stop:", await eval_cdp(session, page, stop_js, 2))
                except Exception as exc:
                    print("Vesktop cleanup warning:", exc)
                if proc.returncode is None:
                    proc.terminate()
                out, _ = await proc.communicate()
                print("Overlay output:\n" + out.decode(errors="replace"))
                for viewer in tuple(viewers):
                    await viewer.close()
                await runner.cleanup()
    print("MediaRecorder chunks:", stats)
    print("Screenshot:", screenshot)


asyncio.run(main())
