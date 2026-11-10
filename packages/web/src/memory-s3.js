'use strict';

// Bucket em memória (modo demonstração e testes): mesma interface do createS3.

function createMemoryS3() {
  const objects = new Map(); // key -> { body: Blob|string, size }
  const sizeOf = (b) => (typeof b === 'string' ? new TextEncoder().encode(b).length : b.size);
  return {
    kind: 'memory',
    objects,
    async exists(key) {
      return objects.has(key) ? objects.get(key).size : null;
    },
    async putFile(key, file, { onProgress } = {}) {
      if (!file || typeof file === 'string') throw new Error('Arquivo local indisponível: adicione-o à biblioteca de novo');
      objects.set(key, { body: file, size: sizeOf(file) });
      if (onProgress) onProgress(1);
    },
    async putJson(key, obj) {
      const body = JSON.stringify(obj, null, 2);
      objects.set(key, { body, size: sizeOf(body) });
    },
    async getJson(key) {
      const o = objects.get(key);
      return o ? JSON.parse(typeof o.body === 'string' ? o.body : await o.body.text()) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size }));
    },
    async presign(key) {
      const o = objects.get(key);
      if (o && typeof o.body !== 'string' && typeof URL.createObjectURL === 'function') return URL.createObjectURL(o.body);
      return '';
    },
  };
}

module.exports = { createMemoryS3 };
