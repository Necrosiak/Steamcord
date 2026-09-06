import { call } from "@decky/api";
import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { FaPlug } from "react-icons/fa";
import { focusHalo, DANGER, toolbarBtnStyle } from "../Styled";
import { useQamUi } from "../../qamUi";

export function DisconnectButton() {
  const { px } = useQamUi();
  const [focused, setFocused] = useState(false);
  // Leave-call action: neutral background, red halo on focus (matches the other
  // voice-toolbar icon buttons).
  const style = {
    ...toolbarBtnStyle(px),
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 6, color: "#fff",
    background: "rgba(255,255,255,0.06)",
    ...focusHalo(DANGER, focused, 1.06),
  };
  const fh = { onFocus: () => setFocused(true), onBlur: () => setFocused(false),
               onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false) };

  if (!DialogButton) {
    return (
      <button onClick={() => call("disconnect_vc")} {...fh}
        style={{ ...style, border: "none", cursor: "pointer" }}>
        <FaPlug size={px(20)} />
      </button>
    );
  }
  return (
    <DialogButton onClick={() => call("disconnect_vc")} style={style} {...fh}>
      <FaPlug size={px(20)} />
    </DialogButton>
  );
}
