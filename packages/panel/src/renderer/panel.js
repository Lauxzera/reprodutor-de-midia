'use strict';

const api = window.panelApi;

const TABS = [
  ['home', 'Início'],
  ['screens', 'Telas'],
  ['library', 'Mídias'],
  ['connect', 'Conectar TV'],
  ['settings', 'Configurações'],
];
const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const state = {
  tab: 'home',
  screenTab: 'playlist', // dentro de Telas: playlist | publish | settings
  newScreen: false,
  screenId: null,
  project: null,
  library: [],
  settings: null,
  openSchedule: new Set(),
  publishing: false,
  lastPublish: null,
  publishLog: [],
  settingsDraft: null,
  testResult: null,
  quota: null, // só na versão web: uso do armazenamento do B2
  update: null, // só no app de mesa: resultado da verificação de versão
  monitor: undefined, // monitoramento: undefined = não carregado, null = carregando, {rows, latestVersion, error}
  pair: undefined, // código de pareamento do player: undefined = não carregado, null = carregando, {ok, code|error}
};

// Barra de uso do armazenamento (versão web). Os limites são os conhecidos do plano gratuito do B2.
function quotaBar() {
  if (!api.quota || !state.quota) return null;
  const q = state.quota;
  const pct = Math.min(100, Math.round(q.ratio * 100));
  const msg = q.level === 'over' ? ' — limite gratuito atingido: novos envios serão recusados' : q.level === 'warn' ? ' — perto do limite gratuito; apague o que não usa' : '';
  return h(
    'div',
    { class: `quota ${q.level}` },
    h('div', { class: 'quota-text' }, `Armazenamento do B2: ${formatSize(q.used)} de ${formatSize(q.limit)} (${pct}%)${msg}`),
    h('div', { class: 'quota-track' }, h('div', { class: 'quota-fill', style: `width:${pct}%` })),
    h('button', { class: 'btn small', onclick: () => loadQuota(true) }, 'Atualizar'),
  );
}

// Atualizações do app de mesa (o painel web já está sempre atualizado).
async function checkUpdate(manual) {
  if (!api.update) return;
  state.update = await api.update.check();
  if (state.update.ok && state.update.newer) toast(`Nova versão disponível: v${state.update.latest}. Atualize em Configurações.`, 'info');
  else if (manual) toast(state.update.ok ? `Já está na versão mais recente (v${state.update.current}).` : `Não consegui verificar: ${state.update.error}`, state.update.ok ? 'success' : 'error');
  render();
}

function updateBlock() {
  if (!api.update) return null;
  const u = state.update;
  return h(
    'div',
    { class: 'card', style: 'margin-top:22px' },
    h('h3', {}, 'Atualizações'),
    h('p', { class: 'muted', style: 'margin-top:0' }, u && u.ok ? (u.newer ? `Nova versão disponível: v${u.latest} (instalada: v${u.current}).` : `Versão instalada: v${u.current} (a mais recente).`) : u ? `Não consegui verificar: ${u.error}` : 'Verificando…'),
    h(
      'div',
      { class: 'row wrap' },
      u && u.ok && u.newer
        ? h(
            'button',
            {
              class: 'btn primary',
              onclick: async (e) => {
                if (!confirm(`Atualizar para a v${u.latest}? O painel baixa, fecha, instala e reabre sozinho (cerca de um minuto).`)) return;
                e.target.disabled = true;
                const r = await api.update.install();
                toast(r.ok ? r.message : r.error, r.ok ? 'success' : 'error');
                e.target.disabled = false;
              },
            },
            `Atualizar para v${u.latest}`,
          )
        : null,
      h('button', { class: 'btn', onclick: () => checkUpdate(true) }, 'Verificar atualizações'),
    ),
  );
}

// Comando para o cmd do PC da TV: baixa o instalador do GitHub e já instala pareado.
const INSTALL_URL = 'https://raw.githubusercontent.com/Lauxzera/reprodutor-de-midia/main/install.ps1';
const installCommand = (code) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr ${INSTALL_URL} -OutFile $env:TEMP\\rm-install.ps1; & $env:TEMP\\rm-install.ps1 -App player -Pair ${code}"`;

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadPair() {
  if (!api.pair || state.pair === null) return;
  state.pair = null;
  try {
    state.pair = await api.pair.code();
  } catch (e) {
    state.pair = { ok: false, error: e.message };
  }
  render();
}

async function loadQuota(force) {
  if (!api.quota) return;
  try {
    state.quota = force ? await api.quota.refresh() : await api.quota.get();
    render();
  } catch (e) {
    /* sem a medição, a barra simplesmente não aparece */
  }
}

// ---------- utilidades ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const uid = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

const fmtDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

function slugify(text, taken) {
  let base =
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tela';
  let slug = base;
  for (let n = 2; taken.includes(slug); n++) slug = `${base}-${n}`;
  return slug;
}

let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 7000 : 3500);
}

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.project.save(state.project).catch((e) => toast(e.message, 'error')), 250);
}

const currentScreen = () => state.project.screens.find((s) => s.id === state.screenId);
const mediaBySha = (sha) => state.library.find((m) => m.sha256 === sha);

function usageCount(sha) {
  return state.project.screens.reduce((n, s) => n + s.items.filter((it) => it.sha256 === sha).length, 0);
}

function scheduleSummary(s) {
  if (!s) return 'Sempre ativo';
  const parts = [];
  if (s.days && s.days.length && s.days.length < 7) parts.push(s.days.map((d) => DAY_NAMES[d]).join(', '));
  if (s.start && s.end) parts.push(`${s.start}–${s.end}`);
  if (s.from || s.to) parts.push(`${fmtDate(s.from) || '…'} → ${fmtDate(s.to) || '…'}`);
  return parts.join(' · ') || 'Sempre ativo';
}

function thumb(media, cls) {
  if (!media) return h('div', { class: cls, style: 'display:flex;align-items:center;justify-content:center;color:#9097a3' }, '?');
  if (media.type === 'video') {
    return h('video', { class: cls, src: `${media.url}#t=0.1`, preload: 'metadata', muted: true });
  }
  return h('img', { class: cls, src: media.url, alt: media.name });
}

// ---------- biblioteca ----------

async function reloadLibrary() {
  state.library = await api.library.list();
}

async function addPaths(paths) {
  if (!paths.length) return;
  const r = await api.library.addPaths(paths);
  await reloadLibrary();
  reportAdd(r);
  render();
  loadQuota(false);
}

function reportAdd(r) {
  const parts = [];
  if (r.added.length) parts.push(`${r.added.length} arquivo(s) adicionado(s)`);
  if (r.skipped.length) parts.push(r.skipped.map((s) => `${s.name}: ${s.reason}`).join('\n'));
  if (parts.length) toast(parts.join('\n'), r.added.length ? 'success' : 'error');
}

async function pickFiles() {
  const r = await api.library.pick();
  await reloadLibrary();
  reportAdd(r);
  render();
  loadQuota(false);
}

function viewLibrary() {
  const zone = h(
    'div',
    { class: 'dropzone' },
    'Arraste imagens e vídeos para cá, ou ',
    h('button', { class: 'btn primary', onclick: pickFiles }, 'Adicionar arquivos'),
    h('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, 'JPG, PNG, GIF, WebP, MP4, WebM, MOV. Recomendado: vídeos em MP4 (H.264).'),
  );

  const grid = h('div', { class: 'grid' });
  for (const m of state.library) {
    const used = usageCount(m.sha256);
    grid.append(
      h(
        'div',
        { class: 'media-card' },
        thumb(m, 'thumb'),
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name', title: m.name }, m.name),
          h('div', { class: 'row' }, h('span', { class: `badge ${m.type}` }, m.type === 'video' ? 'vídeo' : 'imagem'), h('span', { class: 'muted' }, formatSize(m.size))),
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'muted' }, used ? `em ${used} item(ns)` : 'não usada'),
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn small danger',
                onclick: async () => {
                  const r = await api.library.remove(m.sha256);
                  if (!r.ok) return toast(`Em uso na playlist de: ${r.usedIn.join(', ')}. Remova de lá primeiro.`, 'error');
                  await reloadLibrary();
                  render();
                },
              },
              'Excluir',
            ),
          ),
        ),
      ),
    );
  }

  return h(
    'div',
    {},
    h('h2', {}, 'Mídias'),
    h('p', { class: 'sub' }, api.web ? 'Imagens e vídeos disponíveis para as playlists. Cada arquivo é enviado ao seu bucket do B2.' : 'Imagens e vídeos disponíveis para as playlists. Cada arquivo é copiado para o painel.'),
    quotaBar(),
    zone,
    state.library.length ? grid : h('p', { class: 'muted' }, 'Nenhuma mídia ainda. Arraste arquivos para cá ou use o botão acima.'),
  );
}

// ---------- playlist ----------

let dragFrom = null;

function moveItem(from, to) {
  const items = currentScreen().items;
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
  const [it] = items.splice(from, 1);
  items.splice(to, 0, it);
  persist();
  render();
}

function scheduleEditor(it, summaryEl) {
  const s = it.schedule || {};
  const chosen = new Set(s.days && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6]);
  const hint = h('div', { class: 'warn', style: 'font-size:12px' });

  const dayInputs = DAY_NAMES.map((name, d) => h('input', { type: 'checkbox', value: String(d), checked: chosen.has(d), onchange: collect }));
  const startIn = h('input', { type: 'time', value: s.start || '', onchange: collect });
  const endIn = h('input', { type: 'time', value: s.end || '', onchange: collect });
  const fromIn = h('input', { type: 'date', value: s.from || '', onchange: collect });
  const toIn = h('input', { type: 'date', value: s.to || '', onchange: collect });

  function collect() {
    const days = dayInputs.filter((i) => i.checked).map((i) => Number(i.value));
    const sch = {};
    if (days.length && days.length < 7) sch.days = days;
    if (startIn.value && endIn.value && startIn.value !== endIn.value) {
      sch.start = startIn.value;
      sch.end = endIn.value;
    }
    if (fromIn.value) sch.from = fromIn.value;
    if (toIn.value) sch.to = toIn.value;
    it.schedule = Object.keys(sch).length ? sch : null;

    const msgs = [];
    if (!days.length) msgs.push('Nenhum dia marcado equivale a todos os dias.');
    if (!!startIn.value !== !!endIn.value) msgs.push('Preencha início e fim do horário (ou deixe os dois vazios).');
    if (fromIn.value && toIn.value && fromIn.value > toIn.value) msgs.push('A data inicial é depois da final.');
    hint.textContent = msgs.join(' ');
    summaryEl.textContent = scheduleSummary(it.schedule);
    persist();
  }

  return h(
    'div',
    { class: 'sched-editor' },
    h('div', { class: 'days' }, DAY_NAMES.map((name, d) => h('label', { class: 'day' }, dayInputs[d], name))),
    h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, 'Horário'), startIn, h('span', {}, 'até'), endIn, h('span', { class: 'muted' }, '(janela que cruza a meia-noite é aceita, ex.: 22:00 até 02:00)')),
    h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, 'Período'), fromIn, h('span', {}, 'até'), toIn),
    hint,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            it.schedule = null;
            persist();
            render();
          },
        },
        'Sempre ativo (limpar agenda)',
      ),
    ),
  );
}

function itemRow(it, i, total) {
  const media = mediaBySha(it.sha256);
  const summary = h('div', { class: 'muted', style: 'font-size:12px' }, scheduleSummary(it.schedule));
  const row = h('div', { class: 'item' });

  const handle = h('span', { class: 'handle', title: 'Arraste para reordenar', onmousedown: () => (row.draggable = true) }, '⠿');
  row.addEventListener('mouseup', () => (row.draggable = false));
  row.addEventListener('dragstart', (e) => {
    dragFrom = i;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('dragging');
    dragFrom = null;
  });
  row.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-target');
    moveItem(dragFrom, i);
  });

  const durationCell =
    media && media.type === 'image'
      ? h(
          'label',
          { class: 'row muted', title: 'Tempo na tela' },
          h('input', {
            type: 'number',
            min: '1',
            max: '3600',
            value: it.durationSec || 10,
            onchange: (e) => {
              const n = Math.max(1, Math.min(3600, Number(e.target.value) || 10));
              e.target.value = n;
              it.durationSec = n;
              persist();
            },
          }),
          's',
        )
      : h('span', { class: 'muted', title: 'Vídeos tocam até o fim' }, 'até o fim');

  const open = state.openSchedule.has(it.id);
  row.append(
    h(
      'div',
      { class: 'row' },
      handle,
      h('span', { class: 'index' }, i + 1),
      thumb(media, 'thumb-sm'),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'title', title: media ? media.name : '' }, media ? media.name : 'Mídia removida da biblioteca'), summary),
      durationCell,
      h(
        'button',
        {
          class: `btn small${it.schedule ? ' primary' : ''}`,
          onclick: () => {
            if (open) state.openSchedule.delete(it.id);
            else state.openSchedule.add(it.id);
            render();
          },
        },
        'Agenda',
      ),
      h('button', { class: 'btn small', disabled: i === 0, title: 'Subir', onclick: () => moveItem(i, i - 1) }, '↑'),
      h('button', { class: 'btn small', disabled: i === total - 1, title: 'Descer', onclick: () => moveItem(i, i + 1) }, '↓'),
      h(
        'button',
        {
          class: 'btn small danger',
          title: 'Remover da playlist',
          onclick: () => {
            const items = currentScreen().items;
            items.splice(i, 1);
            state.openSchedule.delete(it.id);
            persist();
            render();
          },
        },
        '✕',
      ),
    ),
  );
  if (open) row.append(scheduleEditor(it, summary));
  return row;
}

function playlistPanel(screen) {
  const list = h('div', { class: 'list' });
  screen.items.forEach((it, i) => list.append(itemRow(it, i, screen.items.length)));

  const imageSecs = screen.items.reduce((n, it) => {
    const m = mediaBySha(it.sha256);
    return m && m.type === 'image' ? n + (it.durationSec || 10) : n;
  }, 0);

  const picker = h('div', { class: 'card picker' }, h('h3', {}, 'Mídias para adicionar'));
  if (!state.library.length) picker.append(h('p', { class: 'muted' }, 'Nenhuma mídia ainda.'), h('button', { class: 'btn primary', onclick: () => setTab('library') }, 'Adicionar mídias'));
  for (const m of state.library) {
    picker.append(
      h(
        'div',
        { class: 'mini' },
        thumb(m, ''),
        h('div', { class: 'name', title: m.name }, m.name),
        h(
          'button',
          {
            class: 'btn small primary',
            title: 'Adicionar ao fim da playlist',
            'aria-label': `Adicionar ${m.name} à playlist`,
            onclick: () => {
              screen.items.push({ id: uid(), sha256: m.sha256, durationSec: 10, schedule: null });
              persist();
              render();
            },
          },
          'Adicionar',
        ),
      ),
    );
  }

  return h(
    'div',
    {},
    h('p', { class: 'sub' }, `${screen.items.length} item(ns)${imageSecs ? ` · ${imageSecs}s só das imagens` : ''}. Arraste pela alça para reordenar. As mudanças só chegam à TV depois de publicar.`),
    h('div', { class: 'two-col' }, screen.items.length ? list : h('div', { class: 'card empty' }, h('b', {}, 'Playlist vazia'), h('span', { class: 'muted' }, 'Escolha mídias na lista ao lado para montar a programação desta tela.')), picker),
  );
}

// ---------- estado de cada tela (publicação e TV) ----------

const sig = (s) => JSON.stringify({ items: s.items, settings: s.settings });

/** Há mudanças na playlist/ajustes que a TV ainda não recebeu? */
function isDirty(s) {
  if (s.publishedSig) return s.publishedSig !== sig(s);
  return !s.revision && s.items.length > 0; // nunca publicada e já tem itens
}

const PRESENCE = {
  online: ['Online', 'ok'],
  late: ['Sem sinal recente', 'warn'],
  offline: ['Offline', 'err'],
  none: ['Sem relatório', 'muted'],
};
const SYNC_STATE = { online: 'Conectado', idle: 'Conectado', offline: 'Sem internet (toca do disco)', error: 'Com erro', downloading: 'Baixando mídias', checking: 'Verificando' };

function ago(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 90) return 'agora há pouco';
  if (sec < 5400) return `há ${Math.round(sec / 60)} min`;
  if (sec < 172800) return `há ${Math.round(sec / 3600)} h`;
  return `há ${Math.round(sec / 86400)} dias`;
}

async function loadMonitor(auto) {
  if (!api.monitor) return;
  if (!auto && state.monitor === undefined) state.monitor = null;
  try {
    state.monitor = await api.monitor.list();
  } catch (e) {
    state.monitor = { rows: [], error: e.message };
  }
  if (state.tab === 'home' || state.tab === 'screens') {
    render();
    clearTimeout(loadMonitor.timer);
    loadMonitor.timer = setTimeout(() => (state.tab === 'home' || state.tab === 'screens') && loadMonitor(true), 30000);
  }
}

const rowFor = (id) => (state.monitor && state.monitor.rows ? state.monitor.rows.find((r) => r.id === id) || null : null);

function chip(label, cls) {
  return h('span', { class: `chip ${cls}` }, h('i', { class: 'dot' }), label);
}

function tvChip(row) {
  if (!api.monitor) return null;
  if (state.monitor === undefined || state.monitor === null) return h('span', { class: 'chip muted' }, 'Consultando…');
  const [label, cls] = PRESENCE[row ? row.presence : 'none'];
  return chip(label, cls);
}

/** "v0.1.8 · atual", "v0.1.5 · desatualizada" etc. */
function versionText(row) {
  if (!row || !row.version) return null;
  const note = row.versionState === 'old' ? h('span', { class: 'warn' }, ' · desatualizada') : row.versionState === 'latest' ? h('span', { class: 'ok' }, ' · atual') : null;
  return h('span', {}, `Player v${row.version}`, note);
}

// ---------- publicar ----------

function storageReady() {
  const s = state.settings;
  if (s.type === 'folder') return Boolean(s.folderPath);
  return Boolean(s.endpoint && s.bucket && s.hasKeys);
}

function playerConfigText() {
  const cfg = { baseUrl: state.settings.baseUrl || '', screenId: state.screenId, pollSeconds: state.settings.privateBucket ? 120 : 60 };
  if (state.settings.privateBucket) {
    // Chave SOMENTE DE LEITURA (diferente da de gravação, que nunca sai do painel).
    cfg.keyId = 'COLE_O_KEYID_DE_LEITURA';
    cfg.secretKey = 'COLE_A_APPLICATIONKEY_DE_LEITURA';
  }
  return JSON.stringify(cfg, null, 2);
}

async function runPublish(screen) {
  if (state.publishing) return;
  if (!screen.items.length && !confirm('A playlist está vazia: a TV ficará sem conteúdo. Publicar mesmo assim?')) return;
  state.publishing = true;
  state.lastPublish = null;
  state.publishLog = [];
  state.screenTab = 'publish';
  render();
  try {
    state.lastPublish = await api.publish.run(screen.id);
    screen.revision = state.lastPublish.revision;
    screen.publishedSig = sig(screen);
    persist();
    toast(`Publicado: revisão ${state.lastPublish.revision}`, 'success');
    if (api.monitor) loadMonitor(true);
  } catch (e) {
    state.publishLog.push(`ERRO: ${e.message}`);
    toast(e.message, 'error');
  } finally {
    state.publishing = false;
    render();
  }
}

function publishPanel(screen) {
  const ready = storageReady();
  const row = rowFor(screen.id);
  const dirty = isDirty(screen);
  const logEl = h('pre', { class: 'log' }, state.publishLog.join('\n'));
  const tvRev = row && row.report && row.report.revision !== null && row.report.revision !== undefined ? row.report.revision : null;

  return h(
    'div',
    { class: 'form' },
    h('p', { class: 'sub' }, 'Envia as mídias novas e, por último, a programação. As TVs sincronizam sozinhas na próxima consulta (em geral, até 2 minutos).'),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'facts' },
        h('div', {}, h('span', { class: 'muted' }, 'Itens na playlist'), h('b', {}, String(screen.items.length))),
        h('div', {}, h('span', { class: 'muted' }, 'Revisão publicada'), h('b', {}, screen.revision || '—')),
        tvRev !== null ? h('div', {}, h('span', { class: 'muted' }, 'Revisão na TV'), h('b', {}, String(tvRev))) : null,
        h('div', {}, h('span', { class: 'muted' }, 'Situação'), dirty ? h('b', { class: 'warn' }, 'Mudanças não publicadas') : h('b', { class: 'ok' }, screen.revision ? 'Em dia' : 'Nada a publicar')),
      ),
      h('button', { class: 'btn primary big', disabled: state.publishing || !ready, onclick: () => runPublish(screen) }, state.publishing ? 'Publicando…' : dirty ? 'Publicar agora' : 'Publicar de novo'),
      ready ? null : h('p', { class: 'warn', style: 'margin-bottom:0' }, 'Armazenamento não configurado. ', h('button', { class: 'linkbtn', onclick: () => setTab('settings') }, 'Abrir Configurações')),
      state.publishing || state.publishLog.length ? h('div', { style: 'margin-top:14px;display:flex;flex-direction:column;gap:10px' }, h('div', { class: 'progress' }, h('div', { id: 'pub-bar' })), logEl) : null,
      state.lastPublish ? h('p', { class: 'ok', style: 'margin-bottom:0' }, `Pronto: revisão ${state.lastPublish.revision} · ${state.lastPublish.uploaded} mídia(s) enviada(s), ${state.lastPublish.skipped} já estavam no bucket.`) : null,
    ),
  );
}

// ---------- conectar uma TV ----------

function viewConnect() {
  if (api.pair && state.pair === undefined) loadPair();
  const s = state.settings;
  const needs = [];
  if (!storageReady()) needs.push('conectar ao Backblaze');
  else if (s.privateBucket && !s.hasReadKey) needs.push('informar a chave de leitura do player');

  const method = (title, body) => h('div', { class: 'method' }, h('b', {}, title), h('p', { class: 'muted' }, body));

  const pairBlock = !api.pair
    ? null
    : h(
        'div',
        { class: 'card' },
        state.pair && state.pair.ok
          ? h(
              'div',
              {},
              h('h3', {}, 'PC novo (recomendado)'),
              h('p', { class: 'muted', style: 'margin-top:0' }, 'Abra o Prompt de Comando no PC da TV, cole o comando e pressione Enter. Ele instala o Player já conectado e escolhe a tela.'),
              h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => navigator.clipboard.writeText(installCommand(state.pair.code)).then(() => toast('Comando de instalação copiado', 'success')) }, 'Copiar comando de instalação')),
              h(
                'details',
                { class: 'more' },
                h('summary', {}, 'Player já instalado na TV'),
                method('Arquivo pair.txt', 'Baixe o arquivo e coloque num pendrive (ou na pasta Downloads do PC da TV) antes de abrir o Player. Ele se conecta sozinho.'),
                h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => downloadText('pair.txt', state.pair.code) }, 'Baixar pair.txt')),
                method('Colar o código', 'No Player: Ctrl+Shift+M, Conexão com o admin, Colar código copiado.'),
                h('textarea', { class: 'code', rows: '3', readonly: true, style: 'width:100%;box-sizing:border-box' }, state.pair.code),
                h('div', { class: 'row wrap', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(state.pair.code).then(() => toast('Código copiado', 'success')) }, 'Copiar código')),
              ),
              h('p', { class: 'warn', style: 'margin:12px 0 0;font-size:13px' }, 'Trate o comando e o código como senha: levam a chave de leitura do bucket (e a de status, que só grava em status/). Não publique nem envie em grupos.'),
              s.privateBucket && !s.hasStatusKey ? h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:13px' }, 'Sem a chave de status, a TV funciona, mas não aparece online no Início. ', h('button', { class: 'linkbtn', onclick: () => setTab('settings') }, 'Informar a chave de status')) : null,
            )
          : state.pair
            ? h('div', {}, h('p', { class: 'warn', style: 'margin-top:0' }, state.pair.error), h('button', { class: 'btn', onclick: () => setTab('settings') }, 'Abrir Configurações'))
            : h('p', { class: 'muted', style: 'margin:0' }, 'Gerando código…'),
      );

  const configBlock = h(
    'details',
    { class: 'card more' },
    h('summary', {}, 'Avançado: configuração do player em JSON'),
    h('p', { class: 'muted', style: 'margin-top:8px' }, 'Alternativa ao código: no player, Ctrl+Shift+M, Conexão com o admin, Avançado, e cole este JSON.'),
    h('pre', { class: 'code' }, playerConfigText()),
    (() => {
      // Cada consulta do player ao manifesto conta como uma leitura; o limite gratuito diário do B2 é compartilhado por todos os players.
      const poll = Number(JSON.parse(playerConfigText()).pollSeconds) || 60;
      const perDay = Math.ceil(86400 / poll);
      const over = perDay > 1250;
      return h('p', { class: over ? 'warn' : 'muted', style: 'margin:8px 0 0;font-size:13px' }, `Cada player consulta a cada ${poll} s: cerca de ${perDay} leituras por dia, de ~2.500 gratuitas por dia no B2 (somando todos os players e o painel).${over ? ' Com 2 ou mais players, aumente o intervalo.' : ''}`);
    })(),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(playerConfigText()).then(() => toast('Copiado', 'success')) }, 'Copiar')),
    state.settings.baseUrl ? null : h('p', { class: 'warn' }, 'Defina a URL pública do bucket em Configurações.'),
  );

  return h(
    'div',
    { class: 'form' },
    h('h2', {}, 'Conectar uma TV'),
    h('p', { class: 'sub' }, 'Liga o Player de uma TV a este painel. Cada TV escolhe a sua tela depois de conectada.'),
    needs.length ? h('div', { class: 'callout warn-box' }, h('b', {}, `Falta ${needs.join(' e ')}.`), h('button', { class: 'btn', onclick: () => setTab('settings') }, 'Abrir Configurações')) : null,
    needs.length ? null : pairBlock,
    needs.length ? null : configBlock,
  );
}

// ---------- telas ----------

function screenSettingsPanel(screen) {
  const takenFit = [['contain', 'Conter (sem cortar)'], ['cover', 'Preencher (corta as bordas)'], ['fill', 'Esticar']];
  return h(
    'div',
    { class: 'form' },
    h('p', { class: 'sub' }, 'O ID identifica a tela no Player e não muda. Ajustes de exibição só chegam à TV depois de publicar.'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'field' }, h('label', {}, 'Nome da tela'), h('input', { type: 'text', value: screen.name, onchange: (e) => { screen.name = e.target.value.trim() || screen.name; persist(); render(); } })),
      h('div', { class: 'field' }, h('label', {}, 'ID (não muda)'), h('input', { type: 'text', value: screen.id, readonly: true })),
      h('div', { class: 'field' }, h('label', {}, 'Ajuste da imagem'), h('select', { onchange: (e) => { screen.settings.fit = e.target.value; persist(); render(); } }, takenFit.map(([v, l]) => h('option', { value: v, selected: screen.settings.fit === v }, l)))),
      h('div', { class: 'field' }, h('label', {}, 'Transição entre itens (ms)'), h('input', { type: 'number', min: '0', max: '5000', step: '100', value: screen.settings.transitionMs, onchange: (e) => { screen.settings.transitionMs = Math.max(0, Math.min(5000, Number(e.target.value) || 0)); persist(); render(); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: screen.settings.muted, onchange: (e) => { screen.settings.muted = e.target.checked; persist(); render(); } }), ' Vídeos sem som'),
    ),
    h(
      'div',
      { class: 'card danger-zone' },
      h('h3', {}, 'Excluir tela'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Remove esta tela e a sua playlist do painel. O que já foi publicado no bucket não é apagado.'),
      h(
        'button',
        {
          class: 'btn danger',
          disabled: state.project.screens.length === 1,
          title: state.project.screens.length === 1 ? 'Mantenha ao menos uma tela' : '',
          onclick: () => {
            if (!confirm(`Excluir a tela "${screen.name}" e a sua playlist?`)) return;
            state.project.screens = state.project.screens.filter((x) => x.id !== screen.id);
            state.screenId = state.project.screens[0].id;
            persist();
            render();
          },
        },
        'Excluir esta tela',
      ),
    ),
  );
}

function newScreenForm() {
  const takenIds = state.project.screens.map((s) => s.id);
  const name = h('input', { type: 'text', placeholder: 'Nome (ex.: Vitrine)', 'aria-label': 'Nome da nova tela' });
  const create = () => {
    const n = name.value.trim();
    if (!n) return toast('Informe o nome da tela', 'error');
    const id = slugify(n, takenIds);
    state.project.screens.push({ id, name: n, revision: 0, settings: { fit: 'contain', transitionMs: 600, muted: true }, items: [] });
    state.screenId = id;
    state.screenTab = 'playlist';
    state.newScreen = false;
    persist();
    render();
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create());
  setTimeout(() => name.focus(), 0);
  return h('div', { class: 'newscreen' }, name, h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: create }, 'Criar'), h('button', { class: 'btn small', onclick: () => ((state.newScreen = false), render()) }, 'Cancelar')));
}

const SCREEN_TABS = [
  ['playlist', 'Playlist'],
  ['publish', 'Publicar'],
  ['settings', 'Ajustes'],
];

function viewScreens() {
  if (api.monitor && state.monitor === undefined) loadMonitor();
  const screen = currentScreen();
  const dirty = isDirty(screen);
  const row = rowFor(screen.id);

  const list = h(
    'nav',
    { class: 'screen-list', 'aria-label': 'Telas' },
    state.project.screens.map((s) =>
      h(
        'button',
        { class: `screen-item${s.id === state.screenId ? ' active' : ''}`, 'aria-current': s.id === state.screenId ? 'page' : null, onclick: () => { state.screenId = s.id; state.lastPublish = null; state.publishLog = []; render(); } },
        h('span', { class: 'sname' }, s.name),
        isDirty(s) ? h('span', { class: 'pend', title: 'Mudanças não publicadas' }, 'não publicada') : null,
      ),
    ),
    state.newScreen ? newScreenForm() : h('button', { class: 'btn small add-screen', onclick: () => ((state.newScreen = true), render()) }, '+ Nova tela'),
  );

  const content = { playlist: playlistPanel, publish: publishPanel, settings: screenSettingsPanel }[state.screenTab] || playlistPanel;

  return h(
    'div',
    { class: 'split' },
    list,
    h(
      'section',
      { class: 'detail' },
      h(
        'div',
        { class: 'detail-head' },
        h('div', {}, h('h2', {}, screen.name), h('div', { class: 'meta-line' }, tvChip(row), versionText(row), row && row.report && row.report.playing ? h('span', { class: 'muted' }, `Tocando: ${row.report.playing}`) : null)),
      ),
      dirty
        ? h(
            'div',
            { class: 'callout warn-box' },
            h('span', {}, h('b', {}, 'Mudanças não publicadas.'), ' A TV só vê a nova programação depois de publicar.'),
            state.screenTab === 'publish' ? null : h('button', { class: 'btn primary', disabled: state.publishing || !storageReady(), onclick: () => runPublish(screen) }, 'Publicar agora'),
          )
        : null,
      h('div', { class: 'seg', role: 'tablist' }, SCREEN_TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': state.screenTab === id ? 'true' : 'false', class: state.screenTab === id ? 'active' : '', onclick: () => ((state.screenTab = id), render()) }, label))),
      content(screen),
    ),
  );
}

// ---------- início ----------

function viewHome() {
  if (api.monitor && state.monitor === undefined) loadMonitor();
  const screens = state.project.screens;
  const m = state.monitor;
  const anyReport = Boolean(m && (m.rows || []).some((r) => r.presence !== 'none'));

  const steps = [
    { done: storageReady(), label: 'Conectar ao Backblaze', hint: 'Informe o bucket e as chaves.', go: () => setTab('settings') },
    { done: state.library.length > 0, label: 'Adicionar mídias', hint: 'Envie as imagens e vídeos.', go: () => setTab('library') },
    { done: screens.some((s) => s.items.length > 0), label: 'Montar a playlist', hint: 'Escolha o que cada tela exibe.', go: () => ((state.screenTab = 'playlist'), setTab('screens')) },
    { done: screens.some((s) => s.revision > 0), label: 'Publicar', hint: 'Envie a programação para as TVs.', go: () => ((state.screenTab = 'publish'), setTab('screens')) },
    { done: anyReport, label: 'Conectar uma TV', hint: 'Instale o Player e pareie.', go: () => setTab('connect') },
  ];
  const next = steps.findIndex((s) => !s.done);

  const checklist =
    next < 0
      ? null
      : h(
          'div',
          { class: 'card next' },
          h('div', { class: 'next-main' }, h('div', { class: 'muted' }, `Próximo passo (${next + 1} de ${steps.length})`), h('h3', {}, steps[next].label), h('p', { class: 'muted' }, steps[next].hint)),
          h('button', { class: 'btn primary big', onclick: steps[next].go }, 'Continuar'),
          h('ol', { class: 'steps' }, steps.map((s, i) => h('li', { class: s.done ? 'done' : i === next ? 'current' : '' }, h('button', { class: 'linkbtn', onclick: s.go }, s.label)))),
        );

  const cards = screens.map((s) => {
    const row = rowFor(s.id);
    const dirty = isDirty(s);
    return h(
      'div',
      { class: 'card screen-card' },
      h('div', { class: 'row' }, h('h3', { class: 'sc-name' }, s.name), h('span', { class: 'spacer' }), tvChip(row)),
      h('div', { class: 'muted sc-line' }, `${s.items.length} item(ns) · revisão ${s.revision || '—'}`),
      versionText(row) ? h('div', { class: 'sc-line' }, versionText(row)) : null,
      row && row.report && row.report.playing ? h('div', { class: 'muted sc-line' }, `Tocando: ${row.report.playing}`) : null,
      row && row.report ? h('div', { class: 'muted sc-line' }, `Último sinal ${ago(row.ageSec)}`) : null,
      dirty ? h('div', { class: 'warn sc-line' }, 'Mudanças não publicadas') : null,
      h(
        'div',
        { class: 'row sc-actions' },
        h('button', { class: `btn${dirty ? ' primary' : ''}`, onclick: () => ((state.screenId = s.id), (state.screenTab = 'publish'), setTab('screens')) }, dirty ? 'Publicar' : 'Publicação'),
        h('button', { class: 'btn', onclick: () => ((state.screenId = s.id), (state.screenTab = 'playlist'), setTab('screens')) }, 'Playlist'),
      ),
    );
  });

  const hasStatusKey = state.settings.hasStatusKey;
  return h(
    'div',
    {},
    h('div', { class: 'row wrap' }, h('h2', { style: 'margin:0' }, 'Início'), h('span', { class: 'spacer' }), api.monitor ? h('button', { class: 'btn small', onclick: () => loadMonitor() }, 'Atualizar') : null),
    h('p', { class: 'sub' }, 'Resumo das suas telas e o que fazer a seguir.'),
    checklist,
    h('h3', { class: 'section-title' }, 'Suas telas'),
    h('div', { class: 'cards' }, cards),
    m && (m.error || m.listError) ? h('p', { class: 'warn' }, `Não foi possível ler o status das TVs: ${m.error || m.listError}`) : null,
    api.monitor && !hasStatusKey && state.settings.privateBucket
      ? h('p', { class: 'muted note' }, 'Para ver aqui se cada TV está online e qual versão usa, informe a chave de status em ', h('button', { class: 'linkbtn', onclick: () => setTab('settings') }, 'Configurações'), ' e pareie as TVs de novo.')
      : api.monitor && m && (m.rows || []).some((r) => r.presence === 'none')
        ? h('p', { class: 'muted note' }, '"Sem relatório": a TV nunca enviou o status. Pode ser um Player anterior à 0.1.8 (funciona normalmente, só não relata) ou uma TV pareada sem a chave de status.')
        : null,
    quotaBar(),
  );
}

// ---------- configurações ----------

function viewSettings() {
  const d = state.settingsDraft;
  const keyId = h('input', { type: 'text', placeholder: state.settings.hasKeys ? '•••• (salvo — preencha só para trocar)' : 'keyID da Application Key', autocomplete: 'off' });
  const appKey = h('input', { type: 'password', placeholder: state.settings.hasKeys ? '•••• (salva)' : 'applicationKey', autocomplete: 'off' });
  const readKeyId = h('input', { type: 'text', value: state.settings.readKeyId || '', placeholder: 'keyID da chave SOMENTE LEITURA', autocomplete: 'off' });
  const readAppKey = h('input', { type: 'password', placeholder: state.settings.hasReadKey ? '•••• (salva)' : 'applicationKey da chave somente leitura', autocomplete: 'off' });
  const statusKeyId = h('input', { type: 'text', value: state.settings.statusKeyId || '', placeholder: 'keyID da chave de STATUS (só grava em status/)', autocomplete: 'off' });
  const statusAppKey = h('input', { type: 'password', placeholder: state.settings.hasStatusKey ? '•••• (salva)' : 'applicationKey da chave de status', autocomplete: 'off' });
  const result = h('span', { class: state.testResult && state.testResult.ok ? 'ok' : 'err' }, state.testResult ? (state.testResult.ok ? 'Conexão OK: gravou e apagou um arquivo de teste.' : `Falhou: ${state.testResult.error}`) : '');

  const text = (label, key, placeholder, help) =>
    h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'text', value: d[key] || '', placeholder: placeholder || '', onchange: (e) => (d[key] = e.target.value.trim()) }), help ? h('div', { class: 'muted', style: 'font-size:12px' }, help) : null);

  const endpointInput = h('input', {
    type: 'text',
    value: d.endpoint || '',
    placeholder: 'https://s3.us-west-004.backblazeb2.com',
    onchange: (e) => {
      d.endpoint = e.target.value.trim();
      const m = /s3\.([^.]+)\.backblazeb2/.exec(d.endpoint);
      if (m && !d.region) {
        d.region = m[1];
        render();
      }
    },
  });

  const saved = (ok) => h('span', { class: ok ? 'ok' : 'muted' }, ok ? '✓ salva' : 'não informada');
  const help = (t) => h('div', { class: 'muted', style: 'font-size:12px' }, t);

  const b2 = h(
    'div',
    {},
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Conexão com o Backblaze'),
      h('div', { class: 'field' }, h('label', {}, 'Endpoint S3 do bucket'), endpointInput),
      text('Região', 'region', 'us-west-004', 'Preenchida sozinha a partir do endpoint.'),
      text('Nome do bucket', 'bucket', 'minha-loja-midias'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(d.privateBucket), onchange: (e) => { d.privateBucket = e.target.checked; render(); } }), ' Bucket privado (o player lê com uma chave somente de leitura)'),
      text('URL pública do bucket (opcional)', 'publicBaseUrl', 'https://<bucket>.s3.<região>.backblazeb2.com', 'Se vazio, usa https://<bucket>.<host do endpoint>. O bucket precisa estar com leitura pública.'),
      h('div', { class: 'field' }, h('label', {}, 'Key ID da chave de leitura e escrita ', saved(state.settings.hasKeys)), keyId),
      h('div', { class: 'field' }, h('label', {}, 'Application Key'), appKey, help('Fica criptografada neste computador e nunca vai para o player. Use uma chave com acesso só a este bucket.')),
    ),
    d.privateBucket
      ? h(
          'div',
          { class: 'card' },
          h('h3', {}, 'Chaves dos players'),
          h('div', { class: 'field' }, h('label', {}, 'Chave de leitura ', saved(state.settings.hasReadKey), ' · necessária para gerar o código de pareamento'), readKeyId, readAppKey, help('Crie no B2 uma segunda chave, restrita ao bucket, com acesso Read Only. Ela vai dentro do código de pareamento; a chave de gravação nunca.')),
          h('div', { class: 'field' }, h('label', {}, 'Chave de status ', saved(state.settings.hasStatusKey), ' · opcional, mostra no Início se cada TV está online'), statusKeyId, statusAppKey, help('Crie no B2 uma terceira chave, restrita ao bucket e ao prefixo status/, com permissão só de escrita (Write Only). Os players a usam apenas para relatar versão e estado; ela não lê nem apaga nada fora de status/.')),
        )
      : null,
  );

  const folder = h(
    'div',
    {},
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Pasta de destino (simula o bucket, para testes)'),
      h(
        'div',
        { class: 'row' },
        h('input', { type: 'text', value: d.folderPath || '', style: 'flex:1', onchange: (e) => (d.folderPath = e.target.value.trim()) }),
        h('button', { class: 'btn', onclick: async () => { const p = await api.settings.pickFolder(); if (p) { d.folderPath = p; render(); } } }, 'Escolher…'),
      ),
    ),
    text('URL pública', 'publicBaseUrl', 'http://localhost:8080', 'Sirva a pasta com: npm run dev-server -- "<pasta>" 8080'),
  );

  const save = async () => {
    const keys = keyId.value.trim() && appKey.value ? { keyId: keyId.value.trim(), appKey: appKey.value } : null;
    const readKeys = readKeyId.value.trim() && readAppKey.value ? { keyId: readKeyId.value.trim(), appKey: readAppKey.value } : null;
    const statusKeys = statusKeyId.value.trim() && statusAppKey.value ? { keyId: statusKeyId.value.trim(), appKey: statusAppKey.value } : null;
    try {
      state.settings = await api.settings.save({ type: d.type, endpoint: d.endpoint, region: d.region, bucket: d.bucket, publicBaseUrl: d.publicBaseUrl, privateBucket: Boolean(d.privateBucket), folderPath: d.folderPath }, keys, readKeys, statusKeys);
      state.pair = undefined; // regera o código de pareamento com os dados novos
      state.settingsDraft = { ...state.settings };
      toast('Configurações salvas', 'success');
      render();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return h(
    'div',
    { class: 'form' },
    h('h2', {}, 'Configurações'),
    h('p', { class: 'sub' }, 'Conexão com o Backblaze, chaves dos players e manutenção.'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Armazenamento'),
      h('select', { onchange: (e) => { d.type = e.target.value; render(); } }, h('option', { value: 'b2', selected: d.type === 'b2' }, 'Backblaze B2'), api.web ? null : h('option', { value: 'folder', selected: d.type === 'folder' }, 'Pasta local (teste)')),
    ),
    d.type === 'b2' || api.web ? b2 : folder,
    h(
      'div',
      { class: 'row wrap savebar' },
      h('button', { class: 'btn primary', onclick: save }, 'Salvar'),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            await save();
            state.testResult = await api.settings.test();
            render();
          },
        },
        'Salvar e testar conexão',
      ),
      result,
    ),
    updateBlock(),
    api.web
      ? h(
          'div',
          { class: 'card', style: 'margin-top:22px' },
          h('h3', {}, 'Este navegador'),
          h('p', { class: 'muted', style: 'margin-top:0' }, 'As chaves ficam criptografadas aqui. Biblioteca e playlists ficam no seu bucket (pasta admin/), então valem para qualquer navegador.'),
          h(
            'div',
            { class: 'row wrap' },
            h('button', { class: 'btn', onclick: () => api.logout() }, 'Sair (bloquear)'),
            h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  if (!confirm('Apagar do bucket as mídias que não estão na biblioteca nem em nenhuma tela publicada?')) return;
                  try {
                    const r = await api.cleanOrphans();
                    const heldBytes = (r.held || []).reduce((n, o) => n + o.size, 0);
                    const heldMsg = r.held && r.held.length ? `
${r.held.length} arquivo(s) (${formatSize(heldBytes)}) continuam porque a tela publicada "${[...new Set(r.held.flatMap((o) => o.screens))].join('", "')}" ainda os usa. Monte a playlist nova, clique em Publicar e rode a limpeza de novo.` : '';
                    toast((r.removed ? `${r.removed} arquivo(s) órfão(s) apagado(s) (${formatSize(r.bytes)})` : 'Nenhuma mídia órfã para apagar') + heldMsg, r.held && r.held.length && !r.removed ? 'error' : 'success');
                    loadQuota(true);
                  } catch (e) {
                    toast(e.message, 'error');
                  }
                },
              },
              'Limpar mídias órfãs do bucket',
            ),
          ),
        )
      : null,
  );
}

// ---------- shell ----------

function renderHeader() {
  const pending = state.project.screens.filter(isDirty).length;
  document.getElementById('tabs').replaceChildren(
    ...TABS.map(([id, label]) =>
      h(
        'button',
        { class: state.tab === id ? 'active' : '', 'aria-current': state.tab === id ? 'page' : null, onclick: () => setTab(id) },
        label,
        id === 'screens' && pending ? h('span', { class: 'nav-dot', title: 'Há mudanças não publicadas', 'aria-label': 'mudanças não publicadas' }) : null,
      ),
    ),
  );
}

function render() {
  renderHeader();
  const views = { home: viewHome, screens: viewScreens, library: viewLibrary, connect: viewConnect, settings: viewSettings };
  const view = document.getElementById('view');
  const scroll = view.scrollTop;
  view.replaceChildren((views[state.tab] || viewHome)());
  view.scrollTop = scroll;
}

// Nomes antigos das abas continuam valendo (testes automatizados e atalhos do app de mesa).
const LEGACY_TABS = { playlist: ['screens', 'playlist'], publish: ['screens', 'publish'], monitor: ['home', null] };

function setTab(tab) {
  if (LEGACY_TABS[tab]) {
    const [t, sub] = LEGACY_TABS[tab];
    tab = t;
    if (sub) state.screenTab = sub;
  }
  state.tab = tab;
  if (tab === 'settings') state.settingsDraft = { ...state.settings };
  render();
  document.getElementById('view').scrollTop = 0;
}
window.__goto = setTab; // usado nos testes automatizados

api.publish.onProgress((p) => {
  state.publishLog.push(p.message);
  const bar = document.getElementById('pub-bar');
  if (bar) bar.style.width = `${Math.round((p.pct || 0) * 100)}%`;
  const log = document.querySelector('pre.log');
  if (log) {
    log.textContent = state.publishLog.join('\n');
    log.scrollTop = log.scrollHeight;
  }
});

if (api.update && api.update.onProgress) api.update.onProgress((p) => toast(`Baixando a atualização… ${Math.round(p * 100)}%`, 'info'));

// Versão web: andamento do cálculo e do envio dos arquivos.
if (api.library.onProgress) api.library.onProgress((m) => toast(m, 'info'));

// Soltar arquivos na janela adiciona à biblioteca (e impede o Electron de "abrir" o arquivo).
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
    document.querySelector('.dropzone')?.classList.add('over');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.querySelector('.dropzone')?.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  document.querySelector('.dropzone')?.classList.remove('over');
  addPaths([...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)).catch((err) => toast(err.message, 'error'));
});

async function boot() {
  const [project, library, settings] = await Promise.all([api.project.get(), api.library.list(), api.settings.get()]);
  state.project = project;
  state.library = library;
  state.settings = settings;
  state.settingsDraft = { ...settings };
  state.screenId = project.screens[0].id;
  // Telas já publicadas antes do controle de mudanças: o estado atual vale como o publicado.
  for (const sc of project.screens) if (sc.revision > 0 && !sc.publishedSig) sc.publishedSig = sig(sc);
  render();
  loadQuota(false);
  checkUpdate(false); // avisa se há versão nova (só no app de mesa)
}

boot().catch((e) => {
  document.getElementById('view').textContent = `Erro ao iniciar: ${e.message}`;
});
