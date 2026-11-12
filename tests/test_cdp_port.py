"""#95: Vesktop's debugging port stays clear of other plugins' browsers, and
Steamcord never connects to a port another program owns."""
import asyncio
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_steam_display_env import load_vesktop, ROOT

sys.path.insert(0, str(ROOT / "defaults"))
import host  # noqa: E402


class CdpPortTests(unittest.TestCase):
    def test_port_is_one_shared_constant_away_from_other_plugins(self):
        self.assertNotIn(host.CDP_PORT, range(9222, 9225))
        self.assertNotIn(host.CDP_PORT, range(39021, 39026))  # proxy bridge
        v = load_vesktop()
        self.assertEqual(v.VESKTOP_CDP, f"http://127.0.0.1:{host.CDP_PORT}")
        for name in ("vesktop.py", "vesktop_win.py"):
            text = (ROOT / "defaults" / name).read_text(encoding="utf-8")
            self.assertNotIn("--remote-debugging-port=9223", text)
            self.assertNotIn('"http://127.0.0.1:9223"', text)

    def test_linux_owner_lookup_from_proc(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = Path(tmp)
            (proc / "net").mkdir()
            port = format(host.CDP_PORT, "04X")
            (proc / "net/tcp").write_text(
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                f"   0: 0100007F:{port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1\n"
                f"   1: 0100007F:{port} 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 222 1\n"
                "   2: 0100007F:2407 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1\n")
            for pid, target in (("10", "socket:[111]"), ("11", "socket:[222]"), ("12", "socket:[333]")):
                (proc / pid / "fd").mkdir(parents=True)
                os.symlink(target, proc / pid / "fd" / "5")
            (proc / "13").mkdir()  # no readable fd directory
            self.assertEqual(host._linux_listening_pids(host.CDP_PORT, proc), {10})
            self.assertEqual(host._linux_listening_pids(1234, proc), set())

    def test_linux_owner_lookup_finds_a_real_listener(self):
        if host.WINDOWS or not Path("/proc/net/tcp").exists():
            self.skipTest("Linux /proc only")
        s = socket.socket()
        s.bind(("127.0.0.1", 0)); s.listen(1)
        try:
            self.assertIn(os.getpid(), host._linux_listening_pids(s.getsockname()[1]))
        finally:
            s.close()

    def test_foreign_owner_is_refused_and_unknown_owner_keeps_working(self):
        v = load_vesktop()
        with mock.patch.object(v.host, "WINDOWS", False), \
                mock.patch.object(v, "_port_is_up", mock.AsyncMock(return_value=True)):
            with mock.patch.object(v.host, "listening_pids", return_value={500}), \
                    mock.patch.object(v, "proc_pids", return_value=[42]):
                self.assertFalse(asyncio.run(v.is_up()))
            with mock.patch.object(v.host, "listening_pids", return_value={42}), \
                    mock.patch.object(v, "proc_pids", return_value=[42, 43]):
                self.assertTrue(asyncio.run(v.is_up()))
            with mock.patch.object(v.host, "listening_pids", return_value=set()), \
                    mock.patch.object(v, "proc_pids", return_value=[]):
                self.assertTrue(asyncio.run(v.is_up()))


if __name__ == "__main__":
    unittest.main()
