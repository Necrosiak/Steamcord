import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaHeadphonesAlt, FaSlash } from "react-icons/fa";
import { call } from "@decky/api";
import { focusHalo, DANGER, toolbarBtnStyle } from "../Styled";
import { useQamUi } from "../../qamUi";

export function DeafenButton() {
  const state = useSteamcordState();
  const { px } = useQamUi();
  const [focused, setFocused] = useState(false);
  const deafened = !!state?.me?.is_deafened;
  const icon = deafened
    ? <><FaHeadphonesAlt size={px(20)} /><FaSlash size={px(20)} style={{ position: "absolute", left: px(16) }} /></>
    : <FaHeadphonesAlt size={px(20)} />;
  const style = {
    ...toolbarBtnStyle(px),
    display: "flex", alignItems: "center", justifyContent: "center", position: "relative" as const,
    borderRadius: 6, color: "#fff",
    background: deafened ? DANGER : "rgba(255,255,255,0.06)",
    ...focusHalo(DANGER, focused, 1.06),
  };
  const fh = { onFocus: () => setFocused(true), onBlur: () => setFocused(false),
               onGamepadFocus: () => setFocused(true), onGamepadBlur: () => setFocused(false) };

  if (!DialogButton) {
    return (
      <button onClick={() => call("toggle_deafen")} {...fh}
        style={{ ...style, border: "none", cursor: "pointer" }}>
        {icon}
      </button>
    );
  }
  return (
    <DialogButton onClick={() => call("toggle_deafen")} style={style} {...fh}>
      {icon}
    </DialogButton>
  );
}
