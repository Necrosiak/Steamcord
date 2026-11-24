"""#114: local services stay on localhost and only answer the injected client,
the Vesktop debugging port refuses web origins, the ScreenCast portal only
serves our Vesktop, and update archives with unsafe entries are refused."""
import io
import os
import re
import sys
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = ROOT / "defaults"


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


class LocalBindingTests(unittest.TestCase):
    def test_servers_listen_on_localhost_only(self):
        self.assertIn('TCPSite(cls.runner, "127.0.0.1", 65123)', read("main.py"))
        self.assertIn('TCPSite(runner, "127.0.0.1", 65124)', read("defaults/gst_webrtc.py"))
        for rel in ("main.py", "defaults/gst_webrtc.py"):
            self.assertNotRegex(read(rel), r"TCPSite\([^)]*\"0\.0\.0\.0\"")

    def test_vesktop_debugging_is_bound_to_localhost(self):
        for rel in ("defaults/vesktop.py", "defaults/vesktop_win.py"):
            self.assertIn("--remote-debugging-address=127.0.0.1", read(rel))


class LocalKeyTests(unittest.TestCase):
    def test_backend_requires_the_session_key(self):
        main = read("main.py")
        self.assertIn("LOCAL_KEY = _secrets.token_urlsafe(", main)
        self.assertIn("_hmac.compare_digest", main)
        handler = main[main.index("async def _websocket_handler"):]
        handler = handler[:handler.index("await cls.evt_handler.main(ws)")]
        self.assertIn("if not local_key_ok(request):", handler)
        self.assertIn("status=403", handler)

    def test_relay_requires_the_session_key(self):
        relay = read("defaults/gst_webrtc.py")
        handler = relay[relay.index("async def websocket_handler"):]
        handler = handler[:handler.index("await ws.prepare(request)")]
        self.assertIn("hmac.compare_digest", handler)
        self.assertIn("status=403", handler)
        self.assertIn('"STEAMCORD_WS_KEY": LOCAL_KEY', read("main.py"))

    def test_injected_clients_send_the_key(self):
        self.assertIn("window.STEAMCORD_WS_KEY", read("main.py"))
        for rel, url in (("defaults/steamcord_client.js", "65123/socket?k="),
                         ("defaults/webrtc_client.js", "65124/webrtc?k=")):
            text = read(rel)
            self.assertIn(url, text)
            self.assertNotRegex(text, r"new WebSocket\(['\"]ws://127\.0\.0\.1:6512[34]/[a-z]+['\"]\)")

    def test_websocket_messages_are_capped(self):
        self.assertNotIn("max_msg_size=0", read("main.py"))


class DevToolsOriginTests(unittest.TestCase):
    def test_no_wildcard_origin(self):
        for rel in ("defaults/vesktop.py", "defaults/vesktop_win.py"):
            self.assertNotIn('"--remote-allow-origins=*"', read(rel))


def load_portal_check():
    src = read("defaults/portal_shim.py")
    start = src.index("_VESKTOP_CGROUPS = ")
    end = src.index("def _shim_pid_path():")
    ns = {"os": os, "Path": Path}
    exec(src[start:end], ns)
    return ns


class PortalCallerTests(unittest.TestCase):
    def check(self, cgroup, exe, uid=None):
        ns = load_portal_check()
        stat = types.SimpleNamespace(st_uid=os.getuid() if uid is None else uid)
        with mock.patch.object(ns["os"], "stat", return_value=stat), \
             mock.patch.object(ns["os"], "readlink", return_value=exe), \
             mock.patch.object(Path, "read_text", return_value=cgroup):
            return ns["_is_our_vesktop"](1234)

    def test_flatpak_scope_is_accepted(self):
        self.assertTrue(self.check(
            "0::/user.slice/app.slice/app-flatpak-dev.vencord.Vesktop-3060524032.scope\n",
            "/usr/bin/xdg-dbus-proxy"))

    def test_plugin_unit_is_accepted(self):
        self.assertTrue(self.check(
            "0::/user.slice/app.slice/steamcord-vesktop.service\n", "/usr/bin/electron"))

    def test_native_vesktop_binary_is_accepted(self):
        self.assertTrue(self.check("0::/user.slice/app.slice/other.scope\n", "/opt/Vesktop/vesktop"))

    def test_other_electron_or_discord_named_process_is_refused(self):
        self.assertFalse(self.check("0::/user.slice/app.slice/app-code.scope\n", "/usr/lib/electron/electron"))
        self.assertFalse(self.check("0::/user.slice/app.slice/bot.scope\n", "/usr/bin/python3"))

    def test_other_user_is_refused(self):
        self.assertFalse(self.check(
            "0::/user.slice/app.slice/app-flatpak-dev.vencord.Vesktop-1.scope\n",
            "/app/bin/vesktop/vesktop.bin", uid=os.getuid() + 1))


def load_updater():
    sys.path.insert(0, str(DEFAULTS))
    sys.modules.setdefault("decky", types.SimpleNamespace(logger=None, DECKY_PLUGIN_DIR="/tmp"))
    import updater  # noqa: E402
    return updater


def archive(*entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, link in entries:
            info = zipfile.ZipInfo(name)
            if link:
                info.external_attr = 0o120777 << 16
            z.writestr(info, "x")
    return zipfile.ZipFile(buf)


class UpdateArchiveTests(unittest.TestCase):
    def test_normal_release_layout_passes(self):
        load_updater()._check_members(archive(("Steamcord/main.py", False), ("Steamcord/dist/index.js", False)))

    def test_unsafe_entries_are_refused(self):
        check = load_updater()._check_members
        for entry in (("../evil", False), ("Steamcord/../../evil", False), ("/etc/evil", False),
                      ("C:/evil", False), ("Steamcord/link", True)):
            with self.subTest(entry=entry[0]):
                with self.assertRaises(ValueError):
                    check(archive(entry))


if __name__ == "__main__":
    unittest.main()
