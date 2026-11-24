'use strict';
// Reads UxPlay's console output line by line and derives a simple status:
//   idle -> waiting for an iPhone
//   connecting -> an iPhone opened a session (e.g. picked this PC in Screen Mirroring)
//   mirroring -> video stream has started
// UxPlay prints these at its normal (non-debug) log level, so no -d flag is needed.

class UxplayLogParser {
  constructor() {
    this.sockets = new Set();
    this.client = null;     // { name, model }
    this.state = 'idle';
    this.lastError = null;
  }

  /** @returns {null | {type: string, [k: string]: any}} an event when something changed */
  feed(rawLine) {
    const line = String(rawLine).replace(/\r$/, '');
    let m;

    if ((m = line.match(/connection request from (.+?) \((.+?)\) with deviceID/))) {
      this.client = { name: m[1].trim(), model: m[2].trim() };
      return this._set('connecting');
    }

    if ((m = line.match(/Accepted IPv[46] client on socket (\d+)/))) {
      this.sockets.add(m[1]);
      return null;
    }

    if ((m = line.match(/(?:Connection closed on socket|Removing connection for socket) (\d+)/))) {
      this.sockets.delete(m[1]);
      if (this.sockets.size === 0 && this.state !== 'idle') {
        this.client = null;
        return this._set('idle');
      }
      return null;
    }

    if (/Begin streaming to GStreamer video pipeline|\*\*\* codec is h26[45]/.test(line)) {
      if (this.state !== 'mirroring') return this._set('mirroring');
      return null;
    }

    if (/raop_rtp_mirror->running is no longer true|GStreamer: End-Of-Stream \(video\)/.test(line)) {
      if (this.state === 'mirroring') return this._set(this.sockets.size ? 'connecting' : 'idle');
      return null;
    }

    if ((m = line.match(/CLIENT MUST NOW ENTER PIN = "(\d+)"/))) {
      return { type: 'pin', pin: m[1] };
    }

    if (/Perhaps your GStreamer installation is missing some required plugins/.test(line)) {
      this.lastError = 'The video player components are missing. Reinstall Mirrorlet.';
      return { type: 'error', message: this.lastError };
    }

    if ((m = line.match(/GStreamer error \(video\): (.*)/))) {
      return { type: 'error', message: `Video error: ${m[1]}` };
    }

    if (/lost connection with client/.test(line)) {
      this.sockets.clear();
      this.client = null;
      this.lastError = 'Lost connection with the iPhone (Wi-Fi dropped?)';
      return this._set('idle');
    }

    if (/attempt to connect by blocked client|restricted to those with listed deviceID/.test(line)) {
      return { type: 'warning', message: 'A device was refused because of connection restrictions.' };
    }

    if (/dnssd_register_(raop|airplay) failed|Could not initialize dnssd/.test(line)) {
      this.lastError = 'Could not advertise this PC on the network (mDNS). Check the firewall and that UDP port 5353 is allowed.';
      return { type: 'error', message: this.lastError };
    }

    if (/^\*\*\* ERROR: /.test(line) || /^\*\*\*ERROR/.test(line)) {
      return { type: 'error', message: line.replace(/^\*+ ?ERROR:? ?/, '') };
    }

    return null;
  }

  reset() {
    this.sockets.clear();
    this.client = null;
    this.state = 'idle';
    this.lastError = null;
  }

  _set(state) {
    this.state = state;
    return { type: 'state', state, client: this.client };
  }
}

module.exports = { UxplayLogParser };
