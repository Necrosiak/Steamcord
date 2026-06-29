import { call } from "@decky/api";
import { Toggle } from "@decky/ui";
import { useState } from "react";
import { notify } from "../../notify";

const PTT_BUTTON = 33;

export function PushToTalkButton() {
  const [pttEnabled, setPtt] = useState<boolean>(false);
  let unregisterPtt: any;

  const onToggle = (checked: boolean) => {
    setPtt(checked);
    if (!pttEnabled) {
      call("enable_ptt", true);
      notify({ title: "Push-To-Talk", body: "Hold down the R5 button to talk" });
      unregisterPtt = SteamClient.Input.RegisterForControllerInputMessages(
        (events: any) => {
          for (const event of events)
            if (event.nA == PTT_BUTTON)
              call("set_ptt", event.bS);
        }
      ).unregister;
    } else {
      unregisterPtt();
      call("enable_ptt", false);
    }
  };

  if (!Toggle) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        PTT:
        <button
          onClick={() => onToggle(!pttEnabled)}
          style={{
            background: pttEnabled ? "#23a55a" : "#444",
            color: "#fff", border: "none", borderRadius: 4,
            padding: "4px 10px", cursor: "pointer", fontSize: 13
          }}
        >
          {pttEnabled ? "ON" : "OFF"}
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: "flex" }}>
      PTT:{" "}
      <Toggle value={pttEnabled} onChange={onToggle} />
    </span>
  );
}
