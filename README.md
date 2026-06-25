# Streamcord

**Discord in Steam Gaming Mode** — a [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for Steam Deck / Bazzite / SteamOS.

🌍 **Languages:** **English** · [Français](docs/README.fr.md) · [Deutsch](docs/README.de.md) · [Español](docs/README.es.md) · [Italiano](docs/README.it.md) · [Português](docs/README.pt.md) · [Nederlands](docs/README.nl.md) · [Polski](docs/README.pl.md) · [Русский](docs/README.ru.md)

> **Streamcord is an independent project.** It was originally inspired by
> [Deckcord](https://github.com/marios8543/Deckcord) (see Credits), but the codebase has been
> largely rewritten and now follows its own direction — it is not affiliated with or endorsed
> by that project.
>
> The plugin UI is fully translated into 9 languages and follows your SteamOS language automatically.

---

## Features (and how they work)

- **QR code login** — Scan a QR code with the Discord mobile app to log in instantly. On your phone: *Discord → Settings → Scan QR Code*, then aim at the code shown in the panel. No password typing on the Deck.
- **Fullscreen login (fallback)** — Opens Discord full-screen to log in with email/password or solve a CAPTCHA when QR isn't possible.
- **Voice chat** — Join voice channels and hear everyone, with each member shown live (speaking ring, mute/deafen badges) and a per-user volume slider (0–200%).
- **Private messages (DMs & Group DMs)** — Browse your conversations and start/join voice calls with friends directly from the Quick Access Menu. Active calls are highlighted.
- **Server voice browser** — See which voice channels have people in them (with member avatars) before joining.
- **Mute / Deafen / Disconnect** — One-tap voice controls from the QAM.
- **Go Live (screen share)** — Share your whole screen to a voice channel.
- **Mic relay** — Your microphone is captured in the Steam UI and relayed into Discord, so others hear you even though Discord runs in a hidden background tab. Input and output automatically follow your default audio device (plug in a headset and it just switches).
- **Game status** — Shows the game you're playing as your Discord status.
- **In-game notifications** — DM and ping notifications appear as Steam toasts.
- **Push-to-talk** — With a physical keybind (R5 by default).
- **Post screenshots** — Send a Steam screenshot to any Discord channel.
- **[Vencord](https://vencord.dev/)** is auto-injected, giving access to its plugin ecosystem.

---

## How the audio works (the hard part)

Discord runs in a **hidden** browser view inside Steam. Two things make voice work:

1. **Hearing others** — Chromium suspends audio in hidden tabs (autoplay policy). Streamcord resumes Discord's audio with a CDP-simulated user gesture, so incoming voice actually plays to your default output.
2. **Being heard** — The hidden tab can't capture the mic, so the real microphone is captured in the Steam UI context and relayed to Discord over a local WebRTC connection.

Both input and output follow your system default device automatically.

---

## Installation

> **Not yet on the Decky Store.** Install manually via Developer Mode.

1. Enable **Developer Mode** in Decky → General settings
2. Go to **Developer** in Decky settings
3. Install from URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Requirement (screen share)
The screen-share server uses the system Python + GStreamer. Install the Python deps once:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Build from source

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# copy dist/, main.py, defaults/, plugin.json, package.json to ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Credits

- Original project: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architecture, BrowserView setup, GStreamer screen share
- [@aagaming](https://github.com/AAGaming00) — mic support via the SteamClient tab (WebRTC relay)
- [@Epictek](https://github.com/Epictek) — QR Code login foundation
- [@jessebofill](https://github.com/jessebofill) — Steam menu patching code
