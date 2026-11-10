'use strict';

const {
  SCHEMA_VERSION,
  validateManifest,
  mediaKey,
  screenKey,
  contentTypeFromExt,
} = require('@reprodutor/shared');

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Monta o manifesto de uma tela a partir da playlist e da biblioteca. */
function buildManifest(screen, library, revision) {
  const bySha = new Map(library.map((e) => [e.sha256, e]));
  const items = screen.items.map((it, i) => {
    const media = bySha.get(it.sha256);
    if (!media) throw new Error(`Item ${i + 1} aponta para uma mídia que não está mais na biblioteca`);
    const out = {
      id: it.id,
      type: media.type,
      file: mediaKey(media.sha256, media.ext),
      sha256: media.sha256,
      size: media.size,
      name: media.name,
    };
    if (media.type === 'image') out.durationSec = Number(it.durationSec) > 0 ? Number(it.durationSec) : 10;
    if (it.schedule) out.schedule = it.schedule;
    return out;
  });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    screenId: screen.id,
    revision,
    updatedAt: new Date().toISOString(),
    settings: screen.settings,
    items,
  };
  const v = validateManifest(manifest);
  if (!v.ok) throw new Error(`Playlist inválida: ${v.errors.join('; ')}`);
  return v.manifest;
}

/**
 * Publica uma tela: envia as mídias que faltam e, só no fim, o manifesto
 * (o player nunca enxerga um manifesto que aponta para arquivo inexistente).
 */
async function publishScreen({ storage, screen, library, onProgress = () => {} }) {
  const manifest = buildManifest(screen, library, (screen.revision || 0) + 1);
  const bySha = new Map(library.map((e) => [e.sha256, e]));

  const unique = [...new Map(manifest.items.map((it) => [it.sha256, it])).values()];
  let uploaded = 0;
  let skipped = 0;

  for (let i = 0; i < unique.length; i++) {
    const it = unique[i];
    const entry = bySha.get(it.sha256);
    const label = `(${i + 1}/${unique.length}) ${entry.name}`;
    const existing = await storage.exists(it.file);
    if (existing === entry.size) {
      skipped++;
      onProgress({ step: 'skip', message: `${label}: já está no bucket`, pct: (i + 1) / (unique.length + 1) });
      continue;
    }
    onProgress({ step: 'upload', message: `${label}: enviando…`, pct: i / (unique.length + 1) });
    await storage.putFile(it.file, entry.path, {
      contentType: contentTypeFromExt(entry.ext),
      cacheControl: IMMUTABLE,
      onProgress: (f) =>
        onProgress({ step: 'upload-progress', message: `${label}: ${Math.round(f * 100)}%`, pct: (i + f) / (unique.length + 1) }),
    });
    uploaded++;
  }

  onProgress({ step: 'manifest', message: 'Publicando programação…', pct: unique.length / (unique.length + 1) });
  await storage.putJson(screenKey(screen.id), manifest, { cacheControl: 'no-cache' });
  onProgress({ step: 'done', message: `Publicado: revisão ${manifest.revision}`, pct: 1 });

  return { manifest, uploaded, skipped };
}

module.exports = { buildManifest, publishScreen };
