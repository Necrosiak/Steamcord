import { useEffect, useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaGamepad, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { errText, t } from "../../i18n";
import { isScreenCamOn, setScreenCamOn, subscribeScreenCam } from "../../screenCam";
import { notify } from "../../notify";
import { DANGER, InlineBtn, Notice } from "../Styled";


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
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribeScreenCam(() => setOn(isScreenCamOn())), []);
  // Resync avec le backend au montage : si le frontend a été rechargé, le feeder
  // peut tourner (ou être mort) sans que screenCam.ts le sache.
  useEffect(() => {
    call<[], { running: boolean }>("get_camera_preview")
      .then((r) => { if (r && typeof r.running === "boolean") { setScreenCamOn(r.running); setOn(r.running); } })
      .catch(() => {});
  }, []);

  // Disponible seulement en vocal. On teste channel_id et NON channel_name :
  // un appel en MP n’a pas de nom de salon, et le bouton de partage
  // disparaîssait donc de tous les appels privés.
  if (!state?.vc?.channel_id) return null;

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
      {/* Bouton d'action commun (#45) : ce bloc etait la 3e copie du meme
          dessin dans le plugin, avec ses tailles en dur. */}
      <InlineBtn big on={on} color={DANGER} tone="accent" disabled={busy} onClick={toggle}>
        {on ? <FaStop /> : <FaGamepad />}
        {on ? t("screen_cam_stop") : t("screen_cam_start")}
      </InlineBtn>
      {err && (
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          <Notice tone="warn">{err}</Notice>
        </div>
      )}
    </div>
  );
}
