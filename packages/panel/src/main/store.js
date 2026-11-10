'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sha256File, mediaTypeFromExt } = require('@reprodutor/shared');

const DEFAULT_SETTINGS = {
  type: 'b2', // 'b2' | 'folder'
  endpoint: '',
  region: '',
  bucket: '',
  publicBaseUrl: '',
  privateBucket: false, // true: o player lê com chave somente de leitura (URL no formato path-style)
  folderPath: '',
};

const DEFAULT_PROJECT = () => ({
  version: 1,
  screens: [
    {
      id: 'loja',
      name: 'Loja principal',
      revision: 0,
      settings: { fit: 'contain', transitionMs: 600, muted: true },
      items: [],
    },
  ],
});

/**
 * Persistência local do painel: configurações, credenciais (criptografadas),
 * biblioteca de mídias e projeto (playlists). Sem dependência do Electron;
 * a criptografia é injetada ({ encrypt(str)->Buffer, decrypt(Buffer)->str }).
 */
class Store {
  constructor(dir, cipher) {
    this.dir = dir;
    this.cipher = cipher;
    this.libraryDir = path.join(dir, 'library');
    fs.mkdirSync(this.libraryDir, { recursive: true });
  }

  _read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  _write(name, data) {
    const file = path.join(this.dir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  // --- configurações e credenciais ---

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this._read('settings.json', {}) };
  }

  hasKeys() {
    return fs.existsSync(path.join(this.dir, 'secrets.bin'));
  }

  getKeys() {
    try {
      const buf = fs.readFileSync(path.join(this.dir, 'secrets.bin'));
      return JSON.parse(this.cipher.decrypt(buf));
    } catch {
      return null;
    }
  }

  saveSettings(patch, keys) {
    const next = { ...this.getSettings(), ...patch };
    this._write('settings.json', next);
    if (keys && keys.keyId && keys.appKey) {
      fs.writeFileSync(path.join(this.dir, 'secrets.bin'), this.cipher.encrypt(JSON.stringify(keys)));
    }
    return next;
  }

  // --- biblioteca ---

  _libraryEntries() {
    return this._read('library.json', []);
  }

  libraryFile(entry) {
    return path.join(this.libraryDir, `${entry.sha256}${entry.ext}`);
  }

  listLibrary() {
    return this._libraryEntries().map((e) => ({ ...e, path: this.libraryFile(e), url: pathToFileURL(this.libraryFile(e)).href }));
  }

  /** Copia arquivos para a biblioteca (deduplicando pelo SHA-256). */
  async addFiles(paths) {
    const entries = this._libraryEntries();
    const added = [];
    const skipped = [];
    for (const src of paths) {
      const name = path.basename(src);
      const ext = path.extname(src).toLowerCase();
      const type = mediaTypeFromExt(ext);
      if (!type) {
        skipped.push({ name, reason: `formato não suportado (${ext || 'sem extensão'})` });
        continue;
      }
      try {
        const st = await fsp.stat(src);
        if (!st.isFile()) throw new Error('não é um arquivo');
        const sha256 = await sha256File(src);
        if (entries.some((e) => e.sha256 === sha256)) {
          skipped.push({ name, reason: 'já está na biblioteca' });
          continue;
        }
        const entry = { sha256, name, ext, type, size: st.size, addedAt: new Date().toISOString() };
        await fsp.copyFile(src, this.libraryFile(entry));
        entries.push(entry);
        added.push(entry.sha256);
      } catch (e) {
        skipped.push({ name, reason: e.message });
      }
    }
    this._write('library.json', entries);
    return { added, skipped };
  }

  removeFromLibrary(sha256) {
    const project = this.getProject();
    const usedIn = project.screens.filter((s) => s.items.some((it) => it.sha256 === sha256)).map((s) => s.name);
    if (usedIn.length) return { ok: false, usedIn };
    const entries = this._libraryEntries();
    const entry = entries.find((e) => e.sha256 === sha256);
    if (!entry) return { ok: true };
    fs.rmSync(this.libraryFile(entry), { force: true });
    this._write('library.json', entries.filter((e) => e.sha256 !== sha256));
    return { ok: true };
  }

  // --- projeto (telas e playlists) ---

  getProject() {
    const p = this._read('project.json', null);
    if (p && Array.isArray(p.screens) && p.screens.length) return p;
    const fresh = DEFAULT_PROJECT();
    this._write('project.json', fresh);
    return fresh;
  }

  saveProject(project) {
    if (!project || !Array.isArray(project.screens) || !project.screens.length) throw new Error('Projeto inválido');
    this._write('project.json', project);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
