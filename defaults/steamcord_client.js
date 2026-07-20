// Detect host: Vesktop (native Electron Discord — mic works) vs Steam's hidden CEF
// BrowserView (mic broken). In Vesktop we must NOT hijack getUserMedia / visibility,
// or we'd break the native mic. The CEF-only workarounds are guarded by !IS_VESKTOP.
// The backend sets window.STEAMCORD_IS_VESKTOP = true before this script when it
// injects into Vesktop (most reliable). Fall back to runtime detection otherwise.
window.STEAMCORD_IS_VESKTOP = window.STEAMCORD_IS_VESKTOP
    || !!window.VesktopNative
    || (navigator.userAgent || "").toLowerCase().includes("vesktop");

// CEF only: override Page Visibility API so Discord audio/WebRTC stays active in a
// hidden BrowserView (Chrome throttles background tabs). Not needed in Vesktop.
if (!window.STEAMCORD_IS_VESKTOP) try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    const _origAEL = document.addEventListener.bind(document);
    document.addEventListener = (type, handler, opts) => {
        if (type === 'visibilitychange') return;
        return _origAEL(type, handler, opts);
    };
} catch(_) {}

// ── Auto-validation de la modale Vesktop de partage d'écran ─────────────────
// Le Go Live NATIF (getDisplayMedia → setDisplayMediaRequestHandler de Vesktop)
// ouvre la modale qualité/audio de Vesktop DANS la fenêtre Discord cachée :
// personne ne peut la cliquer → le handler main-process attendrait à jamais et
// le partage resterait bloqué. On la valide automatiquement : 1) audio système
// via venmic (équivalent du choix « Entire System » de la modale), 2) clic sur
// « Go Live ». Observateur PERMANENT (pas lié à $golive) : la modale peut
// apparaître pour tout démarrage de stream. Qualité préréglée 1080p60 via
// VesktopState si l'utilisateur n'a jamais rien choisi (la patch screenShareFixes
// de Vesktop applique ces contraintes sur la piste vidéo).
if (window.STEAMCORD_IS_VESKTOP && !window.STEAMCORD_PICKER_WATCHER) {
    try {
        const st = JSON.parse(localStorage.getItem("VesktopState") || "{}");
        if (!st.screenshareQuality) {
            st.screenshareQuality = { resolution: "1080", frameRate: "60" };
            localStorage.setItem("VesktopState", JSON.stringify(st));
        }
    } catch (_) {}
    window.STEAMCORD_PICKER_WATCHER = setInterval(async () => {
        try {
            // GATE : on n'auto-valide QUE les partages initiés par Steamcord
            // ($golive du QAM — flag posé par le handler). Un partage lancé À LA
            // MAIN dans la fenêtre Vesktop (mode bureau) garde sa modale : sans
            // ce gate, le clic auto validait le choix de l'utilisateur en 500 ms
            // (audio système imposé, qualité non choisie).
            if (!window.STEAMCORD_GOLIVE_ACTIVE) return;
            // TOUS les footers, pas le premier : à un stop→start rapproché la
            // modale du partage précédent peut encore être dans le DOM (déjà
            // auto-cliquée, scAuto=1) — querySelector la retournait ELLE et la
            // NOUVELLE modale n'était jamais validée → getDisplayMedia pendait
            // pour toujours et le bouton Go Live restait mort (issue #12).
            const footer = Array.from(document.querySelectorAll(".vcd-screen-picker-footer"))
                .find(f => !f.dataset.scAuto);
            if (!footer) return;
            const btn = Array.from(footer.querySelectorAll("button"))
                .find(b => !b.disabled && /go live/i.test(b.textContent || ""));
            if (!btn) return;
            footer.dataset.scAuto = "1";
            // venmic AVANT le clic : le device "vencord-screen-share" doit exister
            // quand screenShareFixes attache l'audio au stream. Échec toléré
            // (venmic absent/pipewire KO) → partage vidéo seule.
            try { await window.VesktopNative?.virtmic?.startSystem?.([]); } catch (_) {}
            btn.click();
            console.log("[Steamcord] modale Vesktop de partage auto-validée (audio système via venmic)");
        } catch (_) {}
    }, 500);
}

window.Vencord.Plugins.plugins.Steamcord = {
    name: "Steamcord",
    description: "Plugin required for Steamcord to work",
    authors: [],
    required: true,
    startAt: "DOMContentLoaded",
    async start() {
        // Garde anti-double-wrap : Vesktop survit aux restarts plugin_loader, donc
        // initialize() ré-injecte ce client plusieurs fois. Sans cette garde, la 2e
        // injection prend le wrapper de la 1re comme "old_" → le wrapper finit par
        // s'appeler lui-même → récursion infinie (Maximum call stack size exceeded,
        // crashait enableScreenCamera dès enumerateDevices). On ne wrappe qu'UNE fois
        // et on .bind() pour garder le bon `this` (sinon "Illegal invocation").
        if (!window.old_enumerate_devices) {
            window.old_enumerate_devices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
            navigator.mediaDevices.enumerateDevices = async () => {
                const devices = await window.old_enumerate_devices();
                return devices.filter(f => f.label != "Filter Chain Source" && f.label != "Virtual Source" && !(f.label == "" && f.deviceId == "default"))
            }
        }

        // Camera support (later): when a real webcam is plugged in, set
        // window.STEAMCORD_CAMERA_ENABLED = true and Discord's camera requests
        // (getUserMedia with video) will use the real device instead of the mic relay.
        // Screenshare uses getDisplayMedia (see webrtc_client.js), not this path.
        // Idem enumerateDevices : ne capturer le getUserMedia NATIF qu'une seule fois.
        // Sinon une ré-injection capture notre propre wrapper (steamcordGUM) comme
        // "old_" → récursion infinie quand le wrapper rappelle old_get_user_media.
        if (!window.old_get_user_media) {
            window.old_get_user_media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        }
        window.STEAMCORD_CAMERA_ENABLED = window.STEAMCORD_CAMERA_ENABLED ?? false;
        const steamcordGUM = (constraints) => new Promise(async (resolve, reject) => {
            console.log("[Steamcord] getUserMedia CALLED constraints=" + JSON.stringify(constraints) +
                " by: " + (new Error().stack || "").split("\n").slice(1, 4).join(" || "));
            if (window.STEAMCORD_CAMERA_ENABLED && constraints && constraints.video) {
                console.log("[Steamcord] Camera requested — using real device");
                return resolve(await window.old_get_user_media.call(navigator.mediaDevices, constraints));
            }
            if (window.MIC_STREAM != undefined && window.MIC_PEER_CONNECTION != undefined && window.MIC_PEER_CONNECTION.connectionState == "connected") {
                console.log("WebRTC stream available. Returning that.");
                return resolve(window.MIC_STREAM);
            }

            console.log("Starting WebRTC handshake for mic stream");
            const peerConnection = new RTCPeerConnection(null);
            window.MIC_PEER_CONNECTION = peerConnection;

            window.STEAMCORD_WS.addEventListener("message", async (e) => {
                const data = JSON.parse(e.data);
                if (data.type != "$webrtc") return;

                const remoteDescription = new RTCSessionDescription(data.payload);
                await peerConnection.setRemoteDescription(remoteDescription);
                console.log("[Steamcord] mic: answer set, connection negotiating");
            });

            peerConnection.ontrack = (ev) => {
                ev.track.stop = () => { console.log("CALLED STOP ON TRACK") }
                window.MIC_STREAM = new MediaStream([ev.track]);
                console.log("[Steamcord] mic: WEBRTC STREAM (ontrack)", window.MIC_STREAM);
                resolve(window.MIC_STREAM);
            }

            const offer = await peerConnection.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: true });
            await peerConnection.setLocalDescription(offer);
            // Non-trickle ICE: wait until candidates are gathered so they're embedded
            // in the SDP (localhost host candidates gather instantly). This avoids
            // routing ICE messages between the hidden tab and SharedJSContext.
            await new Promise((res) => {
                if (peerConnection.iceGatheringState === "complete") return res();
                const cb = () => {
                    if (peerConnection.iceGatheringState === "complete") {
                        peerConnection.removeEventListener("icegatheringstatechange", cb);
                        res();
                    }
                };
                peerConnection.addEventListener("icegatheringstatechange", cb);
                setTimeout(res, 2000);
            });
            console.log("[Steamcord] mic: sending offer to backend");
            window.STEAMCORD_WS.send(JSON.stringify({ type: "$MIC_WEBRTC", offer: peerConnection.localDescription }));
        });

        // ── Partage d'écran via CAMÉRA virtuelle (contournement gamescope) ──────────
        // En mode jeu, gamescope n'a PAS de portail → getDisplayMedia (Go Live) = noir.
        // À la place : gst_camera.py capture le node PipeWire gamescope → /dev/video42
        // (v4l2loopback "Steamcord Screen"). Ici on sélectionne cette caméra et on
        // active la vidéo dans le salon vocal. getUserMedia(video) renverra le vrai
        // device (STEAMCORD_CAMERA_ENABLED=true → branche "real device" plus haut).
        window.STEAMCORD_enableScreenCamera = async (on) => {
            const log = (m) => { try { window.STEAMCORD_WS.send(JSON.stringify({ type: "$diag", m: "[cam] " + m })); } catch (_) {} };
            try {
                const WP = Vencord.Webpack;
                if (!on) {
                    window.STEAMCORD_CAMERA_ENABLED = false;
                    try {
                        // Même lookup que le chemin d'activation (findByProps). Ne PAS
                        // utiliser findByCode("setVideoEnabled") : ça peut renvoyer un
                        // hook React → appelé hors render = "Minified React error #321".
                        const va = WP.findByProps?.("setVideoEnabled");
                        if (va?.setVideoEnabled) { va.setVideoEnabled(false); log("caméra coupée"); }
                        else log("setVideoEnabled introuvable (off)");
                    } catch (e) { log("off err " + e); }
                    return;
                }
                window.STEAMCORD_CAMERA_ENABLED = true;
                // 1) Trouver notre device par label. Le feeder gstcam met ~1-3s à
                // établir le pipeline + le lecteur keepalive qui fait passer le
                // device en CAPTURE (donc énumérable par Chromium). On RÉESSAIE
                // l'énumération jusqu'à ~12s avant d'abandonner, sinon on perd la
                // course (videoinputs=[] alors que le device arrive juste après).
                let cam = null;
                for (let attempt = 0; attempt < 12; attempt++) {
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    const vins = devs.filter(d => d.kind === "videoinput");
                    cam = vins.find(d => /steamcord screen/i.test(d.label));
                    if (cam) {
                        log("videoinputs=" + JSON.stringify(vins.map(d => d.label || "(label vide)")) + " (essai " + attempt + ")");
                        break;
                    }
                    if (attempt === 0 || attempt === 11) {
                        log("videoinputs=" + JSON.stringify(vins.map(d => d.label || "(label vide)")) + " — pas encore 'Steamcord Screen' (essai " + attempt + ")");
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!cam) { log("AUCUN 'Steamcord Screen' après 12s — le feeder gstcam n'a pas fait passer /dev/video42 en CAPTURE (lecteur keepalive ?)"); return; }
                log("device choisi: " + JSON.stringify(cam.label) + " id=" + cam.deviceId.slice(0, 12));
                // 2) Sélectionner le device vidéo dans Discord. Ces actions renvoient
                // des PROMESSES : sans await, une rejection est silencieuse et on
                // loggait « OK » alors que la caméra ne s'activait jamais (test
                // 02/07 : setVideoEnabled(true) OK mais is_video jamais true).
                try {
                    const va = WP.findByProps?.("setVideoDevice");
                    if (va?.setVideoDevice) {
                        log("module setVideoDevice: " + Object.keys(va).slice(0, 12).join(","));
                        await Promise.resolve(va.setVideoDevice(cam.deviceId));
                        log("setVideoDevice OK");
                    } else log("setVideoDevice introuvable");
                } catch (e) { log("setVideoDevice REJETÉ " + e); }
                // 3) Activer la caméra dans le salon vocal courant.
                try {
                    const selCh = WP.findStore?.("SelectedChannelStore");
                    const vcId = selCh?.getVoiceChannelId?.();
                    if (!vcId) { log("pas dans un vocal — la cam s'activera au prochain appel"); }
                    const va = WP.findByProps?.("setVideoEnabled");
                    if (va?.setVideoEnabled) {
                        log("module setVideoEnabled: " + Object.keys(va).slice(0, 12).join(","));
                        await Promise.resolve(va.setVideoEnabled(true));
                        log("setVideoEnabled(true) OK (promesse résolue)");
                    } else log("setVideoEnabled introuvable");
                } catch (e) { log("setVideoEnabled REJETÉ " + e); }
                // 4) VERDICT : seul l'état gateway self_video prouve que les autres
                // reçoivent la vidéo (l'engine peut dire oui sans que rien parte).
                // Si toujours off à 2,5s, secours = re-appeler setVideoEnabled(true)
                // (le module d'actions média), puis re-verdict. L'ancien secours
                // cherchait `toggleSelfVideo` : sondé au CDP le 2026-07-19, ce
                // module n'existe plus dans le webpack Discord (ni byProps ni
                // byCode) — le log disait « introuvable » à chaque fois. Côté
                // engine, l'API est isVideoEnabled()/getVideoToggleState()
                // (isSelfVideoEnabled n'a jamais existé → undefined).
                const verdict = (label) => {
                    try {
                        const meId = WP.findStore?.("UserStore")?.getCurrentUser?.()?.id;
                        const vc2 = WP.findStore?.("SelectedChannelStore")?.getVoiceChannelId?.();
                        const states = WP.findStore?.("VoiceStateStore")?.getVoiceStatesForChannel?.(vc2) || {};
                        const st = meId ? states[meId] : null;
                        const MES = WP.findStore?.("MediaEngineStore");
                        const engOn = MES?.isVideoEnabled?.();
                        const on = st ? !!st.selfVideo : null;
                        log(label + " selfVideo(gateway)=" + on + " video(engine)=" + engOn
                            + " toggleState=" + MES?.getVideoToggleState?.());
                        return on;
                    } catch (e) { log(label + " err " + e); return null; }
                };
                setTimeout(() => {
                    if (verdict("VERDICT@2.5s:") === true) return;
                    try {
                        const va2 = WP.findByProps?.("setVideoEnabled");
                        if (va2?.setVideoEnabled) {
                            log("secours: re-setVideoEnabled(true)");
                            Promise.resolve(va2.setVideoEnabled(true)).catch((e) => log("secours setVideoEnabled REJETÉ " + e));
                        } else log("secours: setVideoEnabled introuvable");
                    } catch (e) { log("secours err " + e); }
                    setTimeout(() => verdict("VERDICT@5s:"), 2500);
                }, 2500);
            } catch (e) { log("FATAL " + e); }
        };

        // ── Relais vidéo INVERSE (Vesktop → QAM) ────────────────────────────────
        // Pour VOIR le Go Live/cam d'un participant dans le panneau QAM : on regarde
        // son stream (Discord décode + rend un <video>), on capture sa piste vidéo et
        // on l'OFFRE au QAM par WebRTC local — miroir du relais micro, sens inverse.
        // L'audio n'est PAS relayé : il est déjà audible via la sortie de Vesktop.
        // Corrélation par userId. findByCode (≠ id de module) survit aux MAJ Discord.
        window.STEAMCORD_VIDEO = window.STEAMCORD_VIDEO || {}; // userId -> { pc, streamKey }

        // Streams visibles d'un salon = UNION de deux registres du store (issue #8) :
        // « active streams » (les nôtres / déjà regardés — les seuls peuplés en appel
        // 1:1, ce que le code utilisait partout) et « application streams » (registre
        // gateway STREAM_CREATE/DELETE : contient AUSSI les streams des autres en
        // salon de serveur/groupe et les re-partages, invisibles côté active tant
        // qu'on ne les regarde pas). Dédupliqué par clé, l'entrée active (porteuse
        // de state) gagne.
        // Pistes vidéo ENTRANTES d'un utilisateur, lues sur le moteur média (issue #8).
        // Helper global : sert au relais, et se sonde en direct via CDP pendant un
        // vrai appel — c'est comme ça que l'association ci-dessous a été établie.
        window.__sc_videoTracksFor = (userId) => {
            const out = [];
            const seen = new Set();
            let eng = null;
            try { eng = Vencord.Webpack.findStore("MediaEngineStore").getMediaEngine(); } catch (e) { return out; }
            if (!eng || !eng.connections) return out;
            // `c.pc` sur le build actuel, mais les noms sont minifiés et changent d'une
            // version de Discord à l'autre → on reconnaît l'objet à son interface.
            const findPc = (c) => {
                if (c.pc && typeof c.pc.getReceivers === "function") return c.pc;
                for (const k of Object.keys(c)) {
                    const v = c[k];
                    if (v && typeof v === "object" && typeof v.getReceivers === "function") return v;
                }
                return null;
            };
            for (const c of [...eng.connections]) {
                const pc = findPc(c);
                if (!pc) continue;
                const isScreen = c.context === "stream" && c.streamUserId === userId;
                const isVoice = c.context === "default";
                if (!isScreen && !isVoice) continue;
                for (const r of pc.getReceivers()) {
                    const t = r.track;
                    // Les transceivers pré-alloués sont là mais muted : les écarter.
                    if (!t || t.kind !== "video" || t.muted || t.readyState !== "live") continue;
                    if (seen.has(t.id)) continue;
                    if (isScreen) { seen.add(t.id); out.push({ t, kind: "screen" }); continue; }
                    const owner = (c.trackUserIds || {})[t.id];
                    if (owner === userId) { seen.add(t.id); out.push({ t, kind: "camera" }); }
                }
            }
            // Ordre déterministe (écran d'abord), plus aucun tri par taille.
            out.sort((a, b) => (a.kind === "screen" ? 0 : 1) - (b.kind === "screen" ? 0 : 1));
            return out;
        };

        // Discord ne fait suivre que la vidéo des participants que SON UI affiche :
        // chaque tuile <video> tient un refcount de « sink actif » par streamId, et
        // à zéro le RTCMediaSinkWantsManager marque le user offscreen (LRU de 3 +
        // timeout) puis envoie wants=0 au serveur vocal → la piste caméra reçue
        // passe muted pour de bon → tuile noire (retours David #8 : bascule
        // cam1→cam2, cam+écran relancé ; l'appel 1:1 a un chemin spécial, d'où
        // « avec un seul flux tout marche »). Les Go Live passent par le
        // GoLiveQualityManager qui ne coupe jamais → seules les CAMÉRAS sont
        // touchées. Le relais se déclare donc lui-même comme sink actif (nom
        // "steamcord", à côté de celui de l'UI) pour le streamId de la caméra du
        // user relayé — l'exact équivalent d'une tuile montée.
        window.__sc_heldSinks = window.__sc_heldSinks || {}; // userId -> Set(streamId)
        window.__sc_cameraStreamId = (userId) => {
            try {
                const rc = Vencord.Webpack.findStore("RTCConnectionStore").getRTCConnection?.();
                return rc?._localMediaSinkWantsManager?.streamIds?.[userId] ?? null;
            } catch (e) { return null; }
        };
        window.__sc_holdSinks = (userId) => {
            const held = window.__sc_heldSinks[userId] || new Set();
            const want = new Set();
            const sid = window.__sc_cameraStreamId(userId);
            if (sid != null) want.add(sid);
            let eng = null;
            try { eng = Vencord.Webpack.findStore("MediaEngineStore").getMediaEngine(); } catch (e) { return; }
            if (!eng || !eng.connections) return;
            for (const c of [...eng.connections]) {
                if (typeof c.setHasActiveVideoOutputSink !== "function") continue;
                // Ré-affirmé à chaque tick : une connexion recréée (reconnexion,
                // re-partage) repart avec un registre de sinks vide.
                for (const s of want) { try { c.setHasActiveVideoOutputSink(s, true, "steamcord"); } catch (e) {} }
                // Caméra coupée/rallumée = nouveau streamId : lâcher l'ancien.
                for (const s of held) { if (!want.has(s)) { try { c.setHasActiveVideoOutputSink(s, false, "steamcord"); } catch (e) {} } }
            }
            window.__sc_heldSinks[userId] = want;
        };
        window.__sc_releaseSinks = (userId) => {
            const held = window.__sc_heldSinks[userId];
            delete window.__sc_heldSinks[userId];
            if (!held || !held.size) return;
            try {
                const eng = Vencord.Webpack.findStore("MediaEngineStore").getMediaEngine();
                for (const c of [...(eng && eng.connections || [])]) {
                    if (typeof c.setHasActiveVideoOutputSink !== "function") continue;
                    for (const s of held) { try { c.setHasActiveVideoOutputSink(s, false, "steamcord"); } catch (e) {} }
                }
            } catch (e) {}
        };

        window.__sc_streamsForChannel = (chId) => {
            const ASS = Vencord.Webpack.findStore("ApplicationStreamingStore");
            if (!ASS || !chId) return [];
            const keyOf = (s) => {
                const owner = s.ownerId || s.userId;
                return s.guildId ? `guild:${s.guildId}:${s.channelId}:${owner}` : `call:${s.channelId}:${owner}`;
            };
            const out = new Map();
            // Le registre « actif » GARDE une entrée state:"ENDED" pour un stream
            // qu'on regardait et que son proprio a coupé (observé en live, QAM
            // gardait la tuile) : un stream terminé n'est pas un stream.
            for (const s of (ASS.getAllActiveStreamsForChannel?.(chId) || [])) {
                if (s.state !== "ENDED") out.set(keyOf(s), s);
            }
            for (const s of (ASS.getAllApplicationStreamsForChannel?.(chId) || [])) {
                const k = keyOf(s);
                if (!out.has(k)) out.set(k, s);
            }
            // MON stream : getCurrentUserActiveStream est la vérité pour soi —
            // les listes par-channel le perdent TRANSITOIREMENT à la ré-ouverture
            // (issue #12 : badge LIVE + aperçu disparaissaient au stop→start
            // rapproché, le STOP synthétique débouncé partait alors que le
            // stream re-démarrait). L'union ici stabilise le badge.
            const own = ASS.getCurrentUserActiveStream?.();
            if (own && own.channelId === chId && own.state !== "ENDED") {
                const k = keyOf(own);
                if (!out.has(k)) out.set(k, own);
            }
            return Array.from(out, ([key, s]) => ({ key, s }));
        };

        window.STEAMCORD_startVideoRelay = async (userId) => {
            try {
                const WP = Vencord.Webpack;
                const ASS = WP.findStore("ApplicationStreamingStore");
                const SCS = WP.findStore("SelectedChannelStore");
                const chId = SCS.getVoiceChannelId();

                // Deux cas : (a) GO LIVE = un stream actif (ApplicationStreamingStore)
                // qu'il faut WATCH pour s'abonner ; (b) CAMÉRA = pas de stream, Discord
                // rend déjà la cam du participant dans la tuile vocale → on capte
                // directement (pas de STREAM_WATCH, pas de streamKey).
                const entry = window.__sc_streamsForChannel(chId).find(e => (e.s.ownerId || e.s.userId) === userId);
                const s = entry && entry.s;
                let streamKey = null;
                if (s) {
                    streamKey = entry.key;
                    // Regarder le stream (s'abonner) — SEULEMENT si pas déjà viewer, car
                    // re-dispatcher STREAM_WATCH re-render le tile et tue la piste captée.
                    const myId = WP.findStore("UserStore").getCurrentUser()?.id;
                    const alreadyViewing = (ASS.getViewerIds?.(streamKey) || []).includes(myId);
                    if (!alreadyViewing) {
                        const watch = WP.findByCode('"STREAM_WATCH",streamKey');
                        if (watch) watch(s); else console.warn("[Steamcord] video: action STREAM_WATCH introuvable");
                    }
                } else {
                    console.log("[Steamcord] video: pas de stream → cas CAMÉRA pour " + userId);
                }

                // SOURCE DES PISTES : le moteur média, PAS le DOM (issue #8).
                //
                // L'ancienne version capturait les <video> rendus (captureStream) en les
                // triant par TAILLE, faute de savoir quel élément appartenait à quel flux.
                // Deux problèmes, tous deux observés en vrai sur un appel :
                //   1. deux vidéos rendues = recopie (le fameux « miroir »), et l'ordre
                //      par taille est une devinette qui se trompe (une caméra de
                //      téléphone peut être plus grande qu'un partage d'écran) ;
                //   2. surtout, Discord NE REND QUE CE QU'IL AFFICHE : avec caméra ET
                //      partage actifs (selfVideo + selfStream à true), le DOM ne
                //      contenait qu'UN SEUL <video>. Un flux non affiché est donc
                //      impossible à relayer — aucun tri ne pouvait corriger ça.
                //
                // On lit donc les pistes entrantes directement sur les RTCPeerConnection
                // du moteur média, ce qui ne dépend plus du rendu. Association vérifiée
                // en live (voir issue #8) :
                //   • partage d'écran de X = piste sur la connexion context "stream"
                //     dont streamUserId === X ;
                //   • caméra de X = piste sur la connexion "default" (le vocal), le
                //     propriétaire venant de connection.trackUserIds (trackId → userId).
                // Les transceivers pré-alloués sont muted → on ne garde que live+unmuted.
                //
                // ⚠️ NE PAS se fier à participantOnScreen.userVideo pour distinguer
                // caméra/écran : c'est un attribut du PARTICIPANT (« cette personne a sa
                // caméra allumée »), pas de l'élément — vérifié en live, la même piste
                // passe de true à false quand la personne coupe sa caméra.
                const engineTracks = () => window.__sc_videoTracksFor(userId);
                // Attendre TOUTES les pistes ATTENDUES, pas la première venue : au
                // (re-)watch d'un Go Live la caméra est déjà là alors que l'écran
                // n'arrive qu'après l'aller-retour STREAM_WATCH → sortir à la 1re
                // piste = offre caméra seule, l'écran arrivé ensuite n'est jamais
                // ajouté (pas de renégociation). Bug trouvé par le user au 1er test
                // QAM (couper puis remettre cam+écran → plus que la caméra).
                const expected = new Set();
                if (s) expected.add("screen");
                try {
                    const vs = Object.values(WP.findStore("VoiceStateStore").getVoiceStatesForChannel(chId) || {});
                    if (vs.some(v => v.userId === userId && v.selfVideo)) expected.add("camera");
                } catch (e) { /* store indispo → on prend ce qui vient */ }
                // Tenir le sink AVANT d'attendre les pistes : une caméra déjà
                // coupée par wants=0 (tuile noire) existe mais est MUTED, donc
                // invisible pour engineTracks — la souscription doit repartir
                // d'abord pour que la piste se ranime pendant l'attente.
                window.__sc_holdSinks(userId);
                let found = [];
                for (let i = 0; i < 80; i++) {
                    found = engineTracks();
                    const kinds = new Set(found.map(x => x.kind));
                    if (found.length && [...expected].every(k => kinds.has(k))) break;
                    await new Promise(r => setTimeout(r, 100));
                }
                const tracks = found.map(x => x.t);
                if (found.length) console.log("[Steamcord] video: " + found.map(x => x.kind).join("+") + " pour " + userId + " (attendu: " + [...expected].join("+") + ")");
                if (!tracks.length) { console.warn("[Steamcord] video: piste introuvable pour " + userId); window.__sc_releaseSinks(userId); return; }

                // Fermer un éventuel relais précédent pour ce user avant d'en recréer un.
                const prev = window.STEAMCORD_VIDEO[userId];
                if (prev) { try { prev.pc && prev.pc.close(); } catch {} if (prev.keepalive) clearInterval(prev.keepalive); }

                const pc = new RTCPeerConnection(null);
                const senders = tracks.map(t => pc.addTrack(t));

                // Keepalive : une piste du moteur meurt quand la personne coupe puis
                // relance son partage (nouvelle piste, nouvel id) → on remplace sans
                // renégocier. Contrairement à l'ancienne capture DOM, un simple
                // re-render de Discord ne tue plus la piste : ce filet ne sert donc
                // plus qu'aux vraies coupures.
                // Le remplacement se fait PAR SORTE (écran→écran, caméra→caméra),
                // JAMAIS par index : au retour d'un partage la seule piste fraîche
                // peut être la caméra, et un mapping par index la collait sur le
                // sender de l'ÉCRAN (miroir réinventé — trouvé au 1er test QAM).
                // Si l'ensemble des SORTES change (caméra allumée en cours de route,
                // écran revenu alors que son sender a été abandonné), l'offre est
                // figée (pas de renégociation) → on RECONSTRUIT le relais entier.
                const kinds = found.map(x => x.kind);
                let staleMisses = 0;
                const restart = (why) => {
                    clearInterval(keepalive);
                    const cur = window.STEAMCORD_VIDEO[userId];
                    if (cur && cur.pc === pc) {
                        console.log("[Steamcord] video: reconstruction du relais (" + why + ") pour " + userId);
                        window.STEAMCORD_startVideoRelay(userId);
                    }
                };
                const keepalive = setInterval(() => {
                    try {
                        if (pc.connectionState === "closed") { clearInterval(keepalive); return; }
                        // Souscription caméra ré-affirmée en continu (connexion
                        // recréée, caméra rallumée = nouveau streamId…).
                        window.__sc_holdSinks(userId);
                        const fresh = engineTracks();
                        // nouvelle sorte de piste qu'aucun sender ne porte → rebuild.
                        if (fresh.some(f => !kinds.includes(f.kind))) { restart("nouvelle piste " + fresh.map(x => x.kind).join("+")); return; }
                        // « morte » = finie OU MUETTE : quand la personne coupe SA
                        // caméra, la piste reçue ne meurt pas, elle passe muted pour
                        // toujours (observé en live : sender "live" figé). Le délai de
                        // 8 s absorbe les mutes transitoires (réseau, keyframe).
                        const gone = (tk) => !tk || tk.readyState === "ended" || tk.muted;
                        const deadIdx = senders.map((sn, i) => gone(sn.track) ? i : -1).filter(i => i >= 0);
                        if (!deadIdx.length) { staleMisses = 0; return; }
                        const used = new Set(senders.filter(sn => !gone(sn.track)).map(sn => sn.track.id));
                        let replaced = 0;
                        for (const i of deadIdx) {
                            const f = fresh.find(x => x.kind === kinds[i] && !used.has(x.t.id));
                            if (f) { used.add(f.t.id); senders[i].replaceTrack(f.t); replaced++; console.log("[Steamcord] video: piste " + kinds[i] + " remplacée (keepalive) pour " + userId); }
                        }
                        // sender mort sans remplaçant de sa sorte pendant ~8 s :
                        // • s'il RESTE des pistes (partage coupé, caméra gardée) →
                        //   rebuild sans la sorte disparue (la tuile morte s'en va) ;
                        // • s'il ne reste RIEN (tout coupé) → arrêt PROPRE du relais
                        //   (pc + STREAM_CLOSE + entrée), sinon il tournait pour
                        //   toujours avec une image figée (observé en live).
                        if (replaced < deadIdx.length) {
                            if (++staleMisses >= 8) {
                                if (fresh.length) restart("piste " + kinds[deadIdx[0]] + " disparue");
                                else { clearInterval(keepalive); window.STEAMCORD_stopVideoRelay(userId); }
                            }
                        } else { staleMisses = 0; }
                    } catch (e) { /* ignore */ }
                }, 1000);
                window.STEAMCORD_VIDEO[userId] = { pc, streamKey, keepalive };

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await new Promise((res) => {
                    if (pc.iceGatheringState === "complete") return res();
                    const cb = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", cb); res(); } };
                    pc.addEventListener("icegatheringstatechange", cb);
                    setTimeout(res, 2000);
                });
                // meta : dit au QAM quelle ligne m= est l'ÉCRAN et laquelle est la
                // CAMÉRA (corrélation par mid, stable dans le SDP). Sans ça le front
                // affiche des tuiles anonymes — et ne peut pas proposer « plein écran
                // sur l'écran » vs « sur la caméra » (retour David, issue #8).
                const kindByTrackId = Object.fromEntries(found.map(x => [x.t.id, x.kind]));
                const meta = pc.getTransceivers()
                    .filter(tr => tr.sender && tr.sender.track)
                    .map(tr => ({ mid: tr.mid, kind: kindByTrackId[tr.sender.track.id] || "video" }));
                window.STEAMCORD_WS.send(JSON.stringify({ type: "$VIDEO_WEBRTC", userId, offer: pc.localDescription, meta }));
                console.log("[Steamcord] video: offer envoyée pour " + userId);
            } catch (e) {
                console.error("[Steamcord] video relay start failed", e);
                // Pas de relais monté → personne ne libérera les sinks tenus plus haut.
                if (!window.STEAMCORD_VIDEO[userId]) window.__sc_releaseSinks(userId);
            }
        };

        window.STEAMCORD_stopVideoRelay = (userId) => {
            try {
                const entry = window.STEAMCORD_VIDEO[userId];
                if (!entry) return;
                window.__sc_releaseSinks(userId);
                if (entry.keepalive) clearInterval(entry.keepalive);
                if (entry.pc) entry.pc.close();
                const close = Vencord.Webpack.findByCode('"STREAM_CLOSE",streamKey');
                if (close && entry.streamKey) close(entry.streamKey);
                delete window.STEAMCORD_VIDEO[userId];
                console.log("[Steamcord] video: relais arrêté pour " + userId);
            } catch (e) { console.error("[Steamcord] video relay stop failed", e); }
        };

        // Discord's MediaEngine reinitializes and OVERWRITES our getUserMedia override,
        // so it ends up calling the native one and capturing a silent CEF device →
        // nobody hears the user. Install our override resiliently (defineProperty with a
        // no-op setter) on both the instance and the prototype, and re-assert it.
        function installMicOverride() {
            const desc = { configurable: true, get: () => steamcordGUM, set: () => {} };
            try { Object.defineProperty(navigator.mediaDevices, "getUserMedia", desc); }
            catch (e) { try { navigator.mediaDevices.getUserMedia = steamcordGUM; } catch (_) {} }
            try { Object.defineProperty(MediaDevices.prototype, "getUserMedia", desc); } catch (_) {}
        }
        // CEF only: in Vesktop the native mic works, so installing this override would
        // hijack/break it. Never install it under Vesktop.
        if (!window.STEAMCORD_IS_VESKTOP) {
            installMicOverride();
            setInterval(installMicOverride, 2000);
        }

        function dataURLtoFile(dataurl, filename) {
            var arr = dataurl.split(','),
                mime = arr[0].match(/:(.*?);/)[1],
                bstr = atob(arr[arr.length - 1]),
                n = bstr.length,
                u8arr = new Uint8Array(n);
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            return new File([u8arr], filename, { type: mime });
        }

        function patchTypingField() {
            const t = setInterval(() => {
                try {
                    document.querySelectorAll("[role=\"textbox\"]")[0].onclick = (e) => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" });
                    clearInterval(t);
                } catch (err) { }
            }, 100)
        }

        async function getAppId(name) {
            const res = await Vencord.Webpack.Common.RestAPI.get({ url: "/applications/detectable" });
            if (res.ok) {
                const item = res.body.filter(e => e.name == name);
                if (item.length > 0) return item[0].id;
            }
            return "0";
        }

        // Le statut Discord (online/idle/dnd/invisible) vit dans le settings proto
        // "PreloadedUserSettings" (type 1), pas dans un action-creator updateStatus
        // (qui n'existe plus). On localise le proto store dont getCurrentValue()
        // expose .status, puis on mute via updateAsync("status", ...).
        let _statusProtoStore;
        function getStatusProtoStore() {
            if (_statusProtoStore) return _statusProtoStore;
            try {
                const cache = Vencord.Webpack.wreq && Vencord.Webpack.wreq.c;
                if (!cache) return null;
                const test = (m) => {
                    try {
                        if (m && typeof m.updateAsync === "function" && m.type === 1 &&
                            typeof m.getCurrentValue === "function" && m.getCurrentValue().status) return m;
                    } catch (e) { }
                    return null;
                };
                for (const id in cache) {
                    try {
                        const exp = cache[id] && cache[id].exports;
                        if (!exp) continue;
                        let s = test(exp);
                        if (!s && typeof exp === "object") {
                            for (const k in exp) { s = test(exp[k]); if (s) break; }
                        }
                        if (s) { _statusProtoStore = s; return s; }
                    } catch (e) { }
                }
            } catch (e) { }
            return null;
        }

        let CloudUpload;
        CloudUpload = Vencord.Webpack.findLazy(m => m.prototype?.trackUploadFinished);;
        function sendAttachmentToChannel(channelId, attachment_b64, filename) {
            return new Promise((resolve, reject) => {
                const file = dataURLtoFile(`data:text/plain;base64,${attachment_b64}`, filename);
                const upload = new CloudUpload({
                    file: file,
                    isClip: false,
                    isThumbnail: false,
                    platform: 1,
                }, channelId, false, 0);
                upload.on("complete", () => {
                    Vencord.Webpack.Common.RestAPI.post({
                        url: `/channels/${channelId}/messages`,
                        body: {
                            channel_id: channelId,
                            content: "",
                            nonce: Vencord.Webpack.Common.SnowflakeUtils.fromTimestamp(Date.now()),
                            sticker_ids: [],
                            type: 0,
                            attachments: [{
                                id: "0",
                                filename: upload.filename,
                                uploaded_filename: upload.uploadedFilename
                            }]
                        }
                    });
                    resolve(true);
                });
                upload.on("error", () => resolve(false))
                upload.upload();
            })
        }

        let MediaEngineStore, FluxDispatcher;
        console.log("Steamcord: Waiting for FluxDispatcher...");
        Vencord.Webpack.waitFor(["subscribe", "dispatch", "register"], fdm => {
            FluxDispatcher = fdm;
            Vencord.Webpack.waitFor(Vencord.Webpack.filters.byStoreName("MediaEngineStore"), m => {
                MediaEngineStore = m;
                FluxDispatcher.dispatch({ type: "MEDIA_ENGINE_SET_AUDIO_ENABLED", enabled: true, unmute: true });
                // ROOT CAUSE of "nobody hears me": Discord's MediaEngine never enables mic
                // capture because the hidden tab never gets a user interaction
                // (engine.interacted stays false → engine.enabled stays false → no capture).
                // Force the interaction flag and enable the engine, and re-assert it since
                // Discord can reset it.
                const forceEngineEnabled = () => {
                    try {
                        const eng = m.getMediaEngine && m.getMediaEngine();
                        if (!eng) return;
                        eng.interacted = true;
                        if (typeof eng.setAudioEnabled === "function") eng.setAudioEnabled(true);
                        else if (typeof eng.enable === "function") eng.enable();
                    } catch (_) {}
                };
                // Also dispatch the DOM events Discord listens to for "interacted"
                try {
                    for (const type of ["pointerdown", "mousedown", "click", "keydown", "touchstart"])
                        document.dispatchEvent(new Event(type, { bubbles: true }));
                } catch (_) {}
                forceEngineEnabled();
                setInterval(forceEngineEnabled, 3000);
            });

            function connect() {
                // Garde anti-double-client : si un WS est déjà ouvert/en cours, ne pas
                // en créer un second (sinon chaque message backend est traité 2×).
                if (window.STEAMCORD_WS && window.STEAMCORD_WS.readyState <= 1) return;
                window.STEAMCORD_WS = new WebSocket('ws://127.0.0.1:65123/socket');
                window.STEAMCORD_WS.addEventListener("message", async function (e) {
                    const data = JSON.parse(e.data);
                    if (data.type.startsWith("$")) {
                        let result;
                        try {
                            switch (data.type) {
                                case "$getuser":
                                    result = Vencord.Webpack.Common.UserStore.getUser(data.id);
                                    break;
                                case "$getchannel":
                                    result = Vencord.Webpack.Common.ChannelStore.getChannel(data.id);
                                    break;
                                case "$getguild":
                                    result = Vencord.Webpack.Common.GuildStore.getGuild(data.id);
                                    break;
                                case "$getmedia":
                                    result = {
                                        mute: MediaEngineStore.isSelfMute(),
                                        deaf: MediaEngineStore.isSelfDeaf(),
                                        live: MediaEngineStore.getGoLiveSource() != undefined
                                    }
                                    break;
                                case "$get_last_channels":
                                    result = {}
                                    const ChannelStore = Vencord.Webpack.Common.ChannelStore;
                                    const GuildStore = Vencord.Webpack.Common.GuildStore;
                                    const channelIds = Object.values(JSON.parse(Vencord.Util.localStorage.SelectedChannelStore).mostRecentSelectedTextChannelIds);
                                    for (const chId of channelIds) {
                                        const ch = ChannelStore.getChannel(chId);
                                        const guild = GuildStore.getGuild(ch.guild_id);
                                        result[chId] = `${ch.name} (${guild.name})`;
                                    }
                                    break;
                                case "$get_screen_bounds":
                                    result = { width: screen.width, height: screen.height }
                                    break;
                                case "$ptt":
                                    try {
                                        MediaEngineStore.getMediaEngine().connections.values().next().value.setForceAudioInput(data.value);
                                    } catch (error) { }
                                    return;
                                case "$setptt":
                                    FluxDispatcher.dispatch({
                                        "type": "AUDIO_SET_MODE",
                                        "context": "default",
                                        "mode": data.enabled ? "PUSH_TO_TALK" : "VOICE_ACTIVITY",
                                        "options": MediaEngineStore.getSettings().modeOptions
                                    });
                                    return;
                                case "$rpc":
                                    FluxDispatcher.dispatch({
                                        type: "LOCAL_ACTIVITY_UPDATE",
                                        activity: data.game ? {
                                            application_id: await getAppId(data.game),
                                            name: data.game,
                                            type: 0,
                                            flags: 1,
                                            timestamps: { start: Date.now() }
                                        } : {},
                                        socketId: "CustomRPC",
                                    });
                                    return;
                                case "$screenshot":
                                    result = await sendAttachmentToChannel(data.channel_id, data.attachment_b64, "screenshot.jpg");
                                    break;
                                case "$set_user_volume": {
                                    // context "default" = voix, "stream" = audio du Go Live (volumes indépendants).
                                    // Le moteur stocke une AMPLITUDE ; l'UI Discord affiche un volume
                                    // PERCEPTUEL (conversion du module webpack 792251). Le QAM parle
                                    // perceptuel pour coller aux % Discord — sans ça le défaut stream
                                    // (amplitude 18 = 54 % perçus) s'affichait « 18 % ».
                                    const p = Number(data.volume) || 0;
                                    const amp = p === 0 ? 0 : (p < 100 ? Math.pow(p / 100, 2.8) : Math.pow(10, (p / 100 - 1) * 6 / 20)) * 100;
                                    FluxDispatcher.dispatch({ type: "AUDIO_SET_LOCAL_VOLUME", userId: data.id, volume: amp, context: data.context || "default" });
                                    return;
                                }
                                case "$get_user_volume": {
                                    // Vérité moteur pour les sliders du QAM : sans relecture au
                                    // montage ils retombaient à 100 % à chaque réouverture alors
                                    // que le moteur gardait p. ex. 150 % (issue #5). Amplitude
                                    // moteur → perceptuel (voir $set_user_volume).
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const a = MES?.getLocalVolume ? MES.getLocalVolume(data.id, data.context || "default") : 100;
                                    result = a === 0 ? 0 : (a < 100 ? Math.pow(a / 100, 1 / 2.8) : (20 * Math.log10(a / 100) / 6 + 1)) * 100;
                                    break;
                                }
                                case "$get_local_mute": {
                                    // Mute LOCAL (côté client seulement : on ne les entend plus, eux ne le savent pas).
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id));
                                    break;
                                }
                                case "$toggle_local_mute": {
                                    const mod = Vencord.Webpack.findByProps("toggleLocalMute");
                                    if (mod && mod.toggleLocalMute) mod.toggleLocalMute(data.id);
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id)); // nouvel état
                                    break;
                                }
                                case "$set_local_mute": {
                                    // SET idempotent (≠ toggle aveugle) : on ne bascule que si l'état
                                    // courant diffère du voulu → un double-clic gamescope ne re-flip plus.
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const cur = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id));
                                    if (cur !== !!data.muted) {
                                        const mod = Vencord.Webpack.findByProps("toggleLocalMute");
                                        if (mod && mod.toggleLocalMute) mod.toggleLocalMute(data.id);
                                    }
                                    result = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id));
                                    break;
                                }
                                case "$set_status": {
                                    // data.status: "online" | "idle" | "dnd" | "invisible"
                                    try {
                                        const store = getStatusProtoStore();
                                        if (store) {
                                            await store.updateAsync("status", (s) => { s.status.value = data.status; }, 0);
                                            console.log("[Steamcord] status → " + data.status);
                                        } else console.warn("[Steamcord] proto store status introuvable");
                                    } catch (e) { console.error("[Steamcord] set_status err", e); }
                                    return;
                                }
                                case "$get_status": {
                                    try {
                                        // Le proto store donne la vraie valeur réglée (y compris
                                        // "invisible", que PresenceStore rapporte comme "offline").
                                        const store = getStatusProtoStore();
                                        const protoStatus = store?.getCurrentValue?.()?.status?.status?.value;
                                        if (protoStatus) { result = { status: protoStatus }; break; }
                                        const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
                                        const PS = Vencord.Webpack.findStore("PresenceStore");
                                        result = { status: PS?.getStatus?.(me.id) || "online" };
                                    } catch (e) { result = { status: "online" }; }
                                    break;
                                }
                                case "$golive": {
                                    const selChStore = Vencord.Webpack.findStore("SelectedChannelStore");
                                    const golive_channel_id = selChStore?.getVoiceChannelId?.();
                                    if (!golive_channel_id) {
                                        console.warn("[Steamcord] Go Live: pas dans un salon vocal");
                                        return;
                                    }
                                    const golive_channel = Vencord.Webpack.Common.ChannelStore.getChannel(golive_channel_id);
                                    const golive_guild_id = golive_channel?.guild_id ?? null;

                                    // L'ancienne API (modules m.startStream/m.stopStream) a DISPARU de
                                    // Discord. On utilise les action creators actuels via findByCode
                                    // (robuste aux changements d'ID de module) : STREAM_START / STREAM_STOP.
                                    // getDisplayMedia (webrtc_client.js) : portail NATIF d'abord — en
                                    // mode jeu c'est notre portal_shim.py qui sert le node gamescope,
                                    // la modale Vesktop est auto-validée (watcher ci-dessus) — puis
                                    // repli sur le relais GStreamer local. Aucun picker visible.
                                    const WP = Vencord.Webpack;
                                    try {
                                        if (data.stop) {
                                            // ⚠️ NE PAS éteindre STEAMCORD_GOLIVE_ACTIVE si une acquisition
                                            // est en vol : la modale Vesktop (invisible en gamemode) ne
                                            // serait jamais auto-cliquée → son callback main-process ne
                                            // répond jamais → TOUS les getDisplayMedia suivants pendent
                                            // (wedge Electron vécu le 19/07, seul un restart Vesktop le
                                            // libère). On laisse l'acquisition se terminer ; le chemin
                                            // START verra le drapeau stop et libérera la source.
                                            if (window.STEAMCORD_GOLIVE_PENDING) {
                                                window.STEAMCORD_GOLIVE_STOP_REQUESTED = true;
                                            } else {
                                                window.STEAMCORD_GOLIVE_ACTIVE = false;
                                            }
                                            const ASS = WP.findStore("ApplicationStreamingStore");
                                            const s = ASS?.getCurrentUserActiveStream?.();
                                            const stopFn = WP.findByCode('"STREAM_STOP"');
                                            if (s && stopFn) {
                                                const key = s.guildId
                                                    ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}`
                                                    : `call:${s.channelId}:${s.ownerId}`;
                                                stopFn(key);
                                            }
                                            // Horodatage pour le chemin START : une ré-ouverture trop
                                            // rapide doit laisser le teardown (session portail, source
                                            // du pool, venmic) se finir avant de ré-acquérir (issue #12).
                                            window.STEAMCORD_GOLIVE_LAST_STOP = Date.now();
                                            console.log("[Steamcord] Go Live STOP envoyé");
                                        } else {
                                            // Autorise l'auto-validation de la modale Vesktop (watcher
                                            // en tête de fichier) pour CE partage initié par Steamcord.
                                            window.STEAMCORD_GOLIVE_ACTIVE = true;
                                            const startFn = WP.findByCode('"STREAM_START",streamType');
                                            if (!startFn) {
                                                window.STEAMCORD_GOLIVE_ACTIVE = false;
                                                console.warn("[Steamcord] Go Live: action STREAM_START introuvable");
                                                return;
                                            }
                                            // Bundle Discord ≥ 19/07/2026 : STREAM_START seul ne lance plus
                                            // AUCUNE capture — l'ApplicationSwitchingManager exige pid OU
                                            // sourceId (sinon warn « invalid start_stream ») et plus personne
                                            // n'acquiert la source → stream ACTIVE avec 0 sender vidéo =
                                            // écran noir chez les spectateurs (diagnostiqué au CDP : stats
                                            // outbound-rtp vides). On reproduit le flux navigateur de Discord
                                            // lui-même : eng.getDesktopSource() (= getDisplayMedia via le
                                            // DesktopInputPool → notre portail en gamemode, modale Vesktop
                                            // auto-validée) PUIS STREAM_START avec l'id du pool (le label de
                                            // la piste — souvent "" via le portail, clé de pool valide).
                                            // Prouvé au CDP 19/07 : sender attaché, ~55 fps encodés.
                                            // Garde anti-chevauchement : un 2e $golive pendant qu'une
                                            // acquisition est en vol (double-clic, backend+bouton) créerait
                                            // une 2e modale/2e session portail et peut coincer Electron.
                                            if (window.STEAMCORD_GOLIVE_PENDING) {
                                                console.log("[Steamcord] Go Live: acquisition déjà en cours, ignoré");
                                                return;
                                            }
                                            const eng = WP.findStore("MediaEngineStore")?.getMediaEngine?.();
                                            if (eng?.getDesktopSource) {
                                                window.STEAMCORD_GOLIVE_PENDING = true;
                                                window.STEAMCORD_GOLIVE_STOP_REQUESTED = false;
                                                const myGen = (window.STEAMCORD_GOLIVE_GEN = (window.STEAMCORD_GOLIVE_GEN || 0) + 1);
                                                try {
                                                    // Laisser le PARTAGE PRÉCÉDENT finir de se démonter avant
                                                    // de ré-acquérir (issue #12 : fermer puis rouvrir en <1s
                                                    // faisait se chevaucher teardown de session portail et
                                                    // nouvelle acquisition → getDisplayMedia coincé, bouton
                                                    // mort). On attend que le stream actif ait disparu du
                                                    // store ET ≥1,2s depuis le STOP, 5s max.
                                                    const ASS2 = WP.findStore("ApplicationStreamingStore");
                                                    const t0 = Date.now();
                                                    while (Date.now() - t0 < 5000) {
                                                        const busy = ASS2?.getCurrentUserActiveStream?.();
                                                        const sinceStop = Date.now() - (window.STEAMCORD_GOLIVE_LAST_STOP || 0);
                                                        if (!busy && sinceStop >= 1200) break;
                                                        if (window.STEAMCORD_GOLIVE_STOP_REQUESTED) break;
                                                        await new Promise(r => setTimeout(r, 200));
                                                    }
                                                    if (window.STEAMCORD_GOLIVE_STOP_REQUESTED) {
                                                        window.STEAMCORD_GOLIVE_ACTIVE = false;
                                                        console.log("[Steamcord] Go Live: annulé avant l'acquisition");
                                                        return;
                                                    }
                                                    // Watchdog : si l'acquisition pend (modale jamais apparue,
                                                    // handler main-process muet), on rend la main au lieu de
                                                    // laisser le bouton mort pour toujours ; si la promesse se
                                                    // résout tardivement, la garde de génération ci-dessous
                                                    // libère la source au lieu de démarrer un stream fantôme.
                                                    const acqPromise = eng.getDesktopSource({ width: 1920, height: 1080 }, true);
                                                    // Résolution APRÈS timeout : source acquise pour rien →
                                                    // la libérer (sinon session portail qui fuit à chaque
                                                    // tentative coincée).
                                                    let raceSettled = false;
                                                    acqPromise.then((id) => {
                                                        if (!raceSettled) return;
                                                        try { eng.desktopInputPool?.get?.(id)?.destroy?.(); } catch (_) {}
                                                        console.log("[Steamcord] Go Live: acquisition résolue après timeout, source libérée");
                                                    }).catch(() => {});
                                                    let srcId;
                                                    try {
                                                        srcId = await Promise.race([
                                                            acqPromise,
                                                            new Promise((_, rej) => setTimeout(() => rej(new Error("getDesktopSource timeout (20s)")), 20000)),
                                                        ]);
                                                    } finally {
                                                        raceSettled = true;
                                                    }
                                                    if (window.STEAMCORD_GOLIVE_STOP_REQUESTED || myGen !== window.STEAMCORD_GOLIVE_GEN) {
                                                        // Stop arrivé pendant l'acquisition (ou tentative plus
                                                        // récente en cours) : on libère la source fraîchement
                                                        // acquise au lieu de démarrer.
                                                        if (myGen === window.STEAMCORD_GOLIVE_GEN) window.STEAMCORD_GOLIVE_ACTIVE = false;
                                                        try { eng.desktopInputPool?.get?.(srcId)?.destroy?.(); } catch (_) {}
                                                        console.log("[Steamcord] Go Live: annulé pendant l'acquisition, source libérée");
                                                    } else {
                                                        startFn(golive_guild_id, golive_channel_id, { pid: null, sourceId: srcId, sourceName: null });
                                                        console.log("[Steamcord] Go Live START envoyé (source pool: " + JSON.stringify(srcId) + ")");
                                                    }
                                                } catch (e) {
                                                    if (myGen === window.STEAMCORD_GOLIVE_GEN) window.STEAMCORD_GOLIVE_ACTIVE = false;
                                                    console.error("[Steamcord] Go Live: acquisition écran échouée:", e);
                                                } finally {
                                                    if (myGen === window.STEAMCORD_GOLIVE_GEN) {
                                                        window.STEAMCORD_GOLIVE_PENDING = false;
                                                        window.STEAMCORD_GOLIVE_STOP_REQUESTED = false;
                                                    }
                                                }
                                            } else {
                                                // Vieux bundle sans pool exposé : l'ancien chemin suffisait.
                                                startFn(golive_guild_id, golive_channel_id, {});
                                                console.log("[Steamcord] Go Live START envoyé (flux legacy)");
                                            }
                                        }
                                    } catch (e) {
                                        console.error("[Steamcord] Go Live échec:", e);
                                    }
                                    return;
                                }
                                case "$screen_camera": {
                                    await window.STEAMCORD_enableScreenCamera?.(!data.stop);
                                    return;
                                }
                                case "$rpc": {
                                    // Rich Presence (issue #11) : le QAM envoie le jeu Steam en
                                    // cours (Router.MainRunningApp) — on le publie comme activité
                                    // « Playing … » via le même dispatch local que les plugins
                                    // Vencord (CustomRPC). game=null → activité effacée. Le
                                    // backend rejoue le dernier état à chaque (re)connexion,
                                    // started_at ne bouge pas → temps de jeu continu.
                                    // application_id est REQUIS par la validation du dispatch
                                    // (vérifié au CDP 19/07 : sans lui, LocalActivityStore reste
                                    // vide). On le résout dans la base des jeux détectables de
                                    // Discord (match insensible à la casse — l'exact-match de
                                    // Deckcord ratait des jeux), cache en mémoire ; introuvable
                                    // → "0" (l'activité s'affiche quand même, nom brut).
                                    try {
                                        let appId = "0";
                                        if (data.game) {
                                            try {
                                                if (!window.__sc_rpcAppIds) {
                                                    const res = await Vencord.Webpack.Common.RestAPI.get({ url: "/applications/detectable" });
                                                    const map = new Map();
                                                    if (res.ok) for (const e of res.body) map.set(String(e.name).toLowerCase(), e.id);
                                                    window.__sc_rpcAppIds = map;
                                                }
                                                appId = window.__sc_rpcAppIds.get(String(data.game).toLowerCase()) || "0";
                                            } catch (_) { /* hors-ligne/API KO : nom brut */ }
                                        }
                                        const activity = data.game ? {
                                            application_id: appId,
                                            name: data.game,
                                            type: 0, // Playing
                                            flags: 1, // INSTANCE
                                            timestamps: data.started_at ? { start: data.started_at } : undefined,
                                        } : null;
                                        FluxDispatcher.dispatch({
                                            type: "LOCAL_ACTIVITY_UPDATE",
                                            socketId: "steamcord-rpc",
                                            activity,
                                        });
                                        console.log("[Steamcord] RPC → " + (data.game ? "Playing " + data.game + " (app " + appId + ")" : "effacé"));
                                    } catch (e) {
                                        console.error("[Steamcord] RPC échec:", e);
                                    }
                                    return;
                                }
                                case "$get_dm_channels": {
                                    const CS = Vencord.Webpack.Common.ChannelStore;
                                    const US = Vencord.Webpack.Common.UserStore;
                                    const VSS = Vencord.Webpack.findStore?.("VoiceStateStore");
                                    const sorted = CS?.getSortedPrivateChannels?.() ?? [];
                                    result = sorted.slice(0, 30).map(ch => {
                                        // "Active" only if someone is actually connected to the call.
                                        // CallStore.getCall() lingers after a call ends → false "EN CALL".
                                        const states = VSS?.getVoiceStatesForChannel?.(ch.id) || {};
                                        const activeCall = Object.keys(states).length > 0;
                                        const recipientIds = Array.isArray(ch.recipientIDs) ? ch.recipientIDs
                                            : Array.isArray(ch.recipients) ? ch.recipients.map(r => typeof r === 'string' ? r : r.id)
                                            : [];
                                        const recipients = recipientIds.map(id => {
                                            const u = US?.getUser?.(id);
                                            return { id: String(id), username: u?.username ?? String(id), avatar: u?.avatar ?? null };
                                        });
                                        const name = ch.name || (recipients.length === 1 ? recipients[0].username : `Group (${recipients.length + 1})`);
                                        return {
                                            id: String(ch.id),
                                            type: ch.type ?? 1,
                                            name,
                                            icon: ch.icon ?? null,
                                            recipients,
                                            active_call: activeCall,
                                        };
                                    });
                                    break;
                                }
                                case "$dm_call": {
                                    const channelId = data.id;
                                    if (data.join_existing) {
                                        FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId, guildId: null });
                                    } else {
                                        const CallActions = Vencord.Webpack.find(m => m && typeof m.startCall === 'function');
                                        if (CallActions) CallActions.startCall(channelId);
                                        else FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId, guildId: null });
                                    }
                                    result = true;
                                    break;
                                }
                                case "$get_guilds_vc": {
                                    const GS = Vencord.Webpack.Common.GuildStore;
                                    const GCS = Vencord.Webpack.findStore("GuildChannelStore");
                                    const SGS = Vencord.Webpack.findStore("SortedGuildStore");
                                    const VSS = Vencord.Webpack.findStore("VoiceStateStore");
                                    const US = Vencord.Webpack.Common.UserStore;
                                    const sortedIds = SGS?.getFlattenedGuildIds?.() ?? SGS?.getGuilds?.()?.map(g => g.id) ?? Object.keys(GS.getGuilds());
                                    const allGuilds = GS.getGuilds();
                                    result = [];
                                    for (const guildId of sortedIds) {
                                        const guild = allGuilds[guildId];
                                        if (!guild) continue;
                                        try {
                                            const gc = GCS.getChannels(guild.id);
                                            const vocalList = gc?.VOCAL || [];
                                            const vocal = vocalList
                                                .map(e => {
                                                    const chId = String(e.channel?.id ?? e.id ?? "");
                                                    const chName = String(e.channel?.name ?? e.name ?? "");
                                                    if (!chId || !chName) return null;
                                                    const states = VSS?.getVoiceStatesForChannel?.(chId) || {};
                                                    const members = Object.values(states).map(vs => {
                                                        const u = US?.getUser?.(vs.userId);
                                                        return { id: vs.userId, avatar: u?.avatar || null };
                                                    });
                                                    return { id: chId, name: chName, members };
                                                })
                                                .filter(Boolean);
                                            if (vocal.length > 0) result.push({ id: String(guild.id), name: String(guild.name), icon: guild.icon || null, channels: vocal });
                                        } catch (_) {}
                                    }
                                    break;
                                }
                                case "$join_vc":
                                    FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: data.id, guildId: data.guild_id });
                                    result = true;
                                    break;
                                case "$get_voice_states": {
                                    const vsStore = Vencord.Webpack.findStore("VoiceStateStore");
                                    const states = vsStore?.getVoiceStatesForChannel?.(data.id) || {};
                                    result = Object.values(states).map(vs => ({
                                        userId: vs.userId,
                                        mute: vs.mute || vs.selfMute || false,
                                        deaf: vs.deaf || vs.selfDeaf || false,
                                        video: vs.selfVideo || false,
                                    }));
                                    break;
                                }
                                case "$get_soundboard_sounds": {
                                    // Sons par défaut Discord + sons du serveur du salon vocal courant +
                                    // (si Nitro) sons de tous les autres serveurs rejoints — même perk que
                                    // le client officiel ("soundboard everywhere"), détecté ici via
                                    // premiumType plutôt qu'en rejouant leur logique interne de feature-flag.
                                    const SCS = Vencord.Webpack.findStore("SelectedChannelStore");
                                    const CS = Vencord.Webpack.Common.ChannelStore || Vencord.Webpack.findStore("ChannelStore");
                                    const GS = Vencord.Webpack.Common.GuildStore;
                                    const US = Vencord.Webpack.Common.UserStore;
                                    const vcId = SCS?.getVoiceChannelId?.();
                                    const vcChannel = vcId ? CS?.getChannel?.(vcId) : null;
                                    const currentGuildId = vcChannel?.guild_id || null;

                                    const mapSound = (s) => ({
                                        id: String(s.sound_id), name: String(s.name || ""),
                                        emoji: s.emoji_name || null, volume: s.volume ?? 1,
                                    });

                                    const out = { default: [], guild: null, everywhere: [] };
                                    try {
                                        const def = await Vencord.Webpack.Common.RestAPI.get({ url: "/soundboard-default-sounds" });
                                        out.default = (def?.body || []).map(mapSound);
                                    } catch (_) { }

                                    if (currentGuildId) {
                                        try {
                                            const g = await Vencord.Webpack.Common.RestAPI.get({ url: `/guilds/${currentGuildId}/soundboard-sounds` });
                                            const items = g?.body?.items || [];
                                            out.guild = { guildId: currentGuildId, guildName: GS?.getGuild?.(currentGuildId)?.name || "", sounds: items.map(mapSound) };
                                        } catch (_) { }
                                    }

                                    const premiumType = US?.getCurrentUser?.()?.premiumType;
                                    if (premiumType) {
                                        const allGuilds = GS?.getGuilds?.() || {};
                                        for (const gid of Object.keys(allGuilds)) {
                                            if (gid === currentGuildId) continue;
                                            try {
                                                const g = await Vencord.Webpack.Common.RestAPI.get({ url: `/guilds/${gid}/soundboard-sounds` });
                                                const items = g?.body?.items || [];
                                                if (items.length) out.everywhere.push({ guildId: gid, guildName: allGuilds[gid]?.name || "", sounds: items.map(mapSound) });
                                            } catch (_) { }
                                        }
                                    }
                                    result = out;
                                    break;
                                }
                                case "$play_soundboard_sound": {
                                    // Le son ne joue que dans le salon vocal où l'on est effectivement
                                    // connecté (comme le vrai client) ; source_guild_id seulement pour un
                                    // son venant d'un AUTRE serveur que celui du salon courant.
                                    const SCS2 = Vencord.Webpack.findStore("SelectedChannelStore");
                                    const channelId = SCS2?.getVoiceChannelId?.();
                                    if (!channelId) { result = { ok: false, error: "not_in_voice" }; break; }
                                    const body = { sound_id: data.soundId };
                                    if (data.sourceGuildId) body.source_guild_id = data.sourceGuildId;
                                    try {
                                        await Vencord.Webpack.Common.RestAPI.post({ url: `/channels/${channelId}/send-soundboard-sound`, body });
                                        // La requête REST ci-dessus notifie le serveur (les AUTRES participants
                                        // l'entendent) mais ne joue RIEN localement — le vrai client Discord
                                        // dispatche EN PLUS cette action pour se faire entendre soi-même
                                        // (retrouvé en lisant le code source de son bouton soundboard natif :
                                        // GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY). guildId "0" = son par défaut,
                                        // même convention que source_guild_id ci-dessus. Testé en vrai : joue
                                        // même avec un objet minimal (pas besoin du nom/emoji/volume).
                                        try {
                                            Vencord.Webpack.Common.FluxDispatcher.dispatch({
                                                type: "GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY",
                                                sound: { soundId: data.soundId, guildId: data.sourceGuildId || "0" },
                                                channelId,
                                                trigger: "SOUNDBOARD",
                                            });
                                        } catch (_) { }
                                        result = { ok: true };
                                    } catch (e) {
                                        result = { ok: false, error: String(e?.body?.message || e) };
                                    }
                                    break;
                                }
                                case "$play_sound": {
                                    // "Utilise les sons embed de Discord" (demande user) : rejoue le
                                    // VRAI son natif du client (WebAudioSound — la classe que Discord
                                    // utilise lui-même pour ses cues mute/deafen/connexion), plutôt que
                                    // d'embarquer nos propres fichiers. Lookup par le NOM DE PROP réel
                                    // (findByProps("WebAudioSound")) — pas par un alias mangled par le
                                    // bundler (change à chaque build Discord) ni un ID de module en dur.
                                    // Simplification acceptée : on ne résout pas le nom de fichier par
                                    // soundpack custom (Halloween/Hiver/…) — juste le nom d'évènement, qui
                                    // EST déjà le bon fichier pour tout le monde sauf pack thématique actif
                                    // (rare) → dégrade proprement sur le son classique plutôt que planter.
                                    try {
                                        const Snd = Vencord.Webpack.findByProps("WebAudioSound")?.WebAudioSound;
                                        if (Snd && data.name) new Snd(data.name, data.name, 1, "default").play();
                                    } catch (_) { }
                                    result = true;
                                    break;
                                }
                                case "$get_text_channels": {
                                    // Serveurs → salons texte (type 0) + annonces (type 5) accessibles.
                                    const GS = Vencord.Webpack.Common.GuildStore;
                                    const GCS = Vencord.Webpack.findStore("GuildChannelStore");
                                    const SGS = Vencord.Webpack.findStore("SortedGuildStore");
                                    const sortedIds = SGS?.getFlattenedGuildIds?.() ?? Object.keys(GS.getGuilds());
                                    const allGuilds = GS.getGuilds();
                                    result = [];
                                    for (const gid of sortedIds) {
                                        const guild = allGuilds[gid];
                                        if (!guild) continue;
                                        try {
                                            const gc = GCS.getChannels(guild.id);
                                            const list = gc?.SELECTABLE || [];
                                            const channels = list
                                                .map(e => {
                                                    const ch = e.channel ?? e;
                                                    if (!ch || (ch.type !== 0 && ch.type !== 5)) return null;
                                                    return { id: String(ch.id), name: String(ch.name), type: ch.type };
                                                })
                                                .filter(Boolean);
                                            if (channels.length)
                                                result.push({ id: String(guild.id), name: String(guild.name), icon: guild.icon || null, channels });
                                        } catch (_) { }
                                    }
                                    break;
                                }
                                case "$get_messages": {
                                    // MessageStore est vide pour un salon non ouvert → RestAPI (newest-first,
                                    // on inverse pour l'ordre de lecture). Timestamps ISO. `before` = pagination
                                    // vers l'historique (id du plus vieux message déjà chargé côté frontend).
                                    const url = `/channels/${data.id}/messages?limit=30`
                                        + (data.before ? `&before=${encodeURIComponent(data.before)}` : "");
                                    const res = await Vencord.Webpack.Common.RestAPI.get({ url });
                                    const arr = (res?.body || []).slice().reverse();
                                    const isImg = (a) => (a?.content_type || "").startsWith("image/")
                                        || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(a?.filename || a?.url || "");
                                    result = arr.map(m => {
                                        const atts = Array.isArray(m.attachments) ? m.attachments : [];
                                        // Images = pièces jointes image + images d'embeds (liens d'images
                                        // postés deviennent des embeds). proxy_url = CDN média redimensionnable.
                                        const images = [];
                                        for (const a of atts) {
                                            if (isImg(a)) images.push({ url: a.url, proxy_url: a.proxy_url || a.url, w: a.width || 0, h: a.height || 0 });
                                        }
                                        for (const e of (Array.isArray(m.embeds) ? m.embeds : [])) {
                                            const im = e?.image || e?.thumbnail;
                                            if (im && im.url) images.push({ url: im.url, proxy_url: im.proxy_url || im.url, w: im.width || 0, h: im.height || 0 });
                                        }
                                        return {
                                            id: String(m.id),
                                            author: m.author?.global_name || m.author?.username || "?",
                                            author_id: String(m.author?.id || ""),
                                            avatar: m.author?.avatar || null,
                                            bot: !!m.author?.bot,
                                            content: m.content ?? "",
                                            ts: m.timestamp || null,
                                            images,
                                            files: atts.filter(a => !isImg(a)).length,
                                        };
                                    });
                                    break;
                                }
                                case "$send_message": {
                                    await Vencord.Webpack.Common.RestAPI.post({
                                        url: `/channels/${data.id}/messages`,
                                        body: { content: String(data.content || "") },
                                    });
                                    result = true;
                                    break;
                                }
                                case "$webrtc":
                                    return;
                                case "$WATCH_VIDEO":
                                    window.STEAMCORD_startVideoRelay(data.userId);
                                    return;
                                case "$UNWATCH_VIDEO":
                                    window.STEAMCORD_stopVideoRelay(data.userId);
                                    return;
                                case "$VIDEO_ANSWER": {
                                    const entry = window.STEAMCORD_VIDEO[data.userId];
                                    if (entry && entry.pc) await entry.pc.setRemoteDescription(new RTCSessionDescription(data.payload));
                                    return;
                                }
                                case "$login_token": {
                                    const t = data.token;
                                    if (!t) return;
                                    const lm = Vencord.Webpack.find(m => m && typeof m.loginToken === "function");
                                    if (lm) lm.loginToken(t, true);
                                    else { localStorage.setItem("token", JSON.stringify(t)); location.reload(); }
                                    return;
                                }
                                case "$logout": {
                                    // Déconnexion TOTALE Discord : invalide le token côté serveur +
                                    // purge la session locale → retour page login (QR). Fallback :
                                    // purge localStorage + reload si l'action n'est pas trouvée.
                                    try {
                                        const auth = Vencord.Webpack.findByProps("logout", "loginToken");
                                        if (auth && typeof auth.logout === "function") auth.logout();
                                        else { localStorage.removeItem("token"); location.reload(); }
                                    } catch (e) {
                                        try { localStorage.removeItem("token"); location.reload(); } catch (_) {}
                                    }
                                    return;
                                }
                                case "$get_audio_processing": {
                                    // Réglages micro Discord (Voix & Vidéo). La réduction de bruit
                                    // est un tri-état : Krisp (noiseCancellation) > Standard
                                    // (noiseSuppression) > Aucune. + écho + gain auto.
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const nc = !!MES.getNoiseCancellation();
                                    const ns = !!MES.getNoiseSuppression();
                                    result = {
                                        noise: nc ? "krisp" : (ns ? "standard" : "none"),
                                        echoCancellation: !!MES.getEchoCancellation(),
                                        automaticGainControl: !!MES.getAutomaticGainControl(),
                                        ncSupported: MES.isNoiseCancellationSupported ? !!MES.isNoiseCancellationSupported() : true,
                                        nsSupported: MES.isNoiseSuppressionSupported ? !!MES.isNoiseSuppressionSupported() : true,
                                        agcSupported: MES.isAutomaticGainControlSupported ? !!MES.isAutomaticGainControlSupported() : true,
                                    };
                                    break;
                                }
                                case "$set_noise_reduction": {
                                    // data.mode: "none" | "standard" | "krisp"
                                    // Le module d'actions peut manquer selon le bundle (issue #14 :
                                    // no-op silencieux = réglage « qui ne prend pas ») → fallback
                                    // FluxDispatcher, et une ERREUR remonte si rien n'a pris.
                                    const SET = Vencord.Webpack.findByProps("setNoiseCancellation");
                                    if (SET) {
                                        if (data.mode === "krisp") { SET.setNoiseSuppression(false); SET.setNoiseCancellation(true); }
                                        else if (data.mode === "standard") { SET.setNoiseCancellation(false); SET.setNoiseSuppression(true); }
                                        else { SET.setNoiseCancellation(false); SET.setNoiseSuppression(false); }
                                    } else {
                                        const FD = Vencord.Webpack.Common.FluxDispatcher;
                                        FD.dispatch({ type: "AUDIO_SET_NOISE_CANCELLATION", enabled: data.mode === "krisp" });
                                        FD.dispatch({ type: "AUDIO_SET_NOISE_SUPPRESSION", enabled: data.mode === "standard" });
                                    }
                                    await new Promise(r => setTimeout(r, 150));
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const applied = MES.getNoiseCancellation() ? "krisp" : (MES.getNoiseSuppression() ? "standard" : "none");
                                    result = applied === data.mode ? { noise: applied }
                                        : { noise: applied, error: "noise setting did not apply (module not found?)" };
                                    break;
                                }
                                case "$set_echo_cancellation": {
                                    const SET = Vencord.Webpack.findByProps("setEchoCancellation");
                                    if (SET) SET.setEchoCancellation(!!data.enabled);
                                    else Vencord.Webpack.Common.FluxDispatcher.dispatch({ type: "AUDIO_SET_ECHO_CANCELLATION", enabled: !!data.enabled });
                                    await new Promise(r => setTimeout(r, 150));
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const ec = !!MES.getEchoCancellation();
                                    result = ec === !!data.enabled ? { echoCancellation: ec }
                                        : { echoCancellation: ec, error: "echo setting did not apply (module not found?)" };
                                    break;
                                }
                                case "$set_automatic_gain_control": {
                                    const SET = Vencord.Webpack.findByProps("setAutomaticGainControl");
                                    if (SET) SET.setAutomaticGainControl(!!data.enabled);
                                    else Vencord.Webpack.Common.FluxDispatcher.dispatch({ type: "AUDIO_SET_AUTOMATIC_GAIN_CONTROL", enabled: !!data.enabled });
                                    await new Promise(r => setTimeout(r, 150));
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const agc = !!MES.getAutomaticGainControl();
                                    result = agc === !!data.enabled ? { automaticGainControl: agc }
                                        : { automaticGainControl: agc, error: "AGC setting did not apply (module not found?)" };
                                    break;
                                }
                            }
                        } catch (error) {
                            result = { error: error }
                            if (data.increment == undefined) return;
                        }
                        const payload = {
                            type: "$steamcord_request",
                            increment: data.increment,
                            // `?? {}` et PAS `|| {}` : `|| {}` transformait un résultat
                            // booléen `false` (ex. get_local_mute d'un user NON muté) en
                            // `{}` → côté frontend `!!{}` = true → participant affiché
                            // « muet » à tort. `?? {}` ne remplace que null/undefined et
                            // préserve false/0/"".
                            result: result ?? {}
                        };
                        console.debug(data, payload);
                        window.STEAMCORD_WS.send(JSON.stringify(payload));
                        return;
                    }
                    FluxDispatcher.dispatch(data);
                });

                window.STEAMCORD_WS.onopen = function (e) {
                    // CEF only: kick off the mic relay handshake. In Vesktop the mic is
                    // native — don't touch getUserMedia.
                    if (!window.STEAMCORD_IS_VESKTOP) navigator.mediaDevices.getUserMedia();
                    Vencord.Webpack.waitFor("useState", t => {
                        window.STEAMCORD_WS.send(JSON.stringify({ type: "LOADED", result: true }));
                        Vencord.Webpack.onceReady.then(() => {
                            const user = Vencord.Webpack.Common.UserStore.getCurrentUser();
                            if (user) {
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "CONNECTION_OPEN", user }));
                            } else if (window.STEAMCORD_LAST_QR) {
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_QR_SVG", svg_b64: window.STEAMCORD_LAST_QR }));
                            }
                        });
                    });
                }

                window.STEAMCORD_WS.onclose = function (e) {
                    FluxDispatcher._interceptors.pop()
                    setTimeout(function () {
                        connect();
                    }, 100);
                };

                window.STEAMCORD_WS.onerror = function (err) {
                    console.error('Socket encountered error: ', err.message, 'Closing socket');
                    window.STEAMCORD_WS.close();
                };

                Vencord.Webpack.onceReady.then(t => {
                    const user = Vencord.Webpack.Common.UserStore.getCurrentUser();
                    if (user) {
                        window.STEAMCORD_WS.send(JSON.stringify({ type: "CONNECTION_OPEN", user }));
                    }
                });

                FluxDispatcher.addInterceptor(e => {
                    if (e.type == "CHANNEL_SELECT") patchTypingField();

                    // Incoming DM call → Steam toast (DMs only; guild calls are useless).
                    // Respect the user's Discord status: skip if invisible or DnD (busy).
                    try {
                        if (e.type && e.type.indexOf("CALL") === 0)
                            console.log("[Steamcord] CALL event: " + e.type + " ringing=" + JSON.stringify(e.ringing) + " ch=" + e.channelId);
                        if (e.type === "CALL_DELETE" && window.__sc_ringing) {
                            delete window.__sc_ringing[e.channelId];
                        } else if ((e.type === "CALL_CREATE" || e.type === "CALL_UPDATE") && Array.isArray(e.ringing)) {
                            const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
                            window.__sc_ringing = window.__sc_ringing || {};
                            if (!e.ringing.includes(me?.id)) {
                                delete window.__sc_ringing[e.channelId]; // ring stopped / answered
                            } else {
                                const ch = Vencord.Webpack.Common.ChannelStore.getChannel(e.channelId);
                                console.log("[Steamcord] incoming ring for me, ch.type=" + ch?.type + " status=" + Vencord.Webpack.findStore("PresenceStore")?.getStatus?.(me.id));
                                const isDM = ch && (ch.type === 1 || ch.type === 3);
                                const PresenceStore = Vencord.Webpack.findStore("PresenceStore");
                                const status = PresenceStore?.getStatus?.(me.id);
                                const muted = status === "invisible" || status === "dnd";
                                if (isDM && !muted && !window.__sc_ringing[e.channelId]) {
                                    window.__sc_ringing[e.channelId] = true;
                                    let caller = ch.name;
                                    let caller_avatar = null; // avatar Discord de l'appelant → persona de la notif Steam
                                    const r = (ch.rawRecipients && ch.rawRecipients[0]) ||
                                              (ch.recipients && ch.recipients[0]);
                                    const u = (r && typeof r === "object") ? r
                                            : Vencord.Webpack.Common.UserStore.getUser(r);
                                    if (!caller) caller = u?.global_name || u?.username || "Discord";
                                    if (u?.id && u?.avatar)
                                        caller_avatar = "https://cdn.discordapp.com/avatars/" + u.id + "/" + u.avatar + ".png?size=64";
                                    window.STEAMCORD_WS.send(JSON.stringify({ type: "CALL_RING", caller, caller_avatar, channel_id: String(e.channelId) }));
                                }
                            }
                        }
                    } catch (_) {}

                    const shouldPass = [
                        "CONNECTION_OPEN",
                        "LOGOUT",
                        "CONNECTION_CLOSED",
                        "VOICE_STATE_UPDATES",
                        "VOICE_STATE_UPDATE",
                        "VOICE_CHANNEL_SELECT",
                        "AUDIO_TOGGLE_SELF_MUTE",
                        "AUDIO_TOGGLE_SELF_DEAF",
                        "RPC_NOTIFICATION_CREATE",
                        "STREAM_START",
                        "STREAM_STOP",
                        "SPEAKING"
                    ].includes(e.type);
                    if (shouldPass) {
                        // Notification de message : enrichit l'event avec le contexte
                        // (MP ou #chan de serveur) — le backend ne peut pas interroger
                        // les stores Discord. Les mutes/réglages de notif Discord sont
                        // déjà respectés : NOTIFICATION_CREATE n'arrive que si Discord
                        // aurait notifié.
                        if (e.type === "RPC_NOTIFICATION_CREATE") {
                            try {
                                const ch = Vencord.Webpack.Common.ChannelStore.getChannel(e.channelId);
                                e.__sc_dm = !!ch && (ch.type === 1 || ch.type === 3);
                                if (ch && !e.__sc_dm) {
                                    e.__sc_channel = ch.name || "";
                                    const g = ch.guild_id && Vencord.Webpack.Common.GuildStore?.getGuild?.(ch.guild_id);
                                    e.__sc_guild = (g && g.name) || "";
                                }
                            } catch (_) {}
                        }
                        console.log("Dispatching Steamcord event: ", e);
                        window.STEAMCORD_WS.send(JSON.stringify(e));
                    }
                });
                console.log("Steamcord: Added event interceptor");

                // Robust voice-channel tracking: Discord does NOT reliably emit
                // VOICE_CHANNEL_SELECT when you're force-disconnected by joining voice on
                // another device. Poll the store and notify the backend on any change so
                // the QAM state always matches reality (join / leave / move / kicked).
                let steamcordLastVCId = undefined;
                setInterval(() => {
                    try {
                        if (!window.STEAMCORD_WS || window.STEAMCORD_WS.readyState !== 1) return;
                        const selStore = Vencord.Webpack.findStore("SelectedChannelStore");
                        const vcid = selStore?.getVoiceChannelId?.() ?? null;
                        if (vcid !== steamcordLastVCId) {
                            steamcordLastVCId = vcid;
                            let guildId = null;
                            if (vcid) {
                                const ch = Vencord.Webpack.Common.ChannelStore.getChannel(vcid);
                                guildId = ch?.guild_id ?? null;
                            }
                            console.log("[Steamcord] voice channel changed → " + vcid);
                            window.STEAMCORD_WS.send(JSON.stringify({ type: "VOICE_CHANNEL_SELECT", channelId: vcid, guildId }));
                        }

                        // RÉCONCILIATION mute/deaf depuis le STORE autoritatif (et pas
                        // seulement les deltas VOICE_STATE_UPDATES). Discord peut émettre
                        // un état muet TRANSITOIRE à la connexion d'un participant ; si le
                        // delta de nettoyage est manqué (ou arrive sur un autre channelId),
                        // l'icône « muet » restait collée alors que la personne est audible.
                        // On relit la vérité (getVoiceStatesForChannel = ce que l'UI Discord
                        // affiche) et on ne ré-émet QUE si le signal mute/deaf a changé →
                        // auto-guérison sous 2 s, zéro spam / re-render inutile.
                        if (vcid) {
                            const VSS = Vencord.Webpack.findStore("VoiceStateStore");
                            const states = VSS?.getVoiceStatesForChannel?.(vcid) || {};
                            const vsArr = [];
                            for (const uid in states) {
                                const v = states[uid] || {};
                                vsArr.push({
                                    userId: uid, channelId: vcid,
                                    mute: !!(v.mute || v.selfMute), selfMute: !!v.selfMute,
                                    deaf: !!(v.deaf || v.selfDeaf), selfDeaf: !!v.selfDeaf,
                                    video: !!v.selfVideo, selfVideo: !!v.selfVideo,
                                    suppress: !!v.suppress
                                });
                            }
                            const sig = JSON.stringify(vsArr.map(s => [s.userId, s.mute, s.deaf, s.video]));
                            if (sig !== window.__sc_lastVoiceSig) {
                                window.__sc_lastVoiceSig = sig;
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "VOICE_STATE_UPDATES", voiceStates: vsArr }));
                            }
                        } else {
                            window.__sc_lastVoiceSig = undefined;
                        }
                    } catch (_) {}
                }, 2000);

                // Sync des Go Live actifs → is_live des participants dans le QAM. Discord
                // n'émet STREAM_START qu'au DÉMARRAGE : un stream lancé avant notre
                // connexion serait manqué. On diffe l'ensemble des streams actifs et on
                // émet STREAM_START/STOP synthétiques sur changement (clé = call/guild:…:ownerId).
                let steamcordStreamKeys = new Set();
                const steamcordStreamMisses = new Map(); // key -> polls consécutifs où le stream manque
                setInterval(() => {
                    try {
                        if (!window.STEAMCORD_WS || window.STEAMCORD_WS.readyState !== 1) return;
                        const SCS = Vencord.Webpack.findStore("SelectedChannelStore");
                        const vcid = SCS?.getVoiceChannelId?.() ?? null;
                        const now = new Set();
                        if (vcid) {
                            for (const { key, s } of window.__sc_streamsForChannel(vcid)) {
                                now.add(key);
                                steamcordStreamMisses.delete(key);
                                if (!steamcordStreamKeys.has(key)) {
                                    window.STEAMCORD_WS.send(JSON.stringify({ type: "STREAM_START", streamKey: key }));
                                    // Stream (re)créé : si on relaie déjà son propriétaire
                                    // (l'ami a fermé puis rouvert son partage, Discord nous
                                    // re-abonne tout seul), la piste rattrapée par le
                                    // keepalive est souvent NOIRE (pas encore de keyframe) et
                                    // n'est jamais 'ended' → elle reste noire (issue #8). On
                                    // relance proprement le relais : re-watch + capture fraîche.
                                    const owner = s && (s.ownerId || s.userId);
                                    if (owner && window.STEAMCORD_VIDEO[owner])
                                        setTimeout(() => { try { window.STEAMCORD_startVideoRelay(owner); } catch (_) {} }, 1500);
                                }
                            }
                        }
                        // STOP débouncé : le store rend parfois TRANSITOIREMENT vide
                        // (renégociation de qualité, hoquet de reconnexion) → le bouton
                        // « Voir » disparaissait alors que l'ami streamait toujours
                        // (issue #5). Un stream doit manquer 3 polls consécutifs (~6 s)
                        // avant qu'on émette STREAM_STOP.
                        for (const key of steamcordStreamKeys) {
                            if (now.has(key)) continue;
                            const miss = (steamcordStreamMisses.get(key) || 0) + 1;
                            if (miss >= 3) {
                                steamcordStreamMisses.delete(key);
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "STREAM_STOP", streamKey: key }));
                            } else {
                                steamcordStreamMisses.set(key, miss);
                                now.add(key); // considéré actif tant que le débounce court
                            }
                        }
                        steamcordStreamKeys = now;
                    } catch (_) {}
                }, 2000);

                // Chromium freezes the occluded BrowserView: the voice WebRTC stalls at
                // DTLS_CONNECTING AND Discord's mic capture never runs → nobody hears
                // anyone. Keep the view rendered (1×1, barely visible) for the WHOLE time
                // we're in a voice channel so both the connection and the mic capture stay
                // alive; hide it again when we leave the call.
                let steamcordVoiceShown = false;
                setInterval(() => {
                    try {
                        const inVoice = !!Vencord.Webpack.findStore("SelectedChannelStore").getVoiceChannelId();
                        if (inVoice && !steamcordVoiceShown) {
                            steamcordVoiceShown = true;
                            fetch("http://127.0.0.1:65123/voice_render", { mode: "no-cors" }).catch(() => {});
                        } else if (!inVoice && steamcordVoiceShown) {
                            steamcordVoiceShown = false;
                            fetch("http://127.0.0.1:65123/voice_hide", { mode: "no-cors" }).catch(() => {});
                        }
                    } catch (_) {}
                }, 1000);
            }
            connect();
        });

        (() => {
            const t = setInterval(() => {
                try {
                    if (window.location.pathname == "/login") {
                        for (const el of document.getElementsByTagName('input')) {
                            el.onclick = (ev) => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" });
                        }
                    }
                    clearInterval(t);
                }
                catch (err) { }
            }, 100)
        })();

        // ── Wake-lock audio (issue #3) ──────────────────────────────────────
        // Le mixeur Steam du Deck montre un flux de LECTURE « Chromium » qui
        // SURVIT à l'appel : des sinks WebRTC (<audio>/<video> à srcObject)
        // restent « playing » et des pistes micro restent live après avoir
        // quitté le vocal → Chromium garde sa sortie audio ouverte → l'écran ne
        // s'éteint jamais. Suspendre le SEUL audioContext du MediaEngine
        // (v1.14.1) ne suffisait pas : sur la BC-250 il n'existe même pas en
        // appel — les vrais porteurs du wake-lock sont les sinks/pistes. On
        // traque donc tout ce que la page crée pour pouvoir le libérer.
        window.__STEAMCORD_ACS = window.__STEAMCORD_ACS || [];
        window.__STEAMCORD_GUM_STREAMS = window.__STEAMCORD_GUM_STREAMS || [];
        (function installAudioTrackers() {
            if (window.__STEAMCORD_AUDIO_TRACKERS) return;
            window.__STEAMCORD_AUDIO_TRACKERS = true;
            for (const name of ["AudioContext", "webkitAudioContext"]) {
                const Orig = window[name];
                if (!Orig) continue;
                const Wrapped = function (...args) {
                    const inst = new Orig(...args);
                    window.__STEAMCORD_ACS.push(inst);
                    return inst;
                };
                Wrapped.prototype = Orig.prototype;
                window[name] = Wrapped;
            }
            // Wrapper PASSE-PLAT (≠ override micro CEF plus haut : on ne remplace
            // pas la capture, on mémorise juste les streams rendus pour pouvoir
            // stopper les pistes orphelines hors appel). Vesktop only : sous CEF
            // installMicOverride ré-écrase getUserMedia toutes les 2 s.
            if (window.STEAMCORD_IS_VESKTOP) {
                try {
                    const md = navigator.mediaDevices;
                    const origGUM = md.getUserMedia.bind(md);
                    Object.defineProperty(md, "getUserMedia", {
                        configurable: true,
                        value: function (constraints) {
                            const p = origGUM(constraints);
                            p.then((s) => { window.__STEAMCORD_GUM_STREAMS.push(s); }).catch(() => {});
                            return p;
                        },
                    });
                } catch (_) {}
            }
        })();

        // Hors appel (SelectedChannelStore.getVoiceChannelId, même source de
        // vérité que le poller vocal) : suspendre en continu les AudioContexts,
        // et UNE passe de nettoyage profond ~5 s après la fin d'appel
        // (edge-triggered : un test micro lancé plus tard dans les réglages
        // n'est pas impacté). Rejoindre un appel re-resume en ~1,5 s ; Discord
        // recrée sinks et pistes à chaque connexion vocale.
        (function keepAudioAlive() {
            let wasInCall = false;
            let cleanupAt = 0;
            setInterval(() => {
                try {
                    const me = Vencord.Webpack.findStore?.("MediaEngineStore")?.getMediaEngine?.();
                    const engineCtx = me?.audioContext;
                    const inCall = !!Vencord.Webpack.findStore?.("SelectedChannelStore")?.getVoiceChannelId?.();
                    if (inCall) {
                        wasInCall = true;
                        cleanupAt = 0;
                        if (engineCtx && engineCtx.state === "suspended") {
                            engineCtx.resume();
                            console.log("[Steamcord] Resumed MediaEngine AudioContext (in call)");
                        }
                        return;
                    }
                    window.__STEAMCORD_ACS = window.__STEAMCORD_ACS.filter((c) => c.state !== "closed");
                    const ctxs = engineCtx ? [engineCtx, ...window.__STEAMCORD_ACS] : [...window.__STEAMCORD_ACS];
                    for (const ctx of ctxs) {
                        if (ctx.state === "running") {
                            try { ctx.suspend(); console.log("[Steamcord] Suspended AudioContext (idle, frees the audio wake-lock)"); } catch (_) {}
                        }
                    }
                    if (wasInCall) { wasInCall = false; cleanupAt = Date.now() + 5000; }
                    if (cleanupAt && Date.now() >= cleanupAt) {
                        cleanupAt = 0;
                        let sinks = 0, mics = 0;
                        for (const el of document.querySelectorAll("audio, video")) {
                            // Seulement les sinks WebRTC (srcObject) — jamais un média
                            // « normal » (sons de notification, aperçus…).
                            if (el.srcObject && !el.paused) {
                                try { el.pause(); el.srcObject = null; sinks++; } catch (_) {}
                            }
                        }
                        for (const stream of window.__STEAMCORD_GUM_STREAMS.splice(0)) {
                            for (const t of stream.getTracks()) {
                                if (t.readyState === "live") { try { t.stop(); mics++; } catch (_) {} }
                            }
                        }
                        if (sinks || mics)
                            console.log("[Steamcord] post-call audio cleanup: " + sinks + " sink(s), " + mics + " capture track(s) released");
                    }
                } catch(_) {}
            }, 1500);
        })();

        // Token login: callable from QAM via CDP
        window.steamcordLoginWithToken = function(token) {
            const loginMod = Vencord.Webpack.find(m => m && typeof m.loginToken === "function");
            if (loginMod) {
                loginMod.loginToken(token, true);
                return "ok";
            }
            localStorage.setItem("token", JSON.stringify(token));
            location.reload();
            return "reload";
        };

        // Canvas QR mirror: extract Discord's own QR when the tab is visible (no spinner)
        window.STEAMCORD_LAST_QR = null;
        (function startCanvasQRMirror() {
            const sendQR = (url) => {
                window.STEAMCORD_LAST_QR = url;
                if (window.STEAMCORD_WS?.readyState === 1)
                    window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_QR_SVG", svg_b64: url }));
            };
            // Discord rend désormais le QR en <svg> (≈160px, viewBox carré "0 0 37 37",
            // un gros <path> de modules), PAS en canvas (le canvas 240×240 est un
            // placeholder caché/coloré). On capture le SVG → data URL que l'<img> du QAM
            // affiche directement. Détection = SVG carré 100–300px avec une grosse data
            // de path (le QR ≈ 35 Ko ; les logos/icônes ont des paths courts).
            const findQRSvg = () => {
                for (const s of document.querySelectorAll("svg")) {
                    const r = s.getBoundingClientRect();
                    if (r.width < 100 || r.width > 320 || Math.abs(r.width - r.height) > 30) continue;
                    let pathLen = 0;
                    for (const p of s.querySelectorAll("path, rect")) pathLen += (p.getAttribute("d") || "").length;
                    if (pathLen > 3000) return s;
                }
                return null;
            };
            const svgToDataUrl = (svg) => {
                const clone = svg.cloneNode(true);
                clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
                const s = new XMLSerializer().serializeToString(clone);
                return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(s)));
            };
            const sendScanned = (b) => {
                if (window.STEAMCORD_WS?.readyState === 1)
                    window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_SCANNED", scanned: b }));
            };
            let lastUrl = null, lastScanned = false;
            setInterval(() => {
                try {
                    if (Vencord.Webpack.Common.UserStore?.getCurrentUser?.()) {
                        if (lastUrl !== null) { lastUrl = null; sendQR(null); }
                        if (lastScanned) { lastScanned = false; sendScanned(false); }
                        return;
                    }
                    const svg = findQRSvg();
                    if (svg) {
                        if (lastScanned) { lastScanned = false; sendScanned(false); }
                        const url = svgToDataUrl(svg);
                        if (url.length > 2000 && url !== lastUrl) { lastUrl = url; sendQR(url); }
                        return;
                    }
                    // Pas de QR. Soit SCANNÉ (Discord affiche « regarde ton téléphone » avec
                    // l'avatar du compte → attente de validation), soit en chargement.
                    if (lastUrl !== null) { lastUrl = null; sendQR(null); }
                    const scanned = !!document.querySelector('img[src*="avatars"]');
                    if (scanned !== lastScanned) { lastScanned = scanned; sendScanned(scanned); }
                } catch (e) { /* ignore */ }
            }, 1500);
        })();

        // Remote auth: our own WS, QR from segno (Python), ticket sent to backend for POST with desktop UA
        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
        window.steamcordStartRemoteAuth = async function() {
            if (window.STEAMCORD_REMOTE_AUTH_ACTIVE) return;
            window.STEAMCORD_REMOTE_AUTH_ACTIVE = true;
            try {
                const keyPair = await crypto.subtle.generateKey(
                    { name: "RSA-OAEP", modulusLength: 2048,
                      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
                    true, ["decrypt"]
                );
                const pubDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
                const encodedPub = btoa(String.fromCharCode(...new Uint8Array(pubDer)));
                const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

                const ws = new WebSocket("wss://remote-auth-gateway.discord.gg/?v=2");
                let hbTimer = null;

                ws.onmessage = async (event) => {
                    const data = JSON.parse(event.data);
                    const op = data.op;
                    if (op === "hello") {
                        hbTimer = setInterval(() => ws.send(JSON.stringify({ op: "heartbeat" })), data.heartbeat_interval);
                        ws.send(JSON.stringify({ op: "init", encoded_public_key: encodedPub }));
                    } else if (op === "nonce_proof") {
                        const enc = Uint8Array.from(atob(data.encrypted_nonce), c => c.charCodeAt(0));
                        const nonce = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keyPair.privateKey, enc);
                        const hash = await crypto.subtle.digest("SHA-256", nonce);
                        const proof = btoa(String.fromCharCode(...new Uint8Array(hash)))
                            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
                        ws.send(JSON.stringify({ op: "nonce_proof", proof }));
                    } else if (op === "pending_remote_init") {
                        if (window.STEAMCORD_WS?.readyState === 1)
                            window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_FINGERPRINT", fingerprint: data.fingerprint }));
                    } else if (op === "pending_login") {
                        if (hbTimer) clearInterval(hbTimer);
                        ws.close(1000);
                        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                        // Send ticket + private key to backend — Python makes the POST with desktop UA
                        if (window.STEAMCORD_WS?.readyState === 1)
                            window.STEAMCORD_WS.send(JSON.stringify({
                                type: "REMOTE_AUTH_TICKET",
                                ticket: data.ticket,
                                priv_jwk: JSON.stringify(privJwk)
                            }));
                        return;
                    } else if (op === "cancel") {
                        if (hbTimer) clearInterval(hbTimer);
                        ws.close(1000);
                        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                        if (window.STEAMCORD_WS?.readyState === 1)
                            window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_FINGERPRINT", fingerprint: null }));
                        setTimeout(window.steamcordStartRemoteAuth, 3000);
                    }
                };
                ws.onerror = () => {};
                ws.onclose = (e) => {
                    if (hbTimer) clearInterval(hbTimer);
                    if (e.code !== 1000 && e.code !== 1001) {
                        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                        setTimeout(window.steamcordStartRemoteAuth, 3000);
                    }
                };
            } catch(e) {
                window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                setTimeout(window.steamcordStartRemoteAuth, 5000);
            }
        };

        // Our custom remote-auth (Python ticket exchange) triggers Discord's hCaptcha,
        // especially on a flagged IP. In Vesktop we DON'T need it: the native Discord
        // login page shows its own QR, which startCanvasQRMirror() mirrors to the QAM —
        // scanning it logs Vesktop in natively, no ticket exchange, no CAPTCHA. So only
        // run the custom remote-auth in the CEF flow.
        if (!window.STEAMCORD_IS_VESKTOP) {
            Vencord.Webpack.onceReady.then(() => {
                if (!Vencord.Webpack.Common.UserStore.getCurrentUser()) window.steamcordStartRemoteAuth();
            });
            setInterval(() => {
                if (!Vencord.Webpack.Common.UserStore?.getCurrentUser?.() && !window.STEAMCORD_REMOTE_AUTH_ACTIVE)
                    window.steamcordStartRemoteAuth();
            }, 15000);
        }
    }
};

// In Vesktop, Vencord is already initialized and won't auto-start our (late-injected)
// plugin, so start it ourselves once Vencord/Webpack is ready. (In the CEF flow Vencord
// is injected fresh and calls start() itself.)
if (window.STEAMCORD_IS_VESKTOP && !window.__steamcord_started) {
    window.__steamcord_started = true;
    (function waitAndStart() {
        try {
            if (window.Vencord && window.Vencord.Webpack && window.Vencord.Webpack.Common) {
                window.Vencord.Plugins.plugins.Steamcord.start();
                console.log("[Steamcord] started in Vesktop");
                return;
            }
        } catch (e) { console.log("[Steamcord] vesktop start err " + e.message); }
        setTimeout(waitAndStart, 500);
    })();
}