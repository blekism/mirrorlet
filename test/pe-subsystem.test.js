'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSubsystem, exeSubsystem, SUBSYSTEM } = require('../src/pe-subsystem');

function fakePe(subsystem, peOffset = 0x80) {
  const buf = Buffer.alloc(peOffset + 4 + 20 + 96);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'latin1');
  buf.writeUInt16LE(subsystem, peOffset + 4 + 20 + 68);
  return buf;
}

test('parses GUI and console subsystems', () => {
  assert.equal(parseSubsystem(fakePe(SUBSYSTEM.GUI)), SUBSYSTEM.GUI);
  assert.equal(parseSubsystem(fakePe(SUBSYSTEM.CONSOLE, 0xf8)), SUBSYSTEM.CONSOLE);
});

test('rejects non-PE data', () => {
  assert.equal(parseSubsystem(Buffer.from('hello world')), null);
  assert.equal(parseSubsystem(Buffer.alloc(0)), null);
  const bad = fakePe(2);
  bad.write('XX', 0x80, 'latin1');
  assert.equal(parseSubsystem(bad), null);
});

test('missing file gives null', () => {
  assert.equal(exeSubsystem('Z:/definitely/not/here.exe'), null);
});

test('reads a real executable when on Windows', { skip: process.platform !== 'win32' }, () => {
  // node.exe is a console-subsystem program.
  assert.equal(exeSubsystem(process.execPath), SUBSYSTEM.CONSOLE);
});
