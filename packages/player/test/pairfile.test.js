'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodePair } = require('@reprodutor/shared');
const { findPairFile, writePairConfig, candidateFiles } = require('../src/main/pairfile');

const code = encodePair({ endpoint: 'https://s3.us-east-005.backblazeb2.com', bucket: 'loja', keyId: 'K1', secretKey: 'S1', pollSeconds: 30 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rm-pf-'));

test('pair.txt: acha na pasta de dados (com quebras de linha e BOM) e ignora lixo', () => {
  const dataDir = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Downloads'));
  fs.writeFileSync(path.join(home, 'Downloads', 'pair.txt'), 'isto nao e codigo');
  assert.equal(findPairFile({ dataDir, home, drives: false }), null);
  fs.writeFileSync(path.join(dataDir, 'pair.txt'), `\uFEFF${code.slice(0, 30)}\r\n${code.slice(30)}\r\n`);
  const r = findPairFile({ dataDir, home, drives: false });
  assert.equal(r.file, path.join(dataDir, 'pair.txt'));
  assert.equal(r.pair.keyId, 'K1');
  assert.equal(r.pair.pollSeconds, 30);
});

test('pair.txt: código cortado (checksum) é recusado e a busca segue para o próximo', () => {
  const dataDir = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Downloads'));
  fs.writeFileSync(path.join(dataDir, 'pair.txt'), code.slice(0, -3));
  fs.writeFileSync(path.join(home, 'Downloads', 'pair.txt'), code);
  const r = findPairFile({ dataDir, home, drives: false });
  assert.equal(r.file, path.join(home, 'Downloads', 'pair.txt'));
});

test('pair.txt: procura também nas raízes de D: a Z: no Windows', () => {
  const l = candidateFiles({ dataDir: 'x', home: 'h', platform: 'win32' });
  assert.ok(l.includes('D:\\pair.txt') && l.includes('Z:\\pair.txt') && !l.includes('C:\\pair.txt'));
  assert.ok(!candidateFiles({ dataDir: 'x', home: 'h', platform: 'linux' }).some((p) => /^[A-Z]:/.test(p)));
});

test('writePairConfig: grava as credenciais, mantém o resto e não inventa tela', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ baseUrl: '', screenId: '', autoStart: true, display: { fit: 'cover', rotate: 0, volume: 50 } }));
  const { findPairFile: f } = require('../src/main/pairfile');
  fs.writeFileSync(path.join(dir, 'pair.txt'), code);
  const { pair } = f({ dataDir: dir, home: tmp(), drives: false });
  const next = writePairConfig(file, pair);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.baseUrl, 'https://s3.us-east-005.backblazeb2.com/loja');
  assert.equal(saved.keyId, 'K1');
  assert.equal(saved.secretKey, 'S1');
  assert.equal(saved.region, 'us-east-005');
  assert.equal(saved.screenId, '');
  assert.equal(saved.display.volume, 50);
  assert.deepEqual(next, saved);
});
