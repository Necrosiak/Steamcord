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
interface Clip { token: string; name: string; size: number; mtime: number; too_big: boolean; }

const human = (n: number) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " Mio" : Math.round(n / 1024) + " Kio";

function ClipRow({ clip, busy, onClick }: { clip: Clip; busy: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false);
  // Trop gros = affiché mais inerte. Le masquer ferait croire que le fichier
  // n'existe pas ; le montrer avec sa taille explique le refus.
  const dead = busy || clip.too_big;
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
        {clip.name}
      </span>
      <span style={{ opacity: 0.7, fontSize: 11, flexShrink: 0 }}>
        {human(clip.size)}{clip.too_big ? " · " + t("clip_too_big") : ""}
      </span>
    </Btn>
  );
}

function ClipPickerModal({ channelId, closeModal }: { channelId: string; closeModal?: () => void }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<[], Clip[]>("list_videos").then(setClips).catch(() => setClips([]));
  }, []);

  const send = async (c: Clip) => {
    setBusy(true);
    try { await call("send_video", channelId, c.token); } catch (_) { /* le log backend tranchera */ }
    closeModal?.();
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
