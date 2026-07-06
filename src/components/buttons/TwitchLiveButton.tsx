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
  const [focused, setFocused] = useState(false);

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

  const color = streaming ? "#ed4245" : "#9146ff";   // rouge en live, violet Twitch
  // Halo de focus explicite : un background fixe masque le surlignage natif du
  // DialogButton, donc on dessine nous-mêmes le halo blanc + lueur à la manette.
  const style = {
    ...btnStyle,
    color: "#fff",
    background: color,
    opacity: keySet ? 1 : 0.45,
    boxShadow: focused ? `0 0 0 2px #fff, 0 0 8px 2px ${color}` : "none",
    transform: focused ? "scale(1.06)" : "scale(1)",
    transition: "box-shadow .08s ease, transform .08s ease",
    borderRadius: 6,
    zIndex: focused ? 1 : 0,
  };
  const fh = { onFocus: () => setFocused(true), onBlur: () => setFocused(false) };

  if (!DialogButton) {
    return (
      <button disabled={!keySet} onClick={onClick} title="Twitch" {...fh}
        style={{ ...style, border: "none", cursor: keySet ? "pointer" : "default" }}>
        <FaTwitch />
      </button>
    );
  }
  return (
    <DialogButton disabled={!keySet} onClick={onClick} style={style} {...fh}>
      <FaTwitch />
    </DialogButton>
  );
}
