'use strict';

// Atualização pelo próprio app (Windows): consulta o último Release do GitHub, baixa o instalador,
// confere o SHA-256 publicado no mesmo Release e roda o instalador em modo silencioso depois que o app fecha.
// Só Node (usado pelos processos principais do Player e do Painel de mesa).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULT_REPO = 'Lauxzera/reprodutor-de-midia';
const PREFIX = { player: 'ReprodutorPlayer-Setup-', painel: 'ReprodutorPainel-Setup-' };

const { compareVersions } = require('./version');

/**
 * Consulta o último Release. Devolve { current, latest, newer, asset, sumsUrl, notes, releaseUrl }.
 * `newer` só é true se há versão maior E o instalador deste app está no Release.
 */
async function checkForUpdate({ app, current, repo = DEFAULT_REPO, fetch = globalThis.fetch }) {
  if (!PREFIX[app]) throw new Error(`app desconhecido: ${app}`);
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'user-agent': 'reprodutor-updater', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw new Error('nenhum Release publicado');
  if (!res.ok) throw new Error(`o GitHub respondeu HTTP ${res.status}`);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  const asset = (rel.assets || []).find((a) => a.name.startsWith(PREFIX[app]) && a.name.toLowerCase().endsWith('.exe'));
  const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
  return {
    current,
    latest,
    newer: Boolean(latest) && compareVersions(latest, current) > 0 && Boolean(asset),
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    sumsUrl: sums ? sums.browser_download_url : null,
    notes: rel.body || '',
    releaseUrl: rel.html_url || '',
  };
}

/** Baixa o instalador para uma pasta temporária e confere o SHA-256 publicado. Devolve o caminho do .exe. */
async function downloadUpdate({ info, fetch = globalThis.fetch, dir = os.tmpdir(), onProgress = () => {} }) {
  if (!info || !info.asset) throw new Error('nenhum instalador para baixar');
  if (!info.sumsUrl) throw new Error('o Release não traz SHA256SUMS.txt; não vou instalar sem conferir a integridade');

  const sumsRes = await fetch(info.sumsUrl, { signal: AbortSignal.timeout(20000) });
  if (!sumsRes.ok) throw new Error(`não consegui ler SHA256SUMS.txt (HTTP ${sumsRes.status})`);
  const line = (await sumsRes.text()).split(/\r?\n/).find((l) => l.includes(info.asset.name));
  const expected = line && line.trim().split(/\s+/)[0].toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('SHA256SUMS.txt não lista o instalador');

  const folder = fs.mkdtempSync(path.join(dir, 'reprodutor-update-'));
  const file = path.join(folder, path.basename(info.asset.name));
  const res = await fetch(info.asset.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok) throw new Error(`o download respondeu HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || info.asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress(total ? Math.min(1, got / total) : 0);
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    fs.rmSync(folder, { recursive: true, force: true });
    throw e;
  }
  if (hash.digest('hex') !== expected) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw new Error('o SHA-256 do download não confere com o publicado (arquivo corrompido ou adulterado); nada foi instalado');
  }
  return file;
}

// Auxiliar (JScript, executado pelo wscript): espera o app fechar, roda o instalador em silêncio, espera terminar e
// reabre o app se o instalador não o reabriu. wscript é um programa gráfico: roda sem console e continua vivo
// depois que o app fecha (com `detached`, o PowerShell sai sem executar nada: testado).
const HELPER = String.raw`var sh = new ActiveXObject("WScript.Shell");
var installer = WScript.Arguments(0), app = WScript.Arguments(1), proc = WScript.Arguments(2);
WScript.Sleep(1500);
sh.Run('"' + installer + '" /S --updated', 0, true);
WScript.Sleep(3000);
var wmi = GetObject("winmgmts:\\\\.\\root\\cimv2");
var running = wmi.ExecQuery("select Name from Win32_Process where Name='" + proc + "'").Count > 0;
if (!running) sh.Run('"' + app + '"', 1, false);
`.replace(/\n/g, '\r\n');

/**
 * Atualiza em segundo plano: o app chama isto e fecha logo depois. O auxiliar roda o instalador (/S), espera e
 * reabre o app (`appExe`). Sem `appExe`, só lança o instalador direto.
 */
function launchInstaller(installerPath, { appExe, spawnImpl = spawn, writeFile = fs.writeFileSync } = {}) {
  let cmd = installerPath;
  let args = ['/S'];
  if (appExe) {
    const helper = path.join(path.dirname(installerPath), 'reprodutor-update.js');
    writeFile(helper, HELPER);
    cmd = 'wscript.exe';
    args = ['//B', '//Nologo', helper, installerPath, appExe, path.basename(appExe)];
  }
  const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  if (child && child.unref) child.unref();
  return child;
}

module.exports = { DEFAULT_REPO, compareVersions, checkForUpdate, downloadUpdate, launchInstaller };
