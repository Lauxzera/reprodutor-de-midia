'use strict';

// Relatório de status das telas: cada player grava status/<tela>.json (versão, estado, o que toca)
// e o painel lê. Só acrescenta objetos ao bucket: players de versões antigas simplesmente não relatam
// e continuam funcionando (o painel os mostra como "sem relatório").

const { compareVersions } = require('./version');

const DEFAULT_REPO = 'Lauxzera/reprodutor-de-midia';

const STATUS_PREFIX = 'status/';
const STATUS_SCHEMA = 1;
const REPORT_EVERY_SEC = 120; // intervalo do relatório do player
const ONLINE_MAX_SEC = 5 * 60; // relatou há menos disso: online
const LATE_MAX_SEC = 30 * 60; // até aqui: "sem sinal recente"; depois, offline

const statusKey = (screenId) => `${STATUS_PREFIX}${screenId}.json`;

/** Monta o relatório que o player envia. */
function buildStatus({ screenId, version, platform, state, message, lastSyncAt, revision, itemCount, playableCount, playing, startedAt, now = new Date() }) {
  return {
    schemaVersion: STATUS_SCHEMA,
    screenId,
    version: String(version || ''),
    platform: String(platform || ''),
    state: String(state || 'idle'),
    message: String(message || '').slice(0, 200),
    lastSyncAt: lastSyncAt || null,
    revision: Number.isInteger(revision) ? revision : null,
    itemCount: itemCount || 0,
    playableCount: playableCount || 0,
    playing: playing ? String(playing).slice(0, 200) : '',
    startedAt: startedAt || null,
    reportedAt: now.toISOString(),
  };
}

/**
 * Interpreta um relatório (ou a falta dele).
 * presence: online | late | offline | none (nunca relatou: player antigo ou sem chave de status)
 * versionState: latest | old | unknown
 */
function evaluateStatus(report, { now = new Date(), latestVersion = '' } = {}) {
  if (!report || typeof report !== 'object' || !report.reportedAt) return { presence: 'none', ageSec: null, version: '', versionState: 'unknown' };
  const at = Date.parse(report.reportedAt);
  const ageSec = Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 1000)) : null;
  const presence = ageSec === null ? 'none' : ageSec <= ONLINE_MAX_SEC ? 'online' : ageSec <= LATE_MAX_SEC ? 'late' : 'offline';
  const version = typeof report.version === 'string' ? report.version : '';
  let versionState = 'unknown';
  if (version && latestVersion) versionState = compareVersions(latestVersion, version) > 0 ? 'old' : 'latest';
  return { presence, ageSec, version, versionState };
}

/** Última versão publicada no GitHub ('' se não der para consultar). */
async function fetchLatestVersion({ fetch = globalThis.fetch, repo = DEFAULT_REPO } = {}) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) return '';
    const j = await res.json();
    return String(j.tag_name || '').replace(/^v/, '');
  } catch {
    return '';
  }
}

/**
 * Junta as telas do projeto com os relatórios do bucket.
 * @param {object} o.storage  precisa de list(prefix) e getJson(key)
 * @param {object} o.project  { screens: [{ id, name, revision }] }
 */
async function collectMonitor({ storage, project, latestVersion = '', now = new Date() }) {
  const reports = new Map();
  let listError = '';
  try {
    const objs = await storage.list(STATUS_PREFIX);
    await Promise.all(
      objs.map(async (o) => {
        const m = /^status\/([a-z0-9][a-z0-9_-]{0,62})\.json$/.exec(o.key);
        if (!m) return;
        try {
          reports.set(m[1], await storage.getJson(o.key));
        } catch {
          /* relatório ilegível: trata como ausente */
        }
      }),
    );
  } catch (e) {
    listError = e.message;
  }
  const known = new Set();
  const rows = [];
  for (const s of (project && project.screens) || []) {
    known.add(s.id);
    rows.push({ id: s.id, name: s.name || s.id, published: s.revision || 0, registered: true, report: reports.get(s.id) || null, ...evaluateStatus(reports.get(s.id), { now, latestVersion }) });
  }
  for (const [id, report] of reports) {
    if (!known.has(id)) rows.push({ id, name: id, published: null, registered: false, report, ...evaluateStatus(report, { now, latestVersion }) });
  }
  return { rows, latestVersion, listError, at: now.toISOString() };
}

module.exports = { STATUS_PREFIX, STATUS_SCHEMA, REPORT_EVERY_SEC, ONLINE_MAX_SEC, LATE_MAX_SEC, statusKey, buildStatus, evaluateStatus, fetchLatestVersion, collectMonitor };
