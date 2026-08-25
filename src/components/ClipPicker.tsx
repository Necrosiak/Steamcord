import { Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Btn } from "./TextChat";
import { IcFilm } from "./Icons";
import { focusHalo, ACCENT, IconBtn } from "./Styled";

const ModalRootAny = ModalRoot as any;

// #40 : @Havok027 sortait ses clips vers son téléphone pour les reposter sur
// Discord. Steam n'aide pas — ses enregistrements vivent en fragments .m4s,
// illisibles tels quels ; c'est le clip EXPORTÉ qu'on peut envoyer. Le backend
// ratisse donc les dossiers vidéo et ne rend que des jetons, jamais des chemins.
interface Clip {
  token: string; name: string; size: number; mtime: number;
  kind: "steam" | "file"; appid: string; will_convert: boolean;
}

// Un clip Steam s'appelle « clip_2584270_20260825_073545 » : illisible. On
// résout l'appid en nom de jeu par le store Steam, comme le fait déjà le QAM
// pour les jaquettes, et on retombe sur la date si le jeu est inconnu.
function clipLabel(c: Clip): string {
  if (c.kind !== "steam") return c.name;
  let game = "";
  try {
    const ov = (window as any).appStore?.GetAppOverviewByAppID?.(Number(c.appid));
    game = ov?.display_name || "";
  } catch (_) { /* store absent hors gamemode */ }
  const d = new Date(c.mtime * 1000);
  const when = d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5);
  return (game ? game + " — " : t("clip_steam") + " — ") + when;
}

const human = (n: number) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " Mio" : Math.round(n / 1024) + " Kio";

function ClipRow({ clip, busy, onClick }: { clip: Clip; busy: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false);
  // Plus de refus sur la taille : un clip Steam de 25 s pèse ~32 Mio, soit
  // trois fois la limite de Discord, donc les griser reviendrait à n'en
  // proposer aucun. Ils sont assemblés puis compressés à l'envoi.
  const dead = busy;
  return (
    <Btn
      disabled={dead}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", textAlign: "left", padding: "6px 8px", minHeight: 0,
        borderRadius: 6, marginBottom: 4, opacity: dead ? 0.45 : 1,
        display: "flex", justifyContent: "space-between", gap: 8,
        ...focusHalo(ACCENT, focused),
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {clipLabel(clip)}
      </span>
      <span style={{ opacity: 0.7, fontSize: 11, flexShrink: 0 }}>
        {human(clip.size)}{clip.will_convert ? " · " + t("clip_will_convert") : ""}
      </span>
    </Btn>
  );
}

function ClipPickerModal({ channelId, closeModal }: { channelId: string; closeModal?: () => void }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    call<[], Clip[]>("list_videos").then(setClips).catch(() => setClips([]));
  }, []);

  // L'assemblage et la compression prennent une dizaine de secondes sur un clip
  // de 25 s (le BC-250 n'a aucun encodeur matériel). Fermer la fenêtre tout de
  // suite donnerait l'impression qu'il ne s'est rien passé : on garde la main
  // et on affiche l'état jusqu'au retour du backend.
  const send = async (c: Clip) => {
    setBusy(true);
    setStatus(c.will_convert ? t("clip_converting") : t("clip_sending"));
    let ok = false;
    try { ok = !!(await call("send_video", channelId, c.token)); } catch (_) { ok = false; }
    if (ok) { closeModal?.(); return; }
    setBusy(false);
    setStatus(t("clip_failed"));
  };

  return (
    <ModalRootAny closeModal={closeModal}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t("share_clip")}</div>
      {clips === null ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>{t("loading")}</div>
      ) : clips.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>{t("clip_none")}</div>
      ) : (
        <Focusable style={{ display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto" }}>
          {status ? (
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{status}</div>
          ) : null}
          {clips.map((c) => (
            <ClipRow key={c.token} clip={c} busy={busy} onClick={() => send(c)} />
          ))}
        </Focusable>
      )}
    </ModalRootAny>
  );
}

export function ClipPickerButton({ channelId }: { channelId: string }) {
  return (
    <IconBtn
      onClick={() => showModal(<ClipPickerModal channelId={channelId} />)}
      title={t("share_clip")}
    >
      <IcFilm />
    </IconBtn>
  );
}
