"""Release-based auto-updater for the Steamcord Decky plugin.

Checks the latest GitHub Release of the repo, compares it to the installed
version (plugin.json), and — if newer — downloads the release ZIP and unpacks
it over the plugin directory, then restarts plugin_loader to reload the code.

The plugin backend runs as root (plugin_loader User=root) and the plugin dir
is root-owned, so it can write to itself and restart the loader without sudo.
Network/disk work runs in a thread executor so the asyncio loop never blocks.
"""

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from decky import logger, DECKY_PLUGIN_DIR  # type: ignore

# --- per-plugin configuration -------------------------------------------------
GITHUB_REPO = "Necrosiak/Steamcord"
# -----------------------------------------------------------------------------

RELEASES_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
SETTINGS_DIR = Path(os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", DECKY_PLUGIN_DIR))
SETTINGS_FILE = SETTINGS_DIR / "updater.json"
_USER_AGENT = f"{GITHUB_REPO.split('/')[-1]}-updater"


def _parse_version(v: str) -> tuple:
    """'v1.2.10' / '1.2.10' -> (1, 2, 10). Non-numeric chunks become 0."""
    out = []
    for chunk in str(v).strip().lstrip("vV").split("."):
        digits = "".join(c for c in chunk if c.isdigit())
        out.append(int(digits) if digits else 0)
    return tuple(out) or (0,)


def get_current_version() -> str:
    # The installed version lives in package.json (plugin.json has no version field).
    try:
        data = json.loads((Path(DECKY_PLUGIN_DIR) / "package.json").read_text())
        return str(data.get("version", "0.0.0"))
    except Exception as e:
        logger.warning(f"[updater] cannot read current version: {e}")
        return "0.0.0"


def is_autoupdate_enabled() -> bool:
    try:
        return bool(json.loads(SETTINGS_FILE.read_text()).get("autoupdate", True))
    except Exception:
        return True  # default ON


def set_autoupdate_enabled(enabled: bool) -> bool:
    try:
        SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps({"autoupdate": bool(enabled)}))
    except Exception as e:
        logger.warning(f"[updater] cannot persist autoupdate flag: {e}")
    return bool(enabled)


def _fetch_latest_blocking() -> dict:
    req = urllib.request.Request(
        RELEASES_API,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        rel = json.loads(resp.read().decode("utf-8"))

    tag = rel.get("tag_name") or rel.get("name") or ""
    # Prefer a .zip asset (the one produced by `decky plugin build`); fall back
    # to the source zipball if no built asset is attached.
    download_url = ""
    for asset in rel.get("assets", []):
        name = (asset.get("name") or "").lower()
        if name.endswith(".zip"):
            download_url = asset.get("browser_download_url", "")
            break
    if not download_url:
        download_url = rel.get("zipball_url", "")
    return {"tag": tag, "url": download_url, "notes": rel.get("body", "") or ""}


async def check() -> dict:
    """Return {current, latest, update_available, url, notes, error?}."""
    current = get_current_version()
    try:
        loop = asyncio.get_event_loop()
        latest = await loop.run_in_executor(None, _fetch_latest_blocking)
    except Exception as e:
        logger.warning(f"[updater] check failed: {e}")
        return {"current": current, "latest": None, "update_available": False,
                "url": "", "notes": "", "error": str(e)}

    available = (
        bool(latest["tag"])
        and bool(latest["url"])
        and _parse_version(latest["tag"]) > _parse_version(current)
    )
    return {
        "current": current,
        "latest": latest["tag"],
        "update_available": available,
        "url": latest["url"],
        "notes": latest["notes"],
    }


def _content_root(extracted: Path) -> Path:
    """The release ZIP wraps everything in a single top-level folder."""
    entries = [p for p in extracted.iterdir() if not p.name.startswith("__MACOSX")]
    if len(entries) == 1 and entries[0].is_dir():
        return entries[0]
    return extracted


def _apply_blocking(url: str) -> None:
    plugin_dir = Path(DECKY_PLUGIN_DIR)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        zip_path = tmp / "update.zip"
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as resp, open(zip_path, "wb") as f:
            shutil.copyfileobj(resp, f)

        extract_dir = tmp / "x"
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(extract_dir)

        root = _content_root(extract_dir)
        # Overlay-copy onto the plugin dir (don't wipe — keeps settings/runtime files).
        for src in root.rglob("*"):
            rel = src.relative_to(root)
            dst = plugin_dir / rel
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)


async def apply(url: str) -> bool:
    if not url:
        return False
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _apply_blocking, url)
        logger.info("[updater] update unpacked; restarting plugin_loader")
        return True
    except Exception as e:
        logger.error(f"[updater] apply failed: {e}")
        return False


def restart_loader() -> None:
    """Restart Decky so the new code loads. This kills our own process."""
    try:
        subprocess.Popen(["systemctl", "restart", "plugin_loader"])
    except Exception as e:
        logger.error(f"[updater] restart failed: {e}")
