// shared/ops.js — Frame Studio operation engine (pure). Browser + Node.
//
// applyOps(project, ops, ctx) → { project, results }
//   * never mutates `project`; each op works on a fresh deep clone, so a failing op leaves no partial change
//   * each result: { ok:true, id?, ids?, …extra, warnings? } | { ok:false, error:"Hebrew message" }
//   * ctx.atomic → if any op fails, the ORIGINAL project object is returned (all results still reported)
//   * ctx.media  → resolved media for path-based ops: { [mediaId|path]: Media } or Media[]
//   * ctx.sounds → { [soundQuery]: libraryEntry } for `sfx` ops (or put the entry on the op as `resolved`)
//   * ctx.catalog → catalog from shared/catalog.js getCatalog() (else the last loaded one is used if any)

import {
  CLIP_TYPES, VISUAL_TYPES, MEDIA_TYPES, AUDIO_CAPABLE_TYPES, TEXT_TYPES, TRACK_KINDS, VIDEO_ROLES, AUDIO_ROLES,
  ROLE_LABELS, CLIP_TYPE_LABELS, TRACK_KIND_LABELS, BLEND_MODES, FIT_MODES, MASK_TYPES, SAFE_AREAS, SHAPE_KINDS,
  COLOR_KEYS, clone, deepMerge, getPath, setPathMut, isPlainObject, clamp, round6, isFiniteNumber, uid,
  newClip, newTrack, clipEnd, clipsOnTrack, trackById, projectDuration, parseTimecode, maxClipDuration,
  dbToGain, isKeyframable, DEFAULT_TEXT, TYPE_DEFAULT_DURATION, nextClipOnTrack, KEYFRAMABLE_PATTERNS,
} from './model.js';
import { interpolateKeyframes, evalKeyframed, isEaseName, CLIP_ANIM_IDS, getEase, parsePartEase, partEase } from './anim.js';
import { getCatalogSync } from './catalog.js';
import { alignScriptToAsr, tokenizeScript } from './align.js';

// ───────────────────────────── errors / small utils ─────────────────────────────

class OpError extends Error { constructor(msg) { super(msg); this.name = 'OpError'; } }
const fail = (msg) => { throw new OpError(msg); };
const EPS = 1e-4;
const fmt = (t) => (Math.round((Number(t) || 0) * 100) / 100).toFixed(2);

function num(v, def, label) {
  if (v === undefined || v === null || v === '') {
    if (def === undefined) fail(`חסר ערך מספרי${label ? ` (${label})` : ''}`);
    return def;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) fail(`ערך מספרי לא תקין${label ? ` ל-${label}` : ''}: ${JSON.stringify(v)}`);
  return n;
}
function int(v, def) { return Math.trunc(num(v, def)); }
const fpsOf = (P) => (P.settings && P.settings.fps > 0 ? P.settings.fps : 30);
const frameOf = (P) => 1 / fpsOf(P);
function asList(v) { return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]; }

// ───────────────────────────── words / transcript ─────────────────────────────

const NIQQUD_RE = /[\u0591-\u05C7]/g;
const BIDI_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const TRAIL_QUOTES_RE = /["'״׳)\]}»”’]+$/u;

export function stripNiqqud(s) { return String(s ?? '').replace(NIQQUD_RE, ''); }

/** Word comparison key: no niqqud/cantillation, no punctuation/symbols, no bidi marks, lowercase. */
export function normalizeWord(w) {
  return String(w ?? '').normalize('NFC')
    .replace(NIQQUD_RE, '')
    .replace(BIDI_RE, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function cleanTail(w) { return stripNiqqud(w).replace(BIDI_RE, '').trim().replace(TRAIL_QUOTES_RE, ''); }
export function endsSentence(w) { const s = cleanTail(w); return /[.!?…؟]$/.test(s); }
export function endsClause(w) { const s = cleanTail(w); return /[,;:،]$/.test(s); }
function visibleLength(w) { return stripNiqqud(w).replace(BIDI_RE, '').length; }

/** Normalize words input: "transcript" | [[w,s,e,hot?]] | [{w|word|text, s|start, e|end, hot}] → [{w,s,e,hot}] sorted. */
function parseWords(input, P) {
  let src = input;
  if (src === undefined || src === null || src === 'transcript') src = (P.transcript && P.transcript.words) || [];
  if (!Array.isArray(src)) fail('words חייב להיות מערך [[מילה,התחלה,סוף]…] או [{w,s,e}…] או "transcript"');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    let w, s, e, hot = false;
    if (Array.isArray(x)) { [w, s, e] = x; hot = !!x[3]; }
    else if (x && typeof x === 'object') {
      w = x.w ?? x.word ?? x.text; s = x.s ?? x.start; e = x.e ?? x.end; hot = !!x.hot;
    } else fail(`מילה ${i} לא תקינה: ${JSON.stringify(x)}`);
    if (typeof w !== 'string' || !w.trim()) fail(`מילה ${i} ריקה`);
    s = num(s, undefined, `זמן התחלה של "${w}"`);
    e = e === undefined || e === null ? s + 0.3 : num(e, undefined, `זמן סוף של "${w}"`);
    if (e <= s) e = s + 0.05;
    out.push({ w: w.trim(), s: round6(s), e: round6(e), hot });
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}

function getWords(P) {
  const tw = P.transcript && Array.isArray(P.transcript.words) ? P.transcript.words : [];
  if (tw.length) return tw;
  const all = [];
  for (const c of Object.values(P.clips || {})) if (c.type === 'caption') for (const w of c.caption?.words || []) all.push(w);
  return all.sort((a, b) => a.s - b.s);
}

/** Find the n-th occurrence of a word: exact first, then ignoring punctuation/niqqud. n<0 counts from the end. */
export function findWord(P, word, n = 0) {
  const words = getWords(P);
  if (!words.length) fail('אין תמלול בפרויקט — הגדר תמלול (setTranscript / cutx transcript) או הוסף כתוביות לפני שימוש בזמן לפי מילה');
  const pick = (list) => {
    const idx = n < 0 ? list.length + n : n;
    return idx >= 0 && idx < list.length ? list[idx] : null;
  };
  const exact = words.filter((x) => x.w === word);
  const a = pick(exact);
  if (a) return a;
  const nw = normalizeWord(word);
  const norm = words.filter((x) => normalizeWord(x.w) === nw);
  const b = pick(norm);
  if (b) return b;
  const count = Math.max(exact.length, norm.length);
  const sugg = [...new Set(words.filter((x) => { const k = normalizeWord(x.w); return nw && k && k !== nw && (k.includes(nw) || nw.includes(k)); }).map((x) => x.w))].slice(0, 6);
  fail(`המילה "${word}"${n ? ` (מופע ${n})` : ''} לא נמצאה בתמלול${count ? ` — יש רק ${count} מופעים` : ''}${sugg.length ? `. אולי התכוונת ל: ${sugg.join(' / ')}` : ''}`);
}

function findMarker(P, ref, n = 0) {
  const ms = P.markers || [];
  const byId = ms.find((m) => m.id === ref);
  if (byId) return byId;
  const exact = ms.filter((m) => m.label === ref);
  const pickL = (l) => l[n < 0 ? l.length + n : n] || null;
  const a = pickL(exact);
  if (a) return a;
  const k = normalizeWord(ref);
  const b = pickL(ms.filter((m) => normalizeWord(m.label) === k));
  if (b) return b;
  fail(`הסמן "${ref}" לא נמצא${ms.length ? `. סמנים קיימים: ${ms.map((m) => m.label || m.id).slice(0, 10).join(', ')}` : ' (אין סמנים בפרויקט)'}`);
}

function parseTimeString(P, s0) {
  const s = String(s0).trim();
  if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?s?$/i.test(s)) return Number(s.replace(/s$/i, ''));
  if (s === 'end') return projectDuration(P);
  if (s === 'start') return 0;
  const m = /^(word|marker|clip):(.*)$/s.exec(s);
  if (m) {
    const kind = m[1];
    let rest = m[2];
    if (kind === 'word') {
      let parts = rest.split(':');
      let w = parts[0], n = 0;
      const hm = /^(.*)#(-?\d+)$/.exec(w);
      if (hm) { w = hm[1]; n = Number(hm[2]); }
      if (parts[1] !== undefined && parts[1] !== '') n = int(parts[1], 0);
      const offset = parts[2] !== undefined && parts[2] !== '' ? num(parts[2], 0) : 0;
      const edge = parts[3] || 'start';
      return resolveTime(P, { word: w, n, offset, edge });
    }
    if (kind === 'marker') {
      const parts = rest.split(':');
      return resolveTime(P, { marker: parts[0], offset: parts[1] ? num(parts[1], 0) : 0 });
    }
    const parts = rest.split(':');
    return resolveTime(P, { clip: parts[0], edge: parts[1] || 'start', offset: parts[2] ? num(parts[2], 0) : 0 });
  }
  if (s.includes(':')) {
    const t = parseTimecode(s, fpsOf(P));
    if (Number.isFinite(t)) return t;
  }
  fail(`זמן לא תקין: "${s}" (מספר שניות, "word:מילה[:מופע[:היסט[:end]]]", "marker:תווית", "clip:מזהה:end" או קוד זמן MM:SS:FF)`);
}

/**
 * Resolve a time value to seconds:
 *   number | numeric string | "MM:SS:FF" | "end"
 *   { word, n=0, offset=0, edge:"start"|"end"|"center" } | ["word", n, offset]
 *   { marker:"label"|id, n?, offset } | { clip:id, edge:"start"|"end"|"center", offset } | { t, offset }
 * Throws (Hebrew message) when it cannot be resolved.
 */
export function resolveTime(project, v) {
  const P = project || {};
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`זמן לא תקין: ${v}`);
    return round6(v);
  }
  if (v === undefined || v === null || v === '') fail('חסר ערך זמן');
  if (typeof v === 'string') return round6(parseTimeString(P, v));
  if (Array.isArray(v)) {
    if (typeof v[0] === 'string' && !/^-?\d/.test(v[0])) return resolveTime(P, { word: v[0], n: v[1] ?? 0, offset: v[2] ?? 0, edge: v[3] || 'start' });
    if (v.length === 1) return resolveTime(P, v[0]);
    fail(`זמן לא תקין: ${JSON.stringify(v)}`);
  }
  if (typeof v === 'object') {
    const off = num(v.offset, 0, 'offset');
    if (v.word !== undefined) {
      const w = findWord(P, String(v.word), int(v.n, 0));
      const base = v.edge === 'end' ? w.e : v.edge === 'center' ? (w.s + w.e) / 2 : w.s;
      return round6(base + off);
    }
    if (v.marker !== undefined) return round6(findMarker(P, String(v.marker), int(v.n, 0)).t + off);
    if (v.clip !== undefined) {
      const c = P.clips && P.clips[v.clip];
      if (!c) fail(`הקליפ "${v.clip}" לא נמצא (בזמן יחסי לקליפ)`);
      const base = v.edge === 'end' ? clipEnd(c) : v.edge === 'center' ? c.start + c.duration / 2 : c.start;
      return round6(base + off);
    }
    if (v.t !== undefined) return round6(resolveTime(P, v.t) + off);
    if (v.time !== undefined) return round6(resolveTime(P, v.time) + off);
  }
  fail(`זמן לא תקין: ${JSON.stringify(v)}`);
}

// ───────────────────────────── captions chunking ─────────────────────────────

/**
 * Split words into caption chunks. Explicit `chunks` (counts) win; otherwise chunks never cross sentence ends
 * (. ! ? …), clause ends (, ; : when commaBreak) or pauses longer than pauseBreak; inside each segment the
 * partition uses the fewest chunks that respect maxWords/maxChars, as balanced as possible.
 * Returns array of arrays of word objects.
 */
export function chunkCaptionWords(words, opts = {}) {
  const maxWords = Math.max(1, Math.floor(num(opts.maxWords, 3)));
  const maxChars = Math.max(1, num(opts.maxChars, 18));
  const pauseBreak = opts.pauseBreak === false || opts.pauseBreak === null ? Infinity : num(opts.pauseBreak, 0.6);
  const commaBreak = opts.commaBreak !== false;
  const n = words.length;
  if (!n) return [];
  let chunks = opts.chunks;
  if (typeof chunks === 'string') chunks = chunks.split(/[,\s]+/).filter(Boolean).map(Number);
  if (typeof chunks === 'number') chunks = [chunks];
  if (Array.isArray(chunks) && chunks.length) {
    const out = [];
    let i = 0;
    for (const k0 of chunks) {
      const k = Math.floor(Number(k0));
      if (!(k >= 1)) fail(`גודל מקטע לא תקין ב-chunks: ${JSON.stringify(k0)}`);
      if (i >= n) break;
      out.push(words.slice(i, i + k));
      i += k;
    }
    if (i < n) out.push(...chunkCaptionWords(words.slice(i), { ...opts, chunks: null }));
    return out;
  }
  const segs = [];
  let cur = [];
  for (let i = 0; i < n; i++) {
    const w = words[i];
    if (cur.length && w.s - words[i - 1].e > pauseBreak) { segs.push(cur); cur = []; }
    cur.push(w);
    if (endsSentence(w.w) || (commaBreak && endsClause(w.w))) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);
  const out = [];
  for (const seg of segs) out.push(...partitionSegment(seg, maxWords, maxChars));
  return out;
}

function partitionSegment(seg, maxWords, maxChars) {
  const m = seg.length;
  const lens = seg.map((w) => visibleLength(w.w));
  const best = new Array(m + 1).fill(null);
  best[0] = { k: 0, sq: 0, prev: -1 };
  for (let i = 1; i <= m; i++) {
    let chars = -1;
    for (let j = i - 1; j >= 0; j--) {
      const cnt = i - j;
      chars += lens[j] + 1;
      if (cnt > maxWords) break;
      if (cnt > 1 && chars > maxChars) break;
      const b = best[j];
      if (!b) continue;
      const cand = { k: b.k + 1, sq: b.sq + cnt * cnt, prev: j };
      const cb = best[i];
      if (!cb || cand.k < cb.k || (cand.k === cb.k && cand.sq < cb.sq)) best[i] = cand;
    }
  }
  const groups = [];
  let i = m;
  while (i > 0) { const b = best[i]; groups.unshift(seg.slice(b.prev, i)); i = b.prev; }
  return groups;
}

/** Built-in caption style defaults, used when the render catalog (text-render.js CAPTION_STYLES) is not loaded. */
export const FALLBACK_CAPTION_STYLES = {
  chordix: {
    text: { font: 'Heebo', weight: 900, size: 98, color: '#f2f8fb', stroke: { color: '#071822', width: 14 },
      shadow: { color: 'rgba(0,0,0,0.55)', blur: 18, x: 0, y: 6 }, background: { opacity: 0 }, maxWidth: 940 },
    activeColor: '#3fe0f5', hotColor: '#ff8a66',
  },
  pill: {
    text: { font: 'Heebo', weight: 800, size: 68, color: '#000000', stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 }, background: { color: '#ffffff', opacity: 1, padding: 22, radius: 20 } },
    activeColor: '#000000', hotColor: '#e8364f',
  },
  kinetic: {
    text: { font: 'Heebo', weight: 900, size: 104, color: '#ffffff', stroke: { color: '#000000', width: 10 } },
    activeColor: '#3fe0f5', hotColor: '#ff8a66',
  },
  karaoke: {
    text: { font: 'Heebo', weight: 800, size: 84, color: '#ffffff', stroke: { color: '#000000', width: 10 } },
    activeColor: '#3fe0f5', hotColor: '#ff8a66',
  },
  boldPop: {
    text: { font: 'Heebo', weight: 900, size: 150, color: '#ffffff', stroke: { color: '#000000', width: 16 } },
    activeColor: '#ffe14d', hotColor: '#ff8a66',
  },
  boxHighlight: {
    text: { font: 'Heebo', weight: 800, size: 84, color: '#ffffff', stroke: { color: '#000000', width: 0 } },
    activeColor: '#13b6e4', hotColor: '#ff8a66',
  },
  minimal: {
    text: { font: 'Assistant', weight: 600, size: 66, color: '#ffffff', stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0.5)', blur: 16, x: 0, y: 3 } },
    activeColor: '#ffffff', hotColor: '#ffd27a',
  },
  typewriter: {
    text: { font: 'Heebo', weight: 700, size: 76, color: '#ffffff', stroke: { color: '#000000', width: 8 } },
    activeColor: '#ffffff', hotColor: '#ff8a66',
  },
};

function captionStyleDefaults(style, X) {
  const list = X.cat && Array.isArray(X.cat.captionStyles) ? X.cat.captionStyles : [];
  const cs = list.find((s) => s && s.id === style);
  if (cs) {
    const d = cs.defaults || {};
    return { text: d.text || {}, activeColor: d.activeColor, hotColor: d.hotColor, textAnim: d.textAnim, maxWords: d.maxWords, y: d.y };
  }
  const fb = FALLBACK_CAPTION_STYLES[style];
  if (fb) return fb;
  const ids = list.length ? list.map((s) => s.id) : Object.keys(FALLBACK_CAPTION_STYLES);
  fail(`סגנון כתוביות לא מוכר: "${style}". סגנונות קיימים: ${ids.join(', ')}`);
}

// ───────────────────────────── media / paths ─────────────────────────────

function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').trim().toLowerCase();
  return n(a) === n(b);
}

function lookupCtxMedia(ctx, key) {
  const m = ctx && ctx.media;
  if (!m || !key) return null;
  if (Array.isArray(m)) return m.find((x) => x && (x.id === key || samePath(x.path, key))) || null;
  if (typeof m === 'object') {
    if (m[key] && typeof m[key] === 'object') return m[key];
    return Object.values(m).find((x) => x && typeof x === 'object' && (x.id === key || samePath(x.path, key))) || null;
  }
  return null;
}

function useMedia(P, media) {
  if (!media || !media.id) fail('מדיה לא תקינה (חסר id)');
  if (!P.media[media.id]) P.media[media.id] = clone(media);
  return P.media[media.id];
}

function mediaById(P, X, id) {
  const m = P.media[id] || lookupCtxMedia(X.ctx, id);
  if (!m) fail(`המדיה "${id}" לא נמצאה בפרויקט`);
  return useMedia(P, m);
}

function mediaByPath(P, X, path) {
  const inProject = Object.values(P.media).find((m) => samePath(m.path, path));
  if (inProject) return inProject;
  const fromCtx = lookupCtxMedia(X.ctx, path);
  if (fromCtx) return useMedia(P, fromCtx);
  fail(`הקובץ "${path}" עוד לא יובא לפרויקט — הוספה לפי נתיב מתבצעת דרך השרת (POST /ops או cutx), או ייבא קודם (cutx import) והשתמש ב-mediaId`);
}

function looksLikePath(s) { return typeof s === 'string' && (/[\\/]/.test(s) || /\.(wav|mp3|flac|ogg|m4a|aiff?|opus)$/i.test(s)); }

function soundEntryToMedia(P, entry) {
  if (!entry || typeof entry !== 'object') fail('רשומת צליל לא תקינה');
  const abs = entry.abs || entry.path || entry.file;
  const existing = Object.values(P.media).find((m) => (entry.id && m.library && m.library.soundId === entry.id) || (abs && samePath(m.path, abs)));
  if (existing) return existing;
  let id = entry.id ? `m_snd_${String(entry.id).replace(/[^a-zA-Z0-9_-]/g, '')}` : uid('m_');
  while (P.media[id]) id = uid('m_');
  const m = {
    id, kind: 'audio', name: entry.name || entry.title || (abs ? String(abs).split(/[\\/]/).pop() : 'צליל'),
    path: abs || '', duration: Number(entry.duration) || 0, width: 0, height: 0, fps: 0,
    hasVideo: false, hasAudio: true, channels: entry.channels || 2, sampleRate: entry.sampleRate || 48000, size: entry.size || 0,
    status: 'ready',
  };
  if (entry.id) m.library = { soundId: entry.id };
  P.media[id] = m;
  return m;
}

function resolveSoundMedia(P, op, X) {
  if (op.mediaId) return mediaById(P, X, op.mediaId);
  const entry = op.resolved || (X.ctx.sounds && op.sound !== undefined ? X.ctx.sounds[op.sound] : null);
  if (entry && typeof entry === 'object') {
    if (entry.kind && entry.id && (entry.hasAudio !== undefined || entry.status)) return useMedia(P, entry); // already a Media
    return soundEntryToMedia(P, entry);
  }
  const key = op.path || op.sound;
  if (key === undefined || key === null || key === '') fail('sfx: חסר sound (חיפוש, מזהה צליל או נתיב)');
  const s = String(key);
  const inProject = Object.values(P.media).find((m) => m.id === s || (m.library && m.library.soundId === s) || samePath(m.path, s));
  if (inProject) return inProject;
  const fromCtx = lookupCtxMedia(X.ctx, s);
  if (fromCtx) return useMedia(P, fromCtx);
  fail(`לא ניתן לאתר את הצליל "${s}" בלי השרת — שלח את הפעולה דרך השרת (cutx sfx / POST /ops) או ציין mediaId`);
}

// ───────────────────────────── tracks ─────────────────────────────

const RANK = { effects: 0, captions: 1, text: 2, overlay: 3, main: 4, voice: 5, music: 6, sfx: 7 };
export function isCaptionsTrack(t) { return !!t && (t.captions === true || (t.role === 'text' && t.name === ROLE_LABELS.captions)); }
function trackRank(t) { return isCaptionsTrack(t) ? RANK.captions : RANK[t.role] ?? RANK.overlay; }
function kindForRole(role) { return AUDIO_ROLES.includes(role) ? 'audio' : 'video'; }
function insertIndexForRank(P, rank) {
  const i = P.tracks.findIndex((t) => trackRank(t) > rank);
  return i < 0 ? P.tracks.length : i;
}

function findTrack(P, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'object' && ref.id) ref = ref.id;
  const s = String(ref);
  return P.tracks.find((t) => t.id === s) || P.tracks.find((t) => t.name === s) ||
    (s === 'captions' ? P.tracks.find(isCaptionsTrack) : null) ||
    P.tracks.find((t) => t.role === s && !isCaptionsTrack(t)) || null;
}

function requireTrack(P, ref) {
  const t = findTrack(P, ref);
  if (!t) fail(`הערוץ "${ref}" לא נמצא. ערוצים: ${P.tracks.map((x) => `${x.id} (${x.name})`).join(', ') || 'אין'}`);
  return t;
}

function uniqueTrackName(P, base) {
  if (!P.tracks.some((t) => t.name === base)) return base;
  for (let i = 2; i < 1000; i++) { const n = `${base} ${i}`; if (!P.tracks.some((t) => t.name === n)) return n; }
  return `${base} ${uid('')}`;
}

function uniqueId(exists, preferred, prefix) {
  if (preferred !== undefined && preferred !== null && preferred !== '') {
    const id = String(preferred);
    if (exists(id)) fail(`המזהה "${id}" כבר קיים`);
    return id;
  }
  let id;
  do { id = uid(prefix); } while (exists(id));
  return id;
}

function createTrack(P, { kind, role, name, index, captions, id, preferredId }) {
  const r = role || (kind === 'audio' ? 'sfx' : 'overlay');
  const k = kind || kindForRole(r);
  const okRoles = k === 'audio' ? AUDIO_ROLES : VIDEO_ROLES;
  if (!okRoles.includes(r)) fail(`התפקיד "${r}" לא מתאים לערוץ ${TRACK_KIND_LABELS[k]} (תפקידים אפשריים: ${okRoles.join(', ')})`);
  let tid;
  if (id) tid = uniqueId((x) => P.tracks.some((t) => t.id === x), id, 't_');
  else if (preferredId && !P.tracks.some((t) => t.id === preferredId)) tid = preferredId;
  else tid = uniqueId((x) => P.tracks.some((t) => t.id === x), null, 't_');
  const base = name || (captions ? ROLE_LABELS.captions : ROLE_LABELS[r]);
  const t = newTrack(k, { id: tid, role: r, name: name ? name : uniqueTrackName(P, base) });
  if (captions) t.captions = true;
  let idx = index === undefined || index === null ? insertIndexForRank(P, captions ? RANK.captions : RANK[r] ?? RANK.overlay) : clamp(Math.trunc(Number(index)) || 0, 0, P.tracks.length);
  P.tracks.splice(idx, 0, t);
  return t;
}

function overlaps(aS, aE, bS, bE) { return aS < bE - EPS && bS < aE - EPS; }

function trackConflicts(P, trackId, s, e, exclude) {
  return Object.values(P.clips).filter((c) => c.trackId === trackId && !(exclude && exclude.has(c.id)) && overlaps(s, e, c.start, clipEnd(c)));
}
function isTrackFree(P, trackId, s, e, exclude) { return trackConflicts(P, trackId, s, e, exclude).length === 0; }

function defaultRoleForType(type) {
  switch (type) {
    case 'video': case 'image': return 'main';
    case 'audio': return 'sfx';
    case 'text': return 'text';
    case 'caption': return 'captions';
    case 'shape': case 'sticker': return 'overlay';
    case 'effect': case 'adjustment': return 'effects';
    default: return 'overlay';
  }
}

function tracksForRole(P, role) {
  if (role === 'captions') return P.tracks.filter(isCaptionsTrack);
  return P.tracks.filter((t) => t.role === role && !isCaptionsTrack(t));
}

function createRoleTrack(P, role, X) {
  if (role === 'captions') return createTrack(P, { kind: 'video', role: 'text', captions: true, preferredId: 't_captions' });
  if (role === 'effects') return createTrack(P, { kind: 'video', role: 'effects', index: 0, preferredId: 't_effects' });
  const t = createTrack(P, { kind: kindForRole(role), role, preferredId: `t_${role}` });
  if (X) X.warn(`נוצר ערוץ חדש "${t.name}"`);
  return t;
}

/** New track of the same role right above (video) / below (audio) a group of tracks. */
function createAdjacentTrack(P, group, X) {
  const ref = group[0];
  const role = isCaptionsTrack(ref) ? 'captions' : ref.role;
  let index;
  if (ref.kind === 'audio') index = Math.max(...group.map((t) => P.tracks.indexOf(t))) + 1;
  else index = Math.min(...group.map((t) => P.tracks.indexOf(t)));
  const t = role === 'captions'
    ? createTrack(P, { kind: 'video', role: 'text', captions: true, index })
    : createTrack(P, { kind: ref.kind, role, index });
  X.warn(`הערוץ תפוס בזמן הזה — נוצר ערוץ חדש "${t.name}"`);
  return t;
}

/**
 * Choose / prepare the track for a clip occupying [s,e). Handles explicit track, role, auto role,
 * main→overlay fallback, and overlap modes: newTrack (default) | allow | overwrite | insert | error.
 */
function placeClip(P, clip, opts, X) {
  const s = clip.start, e = clipEnd(clip);
  const needKind = clip.type === 'audio' ? 'audio' : 'video';
  const overlap = opts.overlap || 'newTrack';
  if (!['newTrack', 'allow', 'overwrite', 'insert', 'error'].includes(overlap)) fail(`ערך overlap לא מוכר: "${overlap}" (newTrack | allow | overwrite | insert | error)`);
  const exclude = new Set([clip.id, ...(opts.exclude || [])]);
  const onTarget = (t) => {
    if (t.kind !== needKind) fail(`לא ניתן לשים ${CLIP_TYPE_LABELS[clip.type]} בערוץ ${TRACK_KIND_LABELS[t.kind]} "${t.name}"`);
    if (overlap === 'allow' || isTrackFree(P, t.id, s, e, exclude)) return t;
    if (overlap === 'overwrite') { clearRange(P, t.id, s, e, exclude, X); return t; }
    if (overlap === 'insert') { insertSpaceOnTrack(P, t.id, s, e - s, exclude, X); return t; }
    if (overlap === 'error') fail(`הערוץ "${t.name}" תפוס בין ${fmt(s)} ל-${fmt(e)}`);
    return null;
  };
  if (opts.track !== undefined && opts.track !== null && opts.track !== '') {
    const t = requireTrack(P, opts.track);
    if (t.locked && !opts.force) fail(`הערוץ "${t.name}" נעול`);
    const ok = onTarget(t);
    if (ok) return ok;
    if (t.role === 'main') return overlayChain(P, s, e, exclude, X);
    return createAdjacentTrack(P, [t], X);
  }
  let role = opts.role || defaultRoleForType(clip.type);
  if (role === 'caption') role = 'captions';
  const validRoles = needKind === 'audio' ? AUDIO_ROLES : [...VIDEO_ROLES, 'captions'];
  if (!validRoles.includes(role)) fail(`התפקיד "${role}" לא מתאים ל${CLIP_TYPE_LABELS[clip.type]} (אפשר: ${validRoles.join(', ')})`);
  const allOfRole = tracksForRole(P, role);
  const cands = allOfRole.filter((t) => !t.locked);
  if (!allOfRole.length) return createRoleTrack(P, role, X);
  if (!cands.length) {
    if (role === 'main') return overlayChain(P, s, e, exclude, X);
    return createAdjacentTrack(P, allOfRole, X);
  }
  if (overlap === 'allow') return cands[0];
  if (overlap === 'overwrite' || overlap === 'insert') return onTarget(cands[0]);
  for (const t of cands) if (isTrackFree(P, t.id, s, e, exclude)) return t;
  if (overlap === 'error') fail(`אין ערוץ ${ROLE_LABELS[role]} פנוי בין ${fmt(s)} ל-${fmt(e)}`);
  if (role === 'main') return overlayChain(P, s, e, exclude, X);
  return createAdjacentTrack(P, cands, X);
}

function overlayChain(P, s, e, exclude, X) {
  const overlays = tracksForRole(P, 'overlay').filter((t) => !t.locked);
  for (const t of overlays) if (isTrackFree(P, t.id, s, e, exclude)) return t;
  if (overlays.length) return createAdjacentTrack(P, overlays, X);
  const mainIdx = P.tracks.findIndex((t) => t.role === 'main');
  const t = createTrack(P, { kind: 'video', role: 'overlay', index: mainIdx >= 0 ? mainIdx : undefined });
  X.warn(`הערוץ הראשי תפוס בזמן הזה — הקליפ הונח בערוץ "${t.name}"`);
  return t;
}

function checkLocked(P, clip, op) {
  const t = trackById(P, clip.trackId);
  if (t && t.locked && !op.force) fail(`הערוץ "${t.name}" נעול — בטל נעילה (updateTrack locked:false) או שלח force:true`);
}

// ───────────────────────────── clip editing primitives (mutating, on the working clone) ─────────────────────────────

function getClip(P, id) {
  if (id === undefined || id === null || id === '') fail('חסר מזהה קליפ (id)');
  const c = P.clips[id];
  if (!c) fail(`הקליפ "${id}" לא נמצא`);
  return c;
}

function syncCaptionText(c) {
  if (c.type === 'caption' && c.caption && Array.isArray(c.caption.words)) {
    c.caption.words.sort((a, b) => a.s - b.s);
    if (!c.text) c.text = DEFAULT_TEXT();
    c.text.content = c.caption.words.map((w) => w.w).join(' ');
  }
}

function shiftClip(c, delta) {
  if (!delta) return;
  c.start = round6(c.start + delta);
  if (c.type === 'caption' && c.caption && Array.isArray(c.caption.words)) {
    for (const w of c.caption.words) { w.s = round6(w.s + delta); w.e = round6(w.e + delta); }
  }
}

function shiftKeyframes(c, delta) {
  if (!c.keyframes || !delta) return;
  for (const prop of Object.keys(c.keyframes)) {
    c.keyframes[prop] = c.keyframes[prop].map((k) => ({ ...k, t: round6(k.t + delta) }));
  }
}

function scaleKeyframes(c, factor) {
  if (!c.keyframes || factor === 1) return;
  for (const prop of Object.keys(c.keyframes)) c.keyframes[prop] = c.keyframes[prop].map((k) => ({ ...k, t: round6(k.t * factor) }));
}

function clampFades(c) {
  if (c.fadeIn !== undefined) c.fadeIn = clamp(c.fadeIn, 0, c.duration);
  if (c.fadeOut !== undefined) c.fadeOut = clamp(c.fadeOut, 0, c.duration);
  if (c.fadeIn + c.fadeOut > c.duration && c.duration > 0) {
    const k = c.duration / (c.fadeIn + c.fadeOut);
    c.fadeIn = round6(c.fadeIn * k); c.fadeOut = round6(c.fadeOut * k);
  }
}

function isTimedMedia(c) { return c.type === 'video' || c.type === 'audio'; }

/** Move the clip's start to newStart keeping its end fixed (adjusts in-point, keyframes, loop phase). */
function trimHeadInternal(c, newStart) {
  const d = newStart - c.start;
  if (Math.abs(d) < 1e-9) return;
  const sp = c.speed > 0 ? c.speed : 1;
  if (isTimedMedia(c) && !c.reverse) c.in = round6(Math.max(0, (c.in || 0) + d * sp));
  c.start = round6(newStart);
  c.duration = round6(c.duration - d);
  shiftKeyframes(c, -d);
  if (c.animLoop && c.animLoop.id && c.animLoop.id !== 'none') c.animLoop.offset = round6((Number(c.animLoop.offset) || 0) + d);
  clampFades(c);
}

/** Move the clip's end to newEnd keeping its start fixed. */
function trimTailInternal(c, newEnd) {
  const newDur = round6(newEnd - c.start);
  const d = c.duration - newDur;
  if (Math.abs(d) < 1e-9) return;
  const sp = c.speed > 0 ? c.speed : 1;
  if (isTimedMedia(c) && c.reverse) c.in = round6(Math.max(0, (c.in || 0) + d * sp));
  c.duration = newDur;
  clampFades(c);
}

function dedupeKfs(list) {
  const out = [];
  for (const k of list.sort((a, b) => a.t - b.t)) {
    if (out.length && Math.abs(out[out.length - 1].t - k.t) < 1e-6) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/** Split a keyframe map at local time `cut` → [leftMap, rightMap(times relative to cut)]. Values stay continuous. */
export function splitKeyframeMap(kmap, cut) {
  const L = {}, R = {};
  for (const [prop, list0] of Object.entries(kmap || {})) {
    if (!Array.isArray(list0) || !list0.length) continue;
    const list = list0.slice().sort((a, b) => a.t - b.t);
    const vcut = interpolateKeyframes(list, cut, list[0].v);
    const before = list.filter((k) => k.t < cut - 1e-6);
    const after = list.filter((k) => k.t > cut + 1e-6);
    const at = list.find((k) => Math.abs(k.t - cut) <= 1e-6);
    let left = before.map((k) => ({ ...k }));
    let right = after.map((k) => ({ ...k, t: round6(k.t - cut) }));
    if (at) {
      left.push({ ...at, t: round6(cut) });
      right.unshift({ ...at, t: 0 });
    } else if (before.length && after.length) {
      const a = before[before.length - 1], b = after[0];
      const ez = b.ease || 'linear';
      const pc = (cut - a.t) / (b.t - a.t);
      const part = parsePartEase(ez);
      const inner = getEase(part ? part.inner : ez);
      const A = part ? part.a : 0, B = part ? part.b : 1, M = A + (B - A) * pc;
      const exact = Math.abs(inner(M) - inner(A)) > 1e-9 && Math.abs(inner(B) - inner(M)) > 1e-9;
      if (ez === 'linear' || ez === 'hold') {
        left.push({ t: round6(cut), v: vcut, ease: ez });
        right.unshift({ t: 0, v: vcut, ease: 'linear' });
      } else if (exact) {
        // Same curve, split in two: each half gets the matching sub-range of the original ease.
        left.push({ t: round6(cut), v: vcut, ease: partEase(ez, 0, pc) });
        right[0] = { ...right[0], ease: partEase(ez, pc, 1) };
        right.unshift({ t: 0, v: vcut, ease: 'linear' });
      } else {
        // Degenerate (the curve passes exactly through an end value at the cut): resample with linear keys.
        const N = 16;
        for (let j = 1; j <= N; j++) {
          const t = a.t + ((cut - a.t) * j) / N;
          left.push({ t: round6(t), v: interpolateKeyframes(list, t, 0), ease: 'linear' });
        }
        const rs = [{ t: 0, v: vcut, ease: 'linear' }];
        for (let j = 1; j < N; j++) {
          const t = cut + ((b.t - cut) * j) / N;
          rs.push({ t: round6(t - cut), v: interpolateKeyframes(list, t, 0), ease: 'linear' });
        }
        right[0] = { ...right[0], ease: 'linear' };
        right = rs.concat(right);
      }
    } else if (!before.length) {
      left = [{ t: 0, v: vcut, ease: 'linear' }];
    } else {
      right = [{ t: 0, v: vcut, ease: 'linear' }];
    }
    L[prop] = dedupeKfs(left);
    R[prop] = dedupeKfs(right);
  }
  return [L, R];
}

/** Split clip c at absolute time `at`; c becomes the left part; returns the new right clip (already in P.clips). */
function splitInternal(P, c, at, rightId) {
  const local = round6(at - c.start);
  const oldDur = c.duration;
  const sp = c.speed > 0 ? c.speed : 1;
  const r = clone(c);
  r.id = uniqueId((x) => !!P.clips[x], rightId, 'c_');
  r.start = round6(at);
  r.duration = round6(oldDur - local);
  c.duration = local;
  if (isTimedMedia(c)) {
    if (!c.reverse) r.in = round6((c.in || 0) + local * sp);
    else { r.in = c.in || 0; c.in = round6((c.in || 0) + (oldDur - local) * sp); }
  }
  if (c.keyframes && Object.keys(c.keyframes).length) {
    const [L, R] = splitKeyframeMap(c.keyframes, local);
    c.keyframes = L; r.keyframes = R;
  }
  if (c.type === 'caption' && c.caption) {
    const words = c.caption.words || [];
    c.caption.words = words.filter((w) => w.s < at - 1e-6).map((w) => ({ ...w }));
    r.caption.words = words.filter((w) => w.s >= at - 1e-6).map((w) => ({ ...w }));
    syncCaptionText(c); syncCaptionText(r);
    if (r.caption.words.length) r.name = r.text.content.slice(0, 60);
    if (c.caption.words.length) c.name = c.text.content.slice(0, 60);
  }
  if (c.fadeOut !== undefined) { c.fadeOut = 0; r.fadeIn = 0; clampFades(c); clampFades(r); }
  if (c.transitionOut) {
    r.transitionOut = clone(c.transitionOut);
    c.transitionOut = { id: 'none', duration: c.transitionOut.duration ?? 0.5, params: {} };
  }
  if (c.animIn) r.animIn = { ...c.animIn, id: 'none' };
  if (c.animOut) c.animOut = { ...c.animOut, id: 'none' };
  if (c.textAnim) { c.textAnim = { ...c.textAnim, out: 'none' }; r.textAnim = { ...r.textAnim, in: 'none' }; }
  if (c.animLoop && c.animLoop.id && c.animLoop.id !== 'none') {
    const off = Number(c.animLoop.offset) || 0;
    const span = Number(c.animLoop.span) > 0 ? Number(c.animLoop.span) : oldDur + off;
    c.animLoop = { ...c.animLoop, span: round6(span) };
    r.animLoop = { ...r.animLoop, span: round6(span), offset: round6(off + local) };
  }
  P.clips[r.id] = r;
  return r;
}

/** Remove [s,e) from a track: delete clips inside, trim partial ones, split spanning ones. */
function clearRange(P, trackId, s, e, exclude, X) {
  for (const c of clipsOnTrack(P, trackId)) {
    if (exclude && exclude.has(c.id)) continue;
    const cs = c.start, ce = clipEnd(c);
    if (!overlaps(s, e, cs, ce)) continue;
    if (cs >= s - EPS && ce <= e + EPS) { delete P.clips[c.id]; continue; }
    if (cs < s - EPS && ce > e + EPS) {
      const r = splitInternal(P, c, e);
      trimTailInternal(c, s);
      void r;
      continue;
    }
    if (cs < s - EPS) trimTailInternal(c, s);
    else trimHeadInternal(c, e);
  }
  if (X) X.warn(`נדרס התוכן בערוץ בין ${fmt(s)} ל-${fmt(e)}`);
}

/** Open `dur` seconds at `at` on one track: split a clip spanning `at` and push everything after. */
function insertSpaceOnTrack(P, trackId, at, dur, exclude, X) {
  for (const c of clipsOnTrack(P, trackId)) {
    if (exclude && exclude.has(c.id)) continue;
    if (c.start < at - EPS && clipEnd(c) > at + EPS) splitInternal(P, c, at);
  }
  for (const c of clipsOnTrack(P, trackId)) {
    if (exclude && exclude.has(c.id)) continue;
    if (c.start >= at - EPS) shiftClip(c, dur);
  }
  if (X) X.warn(`נפתח רווח של ${fmt(dur)} שנ' בערוץ ב-${fmt(at)}`);
}

// ───────────────────────────── value validation for updateClip ─────────────────────────────

const OBJECT_SHORTHANDS = {
  text: 'content', sticker: 'value', filter: 'id', transitionOut: 'id', animIn: 'id', animOut: 'id', animLoop: 'id',
  lut: 'file', mask: 'type', shape: 'kind', caption: 'style', textAnim: 'in',
};

function coerceLike(existing, value) {
  if (typeof existing === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (typeof existing === 'boolean' && typeof value === 'string') {
    if (/^(true|1|yes|כן)$/i.test(value)) return true;
    if (/^(false|0|no|לא)$/i.test(value)) return false;
  }
  if (typeof existing === 'boolean' && typeof value === 'number') return value !== 0;
  return value;
}

function clampWarn(X, path, v, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`הערך של ${path} חייב להיות מספר (התקבל ${JSON.stringify(v)})`);
  const c = clamp(v, lo, hi);
  if (c !== v) X.warn(`${path}: הערך ${v} הוגבל ל-${c}`);
  return c;
}

function validateClipValue(P, c, path, value, X) {
  const cat = X.cat;
  const fd = frameOf(P);
  switch (path) {
    case 'start': return Math.max(0, resolveTime(P, value));
    case 'duration': return clampWarn(X, path, Number(value), fd, 86400);
    case 'in': return clampWarn(X, path, Number(value), 0, 86400);
    case 'speed': return clampWarn(X, path, Number(value), 0.05, 100);
    case 'volume': return clampWarn(X, path, Number(value), 0, 4);
    case 'pan': return clampWarn(X, path, Number(value), -1, 1);
    case 'fadeIn': case 'fadeOut': return clampWarn(X, path, Number(value), 0, c.duration);
    case 'transform.opacity': return clampWarn(X, path, Number(value), 0, 1);
    case 'filter.amount': case 'lut.amount': return clampWarn(X, path, Number(value), 0, 1);
    case 'blend': if (!BLEND_MODES.includes(value)) fail(`מצב מיזוג לא מוכר: "${value}" (${BLEND_MODES.join(', ')})`); return value;
    case 'fit': if (!FIT_MODES.includes(value)) fail(`התאמה לא מוכרת: "${value}" (${FIT_MODES.join(', ')})`); return value;
    case 'mask.type': if (!MASK_TYPES.includes(value)) fail(`סוג מסכה לא מוכר: "${value}" (${MASK_TYPES.join(', ')})`); return value;
    case 'shape.kind': if (!SHAPE_KINDS.includes(value) && !shapePreset(X, value)) badShape(X, value); return value;
    case 'animIn.id': case 'animOut.id': case 'animLoop.id': {
      const kind = path.startsWith('animIn') ? 'in' : path.startsWith('animOut') ? 'out' : 'loop';
      if (!CLIP_ANIM_IDS[kind].includes(value)) fail(`אנימציית ${kind} לא מוכרת: "${value}". קיימות: ${CLIP_ANIM_IDS[kind].join(', ')}`);
      return value;
    }
    case 'animIn.duration': case 'animOut.duration': return clampWarn(X, path, Number(value), 0, Math.max(0, c.duration));
    case 'filter.id': {
      if (value !== 'none' && cat && cat.loaded && cat.filters && cat.filters.length && !cat.filters.some((f) => f.id === value)) {
        fail(`פילטר לא מוכר: "${value}". קיימים: ${cat.filters.map((f) => f.id).join(', ')}`);
      }
      return value;
    }
    case 'transitionOut.id': {
      if (value !== 'none' && cat && cat.loaded && cat.transitions && cat.transitions.length && !cat.transitions.some((f) => f.id === value)) {
        fail(`מעבר לא מוכר: "${value}". קיימים: ${cat.transitions.map((f) => f.id).join(', ')}`);
      }
      return value;
    }
    case 'caption.words': return parseWords(value, P);
    default: break;
  }
  if (/^color\./.test(path) && COLOR_KEYS.includes(path.slice(6))) {
    return path === 'color.hue' ? clampWarn(X, path, Number(value), -180, 180) : clampWarn(X, path, Number(value), -1, 1);
  }
  if (/^crop\.[ltrb]$/.test(path)) return clampWarn(X, path, Number(value), 0, 0.95);
  if (/^mask\.(w|h)$/.test(path)) return clampWarn(X, path, Number(value), 0, 4);
  return value;
}

function applySet(P, c, path0, value0, X) {
  let path = String(path0);
  let value = value0;
  if (path === 'id' || path === 'type') fail(`לא ניתן לשנות את השדה "${path}" של קליפ`);
  if (path === 'color' && typeof value === 'string') path = 'tint';
  const existing0 = getPath(c, path);
  if (isPlainObject(existing0) && (typeof value !== 'object' || value === null) && OBJECT_SHORTHANDS[path]) {
    path = `${path}.${OBJECT_SHORTHANDS[path]}`;
  } else if (isPlainObject(existing0) && (typeof value !== 'object' || value === null) && value !== null) {
    fail(`השדה "${path}" הוא אובייקט — הגדר שדה פנימי (למשל ${path}.${Object.keys(existing0)[0] || 'x'})`);
  }
  if (path === 'trackId' || path === 'track') {
    const t = requireTrack(P, value);
    if ((c.type === 'audio') !== (t.kind === 'audio')) fail(`לא ניתן להעביר ${CLIP_TYPE_LABELS[c.type]} לערוץ ${TRACK_KIND_LABELS[t.kind]}`);
    c.trackId = t.id;
    return;
  }
  const existing = getPath(c, path);
  value = coerceLike(existing, value);
  value = validateClipValue(P, c, path, value, X);
  if (path === 'start') { shiftClip(c, value - c.start); return; }
  if (path === 'shape.kind' && !SHAPE_KINDS.includes(value)) {
    const preset = shapePreset(X, value);
    c.shape = deepMerge(c.shape || {}, clone(preset.shape || {}));
    if (!c.shape.kind) c.shape.kind = preset.kind;
    return;
  }
  if (path === 'sticker.value' && c.type === 'sticker') {
    const r = resolveSticker(X, value);
    c.sticker = { ...(c.sticker || {}), kind: r.kind, value: r.value };
    return;
  }
  if (isPlainObject(existing) && isPlainObject(value)) value = deepMerge(existing, value);
  if (isTimedMedia(c) && (path === 'duration' || path === 'in' || path === 'speed')) {
    const media = P.media[c.mediaId];
    const probe = { ...c, [path]: value };
    const max = maxClipDuration(probe, media);
    if (Number.isFinite(max) && probe.duration > max + 1e-3) {
      if (path === 'duration') { X.warn(`המשך הוגבל לאורך המדיה (${fmt(max)} שנ')`); value = round6(max); }
      else { X.warn(`המשך קוצר ל-${fmt(max)} שנ' כדי לא לחרוג מהמדיה`); c.duration = round6(Math.max(frameOf(P), max)); }
    }
  }
  setPathMut(c, path, value);
  if (path.startsWith('caption.words') || path === 'caption') syncCaptionText(c);
  if (path === 'duration' || path === 'fadeIn' || path === 'fadeOut') clampFades(c);
}

// ───────────────────────────── clip props from addClip-like ops ─────────────────────────────

const META_KEYS = new Set(['op', 'track', 'role', 'overlap', 'path', 'set', 'merge', 'append', 'at', 'preset', 'force', 'newId',
  'end', 'words', 'hot', 'style', 'content', 'value', 'kind', 'effect', 'params', 'x', 'y', 'scale', 'rotation', 'opacity',
  'gain_db', 'gainDb', 'fade', 'from', 'sound', 'len', 'resolved', 'clip', 'type', 'id', 'start', 'xAbs', 'yAbs']);

function catList(X, key) { return X && X.cat && Array.isArray(X.cat[key]) ? X.cat[key] : []; }

/** Sticker reference → {kind, value, name}: catalog id ("emoji-fire", "builtin-arrow"), builtin value, or a raw emoji. */
function resolveSticker(X, ref) {
  const list = catList(X, 'stickers');
  const v = String(ref);
  const hit = list.find((s) => s && s.id === v) || list.find((s) => s && s.kind === 'builtin' && s.value === v);
  if (hit) return { kind: hit.kind, value: hit.value, name: hit.name };
  if (/^builtin-/.test(v)) return { kind: 'builtin', value: v.slice(8) };
  if (/^emoji-/.test(v)) fail(`המדבקה "${v}" לא נמצאה בקטלוג — שלח את האימוג'י עצמו (למשל "🔥") או מזהה מ-cutx catalog stickers`);
  return { kind: /^[a-z0-9][a-z0-9-]*$/i.test(v) ? 'builtin' : 'emoji', value: v };
}

function shapePreset(X, id) { return catList(X, 'shapes').find((s) => s && s.id === id) || null; }

function badShape(X, kind) {
  const presets = catList(X, 'shapes').map((s) => s.id);
  fail(`צורה לא מוכרת: "${kind}". צורות: ${SHAPE_KINDS.join(', ')}${presets.length ? ` · סגנונות: ${presets.join(', ')}` : ''}`);
}

function clipPropsFromOp(type, op, X) {
  const props = {};
  for (const [k, v] of Object.entries(op)) if (!META_KEYS.has(k) && v !== undefined) props[k] = v;
  if (op.clip && isPlainObject(op.clip)) Object.assign(props, deepMerge(op.clip, props));
  if (typeof props.text === 'string') props.text = { content: props.text };
  if (op.content !== undefined) props.text = { ...(props.text || {}), content: String(op.content) };
  if (typeof props.filter === 'string') props.filter = { id: props.filter, amount: 1 };
  if (typeof props.lut === 'string') props.lut = { file: props.lut, amount: 1 };
  for (const k of ['animIn', 'animOut', 'animLoop']) if (typeof props[k] === 'string') props[k] = { id: props[k] };
  if (typeof props.transitionOut === 'string') props.transitionOut = { id: props.transitionOut };
  if (typeof props.mask === 'string') props.mask = { type: props.mask };
  const tr = {};
  for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) if (op[k] !== undefined) tr[k] = num(op[k], 0, k);
  if (Object.keys(tr).length) props.transform = { ...(props.transform || {}), ...tr };
  if (op.gain_db !== undefined || op.gainDb !== undefined) props.volume = dbToGain(num(op.gain_db ?? op.gainDb, 0));
  if (op.fade !== undefined && AUDIO_CAPABLE_TYPES.has(type)) props.fadeOut = num(op.fade, 0, 'fade');
  if (op.from !== undefined && MEDIA_TYPES.has(type)) props.in = num(op.from, 0, 'from');
  if (type === 'sticker') {
    const st = typeof props.sticker === 'string' ? { value: props.sticker } : { ...(props.sticker || {}) };
    const explicitKind = op.kind !== undefined ? op.kind : st.kind;
    if (op.value !== undefined) st.value = String(op.value);
    const ref = op.preset !== undefined ? op.preset : st.value;
    if (ref !== undefined) {
      const r = resolveSticker(X, ref);
      const isCatalogId = op.preset !== undefined || /^(builtin|emoji)-/.test(String(ref));
      st.kind = explicitKind && !isCatalogId ? explicitKind : r.kind;
      st.value = r.value;
      if (!props.name && r.name) props.name = r.name;
    } else if (explicitKind) st.kind = explicitKind;
    props.sticker = st;
  }
  if (type === 'shape') {
    let sh = typeof props.shape === 'string' ? { kind: props.shape } : { ...(props.shape || {}) };
    if (op.kind !== undefined) sh.kind = op.kind;
    const ref = op.preset !== undefined ? op.preset : sh.kind;
    if (ref !== undefined && (op.preset !== undefined || !SHAPE_KINDS.includes(String(ref)))) {
      const preset = shapePreset(X, String(ref));
      if (!preset) badShape(X, ref);
      const own = { ...sh };
      if (op.preset === undefined) delete own.kind;
      sh = deepMerge(clone(preset.shape || {}), own);
      if (!sh.kind) sh.kind = preset.kind;
      if (!props.name && preset.name) props.name = preset.name;
    }
    if (sh.kind !== undefined && !SHAPE_KINDS.includes(sh.kind)) badShape(X, sh.kind);
    props.shape = sh;
  }
  if ((type === 'effect' || type === 'adjustment') && op.effect !== undefined) {
    const list = asList(op.effect).map((e) => (typeof e === 'string' ? { id: e, params: { ...(op.params || {}) }, enabled: true } : { enabled: true, params: {}, ...e }));
    props.effects = [...(props.effects || []), ...list];
  }
  return props;
}

function validateAnimIds(c) {
  for (const [field, kind] of [['animIn', 'in'], ['animOut', 'out'], ['animLoop', 'loop']]) {
    if (c[field] && c[field].id && !CLIP_ANIM_IDS[kind].includes(c[field].id)) {
      fail(`אנימציית ${kind} לא מוכרת: "${c[field].id}". קיימות: ${CLIP_ANIM_IDS[kind].join(', ')}`);
    }
  }
}

function fillEffectDefaults(fx, X) {
  const cat = X.cat;
  if (!cat || !cat.loaded || !Array.isArray(cat.effects) || !cat.effects.length) return fx;
  const def = cat.effects.find((e) => e.id === fx.id);
  if (!def) fail(`אפקט לא מוכר: "${fx.id}". קיימים: ${cat.effects.map((e) => e.id).join(', ')}`);
  const params = {};
  for (const p of def.params || []) if (p && p.key !== undefined && p.default !== undefined) params[p.key] = p.default;
  return { ...fx, params: { ...params, ...(fx.params || {}) } };
}

function applyTextPreset(props, presetId, X) {
  const list = X.cat && Array.isArray(X.cat.textPresets) ? X.cat.textPresets : [];
  const p = list.find((x) => x && x.id === presetId);
  if (!p) {
    if (list.length) fail(`סגנון טקסט לא מוכר: "${presetId}". קיימים: ${list.map((x) => x.id).join(', ')}`);
    X.warn(`קטלוג סגנונות הטקסט לא נטען — הסגנון "${presetId}" לא הוחל`);
    return props;
  }
  const out = { ...props };
  out.text = deepMerge(p.text || {}, props.text || {});
  if (p.textAnim) out.textAnim = deepMerge(p.textAnim, props.textAnim || {});
  for (const k of ['transform', 'animIn', 'animOut', 'animLoop', 'effects']) if (p[k] && props[k] === undefined) out[k] = clone(p[k]);
  return out;
}

// ───────────────────────────── op handlers ─────────────────────────────

const H = {};

H.setSettings = (P, op, X) => {
  const set = op.set || {};
  if (!isPlainObject(set)) fail('setSettings: set חייב להיות אובייקט');
  for (const [k, v0] of Object.entries(set)) {
    let v = v0;
    switch (k) {
      case 'width': case 'height': {
        v = Math.round(num(v, undefined, k));
        if (v < 16 || v > 8192) fail(`${k} חייב להיות בין 16 ל-8192`);
        if (v % 2) { v += 1; X.warn(`${k} עוגל למספר זוגי (${v}) — נדרש לייצוא H.264`); }
        break;
      }
      case 'fps': v = num(v, undefined, k); if (!(v > 0 && v <= 240)) fail('fps חייב להיות בין 1 ל-240'); break;
      case 'sampleRate': v = Math.round(num(v, undefined, k)); if (![22050, 32000, 44100, 48000, 88200, 96000].includes(v)) fail('sampleRate לא נתמך'); break;
      case 'safeArea': if (!SAFE_AREAS.includes(v)) fail(`safeArea חייב להיות אחד מ: ${SAFE_AREAS.join(', ')}`); break;
      case 'masterGainDb': v = clamp(num(v, undefined, k), -48, 24); break;
      case 'targetLufs': v = clamp(num(v, undefined, k), -40, -5); break;
      case 'background': if (typeof v !== 'string') fail('background חייב להיות צבע (#rrggbb)'); break;
      default: X.warn(`הגדרה לא מוכרת "${k}" נשמרה כמו שהיא`);
    }
    P.settings[k] = v;
  }
  return {};
};

H.renameProject = (P, op) => {
  const name = String(op.name ?? '').trim();
  if (!name) fail('renameProject: חסר name');
  P.name = name;
  return {};
};

H.addTrack = (P, op) => {
  const kind = op.kind || kindForRole(op.role || 'overlay');
  if (!TRACK_KINDS.includes(kind)) fail(`סוג ערוץ לא מוכר: "${kind}" (video | audio)`);
  const t = createTrack(P, { kind, role: op.role, name: op.name, index: op.index, captions: !!op.captions, id: op.id });
  for (const k of ['hidden', 'muted', 'locked', 'solo']) if (op[k] !== undefined) t[k] = !!op[k];
  if (op.volume !== undefined) t.volume = clamp(num(op.volume, 1), 0, 4);
  return { id: t.id, index: P.tracks.indexOf(t) };
};

H.updateTrack = (P, op, X) => {
  const t = requireTrack(P, op.id);
  const set = op.set || {};
  for (const [k, v0] of Object.entries(set)) {
    let v = v0;
    switch (k) {
      case 'name': v = String(v); if (!v.trim()) fail('שם ערוץ ריק'); break;
      case 'hidden': case 'muted': case 'locked': case 'solo': case 'captions': v = coerceLike(false, v); if (typeof v !== 'boolean') fail(`${k} חייב להיות true/false`); break;
      case 'volume': v = clamp(num(v, undefined, k), 0, 4); break;
      case 'height': v = clamp(num(v, undefined, k), 16, 400); break;
      case 'role': {
        const ok = t.kind === 'audio' ? AUDIO_ROLES : VIDEO_ROLES;
        if (!ok.includes(v)) fail(`התפקיד "${v}" לא מתאים לערוץ ${TRACK_KIND_LABELS[t.kind]} (${ok.join(', ')})`);
        break;
      }
      case 'kind': {
        if (v !== t.kind) {
          if (clipsOnTrack(P, t.id).length) fail('לא ניתן לשנות סוג של ערוץ שיש בו קליפים');
          if (!TRACK_KINDS.includes(v)) fail('kind חייב להיות video או audio');
          t.role = v === 'audio' ? 'sfx' : 'overlay';
        }
        break;
      }
      case 'id': fail('לא ניתן לשנות מזהה ערוץ');
      default: X.warn(`שדה ערוץ לא מוכר "${k}" נשמר`);
    }
    t[k] = v;
  }
  return { id: t.id };
};

H.removeTrack = (P, op) => {
  const t = requireTrack(P, op.id);
  const removed = [];
  for (const c of Object.values(P.clips)) if (c.trackId === t.id) { delete P.clips[c.id]; removed.push(c.id); }
  P.tracks.splice(P.tracks.indexOf(t), 1);
  return { id: t.id, ids: removed };
};

H.moveTrack = (P, op) => {
  const t = requireTrack(P, op.id);
  const from = P.tracks.indexOf(t);
  P.tracks.splice(from, 1);
  const to = clamp(Math.trunc(num(op.index, 0, 'index')), 0, P.tracks.length);
  P.tracks.splice(to, 0, t);
  return { id: t.id, index: to };
};

H.addMedia = (P, op) => {
  const list = asList(op.media);
  if (!list.length) fail('addMedia: חסר media');
  const ids = [];
  for (const m of list) {
    if (!m || !m.id || !['video', 'image', 'audio'].includes(m.kind)) fail('addMedia: מדיה חייבת id ו-kind (video|image|audio)');
    P.media[m.id] = deepMerge(P.media[m.id] || {}, m);
    ids.push(m.id);
  }
  return { ids, id: ids[0] };
};

H.updateMedia = (P, op) => {
  const m = P.media[op.id];
  if (!m) fail(`המדיה "${op.id}" לא נמצאה`);
  for (const [k, v] of Object.entries(op.set || {})) { if (k === 'id') fail('לא ניתן לשנות מזהה מדיה'); setPathMut(m, k, v); }
  return { id: m.id };
};

H.removeMedia = (P, op) => {
  const m = P.media[op.id];
  if (!m) fail(`המדיה "${op.id}" לא נמצאה`);
  const users = Object.values(P.clips).filter((c) => c.mediaId === m.id);
  if (users.length && op.clips === false) fail(`המדיה בשימוש ב-${users.length} קליפים`);
  for (const c of users) delete P.clips[c.id];
  delete P.media[m.id];
  return { id: m.id, ids: users.map((c) => c.id) };
};

function buildClip(P, op, X, typeOverride) {
  let type = typeOverride || op.type;
  let media = null;
  if (op.mediaId) media = mediaById(P, X, op.mediaId);
  else if (op.path) media = mediaByPath(P, X, op.path);
  if (!type && media) type = media.kind;
  if (!type) fail('addClip: חסר type (video|image|audio|text|caption|shape|sticker|effect|adjustment)');
  if (!CLIP_TYPES.includes(type)) fail(`סוג קליפ לא מוכר: "${type}" (${CLIP_TYPES.join(', ')})`);
  if (MEDIA_TYPES.has(type)) {
    if (!media) fail(`קליפ ${CLIP_TYPE_LABELS[type]} צריך mediaId או path`);
    if (type === 'video' && media.kind !== 'video') fail(`המדיה "${media.name}" היא ${media.kind}, לא וידאו`);
    if (type === 'image' && media.kind !== 'image') fail(`המדיה "${media.name}" היא ${media.kind}, לא תמונה`);
    if (type === 'audio' && !(media.kind === 'audio' || media.hasAudio)) fail(`למדיה "${media.name}" אין שמע`);
  }
  let props = clipPropsFromOp(type, op, X);
  if (type === 'text' && op.preset) props = applyTextPreset(props, op.preset, X);
  if (media) props.mediaId = media.id;
  const id = uniqueId((x) => !!P.clips[x], op.id, 'c_');
  const clip = newClip(type, { ...props, id }, { media, settings: P.settings });
  validateAnimIds(clip);
  if (clip.transform && op.xAbs !== undefined) clip.transform.x = num(op.xAbs, 0, 'xAbs') - P.settings.width / 2;
  if (clip.transform && op.yAbs !== undefined) clip.transform.y = num(op.yAbs, 0, 'yAbs') - P.settings.height / 2;
  // timing
  let start = op.start !== undefined ? op.start : op.at;
  clip.start = start === undefined ? 0 : Math.max(0, resolveTime(P, start));
  if (MEDIA_TYPES.has(type)) {
    clip.speed = clampWarn(X, 'speed', num(clip.speed, 1), 0.05, 100);
    clip.in = Math.max(0, num(clip.in, 0));
    if (isTimedMedia(clip) && media.duration > 0 && clip.in >= media.duration) fail(`נקודת הכניסה ${fmt(clip.in)} אחרי סוף המדיה (${fmt(media.duration)})`);
  }
  // caption words
  if (type === 'caption') {
    let words = op.words !== undefined ? parseWords(op.words, P) : (clip.caption.words || []).length ? parseWords(clip.caption.words, P) : null;
    const style = op.style || clip.caption.style || 'karaoke';
    const sd = captionStyleDefaults(style, X);
    clip.text = deepMerge(deepMerge(DEFAULT_TEXT(), sd.text || {}), clipPropsFromOp(type, op, X).text || {});
    clip.caption.style = style;
    if (op.caption?.activeColor === undefined && sd.activeColor) clip.caption.activeColor = sd.activeColor;
    if (op.caption?.hotColor === undefined && sd.hotColor) clip.caption.hotColor = sd.hotColor;
    if (!words) {
      const content = String(op.content ?? (typeof op.text === 'string' ? op.text : op.text?.content) ?? '').trim();
      if (!content) fail('כתובית צריכה words או text');
      const toks = content.split(/\s+/);
      const dur = op.duration !== undefined ? num(op.duration, 2) : Math.max(1, toks.length * 0.35);
      words = toks.map((w, i) => ({ w, s: round6(clip.start + (dur * i) / toks.length), e: round6(clip.start + (dur * (i + 1)) / toks.length), hot: false }));
    }
    const hot = new Set(asList(op.hot).flatMap((h) => String(h).split(/\s+/)).map(normalizeWord).filter(Boolean));
    for (const w of words) if (hot.has(normalizeWord(w.w))) w.hot = true;
    clip.caption.words = words;
    if (start === undefined && words.length) clip.start = words[0].s;
    syncCaptionText(clip);
    if (!op.name) clip.name = clip.text.content.slice(0, 60);
    if (op.duration === undefined && op.end === undefined && words.length) clip.duration = round6(Math.max(frameOf(P), words[words.length - 1].e + 0.4 - clip.start));
  }
  // duration
  if (op.end !== undefined) clip.duration = round6(resolveTime(P, op.end) - clip.start);
  else if (op.duration !== undefined) clip.duration = num(op.duration, undefined, 'duration');
  else if (type !== 'caption') {
    if (isTimedMedia(clip) && media.duration > 0) clip.duration = round6((media.duration - clip.in) / clip.speed);
    else clip.duration = TYPE_DEFAULT_DURATION[type];
  }
  if (!(clip.duration >= frameOf(P) - 1e-9)) fail(`משך לא תקין: ${clip.duration} (מינימום פריים אחד)`);
  if (isTimedMedia(clip) && media.duration > 0) {
    const max = maxClipDuration(clip, media);
    if (clip.duration > max + 1e-3) { X.warn(`המשך קוצר לאורך המדיה (${fmt(max)} שנ')`); clip.duration = round6(max); }
  }
  clip.duration = round6(clip.duration);
  clampFades(clip);
  if (!clip.name) clip.name = media ? media.name : type === 'text' ? String(clip.text.content).slice(0, 60) : CLIP_TYPE_LABELS[type];
  if (clip.effects && clip.effects.length) clip.effects = clip.effects.map((fx) => fillEffectDefaults(fx, X));
  return { clip, media };
}

H.addClip = (P, op, X) => {
  const { clip } = buildClip(P, op, X);
  if (op.append) {
    // place at the end of the target track (auto/main when not given)
    const probe = findTrack(P, op.track) || tracksForRole(P, op.role || defaultRoleForType(clip.type))[0];
    if (probe) { const list = clipsOnTrack(P, probe.id); if (list.length) clip.start = round6(clipEnd(list[list.length - 1])); }
  }
  const t = placeClip(P, clip, { track: op.track, role: op.role, overlap: op.overlap, force: op.force }, X);
  clip.trackId = t.id;
  P.clips[clip.id] = clip;
  if (op.set && isPlainObject(op.set)) for (const [k, v] of Object.entries(op.set)) applySet(P, clip, k, v, X);
  return { id: clip.id, track: t.id, start: clip.start, duration: clip.duration };
};

H.sfx = (P, op, X) => {
  const media = resolveSoundMedia(P, op, X);
  const at = resolveTime(P, op.at ?? op.start ?? 0);
  const from = Math.max(0, num(op.from ?? op.in, 0, 'from'));
  if (media.duration > 0 && from >= media.duration) fail(`from (${fmt(from)}) אחרי סוף הצליל (${fmt(media.duration)})`);
  let dur = op.len ?? op.duration;
  dur = dur !== undefined ? num(dur, undefined, 'len') : media.duration > 0 ? media.duration - from : 2;
  if (media.duration > 0 && dur > media.duration - from + 1e-3) { X.warn(`len קוצר לאורך הצליל (${fmt(media.duration - from)} שנ')`); dur = media.duration - from; }
  if (dur < frameOf(P)) fail('len קצר מדי');
  const volume = op.gain_db !== undefined || op.gainDb !== undefined ? dbToGain(num(op.gain_db ?? op.gainDb, 0)) : num(op.volume, 1);
  if (volume > 4) X.warn('העוצמה הוגבלה ל-+12 dB');
  const id = uniqueId((x) => !!P.clips[x], op.id, 'c_');
  const clip = newClip('audio', {
    id, name: op.name || op.cue || media.name, start: Math.max(0, at), duration: round6(dur), mediaId: media.id, in: round6(from),
    volume: clamp(volume, 0, 4), fadeOut: num(op.fade ?? op.fadeOut, 0), fadeIn: num(op.fadeIn, 0), pan: clamp(num(op.pan, 0), -1, 1),
  });
  clampFades(clip);
  const t = placeClip(P, clip, { track: op.track, role: op.role || 'sfx', overlap: op.overlap, force: op.force }, X);
  clip.trackId = t.id;
  P.clips[clip.id] = clip;
  return { id: clip.id, track: t.id, mediaId: media.id, start: clip.start, duration: clip.duration };
};

H.updateClip = (P, op, X) => {
  const ids = op.ids ? asList(op.ids) : asList(op.id);
  if (!ids.length) fail('updateClip: חסר id');
  if (!op.set && !op.merge) fail('updateClip: חסר set או merge');
  for (const id of ids) {
    const c = getClip(P, id);
    checkLocked(P, c, op);
    if (op.merge) {
      if (!isPlainObject(op.merge)) fail('merge חייב להיות אובייקט');
      const m = { ...op.merge };
      for (const k of ['id', 'type', 'trackId']) delete m[k];
      if (typeof m.color === 'string') { m.tint = m.color; delete m.color; }
      const startDelta = m.start !== undefined ? Math.max(0, resolveTime(P, m.start)) - c.start : 0;
      delete m.start;
      const merged = deepMerge(c, m);
      Object.assign(c, merged);
      if (startDelta) shiftClip(c, startDelta);
      validateAnimIds(c);
      if (c.type === 'caption') { c.caption.words = parseWords(c.caption.words, P); syncCaptionText(c); }
      clampFades(c);
    }
    if (op.set) {
      if (!isPlainObject(op.set)) fail('set חייב להיות אובייקט {"נתיב": ערך}');
      for (const [k, v] of Object.entries(op.set)) applySet(P, c, k, v, X);
    }
  }
  return { id: ids[0], ids };
};

H.removeClip = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const end = clipEnd(c), dur = c.duration, tid = c.trackId;
  delete P.clips[c.id];
  if (op.ripple) for (const o of clipsOnTrack(P, tid)) if (o.start >= end - EPS) shiftClip(o, -dur);
  return { id: c.id };
};

H.removeClips = (P, op) => {
  const ids = asList(op.ids ?? op.id);
  if (!ids.length) fail('removeClips: חסר ids');
  const clips = ids.map((id) => getClip(P, id));
  for (const c of clips) checkLocked(P, c, op);
  clips.sort((a, b) => b.start - a.start);
  for (const c of clips) {
    const end = clipEnd(c), dur = c.duration, tid = c.trackId;
    delete P.clips[c.id];
    if (op.ripple) for (const o of clipsOnTrack(P, tid)) if (o.start >= end - EPS) shiftClip(o, -dur);
  }
  return { ids };
};

H.moveClip = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  let start = op.start !== undefined ? op.start : op.at;
  let newStart = start === undefined ? c.start : resolveTime(P, start);
  if (op.by !== undefined) newStart = c.start + num(op.by, 0, 'by');
  if (newStart < 0) { X.warn('זמן ההתחלה הוגבל ל-0'); newStart = 0; }
  const oldTrack = c.trackId;
  const probe = { ...c, start: round6(newStart) };
  const target = op.track !== undefined ? op.track : oldTrack;
  const t = placeClip(P, probe, { track: target, overlap: op.overlap, force: op.force, exclude: [c.id] }, X);
  shiftClip(c, round6(newStart) - c.start);
  c.trackId = t.id;
  return { id: c.id, track: t.id, start: c.start };
};

H.moveClips = (P, op, X) => {
  const ids = asList(op.ids);
  if (!ids.length) fail('moveClips: חסר ids');
  const clips = ids.map((id) => getClip(P, id));
  for (const c of clips) checkLocked(P, c, op);
  const minStart = Math.min(...clips.map((c) => c.start));
  let delta;
  if (op.delta !== undefined) delta = num(op.delta, 0, 'delta');
  else if (op.start !== undefined) delta = resolveTime(P, op.start) - minStart;
  else delta = 0;
  if (minStart + delta < 0) { X.warn('ההזזה הוגבלה כדי שלא יתחילו לפני 0'); delta = -minStart; }
  let trackMap = null;
  if (op.trackDelta) {
    const td = Math.trunc(num(op.trackDelta, 0));
    trackMap = new Map();
    for (const c of clips) {
      const idx = P.tracks.findIndex((t) => t.id === c.trackId);
      const t2 = P.tracks[idx + td];
      if (!t2 || (t2.kind === 'audio') !== (c.type === 'audio')) fail('לא ניתן להזיז את הקליפים לערוץ מסוג אחר');
      trackMap.set(c.id, t2.id);
    }
  }
  for (const c of clips) {
    shiftClip(c, delta);
    if (trackMap) c.trackId = trackMap.get(c.id);
  }
  return { ids };
};

H.trimClip = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const fd = frameOf(P);
  const media = MEDIA_TYPES.has(c.type) ? P.media[c.mediaId] : null;
  let s = op.start !== undefined ? resolveTime(P, op.start) : c.start;
  if (op.head !== undefined) s = c.start + num(op.head, 0, 'head');
  let e;
  if (op.end !== undefined) e = resolveTime(P, op.end);
  else if (op.duration !== undefined) e = s + num(op.duration, undefined, 'duration');
  else e = clipEnd(c);
  if (op.tail !== undefined) e = clipEnd(c) - num(op.tail, 0, 'tail');
  if (s < 0) { X.warn('ההתחלה הוגבלה ל-0'); s = 0; }
  // media bounds
  if (isTimedMedia(c) && media && media.duration > 0) {
    const sp = c.speed > 0 ? c.speed : 1;
    if (!c.reverse) {
      const minStart = c.start - (c.in || 0) / sp;
      if (s < minStart - 1e-6) { X.warn(`ההתחלה הוגבלה לתחילת המדיה (${fmt(minStart)})`); s = minStart; }
      const newIn = (c.in || 0) + (s - c.start) * sp;
      const maxEnd = s + (media.duration - newIn) / sp;
      if (e > maxEnd + 1e-6) { X.warn(`הסוף הוגבל לסוף המדיה (${fmt(maxEnd)})`); e = maxEnd; }
    } else {
      const maxEnd = clipEnd(c) + (c.in || 0) / sp;
      if (e > maxEnd + 1e-6) { X.warn(`הסוף הוגבל לתחילת המדיה (הפוך) (${fmt(maxEnd)})`); e = maxEnd; }
      const newIn = (c.in || 0) + (clipEnd(c) - e) * sp;
      const minStart = e - (media.duration - newIn) / sp;
      if (s < minStart - 1e-6) { X.warn(`ההתחלה הוגבלה לסוף המדיה (הפוך) (${fmt(minStart)})`); s = minStart; }
    }
  }
  // neighbours: never extend into the previous/next clip on the same track unless overlap:"allow"
  if (op.overlap !== 'allow') {
    for (const o of clipsOnTrack(P, c.trackId)) {
      if (o.id === c.id) continue;
      if (clipEnd(o) <= c.start + EPS && s < clipEnd(o) - EPS) { X.warn(`ההתחלה הוגבלה לסוף הקליפ הקודם (${fmt(clipEnd(o))})`); s = clipEnd(o); }
      if (o.start >= clipEnd(c) - EPS && e > o.start + EPS) { X.warn(`הסוף הוגבל לתחילת הקליפ הבא (${fmt(o.start)})`); e = o.start; }
    }
  }
  if (e - s < fd - 1e-9) fail(`אחרי החיתוך הקליפ קצר מפריים אחד (${fmt(s)}–${fmt(e)})`);
  trimHeadInternal(c, round6(s));
  trimTailInternal(c, round6(e));
  return { id: c.id, start: c.start, end: round6(clipEnd(c)), in: c.in };
};

H.slipClip = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  if (!isTimedMedia(c)) fail('slipClip אפשרי רק לוידאו ואודיו');
  const media = P.media[c.mediaId];
  let nin = op.in !== undefined ? num(op.in, 0, 'in') : (c.in || 0) + num(op.by, 0, 'by');
  const sp = c.speed > 0 ? c.speed : 1;
  const maxIn = media && media.duration > 0 ? Math.max(0, media.duration - c.duration * sp) : Infinity;
  const cl = clamp(nin, 0, maxIn);
  if (cl !== nin) X.warn(`נקודת הכניסה הוגבלה ל-${fmt(cl)}`);
  c.in = round6(cl);
  return { id: c.id, in: c.in };
};

H.splitClip = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const at = resolveTime(P, op.at ?? op.t);
  const fd = frameOf(P);
  if (!(at > c.start + fd / 2 - 1e-9 && at < clipEnd(c) - fd / 2 + 1e-9)) fail(`זמן הפיצול ${fmt(at)} לא בתוך הקליפ (${fmt(c.start)}–${fmt(clipEnd(c))})`);
  const r = splitInternal(P, c, at, op.newId ?? op.rightId);
  return { id: c.id, ids: [c.id, r.id] };
};

H.splitAt = (P, op, X) => {
  const at = resolveTime(P, op.at ?? op.t);
  const tids = op.tracks ? asList(op.tracks).map((r) => requireTrack(P, r).id) : P.tracks.map((t) => t.id);
  const pairs = [];
  for (const tid of tids) {
    const t = trackById(P, tid);
    if (t && t.locked && !op.force) { X.warn(`הערוץ "${t.name}" נעול — דילגתי`); continue; }
    for (const c of clipsOnTrack(P, tid)) {
      if (c.start < at - EPS && clipEnd(c) > at + EPS) { const r = splitInternal(P, c, at); pairs.push([c.id, r.id]); }
    }
  }
  return { ids: pairs.flat(), pairs };
};

H.duplicateClip = (P, op, X) => {
  const c = getClip(P, op.id);
  const d = clone(c);
  d.id = uniqueId((x) => !!P.clips[x], op.newId, 'c_');
  const start = op.start !== undefined ? resolveTime(P, op.start) : op.at !== undefined ? resolveTime(P, op.at) : clipEnd(c);
  shiftClip(d, Math.max(0, start) - c.start);
  const t = placeClip(P, d, { track: op.track !== undefined ? op.track : c.trackId, overlap: op.overlap, force: op.force }, X);
  d.trackId = t.id;
  P.clips[d.id] = d;
  return { id: d.id, track: t.id, start: d.start };
};

H.pasteClips = (P, op, X) => {
  const list = asList(op.clips);
  if (!list.length) fail('pasteClips: חסר clips');
  const minStart = Math.min(...list.map((c) => num(c.start, 0)));
  const at = op.at !== undefined ? resolveTime(P, op.at) : minStart;
  const ids = [];
  for (const src of list) {
    if (!src || !CLIP_TYPES.includes(src.type)) fail('pasteClips: קליפ לא תקין');
    if (MEDIA_TYPES.has(src.type) && !P.media[src.mediaId]) mediaById(P, X, src.mediaId);
    const c = newClip(src.type, { ...clone(src), id: uniqueId((x) => !!P.clips[x], null, 'c_') });
    c.start = num(src.start, 0);
    shiftClip(c, at - minStart);
    const sameTrack = op.track === undefined && trackById(P, src.trackId);
    const t = placeClip(P, c, { track: op.track !== undefined ? op.track : sameTrack ? src.trackId : undefined, overlap: op.overlap }, X);
    c.trackId = t.id;
    P.clips[c.id] = c;
    ids.push(c.id);
  }
  return { ids, id: ids[0] };
};

H.setSpeed = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  if (!isTimedMedia(c)) fail('שינוי מהירות אפשרי רק לוידאו ואודיו');
  const ns = clampWarn(X, 'speed', num(op.speed, undefined, 'speed'), 0.05, 100);
  const old = c.speed > 0 ? c.speed : 1;
  if (op.reverse !== undefined) c.reverse = coerceLike(false, op.reverse) === true;
  if (!op.keepDuration) {
    const factor = old / ns;
    let nd = c.duration * factor;
    const media = P.media[c.mediaId];
    if (media && media.duration > 0) { const max = (media.duration - (c.in || 0)) / ns; if (nd > max) nd = max; }
    scaleKeyframes(c, factor);
    c.duration = round6(Math.max(frameOf(P), nd));
    const nxt = clipsOnTrack(P, c.trackId).find((o) => o.id !== c.id && o.start >= c.start + EPS && o.start < clipEnd(c) - EPS);
    if (nxt) X.warn(`הקליפ חופף עכשיו לקליפ ${nxt.id}`);
  } else {
    const media = P.media[c.mediaId];
    if (media && media.duration > 0) { const max = (media.duration - (c.in || 0)) / ns; if (c.duration > max) { X.warn('המשך קוצר לאורך המדיה'); c.duration = round6(max); } }
  }
  c.speed = ns;
  clampFades(c);
  return { id: c.id, duration: c.duration };
};

H.detachAudio = (P, op, X) => {
  const c = getClip(P, op.id);
  if (c.type !== 'video') fail('הפרדת שמע אפשרית רק לקליפ וידאו');
  const m = P.media[c.mediaId];
  if (!m || !m.hasAudio) fail('לוידאו הזה אין שמע');
  const id = uniqueId((x) => !!P.clips[x], op.newId, 'c_');
  const kf = {};
  for (const k of ['volume', 'pan']) if (c.keyframes && c.keyframes[k]) kf[k] = clone(c.keyframes[k]);
  const a = newClip('audio', {
    id, name: `${c.name || m.name} (שמע)`, start: c.start, duration: c.duration, mediaId: c.mediaId, in: c.in, speed: c.speed,
    reverse: c.reverse, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, pan: c.pan, audioFx: clone(c.audioFx), keyframes: kf,
  });
  const t = placeClip(P, a, { track: op.track, role: op.role || 'voice', overlap: op.overlap }, X);
  a.trackId = t.id;
  P.clips[a.id] = a;
  c.muteAudio = true;
  return { id: a.id, track: t.id };
};

H.closeGaps = (P, op, X) => {
  const t = requireTrack(P, op.track ?? op.id ?? 'main');
  if (t.locked && !op.force) fail(`הערוץ "${t.name}" נעול`);
  const list = clipsOnTrack(P, t.id);
  let cursor = op.from !== undefined ? resolveTime(P, op.from) : list.length ? (op.toZero ? 0 : list[0].start) : 0;
  let moved = 0;
  for (const c of list) {
    if (c.start + EPS < cursor) { cursor = Math.max(cursor, clipEnd(c)); continue; }
    if (c.start > cursor + EPS) { shiftClip(c, cursor - c.start); moved++; }
    cursor = clipEnd(c);
  }
  if (!moved) X.warn('לא נמצאו רווחים');
  return { id: t.id, moved };
};

// keyframes

function kfProp(prop) {
  const p = String(prop || '');
  if (!isKeyframable(p)) fail(`המאפיין "${prop}" לא ניתן להנפשה. נתמכים: transform.x|y|scale|scaleX|scaleY|rotation|opacity, volume, pan, color.<מפתח>, crop.l|t|r|b, effects.<i>.<פרמטר>, mask.x|y|w|h|rotation|feather, filter.amount, lut.amount, text.size|letterSpacing, shape.*`);
  return p;
}

function kfLocalTime(P, c, op, tKey = 't') {
  const raw = op[tKey];
  if (raw === undefined || raw === null) fail('חסר t לקיפריים');
  const isAbs = op.abs === true || (typeof raw !== 'number' && !/^-?\d+(\.\d+)?$/.test(String(raw)));
  const t = isAbs ? resolveTime(P, raw) - c.start : num(raw, undefined, 't');
  return round6(t);
}

function putKeyframe(c, prop, t, v, ease) {
  if (!c.keyframes) c.keyframes = {};
  const list = (c.keyframes[prop] || []).filter((k) => Math.abs(k.t - t) > 1e-3);
  list.push({ t, v, ease });
  list.sort((a, b) => a.t - b.t);
  c.keyframes[prop] = list;
}

function checkEase(ease) {
  const e = ease === undefined || ease === null || ease === '' ? 'linear' : String(ease);
  if (!isEaseName(e)) fail(`ease לא מוכר: "${ease}" (linear, easeIn, easeOut, easeInOut, hold, spring, bounce, back, elastic, bezier(x1,y1,x2,y2))`);
  return e;
}

H.setKeyframe = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const prop = kfProp(op.prop);
  const t = kfLocalTime(P, c, op);
  if (t < -1e-6 || t > c.duration + 1e-6) X.warn(`הקיפריים ב-${fmt(t)} מחוץ לטווח הקליפ (0–${fmt(c.duration)})`);
  const m = /^effects\.(\d+)\./.exec(prop);
  if (m && !(c.effects && c.effects[Number(m[1])])) fail(`אין אפקט באינדקס ${m[1]} בקליפ`);
  const v = op.v === undefined || op.v === null ? evalKeyframed(c, prop, t) : num(op.v, undefined, 'v');
  putKeyframe(c, prop, t, v, checkEase(op.ease));
  return { id: c.id, t, v };
};

H.setKeyframes = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const prop = kfProp(op.prop);
  const keys = asList(op.keys);
  if (!keys.length) fail('setKeyframes: חסר keys [{t,v,ease}]');
  if (op.replace) c.keyframes = { ...(c.keyframes || {}), [prop]: [] };
  for (const k of keys) {
    const kk = Array.isArray(k) ? { t: k[0], v: k[1], ease: k[2] } : k;
    const t = kfLocalTime(P, c, { ...kk, abs: op.abs ?? kk.abs });
    putKeyframe(c, prop, t, num(kk.v, undefined, 'v'), checkEase(kk.ease));
  }
  void X;
  return { id: c.id, count: c.keyframes[prop].length };
};

H.removeKeyframe = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const prop = String(op.prop || '');
  const list = c.keyframes && c.keyframes[prop];
  if (!list || !list.length) fail(`אין קיפריימים ל-${prop}`);
  const t = kfLocalTime(P, c, op);
  const tol = Math.max(1e-3, frameOf(P) / 2);
  const next = list.filter((k) => Math.abs(k.t - t) > tol);
  if (next.length === list.length) fail(`אין קיפריים ב-${fmt(t)} ל-${prop}`);
  if (next.length) c.keyframes[prop] = next; else delete c.keyframes[prop];
  return { id: c.id };
};

H.clearKeyframes = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  if (op.prop) { if (c.keyframes) delete c.keyframes[op.prop]; } else c.keyframes = {};
  return { id: c.id };
};

// transitions

H.setTransition = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  if (!VISUAL_TYPES.has(c.type)) fail('מעברים זמינים רק לקליפים חזותיים (לאודיו השתמש ב-fadeIn/fadeOut)');
  const tid = op.transition ?? op.transitionId ?? op.type;
  if (!tid || tid === 'none') { c.transitionOut = { id: 'none', duration: c.transitionOut?.duration ?? 0.5, params: {} }; return { id: c.id }; }
  const cat = X.cat;
  let def = null;
  if (cat && cat.loaded && Array.isArray(cat.transitions) && cat.transitions.length) {
    def = cat.transitions.find((t) => t.id === tid);
    if (!def) fail(`מעבר לא מוכר: "${tid}". קיימים: ${cat.transitions.map((t) => t.id).join(', ')}`);
  }
  const next = nextClipOnTrack(P, c);
  if (!next && !op.force) fail(`אין קליפ צמוד אחרי "${c.name || c.id}" באותו ערוץ (המעבר מוגדר בין קליפ לקליפ שמתחיל בסופו). הזז את הקליפים כך שייגעו, או שלח force:true`);
  let d = op.duration !== undefined ? num(op.duration, 0.5, 'duration') : def && def.defaultDuration ? Number(def.defaultDuration) : 0.5;
  const maxD = Math.min(5, 2 * Math.min(c.duration, next ? next.duration : c.duration));
  if (d > maxD) { X.warn(`משך המעבר הוגבל ל-${fmt(maxD)} שנ' (חצי מהמעבר בכל צד של החיתוך)`); d = maxD; }
  if (d < frameOf(P)) fail('משך המעבר קצר מדי');
  const params = {};
  if (def && Array.isArray(def.params)) for (const p of def.params) if (p && p.key !== undefined && p.default !== undefined) params[p.key] = p.default;
  c.transitionOut = { id: tid, duration: round6(d), params: { ...params, ...(op.params || {}) } };
  return { id: c.id, next: next ? next.id : null, duration: c.transitionOut.duration };
};

H.removeTransition = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  c.transitionOut = { id: 'none', duration: c.transitionOut?.duration ?? 0.5, params: {} };
  return { id: c.id };
};

// effects (with keyframe index bookkeeping)

function remapEffectKeyframes(c, mapIndex) {
  if (!c.keyframes) return;
  const out = {};
  for (const [prop, list] of Object.entries(c.keyframes)) {
    const m = /^effects\.(\d+)\.(.+)$/.exec(prop);
    if (!m) { out[prop] = list; continue; }
    const ni = mapIndex(Number(m[1]));
    if (ni === null || ni === undefined) continue;
    out[`effects.${ni}.${m[2]}`] = list;
  }
  c.keyframes = out;
}

H.addEffect = (P, op, X) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  if (!VISUAL_TYPES.has(c.type)) fail('אפקטים חזותיים זמינים רק לקליפים חזותיים');
  const eid = op.effect ?? op.effectId;
  if (!eid) fail('addEffect: חסר effect');
  if (!Array.isArray(c.effects)) c.effects = [];
  const fx = fillEffectDefaults({ id: String(eid), params: { ...(op.params || {}) }, enabled: op.enabled !== false }, X);
  const idx = op.index === undefined ? c.effects.length : clamp(Math.trunc(num(op.index, 0)), 0, c.effects.length);
  remapEffectKeyframes(c, (i) => (i >= idx ? i + 1 : i));
  c.effects.splice(idx, 0, fx);
  return { id: c.id, index: idx };
};

function effectAt(c, index) {
  const i = Math.trunc(num(index, undefined, 'index'));
  if (!Array.isArray(c.effects) || !c.effects[i]) fail(`אין אפקט באינדקס ${index}`);
  return i;
}

H.updateEffect = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const i = effectAt(c, op.index);
  const fx = c.effects[i];
  if (op.params) { if (!isPlainObject(op.params)) fail('params חייב להיות אובייקט'); fx.params = { ...(fx.params || {}), ...op.params }; }
  if (op.enabled !== undefined) fx.enabled = coerceLike(true, op.enabled) !== false;
  if (op.effect) fx.id = String(op.effect);
  return { id: c.id, index: i };
};

H.removeEffect = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const i = effectAt(c, op.index);
  c.effects.splice(i, 1);
  remapEffectKeyframes(c, (j) => (j === i ? null : j > i ? j - 1 : j));
  return { id: c.id };
};

H.moveEffect = (P, op) => {
  const c = getClip(P, op.id);
  checkLocked(P, c, op);
  const from = effectAt(c, op.from ?? op.index);
  const to = clamp(Math.trunc(num(op.to, 0, 'to')), 0, c.effects.length - 1);
  const [fx] = c.effects.splice(from, 1);
  c.effects.splice(to, 0, fx);
  remapEffectKeyframes(c, (j) => {
    if (j === from) return to;
    if (from < to && j > from && j <= to) return j - 1;
    if (from > to && j >= to && j < from) return j + 1;
    return j;
  });
  return { id: c.id, index: to };
};

// captions

function captionsTargetTrack(P, op, X) {
  if (op.track !== undefined && op.track !== null && op.track !== '') {
    const t = requireTrack(P, op.track);
    if (t.kind !== 'video') fail('כתוביות צריכות ערוץ וידאו');
    return t;
  }
  const existing = P.tracks.find((t) => isCaptionsTrack(t) && !t.locked);
  return existing || createRoleTrack(P, 'captions', X);
}

H.addCaptions = (P, op, X) => {
  // words: the transcript as is (default) or explicit words; with script → the script's words on those times
  let words = parseWords(op.words === undefined ? 'transcript' : op.words, P);
  if (!words.length) fail('אין מילים לכתוביות — הגדר תמלול (setTranscript) או שלח words');
  if (hasScript(op)) words = alignToScript(P, words, op, X).words;
  const hotSet = new Set(asList(op.hot).flatMap((h) => String(h).split(/\s+/)).map(normalizeWord).filter(Boolean));
  for (const w of words) w.hot = !!w.hot || hotSet.has(normalizeWord(w.w));
  const style = op.style || 'karaoke';
  const sd = captionStyleDefaults(style, X);
  const groups = chunkCaptionWords(words, {
    maxWords: op.maxWords ?? sd.maxWords ?? 3, maxChars: op.maxChars ?? 18, chunks: op.chunks,
    pauseBreak: op.pauseBreak ?? 0.6, commaBreak: op.commaBreak ?? true,
  });
  const fd = frameOf(P);
  const tail = num(op.tail, 0.4), gap = num(op.gap, 0);
  const hold = op.hold !== undefined && op.hold !== null ? num(op.hold, undefined, 'hold') : null;
  const ranges = groups.map((g, i) => {
    let s = g[0].s;
    if (i === 0 && op.hook0) s = 0;
    const lastE = Math.max(...g.map((w) => w.e));
    let e = i < groups.length - 1 ? groups[i + 1][0].s - gap : lastE + tail;
    if (hold !== null) e = Math.min(e, lastE + hold);
    if (e < s + fd) e = s + fd;
    return [round6(Math.max(0, s)), round6(e)];
  });
  let track = captionsTargetTrack(P, op, X);
  const lo = ranges[0][0], hi = ranges[ranges.length - 1][1];
  if (op.replace) {
    let removed = 0;
    for (const c of clipsOnTrack(P, track.id)) if (c.type === 'caption' && overlaps(lo, hi, c.start, clipEnd(c))) { delete P.clips[c.id]; removed++; }
    if (removed) X.warn(`הוסרו ${removed} כתוביות קודמות בטווח`);
  }
  const busy = ranges.some(([s, e]) => !isTrackFree(P, track.id, s, e));
  if (busy) {
    if (op.overlap === 'error') fail(`ערוץ הכתוביות "${track.name}" תפוס בטווח ${fmt(lo)}–${fmt(hi)} (שלח replace:true כדי להחליף)`);
    if (op.overlap !== 'allow') track = createAdjacentTrack(P, [track], X);
  }
  const textBase = deepMerge(deepMerge(DEFAULT_TEXT(), sd.text || {}), isPlainObject(op.text) ? op.text : {});
  let y = op.y;
  if (y === undefined && op.yAbs !== undefined) y = num(op.yAbs, 0) - P.settings.height / 2;
  if (y === undefined) y = sd.y !== undefined ? sd.y : Math.round(P.settings.height * 0.14);
  y = num(y, 0, 'y');
  const ids = [];
  const explicitIds = Array.isArray(op.ids) ? op.ids : null;
  groups.forEach((g, i) => {
    const [s, e] = ranges[i];
    const preferred = explicitIds ? explicitIds[i] : op.idPrefix ? `${op.idPrefix}${i + 1}` : null;
    const id = uniqueId((x) => !!P.clips[x], preferred, 'c_');
    const content = g.map((w) => w.w).join(' ');
    const clip = newClip('caption', {
      id, name: content.slice(0, 60), start: s, duration: round6(e - s),
      text: { ...clone(textBase), content },
      caption: { words: g.map((w) => ({ w: w.w, s: w.s, e: w.e, hot: !!w.hot })), style,
        activeColor: op.activeColor || sd.activeColor || '#3fe0f5', hotColor: op.hotColor || sd.hotColor || '#ff8a66' },
      transform: { y, x: num(op.x, 0, 'x') },
    });
    if (sd.textAnim) clip.textAnim = deepMerge(clip.textAnim, sd.textAnim);
    if (isPlainObject(op.textAnim)) clip.textAnim = deepMerge(clip.textAnim, op.textAnim);
    if (op.animIn) clip.animIn = typeof op.animIn === 'string' ? { id: op.animIn, duration: 0.25 } : { ...clip.animIn, ...op.animIn };
    if (op.animOut) clip.animOut = typeof op.animOut === 'string' ? { id: op.animOut, duration: 0.2 } : { ...clip.animOut, ...op.animOut };
    validateAnimIds(clip);
    clip.trackId = track.id;
    P.clips[id] = clip;
    ids.push(id);
  });
  return { ids, id: ids[0], track: track.id, chunks: groups.map((g) => g.length) };
};

function targetCaptionClips(P, op) {
  let clips;
  if (op.ids || op.id) clips = asList(op.ids ?? op.id).map((id) => getClip(P, id));
  else if (op.track) { const t = requireTrack(P, op.track); clips = clipsOnTrack(P, t.id); }
  else clips = Object.values(P.clips);
  return clips.filter((c) => c.type === 'caption');
}

H.styleCaptions = (P, op, X) => {
  const clips = targetCaptionClips(P, op);
  if (!clips.length) fail('לא נמצאו כתוביות לעיצוב');
  const sd = op.style ? captionStyleDefaults(op.style, X) : null;
  let y = op.y;
  if (y === undefined && op.yAbs !== undefined) y = num(op.yAbs, 0) - P.settings.height / 2;
  for (const c of clips) {
    checkLocked(P, c, op);
    if (sd) {
      const content = c.text?.content;
      c.text = deepMerge(deepMerge(DEFAULT_TEXT(), sd.text || {}), {});
      c.text.content = content;
      c.caption.style = op.style;
      if (sd.activeColor) c.caption.activeColor = sd.activeColor;
      if (sd.hotColor) c.caption.hotColor = sd.hotColor;
      if (sd.textAnim) c.textAnim = deepMerge(c.textAnim || {}, sd.textAnim);
    }
    if (isPlainObject(op.text)) c.text = deepMerge(c.text, op.text);
    if (op.activeColor) c.caption.activeColor = op.activeColor;
    if (op.hotColor) c.caption.hotColor = op.hotColor;
    if (y !== undefined) c.transform.y = num(y, 0, 'y');
    if (op.x !== undefined) c.transform.x = num(op.x, 0, 'x');
    syncCaptionText(c);
  }
  return { ids: clips.map((c) => c.id) };
};

H.setHotWords = (P, op) => {
  const set = new Set(asList(op.words).flatMap((h) => String(h).split(/\s+/)).map(normalizeWord).filter(Boolean));
  if (!set.size) fail('setHotWords: חסר words');
  const hot = op.hot !== false;
  let count = 0;
  for (const c of targetCaptionClips(P, op)) {
    for (const w of c.caption.words) if (set.has(normalizeWord(w.w))) { w.hot = hot; count++; }
  }
  if (op.transcript !== false && P.transcript && Array.isArray(P.transcript.words)) {
    for (const w of P.transcript.words) if (set.has(normalizeWord(w.w))) w.hot = hot;
  }
  return { count };
};

H.setCaptionWord = (P, op) => {
  const c = getClip(P, op.id);
  if (c.type !== 'caption') fail('הקליפ אינו כתובית');
  checkLocked(P, c, op);
  const i = Math.trunc(num(op.index, undefined, 'index'));
  const w = c.caption.words[i];
  if (!w) fail(`אין מילה באינדקס ${i}`);
  const set = op.set || {};
  if (set.w !== undefined) { if (!String(set.w).trim()) fail('מילה ריקה'); w.w = String(set.w).trim(); }
  if (set.s !== undefined) w.s = resolveTime(P, set.s);
  if (set.e !== undefined) w.e = resolveTime(P, set.e);
  if (set.hot !== undefined) w.hot = coerceLike(false, set.hot) === true;
  if (w.e <= w.s) w.e = round6(w.s + 0.05);
  syncCaptionText(c);
  c.name = c.text.content.slice(0, 60);
  return { id: c.id };
};

H.splitCaption = (P, op) => {
  const c = getClip(P, op.id);
  if (c.type !== 'caption') fail('הקליפ אינו כתובית');
  checkLocked(P, c, op);
  const words = c.caption.words;
  const i = Math.trunc(num(op.index ?? op.word, undefined, 'index'));
  if (!(i >= 1 && i < words.length)) fail(`אינדקס פיצול לא תקין: ${i} (בין 1 ל-${words.length - 1})`);
  const at = words[i].s;
  if (!(at > c.start + 1e-6 && at < clipEnd(c) - 1e-6)) fail('זמן המילה מחוץ לטווח הקליפ');
  const r = splitInternal(P, c, at, op.newId);
  // make sure the partition follows word indices exactly (words with equal start times)
  const all = words.map((w) => ({ ...w }));
  c.caption.words = all.slice(0, i); r.caption.words = all.slice(i);
  syncCaptionText(c); syncCaptionText(r);
  c.name = c.text.content.slice(0, 60); r.name = r.text.content.slice(0, 60);
  return { id: c.id, ids: [c.id, r.id] };
};

H.mergeCaptions = (P, op) => {
  const clips = asList(op.ids).map((id) => getClip(P, id));
  if (clips.length < 2) fail('mergeCaptions: צריך לפחות שני מזהים');
  for (const c of clips) { if (c.type !== 'caption') fail(`הקליפ ${c.id} אינו כתובית`); checkLocked(P, c, op); }
  if (new Set(clips.map((c) => c.trackId)).size > 1) fail('אפשר למזג רק כתוביות באותו ערוץ');
  clips.sort((a, b) => a.start - b.start);
  const first = clips[0];
  const end = Math.max(...clips.map(clipEnd));
  const words = clips.flatMap((c) => c.caption.words.map((w) => ({ ...w })));
  for (const c of clips.slice(1)) delete P.clips[c.id];
  first.caption.words = words;
  first.duration = round6(end - first.start);
  const last = clips[clips.length - 1];
  if (last.transitionOut) first.transitionOut = clone(last.transitionOut);
  if (last.animOut) first.animOut = clone(last.animOut);
  syncCaptionText(first);
  first.name = first.text.content.slice(0, 60);
  return { id: first.id, ids: clips.slice(1).map((c) => c.id) };
};

/** op.script (text or tokens) present? */
function hasScript(op) {
  return op.script !== undefined && op.script !== null && tokenizeScript(op.script).length > 0;
}

/**
 * Script ↔ ASR alignment (shared/align.js): the script's correct words (with their punctuation) get the ASR times.
 * words: parsed [{w,s,e,hot}] → { words (parsed, sorted), info }
 */
function alignToScript(P, words, op, X) {
  if (typeof op.script !== 'string' && !Array.isArray(op.script)) fail('script חייב להיות טקסט התסריט (מחרוזת) או מערך מילים');
  if (!words.length) fail('אין זמני מילים ליישור התסריט — שלח words (תמלול ASR) או הגדר תמלול קודם');
  const info = alignScriptToAsr(op.script, words.map((w) => ({ w: w.w, s: w.s, e: w.e })), { hot: op.hot });
  if (!info.words.length) fail('התסריט ריק');
  if (info.method === 'index') X.warn(`התסריט כמעט לא תואם לתמלול (${Math.round(info.coverage * 100)}% מהאותיות) — הזמנים חולקו לפי הסדר בלבד; בדוק שזה התסריט הנכון`);
  else if (info.coverage < 0.75) X.warn(`התאמה נמוכה בין התסריט לתמלול (${Math.round(info.coverage * 100)}% מהאותיות) — בדוק את הזמנים`);
  return { words: parseWords(info.words, P), info };
}

H.setTranscript = (P, op, X) => {
  const script = hasScript(op);
  // words:"transcript" + script = re-align the project's current transcript to the script
  const src = op.words === 'transcript' || (op.words === undefined && script) ? (script ? (P.transcript && P.transcript.words) || [] : []) : op.words ?? [];
  let words = parseWords(src, P);
  let info = null;
  if (script) ({ words, info } = alignToScript(P, words, op, X));
  const prevMedia = op.words === 'transcript' && P.transcript ? P.transcript.mediaId : undefined;
  P.transcript = { words: words.map((w) => (w.hot ? w : { w: w.w, s: w.s, e: w.e })) };
  if (op.mediaId || prevMedia) P.transcript.mediaId = op.mediaId || prevMedia;
  if (!info) return { count: words.length };
  return { count: words.length, asrCount: info.asrCount, coverage: info.coverage, method: info.method, changes: info.changes };
};

// markers

H.addMarker = (P, op) => {
  const t = Math.max(0, resolveTime(P, op.t ?? op.at));
  const id = uniqueId((x) => P.markers.some((m) => m.id === x), op.id, 'mk_');
  const m = { id, t, label: op.label !== undefined ? String(op.label) : '', color: op.color || '#f5c518' };
  P.markers.push(m);
  P.markers.sort((a, b) => a.t - b.t);
  return { id, t };
};

H.updateMarker = (P, op) => {
  const m = P.markers.find((x) => x.id === op.id) || findMarker(P, String(op.id));
  for (const [k, v] of Object.entries(op.set || {})) {
    if (k === 't') m.t = Math.max(0, resolveTime(P, v));
    else if (k === 'label' || k === 'color') m[k] = String(v);
    else fail(`שדה סמן לא מוכר "${k}" (t, label, color)`);
  }
  P.markers.sort((a, b) => a.t - b.t);
  return { id: m.id };
};

H.removeMarker = (P, op) => {
  const m = P.markers.find((x) => x.id === op.id) || findMarker(P, String(op.id ?? op.label));
  P.markers = P.markers.filter((x) => x !== m);
  return { id: m.id };
};

H.clearMarkers = (P) => { const n = P.markers.length; P.markers = []; return { count: n }; };

// ripple / gaps

function rippleTracks(P, op, X) {
  const all = op.tracks === undefined || op.tracks === null;
  const list = all ? P.tracks.slice() : asList(op.tracks).map((r) => requireTrack(P, r));
  const out = [];
  for (const t of list) {
    if (t.locked && !op.force) { X.warn(`הערוץ "${t.name}" נעול — לא הוזז`); continue; }
    out.push(t);
  }
  return { tracks: out, all };
}

H.rippleDelete = (P, op, X) => {
  const from = resolveTime(P, op.from), to = resolveTime(P, op.to);
  if (!(to > from + EPS)) fail(`טווח לא תקין: ${fmt(from)}–${fmt(to)}`);
  const d = to - from;
  const { tracks, all } = rippleTracks(P, op, X);
  let removed = 0;
  for (const t of tracks) {
    for (const c of clipsOnTrack(P, t.id)) {
      const cs = c.start, ce = clipEnd(c);
      if (ce <= from + EPS) continue;
      if (cs >= to - EPS) { shiftClip(c, -d); continue; }
      if (cs >= from - EPS && ce <= to + EPS) { delete P.clips[c.id]; removed++; continue; }
      if (cs < from - EPS && ce > to + EPS) {
        const mid = splitInternal(P, c, from);
        const right = splitInternal(P, mid, to);
        delete P.clips[mid.id];
        shiftClip(right, -d);
        continue;
      }
      if (cs < from - EPS) { trimTailInternal(c, from); continue; }
      trimHeadInternal(c, to);
      shiftClip(c, -d);
    }
  }
  if (all || op.markers) {
    P.markers = P.markers.filter((m) => !(m.t >= from - EPS && m.t < to - EPS)).map((m) => (m.t >= to - EPS ? { ...m, t: round6(m.t - d) } : m));
    if (P.transcript && Array.isArray(P.transcript.words)) {
      P.transcript.words = P.transcript.words.filter((w) => !(w.s >= from - EPS && w.s < to - EPS))
        .map((w) => (w.s >= to - EPS ? { ...w, s: round6(w.s - d), e: round6(w.e - d) } : w));
    }
  }
  return { removed, duration: round6(d) };
};

H.insertGap = (P, op, X) => {
  const at = resolveTime(P, op.at);
  const d = num(op.duration, undefined, 'duration');
  if (!(d > 0)) fail('duration חייב להיות חיובי');
  const { tracks, all } = rippleTracks(P, op, X);
  for (const t of tracks) {
    for (const c of clipsOnTrack(P, t.id)) if (c.start < at - EPS && clipEnd(c) > at + EPS) splitInternal(P, c, at);
    for (const c of clipsOnTrack(P, t.id)) if (c.start >= at - EPS) shiftClip(c, d);
  }
  if (all || op.markers) {
    P.markers = P.markers.map((m) => (m.t >= at - EPS ? { ...m, t: round6(m.t + d) } : m));
    if (P.transcript && Array.isArray(P.transcript.words)) {
      P.transcript.words = P.transcript.words.map((w) => (w.s >= at - EPS ? { ...w, s: round6(w.s + d), e: round6(w.e + d) } : w));
    }
  }
  return { duration: d };
};

// ───────────────────────────── engine ─────────────────────────────

const ALIASES = { addTransition: 'setTransition', deleteClip: 'removeClip', deleteClips: 'removeClips', cut: 'splitClip', split: 'splitClip', addSfx: 'sfx', setTranscriptWords: 'setTranscript', updateClips: 'updateClip' };

function ensureShape(P) {
  if (!isPlainObject(P.settings)) P.settings = {};
  if (!(P.settings.fps > 0)) P.settings.fps = 30;
  if (!(P.settings.width > 0)) P.settings.width = 1080;
  if (!(P.settings.height > 0)) P.settings.height = 1920;
  if (!isPlainObject(P.media)) P.media = {};
  if (!Array.isArray(P.tracks)) P.tracks = [];
  if (!isPlainObject(P.clips)) P.clips = {};
  if (!Array.isArray(P.markers)) P.markers = [];
  if (!isPlainObject(P.transcript)) P.transcript = { words: [] };
  if (!Array.isArray(P.transcript.words)) P.transcript.words = [];
}

/**
 * applyOps(project, ops, ctx={}) → { project, results }
 * Pure; deep-clones; an op error does not abort the batch unless ctx.atomic.
 */
export function applyOps(project, ops, ctx = {}) {
  const list = Array.isArray(ops) ? ops : ops ? [ops] : [];
  const C = ctx || {};
  const cat = C.catalog || getCatalogSync();
  let P = project;
  let changed = false;
  let anyFail = false;
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const op = list[i];
    const warnings = [];
    try {
      if (!op || typeof op !== 'object') fail(`פעולה ${i} אינה אובייקט`);
      const name = ALIASES[op.op] || op.op;
      const h = Object.prototype.hasOwnProperty.call(H, name) ? H[name] : null;
      if (!h) fail(`פעולה לא מוכרת: "${op.op}". פעולות קיימות: ${Object.keys(H).join(', ')}`);
      const next = clone(P);
      ensureShape(next);
      const X = { ctx: C, cat, warn: (m) => warnings.push(m) };
      const res = h(next, op, X) || {};
      P = next;
      changed = true;
      const r = { ok: true, op: name, ...res };
      if (warnings.length) r.warnings = warnings;
      results.push(r);
    } catch (e) {
      anyFail = true;
      const msg = e instanceof OpError ? e.message : `שגיאה פנימית בפעולה ${op && op.op}: ${e && e.message ? e.message : e}`;
      results.push({ ok: false, op: op && op.op, error: msg });
    }
  }
  if (C.atomic && anyFail) return { project, results };
  if (!changed) P = clone(project);
  return { project: P, results };
}

/** Hebrew one-line summary of a batch (for history / SSE toasts when no summary is given). */
export function summarizeOps(ops) {
  const list = Array.isArray(ops) ? ops : ops ? [ops] : [];
  const counts = new Map();
  for (const op of list) { const n = ALIASES[op?.op] || op?.op; if (n) counts.set(n, (counts.get(n) || 0) + 1); }
  const parts = [];
  for (const [n, k] of counts) {
    const h = OPS_HELP.find((x) => x.op === n);
    const label = h ? h.label : n;
    parts.push(k > 1 ? `${label} ×${k}` : label);
  }
  return parts.join(' · ') || 'ללא שינוי';
}

export const OP_NAMES = Object.keys(H);

/** Reference for CLI help and docs: { op, fields, he, label, example } */
export const OPS_HELP = [
  { op: 'setSettings', label: 'הגדרות פרויקט', fields: 'set:{width,height,fps,background,sampleRate,safeArea,masterGainDb,targetLufs}', he: 'שינוי הגדרות הפרויקט (גודל, קצב פריימים, רקע, אזור בטוח, עוצמת יעד)', example: { op: 'setSettings', set: { background: '#071822', targetLufs: -14 } } },
  { op: 'renameProject', label: 'שינוי שם פרויקט', fields: 'name', he: 'שינוי שם הפרויקט', example: { op: 'renameProject', name: 'סרטון 06' } },
  { op: 'addTrack', label: 'הוספת ערוץ', fields: 'kind:video|audio, role?, name?, index?, id?, captions?', he: 'הוספת ערוץ. תפקידים: main/overlay/text/effects (וידאו), voice/music/sfx (אודיו)', example: { op: 'addTrack', kind: 'audio', role: 'sfx', name: 'וושים' } },
  { op: 'updateTrack', label: 'עדכון ערוץ', fields: 'id, set:{name,hidden,muted,locked,solo,volume,height,role}', he: 'עדכון מאפייני ערוץ', example: { op: 'updateTrack', id: 't_music', set: { volume: 0.6 } } },
  { op: 'removeTrack', label: 'מחיקת ערוץ', fields: 'id', he: 'מחיקת ערוץ וכל הקליפים שבו', example: { op: 'removeTrack', id: 't_overlay' } },
  { op: 'moveTrack', label: 'הזזת ערוץ', fields: 'id, index', he: 'שינוי סדר הערוצים (0 = עליון)', example: { op: 'moveTrack', id: 't_text', index: 0 } },
  { op: 'addClip', label: 'הוספת קליפ', fields: 'type, start|at (זמן), duration?|end?, mediaId?|path?, in?, track?|role?, overlap?:newTrack|allow|overwrite|insert|error, id?, append?, preset? (טקסט/צורה/מדבקה), x?,y? | xAbs?,yAbs?, set?:{נתיב:ערך}, …כל שדה של קליפ', he: 'הוספת קליפ. בלי ערוץ: וידאו/תמונה→ראשי (תפוס→שכבה), טקסט→טקסט, כתובית→כתוביות, אודיו→אפקטים קוליים, אפקט→ערוץ אפקטים עליון', example: { op: 'addClip', type: 'text', content: 'רגע!', at: { word: 'רגע!' }, duration: 1.2, y: -600, animIn: 'pop' } },
  { op: 'updateClip', label: 'עדכון קליפ', fields: 'id|ids, set:{"נתיב.לשדה": ערך}, merge?:{…}', he: 'שינוי שדות קליפ לפי נתיב (transform.scale, text.content, volume, animIn.id …)', example: { op: 'updateClip', id: 'c_title', set: { 'transform.scale': 1.2, 'text.color': '#3fe0f5' } } },
  { op: 'removeClip', label: 'מחיקת קליפ', fields: 'id, ripple?', he: 'מחיקת קליפ; ripple מזיז את מה שאחריו באותו ערוץ', example: { op: 'removeClip', id: 'c_old', ripple: true } },
  { op: 'removeClips', label: 'מחיקת קליפים', fields: 'ids, ripple?', he: 'מחיקת כמה קליפים', example: { op: 'removeClips', ids: ['c_a', 'c_b'] } },
  { op: 'moveClip', label: 'הזזת קליפ', fields: 'id, start|by, track?, overlap?', he: 'הזזת קליפ בזמן ו/או לערוץ אחר (מילות כתוביות זזות איתו)', example: { op: 'moveClip', id: 'c_logo', start: 18.2 } },
  { op: 'moveClips', label: 'הזזת קבוצה', fields: 'ids, delta|start, trackDelta?', he: 'הזזת קבוצת קליפים יחד', example: { op: 'moveClips', ids: ['c_a', 'c_b'], delta: 0.5 } },
  { op: 'trimClip', label: 'חיתוך קצוות', fields: 'id, start?, end?, duration?, head?, tail?', he: 'קיצור/הארכת קליפ מהתחלה או מהסוף (מעדכן את נקודת הכניסה במדיה, לפי המהירות)', example: { op: 'trimClip', id: 'c_vid', start: 1.0, end: 4.5 } },
  { op: 'slipClip', label: 'החלקת תוכן', fields: 'id, by|in', he: 'הזזת התוכן בתוך הקליפ בלי להזיז אותו בציר (slip)', example: { op: 'slipClip', id: 'c_vid', by: 0.5 } },
  { op: 'splitClip', label: 'פיצול', fields: 'id, at, newId?', he: 'פיצול קליפ בזמן; מחזיר [שמאל, ימין]; מטפל בקיפריימים, מילות כתוביות, דעיכות ומעבר', example: { op: 'splitClip', id: 'c_vid', at: 3.2 } },
  { op: 'splitAt', label: 'פיצול בכל הערוצים', fields: 'at, tracks?', he: 'פיצול כל הקליפים שחוצים את הזמן', example: { op: 'splitAt', at: 5 } },
  { op: 'duplicateClip', label: 'שכפול', fields: 'id, start?, track?, newId?', he: 'שכפול קליפ (ברירת מחדל: מיד אחריו)', example: { op: 'duplicateClip', id: 'c_hit', start: 8.4 } },
  { op: 'pasteClips', label: 'הדבקה', fields: 'clips:[Clip], at?, track?', he: 'הדבקת קליפים מועתקים (מזהים חדשים)', example: { op: 'pasteClips', clips: [], at: 10 } },
  { op: 'setSpeed', label: 'מהירות', fields: 'id, speed, keepDuration?, reverse?', he: 'שינוי מהירות (המשך משתנה בהתאם, כמו ב-CapCut)', example: { op: 'setSpeed', id: 'c_vid', speed: 2 } },
  { op: 'detachAudio', label: 'הפרדת שמע', fields: 'id, track?|role?', he: 'הוצאת השמע של וידאו לקליפ אודיו נפרד והשתקת הוידאו', example: { op: 'detachAudio', id: 'c_vid' } },
  { op: 'closeGaps', label: 'סגירת רווחים', fields: 'track, from?, toZero?', he: 'הצמדת קליפים בערוץ אחד לשני (מגנטי)', example: { op: 'closeGaps', track: 't_main' } },
  { op: 'setKeyframe', label: 'קיפריים', fields: 'id, prop, t (יחסי לקליפ, או abs:true / זמן לפי מילה), v?, ease?', he: 'הוספת קיפריים. ה-ease חל על המקטע שמגיע אליו', example: { op: 'setKeyframe', id: 'c_vid', prop: 'transform.scale', t: 1.0, v: 1.6, ease: 'spring' } },
  { op: 'setKeyframes', label: 'קיפריימים', fields: 'id, prop, keys:[{t,v,ease}], abs?, replace?', he: 'כמה קיפריימים בבת אחת', example: { op: 'setKeyframes', id: 'c_vid', prop: 'transform.scale', keys: [{ t: 0, v: 1 }, { t: 0.18, v: 1.5, ease: 'easeOut' }, { t: 0.9, v: 1, ease: 'easeInOut' }] } },
  { op: 'removeKeyframe', label: 'מחיקת קיפריים', fields: 'id, prop, t', he: 'מחיקת קיפריים בזמן', example: { op: 'removeKeyframe', id: 'c_vid', prop: 'transform.scale', t: 1.0 } },
  { op: 'clearKeyframes', label: 'ניקוי קיפריימים', fields: 'id, prop?', he: 'מחיקת כל הקיפריימים (של מאפיין או של הקליפ)', example: { op: 'clearKeyframes', id: 'c_vid' } },
  { op: 'setTransition', label: 'מעבר', fields: 'id (הקליפ היוצא), transition, duration?, params?, force?', he: 'מעבר בין הקליפ לקליפ שמתחיל בסופו (ממורכז על החיתוך)', example: { op: 'setTransition', id: 'c_a', transition: 'zoomBlur', duration: 0.4 } },
  { op: 'removeTransition', label: 'הסרת מעבר', fields: 'id', he: 'הסרת המעבר שאחרי הקליפ', example: { op: 'removeTransition', id: 'c_a' } },
  { op: 'addEffect', label: 'אפקט', fields: 'id, effect, params?, index?, enabled?', he: 'הוספת אפקט לקליפ', example: { op: 'addEffect', id: 'c_vid', effect: 'zoomPunch', params: { strength: 0.3 } } },
  { op: 'updateEffect', label: 'עדכון אפקט', fields: 'id, index, params?, enabled?', he: 'שינוי פרמטרים של אפקט', example: { op: 'updateEffect', id: 'c_vid', index: 0, params: { strength: 0.5 } } },
  { op: 'removeEffect', label: 'הסרת אפקט', fields: 'id, index', he: 'הסרת אפקט (קיפריימים של אפקטים אחרים מתעדכנים)', example: { op: 'removeEffect', id: 'c_vid', index: 0 } },
  { op: 'moveEffect', label: 'סדר אפקטים', fields: 'id, from, to', he: 'שינוי סדר האפקטים', example: { op: 'moveEffect', id: 'c_vid', from: 1, to: 0 } },
  { op: 'addCaptions', label: 'כתוביות', fields: 'words:[[w,s,e]]|[{w,s,e}]|"transcript" (ברירת מחדל: התמלול כמו שהוא), script? (מילות התסריט על הזמנים), chunks?:[n…], maxWords?:3, maxChars?:18, style?, hot?:[מילים], track?, text?:{…}, y?|yAbs?, gap?, tail?:0.4, hold?, hook0?, replace?, pauseBreak?:0.6, commaBreak?:true, idPrefix?', he: 'יצירת כתוביות מזמני מילים: כל מקטע = קליפ אחד, מהמילה הראשונה ועד המקטע הבא', example: { op: 'addCaptions', words: 'transcript', style: 'chordix', chunks: [2, 3, 2], hot: ['אקורדים', 'ובום!'], yAbs: 330, hook0: true } },
  { op: 'styleCaptions', label: 'עיצוב כתוביות', fields: 'ids?|track?, style?, text?, activeColor?, hotColor?, y?|yAbs?, x?', he: 'החלת סגנון/צבעים/מיקום על כתוביות קיימות', example: { op: 'styleCaptions', style: 'pill', yAbs: 1300 } },
  { op: 'setHotWords', label: 'מילים מודגשות', fields: 'words, hot?:true, ids?|track?', he: 'סימון מילים כמודגשות בכל הכתוביות (בלי ניקוד ופיסוק)', example: { op: 'setHotWords', words: ['חינם'] } },
  { op: 'setCaptionWord', label: 'עריכת מילה', fields: 'id, index, set:{w,s,e,hot}', he: 'תיקון מילה בכתובית', example: { op: 'setCaptionWord', id: 'c_cap1', index: 0, set: { w: 'רגע!' } } },
  { op: 'splitCaption', label: 'פיצול כתובית', fields: 'id, index (המילה שמתחילה את החלק השני)', he: 'פיצול מקטע כתוביות לשניים', example: { op: 'splitCaption', id: 'c_cap1', index: 2 } },
  { op: 'mergeCaptions', label: 'מיזוג כתוביות', fields: 'ids', he: 'מיזוג מקטעים סמוכים לקליפ אחד', example: { op: 'mergeCaptions', ids: ['c_cap1', 'c_cap2'] } },
  { op: 'setTranscript', label: 'תמלול', fields: 'words:[[w,s,e]]|[{w,s,e}]|"transcript", script?:"טקסט התסריט"|[מילים], hot?:[מילים], mediaId?', he: 'הגדרת זמני המילים של הקריינות (לזמנים לפי מילה ולכתוביות). עם script: מילות התסריט הנכונות (עם הפיסוק) מקבלות את זמני ה-ASR ביישור לפי אותיות — שגיאות כתיב של Whisper מתוקנות, ומילים שה-ASR איחד/פיצל מקבלות זמנים יחסיים; words:"transcript" + script = יישור התמלול הקיים', example: { op: 'setTranscript', words: [['רגע,', 0.0, 0.8], ['וום,', 12.0, 12.16]], script: 'רגע! ובום!' } },
  { op: 'addMarker', label: 'סמן', fields: 't, label?, color?, id?', he: 'הוספת סמן בציר', example: { op: 'addMarker', t: { word: 'ובום!' }, label: 'דרופ' } },
  { op: 'updateMarker', label: 'עדכון סמן', fields: 'id, set:{t,label,color}', he: 'עדכון סמן', example: { op: 'updateMarker', id: 'mk_drop', set: { t: 9.8 } } },
  { op: 'removeMarker', label: 'מחיקת סמן', fields: 'id (או תווית)', he: 'מחיקת סמן', example: { op: 'removeMarker', id: 'mk_drop' } },
  { op: 'clearMarkers', label: 'ניקוי סמנים', fields: '', he: 'מחיקת כל הסמנים', example: { op: 'clearMarkers' } },
  { op: 'rippleDelete', label: 'מחיקה עם הזזה', fields: 'from, to, tracks?', he: 'מחיקת טווח זמן והזזת כל מה שאחריו (בכל הערוצים — גם סמנים ותמלול)', example: { op: 'rippleDelete', from: 4.0, to: 4.6 } },
  { op: 'insertGap', label: 'פתיחת רווח', fields: 'at, duration, tracks?', he: 'פתיחת רווח והזזת כל מה שאחרי', example: { op: 'insertGap', at: 8, duration: 0.5 } },
  { op: 'sfx', label: 'אפקט קולי', fields: 'sound (חיפוש|מזהה|נתיב), at, gain_db?, len?, fade?, from?, track?, name?', he: 'הוספת אפקט קולי מהספרייה (השרת מוצא את הצליל)', example: { op: 'sfx', sound: 'whoosh fast', at: { word: 'סולם!', offset: -0.12 }, gain_db: -14, len: 0.8, fade: 0.15 } },
  { op: 'addMedia', label: 'רישום מדיה', fields: 'media (Media|Media[])', he: 'רישום מדיה מוכנה בפרויקט (בדרך כלל השרת עושה זאת בייבוא)', example: { op: 'addMedia', media: { id: 'm_x', kind: 'audio', name: 'x', path: 'C:/x.wav', duration: 1 } } },
  { op: 'updateMedia', label: 'עדכון מדיה', fields: 'id, set', he: 'עדכון רשומת מדיה', example: { op: 'updateMedia', id: 'm_x', set: { name: 'קריינות' } } },
  { op: 'removeMedia', label: 'הסרת מדיה', fields: 'id, clips?:true', he: 'הסרת מדיה מהפרויקט (וכל הקליפים שמשתמשים בה)', example: { op: 'removeMedia', id: 'm_x' } },
];
