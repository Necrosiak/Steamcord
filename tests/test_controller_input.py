"""Controller buttons read outside Steam's UI (input_watch): Steam Controller
(2026), Steam Deck built-in controller and evdev gamepads (incl. Steam's
virtual gamepad) must all map to the same Steam button ids."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "defaults"))
import input_watch as iw  # noqa: E402


class _Loop:
    def add_reader(self, *a):
        pass

    def remove_reader(self, *a):
        pass


class ControllerInputTest(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.watcher = iw.HidControllerWatcher(_Loop(), lambda held: self.seen.append(sorted(held)))

    def feed(self, node, *chunks):
        r, w = os.pipe()
        os.set_blocking(r, False)
        self.watcher._fds[r] = node
        self.watcher._masks[r] = frozenset()
        for chunk in chunks:
            os.write(w, chunk)
            self.watcher._readable(r)
        os.close(w)
        self.watcher._drop(r)

    def test_steam_deck(self):
        report = bytearray(64)
        report[0], report[2], report[3] = 0x01, iw.HID_DECK_STATE, 0x40
        report[8:16] = (0x80 | (1 << 41)).to_bytes(8, "little")  # A + L4
        self.feed("hidraw9", bytes(report))
        self.assertEqual(self.seen[0], [0, 44])

    def test_steam_controller(self):
        report = bytearray(64)
        report[0] = 0x42
        report[2:6] = (0x00040000 | 0x1).to_bytes(4, "little")  # L5 + A
        self.feed("hidraw9", bytes(report))
        self.assertEqual(self.seen[0], [0, 32])

    def test_evdev_gamepad_buttons_and_hat(self):
        ev = lambda t, c, v: iw._EVENT.pack(0, 0, t, c, v)
        self.feed("input/event99",
                  ev(1, 0x130, 1) + ev(3, iw.ABS_HAT0Y, -1),   # A + up
                  ev(1, 0x130, 0) + ev(3, iw.ABS_HAT0Y, 0),    # release
                  ev(1, 0x133, 1))                             # Y (BTN_NORTH)
        self.assertEqual(self.seen[:3], [[0, 20], [], [3]])

    def test_same_button_from_two_sources_counts_once(self):
        ev = lambda t, c, v: iw._EVENT.pack(0, 0, t, c, v)
        r1, w1 = os.pipe()
        r2, w2 = os.pipe()
        for r, node in ((r1, "input/event1"), (r2, "input/event2")):
            os.set_blocking(r, False)
            self.watcher._fds[r] = node
            self.watcher._masks[r] = frozenset()
        os.write(w1, ev(1, 0x130, 1)); self.watcher._readable(r1)
        os.write(w2, ev(1, 0x130, 1)); self.watcher._readable(r2)
        os.write(w1, ev(1, 0x130, 0)); self.watcher._readable(r1)
        self.assertEqual(self.seen, [[0]])  # still held via the second source
        os.write(w2, ev(1, 0x130, 0)); self.watcher._readable(r2)
        self.assertEqual(self.seen, [[0], []])


if __name__ == "__main__":
    unittest.main()
