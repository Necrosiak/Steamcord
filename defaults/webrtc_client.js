(() => {
    let waitingForMedia = false;
    // getDisplayMedia NATIF (portail Electron/xdg) capturé AVANT la surcharge.
    const md = window.navigator?.mediaDevices;
    // Capturer le VRAI getDisplayMedia natif UNE seule fois, et JAMAIS notre propre
    // override (sinon une ré-injection ferait fallback sur lui-même). On reconnaît
    // le nôtre à sa source, et on mémorise le natif sur window pour les ré-injections.
    // NB : si la patch screenShareFixes de Vesktop est passée avant nous, le « natif »
    // capturé est SON wrapper (venmic + contraintes de qualité) autour du vrai natif —
    // c'est exactement ce qu'on veut.
    const looksLikeOurs = (fn) => { try { return /STEAMCORD_RTC|65124|fallbackNative/.test(fn.toString()); } catch (_) { return false; } };
    if (md && md.getDisplayMedia && !window.STEAMCORD_NATIVE_GDM && !looksLikeOurs(md.getDisplayMedia)) {
        window.STEAMCORD_NATIVE_GDM = md.getDisplayMedia.bind(md);
    }
    const nativeGetDisplayMedia = window.STEAMCORD_NATIVE_GDM || null;

    // ── Stratégie getDisplayMedia : portail NATIF d'abord, relais GStreamer en repli ──
    // MODE JEU : portal_shim.py (backend) possède org.freedesktop.portal.Desktop et
    // sert le node PipeWire gamescope → le chemin de capture natif de Chromium marche
    // (vrai Go Live, pleine résolution, pas de double encodage). La modale Vesktop est
    // auto-validée par steamcord_client.js (fenêtre invisible). BUREAU : le portail du
    // DE (KDE…) répond, comme avant. Si AUCUN portail ne répond (shim arrêté, distro
    // sans portail), getDisplayMedia rejette vite → repli sur le relais WebRTC local
    // (gst_webrtc.py, l'ancien chemin mode jeu). Le relais ne re-tente JAMAIS le natif
    // (le natif a déjà échoué) — sinon boucle.
    const nativeFirst = (constraints) => new Promise((resolve, reject) => {
        let done = false;
        // 25s : auto-validation de la modale (~1s) + venmic + Start du portail
        // (≤5s de recherche du node) + établissement PipeWire. Au-delà = bloqué.
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error("native portal timeout (25s)"));
        }, 25000);
        nativeGetDisplayMedia(constraints).then((stream) => {
            if (done) {
                // Résolution APRÈS le timeout : ne pas laisser une session de
                // capture orpheline tourner en fond.
                try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
                return;
            }
            done = true; clearTimeout(timer);
            resolve(stream);
        }, (e) => {
            if (!done) { done = true; clearTimeout(timer); reject(e); }
        });
    });

    // Relais WebRTC local (gst_webrtc.py sur 65124) — capture pipewiresrc encodée
    // VP8 et renvoyée au renderer. Legacy : sert uniquement quand le portail natif
    // a échoué. `no_source` (bureau sans node gamescope) = échec terminal ici.
    const getRTCStream = (constraints) => new Promise((resolve, reject) => {
        if (window.STEAMCORD_RTC_STREAM) return resolve(window.STEAMCORD_RTC_STREAM);
        if (waitingForMedia) return reject(new Error("relais déjà en cours"));
        waitingForMedia = true;

        let settled = false;
        const peerConnection = new RTCPeerConnection(null);
        const ws = new WebSocket("ws://127.0.0.1:65124/webrtc");
        window.STEAMCORD_PEER_CONNECTION = peerConnection;
        const inbound = new MediaStream();

        const fail = (why) => {
            if (settled) return;
            settled = true;
            waitingForMedia = false;
            try { ws.close(); } catch (_) {}
            try { peerConnection.close(); } catch (_) {}
            console.log("[Steamcord] relais GStreamer KO (" + why + ")");
            reject(new Error("relais GStreamer: " + why));
        };
        // Si gst ne renvoie aucune piste vidéo sous 4s (source absente), échec.
        let fbTimer = setTimeout(() => fail("timeout gst (aucune source)"), 4000);

        // API moderne (Chrome 144) : ontrack remplace onaddstream.
        peerConnection.ontrack = (ev) => {
            inbound.addTrack(ev.track);
            // Attendre la piste vidéo avant de résoudre (l'audio peut arriver avant).
            if (inbound.getVideoTracks().length === 0) return;
            if (settled) return;
            settled = true;
            clearTimeout(fbTimer);
            window.STEAMCORD_RTC_STREAM = inbound;
            for (const track of inbound.getTracks()) {
                track.stop = () => {
                    try { ws.send(JSON.stringify({ "stop": "" })); } catch (_) {}
                    try { peerConnection.close(); } catch (_) {}
                    window.STEAMCORD_RTC_STREAM = undefined;
                };
            }
            waitingForMedia = false;
            resolve(inbound);
        };

        // Poser le listener ICE AVANT createOffer (sinon candidats précoces perdus).
        peerConnection.addEventListener("icecandidate", (event) => {
            if (event.candidate) { try { ws.send(JSON.stringify({ "ice": event.candidate })); } catch (_) {} }
        });

        peerConnection.onconnectionstatechange = () => {
            if (peerConnection.connectionState === "failed") {
                clearTimeout(fbTimer);
                fail("rtc peer connection failed");
            }
        };

        ws.onopen = async () => {
            // recvonly : on REÇOIT la vidéo+audio de GStreamer.
            peerConnection.addTransceiver("video", { direction: "recvonly" });
            peerConnection.addTransceiver("audio", { direction: "recvonly" });
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            ws.send(JSON.stringify({ "offer": offer }));
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.no_source) {           // gst : pas d'écran capturable
                clearTimeout(fbTimer);
                return fail("gst no_source");
            }
            if (data.sdp) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } else if (data.ice) {
                try { await peerConnection.addIceCandidate(data.ice); } catch (_) {}
            }
        };

        ws.onerror = () => { clearTimeout(fbTimer); fail("ws error"); };
    });

    const steamcordGDM = async (constraints) => {
        /* STEAMCORD_RTC 65124 — marqueur pour looksLikeOurs (anti re-wrap) */
        if (nativeGetDisplayMedia) {
            try {
                const stream = await nativeFirst(constraints);
                console.log("[Steamcord] getDisplayMedia → portail natif OK");
                return stream;
            } catch (e) {
                console.log("[Steamcord] getDisplayMedia natif KO (" + ((e && e.message) || e) + ") → relais GStreamer local");
            }
        }
        return getRTCStream(constraints);
    };

    if (window.navigator?.mediaDevices) {
        window.navigator.mediaDevices.getDisplayMedia = steamcordGDM;
    }
})();
