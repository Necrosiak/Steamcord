import { Dropdown } from "@decky/ui";
import { FaDiscord } from "react-icons/fa";
import { registerSteamMenu } from "../steamMenu";

export const patchMenu = () => registerSteamMenu({
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
