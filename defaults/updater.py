"""Release-based auto-updater for the Steamcord Decky plugin.

Checks the latest GitHub Release of the repo, compares it to the installed
version (plugin.json), and — if newer — downloads the release ZIP and unpacks
it over the plugin directory, then restarts plugin_loader to reload the code.

The backend runs as the session user (no "root" flag in plugin.json). Decky
itself keeps the plugin's top-level directory (and plugin.json) root-owned
even on a normal install — only the directory's *contents* get chowned to the
host user — so a non-root backend can never create new directory entries
there (tmp-file + os.replace needs write on the directory, not the file).
_replace_file() tries that first and falls back to an in-place write for
existing, already-host-owned files when it isn't available (issue #16).
Network/disk work runs in a thread executor so the asyncio loop never blocks.
"""

import asyncio
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from decky import logger, DECKY_PLUGIN_DIR  # type: ignore


def _ssl_context():
    """Le Python embarqué de plugin_loader (PyInstaller) n'embarque pas de bundle CA
    → urllib échoue en 'CERTIFICATE_VERIFY_FAILED'. On pointe explicitement le bundle
    CA du système (présent sur Bazzite/Fedora) pour une vérif TLS correcte."""
    for ca in ("/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"):
        if os.path.exists(ca):
            try:
                return ssl.create_default_context(cafile=ca)
            except Exception:
                pass
    try:
        return ssl.create_default_context()
    except Exception:
        return None

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
    # Défaut OFF : une mise à jour passe désormais par l'installeur natif de
    # Decky, qui demande toujours une confirmation à l'écran. Déclencher ça tout
    # seul au démarrage ferait surgir une modale non sollicitée — on se contente
    # de notifier, et l'utilisateur active l'auto-update s'il le veut.
    try:
        return bool(json.loads(SETTINGS_FILE.read_text()).get("autoupdate", False))
    except Exception:
        return False  # default OFF


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
    with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
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


def _selinux_enforcing() -> bool:
    """True on Bazzite/Fedora Atomic and most SELinux distros in Enforcing mode.
    False (never blocks) on SteamOS, Arch/CachyOS, Debian/Ubuntu — no getenforce there."""
    try:
        r = subprocess.run(["getenforce"], capture_output=True, text=True, timeout=5)
        return r.returncode == 0 and r.stdout.strip() == "Enforcing"
    except Exception:
        return False


def _restorecon_best_effort(path: Path) -> None:
    """Re-apply the SELinux context inherited from the parent dir, in case `path`
    was created/overwritten by a `sudo`-run install and got mislabeled (e.g.
    admin_home_t instead of the usual user_home_t) — chown fixes DAC ownership
    but never touches this MAC-layer label, so a root-owned install can stay
    unwritable even after `chown -R`. No-op (silently) wherever restorecon isn't
    installed (SteamOS, Arch/CachyOS, Debian/Ubuntu) or we lack rights to relabel."""
    try:
        subprocess.run(["restorecon", "-R", str(path)], capture_output=True, timeout=10)
    except Exception:
        pass


def _apply_blocking(url: str) -> None:
    plugin_dir = Path(DECKY_PLUGIN_DIR)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        zip_path = tmp / "update.zip"
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=120, context=_ssl_context()) as resp, open(zip_path, "wb") as f:
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
                _replace_file(src, dst)

        # One recursive pass to heal any SELinux mislabeling left by a root-run
        # install (chown fixes ownership but never touches this MAC-layer label).
        # No-op wherever restorecon isn't installed or we lack rights to relabel.
        _restorecon_best_effort(plugin_dir)


def _diagnose_permission(path: Path) -> str:
    """Extra context logged alongside a PermissionError so the NEXT report is
    conclusive instead of another guess — issue #16 has already burned two
    (chown -R alone insufficient; SELinux/restorecon also insufficient on
    SteamOS, which doesn't even have SELinux). Correct ownership + writable
    mode on the directory (confirmed via `ls -la` by two independent reporters)
    plus a persistent EPERM/EACCES on file *creation* inside it points at the
    process not actually running as the uid the directory is chown'd to — this
    logs the actual runtime identity next to the failure so that's provable."""
    import pwd
    d = path if path.is_dir() else path.parent
    bits = []
    try:
        euid = os.geteuid()
        uid = os.getuid()
        name = pwd.getpwuid(euid).pw_name
        bits.append(f"process uid={uid} euid={euid} ({name})")
    except Exception as e:
        bits.append(f"uid lookup failed: {e!r}")
    try:
        groups = os.getgroups()
        bits.append(f"groups={groups}")
    except Exception as e:
        bits.append(f"getgroups failed: {e!r}")
    try:
        st = d.stat()
        owner = pwd.getpwuid(st.st_uid).pw_name
        bits.append(f"{d} owned by uid={st.st_uid} ({owner}) gid={st.st_gid} mode={oct(st.st_mode)[-4:]}")
    except Exception as e:
        bits.append(f"stat({d}) failed: {e!r}")
    bits.append(f"os.access(W_OK) on {d}: {os.access(d, os.W_OK)}")
    return " | ".join(bits)


def _replace_file(src: Path, dst: Path) -> None:
    """Copy src over dst via a same-directory tmp file + atomic os.replace.

    os.replace only needs write permission on the parent directory, so this
    works even when dst itself is root-owned (issue #16) — and the replaced
    file then belongs to us, healing such installs one update at a time.

    But Decky only root-owns the plugin's top-level directory and plugin.json
    at install time (browser.py's set_plugin_dir_permissions chowns every
    other file to the host user recursively) — so on a real (non-dev-deploy)
    install it's the *directory* that's unwritable, while dst itself, if it
    already exists, usually isn't. tmp+rename can't work there since creating
    the tmp file also needs directory write — but overwriting an existing
    file's content only needs write permission on the file itself, so that
    still works. Fall back to writing dst in place in that case.
    """
    tmp_dst = dst.parent / (dst.name + ".steamcord-new")
    try:
        shutil.copyfile(src, tmp_dst)
        shutil.copymode(src, tmp_dst)  # our own file: keeps +x on binaries
        os.replace(tmp_dst, dst)
        return
    except PermissionError:
        try:
            os.unlink(tmp_dst)
        except OSError:
            pass
        if not dst.exists() or not os.access(dst, os.W_OK):
            raise
    except OSError:
        try:
            os.unlink(tmp_dst)
        except OSError:
            pass
        raise

    # Non-atomic (a crash mid-write leaves dst truncated), but src was already
    # downloaded and extracted successfully before this ever runs, and the
    # alternative here is a guaranteed Permission denied.
    with open(src, "rb") as s, open(dst, "wb") as d:
        shutil.copyfileobj(s, d)
    shutil.copymode(src, dst)


async def apply(url: str) -> dict:
    """{"ok": True} ou {"ok": False, "error": "…"} — l'erreur remonte au QAM
    (avant, un échec — ex. Permission denied sur une install root-owned —
    laissait le bouton bloqué sur « installation » pour toujours)."""
    if not url:
        return {"ok": False, "error": "no url"}
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _apply_blocking, url)
        logger.info("[updater] update unpacked; restarting plugin_loader")
        return {"ok": True}
    except PermissionError as e:
        blocked_path = getattr(e, "filename", "") or DECKY_PLUGIN_DIR
        logger.error(f"[updater] apply failed: {e} | {_diagnose_permission(Path(blocked_path))}")
        hints = [f"sudo chown -R $(id -un) {DECKY_PLUGIN_DIR}"]
        if _selinux_enforcing():
            # The likely real culprit on Bazzite/Fedora Atomic: chown fixes DAC
            # ownership, but a root-run install can leave files mislabeled at the
            # SELinux (MAC) layer, which chown never touches — restorecon does.
            hints.append(f"sudo restorecon -R {DECKY_PLUGIN_DIR}")
        as_root = os.geteuid() == 0
        note = (" (this process already runs as root — a further Permission denied "
                "here points at SELinux or an immutable file attribute, not ownership)"
                if as_root else "")
        return {"ok": False,
                "error": f"Permission denied on {blocked_path}{note} — run:\n"
                         + "\n".join(hints) + "\nthen retry"}
    except Exception as e:
        logger.error(f"[updater] apply failed: {e}")
        return {"ok": False, "error": str(e)}


def restart_loader() -> None:
    """Restart Decky so the new code loads. This kills our own process."""
    try:
        subprocess.Popen(["systemctl", "restart", "plugin_loader"])
    except Exception as e:
        logger.error(f"[updater] restart failed: {e}")
