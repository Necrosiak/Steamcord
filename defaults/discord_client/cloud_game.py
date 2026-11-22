"""Read a native GeForce NOW window's game title for Steamcord Rich Presence.

No browser debugging, cookies, GNOME extensions, background service or fake
executables. Only used while Steam's running application is GeForce NOW.
"""
import ast
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import unicodedata


def is_geforce_launcher(name):
    key = re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKC', str(name or '')).casefold())
    return key in {'geforcenow', 'nvidiageforcenow'}


def _strip_joined_brand(title, brand):
    """Strip "<game> <1-3 lowercase words> GeForce NOW" (localised joiners).

    Polish titles read "<game> w usłudze GeForce NOW" (issue #88). Only
    all-lowercase words directly before the brand are removed (at most
    three), so a capitalised game name is never cut.
    """
    m = re.search(r'\s+' + brand + r'\s*$', title, flags=re.I)
    if not m:
        return title
    words = title[:m.start()].split(' ')
    n = 0
    def joiner(w):
        return w.isalpha() and w == w.lower() and w != w.upper()
    while n < len(words) and joiner(words[-1 - n]):
        n += 1
    # More than three lowercase words, or nothing left: unknown format.
    game = ' '.join(words[:-n]).strip() if 0 < n <= 3 else ''
    if game:
        return game
    return title


def classify_title(title):
    """Return (kind, game) for a proven native GFN window title.

    kind is one of 'game', 'branding' (only the GeForce NOW name), 'page'
    (a launcher page or status such as Home/Loading/Error), 'invalid'
    (control characters, too long) or 'unknown' (branding in an unknown
    format). Only the kind may be logged; never the title itself.
    """
    if not isinstance(title, str) or len(title) > 300 or any(ord(c) < 32 for c in title):
        return 'invalid', None
    title = unicodedata.normalize('NFKC', title.replace('®', '').replace('™', '')).strip()
    if not title or is_geforce_launcher(title):
        return 'branding', None
    brand = r'(?:NVIDIA\s+)?GeForce\s*NOW'
    # Require a word/separator boundary; preserve punctuation inside game names.
    title = re.sub(r'\s+(?:(?:on|en|in|via)\s+|[-–—|:]\s*)' + brand + r'\s*$', '', title, flags=re.I)
    title = _strip_joined_brand(title, brand)
    title = re.sub(r'^' + brand + r'\s*[-–—|:]\s*', '', title, flags=re.I)
    title = title.replace('®', '').replace('™', '').strip()
    status = title.casefold().rstrip(' .…')
    if re.match(r'^(?:application (?:launch failed|resource corrupted)\b|error code\b|error\s*[:#]|error\s+(?:0x|[0-9])|connecting to\b)', status):
        return 'page', None
    if not title or is_geforce_launcher(title):
        return 'branding', None
    # SDL's own hidden graphics window, opened by the Linux app (measured 14/11).
    if status == 'sdlgraphicscontext':
        return 'page', None
    if status in {
        'games', 'home', 'library', 'settings', 'sign in', 'login', 'jeux',
        'accueil', 'bibliothèque', 'paramètres', 'connexion', 'nvidia',
        'loading', 'connecting', 'sign-in', 'signin', 'queue', 'error', 'chargement',
    }:
        return 'page', None
    # A remaining branding string has an unknown format; do not publish it.
    if re.search(brand, title, re.I):
        return 'unknown', None
    return ('game', title) if len(title) <= 200 else ('invalid', None)


def game_from_title(title):
    """Called only for a proven native GFN window, never for arbitrary tabs."""
    return classify_title(title)[1]


def _native_linux_pids(proc_root=Path('/proc')):
    pids = set()
    try:
        entries = proc_root.iterdir()
        for path in entries:
            if not path.name.isdecimal():
                continue
            try:
                with (path / 'cmdline').open('rb') as f:
                    argv = f.read(4096).split(b'\0', 1)
                exe = argv[0].rsplit(b'/', 1)[-1].lower()
                if exe in (b'geforcenow', b'geforcenow.exe', b'geforcenowstreamer', b'geforcenowstreamer.exe'):
                    pids.add(int(path.name))
            except OSError:
                continue
    except OSError:
        pass
    return pids


def _x11_titles(env, run=subprocess.run, which=shutil.which, stats=None):
    """Bounded, read-only queries; the caller supplies the actual Steam display.

    GFN's Flatpak can advertise a PID inside its own namespace. Exact WM_CLASS
    plus a running native GFN process is used instead of comparing namespace PIDs.
    """
    if not env.get('DISPLAY') or not which('xprop', path=env.get('PATH')):
        return None
    deadline = time.monotonic() + 2

    def query(args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        result = run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     text=True, encoding='utf-8', errors='replace', timeout=min(.4, remaining), check=False)
        return result.stdout if result.returncode == 0 else None

    titles = []
    try:
        roots = query(['xprop', '-root', '_NET_CLIENT_LIST'])
        if roots is None:
            return None
        ids = re.findall(r'0x[0-9a-fA-F]+', roots)
        # Gamescope may not expose an EWMH client list; ask for root children.
        if not ids and which('xwininfo', path=env.get('PATH')):
            children = query(['xwininfo', '-root', '-children'])
            if children is None:
                return None
            ids = re.findall(r'^\s+(0x[0-9a-fA-F]+)\s+"', children, re.M)
        if len(ids) > 128:
            return None
        if stats is not None:
            stats['windows'] = len(dict.fromkeys(ids))
        for wid in dict.fromkeys(ids):
            props = query(['xprop', '-f', 'WM_NAME', '8s', '-id', wid, 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'])
            if props is None:
                continue
            cls = re.search(r'^WM_CLASS\([^\n]+?\)\s*=\s*(.*)$', props, re.M)
            if not cls:
                continue
            try:
                classes = ast.literal_eval('[' + cls.group(1) + ']')
            except (ValueError, SyntaxError):
                continue
            if not any(is_geforce_launcher(x) or x.casefold() == 'com.nvidia.geforcenow'
                       for x in classes if isinstance(x, str)):
                continue
            for prop in ('_NET_WM_NAME', 'WM_NAME'):
                value = re.search(r'^' + prop + r'\([^\n]+?\)\s*=\s*(.*)$', props, re.M)
                if not value:
                    continue
                try:
                    title = ast.literal_eval(value.group(1))
                    if isinstance(title, str):
                        if prop == 'WM_NAME':
                            # Ask xprop for raw bytes (8s): its default ICCCM
                            # conversion corrupts UTF-8 stored in legacy STRING.
                            # Valid UTF-8 wins; genuine Latin-1 remains readable.
                            try:
                                title = title.encode('latin-1').decode('utf-8')
                            except UnicodeError:
                                pass
                        titles.append(title)
                        break
                except (ValueError, SyntaxError):
                    continue
        return titles
    except (OSError, subprocess.TimeoutExpired, TimeoutError):
        # Do not return a partial result: another unqueried window could name a
        # different game. Ambiguous or timed-out detection retains the Steam name.
        return None


def _windows_titles(pids):
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    titles = []

    @callback_type
    def collect(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and user32.IsWindowVisible(hwnd):
            size = user32.GetWindowTextLengthW(hwnd)
            if 0 < size <= 300:
                buffer = ctypes.create_unicode_buffer(size + 1)
                user32.GetWindowTextW(hwnd, buffer, size + 1)
                titles.append(buffer.value)
        return True

    if not user32.EnumWindows(collect, 0):
        return None
    return titles


_BRAND = re.compile(r'(?:NVIDIA\s+)?GeForce\s*NOW', re.I)


def _mask_words(text):
    def word(m):
        w = m.group(0)
        # Short lowercase words are the joining words a format needs
        # ("on", "na", "auf"...), never enough to name a game.
        if len(w) <= 3 and w.islower() and not any(c.isdigit() for c in w):
            return w
        return ''.join('0' if c.isdigit() else 'A' if c.isupper() else 'a' for c in w)
    return re.sub(r'\w+', word, text)


def title_shape(title):
    """The format of a title without its content, for the diagnostics (#88):
    letters become a/A, digits 0; only the GeForce NOW name, punctuation and
    short joining words stay. "Portal 2 na GeForce NOW" -> "Aaaaaa 0 na GeForce NOW"."""
    if not isinstance(title, str):
        return None
    title = ''.join(c for c in unicodedata.normalize('NFKC', title)[:120] if ord(c) >= 32)
    out, pos = [], 0
    for m in _BRAND.finditer(title):
        out += [_mask_words(title[pos:m.start()]), 'GeForce NOW']
        pos = m.end()
    out.append(_mask_words(title[pos:]))
    return ''.join(out)


def _title_summary(titles):
    """Counts, plus the masked shape of titles in an unknown format."""
    kinds, shapes = {}, []
    for title in titles or ():
        kind = classify_title(title)[0]
        kinds[kind] = kinds.get(kind, 0) + 1
        if kind == 'unknown' and len(shapes) < 3:
            shapes.append(title_shape(title))
    return {'gfn_windows': len(titles or ()), 'title_kinds': kinds, 'unknown_shapes': shapes}


def _x11_displays(env, socket_dir=Path('/tmp/.X11-unix')):
    """Steam's display first, then gamescope's other XWayland displays.

    Gamescope starts several XWayland servers. Steam is on one of them, while
    the GeForce NOW Flatpak opens its windows on another (measured 14/11 on
    SteamOS-style gamescope: Steam on :0, GeForce NOW on :1, issue #88).
    """
    first = env.get('DISPLAY')
    if not first:
        return []
    displays = [first]
    main = first.split('.', 1)[0]
    try:
        numbers = sorted(int(p.name[1:]) for p in socket_dir.iterdir() if re.fullmatch(r'X\d{1,3}', p.name))
    except OSError:
        numbers = []
    for number in numbers:
        display = ':%d' % number
        if display != main and len(displays) < 3:
            displays.append(display)
    return displays


def _gamescope_x11_titles(env, run=subprocess.run, which=shutil.which, stats=None, displays=None):
    """Titles from every gamescope display. Steam's display must answer; another
    display that cannot be queried is skipped, as it cannot hold Steam's game."""
    titles, windows = [], 0
    for index, display in enumerate(_x11_displays(env) if displays is None else displays):
        found = {}
        got = _x11_titles({**env, 'DISPLAY': display}, run=run, which=which, stats=found)
        if got is None:
            if index == 0:
                return None
            continue
        windows += found.get('windows', 0)
        titles += got
    if stats is not None:
        stats['windows'] = windows
    return titles


def detect_geforce_game(steam_game, env=None, gamescope=False):
    """A fresh snapshot. No retained last-game value that could go stale."""
    if not is_geforce_launcher(steam_game):
        return {'game': None, 'reason': 'not_gfn', 'source': None}
    try:
        stats = {}
        if sys.platform == 'win32':
            import host
            pids = {pid for pid, exe in host.processes()
                    if re.split(r'[\\/]', exe)[-1].casefold() in {'geforcenow.exe', 'geforcenowstreamer.exe'}}
            source = 'windows-title'
            titles = _windows_titles(pids) if pids else []
        else:
            pids = _native_linux_pids()
            source = 'x11-title'
            read = _gamescope_x11_titles if gamescope else _x11_titles
            titles = read(dict(env or os.environ), stats=stats) if pids else []
        if not pids:
            return {'game': None, 'reason': 'not_running', 'source': source}
        if titles is None:
            return {'game': None, 'reason': 'unavailable', 'source': source, **stats}
        details = {**stats, **_title_summary(titles)}
        games = {game for title in titles if (game := game_from_title(title))}
        if len(games) == 1:
            return {'game': games.pop(), 'reason': 'detected', 'source': source, **details}
        return {'game': None, 'reason': 'ambiguous' if games else 'no_game', 'source': source, **details}
    except (OSError, ValueError, AttributeError):
        return {'game': None, 'reason': 'unavailable', 'source': None}
