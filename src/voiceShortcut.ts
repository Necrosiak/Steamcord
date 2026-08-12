// Raccourci VOCAL global (survit à la fermeture du QAM) : mute-toggle ou
// push-to-talk, sur une combinaison de boutons de MANETTE, une touche de CLAVIER
// ou un bouton de SOURIS.
//
// Répartition (et pourquoi) :
//   * MANETTE → ici, via SteamClient.Input.RegisterForControllerInputMessages.
//     Sa signature a CHANGÉ entre builds Steam (issue #14, capture morte) :
//     anciens builds = callback([{nA: id bouton, bS: pressé}]) ; builds récents =
//     callback positionnel (controllerIdx, buttonId, pressed, …) — vérifié dans le
//     bundle steamui (HandleControllerInputMessages(e,t,r,…)). L'espace d'ids est
//     le même enum EGamepadButton dans les deux cas (32=L5, 33=R5 inchangés). On
//     gère les deux formes ; RegisterForControllerStateChanges reste en dernier
//     fallback.
//   * CLAVIER / SOURIS → dans le BACKEND (defaults/input_watch.py). CEF n'a pas le
//     focus clavier quand un jeu tourne : un listener keydown ici ne verrait rien
//     en jeu, ce qui est précisément le cas d'usage. Le backend lit /dev/input et
//     pilote set_ptt lui-même ; le frontend ne fait que la config et la capture.
//
// Le backend agrège les sources (OU logique) : manette tenue + touche tenue, on
// relâche l'une, le micro reste ouvert tant que l'autre est tenue.
import { call, addEventListener, removeEventListener } from "@decky/api";
import { notify } from "./notify";
import { t } from "./i18n";

export type DeviceFp = {
  vendor: string;
  product: string;
  name: string;
  node: string;
};

export type ControllerBinding = {
  kind: "controller";
  buttons: number[];              // ids nA de l'accord
  label: string;
};

export type KeyBinding = {
  kind: "keyboard" | "mouse";
  code: number;                   // code Linux KEY_*/BTN_*
  name: string;                   // nom brut stable, ex. "KEY_F13", "BTN_SIDE"
  label: string;                  // libellé court affichable
  device: DeviceFp;
  deviceName?: string;
  noisy?: boolean;                // clic gauche/droit/milieu : avertir
};

export type VoiceBinding = ControllerBinding | KeyBinding;
export type BindingKind = VoiceBinding["kind"];

export type ShortcutCfg = {
  version: 2;
  enabled: boolean;
  mode: "toggle" | "ptt";
  bindings: VoiceBinding[];
};

export const DEFAULT_CFG: ShortcutCfg =
  { version: 2, enabled: false, mode: "toggle", bindings: [] };

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

// Les boutons de souris courants méritent un libellé lisible ; le reste de
// l'espace de noms Linux (≈300 constantes) reste BRUT, on ne traduit pas 300 noms
// × 9 langues. La traduction se fait ICI et pas dans le backend : lui n'a pas la
// locale de l'utilisateur (elle vient de LocalizationManager côté frontend).
const MOUSE_I18N: Record<string, string> = {
  BTN_LEFT: "mouse_btn_left",
  BTN_RIGHT: "mouse_btn_right",
  BTN_MIDDLE: "mouse_btn_middle",
  BTN_SIDE: "mouse_btn_back",
  BTN_EXTRA: "mouse_btn_forward",
  BTN_BACK: "mouse_btn_back",
  BTN_FORWARD: "mouse_btn_forward",
};

export function bindingLabel(b: VoiceBinding): string {
  if (b.kind === "controller") return buttonsLabel(b.buttons);
  // On repart du NOM brut, pas du `label` stocké : les configs enregistrées par
  // les toutes premières versions contiennent un libellé déjà traduit (en
  // français), qu'il ne faut pas réafficher tel quel.
  const key = MOUSE_I18N[b.name];
  if (key) return t(key);
  return b.name || b.label || "";
}

// Une liaison par TYPE d'entrée, les types se cumulant en OU : manette en
// portable, clavier/souris en station d'accueil, sans reconfigurer à chaque fois.
//
// DÉFENSIF À DESSEIN : le callback SteamClient.Input avale les exceptions
// (`catch { }`), donc un `cfg.bindings` absent ferait un `.find` sur undefined et
// tuerait DÉFINITIVEMENT le raccourci manette, en silence, alors que le chemin
// clavier/souris (backend) continuerait de marcher — panne asymétrique très
// difficile à diagnostiquer.
export function bindingOf(cfg: ShortcutCfg, kind: BindingKind): VoiceBinding | undefined {
  const list = cfg && Array.isArray((cfg as any).bindings) ? cfg.bindings : null;
  if (!list) return undefined;
  return list.find((b) => b && b.kind === kind);
}

// Tolère la v1 {enabled, mode, buttons[], label} : on migre en mémoire, et rien
// n'est réécrit avant que l'utilisateur enregistre (retour arrière possible).
export function migrateCfg(raw: any): ShortcutCfg {
  const base: ShortcutCfg = { ...DEFAULT_CFG, bindings: [] };
  if (!raw || typeof raw !== "object") return base;
  base.enabled = !!raw.enabled;
  base.mode = raw.mode === "ptt" ? "ptt" : "toggle";
  if (raw.version === 2 && Array.isArray(raw.bindings)) {
    base.bindings = raw.bindings.filter(isValidBinding);
    return base;
  }
  const btns: number[] = Array.isArray(raw.buttons)
    ? raw.buttons.filter((x: any) => typeof x === "number")
    : [];
  if (btns.length) {
    base.bindings = [{
      kind: "controller",
      buttons: btns,
      label: typeof raw.label === "string" && raw.label ? raw.label : buttonsLabel(btns),
    }];
  }
  return base;
}

function isValidBinding(b: any): b is VoiceBinding {
  if (!b || typeof b !== "object") return false;
  if (b.kind === "controller") {
    return Array.isArray(b.buttons) && b.buttons.every((x: any) => typeof x === "number");
  }
  if (b.kind === "keyboard" || b.kind === "mouse") {
    return typeof b.code === "number" && !!b.device && typeof b.device === "object";
  }
  return false;
}

let cfg: ShortcutCfg = { ...DEFAULT_CFG };
let comboHeld = false;                    // état précédent (détection de front)
const held = new Set<number>();           // boutons actuellement pressés
let capturing: ((r: VoiceBinding) => void) | null = null;
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

// Copie normalisée du cache module (affichage immédiat, sans aller-retour RPC).
export function reloadShortcutCfg(): ShortcutCfg { return migrateCfg(cfg); }

// Relit la SOURCE DE VÉRITÉ (backend) et resynchronise le cache module. À appeler
// au montage du panneau : le cache peut être la config par défaut si le panneau
// s'ouvre avant que le get_voice_shortcut de l'init ait répondu, et enregistrer
// dans cet état écraserait des liaisons existantes.
export async function refreshShortcutCfg(): Promise<ShortcutCfg> {
  try {
    const c = await call<[], any>("get_voice_shortcut");
    cfg = migrateCfg(c);
  } catch {
    cfg = migrateCfg(cfg);
  }
  return cfg;
}

export async function setShortcutCfg(next: ShortcutCfg) {
  const pttWasOn = cfg.enabled && cfg.mode === "ptt";
  // On normalise TOUJOURS avant d'affecter : un objet partiel venant de l'UI
  // laisserait `cfg.bindings` absent, ce qui casse la détection manette (cf.
  // bindingOf) sans casser le clavier/souris. Le module ne doit jamais contenir
  // autre chose qu'une config v2 complète.
  cfg = migrateCfg(next);
  // Le backend fusionne sur l'existant et réévalue son lecteur clavier/souris.
  await call("set_voice_shortcut", cfg as any).catch(() => {});
  if (pttWasOn && !(cfg.enabled && cfg.mode === "ptt"))
    call("set_ptt", false, "controller").catch(() => {});
  applyPttMode();
}

// ── Capture unifiée « appuie sur n'importe quoi » ────────────────────────────
// On arme les DEUX chemins en même temps (manette ici, clavier/souris côté
// backend) et le premier événement valide gagne : l'utilisateur n'a pas à choisir
// un type d'entrée avant d'appuyer, et n'a pas besoin de savoir si le bouton
// latéral de sa souris se déclare en BTN_SIDE ou en touche clavier.
type CaptureHandle = {
  promise: Promise<VoiceBinding | null>;
  cancel: () => void;
};

export function captureBinding(timeoutMs = 10000): CaptureHandle {
  let settled = false;
  let onEvent: ((p: any) => void) | null = null;
  let timer: any = null;
  let token: string | null = null;
  let resolveOuter: (v: VoiceBinding | null) => void;

  const finish = (v: VoiceBinding | null) => {
    if (settled) return;
    settled = true;
    capturing = null;
    if (timer) { clearTimeout(timer); timer = null; }
    if (onEvent) {
      try { (removeEventListener as any)("ptt_capture", onEvent); } catch { }
      onEvent = null;
    }
    call("cancel_input_capture", token).catch(() => {});
    resolveOuter(v);
  };

  const promise = new Promise<VoiceBinding | null>((resolve) => {
    resolveOuter = resolve;

    // 1) manette : accumulation d'un accord, validée au relâchement complet
    captureAcc = new Set();
    captureStartTs = Date.now();
    capturePreHeld = new Set(held);
    capturing = (b) => finish(b);

    // 2) clavier / souris : le backend ouvre une fenêtre et renvoie un jeton ;
    //    le résultat arrive par l'événement `ptt_capture` (jeton apparié pour
    //    qu'une capture abandonnée ne puisse pas résoudre la suivante).
    onEvent = (p: any) => {
      if (!p || (token && p.token !== token)) return;
      if (p.status !== "ok") { finish(null); return; }
      finish({
        kind: p.kind === "mouse" ? "mouse" : "keyboard",
        code: p.code,
        name: p.name,
        label: p.label,
        device: p.device,
        deviceName: p.device_name,
        noisy: !!p.noisy,
      });
    };
    (addEventListener as any)("ptt_capture", onEvent);

    call<[number], any>("start_input_capture", timeoutMs)
      .then((r) => { token = r?.token ?? null; })
      .catch(() => { token = null; });

    // Filet de sécurité côté UI : le backend a son propre délai, mais si le
    // panneau reste ouvert sans qu'aucun des deux ne réponde on ne veut pas d'une
    // capture armée indéfiniment.
    timer = setTimeout(() => finish(null), timeoutMs + 1500);
  });

  return { promise, cancel: () => finish(null) };
}

export function cancelCapture() {
  capturing = null;
  call("cancel_input_capture", null).catch(() => {});
}

// Un événement bouton individuel (down/up). Pendant une capture : un down
// dans la grâce ou d'un bouton pré-tenu = le clic « Définir » → exclu ; un
// down hors grâce s'accumule ; l'accord se valide au relâchement complet.
function onButtonEvent(btn: number, down: boolean) {
  try {
    handleButtonEvent(btn, down);
  } catch (e) {
    // Le callback Steam avale les exceptions : sans cette trace, une régression
    // ici rend le raccourci manette muet SANS aucun signe (le clavier/souris,
    // lu par le backend, continue de marcher).
    console.warn("[Steamcord] voice shortcut button handler failed:", e);
  }
}

function handleButtonEvent(btn: number, down: boolean) {
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
        done({ kind: "controller", buttons, label: buttonsLabel(buttons) });
      }
    }
    return;
  }
  onCombo();
}

function onCombo() {
  const b = bindingOf(cfg, "controller") as ControllerBinding | undefined;
  if (!cfg.enabled || !b || !b.buttons.length) return;
  const active = b.buttons.every((x) => held.has(x));
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
      call("set_ptt", true, "controller").catch(() => {});
    }
  } else if (!active && comboHeld && cfg.mode === "ptt") {
    call("set_ptt", false, "controller").catch(() => {});
  }
  comboHeld = active;
}

// On RETIENT l'abonnement renvoyé par RegisterFor*() : c'est lui qui porte la
// souscription, et le garder accessible évite toute question de collecte. C'est
// aussi ce qui permet de se DÉSABONNER avant un réabonnement (cf. reprise de
// veille), sans quoi on empilerait les callbacks à chaque réveil — chaque front
// serait alors compté deux fois.
let inputReg: any = null;

function unregisterController() {
  if (!inputReg) return;
  try {
    if (typeof inputReg === "function") inputReg();
    else if (typeof inputReg?.unregister === "function") inputReg.unregister();
  } catch { }
  inputReg = null;
}

// Le flux de messages manette de Steam s'ARRÊTE après une mise en veille :
// diagnostiqué le 10/08/26 sur l'appareil — plus AUCUN listener ne recevait
// d'événement (pas même un abonnement créé à l'instant), et tout est revenu
// après un redémarrage de Steam. Aucune API SteamClient de ce build n'expose un
// « resume » (System n'a que batterie/airplane/settings ; User.*Suspend* ne
// concerne que la suspension des JEUX) → on détecte le saut d'horloge : un
// intervalle de 10 s qui prend beaucoup plus longtemps = la machine a dormi.
const RESUME_TICK_MS = 10000;
const RESUME_GAP_MS = 30000;
let lastTick = Date.now();

function watchForResume() {
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap < RESUME_GAP_MS) return;
    console.log("[Steamcord] resume detected (gap " + Math.round(gap / 1000)
      + "s) — re-subscribing to controller input");
    // Un bouton « tenu » avant la veille ne l'est plus au réveil : on repart d'un
    // état propre, sinon comboHeld resterait vrai et le prochain appui ne
    // produirait aucun front (micro coincé, ou plus aucune réaction).
    held.clear();
    comboHeld = false;
    call("set_ptt", false, "controller").catch(() => { });
    registerControllerListener();
    applyPttMode();
  }, RESUME_TICK_MS);
}

export function initVoiceShortcut() {
  call<[], any>("get_voice_shortcut")
    .then((c) => { cfg = migrateCfg(c); applyPttMode(); })
    .catch(() => {});
  registerControllerListener();
  watchForResume();
}

function registerControllerListener() {
  unregisterController();
  const Input = (window as any).SteamClient?.Input;
  try {
    if (typeof Input?.RegisterForControllerInputMessages === "function") {
      inputReg = Input.RegisterForControllerInputMessages((...args: any[]) => {
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
      // Même règle : on RETIENT l'abonnement (cf. inputReg ci-dessus).
      inputReg = Input.RegisterForControllerStateChanges((changes: any[]) => {
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
