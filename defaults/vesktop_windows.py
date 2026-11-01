"""Windows backend of the Vesktop manager (the Linux one lives in vesktop.py).

Same idea as on Linux - run a real Vesktop invisibly, drive it over the Chrome
DevTools Protocol, inject our client - with the Windows way of doing each step:

* Vesktop comes from winget (`Vencord.Vesktop`) or the official GitHub installer,
  installed per-user and silently, so no administrator prompt is needed;
* it is started as a detached, minimised process with its own profile directory
  per Steam account (`--user-data-dir`), so a Vesktop the user already runs on
  the desktop is never touched, killed or logged out;
* the instance we own is found again after a plugin reload by the process that
  listens on the debugging port (plus a pid file), then stopped with `taskkill`.

Nothing here imports Linux-only modules, and the module is safe to import on any
OS (the tests do exactly that); only the functions that need Windows APIs check.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from asyncio import get_running_loop, sleep
from pathlib import Path

from decky import logger  # type: ignore

import sc_platform as plat

CDP_PORT = 9223
WINGET_ID = "Vencord.Vesktop"
RELEASES_API = "https://api.github.com/repos/Vencord/Vesktop/releases/latest"

_STEAM_EPOCH = 76561197960265728
_CREATE_NO_WINDOW = 0x08000000
_DETACHED_PROCESS = 0x00000008
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000
_SW_SHOWMINNOACTIVE = 7


# ── finding Vesktop ─────────────────────────────────────────────────────────
def _override_exe():
    """Escape hatch: STEAMCORD_VESKTOP_EXE, or a one-line text file next to the
    other Steamcord settings, naming a Vesktop.exe in an unusual place (portable
    copy, custom install directory)."""
    cand = os.environ.get("STEAMCORD_VESKTOP_EXE", "").strip().strip('"')
    if not cand:
        try:
            cand = Path(plat.config_file("steamcord-vesktop-path.txt")).read_text(
                encoding="utf-8").strip().strip('"')
        except OSError:
            cand = ""
    return cand if cand and os.path.isfile(cand) else None


def _registry_exe():
    """Vesktop's uninstall entry (per-user or machine-wide) names its folder."""
    if not plat.IS_WINDOWS:
        return None
    try:
        import winreg
    except ImportError:
        return None
    base = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    views = (0, getattr(winreg, "KEY_WOW64_64KEY", 0), getattr(winreg, "KEY_WOW64_32KEY", 0))
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in views:
            try:
                root = winreg.OpenKey(hive, base, 0, winreg.KEY_READ | view)
            except OSError:
                continue
            with root:
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(root, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(root, sub) as k:
                            name = winreg.QueryValueEx(k, "DisplayName")[0]
                            if not str(name).lower().startswith("vesktop"):
                                continue
                            for val in ("InstallLocation", "DisplayIcon"):
                                try:
                                    raw = str(winreg.QueryValueEx(k, val)[0]).strip().strip('"')
                                except OSError:
                                    continue
                                raw = raw.split(",")[0].strip().strip('"')
                                for exe in ((raw,) if raw.lower().endswith(".exe") else
                                            (os.path.join(raw, "Vesktop.exe"),
                                             os.path.join(raw, "vesktop.exe"))):
                                    if os.path.isfile(exe):
                                        return exe
                    except OSError:
                        continue
    return None


def _candidate_exes():
    roots = []
    for var in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        v = os.environ.get(var)
        if v:
            roots.append(v)
            if var == "LOCALAPPDATA":
                roots.append(os.path.join(v, "Programs"))
    for root in roots:
        for folder in ("Vesktop", "vesktop"):
            for exe in ("Vesktop.exe", "vesktop.exe"):
                yield os.path.join(root, folder, exe)


def find_exe():
    """Path of Vesktop.exe, or None. Cheap enough to call on every poll."""
    exe = _override_exe()
    if exe:
        return exe
    exe = _registry_exe()
    if exe:
        return exe
    for cand in _candidate_exes():
        if os.path.isfile(cand):
            return cand
    return shutil.which("vesktop")


def backend():
    """Always "windows": a missing Vesktop is installed on first run. The caller
    turns repeated install failures into the "install Vesktop" help screen."""
    return "windows"


def installed():
    return find_exe() is not None


# ── installing Vesktop ──────────────────────────────────────────────────────
def _run_hidden(cmd, timeout):
    flags = _CREATE_NO_WINDOW if plat.IS_WINDOWS else 0
    return subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=timeout,
                          creationflags=flags)


async def _in_thread(fn, *args):
    return await get_running_loop().run_in_executor(None, lambda: fn(*args))


async def _install_with_winget():
    winget = shutil.which("winget")
    if not winget:
        return False
    try:
        res = await _in_thread(
            _run_hidden,
            [winget, "install", "--id", WINGET_ID, "-e", "--silent",
             "--accept-package-agreements", "--accept-source-agreements"], 600)
    except Exception as e:
        logger.warning(f"[win-install] winget failed to run: {e!r}")
        return False
    tail = (res.stdout or b"").decode("utf-8", "replace").strip().splitlines()[-3:]
    logger.info(f"[win-install] winget exit {res.returncode}: {' | '.join(tail)[:300]}")
    return installed()


async def _install_from_github():
    """Official installer, run silently (NSIS `/S`, per-user)."""
    from aiohttp import ClientSession  # type: ignore
    async with ClientSession() as s:
        async with s.get(RELEASES_API, timeout=20,
                         headers={"Accept": "application/vnd.github+json"}) as r:
            r.raise_for_status()
            rel = await r.json()
        assets = [a for a in rel.get("assets", [])
                  if re.search(r"setup.*\.exe$", a.get("name", ""), re.I)]
        if not assets:
            logger.warning("[win-install] no Windows installer in the latest Vesktop release")
            return False
        url = assets[0]["browser_download_url"]
        dest_dir = tempfile.mkdtemp(prefix="steamcord-vesktop-")
        dest = os.path.join(dest_dir, assets[0]["name"])
        logger.info(f"[win-install] downloading {assets[0]['name']}")
        async with s.get(url, timeout=600) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in r.content.iter_chunked(1 << 16):
                    f.write(chunk)
    try:
        res = await _in_thread(_run_hidden, [dest, "/S"], 600)
        logger.info(f"[win-install] installer exit {res.returncode}")
    finally:
        shutil.rmtree(dest_dir, ignore_errors=True)
    # the NSIS installer returns before the files are fully in place
    for _ in range(30):
        if installed():
            return True
        await sleep(1)
    return False


async def install():
    """Install Vesktop for the current user. Never raises: the caller re-checks
    `installed()` and counts failures."""
    if installed():
        return
    for attempt in (_install_with_winget, _install_from_github):
        try:
            if await attempt():
                return
        except Exception as e:
            logger.warning(f"[win-install] {attempt.__name__}: {e!r}")
    logger.warning("[win-install] Vesktop could not be installed automatically - install it "
                   "from https://vesktop.dev or run: winget install Vencord.Vesktop")


# ── Steam account → Discord profile ─────────────────────────────────────────
def steam_account_id():
    """32-bit AccountID (string) of the Steam user that is signed in, else "default".

    Registry first (Steam publishes the active user there while it runs), then
    loginusers.vdf - most recent / auto-login - the same fallbacks as Linux."""
    if plat.IS_WINDOWS:
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Valve\Steam\ActiveProcess") as k:
                v = int(winreg.QueryValueEx(k, "ActiveUser")[0])
            if v:
                return str(v)
        except (OSError, ValueError, ImportError):
            pass
    root = plat.steam_root()
    if root:
        try:
            data = Path(root, "config", "loginusers.vdf").read_text(errors="ignore", encoding="utf-8")
        except OSError:
            data = ""
        by_flag = by_time = None
        newest = -1
        for m in re.finditer(r'"(\d{17})"\s*\{(.*?)\}', data, re.S):
            sid, block = m.groups()
            if by_flag is None and (re.search(r'"MostRecent"\s+"1"', block)
                                    or re.search(r'"AutoLogin"\s+"1"', block)):
                by_flag = sid
            ts = re.search(r'"Timestamp"\s+"(\d+)"', block)
            if ts and int(ts.group(1)) > newest:
                newest, by_time = int(ts.group(1)), sid
        for sid in (by_flag, by_time):
            if sid:
                return str(int(sid) - _STEAM_EPOCH)
    return "default"


def profiles_dir():
    return Path(plat.config_dir()) / "vesktop-profiles"


def _current_file():
    return profiles_dir() / "current.json"


def recorded_account():
    try:
        return json.loads(_current_file().read_text(encoding="utf-8")).get("account", "")
    except Exception:
        return ""


def record_account(account):
    try:
        profiles_dir().mkdir(parents=True, exist_ok=True)
        _current_file().write_text(json.dumps({"account": account}), encoding="utf-8")
    except OSError as e:
        logger.warning(f"[multisession] cannot record account: {e!r}")


def ensure_profile(account):
    """Profile directories of a Steam account: {'root','electron','vencord'}.

    A separate directory per account is what keeps Discord logins apart (the
    Windows equivalent of the symlink swap the Linux build does)."""
    safe = re.sub(r"[^0-9A-Za-z_.-]", "_", str(account)) or "default"
    root = profiles_dir() / safe
    out = {"root": root, "electron": root / "electron", "vencord": root / "vencord"}
    for p in out.values():
        p.mkdir(parents=True, exist_ok=True)
    return out


# ── process control ─────────────────────────────────────────────────────────
def _pidfile():
    return plat.tmp_file("steamcord-vesktop.pid")


def _read_pidfile():
    try:
        return int(Path(_pidfile()).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0


def _write_pidfile(pid):
    try:
        Path(_pidfile()).write_text(str(pid), encoding="utf-8")
    except OSError:
        pass


def _clear_pidfile():
    try:
        os.unlink(_pidfile())
    except OSError:
        pass


def _is_vesktop_pid(pid):
    if not pid:
        return False
    for p, _pp, name in plat.windows_processes():
        if p == pid:
            return plat.exe_stem(name) == "vesktop"
    return False


def pid_listening(port=CDP_PORT):
    """PID that listens on 127.0.0.1:<port>, from `netstat -ano` - present on
    every Windows. 0 when nobody does."""
    try:
        out = _run_hidden(["netstat", "-ano", "-p", "tcp"], 10).stdout.decode("utf-8", "replace")
    except Exception:
        return 0
    rx = re.compile(rf"^\s*TCP\s+\S+:{port}\s+\S+\s+LISTENING\s+(\d+)\s*$", re.I | re.M)
    m = rx.search(out)
    return int(m.group(1)) if m else 0


def main_pids():
    """PIDs of the Vesktop instance WE run: the one on our debugging port, plus
    the one in our pid file. A Vesktop the user opened by hand has neither."""
    pids = []
    listening = pid_listening()
    if listening and _is_vesktop_pid(listening):
        pids.append(listening)
    pf = _read_pidfile()
    if pf and pf not in pids and _is_vesktop_pid(pf):
        pids.append(pf)
    return pids


def is_running():
    return bool(main_pids())


def _taskkill(pid):
    return _run_hidden(["taskkill", "/PID", str(pid), "/T", "/F"], 20)


async def kill(tag="[recover]"):
    """Stop our Vesktop (whole process tree). True when it is gone."""
    pids = main_pids()
    if not pids:
        _clear_pidfile()
        return True
    for pid in pids:
        try:
            await _in_thread(_taskkill, pid)
        except Exception as e:
            logger.warning(f"{tag} taskkill {pid}: {e!r}")
    for _ in range(10):
        await sleep(1)
        if not is_running():
            _clear_pidfile()
            return True
    return False


def launch_args(profile):
    """Command-line flags for our Vesktop. Windows-specific differences from the
    Linux unit: no ozone/VAAPI workarounds, a per-account user-data-dir."""
    return [
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile['electron']}",
        # keeps the JS timers - and so Discord's gateway heartbeat - running
        # while the window is minimised
        "--disable-background-timer-throttling",
        "--start-minimized",
    ]


def launch_env(profile):
    env = dict(os.environ)
    # Decky's own Python sets these for itself; an Electron child must not see them.
    for var in ("ELECTRON_RUN_AS_NODE", "PYTHONHOME", "PYTHONPATH", "PYTHONSAFEPATH",
                "PYTHONNOUSERSITE", "PYTHONUTF8"):
        env.pop(var, None)
    # Vencord's own settings/quick-CSS directory follows the same profile.
    env["VENCORD_USER_DATA_DIR"] = str(profile["vencord"])
    return env


def _spawn(cmd, env):
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                  stderr=subprocess.DEVNULL, close_fds=True, env=env)
    if plat.IS_WINDOWS:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = _SW_SHOWMINNOACTIVE      # minimised, never steals focus
        kwargs["startupinfo"] = si
        base = _DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP
        try:
            # Outlive a Decky/plugin restart, like the systemd unit does on Linux.
            return subprocess.Popen(cmd, creationflags=base | _CREATE_BREAKAWAY_FROM_JOB, **kwargs)
        except OSError:
            # The job object does not allow breakaway: start without it.
            return subprocess.Popen(cmd, creationflags=base, **kwargs)
    return subprocess.Popen(cmd, **kwargs)


async def launch(is_up):
    """Start Vesktop with the debugging port open. `is_up` is vesktop.is_up
    (passed in to avoid an import cycle). True once the port answers."""
    exe = find_exe()
    if not exe:
        logger.warning("[win] Vesktop.exe not found - install it (winget install Vencord.Vesktop)")
        return False
    account = steam_account_id()
    if is_running():
        if recorded_account() == account and await is_up():
            return True
        if recorded_account() != account:
            logger.info(f"[multisession] Steam account changed "
                        f"({recorded_account() or '?'} → {account}) - switching Discord profile")
            await kill("[multisession]")
        else:
            # ours, but the port never opened (hung): wait a little, then relaunch
            for _ in range(15):
                if await is_up():
                    return True
                await sleep(1)
            await kill("[recover]")
    elif await is_up():
        # Something answers on the port that is not (any longer) ours to manage.
        return True
    profile = ensure_profile(account)
    record_account(account)
    cmd = [exe] + launch_args(profile)
    logger.info(f"[win] starting Vesktop for Steam account {account}: {exe}")
    try:
        proc = await _in_thread(_spawn, cmd, launch_env(profile))
    except OSError as e:
        logger.warning(f"[win] cannot start Vesktop: {e!r}")
        return False
    _write_pidfile(proc.pid)
    for i in range(60):
        if await is_up():
            logger.info(f"[launchdiag] Vesktop CDP {CDP_PORT} up after ~{i}s")
            return True
        if proc.poll() is not None and not is_running():
            # Electron is single-instance per profile: a second launch hands over
            # to the first and exits. Keep waiting only if the port is alive.
            if not await is_up():
                logger.warning(f"[launchdiag] Vesktop exited with code {proc.returncode} "
                               "before the debugging port opened")
                return False
        await sleep(1)
    logger.warning(f"[launchdiag] Vesktop started but CDP {CDP_PORT} never opened after 60s")
    return False
