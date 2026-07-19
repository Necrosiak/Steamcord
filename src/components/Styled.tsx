// Shared visual kit — same design language as the SkullKey / BC250-Toolkit
// plugins: focusable controls with a white halo + colored glow + a slight
// scale on gamepad focus, one accent color per section. Keeping every
// Steamcord control on this kit makes the three plugins read as one family.
import { DialogButton } from "@decky/ui";
import { useCallback, useState } from "react";

const Btn = DialogButton as any;

// Hauteur d'une liste scrollable qui remplit le QAM JUSQU'EN BAS SANS déborder,
// quelle que soit la machine : mesurée depuis la position réelle du conteneur
// (getBoundingClientRect) — un maxHeight en dur (280px historique) laissait un
// grand vide sous les listes. ⚠️ PIÈGE MESURÉ AU CDP (19/07) : le code des
// plugins Decky tourne dans le SharedJSContext dont la fenêtre fait 1×1 px —
// le `window` global est INUTILISABLE pour mesurer le QAM. Le DOM du panneau,
// lui, vit dans la fenêtre QuickAccess (766 pt de haut sur cette machine,
// unités logiques dpr≈1.28 — indépendant de la résolution physique) → on
// mesure TOUT via la fenêtre du document de l'élément (ownerDocument.
// defaultView). `bottom` : la légende manette (A/B) est HORS de la fenêtre
// QuickAccess (vérifié : scrollHeight == innerHeight == 766) → une petite
// marge de respiration suffit.
export function useFillHeight(min = 180, bottom = 12) {
  const [height, setHeight] = useState<number>(min);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const win = el.ownerDocument?.defaultView || window;
    let timer: any = null;
    const compute = () => {
      // Auto-nettoyage : les vues du QAM montent/démontent souvent, et un ref
      // callback ne repasse pas forcément par null — listener + interval se
      // retirent tout seuls dès que l'élément a quitté le DOM.
      if (!el.isConnected) {
        win.removeEventListener("resize", compute);
        if (timer) { clearInterval(timer); timer = null; }
        return;
      }
      const top = el.getBoundingClientRect().top;
      const avail = Math.floor(win.innerHeight - top - bottom);
      // Garde anti-débordement/anti-bogue : pendant une frame de layout ou
      // l'animation d'ouverture, top peut être 0/négatif (hauteur énorme) et
      // la fenêtre peut être minuscule (hauteur négative) → on n'écrit que des
      // mesures plausibles et on retentera au prochain tick.
      if (top <= 0 || avail <= 0) return;
      setHeight(avail > min ? avail : min);
    };
    // Au montage le QAM anime encore son ouverture → plusieurs passes, puis
    // re-mesure périodique : si le contenu AU-DESSUS de la liste change de
    // hauteur (bannière d'erreur, boutons contextuels), la liste se recale.
    setTimeout(compute, 0);
    setTimeout(compute, 300);
    timer = setInterval(compute, 1500);
    win.addEventListener("resize", compute);
  }, []);
  return { ref, height };
}

// Discord blurple — Steamcord's primary accent.
export const ACCENT = "#5865f2";
// Semantic section colors reused across the panel.
export const DANGER = "#ed4245";   // stop / disconnect / logout
export const ONLINE = "#23a55a";   // active / online

// The Steam DialogButton's native focus paints a light background + dark text
// → our forced-white text becomes unreadable. Every control drives its own
// focus instead: white ring + colored glow + a slight pop. `focusHalo` is the
// single source of truth for that look, spread into a control's style.
export function focusHalo(color: string, focused: boolean, scale = 1.02) {
  const c = color || ACCENT;
  return {
    boxShadow: focused ? `0 0 0 2px #fff, 0 0 8px 1px ${c}` : "none",
    transform: focused ? `scale(${scale})` : "scale(1)",
    transition: "box-shadow .08s ease, transform .08s ease",
    // position:relative makes zIndex effective so a focused control (and its
    // glow) lifts above tightly-packed flex siblings instead of being overpainted.
    position: "relative" as const,
    zIndex: focused ? 1 : 0,
  };
}

// Clickable card: colored background when active, white halo + colored glow on
// gamepad focus. Mirrors SkullKey's CardBtn.
export function CardBtn({ active, focused, color, disabled, center, big, onClick, onFocus, onBlur, children }: any) {
  const c = color || ACCENT;
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{
        display: "flex", alignItems: "center", justifyContent: center ? "center" : "flex-start",
        gap: 8, width: "100%", minWidth: 0,
        padding: big ? "12px 14px" : "7px 10px", margin: 0, minHeight: 0, boxSizing: "border-box",
        borderRadius: 6, color: "#fff", fontSize: big ? 14 : 12, fontWeight: active ? 700 : 400,
        background: active ? c : "rgba(255,255,255,0.05)",
        border: active ? "1px solid " + c : "1px solid transparent",
        opacity: disabled ? 0.5 : 1,
        ...focusHalo(c, focused),
      }}
    >
      {children}
    </Btn>
  );
}

// Self-focused CardBtn for isolated actions (owns its focus state).
export function ActionCard({ color, active, disabled, center, big, onClick, children }: any) {
  const [focused, setFocused] = useState(false);
  return (
    <CardBtn
      color={color}
      active={active}
      disabled={disabled}
      focused={focused}
      center={center !== false}
      big={big}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {children}
    </CardBtn>
  );
}

// Square icon button (voice toolbar) with the same halo treatment. `active`
// paints the accent as a solid background (e.g. muted/live state).
export function IconBtn({ color, active, disabled, title, onClick, children }: any) {
  const [focused, setFocused] = useState(false);
  const c = color || ACCENT;
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      title={title}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        height: 40, width: 44, minWidth: 44, padding: 0, margin: 0, boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
        borderRadius: 6, color: "#fff",
        background: active ? c : "rgba(255,255,255,0.06)",
        opacity: disabled ? 0.5 : 1,
        ...focusHalo(c, focused, 1.06),
      }}
    >
      {children}
    </Btn>
  );
}
