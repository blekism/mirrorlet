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
