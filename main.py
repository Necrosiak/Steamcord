from aiohttp.web import (  # type: ignore
    Application,
    get,
    WebSocketResponse,
    AppRunner,
    TCPSite,
    Response,
)
from asyncio import sleep, create_task, create_subprocess_exec, wait_for
import signal
import aiohttp_cors  # type: ignore
from json import dumps
from pathlib import Path
from subprocess import PIPE, DEVNULL

import sys
import os

from decky import logger, DECKY_PLUGIN_DIR, emit  # type: ignore
from logging import INFO

# defaults/ EN PREMIER : le deploy local ne synchronise QUE defaults/, la copie
# racine (extraite du zip de release) reste figée. Sans cette priorité, un fix
# dans discord_client/ ou tab_utils/ ne prenait effet qu'à la release suivante —
# même piège que updater.py/vesktop.py (chargés explicitement plus bas), mais
# invisible : les notifs perdues venaient du VIEUX _rpc_notification racine.
sys.path.insert(0, str(Path(DECKY_PLUGIN_DIR) / "defaults"))
sys.path.append(DECKY_PLUGIN_DIR)

from tab_utils.tab import (
    create_discord_tab,
    setup_discord_tab,
    boot_discord,
    setOSK,
)
from tab_utils.cdp import Tab, get_tab
from discord_client.event_handler import EventHandler

# Decky enregistre son PROPRE module `updater` dans sys.modules, donc un simple
# `import updater` renvoie CELUI-LÀ (qui n'a pas is_autoupdate_enabled) au lieu du
# updater.py du plugin → l'auto-update a silencieusement cassé après une MAJ Decky
# ("module 'decky_loader.updater' has no attribute 'is_autoupdate_enabled'"). On
# charge notre fichier explicitement par chemin (nom unique) pour éviter la collision.
import importlib.util as _ilu
# Charger depuis defaults/ (toujours synchronisé par le deploy + présent dans le zip)
# plutôt que la copie racine ; nom de module unique pour éviter la collision Decky.
_upath = Path(DECKY_PLUGIN_DIR) / "defaults" / "updater.py"
if not _upath.exists():
    _upath = Path(DECKY_PLUGIN_DIR) / "updater.py"
_uspec = _ilu.spec_from_file_location("sc_updater", str(_upath))
updater = _ilu.module_from_spec(_uspec)
_uspec.loader.exec_module(updater)

# vesktop.py a le MÊME problème que updater.py : le deploy synchronise defaults/
# mais PAS la copie racine → `import vesktop` chargeait une version figée au
# 2026-06-28 (avec runImmediately, sans launchdiag). On charge defaults/vesktop.py
# et on l'enregistre dans sys.modules AVANT tout `import vesktop` : sys.modules
# gagne toujours sur la résolution par sys.path.
_vpath = Path(DECKY_PLUGIN_DIR) / "defaults" / "vesktop.py"
if not _vpath.exists():
    _vpath = Path(DECKY_PLUGIN_DIR) / "vesktop.py"
_vspec = _ilu.spec_from_file_location("vesktop", str(_vpath))
_vmod = _ilu.module_from_spec(_vspec)
sys.modules["vesktop"] = _vmod
_vspec.loader.exec_module(_vmod)

logger.setLevel(INFO)


def sys_python():
    """Python SYSTÈME (pour les bindings gi/Gst, absents du python du plugin).
    /usr/bin/python n'existe pas sur Debian/Ubuntu (sauf python-is-python3) →
    résoudre python3 du PATH d'abord."""
    import shutil as _sh
    return _sh.which("python3") or _sh.which("python") or "/usr/bin/python"


async def stream_watcher(stream, is_err=False, prefix="[gst]"):
    async for line in stream:
        line = line.decode("utf-8").rstrip()
        if not line.strip():
            continue
        # Surface GStreamer/WebRTC subprocess output in the journal (was logger.debug,
        # invisible at INFO level — made screenshare failures impossible to diagnose).
        if is_err:
            logger.warning(prefix + " " + line)
        else:
            logger.info(prefix + " " + line)


async def initialize():
    # NATIVE approach: drive Vesktop (a real Electron Discord, mic works) over CDP
    # instead of a hidden Steam CEF BrowserView (where the mic is impossible).
    import vesktop
    # defaults/ d'abord : même piège que discord_client/tab_utils — la copie
    # racine vient du zip de release et n'est PAS resynchronisée par le deploy
    # local (le client injecté restait figé → pas d'enrichissement __sc_dm).
    _cjs = Path(DECKY_PLUGIN_DIR) / "defaults" / "steamcord_client.js"
    if not _cjs.exists():
        _cjs = Path(DECKY_PLUGIN_DIR) / "steamcord_client.js"
    client_js = open(_cjs, "r").read()
    # webrtc_client.js surcharge getDisplayMedia → capture d'écran GStreamer pour
    # le partage d'écran (Go Live). DOIT être injecté sous Vesktop aussi, sinon le
    # partage d'écran « ne donne rien » (getDisplayMedia natif inutilisable headless).
    try:
        _wjs = Path(DECKY_PLUGIN_DIR) / "defaults" / "webrtc_client.js"
        if not _wjs.exists():
            _wjs = Path(DECKY_PLUGIN_DIR) / "webrtc_client.js"
        webrtc_js = open(_wjs, "r").read()
    except Exception:
        webrtc_js = ""
    tab = await vesktop.get_discord_tab(webrtc_js + "\n" + client_js)

    Plugin.discord_tab = tab

    create_task(watchdog(tab))
    create_task(_ensure_handshake(tab))
    return tab


# The injected client only emits LOADED / CONNECTION_OPEN once, on its first
# DOMContentLoaded. If the backend (re-)initializes AFTER that point — watchdog
# recovery (re-initialize()), a soft websocket reconnect, or simply Vesktop having
# survived a plugin_loader restart — the handshake is never re-delivered, so
# evt_handler.loaded stays False and the QAM is stuck on "Initializing…" forever
# even though Vesktop/CDP/the Discord tab all work. Actively re-request the
# handshake from the already-injected client until the backend sees itself loaded.
_REHANDSHAKE_JS = """
(() => {
  try {
    var w = window.STEAMCORD_WS;
    if (!w || w.readyState !== 1) return;
    if (!(window.Vencord && Vencord.Webpack && Vencord.Webpack.Common
          && Vencord.Webpack.Common.UserStore)) return;
    w.send(JSON.stringify({ type: "LOADED", result: true }));
    var u = Vencord.Webpack.Common.UserStore.getCurrentUser();
    if (u) w.send(JSON.stringify({ type: "CONNECTION_OPEN", user: u }));
  } catch (e) {}
})()
"""


async def _ensure_handshake(tab: Tab):
    # Poll for up to ~30s: as soon as the backend is loaded we're done; otherwise
    # nudge the client to re-emit the handshake. Idempotent (LOADED just re-sets the
    # flag, CONNECTION_OPEN refreshes the current user). Bounded so the QR/login flow
    # (never "loaded" until the user scans) doesn't loop forever.
    for _ in range(30):
        if Plugin.evt_handler.loaded:
            return
        try:
            await tab.evaluate(_REHANDSHAKE_JS)
        except Exception:
            pass
        await sleep(1)


async def watchdog(tab: Tab):
    import vesktop
    while True:
        # `tab.websocket.closed` stays False on a half-broken CDP transport (the
        # "Cannot write to closing transport" case seen when Vesktop dies but the
        # socket lingers in a closing state). And probing the CDP endpoint
        # (vesktop.is_up) n'attrape PAS un restart RAPIDE de Vesktop : le nouveau
        # process ré-expose :9223 avant la sonde suivante → is_up() reste True
        # alors que NOTRE onglet est mort → jamais ré-injecté → QAM bloqué sur
        # « Initialisation… » (vécu 19/07 après un systemctl restart). On sonde
        # donc l'ONGLET lui-même : un evaluate trivial avec timeout — s'il ne
        # répond plus, l'onglet est mort quel que soit l'état de l'endpoint.
        from asyncio import wait_for
        while not tab.websocket.closed:
            await sleep(3)
            try:
                await wait_for(tab.evaluate("1"), 5)
            except Exception:
                logger.info("Discord tab stopped answering (Vesktop restarted or CDP bounced) — treating it as dead.")
                break

        logger.info("Discord tab websocket is no longer open. Trying to reconnect...")

        try:
            # Only a soft reconnect makes sense if Vesktop is actually alive.
            if await vesktop.is_up():
                await tab.open_websocket()
                logger.info("Reconnected")
            else:
                break

        except:
            break

    logger.info("Discord has died. Re-initializing...")

    while True:
        try:
            await initialize()
            break

        except:
            await sleep(1)


class Plugin:
    server = Application()
    cors = aiohttp_cors.setup(
        server,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                expose_headers="*", allow_headers="*", allow_credentials=True
            )
        },
    )
    evt_handler = EventHandler()
    last_ws: WebSocketResponse = None
    discord_tab = None
    # Routage audio par-application (PipeWire) : None = auto (suit le système).
    _audio_out = None
    _audio_in = None
    # Réglages micro voulus par l'user (noise/echo/AGC). Persistés côté plugin
    # et ré-assertés à chaque login du client : la persistance interne de
    # Discord se perd sur certains setups → retour aux défauts (issue #14).
    _mic_prefs = {}
    _AUDIO_CFG = os.path.expanduser("~/.config/steamcord-audio.json")
    # ── Partage audio du jeu (voir section "Partage AUDIO du jeu") ──
    _ga_active = False
    _ga_modules = []          # ids des modules pactl chargés (ordre de chargement)
    _ga_loop_mod = {}         # branche ("voice"/"game") -> id du module loopback
    _ga_real_sink = None      # vraie sortie à restaurer au stop
    _ga_real_source = None    # source par défaut à restaurer au stop
    _ga_vol = {"voice": 100, "game": 60}

    @classmethod
    async def _main(cls):
        logger.info("Starting Steamcord backend")
        # CEF (SharedJSContext) can disconnect/reload during startup, which throws
        # mid-evaluate and would otherwise kill _main permanently (watchdog never
        # starts). Retry until the Discord tab is successfully created.
        while True:
            try:
                await initialize()
                break
            except Exception as e:
                # stand-alone : sans backend Vesktop (ni flatpak ni natif), inutile
                # de marteler toutes les 2 s — on re-teste calmement (self-heal dès
                # que le user installe flatpak ou le paquet vesktop).
                import vesktop
                if vesktop.backend() is None or vesktop.install_failures > 0:
                    # aucun backend, OU flatpak dispo mais l'install Vesktop échoue
                    # (hors-ligne/flathub bloqué) — marteler toutes les 2 s ne sert
                    # à rien, on re-teste calmement (self-heal au retour du réseau).
                    logger.warning("initialize(): no usable Vesktop backend "
                                   f"(install_failures={vesktop.install_failures}) "
                                   "— retrying in 15s")
                    await sleep(15)
                else:
                    logger.warning(f"initialize() failed ({e!r}); retrying in 2s")
                    await sleep(2)
        logger.info("Discord initialized")

        cls.server.add_routes(
            [
                get("/openkb", cls._openkb),
                get("/voice_render", cls._voice_render),
                get("/voice_hide", cls._voice_hide),
                get("/socket", cls._websocket_handler)
            ]
        )
        for r in list(cls.server.router.routes())[:-1]:
            cls.cors.add(r)

        cls.runner = AppRunner(cls.server, access_log=None)
        await cls.runner.setup()
        logger.info("Starting server.")
        await TCPSite(cls.runner, "0.0.0.0", 65123).start()

        # Same failure mode as initialize() above: while the Steam UI is still
        # (re)starting, CEF answers /json but SharedJSContext is not in the tab
        # list yet — a one-shot lookup here killed _main (QAM showed the raw
        # Python exception).
        while True:
            try:
                cls.shared_js_tab = await get_tab("SharedJSContext")
                break
            except ValueError:
                logger.warning("SharedJSContext tab not up yet — retrying in 3s")
                await sleep(3)
        await cls.shared_js_tab.open_websocket()
        create_task(cls._notification_dispatcher())

        # Use the SYSTEM GStreamer (1.26+). The original Deckcord bundled GStreamer in
        # bin/, but this fork never shipped it — pointing at a nonexistent bin/ broke the
        # subprocess silently. Inherit the full environment so PATH/HOME/typelibs resolve,
        # and only override what's needed for hw encode + pipewire/pulse access.
        uid = os.getuid()
        # Le plugin GStreamer `nice` (ICE, requis par webrtcbin) n'est PAS dans l'image
        # Bazzite de base → webrtcbin échouait à construire le pipeline VP8 ("missing
        # plug-in") et getDisplayMedia se bloquait. On embarque libgstnice.so et on
        # l'ajoute au GST_PLUGIN_PATH (pas d'install système / pas de reboot).
        gst_plugins_dir = str(Path(DECKY_PLUGIN_DIR) / "defaults" / "gst-plugins")
        gst_env = {
            **os.environ,
            "GST_VAAPI_ALL_DRIVERS": "1",
            "LIBVA_DRIVER_NAME": "radeonsi",
            "GST_PLUGIN_PATH": gst_plugins_dir + os.pathsep + os.environ.get("GST_PLUGIN_PATH", ""),
            "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{uid}"),
            "DBUS_SESSION_BUS_ADDRESS": os.environ.get(
                "DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus"
            ),
        }
        # Réutilisé par le feeder webcam virtuelle (gst_camera.py).
        cls._gst_env = gst_env
        # Auto-install des dépendances du partage d'écran (self-contained sur toute
        # BC-250 fraîche) AVANT de lancer gst_webrtc.py.
        await cls._ensure_screenshare_deps()
        # Tuer un gst_webrtc.py orphelin (restart de plugin_loader ne tue pas toujours
        # l'enfant → port 65124 "address already in use"). Puis laisser le port se libérer.
        try:
            import vesktop
            killer = await create_subprocess_exec("pkill", "-f", "gst_webrtc.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
            await sleep(1)
        except Exception:
            pass
        cls.webrtc_server = await create_subprocess_exec(
            sys_python(),
            str(Path(DECKY_PLUGIN_DIR) / "gst_webrtc.py"),
            env=gst_env,
            stdout=PIPE,
            stderr=PIPE,
        )
        create_task(stream_watcher(cls.webrtc_server.stdout))
        create_task(stream_watcher(cls.webrtc_server.stderr, True))
        # Portail ScreenCast pour gamescope (portal_shim.py) : rend le Go Live
        # NATIF fonctionnel en mode jeu (getDisplayMedia → notre portail → node
        # PipeWire gamescope), sans caméra virtuelle ni relais WebRTC local.
        # Tourne sous le python SYSTÈME (pas de gi requis — dbus_next est
        # vendoré dans py_modules, passé via PYTHONPATH).
        try:
            killer = await create_subprocess_exec("pkill", "-f", "portal_shim.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
        except Exception:
            pass
        _shim = Path(DECKY_PLUGIN_DIR) / "portal_shim.py"
        if not _shim.exists():
            _shim = Path(DECKY_PLUGIN_DIR) / "defaults" / "portal_shim.py"
        shim_env = {
            **vesktop._user_env(),
            "PYTHONPATH": str(Path(DECKY_PLUGIN_DIR) / "py_modules"),
        }
        cls.portal_shim = await create_subprocess_exec(
            sys_python(), str(_shim), env=shim_env, stdout=PIPE, stderr=PIPE,
        )
        create_task(stream_watcher(cls.portal_shim.stdout, prefix="[portal]"))
        create_task(stream_watcher(cls.portal_shim.stderr, True, prefix="[portal]"))
        create_task(cls._remote_auth_watcher())
        create_task(cls._audio_keepalive())
        create_task(cls._autoupdate_check())
        cls._load_audio_cfg()
        cls.evt_handler.on_logged_in = cls._apply_mic_prefs
        create_task(cls._audio_routing_watcher())
        create_task(cls._screen_diag())
        create_task(cls._ga_boot_cleanup())
        create_task(cls._account_watcher())

        async for state in cls.evt_handler.yield_new_state():
            await emit("state", state)

    @classmethod
    async def _account_watcher(cls):
        """Multi-sessions : un profil Discord (Vesktop) par compte Steam. Quand
        le compte Steam actif change (changement d'utilisateur sur la console),
        vesktop.launch() détecte le désaccord de profil, arrête l'unité et
        relance sur le bon profil ; le watchdog ré-injecte ensuite le client
        tout seul dès que le CDP rebondit."""
        import vesktop
        last = vesktop.steam_account_id()
        # Premier démarrage multi-sessions : l'instance qui tourne n'a aucun
        # profil enregistré. On l'adopte/relance TOUT DE SUITE, pendant que le
        # compte Steam actif est forcément celui de la session Discord actuelle
        # — adopter plus tard risquerait d'attribuer la session du proprio au
        # compte d'un autre (ex. la copine se connecte la première).
        try:
            if (vesktop._recorded_account() != last
                    and await vesktop._unit_active(vesktop.VESKTOP_UNIT)):
                logger.info(f"[multisession] instance sans profil → adoption "
                            f"par le compte {last} + relance")
                await vesktop.launch()
        except Exception as e:
            logger.warning(f"[multisession] adoption initiale: {e!r}")
        while True:
            # 5 s : deux petits fichiers lus, coût négligeable — et la détection
            # est la seule part compressible du temps de bascule (le reste =
            # redémarrage Vesktop + chargement Discord, ~15-30 s incompressibles).
            await sleep(5)
            try:
                acc = vesktop.steam_account_id()
                if acc != last:
                    logger.info(f"[multisession] compte Steam actif {last} → {acc}")
                    last = acc
                    # Purger l'état Discord AVANT la relance : le nouveau profil
                    # appartient à quelqu'un d'autre. Sans ça, logged_in restait
                    # True → le LOADED du profil vierge ne démarrait jamais le QR
                    # et le QAM affichait encore l'ancien compte (vu en live).
                    # _logout relance aussi remote_auth (QR) ; si le nouveau
                    # profil est déjà loggé, CONNECTION_OPEN reprendra la main.
                    await cls.evt_handler._logout({})
                    cls.evt_handler.state_changed_event.set()
                    await vesktop.launch()
            except Exception as e:
                logger.warning(f"[multisession] account watcher: {e!r}")

    @classmethod
    async def _audio_keepalive(cls):
        # ROOT CAUSE of "I can't hear anyone": Chromium's autoplay policy keeps
        # AudioContexts suspended in the hidden Discord BrowserView because it never
        # receives a user gesture. A page-side resume() doesn't count. Resuming via a
        # CDP eval with userGesture=True simulates a real activation and unblocks the
        # audio output (a "Chromium / Playback" sink-input then appears on the default
        # sink, which follows headphones/HDMI automatically). Re-assert periodically
        # because Discord spins up new contexts when (re)joining a voice call.
        js = """(() => {
          try {
            let resumed = 0, states = [];
            const me = Vencord.Webpack.findStore('MediaEngineStore')?.getMediaEngine?.();
            const ctxs = [];
            if (me?.audioContext) ctxs.push(me.audioContext);
            if (window.__sc_extra_ctx) ctxs.push(window.__sc_extra_ctx);
            for (const c of ctxs) {
              states.push(c.state);
              if (c.state === 'suspended') { c.resume(); resumed++; }
            }
            return 'resumed=' + resumed + ' states=' + JSON.stringify(states);
          } catch (e) { return 'err:' + e.message; }
        })()"""
        while True:
            try:
                tab = getattr(cls, "discord_tab", None)
                if tab is not None:
                    await tab.ensure_open()
                    res = await tab.evaluate(js, wait=True, user_gesture=True)
                    val = (((res or {}).get("result") or {}).get("result") or {}).get("value")
                    if val and "resumed=0" not in val:
                        logger.info(f"[audio] keepalive: {val}")
            except Exception as e:
                logger.debug(f"[audio] keepalive error: {e}")
            await sleep(4)

    @classmethod
    async def _remote_auth_watcher(cls):
        # Remote auth is now handled entirely in steamcord_client.js
        # This task is kept as a no-op for compatibility
        while True:
            await sleep(3600)

    @classmethod
    async def _toast(cls, title, body):
        try:
            # API NATIVE Steam (DisplayClientNotification, type 1) au lieu du toaster
            # Decky : ce dernier crée des notifs sans `notification_type` qui ne font
            # pas de popup ET font planter le panneau de notifs Steam sur ce build.
            payload = dumps({"title": title, "body": body, "state": "active"}).replace("\\", "\\\\").replace("'", "\\'")
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                "(()=>{const o=JSON.parse('" + payload + "');"
                "const A=window.App;o.steamid=A&&A.GetCurrentUser&&A.GetCurrentUser()?A.GetCurrentUser().strSteamID:'';"
                "window.SteamClient&&window.SteamClient.ClientNotifications&&"
                "window.SteamClient.ClientNotifications.DisplayClientNotification(1,JSON.stringify(o),function(){});})()"
            )
        except Exception as e:
            logger.debug(f"toast failed: {e}")

    @classmethod
    async def _autoupdate_check(cls):
        # Non-blocking release check at boot. If a newer release exists:
        # auto-update ON  → download + unpack over the plugin dir + restart loader;
        # auto-update OFF → just toast that an update is available (before, the
        # user was never told anything and had to open the QAM to find out).
        try:
            info = await updater.check()
            if not info.get("update_available"):
                return
            if not updater.is_autoupdate_enabled():
                logger.info(
                    f"[updater] {info['latest']} available (have {info['current']}); "
                    "autoupdate off — notifying only"
                )
                # Toasts en ANGLAIS : même règle que le script v4l2 — ils partent
                # chez tous les users, quelle que soit la langue du QAM.
                await cls._toast(
                    "Steamcord",
                    f"Update {info['latest']} available — install it from the Quick Access Menu",
                )
                return
            logger.info(
                f"[updater] {info['latest']} available (have {info['current']}); auto-applying"
            )
            await cls._toast("Steamcord", f"Updating to {info['latest']}…")
            # apply() renvoie un dict {"ok": bool, "error"?} — un simple `if` était
            # toujours vrai (dict non vide), donc un échec toastait « installée » et
            # redémarrait le loader pour rien.
            res = await updater.apply(info["url"])
            if res.get("ok"):
                await cls._toast("Steamcord", "Update installed — reloading…")
                await sleep(2)
                updater.restart_loader()
            else:
                await cls._toast("Steamcord", f"Update failed: {res.get('error', '?')}")
        except Exception as e:
            logger.warning(f"[updater] auto-check error: {e}")

    @classmethod
    async def check_update(cls):
        return await updater.check()

    @classmethod
    async def get_version(cls):
        return updater.get_current_version()

    @classmethod
    async def apply_update(cls, url):
        res = await updater.apply(url)
        if res.get("ok"):
            await cls._toast("Steamcord", "Update installed — reloading…")
            await sleep(1)
            updater.restart_loader()
        return res

    @classmethod
    async def get_autoupdate(cls):
        return updater.is_autoupdate_enabled()

    @classmethod
    async def set_autoupdate(cls, enabled):
        return updater.set_autoupdate_enabled(enabled)

    @classmethod
    async def _openkb(cls, request):
        await cls.shared_js_tab.ensure_open()
        await setOSK(cls.shared_js_tab, True)
        logger.info("Setting discord visibility to true")
        return Response(text="OK")

    @classmethod
    async def _voice_render(cls, request):
        # Chromium freezes WebRTC in the occluded (hidden) BrowserView, so the voice
        # connection stalls forever at DTLS_CONNECTING. Rendering the view (even 1×1)
        # un-backgrounds the renderer so the handshake completes. The JS calls this
        # while the voice connection is establishing, then /voice_hide once connected.
        try:
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate("""
                try {
                    window.DISCORD_TAB.m_browserView.SetBounds(0, 0, 1, 1);
                    window.DISCORD_TAB.m_browserView.SetVisible(true);
                } catch (e) {}
            """)
        except Exception as e:
            logger.warning(f"voice_render failed: {e}")
        return Response(text="OK")

    @classmethod
    async def _voice_hide(cls, request):
        try:
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate("""
                try {
                    window.DISCORD_TAB.m_browserView.SetVisible(false);
                    window.DISCORD_TAB.m_browserView.SetBounds(0, 0, window.DISCORD_TAB.WIDTH, window.DISCORD_TAB.HEIGHT);
                } catch (e) {}
            """)
        except Exception as e:
            logger.warning(f"voice_hide failed: {e}")
        return Response(text="OK")

    @classmethod
    async def _websocket_handler(cls, request):
        logger.info("Received websocket connection!")
        ws = WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        # Re-pousser le Rich Presence (issue #11) au client fraîchement (re)connecté
        # — petit délai le temps que son écouteur de messages et les stores Flux
        # soient posés. Fire-and-forget : un échec ne doit pas tuer la connexion.
        if cls._rpc_game and cls._rpc_pref():
            async def _replay_rpc():
                await sleep(2)
                try:
                    await cls.evt_handler.send_client(
                        {"type": "$rpc", "game": cls._rpc_game,
                         "started_at": cls._rpc_since})
                except Exception:
                    pass
            create_task(_replay_rpc())
        await cls.evt_handler.main(ws)
        return ws

    @classmethod
    async def _notification_dispatcher(cls):
        async for notification in cls.evt_handler.yield_notification():
            logger.info("Dispatching notification")
            payload = dumps(
                {
                    "title": notification["title"],
                    "body": notification["body"],
                    "kind": notification.get("kind", ""),
                    "icon": notification.get("icon", ""),
                    "channel_id": notification.get("channel_id", ""),
                }
            )
            # payload (json.dumps ASCII) est une expression JS valide telle quelle.
            # SURTOUT PAS JSON.parse('{payload}') : une apostrophe dans le message
            # (« j'arrive ») cassait l'éval → notification silencieusement perdue.
            js = f"window.STEAMCORD.dispatchNotification({payload});"
            # Après un restart de Steam, le transport CDP peut être mort sans que
            # ws.closed le dise (« Cannot write to closing transport ») : retry en
            # rouvrant le tab, et la boucle NE MEURT JAMAIS — une notif ratée ne
            # doit pas tuer toutes les suivantes (c'est exactement ce qui arrivait).
            for attempt in range(3):
                try:
                    if attempt == 0:
                        await cls.shared_js_tab.ensure_open()
                    else:
                        cls.shared_js_tab = await get_tab("SharedJSContext")
                        await cls.shared_js_tab.open_websocket()
                    await cls.shared_js_tab.evaluate(js)
                    break
                except Exception as e:
                    logger.warning(f"notification dispatch attempt {attempt + 1}/3 failed: {e!r}")
                    await sleep(1)

    @classmethod
    async def connect_ws(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(f"window.STEAMCORD.connectWs()")

    @classmethod
    async def get_state(cls):
        return cls.evt_handler.build_state_dict()

    @classmethod
    async def login_with_token(cls, token: str):
        from tab_utils.cdp import get_tab
        tab = await get_tab("discord")
        if tab is None:
            return False
        await tab.open_websocket()
        result = await tab.evaluate(f"window.steamcordLoginWithToken({repr(token)})")
        await tab.close_websocket()
        return result in ("ok", "reload")

    @classmethod
    async def toggle_mute(cls):
        logger.info("Toggling mute")
        return await cls.evt_handler.toggle_mute(act=True)

    @classmethod
    async def toggle_deafen(cls):
        logger.info("Toggling deafen")
        return await cls.evt_handler.toggle_deafen(act=True)

    @classmethod
    async def disconnect_vc(cls):
        logger.info("Disconnecting vc")
        return await cls.evt_handler.disconnect_vc()

    @classmethod
    async def set_ptt(cls, value):
        await cls.evt_handler.send_client({"type": "$ptt", "value": value})

    @classmethod
    async def enable_ptt(cls, enabled):
        await cls.evt_handler.send_client({"type": "$setptt", "enabled": enabled})

    # Rich Presence (issue #11) : mémorisé pour re-pousser à chaque (re)connexion
    # du client (Vesktop redémarre à la bascule Bureau↔gamemode et une activité
    # LOCAL_ACTIVITY_UPDATE ne survit pas au reload). started_at ne change que
    # quand le JEU change → le « temps de jeu écoulé » ne repart pas de zéro à
    # chaque reconnexion.
    _rpc_game = None
    _rpc_since = None
    # Préférence « afficher le jeu en cours sur Discord » (QAM → Config).
    # Persistée en JSON comme steamcord-input.json ; None = pas encore chargée.
    _RPC_CFG = os.path.expanduser("~/.config/steamcord-rpc.json")
    _rpc_enabled = None

    @classmethod
    def _rpc_pref(cls):
        if cls._rpc_enabled is None:
            from json import load
            try:
                with open(cls._RPC_CFG) as f:
                    cls._rpc_enabled = bool(load(f).get("enabled", True))
            except Exception:
                cls._rpc_enabled = True
        return cls._rpc_enabled

    @classmethod
    async def get_rpc_enabled(cls):
        return cls._rpc_pref()

    @classmethod
    async def set_rpc_enabled(cls, enabled):
        from json import dump
        cls._rpc_enabled = bool(enabled)
        try:
            os.makedirs(os.path.dirname(cls._RPC_CFG), exist_ok=True)
            with open(cls._RPC_CFG, "w") as f:
                dump({"enabled": cls._rpc_enabled}, f)
        except Exception as e:
            logger.warning(f"save rpc cfg failed: {e!r}")
        # Application immédiate : OFF efface l'activité affichée, ON rejoue le
        # jeu courant (toujours mémorisé, même préférence coupée).
        try:
            await cls.evt_handler.send_client(
                {"type": "$rpc",
                 "game": cls._rpc_game if cls._rpc_enabled else None,
                 "started_at": cls._rpc_since if cls._rpc_enabled else None})
        except Exception:
            pass
        return True

    @classmethod
    async def set_rpc(cls, game):
        logger.info("Setting RPC")
        if game != cls._rpc_game:
            from time import time as _now
            cls._rpc_game = game
            cls._rpc_since = int(_now() * 1000) if game else None
        if not cls._rpc_pref():
            return
        await cls.evt_handler.send_client(
            {"type": "$rpc", "game": cls._rpc_game, "started_at": cls._rpc_since})

    @classmethod
    async def set_user_volume(cls, user_id, volume, context="default"):
        await cls.evt_handler.send_client({"type": "$set_user_volume", "id": user_id, "volume": volume, "context": context})

    @classmethod
    async def get_user_volume(cls, user_id, context="default"):
        # Vérité moteur (MediaEngineStore.getLocalVolume) : le QAM relit le
        # volume au montage au lieu de retomber sur 100 % (issue #5). Un vieux
        # client déjà en page ne connaît pas $get_user_volume → toute réponse
        # non numérique retombe sur 100 (le défaut visuel d'avant).
        r = await cls.evt_handler.api.get_user_volume(user_id, context)
        return r if isinstance(r, (int, float)) and not isinstance(r, bool) else 100

    @classmethod
    async def set_discord_status(cls, status):
        # status: "online" | "idle" | "dnd" | "invisible"
        await cls.evt_handler.send_client({"type": "$set_status", "status": status})

    @classmethod
    async def get_discord_status(cls):
        return await cls.evt_handler.api._store_access_request("$get_status")

    @classmethod
    async def get_last_channels(cls):
        return await cls.evt_handler.api.get_last_channels()

    @classmethod
    async def post_screenshot(cls, channel_id, data):
        logger.info("Posting screenshot to " + channel_id)
        r = await cls.evt_handler.api.post_screenshot(channel_id, data)

        if r:
            return True

        payload = dumps({"title": "Steamcord", "body": "Error while posting screenshot"})
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(
            f"DeckyPluginLoader.toaster.toast(JSON.parse('{payload}'));"
        )

    @classmethod
    async def get_screen_bounds(cls):
        return await cls.evt_handler.api.get_screen_bounds()

    # Réordonner/masquer des serveurs (issue #18) : préférences 100% LOCALES à
    # Steamcord, PAS le tri natif Discord. Vérifié en vrai (redémarrage complet
    # de Vesktop) : GUILD_MOVE_BY_ID (le mécanisme du glisser-déposer natif)
    # met à jour l'arbre en mémoire du client MAIS ne persiste JAMAIS côté
    # compte — l'ordre revenait comme avant après reload. Portage sur nos
    # propres fichiers = vraiment permanent, et on n'a pas besoin de
    # reproduire la synchro settings-proto de Discord (protobuf, fragile).
    _GUILD_ORDER_CFG = os.path.expanduser("~/.config/steamcord-guild-order.json")
    _HIDDEN_GUILDS_CFG = os.path.expanduser("~/.config/steamcord-hidden-guilds.json")
    _guild_order = None
    _hidden_guilds = None

    @staticmethod
    def _load_json_list(path, key):
        from json import load
        try:
            with open(path) as f:
                return list(load(f).get(key, []))
        except Exception:
            return []

    @staticmethod
    def _save_json_list(path, key, values):
        from json import dump
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                dump({key: values}, f)
        except Exception as e:
            logger.warning(f"save {path} failed: {e!r}")

    @classmethod
    def _guild_order_list(cls):
        if cls._guild_order is None:
            cls._guild_order = cls._load_json_list(cls._GUILD_ORDER_CFG, "order")
        return cls._guild_order

    @classmethod
    def _hidden_guilds_set(cls):
        if cls._hidden_guilds is None:
            cls._hidden_guilds = set(cls._load_json_list(cls._HIDDEN_GUILDS_CFG, "ids"))
        return cls._hidden_guilds

    @classmethod
    async def set_guild_order(cls, ordered_ids):
        cls._guild_order = [str(g) for g in ordered_ids] if isinstance(ordered_ids, list) else []
        cls._save_json_list(cls._GUILD_ORDER_CFG, "order", cls._guild_order)
        return True

    @classmethod
    async def set_guild_hidden(cls, guild_id, hidden):
        ids = cls._hidden_guilds_set()
        if hidden:
            ids.add(str(guild_id))
        else:
            ids.discard(str(guild_id))
        cls._save_json_list(cls._HIDDEN_GUILDS_CFG, "ids", sorted(ids))
        return True

    @classmethod
    async def get_guilds_vc(cls, include_hidden=False):
        guilds = await cls.evt_handler.api.get_guilds_vc()
        if not isinstance(guilds, list):
            return guilds
        hidden = cls._hidden_guilds_set()
        order = cls._guild_order_list()
        # Un serveur PAS dans `order` (nouveau, jamais réordonné, ou qu'on a
        # quitté depuis) atterrit après ceux explicitement ordonnés, dans son
        # ordre naturel Discord — jamais perdu, jamais planté par une entrée
        # périmée (le dict `present` filtre silencieusement les ids qui ne
        # correspondent plus à un serveur actuel).
        present = {g.get("id"): g for g in guilds if isinstance(g, dict) and g.get("id")}
        ordered = [present[gid] for gid in order if gid in present]
        ordered_ids = {g.get("id") for g in ordered}
        rest = [g for g in guilds if g.get("id") not in ordered_ids]
        merged = ordered + rest
        for g in merged:
            g["hidden"] = g.get("id") in hidden
        return merged if include_hidden else [g for g in merged if not g["hidden"]]

    @classmethod
    async def join_vc(cls, channel_id, guild_id):
        return await cls.evt_handler.api.join_vc(channel_id, guild_id)

    @classmethod
    async def get_dm_channels(cls):
        return await cls.evt_handler.api.get_dm_channels()

    @classmethod
    async def dm_call(cls, channel_id, join_existing=False):
        return await cls.evt_handler.api.dm_call(channel_id, join_existing)

    @classmethod
    async def get_text_channels(cls):
        return await cls.evt_handler.api.get_text_channels()

    @classmethod
    async def get_messages(cls, channel_id, before=None):
        return await cls.evt_handler.api.get_messages(channel_id, before)

    @classmethod
    async def send_message(cls, channel_id, content, reply_to=None):
        return await cls.evt_handler.api.send_message(channel_id, content, reply_to)

    @classmethod
    async def send_typing(cls, channel_id):
        return await cls.evt_handler.api.send_typing(channel_id)

    @classmethod
    async def edit_message(cls, channel_id, message_id, content):
        return await cls.evt_handler.api.edit_message(channel_id, message_id, content)

    @classmethod
    async def delete_message(cls, channel_id, message_id):
        return await cls.evt_handler.api.delete_message(channel_id, message_id)

    @classmethod
    async def add_reaction(cls, channel_id, message_id, emoji):
        return await cls.evt_handler.api.add_reaction(channel_id, message_id, emoji)

    @classmethod
    async def remove_reaction(cls, channel_id, message_id, emoji):
        return await cls.evt_handler.api.remove_reaction(channel_id, message_id, emoji)

    @classmethod
    async def get_soundboard_sounds(cls):
        return await cls.evt_handler.api.get_soundboard_sounds()

    @classmethod
    async def play_soundboard_sound(cls, sound_id, source_guild_id=None):
        return await cls.evt_handler.api.play_soundboard_sound(sound_id, source_guild_id)

    @classmethod
    async def get_local_mute(cls, user_id):
        r = await cls.evt_handler.api.get_local_mute(user_id)
        # Le client (ancien, déjà en page) renvoie `false` coercé en `{}` via
        # `result || {}` → le frontend ferait `!!{}` = true = muet à tort. Seul un
        # vrai `True` = réellement muté localement. On normalise ici → fix immédiat
        # sans dépendre d'une ré-injection du client.
        return r is True

    @classmethod
    async def toggle_local_mute(cls, user_id):
        return await cls.evt_handler.api.toggle_local_mute(user_id)

    @classmethod
    async def set_local_mute(cls, user_id, muted):
        return await cls.evt_handler.api.set_local_mute(user_id, muted)

    @classmethod
    async def get_audio_processing(cls):
        r = await cls.evt_handler.api.get_audio_processing()
        # Client indisponible (reconnexion…) : montrer au moins les prefs
        # persistées plutôt que des défauts trompeurs (issue #14).
        if (not isinstance(r, dict) or r.get("error")) and cls._mic_prefs:
            return {"noise": cls._mic_prefs.get("noise", "krisp"),
                    "echoCancellation": cls._mic_prefs.get("echoCancellation", True),
                    "automaticGainControl": cls._mic_prefs.get("automaticGainControl", True)}
        return r

    @classmethod
    async def set_noise_reduction(cls, mode):
        cls._mic_prefs["noise"] = mode
        cls._save_audio_cfg()
        return await cls.evt_handler.api.set_noise_reduction(mode)

    @classmethod
    async def set_echo_cancellation(cls, enabled):
        cls._mic_prefs["echoCancellation"] = bool(enabled)
        cls._save_audio_cfg()
        return await cls.evt_handler.api.set_echo_cancellation(enabled)

    @classmethod
    async def set_automatic_gain_control(cls, enabled):
        cls._mic_prefs["automaticGainControl"] = bool(enabled)
        cls._save_audio_cfg()
        return await cls.evt_handler.api.set_automatic_gain_control(enabled)

    @classmethod
    async def _apply_mic_prefs(cls):
        """Ré-asserte les réglages micro persistés (appelé à chaque login du
        client Discord) : le plugin est la source de vérité, les défauts ne
        peuvent plus « revenir » après un restart (issue #14)."""
        prefs = dict(cls._mic_prefs)
        if not prefs:
            return
        try:
            if "noise" in prefs:
                await cls.evt_handler.api.set_noise_reduction(prefs["noise"])
            if "echoCancellation" in prefs:
                await cls.evt_handler.api.set_echo_cancellation(bool(prefs["echoCancellation"]))
            if "automaticGainControl" in prefs:
                await cls.evt_handler.api.set_automatic_gain_control(bool(prefs["automaticGainControl"]))
            logger.info(f"mic prefs re-asserted: {prefs}")
        except Exception as e:
            logger.warning(f"mic prefs reassert failed: {e!r}")

    @classmethod
    async def _screen_diag(cls):
        # Diagnostic capture d'écran : log périodiquement si on est en mode JEU
        # (gamescope) et quels nodes vidéo PipeWire existent. Tourne dans plugin_loader
        # (survit aux changements de mode) → capture l'état mode jeu même offline.
        from json import loads
        import vesktop
        while True:
            try:
                # -x avec les deux noms : le comm du compositeur est `gamescope-wl`
                # sur Bazzite (gamescope tout court sur SteamOS) — avec le seul
                # `gamescope`, ce log disait False alors qu'on était en mode jeu.
                g = await create_subprocess_exec("pgrep", "-x", "gamescope(-wl)?",
                                                 stdout=DEVNULL, stderr=DEVNULL)
                in_game = (await g.wait()) == 0
                vids = []
                try:
                    p = await create_subprocess_exec("pw-dump", stdout=PIPE, stderr=DEVNULL, env=vesktop._user_env())
                    # Timeout court : cette boucle tourne toutes les 15s, un
                    # PipeWire wedgé empilerait un pw-dump pendu par tour (6
                    # observés le 19/07). Le timeout sert aussi de DÉTECTEUR :
                    # on prévient l'utilisateur une fois (seul remède connu =
                    # redémarrer la session gamescope, le node écran ne survit
                    # pas à un restart de pipewire seul).
                    try:
                        out, _ = await wait_for(p.communicate(), 5)
                    except Exception:
                        try:
                            p.kill()
                        except ProcessLookupError:
                            pass
                        logger.warning("[screendiag] pw-dump muet après 5s — PipeWire ne répond plus")
                        if not getattr(cls, "_pw_wedge_toasted", False):
                            cls._pw_wedge_toasted = True
                            await cls._toast("Steamcord",
                                             "Audio system (PipeWire) stopped responding — "
                                             "restart the console to recover streaming/audio.")
                        await sleep(15)
                        continue
                    cls._pw_wedge_toasted = False
                    for n in loads(out.decode() or "[]"):
                        if not str(n.get("type", "")).endswith("Node"):
                            continue
                        pr = (n.get("info", {}) or {}).get("props", {}) or {}
                        mc = str(pr.get("media.class", "")); nm = str(pr.get("node.name", ""))
                        if "Video" in mc or "gamescope" in (nm + mc).lower() or "screen" in nm.lower():
                            vids.append(f"{n.get('id')}:{nm}:{mc}")
                except Exception as e:
                    vids = [f"pw-dump err {e!r}"]
                logger.info(f"[screendiag] gamescope={in_game} video_nodes={vids}")
            except Exception as e:
                logger.warning(f"[screendiag] {e!r}")
            await sleep(15)

    @classmethod
    async def logout_discord(cls):
        # Déconnexion totale de Discord (invalide le token + retour login/QR).
        await cls.evt_handler.send_client({"type": "$logout"})

    # ── Sélection des périphériques audio (sortie/entrée) pour Discord ──────────
    # Discord/Vesktop ne voit que "Default" en headless → on pilote au niveau
    # SYSTÈME via PipeWire (pactl), en routant les flux de Vesktop par-application.
    # Ça permet p.ex. d'envoyer le son Discord UNIQUEMENT vers le casque.
    @classmethod
    async def _pactl(cls, *args, want_json=False):
        import vesktop
        pre = ("-f", "json") if want_json else ()
        p = await create_subprocess_exec("pactl", *pre, *args, stdout=PIPE, stderr=DEVNULL, env=vesktop._user_env())
        # ⚠ pactl pend indéfiniment quand PipeWire n'enregistre plus de clients
        # (wedge du 19/07) : sans timeout, le _golive_lock resterait pris pour
        # toujours et plus aucun go_live/stop ne passerait. "" est sûr pour tous
        # les appelants (strip() / loads(x or "[]")).
        try:
            out, _ = await wait_for(p.communicate(), 5)
        except Exception:
            try:
                p.kill()
            except ProcessLookupError:
                pass
            logger.warning(f"pactl {' '.join(args[:2])}: muet après 5s — PipeWire ne répond plus ?")
            return ""
        return out.decode()

    @classmethod
    async def get_stream_volume(cls):
        # Volume BROADCAST du Go Live = volume de la source virtuelle venmic
        # (vencord-screen-share, null-audio-sink avec channelVolumes) : atténue
        # ce que les SPECTATEURS entendent. Régler son propre volume « stream »
        # côté Discord est IGNORÉ par le moteur (on n'entend pas son propre
        # live) — c'était le slider fantôme qui retombait à 18 %.
        from json import loads
        try:
            for s in loads(await cls._pactl("list", "sources", want_json=True) or "[]"):
                if s.get("name") == "vencord-screen-share":
                    for v in (s.get("volume") or {}).values():
                        pct = str(v.get("value_percent", "")).rstrip("%")
                        if pct.isdigit():
                            return int(pct)
        except Exception:
            pass
        return None

    @classmethod
    async def set_stream_volume(cls, volume):
        try:
            v = max(0, min(100, int(volume)))
            await cls._pactl("set-source-volume", "vencord-screen-share", f"{v}%")
            return True
        except Exception:
            return False

    @staticmethod
    def _dev_label(d):
        desc = d.get("description")
        return desc if desc and desc != "(null)" else d.get("name", "")

    @classmethod
    async def get_audio_devices(cls):
        from json import loads
        try:
            sinks = loads(await cls._pactl("list", "sinks", want_json=True) or "[]")
            sources = loads(await cls._pactl("list", "sources", want_json=True) or "[]")
            def_sink = (await cls._pactl("get-default-sink")).strip()
            def_source = (await cls._pactl("get-default-source")).strip()
        except Exception as e:
            return {"error": str(e)}
        outputs = [{"name": s.get("name", ""), "label": cls._dev_label(s)} for s in sinks]
        # Entrées : exclure les monitors (rebouclage de sortie, pas un vrai micro).
        inputs = [{"name": s.get("name", ""), "label": cls._dev_label(s)}
                  for s in sources if not s.get("name", "").endswith(".monitor")]
        return {
            "outputs": outputs, "inputs": inputs,
            "default_output": def_sink, "default_input": def_source,
            "selected_output": cls._audio_out or "auto",
            "selected_input": cls._audio_in or "auto",
        }

    @classmethod
    async def set_audio_output(cls, name):
        cls._audio_out = None if name in (None, "auto") else name
        cls._save_audio_cfg()
        if cls._audio_out is None and not cls._ga_active:
            # Retour « Auto » : _apply_audio_routing ne touche pas aux flux
            # quand la cible est None → sans ce reset ils restaient collés au
            # dernier choix manuel (issue #14).
            await cls._reset_vesktop_routing(outputs=True)
        await cls._apply_audio_routing()
        return True

    @classmethod
    async def set_audio_input(cls, name):
        cls._audio_in = None if name in (None, "auto") else name
        cls._save_audio_cfg()
        if cls._audio_in is None and not cls._ga_active:
            await cls._reset_vesktop_routing(inputs=True)
        await cls._apply_audio_routing()
        return True

    @classmethod
    async def _reset_vesktop_routing(cls, outputs=False, inputs=False):
        """Ramène les flux Vesktop sur le périphérique système par défaut
        (@DEFAULT_SINK@/@DEFAULT_SOURCE@ sont résolus par pactl)."""
        from json import loads
        try:
            if outputs:
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(si):
                        await cls._pactl("move-sink-input", str(si.get("index")), "@DEFAULT_SINK@")
            if inputs:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), "@DEFAULT_SOURCE@")
        except Exception as e:
            logger.warning(f"audio routing reset failed: {e!r}")

    @staticmethod
    def _is_vesktop_stream(s):
        props = s.get("properties", {}) or {}
        blob = " ".join(str(v) for v in props.values()).lower()
        return ("vesktop" in blob) or ("discord" in blob) or ("electron" in blob)

    @classmethod
    async def _apply_audio_routing(cls):
        from json import loads
        out_target = cls._audio_out
        in_target = cls._audio_in
        if cls._ga_active:
            # Partage audio jeu : Vesktop ÉCOUTE sur la vraie sortie (surtout pas le
            # sink jeu, sinon la voix des autres repartirait dans le mix = écho) et
            # CAPTURE le mix micro+jeu à la place du micro.
            out_target = out_target or cls._ga_real_sink
            in_target = "steamcord_mic"
        try:
            if out_target or cls._ga_active:
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(si):
                        if out_target:
                            await cls._pactl("move-sink-input", str(si.get("index")), out_target)
                    elif cls._ga_active and str(si.get("owner_module", "")) not in cls._ga_modules:
                        # Tout le reste (jeu, système) joue dans le sink jeu — les
                        # nouveaux flux y vont déjà (default sink), ceci rattrape les
                        # apps qui ciblent un sink explicite. Move idempotent.
                        await cls._pactl("move-sink-input", str(si.get("index")), "steamcord_game")
            if in_target:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), in_target)
        except Exception as e:
            logger.warning(f"audio routing failed: {e!r}")

    @classmethod
    async def _audio_routing_watcher(cls):
        # Les flux Vesktop apparaissent/disparaissent (à chaque appel) → on ré-applique
        # le routage périodiquement pour qu'un nouveau flux suive le choix de l'user.
        while True:
            try:
                if cls._audio_out or cls._audio_in or cls._ga_active:
                    await cls._apply_audio_routing()
            except Exception:
                pass
            await sleep(4)

    @classmethod
    def _load_audio_cfg(cls):
        from json import load
        try:
            with open(cls._AUDIO_CFG) as f:
                cfg = load(f)
            cls._audio_out = cfg.get("output") or None
            cls._audio_in = cfg.get("input") or None
            if isinstance(cfg.get("mic"), dict):
                cls._mic_prefs = cfg["mic"]
            if isinstance(cfg.get("ga_vol"), dict):
                cls._ga_vol.update({k: int(v) for k, v in cfg["ga_vol"].items()
                                    if k in cls._ga_vol})
        except Exception:
            pass

    @classmethod
    def _save_audio_cfg(cls):
        from json import dump
        try:
            os.makedirs(os.path.dirname(cls._AUDIO_CFG), exist_ok=True)
            with open(cls._AUDIO_CFG, "w") as f:
                dump({"output": cls._audio_out, "input": cls._audio_in,
                      "mic": cls._mic_prefs, "ga_vol": cls._ga_vol}, f)
        except Exception as e:
            logger.warning(f"save audio cfg failed: {e!r}")

    # ── Raccourci manette vocal (mute-toggle / push-to-talk) ──
    # La détection des boutons vit dans le FRONTEND (SteamClient.Input) ; ici
    # on ne fait que persister la config pour qu'elle survive aux reboots.
    _INPUT_CFG = os.path.expanduser("~/.config/steamcord-input.json")

    @classmethod
    async def get_voice_shortcut(cls):
        from json import load
        try:
            with open(cls._INPUT_CFG) as f:
                return load(f)
        except Exception:
            return {"enabled": False, "mode": "toggle", "buttons": [],
                    "label": ""}

    @classmethod
    async def set_voice_shortcut(cls, cfg):
        from json import dump
        try:
            os.makedirs(os.path.dirname(cls._INPUT_CFG), exist_ok=True)
            with open(cls._INPUT_CFG, "w") as f:
                dump(cfg, f)
            return True
        except Exception as e:
            logger.warning(f"save input cfg failed: {e!r}")
            return False

    @classmethod
    async def _ensure_screenshare_deps(cls):
        # gst_webrtc.py tourne sous le python SYSTÈME (requis pour les bindings
        # GStreamer `gi`, absents du python embarqué du plugin). Sur une machine fraîche
        # cet interpréteur n'a pas aiohttp → partage d'écran muet. On l'installe
        # automatiquement en user-site (sans root) → plugin self-contained sur toute BC-250.
        import vesktop
        env = vesktop._user_env()
        try:
            check = await create_subprocess_exec(
                sys_python(), "-c", "import aiohttp, aiohttp_cors",
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            if (await check.wait()) == 0:
                return
            logger.info("Screen-share deps missing — installing aiohttp (user-site) for system python…")
            proc = await create_subprocess_exec(
                sys_python(), "-m", "pip", "install", "--user", "--quiet",
                "aiohttp", "aiohttp_cors",
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            await proc.wait()
        except Exception as e:
            logger.warning(f"Screen-share deps auto-install failed: {e!r}")

    # ── Micro pendant le Go Live : silence si aucun vrai micro ────────────────
    # Sans micro branché, la source par défaut est le MONITOR de la sortie
    # (BC-250 : hdmi-stereo.monitor) → le canal VOIX diffuse tout le son système
    # (jeu, bips/artefacts HDMI, écho des voix des autres), EN DOUBLE du
    # soundshare venmic du stream, et le volume du live n'y peut rien (constaté
    # 19/07). Pendant un Go Live sans vrai micro : capture voix de Vesktop
    # basculée sur le monitor d'un null-sink muet → seul le stream porte l'audio
    # (contrôlable par son volume). Un vrai micro branché = on ne touche à rien.
    _golive_silence_restore = None   # source à restaurer au stop (None = inactif)

    @classmethod
    async def _golive_mic_silence(cls, enable):
        from json import loads
        try:
            if enable:
                if cls._ga_active or cls._golive_silence_restore is not None:
                    return  # partage "son du jeu" actif (il gère la source) ou déjà posé
                src = (await cls._pactl("get-default-source")).strip()
                if not src.endswith(".monitor") or "steamcord_" in src:
                    return  # vrai micro (ou déjà un de nos montages) → ne rien toucher
                out = (await cls._pactl(
                    "load-module", "module-null-sink", "sink_name=steamcord_silence",
                    "sink_properties=device.description=Steamcord-Silence")).strip()
                if not out.isdigit():
                    raise Exception(f"load-module: {out!r}")
                cls._golive_silence_restore = src
                await cls._pactl("set-default-source", "steamcord_silence.monitor")
                # Basculer aussi les captures voix DÉJÀ ouvertes de Vesktop qui
                # pompent l'ancien monitor (le RecordStream venmic vise
                # vencord-screen-share, pas le monitor → naturellement épargné).
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")),
                                         "steamcord_silence.monitor")
                logger.info(f"[golive] pas de vrai micro ({src}) → capture voix "
                            "silencieuse pendant le stream")
            else:
                if cls._golive_silence_restore is None:
                    return
                src = cls._golive_silence_restore
                cls._golive_silence_restore = None
                await cls._pactl("set-default-source", src)
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), src)
                # unload via la purge par nom (steamcord_silence) — idempotent,
                # couvre aussi le cas restart plugin_loader (module survivant).
                for line in (await cls._pactl("list", "modules", "short")).splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 3 and "steamcord_silence" in parts[2]:
                        await cls._pactl("unload-module", parts[0])
                logger.info("[golive] capture voix restaurée")
        except Exception as e:
            logger.warning(f"[golive] mic-silence({enable}): {e!r}")

    # Sérialise start/stop (issue #12) : un stop→start rapproché faisait courir
    # la restauration pactl de _golive_mic_silence(False) EN MÊME TEMPS que le
    # montage de (True) → la purge par nom déchargeait le null-sink tout neuf et
    # la source par défaut pointait dans le vide (plus de capture voix, et selon
    # l'OS des clients pulse coincés). Un seul verrou = séquences entières,
    # jamais entrelacées.
    _golive_seq_lock = None

    @classmethod
    def _golive_lock(cls):
        if cls._golive_seq_lock is None:
            from asyncio import Lock
            cls._golive_seq_lock = Lock()
        return cls._golive_seq_lock

    @classmethod
    async def go_live(cls):
        async with cls._golive_lock():
            await cls._golive_mic_silence(True)
            await cls.evt_handler.send_client({"type": "$golive", "stop": False})

    @classmethod
    async def stop_go_live(cls):
        async with cls._golive_lock():
            await cls.evt_handler.send_client({"type": "$golive", "stop": True})
            await cls._golive_mic_silence(False)

    # ── Partage d'écran via CAMÉRA virtuelle (contournement gamescope) ──────────
    # gamescope n'a pas de portail → Go Live (getDisplayMedia) = écran noir. À la
    # place : gst_camera.py capture le node PipeWire gamescope → /dev/video42
    # (v4l2loopback), que Discord utilise comme caméra. Voir gst_camera.py + client.
    @classmethod
    async def start_screen_camera(cls):
        import os
        from pathlib import Path as _P
        if not os.path.exists("/dev/video42"):
            info = await cls._v4l2_hint()
            logger.warning(f"[gstcam] /dev/video42 absent — {info['hint']}")
            return {"ok": False, **info}
        info = await cls._gst_python_hint()
        if info:
            logger.warning(f"[gstcam] {info['hint']}")
            return {"ok": False, **info}
        # Tuer un feeder précédent puis (re)lancer.
        try:
            import vesktop
            killer = await create_subprocess_exec("pkill", "-f", "gst_camera.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
            await sleep(0.5)
        except Exception:
            pass
        script = _P(DECKY_PLUGIN_DIR) / "gst_camera.py"
        if not script.exists():
            script = _P(DECKY_PLUGIN_DIR) / "defaults" / "gst_camera.py"
        cls.camera_feeder = await create_subprocess_exec(
            sys_python(),
            str(script),
            env=getattr(cls, "_gst_env", None) or dict(os.environ),
            stdout=PIPE, stderr=PIPE,
        )
        create_task(stream_watcher(cls.camera_feeder.stdout, prefix="[gstcam]"))
        create_task(stream_watcher(cls.camera_feeder.stderr, True, prefix="[gstcam]"))
        # Laisser le pipeline s'établir avant de sélectionner la caméra côté Discord.
        await sleep(2)
        await cls.evt_handler.send_client({"type": "$screen_camera", "stop": False})
        return {"ok": True}

    # ── stand-alone : une seule version pour tous les OS ────────────────────────
    # Le plugin vérifie ce que la machine a et dit exactement quoi installer.
    # Les hints sont STRUCTURÉS ({code, cmd, hint}) : le front traduit `code` via
    # l'i18n 9 langues et affiche `cmd` verbatim ; `hint` = phrase anglaise pour
    # les logs (issue #2 : le texte français codé en dur arrivait tel quel chez
    # un utilisateur en portugais).
    @staticmethod
    def _pkg_hint(arch, fedora, debian):
        import shutil as _sh
        if _sh.which("pacman"):
            return f"sudo pacman -S {arch}"
        if _sh.which("rpm-ostree"):
            return f"rpm-ostree install {fedora}"
        if _sh.which("dnf"):
            return f"sudo dnf install {fedora}"
        if _sh.which("zypper"):
            return f"sudo zypper install {fedora}"
        if _sh.which("apt"):
            return f"sudo apt install {debian}"
        return f"install: {arch}"

    @staticmethod
    def _is_steamos():
        # SteamOS stock : rootfs lecture seule, pas de headers noyau, et les MAJ
        # OS effacent les paquets ajoutés → « sudo pacman -S … » y est un faux
        # conseil, on renvoie un code dédié à la place.
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    if line.strip().startswith("ID="):
                        return line.split("=", 1)[1].strip().strip('"') == "steamos"
        except Exception:
            pass
        return False

    _gst_py_ok = False                    # cache : bindings gi/Gst OK (positif seulement)

    @classmethod
    async def _gst_python_hint(cls):
        """None si le python système a gi + Gst + pipewiresrc (requis par
        gst_camera.py), sinon {code, cmd, hint} pour cet OS. Présents sur
        Bazzite/SteamOS, pas sur Arch/Fedora/Debian de base."""
        if cls._gst_py_ok:
            return None
        import vesktop
        try:
            p = await create_subprocess_exec(
                sys_python(), "-c",
                "import gi; gi.require_version('Gst','1.0'); "
                "from gi.repository import Gst; Gst.init(None); "
                "raise SystemExit(0 if Gst.ElementFactory.find('pipewiresrc') else 1)",
                stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            if (await p.wait()) == 0:
                cls._gst_py_ok = True
                return None
        except Exception:
            pass
        cmd = cls._pkg_hint("python-gobject gst-plugin-pipewire",
                            "python3-gobject pipewire-gstreamer",
                            "python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire")
        return {"code": "gst_missing", "cmd": cmd,
                "hint": f"GStreamer/PipeWire Python bindings missing for capture: {cmd}"}

    _MODPROBE = ("sudo modprobe v4l2loopback video_nr=42 "
                 "card_label=Steamcord exclusive_caps=1")

    # Un simple modprobe NE SUFFIT PAS quand le module est déjà chargé sans
    # video_nr=42 (issue #9 : Bazzite charge v4l2loopback en « OBS Virtual
    # Camera » via /usr/lib/modprobe.d/20-akmods.conf) : modprobe sort alors 0
    # EN SILENCE sans rien changer et /dev/video42 n'apparaît jamais — le user
    # relance la commande en boucle sans comprendre. Il faut décharger d'abord.
    # On donne donc un bloc unique qui vaut pour les deux cas (pas chargé /
    # mal chargé) ET qui persiste au reboot : sans les fichiers de conf le
    # module ne revient pas au boot suivant et le problème recommence.
    # « || true » sur le déchargement : il ÉCHOUE quand le module n'est pas
    # chargé (cas le plus fréquent) et, sous set -e, ferait quitter le script
    # avant même d'avoir rien fait.
    _MODPROBE_FIX = (
        "sudo modprobe -r v4l2loopback 2>/dev/null || true\n"
        "echo 'options v4l2loopback exclusive_caps=1 card_label=\"Steamcord Screen\" "
        "video_nr=42' | sudo tee /etc/modprobe.d/99-steamcord-v4l2loopback.conf\n"
        "echo v4l2loopback | sudo tee /etc/modules-load.d/steamcord-v4l2loopback.conf\n"
        "sudo modprobe v4l2loopback")

    _FIX_SCRIPT = "steamcord-fix-v4l2.sh"

    @classmethod
    def _write_v4l2_fix_script(cls, extra=""):
        """Écrit un script prêt à lancer dans le home et renvoie la commande à
        afficher. Le hint part dans un TOAST de chat Steam : un bloc de 4 lignes
        y serait tronqué et n'est de toute façon pas copiable en mode jeu → on
        n'affiche qu'un « bash ~/steamcord-fix-v4l2.sh ». Le plugin tourne en
        user (pas root) : il ne peut pas charger le module lui-même, mais il
        peut parfaitement déposer le script, qui demandera sudo au lancement.
        Renvoie None si l'écriture échoue (home en lecture seule) → l'appelant
        retombe sur les commandes en clair."""
        from pathlib import Path
        body = "\n".join(l for l in (extra, cls._MODPROBE_FIX) if l)
        # Script en ANGLAIS : il part chez tous les users, quelle que soit la
        # langue du QAM. Pas d'apostrophe dans les chaînes quotées en simple.
        script = (
            "#!/usr/bin/env bash\n"
            "# Generated by Steamcord.\n"
            "# Enables the /dev/video42 virtual webcam used for game-mode screen\n"
            "# share, and makes it survive reboots. Safe to re-run.\n"
            "set -e\n"
            + body + "\n"
            # Sans attendre udev, le ls affiche « crw------- root root » (règles
            # pas encore appliquées) : ça a l'air cassé alors que le device est
            # bon une seconde plus tard (crw-rw---- root video + ACL du user).
            "sudo udevadm settle 2>/dev/null || sleep 1\n"
            "echo\n"
            # Le déchargement peut avoir échoué silencieusement si une autre app
            # tient le module (OBS, Sunshine) : on le dit au lieu de laisser un
            # « ls: no such file » sec.
            "ls -l /dev/video42 || { echo \"Still no /dev/video42: something is "
            "still using v4l2loopback (OBS, Sunshine, a browser tab with the "
            "virtual camera). Close it and re-run this script, or reboot.\"; "
            "exit 1; }\n"
            'echo "Done - screen share is ready."\n')
        try:
            p = Path.home() / cls._FIX_SCRIPT
            p.write_text(script)
            p.chmod(0o755)
            return f"bash ~/{cls._FIX_SCRIPT}"
        except Exception as e:
            logger.warning(f"[v4l2] script de correction non écrit: {e}")
            return None

    @staticmethod
    def _v4l2_loaded():
        """(chargé?, expose /dev/video42?) d'après sysfs — pas de lsmod à parser."""
        import os
        if not os.path.exists("/sys/module/v4l2loopback"):
            return False, False
        try:
            with open("/sys/module/v4l2loopback/parameters/video_nr") as f:
                nrs = [n.strip() for n in f.read().split(",")]
            return True, "42" in nrs
        except Exception:
            return True, False

    @classmethod
    async def _v4l2_hint(cls):
        """Distingue « module pas installé » (installer le paquet — ou SteamOS,
        où c'est impossible proprement), « installé mais pas chargé » et
        « chargé mais sans /dev/video42 » (une autre app l'a chargé en premier)
        pour donner LA bonne commande. Appelé quand /dev/video42 est absent."""
        loaded, has42 = cls._v4l2_loaded()
        if loaded:
            # has42 vrai ici = module configuré pour 42 mais device absent quand
            # même (cas tordu) : la même séquence de rechargement le répare.
            return {"code": "v4l2_wrong_device",
                    "cmd": cls._write_v4l2_fix_script() or cls._MODPROBE_FIX,
                    "hint": "v4l2loopback is loaded without the /dev/video42 device "
                            "Steamcord needs (another app loaded it first); a plain "
                            "modprobe is a silent no-op — unload it first: "
                            + cls._MODPROBE_FIX.replace("\n", " ; ")}
        try:
            p = await create_subprocess_exec("modinfo", "v4l2loopback",
                                             stdout=DEVNULL, stderr=DEVNULL)
            installed = (await p.wait()) == 0
        except Exception:
            installed = False
        if installed:
            return {"code": "v4l2_not_loaded",
                    "cmd": cls._write_v4l2_fix_script() or cls._MODPROBE_FIX,
                    "hint": f"v4l2loopback installed but not loaded: {cls._MODPROBE_FIX}"}
        if cls._is_steamos():
            return {"code": "v4l2_steamos", "cmd": "",
                    "hint": "v4l2loopback missing and stock SteamOS cannot keep it "
                            "across OS updates — screen share (game mode) unavailable"}
        pkg = cls._pkg_hint("v4l2loopback-dkms", "v4l2loopback", "v4l2loopback-dkms")
        # même bloc persistant après l'installation du paquet : un modprobe seul
        # ne survivrait pas au reboot (cf _MODPROBE_FIX).
        cmd = f"{pkg}\n{cls._MODPROBE_FIX}"
        return {"code": "v4l2_missing",
                "cmd": cls._write_v4l2_fix_script(extra=pkg) or cmd,
                "hint": f"v4l2loopback kernel module missing: {cmd}"}

    @classmethod
    async def stop_screen_camera(cls):
        import os
        try:
            await cls.evt_handler.send_client({"type": "$screen_camera", "stop": True})
        except Exception:
            pass
        try:
            import vesktop
            killer = await create_subprocess_exec("pkill", "-f", "gst_camera.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
        except Exception:
            pass
        if hasattr(cls, "camera_feeder") and cls.camera_feeder:
            try:
                cls.camera_feeder.kill()
                await cls.camera_feeder.wait()
            except Exception:
                pass
            cls.camera_feeder = None
        return True

    @classmethod
    async def get_camera_preview(cls):
        """Aperçu du partage écran pour le QAM : état du feeder + dernier JPEG.

        Le CEF de Steam n'a pas accès caméra en gamescope (getUserMedia échoue
        sur /dev/video42) → l'aperçu passe par les instantanés que gst_camera.py
        écrit toutes les 2s dans /tmp/steamcord-preview.jpg."""
        import base64
        import os
        import time as _t
        feeder = getattr(cls, "camera_feeder", None)
        running = feeder is not None and feeder.returncode is None
        jpg = ""
        path = "/tmp/steamcord-preview.jpg"
        try:
            if running and os.path.exists(path) and _t.time() - os.path.getmtime(path) < 6:
                with open(path, "rb") as f:
                    jpg = base64.b64encode(f.read()).decode()
        except Exception:
            jpg = ""
        return {"running": running, "jpg": jpg}

    # ── Aperçu du Go Live NATIF ──────────────────────────────────────────────
    # Quand le partage passe par le portail (portal_shim), la capture vit DANS
    # le Chromium de Vesktop → le QAM n'a aucune poignée sur le flux. Ce feeder
    # léger (gst_preview.py) capture le node gamescope → JPEG/2s, uniquement
    # tant que la tuile d'aperçu est montée (start au montage, stop au démontage).
    # Refcount + verrou (issue #12) : au flicker LIVE→pas LIVE→LIVE la tuile se
    # démonte/remonte en <1s, et le stop du 1er montage pouvait être traité APRÈS
    # le start du 2e → il tuait le feeder tout neuf et l'aperçu restait mort
    # (« Starting preview… » éternel). start/stop s'équilibrent ; on ne tue le
    # feeder que quand plus AUCUNE tuile n'est montée.
    _preview_seq_lock = None
    _preview_refs = 0
    _preview_fallback_task = None

    @classmethod
    def _preview_lock(cls):
        if cls._preview_seq_lock is None:
            from asyncio import Lock
            cls._preview_seq_lock = Lock()
        return cls._preview_seq_lock

    @classmethod
    def _preview_running(cls):
        proc = getattr(cls, "golive_preview", None)
        if proc is not None and proc.returncode is None:
            return True
        task = cls._preview_fallback_task
        return task is not None and not task.done()

    @classmethod
    async def _golive_preview_fallback(cls):
        """Aperçu SANS GStreamer (SteamOS stock, issue #12 : pas de
        gst-plugin-pipewire) : gamescopectl screenshot (instantané, natif
        gamescope) + ffmpeg pour la vignette JPEG. Les deux binaires sont dans
        l'image SteamOS de base — l'aperçu marche donc sur Deck stock."""
        import os
        import vesktop
        env = vesktop._user_env()
        raw = "/tmp/steamcord-golive-preview-raw.png"
        path = "/tmp/steamcord-golive-preview.jpg"
        try:
            while True:
                try:
                    try:
                        os.remove(raw)
                    except OSError:
                        pass
                    p = await create_subprocess_exec(
                        "gamescopectl", "screenshot", raw,
                        stdout=DEVNULL, stderr=DEVNULL, env=env)
                    await p.wait()
                    # gamescopectl rend la main tout de suite ; gamescope écrit
                    # le fichier juste après → on attend qu'il apparaisse et
                    # que sa taille se stabilise (PNG non atomique) plutôt
                    # qu'une grosse marge fixe (issue #12 : aperçu ~1 fps).
                    last = -1
                    for _ in range(12):
                        await sleep(0.1)
                        try:
                            size = os.path.getsize(raw)
                        except OSError:
                            continue
                        if size > 0 and size == last:
                            break
                        last = size
                    p = await create_subprocess_exec(
                        "ffmpeg", "-y", "-loglevel", "error", "-i", raw,
                        "-vf", "scale=640:-2", "-q:v", "7", path + ".tmp",
                        stdout=DEVNULL, stderr=DEVNULL, env=env)
                    await p.wait()
                    if os.path.exists(path + ".tmp"):
                        os.replace(path + ".tmp", path)
                except Exception as e:
                    logger.warning(f"[gstprev] fallback screenshot: {e!r}")
                await sleep(0.5)
        finally:
            for f in (raw, path, path + ".tmp"):
                try:
                    os.remove(f)
                except OSError:
                    pass

    @classmethod
    async def start_golive_preview(cls):
        import os
        import shutil as _sh
        from pathlib import Path as _P
        async with cls._preview_lock():
            cls._preview_refs += 1
            if cls._preview_running():
                return {"ok": True}
            hint = await cls._gst_python_hint()
            if hint is None:
                try:
                    import vesktop
                    killer = await create_subprocess_exec("pkill", "-f", "gst_preview.py",
                                                          stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
                    await killer.wait()
                except Exception:
                    pass
                script = _P(DECKY_PLUGIN_DIR) / "gst_preview.py"
                if not script.exists():
                    script = _P(DECKY_PLUGIN_DIR) / "defaults" / "gst_preview.py"
                cls.golive_preview = await create_subprocess_exec(
                    sys_python(), str(script),
                    env=getattr(cls, "_gst_env", None) or dict(os.environ),
                    stdout=PIPE, stderr=PIPE,
                )
                create_task(stream_watcher(cls.golive_preview.stdout, prefix="[gstprev]"))
                create_task(stream_watcher(cls.golive_preview.stderr, True, prefix="[gstprev]"))
                return {"ok": True}
            if _sh.which("gamescopectl") and _sh.which("ffmpeg"):
                logger.info("[gstprev] bindings GStreamer absents → fallback "
                            "gamescopectl+ffmpeg")
                cls._preview_fallback_task = create_task(cls._golive_preview_fallback())
                return {"ok": True}
            # Rien pour capturer : le front affiche le hint structuré (i18n).
            logger.warning(f"[gstprev] {hint['hint']}")
            return {"ok": False, **hint}

    @classmethod
    async def stop_golive_preview(cls):
        async with cls._preview_lock():
            cls._preview_refs = max(0, cls._preview_refs - 1)
            if cls._preview_refs:
                return True
            proc = getattr(cls, "golive_preview", None)
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            cls.golive_preview = None
            task = cls._preview_fallback_task
            if task is not None and not task.done():
                task.cancel()
            cls._preview_fallback_task = None
            return True

    @classmethod
    async def get_golive_preview(cls):
        """Aperçu Go Live natif : état du feeder + dernier JPEG (gst_preview.py
        ou fallback gamescopectl)."""
        import base64
        import os
        import time as _t
        running = cls._preview_running()
        jpg = ""
        path = "/tmp/steamcord-golive-preview.jpg"
        try:
            if running and os.path.exists(path) and _t.time() - os.path.getmtime(path) < 8:
                with open(path, "rb") as f:
                    jpg = base64.b64encode(f.read()).decode()
        except Exception:
            jpg = ""
        return {"running": running, "jpg": jpg}

    @classmethod
    async def get_vesktop_backend(cls):
        # stand-alone : dit au QAM si un moyen de faire tourner Vesktop existe
        # (flatpak ou binaire natif). backend=None → l'écran d'initialisation
        # affiche la marche à suivre au lieu d'un spinner infini (cas CachyOS
        # sans flatpak). Se ré-évalue à chaque appel → self-heal dès que le
        # user installe flatpak/vesktop.
        import vesktop
        try:
            b = vesktop.backend()
            if (b == "flatpak" and vesktop.install_failures >= 3
                    and not await vesktop.installed()):
                # flatpak est là mais l'install Vesktop échoue en boucle (hors-
                # ligne, flathub bloqué, disque plein) → montrer l'écran d'aide
                # plutôt qu'un « Initializing » éternel. Se ré-évalue à chaque
                # appel : dès qu'une install passe, le compteur retombe à 0.
                return {"backend": None}
            return {"backend": b}
        except Exception as e:
            logger.warning(f"[standalone] get_vesktop_backend: {e!r}")
            return {"backend": "unknown"}

    @classmethod
    async def get_share_env(cls):
        # Bureau/Big Picture (KWin) vs console gamescope : décide quel bouton de
        # partage afficher (Go Live = portail, marche seulement sous KWin ; « mode
        # jeu » = node gamescope, marche seulement en console). KWin testé en
        # PREMIER : c'est le signal fiable — les sockets gamescope-* persistent
        # dans XDG_RUNTIME_DIR après une session gamemode, et un gamescope
        # imbriqué par-jeu peut tourner sous KWin (= Bureau quand même).
        async def _running(name):
            p = await create_subprocess_exec("pgrep", "-x", name,
                                             stdout=DEVNULL, stderr=DEVNULL)
            return (await p.wait()) == 0
        try:
            if await _running("kwin_wayland") or await _running("kwin_x11"):
                return {"env": "desktop"}
            if await _running("gamescope") or await _running("gamescope-wl"):
                return {"env": "gamescope"}
        except Exception as e:
            logger.warning(f"[shareenv] {e!r}")
        return {"env": "unknown"}

    # ── Partage AUDIO du jeu (son du jeu → micro Discord, jauges voix/jeu) ───────
    # Deux sinks virtuels : `steamcord_game` devient la sortie PAR DÉFAUT (les jeux
    # y jouent) et reboucle vers la vraie sortie (le user continue d'entendre) ;
    # `steamcord_mix` reçoit micro + jeu via deux loopbacks dont le volume = les
    # jauges du QAM ; un micro virtuel `steamcord_mic` (remap-source du monitor du
    # mix) devient la SOURCE PAR DÉFAUT — indispensable : Discord (entrée «Default»)
    # ne liste pas les monitors, donc sans micro réel il n'ouvrirait AUCUNE capture.
    # Vesktop reste routé sur la vraie sortie → la voix des participants n'entre
    # pas dans le mix (pas d'écho chez eux).
    @classmethod
    async def _pactl_load(cls, *args):
        out = (await cls._pactl("load-module", *args)).strip()
        if not out.isdigit():
            raise Exception(f"load-module {args[0]} a échoué ({out!r})")
        cls._ga_modules.append(out)
        return out

    @classmethod
    async def _ga_boot_cleanup(cls):
        # Après un restart de plugin_loader, d'éventuels modules steamcord_* survivent
        # dans pipewire-pulse alors que notre état est perdu → on repart propre (et on
        # restaure la sortie par défaut si elle pointait encore sur le sink jeu).
        try:
            cur = ((await cls._pactl("get-default-sink")).strip() + " "
                   + (await cls._pactl("get-default-source")).strip())
            if "steamcord_" in cur:
                await cls.stop_game_audio()
            else:
                await cls._ga_cleanup_modules()
        except Exception as e:
            logger.warning(f"[gameaudio] boot cleanup: {e!r}")

    @classmethod
    async def _ga_cleanup_modules(cls):
        # Purge idempotente des modules steamcord_* résiduels (crash / restart
        # plugin_loader : pipewire-pulse, lui, garde les modules chargés).
        # ⚠ le JSON de `pactl list modules` n'a PAS de champ index → format short
        # (index\tnom\targument ; les arguments multi-lignes n'ont pas de tab).
        try:
            for line in (await cls._pactl("list", "modules", "short")).splitlines():
                parts = line.split("\t")
                if len(parts) >= 3 and "steamcord_" in parts[2]:
                    await cls._pactl("unload-module", parts[0])
        except Exception as e:
            logger.warning(f"[gameaudio] purge modules: {e!r}")

    @classmethod
    async def start_game_audio(cls):
        from json import loads
        if cls._ga_active:
            return True
        try:
            await cls._ga_cleanup_modules()
            cls._ga_modules = []
            cls._ga_loop_mod = {}
            real = cls._audio_out or (await cls._pactl("get-default-sink")).strip()
            if not real or "steamcord_" in real:
                raise Exception(f"sortie réelle introuvable ({real!r})")
            cls._ga_real_sink = real
            await cls._pactl_load("module-null-sink", "sink_name=steamcord_game",
                                  "sink_properties=device.description=SteamcordGame")
            await cls._pactl_load("module-null-sink", "sink_name=steamcord_mix",
                                  "sink_properties=device.description=SteamcordMix")
            # Le user continue d'entendre le jeu sur la vraie sortie.
            await cls._pactl_load("module-loopback", "source=steamcord_game.monitor",
                                  f"sink={real}", "latency_msec=30")
            # Branche JEU du mix (jauge 🎮).
            cls._ga_loop_mod["game"] = await cls._pactl_load(
                "module-loopback", "source=steamcord_game.monitor",
                "sink=steamcord_mix", "latency_msec=30")
            # Branche VOIX du mix (jauge 🎙️) — seulement si un vrai micro existe
            # (sur cette machine la source par défaut peut être un monitor HDMI).
            mic = cls._audio_in or (await cls._pactl("get-default-source")).strip()
            if mic and not mic.endswith(".monitor") and "steamcord_" not in mic:
                cls._ga_loop_mod["voice"] = await cls._pactl_load(
                    "module-loopback", f"source={mic}",
                    "sink=steamcord_mix", "latency_msec=30")
            else:
                logger.warning(f"[gameaudio] aucun micro réel ({mic!r}) — branche voix absente")
            # Micro virtuel branché sur le mix, promu source PAR DÉFAUT : sans lui,
            # Discord (entrée « Default ») n'a rien à ouvrir quand aucun micro réel
            # n'existe (WebRTC filtre les monitors) → aucune capture, mix jamais
            # transmis. « Micro-Steamcord » apparaît comme un vrai périphérique.
            await cls._pactl_load("module-remap-source", "master=steamcord_mix.monitor",
                                  "source_name=steamcord_mic",
                                  "source_properties=device.description=Micro-Steamcord")
            cur_src = (await cls._pactl("get-default-source")).strip()
            cls._ga_real_source = cur_src if cur_src and "steamcord_" not in cur_src else None
            await cls._pactl("set-default-source", "steamcord_mic")
            await cls._pactl("set-default-sink", "steamcord_game")
            cls._ga_active = True
            await cls._apply_audio_routing()  # déplace jeu→steamcord_game, Vesktop→réel/mix
            await cls._ga_apply_volumes()
            logger.info(f"[gameaudio] ACTIF (sortie réelle={real}, micro={mic!r}, "
                        f"branches={list(cls._ga_loop_mod)})")
            return True
        except Exception as e:
            logger.warning(f"[gameaudio] démarrage KO: {e!r}")
            await cls.stop_game_audio()
            return False

    @classmethod
    async def stop_game_audio(cls):
        from json import loads
        cls._ga_active = False
        try:
            real = cls._ga_real_sink or (await cls._pactl("get-default-sink")).strip()
            if not real or "steamcord_" in real:
                # État perdu (restart) et défaut encore sur le sink virtuel → premier
                # sink matériel disponible.
                for line in (await cls._pactl("list", "sinks", "short")).splitlines():
                    name = (line.split("\t") + [""])[1]
                    if name and "steamcord_" not in name:
                        real = name
                        break
            if real and "steamcord_" not in real:
                await cls._pactl("set-default-sink", real)
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if str(si.get("owner_module", "")) not in cls._ga_modules:
                        await cls._pactl("move-sink-input", str(si.get("index")), real)
            # Restaurer la source par défaut (le micro virtuel va être déchargé).
            src = cls._ga_real_source
            if not src or "steamcord_" in src:
                cand = [(line.split("\t") + [""])[1]
                        for line in (await cls._pactl("list", "sources", "short")).splitlines()]
                cand = [n for n in cand if n and "steamcord_" not in n]
                src = next((n for n in cand if not n.endswith(".monitor")),
                           cand[0] if cand else None)
            if src and "steamcord_" not in src:
                await cls._pactl("set-default-source", src)
            # Rendre à Vesktop son entrée d'origine (choix user ou défaut système).
            mic = cls._audio_in or (await cls._pactl("get-default-source")).strip()
            if mic and "steamcord_" not in mic:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), mic)
        except Exception as e:
            logger.warning(f"[gameaudio] restauration: {e!r}")
        for mid in reversed(cls._ga_modules):
            try:
                await cls._pactl("unload-module", mid)
            except Exception:
                pass
        cls._ga_modules = []
        cls._ga_loop_mod = {}
        cls._ga_real_sink = None
        cls._ga_real_source = None
        await cls._ga_cleanup_modules()
        logger.info("[gameaudio] arrêté, routage restauré")
        return True

    @classmethod
    async def _ga_apply_volumes(cls):
        # Les jauges = volume du sink-input que chaque loopback pousse dans le mix
        # (retrouvé par owner_module, seul lien stable module→flux).
        from json import loads
        try:
            sis = loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]")
            for kind, mid in cls._ga_loop_mod.items():
                pct = max(0, min(150, int(cls._ga_vol.get(kind, 100))))
                for si in sis:
                    if str(si.get("owner_module")) == str(mid):
                        await cls._pactl("set-sink-input-volume", str(si.get("index")), f"{pct}%")
        except Exception as e:
            logger.warning(f"[gameaudio] volumes: {e!r}")

    @classmethod
    async def set_game_audio_volume(cls, kind, pct):
        if kind in cls._ga_vol:
            cls._ga_vol[kind] = int(pct)
            cls._save_audio_cfg()
        if cls._ga_active:
            await cls._ga_apply_volumes()
        return True

    @classmethod
    async def get_game_audio(cls):
        return {"active": cls._ga_active,
                "has_mic": ("voice" in cls._ga_loop_mod) if cls._ga_active else True,
                "voice": cls._ga_vol["voice"], "game": cls._ga_vol["game"]}

    @classmethod
    async def mic_webrtc_answer(cls, answer):
        await cls.evt_handler.send_client({"type": "$webrtc", "payload": answer})

    # ── Relais vidéo inverse (voir le Go Live/cam des autres dans le QAM) ──
    @classmethod
    async def watch_video(cls, user_id):
        # Ask the Discord tab to watch this user's stream, capture its video track
        # and offer it back to us. Correlated by user_id.
        await cls.evt_handler.send_client({"type": "$WATCH_VIDEO", "userId": user_id})

    @classmethod
    async def unwatch_video(cls, user_id):
        await cls.evt_handler.send_client({"type": "$UNWATCH_VIDEO", "userId": user_id})

    @classmethod
    async def video_webrtc_answer(cls, user_id, answer):
        await cls.evt_handler.send_client({"type": "$VIDEO_ANSWER", "userId": user_id, "payload": answer})

    @classmethod
    async def _unload(cls):
        # Restaurer la capture voix si un Go Live sans micro était en cours
        # (sinon la source par défaut resterait le null-sink silencieux).
        try:
            await cls._golive_mic_silence(False)
        except Exception:
            pass
        if hasattr(cls, "webrtc_server"):
            cls.webrtc_server.kill()
            await cls.webrtc_server.wait()

        if hasattr(cls, "portal_shim"):
            cls.portal_shim.kill()
            await cls.portal_shim.wait()

        proc = getattr(cls, "golive_preview", None)
        if proc is not None and proc.returncode is None:
            proc.kill()
            await proc.wait()

        if hasattr(cls, "runner"):
            await cls.runner.shutdown()
            await cls.runner.cleanup()

        if hasattr(cls, "shared_js_tab"):
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                """
                window.DISCORD_TAB.m_browserView.SetVisible(false);
                window.DISCORD_TAB.Destroy();
                window.DISCORD_TAB = undefined;
            """
            )
            await cls.shared_js_tab.close_websocket()
