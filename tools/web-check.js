'use strict';

// Verifica, contra o B2 real, o cliente S3 do painel web (o mesmo código que roda no navegador),
// incluindo o preflight de CORS simulando a origem do site.
//   B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY  e  WEB_ORIGIN (ex.: https://lauxzera.github.io)
const crypto = require('node:crypto');
const { createS3 } = require('../packages/web/src/s3');

const { B2_ENDPOINT: endpoint, B2_BUCKET: bucket, B2_KEY_ID: keyId, B2_APP_KEY: appKey, WEB_ORIGIN: origin } = process.env;
if (!endpoint || !bucket || !keyId || !appKey) {
  console.error('Faltam B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY');
  process.exit(2);
}
const s3 = createS3({ endpoint, bucket, keyId, appKey });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let failures = 0;
const created = [];

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  try {
    const note = await fn();
    console.log(`OK${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FALHOU\n    ${e.message}`);
  }
}

(async () => {
  const big = crypto.randomBytes(6 * 1024 * 1024);
  const base = `${endpoint}/${bucket}`;

  await step('Gravar JSON (PUT com UNSIGNED-PAYLOAD)', async () => {
    created.push('_webcheck/a.json');
    await s3.putJson('_webcheck/a.json', { ok: true });
  });
  await step('Ler JSON assinado', async () => {
    const j = await s3.getJson('_webcheck/a.json');
    if (!j || j.ok !== true) throw new Error('conteúdo diferente');
  });
  await step('Gravar arquivo de 6 MB e consultar tamanho (HEAD)', async () => {
    created.push('_webcheck/big.bin');
    await s3.putFile('_webcheck/big.bin', new Blob([big]), { contentType: 'application/octet-stream' });
    const size = await s3.exists('_webcheck/big.bin');
    if (size !== big.length) throw new Error(`tamanho ${size}, esperado ${big.length}`);
  });
  await step('HEAD de arquivo inexistente devolve null', async () => {
    if ((await s3.exists('_webcheck/nao-existe.bin')) !== null) throw new Error('esperado null');
  });
  await step('Listar por prefixo', async () => {
    const l = await s3.list('_webcheck/');
    if (l.length !== 2) throw new Error(`esperado 2, veio ${l.length}: ${l.map((x) => x.key).join(', ')}`);
    return l.map((x) => x.key).join(', ');
  });
  await step('URL pré-assinada baixa o arquivo sem cabeçalhos (como <img>/<video>)', async () => {
    const r = await fetch(await s3.presign('_webcheck/big.bin', 300));
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (sha(Buffer.from(await r.arrayBuffer())) !== sha(big)) throw new Error('hash diferente');
  });
  await step('URL pré-assinada adulterada é recusada', async () => {
    const u = (await s3.presign('_webcheck/big.bin', 300)).replace(/Signature=./, 'Signature=0');
    const r = await fetch(u);
    if (r.status === 200) throw new Error('aceitou assinatura inválida');
    return `HTTP ${r.status}`;
  });
  if (origin) {
    await step(`Preflight de CORS para ${origin}`, async () => {
      const r = await fetch(`${base}/_webcheck/a.json`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,x-amz-content-sha256,x-amz-date,content-type,cache-control' },
      });
      const allow = r.headers.get('access-control-allow-origin');
      if (r.status >= 300 || !allow) throw new Error(`HTTP ${r.status}, sem Access-Control-Allow-Origin (rode tools/b2-cors.js)`);
      return `HTTP ${r.status}, allow-origin ${allow}, métodos ${r.headers.get('access-control-allow-methods')}`;
    });
    await step('Resposta real traz Access-Control-Allow-Origin (GET com origem)', async () => {
      const r = await fetch(`${base}/_webcheck/a.json`, { headers: { origin, ...(await require('../packages/web/src/s3').signHeaders({ method: 'GET', url: `${base}/_webcheck/a.json`, keyId, secretKey: appKey, region: s3.region })) } });
      if (!r.headers.get('access-control-allow-origin')) throw new Error('sem cabeçalho CORS na resposta');
    });
  }
  await step('Apagar os arquivos de teste', async () => {
    for (const k of created) await s3.delete(k);
    if ((await s3.list('_webcheck/')).length) throw new Error('sobraram arquivos');
  });
  console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nTodas as verificações passaram.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(`Erro: ${e.message}`);
  process.exit(1);
});
