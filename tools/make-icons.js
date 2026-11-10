'use strict';

// Gera os ícones (PNG 512x512 com transparência) dos dois apps em packages/*/build/icon.png.
// O electron-builder converte para .ico. Troque os arquivos por um ícone seu quando quiser.
// Uso: node tools/make-icons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function pngRGBA(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SIZE = 512;
const RADIUS = 110;

// cobertura (0..1) de um quadrado arredondado, com suavização de 1 px
function roundedCoverage(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - 1 - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), SIZE - 1 - RADIUS);
  const d = Math.hypot(x - cx, y - cy);
  return Math.min(1, Math.max(0, RADIUS - d + 0.5));
}

// dentro do triângulo de "play" (centrado levemente à direita)
function inPlay(x, y) {
  const x0 = 190;
  const x1 = 380;
  const cy = 256;
  const half = 105;
  if (x < x0 || x > x1) return false;
  const t = (x - x0) / (x1 - x0);
  return Math.abs(y - cy) <= half * (1 - t);
}

function makeIcon(file, top, bottom, withBar) {
  const buf = pngRGBA(SIZE, (x, y) => {
    const cover = roundedCoverage(x, y);
    if (cover <= 0) return [0, 0, 0, 0];
    const t = y / SIZE;
    let c = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
    const bar = withBar && y > 400 && y < 430 && x > 120 && x < 392;
    const fill = withBar && y > 400 && y < 430 && x > 120 && x < 120 + 272 * 0.62;
    if (inPlay(x, y) || fill) c = [255, 255, 255];
    else if (bar) c = [255, 255, 255].map((v, i) => Math.round(v * 0.35 + c[i] * 0.65));
    return [...c, Math.round(255 * cover)];
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(file);
}

const root = path.resolve(__dirname, '..', 'packages');
makeIcon(path.join(root, 'player', 'build', 'icon.png'), [76, 141, 255], [37, 80, 170], false); // azul, "play"
makeIcon(path.join(root, 'panel', 'build', 'icon.png'), [62, 207, 142], [24, 120, 84], true); // verde, "play" + barra
