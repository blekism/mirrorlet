'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildUxplayArgs, normalizeSettings, DEFAULTS } = require('../src/uxplay-args');

const paths = { keyFile: 'C:\\data\\key.pem', recordDir: 'C:\\Videos', now: new Date('2026-11-24T07:30:15Z') };

test('defaults produce a sensible command line', () => {
  const a = buildUxplayArgs(DEFAULTS, paths);
  assert.deepEqual(a, [
    '-n', 'Mirrorlet PC', '-nh', '-s', '1920x1080@60', '-fps', '60',
    '-nohold', '-key', 'C:\\data\\key.pem',
  ]);
});

test('every option maps to the right UxPlay flag', () => {
  const a = buildUxplayArgs({
    ...DEFAULTS, deviceName: 'Gaming PC', resolution: '720p', fps: 30, fullscreen: true, audio: false,
    rotate: 'L', lowLatency: true, requirePin: true, pin: '4821', replaceConnection: false,
    keepWindowOpen: true, softwareDecode: true, record: true,
  }, paths);
  const s = a.join(' ');
  assert.match(s, /-n Gaming PC -nh -s 1280x720@30 -fps 30/);
  for (const frag of ['-fs', '-as 0', '-r L', '-vsync no', '-nc', '-avdec', '-pin 4821']) assert.ok(s.includes(frag), frag);
  assert.ok(!a.includes('-nohold'));
  const mp4 = a[a.indexOf('-mp4') + 1];
  assert.equal(mp4, path.join('C:\\Videos', 'iphone-mirror-2026-11-24-07-30-15'));
});

test('invalid PIN disables the PIN requirement instead of crashing UxPlay', () => {
  for (const pin of ['', '12', 'abcd', '0000', '12345']) {
    const s = normalizeSettings({ requirePin: true, pin });
    assert.equal(s.requirePin, false, pin);
    assert.ok(!buildUxplayArgs(s, paths).includes('-pin'));
  }
});

test('bad values fall back to defaults', () => {
  const s = normalizeSettings({ resolution: '8k', fps: 144, rotate: 'X', deviceName: '   ' });
  assert.equal(s.resolution, '1080p');
  assert.equal(s.fps, 60);
  assert.equal(s.rotate, 'none');
  assert.equal(s.deviceName, 'Mirrorlet PC');
});

test('device name is cleaned and capped', () => {
  const s = normalizeSettings({ deviceName: 'My "PC"\\\n' + 'x'.repeat(60) });
  assert.ok(!/["\\\n]/.test(s.deviceName));
  assert.ok(s.deviceName.length <= 40);
});
