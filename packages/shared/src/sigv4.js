'use strict';

const crypto = require('node:crypto');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Codificação de URI do SigV4: tudo exceto A-Z a-z 0-9 - _ . ~ ; "/" preservada no caminho.
function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Região a partir de um endpoint do B2 (s3.us-east-005.backblazeb2.com -> us-east-005). */
function regionFromHost(host) {
  // aceita s3.<região>.backblazeb2.com e <bucket>.s3.<região>.backblazeb2.com (URL no estilo virtual-hosted)
  const m = /(?:^|\.)s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(host);
  return m ? m[1] : 'us-east-1';
}

/**
 * Assina uma requisição GET/HEAD (sem corpo) no padrão AWS SigV4 (S3).
 * Devolve os cabeçalhos a acrescentar (host é definido pelo próprio fetch).
 * Range e If-None-Match não precisam ser assinados.
 */
function signGet(url, { keyId, secretKey, region, method = 'GET', now = new Date() }) {
  const u = new URL(url);
  const reg = region || regionFromHost(u.host);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260101T000000Z
  const date = amzDate.slice(0, 8);

  const canonicalUri = u.pathname
    .split('/')
    .map((seg) => enc(decodeURIComponent(seg)))
    .join('/');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, EMPTY_SHA256].join('\n');

  const scope = `${date}/${reg}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const kDate = hmac(`AWS4${secretKey}`, date);
  const signingKey = hmac(hmac(hmac(kDate, reg), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': EMPTY_SHA256,
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Envolve um fetch para assinar toda requisição GET com a chave de leitura. */
function signedFetch(baseFetch, creds) {
  return (url, init = {}) => {
    const headers = { ...(init.headers || {}), ...signGet(String(url), creds) };
    return baseFetch(url, { ...init, headers });
  };
}

module.exports = { signGet, signedFetch, regionFromHost };
