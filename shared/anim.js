// shared/anim.js — easings, closed-form springs, keyframe evaluation, clip animation presets, deterministic noise.
// Pure ES module (browser + Node). Renderers call these with (clip, localT): no randomness, no timers.

import { getPath, setPath, clone, FULL_FRAME_TYPES, COLOR_KEYS } from './model.js';

const PI = Math.PI;
const clamp01 = (p) => (p < 0 ? 0 : p > 1 ? 1 : p);
export const lerp = (a, b, p) => a + (b - a) * p;

// ───────────────────────────── springs ─────────────────────────────

function springRaw(t, zeta, omega) {
  if (t <= 0) return 0;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const env = Math.exp(-zeta * omega * t);
    return 1 - env * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-omega * t) * (1 + omega * t);
  // overdamped
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - s), r2 = -omega * (zeta + s);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/**
 * Closed-form (under)damped spring step response on p∈[0,1], normalized so value(0)=0 and value(1)=1 exactly.
 * zeta = damping ratio (0.55 → ~13% overshoot), omega = natural frequency in rad per unit p.
 */
export function spring(p, { zeta = 0.55, omega = 12 } = {}) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const z = Math.max(0.01, zeta), w = Math.max(0.1, omega);
  const end = springRaw(1, z, w);
  const v = springRaw(p, z, w);
  if (end > 0.2) return v / end;
  return v + (1 - end) * p; // very slow springs: keep the endpoint exact without blowing up
}

// ───────────────────────────── easings ─────────────────────────────

const easeOutBounce = (p) => {
  const n1 = 7.5625, d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75; }
  if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375; }
  p -= 2.625 / d1; return n1 * p * p + 0.984375;
};
const C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1, C4 = (2 * PI) / 3, C5 = (2 * PI) / 4.5;

export function easeOutBackS(p, s = C1) { const q = p - 1; return 1 + (s + 1) * q * q * q + s * q * q; }
export function easeInBackS(p, s = C1) { return (s + 1) * p * p * p - s * p * p; }

/** name → fn(p∈[0,1]) → value (0 at 0, 1 at 1; back/elastic/spring/bounce may overshoot). */
export const EASINGS = {
  linear: (p) => p,
  hold: (p) => (p >= 1 ? 1 : 0),
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - Math.pow(1 - p, 3),
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  spring: (p) => spring(p),
  bounce: easeOutBounce,
  back: (p) => easeOutBackS(p),
  elastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * C4) + 1),
  // extended set (usable everywhere an ease name is accepted)
  smooth: (p) => p * p * (3 - 2 * p),
  easeInQuad: (p) => p * p,
  easeOutQuad: (p) => 1 - (1 - p) * (1 - p),
  easeInOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  easeInCubic: (p) => p * p * p,
  easeOutCubic: (p) => 1 - Math.pow(1 - p, 3),
  easeInOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  easeInQuart: (p) => p * p * p * p,
  easeOutQuart: (p) => 1 - Math.pow(1 - p, 4),
  easeInOutQuart: (p) => (p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2),
  easeInExpo: (p) => (p <= 0 ? 0 : Math.pow(2, 10 * p - 10)),
  easeOutExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  easeInOutExpo: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
  easeInSine: (p) => 1 - Math.cos((p * PI) / 2),
  easeOutSine: (p) => Math.sin((p * PI) / 2),
  easeInOutSine: (p) => -(Math.cos(PI * p) - 1) / 2,
  easeInBack: (p) => easeInBackS(p),
  easeOutBack: (p) => easeOutBackS(p),
  easeInOutBack: (p) => (p < 0.5
    ? (Math.pow(2 * p, 2) * ((C2 + 1) * 2 * p - C2)) / 2
    : (Math.pow(2 * p - 2, 2) * ((C2 + 1) * (p * 2 - 2) + C2) + 2) / 2),
  easeInElastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : -Math.pow(2, 10 * p - 10) * Math.sin((p * 10 - 10.75) * C4)),
  easeOutElastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * C4) + 1),
  easeInOutElastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5
    ? -(Math.pow(2, 20 * p - 10) * Math.sin((20 * p - 11.125) * C5)) / 2
    : (Math.pow(2, -20 * p + 10) * Math.sin((20 * p - 11.125) * C5)) / 2 + 1),
  easeOutBounce,
  easeInBounce: (p) => 1 - easeOutBounce(1 - p),
  springSoft: (p) => spring(p, { zeta: 0.75, omega: 10 }),
  springBouncy: (p) => spring(p, { zeta: 0.35, omega: 16 }),
};

/** Cubic bezier easing factory (CSS semantics). */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const x = sx(t) - p, d = dx(t);
      if (Math.abs(x) < 1e-6) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= x / d;
    }
    let lo = 0, hi = 1; t = p;
    for (let i = 0; i < 30; i++) {
      const x = sx(t);
      if (Math.abs(x - p) < 1e-6) break;
      if (x < p) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

const easeCache = new Map();
const PART_RE = /^part\(\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*(.+)\)$/s;
const BEZIER_RE = /^(?:cubic-)?bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i;
const SPRING_RE = /^spring\(\s*([-\d.]+)\s*(?:,\s*([-\d.]+)\s*)?\)$/i;

/** "part(a,b,inner)" → { a, b, inner } or null. */
export function parsePartEase(name) {
  const m = PART_RE.exec(String(name || '').trim());
  return m ? { a: +m[1], b: +m[2], inner: m[3].trim() } : null;
}

const fmtNum = (x) => String(Math.round(x * 1e10) / 1e10);

/**
 * Sub-range of an ease: the curve of `name` between progress a and b, renormalized to 0→1.
 * Used by splitClip so that a keyframe segment cut in two keeps exactly the same motion.
 * Nested parts are flattened.
 */
export function partEase(name, a, b) {
  const p = parsePartEase(name);
  let inner = name || 'linear', A = a, B = b;
  if (p) { inner = p.inner; A = p.a + (p.b - p.a) * a; B = p.a + (p.b - p.a) * b; }
  if (inner === 'linear') return 'linear';
  if (A <= 1e-12 && B >= 1 - 1e-12) return inner;
  return `part(${fmtNum(A)},${fmtNum(B)},${inner})`;
}

/**
 * Resolve an ease name to a function. Accepts EASINGS keys, "bezier(x1,y1,x2,y2)" / "cubic-bezier(...)",
 * "spring(zeta,omega)" and "part(a,b,<ease>)". Unknown → linear.
 */
export function getEase(name) {
  if (typeof name === 'function') return name;
  if (!name) return EASINGS.linear;
  const fn = EASINGS[name];
  if (fn) return fn;
  const s = String(name).trim();
  if (easeCache.has(s)) return easeCache.get(s);
  let f = null;
  let m = BEZIER_RE.exec(s);
  if (m) f = cubicBezier(+m[1], +m[2], +m[3], +m[4]);
  if (!f && (m = SPRING_RE.exec(s))) { const z = +m[1], w = m[2] ? +m[2] : 12; f = (p) => spring(p, { zeta: z, omega: w }); }
  if (!f) {
    const part = parsePartEase(s);
    if (part) {
      const inner = getEase(part.inner);
      const a = part.a, b = part.b;
      const e0 = inner(a), d = inner(b) - e0;
      f = Math.abs(d) < 1e-12 ? EASINGS.linear : (p) => (p <= 0 ? 0 : p >= 1 ? 1 : (inner(a + (b - a) * p) - e0) / d);
    }
  }
  if (!f) return EASINGS.linear;
  if (easeCache.size > 500) easeCache.clear();
  easeCache.set(s, f);
  return f;
}

export function isEaseName(name) {
  if (typeof name !== 'string') return false;
  if (name in EASINGS || BEZIER_RE.test(name) || SPRING_RE.test(name)) return true;
  const p = parsePartEase(name);
  return !!p && isEaseName(p.inner) && p.a >= 0 && p.b <= 1 && p.b > p.a;
}

/** ease(name, p) convenience. */
export function ease(name, p) { return getEase(name)(clamp01(p)); }

// ───────────────────────────── deterministic noise ─────────────────────────────

/** 32-bit string hash (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

function seedInt(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return (Math.floor(seed) ^ Math.floor((seed % 1) * 1e6)) | 0;
  return hashString(seed ?? '');
}

/** hash(seed, n) → [0,1), deterministic. seed: number|string; n: integer (floored). */
export function hash(seed, n = 0) {
  const s = seedInt(seed);
  let x = Math.imul(s ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((Math.floor(n) | 0) + 0x632be5ab, 0xc2b2ae35);
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Smooth 1-D value noise in [0,1). */
export function noise1(t, seed = 0) {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(seed, i), hash(seed, i + 1), u);
}

/** Smooth value noise in (-1,1). */
export function noiseSigned(t, seed = 0) { return noise1(t, seed) * 2 - 1; }

// ───────────────────────────── keyframes ─────────────────────────────

function sortedKfs(kfs) {
  for (let i = 1; i < kfs.length; i++) if (kfs[i].t < kfs[i - 1].t) return kfs.slice().sort((a, b) => a.t - b.t);
  return kfs;
}

/**
 * Interpolate a keyframe list at time t. The ease on keyframe k shapes the segment ARRIVING at k.
 * Before the first keyframe → first value; after the last → last value.
 */
export function interpolateKeyframes(kfsIn, t, fallback = 0) {
  if (!Array.isArray(kfsIn) || !kfsIn.length) return fallback;
  const kfs = sortedKfs(kfsIn);
  if (kfs.length === 1 || t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = kfs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (kfs[mid].t <= t) lo = mid; else hi = mid; }
  const a = kfs[lo], b = kfs[hi];
  const span = b.t - a.t;
  if (span <= 1e-9) return b.v;
  const p = (t - a.t) / span;
  return a.v + (b.v - a.v) * getEase(b.ease || 'linear')(p);
}

/** Value of `prop` ("transform.x", "effects.0.strength", …) at clip-local time. */
export function evalKeyframed(clip, prop, localT, fallback) {
  const kfs = clip?.keyframes?.[prop];
  let base = fallback;
  if (base === undefined) {
    const raw = getPath(clip, prop);
    base = typeof raw === 'number' ? raw : raw === undefined ? 0 : Number(raw) || 0;
  }
  if (!Array.isArray(kfs) || !kfs.length) return base;
  return interpolateKeyframes(kfs, localT, base);
}

export function hasKeyframes(clip, prop) {
  if (!clip?.keyframes) return false;
  if (prop) return Array.isArray(clip.keyframes[prop]) && clip.keyframes[prop].length > 0;
  return Object.values(clip.keyframes).some((k) => Array.isArray(k) && k.length > 0);
}

/** Keyframe at local time t (within tol) or null. */
export function keyframeAt(clip, prop, t, tol = 1e-3) {
  const kfs = clip?.keyframes?.[prop];
  if (!Array.isArray(kfs)) return null;
  return kfs.find((k) => Math.abs(k.t - t) <= tol) || null;
}

/** Sorted unique keyframe times (clip-local) over all props or one prop. */
export function keyframeTimes(clip, prop) {
  const set = new Set();
  const props = prop ? [prop] : Object.keys(clip?.keyframes || {});
  for (const p of props) for (const k of clip?.keyframes?.[p] || []) set.add(Math.round(k.t * 1e6) / 1e6);
  return [...set].sort((a, b) => a - b);
}

const DEF_TRANSFORM = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5, flipX: false, flipY: false };

/**
 * Resolve every keyframed property of a clip at local time.
 * Returns { transform, opacity, volume, pan, color, crop, effects:[{id,params,enabled}], mask, filterAmount, lutAmount,
 *           text?:{size,letterSpacing}, shape?:{…}, values:{prop:value} }.
 */
export function evalClipProps(clip, localT) {
  const t = Number(localT) || 0;
  const transform = { ...DEF_TRANSFORM, ...(clip?.transform || {}) };
  for (const k of ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY']) {
    const base = Number(transform[k]);
    transform[k] = evalKeyframed(clip, 'transform.' + k, t, Number.isFinite(base) ? base : DEF_TRANSFORM[k]);
  }
  const color = {};
  for (const k of COLOR_KEYS) color[k] = evalKeyframed(clip, 'color.' + k, t, Number(clip?.color?.[k]) || 0);
  for (const k of Object.keys(clip?.color || {})) if (!(k in color)) color[k] = evalKeyframed(clip, 'color.' + k, t, Number(clip.color[k]) || 0);
  const crop = {};
  for (const k of ['l', 't', 'r', 'b']) crop[k] = evalKeyframed(clip, 'crop.' + k, t, Number(clip?.crop?.[k]) || 0);
  const effects = (clip?.effects || []).map((fx, i) => {
    const params = { ...(fx.params || {}) };
    const prefix = `effects.${i}.`;
    for (const prop of Object.keys(clip?.keyframes || {})) {
      if (prop.startsWith(prefix)) {
        const key = prop.slice(prefix.length);
        params[key] = evalKeyframed(clip, prop, t, Number(params[key]) || 0);
      }
    }
    return { id: fx.id, params, enabled: fx.enabled !== false };
  });
  const mask = { ...(clip?.mask || {}) };
  for (const k of ['x', 'y', 'w', 'h', 'rotation', 'feather']) if (k in mask || clip?.keyframes?.['mask.' + k]) mask[k] = evalKeyframed(clip, 'mask.' + k, t, Number(mask[k]) || 0);
  const out = {
    transform,
    opacity: transform.opacity,
    volume: evalKeyframed(clip, 'volume', t, clip?.volume ?? 1),
    pan: evalKeyframed(clip, 'pan', t, clip?.pan ?? 0),
    color,
    crop,
    effects,
    mask,
    filterAmount: evalKeyframed(clip, 'filter.amount', t, clip?.filter?.amount ?? 1),
    lutAmount: evalKeyframed(clip, 'lut.amount', t, clip?.lut?.amount ?? 1),
    values: {},
  };
  if (clip?.text) out.text = { size: evalKeyframed(clip, 'text.size', t, clip.text.size ?? 96), letterSpacing: evalKeyframed(clip, 'text.letterSpacing', t, clip.text.letterSpacing ?? 0) };
  if (clip?.shape) {
    out.shape = { ...clip.shape };
    for (const k of ['w', 'h', 'radius', 'strokeWidth', 'progressFrom', 'progressTo']) out.shape[k] = evalKeyframed(clip, 'shape.' + k, t, Number(clip.shape[k]) || 0);
  }
  for (const prop of Object.keys(clip?.keyframes || {})) out.values[prop] = evalKeyframed(clip, prop, t);
  return out;
}

/** Return a copy of the clip with every keyframed prop baked to its value at localT (handy for inspectors). */
export function bakeClipAt(clip, localT) {
  let c = clone(clip);
  for (const prop of Object.keys(clip?.keyframes || {})) c = setPath(c, prop, evalKeyframed(clip, prop, localT));
  return c;
}

/** Linear fade-in/fade-out gain multiplier at clip-local time (audio clips; also usable for visual fades). */
export function fadeGain(clip, localT) {
  const D = clip?.duration || 0;
  let g = 1;
  const fi = Math.max(0, clip?.fadeIn || 0), fo = Math.max(0, clip?.fadeOut || 0);
  if (fi > 0 && localT < fi) g *= clamp01(localT / fi);
  if (fo > 0 && localT > D - fo) g *= clamp01((D - localT) / fo);
  return g;
}

// ───────────────────────────── clip animation presets ─────────────────────────────

export const CLIP_ANIMS = {
  in: [
    { id: 'none', name: 'ללא' },
    { id: 'fadeIn', name: 'דהייה פנימה', defaultDuration: 0.5 },
    { id: 'zoomIn', name: 'זום פנימה', defaultDuration: 0.45 },
    { id: 'zoomOut', name: 'זום החוצה', defaultDuration: 0.45 },
    { id: 'slideLeft', name: 'החלקה שמאלה', defaultDuration: 0.45 },
    { id: 'slideRight', name: 'החלקה ימינה', defaultDuration: 0.45 },
    { id: 'slideUp', name: 'החלקה למעלה', defaultDuration: 0.45 },
    { id: 'slideDown', name: 'החלקה למטה', defaultDuration: 0.45 },
    { id: 'pop', name: 'קפיצה', defaultDuration: 0.4 },
    { id: 'bounceIn', name: 'קפיצת גומי', defaultDuration: 0.6 },
    { id: 'spinIn', name: 'סיבוב פנימה', defaultDuration: 0.5 },
    { id: 'blurIn', name: 'טשטוש פנימה', defaultDuration: 0.45 },
    { id: 'dropIn', name: 'נפילה', defaultDuration: 0.7 },
    { id: 'swingIn', name: 'נדנוד פנימה', defaultDuration: 0.7 },
    { id: 'flipIn', name: 'היפוך פנימה', defaultDuration: 0.5 },
    { id: 'stretchIn', name: 'מתיחה', defaultDuration: 0.5 },
    { id: 'glitchIn', name: 'גליץ\' פנימה', defaultDuration: 0.4 },
    { id: 'whipIn', name: 'שוט פנימה', defaultDuration: 0.3 },
    { id: 'riseIn', name: 'עלייה רכה', defaultDuration: 0.5 },
    { id: 'slamIn', name: 'נחיתה חזקה', defaultDuration: 0.35 },
  ],
  out: [
    { id: 'none', name: 'ללא' },
    { id: 'fadeOut', name: 'דהייה החוצה', defaultDuration: 0.5 },
    { id: 'zoomIn', name: 'זום פנימה', defaultDuration: 0.45 },
    { id: 'zoomOut', name: 'זום החוצה', defaultDuration: 0.45 },
    { id: 'slideLeft', name: 'החלקה שמאלה', defaultDuration: 0.45 },
    { id: 'slideRight', name: 'החלקה ימינה', defaultDuration: 0.45 },
    { id: 'slideUp', name: 'החלקה למעלה', defaultDuration: 0.45 },
    { id: 'slideDown', name: 'החלקה למטה', defaultDuration: 0.45 },
    { id: 'popOut', name: 'קפיצה החוצה', defaultDuration: 0.35 },
    { id: 'spinOut', name: 'סיבוב החוצה', defaultDuration: 0.5 },
    { id: 'blurOut', name: 'טשטוש החוצה', defaultDuration: 0.45 },
    { id: 'dropOut', name: 'נפילה החוצה', defaultDuration: 0.55 },
    { id: 'flipOut', name: 'היפוך החוצה', defaultDuration: 0.45 },
    { id: 'whipOut', name: 'שוט החוצה', defaultDuration: 0.3 },
    { id: 'glitchOut', name: 'גליץ\' החוצה', defaultDuration: 0.4 },
    { id: 'sinkOut', name: 'שקיעה רכה', defaultDuration: 0.45 },
  ],
  loop: [
    { id: 'none', name: 'ללא' },
    { id: 'pulse', name: 'פעימה' },
    { id: 'float', name: 'ריחוף' },
    { id: 'shake', name: 'רעידה' },
    { id: 'wobble', name: 'התנודדות' },
    { id: 'spin', name: 'סיבוב' },
    { id: 'swing', name: 'נדנוד' },
    { id: 'heartbeat', name: 'דופק' },
    { id: 'flicker', name: 'הבהוב' },
    { id: 'kenBurns', name: 'קן ברנס' },
    { id: 'drift', name: 'סחיפה' },
    { id: 'breathe', name: 'נשימה' },
    { id: 'jiggle', name: 'רטט' },
    { id: 'bounce', name: 'קפיצות' },
    { id: 'glitch', name: 'גליץ\' מחזורי' },
  ],
};

const eOutCubic = EASINGS.easeOutCubic, eInCubic = EASINGS.easeInCubic, eOutQuad = EASINGS.easeOutQuad,
  eInQuad = EASINGS.easeInQuad, eOutExpo = EASINGS.easeOutExpo, eInExpo = EASINGS.easeInExpo, eInOutSine = EASINGS.easeInOutSine;
const fadeUp = (p, speed) => clamp01(p * speed);

// Each in-preset: (p∈[0,1] progress of the intro, ctx) → partial state; identity at p=1.
// ctx = { W, H, full, unit, seed, D, localT }
const IN = {
  fadeIn: (p) => ({ opacity: eInOutSine(p) }),
  zoomIn: (p, c) => c.full
    ? { scale: lerp(0.72, 1, eOutCubic(p)), opacity: eOutQuad(fadeUp(p, 2)) }
    : { scale: lerp(0.35, 1, easeOutBackS(p, 1.4)), opacity: fadeUp(p, 2.5) },
  zoomOut: (p, c) => c.full
    ? { scale: lerp(1.38, 1, eOutCubic(p)), opacity: fadeUp(p, 2.5) }
    : { scale: lerp(1.9, 1, eOutCubic(p)), opacity: eOutQuad(fadeUp(p, 2)) },
  slideLeft: (p, c) => slideIn(p, c, 1, 0),
  slideRight: (p, c) => slideIn(p, c, -1, 0),
  slideUp: (p, c) => slideIn(p, c, 0, 1),
  slideDown: (p, c) => slideIn(p, c, 0, -1),
  pop: (p) => ({ scale: Math.max(0, spring(p, { zeta: 0.42, omega: 15 })), opacity: fadeUp(p, 5) }),
  bounceIn: (p) => ({ scale: lerp(0.25, 1, spring(p, { zeta: 0.26, omega: 20 })), opacity: fadeUp(p, 4) }),
  spinIn: (p, c) => { const e = eOutCubic(p); return { rotation: -(1 - e) * (c.full ? 90 : 200), scale: lerp(c.full ? 0.5 : 0.2, 1, e), opacity: fadeUp(p, 2.2) }; },
  blurIn: (p, c) => { const e = eOutCubic(p); return { blur: (1 - e) * 26 * c.unit, opacity: eOutQuad(fadeUp(p, 1.4)), scale: lerp(1.12, 1, e) }; },
  dropIn: (p, c) => ({ dy: -(1 - easeOutBounce(p)) * (c.full ? c.H * 0.55 : 460 * c.unit), opacity: fadeUp(p, 6) }),
  swingIn: (p) => ({ rotation: -38 * (1 - spring(p, { zeta: 0.3, omega: 17 })), opacity: fadeUp(p, 3.5), scale: lerp(0.9, 1, eOutCubic(p)) }),
  flipIn: (p) => { const a = (1 - easeOutBackS(p, 1.6)) * (PI / 2); return { scaleX: Math.max(0.001, Math.cos(a)), opacity: fadeUp(p, 3) }; },
  stretchIn: (p) => { const s = spring(p, { zeta: 0.38, omega: 16 }); return { scaleX: lerp(1.9, 1, s), scaleY: lerp(0.18, 1, s), opacity: fadeUp(p, 3) }; },
  glitchIn: (p, c) => glitchState(1 - p, p, c, 7),
  whipIn: (p, c) => { const e = eOutExpo(p); return { dx: (1 - e) * (c.full ? c.W : 620 * c.unit), blur: (1 - e) * 32 * c.unit, scaleX: 1 + 0.28 * (1 - e), opacity: c.full ? 1 : fadeUp(p, 3) }; },
  riseIn: (p, c) => { const e = eOutCubic(p); return { dy: (1 - e) * 70 * c.unit, opacity: eOutQuad(p), scale: lerp(0.96, 1, e) }; },
  slamIn: (p, c) => {
    const k = clamp01(p / 0.55);
    const e = eInQuad(k);
    const st = { scale: lerp(c.full ? 1.6 : 2.4, 1, e), opacity: fadeUp(p, 4) };
    if (p > 0.55) {
      const q = (p - 0.55) / 0.45, damp = (1 - q) * (1 - q);
      st.dx = Math.sin(q * 38) * 12 * c.unit * damp;
      st.dy = Math.cos(q * 31) * 9 * c.unit * damp;
      st.scale *= 1 + 0.04 * damp * Math.cos(q * 20);
    }
    return st;
  },
};

function slideIn(p, c, sx, sy) {
  const e = eOutCubic(p);
  if (c.full) return { dx: sx * (1 - e) * c.W, dy: sy * (1 - e) * c.H };
  const d = 170 * c.unit;
  return { dx: sx * (1 - e) * d, dy: sy * (1 - e) * d, opacity: eOutQuad(fadeUp(p, 1.8)) };
}

function slideOut(q, c, sx, sy) {
  const e = eInCubic(q);
  if (c.full) return { dx: sx * e * c.W, dy: sy * e * c.H };
  const d = 170 * c.unit;
  return { dx: sx * e * d, dy: sy * e * d, opacity: 1 - clamp01((q - 0.35) / 0.65) };
}

/** Glitch helper: g = strength (1 → 0), step-quantized jitter (24 steps/s of the anim). */
function glitchState(g, p, c, salt) {
  if (g <= 0.001) return {};
  const n = Math.floor((c.localT || p) * 24);
  const jx = (hash(c.seed + salt, n) - 0.5) * 2;
  const jy = (hash(c.seed + salt + 1, n) - 0.5) * 2;
  const flick = hash(c.seed + salt + 2, n);
  return {
    dx: jx * 46 * c.unit * g,
    dy: jy * 10 * c.unit * g,
    scaleX: 1 + (hash(c.seed + salt + 3, n) - 0.5) * 0.12 * g,
    opacity: flick < 0.28 * g ? 0.25 : 1 - 0.2 * g * flick,
    glitch: clamp01(g * (0.6 + 0.4 * flick)),
  };
}

// Each out-preset: (q∈[0,1] progress of the outro, ctx) → partial state; identity at q=0.
const OUT = {
  fadeOut: (q) => ({ opacity: 1 - eInOutSine(q) }),
  zoomIn: (q, c) => ({ scale: lerp(1, c.full ? 1.38 : 1.9, eInCubic(q)), opacity: 1 - eInQuad(q) }),
  zoomOut: (q, c) => ({ scale: lerp(1, c.full ? 0.72 : 0.35, eInCubic(q)), opacity: 1 - eInQuad(q) }),
  slideLeft: (q, c) => slideOut(q, c, -1, 0),
  slideRight: (q, c) => slideOut(q, c, 1, 0),
  slideUp: (q, c) => slideOut(q, c, 0, -1),
  slideDown: (q, c) => slideOut(q, c, 0, 1),
  popOut: (q) => {
    const scale = q < 0.3 ? lerp(1, 1.14, eOutQuad(q / 0.3)) : lerp(1.14, 0, eInCubic((q - 0.3) / 0.7));
    return { scale: Math.max(0, scale), opacity: 1 - clamp01((q - 0.65) / 0.35) };
  },
  spinOut: (q, c) => { const e = eInCubic(q); return { rotation: e * (c.full ? 90 : 200), scale: lerp(1, c.full ? 0.5 : 0.2, e), opacity: 1 - eInQuad(q) }; },
  blurOut: (q, c) => { const e = eInCubic(q); return { blur: e * 26 * c.unit, opacity: 1 - eInQuad(q), scale: lerp(1, 1.12, e) }; },
  dropOut: (q, c) => ({ dy: eInQuad(q) * (c.full ? c.H * 0.7 : 640 * c.unit), rotation: eInQuad(q) * 14, opacity: 1 - clamp01((q - 0.5) / 0.5) }),
  flipOut: (q) => ({ scaleX: Math.max(0.001, Math.cos(clamp01(eInCubic(q)) * (PI / 2))), opacity: 1 - clamp01((q - 0.75) / 0.25) }),
  whipOut: (q, c) => { const e = eInExpo(q); return { dx: -e * (c.full ? c.W : 620 * c.unit), blur: e * 32 * c.unit, scaleX: 1 + 0.28 * e, opacity: c.full ? 1 : 1 - clamp01((q - 0.6) / 0.4) }; },
  glitchOut: (q, c) => { const st = glitchState(q, q, c, 11); if (q > 0.85) st.opacity = 0; return st; },
  sinkOut: (q, c) => { const e = eInCubic(q); return { dy: e * 70 * c.unit, opacity: 1 - eInQuad(q), scale: lerp(1, 0.96, e) }; },
};

const bump = (ph, center, width) => { const x = (ph - center) / width; return x <= 0 || x >= 1 ? 0 : Math.sin(PI * x); };

// Each loop: (tt = (localT+offset)*speed, a = intensity, ctx) → partial state.
const LOOP = {
  pulse: (tt, a) => ({ scale: 1 + 0.06 * a * (0.5 - 0.5 * Math.cos((2 * PI * tt) / 0.9)) }),
  float: (tt, a, c) => ({ dy: -14 * a * c.unit * Math.sin((2 * PI * tt) / 2.4), rotation: 1.2 * a * Math.sin((2 * PI * tt) / 3.1) }),
  shake: (tt, a, c) => ({
    dx: noiseSigned(tt * 14, c.seed) * 9 * a * c.unit,
    dy: noiseSigned(tt * 14, c.seed + 7) * 9 * a * c.unit,
    rotation: noiseSigned(tt * 10, c.seed + 13) * 1.2 * a,
  }),
  wobble: (tt, a) => {
    const w = Math.sin((2 * PI * tt) / 0.8);
    return { rotation: 4 * a * w, scaleX: 1 + 0.03 * a * Math.cos((2 * PI * tt) / 0.8), scaleY: 1 - 0.03 * a * Math.cos((2 * PI * tt) / 0.8) };
  },
  spin: (tt, a) => ({ rotation: (tt * 120 * a) % 360 }),
  swing: (tt, a) => ({ rotation: 9 * a * Math.sin((2 * PI * tt) / 1.6) }),
  heartbeat: (tt, a) => {
    const ph = ((tt % 1.1) + 1.1) % 1.1;
    return { scale: 1 + 0.09 * a * (bump(ph, 0, 0.16) + 0.65 * bump(ph, 0.24, 0.16)) };
  },
  flicker: (tt, a, c) => {
    const h = hash(c.seed + 21, Math.floor(tt * 15));
    return { opacity: h < 0.14 * a ? 0.25 : h < 0.3 * a ? 0.7 : 1 - 0.05 * a * h };
  },
  kenBurns: (tt, a, c) => {
    const span = c.loop.span > 0 ? c.loop.span : Math.max(0.001, c.D + (c.loop.offset || 0));
    const pr = clamp01(tt / span);
    const e = eInOutSine(pr);
    return { scale: 1 + 0.12 * a * e, dx: -0.025 * c.W * a * (e - 0.5), dy: -0.012 * c.H * a * (e - 0.5) };
  },
  drift: (tt, a, c) => ({
    dx: 0.02 * c.W * a * Math.sin((2 * PI * tt) / 9),
    dy: 0.012 * c.H * a * Math.sin((2 * PI * tt) / 11 + 1),
    rotation: 0.6 * a * Math.sin((2 * PI * tt) / 13),
  }),
  breathe: (tt, a) => { const b = 0.5 - 0.5 * Math.cos((2 * PI * tt) / 3.2); return { scale: 1 + 0.025 * a * b, opacity: 1 - 0.04 * a * (1 - b) }; },
  jiggle: (tt, a, c) => ({ rotation: noiseSigned(tt * 8, c.seed + 5) * 3.5 * a, scale: 1 + 0.015 * a * noiseSigned(tt * 9, c.seed + 3) }),
  bounce: (tt, a, c) => {
    const ph = (((tt % 0.8) + 0.8) % 0.8) / 0.8;
    const h = Math.sin(PI * ph);
    const squash = Math.pow(1 - h, 6);
    return { dy: -38 * c.unit * a * h, scaleY: 1 - 0.09 * a * squash, scaleX: 1 + 0.09 * a * squash };
  },
  glitch: (tt, a, c) => {
    const period = 1.3, slot = Math.floor(tt / period), ph = tt - slot * period;
    const len = 0.12 + 0.12 * hash(c.seed + 31, slot);
    if (ph > len || hash(c.seed + 37, slot) < 0.25) return {};
    const st = glitchState(a, ph / len, { ...c, localT: tt }, 41);
    return st;
  },
};

const IDENT = () => ({ dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, blur: 0, glitch: 0 });

function combine(st, part) {
  if (!part) return;
  if (part.dx) st.dx += part.dx;
  if (part.dy) st.dy += part.dy;
  if (part.rotation) st.rotation += part.rotation;
  if (part.scale !== undefined) st.scale *= part.scale;
  if (part.scaleX !== undefined) st.scaleX *= part.scaleX;
  if (part.scaleY !== undefined) st.scaleY *= part.scaleY;
  if (part.opacity !== undefined) st.opacity *= part.opacity;
  if (part.blur) st.blur = Math.max(st.blur, part.blur);
  if (part.glitch) st.glitch = Math.max(st.glitch, part.glitch);
}

/** Effective in/out durations after fitting them into the clip (proportionally shortened when they overlap). */
export function animDurations(clip) {
  const D = Math.max(0, clip?.duration || 0);
  let inD = clip?.animIn && clip.animIn.id && clip.animIn.id !== 'none' ? Math.max(0, Number(clip.animIn.duration) || 0) : 0;
  let outD = clip?.animOut && clip.animOut.id && clip.animOut.id !== 'none' ? Math.max(0, Number(clip.animOut.duration) || 0) : 0;
  if (inD + outD > D && inD + outD > 0) { const k = D / (inD + outD); inD *= k; outD *= k; }
  return { inD, outD, D };
}

/**
 * animState(clip, localT, canvasW, canvasH) → { dx, dy, scale, scaleX, scaleY, rotation, opacity, blur, glitch }
 * dx/dy in canvas px, rotation in degrees, blur = radius in canvas px (multiply by preview scale), glitch 0..1.
 * In-animation during the first animIn.duration, out-animation during the last animOut.duration, loop always.
 * animLoop.offset (s) shifts loop phase (set by splitClip so loops stay continuous); animLoop.span (s) is the
 * total length used by progress-based loops (kenBurns).
 */
export function animState(clip, localT, canvasW = 1080, canvasH = 1920) {
  const st = IDENT();
  if (!clip) return st;
  const W = canvasW || 1080, H = canvasH || 1920;
  const { inD, outD, D } = animDurations(clip);
  const t = Number(localT) || 0;
  const loop = clip.animLoop || {};
  const ctx = {
    W, H, D, localT: t, loop,
    full: FULL_FRAME_TYPES.has(clip.type),
    unit: Math.min(W, H) / 1080,
    seed: hashString(clip.id || 'clip') & 0x7fffffff,
  };
  if (inD > 0) {
    const fn = IN[clip.animIn.id];
    if (fn && t < inD) combine(st, fn(clamp01(t / inD), ctx));
  }
  if (outD > 0) {
    const fn = OUT[clip.animOut.id];
    if (fn && t > D - outD) combine(st, fn(clamp01((t - (D - outD)) / outD), ctx));
  }
  if (loop.id && loop.id !== 'none') {
    const fn = LOOP[loop.id];
    if (fn) {
      const speed = Number.isFinite(loop.speed) ? loop.speed : 1;
      const a = Number.isFinite(loop.intensity) ? loop.intensity : 1;
      combine(st, fn((t + (Number(loop.offset) || 0)) * speed, a, ctx));
    }
  }
  if (st.opacity < 0) st.opacity = 0;
  if (st.opacity > 1) st.opacity = 1;
  return st;
}

export const CLIP_ANIM_IDS = {
  in: CLIP_ANIMS.in.map((a) => a.id),
  out: CLIP_ANIMS.out.map((a) => a.id),
  loop: CLIP_ANIMS.loop.map((a) => a.id),
};

export function isClipAnim(kind, id) { return !!CLIP_ANIM_IDS[kind]?.includes(id); }
