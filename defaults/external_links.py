"""Open explicitly clicked web links with the session user's default browser."""
import os
import subprocess
import sys
from urllib.parse import urlsplit


def open_link(url, env=None):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) < 32 for c in url):
        return False
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            return False
        # Validate malformed ports too; never pass a scheme or arbitrary command.
        parsed.port
        if sys.platform == "win32":
            os.startfile(url)
        else:
            proc = subprocess.Popen(["xdg-open", url], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True, env=env)
            try:
                return proc.wait(timeout=2) == 0
            except subprocess.TimeoutExpired:
                # Some browsers keep the opener alive for the lifetime of the window.
                return True
        return True
    except (OSError, ValueError):
        return False
