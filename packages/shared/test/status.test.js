'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatus, evaluateStatus, collectMonitor, statusKey } = require('../src/status');
const { signGet, putJsonSigned } = require('../src/sigv4');

const now = new Date('2026-11-11T12:00:00Z');
const rep = (sec, extra = {}) => buildStatus({ screenId: 'loja', version: '0.1.8', state: 'idle', now: new Date(now.getTime() - sec * 1000), ...extra });

test('situação: online até 5 min, sem sinal até 30 min, depois offline; sem relatório = none', () => {
  assert.equal(evaluateStatus(rep(60), { now }).presence, 'online');
  assert.equal(evaluateStatus(rep(600), { now }).presence, 'late');
  assert.equal(evaluateStatus(rep(7200), { now }).presence, 'offline');
  assert.equal(evaluateStatus(null, { now }).presence, 'none');
  assert.equal(evaluateStatus({ lixo: 1 }, { now }).presence, 'none');
});

test('versão: marca antiga, atual e desconhecida', () => {
  assert.equal(evaluateStatus(rep(1, { version: '0.1.5' }), { now, latestVersion: '0.1.8' }).versionState, 'old');
  assert.equal(evaluateStatus(rep(1, { version: '0.1.8' }), { now, latestVersion: '0.1.8' }).versionState, 'latest');
  assert.equal(evaluateStatus(rep(1, { version: '0.1.8' }), { now }).versionState, 'unknown');
});

test('monitor: junta telas do projeto com relatórios; tela sem relatório e tela fora do projeto', async () => {
  const objs = { [statusKey('loja')]: rep(30, { version: '0.1.6', revision: 3 }), [statusKey('extra')]: rep(30) };
  const storage = {
    list: async () => Object.keys(objs).map((key) => ({ key, size: 1 })).concat([{ key: 'status/Invalido!.json', size: 1 }]),
    getJson: async (k) => objs[k],
  };
  const project = { screens: [{ id: 'loja', name: 'Loja', revision: 4 }, { id: 'vitrine', name: 'Vitrine', revision: 1 }] };
  const m = await collectMonitor({ storage, project, latestVersion: '0.1.8', now });
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(by.loja.presence, 'online');
  assert.equal(by.loja.versionState, 'old');
  assert.equal(by.loja.published, 4);
  assert.equal(by.vitrine.presence, 'none');
  assert.equal(by.extra.registered, false);
  assert.equal(m.rows.length, 3);
});

test('monitor: falha ao listar não derruba a tela (mostra o erro e as telas do projeto)', async () => {
  const storage = { list: async () => { throw new Error('HTTP 403'); }, getJson: async () => null };
  const m = await collectMonitor({ storage, project: { screens: [{ id: 'loja', name: 'Loja', revision: 1 }] }, now });
  assert.equal(m.listError, 'HTTP 403');
  assert.equal(m.rows[0].presence, 'none');
});

test('PUT assinado: assina o hash do corpo e usa o método PUT', async () => {
  let seen;
  const fetch = async (url, init) => ((seen = { url, init }), { ok: true, status: 200 });
  await putJsonSigned(fetch, 'https://s3.us-east-005.backblazeb2.com/loja/status/loja.json', { a: 1 }, { keyId: 'W1', secretKey: 'WS1', region: 'us-east-005' });
  assert.equal(seen.init.method, 'PUT');
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=W1\//);
  assert.notEqual(seen.init.headers['x-amz-content-sha256'], signGet('https://s3.us-east-005.backblazeb2.com/x', { keyId: 'a', secretKey: 'b' })['x-amz-content-sha256'], 'corpo não vazio tem hash próprio');
  assert.equal(Buffer.from(seen.init.body).toString(), '{"a":1}');
});
