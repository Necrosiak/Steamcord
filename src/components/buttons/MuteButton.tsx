import { DialogButton } from "@decky/ui";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaMicrophoneAlt, FaMicrophoneAltSlash } from "react-icons/fa";
import { call } from "@decky/api";

const btnStyle = { height: "40px", width: "40px", minWidth: 0, padding: "10px 12px", marginRight: "10px" };

export function MuteButton() {
  const state = useSteamcordState();
  const icon = state?.me?.is_muted ? <FaMicrophoneAltSlash /> : <FaMicrophoneAlt />;

  if (!DialogButton) {
    return (
      <button onClick={() => call("toggle_mute")}
        style={{ ...btnStyle, background: "#2a475e", color: "#c7d5e0", border: "none", borderRadius: 4, cursor: "pointer" }}>
        {icon}
      </button>
    );
  }
  return (
    <DialogButton onClick={() => call("toggle_mute")} style={btnStyle}>
      {icon}
    </DialogButton>
  );
}
