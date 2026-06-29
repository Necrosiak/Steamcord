// Relais vidéo INVERSE côté QAM (réception). Vesktop capture la vidéo d'un
// participant (Go Live/cam) et nous l'offre par WebRTC local ; ici on répond et on
// expose le MediaStream reçu, indexé par userId, pour l'afficher dans son bloc.
// Miroir du relais micro (qui va QAM→Vesktop) ; ici c'est Vesktop→QAM.
import { call, addEventListener } from "@decky/api";

type Listener = () => void;
const streams = new Map<string, MediaStream>();
const pcs = new Map<string, RTCPeerConnection>();
const watching = new Set<string>();
const listeners = new Set<Listener>();

const notify = () => listeners.forEach((l) => l());

let initialized = false;
export function initVideoRelay() {
  if (initialized) return;
  initialized = true;
  // Vesktop nous offre la vidéo distante (non-trickle : ICE dans le SDP).
  (addEventListener as any)("video_webrtc", (async (data: any) => {
    if (!data || !data.userId) return;
    const userId: string = data.userId;
    if (data.offer) {
      try {
        let pc = pcs.get(userId);
        if (pc) pc.close();
        pc = new RTCPeerConnection();
        pcs.set(userId, pc);
        pc.ontrack = (ev) => {
          const ms = streams.get(userId) || new MediaStream();
          ms.addTrack(ev.track);
          streams.set(userId, ms);
          notify();
        };
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await new Promise<void>((res) => {
          if (pc!.iceGatheringState === "complete") return res();
          const cb = () => {
            if (pc!.iceGatheringState === "complete") {
              pc!.removeEventListener("icegatheringstatechange", cb);
              res();
            }
          };
          pc!.addEventListener("icegatheringstatechange", cb);
          setTimeout(res, 2000);
        });
        await call("video_webrtc_answer", userId, pc.localDescription);
      } catch (e) {
        console.error("[Steamcord] video recv failed", e);
      }
    } else if (data.ice) {
      const pc = pcs.get(userId);
      if (pc) try { await pc.addIceCandidate(data.ice); } catch {}
    }
  }) as any);
}

export function watchVideo(userId: string) {
  watching.add(userId);
  notify();
  call("watch_video", userId).catch(() => {});
}

export function stopVideo(userId: string) {
  watching.delete(userId);
  const pc = pcs.get(userId);
  if (pc) { pc.close(); pcs.delete(userId); }
  const ms = streams.get(userId);
  if (ms) { ms.getTracks().forEach((t) => t.stop()); streams.delete(userId); }
  notify();
  call("unwatch_video", userId).catch(() => {});
}

export const isWatching = (userId: string) => watching.has(userId);
export const getStream = (userId: string) => streams.get(userId) || null;
export function subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }
