// Visionneuse image / vidéo — MÊME modale Steam que le POV d'un flux live
// (FullscreenVideoModal) : vrai overlay, B ferme, habillage retiré.
import { DialogButton, Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useState } from "react";
import { t } from "../i18n";
import { ACCENT, FULL_BLEED, chromeHideMarkerRef, focusHalo } from "./Styled";

const ModalRootAny = ModalRoot as any;
const Btn = DialogButton as any;

export type MediaItem = { kind: "image" | "video"; url: string; label?: string };

// Enregistrement d'une pièce jointe — partagé par la visionneuse et la liste de
// fichiers du chat, pour qu'il n'existe qu'UN chemin vers le backend.
export type SaveState = "idle" | "busy" | "done" | "fail";
export async function saveAttachment(url: string, name?: string): Promise<{ ok: boolean; path?: string }> {
  try {
    const r: any = await call("save_attachment", url, name || "");
    return r?.ok ? { ok: true, path: r.path } : { ok: false };
  } catch (_) {
    return { ok: false };
  }
}

// « 4,2 Mo » plutôt que « 4404019 » : dans le QAM on lit une taille, on ne la
// compte pas. Discord ne donne pas toujours la taille → 0 signifie inconnue.
export function humanSize(n?: number): string {
  if (!n || n <= 0) return "";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : Math.round(v * 10) / 10) + " " + u[i];
}

// #43 (moi952) : « je ne peux pas télécharger une pièce jointe ». Le backend
// écrit dans le dossier Téléchargements et rend le chemin obtenu — on l'affiche,
// parce qu'en mode jeu il n'y a aucun gestionnaire de fichiers pour aller voir.
function SaveButton({ item }: { item: MediaItem }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "fail">("idle");
  const [where, setWhere] = useState("");
  const [focused, setFocused] = useState(false);
  const save = async () => {
    if (state === "busy") return;
    setState("busy");
    const r = await saveAttachment(item.url, item.label);
    if (r.ok) { setWhere(r.path || ""); setState("done"); } else setState("fail");
  };
  const label = state === "busy" ? t("media_saving")
    : state === "done" ? t("media_saved")
    : state === "fail" ? t("media_save_failed")
    : t("media_save");
  return (
    <Focusable style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <Btn
        onClick={save}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onGamepadFocus={() => setFocused(true)}
        onGamepadBlur={() => setFocused(false)}
        disabled={state === "busy" || state === "done"}
        style={{
          margin: 0, padding: "6px 18px", minHeight: 0, fontSize: 13, fontWeight: 600,
          color: "#fff", borderRadius: 6,
          background: focused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.35)",
          opacity: state === "busy" ? 0.6 : 1,
          ...focusHalo(ACCENT, focused),
        }}
      >
        {label}
      </Btn>
      {state === "done" && where ? (
        <div style={{ fontSize: 11, opacity: 0.7, wordBreak: "break-all", maxWidth: "80vw" }}>{where}</div>
      ) : null}
    </Focusable>
  );
}

export function MediaLightbox({ item, closeModal }: { item: MediaItem; closeModal?: () => void }) {
  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      onCancelActionDescription={t("video_exit_fullscreen")}
      bAllowFullSize
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, ...FULL_BLEED }}>
        <div ref={chromeHideMarkerRef} style={{ display: "none" }} />
        {item.label ? (
          <div style={{
            fontSize: 14, fontWeight: 600, padding: "6px 12px", borderRadius: 8,
            background: "rgba(0,0,0,0.55)", maxWidth: "100%",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{item.label}</div>
        ) : null}
        {item.kind === "video" ? (
          <video
            src={item.url}
            controls
            autoPlay
            playsInline
            style={{ width: "100%", maxHeight: "78vh", objectFit: "contain", background: "#000", borderRadius: 6, display: "block" }}
          />
        ) : (
          <img
            src={item.url}
            alt=""
            style={{ width: "100%", maxHeight: "78vh", objectFit: "contain", background: "#000", borderRadius: 6, display: "block" }}
          />
        )}
        <SaveButton item={item} />
      </div>
    </ModalRootAny>
  );
}

export function openMediaLightbox(item: MediaItem) {
  showModal(<MediaLightbox item={item} />);
}
