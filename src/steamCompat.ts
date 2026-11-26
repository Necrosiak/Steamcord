import { replacePatch, callOriginal } from "@decky/ui";
// Guarded reads of Steam's undocumented integration points. No shared object
// replacement: callers get null/false when a Steam build lacks a capability.
export function readSteamPersona(): number | null {
  try {
    const store = (window as any).friendStore?.m_FriendsUIFriendStore;
    const value = store?.m_eUserPersonaState ?? store?.GetPersonaStatePreference?.();
    return typeof value === "number" ? value : null;
  } catch { return null; }
}

export function getMainMenuWindow(): Window | null {
  try {
    const nav = (window as any).FocusNavController;
    const context = nav?.m_ActiveContext || nav?.m_LastActiveContext;
    const trees = context?.m_rgGamepadNavigationTrees;
    const tree = Array.isArray(trees) ? trees.find((item: any) => (item.m_ID || item.id) === "MainNavMenuContainer") : null;
    return (tree?.Root?.Element || tree?.m_Root?.m_element)?.ownerDocument?.defaultView ?? null;
  } catch { return null; }
}

export function resizeDiscordView(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  try {
    const tab = (window as any).DISCORD_TAB;
    if (typeof tab?.m_browserView?.SetBounds !== "function") return false;
    tab.m_browserView.SetBounds(0, 0, width, height);
    tab.WIDTH = width; tab.HEIGHT = height;
    return true;
  } catch { return false; }
}

export function steamIntegrationStatus(): Record<string, boolean> {
  const w = window as any;
  const available = (probe: () => boolean) => { try { return probe(); } catch { return false; } };
  return {
    menu_window: getMainMenuWindow() !== null,
    persona_state: readSteamPersona() !== null,
    browser_view: available(() => typeof w.DISCORD_TAB?.m_browserView?.SetBounds === "function"),
    notification_sound: available(() => typeof w.NotificationStore?.PlayNotificationSound === "function"),
    notification_render_state: available(() => typeof w.NotificationStore?.BAnyContextRenderingToasts === "function"),
    friend_persona: available(() => typeof w.friendStore?.GetFriendState === "function"),
  };
}

export function notificationStore(): any | null {
  try { return (window as any).NotificationStore || null; } catch { return null; }
}

export function syntheticPersona(sid64: string, accountid: number): any | null {
  try {
    const store = (window as any).friendStore;
    if (typeof store?.GetFriendState !== "function") return null;
    return store.GetFriendState({ GetAccountID: () => accountid,
      ConvertTo64BitString: () => sid64, BIsValid: () => true })?.m_persona ?? null;
  } catch { return null; }
}

export function setSyntheticPersona(sid64: string, accountid: number, name: string, avatar?: string): boolean {
  const persona = syntheticPersona(sid64, accountid);
  if (!persona) return false;
  try { if (persona.m_strPlayerName !== name) persona.m_strPlayerName = name; } catch {}
  if (avatar !== undefined) for (const key of ["avatar_url_small", "avatar_url_medium", "avatar_url_full"]) {
    try { Object.defineProperty(persona, key, { get: () => avatar, configurable: true }); } catch {}
  }
  return true;
}

let soundGuard: { store: any; patch: any; active: boolean } | null = null;

export function disposeNotificationSoundGuard(): void {
  if (!soundGuard) return;
  const owned = soundGuard;
  soundGuard = null;
  owned.active = false;
  // Unpatch through Decky's chain only. An untracked foreign wrapper must
  // never be overwritten just to restore our old reference.
  try {
    let fn = owned.store?.PlayNotificationSound;
    const seen = new Set<any>();
    while (typeof fn === "function" && !seen.has(fn)) {
      seen.add(fn);
      if (fn === owned.patch.patchedFunction) {
        try { if (!owned.patch.hasUnpatched) owned.patch.unpatch(); } catch {}
        return;
      }
      fn = fn.__deckyPatch?.original;
    }
  } catch { /* The stale store can disappear during a Steam reload. */ }
}

export function guardNotificationSound(shouldMute: (notification: any) => boolean): boolean {
  try {
    const store = notificationStore();
    if (typeof store?.PlayNotificationSound !== "function") return false;
    const current = soundGuard;
    if (current && current.store === store && store.PlayNotificationSound === current.patch.patchedFunction) return true;
    disposeNotificationSoundGuard();
    const owned = { store, patch: null as any, active: true };
    owned.patch = replacePatch(store, "PlayNotificationSound", (args: any[]) => {
      try { if (owned.active && shouldMute(args[0])) return undefined; } catch {}
      return callOriginal;
    });
    soundGuard = owned;
    return true;
  } catch { return false; }
}
