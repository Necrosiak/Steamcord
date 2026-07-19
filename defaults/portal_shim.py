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
REQUEST_IFACE = "org.freedesktop.portal.Request"
SESSION_IFACE = "org.freedesktop.portal.Session"
PROPS_IFACE = "org.freedesktop.DBus.Properties"

# ScreenCast v2 : assez pour Chromium (CreateSession/SelectSources/Start +
# cursor modes), pas assez pour qu'il tente les restore tokens (v4).
SC_PROPS = {
    "version": Variant("u", 2),
    "AvailableSourceTypes": Variant("u", 1),   # MONITOR only
    "AvailableCursorModes": Variant("u", 3),   # HIDDEN | EMBEDDED (gamescope
                                               # composite déjà le curseur)
}


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
            if iface == SCREENCAST_IFACE and prop in SC_PROPS:
                return Message.new_method_return(msg, "v", [SC_PROPS[prop]])
            return Message.new_error(
                msg, "org.freedesktop.DBus.Error.InvalidArgs",
                f"no property {prop!r} on {iface!r}")
        if msg.member == "GetAll":
            (iface,) = msg.body
            if iface == SCREENCAST_IFACE:
                return Message.new_method_return(msg, "a{sv}", [SC_PROPS])
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
        # Le noyau duplique le fd à l'envoi (SCM_RIGHTS) ; on garde le nôtre
        # jusqu'à la fermeture de la session pour ne pas couper un envoi en vol.
        self.sessions[session]["fds"].append(fd)
        log.info(f"OpenPipeWireRemote → fd pipewire (session {session})")
        return Message.new_method_return(msg, "h", [0], unix_fds=[fd])

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
