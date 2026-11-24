'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UxplayLogParser } = require('../src/log-parser');

// Log lines in the exact format UxPlay 1.74 prints at its normal log level.
const session = [
  'UxPlay 1.74: An Open-Source AirPlay mirroring and audio-streaming server.',
  'Accepted IPv4 client on socket 1240, port 7000',
  'Local : 192.168.1.20',
  'Remote: 192.168.1.33',
  'connection request from iPhone (iPhone10,6) with deviceID = 2A:11:3B:44:5C:66',
  'Client identified as User-Agent: AirPlay/690.7.1',
  'Accepted IPv4 client on socket 1300, port 7000',
  'Begin streaming to GStreamer video pipeline',
  '*** codec is h264: geometry is (w,h)=(886,1920) (source); (x,y)=(0,0); (w,h)=(886,1920)',
  'raop_rtp_mirror->running is no longer true',
  'Connection closed on socket 1300',
  'Removing connection for socket 1240',
];

test('tracks a full mirroring session', () => {
  const p = new UxplayLogParser();
  const states = session.map((l) => p.feed(l)).filter((e) => e && e.type === 'state').map((e) => e.state);
  assert.deepEqual(states, ['connecting', 'mirroring', 'connecting', 'idle']);
});

test('reports the iPhone name and model', () => {
  const p = new UxplayLogParser();
  const ev = p.feed(session[4]);
  assert.deepEqual(ev.client, { name: 'iPhone', model: 'iPhone10,6' });
});

test('handles Windows CRLF line endings', () => {
  const p = new UxplayLogParser();
  const ev = p.feed('Begin streaming to GStreamer video pipeline\r');
  assert.equal(ev.state, 'mirroring');
});

test('PIN prompt and errors are surfaced', () => {
  const p = new UxplayLogParser();
  assert.deepEqual(p.feed('*** CLIENT MUST NOW ENTER PIN = "4821" AS AIRPLAY PASSWORD'), { type: 'pin', pin: '4821' });
  assert.equal(p.feed('*** ERROR: dnssd_register_raop failed with error code -65537').type, 'error');
  assert.equal(p.feed('*** ERROR lost connection with client (network problem?)').state, 'idle');
});
