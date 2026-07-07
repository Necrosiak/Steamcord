import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaMicrophoneAlt, FaMicrophoneAltSlash } from "react-icons/fa";
import { call } from "@decky/api";
import { focusHalo, DANGER } from "../Styled";

const btnStyle = { height: "40px", width: "44px", minWidth: 0, padding: 0, marginRight: "6px" };

export function MuteButton() {
  const state = useSteamcordState();
  const [focused, setFocused] = useState(false);
  const muted = !!state?.me?.is_muted;
  const icon = muted ? <FaMicrophoneAltSlash /> : <FaMicrophoneAlt />;
  // Shared voice-toolbar look: white icon, solid red when active (muted),
  // SkullKey halo + glow on gamepad focus.
  const style = {
    ...btnStyle,
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 6, color: "#fff",
    background: muted ? DANGER : "rgba(255,255,255,0.06)",
    ...focusHalo(DANGER, focused, 1.06),
  };
  const fh = { onFocus: () => setFocused(true), onBlur: () => setFocused(false),
               onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false) };

  if (!DialogButton) {
    return (
      <button onClick={() => call("toggle_mute")} {...fh}
        style={{ ...style, border: "none", cursor: "pointer" }}>
        {icon}
      </button>
    );
  }
  return (
    <DialogButton onClick={() => call("toggle_mute")} style={style} {...fh}>
      {icon}
    </DialogButton>
  );
}
