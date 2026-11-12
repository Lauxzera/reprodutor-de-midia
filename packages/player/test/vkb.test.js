'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/vkb.js'), 'utf8'), { window: win, document: {}, Event: class {} });
const { applyKey, LAYOUTS } = win.VKB;
const st = (value, start = value.length, end = start) => ({ value, start, end });
const plain = (o) => JSON.parse(JSON.stringify(o));
const key = (s, k) => plain(applyKey(s, k));

test('teclado: digita no cursor, substitui a seleção e apaga', () => {
  assert.deepEqual(key(st('ab'), 'c'), st('abc', 3));
  assert.deepEqual(key(st('abcd', 1, 3), 'X'), st('aXd', 2));
  assert.deepEqual(key(st('abc'), 'BACK'), st('ab', 2));
  assert.deepEqual(key(st('abcd', 1, 3), 'BACK'), st('ad', 1));
  assert.deepEqual(key(st('abc', 0), 'BACK'), st('abc', 0));
  assert.deepEqual(key(st('ab', 1), 'SPACE'), st('a b', 2));
});

test('teclado: setas movem o cursor e Limpar esvazia (colar texto longo também vale)', () => {
  assert.deepEqual(key(st('abc', 3), 'LEFT'), st('abc', 2));
  assert.deepEqual(key(st('abc', 0), 'LEFT'), st('abc', 0));
  assert.deepEqual(key(st('abc', 3), 'RIGHT'), st('abc', 3));
  assert.deepEqual(key(st('abc', 1, 3), 'RIGHT'), st('abc', 3));
  assert.deepEqual(key(st('abc', 1), 'CLEAR'), st('', 0));
  assert.deepEqual(key(st('ab', 2), 'RM1-xyz.0000'), st('abRM1-xyz.0000', 14));
});

test('teclado: dá para digitar URL do B2, keyID, applicationKey e ID da tela só com as teclas', () => {
  const keys = new Set(Object.values(LAYOUTS).flat(2));
  const need = 'https://s3.us-east-005.backblazeb2.com/loja-sinalizacao KAZ09+/_loja'.split('').filter((c) => c !== ' ');
  const letters = new Set(Object.values(LAYOUTS).flat(2).filter((k) => k.length === 1));
  for (const c of need) assert.ok(letters.has(c.toLowerCase()) || letters.has(c), `falta a tecla ${c}`);
  for (const special of ['SHIFT', 'BACK', 'SPACE', 'ENTER', 'SYM', 'ABC']) assert.ok(keys.has(special), special);
  assert.ok(LAYOUTS.num.flat().includes('0') && LAYOUTS.num.flat().includes('BACK'), 'teclado numérico');
});
