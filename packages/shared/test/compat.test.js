'use strict';

// Compatibilidade com builds antigas: o que o admin/Player atuais publicam precisa continuar
// sendo entendido pelos validadores e decodificadores das versões já instaladas nas TVs.
// Os arquivos em ./legacy são cópias CONGELADAS dessas versões: não os atualize.

const test = require('node:test');
const assert = require('node:assert/strict');
const old = require('./legacy/manifest-v0.1.0');
const oldPair = require('./legacy/pair-v0.1.2');
const { validateManifest, SCHEMA_VERSION } = require('../src/manifest');
const { encodePair, decodePair } = require('../src/pair');
const { buildManifest } = require('../../panel/src/main/publish');

const sha = 'a'.repeat(64);
const library = [
  { sha256: sha, name: 'a.jpg', ext: '.jpg', type: 'image', size: 10 },
  { sha256: 'b'.repeat(64), name: 'b.mp4', ext: '.mp4', type: 'video', size: 20 },
];
const screen = { id: 'loja', settings: { fit: 'cover', transitionMs: 300, muted: true }, items: [{ id: 'i1', sha256: sha, durationSec: 5, schedule: { days: [1, 2], start: '08:00', end: '18:00', from: '2026-01-01', to: '2026-12-31' } }, { id: 'i2', sha256: 'b'.repeat(64) }] };

test('o schema do manifesto continua 1 (mudar quebraria todos os players instalados)', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(old.SCHEMA_VERSION, 1);
});

test('manifesto publicado pelo admin atual é aceito pelo validador da 0.1.0', () => {
  const m = buildManifest(screen, library, 7);
  const v = old.validateManifest(JSON.parse(JSON.stringify(m)));
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.manifest.items.length, 2);
  assert.equal(v.manifest.settings.fit, 'cover');
});

test('campos novos no manifesto são ignorados pelas versões antigas (só se acrescenta, nunca se muda)', () => {
  const m = { ...buildManifest(screen, library, 1), campoFuturo: { x: 1 }, settings: { ...screen.settings, extra: true } };
  assert.equal(old.validateManifest(m).ok, true);
  assert.equal(validateManifest(m).ok, true);
});

test('código de pareamento com chave de status continua legível pela decodificação da 0.1.2', () => {
  const base = { endpoint: 'https://s3.us-east-005.backblazeb2.com', bucket: 'loja', keyId: 'K1', secretKey: 'S1', pollSeconds: 90 };
  const code = encodePair({ ...base, statusKeyId: 'W1', statusSecret: 'WS1' });
  const o = oldPair.decodePair(code);
  assert.equal(o.keyId, 'K1');
  assert.equal(o.secretKey, 'S1');
  assert.equal(o.baseUrl, 'https://s3.us-east-005.backblazeb2.com/loja');
  assert.equal(o.pollSeconds, 90);
  assert.equal(o.statusKeyId, undefined, 'a build antiga ignora a chave de status');
  const n = decodePair(code);
  assert.equal(n.statusKeyId, 'W1');
  assert.equal(n.statusSecret, 'WS1');
  // e códigos antigos (sem status) seguem valendo no decodificador novo
  assert.equal(decodePair(oldPair.encodePair(base)).keyId, 'K1');
});
