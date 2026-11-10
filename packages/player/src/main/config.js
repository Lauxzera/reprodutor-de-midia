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
  const cfg = {
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    screenId: typeof raw.screenId === 'string' ? raw.screenId.trim() : '',
    pollSeconds: Number.isFinite(raw.pollSeconds) ? raw.pollSeconds : 60,
    autoStart: raw.autoStart !== false,
    updates: raw.updates !== false, // verificar novas versões no GitHub ("updates": false desliga)
    // Opcional: bucket privado (chave somente de leitura).
    keyId: typeof raw.keyId === 'string' ? raw.keyId.trim() : '',
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '',
    region: typeof raw.region === 'string' ? raw.region.trim() : '',
  };
  return { ...cfg, file, configured: Boolean(cfg.baseUrl && cfg.screenId) };
}

module.exports = { loadConfig };
