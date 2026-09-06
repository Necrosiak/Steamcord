// Visionneuse image / vidéo — MÊME modale Steam que le POV d'un flux live
// (FullscreenVideoModal) : vrai overlay, B ferme, habillage retiré.
import { ModalRoot, showModal } from "@decky/ui";
import { t } from "../i18n";
import { FULL_BLEED, chromeHideMarkerRef } from "./Styled";

const ModalRootAny = ModalRoot as any;

export type MediaItem = { kind: "image" | "video"; url: string; label?: string };

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
      </div>
    </ModalRootAny>
  );
}

export function openMediaLightbox(item: MediaItem) {
  showModal(<MediaLightbox item={item} />);
}
