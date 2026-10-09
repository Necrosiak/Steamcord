"""Count Steamcord POV relay frames without reading or saving video content."""

import asyncio
import sys

import aiohttp


async def main():
    counts = {"frames": 0, "inits": 0, "bytes": 0}
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(sys.argv[1], timeout=6) as ws:
            deadline = asyncio.get_running_loop().time() + 5
            while asyncio.get_running_loop().time() < deadline:
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=1)
                except asyncio.TimeoutError:
                    continue
                if msg.type != aiohttp.WSMsgType.BINARY:
                    continue
                data = msg.data
                if len(data) < 3:
                    continue
                uid_len = data[0]
                if len(data) <= uid_len + 1:
                    continue
                counts["frames"] += 1
                counts["inits"] += bool(data[1 + uid_len])
                counts["bytes"] += len(data) - uid_len - 2
    print(counts)


asyncio.run(main())
