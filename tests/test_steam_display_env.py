import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load_vesktop():
    # Only the /proc helpers are under test: stub the runtime-only imports.
    for name in ("decky", "aiohttp", "aiohttp.client_exceptions", "tab_utils", "tab_utils.cdp"):
        sys.modules.setdefault(name, mock.MagicMock())
    sys.path.insert(0, str(ROOT / "defaults"))
    sys.path.insert(0, str(ROOT / "py_modules"))
    spec = importlib.util.spec_from_file_location("vesktop_under_test", ROOT / "defaults" / "vesktop.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SteamDisplayEnvTest(unittest.TestCase):
    def setUp(self):
        self.v = load_vesktop()
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def environ(self, mapping):
        real = Path.read_bytes

        def fake(path):
            for pid, env in mapping.items():
                if str(path) == f"/proc/{pid}/environ":
                    return b"\0".join(f"{k}={v}".encode() for k, v in env.items())
            if str(path).startswith("/proc/"):
                raise FileNotFoundError(path)
            return real(path)
        return mock.patch.object(Path, "read_bytes", fake)

    def test_missing_steampid_falls_back_to_steam_process(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}), \
             mock.patch.object(self.v, "_steam_pids", return_value=["42"]), \
             self.environ({"42": {"DISPLAY": ":0", "XAUTHORITY": "/run/x"}}):
            self.assertEqual(self.v._steam_display_env(), {"DISPLAY": ":0", "XAUTHORITY": "/run/x"})

    def test_stale_steampid_without_display_is_skipped(self):
        (self.home / ".steampid").write_text("7\n")
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}), \
             mock.patch.object(self.v, "_steam_pids", return_value=["42"]), \
             self.environ({"7": {"PATH": "/bin"}, "42": {"DISPLAY": ":0"}}):
            self.assertEqual(self.v._steam_display_env(), {"DISPLAY": ":0"})

    def test_steampid_wins_when_usable(self):
        (self.home / ".steampid").write_text("7")
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}), \
             mock.patch.object(self.v, "_steam_pids", return_value=["42"]), \
             self.environ({"7": {"DISPLAY": ":2"}, "42": {"DISPLAY": ":0"}}):
            self.assertEqual(self.v._steam_display_env()["DISPLAY"], ":2")

    def test_nothing_found_returns_empty(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}), \
             mock.patch.object(self.v, "_steam_pids", return_value=[]):
            self.assertEqual(self.v._steam_display_env(), {})


if __name__ == "__main__":
    unittest.main()
