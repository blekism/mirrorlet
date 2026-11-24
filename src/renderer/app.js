'use strict';
/* global mirrorlet */

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;

const STATUS_TEXT = {
  stopped: ['Stopped', 'Start the receiver to make this PC visible to your iPhone.'],
  starting: ['Starting…', 'Getting the receiver ready.'],
  idle: ['Ready — waiting for iPhone', 'Open Screen Mirroring on your iPhone and pick this PC.'],
  connecting: ['iPhone connecting…', ''],
  mirroring: ['Mirroring', ''],
  error: ['Something went wrong', ''],
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function render(s) {
  state = s;
  const { status, client, error, pin, settings } = s;
  const [title, sub] = STATUS_TEXT[status] || [status, ''];
  $('statusCard').dataset.status = status;
  $('statusTitle').textContent = title;

  let subText = sub;
  if (client && (status === 'connecting' || status === 'mirroring')) {
    subText = `${client.name} (${client.model})`;
  } else if (status === 'idle') {
    subText = `Look for “${settings.deviceName}” in Screen Mirroring.`;
  }
  $('statusSub').textContent = subText;

  const running = !['stopped', 'error'].includes(status);
  const btn = $('toggleBtn');
  btn.textContent = running ? 'Stop' : 'Start';
  btn.className = `btn ${running ? 'danger' : 'primary'}`;

  $('errorBox').textContent = error || '';
  $('errorBox').classList.toggle('hidden', !error);

  const shownPin = pin || (settings.requirePin && running ? settings.pin : null);
  $('pinValue').textContent = shownPin || '';
  $('pinBox').classList.toggle('hidden', !shownPin || status === 'mirroring');

  $('nameInSteps').textContent = settings.deviceName;
  renderSettings(settings, s);
}

function renderSettings(st, s) {
  if (document.activeElement !== $('deviceName')) $('deviceName').value = st.deviceName;
  if (document.activeElement !== $('pin')) $('pin').value = st.pin;
  for (const id of ['resolution', 'fps', 'rotate']) {
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', String(st[id]) === b.dataset.v);
  }
  for (const id of ['audio', 'fullscreen', 'lowLatency', 'replaceConnection', 'keepWindowOpen', 'requirePin',
    'record', 'autoStart', 'launchAtLogin', 'closeToTray', 'softwareDecode']) {
    $(id).checked = Boolean(st[id]);
  }
  $('recordDirLabel').textContent = st.recordDir || 'Videos folder';
  $('exePath').textContent = s.exeFound ? s.exePath : `Not found: ${s.exePath}`;
  $('exePath').title = s.exePath;
}

async function save(patch) {
  const s = await mirrorlet.saveSettings(patch);
  render({ ...state, ...s });
}

// ----- network check -----
async function runChecks() {
  const list = $('checks');
  list.innerHTML = '<li class="muted">Checking…</li>';
  let d;
  try { d = await mirrorlet.diagnostics(); } catch { d = null; }
  list.innerHTML = '';
  if (!d) { addCheck('warn', 'Could not run the network check.'); return; }

  if (!d.ips.length) {
    addCheck('bad', 'This PC is not connected to a network.');
  } else {
    addCheck('ok', `Connected — PC address ${d.ips.map((i) => i.address).join(', ')}`);
  }

  const pub = d.profiles.filter((p) => p.category === 'Public');
  if (pub.length) {
    addCheck('bad', `“${pub.map((p) => esc(p.name)).join(', ')}” is set to <b>Public</b>, so Windows hides this PC from your iPhone. Set it to <b>Private</b>.`,
      { label: 'Open network settings', onClick: () => mirrorlet.openNetworkSettings() });
  } else if (d.profiles.length) {
    addCheck('ok', `Network type: ${d.profiles.map((p) => `${esc(p.name)} (${esc(p.category)})`).join(', ')}`);
  }

  if (d.firewallOk) {
    addCheck('ok', 'Firewall allows Mirrorlet.');
  } else {
    addCheck('bad', 'Windows Firewall is blocking Mirrorlet.', {
      label: 'Allow through firewall',
      onClick: async (btn) => {
        btn.disabled = true;
        const r = await mirrorlet.fixFirewall();
        toast(r.ok ? 'Firewall rule added' : 'Firewall rule was not added');
        runChecks();
      },
    });
  }
}

function addCheck(kind, html, action) {
  const li = document.createElement('li');
  li.className = kind;
  const icon = { ok: '✓', warn: '!', bad: '✕' }[kind];
  li.innerHTML = `<span class="icon">${icon}</span><div class="body">${html}</div>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn ghost small';
    b.textContent = action.label;
    b.onclick = () => action.onClick(b);
    li.querySelector('.body').appendChild(document.createElement('br'));
    li.querySelector('.body').appendChild(b);
  }
  $('checks').appendChild(li);
}

// ----- log -----
function appendLog(line) {
  const pre = $('log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent += `${line}\n`;
  if (pre.textContent.length > 80000) pre.textContent = pre.textContent.slice(-60000);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ----- wiring -----
function wire() {
  $('toggleBtn').onclick = async () => {
    const running = !['stopped', 'error'].includes(state.status);
    $('toggleBtn').disabled = true;
    try { running ? await mirrorlet.stop() : await mirrorlet.start(); } finally { $('toggleBtn').disabled = false; }
  };

  $('deviceName').addEventListener('change', (e) => save({ deviceName: e.target.value }));
  $('deviceName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('pin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  $('pin').addEventListener('change', (e) => {
    const v = e.target.value;
    if (/^\d{4}$/.test(v) && v !== '0000') save({ pin: v });
    else { toast('The code must be 4 digits (not 0000)'); e.target.value = state.settings.pin; }
  });

  for (const id of ['resolution', 'fps', 'rotate']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = id === 'fps' ? Number(b.dataset.v) : b.dataset.v;
      save({ [id]: v });
    });
  }

  for (const id of ['audio', 'fullscreen', 'lowLatency', 'replaceConnection', 'keepWindowOpen',
    'record', 'autoStart', 'launchAtLogin', 'closeToTray', 'softwareDecode']) {
    $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
  }
  $('requirePin').addEventListener('change', (e) => {
    if (e.target.checked && !/^\d{4}$/.test(state.settings.pin)) {
      save({ pin: String(1000 + Math.floor(Math.random() * 9000)), requirePin: true });
    } else save({ requirePin: e.target.checked });
  });

  $('pickRecordDir').onclick = async () => { const d = await mirrorlet.pickFolder(); if (d) save({ recordDir: d }); };
  $('openRecordings').onclick = () => mirrorlet.openRecordings();
  $('pickExe').onclick = async () => { const f = await mirrorlet.pickExe(); if (f) save({ customUxplayPath: f }); };
  $('resetExe').onclick = () => save({ customUxplayPath: '' });
  $('recheckBtn').onclick = runChecks;
  $('copyLog').onclick = async () => {
    await navigator.clipboard.writeText(await mirrorlet.copyLogs());
    toast('Log copied');
  };
}

(async function init() {
  wire();
  mirrorlet.onState(render);
  mirrorlet.onLog(appendLog);
  const s = await mirrorlet.getState();
  (s.logs || []).forEach(appendLog);
  render(s);
  runChecks();
})();
