import { call } from "@decky/api";
import { DialogButton } from "@decky/ui";
import { FaPlug } from "react-icons/fa";

const btnStyle = { height: "40px", width: "40px", minWidth: 0, padding: "10px 12px", marginRight: "10px" };

export function DisconnectButton() {
  if (!DialogButton) {
    return (
      <button onClick={() => call("disconnect_vc")}
        style={{ ...btnStyle, background: "#2a475e", color: "#c7d5e0", border: "none", borderRadius: 4, cursor: "pointer" }}>
        <FaPlug />
      </button>
    );
  }
  return (
    <DialogButton onClick={() => call("disconnect_vc")} style={btnStyle}>
      <FaPlug />
    </DialogButton>
  );
}
