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

export function setMenuEntryEnabled(on: boolean) {
  try { localStorage.setItem(ENABLED_KEY, on ? "1" : "0"); } catch {}
  if (on && !unregister) unregister = register();
  else if (!on && unregister) { unregister(); unregister = undefined; }
}

export const patchMenu = () => {
  if (menuEntryEnabled() && !unregister) unregister = register();
  return () => { unregister?.(); unregister = undefined; };
};
