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

- **One Discord per Steam account (multi-session)** — Every Steam user on the machine gets their **own Discord profile**: switch the Steam account and Steamcord switches Discord automatically within seconds (the first time shows the QR login; after that each session is remembered). Nobody lands in someone else's Discord.
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
- **Screen share** — Share your whole screen to a voice channel (Go Live). Works natively in Desktop / Big Picture, **and now natively in Gaming Mode too**: gamescope ships no screen-capture portal (which is why the normal Go Live used to be a black screen there), so the plugin runs its own tiny ScreenCast portal (`portal_shim.py`) that hands Chromium the gamescope PipeWire node — the same node Steam's built-in Game Recording uses. Real Go Live, full resolution, game audio via venmic, no kernel module, nothing written to the rootfs (survives SteamOS A/B updates). The legacy paths remain as fallbacks: the local GStreamer WebRTC relay (automatic when no portal answers) and the **"Share screen (game mode)"** virtual-camera button (v4l2loopback, needs one-time setup).
- **Share game audio** — Stream your game's sound into the voice channel **along with your voice**. Two mix sliders (🎙️ voice / 🎮 game) control what the others hear, while you keep hearing the game normally — and it works even **without a physical microphone** (the plugin creates a virtual *Steamcord Mic* input).
- **In-game notifications** — Incoming DM calls and pings appear as **native Steam notifications (popup + sound)**, respecting your Discord status (silenced when invisible / do-not-disturb).
- **🕹️ Controller voice shortcut** — Capture **any button combo on your controller** and bind it to **mute toggle** or **push-to-talk**. It works globally in-game, even with the QAM closed (set it up in the Settings tab).
- **Share screenshots** — Send a Steam screenshot straight into the conversation you have open.
- **[Vencord](https://vencord.dev/)** is built into Vesktop, giving access to its plugin ecosystem.
- 🐧 **Compatibility** — we actively work to support every OS that can run Steam in Gaming Mode / Big Picture (Linux for now): portable detection, vendored Python deps, no distro-specific assumptions. Per-distro package notes: [docs/OS-NOTES.md](docs/OS-NOTES.md).

---

## 📸 Screenshots

<p align="center">
  <img src="docs/img/steamcord-servers.jpg" width="49%" alt="Discord servers"/>
  <img src="docs/img/steamcord-dm-chat.jpg" width="49%" alt="Direct messages"/>
</p>
<p align="center">
  <img src="docs/img/steamcord-voice-call.jpg" width="49%" alt="Voice call"/>
  <img src="docs/img/steamcord-voice-live.jpg" width="49%" alt="Screen share live"/>
</p>

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

## 🐛 Issues & ideas — don't hesitate!

Found a bug, something misbehaving on your distro, or missing a feature?
**Please open an [issue](https://github.com/Necrosiak/Steamcord/issues)** —
every report directly shapes what gets built next. Include if you can:

- your distro & version (Bazzite 42, CachyOS, Ubuntu 24.04…) and how Steam runs (Gaming Mode / Big Picture / desktop)
- the plugin version (Settings → Update) and whether Vesktop is flatpak or native
- what you did, what you expected, what happened instead
- logs: `~/homebrew/logs/Steamcord/` and `journalctl -b | grep -i steamcord`

Feature requests and "it works!" reports on unusual setups are just as valuable.

## Credits

- Original project: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architecture, BrowserView setup, GStreamer screen share
- [@aagaming](https://github.com/AAGaming00) — mic support via the SteamClient tab (WebRTC relay)
- [@Epictek](https://github.com/Epictek) — QR Code login foundation
- [@jessebofill](https://github.com/jessebofill) — Steam menu patching code
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — the native Discord client Steamcord drives

### Code contributors

- [@azizzidi](https://github.com/azizzidi) — **native Go Live in Gaming Mode** via the gamescope ScreenCast portal shim ([#10](https://github.com/Necrosiak/Steamcord/pull/10), landed in v1.15.0)

### Community bug hunters

People who reported, diagnosed or helped fix bugs — thank you!

- [@theconker64](https://github.com/theconker64) — report & diagnosis of the `segno` boot crash on stock SteamOS ([#1](https://github.com/Necrosiak/Steamcord/issues/1), fixed in v1.8.2)
- [@V3lvetStorm](https://github.com/V3lvetStorm) — confirmation & testing ([#1](https://github.com/Necrosiak/Steamcord/issues/1))
- [@DavidNotProgamer](https://github.com/DavidNotProgamer) — report of the untranslated screen-share hint and the chat-style look of Decky notifications ([#2](https://github.com/Necrosiak/Steamcord/issues/2), addressed in v1.14.0), diagnosis of the screen wake-lock with volume-mixer evidence ([#3](https://github.com/Necrosiak/Steamcord/issues/3)) report of the green incoming video, the vanishing Watch button and the volume-slider reset ([#5](https://github.com/Necrosiak/Steamcord/issues/5), addressed in v1.14.2), report of incoming streams missing in group and server voice channels and the mirrored second stream ([#8](https://github.com/Necrosiak/Steamcord/issues/8), addressed in v1.14.4 and v1.14.5), and the shutdown-hang bisect ([#7](https://github.com/Necrosiak/Steamcord/issues/7), fixed in v1.14.5), and the detailed repro of the rapid Go Live toggle breakage and the stuck stream preview on stock SteamOS ([#12](https://github.com/Necrosiak/Steamcord/issues/12), fixed in v1.16.0), and the reports of the phantom volume changes, the mic/keybind/audio settings bugs ([#13](https://github.com/Necrosiak/Steamcord/issues/13), [#14](https://github.com/Necrosiak/Steamcord/issues/14), fixed in v1.16.1)
- [@TheRealScrumby](https://github.com/TheRealScrumby) — report of the dead fullscreen-login button ([#6](https://github.com/Necrosiak/Steamcord/issues/6), fixed in v1.14.3)
- [@StarlightAzu](https://github.com/StarlightAzu) — report of the v4l2loopback hint whose command silently did nothing ([#9](https://github.com/Necrosiak/Steamcord/issues/9), fixed in v1.14.6)
- [@humzakh](https://github.com/humzakh) — report of the in-plugin updater failing on root-owned installs, including the chmod/chown attempts that pinpointed the cause ([#16](https://github.com/Necrosiak/Steamcord/issues/16), fixed in v1.16.1), and report of the broken message-list navigation and missing conversation history ([#17](https://github.com/Necrosiak/Steamcord/issues/17), fixed in v1.16.2)
- [@hrhnick](https://github.com/hrhnick) — suggestion to switch the UI to monochrome SVG icons so the plugin blends in with SteamOS ([#15](https://github.com/Necrosiak/Steamcord/issues/15), done in v1.16.1)
- [@jafuuu](https://github.com/jafuuu) — spotted that the game Rich Presence was missing entirely ([#11](https://github.com/Necrosiak/Steamcord/issues/11), added in v1.16.0)
