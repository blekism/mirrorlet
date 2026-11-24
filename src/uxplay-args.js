'use strict';
// Turns the app's settings object into UxPlay command-line arguments.
// Kept free of Electron imports so it can be unit-tested with plain Node.

const path = require('path');

const RESOLUTIONS = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
};

const DEFAULTS = Object.freeze({
  deviceName: 'Mirrorlet PC',
  resolution: '1080p',
  fps: 60,
  fullscreen: false,
  audio: true,
  rotate: 'none', // 'none' | 'R' | 'L'
  lowLatency: false,
  requirePin: false,
  pin: '',
  replaceConnection: true,
  keepWindowOpen: false,
  softwareDecode: false,
  record: false,
  recordDir: '',
  autoStart: true,
  launchAtLogin: false,
  closeToTray: true,
  customUxplayPath: '',
});

function sanitizeName(name) {
  // AirPlay names show up in the iPhone's Screen Mirroring list.
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f"\\]/g, '')
    .trim()
    .slice(0, 40);
  return cleaned || DEFAULTS.deviceName;
}

function isValidPin(pin) {
  return /^\d{4}$/.test(String(pin)) && String(pin) !== '0000';
}

function normalizeSettings(input = {}) {
  const s = { ...DEFAULTS, ...input };
  s.deviceName = sanitizeName(s.deviceName);
  if (!RESOLUTIONS[s.resolution]) s.resolution = DEFAULTS.resolution;
  s.fps = [30, 60].includes(Number(s.fps)) ? Number(s.fps) : DEFAULTS.fps;
  if (!['none', 'R', 'L'].includes(s.rotate)) s.rotate = 'none';
  for (const k of ['fullscreen', 'audio', 'lowLatency', 'requirePin', 'replaceConnection',
    'keepWindowOpen', 'softwareDecode', 'record', 'autoStart', 'launchAtLogin', 'closeToTray']) {
    s[k] = Boolean(s[k]);
  }
  s.pin = String(s.pin || '');
  if (s.requirePin && !isValidPin(s.pin)) s.requirePin = false;
  return s;
}

/**
 * @param {object} settings  normalized settings
 * @param {{keyFile: string, recordDir?: string, now?: Date}} paths
 * @returns {string[]}
 */
function buildUxplayArgs(settings, paths) {
  const s = normalizeSettings(settings);
  const [w, h] = RESOLUTIONS[s.resolution];
  const args = [
    '-n', s.deviceName,
    '-nh',                       // don't append "@hostname" to the name
    '-s', `${w}x${h}@${s.fps}`,  // size/refresh the iPhone is asked to send
    '-fps', String(s.fps),
  ];

  if (s.fullscreen) args.push('-fs');
  if (!s.audio) args.push('-as', '0');
  if (s.rotate !== 'none') args.push('-r', s.rotate);
  if (s.lowLatency) args.push('-vsync', 'no');
  if (s.replaceConnection) args.push('-nohold');
  if (s.keepWindowOpen) args.push('-nc');
  if (s.softwareDecode) args.push('-avdec');
  if (s.requirePin) args.push('-pin', s.pin);

  if (s.record) {
    const dir = s.recordDir || paths.recordDir;
    if (dir) {
      const stamp = (paths.now || new Date()).toISOString().replace(/[:T]/g, '-').slice(0, 19);
      args.push('-mp4', path.join(dir, `iphone-mirror-${stamp}`));
    }
  }

  // Persistent server key: the iPhone remembers this PC (and its PIN pairing)
  // across restarts instead of treating it as a new device every time.
  if (paths.keyFile) args.push('-key', paths.keyFile);

  return args;
}

module.exports = { buildUxplayArgs, normalizeSettings, isValidPin, sanitizeName, DEFAULTS, RESOLUTIONS };
