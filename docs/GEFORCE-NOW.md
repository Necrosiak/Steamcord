# GeForce NOW game activity (experimental)

Steamcord can replace the GeForce NOW launcher name with the game title in your Discord activity. Enable game detection in Settings. A manual game title always takes priority.

## Supported path

- Steam must report the running shortcut as **GeForce NOW** or **NVIDIA GeForce NOW**.
- Use the native GeForce NOW client. On Linux, its window must be readable through X11/XWayland; `xprop` is required and `xwininfo` supplies a fallback for Gamescope. Steamcord does not install system tools or desktop extensions.
- On Windows, Steamcord reads visible windows owned by the native client.
- If no game can be identified, or multiple titles disagree, the Steam launcher name is kept. Leaving a game does not retain a cached title.

Browser sessions, custom shortcut names and native Wayland windows invisible to X11 are not covered. Use the manual game title for those cases.

## Validation limits

Automated tests cover game changes, lobby/error states, Unicode titles, ownership filters, unavailable displays, manual overrides and offline Discord metadata. Isolated X11 window tests passed. Windows compatibility tests passed, but visible-window validation could not be completed from an SSH Session 0 fixture. A real GeForce NOW session still needs to be confirmed; this is experimental.

## Research

The native window-title signal was studied in [KarmaDevz's Windows detector](https://github.com/KarmaDevz/GeForce-NOW-Rich-Presence) and [Josh McKinney's Linux detector](https://github.com/joshmckinney/geforcenow-presence). Steamcord uses its own implementation and existing Rich Presence path. No external detector, browser cookies or dummy executable are needed.
