'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listScreens } = require('../src/main/screens');

const XML = `<?xml version="1.0"?><ListBucketResult><Contents><Key>screens/loja.json</Key><Size>10</Size></Contents>
<Contents><Key>screens/vitrine-2.json</Key><Size>10</Size></Contents><Contents><Key>screens/Maiuscula.json</Key></Contents>
<Contents><Key>screens/pasta/x.json</Key></Contents></ListBucketResult>`;

const base = { baseUrl: 'https://s3.us-east-005.backblazeb2.com/loja-sinalizacao', keyId: 'K', secretKey: 'S', region: 'us-east-005' };

test('lista as telas do bucket (assinando o pedido) e ignora nomes inválidos', async () => {
  let seen;
  const fetch = async (url, init) => ((seen = { url, init }), { ok: true, status: 200, text: async () => XML });
  assert.deepEqual(await listScreens({ ...base, fetch }), ['loja', 'vitrine-2']);
  assert.match(seen.url, /\/loja-sinalizacao\?list-type=2&prefix=screens%2F$/);
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=K\//);
});

test('erros claros: sem chave, sem permissão, falha do bucket', async () => {
  await assert.rejects(() => listScreens({ ...base, keyId: '', fetch: async () => ({}) }), /chave de leitura/);
  await assert.rejects(() => listScreens({ ...base, fetch: async () => ({ ok: false, status: 403 }) }), /permissão para listar/);
  await assert.rejects(() => listScreens({ ...base, fetch: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
});
