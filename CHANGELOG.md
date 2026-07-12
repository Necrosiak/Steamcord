# Changelog

Older releases (v1.0.0 → v1.11.0) are documented on the
[GitHub Releases](https://github.com/Necrosiak/Steamcord/releases) page.

## 1.13.0 — 2026-07-12

### Added
- **🕹️ Controller voice shortcut** — capture **any button combo on your
  controller** and bind it to **mute toggle** or **push-to-talk**, from the
  new "Controller shortcut" section of the Settings tab. The listener is
  global: it works in-game with the QAM closed, and survives panel close.
  PTT mode switches Discord to push-to-talk automatically. Persisted per
  machine in `~/.config/steamcord-input.json`. Strings in 9 languages.

### Removed
- The old hardcoded **R5 push-to-talk button** in the Voice tab — replaced by
  the configurable shortcut above.

## 1.12.3 — 2026-07-10

### Fixed
- **No more raw Python exception in the QAM when the backend starts while
  Steam itself is still (re)starting** (mode switch, boot). The one-shot
  SharedJSContext lookup could fail — CEF answers before the tab exists — and
  killed the main loop; it now retries every 3 seconds until the Steam UI is
  up.

### Docs
- Screenshot gallery in all 9 READMEs (servers, DMs, voice call, screen
  share).

## 1.12.2 — 2026-07-10

### Fixed
- **Debian/Ubuntu compatibility:** the screen-capture camera, the
  screen-share server and its dependency bootstrap all ran the hardcoded
  `/usr/bin/python`, which does not exist on Debian/Ubuntu. The system python
  is now resolved from `PATH`.
- **No more infinite "Initializing…" when the Vesktop install cannot
  succeed.** When flatpak is present but installing Vesktop keeps failing
  (offline, Flathub unreachable, full disk), the QAM now switches to the help
  screen after 3 failed attempts, and self-heals when an install succeeds.

### Added
- **GStreamer/PipeWire pre-check** before starting the virtual camera, with
  the exact package command for your OS (stock Arch/Fedora/Debian miss the
  bindings by default).
- openSUSE (`zypper`) is now covered by the OS-specific install hints.

## 1.12.1 — 2026-07-09

### Fixed
- **Update failures are now visible.** When installing an update fails (e.g.
  root-owned local install), the panel shows the exact error under the update
  button instead of staying on "installing…" forever. Ships the new
  `update_failed` string in 9 languages.

## 1.12.0 — 2026-07-09

Stand-alone across every Linux distro 🐧 — one build that checks what the
machine has; Steamcord no longer assumes a Bazzite-like system.

### Changed
- **Vesktop backend cascade:** existing flatpak → native `vesktop` from PATH
  → silently installable flatpak, with a clear per-OS message (9 languages)
  when none is possible, and self-healing once one becomes available.
- **Multi-session profiles work identically on the native backend.**

### Added
- **Screen share dependency check:** when `/dev/video42` is missing, the
  "game mode" share button shows exactly how to install/load v4l2loopback
  for your package manager, distinguishing "not installed" from "not loaded".
