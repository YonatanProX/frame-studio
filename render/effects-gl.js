// render/effects-gl.js — Frame Studio image-processing library for the WebGL2 compositor (agent R).
//
// Conventions shared by every shader in render/*:
//   * uv (0,0) is the TOP-LEFT of an image and v grows downward (canvas / video pixel order).
//     Uploaded images keep row 0 at t=0 (UNPACK_FLIP_Y=false) and every FBO pass maps v=0 to
//     framebuffer row 0, so all textures share the same orientation and readPixels is top-down.
//   * Every texture holds PREMULTIPLIED-alpha RGBA. Colour maths un-premultiplies, works on
//     straight colour and premultiplies again.
//   * Pixel-sized effect parameters are expressed in canvas pixels of the project (1080x1920 etc.)
//     at the layer's own (pre-transform) scale; shaders convert with cpx() using u_pxScale.
//   * All GLSL in this file is original Frame Studio code.
//
// This module must import cleanly in Node: no DOM / WebGL access at module top level.

/* =====================================================================================
 * Small WebGL2 toolkit (also used by transitions-gl.js and compositor.js)
 * ===================================================================================== */

const GLSTATE = new WeakMap();

function glState(gl) {
  let s = GLSTATE.get(gl);
  if (!s) {
    s = { programs: new Map(), failures: new Map(), quad: null, dummy2D: null, dummy3D: null };
    GLSTATE.set(gl, s);
  }
  return s;
}

/** Forget every cached GL object for this context (call after webglcontextrestored). */
export function resetGLCache(gl) { GLSTATE.delete(gl); }

/** Delete cached programs/buffers (call from Compositor.dispose()). */
export function disposeGLCache(gl) {
  const s = GLSTATE.get(gl);
  if (!s) return;
  try {
    if (!gl.isContextLost()) {
      for (const p of s.programs.values()) gl.deleteProgram(p.prog);
      if (s.quad) { gl.deleteBuffer(s.quad.buf); gl.deleteVertexArray(s.quad.vao); }
      if (s.dummy2D) gl.deleteTexture(s.dummy2D);
      if (s.dummy3D) gl.deleteTexture(s.dummy3D);
    }
  } catch (_) { /* context may be gone */ }
  GLSTATE.delete(gl);
}

export const QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
uniform float u_flipY;
out vec2 v_uv;
void main(){
  v_uv = a_pos;
  vec2 p = a_pos * 2.0 - 1.0;
  p.y = mix(p.y, -p.y, u_flipY);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

function compileShader(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) || 'unknown compile error';
    gl.deleteShader(sh);
    const lines = src.split('\n');
    const m = /ERROR:\s*\d+:(\d+)/.exec(log);
    const ctx = m ? `\n  > ${lines[(+m[1]) - 1] || ''}` : '';
    throw new Error(`${label} (${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}): ${log.trim()}${ctx}`);
  }
  return sh;
}

const SAMPLER_TYPES = new Set([0x8B5E /* SAMPLER_2D */, 0x8B5F /* SAMPLER_3D */]);

/** Compile + link and reflect uniforms. Throws Error with the GLSL log on failure. */
export function compileProgram(gl, vsSrc, fsSrc, label = 'program') {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, label);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, label);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'a_pos');
  gl.linkProgram(prog);
  gl.detachShader(prog, vs); gl.detachShader(prog, fs);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(prog) || 'unknown link error';
    gl.deleteProgram(prog);
    throw new Error(`${label} (link): ${log.trim()}`);
  }
  const uniforms = Object.create(null);
  const samplers = [];
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
    if (SAMPLER_TYPES.has(info.type)) samplers.push(name);
  }
  return { prog, uniforms, samplers, label };
}

/** Cached program by key. build() → [vertexSrc, fragmentSrc]. Returns null when compilation failed. */
export function getProgram(gl, key, build) {
  const s = glState(gl);
  const hit = s.programs.get(key);
  if (hit) return hit;
  if (s.failures.has(key)) return null;
  try {
    const [vs, fs] = build();
    const p = compileProgram(gl, vs, fs, key);
    s.programs.set(key, p);
    return p;
  } catch (e) {
    const msg = String((e && e.message) || e);
    s.failures.set(key, msg);
    if (typeof console !== 'undefined') console.warn('[Frame Studio] shader failed:', msg);
    return null;
  }
}

/** [{key, error}] of every program that failed to compile on this context. */
export function programFailures(gl) {
  const s = GLSTATE.get(gl);
  if (!s) return [];
  return [...s.failures.entries()].map(([key, error]) => ({ key, error }));
}

function quadVAO(gl) {
  const s = glState(gl);
  if (!s.quad) {
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    s.quad = { vao, buf };
  }
  return s.quad.vao;
}

function dummyTex(gl, three) {
  const s = glState(gl);
  if (three) {
    if (!s.dummy3D) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      s.dummy3D = t;
    }
    return s.dummy3D;
  }
  if (!s.dummy2D) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    s.dummy2D = t;
  }
  return s.dummy2D;
}

function setUniform(gl, u, v) {
  if (u.loc == null) return;
  switch (u.type) {
    case gl.FLOAT:
      if (u.size > 1) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, Number.isFinite(+v) ? +v : 0);
      break;
    case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
    case gl.INT: case gl.BOOL:
      if (u.size > 1) gl.uniform1iv(u.loc, v); else gl.uniform1i(u.loc, v | 0);
      break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
    case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
    default: break;
  }
}

/**
 * Draw a unit quad with `prog` into target ({fb,w,h}) or the default framebuffer (target=null,
 * opts.width/height). `uniforms` maps names to values; sampler uniforms take a WebGLTexture or
 * an {tex} object. Every sampler of the program always gets its own unit (unbound ones get a dummy).
 */
export function drawQuad(gl, prog, target, uniforms = {}, opts = {}) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
  const w = target ? target.w : opts.width;
  const h = target ? target.h : opts.height;
  if (opts.viewport) gl.viewport(opts.viewport[0], opts.viewport[1], opts.viewport[2], opts.viewport[3]);
  else gl.viewport(0, 0, w, h);
  gl.useProgram(prog.prog);
  let unit = 0;
  for (const name of prog.samplers) {
    const u = prog.uniforms[name];
    let t = uniforms[name];
    if (t && t.tex) t = t.tex;
    gl.activeTexture(gl.TEXTURE0 + unit);
    if (u.type === gl.SAMPLER_3D) gl.bindTexture(gl.TEXTURE_3D, t || dummyTex(gl, true));
    else gl.bindTexture(gl.TEXTURE_2D, t || dummyTex(gl, false));
    gl.uniform1i(u.loc, unit);
    unit++;
  }
  for (const k in uniforms) {
    const u = prog.uniforms[k];
    if (!u || SAMPLER_TYPES.has(u.type)) continue;
    setUniform(gl, u, uniforms[k]);
  }
  if (prog.uniforms.u_flipY && !('u_flipY' in uniforms)) gl.uniform1f(prog.uniforms.u_flipY.loc, 0);
  gl.bindVertexArray(quadVAO(gl));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

/** Create a 2D texture with sane parameters. */
export function createTexture(gl, { filter = 'linear', wrap = 'clamp' } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  const wr = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
  return t;
}

/** Pool of RGBA8 framebuffer+texture pairs keyed by size. */
export class FboPool {
  constructor(gl) {
    this.gl = gl;
    this.free = new Map();
    this.all = new Set();
    this.frame = 0;
  }
  acquire(w, h) {
    const gl = this.gl;
    w = Math.max(1, Math.min(8192, Math.round(w)));
    h = Math.max(1, Math.min(8192, Math.round(h)));
    const key = w + 'x' + h;
    const list = this.free.get(key);
    let f = list && list.pop();
    if (!f) {
      const tex = createTexture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      f = { fb, tex, w, h, key, inUse: false, last: 0 };
      this.all.add(f);
    }
    f.inUse = true;
    f.last = this.frame;
    return f;
  }
  release(f) {
    if (!f || !f.inUse) return;
    f.inUse = false;
    f.last = this.frame;
    let list = this.free.get(f.key);
    if (!list) this.free.set(f.key, (list = []));
    list.push(f);
  }
  clear(f, rgba = [0, 0, 0, 0]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.viewport(0, 0, f.w, f.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  /** Advance the frame counter; free buffers idle for a while. */
  tick() {
    this.frame++;
    if (this.frame % 90 !== 0) return;
    const gl = this.gl;
    for (const [key, list] of this.free) {
      const keep = [];
      for (const f of list) {
        if (this.frame - f.last > 180) {
          gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); this.all.delete(f);
        } else keep.push(f);
      }
      if (keep.length) this.free.set(key, keep); else this.free.delete(key);
    }
  }
  dispose() {
    const gl = this.gl;
    try {
      if (!gl.isContextLost()) for (const f of this.all) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    } catch (_) { /* ignore */ }
    this.all.clear(); this.free.clear();
  }
}

/* ---------------- colour helpers ---------------- */

const NAMED = { black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  yellow: [1, 1, 0], cyan: [0, 1, 1], magenta: [1, 0, 1], transparent: [0, 0, 0] };

/** Parse "#rgb" "#rrggbb" "#rrggbbaa" "rgb()/rgba()" names or [r,g,b(,a)] (0..1 or 0..255) → [r,g,b,a] in 0..1. */
export function parseColor(c, fallback = [0, 0, 0, 1]) {
  if (Array.isArray(c)) {
    const big = c.some((x) => x > 1);
    const k = big ? 1 / 255 : 1;
    return [(+c[0] || 0) * k, (+c[1] || 0) * k, (+c[2] || 0) * k, c.length > 3 ? (big ? (+c[3]) / (c[3] > 1 ? 255 : 1) : +c[3]) : 1];
  }
  if (typeof c !== 'string') return fallback.slice();
  const s = c.trim().toLowerCase();
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return fallback.slice();
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)));
    const a = p.length > 3 ? (String(m[1]).includes('%') && p[3] > 1 ? p[3] / 255 : p[3]) : 1;
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1];
  }
  if (NAMED[s]) return [...NAMED[s], s === 'transparent' ? 0 : 1];
  return fallback.slice();
}

const rgb3 = (c, fb) => parseColor(c, fb).slice(0, 3);

/* =====================================================================================
 * Shared GLSL snippets
 * ===================================================================================== */

export const GLSL_COMMON = `
#define PI 3.14159265359
#define TAU 6.28318530718
uint fsMix(uint x){
  x ^= x >> 15u; x *= 0x2c1b3c6du;
  x ^= x >> 12u; x *= 0x297a2d39u;
  x ^= x >> 15u; return x;
}
float hash11(float p){ return float(fsMix(floatBitsToUint(p) + 0x51ed27u) >> 8u) * (1.0 / 16777216.0); }
float hash12(vec2 p){
  uvec2 q = floatBitsToUint(p + 0.0);
  return float(fsMix(q.x ^ fsMix(q.y + 0x9e3779b9u)) >> 8u) * (1.0 / 16777216.0);
}
vec2 hash22(vec2 p){
  uvec2 q = floatBitsToUint(p + 0.0);
  uint h1 = fsMix(q.x ^ fsMix(q.y + 0x9e3779b9u));
  uint h2 = fsMix(h1 + 0x85ebca6bu);
  return vec2(float(h1 >> 8u), float(h2 >> 8u)) * (1.0 / 16777216.0);
}
float vnoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = mat2(1.7, 1.05, -1.05, 1.7) * p + vec2(3.17, 1.93);
    a *= 0.5;
  }
  return s / 0.96875;
}
// smooth 1-D noise in [-1,1]
float noise1(float t, float seed){
  float i = floor(t);
  float f = fract(t);
  float a = hash12(vec2(i, seed));
  float b = hash12(vec2(i + 1.0, seed));
  return mix(a, b, f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
}
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c){
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-5) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, mx > 1e-5 ? d / mx : 0.0, mx);
}
float hsvChan(float n, vec3 c){
  float k = mod(n + c.x * 6.0, 6.0);
  return c.z - c.z * c.y * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
vec3 hsv2rgb(vec3 c){ return vec3(hsvChan(5.0, c), hsvChan(3.0, c), hsvChan(1.0, c)); }
mat2 rot2(float a){ float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
`;

/* =====================================================================================
 * Colour grading pass: crop/pad mapping + chroma key + colour + filter look + LUT
 * ===================================================================================== */

const GRADE_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform sampler3D u_lut;
uniform vec4 u_uvRect;
uniform vec4 u_inner;
uniform vec2 u_sharpStep;
uniform float u_seed;
uniform float u_ckOn; uniform vec3 u_ckColor; uniform vec3 u_ck;
uniform float u_colorOn; uniform vec4 u_c0; uniform vec4 u_c1; uniform vec4 u_c2; uniform vec2 u_c3;
uniform float u_filterOn; uniform float u_fAmt; uniform vec4 u_f0; uniform vec4 u_f1; uniform vec4 u_f2; uniform vec2 u_f3;
uniform vec3 u_lift; uniform vec3 u_gamma; uniform vec3 u_gain; uniform vec3 u_shTint; uniform vec3 u_hiTint; uniform vec4 u_look;
uniform float u_lutOn; uniform float u_lutSize; uniform float u_lutAmt; uniform vec3 u_lutMin; uniform vec3 u_lutMax;
${GLSL_COMMON}
vec2 toCbCr(vec3 c){ return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b); }
vec3 fromYCbCr(float y, vec2 cc){ return vec3(y + 1.402 * cc.y, y - 0.344136 * cc.x - 0.714136 * cc.y, y + 1.772 * cc.x); }
vec3 hueRotate(vec3 c, float deg){
  float a = radians(deg);
  float cs = cos(a);
  float sn = sin(a);
  vec3 k = vec3(0.57735027);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}
vec3 toLin(vec3 c){ return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 toGam(vec3 c){ return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
vec3 gradeColor(vec3 c, vec4 A, vec4 B, vec4 C, vec2 D, vec2 luv){
  float exposure = A.x; float brightness = A.y; float contrast = A.z; float saturation = A.w;
  float vibrance = B.x; float temperature = B.y; float tint = B.z; float highlights = B.w;
  float shadows = C.x; float hue = C.y; float vignette = C.z;
  float grain = D.x; float fade = D.y;
  // exposure + white balance in linear light
  vec3 l = toLin(c);
  l *= exp2(exposure * 2.0);
  l *= vec3(1.0 + temperature * 0.32 + tint * 0.07, 1.0 + temperature * 0.03 - tint * 0.2, 1.0 - temperature * 0.34 + tint * 0.07);
  c = toGam(l);
  // contrast around mid grey
  float k = contrast >= 0.0 ? 1.0 + contrast * 1.35 : 1.0 + contrast * 0.8;
  c = (c - 0.5) * k + 0.5;
  c = max(c, vec3(0.0));
  // brightness as a mid-tone curve
  if (abs(brightness) > 1e-4) c = pow(c, vec3(exp2(-brightness * 0.95)));
  // highlights / shadows recovery
  float L = luma(c);
  float hm = smoothstep(0.45, 1.0, L);
  float sm = 1.0 - smoothstep(0.0, 0.55, L);
  c += highlights * 0.4 * hm * mix(c, 1.0 - c, step(0.0, highlights));
  c += shadows * 0.45 * sm * mix(c, 1.0 - c, step(0.0, shadows));
  // saturation / vibrance
  L = luma(c);
  c = mix(vec3(L), c, 1.0 + saturation);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = clamp(mx - mn, 0.0, 1.0);
  c = mix(vec3(L), c, 1.0 + vibrance * (1.0 - sat) * 1.3);
  if (abs(hue) > 0.01) c = hueRotate(c, hue);
  // fade (matte) / crush
  if (fade > 0.0) c = mix(c, c * 0.8 + 0.14, fade);
  else if (fade < 0.0) c = mix(c, c * c * (3.0 - 2.0 * clamp(c, 0.0, 1.0)), -fade);
  // vignette (layer space)
  vec2 q = luv - 0.5;
  float vd = length(q) * 1.41421;
  float vm = smoothstep(0.32, 1.05, vd);
  if (vignette > 0.0) c *= 1.0 - vignette * vm * 0.85;
  else if (vignette < 0.0) c = mix(c, vec3(1.0), -vignette * vm * 0.75);
  // grain (deterministic per frame)
  if (abs(grain) > 0.001) {
    float n = hash12(floor(gl_FragCoord.xy) + vec2(u_seed * 7.13, u_seed * 3.71)) - 0.5;
    float w = clamp(1.15 - abs(luma(c) - 0.45) * 1.5, 0.25, 1.0);
    c += n * abs(grain) * 0.22 * w;
  }
  return clamp(c, 0.0, 1.0);
}
vec3 look(vec3 c){
  c = c * u_gain + u_lift * (1.0 - c);
  c = pow(max(c, vec3(0.0)), 1.0 / max(u_gamma, vec3(0.05)));
  float L = luma(c);
  float tAmt = u_look.x;
  if (tAmt > 0.0) {
    c += (u_shTint - vec3(luma(u_shTint))) * (1.0 - L) * tAmt;
    c += (u_hiTint - vec3(luma(u_hiTint))) * L * tAmt;
  }
  if (u_look.y > 0.0) c = mix(c, vec3(luma(c)), u_look.y);
  if (u_look.z > 0.0) {
    float g = luma(c);
    vec3 ov = mix(2.0 * c * g, 1.0 - 2.0 * (1.0 - c) * (1.0 - g), step(0.5, g));
    c = mix(c, mix(vec3(g), ov, 0.55), u_look.z);
  }
  float cv = u_look.w;
  vec3 cc = clamp(c, 0.0, 1.0);
  vec3 sCurve = cc * cc * (3.0 - 2.0 * cc);
  if (cv > 0.0) c = mix(c, sCurve, cv);
  else if (cv < 0.0) c = mix(c, cc + (cc - sCurve), -cv);
  return clamp(c, 0.0, 1.0);
}
void main(){
  vec2 luv = (v_uv - u_inner.xy) / (u_inner.zw - u_inner.xy);
  if (luv.x < 0.0 || luv.y < 0.0 || luv.x > 1.0 || luv.y > 1.0) { fragColor = vec4(0.0); return; }
  vec2 suv = mix(u_uvRect.xy, u_uvRect.zw, luv);
  vec4 c = texture(u_tex, suv);
  float sharp = u_colorOn * u_c2.w;
  if (abs(sharp) > 0.001) {
    vec4 n = texture(u_tex, suv + vec2(u_sharpStep.x, 0.0)) + texture(u_tex, suv - vec2(u_sharpStep.x, 0.0))
           + texture(u_tex, suv + vec2(0.0, u_sharpStep.y)) + texture(u_tex, suv - vec2(0.0, u_sharpStep.y));
    if (sharp > 0.0) c = c + (c - n * 0.25) * sharp * 1.8;
    else c = mix(c, (c + n) * 0.2, -sharp);
    c = clamp(c, 0.0, 1.0);
    c.rgb = min(c.rgb, vec3(c.a));
  }
  float a = c.a;
  if (a <= 0.0005) { fragColor = vec4(0.0); return; }
  vec3 rgb = c.rgb / a;
  if (u_ckOn > 0.5) {
    vec2 kc = toCbCr(u_ckColor);
    vec2 pc = toCbCr(rgb);
    float d = distance(pc, kc);
    float sim = u_ck.x * 0.5;
    float sm = max(u_ck.y * 0.6, 0.002);
    a *= smoothstep(sim, sim + sm, d);
    float kl = length(kc);
    if (kl > 0.001 && u_ck.z > 0.0) {
      vec2 kd = kc / kl;
      float s = max(0.0, dot(pc, kd));
      vec2 npc = pc - kd * s * clamp(u_ck.z, 0.0, 1.0);
      float y = dot(rgb, vec3(0.299, 0.587, 0.114));
      rgb = clamp(fromYCbCr(y, npc), 0.0, 1.0);
    }
  }
  if (u_colorOn > 0.5) rgb = gradeColor(rgb, u_c0, u_c1, u_c2, u_c3, luv);
  if (u_filterOn > 0.5) {
    vec3 f = gradeColor(rgb, u_f0, u_f1, u_f2, u_f3, luv);
    f = look(f);
    rgb = mix(rgb, f, u_fAmt);
  }
  if (u_lutOn > 0.5) {
    vec3 x = clamp((rgb - u_lutMin) / max(u_lutMax - u_lutMin, vec3(1e-5)), 0.0, 1.0);
    vec3 coord = x * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
    vec3 lc = texture(u_lut, coord).rgb;
    rgb = mix(rgb, lc, u_lutAmt);
  }
  rgb = clamp(rgb, 0.0, 1.0);
  fragColor = vec4(rgb * a, a);
}`;

export const COLOR_KEYS = ['exposure', 'brightness', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint',
  'highlights', 'shadows', 'hue', 'vignette', 'sharpen', 'grain', 'fade'];

function colorVecs(c) {
  const g = (k) => { const v = c ? Number(c[k]) : 0; return Number.isFinite(v) ? v : 0; };
  return [
    [g('exposure'), g('brightness'), g('contrast'), g('saturation')],
    [g('vibrance'), g('temperature'), g('tint'), g('highlights')],
    [g('shadows'), g('hue'), g('vignette'), g('sharpen')],
    [g('grain'), g('fade')],
  ];
}

/** True when any colour parameter differs from neutral. */
export function colorIsActive(c) {
  if (!c) return false;
  for (const k of COLOR_KEYS) { const v = Number(c[k]); if (Number.isFinite(v) && Math.abs(v) > 1e-4) return true; }
  return false;
}

const NEUTRAL_LOOK = { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], shadowTint: null, highlightTint: null,
  tintAmount: 0, mono: 0, bleach: 0, curve: 0 };

/**
 * Colour grade one layer. src = {tex, w, h} (source texture & its pixel size), dst = {fb, w, h}.
 * opts: { uvRect:[x0,y0,x1,y1] source region (crop), inner:[x0,y0,x1,y1] content rect inside dst (padding),
 *         color:{…14 params}, filter:{id, amount} | filterDef, lut:{tex,size,min,max} + lutAmount,
 *         chroma:{enabled,color,similarity,smoothness,spill}, seed }
 */
export function applyColor(gl, src, dst, opts = {}) {
  const prog = getProgram(gl, 'grade', () => [QUAD_VS, GRADE_FS]);
  if (!prog) return false;
  const uvRect = opts.uvRect || [0, 0, 1, 1];
  const inner = opts.inner || [0, 0, 1, 1];
  const color = opts.color || null;
  const fdef = opts.filterDef || (opts.filter && opts.filter.id ? FILTER_MAP.get(opts.filter.id) : null);
  const famt = opts.filter && opts.filter.amount != null ? Number(opts.filter.amount) : 1;
  const filterOn = !!fdef && famt > 0.001;
  const lk = Object.assign({}, NEUTRAL_LOOK, fdef && fdef.look);
  const ck = opts.chroma && opts.chroma.enabled ? opts.chroma : null;
  const lut = opts.lut && opts.lut.tex ? opts.lut : null;
  const lutAmt = opts.lutAmount != null ? Number(opts.lutAmount) : 1;
  const cv = colorVecs(color);
  const fv = colorVecs(fdef ? fdef.color : null);
  // one destination pixel expressed in source uv, at least one source texel
  const innerW = Math.max(1, (inner[2] - inner[0]) * dst.w);
  const innerH = Math.max(1, (inner[3] - inner[1]) * dst.h);
  const stepX = Math.max(1 / Math.max(1, src.w), (uvRect[2] - uvRect[0]) / innerW);
  const stepY = Math.max(1 / Math.max(1, src.h), (uvRect[3] - uvRect[1]) / innerH);
  const ckc = ck ? rgb3(ck.color || '#00ff00') : [0, 1, 0];
  drawQuad(gl, prog, dst, {
    u_tex: src.tex,
    u_lut: lut ? lut.tex : null,
    u_uvRect: uvRect,
    u_inner: inner,
    u_sharpStep: [stepX, stepY],
    u_seed: opts.seed || 0,
    u_ckOn: ck ? 1 : 0,
    u_ckColor: ckc,
    u_ck: ck ? [num(ck.similarity, 0.35), num(ck.smoothness, 0.08), num(ck.spill, 0.5)] : [0.35, 0.08, 0.5],
    u_colorOn: colorIsActive(color) ? 1 : 0,
    u_c0: cv[0], u_c1: cv[1], u_c2: cv[2], u_c3: cv[3],
    u_filterOn: filterOn ? 1 : 0,
    u_fAmt: Math.max(0, Math.min(1, famt)),
    u_f0: fv[0], u_f1: fv[1], u_f2: [fv[2][0], fv[2][1], fv[2][2], 0], u_f3: fv[3],
    u_lift: lk.lift, u_gamma: lk.gamma, u_gain: lk.gain,
    u_shTint: lk.shadowTint ? rgb3(lk.shadowTint) : [0.5, 0.5, 0.5],
    u_hiTint: lk.highlightTint ? rgb3(lk.highlightTint) : [0.5, 0.5, 0.5],
    u_look: [num(lk.tintAmount, 0), num(lk.mono, 0), num(lk.bleach, 0), num(lk.curve, 0)],
    u_lutOn: lut && lutAmt > 0.001 ? 1 : 0,
    u_lutSize: lut ? lut.size : 2,
    u_lutAmt: Math.max(0, Math.min(1, lutAmt)),
    u_lutMin: lut ? lut.min : [0, 0, 0],
    u_lutMax: lut ? lut.max : [1, 1, 1],
  });
  return true;
}

/** Chroma key only (same pass, colour/filter/LUT disabled). */
export function applyChroma(gl, src, dst, chroma, opts = {}) {
  return applyColor(gl, src, dst, Object.assign({}, opts, { chroma: Object.assign({ enabled: true }, chroma), color: null, filter: null, lut: null }));
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/* =====================================================================================
 * Mask pass (rect / ellipse / linear / mirror, feather, invert) and masked mixing
 * ===================================================================================== */

const MASK_GLSL = `
uniform vec4 u_inner;
uniform vec2 u_size;
uniform float u_mType;
uniform vec2 u_mCenter;
uniform vec2 u_mHalf;
uniform float u_mRot;
uniform float u_mFeather;
uniform float u_mInvert;
float maskAt(vec2 uv){
  if (u_mType < 0.5) return 1.0;
  vec2 luv = (uv - u_inner.xy) / (u_inner.zw - u_inner.xy);
  vec2 p = (luv - u_mCenter) * u_size;
  float cs = cos(-u_mRot);
  float sn = sin(-u_mRot);
  p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  float f = max(u_mFeather, 0.75);
  float m = 1.0;
  int t = int(u_mType + 0.5);
  if (t == 1) {
    vec2 q = abs(p) - u_mHalf;
    float sd = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
    m = 1.0 - smoothstep(-f, f, sd);
  } else if (t == 2) {
    vec2 hh = max(u_mHalf, vec2(1.0));
    float k = length(p / hh);
    float sd = (k - 1.0) * min(hh.x, hh.y);
    m = 1.0 - smoothstep(-f, f, sd);
  } else if (t == 3) {
    m = 1.0 - smoothstep(-f, f, p.y);
  } else if (t == 4) {
    m = 1.0 - smoothstep(-f, f, abs(p.y) - u_mHalf.y);
  }
  return u_mInvert > 0.5 ? 1.0 - m : m;
}`;

const MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
${MASK_GLSL}
void main(){ fragColor = texture(u_tex, v_uv) * maskAt(v_uv); }`;

const MIX_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_amt;
${MASK_GLSL}
void main(){ fragColor = mix(texture(u_a, v_uv), texture(u_b, v_uv), clamp(u_amt * maskAt(v_uv), 0.0, 1.0)); }`;

const MASK_TYPES = { none: 0, rect: 1, ellipse: 2, linear: 3, mirror: 4 };

export function maskIsActive(mask) { return !!mask && MASK_TYPES[mask.type] > 0; }

function maskUniforms(mask, innerPx, inner) {
  const t = mask ? (MASK_TYPES[mask.type] || 0) : 0;
  const w = innerPx[0], h = innerPx[1];
  const mw = num(mask && mask.w, 0.6), mh = num(mask && mask.h, 0.6);
  return {
    u_inner: inner || [0, 0, 1, 1],
    u_size: [w, h],
    u_mType: t,
    u_mCenter: [0.5 + num(mask && mask.x, 0), 0.5 + num(mask && mask.y, 0)],
    u_mHalf: [Math.abs(mw) * w * 0.5, Math.abs(mh) * h * 0.5],
    u_mRot: (num(mask && mask.rotation, 0) * Math.PI) / 180,
    u_mFeather: Math.max(0, num(mask && mask.feather, 0.05)) * Math.min(w, h) * 0.5,
    u_mInvert: mask && mask.invert ? 1 : 0,
  };
}

/** Multiply src by the mask; src/dst {tex|fb,w,h}; inner = content rect in uv (padding aware). */
export function applyMask(gl, src, dst, mask, inner = [0, 0, 1, 1]) {
  const prog = getProgram(gl, 'mask', () => [QUAD_VS, MASK_FS]);
  if (!prog) return false;
  const innerPx = [(inner[2] - inner[0]) * src.w, (inner[3] - inner[1]) * src.h];
  drawQuad(gl, prog, dst, Object.assign({ u_tex: src.tex }, maskUniforms(mask, innerPx, inner)));
  return true;
}

/** dst = mix(a, b, amount * mask) — used for adjustment/effect clip opacity and masks. */
export function applyMaskedMix(gl, a, b, dst, amount, mask) {
  const prog = getProgram(gl, 'maskmix', () => [QUAD_VS, MIX_FS]);
  if (!prog) return false;
  drawQuad(gl, prog, dst, Object.assign({ u_a: a.tex, u_b: b.tex, u_amt: amount }, maskUniforms(mask, [dst.w, dst.h], [0, 0, 1, 1])));
  return true;
}

/* =====================================================================================
 * .cube LUT loading → 3D texture
 * ===================================================================================== */

/** Parse Adobe/Resolve .cube text (3D or 1D). Returns {size, data:Float32Array RGB, min, max, title}. */
export function parseCube(text) {
  const lines = String(text).split(/\r?\n/);
  let size3 = 0, size1 = 0, title = '';
  let min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size3 = parseInt(line.split(/\s+/)[1], 10) || 0; continue; }
    if (up.startsWith('LUT_1D_SIZE')) { size1 = parseInt(line.split(/\s+/)[1], 10) || 0; continue; }
    if (up.startsWith('DOMAIN_MIN')) { min = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { max = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('LUT_1D_INPUT_RANGE') || up.startsWith('LUT_3D_INPUT_RANGE')) {
      const p = line.split(/\s+/).slice(1, 3).map(Number);
      min = [p[0], p[0], p[0]]; max = [p[1], p[1], p[1]]; continue;
    }
    if (/^[A-Z_]/.test(up)) continue;
    const p = line.split(/\s+/);
    if (p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
  }
  if (size3 >= 2) {
    const n = size3 * size3 * size3 * 3;
    if (vals.length < n) throw new Error('קובץ LUT פגום: חסרים ערכים');
    return { size: size3, data: new Float32Array(vals.slice(0, n)), min, max, title };
  }
  if (size1 >= 2) {
    // expand a 1D curve into a 33^3 cube
    if (vals.length < size1 * 3) throw new Error('קובץ LUT פגום: חסרים ערכים');
    const N = 33;
    const data = new Float32Array(N * N * N * 3);
    const curve = (ch, x) => {
      const f = Math.max(0, Math.min(1, x)) * (size1 - 1);
      const i = Math.floor(f), j = Math.min(size1 - 1, i + 1), t = f - i;
      return vals[i * 3 + ch] * (1 - t) + vals[j * 3 + ch] * t;
    };
    let o = 0;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      data[o++] = curve(0, r / (N - 1)); data[o++] = curve(1, g / (N - 1)); data[o++] = curve(2, b / (N - 1));
    }
    return { size: N, data, min, max, title };
  }
  throw new Error('קובץ LUT לא נתמך (חסר LUT_3D_SIZE)');
}

/** Parse a .cube file and upload it as a 3D texture. Returns {tex, size, min, max, title}. */
export function loadCubeLut(gl, text) {
  const cube = parseCube(text);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  // WebGL2 rejects 3D uploads (INVALID_OPERATION) while FLIP_Y / PREMULTIPLY_ALPHA are on
  const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const prem = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, cube.size, cube.size, cube.size, 0, gl.RGB, gl.FLOAT, cube.data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!flip);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !!prem);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return { tex, size: cube.size, min: cube.min, max: cube.max, title: cube.title };
}

/* =====================================================================================
 * FILTERS — colour-look presets (colour params + optional "look" curve block)
 * ===================================================================================== */

export const FILTERS = [
  { id: 'natural', name: 'טבעי', category: 'טבעי', color: { contrast: 0.06, saturation: 0.06, vibrance: 0.12, highlights: -0.05, shadows: 0.05 } },
  { id: 'vivid', name: 'חי ותוסס', category: 'טבעי', color: { contrast: 0.14, saturation: 0.25, vibrance: 0.3, highlights: -0.05 } },
  { id: 'cleanSkin', name: 'עור נקי', category: 'טבעי', color: { highlights: 0.08, shadows: 0.12, contrast: -0.05, saturation: -0.06, temperature: 0.06, tint: 0.04, brightness: 0.04 }, look: { curve: -0.1 } },
  { id: 'summer', name: 'קיץ', category: 'טבעי', color: { temperature: 0.25, saturation: 0.18, vibrance: 0.22, brightness: 0.08, highlights: 0.08 } },
  { id: 'winter', name: 'חורף', category: 'טבעי', color: { temperature: -0.42, saturation: -0.15, brightness: 0.08, highlights: 0.12, tint: -0.05 }, look: { gain: [0.97, 1.0, 1.05] } },
  { id: 'warm', name: 'חמים', category: 'טבעי', color: { temperature: 0.35, tint: 0.05, saturation: 0.05 } },
  { id: 'cool', name: 'קריר', category: 'טבעי', color: { temperature: -0.35, tint: -0.03, saturation: 0.02 } },
  { id: 'golden', name: 'שעת זהב', category: 'טבעי', color: { temperature: 0.45, highlights: 0.12, saturation: 0.12, contrast: 0.06 }, look: { gain: [1.05, 1.0, 0.88], highlightTint: '#ffc45e', tintAmount: 0.25 } },
  { id: 'cinematic', name: 'קולנועי', category: 'קולנועי', color: { contrast: 0.16, saturation: -0.12, temperature: -0.04, fade: 0.08, highlights: -0.1 }, look: { shadowTint: '#1d6f7a', highlightTint: '#ffb070', tintAmount: 0.45, curve: 0.2 } },
  { id: 'tealOrange', name: 'טורקיז וכתום', category: 'קולנועי', color: { contrast: 0.15, saturation: 0.1, vibrance: 0.1 }, look: { shadowTint: '#0f7c8c', highlightTint: '#ff9440', tintAmount: 0.7, curve: 0.12 } },
  { id: 'dramatic', name: 'דרמטי', category: 'קולנועי', color: { contrast: 0.38, highlights: -0.3, shadows: -0.18, saturation: -0.15, vignette: 0.3 }, look: { curve: 0.25 } },
  { id: 'moody', name: 'אווירה קודרת', category: 'קולנועי', color: { exposure: -0.1, saturation: -0.3, contrast: 0.14, temperature: -0.15, fade: 0.12, shadows: -0.15 }, look: { shadowTint: '#2c4258', tintAmount: 0.3 } },
  { id: 'bleach', name: 'ביטול הלבנה', category: 'קולנועי', color: { saturation: -0.3, contrast: 0.22 }, look: { bleach: 0.75 } },
  { id: 'vintage', name: 'וינטג\'', category: 'רטרו', color: { fade: 0.32, saturation: -0.25, temperature: 0.2, contrast: -0.06, vignette: 0.2 }, look: { lift: [0.05, 0.03, 0.0], gain: [1.0, 0.96, 0.86] } },
  { id: 'fadeMatte', name: 'מט דהוי', category: 'רטרו', color: { fade: 0.5, contrast: -0.15, saturation: -0.1 } },
  { id: 'film', name: 'פילם', category: 'רטרו', color: { fade: 0.14, grain: 0.3, contrast: 0.1, saturation: -0.08 }, look: { curve: 0.15, gain: [1.02, 1.0, 0.95], shadowTint: '#28463c', tintAmount: 0.15 } },
  { id: 'retro80', name: 'רטרו שנות ה־80', category: 'רטרו', color: { saturation: 0.3, tint: 0.22, temperature: 0.1, fade: 0.2, contrast: 0.05 }, look: { shadowTint: '#5b2a86', highlightTint: '#ff7ab8', tintAmount: 0.45 } },
  { id: 'pastel', name: 'פסטל', category: 'רטרו', color: { saturation: -0.3, fade: 0.25, brightness: 0.12, contrast: -0.2, tint: 0.05 } },
  { id: 'sunset', name: 'שקיעה', category: 'צבעוני', color: { temperature: 0.5, tint: 0.15, saturation: 0.2, contrast: 0.08 }, look: { highlightTint: '#ff8a5c', shadowTint: '#5a2a6e', tintAmount: 0.4 } },
  { id: 'neonNight', name: 'לילה ניאון', category: 'צבעוני', color: { saturation: 0.35, contrast: 0.25, tint: 0.15, temperature: -0.25, shadows: -0.1 }, look: { shadowTint: '#3a1d8a', highlightTint: '#20e0ff', tintAmount: 0.6 } },
  { id: 'cyberpunk', name: 'סייברפאנק', category: 'צבעוני', color: { contrast: 0.3, saturation: 0.25, tint: 0.3, temperature: -0.15 }, look: { shadowTint: '#1a3cff', highlightTint: '#ff2fd1', tintAmount: 0.55, curve: 0.15 } },
  { id: 'forest', name: 'יער', category: 'צבעוני', color: { tint: -0.15, saturation: 0.1, contrast: 0.1, temperature: -0.05 }, look: { shadowTint: '#1f4d2c', highlightTint: '#e8f0a0', tintAmount: 0.35 } },
  { id: 'cyanNight', name: 'ציאן לילי', category: 'צבעוני', color: { temperature: -0.2, contrast: 0.18, saturation: 0.1, vibrance: 0.15, shadows: -0.08 }, look: { shadowTint: '#0a2a3a', highlightTint: '#5fd4e8', tintAmount: 0.45, lift: [0.0, 0.02, 0.04] } },
  { id: 'blackWhite', name: 'שחור־לבן', category: 'שחור־לבן', color: { saturation: -1, contrast: 0.1 } },
  { id: 'noir', name: 'נואר', category: 'שחור־לבן', color: { saturation: -1, contrast: 0.5, shadows: -0.3, vignette: 0.4 }, look: { curve: 0.4 } },
  { id: 'silver', name: 'כסוף', category: 'שחור־לבן', color: { saturation: -1, fade: 0.2, contrast: 0.12 }, look: { gain: [0.96, 1.0, 1.06] } },
  { id: 'sepia', name: 'ספיה', category: 'שחור־לבן', color: { saturation: -1, contrast: 0.05, fade: 0.08 }, look: { gain: [1.08, 0.9, 0.68], lift: [0.04, 0.02, 0.0] } },
];
const FILTER_MAP = new Map(FILTERS.map((f) => [f.id, f]));
export function getFilter(id) { return FILTER_MAP.get(id) || null; }

/* =====================================================================================
 * EFFECTS
 * ===================================================================================== */

const EFFECT_HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform sampler2D u_src;
uniform vec2 u_res;
uniform float u_pxScale;
uniform float u_time;
uniform float u_progress;
uniform float u_duration;
uniform float u_seed;
uniform float u_edge;
uniform vec4 u_inner;
${GLSL_COMMON}
bool outside(vec2 uv){ return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0; }
vec4 tex(vec2 uv){
  if (u_edge > 0.5) return texture(u_tex, clamp(uv, vec2(0.0), vec2(1.0)));
  return outside(uv) ? vec4(0.0) : texture(u_tex, uv);
}
vec4 texT(vec2 uv){ return outside(uv) ? vec4(0.0) : texture(u_tex, uv); }
vec4 srcTex(vec2 uv){
  if (u_edge > 0.5) return texture(u_src, clamp(uv, vec2(0.0), vec2(1.0)));
  return outside(uv) ? vec4(0.0) : texture(u_src, uv);
}
vec3 unpremul(vec4 c){ return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
vec4 withRgb(vec4 c, vec3 rgb){ return vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a); }
float cpx(float canvasPx){ return canvasPx * u_pxScale; }
float aspect(){ return u_res.x / u_res.y; }
`;

/** Separable gaussian blur helper — tapFn is a GLSL function name returning vec4 for a uv. */
function gaussFn(name, tapFn) {
  return `
vec4 ${name}(vec2 uv, vec2 dir, float r){
  if (r < 0.35) return ${tapFn}(uv);
  float sigma = max(r / 3.0, 0.4);
  float stp = max(r / 10.0, 1.0);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -15; i <= 15; i++) {
    float x = float(i) * stp;
    if (abs(x) > r + stp) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += ${tapFn}(uv + dir * x / u_res) * w;
    ws += w;
  }
  return acc / max(ws, 1e-5);
}`;
}
const GAUSS = gaussFn('gaussBlur', 'tex');

const N = (key, name, min, max, def, step) => ({ key, name, type: 'number', min, max, default: def, step: step != null ? step : +((max - min) / 100).toPrecision(2) });
const C = (key, name, def) => ({ key, name, type: 'color', default: def });
const S = (key, name, options, def = 0) => ({ key, name, type: 'select', options, default: def });

const P_AT = N('at', 'התחלה (שנ׳)', 0, 30, 0, 0.01);

export const EFFECTS = [
  /* ---------------- טשטוש ---------------- */
  {
    id: 'blur', name: 'טשטוש', category: 'טשטוש', appliesTo: 'both',
    params: [N('radius', 'עוצמה', 0, 120, 14, 0.5)],
    pad: (p) => p.radius * 1.3,
    passes: [
      { glsl: `${GAUSS}\nvec4 effect(vec2 uv){ return gaussBlur(uv, vec2(1.0, 0.0), cpx(p_radius)); }` },
      { glsl: `${GAUSS}\nvec4 effect(vec2 uv){ return gaussBlur(uv, vec2(0.0, 1.0), cpx(p_radius)); }` },
    ],
  },
  {
    id: 'directionalBlur', name: 'טשטוש כיווני', category: 'טשטוש', appliesTo: 'both',
    params: [N('angle', 'זווית', 0, 360, 0, 1), N('length', 'אורך', 0, 300, 48, 1)],
    pad: (p) => p.length * 0.6,
    glsl: `
vec4 effect(vec2 uv){
  float L = cpx(p_length);
  if (L < 0.5) return tex(uv);
  float a = radians(p_angle);
  vec2 d = vec2(cos(a), sin(a)) * L / u_res;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i <= 32; i++) {
    float k = float(i) / 32.0 - 0.5;
    float w = 1.0 - abs(k);
    acc += tex(uv + d * k) * w;
    ws += w;
  }
  return acc / ws;
}`,
  },
  {
    id: 'zoomBlur', name: 'טשטוש זום', category: 'טשטוש', appliesTo: 'both',
    params: [N('strength', 'עוצמה', 0, 1, 0.3), N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 c = vec2(p_centerX, p_centerY);
  if (p_strength < 0.001) return tex(uv);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 32; i++) {
    float k = float(i) / 31.0;
    float w = 1.0 - k * 0.6;
    acc += tex(c + (uv - c) * (1.0 - p_strength * 0.6 * k)) * w;
    ws += w;
  }
  return acc / ws;
}`,
  },
  {
    id: 'radialBlur', name: 'טשטוש סיבובי', category: 'טשטוש', appliesTo: 'both',
    params: [N('angle', 'זווית', 0, 60, 10, 0.5), N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 c = vec2(p_centerX, p_centerY);
  float ang = radians(p_angle);
  vec2 asp = vec2(aspect(), 1.0);
  vec2 p = (uv - c) * asp;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 32; i++) {
    float k = float(i) / 31.0 - 0.5;
    vec2 q = rot2(ang * k) * p;
    float w = 1.0 - abs(k);
    acc += tex(c + q / asp) * w;
    ws += w;
  }
  return acc / ws;
}`,
  },
  {
    id: 'sharpen', name: 'חידוד', category: 'טשטוש', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 3, 1, 0.05), N('radius', 'רדיוס', 0.5, 4, 1, 0.1)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 o = max(cpx(p_radius), 0.75) / u_res;
  vec4 c = tex(uv);
  vec4 n = tex(uv + vec2(o.x, 0.0)) + tex(uv - vec2(o.x, 0.0)) + tex(uv + vec2(0.0, o.y)) + tex(uv - vec2(0.0, o.y));
  vec4 d = tex(uv + o) + tex(uv - o) + tex(uv + vec2(o.x, -o.y)) + tex(uv + vec2(-o.x, o.y));
  vec4 blur = (c * 4.0 + n * 2.0 + d) / 16.0;
  vec4 r = clamp(c + (c - blur) * p_amount * 2.0, 0.0, 1.0);
  r.a = c.a;
  r.rgb = min(r.rgb, vec3(r.a));
  return r;
}`,
  },
  /* ---------------- תנועה ---------------- */
  {
    id: 'shake', name: 'רעידת מצלמה', category: 'תנועה', appliesTo: 'both',
    params: [N('strength', 'עוצמה', 0, 100, 16, 1), N('speed', 'מהירות', 1, 40, 14, 0.5), N('rotation', 'סיבוב', 0, 15, 1.5, 0.1), N('zoom', 'הגדלה נגד שוליים', 1, 1.4, 1.08, 0.01)],
    pad: (p) => p.strength * 1.2,
    glsl: `
vec4 effect(vec2 uv){
  float t = u_time * p_speed;
  vec2 off = vec2(noise1(t, 3.0) + 0.5 * noise1(t * 2.3, 11.0), noise1(t, 7.0) + 0.5 * noise1(t * 2.1, 19.0)) / 1.5;
  off *= cpx(p_strength);
  float r = noise1(t * 0.8, 23.0) * radians(p_rotation);
  float z = mix(1.0, p_zoom, u_edge);
  vec2 p = (uv - 0.5) * u_res - off;
  p = rot2(-r) * p / z;
  return tex(p / u_res + 0.5);
}`,
  },
  {
    id: 'zoomPunch', name: 'זום פאנץ׳', category: 'תנועה', appliesTo: 'both',
    params: [N('strength', 'עוצמה', 0, 1, 0.28), N('time', 'משך (שנ׳)', 0.05, 2, 0.4, 0.01), P_AT],
    pad: (p, w, h) => p.strength * Math.max(w, h) * 0.5,
    glsl: `
vec4 effect(vec2 uv){
  float x = (u_time - p_at) / max(p_time, 0.01);
  float s = 1.0;
  if (x >= 0.0 && x <= 1.0) {
    float rise = smoothstep(0.0, 0.12, x);
    float y = max(x - 0.12, 0.0);
    float settle = exp(-5.5 * y) * cos(y * 10.0);
    s = 1.0 + p_strength * rise * settle * (1.0 - smoothstep(0.85, 1.0, x));
  }
  return tex(0.5 + (uv - 0.5) / max(s, 0.05));
}`,
  },
  {
    id: 'whip', name: 'פס תנועה (וויפ)', category: 'תנועה', appliesTo: 'both',
    params: [N('angle', 'זווית', 0, 360, 0, 1), N('strength', 'עוצמה', 0, 500, 180, 1), P_AT, N('duration', 'משך (שנ׳)', 0.05, 1.5, 0.35, 0.01)],
    pad: (p) => p.strength * 0.5,
    glsl: `
vec4 effect(vec2 uv){
  float x = (u_time - p_at) / max(p_duration, 0.01);
  if (x <= 0.0 || x >= 1.0) return tex(uv);
  float k = sin(PI * x);
  float L = cpx(p_strength) * k * k;
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 shift = dir * (x - 0.5) * L * 0.7;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i <= 24; i++) {
    float kk = float(i) / 24.0 - 0.5;
    float w = 1.0 - abs(kk) * 0.8;
    acc += tex(uv - (shift + dir * L * kk) / u_res) * w;
    ws += w;
  }
  return acc / ws;
}`,
  },
  {
    id: 'wave', name: 'גל', category: 'עיוות', appliesTo: 'both',
    params: [N('amplitude', 'משרעת', 0, 80, 14, 0.5), N('frequency', 'תדירות', 0.5, 30, 5, 0.1), N('speed', 'מהירות', -10, 10, 2, 0.1), S('direction', 'כיוון', ['אופקי', 'אנכי'], 0)],
    pad: (p) => p.amplitude,
    glsl: `
vec4 effect(vec2 uv){
  float A = cpx(p_amplitude);
  vec2 q = uv;
  if (p_direction < 0.5) q.x += sin(uv.y * p_frequency * TAU + u_time * p_speed) * A / u_res.x;
  else q.y += sin(uv.x * p_frequency * TAU + u_time * p_speed) * A / u_res.y;
  return tex(q);
}`,
  },
  /* ---------------- אור ---------------- */
  {
    id: 'flash', name: 'הבזק', category: 'אור', appliesTo: 'both',
    params: [N('intensity', 'עוצמה', 0, 1, 0.85), N('duration', 'משך (שנ׳)', 0.05, 2, 0.3, 0.01), P_AT, C('color', 'צבע', '#ffffff')],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float x = u_time - p_at;
  if (x < 0.0) return c;
  float f = smoothstep(0.0, 0.02, x) * pow(max(1.0 - x / max(p_duration, 0.01), 0.0), 2.0) * p_intensity;
  vec3 rgb = 1.0 - (1.0 - unpremul(c)) * (1.0 - p_color * f);
  return withRgb(c, rgb);
}`,
  },
  {
    id: 'strobe', name: 'סטרובוסקופ', category: 'אור', appliesTo: 'both',
    params: [N('rate', 'קצב (הרץ)', 1, 30, 8, 0.5), N('intensity', 'עוצמה', 0, 1, 0.75), N('duty', 'זמן דלוק', 0.1, 0.9, 0.5), C('color', 'צבע', '#ffffff')],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float on = step(fract(u_time * p_rate + 1e-4), p_duty);
  return withRgb(c, mix(unpremul(c), p_color, on * p_intensity));
}`,
  },
  {
    id: 'flicker', name: 'הבהוב', category: 'אור', appliesTo: 'both',
    params: [N('intensity', 'עוצמה', 0, 1, 0.45), N('speed', 'מהירות', 1, 30, 12, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float n = hash11(floor(u_time * p_speed) + 0.37);
  float m = 1.0 - p_intensity * smoothstep(0.35, 1.0, n);
  m *= 1.0 + 0.08 * p_intensity * noise1(u_time * 31.0, 5.0);
  return vec4(clamp(c.rgb * m, vec3(0.0), vec3(c.a)), c.a);
}`,
  },
  {
    id: 'lightLeak', name: 'דליפת אור', category: 'אור', appliesTo: 'both',
    params: [N('intensity', 'עוצמה', 0, 1, 0.65), N('speed', 'מהירות', 0, 2, 0.35), N('position', 'מיקום', 0, 1, 0.2), C('color', 'צבע', '#ff7a2a'), C('color2', 'צבע משני', '#ffd36b')],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float t = u_time * p_speed;
  vec2 p = uv * vec2(aspect(), 1.0);
  float n = fbm(p * 1.3 + vec2(t * 0.6, -t * 0.25));
  float n2 = fbm(p * 2.1 - vec2(t * 0.3, t * 0.5) + 7.0);
  vec2 focus = vec2(mix(0.05, 0.95, p_position) + 0.18 * sin(t * 0.7), 0.18 + 0.2 * cos(t * 0.5));
  float side = 1.0 - smoothstep(0.0, 1.15, length((uv - focus) * vec2(aspect(), 1.0)));
  float m = clamp(side * (0.55 + 0.9 * n) + 0.3 * n2 * n2 - 0.1, 0.0, 1.0) * p_intensity;
  vec3 leak = mix(p_color, p_color2, smoothstep(0.3, 0.8, n2));
  vec3 rgb = 1.0 - (1.0 - unpremul(c)) * (1.0 - leak * m);
  return withRgb(c, rgb);
}`,
  },
  ...['glow', 'bloom'].map((id) => ({
    id, name: id === 'glow' ? 'זוהר רך' : 'בלום (הילת אור)', category: 'אור', appliesTo: 'both',
    params: id === 'glow'
      ? [N('intensity', 'עוצמה', 0, 3, 0.9, 0.05), N('radius', 'רדיוס', 2, 100, 26, 1), N('threshold', 'סף בהירות', 0, 1, 0.25), C('color', 'גוון', '#ffffff')]
      : [N('intensity', 'עוצמה', 0, 3, 1.25, 0.05), N('radius', 'רדיוס', 2, 100, 34, 1), N('threshold', 'סף בהירות', 0, 1, 0.62), C('color', 'גוון', '#fff4e0')],
    pad: (p) => p.radius * 1.4,
    passes: [
      { glsl: `
vec4 brightTap(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  float l = max(r.r, max(r.g, r.b));
  float k = smoothstep(p_threshold, p_threshold + 0.22, l);
  return vec4(r * p_color, 1.0) * k * c.a;
}
${gaussFn('gaussBright', 'brightTap')}
vec4 effect(vec2 uv){ return gaussBright(uv, vec2(1.0, 0.0), cpx(p_radius)); }` },
      { glsl: `${GAUSS}\nvec4 effect(vec2 uv){ return gaussBlur(uv, vec2(0.0, 1.0), cpx(p_radius)); }` },
      { glsl: `
vec4 effect(vec2 uv){
  vec4 s = srcTex(uv);
  vec4 g = clamp(texT(uv) * p_intensity, 0.0, 1.0);
  return s + g - s * g;
}` },
    ],
  })),
  {
    id: 'shine', name: 'ברק חולף', category: 'אור', appliesTo: 'both',
    params: [N('angle', 'זווית', 0, 180, 25, 1), N('width', 'רוחב', 0.02, 0.5, 0.12), N('period', 'מחזור (שנ׳)', 0.3, 6, 1.8, 0.05), N('intensity', 'עוצמה', 0, 2, 0.9), C('color', 'צבע', '#ffffff'), N('delay', 'השהיה (שנ׳)', 0, 10, 0, 0.05)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float tt = u_time - p_delay;
  if (tt < 0.0) return c;
  float ph = fract(tt / max(p_period, 0.05));
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 p = (uv - 0.5) * vec2(aspect(), 1.0);
  float span = abs(dir.x) * aspect() * 0.5 + abs(dir.y) * 0.5;
  float s = clamp(ph / 0.6, 0.0, 1.0);
  float pos = mix(-span - p_width * 2.0, span + p_width * 2.0, s);
  float d = dot(p, dir) - pos;
  float band = exp(-d * d / max(p_width * p_width * 0.25, 1e-5)) * step(ph, 0.6);
  return withRgb(c, unpremul(c) + p_color * band * p_intensity);
}`,
  },
  {
    id: 'spotlight', name: 'זרקור', category: 'אור', appliesTo: 'both',
    params: [N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.45), N('radius', 'רדיוס', 0.05, 1, 0.35), N('softness', 'רכות', 0.01, 1, 0.25), N('dim', 'החשכה', 0, 1, 0.75)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float d = length((uv - vec2(p_centerX, p_centerY)) * vec2(aspect(), 1.0));
  float m = 1.0 - smoothstep(p_radius, p_radius + p_softness, d);
  return vec4(c.rgb * mix(1.0 - p_dim, 1.0, m), c.a);
}`,
  },
  {
    id: 'vignette', name: 'ויניטה', category: 'אור', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 0.55), N('size', 'גודל', 0, 1.2, 0.55), N('softness', 'רכות', 0.05, 1, 0.45), N('roundness', 'עגלגלות', 0, 1, 0.5), C('color', 'צבע', '#000000')],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec2 p = uv - 0.5;
  float asp = aspect();
  vec2 q = vec2(p.x * mix(1.0, asp, p_roundness), p.y);
  float n = mix(1.0, max(asp, 1.0), p_roundness);
  float d = length(q) * 2.0 / n;
  float m = smoothstep(p_size, p_size + p_softness, d) * p_amount;
  return withRgb(c, mix(unpremul(c), p_color, m));
}`,
  },
  /* ---------------- דיגיטלי ---------------- */
  {
    id: 'glitch', name: 'גליץ׳', category: 'דיגיטלי', appliesTo: 'both',
    params: [N('intensity', 'עוצמה', 0, 1, 0.55), N('speed', 'מהירות', 1, 30, 12, 0.5), N('blocks', 'פסים', 4, 80, 24, 1)],
    pad: () => 0,
    glsl: `
vec4 effect(vec2 uv){
  float I = p_intensity;
  if (I <= 0.001) return tex(uv);
  float tq = floor(u_time * p_speed);
  float burst = step(0.35, hash11(tq * 0.731 + 0.11));
  float row = floor(uv.y * p_blocks);
  float r1 = hash12(vec2(row, tq));
  float rowOn = step(1.0 - I * (0.25 + 0.5 * burst), r1);
  float shift = (hash12(vec2(row, tq + 17.0)) - 0.5) * 0.16 * I * rowOn;
  vec2 cell = floor(uv * vec2(p_blocks * 0.35, p_blocks));
  float rb = hash12(cell + vec2(tq * 3.1, 0.7));
  float blockOn = step(1.0 - I * 0.12 * (0.5 + burst), rb);
  vec2 q = uv + vec2(shift, 0.0) + blockOn * vec2((hash12(cell + 5.0) - 0.5) * 0.12, 0.0);
  float ca = (0.006 + 0.014 * burst) * I * (0.4 + hash11(tq + 3.0));
  vec4 cr = tex(q + vec2(ca, 0.0));
  vec4 cg = tex(q);
  vec4 cb = tex(q - vec2(ca, 0.0));
  vec4 o = vec4(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
  if (blockOn > 0.5 && hash12(cell + 9.0) > 0.55) o.rgb = vec3(o.a) - o.rgb;
  float line = step(0.985 - 0.02 * I, hash12(vec2(floor(uv.y * u_res.y * 0.5), tq)));
  o.rgb = mix(o.rgb, vec3(o.a), line * 0.6 * I);
  return o;
}`,
  },
  {
    id: 'rgbSplit', name: 'פיצול RGB', category: 'דיגיטלי', appliesTo: 'both',
    params: [N('amount', 'מרחק', 0, 80, 12, 0.5), N('angle', 'זווית', 0, 360, 0, 1), N('animate', 'תנועה', 0, 1, 0)],
    pad: (p) => p.amount * 1.5,
    glsl: `
vec4 effect(vec2 uv){
  float a = radians(p_angle) + p_animate * sin(u_time * 5.0) * 1.5;
  float amt = cpx(p_amount) * (1.0 + p_animate * 0.5 * sin(u_time * 7.3));
  vec2 d = vec2(cos(a), sin(a)) * amt / u_res;
  vec4 r = tex(uv + d);
  vec4 g = tex(uv);
  vec4 b = tex(uv - d);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`,
  },
  {
    id: 'chromaticAberration', name: 'סטייה כרומטית', category: 'דיגיטלי', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 40, 8, 0.5), N('falloff', 'ריכוז בשוליים', 0.5, 4, 1.5, 0.1)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 d = uv - 0.5;
  float k = pow(clamp(length(d * vec2(aspect(), 1.0)) * 1.4, 0.0, 1.5), p_falloff);
  vec2 off = normalize(d + 1e-6) * cpx(p_amount) * k / u_res;
  vec4 r = tex(uv + off);
  vec4 g = tex(uv);
  vec4 b = tex(uv - off);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`,
  },
  {
    id: 'pixelate', name: 'פיקסלים', category: 'דיגיטלי', appliesTo: 'both',
    params: [N('size', 'גודל פיקסל', 2, 150, 20, 1)],
    glsl: `
vec4 effect(vec2 uv){
  float s = max(cpx(p_size), 1.0);
  vec2 px = (uv - 0.5) * u_res;
  vec2 q = (floor(px / s) + 0.5) * s;
  return tex(q / u_res + 0.5);
}`,
  },
  {
    id: 'mosaicBlocks', name: 'פסיפס אריחים', category: 'דיגיטלי', appliesTo: 'both',
    params: [N('size', 'גודל אריח', 4, 120, 28, 1), N('gap', 'מרווח', 0, 0.4, 0.08), N('jitter', 'אקראיות', 0, 1, 0.3), C('groutColor', 'צבע מילוי', '#101010')],
    glsl: `
vec4 effect(vec2 uv){
  float s = max(cpx(p_size), 2.0);
  vec2 px = (uv - 0.5) * u_res;
  vec2 cell = floor(px / s);
  vec2 f = fract(px / s);
  vec2 jit = (hash22(cell) - 0.5) * p_jitter * 0.6;
  vec4 c = tex(((cell + 0.5 + jit * 0.5) * s) / u_res + 0.5);
  float b = 1.0 + (hash12(cell + 7.0) - 0.5) * p_jitter * 0.5;
  vec3 rgb = unpremul(c) * b;
  float g = p_gap * 0.5;
  float inTile = step(g, f.x) * step(f.x, 1.0 - g) * step(g, f.y) * step(f.y, 1.0 - g);
  float edgeD = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  rgb *= mix(0.8, 1.0, smoothstep(g, g + 0.14, edgeD));
  return withRgb(c, mix(p_groutColor, rgb, inTile));
}`,
  },
  {
    id: 'dither', name: 'דיתור רטרו', category: 'דיגיטלי', appliesTo: 'both',
    params: [N('levels', 'רמות', 2, 8, 3, 1), N('pixel', 'גודל נקודה', 1, 8, 2, 1), S('colors', 'צבעים', ['צבע', 'שחור־לבן'], 0)],
    glsl: `
float bayer4(vec2 p){
  ivec2 i = ivec2(mod(p, 4.0));
  int a = i.x ^ i.y;
  int v = ((a & 1) << 3) | ((i.y & 1) << 2) | (((a >> 1) & 1) << 1) | ((i.y >> 1) & 1);
  return (float(v) + 0.5) / 16.0;
}
vec4 effect(vec2 uv){
  float s = max(floor(cpx(p_pixel) + 0.5), 1.0);
  vec2 px = floor(uv * u_res / s);
  vec4 c = tex((px + 0.5) * s / u_res);
  vec3 rgb = unpremul(c);
  if (p_colors > 0.5) rgb = vec3(luma(rgb));
  float L = max(p_levels - 1.0, 1.0);
  float th = bayer4(px) - 0.5;
  rgb = floor(rgb * L + 0.5 + th) / L;
  return withRgb(c, rgb);
}`,
  },
  {
    id: 'scanlines', name: 'קווי סריקה', category: 'רטרו', appliesTo: 'both',
    params: [N('count', 'מספר קווים', 100, 1500, 500, 10), N('intensity', 'עוצמה', 0, 1, 0.35), N('speed', 'גלילה', 0, 5, 0)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float y = (uv.y + u_time * p_speed * 0.02) * p_count;
  float s = 0.5 + 0.5 * cos(y * TAU);
  return vec4(c.rgb * (1.0 - p_intensity * (1.0 - s)), c.a);
}`,
  },
  {
    id: 'vhs', name: 'קלטת VHS', category: 'רטרו', appliesTo: 'both',
    params: [N('intensity', 'עוצמה', 0, 1, 0.6), N('noise', 'רעש', 0, 1, 0.5), N('tracking', 'פס עקיבה', 0, 1, 0.5)],
    glsl: `
vec3 toYiq(vec3 c){ return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 fromYiq(vec3 c){ return vec3(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z); }
vec4 effect(vec2 uv){
  float I = p_intensity;
  float t = u_time;
  float fr = floor(t * 30.0);
  float y = uv.y;
  float jitter = (vnoise(vec2(y * 140.0, fr)) - 0.5) * 0.004 * I;
  float bandPos = fract(t * 0.23 + 0.3);
  float inBand = (1.0 - smoothstep(0.0, 0.05, abs(y - bandPos))) * p_tracking;
  jitter += inBand * (hash12(vec2(floor(y * 220.0), fr)) - 0.5) * 0.05 * I;
  vec2 q = vec2(uv.x + jitter, uv.y);
  vec4 base = tex(q);
  vec4 left = tex(q - vec2(0.007 * I, 0.0));
  vec4 left2 = tex(q - vec2(0.014 * I, 0.0));
  vec3 yiq = toYiq(unpremul(base));
  vec3 yl = toYiq(unpremul(left) * 0.6 + unpremul(left2) * 0.4);
  yiq.yz = mix(yiq.yz, yl.yz, 0.75 * I);
  vec3 rgb = fromYiq(yiq);
  rgb = mix(rgb, vec3(luma(rgb)), 0.2 * I);
  rgb += (hash12(floor(uv * u_res) + fr) - 0.5) * 0.16 * I * p_noise;
  rgb += inBand * 0.1 * I;
  rgb *= 1.0 - 0.07 * I * step(0.5, fract(uv.y * u_res.y * 0.5 / max(u_pxScale, 0.25)));
  return withRgb(base, rgb);
}`,
  },
  {
    id: 'crt', name: 'טלוויזיה ישנה', category: 'רטרו', appliesTo: 'both',
    params: [N('curvature', 'קימור', 0, 1, 0.35), N('scanlines', 'קווי סריקה', 0, 1, 0.45), N('mask', 'מסכת פיקסלים', 0, 1, 0.35), N('vignette', 'ויניטה', 0, 1, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 p = uv * 2.0 - 1.0;
  vec2 q = p + p * (p.yx * p.yx) * (p_curvature * 0.2);
  vec2 cuv = q * 0.5 + 0.5;
  if (outside(cuv)) return u_edge > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(0.0);
  float o = 0.0015;
  vec4 cr = tex(cuv + vec2(o, 0.0));
  vec4 cg = tex(cuv);
  vec4 cb = tex(cuv - vec2(o, 0.0));
  vec4 c = vec4(cr.r, cg.g, cb.b, cg.a);
  vec3 rgb = unpremul(c);
  float lines = max(u_res.y / max(3.0 * u_pxScale, 1.0), 120.0);
  float sl = 0.5 + 0.5 * cos(cuv.y * lines * TAU);
  rgb *= 1.0 - p_scanlines * 0.55 * (1.0 - sl);
  int col = int(mod(gl_FragCoord.x, 3.0));
  vec3 m = col == 0 ? vec3(1.0, 0.7, 0.7) : col == 1 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0);
  rgb *= mix(vec3(1.0), m * 1.12, p_mask);
  float v = 1.0 - smoothstep(0.55, 1.45, length(p));
  rgb *= mix(1.0, v, p_vignette);
  vec2 e = smoothstep(vec2(0.0), vec2(0.012), cuv) * smoothstep(vec2(0.0), vec2(0.012), 1.0 - cuv);
  rgb *= e.x * e.y;
  return withRgb(c, rgb * 1.08);
}`,
  },
  {
    id: 'filmGrain', name: 'גרעיניות פילם', category: 'רטרו', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 0.35), N('size', 'גודל גרעין', 1, 4, 1.4, 0.1), N('color', 'גרעין צבעוני', 0, 1, 0)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 rgb = unpremul(c);
  vec2 g = floor(uv * u_res / max(p_size * u_pxScale, 1.0));
  float fr = u_seed;
  float n = (hash12(g + vec2(fr * 17.31, fr * 3.7)) + hash12(g * 1.37 + vec2(fr * 5.1, 9.3))) * 0.5 - 0.5;
  vec3 nc = vec3(hash12(g + vec2(fr * 3.1, 0.5)), hash12(g + vec2(fr * 5.7, 1.5)), hash12(g + vec2(fr * 7.9, 2.5))) - 0.5;
  vec3 nv = mix(vec3(n * 1.6), nc, p_color);
  float w = clamp(1.2 - abs(luma(rgb) - 0.45) * 1.6, 0.2, 1.0);
  return withRgb(c, rgb + nv * p_amount * 0.4 * w);
}`,
  },
  {
    id: 'letterbox', name: 'פסים קולנועיים', category: 'מסגרות', appliesTo: 'both',
    params: [N('size', 'גובה פס', 0, 0.45, 0.11, 0.005), C('color', 'צבע', '#000000'), N('animIn', 'כניסה (שנ׳)', 0, 3, 0.6, 0.05), N('animOut', 'יציאה (שנ׳)', 0, 3, 0, 0.05)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float e = p_animIn > 0.001 ? smoothstep(0.0, 1.0, clamp(u_time / p_animIn, 0.0, 1.0)) : 1.0;
  if (p_animOut > 0.001) e *= smoothstep(0.0, 1.0, clamp((u_duration - u_time) / p_animOut, 0.0, 1.0));
  float h = p_size * e;
  float bar = 1.0 - step(h, uv.y) * step(uv.y, 1.0 - h);
  return mix(c, vec4(p_color, 1.0), bar);
}`,
  },
  {
    id: 'splitScreen', name: 'מסך מפוצל', category: 'מסגרות', appliesTo: 'both',
    params: [S('count', 'מספר חלונות', ['2', '3', '4', '6', '9'], 2), N('gap', 'מרווח', 0, 30, 4, 0.5), C('gapColor', 'צבע מרווח', '#000000')],
    glsl: `
vec4 effect(vec2 uv){
  int m = int(p_count + 0.5);
  vec2 grid = m == 0 ? vec2(1.0, 2.0) : m == 1 ? vec2(1.0, 3.0) : m == 2 ? vec2(2.0, 2.0) : m == 3 ? vec2(2.0, 3.0) : vec2(3.0, 3.0);
  if (u_res.x > u_res.y) grid = grid.yx;
  vec2 f = fract(uv * grid);
  float cellAsp = (u_res.x / grid.x) / (u_res.y / grid.y);
  float imgAsp = aspect();
  vec2 q = f - 0.5;
  if (cellAsp > imgAsp) q.y *= imgAsp / cellAsp; else q.x *= cellAsp / imgAsp;
  vec4 c = tex(q + 0.5);
  vec2 e = min(f, 1.0 - f) * u_res / grid;
  float g = cpx(p_gap) * 0.5;
  float inside_ = step(g, min(e.x, e.y));
  return mix(vec4(p_gapColor, 1.0), c, inside_);
}`,
  },
  {
    id: 'mirror', name: 'מראה', category: 'עיוות', appliesTo: 'both',
    params: [S('mode', 'סוג', ['שמאל לימין', 'ימין לשמאל', 'למעלה ללמטה', 'למטה ללמעלה', 'ארבעה רבעים'], 0)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 q = uv;
  int m = int(p_mode + 0.5);
  if (m == 0) q.x = q.x > 0.5 ? 1.0 - q.x : q.x;
  else if (m == 1) q.x = q.x < 0.5 ? 1.0 - q.x : q.x;
  else if (m == 2) q.y = q.y > 0.5 ? 1.0 - q.y : q.y;
  else if (m == 3) q.y = q.y < 0.5 ? 1.0 - q.y : q.y;
  else { vec2 t = mod(uv * 2.0, 2.0); q = mix(t, 2.0 - t, step(1.0, t)); }
  return tex(q);
}`,
  },
  {
    id: 'kaleidoscope', name: 'קליידוסקופ', category: 'עיוות', appliesTo: 'both',
    params: [N('segments', 'מקטעים', 2, 16, 6, 1), N('rotation', 'סיבוב', 0, 360, 0, 1), N('speed', 'מהירות סיבוב', -2, 2, 0.15, 0.01), N('zoom', 'זום', 0.5, 3, 1, 0.01)],
    glsl: `
vec4 effect(vec2 uv){
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0) / max(p_zoom, 0.05);
  float r = length(p);
  float a = atan(p.y, p.x) + radians(p_rotation) + u_time * p_speed;
  float seg = TAU / max(floor(p_segments + 0.5), 1.0);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r;
  vec2 s = q / vec2(asp, 1.0) + 0.5;
  vec2 t = mod(s, 2.0);
  return tex(mix(t, 2.0 - t, step(1.0, t)));
}`,
  },
  {
    id: 'fisheye', name: 'עין דג', category: 'עיוות', appliesTo: 'both',
    params: [N('strength', 'עוצמה', -1, 1, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float rmax = length(vec2(asp, 1.0) * 0.5);
  float r = length(p) / rmax;
  float f = 1.0 - p_strength * 0.55 * (1.0 - r * r);
  return tex(p * f / vec2(asp, 1.0) + 0.5);
}`,
  },
  {
    id: 'lensDistortion', name: 'עיוות עדשה', category: 'עיוות', appliesTo: 'both',
    params: [N('amount', 'עוצמה', -1, 1, 0.35), N('fringe', 'שוליים צבעוניים', 0, 1, 0.2)],
    glsl: `
vec4 effect(vec2 uv){
  float asp = aspect();
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  vec2 hc = vec2(asp, 1.0) * 0.5;
  float r2 = dot(p, p) / dot(hc, hc);
  float k = p_amount * 0.5;
  float comp = k > 0.0 ? 1.0 / (1.0 + k) : 1.0;
  vec2 base = p * comp;
  vec2 qr = base * (1.0 + k * r2 * (1.0 + p_fringe * 0.08));
  vec2 qg = base * (1.0 + k * r2);
  vec2 qb = base * (1.0 + k * r2 * (1.0 - p_fringe * 0.08));
  vec4 cr = tex(qr / vec2(asp, 1.0) + 0.5);
  vec4 cg = tex(qg / vec2(asp, 1.0) + 0.5);
  vec4 cb = tex(qb / vec2(asp, 1.0) + 0.5);
  return vec4(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
}`,
  },
  {
    id: 'shockwave', name: 'גל הדף', category: 'עיוות', appliesTo: 'both',
    params: [N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5), P_AT, N('speed', 'מהירות', 0.1, 4, 1.2, 0.05), N('width', 'רוחב גל', 0.02, 0.4, 0.12), N('strength', 'עוצמה', 0, 0.3, 0.06, 0.005), N('brightness', 'הארה', 0, 1, 0.25)],
    glsl: `
vec4 effect(vec2 uv){
  float asp = aspect();
  vec2 c = vec2(p_centerX, p_centerY);
  vec2 p = (uv - c) * vec2(asp, 1.0);
  float r = length(p);
  float tt = u_time - p_at;
  if (tt < 0.0) return tex(uv);
  float R = tt * p_speed;
  float x = (r - R) / max(p_width, 0.005);
  if (abs(x) > 1.0) return tex(uv);
  float fade = exp(-tt * 1.1);
  float wv = sin(x * PI) * (1.0 - abs(x)) * p_strength * fade;
  vec2 dir = r > 1e-5 ? p / r : vec2(0.0);
  vec4 col = tex((p - dir * wv) / vec2(asp, 1.0) + c);
  float glow = (1.0 - abs(x)) * p_brightness * fade;
  col.rgb = min(col.rgb + col.a * glow * 0.5, vec3(col.a));
  return col;
}`,
  },
  {
    id: 'heatHaze', name: 'אוויר חם', category: 'עיוות', appliesTo: 'both',
    params: [N('strength', 'עוצמה', 0, 30, 5, 0.5), N('speed', 'מהירות', 0, 5, 1.4, 0.05), N('scale', 'קנה מידה', 1, 30, 7, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  vec2 p = uv * vec2(aspect(), 1.0) * p_scale;
  float nx = fbm(p + vec2(0.0, u_time * p_speed)) - 0.5;
  float ny = fbm(p * 1.3 + vec2(5.2, u_time * p_speed * 1.3)) - 0.5;
  float w = mix(0.4, 1.0, uv.y);
  vec2 off = vec2(nx, ny * 0.6) * cpx(p_strength) * 2.0 * w / u_res;
  return tex(uv + off);
}`,
  },
  {
    id: 'tvOff', name: 'כיבוי טלוויזיה', category: 'מסגרות', appliesTo: 'both',
    params: [S('mode', 'מתי', ['בסוף הקליפ', 'בזמן מוגדר'], 0), P_AT, N('length', 'משך (שנ׳)', 0.2, 2, 0.6, 0.05)],
    glsl: `
vec4 effect(vec2 uv){
  float start = p_mode < 0.5 ? (u_duration - p_length) : p_at;
  float x = clamp((u_time - start) / max(p_length, 0.05), 0.0, 1.0);
  if (u_time < start) return tex(uv);
  float sy = mix(1.0, 0.006, smoothstep(0.0, 0.5, x));
  float sx = mix(1.0, 0.0, smoothstep(0.5, 0.9, x));
  vec2 p = uv - 0.5;
  vec2 q = vec2(p.x / max(sx, 1e-4), p.y / sy) + 0.5;
  bool inBox = abs(p.x) <= sx * 0.5 && abs(p.y) <= sy * 0.5;
  vec4 c = inBox ? tex(q) : vec4(0.0);
  float bright = smoothstep(0.15, 0.55, x);
  vec3 rgb = mix(unpremul(c), vec3(1.0), bright * 0.9);
  float a = c.a * (1.0 - smoothstep(0.88, 1.0, x));
  float glow = exp(-abs(p.y) * u_res.y / max(cpx(6.0), 1.0)) * exp(-abs(p.x) / max(sx * 0.6 + 0.02, 0.02)) * smoothstep(0.3, 0.55, x) * (1.0 - smoothstep(0.9, 1.0, x));
  vec4 o = vec4(rgb * a, a);
  o = o + vec4(vec3(0.85, 0.95, 1.0) * glow, glow) * (1.0 - o.a);
  if (u_edge > 0.5) o = o + vec4(0.0, 0.0, 0.0, 1.0) * (1.0 - o.a);
  return o;
}`,
  },
  /* ---------------- צבע ---------------- */
  {
    id: 'invert', name: 'היפוך צבעים', category: 'צבע', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 1)],
    glsl: `vec4 effect(vec2 uv){ vec4 c = tex(uv); vec3 r = unpremul(c); return withRgb(c, mix(r, 1.0 - r, p_amount)); }`,
  },
  {
    id: 'posterize', name: 'פוסטריזציה', category: 'צבע', appliesTo: 'both',
    params: [N('levels', 'רמות', 2, 16, 5, 1)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  float L = max(floor(p_levels + 0.5), 2.0);
  vec3 r = pow(unpremul(c), vec3(1.0 / 1.2));
  r = floor(r * (L - 0.001)) / (L - 1.0);
  return withRgb(c, pow(r, vec3(1.2)));
}`,
  },
  {
    id: 'duotone', name: 'דואוטון', category: 'צבע', appliesTo: 'both',
    params: [C('shadow', 'צבע צללים', '#1b1464'), C('highlight', 'צבע אורות', '#ff4d6d'), N('amount', 'עוצמה', 0, 1, 1), N('contrast', 'ניגודיות', 0, 1, 0.2)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  float l = clamp((luma(r) - 0.5) * (1.0 + p_contrast * 2.0) + 0.5, 0.0, 1.0);
  return withRgb(c, mix(r, mix(p_shadow, p_highlight, l), p_amount));
}`,
  },
  {
    id: 'blackWhite', name: 'שחור־לבן', category: 'צבע', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 1), N('contrast', 'ניגודיות', -1, 1, 0.15), S('filter', 'פילטר ערוצים', ['ניטרלי', 'אדום', 'ירוק', 'כחול', 'צהוב'], 0)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  int m = int(p_filter + 0.5);
  vec3 w = m == 1 ? vec3(0.62, 0.3, 0.08) : m == 2 ? vec3(0.25, 0.65, 0.1) : m == 3 ? vec3(0.15, 0.25, 0.6) : m == 4 ? vec3(0.45, 0.48, 0.07) : vec3(0.2126, 0.7152, 0.0722);
  float l = dot(r, w);
  l = clamp((l - 0.5) * (1.0 + p_contrast) + 0.5, 0.0, 1.0);
  return withRgb(c, mix(r, vec3(l), p_amount));
}`,
  },
  {
    id: 'sepia', name: 'ספיה', category: 'צבע', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 1), N('warmth', 'חמימות', 0, 1, 0.5)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  float l = luma(r);
  vec3 tone = vec3(1.0 + 0.12 * p_warmth, 0.86 + 0.02 * p_warmth, 0.62 - 0.12 * p_warmth);
  vec3 s = clamp(l * tone + vec3(0.06, 0.03, 0.0) * (1.0 - l), 0.0, 1.0);
  return withRgb(c, mix(r, s, p_amount));
}`,
  },
  {
    id: 'colorPop', name: 'צבע בודד', category: 'צבע', appliesTo: 'both',
    params: [C('color', 'הצבע שנשמר', '#e8302a'), N('range', 'טווח', 0, 0.5, 0.08), N('softness', 'רכות', 0, 0.3, 0.06), N('minSat', 'רוויה מינימלית', 0, 1, 0.18)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  vec3 h = rgb2hsv(r);
  float th = rgb2hsv(p_color).x;
  float dh = abs(h.x - th);
  dh = min(dh, 1.0 - dh);
  float keep = (1.0 - smoothstep(p_range, p_range + p_softness + 1e-4, dh)) * smoothstep(p_minSat * 0.6, p_minSat + 0.05, h.y);
  return withRgb(c, mix(vec3(luma(r)), r, keep));
}`,
  },
  {
    id: 'rainbow', name: 'קשת', category: 'צבע', appliesTo: 'both',
    params: [N('intensity', 'עוצמה', 0, 1, 0.45), N('speed', 'מהירות', -2, 2, 0.4, 0.01), N('scale', 'קנה מידה', 0.2, 5, 1.2, 0.05), N('angle', 'זווית', 0, 360, 30, 1)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  float a = radians(p_angle);
  float h = fract(dot((uv - 0.5) * vec2(aspect(), 1.0), vec2(cos(a), sin(a))) * p_scale + u_time * p_speed);
  vec3 col = hsv2rgb(vec3(h, 0.85, 1.0));
  float l = luma(r);
  vec3 tinted = col * (l / max(luma(col), 1e-3));
  tinted = mix(tinted, vec3(l), smoothstep(0.85, 1.0, l));
  return withRgb(c, mix(r, clamp(tinted, 0.0, 1.0), p_intensity));
}`,
  },
  {
    id: 'thermal', name: 'מצלמה תרמית', category: 'צבע', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 1)],
    glsl: `
vec3 heat(float x){
  vec3 c0 = vec3(0.02, 0.0, 0.12);
  vec3 c1 = vec3(0.25, 0.0, 0.65);
  vec3 c2 = vec3(0.9, 0.05, 0.45);
  vec3 c3 = vec3(1.0, 0.55, 0.0);
  vec3 c4 = vec3(1.0, 0.95, 0.35);
  vec3 c5 = vec3(1.0, 1.0, 1.0);
  float s = clamp(x, 0.0, 1.0) * 5.0;
  if (s < 1.0) return mix(c0, c1, s);
  if (s < 2.0) return mix(c1, c2, s - 1.0);
  if (s < 3.0) return mix(c2, c3, s - 2.0);
  if (s < 4.0) return mix(c3, c4, s - 3.0);
  return mix(c4, c5, s - 4.0);
}
vec4 effect(vec2 uv){ vec4 c = tex(uv); vec3 r = unpremul(c); return withRgb(c, mix(r, heat(luma(r)), p_amount)); }`,
  },
  {
    id: 'nightVision', name: 'ראיית לילה', category: 'צבע', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 1), N('noise', 'רעש', 0, 1, 0.4)],
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec3 r = unpremul(c);
  float l = pow(clamp(luma(r) * 1.6, 0.0, 1.0), 0.8);
  l += (hash12(floor(uv * u_res / max(u_pxScale * 1.5, 1.0)) + u_seed * 1.7) - 0.5) * 0.3 * p_noise;
  l *= 0.9 + 0.1 * cos(uv.y * u_res.y * 1.2 / max(u_pxScale, 0.25));
  float v = 1.0 - smoothstep(0.35, 0.75, length((uv - 0.5) * vec2(aspect(), 1.0)));
  vec3 g = vec3(0.12, 1.0, 0.28) * clamp(l, 0.0, 1.2) * mix(0.25, 1.0, v);
  return withRgb(c, mix(r, g, p_amount));
}`,
  },
  /* ---------------- אמנותי ---------------- */
  {
    id: 'neonEdges', name: 'קצוות ניאון', category: 'אמנותי', appliesTo: 'both',
    params: [C('color', 'צבע', '#00e5ff'), N('intensity', 'עוצמה', 0, 3, 1.4, 0.05), N('width', 'עובי', 0.5, 4, 1, 0.1), N('keep', 'שמירת מקור', 0, 1, 0.25), N('cycle', 'החלפת צבעים', 0, 2, 0, 0.05)],
    pad: (p) => p.width * 3,
    glsl: `
float lumA(vec2 uv){ vec4 c = tex(uv); return luma(c.rgb) + c.a * 0.25; }
vec4 effect(vec2 uv){
  vec2 o = max(cpx(p_width), 0.75) / u_res;
  float tl = lumA(uv + o * vec2(-1.0, -1.0)); float tc = lumA(uv + o * vec2(0.0, -1.0)); float tr = lumA(uv + o * vec2(1.0, -1.0));
  float ml = lumA(uv + o * vec2(-1.0, 0.0)); float mr = lumA(uv + o * vec2(1.0, 0.0));
  float bl = lumA(uv + o * vec2(-1.0, 1.0)); float bc = lumA(uv + o * vec2(0.0, 1.0)); float br = lumA(uv + o * vec2(1.0, 1.0));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  float e = smoothstep(0.06, 0.5, length(vec2(gx, gy))) * p_intensity;
  vec3 col = p_color;
  if (p_cycle > 0.001) col = hsv2rgb(vec3(fract(rgb2hsv(p_color).x + u_time * p_cycle * 0.2 + uv.y * 0.3), 0.85, 1.0));
  vec4 base = tex(uv) * p_keep;
  float ea = clamp(e, 0.0, 1.0);
  vec4 neon = vec4(col * ea, ea);
  return base + neon - base * neon;
}`,
  },
  {
    id: 'sketch', name: 'סקיצה בעיפרון', category: 'אמנותי', appliesTo: 'both',
    params: [N('amount', 'עוצמה', 0, 1, 1), N('strength', 'חוזק קווים', 0.5, 4, 1.6, 0.05), C('paper', 'צבע נייר', '#f5f1e8')],
    glsl: `
float lumB(vec2 uv){ vec4 c = tex(uv); return luma(unpremul(c)); }
vec4 effect(vec2 uv){
  vec4 c = tex(uv);
  vec2 o = max(u_pxScale, 0.75) / u_res;
  float gx = lumB(uv + vec2(o.x, 0.0)) - lumB(uv - vec2(o.x, 0.0));
  float gy = lumB(uv + vec2(0.0, o.y)) - lumB(uv - vec2(0.0, o.y));
  float gx2 = lumB(uv + vec2(o.x, o.y) * 2.0) - lumB(uv - vec2(o.x, o.y) * 2.0);
  float e = clamp((abs(gx) + abs(gy) + abs(gx2) * 0.5) * p_strength * 2.2, 0.0, 1.0);
  float shade = mix(1.0, 0.82, 1.0 - smoothstep(0.1, 0.6, lumB(uv)));
  float hatch = 1.0 - 0.07 * step(0.5, fract((uv.x + uv.y) * u_res.y / max(cpx(6.0), 1.0))) * (1.0 - smoothstep(0.2, 0.5, lumB(uv)));
  vec3 pencil = p_paper * (1.0 - e * 0.85) * shade * hatch;
  return withRgb(c, mix(unpremul(c), pencil, p_amount));
}`,
  },
  {
    id: 'halftone', name: 'הדפס נקודות', category: 'אמנותי', appliesTo: 'both',
    params: [N('size', 'גודל נקודה', 3, 40, 9, 0.5), N('angle', 'זווית', 0, 90, 45, 1), S('mode', 'סוג', ['שחור־לבן', 'צבע'], 0), C('paper', 'צבע נייר', '#f4efe6'), C('ink', 'צבע דיו', '#151515')],
    glsl: `
vec4 effect(vec2 uv){
  float s = max(cpx(p_size), 2.0);
  vec2 px = uv * u_res;
  mat2 R = rot2(radians(p_angle));
  vec2 rp = R * px;
  vec2 cell = floor(rp / s) + 0.5;
  vec2 center = transpose(R) * (cell * s);
  vec4 cc = tex(center / u_res);
  vec3 rgb = unpremul(cc);
  float L = luma(rgb);
  float rad = (p_mode < 0.5 ? sqrt(max(1.0 - L, 0.0)) : sqrt(max(1.0 - L * 0.55, 0.0))) * s * 0.72;
  float d = length(rp - cell * s);
  float dt = 1.0 - smoothstep(rad - 0.75, rad + 0.75, d);
  vec3 inkC = p_mode < 0.5 ? p_ink : rgb;
  vec4 here = tex(uv);
  return withRgb(here, mix(p_paper, inkC, dt));
}`,
  },
  {
    id: 'outline', name: 'קו מתאר', category: 'אמנותי', appliesTo: 'clip',
    params: [C('color', 'צבע', '#ffffff'), N('width', 'עובי', 1, 40, 8, 0.5), N('opacity', 'אטימות', 0, 1, 1)],
    pad: (p) => p.width + 3,
    glsl: `
vec4 effect(vec2 uv){
  vec4 c = texT(uv);
  float r = cpx(p_width);
  float a = 0.0;
  for (int i = 0; i < 24; i++) {
    float ang = float(i) * TAU / 24.0;
    vec2 o = vec2(cos(ang), sin(ang)) * r / u_res;
    a = max(a, texT(uv + o).a);
    a = max(a, texT(uv + o * 0.5).a);
  }
  vec4 ol = vec4(p_color, 1.0) * a * p_opacity;
  return c + ol * (1.0 - c.a);
}`,
  },
  {
    id: 'dropShadow', name: 'צל נופל', category: 'אמנותי', appliesTo: 'clip',
    params: [C('color', 'צבע', '#000000'), N('opacity', 'אטימות', 0, 1, 0.6), N('distance', 'מרחק', 0, 100, 14, 0.5), N('angle', 'זווית', 0, 360, 90, 1), N('blur', 'טשטוש', 0, 60, 14, 0.5)],
    pad: (p) => p.distance + p.blur * 1.3 + 2,
    passes: [
      { glsl: `
vec4 shTap(vec2 uv){
  float a = radians(p_angle);
  vec2 off = vec2(cos(a), sin(a)) * cpx(p_distance) / u_res;
  return vec4(texT(uv - off).a);
}
${gaussFn('gaussShadow', 'shTap')}
vec4 effect(vec2 uv){ return gaussShadow(uv, vec2(1.0, 0.0), cpx(p_blur)); }` },
      { glsl: `${gaussFn('gaussTT', 'texT')}\nvec4 effect(vec2 uv){ return gaussTT(uv, vec2(0.0, 1.0), cpx(p_blur)); }` },
      { glsl: `
vec4 effect(vec2 uv){
  vec4 s = srcTex(uv);
  float sa = texT(uv).a * p_opacity;
  vec4 sh = vec4(p_color * sa, sa);
  return s + sh * (1.0 - s.a);
}` },
    ],
  },
];

for (const e of EFFECTS) {
  if (!e.glsl && e.passes) e.glsl = e.passes[0].glsl;
  if (!e.passes) e.passes = [{ glsl: e.glsl }];
}
const EFFECT_MAP = new Map(EFFECTS.map((e) => [e.id, e]));
export function getEffect(id) { return EFFECT_MAP.get(id) || null; }

/** Default params object for an effect id ({} for unknown ids). */
export function effectDefaults(id) {
  const e = EFFECT_MAP.get(id);
  const o = {};
  if (e) for (const p of e.params) o[p.key] = p.default;
  return o;
}

function paramDecl(params) {
  return params.map((p) => (p.type === 'color' ? `uniform vec3 p_${p.key};` : `uniform float p_${p.key};`)).join('\n');
}

function effectFragment(def, pass) {
  return `${EFFECT_HEADER}\n${paramDecl(def.params)}\n${def.passes[pass].glsl}\nvoid main(){ vec4 c = effect(v_uv); c = clamp(c, 0.0, 1.0); c.rgb = min(c.rgb, vec3(c.a)); fragColor = c; }`;
}

/** Program for one pass of an effect (cached; null when the shader failed). */
export function compileEffect(gl, id, pass = 0) {
  const def = EFFECT_MAP.get(id);
  if (!def || !def.passes[pass]) return null;
  return getProgram(gl, `effect:${id}:${pass}`, () => [QUAD_VS, effectFragment(def, pass)]);
}

/** Convert user params (numbers / hex / select labels) into uniform values, filling defaults. */
export function resolveEffectParams(def, params = {}) {
  const out = {};
  for (const p of def.params) {
    let v = params ? params[p.key] : undefined;
    if (v === undefined || v === null || v === '') v = p.default;
    if (p.type === 'color') out[p.key] = rgb3(v, rgb3(p.default));
    else if (p.type === 'select') {
      let idx = typeof v === 'number' ? v : p.options.indexOf(String(v));
      if (idx < 0) idx = Number.isFinite(+v) ? +v : p.default;
      out[p.key] = Math.max(0, Math.min(p.options.length - 1, Math.round(idx)));
    } else {
      let n = Number(v);
      if (!Number.isFinite(n)) n = p.default;
      out[p.key] = n;
    }
  }
  return out;
}

/** Padding (canvas px, each side) an effect needs around a layer with alpha. */
export function effectPadding(id, params, w, h) {
  const def = EFFECT_MAP.get(id);
  if (!def || !def.pad) return 0;
  try {
    const p = Object.assign(effectDefaults(id), params || {});
    for (const k in p) if (typeof p[k] === 'string' && Number.isFinite(+p[k])) p[k] = +p[k];
    const v = def.pad(p, w || 0, h || 0);
    return Number.isFinite(v) ? Math.max(0, Math.min(2000, v)) : 0;
  } catch (_) { return 0; }
}

/**
 * Run an effect on src ({tex,w,h}). Returns a NEW pooled target with the result (caller releases it),
 * or null when the effect is unknown / failed (caller keeps src).
 * ctx: { pool, time, progress, duration, seed, pxScale, edge (0 transparent outside | 1 clamp), inner }
 */
export function applyEffect(gl, effectId, src, params, time, ctx) {
  const def = EFFECT_MAP.get(effectId);
  if (!def || !ctx || !ctx.pool) return null;
  const vals = resolveEffectParams(def, params);
  const base = {
    u_src: src.tex,
    u_res: [src.w, src.h],
    u_pxScale: ctx.pxScale || 1,
    u_time: Number.isFinite(time) ? time : 0,
    u_progress: ctx.progress || 0,
    u_duration: ctx.duration || 0,
    u_seed: ctx.seed || 0,
    u_edge: ctx.edge ? 1 : 0,
    u_inner: ctx.inner || [0, 0, 1, 1],
  };
  for (const k in vals) base['p_' + k] = vals[k];
  let cur = src;
  let owned = null;
  for (let i = 0; i < def.passes.length; i++) {
    const prog = compileEffect(gl, effectId, i);
    if (!prog) { if (owned) ctx.pool.release(owned); return null; }
    const out = ctx.pool.acquire(src.w, src.h);
    base.u_tex = cur.tex;
    drawQuad(gl, prog, out, base);
    if (owned) ctx.pool.release(owned);
    owned = out;
    cur = out;
  }
  return owned;
}

/** Compile every effect/grade/mask program; returns [{kind:'effect',id,error}] failures. */
export function compileAllEffects(gl) {
  const fails = [];
  const core = [['grade', GRADE_FS], ['mask', MASK_FS], ['maskmix', MIX_FS]];
  for (const [key, fs] of core) {
    if (!getProgram(gl, key, () => [QUAD_VS, fs])) fails.push({ kind: 'core', id: key, error: (programFailures(gl).find((f) => f.key === key) || {}).error });
  }
  for (const e of EFFECTS) {
    for (let i = 0; i < e.passes.length; i++) {
      if (!compileEffect(gl, e.id, i)) {
        const key = `effect:${e.id}:${i}`;
        fails.push({ kind: 'effect', id: e.id, pass: i, error: (programFailures(gl).find((f) => f.key === key) || {}).error });
      }
    }
  }
  return fails;
}
