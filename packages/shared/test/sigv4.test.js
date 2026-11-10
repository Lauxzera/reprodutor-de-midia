'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signGet, signedFetch, regionFromHost } = require('../src/sigv4');

const creds = { keyId: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z') };

test('região deduzida do endpoint do B2', () => {
  assert.equal(regionFromHost('s3.us-east-005.backblazeb2.com'), 'us-east-005');
  assert.equal(regionFromHost('exemplo.com'), 'us-east-1');
});

test('assinatura tem o formato SigV4 e é determinística', () => {
  const h = signGet('https://s3.us-east-005.backblazeb2.com/bucket/screens/loja.json', creds);
  assert.equal(h['x-amz-date'], '20130524T000000Z');
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-005\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(h.authorization, signGet('https://s3.us-east-005.backblazeb2.com/bucket/screens/loja.json', creds).authorization);
  assert.notEqual(h.authorization, signGet('https://s3.us-east-005.backblazeb2.com/bucket/screens/outra.json', creds).authorization);
});

test('signedFetch preserva cabeçalhos do chamador (Range, If-None-Match) e acrescenta a assinatura', async () => {
  let seen;
  const f = signedFetch(async (url, init) => ((seen = { url, init }), { ok: true }), creds);
  await f('https://s3.us-east-005.backblazeb2.com/b/x.bin', { headers: { range: 'bytes=5-' } });
  assert.equal(seen.init.headers.range, 'bytes=5-');
  assert.ok(seen.init.headers.authorization.startsWith('AWS4-HMAC-SHA256'));
});
