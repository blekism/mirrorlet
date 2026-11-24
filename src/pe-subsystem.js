'use strict';
// Reads the Windows subsystem (GUI vs console) from an .exe's PE header.
//
// Why: uxplay.exe must NOT be spawned with Node's `windowsHide: true`, because that sets
// STARTUPINFO wShowWindow = SW_HIDE and Windows applies it to the first window the process
// shows: GStreamer's video window. scripts/build-uxplay.sh links uxplay.exe with
// -mwindows (GUI subsystem), so it gets no console and needs no hiding. An older bundle or a
// custom path may still be a console exe; only then do we fall back to windowsHide.

const fs = require('fs');

const SUBSYSTEM = { GUI: 2, CONSOLE: 3 };

/** Pure: parse the subsystem from the first bytes of a PE file. Returns null if not a PE. */
function parseSubsystem(buf) {
  if (!buf || buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const pe = buf.readUInt32LE(0x3c);
  // Signature (4) + COFF header (20) + Subsystem offset in optional header (68, same for PE32/PE32+)
  const off = pe + 4 + 20 + 68;
  if (off + 2 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null; // 'PE\0\0'
  return buf.readUInt16LE(off);
}

/** @returns {number|null} subsystem id, or null if the file can't be read/parsed */
function exeSubsystem(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return parseSubsystem(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function isGuiExe(file) {
  return exeSubsystem(file) === SUBSYSTEM.GUI;
}

module.exports = { parseSubsystem, exeSubsystem, isGuiExe, SUBSYSTEM };
