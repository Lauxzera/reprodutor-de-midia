'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Interface de armazenamento usada pela publicação:
 *   exists(key)            -> tamanho em bytes ou null
 *   putFile(key, file, {contentType, cacheControl, onProgress})
 *   putJson(key, obj, {cacheControl})
 *   delete(key)
 * Implementações: B2 (API S3) e pasta local (para testes sem conta).
 */

function createFolderStorage({ folderPath }) {
  if (!folderPath) throw new Error('Informe a pasta de destino');
  const root = path.resolve(folderPath);
  const resolve = (key) => {
    const full = path.resolve(root, ...key.split('/'));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Chave inválida: ${key}`);
    return full;
  };
  return {
    kind: 'folder',
    async exists(key) {
      try {
        const st = await fsp.stat(resolve(key));
        return st.isFile() ? st.size : null;
      } catch {
        return null;
      }
    },
    async putFile(key, file, { onProgress } = {}) {
      const dest = resolve(key);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      await fsp.copyFile(file, tmp);
      await fsp.rename(tmp, dest);
      if (onProgress) onProgress(1);
    },
    async putJson(key, obj) {
      const dest = resolve(key);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
      await fsp.rename(tmp, dest);
    },
    async delete(key) {
      await fsp.rm(resolve(key), { force: true });
    },
    async getJson(key) {
      try {
        return JSON.parse(await fsp.readFile(resolve(key), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    async list(prefix) {
      const base = prefix.replace(/\/+$/, '');
      const dir = resolve(base || '.');
      try {
        return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => ({ key: `${base}/${d.name}`, size: 0 }));
      } catch {
        return [];
      }
    },
  };
}

function createB2Storage({ endpoint, region, bucket, keyId, appKey }) {
  if (!endpoint || !bucket) throw new Error('Informe endpoint e bucket do B2');
  if (!keyId || !appKey) throw new Error('Credenciais do B2 não configuradas');
  // Carregado sob demanda: o SDK é pesado e só é necessário no modo B2.
  const { S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const { Upload } = require('@aws-sdk/lib-storage');

  const client = new S3Client({
    endpoint,
    region: region || 'us-west-004',
    credentials: { accessKeyId: keyId, secretAccessKey: appKey },
    forcePathStyle: true,
    // O B2 não aceita os checksums extras que o SDK novo envia por padrão.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    kind: 'b2',
    async exists(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return r.ContentLength ?? 0;
      } catch (e) {
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async putFile(key, file, { contentType, cacheControl, onProgress } = {}) {
      const size = (await fsp.stat(file)).size;
      const upload = new Upload({
        client,
        queueSize: 3,
        partSize: 16 * 1024 * 1024,
        params: {
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(file),
          ContentType: contentType,
          CacheControl: cacheControl,
        },
      });
      if (onProgress) upload.on('httpUploadProgress', (p) => onProgress(size ? Math.min(1, (p.loaded || 0) / size) : 1));
      await upload.done();
    },
    async putJson(key, obj, { cacheControl = 'no-cache' } = {}) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(obj, null, 2),
          ContentType: 'application/json',
          CacheControl: cacheControl,
        }),
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async getJson(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return JSON.parse(await r.Body.transformToString());
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async list(prefix) {
      const out = [];
      let token;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size || 0 });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}

function createStorage(settings, keys) {
  if (settings.type === 'folder') return createFolderStorage(settings);
  return createB2Storage({ ...settings, ...(keys || {}) });
}

/** URL pública do bucket, usada pelo player (baseUrl). */
function publicBaseUrl(settings) {
  if (settings.publicBaseUrl) return settings.publicBaseUrl.replace(/\/+$/, '');
  if (settings.type === 'b2' && settings.endpoint && settings.bucket) {
    try {
      if (settings.privateBucket) return `https://${new URL(settings.endpoint).host}/${settings.bucket}`;
      return `https://${settings.bucket}.${new URL(settings.endpoint).host}`;
    } catch {
      return '';
    }
  }
  return '';
}

module.exports = { createStorage, createFolderStorage, createB2Storage, publicBaseUrl };
