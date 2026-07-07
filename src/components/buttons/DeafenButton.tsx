import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaHeadphonesAlt, FaSlash } from "react-icons/fa";
import { call } from "@decky/api";
import { focusHalo, DANGER } from "../Styled";

const btnStyle = { height: "40px", width: "44px", minWidth: 0, padding: 0, marginRight: "6px" };

export function DeafenButton() {
  const state = useSteamcordState();
  const [focused, setFocused] = useState(false);
  const deafened = !!state?.me?.is_deafened;
  const icon = deafened
    ? <><FaHeadphonesAlt /><FaSlash style={{ position: "absolute", left: "15px" }} /></>
    : <FaHeadphonesAlt />;
  const style = {
    ...btnStyle,
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
