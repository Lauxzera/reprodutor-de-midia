'use strict';

// Empacota o código de um app (player ou painel) para o electron-builder:
//  - junta o processo principal (e o pacote shared, e o SDK do B2 no painel) em um único arquivo;
//  - copia preload e renderer.
// Executado dentro da pasta do pacote: node ../../tools/build-app.js
// Resultado em <pacote>/dist/ (main/index.js, main/preload.js, renderer/).

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

(async () => {
  const pkgDir = process.cwd();
  const dist = path.join(pkgDir, 'dist');
  const entry = path.join(pkgDir, 'src', 'main', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`Rode dentro de packages/player ou packages/panel (não achei ${entry})`);

  fs.rmSync(dist, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(dist, 'main', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    legalComments: 'none',
    logLevel: 'info',
  });
  fs.copyFileSync(path.join(pkgDir, 'src', 'main', 'preload.js'), path.join(dist, 'main', 'preload.js'));
  fs.cpSync(path.join(pkgDir, 'src', 'renderer'), path.join(dist, 'renderer'), { recursive: true });
  console.log(`Código empacotado em ${dist}`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
