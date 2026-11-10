import { call } from "@decky/api";
import { Dropdown } from "@decky/ui";
import { FaDiscord } from "react-icons/fa";
import { registerSteamMenu } from "../steamMenu";

// #86: the Steam menu entry can be turned off; the Quick Access panel stays.
const ENABLED_KEY = "STEAMCORD_MENU_ENTRY";
let unregister: (() => void) | undefined;

const register = () => registerSteamMenu({
  id: "steamcord", route: "/discord", label: "Steamcord", icon: <FaDiscord />, order: 10,
  onSecondary: () => {
    const choose = new (Dropdown as any)({
      rgOptions: Array.from({ length: 9 }, (_, i) => ({ label: String(i + 1), data: i + 1 })),
      selectedOption: Number(localStorage.getItem("STEAMCORD_MENU_POSITION") || 3),
      onChange: ({ data }: { data: number }) => localStorage.setItem("STEAMCORD_MENU_POSITION", String(data)),
    });
    choose.ShowMenu();
  },
});

export function menuEntryEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) !== "0"; } catch { return true; }
}

const apply = (on: boolean) => {
  if (on && !unregister) unregister = register();
  else if (!on && unregister) { unregister(); unregister = undefined; }
};

const storeLocal = (on: boolean) => {
  try { localStorage.setItem(ENABLED_KEY, on ? "1" : "0"); } catch {}
};

export function setMenuEntryEnabled(on: boolean) {
  storeLocal(on);
  // The backend copy is what counts at the next start (#86): in Game Mode,
  // Steam can stop without writing its localStorage to disk.
  call("set_open_view", null, null, null, null, on ? "on" : "off").catch(() => {});
  apply(on);
}

let started = 0;

export const patchMenu = () => {
  const run = ++started;
  call<[], { menu?: "on" | "off" | null }>("get_open_view")
    .then((b) => {
      if (run !== started) return;
      if (b?.menu === "on" || b?.menu === "off") {
        storeLocal(b.menu === "on");
        apply(b.menu === "on");
      } else {
        // First start with this version: keep the local choice and save it.
        const on = menuEntryEnabled();
        call("set_open_view", null, null, null, null, on ? "on" : "off").catch(() => {});
        apply(on);
      }
    })
    .catch(() => { if (run === started) apply(menuEntryEnabled()); });
  return () => { started++; unregister?.(); unregister = undefined; };
};
