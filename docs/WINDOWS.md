# Steamcord on Windows (Steam Big Picture)

The same `Steamcord` zip runs in two places:

| Host | Loader | Where you use it |
|---|---|---|
| Steam Deck, Bazzite, SteamOS and other Linux | [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) | Gaming Mode → Quick Access Menu |
| Windows 10 / 11 (handhelds and desktops) | [Decky Loader for Windows](https://github.com/musika08/decky-loader-windows) (3.3 or newer) | Steam **Big Picture** → Quick Access Menu |

There is one release and one zip. The plugin notices which host it is on when it
starts; nothing needs to be chosen or configured.

> **Status: new and experimental.** The Windows side is the first release of
> this port. It has automated tests (including a Windows CI job), but it has not
> been run on a real Windows handheld by its author. Please report what you find.

## Requirements

- Windows 10 or 11 with **Steam in Big Picture mode**
- **Decky Loader for Windows** 3.3 or newer. It enables Steam's remote debugging
  (`.cef-enable-remote-debugging` in the Steam folder; restart Steam once) and
  adds the Decky tab to the Quick Access Menu
- Internet access the first time, so Steamcord can install **Vesktop**
- Optional: `ffmpeg` on `PATH` if you want to send Steam clips to Discord

## Install

1. In Big Picture open the Quick Access Menu → **Decky** tab → ⚙ settings.
2. Turn on **Developer Mode** (General tab).
3. In the **Developer** tab choose **Install Plugin from URL** and use
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`
   - or download the zip and pick **Install Plugin from ZIP File**.
4. Confirm the *third-party plugin* warning (the plugin is not on the Decky Store).
5. Open Steamcord from the Decky tab. The first start installs Vesktop (about a
   minute), then shows the **QR code**: scan it with the Discord mobile app
   (*Settings → Scan QR Code*).

The Steam Deck steps are unchanged - see the main [README](../README.md#installation).

## How it works on Windows

The core is the same as on Linux: Steamcord runs a real **Vesktop** (Discord +
Vencord) in the background, drives it over the Chrome DevTools Protocol, and shows
everything in the Quick Access Menu. Your microphone and the voice audio are
Vesktop's own, so they behave exactly like the desktop Discord app. What changes is
how Vesktop is found, started and stopped:

- **Installing.** If Vesktop is missing, Steamcord installs it for the current user
  with `winget install Vencord.Vesktop`, falling back to the official installer from
  Vesktop's GitHub releases (run silently, no administrator prompt).
- **Starting.** Vesktop is started minimised, with its debugging port on
  `127.0.0.1:9223` and **its own profile folder**. A Vesktop you use yourself on the
  desktop is never touched: not closed, not logged out, not re-pointed.
- **One Discord per Steam account.** Each Steam account gets its own Vesktop profile,
  exactly as on the Deck. Switching Steam accounts switches Discord within seconds.
  Profiles live in Decky's settings folder for Steamcord (`…\vesktop-profiles\<account>`).
- **Stopping.** Steamcord only ever stops the Vesktop *it* started (found through the
  debugging port), together with its child processes.
- **Local server.** The plugin's helper server listens on `127.0.0.1` only on Windows,
  so Windows Firewall does not ask for permission.

## What is included

This table shows what the Windows build is designed to do. **None of it has been confirmed on a real Windows handheld yet**, so treat every tick as "expected" until you have tried it.

| Feature | Windows | Steam Deck |
|---|:-:|:-:|
| Voice chat, mute / deafen, per-user volume and local mute | ✅ | ✅ |
| Servers, DMs, group DMs, friends, text chat, attachments | ✅ | ✅ |
| QR login and CAPTCHA solver | ✅ | ✅ |
| Notifications as Steam toasts | ✅ | ✅ |
| Soundboard | ✅ | ✅ |
| Discord status sync / Rich Presence (running games) | ✅ | ✅ |
| One Discord profile per Steam account | ✅ | ✅ |
| Go Live (screen share) | ✅ primary display, video only | ✅ with game audio |
| Send Steam screenshots and clips | ✅ (clips need `ffmpeg`) | ✅ |
| Game audio in the call, game ↔ Discord mix | No | ✅ |
| Choosing audio output / input inside the plugin | No (uses the Windows default devices) | ✅ |
| Virtual camera "Share screen (game mode)" | No | ✅ |
| In-game voice / POV overlays | No | ✅ |
| Controller push-to-talk and mute shortcut | No | ✅ |
| Keep the screen awake while watching a stream | No | ✅ |

Controls that cannot work on the current host are hidden automatically.

## Troubleshooting

**Stuck on "Initializing…"**
- Just updated? Restart Steam so the plugin's backend starts fresh with the new files.
- Check that Decky for Windows is running and Steam was restarted once after it was
  installed (Steam's debugger answers on `http://localhost:8080`).
- Look at the Steamcord log in Decky's log folder (`%USERPROFILE%\homebrew\logs\Steamcord`
  in portable mode). Lines tagged `[win]`, `[win-install]` and `[launchdiag]` say what
  happened to Vesktop.

**"Steamcord could not install Vesktop automatically"**
Install it yourself from <https://vesktop.dev> or run `winget install Vencord.Vesktop`,
then reopen the panel. If it is installed somewhere unusual, tell Steamcord where:
set the environment variable `STEAMCORD_VESKTOP_EXE` to the full path of `Vesktop.exe`,
or put that path on one line in a file named `steamcord-vesktop-path.txt` in Steamcord's
Decky settings folder.

**Go Live shows the wrong monitor.** Steamcord shares the first display Windows reports,
normally the primary one. Set the display you want as the primary display in Windows
display settings.

**No sound in Go Live.** Sharing game audio needs PipeWire virtual devices, which Windows
does not have; the stream is video only for now.

**Updating.** Decky for Windows
keeps installed plugins in a folder a plugin cannot write to, so the update button may
report *Permission denied*; install the new zip with **Install Plugin from ZIP File**
instead. A release that adds files at the top level always needs a normal install.

## For developers

- Host detection is `sys.platform` (see `defaults/sc_platform.py`). Do **not** use
  `os.getuid()`: Decky for Windows emulates it.
- Windows-only code is `defaults/vesktop_windows.py`; `defaults/vesktop.py` hands over to
  it at the top of each entry point and keeps the Linux code untouched.
- `Plugin.get_platform_caps` publishes the feature flags; `src/platform.ts` mirrors them
  and a test keeps the two lists identical.
- Linux-only callables are replaced on Windows by harmless stubs (`_WIN_UNSUPPORTED` at
  the end of `main.py`), so a stale panel can never shell out to `pactl` or `pw-dump`.
- `tests/test_windows_support.py` runs everywhere; its `RealWindowsTest` cases run on the
  Windows CI job. `tests/check_release_zip.py` checks that the built zip carries both the
  Steam Deck files and the Windows layer.
