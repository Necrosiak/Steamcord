// Host platform + feature flags for the Quick Access Menu.
//
// One Steamcord zip runs on the Steam Deck (Linux) and in Steam Big Picture on
// Windows (Decky Loader for Windows). The backend knows which one it is on and
// which features exist there (`get_platform_caps`, backed by sc_platform.py);
// this module mirrors that for the UI so controls that cannot work - PipeWire audio
// routing, the virtual camera, the GTK overlay, evdev shortcuts - are not offered.
//
// The answer is needed synchronously during render, so it starts from a guess
// taken from the user agent (Steam's CEF reports "Windows" on Windows) and is
// replaced by the backend's authoritative answer as soon as that arrives. On the
// Deck the guess is "linux" with every feature on, i.e. exactly the old behaviour.

import { call } from "@decky/api";

export type PlatformInfo = {
  os: "linux" | "windows";
  caps: Record<string, boolean>;
};

// Keep in sync with sc_platform._LINUX_ONLY / _BOTH.
const LINUX_ONLY = [
  "audio_routing",
  "game_audio_share",
  "chat_mix",
  "virtual_camera",
  "gamescope_preview",
  "pov_overlay",
  "keep_awake",
  "controller_shortcut",
  "desktop_mode_options",
  "portal_shim",
];
const BOTH = [
  "voice", "text_chat", "direct_messages", "qr_login", "notifications",
  "rich_presence", "screen_share", "clips", "multi_account", "soundboard",
];

function build(os: "linux" | "windows"): PlatformInfo {
  const caps: Record<string, boolean> = {};
  for (const k of BOTH) caps[k] = true;
  for (const k of LINUX_ONLY) caps[k] = os === "linux";
  return { os, caps };
}

function guessOs(): "linux" | "windows" {
  try {
    return /Windows/i.test(navigator.userAgent) ? "windows" : "linux";
  } catch {
    return "linux";
  }
}

let info: PlatformInfo = build(guessOs());
let loading: Promise<PlatformInfo> | null = null;

export const platform = (): PlatformInfo => info;
export const isWindows = (): boolean => info.os === "windows";
/** A feature is on unless the platform says it is off (unknown names stay on). */
export const hasCap = (name: string): boolean => info.caps[name] !== false;

/** Ask the backend once; keeps the UA guess if the backend does not answer. */
export function loadPlatform(): Promise<PlatformInfo> {
  if (!loading) {
    loading = call<[], { os?: string; caps?: Record<string, boolean> }>("get_platform_caps")
      .then((r) => {
        if (r && (r.os === "windows" || r.os === "linux")) {
          info = { os: r.os, caps: { ...build(r.os).caps, ...(r.caps || {}) } };
        }
        return info;
      })
      .catch(() => info);
  }
  return loading;
}
