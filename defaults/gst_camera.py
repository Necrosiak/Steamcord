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


def build_pipeline(node):
    src = f"pipewiresrc path={node}" if node else "pipewiresrc"
    desc = (
        f"{src} do-timestamp=true ! videoconvert ! videoscale ! videorate ! "
        f"video/x-raw,format=YUY2,width={WIDTH},height={HEIGHT},framerate={FPS}/1 ! "
        f"v4l2sink device={DEVICE} sync=false"
    )
    log.info("Pipeline: " + desc)
    return Gst.parse_launch(desc)


def main():
    Gst.init(None)
    loop = GLib.MainLoop()

    # Attendre qu'un node écran existe (le jeu peut démarrer après nous).
    node = None
    for _ in range(120):
        node = find_screen_node()
        if node:
            break
        log.info("aucun node écran pour l'instant, attente…")
        time.sleep(2)

    pipe = build_pipeline(node)
    bus = pipe.get_bus()
    bus.add_signal_watch()

    def on_error(_bus, msg):
        err, dbg = msg.parse_error()
        log.error(f"gst error: {err} | {dbg}")
        loop.quit()

    bus.connect("message::error", on_error)
    bus.connect("message::eos", lambda *_: (log.info("EOS"), loop.quit()))
    ret = pipe.set_state(Gst.State.PLAYING)
    log.info(f"set_state(PLAYING) → {ret} (device={DEVICE}, node={node})")
    try:
        loop.run()
    finally:
        pipe.set_state(Gst.State.NULL)


if __name__ == "__main__":
    main()
