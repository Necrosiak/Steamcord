import { useEffect, useState } from "react";
export type UiPreference = "external_links" | "swap_sources";
const listeners = new Set<() => void>();
export function readUiPreference(key: UiPreference): boolean {
  try { return localStorage.getItem("steamcord_" + key) === "true"; } catch { return false; }
}
export function setUiPreference(key: UiPreference, value: boolean) {
  try { localStorage.setItem("steamcord_" + key, String(value)); } catch { return; }
  for (const listener of listeners) listener();
}
export function useUiPreference(key: UiPreference): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => readUiPreference(key));
  useEffect(() => { const update = () => setValue(readUiPreference(key)); listeners.add(update); update(); return () => { listeners.delete(update); }; }, [key]);
  return [value, v => setUiPreference(key, v)];
}
export function sourceOrder(expanded: boolean, swap: boolean): ("servers" | "dms")[] {
  const order: ("servers" | "dms")[] = expanded ? ["dms", "servers"] : ["servers", "dms"];
  return swap ? order.reverse() : order;
}
