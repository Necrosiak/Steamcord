#!/usr/bin/env python
# Feeder « webcam virtuelle » : capture l'écran gamescope (node PipeWire direct —
# le SEUL chemin qui marche en mode jeu, gamescope n'ayant pas de portail) et le
# pousse dans /dev/video42 (v4l2loopback "Steamcord Screen"). Discord l'utilise
# ensuite comme CAMÉRA (getUserMedia), ce qui contourne entièrement le partage
# d'écran Go Live (portail → écran noir en gamescope).
#
# Tourne comme sous-process (stdout/stderr capturés par stream_watcher → préfixe
# [gstcam] au journal Steamcord). Boucle de reconnexion : le node gamescope
# n'existe que pendant le jeu et change d'id → on le re-cherche tant qu'absent.

import fcntl
import os
import struct
import sys
import time
import json
import logging
from subprocess import getoutput
from gi import require_version  # type: ignore

logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(levelname)s %(name)s: %(message)s", force=True)
log = logging.getLogger("screencam")

require_version("Gst", "1.0")
from gi.repository import Gst, GLib  # type: ignore

DEVICE = "/dev/video42"
# Discord/Chromium aime un format simple et borné. YUY2 720p30 = sûr.
WIDTH, HEIGHT, FPS = 1280, 720, 30

# --- Écriture write() dans le loopback (remplace v4l2sink MMAP + keepalive) ---
# v4l2loopback n'accepte qu'UN SEUL lecteur en streaming : l'ancien lecteur
# « keepalive » occupait cette place → Discord recevait NotReadableError
# (« Could not start video source ») en ouvrant la caméra → self_video annoncé
# au gateway mais AUCUNE frame envoyée = écran vide chez les autres (prouvé via
# CDP le 02/07). En sortie write() (comme ffmpeg/OBS), le writer n'a besoin
# d'AUCUN lecteur pour survivre ET le device s'annonce CAPTURE (exclusive_caps)
# tant qu'on le tient ouvert → Discord devient le lecteur unique. NB : gst
# v4l2sink io-mode=rw ne déclenche PAS le flip CAPTURE, d'où le S_FMT manuel.
VIDIOC_S_FMT = 0xC0D05605  # _IOWR('V', 5, struct v4l2_format), x86_64
V4L2_BUF_TYPE_VIDEO_OUTPUT = 2
V4L2_FIELD_NONE = 1
FOURCC_YUYV = 0x56595559


def open_device_out():
    """Ouvre DEVICE en écriture et déclare le format de sortie (YUYV WxH).
    Renvoie le fd ; chaque os.write() d'une frame complète = 1 frame publiée."""
    fd = os.open(DEVICE, os.O_RDWR)
    pix = struct.pack("<12I", WIDTH, HEIGHT, FOURCC_YUYV, V4L2_FIELD_NONE,
                      WIDTH * 2, WIDTH * 2 * HEIGHT, 8, 0, 0, 0, 0, 0)
    fmt = bytearray(struct.pack("<I4x", V4L2_BUF_TYPE_VIDEO_OUTPUT) + pix)
    fmt += b"\x00" * (208 - len(fmt))  # sizeof(struct v4l2_format) = 208
    try:
        fcntl.ioctl(fd, VIDIOC_S_FMT, fmt)
    except OSError:
        os.close(fd)
        raise
    return fd


def find_screen_node():
    """Node PipeWire de l'écran gamescope (publie l'écran complet en mode jeu).
    Renvoie l'id (str) ou None."""
    try:
        data = json.loads(getoutput("pw-dump"))
    except Exception as e:
        log.warning(f"pw-dump KO: {e!r}")
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
        # NE JAMAIS capturer notre PROPRE loopback (/dev/video42 « Steamcord Screen »)
        # ni un autre périphérique v4l2 : sinon le feeder se filme lui-même = écran
        # noir. Le node 58 (v4l2_input…video42, classe Video/Source, nom « …screen »)
        # matchait à la fois "screen" ET "video/source" → il était choisi à tort,
        # en Bureau ET potentiellement en gamemode (selon l'ordre de pw-dump).
        if ("video42" in blob or "steamcord" in blob or "loopback" in blob
                or "v4l2" in name.lower()):
            continue
        if "video/source" in mc.lower() or "gamescope" in blob or "screen" in blob or "video/output" in mc.lower():
            vids.append((n.get("id"), name, mc))
    if vids:
        log.info(f"nodes vidéo candidats: {vids}")
    for nid, name, mc in vids:
        if "gamescope" in name.lower() or "screen" in name.lower():
            return str(nid)
    for nid, name, mc in vids:
        if "video/source" in mc.lower():
            return str(nid)
    return None


def find_x_display():
    """Display X imbriqué de gamescope où le JEU est rendu. gamescope crée un X
    nested (typiquement :1) pour le contenu jeu, :0 = UI Steam. On préfère :1.
    Inspiré de decky-streamer (ximagesrc DISPLAY=:1, capture fiable sans portail
    ni node PipeWire). Renvoie ":1"/":0" ou None."""
    try:
        socks = getoutput("ls /tmp/.X11-unix/ 2>/dev/null")
    except Exception as e:
        log.warning(f"ls .X11-unix KO: {e!r}")
        socks = ""
    order = []
    if "X1" in socks:
        order.append(":1")
    if "X0" in socks:
        order.append(":0")
    if not order:
        order = [":0"]
    log.info(f"displays X candidats: {socks!r} → essai {order}")
    return order[0]


def build_pipeline(backend, node=None, display=None):
    """backend = 'pipewire' (node gamescope) | 'ximagesrc' (X nested :1)."""
    if backend == "ximagesrc":
        src = (f"ximagesrc display-name={display} use-damage=0 "
               f"show-pointer=false do-timestamp=true")
    else:
        src = (f"pipewiresrc path={node}" if node else "pipewiresrc") + " do-timestamp=true"
    desc = (
        f"{src} ! videoconvert ! videoscale ! videorate ! "
        f"video/x-raw,format=YUY2,width={WIDTH},height={HEIGHT},framerate={FPS}/1 ! "
        f"appsink name=asink emit-signals=true max-buffers=4 drop=true sync=false"
    )
    log.info(f"Pipeline ({backend}): " + desc)
    return Gst.parse_launch(desc)


def run_backend(backend, node, display):
    """Lance un pipeline pour un backend donné. Renvoie True si arrêt normal
    (EOS/stop), False si erreur GStreamer (→ l'appelant bascule de backend)."""
    loop = GLib.MainLoop()
    ok = {"value": True}
    pipe = build_pipeline(backend, node=node, display=display)
    bus = pipe.get_bus()
    bus.add_signal_watch()

    # GLib.timeout_add pose ses callbacks sur le contexte GLOBAL, pas sur ce loop.
    # Sans nettoyage, les retries en attente d'une itération qui a échoué se
    # redéclenchent TOUS dans l'itération suivante (« 7× démarré d'un coup » +
    # tempête → fuite FD). On trace chaque source et on les retire à la sortie.
    sources = []

    def add_timeout(ms, fn):
        sid = GLib.timeout_add(ms, fn)
        sources.append(sid)
        return sid

    # Le device doit être ouvert + S_FMT AVANT que Discord n'énumère : c'est la
    # présence du writer qui fait annoncer CAPTURE (exclusive_caps=1).
    try:
        dev_fd = open_device_out()
        log.info(f"{DEVICE} ouvert en écriture (S_FMT YUYV {WIDTH}x{HEIGHT}) — "
                 f"device annoncé CAPTURE, Discord sera le lecteur unique")
    except OSError as e:
        log.error(f"ouverture {DEVICE} KO: {e!r}")
        return False

    def on_error(_bus, msg):
        err, dbg = msg.parse_error()
        log.error(f"gst error ({backend}): {err} | {dbg}")
        ok["value"] = False
        loop.quit()

    bus.connect("message::error", on_error)
    bus.connect("message::eos", lambda *_: (log.info("EOS"), loop.quit()))

    # --- Écriture des frames + compteur -----------------------------------
    # set_state(PLAYING) ne prouve PAS que gamescope livre des buffers : on
    # compte les frames réellement écrites + on loggue les caps négociées une
    # seule fois. Verdict net : >0 frames/s = ça coule (problème côté Discord) ;
    # 0 frame = gamescope ne capture rien (source à changer). Log ~1×/10s.
    stats = {"n": 0, "logged_caps": False, "last_log": 0.0}
    # Snapshot diag : on copie la ~90e frame réellement écrite et on l'encode en
    # JPEG hors du thread de streaming. (Un 2e lecteur v4l2src est proscrit :
    # v4l2loopback n'accepte qu'un lecteur, ce serait voler la place de Discord.)
    snapbuf = {"data": None, "caps": None}

    def on_sample(sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        buf = sample.get_buffer()
        got, mi = buf.map(Gst.MapFlags.READ)
        if not got:
            return Gst.FlowReturn.OK
        try:
            data = bytes(mi.data)
        finally:
            buf.unmap(mi)
        try:
            os.write(dev_fd, data)
        except OSError as e:
            log.error(f"write {DEVICE} KO: {e!r}")
            ok["value"] = False
            loop.quit()
            return Gst.FlowReturn.ERROR
        stats["n"] += 1
        # 90e frame → snapshot diag one-shot ; ensuite copie rafraîchie toutes
        # les ~60 frames (2s) pour l'aperçu QAM encodé par write_preview.
        if stats["n"] == 90 or stats["n"] % 60 == 0:
            snapbuf["data"] = data
            snapbuf["caps"] = sample.get_caps()
            if stats["n"] == 90:
                add_timeout(0, write_snapshot)
        now = time.monotonic()
        if not stats["logged_caps"]:
            caps = sample.get_caps()
            log.info(f"PREMIÈRE FRAME écrite vers {DEVICE} — caps négociées: "
                     f"{caps.to_string() if caps else '?'}")
            stats["logged_caps"] = True
            stats["last_log"] = now
        elif now - stats["last_log"] >= 10.0:
            log.info(f"frames écrites vers {DEVICE}: total={stats['n']}")
            stats["last_log"] = now
        return Gst.FlowReturn.OK

    asink = pipe.get_by_name("asink")
    if asink is not None:
        asink.connect("new-sample", on_sample)
    # Filet : si AUCUNE frame n'est arrivée après 5s, on le crie fort.
    def warn_if_no_frames():
        if stats["n"] == 0:
            log.warning(f"AUCUNE frame poussée vers {DEVICE} après 5s "
                        f"(backend={backend}, node={node}) — gamescope ne livre "
                        f"rien sur cette source → écran noir garanti.")
        return False
    add_timeout(5000, warn_if_no_frames)

    # --- Snapshot diagnostic --------------------------------------------
    # Encode en JPEG la frame copiée par la sonde (voir snapbuf). Permet de
    # TRANCHER : image noire → gamescope ne livre rien d'utile (changer de
    # source) ; vraie image → le contenu est bon, le noir vient de Discord.
    SNAP = os.path.expanduser("~/steamcord-snap.jpg")

    def encode_snapbuf(path):
        """Encode la frame copiée par la sonde en JPEG → path. (ok, détail)."""
        sp = Gst.parse_launch(
            f"appsrc name=snapsrc ! videoconvert ! jpegenc ! "
            f"filesink location={path}")
        asrc = sp.get_by_name("snapsrc")
        asrc.set_property("caps", snapbuf["caps"])
        asrc.set_property("format", Gst.Format.TIME)
        sp.set_state(Gst.State.PLAYING)
        asrc.emit("push-buffer", Gst.Buffer.new_wrapped(snapbuf["data"]))
        asrc.emit("end-of-stream")
        msg = sp.get_bus().timed_pop_filtered(
            5 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
        sp.set_state(Gst.State.NULL)
        size = os.path.getsize(path) if os.path.exists(path) else 0
        if msg is not None and msg.type == Gst.MessageType.ERROR:
            e, d = msg.parse_error()
            return False, f"encode: {e} | {d}"
        if size <= 0:
            return False, f"fichier vide ({path})"
        return True, f"{size} octets"

    def write_snapshot():
        try:
            ok2, detail = encode_snapbuf(SNAP)
            if ok2:
                log.info(f"snapshot écrit → {SNAP} ({detail}) — frame "
                         f"réellement poussée vers {DEVICE}")
            else:
                log.warning(f"snapshot KO: {detail}")
        except Exception as e:
            log.warning(f"snapshot KO: {e!r}")
        return False

    # --- Aperçu QAM -------------------------------------------------------
    # Le CEF de Steam (QAM) ne peut PAS ouvrir /dev/video42 par getUserMedia
    # en gamescope (pas d'accès caméra) — vu 02/07 : le SelfPreview affichait
    # « aucun écran mode jeu » alors que le pipeline coulait. À la place, on
    # encode la dernière frame copiée toutes les 2s vers PREVIEW (tmpfs,
    # écriture atomique), servi en base64 par main.get_camera_preview().
    PREVIEW = "/tmp/steamcord-preview.jpg"

    def write_preview():
        if snapbuf["data"] is None:
            return True
        try:
            ok2, _ = encode_snapbuf(PREVIEW + ".tmp")
            if ok2:
                os.replace(PREVIEW + ".tmp", PREVIEW)
        except Exception:
            pass
        return True  # timer répétitif

    add_timeout(2000, write_preview)

    ret = pipe.set_state(Gst.State.PLAYING)
    log.info(f"set_state(PLAYING) → {ret} (backend={backend}, device={DEVICE}, node={node}, display={display})")
    try:
        loop.run()
    finally:
        # Retirer TOUS les timeouts encore en attente (sinon ils refireront dans
        # l'itération suivante → tempête de pipelines + fuite FD).
        for sid in sources:
            try:
                GLib.source_remove(sid)
            except Exception:
                pass
        pipe.set_state(Gst.State.NULL)
        # Fermer le writer EN DERNIER : le device repasse OUTPUT-only à la
        # fermeture (exclusive_caps) et disparaît des videoinputs de Discord.
        try:
            os.close(dev_fd)
        except OSError:
            pass
    return ok["value"]


def main():
    Gst.init(None)

    # On tente d'abord le node PipeWire gamescope (capture "officielle"), mais
    # sans s'éterniser : il est capricieux/absent. Attente courte (~30s).
    node = None
    for _ in range(15):
        node = find_screen_node()
        if node:
            break
        log.info("aucun node écran PipeWire pour l'instant, attente…")
        time.sleep(2)
    display = find_x_display()

    # Stratégies de capture, par ordre de préférence, avec bascule auto en cas
    # d'erreur GStreamer (boucle infinie jusqu'à arrêt explicite) :
    #   1. pipewiresrc path=<node gamescope>   (si node trouvé)
    #   2. pipewiresrc            (plain, PipeWire choisit la source par défaut —
    #      c'est le chemin par défaut de decky-streamer, souvent le plus fiable)
    #   3. ximagesrc display=:1   (X nested du jeu — dernier recours)
    strategies = []
    if node:
        strategies.append(("pipewire", node, None))
    strategies.append(("pipewire", None, None))
    strategies.append(("ximagesrc", None, display))

    i = 0
    fails = 0
    while True:
        backend, n, disp = strategies[i % len(strategies)]
        normal = run_backend(backend, n, disp)
        if normal:
            break  # arrêt demandé (process tué par stop_screen_camera)
        # erreur → stratégie suivante, petite pause anti-boucle-folle.
        # Si le node a disparu (jeu quitté), on re-cherche pour le prochain tour.
        if n and not find_screen_node():
            try:
                strategies = [s for s in strategies if not (s[0] == "pipewire" and s[1])]
            except Exception:
                pass
        i += 1
        fails += 1
        # Backoff progressif : quand AUCUNE source ne marche (typiquement hors
        # gamescope, en Bureau), spinner à 2s épuisait les FD. On plafonne à 30s.
        time.sleep(min(2 + fails, 30))


if __name__ == "__main__":
    main()
