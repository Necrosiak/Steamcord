import { DialogButton } from "@decky/ui";
import { FaTwitch } from "react-icons/fa";
import { call } from "@decky/api";
import { useState, useEffect } from "react";

// Go-live toggle for Twitch, styled like the other voice-control icon buttons.
// Purple = ready (Twitch), red = live. Disabled until a stream key is saved
// (in the Config tab). Polls the backend so the state follows an external
// start/stop too.
const btnStyle = { height: "40px", width: "40px", minWidth: 0, padding: "10px 12px", marginRight: "10px" };

export function TwitchLiveButton() {
  const [streaming, setStreaming] = useState(false);
  const [keySet, setKeySet] = useState(false);

  const refresh = () =>
    call("get_twitch_config").then((c: any) => {
      setStreaming(!!c?.streaming);
      setKeySet(!!c?.key_set);
    }).catch(() => {});

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  const onClick = () => {
    (streaming ? call("stop_twitch_stream") : call("start_twitch_stream"))
      .then(refresh).catch(() => {});
  };

  const style = {
    ...btnStyle,
    color: "#fff",
    background: streaming ? "#ed4245" : "#9146ff",   // rouge en live, violet Twitch sinon
    opacity: keySet ? 1 : 0.45,
  };

  if (!DialogButton) {
    return (
      <button disabled={!keySet} onClick={onClick} title="Twitch"
        style={{ ...style, border: "none", borderRadius: 4, cursor: keySet ? "pointer" : "default" }}>
        <FaTwitch />
      </button>
    );
  }
  return (
    <DialogButton disabled={!keySet} onClick={onClick} style={style}>
      <FaTwitch />
    </DialogButton>
  );
}
