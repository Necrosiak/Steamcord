import { call } from "@decky/api";
import { ReactNode, useEffect, useState } from "react";

export type HostFeatureName = "audio_routing" | "game_audio_share" | "chat_mix" |
  "virtual_camera" | "stream_preview" | "overlay" | "keep_awake" |
  "controller_shortcut" | "desktop_mode";

const linuxFeatures: HostFeatureName[] = ["audio_routing", "game_audio_share", "chat_mix",
  "virtual_camera", "stream_preview", "overlay", "keep_awake", "controller_shortcut", "desktop_mode"];
let windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
let features: Partial<Record<HostFeatureName, boolean>> = {};
const listeners = new Set<() => void>();
let pending: Promise<void> | undefined;

export const onWindows = () => windows;
export const supports = (name: HostFeatureName) => features[name] ?? !windows;

// The backend is authoritative. User agent detection keeps unavailable controls
// hidden during the first render, before the response arrives.
export function initHost(): Promise<void> {
  if (!pending) pending = call<[], { os: string; features: Record<string, boolean> }>("get_host")
    .then((host) => {
      if (!host || (host.os !== "windows" && host.os !== "linux")) return;
      windows = host.os === "windows";
      features = {};
      for (const name of linuxFeatures) {
        if (typeof host.features?.[name] === "boolean") features[name] = host.features[name];
      }
      listeners.forEach((notify) => notify());
    }).catch(() => { pending = undefined; });
  return pending;
}

export function useHost() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const notify = () => refresh((n) => n + 1);
    listeners.add(notify);
    // The RPC can finish between render and this subscription. Repaint once
    // after subscribing so a fast response cannot leave a Windows gate hidden.
    notify();
    initHost();
    return () => { listeners.delete(notify); };
  }, []);
  return { onWindows: windows, supports };
}

// Keep feature-specific hooks inside the child. An unavailable component never
// mounts, so it cannot poll Linux helpers from either QAM or expanded view.
export function HostFeature({ name, children }: { name: HostFeatureName; children: ReactNode }) {
  const host = useHost();
  return host.supports(name) ? <>{children}</> : null;
}
