"""Check that one WebM burst yields multiple paced Cairo updates."""

import importlib.util
import pathlib
import sys
import time

spec = importlib.util.spec_from_file_location("overlay_test", pathlib.Path(sys.argv[1]))
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class Area:
    def __init__(self):
        self.frames = []

    def set_pov_frame(self, uid, data, width, height):
        self.frames.append((uid, data, width, height, time.monotonic()))


area = Area()
receiver = overlay.PovReceiver(area)
loop = overlay.GLib.MainLoop()
for number in range(4):
    receiver._frame("test", bytes([number]), 1, 1)
overlay.GLib.timeout_add(170, loop.quit)
loop.run()
assert [frame[1] for frame in area.frames] == [bytes([n]) for n in range(4)], area.frames
gaps = [area.frames[i + 1][4] - area.frames[i][4] for i in range(3)]
assert all(0.020 <= gap <= 0.065 for gap in gaps), gaps
print("Frame pacing OK: 4 images from one burst, gaps:", [round(g, 3) for g in gaps])
