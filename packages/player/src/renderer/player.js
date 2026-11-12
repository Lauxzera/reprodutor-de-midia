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

// Em janela comum (sem barra de título do Windows) o Player mostra a sua: minimizar, tela cheia e fechar.
function applyWindowControls() {
  const w = document.getElementById('winctl');
  if (w) w.classList.toggle('hidden', !(state && state.windowMode === 'window' && !state.windowed));
}

function applyUpdateBadge() {
  const c = document.getElementById('corner');
  if (c) c.classList.toggle('has-update', Boolean(state && state.update && state.update.newer));
}

document.addEventListener('contextmenu', (e) => e.preventDefault()); // toque longo não abre menu

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
  const openBtn = document.getElementById('idle-open');
  if (openBtn && !openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', () => window.__openMaint && window.__openMaint());
  }
  idleDetail.textContent = playProblem
    ? playProblem
    : state.needsScreen
    ? state.screenChoices && state.screenChoices.length > 1
      ? `Há ${state.screenChoices.length} telas publicadas. Abra o painel (botão abaixo) e escolha a deste player em Conexão com o admin.`
      : 'Pareado. Aguardando uma tela ser publicada pelo painel…'
    : !state.configured
    ? 'Player não configurado. Toque em Abrir painel, depois em Conexão com o admin.'
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

const fadeMs = () => Math.max(200, Math.min(2000, (state && Number(state.settings.transitionMs)) || 600));

// Coloca a mídia no palco ainda invisível (já pode decodificar e apresentar quadros).
function attach(el) {
  el.classList.add('layer');
  stage.appendChild(el);
}

// Dissolve suave: a mídia nova aparece por cima da anterior, que segue tocando por baixo até o fim do fade.
// Só chamar com a nova já pronta (primeiro quadro apresentado), para a transição nunca engasgar nem congelar.
function reveal(el) {
  void el.offsetWidth; // força o início da transição
  el.classList.add('visible');
  const old = currentEl;
  currentEl = el;
  if (old) {
    fadeAudio(old, el, fadeMs());
    disposeLater(old, fadeMs());
  }
}

function swapTo(el) {
  attach(el);
  reveal(el);
}

// Som acompanha o dissolve: o antigo diminui enquanto o novo sobe (nada de corte seco no áudio).
function fadeAudio(oldEl, newEl, ms) {
  if (wantMuted()) return;
  const target = volumeOf();
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    if (newEl.tagName === 'VIDEO') newEl.volume = target * k;
    if (oldEl.tagName === 'VIDEO') oldEl.volume = target * (1 - k);
    if (k < 1) setTimeout(step, 40);
  };
  step();
}

// Primeira mídia depois do vazio: o som sobe junto com a imagem (fade-in), sem estalo.
function fadeAudioIn(v) {
  if (wantMuted()) return;
  const target = volumeOf();
  const t0 = performance.now();
  const ms = fadeMs();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    v.volume = target * k;
    if (k < 1) setTimeout(step, 40);
  };
  step();
}

// Resolve quando o primeiro quadro foi apresentado (ou após o limite, para nunca travar a fila).
function firstFrame(v, ms) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(fin);
    setTimeout(fin, ms);
  });
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

// Pré-carga: enquanto uma mídia toca, a próxima já é aberta e decodificada em segundo plano.
// Assim a troca não espera disco/decodificador e não perde quadros.
let preloaded = null; // { id, promise }

function dropPreload() {
  const old = preloaded;
  preloaded = null;
  if (!old) return;
  old.promise.then(
    (el) => {
      if (el.tagName === 'VIDEO') {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
    },
    () => {},
  );
}

function prefetchNext(afterId) {
  return api
    .next(afterId)
    .then((next) => {
      if (!next) return null;
      if (next.id === currentId || (preloaded && preloaded.id === next.id)) return next;
      dropPreload();
      const promise = next.type === 'image' ? loadImage(next) : loadVideo(next);
      promise.catch(() => {}); // falha na pré-carga: a troca tenta de novo na hora
      preloaded = { id: next.id, promise };
      return next;
    })
    .catch(() => null);
}

function takePreload(id) {
  if (!preloaded || preloaded.id !== id) return Promise.resolve(null);
  const p = preloaded.promise;
  preloaded = null;
  return p.catch(() => null);
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

// Espera o vídeo acabar, ou até faltar leadMs (o próximo já entra em fade enquanto este ainda toca).
function waitTail(v, leadMs) {
  return new Promise((resolve) => {
    const fallback = setTimeout(done, (Number.isFinite(v.duration) ? v.duration : 120) * 1000 + 8000);
    const tick =
      leadMs > 0
        ? setInterval(() => {
            if (Number.isFinite(v.duration) && (v.duration - v.currentTime) * 1000 <= leadMs) done();
          }, 50)
        : null;
    function done() {
      clearTimeout(fallback);
      if (tick) clearInterval(tick);
      resolve();
    }
    v.addEventListener('ended', done, { once: true });
    v.addEventListener('error', done, { once: true });
  });
}

async function play(item) {
  const same = item.id === currentId && currentEl;

  if (item.type === 'image') {
    // Prazo para o watchdog: tempo na tela + folga para carregar.
    api.playing({ id: item.id, expectedMs: (item.durationSec || 10) * 1000 + 45000 });
    if (!same || currentEl.tagName !== 'IMG') swapTo((await takePreload(item.id)) || (await loadImage(item)));
    currentId = item.id;
    prefetchNext(item.id);
    await sleep((item.durationSec || 10) * 1000);
    return;
  }

  api.playing({ id: item.id, expectedMs: 90000 }); // provisório até saber a duração
  let video;
  if (same && currentEl.tagName === 'VIDEO') {
    video = currentEl;
    video.currentTime = 0;
    currentId = item.id;
    api.playing({ id: item.id, expectedMs: (Number.isFinite(video.duration) ? video.duration : 120) * 1000 + 30000 });
    await video.play();
  } else {
    video = await takePreload(item.id);
    if (video) {
      video.muted = wantMuted();
      video.volume = 0; // o som sobe junto com o dissolve (sem estalo antes de aparecer)
    } else {
      video = await loadVideo(item);
      video.volume = 0;
    }
    // Começa a tocar ainda invisível; só dissolve quando o primeiro quadro já foi apresentado.
    attach(video);
    await video.play();
    await firstFrame(video, 1500);
    currentId = item.id;
    api.playing({ id: item.id, expectedMs: (Number.isFinite(video.duration) ? video.duration : 120) * 1000 + 30000 });
    const hadOld = Boolean(currentEl);
    reveal(video);
    if (!hadOld) fadeAudioIn(video);
  }
  // O próximo item começa a dissolver antes do fim deste: este segue tocando por baixo, sem congelar no último quadro.
  const next = await prefetchNext(item.id);
  let lead = 0;
  if (next && next.id !== item.id && Number.isFinite(video.duration)) {
    lead = Math.min(fadeMs() + (next.type === 'video' ? 700 : 250), video.duration * 400);
  }
  await waitTail(video, lead);
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
  applyWindowControls();
  api.onChanged((s) => {
    state = s;
    applySettings(s);
    applyUpdateBadge();
  applyWindowControls();
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
