#!/usr/bin/env python3
"""Check that a built plugin zip carries everything BOTH hosts need.

One zip has to work on the Steam Deck (Linux) and in Steam Big Picture on Windows,
so the release gate looks for the shared core, the Linux-only helpers (Deck) and
the Windows layer, and that the backend and the frontend bundle agree on the
platform API. Decky flattens `defaults/` into the plugin root on install, and the
CLI may or may not nest everything under a top-level folder, so both layouts are
accepted.

usage: check_release_zip.py <plugin.zip>
"""

import re
import sys
import zipfile

SHARED = [
    "main.py", "plugin.json", "package.json", "dist/index.js",
    "steamcord_client.js", "webrtc_client.js", "updater.py", "vesktop.py",
    "discord_client/event_handler.py", "tab_utils/cdp.py", "tab_utils/tab.py",
]
WINDOWS = ["sc_platform.py", "vesktop_windows.py"]
DECK = ["portal_shim.py", "gst_webrtc.py", "gst_camera.py", "input_watch.py",
        "game_overlay/overlay.py", "py_modules/dbus_next/__init__.py"]


def main(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        read = lambda n: z.read(n).decode("utf-8", "replace")

        def find(rel):
            """Zip member for `rel`, at the root, under defaults/, or nested one folder deep."""
            for cand in names:
                parts = cand.split("/")
                for start in range(0, min(2, len(parts))):
                    tail = "/".join(parts[start:])
                    if tail == rel or tail == f"defaults/{rel}":
                        return cand
            return None

        problems = []
        for group, rels in (("shared", SHARED), ("windows", WINDOWS), ("steam deck", DECK)):
            for rel in rels:
                if not find(rel):
                    problems.append(f"missing {group} file: {rel}")
        if problems:
            return problems

        # Python must at least compile (catches a bad edit in the flattened copy too)
        for rel in ("main.py", "vesktop.py", "sc_platform.py", "vesktop_windows.py"):
            try:
                compile(read(find(rel)), rel, "exec")
            except SyntaxError as e:
                problems.append(f"{rel} does not compile: {e}")

        # backend and bundle agree on the platform API
        bundle = read(find("dist/index.js"))
        if "get_platform_caps" not in bundle:
            problems.append("dist/index.js does not call get_platform_caps (stale frontend build?)")
        if "async def get_platform_caps" not in read(find("main.py")):
            problems.append("main.py lacks get_platform_caps")

        # the Windows layer must be wired in, not just shipped
        vest = read(find("vesktop.py"))
        if "import vesktop_windows" not in vest:
            problems.append("vesktop.py does not import vesktop_windows")
        if not re.search(r"^import sc_platform", read(find("main.py")), re.M):
            problems.append("main.py does not import sc_platform")

        # nothing may ship that shadows the standard library
        for n in names:
            if re.search(r"(^|/)platform\.py$", n):
                problems.append(f"{n} would shadow the standard library module")
        return problems


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    errors = main(sys.argv[1])
    if errors:
        print("Release zip check FAILED:")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    print("Release zip check passed: Steam Deck files and Windows layer are both present.")
