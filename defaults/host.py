"""Which machine Steamcord runs on, and what differs there.

One plugin zip serves two hosts: Linux in Steam Gaming Mode (SteamOS, Bazzite,
CachyOS...) and Windows in Steam Big Picture, with the official Decky Loader
Windows build (the one Playhub installs). Everything host-specific that is not
Vesktop itself (see vesktop_win.py) is answered here.

Named `host` rather than `platform`: a platform.py next to main.py would shadow
the standard library module.

The host is `sys.platform`. Decky's Windows build stubs or fakes several POSIX
calls (uid, chown, chmod), so they say nothing about where we are.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

WINDOWS = sys.platform == "win32"
NAME = "windows" if WINDOWS else "linux"

# Vesktop's local debugging (CDP) port, shared by vesktop.py, vesktop_win.py
# and main.py. Kept away from 9222-9224, which other Decky plugins use for their
# own Chromium/Edge windows (Unifideck's Microsoft sign-in, #95), and from the
# proxy bridge ports (39021-39025, see discord_client/netproxy.py).
CDP_PORT = 39223

# Features that only exist on Linux: they sit on PipeWire, gamescope, KWin,
# v4l2loopback, evdev or the SteamOS session. Everything else (voice, chat,
# DMs, QR login, notifications, Rich Presence, Go Live video, clips, one
# Discord per Steam account, soundboard) shares the same code paths. The frontend
# mirrors this list in src/host.tsx. Share snapshots work on both hosts.
LINUX_ONLY = (
    "audio_routing",        # output/input pickers and the Discord voice sink
    "game_audio_share",     # game audio mixed into the call
    "chat_mix",             # game / Discord balance
    "virtual_camera",       # "Share screen (game mode)" through v4l2loopback
    "overlay",              # GTK in-game voice / POV overlay
    "keep_awake",           # SteamOS screen-saver inhibit
    "controller_shortcut",  # push-to-talk / mute combo read from evdev / hidraw
    "desktop_mode",         # Desktop Mode (KWin) options
)


def features():
    """{feature: available} for this host. Unknown names count as available."""
    return {**{name: not WINDOWS for name in LINUX_ONLY}, "stream_preview": True}


# CREATE_NO_WINDOW: a console program started from Decky (taskkill, ffmpeg)
# would otherwise flash a console window over Big Picture.
NO_WINDOW = 0x08000000 if WINDOWS else 0


def run_quiet(cmd, timeout):
    """Run a helper program without a console window; returns CompletedProcess."""
    return subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=timeout, creationflags=NO_WINDOW)


# ── where things live ───────────────────────────────────────────────────────
def settings_dir():
    """Steamcord's small JSON settings files.

    Linux keeps ~/.config, where every existing install already has them.
    Windows uses the settings folder Decky gives the plugin, which survives a
    reinstall of the plugin."""
    if not WINDOWS:
        return os.path.expanduser("~/.config")
    path = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR") or os.path.join(
        os.environ.get("APPDATA") or str(Path.home()), "Steamcord")
    os.makedirs(path, exist_ok=True)
    return path


def settings_file(name):
    return os.path.join(settings_dir(), name)


def data_dir():
    """Large files Steamcord downloads for itself (the Windows Vesktop copy)."""
    if not WINDOWS:
        return os.path.expanduser("~/.local/share/steamcord")
    path = os.environ.get("DECKY_PLUGIN_RUNTIME_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or str(Path.home()), "Steamcord")
    os.makedirs(path, exist_ok=True)
    return path


def _registry_value(hive_name, key, name):
    """One registry value as a string, or None (always None off Windows)."""
    if not WINDOWS:
        return None
    import winreg
    try:
        with winreg.OpenKey(getattr(winreg, hive_name), key) as k:
            value, _ = winreg.QueryValueEx(k, name)
    except OSError:
        return None
    return str(value) if value not in (None, "") else None


def downloads_dir():
    """The user's Downloads folder (moved Downloads folders included on Windows)."""
    if WINDOWS:
        value = _registry_value(
            "HKEY_CURRENT_USER",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            "{374DE290-123F-4565-9164-39C4925E467B}")
        if value:
            path = os.path.expandvars(value)
            if os.path.isdir(path):
                return path
    return os.path.join(os.path.expanduser("~"), "Downloads")


def steam_dir():
    """Steam's folder on Windows (from Steam's own registry key), else None."""
    value = _registry_value("HKEY_CURRENT_USER", r"Software\Valve\Steam", "SteamPath")
    if value and os.path.isdir(value):
        return os.path.normpath(value)
    return None


def steam_clip_dirs():
    """Glob patterns of the folders where Steam keeps exported clips."""
    if not WINDOWS:
        return [os.path.expanduser("~/.local/share/Steam/userdata/*/gamerecordings/clips")]
    root = steam_dir()
    return [os.path.join(root, "userdata", "*", "gamerecordings", "clips")] if root else []


# ── Windows processes ───────────────────────────────────────────────────────
def processes():
    """[(pid, full path of its executable)] for every process we may query.

    psapi's EnumProcesses plus QueryFullProcessImageNameW: no psutil, no
    PowerShell, no console window, and the full path tells our private Vesktop
    apart from one the user runs. Processes we may not open are skipped.
    Empty off Windows."""
    if not WINDOWS:
        return []
    import ctypes
    from ctypes import wintypes

    psapi = ctypes.WinDLL("psapi")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    size = 4096
    while True:
        pids = (wintypes.DWORD * size)()
        returned = wintypes.DWORD()
        if not psapi.EnumProcesses(pids, ctypes.sizeof(pids), ctypes.byref(returned)):
            return []
        count = returned.value // ctypes.sizeof(wintypes.DWORD)
        if count < size:
            break
        size *= 2

    query_limited_information = 0x1000
    out = []
    buffer = ctypes.create_unicode_buffer(32768)
    for pid in pids[:count]:
        if not pid:
            continue
        handle = kernel32.OpenProcess(query_limited_information, False, pid)
        if not handle:
            continue
        try:
            length = wintypes.DWORD(len(buffer))
            if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
                out.append((int(pid), buffer.value))
        finally:
            kernel32.CloseHandle(handle)
    return out


def exe_name(path):
    """'C:\\Games\\Foo\\Foo.exe' -> 'foo' (either separator, any host)."""
    base = re.split(r"[\\/]", path or "")[-1]
    return base[:-4].lower() if base.lower().endswith(".exe") else base.lower()


def pids_named(pattern):
    """PIDs whose executable name (no .exe) fully matches `pattern`, like `pgrep -x`."""
    rx = re.compile(pattern, re.I)
    me = os.getpid()
    return [pid for pid, path in processes() if pid != me and rx.fullmatch(exe_name(path))]


def pids_under(folder):
    """PIDs whose executable lives inside `folder`."""
    prefix = os.path.normcase(os.path.abspath(folder)).rstrip("\\/") + os.sep
    return [pid for pid, path in processes() if os.path.normcase(path).startswith(prefix)]


# Windows' own processes: never a game, so never sent to Discord's Rich Presence.
_SYSTEM_EXES = {
    "system", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass",
    "svchost", "fontdrvhost", "dwm", "conhost", "runtimebroker", "sihost", "searchhost",
    "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "ctfmon", "taskhostw",
    "explorer", "dllhost", "audiodg", "spoolsv", "msmpeng", "securityhealthservice",
}


def running_programs(limit=400):
    """Executable names of running programs ("Game.exe"), newest PIDs first,
    for matching against Discord's detectable games."""
    seen, out = set(), []
    windows_dir = os.path.normcase(os.environ.get("SystemRoot") or r"C:\Windows")
    for _pid, path in sorted(processes(), reverse=True):
        if os.path.normcase(path).startswith(windows_dir) or exe_name(path) in _SYSTEM_EXES:
            continue
        name = re.split(r"[\\/]", path)[-1]
        if name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
            if len(out) >= limit:
                break
    return out


def kill_tree(pid):
    """Stop a process and its children (taskkill /T /F). True if taskkill succeeded."""
    if not WINDOWS:
        return False
    return run_quiet(["taskkill", "/PID", str(pid), "/T", "/F"], 20).returncode == 0


def _linux_listening_pids(port, proc=Path("/proc")):
    """Linux: sockets listening on 127.0.0.1/0.0.0.0:`port` in /proc/net/tcp,
    then the processes holding them. Processes we may not inspect are skipped,
    so an empty result means "owner unknown", not "nobody"."""
    inodes = set()
    try:
        for line in (proc / "net/tcp").read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":  # LISTEN
                continue
            addr, _, hex_port = fields[1].partition(":")
            if int(hex_port, 16) == port and addr in ("0100007F", "00000000"):
                inodes.add(fields[9])
    except (OSError, ValueError):
        return set()
    inodes.discard("0")
    if not inodes:
        return set()
    wanted = {f"socket:[{inode}]" for inode in inodes}
    owners = set()
    try:
        entries = [p for p in proc.iterdir() if p.name.isdigit()]
    except OSError:
        return set()
    for entry in entries:
        try:
            for fd in (entry / "fd").iterdir():
                try:
                    if os.readlink(fd) in wanted:
                        owners.add(int(entry.name))
                        break
                except OSError:
                    continue
        except OSError:
            continue
    return owners


def listening_pids(port):
    """Owners of IPv4 TCP listeners, used to prove the local CDP endpoint is ours.

    Native API only: no shell, netstat parsing or PID files. The CDP URL uses
    127.0.0.1, so IPv6-only listeners cannot be the endpoint being contacted.
    An unavailable table returns no owner: never attach to an unproven process.
    """
    if not WINDOWS:
        return _linux_listening_pids(port)
    import ctypes
    import socket
    from ctypes import wintypes

    class Row(ctypes.Structure):
        _fields_ = [(name, wintypes.DWORD) for name in (
            'state', 'local_addr', 'local_port', 'remote_addr', 'remote_port', 'pid')]

    api = ctypes.WinDLL('iphlpapi').GetExtendedTcpTable
    api.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL,
                    wintypes.ULONG, ctypes.c_int, wintypes.ULONG]
    api.restype = wintypes.DWORD
    size = wintypes.DWORD()
    for _ in range(4):
        buffer = ctypes.create_string_buffer(max(size.value, 4))
        result = api(buffer, ctypes.byref(size), False, 2, 3, 0)
        if result == 122:  # ERROR_INSUFFICIENT_BUFFER: table changed or first probe
            continue
        if result != 0:
            return set()
        count = wintypes.DWORD.from_buffer_copy(buffer.raw[:4]).value
        if 4 + count * ctypes.sizeof(Row) > len(buffer):
            return set()
        rows = (Row * count).from_buffer_copy(buffer.raw[4:4 + count * ctypes.sizeof(Row)])
        return {int(row.pid) for row in rows if socket.ntohs(row.local_port & 0xffff) == port
                and socket.ntohl(row.local_addr) in (0, 0x7f000001)}
    return set()
