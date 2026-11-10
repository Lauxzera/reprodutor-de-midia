'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateManifest, sha256File, signedFetch } =require('@reprodutor/shared');

const MANIFEST_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 30000;
const DISK_MARGIN_BYTES = 50 * 1024 * 1024;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

class SyncEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir  pasta local (manifest.json, state.json, media/)
   * @param {string} opts.baseUrl  URL pública do bucket
   * @param {string} opts.screenId id da tela (screens/<id>.json)
   * @param {number} [opts.pollSeconds]
   */
  constructor(opts) {
    super();
    this.dataDir = opts.dataDir;
    this.baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    this.screenId = opts.screenId || '';
    this.pollMs = opts.pollMs || Math.max(5, opts.pollSeconds || 60) * 1000;
    this.fetch = opts.fetch || globalThis.fetch;
    // Bucket privado: assina cada leitura (SigV4) com uma chave somente de leitura.
    if (opts.keyId && opts.secretKey) {
      this.fetch = signedFetch(this.fetch, { keyId: opts.keyId, secretKey: opts.secretKey, region: opts.region });
    }
    this.log = opts.log || (() => {});

    this.mediaDir = path.join(this.dataDir, 'media');
    this.manifestPath = path.join(this.dataDir, 'manifest.json');
    this.backupManifestPath = path.join(this.dataDir, 'manifest.bak.json');
    this.statePath = path.join(this.dataDir, 'state.json');

    this.manifest = null;
    this.state = { etag: null, lastSyncAt: null };
    this.status = { state: 'idle', message: '', lastCheckAt: null, lastSyncAt: null };

    this._timer = null;
    this._stopped = true;
    this._inflight = null;
    this._failures = 0;
    this._lastProgressEmit = 0;
  }

  get manifestUrl() {
    return `${this.baseUrl}/screens/${this.screenId}.json`;
  }

  /** Carrega manifesto e estado do disco (o que estiver lá toca mesmo sem rede). */
  init() {
    fs.mkdirSync(this.mediaDir, { recursive: true });
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')) };
      this.status.lastSyncAt = this.state.lastSyncAt;
    } catch {
      /* sem estado ainda (ou corrompido) */
    }

    this.manifest = this._readManifest(this.manifestPath);
    if (!this.manifest) {
      // Queda de energia pode corromper o arquivo: usa a cópia de segurança e força nova consulta completa.
      this.manifest = this._readManifest(this.backupManifestPath);
      if (this.manifest) {
        this.state.etag = null;
        this.log('manifest.json ausente ou corrompido; usando manifest.bak.json');
      }
    }
    return this.manifest;
  }

  _readManifest(file) {
    try {
      const v = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (v.ok) return v.manifest;
      this.log(`${path.basename(file)} inválido: ${v.errors.join('; ')}`);
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`Falha ao ler ${path.basename(file)}: ${e.message}`);
    }
    return null;
  }

  mediaPath(item) {
    return path.join(this.mediaDir, path.basename(item.file));
  }

  _hasFile(item) {
    try {
      const st = fs.statSync(this.mediaPath(item));
      return st.isFile() && (item.size === undefined || st.size === item.size);
    } catch {
      return false;
    }
  }

  /** Itens do manifesto ativo cujo arquivo realmente está no disco. */
  playableItems() {
    if (!this.manifest) return [];
    return this.manifest.items.filter((it) => this._hasFile(it));
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    if (!this.manifest && !fs.existsSync(this.mediaDir)) this.init();
    const tick = async () => {
      if (this._stopped) return;
      try {
        await this.syncOnce();
      } catch (e) {
        this.log(`Erro inesperado na sincronização: ${e.stack || e.message}`);
      }
      if (this._stopped) return;
      const wait = Math.min(this.pollMs * 2 ** Math.min(this._failures, 6), Math.max(this.pollMs, MAX_BACKOFF_MS));
      this._timer = setTimeout(tick, this._failures ? wait : this.pollMs);
    };
    tick();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
  }

  syncOnce() {
    if (!this._inflight) {
      this._inflight = this._sync().finally(() => {
        this._inflight = null;
      });
    }
    return this._inflight;
  }

  _setStatus(state, message = '') {
    this.status = { ...this.status, state, message };
    this.emit('status', this.status);
  }

  _finish(state, message = '') {
    this._failures = state === 'offline' || state === 'error' ? this._failures + 1 : 0;
    this._setStatus(state, message);
    return { status: state, message };
  }

  async _sync() {
    if (!this.baseUrl || !this.screenId) {
      return this._finish('error', 'Player sem baseUrl/screenId no config.json');
    }
    this.status.lastCheckAt = new Date().toISOString();
    this._setStatus('checking');

    // 1) Manifesto remoto (ETag evita baixar de novo).
    let target = null;
    let isNew = false;
    let etag = null;
    try {
      const headers = { 'cache-control': 'no-cache' };
      if (this.manifest && this.state.etag) headers['if-none-match'] = this.state.etag;
      const res = await this.fetch(this.manifestUrl, { headers, signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });

      if (res.status === 304) {
        target = this.manifest;
      } else if (res.status === 404) {
        return this._finish('error', `Manifesto não encontrado: ${this.manifestUrl}`);
      } else if (!res.ok) {
        return this._finish('error', `HTTP ${res.status} ao consultar o manifesto`);
      } else {
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return this._finish('error', 'Manifesto remoto não é JSON válido');
        }
        const v = validateManifest(json);
        if (!v.ok) return this._finish('error', `Manifesto remoto inválido: ${v.errors[0]}`);
        if (v.manifest.screenId !== this.screenId) {
          return this._finish('error', `Manifesto é da tela "${v.manifest.screenId}", esperado "${this.screenId}"`);
        }
        etag = res.headers.get('etag');
        target = v.manifest;
        isNew = !this.manifest || JSON.stringify(this.manifest) !== JSON.stringify(v.manifest);
      }
    } catch (e) {
      // Sem rede, DNS, timeout...: segue tocando o que está no disco.
      return this._finish('offline', e.cause?.code || e.name || e.message);
    }

    if (!target) return this._finish('idle', 'Sem manifesto ainda');

    // 2) Baixa o que falta (arquivos novos ou apagados do disco).
    const missing = [];
    const seen = new Set();
    for (const it of target.items) {
      if (!seen.has(it.file) && !this._hasFile(it)) {
        seen.add(it.file);
        missing.push(it);
      }
    }

    if (missing.length) {
      const enough = await this._checkDiskSpace(missing);
      if (!enough.ok) return this._finish('error', enough.message);

      let done = 0;
      for (const it of missing) {
        this._setStatus('downloading', `Baixando ${done + 1}/${missing.length}: ${it.name || it.file}`);
        try {
          await this._download(it, done, missing.length);
        } catch (e) {
          this.log(`Falha ao baixar ${it.file}: ${e.message}`);
          const offline = e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'TimeoutError';
          return this._finish(offline ? 'offline' : 'error', `Download interrompido: ${e.message}`);
        }
        done++;
      }
    }

    // 3) Só agora troca o manifesto (atômico) e avisa o player.
    if (isNew) {
      const tmp = `${this.manifestPath}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(target, null, 2));
      await fsp.rename(tmp, this.manifestPath);
      // Cópia de segurança (também atômica): se o manifesto principal corromper numa queda de energia, ainda há este.
      try {
        await fsp.copyFile(this.manifestPath, `${this.backupManifestPath}.tmp`);
        await fsp.rename(`${this.backupManifestPath}.tmp`, this.backupManifestPath);
      } catch (e) {
        this.log(`Não foi possível gravar a cópia de segurança do manifesto: ${e.message}`);
      }
      this.manifest = target;
    }
    this.state.etag = etag || this.state.etag;
    this.state.lastSyncAt = new Date().toISOString();
    this.status.lastSyncAt = this.state.lastSyncAt;
    await fsp.writeFile(this.statePath, JSON.stringify(this.state, null, 2)).catch(() => {});

    if (isNew) {
      this.log(`Manifesto atualizado: revisão ${target.revision}, ${target.items.length} itens`);
      this.emit('manifest', this.manifest);
    }

    // 4) Por último, apaga o que não é mais usado.
    await this._gc();

    this._finish('idle', isNew ? `Atualizado (revisão ${target.revision})` : 'Em dia');
    return { status: isNew ? 'updated' : 'unchanged', downloaded: missing.length };
  }

  async _checkDiskSpace(missing) {
    let need = DISK_MARGIN_BYTES;
    for (const it of missing) {
      let have = 0;
      try {
        have = (await fsp.stat(`${this.mediaPath(it)}.part`)).size;
      } catch {
        /* sem parcial */
      }
      need += Math.max(0, (it.size || 0) - have);
    }
    try {
      const st = await fsp.statfs(this.mediaDir);
      const free = st.bavail * st.bsize;
      if (free < need) {
        const mb = (n) => Math.ceil(n / 1048576);
        return { ok: false, message: `Espaço em disco insuficiente: precisa de ${mb(need)} MB, livre ${mb(free)} MB` };
      }
    } catch {
      /* statfs indisponível: segue */
    }
    return { ok: true };
  }

  async _download(item, index, total, retriedFrom416 = false) {
    const dest = this.mediaPath(item);
    const part = `${dest}.part`;
    const url = `${this.baseUrl}/${item.file}`;

    let have = 0;
    try {
      have = (await fsp.stat(part)).size;
    } catch {
      /* sem parcial */
    }
    if (item.size !== undefined && have > item.size) {
      await fsp.rm(part, { force: true });
      have = 0;
    }

    if (!(item.size !== undefined && have === item.size)) {
      const ctrl = new AbortController();
      let idleTimer;
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
      };
      bumpIdle();
      try {
        const headers = have > 0 ? { range: `bytes=${have}-` } : {};
        const res = await this.fetch(url, { headers, signal: ctrl.signal });

        if (res.status === 416) {
          await fsp.rm(part, { force: true });
          if (retriedFrom416) throw new Error('HTTP 416 repetido');
          return await this._download(item, index, total, true);
        }
        if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);

        const append = res.status === 206 && have > 0;
        let received = append ? have : 0;
        const length = Number(res.headers.get('content-length') || 0);
        const grand = (append ? have : 0) + length || item.size || 0;
        const tap = new Transform({
          transform: (chunk, _enc, cb) => {
            bumpIdle();
            received += chunk.length;
            this._emitProgress(item, received, grand, index, total);
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
      } finally {
        clearTimeout(idleTimer);
      }
    }

    const hash = await sha256File(part);
    if (hash !== item.sha256) {
      await fsp.rm(part, { force: true });
      throw new Error(`Hash divergente em ${item.name || item.file}`);
    }
    await fsp.rename(part, dest);
  }

  _emitProgress(item, received, total, index, count) {
    const now = Date.now();
    if (now - this._lastProgressEmit < 400 && received !== total) return;
    this._lastProgressEmit = now;
    this.emit('progress', { file: item.name || item.file, received, total, index, count });
  }

  async _gc() {
    if (!this.manifest) return;
    const keep = new Set();
    for (const it of this.manifest.items) {
      const name = path.basename(it.file);
      keep.add(name);
      keep.add(`${name}.part`);
    }
    let names = [];
    try {
      names = await fsp.readdir(this.mediaDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        await fsp.rm(path.join(this.mediaDir, name), { force: true });
        this.log(`Removido do disco: ${name}`);
      } catch (e) {
        this.log(`Não foi possível remover ${name}: ${e.message}`); // ex.: em uso; tenta na próxima
      }
    }
  }
}

module.exports = { SyncEngine };
