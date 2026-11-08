// Frame Studio — per-text / per-line / per-word / per-char text animations (TEXT_ANIMS).
// Hebrew rule: words move as whole units (scale/slide/fade/blur/color) — never revealed by a moving mask line.
// Character-level animations act on whole grapheme clusters (letter + niqqud) in reading order.
// Pure module: evaluation is plain math, deterministic (hash-based noise, no Math.random).

import { clamp01, EASE, outBack, outBackPop, inBack, outBounce, outElastic, spring, hash, noise1, mixColor, luminance, strSeed } from './text-util.js';

const { out2, out3, in2, in3, inOut2 } = EASE;

/** Identity unit state. o=opacity, x/y px offset, s uniform scale, sx/sy axis scale, r deg, b blur px. */
export const identState = () => ({ o: 1, x: 0, y: 0, s: 1, sx: 1, sy: 1, r: 0, b: 0 });

/** Combine b into a (mutates a). Optional fields: c fill color, sc stroke color, gc glow color, g glow boost,
 *  rgb split px, ch substitute glyph, py pivot y fraction, ul underline progress, ulc underline color. */
export function combineState(a, b) {
  if (!b) return a;
  if (b.o !== undefined) a.o *= b.o;
  if (b.x) a.x += b.x;
  if (b.y) a.y += b.y;
  if (b.s !== undefined) a.s *= b.s;
  if (b.sx !== undefined) a.sx *= b.sx;
  if (b.sy !== undefined) a.sy *= b.sy;
  if (b.r) a.r += b.r;
  if (b.b) a.b += b.b;
  if (b.c != null) a.c = b.c;
  if (b.sc != null) a.sc = b.sc;
  if (b.gc != null) a.gc = b.gc;
  if (b.g) a.g = (a.g || 0) + b.g;
  if (b.rgb) a.rgb = (a.rgb || 0) + b.rgb;
  if (b.ch != null) a.ch = b.ch;
  if (b.py != null) a.py = b.py;
  if (b.ul != null) a.ul = b.ul;
  if (b.ulc != null) a.ulc = b.ulc;
  return a;
}

const HEB_GLYPHS = 'אבגדהוזחטיכלמנסעפצקרשת';
const LAT_GLYPHS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const DIG_GLYPHS = '0123456789';
const SYM_GLYPHS = '#%&@*+=?!';
function glitchGlyph(orig, seed) {
  const cp = orig.codePointAt(0);
  const set = (cp >= 0x5d0 && cp <= 0x5ea) ? HEB_GLYPHS : (cp >= 0x30 && cp <= 0x39) ? DIG_GLYPHS
    : /[A-Za-z]/.test(orig) ? LAT_GLYPHS : SYM_GLYPHS;
  return set[Math.floor(hash(seed, 77) * set.length)];
}

// unit duration helpers
const ud = (frac, min = 0, max = Infinity) => (D) => Math.min(D, Math.max(min, Math.min(max, D * frac)));

// ───────────────────────────── IN ─────────────────────────────
const IN = [
  { id: 'none', name: 'ללא', unit: 'text' },
  { id: 'fade', name: 'הופעה הדרגתית', unit: 'text', perWord: true, fn: (p) => ({ o: out2(p) }) },
  { id: 'typewriter', name: 'מכונת כתיבה', unit: 'char', step: true, fn: (p) => ({ o: p > 0 ? 1 : 0 }) },
  { id: 'typewriterWords', name: 'מילה אחר מילה', unit: 'word', step: true, fn: (p) => ({ o: p > 0 ? 1 : 0 }) },
  { id: 'wordPop', name: 'קפיצת מילים', unit: 'word', unitDur: ud(0.35, 0.13, 0.3),
    fn: (p, i, n, c) => (p <= 0 ? { o: 0 } : { o: clamp01(p * 6), s: 1.28 - 0.28 * outBackPop(p), y: (1 - out3(p)) * 0.3 * c.size }) },
  { id: 'wordSlideUp', name: 'מילים עולות', unit: 'word', unitDur: ud(0.5, 0.25),
    fn: (p, i, n, c) => ({ o: out2(p), y: (1 - out3(p)) * 0.55 * c.size }) },
  { id: 'wordSlideDown', name: 'מילים יורדות', unit: 'word', unitDur: ud(0.5, 0.25),
    fn: (p, i, n, c) => ({ o: out2(p), y: -(1 - out3(p)) * 0.55 * c.size }) },
  { id: 'wordFade', name: 'מילים מתגלות', unit: 'word', unitDur: ud(0.5, 0.2), fn: (p) => ({ o: out2(p) }) },
  { id: 'wordBlur', name: 'מילים מפוקסות', unit: 'word', unitDur: ud(0.5, 0.22),
    fn: (p, i, n, c) => ({ o: out2(p), b: (1 - out3(p)) * 0.28 * c.size, y: (1 - out3(p)) * 0.12 * c.size }) },
  { id: 'scaleWords', name: 'מילים גדלות', unit: 'word', unitDur: ud(0.5, 0.25),
    fn: (p) => ({ o: clamp01(p * 3), s: Math.max(0.001, outBack(p)) }) },
  { id: 'bounceWords', name: 'מילים קופצות', unit: 'word', unitDur: ud(0.5, 0.35),
    fn: (p, i, n, c) => ({ o: clamp01(p * 5), y: -(1 - outBounce(p)) * 1.1 * c.size }) },
  { id: 'elasticWords', name: 'מילים אלסטיות', unit: 'word', unitDur: ud(0.55, 0.35),
    fn: (p) => ({ o: clamp01(p * 4), s: Math.max(0.001, outElastic(p)) }) },
  { id: 'flipIn', name: 'היפוך מילים', unit: 'word', unitDur: ud(0.5, 0.25),
    fn: (p) => ({ o: clamp01(p * 3), sy: Math.max(0.01, outBack(p)) }) },
  { id: 'spinIn', name: 'סיבוב מילים', unit: 'word', unitDur: ud(0.5, 0.3),
    fn: (p) => ({ o: out2(p), r: -(1 - out3(p)) * 120, s: 0.3 + 0.7 * out3(p) }) },
  { id: 'swingIn', name: 'נדנדה', unit: 'word', unitDur: ud(0.55, 0.35),
    fn: (p) => ({ o: clamp01(p * 3), r: -38 * (1 - outBack(p, 2.2)), py: -0.5 }) },
  { id: 'karaokeFill', name: 'מילוי קריוקי', unit: 'word', span: 'clip',
    custom: (c, i, n) => {
      const span = Math.max(0.05, c.dur - (c.anim.out && c.anim.out !== 'none' ? c.outD : 0));
      const start = (i / Math.max(1, n)) * span * 0.92;
      const q = (c.t - start) / 0.12;
      if (q <= 0) return null;
      return { c: mixColor(c.color, c.accent, clamp01(q)), s: 1 + 0.1 * (1 - out3((c.t - start) / 0.25)) };
    } },
  { id: 'charFade', name: 'אותיות מתגלות', unit: 'char', unitDur: ud(0.3, 0.08), fn: (p) => ({ o: out2(p) }) },
  { id: 'charDrop', name: 'אותיות נופלות', unit: 'char', unitDur: ud(0.45, 0.3),
    fn: (p, i, n, c) => ({ o: clamp01(p * 4), y: -(1 - outBounce(p)) * 0.9 * c.size }) },
  { id: 'charRise', name: 'אותיות עולות', unit: 'char', unitDur: ud(0.4, 0.2),
    fn: (p, i, n, c) => ({ o: out2(p), y: (1 - out3(p)) * 0.5 * c.size }) },
  { id: 'trackingIn', name: 'ריווח נסגר', unit: 'char', unitDur: (D) => D, sync: true,
    fn: (p, i, n, c) => ({ o: out2(p), x: (c.charCx(i) - c.blockCx) * 0.9 * (1 - out3(p)) }) },
  { id: 'glitchType', name: 'הקלדת גליץ׳', unit: 'char', unitDur: ud(0.25, 0.12, 0.3),
    fn: (p, i, n, c) => {
      if (p <= 0) return { o: 0 };
      if (p >= 1) return null;
      const f = c.frame;
      const st = { o: 1, x: (hash(i * 31 + 7, f) - 0.5) * 0.14 * c.size, y: (hash(i * 17 + 3, f) - 0.5) * 0.06 * c.size,
        c: f % 2 ? '#05d9e8' : '#ff2a6d' };
      if (hash(i * 13 + 1, f) > 0.25 + 0.6 * p) st.ch = glitchGlyph(c.charText(i), i * 977 + f);
      return st;
    } },
  { id: 'blurIn', name: 'מטושטש לחד', unit: 'text', perWord: true,
    fn: (p, i, n, c) => ({ o: out2(p), b: (1 - out3(p)) * 0.22 * c.size, s: 1.06 - 0.06 * out3(p) }) },
  { id: 'zoomIn', name: 'זום פנימה', unit: 'text', perWord: true, fn: (p) => ({ o: out2(p), s: 0.4 + 0.6 * out3(p) }) },
  { id: 'zoomOut', name: 'זום החוצה', unit: 'text', perWord: true, fn: (p) => ({ o: out2(p), s: 1.7 - 0.7 * out3(p) }) },
  { id: 'popIn', name: 'הקפצה', unit: 'text', perWord: true, fn: (p) => ({ o: clamp01(p * 3), s: Math.max(0.001, outBack(p)) }) },
  { id: 'springIn', name: 'קפיץ', unit: 'text', perWord: true, fn: (p) => ({ o: clamp01(p * 4), s: Math.max(0.001, spring(p, 0.45, 13)) }) },
  { id: 'slideUp', name: 'החלקה למעלה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: out2(p), y: (1 - out3(p)) * 0.9 * c.size }) },
  { id: 'slideDown', name: 'החלקה למטה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: out2(p), y: -(1 - out3(p)) * 0.9 * c.size }) },
  { id: 'slideLeft', name: 'החלקה שמאלה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: out2(p), x: (1 - out3(p)) * 1.2 * c.size }) },
  { id: 'slideRight', name: 'החלקה ימינה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: out2(p), x: -(1 - out3(p)) * 1.2 * c.size }) },
  { id: 'rise', name: 'שורות עולות', unit: 'line', unitDur: ud(0.6, 0.25), fn: (p, i, n, c) => ({ o: out2(p), y: (1 - out3(p)) * 0.7 * c.size }) },
  { id: 'stretchIn', name: 'מתיחה', unit: 'text', perWord: true, fn: (p) => ({ o: out2(p), sx: 1 + 1.2 * (1 - out3(p)), sy: 0.35 + 0.65 * out3(p) }) },
  { id: 'dropIn', name: 'נפילה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: clamp01(p * 4), y: -(1 - outBounce(p)) * 1.6 * c.size }) },
];

// ───────────────────────────── OUT (p: 0 = fully visible → 1 = gone) ─────────────────────────────
const OUT = [
  { id: 'none', name: 'ללא', unit: 'text' },
  { id: 'fade', name: 'היעלמות הדרגתית', unit: 'text', perWord: true, fn: (p) => ({ o: 1 - inOut2(p) }) },
  { id: 'wordFadeOut', name: 'מילים נעלמות', unit: 'word', unitDur: ud(0.5, 0.15), fn: (p) => ({ o: 1 - out2(p) }) },
  { id: 'wordPopOut', name: 'מילים מתכווצות', unit: 'word', unitDur: ud(0.5, 0.15),
    fn: (p) => ({ s: Math.max(0.001, 1 - inBack(p)), o: 1 - clamp01((p - 0.6) / 0.4) }) },
  { id: 'wordSlideDown', name: 'מילים יורדות', unit: 'word', unitDur: ud(0.5, 0.15),
    fn: (p, i, n, c) => ({ o: 1 - out2(p), y: in3(p) * 0.6 * c.size }) },
  { id: 'wordSlideUp', name: 'מילים עפות למעלה', unit: 'word', unitDur: ud(0.5, 0.15),
    fn: (p, i, n, c) => ({ o: 1 - out2(p), y: -in3(p) * 0.6 * c.size }) },
  { id: 'spinOut', name: 'סיבוב החוצה', unit: 'word', unitDur: ud(0.5, 0.2),
    fn: (p) => ({ o: 1 - out2(p), r: in3(p) * 120, s: 1 - 0.7 * in3(p) }) },
  { id: 'flipOut', name: 'היפוך החוצה', unit: 'word', unitDur: ud(0.5, 0.15), fn: (p) => ({ sy: Math.max(0.01, 1 - in3(p)), o: 1 - clamp01((p - 0.7) / 0.3) }) },
  { id: 'charFadeOut', name: 'אותיות נעלמות', unit: 'char', unitDur: ud(0.3, 0.06), fn: (p) => ({ o: 1 - out2(p) }) },
  { id: 'typeErase', name: 'מחיקה', unit: 'char', step: true, order: 'reverse', fn: (p) => ({ o: p > 0 ? 0 : 1 }) },
  { id: 'scatterOut', name: 'פיזור', unit: 'char', unitDur: ud(0.6, 0.2),
    fn: (p, i, n, c) => ({ o: 1 - out2(p), x: (hash(i, 1) - 0.5) * 2.2 * c.size * in3(p), y: (hash(i, 2) - 0.5) * 2.2 * c.size * in3(p), r: (hash(i, 3) - 0.5) * 180 * p }) },
  { id: 'blurOut', name: 'חד למטושטש', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: 1 - out2(p), b: in3(p) * 0.25 * c.size, s: 1 + 0.06 * p }) },
  { id: 'zoomOut', name: 'התרחקות', unit: 'text', perWord: true, fn: (p) => ({ o: 1 - out2(p), s: Math.max(0.001, 1 - 0.6 * in3(p)) }) },
  { id: 'zoomIn', name: 'התקרבות', unit: 'text', perWord: true, fn: (p) => ({ o: 1 - out2(p), s: 1 + 0.8 * in3(p) }) },
  { id: 'slideUp', name: 'החלקה למעלה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: 1 - out2(p), y: -in3(p) * 0.9 * c.size }) },
  { id: 'slideDown', name: 'החלקה למטה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: 1 - out2(p), y: in3(p) * 0.9 * c.size }) },
  { id: 'slideLeft', name: 'החלקה שמאלה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: 1 - out2(p), x: -in3(p) * 1.2 * c.size }) },
  { id: 'slideRight', name: 'החלקה ימינה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: 1 - out2(p), x: in3(p) * 1.2 * c.size }) },
  { id: 'dropOut', name: 'נפילה החוצה', unit: 'text', perWord: true, fn: (p, i, n, c) => ({ o: 1 - clamp01((p - 0.4) / 0.6), y: in3(p) * 1.5 * c.size, r: p * 12 }) },
];

// ───────────────────────────── LOOP (t = seconds × speed) ─────────────────────────────
const LOOP = [
  { id: 'none', name: 'ללא', unit: 'text' },
  { id: 'wave', name: 'גל אותיות', unit: 'char', fn: (t, i, n, c) => ({ y: -Math.sin(2 * Math.PI * (t * 1.2) - i * 0.5) * 0.07 * c.size * c.k }) },
  { id: 'waveWords', name: 'גל מילים', unit: 'word', fn: (t, i, n, c) => ({ y: -Math.sin(2 * Math.PI * t - i * 0.8) * 0.1 * c.size * c.k }) },
  { id: 'shimmer', name: 'נצנוץ', unit: 'word',
    fn: (t, i, n, c) => {
      const period = n + 2.5;
      const phase = ((t * 1.6) % period) - 1.2;
      const k = Math.max(0, 1 - Math.abs(i - phase) / 1.1) * Math.min(1, c.k);
      if (k <= 0) return null;
      const target = luminance(c.color) > 0.6 ? c.accent : '#ffffff';
      return { c: mixColor(c.color, target, k * 0.9), g: k * 0.8 };
    } },
  { id: 'pulse', name: 'פעימה', unit: 'text', fn: (t, i, n, c) => ({ s: 1 + 0.045 * c.k * Math.sin(2 * Math.PI * t * 1.3) }) },
  { id: 'heartbeat', name: 'דופק', unit: 'text',
    fn: (t, i, n, c) => {
      const b = (t * 1.15) % 1;
      return { s: 1 + c.k * (0.08 * Math.exp(-((b - 0.1) ** 2) / 0.0025) + 0.05 * Math.exp(-((b - 0.32) ** 2) / 0.0025)) };
    } },
  { id: 'breathe', name: 'נשימה', unit: 'text', fn: (t, i, n, c) => { const v = Math.sin(2 * Math.PI * t * 0.35); return { s: 1 + 0.03 * c.k * v, o: 1 - 0.12 * c.k * (0.5 - 0.5 * v) }; } },
  { id: 'float', name: 'ריחוף', unit: 'text', fn: (t, i, n, c) => ({ y: Math.sin(2 * Math.PI * t * 0.45) * 0.07 * c.size * c.k, r: Math.sin(2 * Math.PI * t * 0.3) * c.k }) },
  { id: 'swing', name: 'נדנוד', unit: 'text', fn: (t, i, n, c) => ({ r: Math.sin(2 * Math.PI * t * 0.6) * 3.5 * c.k }) },
  { id: 'shake', name: 'רעידה', unit: 'text',
    fn: (t, i, n, c) => ({ x: noise1(t * 18, 1) * 0.035 * c.size * c.k, y: noise1(t * 18, 2) * 0.035 * c.size * c.k, r: noise1(t * 14, 3) * 1.2 * c.k }) },
  { id: 'wobble', name: 'התנדנדות מילים', unit: 'word', fn: (t, i, n, c) => ({ r: Math.sin(2 * Math.PI * t * 1.2 + i * 1.3) * 5 * c.k }) },
  { id: 'jiggle', name: 'ריקוד אותיות', unit: 'char',
    fn: (t, i, n, c) => { const f = Math.floor(t * 8); return { r: (hash(i, f) - 0.5) * 14 * c.k, y: (hash(i + 99, f) - 0.5) * 0.05 * c.size * c.k }; } },
  { id: 'bounce', name: 'קפיצות', unit: 'word',
    fn: (t, i, n, c) => ({ y: -Math.max(0, Math.sin(2 * Math.PI * (t * 1.6 - i * 0.18))) * 0.14 * c.size * c.k }) },
  { id: 'flicker', name: 'הבהוב ניאון', unit: 'text',
    fn: (t, i, n, c) => { const v = hash(7, Math.floor(t * 15)); const o = v < 0.08 ? 0.3 : v < 0.14 ? 0.7 : 1; return { o: 1 - (1 - o) * Math.min(1, c.k), g: o > 0.9 ? 0.25 : 0 }; } },
  { id: 'glowPulse', name: 'זוהר פועם', unit: 'text', fn: (t, i, n, c) => ({ g: (0.5 + 0.5 * Math.sin(2 * Math.PI * t * 1.1)) * 1.2 * c.k }) },
  { id: 'rainbow', name: 'קשת צבעים', unit: 'word', fn: (t, i) => ({ c: `hsl(${Math.round((t * 140 + i * 45) % 360)}, 95%, 62%)` }) },
  { id: 'glitch', name: 'גליץ׳', unit: 'text',
    fn: (t, i, n, c) => {
      const burst = hash(11, Math.floor(t * 9)) > 0.72;
      if (!burst) return null;
      const f = Math.floor(t * 30);
      return { rgb: (0.03 + 0.04 * hash(12, f)) * c.size * c.k, x: (hash(13, f) - 0.5) * 0.06 * c.size * c.k };
    } },
];

const IMPL = { in: new Map(IN.map((a) => [a.id, a])), out: new Map(OUT.map((a) => [a.id, a])), loop: new Map(LOOP.map((a) => [a.id, a])) };
const pub = (a) => ({ id: a.id, name: a.name, unit: a.unit, perWord: !!a.perWord });

/** Public catalog (plain data). */
export const TEXT_ANIMS = { in: IN.map(pub), out: OUT.map(pub), loop: LOOP.map(pub) };

export function getTextAnim(phase, id) { return IMPL[phase]?.get(id) || null; }

/**
 * Evaluate text animations at local time.
 * @param {object} anim  clip.textAnim
 * @param {object} c     { t (local s), dur, fps, frame, size, color, accent, counts:{line,word,char},
 *                         charCx(i), blockCx, charText(i), wordOfChar? }
 * @returns {{text, lines, words, chars, needChars:boolean, active:boolean}}
 */
export function evalTextAnims(anim, c) {
  const nL = c.counts.line, nW = c.counts.word, nC = c.counts.char;
  const res = { text: identState(), lines: null, words: null, chars: null, needChars: false, active: false };
  if (!anim) return res;
  const inD = Math.max(0.01, Number(anim.inDuration) || 0.4);
  const outD = Math.max(0.01, Number(anim.outDuration) || 0.3);
  const ctx = { ...c, anim, inD, outD, k: Number.isFinite(anim.loopIntensity) ? anim.loopIntensity : 1 };
  const ensure = (unit) => {
    if (unit === 'line') return res.lines || (res.lines = Array.from({ length: nL }, identState));
    if (unit === 'word') return res.words || (res.words = Array.from({ length: nW }, identState));
    if (unit === 'char') { res.needChars = true; return res.chars || (res.chars = Array.from({ length: nC }, identState)); }
    return null;
  };
  const runPhase = (phase, id, localP0, D) => {
    const def = IMPL[phase].get(id);
    if (!def || id === 'none' || (!def.fn && !def.custom)) return;
    let unit = def.unit;
    if (unit === 'text' && def.perWord && anim.perWord) unit = 'word';
    const n = unit === 'line' ? nL : unit === 'word' ? nW : unit === 'char' ? nC : 1;
    if (n <= 0) return;
    if (def.custom) {
      const arr = ensure(unit);
      for (let i = 0; i < n; i++) {
        const st = def.custom(ctx, i, n);
        if (st) { combineState(arr ? arr[i] : res.text, st); res.active = true; }
      }
      return;
    }
    const step = !!def.step;
    const uDur = n <= 1 ? D : (step ? D / n : Math.min(D, def.unitDur ? def.unitDur(D, n) : D * 0.6));
    const stagger = n <= 1 ? 0 : (step ? D / n : (def.sync ? 0 : (D - uDur) / (n - 1)));
    const arr = unit === 'text' ? null : ensure(unit);
    const seed = strSeed(id);
    for (let i = 0; i < n; i++) {
      let pos = i;
      if (def.order === 'reverse') pos = n - 1 - i;
      else if (def.order === 'random') pos = Math.floor(hash(seed, i) * n);
      const start = pos * stagger;
      const lt = localP0 - start;
      let p;
      if (step) p = lt >= 0 ? 1 : 0;
      else p = clamp01(lt / Math.max(1e-4, uDur));
      if (phase === 'in' && p >= 1 && !def.keep) continue;            // finished → identity
      if (phase === 'out' && lt < 0 && !step) continue;               // not started → identity
      if (phase === 'out' && step && p === 0) continue;
      const st = def.fn(p, i, n, ctx);
      if (st) { combineState(arr ? arr[i] : res.text, st); res.active = true; }
    }
  };
  const t = c.t;
  // IN
  if (anim.in && anim.in !== 'none') {
    const def = IMPL.in.get(anim.in);
    if (def && (def.span === 'clip' || t < inD + 1e-6)) runPhase('in', anim.in, t, def.span === 'clip' ? c.dur : inD);
  }
  // OUT
  if (anim.out && anim.out !== 'none') {
    const t0 = c.dur - outD;
    if (t >= t0) runPhase('out', anim.out, t - t0, outD);
  }
  // LOOP
  if (anim.loop && anim.loop !== 'none') {
    const def = IMPL.loop.get(anim.loop);
    if (def && def.fn) {
      const speed = Number.isFinite(anim.loopSpeed) && anim.loopSpeed > 0 ? anim.loopSpeed : 1;
      const tt = t * speed;
      const unit = def.unit;
      const n = unit === 'line' ? nL : unit === 'word' ? nW : unit === 'char' ? nC : 1;
      const arr = unit === 'text' ? null : ensure(unit);
      for (let i = 0; i < n; i++) {
        const st = def.fn(tt, i, n, ctx);
        if (st) { combineState(arr ? arr[i] : res.text, st); res.active = true; }
      }
    }
  }
  return res;
}

/** Does this textAnim ever need per-character layout? */
export function animNeedsChars(anim) {
  if (!anim) return false;
  const u = (ph, id) => { const d = IMPL[ph].get(id); return d && d.unit === 'char'; };
  return u('in', anim.in) || u('out', anim.out) || u('loop', anim.loop);
}
/** Is anything animated at all (in/out/loop not "none")? */
export function animIsAnimated(anim) {
  return !!anim && ((anim.in && anim.in !== 'none') || (anim.out && anim.out !== 'none') || (anim.loop && anim.loop !== 'none'));
}
