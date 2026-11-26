// Shared menu contract v1. Keep identical across the three plugins.
// One owner patches Steam; entries are registered and removed independently.
import { createElement } from "react";
import { afterPatch, findInReactTree, getReactRoot } from "@decky/ui";

type Entry = { id: string; label: string; route: string; icon: any; order: number; onSecondary?: () => void };
type State = { entries: Map<string, Entry>; dispose?: () => void; timer?: any; revision?: number; implementation?: string; status?: string };
const REVISION = 3;
const IMPLEMENTATION = "decky-patch-v1";
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
  const parent = node.return;
  const patches: { object?: object; unpatch: () => void; hasUnpatched?: boolean }[] = [];
  const rootCount = parent.alternate && typeof parent.alternate.type === "function" ? 2 : 1;
  const patched = new WeakSet<object>();
  const arrays = new Set<any[]>();
  const isItem = (e: any) => e?.props?.label && (e.props.onFocus || e.props.onGamepadFocus) && e.props.route;
  const renderItems = (output: any): boolean => {
    const items: any = findInReactTree(output, (n: any) => Array.isArray(n) && n.some(isItem));
    if (!Array.isArray(items)) return false;
    arrays.add(items);
    if (arrays.size > 32) { const oldest = arrays.values().next().value; if (oldest) arrays.delete(oldest); }
    for (let i = items.length - 1; i >= 0; i--) if (ownedItem(items[i])) items.splice(i, 1);
    const template = items.find(isItem);
    if (!template) return false;
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
    s.status = "ready";
    return true;
  };
  const inspect = (output: any) => {
    if (renderItems(output)) return output;
    // Steam has changed this wrapper shape before. Search the rendered tree,
    // not a fixed children[0] path. Never execute a React component ourselves.
    const element: any = findInReactTree(output, (n: any) =>
      n && typeof n.type === "function" && !patched.has(n));
    if (element) {
      // Bound retained render elements without giving up after many redraws.
      if (patches.length >= 64) {
        const retired = patches.splice(rootCount, 1)[0];
        if (retired) {
          if (!retired.hasUnpatched) retired.unpatch();
          if (retired.object) patched.delete(retired.object);
        }
      }
      patched.add(element);
      patches.push(afterPatch(element, "type", (_args, ret) => inspect(ret)));
    }
    if (!element && !findInReactTree(output, (n: any) => n && typeof n === "object" && patched.has(n)) && s.status !== "unavailable") {
      s.status = "unavailable";
      console.warn("[Steam menu] rendered menu shape unavailable; Decky QAM remains available");
    }
    return output;
  };
  try {
    patches.push(afterPatch(parent, "type", (_args, ret) => inspect(ret)));
    if (parent.alternate && typeof parent.alternate.type === "function")
      patches.push(afterPatch(parent.alternate, "type", (_args, ret) => inspect(ret)));
  } catch (error) {
    for (const patch of patches.reverse()) if (!patch.hasUnpatched) patch.unpatch();
    throw error;
  }
  s.status = "waiting-render";
  s.dispose = () => {
    for (const patch of patches.reverse()) {
      try { if (!patch.hasUnpatched) patch.unpatch(); }
      catch (error) { console.warn("[Steam menu] patch cleanup failed", error); }
    }
    patches.length = 0;
    for (const items of arrays) for (let i = items.length - 1; i >= 0; i--)
      if (ownedItem(items[i])) items.splice(i, 1);
    arrays.clear();
    s.status = "inactive";
  };
  return true;
}

export function registerSteamMenu(entry: Entry): () => void {
  const s = state();
  // The owner can outlive its plugin while siblings remain loaded. Replace an
  // older implementation without losing their entries during an update.
  if (s.revision !== REVISION || s.implementation !== IMPLEMENTATION) {
    clearInterval(s.timer); s.timer = undefined;
    s.dispose?.(); s.dispose = undefined;
    s.revision = REVISION; s.implementation = IMPLEMENTATION;
  }
  s.entries.set(entry.id, entry);
  if (!s.dispose && !s.timer) {
    let attempts = 0;
    const attempt = () => {
      try { if (install(s)) { clearInterval(s.timer); s.timer = undefined; return; } }
      catch (error) { console.debug("[Steam menu] integration unavailable", error); }
      if (++attempts >= 30) {
        clearInterval(s.timer); s.timer = undefined; s.status = "unavailable";
        console.warn("[Steam menu] entry unavailable on this Steam build; Decky QAM remains available");
      }
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

export function steamMenuStatus(): string {
  return state().status || "inactive";
}
