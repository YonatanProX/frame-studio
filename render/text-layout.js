// Frame Studio — bidi-correct, per-word text layout for canvas 2D.
// Words are the animation units. Each word is split into same-level "segments" (glyph runs) so Hebrew
// lines run right-to-left while numbers/Latin inside keep left-to-right; each segment is drawn with its own
// ctx.direction. Wrapping to maxWidth (greedy or balanced), multi-line, align, lineHeight, letterSpacing.
// Measurement needs a canvas; without one, layoutText returns null.

import { graphemes, clusterClass, resolveLevels, visualOrder, firstStrongDir, isSpaceLike } from './text-bidi.js';
import { fontString, runFontString, fontGeneration } from './text-fonts.js';
import { createCanvas, num } from './text-util.js';

const HEBREW_RE = /[\u0590-\u05ff\ufb1d-\ufb4f]/;
let measureCtx = null;
let measureTried = false;
const measureCache = new Map();
const metricsCache = new Map();
let cacheGen = -1;

export function getMeasureCtx() {
  if (!measureTried || !measureCtx) {
    measureTried = true;
    const c = createCanvas(4, 4);
    measureCtx = c ? c.getContext('2d') : null;
  }
  return measureCtx;
}

function checkGen() {
  const g = fontGeneration();
  if (g !== cacheGen) { cacheGen = g; measureCache.clear(); metricsCache.clear(); }
}

export const supportsLetterSpacing = () => {
  const ctx = getMeasureCtx();
  return !!ctx && 'letterSpacing' in ctx;
};

/** Apply font + spacing + direction on a 2D context. */
export function applyFont(ctx, font, letterSpacing, dir) {
  if (ctx.font !== font) ctx.font = font;
  if ('letterSpacing' in ctx) {
    const ls = `${Math.round((letterSpacing || 0) * 100) / 100}px`;
    if (ctx.letterSpacing !== ls) ctx.letterSpacing = ls;
  }
  ctx.direction = dir || 'ltr';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Measure a run of text. Returns {w, l, r, a, d} (advance + ink extents around the left alignment point). */
export function measureRun(text, font, letterSpacing = 0, dir = 'ltr') {
  checkGen();
  const key = `${font}|${letterSpacing}|${dir}|${text}`;
  const hit = measureCache.get(key);
  if (hit) return hit;
  const ctx = getMeasureCtx();
  let out;
  if (!ctx) out = { w: text.length * 10, l: 0, r: text.length * 10, a: 10, d: 2 };
  else {
    applyFont(ctx, font, letterSpacing, dir);
    const m = ctx.measureText(text);
    let w = m.width;
    // canvas letterSpacing fallback (very old engines): add manually
    if (letterSpacing && !('letterSpacing' in ctx)) w += letterSpacing * graphemes(text).length;
    out = {
      w,
      l: num(m.actualBoundingBoxLeft, 0),
      r: num(m.actualBoundingBoxRight, w),
      a: num(m.actualBoundingBoxAscent, 0),
      d: num(m.actualBoundingBoxDescent, 0),
    };
  }
  if (measureCache.size > 6000) measureCache.clear();
  measureCache.set(key, out);
  return out;
}

/** Font-level ascent/descent (like CSS content area) for a font shorthand. */
export function fontMetrics(font, size) {
  checkGen();
  const hit = metricsCache.get(font);
  if (hit) return hit;
  const ctx = getMeasureCtx();
  let asc = size * 0.92, desc = size * 0.26;
  if (ctx) {
    applyFont(ctx, font, 0, 'ltr');
    const m = ctx.measureText('Hgאבגל');
    if (num(m.fontBoundingBoxAscent, 0) > 0) { asc = m.fontBoundingBoxAscent; desc = num(m.fontBoundingBoxDescent, desc); }
    else if (num(m.actualBoundingBoxAscent, 0) > 0) { asc = m.actualBoundingBoxAscent * 1.12; desc = Math.max(m.actualBoundingBoxDescent, size * 0.2); }
  }
  const out = { asc, desc };
  metricsCache.set(font, out);
  return out;
}

/**
 * Lay out text.
 * @param {object} o
 *   paragraphs: [[{text, hot?, sizeMul?, weight?, key?}]]   units (words) per paragraph, logical order
 *   font, weight, size, italic, lineHeight, letterSpacing, maxWidth, align, dir ('auto'|'rtl'|'ltr'),
 *   wordGap (extra px between words), balance (bool)
 * @returns layout | null
 */
export function layoutText(o) {
  if (!getMeasureCtx()) return null;
  const size = Math.max(1, num(o.size, 96));
  const lh = Math.max(0.3, num(o.lineHeight, 1.15));
  const ls = num(o.letterSpacing, 0);
  const family = o.font || 'Heebo';
  const baseWeight = num(o.weight, 800);
  const italic = !!o.italic;
  const maxWidth = num(o.maxWidth, 0);
  const wordGap = num(o.wordGap, 0);
  const paras = Array.isArray(o.paragraphs) ? o.paragraphs : [];
  const baseFont = fontString(family, baseWeight, size, italic);

  // ── base direction for the whole block (dir=auto → first strong char of all text)
  const allGraphemes = [];
  const parsed = paras.map((units) => units.map((u) => {
    const text = String(u.text ?? '').replace(/[ \t]+/g, '\u00a0');
    const g = graphemes(text);
    for (const x of g) allGraphemes.push(x);
    return { ...u, text, g };
  }));
  let baseDir = o.dir === 'rtl' || o.dir === 'ltr' ? o.dir : (firstStrongDir(allGraphemes.map(clusterClass)) || o.defaultDir || 'ltr');
  const paraLevel = baseDir === 'rtl' ? 1 : 0;
  const spaceW = measureRun(' ', baseFont, ls, baseDir).w + wordGap;

  const units = [];
  const segs = [];
  const lines = [];

  parsed.forEach((punits, pi) => {
    // build cluster sequence: unit clusters separated by a space cluster
    const cls = [], spaces = [], owner = [];
    punits.forEach((u, ui) => {
      if (ui > 0) { cls.push('WS'); spaces.push(true); owner.push(-1 - ui); }
      for (const g of u.g) { cls.push(clusterClass(g)); spaces.push(isSpaceLike(g.codePointAt(0))); owner.push(ui); }
    });
    const levels = resolveLevels(cls, paraLevel, { spaces });
    // gap levels: index of space before unit ui
    const gapLevel = new Map();
    let p = 0;
    const unitRecs = punits.map((u, ui) => {
      if (ui > 0) { gapLevel.set(ui, levels[p]); p++; }
      const ulev = [];
      for (let k = 0; k < u.g.length; k++) ulev.push(levels[p + k]);
      p += u.g.length;
      const sizeU = size * num(u.sizeMul, 1);
      const weightU = num(u.weight, baseWeight);
      const font = fontString(family, weightU, sizeU, italic);
      // split into same-level segments (logical order)
      const useg = [];
      let k = 0;
      while (k < u.g.length) {
        let j = k;
        while (j < u.g.length && ulev[j] === ulev[k]) j++;
        const text = u.g.slice(k, j).join('');
        const dir = ulev[k] & 1 ? 'rtl' : 'ltr';
        const segFont = HEBREW_RE.test(text) ? runFontString(family, weightU, sizeU, italic, true) : font;
        const m = measureRun(text, segFont, ls, dir);
        useg.push({ text, g: u.g.slice(k, j), level: ulev[k], dir, font: segFont, size: sizeU, weight: weightU, w: m.w, m, li: useg.length });
        k = j;
      }
      const width = useg.reduce((a, s) => a + s.w, 0);
      return { u, ui, useg, width, font, sizeU, weightU };
    });

    if (!punits.length) {
      // empty paragraph = blank line
      const fm = fontMetrics(baseFont, size);
      const boxH = size * lh;
      const hl = (boxH - (fm.asc + fm.desc)) / 2;
      lines.push({ para: pi, units: [], items: [], width: 0, height: boxH, above: hl + fm.asc, below: hl + fm.desc, last: true });
      return;
    }

    // ── line breaking
    const widths = unitRecs.map((r) => r.width);
    const breakAt = (limit) => {
      const out = [];
      let start = 0, w = 0;
      for (let i = 0; i < widths.length; i++) {
        const add = (i > start ? spaceW : 0) + widths[i];
        if (limit > 0 && i > start && w + add > limit + 0.01) { out.push([start, i]); start = i; w = widths[i]; }
        else w += add;
      }
      out.push([start, widths.length]);
      return out;
    };
    let ranges = breakAt(maxWidth);
    if (o.balance && ranges.length > 1 && maxWidth > 0) {
      const count = ranges.length;
      let lo = Math.max(...widths), hi = maxWidth;
      for (let it = 0; it < 18 && hi - lo > 0.5; it++) {
        const mid = (lo + hi) / 2;
        if (breakAt(mid).length <= count) hi = mid; else lo = mid;
      }
      const r2 = breakAt(hi);
      if (r2.length === count) ranges = r2;
    }

    ranges.forEach(([a, b], ri) => {
      // items in logical order: segments of each unit, with gaps between units
      const items = [];
      for (let ui = a; ui < b; ui++) {
        if (ui > a) items.push({ kind: 'gap', level: gapLevel.get(ui) ?? paraLevel, w: spaceW, before: ui });
        for (const s of unitRecs[ui].useg) items.push({ kind: 'seg', level: s.level, w: s.w, seg: s, ui });
      }
      const order = visualOrder(items.map((it) => it.level));
      const vis = order.map((i) => items[i]);
      // vertical metrics
      let above = 0, below = 0, height = 0;
      for (let ui = a; ui < b; ui++) {
        const r = unitRecs[ui];
        const fm = fontMetrics(r.font, r.sizeU);
        const boxH = r.sizeU * lh;
        const hl = (boxH - (fm.asc + fm.desc)) / 2;
        above = Math.max(above, hl + fm.asc);
        below = Math.max(below, hl + fm.desc);
      }
      height = above + below;
      const width = vis.reduce((acc, it) => acc + it.w, 0);
      lines.push({ para: pi, range: [a, b], items: vis, width, height, above, below, last: ri === ranges.length - 1, unitRecs });
    });
  });

  // ── block size + alignment
  const blockW = lines.reduce((m, l) => Math.max(m, l.width), 0);
  let y = 0;
  const align = o.align || 'center';
  const resolvedAlign = align === 'start' ? (baseDir === 'rtl' ? 'right' : 'left')
    : align === 'end' ? (baseDir === 'rtl' ? 'left' : 'right') : align;
  const unitIndexBase = [];
  let uCounter = 0;
  // global unit numbering in logical order across paragraphs
  parsed.forEach((punits, pi) => { unitIndexBase[pi] = uCounter; uCounter += punits.length; });
  for (let pi = 0; pi < parsed.length; pi++) {
    parsed[pi].forEach((u, ui) => {
      units[unitIndexBase[pi] + ui] = { index: unitIndexBase[pi] + ui, para: pi, text: u.text, hot: !!u.hot, key: u.key, src: u, segs: [], line: -1, x0: Infinity, x1: -Infinity };
    });
  }

  lines.forEach((ln, li) => {
    ln.index = li;
    ln.top = y;
    ln.baseline = y + ln.above;
    let x;
    if (resolvedAlign === 'left') x = 0;
    else if (resolvedAlign === 'right') x = blockW - ln.width;
    else if (resolvedAlign === 'justify') x = baseDir === 'rtl' ? blockW - ln.width : 0;
    else x = (blockW - ln.width) / 2;
    let extraGap = 0;
    if (resolvedAlign === 'justify' && !ln.last) {
      const gaps = ln.items.filter((it) => it.kind === 'gap').length;
      if (gaps > 0) { extraGap = (blockW - ln.width) / gaps; x = 0; }
    }
    ln.left = x;
    for (const it of ln.items) {
      if (it.kind === 'gap') { it.x = x; x += it.w + extraGap; continue; }
      const s = it.seg;
      const gi = unitIndexBase[ln.para] + it.ui;
      const seg = {
        index: segs.length, unit: gi, line: li, li: s.li, text: s.text, g: s.g, level: s.level, dir: s.dir, font: s.font,
        size: s.size, weight: s.weight, x, w: s.w, baseline: ln.baseline, top: ln.top, bottom: ln.top + ln.height,
        inkL: x - Math.max(0, s.m.l), inkR: x + Math.max(s.w, s.m.r), inkT: ln.baseline - Math.max(s.m.a, 0), inkB: ln.baseline + Math.max(s.m.d, 0),
        clusters: null,
      };
      segs.push(seg);
      const U = units[gi];
      U.segs.push(seg.index);
      U.line = li;
      U.x0 = Math.min(U.x0, x);
      U.x1 = Math.max(U.x1, x + s.w);
      x += s.w;
    }
    ln.right = x;
    ln.width = x - ln.left;
    y += ln.height;
  });
  const blockH = y;
  // unit segment order: logical (reading) order of their segments
  for (const U of units) {
    if (!U) continue;
    U.segs.sort((a, b) => segs[a].li - segs[b].li);
    if (U.x0 === Infinity) { U.x0 = 0; U.x1 = 0; }
    const ln = lines[U.line];
    U.top = ln ? ln.top : 0; U.bottom = ln ? ln.top + ln.height : 0; U.baseline = ln ? ln.baseline : 0;
  }
  // ink bounds
  let inkL = 0, inkT = 0, inkR = blockW, inkB = blockH;
  for (const s of segs) {
    inkL = Math.min(inkL, s.inkL); inkR = Math.max(inkR, s.inkR);
    inkT = Math.min(inkT, s.inkT); inkB = Math.max(inkB, s.inkB);
  }
  return {
    width: blockW, height: blockH, baseDir, paraLevel, size, lineHeight: lh, letterSpacing: ls, spaceW,
    family, weight: baseWeight, italic, baseFont, align: resolvedAlign,
    lines: lines.map((l) => ({ index: l.index, top: l.top, height: l.height, baseline: l.baseline, left: l.left, right: l.right, width: l.width, para: l.para, last: l.last })),
    units: units.filter(Boolean), segs,
    ink: { l: inkL, t: inkT, r: inkR, b: inkB },
  };
}

/**
 * Grapheme cluster boxes of a segment (lazy, cached on the segment): [{text, x, w, i}] in logical order,
 * x = absolute left edge in block coordinates. RTL segments place cluster 0 at the right.
 */
export function segClusters(seg, letterSpacing = 0) {
  if (seg.clusters) return seg.clusters;
  const out = [];
  const g = seg.g || [];
  let prev = 0;
  for (let k = 0; k < g.length; k++) {
    const pre = k + 1 === g.length ? seg.w : measureRun(g.slice(0, k + 1).join(''), seg.font, letterSpacing, seg.dir).w;
    const w = Math.max(0, pre - prev);
    const x = seg.dir === 'rtl' ? seg.x + seg.w - pre : seg.x + prev;
    out.push({ text: g[k], x, w, i: k });
    prev = pre;
  }
  seg.clusters = out;
  return out;
}

/** Split plain text content into paragraphs of word units; supports *hot* markup (`*word*`). */
export function splitTextUnits(content, { markup = true } = {}) {
  const paras = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  return paras.map((p) => {
    const words = p.split(/[ \t\u3000]+/).filter((w) => w.length);
    return words.map((w) => {
      if (markup) {
        const m = w.match(/^([("“„'״]*)\*([^*]+)\*([.,!?:;)"”'״…]*)$/);
        if (m) return { text: m[1] + m[2] + m[3], hot: true };
      }
      return { text: w, hot: false };
    });
  });
}
