import { DialogButton } from "@decky/ui";
import { useEffect, useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaGamepad, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { t } from "../../i18n";
import { isScreenCamOn, setScreenCamOn, subscribeScreenCam } from "../../screenCam";

const Btn = DialogButton as any;

// Partage d'écran en MODE JEU : gamescope n'a pas de portail → Go Live = écran noir.
// On capture le node PipeWire gamescope → webcam virtuelle (/dev/video42), utilisée
// comme caméra Discord. Voir gst_camera.py + start_screen_camera (backend).
export function ScreenCameraButton() {
  const state = useSteamcordState();
  // L'état vit dans screenCam.ts (survit au démontage du QAM) : un useState local
  // repartirait à false à chaque réouverture alors que le stream tourne encore.
  const [on, setOn] = useState(isScreenCamOn());
  const [busy, setBusy] = useState(false);
  // Focus géré nous-mêmes (cf GoLiveButton) : texte blanc forcé + halo, sinon le
  // focus natif rend le texte illisible.
  const [focused, setFocused] = useState(false);

  useEffect(() => subscribeScreenCam(() => setOn(isScreenCamOn())), []);
  // Resync avec le backend au montage : si le frontend a été rechargé, le feeder
  // peut tourner (ou être mort) sans que screenCam.ts le sache.
  useEffect(() => {
    call<[], { running: boolean }>("get_camera_preview")
      .then((r) => { if (r && typeof r.running === "boolean") { setScreenCamOn(r.running); setOn(r.running); } })
      .catch(() => {});
  }, []);

  // Disponible seulement en vocal.
  if (!state?.vc?.channel_name) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) { await call("stop_screen_camera"); setOn(false); setScreenCamOn(false); }
      else { await call("start_screen_camera"); setOn(true); setScreenCamOn(true); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Btn
      onClick={toggle}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", margin: 0, padding: "6px 0", minHeight: 0,
        boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        fontSize: 12, fontWeight: 600,
        color: "#fff",
        background: on ? "#ed4245" : (focused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.35)"),
        boxShadow: focused ? "inset 0 0 0 2px #fff" : "none",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {on ? <FaStop /> : <FaGamepad />}
      {on ? t("screen_cam_stop") : t("screen_cam_start")}
    </Btn>
  );
}
