'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateManifest, sha256File, signedFetch, assessRequests, isCapError } = require('@reprodutor/shared');

const CAP_WAIT_MS = 30 * 60 * 1000; // cota do B2 esgotada: só tenta de novo daqui a 30 min
const today = () => new Date().toISOString().slice(0, 10); // o dia do B2 vira à meia-noite UTC

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

    // Conta cada requisição ao bucket (uma consulta de manifesto ou um download = 1 transação).
    const inner = this.fetch;
    this.fetch = (...args) => {
      this._countRequest();
      return inner(...args);
    };
    this._capHit = false;
    this._warnedDay = null;

    this.manifest = null;
    this.state = { etag: null, lastSyncAt: null, requestDay: today(), requestsToday: 0, priority: [], paused: [], order: [], local: {} };
    this.status = { state: 'idle', message: '', lastCheckAt: null, lastSyncAt: null };

    this._timer = null;
    this._stopped = true;
    this._inflight = null;
    this._failures = 0;
    this._lastProgressEmit = 0;

    // Fila de downloads: o que está baixando, em que ordem, o que foi pausado (o painel do player controla isso).
    this.dl = new Map(); // arquivo -> { state: 'downloading' | 'error', received, total, error }
    this.pending = null; // itens do manifesto que está sendo baixado (ainda não ativado)
    this.pendingRevision = null;
    this._current = null; // { file, ctrl } do download em andamento
    this._userAbort = false;
    this._rerun = false;
    this._lastDlEmit = 0;
  }

  _countRequest() {
    const d = today();
    if (this.state.requestDay !== d) {
      this.state.requestDay = d;
      this.state.requestsToday = 0;
    }
    this.state.requestsToday++;
    const q = assessRequests(this.state.requestsToday);
    if (q.level !== 'ok' && this._warnedDay !== d) {
      this._warnedDay = d;
      this.log(`Aviso de cota: ${q.used} leituras hoje (limite gratuito do B2 ~${q.limit}/dia, somando todos os players e o painel). Aumente "Consultar a cada".`);
    }
  }

  /** Uso diário de leituras deste player (para o painel de status). */
  quota() {
    const d = today();
    const used = this.state.requestDay === d ? this.state.requestsToday : 0;
    return assessRequests(used);
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

  /**
   * Itens do manifesto ativo com os ajustes locais deste player aplicados (nome, duração, ordem, oculta).
   * Os ajustes ficam no state.json e valem por id de item; o manifesto do admin não é alterado.
   */
  localItems() {
    if (!this.manifest) return [];
    const order = this.state.order || [];
    const local = this.state.local || {};
    const rank = (id, i) => {
      const k = order.indexOf(id);
      return k >= 0 ? k : 1e6 + i;
    };
    return this.manifest.items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => rank(a.it.id, a.i) - rank(b.it.id, b.i))
      .map(({ it }) => {
        const l = local[it.id] || {};
        const out = { ...it, origName: it.name || it.id, origDuration: it.durationSec || 0, localHidden: Boolean(l.hidden), localName: Boolean(l.name), localDuration: Boolean(l.durationSec) };
        if (l.name) out.name = l.name;
        if (l.durationSec) out.durationSec = l.durationSec;
        return out;
      });
  }

  /** Itens que tocam: na ordem local, não ocultos e com o arquivo no disco. */
  playableItems() {
    return this.localItems().filter((it) => !it.localHidden && this._hasFile(it));
  }

  /** Muda nome, duração (imagens) ou visibilidade de uma mídia só neste player. Valor vazio/0 volta ao do admin. */
  setItemLocal(id, patch = {}) {
    const it = this.manifest && this.manifest.items.find((x) => x.id === id);
    if (!it) return { ok: false, error: 'Mídia não encontrada na programação' };
    const local = { ...(this.state.local || {}) };
    const cur = { ...(local[id] || {}) };
    if ('name' in patch) {
      const n = String(patch.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (n && n !== (it.name || it.id)) cur.name = n;
      else delete cur.name;
    }
    if ('durationSec' in patch) {
      const d = Math.round(Number(patch.durationSec));
      if (it.type !== 'image') return { ok: false, error: 'A duração só vale para imagens (vídeo toca até o fim)' };
      if (d > 0 && d !== (it.durationSec || 0)) {
        if (d > 3600) return { ok: false, error: 'Duração máxima: 3600 s' };
        cur.durationSec = d;
      } else delete cur.durationSec;
    }
    if ('hidden' in patch) {
      if (patch.hidden) cur.hidden = true;
      else delete cur.hidden;
    }
    if (Object.keys(cur).length) local[id] = cur;
    else delete local[id];
    this.state.local = local;
    this._saveState();
    this.emit('local');
    this._emitDownloads(true);
    return { ok: true };
  }

  /** Muda a ordem de reprodução neste player: 'up', 'down', 'top', 'bottom'. */
  moveItem(id, action) {
    const ids = this.localItems().map((x) => x.id);
    const i = ids.indexOf(id);
    if (i < 0) return { ok: false, error: 'Mídia não encontrada na programação' };
    const to = { up: i - 1, down: i + 1, top: 0, bottom: ids.length - 1 }[action];
    if (to === undefined) return { ok: false, error: 'Ação desconhecida' };
    ids.splice(i, 1);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    this.state.order = ids;
    this._saveState();
    this.emit('local');
    return { ok: true };
  }

  /** Volta ao que o admin definiu: uma mídia (id) ou tudo (sem id, inclui a ordem). */
  resetLocal(id) {
    if (id) {
      const local = { ...(this.state.local || {}) };
      delete local[id];
      this.state.local = local;
    } else {
      this.state.local = {};
      this.state.order = [];
    }
    this._saveState();
    this.emit('local');
    this._emitDownloads(true);
    return { ok: true };
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
      this._timer = setTimeout(tick, this._capHit ? CAP_WAIT_MS : this._failures ? wait : this.pollMs);
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
        this.pending = null;
        this.pendingRevision = null;
        if (this._rerun) {
          this._rerun = false;
          this.syncOnce().catch(() => {});
        }
        this._emitDownloads(true);
      });
    }
    return this._inflight;
  }

  // ---------- fila de downloads (prioridade, pausa, gerenciamento) ----------

  _paused(file) {
    return (this.state.paused || []).includes(file);
  }

  _saveState() {
    // Gravações em série: várias mudanças seguidas (ordem, nome...) não se misturam no mesmo arquivo.
    const json = JSON.stringify(this.state, null, 2);
    this._saving = (this._saving || Promise.resolve()).then(() => fsp.writeFile(this.statePath, json)).catch(() => {});
    return this._saving;
  }

  /** Posição na fila definida pelo usuário (menor = antes); o que não foi ordenado vai depois, na ordem do manifesto. */
  _rank(file, fallback) {
    const i = (this.state.priority || []).indexOf(file);
    return i >= 0 ? i : 1e6 + fallback;
  }

  /** Itens (sem repetir arquivo) na ordem em que serão baixados. */
  _ordered(items) {
    const seen = new Set();
    const list = [];
    items.forEach((it, i) => {
      if (seen.has(it.file)) return;
      seen.add(it.file);
      list.push({ it, i });
    });
    return list.sort((a, b) => this._rank(a.it.file, a.i) - this._rank(b.it.file, b.i)).map((x) => x.it);
  }

  /** Faltam no disco e não estão pausados, na ordem de prioridade. */
  _toDownload(items) {
    return this._ordered(items).filter((it) => !this._hasFile(it) && !this._paused(it.file));
  }

  _partSize(item) {
    try {
      return fs.statSync(`${this.mediaPath(item)}.part`).size;
    } catch {
      return 0;
    }
  }

  /** Situação de cada mídia (da programação em andamento ou da ativa), em ordem de prioridade. */
  downloadStatus() {
    const items = this.pending || (this.manifest ? this.manifest.items : []);
    const rows = this._ordered(items).map((it, order) => {
      const present = this._hasFile(it);
      const cur = this.dl.get(it.file);
      const paused = this._paused(it.file);
      let state = present ? 'done' : paused ? 'paused' : cur && cur.state === 'error' ? 'error' : cur && cur.state === 'downloading' ? 'downloading' : 'queued';
      const total = (cur && cur.total) || it.size || 0;
      const received = present ? total : cur && cur.state === 'downloading' ? cur.received : this._partSize(it);
      return { id: it.id, file: it.file, name: ((this.state.local || {})[it.id] || {}).name || it.name || it.file, type: it.type, size: it.size || 0, state, received, total, paused, error: cur && cur.state === 'error' ? cur.error : '', order: order + 1 };
    });
    return { items: rows, revision: this.pendingRevision ?? (this.manifest ? this.manifest.revision : null), incoming: Boolean(this.pending), syncing: Boolean(this._inflight) };
  }

  _emitDownloads(force = false) {
    const now = Date.now();
    if (!force && now - this._lastDlEmit < 300) return;
    this._lastDlEmit = now;
    this.emit('downloads', this.downloadStatus());
  }

  _abortCurrent() {
    if (this._current) {
      this._userAbort = true;
      this._current.ctrl.abort();
    }
  }

  _kick() {
    if (this._inflight) this._rerun = true;
    else this.syncOnce().catch(() => {});
  }

  /**
   * Muda a ordem da fila. action: 'first' (baixa já, interrompendo o atual), 'top', 'up', 'down'.
   * O download interrompido continua de onde parou quando chegar a vez dele.
   */
  setPriority(file, action) {
    const items = this.pending || (this.manifest ? this.manifest.items : []);
    const order = this._ordered(items).map((it) => it.file);
    const i = order.indexOf(file);
    if (i < 0) return { ok: false, error: 'Mídia não encontrada na programação' };
    const move = (to) => {
      order.splice(i, 1);
      order.splice(Math.max(0, Math.min(order.length, to)), 0, file);
    };
    if (action === 'first' || action === 'top') move(0);
    else if (action === 'up') move(i - 1);
    else if (action === 'down') move(i + 1);
    else return { ok: false, error: 'Ação desconhecida' };
    this.state.priority = order;
    this._saveState();
    if (action === 'first') {
      if (this._paused(file)) this.state.paused = this.state.paused.filter((x) => x !== file);
      if (this._current && this._current.file !== file) this._abortCurrent(); // o atual volta à fila e retoma depois
      this._kick();
    }
    this._emitDownloads(true);
    return { ok: true };
  }

  setPaused(file, paused) {
    const set = new Set(this.state.paused || []);
    if (paused) set.add(file);
    else set.delete(file);
    this.state.paused = [...set];
    this._saveState();
    if (paused && this._current && this._current.file === file) this._abortCurrent();
    if (!paused) this._kick();
    this._emitDownloads(true);
    return { ok: true };
  }

  pauseAll(paused) {
    const items = this.pending || (this.manifest ? this.manifest.items : []);
    const missing = items.filter((it) => !this._hasFile(it)).map((it) => it.file);
    const set = new Set(this.state.paused || []);
    for (const f of paused ? missing : [...set]) paused ? set.add(f) : set.delete(f);
    this.state.paused = [...set];
    this._saveState();
    if (paused) this._abortCurrent();
    else this._kick();
    this._emitDownloads(true);
    return { ok: true };
  }

  /** Apaga o arquivo do disco. redownload=true baixa de novo na fila; false deixa pausada (não volta sozinha). */
  async removeLocal(file, { redownload = true } = {}) {
    const items = this.pending || (this.manifest ? this.manifest.items : []);
    const it = items.find((x) => x.file === file);
    if (!it) return { ok: false, error: 'Mídia não encontrada na programação' };
    if (this._current && this._current.file === file) this._abortCurrent();
    try {
      await fsp.rm(this.mediaPath(it), { force: true });
      await fsp.rm(`${this.mediaPath(it)}.part`, { force: true });
    } catch (e) {
      return { ok: false, error: `Não consegui apagar (${e.code || e.message}). Se ela está tocando agora, tente de novo depois.` };
    }
    this.dl.delete(file);
    const set = new Set(this.state.paused || []);
    if (redownload) set.delete(file);
    else set.add(file);
    this.state.paused = [...set];
    this._saveState();
    this.log(`Mídia ${redownload ? 'apagada para baixar de novo' : 'removida do disco'}: ${it.name || file}`);
    if (redownload) this._kick();
    this._emitDownloads(true);
    return { ok: true };
  }

  _setStatus(state, message = '') {
    this.status = { ...this.status, state, message, quota: this.quota(), quotaExceeded: this._capHit };
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
        const body = res.status === 403 || res.status === 429 || res.status === 503 ? await res.text().catch(() => '') : '';
        this._capHit = false;
        if (isCapError(res.status, body)) {
          this._capHit = true;
          this.log('Cota diária do B2 esgotada (HTTP ' + res.status + '); continua tocando do disco e tenta de novo em 30 min.');
          return this._finish('error', 'Cota diária do B2 esgotada: segue tocando o que já está no disco; volta a atualizar quando a cota renovar (meia-noite UTC)');
        }
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

    this._capHit = false; // o B2 respondeu normalmente
    if (!target) return this._finish('idle', 'Sem manifesto ainda');

    // 2) Baixa o que falta (arquivos novos ou apagados do disco), na ordem de prioridade da fila.
    this.pending = target.items;
    this.pendingRevision = target.revision;
    let missing = this._toDownload(target.items);
    let downloadedCount = 0;

    if (missing.length) {
      const enough = await this._checkDiskSpace(missing);
      if (!enough.ok) return this._finish('error', enough.message);

      let done = 0;
      while ((missing = this._toDownload(target.items)).length) {
        const it = missing[0];
        this._setStatus('downloading', `Baixando ${done + 1}/${done + missing.length}: ${it.name || it.file}`);
        this.dl.set(it.file, { state: 'downloading', received: this._partSize(it), total: it.size || 0, error: '' });
        this._emitDownloads(true);
        try {
          await this._download(it, done, done + missing.length);
          this.dl.delete(it.file);
        } catch (e) {
          if (e.userAbort) {
            this.dl.delete(it.file); // pausado, apagado ou passou a vez: volta à fila e segue com o próximo
            continue;
          }
          this.dl.set(it.file, { state: 'error', received: this._partSize(it), total: it.size || 0, error: e.message });
          this._emitDownloads(true);
          this.log(`Falha ao baixar ${it.file}: ${e.message}`);
          const offline = e.name === 'TypeError' || e.name === 'AbortError' || e.name === 'TimeoutError';
          return this._finish(offline ? 'offline' : 'error', `Download interrompido: ${e.message}`);
        }
        done++;
        downloadedCount++;
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
    return { status: isNew ? 'updated' : 'unchanged', downloaded: downloadedCount };
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
      this._current = { file: item.file, ctrl };
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
      } catch (e) {
        if (this._userAbort) {
          this._userAbort = false;
          throw Object.assign(new Error('interrompido pelo usuário'), { userAbort: true });
        }
        throw e;
      } finally {
        clearTimeout(idleTimer);
        this._current = null;
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
    const cur = this.dl.get(item.file);
    if (cur && cur.state === 'downloading') {
      cur.received = received;
      if (total) cur.total = total;
    }
    this._emitDownloads(false);
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
