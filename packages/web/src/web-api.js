'use strict';

// Implementa, no navegador, a mesma interface `panelApi` que o app Electron expõe ao painel
// (settings, library, project, publish), guardando tudo no próprio bucket em admin/*.json.
// Assim a interface (panel.js) é única para o app de mesa e para a versão web.

const { mediaTypeFromExt, screenKey, mediaKey } = require('@reprodutor/shared');
const { publishScreen } = require('../../panel/src/main/publish');
const { hashAndProbe } = require('./sha256');
const { assessStorage, fmtBytes } = require('../../shared/src/quota');
const { encodePair } = require('../../shared/src/pair');

const LIBRARY_KEY = 'admin/library.json';
const PROJECT_KEY = 'admin/project.json';

const DEFAULT_PROJECT = () => ({
  version: 1,
  screens: [{ id: 'loja', name: 'Loja principal', revision: 0, settings: { fit: 'contain', transitionMs: 600, muted: true }, items: [] }],
});

function baseUrlFor(s) {
  if (s.publicBaseUrl) return s.publicBaseUrl.replace(/\/+$/, '');
  if (s.endpoint && s.bucket) {
    try {
      const host = new URL(s.endpoint).host;
      return s.privateBucket ? `https://${host}/${s.bucket}` : `https://${s.bucket}.${host}`;
    } catch {
      return '';
    }
  }
  return '';
}

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
};

/**
 * @param {object} o
 * @param {object} o.storage   createS3(...) ou createMemoryS3()
 * @param {object} o.settings  { endpoint, region, bucket, privateBucket, publicBaseUrl }
 * @param {Function} o.saveSettings (patch, keys) => Promise
 * @param {Function} [o.logout]
 * @param {Function} [o.pickFiles] () => Promise<File[]>   (seletor de arquivos do navegador)
 */
function createWebApi({ storage, settings, saveSettings, logout, pickFiles, getReadKey = () => null }) {
  const viewSettings = () => {
    const rk = getReadKey();
    return { type: 'b2', ...settings, hasKeys: true, hasReadKey: Boolean(rk), readKeyId: rk ? rk.keyId : '', baseUrl: baseUrlFor(settings) };
  };
  let library = null; // entradas (sem url/path)
  const localFiles = new Map(); // sha256 -> File desta sessão (para reenviar se faltar no bucket)
  const publishListeners = [];
  const libraryListeners = [];
  const say = (m) => libraryListeners.forEach((cb) => cb(m));

  async function loadLibrary() {
    if (!library) library = (await storage.getJson(LIBRARY_KEY)) || [];
    return library;
  }
  const saveLibrary = () => storage.putJson(LIBRARY_KEY, library);

  async function loadProject() {
    const p = await storage.getJson(PROJECT_KEY);
    if (p && Array.isArray(p.screens) && p.screens.length) return p;
    const fresh = DEFAULT_PROJECT();
    await storage.putJson(PROJECT_KEY, fresh);
    return fresh;
  }

  // Uso do armazenamento do bucket (soma de tudo o que existe nele), para avisar antes de estourar os 10 GB gratuitos.
  let usage = null;
  async function refreshUsage() {
    const objects = await storage.list('');
    usage = { ...assessStorage(objects.reduce((n, o) => n + o.size, 0)), objects: objects.length };
    return usage;
  }

  async function addFiles(files) {
    const entries = await loadLibrary();
    const added = [];
    const skipped = [];
    let n = 0;
    try {
      if (!usage) await refreshUsage();
    } catch {
      /* sem a medição, segue sem a trava de cota */
    }
    for (const file of files) {
      n++;
      const name = file.name;
      const ext = extOf(name);
      const type = mediaTypeFromExt(ext);
      const tag = `(${n}/${files.length}) ${name}`;
      if (!type) {
        skipped.push({ name, reason: `formato não suportado (${ext || 'sem extensão'})` });
        continue;
      }
      try {
        say(`${tag}: calculando assinatura…`);
        const probe = await hashAndProbe(file, (f) => say(`${tag}: lendo ${Math.round(f * 100)}%`));
        const sha256 = probe.sha256;
        if (type === 'video' && probe.hevc && !probe.h264) {
          skipped.push({ name, reason: 'vídeo em HEVC (H.265, comum em iPhone): o player não consegue exibir a imagem. Converta para H.264 em MP4 (HandBrake ou ffmpeg) e envie de novo' });
          continue;
        }
        if (entries.some((e) => e.sha256 === sha256)) {
          skipped.push({ name, reason: 'já está na biblioteca' });
          continue;
        }
        const key = mediaKey(sha256, ext);
        const existing = await storage.exists(key);
        if (existing !== file.size) {
          if (usage && usage.used + file.size > usage.limit) {
            skipped.push({ name, reason: `não cabe nos ${fmtBytes(usage.limit)} gratuitos do B2 (já usados: ${fmtBytes(usage.used)}). Apague mídias órfãs ou arquivos no site do B2` });
            continue;
          }
          say(`${tag}: enviando…`);
          await storage.putFile(key, file, {
            contentType: file.type || undefined,
            cacheControl: 'public, max-age=31536000, immutable',
            onProgress: (f) => say(`${tag}: enviando ${Math.round(f * 100)}%`),
          });
        }
        if (existing !== file.size && usage) usage = { ...assessStorage(usage.used + file.size, usage.limit), objects: usage.objects + 1 };
        const entry = { sha256, name, ext, type, size: file.size, addedAt: new Date().toISOString() };
        entries.push(entry);
        localFiles.set(sha256, file);
        await saveLibrary();
        added.push(sha256);
      } catch (e) {
        skipped.push({ name, reason: e.message });
      }
    }
    return { added, skipped };
  }

  return {
    web: true,
    settings: {
      get: async () => viewSettings(),
      save: async (patch, keys, readKeys) => {
        await saveSettings({ endpoint: patch.endpoint, region: patch.region, bucket: patch.bucket, publicBaseUrl: patch.publicBaseUrl || '', privateBucket: Boolean(patch.privateBucket) }, keys, readKeys);
        return viewSettings();
      },
      test: async () => {
        try {
          await storage.putJson('_ping.json', { at: new Date().toISOString() });
          await storage.delete('_ping.json');
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      pickFolder: async () => null,
    },
    library: {
      list: async () => {
        const entries = await loadLibrary();
        return Promise.all(
          entries.map(async (e) => ({ ...e, path: localFiles.get(e.sha256) || null, url: await storage.presign(mediaKey(e.sha256, e.ext), 6 * 3600) })),
        );
      },
      pick: async () => {
        const files = pickFiles ? await pickFiles() : [];
        return files.length ? addFiles(files) : { added: [], skipped: [] };
      },
      addPaths: (files) => addFiles(files),
      remove: async (sha256) => {
        const project = await loadProject();
        const usedIn = project.screens.filter((s) => s.items.some((it) => it.sha256 === sha256)).map((s) => s.name);
        if (usedIn.length) return { ok: false, usedIn };
        await loadLibrary();
        library = library.filter((e) => e.sha256 !== sha256);
        localFiles.delete(sha256);
        await saveLibrary();
        return { ok: true };
      },
      onProgress: (cb) => libraryListeners.push(cb),
    },
    project: {
      get: loadProject,
      save: async (project) => {
        if (!project || !Array.isArray(project.screens) || !project.screens.length) throw new Error('Projeto inválido');
        await storage.putJson(PROJECT_KEY, project);
        return true;
      },
    },
    publish: {
      run: async (screenId) => {
        const project = await loadProject();
        const screen = project.screens.find((s) => s.id === screenId);
        if (!screen) throw new Error('Tela não encontrada');
        const lib = (await loadLibrary()).map((e) => ({ ...e, path: localFiles.get(e.sha256) || null }));
        const result = await publishScreen({
          storage,
          screen,
          library: lib,
          onProgress: (p) => publishListeners.forEach((cb) => cb(p)),
        });
        screen.revision = result.manifest.revision;
        await storage.putJson(PROJECT_KEY, project);
        const base = baseUrlFor(settings);
        return { revision: result.manifest.revision, uploaded: result.uploaded, skipped: result.skipped, baseUrl: base, manifestUrl: base ? `${base}/${screenKey(screen.id)}` : '' };
      },
      onProgress: (cb) => publishListeners.push(cb),
    },
    pathForFile: (file) => file,
    pair: {
      // Código de pareamento do Player: endpoint + bucket + chave de leitura + intervalo.
      code: async () => {
        const rk = getReadKey();
        if (!settings.endpoint || !settings.bucket) return { ok: false, error: 'Configure o bucket do B2 em Configurações.' };
        if (settings.privateBucket && !rk) return { ok: false, error: 'Informe a chave de leitura do player em Configurações.' };
        try {
          return { ok: true, code: encodePair({ endpoint: settings.endpoint, bucket: settings.bucket, keyId: settings.privateBucket ? rk.keyId : '', secretKey: settings.privateBucket ? rk.appKey : '', pollSeconds: settings.privateBucket ? 120 : 60, publicBaseUrl: settings.publicBaseUrl }) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    },
    quota: {
      get: async () => usage || refreshUsage(),
      refresh: refreshUsage,
    },
    logout: logout || (async () => {}),

    /** Apaga do bucket as mídias que não estão na biblioteca nem em nenhuma tela publicada. */
    cleanOrphans: async () => {
      const entries = await loadLibrary();
      const keep = new Set(entries.map((e) => mediaKey(e.sha256, e.ext)));
      for (const obj of await storage.list('screens/')) {
        const m = await storage.getJson(obj.key);
        for (const it of (m && m.items) || []) keep.add(it.file);
      }
      const orphans = (await storage.list('media/')).filter((o) => !keep.has(o.key));
      for (const o of orphans) await storage.delete(o.key);
      usage = null; // será medido de novo
      return { removed: orphans.length, bytes: orphans.reduce((n, o) => n + o.size, 0) };
    },
  };
}

module.exports = { createWebApi, baseUrlFor, DEFAULT_PROJECT };
