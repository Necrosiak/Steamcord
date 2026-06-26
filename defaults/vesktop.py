"""Vesktop (native Discord) manager: launch it headless with remote debugging,
connect via CDP, get past the first-launch screen, and inject our client. Used
instead of the Steam CEF BrowserView so the microphone works natively."""

import os
from asyncio import sleep, create_subprocess_exec
from subprocess import DEVNULL, PIPE
from pathlib import Path
from aiohttp import ClientSession  # type: ignore

from tab_utils.cdp import Tab

VESKTOP_CDP = "http://127.0.0.1:9223"
VESKTOP_APP = "dev.vencord.Vesktop"


def _user_env():
    """Env needed to reach the user systemd manager (`systemctl --user`).
    The plugin backend is spawned by the SYSTEM (root) plugin_loader service and
    INHERITS root's XDG_RUNTIME_DIR=/run/user/0 + DBUS pointing at the root bus,
    even after dropping to uid 1000. Trusting those (os.environ.get) makes every
    `systemctl --user` hit the wrong/forbidden bus → DISPLAY/XAUTHORITY come back
    empty → Vesktop launches with no graphical env → 9223 never opens. So ALWAYS
    derive both from our real uid; the plugin always runs as the target user."""
    uid = os.getuid()
    rt = f"/run/user/{uid}"
    dbus = f"unix:path={rt}/bus"
    env = {**os.environ, "XDG_RUNTIME_DIR": rt, "DBUS_SESSION_BUS_ADDRESS": dbus}
    # plugin_loader is a PyInstaller binary: it points LD_LIBRARY_PATH at its bundled
    # libs (an old libcrypto.so.3). Children inherit it, so system binaries (systemd-run,
    # systemctl, flatpak) load the wrong libcrypto and abort ("OPENSSL_3.4.0 not found").
    # Restore PyInstaller's saved original (or drop it) so they use the system libs.
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig is not None:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    env.pop("LD_PRELOAD", None)
    return env


async def _cdp_json(path):
    async with ClientSession() as s:
        async with s.get(VESKTOP_CDP + path, timeout=3) as r:
            return await r.json()


async def is_up():
    try:
        await _cdp_json("/json/version")
        return True
    except Exception:
        return False


async def _running():
    """True if a Vesktop process exists, regardless of the debug port."""
    try:
        proc = await create_subprocess_exec("pgrep", "-f", "vesktop.bin", stdout=DEVNULL, stderr=DEVNULL)
        return (await proc.wait()) == 0
    except Exception:
        return False


async def installed():
    try:
        proc = await create_subprocess_exec("flatpak", "info", VESKTOP_APP, stdout=DEVNULL, stderr=DEVNULL, env=_user_env())
        return (await proc.wait()) == 0
    except Exception:
        return False


async def install():
    # Silent USER-level install — no polkit/root prompt, so it can run unattended when
    # the plugin first loads. Ensure a user flathub remote exists first.
    r = await create_subprocess_exec(
        "flatpak", "remote-add", "--user", "--if-not-exists", "flathub",
        "https://flathub.org/repo/flathub.flatpakrepo",
        stdout=DEVNULL, stderr=DEVNULL, env=_user_env(),
    )
    await r.wait()
    proc = await create_subprocess_exec(
        "flatpak", "install", "--user", "-y", "--noninteractive", "flathub", VESKTOP_APP,
        stdout=DEVNULL, stderr=DEVNULL, env=_user_env(),
    )
    await proc.wait()


VESKTOP_UNIT = "streamcord-vesktop"


async def _show_env():
    """Graphical env the user session manager has imported (DISPLAY, XAUTHORITY...).
    May be empty very early at boot, before the compositor exports it."""
    try:
        proc = await create_subprocess_exec(
            "systemctl", "--user", "show-environment",
            stdout=PIPE, stderr=DEVNULL, env=_user_env(),
        )
        out, _ = await proc.communicate()
        env = {}
        for line in out.decode().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
        return env
    except Exception:
        return {}


async def _unit_active(unit):
    try:
        proc = await create_subprocess_exec(
            "systemctl", "--user", "is-active", "--quiet", unit,
            stdout=DEVNULL, stderr=DEVNULL, env=_user_env(),
        )
        return (await proc.wait()) == 0
    except Exception:
        return False


async def _wait_for_display(runtime_dir, timeout=120):
    """Block until the host wayland socket exists. Booting straight into gamemode,
    the plugin loads before the compositor creates wayland-0; launching Vesktop
    before then gives Electron no display so it never opens the CDP debug port —
    that was the infinite 'initialize() failed ... 9223 ConnectionRefused' loop."""
    sock = Path(runtime_dir) / "wayland-0"
    for _ in range(timeout):
        if sock.exists():
            return True
        await sleep(1)
    return sock.exists()


async def launch():
    # Always derive from our real uid — never trust inherited XDG_RUNTIME_DIR/DBUS,
    # which point at root's bus when spawned by the system service (see _user_env).
    runtime_dir = f"/run/user/{os.getuid()}"

    # Don't launch until the host display actually exists (see _wait_for_display).
    await _wait_for_display(runtime_dir)

    # The plugin backend is spawned by the SYSTEM plugin_loader service, so it does NOT
    # inherit the user's graphical session env. `systemd-run --user` runs the transient
    # unit under the user MANAGER, which inherits what the manager imported — but at a
    # cold gamemode boot that import is empty/late, so Vesktop launched without DISPLAY/
    # WAYLAND_DISPLAY never renders and 9223 never opens. Fix: read the session env and
    # pass it to the unit EXPLICITLY via --setenv (env= on this call only affects the
    # systemd-run client, not the resulting unit). Target the host wayland-0 (what worked
    # in Big Picture) rather than gamescope's nested socket.
    session_env = await _show_env()
    display = session_env.get("DISPLAY", ":0")
    xauth = session_env.get("XAUTHORITY", "")
    dbus = session_env.get("DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime_dir}/bus")
    # systemd-run client only needs to reach the user manager:
    env = _user_env()

    # If OUR debug unit is already coming up, never kill it — just wait for the port.
    # Only a FOREIGN (non-debug) Vesktop needs killing: Electron is single-instance, so a
    # second `flatpak run` would only wake it and drop our flags. Blindly killing on every
    # retry is what previously prevented the loop from ever recovering on its own.
    if await _unit_active(VESKTOP_UNIT):
        for _ in range(60):
            if await is_up():
                return True
            await sleep(1)
        # Our unit is up but the port never opened (hung instance) — clear it and relaunch.
        try:
            st = await create_subprocess_exec(
                "systemctl", "--user", "stop", VESKTOP_UNIT,
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            await st.wait()
        except Exception:
            pass
    elif await _running():
        try:
            killer = await create_subprocess_exec(
                "flatpak", "kill", VESKTOP_APP, stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            await killer.wait()
            for _ in range(10):
                await sleep(1)
                if not await _running():
                    break
        except Exception:
            pass

    # Clear any leftover transient unit so we can reuse the fixed name.
    try:
        rf = await create_subprocess_exec(
            "systemctl", "--user", "reset-failed", VESKTOP_UNIT,
            stdout=DEVNULL, stderr=DEVNULL, env=env,
        )
        await rf.wait()
    except Exception:
        pass

    setenv = [
        "--setenv=WAYLAND_DISPLAY=wayland-0",
        f"--setenv=DISPLAY={display}",
        f"--setenv=XDG_RUNTIME_DIR={runtime_dir}",
        f"--setenv=DBUS_SESSION_BUS_ADDRESS={dbus}",
    ]
    if xauth:
        setenv.append(f"--setenv=XAUTHORITY={xauth}")

    await create_subprocess_exec(
        "systemd-run", "--user", "--collect", f"--unit={VESKTOP_UNIT}",
        *setenv,
        "flatpak", "run", VESKTOP_APP,
        "--remote-debugging-port=9223",
        "--remote-allow-origins=*",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        # Login token persists, so we no longer need the window visible for the QR —
        # start it minimized so it runs invisibly in the background.
        "--start-minimized",
        stdout=DEVNULL, stderr=DEVNULL, env=env,
    )
    for _ in range(60):
        if await is_up():
            return True
        await sleep(1)
    return False


async def _get_page():
    """Return the CDP target dict for Vesktop's main page (Discord or first-launch)."""
    tabs = await _cdp_json("/json")
    return next((t for t in tabs if t.get("type") == "page"), None)


async def get_discord_tab(client_js) -> Tab:
    """Ensure Vesktop is running and logged-into-able, inject our client, return the Tab."""
    if not await is_up():
        if not await installed():
            await install()
        await launch()

    # Wait for a page target and get past the first-launch setup screen
    while True:
        page = await _get_page()
        if page:
            tab = Tab(page)
            await tab.open_websocket()
            await tab.enable()
            url = page.get("url", "")
            if "first-launch" in url:
                # Accept defaults and proceed to Discord
                await tab.evaluate("(()=>{const b=document.getElementById('submit');if(b)b.click();})()")
                await tab.close_websocket()
                await sleep(4)
                continue
            # Inject our client (Vesktop already ships Vencord — no Vencord fetch needed).
            # Runs on every navigation (login → app) so the QR mirror works on the login page.
            # Tell the client it's running under Vesktop (native mic) BEFORE it runs, so it
            # never installs the CEF-only getUserMedia/visibility overrides that would break
            # Vesktop's native microphone.
            await tab._send_devtools_cmd({
                "method": "Page.addScriptToEvaluateOnNewDocument",
                "params": {"source": "window.STREAMCORD_IS_VESKTOP = true;\n" + client_js, "runImmediately": True},
            }, False)
            await tab._send_devtools_cmd({"method": "Page.reload", "params": {}}, False)
            return tab
        await sleep(1)
