'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('playerApi', {
  getState: () => invoke('player:get-state'),
  next: (lastId) => invoke('player:next', lastId),
  onChanged: (cb) => ipcRenderer.on('player:changed', (_e, state) => cb(state)),
  heartbeat: () => ipcRenderer.send('player:heartbeat'),
  onUpdateProgress: (cb) => ipcRenderer.on('player:update-progress', (_e, p) => cb(p)),
  log: (message) => ipcRenderer.send('player:log', String(message).slice(0, 300)),
  playing: (info) => ipcRenderer.send('player:playing', info),
  maint: {
    status: () => invoke('maint:status'),
    setPassword: (password) => invoke('maint:set-password', password),
    auth: (password) => invoke('maint:auth', password),
    info: (token) => invoke('maint:info', token),
    action: (token, action) => invoke('maint:action', token, action),
    paste: (token) => invoke('maint:paste', token),
    setDisplay: (token, d) => invoke('maint:set-display', token, d),
    getConfig: (token) => invoke('maint:get-config', token),
    saveConfig: (token, cfg) => invoke('maint:save-config', token, cfg),
    applyPair: (token, code) => invoke('maint:apply-pair', token, code),
    listScreens: (token) => invoke('maint:list-screens', token),
    updateCheck: (token) => invoke('maint:update-check', token),
    updateInstall: (token) => invoke('maint:update-install', token),
  },
});
