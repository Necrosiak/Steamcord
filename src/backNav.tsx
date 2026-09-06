// B/annuler HIÉRARCHIQUE dans le QAM : on remonte d'UN menu à la fois
// (salon ouvert → liste des salons → serveurs repliés → appel, etc.) jusqu'au
// haut de Steamcord, après quoi Steam referme le panneau comme d'habitude.
import { Focusable } from "@decky/ui";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { t } from "./i18n";

type Handler = () => boolean;

const Ctx = createContext<{
  push: (h: Handler) => () => void;
  depth: number;
}>({ push: () => () => {}, depth: 0 });

export function useBackHandler(handler: Handler, active = true) {
  const { push } = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return push(() => ref.current());
  }, [active, push]);
}

export function BackNavRoot({ children }: { children: any }) {
  const stack = useRef<Handler[]>([]);
  const [depth, setDepth] = useState(0);
  const push = useCallback((h: Handler) => {
    stack.current.push(h);
    setDepth(stack.current.length);
    return () => {
      const i = stack.current.lastIndexOf(h);
      if (i >= 0) stack.current.splice(i, 1);
      setDepth(stack.current.length);
    };
  }, []);

  const onCancel = (e?: any) => {
    const h = stack.current[stack.current.length - 1];
    if (h && h()) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      e?.stopImmediatePropagation?.();
      return true;
    }
    return false;
  };

  // vgp_oncancel est l'événement que Steam émet RÉELLEMENT pour B. Les props
  // FooterLegend sur un Focusable enveloppant ne sont pas toujours câblées dans
  // le QAM (même piège que ChatFullscreen) : on écoute donc aussi le vrai nœud
  // DOM en capture.
  const attach = (el: HTMLDivElement | null) => {
    if (!el || (el as any).__scBackNav) return;
    (el as any).__scBackNav = true;
    el.addEventListener("vgp_oncancel", (e: Event) => {
      if (onCancel(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  };

  return (
    <Ctx.Provider value={{ push, depth }}>
      <Focusable
        noFocusRing
        onCancel={onCancel}
        onCancelButton={onCancel}
        onButtonDown={(e: any) => { if (e?.detail?.button === 2) onCancel(e); }}
        onCancelActionDescription={depth > 0 ? t("nav_back") : undefined}
        style={{ minWidth: 0 }}
      >
        <div ref={attach}>{children}</div>
      </Focusable>
    </Ctx.Provider>
  );
}
