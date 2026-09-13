# Working on Steamcord

Notes for anyone — human or agent — touching this repository. Everything here
was learned the hard way, usually from a bug that shipped. None of it is
guessable from the code.

## Ground rule

**No commit, no push, no tag, no release without the maintainer's explicit go.**
Not "it builds", not "the tests pass", not "you said to do the whole thing" — an
explicit yes, given after seeing the result. Working in the tree is expected;
publishing is not.

## Deploying and reloading

```bash
sudo steamcord-deploy       # passwordless, canonical, reloads backend AND frontend
```

Close and reopen the Quick Access Menu afterwards. That is all it takes.

⛔ **Never restart the gamescope session** (`gamescope-session-plus@*.service`)
to reload the plugin. It kills the running game and drops the user out of their
voice call. The deploy script is enough.

⚠️ The installed layout is **flat**: `decky plugin build` promotes the *contents*
of `defaults/` to the plugin root. There is no `defaults/` directory in a real
install, so no code path may depend on one.

## What Decky lets a plugin write

Measured on a real install:

```
plugin top-level directory   root:root       → creating an entry: DENIED
plugin.json                  root:root       → writing: DENIED
everything else inside       user-owned      → overwriting: OK
subdirectories               user-owned      → creating inside: OK
```

So the updater can overwrite existing files but cannot add a new top-level one.
`updater.py` surveys the release **before** writing anything: a code file it
cannot write cancels the update untouched, while docs, licences and
`plugin.json` are skipped and the update proceeds. Do not turn that back into a
write-as-you-go loop — a half-applied update is worse than none.

⛔ **Do not delegate installs to `DeckyBackend.call('utilities/install_plugin')`.**
That is the Decky *Store* route: after unpacking it reports the install to
`plugins.deckbrew.xyz`, which does not know a self-distributed plugin, and the
request 404s. The flow then stops: files written, plugin never reloaded, and a
confirmation dialog frozen over the Steam UI. It also leaves the whole plugin
directory root-owned.

## Audio (PipeWire / PulseAudio)

- **Every `pactl` spawned from the backend needs `env=vesktop._user_env()`.** The
  backend is a child of the PyInstaller loader, which points `LD_LIBRARY_PATH`
  at its own libraries; without that env the command dies instantly. Send
  `stderr` to the log, never to `/dev/null` — a silent death reads as "found
  nothing".
- **`pactl subscribe` output is localised** (`Événement « nouveau » sur source #N`).
  Force `LC_ALL=C` rather than matching translated verbs.
- **Never poll `pactl` in a tight loop.** When a PipeWire client hangs, every
  call takes 5 s to time out and the calls pile up — a 0.5 s watcher once cost
  28 s on a Go Live and made the wedge it was waiting on worse. Subscribe to
  events instead.
- **Route streams before creating your own loopbacks.** A freshly created
  sink-input does not have its final properties yet, so it cannot be spared by
  name. Ours are tagged `sink_input_properties=media.name=steamcord-bridge`.

### Go Live audio, in one picture

```
game playback  → steamcord_share_sink → steamcord_share → Vesktop's Go Live track
microphone     → Vesktop's normal voice track
Vesktop output → the real output device (never enters the captured sink)
```

`steamcord_share` is a `module-remap-source` whose **`device.description` is
exactly `vencord-screen-share`**. That string is not cosmetic: Vesktop resolves
the share's audio device with

```js
devices.find(({ label }) => label === "vencord-screen-share")
```

an exact match on the label, which for a Pulse source is its description. Change
it and the Go Live silently loses its audio track.

Two consequences worth keeping in mind:

- **Only one device may carry that label.** venmic creates a node with the same
  name, so the modal is deliberately left on "None" and venmic is never started.
  With two candidates the lookup picks whichever Chromium returns first, and when
  it picks the wrong one Chromium falls back to the default input — the
  microphone. The result is the user's voice sent twice and no game audio.
- **The Go Live capture must be spared by every routing helper.** Vesktop opens
  a second `RecordStream` carrying `target.object=steamcord_share`, and PipeWire
  may still place it on the default source. `_golive_route_stream_audio()` moves
  it where it belongs; anything else that moves Vesktop captures must skip it
  via `_is_golive_capture_output()`, or it will drag the share back onto the
  microphone. This bites in practice when a headset is plugged in mid-share.

## Notifications

Use the local `notify()` helper (`SteamClient.ClientNotifications`), never
`toaster.toast`. The Decky toaster creates entries without `notification_type`
which do not appear and can crash the Steam notification panel on this build. A
`steamid` is mandatory; without one the entry is malformed.

## Testing backend code without Decky

`main.py` cannot be imported directly. Parse it and execute only the functions
under test:

```python
tree = ast.parse(open("main.py").read())
picked = [n for n in tree.body if getattr(n, "name", None) in WANTED]
exec(compile(ast.Module(body=picked, type_ignores=[]), "main.py", "exec"), ns)
```

`sys.path` needs `<repo>/defaults`, plus a stub `decky` module.

## Two file-level traps

- **`src/index.tsx` uses CRLF.** Rewriting it with a script that emits LF
  produces a 3700-line phantom diff. Preserve the line endings.
- Translated READMEs live in `docs/`. Nine languages; a user-visible change
  belongs in all of them.
