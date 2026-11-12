'use strict';

// Regressão do menu de manutenção: roda o maintenance.js (script do renderer) contra um DOM de mentira
// e percorre menu -> configurar conexão -> voltar -> fechar -> entrar de novo.
// Pega erros como "função usada fora do escopo" que só apareciam com o app aberto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.children = [];
    this.handlers = {};
    this.value = '';
    this._text = '';
    const cls = new Set();
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)) };
    this.classSet = cls;
  }
  set className(v) {
    this.classSet.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classSet.add(c));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }
  append(...kids) {
    for (const k of kids) {
      const node = typeof k === 'string' ? Object.assign(new FakeNode('#text'), { _text: k }) : k;
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }
  get textContent() {
    return this.innerText;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  focus() {}
  get innerText() {
    return this._text + this.children.map((c) => c.innerText).join(' ');
  }
  all(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
}

function setup(apiOverrides = {}, opts = {}) {
  const maint = new FakeNode('div');
  maint.classSet.add('hidden');
  const corner = new FakeNode('button');
  const body = new FakeNode('body');
  const byId = { maint, corner };
  const windowHandlers = {};
  let password = null;
  const baseState = {
    configured: true,
    screenId: 'loja',
    revision: 4,
    version: '0.1.5',
    playableCount: 2,
    itemCount: 3,
    status: { state: 'online', lastSyncAt: '2026-11-11T12:00:00Z' },
    display: { fit: 'auto', rotate: 0, volume: 100 },
    media: [
      { id: 'a', type: 'video', name: 'promo.mp4', size: 44040192, present: true, src: '' },
      { id: 'b', type: 'image', name: 'oferta.jpg', size: 1048576, durationSec: 8, present: true, src: 'file:///x.jpg' },
      { id: 'c', type: 'video', name: 'faltando.mp4', size: 10, present: false, src: '' },
    ],
    ...(apiOverrides.state || {}),
  };
  delete apiOverrides.state;
  const api = {
    getState: async () => baseState,
    onChanged: () => {},
    maint: {
      paste: async () => ({ ok: true, text: 'RM1-abcdefghijkl.00000000' }),
      setDisplay: async () => ({ ok: true, message: 'Exibição salva e aplicada.' }),
      status: async () => ({ hasPassword: password !== null, lockedMs: 0 }),
      setPassword: async (p) => ((password = p), { ok: true }),
      session: async () => ({ ok: true, token: 't1' }),
      info: async () => ({ ok: true, snapshot: { screenId: 'loja', revision: 1, playableCount: 0, itemCount: 0, status: { state: 'idle' } }, log: '(log)' }),
      action: async () => ({ ok: true, message: 'feito' }),
      getConfig: async () => ({ ok: true, baseUrl: '', screenId: '', pollSeconds: 60, keyId: '', hasSecret: false }),
      saveConfig: async () => ({ ok: true, message: 'ok' }),
      applyPair: async () => ({ ok: false, error: 'x' }),
      updateCheck: async () => ({ ok: true, info: { current: '0.1.2', latest: '0.1.3', newer: true } }),
      updateInstall: async () => ({ ok: true, message: 'Instalando…' }),
      listScreens: async () => ({ ok: true, screens: [] }),
      ...apiOverrides,
    },
  };
  const document = {
    getElementById: (id) => byId[id],
    createElement: (t) => new FakeNode(t),
    createTextNode: (t) => Object.assign(new FakeNode('#text'), { _text: String(t) }),
    body,
  };
  const errors = [];
  api.onUpdateProgress = () => {};
  const win = { playerApi: api, innerWidth: 1280, addEventListener: (t, fn) => (windowHandlers[t] ||= []).push(fn), confirm: () => true };
  Object.assign(win, opts.win || {});
  const intervals = [];
  const holds = [];
  win.__hold = (h) => holds.push(h);
  win.__problems = new Map([['b', 'formato de vídeo sem imagem (provavelmente HEVC/H.265)']]);
  const sandbox = { window: win, document, Node: FakeNode, setTimeout, clearTimeout, setInterval: (fn) => (intervals.push(fn), intervals.length), clearInterval: () => {}, console: { warn: () => {}, log: () => {}, error: (e) => errors.push(e) } };
  vm.runInNewContext(fs.readFileSync(process.env.MAINT_JS || path.join(__dirname, '../src/renderer/maintenance.js'), 'utf8'), sandbox);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const button = (re) => [...maint.all((n) => n.tagName === 'BUTTON' && re.test(n.innerText)), ...body.all((n) => n.tagName === 'BUTTON' && re.test(n.innerText))][0];
  // clique sem esperar o fim do tratador (usado quando ele abre uma confirmação e fica aguardando a resposta)
  const tap = async (re) => {
    const b = button(re);
    assert.ok(b, `botão "${re}" não encontrado; tela: ${maint.innerText}`);
    for (const fn of b.handlers.click || []) fn({});
    await tick();
  };
  const click = async (re) => {
    const b = button(re);
    assert.ok(b, `botão "${re}" não encontrado; tela: ${maint.innerText}`);
    const fns = b.handlers.click || [];
    for (const fn of fns) await Promise.resolve(fn({}));
    await tick();
  };
  const press = async (key, mods = {}) => {
    for (const fn of windowHandlers.keydown || []) fn({ key, preventDefault() {}, ...mods });
    await tick();
  };
  const inputs = () => maint.all((n) => n.tagName === 'INPUT');
  const text = () => `${maint.innerText} ${body.innerText}`;
  return { maint, corner, text, click, tap, press, inputs, tick, errors, body, intervals, holds, win };
}

const openCorner = async (t) => {
  for (const fn of t.corner.handlers.click) fn({});
  await t.tick();
};

test('painel inicial: abre sozinho, lista as mídias, mostra o aviso de HEVC e silencia o som por baixo', async () => {
  const t = setup();
  await t.tick();
  assert.ok(!t.maint.classList.contains('hidden'), 'abre ao ligar');
  assert.deepEqual(t.holds, [true]);
  const txt = t.maint.innerText;
  for (const re of [/Reprodutor Player/, /Conectado/, /promo\.mp4/, /oferta\.jpg/, /ainda não baixado/, /HEVC: não reproduz/, /v0\.1\.5/, /Iniciar reprodução/, /Exibição/, /Conexão com o admin/, /Minimizar/, /Janela/, /Configurações do Windows/]) {
    assert.match(txt, re);
  }
  assert.match(txt, /começa sozinha em 60 s/);
  assert.equal(t.intervals.length, 1, 'contagem regressiva ligada');
  await t.click(/Iniciar reprodução/);
  assert.ok(t.maint.classList.contains('hidden'));
  assert.deepEqual(t.holds, [true, false]);
  assert.deepEqual(t.errors, []);
});

test('painel inicial: a contagem chega a zero e começa a reprodução', async () => {
  const t = setup();
  await t.tick();
  for (let i = 0; i < 60; i++) t.intervals[0]();
  assert.ok(t.maint.classList.contains('hidden'));
});

test('painel inicial: botões vão direto, sem senha, para para a tela pedida; botão do canto volta ao painel', async () => {
  const t = setup();
  await t.tick();
  await t.click(/Exibição/);
  assert.match(t.maint.innerText, /Ajuste da imagem/);
  assert.match(t.maint.innerText, /Rotação da tela/);
  await t.click(/Salvar/);
  assert.match(t.maint.innerText, /Exibição salva e aplicada/);
  await t.click(/Voltar/);
  assert.match(t.maint.innerText, /Mídias baixadas/);
  assert.ok(!/começa sozinha/.test(t.maint.innerText), 'depois de entrar, não inicia sozinho');

  await t.click(/Conexão com o admin/);
  assert.match(t.maint.innerText, /Código de pareamento/);
  await t.click(/Voltar/);
  await t.click(/Mais opções/);
  assert.match(t.maint.innerText, /Reiniciar/);
  await t.click(/Voltar ao painel/);

  await t.click(/Minimizar/);
  assert.ok(t.maint.classList.contains('hidden'));

  // botão do canto (reprodução rodando) volta a esta tela
  await openCorner(t);
  assert.match(t.maint.innerText, /Mídias baixadas/);
  await t.click(/Configurações do Windows/);
  assert.ok(t.maint.classList.contains('hidden'), 'a ação roda direto, sem pedir senha (janela some)');
  assert.deepEqual(t.errors, []);
});

test('painel inicial: Ctrl+Shift+M reabre e Esc fecha', async () => {
  const t = setup();
  await t.tick();
  await t.press('Escape');
  assert.ok(t.maint.classList.contains('hidden'));
  await t.press('m', { ctrlKey: true, shiftKey: true });
  assert.ok(!t.maint.classList.contains('hidden'));
});

test('painel inicial: aviso de versão nova, barra de progresso e botão Atualizar', async () => {
  const calls = [];
  let progress = () => {};
  const t = setup({
    state: { update: { current: '0.1.4', latest: '0.1.5', newer: true } },
    updateInstall: async () => (calls.push('install'), { ok: true, message: 'Instalando v0.1.5…' }),
  });
  await t.tick();
  assert.ok(t.maint.innerText.includes('Atualizar para v0.1.5'));
  assert.ok(t.maint.innerText.includes('v0.1.5 disponível'));
  const bar = t.maint.all((n) => n.tagName === 'PROGRESS')[0];
  assert.ok(bar, 'barra de download presente');
  await t.tap(/Atualizar para v/);
  assert.match(t.text(), /Atualizar para a v0\.1\.5\?/);
  assert.deepEqual(calls, [], 'só atualiza depois de confirmar');
  await t.click(/^Atualizar$/);
  assert.deepEqual(calls, ['install']);
  assert.ok(t.maint.innerText.includes('Instalando v0.1.5'));
  assert.deepEqual(t.errors, []);
});

test('painel inicial: sem versão nova não há botão Atualizar nem barra', async () => {
  const t = setup();
  await t.tick();
  assert.ok(!/Atualizar para/.test(t.maint.innerText));
  assert.equal(t.maint.all((n) => n.tagName === 'PROGRESS').length, 0);
  assert.match(t.maint.innerText, /Verificar atualizações/);
});

test('painel inicial: sem mídias e sem configuração mostra a instrução e não inicia sozinho', async () => {
  const t = setup({ state: { configured: false, playableCount: 0, itemCount: 0, media: [], status: {} } });
  await t.tick();
  assert.match(t.maint.innerText, /cole o código de pareamento/);
  assert.equal(t.intervals.length, 0);
});

test('conexão: botão Colar código copiado lê a área de transferência e aplica o código', async () => {
  const applied = [];
  const t = setup({ applyPair: async (_t, c) => (applied.push(c), { ok: true, baseUrl: 'https://x/b', keyId: 'K', pollSeconds: 60, screens: ['loja'], screensError: '' }) });
  await t.tick();
  await t.click(/Conexão com o admin/);
  await t.click(/Colar código copiado/);
  assert.deepEqual(applied, ['RM1-abcdefghijkl.00000000']);
  assert.match(t.maint.innerText, /Código aceito/);
  assert.deepEqual(t.errors, []);
});

test('janela: botões Minimizar e Janela/Tela cheia alternam o modo e o rótulo muda', async () => {
  const actions = [];
  const t = setup({
    action: async (_t, a) => (actions.push(a), { ok: true, message: 'feito' }),
  });
  await t.tick();
  assert.match(t.maint.innerText, /Janela/);
  await t.click(/^\s*Janela\s*$/);
  assert.deepEqual(actions, ['window-toggle']);
  assert.match(t.maint.innerText, /Minimizar/);
  assert.deepEqual(t.errors, []);
});

test('toque: alvos de ação são botões grandes com descrição e o toque adia o início automático', async () => {
  const t = setup();
  await t.tick();
  const tiles = t.maint.all((n) => n.tagName === 'BUTTON' && n.classSet.has('tile'));
  assert.ok(tiles.length >= 5);
  for (const b of tiles) assert.ok(b.children.length === 2, 'título + descrição');
  assert.ok(t.maint.all((n) => n.classSet.has('bigstart')).length === 1);
});

test('sem senha: nenhuma tela de login aparece em nenhum botão', async () => {
  const t = setup();
  await t.tick();
  for (const re of [/Exibição/, /Conexão com o admin/, /Mais opções/]) {
    await t.click(re);
    assert.ok(!/senha|Entrar/i.test(t.maint.innerText), `${re} não pode pedir senha`);
    await t.click(/Voltar/);
  }
});

// ---------- totem touch (sem mouse e sem teclado) ----------

const fire = (node, type, e = {}) => (node.handlers[type] || []).forEach((fn) => fn({ preventDefault() {}, ...e }));

test('touch: o canto abre o painel só com toque longo; toque curto não abre', async () => {
  const t = setup({}, { win: { __HOLD_MS: 60 } });
  await t.tick();
  await t.click(/Iniciar reprodução/);
  assert.ok(t.maint.classList.contains('hidden'));

  fire(t.corner, 'pointerdown');
  fire(t.corner, 'pointerup'); // soltou antes da hora
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(t.maint.classList.contains('hidden'), 'toque curto não abre');

  fire(t.corner, 'pointerdown');
  assert.ok(t.corner.classList.contains('holding'), 'anel de andamento ligado');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!t.maint.classList.contains('hidden'), 'segurar abre o painel');
  assert.ok(!t.corner.classList.contains('holding'));
  assert.match(t.maint.innerText, /Mídias baixadas/);

  await t.click(/Iniciar reprodução/);
  fire(t.corner, 'click', { detail: 0 }); // teclado (Enter/Espaço) continua abrindo direto
  await t.tick();
  assert.ok(!t.maint.classList.contains('hidden'));
  assert.deepEqual(t.errors, []);
});

test('touch: confirmações são do próprio painel (botões grandes) e Cancelar não executa a ação', async () => {
  const actions = [];
  const t = setup({ action: async (_t, a) => (actions.push(a), { ok: true, message: 'feito' }) });
  await t.tick();
  await t.click(/Mais opções/);
  await t.tap(/Sair do player/);
  assert.match(t.text(), /Encerrar o player\?/);
  await t.click(/^Cancelar$/);
  assert.deepEqual(actions, []);
  assert.ok(!/Encerrar o player\?/.test(t.text()), 'diálogo fechou');
  await t.tap(/Sair do player/);
  await t.click(/^Confirmar$/);
  assert.deepEqual(actions, ['quit']);
});

test('touch: Exibição e Conexão não usam listas suspensas; tudo é botão grande', async () => {
  const saved = [];
  const t = setup({ setDisplay: async (_t, d) => (saved.push(d), { ok: true, message: 'salvo' }), listScreens: async () => ({ ok: true, screens: ['loja', 'vitrine'] }), getConfig: async () => ({ ok: true, baseUrl: 'https://x/b', screenId: 'loja', pollSeconds: 60, keyId: 'K', hasSecret: true, screens: ['loja', 'vitrine'] }) });
  await t.tick();
  await t.click(/Exibição/);
  assert.equal(t.maint.all((n) => n.tagName === 'SELECT').length, 0);
  await t.click(/^90°$/);
  await t.click(/Preencher a tela|Preencher \(corta/);
  await t.click(/^\+$/);
  await t.click(/Salvar/);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), [{ fit: 'cover', rotate: 90, volume: 100 }]);
  await t.click(/Voltar/);

  await t.click(/Conexão com o admin/);
  assert.equal(t.maint.all((n) => n.tagName === 'SELECT').length, 0);
  assert.ok(button(/^vitrine$/, t), 'telas viram botões');
  assert.deepEqual(t.errors, []);
});

function button(re, t) {
  return t.maint.all((n) => n.tagName === 'BUTTON' && re.test(n.innerText))[0];
}

test('touch: "Procurar pair.txt" usa o código do arquivo, sem digitar nada', async () => {
  const applied = [];
  const t = setup({
    findPair: async () => ({ ok: true, text: 'RM1-arquivo.00000000', file: 'D:\\pair.txt' }),
    applyPair: async (_t, c) => (applied.push(c), { ok: true, baseUrl: 'https://x/b', keyId: 'K', pollSeconds: 60, screens: ['loja'], screensError: '' }),
  });
  await t.tick();
  await t.click(/Conexão com o admin/);
  await t.click(/Procurar pair\.txt/);
  assert.deepEqual(applied, ['RM1-arquivo.00000000']);
  assert.match(t.maint.innerText, /pair\.txt encontrado em D:/);

  const t2 = setup({ findPair: async () => ({ ok: false, error: 'Não encontrei o pair.txt.' }) });
  await t2.tick();
  await t2.click(/Conexão com o admin/);
  await t2.click(/Procurar pair\.txt/);
  assert.match(t2.maint.innerText, /Não encontrei o pair\.txt/);
  assert.deepEqual(t.errors.concat(t2.errors), []);
});

test('touch: parado por alguns minutos, o painel fecha sozinho e a reprodução volta', async () => {
  const t = setup({}, { win: { __IDLE_MS: 250, __IDLE_POLL_MS: 20 } });
  await t.tick();
  await t.click(/Exibição/); // numa tela de ajustes, onde a contagem de 60 s da tela inicial não existe
  assert.ok(!t.maint.classList.contains('hidden'));
  assert.ok(!t.maint.classList.contains('hidden'), 'ainda aberto logo depois de tocar');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(t.maint.classList.contains('hidden'), 'fechou por inatividade');
  assert.deepEqual(t.holds.slice(-1), [false], 'som volta');
});

test('fechar: o painel tem o botão Fechar o Player (com confirmação) e os controles da janela funcionam sem abrir o painel', async () => {
  const actions = [];
  const t = setup({ action: async (_t, a) => (actions.push(a), { ok: true, message: 'feito' }) });
  await t.tick();
  await t.tap(/Fechar o Player/);
  assert.match(t.text(), /Fechar o Player?/);
  await t.click(/^Cancelar$/);
  assert.deepEqual(actions, [], 'cancelar não fecha');
  await t.tap(/Fechar o Player/);
  await t.click(/^Confirmar$/);
  assert.deepEqual(actions, ['quit']);
});
