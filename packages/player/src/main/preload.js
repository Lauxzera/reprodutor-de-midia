'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('playerApi', {
  getState: () => invoke('player:get-state'),
  next: (lastId) => invoke('player:next', lastId),
  onChanged: (cb) => ipcRenderer.on('player:changed', (_e, state) => cb(state)),
  heartbeat: () => ipcRenderer.send('player:heartbeat'),
  playing: (info) => ipcRenderer.send('player:playing', info),
  maint: {
    status: () => invoke('maint:status'),
    setPassword: (password) => invoke('maint:set-password', password),
    auth: (password) => invoke('maint:auth', password),
    info: (token) => invoke('maint:info', token),
    action: (token, action) => invoke('maint:action', token, action),
    getConfig: (token) => invoke('maint:get-config', token),
    saveConfig: (token, cfg) => invoke('maint:save-config', token, cfg),
  },
});
