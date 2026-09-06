import { DialogButton } from "@decky/ui";
import { useEffect, useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaGamepad, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { errText, t } from "../../i18n";
import { isScreenCamOn, setScreenCamOn, subscribeScreenCam } from "../../screenCam";
import { notify } from "../../notify";
import { focusHalo, ACCENT, DANGER } from "../Styled";

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
  const [err, setErr] = useState<string | null>(null);

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

  const fail = (body: string) => {
    setErr(body);
    notify({ title: t("screen_cam_start"), body });
  };

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) { await call("stop_screen_camera"); setOn(false); setScreenCamOn(false); setErr(null); }
      else {
        // stand-alone : le backend vérifie v4l2loopback et renvoie un code
        // structuré + la commande exacte pour cet OS si le module manque (au
        // lieu d'un échec muet). Le code est traduit ici (langue du user), la
        // commande est affichée verbatim ; r.hint (anglais) = fallback si un
        // vieux backend tourne encore sous un front à jour.
        // L'échec doit AUSSI s'afficher dans le panneau : le toast Steam avale
        // un hint long (guillemets/retours ligne) et le bouton paraît mort.
        const r: any = await call("start_screen_camera");
        if (r && r.ok === false) {
          const msg = r.code ? t("hint_" + r.code) : "";
          const body = (msg && msg !== "hint_" + r.code ? msg : r.hint || "v4l2loopback missing")
            + (r.cmd ? "\n" + r.cmd : "");
          fail(body);
        } else {
          setOn(true); setScreenCamOn(true); setErr(null);
        }
      }
    } catch (e) {
      fail(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
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
          color: "#fff", borderRadius: 6,
          background: on ? DANGER : (focused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.35)"),
          opacity: busy ? 0.6 : 1,
          ...focusHalo(on ? DANGER : ACCENT, focused),
        }}
      >
        {on ? <FaStop /> : <FaGamepad />}
        {on ? t("screen_cam_stop") : t("screen_cam_start")}
      </Btn>
      {err && (
        <div style={{
          marginTop: 6, fontSize: 11, color: "#ffcc66",
          whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.35,
        }}>{err}</div>
      )}
    </div>
  );
}
