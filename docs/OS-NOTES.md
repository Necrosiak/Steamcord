# OS notes — Steamcord on any Linux distribution

Steamcord ships **one build for every Linux distro**. Everything external is
detected at runtime; when something is missing, the QAM shows the **exact
install command for the package manager it detected** (pacman / rpm-ostree /
dnf / zypper / apt). This page sums up the system pieces each feature uses.

Base requirements: **Steam + [Decky Loader](https://decky.xyz/)**, a systemd
user session and PipeWire audio — i.e. any modern distro able to run Steam in
Gaming Mode / Big Picture.

## Required system tools

Steamcord itself is self-contained (its Python dependencies are vendored), but
some features shell out to standard tools. **None of them are mandatory** — the
plugin starts and Discord voice/chat work without any of them; each missing tool
only costs the feature next to it.

| Tool | Needed for | Usually shipped by |
|---|---|---|
| `pw-dump` | finding the screen/audio PipeWire nodes (screen share, game audio) | `pipewire-utils` / `pipewire` |
| `pactl` | game audio sharing (virtual sinks + mic mixing) | `pipewire-pulse` / `libpulse` |
| `ffmpeg` | screen-share preview (fallback path) | `ffmpeg` |
| `gamescopectl` | screen-share preview in Game Mode (fallback path) | `gamescope` |
| `flatpak` | installing/running Vesktop as a flatpak (not needed with a native `vesktop`) | `flatpak` |
| `systemctl`, `systemd-run` | launching Vesktop in its own user unit | systemd |

At startup the backend logs a single `[deps]` line naming exactly which of these
are missing and what each one costs, so you never have to guess from a stack
trace. `pgrep`/`pkill` (procps) used to be required too — they no longer are, the
plugin reads `/proc` directly.

**PATH:** the backend is started by Decky's *system* service, so it inherits
systemd's minimal `PATH`. Steamcord appends the Nix, Guix, `~/.local/bin` and
usual `/usr` locations to it at startup, which is what makes the tools above
resolve on distros that put nothing in `/usr/bin` (NixOS in particular). You do
not need to configure anything for this.

## Vesktop (the Discord client driven by Steamcord)

Resolved automatically, in this order:

1. **Vesktop flatpak already installed** → used as-is (your session is kept);
2. **native `vesktop` binary** in `PATH` (e.g. the AUR package on
   Arch/CachyOS) → used directly;
3. **flatpak available** → Vesktop is installed silently (user-level, from
   Flathub) on first run;
4. none of the above → the QAM explains what to install instead of hanging
   on "Initializing".

So on a distro without flatpak, either install flatpak
(`sudo pacman -S flatpak`, `sudo apt install flatpak`, …) or the native
vesktop package.

## Screen share in Game Mode (native Go Live)

gamescope has no screen-cast portal, so Steamcord ships its own: the backend
runs `portal_shim.py`, a tiny `org.freedesktop.portal.ScreenCast` service that
auto-approves capture requests with the gamescope PipeWire node (the one Steam
Game Recording uses). The regular **Go Live** button therefore works natively
in Game Mode — full resolution, game audio via venmic, no kernel module, no
rootfs writes (survives SteamOS A/B updates). It needs nothing beyond what
every gamescope-capable distro already has: PipeWire, D-Bus and `pw-dump`.

In Desktop Mode the shim steps aside automatically (releases the portal name)
so the desktop's own portal keeps handling screen shares. If no portal answers
at all, Steamcord falls back to the local GStreamer WebRTC relay, and the
virtual-camera button below remains as a last-resort manual path.

## Screen-share camera (Game Mode, legacy fallback)

The **virtual camera** path: the `v4l2loopback` kernel module must exist and be
loaded with the right options.

Package:

| Distro | Command |
|---|---|
| Arch / CachyOS | `sudo pacman -S v4l2loopback-dkms` |
| Fedora | `sudo dnf install v4l2loopback` (RPM Fusion: `akmod-v4l2loopback`) |
| Bazzite | preinstalled |
| Debian / Ubuntu | `sudo apt install v4l2loopback-dkms` |
| openSUSE | `sudo zypper install v4l2loopback` |
| Gentoo | `sudo emerge media-video/v4l2loopback` |
| Void | `sudo xbps-install -S v4l2loopback` |
| Alpine | `sudo apk add v4l2loopback-dkms` |
| NixOS | declarative, see below |

On NixOS the module is not a user package — put it in `configuration.nix`
instead of running `modprobe`, and the options below replace the
`/etc/modprobe.d` file:

```nix
boot.extraModulePackages = [ config.boot.kernelPackages.v4l2loopback ];
boot.kernelModules = [ "v4l2loopback" ];
boot.extraModprobeConfig = ''
  options v4l2loopback exclusive_caps=1 card_label="Steamcord Screen" video_nr=42
'';
```

Configuration (one-time, then reboot or `sudo modprobe v4l2loopback`):

```bash
# /etc/modprobe.d/v4l2loopback.conf
options v4l2loopback exclusive_caps=1 card_label="Steamcord Screen" video_nr=42
# /etc/modules-load.d/v4l2loopback.conf
v4l2loopback
```

The Screen camera button checks all of this and tells you which step is
missing (module not installed vs installed-but-not-loaded).

## GStreamer bindings (capture pipeline)

The capture feeder runs on the **system python** and needs the GObject
bindings + the PipeWire GStreamer plugin (present on Bazzite, not on stock
Arch/Fedora/Debian):

| Distro | Command |
|---|---|
| Arch / CachyOS | `sudo pacman -S python-gobject gst-plugin-pipewire` |
| Fedora | `sudo dnf install python3-gobject pipewire-gstreamer` |
| Bazzite | preinstalled |
| Debian / Ubuntu | `sudo apt install python3-gi gir1.2-gstreamer-1.0 gstreamer1.0-pipewire` |
| openSUSE | `sudo zypper install python3-gobject gstreamer-plugin-pipewire` |
| Gentoo | `sudo emerge dev-python/pygobject media-plugins/gst-plugins-pipewire` |
| Void | `sudo xbps-install -S python3-gobject gst-plugins-base1 pipewire` |
| Alpine | `sudo apk add py3-gobject3 gst-plugins-base pipewire` |
| NixOS | see below |

**If these are missing, the preview still works**: Steamcord falls back to
`gamescopectl` + `ffmpeg`, which needs no Python bindings at all. Only bother
with this section if that fallback is unavailable too.

## NixOS

Nothing in Steamcord is Nix-hostile, but two NixOS traits need saying:

1. **Nothing lives in `/usr/bin`.** Steamcord adds `/run/current-system/sw/bin`,
   `/run/wrappers/bin` and the Nix profiles to its `PATH` automatically, so
   `pw-dump`, `pactl`, `ffmpeg` and `gamescopectl` are found as long as they are
   in `environment.systemPackages`. Before this was handled, they simply raised
   `FileNotFoundError` and screen sharing/preview died silently
   ([#29](https://github.com/Necrosiak/Steamcord/issues/29)).
2. **`pygobject3` alone will not work.** A plain `python3` cannot import `gi`
   from a sibling package — the interpreter itself has to carry it:

```nix
environment.systemPackages = with pkgs; [
  # tools Steamcord shells out to
  pipewire            # pw-dump
  ffmpeg              # preview fallback
  gamescope           # gamescopectl
  vesktop             # native Vesktop, so flatpak is not needed

  # only for the GStreamer preview path (optional, see the note above)
  (python3.withPackages (ps: with ps; [ pygobject3 ]))
  gst_all_1.gstreamer
  gst_all_1.gst-plugins-base
  gst_all_1.gst-plugins-good
];
```

With `vesktop` in `systemPackages`, Steamcord picks the native binary and never
touches flatpak.

## Gentoo, Alpine, Void and other manual distros

These are supported by the same detection: Steamcord looks for what exists at
runtime and reports what it could not find. The QAM shows the install command
for the package manager it detected — `emerge`, `apk`, `xbps-install` and
`nixos-rebuild` are recognised alongside pacman/dnf/apt/zypper. If the command
it suggests is wrong for your distro, that is a bug worth reporting.

---

Something missing for your distro?
[Open an issue](https://github.com/Necrosiak/Steamcord/issues) — reports from
non-Bazzite systems are exactly what makes this page grow.
