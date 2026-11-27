// Shared menu contract v1. Keep identical across the three plugins.
// One owner patches Steam; entries are registered and removed independently.
import { createElement } from "react";
import { afterPatch, findInReactTree, getReactRoot } from "@decky/ui";

type Entry = { id: string; label: string; route: string; icon: any; order: number; onSecondary?: () => void };
type State = { entries: Map<string, Entry>; dispose?: () => void; timer?: any; revision?: number; implementation?: string; status?: string };
const REVISION = 3;
const IMPLEMENTATION = "stable-types-v2";
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
  let active = true;
  const types = new WeakMap<Function, Function>();
  const wrapped = new WeakSet<Function>();
  const roots = [parent, parent.alternate].filter(Boolean);
  const marker = Symbol.for("necroSteamMenu.wrapper.v2");
  // React copies type into alternate fibers. Remove our wrappers from both
  // live chains, including copies that Decky's patch.object no longer owns.
  // Leave foreign wrappers in place and only edit their original link.
  const strip = (fiber: any, legacy = false) => {
    let object = fiber, key = "type";
    const seen = new Set<Function>();
    while (typeof object?.[key] === "function" && !seen.has(object[key])) {
      const fn = object[key]; seen.add(fn);
      const patch = fn.__deckyPatch;
      const ours = Object.prototype.hasOwnProperty.call(fn, marker);
      const old = legacy && patch && roots.includes(patch.object) && patch.property === "type"
        && /^\(_args,\s*ret\)\s*=>\s*inspect\(ret\)$/.test(Function.prototype.toString.call(patch.handler).trim());
      if ((ours || old) && patch) { object[key] = patch.original; continue; }
      if (!patch) break;
      object = patch; key = "original";
    }
  };
  for (const fiber of roots) strip(fiber, true);
  const arrays = new Set<any[]>();
  const elements = new Set<any>();
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
    if (!active || renderItems(output)) return output;
    // Steam has changed this wrapper shape before. Search the rendered tree,
    // not a fixed children[0] path. Never execute a React component ourselves.
    const element: any = findInReactTree(output, (n: any) =>
      n && typeof n.type === "function" && !wrapped.has(n.type));
    if (element) {
      element.type = wrap(element.type);
      elements.add(element);
      if (elements.size > 64) elements.delete(elements.values().next().value);
    }
    if (!element && !findInReactTree(output, (n: any) => n && wrapped.has(n.type)) && s.status !== "unavailable") {
      s.status = "unavailable";
      console.warn("[Steam menu] rendered menu shape unavailable; Decky QAM remains available");
    }
    return output;
  };
  const wrap = (original: any): any => {
    if (wrapped.has(original)) return original;
    const cached = types.get(original);
    if (cached) return cached;
    // Patch a private holder once per component type, never each render's
    // fresh React element. Stable type identity preserves focus and state.
    const holder = { type: original };
    afterPatch(holder, "type", (_args, ret) => inspect(ret));
    Object.defineProperty(holder.type, marker, { value: true });
    types.set(original, holder.type); wrapped.add(holder.type);
    return holder.type;
  };
  for (const fiber of roots) fiber.type = wrap(fiber.type);
  s.status = "waiting-render";
  s.dispose = () => {
    active = false;
    for (const fiber of roots) strip(fiber);
    for (const element of elements) strip(element);
    elements.clear();
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
