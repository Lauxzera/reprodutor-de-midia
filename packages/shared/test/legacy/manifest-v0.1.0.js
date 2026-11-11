'use strict';

const SCHEMA_VERSION = 1;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const FILE_RE = /^media\/[a-f0-9]{64}\.[a-z0-9]{1,5}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FITS = ['contain', 'cover', 'fill'];

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm'];

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function mediaTypeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXT.includes(e)) return 'image';
  if (VIDEO_EXT.includes(e)) return 'video';
  return null;
}

function contentTypeFromExt(ext) {
  return CONTENT_TYPES[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function mediaKey(sha256, ext) {
  return `media/${sha256}${String(ext).toLowerCase()}`;
}

function screenKey(screenId) {
  return `screens/${screenId}.json`;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function validateSchedule(raw, where, fail) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where}.schedule inválido`);
    return null;
  }
  const out = {};

  if (raw.days !== undefined) {
    if (!Array.isArray(raw.days) || !raw.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      fail(`${where}.schedule.days deve ser lista de 0 a 6`);
    } else {
      const days = [...new Set(raw.days)].sort((a, b) => a - b);
      if (days.length > 0 && days.length < 7) out.days = days;
    }
  }

  const hasStart = raw.start !== undefined && raw.start !== null && raw.start !== '';
  const hasEnd = raw.end !== undefined && raw.end !== null && raw.end !== '';
  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) fail(`${where}.schedule: start e end devem vir juntos`);
    else if (!TIME_RE.test(raw.start) || !TIME_RE.test(raw.end)) fail(`${where}.schedule: horário deve ser HH:MM`);
    else if (raw.start !== raw.end) {
      out.start = raw.start;
      out.end = raw.end;
    }
  }

  for (const key of ['from', 'to']) {
    const v = raw[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !DATE_RE.test(v)) fail(`${where}.schedule.${key} deve ser AAAA-MM-DD`);
    else out[key] = v;
  }
  if (out.from && out.to && out.from > out.to) fail(`${where}.schedule: "from" é depois de "to"`);

  return Object.keys(out).length ? out : null;
}

/**
 * Valida e normaliza um manifesto. Nunca lança: devolve { ok, errors, manifest }.
 */
function validateManifest(input) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Manifesto não é um objeto'], manifest: null };
  }

  if (input.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion ${input.schemaVersion} não suportado (esperado ${SCHEMA_VERSION})`);
  }
  if (typeof input.screenId !== 'string' || !SLUG_RE.test(input.screenId)) fail('screenId inválido');

  let revision = 0;
  if (Number.isInteger(input.revision) && input.revision >= 0) revision = input.revision;
  else fail('revision inválida');

  const s = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const settings = {
    fit: FITS.includes(s.fit) ? s.fit : 'contain',
    transitionMs: Number.isFinite(s.transitionMs) ? clamp(Math.round(s.transitionMs), 0, 5000) : 600,
    muted: s.muted !== false,
  };

  const items = [];
  const ids = new Set();
  if (!Array.isArray(input.items)) {
    fail('items deve ser uma lista');
  } else {
    input.items.forEach((raw, i) => {
      const where = `items[${i}]`;
      if (!raw || typeof raw !== 'object') return fail(`${where} inválido`);
      let ok = true;
      const bad = (msg) => {
        ok = false;
        fail(`${where}: ${msg}`);
      };

      if (typeof raw.id !== 'string' || !raw.id) bad('id ausente');
      else if (ids.has(raw.id)) bad(`id duplicado "${raw.id}"`);
      else ids.add(raw.id);

      if (raw.type !== 'image' && raw.type !== 'video') bad('type deve ser image ou video');
      if (typeof raw.sha256 !== 'string' || !SHA_RE.test(raw.sha256)) bad('sha256 inválido');
      if (typeof raw.file !== 'string' || !FILE_RE.test(raw.file) || !raw.file.startsWith(`media/${raw.sha256}.`)) {
        bad('file inválido (esperado media/<sha256>.<ext>)');
      }
      if (raw.size !== undefined && !(Number.isInteger(raw.size) && raw.size >= 0)) bad('size inválido');

      let durationSec;
      if (raw.durationSec !== undefined) {
        if (!Number.isFinite(raw.durationSec) || raw.durationSec <= 0 || raw.durationSec > 3600) bad('durationSec inválido');
        else durationSec = raw.durationSec;
      } else if (raw.type === 'image') {
        durationSec = 10;
      }

      const schedule = validateSchedule(raw.schedule, where, (m) => {
        ok = false;
        fail(m);
      });

      if (ok) {
        const item = { id: raw.id, type: raw.type, file: raw.file, sha256: raw.sha256 };
        if (raw.size !== undefined) item.size = raw.size;
        item.name = String(raw.name || '').slice(0, 200);
        if (durationSec !== undefined) item.durationSec = durationSec;
        if (schedule) item.schedule = schedule;
        items.push(item);
      }
    });
  }

  if (errors.length) return { ok: false, errors, manifest: null };

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    screenId: input.screenId,
    revision,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
    settings,
    items,
  };
  return { ok: true, errors: [], manifest };
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * O item deve tocar agora? Usa o relógio local do PC.
 * Janela que cruza a meia-noite (ex.: 22:00–02:00) vale para o dia em que começou.
 */
function isItemActive(item, now = new Date()) {
  const s = item.schedule;
  if (!s) return true;

  const minutes = now.getHours() * 60 + now.getMinutes();
  const ref = new Date(now.getTime());

  if (s.start && s.end) {
    const a = toMinutes(s.start);
    const b = toMinutes(s.end);
    if (a < b) {
      if (minutes < a || minutes >= b) return false;
    } else if (a > b) {
      if (minutes >= a) {
        // ainda no dia em que a janela começou
      } else if (minutes < b) {
        ref.setDate(ref.getDate() - 1);
      } else {
        return false;
      }
    }
  }

  if (s.days && s.days.length && !s.days.includes(ref.getDay())) return false;
  const date = localDateStr(ref);
  if (s.from && date < s.from) return false;
  if (s.to && date > s.to) return false;
  return true;
}

function activeItems(items, now = new Date()) {
  return items.filter((it) => isItemActive(it, now));
}

/**
 * Próximo item ativo depois de `lastId`, na ordem da playlist e dando a volta.
 * Se só houver um item ativo, devolve o próprio.
 */
function nextActiveItem(items, lastId, now = new Date()) {
  const n = items.length;
  if (!n) return null;
  const start = items.findIndex((it) => it.id === lastId);
  for (let k = 1; k <= n; k++) {
    const it = items[(((start + k) % n) + n) % n];
    if (isItemActive(it, now)) return it;
  }
  return null;
}

module.exports = {
  SCHEMA_VERSION,
  SLUG_RE,
  FITS,
  IMAGE_EXT,
  VIDEO_EXT,
  mediaTypeFromExt,
  contentTypeFromExt,
  mediaKey,
  screenKey,
  validateManifest,
  isItemActive,
  activeItems,
  nextActiveItem,
};
