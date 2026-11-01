// Shared menu contract v1. Keep identical across the three plugins.
// One owner patches Steam; entries are registered and removed independently.
import { createElement } from "react";
import { findInReactTree, getReactRoot } from "@decky/ui";

type Entry = { id: string; label: string; route: string; icon: any; order: number; onSecondary?: () => void };
type State = { entries: Map<string, Entry>; dispose?: () => void; timer?: any; revision?: number };
const REVISION = 3;
const KEY = "__necroSteamMenuV1";
const state = (): State => ((window as any)[KEY] ||= { entries: new Map() });

function ownedItem(item: any): boolean {
  const key = String(item?.key || "");
  return key.startsWith("necro-menu:") || (key === "steamcord" && item?.props?.route === "/discord");
}
function install(s: State): boolean {
  const root = document.getElementById("root");
  if (!root) return false;
  const node: any = findInReactTree(getReactRoot(root as any),
    (n: any) => n?.memoizedProps?.navID === "MainNavMenuContainer");
  if (!node?.return?.type || typeof node.return.type !== "function") return false;
  const parent = node.return, original = parent.type;
  let innerOriginal: any, innerWrapper: any;
  const elements = new Set<any>();
  const arrays = new Set<any[]>();
  const wrapper = function(this: any, ...args: any[]) {
    const result = original.apply(this, args);
    const element = result?.props?.children?.props?.children?.[0];
    if (!element?.type || typeof element.type !== "function") return result;
    if (!innerWrapper) {
      innerOriginal = element.type;
      innerWrapper = function(this: any, ...innerArgs: any[]) {
        const output = innerOriginal.apply(this, innerArgs);
        const isItem = (e: any) => e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus) && e.props.route;
        const items: any = findInReactTree(output,
          (n: any) => Array.isArray(n) && n.some(isItem));
        if (!Array.isArray(items)) return output;
        arrays.add(items); if (arrays.size > 32) { const oldest = arrays.values().next().value; if (oldest) arrays.delete(oldest); }
        // Steam may reuse the children array on a subsequent render.
        for (let i = items.length - 1; i >= 0; i--)
          if (ownedItem(items[i])) items.splice(i, 1);
        const template = items.find(isItem);
        if (!template) return output;
        const entries = [...s.entries.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        let position = 3;
        try { position = Number(localStorage.getItem("STEAMCORD_MENU_POSITION") || 3); } catch {}
        if (!Number.isFinite(position) || position < 1 || position > 9) position = 3;
        const indexes = items.flatMap((e: any, i: number) => isItem(e) ? [i] : []);
        const index = position === 9 ? indexes[indexes.length - 1] + 1 : (indexes[position - 1] ?? indexes[indexes.length - 1] + 1);
        items.splice(index, 0, ...entries.map(entry => createElement(template.type, {
          key: "necro-menu:" + entry.id, route: entry.route, label: entry.label,
          ...(template.props.onGamepadFocus ? { onGamepadFocus: template.props.onGamepadFocus } : { onFocus: template.props.onFocus }),
          ...(entry.onSecondary ? { onSecondaryActionDescription: "Change Position", onSecondaryButton: entry.onSecondary } : {}),
          ...(template.props.icon ? { icon: entry.icon } : { children: entry.icon }),
        })));
        return output;
      };
    }
    if (element.type === innerOriginal) { element.type = innerWrapper; elements.add(element); if (elements.size > 32) elements.delete(elements.values().next().value); }
    return result;
  };
  parent.type = wrapper;
  if (parent.alternate) parent.alternate.type = wrapper;
  s.dispose = () => {
    if (parent.type === wrapper) parent.type = original;
    if (parent.alternate?.type === wrapper) parent.alternate.type = original;
    for (const el of elements) if (el.type === innerWrapper) el.type = innerOriginal;
    elements.clear();
    for (const items of arrays) for (let i = items.length - 1; i >= 0; i--)
      if (ownedItem(items[i])) items.splice(i, 1);
    arrays.clear();
  };
  return true;
}

export function registerSteamMenu(entry: Entry): () => void {
  const s = state();
  // The owner can outlive its plugin while siblings remain loaded. Replace an
  // older implementation without losing their entries during an update.
  if (s.revision !== REVISION) {
    clearInterval(s.timer); s.timer = undefined;
    s.dispose?.(); s.dispose = undefined;
    s.revision = REVISION;
  }
  s.entries.set(entry.id, entry);
  if (!s.dispose && !s.timer) {
    let attempts = 0;
    const attempt = () => {
      try { if (install(s)) { clearInterval(s.timer); s.timer = undefined; return; } }
      catch (error) { console.debug("[Steam menu] integration unavailable", error); }
      if (++attempts >= 30) { clearInterval(s.timer); s.timer = undefined; }
    };
    s.timer = setInterval(attempt, 2000);
    attempt();
  }
  return () => {
    // A previous instance must not unregister its replacement after a reload.
    if (s.entries.get(entry.id) !== entry) return;
    s.entries.delete(entry.id);
    if (s.entries.size) return;
    clearInterval(s.timer); s.timer = undefined;
    s.dispose?.(); s.dispose = undefined;
  };
}
