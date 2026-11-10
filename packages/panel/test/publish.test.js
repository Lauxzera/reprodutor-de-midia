'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../src/main/store');
const { createFolderStorage, publicBaseUrl } = require('../src/main/storage');
const { buildManifest, publishScreen } = require('../src/main/publish');
const { createServer } = require('../../../tools/dev-server');
const { SyncEngine } = require('../../player/src/main/sync');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `rm-${p}-`));
const cipher = { encrypt: (s) => Buffer.from(s, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };

function sampleFile(dir, name, size = 3000) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, crypto.randomBytes(size));
  return file;
}

test('biblioteca deduplica, rejeita formatos e bloqueia remoção de item em uso', async () => {
  const store = new Store(tmp('store'), cipher);
  const src = tmp('src');
  const a = sampleFile(src, 'promo.png');
  const dup = path.join(src, 'copia.png');
  fs.copyFileSync(a, dup);
  const txt = path.join(src, 'nota.txt');
  fs.writeFileSync(txt, 'x');

  const r = await store.addFiles([a, dup, txt]);
  assert.equal(r.added.length, 1);
  assert.equal(r.skipped.length, 2);
  assert.equal(store.listLibrary().length, 1);

  const project = store.getProject();
  project.screens[0].items.push({ id: 'i1', sha256: r.added[0], durationSec: 8, schedule: null });
  store.saveProject(project);
  const blocked = store.removeFromLibrary(r.added[0]);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.usedIn, ['Loja principal']);

  project.screens[0].items = [];
  store.saveProject(project);
  assert.equal(store.removeFromLibrary(r.added[0]).ok, true);
  assert.equal(store.listLibrary().length, 0);
});

test('credenciais são salvas cifradas e não aparecem em settings.json', () => {
  const dir = tmp('store');
  const store = new Store(dir, cipher);
  store.saveSettings({ type: 'b2', bucket: 'meu-bucket' }, { keyId: 'KEY123', appKey: 'SEGREDO456' });
  assert.deepEqual(store.getKeys(), { keyId: 'KEY123', appKey: 'SEGREDO456' });
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.equal(all.includes('SEGREDO456'), false);
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.bin')).toString('latin1').includes('SEGREDO456'), false);
});

test('buildManifest preserva agenda, duração e recusa mídia ausente', () => {
  const lib = [{ sha256: 'a'.repeat(64), ext: '.png', type: 'image', size: 10, name: 'a.png', path: 'x' }];
  const screen = {
    id: 'loja',
    revision: 0,
    settings: { fit: 'cover', transitionMs: 300, muted: true },
    items: [{ id: 'i1', sha256: 'a'.repeat(64), durationSec: 7, schedule: { days: [1, 2], start: '09:00', end: '18:00' } }],
  };
  const m = buildManifest(screen, lib, 5);
  assert.equal(m.revision, 5);
  assert.equal(m.items[0].durationSec, 7);
  assert.deepEqual(m.items[0].schedule, { days: [1, 2], start: '09:00', end: '18:00' });
  assert.equal(m.settings.fit, 'cover');

  screen.items.push({ id: 'i2', sha256: 'b'.repeat(64) });
  assert.throws(() => buildManifest(screen, lib, 1), /biblioteca/);
});

test('ponta a ponta: painel publica, player sincroniza, offline continua, remoção apaga do disco', async () => {
  const store = new Store(tmp('store'), cipher);
  const bucket = tmp('bucket');
  const storage = createFolderStorage({ folderPath: bucket });
  const src = tmp('src');
  const added = await store.addFiles([sampleFile(src, 'a.png'), sampleFile(src, 'b.jpg'), sampleFile(src, 'c.mp4', 90000)]);
  const [a, b, c] = added.added;

  const project = store.getProject();
  const screen = project.screens[0];
  screen.items = [
    { id: 'i1', sha256: a, durationSec: 6, schedule: null },
    { id: 'i2', sha256: b, durationSec: 12, schedule: { days: [0, 1, 2, 3, 4, 5, 6].slice(0, 6), start: '00:00', end: '23:59' } },
    { id: 'i3', sha256: c, schedule: null },
  ];
  store.saveProject(project);

  const events = [];
  let r = await publishScreen({ storage, screen, library: store.listLibrary(), onProgress: (p) => events.push(p.step) });
  assert.equal(r.uploaded, 3);
  assert.equal(r.manifest.revision, 1);
  assert.equal(events.at(-1), 'done');
  assert.ok(events.indexOf('manifest') > events.lastIndexOf('upload'), 'manifesto vai depois das mídias');
  screen.revision = r.manifest.revision;

  // Republicar sem mudanças não reenvia nada.
  r = await publishScreen({ storage, screen, library: store.listLibrary() });
  assert.equal(r.uploaded, 0);
  assert.equal(r.skipped, 3);
  screen.revision = r.manifest.revision;

  const server = createServer(bucket);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dataDir = tmp('player');
  const engine = new SyncEngine({ dataDir, baseUrl, screenId: 'loja' });
  engine.init();

  try {
    assert.equal((await engine.syncOnce()).status, 'updated');
    assert.equal(engine.playableItems().length, 3);
    assert.equal(engine.manifest.items[1].durationSec, 12);

    // Remove o vídeo na playlist e republica: o player apaga do disco.
    screen.items = screen.items.filter((it) => it.id !== 'i3');
    r = await publishScreen({ storage, screen, library: store.listLibrary() });
    screen.revision = r.manifest.revision;
    assert.equal((await engine.syncOnce()).status, 'updated');
    assert.equal(engine.playableItems().length, 2);
    assert.equal(fs.readdirSync(path.join(dataDir, 'media')).length, 2);

    // Servidor cai: segue com o que tem.
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
    assert.equal((await engine.syncOnce()).status, 'offline');
    assert.equal(engine.playableItems().length, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('publicBaseUrl deriva do endpoint do B2 quando não informado', () => {
  assert.equal(
    publicBaseUrl({ type: 'b2', endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'loja-tv' }),
    'https://loja-tv.s3.us-west-004.backblazeb2.com',
  );
  assert.equal(publicBaseUrl({ type: 'folder', publicBaseUrl: 'http://localhost:8080/' }), 'http://localhost:8080');
});
