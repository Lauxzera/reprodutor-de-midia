'use strict';

const api = window.panelApi;

const TABS = [
  ['library', 'Biblioteca'],
  ['playlist', 'Playlist'],
  ['publish', 'Publicar'],
  ['screens', 'Telas'],
  ['settings', 'Configurações'],
];
const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const state = {
  tab: 'library',
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
    h('h2', {}, 'Biblioteca'),
    h('p', { class: 'sub' }, api.web ? 'Arquivos disponíveis para as playlists. Cada arquivo é enviado ao seu bucket do B2.' : 'Arquivos disponíveis para as playlists. Cada arquivo é copiado para o painel.'),
    quotaBar(),
    zone,
    state.library.length ? grid : h('p', { class: 'muted' }, 'Nenhuma mídia ainda.'),
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

function viewPlaylist() {
  const screen = currentScreen();
  const list = h('div', { class: 'list' });
  screen.items.forEach((it, i) => list.append(itemRow(it, i, screen.items.length)));

  const imageSecs = screen.items.reduce((n, it) => {
    const m = mediaBySha(it.sha256);
    return m && m.type === 'image' ? n + (it.durationSec || 10) : n;
  }, 0);

  const picker = h('div', { class: 'card' }, h('h3', {}, 'Biblioteca'));
  if (!state.library.length) picker.append(h('p', { class: 'muted' }, 'Adicione arquivos na aba Biblioteca.'));
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
            onclick: () => {
              screen.items.push({ id: uid(), sha256: m.sha256, durationSec: 10, schedule: null });
              persist();
              render();
            },
          },
          '+',
        ),
      ),
    );
  }

  return h(
    'div',
    {},
    h('h2', {}, `Playlist — ${screen.name}`),
    h('p', { class: 'sub' }, `${screen.items.length} item(ns)${imageSecs ? ` · ${imageSecs}s só das imagens` : ''}. Arraste para reordenar. Depois de editar, vá em Publicar.`),
    h(
      'div',
      { class: 'two-col' },
      screen.items.length ? list : h('div', { class: 'card muted' }, 'Playlist vazia. Adicione mídias da biblioteca ao lado.'),
      picker,
    ),
  );
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

function viewPublish() {
  const screen = currentScreen();
  const ready = storageReady();
  const bar = h('div', { style: 'width:0' });
  const logEl = h('pre', { class: 'log' }, state.publishLog.join('\n'));
  const btn = h('button', { class: 'btn primary', disabled: state.publishing || !ready }, state.publishing ? 'Publicando…' : 'Publicar agora');

  btn.addEventListener('click', async () => {
    if (!screen.items.length && !confirm('A playlist está vazia: a TV ficará sem conteúdo. Publicar mesmo assim?')) return;
    state.publishing = true;
    state.lastPublish = null;
    state.publishLog = [];
    render();
    try {
      state.lastPublish = await api.publish.run(screen.id);
      screen.revision = state.lastPublish.revision;
      toast(`Publicado: revisão ${state.lastPublish.revision}`, 'success');
    } catch (e) {
      state.publishLog.push(`ERRO: ${e.message}`);
      toast(e.message, 'error');
    } finally {
      state.publishing = false;
      render();
    }
  });

  if (api.pair && state.pair === undefined) loadPair();
  const pairBlock = !api.pair
    ? null
    : h(
        'div',
        { class: 'card', style: 'margin-top:18px' },
        h('h3', {}, 'Parear um player'),
        state.pair && state.pair.ok
          ? h(
              'div',
              {},
              h('p', { class: 'muted', style: 'margin-top:0' }, 'Três jeitos de ligar uma TV, do mais direto ao mais manual:'),
              h('p', { style: 'margin:6px 0' }, h('b', {}, '1. PC novo: '), 'copie o comando, cole no cmd do PC da TV e pronto: instala, conecta e escolhe a tela.'),
              h('p', { style: 'margin:6px 0' }, h('b', {}, '2. Player já instalado: '), 'baixe o pair.txt e coloque num pendrive (ou na pasta Downloads do PC da TV) antes de abrir o Player, ou copie o código e clique em "Colar código copiado" em Conexão com o admin, no painel do Player.'),
              h('p', { style: 'margin:6px 0' }, h('b', {}, '3. Manual: '), 'cole o código no campo da tela Conexão com o admin.'),
              h('textarea', { class: 'code', rows: '4', readonly: true, style: 'width:100%;box-sizing:border-box' }, state.pair.code),
              h(
                'div',
                { class: 'row', style: 'margin-top:8px;gap:8px;flex-wrap:wrap' },
                h('button', { class: 'btn small primary', onclick: () => navigator.clipboard.writeText(installCommand(state.pair.code)).then(() => toast('Comando de instalação copiado', 'success')) }, 'Copiar comando de instalação'),
                h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(state.pair.code).then(() => toast('Código copiado', 'success')) }, 'Copiar código'),
                h('button', { class: 'btn small', onclick: () => downloadText('pair.txt', state.pair.code) }, 'Baixar pair.txt'),
              ),
              h('p', { class: 'warn', style: 'margin:8px 0 0;font-size:13px' }, 'Trate o código como senha: ele leva a chave de leitura do bucket. Não publique nem envie em grupos.'),
            )
          : state.pair
            ? h('div', {}, h('p', { class: 'warn', style: 'margin-top:0' }, state.pair.error), h('button', { class: 'btn small', onclick: () => setTab('settings') }, 'Abrir Configurações'))
            : h('p', { class: 'muted', style: 'margin-top:0' }, 'Gerando código…'),
      );

  const configBlock = h(
    'details',
    { class: 'card', style: 'margin-top:18px' },
    h('summary', {}, 'Avançado: configuração do player em JSON'),
    h('p', { class: 'muted', style: 'margin-top:8px' }, 'Alternativa ao código: no player, Ctrl+Shift+M > Configurar conexão > Avançado, e cole este JSON.'),
    h('pre', { class: 'code' }, playerConfigText()),
    (() => {
      // Cada consulta do player ao manifesto conta como uma leitura; o limite gratuito diário do B2 é compartilhado por todos os players.
      const poll = Number((JSON.parse(playerConfigText()).pollSeconds)) || 60;
      const perDay = Math.ceil(86400 / poll);
      const over = perDay > 1250;
      return h('p', { class: over ? 'warn' : 'muted', style: 'margin:8px 0 0;font-size:13px' }, `Cada player consulta a cada ${poll} s: cerca de ${perDay} leituras por dia, de ~2.500 gratuitas por dia no B2 (somando todos os players e o painel).${over ? ' Com 2 ou mais players, aumente o intervalo.' : ''}`);
    })(),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(playerConfigText()).then(() => toast('Copiado', 'success')) }, 'Copiar')),
    state.settings.baseUrl ? null : h('p', { class: 'warn' }, 'Defina a URL pública do bucket em Configurações.'),
  );

  return h(
    'div',
    { class: 'form', style: 'max-width:760px' },
    h('h2', {}, `Publicar — ${screen.name}`),
    h('p', { class: 'sub' }, 'Envia as mídias novas e, por último, a programação. Os players sincronizam sozinhos na próxima consulta.'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row wrap', style: 'gap:32px' }, h('div', {}, h('div', { class: 'muted' }, 'Itens na playlist'), h('div', { style: 'font-size:20px' }, screen.items.length)), h('div', {}, h('div', { class: 'muted' }, 'Última revisão publicada'), h('div', { style: 'font-size:20px' }, screen.revision || '—')), h('span', { class: 'spacer' }), btn),
      ready ? null : h('p', { class: 'warn', style: 'margin-bottom:0' }, 'Armazenamento não configurado. Vá em Configurações.'),
      state.publishing || state.publishLog.length ? h('div', { style: 'margin-top:14px;display:flex;flex-direction:column;gap:10px' }, h('div', { class: 'progress' }, h('div', { id: 'pub-bar' })), logEl) : null,
      state.lastPublish ? h('p', { class: 'ok', style: 'margin-bottom:0' }, `Pronto: revisão ${state.lastPublish.revision} · ${state.lastPublish.uploaded} mídia(s) enviada(s), ${state.lastPublish.skipped} já estavam no bucket.`) : null,
    ),
    pairBlock,
    configBlock,
  );
}

// ---------- telas ----------

function viewScreens() {
  const takenIds = state.project.screens.map((s) => s.id);
  const newName = h('input', { type: 'text', placeholder: 'Nome da nova tela (ex.: Vitrine)' });

  const rows = state.project.screens.map((s) =>
    h(
      'tr',
      {},
      h('td', {}, h('input', { type: 'text', value: s.name, onchange: (e) => { s.name = e.target.value.trim() || s.name; persist(); render(); } })),
      h('td', { class: 'muted' }, s.id),
      h('td', {}, h('select', { onchange: (e) => { s.settings.fit = e.target.value; persist(); } }, [['contain', 'Conter (sem cortar)'], ['cover', 'Preencher (corta)'], ['fill', 'Esticar']].map(([v, l]) => h('option', { value: v, selected: s.settings.fit === v }, l)))),
      h('td', {}, h('input', { type: 'number', min: '0', max: '5000', step: '100', value: s.settings.transitionMs, onchange: (e) => { s.settings.transitionMs = Math.max(0, Math.min(5000, Number(e.target.value) || 0)); persist(); } })),
      h('td', {}, h('input', { type: 'checkbox', checked: s.settings.muted, onchange: (e) => { s.settings.muted = e.target.checked; persist(); } })),
      h(
        'td',
        {},
        h(
          'button',
          {
            class: 'btn small danger',
            disabled: state.project.screens.length === 1,
            onclick: () => {
              if (!confirm(`Excluir a tela "${s.name}" e a sua playlist? O que já foi publicado no bucket não é apagado.`)) return;
              state.project.screens = state.project.screens.filter((x) => x.id !== s.id);
              if (state.screenId === s.id) state.screenId = state.project.screens[0].id;
              persist();
              render();
            },
          },
          'Excluir',
        ),
      ),
    ),
  );

  return h(
    'div',
    {},
    h('h2', {}, 'Telas'),
    h('p', { class: 'sub' }, 'Cada tela tem a sua própria playlist e o seu manifesto. O ID identifica a tela no player e não muda.'),
    h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['Nome', 'ID', 'Ajuste da imagem', 'Transição (ms)', 'Vídeo mudo', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))),
    h(
      'div',
      { class: 'row', style: 'margin-top:14px;max-width:480px' },
      newName,
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            const name = newName.value.trim();
            if (!name) return toast('Informe o nome da tela', 'error');
            const id = slugify(name, takenIds);
            state.project.screens.push({ id, name, revision: 0, settings: { fit: 'contain', transitionMs: 600, muted: true }, items: [] });
            state.screenId = id;
            persist();
            render();
          },
        },
        'Criar tela',
      ),
    ),
  );
}

// ---------- configurações ----------

function viewSettings() {
  const d = state.settingsDraft;
  const keyId = h('input', { type: 'text', placeholder: state.settings.hasKeys ? '•••• (salvo — preencha só para trocar)' : 'keyID da Application Key', autocomplete: 'off' });
  const appKey = h('input', { type: 'password', placeholder: state.settings.hasKeys ? '•••• (salva)' : 'applicationKey', autocomplete: 'off' });
  const readKeyId = h('input', { type: 'text', value: state.settings.readKeyId || '', placeholder: 'keyID da chave SOMENTE LEITURA', autocomplete: 'off' });
  const readAppKey = h('input', { type: 'password', placeholder: state.settings.hasReadKey ? '•••• (salva)' : 'applicationKey da chave somente leitura', autocomplete: 'off' });
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

  const b2 = h(
    'div',
    {},
    h('div', { class: 'field' }, h('label', {}, 'Endpoint S3 do bucket'), endpointInput),
    text('Região', 'region', 'us-west-004', 'Preenchida sozinha a partir do endpoint.'),
    text('Nome do bucket', 'bucket', 'minha-loja-midias'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, h('input', { type: 'checkbox', checked: Boolean(d.privateBucket), onchange: (e) => { d.privateBucket = e.target.checked; render(); } }), ' Bucket privado (o player lê com uma chave somente de leitura)'),
    ),
    text('URL pública do bucket (opcional)', 'publicBaseUrl', 'https://<bucket>.s3.<região>.backblazeb2.com', 'Se vazio, usa https://<bucket>.<host do endpoint>. O bucket precisa estar com leitura pública.'),
    h('div', { class: 'field' }, h('label', {}, 'Key ID'), keyId),
    h('div', { class: 'field' }, h('label', {}, 'Application Key'), appKey, h('div', { class: 'muted', style: 'font-size:12px' }, 'Fica criptografada neste computador e nunca vai para o player. Use uma chave com acesso só a este bucket.')),
    d.privateBucket
      ? h(
          'div',
          { class: 'field' },
          h('label', {}, 'Chave de leitura do player (opcional aqui, necessária para gerar o código de pareamento)'),
          readKeyId,
          readAppKey,
          h('div', { class: 'muted', style: 'font-size:12px' }, 'Crie no B2 uma segunda chave, restrita ao bucket, com acesso Read Only. Ela vai dentro do código de pareamento; a chave de gravação nunca.'),
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
    try {
      state.settings = await api.settings.save({ type: d.type, endpoint: d.endpoint, region: d.region, bucket: d.bucket, publicBaseUrl: d.publicBaseUrl, privateBucket: Boolean(d.privateBucket), folderPath: d.folderPath }, keys, readKeys);
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
    h('p', { class: 'sub' }, 'Onde as mídias e a programação são guardadas.'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Armazenamento'),
      h('select', { onchange: (e) => { d.type = e.target.value; render(); } }, h('option', { value: 'b2', selected: d.type === 'b2' }, 'Backblaze B2'), api.web ? null : h('option', { value: 'folder', selected: d.type === 'folder' }, 'Pasta local (teste)')),
    ),
    d.type === 'b2' || api.web ? b2 : folder,
    h(
      'div',
      { class: 'row wrap' },
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
  const sel = document.getElementById('screen-select');
  sel.replaceChildren(...state.project.screens.map((s) => h('option', { value: s.id, selected: s.id === state.screenId }, s.name)));
  sel.onchange = () => {
    state.screenId = sel.value;
    state.lastPublish = null;
    state.publishLog = [];
    render();
  };
  document.getElementById('tabs').replaceChildren(
    ...TABS.map(([id, label]) => h('button', { class: state.tab === id ? 'active' : '', onclick: () => setTab(id) }, label)),
  );
}

function render() {
  renderHeader();
  const views = { library: viewLibrary, playlist: viewPlaylist, publish: viewPublish, screens: viewScreens, settings: viewSettings };
  const view = document.getElementById('view');
  const scroll = view.scrollTop;
  view.replaceChildren(views[state.tab]());
  view.scrollTop = scroll;
}

function setTab(tab) {
  state.tab = tab;
  if (tab === 'settings') state.settingsDraft = { ...state.settings };
  render();
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
  if (!storageReady()) state.tab = 'settings';
  render();
  loadQuota(false);
  checkUpdate(false); // avisa se há versão nova (só no app de mesa)
}

boot().catch((e) => {
  document.getElementById('view').textContent = `Erro ao iniciar: ${e.message}`;
});
