#!/usr/bin/env python
# Aperçu du Go Live NATIF : capture le node PipeWire gamescope et écrit un JPEG
# toutes les 2s → /tmp/steamcord-golive-preview.jpg (écriture atomique), servi
# en base64 par main.get_golive_preview(). Aucun v4l2 : quand le partage passe
# par le portail (portal_shim), la capture vit DANS le Chromium de Vesktop et
# le QAM n'a aucune poignée dessus — ce feeder léger ne sert que l'aperçu.
#
# Tourne comme sous-process (stdout/stderr → stream_watcher, préfixe [gstprev]).
# Boucle de reconnexion : le node gamescope peut changer d'id → on re-cherche.

import os
import sys
import time
import logging
from gi import require_version  # type: ignore

logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(levelname)s %(name)s: %(message)s", force=True)
log = logging.getLogger("golivepreview")

require_version("Gst", "1.0")
from gi.repository import Gst, GLib  # type: ignore

# Même détection de node que le feeder webcam virtuelle (fichier voisin).
from gst_camera import find_screen_node  # noqa: E402

PREVIEW = "/tmp/steamcord-golive-preview.jpg"
# Petit et léger : c'est une vignette de QAM, pas un flux.
WIDTH, HEIGHT = 640, 360


def run_once(node):
    """Un pipeline de capture → JPEG/2s. True = arrêt normal, False = erreur."""
    loop = GLib.MainLoop()
    ok = {"value": True}
    # jpegenc DANS le pipeline : chaque sample de l'appsink EST un JPEG complet,
    # écrit tel quel (atomique via .tmp + rename). PAS de videorate : le node
    # gamescope ne livre des frames QUE sur changement d'écran (1 frame/10s
    # possible sur écran statique — mesuré), videorate attendrait 2 frames pour
    # en émettre une → famine. On écrit chaque frame reçue, throttlée à ~1/2s
    # dans on_sample (écran statique = aperçu inchangé, c'est le comportement
    # attendu).
    desc = (
        f"pipewiresrc path={node} do-timestamp=true ! videoconvert ! "
        f"videoscale ! video/x-raw,width={WIDTH},height={HEIGHT} ! "
        f"jpegenc quality=75 ! "
        f"appsink name=asink emit-signals=true max-buffers=2 drop=true sync=false"
    )
    log.info("Pipeline: " + desc)
    pipe = Gst.parse_launch(desc)
    bus = pipe.get_bus()
    bus.add_signal_watch()

    def on_error(_bus, msg):
        err, dbg = msg.parse_error()
        log.error(f"gst error: {err} | {dbg}")
        ok["value"] = False
        loop.quit()

    bus.connect("message::error", on_error)
    bus.connect("message::eos", lambda *_: (log.info("EOS"), loop.quit()))

    stats = {"n": 0, "last_write": 0.0}

    def on_sample(sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        # Throttle : au plus une écriture JPEG toutes les 2s (l'aperçu QAM est
        # pollé à ce rythme), même si le jeu pousse 60 frames/s.
        now = time.monotonic()
        if stats["n"] and now - stats["last_write"] < 2.0:
            return Gst.FlowReturn.OK
        buf = sample.get_buffer()
        got, mi = buf.map(Gst.MapFlags.READ)
        if not got:
            return Gst.FlowReturn.OK
        try:
            data = bytes(mi.data)
        finally:
            buf.unmap(mi)
        stats["last_write"] = now
        try:
            with open(PREVIEW + ".tmp", "wb") as f:
                f.write(data)
            os.replace(PREVIEW + ".tmp", PREVIEW)
        except OSError as e:
            log.warning(f"écriture {PREVIEW} KO: {e!r}")
        stats["n"] += 1
        if stats["n"] == 1:
            log.info(f"premier aperçu écrit → {PREVIEW} ({len(data)} octets)")
        return Gst.FlowReturn.OK

    pipe.get_by_name("asink").connect("new-sample", on_sample)
    ret = pipe.set_state(Gst.State.PLAYING)
    log.info(f"set_state(PLAYING) → {ret} (node={node})")
    try:
        loop.run()
    finally:
        pipe.set_state(Gst.State.NULL)
    return ok["value"]


def main():
    Gst.init(None)
    fails = 0
    while True:
        node = find_screen_node()
        if not node:
            fails += 1
            log.info("aucun node écran PipeWire, attente…")
            time.sleep(min(2 + fails, 30))
            continue
        if run_once(node):
            break  # arrêt demandé (process tué par stop_golive_preview)
        fails += 1
        time.sleep(min(2 + fails, 30))


if __name__ == "__main__":
    try:
        main()
    finally:
        # Pas d'aperçu périmé au prochain montage de la tuile.
        try:
            os.remove(PREVIEW)
        except OSError:
            pass
