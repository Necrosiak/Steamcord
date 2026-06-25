# Streamcord

**Discord im Steam-Spielmodus** — ein [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)-Plugin für Steam Deck / Bazzite / SteamOS.

🌍 **Sprachen:** [English](../README.md) · [Français](README.fr.md) · **Deutsch** · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Streamcord ist ein unabhängiger Fork von [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> Es ist nicht mit dem ursprünglichen Deckcord-Projekt verbunden, von ihm unterstützt oder befürwortet.
> Der Code hat sich stark verändert — die meisten Funktionen wurden neu geschrieben oder von Grund auf hinzugefügt.
>
> Die Oberfläche ist vollständig in 9 Sprachen übersetzt und folgt automatisch deiner SteamOS-Sprache.

---

## Funktionen (und wie sie funktionieren)

- **QR-Code-Anmeldung** — Scanne einen QR-Code mit der Discord-Handy-App, um dich sofort anzumelden. Auf deinem Handy: *Discord → Einstellungen → QR-Code scannen*, dann auf den im Panel angezeigten Code richten. Kein Passwort-Tippen auf dem Deck.
- **Vollbild-Anmeldung (Ausweichlösung)** — Öffnet Discord im Vollbild zur Anmeldung mit E-Mail/Passwort oder zum Lösen eines CAPTCHAs, wenn QR nicht möglich ist.
- **Sprachchat** — Tritt Sprachkanälen bei und höre alle, jedes Mitglied live angezeigt (Sprechring, Stumm-/Taub-Abzeichen) mit Lautstärkeregler pro Person (0–200 %).
- **Direktnachrichten (DMs & Gruppen-DMs)** — Durchsuche deine Unterhaltungen und starte/tritt Sprachanrufen mit Freunden direkt aus dem Schnellzugriffsmenü bei. Aktive Anrufe werden hervorgehoben.
- **Server-Sprachbrowser** — Sieh, in welchen Sprachkanälen Leute sind (mit Avataren), bevor du beitrittst.
- **Stumm / Taub / Trennen** — Sprachsteuerung mit einem Tippen aus dem QAM.
- **Go Live (Bildschirmübertragung)** — Teile deinen ganzen Bildschirm in einem Sprachkanal.
- **Mikrofon-Relay** — Dein Mikrofon wird in der Steam-Oberfläche erfasst und an Discord weitergeleitet, sodass dich andere hören, obwohl Discord in einem versteckten Hintergrund-Tab läuft. Ein- und Ausgabe folgen automatisch deinem Standard-Audiogerät (Headset einstecken, es wechselt von selbst).
- **Spielstatus** — Zeigt das gespielte Spiel als deinen Discord-Status.
- **Benachrichtigungen im Spiel** — DM- und Ping-Benachrichtigungen erscheinen als Steam-Toasts.
- **Push-to-Talk** — Mit physischer Tastenbelegung (R5 standardmäßig).
- **Screenshots senden** — Sende einen Steam-Screenshot an jeden Discord-Kanal.
- **[Vencord](https://vencord.dev/)** wird automatisch injiziert und gibt Zugang zu seinem Plugin-Ökosystem.

---

## Wie der Ton funktioniert (der schwierige Teil)

Discord läuft in einer **versteckten** Browser-Ansicht in Steam. Zwei Dinge lassen den Sprachchat funktionieren:

1. **Andere hören** — Chromium pausiert Audio in versteckten Tabs (Autoplay-Richtlinie). Streamcord setzt Discords Audio mit einer per CDP simulierten Nutzeraktion fort, sodass eingehende Stimmen tatsächlich auf deiner Standardausgabe abgespielt werden.
2. **Gehört werden** — Der versteckte Tab kann das Mikrofon nicht erfassen, daher wird das echte Mikrofon im Steam-UI-Kontext erfasst und über eine lokale WebRTC-Verbindung an Discord weitergeleitet.

Ein- und Ausgabe folgen automatisch deinem Standardgerät.

---

## Installation

> **Noch nicht im Decky Store.** Manuelle Installation über den Entwicklermodus.

1. Aktiviere den **Entwicklermodus** in Decky → Allgemeine Einstellungen
2. Gehe zu **Entwickler** in den Decky-Einstellungen
3. Installiere von der URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Voraussetzung (Bildschirmübertragung)
Der Übertragungsserver nutzt das System-Python + GStreamer. Installiere die Python-Abhängigkeiten einmalig:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Aus dem Quellcode bauen

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# dist/, main.py, defaults/, plugin.json, package.json nach ~/homebrew/plugins/Streamcord/ kopieren
sudo systemctl restart plugin_loader
```

---

## Danksagungen

- Ursprüngliches Projekt: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — Architektur, BrowserView, GStreamer-Bildschirmübertragung
- [@aagaming](https://github.com/AAGaming00) — Mikrofon-Unterstützung über den SteamClient-Tab (WebRTC-Relay)
- [@Epictek](https://github.com/Epictek) — Grundlage der QR-Code-Anmeldung
- [@jessebofill](https://github.com/jessebofill) — Code für das Steam-Menü-Patching
