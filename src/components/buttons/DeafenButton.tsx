import { DialogButton } from "@decky/ui";
import { useStreamcordState } from "../../hooks/useStreamcordState";
import { FaHeadphonesAlt, FaSlash } from "react-icons/fa";
import { call } from "@decky/api";

const btnStyle = { height: "40px", width: "40px", minWidth: 0, padding: "10px 12px", marginRight: "10px" };

export function DeafenButton() {
  const state = useStreamcordState();
  const icon = state?.me?.is_deafened
    ? <><FaHeadphonesAlt /><FaSlash style={{ position: "absolute", left: "13px" }} /></>
    : <FaHeadphonesAlt />;

  if (!DialogButton) {
    return (
      <button onClick={() => call("toggle_deafen")}
        style={{ ...btnStyle, background: "#2a475e", color: "#c7d5e0", border: "none", borderRadius: 4, cursor: "pointer", position: "relative" }}>
        {icon}
      </button>
    );
  }
  return (
    <DialogButton onClick={() => call("toggle_deafen")} style={btnStyle}>
      {icon}
    </DialogButton>
  );
}
