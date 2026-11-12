'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/vkb.js'), 'utf8'), { window: win, document: {}, Event: class {} });
const { applyKey, compose, charFor, ROWS, NUM_ROWS } = win.VKB;
const plain = (o) => JSON.parse(JSON.stringify(o));
const st = (value, start = value.length, end = start) => ({ value, start, end });
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

const rowKeys = (i) => plain(ROWS[i].filter((k) => Array.isArray(k)).map((k) => k[0]));

test('layout ABNT2: mesmas linhas de um teclado QWERTY brasileiro', () => {
  assert.deepEqual(rowKeys(0), ["'", '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=']);
  assert.deepEqual(rowKeys(1), ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'dead:acute', '[']);
  assert.deepEqual(rowKeys(2), ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ç', 'dead:tilde', ']']);
  assert.deepEqual(rowKeys(3), ['\\', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', ';', '/']);
  assert.ok(ROWS[2].includes('CAPS') && ROWS[2].includes('ENTER') && ROWS[0].includes('BACK'));
  assert.equal(ROWS[3].filter((k) => k === 'SHIFT').length, 2, 'dois Shift');
  assert.ok(NUM_ROWS.flat().includes('0'), 'teclado numérico para campos numéricos');
});

test('layout ABNT2: Shift dá os símbolos certos e Caps só maiúsculiza letras', () => {
  const def = (n) => ROWS.flat().find((k) => Array.isArray(k) && k[0] === n);
  const shifted = { 2: '@', 3: '#', 5: '%', 7: '&', 8: '*', 9: '(', 0: ')', '-': '_', '=': '+', ';': ':', '/': '?', ',': '<', '.': '>', '\\': '|', "'": '"', '[': '{', ']': '}' };
  for (const [k, s] of Object.entries(shifted)) assert.equal(charFor(def(String(k)), { shift: true }), s, `Shift+${k}`);
  assert.equal(charFor(def('q'), { shift: true }), 'Q');
  assert.equal(charFor(def('q'), { caps: true }), 'Q');
  assert.equal(charFor(def('q'), { caps: true, shift: true }), 'q', 'Caps + Shift = minúscula, como no teclado físico');
  assert.equal(charFor(def('ç'), { caps: true }), 'Ç');
  assert.equal(charFor(def('2'), { caps: true }), '2', 'Caps não muda número');
  assert.equal(charFor(def('dead:acute'), {}), 'dead:acute');
  assert.equal(charFor(def('dead:acute'), { shift: true }), 'dead:grave');
  assert.equal(charFor(def('dead:tilde'), { shift: true }), 'dead:circumflex');
  assert.equal(charFor(def('6'), { shift: true }), 'dead:diaeresis');
});

test('acentos: agudo, til, circunflexo, crase e trema combinam com a próxima letra', () => {
  assert.deepEqual(plain(compose('acute', 'a')), { text: 'á', dead: null });
  assert.deepEqual(plain(compose('acute', 'E')), { text: 'É', dead: null });
  assert.deepEqual(plain(compose('tilde', 'a')), { text: 'ã', dead: null });
  assert.deepEqual(plain(compose('tilde', 'o')), { text: 'õ', dead: null });
  assert.deepEqual(plain(compose('circumflex', 'e')), { text: 'ê', dead: null });
  assert.deepEqual(plain(compose('grave', 'a')), { text: 'à', dead: null });
  assert.deepEqual(plain(compose('diaeresis', 'u')), { text: 'ü', dead: null });
  assert.deepEqual(plain(compose('acute', 'c')), { text: 'ç', dead: null }, 'como no ABNT2: ´ + c = ç');
});

test('acentos: espaço, letra sem acento e dois acentos seguidos não perdem nada', () => {
  assert.deepEqual(plain(compose('acute', ' ')), { text: '´', dead: null });
  assert.deepEqual(plain(compose('tilde', 'k')), { text: '~k', dead: null });
  assert.deepEqual(plain(compose('acute', '3')), { text: '´3', dead: null });
  assert.deepEqual(plain(compose(null, 'dead:tilde')), { text: '', dead: 'tilde' }, 'acento espera a próxima tecla');
  assert.deepEqual(plain(compose('acute', 'dead:tilde')), { text: '´', dead: 'tilde' });
  assert.deepEqual(plain(compose(null, 'x')), { text: 'x', dead: null });
});

test('teclado: dá para digitar URL do B2, keyID, applicationKey e ID da tela só com as teclas', () => {
  const chars = new Set();
  for (const k of ROWS.flat().filter(Array.isArray)) for (const shift of [false, true]) for (const caps of [false, true]) chars.add(charFor(k, { shift, caps }));
  const need = 'https://s3.us-east-005.backblazeb2.com/loja-sinalizacao KAZ09+/_loja Ação pão você'.split('');
  for (const c of need) if (c !== ' ') assert.ok(chars.has(c) || ['ç', 'ã', 'ê', 'o', 'v', 'A', 'ã'].includes(c) || 'çãõáéíóúâê'.includes(c), `falta a tecla ${c}`);
  for (const c of 'https://s3.us-east-005.backblazeb2.com/loja-sinalizacao_KAZ09+') assert.ok(chars.has(c), `falta a tecla ${c}`);
});
