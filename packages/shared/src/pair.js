'use strict';

// Código de pareamento: um único texto com tudo o que o Player precisa para falar com o bucket
// (endpoint, bucket, chave SOMENTE DE LEITURA, intervalo). A tela é escolhida no próprio Player.
// Formato: RM1-<json em base64url>.<verificação>   (a verificação pega erro de digitação ou texto cortado)
// Funciona no Node e no navegador (sem dependências).

const PREFIX = 'RM1-';

const toBytes = (s) => new TextEncoder().encode(s);
const b64 = (s) => {
  let bin = '';
  for (const b of toBytes(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** Adler-32 em 8 dígitos hex (simples de repetir no PowerShell do instalador). */
function checksum(text) {
  let a = 1;
  let b = 0;
  for (const byte of toBytes(text)) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (((b << 16) | a) >>> 0).toString(16).padStart(8, '0');
}

const regionOf = (endpoint) => (/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint) || [])[1] || '';

function encodePair({ endpoint, bucket, keyId, secretKey, pollSeconds, publicBaseUrl, statusKeyId, statusSecret }) {
  if (!/^https:\/\/[^\s/]+$/.test(endpoint || '')) throw new Error('Endpoint inválido para o código de pareamento');
  if (!bucket) throw new Error('Bucket não informado');
  const body = { v: 1, e: endpoint, b: bucket };
  if (keyId && secretKey) {
    body.k = keyId;
    body.s = secretKey;
  }
  if (publicBaseUrl) body.u = publicBaseUrl;
  // Opcional (a partir da 0.1.8): chave que só grava em status/, para o player relatar versão e estado. Players antigos ignoram.
  if (statusKeyId && statusSecret) {
    body.wk = statusKeyId;
    body.ws = statusSecret;
  }
  if (Number(pollSeconds) > 0) body.p = Math.round(Number(pollSeconds));
  const payload = b64(JSON.stringify(body));
  return `${PREFIX}${payload}.${checksum(payload)}`;
}

/**
 * Lê um código de pareamento. Devolve { baseUrl, keyId, secretKey, region, pollSeconds } ou lança um erro em português.
 * Aceita quebras de linha/espaços colados junto.
 */
function decodePair(code) {
  const text = String(code || '').replace(/\s+/g, '');
  if (!text.startsWith(PREFIX)) throw new Error('Código de pareamento inválido (deve começar com RM1-)');
  const dot = text.lastIndexOf('.');
  if (dot < 0) throw new Error('Código de pareamento incompleto (faltou o final); copie de novo');
  const payload = text.slice(PREFIX.length, dot);
  if (checksum(payload) !== text.slice(dot + 1).toLowerCase()) throw new Error('Código de pareamento corrompido ou cortado; copie de novo');
  let body;
  try {
    body = JSON.parse(unb64(payload));
  } catch {
    throw new Error('Código de pareamento ilegível');
  }
  if (!body || body.v !== 1 || typeof body.e !== 'string' || typeof body.b !== 'string') throw new Error('Versão de código de pareamento não suportada');
  const private_ = Boolean(body.k && body.s);
  const host = new URL(body.e).host;
  const baseUrl = body.u ? String(body.u).replace(/\/+$/, '') : private_ ? `https://${host}/${body.b}` : `https://${body.b}.${host}`;
  const out = {
    baseUrl,
    keyId: private_ ? body.k : '',
    secretKey: private_ ? body.s : '',
    region: regionOf(body.e),
    pollSeconds: Number.isFinite(body.p) && body.p >= 5 ? body.p : 120,
  };
  if (body.wk && body.ws) {
    out.statusKeyId = String(body.wk);
    out.statusSecret = String(body.ws);
  }
  return out;
}

const isPairCode = (text) => String(text || '').trim().startsWith(PREFIX);

module.exports = { PREFIX, encodePair, decodePair, isPairCode, pairChecksum: checksum };
