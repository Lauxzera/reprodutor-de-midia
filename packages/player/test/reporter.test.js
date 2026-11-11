'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StatusReporter } = require('../src/main/reporter');

const base = { baseUrl: 'https://s3.us-east-005.backblazeb2.com/loja', screenId: 'loja', keyId: 'W1', secretKey: 'WS1', region: 'us-east-005', collect: () => ({ version: '0.1.8', state: 'idle', playing: 'promo.mp4', revision: 2, itemCount: 2, playableCount: 2 }) };

test('relatório: grava status/<tela>.json com versão e o que toca', async () => {
  let seen;
  const r = new StatusReporter({ ...base, fetch: async (url, init) => ((seen = { url, init }), { ok: true, status: 200 }) });
  assert.equal(r.enabled, true);
  assert.equal(await r.report(), true);
  assert.equal(seen.url, 'https://s3.us-east-005.backblazeb2.com/loja/status/loja.json');
  const body = JSON.parse(Buffer.from(seen.init.body).toString());
  assert.equal(body.version, '0.1.8');
  assert.equal(body.playing, 'promo.mp4');
  assert.equal(body.screenId, 'loja');
  assert.ok(r.info().lastAt);
});

test('relatório: sem chave de status fica desligado e não faz nenhuma requisição', async () => {
  let calls = 0;
  const r = new StatusReporter({ ...base, keyId: '', secretKey: '', fetch: async () => (calls++, { ok: true }) });
  assert.equal(r.enabled, false);
  assert.equal(await r.report(), false);
  r.start();
  r.nudge();
  r.stop();
  assert.equal(calls, 0);
});

test('relatório: falha (sem rede ou 403) nunca lança e é registrada uma vez só', async () => {
  const logs = [];
  const r = new StatusReporter({ ...base, log: (m) => logs.push(m), fetch: async () => ({ ok: false, status: 403 }) });
  assert.equal(await r.report(), false);
  assert.equal(await r.report(), false);
  assert.equal(logs.length, 1);
  assert.match(r.info().error, /403/);
  const r2 = new StatusReporter({ ...base, fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(await r2.report(), false);
});
