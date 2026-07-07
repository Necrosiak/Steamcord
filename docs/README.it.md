# Steamcord

**Discord nella Modalità Gioco di Steam** — un plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) per Steam Deck / Bazzite / SteamOS.

🌍 **Lingue:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Italiano** · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord è un progetto indipendente.** È stato inizialmente ispirato da
> [Deckcord](https://github.com/marios8543/Deckcord) (vedi Ringraziamenti), ma il codice è stato
> ampiamente riscritto e ora segue la propria direzione — non è affiliato né approvato da
> quel progetto.
>
> L'interfaccia è completamente tradotta in 9 lingue e segue automaticamente la lingua di SteamOS.

---

## Come funziona

Steamcord avvia **[Vesktop](https://github.com/Vencord/Vesktop)** — un vero client Discord nativo — invisibile in background, e lo pilota tramite il Chrome DevTools Protocol. Il plugin vi inietta un piccolo client ed espone tutto nel **menu di accesso rapido** di Steam.

Il passaggio al nativo risolve i problemi difficili del vecchio approccio a browser nascosto: **il tuo microfono e l'audio vocale funzionano in modo nativo**, esattamente come nell'app desktop di Discord — niente trucchi di cattura, niente aggiramenti dell'autoplay. Vesktop viene avviato (e installato se manca) automaticamente, resta connesso dopo i riavvii e non ha mai bisogno di una finestra desktop in Modalità Gioco.

---

## Funzioni

- **Un Discord per account Steam (multi-sessione)** — Ogni utente Steam della macchina ha **il proprio profilo Discord**: cambia account Steam e Steamcord cambia Discord automaticamente in pochi secondi (la prima volta mostra il login QR; poi ogni sessione viene ricordata). Nessuno finisce nel Discord di qualcun altro.
- **Accesso con codice QR** — Scansiona un codice QR con l'app mobile di Discord per accedere all'istante. Sul telefono: *Discord → Impostazioni → Scansiona QR Code*, poi inquadra il codice mostrato nel pannello. Nessuna password da digitare sulla Deck.
- **Accesso a schermo intero (alternativa)** — Apre Discord a schermo intero per accedere con email/password o risolvere un CAPTCHA quando il QR non è possibile.
- **Navigazione unificata** — Schede **Vocale / Testo / ⚙️ Impostazioni** in alto, con un selettore **Server / MP** condiviso sotto: lo stesso interruttore di sorgente vale per la voce e per il testo.
- **Chat vocale** — Entra nei canali vocali e ascolta tutti, con ogni membro mostrato in tempo reale (anello quando parla, badge muto/audio disattivato), un cursore del volume per persona (0–200 %) **e un muto locale per persona** (silenzia qualcuno solo per te, senza che lo sappia). Microfono e audio nativi (Vesktop).
- **Messaggi diretti (MP e gruppi)** — Sfoglia le tue conversazioni e avvia/entra in chiamate vocali con gli amici direttamente dal menu di accesso rapido. Le chiamate attive sono evidenziate.
- **Browser vocale dei server** — Vedi quali canali vocali hanno persone (con gli avatar) prima di entrare.
- **Chat testuale — server *e* MP** — Leggi e rispondi a un canale di un server **o a una conversazione privata** dal QAM (campo a larghezza piena, la tastiera di Steam si apre da sola). **Le immagini allegate appaiono come miniature** (caricate solo mentre il canale è aperto) e **i link si aprono nel browser della Modalità Gioco**. Scorrimento automatico all'ultimo messaggio.
- **Stato Discord sul tuo nome** — Il tuo **nome utente cliccabile** in alto mostra lo stato attuale; toccalo per cambiarlo. Una sincronizzazione automatica opzionale fa **seguire a Discord il tuo stato Steam** in background; scegliere uno stato a mano torna alla modalità manuale.
- **Selezione dei dispositivi audio** — Dalle Impostazioni scegli il dispositivo di **uscita (audio Discord)** e di **ingresso (microfono)** — *Auto (predefinito di sistema)* o uno specifico, ad es. mandare l'audio Discord solo alle **cuffie** mentre il gioco resta sull'HDMI.
- **Muto / Audio disattivato / Disconnetti** — Controlli vocali con un tocco dal QAM.
- **Condivisione schermo** — Condividi l'intero schermo in un canale vocale (Go Live). Funziona nativamente in Desktop / Big Picture. **In Modalità Gioco (gamescope) è in _beta_:** gamescope non ha un portale di cattura dello schermo (il Go Live normale è uno schermo nero), quindi un pulsante separato **«Condividi schermo (modalità gioco)»** cattura il gioco tramite una fotocamera virtuale (v4l2loopback) alimentata direttamente dall'uscita PipeWire di gamescope — l'unico percorso di cattura che funziona lì. Richiede una configurazione una tantum di v4l2loopback.
- **Condivisione dell'audio di gioco** — Trasmetti il suono del tuo gioco nel canale vocale **insieme alla tua voce**. Due cursori di mixaggio (🎙️ voce / 🎮 gioco) regolano ciò che sentono gli altri, mentre tu continui a sentire il gioco normalmente — e funziona anche **senza microfono fisico** (il plugin crea un ingresso virtuale *Steamcord Mic*).
- **Notifiche in gioco** — Le chiamate MP in arrivo e le menzioni appaiono come **notifiche native di Steam (popup + suono)**, rispettando il tuo stato Discord (silenziate quando invisibile / non disturbare).
- **Push-to-talk** — Con un tasto fisico (R5 di default).
- **Invio di screenshot** — Invia uno screenshot di Steam direttamente nella conversazione aperta.
- **[Vencord](https://vencord.dev/)** è integrato in Vesktop, dando accesso al suo ecosistema di plugin.
- 🐧 **Compatibilità** — lavoriamo attivamente per supportare ogni OS in grado di eseguire Steam in modalità gioco / Big Picture (Linux per ora): rilevamento portabile, dipendenze Python incluse, nessuna assunzione specifica di distribuzione.

---

## Installazione

> **Non ancora sul Decky Store.** Installazione manuale tramite la modalità sviluppatore.

1. Attiva la **modalità sviluppatore** in Decky → Impostazioni generali
2. Vai su **Sviluppatore** nelle impostazioni di Decky
3. Installa dall'URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop viene installato e avviato automaticamente dal plugin al primo avvio. Accedi una sola volta (QR o schermo intero) e resti connesso.

### Requisito (condivisione schermo)
La condivisione dello schermo funziona subito: il plugin installa automaticamente la sua dipendenza Python (aiohttp) al primo avvio. GStreamer è fornito dal sistema.

---

## Compilare dai sorgenti

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copia dist/, main.py, defaults/, plugin.json, package.json in ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Ringraziamenti

- Progetto originale: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architettura, BrowserView, condivisione schermo GStreamer
- [@aagaming](https://github.com/AAGaming00) — supporto microfono tramite la scheda SteamClient (relay WebRTC)
- [@Epictek](https://github.com/Epictek) — base dell'accesso con QR Code
- [@jessebofill](https://github.com/jessebofill) — codice per il patching del menu Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — il client Discord nativo che Steamcord pilota
