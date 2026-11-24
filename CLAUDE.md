# Mirrorlet — project context for Claude Code

> Save this file as `CLAUDE.md` in the project root. Claude Code reads it automatically at the start of every session.
> The **"Current task"** section at the bottom lists the change that still needs to be applied.

## What this is

Mirrorlet is a Windows 10/11 desktop app that mirrors an iPhone screen (with audio) to the PC over Wi-Fi using AirPlay.
- Target device: **iPhone X (iPhone10,3) on iOS 16.7.x**.
- The developer's PC is on **Ethernet** (192.168.1.2); the iPhone is on the same LAN over Wi-Fi.

It has two parts:
- **Electron app** (control panel, tray, installer). Plain JavaScript (CommonJS), no framework, no build step.
- **UxPlay** (`uxplay.exe`), a native C open-source AirPlay receiver (GPL-3.0, https://github.com/FDH2/UxPlay).
  - Electron spawns it as a child process with CLI flags and parses its stdout for status.
  - UxPlay renders video in **its own GStreamer Direct3D 11 window** (`d3d11videosink`, window class `GSTD3D11`), **not** inside Electron. This is on purpose: GPU decode straight to screen gives the lowest lag.

```
iPhone ──AirPlay──▶ uxplay.exe ──▶ GStreamer D3D11 window (own window)
                        ▲ spawn + stdout parsing
                  Electron (Mirrorlet): settings, status, network/firewall checks, tray
```

## Layout

```
src/main.js            Electron main: settings (userData/settings.json), spawn/stop uxplay.exe,
                       GStreamer env vars, stdout → status, tray, IPC handlers, auto-restart
src/uxplay-args.js     settings → UxPlay CLI flags (pure; unit-tested)
src/log-parser.js      UxPlay stdout lines → idle/connecting/mirroring + pin/error events (pure; unit-tested)
src/windows-net.js     Public-network check (Get-NetConnectionProfile), firewall rule check/fix (elevated netsh)
src/video-window.js    Finds UxPlay's GStreamer window by PID + class and shows/raises it (PowerShell + inline C# P/Invoke)
src/pe-subsystem.js    Reads an .exe's PE subsystem (GUI/console); main.js uses it to decide windowsHide (unit-tested)
src/preload.js         contextBridge API: window.mirrorlet.*
src/renderer/          index.html, styles.css, app.js (strict CSP, sandboxed, no Node)
scripts/build-uxplay.sh   MSYS2 UCRT64: builds UxPlay at pinned commit, bundles exe + GStreamer plugins + DLLs (via ldd) into vendor/uxplay
scripts/verify-bundle.ps1 runs bundle with MSYS2 off PATH; checks 24 GStreamer elements; ends with `exit 0`
build/installer.nsh    NSIS: adds/removes firewall rule "Mirrorlet (UxPlay AirPlay receiver)" (private,domain profiles)
.github/workflows/build-windows.yml  CI: MSYS2 → build UxPlay → verify → npm ci → tests → helper check → electron-builder NSIS
test/*.test.js         node:test unit tests (`npm test`)
```

## Key facts and decisions (don't undo these without a reason)

- **UxPlay version:** `master` commit `fbd040e70e754e01fa7e6df810fecd08b6484ada` (v1.74).
  - 1.74 has its own internal mDNS, so **no Apple Bonjour** is needed. Tag v1.73.x would need Bonjour.
  - The commit is pinned in `scripts/build-uxplay.sh` as `UXPLAY_REF`.
- **Bundle layout** (`vendor/uxplay`, packaged to `resources/uxplay`):
  - `bin/` holds uxplay.exe, all DLLs and gst-inspect-1.0.exe.
  - `lib/gstreamer-1.0/` holds plugins.
  - `libexec/gstreamer-1.0/gst-plugin-scanner.exe`.
- **Env vars set when spawning uxplay** (see `uxplayEnv()` in main.js):
  - `PATH`: bundled `bin/` first.
  - `GST_PLUGIN_SYSTEM_PATH_1_0` and `GST_PLUGIN_SCANNER_1_0`.
  - `GST_REGISTRY_1_0`: placed in userData.
  - `HOME`: set to userData, so UxPlay's `~/.uxplayrc` and key files stay out of the user profile.
- **uxplay.exe is GUI-subsystem** (`-DCMAKE_EXE_LINKER_FLAGS=-mwindows` in build-uxplay.sh; verify-bundle.ps1 enforces subsystem 2). main.js spawns it with `windowsHide: false` when the exe is GUI, because `windowsHide: true` makes the GStreamer video window start hidden. It falls back to `windowsHide: true` only for a console-subsystem exe (an old bundle or a custom path).
- **Always passed:** `-key <userData>/airplay-server-key.pem`, for a persistent AirPlay identity.
- **Settings → flags:**

  | Setting | Flag |
  |---|---|
  | device name | `-n <name> -nh` |
  | resolution / fps | `-s WxH@fps -fps N` |
  | fullscreen | `-fs` |
  | audio off | `-as 0` |
  | rotate | `-r L\|R` |
  | lowLatency | `-vsync no` |
  | replaceConnection | `-nohold` |
  | keepWindowOpen | `-nc` |
  | softwareDecode | `-avdec` |
  | PIN | `-pin NNNN` |
  | record | `-mp4 <path>` |

- **Status parsing** works at UxPlay's normal log level. **Don't use `-d`**: debug mode makes stdout buffered on Windows. Lines it relies on:
  - `connection request from <name> (<model>) with deviceID` → connecting
  - `Begin streaming to GStreamer video pipeline` / `*** codec is h264` → mirroring
  - `Accepted IPv4 client on socket N` / `Connection closed on socket N` / `Removing connection for socket N` → socket tracking, back to idle when none are left
  - `raop_rtp_mirror->running is no longer true` → mirroring stopped
- **CI facts already learned:**
  - GitHub runners have no GPU, so `d3d11h264dec` / `d3d12h264dec` don't register there. They're informational only, not required.
  - GitHub's pwsh wrapper exits with the last native command's `$LASTEXITCODE`, so `verify-bundle.ps1` ends with `exit 0`.
- **Build locally:**
  1. In MSYS2 UCRT64: `bash scripts/build-uxplay.sh`
  2. In PowerShell: `./scripts/verify-bundle.ps1`, then `npm install`, then `npm start` (dev mode) or `npm run dist` (installer in `dist/`).
  - If electron-builder fails with a symlink privilege error, turn on Windows Developer Mode.
- **Stack:** Electron ^45, electron-builder ^26, Node 22. Tests: `npm test` (`node --test "test/*.test.js"`).

## Known issue being fixed: iPhone says "connected", but no mirror window appears

Evidence from a real run. UxPlay works and video is arriving:

```
connection request from Blake's iPhone (iPhone10,3) with deviceID = ...
raop_rtp_mirror starting mirroring
*** codec is h264: geometry is (w,h)=(334,720) (source); (x,y)=(473,0); (w,h)=(334,720)
Begin streaming to GStreamer video pipeline
> mirror window shown        ← old helper found a GST* window, but nothing visible happened
```

- `uxplay.exe` doesn't appear under Task Manager → Apps, which means it has no visible window. It does run as a child of Mirrorlet.

**Root-cause hypothesis:**
1. main.js spawns uxplay with Node `windowsHide: true` to avoid a console window. That sets STARTUPINFO `wShowWindow = SW_HIDE` for the child process.
2. GStreamer's `gstd3d11window_win32.cpp` calls `ShowWindow(hwnd, SW_SHOW)` only once. Windows substitutes the STARTUPINFO value on a process's first ShowWindow, so the video window stays hidden.
3. Second issue: focus-stealing protection makes `SetForegroundWindow` / `BringWindowToTop` from the background PowerShell helper no-ops.

The old helper only did `ShowWindow(SW_SHOW)` if not visible, plus `SetForegroundWindow`, and gave no diagnostics.

## Current task

### 1. Replace `src/video-window.js` with this version

Compared with the old helper, it adds:
- restore if minimized
- move onto the primary monitor if off-screen or tiny
- a TOPMOST→NOTOPMOST `SetWindowPos` raise, which works without foreground rights
- a before/after state report for every GST* window

```js
'use strict';
// Makes UxPlay's video window visible, on-screen, and in front of other windows.
//
// Why this exists:
// 1. Mirrorlet starts uxplay.exe with Node's `windowsHide: true` so no console window
//    pops up. Windows hands that "hidden" flag to the child process, and it is applied to
//    the FIRST window it shows: GStreamer's Direct3D video window, which only calls
//    ShowWindow(SW_SHOW) once. Result: iPhone says "connected", no window appears.
// 2. Even once shown, Windows' focus-stealing protection stops a background process from
//    bringing a window to the front (SetForegroundWindow is ignored), so the window can
//    open BEHIND whatever app you're using.
//
// The fix, for each GStreamer renderer window owned by uxplay.exe
// (classes GSTD3D11 = d3d11videosink, GstD3D12Hwnd = d3d12videosink, GSTGL* = glimagesink):
//   - show it (and restore it if minimized)
//   - if it's not on any monitor, move it onto the primary monitor
//   - briefly make it "topmost" then normal again: this raises it above other windows
//     without needing foreground permission
//   - report its state (class, visible, minimized, position) to the receiver log.

const { execFile } = require('child_process');

const CSHARP = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MirrorletWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

  static readonly IntPtr TOPMOST = new IntPtr(-1), NOTOPMOST = new IntPtr(-2);
  const uint NOSIZE = 0x1, NOMOVE = 0x2, SHOWWINDOW = 0x40;

  static string Describe(IntPtr h, string cls) {
    RECT r; GetWindowRect(h, out r);
    bool onScreen = MonitorFromWindow(h, 0) != IntPtr.Zero; // MONITOR_DEFAULTTONULL
    return cls + " visible=" + IsWindowVisible(h) + " minimized=" + IsIconic(h) + " onScreen=" + onScreen +
      " rect=" + r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
  }

  public static string Reveal(uint target) {
    List<string> report = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      StringBuilder sb = new StringBuilder(256);
      GetClassName(h, sb, sb.Capacity);
      string cls = sb.ToString();
      if (!cls.StartsWith("GST", StringComparison.OrdinalIgnoreCase)) return true;

      string before = Describe(h, cls);
      if (IsIconic(h)) ShowWindow(h, 9);            // SW_RESTORE
      if (!IsWindowVisible(h)) ShowWindow(h, 5);    // SW_SHOW

      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      bool tooSmall = w < 120 || ht < 120;
      if (MonitorFromWindow(h, 0) == IntPtr.Zero || tooSmall) {
        // Off every monitor (or collapsed): put it on the primary screen at a sane size.
        if (tooSmall) { w = 480; ht = 900; }
        SetWindowPos(h, IntPtr.Zero, 80, 60, w, ht, SHOWWINDOW);
      }
      // Raise above everything, then drop back to a normal (non-topmost) window.
      SetWindowPos(h, TOPMOST, 0, 0, 0, 0, NOMOVE | NOSIZE | SHOWWINDOW);
      SetWindowPos(h, NOTOPMOST, 0, 0, 0, 0, NOMOVE | NOSIZE | SHOWWINDOW);
      SetForegroundWindow(h); // best effort; may be refused by Windows

      report.Add("before[" + before + "] after[" + Describe(h, cls) + "]");
      return true;
    }, IntPtr.Zero);
    return string.Join(" | ", report.ToArray());
  }
}`;

// Polls for up to `seconds`: the window is created a moment after the first video frame.
function script(pid, seconds) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP}
'@
$deadline = (Get-Date).AddSeconds(${seconds})
do {
  $r = [MirrorletWin]::Reveal(${pid})
  if ($r) { Write-Output "revealed $r"; exit 0 }
  Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)
Write-Output 'none'
`;
}

/**
 * @param {number} pid  uxplay.exe process id
 * @param {{seconds?: number}} [opts]
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function revealVideoWindow(pid, opts = {}) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve({ ok: false, detail: 'not windows' });
  const seconds = Math.max(1, Math.min(30, Number(opts.seconds) || 10));
  // -EncodedCommand (UTF-16LE base64) avoids every quoting problem with the inline C#.
  const encoded = Buffer.from(script(Number(pid), seconds), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: (seconds + 15) * 1000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        resolve({ ok: !err && out.startsWith('revealed'), detail: err ? String(stderr || err.message).trim() : out });
      });
  });
}

module.exports = { revealVideoWindow, _script: script };
```

### 2. In `src/main.js`, log the helper's report

In `showVideoWindow()`, the log line should be:

```js
async function showVideoWindow(opts = {}) {
  const child = receiver.child;
  if (!child) return { ok: false, detail: 'receiver not running' };
  const r = await revealVideoWindow(child.pid, opts);
  pushLog(r.ok ? `> mirror window: ${r.detail.replace(/^revealed /, '')}` : `> mirror window not found yet (${r.detail || 'no window'})`);
  return r;
}
```

(It's already wired up:
- `showVideoWindow({ seconds: 10 })` runs when the parser emits `mirroring`.
- IPC `show-video-window` and the tray item "Show mirror window" call it with `{ seconds: 3 }`.
- The renderer button `#showVideoBtn` calls `mirrorlet.showVideoWindow()`.)

### 3. Test (Windows, real iPhone)

1. Run `npm start`, then pick "Mirrorlet PC" in the iPhone's Screen Mirroring.
2. Read the `> mirror window: before[...] after[...]` line in the Receiver log.
3. Interpret it:
   - **after shows `visible=True onScreen=True` but nothing is visible on screen:** a rendering problem. Try the `softwareDecode` setting (`-avdec`).
   - **after still shows `visible=False`:** go to plan B below.
   - **more than one GST* window in the report:** check which one is the real video window (size around 334x720 plus the window frame, for a portrait phone at 720p).

### Plan B, if the window still won't show

The real fix is to stop launching uxplay hidden, while still not showing a console window. Options:
- **(a)** Spawn without `windowsHide`, then immediately hide only the console window. Find it with `AttachConsole`/`GetConsoleWindow` in a helper, or via EnumWindows class `ConsoleWindowClass` / `CASCADIA_HOSTING_WINDOW_CLASS` for the uxplay PID. Watch for a brief console flash.
- **(b)** Rebuild uxplay.exe as a GUI-subsystem executable (`-mwindows` / `WIN32_EXECUTABLE`) so it has no console. Stdout piping still works when the parent supplies pipes. Do this in `scripts/build-uxplay.sh` by adding `-DCMAKE_EXE_LINKER_FLAGS=-mwindows`, then check that the `Accepted…`/`Begin streaming…` lines still arrive on stdout. Then spawn uxplay with `windowsHide: false`: a GUI-subsystem exe gets no console, so there's nothing to hide, and the SW_HIDE problem disappears. **This is likely the cleanest fix.**
- **(c)** Run with `-fs` (fullscreen), which takes a different code path (`WM_GST_D3D11_FULLSCREEN`). This is a workaround, not a fix.

### Constraints

- Keep `uxplay-args.js` and `log-parser.js` pure and unit-tested. Add tests for any new log lines you parse.
- The renderer has a strict CSP and no Node; add any new capability through `preload.js` + `ipcMain.handle`.
- Don't add `-d` (debug) to UxPlay args; it makes stdout buffered on Windows.
- The CI step "Check mirror-window helper compiles and runs" runs `revealVideoWindow(process.pid, {seconds:1})` and expects `detail === 'none'`. Keep the output contract: it prints `revealed <report>` or `none`.
