'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// No navegador "@reprodutor/shared" aponta só para o manifesto; replicamos isso aqui.
const manifestPath = path.resolve(__dirname, '../../shared/src/manifest.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request === '@reprodutor/shared' ? manifestPath : request, ...rest);
};

const { createMemoryS3 } = require('../src/memory-s3');
const { createWebApi } = require('../src/web-api');
const { decodePair } = require('../../shared/src/pair');
const { buildStatus } = require('../../shared/src/status');

const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'loja', privateBucket: true, publicBaseUrl: '' };

test('monitoramento web: mostra telas do projeto, versão e situação de cada player', async () => {
  const storage = createMemoryS3();
  await storage.putJson('admin/project.json', { version: 1, screens: [{ id: 'loja', name: 'Loja', revision: 2, settings: {}, items: [] }, { id: 'vitrine', name: 'Vitrine', revision: 1, settings: {}, items: [] }] });
  await storage.putJson('status/loja.json', buildStatus({ screenId: 'loja', version: '0.1.5', state: 'idle', revision: 2, playing: 'promo.mp4' }));
  const api = createWebApi({ storage, settings, saveSettings: async () => {}, fetchLatest: async () => '0.1.8' });
  const m = await api.monitor.list();
  const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(m.latestVersion, '0.1.8');
  assert.equal(by.loja.presence, 'online');
  assert.equal(by.loja.versionState, 'old');
  assert.equal(by.loja.version, '0.1.5');
  assert.equal(by.vitrine.presence, 'none');
});

test('pareamento web: a chave de status vai no código só quando informada, e nunca a de gravação geral', async () => {
  const storage = createMemoryS3();
  let sk = null;
  const api = createWebApi({ storage, settings, saveSettings: async () => {}, getReadKey: () => ({ keyId: 'LEITURA', appKey: 'L-SEGREDO' }), getStatusKey: () => sk });
  assert.equal(decodePair((await api.pair.code()).code).statusKeyId, undefined);
  assert.equal((await api.settings.get()).hasStatusKey, false);
  sk = { keyId: 'STATUS', appKey: 'S-SEGREDO' };
  const d = decodePair((await api.pair.code()).code);
  assert.equal(d.statusKeyId, 'STATUS');
  assert.equal(d.statusSecret, 'S-SEGREDO');
  assert.equal(d.keyId, 'LEITURA');
  assert.equal((await api.settings.get()).hasStatusKey, true);
});
