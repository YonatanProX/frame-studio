// Frame Studio — app/ui-catalog.js (owner: U)
// Loads shared/catalog.js getCatalog() (agent M) + server lists (fonts, LUTs) and normalizes them
// into one predictable shape. Every section may be empty — consumers must handle [] gracefully.
import { api } from './api.js';

const norm = (k) => String(k).toLowerCase().replace(/[-_\s]/g, '');
const WANT = {
  transitions: ['transitions'],
  effects: ['effects'],
  filters: ['filters'],
  clipAnims: ['clipanims', 'anims', 'animations', 'clipanimations'],
  textAnims: ['textanims', 'textanimations'],
  captionStyles: ['captionstyles', 'captions', 'captionstyle'],
  textPresets: ['textpresets', 'presets', 'textstyles'],
  shapes: ['shapes'],
  stickers: ['stickers'],
  fonts: ['fonts'],
  easings: ['easings', 'eases'],
  luts: ['luts'],
};

/** first non-empty value whose normalized key matches (getCatalog() data wins over module live bindings) */
function pick(raw, names) {
  if (!raw || typeof raw !== 'object') return undefined;
  let fallback;
  for (const [k, v] of Object.entries(raw)) {
    if (!names.includes(norm(k)) || v == null) continue;
    const empty = Array.isArray(v) ? v.length === 0 : (typeof v === 'object' ? Object.values(v).every((x) => Array.isArray(x) && x.length === 0) : false);
    if (!empty) return v;
    if (fallback === undefined) fallback = v;
  }
  return fallback;
}
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && x.id != null) : []);
function animGroups(v) {
  const out = { in: [], out: [], loop: [] };
  if (!v || typeof v !== 'object') return out;
  for (const g of ['in', 'out', 'loop']) {
    const list = v[g];
    if (Array.isArray(list)) out[g] = list.map((x) => (typeof x === 'string' ? { id: x, name: x } : x)).filter((x) => x && x.id != null);
  }
  return out;
}

let cached = null;
let pending = null;

export function getCatalogSync() { return cached || EMPTY(); }

const EMPTY = () => ({
  transitions: [], effects: [], filters: [], clipAnims: { in: [], out: [], loop: [] }, textAnims: { in: [], out: [], loop: [] },
  captionStyles: [], textPresets: [], shapes: [], stickers: [], fonts: [], easings: [], luts: [], loaded: false,
});

export function loadCatalog() {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = (async () => {
    const out = EMPTY();
    let raw = {};
    try {
      const mod = await import('../shared/catalog.js');
      let c = null;
      if (typeof mod.getCatalog === 'function') c = await mod.getCatalog();
      // getCatalog() data first; module exports (read AFTER loading, live bindings) only as fallback
      raw = { ...(c && typeof c === 'object' ? c : {}) };
      for (const [k, v] of Object.entries(mod)) if (typeof v !== 'function' && !(k in raw)) raw[k] = v;
      if (Array.isArray(c?.errors) && c.errors.length) console.warn('[catalog]', c.errors.join(' | '));
    } catch (e) {
      console.warn('[catalog] shared/catalog.js לא נטען', e);
    }
    out.transitions = arr(pick(raw, WANT.transitions));
    out.effects = arr(pick(raw, WANT.effects));
    out.filters = arr(pick(raw, WANT.filters));
    out.clipAnims = animGroups(pick(raw, WANT.clipAnims));
    out.textAnims = animGroups(pick(raw, WANT.textAnims));
    out.captionStyles = arr(pick(raw, WANT.captionStyles));
    out.textPresets = arr(pick(raw, WANT.textPresets));
    const shapes = pick(raw, WANT.shapes);
    out.shapes = Array.isArray(shapes) ? shapes.map((s) => (typeof s === 'string' ? { id: s, name: s, kind: s } : s)).filter(Boolean) : [];
    out.stickers = arr(pick(raw, WANT.stickers));
    const fonts = pick(raw, WANT.fonts);
    out.fonts = Array.isArray(fonts) ? fonts.map((f) => (typeof f === 'string' ? { family: f, weights: [400, 700] } : f)).filter((f) => f && f.family) : [];
    const eas = pick(raw, WANT.easings);
    out.easings = Array.isArray(eas) ? eas.map((e) => (typeof e === 'string' ? e : e.id)).filter(Boolean) : (eas && typeof eas === 'object' ? Object.keys(eas) : []);
    const luts = pick(raw, WANT.luts);
    if (Array.isArray(luts)) out.luts = luts.map(normLut).filter(Boolean);

    // server lists (fonts incl. system Hebrew fonts, LUT files)
    const [sf, sl] = await Promise.allSettled([api.get('/api/library/fonts'), api.get('/api/library/luts')]);
    if (sf.status === 'fulfilled' && Array.isArray(sf.value)) {
      const byFam = new Map(out.fonts.map((f) => [f.family, f]));
      for (const f of sf.value) {
        if (!f || !f.family) continue;
        const prev = byFam.get(f.family);
        if (prev) byFam.set(f.family, { ...f, ...prev, weights: [...new Set([...(prev.weights || []), ...(f.weights || [])])].sort((a, b) => a - b) });
        else byFam.set(f.family, f);
      }
      out.fonts = [...byFam.values()];
    }
    const lutList = sl.status === 'fulfilled' ? (Array.isArray(sl.value) ? sl.value : (sl.value?.luts || [])) : [];
    if (lutList.length) {
      const seen = new Set(out.luts.map((l) => l.file));
      for (const l of lutList.map(normLut).filter(Boolean)) if (!seen.has(l.file)) { out.luts.push(l); seen.add(l.file); }
    }
    if (!out.fonts.length) out.fonts = [{ family: 'Heebo', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] }, { family: 'Assistant', weights: [200, 300, 400, 500, 600, 700, 800] }, { family: 'Arial', weights: [400, 700] }];
    out.loaded = true;
    cached = out;
    return out;
  })();
  return pending;
}

function normLut(l) {
  if (!l) return null;
  if (typeof l === 'string') return { file: l, name: LUT_NAMES[l.replace(/\.cube$/i, '')] || l.replace(/\.cube$/i, '') };
  const file = l.file || l.name || l.id;
  if (!file) return null;
  return { file, name: l.label || l.title || LUT_NAMES[String(file).replace(/\.cube$/i, '')] || l.name || file };
}
const LUT_NAMES = {
  'teal-orange': 'טורקיז־כתום', 'warm-film': 'פילם חם', 'cool-night': 'לילה קריר', 'bleach-bypass': 'בליץ׳ ביפאס',
  'vintage-fade': 'וינטג׳ דהוי', 'mono-contrast': 'שחור־לבן חד', 'golden-hour': 'שעת זהב', 'chordix-cyan': 'כורדיקס ציאן',
};

export function groupBy(list, key = 'category', fallback = 'כללי') {
  const m = new Map();
  for (const it of list) { const k = it[key] || fallback; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return m;
}
