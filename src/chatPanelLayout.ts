import { useCallback, useState } from "react";

// Measures in the element's own window, not SharedJSContext's 1px viewport.
// Account for theme transforms/zoom and ancestor scroll: scrolling must not
// make the panel grow and push the composer further down on every measurement.
export function chatPanelHeight(el: HTMLElement): number {
  const win = el.ownerDocument.defaultView;
  if (!win) return 180;
  const rect = el.getBoundingClientRect();
  const scale = el.offsetHeight > 0 && rect.height > 0 ? rect.height / el.offsetHeight : 1;
  if (!Number.isFinite(scale) || scale <= 0) return 180;
  let top = rect.top;
  const viewport = win.visualViewport;
  let bottom = Math.min(win.innerHeight, viewport ? viewport.offsetTop + viewport.height : win.innerHeight) - 12;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY)) {
      const r = parent.getBoundingClientRect();
      top += parent.scrollTop * scale;
      bottom = Math.min(bottom, r.top + parent.clientHeight * scale - 8);
    }
  }
  // If Steam's keyboard leaves too little room, keep the header/composer
  // usable and let the outer panel scroll; never collapse the input to zero.
  let chrome = 0;
  for (const child of Array.from(el.children || [])) {
    if (child.hasAttribute("data-sc-chat-messages")) continue;
    const style = win.getComputedStyle(child);
    chrome += child.getBoundingClientRect().height / scale
      + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  }
  return Math.max(Math.ceil(chrome), 0, Math.floor((bottom - top) / scale));
}

export function useChatPanelHeight() {
  const [height, setHeight] = useState(180);
  const [cleanup] = useState(() => ({ current: () => {} }));
  const ref = useCallback((el: HTMLDivElement | null) => {
    cleanup.current();
    cleanup.current = () => {};
    if (!el) return;
    const win = el.ownerDocument.defaultView;
    if (!win) return;
    const measure = () => { if (el.isConnected) setHeight(chatPanelHeight(el)); };
    measure();
    const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(measure) : null;
    observer?.observe(el);
    win.addEventListener("resize", measure);
    win.visualViewport?.addEventListener("resize", measure);
    const timer = win.setInterval(measure, 1500);
    cleanup.current = () => {
      observer?.disconnect(); win.clearInterval(timer);
      win.removeEventListener("resize", measure);
      win.visualViewport?.removeEventListener("resize", measure);
    };
  }, [cleanup]);
  return { ref, height };
}
