# Steamcord on Windows

Steamcord also runs on Windows, in Steam Big Picture. It works with both
Windows versions of Decky: the official Decky Loader build that
[Playhub](https://github.com/LoZazaMastro/Playhub) installs, and musika08's
[Decky Loader for Windows](https://github.com/musika08/decky-loader-windows). The same plugin works on Linux and Windows.

## Installing

1. Install Decky on Windows, with either
   [Playhub](https://github.com/LoZazaMastro/Playhub) or musika08's
   [Decky Loader for Windows](https://github.com/musika08/decky-loader-windows) (only one of them at a time:
   both use the same port).
2. Install Steamcord from Playhub's catalog, or from Decky's developer settings
   with *Install plugin from URL*:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`
3. Open Steamcord from the Quick Access Menu. On first start it downloads its
   own copy of Vesktop (about 150 MB), then shows the QR code to sign in.

Start Decky from your Windows desktop session (both installers do this). Started
from a remote shell, Windows denies Discord access to the microphone.

## Your own Discord stays untouched

Steamcord uses a private, portable Vesktop downloaded from the official
Vencord release and checked against a pinned SHA-256. Nothing is installed
into Windows, no administrator prompt is needed, and it is not added to
Windows startup. A Discord or Vesktop you already use is never stopped,
reused or imported.

Each Steam account gets its own Discord login, as on Linux.

## What works

- Voice chat: microphone, hearing others, mute and deafen
- Private messages, notifications and game activity (Rich Presence)
- Go Live with your screen and its sound, without echoing the call
- Watching other people's streams, with a preview of your own stream in the
  Quick Access Menu and the expanded view

## Linux-only features

These depend on Linux system components and are hidden on Windows: audio
device pickers and the game/voice balance (Windows' own sound settings
apply), sharing game audio as a separate source, the virtual camera, the
in-game voice and POV overlays, keeping the screen awake, and the
controller push-to-talk/mute shortcut.

## Reporting a problem

Logs are in `%USERPROFILE%\homebrew\logs\Steamcord`. Please include your
Windows version, which Decky you use (Playhub or Decky Loader for Windows) and its version, and the step that fails.
Never post tokens, passwords or QR codes, and check logs for personal
information before attaching them.

The Windows port was made possible by
[@SilvertongueRED](https://github.com/SilvertongueRED)'s
[fork](https://github.com/SilvertongueRED/Steamcord-for-Windows), which showed
the way.
