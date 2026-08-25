# Changelog

Older releases (v1.0.0 → v1.11.0) are documented on the
[GitHub Releases](https://github.com/Necrosiak/Steamcord/releases) page.

## Planned for upcoming updates

> The UI of recently added features (in-game voice/POV overlays, the
> multi-POV grid, the quick-reply panel) is **not final** — layout, controls
> and defaults are still open to change. Suggestions are welcome via
> [issues](https://github.com/Necrosiak/Steamcord/issues); the same applies to
> anything added going forward.

- **Screen + camera as separate POV tiles** — when someone shares both at
  once, show them as two tiles instead of preferring the screen.
- **Translations** for the newest labels (overlays, POV grid, quick-reply);
  they currently fall back to English outside EN/FR.

## 1.28.0 — 2026-08-25

Clip sending, as shipped in v1.27.0 and v1.27.1, did not work for the clips
people actually have. Those two releases have been withdrawn.

### Fixed

- **Steam clips were invisible, and could not have been sent anyway**
  ([#40](https://github.com/Necrosiak/Steamcord/issues/40)). A Steam clip is not
  a file: it is a folder holding a thumbnail, a timeline and the recording split
  into DASH fragments (`init-stream0.m4s` plus a run of `chunk-stream0-*.m4s`,
  and the same again for audio). The previous releases looked for video files,
  so a clip recorded a minute earlier appeared nowhere. Clips are now listed
  first, named after the game and the time they were taken, and rebuilt on send
  by stitching the fragments back together — in numerical order, since sorting
  them as text puts chunk 100 before chunk 2.

- **Clips are compressed to fit instead of being refused.** Twenty-five seconds
  of 1080p comes to about 32 MiB, three times what Discord accepts, so greying
  those out would have meant offering none of them. The bitrate is now derived
  from the clip's length to land just under the limit — that example becomes
  8.4 MiB in around thirteen seconds, still 1080p. Beyond ten minutes, or where
  the required bitrate would ruin the picture, Steamcord says so rather than
  grinding away at it.

- **`ffmpeg` inherited the plugin loader's PyInstaller environment** and died on
  `OPENSSL_3.2.0 not found`, which surfaced as "could not send this clip". This
  is the same defect fixed for the GStreamer children in v1.25.0; the media
  tooling added in v1.27.0 had not been routed through the same cleanup.

- **Attachments arrived with a doubled extension** and an internal working name.
  A clip now arrives as `clip-20260825-073545.mp4`.

### Changed

- Preparing a clip takes a few seconds, so the picker now stays open and says
  what it is doing instead of closing as though nothing had happened.

## 1.27.1 — 2026-08-25

### Fixed

- **Clips that were not already MP4 arrived as a download instead of a video**
  ([#40](https://github.com/Necrosiak/Steamcord/issues/40)). Discord only plays
  MP4, WebM and MOV inline. A Matroska clip uploaded perfectly well and then sat
  in the conversation as a file to download, which defeats the point of sending
  a clip at all. Anything in another container is now repackaged as MP4 before
  it is sent — the streams are copied, not re-encoded, so it is near-instant and
  loses no quality. If the streams cannot go into an MP4 the original is sent
  unchanged rather than not sent at all.

## 1.27.0 — 2026-08-25

Three reports, three different needs: someone whose Go Live fails silently,
someone whose Rich Presence names the wrong game, and someone who wanted to
send a clip without going through their phone.

### Added

- **Send a video clip to Discord from the plugin**
  ([#40](https://github.com/Necrosiak/Steamcord/issues/40)). A film icon next to
  the screenshot button lists the videos in your Videos, Downloads and Desktop
  folders — under their localised names too — along with any clips you have
  exported from Steam, newest first. Files above Discord's 10 MiB limit are
  listed but greyed out with their size, rather than hidden as if they did not
  exist. Steam's own recordings live as `.m4s` fragments and are not playable
  files, so only exported clips appear.

  The file never travels through the plugin's websocket: Discord fetches it from
  a local address and hands it to the same uploader the client uses for its own
  attachments. The backend only ever issues opaque tokens, never paths.

### Fixed

- **The play timer never restarted when the detected game changed**
  ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). The timer followed
  the title Steam reports, which stays "Heroic" from beginning to end. Closing a
  game therefore left Heroic carrying on with the game's elapsed time, and the
  next game continued from there. It now restarts whenever the game actually
  shown changes.

- **Nothing after the screen capture was visible in the logs**
  ([#42](https://github.com/Necrosiak/Steamcord/issues/42)). Go Live acquires the
  screen and then asks Discord to publish it. Everything past the first step was
  written to Vesktop's console, which is out of reach in Gaming Mode — so a
  report where the capture starts and the stream never appears contained nothing
  to work with. Each step is now recorded in the backend log, including whether
  Discord actually created a stream two seconds after being asked to.

### Changed

- **You can override which game is shown**
  ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). Discord's database
  maps one executable to one title, and some series share a single program file
  — every classic Need for Speed runs `speed.exe`, and Discord lists only one
  *Most Wanted*. No amount of guessing fixes that, so there are now two settings:
  one to switch launcher detection off, and one to force an exact title.

## 1.26.1 — 2026-08-24

Same-day follow-up to v1.26.0, from @imrprogamer testing it properly.

### Fixed

- **A title Discord did not recognise could pick up someone else's artwork**
  ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). When the running
  title resolved to nothing, v1.26.0 fell back to the first recognised
  executable it could find — which might be anything detectable sitting in the
  background. Watching media in Harbor showed an unrelated game's picture. No
  artwork was always better than the wrong artwork. The executable must now
  bear some resemblance to the title Steam reports; launcher titles are exempt,
  because there the whole point is to find a game unrelated to the launcher.

- **Games started from inside a launcher are picked up as they appear**
  ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). Steam only notifies
  about its own applications, so launching a game from Heroic produced no event
  at all and the process list travelled with a snapshot taken before the game
  existed — leaving "Heroic" on screen. The list is now refreshed every 20
  seconds for as long as something is running, and the client ignores refreshes
  that change nothing, so Discord sees no extra traffic.

## 1.26.0 — 2026-08-24

Rich Presence had been running on the wrong code for ten releases, and a crash
in the desktop fallback had been waiting since before that.

### Fixed

- **The Rich Presence improvements shipped in v1.16.0 never ran**
  ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). Two `case "$rpc"`
  branches existed in the same `switch`, so the second — the one with the
  artwork lookup, the normalised name matching added for
  [#32](https://github.com/Necrosiak/Steamcord/issues/32), and the continuous
  playtime — was unreachable. What actually ran was the original exact-match
  handler: it required the Steam title to equal Discord's title character for
  character, so anything Steam writes differently ("HELLDIVERS™ 2", a shortcut
  named "GTA San Andreas") got no artwork at all, and the play timer restarted
  on every reconnection. The dead branch is now the live one.

- **The screen-share relay crashed when it had no pipeline to close**
  ([#42](https://github.com/Necrosiak/Steamcord/issues/42)). `close_pipeline()`
  read an attribute that only `start_pipeline()` ever created, so every path
  that closed the socket without building a pipeline raised `AttributeError` in
  the handler's cleanup — the Desktop Mode `no_source` path, and, since v1.25.0,
  the missing-plugins path as well.

### Added

- **Games launched through Heroic, Lutris and other launchers are now
  detected** ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). Steam
  only knows what Steam started, so launching a game from Heroic showed
  "Heroic" in Discord and nothing about the game. Steamcord now reports the
  running executables alongside the Steam title, and matches them against the
  executable list in Discord's own detectable-games database — the same
  information the official client uses. A game whose Steam title already
  resolves is left alone, so nothing that worked before can be redirected.

- **Artwork for shortcuts whose name does not match Discord's**. When the title
  resolves to nothing, the running executable is used instead, and the
  canonical name is displayed with it.

## 1.25.0 — 2026-08-23

Screen sharing worked here and failed elsewhere. Three reasons, none of them
visible on the machine it was developed on.

### Fixed

- **The GStreamer fallback could never claim the screen after the native path
  timed out** ([#38](https://github.com/Necrosiak/Steamcord/issues/38)). When
  `getDisplayMedia` did not answer within 25 seconds, Steamcord gave up and fell
  back to its local GStreamer relay — but nothing cancelled the portal capture
  session it had already opened. Closing a session only released our own copies
  of the PipeWire file descriptors and never emitted
  `org.freedesktop.portal.Session.Closed`, so Chromium went on believing the
  session was alive and kept holding the gamescope node. The fallback then found
  a source it could not open. Killing the shim by hand was the only thing that
  freed it, because losing the D-Bus name is what finally told Chromium to let
  go. Sessions now emit `Closed`, and the relay asks the shim to release them
  before it opens the node.

- **The GStreamer child inherited the plugin loader's PyInstaller
  environment** ([#38](https://github.com/Necrosiak/Steamcord/issues/38)).
  Decky's loader is a PyInstaller binary and points `LD_LIBRARY_PATH` and
  `LD_PRELOAD` at its own bundled libraries. The system GStreamer launched from
  it picked those up and aborted on the bundled OpenSSL (`OPENSSL_3.4.0 not
  found`), so Go Live produced no picture at all. Steamcord already had the
  cleanup used for the portal shim; this launch path had simply never been
  routed through it. Two further spawn sites (the virtual-camera feeder and the
  Go Live preview) fell back to the same unscrubbed environment and are fixed
  too. This never showed up on Bazzite, whose system libraries happen to be
  compatible with the bundled ones; on SteamOS it is fatal.

- **An incomplete GStreamer install failed without saying so**
  ([#38](https://github.com/Necrosiak/Steamcord/issues/38)). Without
  `gst-plugins-bad` there is no `webrtcbin`, so the pipeline could not be built
  and Go Live failed in a way that looked like "no capturable screen". Steamcord
  now checks the GStreamer registry up front and reports every missing element
  along with the package that provides it.

### Known limitations

- On hardware where `v4l2loopback` cannot be installed, the virtual-camera path
  remains unavailable; this is a packaging matter for the distribution, not
  something Steamcord can work around.

## 1.24.0 — 2026-08-23

A login that could never finish, a README that described a feature removed a
month earlier, and a workaround that had quietly been breaking other people's
applications.

### Fixed

- **Steamcord broke every other app in Gaming Mode that talks to the desktop
  portal** ([#39](https://github.com/Necrosiak/Steamcord/issues/39)). To make
  Go Live work under gamescope — which ships no portal backend — Steamcord runs
  a shim that takes ownership of `org.freedesktop.portal.Desktop` and stops the
  real `xdg-desktop-portal` while a gamescope session exists.

  That bus name is **session-wide**, not private to Discord. The shim
  implemented only `ScreenCast` and answered everything else with an error, so
  while it was running, *every* application in the session got that error
  instead of a working portal. It was reported as Sober (Roblox on Linux)
  failing to list servers; Sober was simply asking for its proxy configuration
  and being refused by us.

  The shim now answers the interfaces the real portal implements in its
  frontend, with no desktop backend involved — `ProxyResolver` and
  `NetworkMonitor`. Those are always available with a real portal on any
  desktop, so refusing them was a regression rather than a missing feature.
  Anything still unimplemented is now logged with the caller and the method, so
  the next gap of this kind shows up in Steamcord's own journal instead of in
  somebody else's application.

- **QR login looped forever, silently, when Discord served a CAPTCHA**
  ([#37](https://github.com/Necrosiak/Steamcord/issues/37)). When Discord does
  not trust the IP it puts a CAPTCHA on its *login page*. It then never issues a
  remote-auth ticket at all: the QR code quietly reset every ~30 seconds,
  forever, with nothing shown to explain it.

  The plugin did have a CAPTCHA warning, translated into all nine languages —
  and it could never fire. It was set only on the ticket-exchange path
  (`exchange_ticket` receiving a `400` with `captcha_key`), and that path does
  not exist under Vesktop: there the QR code shown in the panel is Discord's
  own, mirrored from its login page, so no ticket is ever exchanged. The
  warning was unreachable by construction. Detection now looks at the page
  itself, where the challenge actually is.

- **The README described a fullscreen login that no longer exists.** The
  fullscreen login button and its CAPTCHA fallback were removed in v1.14.3
  (they drove a Steam BrowserView from the pre-Vesktop architecture and had
  been dead for everyone), but all nine READMEs kept advertising them —
  including the claim that a CAPTCHA could be solved there. Corrected in every
  language.

### Added

- **Solve the CAPTCHA in Gaming Mode, with the controller.** When the challenge
  is detected the panel now offers to open it: Steamcord mirrors Discord's
  login page and sends your clicks back to it. The D-pad moves the pointer and
  A clicks; a touchscreen or mouse works too. It closes itself once you are
  logged in.

  Simply showing the Vesktop window instead would not work, and this was
  measured rather than assumed: the window is started minimized, and mapping it
  by hand changes nothing on screen — gamescope only paints the window Steam
  designates, and before/after screenshots are identical byte for byte. Posting
  it as an external overlay (the atom mangoapp uses) does display it, but such
  windows receive no focus and no input at all. Mirroring the page over CDP is
  the only path that works, and the page receives the forwarded clicks as
  genuine user input.

## 1.23.0 — 2026-08-18

Two reports about the plugin costing more than it should, and one long-standing
request for control over the stream. All three turned out to be about the same
thing: work being done that nobody asked for, and settings that existed but were
never exposed.

### Added

- **Stream quality settings for Go Live** (resolution and frame rate), in the
  Steamcord settings next to the notification options — requested in
  [#33](https://github.com/Necrosiak/Steamcord/issues/33).

  Steamcord was already pinning screen sharing to 1080p60 internally, without
  ever showing it. Now you choose: 720p / 1080p / 1440p / Source, and 15 / 30 /
  60 FPS / Source.

  Worth being precise about what this does, because it is not a transcoder. The
  setting is handed to Discord's own encoder as a capture constraint, so nothing
  is re-encoded on your machine and the plugin costs no extra CPU for it. It
  also means the constraint is read **when a share starts**: changing it does
  not affect a Go Live already running, only the next one.

### Fixed

- **A polling loop that never stopped, burning CPU and battery forever**
  ([#36](https://github.com/Necrosiak/Steamcord/issues/36)).

  Steamcord opens the on-screen keyboard when you tap a message box. It found
  that message box by polling the DOM every 100 ms and stopping once it had
  wired it up — except on any view that has no message box (the friends list, a
  voice channel, a forum, the shop) the lookup threw, the failure was swallowed,
  and the loop simply never stopped. Worse, it was restarted on **every channel
  switch**: one permanently leaked 10 Hz whole-document query per such view
  visited, accumulating for as long as the session lasted.

  Measured over CDP on nothing but an idle friends list, it was the only
  repeated DOM query in the whole renderer, running exactly ten times a second.
  It is now a single delegated click listener, installed once: no polling at
  all, and it also covers message boxes created later, which the old code could
  not do reliably.

- **The 1080p60 screen-share preset was often never applied.** It was written
  through `window.localStorage`, which Discord deletes on `discord.com` as an
  anti-token-theft measure; the write threw and the failure was swallowed. It
  now goes through a same-origin iframe, the same approach Vencord uses.

### Changed

- **Vesktop no longer keeps its renderer at foreground priority.** Its window is
  never shown — everything you look at is the plugin's own UI in the Steam
  overlay — yet two Chromium flags were forcing the browser to treat that hidden
  window as if you were watching it. Only the flag that protects JavaScript
  timers is kept, because Discord's gateway heartbeat depends on it.

  To be straight about the measured effect: idle CPU did **not** change (about
  1.7 % of one core before, and Chromium was already throttling animation to
  1 fps on its own). What changes is that the scheduler may now deprioritise a
  renderer nobody is looking at while a game is running.

## 1.22.0 — 2026-08-12

The voice shortcut could only be bound to controller buttons, which is the one
thing `SteamClient.Input` can see. Binding push-to-talk to a key on an attached
keyboard — or to a spare mouse button, which is what most people actually want
when the Deck is docked — needed a different input source, read from the
backend. It turned out not to need any new privileges.

### Added

- **Push-to-talk on a physical keyboard key or a mouse button.** The QAM now
  captures whatever you press — controller chord, keyboard key or mouse button —
  and keeps one binding per input type, any of them opening the mic. Controller
  in handheld, mouse while docked, without reconfiguring in between.

  Keyboard and mouse are read in the backend from `/dev/input/event*`, because
  the CEF context has no keyboard focus while a game is running: a `keydown`
  listener in the panel sees nothing in the exact situation the feature exists
  for. Notable constraints the implementation respects:

  - **No root flag.** `plugin.json` stays `"flags": []`. On SteamOS this is
    enough: it ships `70-steam-jupiter-input.rules`, which tags input devices
    `uaccess`, and logind then grants the active session user a POSIX ACL on the
    event nodes. **On other distributions it is usually not enough** — see the
    known limitation below.
  - **Readable devices are probed, never inferred.** Whether a node is readable
    is not deducible from its bus or vendor — two predictions made from the rule
    text turned out wrong. The reader simply attempts `open()` and offers what
    succeeds; a device that is present but not readable is listed separately
    and shown to you, rather than being indistinguishable from one that is absent.
  - **`EVIOCGRAB` is never used.** The grab is per *device*, not per key, so it
    would take the whole keyboard away from the game. As a passive reader the
    plugin sees the same events the game does.
  - **Bindings are stored as a device fingerprint**, not `/dev/input/eventN`:
    node numbers are reassigned on reconnect and after suspend (observed: the
    same keyboard came back as `event19` having been `event18`). Devices are
    re-resolved on a read error and on a periodic rescan, so a binding survives
    sleep and Bluetooth reconnects.
  - **Privacy.** The reader is a separate module so the guarantee is auditable in
    one place: it never logs or persists a key code, only the binding you chose
    and a count of readable devices. Autorepeat is ignored, and `SYN_DROPPED`
    releases push-to-talk rather than risk leaving the mic open.

### Fixed

- **The mic cut out when two shortcuts were held at once.** `set_ptt` carried no
  notion of *which* input asked for it, so with a controller button and a
  keyboard key both held, releasing either one closed the mic while the other was
  still down. Push-to-talk state is now tracked per source and only the
  aggregate edge is sent to Discord.
- **Saving the voice shortcut could drop unrelated settings.** The config was
  written as a whole blob with no merge, so any caller that did not know about a
  key silently removed it. Writes now merge onto the stored file under a lock.
- **The controller shortcut could stop responding until Steam restarted.** The
  subscription returned by `RegisterForControllerInputMessages` is now retained,
  and re-subscribed after the machine wakes from sleep — held-button state is
  reset at the same time, since a button held before suspend is not held after.
- **A binding could anchor on a node that never speaks.** A device fingerprint
  (vendor, product, name) does not identify a *node*, and several nodes can share
  all three byte for byte — measured on an ordinary 2.4GHz receiver whose
  `event3` and `event7` are both keyboards with identical fields. Resolution
  stopped at the first match, which is the lowest-numbered node and frequently
  the silent one; the shortcut then never fired, with no error anywhere. Every
  matching node is now registered.
- **Push-to-talk was not released when the plugin reloaded.** A key held at that
  moment left the client on `$ptt = true` with nothing left to say otherwise,
  holding the mic open.

### Known limitation

- **Outside SteamOS, your keyboard and mouse are probably not readable.** The
  plugin cannot fix this from its side: reading `/dev/input/event*` needs a
  `uaccess` ACL, and systemd's own rule grants it to **joysticks only**
  (`70-uaccess.rules`: `ENV{ID_INPUT_JOYSTICK}`). SteamOS adds a rule covering
  input devices; most other distributions do not — measured on Bazzite, where a
  USB wireless mouse returned `EACCES` on all five of its nodes, and a keyboard
  was readable only because an unrelated RGB-lighting rule happened to tag it.

  The panel now tells you when this is the case, instead of silently offering
  nothing. To opt in, add two lines as root and reload udev:

  ```
  # /etc/udev/rules.d/70-input-uaccess.rules
  SUBSYSTEM=="input", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
  SUBSYSTEM=="input", ENV{ID_INPUT_MOUSE}=="1", TAG+="uaccess"
  ```

  ```
  sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=input
  ```

  Be aware of what this trades away: `uaccess` lets **any** process running as
  your user read every keystroke on the machine, in any window. It is the same
  trade SteamOS makes on the Deck, reasonable on a single-user games console and
  much less so on a machine you also work on. Deleting the file reverts it.

### Changed

- The voice shortcut config is now versioned (`version: 2`) and holds a list of
  bindings instead of a single button array. Existing configs are migrated in
  memory and only rewritten in the new shape once you save, so an install can be
  rolled back. Nobody loses an existing controller binding.

## 1.21.1 — 2026-08-09

@william097y noticed that some games showed up in Discord without their
artwork, and guessed the reason from the pattern: the affected titles all
carried a `™`. That guess was right, and it pointed at something slightly
wider than the symbol itself.

### Fixed

- **Games showing in Discord without their Rich Presence artwork**
  ([#32](https://github.com/Necrosiak/Steamcord/issues/32)). Steam and Discord
  do not spell the same game the same way. Steam keeps legal symbols and
  typographic punctuation — `HELLDIVERS™ 2`, `DARK SOULS™ III`,
  `Marvel’s Spider-Man Remastered` with a curly apostrophe — while Discord's
  detectable-games index has `HELLDIVERS 2` and `Marvel's …` with a plain one.
  Steamcord matched those two spellings literally, so the title resolved to no
  application id at all, and the artwork hangs off that id: the activity
  appeared with the right name and no image.

  Titles are now compared through a normalised key (legal symbols, curly
  quotes and dashes, width and spacing), and, failing that, a letters-and-digits
  key that absorbs punctuation differences such as
  `Resident Evil 7 Biohazard` versus `Resident Evil 7: Biohazard`. Exact
  matching still runs first, so no game that already resolved can change
  target. Measured against a real 139-game library, matches went from 99 to
  110 — every game in that library which Discord knows about.

  The loosest key is deliberately fenced in: on its own it collapses any
  fully non-Latin title — Japanese, Korean, Chinese, Cyrillic — to an empty
  string, which on the real index put more than fifty games in one bucket.
  It is therefore only consulted for keys of at least six characters that
  contain a letter, and any key claimed by two different applications is
  dropped for good. No image is better than another game's image.

## 1.21.0 — 2026-08-03

The first NixOS report, from @Strix-Vyxlor, turned out not to be about missing
packages at all: the plugin could not find tools that were installed. One cause,
three symptoms, and the fix makes every unusual distribution more likely to work
out of the box.

> Updating from v1.18.2 or later works normally from the plugin — this release
> adds no new top-level files.

### Fixed

- **Screen share and its preview silently did nothing on NixOS**
  ([#29](https://github.com/Necrosiak/Steamcord/issues/29)). The backend is
  started by Decky's *system* service, so it inherits systemd's minimal `PATH`.
  On NixOS nothing lives in those directories — `pgrep`, `pw-dump`, `pactl`,
  `ffmpeg` and `gamescopectl` are all under `/run/current-system/sw/bin` — so
  three separate features died on a bare `FileNotFoundError`: the plugin could
  no longer tell Game Mode from Desktop (`[shareenv]`), PipeWire node discovery
  failed (`[screendiag]`), and the preview's no-GStreamer fallback never fired,
  because looking up its two binaries went through the same truncated `PATH`.
  Steamcord now appends the Nix and Guix roots, `~/.local/bin` and the usual
  `/usr` locations to its own `PATH` at startup — appended, never prepended, so
  the distribution's own binaries keep priority, and a no-op where those
  directories do not exist.

### Changed

- **procps is no longer a dependency.** Process lookup used to shell out to
  `pgrep`/`pkill`, which are absent from a default NixOS or Alpine install.
  Steamcord now reads `/proc` directly — no package needed on any distribution,
  and one less process spawned on paths that run every time the panel opens.
- **Install hints for four more package managers.** `nixos-rebuild`, `emerge`,
  `apk` and `xbps-install` are recognised alongside pacman/dnf/apt/zypper, so
  those users stop being shown an Arch command. NixOS gets the declaration to
  add to `configuration.nix` rather than an imperative command, which would be
  undone by the next rebuild.
- **A `[deps]` line at startup** naming exactly which optional tools were not
  found and what each one costs. None of them are mandatory — voice and chat
  need none — but a feature that quietly does nothing now says why.

### Documentation

- [docs/OS-NOTES.md](docs/OS-NOTES.md) gains a **required system tools** table,
  a **NixOS** section (including why `pygobject3` on its own cannot work), and
  Gentoo, Alpine and Void entries in the package tables — the explicit
  dependency list asked for in
  [#29](https://github.com/Necrosiak/Steamcord/issues/29).

## 1.20.0 — 2026-08-02

Four reports from @Matchaccia and @Havok027, three of them traced to a definite
root cause. The screenshot picker was showing the wrong screenshots, screen
sharing could die until a full shutdown, the server list could fail with a raw
Python error, and notifications can now be filtered while a game is running.

> Updating from v1.18.2 or later works normally from the plugin — this release
> adds no new top-level files.

### Fixed

- **The screenshot picker never showed your most recent screenshots**
  ([#27](https://github.com/Necrosiak/Steamcord/issues/27)). `GetAllAppsLocalScreenshotsRange(0, 24)`
  looked like "the 25 newest". It is not. Measured against the running Steam
  client: the bounds are **inclusive**, and the list is **not sorted by date** —
  it is grouped by game, and only descending *within* each game. So the request
  returned the first 25 entries of a per-game ordering, and once you had more
  screenshots than that, whole recent games fell outside the window. Taking the
  tail of the list does not work either, because the newest shot can sit in the
  middle. The picker now fetches everything and sorts it itself.
- **Screen sharing could stop starting entirely, until a full shutdown**
  ([#26](https://github.com/Necrosiak/Steamcord/issues/26)). The ScreenCast
  portal handed Chromium a PipeWire connection and held its own copy of the file
  descriptor until Discord closed the session — which Discord only does on a
  clean stop. A glitched stream, a reloaded tab or a restarted Vesktop leaked
  one every time. Those connections pile up until PipeWire stops registering
  clients: `pw-dump` then hangs, the screen node can no longer be found, and
  `Start` fails **without surfacing any error** — exactly the reported "it just
  doesn't want to start". Stale sessions are now closed when a new one opens,
  and our copy of the descriptor is always released.
- **The server list could fail with a raw Python exception**
  ([#28](https://github.com/Necrosiak/Steamcord/issues/28)). Two separate
  problems. A non-dict entry in the guild list raised `AttributeError` straight
  into the panel, because the type guard was applied in one place out of three.
  And Vencord resolves its stores lazily: opening the tab in the first seconds
  after Discord starts could throw a `TypeError` that was relayed verbatim. The
  list now retries on its own while the failure is transient, unexpected errors
  are logged with a traceback, and neither case reaches the UI as a stack trace.
  For the record, a 30-second timeout was ruled out by measurement — the lookup
  takes 23 ms across 98 servers and 515 voice channels.

### Added

- **Notifications while playing** ([#25](https://github.com/Necrosiak/Steamcord/issues/25)),
  requested by @Havok027. A new setting with three modes: all notifications,
  direct messages and calls only, or none — applied only while a game is in the
  foreground. A corrupt or unreadable setting always falls back to "all", so
  notifications are never silenced without you asking.

## 1.19.0 — 2026-07-26

Follow-up to @DavidNotProgamer2's reports. The jump-to-latest button is gone,
replaced by a controller shortcut and by the composer itself; the first
notification of a session no longer disappears; and a whole class of silent
failures is fixed — several DOM helpers had been looking for elements in the
wrong document and quietly doing nothing.

> Updating from v1.18.2 or later works normally from the plugin — this release
> adds no new top-level files.

### Changed

- **Fullscreen chat: no more "Jump to latest" button.** Moving down onto the
  message box is what resumes the live feed now, which is the gesture most
  people already used. The button also flickered while scrolling, because its
  state was recomputed on every scroll event.
- **Controller shortcut in the fullscreen chat** — **Y** (or **X**) puts the
  selection back on the message box and returns to the bottom of the
  conversation in one press. The action is shown in the footer legend.
- **Quick chat: moving down from the channel list now lands directly on the
  message box**, instead of stopping on the most recent message first. Moving
  back up still enters the list on the most recent message and walks the
  history one message at a time.

### Fixed

- **The very first message notification of a session never popped**
  ([#23](https://github.com/Necrosiak/Steamcord/issues/23)). The toast window
  subscribes to Steam's notification store; when a notification arrives before
  that window is mounted, nothing renders it and the notification is silently
  lost — the entry still reached the tray, which is why it looked like a
  display glitch. Steamcord now checks that the first toast of a session was
  actually rendered and re-issues it once if it was not.
- **Notifications arriving in quick succession were dropped.** The backend held
  a single notification slot: anything that arrived while the previous one was
  being dispatched overwrote it and was then cleared. Two messages in a row
  produced one notification. It is now a proper queue, preserving order.
- **Only one screen share was visible at a time**
  ([#24](https://github.com/Necrosiak/Steamcord/issues/24)). Stream detection
  relied on a registry that can be empty even when someone is sharing, so
  neither the LIVE badge nor the Watch button appeared; and watching a second
  share cut the first one off. Detection now also reads the voice state, and
  watching no longer stops the stream already playing.
- **Several UI behaviours silently did nothing at all.** The fullscreen view
  and the quick chat both looked up their scroll containers by element id, but
  the plugin does not run in the same document as the panel (quick chat) or the
  modal (fullscreen) — every lookup returned nothing. Sticking to the bottom,
  restoring focus on the most recent message, and holding the view still on the
  selected message were all affected. They now work on the real nodes.

## 1.18.4 — 2026-07-24

Bugfix release, entirely from @DavidNotProgamer2's chat report
([#21](https://github.com/Necrosiak/Steamcord/issues/21)): the fullscreen chat
stays where you put it, messages arrive live every time, and actions that fail
now say why instead of pretending to have worked.

> Updating from v1.18.2 or later works normally from the plugin — this release
> adds no new top-level files.

### Fixed

- **Fullscreen chat no longer jumps to the newest message while you are reading
  an older one** ([#21](https://github.com/Necrosiak/Steamcord/issues/21)). The
  v1.18.1 fix only froze the view while you were *acting* on a message —
  editing, reacting, deleting — and simply *selecting* one did not count. Worse,
  the "are you still at the bottom?" test measured the scroll position, which is
  blind to this case: selecting a message already on screen scrolls nothing, so
  the list still looked pinned to the bottom and the next incoming message
  yanked it away regardless. The view now follows which message your cursor is
  on. Select anything that is not the newest and it holds still, with the "jump
  to latest" button to resume. Passive reading still follows the conversation.
- **Messages sometimes took 20 seconds to appear, or seemed never to arrive**
  ([#21](https://github.com/Necrosiak/Steamcord/issues/21)). Live message events
  are only pushed for the one channel the plugin declares it is watching, and
  that declaration was made solely by the quick-access panel — which unmounts
  behind the fullscreen window and released the channel on its way out. So
  depending on how you got into fullscreen, the live feed was switched off
  underneath it and messages only surfaced on the 20-second reconciliation poll.
  That is why it looked random and had nothing to do with servers or DMs. The
  fullscreen view now claims its own channel, re-claims it periodically (so it
  also recovers by itself if the Discord tab restarts), and hands it back when
  it closes.
- **The quick-access chat preview showed the oldest messages instead of the
  newest** ([#21](https://github.com/Necrosiak/Steamcord/issues/21)). It was
  still using the delayed "scroll to the bottom" that loses the race whenever an
  image finishes decoding after the fact, leaving you parked at the top of the
  conversation with one or two messages visible. It is now anchored to the
  bottom the same way the fullscreen list is.
- **Editing, deleting or reacting could fail silently.** When one of these was
  refused, the reason was thrown away in three separate places: the error was
  serialised to an empty object on its way back from the Discord tab, the
  backend read that empty result as a success, and the interface applied its
  optimistic update anyway. A failed edit therefore closed the editor and
  displayed your new text until the next refresh quietly replaced it — visually
  identical to nothing having happened, with nothing in the logs either. These
  failures are now visible: the reason appears in red under the message and in
  the plugin log, the editor stays open with your text intact, and the
  optimistic update is rolled back. The reason is the one Discord gives —
  message, error code and HTTP status — not a generic placeholder.
- **A message that could not be sent no longer disappears.** A refused send was
  treated as a success: the draft was cleared and the conversation reloaded, so
  the text vanished without ever reaching Discord. The draft — and the reply
  you were answering — are now kept, with Discord's own reason shown.
- **The quick-access message list no longer jumps to the oldest message when
  you scroll down into it.** Entering the list from above landed on its first
  child — the oldest message on screen — which tore the view away from the
  recent messages it had just settled on. Entry now targets the newest message
  whichever direction you come from, and each step up walks back through the
  conversation.

### Changed

- **Overlay logs are now in English.** The `[overlay]` lines printed by the
  helper and the backend were still partly in French, which is awkward given
  that these are exactly the lines people paste into bug reports.

## 1.18.3 — 2026-07-24

Bugfix release. In-game overlays finally work on a stock Steam Deck: the
overlay no longer needs a web engine to draw the voice roster.

### Fixed

- **In-game overlays now work on SteamOS**
  ([#22](https://github.com/Necrosiak/Steamcord/issues/22)). SteamOS ships no
  WebKitGTK GObject binding at all — neither 4.1 nor 4.0 — so the overlay
  helper died on startup and no overlay ever appeared on a Steam Deck. The
  helper now picks its renderer at launch: WebKitGTK where it exists, and
  otherwise a native GTK/Cairo renderer that draws the voice roster itself
  (avatars, speaking ring, mute badge, position/opacity/size settings — same
  look as before). The POV video overlay still needs a web engine to decode
  the stream, so it is hidden from the menu, with the reason, on systems
  without one instead of offering a switch that cannot work.
- **Overlay window no longer depends on python-xlib.** Setting the
  `GAMESCOPE_EXTERNAL_OVERLAY` atom — what makes gamescope paint the window
  over the game — fell back silently when the module was missing. It now calls
  libX11 directly if python-xlib is unavailable.

## 1.18.2 — 2026-07-24

Bugfix release. The in-plugin updater now works on every install, and in-game
overlays start on Decks that only ship the older WebKit binding.

> **⚠️ Updating from v1.17.0 or older requires a manual reinstall.** The fix
> ships *inside* the updater, so it cannot repair an update performed by an older
> one — and those installs are missing the `game_overlay` folder, which the old
> updater cannot create. Uninstall the plugin from Decky and install v1.18.2
> fresh. Coming from v1.18.0 or v1.18.1, update normally: this release adds no
> new top-level files. **From v1.18.2 onwards, updating from the plugin always
> works.**

### Fixed

- **Plugin updates no longer fail with "Permission denied"**
  ([#16](https://github.com/Necrosiak/Steamcord/issues/16)). Decky re-owns the
  plugin's top-level directory as root on every load and only hands the contents
  to your user, so the backend could never create a *new* top-level file or
  directory — any release that added one failed, and no amount of `chmod` or
  `chown` made it stick. Updates are now handed to Decky's own installer, which
  runs as root and restores permissions afterwards. Decky shows its usual
  confirmation prompt, and the update button follows the install through to the
  end instead of hanging.
- **In-game overlays did nothing on some Decks**
  ([#22](https://github.com/Necrosiak/Steamcord/issues/22)). The overlay helper
  required the WebKit2 **4.1** GObject binding and exited immediately when only
  **4.0** was available. It now probes both, and says so clearly if neither is
  installed.
- **The speaking / focus ring was invisible on portrait streams**
  ([#22](https://github.com/Necrosiak/Steamcord/issues/22)). A letterboxed video
  still fills its whole element and painted over the ring; the ring is now drawn
  above the video.
- **A failed update check reported "up to date"**. A network error or an
  exhausted GitHub API rate limit now shows the real reason instead of claiming
  you are on the latest version.
- **Plugin notifications used your own Steam name and avatar**, as if you had
  sent them to yourself. They now show as *Steamcord*.

### Changed

- **Auto-update is off by default.** An available update is always announced with
  a notification; installing it stays your call. Installing goes through Decky's
  confirmation prompt, so it is never triggered silently in the background.

## 1.18.1 — 2026-07-23

Follow-up fixes for feedback on the 1.18.0 features.

### Fixed
- **In-game overlays** — the overlay toggle no longer silently reverts to off.
  When enabling an overlay, the plugin now confirms the overlay window
  actually stays up; if it fails to start, the toggle flips back immediately
  instead of appearing on and then reverting the next time you open the panel.
  (If overlays still fail to appear on your device, please attach the
  `[overlay]` lines from `journalctl -u plugin_loader` — the underlying cause
  on some setups is still being investigated.)
- **Controller focus ring** now shows on the "All POV" and in-game overlay
  buttons when navigating with a gamepad (previously the highlight only
  appeared with touch, though the buttons were still pressable).
- **Reaction counts** no longer briefly show one too many when you add or
  remove your own reaction.
- **Custom server emojis** now render inline in messages instead of showing
  their raw `:name:` code.
- **Notifications** are muted for the channel you have open in the fullscreen
  chat (messages only — call, stream and camera notifications still come
  through).
- **Fullscreen chat** no longer scrolls to the bottom while you are acting on
  a specific message (reacting, editing or deleting).

## 1.18.0 — 2026-07-23

### Added
- **In-game overlays** (new "In-game overlays" menu in the voice tab):
  - **Voice overlay** — a Discord-style roster (avatars, names, a green
    speaking halo, muted-mic badge) drawn over the running game via
    gamescope's overlay plane. Adjustable corner, opacity and size.
  - **POV overlay** — a real live video feed of up to 4 participants
    (screen/camera) over the game, in five layouts (all right/left stacked,
    all top/bottom in a row, or one per corner) with opacity and size.
- **Fullscreen multi-POV grid** — when people in a call have their camera or
  stream on, a button above the member list opens one fullscreen grid with
  every POV at once; press A on a tile to fullscreen just that one. Speaking
  and muted states are shown per tile, and connected non-streaming members
  appear as avatar tiles.
- **Quick-reply chat in the Quick Access panel** — the channel view in the
  QAM is interactive again: a navigable message list (links and photos open
  with A) plus a minimal composer to fire off a reply in seconds (Enter
  sends). Advanced actions (edit/delete, reactions, screenshot upload) stay
  exclusive to the fullscreen view, one button away. Drafts are shared
  between the QAM and the fullscreen chat.

### Fixed
- The in-game overlays now close automatically when you leave the voice call.
- Message rows in the QAM no longer log `Unhandled flow-children` errors on
  the current Steam client.

## 1.17.0 — 2026-07-23

### Added
- **Fullscreen chat view** (#20, suggested by @DavidNotProgamer2 with
  mockups): open any text channel or DM in a real fullscreen Steam modal —
  navigable history with pagination, reply composer, and a screenshot
  picker that browses recent screenshots across games instead of always
  sending the last one taken. The QAM panel shows a passive live preview
  with an "Open Chat" button.
- **Real-time messages**: new messages, edits, deletions and reactions in
  the channel you have open now arrive the second Discord receives them,
  pushed through the plugin's event pipeline — no more waiting for the next
  poll (polling remains only as a 20 s reconciliation safety net). A posted
  link's embed thumbnail also pops in as soon as Discord resolves it.
- **Typing indicator** both ways: see "X is typing…" live, and others see
  you typing while you compose.
- **Reactions, edit/delete, reply**: react with common emojis (or toggle
  existing reactions), edit or delete your own messages (two-step confirm),
  and reply to any message with the quoted context shown above it.
- **Author avatars** next to usernames in the conversation and in the QAM
  preview — fixed-size round thumbnails that never disturb the layout.
- **Reorder / hide servers in the text tab** — same mechanism as the voice
  tab, sharing the same preferences (hide or move a server once, both tabs
  follow). DMs are not affected.
- **Enter sends the message** from the composer, and an unsent draft now
  survives the modal closing — reopen the chat and your text is back.

### Fixed
- The conversation now opens anchored to the **latest** message at the
  bottom (like every chat app) and sticks to it as new messages arrive;
  controller navigation from the composer walks up from the newest message
  one by one. This took a few rounds of live testing to get right across
  Steam's gamepad navigation engine and Chromium's scroll anchoring.
- Message action chips (add-reaction "+", Reply, Edit, Delete) rendered
  with a zero-width flex basis, piling their labels on top of each other
  into an unreadable overlap.
- Messages flashing away and back every few seconds: a background poll
  returning transiently empty replaced the whole displayed history.
- `flow-children="horizontal"/"vertical"` is rejected by the current Steam
  client (only `row`/`column` and variants are accepted), which broke
  re-renders of dynamic rows — all occurrences migrated.
- Discord system events (member joins, boosts) no longer show as blank
  messages; history pages are filtered so "load older" keeps working.

## 1.16.9 — 2026-07-22

### Fixed
- Updater still failing with "Permission denied" on real installs after
  v1.16.8's diagnostics (#16) — traced to Decky Loader itself: it only keeps
  the plugin's top-level directory (and `plugin.json`) root-owned, while
  every other file gets chowned to the host user at install time. The
  tmp-file + `os.replace` dance from v1.16.1 needs to create a new entry in
  that directory before it can rename it into place, which needs directory
  write access — something a non-root backend never has there, regardless of
  who owns the files inside. When that fails, the updater now falls back to
  overwriting the destination file's content directly, which only needs
  write permission on the file itself (already granted by Decky) — covering
  essentially every file in a normal update. Only `plugin.json` or a
  genuinely brand-new top-level file added in some future release can still
  hit the wall, in which case the existing `chown -R` guidance still applies.

## 1.16.8 — 2026-07-22

### Changed
- Updater (#16): the SELinux/`restorecon` theory from v1.16.6 turned out to be
  incomplete — confirmed by reports from Steam Deck/Steam Machine (stock
  SteamOS, which has no SELinux at all) still hitting `Permission denied`
  even after the directory ownership was verified correct. Rather than guess
  a third fix blind, a `Permission denied` failure now logs the update
  process's actual uid/euid/groups and the target directory's owner/mode/
  `os.access(W_OK)` result at the moment it happens, so the next report gives
  a conclusive answer instead of another manual `ls -la` round-trip.

## 1.16.7 — 2026-07-21

### Fixed
- Plain-text messages (no link, no image) still weren't controller/keyboard
  nav stops after the v1.16.2 fix (#17) — only links and the "Load older
  messages" button were reachable with the stick/D-pad. The message list
  container was missing an explicit vertical flow hint, so a lone `Focusable`
  per message wasn't picked up as a stop by Steam's gamepad navigation unless
  something more "interactive" (a real button) was also present. Every
  message is now wrapped the same way as the rest of the panel's focusable
  rows, and picks up the same highlight (colored background + outline, text
  stays readable) when focused instead of vanishing with no visual feedback.

## 1.16.6 — 2026-07-20

### Fixed
- Updater still failing with "Permission denied" on some root-owned installs
  even after the v1.16.1 fix and a manual `chown -R` (#16). The atomic
  `os.replace` fix in v1.16.1 only ever addressed file *ownership*; on
  SELinux-enforcing systems (Bazzite/Fedora Atomic by default) a hierarchy
  created by a `sudo`-run install can also be *mislabeled* at the SELinux
  layer, which `chown` never touches. The updater now runs a best-effort
  `restorecon -R` over the plugin directory after every successful update to
  self-heal that labeling — a silent no-op on systems without SELinux
  (SteamOS, CachyOS/Arch, Debian/Ubuntu). If an update still fails, the error
  now also suggests `sudo restorecon -R` (only where SELinux is actually
  enforcing) alongside the existing `chown -R` hint, and calls out explicitly
  when the failure can't be an ownership issue because the plugin is already
  running as root.

## 1.16.5 — 2026-07-20

### Added
- **Reorder and hide servers** in the server/DM browser (#18). A new toggle
  reveals ↑/↓ and hide/unhide controls per server (kept out of the way by
  default); a "show hidden" button lets you bring hidden servers back. The
  order and hidden set are Steamcord's own local preferences — Discord's
  native drag-and-drop reorder doesn't actually persist across a client
  restart, so this is tracked separately and survives reconnecting. New
  servers you join always show up (appended after your custom order), and
  leaving a server never leaves a stale/broken entry behind.

## 1.16.4 — 2026-07-20

### Added
- **Soundboard** in the voice call view: browse and play the default sounds,
  the current server's sounds, and — with Nitro — sounds from every other
  server you've joined, same as the "soundboard everywhere" perk on the real
  client. Browsing/playing only, no sound management (upload/edit/delete
  stays server administration, out of scope here). You now hear your own
  sounds locally too, matching the real client's behavior.
- **Native Discord sound cues** for muting/unmuting, deafening/undeafening,
  disconnecting from a voice channel, and other participants joining or
  leaving the channel you're in. These reuse Discord's own bundled sounds
  (whatever soundpack you have selected — classic, seasonal, etc.) instead of
  shipping separate audio files.

### Fixed
- Soundboard tiles rendered as a plain full-width list instead of a compact
  grid, and playing a sound could kick the controller focus out of the panel
  entirely. A very similar focus loss also happened whenever another
  participant's mic activity flickered on/off, even without touching the
  soundboard at all. All three turned out to share the same root cause —
  controller-focused elements being torn down and rebuilt by the UI on
  re-renders that had nothing to do with them — and are fixed together.
- The new join/leave sound cue above could trigger randomly while **not even
  in a voice channel**: voice-state updates are broadcast for any mutual
  friend's voice activity anywhere, and a friend leaving a call elsewhere
  reports no channel — which was matching "no channel" on our own side too.

## 1.16.2 — 2026-07-20

### Fixed
- **Impossible to read past the last 30 messages in a channel/DM, and
  keyboard/controller navigation only stopped on messages containing a link**
  (#17). Two separate issues: only the most recent 30 messages were ever
  fetched, with no way to reach anything older; and plain-text messages had no
  focusable element at all, so D-pad/keyboard navigation (which drives
  Steam's scroll-follows-focus behavior) skipped straight to the next message
  that had a link or image. Every message is now itself a focus stop, and a
  "Load older messages" button appears at the top of the list once there's
  more history to fetch, paging backwards through the conversation.
- The 5 s background refresh no longer snaps the view back to the bottom
  while reading older history — it just doesn't discard messages loaded that
  way — and it no longer wipes the whole conversation from view if a single
  refresh happens to fail.

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
  @DavidNotProgamer2 right after the v1.15.0 release (#8).
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
  live. Reported by @DavidNotProgamer2 with meticulous multi-account
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
