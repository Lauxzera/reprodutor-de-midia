'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

// No navegador "@reprodutor/shared" aponta só para o manifesto; replicamos isso aqui.
const manifestPath = path.resolve(__dirname, '../../shared/src/manifest.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return origResolve.call(this, request === '@reprodutor/shared' ? manifestPath : request, ...rest);
};

const { Sha256, sha256Blob } = require('../src/sha256');
const { signHeaders, presignGet, EMPTY_SHA256 } = require('../src/s3');
const { signGet } = require('../../shared/src/sigv4');
const vault = require('../src/vault');
const { createMemoryS3 } = require('../src/memory-s3');
const { createWebApi } = require('../src/web-api');

const nodeSha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('SHA-256 incremental confere com o do Node (tamanhos de borda e fatias irregulares)', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100000]) {
    const buf = crypto.randomBytes(n);
    const h = new Sha256();
    for (let i = 0; i < n; ) {
      const step = 1 + Math.floor(Math.random() * 97);
      h.update(buf.subarray(i, Math.min(n, i + step)));
      i += step;
    }
    assert.equal(h.hex(), nodeSha(buf), `tamanho ${n}`);
  }
});

test('sha256Blob lê um Blob grande em fatias e confere', async () => {
  const buf = crypto.randomBytes(9 * 1024 * 1024 + 123);
  let last = 0;
  const hash = await sha256Blob(new Blob([buf]), (f) => (last = f));
  assert.equal(hash, nodeSha(buf));
  assert.equal(last, 1);
});

test('assinatura do navegador é idêntica à do Node para o mesmo pedido', async () => {
  const now = new Date('2026-11-10T12:34:56Z');
  const creds = { keyId: 'AKIDEXAMPLE', secretKey: 'segredo', region: 'us-east-005', now };
  const url = 'https://s3.us-east-005.backblazeb2.com/bucket/screens/loja.json';
  const web = await signHeaders({ method: 'GET', url, ...creds });
  const node = signGet(url, creds);
  assert.equal(web.authorization, node.authorization);
  assert.equal(web['x-amz-date'], node['x-amz-date']);
  assert.equal(web['x-amz-content-sha256'], EMPTY_SHA256);
});

test('URL pré-assinada tem os parâmetros esperados e é determinística', async () => {
  const args = { url: 'https://s3.us-east-005.backblazeb2.com/b/media/a b.png', keyId: 'K', secretKey: 'S', region: 'us-east-005', expires: 600, now: new Date('2026-01-01T00:00:00Z') };
  const u1 = await presignGet(args);
  assert.equal(u1, await presignGet(args));
  const q = new URL(u1).searchParams;
  assert.equal(q.get('X-Amz-Expires'), '600');
  assert.equal(q.get('X-Amz-SignedHeaders'), 'host');
  assert.match(q.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
});

test('cofre: criptografa, abre com a senha certa e recusa a errada', async () => {
  const sealed = await vault.seal('senha-forte-1', { keyId: 'k', appKey: 'segredo' });
  assert.ok(!JSON.stringify(sealed).includes('segredo'));
  assert.deepEqual(await vault.open('senha-forte-1', sealed), { keyId: 'k', appKey: 'segredo' });
  await assert.rejects(() => vault.open('outra-senha', sealed), /Senha incorreta/);
});

test('API web: adicionar mídia, montar playlist, publicar e limpar órfãs', async () => {
  const storage = createMemoryS3();
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  const api = createWebApi({ storage, settings, saveSettings: async (p) => Object.assign(settings, p) });

  const png = new File([crypto.randomBytes(2000)], 'foto.png', { type: 'image/png' });
  const mp4 = new File([crypto.randomBytes(5000)], 'filme.mp4', { type: 'video/mp4' });
  const txt = new File(['x'], 'nota.txt');
  const r = await api.library.addPaths([png, mp4, txt, png]);
  assert.equal(r.added.length, 2);
  assert.equal(r.skipped.length, 2); // .txt e duplicada

  const lib = await api.library.list();
  assert.equal(lib.length, 2);
  for (const m of lib) assert.ok(storage.objects.has(`media/${m.sha256}${m.ext}`));

  const project = await api.project.get();
  const screen = project.screens[0];
  screen.items.push({ id: 'a', sha256: lib[0].sha256, durationSec: 7 }, { id: 'b', sha256: lib[1].sha256 });
  await api.project.save(project);

  const events = [];
  api.publish.onProgress((p) => events.push(p.step));
  const pub = await api.publish.run(screen.id);
  assert.equal(pub.revision, 1);
  assert.equal(pub.baseUrl, 'https://s3.us-east-005.backblazeb2.com/b');
  assert.ok(events.includes('manifest'));
  const manifest = await storage.getJson(`screens/${screen.id}.json`);
  assert.equal(manifest.items.length, 2);
  assert.equal(manifest.items[0].durationSec, 7);

  // em uso: não pode excluir
  assert.equal((await api.library.remove(lib[0].sha256)).ok, false);

  // uma mídia órfã (enviada e depois removida da biblioteca) é apagada; as publicadas ficam
  const extra = new File([crypto.randomBytes(300)], 'extra.png');
  const added = await api.library.addPaths([extra]);
  assert.equal((await api.library.remove(added.added[0])).ok, true);
  const clean = await api.cleanOrphans();
  assert.equal(clean.removed, 1);
  assert.ok(storage.objects.has(`media/${lib[0].sha256}${lib[0].ext}`));

  // estado persiste no "bucket": uma nova instância enxerga tudo
  const api2 = createWebApi({ storage, settings, saveSettings: async () => {} });
  assert.equal((await api2.library.list()).length, 2);
  assert.equal((await api2.project.get()).screens[0].revision, 1);
});

test('API web: mede o uso do bucket e recusa envio que estouraria os 10 GB gratuitos', async () => {
  const storage = createMemoryS3();
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  const api = createWebApi({ storage, settings, saveSettings: async () => {} });

  await api.library.addPaths([new File([crypto.randomBytes(1000)], 'a.png')]);
  const q = await api.quota.get();
  assert.ok(q.used >= 1000);
  assert.equal(q.level, 'ok');
  assert.equal(q.limit, 10 * 1024 ** 3);

  // simula um bucket quase cheio: um objeto de "9,99 GB" na lista e um arquivo novo que não cabe
  const realList = storage.list.bind(storage);
  storage.list = async (p) => [...(await realList(p)), { key: 'media/enorme.bin', size: 10 * 1024 ** 3 - 500 }];
  const full = createWebApi({ storage, settings, saveSettings: async () => {} });
  const r = await full.library.addPaths([new File([crypto.randomBytes(2000)], 'b.png')]);
  assert.equal(r.added.length, 0);
  assert.match(r.skipped[0].reason, /não cabe/);
  assert.equal((await full.quota.get()).level, 'over'); // 10 GB - 500 B + os 1000 B já enviados
});

test('API web: gera o código de pareamento com a chave de leitura (nunca a de gravação)', async () => {
  const { decodePair } = require('../../shared/src/pair');
  const storage = createMemoryS3();
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'loja', privateBucket: true, publicBaseUrl: '' };
  let rk = null;
  const api = createWebApi({ storage, settings, saveSettings: async () => {}, getReadKey: () => rk });

  const semChave = await api.pair.code();
  assert.equal(semChave.ok, false);
  assert.match(semChave.error, /chave de leitura/);

  rk = { keyId: 'LEITURA-ID', appKey: 'LEITURA-SEGREDO' };
  const r = await api.pair.code();
  assert.equal(r.ok, true);
  const d = decodePair(r.code);
  assert.equal(d.baseUrl, 'https://s3.us-east-005.backblazeb2.com/loja');
  assert.equal(d.keyId, 'LEITURA-ID');
  assert.equal(d.secretKey, 'LEITURA-SEGREDO');
  assert.equal(d.pollSeconds, 120);
  assert.equal((await api.settings.get()).hasReadKey, true);

  // bucket público: o código não leva chave nenhuma
  settings.privateBucket = false;
  const pub = decodePair((await api.pair.code()).code);
  assert.equal(pub.keyId, '');
  assert.equal(pub.baseUrl, 'https://loja.s3.us-east-005.backblazeb2.com');
});

test('sonda de codec: acha hvc1/hev1/avc1 mesmo na fronteira entre fatias de 4 MB', async () => {
  const { hashAndProbe } = require('../src/sha256');
  const SLICE = 4 * 1024 * 1024;
  const mk = (tag, at) => {
    const b = Buffer.alloc(SLICE * 2 + 100, 0x20);
    Buffer.from(tag).copy(b, at);
    return b;
  };
  const hevc = await hashAndProbe(new Blob([mk('hvc1', SLICE - 2)])); // a marca atravessa a fronteira
  assert.deepEqual([hevc.hevc, hevc.h264], [true, false]);
  assert.equal(hevc.sha256, nodeSha(mk('hvc1', SLICE - 2)));
  const avc = await hashAndProbe(new Blob([mk('avc1', 10)]));
  assert.deepEqual([avc.hevc, avc.h264], [false, true]);
  const none = await hashAndProbe(new Blob([crypto.randomBytes(1000)]));
  assert.deepEqual([none.hevc, none.h264], [false, false]);
});

test('API web: recusa vídeo só HEVC (iPhone) e aceita H.264', async () => {
  const storage = createMemoryS3();
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  const api = createWebApi({ storage, settings, saveSettings: async () => {} });
  const fake = (tag) => new File([Buffer.concat([Buffer.from('....ftypqt  ....moov'), Buffer.from(tag), crypto.randomBytes(500)])], `${tag}.mov`);

  const r = await api.library.addPaths([fake('hvc1'), fake('avc1')]);
  assert.equal(r.added.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /HEVC.*H\.264/);
  assert.equal([...storage.objects.keys()].filter((k) => k.startsWith('media/')).length, 1, 'o HEVC não foi enviado ao bucket');
});

test('API web: com conversor, vídeo HEVC é convertido e o MP4 H.264 é o que vai ao bucket', async () => {
  const storage = createMemoryS3();
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  const hevc = new File([Buffer.concat([Buffer.from('....ftypqt  ....moov'), Buffer.from('hvc1'), crypto.randomBytes(800)])], 'iphone.mov');
  const calls = [];
  const convertVideo = async (file, { onProgress }) => {
    calls.push(file.name);
    onProgress(0.5);
    onProgress(1);
    return new File([Buffer.concat([Buffer.from('....ftypisom....moov'), Buffer.from('avc1'), crypto.randomBytes(300)])], 'iphone.mp4', { type: 'video/mp4' });
  };
  const api = createWebApi({ storage, settings, saveSettings: async () => {}, convertVideo });
  const msgs = [];
  api.library.onProgress((m) => msgs.push(m));

  const r = await api.library.addPaths([hevc]);
  assert.equal(r.added.length, 1);
  assert.deepEqual(calls, ['iphone.mov']);
  const lib = await api.library.list();
  assert.equal(lib[0].name, 'iphone.mp4');
  assert.equal(lib[0].ext, '.mp4');
  assert.ok(storage.objects.has(`media/${lib[0].sha256}.mp4`));
  assert.ok(msgs.some((m) => /convertendo de HEVC/.test(m)));

  // conversor que falha (navegador sem decodificador de HEVC): explica e não envia nada
  const failing = createWebApi({ storage: createMemoryS3(), settings, saveSettings: async () => {}, convertVideo: async () => { throw new Error('este navegador não consegue decodificar o vídeo'); } });
  const f = await failing.library.addPaths([hevc]);
  assert.equal(f.added.length, 0);
  assert.match(f.skipped[0].reason, /não consegue decodificar/);
});

test('limpeza de órfãs: não apaga o que uma tela publicada ainda usa e avisa o motivo', async () => {
  const storage = createMemoryS3();
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  const api = createWebApi({ storage, settings, saveSettings: async () => {} });

  const a = new File([crypto.randomBytes(900)], 'a.png');
  const added = await api.library.addPaths([a]);
  const project = await api.project.get();
  project.screens[0].items.push({ id: 'x', sha256: added.added[0], durationSec: 5 });
  await api.project.save(project);
  await api.publish.run(project.screens[0].id); // tela publicada usa a.png

  // tira da playlist e da biblioteca, mas não republica
  project.screens[0].items = [];
  await api.project.save(project);
  await api.library.remove(added.added[0]);

  const r1 = await api.cleanOrphans();
  assert.equal(r1.removed, 0);
  assert.equal(r1.held.length, 1);
  assert.deepEqual(r1.held[0].screens, [project.screens[0].id]);

  // republica sem o arquivo: agora ele é órfão de verdade
  await api.publish.run(project.screens[0].id);
  const r2 = await api.cleanOrphans();
  assert.equal(r2.removed, 1);
  assert.equal(r2.held.length, 0);
  assert.equal([...storage.objects.keys()].filter((k) => k.startsWith('media/')).length, 0);
});

test('vídeo H.264 pesado (4K ou 60 fps) é otimizado; dentro do limite fica intacto; falha usa o original', async () => {
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  const mk = (name, size) => new File([Buffer.concat([Buffer.from('....ftypisom....moov'), Buffer.from('avc1'), crypto.randomBytes(size)])], name, { type: 'video/mp4' });
  const smallOut = () => mk('grande.mp4', 200);

  // pesado: troca pelo arquivo menor
  const heavy = createWebApi({ storage: createMemoryS3(), settings, saveSettings: async () => {}, convertVideo: async () => smallOut(), analyzeVideo: async () => ({ heavy: true, why: '3840x2160' }), getOptimize: () => true });
  const msgs = [];
  heavy.library.onProgress((m) => msgs.push(m));
  const big = mk('grande.mp4', 5000);
  const r1 = await heavy.library.addPaths([big]);
  assert.equal(r1.added.length, 1);
  assert.ok(msgs.some((m) => /vídeo pesado \(3840x2160\)/.test(m)));
  assert.ok((await heavy.library.list())[0].size < big.size, 'foi enviado o arquivo otimizado');

  // dentro do limite: o conversor nem é chamado
  let called = 0;
  const light = createWebApi({ storage: createMemoryS3(), settings, saveSettings: async () => {}, convertVideo: async () => { called++; return smallOut(); }, analyzeVideo: async () => ({ heavy: false, why: '' }), getOptimize: () => true });
  const orig = mk('ok.mp4', 3000);
  await light.library.addPaths([orig]);
  assert.equal(called, 0);
  assert.equal((await light.library.list())[0].size, orig.size);

  // conversor falha: segue com o original em vez de recusar o arquivo
  const failing = createWebApi({ storage: createMemoryS3(), settings, saveSettings: async () => {}, convertVideo: async () => { throw new Error('sem encoder'); }, analyzeVideo: async () => ({ heavy: true, why: '60 fps' }), getOptimize: () => true });
  const m2 = [];
  failing.library.onProgress((m) => m2.push(m));
  const r3 = await failing.library.addPaths([mk('f.mp4', 2000)]);
  assert.equal(r3.added.length, 1);
  assert.ok(m2.some((m) => /não foi possível otimizar/.test(m)));
});

test('otimização de vídeo pesado vem ligada por padrão; desligada, preserva a resolução original', async () => {
  const settings = { endpoint: 'https://s3.us-east-005.backblazeb2.com', region: '', bucket: 'b', privateBucket: true, publicBaseUrl: '' };
  let chamadas = 0;
  const api = createWebApi({ storage: createMemoryS3(), settings, saveSettings: async () => {}, convertVideo: async () => { chamadas++; return new File([Buffer.from('x')], 'x.mp4'); }, analyzeVideo: async () => ({ heavy: true, why: '3840x2160' }) });
  const big = new File([Buffer.concat([Buffer.from('....ftypisom....moov'), Buffer.from('avc1'), crypto.randomBytes(4000)])], '4k.mp4', { type: 'video/mp4' });
  assert.equal(api.library.optimize.get(), true);
  await api.library.addPaths([big]);
  assert.equal(chamadas, 1, 'ligada por padrão: o vídeo 4K é reduzido');

  const off = createWebApi({ storage: createMemoryS3(), settings, saveSettings: async () => {}, convertVideo: async () => { chamadas++; return new File([Buffer.from('x')], 'x.mp4'); }, analyzeVideo: async () => ({ heavy: true, why: '3840x2160' }), getOptimize: () => false });
  await off.library.addPaths([big]);
  assert.equal(chamadas, 1, 'desligada: nada é recomprimido');
  assert.equal((await off.library.list())[0].size, big.size);
});
