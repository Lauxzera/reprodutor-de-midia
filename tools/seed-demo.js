'use strict';

// Monta um ambiente de demonstração 100% local (sem conta no B2):
//  .dev/panel-data  dados do painel (biblioteca + playlist de exemplo)
//  .dev/bucket      "bucket" simulado, já com a programação publicada
// Depois: npm run dev-server -- .dev/bucket 8080
// Uso: node tools/seed-demo.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store } = require('../packages/panel/src/main/store');
const { createFolderStorage } = require('../packages/panel/src/main/storage');
const { publishScreen } = require('../packages/panel/src/main/publish');

const root = path.resolve(__dirname, '..', '.dev');
const sampleDir = path.join(root, 'sample');
const panelDir = path.join(root, 'panel-data');
const bucketDir = path.join(root, 'bucket');

(async () => {
  execFileSync(process.execPath, [path.join(__dirname, 'make-sample-media.js'), sampleDir, '3'], { stdio: 'ignore' });

  const cipher = { encrypt: (s) => Buffer.from(s), decrypt: (b) => Buffer.from(b).toString() };
  const store = new Store(panelDir, cipher);
  store.saveSettings({ type: 'folder', folderPath: bucketDir, publicBaseUrl: 'http://localhost:8080' });

  const files = fs.readdirSync(sampleDir).filter((f) => /\.(png|mp4)$/.test(f)).map((f) => path.join(sampleDir, f));
  await store.addFiles(files);
  const library = store.listLibrary();

  const project = store.getProject();
  const screen = project.screens[0];
  screen.items = library.map((m, i) => ({
    id: `demo${i + 1}`,
    sha256: m.sha256,
    durationSec: library[i].type === 'image' ? 4 : undefined,
    schedule: i === 1 ? { days: [0, 1, 2, 3, 4, 5, 6].slice(0, 6), start: '00:00', end: '23:59' } : null,
  }));
  store.saveProject(project);

  const r = await publishScreen({ storage: createFolderStorage({ folderPath: bucketDir }), screen, library });
  screen.revision = r.manifest.revision;
  store.saveProject(project);
  console.log(`Demo pronta: revisão ${r.manifest.revision}, ${r.uploaded} mídia(s) em ${bucketDir}`);
})();
