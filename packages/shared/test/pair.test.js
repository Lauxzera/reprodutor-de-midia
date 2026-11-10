'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodePair, decodePair, isPairCode, pairChecksum } = require('../src/pair');

const base = { endpoint: 'https://s3.us-east-005.backblazeb2.com', bucket: 'loja-sinalizacao', keyId: '005abc000000002', secretKey: 'K005segredo/com+simbolos==', pollSeconds: 120 };

test('código de pareamento: ida e volta (bucket privado)', () => {
  const code = encodePair(base);
  assert.match(code, /^RM1-[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
  assert.equal(isPairCode(` ${code}\n`), true);
  assert.deepEqual(decodePair(code), {
    baseUrl: 'https://s3.us-east-005.backblazeb2.com/loja-sinalizacao',
    keyId: '005abc000000002',
    secretKey: 'K005segredo/com+simbolos==',
    region: 'us-east-005',
    pollSeconds: 120,
  });
});

test('bucket público: sem chaves, URL no formato bucket.host', () => {
  const r = decodePair(encodePair({ endpoint: base.endpoint, bucket: 'meu-bucket', pollSeconds: 60 }));
  assert.equal(r.baseUrl, 'https://meu-bucket.s3.us-east-005.backblazeb2.com');
  assert.equal(r.keyId, '');
  assert.equal(r.pollSeconds, 60);
});

test('aceita quebras de linha coladas no meio do código', () => {
  const code = encodePair(base);
  const broken = `${code.slice(0, 20)}\r\n  ${code.slice(20, 50)}\n${code.slice(50)}`;
  assert.equal(decodePair(broken).keyId, base.keyId);
});

test('detecta texto cortado, adulterado e códigos que não são nossos', () => {
  const code = encodePair(base);
  assert.throws(() => decodePair(code.slice(0, -3)), /corrompido|cortado/);
  assert.throws(() => decodePair(code.replace('RM1-', 'RM1-A')), /corrompido|cortado/);
  assert.throws(() => decodePair('RM1-abcdef'), /incompleto/);
  assert.throws(() => decodePair('XYZ-123'), /inválido/);
  assert.throws(() => decodePair(''), /inválido/);
  assert.throws(() => encodePair({ ...base, endpoint: 'http://inseguro.com' }), /Endpoint inválido/);
});

test('verificação é Adler-32 (mesma conta feita no instalador PowerShell)', () => {
  assert.equal(pairChecksum('Wikipedia'), '11e60398'); // vetor clássico do Adler-32
});
