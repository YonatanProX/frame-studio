// Frame Studio — text / caption / shape / sticker rasterizer (agent T).
//
//   rasterize(clip, t, project, scale=1) → { canvas, w, h, cx, cy, key, version, box, scale } | null
//     canvas  : DEVICE pixels (= canvas px × scale). The canvas object is reused per clip; re-upload the texture
//               whenever `key` (or `version`) changes. Same key ⇒ identical pixels.
//     w, h    : layer size in CANVAS px (= canvas.width / scale) — use as the layer's base size (fit "none").
//     cx, cy  : where the canvas center sits relative to the clip's anchor point, in canvas px (always 0,0 here:
//               padding is symmetric so the anchor = center of the text block / shape / sticker).
//     box     : tight content box {x,y,w,h} in canvas px relative to the canvas center (for handles / hit tests).
//   Text is laid out per word with bidi-correct segments (Hebrew RTL, numbers/Latin LTR inside), wrapped to maxWidth.
//   Animated items re-render only when their per-frame state changes (time quantized to project fps).
//
// Importable in Node (no DOM at module top level); rasterize returns null when no canvas is available.

import {
  clamp01, num, EASE, deepMerge, diffFrom, mMul, mAbout, mTranslate, M_ID, isVisibleColor, withAlpha, alphaOf,
  createCanvas, canvasSupported, roundRectPath, makeLinearGradient, DEG,
} from './text-util.js';
import { FONTS, listFonts, findFont, registerBundledFonts, loadFontVariants, discoverLibraryFonts, fontGeneration, onFontsChanged, setFontBase, fontString, fontFamilyCss } from './text-fonts.js';
import { layoutText, segClusters, splitTextUnits, measureRun, applyFont } from './text-layout.js';
import { TEXT_ANIMS, evalTextAnims, animNeedsChars, identState, combineState } from './text-anims.js';
import { CAPTION_STYLES, getCaptionStyle, evalCaption, captionActiveIndex, captionUnitProps, captionIsSingle, captionNeedsChars } from './text-captions.js';
import { TEXT_PRESETS, getTextPreset } from './text-presets.js';
import { SHAPES, SHAPE_DEFAULTS, getShape, drawShape, shapeBox, shapePad, progressValue } from './text-shapes.js';
import { STICKERS, getSticker, getBuiltinSticker, stickerBox, stickerPad, stickerIsAnimated, drawStickerContent } from './text-stickers.js';

export { FONTS, TEXT_ANIMS, CAPTION_STYLES, TEXT_PRESETS, SHAPES, STICKERS };
export { listFonts, findFont, setFontBase, fontString, fontFamilyCss, onFontsChanged, fontGeneration };
export { getCaptionStyle, captionActiveIndex, getTextPreset, getShape, getSticker, getBuiltinSticker };
export { layoutText, splitTextUnits };

/** Model defaults for the text block (shared/model.js DEFAULT_TEXT) — used to detect user overrides on captions. */
export const TEXT_DEFAULTS = Object.freeze({
  content: 'טקסט', font: 'Heebo', weight: 800, size: 96, color: '#ffffff',
  align: 'center', lineHeight: 1.15, letterSpacing: 0, maxWidth: 900, dir: 'auto', italic: false, underline: false,
  stroke: { color: '#000000', width: 0 },
  shadow: { color: 'rgba(0,0,0,0.6)', blur: 12, x: 0, y: 4 },
  background: { color: '#000000', opacity: 0, padding: 24, radius: 24 },
  glow: { color: '#ffd60a', blur: 0 },
  gradient: null,
});
const TEXT_ANIM_DEFAULTS = Object.freeze({ in: 'none', out: 'none', loop: 'none', inDuration: 0.4, outDuration: 0.3, perWord: false });
const CAPTION_MODEL_DEFAULTS = Object.freeze({ activeColor: '#ffd60a', hotColor: '#ff4d6d' });
const MAX_CANVAS = 8192;
const SIG_ROUND = (v) => Math.round(v * 1000) / 1000;

// ───────────────────────────── style resolution ─────────────────────────────

/** Effective text style of a text/caption clip (caption: style defaults + the user's overrides of the model defaults). */
export function resolveTextStyle(clip) {
  const base = TEXT_DEFAULTS;
  const user = clip && clip.text ? clip.text : {};
  if (clip && clip.type === 'caption') {
    const style = getCaptionStyle(clip.caption && clip.caption.style);
    const over = diffFrom(user, base) || {};
    return deepMerge(deepMerge(base, style.defaults.text || {}), over);
  }
  return deepMerge(base, user);
}
/** Effective caption colors. */
export function resolveCaptionColors(clip) {
  const cap = (clip && clip.caption) || {};
  const style = getCaptionStyle(cap.style);
  const d = style.defaults;
  const pick = (k) => (cap[k] && String(cap[k]).toLowerCase() !== String(CAPTION_MODEL_DEFAULTS[k] || '').toLowerCase() ? cap[k] : (d[k] ?? CAPTION_MODEL_DEFAULTS[k]));
  return {
    active: pick('activeColor'), hot: pick('hotColor'),
    activeText: cap.activeTextColor || d.activeTextColor || null,
  };
}
function textAnimOf(clip) { return { ...TEXT_ANIM_DEFAULTS, ...(clip && clip.textAnim ? clip.textAnim : {}) }; }

/** Caption words with absolute times; re-based to the clip start when they don't overlap the clip at all. */
function captionWords(clip) {
  const words = (clip.caption && Array.isArray(clip.caption.words) ? clip.caption.words : [])
    .filter((w) => w && String(w.w ?? '').trim().length)
    .map((w) => ({ w: String(w.w).trim(), s: num(w.s, 0), e: num(w.e, num(w.s, 0) + 0.3), hot: !!w.hot }));
  if (!words.length) return words;
  const start = num(clip.start, 0), end = start + Math.max(0, num(clip.duration, 0));
  const first = words[0].s, last = words[words.length - 1].e;
  if (last < start - 0.01 || first >= end + 0.01) {
    const off = start - first;
    for (const w of words) { w.s += off; w.e += off; }
  }
  return words;
}

// ───────────────────────────── counters ─────────────────────────────

function formatNumber(v, decimals, sep) {
  const neg = v < 0;
  let s = Math.abs(v).toFixed(Math.max(0, Math.min(6, decimals | 0)));
  if (sep) {
    const [i, f] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + (f ? '.' + f : '');
  }
  return (neg ? '-' : '') + s;
}
/** Counter text at local time. counter: {from,to,decimals,prefix,suffix,mode:'smooth'|'steps',ease,separator,duration} */
export function counterText(counter, localT, dur) {
  const from = num(counter.from, 0), to = num(counter.to, 100);
  const span = num(counter.duration, counter.mode === 'steps' ? dur : dur * 0.8);
  const p = span > 0 ? clamp01(localT / span) : 1;
  let v;
  if (counter.mode === 'steps') {
    const count = Math.max(1, Math.floor(Math.abs(to - from)) + 1);
    const idx = Math.min(count - 1, Math.floor(p * count));
    v = from + Math.sign(to - from) * idx;
  } else {
    const ease = EASE[counter.ease] || EASE.out3;
    v = from + (to - from) * ease(p);
  }
  return `${counter.prefix ?? ''}${formatNumber(v, num(counter.decimals, 0), counter.separator ?? '')}${counter.suffix ?? ''}`;
}

// ───────────────────────────── layout cache ─────────────────────────────

const layoutCache = new Map();
function cachedLayout(opts) {
  const key = fontGeneration() + '|' + JSON.stringify(opts);
  let L = layoutCache.get(key);
  if (L) { layoutCache.delete(key); layoutCache.set(key, L); return L; }
  L = layoutText(opts);
  if (!L) return null;
  // global char numbering (logical order: units → segments → clusters)
  let c = 0;
  for (const U of L.units) {
    U.c0 = c;
    for (const si of U.segs) { const s = L.segs[si]; s.c0 = c; c += s.g.length; }
    U.c1 = c;
  }
  L.nChars = c;
  layoutCache.set(key, L);
  if (layoutCache.size > 400) layoutCache.delete(layoutCache.keys().next().value);
  return L;
}
function layoutOpts(txt, paragraphs) {
  return {
    paragraphs, font: txt.font || 'Heebo', weight: num(txt.weight, 800), size: num(txt.size, 96), italic: !!txt.italic,
    lineHeight: num(txt.lineHeight, 1.15), letterSpacing: num(txt.letterSpacing, 0), maxWidth: num(txt.maxWidth, 0),
    align: txt.align || 'center', dir: txt.dir || 'auto', wordGap: num(txt.wordSpacing, 0), balance: !!txt.balance,
  };
}

// ───────────────────────────── geometry (static per content) ─────────────────────────────

function effectPad(txt) {
  const sw = Math.max(0, num(txt.stroke && txt.stroke.width, 0));
  let pad = 3 + sw / 2;
  const sh = txt.shadow;
  const shadowOn = sh && isVisibleColor(sh.color) && (num(sh.blur, 0) > 0 || num(sh.x, 0) || num(sh.y, 0));
  const shadowExt = shadowOn ? num(sh.blur, 0) * 1.5 + Math.max(Math.abs(num(sh.x, 0)), Math.abs(num(sh.y, 0))) : 0;
  const glowBlur = txt.glow && num(txt.glow.blur, 0) > 0 ? num(txt.glow.blur, 0) : 0;
  const glowExt = glowBlur * 1.6;
  const ext = txt.depth3d ? num(txt.depth3d.depth, 10) + 2 : 0;
  return pad + Math.max(shadowExt, glowExt) + ext;
}

/** Build static geometry for a text/caption clip (layouts + canvas size). */
function buildTextGeom(clip, project) {
  const txt = resolveTextStyle(clip);
  const anim = textAnimOf(clip);
  const isCap = clip.type === 'caption';
  const dur = Math.max(1e-3, num(clip.duration, 3));
  const fps = num(project && project.settings && project.settings.fps, 30) || 30;
  const G = { clip, txt, anim, isCap, dur, fps, start: num(clip.start, 0), size: num(txt.size, 96), layouts: [], mode: 'plain' };
  if (isCap) {
    const style = getCaptionStyle(clip.caption && clip.caption.style);
    G.styleId = style.id;
    G.words = captionWords(clip);
    G.colors = resolveCaptionColors(clip);
    const units = G.words.map((w) => ({ text: w.w, hot: w.hot, ...(captionUnitProps(style.id, w) || {}) }));
    if (!units.length) return null;
    if (captionIsSingle(style.id)) {
      G.mode = 'single';
      for (const u of units) { const L = cachedLayout(layoutOpts(txt, [[u]])); if (!L) return null; G.layouts.push(L); }
    } else {
      const L = cachedLayout(layoutOpts(txt, [units]));
      if (!L) return null;
      G.layouts.push(L);
    }
  } else if (txt.counter && typeof txt.counter === 'object') {
    G.mode = 'counter';
    const c = txt.counter;
    const candidates = new Set([counterText(c, 0, dur), counterText(c, dur * 10, dur)]);
    G.counterLayouts = new Map();
    for (const s of candidates) {
      const L = cachedLayout(layoutOpts(txt, splitTextUnits(s, { markup: false })));
      if (!L) return null;
      G.counterLayouts.set(s, L);
      G.layouts.push(L);
    }
  } else {
    const paras = splitTextUnits(txt.content ?? '', { markup: txt.markup !== false });
    if (!paras.some((p) => p.length)) return null;
    const L = cachedLayout(layoutOpts(txt, paras));
    if (!L) return null;
    G.layouts.push(L);
  }
  G.frameW = Math.max(...G.layouts.map((L) => L.width), 1);
  G.frameH = Math.max(...G.layouts.map((L) => L.height), 1);
  G.hotColor = txt.hotColor || '#ff4d6d';
  G.accent = (txt.glow && txt.glow.color) || '#ffd60a';
  G.needChars = animNeedsChars(anim) || (isCap && captionNeedsChars(G.styleId));
  computeEnvelope(G);
  return G;
}

function layoutAt(G, localT, capState) {
  if (G.mode === 'single') {
    const idx = capState && capState.single >= 0 ? capState.single : -1;
    return idx >= 0 ? G.layouts[idx] : null;
  }
  if (G.mode === 'counter') {
    const s = counterText(G.txt.counter, localT, G.dur);
    let L = G.counterLayouts.get(s);
    if (!L) { L = cachedLayout(layoutOpts(G.txt, splitTextUnits(s, { markup: false }))); if (L) G.counterLayouts.set(s, L); }
    if (G.counterLayouts.size > 300) G.counterLayouts.clear();
    return L;
  }
  return G.layouts[0];
}

/** Per-frame states for a text geometry. */
function frameStates(G, localT) {
  const absT = G.start + localT;
  let cap = null;
  if (G.isCap) {
    const L0 = G.mode === 'single' ? null : G.layouts[0];
    cap = evalCaption(G.styleId, {
      t: absT, words: G.words, start: G.start, end: G.start + G.dur, size: G.size, color: G.txt.color,
      active: G.colors.active, hot: G.colors.hot, activeText: G.colors.activeText,
      nChars: L0 ? L0.nChars : 0,
      gap: L0 ? L0.spaceW : 0,
      unitWidth: (i) => (L0 && L0.units[i] ? L0.units[i].x1 - L0.units[i].x0 : 0),
      unitChars: (i) => { if (!L0) return []; const U = L0.units[i]; const a = []; for (let k = U.c0; k < U.c1; k++) a.push(k); return a; },
    });
  }
  const L = layoutAt(G, localT, cap);
  if (!L) return { L: null, cap, ta: null };
  let charInfo = null;
  const getCharInfo = () => {
    if (charInfo) return charInfo;
    charInfo = new Array(L.nChars);
    for (const s of L.segs) {
      const cl = segClusters(s, L.letterSpacing);
      cl.forEach((c, k) => { charInfo[s.c0 + k] = { text: c.text, cx: c.x + c.w / 2 }; });
    }
    return charInfo;
  };
  const ta = evalTextAnims(G.anim, {
    t: localT, dur: G.dur, fps: G.fps, frame: Math.round(localT * G.fps), size: G.size, color: G.txt.color, accent: G.accent,
    counts: { line: L.lines.length, word: L.units.length, char: L.nChars },
    blockCx: L.width / 2,
    charCx: (i) => (getCharInfo()[i] ? getCharInfo()[i].cx : L.width / 2),
    charText: (i) => { for (const s of L.segs) if (i >= s.c0 && i < s.c0 + s.g.length) return s.g[i - s.c0]; return ''; },
  });
  return { L, cap, ta };
}

/** Collect drawables (per segment or per cluster) with matrices in FRAME-block coordinates. */
function collectDrawables(G, F) {
  const { L, cap, ta } = F;
  const out = { items: [], textM: null, lineM: [], unitM: [], unitState: [], textState: null, L };
  if (!L) return out;
  const dx = (G.frameW - L.width) / 2, dy = (G.frameH - L.height) / 2;
  const Mbase = mTranslate(dx, dy);
  const ts = ta.text;
  const Mt = mMul(Mbase, mAbout(L.width / 2, L.height / 2, ts.x, ts.y, ts.r, ts.s * ts.sx, ts.s * ts.sy));
  out.textM = Mt; out.textState = ts;
  const lineM = L.lines.map((ln, li) => {
    const st = ta.lines ? ta.lines[li] : null;
    if (!st) return Mt;
    const cx = (ln.left + ln.right) / 2, cy = ln.top + ln.height / 2;
    return mMul(Mt, mAbout(cx, cy, st.x, st.y, st.r, st.s * st.sx, st.s * st.sy));
  });
  out.lineM = lineM;
  const nU = L.units.length;
  // per-unit combined state (caption style ∘ text anim word state)
  for (let ui = 0; ui < nU; ui++) {
    const st = identState();
    if (cap) {
      const capIdx = G.mode === 'single' ? (cap.single >= 0 ? cap.single : ui) : ui;
      if (cap.words && cap.words[capIdx]) combineState(st, cap.words[capIdx]);
    }
    if (ta.words && ta.words[ui]) combineState(st, ta.words[ui]);
    out.unitState[ui] = st;
  }
  const charsNeeded = !!((ta.needChars && ta.chars) || (cap && cap.chars && G.mode !== 'single'));
  const baseOpacity = ts.o;
  for (const seg of L.segs) {
    const ui = seg.unit;
    const U = L.units[ui];
    const ln = L.lines[seg.line];
    const lst = ta.lines ? ta.lines[seg.line] : null;
    const ust = out.unitState[ui];
    const lineCy = ln.top + ln.height / 2;
    const pivotY = lineCy + (ust.py ? ust.py * ln.height : 0);
    // a word whose bidi segments sit side by side ("123 BPM" + "!") moves as one unit around its own center;
    // only a word split apart by other words (e.g. "ב-" … "120 BPM") transforms each piece around the piece center
    if (U.contiguous === undefined) {
      const sumW = U.segs.reduce((a, si) => a + L.segs[si].w, 0);
      U.contiguous = Math.abs((U.x1 - U.x0) - sumW) < 0.5;
    }
    const segCx = U.contiguous ? (U.x0 + U.x1) / 2 : seg.x + seg.w / 2;
    const Mw = mMul(lineM[seg.line], mAbout(segCx, pivotY, ust.x, ust.y, ust.r, ust.s * ust.sx, ust.s * ust.sy));
    out.unitM[ui] = out.unitM[ui] || mMul(lineM[seg.line], mAbout((U.x0 + U.x1) / 2, pivotY, ust.x, ust.y, ust.r, ust.s * ust.sx, ust.s * ust.sy));
    const o = baseOpacity * (lst ? lst.o : 1) * ust.o;
    const fillOverride = ust.c ?? (lst && lst.c) ?? ts.c ?? (U.hot ? G.hotColor : null);
    const common = {
      seg, unit: ui, line: seg.line, font: seg.font, dir: seg.dir, baseline: seg.baseline, top: ln.top, bottom: ln.top + ln.height,
      blur: ts.b + (lst ? lst.b : 0) + ust.b,
      fill: fillOverride, stroke: ust.sc ?? ts.sc ?? null, glowColor: ust.gc ?? ts.gc ?? null,
      glow: (ts.g || 0) + (lst && lst.g ? lst.g : 0) + (ust.g || 0), rgb: (ts.rgb || 0) + (ust.rgb || 0),
      ovL: Math.max(0, seg.x - seg.inkL), ovR: Math.max(0, seg.inkR - (seg.x + seg.w)), inkT: seg.inkT, inkB: seg.inkB,
    };
    if (!charsNeeded) {
      if (o <= 0.002) continue;
      out.items.push({ ...common, text: seg.text, x: seg.x, w: seg.w, M: Mw, o });
      continue;
    }
    const cls = segClusters(seg, L.letterSpacing);
    for (let k = 0; k < cls.length; k++) {
      const ci = seg.c0 + k;
      const cst = identState();
      if (cap && cap.chars && cap.chars[ci]) combineState(cst, cap.chars[ci]);
      if (ta.chars && ta.chars[ci]) combineState(cst, ta.chars[ci]);
      const oc = o * cst.o;
      if (oc <= 0.002) continue;
      const c = cls[k];
      const M = mMul(Mw, mAbout(c.x + c.w / 2, pivotY, cst.x, cst.y, cst.r, cst.s * cst.sx, cst.s * cst.sy));
      let text = c.text, x = c.x;
      if (cst.ch != null && cst.ch !== c.text) {
        text = cst.ch;
        const mw = measureRun(text, seg.font, L.letterSpacing, seg.dir).w;
        x = c.x + (c.w - mw) / 2;
      }
      out.items.push({
        ...common, text, x, w: c.w, M, o: oc, blur: common.blur + cst.b,
        fill: cst.c ?? common.fill, glow: common.glow + (cst.g || 0), rgb: common.rgb + (cst.rgb || 0),
        ovL: k === 0 || seg.dir === 'rtl' ? common.ovL : 0, ovR: common.ovR,
      });
    }
  }
  return out;
}

function transformRect(M, x0, y0, x1, y1, acc) {
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (const [x, y] of pts) {
    const X = M[0] * x + M[2] * y + M[4], Y = M[1] * x + M[3] * y + M[5];
    if (X < acc.l) acc.l = X; if (X > acc.r) acc.r = X;
    if (Y < acc.t) acc.t = Y; if (Y > acc.b) acc.b = Y;
  }
}

function bgBoxes(G, D) {
  // background rects in frame-block coordinates with their matrices
  const bg = G.txt.background || {};
  const out = [];
  if (!(num(bg.opacity, 0) > 0) || !isVisibleColor(bg.color)) return out;
  const L = D.L;
  if (!L) return out;
  const pad = Math.max(0, num(bg.padding, 24));
  const mode = bg.mode || 'block';
  if (mode === 'line') {
    L.lines.forEach((ln, li) => {
      if (ln.right - ln.left <= 0) return;
      const vp = Math.min(pad * 0.5, ln.height * 0.3);
      out.push({ M: D.lineM[li], x: ln.left - pad, y: ln.top - vp, w: ln.right - ln.left + pad * 2, h: ln.height + vp * 2, r: num(bg.radius, 24), line: li });
    });
  } else if (mode === 'word') {
    L.units.forEach((U, ui) => {
      const ln = L.lines[U.line];
      if (!ln) return;
      const vp = Math.min(pad * 0.5, ln.height * 0.3);
      const px = Math.min(pad * 0.6, Math.max(2, L.spaceW * 0.5 - 4)); // keep neighbouring word boxes apart
      out.push({ M: D.unitM[ui] || D.textM, x: U.x0 - px, y: ln.top - vp, w: U.x1 - U.x0 + px * 2, h: ln.height + vp * 2, r: num(bg.radius, 24), unit: ui });
    });
  } else {
    out.push({ M: D.textM, x: -pad, y: -pad, w: L.width + pad * 2, h: L.height + pad * 2, r: num(bg.radius, 24) });
  }
  return out;
}

function capBoxes(G, D, cap) {
  const out = [];
  if (!cap || !cap.boxes || !D.L) return out;
  const L = D.L;
  cap.boxes.forEach((bx, ui) => {
    if (!bx || !L.units[ui]) return;
    const U = L.units[ui];
    const ln = L.lines[U.line];
    const size = G.size;
    if (bx.mode === 'marker') {
      // highlighter-pen stroke: covers the whole word (stroke included), sweeps in from the reading-start edge
      const sw = Math.max(0, num(G.txt.stroke && G.txt.stroke.width, 0));
      const padX = size * 0.1 + sw / 2;
      const w = U.x1 - U.x0 + padX * 2;
      const grow = clamp01(num(bx.grow, 1));
      const rtl = L.segs[U.segs[0]] && L.segs[U.segs[0]].dir === 'rtl';
      const gw = w * grow;
      const x = rtl ? U.x1 + padX - gw : U.x0 - padX;
      const top = Math.min(U.baseline - size * 0.82, ln.top + ln.height * 0.06) - sw / 2;
      const bottom = U.baseline + size * 0.2 + sw / 2;
      out.push({ M: D.unitM[ui], x, y: top, w: gw, h: bottom - top, r: size * 0.06, color: bx.color, alpha: bx.alpha, scale: 1, unit: ui, rot: -1.2 });
    } else {
      const padX = size * 0.16;
      const y = ln.top + ln.height * 0.04, h = ln.height * 0.92;
      out.push({ M: D.unitM[ui], x: U.x0 - padX, y, w: U.x1 - U.x0 + padX * 2, h, r: size * 0.2, color: bx.color, alpha: bx.alpha, scale: num(bx.scale, 1), unit: ui });
    }
  });
  return out;
}

/** Sample the animation over time to find the union of everything ever drawn → fixed canvas size. */
function computeEnvelope(G) {
  const times = new Set();
  const dur = G.dur;
  const add = (t) => { if (t >= 0 && t <= dur) times.add(Math.round(t * 1000) / 1000); };
  add(0); add(dur * 0.5); add(Math.max(0, dur - 1e-3));
  const a = G.anim;
  if (a.in && a.in !== 'none') { const D = Math.min(dur, num(a.inDuration, 0.4)); for (let k = 0; k <= 16; k++) add((D * k) / 16); }
  if (a.in === 'karaokeFill') for (let k = 0; k <= 24; k++) add((dur * k) / 24);
  if (a.out && a.out !== 'none') { const D = Math.min(dur, num(a.outDuration, 0.3)); for (let k = 0; k <= 16; k++) add(dur - D + (D * k) / 16); }
  if (a.loop && a.loop !== 'none') { const span = Math.min(dur, 4 / Math.max(0.25, num(a.loopSpeed, 1))); for (let k = 0; k <= 60; k++) add((span * k) / 60); }
  if (G.isCap) {
    for (const w of G.words) for (const d of [0, 0.02, 0.04, 0.065, 0.09, 0.12, 0.16, 0.2, 0.26, 0.33, 0.45]) add(w.s - G.start + d);
  }
  if (G.mode === 'counter') for (let k = 0; k <= 10; k++) add((dur * k) / 10);
  const acc = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
  // always include every layout's own box
  for (const L of G.layouts) {
    const dx = (G.frameW - L.width) / 2, dy = (G.frameH - L.height) / 2;
    transformRect(M_ID, dx + Math.min(0, L.ink.l), dy + Math.min(0, L.ink.t), dx + Math.max(L.width, L.ink.r), dy + Math.max(L.height, L.ink.b), acc);
  }
  const bgPadShadow = (() => {
    const sh = G.txt.shadow;
    return sh && isVisibleColor(sh.color) ? num(sh.blur, 0) * 1.5 + Math.max(Math.abs(num(sh.x, 0)), Math.abs(num(sh.y, 0))) : 0;
  })();
  let bgAcc = null;
  const sortedTimes = [...times].sort((x, y) => x - y);
  const singleSeen = new Set();
  for (const t of sortedTimes) {
    const F = frameStates(G, t);
    if (!F.L) continue;
    const D = collectDrawables(G, F);
    for (const it of D.items) {
      const bl = it.blur * 1.6;
      transformRect(it.M, it.x - it.ovL - bl, Math.min(it.inkT, it.top) - bl, it.x + it.w + it.ovR + bl, Math.max(it.inkB, it.bottom) + bl, acc);
    }
    for (const b of bgBoxes(G, D).concat(capBoxes(G, D, F.cap))) {
      bgAcc = bgAcc || { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
      const sc = b.scale || 1;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      transformRect(b.M, cx - (b.w / 2) * Math.max(1, sc), cy - (b.h / 2) * Math.max(1, sc), cx + (b.w / 2) * Math.max(1, sc), cy + (b.h / 2) * Math.max(1, sc), bgAcc);
    }
    if (G.mode === 'single' && F.cap) singleSeen.add(F.cap.single);
  }
  if (G.mode === 'single') {
    // make sure every word's resting layout is inside (in case sampling missed one)
    G.layouts.forEach((L, i) => {
      if (singleSeen.has(i)) return;
      const dx = (G.frameW - L.width) / 2, dy = (G.frameH - L.height) / 2;
      transformRect(M_ID, dx - L.size * 0.3, dy - L.size * 0.3, dx + L.width + L.size * 0.3, dy + L.height + L.size * 0.3, acc);
    });
  }
  const ep = effectPad(G.txt);
  const cxF = G.frameW / 2, cyF = G.frameH / 2;
  let halfW = Math.max(cxF - acc.l, acc.r - cxF) + ep;
  let halfH = Math.max(cyF - acc.t, acc.b - cyF) + ep;
  if (bgAcc) {
    halfW = Math.max(halfW, Math.max(cxF - bgAcc.l, bgAcc.r - cxF) + bgPadShadow + 2);
    halfH = Math.max(halfH, Math.max(cyF - bgAcc.t, bgAcc.b - cyF) + bgPadShadow + 2);
  }
  G.halfW = Math.ceil(halfW + 1);
  G.halfH = Math.ceil(halfH + 1);
  const bg = G.txt.background || {};
  const bgPad = num(bg.opacity, 0) > 0 ? Math.max(0, num(bg.padding, 0)) : 0;
  G.box = { x: -G.frameW / 2 - bgPad, y: -G.frameH / 2 - bgPad, w: G.frameW + bgPad * 2, h: G.frameH + bgPad * 2 };
}

// ───────────────────────────── drawing ─────────────────────────────

let scratch = null;
function getScratch(w, h) {
  if (!scratch) scratch = createCanvas(Math.max(64, w), Math.max(64, h));
  if (!scratch) return null;
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, Math.ceil(w));
    scratch.height = Math.max(scratch.height, Math.ceil(h));
  }
  const ctx = scratch.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return { canvas: scratch, ctx };
}

let scratch2 = null;
function getScratch2(w, h) {
  if (!scratch2) scratch2 = createCanvas(Math.max(64, w), Math.max(64, h));
  if (!scratch2) return null;
  if (scratch2.width < w || scratch2.height < h) {
    scratch2.width = Math.max(scratch2.width, Math.ceil(w));
    scratch2.height = Math.max(scratch2.height, Math.ceil(h));
  }
  const ctx = scratch2.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  return { canvas: scratch2, ctx };
}

function setM(ctx, scale, ox, oy, M) {
  ctx.setTransform(scale * M[0], scale * M[1], scale * M[2], scale * M[3], scale * (M[4] + ox), scale * (M[5] + oy));
}
function resetShadow(ctx) { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }

function drawTextFrame(ctx, G, F, scale, W, H) {
  const txt = G.txt;
  const D = collectDrawables(G, F);
  const ox = G.halfW - G.frameW / 2, oy = G.halfH - G.frameH / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!D.L) return;
  const L = D.L;
  const ts = D.textState;
  const letterSpacing = L.letterSpacing;
  const strokeW = Math.max(0, num(txt.stroke && txt.stroke.width, 0));
  const strokeColor = (txt.stroke && txt.stroke.color) || '#000000';
  const strokeOn = strokeW > 0 && isVisibleColor(strokeColor);
  const sh = txt.shadow || {};
  const shadowOn = isVisibleColor(sh.color) && (num(sh.blur, 0) > 0 || num(sh.x, 0) !== 0 || num(sh.y, 0) !== 0);
  const bg = txt.background || {};
  const bgOn = num(bg.opacity, 0) > 0 && isVisibleColor(bg.color);
  const OFF = Math.ceil(W + 200);
  const blurFilter = (b) => (b > 0.05 ? `blur(${Math.round(b * scale * 100) / 100}px)` : 'none');

  // gradient (block space of the active layout)
  let gradient = null;
  if (txt.gradient && (txt.gradient.from || txt.gradient.stops)) {
    gradient = makeLinearGradient(ctx, txt.gradient, 0, 0, L.width, L.height);
  }

  // ── P0: background boxes (into scratch → composited with opacity + box shadow)
  if (bgOn) {
    const boxes = bgBoxes(G, D);
    const S = getScratch(W, H);
    if (S && boxes.length) {
      const c2 = S.ctx;
      c2.fillStyle = withAlpha(bg.color, 1);
      for (const b of boxes) {
        // boxes follow the opacity of their word / line (text-level opacity is applied when compositing)
        let a = 1;
        if (b.unit != null) a = D.unitState[b.unit] ? D.unitState[b.unit].o : 1;
        else if (b.line != null && F.ta && F.ta.lines && F.ta.lines[b.line]) a = F.ta.lines[b.line].o;
        if (a <= 0.002) continue;
        c2.globalAlpha = clamp01(a);
        setM(c2, scale, ox, oy, b.M);
        roundRectPath(c2, b.x, b.y, b.w, b.h, b.r);
        c2.fill();
      }
      c2.globalAlpha = 1;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = clamp01(num(bg.opacity, 1)) * alphaOf(bg.color) * ts.o;
      if (shadowOn) {
        ctx.shadowColor = sh.color; ctx.shadowBlur = num(sh.blur, 0) * scale;
        ctx.shadowOffsetX = num(sh.x, 0) * scale; ctx.shadowOffsetY = num(sh.y, 0) * scale;
      }
      ctx.drawImage(S.canvas, 0, 0, W, H, 0, 0, W, H);
      ctx.restore();
    }
  }

  // ── P1: caption highlight boxes / markers
  for (const b of capBoxes(G, D, F.cap)) {
    if (!(b.alpha > 0.002) || !(b.w > 0)) continue;
    ctx.save();
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const M = mMul(b.M, mAbout(cx, cy, 0, 0, b.rot || 0, b.scale || 1, b.scale || 1));
    setM(ctx, scale, ox, oy, M);
    ctx.globalAlpha = clamp01(b.alpha) * ts.o * (D.unitState[b.unit] ? D.unitState[b.unit].o : 1);
    roundRectPath(ctx, b.x, b.y, b.w, b.h, b.r);
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.restore();
  }

  const items = D.items;
  if (!items.length) return;
  const drawGlyph = (c, it, mode) => {
    applyFont(c, it.font, letterSpacing, it.dir);
    if (mode === 'stroke') c.strokeText(it.text, it.x, it.baseline);
    else c.fillText(it.text, it.x, it.baseline);
  };

  // ── P2: text shadow (silhouettes into scratch, one blurred shadow for the union)
  if (shadowOn && !bgOn) {
    const S = getScratch(W, H);
    if (S) {
      const c2 = S.ctx;
      c2.fillStyle = '#000'; c2.strokeStyle = '#000';
      c2.lineJoin = 'round'; c2.lineCap = 'round'; c2.miterLimit = 2;
      for (const it of items) {
        setM(c2, scale, ox, oy, it.M);
        c2.globalAlpha = clamp01(it.o);
        c2.filter = blurFilter(it.blur);
        if (strokeOn) { c2.lineWidth = strokeW; drawGlyph(c2, it, 'stroke'); }
        drawGlyph(c2, it, 'fill');
      }
      c2.filter = 'none';
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.shadowColor = sh.color;
      ctx.shadowBlur = num(sh.blur, 0) * scale;
      ctx.shadowOffsetX = num(sh.x, 0) * scale + OFF;
      ctx.shadowOffsetY = num(sh.y, 0) * scale;
      ctx.drawImage(S.canvas, 0, 0, W, H, -OFF, 0, W, H);
      ctx.restore();
    }
  }

  // ── P3: glow (per drawable, shadow-only trick so per-word glow colors/strengths work)
  const glowBase = txt.glow && num(txt.glow.blur, 0) > 0 ? Math.max(0, num(txt.glow.strength, 1)) : 0;
  const glowBlur = txt.glow && num(txt.glow.blur, 0) > 0 ? num(txt.glow.blur, 0) : G.size * 0.22;
  for (const it of items) {
    const amount = glowBase + (it.glow || 0);
    if (amount <= 0.01) continue;
    const color = it.glowColor || (txt.glow && txt.glow.color) || G.accent;
    const passes = Math.min(5, Math.ceil(amount));
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = glowBlur * scale;
    ctx.shadowOffsetX = OFF;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.filter = blurFilter(it.blur);
    for (let k = 0; k < passes; k++) {
      const frac = k === passes - 1 ? amount - (passes - 1) : 1;
      ctx.globalAlpha = clamp01(it.o * frac);
      const M = it.M;
      ctx.setTransform(scale * M[0], scale * M[1], scale * M[2], scale * M[3], scale * (M[4] + ox) - OFF, scale * (M[5] + oy));
      if (strokeOn) { ctx.lineWidth = strokeW; drawGlyph(ctx, it, 'stroke'); }
      drawGlyph(ctx, it, 'fill');
    }
    ctx.restore();
  }

  // ── P4: 3D extrusion
  if (txt.depth3d && num(txt.depth3d.depth, 0) > 0) {
    const depth = Math.min(80, num(txt.depth3d.depth, 10));
    const ang = num(txt.depth3d.angle, 135) * DEG; // CSS-like: 0 = up, 90 = right, 135 = down-right
    const dxu = Math.sin(ang), dyu = -Math.cos(ang);
    ctx.save();
    ctx.fillStyle = txt.depth3d.color || '#000000';
    ctx.strokeStyle = txt.depth3d.color || '#000000';
    ctx.lineJoin = 'round';
    for (const it of items) {
      ctx.globalAlpha = clamp01(it.o);
      ctx.filter = blurFilter(it.blur);
      for (let k = Math.ceil(depth); k >= 1; k -= 1) {
        const M = mMul(mTranslate(dxu * k, dyu * k), it.M);
        setM(ctx, scale, ox, oy, M);
        if (strokeOn) { ctx.lineWidth = strokeW; drawGlyph(ctx, it, 'stroke'); }
        drawGlyph(ctx, it, 'fill');
      }
    }
    ctx.restore();
  }

  // ── P5: stroke (under fill, round joins)
  if (strokeOn || items.some((it) => it.stroke)) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.miterLimit = 2;
    ctx.lineWidth = strokeW;
    for (const it of items) {
      if (!strokeOn) continue;
      setM(ctx, scale, ox, oy, it.M);
      ctx.globalAlpha = clamp01(it.o);
      ctx.filter = blurFilter(it.blur);
      ctx.strokeStyle = it.stroke || strokeColor;
      drawGlyph(ctx, it, 'stroke');
    }
    ctx.restore();
  }

  // ── P6: fill (+ RGB split copies)
  ctx.save();
  const baseFillVisible = gradient || isVisibleColor(txt.color);
  for (const it of items) {
    setM(ctx, scale, ox, oy, it.M);
    ctx.filter = blurFilter(it.blur);
    if (it.rgb > 0.05) {
      ctx.globalAlpha = clamp01(it.o * 0.85);
      ctx.fillStyle = '#ff2a6d';
      const M1 = mMul(mTranslate(-it.rgb, 0), it.M); setM(ctx, scale, ox, oy, M1); drawGlyph(ctx, it, 'fill');
      ctx.fillStyle = '#05d9e8';
      const M2 = mMul(mTranslate(it.rgb, 0), it.M); setM(ctx, scale, ox, oy, M2); drawGlyph(ctx, it, 'fill');
      setM(ctx, scale, ox, oy, it.M);
    }
    const fill = it.fill || (gradient && !it.fill ? gradient : txt.color);
    if (!it.fill && !baseFillVisible) continue;
    if (typeof fill === 'string' && !isVisibleColor(fill)) continue;
    ctx.globalAlpha = clamp01(it.o);
    ctx.fillStyle = fill;
    drawGlyph(ctx, it, 'fill');
  }
  ctx.restore();

  // ── P7: underline (whole text) + per-word underline sweeps (kinetic captions)
  const ulThick = Math.max(1.5, G.size * 0.065);
  const ulOffset = G.size * 0.14;
  const drawUL = (M, x0, x1, baseline, color, alpha) => {
    if (x1 - x0 <= 0.5 || alpha <= 0.002) return;
    ctx.save();
    setM(ctx, scale, ox, oy, M);
    ctx.globalAlpha = clamp01(alpha);
    const y = baseline + ulOffset;
    if (strokeOn) {
      roundRectPath(ctx, x0, y, x1 - x0, ulThick, ulThick / 2);
      ctx.lineWidth = strokeW; ctx.lineJoin = 'round'; ctx.strokeStyle = strokeColor; ctx.stroke();
    }
    roundRectPath(ctx, x0, y, x1 - x0, ulThick, ulThick / 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  };
  const unitMoves = D.unitState.some((s) => s && (s.x || s.y || s.r || s.s !== 1 || s.sx !== 1 || s.sy !== 1));
  if (txt.underline) {
    const ulColor = typeof txt.color === 'string' && isVisibleColor(txt.color) ? txt.color : strokeColor;
    if (!unitMoves && !(F.ta && F.ta.needChars)) {
      L.lines.forEach((ln, li) => {
        if (ln.right - ln.left > 0) drawUL(D.lineM[li], ln.left, ln.right, ln.baseline, ulColor, ts.o * (F.ta.lines && F.ta.lines[li] ? F.ta.lines[li].o : 1));
      });
    } else {
      L.units.forEach((U, ui) => {
        const st = D.unitState[ui];
        if (D.unitM[ui]) drawUL(D.unitM[ui], U.x0, U.x1, U.baseline, st.c || ulColor, ts.o * st.o);
      });
    }
  }
  L.units.forEach((U, ui) => {
    const st = D.unitState[ui];
    if (!st || st.ul == null || !(st.ul > 0) || !D.unitM[ui]) return;
    const w = (U.x1 - U.x0) * clamp01(st.ul);
    const rtl = L.segs[U.segs[0]] && L.segs[U.segs[0]].dir === 'rtl';
    const x0 = rtl ? U.x1 - w : U.x0;
    drawUL(D.unitM[ui], x0, x0 + w, U.baseline + G.size * 0.03, st.ulc || st.c || txt.color, ts.o * st.o);
  });
}

// signature of a frame's visual state (same signature ⇒ same pixels)
function frameSignature(G, F) {
  if (!F.L) return 'empty';
  const parts = [F.L === G.layouts[0] ? 'L0' : (F.L.units.map((u) => u.text).join('\u0001'))];
  const pushS = (s) => {
    if (!s) { parts.push('-'); return; }
    parts.push(`${SIG_ROUND(s.o)},${SIG_ROUND(s.x)},${SIG_ROUND(s.y)},${SIG_ROUND(s.s)},${SIG_ROUND(s.sx)},${SIG_ROUND(s.sy)},${SIG_ROUND(s.r)},${SIG_ROUND(s.b)},${s.c ?? ''},${s.sc ?? ''},${s.gc ?? ''},${SIG_ROUND(s.g || 0)},${SIG_ROUND(s.rgb || 0)},${s.ch ?? ''},${s.py ?? ''},${s.ul == null ? '' : SIG_ROUND(s.ul)},${s.ulc ?? ''}`);
  };
  const ta = F.ta;
  pushS(ta.text);
  if (ta.lines) ta.lines.forEach(pushS);
  if (ta.words) ta.words.forEach(pushS);
  if (ta.chars) ta.chars.forEach(pushS);
  if (F.cap) {
    parts.push('cap' + F.cap.single);
    F.cap.words.forEach(pushS);
    if (F.cap.chars) F.cap.chars.forEach(pushS);
    if (F.cap.boxes) F.cap.boxes.forEach((b) => parts.push(b ? `${b.color},${SIG_ROUND(b.alpha)},${SIG_ROUND(b.scale || 1)},${SIG_ROUND(b.grow ?? 1)}` : '-'));
  }
  return parts.join('|');
}

// ───────────────────────────── cache + public rasterize ─────────────────────────────

const cache = new Map(); // clipId → entry
let versionCounter = 0;
let useTick = 0;

/** Drop cached rasters (one clip or everything). */
export function clearTextCache(clipId) {
  if (clipId == null) { cache.clear(); layoutCache.clear(); return; }
  cache.delete(clipId);
}

function staticKeyOf(clip, extra) {
  const pick = {
    type: clip.type, start: clip.start, duration: clip.duration, text: clip.text, textAnim: clip.textAnim, caption: clip.caption,
    shape: clip.shape, sticker: clip.sticker,
  };
  return fontGeneration() + '|' + JSON.stringify(pick) + '|' + (extra || '');
}

function ensureEntryCanvas(entry, W, H) {
  if (!entry.canvas) entry.canvas = createCanvas(W, H);
  if (!entry.canvas) return null;
  if (entry.canvas.width !== W || entry.canvas.height !== H) { entry.canvas.width = W; entry.canvas.height = H; }
  return entry.canvas.getContext('2d');
}

function fitScale(halfW, halfH, scale) {
  let s = scale;
  const W = Math.ceil(halfW * 2 * s), H = Math.ceil(halfH * 2 * s);
  if (W > MAX_CANVAS || H > MAX_CANVAS) s = s * Math.min(MAX_CANVAS / W, MAX_CANVAS / H);
  return s;
}

function quantize(t, fps) {
  const f = Math.round(t * fps + 1e-6);
  return f / fps;
}

function finish(entry, clip, sig, scaleEff, W, H, box) {
  versionCounter++;
  entry.sig = sig;
  entry.version = versionCounter;
  entry.result = {
    canvas: entry.canvas, w: W / scaleEff, h: H / scaleEff, cx: 0, cy: 0,
    key: `${clip.id || ''}:${entry.version}`, version: entry.version, box, scale: scaleEff,
  };
  return entry.result;
}

/**
 * Rasterize a text / caption / shape / sticker clip at timeline time t.
 * @returns {{canvas, w, h, cx, cy, key, version, box, scale}|null}
 */
export function rasterize(clip, t, project, scale = 1) {
  if (!clip || !canvasSupported()) return null;
  const type = clip.type;
  if (type !== 'text' && type !== 'caption' && type !== 'shape' && type !== 'sticker') return null;
  try {
    registerBundledFonts();
    const fps = num(project && project.settings && project.settings.fps, 30) || 30;
    const dur = Math.max(1e-3, num(clip.duration, 3));
    const tq = quantize(num(t, 0), fps);
    const localT = Math.min(Math.max(0, tq - num(clip.start, 0)), Math.max(0, dur - 1e-4));
    scale = num(scale, 1) > 0 ? num(scale, 1) : 1;
    const id = clip.id || '__anon';
    let entry = cache.get(id);
    const skey = staticKeyOf(clip, '');
    if (!entry || entry.skey !== skey) {
      entry = { skey, canvas: entry ? entry.canvas : null, sig: null, geom: null, result: null, version: 0 };
      cache.set(id, entry);
      if (type === 'text' || type === 'caption') entry.geom = buildTextGeom(clip, project);
      else entry.geom = { kind: type };
      if (cache.size > 500) pruneCache();
    }
    entry.use = ++useTick;
    if ((useTick & 63) === 0) releaseIdle();
    if (type === 'text' || type === 'caption') return rasterizeText(entry, clip, localT, scale);
    if (type === 'shape') return rasterizeShape(entry, clip, localT, dur, scale);
    return rasterizeSticker(entry, clip, localT, scale);
  } catch (e) {
    try { console.warn('[text-render] rasterize failed', clip && clip.id, e); } catch { /* no console */ }
    return null;
  }
}

/**
 * Free the pixel memory of rasters that have not been requested for a while (a long video has dozens of caption
 * clips but only a few are on screen). Keeps up to KEEP_LIVE canvases; a released clip simply redraws on next use
 * (with a new key/version).
 */
const KEEP_LIVE = 24;
const IDLE_TICKS = 240;
function releaseIdle() {
  const live = [];
  for (const [id, e] of cache) if (e.canvas) live.push([id, e]);
  if (live.length <= KEEP_LIVE) return;
  live.sort((x, y) => (x[1].use || 0) - (y[1].use || 0));
  let excess = live.length - KEEP_LIVE;
  for (const [, e] of live) {
    if (excess <= 0) break;
    if ((e.use || 0) > useTick - IDLE_TICKS) break;
    try { e.canvas.width = 1; e.canvas.height = 1; } catch { /* detached */ }
    e.canvas = null; e.sig = null; e.result = null;
    excess--;
  }
}

function pruneCache() {
  const arr = [...cache.entries()].sort((a, b) => (a[1].use || 0) - (b[1].use || 0));
  for (let i = 0; i < arr.length - 350; i++) cache.delete(arr[i][0]);
}

function rasterizeText(entry, clip, localT, scale) {
  const G = entry.geom;
  if (!G) return null;
  const s = fitScale(G.halfW, G.halfH, scale);
  const W = Math.max(1, Math.ceil(G.halfW * 2 * s)), H = Math.max(1, Math.ceil(G.halfH * 2 * s));
  const F = frameStates(G, localT);
  const sig = `${W}x${H}@${s}|` + frameSignature(G, F);
  if (entry.sig === sig && entry.result && entry.canvas) return entry.result;
  const ctx = ensureEntryCanvas(entry, W, H);
  if (!ctx) return null;
  // the canvas may be a little larger than 2*half*s due to ceil; use exact device scale
  drawTextFrame(ctx, G, F, s, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  return finish(entry, clip, sig, s, W, H, G.box);
}

function rasterizeShape(entry, clip, localT, dur, scale) {
  const sh = { ...SHAPE_DEFAULTS, ...(clip.shape || {}) };
  const box = shapeBox(sh);
  const pad = shapePad(sh);
  const halfW = box.w / 2 + pad, halfH = box.h / 2 + pad;
  const s = fitScale(halfW, halfH, scale);
  const W = Math.max(1, Math.ceil(halfW * 2 * s)), H = Math.max(1, Math.ceil(halfH * 2 * s));
  const value = sh.kind === 'progress' ? progressValue(sh, localT, dur) : 1;
  const sig = `${W}x${H}@${s}|${JSON.stringify(sh)}|${sh.kind === 'progress' ? Math.round(value * 4000) : ''}`;
  if (entry.sig === sig && entry.result) return entry.result;
  const ctx = ensureEntryCanvas(entry, W, H);
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, (W - box.w * s) / 2, (H - box.h * s) / 2);
  drawShape(ctx, sh, value, s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  resetShadow(ctx);
  return finish(entry, clip, sig, s, W, H, { x: -box.w / 2, y: -box.h / 2, w: box.w, h: box.h });
}

function drawStickerWithEffects(ctx, st, t, s, W, H) {
  const box = stickerBox(st);
  const ox = (W - box.w * s) / 2, oy = (H - box.h * s) / 2;
  const outline = st.outline && num(st.outline.width, 0) > 0 && isVisibleColor(st.outline.color) ? st.outline : null;
  const shadow = st.shadow && isVisibleColor(st.shadow.color) ? st.shadow : null;
  if (!outline && !shadow) {
    ctx.setTransform(s, 0, 0, s, ox, oy);
    drawStickerContent(ctx, st, t, s);
    return;
  }
  const C2 = getScratch2(W, H);
  if (!C2) { ctx.setTransform(s, 0, 0, s, ox, oy); drawStickerContent(ctx, st, t, s); return; }
  C2.ctx.setTransform(s, 0, 0, s, ox, oy);
  drawStickerContent(C2.ctx, st, t, s);
  C2.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const content = C2.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (outline) {
    // tinted silhouette dilated in 16 directions
    const sil = getScratch(W, H);
    sil.ctx.drawImage(content, 0, 0, W, H, 0, 0, W, H);
    sil.ctx.globalCompositeOperation = 'source-in';
    sil.ctx.fillStyle = outline.color;
    sil.ctx.fillRect(0, 0, W, H);
    sil.ctx.globalCompositeOperation = 'source-over';
    const r = num(outline.width, 8) * s;
    if (shadow) {
      ctx.save();
      ctx.shadowColor = shadow.color; ctx.shadowBlur = num(shadow.blur, 0) * s;
      ctx.shadowOffsetX = num(shadow.x, 0) * s; ctx.shadowOffsetY = num(shadow.y, 0) * s;
      ctx.drawImage(sil.canvas, 0, 0, W, H, 0, 0, W, H);
      ctx.restore();
    }
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      ctx.drawImage(sil.canvas, 0, 0, W, H, Math.cos(a) * r, Math.sin(a) * r, W, H);
    }
  } else if (shadow) {
    ctx.save();
    ctx.shadowColor = shadow.color; ctx.shadowBlur = num(shadow.blur, 0) * s;
    ctx.shadowOffsetX = num(shadow.x, 0) * s; ctx.shadowOffsetY = num(shadow.y, 0) * s;
    ctx.drawImage(content, 0, 0, W, H, 0, 0, W, H);
    ctx.restore();
  }
  ctx.drawImage(content, 0, 0, W, H, 0, 0, W, H);
}

function rasterizeSticker(entry, clip, localT, scale) {
  const st = { kind: 'emoji', value: '🔥', size: 220, ...(clip.sticker || {}) };
  if (st.kind === 'builtin' && !getBuiltinSticker(st.value)) {
    const cat = getSticker(st.value);
    if (cat) { st.kind = cat.kind; st.value = cat.value; }
  }
  const box = stickerBox(st);
  const pad = stickerPad(st);
  const halfW = box.w / 2 + pad, halfH = box.h / 2 + pad;
  const s = fitScale(halfW, halfH, scale);
  const W = Math.max(1, Math.ceil(halfW * 2 * s)), H = Math.max(1, Math.ceil(halfH * 2 * s));
  const animated = stickerIsAnimated(st);
  const fps = 30;
  const tq = animated ? Math.round(localT * fps) / fps : 0;
  const sig = `${W}x${H}@${s}|${JSON.stringify(st)}|${animated ? tq.toFixed(4) : ''}|${fontGeneration()}`;
  if (entry.sig === sig && entry.result) return entry.result;
  const ctx = ensureEntryCanvas(entry, W, H);
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawStickerWithEffects(ctx, st, animated ? tq : 1.5, s, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  return finish(entry, clip, sig, s, W, H, { x: -box.w / 2, y: -box.h / 2, w: box.w, h: box.h });
}

// ───────────────────────────── fonts ─────────────────────────────

/**
 * Register the bundled @font-face rules and wait until every family/weight used by the project is loaded
 * (document.fonts.load with a Hebrew sample). project may be null → loads the bundled families' common weights.
 * Resolves to { loaded:[…], failed:[…] }. Never rejects.
 */
export async function ensureFonts(project) {
  try {
    if (!registerBundledFonts()) return { loaded: [], failed: [] };
    const specs = [];
    const addSpec = (family, weight, italic, sample) => specs.push({ family: family || 'Heebo', weight: weight || 400, italic: !!italic, sample });
    let unknown = false;
    const clips = project && project.clips ? Object.values(project.clips) : [];
    for (const c of clips) {
      if (!c) continue;
      if (c.type === 'text' || c.type === 'caption') {
        const txt = resolveTextStyle(c);
        addSpec(txt.font, txt.weight, txt.italic);
        if (c.type === 'caption' && getCaptionStyle(c.caption && c.caption.style).id === 'kinetic') addSpec(txt.font, 900, txt.italic);
        if (!findFont(txt.font)) unknown = true;
      } else if (c.type === 'sticker') {
        if (!c.sticker || c.sticker.kind !== 'builtin') addSpec('Segoe UI Emoji', 400, false, '🔥😂');
        else { addSpec('Heebo', 900, false); addSpec('Assistant', 800, false); }
      } else if (c.type === 'shape' && c.shape && c.shape.showValue) addSpec('Heebo', 900, false);
    }
    if (!project) {
      for (const w of [400, 500, 600, 700, 800, 900]) addSpec('Heebo', w, false);
      for (const w of [300, 400, 600, 700, 800]) addSpec('Assistant', w, false);
      addSpec('Segoe UI Emoji', 400, false, '🔥😂');
    } else {
      addSpec('Heebo', 900, false); // used by built-in stickers and fallbacks
    }
    if (unknown) { try { await discoverLibraryFonts(); } catch { /* ignore */ } }
    const res = await loadFontVariants(specs);
    layoutCache.clear();
    return res;
  } catch (e) {
    return { loaded: [], failed: [String(e && e.message || e)] };
  }
}

// ───────────────────────────── info helpers ─────────────────────────────

/** Static content size of a text/caption/shape/sticker clip in canvas px ({w,h} of the layout box, no padding). */
export function measureClip(clip, project) {
  if (!clip || !canvasSupported()) return null;
  try {
    if (clip.type === 'shape') { const b = shapeBox({ ...SHAPE_DEFAULTS, ...(clip.shape || {}) }); return { w: b.w, h: b.h }; }
    if (clip.type === 'sticker') { const b = stickerBox({ kind: 'emoji', value: '🔥', size: 220, ...(clip.sticker || {}) }); return { w: b.w, h: b.h }; }
    if (clip.type !== 'text' && clip.type !== 'caption') return null;
    const G = buildTextGeom(clip, project);
    return G ? { w: G.frameW, h: G.frameH, box: G.box, lines: G.layouts[0] ? G.layouts[0].lines.length : 0 } : null;
  } catch { return null; }
}

// ───────────────────────────── thumbnails ─────────────────────────────

const SAMPLE_CAPTION = [
  { w: 'זה', s: 0.0, e: 0.25 }, { w: 'הסרטון', s: 0.25, e: 0.5 }, { w: 'הראשון', s: 0.5, e: 0.8, hot: true }, { w: 'שלי!', s: 0.8, e: 1.2 },
];

function fitDraw(canvas, r, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!r || !r.canvas) return;
  const cw = canvas.width, ch = canvas.height;
  const margin = num(opts.margin, 0.08);
  const box = r.box && opts.fitBox !== false ? r.box : { x: -r.w / 2, y: -r.h / 2, w: r.w, h: r.h };
  const bw = Math.max(1, Math.max(box.w, 1)), bh = Math.max(1, box.h);
  const k = Math.min((cw * (1 - margin * 2)) / bw, (ch * (1 - margin * 2)) / bh) / r.scale;
  const dw = r.canvas.width * k, dh = r.canvas.height * k;
  const centerX = cw / 2 - (box.x + box.w / 2) * r.scale * k;
  const centerY = ch / 2 - (box.y + box.h / 2) * r.scale * k;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.canvas, centerX - dw / 2, centerY - dh / 2, dw, dh);
}

/**
 * Draw a library-grid preview.
 * @param {'textPreset'|'text'|'captionStyle'|'caption'|'textAnim'|'shape'|'sticker'|'font'} kind
 * @param {object|string} item  catalog entry (or id)
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas  target (its current size is used)
 * @param {object} [opts] { background:'#hex', t:seconds (animated preview frame), phase:'in'|'out'|'loop' (textAnim), text, margin }
 * @returns the canvas
 */
export function drawThumbnail(kind, item, canvas, opts = {}) {
  if (!canvas || !canvas.getContext) return canvas;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  try {
    const project = { settings: { fps: 30, width: 1080, height: 1920 } };
    const res = Math.max(0.25, Math.min(1, (canvas.width * 2.2) / 1080));
    let r = null;
    const tid = `__thumb_${kind}_${typeof item === 'string' ? item : (item && item.id) || ''}`;
    if (kind === 'textPreset' || kind === 'text') {
      const p = typeof item === 'string' ? getTextPreset(item) : item;
      if (!p) return canvas;
      const ta = { ...TEXT_ANIM_DEFAULTS, ...(p.textAnim || {}) };
      if (opts.t == null) ta.loop = 'none'; // static thumbnail shows the resting style (loops only in animated previews)
      const dur = 3;
      const text = deepMerge(TEXT_DEFAULTS, p.text || {});
      text.content = opts.text ?? p.sample ?? p.name;
      text.maxWidth = Math.max(num(text.maxWidth, 900), 900);
      const t = opts.t != null ? opts.t % dur : (text.counter ? dur - 0.01 : Math.min(dur * 0.5, num(ta.inDuration, 0.4) + 0.6));
      const clip = { id: tid, type: 'text', start: 0, duration: dur, text, textAnim: ta };
      r = rasterize(clip, t, project, res);
    } else if (kind === 'captionStyle' || kind === 'caption') {
      const st = typeof item === 'string' ? getCaptionStyle(item) : item;
      if (!st) return canvas;
      const clip = { id: tid, type: 'caption', start: 0, duration: 1.6, text: deepMerge(TEXT_DEFAULTS, {}), textAnim: { ...TEXT_ANIM_DEFAULTS },
        caption: { words: SAMPLE_CAPTION, style: st.id, activeColor: CAPTION_MODEL_DEFAULTS.activeColor, hotColor: CAPTION_MODEL_DEFAULTS.hotColor } };
      clip.text.content = '';
      const t = opts.t != null ? opts.t % 1.6 : 0.68;
      r = rasterize(clip, t, project, res);
    } else if (kind === 'textAnim') {
      const a = typeof item === 'string' ? { id: item } : item;
      const phase = opts.phase || a.phase || (TEXT_ANIMS.in.some((x) => x.id === a.id) ? 'in' : TEXT_ANIMS.out.some((x) => x.id === a.id) ? 'out' : 'loop');
      const dur = 2;
      const ta = { ...TEXT_ANIM_DEFAULTS, inDuration: 0.8, outDuration: 0.8, perWord: false };
      ta[phase] = a.id;
      const text = deepMerge(TEXT_DEFAULTS, { weight: 900, size: 110, stroke: { color: '#000000', width: 10 }, content: opts.text ?? 'אנימציה כאן' });
      const t = opts.t != null ? opts.t % dur : (phase === 'in' ? 0.45 : phase === 'out' ? dur - 0.45 : 0.6);
      r = rasterize({ id: tid + phase, type: 'text', start: 0, duration: dur, text, textAnim: ta }, t, project, res);
    } else if (kind === 'shape') {
      const s = typeof item === 'string' ? getShape(item) : item;
      if (!s) return canvas;
      const shape = { ...SHAPE_DEFAULTS, ...(s.shape || s) };
      r = rasterize({ id: tid, type: 'shape', start: 0, duration: 2, shape }, opts.t != null ? opts.t % 2 : 1.3, project, res);
    } else if (kind === 'sticker') {
      const s = typeof item === 'string' ? getSticker(item) : item;
      if (!s) return canvas;
      const sticker = { kind: s.kind || 'emoji', value: s.value, size: 220, ...(s.sticker || {}) };
      const b = sticker.kind === 'builtin' ? getBuiltinSticker(sticker.value) : null;
      const restT = b && b.thumbT != null ? b.thumbT : 1.5;
      r = rasterize({ id: tid, type: 'sticker', start: 0, duration: 3, sticker }, opts.t != null ? opts.t % 3 : restT, project, Math.max(0.3, Math.min(1, (canvas.height * 1.5) / 220)));
    } else if (kind === 'font') {
      const f = typeof item === 'string' ? (findFont(item) || { family: item }) : item;
      const text = deepMerge(TEXT_DEFAULTS, { font: f.family, weight: f.weights && f.weights.includes(700) ? 700 : (f.weights ? f.weights[f.weights.length - 1] : 400), size: 90, shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 }, content: opts.text ?? (f.hebrew === false ? 'Abc 123' : 'אבג Abc') });
      r = rasterize({ id: tid, type: 'text', start: 0, duration: 1, text, textAnim: { ...TEXT_ANIM_DEFAULTS } }, 0.5, project, res);
    }
    if (r) fitDraw(canvas, r, opts);
    // static thumbnails are copied out → drop their rasters; animated previews (opts.t) keep theirs for the next frame
    if (opts.t == null) for (const id of [...cache.keys()]) if (id.startsWith('__thumb_')) { const e = cache.get(id); if (e && e.canvas) { try { e.canvas.width = 1; e.canvas.height = 1; } catch { /* */ } } cache.delete(id); }
  } catch (e) {
    try { console.warn('[text-render] drawThumbnail failed', kind, e); } catch { /* ignore */ }
  }
  return canvas;
}

/** Catalog bundle (plain data) — handy for shared/catalog.js and the CLI. */
export function textCatalog() {
  return {
    fonts: listFonts().map((f) => ({ family: f.family, name: f.name, weights: f.weights, system: !!f.system, hebrew: f.hebrew !== false, license: f.license, src: f.src })),
    textAnims: TEXT_ANIMS,
    captionStyles: CAPTION_STYLES.map((s) => ({ id: s.id, name: s.name, description: s.description, defaults: s.defaults })),
    textPresets: TEXT_PRESETS,
    shapes: SHAPES,
    stickers: STICKERS,
  };
}
