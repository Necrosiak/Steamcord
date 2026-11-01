"""Platform layer: one Steamcord zip, two hosts (Steam Deck / Linux and Windows).

Everything that differs between Decky Loader on Linux (SteamOS, Bazzite, ...) and
Decky Loader for Windows (Steam Big Picture) is answered here, so the rest of the
backend can ask "where does this live?" or "does this feature exist here?" instead
of sprinkling `sys.platform` checks around.

Detection is `sys.platform`, NEVER `os.getuid()`: Decky for Windows emulates
`os.getuid()` (it returns 0 or 1000), so it says nothing about the host.

This file is named `sc_platform` on purpose - a `platform.py` next to main.py
would shadow the standard library module of the same name.
"""

import ctypes
import os
import re
import sys
import tempfile
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
IS_LINUX = sys.platform.startswith("linux")
OS_NAME = "windows" if IS_WINDOWS else "linux"


# ── features ────────────────────────────────────────────────────────────────
# What the QAM may offer on each host. The frontend reads this once and hides
# the controls that cannot work; the backend uses it to skip Linux-only helpers.
# Windows runs the SAME Vesktop-over-CDP core (voice, DMs, text, QR login,
# notifications, rich presence) and screen share through Electron's native
# desktop capture. What it does not have is the PipeWire/gamescope/evdev stack.
_LINUX_ONLY = (
    "audio_routing",        # per-app output/input routing (pactl / PipeWire)
    "game_audio_share",     # mix game audio into the call (virtual sinks)
    "chat_mix",             # game <-> Discord balance in the headset
    "virtual_camera",       # v4l2loopback "Share screen (game mode)"
    "gamescope_preview",    # gamescopectl/ffmpeg screenshot of the stream
    "pov_overlay",          # GTK in-game overlay / POV relay
    "keep_awake",           # SteamOS screen-saver inhibit
    "controller_shortcut",  # evdev / hidraw push-to-talk and mute combo
    "desktop_mode_options", # KWin vs gamescope switches
    "portal_shim",          # ScreenCast portal for gamescope
)
_BOTH = (
    "voice", "text_chat", "direct_messages", "qr_login", "notifications",
    "rich_presence", "screen_share", "clips", "multi_account", "soundboard",
)


def capabilities():
    """{feature: bool} for the host we are running on."""
    caps = {name: True for name in _BOTH}
    caps.update({name: IS_LINUX for name in _LINUX_ONLY})
    return caps


# ── paths ───────────────────────────────────────────────────────────────────
def config_dir():
    """Where Steamcord's small JSON settings files live.

    Linux keeps `~/.config` (the historical location - existing settings must
    keep working after an update). Windows uses the plugin settings directory
    Decky provides, so settings survive a plugin reinstall; outside Decky it
    falls back to %APPDATA%\\steamcord.
    """
    if not IS_WINDOWS:
        return os.path.expanduser("~/.config")
    base = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR")
    if not base:
        base = os.path.join(os.environ.get("APPDATA") or str(Path.home()), "steamcord")
    return base


def config_file(name):
    """Full path of a settings file. The directory is created on Windows (the
    Linux callers have always created ~/.config themselves)."""
    d = config_dir()
    if IS_WINDOWS:
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass
    return os.path.join(d, name)


def tmp_dir():
    if IS_WINDOWS:
        return (os.environ.get("DECKY_PLUGIN_RUNTIME_DIR")
                or os.path.join(tempfile.gettempdir(), "steamcord"))
    return "/tmp"


def tmp_file(name):
    d = tmp_dir()
    if IS_WINDOWS:
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass
    return os.path.join(d, name)


def downloads_dir():
    """The user's Downloads folder (Known Folder on Windows, XDG on Linux)."""
    if IS_WINDOWS:
        try:
            from ctypes import wintypes

            class _GUID(ctypes.Structure):
                _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD),
                            ("c", wintypes.WORD), ("d", ctypes.c_ubyte * 8)]

            # FOLDERID_Downloads {374DE290-123F-4565-9164-39C4925E467B}
            fid = _GUID(0x374DE290, 0x123F, 0x4565,
                        (ctypes.c_ubyte * 8)(0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B))
            out = ctypes.c_wchar_p()
            res = ctypes.windll.shell32.SHGetKnownFolderPath(
                ctypes.byref(fid), 0, None, ctypes.byref(out))
            if res == 0 and out.value:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                return path
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


def steam_root():
    """Steam's install directory, or None. Windows reads the registry; Linux
    keeps probing the usual symlinks."""
    if IS_WINDOWS:
        try:
            import winreg
            for hive, sub, val in (
                    (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
                    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
                    (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath")):
                try:
                    with winreg.OpenKey(hive, sub) as k:
                        v, _ = winreg.QueryValueEx(k, val)
                    if v and os.path.isdir(v):
                        return os.path.normpath(v)
                except OSError:
                    continue
        except ImportError:
            pass
        for guess in (r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"):
            if os.path.isdir(guess):
                return guess
        return None
    for root in ("~/.steam/steam", "~/.local/share/Steam", "~/.steam/root"):
        p = os.path.expanduser(root)
        if os.path.isdir(p):
            return p
    return None


def steam_clip_globs():
    """Glob patterns for the clips Steam exported (one per userdata account)."""
    root = steam_root()
    if IS_WINDOWS:
        if not root:
            return []
        return [os.path.join(root, "userdata", "*", "gamerecordings", "clips")]
    return [os.path.expanduser("~/.local/share/Steam/userdata/*/gamerecordings/clips")]


# ── Windows process table (no psutil, no PowerShell, no extra install) ──────
_TH32CS_SNAPPROCESS = 0x00000002


def windows_processes():
    """[(pid, parent_pid, exe_name)] from a ToolHelp32 snapshot. [] off Windows."""
    if not IS_WINDOWS:
        return []
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    k32 = ctypes.windll.kernel32
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return []
    out = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID),
                        entry.szExeFile))
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return out


def windows_exe_names(cap=400):
    """Names of the running programs (".exe" kept), newest-looking first.

    ToolHelp has no start time, but Windows hands out PIDs that grow with
    uptime only loosely; the PID is still the best cheap tie-breaker we have, and
    the client matches names against Discord's detectable-games list anyway.
    """
    skip = {"system", "system idle process", "registry", "smss.exe", "csrss.exe",
            "wininit.exe", "services.exe", "lsass.exe", "svchost.exe",
            "fontdrvhost.exe", "dwm.exe", "memory compression", "conhost.exe",
            "runtimebroker.exe", "searchhost.exe", "sihost.exe", "winlogon.exe"}
    procs = [(pid, name) for pid, _ppid, name in windows_processes()
             if name and name.lower() not in skip]
    procs.sort(key=lambda t: t[0], reverse=True)
    seen, out = set(), []
    for _pid, name in procs:
        if name not in seen:
            seen.add(name)
            out.append(name)
        if len(out) >= cap:
            break
    return out


def exe_stem(name):
    """'Vesktop.exe' -> 'vesktop' (lower-case, no extension)."""
    base = re.split(r"[\\/]", name or "")[-1]       # either separator, whatever the host
    if base.lower().endswith(".exe"):
        base = base[:-4]
    return base.lower()


def windows_pids(comm=None):
    """PIDs whose executable stem fully matches the regex `comm` (case-insensitive),
    mirroring `pgrep -x`. Our own PID is never returned."""
    if not IS_WINDOWS or not comm:
        return []
    rx = re.compile(comm, re.I)
    me = os.getpid()
    return [pid for pid, _ppid, name in windows_processes()
            if pid != me and rx.fullmatch(exe_stem(name))]
