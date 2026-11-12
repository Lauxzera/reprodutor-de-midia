'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canClose } = require('../src/main/closepolicy');

test('fechar a janela: bloqueado em tela cheia, liberado em janela comum, minimizado, encerrando e no modo dev', () => {
  assert.equal(canClose({ winMode: 'full' }), false, 'tela cheia da TV: Alt+F4 não fecha');
  assert.equal(canClose({ winMode: 'window' }), true, 'janela comum: o X fecha');
  assert.equal(canClose({ winMode: 'full', minimized: true }), true, 'minimizado: fecha pela barra de tarefas');
  assert.equal(canClose({ winMode: 'full', quitting: true }), true, 'encerramento pedido pela manutenção');
  assert.equal(canClose({ winMode: 'full', windowed: true }), true, 'modo de teste em janela');
  assert.equal(canClose(), false);
});
