// Échelle du QAM. Sur Steam Deck le panneau d'accès rapide fait ~340×800 px
// CSS. En mode jeu 1440p/4K il est bien plus grand, alors que Steamcord posait
// des tailles absolues « Deck » (boutons 40px, avatars 28px) : tout paraissait
// minuscule, et le minHeight:0 de DialogButton rognait avatars et icônes.
//
// On MESURE le panneau via l'ownerDocument de l'élément (la fenêtre du contexte
// JS du plugin fait 1×1 px — même piège que useFillHeight). Jamais < 1.
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type QamUi = { scale: number; px: (n: number) => number };

const Ctx = createContext<QamUi>({ scale: 1, px: (n) => n });
export const useQamUi = () => useContext(Ctx);

const DECK_W = 340;
const DECK_H = 800;

function computeScale(w: number, innerH: number, screenH: number): number {
  let s = w / DECK_W;
  if (innerH >= 1100) s = Math.max(s, innerH / DECK_H);
  else if (screenH >= 1440 && w < 420) s = Math.max(s, screenH >= 2100 ? 1.5 : 1.28);
  if (s < 1) s = 1;
  if (s > 2.2) s = 2.2;
  return Math.round(s * 100) / 100;
}

export function QamUiRoot({ children }: { children: any }) {
  const [scale, setScale] = useState(1);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const win = el.ownerDocument?.defaultView;
    let timer: ReturnType<typeof setInterval> | null = null;
    const measure = () => {
      if (!el.isConnected) {
        win?.removeEventListener("resize", measure);
        if (timer) { clearInterval(timer); timer = null; }
        return;
      }
      const w = el.getBoundingClientRect().width;
      if (w < 80) return;
      const next = computeScale(w, win?.innerHeight || DECK_H, win?.screen?.height || DECK_H);
      setScale((prev) => (Math.abs(prev - next) < 0.03 ? prev : next));
    };
    setTimeout(measure, 0);
    setTimeout(measure, 300);
    timer = setInterval(measure, 2000);
    win?.addEventListener("resize", measure);
  }, []);
  const value = useMemo<QamUi>(() => ({
    scale,
    px: (n: number) => Math.max(1, Math.round(n * scale)),
  }), [scale]);
  return (
    <div ref={ref} style={{ fontSize: value.px(13), minWidth: 0, maxWidth: "100%" }}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </div>
  );
}
