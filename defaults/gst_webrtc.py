#Most of the code here is adapted from https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/main/subprojects/gst-examples/webrtc/sendrecv/gst/webrtc_sendrecv.py
#Code for setting up pipelinesrc and audio pipeline is from https://github.com/marissa999/decky-recorder

import sys
import aiohttp # type: ignore
from aiohttp import web # type: ignore
import logging
import signal
import os
import time
from logging import getLogger
from gi import require_version # type: ignore
import asyncio
from asyncio import run_coroutine_threadsafe
from subprocess import getoutput

# Ce script tourne comme sous-process (stdout/stderr capturés par stream_watcher →
# préfixe [gst] dans le journal Steamcord). Sans handler racine, tous les log.info
# (node écran choisi, "listening", erreurs de bus GStreamer) étaient JETÉS
# silencieusement → diagnostic écran noir impossible. On force un handler INFO sur
# stdout pour rendre tout ça visible.
logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(levelname)s %(name)s: %(message)s", force=True)
log = getLogger("webrtc")

require_version("Gst", "1.0")
require_version("GstWebRTC", "1.0")
require_version("GstSdp", "1.0")
from gi.repository import Gst, GstWebRTC, GstSdp # type: ignore

# Whole-screen capture: pipewiresrc with no target binds to the compositor's
# default screencast node (gamescope exposes the full screen in Steam gaming mode).
# Audio: the default sink's .monitor source (system output mix).
PIPELINE_DESC = """
  webrtcbin name=send latency=0 stun-server=stun://stun.l.google.com:19302
  turn-server=turn://gstreamer:IsGreatWhenYouCanGetItToWork@webrtc.nirbheek.in:3478
  {video_src} do-timestamp=true ! videoconvert ! queue !
  vp8enc deadline=1 keyframe-max-dist=2000 ! rtpvp8pay picture-id-mode=15-bit !
  queue ! application/x-rtp,media=video,encoding-name=VP8,payload={video_pt} ! send.
  pulsesrc device="{monitor}" ! audioconvert ! audioresample ! queue ! opusenc ! rtpopuspay !
  queue ! application/x-rtp,media=audio,encoding-name=OPUS,payload={audio_pt} ! send.
"""


# Éléments exigés par PIPELINE_DESC, et le paquet qui les fournit. Sert à dire
# CE QUI MANQUE plutôt que de laisser parse_launch échouer sur un message opaque
# (#38 : sur SteamOS, gst-plugins-bad absent → pas de webrtcbin → Go Live sans
# explication ; le rapporteur a mis longtemps à trouver que c'était ça).
REQUIRED_ELEMENTS = {
    "webrtcbin": "gst-plugins-bad (gstreamer1-plugins-bad-free)",
    # webrtcbin fabrique lui-même un nicesrc/nicesink pour l'ICE : sans le plugin
    # `nice`, la demande de pad sur webrtcbin échoue et parse_launch ne dit que
    # « send can't handle caps … missing a plug-in » (#42). Le plugin est vendoré
    # dans <plugin>/gst-plugins ; le tester ici transforme une régression de
    # GST_PLUGIN_PATH en message lisible au lieu d'un Go Live muet.
    "nicesrc": "libnice-gstreamer1 (vendoré dans le plugin : gst-plugins/libgstnice.so)",
    "pipewiresrc": "gstreamer1-plugin-pipewire / pipewire-gstreamer",
    "vp8enc": "gst-plugins-good (libvpx)",
    "rtpvp8pay": "gst-plugins-good",
    "opusenc": "gst-plugins-base (opus)",
    "rtpopuspay": "gst-plugins-good",
    "pulsesrc": "gst-plugins-good (pulseaudio)",
    "videoconvert": "gst-plugins-base",
    "audioconvert": "gst-plugins-base",
    "audioresample": "gst-plugins-base",
}


def _missing_gst_elements():
    """Liste [(élément, paquet)] des éléments absents de l'installation GStreamer.

    On interroge le registre plutôt que de tenter le pipeline : parse_launch
    s'arrête au PREMIER manquant, alors qu'on veut pouvoir tout annoncer d'un coup.
    """
    missing = []
    for name, pkg in REQUIRED_ELEMENTS.items():
        try:
            if Gst.ElementFactory.find(name) is None:
                missing.append((name, pkg))
        except Exception as e:
            log.warning(f"[gst] registre interrogeable pour {name}: {e!r}")
    return missing


def _shim_pid_path():
    rt = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(rt, "steamcord-portal-shim.pid")


def _release_portal_sessions():
    """Demande au shim de lâcher ses sessions ScreenCast (#38).

    On n'arrive ici QUE si le getDisplayMedia natif a déjà échoué : toute session
    portail encore vivante est donc orpheline. Elle tient pourtant le node
    gamescope, et Chromium ne le relâche pas tant qu'il croit la session ouverte
    — le relais trouvait alors une source impossible à ouvrir. SIGUSR1 déclenche
    close_all() côté shim, qui émet Session.Closed et fait tout relâcher.
    Le nettoyage d'orphelines de CreateSession (#26) ne couvre pas ce chemin :
    le repli n'ouvre aucune session, donc il ne se déclenche jamais ici.

    On vise un PID lu dans un pidfile, JAMAIS `pkill -f portal_shim.py` : ce
    motif matche aussi un shell ou un éditeur dont la ligne de commande cite le
    fichier, et l'action par défaut de SIGUSR1 est de TUER. Le pidfile pouvant
    être périmé (PID recyclé par le noyau), on relit /proc/<pid>/cmdline pour
    confirmer que c'est bien notre shim avant de signaler.
    """
    try:
        with open(_shim_pid_path()) as f:
            pid = int(f.read().strip())
    except Exception:
        return                      # pas de shim (mode bureau) : rien à libérer
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read().decode("utf-8", "replace")
    except OSError:
        log.info("[screen] pidfile shim périmé (processus absent)")
        return
    if "portal_shim.py" not in cmdline:
        log.warning(f"[screen] PID {pid} n'est pas portal_shim.py — pas de signal")
        return
    try:
        os.kill(pid, signal.SIGUSR1)
        log.info(f"[screen] SIGUSR1 -> portal_shim ({pid}) : sessions portail relâchées")
        # Laisser Chromium traiter le Closed et fermer son flux PipeWire avant
        # qu'on tente d'ouvrir le node.
        time.sleep(0.5)
    except OSError as e:
        log.warning(f"[screen] SIGUSR1 portal_shim KO: {e!r}")


def _find_screen_node():
    """Trouve le node PipeWire de l'écran (gamescope publie l'écran complet en mode
    jeu Steam → capturable SANS portail/dialogue). Log tous les nodes vidéo pour
    diagnostic. Renvoie l'id du node (str) ou None (→ pipewiresrc par défaut)."""
    import json
    from subprocess import run, PIPE, DEVNULL
    try:
        # timeout : un PipeWire qui n'enregistre plus de clients laisse pw-dump
        # pendu pour toujours (wedge du 19/07) — mieux vaut un fallback propre.
        data = json.loads(run(["pw-dump"], stdout=PIPE, stderr=DEVNULL,
                              timeout=5, text=True).stdout)
    except Exception as e:
        log.warning(f"[screen] pw-dump KO: {e!r}")
        return None
    vids = []
    for n in data:
        if not str(n.get("type", "")).endswith("Node"):
            continue
        p = (n.get("info", {}) or {}).get("props", {}) or {}
        mc = str(p.get("media.class", ""))
        name = str(p.get("node.name", ""))
        desc = str(p.get("node.description", ""))
        blob = (mc + " " + name + " " + desc).lower()
        # Exclure NOTRE webcam virtuelle (v4l2loopback /dev/video42 "Steamcord Screen")
        # et tout loopback v4l2 : ce n'est PAS l'écran. Sinon, en BUREAU (où aucun node
        # gamescope n'existe), on capturerait ce loopback vide → écran noir au lieu de
        # laisser le client basculer sur le portail natif.
        if "v4l2" in blob or "video42" in blob or "steamcord" in blob or "loopback" in blob:
            continue
        if "video/source" in mc.lower() or "gamescope" in blob or "screen" in blob or "video/output" in mc.lower():
            vids.append((n.get("id"), name, mc))
    log.info(f"[screen] nodes vidéo candidats: {vids}")
    # Préférence : un node gamescope/screen explicite, sinon le 1er Video/Source.
    for nid, name, mc in vids:
        if "gamescope" in (name.lower()) or "screen" in (name.lower()):
            return str(nid)
    for nid, name, mc in vids:
        if "video/source" in mc.lower():
            return str(nid)
    return None


def get_payload_types(sdpmsg, video_encoding, audio_encoding):
    video_pt = None
    audio_pt = None

    for i in range(0, sdpmsg.medias_len()):
        media = sdpmsg.get_media(i)

        for j in range(0, media.formats_len()):
            fmt = media.get_format(j)

            if fmt == "webrtc-datachannel":
                continue

            pt = int(fmt)
            caps = media.get_caps_from_media(pt)
            s = caps.get_structure(0)
            encoding_name = s.get_string("encoding-name")

            if video_pt is None and encoding_name == video_encoding:
                video_pt = pt

            elif audio_pt is None and encoding_name == audio_encoding:
                audio_pt = pt

    ret = {video_encoding: video_pt, audio_encoding: audio_pt}
    print(ret)
    return ret


class WebRTCServer:
    def __init__(self, loop=None) -> None:
        Gst.init(None)

        self.loop = loop
        self.app = web.Application()
        self.app.add_routes([web.get("/webrtc", self.websocket_handler)])

        # #42 : close_pipeline() lit self.pipe, or il n'était posé que par
        # start_pipeline(). Tout chemin qui ferme la WS SANS avoir bâti de
        # pipeline — `no_source` en bureau, et depuis v1.25.0 `missing_plugins` —
        # levait AttributeError dans le nettoyage du handler.
        self.pipe = None
        self.webrtc = None
        self.remote_ws = None

    def start_pipeline(self, create_offer=True, audio_pt=96, video_pt=97):
        # run+timeout : pactl pend pour toujours si PipeWire est wedgé (19/07).
        from subprocess import run, PIPE, DEVNULL
        try:
            default_sink = run(["pactl", "get-default-sink"], stdout=PIPE,
                               stderr=DEVNULL, timeout=5, text=True).stdout.splitlines()
        except Exception:
            default_sink = []
        audio_monitor = (default_sink[0] + ".monitor") if default_sink and default_sink[0] else "@DEFAULT_MONITOR@"
        log.info(f"Creating pipeline, create_offer={create_offer}, audio_monitor={audio_monitor}")
        node = _find_screen_node()
        video_src = f"pipewiresrc path={node}" if node else "pipewiresrc"
        log.info(f"[screen] source vidéo: {video_src}")
        desc = PIPELINE_DESC.format(video_src=video_src, video_pt=video_pt, audio_pt=audio_pt, monitor=audio_monitor)
        log.info("Pipeline:\n" + desc)
        try:
            self.pipe = Gst.parse_launch(desc)
        except Exception as e:
            log.error(f"Failed to build pipeline: {e}")
            raise
        self.webrtc = self.pipe.get_by_name("send")
        self.webrtc.connect("on-negotiation-needed", self.on_negotiation_needed, create_offer)
        self.webrtc.connect("on-ice-candidate", self.send_ice_candidate_message)
        # Surface pipeline errors instead of failing silently (whole-screen capture diagnosis)
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_bus_error)
        ret = self.pipe.set_state(Gst.State.PLAYING)
        log.info(f"Pipeline set_state(PLAYING) → {ret}")

    def _on_bus_error(self, _bus, msg):
        err, dbg = msg.parse_error()
        log.error(f"GStreamer pipeline error: {err} | debug: {dbg}")

    def close_pipeline(self):
        if self.pipe:
            self.pipe.set_state(Gst.State.NULL)
            self.pipe = None

        self.webrtc = None
    
    def on_negotiation_needed(self, _, create_offer):
        if create_offer:
            log.info('Call was connected: creating offer')
            promise = Gst.Promise.new_with_change_func(self.on_offer_created, None, None)
            self.webrtc.emit('create-offer', None, promise)

    def send_ice_candidate_message(self, _, mlineindex, candidate):
        icemsg = {'ice': {'candidate': candidate, 'sdpMLineIndex': mlineindex}}
        run_coroutine_threadsafe(self.remote_ws.send_json(icemsg), self.loop)

    def on_offer_set(self, promise, _, __):
        assert promise.wait() == Gst.PromiseResult.REPLIED
        promise = Gst.Promise.new_with_change_func(self.on_answer_created, None, None)
        self.webrtc.emit("create-answer", None, promise)

    def on_answer_created(self, promise, _, __):
        assert promise.wait() == Gst.PromiseResult.REPLIED
        reply = promise.get_reply()
        answer = reply.get_value("answer")
        promise = Gst.Promise.new()
        self.webrtc.emit("set-local-description", answer, promise)
        promise.interrupt()
        print(answer)
        self.send_sdp(answer)

    def send_sdp(self, offer):
        text = offer.sdp.as_text()
        log.info("Sending answer:\n%s" % text)
        msg = {'sdp': {'type': 'answer', 'sdp': text}}
        run_coroutine_threadsafe(self.remote_ws.send_json(msg), self.loop)

    async def websocket_handler(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.remote_ws = ws

        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = msg.json()

                if "offer" in data:
                    res, sdpmsg = GstSdp.SDPMessage.new_from_text(data["offer"]["sdp"])

                    if not self.webrtc:
                        # Pas de node écran capturable (= mode BUREAU : aucun node
                        # gamescope, et le portail xdg N'EST PAS un node PipeWire
                        # direct) → on NE bâtit PAS un pipeline noir. On signale
                        # `no_source` : le client basculera sur le getDisplayMedia
                        # NATIF (portail KDE), qui marche en bureau. En gamemode le
                        # node gamescope existe → on continue normalement (gst).
                        # Avant toute chose : un GStreamer incomplet ne donnera
                        # jamais de pipeline. Le dire explicitement vaut mieux que
                        # de laisser le client conclure « aucune source » (#38).
                        missing = _missing_gst_elements()
                        if missing:
                            details = ", ".join(f"{n} ({p})" for n, p in missing)
                            log.error(f"[gst] éléments GStreamer manquants → Go Live impossible: {details}")
                            await ws.send_json({
                                "missing_plugins": [n for n, _ in missing],
                                "packages": sorted({p for _, p in missing}),
                            })
                            await ws.close()
                            break
                        _release_portal_sessions()
                        if _find_screen_node() is None:
                            log.info("[screen] aucune source d'écran directe (bureau) → no_source, bascule portail natif côté client")
                            await ws.send_json({"no_source": True})
                            await ws.close()
                            break
                        log.info("Incoming call: received an offer, creating pipeline")
                        pts = get_payload_types(sdpmsg, video_encoding="VP8", audio_encoding="OPUS")
                        assert "VP8" in pts
                        assert "OPUS" in pts
                        self.start_pipeline(create_offer=False, video_pt=pts["VP8"], audio_pt=pts["OPUS"])

                    assert self.webrtc
                    offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdpmsg)
                    promise = Gst.Promise.new_with_change_func(self.on_offer_set, None, None)
                    self.webrtc.emit("set-remote-description", offer, promise)

                elif "ice" in data:
                    assert self.webrtc
                    candidate = data['ice']['candidate']
                    sdpmlineindex = data['ice']['sdpMLineIndex']
                    self.webrtc.emit('add-ice-candidate', sdpmlineindex, candidate)

                elif "stop" in data:
                    await ws.close()
                    break

        self.close_pipeline()
        return ws


def main():
    # Python 3.14: no implicit event loop, and aiohttp removed run_app(loop=...).
    # Create the loop explicitly so GStreamer callback threads can target it via
    # run_coroutine_threadsafe.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    server = WebRTCServer(loop=loop)
    runner = web.AppRunner(server.app)
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, "0.0.0.0", 65124)
    loop.run_until_complete(site.start())
    log.info("WebRTC screenshare server listening on :65124")
    loop.run_forever()


if __name__ == "__main__":
    main()