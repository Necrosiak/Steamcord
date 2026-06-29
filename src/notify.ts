// Notification native Steam sûre — chemin UNIQUE pour tout Steamcord.
//
// NE PAS utiliser Decky `toaster.toast` : sur ce build de Steam ça crée des
// entrées de notif SANS `notification_type` → aucun popup ET ça FAIT PLANTER le
// panneau de notifs Steam ("Cannot read properties of undefined (reading
// 'notification_type')"). On passe par l'API NATIVE Steam avec un type qui a
// popup+son : EClientUINotificationType 1 (GroupChatMessage). Le type porte un
// vrai notification_type → plus de crash, ET popup + son OK (validé en live).
export function notify(payload: { title: string; body: string }) {
  try {
    const App = (window as any).App;
    // steamid OBLIGATOIRE : sans lui, DisplayClientNotification crée une entrée
    // malformée qui fait planter le panneau de notifs Steam → on s'abstient.
    const steamid = App?.GetCurrentUser?.()?.strSteamID || App?.m_CurrentUser?.strSteamID || "";
    if (!steamid) return;
    (window as any).SteamClient?.ClientNotifications?.DisplayClientNotification?.(
      1,
      JSON.stringify({ title: payload.title, body: payload.body, state: "active", steamid }),
      () => {},
    );
  } catch (e) {
    console.error("[Steamcord] notification failed", e);
  }
}

// Protège le PANNEAU de notifs Steam contre les crash `notification_type`. Sur ce
// build, le toaster PARTAGÉ de Decky (utilisé par Decky pour ses notifs de MAJ ET
// par des plugins tiers — ex. decky-lsfg-vk) crée des entrées SANS notification_type
// → ouvrir le panneau plante ("Cannot read properties of undefined (reading
// 'notification_type')"), et ça revient « de temps en temps » (notifs périodiques).
// On reroute TOUT toaster.toast vers la notif native sûre → plus aucun plugin ne peut
// crasher le panneau. Idempotent. Best-effort sur title/body non-string (rares).
export function patchDeckyToaster(_tries = 0) {
  try {
    const dpl: any = (window as any).DeckyPluginLoader;
    // Le toaster peut ne pas être prêt à l'init (surtout après un restart Steam) →
    // on réessaie quelques secondes pour ne jamais manquer la fenêtre de patch.
    if (!dpl?.toaster) {
      if (_tries < 40) setTimeout(() => patchDeckyToaster(_tries + 1), 500);
      return;
    }
    if (dpl.toaster.__steamcordSafe) return;
    dpl.toaster.__steamcordSafe = true;
    dpl.toaster.toast = (toast: any) => {
      try {
        const App = (window as any).App;
        const steamid = App?.GetCurrentUser?.()?.strSteamID || App?.m_CurrentUser?.strSteamID || "";
        if (!steamid) return;
        const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : "Notification");
        const title = str(toast?.title) || "Decky";
        const body = str(toast?.body);
        (window as any).SteamClient?.ClientNotifications?.DisplayClientNotification?.(
          1,
          JSON.stringify({ title, body, state: "active", steamid }),
          () => {},
        );
      } catch (e) {
        console.error("[Steamcord] safe toaster failed", e);
      }
    };
    console.log("[Steamcord] Decky toaster sécurisé (anti-crash notification_type)");
  } catch (e) {
    console.error("[Steamcord] patchDeckyToaster failed", e);
  }
}
