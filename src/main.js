'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { buildUxplayArgs, normalizeSettings, DEFAULTS } = require('./uxplay-args');
const { UxplayLogParser } = require('./log-parser');
const net = require('./windows-net');
const { revealVideoWindow } = require('./video-window');

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    const s = normalizeSettings({
      ...DEFAULTS,
      // A fresh random PIN so "Require PIN" works the moment it's switched on.
      pin: String(1000 + Math.floor(Math.random() * 9000)),
    });
    saveSettings(s);
    return s;
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

let settings = null;

// ---------- UxPlay process ----------
const MAX_LOG_LINES = 400;
const receiver = {
  child: null,
  status: 'stopped', // stopped | starting | idle | connecting | mirroring | error
  client: null,
  error: null,
  pin: null,
  logs: [],
  parser: new UxplayLogParser(),
  stopping: false,
  startedAt: 0,
};

function uxplayRoot() {
  if (settings.customUxplayPath) return path.dirname(path.dirname(settings.customUxplayPath));
  return app.isPackaged
    ? path.join(process.resourcesPath, 'uxplay')
    : path.join(__dirname, '..', 'vendor', 'uxplay');
}

function uxplayExe() {
  return settings.customUxplayPath || path.join(uxplayRoot(), 'bin', 'uxplay.exe');
}

function uxplayEnv() {
  const root = uxplayRoot();
  const bin = path.join(root, 'bin');
  const plugins = path.join(root, 'lib', 'gstreamer-1.0');
  const scanner = path.join(root, 'libexec', 'gstreamer-1.0', 'gst-plugin-scanner.exe');
  const home = app.getPath('userData');
  return {
    ...process.env,
    // Bundled DLLs first, so a system-wide GStreamer/FFmpeg install can't interfere.
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    GST_PLUGIN_SYSTEM_PATH_1_0: plugins,
    GST_PLUGIN_SYSTEM_PATH: plugins,
    GST_PLUGIN_PATH_1_0: '',
    GST_PLUGIN_PATH: '',
    GST_PLUGIN_SCANNER_1_0: scanner,
    GST_PLUGIN_SCANNER: scanner,
    GST_REGISTRY_1_0: path.join(home, 'gst-registry.bin'),
    // UxPlay reads ~/.uxplayrc and stores files under $HOME; keep those inside the app's data folder.
    HOME: home,
    UXPLAYRC: path.join(home, 'uxplayrc-unused'),
  };
}

function pushLog(line) {
  receiver.logs.push(line);
  if (receiver.logs.length > MAX_LOG_LINES) receiver.logs.shift();
  send('log', line);
}

function setStatus(status, extra = {}) {
  Object.assign(receiver, { status }, extra);
  broadcastState();
}

function publicState() {
  return {
    status: receiver.status,
    client: receiver.client,
    error: receiver.error,
    pin: receiver.pin,
    settings,
    exePath: uxplayExe(),
    exeFound: fs.existsSync(uxplayExe()),
  };
}

function broadcastState() {
  send('state', publicState());
  updateTray();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startReceiver() {
  if (receiver.child) return;
  const exe = uxplayExe();
  if (!fs.existsSync(exe)) {
    setStatus('error', { error: `UxPlay was not found at ${exe}. Reinstall Mirrorlet, or set the path under Advanced.` });
    return;
  }

  const userData = app.getPath('userData');
  const args = buildUxplayArgs(settings, {
    keyFile: path.join(userData, 'airplay-server-key.pem'),
    recordDir: app.getPath('videos'),
  });

  receiver.parser.reset();
  receiver.stopping = false;
  receiver.startedAt = Date.now();
  setStatus('starting', { error: null, client: null, pin: null });
  pushLog(`> uxplay ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

  let child;
  try {
    child = spawn(exe, args, { env: uxplayEnv(), windowsHide: true, cwd: userData });
  } catch (e) {
    setStatus('error', { error: `Could not start UxPlay: ${e.message}` });
    return;
  }
  receiver.child = child;

  const onLine = (line) => {
    if (!line.trim()) return;
    pushLog(line);
    const ev = receiver.parser.feed(line);
    if (!ev) return;
    if (ev.type === 'state') {
      setStatus(ev.state, { client: ev.client, error: null });
      if (ev.state === 'mirroring') showVideoWindow({ seconds: 10 });
    }
    else if (ev.type === 'pin') setStatus(receiver.status, { pin: ev.pin });
    else if (ev.type === 'error') setStatus(receiver.status, { error: ev.message });
  };
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', onLine);

  // UxPlay doesn't print a "ready" line we can rely on across versions;
  // if it's still alive after a moment, it's advertising on the network.
  setTimeout(() => {
    if (receiver.child === child && receiver.status === 'starting') setStatus('idle');
  }, 1500);

  child.on('error', (e) => {
    pushLog(`! ${e.message}`);
    setStatus('error', { error: `UxPlay failed to start: ${e.message}` });
  });

  child.on('exit', (code, signal) => {
    if (receiver.child !== child) return;
    receiver.child = null;
    pushLog(`> uxplay exited (code ${code}${signal ? `, ${signal}` : ''})`);
    if (receiver.stopping || quitting) {
      setStatus('stopped', { client: null, pin: null });
      return;
    }
    const ranFor = Date.now() - receiver.startedAt;
    const hint = receiver.parser.lastError
      || (code === 3221225781 || code === -1073741515
        ? 'A required DLL is missing (0xC0000135). Reinstall Mirrorlet.'
        : 'UxPlay stopped unexpectedly. Open the log below for details.');
    // Quick automatic recovery if it ran fine for a while (e.g. a GPU/driver hiccup).
    if (ranFor > 30000) {
      pushLog('> restarting receiver…');
      setTimeout(startReceiver, 1000);
      setStatus('starting', { client: null });
    } else {
      setStatus('error', { error: hint, client: null });
    }
  });
}

function stopReceiver() {
  return new Promise((resolve) => {
    const child = receiver.child;
    if (!child) {
      setStatus('stopped');
      return resolve();
    }
    receiver.stopping = true;
    const done = () => resolve();
    child.once('exit', done);
    // On Windows, kill() calls TerminateProcess; the video window closes with it.
    child.kill();
    setTimeout(() => {
      if (receiver.child === child) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      }
    }, 3000);
    setTimeout(done, 4000);
  });
}

async function showVideoWindow(opts = {}) {
  const child = receiver.child;
  if (!child) return { ok: false, detail: 'receiver not running' };
  const r = await revealVideoWindow(child.pid, opts);
  pushLog(r.ok ? '> mirror window shown' : `> mirror window not found yet (${r.detail || 'no window'})`);
  return r;
}

async function restartReceiver() {
  await stopReceiver();
  startReceiver();
}

// ---------- window & tray ----------
function iconPath() {
  return path.join(__dirname, 'renderer', 'icon.png');
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    title: 'Mirrorlet',
    icon: iconPath(),
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const running = Boolean(receiver.child);
  const label = {
    stopped: 'Stopped', starting: 'Starting…', idle: 'Waiting for iPhone',
    connecting: 'iPhone connecting…', mirroring: 'Mirroring', error: 'Error',
  }[receiver.status] || receiver.status;
  tray.setToolTip(`Mirrorlet — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${label}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Mirrorlet', click: showWindow },
    { label: 'Show mirror window', enabled: receiver.status === 'mirroring' || receiver.status === 'connecting', click: () => showVideoWindow({ seconds: 3 }) },
    running
      ? { label: 'Stop receiver', click: () => stopReceiver() }
      : { label: 'Start receiver', click: () => startReceiver() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
}

function applyLoginItem() {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] });
}

// ---------- IPC ----------
// Settings that UxPlay reads at launch; changing them restarts the receiver.
const RESTART_KEYS = ['deviceName', 'resolution', 'fps', 'fullscreen', 'audio', 'rotate', 'lowLatency',
  'requirePin', 'pin', 'replaceConnection', 'keepWindowOpen', 'softwareDecode', 'record', 'recordDir', 'customUxplayPath'];

ipcMain.handle('get-state', () => ({ ...publicState(), logs: receiver.logs }));
ipcMain.handle('start', () => startReceiver());
ipcMain.handle('stop', () => stopReceiver());
ipcMain.handle('save-settings', async (_e, patch) => {
  const prev = settings;
  settings = normalizeSettings({ ...settings, ...patch });
  saveSettings(settings);
  applyLoginItem();
  const needsRestart = RESTART_KEYS.some((k) => prev[k] !== settings[k]);
  if (needsRestart && receiver.child) await restartReceiver();
  else broadcastState();
  return publicState();
});
ipcMain.handle('diagnostics', () => net.diagnostics());
ipcMain.handle('fix-firewall', () => net.addFirewallRule(uxplayExe()));
ipcMain.handle('open-network-settings', () => shell.openExternal('ms-settings:network-status'));
ipcMain.handle('open-recordings', () => shell.openPath(settings.recordDir || app.getPath('videos')));
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-exe', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'uxplay.exe', extensions: ['exe'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('show-video-window', () => showVideoWindow({ seconds: 3 }));
ipcMain.handle('copy-logs', () => receiver.logs.join('\n'));

// ---------- lifecycle ----------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  app.setAppUserModelId('app.mirrorlet.receiver');
  settings = loadSettings();
  createWindow();
  createTray();
  applyLoginItem();
  if (settings.autoStart) startReceiver();
});

app.on('window-all-closed', () => {
  // keep running in the tray unless the user quits
  if (!settings.closeToTray) { quitting = true; app.quit(); }
});

app.on('before-quit', (e) => {
  quitting = true;
  if (receiver.child) {
    e.preventDefault();
    stopReceiver().then(() => app.exit(0));
  }
});
