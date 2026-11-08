// tools/tests/R-test.js — agent R headless render self-test (runs in Chrome via R-run.mjs).
import { Compositor } from '/render/compositor.js';
import { SourceProvider } from '/render/sources.js';
import { TRANSITIONS } from '/render/transitions-gl.js';
import { EFFECTS, FILTERS } from '/render/effects-gl.js';

const results = { summary: { ok: false }, compile: null, transitions: [], effects: [], filters: [], color: [], misc: [], checks: [], seek: null, preview: null, perf: null, errors: [] };
const statusEl = document.getElementById('status');
const say = (s) => { statusEl.textContent = s; document.title = 'R-test: ' + s; post('/__log', s); };

function post(url, body) { return fetch(url, { method: 'POST', body }).catch(() => {}); }
for (const k of ['warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { orig(...a); post('/__log', `[${k}] ` + a.map((x) => (x && x.stack) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')); };
}
window.addEventListener('error', (e) => { results.errors.push(String(e.message)); post('/__log', '[uncaught] ' + e.message); });
window.addEventListener('unhandledrejection', (e) => { results.errors.push(String(e.reason && e.reason.stack || e.reason)); post('/__log', '[unhandled] ' + (e.reason && e.reason.stack || e.reason)); });

const W = 360, H = 640, FPS = 30;
const MEDIA = {
  m_pat: { id: 'm_pat', kind: 'video', name: 'pattern', duration: 4, width: 360, height: 640, fps: 30, hasVideo: true, hasAudio: false, status: 'ready', proxy: 'cache/proxy/m_pat.mp4' },
  m_pat2: { id: 'm_pat2', kind: 'video', name: 'land', duration: 3, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false, status: 'ready', proxy: 'cache/proxy/m_pat2.mp4' },
  m_cnt: { id: 'm_cnt', kind: 'video', name: 'counter', duration: 3, width: 64, height: 64, fps: 30, hasVideo: true, hasAudio: false, status: 'ready', proxy: 'cache/proxy/m_cnt.mp4' },
  m_photo: { id: 'm_photo', kind: 'image', name: 'photo', duration: 0, width: 720, height: 1280, status: 'ready' },
  m_card: { id: 'm_card', kind: 'image', name: 'card', duration: 0, width: 360, height: 640, status: 'ready' },
  m_alpha: { id: 'm_alpha', kind: 'image', name: 'alpha', duration: 0, width: 400, height: 400, status: 'ready' },
  m_green: { id: 'm_green', kind: 'image', name: 'green', duration: 0, width: 360, height: 640, status: 'ready' },
};
const TRACKS = [
  { id: 'tText', kind: 'video', role: 'text' }, { id: 'tFx', kind: 'video', role: 'effects' },
  { id: 'tOver', kind: 'video', role: 'overlay' }, { id: 'tMain', kind: 'video', role: 'main' },
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const o = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b || {})) o[k] = isObj(a && a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k];
  return o;
}
let ids = 0;
function clip(type, props = {}) {
  const base = {
    id: 'c' + (++ids), trackId: 'tMain', type, name: '', start: 0, duration: 3, disabled: false, in: 0, speed: 1, reverse: false,
    transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5, flipX: false, flipY: false },
    fit: 'cover', crop: { l: 0, t: 0, r: 0, b: 0 }, blend: 'normal', keyframes: {},
    animIn: { id: 'none', duration: 0.4 }, animOut: { id: 'none', duration: 0.4 }, animLoop: { id: 'none', speed: 1, intensity: 1 },
    color: { exposure: 0, brightness: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, hue: 0, vignette: 0, sharpen: 0, grain: 0, fade: 0 },
    filter: { id: 'none', amount: 1 }, lut: { file: null, amount: 1 }, effects: [],
    mask: { type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rotation: 0, feather: 0.05, invert: false },
    chroma: { enabled: false, color: '#00ff00', similarity: 0.35, smoothness: 0.08, spill: 0.5 },
    transitionOut: { id: 'none', duration: 0.5, params: {} },
  };
  return merge(base, props);
}
function proj(clips, opts = {}) {
  return {
    version: 1, id: 'rtest', name: 'בדיקה', rev: ++ids,
    settings: { width: opts.w || W, height: opts.h || H, fps: FPS, background: opts.bg || '#000000', sampleRate: 48000 },
    media: MEDIA,
    tracks: (opts.tracks || TRACKS).map((t) => ({ name: t.id, hidden: false, muted: false, locked: false, solo: false, volume: 1, ...t })),
    clips: Object.fromEntries(clips.map((c) => [c.id, c])), markers: [], transcript: { words: [] }, meta: {},
  };
}

/* ---------------- render helpers ---------------- */
const canvas = document.createElement('canvas');
const comp = new Compositor(canvas, { mode: 'export', scale: 1 });
const sp = new SourceProvider({ mode: 'export', projectId: 'rtest', apiBase: '' });

async function frame(p, t, c = comp, s = sp) {
  c.setProject(p); s.setProject(p);
  const ok = await c.renderFrame(t, s);
  if (!ok) throw new Error('renderFrame returned false: ' + (c.stats.lastError || ''));
  return c.readPixels();
}
function stats(px) {
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) { const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; sum += l; sum2 += l * l; n++; }
  const mean = sum / n;
  return { mean: +mean.toFixed(1), std: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1) };
}
function diff(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 8) { s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
  return +(s / n).toFixed(2);
}
const pixelAt = (px, x, y, w = W) => { const i = (Math.round(y) * w + Math.round(x)) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };

class Sheet {
  constructor(name, cols, tw = 120, th = 213) {
    this.name = name; this.cols = cols; this.tw = tw; this.th = th; this.tiles = [];
  }
  add(px, label, bad = false, w = W, h = H) { this.tiles.push({ px: new Uint8ClampedArray(px), label, bad, w, h }); }
  async save() {
    const rows = Math.ceil(this.tiles.length / this.cols);
    const lh = 16;
    const cv = document.createElement('canvas');
    cv.width = this.cols * (this.tw + 4) + 4; cv.height = rows * (this.th + lh + 4) + 4;
    const g = cv.getContext('2d');
    g.fillStyle = '#222'; g.fillRect(0, 0, cv.width, cv.height);
    const tmp = document.createElement('canvas');
    this.tiles.forEach((t, i) => {
      tmp.width = t.w; tmp.height = t.h;
      tmp.getContext('2d').putImageData(new ImageData(t.px, t.w, t.h), 0, 0);
      const x = 4 + (i % this.cols) * (this.tw + 4), y = 4 + Math.floor(i / this.cols) * (this.th + lh + 4);
      const k = Math.min(this.tw / t.w, this.th / t.h);
      const dw = t.w * k, dh = t.h * k;
      g.drawImage(tmp, x + (this.tw - dw) / 2, y + (this.th - dh) / 2, dw, dh);
      if (t.bad) { g.strokeStyle = '#ff3030'; g.lineWidth = 3; g.strokeRect(x, y, this.tw, this.th); }
      g.fillStyle = t.bad ? '#ff6060' : '#e0e0e0';
      g.font = '11px Arial';
      g.fillText(t.label.slice(0, 22), x + 2, y + this.th + 12);
    });
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    await fetch('/__save?name=' + encodeURIComponent(this.name + '.png'), { method: 'POST', body: blob });
  }
}

/* ---------------- tests ---------------- */
const check = (name, ok, info = {}) => { results.checks.push({ name, ok: !!ok, ...info }); if (!ok) post('/__log', `[warn] CHECK FAILED ${name} ${JSON.stringify(info)}`); };

async function testCompile() {
  say('compiling shaders');
  const t0 = performance.now();
  const r = comp.compileAll();
  results.compile = { total: r.total, failures: r.failures, ms: Math.round(performance.now() - t0) };
  check('all shaders compile', r.failures.length === 0, { failures: r.failures.map((f) => f.id) });
}

async function testTransitions() {
  const sheet = new Sheet('R-transitions', 12);
  const A = (tr) => clip('video', { id: 'A', mediaId: 'm_pat', start: 0, duration: 2, transitionOut: { id: tr, duration: 1, params: {} } });
  const B = clip('image', { id: 'B', mediaId: 'm_card', start: 2, duration: 2 });
  const refB = await frame(proj([A('none'), B]), 3.0);
  const refA = await frame(proj([clip('video', { id: 'A', mediaId: 'm_pat', start: 0, duration: 3 })]), 2.0);
  let i = 0;
  for (const T of TRANSITIONS) {
    say(`transition ${++i}/${TRANSITIONS.length} ${T.id}`);
    const p = proj([A(T.id), B]);
    const q = await frame(p, 1.75);
    const h = await frame(p, 2.0);
    const s = stats(h);
    const dA = diff(h, refA), dB = diff(h, refB);
    const dips = /^dip/.test(T.id);
    const bad = (!dips && s.mean < 3) || dB < 0.4 || dA < 0.4;
    results.transitions.push({ id: T.id, ...s, diffA: dA, diffB: dB, quarter: stats(q), bad });
    sheet.add(q, T.id + ' .25', bad);
    sheet.add(h, T.id + ' .5', bad);
  }
  await sheet.save();
  const bad = results.transitions.filter((t) => t.bad).map((t) => t.id);
  check('transitions visible at p=0.5', bad.length === 0, { bad, count: TRANSITIONS.length });
}

const EFFECT_T = { strobe: 0.05, shine: 0.5, letterbox: 0.8, tvOff: 2.7, flicker: 0.2 };
async function testEffects() {
  const sheet = new Sheet('R-effects', 10);
  const main = (fx) => clip('image', { id: 'M', mediaId: 'm_photo', start: 0, duration: 3, effects: fx ? [{ id: fx, params: {}, enabled: true }] : [] });
  const over = (fx) => clip('image', { id: 'O', trackId: 'tOver', mediaId: 'm_alpha', start: 0, duration: 3, fit: 'none', transform: { scale: 0.55 }, effects: fx ? [{ id: fx, params: {}, enabled: true }] : [] });
  const refs = new Map();
  let i = 0;
  for (const E of EFFECTS) {
    say(`effect ${++i}/${EFFECTS.length} ${E.id}`);
    const t = EFFECT_T[E.id] != null ? EFFECT_T[E.id] : 0.2;
    const onLayer = E.appliesTo === 'clip';
    const p = onLayer ? proj([main(null), over(E.id)]) : proj([main(E.id)]);
    const refKey = (onLayer ? 'L' : 'M') + t;
    if (!refs.has(refKey)) refs.set(refKey, await frame(onLayer ? proj([main(null), over(null)]) : proj([main(null)]), t));
    const px = await frame(p, t);
    const s = stats(px);
    const d = diff(px, refs.get(refKey));
    const bad = s.mean < 2 || d < 0.3;
    results.effects.push({ id: E.id, t, ...s, diff: d, bad });
    sheet.add(px, E.id, bad);
  }
  // effects on the video (comp-edge sampling) and as an effect clip over the composite
  for (const fx of ['blur', 'shake', 'kaleidoscope', 'glow', 'crt']) {
    const p = proj([clip('video', { id: 'V', mediaId: 'm_pat', start: 0, duration: 3, effects: [{ id: fx, params: {}, enabled: true }] })]);
    const px = await frame(p, 0.5);
    sheet.add(px, 'video+' + fx, stats(px).mean < 2);
  }
  await sheet.save();
  const bad = results.effects.filter((e) => e.bad).map((e) => e.id);
  check('effects change the image', bad.length === 0, { bad, count: EFFECTS.length });
}

async function testColor() {
  const sheet = new Sheet('R-filters-color', 10);
  const base = (props) => proj([clip('image', { id: 'M', mediaId: 'm_photo', start: 0, duration: 3, ...props })]);
  const ref = await frame(base({}), 0.2);
  sheet.add(ref, 'reference');
  for (const F of FILTERS) {
    say('filter ' + F.id);
    const px = await frame(base({ filter: { id: F.id, amount: 1 } }), 0.2);
    const d = diff(px, ref);
    const bad = d < 0.5;
    results.filters.push({ id: F.id, diff: d, ...stats(px), bad });
    sheet.add(px, 'filter ' + F.id, bad);
  }
  const half = await frame(base({ filter: { id: 'noir', amount: 0.5 } }), 0.2);
  sheet.add(half, 'noir 50%');
  const keys = ['exposure', 'brightness', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows', 'hue', 'vignette', 'sharpen', 'grain', 'fade'];
  for (const k of keys) {
    for (const v of [0.7, -0.7]) {
      const val = k === 'hue' ? v * 120 : v;
      const px = await frame(base({ color: { [k]: val } }), 0.2);
      const d = diff(px, ref);
      const bad = d < 0.4;
      results.color.push({ key: k, v: val, diff: d, bad });
      sheet.add(px, `${k} ${val > 0 ? '+' : ''}${val}`, bad);
    }
  }
  const lut = await frame(base({ lut: { file: 'R-test-rotate.cube', amount: 1 } }), 0.2);
  const dl = diff(lut, ref);
  sheet.add(lut, 'LUT rotate', dl < 2);
  const lw = pixelAt(lut, 110, 100), lk = pixelAt(lut, 290, 520), lc = pixelAt(lut, 190, 300);
  // cube maps (r,g,b) → (0.9g+0.1, b, r): white→white, black→(26,0,0), cyan(63,224,245)→(227,245,63)
  const lutOk = lw[0] > 235 && lw[1] > 235 && lk[0] > 15 && lk[0] < 40 && lk[1] < 12 && Math.abs(lc[0] - 227) < 14 && Math.abs(lc[1] - 245) < 14 && Math.abs(lc[2] - 63) < 18;
  check('LUT .cube applied', dl > 2 && lutOk, { diff: dl, white: lw, black: lk, cyan: lc });
  const lut50 = await frame(base({ lut: { file: 'R-test-rotate.cube', amount: 0.5 } }), 0.2);
  sheet.add(lut50, 'LUT 50%');
  await sheet.save();
  check('filters change the image', results.filters.every((f) => !f.bad), { bad: results.filters.filter((f) => f.bad).map((f) => f.id), count: FILTERS.length });
  check('colour params change the image', results.color.every((c) => !c.bad), { bad: results.color.filter((c) => c.bad).map((c) => c.key + c.v) });
}

async function testMisc() {
  const sheet = new Sheet('R-misc', 8);
  const card = () => clip('image', { id: 'BG', mediaId: 'm_card', start: 0, duration: 3 });
  const photoOver = (props) => clip('image', { id: 'O', trackId: 'tOver', mediaId: 'm_photo', start: 0, duration: 3, transform: { scale: 0.7 }, ...props });
  const add = async (label, p, t = 0.2, fn) => {
    say('misc ' + label);
    const px = await frame(p, t);
    const s = stats(px);
    let bad = s.mean < 2 && s.std < 2;
    if (fn) { const r = fn(px); if (r === false) bad = true; }
    results.misc.push({ label, ...s, bad });
    sheet.add(px, label, bad);
    return px;
  };
  // top-down readPixels: orange square of card.png at (40..120, 40..120)
  await add('readPixels top-down', proj([card()]), 0.2, (px) => {
    const c = pixelAt(px, 60, 60), d = pixelAt(px, 60, 580);
    const ok = c[0] > 220 && c[1] > 110 && c[1] < 170 && c[2] < 130 && d[2] > 190 && d[0] < 60;
    check('readPixels is top-down', ok, { topLeft: c, bottomLeft: d });
    return ok;
  });
  for (const b of ['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'softlight', 'difference']) {
    await add('blend ' + b, proj([card(), photoOver({ blend: b })]));
  }
  // blend math spot-check: multiply of white(card stripe y=200..280) area by photo → equals photo there
  for (const [type, extra] of [['rect', {}], ['ellipse', {}], ['linear', { rotation: 20 }], ['mirror', { h: 0.3 }], ['ellipse', { invert: true }], ['rect', { rotation: 25, feather: 0.15 }]]) {
    await add(`mask ${type}${extra.invert ? ' inv' : ''}`, proj([card(), photoOver({ transform: { scale: 1 }, mask: { type, x: 0, y: 0, w: 0.6, h: 0.5, rotation: 0, feather: 0.06, invert: false, ...extra } })]));
  }
  await add('chroma key', proj([card(), clip('image', { id: 'G', trackId: 'tOver', mediaId: 'm_green', start: 0, duration: 3, chroma: { enabled: true } })]), 0.2, (px) => {
    const bg = pixelAt(px, 30, 590), subj = pixelAt(px, 110, 400), inner = pixelAt(px, 180, 270);
    const ok = bg[0] < 70 && bg[1] > 150 && bg[1] < 215 && bg[2] > 190 && subj[0] > 200 && subj[1] > 100 && subj[2] < 120 && inner[2] > 200 && inner[0] > 100;
    check('chroma key removes green', ok, { bg, subj, inner });
    return ok;
  });
  await add('chroma off', proj([card(), clip('image', { id: 'G', trackId: 'tOver', mediaId: 'm_green', start: 0, duration: 3 })]));
  await add('crop', proj([card(), photoOver({ transform: { scale: 0.8 }, crop: { l: 0.2, t: 0.1, r: 0.1, b: 0.3 } })]));
  await add('crop+flipX', proj([card(), photoOver({ transform: { scale: 0.8, flipX: true }, crop: { l: 0.2, t: 0.1, r: 0.1, b: 0.3 } })]));
  await add('rot30 s.6', proj([card(), photoOver({ transform: { scale: 0.6, rotation: 30 } })]));
  await add('anchor0 rot20', proj([card(), photoOver({ transform: { scale: 0.5, rotation: 20, anchorX: 0, anchorY: 0 } })]));
  await add('flipY', proj([card(), photoOver({ transform: { scale: 0.6, flipY: true } })]));
  await add('pos x80 y-120', proj([card(), photoOver({ transform: { scale: 0.5, x: 80, y: -120 } })]));
  await add('opacity .5', proj([card(), photoOver({ transform: { scale: 0.8, opacity: 0.5 } })]));
  // premultiplied alpha from PNG ImageBitmap: soft red edge over cyan card at r=165
  await add('alpha png', proj([card(), clip('image', { id: 'AL', trackId: 'tOver', mediaId: 'm_alpha', start: 0, duration: 3, fit: 'none' })]), 0.2, (px) => {
    const e = pixelAt(px, 345, 324);
    const ok = e[0] > 100 && e[0] < 175 && e[1] > 90 && e[1] < 150;
    check('PNG alpha premultiplied (no fringe)', ok, { edge: e, expect: '~[137,121,134]' });
    return ok;
  });
  // text layers (T's rasterizer)
  const txt = (props) => clip('text', { id: 'T1', trackId: 'tText', start: 0, duration: 3, fit: 'none', text: { content: 'שלום עולם 123', font: 'Heebo', weight: 800, size: 54, color: '#ffffff', stroke: { color: '#000000', width: 6 }, maxWidth: 320 }, ...props });
  await add('text', proj([card(), txt({})]), 0.5);
  await add('text rot+glow fx', proj([card(), txt({ transform: { rotation: -12, scale: 1.3 }, effects: [{ id: 'glow', params: {}, enabled: true }] })]), 0.5);
  await add('text dropShadow', proj([card(), txt({ effects: [{ id: 'dropShadow', params: { distance: 10, blur: 8, opacity: 0.9 }, enabled: true }] })]), 0.5);
  await add('caption', proj([card(), clip('caption', { id: 'CP', trackId: 'tText', start: 0, duration: 2, fit: 'none', transform: { y: 200 }, text: { size: 60 }, caption: { style: 'popWords', words: [{ w: 'מילה', s: 0, e: 0.4 }, { w: 'שנייה', s: 0.4, e: 0.9 }, { w: 'כאן', s: 0.9, e: 1.4 }] } })]), 0.6);
  await add('shape star', proj([card(), clip('shape', { id: 'SH', trackId: 'tOver', start: 0, duration: 3, fit: 'none', shape: { kind: 'star', w: 200, h: 200, fill: '#ffcc00', stroke: '#ffffff', strokeWidth: 6 } })]));
  await add('sticker', proj([card(), clip('sticker', { id: 'ST', trackId: 'tOver', start: 0, duration: 3, fit: 'none', sticker: { kind: 'builtin', value: 'checkmark', size: 220 } })]));
  // animState extra passes
  await add('anim blurIn', proj([card(), photoOver({ animIn: { id: 'blurIn', duration: 0.6 } })]), 0.12);
  await add('anim glitchIn', proj([card(), photoOver({ animIn: { id: 'glitchIn', duration: 0.6 } })]), 0.15);
  await add('anim zoomIn', proj([card(), photoOver({ animIn: { id: 'zoomIn', duration: 0.6 } })]), 0.15);
  // effect & adjustment clips over the composite
  const vid = () => clip('video', { id: 'V', mediaId: 'm_pat', start: 0, duration: 3 });
  await add('fx clip glitch', proj([vid(), clip('effect', { id: 'FX', trackId: 'tFx', start: 0, duration: 3, effects: [{ id: 'glitch', params: { intensity: 0.9 }, enabled: true }] })]), 0.5);
  await add('adj noir+vign', proj([vid(), clip('adjustment', { id: 'AD', trackId: 'tFx', start: 0, duration: 3, filter: { id: 'noir', amount: 1 }, color: { vignette: 0.6 } })]), 0.5);
  await add('adj 50% masked', proj([vid(), clip('adjustment', { id: 'AD', trackId: 'tFx', start: 0, duration: 3, transform: { opacity: 1 }, filter: { id: 'blackWhite', amount: 1 }, mask: { type: 'ellipse', x: 0, y: 0, w: 0.7, h: 0.4, feather: 0.1 } })]), 0.5);
  await add('adj opacity .5', proj([vid(), clip('adjustment', { id: 'AD', trackId: 'tFx', start: 0, duration: 3, transform: { opacity: 0.5 }, effects: [{ id: 'invert', params: {}, enabled: true }] })]), 0.5);
  // keyframes
  const kfClip = photoOver({ keyframes: { 'transform.scale': [{ t: 0, v: 0.3, ease: 'linear' }, { t: 2, v: 1, ease: 'linear' }], 'transform.rotation': [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 90, ease: 'linear' }] } });
  await add('keyframes t=1', proj([card(), kfClip]), 1.0);
  comp.setProject(proj([card(), kfClip]));
  const kb = comp.clipBounds(1.0, 'O');
  check('keyframed scale/rotation in clipBounds', kb && Math.abs(kb.w - 360 * 0.65) < 2 && Math.abs(kb.rotation - 45) < 0.5, { bounds: kb && { w: kb.w, h: kb.h, rot: kb.rotation } });
  // landscape video fits
  await add('land contain', proj([card(), clip('video', { id: 'L', trackId: 'tOver', mediaId: 'm_pat2', start: 0, duration: 3, fit: 'contain' })]), 0.5);
  await add('land cover', proj([clip('video', { id: 'L', mediaId: 'm_pat2', start: 0, duration: 3, fit: 'cover' })]), 0.5);
  // same media on both sides of a transition (split halves) → two elements
  const sa = clip('video', { id: 'SA', mediaId: 'm_pat', start: 0, duration: 1.5, in: 0, transitionOut: { id: 'crossfade', duration: 0.8 } });
  const sb = clip('video', { id: 'SB', mediaId: 'm_pat', start: 1.5, duration: 1.5, in: 2.2 });
  await add('split xfade', proj([sa, sb]), 1.5);
  // text → text transition
  const ta = txt({ id: 'TA', start: 0, duration: 1.5, transitionOut: { id: 'pushLeft', duration: 0.8 } });
  const tb = txt({ id: 'TB', start: 1.5, duration: 1.5, text: { content: 'טקסט שני', color: '#ffcc00' } });
  await add('text pushLeft', proj([card(), ta, tb]), 1.5);
  // hidden track
  const hidden = proj([card(), photoOver({})]);
  hidden.tracks.find((t) => t.id === 'tOver').hidden = true;
  const hp = await add('hidden overlay', hidden);
  const cardOnly = await frame(proj([card()]), 0.2);
  check('hidden track not drawn', diff(hp, cardOnly) < 0.5, { diff: diff(hp, cardOnly) });
  await sheet.save();
}

async function testGeometry() {
  say('hitTest / clipBounds');
  const p = proj([
    clip('image', { id: 'BG', mediaId: 'm_card', start: 0, duration: 3 }),
    clip('image', { id: 'O', trackId: 'tOver', mediaId: 'm_photo', start: 0, duration: 3, transform: { scale: 0.5, rotation: 45, x: 30, y: -40 } }),
  ]);
  comp.setProject(p);
  const b = comp.clipBounds(0.5, 'O');
  const okB = b && Math.abs(b.cx - 210) < 0.5 && Math.abs(b.cy - 280) < 0.5 && Math.abs(b.w - 180) < 0.5 && Math.abs(b.h - 320) < 0.5 && Math.abs(b.rotation - 45) < 1e-6 && b.corners.length === 4;
  check('clipBounds', okB, { b });
  const hitCenter = comp.hitTest(0.5, 210, 280);
  const hitCorner = comp.hitTest(0.5, 5, 5);
  // a point inside the axis-aligned bbox of the rotated quad but outside the quad
  const outside = comp.hitTest(0.5, b.corners[0][0] + 2, b.corners[1][1] + 2);
  check('hitTest topmost', hitCenter === 'O' && hitCorner === 'BG', { hitCenter, hitCorner, outside });
  const locked = JSON.parse(JSON.stringify(p));
  locked.tracks.find((t) => t.id === 'tOver').locked = true;
  comp.setProject(locked);
  check('hitTest skips locked tracks', comp.hitTest(0.5, 210, 280) === 'BG', {});
}

async function testSeek() {
  say('exact seek');
  const out = [];
  const mk = (props) => proj([clip('video', { id: 'K', mediaId: 'm_cnt', start: 0, duration: 3, fit: 'fill', ...props })]);
  let maxOff = 0;
  for (let k = 0; k <= 48; k += 3) {
    const px = await frame(mk({}), k / FPS);
    const v = pixelAt(px, 180, 320)[0];
    const exp = (k * 5) % 256;
    const off = Math.round((v - exp) / 5);
    maxOff = Math.max(maxOff, Math.abs(off));
    out.push({ k, v, exp, off });
  }
  const sp2 = await frame(mk({ speed: 2 }), 0.5);
  const rev = await frame(mk({ duration: 2, reverse: true }), 0.5);
  const s2 = pixelAt(sp2, 180, 320)[0], r2 = pixelAt(rev, 180, 320)[0];
  const fast = new SourceProvider({ mode: 'export', projectId: 'rtest', frameTimeout: 0 });
  let fastOff = 0;
  const tf0 = performance.now();
  for (let k = 1; k <= 49; k += 4) {
    const px = await frame(mk({ id: 'K2' }), k / FPS, comp, fast);
    const v = pixelAt(px, 180, 320)[0];
    fastOff = Math.max(fastOff, Math.abs(Math.round((v - (k * 5) % 256) / 5)));
  }
  const fastMs = (performance.now() - tf0) / 13;
  fast.dispose();
  results.seekNoFrameWait = { maxFrameOffset: fastOff, msPerFrame: Math.round(fastMs) };
  check('exact seek without rVFC wait', fastOff === 0, { fastOff });
  results.seek = { frames: out, maxFrameOffset: maxOff, speed2: { v: s2, exp: 150 }, reverse: { v: r2, exp: 225 }, stats: { ...sp.stats } };
  check('exact seek lands on the right frame', maxOff === 0, { maxOff });
  check('speed 2 source time', Math.abs(s2 - 150) <= 6, { v: s2 });
  check('reverse source time', Math.abs(r2 - 225) <= 6, { v: r2 });
}

async function testPreview() {
  say('preview playback');
  const cv = document.createElement('canvas');
  const pc = new Compositor(cv, { mode: 'preview', scale: 0.5 });
  const ps = new SourceProvider({ mode: 'preview', projectId: 'rtest' });
  const p = proj([clip('video', { id: 'K', mediaId: 'm_cnt', start: 0, duration: 3, fit: 'fill' })]);
  pc.setProject(p); ps.setProject(p);
  ps.preloadAround(0);
  await ps.whenReady(0, 8000);
  ps.startPlayback(0, p);
  const t0 = performance.now();
  const drifts = [], offs = [];
  await new Promise((resolve) => {
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      if (t > 2.2) { resolve(); return; }
      ps.tick(t);
      pc.renderFrameSync(t, ps);
      const slot = ps.slots.get('K');
      if (slot && t > 0.4) {
        drifts.push(Math.abs(slot.el.currentTime - t));
        const px = pc.readPixels();
        const v = px[((160 * 180) + 90) * 4];
        const k = Math.floor(t * FPS + 1e-6);
        offs.push(Math.round((((v - ((k * 5) % 256)) + 384) % 256 - 128) / 5));
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  ps.stopPlayback();
  const sorted = drifts.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  // paused scrub: getSync triggers a seek, frame arrives, compositor redraws by itself
  pc.renderFrameSync(1.0, ps);
  await new Promise((r) => setTimeout(r, 600));
  pc.renderFrameSync(1.0, ps);
  const v1 = pc.readPixels()[((160 * 180) + 90) * 4];
  // exact still in preview mode (what the viewer does while paused)
  await pc.renderFrame(2.0, ps);
  const v2 = pc.readPixels()[((160 * 180) + 90) * 4];
  results.preview = { samples: drifts.length, medianDrift: +med.toFixed(3), p90Drift: +p90.toFixed(3), maxDrift: +(sorted[sorted.length - 1] || 0).toFixed(3), frameOffsets: summarize(offs), scrub1s: { v: v1, exp: 150 }, exact2s: { v: v2, exp: 44 }, stats: { ...ps.stats } };
  check('preview drift < 0.08 s (p90)', p90 < 0.08, { med, p90 });
  const within = offs.filter((o) => Math.abs(o) <= 1).length / Math.max(1, offs.length);
  check('preview frames within ±1 frame of the clock (95%)', within >= 0.95, { within: +within.toFixed(3), offsets: summarize(offs) });
  check('preview scrub shows the seeked frame', Math.abs(v1 - 150) <= 6, { v1 });
  check('preview exact still', Math.abs(v2 - 44) <= 6, { v2 });
  pc.dispose(); ps.dispose();
}
function summarize(a) { const m = {}; for (const x of a) m[x] = (m[x] || 0) + 1; return m; }

async function testContextLoss() {
  say('context loss');
  const cv = document.createElement('canvas');
  const c = new Compositor(cv, { mode: 'export' });
  const p = proj([clip('image', { id: 'BG', mediaId: 'm_card', start: 0, duration: 3 })]);
  await frame(p, 0.2, c);
  const ext = c.gl.getExtension('WEBGL_lose_context');
  if (!ext) { check('context loss', true, { skipped: true }); return; }
  const restored = new Promise((r) => cv.addEventListener('webglcontextrestored', r, { once: true }));
  const lost = new Promise((r) => cv.addEventListener('webglcontextlost', r, { once: true }));
  ext.loseContext();
  await lost;
  let threw = false, ret = null;
  try { ret = c.renderFrameSync(0.2, sp); } catch (e) { threw = true; }
  // Chrome only honours restoreContext() in a later task than the lost event (like a real GPU reset)
  await new Promise((r) => setTimeout(r, 200));
  ext.restoreContext();
  const gotRestored = await Promise.race([restored.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
  await new Promise((r) => setTimeout(r, 50));
  post('/__log', '[info] ctx restored=' + gotRestored + ' lost=' + c._lost + ' isLost=' + c.gl.isContextLost());
  let px;
  try { px = await frame(p, 0.2, c); } catch (e) { check('context loss handled', false, { threw, ret, gotRestored, lost: c._lost, isLost: c.gl.isContextLost(), err: String(e.message) }); c.dispose(); return; }
  check('context loss handled', !threw && ret === false && stats(px).mean > 20, { threw, ret, gotRestored, after: stats(px) });
  c.dispose();
}

async function testPerf() {
  say('perf 1080x1920');
  const cv = document.createElement('canvas');
  const c = new Compositor(cv, { mode: 'export' });
  const p = proj([
    clip('video', { id: 'V', mediaId: 'm_pat', start: 0, duration: 3, color: { contrast: 0.2, saturation: 0.1 }, filter: { id: 'cinematic', amount: 0.8 } }),
    clip('image', { id: 'O', trackId: 'tOver', mediaId: 'm_photo', start: 0, duration: 3, transform: { scale: 0.5, rotation: 8 }, effects: [{ id: 'glow', params: {}, enabled: true }, { id: 'vignette', params: {}, enabled: true }], mask: { type: 'ellipse', x: 0, y: 0, w: 0.9, h: 0.9, feather: 0.1 } }),
    clip('text', { id: 'T', trackId: 'tText', start: 0, duration: 3, fit: 'none', transform: { y: -500 }, text: { content: 'בדיקת ביצועים', size: 110, weight: 900 } }),
  ], { w: 1080, h: 1920 });
  await frame(p, 0, c);
  const t0 = performance.now();
  const n = 8;
  for (let i = 1; i <= n; i++) await frame(p, i / FPS, c);
  const ms = (performance.now() - t0) / n;
  const px = c.readPixels();
  results.perf = { size: '1080x1920', msPerFrame: Math.round(ms), lastStats: c.getStats(), bytes: px.length, note: 'SwiftShader (software GL); real GPU is far faster' };
  check('export readPixels size', px.length === 1080 * 1920 * 4, { len: px.length });
  c.dispose();
}

async function main() {
  const t0 = performance.now();
  const steps = [testCompile, testTransitions, testEffects, testColor, testMisc, testGeometry, testSeek, testPreview, testContextLoss, testPerf];
  for (const s of steps) {
    try { await s(); } catch (e) { results.errors.push(`${s.name}: ${e && e.stack || e}`); post('/__log', `[error] ${s.name}: ${e && e.stack || e}`); }
  }
  const failed = results.checks.filter((c) => !c.ok);
  results.summary = {
    ok: failed.length === 0 && results.errors.length === 0,
    seconds: Math.round((performance.now() - t0) / 1000),
    transitions: TRANSITIONS.length, effects: EFFECTS.length, filters: FILTERS.length,
    shaders: results.compile && { total: results.compile.total, failed: results.compile.failures.length, ms: results.compile.ms },
    failedChecks: failed.map((c) => c.name),
    passedChecks: results.checks.filter((c) => c.ok).length,
    errors: results.errors.slice(0, 10),
    seek: results.seek && { maxFrameOffset: results.seek.maxFrameOffset, stats: results.seek.stats },
    preview: results.preview && { medianDrift: results.preview.medianDrift, p90Drift: results.preview.p90Drift, offsets: results.preview.frameOffsets },
    perf: results.perf && results.perf.msPerFrame,
  };
  document.getElementById('result').textContent = JSON.stringify(results.summary, null, 2);
  say(results.summary.ok ? 'DONE:ok' : 'DONE:fail');
  await fetch('/__done', { method: 'POST', body: JSON.stringify(results) });
}
main();
