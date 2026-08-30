from aiohttp.web import (  # type: ignore
    Application,
    get,
    WebSocketResponse,
    AppRunner,
    TCPSite,
    Response,
)
from asyncio import sleep, create_task, create_subprocess_exec, wait_for
import signal
import aiohttp_cors  # type: ignore
from json import dumps
from pathlib import Path
import tempfile
from subprocess import PIPE, DEVNULL

import sys
import os

from decky import logger, DECKY_PLUGIN_DIR, emit  # type: ignore
from logging import INFO

# defaults/ EN PREMIER : le deploy local ne synchronise QUE defaults/, la copie
# racine (extraite du zip de release) reste figée. Sans cette priorité, un fix
# dans discord_client/ ou tab_utils/ ne prenait effet qu'à la release suivante —
# même piège que updater.py/vesktop.py (chargés explicitement plus bas), mais
# invisible : les notifs perdues venaient du VIEUX _rpc_notification racine.
sys.path.insert(0, str(Path(DECKY_PLUGIN_DIR) / "defaults"))
sys.path.append(DECKY_PLUGIN_DIR)

from tab_utils.tab import (
    create_discord_tab,
    setup_discord_tab,
    boot_discord,
    setOSK,
)
from tab_utils.cdp import Tab, get_tab
from discord_client.event_handler import EventHandler

# Decky enregistre son PROPRE module `updater` dans sys.modules, donc un simple
# `import updater` renvoie CELUI-LÀ (qui n'a pas is_autoupdate_enabled) au lieu du
# updater.py du plugin → l'auto-update a silencieusement cassé après une MAJ Decky
# ("module 'decky_loader.updater' has no attribute 'is_autoupdate_enabled'"). On
# charge notre fichier explicitement par chemin (nom unique) pour éviter la collision.
import importlib.util as _ilu
# Charger depuis defaults/ (toujours synchronisé par le deploy + présent dans le zip)
# plutôt que la copie racine ; nom de module unique pour éviter la collision Decky.
_upath = Path(DECKY_PLUGIN_DIR) / "defaults" / "updater.py"
if not _upath.exists():
    _upath = Path(DECKY_PLUGIN_DIR) / "updater.py"
_uspec = _ilu.spec_from_file_location("sc_updater", str(_upath))
updater = _ilu.module_from_spec(_uspec)
_uspec.loader.exec_module(updater)

# vesktop.py a le MÊME problème que updater.py : le deploy synchronise defaults/
# mais PAS la copie racine → `import vesktop` chargeait une version figée au
# 2026-06-28 (avec runImmediately, sans launchdiag). On charge defaults/vesktop.py
# et on l'enregistre dans sys.modules AVANT tout `import vesktop` : sys.modules
# gagne toujours sur la résolution par sys.path.
_vpath = Path(DECKY_PLUGIN_DIR) / "defaults" / "vesktop.py"
if not _vpath.exists():
    _vpath = Path(DECKY_PLUGIN_DIR) / "vesktop.py"
_vspec = _ilu.spec_from_file_location("vesktop", str(_vpath))
_vmod = _ilu.module_from_spec(_vspec)
sys.modules["vesktop"] = _vmod
_vspec.loader.exec_module(_vmod)

logger.setLevel(INFO)


def sys_python():
    """Python SYSTÈME (pour les bindings gi/Gst, absents du python du plugin).
    /usr/bin/python n'existe pas sur Debian/Ubuntu (sauf python-is-python3) →
    résoudre python3 du PATH d'abord."""
    import shutil as _sh
    return _sh.which("python3") or _sh.which("python") or "/usr/bin/python"


async def stream_watcher(stream, is_err=False, prefix="[gst]"):
    async for line in stream:
        line = line.decode("utf-8").rstrip()
        if not line.strip():
            continue
        # Surface GStreamer/WebRTC subprocess output in the journal (was logger.debug,
        # invisible at INFO level — made screenshare failures impossible to diagnose).
        if is_err:
            logger.warning(prefix + " " + line)
        else:
            logger.info(prefix + " " + line)


# Optional system tools, and the feature each one buys. Nothing here is fatal —
# the plugin runs without all of them — but when a feature quietly does nothing
# on an unusual distro, this log line is what tells you why (issue #29: a NixOS
# user could only see raw FileNotFoundErrors and had to guess).
_OPTIONAL_TOOLS = {
    "pw-dump": "PipeWire node discovery (screen share, game audio)",
    "pactl": "game audio sharing (virtual sinks)",
    "ffmpeg": "screen-share preview fallback",
    "gamescopectl": "screen-share preview fallback in Game Mode",
    "flatpak": "installing/running Vesktop as a flatpak",
}


def _log_tool_report():
    import shutil as _sh
    missing = {t: why for t, why in _OPTIONAL_TOOLS.items() if not _sh.which(t)}
    if not missing:
        return
    logger.info("[deps] optional tools not found on PATH — "
                + "; ".join(f"{t} ({why})" for t, why in missing.items())
                + " — see docs/OS-NOTES.md")


async def initialize():
    # NATIVE approach: drive Vesktop (a real Electron Discord, mic works) over CDP
    # instead of a hidden Steam CEF BrowserView (where the mic is impossible).
    import vesktop
    _log_tool_report()
    # defaults/ d'abord : même piège que discord_client/tab_utils — la copie
    # racine vient du zip de release et n'est PAS resynchronisée par le deploy
    # local (le client injecté restait figé → pas d'enrichissement __sc_dm).
    _cjs = Path(DECKY_PLUGIN_DIR) / "defaults" / "steamcord_client.js"
    if not _cjs.exists():
        _cjs = Path(DECKY_PLUGIN_DIR) / "steamcord_client.js"
    client_js = open(_cjs, "r").read()
    # webrtc_client.js surcharge getDisplayMedia → capture d'écran GStreamer pour
    # le partage d'écran (Go Live). DOIT être injecté sous Vesktop aussi, sinon le
    # partage d'écran « ne donne rien » (getDisplayMedia natif inutilisable headless).
    try:
        _wjs = Path(DECKY_PLUGIN_DIR) / "defaults" / "webrtc_client.js"
        if not _wjs.exists():
            _wjs = Path(DECKY_PLUGIN_DIR) / "webrtc_client.js"
        webrtc_js = open(_wjs, "r").read()
    except Exception:
        webrtc_js = ""
    tab = await vesktop.get_discord_tab(webrtc_js + "\n" + client_js)

    Plugin.discord_tab = tab

    create_task(watchdog(tab))
    create_task(_ensure_handshake(tab))
    return tab


# The injected client only emits LOADED / CONNECTION_OPEN once, on its first
# DOMContentLoaded. If the backend (re-)initializes AFTER that point — watchdog
# recovery (re-initialize()), a soft websocket reconnect, or simply Vesktop having
# survived a plugin_loader restart — the handshake is never re-delivered, so
# evt_handler.loaded stays False and the QAM is stuck on "Initializing…" forever
# even though Vesktop/CDP/the Discord tab all work. Actively re-request the
# handshake from the already-injected client until the backend sees itself loaded.
_REHANDSHAKE_JS = """
(() => {
  try {
    var w = window.STEAMCORD_WS;
    if (!w || w.readyState !== 1) return;
    if (!(window.Vencord && Vencord.Webpack && Vencord.Webpack.Common
          && Vencord.Webpack.Common.UserStore)) return;
    w.send(JSON.stringify({ type: "LOADED", result: true }));
    var u = Vencord.Webpack.Common.UserStore.getCurrentUser();
    if (u) w.send(JSON.stringify({ type: "CONNECTION_OPEN", user: u }));
  } catch (e) {}
})()
"""


async def _ensure_handshake(tab: Tab):
    # Poll for up to ~30s: as soon as the backend is loaded we're done; otherwise
    # nudge the client to re-emit the handshake. Idempotent (LOADED just re-sets the
    # flag, CONNECTION_OPEN refreshes the current user). Bounded so the QR/login flow
    # (never "loaded" until the user scans) doesn't loop forever.
    for _ in range(30):
        if Plugin.evt_handler.loaded:
            return
        try:
            await tab.evaluate(_REHANDSHAKE_JS)
        except Exception:
            pass
        await sleep(1)


async def watchdog(tab: Tab):
    import vesktop
    while True:
        # `tab.websocket.closed` stays False on a half-broken CDP transport (the
        # "Cannot write to closing transport" case seen when Vesktop dies but the
        # socket lingers in a closing state). And probing the CDP endpoint
        # (vesktop.is_up) n'attrape PAS un restart RAPIDE de Vesktop : le nouveau
        # process ré-expose :9223 avant la sonde suivante → is_up() reste True
        # alors que NOTRE onglet est mort → jamais ré-injecté → QAM bloqué sur
        # « Initialisation… » (vécu 19/07 après un systemctl restart). On sonde
        # donc l'ONGLET lui-même : un evaluate trivial avec timeout — s'il ne
        # répond plus, l'onglet est mort quel que soit l'état de l'endpoint.
        from asyncio import wait_for
        while not tab.websocket.closed:
            await sleep(3)
            try:
                await wait_for(tab.evaluate("1"), 5)
            except Exception:
                logger.info("Discord tab stopped answering (Vesktop restarted or CDP bounced) — treating it as dead.")
                break

        logger.info("Discord tab websocket is no longer open. Trying to reconnect...")

        try:
            # Only a soft reconnect makes sense if Vesktop is actually alive.
            if await vesktop.is_up():
                await tab.open_websocket()
                logger.info("Reconnected")
            else:
                break

        except:
            break

    logger.info("Discord has died. Re-initializing...")

    while True:
        try:
            await initialize()
            break

        except:
            await sleep(1)


def _running_executables(cap=400):
    """Exécutables en cours, du plus récemment démarré au plus ancien (#41).

    Steam ne connaît que ce QU'IL a lancé : quand Heroic (ou tout autre lanceur)
    démarre un jeu, `Router.MainRunningApp` reste « Heroic » et le jeu enfant est
    invisible. La base `/applications/detectable` de Discord, elle, liste aussi
    les EXÉCUTABLES de chaque jeu — c'est ainsi que le client Discord officiel
    les détecte. On remonte donc les binaires vivants et le client fait le
    rapprochement (il a déjà la base en mémoire).

    On renvoie AUSSI les arguments en .exe : sous Proton/Wine le processus porte
    le nom d'un lanceur Unix, et c'est l'argument qui nomme le jeu.
    L'heure de démarrage vient de /proc/<pid>/stat champ 22 ; elle sert à
    préférer le dernier lancé — donc le jeu plutôt que le lanceur qui l'a ouvert.
    """
    seen = {}
    try:
        pids = [d for d in os.listdir("/proc") if d.isdigit()]
    except OSError:
        return []
    for pid in pids:
        try:
            with open(f"/proc/{pid}/stat", "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            # comm peut contenir espaces ET parenthèses : couper au DERNIER ')'.
            start = int(stat[stat.rindex(")") + 2:].split()[19])
        except (OSError, ValueError, IndexError):
            continue
        names = []
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                parts = [a for a in f.read().decode("utf-8", "replace").split("\0") if a]
            if parts:
                names.append(os.path.basename(parts[0]))
                # Le DERNIER argument .exe est le binaire réellement lancé ; ceux
                # d'avant sont des wrappers (proton, wine, steam-launch...).
                exes = [os.path.basename(a) for a in parts if a.lower().endswith(".exe")]
                if exes:
                    names.append(exes[-1])
        except OSError:
            pass
        # Ligne de commande vide = thread NOYAU (kworker, ksoftirqd...). Ils ne
        # peuvent correspondre à aucun jeu et représentaient les deux tiers de la
        # liste : on les écarte plutôt que de les envoyer au client.
        if not names:
            continue
        for n in names:
            if n and (n not in seen or start > seen[n]):
                seen[n] = start
    ordered = sorted(seen.items(), key=lambda kv: kv[1], reverse=True)
    return [n for n, _ in ordered[:cap]]


# ── Envoi de clips vidéo vers Discord (#40) ──────────────────────────────────
# Demandé par @Havok027, qui sortait ses clips vers son téléphone pour les
# reposter. Steam n'aide pas : ses enregistrements vivent en FRAGMENTS
# (gamerecordings/timelines/*.m4s), illisibles tels quels — c'est le clip
# EXPORTÉ par Steam qu'on peut envoyer. On ratisse donc les dossiers où
# atterrissent les vidéos, sans supposer une langue d'interface.
VIDEO_EXTS = (".mp4", ".mkv", ".webm", ".mov", ".m4v")
# Discord ne LIT en ligne que ces conteneurs. Un .mkv se téléverse très bien
# mais arrive en pièce jointe à télécharger, ce qui rate tout l'intérêt d'un
# clip. On remuxe donc les autres vers mp4 avant l'envoi (voir _playable_copy).
DISCORD_PLAYABLE = (".mp4", ".webm", ".mov")
# Discord refuse au-delà de 10 Mio pour un compte sans Nitro. On liste quand
# même les fichiers plus gros : mieux vaut les montrer grisés avec leur taille
# que laisser l'utilisateur croire qu'ils n'existent pas.
DISCORD_UPLOAD_LIMIT = 10 * 1024 * 1024


def _video_dirs():
    home = os.path.expanduser("~")
    out = []
    for rel in ("Videos", "Vidéos", "Vídeos", "Filme", "Video",
                "Downloads", "Téléchargements", "Descargas",
                "Desktop", "Bureau"):
        d = os.path.join(home, rel)
        if os.path.isdir(d):
            out.append(d)
    # Clips exportés par Steam (le dossier n'existe que si on en a exporté).
    import glob
    out += [d for d in glob.glob(os.path.join(
        home, ".local/share/Steam/userdata/*/gamerecordings/clips")) if os.path.isdir(d)]
    return out


def _media_env():
    """Env pour ffmpeg/ffprobe, débarrassé de celui de plugin_loader.

    MÊME PIÈGE QUE #38, et je suis retombé dedans : plugin_loader est un binaire
    PyInstaller, il pointe LD_LIBRARY_PATH sur ses libs embarquées, et tout
    enfant en hérite. ffmpeg chargeait alors le libssl du bundle et mourait sur
    « OPENSSL_3.2.0 not found » — donc « impossible d'envoyer ce clip » alors que
    la logique était juste. Les tests isolés ne peuvent PAS l'attraper : ils
    tournent hors de cet environnement.
    """
    import vesktop as _vesktop
    return _vesktop._user_env()


def _send_filename(entry, prepared):
    """Nom lisible pour la pièce jointe Discord.

    Le fichier préparé s'appelle `steamcord-clip_2584270_20260825_073545.mp4.small.mp4`
    — nom interne, double extension : ça part chez le destinataire, autant que
    ce soit présentable. Un clip Steam devient `clip-20260825-073545.mp4`, un
    fichier ordinaire garde SON nom avec la bonne extension finale.
    """
    ext = os.path.splitext(prepared)[1] or ".mp4"
    if os.path.isdir(entry):
        parts = os.path.basename(entry).split("_")      # clip_<appid>_<date>_<heure>
        stamp = "-".join(parts[2:]) if len(parts) >= 4 else parts[-1]
        return f"clip-{stamp}{ext}"
    return os.path.splitext(os.path.basename(entry))[0] + ext


async def _run_ffmpeg(args, timeout=900):
    proc = await create_subprocess_exec("ffmpeg", "-y", "-loglevel", "error", *args,
                                        stdout=DEVNULL, stderr=PIPE, env=_media_env())
    _, err = await wait_for(proc.communicate(), timeout=timeout)
    return proc.returncode, (err or b"").decode("utf-8", "replace")


async def _assemble_steam_clip(clip_dir, out):
    """Reconstruit un mp4 lisible depuis les fragments DASH d'un clip Steam.

    Les fragments se recollent par simple concaténation d'octets — `init` puis
    les `chunk` DANS L'ORDRE NUMÉRIQUE, ce que ne donne PAS un tri lexical dès
    qu'on passe la centaine de fragments. On obtient un flux par piste, qu'on
    mux ensuite sans réencoder.
    """
    import glob, re
    frag = _clip_fragment_dir(clip_dir)
    if not frag:
        return None
    def num(p):
        m = re.search(r"(\d+)\.m4s$", p)
        return int(m.group(1)) if m else 0
    tmp = []
    for idx in (0, 1):
        init = os.path.join(frag, f"init-stream{idx}.m4s")
        chunks = sorted(glob.glob(os.path.join(frag, f"chunk-stream{idx}-*.m4s")), key=num)
        if not os.path.isfile(init) or not chunks:
            continue
        part = out + f".s{idx}.mp4"
        try:
            with open(part, "wb") as w:
                for src in [init] + chunks:
                    with open(src, "rb") as r:
                        while True:
                            b = r.read(1 << 20)
                            if not b:
                                break
                            w.write(b)
        except OSError as e:
            logger.warning(f"assemblage clip: {e!r}")
            return None
        tmp.append(part)
    if not tmp:
        return None
    args = []
    for t in tmp:
        args += ["-i", t]
    rc, err = await _run_ffmpeg(args + ["-c", "copy", "-movflags", "+faststart", out])
    for t in tmp:
        try:
            os.unlink(t)
        except OSError:
            pass
    if rc == 0 and os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    logger.warning(f"mux du clip Steam impossible : {err[:200]}")
    return None


async def _media_duration(path):
    proc = await create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", path, stdout=PIPE, stderr=DEVNULL, env=_media_env())
    out, _ = await wait_for(proc.communicate(), timeout=30)
    try:
        return float((out or b"").decode().strip())
    except ValueError:
        return 0.0


async def _shrink_to_limit(path, out):
    """Réencode pour tenir sous la limite Discord, ou None si déraisonnable.

    Un clip Steam de 25 s en 1080p pèse ~32 Mio : plus de trois fois la limite.
    Sans cette étape la fonctionnalité ne sert à rien pour de VRAIS clips — ce
    que le fichier de test, une vidéo déjà légère, avait masqué.
    On vise 90 % de la limite pour garder de la marge sur l'entête et l'audio.
    """
    dur = await _media_duration(path)
    if dur <= 0:
        return None
    # Au-delà, l'encodage logiciel (le BC-250 n'a aucun encodeur matériel)
    # prendrait des minutes, et le débit tomberait si bas que l'image serait
    # inregardable. Mieux vaut le dire que produire une bouillie.
    if dur > 600:
        logger.warning(f"clip trop long pour être compressé ({dur:.0f}s)")
        return None
    total_kbps = DISCORD_UPLOAD_LIMIT * 8 / dur / 1000 * 0.90
    video_kbps = int(total_kbps - 128)
    if video_kbps < 400:
        logger.warning(f"débit cible trop bas ({video_kbps} kbps) — compression abandonnée")
        return None
    rc, err = await _run_ffmpeg([
        "-i", path, "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", f"{video_kbps}k", "-maxrate", f"{video_kbps}k",
        "-bufsize", f"{video_kbps * 2}k",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out])
    if rc == 0 and os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    logger.warning(f"compression impossible : {err[:200]}")
    return None


async def _playable_copy(path):
    """Rend un chemin lisible EN LIGNE par Discord, ou None si rien à faire.

    Le remuxage (`-c copy`) ne réencode rien : il déplace les mêmes pistes dans
    un conteneur mp4, donc c'est quasi instantané et sans perte — mais il échoue
    si les codecs n'entrent pas dans du mp4 (VP9/Opus d'un enregistrement OBS,
    par exemple). Dans ce cas on renvoie None et l'original part tel quel :
    une pièce jointe à télécharger vaut mieux que pas de clip du tout.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext in DISCORD_PLAYABLE:
        return None
    out = os.path.join(tempfile.gettempdir(),
                       "steamcord-clip-" + os.path.splitext(os.path.basename(path))[0] + ".mp4")
    try:
        rc, err = await _run_ffmpeg(
            ["-i", path, "-c", "copy", "-movflags", "+faststart", out], timeout=120)
        if rc == 0 and os.path.isfile(out) and os.path.getsize(out) > 0:
            return out
        logger.warning("remux mp4 impossible (%s) : %s", os.path.basename(path), err[:200])
    except Exception as e:
        logger.warning(f"remux mp4 impossible: {e!r}")
    try:
        if os.path.exists(out):
            os.unlink(out)
    except OSError:
        pass
    return None


def _steam_clips():
    """[(dossier, appid, taille, mtime)] des clips enregistrés par Steam.

    Un clip Steam n'est PAS un fichier : c'est un dossier `clip_<appid>_<date>/`
    contenant une miniature, une timeline et des fragments DASH
    (`init-stream0.m4s` + `chunk-stream0-*.m4s` pour l'image, `stream1` pour le
    son). Rien n'y est lisible tel quel — d'où l'assemblage dans
    `_assemble_steam_clip`. La v1.27.0 ne listait que de vrais fichiers vidéo,
    donc un clip fraîchement enregistré n'apparaissait nulle part.
    """
    import glob
    out = []
    pattern = os.path.expanduser(
        "~/.local/share/Steam/userdata/*/gamerecordings/clips/clip_*")
    for d in glob.glob(pattern):
        if not os.path.isdir(d):
            continue
        frags = glob.glob(os.path.join(d, "video", "*", "*.m4s"))
        if not frags:
            continue
        total = 0
        for f in frags:
            try:
                total += os.path.getsize(f)
            except OSError:
                pass
        appid = ""
        base = os.path.basename(d).split("_")
        if len(base) >= 2 and base[1].isdigit():
            appid = base[1]
        try:
            mtime = os.path.getmtime(d)
        except OSError:
            continue
        out.append((d, appid, total, mtime))
    return out


def _clip_fragment_dir(clip_dir):
    """Le sous-dossier `video/fg_*` qui porte réellement les fragments."""
    import glob
    for d in sorted(glob.glob(os.path.join(clip_dir, "video", "*"))):
        if os.path.isdir(d) and glob.glob(os.path.join(d, "init-stream*.m4s")):
            return d
    return None


def _list_videos(cap=40):
    """[(chemin, nom, taille, mtime)] des vidéos, de la plus récente à la plus
    ancienne. Profondeur 2 : assez pour un sous-dossier par jeu, pas assez pour
    parcourir tout un disque de 4 To."""
    found = []
    for root in _video_dirs():
        for dirpath, dirnames, filenames in os.walk(root):
            depth = dirpath[len(root):].count(os.sep)
            if depth >= 2:
                dirnames[:] = []
            for fn in filenames:
                if not fn.lower().endswith(VIDEO_EXTS):
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                found.append((full, fn, st.st_size, st.st_mtime))
    found.sort(key=lambda t: t[3], reverse=True)
    return found[:cap]


class Plugin:
    server = Application()
    cors = aiohttp_cors.setup(
        server,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                expose_headers="*", allow_headers="*", allow_credentials=True
            )
        },
    )
    evt_handler = EventHandler()
    last_ws: WebSocketResponse = None
    discord_tab = None
    # Routage audio par-application (PipeWire) : None = auto (suit le système).
    _audio_out = None
    _audio_in = None
    # Réglages micro voulus par l'user (noise/echo/AGC). Persistés côté plugin
    # et ré-assertés à chaque login du client : la persistance interne de
    # Discord se perd sur certains setups → retour aux défauts (issue #14).
    _mic_prefs = {}
    _AUDIO_CFG = os.path.expanduser("~/.config/steamcord-audio.json")
    # ── Partage audio du jeu (voir section "Partage AUDIO du jeu") ──
    _ga_active = False
    _ga_modules = []          # ids des modules pactl chargés (ordre de chargement)
    _ga_loop_mod = {}         # branche ("voice"/"game") -> id du module loopback
    _ga_real_sink = None      # vraie sortie à restaurer au stop
    _ga_real_source = None    # source par défaut à restaurer au stop
    _ga_vol = {"voice": 100, "game": 60}

    @classmethod
    async def _main(cls):
        logger.info("Starting Steamcord backend")
        # CEF (SharedJSContext) can disconnect/reload during startup, which throws
        # mid-evaluate and would otherwise kill _main permanently (watchdog never
        # starts). Retry until the Discord tab is successfully created.
        while True:
            try:
                await initialize()
                break
            except Exception as e:
                # stand-alone : sans backend Vesktop (ni flatpak ni natif), inutile
                # de marteler toutes les 2 s — on re-teste calmement (self-heal dès
                # que le user installe flatpak ou le paquet vesktop).
                import vesktop
                if vesktop.backend() is None or vesktop.install_failures > 0:
                    # aucun backend, OU flatpak dispo mais l'install Vesktop échoue
                    # (hors-ligne/flathub bloqué) — marteler toutes les 2 s ne sert
                    # à rien, on re-teste calmement (self-heal au retour du réseau).
                    logger.warning("initialize(): no usable Vesktop backend "
                                   f"(install_failures={vesktop.install_failures}) "
                                   "— retrying in 15s")
                    await sleep(15)
                else:
                    logger.warning(f"initialize() failed ({e!r}); retrying in 2s")
                    await sleep(2)
        logger.info("Discord initialized")

        cls.server.add_routes(
            [
                get("/openkb", cls._openkb),
                get("/voice_render", cls._voice_render),
                get("/voice_hide", cls._voice_hide),
                get("/socket", cls._websocket_handler),
                get("/clip", cls._serve_clip),
                get("/pov_feed", cls._pov_feed),
            ]
        )
        cls.evt_handler.on_pov_chunk = cls._on_pov_chunk
        for r in list(cls.server.router.routes())[:-1]:
            cls.cors.add(r)

        cls.runner = AppRunner(cls.server, access_log=None)
        await cls.runner.setup()
        logger.info("Starting server.")
        await TCPSite(cls.runner, "0.0.0.0", 65123).start()

        # Same failure mode as initialize() above: while the Steam UI is still
        # (re)starting, CEF answers /json but SharedJSContext is not in the tab
        # list yet — a one-shot lookup here killed _main (QAM showed the raw
        # Python exception).
        while True:
            try:
                cls.shared_js_tab = await get_tab("SharedJSContext")
                break
            except ValueError:
                logger.warning("SharedJSContext tab not up yet — retrying in 3s")
                await sleep(3)
        await cls.shared_js_tab.open_websocket()
        create_task(cls._notification_dispatcher())

        # Use the SYSTEM GStreamer (1.26+). The original Deckcord bundled GStreamer in
        # bin/, but this fork never shipped it — pointing at a nonexistent bin/ broke the
        # subprocess silently. Inherit the user environment so PATH/HOME/typelibs
        # resolve, and only override what's needed for hw encode + pipewire/pulse access.
        # Le plugin GStreamer `nice` (ICE, requis par webrtcbin) n'est PAS dans l'image
        # Bazzite de base → webrtcbin échouait à construire le pipeline VP8 ("missing
        # plug-in") et getDisplayMedia se bloquait. On embarque libgstnice.so et on
        # l'ajoute au GST_PLUGIN_PATH (pas d'install système / pas de reboot).
        # Decky APLATIT defaults/ dans la racine du plugin à l'installation : le
        # dossier vendoré arrive en <plugin>/gst-plugins, et <plugin>/defaults/
        # n'existe PAS dans une install réelle (il n'existe que sur un deploy dev).
        # Ne viser que defaults/ pointait donc GST_PLUGIN_PATH sur un dossier
        # inexistant → libgstnice.so jamais chargé → webrtcbin sans ICE → « could
        # not link queueN to send … missing a plug-in » et getDesktopSource qui
        # expire (#42). On passe les DEUX chemins, ceux qui existent.
        gst_plugins_dir = os.pathsep.join(
            str(_p)
            for _p in (
                Path(DECKY_PLUGIN_DIR) / "gst-plugins",
                Path(DECKY_PLUGIN_DIR) / "defaults" / "gst-plugins",
            )
            if _p.is_dir()
        )
        # #38 : partir de _user_env() et NON de os.environ. plugin_loader est un
        # binaire PyInstaller : il exporte LD_LIBRARY_PATH/LD_PRELOAD vers ses libs
        # embarquées (/tmp/_MEI...). Le GStreamer SYSTÈME lancé ici héritait de ces
        # variables et chargeait le libcrypto du bundle → « OPENSSL_3.4.0 not found »,
        # donc pas de pipeline et un Go Live sans image (invisible sur Bazzite, dont
        # les libs système sont compatibles ; fatal sur SteamOS). _user_env() fait
        # déjà ce nettoyage — le shim s'en servait, ce lancement-ci l'avait manqué.
        # Il dérive aussi XDG_RUNTIME_DIR/DBUS du vrai uid, ce que os.environ.get
        # ne garantissait pas (le backend hérite du /run/user/0 de plugin_loader).
        import vesktop as _vesktop
        gst_env = {
            **_vesktop._user_env(),
            "GST_VAAPI_ALL_DRIVERS": "1",
            "LIBVA_DRIVER_NAME": "radeonsi",
            "GST_PLUGIN_PATH": gst_plugins_dir + os.pathsep + os.environ.get("GST_PLUGIN_PATH", ""),
        }
        # Réutilisé par le feeder webcam virtuelle (gst_camera.py).
        cls._gst_env = gst_env
        # Auto-install des dépendances du partage d'écran (self-contained sur toute
        # BC-250 fraîche) AVANT de lancer gst_webrtc.py.
        await cls._ensure_screenshare_deps()
        # Tuer un gst_webrtc.py orphelin (restart de plugin_loader ne tue pas toujours
        # l'enfant → port 65124 "address already in use"). Puis laisser le port se libérer.
        try:
            import vesktop
            vesktop.proc_kill("gst_webrtc.py")
            await sleep(1)
        except Exception:
            pass
        cls.webrtc_server = await create_subprocess_exec(
            sys_python(),
            str(Path(DECKY_PLUGIN_DIR) / "gst_webrtc.py"),
            env=gst_env,
            stdout=PIPE,
            stderr=PIPE,
        )
        create_task(stream_watcher(cls.webrtc_server.stdout))
        create_task(stream_watcher(cls.webrtc_server.stderr, True))
        # Portail ScreenCast pour gamescope (portal_shim.py) : rend le Go Live
        # NATIF fonctionnel en mode jeu (getDisplayMedia → notre portail → node
        # PipeWire gamescope), sans caméra virtuelle ni relais WebRTC local.
        # Tourne sous le python SYSTÈME (pas de gi requis — dbus_next est
        # vendoré dans py_modules, passé via PYTHONPATH).
        try:
            vesktop.proc_kill("portal_shim.py")
        except Exception:
            pass
        _shim = Path(DECKY_PLUGIN_DIR) / "portal_shim.py"
        if not _shim.exists():
            _shim = Path(DECKY_PLUGIN_DIR) / "defaults" / "portal_shim.py"
        shim_env = {
            **vesktop._user_env(),
            "PYTHONPATH": str(Path(DECKY_PLUGIN_DIR) / "py_modules"),
        }
        cls.portal_shim = await create_subprocess_exec(
            sys_python(), str(_shim), env=shim_env, stdout=PIPE, stderr=PIPE,
        )
        create_task(stream_watcher(cls.portal_shim.stdout, prefix="[portal]"))
        create_task(stream_watcher(cls.portal_shim.stderr, True, prefix="[portal]"))
        create_task(cls._remote_auth_watcher())
        create_task(cls._audio_keepalive())
        create_task(cls._autoupdate_check())
        cls._load_audio_cfg()
        cls.evt_handler.on_logged_in = cls._on_logged_in
        create_task(cls.apply_stream_prefs())
        create_task(cls._audio_routing_watcher())
        create_task(cls._screen_diag())
        create_task(cls._ga_boot_cleanup())
        create_task(cls._account_watcher())
        # Lecteur clavier/souris du raccourci vocal — no-op tant qu'aucun binding
        # clavier/souris n'existe (aucun fd ouvert, donc rien à payer).
        create_task(cls._input_refresh())
        create_task(cls._input_watchdog())

        async for state in cls.evt_handler.yield_new_state():
            await emit("state", state)
            # Overlays in-game : miroir du state (roster/parole) + réalignement
            # des relais POV — seulement quand la fenêtre overlay tourne.
            if cls._overlay_running():
                if not state.get("vc"):
                    # Sortie du vocal → fermer les overlays : ils sont liés à
                    # l'appel (retour user : quitter l'appel ne fermait pas
                    # l'overlay). Toggles remis à false = le menu QAM reflète
                    # l'état à sa prochaine ouverture.
                    await cls.stop_pov_overlay()
                    await cls.stop_voice_overlay()
                else:
                    cls._write_overlay_state(state)
                    if cls._pov_ov_on:
                        await cls._sync_pov_users(state)

    @classmethod
    async def _account_watcher(cls):
        """Multi-sessions : un profil Discord (Vesktop) par compte Steam. Quand
        le compte Steam actif change (changement d'utilisateur sur la console),
        vesktop.launch() détecte le désaccord de profil, arrête l'unité et
        relance sur le bon profil ; le watchdog ré-injecte ensuite le client
        tout seul dès que le CDP rebondit."""
        import vesktop
        last = vesktop.steam_account_id()
        # Premier démarrage multi-sessions : l'instance qui tourne n'a aucun
        # profil enregistré. On l'adopte/relance TOUT DE SUITE, pendant que le
        # compte Steam actif est forcément celui de la session Discord actuelle
        # — adopter plus tard risquerait d'attribuer la session du proprio au
        # compte d'un autre (ex. la copine se connecte la première).
        try:
            if (vesktop._recorded_account() != last
                    and await vesktop._unit_active(vesktop.VESKTOP_UNIT)):
                logger.info(f"[multisession] instance sans profil → adoption "
                            f"par le compte {last} + relance")
                await vesktop.launch()
        except Exception as e:
            logger.warning(f"[multisession] adoption initiale: {e!r}")
        while True:
            # 5 s : deux petits fichiers lus, coût négligeable — et la détection
            # est la seule part compressible du temps de bascule (le reste =
            # redémarrage Vesktop + chargement Discord, ~15-30 s incompressibles).
            await sleep(5)
            try:
                acc = vesktop.steam_account_id()
                if acc != last:
                    logger.info(f"[multisession] compte Steam actif {last} → {acc}")
                    last = acc
                    # Purger l'état Discord AVANT la relance : le nouveau profil
                    # appartient à quelqu'un d'autre. Sans ça, logged_in restait
                    # True → le LOADED du profil vierge ne démarrait jamais le QR
                    # et le QAM affichait encore l'ancien compte (vu en live).
                    # _logout relance aussi remote_auth (QR) ; si le nouveau
                    # profil est déjà loggé, CONNECTION_OPEN reprendra la main.
                    await cls.evt_handler._logout({})
                    cls.evt_handler.state_changed_event.set()
                    await vesktop.launch()
            except Exception as e:
                logger.warning(f"[multisession] account watcher: {e!r}")

    @classmethod
    async def _audio_keepalive(cls):
        # ROOT CAUSE of "I can't hear anyone": Chromium's autoplay policy keeps
        # AudioContexts suspended in the hidden Discord BrowserView because it never
        # receives a user gesture. A page-side resume() doesn't count. Resuming via a
        # CDP eval with userGesture=True simulates a real activation and unblocks the
        # audio output (a "Chromium / Playback" sink-input then appears on the default
        # sink, which follows headphones/HDMI automatically). Re-assert periodically
        # because Discord spins up new contexts when (re)joining a voice call.
        js = """(() => {
          try {
            let resumed = 0, states = [];
            const me = Vencord.Webpack.findStore('MediaEngineStore')?.getMediaEngine?.();
            const ctxs = [];
            if (me?.audioContext) ctxs.push(me.audioContext);
            if (window.__sc_extra_ctx) ctxs.push(window.__sc_extra_ctx);
            for (const c of ctxs) {
              states.push(c.state);
              if (c.state === 'suspended') { c.resume(); resumed++; }
            }
            return 'resumed=' + resumed + ' states=' + JSON.stringify(states);
          } catch (e) { return 'err:' + e.message; }
        })()"""
        while True:
            try:
                tab = getattr(cls, "discord_tab", None)
                if tab is not None:
                    await tab.ensure_open()
                    res = await tab.evaluate(js, wait=True, user_gesture=True)
                    val = (((res or {}).get("result") or {}).get("result") or {}).get("value")
                    if val and "resumed=0" not in val:
                        logger.info(f"[audio] keepalive: {val}")
            except Exception as e:
                logger.debug(f"[audio] keepalive error: {e}")
            await sleep(4)

    @classmethod
    async def _remote_auth_watcher(cls):
        # Remote auth is now handled entirely in steamcord_client.js
        # This task is kept as a no-op for compatibility
        while True:
            await sleep(3600)

    @classmethod
    async def _toast(cls, title, body):
        try:
            # On passe par le dispatcher du frontend (notify.ts) : il fabrique un
            # persona factice à partir du titre, donc la notif s'affiche au nom
            # « Steamcord » avec le logo Discord, comme les notifs de messages.
            # Sans ça on retombait sur DisplayClientNotification avec le SteamID
            # de l'utilisateur COURANT → la notif portait son pseudo et son
            # avatar Steam, comme s'il se l'était envoyée (retour user).
            payload = dumps({"title": title, "body": body, "kind": "plugin"})
            payload = payload.replace("\\", "\\\\").replace("'", "\\'")
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                "(()=>{const p=JSON.parse('" + payload + "');"
                "const S=window.STEAMCORD;"
                "if(S&&S.dispatchNotification){S.dispatchNotification(p);return;}"
                # Repli si le frontend n'est pas encore monté : ancien chemin brut
                # (API native Steam ; le toaster Decky, lui, crée des notifs sans
                # `notification_type` qui ne popent pas ET font planter le panneau
                # de notifs Steam sur ce build).
                "const o={title:p.title,body:p.body,state:'active'};"
                "const A=window.App;o.steamid=A&&A.GetCurrentUser&&A.GetCurrentUser()?A.GetCurrentUser().strSteamID:'';"
                "window.SteamClient&&window.SteamClient.ClientNotifications&&"
                "window.SteamClient.ClientNotifications.DisplayClientNotification(1,JSON.stringify(o),function(){});})()"
            )
        except Exception as e:
            logger.debug(f"toast failed: {e}")

    @classmethod
    async def _autoupdate_check(cls):
        # Vérification non bloquante au démarrage. Une maj disponible est TOUJOURS
        # notifiée (avant, le toast n'existait que si l'auto-update était off, or
        # il était on par défaut → l'utilisateur n'était jamais prévenu, il voyait
        # juste une install se déclencher ou échouer).
        try:
            info = await updater.check()
            if not info.get("update_available"):
                return
            # Toasts en ANGLAIS : même règle que le script v4l2 — ils partent
            # chez tous les users, quelle que soit la langue du QAM.
            await cls._toast(
                "Steamcord",
                f"Update {info['latest']} available — install it from the Quick Access Menu",
            )
            if not updater.is_autoupdate_enabled():
                logger.info(
                    f"[updater] {info['latest']} available (have {info['current']}); "
                    "autoupdate off — notifying only"
                )
                return
            logger.info(
                f"[updater] {info['latest']} available (have {info['current']}); auto-applying"
            )
            if await cls._delegate_install(info["url"], info["latest"]):
                # Decky prend le relais : il affiche sa modale de confirmation,
                # décompresse en root et recharge le plugin lui-même.
                return
            # Repli si le loader n'expose pas l'installeur (version trop ancienne).
            # apply() renvoie un dict {"ok": bool, "error"?} — un simple `if` était
            # toujours vrai (dict non vide), donc un échec toastait « installée » et
            # redémarrait le loader pour rien.
            res = await updater.apply(info["url"])
            if res.get("ok"):
                await cls._toast("Steamcord", "Update installed — reloading…")
                await sleep(2)
                updater.restart_loader()
            else:
                await cls._toast("Steamcord", f"Update failed: {res.get('error', '?')}")
        except Exception as e:
            logger.warning(f"[updater] auto-check error: {e}")

    @classmethod
    async def _delegate_install(cls, url: str, version: str) -> bool:
        """Confie l'install à l'installeur natif de Decky, exposé par le loader.

        Le loader tourne en root, nous non : le dossier top-level du plugin (et
        plugin.json) lui appartient et il le re-chown à chaque chargement, donc
        notre backend ne peut jamais y créer une nouvelle entrée — toute release
        ajoutant un fichier ou un dossier à la racine échouait en Permission
        denied (cf #16). Le loader, lui, décompresse en root puis rétablit les
        droits (set_plugin_dir_permissions) : c'est le chemin qu'emprunte le
        Store Decky. `DeckyBackend` n'existe que côté JS → on passe par l'onglet
        partagé, comme pour les toasts. Renvoie False si la route est absente.
        """
        try:
            args = dumps([url, "Steamcord", version, "", 2])  # 2 = InstallType.UPDATE
            args = args.replace("\\", "\\\\").replace("'", "\\'")
            await cls.shared_js_tab.ensure_open()
            # evaluate() n'attend pas les promesses : on ne peut pas `await` le
            # call côté JS (on récupérerait un objet Promise). On le lance sans
            # l'attendre — c'est le loader qui affiche la modale et fait le
            # travail — et on ne renvoie ici que « la route existe-t-elle ».
            res = await cls.shared_js_tab.evaluate(
                "(()=>{const b=window.DeckyBackend;"
                "if(!b||!b.call)return 'no-backend';"
                "try{b.call('utilities/install_plugin',...JSON.parse('" + args + "'))"
                ".catch(e=>console.warn('[Steamcord] install_plugin:',e));"
                "return 'ok';}catch(e){return 'err:'+e;}})()",
                wait=True,
            )
            out = (((res or {}).get("result") or {}).get("result") or {}).get("value")
            if out != "ok":
                logger.warning(f"[updater] delegated install unavailable: {out}")
                return False
            return True
        except Exception as e:
            logger.warning(f"[updater] delegated install failed: {e}")
            return False

    @classmethod
    async def check_update(cls):
        return await updater.check()

    @classmethod
    async def get_version(cls):
        return updater.get_current_version()

    @classmethod
    async def apply_update(cls, url):
        res = await updater.apply(url)
        if res.get("ok"):
            await cls._toast("Steamcord", "Update installed — reloading…")
            await sleep(1)
            updater.restart_loader()
        return res

    @classmethod
    async def get_autoupdate(cls):
        return updater.is_autoupdate_enabled()

    @classmethod
    async def set_autoupdate(cls, enabled):
        return updater.set_autoupdate_enabled(enabled)

    @classmethod
    async def _openkb(cls, request):
        await cls.shared_js_tab.ensure_open()
        await setOSK(cls.shared_js_tab, True)
        logger.info("Setting discord visibility to true")
        return Response(text="OK")

    @classmethod
    async def _voice_render(cls, request):
        # Chromium freezes WebRTC in the occluded (hidden) BrowserView, so the voice
        # connection stalls forever at DTLS_CONNECTING. Rendering the view (even 1×1)
        # un-backgrounds the renderer so the handshake completes. The JS calls this
        # while the voice connection is establishing, then /voice_hide once connected.
        try:
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate("""
                try {
                    window.DISCORD_TAB.m_browserView.SetBounds(0, 0, 1, 1);
                    window.DISCORD_TAB.m_browserView.SetVisible(true);
                } catch (e) {}
            """)
        except Exception as e:
            logger.warning(f"voice_render failed: {e}")
        return Response(text="OK")

    @classmethod
    async def _voice_hide(cls, request):
        try:
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate("""
                try {
                    window.DISCORD_TAB.m_browserView.SetVisible(false);
                    window.DISCORD_TAB.m_browserView.SetBounds(0, 0, window.DISCORD_TAB.WIDTH, window.DISCORD_TAB.HEIGHT);
                } catch (e) {}
            """)
        except Exception as e:
            logger.warning(f"voice_hide failed: {e}")
        return Response(text="OK")

    @classmethod
    async def _websocket_handler(cls, request):
        logger.info("Received websocket connection!")
        ws = WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        # Re-pousser le Rich Presence (issue #11) au client fraîchement (re)connecté
        # — petit délai le temps que son écouteur de messages et les stores Flux
        # soient posés. Fire-and-forget : un échec ne doit pas tuer la connexion.
        if cls._rpc_game and cls._rpc_pref():
            async def _replay_rpc():
                await sleep(2)
                try:
                    await cls.evt_handler.send_client(
                        {"type": "$rpc", "game": cls._rpc_game,
                         "started_at": cls._rpc_since,
                         "procs": _running_executables(),
                         "detect": cls._rpc_detect_pref(),
                         "override": cls._rpc_override_pref()})
                except Exception:
                    pass
            create_task(_replay_rpc())
        await cls.evt_handler.main(ws)
        return ws

    @classmethod
    async def _notification_dispatcher(cls):
        async for notification in cls.evt_handler.yield_notification():
            logger.info("Dispatching notification")
            payload = dumps(
                {
                    "title": notification["title"],
                    "body": notification["body"],
                    "kind": notification.get("kind", ""),
                    "icon": notification.get("icon", ""),
                    "channel_id": notification.get("channel_id", ""),
                }
            )
            # payload (json.dumps ASCII) est une expression JS valide telle quelle.
            # SURTOUT PAS JSON.parse('{payload}') : une apostrophe dans le message
            # (« j'arrive ») cassait l'éval → notification silencieusement perdue.
            js = f"window.STEAMCORD.dispatchNotification({payload});"
            # Après un restart de Steam, le transport CDP peut être mort sans que
            # ws.closed le dise (« Cannot write to closing transport ») : retry en
            # rouvrant le tab, et la boucle NE MEURT JAMAIS — une notif ratée ne
            # doit pas tuer toutes les suivantes (c'est exactement ce qui arrivait).
            for attempt in range(3):
                try:
                    if attempt == 0:
                        await cls.shared_js_tab.ensure_open()
                    else:
                        cls.shared_js_tab = await get_tab("SharedJSContext")
                        await cls.shared_js_tab.open_websocket()
                    await cls.shared_js_tab.evaluate(js)
                    break
                except Exception as e:
                    logger.warning(f"notification dispatch attempt {attempt + 1}/3 failed: {e!r}")
                    await sleep(1)

    # ── Notifications en jeu (#25) ────────────────────────────────────────────
    # Havok027 : « Would it be possible to leave active or disabled to receive
    # notifications while playing? Or select whatever receives notification? »
    # Le filtrage se fait CÔTÉ FRONTEND (index.tsx) et pas ici : c'est le contexte
    # Steam qui sait si un jeu tourne au premier plan, le backend n'en a aucune
    # idée. Ici on ne fait que persister le choix.
    _NOTIFY_CFG = os.path.expanduser("~/.config/steamcord-notify.json")
    _notify_settings = None

    # "all" : tout passe (comportement historique)
    # "priority" : seulement MP, appels entrants et avis du plugin
    # "off" : rien tant qu'un jeu est au premier plan
    _NOTIFY_MODES = ("all", "priority", "off")

    @classmethod
    def _load_notify_settings(cls):
        from json import load as _load
        if cls._notify_settings is None:
            try:
                with open(cls._NOTIFY_CFG) as f:
                    cls._notify_settings = _load(f)
            except Exception:
                cls._notify_settings = {}
        mode = cls._notify_settings.get("in_game")
        if mode not in cls._NOTIFY_MODES:
            cls._notify_settings["in_game"] = "all"
        return cls._notify_settings

    @classmethod
    async def get_notify_prefs(cls):
        return cls._load_notify_settings()

    @classmethod
    async def set_notify_prefs(cls, in_game):
        from json import dump as _dump
        if in_game not in cls._NOTIFY_MODES:
            return {"ok": False, "error": f"mode inconnu: {in_game}"}
        cfg = cls._load_notify_settings()
        cfg["in_game"] = in_game
        try:
            os.makedirs(os.path.dirname(cls._NOTIFY_CFG), exist_ok=True)
            with open(cls._NOTIFY_CFG, "w") as f:
                _dump(cfg, f)
        except Exception as e:
            logger.warning(f"save {cls._NOTIFY_CFG} failed: {e!r}")
            return {"ok": False, "error": str(e)}
        return {"ok": True, **cfg}

    # ── qualité du partage d'écran (issue #33) ──────────────────────────────
    # « It would be cool to insert the sharing options to configure the stream
    # resolution » (Havok027). Le levier existe déjà, il n'était simplement pas
    # exposé : Vesktop garde une `screenshareQuality` dans son VesktopState, et
    # le patch screenShareFixes de Vencord l'applique comme contrainte sur la
    # piste vidéo au moment du partage. C'est le BON endroit pour ce réglage —
    # c'est l'encodeur de Discord qui obéit, sans transcodage de notre côté,
    # donc sans un cycle CPU de plus sur une machine qui encode déjà en logiciel.
    #
    # Piège : sur discord.com, `window.localStorage` est SUPPRIMÉ par Discord
    # (protection anti-vol de jeton). Y accéder directement jette, et le préréglage
    # 1080p60 que le client injecté croyait poser ne l'était pas toujours. On passe
    # donc par le localStorage d'une iframe de même origine, comme Vencord.
    _STREAM_CFG = os.path.expanduser("~/.config/steamcord-stream.json")
    _stream_settings = None

    # "source" = ne rien contraindre, on laisse Vesktop/Discord décider.
    _STREAM_RES = ("source", "720", "1080", "1440")
    _STREAM_FPS = ("source", "15", "30", "60")

    @classmethod
    def _load_stream_settings(cls):
        from json import load as _load
        if cls._stream_settings is None:
            try:
                with open(cls._STREAM_CFG) as f:
                    cls._stream_settings = _load(f)
            except Exception:
                cls._stream_settings = {}
        if cls._stream_settings.get("resolution") not in cls._STREAM_RES:
            cls._stream_settings["resolution"] = "1080"
        if cls._stream_settings.get("frameRate") not in cls._STREAM_FPS:
            cls._stream_settings["frameRate"] = "60"
        return cls._stream_settings

    @classmethod
    async def apply_stream_prefs(cls):
        """Pousse le réglage dans Vesktop. Sans effet sur un partage EN COURS :
        la contrainte est lue à l'acquisition de la piste.

        Passe par le canal WebSocket du client injecté, PAS par une évaluation
        CDP directe : le socket CDP est partagé, et un evaluate lancé pendant la
        poignée de main de démarrage le faisait échouer sur « Concurrent call to
        receive() ». Le canal $steamcord_request, lui, sérialise les requêtes.
        """
        cfg = cls._load_stream_settings()
        # Au démarrage le client n'est pas encore injecté : le hook on_logged_in
        # n'est branché qu'après le premier CONNECTION_OPEN. Sans cette attente,
        # la préférence était ignorée au boot et ne reprenait qu'au login suivant.
        for _ in range(30):
            api = getattr(getattr(cls, "evt_handler", None), "api", None)
            if api is not None and getattr(api, "ws", None) is not None \
                    and not api.ws.closed:
                try:
                    res = await api.set_stream_quality(cfg["resolution"],
                                                       cfg["frameRate"])
                    logger.info(f"[stream] qualité appliquée: {res}")
                    return res
                except Exception as e:
                    logger.warning(f"[stream] application échouée: {e!r}")
                    return None
            await sleep(1)
        logger.warning("[stream] client Discord absent — qualité non appliquée")
        return None

    @classmethod
    async def get_stream_prefs(cls):
        return cls._load_stream_settings()

    @classmethod
    async def set_stream_prefs(cls, resolution=None, frameRate=None):
        from json import dump as _dump
        cfg = cls._load_stream_settings()
        if resolution is not None:
            if resolution not in cls._STREAM_RES:
                return {"ok": False, "error": f"résolution inconnue: {resolution}"}
            cfg["resolution"] = resolution
        if frameRate is not None:
            if frameRate not in cls._STREAM_FPS:
                return {"ok": False, "error": f"cadence inconnue: {frameRate}"}
            cfg["frameRate"] = frameRate
        try:
            os.makedirs(os.path.dirname(cls._STREAM_CFG), exist_ok=True)
            with open(cls._STREAM_CFG, "w") as f:
                _dump(cfg, f)
        except Exception as e:
            logger.warning(f"save {cls._STREAM_CFG} failed: {e!r}")
            return {"ok": False, "error": str(e)}
        await cls.apply_stream_prefs()
        return {"ok": True, **cfg}

    @classmethod
    async def connect_ws(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(f"window.STEAMCORD.connectWs()")

    @classmethod
    async def get_state(cls):
        return cls.evt_handler.build_state_dict()

    @classmethod
    async def login_with_token(cls, token: str):
        from tab_utils.cdp import get_tab
        tab = await get_tab("discord")
        if tab is None:
            return False
        await tab.open_websocket()
        result = await tab.evaluate(f"window.steamcordLoginWithToken({repr(token)})")
        await tab.close_websocket()
        return result in ("ok", "reload")

    @classmethod
    async def toggle_mute(cls):
        logger.info("Toggling mute")
        return await cls.evt_handler.toggle_mute(act=True)

    @classmethod
    async def toggle_deafen(cls):
        logger.info("Toggling deafen")
        return await cls.evt_handler.toggle_deafen(act=True)

    @classmethod
    async def disconnect_vc(cls):
        logger.info("Disconnecting vc")
        return await cls.evt_handler.disconnect_vc()

    # ── Push-to-talk : agrégation PAR SOURCE ──
    # $ptt est un booléen SANS source. Avec un seul producteur (la manette, côté
    # frontend) ça suffisait. Dès qu'un second producteur existe (clavier/souris,
    # lus par input_watch dans CE processus), le dernier qui parle gagne : manette
    # tenue + touche tenue, on relâche la TOUCHE → set_ptt(False) coupait le micro
    # alors que la manette est toujours enfoncée. On garde donc l'état par source et
    # on n'émet vers le client que sur un front de l'AGRÉGAT (OU logique) — « une
    # source quelconque tenue = micro ouvert », ce qui est aussi le comportement
    # attendu (manette en portable, clavier en station d'accueil).
    _ptt_sources = {}
    _ptt_active = False

    @classmethod
    async def _ptt_sync(cls):
        want = any(cls._ptt_sources.values())
        if want == cls._ptt_active:
            return
        cls._ptt_active = want
        await cls.evt_handler.send_client({"type": "$ptt", "value": want})

    @classmethod
    async def set_ptt(cls, value, source="controller"):
        # `source` par défaut = "controller" : les appels existants du frontend
        # (call("set_ptt", true)) restent valides sans changement.
        cls._ptt_sources[source] = bool(value)
        await cls._ptt_sync()

    @classmethod
    async def _ptt_release_all(cls):
        """Relâche toutes les sources (changement de config, arrêt du lecteur)."""
        if not cls._ptt_sources:
            return
        cls._ptt_sources = {}
        await cls._ptt_sync()

    @classmethod
    async def enable_ptt(cls, enabled):
        await cls.evt_handler.send_client({"type": "$setptt", "enabled": enabled})

    # Rich Presence (issue #11) : mémorisé pour re-pousser à chaque (re)connexion
    # du client (Vesktop redémarre à la bascule Bureau↔gamemode et une activité
    # LOCAL_ACTIVITY_UPDATE ne survit pas au reload). started_at ne change que
    # quand le JEU change → le « temps de jeu écoulé » ne repart pas de zéro à
    # chaque reconnexion.
    _rpc_game = None
    _rpc_since = None
    # Préférence « afficher le jeu en cours sur Discord » (QAM → Config).
    # Persistée en JSON comme steamcord-input.json ; None = pas encore chargée.
    _RPC_CFG = os.path.expanduser("~/.config/steamcord-rpc.json")
    _rpc_enabled = None

    @classmethod
    def _rpc_pref(cls):
        if cls._rpc_enabled is None:
            cls._rpc_cfg()
        return cls._rpc_enabled

    # #41 : la base de Discord ne distingue pas toujours deux jeux qui partagent
    # un exécutable — toute la série Need for Speed classique utilise speed.exe,
    # et Discord ne connaît qu'un seul « Most Wanted ». Aucune heuristique ne
    # peut trancher ça : on rend donc la main à l'utilisateur, avec un
    # interrupteur pour couper la détection et un champ pour imposer un titre.
    _rpc_detect = None
    _rpc_override = None

    @classmethod
    def _rpc_cfg(cls):
        """Charge le JSON complet une fois, et remplit les trois préférences."""
        from json import load
        cfg = {}
        try:
            with open(cls._RPC_CFG) as f:
                cfg = load(f) or {}
        except Exception:
            cfg = {}
        if cls._rpc_enabled is None:
            cls._rpc_enabled = bool(cfg.get("enabled", True))
        if cls._rpc_detect is None:
            cls._rpc_detect = bool(cfg.get("detect_launcher_games", True))
        if cls._rpc_override is None:
            cls._rpc_override = str(cfg.get("override", "") or "")
        return cfg

    @classmethod
    def _rpc_cfg_save(cls):
        """Réécrit le fichier ENTIER : `dump({"enabled": ...})` seul effaçait les
        autres clés à chaque bascule de l'interrupteur."""
        from json import dump
        try:
            os.makedirs(os.path.dirname(cls._RPC_CFG), exist_ok=True)
            with open(cls._RPC_CFG, "w") as f:
                dump({"enabled": cls._rpc_pref(),
                      "detect_launcher_games": cls._rpc_detect_pref(),
                      "override": cls._rpc_override_pref()}, f)
        except Exception as e:
            logger.warning(f"save rpc cfg failed: {e!r}")

    @classmethod
    def _rpc_detect_pref(cls):
        if cls._rpc_detect is None:
            cls._rpc_cfg()
        return cls._rpc_detect

    @classmethod
    def _rpc_override_pref(cls):
        if cls._rpc_override is None:
            cls._rpc_cfg()
        return cls._rpc_override

    @classmethod
    async def get_rpc_detect(cls):
        return cls._rpc_detect_pref()

    @classmethod
    async def set_rpc_detect(cls, enabled):
        cls._rpc_detect = bool(enabled)
        cls._rpc_cfg_save()
        await cls.set_rpc(cls._rpc_game)
        return True

    @classmethod
    async def get_rpc_override(cls):
        return cls._rpc_override_pref()

    @classmethod
    async def set_rpc_override(cls, name):
        cls._rpc_override = str(name or "").strip()
        cls._rpc_cfg_save()
        await cls.set_rpc(cls._rpc_game)
        return True

    @classmethod
    async def get_rpc_enabled(cls):
        return cls._rpc_pref()

    @classmethod
    async def set_rpc_enabled(cls, enabled):
        cls._rpc_enabled = bool(enabled)
        cls._rpc_cfg_save()
        # Application immédiate : OFF efface l'activité affichée, ON rejoue le
        # jeu courant (toujours mémorisé, même préférence coupée).
        try:
            await cls.evt_handler.send_client(
                {"type": "$rpc",
                 "game": cls._rpc_game if cls._rpc_enabled else None,
                 "started_at": cls._rpc_since if cls._rpc_enabled else None,
                 "procs": _running_executables() if cls._rpc_enabled and cls._rpc_game else [],
                 "detect": cls._rpc_detect_pref(), "override": cls._rpc_override_pref()})
        except Exception:
            pass
        return True

    @classmethod
    async def set_rpc(cls, game):
        logger.info("Setting RPC")
        if game != cls._rpc_game:
            from time import time as _now
            cls._rpc_game = game
            cls._rpc_since = int(_now() * 1000) if game else None
        if not cls._rpc_pref():
            return
        # #41 : on joint les exécutables vivants pour que le client puisse
        # reconnaître le jeu qu'un LANCEUR a ouvert (Heroic, Lutris...), que
        # Steam ne nous nomme jamais. Inutile quand rien ne tourne.
        await cls.evt_handler.send_client(
            {"type": "$rpc", "game": cls._rpc_game, "started_at": cls._rpc_since,
             "procs": _running_executables() if cls._rpc_game else [],
             "detect": cls._rpc_detect_pref(), "override": cls._rpc_override_pref()})
        cls._rpc_rescan_arm()

    # Steam ne notifie QUE ses propres applications : lancer un jeu DEPUIS Heroic
    # ne produit aucun événement, donc la liste de processus envoyée avec le $rpc
    # est une photo prise avant que le jeu existe (#41). On la rafraîchit tant
    # qu'une application tourne ; le client ignore les envois qui ne changent
    # rien, donc ceci ne provoque aucun trafic Discord inutile.
    _rpc_rescan_task = None
    RPC_RESCAN_PERIOD = 20

    @classmethod
    def _rpc_rescan_arm(cls):
        task = getattr(cls, "_rpc_rescan_task", None)
        if not cls._rpc_game:
            if task is not None:
                task.cancel()
                cls._rpc_rescan_task = None
            return
        if task is not None and not task.done():
            return

        async def _loop():
            try:
                while cls._rpc_game and cls._rpc_pref():
                    await sleep(cls.RPC_RESCAN_PERIOD)
                    if not (cls._rpc_game and cls._rpc_pref()):
                        break
                    try:
                        await cls.evt_handler.send_client(
                            {"type": "$rpc", "game": cls._rpc_game,
                             "started_at": cls._rpc_since,
                             "procs": _running_executables(),
                             "detect": cls._rpc_detect_pref(),
                             "override": cls._rpc_override_pref()})
                    except Exception:
                        # Client absent/reconnexion : réessai au tour suivant.
                        pass
            finally:
                # L'annulation se propage d'elle-même ; on ne veut ici que
                # libérer la référence pour qu'un prochain arm() reparte.
                cls._rpc_rescan_task = None

        cls._rpc_rescan_task = create_task(_loop())

    @classmethod
    async def set_user_volume(cls, user_id, volume, context="default"):
        await cls.evt_handler.send_client({"type": "$set_user_volume", "id": user_id, "volume": volume, "context": context})

    @classmethod
    async def get_user_volume(cls, user_id, context="default"):
        # Vérité moteur (MediaEngineStore.getLocalVolume) : le QAM relit le
        # volume au montage au lieu de retomber sur 100 % (issue #5). Un vieux
        # client déjà en page ne connaît pas $get_user_volume → toute réponse
        # non numérique retombe sur 100 (le défaut visuel d'avant).
        r = await cls.evt_handler.api.get_user_volume(user_id, context)
        return r if isinstance(r, (int, float)) and not isinstance(r, bool) else 100

    @classmethod
    async def set_discord_status(cls, status):
        # status: "online" | "idle" | "dnd" | "invisible"
        await cls.evt_handler.send_client({"type": "$set_status", "status": status})

    @classmethod
    async def get_discord_status(cls):
        return await cls.evt_handler.api._store_access_request("$get_status")

    @classmethod
    async def get_last_channels(cls):
        return await cls.evt_handler.api.get_last_channels()

    # Jeton → chemin, rempli par list_videos(). On ne prend JAMAIS un chemin
    # fourni par le client : sans ça, /clip?path=… lirait n'importe quel fichier
    # du disque via une requête locale. Le client ne manipule que des jetons.
    # 3 tours de 15 s : un blocage passager ne dérange plus personne, un vrai
    # wedge (définitif) alerte au bout de ~45 s.
    PW_WEDGE_ALERT_AFTER = 3
    _pw_wedge_misses = 0

    _clip_index = {}
    # Copies mp4 temporaires, effacées au déchargement du plugin.
    _clip_tmp = set()

    @classmethod
    async def list_videos(cls):
        from hashlib import sha1
        out = []
        cls._clip_index = {}
        # Clips Steam d'abord : c'est ce que les gens viennent d'enregistrer.
        for d, appid, size, mtime in _steam_clips():
            tok = sha1(d.encode("utf-8", "replace")).hexdigest()[:16]
            cls._clip_index[tok] = d
            out.append({"token": tok, "name": os.path.basename(d), "size": size,
                        "mtime": int(mtime), "kind": "steam", "appid": appid,
                        # Steam dépose lui-même une vignette dans le dossier du
                        # clip : rien à extraire, il suffit de la réduire.
                        "has_thumb": os.path.isfile(os.path.join(d, "thumbnail.jpg")),
                        # Un clip Steam dépasse presque toujours la limite : il
                        # sera assemblé puis compressé, pas refusé.
                        "will_convert": True})
        for full, name, size, mtime in _list_videos():
            tok = sha1(full.encode("utf-8", "replace")).hexdigest()[:16]
            cls._clip_index[tok] = full
            out.append({"token": tok, "name": name, "size": size,
                        "mtime": int(mtime), "kind": "file", "appid": "",
                        # Une vidéo ordinaire n'a pas de vignette fournie ; on
                        # n'en extrait pas (une passe ffmpeg par fichier à
                        # l'ouverture du sélecteur), la tuile reste neutre.
                        "has_thumb": False,
                        "will_convert": size > DISCORD_UPLOAD_LIMIT
                                        or not name.lower().endswith(DISCORD_PLAYABLE)})
        out.sort(key=lambda e: e["mtime"], reverse=True)
        return out

    # Vignettes déjà réduites, indexées par jeton. Un clip ne change pas : une
    # fois la miniature fabriquée elle reste valable jusqu'au déchargement.
    _clip_thumbs: dict = {}

    @classmethod
    async def clip_thumb(cls, token):
        """Vignette d'un clip Steam, en data URI prête à poser dans un <img>.

        Demandée PAR TUILE depuis l'interface plutôt que jointe à la liste :
        l'originale de Steam fait 1920x1080 pour ~290 Kio, et les empiler dans
        la réponse de `list_videos` ferait transiter plusieurs Mio en base64 sur
        la websocket qui sert aussi la voix. Réduite à 320 px, une vignette pèse
        une vingtaine de Kio.

        Réduction par ffmpeg et non par Pillow : ffmpeg est déjà une dépendance
        déclarée du plugin, avec son environnement nettoyé, alors que
        python3-pillow n'est pas garanti sur SteamOS.
        """
        cached = cls._clip_thumbs.get(token)
        if cached is not None:
            return cached
        entry = cls._clip_index.get(token)
        if not entry or not os.path.isdir(entry):
            return ""
        src = os.path.join(entry, "thumbnail.jpg")
        if not os.path.isfile(src):
            return ""
        out = os.path.join(tempfile.gettempdir(), f"steamcord-thumb-{token}.jpg")
        if not os.path.isfile(out):
            rc, err = await _run_ffmpeg(
                ["-i", src, "-vf", "scale=320:-1", "-q:v", "6", out],
                timeout=20)
            if rc != 0 or not os.path.isfile(out):
                logger.warning(f"vignette illisible pour le clip {token}: {err.strip()}")
                cls._clip_thumbs[token] = ""
                return ""
        try:
            import base64
            data = "data:image/jpeg;base64," + base64.b64encode(
                open(out, "rb").read()).decode("ascii")
        except OSError as e:
            logger.warning(f"vignette illisible ({e}) pour le clip {token}")
            data = ""
        cls._clip_thumbs[token] = data
        return data

    @classmethod
    async def _serve_clip(cls, request):
        from aiohttp.web import FileResponse, Response
        tok = request.query.get("t", "")
        path = cls._clip_index.get(tok)
        if not path or not os.path.isfile(path):
            return Response(status=404, text="unknown clip")
        return FileResponse(path)

    @classmethod
    async def send_video(cls, channel_id, token):
        """Fait tirer le fichier par le client plutôt que de le pousser.

        Les captures d'écran transitent en base64 par la websocket ; une vidéo
        de plusieurs dizaines de Mio y gonflerait d'un tiers et bloquerait la
        boucle qui sert aussi la voix. Le client va le chercher en HTTP local et
        le remet à CloudUpload, qui sait déjà téléverser vers le CDN Discord.
        """
        entry = cls._clip_index.get(token)
        if not entry:
            return False
        # Discord ne lit en ligne ni le .mkv ni le .m4v : sans ce remuxage le
        # clip arrive en pièce jointe à télécharger, ce qui rate le but. On
        # substitue la copie mp4 DANS L'INDEX, pour que la route serve bien
        # celle-ci — le client, lui, ne manipule toujours qu'un jeton.
        send_path = entry
        # ① Clip Steam : recoller les fragments, sinon il n'y a aucun fichier.
        if os.path.isdir(entry):
            asm = os.path.join(tempfile.gettempdir(),
                               "steamcord-" + os.path.basename(entry) + ".mp4")
            built = await _assemble_steam_clip(entry, asm)
            if not built:
                logger.warning(f"clip Steam illisible : {entry}")
                return False
            cls._clip_tmp.add(built)
            send_path = built
            logger.info(f"clip Steam assemblé : {os.path.basename(built)} "
                        f"({os.path.getsize(built) / 1048576:.1f} Mio)")
        else:
            # ② Fichier ordinaire dans un conteneur que Discord ne lit pas.
            remuxed = await _playable_copy(entry)
            if remuxed:
                cls._clip_tmp.add(remuxed)
                send_path = remuxed
                logger.info(f"clip remuxé en mp4 : {os.path.basename(remuxed)}")
        # ③ Trop lourd : compresser plutôt que refuser. Un clip Steam de 25 s
        # pèse ~32 Mio, soit trois fois la limite — sans ceci la fonctionnalité
        # ne servirait qu'aux petites vidéos déjà prêtes.
        if os.path.getsize(send_path) > DISCORD_UPLOAD_LIMIT:
            small = send_path + ".small.mp4"
            done = await _shrink_to_limit(send_path, small)
            if not done:
                logger.warning("clip trop lourd et non compressible")
                return False
            cls._clip_tmp.add(done)
            send_path = done
            logger.info(f"clip compressé : {os.path.getsize(done) / 1048576:.1f} Mio")
        cls._clip_index[token] = send_path
        send_name = _send_filename(entry, send_path)
        await cls.evt_handler.send_client(
            {"type": "$clip", "channel_id": channel_id,
             "url": f"http://127.0.0.1:65123/clip?t={token}",
             "filename": send_name})
        return True

    @classmethod
    async def post_screenshot(cls, channel_id, data):
        logger.info("Posting screenshot to " + channel_id)
        r = await cls.evt_handler.api.post_screenshot(channel_id, data)

        if r:
            return True

        payload = dumps({"title": "Steamcord", "body": "Error while posting screenshot"})
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(
            f"DeckyPluginLoader.toaster.toast(JSON.parse('{payload}'));"
        )

    @classmethod
    async def get_screen_bounds(cls):
        return await cls.evt_handler.api.get_screen_bounds()

    # ── CAPTCHA de la page de login (#37) ──────────────────────────────────
    # Discord plante parfois un hCaptcha SUR sa page de login quand il n'aime
    # pas l'IP. Tant qu'il n'est pas résolu, aucun ticket de remote-auth n'est
    # émis : le QR se régénère toutes les ~30 s, sans fin et sans un mot.
    #
    # On ne peut PAS simplement montrer la fenêtre Vesktop pour le résoudre.
    # Mesuré sur BC-250 en mode Jeu : la fenêtre est démappée (--start-minimized)
    # et la re-mapper à la main ne change RIEN à l'écran — gamescope ne peint que
    # la fenêtre que Steam a désignée (GAMESCOPECTRL_BASELAYER_APPID), et une
    # capture avant/après est identique au md5 près. La poser en overlay externe
    # (l'atome de mangoapp, cf. game_overlay/overlay.py) l'affiche mais SANS
    # focus ni entrées : increvable pour un HUD, inutile pour cliquer.
    #
    # Le seul chemin qui marche en mode Jeu est donc de miroiter la page dans
    # notre propre UI et de lui renvoyer les clics par CDP. Page.captureScreenshot
    # rend même fenêtre démappée (vérifié : document.visibilityState reste
    # "visible"), donc l'image est vivante et à jour.
    # MÊME règle que findCaptcha() dans steamcord_client.js — les deux doivent
    # rester d'accord, sinon le panneau annonce un défi que le miroir ne cadre
    # pas (ou l'inverse). Plancher de hauteur BAS (la case « je ne suis pas un
    # robot » fait ~302×76) et test de visibilité (l'iframe du défi en grille
    # existe en visibility:hidden avant d'être ouverte).
    _CAPTCHA_RECT_JS = """(() => {
      let best = null;
      for (const f of document.querySelectorAll("iframe")) {
        if (!/hcaptcha\\.com|recaptcha|arkoselabs\\.com|funcaptcha/i.test(f.src || "")) continue;
        const r = f.getBoundingClientRect();
        if (r.width < 80 || r.height < 40) continue;
        const cs = getComputedStyle(f);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (parseFloat(cs.opacity || "1") < 0.1) continue;
        if (!best || r.width * r.height > best.w * best.h)
          best = { x: r.left, y: r.top, w: r.width, h: r.height };
      }
      return JSON.stringify(best || null);
    })()"""

    @classmethod
    async def captcha_session(cls, on: bool):
        """Ouvre/ferme la session de résolution. Emulation.setFocusEmulationEnabled
        fait croire à la page qu'elle a le focus : sans ça `document.hasFocus()`
        est faux (la fenêtre est démappée), et hCaptcha refuse d'ouvrir son défi.
        Posé seulement le temps de la résolution — le laisser en permanence
        changerait la détection d'inactivité de Discord."""
        tab = getattr(cls, "discord_tab", None)
        if tab is None:
            return False
        try:
            await tab.ensure_open()
            await tab._send_devtools_cmd({
                "method": "Emulation.setFocusEmulationEnabled",
                "params": {"enabled": bool(on)},
            }, False)
            return True
        except Exception as e:
            logger.warning(f"[captcha] session({on}) failed: {e!r}")
            return False

    @classmethod
    async def captcha_frame(cls, full: bool = False):
        """Une image du défi — ou de toute la page de login si `full` — avec le
        rectangle de PAGE qu'elle couvre, pour que le frontend retraduise ses
        clics en coordonnées de page."""
        from json import loads
        tab = getattr(cls, "discord_tab", None)
        if tab is None:
            return None
        try:
            await tab.ensure_open()
            vw, vh = 1280, 720
            try:
                res = await tab.evaluate(
                    "JSON.stringify([innerWidth, innerHeight])", wait=True)
                val = (((res or {}).get("result") or {}).get("result") or {}).get("value")
                if val:
                    vw, vh = loads(val)
            except Exception:
                pass

            rect = None
            if not full:
                res = await tab.evaluate(cls._CAPTCHA_RECT_JS, wait=True)
                val = (((res or {}).get("result") or {}).get("result") or {}).get("value")
                if val and val != "null":
                    rect = loads(val)

            if rect:
                # Marge : la case « je ne suis pas un robot » et le bouton de
                # validation du défi débordent légèrement de l'iframe.
                m = 12
                x = max(0, rect["x"] - m)
                y = max(0, rect["y"] - m)
                w = min(vw - x, rect["w"] + 2 * m)
                h = min(vh - y, rect["h"] + 2 * m)
                scale = 1.0
            else:
                # Pas (encore) de défi visible : on miroite la page entière, ce
                # qui couvre aussi l'interstitiel « Wait! Are you human? » servi
                # AVANT que l'iframe du défi n'existe.
                x, y, w, h = 0, 0, vw, vh
                scale = 0.75

            shot = await tab._send_devtools_cmd({
                "method": "Page.captureScreenshot",
                "params": {
                    "format": "jpeg",
                    "quality": 70,
                    "clip": {"x": x, "y": y, "width": w, "height": h, "scale": scale},
                },
            }, True)
            data = (((shot or {}).get("result") or {}).get("data"))
            if not data:
                return None
            return {
                "img": "data:image/jpeg;base64," + data,
                # Rectangle de PAGE couvert par l'image (coordonnées CSS).
                "x": x, "y": y, "w": w, "h": h,
                "challenge": rect is not None,
            }
        except Exception as e:
            logger.warning(f"[captcha] frame failed: {e!r}")
            return None

    @classmethod
    async def captcha_click(cls, x: float, y: float):
        """Clic à (x, y) en pixels CSS de la page de login."""
        tab = getattr(cls, "discord_tab", None)
        if tab is None:
            return False
        try:
            await tab.ensure_open()
            # Un mouseMoved AVANT le clic : un appui qui surgit sans le moindre
            # déplacement de pointeur est une signature de robot évidente, et
            # hCaptcha regarde exactement ça.
            base = {"x": float(x), "y": float(y), "button": "left"}
            await tab._send_devtools_cmd({
                "method": "Input.dispatchMouseEvent",
                "params": dict(base, type="mouseMoved", buttons=0),
            }, False)
            await sleep(0.05)
            await tab._send_devtools_cmd({
                "method": "Input.dispatchMouseEvent",
                "params": dict(base, type="mousePressed", buttons=1, clickCount=1),
            }, False)
            await sleep(0.04)
            await tab._send_devtools_cmd({
                "method": "Input.dispatchMouseEvent",
                "params": dict(base, type="mouseReleased", buttons=0, clickCount=1),
            }, False)
            return True
        except Exception as e:
            logger.warning(f"[captcha] click failed: {e!r}")
            return False

    # Réordonner/masquer des serveurs (issue #18) : préférences 100% LOCALES à
    # Steamcord, PAS le tri natif Discord. Vérifié en vrai (redémarrage complet
    # de Vesktop) : GUILD_MOVE_BY_ID (le mécanisme du glisser-déposer natif)
    # met à jour l'arbre en mémoire du client MAIS ne persiste JAMAIS côté
    # compte — l'ordre revenait comme avant après reload. Portage sur nos
    # propres fichiers = vraiment permanent, et on n'a pas besoin de
    # reproduire la synchro settings-proto de Discord (protobuf, fragile).
    _GUILD_ORDER_CFG = os.path.expanduser("~/.config/steamcord-guild-order.json")
    _HIDDEN_GUILDS_CFG = os.path.expanduser("~/.config/steamcord-hidden-guilds.json")
    _guild_order = None
    _hidden_guilds = None

    @staticmethod
    def _load_json_list(path, key):
        from json import load
        try:
            with open(path) as f:
                return list(load(f).get(key, []))
        except Exception:
            return []

    @staticmethod
    def _save_json_list(path, key, values):
        from json import dump
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                dump({key: values}, f)
        except Exception as e:
            logger.warning(f"save {path} failed: {e!r}")

    @classmethod
    def _guild_order_list(cls):
        if cls._guild_order is None:
            cls._guild_order = cls._load_json_list(cls._GUILD_ORDER_CFG, "order")
        return cls._guild_order

    @classmethod
    def _hidden_guilds_set(cls):
        if cls._hidden_guilds is None:
            cls._hidden_guilds = set(cls._load_json_list(cls._HIDDEN_GUILDS_CFG, "ids"))
        return cls._hidden_guilds

    @classmethod
    async def set_guild_order(cls, ordered_ids):
        cls._guild_order = [str(g) for g in ordered_ids] if isinstance(ordered_ids, list) else []
        cls._save_json_list(cls._GUILD_ORDER_CFG, "order", cls._guild_order)
        return True

    @classmethod
    async def set_guild_hidden(cls, guild_id, hidden):
        ids = cls._hidden_guilds_set()
        if hidden:
            ids.add(str(guild_id))
        else:
            ids.discard(str(guild_id))
        cls._save_json_list(cls._HIDDEN_GUILDS_CFG, "ids", sorted(ids))
        return True

    @classmethod
    def _apply_guild_prefs(cls, guilds, include_hidden):
        # Ordre + masquage PARTAGÉS entre l'onglet vocal et l'onglet textuel
        # (mêmes fichiers de prefs) : cacher/déplacer un serveur agit sur les
        # deux listes d'un coup — ce sont les mêmes serveurs.
        # Un serveur PAS dans `order` (nouveau, jamais réordonné, ou qu'on a
        # quitté depuis) atterrit après ceux explicitement ordonnés, dans son
        # ordre naturel Discord — jamais perdu, jamais planté par une entrée
        # périmée (le dict `present` filtre silencieusement les ids qui ne
        # correspondent plus à un serveur actuel).
        hidden = cls._hidden_guilds_set()
        order = cls._guild_order_list()
        # `clean` et PAS `guilds` pour la suite : le filtre isinstance n'était
        # appliqué qu'à `present`, si bien qu'une entrée non-dict traversait
        # quand même `rest` et la boucle de marquage → `AttributeError: 'str'
        # object has no attribute 'get'` remontée BRUTE dans le QAM. Une seule
        # liste assainie, utilisée partout (#28).
        clean = [g for g in guilds if isinstance(g, dict) and g.get("id")]
        present = {g["id"]: g for g in clean}
        ordered = [present[gid] for gid in order if gid in present]
        ordered_ids = {g["id"] for g in ordered}
        rest = [g for g in clean if g["id"] not in ordered_ids]
        merged = ordered + rest
        for g in merged:
            g["hidden"] = g.get("id") in hidden
        return merged if include_hidden else [g for g in merged if not g["hidden"]]

    @classmethod
    async def get_guilds_vc(cls, include_hidden=False):
        # Tout ce qui s'échappe d'ici part TEL QUEL dans le QAM — c'est ce que
        # voyait le rapporteur de #28 (« error: python exception »), sans la
        # moindre trace exploitable dans les logs. On journalise la pile et on
        # renvoie un code stable que le frontend sait traduire. Les codes déjà
        # connus du frontend (`discord_reconnecting`, `stores_not_ready`) sont
        # relayés intacts : eux ont une traduction et un réessai dédiés.
        try:
            guilds = await cls.evt_handler.api.get_guilds_vc()
        except Exception as e:
            msg = str(e)
            if "discord_reconnecting" in msg or "stores_not_ready" in msg:
                raise
            logger.exception("get_guilds_vc failed")
            raise Exception("guilds_failed") from None
        if not isinstance(guilds, list):
            return guilds
        try:
            return cls._apply_guild_prefs(guilds, include_hidden)
        except Exception:
            # Les préférences (ordre/masquage) ne valent pas de perdre la liste :
            # en cas de pépin on rend les serveurs bruts plutôt que rien.
            logger.exception("guild prefs failed — falling back to raw list")
            return [g for g in guilds if isinstance(g, dict) and g.get("id")]

    @classmethod
    async def join_vc(cls, channel_id, guild_id):
        return await cls.evt_handler.api.join_vc(channel_id, guild_id)

    @classmethod
    async def get_dm_channels(cls):
        return await cls.evt_handler.api.get_dm_channels()

    @classmethod
    async def dm_call(cls, channel_id, join_existing=False):
        return await cls.evt_handler.api.dm_call(channel_id, join_existing)

    @classmethod
    async def get_text_channels(cls, include_hidden=False):
        guilds = await cls.evt_handler.api.get_text_channels()
        if not isinstance(guilds, list):
            return guilds
        # Mêmes prefs ordre/masquage que l'onglet vocal (les MP ne sont pas
        # concernés — liste séparée, get_dm_channels).
        return cls._apply_guild_prefs(guilds, include_hidden)

    @classmethod
    async def get_messages(cls, channel_id, before=None):
        return await cls.evt_handler.api.get_messages(channel_id, before)

    @classmethod
    async def send_message(cls, channel_id, content, reply_to=None):
        # Même traitement que les actions sur un message : un envoi refusé est
        # l'échec le plus visible du plugin, il ne peut pas se contenter du
        # « Python Exception » que Decky substitue au vrai motif.
        return await cls._msg_action(
            "send_message",
            cls.evt_handler.api.send_message(channel_id, content, reply_to))

    @classmethod
    async def send_typing(cls, channel_id):
        return await cls.evt_handler.api.send_typing(channel_id)

    @classmethod
    async def watch_channel(cls, channel_id=None):
        return await cls.evt_handler.api.watch_channel(channel_id)

    @classmethod
    async def set_fullscreen_channel(cls, channel_id=""):
        # Salon actuellement ouvert dans le chat PLEIN ÉCRAN — le backend coupe
        # les notifs de MESSAGE de ce seul salon tant qu'il est ouvert (David
        # #21). Distinct de watch_channel (le QAM le pose aussi, mais le QAM ne
        # doit PAS couper les notifs). "" = aucun (fermé).
        cls.evt_handler.fullscreen_channel = str(channel_id or "")
        return {"ok": True}

    @classmethod
    async def _msg_action(cls, label, coro):
        """Exécute une action sur un message en RAMENANT le motif d'un échec.

        Une exception qui traverse Decky perd son texte en route : le loader la
        rend au frontend sous la forme d'un « Python Exception » générique, et
        elle n'apparaît dans aucun log de plugin. C'est précisément le
        brouillard du #21 — vérifié en simulant un refus d'édition, où l'erreur
        rouge s'affichait sans le moindre motif, ici comme dans les logs.
        Le motif est donc tracé côté plugin ET renvoyé comme VALEUR de retour,
        seul canal que la couche Decky ne réécrit pas.
        """
        try:
            return await coro
        except Exception as e:
            reason = str(e) or e.__class__.__name__
            logger.warning(f"[msg] {label} refused: {reason}")
            return {"ok": False, "error": reason}

    @classmethod
    async def edit_message(cls, channel_id, message_id, content):
        return await cls._msg_action(
            "edit_message",
            cls.evt_handler.api.edit_message(channel_id, message_id, content))

    @classmethod
    async def delete_message(cls, channel_id, message_id):
        return await cls._msg_action(
            "delete_message",
            cls.evt_handler.api.delete_message(channel_id, message_id))

    @classmethod
    async def add_reaction(cls, channel_id, message_id, emoji):
        return await cls._msg_action(
            "add_reaction",
            cls.evt_handler.api.add_reaction(channel_id, message_id, emoji))

    @classmethod
    async def remove_reaction(cls, channel_id, message_id, emoji):
        return await cls._msg_action(
            "remove_reaction",
            cls.evt_handler.api.remove_reaction(channel_id, message_id, emoji))

    @classmethod
    async def get_soundboard_sounds(cls):
        return await cls.evt_handler.api.get_soundboard_sounds()

    @classmethod
    async def play_soundboard_sound(cls, sound_id, source_guild_id=None):
        return await cls.evt_handler.api.play_soundboard_sound(sound_id, source_guild_id)

    @classmethod
    async def get_local_mute(cls, user_id):
        r = await cls.evt_handler.api.get_local_mute(user_id)
        # Le client (ancien, déjà en page) renvoie `false` coercé en `{}` via
        # `result || {}` → le frontend ferait `!!{}` = true = muet à tort. Seul un
        # vrai `True` = réellement muté localement. On normalise ici → fix immédiat
        # sans dépendre d'une ré-injection du client.
        return r is True

    @classmethod
    async def toggle_local_mute(cls, user_id):
        return await cls.evt_handler.api.toggle_local_mute(user_id)

    @classmethod
    async def set_local_mute(cls, user_id, muted):
        return await cls.evt_handler.api.set_local_mute(user_id, muted)

    @classmethod
    async def get_audio_processing(cls):
        r = await cls.evt_handler.api.get_audio_processing()
        # Client indisponible (reconnexion…) : montrer au moins les prefs
        # persistées plutôt que des défauts trompeurs (issue #14).
        if (not isinstance(r, dict) or r.get("error")) and cls._mic_prefs:
            return {"noise": cls._mic_prefs.get("noise", "krisp"),
                    "echoCancellation": cls._mic_prefs.get("echoCancellation", True),
                    "automaticGainControl": cls._mic_prefs.get("automaticGainControl", True)}
        return r

    @classmethod
    async def set_noise_reduction(cls, mode):
        cls._mic_prefs["noise"] = mode
        cls._save_audio_cfg()
        return await cls.evt_handler.api.set_noise_reduction(mode)

    @classmethod
    async def set_echo_cancellation(cls, enabled):
        cls._mic_prefs["echoCancellation"] = bool(enabled)
        cls._save_audio_cfg()
        return await cls.evt_handler.api.set_echo_cancellation(enabled)

    @classmethod
    async def set_automatic_gain_control(cls, enabled):
        cls._mic_prefs["automaticGainControl"] = bool(enabled)
        cls._save_audio_cfg()
        return await cls.evt_handler.api.set_automatic_gain_control(enabled)

    @classmethod
    async def _on_logged_in(cls):
        """Ré-assertions à chaque login du client Discord. Le plugin est la
        source de vérité : ni les réglages micro (#14) ni la qualité de partage
        (#33) ne doivent pouvoir « revenir » aux défauts après un redémarrage."""
        await cls._apply_mic_prefs()
        await cls.apply_stream_prefs()

    @classmethod
    async def _apply_mic_prefs(cls):
        """Ré-asserte les réglages micro persistés (appelé à chaque login du
        client Discord) : le plugin est la source de vérité, les défauts ne
        peuvent plus « revenir » après un restart (issue #14)."""
        prefs = dict(cls._mic_prefs)
        if not prefs:
            return
        try:
            if "noise" in prefs:
                await cls.evt_handler.api.set_noise_reduction(prefs["noise"])
            if "echoCancellation" in prefs:
                await cls.evt_handler.api.set_echo_cancellation(bool(prefs["echoCancellation"]))
            if "automaticGainControl" in prefs:
                await cls.evt_handler.api.set_automatic_gain_control(bool(prefs["automaticGainControl"]))
            logger.info(f"mic prefs re-asserted: {prefs}")
        except Exception as e:
            logger.warning(f"mic prefs reassert failed: {e!r}")

    @classmethod
    async def _screen_diag(cls):
        # Diagnostic capture d'écran : log périodiquement si on est en mode JEU
        # (gamescope) et quels nodes vidéo PipeWire existent. Tourne dans plugin_loader
        # (survit aux changements de mode) → capture l'état mode jeu même offline.
        from json import loads
        import vesktop
        while True:
            try:
                # -x avec les deux noms : le comm du compositeur est `gamescope-wl`
                # sur Bazzite (gamescope tout court sur SteamOS) — avec le seul
                # `gamescope`, ce log disait False alors qu'on était en mode jeu.
                in_game = vesktop.proc_running(comm="gamescope(-wl)?")
                vids = []
                try:
                    p = await create_subprocess_exec("pw-dump", stdout=PIPE, stderr=DEVNULL, env=vesktop._user_env())
                    # Timeout court : cette boucle tourne toutes les 15s, un
                    # PipeWire wedgé empilerait un pw-dump pendu par tour (6
                    # observés le 19/07). Le timeout sert aussi de DÉTECTEUR :
                    # on prévient l'utilisateur une fois (seul remède connu =
                    # redémarrer la session gamescope, le node écran ne survit
                    # pas à un restart de pipewire seul).
                    try:
                        out, _ = await wait_for(p.communicate(), 5)
                    except Exception:
                        try:
                            p.kill()
                        except ProcessLookupError:
                            pass
                        # Un VRAI wedge est définitif : pw-dump ne revient jamais.
                        # Un sondage isolé qui expire, lui, se rétablit au tour
                        # suivant — vu 5 fois le 25/08, tout est reparti en 15 s
                        # à chaque fois. Alerter au premier échec revenait donc à
                        # conseiller de redémarrer la console pour un incident
                        # déjà résolu. On exige 3 tours consécutifs (~45 s de
                        # silence) avant de déranger l'utilisateur.
                        misses = getattr(cls, "_pw_wedge_misses", 0) + 1
                        cls._pw_wedge_misses = misses
                        logger.warning(f"[screendiag] pw-dump muet après 5s "
                                       f"({misses}/{cls.PW_WEDGE_ALERT_AFTER}) — PipeWire ne répond plus")
                        if misses >= cls.PW_WEDGE_ALERT_AFTER and not getattr(cls, "_pw_wedge_toasted", False):
                            cls._pw_wedge_toasted = True
                            await cls._toast("Steamcord",
                                             "Audio system (PipeWire) stopped responding — "
                                             "restart the console to recover streaming/audio.")
                        await sleep(15)
                        continue
                    if getattr(cls, "_pw_wedge_misses", 0):
                        logger.info(f"[screendiag] PipeWire répond de nouveau "
                                    f"(après {cls._pw_wedge_misses} sondage(s) muet(s))")
                    cls._pw_wedge_misses = 0
                    cls._pw_wedge_toasted = False
                    for n in loads(out.decode() or "[]"):
                        if not str(n.get("type", "")).endswith("Node"):
                            continue
                        pr = (n.get("info", {}) or {}).get("props", {}) or {}
                        mc = str(pr.get("media.class", "")); nm = str(pr.get("node.name", ""))
                        if "Video" in mc or "gamescope" in (nm + mc).lower() or "screen" in nm.lower():
                            vids.append(f"{n.get('id')}:{nm}:{mc}")
                except Exception as e:
                    vids = [f"pw-dump err {e!r}"]
                logger.info(f"[screendiag] gamescope={in_game} video_nodes={vids}")
            except Exception as e:
                logger.warning(f"[screendiag] {e!r}")
            await sleep(15)

    @classmethod
    async def logout_discord(cls):
        # Déconnexion totale de Discord (invalide le token + retour login/QR).
        await cls.evt_handler.send_client({"type": "$logout"})

    # ── Sélection des périphériques audio (sortie/entrée) pour Discord ──────────
    # Discord/Vesktop ne voit que "Default" en headless → on pilote au niveau
    # SYSTÈME via PipeWire (pactl), en routant les flux de Vesktop par-application.
    # Ça permet p.ex. d'envoyer le son Discord UNIQUEMENT vers le casque.
    @classmethod
    async def _pactl(cls, *args, want_json=False):
        import vesktop
        pre = ("-f", "json") if want_json else ()
        p = await create_subprocess_exec("pactl", *pre, *args, stdout=PIPE, stderr=DEVNULL, env=vesktop._user_env())
        # ⚠ pactl pend indéfiniment quand PipeWire n'enregistre plus de clients
        # (wedge du 19/07) : sans timeout, le _golive_lock resterait pris pour
        # toujours et plus aucun go_live/stop ne passerait. "" est sûr pour tous
        # les appelants (strip() / loads(x or "[]")).
        try:
            out, _ = await wait_for(p.communicate(), 5)
        except Exception:
            try:
                p.kill()
            except ProcessLookupError:
                pass
            logger.warning(f"pactl {' '.join(args[:2])}: muet après 5s — PipeWire ne répond plus ?")
            return ""
        return out.decode()

    @classmethod
    async def get_stream_volume(cls):
        # Volume BROADCAST du Go Live = volume de la source virtuelle venmic
        # (vencord-screen-share, null-audio-sink avec channelVolumes) : atténue
        # ce que les SPECTATEURS entendent. Régler son propre volume « stream »
        # côté Discord est IGNORÉ par le moteur (on n'entend pas son propre
        # live) — c'était le slider fantôme qui retombait à 18 %.
        from json import loads
        try:
            for s in loads(await cls._pactl("list", "sources", want_json=True) or "[]"):
                if s.get("name") == "vencord-screen-share":
                    for v in (s.get("volume") or {}).values():
                        pct = str(v.get("value_percent", "")).rstrip("%")
                        if pct.isdigit():
                            return int(pct)
        except Exception:
            pass
        return None

    @classmethod
    async def set_stream_volume(cls, volume):
        try:
            v = max(0, min(100, int(volume)))
            await cls._pactl("set-source-volume", "vencord-screen-share", f"{v}%")
            return True
        except Exception:
            return False

    @staticmethod
    def _dev_label(d):
        desc = d.get("description")
        return desc if desc and desc != "(null)" else d.get("name", "")

    @classmethod
    async def get_audio_devices(cls):
        from json import loads
        try:
            sinks = loads(await cls._pactl("list", "sinks", want_json=True) or "[]")
            sources = loads(await cls._pactl("list", "sources", want_json=True) or "[]")
            def_sink = (await cls._pactl("get-default-sink")).strip()
            def_source = (await cls._pactl("get-default-source")).strip()
        except Exception as e:
            return {"error": str(e)}
        outputs = [{"name": s.get("name", ""), "label": cls._dev_label(s)} for s in sinks]
        # Entrées : exclure les monitors (rebouclage de sortie, pas un vrai micro).
        inputs = [{"name": s.get("name", ""), "label": cls._dev_label(s)}
                  for s in sources if not s.get("name", "").endswith(".monitor")]
        return {
            "outputs": outputs, "inputs": inputs,
            "default_output": def_sink, "default_input": def_source,
            "selected_output": cls._audio_out or "auto",
            "selected_input": cls._audio_in or "auto",
        }

    @classmethod
    async def set_audio_output(cls, name):
        cls._audio_out = None if name in (None, "auto") else name
        cls._save_audio_cfg()
        if cls._audio_out is None and not cls._ga_active:
            # Retour « Auto » : _apply_audio_routing ne touche pas aux flux
            # quand la cible est None → sans ce reset ils restaient collés au
            # dernier choix manuel (issue #14).
            await cls._reset_vesktop_routing(outputs=True)
        await cls._apply_audio_routing()
        return True

    @classmethod
    async def set_audio_input(cls, name):
        cls._audio_in = None if name in (None, "auto") else name
        cls._save_audio_cfg()
        if cls._audio_in is None and not cls._ga_active:
            await cls._reset_vesktop_routing(inputs=True)
        await cls._apply_audio_routing()
        return True

    @classmethod
    async def _reset_vesktop_routing(cls, outputs=False, inputs=False):
        """Ramène les flux Vesktop sur le périphérique système par défaut
        (@DEFAULT_SINK@/@DEFAULT_SOURCE@ sont résolus par pactl)."""
        from json import loads
        try:
            if outputs:
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(si):
                        await cls._pactl("move-sink-input", str(si.get("index")), "@DEFAULT_SINK@")
            if inputs:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), "@DEFAULT_SOURCE@")
        except Exception as e:
            logger.warning(f"audio routing reset failed: {e!r}")

    @staticmethod
    def _is_vesktop_stream(s):
        props = s.get("properties", {}) or {}
        blob = " ".join(str(v) for v in props.values()).lower()
        return ("vesktop" in blob) or ("discord" in blob) or ("electron" in blob)

    @classmethod
    async def _apply_audio_routing(cls):
        from json import loads
        out_target = cls._audio_out
        in_target = cls._audio_in
        if cls._ga_active:
            # Partage audio jeu : Vesktop ÉCOUTE sur la vraie sortie (surtout pas le
            # sink jeu, sinon la voix des autres repartirait dans le mix = écho) et
            # CAPTURE le mix micro+jeu à la place du micro.
            out_target = out_target or cls._ga_real_sink
            in_target = "steamcord_mic"
        try:
            if out_target or cls._ga_active:
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(si):
                        if out_target:
                            await cls._pactl("move-sink-input", str(si.get("index")), out_target)
                    elif cls._ga_active and str(si.get("owner_module", "")) not in cls._ga_modules:
                        # Tout le reste (jeu, système) joue dans le sink jeu — les
                        # nouveaux flux y vont déjà (default sink), ceci rattrape les
                        # apps qui ciblent un sink explicite. Move idempotent.
                        await cls._pactl("move-sink-input", str(si.get("index")), "steamcord_game")
            if in_target:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), in_target)
        except Exception as e:
            logger.warning(f"audio routing failed: {e!r}")

    @classmethod
    async def _audio_routing_watcher(cls):
        # Les flux Vesktop apparaissent/disparaissent (à chaque appel) → on ré-applique
        # le routage périodiquement pour qu'un nouveau flux suive le choix de l'user.
        while True:
            try:
                if cls._audio_out or cls._audio_in or cls._ga_active:
                    await cls._apply_audio_routing()
            except Exception:
                pass
            await sleep(4)

    @classmethod
    def _load_audio_cfg(cls):
        from json import load
        try:
            with open(cls._AUDIO_CFG) as f:
                cfg = load(f)
            cls._audio_out = cfg.get("output") or None
            cls._audio_in = cfg.get("input") or None
            if isinstance(cfg.get("mic"), dict):
                cls._mic_prefs = cfg["mic"]
            if isinstance(cfg.get("ga_vol"), dict):
                cls._ga_vol.update({k: int(v) for k, v in cfg["ga_vol"].items()
                                    if k in cls._ga_vol})
        except Exception:
            pass

    @classmethod
    def _save_audio_cfg(cls):
        from json import dump
        try:
            os.makedirs(os.path.dirname(cls._AUDIO_CFG), exist_ok=True)
            with open(cls._AUDIO_CFG, "w") as f:
                dump({"output": cls._audio_out, "input": cls._audio_in,
                      "mic": cls._mic_prefs, "ga_vol": cls._ga_vol}, f)
        except Exception as e:
            logger.warning(f"save audio cfg failed: {e!r}")

    # ── Raccourci vocal (manette / clavier / souris) ──
    # La MANETTE est détectée dans le FRONTEND (SteamClient.Input est la seule API
    # qui voit les boutons Steam). Le CLAVIER et la SOURIS sont lus ICI, par
    # input_watch : CEF n'a pas le focus clavier quand un jeu tourne, donc une
    # capture globale ne peut pas vivre côté frontend. Voir defaults/input_watch.py
    # pour les contraintes de vie privée (aucun code de touche journalisé).
    _INPUT_CFG = os.path.expanduser("~/.config/steamcord-input.json")
    _input_lock = None            # asyncio.Lock (créé à la première écriture)
    _input_watcher = None
    _input_capture = None         # {"token": str, "task": Task} pendant une capture
    _voice_cache = None           # config normalisée (évite un accès disque par touche)
    _input_active = {}            # (kind, code, node) -> source, recalculé au rescan

    VOICE_CFG_V2 = {"version": 2, "enabled": False, "mode": "toggle", "bindings": []}

    @staticmethod
    def _valid_binding(b):
        if not isinstance(b, dict):
            return False
        if b.get("kind") == "controller":
            return isinstance(b.get("buttons"), list) and all(
                isinstance(x, int) for x in b["buttons"]
            )
        if b.get("kind") in ("keyboard", "mouse"):
            return isinstance(b.get("code"), int) and isinstance(b.get("device"), dict)
        return False

    @classmethod
    def _migrate_voice_cfg(cls, raw):
        """Normalise en v2 ; la v1 était {enabled, mode, buttons[], label}.

        La migration est EN MÉMOIRE et on n'écrit la v2 qu'au premier enregistrement
        de l'utilisateur : quelqu'un qui met à jour sans toucher aux réglages garde
        un fichier relisible par l'ancienne version (retour arrière possible).
        """
        cfg = {"version": 2, "enabled": False, "mode": "toggle", "bindings": []}
        if not isinstance(raw, dict):
            return cfg
        cfg["enabled"] = bool(raw.get("enabled", False))
        cfg["mode"] = raw.get("mode") if raw.get("mode") in ("toggle", "ptt") else "toggle"
        if raw.get("version") == 2 and isinstance(raw.get("bindings"), list):
            cfg["bindings"] = [b for b in raw["bindings"] if cls._valid_binding(b)]
            return cfg
        btns = [b for b in (raw.get("buttons") or []) if isinstance(b, int)]
        if btns:
            cfg["bindings"] = [{
                "kind": "controller",
                "buttons": btns,
                "label": raw.get("label") or "",
            }]
        return cfg

    @classmethod
    def _voice_cfg(cls, refresh=False):
        if cls._voice_cache is not None and not refresh:
            return cls._voice_cache
        from json import load
        try:
            with open(cls._INPUT_CFG) as f:
                raw = load(f)
        except Exception:
            raw = None
        cls._voice_cache = cls._migrate_voice_cfg(raw)
        return cls._voice_cache

    @classmethod
    async def get_voice_shortcut(cls):
        return cls._voice_cfg(refresh=True)

    @classmethod
    async def set_voice_shortcut(cls, cfg):
        from json import dump
        # Fusion sur l'existant : l'ancienne version écrasait le blob entier, donc
        # tout appelant ignorant une clé la supprimait silencieusement. Sous verrou
        # (même motif que _golive_seq_lock) pour éviter deux écritures entrelacées.
        if cls._input_lock is None:
            from asyncio import Lock
            cls._input_lock = Lock()
        async with cls._input_lock:
            merged = cls._voice_cfg(refresh=True)
            merged = dict(merged)
            if isinstance(cfg, dict):
                merged.update(cfg)
            merged["version"] = 2
            merged.pop("buttons", None)         # reliquats de la v1
            merged.pop("label", None)
            merged["bindings"] = [
                b for b in (merged.get("bindings") or []) if cls._valid_binding(b)
            ]
            try:
                os.makedirs(os.path.dirname(cls._INPUT_CFG), exist_ok=True)
                with open(cls._INPUT_CFG, "w") as f:
                    dump(merged, f)
            except Exception as e:
                logger.warning(f"save input cfg failed: {e!r}")
                return False
            cls._voice_cache = merged
        # Le binding a pu changer : on repart d'un état de sources propre (sinon une
        # touche « tenue » d'un ancien binding resterait vraie pour toujours) et on
        # réévalue les périphériques à écouter.
        await cls._ptt_release_all()
        await cls._input_refresh()
        return True

    # ── Lecture clavier / souris ────────────────────────────────────────────
    @classmethod
    async def _input_refresh(cls):
        """Démarre, arrête ou réévalue le lecteur selon la config et la capture."""
        cfg = cls._voice_cfg()
        wants = bool(cfg["enabled"]) and any(
            b.get("kind") in ("keyboard", "mouse") for b in cfg["bindings"]
        )
        capturing = cls._input_capture is not None
        if not (wants or capturing):
            if cls._input_watcher is not None:
                cls._input_watcher.close()
                cls._input_watcher = None
            cls._input_active = {}
            return
        try:
            import input_watch
        except Exception as e:
            logger.warning(f"input_watch unavailable: {e!r}")
            return
        if cls._input_watcher is None:
            from asyncio import get_running_loop
            cls._input_watcher = input_watch.Watcher(
                get_running_loop(), cls._on_input_edge, cls._on_input_capture,
                log=logger.info, on_lost=cls._on_input_lost,
            )
        cls._input_watcher.rescan()
        # Résolution des empreintes → nœud COURANT. Le numéro de nœud change au
        # rebranchement (et le Bluetooth se reconnecte souvent), donc on ne se fie
        # jamais au nœud persisté : on remappe à chaque rescan.
        active = {}
        devices = input_watch.list_devices()
        for b in cfg["bindings"]:
            kind = b.get("kind")
            if kind not in ("keyboard", "mouse"):
                continue
            # PAS de `break` : l'empreinte (vendor+product+nom) ne distingue PAS
            # les nœuds d'un même périphérique, et plusieurs peuvent la partager à
            # l'octet près — mesuré sur un récepteur sans fil 2.4G grand public,
            # dont event3 et event7 sont tous deux « keyboard » avec des champs
            # identiques. S'arrêter au premier ancrait la liaison sur le nœud de
            # plus petit numéro, qui est souvent le nœud MUET : la touche liée
            # n'aurait alors jamais déclenché, sans la moindre erreur. On
            # enregistre donc TOUS les nœuds correspondants ; _input_active étant
            # déjà indexé par nœud, plusieurs entrées pour une même liaison sont
            # sans effet de bord, et l'ordre des nœuds cesse de compter.
            for d in devices:
                if d["kind"] == kind and input_watch.match(d, b.get("device")):
                    active[(kind, b["code"], d["node"])] = kind
        cls._input_active = active

    @classmethod
    def _on_input_lost(cls):
        """Un fd est mort (débranchement / réveil) : re-résoudre les nœuds."""
        create_task(cls._input_refresh())

    @classmethod
    async def _input_watchdog(cls):
        """Rescan périodique des périphériques d'entrée.

        Au RÉVEIL de veille et à chaque reconnexion Bluetooth, deux choses
        cassent en même temps : les fd ouverts deviennent morts, et
        /dev/input/eventN est RENUMÉROTÉ (vérifié sur l'appareil : le même
        clavier est passé de event18 à event19 après une mise en veille). Le
        rescan sur erreur de lecture (_on_input_lost) couvre le premier cas,
        mais un périphérique qui revient sur un nouveau nœud n'émet plus rien
        sur l'ancien fd — donc aucune erreur, donc aucun rescan. D'où ce filet
        périodique. Coût : ~20 open/close toutes les 20 s, négligeable, et rien
        du tout quand aucune liaison clavier/souris n'est configurée.
        """
        while True:
            await sleep(20)
            try:
                cfg = cls._voice_cfg()
                wants = bool(cfg["enabled"]) and any(
                    b.get("kind") in ("keyboard", "mouse") for b in cfg["bindings"]
                )
                if not wants and cls._input_watcher is None:
                    continue
                await cls._input_refresh()
            except Exception as e:
                logger.warning(f"input watchdog failed: {e!r}")

    @classmethod
    def _on_input_edge(cls, kind, code, node, down):
        """Appelé SYNCHRONEMENT par le lecteur : aiguillage seulement, pas d'await.

        `code is None` = SYN_DROPPED (le noyau a jeté des événements) : notre état
        « tenu » n'est plus fiable, on relâche pour ne pas laisser le micro ouvert.
        """
        if code is None:
            create_task(cls.set_ptt(False, kind))
            return
        if (kind, code, node) not in cls._input_active:
            return                      # pas notre touche : ignorée, jamais stockée
        cfg = cls._voice_cfg()
        if cfg["mode"] == "ptt":
            create_task(cls.set_ptt(down, kind))
        elif down:
            create_task(cls._toggle_mute_notify())

    @classmethod
    async def _toggle_mute_notify(cls):
        try:
            await cls.toggle_mute()
        except Exception as e:
            logger.warning(f"toggle_mute from input failed: {e!r}")

    @classmethod
    def _on_input_capture(cls, kind, code, node, dev):
        cap = cls._input_capture
        if cap is None:
            return
        import input_watch
        payload = {
            "token": cap["token"],
            "status": "ok",
            "kind": kind,
            "code": code,
            "name": input_watch.code_name(code, kind),
            "label": input_watch.code_label(code, kind),
            "noisy": kind == "mouse" and code in input_watch.NOISY_BUTTONS,
            "device": input_watch.fingerprint(dev),
            "device_name": dev.get("name") or "",
        }
        create_task(cls._finish_capture(payload))

    @classmethod
    async def _finish_capture(cls, payload):
        cap = cls._input_capture
        if cap is None:
            return
        cls._input_capture = None
        task = cap.get("task")
        if task is not None:
            task.cancel()
        if cls._input_watcher is not None:
            cls._input_watcher.set_capturing(False)
        await emit("ptt_capture", payload)
        await cls._input_refresh()

    @classmethod
    async def _capture_timeout(cls, token, timeout_ms):
        try:
            await sleep(timeout_ms / 1000)
        except Exception:
            return
        cap = cls._input_capture
        if cap is None or cap["token"] != token:
            return
        cls._input_capture = None
        if cls._input_watcher is not None:
            cls._input_watcher.set_capturing(False)
        logger.info("input capture timed out")
        await emit("ptt_capture", {"token": token, "status": "timeout"})
        await cls._input_refresh()

    @classmethod
    async def list_input_devices(cls):
        """Périphériques clavier/souris réellement LISIBLES par nous.

        On ne devine pas depuis le bus ou le vendeur : input_watch tente open() sur
        chaque nœud. Un clavier présent mais absent de cette liste n'est pas lisible
        (l'UI le dit à l'utilisateur au lieu d'échouer en silence).
        """
        # Renvoie AUSSI les périphériques présents mais non ouvrables : les taire
        # laissait l'utilisateur appuyer sur un clavier qui ne répondra jamais,
        # sans aucun message. Hors SteamOS c'est le cas courant, pas un cas limite
        # (Bazzite ne pose `uaccess` que sur les joysticks).
        try:
            import input_watch
            return {"devices": input_watch.list_devices(),
                    "unreadable": input_watch.list_unreadable()}
        except Exception as e:
            logger.warning(f"list_input_devices failed: {e!r}")
            return {"devices": [], "unreadable": []}

    @classmethod
    async def start_input_capture(cls, timeout_ms=10000):
        """Ouvre une fenêtre de capture ; le résultat arrive par l'événement
        `ptt_capture` (jeton apparié). Événement plutôt que promesse : l'annulation,
        l'expiration et le démontage du panneau restent explicites."""
        from secrets import token_hex
        await cls.cancel_input_capture()
        token = token_hex(8)
        cls._input_capture = {"token": token}
        await cls._input_refresh()
        if cls._input_watcher is None or cls._input_watcher.device_count == 0:
            cls._input_capture = None
            await cls._input_refresh()
            return {"token": None, "error": "no_devices"}
        cls._input_watcher.set_capturing(True)
        cls._input_capture["task"] = create_task(cls._capture_timeout(token, timeout_ms))
        logger.info("input capture started")     # jamais de code de touche
        return {"token": token, "devices": cls._input_watcher.device_count}

    @classmethod
    async def cancel_input_capture(cls, token=None):
        cap = cls._input_capture
        if cap is None:
            return False
        if token is not None and cap["token"] != token:
            return False
        cls._input_capture = None
        task = cap.get("task")
        if task is not None:
            task.cancel()
        if cls._input_watcher is not None:
            cls._input_watcher.set_capturing(False)
        await cls._input_refresh()
        return True

    @classmethod
    def _gst_env_or_default(cls):
        """Env des enfants GStreamer, même si _main n'a pas encore posé _gst_env.

        #38 : le repli était `dict(os.environ)`, donc l'env PyInstaller de
        plugin_loader (LD_LIBRARY_PATH/LD_PRELOAD vers /tmp/_MEI...) repassait par
        la fenêtre dès que ces lancements précédaient _main. On repart de la même
        base nettoyée que gst_env.
        """
        env = getattr(cls, "_gst_env", None)
        if env:
            return env
        import vesktop as _vesktop
        return _vesktop._user_env()

    @classmethod
    async def _ensure_screenshare_deps(cls):
        # gst_webrtc.py tourne sous le python SYSTÈME (requis pour les bindings
        # GStreamer `gi`, absents du python embarqué du plugin). Sur une machine fraîche
        # cet interpréteur n'a pas aiohttp → partage d'écran muet. On l'installe
        # automatiquement en user-site (sans root) → plugin self-contained sur toute BC-250.
        import vesktop
        env = vesktop._user_env()
        try:
            check = await create_subprocess_exec(
                sys_python(), "-c", "import aiohttp, aiohttp_cors",
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            if (await check.wait()) == 0:
                return
            logger.info("Screen-share deps missing — installing aiohttp (user-site) for system python…")
            proc = await create_subprocess_exec(
                sys_python(), "-m", "pip", "install", "--user", "--quiet",
                "aiohttp", "aiohttp_cors",
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            await proc.wait()
        except Exception as e:
            logger.warning(f"Screen-share deps auto-install failed: {e!r}")

    # ── Micro pendant le Go Live : silence si aucun vrai micro ────────────────
    # Sans micro branché, la source par défaut est le MONITOR de la sortie
    # (BC-250 : hdmi-stereo.monitor) → le canal VOIX diffuse tout le son système
    # (jeu, bips/artefacts HDMI, écho des voix des autres), EN DOUBLE du
    # soundshare venmic du stream, et le volume du live n'y peut rien (constaté
    # 19/07). Pendant un Go Live sans vrai micro : capture voix de Vesktop
    # basculée sur le monitor d'un null-sink muet → seul le stream porte l'audio
    # (contrôlable par son volume). Un vrai micro branché = on ne touche à rien.
    _golive_silence_restore = None   # source à restaurer au stop (None = inactif)

    @classmethod
    async def _golive_mic_silence(cls, enable):
        from json import loads
        try:
            if enable:
                if cls._ga_active or cls._golive_silence_restore is not None:
                    return  # partage "son du jeu" actif (il gère la source) ou déjà posé
                src = (await cls._pactl("get-default-source")).strip()
                if not src.endswith(".monitor") or "steamcord_" in src:
                    return  # vrai micro (ou déjà un de nos montages) → ne rien toucher
                out = (await cls._pactl(
                    "load-module", "module-null-sink", "sink_name=steamcord_silence",
                    "sink_properties=device.description=Steamcord-Silence")).strip()
                if not out.isdigit():
                    raise Exception(f"load-module: {out!r}")
                cls._golive_silence_restore = src
                await cls._pactl("set-default-source", "steamcord_silence.monitor")
                # Basculer aussi les captures voix DÉJÀ ouvertes de Vesktop qui
                # pompent l'ancien monitor (le RecordStream venmic vise
                # vencord-screen-share, pas le monitor → naturellement épargné).
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")),
                                         "steamcord_silence.monitor")
                logger.info(f"[golive] pas de vrai micro ({src}) → capture voix "
                            "silencieuse pendant le stream")
            else:
                if cls._golive_silence_restore is None:
                    return
                src = cls._golive_silence_restore
                cls._golive_silence_restore = None
                await cls._pactl("set-default-source", src)
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), src)
                # unload via la purge par nom (steamcord_silence) — idempotent,
                # couvre aussi le cas restart plugin_loader (module survivant).
                for line in (await cls._pactl("list", "modules", "short")).splitlines():
                    parts = line.split("\t")
                    if len(parts) >= 3 and "steamcord_silence" in parts[2]:
                        await cls._pactl("unload-module", parts[0])
                logger.info("[golive] capture voix restaurée")
        except Exception as e:
            logger.warning(f"[golive] mic-silence({enable}): {e!r}")

    # Sérialise start/stop (issue #12) : un stop→start rapproché faisait courir
    # la restauration pactl de _golive_mic_silence(False) EN MÊME TEMPS que le
    # montage de (True) → la purge par nom déchargeait le null-sink tout neuf et
    # la source par défaut pointait dans le vide (plus de capture voix, et selon
    # l'OS des clients pulse coincés). Un seul verrou = séquences entières,
    # jamais entrelacées.
    _golive_seq_lock = None

    @classmethod
    def _golive_lock(cls):
        if cls._golive_seq_lock is None:
            from asyncio import Lock
            cls._golive_seq_lock = Lock()
        return cls._golive_seq_lock

    @classmethod
    async def go_live(cls):
        async with cls._golive_lock():
            await cls._golive_mic_silence(True)
            await cls.evt_handler.send_client({"type": "$golive", "stop": False})

    @classmethod
    async def stop_go_live(cls):
        async with cls._golive_lock():
            await cls.evt_handler.send_client({"type": "$golive", "stop": True})
            await cls._golive_mic_silence(False)

    # ── Partage d'écran via CAMÉRA virtuelle (contournement gamescope) ──────────
    # gamescope n'a pas de portail → Go Live (getDisplayMedia) = écran noir. À la
    # place : gst_camera.py capture le node PipeWire gamescope → /dev/video42
    # (v4l2loopback), que Discord utilise comme caméra. Voir gst_camera.py + client.
    @classmethod
    async def start_screen_camera(cls):
        import os
        from pathlib import Path as _P
        if not os.path.exists("/dev/video42"):
            info = await cls._v4l2_hint()
            logger.warning(f"[gstcam] /dev/video42 absent — {info['hint']}")
            return {"ok": False, **info}
        info = await cls._gst_python_hint()
        if info:
            logger.warning(f"[gstcam] {info['hint']}")
            return {"ok": False, **info}
        # Tuer un feeder précédent puis (re)lancer.
        try:
            import vesktop
            vesktop.proc_kill("gst_camera.py")
            await sleep(0.5)
        except Exception:
            pass
        script = _P(DECKY_PLUGIN_DIR) / "gst_camera.py"
        if not script.exists():
            script = _P(DECKY_PLUGIN_DIR) / "defaults" / "gst_camera.py"
        cls.camera_feeder = await create_subprocess_exec(
            sys_python(),
            str(script),
            env=cls._gst_env_or_default(),
            stdout=PIPE, stderr=PIPE,
        )
        create_task(stream_watcher(cls.camera_feeder.stdout, prefix="[gstcam]"))
        create_task(stream_watcher(cls.camera_feeder.stderr, True, prefix="[gstcam]"))
        # Laisser le pipeline s'établir avant de sélectionner la caméra côté Discord.
        await sleep(2)
        await cls.evt_handler.send_client({"type": "$screen_camera", "stop": False})
        return {"ok": True}

    # ── stand-alone : une seule version pour tous les OS ────────────────────────
    # Le plugin vérifie ce que la machine a et dit exactement quoi installer.
    # Les hints sont STRUCTURÉS ({code, cmd, hint}) : le front traduit `code` via
    # l'i18n 9 langues et affiche `cmd` verbatim ; `hint` = phrase anglaise pour
    # les logs (issue #2 : le texte français codé en dur arrivait tel quel chez
    # un utilisateur en portugais).
    @staticmethod
    def _pkg_hint(arch, fedora, debian, nix=None, gentoo=None, alpine=None, void=None):
        """Install command for the package manager actually present.

        NixOS/Gentoo/Alpine/Void added for issue #29: those users got the Arch
        fallback (`install: python-gobject …`), a command that means nothing on
        their system. Declarative distros get the *declaration* to add, not an
        imperative command — telling a NixOS user to `nix-env -i` would work
        until the next rebuild wipes it, which is worse than saying nothing."""
        import shutil as _sh
        if _sh.which("pacman"):
            return f"sudo pacman -S {arch}"
        if _sh.which("rpm-ostree"):
            return f"rpm-ostree install {fedora}"
        if _sh.which("dnf"):
            return f"sudo dnf install {fedora}"
        if _sh.which("zypper"):
            return f"sudo zypper install {fedora}"
        if _sh.which("apt"):
            return f"sudo apt install {debian}"
        if _sh.which("nixos-rebuild") or _sh.which("nix"):
            return (f"add to environment.systemPackages: {nix or arch}"
                    " — then: sudo nixos-rebuild switch")
        if _sh.which("emerge"):
            return f"sudo emerge {gentoo or arch}"
        if _sh.which("apk"):
            return f"sudo apk add {alpine or arch}"
        if _sh.which("xbps-install"):
            return f"sudo xbps-install -S {void or arch}"
        return f"install: {arch}"

    @staticmethod
    def _is_steamos():
        # SteamOS stock : rootfs lecture seule, pas de headers noyau, et les MAJ
        # OS effacent les paquets ajoutés → « sudo pacman -S … » y est un faux
        # conseil, on renvoie un code dédié à la place.
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    if line.strip().startswith("ID="):
                        return line.split("=", 1)[1].strip().strip('"') == "steamos"
        except Exception:
            pass
        return False

    _gst_py_ok = False                    # cache : bindings gi/Gst OK (positif seulement)

    @classmethod
    async def _gst_python_hint(cls):
        """None si le python système a gi + Gst + pipewiresrc (requis par
        gst_camera.py), sinon {code, cmd, hint} pour cet OS. Présents sur
        Bazzite/SteamOS, pas sur Arch/Fedora/Debian de base."""
        if cls._gst_py_ok:
            return None
        import vesktop
        try:
            p = await create_subprocess_exec(
                sys_python(), "-c",
                "import gi; gi.require_version('Gst','1.0'); "
                "from gi.repository import Gst; Gst.init(None); "
                "raise SystemExit(0 if Gst.ElementFactory.find('pipewiresrc') else 1)",
                stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            if (await p.wait()) == 0:
                cls._gst_py_ok = True
                return None
        except Exception:
            pass
        cmd = cls._pkg_hint(
            "python-gobject gst-plugin-pipewire",
            "python3-gobject pipewire-gstreamer",
            "python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire",
            # NixOS : pygobject3 seul ne suffit pas — le python doit être un
            # `withPackages` (sinon `import gi` échoue quelle que soit la
            # présence du paquet) et il faut le typelib GStreamer + le plugin
            # PipeWire. Le fallback gamescopectl+ffmpeg (voir preview) évite
            # tout ça et suffit à la plupart des installations.
            nix="(python3.withPackages (ps: [ ps.pygobject3 ])) "
                "gst_all_1.gstreamer gst_all_1.gst-plugins-base "
                "gst_all_1.gst-plugins-good pipewire",
            gentoo="dev-python/pygobject media-plugins/gst-plugins-pipewire",
            alpine="py3-gobject3 gst-plugins-base pipewire",
            void="python3-gobject gst-plugins-base1 pipewire")
        return {"code": "gst_missing", "cmd": cmd,
                "hint": f"GStreamer/PipeWire Python bindings missing for capture: {cmd}"}

    _MODPROBE = ("sudo modprobe v4l2loopback video_nr=42 "
                 "card_label=Steamcord exclusive_caps=1")

    # Un simple modprobe NE SUFFIT PAS quand le module est déjà chargé sans
    # video_nr=42 (issue #9 : Bazzite charge v4l2loopback en « OBS Virtual
    # Camera » via /usr/lib/modprobe.d/20-akmods.conf) : modprobe sort alors 0
    # EN SILENCE sans rien changer et /dev/video42 n'apparaît jamais — le user
    # relance la commande en boucle sans comprendre. Il faut décharger d'abord.
    # On donne donc un bloc unique qui vaut pour les deux cas (pas chargé /
    # mal chargé) ET qui persiste au reboot : sans les fichiers de conf le
    # module ne revient pas au boot suivant et le problème recommence.
    # « || true » sur le déchargement : il ÉCHOUE quand le module n'est pas
    # chargé (cas le plus fréquent) et, sous set -e, ferait quitter le script
    # avant même d'avoir rien fait.
    _MODPROBE_FIX = (
        "sudo modprobe -r v4l2loopback 2>/dev/null || true\n"
        "echo 'options v4l2loopback exclusive_caps=1 card_label=\"Steamcord Screen\" "
        "video_nr=42' | sudo tee /etc/modprobe.d/99-steamcord-v4l2loopback.conf\n"
        "echo v4l2loopback | sudo tee /etc/modules-load.d/steamcord-v4l2loopback.conf\n"
        "sudo modprobe v4l2loopback")

    _FIX_SCRIPT = "steamcord-fix-v4l2.sh"

    @classmethod
    def _write_v4l2_fix_script(cls, extra=""):
        """Écrit un script prêt à lancer dans le home et renvoie la commande à
        afficher. Le hint part dans un TOAST de chat Steam : un bloc de 4 lignes
        y serait tronqué et n'est de toute façon pas copiable en mode jeu → on
        n'affiche qu'un « bash ~/steamcord-fix-v4l2.sh ». Le plugin tourne en
        user (pas root) : il ne peut pas charger le module lui-même, mais il
        peut parfaitement déposer le script, qui demandera sudo au lancement.
        Renvoie None si l'écriture échoue (home en lecture seule) → l'appelant
        retombe sur les commandes en clair."""
        from pathlib import Path
        body = "\n".join(l for l in (extra, cls._MODPROBE_FIX) if l)
        # Script en ANGLAIS : il part chez tous les users, quelle que soit la
        # langue du QAM. Pas d'apostrophe dans les chaînes quotées en simple.
        script = (
            "#!/usr/bin/env bash\n"
            "# Generated by Steamcord.\n"
            "# Enables the /dev/video42 virtual webcam used for game-mode screen\n"
            "# share, and makes it survive reboots. Safe to re-run.\n"
            "set -e\n"
            + body + "\n"
            # Sans attendre udev, le ls affiche « crw------- root root » (règles
            # pas encore appliquées) : ça a l'air cassé alors que le device est
            # bon une seconde plus tard (crw-rw---- root video + ACL du user).
            "sudo udevadm settle 2>/dev/null || sleep 1\n"
            "echo\n"
            # Le déchargement peut avoir échoué silencieusement si une autre app
            # tient le module (OBS, Sunshine) : on le dit au lieu de laisser un
            # « ls: no such file » sec.
            "ls -l /dev/video42 || { echo \"Still no /dev/video42: something is "
            "still using v4l2loopback (OBS, Sunshine, a browser tab with the "
            "virtual camera). Close it and re-run this script, or reboot.\"; "
            "exit 1; }\n"
            'echo "Done - screen share is ready."\n')
        try:
            p = Path.home() / cls._FIX_SCRIPT
            p.write_text(script)
            p.chmod(0o755)
            return f"bash ~/{cls._FIX_SCRIPT}"
        except Exception as e:
            logger.warning(f"[v4l2] script de correction non écrit: {e}")
            return None

    @staticmethod
    def _v4l2_loaded():
        """(chargé?, expose /dev/video42?) d'après sysfs — pas de lsmod à parser."""
        import os
        if not os.path.exists("/sys/module/v4l2loopback"):
            return False, False
        try:
            with open("/sys/module/v4l2loopback/parameters/video_nr") as f:
                nrs = [n.strip() for n in f.read().split(",")]
            return True, "42" in nrs
        except Exception:
            return True, False

    @classmethod
    async def _v4l2_hint(cls):
        """Distingue « module pas installé » (installer le paquet — ou SteamOS,
        où c'est impossible proprement), « installé mais pas chargé » et
        « chargé mais sans /dev/video42 » (une autre app l'a chargé en premier)
        pour donner LA bonne commande. Appelé quand /dev/video42 est absent."""
        loaded, has42 = cls._v4l2_loaded()
        if loaded:
            # has42 vrai ici = module configuré pour 42 mais device absent quand
            # même (cas tordu) : la même séquence de rechargement le répare.
            return {"code": "v4l2_wrong_device",
                    "cmd": cls._write_v4l2_fix_script() or cls._MODPROBE_FIX,
                    "hint": "v4l2loopback is loaded without the /dev/video42 device "
                            "Steamcord needs (another app loaded it first); a plain "
                            "modprobe is a silent no-op — unload it first: "
                            + cls._MODPROBE_FIX.replace("\n", " ; ")}
        try:
            p = await create_subprocess_exec("modinfo", "v4l2loopback",
                                             stdout=DEVNULL, stderr=DEVNULL)
            installed = (await p.wait()) == 0
        except Exception:
            installed = False
        if installed:
            return {"code": "v4l2_not_loaded",
                    "cmd": cls._write_v4l2_fix_script() or cls._MODPROBE_FIX,
                    "hint": f"v4l2loopback installed but not loaded: {cls._MODPROBE_FIX}"}
        if cls._is_steamos():
            return {"code": "v4l2_steamos", "cmd": "",
                    "hint": "v4l2loopback missing and stock SteamOS cannot keep it "
                            "across OS updates — screen share (game mode) unavailable"}
        pkg = cls._pkg_hint("v4l2loopback-dkms", "v4l2loopback", "v4l2loopback-dkms",
                            # NixOS charge les modules par boot.extraModulePackages
                            # + boot.kernelModules, pas par un paquet utilisateur.
                            nix="boot.extraModulePackages = [ config.boot.kernelPackages"
                                ".v4l2loopback ]; boot.kernelModules = [ \"v4l2loopback\" ];",
                            gentoo="media-video/v4l2loopback",
                            alpine="v4l2loopback-dkms",
                            void="v4l2loopback")
        # même bloc persistant après l'installation du paquet : un modprobe seul
        # ne survivrait pas au reboot (cf _MODPROBE_FIX).
        cmd = f"{pkg}\n{cls._MODPROBE_FIX}"
        return {"code": "v4l2_missing",
                "cmd": cls._write_v4l2_fix_script(extra=pkg) or cmd,
                "hint": f"v4l2loopback kernel module missing: {cmd}"}

    @classmethod
    async def stop_screen_camera(cls):
        import os
        try:
            await cls.evt_handler.send_client({"type": "$screen_camera", "stop": True})
        except Exception:
            pass
        try:
            import vesktop
            vesktop.proc_kill("gst_camera.py")
        except Exception:
            pass
        if hasattr(cls, "camera_feeder") and cls.camera_feeder:
            try:
                cls.camera_feeder.kill()
                await cls.camera_feeder.wait()
            except Exception:
                pass
            cls.camera_feeder = None
        return True

    @classmethod
    async def get_camera_preview(cls):
        """Aperçu du partage écran pour le QAM : état du feeder + dernier JPEG.

        Le CEF de Steam n'a pas accès caméra en gamescope (getUserMedia échoue
        sur /dev/video42) → l'aperçu passe par les instantanés que gst_camera.py
        écrit toutes les 2s dans /tmp/steamcord-preview.jpg."""
        import base64
        import os
        import time as _t
        feeder = getattr(cls, "camera_feeder", None)
        running = feeder is not None and feeder.returncode is None
        jpg = ""
        path = "/tmp/steamcord-preview.jpg"
        try:
            if running and os.path.exists(path) and _t.time() - os.path.getmtime(path) < 6:
                with open(path, "rb") as f:
                    jpg = base64.b64encode(f.read()).decode()
        except Exception:
            jpg = ""
        return {"running": running, "jpg": jpg}

    # ── Aperçu du Go Live NATIF ──────────────────────────────────────────────
    # Quand le partage passe par le portail (portal_shim), la capture vit DANS
    # le Chromium de Vesktop → le QAM n'a aucune poignée sur le flux. Ce feeder
    # léger (gst_preview.py) capture le node gamescope → JPEG/2s, uniquement
    # tant que la tuile d'aperçu est montée (start au montage, stop au démontage).
    # Refcount + verrou (issue #12) : au flicker LIVE→pas LIVE→LIVE la tuile se
    # démonte/remonte en <1s, et le stop du 1er montage pouvait être traité APRÈS
    # le start du 2e → il tuait le feeder tout neuf et l'aperçu restait mort
    # (« Starting preview… » éternel). start/stop s'équilibrent ; on ne tue le
    # feeder que quand plus AUCUNE tuile n'est montée.
    _preview_seq_lock = None
    _preview_refs = 0
    _preview_fallback_task = None

    @classmethod
    def _preview_lock(cls):
        if cls._preview_seq_lock is None:
            from asyncio import Lock
            cls._preview_seq_lock = Lock()
        return cls._preview_seq_lock

    @classmethod
    def _preview_running(cls):
        proc = getattr(cls, "golive_preview", None)
        if proc is not None and proc.returncode is None:
            return True
        task = cls._preview_fallback_task
        return task is not None and not task.done()

    @classmethod
    async def _golive_preview_fallback(cls):
        """Aperçu SANS GStreamer (SteamOS stock, issue #12 : pas de
        gst-plugin-pipewire) : gamescopectl screenshot (instantané, natif
        gamescope) + ffmpeg pour la vignette JPEG. Les deux binaires sont dans
        l'image SteamOS de base — l'aperçu marche donc sur Deck stock."""
        import os
        import vesktop
        env = vesktop._user_env()
        raw = "/tmp/steamcord-golive-preview-raw.png"
        path = "/tmp/steamcord-golive-preview.jpg"
        try:
            while True:
                try:
                    try:
                        os.remove(raw)
                    except OSError:
                        pass
                    p = await create_subprocess_exec(
                        "gamescopectl", "screenshot", raw,
                        stdout=DEVNULL, stderr=DEVNULL, env=env)
                    await p.wait()
                    # gamescopectl rend la main tout de suite ; gamescope écrit
                    # le fichier juste après → on attend qu'il apparaisse et
                    # que sa taille se stabilise (PNG non atomique) plutôt
                    # qu'une grosse marge fixe (issue #12 : aperçu ~1 fps).
                    last = -1
                    for _ in range(12):
                        await sleep(0.1)
                        try:
                            size = os.path.getsize(raw)
                        except OSError:
                            continue
                        if size > 0 and size == last:
                            break
                        last = size
                    p = await create_subprocess_exec(
                        "ffmpeg", "-y", "-loglevel", "error", "-i", raw,
                        "-vf", "scale=640:-2", "-q:v", "7", path + ".tmp",
                        stdout=DEVNULL, stderr=DEVNULL, env=env)
                    await p.wait()
                    if os.path.exists(path + ".tmp"):
                        os.replace(path + ".tmp", path)
                except Exception as e:
                    logger.warning(f"[gstprev] fallback screenshot: {e!r}")
                await sleep(0.5)
        finally:
            for f in (raw, path, path + ".tmp"):
                try:
                    os.remove(f)
                except OSError:
                    pass

    @classmethod
    async def start_golive_preview(cls):
        import os
        import shutil as _sh
        from pathlib import Path as _P
        async with cls._preview_lock():
            cls._preview_refs += 1
            if cls._preview_running():
                return {"ok": True}
            hint = await cls._gst_python_hint()
            if hint is None:
                try:
                    import vesktop
                    vesktop.proc_kill("gst_preview.py")
                except Exception:
                    pass
                script = _P(DECKY_PLUGIN_DIR) / "gst_preview.py"
                if not script.exists():
                    script = _P(DECKY_PLUGIN_DIR) / "defaults" / "gst_preview.py"
                cls.golive_preview = await create_subprocess_exec(
                    sys_python(), str(script),
                    env=cls._gst_env_or_default(),
                    stdout=PIPE, stderr=PIPE,
                )
                create_task(stream_watcher(cls.golive_preview.stdout, prefix="[gstprev]"))
                create_task(stream_watcher(cls.golive_preview.stderr, True, prefix="[gstprev]"))
                return {"ok": True}
            if _sh.which("gamescopectl") and _sh.which("ffmpeg"):
                logger.info("[gstprev] bindings GStreamer absents → fallback "
                            "gamescopectl+ffmpeg")
                cls._preview_fallback_task = create_task(cls._golive_preview_fallback())
                return {"ok": True}
            # Rien pour capturer : le front affiche le hint structuré (i18n).
            logger.warning(f"[gstprev] {hint['hint']}")
            return {"ok": False, **hint}

    @classmethod
    async def stop_golive_preview(cls):
        async with cls._preview_lock():
            cls._preview_refs = max(0, cls._preview_refs - 1)
            if cls._preview_refs:
                return True
            proc = getattr(cls, "golive_preview", None)
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            cls.golive_preview = None
            task = cls._preview_fallback_task
            if task is not None and not task.done():
                task.cancel()
            cls._preview_fallback_task = None
            return True

    @classmethod
    async def get_golive_preview(cls):
        """Aperçu Go Live natif : état du feeder + dernier JPEG (gst_preview.py
        ou fallback gamescopectl)."""
        import base64
        import os
        import time as _t
        running = cls._preview_running()
        jpg = ""
        path = "/tmp/steamcord-golive-preview.jpg"
        try:
            if running and os.path.exists(path) and _t.time() - os.path.getmtime(path) < 8:
                with open(path, "rb") as f:
                    jpg = base64.b64encode(f.read()).decode()
        except Exception:
            jpg = ""
        return {"running": running, "jpg": jpg}

    @classmethod
    async def get_vesktop_backend(cls):
        # stand-alone : dit au QAM si un moyen de faire tourner Vesktop existe
        # (flatpak ou binaire natif). backend=None → l'écran d'initialisation
        # affiche la marche à suivre au lieu d'un spinner infini (cas CachyOS
        # sans flatpak). Se ré-évalue à chaque appel → self-heal dès que le
        # user installe flatpak/vesktop.
        import vesktop
        try:
            b = vesktop.backend()
            if (b == "flatpak" and vesktop.install_failures >= 3
                    and not await vesktop.installed()):
                # flatpak est là mais l'install Vesktop échoue en boucle (hors-
                # ligne, flathub bloqué, disque plein) → montrer l'écran d'aide
                # plutôt qu'un « Initializing » éternel. Se ré-évalue à chaque
                # appel : dès qu'une install passe, le compteur retombe à 0.
                return {"backend": None}
            return {"backend": b}
        except Exception as e:
            logger.warning(f"[standalone] get_vesktop_backend: {e!r}")
            return {"backend": "unknown"}

    @classmethod
    async def get_share_env(cls):
        # Bureau/Big Picture (KWin) vs console gamescope : décide quel bouton de
        # partage afficher (Go Live = portail, marche seulement sous KWin ; « mode
        # jeu » = node gamescope, marche seulement en console). KWin testé en
        # PREMIER : c'est le signal fiable — les sockets gamescope-* persistent
        # dans XDG_RUNTIME_DIR après une session gamemode, et un gamescope
        # imbriqué par-jeu peut tourner sous KWin (= Bureau quand même).
        # /proc plutôt que pgrep : procps n'est ni installé ni dans le PATH du
        # service sur NixOS/Alpine → FileNotFoundError à chaque ouverture du
        # panneau, et le partage d'écran disparaissait (issue #29).
        try:
            import vesktop
            if vesktop.proc_running(comm="kwin_wayland|kwin_x11"):
                return {"env": "desktop"}
            if vesktop.proc_running(comm="gamescope|gamescope-wl"):
                return {"env": "gamescope"}
        except Exception as e:
            logger.warning(f"[shareenv] {e!r}")
        return {"env": "unknown"}

    # ── Partage AUDIO du jeu (son du jeu → micro Discord, jauges voix/jeu) ───────
    # Deux sinks virtuels : `steamcord_game` devient la sortie PAR DÉFAUT (les jeux
    # y jouent) et reboucle vers la vraie sortie (le user continue d'entendre) ;
    # `steamcord_mix` reçoit micro + jeu via deux loopbacks dont le volume = les
    # jauges du QAM ; un micro virtuel `steamcord_mic` (remap-source du monitor du
    # mix) devient la SOURCE PAR DÉFAUT — indispensable : Discord (entrée «Default»)
    # ne liste pas les monitors, donc sans micro réel il n'ouvrirait AUCUNE capture.
    # Vesktop reste routé sur la vraie sortie → la voix des participants n'entre
    # pas dans le mix (pas d'écho chez eux).
    @classmethod
    async def _pactl_load(cls, *args):
        out = (await cls._pactl("load-module", *args)).strip()
        if not out.isdigit():
            raise Exception(f"load-module {args[0]} a échoué ({out!r})")
        cls._ga_modules.append(out)
        return out

    @classmethod
    async def _ga_boot_cleanup(cls):
        # Après un restart de plugin_loader, d'éventuels modules steamcord_* survivent
        # dans pipewire-pulse alors que notre état est perdu → on repart propre (et on
        # restaure la sortie par défaut si elle pointait encore sur le sink jeu).
        try:
            cur = ((await cls._pactl("get-default-sink")).strip() + " "
                   + (await cls._pactl("get-default-source")).strip())
            if "steamcord_" in cur:
                await cls.stop_game_audio()
            else:
                await cls._ga_cleanup_modules()
        except Exception as e:
            logger.warning(f"[gameaudio] boot cleanup: {e!r}")

    @classmethod
    async def _ga_cleanup_modules(cls):
        # Purge idempotente des modules steamcord_* résiduels (crash / restart
        # plugin_loader : pipewire-pulse, lui, garde les modules chargés).
        # ⚠ le JSON de `pactl list modules` n'a PAS de champ index → format short
        # (index\tnom\targument ; les arguments multi-lignes n'ont pas de tab).
        try:
            for line in (await cls._pactl("list", "modules", "short")).splitlines():
                parts = line.split("\t")
                if len(parts) >= 3 and "steamcord_" in parts[2]:
                    await cls._pactl("unload-module", parts[0])
        except Exception as e:
            logger.warning(f"[gameaudio] purge modules: {e!r}")

    @classmethod
    async def start_game_audio(cls):
        from json import loads
        if cls._ga_active:
            return True
        try:
            await cls._ga_cleanup_modules()
            cls._ga_modules = []
            cls._ga_loop_mod = {}
            real = cls._audio_out or (await cls._pactl("get-default-sink")).strip()
            if not real or "steamcord_" in real:
                raise Exception(f"sortie réelle introuvable ({real!r})")
            cls._ga_real_sink = real
            await cls._pactl_load("module-null-sink", "sink_name=steamcord_game",
                                  "sink_properties=device.description=SteamcordGame")
            await cls._pactl_load("module-null-sink", "sink_name=steamcord_mix",
                                  "sink_properties=device.description=SteamcordMix")
            # Le user continue d'entendre le jeu sur la vraie sortie.
            await cls._pactl_load("module-loopback", "source=steamcord_game.monitor",
                                  f"sink={real}", "latency_msec=30")
            # Branche JEU du mix (jauge 🎮).
            cls._ga_loop_mod["game"] = await cls._pactl_load(
                "module-loopback", "source=steamcord_game.monitor",
                "sink=steamcord_mix", "latency_msec=30")
            # Branche VOIX du mix (jauge 🎙️) — seulement si un vrai micro existe
            # (sur cette machine la source par défaut peut être un monitor HDMI).
            mic = cls._audio_in or (await cls._pactl("get-default-source")).strip()
            if mic and not mic.endswith(".monitor") and "steamcord_" not in mic:
                cls._ga_loop_mod["voice"] = await cls._pactl_load(
                    "module-loopback", f"source={mic}",
                    "sink=steamcord_mix", "latency_msec=30")
            else:
                logger.warning(f"[gameaudio] aucun micro réel ({mic!r}) — branche voix absente")
            # Micro virtuel branché sur le mix, promu source PAR DÉFAUT : sans lui,
            # Discord (entrée « Default ») n'a rien à ouvrir quand aucun micro réel
            # n'existe (WebRTC filtre les monitors) → aucune capture, mix jamais
            # transmis. « Micro-Steamcord » apparaît comme un vrai périphérique.
            await cls._pactl_load("module-remap-source", "master=steamcord_mix.monitor",
                                  "source_name=steamcord_mic",
                                  "source_properties=device.description=Micro-Steamcord")
            cur_src = (await cls._pactl("get-default-source")).strip()
            cls._ga_real_source = cur_src if cur_src and "steamcord_" not in cur_src else None
            await cls._pactl("set-default-source", "steamcord_mic")
            await cls._pactl("set-default-sink", "steamcord_game")
            cls._ga_active = True
            await cls._apply_audio_routing()  # déplace jeu→steamcord_game, Vesktop→réel/mix
            await cls._ga_apply_volumes()
            logger.info(f"[gameaudio] ACTIF (sortie réelle={real}, micro={mic!r}, "
                        f"branches={list(cls._ga_loop_mod)})")
            return True
        except Exception as e:
            logger.warning(f"[gameaudio] démarrage KO: {e!r}")
            await cls.stop_game_audio()
            return False

    @classmethod
    async def stop_game_audio(cls):
        from json import loads
        cls._ga_active = False
        try:
            real = cls._ga_real_sink or (await cls._pactl("get-default-sink")).strip()
            if not real or "steamcord_" in real:
                # État perdu (restart) et défaut encore sur le sink virtuel → premier
                # sink matériel disponible.
                for line in (await cls._pactl("list", "sinks", "short")).splitlines():
                    name = (line.split("\t") + [""])[1]
                    if name and "steamcord_" not in name:
                        real = name
                        break
            if real and "steamcord_" not in real:
                await cls._pactl("set-default-sink", real)
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if str(si.get("owner_module", "")) not in cls._ga_modules:
                        await cls._pactl("move-sink-input", str(si.get("index")), real)
            # Restaurer la source par défaut (le micro virtuel va être déchargé).
            src = cls._ga_real_source
            if not src or "steamcord_" in src:
                cand = [(line.split("\t") + [""])[1]
                        for line in (await cls._pactl("list", "sources", "short")).splitlines()]
                cand = [n for n in cand if n and "steamcord_" not in n]
                src = next((n for n in cand if not n.endswith(".monitor")),
                           cand[0] if cand else None)
            if src and "steamcord_" not in src:
                await cls._pactl("set-default-source", src)
            # Rendre à Vesktop son entrée d'origine (choix user ou défaut système).
            mic = cls._audio_in or (await cls._pactl("get-default-source")).strip()
            if mic and "steamcord_" not in mic:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), mic)
        except Exception as e:
            logger.warning(f"[gameaudio] restauration: {e!r}")
        for mid in reversed(cls._ga_modules):
            try:
                await cls._pactl("unload-module", mid)
            except Exception:
                pass
        cls._ga_modules = []
        cls._ga_loop_mod = {}
        cls._ga_real_sink = None
        cls._ga_real_source = None
        await cls._ga_cleanup_modules()
        logger.info("[gameaudio] arrêté, routage restauré")
        return True

    @classmethod
    async def _ga_apply_volumes(cls):
        # Les jauges = volume du sink-input que chaque loopback pousse dans le mix
        # (retrouvé par owner_module, seul lien stable module→flux).
        from json import loads
        try:
            sis = loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]")
            for kind, mid in cls._ga_loop_mod.items():
                pct = max(0, min(150, int(cls._ga_vol.get(kind, 100))))
                for si in sis:
                    if str(si.get("owner_module")) == str(mid):
                        await cls._pactl("set-sink-input-volume", str(si.get("index")), f"{pct}%")
        except Exception as e:
            logger.warning(f"[gameaudio] volumes: {e!r}")

    @classmethod
    async def set_game_audio_volume(cls, kind, pct):
        if kind in cls._ga_vol:
            cls._ga_vol[kind] = int(pct)
            cls._save_audio_cfg()
        if cls._ga_active:
            await cls._ga_apply_volumes()
        return True

    @classmethod
    async def get_game_audio(cls):
        return {"active": cls._ga_active,
                "has_mic": ("voice" in cls._ga_loop_mod) if cls._ga_active else True,
                "voice": cls._ga_vol["voice"], "game": cls._ga_vol["game"]}

    @classmethod
    async def mic_webrtc_answer(cls, answer):
        await cls.evt_handler.send_client({"type": "$webrtc", "payload": answer})

    # ── Relais vidéo inverse (voir le Go Live/cam des autres dans le QAM) ──
    @classmethod
    async def watch_video(cls, user_id):
        # Ask the Discord tab to watch this user's stream, capture its video track
        # and offer it back to us. Correlated by user_id.
        await cls.evt_handler.send_client({"type": "$WATCH_VIDEO", "userId": user_id})

    @classmethod
    async def unwatch_video(cls, user_id):
        await cls.evt_handler.send_client({"type": "$UNWATCH_VIDEO", "userId": user_id})

    @classmethod
    async def video_webrtc_answer(cls, user_id, answer):
        await cls.evt_handler.send_client({"type": "$VIDEO_ANSWER", "userId": user_id, "payload": answer})

    # ── Overlays in-game (vocal + POV vidéo) ──────────────────────────────────
    # UNE seule fenêtre WebKitGTK transparente (gamescope n'a qu'UN plan
    # external-overlay — la recette mangoapp, éprouvée par le chat BoneCast)
    # qui héberge les deux widgets ; chacun s'active indépendamment via le
    # menu QAM. La page poll voice_state.json (roster + réglages, réécrit par
    # la boucle de state) et consomme /pov_feed (WS binaire, chunks WebM du
    # client MediaRecorder → lecture MSE : WebKit n'a PAS de WebRTC, sondé).
    _OVERLAY_CFG = os.path.expanduser("~/.config/steamcord-overlay.json")
    _overlay_proc = None
    _overlay_settings = None
    _overlay_caps_cache = None
    _voice_ov_on = False
    _pov_ov_on = False
    _pov_users = set()          # users actuellement relayés (client MediaRecorder)
    _pov_clients = {}           # ws overlay -> asyncio.Queue de fragments binaires
    _pov_init = {}              # uid -> fragment d'init fMP4 (ftyp+moov) en cache

    POV_MAX = 4
    POV_FEED_URL = "ws://127.0.0.1:65123/pov_feed"

    @classmethod
    def _overlay_dir(cls):
        return os.path.expanduser("~/.local/share/steamcord/game_overlay")

    @classmethod
    def _overlay_script(cls):
        script = Path(DECKY_PLUGIN_DIR) / "game_overlay" / "overlay.py"
        if not script.exists():
            script = Path(DECKY_PLUGIN_DIR) / "defaults" / "game_overlay" / "overlay.py"
        return script

    @classmethod
    async def _overlay_caps(cls):
        """Ce que le helper sait rendre ICI. SteamOS n'a AUCUN binding GIR
        WebKit2 → le helper y peint le roster vocal en GTK/Cairo, mais le POV
        (décodage fMP4 en MediaSource) reste hors de portée sans moteur web
        (#22). Sondé une fois, puis mémorisé."""
        if cls._overlay_caps_cache is not None:
            return cls._overlay_caps_cache
        import json as _json
        caps = {"backend": "unknown", "voice": True, "pov": True}
        try:
            proc = await create_subprocess_exec(
                sys_python(), str(cls._overlay_script()), "--probe",
                stdout=PIPE, stderr=PIPE)
            out, _err = await wait_for(proc.communicate(), timeout=15)
            caps = _json.loads(out.decode().strip().splitlines()[-1])
        except Exception as e:
            logger.warning(f"[overlay] probe failed: {e!r}")
        cls._overlay_caps_cache = caps
        logger.info(f"[overlay] capabilities: {caps}")
        return caps

    @classmethod
    def _overlay_running(cls):
        return cls._overlay_proc is not None and cls._overlay_proc.returncode is None

    @classmethod
    def _load_overlay_settings(cls):
        import json as _json
        if cls._overlay_settings is None:
            try:
                with open(cls._OVERLAY_CFG) as f:
                    cls._overlay_settings = _json.load(f)
            except Exception:
                cls._overlay_settings = {}
        cls._overlay_settings.setdefault(
            "voice", {"pos": "bottom-left", "opacity": 85, "scale": 100})
        cls._overlay_settings.setdefault(
            "pov", {"layout": "right", "opacity": 90, "scale": 100})
        return cls._overlay_settings

    @classmethod
    def _save_overlay_settings(cls):
        import json as _json
        try:
            with open(cls._OVERLAY_CFG, "w") as f:
                _json.dump(cls._load_overlay_settings(), f)
        except Exception as e:
            logger.warning(f"[overlay] save settings failed: {e!r}")

    @classmethod
    def _write_overlay_state(cls, state=None):
        import json as _json
        try:
            st = state or cls.evt_handler.build_state_dict()
            vc = st.get("vc") or {}
            users = []
            for u in vc.get("users") or []:
                av = u.get("avatar")
                users.append({
                    "id": u.get("id"),
                    "username": u.get("username"),
                    "avatar_url": (
                        f"https://cdn.discordapp.com/avatars/{u.get('id')}/{av}.webp?size=64"
                        if av else "https://cdn.discordapp.com/embed/avatars/0.png"),
                    "is_speaking": bool(u.get("is_speaking")),
                    "is_muted": bool(u.get("is_muted")),
                    "is_deafened": bool(u.get("is_deafened")),
                })
            s = cls._load_overlay_settings()
            payload = {
                "voice": {"enabled": cls._voice_ov_on, "settings": s.get("voice"), "users": users},
                "pov": {"enabled": cls._pov_ov_on, "settings": s.get("pov"), "feed": cls.POV_FEED_URL},
            }
            d = cls._overlay_dir()
            os.makedirs(d, exist_ok=True)
            tmp = os.path.join(d, ".voice_state.tmp")
            with open(tmp, "w") as f:
                _json.dump(payload, f)
            os.replace(tmp, os.path.join(d, "voice_state.json"))
        except Exception as e:
            logger.debug(f"[overlay] write state failed: {e!r}")

    @classmethod
    async def _ensure_overlay_window(cls):
        if cls._overlay_running():
            return True
        script = cls._overlay_script()
        cls._write_overlay_state()
        try:
            import vesktop
            # Env graphique de la vraie session (l'env plugin_loader n'a pas de
            # cookie X → GTK meurt sur « Authorization required ») ; on repart
            # de _user_env, JAMAIS d'os.environ : le LD_LIBRARY_PATH PyInstaller
            # (/tmp/_MEI*) casse libcurl/gio dans WebKit (leçon BoneCast).
            env = dict(vesktop._user_env())
            try:
                env.update(await vesktop._show_env())
            except Exception:
                pass
            env.setdefault("DISPLAY", ":0")
            if "/tmp/_MEI" in env.get("LD_LIBRARY_PATH", ""):
                env.pop("LD_LIBRARY_PATH", None)
            cls._overlay_proc = await create_subprocess_exec(
                sys_python(), str(script), "--state-dir", cls._overlay_dir(),
                env=env, stdout=PIPE, stderr=PIPE)
            create_task(stream_watcher(cls._overlay_proc.stdout, prefix="[overlay]"))
            create_task(stream_watcher(cls._overlay_proc.stderr, True, prefix="[overlay]"))
            # Le spawn réussit TOUJOURS ; ce qui compte c'est la survie du
            # helper. Sur certains OS (SteamOS n'a pas forcément WebKit2 4.1 /
            # python-xlib) il meurt dans la seconde. On attend un court instant
            # et on renvoie False s'il a déjà rendu la main, pour que le toggle
            # repasse OFF tout de suite au lieu de « mentir » puis se corriger
            # au ré-affichage du panel (#22). Le motif exact du crash est déjà
            # loggé par stream_watcher, préfixe [overlay].
            await sleep(0.7)
            if cls._overlay_proc is not None and cls._overlay_proc.returncode is not None:
                rc = cls._overlay_proc.returncode
                cls._overlay_proc = None
                logger.warning(
                    f"[overlay] helper exited immediately (rc={rc}) — see [overlay] stderr above")
                return False
            logger.info("[overlay] overlay window started")
            return True
        except Exception as e:
            logger.warning(f"[overlay] start failed: {e!r}")
            return False

    @classmethod
    async def _maybe_stop_overlay_window(cls):
        if cls._voice_ov_on or cls._pov_ov_on:
            return
        proc = cls._overlay_proc
        cls._overlay_proc = None
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
                try:
                    await wait_for(proc.wait(), timeout=2)
                except Exception:
                    proc.kill()
            except Exception:
                pass

    # ── Overlay vocal ─────────────────────────────────────────────────────────
    @classmethod
    async def start_voice_overlay(cls):
        cls._voice_ov_on = True
        ok = await cls._ensure_overlay_window()
        if not ok:
            cls._voice_ov_on = False
        cls._write_overlay_state()
        return {"ok": ok}

    @classmethod
    async def stop_voice_overlay(cls):
        cls._voice_ov_on = False
        cls._write_overlay_state()
        await cls._maybe_stop_overlay_window()
        return {"ok": True}

    @classmethod
    async def set_voice_overlay_settings(cls, settings):
        cur = cls._load_overlay_settings()
        cur["voice"] = {**cur.get("voice", {}), **(settings or {})}
        cls._save_overlay_settings()
        if cls._overlay_running():
            cls._write_overlay_state()
        return {"ok": True, "settings": cur["voice"]}

    # ── Overlay POV ───────────────────────────────────────────────────────────
    @classmethod
    async def start_pov_overlay(cls):
        # Échec HONNÊTE plutôt qu'un toggle qui ment : sans moteur web, le POV
        # ne peut pas être décodé (le roster vocal, lui, marche — backend cairo).
        caps = await cls._overlay_caps()
        if not caps.get("pov", True):
            logger.info("[overlay] POV refused: backend %s has no MediaSource"
                        % caps.get("backend"))
            return {"ok": False, "reason": "pov_unsupported"}
        cls._pov_ov_on = True
        ok = await cls._ensure_overlay_window()
        if not ok:
            cls._pov_ov_on = False
            cls._write_overlay_state()
            return {"ok": ok}
        cls._write_overlay_state()
        # Lance tout de suite le relais des POV déjà actives (sans attendre le
        # prochain event de state).
        await cls._sync_pov_users()
        return {"ok": ok}

    @classmethod
    async def stop_pov_overlay(cls):
        cls._pov_ov_on = False
        for uid in list(cls._pov_users):
            try:
                await cls.evt_handler.send_client({"type": "$POV_STOP", "userId": uid})
            except Exception:
                pass
        cls._pov_users.clear()
        cls._pov_init.clear()
        cls._write_overlay_state()
        await cls._maybe_stop_overlay_window()
        return {"ok": True}

    @classmethod
    async def set_pov_overlay_settings(cls, settings):
        cur = cls._load_overlay_settings()
        cur["pov"] = {**cur.get("pov", {}), **(settings or {})}
        cls._save_overlay_settings()
        if cls._overlay_running():
            cls._write_overlay_state()
        return {"ok": True, "settings": cur["pov"]}

    @classmethod
    async def get_overlay_status(cls):
        s = cls._load_overlay_settings()
        caps = await cls._overlay_caps()
        return {
            "voice_on": cls._voice_ov_on and cls._overlay_running(),
            "pov_on": cls._pov_ov_on and cls._overlay_running(),
            "voice": s.get("voice"),
            "pov": s.get("pov"),
            # Le menu masque le POV là où il ne peut pas fonctionner (SteamOS).
            "pov_supported": bool(caps.get("pov", True)),
            "voice_supported": bool(caps.get("voice", True)),
            "backend": caps.get("backend"),
        }

    @classmethod
    async def _sync_pov_users(cls, state=None):
        """Aligne les enregistreurs client sur les participants vidéo-actifs
        (max POV_MAX, hors soi) — appelé à chaque changement de state tant que
        l'overlay POV est actif."""
        if not cls._pov_ov_on:
            return
        try:
            st = state or cls.evt_handler.build_state_dict()
            me = (st.get("me") or {}).get("id")
            vc = st.get("vc") or {}
            want = []
            for u in vc.get("users") or []:
                if u.get("id") != me and (u.get("is_live") or u.get("is_video")):
                    want.append(u["id"])
                if len(want) >= cls.POV_MAX:
                    break
            want = set(want)
            for uid in want - cls._pov_users:
                await cls.evt_handler.send_client({"type": "$POV_START", "userId": uid})
            for uid in cls._pov_users - want:
                await cls.evt_handler.send_client({"type": "$POV_STOP", "userId": uid})
                cls._pov_init.pop(uid, None)
            cls._pov_users = want
        except Exception as e:
            logger.debug(f"[overlay] sync pov users failed: {e!r}")

    @classmethod
    def _on_pov_chunk(cls, data):
        """Fragment fMP4 du client (base64) → fragment binaire poussé aux pages
        overlay connectées : [1o len uid][uid][1o init][payload]. L'init
        (ftyp+moov, marqué `init`) est mis en CACHE par user pour être renvoyé
        en TÊTE à tout consommateur qui se connecte après (fMP4 : un fragment
        média n'est décodable qu'avec l'init de son flux). Une queue par
        client + tâche d'envoi dédiée : l'ordre des fragments est vital."""
        import base64
        try:
            uid = str(data.get("userId") or "")
            payload = base64.b64decode(data.get("data") or "")
            if not uid or not payload:
                return
            is_init = bool(data.get("init"))
            frame = bytes([len(uid)]) + uid.encode() + bytes([1 if is_init else 0]) + payload
            if is_init:
                cls._pov_init[uid] = frame
            for q in list(cls._pov_clients.values()):
                # Client à la traîne : on jette les fragments média récents
                # plutôt que d'accumuler (l'image reprendra, la latence non).
                if q.qsize() < 120:
                    q.put_nowait(frame)
        except Exception as e:
            logger.debug(f"[overlay] pov chunk relay failed: {e!r}")

    @classmethod
    async def _pov_feed(cls, request):
        """WS binaire consommé par la page overlay (lecture MSE H264/fMP4).
        À la connexion, on envoie d'abord l'init caché de chaque user actif
        pour que les fragments média qui suivent soient décodables."""
        from asyncio import Queue
        ws = WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        q = Queue()
        for uid in list(cls._pov_users):
            fr = cls._pov_init.get(uid)
            if fr:
                q.put_nowait(fr)
        cls._pov_clients[ws] = q

        async def sender():
            try:
                while True:
                    await ws.send_bytes(await q.get())
            except Exception:
                pass

        send_task = create_task(sender())
        try:
            async for _ in ws:
                pass
        finally:
            cls._pov_clients.pop(ws, None)
            send_task.cancel()
        return ws

    @classmethod
    async def _unload(cls):
        # Copies mp4 faites pour Discord : rien d'autre ne les effacerait, et
        # elles vivent dans /tmp avec la taille d'un clip.
        for f in list(getattr(cls, "_clip_tmp", ())):
            try:
                os.unlink(f)
            except OSError:
                pass
        cls._clip_tmp = set()
        # Fermer les fd /dev/input AVANT tout le reste : un rechargement de plugin
        # détruit les objets Python sans tuer le processus, donc rien ne les
        # refermerait tout seul (fuite de fd + lecteur fantôme).
        try:
            if cls._input_capture is not None:
                cls._input_capture = None
            # Relâcher AVANT de fermer les fd : si une touche liée est tenue au
            # moment du rechargement, le client a reçu $ptt=true et plus personne
            # ne lui dira l'inverse — le micro resterait ouvert.
            if cls._ptt_sources:
                try:
                    await cls._ptt_release_all()
                except Exception:
                    pass
            if cls._input_watcher is not None:
                cls._input_watcher.close()
                cls._input_watcher = None
        except Exception:
            pass
        # Restaurer la capture voix si un Go Live sans micro était en cours
        # (sinon la source par défaut resterait le null-sink silencieux).
        try:
            await cls._golive_mic_silence(False)
        except Exception:
            pass
        try:
            cls._voice_ov_on = False
            cls._pov_ov_on = False
            await cls._maybe_stop_overlay_window()
        except Exception:
            pass
        if hasattr(cls, "webrtc_server"):
            cls.webrtc_server.kill()
            await cls.webrtc_server.wait()

        if hasattr(cls, "portal_shim"):
            cls.portal_shim.kill()
            await cls.portal_shim.wait()

        proc = getattr(cls, "golive_preview", None)
        if proc is not None and proc.returncode is None:
            proc.kill()
            await proc.wait()

        if hasattr(cls, "runner"):
            await cls.runner.shutdown()
            await cls.runner.cleanup()

        if hasattr(cls, "shared_js_tab"):
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                """
                window.DISCORD_TAB.m_browserView.SetVisible(false);
                window.DISCORD_TAB.Destroy();
                window.DISCORD_TAB = undefined;
            """
            )
            await cls.shared_js_tab.close_websocket()
