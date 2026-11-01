"""Windows support: platform layer, Vesktop-on-Windows helpers, and the guards that
keep Linux-only code from running on a Windows host.

Runs on Linux (the Windows host is simulated by patching `sc_platform`) AND on a
real Windows runner, where the extra `RealWindowsTest` cases exercise the actual
Win32 calls (process table, known folders, netstat).
"""

import ast
import importlib.util
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = ROOT / "defaults"


def _stub_runtime():
    for name in ("decky", "aiohttp", "aiohttp.client_exceptions", "tab_utils", "tab_utils.cdp"):
        sys.modules.setdefault(name, mock.MagicMock())
    for p in (str(DEFAULTS), str(ROOT / "py_modules")):
        if p not in sys.path:
            sys.path.insert(0, p)


def _load(name, path, fresh=()):
    for mod in fresh:
        sys.modules.pop(mod, None)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_stub_runtime()
import sc_platform  # noqa: E402


class PlatformCapsTest(unittest.TestCase):
    def test_linux_keeps_every_feature(self):
        with mock.patch.object(sc_platform, "IS_LINUX", True), \
                mock.patch.object(sc_platform, "IS_WINDOWS", False):
            caps = sc_platform.capabilities()
        self.assertTrue(all(caps.values()), caps)

    def test_windows_drops_the_linux_stack_but_keeps_the_core(self):
        with mock.patch.object(sc_platform, "IS_LINUX", False), \
                mock.patch.object(sc_platform, "IS_WINDOWS", True):
            caps = sc_platform.capabilities()
        for name in sc_platform._LINUX_ONLY:
            self.assertFalse(caps[name], name)
        for name in ("voice", "text_chat", "direct_messages", "qr_login", "notifications",
                     "rich_presence", "screen_share", "multi_account"):
            self.assertTrue(caps[name], name)

    def test_frontend_mirror_matches_backend(self):
        """src/platform.ts must list exactly the same feature names."""
        ts = (ROOT / "src" / "platform.ts").read_text(encoding="utf-8")

        def names(var):
            body = re.search(rf"const {var} = \[(.*?)\];", ts, re.S).group(1)
            return re.findall(r'"([a-z_]+)"', body)

        self.assertEqual(sorted(names("LINUX_ONLY")), sorted(sc_platform._LINUX_ONLY))
        self.assertEqual(sorted(names("BOTH")), sorted(sc_platform._BOTH))

    def test_detection_does_not_use_getuid(self):
        # Decky for Windows emulates os.getuid(); only sys.platform tells the truth.
        src = (DEFAULTS / "sc_platform.py").read_text(encoding="utf-8")
        code = re.sub(r'""".*?"""', "", src, flags=re.S)
        code = "\n".join(l.split("#")[0] for l in code.splitlines())
        self.assertNotIn("getuid", code)


class PathsTest(unittest.TestCase):
    def test_linux_config_stays_in_dot_config(self):
        with mock.patch.object(sc_platform, "IS_WINDOWS", False):
            self.assertEqual(sc_platform.config_file("steamcord-rpc.json"),
                             os.path.join(os.path.expanduser("~/.config"), "steamcord-rpc.json"))
            self.assertEqual(sc_platform.tmp_file("x.jpg"), os.path.join("/tmp", "x.jpg"))

    def test_windows_config_uses_the_decky_settings_dir_and_creates_it(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "settings", "Steamcord")
            with mock.patch.object(sc_platform, "IS_WINDOWS", True), \
                    mock.patch.dict(os.environ, {"DECKY_PLUGIN_SETTINGS_DIR": target}):
                path = sc_platform.config_file("steamcord-rpc.json")
            self.assertEqual(path, os.path.join(target, "steamcord-rpc.json"))
            self.assertTrue(os.path.isdir(target))

    def test_steam_clip_globs(self):
        with mock.patch.object(sc_platform, "IS_WINDOWS", False):
            self.assertTrue(os.path.normpath(sc_platform.steam_clip_globs()[0]).endswith(
                os.path.join("userdata", "*", "gamerecordings", "clips")))
        with tempfile.TemporaryDirectory() as steam, \
                mock.patch.object(sc_platform, "IS_WINDOWS", True), \
                mock.patch.object(sc_platform, "steam_root", return_value=steam):
            self.assertEqual(sc_platform.steam_clip_globs(),
                             [os.path.join(steam, "userdata", "*", "gamerecordings", "clips")])

    def test_exe_stem(self):
        self.assertEqual(sc_platform.exe_stem("Vesktop.exe"), "vesktop")
        self.assertEqual(sc_platform.exe_stem(r"C:\x\VESKTOP.EXE"), "vesktop")
        self.assertEqual(sc_platform.exe_stem(""), "")

    def test_process_helpers_are_inert_off_windows(self):
        with mock.patch.object(sc_platform, "IS_WINDOWS", False):
            self.assertEqual(sc_platform.windows_processes(), [])
            self.assertEqual(sc_platform.windows_pids("python"), [])


class VesktopWindowsTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(sc_platform, "IS_WINDOWS", True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = mock.patch.dict(os.environ, {"DECKY_PLUGIN_SETTINGS_DIR": self.tmp.name,
                                           "DECKY_PLUGIN_RUNTIME_DIR": self.tmp.name})
        env.start()
        self.addCleanup(env.stop)
        self.w = _load("vesktop_windows_under_test", DEFAULTS / "vesktop_windows.py")

    def test_launch_args_open_the_debug_port_with_a_private_profile(self):
        prof = self.w.ensure_profile("123456")
        args = self.w.launch_args(prof)
        self.assertIn("--remote-debugging-port=9223", args)
        self.assertIn("--remote-allow-origins=*", args)
        self.assertIn(f"--user-data-dir={prof['electron']}", args)
        self.assertIn("--start-minimized", args)
        # none of the Linux-only Electron workarounds
        self.assertFalse([a for a in args if "ozone" in a or "VideoDecodeLinux" in a])

    def test_launch_env_is_clean_for_electron(self):
        prof = self.w.ensure_profile("1")
        with mock.patch.dict(os.environ, {"ELECTRON_RUN_AS_NODE": "1", "PYTHONHOME": "x"}):
            env = self.w.launch_env(prof)
        self.assertNotIn("ELECTRON_RUN_AS_NODE", env)
        self.assertNotIn("PYTHONHOME", env)
        self.assertEqual(env["VENCORD_USER_DATA_DIR"], str(prof["vencord"]))

    def test_profiles_are_separate_per_account_and_names_are_sanitised(self):
        a, b = self.w.ensure_profile("111"), self.w.ensure_profile("222")
        self.assertNotEqual(a["electron"], b["electron"])
        weird = self.w.ensure_profile("..\\..\\evil")
        self.assertTrue(str(weird["root"]).startswith(str(self.w.profiles_dir())))
        for p in a.values():
            self.assertTrue(Path(p).is_dir())

    def test_recorded_account_round_trip(self):
        self.assertEqual(self.w.recorded_account(), "")
        self.w.record_account("4242")
        self.assertEqual(self.w.recorded_account(), "4242")

    def test_exe_override_wins(self):
        exe = Path(self.tmp.name) / "Vesktop.exe"
        exe.write_bytes(b"MZ")
        with mock.patch.dict(os.environ, {"STEAMCORD_VESKTOP_EXE": str(exe)}):
            self.assertEqual(self.w.find_exe(), str(exe))
        with mock.patch.dict(os.environ, {"STEAMCORD_VESKTOP_EXE": str(exe) + ".missing"}):
            self.assertNotEqual(self.w.find_exe(), str(exe) + ".missing")

    def test_backend_is_always_windows_so_a_missing_vesktop_gets_installed(self):
        self.assertEqual(self.w.backend(), "windows")

    def test_steam_account_from_loginusers(self):
        steam = Path(self.tmp.name) / "Steam"
        (steam / "config").mkdir(parents=True)
        base = 76561197960265728
        (steam / "config" / "loginusers.vdf").write_text(
            '"users"\n{\n'
            f'\t"{base + 1000}"\n\t{{\n\t\t"AccountName"\t"old"\n\t\t"Timestamp"\t"100"\n\t}}\n'
            f'\t"{base + 2000}"\n\t{{\n\t\t"AccountName"\t"new"\n\t\t"MostRecent"\t"1"\n'
            '\t\t"Timestamp"\t"200"\n\t}\n}\n')
        with mock.patch.object(sc_platform, "IS_WINDOWS", False), \
                mock.patch.object(sc_platform, "steam_root", return_value=str(steam)):
            self.assertEqual(self.w.steam_account_id(), "2000")

    def test_steam_account_defaults_when_steam_is_unknown(self):
        with mock.patch.object(sc_platform, "IS_WINDOWS", False), \
                mock.patch.object(sc_platform, "steam_root", return_value=None):
            self.assertEqual(self.w.steam_account_id(), "default")


class VesktopDispatchTest(unittest.TestCase):
    """vesktop.py must hand over to the Windows module - and must never match or
    signal processes by command line there (a bare name match would hit Decky)."""

    @classmethod
    def setUpClass(cls):
        patcher = mock.patch.object(sc_platform, "IS_WINDOWS", True)
        patcher.start()
        cls.addClassCleanup(patcher.stop)
        sys.modules.pop("vesktop_windows", None)
        cls.v = _load("vesktop_win_dispatch", DEFAULTS / "vesktop.py")

    def test_dispatches_to_the_windows_backend(self):
        self.assertTrue(self.v.IS_WINDOWS)
        self.assertEqual(self.v.backend(), "windows")

    def test_command_line_filters_match_nothing(self):
        with mock.patch.object(sc_platform, "windows_pids", return_value=[4242]) as m:
            self.assertEqual(self.v.proc_pids(comm=r"python3?(\.\d+)?",
                                              cmdline=r"game_overlay/overlay\.py"), [])
            m.assert_not_called()
            self.assertEqual(self.v.proc_pids(cmdline="anything"), [])
            self.assertEqual(self.v.proc_pids(comm="vesktop"), [4242])

    def test_nothing_is_killed_by_pattern(self):
        with mock.patch("os.kill") as kill:
            self.assertEqual(self.v.proc_kill("gst_webrtc.py"), 0)
            kill.assert_not_called()

    def test_linux_only_helpers_are_inert(self):
        self.assertFalse(self.v.release_portal_sessions())
        self.assertNotIn("XDG_RUNTIME_DIR", self.v._user_env() if "XDG_RUNTIME_DIR" not in os.environ else {})


class MainGuardsTest(unittest.TestCase):
    """Static checks on main.py (it cannot be imported outside Decky)."""

    @classmethod
    def setUpClass(cls):
        cls.src = (ROOT / "main.py").read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.src)

    def _plugin_methods(self):
        for node in self.tree.body:
            if isinstance(node, ast.ClassDef) and node.name == "Plugin":
                return {n.name for n in node.body
                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        self.fail("class Plugin not found")

    def test_every_windows_stub_replaces_a_real_callable(self):
        stubs = None
        for node in self.tree.body:
            if isinstance(node, ast.Assign) and any(
                    getattr(t, "id", "") == "_WIN_UNSUPPORTED" for t in node.targets):
                stubs = ast.literal_eval(node.value)
        self.assertIsNotNone(stubs, "_WIN_UNSUPPORTED missing")
        missing = sorted(set(stubs) - self._plugin_methods())
        self.assertEqual(missing, [], "stubs for callables that no longer exist")

    def test_platform_caps_callable_exists(self):
        self.assertIn("get_platform_caps", self._plugin_methods())

    def test_linux_subprocess_spawns_are_skipped_on_windows(self):
        # the GStreamer relay and the portal shim must sit behind the IS_WINDOWS switch
        main_body = self.src[self.src.index("async def _main(cls)"):]
        gate = main_body.index("if IS_WINDOWS:")
        self.assertLess(gate, main_body.index("cls.webrtc_server = await create_subprocess_exec"))
        self.assertLess(gate, main_body.index("cls.portal_shim = await create_subprocess_exec"))

    def test_settings_files_go_through_the_platform_layer(self):
        self.assertNotIn('expanduser("~/.config/steamcord-', self.src)

    def test_local_server_is_loopback_only_on_windows(self):
        self.assertIn('"127.0.0.1" if IS_WINDOWS else "0.0.0.0"', self.src)


class TextEncodingTest(unittest.TestCase):
    """On Windows, Python opens text files with the legacy ANSI code page unless told
    otherwise, and Steamcord's own JavaScript and settings files are UTF-8. The first
    Windows run died on exactly this (UnicodeDecodeError 'charmap' while reading
    steamcord_client.js), so every text-mode open / read_text / write_text must name
    its encoding."""

    def _files(self):
        # Every backend file, the Steam Deck-only helpers included: one bare open()
        # is all it takes, and a skip list goes stale as code moves around.
        return [ROOT / "main.py"] + sorted(
            p for p in DEFAULTS.rglob("*.py") if "__pycache__" not in p.parts)

    @staticmethod
    def _binary_mode(call):
        mode = None
        if len(call.args) > 1 and isinstance(call.args[1], ast.Constant):
            mode = call.args[1].value
        for kw in call.keywords:
            if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                mode = kw.value.value
        return isinstance(mode, str) and "b" in mode

    def test_every_text_file_access_names_its_encoding(self):
        offenders = []
        for path in self._files():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                is_open = isinstance(fn, ast.Name) and fn.id == "open"
                is_text_io = isinstance(fn, ast.Attribute) and fn.attr in ("read_text", "write_text")
                if not (is_open or is_text_io):
                    continue
                if is_open and self._binary_mode(node):
                    continue
                if not any(kw.arg == "encoding" for kw in node.keywords):
                    offenders.append(f"{path.relative_to(ROOT)}:{node.lineno}")
        self.assertEqual(offenders, [], "text-mode file access without encoding= (breaks on Windows)")

    def test_injected_scripts_are_valid_utf8(self):
        # The exact files that broke the first Windows start.
        for name in ("steamcord_client.js", "webrtc_client.js"):
            (DEFAULTS / name).read_bytes().decode("utf-8")

    def test_startup_retry_log_line_is_bounded(self):
        src = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertNotIn('initialize() failed ({e!r})', src)
        self.assertIn('"...(truncated)"', src)


@unittest.skipUnless(sys.platform == "win32", "needs a real Windows host")
class RealWindowsTest(unittest.TestCase):
    def test_process_table_contains_this_python(self):
        procs = sc_platform.windows_processes()
        mine = [p for p in procs if p[0] == os.getpid()]
        self.assertEqual(len(mine), 1)
        self.assertIn("python", sc_platform.exe_stem(mine[0][2]))

    def test_windows_pids_never_returns_ourselves(self):
        self.assertNotIn(os.getpid(), sc_platform.windows_pids("python.*"))

    def test_exe_names_are_listed(self):
        names = sc_platform.windows_exe_names()
        self.assertTrue(names)
        self.assertTrue(all(isinstance(n, str) for n in names))

    def test_downloads_dir_exists(self):
        self.assertTrue(os.path.isdir(sc_platform.downloads_dir()))

    def test_netstat_lookup_returns_zero_for_a_free_port(self):
        w = _load("vesktop_windows_real", DEFAULTS / "vesktop_windows.py")
        self.assertEqual(w.pid_listening(59999), 0)

    def test_listening_socket_is_found(self):
        import socket
        w = _load("vesktop_windows_real2", DEFAULTS / "vesktop_windows.py")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            port = s.getsockname()[1]
            self.assertEqual(w.pid_listening(port), os.getpid())

    def test_registry_steam_root_is_a_directory_or_none(self):
        root = sc_platform.steam_root()
        self.assertTrue(root is None or os.path.isdir(root))


if __name__ == "__main__":
    unittest.main()
