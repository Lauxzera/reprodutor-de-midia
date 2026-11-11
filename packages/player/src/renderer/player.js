'use strict';

const api = window.playerApi;
const stage = document.getElementById('stage');
const idleEl = document.getElementById('idle');
const idleDetail = document.getElementById('idle-detail');
const debugEl = document.getElementById('debug');

let state = null;
let currentId = null;
let currentEl = null;
let playProblem = null; // último item que não pôde ser exibido (aparece na tela ociosa e no Ctrl+Shift+D)
const reported = new Set(); // itens já registrados no log (um aviso por item)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: tempo esgotado`)), ms))]);

function applyUpdateBadge() {
  const c = document.getElementById('corner');
  if (c) c.classList.toggle('has-update', Boolean(state && state.update && state.update.newer));
}

let held = false; // painel aberto: o som da reprodução fica mudo por baixo

const volumeOf = () => (state && state.display ? state.display.volume : 100) / 100;
const wantMuted = () => held || Boolean(state && state.settings.muted) || volumeOf() === 0;

function applyAudio() {
  if (currentEl && currentEl.tagName === 'VIDEO') {
    currentEl.muted = wantMuted();
    currentEl.volume = volumeOf();
  }
}

// Exibição = playlist (ajuste da imagem) + ajustes locais do player (ajuste, rotação, volume).
function applySettings(st) {
  const s = st.settings;
  const d = st.display || { fit: 'auto', rotate: 0, volume: 100 };
  document.documentElement.style.setProperty('--fit', d.fit === 'auto' ? s.fit : d.fit);
  document.documentElement.style.setProperty('--t', `${s.transitionMs}ms`);
  stage.className = d.rotate ? `rot${d.rotate}` : '';
  applyAudio();
}

window.__hold = (h) => {
  held = Boolean(h);
  applyAudio();
};
const problems = new Map(); // id -> motivo pelo qual o item não toca (o painel mostra)
window.__problems = problems;

function renderDebug() {
  if (!state) return;
  const st = state.status || {};
  debugEl.textContent = [
    `tela: ${state.screenId || '—'}  revisão: ${state.revision ?? '—'}`,
    `itens: ${state.playableCount}/${state.itemCount} no disco`,
    `sync: ${st.state}${st.message ? ` — ${st.message}` : ''}`,
    `última sync: ${st.lastSyncAt || '—'}`,
    st.quota ? `leituras do B2 hoje: ${st.quota.used}/${st.quota.limit} (${Math.round(st.quota.ratio * 100)}%)${st.quota.level === 'ok' ? '' : st.quota.level === 'over' ? ' — LIMITE GRATUITO ATINGIDO' : ' — perto do limite gratuito'}` : null,
    `tocando: ${currentId || '—'}`,
    playProblem ? `problema: ${playProblem}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function showIdle(show) {
  idleEl.classList.toggle('hidden', !show);
  if (!show || !state) return;
  idleDetail.textContent = playProblem
    ? playProblem
    : state.needsScreen
    ? state.screenChoices && state.screenChoices.length > 1
      ? `Há ${state.screenChoices.length} telas publicadas. Pressione Ctrl+Shift+M > Configurar conexão para escolher a deste player.`
      : 'Pareado. Aguardando uma tela ser publicada pelo painel…'
    : !state.configured
    ? 'Player não configurado. Pressione Ctrl+Shift+M para definir a senha e colar o código de pareamento.'
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
  v.muted = wantMuted();
  v.volume = volumeOf();
  v.playsInline = true;
  v.preload = 'auto';
  v.src = item.src;
  return withTimeout(
    new Promise((resolve, reject) => {
      v.addEventListener('canplay', () => (v.videoWidth === 0 ? reject(new Error('formato de vídeo sem imagem (provavelmente HEVC/H.265); converta para H.264 em MP4')) : resolve(v)), { once: true });
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
  // `cursor` avança mesmo quando um item falha; sem isso o player repetiria o item com defeito e nunca chegaria ao próximo.
  let cursor = null;
  for (;;) {
    let item = null;
    try {
      item = await api.next(cursor);
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
    cursor = item.id;
    try {
      await play(item);
      playProblem = null;
      problems.delete(item.id);
    } catch (e) {
      problems.set(item.id, e.message);
      console.warn(`Pulando "${item.name || item.id}": ${e.message}`);
      if (!reported.has(item.id)) {
        reported.add(item.id);
        api.log(`Item "${item.name || item.id}" não pôde ser exibido e foi pulado: ${e.message}`);
      }
      playProblem = `"${item.name || item.id}" não pôde ser exibido: ${e.message}`;
      if (!currentEl) showIdle(true);
      await sleep(1000);
    }
  }
}

async function boot() {
  state = await api.getState();
  applySettings(state);
  applyUpdateBadge();
  api.onChanged((s) => {
    state = s;
    applySettings(s);
    applyUpdateBadge();
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
