'use strict';

// Configura o CORS do bucket para o painel web poder falar com o B2 a partir do navegador.
// Usa a API nativa do B2 (b2_update_bucket); a chave precisa da permissão writeBuckets.
//
//   B2_BUCKET, B2_KEY_ID, B2_APP_KEY   (env; as chaves nunca são impressas)
//   node tools/b2-cors.js https://lauxzera.github.io [http://localhost:8099 ...]
//
// Só mexe nas regras de CORS (nome "painel-web"); as outras regras do bucket são mantidas.

const origins = process.argv.slice(2);
const { B2_BUCKET: bucket, B2_KEY_ID: keyId, B2_APP_KEY: appKey } = process.env;

if (!origins.length || !bucket || !keyId || !appKey) {
  console.error('Uso: B2_BUCKET=... B2_KEY_ID=... B2_APP_KEY=... node tools/b2-cors.js <origem> [<origem>...]');
  process.exit(2);
}

async function api(url, init) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${body.code || r.status}: ${body.message || r.statusText}`);
  return body;
}

(async () => {
  const auth = await api('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}` },
  });
  const storage = auth.apiInfo.storageApi;
  const apiUrl = storage.apiUrl;
  const call = (op, params, method = 'POST') =>
    api(method === 'GET' ? `${apiUrl}/b2api/v3/${op}?${new URLSearchParams(params)}` : `${apiUrl}/b2api/v3/${op}`, {
      method,
      headers: { authorization: auth.authorizationToken, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(params),
    });

  const list = await call('b2_list_buckets', { accountId: auth.accountId, bucketName: bucket }, 'GET');
  const b = list.buckets.find((x) => x.bucketName === bucket);
  if (!b) throw new Error(`Bucket "${bucket}" não encontrado para esta chave`);

  const ours = {
    corsRuleName: 'painel-web',
    allowedOrigins: origins,
    allowedOperations: ['s3_get', 's3_head', 's3_put', 's3_delete'],
    allowedHeaders: ['*'],
    exposeHeaders: ['ETag', 'x-amz-request-id', 'Content-Length'],
    maxAgeSeconds: 3600,
  };
  const rules = [...(b.corsRules || []).filter((r) => r.corsRuleName !== 'painel-web'), ours];
  await call('b2_update_bucket', { accountId: auth.accountId, bucketId: b.bucketId, corsRules: rules });
  console.log(`CORS atualizado em "${bucket}" para: ${origins.join(', ')}`);
})().catch((e) => {
  console.error(`Erro: ${e.message}`);
  process.exit(1);
});
