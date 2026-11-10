'use strict';

// Processo filho dos testes de queda de energia: sincroniza uma vez e sai.
// Uso: node sync-child.js <dataDir> <baseUrl> <screenId>
const { SyncEngine } = require('../../src/main/sync');

const [dataDir, baseUrl, screenId] = process.argv.slice(2);
const engine = new SyncEngine({ dataDir, baseUrl, screenId });
engine.init();
engine.syncOnce().then((r) => {
  console.log('RESULT', JSON.stringify(r));
  process.exit(0);
});
