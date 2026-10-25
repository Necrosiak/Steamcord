// Steamcord notifications only. Native mode uses Decky's public toaster API;
// chat-style mode retains Steamcord's persona, click, sound and streamer behavior.
// Never replace the shared Decky toaster or remove other plugins' notifications.

import { findModuleExport, Navigation } from "@decky/ui";
import { t } from "./i18n";
import { toaster } from "@decky/api";

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
// complet. Sur le SteamUI d'octobre, le getter est `steamid_sender()` ; des
// builds précédents exposaient `steamid()`. Les deux permettent de reconnaître
// notre persona factice. On ne coupe
// que celles qu'on a nous-mêmes marquées : toute vraie notification Steam
// (message d'un ami, téléchargement fini…) garde son son.
// Fenêtre + compteur plutôt qu'un simple drapeau : le toast part en asynchrone
// (aller-retour vers le client Steam), et deux messages du même expéditeur coup
// sur coup doivent taire DEUX sons.
const SILENT_TOAST_WINDOW_MS = 8000;
const silentToasts = new Map<string, { n: number; exp: number }>();
let patchedToastSound: ((n: any) => void) | null = null;

function patchToastSound() {
  try {
    const ns = (window as any).NotificationStore;
    // SteamUI peut recréer le store ou rétablir sa méthode après notre init.
    // Le marqueur booléen restait alors vrai et le son de chat revenait.
    if (ns?.PlayNotificationSound === patchedToastSound) return;
    const orig = ns && Object.getPrototypeOf(ns)?.PlayNotificationSound;
    if (typeof orig !== "function") return;
    const patched = function (this: any, n: any) {
      try {
        const d = n?.data;
        const raw = d ? (typeof d.steamid_sender === "function" ? d.steamid_sender()
          : d.steamid_sender ?? (typeof d.steamid === "function" ? d.steamid() : d.steamid)) : null;
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
    ns.PlayNotificationSound = patched;
    patchedToastSound = patched;
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
};

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
const STEAMID_BASE = BigInt("76561197960265728");

const FAKE_ACCOUNT_BASE = 0xde000000;
const FAKE_ACCOUNT_MASK = 0xfffff;

function fakeSenderSid(sender: string): { sid64: string; accountid: number } {
  let h = 5381;
  for (let i = 0; i < sender.length; i++) h = (Math.imul(h, 33) ^ sender.charCodeAt(i)) >>> 0;
  const accountid = FAKE_ACCOUNT_BASE + (h & FAKE_ACCOUNT_MASK);
  return { sid64: (STEAMID_BASE + BigInt(accountid)).toString(), accountid };
}

const isFakeAccount = (accountid: number) =>
  accountid >= FAKE_ACCOUNT_BASE && accountid <= FAKE_ACCOUNT_BASE + FAKE_ACCOUNT_MASK;

// ── Clic sur une notification ─────────────────────────────────────────────
// Mesuré au CDP le 06/10 : le 3e argument de DisplayClientNotification n'est
// JAMAIS appelé au clic. Le clic passe par le renderer Steam (onActivate), qui
// appelle un singleton du bundle :
//   type 2 (FriendChatMessage) → ShowFriendChatDialog(browserCtx, steamID)
//   type 1 (GroupChatMessage)  → ShowChatRoomGroupDialog(browserCtx, chat_group_id, chat_id)
// Sur nos personas factices, Steam ouvrait donc une conv avec un ami
// inexistant (rien) ou un chat de groupe VIDE. Le type 2 transmet le steamid
// de l'expéditeur → on retrouve NOTRE notif ; le type 1 ne transmet que
// chat_group_id/chat_id, que DisplayClientNotification ignore (testé : string,
// nombre, autres noms de champ → toujours ""). D'où : une notif cliquable part
// en type 2, et un ShowChatRoomGroupDialog sans aucun id (jamais émis par un
// vrai chat Steam) est avalé au lieu d'ouvrir un chat de groupe vide.
// Une action par persona : le hash du persona inclut le contexte (« Pseudo
// (#salon, Serveur) »), donc la dernière notif d'un expéditeur à un endroit
// donné est celle qu'on rouvre — tray compris.
const clickActions = new Map<number, () => void>();
let unhookClick: (() => void) | null = null;

export function installClickHook() {
  if (unhookClick) return;
  try {
    const store = findModuleExport((e: any) =>
      e && typeof e.ShowFriendChatDialog === "function" && typeof e.ShowChatRoomGroupDialog === "function");
    if (!store) {
      console.warn("[Steamcord] store de chat Steam introuvable : clic sur les notifs inactif");
      return;
    }
    const origFriend = store.ShowFriendChatDialog;
    const origGroup = store.ShowChatRoomGroupDialog;
    unhookClick = () => {
      store.ShowFriendChatDialog = origFriend;
      store.ShowChatRoomGroupDialog = origGroup;
      unhookClick = null;
    };
    store.ShowFriendChatDialog = function (ctx: any, steamID: any, ...rest: any[]) {
      let accountid = NaN;
      try { accountid = Number(steamID?.GetAccountID?.()); } catch {}
      if (isFakeAccount(accountid)) {
        const action = clickActions.get(accountid);
        if (action) {
          // Ferme d'abord le centre de notifs : la notif est traitée, et Retour
          // doit ramener à ce qu'on faisait avant (le jeu), pas à la liste.
          try { Navigation.CloseSideMenus(); } catch {}
          try { action(); } catch (e) { console.error("[Steamcord] action de clic échouée", e); }
        }
        return;
      }
      return origFriend.call(this, ctx, steamID, ...rest);
    };
    store.ShowChatRoomGroupDialog = function (ctx: any, groupId: any, chatId: any, ...rest: any[]) {
      if (!groupId && !chatId) return;
      return origGroup.call(this, ctx, groupId, chatId, ...rest);
    };
  } catch (e) {
    console.error("[Steamcord] hook du clic des notifs échoué", e);
  }
}

export function uninstallClickHook() {
  unhookClick?.();
  clickActions.clear();
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
  // message reçu). Les avis du plugin conservent leur son Steam.
  message?: boolean;
  // `quiet: true` = pas de son de message de chat pour cette notification.
  quiet?: boolean;
  onClick?: () => void;
  // Clé du persona factice, si elle doit différer du nom affiché : un appel et
  // les messages de la même personne doivent garder chacun leur action de clic.
  personaKey?: string;
};

function chatStyleNotification(n: ChatNotif) {
  // Garde limitée aux notifications émises par Steamcord.
  if (streamerActive()) { holdForStream(() => chatStyleNotification(n)); return; }
  const { title, body, sender, avatar, dm, message, quiet, onClick, personaKey } = n;
  try {
    const name = sender || title || "Steamcord";
    const { sid64, accountid } = fakeSenderSid(personaKey || name);
    primeSenderPersona(sid64, accountid, name, avatar || DEFAULT_AVATAR);
    if ((message && steamToastMuted()) || quiet) markToastSilent(sid64);
    if (onClick) {
      installClickHook();
      clickActions.set(accountid, onClick);
    } else {
      clickActions.delete(accountid);
    }
    // Type 2 (FriendChatMessage) pour les MP/appels : rendu « message privé »
    // (le type 1 affichait « Message de groupe » sur un MP — retour user).
    // Type 1 (GroupChatMessage) pour les chans de serveur et les notifs système.
    // Une notif CLIQUABLE part toujours en type 2 : seul ce type rend le
    // steamid au clic (voir installClickHook).
    // `title` du proto = nom de groupe (affiché seulement hors gamemode) : on le
    // vide quand il répéterait le pseudo déjà rendu via le persona.
    // 3e argument : jamais appelé par Steam (ni au clic ni ailleurs, vérifié).
    // PAS de champ `state` : en type 2 Steam le range dans `response_steamurl`,
    // et en mode jeu un response_steamurl non vide remplace l'ouverture du chat
    // par un menu « Accepter l'invitation » qui ouvre cette « URL » (« active »
    // → rien). Vide, le clic passe par ShowFriendChatDialog (installClickHook).
    const send = () => (window as any).SteamClient?.ClientNotifications?.DisplayClientNotification?.(
      dm || onClick ? 2 : 1,
      JSON.stringify({ title: title === name ? "" : title, body, steamid: sid64 }),
      () => {},
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
    // ⚠️ Mode « notifications natives » (opt-in) : le toast part par le toaster
    // Decky, sans notre persona factice — le réglage du son ne peut donc pas le
    // reconnaître et ne s'applique pas à ce chemin-là.
    if (useNativeToasts()) {
      toaster.toast({ title: payload.sender || payload.title, body: payload.body, onClick: payload.onClick });
      return;
    }
  } catch {}
  chatStyleNotification(payload);
}
