'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('panelApi', {
  settings: {
    get: () => invoke('settings:get'),
    save: (storage, keys, readKeys, statusKeys) => invoke('settings:save', storage, keys, readKeys, statusKeys),
    test: () => invoke('settings:test'),
    pickFolder: () => invoke('dialog:pick-folder'),
  },
  library: {
    list: () => invoke('library:list'),
    pick: () => invoke('library:pick'),
    addPaths: (paths) => invoke('library:add-paths', paths),
    remove: (sha256) => invoke('library:remove', sha256),
  },
  update: {
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    onProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  },
  pair: {
    code: () => invoke('pair:code'),
  },
  monitor: {
    list: () => invoke('monitor:list'),
  },
  project: {
    get: () => invoke('project:get'),
    save: (project) => invoke('project:save', project),
  },
  publish: {
    run: (screenId) => invoke('publish:run', screenId),
    onProgress: (cb) => ipcRenderer.on('publish:progress', (_e, p) => cb(p)),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
