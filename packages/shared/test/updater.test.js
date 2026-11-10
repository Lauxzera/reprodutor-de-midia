'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { compareVersions, checkForUpdate, downloadUpdate, launchInstaller } = require('../src/updater');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('comparação de versões', () => {
  assert.ok(compareVersions('0.1.3', '0.1.2') > 0);
  assert.ok(compareVersions('v0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.equal(compareVersions('v0.1.2', '0.1.2'), 0);
  assert.ok(compareVersions('0.1.2', '0.1.3') < 0);
  assert.ok(compareVersions('1.0', '0.9.9') > 0);
});

const release = (tag, names) => ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: 'https://x/r', body: 'notas', assets: names.map((n) => ({ name: n, browser_download_url: `https://x/${n}`, size: 10 })) }) });

test('checkForUpdate: vê versão nova do instalador certo e ignora a versão igual ou anterior', async () => {
  const names = ['ReprodutorPlayer-Setup-0.1.3.exe', 'ReprodutorPainel-Setup-0.1.3.exe', 'SHA256SUMS.txt'];
  const nova = await checkForUpdate({ app: 'player', current: '0.1.2', fetch: async () => release('v0.1.3', names) });
  assert.equal(nova.newer, true);
  assert.equal(nova.latest, '0.1.3');
  assert.equal(nova.asset.name, 'ReprodutorPlayer-Setup-0.1.3.exe');
  assert.equal(nova.sumsUrl, 'https://x/SHA256SUMS.txt');
  const painel = await checkForUpdate({ app: 'painel', current: '0.1.2', fetch: async () => release('v0.1.3', names) });
  assert.equal(painel.asset.name, 'ReprodutorPainel-Setup-0.1.3.exe');

  assert.equal((await checkForUpdate({ app: 'player', current: '0.1.3', fetch: async () => release('v0.1.3', names) })).newer, false);
  assert.equal((await checkForUpdate({ app: 'player', current: '0.2.0', fetch: async () => release('v0.1.3', names) })).newer, false);
  // versão maior, mas sem o instalador deste app: não oferece
  assert.equal((await checkForUpdate({ app: 'player', current: '0.1.0', fetch: async () => release('v0.1.3', ['SHA256SUMS.txt']) })).newer, false);
});

test('checkForUpdate: erros claros (sem Release, GitHub fora)', async () => {
  await assert.rejects(() => checkForUpdate({ app: 'player', current: '1', fetch: async () => ({ ok: false, status: 404 }) }), /nenhum Release/);
  await assert.rejects(() => checkForUpdate({ app: 'player', current: '1', fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(() => checkForUpdate({ app: 'outro', current: '1' }), /desconhecido/);
});

function fakeDownload(buf, sumsText) {
  return async (url) => {
    if (url.endsWith('SHA256SUMS.txt')) return { ok: true, status: 200, text: async () => sumsText };
    return { ok: true, status: 200, headers: { get: () => String(buf.length) }, body: Readable.from([buf.subarray(0, 40), buf.subarray(40)]) };
  };
}
const info = { asset: { name: 'ReprodutorPlayer-Setup-0.1.3.exe', url: 'https://x/ReprodutorPlayer-Setup-0.1.3.exe', size: 100 }, sumsUrl: 'https://x/SHA256SUMS.txt' };

test('downloadUpdate: baixa, confere o hash e informa o progresso', async () => {
  const buf = crypto.randomBytes(200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-upd-'));
  const prog = [];
  const file = await downloadUpdate({ info, dir, fetch: fakeDownload(buf, `${sha(buf)}  ReprodutorPlayer-Setup-0.1.3.exe\n`), onProgress: (p) => prog.push(p) });
  assert.ok(fs.readFileSync(file).equals(buf));
  assert.equal(prog.at(-1), 1);
});

test('downloadUpdate: recusa hash diferente, SHA256SUMS ausente e arquivo não listado; não deixa lixo', async () => {
  const buf = crypto.randomBytes(200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-upd-'));
  await assert.rejects(() => downloadUpdate({ info, dir, fetch: fakeDownload(buf, `${sha(Buffer.from('outro'))}  ReprodutorPlayer-Setup-0.1.3.exe`) }), /não confere/);
  assert.deepEqual(fs.readdirSync(dir), [], 'removeu o download adulterado');
  await assert.rejects(() => downloadUpdate({ info: { ...info, sumsUrl: null }, dir, fetch: fakeDownload(buf, '') }), /SHA256SUMS/);
  await assert.rejects(() => downloadUpdate({ info, dir, fetch: fakeDownload(buf, `${sha(buf)}  OutroArquivo.exe`) }), /não lista/);
});

test('launchInstaller com appExe: usa o auxiliar wscript, que roda o instalador e reabre o app', () => {
  let seen;
  let script;
  launchInstaller('C:\\Users\\D&D\\Temp\\up\\Setup 0.1.3.exe', {
    appExe: 'C:\\Apps\\Reprodutor Player.exe',
    writeFile: (p, t) => (script = { p, t }),
    spawnImpl: (cmd, args, opts) => ((seen = { cmd, args, opts }), { unref() {} }),
  });
  assert.equal(seen.cmd, 'wscript.exe');
  assert.equal(seen.opts.detached, true);
  assert.deepEqual(seen.args.slice(0, 2), ['//B', '//Nologo']);
  assert.deepEqual(seen.args.slice(3), ['C:\\Users\\D&D\\Temp\\up\\Setup 0.1.3.exe', 'C:\\Apps\\Reprodutor Player.exe', 'Reprodutor Player.exe']);
  assert.equal(seen.args[2], script.p);
  assert.ok(script.t.includes('/S --updated') && script.t.includes('Win32_Process'));
  // no arquivo JScript o moniker fica com as barras dobradas: winmgmts:\\\\.\\root\\cimv2
  assert.ok(script.t.includes(String.raw`winmgmts:\\\\.\\root\\cimv2`), 'moniker WMI escapado para JScript');
});

test('launchInstaller: roda o instalador direto com /S, independente do app (sem PowerShell, sem shell)', () => {
  let seen;
  const child = launchInstaller('C:\Users\D&D\Temp\Setup 0.1.3.exe', { spawnImpl: (cmd, args, opts) => ((seen = { cmd, args, opts }), { unref() { seen.unref = true; } }) });
  assert.equal(seen.cmd, 'C:\Users\D&D\Temp\Setup 0.1.3.exe');
  assert.deepEqual(seen.args, ['/S']);
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.opts.stdio, 'ignore');
  assert.ok(!seen.opts.shell, 'sem shell: o & e os espaços do caminho não são interpretados');
  assert.ok(seen.unref && child);
});
