// shared/catalog.js — one place to get every catalog (transitions, effects, filters, animations, text, captions,
// shapes, stickers, fonts). The render/* modules are written independently, so they are loaded with dynamic
// import() inside try/catch: a missing or broken render module never breaks this module (or the ops engine).
//
// Usage:
//   import { getCatalog, TRANSITIONS } from '../shared/catalog.js';
//   const cat = await getCatalog();   // also fills the live-binding exports below (TRANSITIONS, EFFECTS, …)
//   getCatalogSync()                  // last loaded catalog (or a partial one with clipAnims only)

import { CLIP_ANIMS } from './anim.js';

export { CLIP_ANIMS };

// Live bindings — filled by loadCatalog()/getCatalog().
export let TRANSITIONS = [];
export let EFFECTS = [];
export let FILTERS = [];
export let FONTS = [];
export let TEXT_PRESETS = [];
export let TEXT_ANIMS = { in: [], out: [], loop: [] };
export let CAPTION_STYLES = [];
export let SHAPES = [];
export let STICKERS = [];

const SOURCES = {
  transitions: '../render/transitions-gl.js',
  effects: '../render/effects-gl.js',
  text: '../render/text-render.js',
};

// Keys never exposed in the JSON catalog (shader code, functions, renderer internals).
const STRIP_KEYS = new Set(['glsl', 'frag', 'fragment', 'vert', 'vertex', 'shader', 'source', 'program', 'uniforms', 'compiled']);

let cached = null;
let loading = null;
let lastErrors = [];

function sanitize(v, depth = 0) {
  if (typeof v === 'function') return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (depth > 8) return undefined;
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof HTMLElement !== 'undefined' && v instanceof HTMLElement) return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (STRIP_KEYS.has(k)) continue;
    const s = sanitize(val, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function asArray(v) { return Array.isArray(v) ? v : []; }
function asAnimGroups(v) {
  const g = v && typeof v === 'object' ? v : {};
  return { in: asArray(g.in), out: asArray(g.out), loop: asArray(g.loop) };
}

async function tryImport(rel, errors) {
  try {
    return await import(new URL(rel, import.meta.url).href);
  } catch (e) {
    errors.push(`טעינת ${rel} נכשלה: ${e && e.message ? e.message : e}`);
    return null;
  }
}

function build(loaded) {
  return {
    loaded,
    transitions: sanitize(TRANSITIONS),
    effects: sanitize(EFFECTS),
    filters: sanitize(FILTERS),
    clipAnims: sanitize(CLIP_ANIMS),
    textAnims: sanitize(TEXT_ANIMS),
    captionStyles: sanitize(CAPTION_STYLES),
    textPresets: sanitize(TEXT_PRESETS),
    shapes: sanitize(SHAPES),
    stickers: sanitize(STICKERS),
    fonts: sanitize(FONTS),
    errors: lastErrors.slice(),
  };
}

/** Load all render-side catalogs (once; pass {reload:true} to force). Never throws. */
export async function loadCatalog({ reload = false } = {}) {
  if (cached && !reload) return cached;
  if (loading && !reload) return loading;
  loading = (async () => {
    const errors = [];
    const [tr, fx, tx] = await Promise.all([
      tryImport(SOURCES.transitions, errors),
      tryImport(SOURCES.effects, errors),
      tryImport(SOURCES.text, errors),
    ]);
    try {
      if (tr) TRANSITIONS = asArray(tr.TRANSITIONS);
      if (fx) { EFFECTS = asArray(fx.EFFECTS); FILTERS = asArray(fx.FILTERS); }
      if (tx) {
        FONTS = asArray(tx.FONTS);
        TEXT_PRESETS = asArray(tx.TEXT_PRESETS);
        TEXT_ANIMS = asAnimGroups(tx.TEXT_ANIMS);
        CAPTION_STYLES = asArray(tx.CAPTION_STYLES);
        SHAPES = asArray(tx.SHAPES);
        STICKERS = asArray(tx.STICKERS);
      }
    } catch (e) {
      errors.push(`קריאת הקטלוגים נכשלה: ${e && e.message ? e.message : e}`);
    }
    lastErrors = errors;
    try {
      cached = build(!!(tr || fx || tx));
    } catch (e) {
      lastErrors.push(`בניית הקטלוג נכשלה: ${e && e.message ? e.message : e}`);
      cached = { loaded: false, transitions: [], effects: [], filters: [], clipAnims: CLIP_ANIMS, textAnims: { in: [], out: [], loop: [] },
        captionStyles: [], textPresets: [], shapes: [], stickers: [], fonts: [], errors: lastErrors.slice() };
    }
    loading = null;
    return cached;
  })();
  return loading;
}

/**
 * getCatalog() → { transitions, effects, filters, clipAnims, textAnims, captionStyles, textPresets, shapes, stickers, fonts,
 *                  loaded, errors }
 * JSON-safe (glsl / functions stripped). Data fields such as captionStyles[].defaults and textPresets[].text are kept.
 */
export async function getCatalog(opts) {
  try {
    return await loadCatalog(opts);
  } catch (e) {
    return { loaded: false, transitions: [], effects: [], filters: [], clipAnims: CLIP_ANIMS, textAnims: { in: [], out: [], loop: [] },
      captionStyles: [], textPresets: [], shapes: [], stickers: [], fonts: [], errors: [String(e && e.message ? e.message : e)] };
  }
}

/** The last loaded catalog, or a partial one (only clipAnims, loaded:false) when getCatalog() was never awaited. */
export function getCatalogSync() {
  if (cached) return cached;
  return { loaded: false, transitions: [], effects: [], filters: [], clipAnims: CLIP_ANIMS, textAnims: { in: [], out: [], loop: [] },
    captionStyles: [], textPresets: [], shapes: [], stickers: [], fonts: [], errors: [] };
}

/** Find one item: kind = transitions|effects|filters|captionStyles|textPresets|shapes|stickers|fonts. */
export function findCatalogItem(kind, id, cat = getCatalogSync()) {
  const list = cat?.[kind];
  if (!Array.isArray(list)) return null;
  return list.find((x) => x && (x.id === id || x.family === id)) || null;
}

/** Default params object {key: default} from a catalog item's params array. */
export function defaultParams(item) {
  const out = {};
  for (const p of asArray(item?.params)) if (p && p.key !== undefined && p.default !== undefined) out[p.key] = p.default;
  return out;
}
