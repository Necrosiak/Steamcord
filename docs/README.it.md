# Streamcord

**Discord nella Modalità Gioco di Steam** — un plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) per Steam Deck / Bazzite / SteamOS.

🌍 **Lingue:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Italiano** · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Streamcord è un fork indipendente di [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> Non è affiliato, approvato o supportato dal progetto Deckcord originale.
> Il codice è molto divergente — la maggior parte delle funzioni è stata riscritta o aggiunta da zero.
>
> L'interfaccia è completamente tradotta in 9 lingue e segue automaticamente la lingua di SteamOS.

---

## Funzioni (e come funzionano)

- **Accesso con codice QR** — Scansiona un codice QR con l'app mobile di Discord per accedere all'istante. Sul telefono: *Discord → Impostazioni → Scansiona QR Code*, poi inquadra il codice mostrato nel pannello. Nessuna password da digitare sulla Deck.
- **Accesso a schermo intero (alternativa)** — Apre Discord a schermo intero per accedere con email/password o risolvere un CAPTCHA quando il QR non è possibile.
- **Chat vocale** — Entra nei canali vocali e ascolta tutti, con ogni membro mostrato in tempo reale (anello quando parla, badge muto/audio disattivato) e un cursore del volume per persona (0–200 %).
- **Messaggi diretti (MP e gruppi)** — Sfoglia le tue conversazioni e avvia/entra in chiamate vocali con gli amici direttamente dal menu di accesso rapido. Le chiamate attive sono evidenziate.
- **Browser vocale dei server** — Vedi quali canali vocali hanno persone (con gli avatar) prima di entrare.
- **Muto / Audio disattivato / Disconnetti** — Controlli vocali con un tocco dal QAM.
- **Go Live (condivisione schermo)** — Condividi l'intero schermo in un canale vocale.
- **Relay del microfono** — Il tuo microfono viene catturato nell'interfaccia di Steam e inoltrato a Discord, così gli altri ti sentono anche se Discord gira in una scheda nascosta in background. Ingresso e uscita seguono automaticamente il tuo dispositivo audio predefinito (collega delle cuffie e cambia da solo).
- **Stato di gioco** — Mostra il gioco a cui stai giocando come stato Discord.
- **Notifiche in gioco** — MP e menzioni appaiono come notifiche di Steam.
- **Push-to-talk** — Con un tasto fisico (R5 di default).
- **Invio di screenshot** — Invia uno screenshot di Steam a qualsiasi canale Discord.
- **[Vencord](https://vencord.dev/)** viene iniettato automaticamente, dando accesso al suo ecosistema di plugin.

---

## Come funziona l'audio (la parte difficile)

Discord gira in una vista browser **nascosta** dentro Steam. Due cose fanno funzionare la voce:

1. **Sentire gli altri** — Chromium sospende l'audio nelle schede nascoste (policy di autoplay). Streamcord riprende l'audio di Discord con un gesto utente simulato tramite CDP, così la voce in arrivo viene riprodotta sulla tua uscita predefinita.
2. **Essere sentiti** — La scheda nascosta non può catturare il microfono, quindi il microfono reale viene catturato nel contesto dell'interfaccia di Steam e inoltrato a Discord tramite una connessione WebRTC locale.

Ingresso e uscita seguono automaticamente il tuo dispositivo predefinito.

---

## Installazione

> **Non ancora sul Decky Store.** Installazione manuale tramite la modalità sviluppatore.

1. Attiva la **modalità sviluppatore** in Decky → Impostazioni generali
2. Vai su **Sviluppatore** nelle impostazioni di Decky
3. Installa dall'URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Requisito (condivisione schermo)
Il server di condivisione usa il Python di sistema + GStreamer. Installa le dipendenze Python una volta:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Compilare dai sorgenti

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# copia dist/, main.py, defaults/, plugin.json, package.json in ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Ringraziamenti

- Progetto originale: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architettura, BrowserView, condivisione schermo GStreamer
- [@aagaming](https://github.com/AAGaming00) — supporto microfono tramite la scheda SteamClient (relay WebRTC)
- [@Epictek](https://github.com/Epictek) — base dell'accesso con QR Code
- [@jessebofill](https://github.com/jessebofill) — codice per il patching del menu Steam
