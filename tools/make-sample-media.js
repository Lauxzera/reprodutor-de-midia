'use strict';

// Gera imagens PNG de exemplo (gradientes) para testar o player sem mídia real.
// Uso: node tools/make-sample-media.js [pasta] [quantidade]

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

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const palettes = [
  [[230, 57, 70], [29, 53, 87]],
  [[42, 157, 143], [233, 196, 106]],
  [[106, 76, 147], [255, 202, 58]],
  [[25, 130, 196], [138, 201, 38]],
];

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '.dev', 'sample'));
const count = Number(process.argv[3] || 3);
fs.mkdirSync(out, { recursive: true });
for (let i = 0; i < count; i++) {
  const [a, b] = palettes[i % palettes.length];
  const file = path.join(out, `exemplo-${i + 1}.png`);
  const w = 1280;
  const h = 720;
  fs.writeFileSync(
    file,
    png(w, h, (x, y) => {
      const t = (x / w + y / h) / 2;
      const border = x < 24 || y < 24 || x >= w - 24 || y >= h - 24;
      if (border) return [255, 255, 255];
      return a.map((c, k) => Math.round(c + (b[k] - c) * t));
    }),
  );
  console.log(file);
}
