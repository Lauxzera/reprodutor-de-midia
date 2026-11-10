'use strict';

const { signedFetch, SLUG_RE } = require('@reprodutor/shared');

/**
 * Lista as telas publicadas no bucket (screens/<id>.json), para o Player escolher numa lista
 * em vez de digitar o ID. Requer a chave de leitura (listagem não é pública no B2).
 * @returns {Promise<string[]>} IDs das telas, em ordem alfabética
 */
async function listScreens({ baseUrl, keyId, secretKey, region, fetch = globalThis.fetch }) {
  if (!baseUrl) throw new Error('Informe a URL do bucket');
  if (!keyId || !secretKey) throw new Error('Listar as telas exige a chave de leitura (bucket privado)');
  const f = signedFetch(fetch, { keyId, secretKey, region });
  const res = await f(`${String(baseUrl).replace(/\/+$/, '')}?list-type=2&prefix=${encodeURIComponent('screens/')}`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 403) throw new Error('A chave não tem permissão para listar o bucket (confira a chave de leitura e o bucket)');
  if (!res.ok) throw new Error(`O bucket respondeu HTTP ${res.status} ao listar as telas`);
  const xml = await res.text();
  const ids = [];
  for (const m of xml.matchAll(/<Key>screens\/([^<]+)\.json<\/Key>/g)) if (SLUG_RE.test(m[1])) ids.push(m[1]);
  return [...new Set(ids)].sort();
}

module.exports = { listScreens };
