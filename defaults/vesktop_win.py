"""Vesktop on Windows: Steamcord's own private copy.

On Linux Steamcord runs the user's flatpak or native Vesktop under a systemd
unit (vesktop.py). Windows has neither, so Steamcord keeps its own copy:

* the official portable build (Vencord/Vesktop release `Vesktop-<v>-win.zip`),
  pinned and checked against its SHA-256, unpacked into Steamcord's data folder
  under homebrew. Nothing is installed into Windows, no administrator prompt,
  and a Vesktop the user runs on the desktop is never touched;
* one data folder per Steam account (VENCORD_USER_DATA_DIR + --user-data-dir),
  so each Steam account keeps its own Discord login, as on Linux;
* "our" Vesktop is every process whose executable lives inside that private
  copy, which is exact: the user's own Vesktop lives somewhere else.

Importable on any OS (the tests do); only the calls that start or inspect
Windows processes need Windows.
"""

import hashlib
import json
import os
import ntpath
import stat
import platform
import re
import shutil
import subprocess
import tempfile
import zipfile
from asyncio import get_running_loop, sleep
from pathlib import Path

from decky import logger  # type: ignore

import host

VERSION = "1.6.8"
# Official release assets and the SHA-256 GitHub publishes for them.
BUILDS = {
    "x64": ("Vesktop-1.6.8-win.zip",
            "8ffa8d3778c287551ee0b302b3396acd2fac45931282071048bb881b67c88286"),
    "arm64": ("Vesktop-1.6.8-arm64-win.zip",
              "09a29c4872a3f92da056d85a71d91c66b9751e6dc519c734f970d79c12411a5e"),
}
RELEASE_URL = "https://github.com/Vencord/Vesktop/releases/download/v{version}/{asset}"
CDP_PORT = 9223  # same debugging port as the Linux unit
_STEAM_EPOCH = 76561197960265728

# Windows process creation flags.
_DETACHED_PROCESS = 0x00000008
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000
_SW_SHOWMINNOACTIVE = 7


def _arch():
    return "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"


def root():
    return Path(host.data_dir()) / "vesktop"


def install_dir():
    return root() / f"{VERSION}-{_arch()}"


def exe():
    return install_dir() / "Vesktop.exe"


def installed():
    # The marker is written last: a copy cut short by a crash is not "installed".
    return exe().is_file() and (install_dir() / ".steamcord-complete").is_file()


# ── installing the private copy ─────────────────────────────────────────────
def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _unpack(archive, target):
    """Extract into a sibling folder, then rename it into place (all or nothing).
    The official zip may or may not wrap everything in one top-level folder."""
    target = Path(target)
    staging = Path(tempfile.mkdtemp(prefix=".unpack-", dir=target.parent))
    try:
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                member = info.filename
                # ZIP uses '/', but Windows also interprets backslashes, drives
                # and alternate data streams. Validate on both test hosts.
                parts = member.replace("\\", "/").split("/")
                if (ntpath.splitdrive(member)[0] or member.startswith(("/", "\\"))
                        or any(p == ".." or ":" in p for p in parts)
                        or stat.S_ISLNK(info.external_attr >> 16)):
                    raise ValueError(f"unsafe path in Vesktop archive: {member}")
                resolved = (staging / member).resolve()
                if not resolved.is_relative_to(staging.resolve()):
                    raise ValueError(f"unsafe path in Vesktop archive: {member}")
            z.extractall(staging)
        top = staging
        entries = list(staging.iterdir())
        if not (staging / "Vesktop.exe").is_file() and len(entries) == 1 and entries[0].is_dir():
            top = entries[0]
        if not (top / "Vesktop.exe").is_file():
            raise ValueError("Vesktop.exe missing from the archive")
        (top / ".steamcord-complete").write_text(VERSION, encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        top.replace(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _checked_unpack(archive, target, expected):
    if _sha256(archive) != expected:
        raise ValueError("checksum mismatch for Vesktop archive")
    _unpack(archive, target)


def _remove_old_copies():
    """Older versions of OUR copy only (never the profiles, never anything else)."""
    keep = install_dir().name
    for entry in root().iterdir():
        if entry.is_dir() and entry.name != keep and re.fullmatch(r"\d+(\.\d+)+-(x64|arm64)", entry.name):
            if host.pids_under(entry):
                continue  # still running (a plugin update mid-call): next start removes it
            shutil.rmtree(entry, ignore_errors=True)


async def install():
    """Download, verify and unpack the pinned Vesktop. Never raises: the caller
    checks installed() and shows the help text if this keeps failing."""
    if installed():
        return
    from aiohttp import ClientSession  # type: ignore

    asset, expected = BUILDS[_arch()]
    url = RELEASE_URL.format(version=VERSION, asset=asset)
    root().mkdir(parents=True, exist_ok=True)
    part = root() / (asset + ".part")
    try:
        logger.info(f"[win-vesktop] downloading {asset}")
        async with ClientSession() as session:
            async with session.get(url, timeout=None) as response:
                response.raise_for_status()
                with open(part, "wb") as f:
                    async for chunk in response.content.iter_chunked(1 << 20):
                        f.write(chunk)
        loop = get_running_loop()
        await loop.run_in_executor(None, _checked_unpack, part, install_dir(), expected)
        logger.info(f"[win-vesktop] Vesktop {VERSION} ready in {install_dir()}")
        _remove_old_copies()
    except Exception as e:
        logger.warning(f"[win-vesktop] could not set up Vesktop {VERSION}: {e!r}")
    finally:
        part.unlink(missing_ok=True)


# ── one Discord login per Steam account ─────────────────────────────────────
def steam_account_id():
    """32-bit AccountID of the signed-in Steam user, or "default".

    Steam publishes the active user under HKCU\\Software\\Valve\\Steam\\ActiveProcess
    while it runs; loginusers.vdf (auto-login, then the newest session) covers
    the moment Steam has not written it yet."""
    if host.WINDOWS:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam\ActiveProcess") as k:
                active = int(winreg.QueryValueEx(k, "ActiveUser")[0])
            if active:
                return str(active)
        except (OSError, ValueError):
            pass
    steam = host.steam_dir()
    if not steam:
        return "default"
    try:
        data = (Path(steam) / "config" / "loginusers.vdf").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return "default"
    auto, newest, newest_time = None, None, -1
    for sid, block in re.findall(r'"(\d{17})"\s*\{(.*?)\}', data, re.S):
        if auto is None and re.search(r'"(?:AutoLogin|MostRecent)"\s+"1"', block):
            auto = sid
        stamp = re.search(r'"Timestamp"\s+"(\d+)"', block)
        if stamp and int(stamp.group(1)) > newest_time:
            newest_time, newest = int(stamp.group(1)), sid
    sid = auto or newest
    return str(int(sid) - _STEAM_EPOCH) if sid else "default"


def profile_dir(account):
    safe = re.sub(r"[^0-9A-Za-z_.-]", "_", account) or "default"
    path = Path(host.settings_dir()) / "vesktop-profiles" / safe
    path.mkdir(parents=True, exist_ok=True)
    vesktop = path / "vesktop"
    vesktop.mkdir(exist_ok=True)
    # Vesktop's first-run tour blocks Discord from loading. Initialise only
    # this new private profile, without importing another Vencord installation
    # or registering an application at Windows startup.
    for name, data in (("state.json", {"firstLaunch": False}),
                       ("settings.json", {"discordBranch": "stable", "minimizeToTray": True,
                                          "autoStartMinimized": True})):
        try:
            with (vesktop / name).open("x", encoding="utf-8") as f:
                json.dump(data, f)
        except FileExistsError:
            pass
    return path


def _state_file():
    return Path(host.settings_dir()) / "vesktop-profiles" / "current.json"


def running_account():
    try:
        return json.loads(_state_file().read_text(encoding="utf-8")).get("account", "")
    except (OSError, ValueError):
        return ""


def _remember_account(account):
    try:
        _state_file().parent.mkdir(parents=True, exist_ok=True)
        _state_file().write_text(json.dumps({"account": account}), encoding="utf-8")
    except OSError as e:
        logger.warning(f"[multisession] cannot record account: {e!r}")


# ── our Vesktop's processes ─────────────────────────────────────────────────
def our_pids():
    return host.pids_under(root()) if root().is_dir() else []


def is_running():
    return bool(our_pids())


def owns_cdp():
    owners = host.listening_pids(CDP_PORT)
    return bool(owners) and owners.issubset(set(our_pids()))


async def stop(tag):
    """Stop every process of our copy. True once none is left."""
    loop = get_running_loop()
    for pid in our_pids():
        await loop.run_in_executor(None, host.kill_tree, pid)
    for _ in range(10):
        if not is_running():
            return True
        await sleep(1)
    logger.warning(f"{tag} Vesktop is still running after taskkill")
    return False


def _command(account):
    profile = profile_dir(account)
    return [
        str(exe()),
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        # Chromium's own profile, and with it the single-instance lock: without
        # it, a Vesktop the user already runs would swallow our launch.
        f"--user-data-dir={profile / 'chromium'}",
        # Keep Discord's timers (gateway heartbeat) running while minimised.
        "--disable-background-timer-throttling",
        "--start-minimized",
    ], profile


def _environment(profile):
    env = dict(os.environ)
    # Variables Decky's embedded Python sets for itself; an Electron child must not inherit them.
    for name in ("ELECTRON_RUN_AS_NODE", "PYTHONHOME", "PYTHONPATH", "PYTHONSAFEPATH",
                 "PYTHONNOUSERSITE", "PYTHONUTF8"):
        env.pop(name, None)
    # Vesktop keeps the Discord session, Vencord settings and themes here.
    env["VENCORD_USER_DATA_DIR"] = str(profile / "vesktop")
    return env


def _spawn(command, env):
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = _SW_SHOWMINNOACTIVE  # minimised, never takes focus from Big Picture
    options = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env=env, startupinfo=startup, close_fds=True)
    flags = _DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP
    try:
        # Outlive a reload of the plugin, like the systemd unit does on Linux.
        return subprocess.Popen(command, creationflags=flags | _CREATE_BREAKAWAY_FROM_JOB, **options)
    except OSError:
        return subprocess.Popen(command, creationflags=flags, **options)


async def launch(is_up):
    """Start our Vesktop for the signed-in Steam account; True once CDP answers.
    `is_up` is vesktop.is_up, passed in to avoid an import cycle."""
    if not installed():
        logger.warning("[win-vesktop] Vesktop is not set up")
        return False
    account = steam_account_id()
    if is_running():
        if running_account() == account:
            for _ in range(15):
                if owns_cdp() and await is_up():
                    return True
                await sleep(1)
            logger.info("[recover] our Vesktop runs but its debugging port stays closed: restarting it")
        else:
            logger.info(f"[multisession] Steam account changed ({running_account() or '?'} → {account}): "
                        "switching Discord profile")
        await stop("[win-vesktop]")
    if await is_up():
        logger.warning(f"[win-vesktop] port {CDP_PORT} is already used by another program")
        return False
    command, profile = _command(account)
    _remember_account(account)
    logger.info(f"[win-vesktop] starting Vesktop {VERSION} for Steam account {account}")
    try:
        process = await get_running_loop().run_in_executor(None, _spawn, command, _environment(profile))
    except OSError as e:
        logger.warning(f"[win-vesktop] cannot start Vesktop: {e!r}")
        return False
    for second in range(60):
        if owns_cdp() and await is_up():
            logger.info(f"[launchdiag] Vesktop CDP {CDP_PORT} up after ~{second}s")
            return True
        if process.poll() is not None and not is_running():
            logger.warning(f"[launchdiag] Vesktop exited ({process.returncode}) before CDP opened")
            return False
        await sleep(1)
    logger.warning(f"[launchdiag] Vesktop started but CDP {CDP_PORT} never opened after 60s")
    return False
