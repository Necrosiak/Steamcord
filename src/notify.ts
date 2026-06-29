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
