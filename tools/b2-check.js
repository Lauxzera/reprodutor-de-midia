'use strict';

// Verificação do Backblaze B2 de ponta a ponta, com SUAS credenciais, no SEU terminal.
// As chaves ficam só nas variáveis de ambiente deste processo e nunca são impressas.
//
//   B2_ENDPOINT   ex.: https://s3.us-west-004.backblazeb2.com
//   B2_BUCKET     nome do bucket (com leitura pública)
//   B2_KEY_ID     keyID da Application Key
//   B2_APP_KEY    applicationKey
//   B2_REGION     opcional (deduzida do endpoint)
//   B2_PUBLIC_URL opcional (padrão: https://<bucket>.<host do endpoint>)
//   B2_PRIVATE    1 = bucket privado: o player lê assinando com chave de leitura (SigV4)
//   B2_READ_KEY_ID / B2_READ_APP_KEY  chave SOMENTE LEITURA do player (se omitidas, usa a de gravação)
//   B2_TEST_MB    tamanho do arquivo grande de teste, padrão 25 (use 0 para pular)
//
// Tudo é criado sob "_check/" e "screens/check-b2.json" e apagado ao final.
// Modo de autoteste sem B2: B2_LOCAL_FOLDER=<pasta> B2_PUBLIC_URL=http://localhost:8080 (com o dev-server servindo a pasta).
//
// Uso: node tools/b2-check.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createB2Storage, createFolderStorage, publicBaseUrl } = require('../packages/panel/src/main/storage');
const { publishScreen } = require('../packages/panel/src/main/publish');
const { signedFetch } = require('../packages/shared');
const { SyncEngine } = require('../packages/player/src/main/sync');

const env = process.env;
const local = env.B2_LOCAL_FOLDER;
let failures = 0;
const isPrivate = env.B2_PRIVATE === '1';
let rf = fetch; // fetch usado nas leituras do player (assinado se o bucket for privado)
let readCreds = null;
const warnings = [];
const toDelete = new Set();

const ms = (t) => `${((Date.now() - t) / 1000).toFixed(1)} s`;
const mb = (n) => (n / 1048576).toFixed(1);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function step(name, fn) {
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  try {
    const note = await fn();
    console.log(`OK (${ms(t)})${note ? ` — ${note}` : ''}`);
    return true;
  } catch (e) {
    failures++;
    console.log(`FALHOU (${ms(t)})\n    ${explain(e).split('\n')[0]}`);
    return false;
  }
}

const warn = (msg) => warnings.push(msg);

function explain(e) {
  const m = String(e && (e.message || e.name));
  if (/InvalidAccessKeyId|AccessDenied|Forbidden|403/i.test(m)) return `${m} → chave sem acesso a este bucket, ou keyID/applicationKey errados`;
  if (/NoSuchBucket/i.test(m)) return `${m} → nome do bucket errado`;
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return `${m} → endpoint errado ou sem internet`;
  return m;
}

(async () => {
  let storage;
  let base;
  if (local) {
    storage = createFolderStorage({ folderPath: local });
    base = (env.B2_PUBLIC_URL || '').replace(/\/+$/, '');
    console.log(`MODO AUTOTESTE (pasta local ${local}), sem B2.\n`);
  } else {
    const missing = ['B2_ENDPOINT', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APP_KEY'].filter((k) => !env[k]);
    if (missing.length) {
      console.error(`Faltam variáveis de ambiente: ${missing.join(', ')}\nVeja o passo a passo em docs/B2.md`);
      process.exit(2);
    }
    const region = env.B2_REGION || (/s3\.([^.]+)\.backblazeb2/.exec(env.B2_ENDPOINT) || [])[1];
    storage = createB2Storage({ endpoint: env.B2_ENDPOINT, region, bucket: env.B2_BUCKET, keyId: env.B2_KEY_ID, appKey: env.B2_APP_KEY });
    base = (env.B2_PUBLIC_URL || publicBaseUrl({ type: 'b2', endpoint: env.B2_ENDPOINT, bucket: env.B2_BUCKET, privateBucket: isPrivate })).replace(/\/+$/, '');
    if (isPrivate) {
      readCreds = { keyId: env.B2_READ_KEY_ID || env.B2_KEY_ID, secretKey: env.B2_READ_APP_KEY || env.B2_APP_KEY, region };
      rf = signedFetch(fetch, readCreds);
      if (!env.B2_READ_KEY_ID) console.log('(sem B2_READ_KEY_ID: lendo com a chave de gravação; o teste da chave de leitura fica para depois)');
    }
    console.log(`Bucket "${env.B2_BUCKET}" em ${env.B2_ENDPOINT}\nURL usada pelo player (${isPrivate ? 'bucket PRIVADO, leituras assinadas' : 'pública'}): ${base}\n`);
  }
  if (!base) {
    console.error('Defina B2_PUBLIC_URL (URL pública do bucket).');
    process.exit(2);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-b2check-'));
  const put = async (key, buf, type = 'application/octet-stream') => {
    const file = path.join(work, crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(file, buf);
    toDelete.add(key);
    await storage.putFile(key, file, { contentType: type, cacheControl: 'public, max-age=31536000, immutable' });
  };

  // 1) credenciais e escrita
  const ok1 = await step('Credenciais: gravar um arquivo de teste no bucket', async () => {
    toDelete.add('_check/ping.json');
    await storage.putJson('_check/ping.json', { at: new Date().toISOString() });
    const size = await storage.exists('_check/ping.json');
    if (size === null) throw new Error('arquivo gravado mas não encontrado (exists=null)');
  }).catch(() => false);

  if (!ok1) {
    console.log('\nSem escrita no bucket não dá para continuar. Confira endpoint, bucket e a chave (leitura e escrita neste bucket).');
    process.exit(1);
  }

  // 2) leitura pública
  const small = crypto.randomBytes(20000);
  await put('_check/small.bin', small);
  await step(isPrivate ? 'Leitura ASSINADA com a chave de leitura (é como o player lê)' : 'Leitura PÚBLICA sem credenciais (é como o player lê)', async () => {
    const r = await rf(`${base}/_check/small.bin`, { signal: AbortSignal.timeout(20000) });
    if (r.status === 401 || r.status === 403) {
      throw new Error(isPrivate ? `HTTP ${r.status}: assinatura recusada (chave de leitura errada, sem acesso ao bucket, ou região errada)` : `HTTP ${r.status}: o bucket não está público. No B2: Bucket Settings > Files in Bucket are: Public`);
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status} em ${base}/_check/small.bin (confira B2_PUBLIC_URL)`);
    if (sha(Buffer.from(await r.arrayBuffer())) !== sha(small)) throw new Error('conteúdo baixado difere do enviado');
    return `Content-Type ${r.headers.get('content-type')}`;
  });

  if (isPrivate) {
    await step('Bucket realmente privado: leitura SEM assinatura deve ser recusada', async () => {
      const r = await fetch(`${base}/_check/small.bin`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 200) throw new Error('o bucket está público; qualquer pessoa com a URL consegue ler');
      return `HTTP ${r.status}`;
    });
  }

  // 3) Range (retomada de download)
  await step('Download parcial (Range), usado para retomar downloads', async () => {
    const r = await rf(`${base}/_check/small.bin`, { headers: { range: 'bytes=100-199' } });
    const body = Buffer.from(await r.arrayBuffer());
    if (r.status !== 206 || body.length !== 100) throw new Error(`esperado 206 com 100 bytes, veio HTTP ${r.status} com ${body.length}`);
    if (!body.equals(small.subarray(100, 200))) throw new Error('bytes devolvidos não conferem');
  });

  // 4) arquivo grande
  const mbSize = Number(env.B2_TEST_MB ?? 25);
  if (mbSize > 0) {
    const big = Buffer.concat(Array.from({ length: mbSize }, () => crypto.randomBytes(1048576)));
    const bigFile = path.join(work, 'big.bin');
    fs.writeFileSync(bigFile, big);
    toDelete.add('_check/large.bin');
    await step(`Enviar arquivo de ${mbSize} MB (envio em partes)`, async () => {
      const t = Date.now();
      await storage.putFile('_check/large.bin', bigFile, { contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' });
      return `${(mbSize / ((Date.now() - t) / 1000)).toFixed(1)} MB/s`;
    });
    await step(`Baixar os ${mbSize} MB pela URL pública e conferir o hash`, async () => {
      const t = Date.now();
      const r = await rf(`${base}/_check/large.bin`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (sha(buf) !== sha(big)) throw new Error('hash diferente do enviado');
      return `${(mbSize / ((Date.now() - t) / 1000)).toFixed(1)} MB/s`;
    });
  }

  // 5) manifesto: cabeçalhos e ETag
  const a = crypto.randomBytes(30000);
  const b = crypto.randomBytes(30000);
  const entry = (name, buf) => ({ sha256: sha(buf), ext: '.png', type: 'image', size: buf.length, name, path: path.join(work, name) });
  const A = entry('a.png', a);
  const B = entry('b.png', b);
  fs.writeFileSync(A.path, a);
  fs.writeFileSync(B.path, b);
  const library = [A, B];
  const screen = { id: 'check-b2', revision: 0, settings: { fit: 'contain', transitionMs: 600, muted: true }, items: [{ id: 'i1', sha256: A.sha256, durationSec: 5 }, { id: 'i2', sha256: B.sha256, durationSec: 5 }] };
  toDelete.add('screens/check-b2.json');
  for (const m of library) toDelete.add(`media/${m.sha256}.png`);

  await step('Publicar uma tela de teste (mídias primeiro, manifesto por último)', async () => {
    const r = await publishScreen({ storage, screen, library });
    screen.revision = r.manifest.revision;
    return `${r.uploaded} mídia(s) enviada(s)`;
  });

  await step('Manifesto: cabeçalhos de cache e ETag', async () => {
    const r1 = await rf(`${base}/screens/check-b2.json`, { headers: { 'cache-control': 'no-cache' } });
    if (r1.status !== 200) throw new Error(`HTTP ${r1.status} em ${base}/screens/check-b2.json`);
    const etag = r1.headers.get('etag');
    const cc = r1.headers.get('cache-control');
    if (!/no-cache|no-store|max-age=0/i.test(cc || '')) warn(`o manifesto veio com Cache-Control "${cc}"; uma cópia em cache poderia atrasar atualizações`);
    if (!etag) {
      warn('o servidor não devolveu ETag: o player vai baixar o manifesto inteiro a cada consulta (funciona, só gasta um pouco mais de transações)');
      return 'sem ETag';
    }
    const r2 = await rf(`${base}/screens/check-b2.json`, { headers: { 'if-none-match': etag } });
    if (r2.status !== 304) warn(`If-None-Match devolveu HTTP ${r2.status} em vez de 304: o player baixa o manifesto inteiro a cada consulta (funciona)`);
    return `ETag ${etag.slice(0, 14)}…, condicional → HTTP ${r2.status}`;
  });

  // 6) player de verdade
  const dataDir = path.join(work, 'player');
  const engine = new SyncEngine({ dataDir, baseUrl: base, screenId: 'check-b2', ...(readCreds || {}) });
  engine.init();
  await step('Player: sincronizar do bucket público e tocar do disco', async () => {
    const r = await engine.syncOnce();
    if (r.status !== 'updated') throw new Error(`${r.status}: ${r.message || ''}`);
    if (engine.playableItems().length !== 2) throw new Error(`${engine.playableItems().length} de 2 itens no disco`);
  });

  await step('Painel remove um item, republica; player apaga do disco', async () => {
    screen.items = screen.items.slice(0, 1);
    const r = await publishScreen({ storage, screen, library });
    screen.revision = r.manifest.revision;
    const s = await engine.syncOnce();
    if (s.status !== 'updated') throw new Error(`${s.status}: ${s.message || ''}`);
    const files = fs.readdirSync(path.join(dataDir, 'media'));
    if (files.length !== 1) throw new Error(`${files.length} arquivos no disco, esperado 1`);
  });

  // 7) limpeza
  await step('Limpeza: apagar os arquivos de teste do bucket', async () => {
    let n = 0;
    for (const key of toDelete) {
      await storage.delete(key);
      n++;
    }
    return `${n} arquivos`;
  });
  fs.rmSync(work, { recursive: true, force: true });

  console.log('\n--- Resumo ---');
  console.log(failures ? `${failures} verificação(ões) falharam.` : 'Todas as verificações passaram.');
  for (const w of warnings) console.log(`Aviso: ${w}`);
  if (!local) {
    console.log('\nCuidados com o plano gratuito do B2 (confira os limites atuais no site):');
    console.log('• Cada consulta do player ao manifesto conta como uma transação de leitura; o limite diário gratuito é pequeno (da ordem de 2.500).');
    console.log('  Consulta a cada 60 s = 1.440/dia por tela; a cada 120 s = 720/dia. Com várias telas, aumente "Consultar a cada" no player.');
    console.log('• Arquivos apagados pela API ficam como versões ocultas e ainda ocupam espaço: nas configurações do bucket,');
    console.log('  em Lifecycle Settings, escolha "Keep only the last version of the file".');
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(`\nErro inesperado: ${explain(e)}`);
  process.exit(1);
});
