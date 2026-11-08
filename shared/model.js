// shared/model.js — Frame Studio data model, defaults, factories, time helpers, validation.
// Pure ES module: importable by the browser AND Node. No DOM, no Node built-ins, no top-level side effects.

export const MODEL_VERSION = 1;

// ───────────────────────────── enums / labels ─────────────────────────────

export const CLIP_TYPES = ['video', 'image', 'audio', 'text', 'caption', 'shape', 'sticker', 'effect', 'adjustment'];
export const VISUAL_TYPES = new Set(['video', 'image', 'text', 'caption', 'shape', 'sticker', 'effect', 'adjustment']);
export const MEDIA_TYPES = new Set(['video', 'image', 'audio']);
export const AUDIO_CAPABLE_TYPES = new Set(['video', 'audio']);
export const TEXT_TYPES = new Set(['text', 'caption']);
/** Clip types that normally fill the frame (used by animation distances, fit defaults). */
export const FULL_FRAME_TYPES = new Set(['video', 'image', 'effect', 'adjustment']);

export const TRACK_KINDS = ['video', 'audio'];
export const VIDEO_ROLES = ['main', 'overlay', 'text', 'effects'];
export const AUDIO_ROLES = ['voice', 'music', 'sfx'];
export const TRACK_ROLES = [...VIDEO_ROLES, ...AUDIO_ROLES];

export const ROLE_LABELS = {
  main: 'ראשי',
  overlay: 'שכבה',
  text: 'טקסט',
  effects: 'אפקטים',
  voice: 'קריינות',
  music: 'מוזיקה',
  sfx: 'אפקטים קוליים',
  captions: 'כתוביות',
};

export const CLIP_TYPE_LABELS = {
  video: 'וידאו',
  image: 'תמונה',
  audio: 'אודיו',
  text: 'טקסט',
  caption: 'כתובית',
  shape: 'צורה',
  sticker: 'מדבקה',
  effect: 'אפקט',
  adjustment: 'שכבת התאמה',
};

export const TRACK_KIND_LABELS = { video: 'וידאו', audio: 'אודיו' };

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'softlight', 'difference'];
export const BLEND_LABELS = {
  normal: 'רגיל', multiply: 'הכפלה', screen: 'מסך', overlay: 'שכבת על', add: 'חיבור',
  darken: 'הכהיה', lighten: 'הבהרה', softlight: 'אור רך', difference: 'הפרש',
};
export const FIT_MODES = ['contain', 'cover', 'fill', 'none'];
export const FIT_LABELS = { contain: 'התאמה', cover: 'מילוי', fill: 'מתיחה', none: 'גודל מקורי' };
export const MASK_TYPES = ['none', 'rect', 'ellipse', 'linear', 'mirror'];
export const SHAPE_KINDS = ['rect', 'roundrect', 'ellipse', 'line', 'arrow', 'star', 'triangle', 'heart', 'burst', 'progress'];
export const SAFE_AREAS = ['none', 'reels', 'tiktok', 'youtube'];
export const KEYFRAME_EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'spring', 'bounce', 'back', 'elastic'];
export const COLOR_KEYS = ['exposure', 'brightness', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint',
  'highlights', 'shadows', 'hue', 'vignette', 'sharpen', 'grain', 'fade'];

/** Regexes of keyframable property paths (relative to the clip). */
export const KEYFRAMABLE_PATTERNS = [
  /^transform\.(x|y|scale|scaleX|scaleY|rotation|opacity|anchorX|anchorY)$/,
  /^volume$/,
  /^pan$/,
  /^color\.[A-Za-z0-9_]+$/,
  /^crop\.(l|t|r|b)$/,
  /^effects\.\d+\.[A-Za-z0-9_]+$/,
  /^mask\.(x|y|w|h|rotation|feather)$/,
  /^filter\.amount$/,
  /^lut\.amount$/,
  /^text\.(size|letterSpacing)$/,
  /^shape\.(w|h|radius|strokeWidth|progressFrom|progressTo)$/,
];

export function isKeyframable(prop) {
  return typeof prop === 'string' && KEYFRAMABLE_PATTERNS.some((re) => re.test(prop));
}

/** Default timeline duration per clip type (seconds) when there is no media length to use. */
export const TYPE_DEFAULT_DURATION = {
  video: 5, image: 3, audio: 5, text: 3, caption: 2, shape: 2, sticker: 2, effect: 1, adjustment: 3,
};

// ───────────────────────────── generic helpers ─────────────────────────────

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** Deep clone of JSON-like data. */
export function clone(v) {
  if (v === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch { /* fall through for exotic values */ }
  }
  return JSON.parse(JSON.stringify(v));
}

/**
 * Deep merge: returns a NEW object. Plain objects are merged recursively, arrays and
 * everything else in `b` replace the value in `a`. `undefined` values in `b` are ignored.
 */
export function deepMerge(a, b) {
  if (b === undefined) return clone(a);
  if (!isPlainObject(a) || !isPlainObject(b)) return clone(b);
  const out = {};
  for (const k of Object.keys(a)) out[k] = clone(a[k]);
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (bv === undefined) continue;
    if (isPlainObject(bv) && isPlainObject(out[k])) out[k] = deepMerge(out[k], bv);
    else out[k] = clone(bv);
  }
  return out;
}

function splitPath(path) {
  if (Array.isArray(path)) return path.map(String);
  return String(path).split('.').filter((s) => s.length > 0);
}

/** getPath(obj, "a.b.0.c") */
export function getPath(obj, path) {
  let cur = obj;
  for (const seg of splitPath(path)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Immutable set: returns a new root with shallow copies along the path (structural sharing).
 * Missing intermediates are created ({} or [] when the next segment is a number).
 */
export function setPath(obj, path, value) {
  const segs = splitPath(path);
  if (!segs.length) return value;
  const rec = (node, i) => {
    const seg = segs[i];
    const isIdx = /^\d+$/.test(seg);
    let copy;
    if (Array.isArray(node)) copy = node.slice();
    else if (node && typeof node === 'object') copy = { ...node };
    else copy = isIdx ? [] : {};
    const key = Array.isArray(copy) && isIdx ? Number(seg) : seg;
    if (i === segs.length - 1) copy[key] = value;
    else copy[key] = rec(copy[key], i + 1);
    return copy;
  };
  return rec(obj, 0);
}

/** Mutating set (for objects you own, e.g. inside the ops engine after cloning). */
export function setPathMut(obj, path, value) {
  const segs = splitPath(path);
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const key = Array.isArray(cur) && /^\d+$/.test(seg) ? Number(seg) : seg;
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[key];
  }
  const last = segs[segs.length - 1];
  cur[Array.isArray(cur) && /^\d+$/.test(last) ? Number(last) : last] = value;
  return obj;
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function round6(v) { return Math.round(v * 1e6) / 1e6; }
export function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

// ───────────────────────────── ids ─────────────────────────────

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
/** uid("c_") → "c_" + 8 base36 chars. Edit-time only (never used while rendering). */
export function uid(prefix = '') {
  const bytes = new Uint8Array(8);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < 8; i++) s += B36[bytes[i] % 36];
  return prefix + s;
}

/** ASCII slug [a-z0-9-]+ for project ids. Hebrew-only names get a generated id. */
export function slugify(name) {
  const s = String(name || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
    .slice(0, 48);
  return s || ('p-' + uid('').slice(0, 6));
}

export function isValidProjectId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

// ───────────────────────────── default blocks ─────────────────────────────

export const DEFAULT_SETTINGS = () => ({
  width: 1080, height: 1920, fps: 30, background: '#000000', sampleRate: 48000,
  safeArea: 'reels', masterGainDb: 0, targetLufs: -14,
});

export const DEFAULT_TRANSFORM = () => ({
  x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
  anchorX: 0.5, anchorY: 0.5, flipX: false, flipY: false,
});

export const DEFAULT_COLOR = () => ({
  exposure: 0, brightness: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0,
  highlights: 0, shadows: 0, hue: 0, vignette: 0, sharpen: 0, grain: 0, fade: 0,
});

export const DEFAULT_TEXT = () => ({
  content: 'טקסט', font: 'Heebo', weight: 800, size: 96, color: '#ffffff',
  align: 'center', lineHeight: 1.15, letterSpacing: 0, maxWidth: 900, dir: 'auto', italic: false, underline: false,
  stroke: { color: '#000000', width: 0 },
  shadow: { color: 'rgba(0,0,0,0.6)', blur: 12, x: 0, y: 4 },
  background: { color: '#000000', opacity: 0, padding: 24, radius: 24 },
  glow: { color: '#ffd60a', blur: 0 },
  gradient: null,
});

export const DEFAULT_TEXT_ANIM = () => ({ in: 'none', out: 'none', loop: 'none', inDuration: 0.4, outDuration: 0.3, perWord: false });
export const DEFAULT_CAPTION = () => ({ words: [], style: 'karaoke', activeColor: '#ffd60a', hotColor: '#ff4d6d' });
export const DEFAULT_SHAPE = () => ({
  kind: 'rect', w: 400, h: 400, fill: '#3b82f6', stroke: '#ffffff', strokeWidth: 0, radius: 40, progressFrom: 0, progressTo: 1,
});
export const DEFAULT_STICKER = () => ({ kind: 'emoji', value: '🔥', size: 220 });
export const DEFAULT_AUDIO_FX = () => ({ voiceEnhance: false, denoise: false, eqPreset: 'none', duckUnderVoice: false, duckDb: -10 });
export const DEFAULT_MASK = () => ({ type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rotation: 0, feather: 0.05, invert: false });
export const DEFAULT_CHROMA = () => ({ enabled: false, color: '#00ff00', similarity: 0.35, smoothness: 0.08, spill: 0.5 });
export const DEFAULT_TRANSITION = () => ({ id: 'none', duration: 0.5, params: {} });

function visualBlock() {
  return {
    transform: DEFAULT_TRANSFORM(),
    fit: 'contain',
    crop: { l: 0, t: 0, r: 0, b: 0 },
    blend: 'normal',
    animIn: { id: 'none', duration: 0.4 },
    animOut: { id: 'none', duration: 0.4 },
    animLoop: { id: 'none', speed: 1, intensity: 1 },
    color: DEFAULT_COLOR(),
    filter: { id: 'none', amount: 1 },
    lut: { file: null, amount: 1 },
    effects: [],
    mask: DEFAULT_MASK(),
    chroma: DEFAULT_CHROMA(),
    transitionOut: DEFAULT_TRANSITION(),
  };
}

function audioBlock() {
  return { volume: 1, fadeIn: 0, fadeOut: 0, pan: 0, muteAudio: false, audioFx: DEFAULT_AUDIO_FX() };
}

/**
 * Full default clip for a type (without id/trackId). Visual types get the visual block,
 * video/audio get the audio block, media types get mediaId/in/speed/reverse, text & caption get
 * text + textAnim, caption gets caption, shape gets shape, sticker gets sticker.
 */
export function clipDefaults(type) {
  if (!CLIP_TYPES.includes(type)) throw new Error(`סוג קליפ לא מוכר: "${type}". סוגים אפשריים: ${CLIP_TYPES.join(', ')}`);
  const c = {
    type, name: '', start: 0, duration: TYPE_DEFAULT_DURATION[type], tint: null, disabled: false,
    keyframes: {},
  };
  if (MEDIA_TYPES.has(type)) Object.assign(c, { mediaId: null, in: 0, speed: 1, reverse: false });
  if (VISUAL_TYPES.has(type)) Object.assign(c, visualBlock());
  if (AUDIO_CAPABLE_TYPES.has(type)) Object.assign(c, audioBlock());
  if (TEXT_TYPES.has(type)) { c.text = DEFAULT_TEXT(); c.textAnim = DEFAULT_TEXT_ANIM(); }
  if (type === 'caption') { c.caption = DEFAULT_CAPTION(); c.text.content = ''; }
  if (type === 'shape') { c.shape = DEFAULT_SHAPE(); c.fit = 'none'; }
  if (type === 'sticker') { c.sticker = DEFAULT_STICKER(); c.fit = 'none'; }
  if (type === 'text' || type === 'caption') c.fit = 'none';
  if (type === 'effect' || type === 'adjustment') c.fit = 'fill';
  return c;
}

/** "cover" if media aspect is within 5% of the canvas aspect, else "contain". */
export function defaultFit(media, settings) {
  const W = settings?.width || 1080, H = settings?.height || 1920;
  if (!media || !media.width || !media.height) return 'contain';
  const a = media.width / media.height, b = W / H;
  return Math.abs(a / b - 1) <= 0.05 ? 'cover' : 'contain';
}

/**
 * newClip(type, props, {media, settings}?) — every field filled with defaults, deep-merged with props.
 * `props.color` given as a string is treated as the timeline tint (stored in `tint`).
 */
export function newClip(type, props = {}, opts = {}) {
  const p = { ...(props || {}) };
  if (typeof p.color === 'string') { p.tint = p.color; delete p.color; }
  let c = clipDefaults(type);
  if ((type === 'video' || type === 'image') && opts.media && p.fit === undefined) c.fit = defaultFit(opts.media, opts.settings);
  c = deepMerge(c, p);
  c.type = type;
  c.id = p.id || uid('c_');
  if (c.trackId === undefined) c.trackId = null;
  return c;
}

/** Fill any missing fields of an existing clip (older projects, hand-written JSON). Returns a new clip. */
export function normalizeClip(clip) {
  if (!clip || !CLIP_TYPES.includes(clip.type)) return clone(clip);
  const src = { ...clip };
  if (typeof src.color === 'string') { if (!src.tint) src.tint = src.color; delete src.color; }
  const out = deepMerge(clipDefaults(clip.type), src);
  if (!Array.isArray(out.effects) && VISUAL_TYPES.has(out.type)) out.effects = [];
  if (out.type === 'caption' && !Array.isArray(out.caption?.words)) out.caption.words = [];
  return out;
}

export function newTrack(kind, props = {}) {
  if (!TRACK_KINDS.includes(kind)) throw new Error(`סוג ערוץ לא מוכר: "${kind}" (video או audio)`);
  const role = props.role || (kind === 'video' ? 'overlay' : 'sfx');
  const t = {
    id: props.id || uid('t_'), kind, name: ROLE_LABELS[role] || TRACK_KIND_LABELS[kind], role,
    hidden: false, muted: false, locked: false, solo: false, volume: 1,
  };
  return deepMerge(t, { ...props, kind, role });
}

/** Default track stack, top-to-bottom: text, overlay, main, voice, music, sfx. */
export function DEFAULT_TRACKS() {
  return [
    newTrack('video', { id: 't_text', role: 'text', name: 'טקסט' }),
    newTrack('video', { id: 't_overlay', role: 'overlay', name: 'שכבה' }),
    newTrack('video', { id: 't_main', role: 'main', name: 'ראשי' }),
    newTrack('audio', { id: 't_voice', role: 'voice', name: 'קריינות' }),
    newTrack('audio', { id: 't_music', role: 'music', name: 'מוזיקה' }),
    newTrack('audio', { id: 't_sfx', role: 'sfx', name: 'אפקטים קוליים' }),
  ];
}

export function nowIso() {
  try { return new Date().toISOString(); } catch { return '1970-01-01T00:00:00.000Z'; }
}

/** newProject({id, name, width, height, fps, background, tracks:"default"|"empty"|Track[]}) */
export function newProject(opts = {}) {
  const settings = DEFAULT_SETTINGS();
  for (const k of ['width', 'height', 'fps', 'background', 'sampleRate', 'safeArea', 'masterGainDb', 'targetLufs']) {
    if (opts[k] !== undefined && opts[k] !== null) settings[k] = opts[k];
  }
  settings.width = Math.max(16, Math.round(Number(settings.width) || 1080));
  settings.height = Math.max(16, Math.round(Number(settings.height) || 1920));
  settings.fps = Number(settings.fps) > 0 ? Number(settings.fps) : 30;
  const name = opts.name || 'פרויקט חדש';
  const id = isValidProjectId(opts.id) ? opts.id : slugify(opts.id || name);
  let tracks;
  if (Array.isArray(opts.tracks)) tracks = opts.tracks.map((t) => newTrack(t.kind, t));
  else if (opts.tracks === 'empty') tracks = [];
  else tracks = DEFAULT_TRACKS();
  const iso = nowIso();
  return {
    version: MODEL_VERSION, id, name, rev: 0, settings, media: {}, tracks, clips: {}, markers: [],
    transcript: { words: [] },
    meta: { created: iso, modified: iso, lastEditor: 'user' },
  };
}

/** Fill missing top-level structures and normalize every clip. Returns a new project. */
export function normalizeProject(p) {
  const out = clone(p) || {};
  out.version = out.version || MODEL_VERSION;
  out.rev = Number.isFinite(out.rev) ? out.rev : 0;
  out.settings = deepMerge(DEFAULT_SETTINGS(), out.settings || {});
  out.media = isPlainObject(out.media) ? out.media : {};
  out.tracks = Array.isArray(out.tracks) ? out.tracks.map((t) => newTrack(TRACK_KINDS.includes(t.kind) ? t.kind : 'video', t)) : [];
  const clips = {};
  for (const [id, c] of Object.entries(isPlainObject(out.clips) ? out.clips : {})) {
    const n = normalizeClip({ ...c, id: c.id || id });
    clips[n.id] = n;
  }
  out.clips = clips;
  out.markers = Array.isArray(out.markers) ? out.markers.map((m) => ({ id: m.id || uid('mk_'), t: Number(m.t) || 0, label: m.label || '', color: m.color || '#f5c518' })) : [];
  out.transcript = isPlainObject(out.transcript) ? out.transcript : { words: [] };
  if (!Array.isArray(out.transcript.words)) out.transcript.words = [];
  out.meta = deepMerge({ created: nowIso(), modified: nowIso(), lastEditor: 'user' }, out.meta || {});
  return out;
}

// ───────────────────────────── time / query helpers ─────────────────────────────

export function clipEnd(c) { return (c?.start || 0) + (c?.duration || 0); }

export function frameDuration(p) { return 1 / (p?.settings?.fps || 30); }

/** max clip end over all clips, min one frame. */
export function projectDuration(p) {
  const fd = frameDuration(p);
  let end = 0;
  for (const c of Object.values(p?.clips || {})) end = Math.max(end, clipEnd(c));
  return Math.max(fd, round6(end));
}

export function trackById(p, id) { return (p?.tracks || []).find((t) => t.id === id) || null; }
export function trackIndex(p, id) { return (p?.tracks || []).findIndex((t) => t.id === id); }
export function tracksByRole(p, role) { return (p?.tracks || []).filter((t) => t.role === role); }

/** Clips on a track sorted by start (then id for stability). */
export function clipsOnTrack(p, trackId) {
  return Object.values(p?.clips || {})
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => (a.start - b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Clips with start <= t < end, not disabled; ordered by track index (top first) then start. */
export function activeClipsAt(p, t) {
  const order = new Map((p?.tracks || []).map((tr, i) => [tr.id, i]));
  return Object.values(p?.clips || {})
    .filter((c) => !c.disabled && c.start <= t + 1e-9 && t < clipEnd(c) - 1e-9)
    .sort((a, b) => ((order.get(a.trackId) ?? 1e9) - (order.get(b.trackId) ?? 1e9)) || (a.start - b.start));
}

/** The clip on the same track whose start is within one frame of this clip's end (closest), else null. */
export function nextClipOnTrack(p, clip) {
  if (!clip) return null;
  const tol = frameDuration(p) + 1e-6;
  const end = clipEnd(clip);
  let best = null, bestD = Infinity;
  for (const c of Object.values(p?.clips || {})) {
    if (c.id === clip.id || c.trackId !== clip.trackId) continue;
    const d = Math.abs(c.start - end);
    if (d <= tol && d < bestD && c.start > clip.start) { best = c; bestD = d; }
  }
  return best;
}

/** The clip on the same track whose end is within one frame of this clip's start (closest), else null. */
export function prevClipOnTrack(p, clip) {
  if (!clip) return null;
  const tol = frameDuration(p) + 1e-6;
  let best = null, bestD = Infinity;
  for (const c of Object.values(p?.clips || {})) {
    if (c.id === clip.id || c.trackId !== clip.trackId) continue;
    const d = Math.abs(clipEnd(c) - clip.start);
    if (d <= tol && d < bestD && c.start < clip.start) { best = c; bestD = d; }
  }
  return best;
}

/** Max timeline duration a media-backed clip can have given its in-point and speed (Infinity for images/unknown). */
export function maxClipDuration(clip, media) {
  if (!clip || !MEDIA_TYPES.has(clip.type) || clip.type === 'image') return Infinity;
  if (!media || !(media.duration > 0)) return Infinity;
  const sp = clip.speed > 0 ? clip.speed : 1;
  return Math.max(0, (media.duration - (clip.in || 0)) / sp);
}

/**
 * Source time for timeline time t: in + (t-start)*speed, or reversed:
 * in + (duration-(t-start))*speed. Clamped to [0, media.duration] (when known).
 */
export function sourceTimeAt(clip, t, media) {
  const sp = clip?.speed > 0 ? clip.speed : 1;
  const local = t - (clip?.start || 0);
  let s = clip?.reverse ? (clip.in || 0) + ((clip.duration || 0) - local) * sp : (clip?.in || 0) + local * sp;
  const dur = media?.duration;
  if (dur > 0) s = clamp(s, 0, dur); else s = Math.max(0, s);
  return s;
}

export function snapToFrame(t, fps = 30) {
  const f = fps > 0 ? fps : 30;
  return round6(Math.round(t * f) / f);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** "MM:SS:FF" (minutes keep counting past 59). */
export function formatTimecode(t, fps = 30) {
  const f = Math.max(1, Math.round(fps > 0 ? fps : 30));
  const total = Math.max(0, Math.round((Number(t) || 0) * f));
  const ff = total % f;
  const secs = Math.floor(total / f);
  return `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}:${pad2(ff)}`;
}

/**
 * Parse "MM:SS:FF", "HH:MM:SS:FF", "M:SS(.s)" or plain seconds → seconds. Returns NaN when invalid.
 */
export function parseTimecode(str, fps = 30) {
  const s = String(str).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':');
  if (!parts.every((x) => /^\d+(\.\d+)?$/.test(x))) return NaN;
  const n = parts.map(Number);
  const f = fps > 0 ? fps : 30;
  if (n.length === 2) return n[0] * 60 + n[1];
  if (n.length === 3) return n[0] * 60 + n[1] + n[2] / f;
  if (n.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / f;
  return NaN;
}

/** "12.34 שנ'" style short format */
export function formatSeconds(t, digits = 2) {
  return (Number(t) || 0).toFixed(digits);
}

export function dbToGain(db) { return Math.pow(10, (Number(db) || 0) / 20); }
export function gainToDb(g) { return g > 0 ? 20 * Math.log10(g) : -Infinity; }

// ───────────────────────────── validation ─────────────────────────────

/** Returns an array of Hebrew problem strings (empty = valid). */
export function validateProject(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['הפרויקט ריק או לא תקין'];
  if (!isValidProjectId(p.id)) out.push(`מזהה פרויקט לא תקין: "${p.id}" (רק a-z, 0-9 ומקף)`);
  const s = p.settings || {};
  if (!(s.width >= 16 && s.height >= 16)) out.push(`גודל קנבס לא תקין: ${s.width}×${s.height}`);
  if (s.width % 2 || s.height % 2) out.push(`גודל קנבס אי-זוגי (${s.width}×${s.height}) — ייצוא H.264 דורש מידות זוגיות`);
  if (!(s.fps > 0 && s.fps <= 240)) out.push(`קצב פריימים לא תקין: ${s.fps}`);
  if (s.safeArea && !SAFE_AREAS.includes(s.safeArea)) out.push(`אזור בטוח לא מוכר: ${s.safeArea}`);
  const tracks = Array.isArray(p.tracks) ? p.tracks : [];
  if (!Array.isArray(p.tracks)) out.push('חסר מערך ערוצים (tracks)');
  const tIds = new Set();
  for (const t of tracks) {
    if (tIds.has(t.id)) out.push(`מזהה ערוץ כפול: ${t.id}`);
    tIds.add(t.id);
    if (!TRACK_KINDS.includes(t.kind)) out.push(`ערוץ ${t.id}: סוג לא מוכר "${t.kind}"`);
    const okRoles = t.kind === 'audio' ? AUDIO_ROLES : VIDEO_ROLES;
    if (!okRoles.includes(t.role)) out.push(`ערוץ ${t.id}: התפקיד "${t.role}" לא מתאים לערוץ ${TRACK_KIND_LABELS[t.kind] || t.kind}`);
  }
  const fd = frameDuration(p);
  const media = p.media || {};
  const byTrack = new Map();
  for (const [key, c] of Object.entries(p.clips || {})) {
    const label = `קליפ ${key}`;
    if (c.id !== key) out.push(`${label}: המזהה בתוך הקליפ (${c.id}) שונה מהמפתח`);
    if (!CLIP_TYPES.includes(c.type)) { out.push(`${label}: סוג לא מוכר "${c.type}"`); continue; }
    const tr = tracks.find((t) => t.id === c.trackId);
    if (!tr) out.push(`${label}: הערוץ ${c.trackId} לא קיים`);
    else if ((c.type === 'audio') !== (tr.kind === 'audio')) out.push(`${label}: קליפ ${CLIP_TYPE_LABELS[c.type]} בערוץ ${TRACK_KIND_LABELS[tr.kind]}`);
    if (!isFiniteNumber(c.start) || c.start < -1e-9) out.push(`${label}: זמן התחלה לא תקין (${c.start})`);
    if (!isFiniteNumber(c.duration) || c.duration < fd - 1e-6) out.push(`${label}: משך לא תקין (${c.duration})`);
    if (MEDIA_TYPES.has(c.type)) {
      const m = media[c.mediaId];
      if (!c.mediaId || !m) out.push(`${label}: מדיה חסרה (${c.mediaId})`);
      else {
        if (m.status === 'error') out.push(`${label}: המדיה "${m.name}" נכשלה בעיבוד${m.error ? ': ' + m.error : ''}`);
        const max = maxClipDuration(c, m);
        if (Number.isFinite(max) && c.duration > max + fd) out.push(`${label}: ארוך מהמדיה (${c.duration.toFixed(2)} > ${max.toFixed(2)} שנ')`);
        if ((c.in || 0) < -1e-9) out.push(`${label}: נקודת כניסה שלילית`);
        if (c.type === 'video' && m.kind !== 'video') out.push(`${label}: קליפ וידאו על מדיה מסוג ${m.kind}`);
        if (c.type === 'audio' && !m.hasAudio && m.kind !== 'audio') out.push(`${label}: קליפ אודיו על מדיה בלי שמע`);
      }
      if (!(c.speed > 0)) out.push(`${label}: מהירות לא תקינה (${c.speed})`);
    }
    if (c.keyframes) {
      for (const [prop, kfs] of Object.entries(c.keyframes)) {
        if (!isKeyframable(prop)) out.push(`${label}: מאפיין לא ניתן להנפשה "${prop}"`);
        if (!Array.isArray(kfs)) { out.push(`${label}: קיפריימים לא תקינים ל-${prop}`); continue; }
        for (let i = 0; i < kfs.length; i++) {
          if (!isFiniteNumber(kfs[i]?.t) || !isFiniteNumber(kfs[i]?.v)) out.push(`${label}: קיפריים לא תקין ב-${prop}[${i}]`);
          if (i && kfs[i].t < kfs[i - 1].t) out.push(`${label}: קיפריימים לא ממוינים ב-${prop}`);
        }
      }
    }
    if (c.type === 'caption') {
      const words = c.caption?.words || [];
      if (!words.length) out.push(`${label}: כתובית בלי מילים`);
      for (const w of words) {
        if (!(w.s >= c.start - fd - 1e-6 && w.s <= clipEnd(c) + fd)) { out.push(`${label}: המילה "${w.w}" (${(+w.s).toFixed(2)}) מחוץ לטווח הקליפ`); break; }
      }
    }
    if (VISUAL_TYPES.has(c.type) && c.transitionOut && c.transitionOut.id && c.transitionOut.id !== 'none' && tr) {
      if (!nextClipOnTrack(p, c)) out.push(`${label}: מוגדר מעבר "${c.transitionOut.id}" אבל אין קליפ צמוד אחריו באותו ערוץ`);
    }
    if (c.trackId) { if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []); byTrack.get(c.trackId).push(c); }
  }
  for (const [tid, list] of byTrack) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (b.start < clipEnd(a) - 1e-3) out.push(`חפיפה בערוץ ${tid}: ${a.id} (${a.start.toFixed(2)}–${clipEnd(a).toFixed(2)}) ו-${b.id} (${b.start.toFixed(2)}–${clipEnd(b).toFixed(2)})`);
    }
  }
  for (const m of p.markers || []) if (!isFiniteNumber(m.t) || m.t < 0) out.push(`סמן ${m.id}: זמן לא תקין`);
  return out;
}
