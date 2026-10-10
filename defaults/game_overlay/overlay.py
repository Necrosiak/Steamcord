#!/usr/bin/env python3
# Fenêtre overlay in-game de Steamcord (vocal et POV vidéo).
# Fenêtre plein écran TRANSPARENTE qui pose l'atome GAMESCOPE_EXTERNAL_OVERLAY
# sur son window X11 (= mécanisme mangoapp) → en gamemode, gamescope la peint
# sur le plan overlay au-dessus du jeu. Même recette éprouvée que l'overlay
# chat Twitch (BoneCast) : géométrie moniteur forcée, visual RGBA, région
# d'input vide (les inputs traversent).
#
# DEUX backends de rendu, choisis automatiquement :
#   · webkit — WebKitGTK charge voice.html : roster vocal + POV vidéo (MSE).
#   · cairo  — repli SANS WebKit : roster et POV peints en GTK3/Cairo.
#              SteamOS n'expose pas WebKit2 GIR ; GStreamer y décode WebM/VP8
#              en images brutes. Si les éléments manquent, le roster reste là.
#
# Usage : overlay.py --state-dir <dir>
#         overlay.py --probe        → capacités du système en JSON, puis exit
#   --state-dir : dossier où vit voice_state.json (écrit par le backend à
#                 chaque changement d'état vocal + réglages), poll-é en boucle.
import os, json, math, time, argparse, hashlib, threading, urllib.request
import socket, base64, secrets, struct
from collections import deque
from urllib.parse import urlsplit
os.environ["GDK_BACKEND"] = "x11"  # window X11 sous XWayland → XID + atome settable

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")

# Le binding GIR de WebKit2-GTK3 change de version selon l'OS : 4.1 (libsoup3,
# distros récentes) ou 4.0 (libsoup2, plus ancien) — et il est carrément ABSENT
# sur SteamOS. On sonde les deux ; sans lui on bascule sur le backend cairo au
# lieu de mourir (cf. #22).
WEBKIT_VER = None
for _wk_ver in ("4.1", "4.0"):
    try:
        gi.require_version("WebKit2", _wk_ver)
        WEBKIT_VER = _wk_ver
        break
    except ValueError:
        continue

from gi.repository import Gtk, Gdk, GLib, GdkPixbuf

# pycairo : indispensable au backend cairo (dessin + région d'input vide).
try:
    import cairo
    HAVE_CAIRO = True
except Exception:
    HAVE_CAIRO = False

try:
    gi.require_version("PangoCairo", "1.0")
    from gi.repository import Pango, PangoCairo
    HAVE_PANGO = True
except Exception:
    HAVE_PANGO = False

# Le fallback Cairo peut décoder les POV sans WebKit. SteamOS fournit vp8dec ;
# appsrc + matroskademux transforment les fragments WebM de MediaRecorder en
# images brutes pour Cairo. On sonde les éléments exacts au lieu de supposer
# qu'un paquet GStreamer entier est installé sur toutes les distributions.
try:
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
    Gst.init(None)
    GST_POV_MISSING = [name for name in (
        "appsrc", "matroskademux", "vp8dec", "videoconvert", "appsink")
        if Gst.ElementFactory.find(name) is None]
except Exception:
    Gst = None
    GST_POV_MISSING = ["Gst Python bindings"]

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_HTML = os.path.join(HERE, "voice.html")


def capabilities(requested_backend="auto"):
    """Ce que cette machine sait afficher — lu par le backend (menu QAM)."""
    backend = "webkit" if WEBKIT_VER else ("cairo" if (HAVE_CAIRO and HAVE_PANGO) else "none")
    if requested_backend == "cairo" and HAVE_CAIRO and HAVE_PANGO:
        backend = "cairo"
    return {
        "backend": backend,
        "webkit_version": WEBKIT_VER,
        "voice": backend != "none",
        "pov": backend == "webkit" or (backend == "cairo" and not GST_POV_MISSING),
        "pov_format": "mp4" if backend == "webkit" else "webm",
        "pov_missing": GST_POV_MISSING if backend == "cairo" else [],
        "cairo": HAVE_CAIRO,
        "pango": HAVE_PANGO,
    }


def _set_atoms_xlib(xid):
    from Xlib import display, Xatom
    d = display.Display()
    w = d.create_resource_object("window", xid)
    w.change_property(d.intern_atom("GAMESCOPE_EXTERNAL_OVERLAY"), Xatom.CARDINAL, 32, [1])
    w.change_property(
        d.intern_atom("_NET_WM_WINDOW_TYPE"), Xatom.ATOM, 32,
        [d.intern_atom("_KDE_NET_WM_WINDOW_TYPE_ON_SCREEN_DISPLAY"),
         d.intern_atom("_NET_WM_WINDOW_TYPE_NOTIFICATION")])
    d.sync(); d.close()


def _set_atoms_ctypes(xid):
    """Même chose SANS python-xlib : appel direct de libX11 (toujours présente
    puisqu'on tourne sous XWayland). SteamOS n'embarque pas forcément le module
    python — sans ce repli, gamescope ne peindrait jamais l'overlay."""
    from ctypes import cdll, c_char_p, c_int, c_ulong, c_void_p, POINTER
    x = cdll.LoadLibrary("libX11.so.6")
    x.XOpenDisplay.argtypes = [c_char_p]; x.XOpenDisplay.restype = c_void_p
    x.XInternAtom.argtypes = [c_void_p, c_char_p, c_int]; x.XInternAtom.restype = c_ulong
    x.XChangeProperty.argtypes = [c_void_p, c_ulong, c_ulong, c_ulong, c_int, c_int,
                                  POINTER(c_ulong), c_int]
    x.XSync.argtypes = [c_void_p, c_int]
    x.XCloseDisplay.argtypes = [c_void_p]

    d = x.XOpenDisplay(None)
    if not d:
        raise RuntimeError("XOpenDisplay failed")
    try:
        XA_ATOM, XA_CARDINAL, REPLACE = 4, 6, 0
        one = (c_ulong * 1)(1)
        x.XChangeProperty(d, xid, x.XInternAtom(d, b"GAMESCOPE_EXTERNAL_OVERLAY", False),
                          XA_CARDINAL, 32, REPLACE, one, 1)
        types = (c_ulong * 2)(
            x.XInternAtom(d, b"_KDE_NET_WM_WINDOW_TYPE_ON_SCREEN_DISPLAY", False),
            x.XInternAtom(d, b"_NET_WM_WINDOW_TYPE_NOTIFICATION", False))
        x.XChangeProperty(d, xid, x.XInternAtom(d, b"_NET_WM_WINDOW_TYPE", False),
                          XA_ATOM, 32, REPLACE, types, 2)
        x.XSync(d, False)
    finally:
        x.XCloseDisplay(d)


def set_overlay_atom(xid):
    """Pose GAMESCOPE_EXTERNAL_OVERLAY=1 (comme mangoapp) + type fenêtre OSD.
    Le type KDE « on-screen-display » (popup de volume) vit dans une couche
    KWin AU-DESSUS du plein écran ACTIF — sans lui, Big Picture focalisé
    recouvre l'overlay (la couche notification passe dessous)."""
    for name, fn in (("xlib", _set_atoms_xlib), ("ctypes", _set_atoms_ctypes)):
        try:
            fn(xid)
            return name
        except Exception as e:
            print("[overlay] atoms via %s failed: %s" % (name, e), flush=True)
    return False


def build_window():
    """Fenêtre plein écran transparente, sans focus ni inputs."""
    win = Gtk.Window()
    win.set_decorated(False)
    win.set_skip_taskbar_hint(True)
    win.set_skip_pager_hint(True)
    win.set_app_paintable(True)
    win.set_title("Steamcord Overlay")
    # Affichage PUR : jamais de focus, jamais d'inputs (cf. overlay BoneCast —
    # sans ça la fenêtre plein écran volait le focus de Steam en Bureau/BP).
    win.set_accept_focus(False)
    win.set_focus_on_map(False)
    win.set_can_focus(False)
    win.set_keep_above(True)
    win.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION)

    # Taille EXPLICITE = plein écran de la sortie (gamescope over-game n'honore
    # pas toujours fullscreen() ; sans ça GTK dimensionne au contenu ancré 0,0
    # et un widget « bas-droite » finit tronqué dans le coin haut-gauche).
    sw, sh = 1920, 1080
    try:
        disp = Gdk.Display.get_default()
        mon = disp.get_primary_monitor() or disp.get_monitor(0)
        geo = mon.get_geometry()
        if geo.width > 0 and geo.height > 0:
            sw, sh = geo.width, geo.height
    except Exception as e:
        print("[overlay] monitor geometry failed, falling back to 1920x1080:", e, flush=True)
    win.set_default_size(sw, sh)
    win.set_size_request(sw, sh)
    win.move(0, 0)
    win.fullscreen()

    rgba = win.get_screen().get_rgba_visual()
    if rgba:
        win.set_visual(rgba)

    def on_map(_w):
        gdk_win = win.get_window()
        xid = gdk_win.get_xid()
        ok = set_overlay_atom(xid)
        # Région d'input VIDE (X11 Shape) : clics/manette traversent vers le
        # jeu. À poser après le map, sinon GTK/WebKit la réinitialise.
        try:
            gdk_win.input_shape_combine_region(cairo.Region(), 0, 0)
            passthrough = True
        except Exception as e:
            passthrough = False
            print("[overlay] input passthrough failed:", e, flush=True)
        print("[overlay] mapped xid=%s atom=%s passthrough=%s"
              % (hex(xid), ok, passthrough), flush=True)

    win.connect("map", on_map)
    win.connect("destroy", Gtk.main_quit)
    return win


# ── Backend WebKit (roster + POV) ─────────────────────────────────────────────
def run_webkit(state_dir, state_path):
    from gi.repository import WebKit2

    # Contexte WebKit à data dir persistant (cache avatars CDN entre relances).
    dm = WebKit2.WebsiteDataManager(
        base_data_directory=os.path.join(state_dir, "wk-data"),
        base_cache_directory=os.path.join(state_dir, "wk-cache"),
    )
    ctx = WebKit2.WebContext.new_with_website_data_manager(dm)

    # Injecte window.OVERLAY_CFG AVANT le chargement du document.
    ucm = WebKit2.UserContentManager()
    script = "window.OVERLAY_CFG = %s;" % json.dumps({"stateUrl": "file://" + state_path})
    ucm.add_script(WebKit2.UserScript(
        script, WebKit2.UserContentInjectedFrames.ALL_FRAMES,
        WebKit2.UserScriptInjectionTime.START, None, None))

    win = build_window()
    wv = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
    wv.set_background_color(Gdk.RGBA(0, 0, 0, 0))
    # file:// doit pouvoir fetch le state local + les avatars CDN Discord.
    s = wv.get_settings()
    s.set_property("allow-file-access-from-file-urls", True)
    s.set_property("allow-universal-access-from-file-urls", True)
    wv.load_uri("file://" + PAGE_HTML)
    win.add(wv)
    print("[overlay] backend=webkit (WebKit2 %s)" % WEBKIT_VER, flush=True)
    win.show_all()
    Gtk.main()


# ── Backend cairo (roster vocal et POV sans moteur web) ───────────────────────
# Reproduit le rendu de voice.html : rangée pilule sombre, avatar rond, pseudo,
# badge micro coupé, halo vert quand la personne parle. Mêmes métriques que le
# CSS (26 px d'avatar, 13 px de texte, rayon 16 px…), mises à l'échelle par le
# réglage « taille » du menu QAM.
class RosterArea(Gtk.DrawingArea):
    AVATAR = 26.0
    PAD_V = 3.0
    PAD_IN = 4.0       # côté avatar
    PAD_OUT = 9.0      # côté pseudo
    GAP = 7.0
    RADIUS = 16.0
    FONT_PX = 13.0
    MUTE = 13.0
    NAME_MAX = 160.0
    MARGIN = 18.0      # marge écran (non mise à l'échelle, comme le CSS)
    GAP_ROW = 4.0

    def __init__(self, state_dir):
        super().__init__()
        self._avatars = {}        # url -> GdkPixbuf.Pixbuf | False (échec)
        self._inflight = set()
        self._cache_dir = os.path.join(state_dir, "avatars")
        os.makedirs(self._cache_dir, exist_ok=True)
        self.voice = {}
        self.pov = {}
        self.pov_frames = {}   # uid -> (backing bytes, Cairo surface, width, height, last frame)
        self._pov_first_surface_logged = False
        self._pov_first_reject_logged = False
        self.connect("draw", self.on_draw)

    # ---- avatars ----
    @staticmethod
    def _pixbuf_url(url):
        """gdk-pixbuf ne décode pas le WebP sans loader dédié (absent de la
        plupart des images SteamOS) → on demande le PNG au CDN Discord."""
        return url.replace(".webp?", ".png?") if ".webp?" in url else url

    def _avatar(self, url):
        """Pixbuf si déjà en cache, sinon None + téléchargement en tâche de fond."""
        if not url:
            return None
        url = self._pixbuf_url(url)
        got = self._avatars.get(url)
        if got is not None:
            return got or None
        if url in self._inflight:
            return None
        self._inflight.add(url)
        threading.Thread(target=self._fetch_avatar, args=(url,), daemon=True).start()
        return None

    def _fetch_avatar(self, url):
        path = os.path.join(self._cache_dir, hashlib.sha1(url.encode()).hexdigest() + ".img")
        data = None
        try:
            if os.path.exists(path) and os.path.getsize(path) > 0:
                with open(path, "rb") as f:
                    data = f.read()
            else:
                req = urllib.request.Request(url, headers={"User-Agent": "Steamcord-Overlay"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = r.read()
                tmp = path + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, path)
        except Exception as e:
            print("[overlay] avatar fetch failed (%s): %s" % (url, e), flush=True)
        GLib.idle_add(self._store_avatar, url, data)

    def _store_avatar(self, url, data):
        pb = False
        if data:
            try:
                loader = GdkPixbuf.PixbufLoader()
                loader.write(data)
                loader.close()
                pb = loader.get_pixbuf() or False
            except Exception as e:
                print("[overlay] avatar decode failed: %s" % e, flush=True)
        self._avatars[url] = pb
        self._inflight.discard(url)
        self.queue_draw()
        return False

    # ---- rendu ----
    def set_voice(self, voice):
        self.voice = voice or {}
        self.queue_draw()

    def set_pov(self, pov):
        self.pov = pov or {}
        if not self.pov.get("enabled"):
            self.pov_frames.clear()
            self._pov_first_surface_logged = False
            self._pov_first_reject_logged = False
        self.queue_draw()

    def set_pov_frame(self, uid, data, width, height):
        if not self.pov.get("enabled") or width < 1 or height < 1 or width > 1920 or height > 1080:
            if self.pov.get("enabled") and not self._pov_first_reject_logged:
                print("[overlay] POV frame rejected: dimensions=%dx%d" % (width, height), flush=True)
                self._pov_first_reject_logged = True
            return False
        stride = len(data) // height
        if stride * height != len(data) or stride < width * 4 or stride % 4:
            if not self._pov_first_reject_logged:
                print("[overlay] POV frame rejected: invalid stride", flush=True)
                self._pov_first_reject_logged = True
            return False
        try:
            surface = cairo.ImageSurface.create_for_data(data, cairo.FORMAT_RGB24,
                                                          width, height, stride)
            self.pov_frames[uid] = (data, surface, width, height, time.monotonic())
            if not self._pov_first_surface_logged:
                print("[overlay] POV first Cairo surface ready: %dx%d" % (width, height), flush=True)
                self._pov_first_surface_logged = True
            self.queue_draw()
        except Exception as e:
            print("[overlay] POV frame rejected: %s" % e, flush=True)
        return False

    def clear_pov_frame(self, uid):
        self.pov_frames.pop(uid, None)
        self.queue_draw()
        return False

    def expire_pov_frames(self):
        now = time.monotonic()
        expired = [uid for uid, frame in self.pov_frames.items() if now - frame[4] > 5]
        for uid in expired:
            self.pov_frames.pop(uid, None)
        if expired:
            self.queue_draw()

    @staticmethod
    def _layout(cr, text, size, max_w):
        layout = PangoCairo.create_layout(cr)
        desc = Pango.FontDescription("Noto Sans, DejaVu Sans, Sans")
        desc.set_absolute_size(size * Pango.SCALE)
        desc.set_weight(Pango.Weight.SEMIBOLD)
        layout.set_font_description(desc)
        layout.set_text(text or "", -1)
        layout.set_ellipsize(Pango.EllipsizeMode.END)
        layout.set_width(int(max_w * Pango.SCALE))
        return layout

    @staticmethod
    def _rounded(cr, x, y, w, h, r):
        r = min(r, h / 2.0, w / 2.0)
        cr.new_sub_path()
        cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
        cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
        cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
        cr.arc(x + r, y + r, r, math.pi, 1.5 * math.pi)
        cr.close_path()

    @staticmethod
    def _draw_avatar(cr, pb, x, y, size, speaking):
        cr.save()
        cr.arc(x + size / 2, y + size / 2, size / 2, 0, 2 * math.pi)
        cr.clip()
        if pb:
            px = int(round(size))
            sc = pb.scale_simple(px, px, GdkPixbuf.InterpType.BILINEAR)
            Gdk.cairo_set_source_pixbuf(cr, sc, x, y)
            cr.paint()
        else:
            cr.set_source_rgba(0.35, 0.37, 0.42, 1)
            cr.paint()
        cr.restore()
        if speaking:
            # box-shadow 0 0 0 2px #23a55a + lueur 0 0 8px 2px
            cr.set_source_rgba(35 / 255, 165 / 255, 90 / 255, 0.45)
            cr.set_line_width(size * 0.22)
            cr.arc(x + size / 2, y + size / 2, size / 2 + size * 0.10, 0, 2 * math.pi)
            cr.stroke()
            cr.set_source_rgba(35 / 255, 165 / 255, 90 / 255, 1)
            cr.set_line_width(max(1.5, size * 0.08))
            cr.arc(x + size / 2, y + size / 2, size / 2 + size * 0.04, 0, 2 * math.pi)
            cr.stroke()

    @staticmethod
    def _draw_mute(cr, x, y, size):
        """Micro barré, rouge Discord (#ed4245) — équivalent du SVG de la page."""
        cr.save()
        cr.translate(x, y)
        u = size / 16.0
        cr.set_source_rgba(237 / 255, 66 / 255, 69 / 255, 1)
        # capsule du micro
        RosterArea._rounded(cr, 6 * u, 1.5 * u, 4 * u, 7.5 * u, 2 * u)
        cr.fill()
        # arceau + pied
        cr.set_line_width(1.4 * u)
        cr.arc(8 * u, 8 * u, 3.6 * u, 0, math.pi)
        cr.stroke()
        cr.move_to(8 * u, 11.6 * u); cr.line_to(8 * u, 14 * u); cr.stroke()
        cr.move_to(5.2 * u, 14 * u); cr.line_to(10.8 * u, 14 * u); cr.stroke()
        # barre : liseré sombre pour détacher le trait, puis le rouge
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.set_source_rgba(0, 0, 0, 0.55)
        cr.set_line_width(3.4 * u)
        cr.move_to(2.5 * u, 1.8 * u); cr.line_to(13.5 * u, 14.2 * u); cr.stroke()
        cr.set_source_rgba(237 / 255, 66 / 255, 69 / 255, 1)
        cr.set_line_width(1.8 * u)
        cr.move_to(2.5 * u, 1.8 * u); cr.line_to(13.5 * u, 14.2 * u); cr.stroke()
        cr.restore()

    def on_draw(self, _w, cr):
        # Fond 100 % transparent : seuls les widgets sont peints.
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)

        self._draw_pov(cr)

        v = self.voice or {}
        users = v.get("users") or []
        now_ms = time.time() * 1000
        events = [e for e in (v.get("events") or [])
                  if now_ms - e.get("ts", 0) < (v.get("event_ms") or 5000)]
        if not v.get("enabled") or not (users or events):
            return False

        st = v.get("settings") or {}
        pos = st.get("pos") if st.get("pos") in (
            "top-left", "top-right", "bottom-left", "bottom-right") else "bottom-left"
        opacity = st.get("opacity")
        opacity = (opacity if isinstance(opacity, (int, float)) else 85) / 100.0
        scale = st.get("scale")
        scale = (scale if isinstance(scale, (int, float)) else 100) / 100.0

        av = self.AVATAR * scale
        pad_v = self.PAD_V * scale
        pad_in = self.PAD_IN * scale
        pad_out = self.PAD_OUT * scale
        gap = self.GAP * scale
        radius = self.RADIUS * scale
        mute_sz = self.MUTE * scale
        gap_row = self.GAP_ROW * scale
        row_h = av + 2 * pad_v
        right = pos.endswith("right")

        W = self.get_allocated_width()
        H = self.get_allocated_height()

        # Mesure des rangées d'abord (largeur = contenu, comme width:fit-content).
        rows = []
        for u in users:
            muted = bool(u.get("is_muted") or u.get("is_deafened"))
            lay = self._layout(cr, u.get("username") or "", self.FONT_PX * scale,
                               self.NAME_MAX * scale)
            tw, th = lay.get_pixel_size()
            w = pad_in + av + gap + tw + (gap + mute_sz if muted else 0) + pad_out
            rows.append({"u": u, "lay": lay, "tw": tw, "th": th, "w": w, "muted": muted})

        # Arrivées / départs : petites lignes « → pseudo » (vert) / « ← pseudo »
        # (rouge), du côté libre du roster (au-dessus en bas d'écran).
        ev_rows = []
        ev_h = (self.FONT_PX - 1) * scale + 6 * scale
        for e in events:
            leave = e.get("kind") == "leave"
            arrow = self._layout(cr, "\u2190" if leave else "\u2192", (self.FONT_PX - 1) * scale, 40 * scale)
            name = self._layout(cr, e.get("name") or "", (self.FONT_PX - 1) * scale, self.NAME_MAX * scale)
            aw, ah = arrow.get_pixel_size()
            nw, nh = name.get_pixel_size()
            ev_rows.append({"leave": leave, "arrow": arrow, "name": name, "aw": aw,
                            "nw": nw, "th": max(ah, nh), "w": 9 * scale * 2 + aw + 6 * scale + nw})
        ev_total = len(ev_rows) * (ev_h + gap_row)

        total_h = len(rows) * row_h + max(0, len(rows) - 1) * gap_row
        top = pos.startswith("top")
        y = self.MARGIN if top else H - self.MARGIN - total_h - ev_total

        cr.push_group()

        def draw_events(y):
            for e in ev_rows:
                x = (W - self.MARGIN - e["w"]) if right else self.MARGIN
                cr.set_source_rgba(0, 0, 0, 0.45)
                self._rounded(cr, x, y, e["w"], ev_h, 12 * scale)
                cr.fill()
                if e["leave"]:
                    cr.set_source_rgba(0.93, 0.26, 0.27, 1)
                else:
                    cr.set_source_rgba(0.14, 0.65, 0.35, 1)
                cr.move_to(x + 9 * scale, y + (ev_h - e["th"]) / 2)
                PangoCairo.show_layout(cr, e["arrow"])
                cr.set_source_rgba(1, 1, 1, 0.85)
                cr.move_to(x + 9 * scale + e["aw"] + 6 * scale, y + (ev_h - e["th"]) / 2)
                PangoCairo.show_layout(cr, e["name"])
                y += ev_h + gap_row
            return y

        if not top:
            y = draw_events(y)
        for r in rows:
            u = r["u"]
            x = (W - self.MARGIN - r["w"]) if right else self.MARGIN

            cr.set_source_rgba(0, 0, 0, 0.55)
            self._rounded(cr, x, y, r["w"], row_h, radius)
            cr.fill()

            if right:
                # flex-direction: row-reverse → avatar à droite, badge à gauche.
                cx = x + pad_out
                if r["muted"]:
                    self._draw_mute(cr, cx, y + (row_h - mute_sz) / 2, mute_sz)
                    cx += mute_sz + gap
                text_x, avatar_x = cx, x + r["w"] - pad_in - av
            else:
                avatar_x = x + pad_in
                text_x = avatar_x + av + gap

            self._draw_avatar(cr, self._avatar(u.get("avatar_url")), avatar_x,
                              y + pad_v, av, bool(u.get("is_speaking")))

            cr.set_source_rgba(1, 1, 1, 1 if u.get("is_speaking") else 0.75)
            cr.move_to(text_x, y + (row_h - r["th"]) / 2)
            PangoCairo.show_layout(cr, r["lay"])

            if not right and r["muted"]:
                self._draw_mute(cr, text_x + r["tw"] + gap,
                                y + (row_h - mute_sz) / 2, mute_sz)

            y += row_h + gap_row
        if top:
            draw_events(y)
        cr.pop_group_to_source()
        cr.paint_with_alpha(max(0.0, min(1.0, opacity)))
        return False

    def _draw_pov(self, cr):
        if not self.pov.get("enabled") or not self.pov_frames:
            return
        st = self.pov.get("settings") or {}
        layout = st.get("layout")
        if layout not in ("right", "left", "top", "bottom", "corners"):
            layout = "right"
        raw_scale = st.get("scale")
        scale = max(0.5, min(1.8, (raw_scale if isinstance(raw_scale,
                    (int, float)) else 100) / 100.0))
        opacity = max(0.0, min(1.0, (st.get("opacity") if isinstance(st.get("opacity"),
                    (int, float)) else 90) / 100.0))
        width, height = self.get_allocated_width(), self.get_allocated_height()
        frames = list(self.pov_frames.items())[:4]
        count, gap, margin = len(frames), 8.0, 16.0
        tile_w = 280.0 * scale
        if layout in ("top", "bottom"):
            tile_w = min(tile_w, (width - margin * 2 - gap * (count - 1)) / count)
        elif layout in ("right", "left"):
            tile_w = min(tile_w, (height - margin * 2 - gap * (count - 1)) / count * 16 / 9)
        tile_w = max(48.0, tile_w)
        tile_h = tile_w * 9 / 16
        cr.push_group()
        for index, (uid, (_, surface, video_w, video_h, _)) in enumerate(frames):
            if layout == "right":
                x = width - margin - tile_w
                y = (height - count * tile_h - (count - 1) * gap) / 2 + index * (tile_h + gap)
            elif layout == "left":
                x = margin
                y = (height - count * tile_h - (count - 1) * gap) / 2 + index * (tile_h + gap)
            elif layout in ("top", "bottom"):
                x = (width - count * tile_w - (count - 1) * gap) / 2 + index * (tile_w + gap)
                y = margin if layout == "top" else height - margin - tile_h
            else:
                x = margin if index % 2 == 0 else width - margin - tile_w
                y = margin if index < 2 else height - margin - tile_h
            cr.set_source_rgba(0.04, 0.05, 0.07, 0.92)
            self._rounded(cr, x - 2, y - 2, tile_w + 4, tile_h + 4, 7)
            cr.fill()
            cr.save()
            self._rounded(cr, x, y, tile_w, tile_h, 5)
            cr.clip()
            factor = min(tile_w / video_w, tile_h / video_h)
            cr.translate(x + (tile_w - video_w * factor) / 2,
                         y + (tile_h - video_h * factor) / 2)
            cr.scale(factor, factor)
            cr.set_source_surface(surface, 0, 0)
            cr.paint()
            cr.restore()
            username = next((u.get("username") for u in (self.voice.get("users") or [])
                             if str(u.get("id")) == uid), None)
            if username:
                label = self._layout(cr, username, 11 * min(scale, 1.2), tile_w - 16)
                _, label_h = label.get_pixel_size()
                cr.set_source_rgba(0, 0, 0, 0.7)
                cr.rectangle(x, y + tile_h - label_h - 9, tile_w, label_h + 9)
                cr.fill()
                cr.set_source_rgba(1, 1, 1, 0.94)
                cr.move_to(x + 7, y + tile_h - label_h - 5)
                PangoCairo.show_layout(cr, label)
        cr.pop_group_to_source()
        cr.paint_with_alpha(opacity)


class PovDecoder:
    """Un décodeur WebM/VP8 par participant ; seule la dernière image va à GTK."""

    def __init__(self, uid, on_frame):
        self.uid = uid
        self.on_frame = on_frame
        self.pipeline = Gst.parse_launch(
            "appsrc name=source is-live=true format=bytes block=false max-bytes=4194304 "
            "! matroskademux ! vp8dec ! videoconvert "
            "! video/x-raw,format=BGRx "
            "! appsink name=sink emit-signals=true max-buffers=1 drop=true sync=false")
        self.source = self.pipeline.get_by_name("source")
        self.sink = self.pipeline.get_by_name("sink")
        self.sink.connect("new-sample", self._sample)
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("GStreamer VP8 pipeline could not start")

    def _sample(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        caps = sample.get_caps().get_structure(0)
        width, height = caps.get_value("width"), caps.get_value("height")
        buf = sample.get_buffer()
        ok, mapped = buf.map(Gst.MapFlags.READ)
        if ok:
            try:
                self.on_frame(self.uid, bytearray(mapped.data), width, height)
            finally:
                buf.unmap(mapped)
        return Gst.FlowReturn.OK

    def push(self, data):
        result = self.source.emit("push-buffer", Gst.Buffer.new_wrapped(data))
        if result != Gst.FlowReturn.OK:
            raise RuntimeError("GStreamer VP8 push-buffer: %s" % result)
        msg = self.pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
        if msg:
            err, detail = msg.parse_error()
            raise RuntimeError("GStreamer VP8 decode: %s %s" % (err, detail))

    def close(self):
        self.pipeline.set_state(Gst.State.NULL)


class PovReceiver:
    """Client du relais WS local. Aucun I/O réseau ne bloque le thread GTK."""

    def __init__(self, area):
        self.area = area
        self.stop_event = threading.Event()
        self.thread = None
        self.sock = None
        self.url = None
        self.decoders = {}
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.flush_scheduled = False
        self.frame_timer_id = None
        self.diag_lock = threading.Lock()
        self.diag = {"connections": 0, "inits": 0, "media": 0, "frames": 0}

    def start(self, url):
        if self.thread and self.thread.is_alive() and self.url == url:
            return
        self.stop()
        if self.thread and self.thread.is_alive():
            return
        self.url = url
        with self.diag_lock:
            self.diag = {"connections": 0, "inits": 0, "media": 0, "frames": 0}
        print("[overlay] POV receiver starting", flush=True)
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        with self.pending_lock:
            self.pending.clear()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)
        if self.thread and not self.thread.is_alive():
            self.thread = None
        self.url = None

    def _frame(self, uid, data, width, height):
        with self.diag_lock:
            self.diag["frames"] += 1
            first_frame = self.diag["frames"] == 1
        if first_frame:
            print("[overlay] POV first decoded frame: %dx%d" % (width, height), flush=True)
        with self.pending_lock:
            # MediaRecorder livre plusieurs images à la fois (~120 ms). Garder
            # seulement la dernière limitait le rendu à ~8 i/s alors que le
            # décodeur en sort 30. Une petite file bornée préserve leur rythme
            # sans accumuler de latence si le rendu prend du retard.
            self.pending.setdefault(uid, deque(maxlen=6)).append(
                (data, width, height))
            if self.flush_scheduled:
                return
            self.flush_scheduled = True
        GLib.idle_add(self._start_frame_clock)

    def _start_frame_clock(self):
        if self.frame_timer_id is None:
            self.frame_timer_id = GLib.timeout_add(33, self._flush_frames)
        self._flush_frames()
        return False

    def _flush_frames(self):
        with self.pending_lock:
            frames = {uid: queue.popleft() for uid, queue in self.pending.items()
                      if queue}
            self.pending = {uid: queue for uid, queue in self.pending.items()
                            if queue}
            if not frames:
                self.flush_scheduled = False
                self.frame_timer_id = None
                return False
        for uid, (data, width, height) in frames.items():
            self.area.set_pov_frame(uid, data, width, height)
        return True

    def _clear_decoders(self):
        for uid, decoder in list(self.decoders.items()):
            decoder.close()
            GLib.idle_add(self.area.clear_pov_frame, uid)
        self.decoders.clear()

    def _read_exact(self, count, pending):
        while len(pending) < count:
            if self.stop_event.is_set():
                raise ConnectionError("POV stopped")
            try:
                chunk = self.sock.recv(max(4096, count - len(pending)))
            except socket.timeout:
                continue
            if not chunk:
                raise ConnectionError("POV feed closed")
            pending.extend(chunk)
        data = bytes(pending[:count])
        del pending[:count]
        return data

    def _connect(self):
        parsed = urlsplit(self.url or "")
        if parsed.scheme != "ws" or parsed.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("POV feed must be local ws://")
        self.sock = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=3)
        self.sock.settimeout(0.5)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        request = ("GET %s HTTP/1.1\r\nHost: %s:%s\r\nUpgrade: websocket\r\n"
                   "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                   "Sec-WebSocket-Version: 13\r\n\r\n") % (
                       path, parsed.hostname, parsed.port or 80, key)
        self.sock.sendall(request.encode("ascii"))
        pending = bytearray()
        while b"\r\n\r\n" not in pending:
            if self.stop_event.is_set():
                raise ConnectionError("POV stopped")
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                raise ConnectionError("POV feed closed during handshake")
            pending.extend(chunk)
            if len(pending) > 8192:
                raise ConnectionError("POV WebSocket response too large")
        header, rest = pending.split(b"\r\n\r\n", 1)
        if not header.startswith(b"HTTP/1.1 101"):
            raise ConnectionError("POV WebSocket handshake refused")
        with self.diag_lock:
            self.diag["connections"] += 1
        print("[overlay] POV feed WebSocket connected", flush=True)
        return bytearray(rest)

    def _send_pong(self, payload):
        mask = secrets.token_bytes(4)
        size = len(payload)
        if size > 125:
            return
        encoded = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        self.sock.sendall(bytes([0x8a, 0x80 | size]) + mask + encoded)

    def _consume(self, pending):
        fragments = bytearray()
        while not self.stop_event.is_set():
            first, second = self._read_exact(2, pending)
            fin, opcode, length = bool(first & 0x80), first & 0x0f, second & 0x7f
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2, pending))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8, pending))[0]
            if length > 4 * 1024 * 1024:
                raise ConnectionError("POV frame too large")
            mask = self._read_exact(4, pending) if second & 0x80 else None
            payload = self._read_exact(length, pending)
            if mask:
                payload = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
            if opcode == 8:
                return
            if opcode == 9:
                self._send_pong(payload)
                continue
            if opcode not in (0, 2):
                continue
            if opcode == 2:
                fragments.clear()
            fragments.extend(payload)
            if len(fragments) > 4 * 1024 * 1024:
                raise ConnectionError("POV message too large")
            if fin:
                self._handle_message(bytes(fragments))
                fragments.clear()

    def _handle_message(self, data):
        if len(data) < 3:
            return
        uid_len = data[0]
        if not uid_len or len(data) <= uid_len + 2:
            return
        uid = data[1:1 + uid_len].decode("ascii", "ignore")
        is_init = data[1 + uid_len] == 1
        payload = data[2 + uid_len:]
        if is_init:
            with self.diag_lock:
                self.diag["inits"] += 1
                init_count = self.diag["inits"]
            print("[overlay] POV decoder init received: total=%d" % init_count, flush=True)
            previous = self.decoders.pop(uid, None)
            if previous:
                previous.close()
            GLib.idle_add(self.area.clear_pov_frame, uid)
            self.decoders[uid] = PovDecoder(uid, self._frame)
        else:
            with self.diag_lock:
                self.diag["media"] += 1
                first_media = self.diag["media"] == 1
            if first_media:
                print("[overlay] POV first media segment received", flush=True)
        decoder = self.decoders.get(uid)
        if decoder:
            decoder.push(payload)

    def log_health(self):
        if not self.thread or not self.thread.is_alive():
            return
        with self.diag_lock:
            stats = dict(self.diag)
        print("[overlay] POV health: ws=%d init=%d media=%d decoded=%d decoders=%d" % (
            stats["connections"], stats["inits"], stats["media"],
            stats["frames"], len(self.decoders)), flush=True)

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self._consume(self._connect())
            except Exception as e:
                if not self.stop_event.is_set():
                    print("[overlay] POV feed/decode: %s" % e, flush=True)
            finally:
                self._clear_decoders()
                if self.sock:
                    try:
                        self.sock.close()
                    except OSError:
                        pass
                    self.sock = None
            self.stop_event.wait(1)


def run_cairo(state_dir, state_path):
    win = build_window()
    area = RosterArea(state_dir)
    receiver = PovReceiver(area) if not GST_POV_MISSING else None
    win.add(area)
    print("[overlay] backend=cairo, POV=%s%s" % (
        "VP8/WebM" if receiver else "unavailable",
        " (missing: %s)" % ", ".join(GST_POV_MISSING) if GST_POV_MISSING else ""), flush=True)
    win.show_all()

    state = {"json": "", "pov_status": None}

    def tick():
        try:
            with open(state_path) as f:
                txt = f.read()
        except Exception:
            return True                     # pas encore écrit : on retente
        if not txt or txt == state["json"]:
            return True
        state["json"] = txt
        try:
            st = json.loads(txt)
        except Exception:
            return True
        area.set_voice(st.get("voice"))
        pov = st.get("pov") or {}
        pov_status = (bool(pov.get("enabled")), bool(pov.get("feed")))
        if pov_status != state["pov_status"]:
            print("[overlay] POV state: enabled=%s feed_configured=%s" % pov_status,
                  flush=True)
            state["pov_status"] = pov_status
        area.set_pov(pov)
        if receiver:
            if pov.get("enabled") and pov.get("feed"):
                receiver.start(pov["feed"])
            else:
                receiver.stop()
        return True

    tick()
    GLib.timeout_add(300, tick)

    def log_pov_health():
        if receiver:
            receiver.log_health()
        return True
    GLib.timeout_add_seconds(10, log_pov_health)

    def expire():
        # Une annonce d'arrivée/départ s'efface même si le state ne bouge plus.
        if (area.voice or {}).get("events"):
            area.queue_draw()
        area.expire_pov_frames()
        return True
    GLib.timeout_add(500, expire)
    try:
        Gtk.main()
    finally:
        if receiver:
            receiver.stop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=os.path.expanduser("~/.local/share/steamcord/game_overlay"))
    ap.add_argument("--probe", action="store_true",
                    help="affiche les capacités de rendu en JSON puis quitte")
    # « cairo » force le repli même quand WebKit est là (tests, ou machine où
    # WebKit rame) ; « auto » = WebKit si dispo, sinon cairo.
    ap.add_argument("--backend", choices=("auto", "webkit", "cairo"),
                    default=os.environ.get("STEAMCORD_OVERLAY_BACKEND", "auto"))
    args = ap.parse_args()

    if args.probe:
        print(json.dumps(capabilities(args.backend)), flush=True)
        return

    state_dir = args.state_dir
    os.makedirs(state_dir, exist_ok=True)
    state_path = os.path.join(state_dir, "voice_state.json")

    caps = capabilities(args.backend)
    backend = caps["backend"]
    if args.backend == "cairo" and HAVE_CAIRO and HAVE_PANGO:
        backend = "cairo"
    elif args.backend == "webkit" and not WEBKIT_VER:
        print("[overlay] webkit backend requested but unavailable — falling back", flush=True)
    if backend == "webkit":
        run_webkit(state_dir, state_path)
    elif backend == "cairo":
        run_cairo(state_dir, state_path)
    else:
        missing = []
        if not HAVE_CAIRO:
            missing.append("pycairo")
        if not HAVE_PANGO:
            missing.append("PangoCairo (gobject-introspection)")
        print("[overlay] no rendering backend available — neither WebKit2-GTK3 "
              "nor %s" % " + ".join(missing), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
