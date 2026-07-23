import { DialogButton, Focusable, ModalRoot, showModal } from "@decky/ui";
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { getStream, getTrackKind, isWatching, stopVideo, subscribe, watchVideo } from "../videoRelay";
import { useSteamcordState } from "../hooks/useSteamcordState";
import { IcCameraVideo, IcFilm, IcMicMuteFill, IcMonitor } from "./Icons";
import { focusHalo, ACCENT, FULL_BLEED, chromeHideMarkerRef } from "./Styled";
import { FullscreenVideoModal } from "./VoiceChatViews";

const ModalRootAny = ModalRoot as any;
const Btn = DialogButton as any;

// Une seule grille ouverte à la fois (showModal) : suivi module-level des
// relais démarrés PAR la grille, pour ne couper qu'eux à la fermeture — un
// « Voir » déjà actif dans le panneau QAM survit à l'ouverture/fermeture.
let _gridStarted = new Set<string>();

const kindIcon = (kind?: string) =>
  kind === "screen" ? <IcMonitor /> : kind === "camera" ? <IcCameraVideo /> : kind ? <IcFilm /> : null;

// Anneau « en train de parler » (même vert que le halo d'avatar du QAM) —
// combiné au halo de focus manette quand les deux sont actifs.
const speakRing = (speaking: boolean, focused: boolean) => ({
  boxShadow: [
    speaking ? "inset 0 0 0 3px #23a55a, 0 0 12px 2px rgba(35,165,90,0.6)" : "",
    focused ? "inset 0 0 0 2px " + ACCENT : "",
  ].filter(Boolean).join(", ") || "none",
});

// Étiquette commune : type de flux, pseudo, badge micro coupé, pastille voix.
function TileLabel({ user, kind }: { user: any; kind?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 5,
      fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 6,
      background: "rgba(0,0,0,0.55)", color: "#fff", maxWidth: "100%", boxSizing: "border-box",
    }}>
      {kindIcon(kind)}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.username}</span>
      {(user.is_muted || user.is_deafened) && <IcMicMuteFill color="#ed4245" size={11} />}
      <div style={{
        width: 7, height: 7, borderRadius: "50%", background: "#23a55a", flexShrink: 0,
        boxShadow: "0 0 5px 1px rgba(35,165,90,0.8)",
        opacity: user.is_speaking ? 1 : 0, transition: "opacity 0.08s ease-out",
      }} />
    </div>
  );
}

// Tuile vidéo (une PISTE) : A = plein écran sur cette POV (modale empilée,
// B revient à la grille). Wrapper Btn, pas Focusable brut (leçon v1.16.7 :
// seul DialogButton est un arrêt de nav fiable avec tracking de focus custom).
function VideoTile({ user, kind, track }: { user: any; kind: string; track: MediaStreamTrack }) {
  const [focused, setFocused] = useState(false);
  const ms = useMemo(() => new MediaStream([track]), [track]);
  const ref = (el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== ms) { el.srcObject = ms; (el as any).play?.().catch(() => {}); }
  };
  return (
    <Btn
      onClick={() => showModal(
        <FullscreenVideoModal track={track} label={<>{kindIcon(kind)} {user.username}</>} />
      )}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        position: "relative", background: "#000", borderRadius: 8, overflow: "hidden",
        padding: 0, margin: 0, minHeight: 0, width: "100%", height: "100%", color: "#fff",
        ...speakRing(!!user.is_speaking, focused),
      }}
    >
      <video
        ref={ref}
        autoPlay muted playsInline
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />
      <div style={{ position: "absolute", top: 6, left: 6, right: 6, display: "flex" }}>
        <TileLabel user={user} kind={kind} />
      </div>
    </Btn>
  );
}

// Tuile avatar : participant connecté SANS diffusion en cours — présent dans
// la grille pour qu'on voie qui est là et qui parle (demande user : « on ne
// sait pas qui parle »). Pas d'action au A, et pas un arrêt de nav (rien à y
// faire) — la nav ne circule qu'entre les vraies POV.
function AvatarTile({ user }: { user: any }) {
  return (
    <div style={{
      // Carte pleine (pas un simple voile translucide : l'avatar semblait
      // flotter dans le vide sur le fond sombre — vu sur capture).
      position: "relative", background: "#14171c", borderRadius: 8,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 10, minHeight: 0, ...speakRing(!!user.is_speaking, false),
    }}>
      <img
        src={user?.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=128`
          : `https://cdn.discordapp.com/embed/avatars/0.png`}
        width={72} height={72}
        style={{
          borderRadius: "50%",
          boxShadow: user.is_speaking
            ? "0 0 0 3px #23a55a, 0 0 12px 3px rgba(35,165,90,0.75)"
            : "0 0 0 3px transparent",
          transition: "box-shadow 0.08s ease-out",
        }}
      />
      <TileLabel user={user} />
    </div>
  );
}

// Grille multi-POV plein écran : TOUS les participants du vocal — une tuile
// par PISTE diffusée (écran et caméra séparés) + une tuile avatar pour ceux
// qui ne diffusent pas. A sur une POV = plein écran individuel (B revient).
// Les relais sont démarrés en NON-exclusif : la capture côté client lit les
// pistes du moteur média par user (issue #8), plusieurs relais cohabitent —
// l'exclusivité du QAM est un choix d'UI de panneau étroit, pas une limite.
// ⚠️ Chaque relais = un encodage/décodage logiciel de plus (pas de VCN sur
// BC-250) : la grille assume ce coût, c'est son usage.
export function VideoGridModal({ closeModal }: { closeModal?: () => void }) {
  const state = useSteamcordState();
  const meId = state?.me?.id;
  const users: any[] = state?.vc?.users || [];
  const liveUsers = users.filter((u) => u.id !== meId && (u.is_live || u.is_video));
  // Re-render à chaque évolution du relais (piste arrivée/remplacée/morte).
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((n) => n + 1)), []);

  // Watch de tous les participants vidéo-actifs ; suit aussi les changements en
  // cours de route (nouvelle diffusion → nouvelle tuile, arrêt → relais coupé).
  const liveIds = liveUsers.map((u) => u.id).join(",");
  useEffect(() => {
    for (const u of liveUsers) {
      if (!isWatching(u.id)) { _gridStarted.add(u.id); watchVideo(u.id, { exclusive: false }); }
    }
    for (const id of Array.from(_gridStarted)) {
      if (!liveUsers.some((u) => u.id === id)) { _gridStarted.delete(id); stopVideo(id); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds]);
  useEffect(() => () => {
    for (const id of Array.from(_gridStarted)) stopVideo(id);
    _gridStarted = new Set();
  }, []);


  // Une tuile par piste vivante ; les participants sans piste (pas de diff,
  // relais pas encore connecté, ou soi-même) ont une tuile avatar.
  const tiles: { key: string; user: any; kind?: string; track?: MediaStreamTrack }[] = [];
  for (const u of users) {
    let hasVideo = false;
    if (u.id !== meId && (u.is_live || u.is_video)) {
      const ms = getStream(u.id);
      for (const trk of ms?.getVideoTracks() || []) {
        if (trk.readyState !== "live") continue;
        hasVideo = true;
        tiles.push({ key: u.id + ":" + trk.id, user: u, kind: getTrackKind(u.id, trk.id), track: trk });
      }
    }
    if (!hasVideo) tiles.push({ key: u.id, user: u });
  }
  // La grille s'adapte au nombre de tuiles (POV + avatars) : 1 / 2 / 3 / 4
  // colonnes, les rangées se partagent la hauteur à parts égales.
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4;

  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      onCancelActionDescription={t("video_exit_fullscreen")}
      bAllowFullSize
    >
      {/* FULL_BLEED : déborde du cadre ~573px du dialog (cf. Styled.tsx). Les
          ancêtres overflow:hidden font toute la fenêtre, rien n'est clippé
          (vérifié en live au CDP). */}
      <Focusable
        flow-children="grid"
        style={{
          display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: "1fr",
          gap: 8, height: "80vh", ...FULL_BLEED,
        }}
      >
        {/* Marqueur chrome-hide (cf. Styled.tsx) ; display:none = ignoré par
            la grille CSS. */}
        <div ref={chromeHideMarkerRef} style={{ display: "none" }} />
        {tiles.map((tl) => tl.track
          ? <VideoTile key={tl.key} user={tl.user} kind={tl.kind!} track={tl.track} />
          : <AvatarTile key={tl.key} user={tl.user} />)}
        {tiles.length === 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.6, fontSize: 14 }}>
            {t("video_grid_waiting")}
          </div>
        )}
      </Focusable>
    </ModalRootAny>
  );
}
