import { call } from "@decky/api";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useSteamcordState } from "../hooks/useSteamcordState";
import { t } from "../i18n";
import {
  IcCameraVideo, IcController, IcFilm, IcMic, IcMicMute, IcMicMuteFill,
  IcMonitor, IcSpeaker, IcSpeakerMuteFill,
} from "./Icons";
import { SliderField, DialogButton, ModalRoot, showModal } from "@decky/ui";
import { watchVideo, stopVideo, isWatching, getStream, getTrackKind, subscribe } from "../videoRelay";
import { isScreenCamOn, subscribeScreenCam, startSelfPreview } from "../screenCam";
import { focusHalo, ACCENT, DANGER } from "./Styled";

// Réagit à l'arrivée du flux vidéo relayé (Vesktop→QAM) pour cet utilisateur.
function useRemoteVideo(userId: string) {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return { stream: getStream(userId), watching: isWatching(userId) };
}

// Tuile vidéo : on branche le MediaStream reçu sur l'élément <video>. Muet : le son
// de l'appel est déjà audible via la sortie de Vesktop (on ne relaie que la vidéo).
function VideoTile({ stream }: { stream: MediaStream }) {
  const ref = useCallback((el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      (el as any).play?.().catch(() => {});
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      style={{ width: "100%", borderRadius: 6, marginTop: 6, background: "#000", display: "block" }}
    />
  );
}

// Libellé humain d'une piste selon son kind (transmis par le client dans la meta
// de l'offre : écran vs caméra — issue #8, on n'affiche plus de tuiles anonymes).
const trackLabel = (kind: string) =>
  kind === "screen" ? <><IcMonitor /> {t("video_kind_screen")}</>
    : kind === "camera" ? <><IcCameraVideo /> {t("video_kind_camera")}</> : <IcFilm />;

// Une tuile par PISTE vidéo : un participant peut diffuser ÉCRAN + CAMÉRA en même
// temps (2 pistes dans le même MediaStream) → on les affiche séparément (un <video>
// ne joue qu'une piste), chacune avec son libellé et SON bouton plein écran
// (retour David #8 : « choose between the screen and camera to fullscreen, not
// both »). Stream stable par piste pour ne pas re-brancher à chaque rendu.
function SingleTrackTile({ userId, track, onFullscreen }:
  { userId: string; track: MediaStreamTrack; onFullscreen: () => void }) {
  const ms = useMemo(() => new MediaStream([track]), [track]);
  const [fsFocused, setFsFocused] = useState(false);
  return (
    <div>
      <VideoTile stream={ms} />
      <Btn
        onClick={onFullscreen}
        onFocus={() => setFsFocused(true)}
        onBlur={() => setFsFocused(false)}
        onGamepadFocus={() => setFsFocused(true)}
        onGamepadBlur={() => setFsFocused(false)}
        style={{
          width: "100%", margin: "2px 0 0", padding: "4px 0", minHeight: 0, fontSize: 10, fontWeight: 600,
          borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          color: "#fff",
          background: fsFocused ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)",
          ...focusHalo(ACCENT, fsFocused),
        }}
      >
        <>⛶ {trackLabel(getTrackKind(userId, track.id))}</>
      </Btn>
    </div>
  );
}
function MultiVideoTiles({ userId, stream, onFullscreen }:
  { userId: string; stream: MediaStream; onFullscreen: (trackId: string) => void }) {
  const tracks = stream.getVideoTracks();
  return (
    <>
      {tracks.map((trk) => (
        <SingleTrackTile key={trk.id} userId={userId} track={trk} onFullscreen={() => onFullscreen(trk.id)} />
      ))}
    </>
  );
}

const ModalRootAny = ModalRoot as any;

// Plein écran : UNE SEULE piste (choisie par sa tuile), dans une VRAIE modale
// Steam (showModal/ModalRoot — même mécanisme que les menus SkullKey). Un
// overlay position:fixed ne sort JAMAIS du panneau QAM : gamescope ne composite
// que la bande de droite (vérifié par capture CEF vs écran réel — la page se
// croyait plein écran, le user voyait une tranche). La modale, elle, est rendue
// par Steam par-dessus tout l'écran, et le bouton B la ferme nativement
// (onCancel) — exactement la maquette « window popup » de David (#8).
function FullscreenVideoModal({ track, label, closeModal }:
  { track: MediaStreamTrack; label: ReactNode; closeModal?: () => void }) {
  const ms = useMemo(() => new MediaStream([track]), [track]);
  // La piste meurt (partage coupé pendant le plein écran) → on se referme au
  // lieu de laisser une image figée.
  useEffect(() => {
    const iv = setInterval(() => { if (track.readyState === "ended") closeModal?.(); }, 1000);
    return () => clearInterval(iv);
  }, [track]);
  const ref = useCallback((el: HTMLVideoElement | null) => {
    if (el && el.srcObject !== ms) { el.srcObject = ms; (el as any).play?.().catch(() => {}); }
  }, [ms]);
  return (
    <ModalRootAny closeModal={closeModal} onCancel={() => closeModal?.()} bAllowFullSize>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
        <video
          ref={ref}
          autoPlay muted playsInline
          style={{ width: "100%", maxHeight: "72vh", objectFit: "contain", background: "#000", borderRadius: 6, display: "block" }}
        />
        <div style={{ fontSize: 11, opacity: 0.6 }}>{`${t("video_exit_fullscreen")} (B)`}</div>
      </div>
    </ModalRootAny>
  );
}

const SliderFieldAny = SliderField as any;
const Btn = DialogButton as any;

// Aperçu LOCAL de mon propre partage d'écran (mode jeu). On lit la caméra
// virtuelle "Steamcord Screen" (/dev/video42). Le feeder GStreamer met quelques
// secondes à créer/alimenter le device → on réessaie jusqu'à obtenir un flux.
function SelfPreviewTile() {
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Aperçu de secours : le CEF de Steam refuse getUserMedia sur la caméra
  // virtuelle en gamescope (vu 02/07 : pipeline OK mais préviz « give up »).
  // Le feeder écrit un instantané JPEG toutes les 2s → on le polle au backend.
  const [snap, setSnap] = useState("");
  const [feederUp, setFeederUp] = useState<boolean | null>(null);
  // Après ~16s (8 essais à 2s) sans device NI instantané, c'est qu'on n'est
  // PAS en vraie session gamescope (le feeder ne crée jamais /dev/video42) →
  // on le DIT clairement au lieu d'un « démarrage… » silencieux à l'infini.
  const [giveUp, setGiveUp] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: any;
    let tries = 0;
    const tryOpen = async () => {
      const s = await startSelfPreview();
      if (!alive) return;
      if (s) { setStream(s); return; }
      tries += 1;
      if (tries >= 8) setGiveUp(true);
      timer = setTimeout(tryOpen, 2000); // device pas encore prêt
    };
    tryOpen();
    const poll = setInterval(async () => {
      try {
        const r = await call<[], { running: boolean; jpg: string }>("get_camera_preview");
        if (!alive) return;
        setFeederUp(r.running);
        if (r.jpg) setSnap(r.jpg);
      } catch (_) { /* backend pas prêt : on retentera */ }
    }, 2000);
    return () => { alive = false; if (timer) clearTimeout(timer); clearInterval(poll); };
  }, []);

  if (stream) return <VideoTile stream={stream} />;
  if (snap) {
    return (
      <img
        src={"data:image/jpeg;base64," + snap}
        style={{ width: "100%", borderRadius: 6, marginTop: 6, display: "block" }}
      />
    );
  }
  if (giveUp && feederUp === false) {
    return (
      <div style={{ fontSize: 10, color: "#ffb74d", padding: "6px 4px", lineHeight: 1.35 }}>
        {t("self_preview_nogamemode")}
      </div>
    );
  }
  return <div style={{ fontSize: 10, opacity: 0.6, textAlign: "center", padding: "6px 0" }}>{t("self_preview_wait")}</div>;
}

// Aperçu LOCAL de mon Go Live NATIF (portail). La capture vit dans le Chromium
// de Vesktop → aucun flux accessible d'ici : le backend lance gst_preview.py
// (node gamescope → JPEG/2s) tant que cette tuile est montée, et on polle
// l'instantané comme pour l'aperçu mode jeu.
function GoLivePreviewTile() {
  const [snap, setSnap] = useState("");
  // Diagnostic honnête (issue #12 : « Starting Preview… » éternel sur SteamOS) :
  // si le backend dit qu'il ne PEUT PAS capturer (bindings GStreamer absents et
  // pas de fallback), on affiche le hint structuré {code, cmd} comme le bouton
  // caméra ; si le feeder est censé tourner mais ne produit jamais (running
  // false sur 8 polls), on le dit au lieu d'attendre en silence.
  const [hint, setHint] = useState<{ code?: string; cmd?: string } | null>(null);
  const [giveUp, setGiveUp] = useState(false);
  useEffect(() => {
    let alive = true;
    let downPolls = 0;
    call<[], { ok: boolean; code?: string; cmd?: string }>("start_golive_preview")
      .then((r) => { if (alive && r && r.ok === false) setHint(r); })
      .catch(() => {});
    const poll = setInterval(async () => {
      try {
        const r = await call<[], { running: boolean; jpg: string }>("get_golive_preview");
        if (!alive) return;
        if (r.jpg) { setSnap(r.jpg); setGiveUp(false); downPolls = 0; return; }
        downPolls = r.running ? 0 : downPolls + 1;
        if (downPolls >= 16) setGiveUp(true);
      } catch (_) { /* backend pas prêt : on retentera */ }
    }, 1000); // ~1 fps : suit la cadence resserrée du backend (issue #12)
    return () => {
      alive = false;
      clearInterval(poll);
      call("stop_golive_preview").catch(() => {});
    };
  }, []);
  if (snap) {
    return (
      <img
        src={"data:image/jpeg;base64," + snap}
        style={{ width: "100%", borderRadius: 6, marginTop: 6, display: "block" }}
      />
    );
  }
  if (hint) {
    const msg = hint.code ? t("hint_" + hint.code) : "";
    return (
      <div style={{ fontSize: 10, color: "#ffb74d", padding: "6px 4px", lineHeight: 1.35 }}>
        {msg && msg !== "hint_" + hint.code ? msg : t("self_preview_failed")}
        {hint.cmd && (
          <code style={{ display: "block", marginTop: 4, userSelect: "text", wordBreak: "break-all" }}>
            {hint.cmd}
          </code>
        )}
      </div>
    );
  }
  if (giveUp) {
    return (
      <div style={{ fontSize: 10, color: "#ffb74d", padding: "6px 4px", lineHeight: 1.35 }}>
        {t("self_preview_failed")}
      </div>
    );
  }
  return <div style={{ fontSize: 10, opacity: 0.6, textAlign: "center", padding: "6px 0" }}>{t("self_preview_wait")}</div>;
}

// Réagit aux changements d'état du partage d'écran (on/off).
function useScreenCam() {
  const [, force] = useState(0);
  useEffect(() => subscribeScreenCam(() => force((n) => n + 1)), []);
  return isScreenCamOn();
}

export function VoiceChatChannel() {
  const state = useSteamcordState();
  if (!state?.vc) return <div />;
  // DM calls have no guild — the backend sends null and we localize the label.
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{state.vc.channel_name || t("private_message")}</span>
      <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 6 }}>{state.vc.guild_name || t("private_message")}</span>
    </div>
  );
}

function UserRow({ user, isSelf }: { user: any; isSelf?: boolean }) {
  const [volume, setVolume] = useState<number>(100);
  // Mute LOCAL : on ne l'entend plus, de NOTRE côté seulement (lui ne le sait pas).
  const [localMuted, setLocalMuted] = useState<boolean>(false);
  // Vidéo relayée (Go Live/cam) de ce participant, affichée dans son bloc.
  const { stream: remoteVideo, watching } = useRemoteVideo(user.id);
  // La personne a tout coupé (plus ni Go Live ni caméra) pendant qu'on regardait
  // → arrêter le relais et jeter les tuiles, sinon elles restaient figées dans
  // le QAM (observé au test user). Re-cliquer Voir relancera tout proprement.
  useEffect(() => {
    if (watching && !user?.is_live && !user?.is_video) stopVideo(user.id);
  }, [watching, user?.is_live, user?.is_video, user.id]);

  const speaking = user?.is_speaking;
  const muted = user?.is_muted;
  const deafened = user?.is_deafened;
  // Mon propre partage d'écran (mode jeu) actif → aperçu local sous mon pseudo.
  const screenCamOn = useScreenCam();

  // État du mute local : on POLL la vérité moteur (Discord) en continu plutôt que
  // de lire une seule fois au montage. Sinon l'UI restait bloquée sur « Muet »
  // (lu pendant qu'elle l'était) alors que le moteur était démuté → auto-correction.
  useEffect(() => {
    if (isSelf) return;
    let alive = true;
    const read = () =>
      call<[string], boolean>("get_local_mute", user.id)
        .then((r) => { if (alive) setLocalMuted(!!r); })
        .catch(() => {});
    read();
    const iv = setInterval(read, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [user.id, isSelf]);

  // Volume du STREAM (audio du Go Live) — indépendant du volume de la voix (micro).
  const [streamVol, setStreamVol] = useState<number>(100);

  // Volumes : relire la vérité moteur au montage — sinon les sliders retombaient
  // à 100 % à chaque réouverture du QAM alors que le moteur gardait p. ex. 150 %
  // (issue #5). Le volume ne change que via ces sliders → une lecture suffit.
  useEffect(() => {
    let alive = true;
    call<[string, string], number>("get_user_volume", user.id, "default")
      .then((v) => { if (alive && typeof v === "number") setVolume(Math.round(v)); })
      .catch(() => {});
    call<[string, string], number>("get_user_volume", user.id, "stream")
      .then((v) => { if (alive && typeof v === "number") setStreamVol(Math.round(v)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [user.id]);
  // Halo de focus des boutons (texte blanc + anneau, pas d'inversion de couleur).
  const [muteFocused, setMuteFocused] = useState<boolean>(false);
  const [videoFocused, setVideoFocused] = useState<boolean>(false);

  const onVolumeChange = async (val: number) => {
    setVolume(val);
    await call("set_user_volume", user.id, val, "default");
  };

  const onStreamVolumeChange = async (val: number) => {
    setStreamVol(val);
    await call("set_user_volume", user.id, val, "stream");
  };

  // Volume BROADCAST de MON Go Live = ce que les SPECTATEURS entendent, réglé
  // côté PipeWire (source venmic vencord-screen-share). Indispensable car le
  // moteur Discord IGNORE le volume « stream » sur son propre id (on n'entend
  // pas son propre live) : l'ancien slider self ne faisait rien et retombait
  // au défaut moteur (18 d'amplitude) à chaque réouverture du QAM.
  const [bcastVol, setBcastVol] = useState<number>(100);
  useEffect(() => {
    if (!(isSelf && user?.is_live)) return;
    let alive = true;
    call<[], number | null>("get_stream_volume")
      .then((v) => { if (alive && typeof v === "number") setBcastVol(Math.min(100, Math.round(v))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isSelf, user?.is_live]);

  const onBcastVolumeChange = async (val: number) => {
    setBcastVol(val);
    await call("set_stream_volume", val);
  };

  const toggleLocalMute = async () => {
    // SET idempotent (≠ toggle aveugle) : on fixe l'état VOULU. Optimiste pour la
    // réactivité ; le poll ci-dessus réconcilie ensuite avec le moteur (jamais de
    // revert aveugle en cas d'erreur réseau → plus de « ça reste muet »).
    const target = !localMuted;
    setLocalMuted(target);
    try { await call<[string, boolean], boolean>("set_local_mute", user.id, target); } catch {}
  };

  return (
    <li style={{ listStyle: "none", marginBottom: 8, padding: "6px 0", background: "rgba(255,255,255,0.04)", borderRadius: 6, overflow: "hidden", boxSizing: "border-box", width: "100%", maxWidth: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <img
            src={user?.avatar
              ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp`
              : `https://cdn.discordapp.com/embed/avatars/0.png`}
            width={28} height={28}
            style={{
              borderRadius: "50%",
              display: "block",
              // Native-Discord-style glowing halo while speaking
              boxShadow: speaking
                ? "0 0 0 2px #23a55a, 0 0 10px 3px rgba(35,165,90,0.75)"
                : "0 0 0 2px transparent",
              transition: "box-shadow 0.08s ease-out",
            }}
          />
          {(muted || deafened) && (
            <div style={{
              position: "absolute", bottom: -1, right: -1,
              background: "#ed4245", borderRadius: "50%",
              width: 12, height: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, lineHeight: 1
            }}>
              {deafened ? <IcSpeakerMuteFill color="#fff" size={8} /> : <IcMicMuteFill color="#fff" size={8} />}
            </div>
          )}
        </div>
        <span style={{ flex: 1, fontSize: 12, opacity: muted ? 0.45 : 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {user?.username}
          {user?.is_live && <span style={{ marginLeft: 4, color: "#ed4245", fontSize: 9 }}>● LIVE</span>}
        </span>
        {speaking && (
          <div style={{
            width: 8, height: 8, borderRadius: "50%", background: "#23a55a", flexShrink: 0,
            boxShadow: "0 0 6px 1px rgba(35,165,90,0.8)"
          }} />
        )}
      </div>
      {/* Aperçu de MON partage d'écran (mode jeu), juste sous mon pseudo, pour
          voir ce que les autres voient. */}
      {isSelf && screenCamOn && (
        <div style={{ padding: "2px 8px 0" }}>
          <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}><IcController /> {t("self_preview_label")}</div>
          <SelfPreviewTile />
        </div>
      )}
      {/* Aperçu de MON Go Live natif (portail) — même idée, snapshots backend.
          Pas quand le partage mode jeu tourne : SelfPreviewTile s'en charge. */}
      {isSelf && !screenCamOn && user?.is_live && (
        <div style={{ padding: "2px 8px 0" }}>
          <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}><IcMonitor /> {t("self_preview_label")}</div>
          <GoLivePreviewTile />
        </div>
      )}

      {/* Volume VOIX (à quel point TU l'entends) — barre PLEINE LARGEUR. */}
      <div style={{ padding: "0 6px", boxSizing: "border-box", width: "100%", overflow: "hidden" }}>
        <SliderFieldAny
          label={<><IcSpeaker /> {localMuted ? t("video_muted") : volume + "%"}</>}
          value={volume}
          min={0} max={200} step={5}
          onChange={onVolumeChange}
          bottomSeparator="none"
        />
      </div>

      {/* Mute LOCAL : bouton pleine largeur (sélectionnable manette) collé sous la
          barre voix. C'est côté plugin-user seulement (l'autre ne le sait pas). */}
      {!isSelf && (
        <div style={{ padding: "2px 6px 0", boxSizing: "border-box", width: "100%" }}>
          <Btn
            onClick={toggleLocalMute}
            onFocus={() => setMuteFocused(true)}
            onBlur={() => setMuteFocused(false)}
            onGamepadFocus={() => setMuteFocused(true)}
            onGamepadBlur={() => setMuteFocused(false)}
            style={{
              width: "100%", margin: 0, padding: "5px 0", minHeight: 0, fontSize: 11, fontWeight: 600,
              borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              color: "#fff",
              background: localMuted ? DANGER : (muteFocused ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)"),
              ...focusHalo(localMuted ? DANGER : ACCENT, muteFocused),
            }}
          >
            {localMuted ? <><IcMicMute /> {t("unmute_voice")}</> : <><IcMic /> {t("mute_voice")}</>}
          </Btn>
        </div>
      )}

      {/* Volume STREAM (audio du Go Live d'un AUTRE) — barre SÉPARÉE pleine
          largeur (le son micro et le son du stream sont distincts). Jamais sur
          sa propre ligne : Discord ignore ce volume pour son propre id. */}
      {user?.is_live && !isSelf && (
        <div style={{ padding: "0 6px", boxSizing: "border-box", width: "100%", overflow: "hidden" }}>
          <SliderFieldAny
            label={<><IcMonitor /> {t("video_stream")} {streamVol}%</>}
            value={streamVol}
            min={0} max={200} step={5}
            onChange={onStreamVolumeChange}
            bottomSeparator="none"
          />
        </div>
      )}

      {/* MA ligne en live : volume BROADCAST (ce que les spectateurs entendent).
          Max 100 % : le signal venmic est déjà à pleine échelle, au-delà ça sature. */}
      {user?.is_live && isSelf && (
        <div style={{ padding: "0 6px", boxSizing: "border-box", width: "100%", overflow: "hidden" }}>
          <SliderFieldAny
            label={<><IcMonitor /> {t("broadcast_volume")} {bcastVol}%</>}
            value={bcastVol}
            min={0} max={100} step={5}
            onChange={onBcastVolumeChange}
            bottomSeparator="none"
          />
        </div>
      )}

      {/* Live (Go Live) OU caméra : bouton Voir + vidéo relayée dans le bloc. */}
      {(user?.is_live || user?.is_video) && !isSelf && (
        <div style={{ padding: "2px 8px 0" }}>
          <Btn
            onClick={() => (watching ? stopVideo(user.id) : watchVideo(user.id))}
            onFocus={() => setVideoFocused(true)}
            onBlur={() => setVideoFocused(false)}
            onGamepadFocus={() => setVideoFocused(true)}
            onGamepadBlur={() => setVideoFocused(false)}
            style={{
              width: "100%", margin: 0, padding: "5px 0", minHeight: 0, fontSize: 11, fontWeight: 600,
              borderRadius: 6,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              color: "#fff",
              background: watching ? DANGER : (videoFocused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.45)"),
              ...focusHalo(watching ? DANGER : ACCENT, videoFocused),
            }}
          >
            {watching ? t("video_stop") : <>{user?.is_live ? <IcMonitor /> : <IcCameraVideo />} {t("video_watch")}</>}
          </Btn>
          {watching && remoteVideo && (
            <MultiVideoTiles
              userId={user.id}
              stream={remoteVideo}
              onFullscreen={(tid) => {
                const trk = remoteVideo.getVideoTracks().find((x) => x.id === tid);
                if (trk) showModal(
                  <FullscreenVideoModal track={trk} label={trackLabel(getTrackKind(user.id, trk.id))} />,
                );
              }}
            />
          )}
          {watching && !remoteVideo && (
            <div style={{ fontSize: 10, opacity: 0.6, textAlign: "center", padding: "6px 0" }}>{t("video_connecting")}</div>
          )}
        </div>
      )}
    </li>
  );
}

export function VoiceChatMembers() {
  const state = useSteamcordState();
  if (!state?.vc?.users) return <div />;
  const meId = state?.me?.id;
  return (
    <ul style={{ margin: 0, padding: "0 4px", boxSizing: "border-box", width: "100%", listStyle: "none", overflow: "hidden" }}>
      {state.vc.users.map((user: any) => (
        <UserRow key={user.id} user={user} isSelf={user.id === meId} />
      ))}
    </ul>
  );
}
