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

const NATIVE_TOASTS_KEY = "steamcord_native_toasts";
export const getNativeToasts = (): boolean => {
  try { return localStorage.getItem(NATIVE_TOASTS_KEY) === "1"; } catch { return false; } // défaut OFF
};
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

function chatStyleNotification(title: string, body: string, sender?: string, avatar?: string, dm?: boolean) {
  try {
    const name = sender || title || "Steamcord";
    const { sid64, accountid } = fakeSenderSid(name);
    primeSenderPersona(sid64, accountid, name, avatar || DEFAULT_AVATAR);
    // Type 2 (FriendChatMessage) pour les MP/appels : rendu « message privé »
    // (le type 1 affichait « Message de groupe » sur un MP — retour user).
    // Type 1 (GroupChatMessage) pour les chans de serveur et les notifs système.
    // `title` du proto = nom de groupe (affiché seulement hors gamemode) : on le
    // vide quand il répéterait le pseudo déjà rendu via le persona.
    (window as any).SteamClient?.ClientNotifications?.DisplayClientNotification?.(
      dm ? 2 : 1,
      JSON.stringify({ title: title === name ? "" : title, body, state: "active", steamid: sid64 }),
      () => {},
    );
  } catch (e) {
    console.error("[Steamcord] notification failed", e);
  }
}

// Notification Steamcord : chat-style persona en mode sûr, toast Decky natif si
// le user a activé le mode natif.
export function notify(payload: { title: string; body: string; sender?: string; avatar?: string; dm?: boolean }) {
  try {
    const dpl: any = (window as any).DeckyPluginLoader;
    if (getNativeToasts() && typeof dpl?.toaster?.toast === "function") {
      dpl.toaster.toast({ title: payload.sender || payload.title, body: payload.body });
      return;
    }
  } catch {}
  chatStyleNotification(payload.title, payload.body, payload.sender, payload.avatar, payload.dm);
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
      if (getNativeToasts()) {
        return orig.call(dpl.toaster, toast);
      }
      try {
        const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : "Notification");
        // Toast d'un plugin quelconque → avatar « ? » Steam neutre, PAS le logo
        // Discord (issue #4 : AutoFlatpaks passait pour un message Discord).
        chatStyleNotification(str(toast?.title) || "Decky", str(toast?.body), undefined, NEUTRAL_AVATAR);
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
