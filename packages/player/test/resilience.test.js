'use strict';

// Cenários de falha reais: rede que cai e volta, energia cortada no meio do download,
// manifesto corrompido, disco cheio, servidor com erro.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createServer } = require('../../../tools/dev-server');
const { SyncEngine } = require('../src/main/sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-res-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function makeMedia(bucket, seed, size = 5000) {
  const buf = crypto.randomBytes(size);
  const hash = sha(buf);
  const key = `media/${hash}.jpg`;
  fs.mkdirSync(path.join(bucket, 'media'), { recursive: true });
  fs.writeFileSync(path.join(bucket, key), buf);
  return { id: seed, type: 'image', file: key, sha256: hash, size: buf.length, name: `${seed}.jpg`, durationSec: 5 };
}

function writeManifest(bucket, revision, items) {
  fs.mkdirSync(path.join(bucket, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(bucket, 'screens', 'loja.json'), JSON.stringify({ schemaVersion: 1, screenId: 'loja', revision, items }));
}

const listen = (server, port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', r));
const stop = (server) =>
  new Promise((r) => {
    server.closeAllConnections();
    server.close(r);
  });
const waitFor = async (fn, ms = 15000, step = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('tempo esgotado esperando a condição');
};

test('rede cai e volta com o player rodando: segue tocando e atualiza sozinho ao reconectar', async () => {
  const bucket = tmp();
  const dataDir = tmp();
  const a = makeMedia(bucket, 'a');
  writeManifest(bucket, 1, [a]);

  let server = createServer(bucket);
  await listen(server);
  const port = server.address().port;
  const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${port}`, screenId: 'loja', pollMs: 100 });
  engine.init();
  const revisions = [];
  const states = [];
  engine.on('manifest', (m) => revisions.push(m.revision));
  engine.on('status', (s) => states.push(s.state));
  engine.start();
  try {
    await waitFor(() => revisions.includes(1));

    await stop(server); // cai a internet
    await waitFor(() => states.includes('offline'));
    assert.equal(engine.playableItems().length, 1, 'continua com a mídia no disco');

    // Enquanto offline, o painel publica uma nova versão no bucket.
    const b = makeMedia(bucket, 'b');
    writeManifest(bucket, 2, [a, b]);
    await sleep(500); // várias tentativas falhando
    assert.equal(engine.manifest.revision, 1);

    server = createServer(bucket); // volta a internet (mesmo endereço)
    await listen(server, port);
    await waitFor(() => revisions.includes(2), 20000);
    assert.equal(engine.playableItems().length, 2);
  } finally {
    engine.stop();
    await stop(server);
  }
});

test('energia cortada no meio do download: ao religar, retoma de onde parou e confere o hash', async () => {
  const bucket = tmp();
  const dataDir = tmp();
  const big = makeMedia(bucket, 'grande', 4 * 1024 * 1024);
  writeManifest(bucket, 1, [big]);

  const ranges = [];
  const slow = createServer(bucket, { slow: { chunk: 16384, every: 20 }, onRequest: (req) => req.headers.range && ranges.push(req.headers.range) });
  await listen(slow);
  const baseUrl = `http://127.0.0.1:${slow.address().port}`;
  const part = path.join(dataDir, 'media', `${big.sha256}.jpg.part`);
  const final = path.join(dataDir, 'media', `${big.sha256}.jpg`);

  const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'sync-child.js'), dataDir, baseUrl, 'loja'], { stdio: 'ignore' });
  let partial = 0;
  try {
    partial = await waitFor(() => {
      try {
        const n = fs.statSync(part).size;
        return n > 500 * 1024 ? n : 0;
      } catch {
        return 0;
      }
    }, 20000, 20);
  } finally {
    child.kill('SIGKILL'); // "puxa o cabo da tomada"
    await new Promise((r) => child.once('exit', r));
    await stop(slow);
  }
  assert.ok(partial > 0 && partial < big.size, `download parcial (${partial} de ${big.size})`);
  assert.equal(fs.existsSync(final), false, 'arquivo final não existe');
  assert.equal(fs.existsSync(path.join(dataDir, 'manifest.json')), false, 'manifesto não foi aplicado');

  // Religou: novo processo do player.
  const fast = createServer(bucket, { onRequest: (req) => req.headers.range && ranges.push(req.headers.range) });
  await listen(fast);
  try {
    const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${fast.address().port}`, screenId: 'loja' });
    engine.init();
    const r = await engine.syncOnce();
    assert.equal(r.status, 'updated');
    assert.equal(sha(fs.readFileSync(final)), big.sha256);
    assert.equal(fs.existsSync(part), false);
    assert.ok(ranges.some((x) => x.startsWith('bytes=') && Number(x.slice(6, -1)) >= 500 * 1024), `usou Range para retomar: ${ranges.join(', ')}`);
  } finally {
    await stop(fast);
  }
});

test('manifesto principal corrompido (queda de energia): usa a cópia de segurança e continua tocando offline', async () => {
  const bucket = tmp();
  const dataDir = tmp();
  const a = makeMedia(bucket, 'a');
  writeManifest(bucket, 1, [a]);
  const server = createServer(bucket);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const first = new SyncEngine({ dataDir, baseUrl, screenId: 'loja' });
  first.init();
  await first.syncOnce();
  await stop(server); // e a internet não volta

  for (const damage of ['', '{ "schemaVersion": 1, "scr', null]) {
    if (damage === null) fs.rmSync(path.join(dataDir, 'manifest.json'));
    else fs.writeFileSync(path.join(dataDir, 'manifest.json'), damage);

    const logs = [];
    const again = new SyncEngine({ dataDir, baseUrl, screenId: 'loja', log: (m) => logs.push(m) });
    again.init();
    assert.equal(again.manifest && again.manifest.revision, 1, `recuperou com manifesto ${damage === null ? 'ausente' : 'corrompido'}`);
    assert.equal(again.playableItems().length, 1);
    assert.ok(logs.some((l) => /manifest\.bak\.json/.test(l)));
  }
});

test('mídia truncada no disco (energia cortada após o rename) é detectada e baixada de novo', async () => {
  const bucket = tmp();
  const dataDir = tmp();
  const a = makeMedia(bucket, 'a', 40000);
  writeManifest(bucket, 1, [a]);
  const server = createServer(bucket);
  await listen(server);
  try {
    const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${server.address().port}`, screenId: 'loja' });
    engine.init();
    await engine.syncOnce();
    const file = path.join(dataDir, 'media', `${a.sha256}.jpg`);
    fs.truncateSync(file, 100);
    assert.equal(engine.playableItems().length, 0, 'não toca arquivo truncado');
    const r = await engine.syncOnce();
    assert.equal(r.downloaded, 1);
    assert.equal(sha(fs.readFileSync(file)), a.sha256);
  } finally {
    await stop(server);
  }
});

test('disco cheio: não baixa, não troca o manifesto e mantém a programação atual', async () => {
  const bucket = tmp();
  const dataDir = tmp();
  const a = makeMedia(bucket, 'a');
  writeManifest(bucket, 1, [a]);
  const server = createServer(bucket);
  await listen(server);
  try {
    const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${server.address().port}`, screenId: 'loja' });
    engine.init();
    await engine.syncOnce();

    const huge = { ...a, id: 'enorme', sha256: 'e'.repeat(64), file: `media/${'e'.repeat(64)}.mp4`, type: 'video', size: 10 * 1024 ** 4 }; // 10 TB
    delete huge.durationSec;
    writeManifest(bucket, 2, [a, huge]);
    const r = await engine.syncOnce();
    assert.equal(r.status, 'error');
    assert.match(r.message, /Espaço em disco insuficiente/);
    assert.equal(engine.manifest.revision, 1);
    assert.equal(engine.playableItems().length, 1);
    assert.equal(fs.readdirSync(path.join(dataDir, 'media')).some((f) => f.includes('eeee')), false);
  } finally {
    await stop(server);
  }
});

test('bucket com erro (500), manifesto sumido (404) e volta ao normal: sempre continua tocando', async () => {
  const bucket = tmp();
  const dataDir = tmp();
  const a = makeMedia(bucket, 'a');
  writeManifest(bucket, 1, [a]);
  let mode = null;
  const server = createServer(bucket, { forceStatus: () => mode });
  await listen(server);
  try {
    const engine = new SyncEngine({ dataDir, baseUrl: `http://127.0.0.1:${server.address().port}`, screenId: 'loja' });
    engine.init();
    assert.equal((await engine.syncOnce()).status, 'updated');

    for (const status of [500, 503, 404, 403]) {
      mode = status;
      const r = await engine.syncOnce();
      assert.equal(r.status, 'error', `HTTP ${status}`);
      assert.equal(engine.playableItems().length, 1, `continua tocando com HTTP ${status}`);
    }

    mode = null;
    writeManifest(bucket, 2, [a]);
    assert.equal((await engine.syncOnce()).status, 'updated');
    assert.equal(engine.manifest.revision, 2);
  } finally {
    await stop(server);
  }
});

test('falhas seguidas de rede são contadas (base do backoff do intervalo de consulta)', async () => {
  const dataDir = tmp();
  const engine = new SyncEngine({ dataDir, baseUrl: 'http://127.0.0.1:9', screenId: 'loja', pollMs: 100 });
  engine.init();
  for (let i = 0; i < 4; i++) assert.equal((await engine.syncOnce()).status, 'offline');
  assert.equal(engine._failures, 4);
});
