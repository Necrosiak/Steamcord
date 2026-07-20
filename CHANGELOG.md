# Changelog

Older releases (v1.0.0 → v1.11.0) are documented on the
[GitHub Releases](https://github.com/Necrosiak/Steamcord/releases) page.

## 1.16.1 — 2026-07-20

### Changed
- **Monochrome SVG icons across the whole QAM UI** (#15). All color emoji
  icons (tabs, config sections, sliders, buttons, status picker) were replaced
  with monochrome vector icons that inherit the surrounding text size and
  color, so the plugin now blends in with the rest of the SteamOS UI. Discord
  statuses are shown as tinted dots (filled / moon / slashed / hollow) instead
  of emoji.
- **Faster Go Live self-preview** (#12). The stock-SteamOS screenshot fallback
  now produces roughly one frame per second (instead of one every ~3 s): the
  loop waits for the screenshot file to actually finish being written instead
  of sleeping a fixed margin, and the QAM polls the thumbnail every second.

### Fixed
- **In-plugin updates failed on root-owned installs** (#16). The plugin
  backend runs as the regular user, and the updater overwrote files with
  `shutil.copy2`, which ends with a `chmod` on the destination — an operation
  a non-root user cannot perform on root-owned files even when they are
  world-writable. Files are now replaced via a temp file + atomic
  `os.replace`, which only needs write permission on the directory; as a
  bonus every replaced file becomes owned by the user, so a root-owned
  install heals itself as it updates. If a directory is still not writable,
  the error message now tells you the exact `chown -R` command to run.
- **Controller shortcut capture never registered any button** (#14). Newer
  Steam client builds changed the `RegisterForControllerInputMessages`
  callback from an array of event objects to positional arguments, so the
  capture (and the shortcut itself) silently saw nothing. The listener now
  handles both signatures — and button ids are unchanged between builds, so
  existing bindings keep working. Button names are also nicer now (A/B/X/Y,
  D-pad, L4/L5/R4/R5, … instead of `BTN<n>`).
- **Pressing the capture button instantly saved "A" as the shortcut** (#14).
  The controller events of the very press that clicked "Set binding" leaked
  into the capture, validating a one-button "A" chord before you could touch
  anything. The capture now ignores the activating press (short grace period
  + already-held buttons) and only validates once you release your actual
  chord — you can still bind A itself by pressing it again after the grace.
- **Mic processing settings (noise suppression, echo cancellation, automatic
  gain control) reverted to defaults** (#14). The plugin now persists your
  choices itself and re-asserts them every time the Discord client logs in,
  so they survive plugin and console restarts even when Discord's own
  persistence fails. The setters also verify the value actually applied and
  report an error instead of silently doing nothing, and the QAM shows the
  real applied value rather than an optimistic one. If the volume of other
  apps was "dancing" during your calls (#13), it was most likely WebRTC's
  automatic gain control staying enabled no matter what you selected — turn
  AGC off and it should stop now that the toggle actually sticks.
- **Audio output/input "Auto" kept the last manual choice** (#14). Switching
  back to Auto now actively moves the Discord streams back to the system
  default device instead of leaving them wherever they were last routed.

## 1.16.0 — 2026-07-19

### Added
- **Discord Rich Presence for the running game** (#11). The QAM already told
  the backend which game was running, but the client handler for it had been
  lost in an earlier rewrite, so nothing ever reached Discord. It is now
  dispatched as a proper local activity, with the game name matched (case-
  insensitively) against Discord's detectable-applications list so most games
  get their real artwork and "Playing …" card; the activity is also replayed
  automatically when the Discord client reconnects, and the elapsed timer
  survives those reconnections. A new toggle in Config → Status ("Show current
  game on Discord", on by default) lets you turn the feature off; switching it
  off clears the activity immediately. While the option is on, the QAM also
  shows a small "Playing …" line (game artwork + name) under your username.

### Fixed
- **Rapid stream toggling could break streaming — and the whole console's
  audio** (#12). Closing and reopening Go Live within a second or two made
  overlapping acquisitions race each other: the Go Live button died, and the
  storm of stream setup/teardown could push PipeWire itself into a state
  where it stops accepting new clients — which on SteamOS shows up as dead
  Steam/QAM buttons, no sound, and games refusing to launch. Fixes: the Go
  Live button now has a short cooldown; a new start waits for the previous
  stream's teardown before acquiring; a watchdog recovers the button if an
  acquisition hangs; the backend serializes start/stop so audio routing can't
  race; and every PipeWire query (`pw-dump`, `pactl`) now has a timeout, so a
  wedged PipeWire degrades into a clear error (plus a toast telling you to
  restart the console) instead of freezing streaming forever.
- **Self-preview stuck on "Starting Preview…" on stock SteamOS** (#12). Stock
  SteamOS ships GStreamer without `gst-plugin-pipewire`, so the preview
  pipeline silently died. The preview now falls back to a
  `gamescopectl screenshot` + `ffmpeg` loop (both are stock on SteamOS), and
  if no method works the tile now says so instead of spinning forever.
- The LIVE badge and preview tile no longer flicker away during a
  not-so-fast stream reopen (a debounced synthetic STOP from the previous
  stream raced the new one).

## 1.15.1 — 2026-07-19

### Added
- **Live preview for native Go Live.** While streaming through the portal, the
  voice view now shows a small self-preview tile (a snapshot refreshed every
  ~2 s, captured from the same gamescope PipeWire node Chromium streams), so
  you can see what your viewers see — same idea as the existing virtual-camera
  preview.
- **Update notification even with auto-update off.** If a newer release
  exists and auto-update is disabled, a toast now tells you it's available
  (install from the Quick Access Menu); before, you were never notified.

### Changed
- The game-mode share button is now labeled "Share screen (virtual camera)"
  instead of "(game mode)" — since v1.15.0 native Go Live is the primary path
  in Gaming Mode and this button is the fallback. The label is also translated
  in all 9 languages now (it used to fall back to English outside EN/FR).

### Fixed
- **Stream volume on your own row did nothing and reset to 18 %.** Discord's
  engine ignores the per-user stream volume for your own id (you never hear
  your own stream), so the slider silently failed and fell back to the
  engine's stream default (amplitude 18) on every QAM reopen. Your row now
  shows a real **broadcast volume** slider instead: it scales the venmic
  capture source (PipeWire), i.e. what your viewers actually hear.
- **Volume sliders now use Discord's perceptual scale.** The engine stores
  amplitudes while the Discord UI shows perceptual percentages; the QAM
  sliders now convert both ways (same curve as Discord), so percentages match
  the Discord app — another stream's default now reads ~54 % instead of a
  mysterious "18 %".
- **Plugin stuck on "Initializing…" after a fast Vesktop restart.** The
  watchdog only probed Vesktop's CDP endpoint; a quick `systemctl restart`
  brings the new endpoint up before the next probe, so the dead tab was never
  detected and the client never re-injected. The watchdog now probes the
  actual tab (trivial evaluate with a timeout) and recovers within seconds.
- The initializing screen no longer draws the title across the Steam spinner
  (the spinner renders ~110pt regardless of its container and overflowed its
  48px box); the spinner is now properly contained with the title below it.
- **Voice channel no longer duplicates system audio during Go Live on
  mic-less machines.** Without a real microphone the default source is the
  output monitor, so the voice channel silently broadcast everything the
  machine played (game audio, UI sounds, an echo of other participants) on
  top of the stream's own soundshare — and the stream volume slider had no
  effect on it. While streaming without a real microphone, the voice capture
  is now pointed at a silent sink and restored afterwards; a real microphone
  is left untouched.
- A Go Live stop arriving while the screen acquisition was still in flight
  could leave Vesktop's (invisible) share dialog unanswered, wedging every
  later `getDisplayMedia` in Electron's main process until Vesktop restarted.
  The stop now lets the acquisition finish and releases the source; a second
  Go Live during acquisition is ignored.
- **Go Live black screen after the July 2026 Discord update.** Discord's new
  bundle (hot-loaded by Vesktop on restart) changed the Go Live startup
  contract: dispatching `STREAM_START` alone no longer captures anything — the
  stream goes ACTIVE with no video track attached, so viewers see black. The
  QAM Go Live now reproduces Discord's own browser flow: acquire the screen
  through the media engine's desktop-source pool (which routes through our
  ScreenCast portal in Gaming Mode) and pass the source id to `STREAM_START`.
- The self-camera "rescue" path no longer looks up a Discord internal
  (`toggleSelfVideo`) that no longer exists; it retries the real media action
  instead, and the diagnostic verdict now reads the actual engine state.
- **Server, DM and text-chat lists now fill the panel down to the bottom.**
  They were capped at a hardcoded height sized for 800p, leaving a large
  empty gap below on higher resolutions; they now size themselves to the
  panel at any resolution.
- A failed automatic update no longer toasts "update installed" and restarts
  the plugin loader for nothing — it now reports the actual error.
- **The Go Live button now shows up in Gaming Mode.** v1.15.0 shipped native
  Go Live for gamescope, but the Quick Access Menu still hid the button there
  — a leftover gate from when Go Live could only work under KWin. The button
  is now always available while in voice; the virtual-camera ("game mode
  share") button remains as the gamescope fallback. Reported by
  @DavidNotProgamer right after the v1.15.0 release (#8).
- On stock SteamOS, the screen-share error toast now points to Go Live
  (which needs no kernel module) instead of dead-ending on v4l2loopback
  being unavailable. (all 9 languages)

## 1.15.0 — 2026-07-18

### Added
- **Native Go Live in Gaming Mode — no more virtual camera.** gamescope has
  no screen-cast portal, which is why Go Live black-screened in game mode and
  the v4l2loopback camera workaround existed. The plugin now ships its own
  portal: `portal_shim.py` owns `org.freedesktop.portal.Desktop` on the user
  bus (only while a gamescope session exists — it steps aside in Desktop Mode)
  and answers Chromium's ScreenCast handshake with the gamescope PipeWire
  node, the same one Steam Game Recording captures. The regular Go Live
  button now streams the real screen at native resolution through Chromium's
  own capture path (no VP8 double-encode, no kernel module, no rootfs writes
  — safe across SteamOS A/B updates). Game audio is attached via venmic
  ("Entire System"), and Vesktop's invisible share-settings modal is
  auto-confirmed (1080p60 preset). `getDisplayMedia` now tries the native
  portal first and falls back to the local GStreamer WebRTC relay; the
  virtual-camera button remains as a manual last resort. Vesktop is launched
  with `XDG_SESSION_TYPE=wayland` under gamescope so Chromium picks the
  PipeWire capturer. A stale desktop-session `xdg-desktop-portal` holding the
  portal name in game mode is stopped (it re-activates on demand back in
  Desktop Mode). New vendored dep: `dbus_next` (pure Python, py_modules,
  MIT — license shipped alongside).
  Contributed by @azizzidi (#10) — thank you! Validated end-to-end on a
  BC-250 with the hardening below.

### Changed (hardening of the native Go Live, on top of #10)
- **The portal only serves Steamcord's own Vesktop.** A screen-cast portal
  that auto-approves without a consent dialog must not hand the screen to
  arbitrary processes: the shim now verifies the D-Bus caller (resolving the
  flatpak `xdg-dbus-proxy` through its systemd scope) before creating a
  session, and the PipeWire fd is only handed to verified sessions.
- **Reliable game-mode detection**: gamescope sockets persist in
  `XDG_RUNTIME_DIR` after a game-mode session, so socket probing alone would
  have hijacked the portal name back on the desktop and broken KDE screen
  sharing. Detection now checks for a running KWin first (same logic the
  share-button picker already used), in both the shim and the Vesktop
  launcher.
- **Electron is pinned to X11 rendering under gamescope**
  (`--ozone-platform=x11`): with `XDG_SESSION_TYPE=wayland` alone, Electron
  tried to render on a non-existent Wayland socket and never opened a window
  (WebRTC's capturer selection reads the environment, not the rendering
  platform, so the portal path still engages).
- **Unimplemented portal interfaces get proper D-Bus error replies** (and
  `Properties.GetAll` an empty dict) instead of no answer at all — otherwise
  every app probing `Settings`/`FileChooser` in game mode hung until timeout.
- **The share-settings modal is only auto-confirmed for shares Steamcord
  itself initiated** — a share started manually in the Vesktop window keeps
  its quality/audio dialog untouched.

### Fixed
- **Cameras going black while switching between videos** (#8): Discord's
  voice server only sends the video of participants whose tile is
  rendered by Discord's own UI — every mounted `<video>` tile holds an
  "active sink" refcount per stream, and when it drops to zero the client
  tells the server to stop that user's video (that's the black 16:9
  rectangle that neither stop/re-watch nor toggling helped; screen shares
  use a separate quality manager and were never affected, and 1:1 calls
  take a special path — which is why a single stream always worked).
  The relay now registers itself as an active video sink for the camera
  it is relaying, exactly like a rendered Discord tile would, and keeps
  re-asserting it while the relay is alive: switching between two
  cameras, watching camera + screen while the share is restarted, and
  coming back to a previously-watched camera should all keep the picture
  live. Reported by @DavidNotProgamer with meticulous multi-account
  testing — thanks again.

## 1.14.6 — 2026-07-18

### Fixed
- **Incoming video rewritten: mirrored cameras, ghost tiles and black
  streams** (#8): the relay used to capture the `<video>` elements Discord
  had rendered, sorted by size — with no way to tell which element belonged
  to which stream, and no way at all to capture a stream Discord had
  decided not to render (with camera + screen share active, only one of
  the two exists in the DOM; live-debugged on a real call). Incoming video
  is now read straight from Discord's media engine (`RTCPeerConnection`
  receivers), where every track is tied to its owner and its type: the
  screen share is the track on the `stream` connection of that user, the
  camera comes from the voice connection's track-owner table. No more
  guessing — camera-only mirroring, "first watch shows only the camera",
  and the ghost/black tiles that survived re-joining a call should all be
  gone, and camera + screen share can finally be watched together.
- **Tiles are labeled** (#8): each incoming video tile now says what it is
  (🖥️ screen / 📷 camera) — the offer carries a per-track label so the
  panel no longer shows anonymous tiles.

### Added
- **Toast when someone goes live**: starting a screen share or turning a
  camera on in your voice channel now shows a SteamOS notification with
  the person's name and avatar — before, with the panel closed, you never
  knew a video had started (Discord itself doesn't notify these events).
  Only real transitions notify: joining a call where someone is already
  streaming stays silent.

### Changed
- **Fullscreen reworked** (#8, suggested by David): the fullscreen view is
  now a real Steam modal rendered above the whole screen (the previous
  in-panel overlay could not escape the Quick Access sidebar), one video
  at a time — each tile has its own ⛶ button (choose the screen *or* the
  camera) — and the controller's **B** button closes it.
- **"v4l2loopback is installed but not loaded" that no command could fix**
  (#9): the module can already be loaded by something else — on Bazzite
  `/usr/lib/modprobe.d/20-akmods.conf` loads it as the OBS Virtual Camera,
  without the `video_nr=42` device Steamcord needs. `modprobe` is a no-op
  when the module is already loaded: it exits 0, prints nothing, and
  ignores the parameters. The screen share hint therefore handed out a
  command that silently did nothing, however many times you ran it.
  Steamcord now tells that case apart from a module that is simply not
  loaded, and unloads it first.
- **Screen share stopped working again after every reboot**: nothing ever
  persisted the module configuration, so `/dev/video42` was gone on the
  next boot and the hint came back. The fix now writes
  `/etc/modprobe.d/99-steamcord-v4l2loopback.conf` and
  `/etc/modules-load.d/steamcord-v4l2loopback.conf`.

### Changed
- The screen share hint is delivered as a chat-style toast, which is too
  small for a multi-line shell block and cannot be copied from in game
  mode. Steamcord now drops a ready-to-run `~/steamcord-fix-v4l2.sh` and
  the toast just shows `bash ~/steamcord-fix-v4l2.sh`. The script is safe
  to re-run, and reports what is still holding the module if the unload
  fails.

## 1.14.5 — 2026-07-17

### Fixed
- **Watching a second stream mirrored the first one** (#8): with several
  people streaming, watching one stream and then another showed the first
  stream in both tiles (and, with screen + camera, the camera sometimes
  came through black). The relay captures the rendered `<video>` elements
  by size, with no reliable way to tell which element belongs to which
  stream, so two streams watched at once cross-captured. Only one stream
  is watched at a time now — the previous one is closed before the next
  opens — which also keeps the narrow Quick Access panel readable.
- **A re-opened share could come through black on the first watch** (#8):
  when someone closes and re-opens their share, Discord re-subscribes you
  automatically, but the relay could latch onto a not-yet-painting frame.
  A re-created stream you are already relaying now restarts the relay so
  it re-captures a live frame. (If it still comes through black, stop and
  watch again.)
- **The machine appeared to hang on shutdown while Steamcord was
  installed** (#7): Vesktop runs in its own flatpak systemd scope, outside
  the plugin's control group, and it ignored the shutdown SIGTERM — so the
  system waited the full default stop timeout (~90s) before force-killing
  it, leaving the machine with a dim backlight and the fan running before
  it powered off. The Vesktop unit now terminates Vesktop immediately when
  it stops and caps its stop timeout, so shutdown is prompt again.

### Added
- **Fullscreen toggle for a watched stream** (#8): a ⛶ button expands the
  relayed video to fill the Quick Access panel, with a ✕ to exit — handy
  on the small in-game panel.

## 1.14.4 — 2026-07-17

### Fixed
- **Streams from other people never showed up in group DMs and server
  voice channels, and a share that was closed and re-opened stayed
  invisible until you left and rejoined the call** (#8): the plugin only
  polled Discord's *active* stream registry, which is populated in 1:1
  calls but only contains your own stream — or one you are already
  watching — in group and guild channels, and misses re-created streams.
  Stream detection (both the LIVE badge/Watch button and the watch
  action itself) now also reads the gateway-fed *application* stream
  registry, which tracks every stream in the channel, so streams appear
  in every call type and re-opened shares are picked up automatically.

## 1.14.3 — 2026-07-17

### Fixed
- **The "Discord login (fullscreen)" button did nothing** (#6): it was a
  leftover from the pre-Vesktop architecture, where Discord ran inside
  Steam's own browser view (`window.DISCORD_TAB`). Since the move to
  Vesktop that view no longer exists, so the button — and the automatic
  fullscreen fallback when the QR login hits a CAPTCHA — failed silently
  for everyone.

### Changed
- **Login is now QR code or Vesktop only, by design.** No login page is
  hosted inside the plugin and no credentials ever pass through it. The
  dead fullscreen-login button and its CAPTCHA fallback are removed; the
  "not connected" panel now shows the QR code plus a clear hint: if you
  can't scan it, open Vesktop once in Desktop Mode and sign in there —
  Steamcord reuses that session. The CAPTCHA message points to the same
  Vesktop path instead of a page that no longer opens. Translated across
  all 9 languages.

## 1.14.2 — 2026-07-17

### Fixed
- **Watching a friend's Go Live / camera showed a green picture on devices
  with a hardware video decoder** (#5, e.g. Steam Deck): Electron's VAAPI
  decode path outputs green frames for incoming WebRTC video on some
  GPU/driver combos, and the relayed stream inherited them. Vesktop is now
  launched with hardware video *decode* disabled (software decode, the same
  path already proven on GPUs without a decoder); sending your own share is
  unaffected.
- **The screen never turned off after a voice call** (#3, follow-up): the
  v1.14.1 fix suspended the media engine's `AudioContext`, but the real
  wake-lock holders survive a call: WebRTC audio sinks (`<audio>` elements
  fed by a `MediaStream`) keep "playing" silence and microphone capture
  tracks stay live, so Chromium keeps its audio output stream open forever
  (the lingering "Chromium" entry in Steam's volume mixer). A post-call
  janitor now pauses leftover WebRTC sinks, stops orphaned capture tracks
  and suspends every page `AudioContext` ~5 s after leaving a call —
  verified end-to-end in sandbox (leaked sink reproduced, PipeWire streams
  all released after hangup). Discord recreates everything on the next call.
- **The "Watch" button could vanish while the friend was still streaming**
  (#5): Discord's streaming store transiently reports no active streams
  (quality renegotiation, reconnection hiccups) and a single empty poll was
  enough to declare the stream dead. A stream must now be missing for 3
  consecutive polls (~6 s) before the button is removed.
- **Voice/stream volume sliders reset to 100% when reopening the panel**
  (#5, UI only — the actual volume was preserved): the sliders now read the
  engine's persisted volume when they mount instead of assuming 100%.

## 1.14.1 — 2026-07-16

### Fixed
- **Rerouted notifications from other Decky plugins no longer wear the
  Discord logo** (#4): a toast from e.g. AutoFlatpaks used the generic
  Discord avatar and looked like a Discord message — plugin toasts now get
  the neutral Steam default avatar; the Discord logo is reserved for actual
  Discord events without a custom avatar.
- **Notification title could flicker or vanish** (#4): Steam refreshes the
  personas backing the notifications asynchronously and could wipe the
  sender's name mid-render (the name is a non-configurable MobX accessor, so
  it can't be shadowed with a getter like the avatars) — a persona guard now
  re-asserts the names of all notification personas, repairing the toast and
  the notification tray within moments of any overwrite.
- **A poisoned notification tray could silence every plugin's notifications
  for the whole session** (#4): after using native Decky toasts on a Steam
  build that can't render them, stale tray entries kept crashing the
  notifications panel. The tray is now swept of leftover Decky entries at
  every startup, regardless of the toggle. The toggle's description now
  warns explicitly that most current builds (including SteamOS stable
  3.8.15, same steamui bundle as the dev machine) crash on native rendering.
- **Screen could never turn off while Steamcord was loaded** (#3,
  experimental fix): the Discord audio engine's `AudioContext` was kept
  permanently resumed, making Chromium hold an audio wake-lock. It is now
  kept alive only during a voice call on this device and actively suspended
  when idle (rejoining a call resumes it within ~1.5 s).

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
