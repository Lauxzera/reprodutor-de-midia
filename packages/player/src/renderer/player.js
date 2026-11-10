'use strict';

const api = window.playerApi;
const stage = document.getElementById('stage');
const idleEl = document.getElementById('idle');
const idleDetail = document.getElementById('idle-detail');
const debugEl = document.getElementById('debug');

let state = null;
let currentId = null;
let currentEl = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: tempo esgotado`)), ms))]);

function applySettings(s) {
  document.documentElement.style.setProperty('--fit', s.fit);
  document.documentElement.style.setProperty('--t', `${s.transitionMs}ms`);
}

function renderDebug() {
  if (!state) return;
  const st = state.status || {};
  debugEl.textContent = [
    `tela: ${state.screenId || '—'}  revisão: ${state.revision ?? '—'}`,
    `itens: ${state.playableCount}/${state.itemCount} no disco`,
    `sync: ${st.state}${st.message ? ` — ${st.message}` : ''}`,
    `última sync: ${st.lastSyncAt || '—'}`,
    `tocando: ${currentId || '—'}`,
  ].join('\n');
}

function showIdle(show) {
  idleEl.classList.toggle('hidden', !show);
  if (!show || !state) return;
  idleDetail.textContent = !state.configured
    ? 'Player não configurado. Pressione Ctrl+Shift+M para definir a senha e configurar a conexão.'
    : state.status && state.status.state === 'downloading'
      ? state.status.message
      : state.status && state.status.state === 'error'
        ? state.status.message
        : 'Aguardando a primeira sincronização…';
}

function disposeLater(el, ms) {
  setTimeout(() => {
    if (el.tagName === 'VIDEO') {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    el.remove();
  }, ms + 150);
}

function swapTo(el) {
  el.classList.add('layer');
  stage.appendChild(el);
  void el.offsetWidth; // força o início da transição
  el.classList.add('visible');
  const old = currentEl;
  currentEl = el;
  if (old) {
    old.classList.remove('visible');
    disposeLater(old, state ? state.settings.transitionMs : 600);
  }
}

function clearStage() {
  if (!currentEl) return;
  currentEl.classList.remove('visible');
  disposeLater(currentEl, state ? state.settings.transitionMs : 600);
  currentEl = null;
  currentId = null;
}

async function loadImage(item) {
  const img = new Image();
  img.src = item.src;
  await withTimeout(img.decode(), 15000, 'Imagem');
  return img;
}

function loadVideo(item) {
  const v = document.createElement('video');
  v.muted = state.settings.muted;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = item.src;
  return withTimeout(
    new Promise((resolve, reject) => {
      v.addEventListener('canplay', () => resolve(v), { once: true });
      v.addEventListener('error', () => reject(new Error('Vídeo não pôde ser carregado')), { once: true });
    }),
    20000,
    'Vídeo',
  );
}

function waitEnded(v) {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, (Number.isFinite(v.duration) ? v.duration : 120) * 1000 + 8000);
    const done = () => {
      clearTimeout(fallback);
      resolve();
    };
    v.addEventListener('ended', done, { once: true });
    v.addEventListener('error', done, { once: true });
  });
}

async function play(item) {
  const same = item.id === currentId && currentEl;

  if (item.type === 'image') {
    // Prazo para o watchdog: tempo na tela + folga para carregar.
    api.playing({ id: item.id, expectedMs: (item.durationSec || 10) * 1000 + 45000 });
    if (!same || currentEl.tagName !== 'IMG') swapTo(await loadImage(item));
    currentId = item.id;
    await sleep((item.durationSec || 10) * 1000);
    return;
  }

  api.playing({ id: item.id, expectedMs: 90000 }); // provisório até saber a duração
  let video;
  if (same && currentEl.tagName === 'VIDEO') {
    video = currentEl;
    video.currentTime = 0;
  } else {
    video = await loadVideo(item);
    swapTo(video);
  }
  currentId = item.id;
  api.playing({ id: item.id, expectedMs: (Number.isFinite(video.duration) ? video.duration : 120) * 1000 + 30000 });
  await video.play();
  await waitEnded(video);
}

async function loop() {
  for (;;) {
    let item = null;
    try {
      item = await api.next(currentId);
    } catch (e) {
      console.warn('next falhou', e);
    }

    if (!item) {
      api.playing({ id: null });
      clearStage();
      showIdle(true);
      await sleep(2000);
      continue;
    }

    showIdle(false);
    try {
      await play(item);
    } catch (e) {
      console.warn(`Pulando "${item.name || item.id}": ${e.message}`);
      await sleep(1000);
    }
  }
}

async function boot() {
  state = await api.getState();
  applySettings(state.settings);
  api.onChanged((s) => {
    state = s;
    applySettings(s.settings);
    renderDebug();
  });
  api.heartbeat();
  setInterval(() => api.heartbeat(), 5000);
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      debugEl.classList.toggle('hidden');
      renderDebug();
    }
  });
  loop();
}

boot();
