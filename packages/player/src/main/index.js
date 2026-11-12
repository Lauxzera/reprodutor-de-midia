'use strict';

const { app, BrowserWindow, ipcMain, powerSaveBlocker, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { nextActiveItem, SLUG_RE, decodePair, checkForUpdate, downloadUpdate, launchInstaller } = require('@reprodutor/shared');
const { listScreens } = require('./screens');
const { findPairFile, writePairConfig } = require('./pairfile');
const { SyncEngine } = require('./sync');
const { loadConfig } = require('./config');
const { StatusReporter } = require('./reporter');
const { createLogger, readLogTail } = require('./logger');
const { Watchdog } = require('./watchdog');
const { Security } = require('./security');

const argv = process.argv.slice(2);
const windowed = argv.includes('--windowed') || Boolean(process.env.PLAYER_WINDOWED);
const dirArg = argv.find((a) => a.startsWith('--data-dir='));
const dataDir = process.env.PLAYER_DATA_DIR || (dirArg ? dirArg.slice('--data-dir='.length) : path.join(app.getPath('userData'), 'data'));

// Totem touch: sem zoom por gesto de pinça e sem voltar/avançar por deslize nas bordas.
app.commandLine.appendSwitch('disable-pinch');
app.commandLine.appendSwitch('overscroll-history-navigation', '0');

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

  const startedAt = new Date().toISOString();
  let playingName = '';
  const reporter = new StatusReporter({
    baseUrl: config.baseUrl,
    screenId: config.screenId,
    keyId: config.statusKeyId,
    secretKey: config.statusSecret,
    region: config.region,
    log,
    collect: () => ({
      version: app.getVersion(),
      platform: process.platform,
      state: engine.status.state,
      message: engine.status.message,
      lastSyncAt: engine.status.lastSyncAt,
      revision: engine.manifest ? engine.manifest.revision : null,
      itemCount: engine.manifest ? engine.manifest.items.length : 0,
      playableCount: engine.playableItems().length,
      playing: playingName,
      startedAt,
    }),
  });

  let win = null;
  let screenChoices = []; // telas publicadas quando há mais de uma e falta escolher
  let updateInfo = null; // resultado da última verificação de versão
  let updateError = '';
  let updating = false;
  let pendingPair = null; // credenciais de um código de pareamento colado e ainda não salvas (nunca vão ao renderer)
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
    needsScreen: Boolean(config.baseUrl && !config.screenId),
    screenChoices,
    configFile: config.file,
    version: app.getVersion(),
    windowMode: winMode,
    display: config.display,
    media: engine.manifest
      ? engine.manifest.items.map((it) => {
          const present = engine._hasFile(it);
          return { id: it.id, type: it.type, name: it.name || it.id, size: it.size || 0, durationSec: it.durationSec || 0, present, src: present && it.type === 'image' ? pathToFileURL(engine.mediaPath(it)).href : '' };
        })
      : [],
    dataDir,
    screenId: config.screenId,
    settings: engine.manifest ? engine.manifest.settings : { fit: 'contain', transitionMs: 600, muted: true },
    revision: engine.manifest ? engine.manifest.revision : null,
    itemCount: engine.manifest ? engine.manifest.items.length : 0,
    playableCount: engine.playableItems().length,
    status: engine.status,
    report: reporter.info(),
    update: updateInfo ? { current: updateInfo.current, latest: updateInfo.latest, newer: updateInfo.newer, notes: updateInfo.notes, error: updateError } : updateError ? { error: updateError } : null,
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
  ipcMain.on('player:log', (_e, message) => log(`Player: ${message}`));
  ipcMain.on('player:playing', (_e, info) => {
    if (info && typeof info === 'object') {
      const it = engine.manifest && engine.manifest.items.find((x) => x.id === info.id);
      playingName = it ? it.name || it.id : '';
    }
    if (info && typeof info === 'object') watchdog.itemStarted({ id: typeof info.id === 'string' ? info.id : null, expectedMs: Number(info.expectedMs) });
  });

  engine.on('manifest', () => {
    notify();
    reporter.nudge();
  });
  engine.on('status', (s) => {
    notify();
    // Registra só as mudanças de estado (online/offline/erro), sem poluir o log a cada consulta.
    const key = `${s.state === 'checking' || s.state === 'downloading' ? lastStatusState : s.state}|${s.state === 'error' ? s.message : ''}`;
    if (s.state !== 'checking' && s.state !== 'downloading' && key !== lastStatusState) {
      lastStatusState = key;
      log(`Sincronização: ${s.state}${s.message ? ` — ${s.message}` : ''}`);
    }
  });

  // ---- atualizações (GitHub Releases) ----

  const checkUpdate = async () => {
    if (config.updates === false) return null;
    try {
      const before = updateInfo && updateInfo.latest;
      updateInfo = await checkForUpdate({ app: 'player', current: process.env.PLAYER_FAKE_VERSION || app.getVersion() }); // PLAYER_FAKE_VERSION: só para testes
      updateError = '';
      if (updateInfo.newer && updateInfo.latest !== before) log(`Nova versão disponível: v${updateInfo.latest} (instalada: v${updateInfo.current})`);
    } catch (e) {
      updateError = e.message; // sem internet etc.: silencioso, tenta de novo mais tarde
    }
    notify();
    return updateInfo;
  };

  // ---- manutenção (senha) ----

  ipcMain.handle('maint:status', () => ({ hasPassword: security.hasPassword(), lockedMs: security.lockedMs() }));
  ipcMain.handle('maint:set-password', (_e, password) => {
    const r = security.setPassword(password);
    if (r.ok) log('Senha de manutenção definida');
    return r;
  });
  ipcMain.handle('maint:session', () => ({ ok: true, token: security.issueToken() })); // painel sem senha
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
    armWindowTimer(); // usar o painel adia a volta automática à tela cheia
    switch (action) {
      case 'sync': {
        const r = await engine.syncOnce();
        return { ok: true, message: `Sincronização: ${r.status}${r.message ? ` — ${r.message}` : ''}` };
      }
      case 'open-folder':
        await shell.openPath(dataDir);
        return { ok: true, message: 'Pasta aberta' };
      case 'window-toggle':
        setWindowMode(winMode === 'full' ? 'window' : 'full');
        return { ok: true, message: winMode === 'full' ? 'Tela cheia.' : `Modo janela (volta sozinho à tela cheia após ${WINDOW_MODE_MINUTES} min sem uso do painel).` };
      case 'minimize':
        minimizeWindow();
        return { ok: true, message: `Player minimizado; volta sozinho em ${MINIMIZE_MINUTES} min (ou clique no ícone na barra de tarefas).` };
      case 'windows-settings':
        minimizeWindow();
        await shell.openExternal('ms-settings:');
        return { ok: true, message: 'Abrindo as configurações do Windows…' };
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

  const credsOf = (c) => ({ baseUrl: c.baseUrl, keyId: c.keyId, secretKey: c.secretKey, region: c.region });

  // Cola um código de pareamento: valida, guarda as credenciais só no processo principal e devolve as telas publicadas.
  // Sem teclado: acha o pair.txt (pendrive, Downloads, Área de Trabalho) e devolve o código para o painel aplicar.
  ipcMain.handle('maint:find-pair', (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    const found = findPairFile({ dataDir });
    if (!found) return { ok: false, error: 'Não encontrei o pair.txt. Coloque-o num pendrive (raiz), em Downloads ou na Área de Trabalho e tente de novo.' };
    log(`pair.txt encontrado pelo painel: ${found.file}`);
    return { ok: true, text: found.code, file: found.file };
  });

  ipcMain.handle('maint:apply-pair', async (_e, token, code) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    let p;
    try {
      p = decodePair(code);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    pendingPair = p;
    log('Manutenção: código de pareamento aplicado');
    const out = { ok: true, baseUrl: p.baseUrl, pollSeconds: p.pollSeconds, keyId: p.keyId, screens: [], screensError: '' };
    if (p.keyId) {
      try {
        out.screens = await listScreens(credsOf(p));
      } catch (e) {
        out.screensError = e.message;
      }
    }
    return out;
  });

  // Lê o código da área de transferência (botão "Colar código").
  ipcMain.handle('maint:paste', (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    const text = clipboard.readText().trim();
    return text ? { ok: true, text: text.slice(0, 4000) } : { ok: false, error: 'A área de transferência está vazia. Copie o código no admin primeiro.' };
  });

  // Atualiza a lista de telas (com as credenciais pendentes ou as já salvas).
  ipcMain.handle('maint:list-screens', async (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    try {
      return { ok: true, screens: await listScreens(credsOf(pendingPair || config)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('maint:update-check', async (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    if (config.updates === false) return { ok: false, error: 'Atualizações desligadas no config.json ("updates": false)' };
    await checkUpdate();
    return updateInfo ? { ok: true, info: { current: updateInfo.current, latest: updateInfo.latest, newer: updateInfo.newer } } : { ok: false, error: updateError || 'sem resposta' };
  });

  // Baixa o instalador do Release, confere o SHA-256, fecha o player e deixa o instalador reabri-lo.
  ipcMain.handle('maint:update-install', async (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    if (!app.isPackaged) return { ok: false, error: 'A atualização pelo app só funciona no programa instalado' };
    if (updating) return { ok: false, error: 'Já existe uma atualização em andamento' };
    if (!updateInfo || !updateInfo.newer) return { ok: false, error: 'Não há versão nova; verifique as atualizações primeiro' };
    updating = true;
    try {
      log(`Atualização: baixando v${updateInfo.latest}`);
      const file = await downloadUpdate({ info: updateInfo, onProgress: (p) => win && !win.isDestroyed() && win.webContents.send('player:update-progress', p) });
      log('Atualização: instalador conferido (SHA-256); fechando para instalar');
      launchInstaller(file, { appExe: process.execPath }); // o auxiliar reabre o player depois de instalar
      setTimeout(quit, 1000);
      return { ok: true, message: `Instalando v${updateInfo.latest}… o player fecha e reabre sozinho em cerca de um minuto.` };
    } catch (e) {
      updating = false;
      log(`Atualização falhou: ${e.message}`);
      return { ok: false, error: `Atualização falhou: ${e.message}` };
    }
  });

  // Exibição local (ajuste da imagem, rotação, volume): vale na hora, sem reiniciar.
  ipcMain.handle('maint:set-display', (_e, token, input) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    const fit = String((input && input.fit) || 'auto');
    const rotate = Number(input && input.rotate);
    const volume = Math.round(Number(input && input.volume));
    if (!['auto', 'contain', 'cover', 'fill'].includes(fit)) return { ok: false, error: 'Ajuste de imagem inválido' };
    if (![0, 90, 180, 270].includes(rotate)) return { ok: false, error: 'Rotação inválida' };
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) return { ok: false, error: 'Volume deve ficar entre 0 e 100' };
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(config.file, 'utf8'));
    } catch {
      /* config novo */
    }
    fs.writeFileSync(config.file, JSON.stringify({ ...current, display: { fit, rotate, volume } }, null, 2));
    config.display = { fit, rotate, volume };
    log(`Exibição alterada: ajuste ${fit}, rotação ${rotate}°, volume ${volume}`);
    notify();
    return { ok: true, message: 'Exibição salva e aplicada.' };
  });

  ipcMain.handle('maint:get-config', (_e, token) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    return { ok: true, baseUrl: config.baseUrl, screenId: config.screenId, pollSeconds: config.pollSeconds, keyId: config.keyId, hasSecret: Boolean(config.secretKey) };
  });
  ipcMain.handle('maint:save-config', (_e, token, input) => {
    if (!security.checkToken(token)) return { ok: false, error: 'Sessão expirada' };
    const usePair = Boolean(input && input.usePair && pendingPair);
    const baseUrl = String((usePair ? pendingPair.baseUrl : input && input.baseUrl) || '').trim().replace(/\/+$/, '');
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
    if (usePair) {
      // Credenciais do código de pareamento (ficaram só no processo principal).
      next.keyId = pendingPair.keyId;
      next.region = pendingPair.region;
      if (pendingPair.statusKeyId && pendingPair.statusSecret) {
        next.statusKeyId = pendingPair.statusKeyId;
        next.statusSecret = pendingPair.statusSecret;
      } else {
        delete next.statusKeyId;
        delete next.statusSecret;
      }
      if (pendingPair.secretKey) next.secretKey = pendingPair.secretKey;
      else delete next.secretKey;
    } else {
      if (input && typeof input.keyId === 'string') next.keyId = input.keyId.trim();
      // Segredo em branco = mantém o atual (a tela não o exibe).
      if (input && typeof input.secretKey === 'string' && input.secretKey.trim()) next.secretKey = input.secretKey.trim();
      if (input && typeof input.region === 'string') next.region = input.region.trim();
    }
    if (!next.keyId) delete next.secretKey;
    pendingPair = null;
    fs.writeFileSync(config.file, JSON.stringify(next, null, 2));
    log(`Configuração salva pela manutenção (tela "${screenId}")`);
    setTimeout(() => restart('configuração alterada'), 300);
    return { ok: true, message: 'Configuração salva. Reiniciando…' };
  });

  // ---- janela ----

  let winMode = windowed ? 'window' : 'full'; // 'full' = tela cheia sempre por cima; 'window' = janela comum

  // Minimizar para acessar o Windows: o player volta sozinho à tela cheia depois de um tempo,
  // para a TV não ficar sem conteúdo se esquecerem a janela minimizada.
  const MINIMIZE_MINUTES = 10;
  let restoreTimer = null;
  const restoreWindow = () => {
    clearTimeout(restoreTimer);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (winMode === 'full') {
      win.setFullScreen(true);
      win.setAlwaysOnTop(true, 'screen-saver');
    }
    win.show();
    win.focus();
  };

  // Tela cheia (padrão da TV) <-> janela comum (mover, redimensionar, usar o Windows ao lado). Se ficar em janela
  // por 30 min sem uso do painel, volta sozinha à tela cheia para a TV não ficar com o player em janela.
  const WINDOW_MODE_MINUTES = 30;
  let windowTimer = null;
  const armWindowTimer = () => {
    clearTimeout(windowTimer);
    if (winMode === 'window' && !windowed) {
      windowTimer = setTimeout(() => {
        log('Voltando à tela cheia (tempo em janela esgotado)');
        setWindowMode('full');
      }, WINDOW_MODE_MINUTES * 60000);
    }
  };
  function setWindowMode(mode) {
    if (!win || win.isDestroyed()) return;
    winMode = mode;
    clearTimeout(restoreTimer);
    if (win.isMinimized()) win.restore();
    if (mode === 'full') {
      clearTimeout(windowTimer);
      win.setFullScreen(true);
      win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      win.setAlwaysOnTop(false);
      win.setFullScreen(false);
      setTimeout(() => {
        if (!win || win.isDestroyed() || winMode !== 'window') return;
        win.setSize(1200, 780);
        win.center();
      }, 350);
      armWindowTimer();
    }
    win.show();
    win.focus();
    notify();
  }
  const minimizeWindow = () => {
    if (!win || win.isDestroyed()) return;
    log(`Janela minimizada pela manutenção (volta em ${MINIMIZE_MINUTES} min)`);
    win.setAlwaysOnTop(false);
    win.minimize();
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      log('Janela restaurada automaticamente');
      restoreWindow();
    }, MINIMIZE_MINUTES * 60000);
  };

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
    // Voltou da barra de tarefas (ou do tempo limite): tela cheia e por cima de novo.
    win.on('restore', () => {
      clearTimeout(restoreTimer);
      if (winMode === 'full') {
        win.setFullScreen(true);
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    });

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

  // Pareado por código/instalador, mas sem tela definida: se só existe uma tela publicada, usa ela;
  // se houver várias, pede para escolher; se nenhuma, tenta de novo a cada 30 s até o painel publicar.
  function autoPickScreen() {
    const attempt = async () => {
      if (quitting) return;
      try {
        const ids = await listScreens(credsOf(config));
        if (ids.length === 1) {
          const cur = JSON.parse(fs.readFileSync(config.file, 'utf8'));
          fs.writeFileSync(config.file, JSON.stringify({ ...cur, screenId: ids[0] }, null, 2));
          log(`Tela definida automaticamente: "${ids[0]}" (única publicada)`);
          restart('tela definida automaticamente');
          return;
        }
        screenChoices = ids;
        notify();
        if (ids.length > 1) log(`Há ${ids.length} telas publicadas (${ids.join(', ')}); escolha em Ctrl+Shift+M > Configurar conexão`);
        else log('Nenhuma tela publicada ainda; tentando de novo em 30 s');
      } catch (e) {
        log(`Não foi possível listar as telas: ${e.message}`);
      }
      setTimeout(attempt, 30000);
    };
    attempt();
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
    if (config.configured) {
      engine.start();
      reporter.start();
    }
    else if (config.baseUrl && config.keyId && config.secretKey) autoPickScreen();
    else {
      // Sem conexão: procura um pair.txt (pasta de dados, Downloads, Desktop ou pendrive) e se pareia sozinho.
      const found = !config.baseUrl && findPairFile({ dataDir });
      if (found) {
        writePairConfig(config.file, found.pair);
        log(`Pareado automaticamente pelo arquivo ${found.file}`);
        if (path.resolve(path.dirname(found.file)) === path.resolve(dataDir)) fs.rmSync(found.file, { force: true }); // o código leva a chave de leitura
        restart('pareado por pair.txt');
        return;
      }
      log('Player sem configuração: use o botão do canto inferior direito (Conexão com o admin) ou coloque um pair.txt no pendrive.');
    }
    // Verifica novas versões pouco depois de abrir e depois a cada 6 horas.
    setTimeout(checkUpdate, 15000);
    setInterval(checkUpdate, 6 * 60 * 60 * 1000);
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
    reporter.stop();
    watchdog.stop();
  });
}
