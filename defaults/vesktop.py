"""Vesktop (native Discord) manager: launch it headless with remote debugging,
connect via CDP, get past the first-launch screen, and inject our client. Used
instead of the Steam CEF BrowserView so the microphone works natively."""

import json
import os
import re
import shutil
from asyncio import sleep, create_subprocess_exec
from subprocess import DEVNULL, PIPE
from pathlib import Path
from aiohttp import ClientSession  # type: ignore

from decky import logger  # type: ignore

from tab_utils.cdp import Tab

VESKTOP_CDP = "http://127.0.0.1:9223"
VESKTOP_APP = "dev.vencord.Vesktop"


# ── stand-alone: Vesktop backend = flatpak OU binaire natif ──────────────────
# Bazzite/SteamOS : flatpak (historique). CachyOS/Arch & co n'ont pas forcément
# flatpak → on accepte aussi un Vesktop natif du PATH (paquet `vesktop`).
# Priorité : flatpak déjà installé (garde la session existante) > natif présent
# > flatpak installable silencieusement > rien (message clair côté QAM).
def _native_bin():
    return shutil.which("vesktop") or shutil.which("vesktop-bin")


def _flatpak_available():
    return shutil.which("flatpak") is not None


def _flatpak_vesktop_installed():
    return any((base / "app" / VESKTOP_APP).is_dir()
               for base in (Path.home() / ".local/share/flatpak", Path("/var/lib/flatpak")))


def backend():
    """'flatpak' | 'native' | None (= aucun moyen d'avoir Vesktop)."""
    if _flatpak_available() and _flatpak_vesktop_installed():
        return "flatpak"
    if _native_bin():
        return "native"
    if _flatpak_available():
        return "flatpak"
    return None


# ── multi-sessions: one Discord (Vesktop) profile per Steam account ─────────
# flatpak : profiles INSIDE the Vesktop flatpak app dir so the sandbox can
# write them without extra --filesystem permissions (flatpak forces the XDG
# vars to the app dir, so an --env override does not work). natif : même
# mécanique sur ~/.config. The active profile is selected by atomically
# retargeting the `config/vesktop` symlink.
def _config_base():
    if backend() == "native":
        return Path.home() / ".config"
    return Path.home() / ".var/app" / VESKTOP_APP / "config"


def _profiles_dir():
    return _config_base() / "steamcord-profiles"


def _current_file():
    return _profiles_dir() / "current.json"

# Steam install roots across distros (Bazzite/SteamOS/Arch/Debian…)
_STEAM_ROOTS = ("~/.steam/steam", "~/.local/share/Steam", "~/.steam/root")


def steam_account_id():
    """AccountID (32-bit, as string) of the ACTIVE Steam session.
    registry.vdf ActiveUser first (updated live on user switch; 0 while logged
    out — ignored), then loginusers.vdf MostRecent (SteamID64 → accountid).
    Falls back to "default" so Vesktop still works without Steam."""
    try:
        reg = (Path.home() / ".steam/registry.vdf").read_text(errors="ignore")
        m = re.search(r'"ActiveUser"\s+"(\d+)"', reg)
        if m and m.group(1) != "0":
            return m.group(1)
    except OSError:
        pass
    for root in _STEAM_ROOTS:
        p = Path(os.path.expanduser(root)) / "config/loginusers.vdf"
        try:
            data = p.read_text(errors="ignore")
        except OSError:
            continue
        for m in re.finditer(r'"(\d{17})"\s*\{(.*?)\}', data, re.S):
            sid, block = m.groups()
            if re.search(r'"MostRecent"\s+"1"', block):
                return str(int(sid) - 76561197960265728)
    return "default"


def _ensure_profile(account):
    """Prepare the profile of a Steam account and ROUTE Vesktop to it.
    flatpak forces XDG_CONFIG_HOME to the app dir (`--env=` cannot override
    the XDG vars — verified live), so the switch is the `config/vesktop`
    SYMLINK itself: it is atomically retargeted to the active account's
    profile while Vesktop is stopped. Manual `flatpak run` follows it too.
    The very first time multi-sessions runs, the existing default config (the
    currently logged-in Discord) is ADOPTED by the active account."""
    profiles = _profiles_dir()
    prof = profiles / account
    target = prof / "vesktop"
    default = _config_base() / "vesktop"
    had_profiles = profiles.is_dir() and any(
        p.is_dir() for p in profiles.iterdir())
    if not target.exists():
        prof.mkdir(parents=True, exist_ok=True)
        if not had_profiles and default.is_dir() and not default.is_symlink():
            shutil.move(str(default), str(target))
            logger.info(f"[multisession] existing Discord session adopted by "
                        f"Steam account {account}")
        else:
            target.mkdir(parents=True, exist_ok=True)
    if default.is_dir() and not default.is_symlink():
        # a manual run recreated a REAL default dir while profiles exist —
        # park it so the symlink can take its place (nothing is ever deleted)
        park = default.with_name(f"vesktop.parked-{os.getpid()}")
        shutil.move(str(default), str(park))
        logger.info(f"[multisession] stray default config parked as {park.name}")
    # atomic retarget: build the new symlink beside, then rename over
    tmp = default.with_name("vesktop.swap")
    try:
        tmp.unlink()
    except OSError:
        pass
    tmp.symlink_to(target)
    os.replace(tmp, default)
    return prof


def _recorded_account():
    try:
        return json.loads(_current_file().read_text()).get("account", "")
    except Exception:
        return ""


def _record_account(account):
    try:
        _profiles_dir().mkdir(parents=True, exist_ok=True)
        _current_file().write_text(json.dumps({"account": account}))
    except OSError as e:
        logger.warning(f"[multisession] cannot record account: {e!r}")


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


# flatpak : vesktop.bin (dans le sandbox) ; natif : le chemin d'app contient
# « vesktop » (/usr/lib/vesktop/app.asar, /opt/Vesktop/…) — pattern insensible
# à la casse, assez précis pour ne pas matcher steamcord-vesktop (nom d'unité,
# absent des cmdlines).
_PROC_PATTERN = "[Vv]esktop"


async def _running():
    """True if a Vesktop process exists, regardless of the debug port."""
    try:
        proc = await create_subprocess_exec("pgrep", "-f", _PROC_PATTERN, stdout=DEVNULL, stderr=DEVNULL)
        return (await proc.wait()) == 0
    except Exception:
        return False


async def installed():
    b = backend()
    if b == "native":
        return True
    if b == "flatpak":
        return _flatpak_vesktop_installed()
    return False


async def install():
    if backend() != "flatpak":
        # natif = déjà installé ; None = rien d'installable silencieusement
        # (flatpak lui-même demande root) → le QAM affiche la marche à suivre.
        if backend() is None:
            logger.warning("[standalone] ni flatpak ni Vesktop natif — installe "
                           "flatpak ou le paquet vesktop puis relance le plugin")
        return
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


VESKTOP_UNIT = "steamcord-vesktop"


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


def _any_display(runtime_dir):
    """True if SOME display Vesktop can render on exists. In pure gamemode the
    compositor is gamescope: wayland-0 n'apparaît JAMAIS (seulement gamescope-0 +
    XWayland X0/X1) — attendre wayland-0 brûlait les 120s complètes à CHAQUE boot
    console (2 min d'« Initialisation… » pour rien, prouvé au boot du 2026-07-02 :
    backend 16:01:31 → systemd-run 16:03:31, +120s pile). Electron retombe seul
    sur X11 quand WAYLAND_DISPLAY pointe dans le vide, donc n'importe laquelle de
    ces sockets suffit pour que Vesktop rende et ouvre le port CDP."""
    if (Path(runtime_dir) / "wayland-0").exists():
        return True
    try:
        if any(p.name.startswith("gamescope-") and p.is_socket()
               for p in Path(runtime_dir).iterdir()):
            return True
    except Exception:
        pass
    try:
        return any(Path("/tmp/.X11-unix").iterdir())
    except Exception:
        return False


async def _wait_for_display(runtime_dir, timeout=120):
    """Block until a usable display exists (see _any_display). Launching Vesktop
    with no display at all gives Electron nothing to render on so it never opens
    the CDP debug port — that was the infinite 'initialize() failed ... 9223
    ConnectionRefused' loop at cold gamemode boot."""
    for _ in range(timeout):
        if _any_display(runtime_dir):
            return True
        await sleep(1)
    return _any_display(runtime_dir)


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

    # [launchdiag] Gamemode-specific stuck-on-Initializing diagnosis: capture exactly
    # which compositor sockets exist and what graphical env the manager exported. In
    # pure gamemode the root compositor is gamescope (not KWin), so wayland-0 may be
    # gamescope's socket — or absent — which would keep Vesktop from rendering and 9223
    # from ever opening. This logs even when the user is away in gamemode.
    try:
        socks = sorted(
            p.name for p in Path(runtime_dir).iterdir()
            if p.is_socket() and (p.name.startswith("wayland-") or p.name.startswith("gamescope-"))
        )
    except Exception as e:
        socks = [f"err {e!r}"]
    logger.info(
        f"[launchdiag] sockets={socks} env.WAYLAND_DISPLAY={session_env.get('WAYLAND_DISPLAY')!r} "
        f"env.DISPLAY={session_env.get('DISPLAY')!r} env.XAUTHORITY={'set' if xauth else 'empty'} "
        f"targeting WAYLAND_DISPLAY=wayland-0"
    )

    # Multi-sessions: pick the Vesktop profile of the ACTIVE Steam account.
    # (The profile dir itself is prepared AFTER any old instance is stopped,
    # so the first-run adoption never moves a config Vesktop is writing to.)
    account = steam_account_id()

    # If OUR debug unit is already coming up, never kill it — just wait for the port.
    # Only a FOREIGN (non-debug) Vesktop needs killing: Electron is single-instance, so a
    # second `flatpak run` would only wake it and drop our flags. Blindly killing on every
    # retry is what previously prevented the loop from ever recovering on its own.
    if await _unit_active(VESKTOP_UNIT):
        if _recorded_account() != account:
            # The running instance belongs to ANOTHER Steam account's profile —
            # stop it and fall through to a relaunch on the right one.
            logger.info(f"[multisession] Steam account changed "
                        f"({_recorded_account() or '?'} → {account}) — "
                        f"switching Discord profile")
        else:
            # 15s suffit largement : Electron ouvre le port CDP ~2s après le start
            # (mesuré au boot). Au-delà = instance zombie (ex. gamescope mort sous
            # Vesktop à la bascule mode jeu↔bureau) — attendre 60s ne faisait que
            # rallonger la reconnexion de la QAM après chaque bascule.
            for _ in range(15):
                if await is_up():
                    return True
                await sleep(1)
            # Our unit is up but the port never opened (hung instance) — clear it
            # and relaunch.
        try:
            st = await create_subprocess_exec(
                "systemctl", "--user", "stop", VESKTOP_UNIT,
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            await st.wait()
        except Exception:
            pass
    # Stopping the unit is NOT enough: the sandboxed app (bwrap) can escape the
    # unit's cgroup, keep 9223 open, and Electron is single-instance — a new
    # `flatpak run` would just wake the OLD instance (old profile) and exit.
    # Seen live on the first multisession switch (unit inactive, vesktop.bin
    # alive since boot). So always flatpak-kill any leftover before spawning.
    # (backend natif : pas de sandbox → pkill sur le pattern suffit.)
    if await _running():
        try:
            if backend() == "flatpak":
                killer = await create_subprocess_exec(
                    "flatpak", "kill", VESKTOP_APP, stdout=DEVNULL, stderr=DEVNULL, env=env,
                )
            else:
                killer = await create_subprocess_exec(
                    "pkill", "-f", _PROC_PATTERN, stdout=DEVNULL, stderr=DEVNULL,
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
    # Session gamescope (mode jeu) : forcer XDG_SESSION_TYPE=wayland pour que le
    # WebRTC de Chromium prenne le chemin portail/PipeWire (IsRunningUnderWayland
    # exige XDG_SESSION_TYPE=wayland ET WAYLAND_DISPLAY). C'est ce qui route le
    # getDisplayMedia natif vers notre portal_shim.py → Go Live RÉEL en mode jeu.
    # Le rendu, lui, retombe sur X11 comme avant (WAYLAND_DISPLAY pointe dans le
    # vide sous gamescope pur — cf. _any_display). Pas de --setenv hors gamescope :
    # sur un bureau X11 classique, forcer "wayland" casserait la capture X11 native.
    # KWin testé en PREMIER (même logique que main.py:get_share_env) : les
    # sockets gamescope-* PERSISTENT dans XDG_RUNTIME_DIR après une session
    # gamemode, et un gamescope imbriqué par-jeu peut tourner sous KWin
    # (= bureau quand même) — le test socket seul força(it) wayland à tort
    # au bureau.
    def _proc_running(*names):
        try:
            for p in Path("/proc").iterdir():
                if not p.name.isdigit():
                    continue
                try:
                    if (p / "comm").read_text().strip() in names:
                        return True
                except OSError:
                    continue
        except Exception:
            pass
        return False
    gamescope = (not _proc_running("kwin_wayland", "kwin_x11")
                 and _proc_running("gamescope", "gamescope-wl"))
    extra_flags = []
    if gamescope:
        setenv.append("--setenv=XDG_SESSION_TYPE=wayland")
        # XDG_SESSION_TYPE=wayland fait choisir « wayland » à l'ozone AUTO
        # d'Electron → il tente WAYLAND_DISPLAY=wayland-0 (inexistant sous
        # gamescope pur, le socket est gamescope-0) et ne retombe PAS sur X11 :
        # aucune fenêtre, CDP jamais ouvert (vu en live 18/07). On épingle donc
        # le RENDU sur X11 (XWayland gamescope) ; la sélection du capturer
        # WebRTC (portail) lit les variables d'ENV, pas la plateforme ozone.
        extra_flags.append("--ozone-platform=x11")

    _ensure_profile(account)
    _record_account(account)
    # stand-alone : la commande dépend du backend — flatpak (Bazzite/SteamOS)
    # ou binaire natif (CachyOS/Arch…). Mêmes flags Electron dans les deux cas.
    b = backend()
    if b is None:
        logger.warning("[standalone] aucun backend Vesktop (ni flatpak ni natif) "
                       "— installe flatpak (ex: sudo pacman -S flatpak) ou le "
                       "paquet vesktop, puis relance le plugin")
        return False
    if b == "flatpak":
        cmd = ["flatpak", "run", VESKTOP_APP]
    else:
        cmd = [_native_bin()]

    # Extinction rapide (issue #7) : `flatpak run` enregistre Vesktop dans SON
    # PROPRE scope systemd (app-flatpak-dev.vencord.Vesktop-*.scope), HORS du
    # cgroup de notre unité (bwrap s'en échappe, cf. le flatpak-kill plus haut).
    # À l'arrêt système ce scope reçoit SIGTERM, qu'Electron/bwrap ignore →
    # systemd attend le TimeoutStopSec par défaut (~90 s) avant le SIGKILL vu
    # dans les logs de David → l'extinction PEND (rétroéclairage faible, ventilo
    # qui tourne longtemps). Fix : un ExecStop qui tue activement l'app (flatpak
    # kill / pkill) — le scope se vide et s'arrête aussitôt — + un TimeoutStopSec
    # court en filet. L'ExecStop hérite de l'Environment (--setenv) de l'unité,
    # donc flatpak kill atteint bien l'instance via le bus de session.
    stop_props = ["--property=TimeoutStopSec=8", "--property=KillMode=mixed"]
    if b == "flatpak":
        _fp = shutil.which("flatpak")
        if _fp:
            stop_props.append(f"--property=ExecStop={_fp} kill {VESKTOP_APP}")
    else:
        _pk = shutil.which("pkill")
        if _pk:
            stop_props.append(f"--property=ExecStop={_pk} -f {_PROC_PATTERN}")

    await create_subprocess_exec(
        "systemd-run", "--user", "--collect", f"--unit={VESKTOP_UNIT}",
        *stop_props,
        *setenv,
        *cmd,
        "--remote-debugging-port=9223",
        "--remote-allow-origins=*",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        # Login token persists, so we no longer need the window visible for the QR —
        # start it minimized so it runs invisibly in the background.
        "--start-minimized",
        # Issue #5 : sur les GPU avec décodeur vidéo matériel (Steam Deck/VCN…),
        # le décodage VAAPI d'Electron sort des frames VERTES pour les streams
        # entrants (bug Chromium/VAAPI connu) → visionnage Go Live/cam
        # inutilisable. On force le décodage LOGICIEL — c'est déjà le chemin
        # (validé) de la BC-250, dont le GPU n'a pas de VCN. L'ENCODAGE (envoi
        # de son propre partage) n'est pas touché.
        "--disable-accelerated-video-decode",
        "--disable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL",
        *extra_flags,
        stdout=DEVNULL, stderr=DEVNULL, env=env,
    )
    for i in range(60):
        if await is_up():
            logger.info(f"[launchdiag] Vesktop CDP 9223 up after ~{i}s")
            return True
        await sleep(1)
    logger.warning(
        "[launchdiag] Vesktop launched but CDP 9223 never opened after 60s "
        "(Electron likely got no usable display) — QAM will stay on 'Initializing'"
    )
    return False


async def _get_page():
    """Return the CDP target dict for Vesktop's main page (Discord or first-launch)."""
    tabs = await _cdp_json("/json")
    return next((t for t in tabs if t.get("type") == "page"), None)


# stand-alone : nombre d'installs Vesktop tentées SANS succès (flatpak dispo
# mais hors-ligne/flathub bloqué/disque plein). ≥3 → le QAM bascule sur l'écran
# d'aide au lieu d'« Initializing » éternel ; remis à 0 dès qu'une install passe.
install_failures = 0


async def get_discord_tab(client_js) -> Tab:
    """Ensure Vesktop is running and logged-into-able, inject our client, return the Tab."""
    global install_failures
    if not await is_up():
        if not await installed():
            await install()
        if not await installed():
            # stand-alone : rien pour faire tourner Vesktop (pas de flatpak, pas
            # de binaire natif, ou install flatpak qui échoue) → remonter une
            # erreur claire plutôt que de marteler le port CDP.
            if backend() == "flatpak":
                install_failures += 1
            raise RuntimeError("no Vesktop backend (flatpak or native) available")
        install_failures = 0
        await launch()

    # Wait for a page target and get past the first-launch setup screen
    while True:
        page = await _get_page()
        if page:
            tab = Tab(page)
            await tab.open_websocket()
            await tab.enable()
            url = page.get("url", "")
            logger.info(f"[launchdiag] Vesktop page url={url!r}")
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
            # PAS runImmediately : sinon le script tourne 2× (immédiat + au reload) →
            # 2 WS + 2 intercepteurs sur le même document → events traités en double
            # (le toggle mute s'annulait, etc.). Le reload juste après suffit → 1 exécution.
            await tab._send_devtools_cmd({
                "method": "Page.addScriptToEvaluateOnNewDocument",
                "params": {"source": "window.STEAMCORD_IS_VESKTOP = true;\n" + client_js},
            }, False)
            await tab._send_devtools_cmd({"method": "Page.reload", "params": {}}, False)
            return tab
        await sleep(1)
