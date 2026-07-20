// Raccourci manette VOCAL (global, survit à la fermeture du QAM) : mute-toggle
// ou push-to-talk sur une combinaison de boutons capturée par le user.
// API : SteamClient.Input.RegisterForControllerInputMessages. Sa signature a
// CHANGÉ entre builds Steam (issue #14, capture morte) : anciens builds =
// callback([{nA: id bouton, bS: pressé}]) ; builds récents = callback
// positionnel (controllerIdx, buttonId, pressed, …) — vérifié dans le bundle
// steamui (HandleControllerInputMessages(e,t,r,…)). L'espace d'ids est le même
// enum EGamepadButton dans les deux cas (32=L5, 33=R5 inchangés). On gère les
// deux formes ; RegisterForControllerStateChanges reste en dernier fallback.
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

// Noms de l'enum EGamepadButton (extraits du bundle steamui ; 32/33 aussi
// vérifiés par l'ancien code Deckcord). Les autres s'affichent « BTN<n> » :
// la capture rend le nom accessoire.
const BUTTON_NAMES: Record<number, string> = {
  0: "A", 1: "B", 2: "X", 3: "Y",
  4: "D-Up", 5: "D-Right", 6: "D-Down", 7: "D-Left",
  8: "Menu", 9: "View",
  28: "LT", 29: "RT", 30: "LB", 31: "RB",
  32: "L5", 33: "R5", 34: "Guide", 35: "Select", 36: "Start",
  37: "L-Pad", 39: "R-Pad", 44: "L4", 45: "R4",
};

export function buttonsLabel(ids: number[]): string {
  return ids.map((b) => BUTTON_NAMES[b] || `BTN${b}`).join(" + ");
}

let cfg: ShortcutCfg = { ...DEFAULT_CFG };
let comboHeld = false;                    // état précédent (détection de front)
const held = new Set<number>();           // boutons actuellement pressés
let capturing: ((r: { buttons: number[]; label: string }) => void) | null = null;
let captureAcc = new Set<number>();
// Le A qui clique « Définir » génère ses events down/up APRÈS le démarrage de
// la capture → sans garde-fou il validait l'accord à lui tout seul (retour
// user 20/07). Deux protections : une période de grâce (events du clic
// ignorés) + l'exclusion des boutons déjà tenus au démarrage (cas où le down
// du A est traité AVANT le début de la capture).
const CAPTURE_GRACE_MS = 250;
let captureStartTs = 0;
let capturePreHeld = new Set<number>();

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
    captureStartTs = Date.now();
    capturePreHeld = new Set(held);
    capturing = resolve;
  });
}
export function cancelCapture() { capturing = null; }

// Un événement bouton individuel (down/up). Pendant une capture : un down
// dans la grâce ou d'un bouton pré-tenu = le clic « Définir » → exclu ; un
// down hors grâce s'accumule ; l'accord se valide au relâchement complet.
function onButtonEvent(btn: number, down: boolean) {
  if (down) held.add(btn); else held.delete(btn);
  if (capturing) {
    if (down) {
      if (Date.now() - captureStartTs < CAPTURE_GRACE_MS || capturePreHeld.has(btn)) {
        capturePreHeld.add(btn);
      } else {
        captureAcc.add(btn);
      }
    } else {
      // Relâché = plus exclu : le user peut re-binder A au même passage.
      capturePreHeld.delete(btn);
      if (captureAcc.size && held.size === 0) {
        const done = capturing;
        capturing = null;
        const buttons = [...captureAcc].sort((a, b) => a - b);
        done({ buttons, label: buttonsLabel(buttons) });
      }
    }
    return;
  }
  onCombo();
}

function onCombo() {
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
      Input.RegisterForControllerInputMessages((...args: any[]) => {
        try {
          const first = args[0];
          if (Array.isArray(first)) {
            // ancien build : un tableau d'événements {nA, bS}
            for (const e of first) {
              if (typeof e?.nA !== "number") continue;
              onButtonEvent(e.nA, !!e.bS);
            }
          } else if (typeof args[1] === "number") {
            // build récent : (controllerIdx, buttonId, pressed, …)
            onButtonEvent(args[1], !!args[2]);
          }
        } catch { }
      });
    } else if (typeof Input?.RegisterForControllerStateChanges === "function") {
      // fallback bitmasks (builds Steam où l'API messages n'existe pas/plus) :
      // on diffe l'état complet pour retomber sur des events par-bouton.
      Input.RegisterForControllerStateChanges((changes: any[]) => {
        try {
          const next = new Set<number>();
          for (const c of changes) {
            const lo = c.ulButtons >>> 0, hi = c.ulUpperButtons >>> 0;
            for (let b = 0; b < 32; b++) {
              if (lo & (1 << b)) next.add(b);
              if (hi & (1 << b)) next.add(b + 32);
            }
          }
          for (const b of [...held]) if (!next.has(b)) onButtonEvent(b, false);
          for (const b of next) if (!held.has(b)) onButtonEvent(b, true);
        } catch { }
      });
    } else {
      console.warn("[Steamcord] no controller input API available");
    }
  } catch (e) {
    console.warn("[Steamcord] controller listener failed:", e);
  }
}
