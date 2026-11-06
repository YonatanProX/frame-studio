// Frame Studio — compact Unicode Bidirectional Algorithm (UBA, UAX #9 rules W1–W7, N1–N2, I1–I2, L2)
// working on grapheme clusters, with one deliberate typographic extension for Hebrew social video:
//   W7b: a run of European digits that is followed (across spaces only) by a Latin word becomes L,
//        so "123 BPM", "3 iPhone", "2.0 Pro" stay one left-to-right phrase inside Hebrew text
//        (plain UBA would show "BPM 123").
// Pure module (no DOM).

const CS_SET = new Set([0x2c, 0x2e, 0x2f, 0x3a, 0xa0, 0x60c, 0x202f, 0x2044, 0xfe50, 0xfe52, 0xfe55, 0xff0c, 0xff0e, 0xff0f, 0xff1a]);
const ET_SET = new Set([0x23, 0x24, 0x25, 0xa2, 0xa3, 0xa4, 0xa5, 0xb0, 0xb1, 0x212e, 0x2213, 0x2030, 0x2031, 0x2032, 0x2033, 0x2034, 0x9f2, 0x9f3, 0xe3f, 0x17db, 0xfe5f, 0xfe69, 0xfe6a, 0xff03, 0xff04, 0xff05, 0xffe0, 0xffe1, 0xffe5, 0xffe6]);
const ES_SET = new Set([0x2b, 0x2d, 0x2212, 0x207a, 0x207b, 0x208a, 0x208b, 0xfb29, 0xfe62, 0xfe63, 0xff0b, 0xff0d]);
const EN_EXTRA = new Set([0xb2, 0xb3, 0xb9, 0x2070]);

const RE_LETTER = /[\p{L}\p{Mc}\p{Nd}]/u;

function inR(cp, a, b) { return cp >= a && cp <= b; }

function isNSM(cp) {
  return inR(cp, 0x300, 0x36f) || inR(cp, 0x483, 0x489) || inR(cp, 0x591, 0x5bd) || cp === 0x5bf ||
    inR(cp, 0x5c1, 0x5c2) || inR(cp, 0x5c4, 0x5c5) || cp === 0x5c7 || inR(cp, 0x610, 0x61a) ||
    inR(cp, 0x64b, 0x65f) || cp === 0x670 || inR(cp, 0x6d6, 0x6dc) || inR(cp, 0x6df, 0x6e4) ||
    inR(cp, 0x6e7, 0x6e8) || inR(cp, 0x6ea, 0x6ed) || inR(cp, 0x20d0, 0x20f0) || inR(cp, 0xfe00, 0xfe0f) ||
    inR(cp, 0xfe20, 0xfe2f) || cp === 0xfb1e || inR(cp, 0xe0100, 0xe01ef);
}

/** Bidi class of a code point: L R AL EN AN ES ET CS NSM BN WS ON */
export function bidiClass(cp) {
  if (cp >= 0x30 && cp <= 0x39) return 'EN';
  if (cp < 0x80) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'L';
    if (cp === 0x20) return 'WS';
    if (cp === 0x09 || cp === 0x0b || cp === 0x1f) return 'WS';
    if (cp < 0x20 || cp === 0x7f) return 'BN';
    if (ES_SET.has(cp)) return 'ES';
    if (ET_SET.has(cp)) return 'ET';
    if (CS_SET.has(cp)) return 'CS';
    return 'ON';
  }
  if (cp === 0x200e) return 'L';
  if (cp === 0x200f) return 'R';
  if (cp === 0x61c) return 'AL';
  if (isNSM(cp)) return 'NSM';
  if (inR(cp, 0x200b, 0x200d) || inR(cp, 0x2060, 0x2064) || cp === 0xfeff || cp === 0xad ||
      inR(cp, 0x202a, 0x202e) || inR(cp, 0x2066, 0x2069) || inR(cp, 0x80, 0x9f)) return 'BN';
  if (CS_SET.has(cp)) return 'CS';
  if (ES_SET.has(cp)) return 'ES';
  if (ET_SET.has(cp) || inR(cp, 0x20a0, 0x20cf)) return 'ET';
  if (EN_EXTRA.has(cp) || inR(cp, 0x2074, 0x2079) || inR(cp, 0x2080, 0x2089) || inR(cp, 0xff10, 0xff19) || inR(cp, 0x6f0, 0x6f9)) return 'EN';
  if (inR(cp, 0x660, 0x669) || cp === 0x66b || cp === 0x66c || inR(cp, 0x600, 0x605)) return 'AN';
  if (inR(cp, 0x2000, 0x200a) || cp === 0x2028 || cp === 0x205f || cp === 0x3000 || cp === 0x1680) return 'WS';
  if (inR(cp, 0x590, 0x5ff) || inR(cp, 0x7c0, 0x85f) || inR(cp, 0xfb1d, 0xfb4f) || inR(cp, 0x10800, 0x10fff) || inR(cp, 0x1e800, 0x1edff)) return 'R';
  if (inR(cp, 0x600, 0x6ff) || inR(cp, 0x700, 0x74f) || inR(cp, 0x750, 0x77f) || inR(cp, 0x8a0, 0x8ff) ||
      inR(cp, 0xfb50, 0xfdff) || inR(cp, 0xfe70, 0xfefe)) return 'AL';
  const ch = String.fromCodePoint(cp);
  if (RE_LETTER.test(ch)) return 'L';
  return 'ON';
}

export const isHebrewChar = (cp) => (cp >= 0x5d0 && cp <= 0x5ea) || (cp >= 0x5ef && cp <= 0x5f2) || (cp >= 0xfb1d && cp <= 0xfb4f);
export const isSpaceLike = (cp) => cp === 0x20 || cp === 0xa0 || cp === 0x202f || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x09;

// ───────────────────────────── graphemes ─────────────────────────────

let segmenter = null;
let segmenterTried = false;
function getSegmenter() {
  if (!segmenterTried) {
    segmenterTried = true;
    try { if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('he', { granularity: 'grapheme' }); } catch { segmenter = null; }
  }
  return segmenter;
}

/** Split text into grapheme clusters (base + niqqud/combining marks, emoji ZWJ sequences, flags). */
export function graphemes(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const seg = getSegmenter();
  if (seg) {
    const out = [];
    for (const g of seg.segment(s)) out.push(g.segment);
    return out;
  }
  // fallback: combine marks, variation selectors, ZWJ sequences, skin tones and regional-indicator pairs
  const cps = Array.from(s);
  const out = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    const cp = ch.codePointAt(0);
    const prev = out.length ? out[out.length - 1] : null;
    const prevLast = prev ? Array.from(prev).pop().codePointAt(0) : 0;
    const joinPrev = prev && (isNSM(cp) || cp === 0x200d || prevLast === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
      (cp >= 0xe0020 && cp <= 0xe007f) || cp === 0x20e3 ||
      (cp >= 0x1f1e6 && cp <= 0x1f1ff && prevLast >= 0x1f1e6 && prevLast <= 0x1f1ff && Array.from(prev).length === 1));
    if (joinPrev) out[out.length - 1] = prev + ch;
    else out.push(ch);
  }
  return out;
}

/** Bidi class of a grapheme cluster = class of its first code point. */
export function clusterClass(g) {
  const cp = g.codePointAt(0);
  return bidiClass(cp);
}

/** First strong direction in a list of classes: 'ltr' | 'rtl' | null */
export function firstStrongDir(classes) {
  for (const c of classes) {
    if (c === 'L') return 'ltr';
    if (c === 'R' || c === 'AL') return 'rtl';
  }
  return null;
}
/** First strong direction of a string. */
export function detectDir(text) {
  for (const ch of String(text ?? '')) {
    const c = bidiClass(ch.codePointAt(0));
    if (c === 'L') return 'ltr';
    if (c === 'R' || c === 'AL') return 'rtl';
  }
  return null;
}

// ───────────────────────────── level resolution ─────────────────────────────

/**
 * Resolve embedding levels for a paragraph.
 * @param {string[]} classes  bidi class per item (grapheme)
 * @param {number} paraLevel  0 (LTR) or 1 (RTL)
 * @param {object} [opt] { spaces: boolean[] (items that are spaces / NBSP), joinNumbersToLatin: true }
 * @returns {number[]} levels
 */
export function resolveLevels(classes, paraLevel, opt = {}) {
  const n = classes.length;
  const t = classes.slice();
  const sos = paraLevel & 1 ? 'R' : 'L';
  const eos = sos;
  const spaces = opt.spaces || classes.map((c) => c === 'WS');
  // W1 (NSM / BN take the type of the previous item)
  for (let i = 0; i < n; i++) if (t[i] === 'NSM' || t[i] === 'BN') t[i] = i > 0 ? t[i - 1] : sos;
  // W2
  let last = sos;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'EN' && last === 'AL') t[i] = 'AN';
    if (t[i] === 'L' || t[i] === 'R' || t[i] === 'AL') last = t[i];
  }
  // W3
  for (let i = 0; i < n; i++) if (t[i] === 'AL') t[i] = 'R';
  // W4
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    else if (t[i] === 'CS') {
      if (t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
      else if (t[i - 1] === 'AN' && t[i + 1] === 'AN') t[i] = 'AN';
    }
  }
  // W5
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue;
    let j = i;
    while (j < n && t[j] === 'ET') j++;
    if ((i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN')) for (let k = i; k < j; k++) t[k] = 'EN';
    i = j - 1;
  }
  // W6
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'ET' || t[i] === 'CS') t[i] = 'ON';
  // W7
  last = sos;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'EN' && last === 'L') t[i] = 'L';
    if (t[i] === 'L' || t[i] === 'R') last = t[i];
  }
  // W7b — digits glue to a following Latin word (processed right-to-left so chains resolve)
  if (opt.joinNumbersToLatin !== false) {
    for (let i = n - 1; i >= 0; i--) {
      if (t[i] !== 'EN') continue;
      let a = i;
      while (a > 0 && t[a - 1] === 'EN') a--;
      let k = i + 1;
      while (k < n && spaces[k]) k++;
      if (k < n && t[k] === 'L') {
        for (let m = a; m <= i; m++) t[m] = 'L';
        for (let m = i + 1; m < k; m++) t[m] = 'L';
      }
      i = a;
    }
  }
  // N1 / N2
  const e = paraLevel & 1 ? 'R' : 'L';
  const strongOf = (c) => (c === 'EN' || c === 'AN' ? 'R' : c);
  const isNeutral = (c) => c === 'ON' || c === 'WS' || c === 'B' || c === 'S';
  for (let i = 0; i < n; i++) {
    if (!isNeutral(t[i])) continue;
    let j = i;
    while (j < n && isNeutral(t[j])) j++;
    const before = i > 0 ? strongOf(t[i - 1]) : sos;
    const after = j < n ? strongOf(t[j]) : eos;
    const dir = before === after ? before : e;
    for (let k = i; k < j; k++) t[k] = dir;
    i = j - 1;
  }
  // I1 / I2
  const levels = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = t[i];
    if ((paraLevel & 1) === 0) levels[i] = c === 'R' ? paraLevel + 1 : (c === 'AN' || c === 'EN') ? paraLevel + 2 : paraLevel;
    else levels[i] = c === 'R' ? paraLevel : paraLevel + 1;
  }
  return levels;
}

/**
 * L2 reordering: returns the logical indices in visual (left→right) order.
 * @param {number[]} levels
 */
export function visualOrder(levels) {
  const n = levels.length;
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  if (!n) return arr;
  let max = 0, min = Infinity;
  for (const l of levels) { if (l > max) max = l; if (l < min) min = l; }
  const lowestOdd = min % 2 === 1 ? min : min + 1;
  for (let lev = max; lev >= lowestOdd; lev--) {
    let i = 0;
    while (i < n) {
      if (levels[arr[i]] >= lev) {
        let j = i;
        while (j < n && levels[arr[j]] >= lev) j++;
        for (let a = i, b = j - 1; a < b; a++, b--) { const tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp; }
        i = j;
      } else i++;
    }
  }
  return arr;
}

/** Convenience: visual string of a single line (for tests/debugging). */
export function visualString(text, dir = 'auto') {
  const g = graphemes(text);
  const cls = g.map(clusterClass);
  const base = dir === 'rtl' ? 1 : dir === 'ltr' ? 0 : (firstStrongDir(cls) === 'rtl' ? 1 : 0);
  const lv = resolveLevels(cls, base, { spaces: g.map((x) => isSpaceLike(x.codePointAt(0))) });
  return visualOrder(lv).map((i) => g[i]).join('');
}
