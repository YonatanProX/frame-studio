// Frame Studio — font catalog, FontFace registration (local files in /library/fonts) and loading.
// Importable in Node: browser APIs are touched only inside functions.

export const FONTS = [
  {
    family: 'Heebo', name: 'Heebo', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    src: '/library/fonts/Heebo-VariableFont_wght.ttf',
    files: [
      { src: '/library/fonts/heebo-latin.woff2', format: 'woff2', unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
      { src: '/library/fonts/heebo-hebrew.woff2', format: 'woff2', unicodeRange: 'U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F' },
    ],
    variable: true, weightRange: '100 900', local: true, system: false, hebrew: true, license: 'SIL OFL 1.1', category: 'sans',
  },
  {
    family: 'Assistant', name: 'Assistant', weights: [200, 300, 400, 500, 600, 700, 800],
    src: '/library/fonts/assistant-hebrew.woff2',
    files: [
      { src: '/library/fonts/assistant-latin.woff2', format: 'woff2', unicodeRange: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
      { src: '/library/fonts/assistant-hebrew.woff2', format: 'woff2', unicodeRange: 'U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F' },
    ],
    variable: true, weightRange: '200 800', local: true, system: false, hebrew: true, license: 'SIL OFL 1.1', category: 'sans',
  },
  { family: 'Arial', name: 'Arial', css: 'Arial', weights: [400, 700], system: true, hebrew: true, license: 'Windows', category: 'sans' },
  { family: 'David', name: 'דוד (David)', css: 'David', weights: [400, 700], system: true, hebrew: true, license: 'Windows', category: 'serif' },
  { family: 'Frank Ruehl', name: 'פרנק ריהל (Frank Ruehl)', css: 'FrankRuehl', weights: [400], system: true, hebrew: true, license: 'Windows', category: 'serif' },
  { family: 'Gisha', name: 'גישה (Gisha)', css: 'Gisha', weights: [400, 700], system: true, hebrew: true, license: 'Windows', category: 'sans' },
  { family: 'Rod', name: 'רוד (Rod)', css: 'Rod', weights: [400], system: true, hebrew: true, license: 'Windows', category: 'mono' },
  { family: 'Segoe UI', name: 'Segoe UI', css: 'Segoe UI', weights: [300, 400, 600, 700], system: true, hebrew: true, license: 'Windows', category: 'sans' },
  { family: 'Tahoma', name: 'Tahoma', css: 'Tahoma', weights: [400, 700], system: true, hebrew: true, license: 'Windows', category: 'sans' },
  { family: 'Bahnschrift', name: 'Bahnschrift', css: 'Bahnschrift', weights: [300, 400, 500, 600, 700], system: true, hebrew: false, hebrewFallback: { family: 'Heebo', weightAdd: 100 }, license: 'Windows', category: 'display' },
  { family: 'Impact', name: 'Impact', css: 'Impact', weights: [400], system: true, hebrew: false, hebrewFallback: { family: 'Heebo', weight: 900 }, license: 'Windows', category: 'display' },
  { family: 'Segoe UI Emoji', name: 'Segoe UI Emoji', css: 'Segoe UI Emoji', weights: [400], system: true, hebrew: false, emoji: true, license: 'Windows', category: 'emoji' },
];

export const EMOJI_FONT_STACK = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol"';
export const HEBREW_SAMPLE = 'אבג';

const extraFonts = []; // discovered via /api/library/fonts at runtime
let fontBase = '';
let generation = 0;
const listeners = new Set();
let registered = false;
let discoverPromise = null;
const registeredFamilies = new Set();
const fontStackCache = new Map();

/** Prefix for font URLs (default '' → same origin, '/library/fonts/...'). */
export function setFontBase(base) { fontBase = String(base || '').replace(/\/+$/, ''); }
export function getFontBase() { return fontBase; }
/** Increments whenever new font faces become available (layout caches key on it). */
export function fontGeneration() { return generation; }
export function onFontsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function bump() {
  generation++;
  for (const fn of listeners) { try { fn(generation); } catch { /* listener error */ } }
}

/** All known fonts (catalog + runtime-discovered local fonts). */
export function listFonts() { return FONTS.concat(extraFonts); }
export function findFont(family) {
  if (!family) return null;
  const f = String(family).toLowerCase();
  return listFonts().find((x) => x.family.toLowerCase() === f || (x.css && x.css.toLowerCase() === f)) || null;
}

const q = (s) => `"${String(s).replace(/["\\]/g, '')}"`;

/** CSS font-family stack for a family: the family, then Heebo for missing Hebrew glyphs, then emoji fonts. */
export function fontFamilyCss(family) {
  const key = String(family || 'Heebo');
  if (fontStackCache.has(key)) return fontStackCache.get(key);
  const f = findFont(key);
  const main = f ? (f.css || f.family) : key;
  const parts = [q(main)];
  if (f && f.css && f.css !== f.family) parts.push(q(f.family));
  if (main.toLowerCase() !== 'heebo') parts.push('"Heebo"');
  const stack = parts.join(', ') + ', ' + EMOJI_FONT_STACK + ', sans-serif';
  fontStackCache.set(key, stack);
  return stack;
}

/**
 * Font for a glyph run: Latin-only display fonts (Impact, Bahnschrift) hand Hebrew runs to Heebo at a matching
 * (heavier) weight instead of the browser's light default fallback.
 */
export function runFontString(family, weight, size, italic, hasHebrew) {
  if (hasHebrew) {
    const f = findFont(family);
    if (f && f.hebrew === false && f.hebrewFallback) {
      const fb = f.hebrewFallback;
      const w = fb.weight != null ? fb.weight : Math.min(900, (Number(weight) || 400) + (fb.weightAdd || 0));
      return fontString(fb.family || 'Heebo', w, size, italic);
    }
  }
  return fontString(family, weight, size, italic);
}

/** Canvas font shorthand. */
export function fontString(family, weight, size, italic) {
  const w = Math.max(1, Math.min(1000, Math.round(Number(weight) || 400)));
  const s = Math.max(0.5, Number(size) || 16);
  return `${italic ? 'italic ' : ''}${w} ${Math.round(s * 100) / 100}px ${fontFamilyCss(family)}`;
}

function fontSet() {
  try {
    if (typeof document !== 'undefined' && document && document.fonts) return document.fonts;
    if (typeof self !== 'undefined' && self && self.fonts) return self.fonts;
  } catch { /* no font set */ }
  return null;
}

function absUrl(src) {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  const parts = src.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(decodeURIComponent(seg))));
  return fontBase + parts.join('/');
}

function addFace(set, family, src, descriptors) {
  try {
    const face = new FontFace(family, `url(${JSON.stringify(absUrl(src))})`, descriptors);
    set.add(face);
    return face;
  } catch (e) {
    return null;
  }
}

/** Register @font-face rules (FontFace API) for the bundled local fonts. Idempotent. */
export function registerBundledFonts() {
  if (registered) return true;
  const set = fontSet();
  if (!set || typeof FontFace === 'undefined') return false;
  registered = true;
  for (const f of FONTS) {
    if (!f.local) continue;
    const desc = { weight: f.weightRange || '400', style: 'normal', display: 'block' };
    // complete face first (fallback for every code point), then the unicode-range subsets (preferred for their ranges)
    if (f.src && !(f.files || []).some((x) => x.src === f.src)) addFace(set, f.family, f.src, desc);
    for (const file of f.files || []) addFace(set, f.family, file.src, { ...desc, unicodeRange: file.unicodeRange });
    registeredFamilies.add(f.family.toLowerCase());
  }
  try {
    set.addEventListener?.('loadingdone', () => bump());
  } catch { /* old API */ }
  return true;
}

/** Ask the server for additional local font files (GET /api/library/fonts) and register them. Never throws. */
export function discoverLibraryFonts(apiBase = '') {
  if (discoverPromise) return discoverPromise;
  discoverPromise = (async () => {
    const set = fontSet();
    if (!set || typeof fetch === 'undefined' || typeof FontFace === 'undefined') return [];
    let list = [];
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
      const res = await fetch((apiBase || fontBase) + '/api/library/fonts', ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (res.ok) list = await res.json();
    } catch { list = []; }
    if (!Array.isArray(list)) return [];
    const added = [];
    for (const it of list) {
      if (!it || !it.family || !it.url || it.system) continue;
      if (findFont(it.family) || registeredFamilies.has(String(it.family).toLowerCase())) continue;
      const ws = Array.isArray(it.weights) && it.weights.length ? it.weights.map(Number).filter(Boolean) : [400];
      const range = ws.length > 1 ? `${Math.min(...ws)} ${Math.max(...ws)}` : String(ws[0]);
      if (addFace(set, it.family, it.url, { weight: range, style: 'normal', display: 'block' })) {
        const entry = { family: it.family, name: it.family, weights: ws, src: it.url, local: true, system: false, hebrew: true, license: it.license || '', category: 'sans', discovered: true };
        extraFonts.push(entry);
        registeredFamilies.add(String(it.family).toLowerCase());
        added.push(entry);
      }
    }
    if (added.length) { fontStackCache.clear(); bump(); }
    return added;
  })();
  return discoverPromise;
}

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ timeout: true }); } }, ms);
    Promise.resolve(p).then((v) => { if (!done) { done = true; clearTimeout(timer); resolve({ value: v }); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ error: e }); } });
  });
}

/**
 * Load the given font variants. specs: [{family, weight, italic}]. Resolves to {loaded:[...], failed:[...]}.
 * Uses document.fonts.load with a Hebrew + Latin + digit sample so both unicode-range subsets load.
 */
export async function loadFontVariants(specs, { timeout = 4000 } = {}) {
  const set = fontSet();
  const out = { loaded: [], failed: [] };
  if (!set) return out;
  registerBundledFonts();
  const seen = new Set();
  const jobs = [];
  for (const s of specs) {
    const fam = s.family || 'Heebo';
    const w = Math.round(Number(s.weight) || 400);
    const it = !!s.italic;
    const key = `${fam}|${w}|${it}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = findFont(fam);
    const css = f ? (f.css || f.family) : fam;
    const shorthand = `${it ? 'italic ' : ''}${w} 64px ${q(css)}`;
    const sample = s.sample || (f && f.emoji ? '🔥😂' : `${HEBREW_SAMPLE} Abc 123`);
    jobs.push(withTimeout(set.load(shorthand, sample), timeout).then((r) => {
      if (r.value && r.value.length) out.loaded.push(key);
      else if (r.value) out.loaded.push(key + ' (system)');
      else out.failed.push(key + (r.timeout ? ' (timeout)' : ''));
    }));
  }
  await Promise.all(jobs);
  if (out.loaded.length) bump();
  try { await withTimeout(set.ready, timeout); } catch { /* ignore */ }
  return out;
}

/** True when the font set reports the family/weight as available (best effort). */
export function fontAvailable(family, weight = 400) {
  const set = fontSet();
  if (!set || typeof set.check !== 'function') return false;
  const f = findFont(family);
  try { return set.check(`${weight} 32px ${q(f ? (f.css || f.family) : family)}`, HEBREW_SAMPLE); } catch { return false; }
}
