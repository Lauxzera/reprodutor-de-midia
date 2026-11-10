'use strict';

// Aviso de cota do B2: contador diário de leituras e detecção de "cota esgotada".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../../../tools/dev-server');
const { SyncEngine } = require('../src/main/sync');
const { assessRequests, assessStorage, isCapError, readsPerDay, FREE } = require('@reprodutor/shared');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-quota-'));
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const stop = (server) => new Promise((r) => (server.closeAllConnections(), server.close(r)));

function bucketWith(revision = 1) {
  const bucket = tmp();
  const buf = crypto.randomBytes(3000);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const key = `media/${hash}.jpg`;
  fs.mkdirSync(path.join(bucket, 'media'), { recursive: true });
  fs.mkdirSync(path.join(bucket, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(bucket, key), buf);
  const item = { id: 'a', type: 'image', file: key, sha256: hash, size: buf.length, name: 'a.jpg', durationSec: 5 };
  fs.writeFileSync(path.join(bucket, 'screens', 'loja.json'), JSON.stringify({ schemaVersion: 1, screenId: 'loja', revision, items: [item] }));
  return bucket;
}

test('limites: níveis de aviso e leituras por dia', () => {
  assert.equal(assessRequests(100).level, 'ok');
  assert.equal(assessRequests(Math.ceil(FREE.dailyTransactions * 0.8)).level, 'warn');
  assert.equal(assessRequests(FREE.dailyTransactions).level, 'over');
  assert.equal(assessStorage(9 * 1024 ** 3).level, 'warn');
  assert.equal(assessStorage(11 * 1024 ** 3).level, 'over');
  assert.equal(readsPerDay(60), 1440);
  assert.equal(readsPerDay(120), 720);
});

test('detecta resposta de cota esgotada do B2 e ignora erros comuns', () => {
  assert.equal(isCapError(403, 'Cannot download file, download bandwidth or transaction (Class B) cap exceeded.'), true);
  assert.equal(isCapError(429, 'Too many requests'), true);
  assert.equal(isCapError(403, '<Error><Code>AccessDenied</Code><Message>Access denied</Message></Error>'), false);
  assert.equal(isCapError(404, 'transaction'), false);
  assert.equal(isCapError(200, 'cap exceeded'), false);
});

test('o player conta cada requisição e guarda o total do dia no state.json', async () => {
  const bucket = bucketWith();
  const dataDir = tmp();
  const server = createServer(bucket);
  await listen(server);
  try {
    const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${server.address().port}`, screenId: 'loja' });
    engine.init();
    await engine.syncOnce(); // manifesto + 1 mídia
    assert.equal(engine.quota().used, 2);
    await engine.syncOnce(); // só o manifesto (304)
    assert.equal(engine.quota().used, 3);
    assert.equal(engine.status.quota.used, 3);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.requestsToday, 3);

    // reinício no mesmo dia continua a contagem
    const again = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${server.address().port}`, screenId: 'loja' });
    again.init();
    assert.equal(again.quota().used, 3);
  } finally {
    await stop(server);
  }
});

test('cota esgotada: sinaliza, continua tocando do disco e recupera quando o B2 volta', async () => {
  const bucket = bucketWith();
  const dataDir = tmp();
  let cap = null;
  const server = createServer(bucket, { forceStatus: () => cap });
  await listen(server);
  try {
    const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${server.address().port}`, screenId: 'loja' });
    engine.init();
    assert.equal((await engine.syncOnce()).status, 'updated');

    cap = { status: 403, body: 'transaction cap exceeded' };
    const r = await engine.syncOnce();
    assert.equal(r.status, 'error');
    assert.match(r.message, /Cota diária do B2 esgotada/);
    assert.equal(engine.status.quotaExceeded, true);
    assert.equal(engine.playableItems().length, 1, 'segue tocando');

    // um 403 comum (sem texto de cota) não é tratado como cota
    cap = { status: 403, body: 'AccessDenied' };
    assert.equal((await engine.syncOnce()).message.includes('Cota'), false);
    assert.equal(engine.status.quotaExceeded, false);

    cap = null;
    assert.equal((await engine.syncOnce()).status, 'unchanged');
    assert.equal(engine.status.quotaExceeded, false);
  } finally {
    await stop(server);
  }
});
