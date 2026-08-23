#!/usr/bin/env python
"""ScreenCast portal shim for gamescope — makes REAL Go Live work in game mode.

gamescope ships no xdg-desktop-portal backend, so Chromium's getDisplayMedia
(what Discord Go Live actually calls) finds nobody to ask for pixels in game
mode → black screen. But gamescope DOES publish its composited output as a
PipeWire video node (the same one Steam Game Recording and Decky Recorder use).

The portal is only a D-Bus middleman: at the end of the CreateSession →
SelectSources → Start handshake Chromium receives a PipeWire node id + an fd
from OpenPipeWireRemote, then reads pixels straight from PipeWire. It does not
care WHO implemented the portal. So this shim owns org.freedesktop.portal.Desktop
on the user session bus and implements just enough of
org.freedesktop.portal.ScreenCast (v2) to auto-approve every request with the
gamescope node — no dialog, no virtual camera, no kernel module: the native
Chromium capture path, full resolution, hardware-friendly.

Owning that name has a cost that is easy to miss: it is SESSION-WIDE, not
private to Discord. While the shim holds it, every application in the session
talks to us instead of the real portal — so anything we refuse, we refuse for
all of them (#39: Sober asked for ProxyResolver and got an error, which looked
like a Sober bug and was ours). We therefore answer the interfaces the real
portal implements in its FRONTEND, with no desktop backend involved, because
those are always available with a real portal and their absence is a genuine
regression rather than a missing feature: ProxyResolver and NetworkMonitor.
Anything still refused is now logged, so the next gap shows up in our journal
instead of in somebody else's app.

Politeness rules (SteamOS switches between game mode and desktop on the SAME
user bus): we only hold the portal name while a gamescope session exists. In
desktop mode the REAL xdg-desktop-portal must own it (KDE portal serves
screenshare there), so we release it and poll until game mode comes back.
Conversely a STALE xdg-desktop-portal left running from a previous desktop
session (systemd user units survive session switches) is useless under
gamescope AND blocks us → we stop its unit; desktop mode re-activates it on
demand via D-Bus activation, so nothing is lost.

Runs as a subprocess of main.py (stdout/stderr → [portal] prefix in the
Steamcord journal). Pure userspace, no rootfs writes → survives A/B updates.
"""

import asyncio
import json
import logging
import os
import socket
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(levelname)s %(name)s: %(message)s", force=True)
log = logging.getLogger("portalshim")

# dbus_next is vendored in the plugin's py_modules (pure python — works under
# the system interpreter). main.py passes PYTHONPATH, but self-locate too so
# the shim can be run by hand for debugging.
_here = Path(__file__).resolve().parent
for _root in (_here, _here.parent):
    _pm = _root / "py_modules"
    if _pm.is_dir() and str(_pm) not in sys.path:
        sys.path.insert(0, str(_pm))

from dbus_next.aio import MessageBus  # type: ignore # noqa: E402
from dbus_next.constants import (BusType, MessageType, NameFlag,  # noqa: E402
                                 RequestNameReply)
from dbus_next.message import Message  # type: ignore # noqa: E402
from dbus_next import Variant  # type: ignore # noqa: E402

PORTAL_NAME = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
# #39 : ProxyResolver et NetworkMonitor sont implémentées par le FRONTEND de
# xdg-desktop-portal (GLib direct, aucun backend de bureau requis) — elles sont
# donc TOUJOURS disponibles avec un vrai portail, sur n'importe quel bureau.
# Les refuser n'est pas « une interface qu'on n'a pas », c'est une régression
# visible par toute app de la session. Cf. le commentaire de handle().
PROXY_IFACE = "org.freedesktop.portal.ProxyResolver"
NETMON_IFACE = "org.freedesktop.portal.NetworkMonitor"
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
PROPS_IFACE = "org.freedesktop.DBus.Properties"

# Délai avant de refermer NOTRE copie d'un fd PipeWire remis à Chromium (#26).
# Il ne borne qu'un envoi D-Bus local déjà accepté par le noyau — 30 s est
# absurdement large exprès : le but n'est pas d'être rapide, c'est de garantir
# que la copie finit par partir même si Discord ne ferme jamais la session.
FD_RELEASE_DELAY = 30.0

# ScreenCast v2 : assez pour Chromium (CreateSession/SelectSources/Start +
# cursor modes), pas assez pour qu'il tente les restore tokens (v4).
SC_PROPS = {
    "version": Variant("u", 2),
    "AvailableSourceTypes": Variant("u", 1),   # MONITOR only
    "AvailableCursorModes": Variant("u", 3),   # HIDDEN | EMBEDDED (gamescope
                                               # composite déjà le curseur)
}

PROXY_PROPS = {"version": Variant("u", 1)}
NETMON_PROPS = {"version": Variant("u", 3)}


def _proxy_for(uri):
    """Proxy à employer pour `uri`, au format GProxyResolver — soit
    « direct:// », soit une URL de proxy.

    Le vrai portail délègue à GProxyResolver, qui lit la configuration du
    bureau. Ici on s'en tient aux variables d'environnement (et à no_proxy),
    et on retombe sur une connexion directe : c'est la réponse JUSTE dans le
    cas de très loin le plus courant — aucun proxy configuré — et elle ne peut
    pas casser une app, contrairement à l'erreur qu'on renvoyait avant.
    Limite assumée : un proxy réglé UNIQUEMENT dans les réglages du bureau
    (gsettings) n'est pas vu ici."""
    scheme, host = "", ""
    try:
        if "://" in uri:
            scheme, rest = uri.split("://", 1)
        else:
            rest = uri
        scheme = scheme.lower()
        host = rest.split("/", 1)[0].split("@")[-1].rsplit(":", 1)[0].strip("[]").lower()
    except Exception:
        pass

    no_proxy = os.environ.get("no_proxy") or os.environ.get("NO_PROXY") or ""
    for pat in (x.strip().lower() for x in no_proxy.split(",")):
        if not pat:
            continue
        if pat == "*" or host == pat or host.endswith("." + pat.lstrip(".")):
            return "direct://"

    for var in (f"{scheme}_proxy", f"{scheme.upper()}_PROXY",
                "all_proxy", "ALL_PROXY"):
        val = os.environ.get(var)
        if val:
            return val
    return "direct://"


def _runtime_dir():
    return os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")


def _proc_running(*names):
    """True si un process dont le comm est dans `names` tourne (scan /proc)."""
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


def in_game_mode():
    """True si la session ACTIVE est gamescope. KWin testé en PREMIER : les
    sockets gamescope-* persistent dans XDG_RUNTIME_DIR après une session
    gamemode, et un gamescope imbriqué par-jeu peut tourner sous KWin (= bureau
    quand même) — même logique que main.py:get_share_env. Se tromper ici =
    voler le nom portail au bureau et casser le partage d'écran du DE."""
    if _proc_running("kwin_wayland", "kwin_x11"):
        return False
    return _proc_running("gamescope", "gamescope-wl")


# ── gamescope PipeWire node ──────────────────────────────────────────────────
# Même filtrage que gst_webrtc._find_screen_node : jamais un device v4l2 (ni
# notre ancienne webcam virtuelle), préférence au node gamescope/screen.
async def find_screen_node():
    """(node_id:int, (w,h)|None) du node écran gamescope, ou (None, None)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "pw-dump", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        # ⚠ SANS timeout, un PipeWire qui n'enregistre plus de clients (vu le
        # 19/07 après un spam start/stop : 6 pw-dump pendus) bloquait ce await
        # pour toujours → Start ne répondait jamais → le getDisplayMedia de
        # Chromium pendait → plus AUCUN Go Live possible (faux « wedge Electron »).
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 5)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            log.warning("pw-dump muet après 5s — PipeWire ne répond plus "
                        "(redémarrer la session/console pour récupérer)")
            return None, None
        data = json.loads(out)
    except Exception as e:
        log.warning(f"pw-dump KO: {e!r}")
        return None, None
    vids = []
    for n in data:
        if not str(n.get("type", "")).endswith("Node"):
            continue
        info = n.get("info", {}) or {}
        p = info.get("props", {}) or {}
        mc = str(p.get("media.class", ""))
        name = str(p.get("node.name", ""))
        desc = str(p.get("node.description", ""))
        blob = (mc + " " + name + " " + desc).lower()
        if ("v4l2" in blob or "video42" in blob or "steamcord" in blob
                or "loopback" in blob):
            continue
        if ("video/source" in mc.lower() or "gamescope" in blob
                or "screen" in blob or "video/output" in mc.lower()):
            vids.append((n.get("id"), name, mc, info))
    for nid, name, mc, info in vids:
        if "gamescope" in name.lower() or "screen" in name.lower():
            return int(nid), _node_size(info)
    for nid, name, mc, info in vids:
        if "video/source" in mc.lower():
            return int(nid), _node_size(info)
    return None, None


def _node_size(info):
    """Meilleure taille (w,h) trouvable dans les params du node, sinon None."""
    try:
        for plist in (info.get("params", {}) or {}).values():
            if not isinstance(plist, list):
                continue
            for prm in plist:
                if isinstance(prm, dict) and isinstance(prm.get("size"), dict):
                    s = prm["size"]
                    if s.get("width") and s.get("height"):
                        return int(s["width"]), int(s["height"])
    except Exception:
        pass
    return None


# ── protocol plumbing ────────────────────────────────────────────────────────
def _sender_token(sender):
    """':1.123' → '1_123' (segment de chemin des objets Request/Session)."""
    return sender.lstrip(":").replace(".", "_")


def _opt(options, key, default=""):
    v = options.get(key)
    return v.value if v is not None else default


class PortalShim:
    def __init__(self, bus):
        self.bus = bus
        self.loop = asyncio.get_event_loop()
        # session_path → {"fds": [pipewire remote fds]}
        self.sessions = {}

    # Response est TOUJOURS émise après le retour de la méthode (le client
    # s'abonne au chemin de Request AVANT l'appel — il le calcule depuis son
    # handle_token) ; call_soon garantit reply-puis-signal sur le socket.
    def _respond_later(self, sender, request_path, code, results):
        def _send():
            self.bus.send(Message(
                message_type=MessageType.SIGNAL,
                destination=sender,
                path=request_path,
                interface=REQUEST_IFACE,
                member="Response",
                signature="ua{sv}",
                body=[code, results],
            ))
        self.loop.call_soon(_send)

    def _request_path(self, sender, options):
        token = _opt(options, "handle_token", "t") or "t"
        return (f"/org/freedesktop/portal/desktop/request/"
                f"{_sender_token(sender)}/{token}")

    # dbus_next appelle ce handler pour chaque message entrant ; renvoyer un
    # Message = réponse envoyée, None = non géré (erreur UnknownObject par défaut).
    def handle(self, msg):
        if msg.message_type != MessageType.METHOD_CALL:
            return None
        try:
            if msg.path == PORTAL_PATH and msg.interface == PROPS_IFACE:
                return self._props(msg)
            if msg.path == PORTAL_PATH and msg.interface == SCREENCAST_IFACE:
                m = getattr(self, "_m_" + msg.member, None)
                if m:
                    return m(msg)
            if msg.interface == SESSION_IFACE and msg.path in self.sessions:
                if msg.member == "Close":
                    self._close_session(msg.path)
                    return Message.new_method_return(msg, "", [])
            if msg.interface == REQUEST_IFACE and msg.member == "Close":
                return Message.new_method_return(msg, "", [])
            if msg.path == PORTAL_PATH and msg.interface == PROXY_IFACE:
                if msg.member == "Lookup":
                    (uri,) = msg.body
                    proxy = _proxy_for(uri)
                    log.info(f"ProxyResolver.Lookup({uri!r}) -> {proxy}")
                    return Message.new_method_return(msg, "as", [[proxy]])
            if msg.path == PORTAL_PATH and msg.interface == NETMON_IFACE:
                if msg.member == "GetAvailable":
                    return Message.new_method_return(msg, "b", [True])
                if msg.member == "GetMetered":
                    return Message.new_method_return(msg, "b", [False])
                if msg.member == "GetConnectivity":
                    # 4 = G_NETWORK_CONNECTIVITY_FULL
                    return Message.new_method_return(msg, "u", [4])
                if msg.member == "CanReach":
                    # Vrai = « tente la connexion ». On ne sonde PAS le réseau :
                    # ce handler doit répondre sans bloquer la boucle qui sert
                    # aussi le handshake ScreenCast. Et c'est la réponse sûre —
                    # l'app établit ensuite sa connexion pour de vrai et gère
                    # l'échec normalement, alors qu'un faux « injoignable »
                    # l'arrêterait net.
                    return Message.new_method_return(msg, "b", [True])
            # Interfaces portail NON implémentées (Settings, FileChooser…) :
            # répondre une VRAIE erreur D-Bus tout de suite. Sinon le handler
            # par défaut de dbus_next lève UNKNOWN_OBJECT sans répondre →
            # l'appelant attend son timeout (25 s) et le journal se remplit de
            # tracebacks (vu en live : sondes Settings en boucle dès la prise
            # du nom). Les interfaces org.freedesktop.DBus.* (Peer, Introspect,
            # Properties) restent aux handlers par défaut / à _props.
            if (str(msg.path).startswith("/org/freedesktop/portal/")
                    and not (msg.interface or "").startswith(
                        "org.freedesktop.DBus")):
                # TRACÉ : sans cette ligne, une app tierce cassée par le shim
                # échouait en silence côté Steamcord (#39 — Sober réclamait
                # ProxyResolver et personne ne le voyait dans notre journal).
                # msg.sender peut être None sur un bus sans routage de noms :
                # _sender_token ferait un .lstrip() sur None et l'exception
                # transformerait un UnknownMethod net en Error.Failed opaque.
                log.warning(
                    f"refusé à {msg.sender or '?'} : "
                    f"{msg.interface}.{msg.member} — non implémentée par le shim")
                return Message.new_error(
                    msg, "org.freedesktop.DBus.Error.UnknownMethod",
                    f"{msg.interface} not implemented by Steamcord shim")
        except Exception as e:
            log.error(f"{msg.member} KO: {e!r}")
            return Message.new_error(
                msg, "org.freedesktop.portal.Error.Failed", str(e))
        return None

    def _props(self, msg):
        if msg.member == "Get":
            iface, prop = msg.body
            for want, props in ((SCREENCAST_IFACE, SC_PROPS),
                                (PROXY_IFACE, PROXY_PROPS),
                                (NETMON_IFACE, NETMON_PROPS)):
                if iface == want and prop in props:
                    return Message.new_method_return(msg, "v", [props[prop]])
            return Message.new_error(
                msg, "org.freedesktop.DBus.Error.InvalidArgs",
                f"no property {prop!r} on {iface!r}")
        if msg.member == "GetAll":
            (iface,) = msg.body
            for want, props in ((SCREENCAST_IFACE, SC_PROPS),
                                (PROXY_IFACE, PROXY_PROPS),
                                (NETMON_IFACE, NETMON_PROPS)):
                if iface == want:
                    return Message.new_method_return(msg, "a{sv}", [props])
            # Interfaces non implémentées (Settings…) : dict vide = réponse
            # honnête, pas de timeout ni de retry agressif côté appelant.
            return Message.new_method_return(msg, "a{sv}", [{}])
        # Set & co : refus propre plutôt que le handler par défaut qui lève.
        return Message.new_error(
            msg, "org.freedesktop.DBus.Error.NotSupported",
            f"Properties.{msg.member} not supported by Steamcord shim")

    async def _sender_is_vesktop(self, sender):
        """Le portail auto-approuve sans dialogue → on ne sert QUE notre Vesktop.
        Sans ce garde-fou, n'importe quel process du bus de session pourrait
        capturer l'écran en silence pendant le mode jeu (le dialogue de
        consentement du portail existe précisément pour empêcher ça)."""
        try:
            reply = await self.bus.call(Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus",
                member="GetConnectionUnixProcessID",
                signature="s", body=[sender]))
            pid = int(reply.body[0])
            cmd = (Path(f"/proc/{pid}/cmdline").read_bytes()
                   .replace(b"\0", b" ").decode(errors="replace").lower())
            if any(k in cmd for k in ("vesktop", "vencord", "electron",
                                      "discord")):
                return True
            # Flatpak : la connexion D-Bus vue par le bus est celle du
            # xdg-dbus-proxy de l'instance (cmdline anonyme) — MAIS il vit dans
            # le scope systemd de l'app (app-flatpak-dev.vencord.Vesktop-*.scope,
            # vérifié en live 18/07 : le refus du proxy cassait le Go Live natif).
            cg = Path(f"/proc/{pid}/cgroup").read_text(errors="replace").lower()
            if any(k in cg for k in ("vesktop", "vencord", "steamcord")):
                return True
            log.warning(f"sender {sender} refusé (pid={pid}, "
                        f"cmdline={cmd[:120]!r}, cgroup={cg.strip()[-90:]!r})")
        except Exception as e:
            log.warning(f"vérif sender {sender} KO ({e!r}) — refus par prudence")
        return False

    def _m_CreateSession(self, msg):
        (options,) = msg.body
        sender = msg.sender
        st = _opt(options, "session_handle_token", "s") or "s"
        session_path = (f"/org/freedesktop/portal/desktop/session/"
                        f"{_sender_token(sender)}/{st}")
        req = self._request_path(sender, options)

        # La session n'existe (et Response(0) ne part) qu'une fois le sender
        # vérifié — Start et OpenPipeWireRemote exigent une session connue,
        # donc un appelant non vérifié n'obtient ni node ni fd.
        async def _vet():
            if await self._sender_is_vesktop(sender):
                # #26 « Stream screen not working ». Discord n'appelle
                # Session.Close QUE sur un arrêt propre : un flux qui glitche, un
                # rechargement de l'onglet ou un Vesktop qui redémarre laissaient
                # la session — et ses fds PipeWire — vivante pour toujours. Les
                # connexions s'accumulaient jusqu'à ce que PipeWire n'enregistre
                # plus aucun client : pw-dump pend, find_screen_node rend
                # (None, None), Start échoue SANS ERREUR VISIBLE, et seul un
                # redémarrage complet récupérait la main. On ne partage qu'un seul
                # écran à la fois ici : toute session antérieure du même
                # expéditeur est forcément morte, on la ferme avant d'en ouvrir
                # une neuve.
                for old in [p for p in self.sessions
                            if p.startswith(f"/org/freedesktop/portal/desktop/session/"
                                            f"{_sender_token(sender)}/")
                            and p != session_path]:
                    log.info(f"CreateSession: fermeture de la session orpheline {old}")
                    self._close_session(old)
                self.sessions[session_path] = {"fds": []}
                log.info(f"CreateSession → {session_path}")
                self._respond_later(sender, req, 0,
                                    {"session_handle": Variant("s", session_path)})
            else:
                self._respond_later(sender, req, 2, {})
        asyncio.ensure_future(_vet())
        return Message.new_method_return(msg, "o", [req])

    def _m_SelectSources(self, msg):
        session, options = msg.body
        req = self._request_path(msg.sender, options)
        # Tout est auto-approuvé : une seule source possible (l'écran gamescope).
        self._respond_later(msg.sender, req, 0, {})
        return Message.new_method_return(msg, "o", [req])

    def _m_Start(self, msg):
        session, _parent, options = msg.body
        sender = msg.sender
        req = self._request_path(sender, options)
        asyncio.ensure_future(self._start_async(sender, session, req))
        return Message.new_method_return(msg, "o", [req])

    async def _start_async(self, sender, session, req):
        # Le node gamescope peut mettre quelques instants à (ré)apparaître
        # (lancement de jeu) — courte boucle avant d'abandonner. Budget en
        # TEMPS et pas en tours : si pw-dump timeoute (5s/appel, PipeWire
        # wedgé), 10 tours feraient ~55s alors que Chromium abandonne le
        # portail à 25s — il faut répondre Response(2) AVANT.
        node = size = None
        t0 = time.monotonic()
        while time.monotonic() - t0 < 6:
            node, size = await find_screen_node()
            if node is not None:
                break
            await asyncio.sleep(0.5)
        if node is None or session not in self.sessions:
            log.warning("Start: aucun node écran gamescope → Response(2)")
            self._respond_later(sender, req, 2, {})
            return
        props = {"position": Variant("(ii)", [0, 0]),
                 "source_type": Variant("u", 1)}
        if size:
            props["size"] = Variant("(ii)", [size[0], size[1]])
        log.info(f"Start → node {node} size={size} (session {session})")
        self._respond_later(sender, req, 0, {
            "streams": Variant("a(ua{sv})", [[node, props]]),
        })

    def _m_OpenPipeWireRemote(self, msg):
        session = msg.body[0]
        # Session inconnue = sender jamais vérifié (cf. _sender_is_vesktop) :
        # pas de fd PipeWire pour lui.
        if session not in self.sessions:
            return Message.new_error(
                msg, "org.freedesktop.portal.Error.Failed",
                "unknown session")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            remote = os.environ.get("PIPEWIRE_REMOTE", "pipewire-0")
            sock.connect(os.path.join(_runtime_dir(), remote))
        except OSError as e:
            sock.close()
            log.error(f"OpenPipeWireRemote: connexion pipewire KO: {e!r}")
            return Message.new_error(
                msg, "org.freedesktop.portal.Error.Failed", str(e))
        fd = sock.detach()
        # Le noyau duplique le fd à l'envoi (SCM_RIGHTS) : une fois le message
        # parti, NOTRE copie ne sert plus à rien — Chromium a la sienne. On la
        # gardait jusqu'à Session.Close, donc pour toujours dès que Discord
        # oubliait de fermer (#26) : autant de connexions PipeWire vivantes en
        # pure perte, jusqu'au blocage du serveur. On la referme après un délai
        # large, qui couvre très largement l'envoi en vol.
        self.sessions[session]["fds"].append(fd)
        log.info(f"OpenPipeWireRemote → fd pipewire (session {session})")
        asyncio.get_event_loop().call_later(
            FD_RELEASE_DELAY, self._release_fd, session, fd)
        return Message.new_method_return(msg, "h", [0], unix_fds=[fd])

    def _release_fd(self, session, fd):
        """Ferme notre copie du fd, une seule fois.

        Le retrait de la liste AVANT le close est ce qui rend l'opération sûre :
        sans ça, _close_session pourrait refermer le même numéro de fd après
        que le noyau l'ait recyclé pour autre chose — on fermerait un descripteur
        sans rapport (socket D-Bus, fichier de log…).
        """
        sess = self.sessions.get(session)
        if sess and fd in sess["fds"]:
            sess["fds"].remove(fd)
            _safe_close(fd)

    def _close_session(self, path):
        sess = self.sessions.pop(path, None)
        if sess:
            for fd in sess["fds"]:
                _safe_close(fd)
            log.info(f"Session fermée: {path}")

    def close_all(self):
        for path in list(self.sessions):
            self._close_session(path)


def _safe_close(fd):
    try:
        os.close(fd)
    except OSError:
        pass


async def _stop_stale_portal():
    """Un xdg-desktop-portal resté de la session bureau tient le nom mais ne
    sait rien capturer sous gamescope → on arrête son unité user. Le bureau le
    réactivera à la demande (activation D-Bus) — rien n'est perdu."""
    log.info("nom portail occupé en mode jeu — arrêt du xdg-desktop-portal "
             "hérité de la session bureau (réactivé à la demande au retour)")
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "--user", "stop", "xdg-desktop-portal.service",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL)
        await proc.wait()
    except Exception as e:
        log.warning(f"systemctl stop xdg-desktop-portal KO: {e!r}")


async def serve_while_in_game_mode():
    """Possède le nom portail et sert les requêtes tant que gamescope vit."""
    bus = await MessageBus(bus_type=BusType.SESSION,
                           negotiate_unix_fd=True).connect()
    shim = PortalShim(bus)
    bus.add_message_handler(shim.handle)
    reply = await bus.request_name(PORTAL_NAME, NameFlag.DO_NOT_QUEUE)
    if reply != RequestNameReply.PRIMARY_OWNER:
        bus.remove_message_handler(shim.handle)
        bus.disconnect()
        await _stop_stale_portal()
        return
    log.info(f"portail ScreenCast prêt ({PORTAL_NAME} possédé) — "
             f"Go Live natif disponible en mode jeu")
    try:
        while in_game_mode() and bus.connected:
            await asyncio.sleep(3)
    finally:
        shim.close_all()
        try:
            if bus.connected:
                await bus.release_name(PORTAL_NAME)
                bus.disconnect()
        except Exception:
            pass
        log.info("session gamescope terminée — nom portail relâché "
                 "(le portail bureau peut reprendre la main)")


async def main():
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = \
            f"unix:path={_runtime_dir()}/bus"
    last_log = 0.0
    while True:
        if in_game_mode():
            try:
                await serve_while_in_game_mode()
            except Exception as e:
                log.error(f"portail interrompu: {e!r}")
        else:
            now = time.monotonic()
            if now - last_log > 300:
                log.info("pas de session gamescope — portail en veille")
                last_log = now
        await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
