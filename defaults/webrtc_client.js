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
        // 8s, et plus 25. Le budget d'origine additionnait les pires cas
        // (auto-validation ~1s + venmic + Start ≤5s + établissement PipeWire),
        // mais quand le chemin natif ABOUTIT il répond en 1 à 2 s : les 25 s
        // n'étaient jamais un temps d'attente utile, seulement le prix de
        // l'échec. Or sur une machine où le natif échoue systématiquement —
        // mesuré le 13/09, tous les Go Live finissent sur le relais — c'est
        // 25 s d'attente à chaque lancement, pour rien. Le repli produit une
        // image et un son corrects ; le seul coût est un réencodage.
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            console.warn("[Steamcord] portail natif muet après 8s → repli sur le relais");
            try {
                window.STEAMCORD_WS.send(JSON.stringify({ type: "$diag",
                    m: "[golive] portail natif muet après 8s → repli relais" }));
            } catch (_) {}
            reject(new Error("native portal timeout (8s)"));
        }, 8000);
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
            // #38 : GStreamer incomplet (typiquement gst-plugins-bad absent, donc
            // pas de webrtcbin). Sans ce message l'échec ressemblait à « aucune
            // source » et envoyait le diagnostic dans le mur. On nomme le paquet.
            if (data.missing_plugins) {
                clearTimeout(fbTimer);
                console.error("[Steamcord] GStreamer incomplet — éléments manquants : "
                    + data.missing_plugins.join(", ")
                    + " — paquet(s) à installer : " + (data.packages || []).join(", "));
                return fail("gst missing_plugins: " + data.missing_plugins.join(","));
            }
            if (data.sdp) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } else if (data.ice) {
                try { await peerConnection.addIceCandidate(data.ice); } catch (_) {}
            }
        };

        ws.onerror = () => { clearTimeout(fbTimer); fail("ws error"); };
    });

    // L'aperçu du QAM se sert de CETTE stream, pas d'une capture à part.
    //
    // Avant, la vignette coûtait un `gamescopectl screenshot` + un ffmpeg à
    // chaque rafraîchissement — mesuré ~0,57 cœur·seconde par image. Or Vesktop
    // détient déjà la stream qu'il encode et envoie : en tirer une image ne
    // coûte qu'un `drawImage`, et surtout n'ajoute AUCUN consommateur PipeWire.
    // C'est ce dernier point qui compte : c'est un second consommateur sur le
    // node gamescope qui figeait le partage chez les spectateurs (01/09).
    const keepShareStream = (stream) => {
        window.STEAMCORD_SHARE_STREAM = stream;
        try {
            const t = stream.getVideoTracks()[0];
            if (t) t.addEventListener("ended", () => {
                if (window.STEAMCORD_SHARE_STREAM === stream) window.STEAMCORD_SHARE_STREAM = undefined;
            });
        } catch (_) {}
        return stream;
    };

    // Rend une image JPEG en base64, ou "" si aucune stream n'est disponible.
    window.STEAMCORD_GRAB_FRAME = async (maxWidth) => {
        const stream = window.STEAMCORD_SHARE_STREAM;
        const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
        if (!track || track.readyState !== "live") return "";
        const bmp = await new ImageCapture(track).grabFrame();
        const w = Math.min(maxWidth || 640, bmp.width || 640);
        const h = Math.max(1, Math.round((bmp.height || 360) * (w / (bmp.width || 640))));
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
        try { bmp.close(); } catch (_) {}
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return btoa(bin);
    };

    // Le portail natif a-t-il déjà échoué dans CETTE session ? Sur une machine
    // où il ne répond pas, le réessayer à chaque Go Live coûte les 8 s du budget
    // à chaque fois — mesuré ce jour : 8 s sur 9 s de latence totale, pour un
    // chemin qui n'a jamais abouti une seule fois. On ne le retente donc pas
    // avant le prochain chargement du plugin, ce qui laisse une chance à une
    // machine où il se remettrait à marcher, sans faire payer les autres.
    let nativePortalDead = false;

    const steamcordGDM = async (constraints) => {
        /* STEAMCORD_RTC 65124 — marqueur pour looksLikeOurs (anti re-wrap) */
        if (nativeGetDisplayMedia && !nativePortalDead) {
            try {
                const stream = await nativeFirst(constraints);
                console.log("[Steamcord] getDisplayMedia → portail natif OK");
                return keepShareStream(stream);
            } catch (e) {
                nativePortalDead = true;
                console.log("[Steamcord] getDisplayMedia natif KO (" + ((e && e.message) || e) + ") → relais GStreamer local ; les prochains partages iront direct au relais");
                try {
                    window.STEAMCORD_WS.send(JSON.stringify({ type: "$diag",
                        m: "[golive] portail natif écarté pour cette session — les prochains Go Live partent direct au relais" }));
                } catch (_) {}
            }
        }
        return keepShareStream(await getRTCStream(constraints));
    };

    if (window.navigator?.mediaDevices) {
        window.navigator.mediaDevices.getDisplayMedia = steamcordGDM;
    }
})();
