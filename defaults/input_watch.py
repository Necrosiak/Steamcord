# Lecture des périphériques d'entrée (clavier / souris) pour le raccourci vocal.
#
# Pourquoi ce module existe : SteamClient.Input (frontend) ne voit QUE la manette.
# Pour lier le push-to-talk à une touche de clavier ou à un bouton de souris il faut
# lire /dev/input/event* — donc côté BACKEND, et le raccourci doit fonctionner même
# quand un jeu a le focus.
#
# Le backend Decky tourne en `deck` NON PRIVILÉGIÉ (plugin.json : "flags": []) et
# c'est SUFFISANT : SteamOS livre /usr/lib/udev/rules.d/70-steam-jupiter-input.rules
# qui pose TAG+="uaccess" sur les périphériques d'entrée, ce qui donne une ACL POSIX
# (`user:deck:rw-`) sur les nœuds event* pour l'utilisateur de la session active.
# Vérifié sur l'appareil (10/08/26) : clavier USB *et* souris Bluetooth lisibles,
# press ET release reçus pendant qu'un jeu (Foxhole) avait le focus.
#
# ATTENTION — la lisibilité n'est PAS déductible du bus ni des règles udev : deux
# prédictions faites depuis le texte des règles se sont révélées fausses (on croyait
# root nécessaire, puis le Bluetooth exclu). On NE DEVINE PAS : on tente open() sur
# chaque nœud et on ne propose que ce qui s'ouvre réellement.
#
# On n'appelle JAMAIS EVIOCGRAB : le grab est par PÉRIPHÉRIQUE (pas par touche) et
# volerait tout le clavier au jeu. En lecteur passif le noyau livre chaque événement
# à TOUS les lecteurs ouverts (drivers/input/evdev.c) — le jeu reçoit la touche aussi.
#
# ── VIE PRIVÉE (contrainte dure, à ne pas relâcher) ──
# Un processus qui lit tous les claviers est techniquement un keylogger. Donc :
#   * AUCUN logger.* de ce module ne doit contenir un code de touche, un nom de
#     touche ou un objet événement. Les seules traces sont des transitions de haut
#     niveau (nombre de périphériques, capture démarrée / expirée).
#   * Rien n'est mis en mémoire tampon ni persisté hormis le binding CHOISI par
#     l'utilisateur, qu'il voit affiché dans l'UI.
#   * Hors capture, un événement dont le code ne correspond à aucun binding est
#     ignoré immédiatement, sans être stocké ni compté.

import ctypes
import errno
import fcntl
import glob
import os
import re

EV_SYN = 0x00
EV_KEY = 0x01
EV_REL = 0x02

SYN_DROPPED = 3

KEY_MAX = 0x2FF
EV_MAX = 0x1F
REL_MAX = 0x0F

# Sondes de classification (présence de ces codes dans le bitmap EV_KEY).
KEY_A, KEY_Z, KEY_SPACE = 30, 44, 57
BTN_LEFT, BTN_RIGHT = 0x110, 0x111

# Valve : la manette est déjà gérée par SteamClient.Input côté frontend, on ne la
# propose pas ici (sinon un bouton de manette serait capturable deux fois, avec deux
# libellés différents).
VENDOR_VALVE = 0x28DE


class InputEvent(ctypes.Structure):
    """struct input_event du noyau.

    ctypes et PAS struct.unpack("llHHi") : `long` fait 8 octets en 64 bits et 4 en
    32 bits ; un format figé casserait la taille (24 octets ici, vérifié sur Deck).
    """

    _fields_ = [
        ("sec", ctypes.c_long),
        ("usec", ctypes.c_long),
        ("type", ctypes.c_ushort),
        ("code", ctypes.c_ushort),
        ("value", ctypes.c_int32),
    ]


EVENT_SIZE = ctypes.sizeof(InputEvent)


class InputId(ctypes.Structure):
    """struct input_id (EVIOCGID)."""

    _fields_ = [
        ("bustype", ctypes.c_ushort),
        ("vendor", ctypes.c_ushort),
        ("product", ctypes.c_ushort),
        ("version", ctypes.c_ushort),
    ]


# ── ioctls, reconstruits sans dépendance (python-evdev embarque une extension C,
# or py_modules/ ne contient que du pur Python) ───────────────────────────────
_IOC_NRBITS, _IOC_TYPEBITS, _IOC_SIZEBITS = 8, 8, 14
_IOC_NRSHIFT = 0
_IOC_TYPESHIFT = _IOC_NRSHIFT + _IOC_NRBITS
_IOC_SIZESHIFT = _IOC_TYPESHIFT + _IOC_TYPEBITS
_IOC_DIRSHIFT = _IOC_SIZESHIFT + _IOC_SIZEBITS
_IOC_READ = 2


def _ioc(direction, typ, nr, size):
    return (
        (direction << _IOC_DIRSHIFT)
        | (typ << _IOC_TYPESHIFT)
        | (nr << _IOC_NRSHIFT)
        | (size << _IOC_SIZESHIFT)
    )


def _EVIOCGNAME(n):
    return _ioc(_IOC_READ, ord("E"), 0x06, n)


def _EVIOCGID():
    return _ioc(_IOC_READ, ord("E"), 0x02, ctypes.sizeof(InputId))


def _EVIOCGBIT(ev, n):
    return _ioc(_IOC_READ, ord("E"), 0x20 + ev, n)


def _test_bit(buf, bit):
    idx = bit // 8
    return idx < len(buf) and bool(buf[idx] & (1 << (bit % 8)))


def _bits(fd, ev_type, max_code):
    size = (max_code + 8) // 8
    buf = bytearray(size)
    try:
        fcntl.ioctl(fd, _EVIOCGBIT(ev_type, size), buf, True)
    except OSError:
        return bytearray()
    return buf


def _name(fd):
    buf = bytearray(256)
    try:
        fcntl.ioctl(fd, _EVIOCGNAME(len(buf)), buf, True)
    except OSError:
        return ""
    return bytes(buf).split(b"\0", 1)[0].decode("utf-8", "replace")


def _ident(fd):
    iid = InputId()
    try:
        fcntl.ioctl(fd, _EVIOCGID(), iid, True)
    except OSError:
        return (0, 0, 0)
    return (iid.bustype, iid.vendor, iid.product)


# ── Libellés ─────────────────────────────────────────────────────────────────
# On ne traduit PAS l'espace de noms Linux (≈300 constantes × 9 langues) : le nom
# brut (KEY_F13, BTN_SIDE) est stable, diagnosticable et compris tel quel. Seuls
# les mots de l'INTERFACE sont traduits (voir src/i18n.ts).
_KEY_NAMES = {
    1: "ESC", 12: "MINUS", 13: "EQUAL", 14: "BACKSPACE", 15: "TAB",
    26: "LEFTBRACE", 27: "RIGHTBRACE", 28: "ENTER", 29: "LEFTCTRL",
    39: "SEMICOLON", 40: "APOSTROPHE", 41: "GRAVE", 42: "LEFTSHIFT",
    43: "BACKSLASH", 51: "COMMA", 52: "DOT", 53: "SLASH", 54: "RIGHTSHIFT",
    55: "KPASTERISK", 56: "LEFTALT", 57: "SPACE", 58: "CAPSLOCK",
    69: "NUMLOCK", 70: "SCROLLLOCK", 74: "KPMINUS", 78: "KPPLUS",
    83: "KPDOT", 96: "KPENTER", 97: "RIGHTCTRL", 98: "KPSLASH",
    99: "SYSRQ", 100: "RIGHTALT", 102: "HOME", 103: "UP", 104: "PAGEUP",
    105: "LEFT", 106: "RIGHT", 107: "END", 108: "DOWN", 109: "PAGEDOWN",
    110: "INSERT", 111: "DELETE", 113: "MUTE", 114: "VOLUMEDOWN",
    115: "VOLUMEUP", 116: "POWER", 119: "PAUSE", 125: "LEFTMETA",
    126: "RIGHTMETA", 127: "COMPOSE",
}
for _i, _c in enumerate("1234567890"):
    _KEY_NAMES[2 + _i] = _c
for _i, _c in enumerate("QWERTYUIOP"):
    _KEY_NAMES[16 + _i] = _c
for _i, _c in enumerate("ASDFGHJKL"):
    _KEY_NAMES[30 + _i] = _c
for _i, _c in enumerate("ZXCVBNM"):
    _KEY_NAMES[44 + _i] = _c
for _i in range(10):                       # F1..F10
    _KEY_NAMES[59 + _i] = "F%d" % (_i + 1)
_KEY_NAMES[87], _KEY_NAMES[88] = "F11", "F12"
for _i in range(12):                       # F13..F24
    _KEY_NAMES[183 + _i] = "F%d" % (_i + 13)
for _i, _n in enumerate(["7", "8", "9"]):
    _KEY_NAMES[71 + _i] = "KP" + _n
for _i, _n in enumerate(["4", "5", "6"]):
    _KEY_NAMES[75 + _i] = "KP" + _n
for _i, _n in enumerate(["1", "2", "3"]):
    _KEY_NAMES[79 + _i] = "KP" + _n
_KEY_NAMES[82] = "KP0"

_BTN_NAMES = {
    0x110: "BTN_LEFT", 0x111: "BTN_RIGHT", 0x112: "BTN_MIDDLE",
    0x113: "BTN_SIDE", 0x114: "BTN_EXTRA", 0x115: "BTN_FORWARD",
    0x116: "BTN_BACK", 0x117: "BTN_TASK",
}

# Boutons qui cliquent en permanence en jeu : liables, mais l'UI avertit.
NOISY_BUTTONS = (0x110, 0x111, 0x112)


def code_name(code, kind):
    """Nom stable et affichable d'un code (jamais journalisé, cf. VIE PRIVÉE)."""
    if kind == "mouse":
        return _BTN_NAMES.get(code, "BTN_%d" % code)
    named = _KEY_NAMES.get(code)
    return ("KEY_" + named) if named else "KEY_%d" % code


def code_label(code, kind):
    """Libellé NEUTRE, non localisé.

    Le backend ne doit produire AUCUN texte traduit : il ne connaît pas la locale
    de l'utilisateur (celle-ci est détectée côté frontend via LocalizationManager).
    Une table française ici affichait « Souris arrière » à tout le monde, quelle
    que soit la langue. La traduction se fait dans src/voiceShortcut.ts à partir
    du nom brut (BTN_SIDE, KEY_F13…), qui est stable et sert de clé.
    """
    if kind == "mouse":
        return _BTN_NAMES.get(code, "BTN_%d" % code)
    named = _KEY_NAMES.get(code)
    return named if named else "KEY_%d" % code


def _node_num(path):
    m = re.sub(r"\D", "", os.path.basename(path))
    return int(m) if m else 0


def probe(path):
    """Décrit un nœud event*, ou None s'il n'est pas utilisable.

    « Utilisable » = ouvrable PAR NOUS (l'ACL uaccess est posée par uid) et porteur
    de touches ou de boutons. On tente réellement open() : c'est la seule mesure
    fiable de la lisibilité (cf. avertissement en tête de fichier).
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None                       # pas d'ACL pour nous → invisible, sans bruit
    try:
        evbits = _bits(fd, 0, EV_MAX)
        if not _test_bit(evbits, EV_KEY):
            return None
        keybits = _bits(fd, EV_KEY, KEY_MAX)
        has_letters = all(_test_bit(keybits, c) for c in (KEY_A, KEY_Z, KEY_SPACE))
        has_buttons = all(_test_bit(keybits, c) for c in (BTN_LEFT, BTN_RIGHT))
        has_rel = _test_bit(evbits, EV_REL)
        bustype, vendor, product = _ident(fd)
        name = _name(fd)
        if vendor == VENDOR_VALVE:
            return None                   # manette : déjà couverte par le frontend
        if has_buttons and has_rel:
            kind = "mouse"
        elif has_letters:
            kind = "keyboard"
        else:
            return None                   # boutons d'alimentation, jacks, etc.
        return {
            "node": os.path.basename(path),
            "kind": kind,
            "name": name,
            "vendor": "%04x" % vendor,
            "product": "%04x" % product,
            "bustype": "%04x" % bustype,
        }
    finally:
        os.close(fd)


def list_devices():
    """Périphériques clavier/souris réellement lisibles, triés par nœud."""
    out = []
    for path in sorted(glob.glob("/dev/input/event*"), key=_node_num):
        d = probe(path)
        if d:
            out.append(d)
    return out


# ── Périphériques PRÉSENTS mais non ouvrables ────────────────────────────────
# Un nœud sans ACL pour nous renvoie EACCES à open(), donc probe() ne peut RIEN
# en dire — pas même s'il s'agit d'un clavier. L'écarter en silence était le
# pire des choix : l'utilisateur voit la capture s'ouvrir, appuie sur son clavier
# et il ne se passe rien, sans le moindre message.
#
# /proc/bus/input/devices est lisible sans ACL et suffit à classer : la ligne
# `H: Handlers=` contient `kbd` pour un clavier et `mouseN` pour une souris.
# On ne s'en sert QUE pour les nœuds qu'on ne peut pas ouvrir — pour les autres,
# probe() reste la seule mesure de vérité (cf. avertissement en tête de fichier).
#
# Mesuré sur BC-250/Bazzite : 70-uaccess.rules ne pose `uaccess` que sur les
# joysticks (ENV{ID_INPUT_JOYSTICK}) et 70-steam-jupiter-input.rules, propre à
# SteamOS, n'existe pas — une souris USB ordinaire y est donc invisible.
def _proc_bit(bitmap, bit):
    """Teste un bit dans un bitmap `B: …=` de /proc/bus/input/devices.

    Le noyau imprime une suite de mots hexadécimaux, mot de POIDS FORT en tête ;
    le dernier mot porte donc les bits 0-63. Se fier au handler `kbd` seul ne
    marche pas : le bouton d'alimentation, le « Video Bus » et le haut-parleur PC
    en ont un et ne sont pas des claviers. On applique donc ici les MÊMES critères
    que probe() — lettres présentes, ou boutons souris + mouvement relatif.
    """
    words = bitmap.split()
    if not words:
        return False
    idx = bit // 64
    if idx >= len(words):
        return False
    try:
        return bool((int(words[len(words) - 1 - idx], 16) >> (bit % 64)) & 1)
    except ValueError:
        return False


def _proc_devices():
    """{node: (name, kinds)} d'après /proc/bus/input/devices."""
    out = {}
    try:
        with open("/proc/bus/input/devices", encoding="utf-8", errors="replace") as f:
            blocks = f.read().split("\n\n")
    except OSError:
        return out
    for blk in blocks:
        name, handlers, keybits, evbits, vendor = "", "", "", "", 0
        for line in blk.splitlines():
            if line.startswith("N: Name="):
                name = line.split("=", 1)[1].strip().strip('"')
            elif line.startswith("H: Handlers="):
                handlers = line.split("=", 1)[1]
            elif line.startswith("B: KEY="):
                keybits = line.split("=", 1)[1]
            elif line.startswith("B: EV="):
                evbits = line.split("=", 1)[1]
            elif line.startswith("I: "):
                m = re.search(r"Vendor=([0-9a-fA-F]+)", line)
                if m:
                    vendor = int(m.group(1), 16)
        if not handlers or vendor == VENDOR_VALVE:
            continue
        kinds = set()
        if all(_proc_bit(keybits, c) for c in (KEY_A, KEY_Z, KEY_SPACE)):
            kinds.add("keyboard")
        if (all(_proc_bit(keybits, c) for c in (BTN_LEFT, BTN_RIGHT))
                and _proc_bit(evbits, EV_REL)):
            kinds.add("mouse")
        if not kinds:
            continue
        for h in handlers.split():
            if h.startswith("event"):
                out[h] = (name, kinds)
    return out


def list_unreadable():
    """Claviers/souris présents que nous n'avons PAS le droit d'ouvrir.

    Sert uniquement à le DIRE à l'utilisateur : sans cette liste, un périphérique
    sans ACL est indiscernable d'un périphérique absent.
    """
    proc = _proc_devices()
    out = []
    for path in sorted(glob.glob("/dev/input/event*"), key=_node_num):
        node = os.path.basename(path)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        except OSError as e:
            if e.errno not in (errno.EACCES, errno.EPERM):
                continue
            info = proc.get(node)
            if not info:
                continue                  # ni clavier ni souris : hors sujet
            name, kinds = info
            out.append({"node": node, "name": name,
                        "kinds": sorted(kinds), "reason": "permission"})
            continue
        os.close(fd)
    return out


def fingerprint(dev):
    """Identité stable d'un binding.

    On ne persiste PAS /dev/input/eventN : le numéro change au rebranchement (et le
    Bluetooth se reconnecte souvent). On garde vendor/product/nom + le RÔLE du nœud,
    parce qu'un même clavier expose plusieurs nœuds et qu'un seul émet les touches
    (constaté : le Magic Keyboard parle sur event18, event9 reste muet).
    """
    return {
        "vendor": dev["vendor"],
        "product": dev["product"],
        "name": dev["name"],
        "node": dev["node"],
    }


def match(dev, fp):
    """Un périphérique correspond-il à une empreinte ? Le nœud n'est qu'un indice."""
    if not fp:
        return False
    return (
        dev["vendor"] == fp.get("vendor")
        and dev["product"] == fp.get("product")
        and dev["name"] == fp.get("name")
    )


class Watcher:
    """Lit les nœuds lisibles et signale les fronts press/release.

    Piloté par loop.add_reader : le processus dort tant que le noyau n'a rien à
    livrer (coût CPU nul au repos, ce qui compte sur batterie). Une boucle
    `while True: read(); sleep()` serait un bug de conso, pas une variante.
    """

    def __init__(self, loop, on_edge, on_capture, log=None, on_lost=None):
        self._loop = loop
        self._on_edge = on_edge          # (kind, code, node, down) -> None
        self._on_capture = on_capture    # (kind, code, node, dev) -> None
        self._on_lost = on_lost          # () -> None : un fd est mort, re-scanner
        self._log = log
        self._fds = {}                   # fd -> dict(device info)
        self._capturing = False
        self._closed = False
        self._last_count = -1            # pour ne journaliser qu'aux changements

    # ── cycle de vie ────────────────────────────────────────────────────────
    def rescan(self):
        """(Ré)ouvre l'ensemble des nœuds lisibles.

        Un événement de branchement veut dire RESCAN, jamais « vérité
        incrémentale » : la file inotify peut déborder et on se retrouverait avec
        une vue partielle silencieusement fausse.
        """
        if self._closed:
            return
        wanted = {d["node"]: d for d in list_devices()}
        for fd, info in list(self._fds.items()):
            if info["node"] not in wanted:
                self._drop(fd)
        have = {i["node"] for i in self._fds.values()}
        for node, dev in wanted.items():
            if node in have:
                continue
            path = "/dev/input/" + node
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            except OSError:
                continue
            self._fds[fd] = dev
            try:
                self._loop.add_reader(fd, self._readable, fd)
            except Exception:
                os.close(fd)
                self._fds.pop(fd, None)
        # Volontairement un COMPTE, pas une liste de touches. Et seulement aux
        # CHANGEMENTS : le rescan est périodique (réveil / reconnexion BT), on ne
        # veut pas une ligne de log toutes les 20 s.
        if self._log and len(self._fds) != self._last_count:
            self._log("input_watch: %d readable device(s)" % len(self._fds))
        self._last_count = len(self._fds)

    def _drop(self, fd):
        try:
            self._loop.remove_reader(fd)
        except Exception:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        self._fds.pop(fd, None)

    def close(self):
        self._closed = True
        self._capturing = False
        for fd in list(self._fds):
            self._drop(fd)

    # ── capture ─────────────────────────────────────────────────────────────
    def set_capturing(self, on):
        self._capturing = bool(on)

    @property
    def device_count(self):
        return len(self._fds)

    # ── lecture ─────────────────────────────────────────────────────────────
    def _readable(self, fd):
        info = self._fds.get(fd)
        if info is None:
            return
        while True:
            try:
                data = os.read(fd, EVENT_SIZE * 64)
            except BlockingIOError:
                return
            except OSError:
                # Débranchement / réveil de veille : le fd est mort. On le lâche et
                # on demande un rescan immédiat — au réveil le nœud est souvent
                # RENUMÉROTÉ (constaté : event18 -> event19 pour le même clavier),
                # donc attendre le prochain changement de config laisserait le
                # raccourci muet indéfiniment.
                self._drop(fd)
                if self._on_lost:
                    try:
                        self._on_lost()
                    except Exception:
                        pass
                return
            if not data:
                return
            for off in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                ev = InputEvent.from_buffer_copy(data[off:off + EVENT_SIZE])
                self._dispatch(info, ev)
            if len(data) < EVENT_SIZE * 64:
                return

    def _dispatch(self, info, ev):
        if ev.type == EV_SYN and ev.code == SYN_DROPPED:
            # Le noyau a jeté des événements : notre état « touche tenue » est
            # devenu un mensonge. On relâche pour ne pas laisser le micro ouvert.
            self._on_edge(info["kind"], None, info["node"], False)
            return
        if ev.type != EV_KEY:
            return                        # EV_REL (mouvement souris) : rien à faire
        if ev.value == 2:
            return                        # auto-répétition : ni press ni release
        down = ev.value == 1
        if self._capturing:
            if down:
                self._on_capture(info["kind"], ev.code, info["node"], info)
            return
        self._on_edge(info["kind"], ev.code, info["node"], down)


# ── Manette Valve lue en hidraw (issue #60) ─────────────────────────────────
#
# Pourquoi : SteamClient.Input (frontend) ne livre AUCUN bouton tant qu'un jeu a
# le focus — mesuré le 28/09/26 : 0 événement de RegisterForControllerInput-
# Messages (ni des messages analogiques) pendant qu'un jeu Proton est au premier
# plan, alors que tout arrive dès que l'interface Steam reprend la main. Le
# push-to-talk manette était donc muet précisément là où il sert. Les nœuds
# hidraw des manettes Valve, eux, sont lisibles par l'utilisateur de session
# (règles udev de Steam) et le noyau livre chaque rapport à TOUS les lecteurs :
# on lit en PASSIF, en parallèle de Steam, sans rien lui retirer.
#
# Ne gère QUE le Steam Controller (2026) et ses dongles. Format des rapports
# d'après le pilote SDL (src/joystick/hidapi/SDL_hidapi_steam_triton.c, zlib) :
# octet 0 = id du rapport, octet 1 = numéro de séquence, octets 2-5 = masque des
# boutons en petit-boutiste — vérifié sur l'appareil pour A/B/croix/L4/L5.
#
# Aucun bouton n'est journalisé (même règle que pour le clavier) : seul le
# nombre de nœuds ouverts l'est, et seulement quand il change.

HID_VENDOR_VALVE = 0x28DE
# 0x1302 filaire, 0x1303 BLE, 0x1304/0x1305 dongles (Proteus / Nereid).
HID_TRITON_PRODUCTS = {0x1302, 0x1303, 0x1304, 0x1305}
# 0x42 état, 0x45 état BLE, 0x47 état horodaté : même en-tête dans les trois.
HID_TRITON_STATE_REPORTS = {0x42, 0x45, 0x47}
HID_TRITON_WIRELESS = 0x79        # octet 1 : 1 = déconnexion, 2 = connexion
HID_TRITON_DISCONNECT = 1

# Bit du masque Triton -> identifiant de bouton Steam (celui que la capture du
# frontend enregistre dans la liaison). Mesurés en croisant hidraw et
# RegisterForControllerInputMessages : A, B, la croix, L4, L5. X, Y, R4, R5
# suivent la même énumération Steam (32/33 = L5/R5, 44/45 = L4/R4).
HID_TRITON_TO_STEAM = {
    0x00000001: 0,    # A
    0x00000002: 1,    # B
    0x00000004: 2,    # X
    0x00000008: 3,    # Y
    0x00002000: 20,   # croix haut
    0x00000400: 21,   # croix bas
    0x00001000: 22,   # croix gauche
    0x00000800: 23,   # croix droite
    0x00040000: 32,   # L5
    0x00000100: 33,   # R5
    0x00020000: 44,   # L4
    0x00000080: 45,   # R4
}
HID_SUPPORTED_BUTTONS = frozenset(HID_TRITON_TO_STEAM.values())


def list_hid_controllers():
    """Nœuds hidraw des manettes prises en charge qui s'ouvrent RÉELLEMENT."""
    out = []
    for dev in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            with open(os.path.join(dev, "device", "uevent")) as f:
                uevent = f.read()
        except OSError:
            continue
        m = re.search(r"^HID_ID=[0-9A-Fa-f]+:([0-9A-Fa-f]+):([0-9A-Fa-f]+)$", uevent, re.M)
        if not m:
            continue
        if int(m.group(1), 16) != HID_VENDOR_VALVE:
            continue
        if int(m.group(2), 16) not in HID_TRITON_PRODUCTS:
            continue
        node = os.path.basename(dev)
        # Même règle que pour /dev/input : on NE DEVINE PAS la lisibilité.
        try:
            os.close(os.open("/dev/" + node, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC))
        except OSError:
            continue
        out.append(node)
    return out


class HidControllerWatcher:
    """Suit les boutons tenus des manettes Valve et signale chaque changement.

    `on_change(held)` reçoit l'ensemble des identifiants de boutons Steam tenus,
    toutes manettes confondues. Piloté par loop.add_reader, comme Watcher.
    """

    def __init__(self, loop, on_change, log=None):
        self._loop = loop
        self._on_change = on_change
        self._log = log
        self._fds = {}                   # fd -> node
        self._masks = {}                 # fd -> masque des boutons suivis
        self._held = frozenset()
        self._closed = False
        self._last_count = -1

    @property
    def device_count(self):
        return len(self._fds)

    def rescan(self):
        if self._closed:
            return
        wanted = set(list_hid_controllers())
        for fd, node in list(self._fds.items()):
            if node not in wanted:
                self._drop(fd)
        have = set(self._fds.values())
        for node in wanted - have:
            try:
                fd = os.open("/dev/" + node, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            except OSError:
                continue
            self._fds[fd] = node
            self._masks[fd] = 0
            try:
                self._loop.add_reader(fd, self._readable, fd)
            except Exception:
                os.close(fd)
                self._fds.pop(fd, None)
                self._masks.pop(fd, None)
        if self._log and len(self._fds) != self._last_count:
            self._log("controller_hid: %d readable node(s)" % len(self._fds))
        self._last_count = len(self._fds)
        self._publish()

    def _drop(self, fd):
        try:
            self._loop.remove_reader(fd)
        except Exception:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        self._fds.pop(fd, None)
        self._masks.pop(fd, None)

    def close(self):
        self._closed = True
        for fd in list(self._fds):
            self._drop(fd)
        self._publish()

    def _readable(self, fd):
        if fd not in self._fds:
            return
        changed = False
        while True:
            try:
                data = os.read(fd, 64)
            except BlockingIOError:
                break
            except OSError:
                # Manette/dongle débranché ou réveil de veille : un bouton tenu à
                # cet instant ne sera jamais relâché sur ce fd → on le lâche (ce
                # qui retire ses boutons de l'ensemble tenu) et le rescan
                # périodique rouvrira le nœud s'il revient.
                self._drop(fd)
                changed = True
                break
            if not data:
                break
            if data[0] in HID_TRITON_STATE_REPORTS and len(data) >= 6:
                raw = int.from_bytes(data[2:6], "little")
                mask = 0
                for bit in HID_TRITON_TO_STEAM:
                    if raw & bit:
                        mask |= bit
            elif data[0] == HID_TRITON_WIRELESS and len(data) >= 2 \
                    and data[1] == HID_TRITON_DISCONNECT:
                mask = 0                 # manette éteinte : plus rien n'est tenu
            else:
                continue
            if mask != self._masks.get(fd):
                self._masks[fd] = mask
                changed = True
        if changed:
            self._publish()

    def _publish(self):
        held = frozenset(
            HID_TRITON_TO_STEAM[bit]
            for mask in self._masks.values()
            for bit in HID_TRITON_TO_STEAM
            if mask & bit
        )
        if held == self._held:
            return
        self._held = held
        try:
            self._on_change(held)
        except Exception:
            pass
