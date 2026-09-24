// Notifications Steamcord + garde anti-crash du panneau de notifs Steam.
//
// CE QU'ON SAIT (root cause prouvée en live le 2026-07-16 sur le bundle steamui
// 10789616) : un toast Decky d'origine (eType 31) est routé par le sélecteur de
// renderer via une map eType→notification_type (ici 31→10) vers les composants
// « Steam notification » (Xt & co) qui lisent data.item.notification_type /
// data.type / data.rgunread — champs absents des toasts Decky → TypeError
// « Cannot read properties of undefined (reading 'notification_type') » : écran
// d'erreur Decky au rendu du POPUP, et crash du panneau de notifs pour l'entrée
// tray. Sur d'autres builds Steam (mapping différent), le rendu natif marche.
// Aucune sonde runtime ne peut prouver qu'un build est sain sans déclencher le
// crash lui-même → le choix est laissé à l'utilisateur :
//
// - défaut = REROUTAGE sûr : DisplayClientNotification type 1 (GroupChatMessage,
//   seul renderer générique titre+corps du bundle actuel — vérifié). Zéro crash
//   partout, mais les notifs ressemblent à un message de chat (issue #2).
// - opt-in « notifications natives » (toggle QAM, localStorage) : passthrough
//   intégral vers le toaster Decky d'origine pour les builds qui savent les
//   rendre. Si l'écran d'erreur apparaît, l'utilisateur désactive et le
//   balayage du tray au chargement suivant purge les entrées empoisonnées.

import { t } from "./i18n";

// ── Mode streamer ──────────────────────────────────────────────────────────
// Pendant un live (Go Live Discord, stream ou enregistrement BoneCast), un toast
// Steam finit DANS la vidéo : gamescope le compose avec le jeu, et c'est cette
// image-là que capturent Vesktop comme BoneCast (demande user 15/09). On retient
// donc les notifications, puis on les rend à la fin du live.
//
// Contrat PARTAGÉ avec BoneCast, SkullKey et BC250 Toolkit — tous les frontends
// vivent dans le même contexte JS de Steam, un objet global suffit :
//   window.__necroStreamer.sources = { <source>: bool }  (qui est en live)
//   localStorage « necro_streamer_mode » = auto | always | off
//   événement window « necro-streamer-change » à chaque changement
// « always » couvre OBS et tout logiciel de stream qu'on ne sait pas détecter.
export type StreamerMode = "auto" | "always" | "off";
const STREAMER_KEY = "necro_streamer_mode";
export const getStreamerMode = (): StreamerMode => {
  try { const v = localStorage.getItem(STREAMER_KEY); return v === "always" || v === "off" ? v : "auto"; } catch { return "auto"; }
};
export const setStreamerMode = (m: StreamerMode) => {
  try { localStorage.setItem(STREAMER_KEY, m); } catch {}
  window.dispatchEvent(new Event("necro-streamer-change"));
};
export function setLiveSource(name: string, live: boolean) {
  const w = window as any;
  const g = (w.__necroStreamer ||= { sources: {} });
  if (!!g.sources[name] === live) return;
  g.sources[name] = live;
  window.dispatchEvent(new Event("necro-streamer-change"));
}
export function streamerActive(): boolean {
  const m = getStreamerMode();
  if (m !== "auto") return m === "always";
  return Object.values((window as any).__necroStreamer?.sources || {}).some(Boolean);
}

// Notifications retenues pendant le live. À la fin : rejouées telles quelles
// s'il y en a peu, sinon UN résumé — dix toasts d'affilée à la sortie d'un
// stream seraient pires que le problème.
const HELD_REPLAY_MAX = 3;
const held: Array<() => void> = [];
let streamerListening = false;
function holdForStream(show: () => void) {
  held.push(show);
  if (streamerListening) return;
  streamerListening = true;
  window.addEventListener("necro-streamer-change", () => {
    if (streamerActive() || held.length === 0) return;
    const pending = held.splice(0);
    if (pending.length <= HELD_REPLAY_MAX) pending.forEach((fn) => { try { fn(); } catch {} });
    else chatStyleNotification({ title: "Steamcord", body: t("streamer_summary", { n: pending.length }), sender: "Steamcord", dm: true });
  });
}

// ── Son des notifications de message (retour user 20/09) ───────────────────
// « quand je reçois un message Discord, j'ai le son Discord + le son de notif
// Steam ». Les deux sons sont réels et indépendants : Vesktop joue `message1`,
// et le toast que NOUS émettons fait sonner Steam. Le mode est persisté par le
// backend (`~/.config/steamcord-notify.json`, clé `sound`) parce qu'il pilote
// aussi le client injecté dans Vesktop ; ici on n'en garde qu'un cache, posé au
// démarrage par index.tsx. Défaut « discord » = on garde le son de Discord.
export type NotifSound = "discord" | "steam" | "both" | "none";
let notifSound: NotifSound = "discord";
export const getNotifSound = (): NotifSound => notifSound;
export const setNotifSoundCache = (v: NotifSound) => { notifSound = v; };
const steamToastMuted = () => notifSound === "discord" || notifSound === "none";

// Steam sonne dans `NotificationStore.PlayNotificationSound(notif)`. Mesuré au
// CDP le 20/09 : elle est appelée UNE fois par notification, avec l'objet
// complet, et `notif.data.steamid()` rend exactement le steamid envoyé — nos
// notifications sont donc reconnaissables à leur persona factice. On ne coupe
// que celles qu'on a nous-mêmes marquées : toute vraie notification Steam
// (message d'un ami, téléchargement fini…) garde son son.
// Fenêtre + compteur plutôt qu'un simple drapeau : le toast part en asynchrone
// (aller-retour vers le client Steam), et deux messages du même expéditeur coup
// sur coup doivent taire DEUX sons.
const SILENT_TOAST_WINDOW_MS = 8000;
const silentToasts = new Map<string, { n: number; exp: number }>();
let toastSoundPatched = false;

function patchToastSound() {
  if (toastSoundPatched) return;
  try {
    const ns = (window as any).NotificationStore;
    const orig = ns && Object.getPrototypeOf(ns)?.PlayNotificationSound;
    if (typeof orig !== "function") return;
    toastSoundPatched = true;
    ns.PlayNotificationSound = function (n: any) {
      try {
        const d = n?.data;
        const raw = d ? (typeof d.steamid === "function" ? d.steamid() : d.steamid) : null;
        const sid = raw == null ? "" : String(raw);
        const e = sid ? silentToasts.get(sid) : undefined;
        if (e) {
          if (e.exp > Date.now()) {
            if (--e.n <= 0) silentToasts.delete(sid);
            return; // la nôtre : c'est Discord qui sonne
          }
          silentToasts.delete(sid); // périmée : le son revient
        }
      } catch {}
      return orig.call(this, n);
    };
  } catch (e) {
    console.error("[Steamcord] patch du son des toasts échoué", e);
  }
}

function markToastSilent(sid: string) {
  patchToastSound();
  const exp = Date.now() + SILENT_TOAST_WINDOW_MS;
  const e = silentToasts.get(sid);
  if (e && e.exp > Date.now()) { e.n++; e.exp = exp; } else silentToasts.set(sid, { n: 1, exp });
}

const NATIVE_TOASTS_KEY = "steamcord_native_toasts";
export const getNativeToasts = (): boolean => {
  try { return localStorage.getItem(NATIVE_TOASTS_KEY) === "1"; } catch { return false; } // défaut OFF
};
// #53 : en mode bureau, la fenêtre Steam plante sur TOUT toast Decky natif.
// Reproduit le 23/09 sur le build de fuzi0nz (chunk 7e9d063cfb819cd56045) : le toast
// (eType 31) atterrit dans `Xt`, qui lit data.item.notification_type → écran d'erreur
// Decky dans la fenêtre bureau. Le mode sûr, lui, passe (toast + cloche testés). On
// n'honore donc le réglage qu'en mode jeu (UI mode 4) ; en bureau c'est 7.
const inGamepadUi = (): boolean => {
  try { return (window as any).SteamUIStore?.MainInstanceUIMode === 4; } catch { return false; }
};
const useNativeToasts = (): boolean => getNativeToasts() && inGamepadUi();
export const setNativeToasts = (v: boolean) => {
  try { localStorage.setItem(NATIVE_TOASTS_KEY, v ? "1" : "0"); } catch {}
  if (!v) sweepDeckyTrayGroups(); // purge immédiate des entrées natives restantes
};

// Retire du tray tout groupe créé par le toaster Decky (marqueur `decky: true`
// posé par decky-loader sur ses toastData). RemoveGroupFromTray est l'API que
// Decky utilise lui-même dans dismiss() — pas d'accès privé supplémentaire.
function sweepDeckyTrayGroups() {
  try {
    const ns = (window as any).NotificationStore;
    if (!ns?.m_rgNotificationTray || !ns.RemoveGroupFromTray) return;
    for (const g of [...ns.m_rgNotificationTray]) {
      if ((g?.notifications || []).some((n: any) => n?.decky)) {
        try {
          ns.RemoveGroupFromTray(g);
        } catch {}
      }
    }
  } catch {}
}

// Rendu chat-style avec PERSONA FACTICE (demande user : « pseudo de l'expéditeur
// + image Discord », pas mon propre profil). Le renderer GroupChatMessage tire
// avatar + pseudo du persona Steam de `steamid` (champ proto steamid_sender) :
// on dérive donc un accountid réservé du nom de l'expéditeur (hash → plage
// haute 0xDExxxxx, loin des comptes réels), on crée/maquille son entrée locale
// dans friendStore (m_strPlayerName + getters avatar_url_* shadowés par
// defineProperty → l'URL CDN Discord passe la CSP, vérifié en live), puis on
// notifie avec ce steamid. Chaque expéditeur garde SON persona (hash stable) ;
// re-maquillé à chaque notif au cas où Steam rafraîchirait l'entrée.
// Avatar par défaut d'un évènement DISCORD sans avatar connu = logo Discord.
const DEFAULT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";
// Avatar des toasts REROUTÉS des autres plugins Decky : le « ? » Steam neutre —
// un toast AutoFlatpaks avec le logo Discord était trompeur (issue #4).
const NEUTRAL_AVATAR = "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";
const STEAMID_BASE = BigInt("76561197960265728");

function fakeSenderSid(sender: string): { sid64: string; accountid: number } {
  let h = 5381;
  for (let i = 0; i < sender.length; i++) h = (Math.imul(h, 33) ^ sender.charCodeAt(i)) >>> 0;
  const accountid = 0xde000000 + (h & 0xfffff);
  return { sid64: (STEAMID_BASE + BigInt(accountid)).toString(), accountid };
}

// Steam rafraîchit en ASYNC le persona d'un accountid inconnu et efface
// m_strPlayerName → titre qui « flicke »/disparaît sur le toast (issue #4).
// Impossible de shadower le nom par getter : m_strPlayerName est un accessor
// MobX NON-configurable (« Cannot redefine property », vérifié en live) — seul
// le setter MobX est utilisable, et Steam repasse par lui pour écraser. Parade :
// registre des personas factices + garde périodique qui ré-affirme le nom
// (l'écriture MobX déclenche le re-render → le toast/tray se répare seul), plus
// quelques ré-affirmations rapprochées juste après la notif pour couvrir la
// fenêtre de rendu du toast. Les avatar_url_* restent shadowés par getter
// (getters de prototype → defineProperty OK, vérifié en live).
const fakePersonaNames = new Map<number, { sid64: string; name: string }>();
let personaGuard: ReturnType<typeof setInterval> | null = null;

function getFakePersona(sid64: string, accountid: number) {
  const fs = (window as any).friendStore;
  if (!fs?.GetFriendState) return null;
  return fs.GetFriendState({
    GetAccountID: () => accountid,
    ConvertTo64BitString: () => sid64,
    BIsValid: () => true,
  })?.m_persona ?? null;
}

function assertPersonaName(sid64: string, accountid: number, name: string) {
  try {
    const p = getFakePersona(sid64, accountid);
    if (p && p.m_strPlayerName !== name) p.m_strPlayerName = name;
  } catch {}
}

function ensurePersonaGuard() {
  if (personaGuard) return;
  personaGuard = setInterval(() => {
    for (const [accountid, e] of fakePersonaNames) assertPersonaName(e.sid64, accountid, e.name);
  }, 2000);
}

function primeSenderPersona(sid64: string, accountid: number, name: string, avatar: string) {
  try {
    const p = getFakePersona(sid64, accountid);
    if (!p) return; // pas de store → avatar/pseudo par défaut, la notif part quand même
    try { p.m_strPlayerName = name; } catch {}
    for (const k of ["avatar_url_small", "avatar_url_medium", "avatar_url_full"]) {
      try {
        Object.defineProperty(p, k, { get: () => avatar, configurable: true });
      } catch {}
    }
    fakePersonaNames.set(accountid, { sid64, name });
    ensurePersonaGuard();
    // Le refresh Steam qui efface le nom arrive typiquement <1 s après la
    // création du persona → ré-affirmations rapprochées pendant le toast.
    for (const ms of [300, 800, 1500]) setTimeout(() => assertPersonaName(sid64, accountid, name), ms);
  } catch {}
}

// ── #23 : le TOUT PREMIER toast d'une session Steam n'est jamais rendu ──
// Reproduit de façon fiable : l'entrée arrive bien dans le tray, mais rien ne
// s'affiche ; les suivantes popent normalement. Le rendu passe par
// `NotificationStore.m_valueCurrentToast`, auquel la fenêtre de toasts
// s'ABONNE — si elle n'est pas encore montée quand la 1re notif arrive, la
// valeur est posée dans le vide et personne ne la rend.
//
// On ne peut pas deviner de façon fiable si la fenêtre est prête ; on VÉRIFIE
// donc après coup. Signal mesuré au CDP le 26/07 : `BAnyContextRenderingToasts()`
// passe à true ~170 ms après une notif RÉELLEMENT rendue et le reste pendant
// tout l'affichage (`m_valueCurrentToast.m_currentValue`, lui, reste vide —
// ne pas s'en servir). Si rien n'a été rendu au bout de la fenêtre d'attente,
// on ré-émet UNE fois.
//
// ⚠️ Compromis assumé : si un AUTRE toast (Steam, autre plugin) occupe le
// rendu pile à ce moment, on croit à tort que le nôtre est passé et on ne
// ré-émet pas. À l'inverse le risque de doublon est borné à une seule notif
// par démarrage. Perdre une notif est pire qu'en voir une en double.
const TOAST_RENDER_SIGNAL_MS = 900;
let firstToastVerified = false;

function verifyFirstToastRendered(resend: () => void) {
  if (firstToastVerified) return;
  firstToastVerified = true;
  const ns = (window as any).NotificationStore;
  if (typeof ns?.BAnyContextRenderingToasts !== "function") return;
  const t0 = Date.now();
  const iv = setInterval(() => {
    let rendered = false;
    try { rendered = !!ns.BAnyContextRenderingToasts(); } catch {}
    if (rendered) { clearInterval(iv); return; }
    if (Date.now() - t0 >= TOAST_RENDER_SIGNAL_MS) {
      clearInterval(iv);
      console.log("[Steamcord] 1er toast jamais rendu (#23) → ré-émission");
      try { resend(); } catch (e) { console.error("[Steamcord] re-emission toast failed", e); }
    }
  }, 60);
}

type ChatNotif = {
  title: string; body: string; sender?: string; avatar?: string; dm?: boolean;
  // `message: true` = Discord joue DÉJÀ son propre son pour cet évènement (un
  // message reçu). Seules ces notifications-là peuvent voir leur son Steam
  // coupé par le réglage : un avis du plugin ou un toast rerouté d'un autre
  // plugin Decky n'a pas de son Discord en face, il garderait le silence.
  message?: boolean;
  onClick?: () => void;
};

function chatStyleNotification(n: ChatNotif) {
  // Point de passage de TOUT ce qui s'affiche en mode sûr (nos notifs et les
  // toasts reroutés des autres plugins Decky) → une seule garde suffit.
  if (streamerActive()) { holdForStream(() => chatStyleNotification(n)); return; }
  const { title, body, sender, avatar, dm, message, onClick } = n;
  try {
    const name = sender || title || "Steamcord";
    const { sid64, accountid } = fakeSenderSid(name);
    primeSenderPersona(sid64, accountid, name, avatar || DEFAULT_AVATAR);
    if (message && steamToastMuted()) markToastSilent(sid64);
    // Type 2 (FriendChatMessage) pour les MP/appels : rendu « message privé »
    // (le type 1 affichait « Message de groupe » sur un MP — retour user).
    // Type 1 (GroupChatMessage) pour les chans de serveur et les notifs système.
    // `title` du proto = nom de groupe (affiché seulement hors gamemode) : on le
    // vide quand il répéterait le pseudo déjà rendu via le persona.
    // Le 3e argument est appelé par Steam quand l'utilisateur CLIQUE la notif
    // (doc SteamClient : "executed when the user interacts with the notification")
    // — jusqu'ici toujours un no-op, donc cliquer une notif ne faisait rien
    // (retour user : « répondre à l'appel/aller à la conv » demandés).
    const send = () => (window as any).SteamClient?.ClientNotifications?.DisplayClientNotification?.(
      dm ? 2 : 1,
      JSON.stringify({ title: title === name ? "" : title, body, state: "active", steamid: sid64 }),
      () => { try { onClick?.(); } catch (e) { console.error("[Steamcord] notification onClick failed", e); } },
    );
    send();
    verifyFirstToastRendered(send); // #23, voir plus haut
  } catch (e) {
    console.error("[Steamcord] notification failed", e);
  }
}

// Notification Steamcord : chat-style persona en mode sûr, toast Decky natif si
// le user a activé le mode natif.
export function notify(payload: ChatNotif) {
  if (streamerActive()) { holdForStream(() => notify(payload)); return; }
  try {
    const dpl: any = (window as any).DeckyPluginLoader;
    // ⚠️ Mode « notifications natives » (opt-in) : le toast part par le toaster
    // Decky, sans notre persona factice — le réglage du son ne peut donc pas le
    // reconnaître et ne s'applique pas à ce chemin-là.
    if (useNativeToasts() && typeof dpl?.toaster?.toast === "function") {
      dpl.toaster.toast({ title: payload.sender || payload.title, body: payload.body, onClick: payload.onClick });
      return;
    }
  } catch {}
  chatStyleNotification(payload);
}

// Enrobe toaster.toast (Decky + tous les plugins) selon le mode. Marqueur
// versionné (=== 2) : un plugin mis à jour à chaud doit remplacer l'ancien
// reroutage v1 (qui posait `__steamcordSafe = true`).
export function patchDeckyToaster(_tries = 0) {
  try {
    const dpl: any = (window as any).DeckyPluginLoader;
    // Le toaster peut ne pas être prêt à l'init (surtout après un restart Steam) →
    // on réessaie quelques secondes pour ne jamais manquer la fenêtre de patch.
    if (!dpl?.toaster) {
      if (_tries < 40) setTimeout(() => patchDeckyToaster(_tries + 1), 500);
      return;
    }
    if (dpl.toaster.__steamcordSafe === 2) return;
    // L'implémentation d'origine vit sur le prototype du toaster Decky ; la
    // propriété propre `toast`, si elle existe et que le marqueur v1 est posé,
    // est notre ancien patch → à écraser.
    const proto = Object.getPrototypeOf(dpl.toaster);
    const own = Object.prototype.hasOwnProperty.call(dpl.toaster, "toast");
    const orig = own && !dpl.toaster.__steamcordSafe ? dpl.toaster.toast : proto?.toast;
    if (typeof orig !== "function") return;
    dpl.toaster.__steamcordSafe = 2;
    dpl.toaster.toast = (toast: any) => {
      if (streamerActive()) { holdForStream(() => dpl.toaster.toast(toast)); return; }
      if (useNativeToasts()) {
        return orig.call(dpl.toaster, toast);
      }
      try {
        const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : "Notification");
        // Toast d'un plugin quelconque → avatar « ? » Steam neutre, PAS le logo
        // Discord (issue #4 : AutoFlatpaks passait pour un message Discord).
        chatStyleNotification({ title: str(toast?.title) || "Decky", body: str(toast?.body), avatar: NEUTRAL_AVATAR });
      } catch (e) {
        console.error("[Steamcord] safe toaster failed", e);
      }
    };
    // Purge SYSTÉMATIQUE au chargement des entrées Decky natives restantes
    // (toasts d'avant le patch, ou session native précédente) : sur un build
    // qui plante, une entrée empoisonnée dans le tray tue le panneau de notifs
    // pour toute la session, même notifs OK par ailleurs (issue #4). Les toasts
    // Decky d'une session précédente sont périmés de toute façon.
    sweepDeckyTrayGroups();
    console.log("[Steamcord] Decky toaster sécurisé (mode " + (getNativeToasts() ? "natif" : "sûr") + ")");
  } catch (e) {
    console.error("[Steamcord] patchDeckyToaster failed", e);
  }
}
