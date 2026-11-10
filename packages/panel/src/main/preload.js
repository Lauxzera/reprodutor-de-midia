'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('panelApi', {
  settings: {
    get: () => invoke('settings:get'),
    save: (storage, keys) => invoke('settings:save', storage, keys),
    test: () => invoke('settings:test'),
    pickFolder: () => invoke('dialog:pick-folder'),
  },
  library: {
    list: () => invoke('library:list'),
    pick: () => invoke('library:pick'),
    addPaths: (paths) => invoke('library:add-paths', paths),
    remove: (sha256) => invoke('library:remove', sha256),
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
