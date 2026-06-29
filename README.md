# Steamcord

**Discord in Steam Gaming Mode** — a [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for Steam Deck / Bazzite / SteamOS.

🌍 **Languages:** **English** · [Français](docs/README.fr.md) · [Deutsch](docs/README.de.md) · [Español](docs/README.es.md) · [Italiano](docs/README.it.md) · [Português](docs/README.pt.md) · [Nederlands](docs/README.nl.md) · [Polski](docs/README.pl.md) · [Русский](docs/README.ru.md)

> **Steamcord is an independent project.** It was originally inspired by
> [Deckcord](https://github.com/marios8543/Deckcord) (see Credits), but the codebase has been
> largely rewritten and now follows its own direction — it is not affiliated with or endorsed
> by that project.
>
> The plugin UI is fully translated into 9 languages and follows your SteamOS language automatically.

---

## How it works

Steamcord runs **[Vesktop](https://github.com/Vencord/Vesktop)** — a real, native Discord client — invisibly in the background, and drives it over the Chrome DevTools Protocol. The plugin injects a small client into it and exposes everything in the Steam **Quick Access Menu**.

Going native fixes the hard problems of the old hidden-browser approach: **your microphone and the voice audio work natively**, exactly as in the desktop Discord app — no capture hacks, no autoplay workarounds. Vesktop is launched (and installed if missing) automatically, stays logged in across reboots, and never needs a desktop window in Gaming Mode.

---

## Features

- **QR code login** — Scan a QR code with the Discord mobile app to log in instantly. On your phone: *Discord → Settings → Scan QR Code*, then aim at the code shown in the panel. No password typing on the Deck.
- **Fullscreen login (fallback)** — Opens Discord full-screen to log in with email/password or solve a CAPTCHA when QR isn't possible.
- **Unified navigation** — Top tabs **Voice / Text / ⚙️ Settings**, with a shared **Servers / DMs** switch underneath, so the same source toggle works for both voice and text.
- **Voice chat** — Join voice channels and hear everyone, with each member shown live (speaking ring, mute/deafen badges), a per-user volume slider (0–200%) **and a per-user local mute** (silence someone just for you, without them knowing). Mic and audio are native (Vesktop).
- **Private messages (DMs & Group DMs)** — Browse your conversations and start/join voice calls with friends directly from the Quick Access Menu. Active calls are highlighted.
- **Server voice browser** — See which voice channels have people in them (with member avatars) before joining.
- **Text chat — servers *and* DMs** — Read and reply to a server channel **or a private conversation** from the QAM (full-width input, Steam keyboard opens automatically). **Image attachments show as thumbnails** (loaded only while the channel is open) and **links open in the Steam Gaming Mode browser**. Auto-scrolls to the latest message.
- **Discord status on your name** — Your **clickable username** at the top shows your current status; tap it to change it. Optional auto-sync makes Discord **follow your Steam status** in the background; picking one by hand switches back to manual.
- **Audio device selection** — From Settings, choose the **output (Discord sound)** and **input (microphone)** device — *Auto (system default)* or a specific device, e.g. send Discord audio to your **headset only** while games stay on HDMI.
- **Mute / Deafen / Disconnect** — One-tap voice controls from the QAM.
- **Screen share** — Share your whole screen to a voice channel (Go Live). Works natively in Desktop / Big Picture. **In Gaming Mode (gamescope) this is _beta_:** gamescope ships no screen-capture portal (so the normal Go Live is a black screen), so a separate **"Share screen (game mode)"** button captures the game through a virtual camera (v4l2loopback) fed straight from gamescope's PipeWire output — the only capture path that works there. Needs a one-time v4l2loopback setup.
- **In-game notifications** — Incoming DM calls and pings appear as **native Steam notifications (popup + sound)**, respecting your Discord status (silenced when invisible / do-not-disturb).
- **Push-to-talk** — With a physical keybind (R5 by default).
- **Share screenshots** — Send a Steam screenshot straight into the conversation you have open.
- **[Vencord](https://vencord.dev/)** is built into Vesktop, giving access to its plugin ecosystem.

---

## Installation

> **Not yet on the Decky Store.** Install manually via Developer Mode.

1. Enable **Developer Mode** in Decky → General settings
2. Go to **Developer** in Decky settings
3. Install from URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop is installed and launched automatically by the plugin the first time it runs. Just log in once (QR or fullscreen) and you stay logged in.

### Screen share
Screen sharing works out of the box — the plugin auto-installs its Python dependency (aiohttp) for the system Python on first run. GStreamer is provided by the system.

---

## Build from source

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copy dist/, main.py, defaults/, plugin.json, package.json to ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Credits

- Original project: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architecture, BrowserView setup, GStreamer screen share
- [@aagaming](https://github.com/AAGaming00) — mic support via the SteamClient tab (WebRTC relay)
- [@Epictek](https://github.com/Epictek) — QR Code login foundation
- [@jessebofill](https://github.com/jessebofill) — Steam menu patching code
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — the native Discord client Steamcord drives
