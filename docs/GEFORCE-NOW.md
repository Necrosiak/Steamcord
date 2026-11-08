# GeForce NOW game activity (experimental)

Steamcord can replace the GeForce NOW launcher name with the game title in your Discord activity. Enable game detection in Settings. A manual game title always takes priority.

## Supported path

- Steam must report the running shortcut as **GeForce NOW** or **NVIDIA GeForce NOW**.
- Use the native GeForce NOW client. On Linux, its window must be readable through X11/XWayland; `xprop` is required and `xwininfo` supplies a fallback for Gamescope. Steamcord does not install system tools or desktop extensions.
- On Windows, Steamcord reads visible windows owned by the native client.
- If no game can be identified, or multiple titles disagree, the Steam launcher name is kept. Leaving a game does not retain a cached title.

Browser sessions, custom shortcut names and native Wayland windows invisible to X11 are not covered. Use the manual game title for those cases.

## Troubleshooting

While GeForce NOW is running, open Steamcord Settings and press **Game detection diagnostics**. This is available in both the Quick Access panel and the expanded view on Windows and Linux. The report records the Steamcord version, Linux distribution/version or Windows version/build, whether game detection is enabled, and the detector's result. It does not include game titles, executable paths or account information. It is also written to the Steamcord log with the `[game-diagnostic]` prefix.

`not_running` means the native client process was not found. `unavailable` means its windows could not be queried. `no_game` means no supported game title was identified; `ambiguous` means several windows gave different game titles. `not_gfn` can occur when Steam reports a custom shortcut name. A `detected` result confirms a title was read; it does not by itself confirm that Discord displayed it.

## Validation limits

Automated tests cover game changes, lobby/error states, Unicode titles, ownership filters, unavailable displays, manual overrides and offline Discord metadata. Isolated X11 window tests passed. Windows compatibility tests passed, but visible-window validation could not be completed from an SSH Session 0 fixture. A real GeForce NOW session still needs to be confirmed; this is experimental.

## Research

The native window-title signal was studied in [KarmaDevz's Windows detector](https://github.com/KarmaDevz/GeForce-NOW-Rich-Presence) and [Josh McKinney's Linux detector](https://github.com/joshmckinney/geforcenow-presence). Steamcord uses its own implementation and existing Rich Presence path. No external detector, browser cookies or dummy executable are needed.
