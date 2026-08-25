# Community bug hunters

People who reported, diagnosed or helped fix bugs in Steamcord — thank you!

A report that says *what* broke is useful. Most of the entries below went
further: the log line that pointed at the real cause, the detail that ruled out
the obvious explanation, the follow-up test after a fix that was not quite
right. Several of these releases exist because somebody insisted something was
still broken.

If you reported something and are not listed here, that is an oversight — please
say so on an [issue](https://github.com/Necrosiak/Steamcord/issues).

---

### [@DavidNotProgamer2](https://github.com/DavidNotProgamer2)

- The untranslated screen-share hint and the chat-style look of Decky notifications ([#2](https://github.com/Necrosiak/Steamcord/issues/2), addressed in v1.14.0)
- Diagnosis of the screen wake-lock, with volume-mixer evidence ([#3](https://github.com/Necrosiak/Steamcord/issues/3))
- The green incoming video, the vanishing Watch button and the volume-slider reset ([#5](https://github.com/Necrosiak/Steamcord/issues/5), addressed in v1.14.2)
- The shutdown-hang bisect ([#7](https://github.com/Necrosiak/Steamcord/issues/7), fixed in v1.14.5)
- Incoming streams missing in group and server voice channels, and the mirrored second stream ([#8](https://github.com/Necrosiak/Steamcord/issues/8), addressed in v1.14.4 and v1.14.5)
- Detailed repro of the rapid Go Live toggle breakage and the stuck stream preview on stock SteamOS ([#12](https://github.com/Necrosiak/Steamcord/issues/12), fixed in v1.16.0)
- The phantom volume changes and the mic/keybind/audio settings bugs ([#13](https://github.com/Necrosiak/Steamcord/issues/13), [#14](https://github.com/Necrosiak/Steamcord/issues/14), fixed in v1.16.1)
- The post-`chown` `ls -la` on the updater permission bug, showing exactly which files and directories stayed root-owned — which pinned down the real cause ([#16](https://github.com/Necrosiak/Steamcord/issues/16), fixed in v1.16.9)
- The fullscreen chat concept with hand-drawn mockups — passive live preview in the QAM, a real navigable fullscreen view with auto-follow — and the live testing that shaped it ([#20](https://github.com/Necrosiak/Steamcord/issues/20), shipped in v1.17.0)
- Phantom reaction counts, unrendered custom server emojis and per-channel fullscreen notification behaviour ([#21](https://github.com/Necrosiak/Steamcord/issues/21))
- Persistence on the fullscreen scroll and the randomly slow messages — insisting both were still broken after v1.18.1, which uncovered that the live feed was being switched off underneath the fullscreen view ([#21](https://github.com/Necrosiak/Steamcord/issues/21), fixed in v1.18.4)
- The suggestion that ended the jump-to-latest saga: replace the button with a controller shortcut that puts the selection back on the composer — then spotting that going back up landed one message short ([#21](https://github.com/Necrosiak/Steamcord/issues/21), shipped in v1.19.0)
- The v1.18.0 feedback that shaped v1.18.1 — the in-game overlay toggle not persisting and the missing controller focus ring ([#22](https://github.com/Necrosiak/Steamcord/issues/22))
- The `[overlay]` logs that pinned down the dead in-game overlays — first a missing WebKit2 4.1 binding, then, when that was not enough, SteamOS shipping no WebKitGTK binding at all, which is what led to the web-engine-free overlay renderer — plus the speaking ring hidden behind portrait streams ([#22](https://github.com/Necrosiak/Steamcord/issues/22), fixed in v1.18.3)
- The very first message notification never popping ([#23](https://github.com/Necrosiak/Steamcord/issues/23), fixed in v1.19.0)
- Only one screen share showing at a time ([#24](https://github.com/Necrosiak/Steamcord/issues/24), fixed in v1.19.0)

### [@Matchaccia](https://github.com/Matchaccia)

- Screen sharing refusing to restart until a full shutdown — with the key detail that a reboot was not always enough while a full power cycle always was, which pointed at leaked PipeWire connections rather than a Discord-side problem ([#26](https://github.com/Necrosiak/Steamcord/issues/26), fixed in v1.20.0)
- The screenshot picker hiding the most recent screenshots ([#27](https://github.com/Necrosiak/Steamcord/issues/27), fixed in v1.20.0)
- The server list failing with a raw Python exception ([#28](https://github.com/Necrosiak/Steamcord/issues/28), fixed in v1.20.0)

### [@humzakh](https://github.com/humzakh)

- The in-plugin updater failing on root-owned installs, including the chmod/chown attempts and the follow-up reports across several fix attempts, which eventually pinned down the real cause ([#16](https://github.com/Necrosiak/Steamcord/issues/16), properly fixed in v1.18.2)
- Broken message-list navigation and missing conversation history ([#17](https://github.com/Necrosiak/Steamcord/issues/17), fixed in v1.16.2)

### [@Strix-Vyxlor](https://github.com/Strix-Vyxlor)

- The first NixOS report, with the log excerpts and the decisive detail that the stream worked while the preview did not — which identified the truncated service `PATH` rather than a missing package — plus the request for an explicit dependency list ([#29](https://github.com/Necrosiak/Steamcord/issues/29), fixed in v1.21.0)

### [@Havok027](https://github.com/Havok027)

- The screen randomly dimming as if the game had gone to the background, on a Legion Go S, and the follow-up suggestion of letting people choose which notifications come through while playing — which is what shaped the setting ([#25](https://github.com/Necrosiak/Steamcord/issues/25), setting added in v1.20.0)
- The request that became clip sending: he was exporting gameplay clips to his phone just to post them to Discord ([#40](https://github.com/Necrosiak/Steamcord/issues/40), added in v1.27.0)

### [@william097y](https://github.com/william097y)

- Games appearing in Discord without their Rich Presence artwork, with the observation that the affected titles all carried a `™` — which pointed at Steam and Discord spelling the same game differently — and the follow-up test on a title with no `™`, widening the cause to typographic punctuation in general ([#32](https://github.com/Necrosiak/Steamcord/issues/32), fixed in v1.21.1)
- His report deserved better than it got: the fix written for it in v1.21.1 landed in a `case` that could never be reached, so it did nothing until v1.26.0. The diagnosis was right all along — the code just never ran ([#41](https://github.com/Necrosiak/Steamcord/issues/41))

### [@theconker64](https://github.com/theconker64)

- Report and diagnosis of the `segno` boot crash on stock SteamOS ([#1](https://github.com/Necrosiak/Steamcord/issues/1), fixed in v1.8.2)

### [@V3lvetStorm](https://github.com/V3lvetStorm)

- Confirmation and testing ([#1](https://github.com/Necrosiak/Steamcord/issues/1))

### [@TheRealScrumby](https://github.com/TheRealScrumby)

- The dead fullscreen-login button ([#6](https://github.com/Necrosiak/Steamcord/issues/6), fixed in v1.14.3)

### [@StarlightAzu](https://github.com/StarlightAzu)

- The v4l2loopback hint whose command silently did nothing ([#9](https://github.com/Necrosiak/Steamcord/issues/9), fixed in v1.14.6)

### [@hrhnick](https://github.com/hrhnick)

- Suggestion to switch the UI to monochrome SVG icons so the plugin blends into SteamOS ([#15](https://github.com/Necrosiak/Steamcord/issues/15), done in v1.16.1)

### [@jafuuu](https://github.com/jafuuu)

- Spotted that the game Rich Presence was missing entirely ([#11](https://github.com/Necrosiak/Steamcord/issues/11), added in v1.16.0)

### [@bastiHST90](https://github.com/bastiHST90)

- The battery drain, with the measurement that made it actionable: idle power identical with and without the plugin once v1.23.0 landed, against a Vesktop sitting at 20–30% CPU before it ([#36](https://github.com/Necrosiak/Steamcord/issues/36), fixed in v1.23.0)

### [@zomars](https://github.com/zomars)

- The silently looping QR login — traced all the way to the page-level hCaptcha, with the page text and the exact `get_state` payload showing `captcha_needed` stuck at `false`, and the observation that the README promised a fullscreen CAPTCHA fallback the plugin no longer had ([#37](https://github.com/Necrosiak/Steamcord/issues/37), fixed in v1.24.0)

### [@EasyAs123ABC](https://github.com/EasyAs123ABC)

- The screenshot that exposed the portal shim refusing every interface it does not implement, to every application in the session — the error named Steamcord outright, and he was right to suspect it was not Sober's fault ([#39](https://github.com/Necrosiak/Steamcord/issues/39), fixed in v1.24.0)

### [@immortalt](https://github.com/immortalt)

- The write-up that took screen sharing apart on an ASUS ROG Xbox Ally, after the first report had nothing to act on ([#38](https://github.com/Necrosiak/Steamcord/issues/38)). He had already uninstalled Steamcord and lost his logs, and reconstructed the diagnosis from memory anyway: the missing `gst-plugins-bad`, the PyInstaller `LD_LIBRARY_PATH`/`LD_PRELOAD` leaking into the GStreamer child, and — the one that mattered — the timed-out portal session still holding the gamescope node, proven by killing `portal_shim.py` and watching the fallback start instantly. He also ruled out the part that was *not* our bug: identical frame hashes on the XWayland root window across a page turn, differing hashes on the game's own window, with the official Discord client showing the same stale picture.

### [@imrprogamer](https://github.com/imrprogamer)

- The side-by-side comparison of Rich Presence in Gaming Mode against Desktop Mode, with screenshots of each case ([#41](https://github.com/Necrosiak/Steamcord/issues/41)). Reporting that a game launched from Heroic showed up as "Heroic", that a non-Steam shortcut got its name but no artwork, and that the same setup behaved differently in Desktop Mode, is what exposed a duplicated `switch` branch that had silently disabled the artwork matching since v1.16.0 — and prompted detecting games by their executable, the way the official client does.
- Then he tested the fix the same day and caught two things wrong with it: an unrelated background program could take over the status, and games started inside a launcher were still missed. He also found that the play timer never restarted, which no one had noticed in ten releases ([#41](https://github.com/Necrosiak/Steamcord/issues/41), fixed in v1.26.1 and v1.27.0)

### [@ZyreonX](https://github.com/ZyreonX)

- The Go Live failure on an ASUS ROG Xbox Ally under Bazzite 44, with the full backend log attached ([#42](https://github.com/Necrosiak/Steamcord/issues/42)). The traceback in it pinned an `AttributeError` that had been reachable from the Desktop Mode fallback the whole time, and the log line numbers confirmed which release it came from. His answer to the follow-up ruled out the worse hypothesis — that Gaming Mode was dropping him on its own — and his second log showed the capture starting while Discord never published the stream, which is what prompted logging that half of Go Live at all.

---

# Code contributions

### [@jezonek](https://github.com/jezonek)

- Push-to-talk on a keyboard key or a mouse button ([#34](https://github.com/Necrosiak/Steamcord/pull/34)) — the backend evdev reader, its privacy constraints and the config migration. Along the way he found and fixed two pre-existing bugs nobody had reported: holding a controller button and a key at once cut the mic when either was released, and saving the voice shortcut silently dropped unrelated settings.
