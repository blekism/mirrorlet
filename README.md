# Mirrorlet

Mirror an iPhone screen (with sound) to a Windows 10/11 PC over Wi-Fi. Built and tested against
an **iPhone X on iOS 16.7.x**, and it should work with any iPhone that has Screen Mirroring.

Mirrorlet is an Electron control panel around **[UxPlay](https://github.com/FDH2/UxPlay)**, an
open-source AirPlay mirroring receiver. The iPhone thinks it's talking to an Apple TV. UxPlay decodes
the stream and shows it in its own window, and Mirrorlet starts and stops UxPlay, configures it, watches
its output to show status, and checks your network.

```
iPhone ──AirPlay (Wi-Fi)──▶ uxplay.exe ──▶ mirror window (Direct3D 11, GPU-decoded H.264)
                                ▲
                Mirrorlet (Electron): settings, status, firewall/network checks, tray
```

---

## 1. Get the installer (GitHub builds it for you)

Building UxPlay needs MSYS2, a C compiler and about 40 GStreamer and FFmpeg libraries. The included
workflow has GitHub's Windows machines do all of that, so your PC doesn't need any of it.

1. Create a new **empty** repo on GitHub (private is fine), then push this folder:
   ```powershell
   cd mirrorlet
   git init
   git add .
   git commit -m "Mirrorlet"
   git branch -M main
   git remote add origin https://github.com/<you>/mirrorlet.git
   git push -u origin main
   ```
2. Open the repo's **Actions** tab and wait for **Build Windows installer** to finish (~10–15 min the
   first time, faster afterwards thanks to caching).
3. Open the finished run. Under **Artifacts**, download **Mirrorlet-Setup** and unzip it to get
   `Mirrorlet Setup 1.0.0.exe`.
4. Run it. Windows SmartScreen will say *"Windows protected your PC"* because the installer isn't
   code-signed. Click **More info → Run anyway**. Approve the admin prompt; the installer uses it to
   add the firewall rule (see below).

To publish a proper release instead, push a tag (`git tag v1.0.0 && git push --tags`). The same
workflow then attaches the installer to a GitHub Release.

**What the workflow does** (`.github/workflows/build-windows.yml`):

| Step | Why |
|---|---|
| `msys2/setup-msys2` + package list | UxPlay's only supported Windows toolchain is MSYS2/MinGW-64. GStreamer and FFmpeg come prebuilt from MSYS2. |
| `scripts/build-uxplay.sh` | Compiles UxPlay at a pinned commit, then copies `uxplay.exe`, the GStreamer plugins it uses and every DLL they need (found with `ldd`) into `vendor/uxplay`. |
| `scripts/verify-bundle.ps1` | Runs the bundle with MSYS2 **removed from PATH** and checks that all 25 GStreamer elements load. This catches a missing DLL here instead of on your PC. |
| `npm test` | Unit tests for the argument builder and log parser. |
| `npm run dist` | electron-builder packs the app plus `vendor/uxplay` into an NSIS installer. |

## 2. Use it

1. Open **Mirrorlet**. The receiver starts automatically and the status shows *Ready — waiting for iPhone*.
2. On the iPhone X: swipe down from the **top-right corner** → **Screen Mirroring** → **Mirrorlet PC**.
3. A window opens with your screen in it. To stop, tap **Stop Mirroring** on the phone.

The **Network check** card flags the two usual reasons an iPhone can't find the PC:

- **Your Wi-Fi is set to "Public".** Windows then blocks the local discovery traffic AirPlay uses.
  Click *Open network settings* → your Wi-Fi → **Private network**.
- **There's no firewall rule.** The installer adds one. If it's missing, click
  *Allow through firewall* (you'll get an admin prompt).

### Settings, and the UxPlay flag behind each one

| Setting | UxPlay flag | Notes |
|---|---|---|
| Name shown on iPhone | `-n <name> -nh` | `-nh` stops UxPlay from adding `@hostname` to the name. |
| Quality 720p/1080p/1440p | `-s WxH@fps` | The iPhone X screen is 1125×2436, so **1080p** is the sweet spot. 1440p mostly adds network load. |
| Frame rate | `-fps 30\|60` | iPhone X can send 60 fps. Choose 30 on weak Wi-Fi. |
| Play sound on PC | `-as 0` when off | |
| Full screen | `-fs` | |
| Rotate picture | `-r L\|R` | For a phone stand that holds the phone sideways. |
| Lowest lag | `-vsync no` | Shows frames as soon as they arrive. Audio may drift slightly. |
| New iPhone takes over | `-nohold` | Otherwise a second phone has to wait. |
| Require 4-digit code | `-pin NNNN` | The iPhone asks for the code the first time, then remembers this PC. |
| Record to MP4 | `-mp4 <file>` | Saved to your Videos folder by default. |
| Software decoding (Advanced) | `-avdec` | Use this only if the picture is black or green: it means hardware (D3D11) decoding isn't working with your GPU driver. |

Mirrorlet also always passes `-key <AppData>\Mirrorlet\airplay-server-key.pem`. That keeps the PC's
AirPlay identity the same across restarts, so the iPhone treats it as the same device instead of a
new one every launch.

## 3. Build locally (optional)

Do this only if you want to change the code and test it without pushing.

1. Install [MSYS2](https://www.msys2.org), open **MSYS2 UCRT64**, then run:
   ```bash
   pacman -Syu   # restart the shell if it asks, then run again
   pacman -S --needed git mingw-w64-ucrt-x86_64-{gcc,cmake,ninja,pkgconf,openssl,libplist,gstreamer,gst-plugins-base,gst-plugins-good,gst-plugins-bad,gst-libav,pango}
   cd /c/path/to/mirrorlet
   bash scripts/build-uxplay.sh
   ```
2. In normal PowerShell:
   ```powershell
   ./scripts/verify-bundle.ps1   # optional sanity check
   npm install
   npm start                     # run in dev mode, using vendor/uxplay
   npm run dist                  # build dist/Mirrorlet Setup x.y.z.exe
   ```

## Project layout

```
src/main.js           Electron main: starts/stops uxplay.exe, sets GStreamer env vars, tray, IPC
src/uxplay-args.js    settings → UxPlay command-line flags (pure, unit-tested)
src/log-parser.js     UxPlay output → idle / connecting / mirroring + errors (pure, unit-tested)
src/windows-net.js    Public-network and firewall checks; elevated firewall fix
src/preload.js        the small, typed bridge the UI is allowed to call
src/renderer/         UI (plain HTML/CSS/JS, strict CSP, no Node access)
scripts/              UxPlay build and bundle verification
build/installer.nsh   adds/removes the Windows Firewall rule during install/uninstall
```

## Design choices

- **Wrap UxPlay, don't rewrite AirPlay.** AirPlay mirroring needs Apple's FairPlay key exchange,
  encrypted H.264 over RTP and timing sync. UxPlay has handled all of this for years and supports
  iOS 9 through 18. Reimplementing it in Node would take months and break more often.
- **UxPlay 1.74 from `master`, not the 1.73.x tag.** 1.74 has its own mDNS responder, so you
  don't need Apple's **Bonjour** service, which older Windows builds required. The commit is pinned in
  `scripts/build-uxplay.sh` (`UXPLAY_REF`); change it to update UxPlay.
- **UxPlay's own window, not video inside Electron.** UxPlay renders through Direct3D 11 with GPU
  decoding, which gives the lowest lag. Sending video into Electron would mean re-encoding or
  WebRTC and add delay.
- **Only the needed GStreamer plugins are bundled.** About 20 plugins instead of hundreds keeps the
  installer smaller. The verify script fails the build if any element UxPlay uses is missing.
- **Firewall rule for Private/Domain networks only.** Your PC won't accept AirPlay on public Wi-Fi
  such as cafés or airports.

## Troubleshooting

| Symptom | Fix |
|---|---|
| PC doesn't show up in Screen Mirroring | Check the Network check card. Make sure both devices are on the same Wi-Fi band/router (some routers isolate the 5 GHz and 2.4 GHz bands or turn on "AP/client isolation"). Toggle the iPhone's Wi-Fi off and on. |
| Shows up but connecting spins forever | Firewall rule missing, or a VPN on the PC. Disconnect the VPN. |
| Black or green picture | Advanced → **Software video decoding**. |
| Stutter | Use 1080p @ 30 fps. Move closer to the router, or use Ethernet on the PC. |
| Anything else | Open **Receiver log**, click **Copy log**, and read the lines starting with `*** ERROR`. |

## License

GPL-3.0-or-later, because it bundles UxPlay (GPL-3.0). Not affiliated with Apple. AirPlay and iPhone
are trademarks of Apple Inc.
