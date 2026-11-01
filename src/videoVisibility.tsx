import { call } from "@decky/api";
import { useEffect, useRef } from "react";

// Visibility belongs to the document rendering the video, not the hidden plugin
// window. The QAM and expanded/fullscreen views contribute independent leases.
const surfaces = new Map<object, string[]>();
let timer: ReturnType<typeof setInterval> | undefined;
let pending: ReturnType<typeof setTimeout> | undefined;
let enabled = false;
let running = false;
let serial: Promise<unknown> = Promise.resolve();
function publish() {
  const users = [...new Set([...surfaces.values()].flat())].sort();
  const active = enabled;
  // Serialize publications: a delayed older request must not reopen a stream
  // after the last visible surface has closed.
  serial = serial.catch(() => {}).then(() => call("set_video_visibility", users, active)).catch(() => {});
}
function schedule() {
  if (pending !== undefined) clearTimeout(pending);
  pending = setTimeout(() => { pending = undefined; if (running) publish(); }, 0);
}
export function startVideoVisibility() {
  if (running) return;
  running = true;
  const refresh = async () => {
    try {
      const env = await call<[], { env: string }>("get_share_env");
      if (!running) return;
      // Game Mode and Windows Big Picture: the Discord window is hidden, so a
      // stream nobody watches in Steamcord must not play. Linux Desktop Mode
      // keeps Vesktop visible and its own controls.
      enabled = env?.env === "gamescope" || env?.env === "windows";
      publish();
    } catch { /* Keep a known policy during a transient backend disconnect. */ }
  };
  refresh();
  timer = setInterval(refresh, 15000);
}
export function stopVideoVisibility() {
  running = false; enabled = false;
  if (timer !== undefined) clearInterval(timer);
  if (pending !== undefined) clearTimeout(pending);
  timer = undefined; pending = undefined;
  surfaces.clear(); publish();
}
export function VideoVisibility({ users }: { users: string[] }) {
  const marker = useRef<HTMLSpanElement>(null);
  const signature = [...new Set(users)].sort().join(",");
  useEffect(() => {
    const token = {}, document = marker.current?.ownerDocument;
    if (!document) return;
    const update = () => {
      if (!document.hidden) surfaces.set(token, signature ? signature.split(",") : []);
      else surfaces.delete(token);
      schedule();
    };
    document.addEventListener("visibilitychange", update);
    update();
    return () => { document.removeEventListener("visibilitychange", update); surfaces.delete(token); schedule(); };
  }, [signature]);
  return <span ref={marker} style={{ display: "none" }} />;
}
