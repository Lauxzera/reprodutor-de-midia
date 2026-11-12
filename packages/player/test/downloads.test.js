'use strict';

// Fila de downloads do player: andamento por mídia, prioridade, "baixar já", pausa e gerenciamento.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SyncEngine } = require('../src/main/sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-dl-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 500;
const CHUNKS = 8; // 4000 bytes por mídia
const DELAY = 25;

function media(seed) {
  const buf = Buffer.alloc(CHUNK * CHUNKS, seed.charCodeAt(0));
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { buf, item: { id: seed, type: 'image', file: `media/${hash}.jpg`, sha256: hash, size: buf.length, name: `${seed}.jpg`, durationSec: 5 } };
}

/** Servidor de mentira: entrega a mídia aos poucos (dá tempo de mexer na fila) e respeita Range e abort. */
function fakeBucket(items) {
  const byFile = new Map(items.map((m) => [m.item.file, m]));
  const manifest = JSON.stringify({ schemaVersion: 1, screenId: 'loja', revision: 3, items: items.map((m) => m.item) });
  const calls = []; // "a:0" = arquivo a começando do byte 0
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/screens/loja.json') return new Response(manifest, { status: 200, headers: { etag: '"m3"' } });
    const m = byFile.get(u.pathname.slice(1));
    if (!m) return new Response('', { status: 404 });
    const range = /bytes=(\d+)-/.exec((init.headers || {}).range || '');
    const from = range ? Number(range[1]) : 0;
    calls.push(`${m.item.id}:${from}`);
    const signal = init.signal;
    let pos = from;
    const body = new ReadableStream({
      async pull(ctrl) {
        await sleep(DELAY);
        if (signal && signal.aborted) return ctrl.error(Object.assign(new Error('abortado'), { name: 'AbortError' }));
        if (pos >= m.buf.length) return ctrl.close();
        ctrl.enqueue(m.buf.subarray(pos, pos + CHUNK));
        pos += CHUNK;
      },
    });
    return new Response(body, { status: range ? 206 : 200, headers: { 'content-length': String(m.buf.length - from) } });
  };
  return { fetch, calls };
}

function setup(seeds) {
  const items = seeds.map(media);
  const { fetch, calls } = fakeBucket(items);
  const dataDir = tmp();
  const engine = new SyncEngine({ dataDir, baseUrl: 'http://bucket.test', screenId: 'loja', fetch });
  engine.init();
  const by = Object.fromEntries(items.map((m) => [m.item.id, m.item]));
  const statusOf = (id) => engine.downloadStatus().items.find((x) => x.id === id);
  const waitFor = async (cond, ms = 4000) => {
    const t0 = Date.now();
    const ok = () => {
      try {
        return cond();
      } catch {
        return false; // a sincronização ainda não começou
      }
    };
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição');
      await sleep(10);
    }
  };
  return { engine, calls, by, dataDir, statusOf, waitFor, mediaPath: (id) => path.join(dataDir, 'media', path.basename(by[id].file)) };
}

test('andamento: cada mídia mostra estado e porcentagem enquanto baixa', async () => {
  const t = setup(['a', 'b']);
  const run = t.engine.syncOnce();
  await t.waitFor(() => t.statusOf('a') && t.statusOf('a').state === 'downloading' && t.statusOf('a').received > 0);
  const a = t.statusOf('a');
  assert.ok(a.total === 4000 && a.received > 0 && a.received < 4000, 'a tem porcentagem parcial');
  assert.equal(t.statusOf('b').state, 'queued', 'b espera na fila');
  assert.equal(t.engine.downloadStatus().incoming, true, 'programação nova ainda não ativada');
  assert.deepEqual(t.engine.downloadStatus().items.map((x) => x.order), [1, 2]);
  await run;
  assert.ok(t.engine.downloadStatus().items.every((x) => x.state === 'done' && x.received === x.total));
  assert.equal(t.engine.downloadStatus().incoming, false);
});

test('"baixar já": interrompe a atual, baixa a escolhida primeiro e a interrompida retoma de onde parou', async () => {
  const t = setup(['a', 'b', 'c']);
  const run = t.engine.syncOnce();
  await t.waitFor(() => t.statusOf('a').state === 'downloading' && t.statusOf('a').received >= CHUNK);
  assert.deepEqual(t.engine.setPriority(t.by.c.file, 'first'), { ok: true });
  await run;
  const order = t.calls.map((c) => c.split(':')[0]);
  assert.equal(order[0], 'a');
  assert.equal(order[1], 'c', 'c passou na frente');
  const resumed = t.calls.find((c, i) => i > 1 && c.startsWith('a:'));
  assert.ok(resumed && Number(resumed.split(':')[1]) > 0, `a retomou do meio (${t.calls.join(' ')})`);
  assert.equal(t.engine.playableItems().length, 3);
  for (const id of ['a', 'b', 'c']) assert.equal(fs.statSync(t.mediaPath(id)).size, 4000, `${id} completa e conferida`);
});

test('ordem: subir e descer mudam a fila; o que não foi ordenado segue a ordem do manifesto', async () => {
  const t = setup(['a', 'b', 'c', 'd']);
  const run = t.engine.syncOnce();
  await t.waitFor(() => t.statusOf('a').state === 'downloading');
  assert.equal(t.engine.setPriority(t.by.d.file, 'up').ok, true); // a b d c
  assert.deepEqual(t.engine.downloadStatus().items.map((x) => x.id), ['a', 'b', 'd', 'c']);
  assert.equal(t.engine.setPriority(t.by.b.file, 'down').ok, true); // a d b c
  assert.deepEqual(t.engine.downloadStatus().items.map((x) => x.id), ['a', 'd', 'b', 'c']);
  assert.equal(t.engine.setPriority(t.by.c.file, 'top').ok, true); // c a d b (não interrompe a atual)
  assert.deepEqual(t.engine.downloadStatus().items.map((x) => x.id), ['c', 'a', 'd', 'b']);
  assert.equal(t.engine.setPriority('media/inexistente.jpg', 'up').ok, false);
  await run;
  assert.equal(t.calls.filter((c) => c.startsWith('a:')).length, 1, 'top não interrompe o download em andamento');
  assert.deepEqual(t.calls.map((c) => c.split(':')[0]), ['a', 'c', 'd', 'b']);
  assert.deepEqual(t.engine.state.priority, [t.by.c.file, t.by.a.file, t.by.d.file, t.by.b.file], 'a ordem fica gravada');
});

test('pausa: item pausado não baixa, não trava a programação nova e pode ser retomado', async () => {
  const t = setup(['a', 'b']);
  const run = t.engine.syncOnce();
  await t.waitFor(() => t.statusOf('a').state === 'downloading');
  t.engine.setPaused(t.by.b.file, true);
  await run;
  assert.equal(t.statusOf('b').state, 'paused');
  assert.equal(fs.existsSync(t.mediaPath('b')), false);
  assert.equal(t.engine.manifest.revision, 3, 'programação ativada mesmo com uma mídia pausada');
  assert.equal(t.engine.playableItems().length, 1, 'toca só o que está no disco');

  t.engine.setPaused(t.by.b.file, false);
  await t.waitFor(() => fs.existsSync(t.mediaPath('b')) && t.statusOf('b').state === 'done');
  assert.equal(t.engine.playableItems().length, 2);
});

test('pausar a que está baixando interrompe na hora e guarda o que já veio', async () => {
  const t = setup(['a']);
  const run = t.engine.syncOnce();
  await t.waitFor(() => t.statusOf('a').state === 'downloading' && t.statusOf('a').received >= CHUNK);
  t.engine.setPaused(t.by.a.file, true);
  await run;
  const a = t.statusOf('a');
  assert.equal(a.state, 'paused');
  assert.ok(a.received > 0 && a.received < 4000, 'parcial preservado e mostrado');
  t.engine.pauseAll(false);
  await t.waitFor(() => t.statusOf('a').state === 'done');
  assert.ok(t.calls.some((c) => c.startsWith('a:') && Number(c.split(':')[1]) > 0), 'retomou com Range');
});

test('gerenciar: baixar de novo apaga e baixa outra vez; remover do disco apaga e não volta sozinha', async () => {
  const t = setup(['a', 'b']);
  await t.engine.syncOnce();
  assert.equal(t.engine.playableItems().length, 2);

  assert.equal((await t.engine.removeLocal(t.by.a.file, { redownload: true })).ok, true);
  await t.waitFor(() => t.statusOf('a').state === 'done' && t.calls.filter((c) => c.startsWith('a:')).length === 2);
  assert.equal(fs.statSync(t.mediaPath('a')).size, 4000);

  assert.equal((await t.engine.removeLocal(t.by.b.file, { redownload: false })).ok, true);
  await sleep(150);
  assert.equal(fs.existsSync(t.mediaPath('b')), false);
  assert.equal(t.statusOf('b').state, 'paused', 'fica pausada: não volta sozinha');
  await t.engine.syncOnce();
  assert.equal(fs.existsSync(t.mediaPath('b')), false, 'nem na próxima sincronização');
  t.engine.setPaused(t.by.b.file, false);
  await t.waitFor(() => t.statusOf('b').state === 'done');
});

test('a fila e as pausas sobrevivem a um reinício (state.json)', async () => {
  const t = setup(['a', 'b']);
  const run = t.engine.syncOnce();
  await t.waitFor(() => t.statusOf('a').state === 'downloading');
  t.engine.setPriority(t.by.b.file, 'top');
  t.engine.setPaused(t.by.b.file, true);
  await run;
  await sleep(50);
  const again = new SyncEngine({ dataDir: t.dataDir, baseUrl: 'http://bucket.test', screenId: 'loja', fetch: async () => new Response('', { status: 500 }) });
  again.init();
  assert.deepEqual(again.state.paused, [t.by.b.file]);
  assert.equal(again.state.priority[0], t.by.b.file);
});
