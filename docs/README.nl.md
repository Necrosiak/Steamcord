# Streamcord

**Discord in de Steam-spelmodus** — een [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)-plugin voor Steam Deck / Bazzite / SteamOS.

🌍 **Talen:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · **Nederlands** · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Streamcord is een onafhankelijke fork van [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> Het is niet verbonden met, goedgekeurd door of ondersteund door het originele Deckcord-project.
> De code is sterk afgeweken — de meeste functies zijn herschreven of vanaf nul toegevoegd.
>
> De interface is volledig vertaald in 9 talen en volgt automatisch je SteamOS-taal.

---

## Functies (en hoe ze werken)

- **Aanmelden met QR-code** — Scan een QR-code met de Discord-app op je telefoon om direct in te loggen. Op je telefoon: *Discord → Instellingen → QR-code scannen*, richt dan op de code in het paneel. Geen wachtwoord typen op de Deck.
- **Volledig scherm aanmelden (terugval)** — Opent Discord op volledig scherm om in te loggen met e-mail/wachtwoord of een CAPTCHA op te lossen wanneer QR niet mogelijk is.
- **Spraakchat** — Word lid van spraakkanalen en hoor iedereen, met elk lid live weergegeven (sprekring, mute/doof-badges) en een volumeschuif per persoon (0–200 %).
- **Privéberichten (DM's & groeps-DM's)** — Blader door je gesprekken en start/neem deel aan spraakoproepen met vrienden rechtstreeks vanuit het snelmenu. Actieve oproepen worden gemarkeerd.
- **Spraakbrowser voor servers** — Zie in welke spraakkanalen mensen zitten (met avatars) voordat je deelneemt.
- **Mute / Doof / Verbinding verbreken** — Spraakbediening met één tik vanuit het QAM.
- **Go Live (scherm delen)** — Deel je hele scherm in een spraakkanaal.
- **Microfoon-relay** — Je microfoon wordt vastgelegd in de Steam-interface en doorgestuurd naar Discord, zodat anderen je horen ook al draait Discord in een verborgen achtergrondtab. In- en uitgang volgen automatisch je standaard audioapparaat (sluit een headset aan en het schakelt vanzelf).
- **Spelstatus** — Toont het spel dat je speelt als je Discord-status.
- **Meldingen in het spel** — DM- en ping-meldingen verschijnen als Steam-meldingen.
- **Push-to-talk** — Met een fysieke toets (standaard R5).
- **Schermafbeeldingen versturen** — Stuur een Steam-schermafbeelding naar elk Discord-kanaal.
- **[Vencord](https://vencord.dev/)** wordt automatisch geïnjecteerd en geeft toegang tot zijn plugin-ecosysteem.

---

## Hoe de audio werkt (het moeilijke deel)

Discord draait in een **verborgen** browserweergave binnen Steam. Twee dingen laten spraak werken:

1. **Anderen horen** — Chromium pauzeert audio in verborgen tabs (autoplay-beleid). Streamcord hervat Discords audio met een via CDP gesimuleerde gebruikersactie, zodat inkomende spraak echt op je standaarduitgang wordt afgespeeld.
2. **Gehoord worden** — De verborgen tab kan de microfoon niet vastleggen, dus de echte microfoon wordt vastgelegd in de Steam-UI-context en doorgestuurd naar Discord via een lokale WebRTC-verbinding.

In- en uitgang volgen automatisch je standaardapparaat.

---

## Installatie

> **Nog niet in de Decky Store.** Handmatige installatie via de ontwikkelaarsmodus.

1. Schakel de **ontwikkelaarsmodus** in via Decky → Algemene instellingen
2. Ga naar **Ontwikkelaar** in de Decky-instellingen
3. Installeer vanaf de URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Vereiste (scherm delen)
De server voor scherm delen gebruikt de systeem-Python + GStreamer. Installeer de Python-afhankelijkheden eenmalig:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Vanaf de broncode bouwen

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# kopieer dist/, main.py, defaults/, plugin.json, package.json naar ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Met dank aan

- Origineel project: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architectuur, BrowserView, GStreamer scherm delen
- [@aagaming](https://github.com/AAGaming00) — microfoonondersteuning via de SteamClient-tab (WebRTC-relay)
- [@Epictek](https://github.com/Epictek) — basis van het aanmelden met QR-code
- [@jessebofill](https://github.com/jessebofill) — code voor het patchen van het Steam-menu
