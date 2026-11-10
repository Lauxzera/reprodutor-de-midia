'use strict';

// Limites do plano gratuito do Backblaze B2 que conhecemos. Podem mudar: confira no site do Backblaze.
const FREE = {
  storageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
  dailyTransactions: 2500, // leituras (classe B) por dia, somando todos os players e o painel
};
const WARN_AT = 0.8;

/** Quantas consultas ao manifesto um player faz por dia com esse intervalo. */
const readsPerDay = (pollSeconds) => Math.ceil(86400 / Math.max(1, Number(pollSeconds) || 60));

const levelOf = (ratio) => (ratio >= 1 ? 'over' : ratio >= WARN_AT ? 'warn' : 'ok');

function assessStorage(usedBytes, limit = FREE.storageBytes) {
  const ratio = limit ? usedBytes / limit : 0;
  return { used: usedBytes, limit, ratio, level: levelOf(ratio) };
}

function assessRequests(count, limit = FREE.dailyTransactions) {
  const ratio = limit ? count / limit : 0;
  return { used: count, limit, ratio, level: levelOf(ratio) };
}

/** A resposta do B2 indica que a cota diária (transações ou banda) acabou? */
function isCapError(status, bodyText = '') {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /cap exceeded|cap_exceeded|transaction|bandwidth|too many requests|slowdown/i.test(String(bodyText));
}

const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

module.exports = { FREE, WARN_AT, readsPerDay, levelOf, assessStorage, assessRequests, isCapError, fmtBytes };
