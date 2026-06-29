import { call } from "@decky/api";
import { useCallback, useEffect, useState } from "react";
import { useSteamcordState } from "../hooks/useSteamcordState";
import { t } from "../i18n";
import { SliderField, DialogButton } from "@decky/ui";
import { watchVideo, stopVideo, isWatching, getStream, subscribe } from "../videoRelay";

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

const SliderFieldAny = SliderField as any;
const Btn = DialogButton as any;

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

  const speaking = user?.is_speaking;
  const muted = user?.is_muted;
  const deafened = user?.is_deafened;

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

  const onVolumeChange = async (val: number) => {
    setVolume(val);
    await call("set_user_volume", user.id, val, "default");
  };

  const onStreamVolumeChange = async (val: number) => {
    setStreamVol(val);
    await call("set_user_volume", user.id, val, "stream");
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
    <li style={{ listStyle: "none", marginBottom: 8, padding: "6px 0", background: "rgba(255,255,255,0.04)", borderRadius: 6, overflow: "hidden", boxSizing: "border-box" }}>
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
              {deafened ? "🔇" : "🔕"}
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
      {/* Volume VOIX (à quel point TU l'entends) — barre PLEINE LARGEUR. */}
      <div style={{ padding: "0 10px", boxSizing: "border-box" }}>
        <SliderFieldAny
          label={`🔊 ${localMuted ? t("video_muted") : volume + "%"}`}
          value={volume}
          min={0} max={200} step={5}
          onChange={onVolumeChange}
          bottomSeparator="none"
        />
      </div>

      {/* Mute LOCAL : bouton pleine largeur (sélectionnable manette) collé sous la
          barre voix. C'est côté plugin-user seulement (l'autre ne le sait pas). */}
      {!isSelf && (
        <div style={{ padding: "2px 10px 0" }}>
          <Btn
            onClick={toggleLocalMute}
            style={{
              width: "100%", margin: 0, padding: "5px 0", minHeight: 0, fontSize: 11, fontWeight: 600,
              borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              background: localMuted ? "#ed4245" : "rgba(255,255,255,0.08)",
            }}
          >
            {localMuted ? `🔇 ${t("unmute_voice")}` : `🎙️ ${t("mute_voice")}`}
          </Btn>
        </div>
      )}

      {/* Volume STREAM (audio du Go Live) — barre SÉPARÉE pleine largeur, seulement
          si l'utilisateur partage (le son micro et le son du stream sont distincts). */}
      {user?.is_live && (
        <div style={{ padding: "0 10px", boxSizing: "border-box" }}>
          <SliderFieldAny
            label={`🖥️ ${t("video_stream")} ${streamVol}%`}
            value={streamVol}
            min={0} max={200} step={5}
            onChange={onStreamVolumeChange}
            bottomSeparator="none"
          />
        </div>
      )}

      {/* Live (Go Live / caméra) : bouton Voir + vidéo relayée dans le bloc. */}
      {user?.is_live && !isSelf && (
        <div style={{ padding: "2px 8px 0" }}>
          <Btn
            onClick={() => (watching ? stopVideo(user.id) : watchVideo(user.id))}
            style={{
              width: "100%", margin: 0, padding: "5px 0", minHeight: 0, fontSize: 11, fontWeight: 600,
              borderRadius: 6,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              background: watching ? "#ed4245" : "rgba(88,101,242,0.45)",
            }}
          >
            {watching ? t("video_stop") : t("video_watch")}
          </Btn>
          {watching && remoteVideo && <VideoTile stream={remoteVideo} />}
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
    <ul style={{ margin: 0, padding: 0 }}>
      {state.vc.users.map((user: any) => (
        <UserRow key={user.id} user={user} isSelf={user.id === meId} />
      ))}
    </ul>
  );
}
