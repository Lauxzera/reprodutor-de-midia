'use strict';

const { app, BrowserWindow, ipcMain, powerSaveBlocker, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { nextActiveItem, SLUG_RE } = require('@reprodutor/shared');
const { SyncEngine } = require('./sync');
const { loadConfig } = require('./config');
const { createLogger, readLogTail } = require('./logger');
const { Watchdog } = require('./watchdog');
const { Security } = require('./security');

const argv = process.argv.slice(2);
const windowed = argv.includes('--windowed') || Boolean(process.env.PLAYER_WINDOWED);
const dirArg = argv.find((a) => a.startsWith('--data-dir='));
const dataDir = process.env.PLAYER_DATA_DIR || (dirArg ? dirArg.slice('--data-dir='.length) : path.join(app.getPath('userData'), 'data'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  const log = createLogger(dataDir);
  const config = loadConfig(dataDir);
  const security = new Security(dataDir);
  const engine = new SyncEngine({
    dataDir,
    baseUrl: config.baseUrl,
    screenId: config.screenId,
    pollSeconds: config.pollSeconds,
    keyId: config.keyId,
    secretKey: config.secretKey,
    region: config.region,
    log,
  });
  engine.init();

  let win = null;
  let quitting = false;
  let lastStatusState = null;

  process.on('uncaughtException', (e) => log(`uncaughtException: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.stack ? e.stack : e}`));

  // ---- restart / quit ----

  const quit = () => {
    quitting = true;
    app.quit();
  };
  const restart = (reason) => {
    log(`Reiniciando o player: ${reason}`);
    quitting = true;
    app.relaunch();
    app.exit(0);
  };

  let loads = 0;
  const watchdog = new Watchdog({
    log,
    onReload: () => {
      if (!win || win.isDestroyed()) return;
      const before = loads;
      win.webContents.reload();
      // Renderer travado de verdade (laço infinito) não obedece a reload: derruba o processo à força.
      setTimeout(() => {
        if (loads === before && win && !win.isDestroyed()) {
          log('Recarga não concluiu em 10 s; forçando queda do renderer');
          win.webContents.forcefullyCrashRenderer();
        }
      }, 10000);
    },
    onRestart: restart,
  });

  // ---- estado enviado ao renderer ----

  const snapshot = () => ({
    configured: config.configured,
    configFile: config.file,
    dataDir,
    screenId: config.screenId,
    settings: engine.manifest ? engine.manifest.settings : { fit: 'contain', transitionMs: 600, muted: true },
    revision: engine.manifest ? engine.manifest.revision : null,
    itemCount: engine.manifest ? engine.manifest.items.length : 0,
    playableCount: engine.playableItems().length,
    status: engine.status,
  });

  const toPlayable = (item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    durationSec: item.durationSec,
    src: pathToFileURL(engine.mediaPath(item)).href,
  });

  const notify = () => {
    if (win && !win.isDestroyed()) win.webContents.send('player:changed', snapshot());
  };

  ipcMain.handle('player:get-state', () => snapshot());
  ipcMain.handle('player:next', (_e, lastId) => {
    const item = nextActiveItem(engine.playableItems(), lastId, new Date());
    return item ? toPlayable(item) : null;
  });
  ipcMain.on('player:heartbeat', () => watchdog.heartbeat());
  ipcMain.on('player:playing', (_e, info) => {
    if (info && typeof info === 'object') watchdog.itemStarted({ id: typeof info.id === 'string' ? info.id : null, expectedMs: Number(info.expectedMs) });
  });

  engine.on('manifest', notify);
  engine.on('status', (s) => {
    notify();
    // Registra só as mudanças de estado (online/offline/erro), sem poluir o log a cada consulta.
    const key = `${s.state === 'checking' || s.state === 'downloading' ? lastStatusState : s.state}|${s.state === 'error' ? s.message : ''}`;
    if (s.state !== 'checking' && s.state !== 'downloading' && key !== lastStatusState) {
      lastStatusState = key;
      log(`Sincronização: ${s.state}${s.message ? ` — ${s.message}` : ''}`);
    }
  });

  // ---- manutenção (senha) ----

  ipcMain.handle('maint:status', () => ({ hasPassword: security.hasPassword(), lockedMs: security.lockedMs() }));
  ipcMain.handle('maint:set-password', (_e, password) => {
    const r = security.setPassword(password);
    if (r.ok) log('Senha de manutenção definida');
    return r;
  });
  ipcMain.handle('maint:auth', (_e, password) => {
    const r = security.verify(password);
    log(r.ok ? 'Manutenção: acesso liberado' : `Manutenção: tentativa de acesso recusada (${r.error})`);
    return r;
  });
  ipcMain.handle('maint:info', (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    return { ok: true, snapshot: snapshot(), log: readLogTail(dataDir, 30) };
  });
  ipcMain.handle('maint:action', async (_e, token, action) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    log(`Manutenção: ação "${action}"`);
    switch (action) {
      case 'sync': {
        const r = await engine.syncOnce();
        return { ok: true, message: `Sincronização: ${r.status}${r.message ? ` — ${r.message}` : ''}` };
      }
      case 'open-folder':
        await shell.openPath(dataDir);
        return { ok: true, message: 'Pasta aberta' };
      case 'restart':
        setTimeout(() => restart('pedido pela manutenção'), 200);
        return { ok: true, message: 'Reiniciando…' };
      case 'quit':
        setTimeout(quit, 200);
        return { ok: true, message: 'Encerrando…' };
      default:
        return { ok: false, error: 'Ação desconhecida' };
    }
  });

  ipcMain.handle('maint:get-config', (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    return { ok: true, baseUrl: config.baseUrl, screenId: config.screenId, pollSeconds: config.pollSeconds, keyId: config.keyId, hasSecret: Boolean(config.secretKey) };
  });
  ipcMain.handle('maint:save-config', (_e, token, input) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    const baseUrl = String((input && input.baseUrl) || '').trim().replace(/\/+$/, '');
    const screenId = String((input && input.screenId) || '').trim();
    const pollSeconds = Number(input && input.pollSeconds);
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) return { ok: false, error: 'URL do bucket inválida (deve começar com http:// ou https://)' };
    if (!SLUG_RE.test(screenId)) return { ok: false, error: 'ID da tela inválido (letras minúsculas, números, - e _)' };
    if (!Number.isFinite(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) return { ok: false, error: 'Intervalo deve ficar entre 5 e 3600 segundos' };

    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(config.file, 'utf8'));
    } catch {
      /* config novo */
    }
    const next = { ...current, baseUrl, screenId, pollSeconds };
    if (input && typeof input.keyId === 'string') next.keyId = input.keyId.trim();
    // Segredo em branco = mantém o atual (a tela não o exibe).
    if (input && typeof input.secretKey === 'string' && input.secretKey.trim()) next.secretKey = input.secretKey.trim();
    if (input && typeof input.region === 'string') next.region = input.region.trim();
    if (!next.keyId) delete next.secretKey;
    fs.writeFileSync(config.file, JSON.stringify(next, null, 2));
    log(`Configuração salva pela manutenção (tela "${screenId}")`);
    setTimeout(() => restart('configuração alterada'), 300);
    return { ok: true, message: 'Configuração salva. Reiniciando…' };
  });

  // ---- janela ----

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      backgroundColor: '#000000',
      fullscreen: !windowed,
      frame: windowed,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    if (!windowed) win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());

    // Alt+F4 e afins não fecham o player; só a manutenção (ou o desligamento do Windows).
    win.on('close', (e) => {
      if (!windowed && !quitting) {
        e.preventDefault();
        log('Tentativa de fechar a janela bloqueada');
      }
    });

    // Atalho de atalho para desenvolvimento: só em modo janela.
    win.webContents.on('before-input-event', (event, input) => {
      if (windowed && input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'q') {
        event.preventDefault();
        quit();
      }
    });

    if (process.env.PLAYER_DEBUG) {
      win.webContents.on('console-message', (...args) => {
        const e = args[0];
        console.log('[renderer]', e && e.message !== undefined ? e.message : args[2]);
      });
    }

    win.webContents.on('did-finish-load', () => {
      loads++;
      log('Janela carregada');
      watchdog.reset();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log(`Renderer caiu (${details.reason}); recarregando`);
      watchdog.reset();
      setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 1000);
    });

    let hangTimer = null;
    win.on('unresponsive', () => {
      log('Janela sem resposta');
      clearTimeout(hangTimer);
      hangTimer = setTimeout(() => {
        log('Janela continua sem resposta; forçando recarga');
        win.webContents.forcefullyCrashRenderer();
      }, 20000);
    });
    win.on('responsive', () => clearTimeout(hangTimer));

    // Verificação automatizada: encerra após N ms (teste do watchdog, sem screenshot).
    if (process.env.PLAYER_SMOKE_QUIT_MS) {
      if (process.env.PLAYER_SMOKE_JS) win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.executeJavaScript(process.env.PLAYER_SMOKE_JS).catch(() => {}), 3000));
      setTimeout(quit, Number(process.env.PLAYER_SMOKE_QUIT_MS));
    }

    // Verificação automatizada: executa JS opcional, tira um screenshot e encerra.
    if (process.env.PLAYER_SMOKE_SHOT) {
      setTimeout(async () => {
        try {
          if (process.env.PLAYER_SMOKE_JS) {
            const out = await win.webContents.executeJavaScript(process.env.PLAYER_SMOKE_JS);
            if (out !== undefined) console.log('[smoke]', JSON.stringify(out));
            await new Promise((r) => setTimeout(r, 1500));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.PLAYER_SMOKE_SHOT, img.toPNG());
        } finally {
          quit();
        }
      }, Number(process.env.PLAYER_SMOKE_DELAY || 6000));
    }
  }

  app.whenReady().then(() => {
    powerSaveBlocker.start('prevent-display-sleep');
    if (app.isPackaged && config.autoStart) app.setLoginItemSettings({ openAtLogin: true });
    createWindow();
    watchdog.start();
    if (process.env.PLAYER_METRICS) {
      // Teste de longa duração: registra memória (MB) de cada processo a cada 15 s.
      setInterval(() => {
        const m = app.getAppMetrics().map((p) => `${p.type}=${Math.round(p.memory.workingSetSize / 1024)}`);
        log(`metrics MB: ${m.join(' ')}`);
      }, 15000);
    }
    if (config.configured) engine.start();
    else log('Player sem configuração: pressione Ctrl+Shift+M na tela do player para configurar a conexão.');
    log(`Player iniciado (tela "${config.screenId || '—'}", dados em ${dataDir})`);
  });

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('child-process-gone', (_e, details) => log(`Processo filho encerrou: ${details.type} (${details.reason})`));
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    engine.stop();
    watchdog.stop();
  });
}
