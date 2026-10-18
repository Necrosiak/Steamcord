import { call, addEventListener, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";

const stateListeners = new Set<(state: any) => void>();
let currentState: any;
let revision = 0;
let refreshId = 0;
let refreshing = false;
let poll: ReturnType<typeof setInterval> | undefined;
function updateState(state: any) {
  if (!state || typeof state.loaded !== "boolean") return;
  revision++;
  currentState = state;
  stateListeners.forEach(listener => listener(state));
}
function refreshState() {
  if (refreshing || !stateListeners.size) return;
  refreshing = true;
  const id = ++refreshId;
  const before = revision;
  // A stale Decky connection must not hold the fallback forever.
  const timeout = setTimeout(() => { if (id === refreshId) refreshing = false; }, 5000);
  call("get_state").then(state => {
    if (id === refreshId && before === revision && stateListeners.size) updateState(state);
  }).catch(() => {}).finally(() => {
    clearTimeout(timeout);
    if (id === refreshId) refreshing = false;
  });
}
// A confirmed local stop must replace every mounted view immediately, even
// when a Decky state event is delayed. Never infer a logout from this flag.
export function publishDiscordRuntime(enabled: boolean) {
  updateState({ ...currentState, discord_enabled: enabled,
    loaded: false, logged_in: false, vc: null });
  // On may already have completed while the control RPC was returning.
  // Reconcile instead of waiting forever for another Discord event.
  refreshId++;
  refreshing = false;
  refreshState();
}

export function useSteamcordState() {
  const [state, setState] = useState<any | undefined>(currentState);

  useEffect(() => {
    let alive = true;
    const listener = (data: any) => { if (alive) setState(data); };
    stateListeners.add(listener);
    if (currentState) listener(currentState);
    if (stateListeners.size === 1) {
      addEventListener("state", updateState);
      // One shared fallback for all views, only while a view is mounted.
      poll = setInterval(refreshState, 2000);
    }
    refreshState();

    return () => {
      alive = false;
      stateListeners.delete(listener);
      if (!stateListeners.size) {
        removeEventListener("state", updateState);
        clearInterval(poll);
        refreshId++;
        refreshing = false;
      }
    };
  }, []);

  return state;
}

export const isLoaded = () =>
  new Promise((resolve) => {
    call("get_state").then((s: any) => {
      if (s.loaded) resolve(true);
    });

    const listener = (s: any) => {
      if (s.loaded) {
        removeEventListener("state", listener);
        return resolve(true);
      }
    };
    addEventListener("state", listener);
  });

export const isLoggedIn = () =>
  new Promise((resolve) => {
    call("get_state").then((s: any) => {
      if (s.logged_in) resolve(true);
    });

    const listener = (s: any) => {
      if (s.logged_in) {
        removeEventListener("state", listener);
        return resolve(true);
      }
    };
    addEventListener("state", listener);
  });
