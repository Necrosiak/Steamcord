import { Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Btn } from "./TextChat";
import { IcCamera } from "./Icons";
import { focusHalo, ACCENT, IconBtn } from "./Styled";

declare const SteamClient: any;

const ModalRootAny = ModalRoot as any;

interface Shot { strUrl: string; nAppID: number; hHandle: number; nCreated: number; }

function urlContentToDataUri(url: string) {
  return fetch(url)
    .then((response) => response.blob())
    .then(
      (blob) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = function () { resolve(this.result); };
          reader.readAsDataURL(blob);
        })
    );
}

function ShotTile({ shot, busy, onClick }: { shot: Shot; busy: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Btn
      disabled={busy}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        flex: "1 1 0", padding: 0, minHeight: 0, minWidth: 0, borderRadius: 6,
        overflow: "hidden", ...focusHalo(ACCENT, focused),
      }}
    >
      <img
        src={"https://steamloopback.host/" + shot.strUrl}
        style={{ width: "100%", height: 90, objectFit: "cover", display: "block", opacity: busy ? 0.4 : 1 }}
      />
    </Btn>
  );
}

// Grille des captures récentes (tous jeux confondus, triées de la plus
// récente à la plus vieille) — clic → upload immédiat vers le salon/
// conversation cible puis fermeture. Même recette de grille que le soundboard
// (VoiceChatViews.tsx) : des rangées de N tuiles chacune dans un Focusable
// "horizontal", pas de valeur "grid" pour flow-children (jamais vue ailleurs
// dans ce codebase, pas sûr que ce soit supporté).
function ScreenshotPickerModal({ channelId, closeModal }: { channelId: string; closeModal?: () => void }) {
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [busyHandle, setBusyHandle] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    SteamClient.Screenshots.GetAllAppsLocalScreenshotsRange(0, 24)
      .then((res: Shot[]) => setShots((Array.isArray(res) ? res : []).slice().sort((a, b) => b.nCreated - a.nCreated)))
      .catch(() => setShots([]));
  }, []);

  const pick = async (shot: Shot) => {
    if (busyHandle !== null) return;
    setBusyHandle(shot.hHandle);
    try {
      const data = await urlContentToDataUri("https://steamloopback.host/" + shot.strUrl);
      await call("post_screenshot", channelId, data);
      closeModal?.();
    } catch (e) {
      setError(String(e));
      setBusyHandle(null);
    }
  };

  const ROW = 4;
  const rows: Shot[][] = [];
  if (shots) for (let i = 0; i < shots.length; i += ROW) rows.push(shots.slice(i, i + ROW));

  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      onCancelActionDescription={t("video_exit_fullscreen")}
      bAllowFullSize
    >
      <div style={{ maxWidth: 720, margin: "0 auto", width: "100%" }}>
        <div style={{
          fontSize: 16, fontWeight: 600, textAlign: "center", marginBottom: 10,
          padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.06)",
        }}>{t("select_screenshot")}</div>

        {shots === null && <div style={{ opacity: 0.6, fontSize: 13, textAlign: "center", padding: 12 }}>{t("loading")}</div>}
        {shots !== null && shots.length === 0 && <div style={{ opacity: 0.5, fontSize: 13, textAlign: "center", padding: 12 }}>{t("no_screenshots")}</div>}
        {error && <div style={{ color: "#ff6b6b", fontSize: 12, textAlign: "center", marginBottom: 6 }}>{error}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "70vh", overflowY: "auto" }}>
          {rows.map((row, i) => (
            <Focusable key={i} flow-children="row" style={{ display: "flex", gap: 6 }}>
              {row.map((s) => (
                <ShotTile key={s.hHandle} shot={s} busy={busyHandle !== null} onClick={() => pick(s)} />
              ))}
              {row.length < ROW && Array.from({ length: ROW - row.length }).map((_, j) => (
                <div key={"pad" + j} style={{ flex: "1 1 0" }} />
              ))}
            </Focusable>
          ))}
        </div>
      </div>
    </ModalRootAny>
  );
}

// Bouton compact (icône seule) à poser à côté d'Envoyer — retour user #20 :
// pas le gros bloc d'avant (titre + grande vignette + ligne cible), juste un
// déclencheur qui ouvre le sélecteur.
export function ScreenshotPickerButton({ channelId }: { channelId: string }) {
  return (
    <IconBtn
      onClick={() => showModal(<ScreenshotPickerModal channelId={channelId} />)}
      title={t("share_screenshot")}
    >
      <IcCamera />
    </IconBtn>
  );
}
