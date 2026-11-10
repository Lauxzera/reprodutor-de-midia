'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Watchdog } = require('../src/main/watchdog');
const { Security } = require('../src/main/security');
const { createLogger, readLogTail } = require('../src/main/logger');
const { loadConfig } = require('../src/main/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-rob-'));

function wd(overrides = {}) {
  const clock = { t: 1_000_000 };
  const calls = { reload: [], restart: [] };
  const w = new Watchdog({
    now: () => clock.t,
    onReload: (r) => calls.reload.push(r),
    onRestart: (r) => calls.restart.push(r),
    ...overrides,
  });
  return { w, clock, calls };
}

test('watchdog: batimentos em dia não disparam nada', () => {
  const { w, clock, calls } = wd();
  for (let i = 0; i < 20; i++) {
    clock.t += 10000;
    w.heartbeat();
    assert.equal(w.check(), null);
  }
  assert.equal(calls.reload.length, 0);
});

test('watchdog: sem batimento por mais de 60 s recarrega e dá carência', () => {
  const { w, clock, calls } = wd();
  clock.t += 61000;
  assert.equal(w.check(), 'reload');
  assert.equal(calls.reload.length, 1);
  assert.equal(w.check(), null); // carência logo após recarregar
});

test('watchdog: item que estoura o prazo recarrega; ocioso limpa o prazo', () => {
  const { w, clock, calls } = wd();
  w.itemStarted({ id: 'a', expectedMs: 20000 });
  clock.t += 19000;
  w.heartbeat();
  assert.equal(w.check(), null);
  clock.t += 2000;
  w.heartbeat();
  assert.equal(w.check(), 'reload');
  assert.match(calls.reload[0], /travado/);

  w.itemStarted({ id: 'b', expectedMs: 5000 });
  w.itemStarted({ id: null }); // sem conteúdo: ocioso
  clock.t += 600000;
  w.heartbeat();
  assert.equal(w.check(), null);
});

test('watchdog: muitas falhas seguidas pedem reinício do app', () => {
  const { w, clock, calls } = wd({ maxReloads: 3 });
  const results = [];
  for (let i = 0; i < 4; i++) {
    clock.t += 61000;
    results.push(w.check());
  }
  assert.deepEqual(results, ['reload', 'reload', 'reload', 'restart']);
  assert.equal(calls.restart.length, 1);
});

test('watchdog: falhas espaçadas (fora da janela) não acumulam', () => {
  const { w, clock, calls } = wd({ maxReloads: 3, windowMs: 10 * 60 * 1000 });
  for (let i = 0; i < 6; i++) {
    clock.t += 11 * 60 * 1000;
    assert.equal(w.check(), 'reload');
  }
  assert.equal(calls.restart.length, 0);
});

test('segurança: define senha uma vez, valida e guarda só o hash', () => {
  const dir = tmp();
  const s = new Security(dir);
  assert.equal(s.hasPassword(), false);
  assert.equal(s.setPassword('123').ok, false);
  assert.equal(s.setPassword('senha-forte').ok, true);
  assert.equal(s.setPassword('outra-coisa').ok, false); // não permite sobrescrever
  assert.equal(fs.readFileSync(path.join(dir, 'security.json'), 'utf8').includes('senha-forte'), false);

  assert.equal(s.verify('errada').ok, false);
  const ok = s.verify('senha-forte');
  assert.equal(ok.ok, true);
  assert.equal(s.checkToken(ok.token), true);
  assert.equal(s.checkToken('inventado'), false);
});

test('segurança: bloqueia após 5 erros e libera depois do prazo', () => {
  const clock = { t: 5000 };
  const s = new Security(tmp(), { now: () => clock.t });
  s.setPassword('abcd');
  for (let i = 0; i < 5; i++) assert.equal(s.verify('x').ok, false);
  const locked = s.verify('abcd'); // mesmo a senha certa é recusada durante o bloqueio
  assert.equal(locked.ok, false);
  assert.ok(locked.retryAfterMs > 0);
  clock.t += 31000;
  assert.equal(s.verify('abcd').ok, true);
});

test('segurança: token expira e é renovado pelo uso', () => {
  const clock = { t: 0 };
  const s = new Security(tmp(), { now: () => clock.t, tokenMs: 1000 });
  s.setPassword('abcd');
  const { token } = s.verify('abcd');
  clock.t += 800;
  assert.equal(s.checkToken(token), true); // renova
  clock.t += 800;
  assert.equal(s.checkToken(token), true);
  clock.t += 1500;
  assert.equal(s.checkToken(token), false);
});

test('log: readLogTail devolve só o fim', () => {
  const dir = tmp();
  const log = createLogger(dir);
  for (let i = 1; i <= 50; i++) log(`linha ${i}`);
  const tail = readLogTail(dir, 5).split('\n');
  assert.equal(tail.length, 5);
  assert.match(tail.at(-1), /linha 50$/);
  assert.equal(readLogTail(tmp(), 5), '');
});

test('config: autoStart ligado por padrão e desligável', () => {
  const dir = tmp();
  assert.equal(loadConfig(dir).configured, false);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ baseUrl: 'http://x', screenId: 'loja' }));
  assert.equal(loadConfig(dir).autoStart, true);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ baseUrl: 'http://x', screenId: 'loja', autoStart: false }));
  assert.equal(loadConfig(dir).autoStart, false);
});
