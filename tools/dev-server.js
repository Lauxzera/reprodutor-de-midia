'use strict';

// Servidor estático de desenvolvimento: faz o papel do bucket público (B2) a partir de uma pasta.
// Suporta ETag (304) e Range (retomada de download), como o B2.
// Uso: node tools/dev-server.js [pasta] [porta]

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * @param {string} root pasta servida
 * @param {object} [opts]
 * @param {{chunk:number, every:number}} [opts.slow] devolve `chunk` bytes a cada `every` ms (simula link lento)
 * @param {(req) => void} [opts.onRequest] observa cada requisição (testes)
 * @param {(req) => number|null} [opts.forceStatus] devolve um status HTTP para forçar falhas (testes)
 */
function createServer(root, opts = {}) {
  const base = path.resolve(root);
  return http.createServer((req, res) => {
    if (opts.onRequest) opts.onRequest(req);
    const forced = opts.forceStatus && opts.forceStatus(req);
    if (forced) {
      res.writeHead(forced).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(base, '.' + rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      let start = 0;
      let end = st.size - 1;
      let status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        if (range[1] !== '') start = Number(range[1]);
        if (range[2] !== '') end = Math.min(Number(range[2]), st.size - 1);
        if (start >= st.size || start > end) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }).end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, { start, end, highWaterMark: opts.slow ? opts.slow.chunk : 65536 });
      if (!opts.slow) return void stream.pipe(res);
      stream.on('data', (chunk) => {
        if (res.write(chunk)) {
          stream.pause();
          setTimeout(() => stream.resume(), opts.slow.every);
        } else {
          stream.pause();
          res.once('drain', () => setTimeout(() => stream.resume(), opts.slow.every));
        }
      });
      stream.on('end', () => res.end());
      res.on('close', () => stream.destroy());
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, '..', '.dev', 'bucket');
  const port = Number(process.argv[3] || 8080);
  fs.mkdirSync(root, { recursive: true });
  createServer(root).listen(port, () => {
    console.log(`Servindo ${path.resolve(root)} em http://localhost:${port}`);
  });
}
