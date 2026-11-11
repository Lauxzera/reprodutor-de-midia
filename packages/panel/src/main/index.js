'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { encodePair, checkForUpdate, downloadUpdate, launchInstaller, collectMonitor, fetchLatestVersion } = require('@reprodutor/shared');
const { createStorage, publicBaseUrl } = require('./storage');
const { publishScreen } = require('./publish');
const { IMAGE_EXT, VIDEO_EXT, screenKey } = require('@reprodutor/shared');

const dataDir = process.env.PANEL_DATA_DIR || path.join(app.getPath('userData'), 'data');

const cipher = {
  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Criptografia do sistema indisponível; credenciais não foram salvas');
    return safeStorage.encryptString(text);
  },
  decrypt: (buf) => safeStorage.decryptString(buf),
};

let store;
let win;

function currentStorage() {
  const settings = store.getSettings();
  const storage = createStorage(settings, store.getKeys());
  return { settings, storage };
}

let updateInfo = null;
let updating = false;

function registerIpc() {
  // ---- atualizações (GitHub Releases) ----
  ipcMain.handle('update:check', async () => {
    try {
      updateInfo = await checkForUpdate({ app: 'painel', current: app.getVersion() });
      return { ok: true, current: updateInfo.current, latest: updateInfo.latest, newer: updateInfo.newer, notes: updateInfo.notes };
    } catch (e) {
      return { ok: false, current: app.getVersion(), error: e.message };
    }
  });

  ipcMain.handle('update:install', async (event) => {
    if (!app.isPackaged) return { ok: false, error: 'A atualização pelo app só funciona no programa instalado' };
    if (updating) return { ok: false, error: 'Já existe uma atualização em andamento' };
    if (!updateInfo || !updateInfo.newer) return { ok: false, error: 'Não há versão nova; verifique as atualizações primeiro' };
    updating = true;
    try {
      const file = await downloadUpdate({ info: updateInfo, onProgress: (p) => event.sender.send('update:progress', p) });
      launchInstaller(file, { appExe: process.execPath }); // o auxiliar reabre o painel depois de instalar
      setTimeout(() => app.quit(), 1000);
      return { ok: true, message: `Instalando v${updateInfo.latest}… o painel fecha e reabre sozinho em cerca de um minuto.` };
    } catch (e) {
      updating = false;
      return { ok: false, error: `Atualização falhou: ${e.message}` };
    }
  });

  const settingsView = () => {
    const k = store.getKeys() || {};
    return { ...store.getSettings(), hasKeys: store.hasKeys(), hasReadKey: Boolean(k.readKeyId && k.readAppKey), readKeyId: k.readKeyId || '', hasStatusKey: Boolean(k.statusKeyId && k.statusAppKey), statusKeyId: k.statusKeyId || '', baseUrl: publicBaseUrl(store.getSettings()) };
  };
  ipcMain.handle('settings:get', () => settingsView());

  ipcMain.handle('settings:save', (_e, patch, keys, readKeys, statusKeys) => {
    store.saveSettings(patch, keys, readKeys, statusKeys);
    return settingsView();
  });

  // Código de pareamento do Player: endpoint + bucket + chave de leitura + intervalo.
  ipcMain.handle('pair:code', () => {
    const s = store.getSettings();
    const k = store.getKeys() || {};
    if (s.type !== 'b2' || !s.endpoint || !s.bucket) return { ok: false, error: 'Configure o bucket do B2 em Configurações.' };
    if (s.privateBucket && !(k.readKeyId && k.readAppKey)) return { ok: false, error: 'Informe a chave de leitura do player em Configurações.' };
    try {
      return { ok: true, code: encodePair({ endpoint: s.endpoint, bucket: s.bucket, keyId: s.privateBucket ? k.readKeyId : '', secretKey: s.privateBucket ? k.readAppKey : '', pollSeconds: s.privateBucket ? 120 : 60, publicBaseUrl: s.publicBaseUrl, statusKeyId: k.statusKeyId, statusSecret: k.statusAppKey }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Telas do projeto + último relatório de cada player.
  let latest = { at: 0, version: '' };
  ipcMain.handle('monitor:list', async () => {
    const { storage } = currentStorage();
    if (!latest.at || Date.now() - latest.at > 10 * 60 * 1000) latest = { at: Date.now(), version: await fetchLatestVersion() };
    return collectMonitor({ storage, project: store.getProject(), latestVersion: latest.version });
  });

  ipcMain.handle('settings:test', async () => {
    try {
      const { storage } = currentStorage();
      const key = '_ping.json';
      await storage.putJson(key, { at: new Date().toISOString() });
      await storage.delete(key);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('library:list', () => store.listLibrary());

  ipcMain.handle('library:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Imagens e vídeos', extensions: [...IMAGE_EXT, ...VIDEO_EXT].map((e) => e.slice(1)) }],
    });
    if (r.canceled) return { added: [], skipped: [] };
    return store.addFiles(r.filePaths);
  });

  ipcMain.handle('library:add-paths', (_e, paths) => store.addFiles(paths));
  ipcMain.handle('library:remove', (_e, sha256) => store.removeFromLibrary(sha256));

  ipcMain.handle('project:get', () => store.getProject());
  ipcMain.handle('project:save', (_e, project) => {
    store.saveProject(project);
    return true;
  });

  ipcMain.handle('publish:run', async (event, screenId) => {
    const project = store.getProject();
    const screen = project.screens.find((s) => s.id === screenId);
    if (!screen) throw new Error('Tela não encontrada');
    const { settings, storage } = currentStorage();

    const result = await publishScreen({
      storage,
      screen,
      library: store.listLibrary(),
      onProgress: (p) => event.sender.send('publish:progress', p),
    });

    screen.revision = result.manifest.revision;
    store.saveProject(project);
    const base = publicBaseUrl(settings);
    return {
      revision: result.manifest.revision,
      uploaded: result.uploaded,
      skipped: result.skipped,
      baseUrl: base,
      manifestUrl: base ? `${base}/${screenKey(screen.id)}` : '',
    };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'Painel — Reprodutor de Mídia',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.env.PANEL_DEBUG) {
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      console.log('[renderer]', e && e.message !== undefined ? e.message : args[2]);
    });
  }

  // Verificação automatizada: percorre as abas, tira screenshots e encerra.
  if (process.env.PANEL_SMOKE_DIR) {
    win.webContents.once('did-finish-load', async () => {
      const out = process.env.PANEL_SMOKE_DIR;
      fs.mkdirSync(out, { recursive: true });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        win.show();
        win.focus();
        await wait(2000);
        for (const tab of ['library', 'playlist', 'publish', 'screens', 'settings']) {
          await win.webContents.executeJavaScript(`window.__goto(${JSON.stringify(tab)})`);
          await wait(400);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(out, `${tab}.png`), img.toPNG());
        }
      } catch (e) {
        console.error('smoke falhou:', e.message);
      } finally {
        app.quit();
      }
    });
  }
}

app.whenReady().then(() => {
  store = new Store(dataDir, cipher);
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
