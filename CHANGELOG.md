# Changelog

Older releases (v1.0.0 → v1.11.0) are documented on the
[GitHub Releases](https://github.com/Necrosiak/Steamcord/releases) page.

## 1.14.0 — 2026-07-16

### Added
- **Notifications now show the Discord sender, not your own Steam profile**:
  the sender's Discord name and real avatar appear on every message and
  incoming-call notification (a per-sender local persona is primed in the
  Steam friends store; senders without a custom avatar get the Discord logo).
  DMs and incoming calls render as private messages (FriendChatMessage),
  server channels render as group messages labeled `Sender (#channel, Server)`.
  Your Discord notification settings (server/channel mutes, mentions-only…)
  are respected — Steamcord only relays what Discord itself would notify.

### Fixed
- **Message notifications were broken entirely** — four stacked bugs:
  a plain text message (no embed) crashed the handler with `IndexError`
  (and handler exceptions went to an invisible `print()`); an apostrophe in
  any message broke the JS dispatch eval (`JSON.parse('…')`); the dispatcher
  task **died permanently** on the first `Cannot write to closing transport`
  after a Steam restart (now retries with a fresh CDP tab and never dies);
  and the plugin imported the **stale release-zip copies** of
  `discord_client`/`tab_utils`/`steamcord_client.js` instead of the current
  `defaults/` ones (defaults-first resolution now).
- **Screen-share requirement hints are now translated (9 languages)** instead
  of hardcoded French: when v4l2loopback or the GStreamer/PipeWire Python
  bindings are missing, the backend returns a structured code plus the exact
  install command for your distro, and the QAM shows the explanation in your
  language with the command verbatim
  ([#2](https://github.com/Necrosiak/Steamcord/issues/2)).
- **SteamOS gets an honest message**: stock SteamOS does not ship the
  v4l2loopback kernel module and OS updates wipe manual installs, so instead
  of a `sudo pacman -S` command that cannot work there, Steamcord now says
  screen share (game mode) is unavailable on SteamOS.

### Added
- **"Native Decky notifications" toggle** (Settings → 🔔 Notifications,
  default OFF). Steamcord reroutes every Decky toast through a chat-style
  Steam notification because some Steam builds crash while rendering native
  Decky toasts (`TypeError: … reading 'notification_type'` — reproduced and
  root-caused on current steamui: toast eType 31 is dispatched to
  Steam-notification renderers that expect protobuf fields Decky toasts don't
  have). If your Steam build renders them fine, flip the toggle ON to get the
  native look back for all plugins
  ([#2](https://github.com/Necrosiak/Steamcord/issues/2)). Turning it OFF
  also sweeps crash-prone entries out of the notification tray.

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
