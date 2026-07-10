# OS notes — Steamcord on any Linux distribution

Steamcord ships **one build for every Linux distro**. Everything external is
detected at runtime; when something is missing, the QAM shows the **exact
install command for the package manager it detected** (pacman / rpm-ostree /
dnf / zypper / apt). This page sums up the system pieces each feature uses.

Base requirements: **Steam + [Decky Loader](https://decky.xyz/)**, a systemd
user session and PipeWire audio — i.e. any modern distro able to run Steam in
Gaming Mode / Big Picture.

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

## Screen-share camera (Game Mode)

gamescope has no screen-cast portal, so Steamcord streams the screen through
a **virtual camera**: the `v4l2loopback` kernel module must exist and be
loaded with the right options.

Package:

| Distro | Command |
|---|---|
| Arch / CachyOS | `sudo pacman -S v4l2loopback-dkms` |
| Fedora | `sudo dnf install v4l2loopback` (RPM Fusion: `akmod-v4l2loopback`) |
| Bazzite | preinstalled |
| Debian / Ubuntu | `sudo apt install v4l2loopback-dkms` |
| openSUSE | `sudo zypper install v4l2loopback` |

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

---

Something missing for your distro?
[Open an issue](https://github.com/Necrosiak/Steamcord/issues) — reports from
non-Bazzite systems are exactly what makes this page grow.
