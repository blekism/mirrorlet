'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirrorlet', {
  getState: () => ipcRenderer.invoke('get-state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  fixFirewall: () => ipcRenderer.invoke('fix-firewall'),
  openNetworkSettings: () => ipcRenderer.invoke('open-network-settings'),
  openRecordings: () => ipcRenderer.invoke('open-recordings'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickExe: () => ipcRenderer.invoke('pick-exe'),
  showVideoWindow: () => ipcRenderer.invoke('show-video-window'),
  copyLogs: () => ipcRenderer.invoke('copy-logs'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l)),
});
