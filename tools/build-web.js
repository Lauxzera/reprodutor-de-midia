'use strict';

// Gera o painel web estático em docs/painel/ (publicado pelo GitHub Pages).
//   node tools/build-web.js
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs', 'painel');
fs.mkdirSync(out, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, 'packages/web/src/boot.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  outfile: path.join(out, 'app.js'),
  // No navegador só entram o schema e as regras do manifesto (sem as partes que usam o Node).
  alias: { '@reprodutor/shared': path.join(root, 'packages/shared/src/manifest.js') },
  logLevel: 'warning',
});

fs.copyFileSync(path.join(root, 'packages/panel/src/renderer/panel.css'), path.join(out, 'panel.css'));
fs.copyFileSync(path.join(root, 'packages/panel/src/renderer/panel.js'), path.join(out, 'panel.js'));
fs.copyFileSync(path.join(root, 'packages/web/src/index.template.html'), path.join(out, 'index.html'));
fs.writeFileSync(path.join(root, 'docs', '.nojekyll'), '');
console.log(`Painel web gerado em ${path.relative(root, out)}`);
