// Raccourci manette VOCAL (global, survit à la fermeture du QAM) : mute-toggle
// ou push-to-talk sur une combinaison de boutons capturée par le user.
// API : SteamClient.Input.RegisterForControllerInputMessages (événements
// {nA: id bouton, bS: pressé} — seule dispo sur ce build Steam, vérifié CDP ;
// RegisterForControllerStateChanges est undefined ici, gardé en fallback).
// Le backend a déjà set_ptt/enable_ptt ($ptt/$setptt côté client Discord)
// et toggle_mute — on ne fait que les piloter depuis les boutons.
import { call } from "@decky/api";
import { notify } from "./notify";
import { t } from "./i18n";

export type ShortcutCfg = {
  enabled: boolean;
  mode: "toggle" | "ptt";
  buttons: number[];  // ids nA de l'accord
  label: string;
};

export const DEFAULT_CFG: ShortcutCfg =
  { enabled: false, mode: "toggle", buttons: [], label: "" };

// Noms connus des ids nA (peu documentés — 32/33 vérifiés par l'ancien code
// Deckcord). Les autres s'affichent « BTN<n> » : la capture rend le nom accessoire.
const BUTTON_NAMES: Record<number, string> = { 32: "L5", 33: "R5" };

export function buttonsLabel(ids: number[]): string {
  return ids.map((b) => BUTTON_NAMES[b] || `BTN${b}`).join(" + ");
}

let cfg: ShortcutCfg = { ...DEFAULT_CFG };
let comboHeld = false;                    // état précédent (détection de front)
const held = new Set<number>();           // boutons actuellement pressés
let capturing: ((r: { buttons: number[]; label: string }) => void) | null = null;
let captureAcc = new Set<number>();

// Le mode PTT de Discord (AUDIO_SET_MODE) doit refléter le réglage — ré-asserté
// à l'init et à chaque changement ; silencieux si le client n'est pas encore là.
function applyPttMode() {
  call("enable_ptt", cfg.enabled && cfg.mode === "ptt").catch(() => {});
}

export function getShortcutCfg(): ShortcutCfg { return cfg; }

export async function setShortcutCfg(next: ShortcutCfg) {
  const pttWasOn = cfg.enabled && cfg.mode === "ptt";
  cfg = next;
  await call("set_voice_shortcut", cfg as any).catch(() => {});
  if (pttWasOn && !(cfg.enabled && cfg.mode === "ptt"))
    call("set_ptt", false).catch(() => {});
  applyPttMode();
}

// Capture du prochain accord : accumule les boutons pressés, se termine au
// relâchement complet.
export function captureBinding(): Promise<{ buttons: number[]; label: string }> {
  return new Promise((resolve) => {
    captureAcc = new Set();
    capturing = resolve;
  });
}
export function cancelCapture() { capturing = null; }

function onChange() {
  if (capturing) {
    held.forEach((b) => captureAcc.add(b));
    if (captureAcc.size && held.size === 0) {
      const done = capturing;
      capturing = null;
      const buttons = [...captureAcc].sort((a, b) => a - b);
      done({ buttons, label: buttonsLabel(buttons) });
    }
    return;
  }

  if (!cfg.enabled || !cfg.buttons.length) return;
  const active = cfg.buttons.every((b) => held.has(b));
  if (active && !comboHeld) {
    if (cfg.mode === "toggle") {
      call("toggle_mute").catch(() => {});
      // L'état settled arrive par l'écho Discord → petit délai avant lecture.
      setTimeout(() => {
        call<[], any>("get_state").then((s) => {
          notify({ title: "Steamcord", body: s?.me?.is_muted ? `🔇 ${t("mic_muted")}` : `🎙️ ${t("mic_unmuted")}` });
        }).catch(() => {});
      }, 600);
    } else {
      call("set_ptt", true).catch(() => {});
    }
  } else if (!active && comboHeld && cfg.mode === "ptt") {
    call("set_ptt", false).catch(() => {});
  }
  comboHeld = active;
}

export function initVoiceShortcut() {
  call<[], ShortcutCfg>("get_voice_shortcut")
    .then((c) => { cfg = { ...DEFAULT_CFG, ...(c || {}) }; applyPttMode(); })
    .catch(() => {});
  const Input = (window as any).SteamClient?.Input;
  try {
    if (typeof Input?.RegisterForControllerInputMessages === "function") {
      Input.RegisterForControllerInputMessages((events: any[]) => {
        try {
          for (const e of events) {
            if (typeof e?.nA !== "number") continue;
            if (e.bS) held.add(e.nA); else held.delete(e.nA);
          }
          onChange();
        } catch { }
      });
    } else if (typeof Input?.RegisterForControllerStateChanges === "function") {
      // fallback bitmasks (builds Steam où l'API messages n'existe pas/plus)
      Input.RegisterForControllerStateChanges((changes: any[]) => {
        try {
          held.clear();
          for (const c of changes) {
            const lo = c.ulButtons >>> 0, hi = c.ulUpperButtons >>> 0;
            for (let b = 0; b < 32; b++) {
              if (lo & (1 << b)) held.add(b);
              if (hi & (1 << b)) held.add(b + 32);
            }
          }
          onChange();
        } catch { }
      });
    } else {
      console.warn("[Steamcord] no controller input API available");
    }
  } catch (e) {
    console.warn("[Steamcord] controller listener failed:", e);
  }
}
