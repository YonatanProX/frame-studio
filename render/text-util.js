// Frame Studio — text-render helpers: math, easing, deterministic noise, colors, canvas helpers.
// Pure ES module, importable in Node and in the browser (no DOM access at module top level).

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const num = (v, d) => (isNum(v) ? v : d);
export const DEG = Math.PI / 180;

// ───────────────────────────── easing ─────────────────────────────
// All take p (clamped to [0,1]) and return the eased value (back/elastic/bounce/spring may overshoot).

export function outBack(p, c1 = 1.70158) {
  p = clamp01(p);
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}
/** The exact "outBack" used by the Chordix workshop compositor (c1 = 1.9). */
export const outBackChordix = (p) => outBack(p, 1.9);
export function inBack(p, c1 = 1.70158) {
  p = clamp01(p);
  return (c1 + 1) * p * p * p - c1 * p * p;
}
export function outBounce(p) {
  p = clamp01(p);
  const n1 = 7.5625, d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75; }
  if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375; }
  p -= 2.625 / d1;
  return n1 * p * p + 0.984375;
}
export function outElastic(p) {
  p = clamp01(p);
  if (p === 0 || p === 1) return p;
  const c4 = (2 * Math.PI) / 3.2;
  return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
}
/** Underdamped spring step response normalized so value(0)=0 and value(1)=1 exactly. */
export function spring(p, zeta = 0.55, omega = 12) {
  p = clamp01(p);
  if (p === 0) return 0;
  if (p === 1) return 1;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const f = (x) => 1 - Math.exp(-zeta * omega * x) * (Math.cos(wd * x) + ((zeta * omega) / wd) * Math.sin(wd * x));
  const f1 = f(1);
  // blend the tiny residual so the curve lands exactly on 1 at p=1
  return f(p) + (1 - f1) * p;
}

export const EASE = {
  linear: (p) => clamp01(p),
  in2: (p) => { p = clamp01(p); return p * p; },
  out2: (p) => { p = clamp01(p); return 1 - (1 - p) * (1 - p); },
  inOut2: (p) => { p = clamp01(p); return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; },
  in3: (p) => { p = clamp01(p); return p * p * p; },
  out3: (p) => { p = clamp01(p); return 1 - Math.pow(1 - p, 3); },
  inOut3: (p) => { p = clamp01(p); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
  out4: (p) => { p = clamp01(p); return 1 - Math.pow(1 - p, 4); },
  out5: (p) => { p = clamp01(p); return 1 - Math.pow(1 - p, 5); },
  outExpo: (p) => { p = clamp01(p); return p === 1 ? 1 : 1 - Math.pow(2, -10 * p); },
  inExpo: (p) => { p = clamp01(p); return p === 0 ? 0 : Math.pow(2, 10 * p - 10); },
  outSine: (p) => Math.sin((clamp01(p) * Math.PI) / 2),
  inOutSine: (p) => -(Math.cos(Math.PI * clamp01(p)) - 1) / 2,
  outBack: (p) => outBack(p),
  outBackChordix,
  inBack: (p) => inBack(p),
  outBounce,
  outElastic,
  spring: (p) => spring(p),
  step: (p) => (p > 0 ? 1 : 0),
};
export const out3 = EASE.out3;
export const out2 = EASE.out2;
export const in3 = EASE.in3;

// ───────────────────────────── deterministic noise ─────────────────────────────

/** Deterministic hash → [0,1). Same inputs always give the same output (no Math.random at render time). */
export function hash(seed, n = 0) {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((n | 0) + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** String → 32-bit seed. */
export function strSeed(s) {
  let h = 2166136261 >>> 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h | 0;
}
/** Smooth 1-D value noise in [-1,1]. */
export function noise1(t, seed = 0) {
  const i = Math.floor(t), f = t - i;
  const a = hash(seed, i) * 2 - 1, b = hash(seed, i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

// ───────────────────────────── objects ─────────────────────────────

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
/** Deep merge (new object). Arrays and non-plain values in b replace; undefined in b is ignored; null replaces. */
export function deepMerge(a, b) {
  if (b === undefined) return cloneDeep(a);
  if (!isPlainObject(a) || !isPlainObject(b)) return cloneDeep(b);
  const out = {};
  for (const k of Object.keys(a)) out[k] = cloneDeep(a[k]);
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (bv === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(bv) ? deepMerge(out[k], bv) : cloneDeep(bv);
  }
  return out;
}
export function cloneDeep(v) {
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (isPlainObject(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = cloneDeep(v[k]); return o; }
  return v;
}
/** Values of `obj` that differ from `base` (deep). Returns undefined if nothing differs. */
export function diffFrom(obj, base) {
  if (!isPlainObject(obj)) return JSON.stringify(obj) === JSON.stringify(base) ? undefined : obj;
  if (!isPlainObject(base)) return obj;
  let out;
  for (const k of Object.keys(obj)) {
    const d = isPlainObject(obj[k]) && isPlainObject(base[k]) ? diffFrom(obj[k], base[k])
      : (JSON.stringify(obj[k]) === JSON.stringify(base[k]) ? undefined : obj[k]);
    if (d !== undefined) { out = out || {}; out[k] = d; }
  }
  return out;
}

// ───────────────────────────── colors ─────────────────────────────

const NAMED = {
  black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1], cyan: [0, 255, 255, 1], magenta: [255, 0, 255, 1], orange: [255, 165, 0, 1],
  gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], pink: [255, 192, 203, 1], purple: [128, 0, 128, 1],
  transparent: [0, 0, 0, 0], none: [0, 0, 0, 0],
};
const colorCache = new Map();

/** Parse a CSS color → [r,g,b,a] (0..255, a 0..1) or null when not understood. */
export function parseColor(c) {
  if (c == null) return null;
  if (Array.isArray(c)) return c.length >= 3 ? [c[0], c[1], c[2], c.length > 3 ? c[3] : 1] : null;
  const s = String(c).trim().toLowerCase();
  if (colorCache.has(s)) return colorCache.get(s);
  let out = null;
  if (s[0] === '#') {
    const h = s.slice(1);
    if (/^[0-9a-f]+$/.test(h)) {
      if (h.length === 3 || h.length === 4) {
        out = [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1];
      } else if (h.length === 6 || h.length === 8) {
        out = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
      }
    }
  } else if (s.startsWith('rgb')) {
    const m = s.match(/rgba?\(([^)]*)\)/);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const ch = (v) => (v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v));
        const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
        out = [ch(parts[0]), ch(parts[1]), ch(parts[2]), isNum(a) ? a : 1];
      }
    }
  } else if (s.startsWith('hsl')) {
    const m = s.match(/hsla?\(([^)]*)\)/);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const hh = parseFloat(parts[0]), ss = parseFloat(parts[1]) / 100, ll = parseFloat(parts[2]) / 100;
        const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
        out = [...hslToRgb(hh, ss, ll), isNum(a) ? a : 1];
      }
    }
  } else if (NAMED[s]) {
    out = NAMED[s].slice();
  }
  if (out && out.some((v) => !isNum(v))) out = null;
  if (colorCache.size > 2000) colorCache.clear();
  colorCache.set(s, out);
  return out;
}
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}
export function rgbaCss(c) {
  if (!c) return 'rgba(0,0,0,0)';
  const a = Math.round(clamp01(c[3]) * 1000) / 1000;
  return `rgba(${Math.round(clamp(c[0], 0, 255))},${Math.round(clamp(c[1], 0, 255))},${Math.round(clamp(c[2], 0, 255))},${a})`;
}
/** Color with its alpha multiplied by k (falls back to the original string if unparseable). */
export function withAlpha(color, k) {
  const c = parseColor(color);
  if (!c) return color;
  return rgbaCss([c[0], c[1], c[2], c[3] * k]);
}
export function alphaOf(color) {
  const c = parseColor(color);
  return c ? c[3] : 1;
}
export function mixColor(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  return rgbaCss([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t), lerp(ca[3], cb[3], t)]);
}
/** Relative luminance 0..1 */
export function luminance(color) {
  const c = parseColor(color);
  if (!c) return 1;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
export function isVisibleColor(color) {
  if (color == null || color === '' || color === 'none' || color === 'transparent') return false;
  const c = parseColor(color);
  return c ? c[3] > 0.001 : true;
}

// ───────────────────────────── 2D affine matrices [a,b,c,d,e,f] ─────────────────────────────

export const M_ID = Object.freeze([1, 0, 0, 1, 0, 0]);
export function mMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const mTranslate = (x, y) => [1, 0, 0, 1, x, y];
export const mScale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export function mRotate(rad) { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, -s, c, 0, 0]; }
/** Transform about a pivot: T(p + (tx,ty)) · R · S · T(-p) */
export function mAbout(px, py, tx, ty, rotDeg, sx, sy) {
  let m = mTranslate(px + tx, py + ty);
  if (rotDeg) m = mMul(m, mRotate(rotDeg * DEG));
  if (sx !== 1 || sy !== 1) m = mMul(m, mScale(sx, sy));
  return mMul(m, mTranslate(-px, -py));
}

// ───────────────────────────── canvas helpers ─────────────────────────────

/** Create a canvas usable for 2D drawing + WebGL upload (DOM canvas preferred, else OffscreenCanvas, else null). */
export function createCanvas(w, h) {
  w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
  try {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
  } catch { /* fall through */ }
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch { /* no canvas */ }
  return null;
}
export function canvasSupported() {
  return (typeof document !== 'undefined' && !!document && typeof document.createElement === 'function') ||
    typeof OffscreenCanvas !== 'undefined';
}
/** Rounded-rect path (radius clamped to half the shorter side). Works without ctx.roundRect.
 *  newPath=false appends a closed sub-path to the current path. */
export function roundRectPath(ctx, x, y, w, h, r, newPath = true) {
  const rr = Math.max(0, Math.min(Number(r) || 0, Math.abs(w) / 2, Math.abs(h) / 2));
  if (newPath) ctx.beginPath();
  if (rr <= 0.01) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
/** CSS-like linear gradient across box (angle deg: 0 = bottom→top, 90 = left→right, 180 = top→bottom). */
export function makeLinearGradient(ctx, gradient, x, y, w, h) {
  if (!gradient) return null;
  const angle = num(gradient.angle, 180) * DEG;
  const cx = x + w / 2, cy = y + h / 2;
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  const stops = Array.isArray(gradient.stops) && gradient.stops.length >= 2
    ? gradient.stops
    : [[0, gradient.from ?? '#ffffff'], [1, gradient.to ?? '#000000']];
  for (const st of stops) {
    const pos = Array.isArray(st) ? st[0] : st.pos, col = Array.isArray(st) ? st[1] : st.color;
    try { g.addColorStop(clamp01(num(pos, 0)), String(col)); } catch { /* invalid color */ }
  }
  return g;
}
