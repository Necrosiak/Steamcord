import { DialogButton, Router } from "@decky/ui";
import { FaDiscord } from "react-icons/fa";

export function OpenDiscordButton() {
  if (!DialogButton) {
    return (
      <button onClick={() => Router.Navigate("/discord")}
        style={{ width: "100%", background: "#5865f2", color: "#fff", border: "none", borderRadius: 4, padding: "8px 12px", cursor: "pointer", fontSize: 14 }}>
        <FaDiscord style={{ marginRight: "6px" }} />
        Open Discord
      </button>
    );
  }
  return (
    <DialogButton onClick={() => Router.Navigate("/discord")} style={{ width: "100%" }}>
      <FaDiscord style={{ marginRight: "6px" }} />
      Open Discord
    </DialogButton>
  );
}
