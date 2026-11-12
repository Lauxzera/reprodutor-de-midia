'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// judgeVideo é regra pura; o módulo carrega mediabunny, então só roda onde ele resolve.
let judgeVideo = null;
try {
  ({ judgeVideo } = require('../src/convert'));
} catch {
  /* sem mediabunny no ambiente de teste */
}

test('regra de vídeo pesado: acima de Full HD ou de 30 fps', { skip: !judgeVideo }, () => {
  assert.equal(judgeVideo(1920, 1080, 30).heavy, false);
  assert.equal(judgeVideo(1080, 1920, 29.97).heavy, false, 'vertical Full HD é normal');
  assert.equal(judgeVideo(3840, 2160, 30).heavy, true);
  assert.equal(judgeVideo(1920, 1080, 60).heavy, true);
  assert.match(judgeVideo(3840, 2160, 60).why, /3840x2160 e 60 fps/);
  assert.equal(judgeVideo(1280, 720, null).heavy, false, 'sem fps medido, julga só pela resolução');
});
