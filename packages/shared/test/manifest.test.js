'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, isItemActive, nextActiveItem } = require('../src');

const SHA = 'a'.repeat(64);
const base = () => ({
  schemaVersion: 1,
  screenId: 'loja',
  revision: 3,
  items: [{ id: 'a1', type: 'image', file: `media/${SHA}.jpg`, sha256: SHA, size: 10 }],
});

test('manifesto válido recebe valores padrão', () => {
  const r = validateManifest(base());
  assert.equal(r.ok, true);
  assert.equal(r.manifest.items[0].durationSec, 10);
  assert.deepEqual(r.manifest.settings, { fit: 'contain', transitionMs: 600, muted: true });
});

test('rejeita caminho fora de media/ e hash incoerente', () => {
  const m = base();
  m.items[0].file = '../segredo.jpg';
  assert.equal(validateManifest(m).ok, false);
  const n = base();
  n.items[0].file = `media/${'b'.repeat(64)}.jpg`;
  assert.equal(validateManifest(n).ok, false);
});

test('rejeita ids duplicados, versão errada e agenda inválida', () => {
  const m = base();
  m.items.push({ ...m.items[0] });
  assert.match(validateManifest(m).errors.join('|'), /duplicado/);
  assert.equal(validateManifest({ ...base(), schemaVersion: 2 }).ok, false);
  const s = base();
  s.items[0].schedule = { start: '25:00', end: '10:00' };
  assert.equal(validateManifest(s).ok, false);
  const t = base();
  t.items[0].schedule = { start: '09:00' };
  assert.equal(validateManifest(t).ok, false);
});

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);
// 2026-11-10 é terça (2)

test('sem agenda toca sempre', () => {
  assert.equal(isItemActive({}, at(2026, 11, 10, 3, 0)), true);
});

test('janela de horário e dias da semana', () => {
  const item = { schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } };
  assert.equal(isItemActive(item, at(2026, 11, 10, 9, 0)), true);
  assert.equal(isItemActive(item, at(2026, 11, 10, 17, 59)), true);
  assert.equal(isItemActive(item, at(2026, 11, 10, 18, 0)), false);
  assert.equal(isItemActive(item, at(2026, 11, 10, 8, 59)), false);
  assert.equal(isItemActive(item, at(2026, 11, 8, 12, 0)), false); // domingo
});

test('janela que cruza a meia-noite vale para o dia em que começou', () => {
  const item = { schedule: { days: [5], start: '22:00', end: '02:00' } }; // sexta
  assert.equal(isItemActive(item, at(2026, 11, 13, 23, 0)), true); // sexta 23h
  assert.equal(isItemActive(item, at(2026, 11, 14, 1, 0)), true); // sábado 1h (continuação)
  assert.equal(isItemActive(item, at(2026, 11, 14, 23, 0)), false); // sábado 23h
  assert.equal(isItemActive(item, at(2026, 11, 13, 12, 0)), false);
});

test('intervalo de datas é inclusivo', () => {
  const item = { schedule: { from: '2026-11-10', to: '2026-11-12' } };
  assert.equal(isItemActive(item, at(2026, 11, 9, 23, 59)), false);
  assert.equal(isItemActive(item, at(2026, 11, 10, 0, 0)), true);
  assert.equal(isItemActive(item, at(2026, 11, 12, 23, 59)), true);
  assert.equal(isItemActive(item, at(2026, 11, 13, 0, 0)), false);
});

test('nextActiveItem pula inativos, dá a volta e aceita item único', () => {
  const now = at(2026, 11, 10, 12, 0);
  const off = { schedule: { start: '20:00', end: '21:00' } };
  const items = [{ id: 'a' }, { id: 'b', ...off }, { id: 'c' }];
  assert.equal(nextActiveItem(items, null, now).id, 'a');
  assert.equal(nextActiveItem(items, 'a', now).id, 'c');
  assert.equal(nextActiveItem(items, 'c', now).id, 'a');
  assert.equal(nextActiveItem(items, 'removido', now).id, 'a');
  assert.equal(nextActiveItem([{ id: 'x' }], 'x', now).id, 'x');
  assert.equal(nextActiveItem([{ id: 'b', ...off }], null, now), null);
  assert.equal(nextActiveItem([], null, now), null);
});
