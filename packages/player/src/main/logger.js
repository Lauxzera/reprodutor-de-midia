'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;

/** Log simples em arquivo (<dataDir>/player.log), com rotação ao passar de 1 MB. */
function createLogger(dataDir) {
  const file = path.join(dataDir, 'player.log');
  return function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* arquivo ainda não existe */
      }
      fs.appendFileSync(file, line);
    } catch {
      /* log nunca pode derrubar o player */
    }
    if (process.env.PLAYER_DEBUG) process.stdout.write(line);
  };
}

/** Últimas `lines` linhas do log (lê só o fim do arquivo). */
function readLogTail(dataDir, lines = 40) {
  const file = path.join(dataDir, 'player.log');
  try {
    const { size } = fs.statSync(file);
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    const all = buf.toString('utf8').split('\n').filter(Boolean);
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

module.exports = { createLogger, readLogTail };
