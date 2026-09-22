// Inhibiteur d'économiseur d'écran pendant le visionnage d'un stream (#51).
//
// SteamOS n'offre AUCUNE API d'inhibition : le service Screensaver de l'UI est
// en lecture seule (GetActiveState + notification), SteamClient n'expose rien
// d'« idle », gamescope n'implémente pas zwp_idle_inhibit_manager_v1, et la
// session gamemode n'a pas d'org.freedesktop.ScreenSaver sur le bus.
// Le seul levier réel est le RÉGLAGE Steam lui-même : on met le délai de
// l'économiseur à 0 (= désactivé) le temps du visionnage, et on le remet
// exactement comme il était ensuite.
//
// Lecture  : `window.settingsStore.clientSettings[<nom>]` (265 réglages, lisible).
// Écriture : `SteamClient.Settings.SetSetting(<base64 du protobuf>)`, comme la
// page de réglages de Steam — un message ne portant QUE le champ visé.
// Les deux ont été vérifiés à la mesure : écriture 0 → relecture 0, restauration
// 300 → relecture 300, aucun autre réglage touché.
import { call } from "@decky/api";

type Entry = { name: string; field: number };
type Held = Entry & { prev: number };

// Champs du message de réglages client. AC et batterie sont deux délais
// distincts : on tient les deux, la source d'alimentation peut changer
// pendant qu'on regarde.
const FIELDS: Entry[] = [
  { name: "system_idle_screensaver_ac_sec", field: 24009 },
  { name: "system_idle_screensaver_battery_sec", field: 24008 },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const clientSettings = (): Record<string, any> | null =>
  ((window as any).settingsStore?.clientSettings as Record<string, any>) || null;

const readSetting = (name: string): number | null => {
  const v = clientSettings()?.[name];
  return typeof v === "number" ? v : null;
};

// Protobuf minimal : un seul champ, varint (wiretype 0). C'est exactement ce
// que fabrique la page de réglages de Steam avant SetSetting().
function encodeSetting(field: number, value: number): string {
  const out: number[] = [];
  let k = field * 8;
  do { const b = k % 128; k = Math.floor(k / 128); out.push(b | (k ? 0x80 : 0)); } while (k);
  let v = Math.max(0, Math.floor(value));
  do { const b = v % 128; v = Math.floor(v / 128); out.push(b | (v ? 0x80 : 0)); } while (v);
  return btoa(String.fromCharCode(...out));
}

// Écrit puis RELIT : tant que la relecture ne confirme pas, on ne se considère
// pas armé. C'est le garde-fou contre un renumérotage des champs par Valve —
// on préfère ne rien inhiber plutôt que croire l'avoir fait.
async function writeSetting(e: Entry, value: number): Promise<boolean> {
  try {
    await (window as any).SteamClient?.Settings?.SetSetting(encodeSetting(e.field, value));
  } catch (err) {
    console.warn("[Steamcord] keepAwake: SetSetting failed", e.name, err);
    return false;
  }
  // La valeur revient par un aller-retour client → store : on laisse le temps.
  for (let i = 0; i < 10; i++) {
    if (readSetting(e.name) === value) return true;
    await sleep(150);
  }
  return readSetting(e.name) === value;
}

let enabled = true;          // préférence utilisateur (Config → « Rester éveillé »)
let held: Held[] | null = null;  // non-null = on tient l'économiseur
let chain: Promise<void> = Promise.resolve();

// Toutes les opérations passent par une file : armer et relâcher ne peuvent
// pas s'entrelacer si l'utilisateur ouvre/ferme un stream très vite.
const queue = (fn: () => Promise<void>): Promise<void> => {
  chain = chain.then(fn).catch((e) => console.warn("[Steamcord] keepAwake", e));
  return chain;
};

const savePending = (values: Record<string, number> | null) =>
  call("set_keepawake_pending", values).catch(() => {});

async function doArm() {
  if (!enabled || held) return;
  if (!clientSettings()) return;  // pas de store → on ne touche à rien
  const snapshot: Held[] = [];
  for (const e of FIELDS) {
    const v = readSetting(e.name);
    // 0 = déjà désactivé par l'utilisateur : rien à tenir, rien à restaurer.
    if (v !== null && v > 0) snapshot.push({ ...e, prev: v });
  }
  held = snapshot;
  if (!snapshot.length) return;
  // Le filet d'abord : si Steam meurt entre ici et la restauration, le
  // prochain chargement du plugin remettra ces valeurs.
  await savePending(Object.fromEntries(snapshot.map((e) => [e.name, e.prev])));
  for (const e of snapshot) {
    if (!(await writeSetting(e, 0))) {
      console.warn("[Steamcord] keepAwake: write not confirmed, rolling back", e.name);
      await doRelease();
      return;
    }
  }
}

async function doRelease() {
  const h = held;
  held = null;
  if (!h) return;
  for (const e of h) await writeSetting(e, e.prev);
  await savePending(null);
}

export const armKeepAwake = () => queue(doArm);
export const releaseKeepAwake = () => queue(doRelease);

export function setKeepAwakeEnabled(on: boolean) {
  enabled = !!on;
  call("set_keepawake_enabled", enabled).catch(() => {});
  if (!enabled) releaseKeepAwake();
}

// Au chargement du plugin : lire la préférence, et réparer un délai laissé à 0
// par une session précédente morte en plein visionnage (Steam tué, plugin
// rechargé). On ne restaure QUE si la valeur est toujours 0 — si l'utilisateur
// l'a changée lui-même entre-temps, c'est la sienne qui gagne.
export async function initKeepAwake() {
  let prefs: any = null;
  try {
    prefs = await call<[], any>("get_keepawake_prefs");
  } catch { return; }
  enabled = prefs?.enabled !== false;
  const pending = prefs?.pending || {};
  const names = Object.keys(pending);
  if (!names.length) return;
  for (const e of FIELDS) {
    const prev = pending[e.name];
    if (typeof prev === "number" && prev > 0 && readSetting(e.name) === 0) {
      await writeSetting(e, prev);
    }
  }
  await savePending(null);
}

export const isKeepAwakeEnabled = () => enabled;
