"""aiohttp sessions opened by Tab.open_websocket are always closed (#44, #99)."""
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SESSIONS = []


class FakeWS:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class FakeSession:
    fail = False

    def __init__(self):
        self.closed = False
        SESSIONS.append(self)

    async def ws_connect(self, url):
        if FakeSession.fail:
            raise ConnectionRefusedError(url)
        return FakeWS()

    async def close(self):
        self.closed = True


def load_cdp():
    aiohttp = types.ModuleType('aiohttp')
    aiohttp.ClientSession = FakeSession
    exc = types.ModuleType('aiohttp.client_exceptions')
    exc.ClientConnectorError = type('ClientConnectorError', (Exception,), {})
    exc.ClientOSError = type('ClientOSError', (Exception,), {})
    sys.modules['aiohttp'], sys.modules['aiohttp.client_exceptions'] = aiohttp, exc
    spec = importlib.util.spec_from_file_location('cdp_under_test', ROOT / 'defaults/tab_utils/cdp.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TabSessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        SESSIONS.clear()
        FakeSession.fail = False
        self.cdp = load_cdp()
        self.tab = self.cdp.Tab({'title': 't', 'id': '1', 'url': 'u', 'webSocketDebuggerUrl': 'ws://x'})

    async def test_failed_connection_closes_its_session(self):
        FakeSession.fail = True
        for _ in range(7):     # the 30 s burst seen while Vesktop is stopped
            with self.assertRaises(ConnectionRefusedError):
                await self.tab.open_websocket()
        self.assertTrue(all(s.closed for s in SESSIONS))

    async def test_reopening_a_dead_socket_closes_the_old_session(self):
        await self.tab.open_websocket()
        first = SESSIONS[0]
        self.tab.websocket.closed = True
        await self.tab.ensure_open()
        self.assertTrue(first.closed)
        self.assertFalse(SESSIONS[1].closed)

    async def test_live_socket_is_never_closed_behind_its_users(self):
        await self.tab.open_websocket()
        first = SESSIONS[0]
        await self.tab.open_websocket()
        self.assertFalse(first.closed)

    async def test_close_websocket_closes_both_and_tolerates_never_opened(self):
        await self.tab.close_websocket()      # never opened: no AttributeError
        await self.tab.open_websocket()
        await self.tab.close_websocket()
        self.assertTrue(self.tab.websocket.closed and SESSIONS[0].closed)


if __name__ == '__main__':
    unittest.main()
