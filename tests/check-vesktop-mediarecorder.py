"""Read-only CDP check of the live Vesktop MediaRecorder formats."""

import asyncio
import json

import aiohttp


async def main():
    async with aiohttp.ClientSession() as session:
        async with session.get("http://127.0.0.1:9223/json") as response:
            pages = await response.json()
        page = next(p for p in pages if p.get("type") == "page" and
                    p.get("url", "").startswith("https://discord.com/"))
        async with session.ws_connect(page["webSocketDebuggerUrl"]) as ws:
            await ws.send_json({
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {"expression": "JSON.stringify({mediaRecorder: typeof MediaRecorder !== 'undefined', vp8Webm: MediaRecorder.isTypeSupported('video/webm;codecs=vp8'), h264Mp4: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E'), pov: Object.values(window.STEAMCORD_POV || {}).map(x => {const s=x.rec?.stream?.getVideoTracks?.()[0]?.getSettings?.()||{}; return {format:x.format,kind:x.kind,recording:x.rec?.state,width:s.width,height:s.height,frameRate:s.frameRate}})})", "returnByValue": True},
            })
            async for message in ws:
                result = json.loads(message.data)
                if result.get("id") == 1:
                    print(result.get("result", {}).get("result", {}).get("value", result))
                    return


asyncio.run(main())
