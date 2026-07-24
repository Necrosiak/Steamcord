#!/usr/bin/env python3
# Fenêtre overlay in-game de Steamcord (vocal, et à terme POV vidéo).
# Fenêtre plein écran TRANSPARENTE qui pose l'atome GAMESCOPE_EXTERNAL_OVERLAY
# sur son window X11 (= mécanisme mangoapp) → en gamemode, gamescope la peint
# sur le plan overlay au-dessus du jeu. Même recette éprouvée que l'overlay
# chat Twitch (BoneCast) : géométrie moniteur forcée, visual RGBA, région
# d'input vide (les inputs traversent).
#
# DEUX backends de rendu, choisis automatiquement :
#   · webkit — WebKitGTK charge voice.html : roster vocal + POV vidéo (MSE).
#   · cairo  — repli SANS WebKit : le roster vocal est peint directement en
#              GTK3/Cairo. SteamOS (Steam Deck) n'expose AUCUN binding GIR
#              WebKit2 (ni 4.1 ni 4.0) → l'overlay ne démarrait jamais là-bas
#              (#22). Le POV vidéo reste indisponible dans ce mode (il repose
#              sur MediaSource, donc sur un moteur web).
#
# Usage : overlay.py --state-dir <dir>
#         overlay.py --probe        → capacités du système en JSON, puis exit
#   --state-dir : dossier où vit voice_state.json (écrit par le backend à
#                 chaque changement d'état vocal + réglages), poll-é en boucle.
import os, json, math, argparse, hashlib, threading, urllib.request
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

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_HTML = os.path.join(HERE, "voice.html")


def capabilities():
    """Ce que cette machine sait afficher — lu par le backend (menu QAM)."""
    backend = "webkit" if WEBKIT_VER else ("cairo" if (HAVE_CAIRO and HAVE_PANGO) else "none")
    return {
        "backend": backend,
        "webkit_version": WEBKIT_VER,
        "voice": backend != "none",
        # Le POV décode du fMP4 en MediaSource : moteur web obligatoire.
        "pov": backend == "webkit",
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


# ── Backend cairo (roster vocal seul, sans moteur web) ────────────────────────
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

        v = self.voice or {}
        users = v.get("users") or []
        if not v.get("enabled") or not users:
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

        total_h = len(rows) * row_h + max(0, len(rows) - 1) * gap_row
        y = self.MARGIN if pos.startswith("top") else H - self.MARGIN - total_h

        cr.push_group()
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
        cr.pop_group_to_source()
        cr.paint_with_alpha(max(0.0, min(1.0, opacity)))
        return False


def run_cairo(state_dir, state_path):
    win = build_window()
    area = RosterArea(state_dir)
    win.add(area)
    print("[overlay] backend=cairo (no WebKit2 binding on this system) — "
          "voice roster OK, video POV unavailable", flush=True)
    win.show_all()

    state = {"json": "", "warned_pov": False}

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
        if (st.get("pov") or {}).get("enabled") and not state["warned_pov"]:
            state["warned_pov"] = True
            print("[overlay] video POV requested but unavailable without WebKit2 "
                  "— showing the voice roster only", flush=True)
        return True

    tick()
    GLib.timeout_add(300, tick)
    Gtk.main()


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
        print(json.dumps(capabilities()), flush=True)
        return

    state_dir = args.state_dir
    os.makedirs(state_dir, exist_ok=True)
    state_path = os.path.join(state_dir, "voice_state.json")

    caps = capabilities()
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
