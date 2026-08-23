// Résolution du CAPTCHA de la page de login SANS quitter le mode Jeu (#37).
//
// Pourquoi un miroir plutôt que « montrer la fenêtre Vesktop » : mesuré sur
// BC-250 en mode Jeu, la fenêtre Vesktop est démappée (--start-minimized) et la
// re-mapper à la main ne change RIEN à l'écran — gamescope ne peint que la
// fenêtre désignée par Steam (GAMESCOPECTRL_BASELAYER_APPID), captures avant/
// après identiques au md5 près. La poser en overlay externe (l'atome de
// mangoapp, cf. defaults/game_overlay/overlay.py) l'affiche mais SANS focus ni
// entrées. Il ne reste donc que le miroir : le backend rend la page par CDP
// (Page.captureScreenshot marche même fenêtre démappée) et lui renvoie les
// clics (Input.dispatchMouseEvent — vérifié : la page les reçoit avec
// isTrusted=true, ce que hCaptcha exige).
import { Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { ACCENT, FULL_BLEED, chromeHideMarkerRef } from "./Styled";

declare const SteamClient: any;

const ModalRootAny = ModalRoot as any;

type Frame = { img: string; x: number; y: number; w: number; h: number; challenge: boolean };

// Ids de l'enum EGamepadButton (cf. voiceShortcut.ts, où ils sont déjà
// éprouvés). B (1) n'est pas géré ici : c'est l'annulation native de la modale.
const BTN_A = 0;
const BTN_DUP = 4, BTN_DRIGHT = 5, BTN_DDOWN = 6, BTN_DLEFT = 7;

// Déplacement du pointeur, en pixels de PAGE. Départ lent pour viser une case
// à cocher, accélération à la tenue pour traverser une grille d'images.
const TICK_MS = 55;
const STEP_MIN = 3;
const STEP_MAX = 26;
const ACCEL_TICKS = 10;

const FRAME_MS = 900;        // cadence normale du miroir
const FRAME_MS_BURST = 350;  // juste après un clic : le défi bouge

function CaptchaSolverModal({ closeModal }: { closeModal?: () => void }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState(false);
  const [clicking, setClicking] = useState(false);

  // Pointeur en coordonnées de PAGE (pas d'image) : le cadrage renvoyé par le
  // backend change quand le défi s'ouvre ou se referme, et un pointeur stocké
  // en coordonnées d'image sauterait à chaque recadrage.
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const [, forceRender] = useState(0);
  const frameRef = useRef<Frame | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const burstUntil = useRef(0);

  frameRef.current = frame;

  // ── Miroir ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let timer: any = null;

    call("captcha_session", true).catch(() => {});

    const poll = async () => {
      if (!alive) return;
      try {
        const f = await call<[boolean], Frame | null>("captcha_frame", false);
        if (!alive) return;
        if (f && f.img) {
          setFrame(f);
          setError(false);
          // Premier cadrage : pointeur au centre, l'endroit le plus utile
          // (case « je ne suis pas un robot » ou centre de la grille).
          if (!cursor.current) cursor.current = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
          else clampCursor(f);
        } else {
          setError(true);
        }
        // Connecté = CAPTCHA franchi : on referme tout seul.
        const st: any = await call("get_state");
        if (alive && st?.logged_in) closeModal?.();
      } catch {
        if (alive) setError(true);
      }
      if (!alive) return;
      timer = setTimeout(poll, Date.now() < burstUntil.current ? FRAME_MS_BURST : FRAME_MS);
    };
    poll();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      call("captcha_session", false).catch(() => {});
    };
  }, []);

  const clampCursor = (f: Frame) => {
    const c = cursor.current;
    if (!c) return;
    c.x = Math.min(f.x + f.w, Math.max(f.x, c.x));
    c.y = Math.min(f.y + f.h, Math.max(f.y, c.y));
  };

  const clickingRef = useRef(false);
  const clickAt = async (px: number, py: number) => {
    if (clickingRef.current) return;   // A tenu / tapé vite : pas de rafale
    clickingRef.current = true;
    setClicking(true);
    burstUntil.current = Date.now() + 4000;
    try { await call("captcha_click", px, py); } catch {}
    setTimeout(() => { clickingRef.current = false; setClicking(false); }, 180);
  };

  // ── Manette ───────────────────────────────────────────────────────────────
  // Même recette dual-signature que voiceShortcut.ts : la signature de
  // RegisterForControllerInputMessages a changé entre builds Steam (issue #14),
  // les deux formes coexistent donc dans la nature.
  useEffect(() => {
    const held = new Set<number>();
    let ticks = 0;
    let reg: any = null;

    const moveTimer = setInterval(() => {
      const f = frameRef.current;
      const c = cursor.current;
      if (!f || !c) return;
      let dx = 0, dy = 0;
      if (held.has(BTN_DLEFT)) dx -= 1;
      if (held.has(BTN_DRIGHT)) dx += 1;
      if (held.has(BTN_DUP)) dy -= 1;
      if (held.has(BTN_DDOWN)) dy += 1;
      if (!dx && !dy) { ticks = 0; return; }
      ticks++;
      const step = STEP_MIN + (STEP_MAX - STEP_MIN) * Math.min(1, ticks / ACCEL_TICKS);
      c.x += dx * step;
      c.y += dy * step;
      clampCursor(f);
      forceRender((n) => n + 1);
    }, TICK_MS);

    const onButton = (id: number, pressed: boolean) => {
      if (id === BTN_A) {
        if (pressed && cursor.current) clickAt(cursor.current.x, cursor.current.y);
        return;
      }
      if (id !== BTN_DUP && id !== BTN_DDOWN && id !== BTN_DLEFT && id !== BTN_DRIGHT) return;
      if (pressed) held.add(id); else held.delete(id);
      if (!pressed && held.size === 0) ticks = 0;
    };

    try {
      const Input = (window as any).SteamClient?.Input;
      if (typeof Input?.RegisterForControllerInputMessages === "function") {
        reg = Input.RegisterForControllerInputMessages((...args: any[]) => {
          try {
            const first = args[0];
            if (Array.isArray(first)) {
              for (const e of first) {
                if (typeof e?.nA === "number") onButton(e.nA, !!e.bS);
              }
            } else if (typeof args[1] === "number") {
              onButton(args[1], !!args[2]);
            }
          } catch {}
        });
      }
    } catch (e) {
      console.warn("[Steamcord] captcha: controller listener failed:", e);
    }

    return () => {
      clearInterval(moveTimer);
      // Deux formes de désabonnement selon le build Steam, comme dans
      // voiceShortcut.ts : une fonction, ou un objet à .unregister().
      try {
        if (typeof reg === "function") reg();
        else if (typeof reg?.unregister === "function") reg.unregister();
      } catch {}
    };
  }, []);

  // ── Rendu ─────────────────────────────────────────────────────────────────
  // Le pointeur se dessine à partir du rectangle de page couvert par l'image :
  // k = pixels affichés par pixel de page.
  const img = imgRef.current;
  const k = frame && img && img.clientWidth ? img.clientWidth / frame.w : 0;
  const c = cursor.current;

  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      onCancelActionDescription={t("captcha_close")}
      bAllowFullSize
    >
      <Focusable
        flow-children="column"
        noFocusRing
        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, ...FULL_BLEED }}
      >
        <div ref={chromeHideMarkerRef} style={{ display: "none" }} />

        <div style={{
          fontSize: 16, fontWeight: 600, textAlign: "center",
          padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.06)",
          maxWidth: 720,
        }}>{t("captcha_title")}</div>

        <div style={{ fontSize: 13, opacity: 0.75, textAlign: "center", maxWidth: 620 }}>
          {t("captcha_hint")}
        </div>

        <div style={{ position: "relative", lineHeight: 0, maxWidth: "92vw" }}>
          {frame && (
            <img
              ref={imgRef}
              src={frame.img}
              onLoad={() => forceRender((n) => n + 1)}
              onClick={(e: any) => {
                // Souris / écran tactile / pavé tactile : on vise directement.
                const f = frameRef.current;
                const el = e.currentTarget as HTMLImageElement;
                if (!f || !el.clientWidth) return;
                const kk = el.clientWidth / f.w;
                const r = el.getBoundingClientRect();
                const px = f.x + (e.clientX - r.left) / kk;
                const py = f.y + (e.clientY - r.top) / kk;
                cursor.current = { x: px, y: py };
                clickAt(px, py);
              }}
              style={{
                display: "block", maxWidth: "92vw", maxHeight: "72vh",
                borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)",
                opacity: clicking ? 0.75 : 1, transition: "opacity 120ms",
              }}
            />
          )}
          {!frame && (
            <div style={{ padding: 40, fontSize: 14, opacity: 0.6, lineHeight: 1.4 }}>
              {error ? t("captcha_unavailable") : t("captcha_loading")}
            </div>
          )}
          {frame && c && k > 0 && (
            <div
              style={{
                position: "absolute", pointerEvents: "none",
                left: (c.x - frame.x) * k, top: (c.y - frame.y) * k,
                width: 22, height: 22, marginLeft: -11, marginTop: -11,
                borderRadius: "50%",
                border: `2px solid ${ACCENT}`,
                boxShadow: "0 0 0 2px rgba(0,0,0,0.55), 0 0 10px rgba(0,0,0,0.5)",
                background: "rgba(88,101,242,0.22)",
                transform: clicking ? "scale(0.7)" : "scale(1)",
                transition: "transform 90ms",
              }}
            />
          )}
        </div>
      </Focusable>
    </ModalRootAny>
  );
}

export function openCaptchaSolver() {
  showModal(<CaptchaSolverModal />);
}
