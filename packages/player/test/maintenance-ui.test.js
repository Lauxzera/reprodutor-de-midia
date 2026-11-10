'use strict';

// Regressão do menu de manutenção: roda o maintenance.js (script do renderer) contra um DOM de mentira
// e percorre definir senha -> menu -> configurar conexão -> voltar -> fechar -> entrar de novo.
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
    for (const k of kids) this.children.push(typeof k === 'string' ? Object.assign(new FakeNode('#text'), { _text: k }) : k);
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

function setup(apiOverrides = {}) {
  const maint = new FakeNode('div');
  maint.classSet.add('hidden');
  const corner = new FakeNode('button');
  const body = new FakeNode('body');
  const byId = { maint, corner };
  const windowHandlers = {};
  let password = null;
  const api = {
    maint: {
      status: async () => ({ hasPassword: password !== null, lockedMs: 0 }),
      setPassword: async (p) => ((password = p), { ok: true }),
      auth: async (p) => (p === password ? { ok: true, token: 't1' } : { ok: false, error: 'Senha incorreta' }),
      info: async () => ({ ok: true, snapshot: { screenId: 'loja', revision: 1, playableCount: 0, itemCount: 0, status: { state: 'idle' } }, log: '(log)' }),
      action: async () => ({ ok: true, message: 'feito' }),
      getConfig: async () => ({ ok: true, baseUrl: '', screenId: '', pollSeconds: 60, keyId: '', hasSecret: false }),
      saveConfig: async () => ({ ok: true, message: 'ok' }),
      applyPair: async () => ({ ok: false, error: 'x' }),
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
  const win = { playerApi: api, innerWidth: 1280, addEventListener: (t, fn) => (windowHandlers[t] ||= []).push(fn), confirm: () => true };
  const sandbox = { window: win, document, Node: FakeNode, setTimeout, clearTimeout, console: { warn: () => {}, log: () => {}, error: (e) => errors.push(e) } };
  vm.runInNewContext(fs.readFileSync(process.env.MAINT_JS || path.join(__dirname, '../src/renderer/maintenance.js'), 'utf8'), sandbox);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const button = (re) => maint.all((n) => n.tagName === 'BUTTON' && re.test(n.innerText))[0];
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
  return { maint, corner, click, press, inputs, tick, errors, body };
}

test('manutenção: definir senha, abrir o menu com os botões novos, configurar conexão, fechar e entrar de novo', async () => {
  const t = setup();

  // botão do canto abre o login; primeiro acesso pede para definir a senha
  for (const fn of t.corner.handlers.click) fn({});
  await t.tick();
  assert.match(t.maint.innerText, /Defina a senha/);
  for (const i of t.inputs()) i.value = 'senha-123';
  await t.click(/Definir e entrar/);

  // menu aberto, com Minimizar e Configurações do Windows
  assert.match(t.maint.innerText, /Sincronizar agora/);
  assert.match(t.maint.innerText, /Minimizar o player/);
  assert.match(t.maint.innerText, /Configurações do Windows/);

  await t.click(/Configurar conexão/);
  assert.match(t.maint.innerText, /Código de pareamento/);
  await t.click(/Voltar/);
  assert.match(t.maint.innerText, /Sincronizar agora/);

  // Minimizar fecha o menu
  await t.click(/Minimizar o player/);
  assert.ok(t.maint.classList.contains('hidden'));

  // reabrir: agora pede a senha (não define); errada recusa, certa entra
  for (const fn of t.corner.handlers.click) fn({});
  await t.tick();
  assert.match(t.maint.innerText, /Digite a senha/);
  t.inputs()[0].value = 'errada';
  await t.click(/Entrar/);
  assert.match(t.maint.innerText, /Senha incorreta/);
  t.inputs()[0].value = 'senha-123';
  await t.click(/Entrar/);
  assert.match(t.maint.innerText, /Minimizar o player/);
  assert.deepEqual(t.errors, []);
});

test('manutenção: Ctrl+Shift+M abre e Esc fecha', async () => {
  const t = setup();
  await t.press('m', { ctrlKey: true, shiftKey: true });
  assert.ok(!t.maint.classList.contains('hidden'));
  await t.press('Escape');
  assert.ok(t.maint.classList.contains('hidden'));
});
