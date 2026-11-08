// render/compositor.js — Frame Studio WebGL2 compositor (agent R), used by the editor preview and by export.
//
// Pipeline per frame (premultiplied alpha everywhere, pooled FBOs, all textures top-down — see effects-gl.js):
//   comp = background → for each visual track from LAST to FIRST (tracks[0] ends on top):
//     clip layer: source texture → [crop/pad → chroma → colour → filter → LUT] → effects → mask → anim blur/glitch
//                 → drawn with its model matrix (fit, anchor, flip, rotation, scale, keyframes + animState),
//                   opacity and blend mode (GL blend for normal/add, shader blend for the rest)
//     transition: A and B rendered as full-canvas layers, mixed by the transition shader (normal blend)
//     effect / adjustment clip: processes the composite drawn so far (tracks below)
//   → final blit to the canvas (flipped), readPixels() returns top-down RGBA.
//
// Module is Node-importable: no DOM / GL access at top level.

import * as anim from '../shared/anim.js';
import {
  QUAD_VS, FboPool, getProgram, drawQuad, createTexture, parseColor, resetGLCache, disposeGLCache,
  programFailures, applyColor, applyEffect, applyMask, applyMaskedMix, loadCubeLut, colorIsActive,
  maskIsActive, getFilter, getEffect, effectPadding, compileAllEffects, EFFECTS, FILTERS,
} from './effects-gl.js';
import { drawTransition, findTransitionPairs, compileAllTransitions, TRANSITIONS } from './transitions-gl.js';

export { EFFECTS, FILTERS, TRANSITIONS };

const VISUAL = new Set(['video', 'image', 'text', 'caption', 'shape', 'sticker', 'effect', 'adjustment']);
const MEDIA_TYPES = new Set(['video', 'image']);
const RASTER_TYPES = new Set(['text', 'caption', 'shape', 'sticker']);
const ADJUST_TYPES = new Set(['effect', 'adjustment']);
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'softlight', 'difference'];
const BLEND_IDS = Object.fromEntries(BLEND_MODES.map((m, i) => [m, i]));
const DEF_TR = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5, flipX: false, flipY: false };
const IDENT_ANIM = { dx: 0, dy: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, blur: 0, glitch: 0 };
const EPS = 1e-9;

const LAYER_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
uniform mat3 u_model;
uniform vec2 u_canvas;
uniform vec4 u_uvRect;
uniform vec2 u_flip;
out vec2 v_uv;
out vec2 v_unit;
void main(){
  vec2 px = (u_model * vec3(a_pos, 1.0)).xy;
  gl_Position = vec4(px / u_canvas * 2.0 - 1.0, 0.0, 1.0);
  vec2 u = vec2(u_flip.x > 0.5 ? 1.0 - a_pos.x : a_pos.x, u_flip.y > 0.5 ? 1.0 - a_pos.y : a_pos.y);
  v_uv = mix(u_uvRect.xy, u_uvRect.zw, u);
  v_unit = a_pos;
}`;

const LAYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_unit;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform sampler2D u_backdrop;
uniform float u_opacity;
uniform int u_blend;
uniform float u_aa;
float softL(float b, float s){
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
vec3 blendFn(int m, vec3 b, vec3 s){
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return mix(2.0 * s * b, 1.0 - 2.0 * (1.0 - s) * (1.0 - b), step(0.5, b));
  if (m == 5) return min(b, s);
  if (m == 6) return max(b, s);
  if (m == 7) return vec3(softL(b.r, s.r), softL(b.g, s.g), softL(b.b, s.b));
  if (m == 8) return abs(b - s);
  return s;
}
void main(){
  vec4 s = texture(u_tex, v_uv) * u_opacity;
  if (u_aa > 0.5) {
    vec2 fw = max(fwidth(v_unit), vec2(1e-6));
    vec2 d = min(v_unit, 1.0 - v_unit) / fw;
    s *= clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
  }
  if (u_blend == 0 || u_blend == 4) { fragColor = s; return; }
  vec4 b = texelFetch(u_backdrop, ivec2(gl_FragCoord.xy), 0);
  vec3 Cs = s.a > 1e-5 ? s.rgb / s.a : vec3(0.0);
  vec3 Cb = b.a > 1e-5 ? b.rgb / b.a : vec3(0.0);
  vec3 B = clamp(blendFn(u_blend, Cb, Cs), 0.0, 1.0);
  vec3 co = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * B;
  fragColor = vec4(co, s.a + b.a * (1.0 - s.a));
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main(){ vec4 c = texture(u_tex, v_uv); fragColor = vec4(c.rgb, 1.0); }`;

let TEXT_MODULE = null;
function loadTextModule() {
  if (!TEXT_MODULE) {
    TEXT_MODULE = import('./text-render.js').catch((e) => {
      if (typeof console !== 'undefined') console.warn('[Frame Studio] text-render.js לא נטען — שכבות טקסט לא יוצגו', e);
      return null;
    });
  }
  return TEXT_MODULE;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const isVideoEl = (s) => typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement;
const isCanvasLike = (s) => (typeof HTMLCanvasElement !== 'undefined' && s instanceof HTMLCanvasElement)
  || (typeof OffscreenCanvas !== 'undefined' && s instanceof OffscreenCanvas);
const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

function fitSize(fit, sw, sh, W, H) {
  if (!(sw > 0) || !(sh > 0)) return [W, H];
  switch (fit) {
    case 'fill': return [W, H];
    case 'none': return [sw, sh];
    case 'cover': { const s = Math.max(W / sw, H / sh); return [sw * s, sh * s]; }
    case 'contain':
    default: { const s = Math.min(W / sw, H / sh); return [sw * s, sh * s]; }
  }
}
function defaultFit(sw, sh, W, H) {
  if (!(sw > 0) || !(sh > 0)) return 'contain';
  const a = sw / sh, b = W / H;
  return Math.abs(a / b - 1) <= 0.05 ? 'cover' : 'contain';
}

function pointInQuad(x, y, c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[(i + 1) % 4];
    const cr = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/** Minimal keyframe fallback when shared/anim.js lacks evalClipProps/evalKeyframed. */
function kfLinear(kfs, t, fallback) {
  if (!Array.isArray(kfs) || !kfs.length) return fallback;
  const k = kfs.slice().sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return k[0].v;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const a = k[i - 1], b = k[i];
      if (b.ease === 'hold') return a.v;
      const p = (t - a.t) / Math.max(1e-9, b.t - a.t);
      return a.v + (b.v - a.v) * p;
    }
  }
  return fallback;
}
function evalFallback(clip, t) {
  const K = clip.keyframes || {};
  const ev = (prop, base) => {
    if (typeof anim.evalKeyframed === 'function') { try { return num(anim.evalKeyframed(clip, prop, t, base), base); } catch (_) { /* fall through */ } }
    return num(kfLinear(K[prop], t, base), base);
  };
  const transform = Object.assign({}, DEF_TR, clip.transform || {});
  for (const k of ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY']) transform[k] = ev('transform.' + k, num(transform[k], DEF_TR[k]));
  const color = {};
  for (const k of Object.keys(clip.color || {})) color[k] = ev('color.' + k, num(clip.color[k], 0));
  const crop = {};
  for (const k of ['l', 't', 'r', 'b']) crop[k] = ev('crop.' + k, num(clip.crop && clip.crop[k], 0));
  const effects = (clip.effects || []).map((fx, i) => {
    const params = Object.assign({}, fx.params || {});
    for (const prop of Object.keys(K)) if (prop.startsWith(`effects.${i}.`)) { const key = prop.slice(`effects.${i}.`.length); params[key] = ev(prop, num(params[key], 0)); }
    return { id: fx.id, params, enabled: fx.enabled !== false };
  });
  const mask = Object.assign({}, clip.mask || {});
  for (const k of ['x', 'y', 'w', 'h', 'rotation', 'feather']) if (k in mask) mask[k] = ev('mask.' + k, num(mask[k], 0));
  return { transform, color, crop, effects, mask, filterAmount: ev('filter.amount', num(clip.filter && clip.filter.amount, 1)), lutAmount: ev('lut.amount', num(clip.lut && clip.lut.amount, 1)) };
}

export class Compositor {
  /**
   * @param canvas HTMLCanvasElement | OffscreenCanvas
   * @param opts { mode:"preview"|"export", scale:1, apiBase:"" (prefix for /library/luts fetches) }
   */
  constructor(canvas, { mode = 'preview', scale = 1, apiBase = '' } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new Error('Compositor: נדרש קנבס');
    this.canvas = canvas;
    this.mode = mode === 'export' ? 'export' : 'preview';
    this.scale = clamp(num(scale, 1), 0.05, 4);
    this.apiBase = apiBase || '';
    this.project = null;
    this.onNeedsRedraw = null;   // optional callback (preview): called when async data (frames, LUTs, fonts) arrived
    this.onError = null;         // optional callback(err)
    this.stats = { frame: 0, layers: 0, ms: 0, lastError: null };
    this._lost = false;
    this._disposed = false;
    this._queue = Promise.resolve();
    this._lastT = null;
    this._lastSources = null;
    this._hooked = null;
    this._dims = new Map();
    this._warned = new Set();
    this._text = null;
    this._textDone = false;
    this._textReady = loadTextModule().then((m) => { this._text = m; this._textDone = true; this._requestRedraw(); return m; });
    const gl = canvas.getContext('webgl2', {
      alpha: false, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: this.mode === 'export', powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 אינו זמין בדפדפן זה');
    this.gl = gl;
    this._onLost = (e) => { e.preventDefault(); this._lost = true; this.stats.lastError = 'הקשר WebGL אבד'; };
    this._onRestored = () => { this._lost = false; this._initGL(); this._requestRedraw(); };
    if (typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this._onLost, false);
      canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    }
    this._redrawFn = () => this._requestRedraw();
    this._initGL();
  }

  _initGL() {
    const gl = this.gl;
    resetGLCache(gl);
    this.pool = new FboPool(gl);
    this._tex = new Map();
    this._luts = new Map();
    this._final = null;
    this._frame = 0;
    this._maxTex = Math.max(1024, Math.min(4096, num(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096)));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  /* ------------------------------------------------------------------ public API */

  setProject(project) {
    const prev = this.project;
    this.project = project || null;
    this._struct = null;
    if (prev && project && prev.clips && project.clips) {
      for (const [key, e] of this._tex) {
        if (e.clipId && !project.clips[e.clipId]) this._dropTex(key);
      }
    }
    this._resize();
  }

  setScale(scale) {
    this.scale = clamp(num(scale, 1), 0.05, 4);
    this._resize();
    this._requestRedraw();
  }

  /** Preview: draw immediately with whatever frames the SourceProvider has. Never awaits, never throws. */
  renderFrameSync(t, sources) {
    if (!this._ready()) return false;
    t = num(t, 0);
    this._lastT = t;
    this._lastSources = sources || null;
    this._hook(sources);
    try {
      const plan = this._plan(t);
      const srcMap = new Map();
      for (const r of this._requirements(plan, t)) {
        let el = null;
        try { el = sources && typeof sources.getSync === 'function' ? sources.getSync(r.clip, r.st) : null; } catch (_) { el = null; }
        srcMap.set(r.clip.id, el);
      }
      this._draw(t, plan, srcMap, false);
      return true;
    } catch (e) { this._error(e); return false; }
  }

  /** Export / exact still: awaits exact source frames, LUTs and the text module, then draws. */
  renderFrame(t, sources) {
    const run = async () => {
      if (!this._ready()) return false;
      t = num(t, 0);
      this._hook(sources);
      // auto-redraws triggered while we await must target this time, not an older one
      this._lastT = t;
      this._lastSources = sources || null;
      this._exactBusy = (this._exactBusy || 0) + 1;
      try {
        if (!this._textDone) {
          let to = null;
          await Promise.race([this._textReady, new Promise((r) => { to = setTimeout(r, 4000); })]);
          clearTimeout(to);
        }
        const plan = this._plan(t);
        const reqs = this._requirements(plan, t);
        const srcMap = new Map();
        await Promise.all(reqs.map(async (r) => {
          let el = null;
          try {
            if (sources && typeof sources.getExact === 'function') el = await sources.getExact(r.clip, r.st);
            else if (sources && typeof sources.getSync === 'function') el = sources.getSync(r.clip, r.st);
          } catch (_) { el = null; }
          srcMap.set(r.clip.id, el || null);
        }));
        await this._ensureLuts(plan);
        if (!this._ready()) return false;
        this._lastT = t;
        this._lastSources = sources || null;
        this._draw(t, plan, srcMap, true);
        return true;
      } catch (e) { this._error(e); return false; } finally { this._exactBusy--; }
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  /** RGBA, top-to-bottom rows, (width*scale)×(height*scale)×4 of the last rendered frame. */
  readPixels() {
    const gl = this.gl;
    const [RW, RH] = this._renderSize();
    const f = this._final;
    if (!f || this._lost || f.w !== RW || f.h !== RH) {
      return new Uint8Array(RW * RH * 4);
    }
    const out = new Uint8Array(f.w * f.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, f.w, f.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Topmost visual clip (not effect/adjustment, not on hidden/locked tracks) whose transformed quad contains (x,y) canvas px. */
  hitTest(t, x, y) {
    if (!this.project) return null;
    t = num(t, 0);
    const st = this._structure();
    for (let i = 0; i < st.tracks.length; i++) {
      const T = st.tracks[i];
      if (T.track.hidden || T.track.locked) continue;
      const cands = [];
      const consumed = new Set();
      for (const pr of T.pairs) {
        if (t >= pr.t0 && t < pr.t1) {
          const p = (t - pr.t0) / (pr.t1 - pr.t0);
          cands.push(...(p >= 0.5 ? [pr.b, pr.a] : [pr.a, pr.b]).map((c, k) => ({ c, order: 1e9 - k })));
          consumed.add(pr.a.id); consumed.add(pr.b.id);
        }
      }
      for (const c of T.clips) {
        if (c.disabled || consumed.has(c.id) || ADJUST_TYPES.has(c.type)) continue;
        if (c.start <= t + EPS && t < c.start + c.duration - EPS) cands.push({ c, order: c.start });
      }
      cands.sort((a, b) => b.order - a.order);
      for (const { c } of cands) {
        if (ADJUST_TYPES.has(c.type)) continue;
        const g = this._geometry(c, t);
        if (g && pointInQuad(x, y, g.corners)) return c.id;
      }
    }
    return null;
  }

  /** {cx, cy, w, h, rotation, corners:[[x,y]×4 TL,TR,BR,BL]} in canvas px for the viewer handles. */
  clipBounds(t, clipId) {
    const clip = this.project && this.project.clips ? this.project.clips[clipId] : null;
    if (!clip || !VISUAL.has(clip.type)) return null;
    if (ADJUST_TYPES.has(clip.type)) {
      const { width: W, height: H } = this._settings();
      return { cx: W / 2, cy: H / 2, w: W, h: H, rotation: 0, corners: [[0, 0], [W, 0], [W, H], [0, H]] };
    }
    const g = this._geometry(clip, num(t, 0));
    if (!g) return null;
    const cx = (g.corners[0][0] + g.corners[1][0] + g.corners[2][0] + g.corners[3][0]) / 4;
    const cy = (g.corners[0][1] + g.corners[1][1] + g.corners[2][1] + g.corners[3][1]) / 4;
    return { cx, cy, w: g.w, h: g.h, rotation: g.rotationDeg, corners: g.corners };
  }

  /** Compile every shader up front. → { total, failures:[{kind,id,error}] } */
  compileAll() {
    const gl = this.gl;
    const failures = [...compileAllEffects(gl), ...compileAllTransitions(gl)];
    for (const [key, vs, fs] of [['layer', LAYER_VS, LAYER_FS], ['blit', QUAD_VS, BLIT_FS]]) {
      if (!getProgram(gl, key, () => [vs, fs])) failures.push({ kind: 'core', id: key, error: (programFailures(gl).find((f) => f.key === key) || {}).error });
    }
    const total = 5 + TRANSITIONS.length + EFFECTS.reduce((n, e) => n + e.passes.length, 0);
    return { total, failures };
  }

  /** Last frame duration etc. */
  getStats() { return Object.assign({}, this.stats); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._hooked && typeof this._hooked.removeEventListener === 'function') this._hooked.removeEventListener('frame', this._redrawFn);
    this._hooked = null;
    if (typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this._onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    }
    const gl = this.gl;
    try {
      if (!gl.isContextLost()) {
        for (const e of this._tex.values()) gl.deleteTexture(e.tex);
        for (const e of this._luts.values()) if (e.lut) gl.deleteTexture(e.lut.tex);
      }
    } catch (_) { /* ignore */ }
    this._tex.clear();
    this._luts.clear();
    if (this.pool) this.pool.dispose();
    disposeGLCache(gl);
    this._final = null;
    this.project = null;
  }

  /* ------------------------------------------------------------------ internals: setup */

  _ready() { return !this._disposed && !this._lost && !!this.project && !this.gl.isContextLost(); }

  _settings() {
    const s = (this.project && this.project.settings) || {};
    return { width: Math.max(1, num(s.width, 1080)), height: Math.max(1, num(s.height, 1920)), fps: Math.max(1, num(s.fps, 30)), background: s.background || '#000000' };
  }

  _renderSize() {
    const { width, height } = this._settings();
    return [Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale))];
  }

  _resize() {
    if (!this.project) return;
    const [RW, RH] = this._renderSize();
    if (this.canvas.width !== RW) this.canvas.width = RW;
    if (this.canvas.height !== RH) this.canvas.height = RH;
  }

  _hook(sources) {
    if (!sources || sources === this._hooked) return;
    if (this._hooked && typeof this._hooked.removeEventListener === 'function') this._hooked.removeEventListener('frame', this._redrawFn);
    this._hooked = sources;
    if (typeof sources.addEventListener === 'function') sources.addEventListener('frame', this._redrawFn);
  }

  _requestRedraw() {
    if (this._disposed || this.mode !== 'preview') return;
    if (typeof this.onNeedsRedraw === 'function') { try { this.onNeedsRedraw(); } catch (_) { /* ignore */ } return; }
    if (this._redrawPending || this._lastT == null) return;
    this._redrawPending = true;
    const stamp = this.stats.frame;
    raf(() => {
      this._redrawPending = false;
      if (this._disposed || this._lastT == null) return;
      if (this.stats.frame !== stamp) return; // somebody already rendered a newer frame
      if (this._exactBusy > 0) return;        // an exact render is in flight and will draw
      this.renderFrameSync(this._lastT, this._lastSources);
    });
  }

  _error(e) {
    this.stats.lastError = String((e && e.message) || e);
    const key = this.stats.lastError.slice(0, 120);
    if (!this._warned.has(key)) {
      this._warned.add(key);
      if (typeof console !== 'undefined') console.warn('[Frame Studio] compositor:', e);
    }
    if (typeof this.onError === 'function') { try { this.onError(e); } catch (_) { /* ignore */ } }
  }

  /* ------------------------------------------------------------------ internals: timeline */

  _structure() {
    if (this._struct && this._struct.project === this.project) return this._struct;
    const p = this.project;
    const fps = this._settings().fps;
    const byTrack = new Map();
    for (const c of Object.values(p.clips || {})) {
      if (!c || !VISUAL.has(c.type)) continue;
      if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
      byTrack.get(c.trackId).push(c);
    }
    const tracks = [];
    for (const track of p.tracks || []) {
      if (!track || track.kind === 'audio') continue;
      const clips = (byTrack.get(track.id) || []).slice().sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
      tracks.push({ track, clips, pairs: findTransitionPairs(clips, fps) });
    }
    this._struct = { project: p, tracks };
    return this._struct;
  }

  /** Draw items bottom → top. */
  _plan(t) {
    const st = this._structure();
    const items = [];
    for (let i = st.tracks.length - 1; i >= 0; i--) {
      const T = st.tracks[i];
      if (T.track.hidden) continue;
      const list = [];
      const consumed = new Set();
      for (const pr of T.pairs) {
        if (t >= pr.t0 && t < pr.t1) {
          list.push({ kind: 'transition', pair: pr, order: pr.a.start, track: T.track });
          consumed.add(pr.a.id); consumed.add(pr.b.id);
        }
      }
      for (const c of T.clips) {
        if (c.disabled || consumed.has(c.id)) continue;
        if (c.start <= t + EPS && t < c.start + c.duration - EPS) {
          list.push({ kind: ADJUST_TYPES.has(c.type) ? 'adjust' : 'clip', clip: c, order: c.start, track: T.track });
        }
      }
      list.sort((a, b) => a.order - b.order);
      for (const it of list) items.push(it);
    }
    return items;
  }

  _sourceTime(clip, t) {
    const sp = clip.speed > 0 ? clip.speed : 1;
    const local = t - (clip.start || 0);
    let s = clip.reverse ? (clip.in || 0) + ((clip.duration || 0) - local) * sp : (clip.in || 0) + local * sp;
    const m = this.project.media && this.project.media[clip.mediaId];
    if (m && m.duration > 0) s = clamp(s, 0, m.duration); else s = Math.max(0, s);
    return s;
  }

  _requirements(plan, t) {
    const out = [];
    const add = (c) => { if (c && MEDIA_TYPES.has(c.type) && c.mediaId) out.push({ clip: c, st: this._sourceTime(c, t) }); };
    for (const it of plan) {
      if (it.kind === 'clip') add(it.clip);
      else if (it.kind === 'transition') { add(it.pair.a); add(it.pair.b); }
    }
    return out;
  }

  async _ensureLuts(plan) {
    const files = new Set();
    const addClip = (c) => { if (c && c.lut && c.lut.file && num(c.lut.amount, 1) > 0.001) files.add(c.lut.file); };
    for (const it of plan) {
      if (it.kind === 'transition') { addClip(it.pair.a); addClip(it.pair.b); } else addClip(it.clip);
    }
    await Promise.all([...files].map((f) => { this._getLut(f); const e = this._luts.get(f); return e && e.promise ? e.promise.catch(() => null) : null; }));
  }

  _getLut(file) {
    if (!file) return null;
    let e = this._luts.get(file);
    if (!e) {
      e = { state: 'loading', lut: null, promise: null };
      this._luts.set(file, e);
      const url = `${this.apiBase}/library/luts/${String(file).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
      e.promise = (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`LUT ${file}: HTTP ${res.status}`);
          const text = await res.text();
          if (this._disposed || this.gl.isContextLost()) return null;
          e.lut = loadCubeLut(this.gl, text);
          e.state = 'ready';
          this._requestRedraw();
          return e.lut;
        } catch (err) {
          e.state = 'error';
          this._error(err);
          return null;
        }
      })();
    }
    return e.state === 'ready' ? e.lut : null;
  }

  /* ------------------------------------------------------------------ internals: evaluation */

  _eval(clip, aT) {
    let ev = null;
    if (typeof anim.evalClipProps === 'function') { try { ev = anim.evalClipProps(clip, aT); } catch (_) { ev = null; } }
    if (!ev || typeof ev !== 'object') ev = evalFallback(clip, aT);
    const tr = Object.assign({}, DEF_TR, clip.transform || {}, ev.transform || {});
    for (const k of ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY']) tr[k] = num(tr[k], DEF_TR[k]);
    tr.flipX = !!(clip.transform && clip.transform.flipX);
    tr.flipY = !!(clip.transform && clip.transform.flipY);
    return {
      tr,
      color: ev.color || clip.color || null,
      crop: ev.crop || clip.crop || null,
      effects: Array.isArray(ev.effects) ? ev.effects : (clip.effects || []),
      mask: ev.mask && ev.mask.type ? ev.mask : (clip.mask || null),
      filterAmount: num(ev.filterAmount, num(clip.filter && clip.filter.amount, 1)),
      lutAmount: num(ev.lutAmount, num(clip.lut && clip.lut.amount, 1)),
    };
  }

  _anim(clip, aT) {
    const { width, height } = this._settings();
    let st = null;
    if (typeof anim.animState === 'function') { try { st = anim.animState(clip, aT, width, height); } catch (_) { st = null; } }
    const o = Object.assign({}, IDENT_ANIM);
    if (st) for (const k in IDENT_ANIM) o[k] = num(st[k], IDENT_ANIM[k]);
    return o;
  }

  /** Shared geometry: base rect (local px around clip position), crop, transform → corners & matrix. */
  _layout(clip, t, base, ev, as) {
    const { width: W, height: H } = this._settings();
    const tr = ev.tr;
    const cr = ev.crop || {};
    let l = clamp(num(cr.l, 0), 0, 0.999), tp = clamp(num(cr.t, 0), 0, 0.999), r = clamp(num(cr.r, 0), 0, 0.999), b = clamp(num(cr.b, 0), 0, 0.999);
    if (l + r > 0.998) { const k = 0.998 / (l + r); l *= k; r *= k; }
    if (tp + b > 0.998) { const k = 0.998 / (tp + b); tp *= k; b *= k; }
    const bw = base.x1 - base.x0, bh = base.y1 - base.y0;
    const mcx = (base.x0 + base.x1) / 2, mcy = (base.y0 + base.y1) / 2;
    let x0 = base.x0 + l * bw, x1 = base.x1 - r * bw, y0 = base.y0 + tp * bh, y1 = base.y1 - b * bh;
    if (tr.flipX) { const a = 2 * mcx - x1, c = 2 * mcx - x0; x0 = a; x1 = c; }
    if (tr.flipY) { const a = 2 * mcy - y1, c = 2 * mcy - y0; y0 = a; y1 = c; }
    const sx = tr.scale * tr.scaleX * as.scale * as.scaleX;
    const sy = tr.scale * tr.scaleY * as.scale * as.scaleY;
    const rotationDeg = tr.rotation + as.rotation;
    const rot = (rotationDeg * Math.PI) / 180;
    const C = [W / 2 + tr.x + as.dx, H / 2 + tr.y + as.dy];
    const pivot = [mcx + (tr.anchorX - 0.5) * bw, mcy + (tr.anchorY - 0.5) * bh];
    return { rect: { x0, y0, x1, y1 }, uvRect: [l, tp, 1 - r, 1 - b], sx, sy, rot, rotationDeg, C, pivot, flip: [tr.flipX ? 1 : 0, tr.flipY ? 1 : 0] };
  }

  _matrix(L, rect) {
    const cs = Math.cos(L.rot), sn = Math.sin(L.rot);
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    const a00 = cs * L.sx * w, a10 = sn * L.sx * w, a01 = -sn * L.sy * h, a11 = cs * L.sy * h;
    const qx = (rect.x0 - L.pivot[0]) * L.sx, qy = (rect.y0 - L.pivot[1]) * L.sy;
    const bx = L.C[0] + L.pivot[0] + cs * qx - sn * qy;
    const by = L.C[1] + L.pivot[1] + sn * qx + cs * qy;
    const m = new Float32Array([a00, a10, 0, a01, a11, 0, bx, by, 1]);
    const P = (u, v) => [a00 * u + a01 * v + bx, a10 * u + a11 * v + by];
    return { m, corners: [P(0, 0), P(1, 0), P(1, 1), P(0, 1)] };
  }

  _coversCanvas(corners) {
    const { width: W, height: H } = this._settings();
    const pts = [[0.5, 0.5], [W - 0.5, 0.5], [W - 0.5, H - 0.5], [0.5, H - 0.5]];
    return pts.every(([x, y]) => pointInQuad(x, y, corners));
  }

  _mediaDims(clip) {
    const d = this._dims.get(clip.mediaId);
    if (d) return d;
    const m = this.project.media && this.project.media[clip.mediaId];
    if (m && m.width > 0 && m.height > 0) return [m.width, m.height];
    return null;
  }

  _baseRectMedia(clip, dims) {
    const { width: W, height: H } = this._settings();
    const fit = clip.fit || defaultFit(dims[0], dims[1], W, H);
    const [bw, bh] = fitSize(fit, dims[0], dims[1], W, H);
    return { x0: -bw / 2, y0: -bh / 2, x1: bw / 2, y1: bh / 2 };
  }

  _rasterInfo(clip, t) {
    const mod = this._text;
    if (!mod || typeof mod.rasterize !== 'function') return null;
    let res = null;
    try { res = mod.rasterize(clip, t, this.project, this.scale); } catch (e) { this._error(e); return null; }
    if (!res || !res.canvas) return null;
    const cv = res.canvas;
    const cw = cv.width, ch = cv.height;
    if (!(cw > 0) || !(ch > 0)) return null;
    let w = num(res.w, cw / this.scale), h = num(res.h, ch / this.scale);
    // tolerate a rasterizer that reports device pixels instead of canvas pixels
    if (Math.abs(this.scale - 1) > 1e-3 && Math.abs(w - cw) < 1.5 && Math.abs(h - ch) < 1.5) { w /= this.scale; h /= this.scale; }
    return { res, canvas: cv, cw, ch, w, h, cx: num(res.cx, 0), cy: num(res.cy, 0) };
  }

  /** Geometry without GPU work (hitTest/clipBounds). */
  _geometry(clip, t) {
    const localT = t - clip.start;
    const ev = this._eval(clip, localT);
    const as = this._anim(clip, localT);
    let base;
    if (MEDIA_TYPES.has(clip.type)) {
      const dims = this._mediaDims(clip) || [this._settings().width, this._settings().height];
      base = this._baseRectMedia(clip, dims);
    } else if (RASTER_TYPES.has(clip.type)) {
      const ri = this._rasterInfo(clip, t);
      if (!ri) return null;
      base = { x0: ri.cx - ri.w / 2, y0: ri.cy - ri.h / 2, x1: ri.cx + ri.w / 2, y1: ri.cy + ri.h / 2 };
    } else return null;
    const L = this._layout(clip, t, base, ev, as);
    const { corners } = this._matrix(L, L.rect);
    return { corners, w: Math.abs((L.rect.x1 - L.rect.x0) * L.sx), h: Math.abs((L.rect.y1 - L.rect.y0) * L.sy), rotationDeg: L.rotationDeg };
  }

  /* ------------------------------------------------------------------ internals: textures */

  _dropTex(key) {
    const e = this._tex.get(key);
    if (e) { try { this.gl.deleteTexture(e.tex); } catch (_) { /* ignore */ } this._tex.delete(key); }
  }

  _texEntry(key, clip) {
    let e = this._tex.get(key);
    if (!e) {
      e = { tex: createTexture(this.gl), w: 0, h: 0, src: null, ver: undefined, used: 0, clipId: clip ? clip.id : null, mediaId: clip ? clip.mediaId : null, mip: false };
      this._tex.set(key, e);
    }
    e.used = this._frame;
    return e;
  }

  _upload(e, src, w, h, mip) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch (err) {
      this._error(err);
      return false;
    }
    if (mip) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    e.w = w; e.h = h; e.src = src; e.mip = mip;
    return true;
  }

  _mediaTexture(clip, src, exact) {
    const isImage = clip.type === 'image';
    const key = (isImage ? 'img:' : 'vid:') + (isImage ? clip.mediaId : clip.id);
    const stale = () => {
      const e = this._tex.get(key);
      if (!exact && e && e.w > 0 && e.mediaId === clip.mediaId) { e.used = this._frame; return e; }
      return null;
    };
    if (!src) return stale();
    const video = isVideoEl(src);
    if (video && src.readyState < 2) return stale();
    const w = video ? src.videoWidth : (src.width || src.naturalWidth || 0);
    const h = video ? src.videoHeight : (src.height || src.naturalHeight || 0);
    if (!w || !h) return stale();
    const e = this._texEntry(key, isImage ? null : clip);
    e.mediaId = clip.mediaId;
    const dispW = num(src._fsW, w), dispH = num(src._fsH, h);
    this._dims.set(clip.mediaId, [dispW, dispH]);
    const ver = src._fsVersion;
    const need = video || e.src !== src || e.w !== w || e.h !== h || (ver !== undefined ? ver !== e.ver : isCanvasLike(src));
    if (need) {
      if (!this._upload(e, src, w, h, !video && !isCanvasLike(src))) return stale();
      e.ver = ver;
    }
    e.dispW = dispW; e.dispH = dispH;
    return e;
  }

  _rasterTexture(clip, ri) {
    const key = 'txt:' + clip.id;
    const e = this._texEntry(key, clip);
    const ver = ri.res.key !== undefined ? ri.res.key : (ri.res.version !== undefined ? ri.res.version : ri.canvas._fsVersion);
    const same = e.src === ri.canvas && e.res === ri.res && ver !== undefined && ver === e.ver && e.w === ri.cw && e.h === ri.ch;
    if (!same) {
      if (!this._upload(e, ri.canvas, ri.cw, ri.ch, false)) return null;
      e.ver = ver;
      e.res = ri.res;
    }
    return e;
  }

  _gcTextures() {
    if (this._frame % 120 !== 0) return;
    for (const [key, e] of this._tex) if (this._frame - e.used > 600) this._dropTex(key);
  }

  /* ------------------------------------------------------------------ internals: drawing */

  _draw(t, plan, srcMap, exact) {
    const gl = this.gl;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._frame++;
    this.stats.frame++;
    this.pool.tick();
    this._gcTextures();
    this._resize();
    const [RW, RH] = this._renderSize();
    const { fps, background } = this._settings();
    this._seed = Math.round(t * fps);
    if (this._final) { this.pool.release(this._final); this._final = null; }
    let comp = this.pool.acquire(RW, RH);
    const bg = parseColor(background, [0, 0, 0, 1]);
    this.pool.clear(comp, [bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]]);
    let layers = 0;
    for (const it of plan) {
      try {
        if (it.kind === 'clip') {
          const L = this._buildLayer(it.clip, t, srcMap, exact, null);
          if (L) { this._drawLayer(L, comp, it.clip.blend || 'normal', L.opacity); this._releaseLayer(L); layers++; }
        } else if (it.kind === 'transition') {
          this._drawTransitionItem(it.pair, t, srcMap, exact, comp);
          layers += 2;
        } else if (it.kind === 'adjust') {
          comp = this._applyAdjust(it.clip, t, comp);
          layers++;
        }
      } catch (e) {
        this._error(e);
      }
    }
    // final blit (canvas is bottom-up → flip)
    const blit = getProgram(gl, 'blit', () => [QUAD_VS, BLIT_FS]);
    gl.disable(gl.BLEND);
    if (blit) drawQuad(gl, blit, null, { u_tex: comp.tex, u_flipY: 1 }, { width: this.canvas.width, height: this.canvas.height });
    this._final = comp;
    this.stats.layers = layers;
    this.stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  _releaseLayer(L) { if (L && L.own) this.pool.release(L.own); }

  /**
   * Build a drawable layer for a clip. animT overrides the clip-local time used for keyframes/animations
   * (transitions hold clips at their edges); effects always get the real local time.
   */
  _buildLayer(clip, t, srcMap, exact, animT) {
    const gl = this.gl;
    const { width: W, height: H } = this._settings();
    const localT = t - clip.start;
    const aT = animT != null ? animT : localT;
    const ev = this._eval(clip, aT);
    const as = this._anim(clip, aT);
    const opacity = clamp(ev.tr.opacity * as.opacity, 0, 1);
    if (opacity <= 0.0005) return null;

    let srcTex, texW, texH, base, isMedia = false;
    if (MEDIA_TYPES.has(clip.type)) {
      const e = this._mediaTexture(clip, srcMap.get(clip.id), exact);
      if (!e) return null;
      srcTex = e.tex; texW = e.w; texH = e.h;
      base = this._baseRectMedia(clip, [e.dispW || e.w, e.dispH || e.h]);
      isMedia = true;
    } else if (RASTER_TYPES.has(clip.type)) {
      const ri = this._rasterInfo(clip, t);
      if (!ri) return null;
      const e = this._rasterTexture(clip, ri);
      if (!e) return null;
      srcTex = e.tex; texW = ri.cw; texH = ri.ch;
      base = { x0: ri.cx - ri.w / 2, y0: ri.cy - ri.h / 2, x1: ri.cx + ri.w / 2, y1: ri.cy + ri.h / 2 };
    } else return null;

    const Lg = this._layout(clip, t, base, ev, as);
    const plain = this._matrix(Lg, Lg.rect);
    const covers = isMedia && this._coversCanvas(plain.corners);

    const color = ev.color;
    const colorOn = colorIsActive(color);
    const filterDef = clip.filter && clip.filter.id && clip.filter.id !== 'none' ? getFilter(clip.filter.id) : null;
    const filterOn = !!filterDef && ev.filterAmount > 0.001;
    const lut = clip.lut && clip.lut.file && ev.lutAmount > 0.001 ? this._getLut(clip.lut.file) : null;
    const chroma = clip.chroma && clip.chroma.enabled ? clip.chroma : null;
    const effects = (ev.effects || []).filter((fx) => fx && fx.enabled !== false && getEffect(fx.id));
    const mask = maskIsActive(ev.mask) ? ev.mask : null;
    const blurR = as.blur > 0.25 ? as.blur : 0;
    const glitch = as.glitch > 0.002 ? as.glitch : 0;
    const needProc = colorOn || filterOn || !!lut || !!chroma || effects.length > 0 || !!mask || blurR > 0 || glitch > 0;

    const layer = { tex: srcTex, own: null, uvRect: Lg.uvRect, flip: Lg.flip, matrix: plain.m, opacity, covers };
    if (!needProc) return layer;

    // processing resolution: cropped region at its on-screen size (never above the source resolution)
    const cropWc = Math.abs(Lg.rect.x1 - Lg.rect.x0), cropHc = Math.abs(Lg.rect.y1 - Lg.rect.y0);
    const srcCropW = texW * (Lg.uvRect[2] - Lg.uvRect[0]), srcCropH = texH * (Lg.uvRect[3] - Lg.uvRect[1]);
    const boost = clamp(Math.abs(num(clip.transform && clip.transform.scale, 1)), 1, 4);
    const maxDim = this._maxTex;
    let pw = Math.max(1, Math.min(srcCropW, cropWc * this.scale * boost * Math.max(1, Math.abs(num(clip.transform && clip.transform.scaleX, 1)))));
    let ph = Math.max(1, Math.min(srcCropH, cropHc * this.scale * boost * Math.max(1, Math.abs(num(clip.transform && clip.transform.scaleY, 1)))));
    if (pw > maxDim || ph > maxDim) { const k = maxDim / Math.max(pw, ph); pw *= k; ph *= k; }
    pw = Math.max(1, Math.round(pw)); ph = Math.max(1, Math.round(ph));
    const pxScale = pw / Math.max(1e-6, cropWc);

    let padC = 0;
    if (!covers) {
      for (const fx of effects) padC = Math.max(padC, effectPadding(fx.id, fx.params, cropWc, cropHc));
      if (blurR) padC = Math.max(padC, blurR * 1.3);
      if (glitch) padC = Math.max(padC, cropWc * 0.05);
    }
    const padX = Math.min(2048, Math.ceil(padC * pxScale));
    const padY = Math.min(2048, Math.ceil(padC * (ph / Math.max(1e-6, cropHc))));
    const fullW = pw + 2 * padX, fullH = ph + 2 * padY;
    const inner = [padX / fullW, padY / fullH, 1 - padX / fullW, 1 - padY / fullH];

    let cur = this.pool.acquire(fullW, fullH);
    applyColor(gl, { tex: srcTex, w: texW, h: texH }, cur, {
      uvRect: Lg.uvRect, inner, color: colorOn ? color : null,
      filterDef: filterOn ? filterDef : null, filter: { amount: ev.filterAmount },
      lut, lutAmount: ev.lutAmount, chroma, seed: this._seed,
    });
    const ctx = { pool: this.pool, pxScale, progress: clip.duration > 0 ? clamp(localT / clip.duration, 0, 1) : 0, duration: clip.duration || 0, seed: this._seed, edge: covers ? 1 : 0, inner };
    for (const fx of effects) {
      const out = applyEffect(gl, fx.id, cur, fx.params, localT, ctx);
      if (out) { this.pool.release(cur); cur = out; }
    }
    if (mask) {
      const out = this.pool.acquire(fullW, fullH);
      if (applyMask(gl, cur, out, mask, inner)) { this.pool.release(cur); cur = out; } else this.pool.release(out);
    }
    if (blurR) {
      const out = applyEffect(gl, 'blur', cur, { radius: blurR }, localT, ctx);
      if (out) { this.pool.release(cur); cur = out; }
    }
    if (glitch) {
      const out = applyEffect(gl, 'glitch', cur, { intensity: glitch, speed: 18, blocks: 22 }, aT, ctx);
      if (out) { this.pool.release(cur); cur = out; }
    }

    // padded quad (same transform, rect grown by the padding)
    const pxX = padX / pxScale, pxY = padY / (ph / Math.max(1e-6, cropHc));
    const r0 = Lg.rect;
    const sxSign = r0.x1 >= r0.x0 ? 1 : -1, sySign = r0.y1 >= r0.y0 ? 1 : -1;
    const prect = { x0: r0.x0 - pxX * sxSign, x1: r0.x1 + pxX * sxSign, y0: r0.y0 - pxY * sySign, y1: r0.y1 + pxY * sySign };
    const pm = this._matrix(Lg, prect);
    layer.tex = cur.tex;
    layer.own = cur;
    layer.uvRect = [0, 0, 1, 1];
    layer.matrix = pm.m;
    return layer;
  }

  _blitCopy(src, dst) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fb);
    gl.blitFramebuffer(0, 0, src.w, src.h, 0, 0, dst.w, dst.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  _drawLayer(L, target, blend, opacity) {
    const gl = this.gl;
    const prog = getProgram(gl, 'layer', () => [LAYER_VS, LAYER_FS]);
    if (!prog) return;
    const mode = BLEND_IDS[blend] != null ? BLEND_IDS[blend] : 0;
    let backdrop = null;
    if (mode !== 0 && mode !== 4) {
      backdrop = this.pool.acquire(target.w, target.h);
      this._blitCopy(target, backdrop);
    }
    if (mode === 0) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else if (mode === 4) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE); }
    else gl.disable(gl.BLEND);
    const { width: W, height: H } = this._settings();
    drawQuad(gl, prog, target, {
      u_model: L.matrix, u_canvas: [W, H], u_uvRect: L.uvRect, u_flip: L.flip,
      u_tex: L.tex, u_backdrop: backdrop ? backdrop.tex : null,
      u_opacity: opacity, u_blend: mode, u_aa: 1,
    });
    gl.disable(gl.BLEND);
    if (backdrop) this.pool.release(backdrop);
  }

  _drawTransitionItem(pr, t, srcMap, exact, comp) {
    const gl = this.gl;
    const [RW, RH] = this._renderSize();
    const { width: W, height: H } = this._settings();
    const fa = this.pool.acquire(RW, RH);
    const fb = this.pool.acquire(RW, RH);
    this.pool.clear(fa); this.pool.clear(fb);
    const aDur = pr.a.duration || 0;
    const aAnimT = clamp(t - pr.a.start, 0, Math.max(0, aDur - 1e-4));
    const bAnimT = Math.max(0, t - pr.b.start);
    const LA = this._buildLayer(pr.a, t, srcMap, exact, aAnimT);
    const LB = this._buildLayer(pr.b, t, srcMap, exact, bAnimT);
    if (LA) { this._drawLayer(LA, fa, 'normal', LA.opacity); this._releaseLayer(LA); }
    if (LB) { this._drawLayer(LB, fb, 'normal', LB.opacity); this._releaseLayer(LB); }
    const p = clamp((t - pr.t0) / Math.max(1e-6, pr.t1 - pr.t0), 0, 1);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const ok = drawTransition(gl, pr.id, fa, fb, p, pr.params, RW, RH, { target: comp, edge: !!(LA && LB && LA.covers && LB.covers), ratio: W / H, res: [W, H] });
    if (!ok) {
      // emergency fallback: plain cut at the middle
      const L = p < 0.5 ? fa : fb;
      const prog = getProgram(gl, 'layer', () => [LAYER_VS, LAYER_FS]);
      if (prog) {
        drawQuad(gl, prog, comp, { u_model: new Float32Array([W, 0, 0, 0, H, 0, 0, 0, 1]), u_canvas: [W, H], u_uvRect: [0, 0, 1, 1], u_flip: [0, 0], u_tex: L.tex, u_backdrop: null, u_opacity: 1, u_blend: 0, u_aa: 0 });
      }
    }
    gl.disable(gl.BLEND);
    this.pool.release(fa);
    this.pool.release(fb);
  }

  _applyAdjust(clip, t, comp) {
    const gl = this.gl;
    const localT = t - clip.start;
    const ev = this._eval(clip, localT);
    const as = this._anim(clip, localT);
    const amount = clamp(ev.tr.opacity * as.opacity, 0, 1);
    if (amount <= 0.001) return comp;
    const ctx = { pool: this.pool, pxScale: this.scale, progress: clip.duration > 0 ? clamp(localT / clip.duration, 0, 1) : 0, duration: clip.duration || 0, seed: this._seed, edge: 1, inner: [0, 0, 1, 1] };
    let cur = comp;
    const take = (out) => { if (!out) return; if (cur !== comp) this.pool.release(cur); cur = out; };
    if (clip.type === 'adjustment') {
      const color = ev.color;
      const colorOn = colorIsActive(color);
      const filterDef = clip.filter && clip.filter.id && clip.filter.id !== 'none' ? getFilter(clip.filter.id) : null;
      const filterOn = !!filterDef && ev.filterAmount > 0.001;
      const lut = clip.lut && clip.lut.file && ev.lutAmount > 0.001 ? this._getLut(clip.lut.file) : null;
      const chroma = clip.chroma && clip.chroma.enabled ? clip.chroma : null;
      if (colorOn || filterOn || lut || chroma) {
        const out = this.pool.acquire(comp.w, comp.h);
        applyColor(gl, comp, out, { color: colorOn ? color : null, filterDef: filterOn ? filterDef : null, filter: { amount: ev.filterAmount }, lut, lutAmount: ev.lutAmount, chroma, seed: this._seed });
        take(out);
      }
    }
    for (const fx of ev.effects || []) {
      if (!fx || fx.enabled === false || !getEffect(fx.id)) continue;
      take(applyEffect(gl, fx.id, cur, fx.params, localT, ctx));
    }
    if (as.blur > 0.25) take(applyEffect(gl, 'blur', cur, { radius: as.blur }, localT, ctx));
    if (as.glitch > 0.002) take(applyEffect(gl, 'glitch', cur, { intensity: as.glitch, speed: 18, blocks: 22 }, localT, ctx));
    if (cur === comp) return comp;
    const mask = maskIsActive(ev.mask) ? ev.mask : null;
    if (amount < 0.999 || mask) {
      const out = this.pool.acquire(comp.w, comp.h);
      applyMaskedMix(gl, comp, cur, out, amount, mask);
      take(out);
    }
    this.pool.release(comp);
    return cur;
  }
}

export default Compositor;
