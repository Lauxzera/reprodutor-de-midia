'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = {
  baseUrl: '',
  screenId: '',
  pollSeconds: 60,
  autoStart: true,
};

/** Lê <dataDir>/config.json; cria um modelo na primeira execução. */
function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(TEMPLATE, null, 2));
    return { ...TEMPLATE, file, configured: false };
  }
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* config corrompido: trata como vazio */
  }
  const d = raw.display && typeof raw.display === 'object' ? raw.display : {};
  const cfg = {
    // Exibição local deste player: fit 'auto' segue a playlist; rotação em graus; volume de 0 a 100.
    display: {
      fit: ['auto', 'contain', 'cover', 'fill'].includes(d.fit) ? d.fit : 'auto',
      rotate: [0, 90, 180, 270].includes(Number(d.rotate)) ? Number(d.rotate) : 0,
      volume: Number.isFinite(Number(d.volume)) ? Math.min(100, Math.max(0, Math.round(Number(d.volume)))) : 100,
    },
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    screenId: typeof raw.screenId === 'string' ? raw.screenId.trim() : '',
    pollSeconds: Number.isFinite(raw.pollSeconds) ? raw.pollSeconds : 60,
    autoStart: raw.autoStart !== false,
    updates: raw.updates !== false, // verificar novas versões no GitHub ("updates": false desliga)
    // Opcional: bucket privado (chave somente de leitura).
    keyId: typeof raw.keyId === 'string' ? raw.keyId.trim() : '',
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '',
    region: typeof raw.region === 'string' ? raw.region.trim() : '',
    // Opcional: chave que só grava em status/ (relatório de versão e estado para o painel do admin).
    statusKeyId: typeof raw.statusKeyId === 'string' ? raw.statusKeyId.trim() : '',
    statusSecret: typeof raw.statusSecret === 'string' ? raw.statusSecret.trim() : '',
  };
  return { ...cfg, file, configured: Boolean(cfg.baseUrl && cfg.screenId) };
}

module.exports = { loadConfig };
