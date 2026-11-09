"""Proxy support: settings, Chromium flags, and the loopback bridge.

Runs without Decky (fake `decky`/`host` modules) and without a network: every
"proxy" here is a real loopback server speaking just enough HTTP CONNECT or
SOCKS to prove the bridge does what Chromium and aiohttp cannot do themselves
(a login, and SOCKS at all).
"""
import asyncio
import importlib.util
import json
import logging
import os
import stat
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

DEFAULTS = Path(__file__).resolve().parents[1] / "defaults"


def load(name):
    spec = importlib.util.spec_from_file_location(name, DEFAULTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _pump(source, sink):
    try:
        while True:
            data = await source.read(65536)
            if not data:
                break
            sink.write(data)
            await sink.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass


async def _splice(a_reader, a_writer, b_reader, b_writer):
    # Like the bridge: one side closed ends the tunnel (Python 3.12+ makes
    # Server.wait_closed() wait for every open connection).
    tasks = [asyncio.ensure_future(_pump(a_reader, b_writer)),
             asyncio.ensure_future(_pump(b_reader, a_writer))]
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in tasks:
        task.cancel()
    for writer in (a_writer, b_writer):
        writer.close()


class EchoServer:
    """The 'Discord' end of a tunnel: whatever goes in comes back."""

    def __init__(self):
        self.server = None
        self.port = 0
        self.opened = 0

    async def start(self):
        async def handle(reader, writer):
            self.opened += 1
            await _pump(reader, writer)
            writer.close()

        self.server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()


class FakeHttpProxy:
    """HTTP CONNECT proxy; optional Basic auth. Records what it was asked."""

    def __init__(self, user="", password=""):
        self.user, self.password = user, password
        self.server = None
        self.port = 0
        self.connects = []
        self.refused = 0

    async def start(self):
        async def handle(reader, writer):
            try:
                head = await reader.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                writer.close()
                return
            lines = head.split(b"\r\n")
            method, target, _version = lines[0].decode("latin-1").split(" ", 2)
            headers = {}
            for line in lines[1:]:
                if b":" in line:
                    name, _, value = line.partition(b":")
                    headers[name.strip().decode("latin-1").lower()] = \
                        value.strip().decode("latin-1")
            self.connects.append((method, target, headers))
            if self.user:
                import base64
                expected = "Basic " + base64.b64encode(
                    f"{self.user}:{self.password}".encode()).decode()
                if headers.get("proxy-authorization") != expected:
                    self.refused += 1
                    writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                                 b"Proxy-Authenticate: Basic realm=\"test\"\r\n"
                                 b"Content-Length: 0\r\n\r\n")
                    writer.close()
                    return
            if method != "CONNECT":
                # Absolute-form GET, as Chromium and aiohttp send to an HTTP
                # proxy: relay it to the origin in origin-form.
                from urllib.parse import urlsplit
                url = urlsplit(target)
                try:
                    up_reader, up_writer = await asyncio.open_connection(
                        url.hostname, url.port or 80)
                except OSError:
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                    writer.close()
                    return
                origin = (url.path or "/") + (f"?{url.query}" if url.query else "")
                head_out = [f"{method} {origin} {_version}".encode()] + [
                    line for line in lines[1:]
                    if not line.lower().startswith((b"proxy-authorization", b"proxy-connection"))
                ]
                up_writer.write(b"\r\n".join(head_out) + b"\r\n\r\n")
                await up_writer.drain()
                await _splice(reader, writer, up_reader, up_writer)
                return
            host, _, port = target.rpartition(":")
            try:
                up_reader, up_writer = await asyncio.open_connection(host, int(port))
            except OSError:
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                writer.close()
                return
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await _splice(reader, writer, up_reader, up_writer)

        self.server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()


class FakeSocks5:
    """SOCKS5 proxy with optional RFC 1929 login. Names are resolved here
    (ATYP=3), which is what makes a blocked DNS work — the test asserts it."""

    def __init__(self, user="", password=""):
        self.user, self.password = user, password
        self.server = None
        self.port = 0
        self.requested = []
        self.refused = 0

    async def start(self):
        async def handle(reader, writer):
            try:
                await self._serve(reader, writer)
            except (OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                pass
            finally:
                writer.close()

        self.server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def _serve(self, reader, writer):
        _version, count = await reader.readexactly(2)
        methods = await reader.readexactly(count)
        if self.user:
            if 0x02 not in methods:
                writer.write(b"\x05\xff")
                return
            writer.write(b"\x05\x02")
            await writer.drain()
            _v, length = await reader.readexactly(2)
            user = await reader.readexactly(length)
            (length,) = await reader.readexactly(1)
            password = await reader.readexactly(length)
            if (user.decode(), password.decode()) != (self.user, self.password):
                self.refused += 1
                writer.write(b"\x01\x01")
                return
            writer.write(b"\x01\x00")
        else:
            if 0x00 not in methods:
                writer.write(b"\x05\xff")
                return
            writer.write(b"\x05\x00")
        await writer.drain()

        _v, command, _rsv, atyp = await reader.readexactly(4)
        if atyp == 0x03:
            (length,) = await reader.readexactly(1)
            host = (await reader.readexactly(length)).decode()
        elif atyp == 0x01:
            host = ".".join(str(b) for b in await reader.readexactly(4))
        else:
            host = None
            await reader.readexactly(16)
        port, = struct.unpack(">H", await reader.readexactly(2))
        self.requested.append((command, atyp, host, port))
        if command != 0x01 or host is None:
            writer.write(b"\x05\x07\x00\x01" + b"\x00" * 6)
            return
        try:
            up_reader, up_writer = await asyncio.open_connection(host, port)
        except OSError:
            writer.write(b"\x05\x05\x00\x01" + b"\x00" * 6)
            return
        writer.write(b"\x05\x00\x00\x01" + b"\x7f\x00\x00\x01" + struct.pack(">H", 0))
        await writer.drain()
        await _splice(reader, writer, up_reader, up_writer)

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()


class OriginServer:
    """A plain HTTP origin: answers any GET with a fixed body, and records the
    request line it saw (so a test can prove the rewrite happened)."""

    def __init__(self):
        self.server = None
        self.port = 0
        self.requests = []

    async def start(self):
        body = b"hello from the origin"

        async def handle(reader, writer):
            try:
                head = await reader.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                writer.close()
                return
            self.requests.append(head.split(b"\r\n")[0].decode("latin-1"))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
            await writer.drain()
            writer.close()

        self.server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        fake_host = types.SimpleNamespace(
            WINDOWS=False,
            settings_file=lambda name: str(self.root / name),
            settings_dir=lambda: str(self.root),
        )
        with patch.dict(sys.modules, {
            "host": fake_host,
            "decky": types.SimpleNamespace(logger=logging.getLogger(__name__)),
        }):
            self.netproxy = load("discord_client/netproxy")
        self.netproxy.CONFIG_FILE = str(self.root / "steamcord-proxy.json")

    # ── settings ────────────────────────────────────────────────────────────
    def test_defaults_are_off_and_harmless(self):
        cfg = self.netproxy.load()
        self.assertFalse(cfg["enabled"])
        self.assertEqual(cfg["scheme"], "socks5")
        self.assertFalse(self.netproxy.is_active(cfg))
        self.assertIsNone(self.netproxy.client_proxy_url(cfg))
        self.assertEqual(self.netproxy.chromium_flags(cfg), [])
        self.assertEqual(self.netproxy.env(cfg), {})

    def test_normalise_rejects_what_chromium_would_ignore(self):
        for bad, code in (
            ({"enabled": True, "host": ""}, "proxy_err_host"),
            ({"scheme": "ftp"}, "proxy_err_scheme"),
            ({"scheme": "socks5", "port": 0}, "proxy_err_port"),
            ({"scheme": "socks5", "port": "abc"}, "proxy_err_port"),
            ({"scheme": "socks5", "host": "1.2.3.4/path"}, "proxy_err_host"),
        ):
            with self.subTest(raw=bad):
                with self.AssertRaises if False else self.assertRaises(ValueError) as ctx:
                    self.netproxy.normalise(bad)
                self.assertEqual(str(ctx.exception), code)

    def test_pasted_proxy_url_fills_every_field(self):
        cfg = self.netproxy.normalise({
            "enabled": True,
            "host": "socks5://user:p%40ss@proxy.example.com:1081",
        })
        self.assertEqual(cfg["scheme"], "socks5")
        self.assertEqual(cfg["host"], "proxy.example.com")
        self.assertEqual(cfg["port"], 1081)
        self.assertEqual(cfg["username"], "user")
        self.assertEqual(cfg["password"], "p@ss")

    def test_a_pasted_url_wins_over_stale_fields(self):
        # The panel keeps the old port/login in its fields; pasting a full URL
        # must not be half-applied (it would aim at the wrong port silently).
        cfg = self.netproxy.normalise({
            "enabled": True, "scheme": "socks5", "host": "http://u2:p2@proxy:3129",
            "port": "1080", "username": "u1", "password": "p1",
        })
        self.assertEqual((cfg["scheme"], cfg["host"], cfg["port"]), ("http", "proxy", 3129))
        self.assertEqual((cfg["username"], cfg["password"]), ("u2", "p2"))

    def test_ipv6_proxy_is_bracketed_in_urls(self):
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "::1", "port": 1080})
        self.assertTrue(any("socks5://[::1]:1080" in f
                            for f in self.netproxy.chromium_flags(cfg)))
        self.assertEqual(self.netproxy.client_proxy_url(cfg), "socks5://[::1]:1080")

    def test_save_round_trip_is_private_and_merges(self):
        result = self.netproxy.save({"enabled": True, "scheme": "http",
                                     "host": "10.0.0.2", "port": 3128,
                                     "username": "u", "password": "s3cr3t"})
        self.assertTrue(result["ok"])
        self.assertEqual(stat.S_IMODE(os.stat(self.netproxy.CONFIG_FILE).st_mode), 0o600)
        self.assertTrue(self.netproxy.is_active())
        # A partial update keeps the rest.
        self.assertTrue(self.netproxy.save({"bypass": "192.168.0.1 , ;localhost"} )["ok"])
        cfg = self.netproxy.load()
        self.assertEqual(cfg["host"], "10.0.0.2")
        self.assertEqual(cfg["bypass"], "192.168.0.1,localhost")
        self.assertEqual(cfg["password"], "s3cr3t")

    def test_secret_never_appears_in_describe(self):
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "http",
                                       "host": "proxy", "port": 8080,
                                       "username": "user", "password": "hunter2"})
        text = self.netproxy.describe(cfg)
        self.assertIn("proxy:8080", text)
        self.assertNotIn("hunter2", text)
        self.assertNotIn("user", text)

    # ── what Vesktop gets ───────────────────────────────────────────────────
    def test_flags_direct_when_no_login(self):
        cfg = self.netproxy.normalise({"enabled": True, "host": "1.2.3.4",
                                       "scheme": "socks5", "port": 1080})
        flags = self.netproxy.chromium_flags(cfg)
        self.assertIn("--proxy-server=socks5://1.2.3.4:1080", flags)
        self.assertIn("--disable-quic", flags)
        self.assertFalse(any(f.startswith("--proxy-bypass-list") for f in flags))

    def test_flags_point_at_the_bridge_and_keep_localhost_direct(self):
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "http",
                                       "host": "proxy.example", "port": 8080,
                                       "username": "u", "password": "p",
                                       "bypass": "localhost,192.168.1.0/24"})
        flags = self.netproxy.chromium_flags(cfg, bridge="http://127.0.0.1:39021")
        self.assertIn("--proxy-server=http://127.0.0.1:39021", flags)
        self.assertIn("--proxy-bypass-list=localhost,192.168.1.0/24", flags)
        # The credential itself never goes on a command line (visible in `ps`).
        self.assertFalse(any("p" == part or "u:" in part for part in flags))

    def test_env_and_client_urls_follow_the_setting(self):
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "proxy", "port": 1080,
                                       "username": "u", "password": "p",
                                       "bypass": "localhost"})
        env = self.netproxy.env(cfg, bridge="http://127.0.0.1:39021")
        self.assertEqual(env["https_proxy"], "http://127.0.0.1:39021")
        self.assertEqual(env["no_proxy"], "localhost")
        # Without a bridge the upstream URL carries the login for urllib's
        # ProxyHandler (percent-encoded, so a '@' in a password survives).
        self.assertEqual(self.netproxy.client_proxy_url(cfg),
                         "socks5://u:p@proxy:1080")


    def test_https_proxy_login_is_never_sent_in_clear(self):
        # Without the bridge, urllib/aiohttp could only reach an "https" proxy
        # in plain HTTP, login included: no route rather than a leaked login.
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "https",
                                       "host": "proxy.example.com", "port": 443,
                                       "username": "u", "password": "s3cr3t"})
        self.assertIsNone(self.netproxy.aiohttp_proxy(cfg, None))
        self.assertEqual(self.netproxy.env(cfg, None), {})
        self.assertNotIn("s3cr3t", repr(self.netproxy.chromium_flags(cfg, None)))

    def test_panel_never_receives_the_password(self):
        cfg = self.netproxy.normalise({"enabled": True, "host": "1.2.3.4",
                                       "username": "u", "password": "s3cr3t"})
        public = self.netproxy.public(cfg)
        self.assertNotIn("password", public)
        self.assertTrue(public["has_password"])
        self.assertNotIn("s3cr3t", json.dumps(public))
        # Clearing the username is how the panel removes a stored password.
        self.assertEqual(self.netproxy.normalise({**cfg, "username": ""})["password"], "")


class BridgeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        fake_host = types.SimpleNamespace(
            WINDOWS=False,
            settings_file=lambda name: str(Path(self.tmp.name) / name),
            settings_dir=lambda: self.tmp.name,
        )
        with patch.dict(sys.modules, {
            "host": fake_host,
            "decky": types.SimpleNamespace(logger=logging.getLogger(__name__)),
        }):
            self.netproxy = load("discord_client/netproxy")
        self.netproxy.CONFIG_FILE = str(Path(self.tmp.name) / "steamcord-proxy.json")
        self.echo = await EchoServer().start()
        self.addAsyncCleanup(self.echo.stop)

    async def asyncTearDown(self):
        await self.netproxy.stop_bridge()
        self.tmp.cleanup()

    async def _through_bridge(self, cfg, target_host="127.0.0.1"):
        bridge = await self.netproxy.ensure_bridge(cfg)
        self.assertIsNotNone(bridge)
        port = int(bridge.rsplit(":", 1)[1])
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"CONNECT {target_host}:{self.echo.port} HTTP/1.1\r\n"
                     f"Host: {target_host}:{self.echo.port}\r\n\r\n".encode())
        await writer.drain()
        status = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        if b" 200 " not in status:
            writer.close()
            return status.decode("latin-1"), bridge
        writer.write(b"ping")
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(4), 10), b"ping")
        writer.close()
        return "200", bridge

    async def test_socks5_with_login_is_usable_by_chromium(self):
        socks = await FakeSocks5("user", "pass").start()
        self.addAsyncCleanup(socks.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "127.0.0.1", "port": socks.port,
                                       "username": "user", "password": "pass"})
        # A NAME, not an address: the point of a proxy where DNS is filtered.
        status, bridge = await self._through_bridge(cfg, target_host="localhost")
        self.assertEqual(status, "200")
        self.assertTrue(bridge.startswith("http://127.0.0.1:"))
        self.assertEqual(socks.refused, 0)
        # ATYP 3 = the name travels to the proxy, so a blocked DNS still works.
        self.assertEqual(socks.requested[0][1], 3)
        self.assertEqual(socks.requested[0][2], "localhost")

    async def test_http_proxy_with_login_gets_its_credentials(self):
        proxy = await FakeHttpProxy("user", "pass").start()
        self.addAsyncCleanup(proxy.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "http",
                                       "host": "127.0.0.1", "port": proxy.port,
                                       "username": "user", "password": "pass"})
        status, _bridge = await self._through_bridge(cfg)
        self.assertEqual(status, "200")
        self.assertEqual(proxy.refused, 0)
        self.assertEqual(proxy.connects[0][0], "CONNECT")
        self.assertTrue(proxy.connects[0][2]["proxy-authorization"].startswith("Basic "))

    async def test_open_proxy_without_login_still_works(self):
        socks = await FakeSocks5().start()
        self.addAsyncCleanup(socks.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "127.0.0.1", "port": socks.port})
        self.assertEqual((await self._through_bridge(cfg))[0], "200")

    async def test_wrong_login_is_reported_not_silently_direct(self):
        proxy = await FakeHttpProxy("user", "pass").start()
        self.addAsyncCleanup(proxy.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "http",
                                       "host": "127.0.0.1", "port": proxy.port,
                                       "username": "user", "password": "wrong"})
        status, _bridge = await self._through_bridge(cfg)
        self.assertNotEqual(status, "200")
        self.assertEqual(proxy.refused, 1)

    async def test_unreachable_proxy_answers_502(self):
        # Nothing listens on that port: Chromium must see a failure, never a
        # silent direct connection that would leak around the proxy.
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "127.0.0.1", "port": 9})
        status, _bridge = await self._through_bridge(cfg)
        self.assertNotEqual(status, "200")

    async def _plain_http_through_bridge(self, cfg):
        bridge = await self.netproxy.ensure_bridge(cfg)
        port = int(bridge.rsplit(":", 1)[1])
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(f"GET http://127.0.0.1:{self.origin.port}/x HTTP/1.1\r\n"
                     f"Host: 127.0.0.1:{self.origin.port}\r\n"
                     f"Proxy-Connection: keep-alive\r\n\r\n".encode())
        await writer.drain()
        # Read what the origin said; the tunnel stays half-open (as it must for
        # keep-alive), so wait for the body rather than for EOF.
        answer = b""
        while b"hello from the origin" not in answer:
            chunk = await asyncio.wait_for(reader.read(4096), 10)
            if not chunk:
                break
            answer += chunk
        writer.close()
        return answer

    async def test_plain_http_request_goes_through_an_http_proxy(self):
        self.origin = await OriginServer().start()
        self.addAsyncCleanup(self.origin.stop)
        proxy = await FakeHttpProxy("user", "pass").start()
        self.addAsyncCleanup(proxy.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "http",
                                       "host": "127.0.0.1", "port": proxy.port,
                                       "username": "user", "password": "pass"})
        answer = await self._plain_http_through_bridge(cfg)
        self.assertIn(b"200 OK", answer)
        self.assertIn(b"hello from the origin", answer)
        # Origin-form at the origin, absolute-form (plus auth) at the proxy.
        self.assertEqual(self.origin.requests, [f"GET /x HTTP/1.1"])
        self.assertEqual(proxy.connects[0][0], "GET")

    async def test_plain_http_request_goes_through_a_socks_proxy(self):
        self.origin = await OriginServer().start()
        self.addAsyncCleanup(self.origin.stop)
        socks = await FakeSocks5("user", "pass").start()
        self.addAsyncCleanup(socks.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "127.0.0.1", "port": socks.port,
                                       "username": "user", "password": "pass"})
        answer = await self._plain_http_through_bridge(cfg)
        self.assertIn(b"hello from the origin", answer)
        self.assertEqual(socks.requested[0][0], 0x01)

    async def test_bridge_follows_the_setting(self):
        socks = await FakeSocks5().start()
        self.addAsyncCleanup(socks.stop)
        cfg = self.netproxy.normalise({"enabled": True, "scheme": "socks5",
                                       "host": "127.0.0.1", "port": socks.port})
        first = await self.netproxy.ensure_bridge(cfg)
        self.assertIsNotNone(first)
        self.assertEqual(await self.netproxy.ensure_bridge(cfg), first)  # no restart
        off = self.netproxy.normalise({"enabled": False})
        self.assertIsNone(await self.netproxy.ensure_bridge(off))
        self.assertIsNone(self.netproxy.bridge_url())

    async def test_launch_flags_match_the_bridge_it_starts(self):
        socks = await FakeSocks5().start()
        self.addAsyncCleanup(socks.stop)
        self.netproxy.save({"enabled": True, "scheme": "socks5",
                            "host": "127.0.0.1", "port": socks.port})
        flags = await self.netproxy.chromium_flags_for_launch()
        bridge = self.netproxy.bridge_url()
        self.assertIsNotNone(bridge)
        self.assertIn(f"--proxy-server={bridge}", flags)


if __name__ == "__main__":
    unittest.main()
