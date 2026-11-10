'use strict';

// Cliente S3 mínimo para o navegador (WebCrypto + fetch/XHR), compatível com o B2.
// Funciona também no Node 20+ (testes): lá usa fetch no lugar de XMLHttpRequest.

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (data) => hex(await subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, enc.encode(data)));
}
const uriEnc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map((seg) => uriEnc(decodeURIComponent(seg))).join('/');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

function regionFromEndpoint(endpoint) {
  const m = /^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint || '');
  return m ? m[1] : 'us-east-1';
}

async function signingKey(secret, date, region) {
  return hmac(await hmac(await hmac(await hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
}

const stamp = (now) => now.toISOString().replace(/[:-]|\.\d{3}/g, '');

/** Assina com o cabeçalho Authorization. Devolve os cabeçalhos x-amz-* e authorization a enviar. */
async function signHeaders({ method, url, keyId, secretKey, region, payloadHash = EMPTY_SHA256, now = new Date() }) {
  const u = new URL(url);
  const amzDate = stamp(now);
  const date = amzDate.slice(0, 8);
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEnc(k), uriEnc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [method, encPath(u.pathname), query, `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`, signed, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  const sig = hex(await hmac(await signingKey(secretKey, date, region), toSign));
  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
  };
}

/** URL pré-assinada de leitura (serve para <img>/<video> sem CORS e sem cabeçalhos). */
async function presignGet({ url, keyId, secretKey, region, expires = 3600, now = new Date() }) {
  const u = new URL(url);
  const amzDate = stamp(now);
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${keyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const query = params.map(([k, v]) => [uriEnc(k), uriEnc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = ['GET', encPath(u.pathname), query, `host:${u.host}\n`, 'host', UNSIGNED].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  const sig = hex(await hmac(await signingKey(secretKey, date, region), toSign));
  return `${u.origin}${u.pathname}?${query}&X-Amz-Signature=${sig}`;
}

function xmlText(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function createS3({ endpoint, region, bucket, keyId, appKey, fetchImpl }) {
  if (!endpoint || !bucket) throw new Error('Informe endpoint e bucket do B2');
  if (!keyId || !appKey) throw new Error('Credenciais do B2 não configuradas');
  const base = endpoint.replace(/\/+$/, '');
  const reg = region || regionFromEndpoint(endpoint);
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  const urlFor = (key) => `${base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const creds = { keyId, secretKey: appKey, region: reg };

  async function request(method, url, { headers = {}, body, payloadHash } = {}) {
    const signed = await signHeaders({ method, url, payloadHash, ...creds });
    return f(url, { method, headers: { ...headers, ...signed }, body });
  }

  function putXhr(url, headers, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => onProgress && e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`B2 respondeu HTTP ${xhr.status}: ${String(xhr.responseText).slice(0, 200)}`)));
      xhr.onerror = () => reject(new Error('Falha de rede ao enviar (confira a regra de CORS do bucket e a conexão)'));
      xhr.send(blob);
    });
  }

  async function put(key, body, { contentType, cacheControl, onProgress } = {}) {
    const url = urlFor(key);
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    if (cacheControl) headers['cache-control'] = cacheControl;
    const signed = await signHeaders({ method: 'PUT', url, payloadHash: UNSIGNED, ...creds });
    if (typeof XMLHttpRequest !== 'undefined' && onProgress) {
      return putXhr(url, { ...headers, ...signed }, body, onProgress);
    }
    const r = await f(url, { method: 'PUT', headers: { ...headers, ...signed }, body });
    if (!r.ok) throw new Error(`B2 respondeu HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    if (onProgress) onProgress(1);
  }

  return {
    kind: 'b2-web',
    region: reg,
    async exists(key) {
      const r = await request('HEAD', urlFor(key));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`B2 respondeu HTTP ${r.status} ao consultar ${key}`);
      return Number(r.headers.get('content-length') || 0);
    },
    // file pode ser um File/Blob (navegador) ou Uint8Array/string.
    async putFile(key, file, opts = {}) {
      if (!file || (typeof file === 'string')) throw new Error('Arquivo local indisponível: adicione-o à biblioteca de novo');
      await put(key, file, opts);
    },
    async putJson(key, obj, { cacheControl = 'no-cache' } = {}) {
      await put(key, JSON.stringify(obj, null, 2), { contentType: 'application/json', cacheControl });
    },
    async getJson(key) {
      const r = await request('GET', urlFor(key), { headers: { 'cache-control': 'no-cache' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`B2 respondeu HTTP ${r.status} ao ler ${key}`);
      return JSON.parse(await r.text());
    },
    async delete(key) {
      const r = await request('DELETE', urlFor(key));
      if (!r.ok && r.status !== 404) throw new Error(`B2 respondeu HTTP ${r.status} ao apagar ${key}`);
    },
    /** Lista chaves com o prefixo (ListObjectsV2), com paginação. */
    async list(prefix) {
      const out = [];
      let token = '';
      do {
        const q = `list-type=2&prefix=${uriEnc(prefix)}${token ? `&continuation-token=${uriEnc(token)}` : ''}`;
        const r = await request('GET', `${base}/${bucket}?${q}`);
        if (!r.ok) throw new Error(`B2 respondeu HTTP ${r.status} ao listar ${prefix}`);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
          const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
          if (key) out.push({ key: xmlText(key[1]), size: size ? Number(size[1]) : 0 });
        }
        const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
        token = next ? xmlText(next[1]) : '';
      } while (token);
      return out;
    },
    presign(key, expires = 3600) {
      return presignGet({ url: urlFor(key), expires, ...creds });
    },
  };
}

module.exports = { createS3, signHeaders, presignGet, regionFromEndpoint, EMPTY_SHA256, UNSIGNED };
