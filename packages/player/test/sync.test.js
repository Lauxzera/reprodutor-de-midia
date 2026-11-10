'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../../../tools/dev-server');
const { SyncEngine } = require('../src/main/sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-sync-'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function makeMedia(bucket, seed, size = 5000) {
  const data = crypto.createHash('sha256').update(seed).digest();
  const buf = Buffer.concat(Array.from({ length: Math.ceil(size / 32) }, () => data)).subarray(0, size);
  const hash = sha(buf);
  const key = `media/${hash}.jpg`;
  fs.mkdirSync(path.join(bucket, 'media'), { recursive: true });
  fs.writeFileSync(path.join(bucket, key), buf);
  return { id: seed, type: 'image', file: key, sha256: hash, size: buf.length, name: `${seed}.jpg`, durationSec: 5 };
}

function writeManifest(bucket, revision, items) {
  fs.mkdirSync(path.join(bucket, 'screens'), { recursive: true });
  fs.writeFileSync(
    path.join(bucket, 'screens', 'loja.json'),
    JSON.stringify({ schemaVersion: 1, screenId: 'loja', revision, items }),
  );
}

async function setup() {
  const bucket = tmp();
  const dataDir = tmp();
  const server = createServer(bucket);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const engine = new SyncEngine({ dataDir, baseUrl, screenId: 'loja' });
  engine.init();
  const close = () => new Promise((r) => (server.closeAllConnections(), server.close(r)));
  return { bucket, dataDir, baseUrl, engine, close };
}

const mediaFiles = (dataDir) => fs.readdirSync(path.join(dataDir, 'media')).sort();

test('baixa mídias, grava manifesto e depois remove as que saíram', async () => {
  const { bucket, dataDir, engine, close } = await setup();
  try {
    const a = makeMedia(bucket, 'a');
    const b = makeMedia(bucket, 'b');
    const c = makeMedia(bucket, 'c');

    writeManifest(bucket, 1, [a, b]);
    const events = [];
    engine.on('manifest', (m) => events.push(m.revision));
    let r = await engine.syncOnce();
    assert.equal(r.status, 'updated');
    assert.deepEqual(mediaFiles(dataDir), [`${a.sha256}.jpg`, `${b.sha256}.jpg`].sort());
    assert.equal(engine.playableItems().length, 2);

    writeManifest(bucket, 2, [b, c]);
    r = await engine.syncOnce();
    assert.equal(r.status, 'updated');
    assert.deepEqual(mediaFiles(dataDir), [`${b.sha256}.jpg`, `${c.sha256}.jpg`].sort());
    assert.deepEqual(events, [1, 2]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'))).revision, 2);
  } finally {
    await close();
  }
});

test('segunda consulta sem mudança usa ETag (304) e re-baixa arquivo apagado', async () => {
  const { bucket, dataDir, engine, close } = await setup();
  try {
    const a = makeMedia(bucket, 'a');
    writeManifest(bucket, 1, [a]);
    assert.equal((await engine.syncOnce()).status, 'updated');
    assert.equal((await engine.syncOnce()).status, 'unchanged');

    fs.rmSync(path.join(dataDir, 'media', `${a.sha256}.jpg`));
    assert.equal(engine.playableItems().length, 0);
    const r = await engine.syncOnce();
    assert.equal(r.status, 'unchanged');
    assert.equal(r.downloaded, 1);
    assert.equal(engine.playableItems().length, 1);
  } finally {
    await close();
  }
});

test('offline: mantém manifesto e mídias e continua tocando', async () => {
  const { bucket, dataDir, engine, close } = await setup();
  const a = makeMedia(bucket, 'a');
  writeManifest(bucket, 1, [a]);
  await engine.syncOnce();
  await close(); // "cai a internet"

  const r = await engine.syncOnce();
  assert.equal(r.status, 'offline');
  assert.equal(engine.playableItems().length, 1);

  // Reinício do player sem rede: recarrega do disco.
  const again = new SyncEngine({ dataDir, baseUrl: engine.baseUrl, screenId: 'loja' });
  again.init();
  assert.equal(again.playableItems().length, 1);
  assert.equal(again.manifest.revision, 1);
});

test('hash divergente: não grava manifesto nem arquivo final', async () => {
  const { bucket, dataDir, engine, close } = await setup();
  try {
    const a = makeMedia(bucket, 'a');
    const bad = { ...a, sha256: 'f'.repeat(64), file: `media/${'f'.repeat(64)}.jpg` };
    fs.copyFileSync(path.join(bucket, a.file), path.join(bucket, bad.file)); // conteúdo não bate com o nome
    writeManifest(bucket, 1, [bad]);
    const r = await engine.syncOnce();
    assert.equal(r.status, 'error');
    assert.equal(engine.manifest, null);
    assert.equal(fs.existsSync(path.join(dataDir, 'manifest.json')), false);
    assert.deepEqual(mediaFiles(dataDir), []);
  } finally {
    await close();
  }
});

test('falha no meio mantém o manifesto antigo e não apaga nada', async () => {
  const { bucket, dataDir, engine, close } = await setup();
  try {
    const a = makeMedia(bucket, 'a');
    writeManifest(bucket, 1, [a]);
    await engine.syncOnce();

    const ghost = makeMedia(bucket, 'ghost');
    fs.rmSync(path.join(bucket, ghost.file)); // listado no manifesto, mas ausente no bucket
    writeManifest(bucket, 2, [ghost]);
    const r = await engine.syncOnce();
    assert.equal(r.status, 'error');
    assert.equal(engine.manifest.revision, 1);
    assert.deepEqual(mediaFiles(dataDir), [`${a.sha256}.jpg`]);
    assert.equal(engine.playableItems().length, 1);
  } finally {
    await close();
  }
});

test('retoma download parcial com Range', async () => {
  const { bucket, dataDir, engine, close } = await setup();
  try {
    const a = makeMedia(bucket, 'big', 200000);
    writeManifest(bucket, 1, [a]);
    const full = fs.readFileSync(path.join(bucket, a.file));
    fs.writeFileSync(path.join(dataDir, 'media', `${a.sha256}.jpg.part`), full.subarray(0, 70000));

    const r = await engine.syncOnce();
    assert.equal(r.status, 'updated');
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'media', `${a.sha256}.jpg`)), full);
    assert.deepEqual(mediaFiles(dataDir), [`${a.sha256}.jpg`]);
  } finally {
    await close();
  }
});

test('manifesto de outra tela ou inválido é rejeitado', async () => {
  const { bucket, engine, close } = await setup();
  try {
    fs.mkdirSync(path.join(bucket, 'screens'), { recursive: true });
    fs.writeFileSync(
      path.join(bucket, 'screens', 'loja.json'),
      JSON.stringify({ schemaVersion: 1, screenId: 'outra', revision: 1, items: [] }),
    );
    assert.equal((await engine.syncOnce()).status, 'error');
    fs.writeFileSync(path.join(bucket, 'screens', 'loja.json'), '{ quebrado');
    assert.equal((await engine.syncOnce()).status, 'error');
    assert.equal(engine.manifest, null);
  } finally {
    await close();
  }
});
