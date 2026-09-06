import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaMicrophoneAlt, FaMicrophoneAltSlash } from "react-icons/fa";
import { call } from "@decky/api";
import { focusHalo, DANGER, toolbarBtnStyle } from "../Styled";
import { useQamUi } from "../../qamUi";

export function MuteButton() {
  const state = useSteamcordState();
  const { px } = useQamUi();
  const [focused, setFocused] = useState(false);
  const muted = !!state?.me?.is_muted;
  const icon = muted ? <FaMicrophoneAltSlash size={px(20)} /> : <FaMicrophoneAlt size={px(20)} />;
  // Shared voice-toolbar look: white icon, solid red when active (muted),
  // SkullKey halo + glow on gamepad focus.
  const style = {
    ...toolbarBtnStyle(px),
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
