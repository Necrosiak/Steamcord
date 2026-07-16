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

// Rendu de secours : notif native Steam type GroupChatMessage. steamid
// OBLIGATOIRE : sans lui, DisplayClientNotification crée une entrée malformée
// qui fait planter le panneau de notifs Steam → on s'abstient.
function chatStyleNotification(title: string, body: string) {
  try {
    const App = (window as any).App;
    const steamid = App?.GetCurrentUser?.()?.strSteamID || App?.m_CurrentUser?.strSteamID || "";
    if (!steamid) return;
    (window as any).SteamClient?.ClientNotifications?.DisplayClientNotification?.(
      1,
      JSON.stringify({ title, body, state: "active", steamid }),
      () => {},
    );
  } catch (e) {
    console.error("[Steamcord] notification failed", e);
  }
}

// Notification Steamcord : passe par le toaster (wrappé) → suit le mode choisi.
export function notify(payload: { title: string; body: string }) {
  try {
    const dpl: any = (window as any).DeckyPluginLoader;
    if (typeof dpl?.toaster?.toast === "function") {
      dpl.toaster.toast({ title: payload.title, body: payload.body });
      return;
    }
  } catch {}
  chatStyleNotification(payload.title, payload.body); // toaster pas prêt (boot)
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
        chatStyleNotification(str(toast?.title) || "Decky", str(toast?.body));
      } catch (e) {
        console.error("[Steamcord] safe toaster failed", e);
      }
    };
    // Entrées natives restantes (toasts d'avant le patch, ou session native
    // précédente sur un build qui plante) → purge en mode sûr.
    if (!getNativeToasts()) sweepDeckyTrayGroups();
    console.log("[Steamcord] Decky toaster sécurisé (mode " + (getNativeToasts() ? "natif" : "sûr") + ")");
  } catch (e) {
    console.error("[Steamcord] patchDeckyToaster failed", e);
  }
}
