"""Portable-runtime boundaries; runs on Linux and Windows without Decky."""
import asyncio
import ast
import hashlib
import importlib.util
import logging
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch
import zipfile

DEFAULTS = Path(__file__).resolve().parents[1] / "defaults"


def load(name):
    spec = importlib.util.spec_from_file_location(name, DEFAULTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WindowsHostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.host = load("host")
        with patch.dict(sys.modules, {"host": self.host, "decky": types.SimpleNamespace(logger=logging.getLogger(__name__))}):
            self.win = load("vesktop_win")

    def archive(self, members):
        p = self.root / "vesktop.zip"
        with zipfile.ZipFile(p, "w") as z:
            for name, data in members.items():
                z.writestr(name, data)
        return p

    def test_host_capabilities_and_linux_paths(self):
        with patch.object(self.host, "WINDOWS", False):
            self.assertTrue(all(self.host.features().values()))
            self.assertEqual(self.host.settings_file("prefs.json"), os.path.join(os.path.expanduser("~/.config"), "prefs.json"))
        with patch.object(self.host, "WINDOWS", True), patch.dict(os.environ, {
            "DECKY_PLUGIN_SETTINGS_DIR": str(self.root / "settings"),
            "DECKY_PLUGIN_RUNTIME_DIR": str(self.root / "runtime"),
        }):
            self.assertTrue(self.host.features()["stream_preview"])
            self.assertFalse(any(value for name, value in self.host.features().items() if name != "stream_preview"))
            self.assertEqual(self.host.settings_file("prefs.json"), str(self.root / "settings" / "prefs.json"))
            self.assertEqual(self.host.data_dir(), str(self.root / "runtime"))

    def test_archive_with_or_without_root_and_complete_marker(self):
        for prefix in ("", "portable/"):
            with self.subTest(prefix=prefix):
                archive = self.archive({prefix + "Vesktop.exe": b"test", prefix + "resources/app.asar": b"app"})
                target = self.root / "installed"
                self.win._unpack(archive, target)
                self.assertEqual((target / "Vesktop.exe").read_bytes(), b"test")
                self.assertTrue((target / ".steamcord-complete").is_file())
                self.assertFalse(list(self.root.glob(".unpack-*")))

    def test_unsafe_archive_preserves_existing_install(self):
        for unsafe in ("../outside", "../installed-evil/a", "/absolute", "C:/outside", "..\\outside", "Vesktop.exe:stream"):
            with self.subTest(unsafe=unsafe):
                target = self.root / "installed"
                target.mkdir(exist_ok=True)
                (target / "keep").write_bytes(b"old")
                archive = self.archive({"Vesktop.exe": b"test", unsafe: b"bad"})
                with self.assertRaises(ValueError):
                    self.win._unpack(archive, target)
                self.assertEqual((target / "keep").read_bytes(), b"old")
                self.assertFalse(list(self.root.glob(".unpack-*")))

    def test_incomplete_archive_never_becomes_installed(self):
        archive = self.archive({"resources/app.asar": b"app"})
        target = self.root / "incomplete"
        with self.assertRaises(ValueError):
            self.win._unpack(archive, target)
        self.assertFalse(target.exists())

    def test_sha256_checked_before_unpack(self):
        archive = self.archive({"Vesktop.exe": b"test"})
        target = self.root / "verified"
        with self.assertRaises(ValueError):
            self.win._checked_unpack(archive, target, "0" * 64)
        self.assertFalse(target.exists())
        self.win._checked_unpack(archive, target, hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertTrue((target / ".steamcord-complete").is_file())

    def test_profile_isolation_and_child_environment(self):
        with patch.object(self.host, "settings_dir", return_value=str(self.root)):
            command, first = self.win._command("123")
            _, second = self.win._command("456")
            self.assertNotEqual(first, second)
            self.assertIn("--user-data-dir=" + str(first / "chromium"), command)
            with patch.dict(os.environ, {"ELECTRON_RUN_AS_NODE": "1", "PYTHONHOME": "embedded"}):
                env = self.win._environment(first)
            self.assertNotIn("ELECTRON_RUN_AS_NODE", env)
            self.assertNotIn("PYTHONHOME", env)
            self.assertEqual(env["VENCORD_USER_DATA_DIR"], str(first / "vesktop"))

    def test_steam_account_fallback_selects_most_recent(self):
        config = self.root / "config"
        config.mkdir()
        (config / "loginusers.vdf").write_text('"users" { "76561197960265729" { "Timestamp" "10" } "76561197960265730" { "MostRecent" "1" "Timestamp" "20" } }', encoding="utf-8")
        with patch.object(self.host, "WINDOWS", False), patch.object(self.host, "steam_dir", return_value=str(self.root)):
            self.assertEqual(self.win.steam_account_id(), "2")

    def test_process_ownership_requires_directory_boundary(self):
        owned = self.root / "vesktop"
        candidates = [(101, str(owned / "1.6.8-x64/Vesktop.exe")),
                      (102, str(self.root / "vesktop-personal/Vesktop.exe")),
                      (103, str(self.root / "personal/Vesktop.exe"))]
        with patch.object(self.host, "processes", return_value=candidates):
            self.assertEqual(self.host.pids_under(owned), [101])

    def test_stop_only_targets_owned_processes(self):
        with patch.object(self.win, "our_pids", return_value=[101]), patch.object(self.win, "is_running", return_value=False), patch.object(self.host, "kill_tree", return_value=True) as kill:
            self.assertTrue(asyncio.run(self.win.stop("test")))
            kill.assert_called_once_with(101)

    def test_first_launch_setup_keeps_existing_profile_settings(self):
        with patch.object(self.host, "settings_dir", return_value=str(self.root)):
            profile = self.win.profile_dir("123")
            state = profile / "vesktop" / "state.json"
            settings = profile / "vesktop" / "settings.json"
            self.assertIn('"firstLaunch": false', state.read_text(encoding="utf-8"))
            settings.write_text('{"discordBranch":"canary","custom":true}', encoding="utf-8")
            self.win.profile_dir("123")
            self.assertEqual(settings.read_text(encoding="utf-8"), '{"discordBranch":"canary","custom":true}')

    def test_linux_only_guard_never_runs_helper_on_windows(self):
        source = (DEFAULTS.parent / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        decorator = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "linux_only")
        namespace = {"host": self.host}
        exec(compile(ast.Module(body=[decorator], type_ignores=[]), "main.py", "exec"), namespace)
        called = []
        async def helper(cls):
            called.append(True)
            return "linux"
        with patch.object(self.host, "WINDOWS", True):
            guarded = namespace["linux_only"]({"ok": False})(helper)
            self.assertEqual(asyncio.run(guarded(None)), {"ok": False})
            self.assertEqual(called, [])
        with patch.object(self.host, "WINDOWS", False):
            guarded = namespace["linux_only"](False)(helper)
            self.assertIs(guarded, helper)
            self.assertEqual(asyncio.run(guarded(None)), "linux")

    def test_cdp_requires_a_listener_owned_by_private_vesktop(self):
        with patch.object(self.win, "our_pids", return_value=[100]):
            for listeners, expected in ((set(), False), ({100}, True), ({200}, False), ({100, 200}, False)):
                with patch.object(self.host, "listening_pids", return_value=listeners):
                    self.assertEqual(self.win.owns_cdp(), expected)

    def test_foreign_cdp_does_not_launch_or_stop_any_process(self):
        with patch.object(self.win, "installed", return_value=True), patch.object(self.win, "is_running", return_value=False), patch.object(self.win, "_spawn") as spawn, patch.object(self.win, "stop", new_callable=AsyncMock) as stop:
            self.assertFalse(asyncio.run(self.win.launch(AsyncMock(return_value=True))))
            spawn.assert_not_called()
            stop.assert_not_called()

    @unittest.skipUnless(sys.platform == "win32", "native Windows TCP table")
    def test_native_listener_owner_matches_this_python(self):
        import socket
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            self.assertIn(os.getpid(), self.host.listening_pids(listener.getsockname()[1]))

    @unittest.skipUnless(sys.platform == "win32", "native Windows process API")
    def test_native_process_enumeration_finds_this_python(self):
        self.assertIn(os.getpid(), [pid for pid, _ in self.host.processes()])


if __name__ == "__main__":
    unittest.main()
