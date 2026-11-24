'use strict';
// Makes UxPlay's video window visible and brings it to the front.
//
// Why this exists: Mirrorlet starts uxplay.exe with Node's `windowsHide: true` so no
// console window pops up. Windows passes that "hidden" flag to the child process as
// its STARTUPINFO show state, and it is applied to the FIRST window the process shows —
// GStreamer's Direct3D video window, which only calls ShowWindow(SW_SHOW) once.
// Result: the iPhone says "connected" but the mirror window stays invisible.
//
// The fix: when mirroring starts, find the video window(s) owned by uxplay.exe and
// show them. Only GStreamer's renderer windows are touched, matched by window class:
//   GSTD3D11 (d3d11videosink), GstD3D12Hwnd (d3d12videosink), GSTGL* (glimagesink).

const { execFile } = require('child_process');

const CSHARP = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MirrorletWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  public static int Reveal(uint target) {
    int found = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      StringBuilder cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      string c = cls.ToString();
      if (!c.StartsWith("GST", StringComparison.OrdinalIgnoreCase)) return true;
      if (!IsWindowVisible(h)) ShowWindow(h, 5);   // SW_SHOW
      if (IsIconic(h)) ShowWindow(h, 9);           // SW_RESTORE
      BringWindowToTop(h);
      SetForegroundWindow(h);
      found++;
      return true;
    }, IntPtr.Zero);
    return found;
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
  $n = [MirrorletWin]::Reveal(${pid})
  if ($n -gt 0) { Write-Output "revealed $n"; exit 0 }
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
