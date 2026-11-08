// render/transitions-gl.js — Frame Studio transitions (agent R). All GLSL here is original.
//
// A transition body is a GLSL function `vec4 transition(vec2 uv)` that may use:
//   getFromColor(uv) / getToColor(uv)   premultiplied RGBA of clip A / clip B (transparent outside 0..1)
//   getFromEdge(uv) / getToEdge(uv)     same but mirrored outside 0..1 when both layers are opaque full-frame
//   progress (0..1), ratio (width/height), u_res (px), p_<param> uniforms, helpers from GLSL_COMMON.
// uv (0,0) = top-left, v grows downward (see effects-gl.js header).
//
// Module is Node-safe: no DOM / GL access at top level.

import { GLSL_COMMON, QUAD_VS, getProgram, drawQuad, programFailures, parseColor } from './effects-gl.js';

const HEADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float progress;
uniform float ratio;
uniform vec2 u_res;
uniform float u_edge;
${GLSL_COMMON}
float inside01(vec2 uv){ return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0); }
vec2 mirror01(vec2 uv){ vec2 m = mod(uv, 2.0); return mix(m, 2.0 - m, step(1.0, m)); }
vec4 getFromColor(vec2 uv){ return texture(u_from, uv) * inside01(uv); }
vec4 getToColor(vec2 uv){ return texture(u_to, uv) * inside01(uv); }
vec4 getFromEdge(vec2 uv){ return u_edge > 0.5 ? texture(u_from, mirror01(uv)) : getFromColor(uv); }
vec4 getToEdge(vec2 uv){ return u_edge > 0.5 ? texture(u_to, mirror01(uv)) : getToColor(uv); }
vec4 over(vec4 top, vec4 bottom){ return top + bottom * (1.0 - top.a); }
float easeInCubic(float x){ return x * x * x; }
float easeOutCubic(float x){ float y = 1.0 - x; return 1.0 - y * y * y; }
float easeInOutCubic(float x){ return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5; }
float easeInOutQuint(float x){ return x < 0.5 ? 16.0 * x * x * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 5.0) * 0.5; }
float easeInOutSine(float x){ return 0.5 - 0.5 * cos(PI * x); }
float bell(float x){ return sin(PI * clamp(x, 0.0, 1.0)); }
vec2 toAsp(vec2 uv){ return (uv - 0.5) * vec2(ratio, 1.0); }
vec2 fromAsp(vec2 p){ return p / vec2(ratio, 1.0) + 0.5; }
`;

const N = (key, name, min, max, def, step) => ({ key, name, type: 'number', min, max, default: def, step: step != null ? step : +((max - min) / 100).toPrecision(2) });
const C = (key, name, def) => ({ key, name, type: 'color', default: def });
const S = (key, name, options, def = 0) => ({ key, name, type: 'select', options, default: def });
const SOFT = (d = 0.04) => N('softness', 'רכות קצה', 0, 0.5, d, 0.005);
const T = (id, name, category, glsl, params = [], defaultDuration = 0.5) => ({ id, name, category, defaultDuration, params, glsl });

const DIRS = {
  Left: { v: 'vec2(1.0, 0.0)', he: 'שמאלה' },
  Right: { v: 'vec2(-1.0, 0.0)', he: 'ימינה' },
  Up: { v: 'vec2(0.0, 1.0)', he: 'למעלה' },
  Down: { v: 'vec2(0.0, -1.0)', he: 'למטה' },
};

const slide = (d) => `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  vec2 D = ${DIRS[d].v};
  vec4 a = getFromColor(uv + D * e);
  vec4 b = getToColor(uv);
  float sh = getFromColor(uv + D * (e - 0.035)).a * (1.0 - a.a) * 0.45 * (1.0 - e);
  b.rgb *= 1.0 - sh;
  return over(a, b);
}`;

const push = (d) => `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  vec2 D = ${DIRS[d].v};
  vec4 a = getFromColor(uv + D * e);
  vec4 b = getToColor(uv + D * e - D);
  return over(b, a);
}`;

const cover = (d) => `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  vec2 D = ${DIRS[d].v};
  vec4 b = getToColor(uv - D * (1.0 - e));
  vec4 a = getFromColor(uv);
  float sh = getToColor(uv - D * (1.0 - e) + D * 0.045).a * (1.0 - b.a) * 0.5;
  a.rgb *= 1.0 - sh * smoothstep(0.0, 0.1, e);
  return over(b, a);
}`;

const wipe = (coord) => `
vec4 transition(vec2 uv){
  float sw = max(p_softness, 0.0005);
  float s = ${coord};
  float edge = mix(-sw, 1.0 + sw, progress);
  float m = 1.0 - smoothstep(edge - sw, edge + sw, s);
  return mix(getFromColor(uv), getToColor(uv), m);
}`;

const whip = (d) => `
vec4 transition(vec2 uv){
  float e = easeInOutQuint(progress);
  vec2 D = ${DIRS[d].v};
  float blurLen = p_blur * 0.35 * pow(bell(progress), 2.0);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 24; i++) {
    float k = float(i) / 23.0 - 0.5;
    float off = e + k * blurLen;
    vec4 a = getFromColor(uv + D * off);
    vec4 b = getToColor(uv + D * off - D);
    float w = 1.0 - abs(k);
    acc += over(b, a) * w;
    ws += w;
  }
  return acc / ws;
}`;

export const TRANSITIONS = [
  /* ---------------- בסיסי ---------------- */
  T('crossfade', 'עמעום מוצלב', 'בסיסי', `
vec4 transition(vec2 uv){ return mix(getFromColor(uv), getToColor(uv), progress); }`),
  T('dipBlack', 'מעבר דרך שחור', 'בסיסי', `
vec4 transition(vec2 uv){
  float h = p_hold * 0.5;
  vec4 K = vec4(0.0, 0.0, 0.0, 1.0);
  if (progress < 0.5) return mix(getFromColor(uv), K, smoothstep(0.0, max(0.5 - h, 0.001), progress));
  return mix(K, getToColor(uv), smoothstep(0.5 + h, 1.0, progress));
}`, [N('hold', 'השהיה בשחור', 0, 0.6, 0.12)], 0.6),
  T('dipWhite', 'מעבר דרך לבן', 'בסיסי', `
vec4 transition(vec2 uv){
  float h = p_hold * 0.5;
  vec4 K = vec4(1.0);
  if (progress < 0.5) return mix(getFromColor(uv), K, smoothstep(0.0, max(0.5 - h, 0.001), progress));
  return mix(K, getToColor(uv), smoothstep(0.5 + h, 1.0, progress));
}`, [N('hold', 'השהיה בלבן', 0, 0.6, 0.1)], 0.6),
  T('dipColor', 'מעבר דרך צבע', 'בסיסי', `
vec4 transition(vec2 uv){
  float h = p_hold * 0.5;
  vec4 K = vec4(p_color, 1.0);
  if (progress < 0.5) return mix(getFromColor(uv), K, smoothstep(0.0, max(0.5 - h, 0.001), progress));
  return mix(K, getToColor(uv), smoothstep(0.5 + h, 1.0, progress));
}`, [C('color', 'צבע', '#3b82f6'), N('hold', 'השהיה', 0, 0.6, 0.1)], 0.6),
  T('flashWhite', 'הבזק לבן', 'בסיסי', `
vec4 transition(vec2 uv){
  vec4 c = mix(getFromColor(uv), getToColor(uv), smoothstep(0.44, 0.56, progress));
  float f = exp(-pow((progress - 0.5) / max(p_width, 0.02), 2.0)) * p_intensity;
  return vec4(c.rgb + vec3(f), max(c.a, min(f, 1.0)));
}`, [N('intensity', 'עוצמה', 0, 1.5, 1), N('width', 'משך ההבזק', 0.05, 0.5, 0.16)], 0.4),
  T('blurDissolve', 'עמעום מטושטש', 'בסיסי', `
vec4 blurAt(vec2 uv, float r, float which){
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / 24.0) * r;
    float an = fi * 2.39996;
    vec2 o = vec2(cos(an), sin(an)) * rr / vec2(ratio, 1.0);
    vec4 c = which < 0.5 ? getFromEdge(uv + o) : getToEdge(uv + o);
    acc += c;
    ws += 1.0;
  }
  return acc / ws;
}
vec4 transition(vec2 uv){
  float r = p_blur * 0.06 * bell(progress);
  return mix(blurAt(uv, r, 0.0), blurAt(uv, r, 1.0), smoothstep(0.25, 0.75, progress));
}`, [N('blur', 'טשטוש', 0, 1, 0.6)], 0.6),
  T('lumaDissolve', 'התמוססות רעש', 'בסיסי', `
vec4 transition(vec2 uv){
  float n = clamp((fbm(uv * vec2(ratio, 1.0) * p_scale) - 0.22) / 0.56, 0.0, 1.0);
  float sw = max(p_softness, 0.002);
  float edge = mix(-sw, 1.0 + sw, progress);
  float m = 1.0 - smoothstep(edge - sw, edge + sw, n);
  vec4 c = mix(getFromColor(uv), getToColor(uv), m);
  float rim = (1.0 - smoothstep(0.0, sw * 1.5, abs(n - edge))) * p_glow * bell(progress);
  c.rgb += p_glowColor * rim * c.a;
  return c;
}`, [N('scale', 'קנה מידה', 0.5, 12, 3.5, 0.1), SOFT(0.06), N('glow', 'זוהר קצה', 0, 1, 0.4), C('glowColor', 'צבע זוהר', '#ffcf7a')], 0.8),
  /* ---------------- החלקה ---------------- */
  ...Object.keys(DIRS).map((d) => T('slide' + d, `החלקה ${DIRS[d].he}`, 'החלקה', slide(d))),
  ...Object.keys(DIRS).map((d) => T('push' + d, `דחיפה ${DIRS[d].he}`, 'החלקה', push(d))),
  ...Object.keys(DIRS).map((d) => T('cover' + d, `כיסוי ${DIRS[d].he}`, 'החלקה', cover(d))),
  T('splitReveal', 'פיצול וחשיפה', 'החלקה', `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  vec4 b = getToColor(0.5 + (uv - 0.5) / mix(1.12, 1.0, e));
  vec4 a = vec4(0.0);
  float half_ = 0.5 * e;
  if (p_direction < 0.5) {
    if (uv.y < 0.5) { vec2 q = vec2(uv.x, uv.y + half_); if (q.y < 0.5) a = getFromColor(q); }
    else { vec2 q = vec2(uv.x, uv.y - half_); if (q.y >= 0.5) a = getFromColor(q); }
  } else {
    if (uv.x < 0.5) { vec2 q = vec2(uv.x + half_, uv.y); if (q.x < 0.5) a = getFromColor(q); }
    else { vec2 q = vec2(uv.x - half_, uv.y); if (q.x >= 0.5) a = getFromColor(q); }
  }
  return over(a, b);
}`, [S('direction', 'כיוון', ['למעלה ולמטה', 'לצדדים'], 0)], 0.6),
  /* ---------------- ניגוב ---------------- */
  T('wipeLeft', 'ניגוב שמאלה', 'ניגוב', wipe('1.0 - uv.x'), [SOFT()]),
  T('wipeRight', 'ניגוב ימינה', 'ניגוב', wipe('uv.x'), [SOFT()]),
  T('wipeUp', 'ניגוב למעלה', 'ניגוב', wipe('1.0 - uv.y'), [SOFT()]),
  T('wipeDown', 'ניגוב למטה', 'ניגוב', wipe('uv.y'), [SOFT()]),
  T('wipeDiagonal', 'ניגוב אלכסוני', 'ניגוב', `
vec4 transition(vec2 uv){
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float r = (abs(dir.x) + abs(dir.y)) * 0.5;
  float s = (dot(uv - 0.5, dir) + r) / (2.0 * r);
  float sw = max(p_softness, 0.0005);
  float edge = mix(-sw, 1.0 + sw, progress);
  float m = 1.0 - smoothstep(edge - sw, edge + sw, s);
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [N('angle', 'זווית', 0, 360, 45, 1), SOFT(0.05)]),
  T('clockWipe', 'ניגוב שעון', 'ניגוב', `
vec4 transition(vec2 uv){
  vec2 d = (uv - vec2(p_centerX, p_centerY)) * vec2(ratio, 1.0);
  float a01 = fract(atan(d.x, -d.y) / TAU + 1.0);
  float sw = max(p_softness, 0.0005);
  float edge = mix(-sw, 1.0 + sw, progress);
  float m = 1.0 - smoothstep(edge - sw, edge + sw, a01);
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [SOFT(0.01), N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)], 0.7),
  T('blinds', 'תריסים', 'ניגוב', `
vec4 transition(vec2 uv){
  float coord = p_direction < 0.5 ? uv.y : uv.x;
  float n = max(floor(p_count + 0.5), 1.0);
  float f = fract(coord * n);
  float idx = floor(coord * n);
  float local = clamp(progress * 1.3 - (idx / n) * 0.3, 0.0, 1.0);
  float sw = 0.02;
  float edge = mix(-sw, 1.0 + sw, local);
  float m = 1.0 - smoothstep(edge - sw, edge + sw, f);
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [N('count', 'מספר פסים', 2, 30, 8, 1), S('direction', 'כיוון', ['אופקי', 'אנכי'], 0)], 0.7),
  T('lightSweep', 'סריקת אור', 'ניגוב', `
vec4 transition(vec2 uv){
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 p = toAsp(uv);
  float span = abs(dir.x) * ratio * 0.5 + abs(dir.y) * 0.5;
  float pos = mix(-span - 0.25, span + 0.25, easeInOutSine(progress));
  float d = dot(p, dir) - pos;
  float m = smoothstep(0.02, -0.02, d);
  vec4 c = mix(getFromColor(uv), getToColor(uv), m);
  float band = exp(-d * d / max(p_width * p_width, 1e-4)) * p_intensity;
  c.rgb += p_color * band * c.a;
  return c;
}`, [N('angle', 'זווית', 0, 360, 20, 1), N('width', 'רוחב', 0.02, 0.4, 0.09), N('intensity', 'עוצמה', 0, 2, 1.1), C('color', 'צבע', '#fff6dc')], 0.6),
  /* ---------------- זום ---------------- */
  T('zoomIn', 'זום פנימה', 'זום', `
vec4 transition(vec2 uv){
  float sA = 1.0 + p_strength * easeInCubic(clamp(progress * 2.0, 0.0, 1.0));
  float sB = 1.0 + p_strength * (1.0 - easeOutCubic(clamp(progress * 2.0 - 1.0, 0.0, 1.0)));
  vec4 a = getFromColor(0.5 + (uv - 0.5) / sA);
  vec4 b = getToColor(0.5 + (uv - 0.5) / sB);
  return mix(a, b, smoothstep(0.4, 0.6, progress));
}`, [N('strength', 'עוצמת זום', 0.2, 3, 1.0)], 0.5),
  T('zoomOut', 'זום החוצה', 'זום', `
vec4 transition(vec2 uv){
  float k = 1.0 + p_strength;
  float sA = mix(1.0, 1.0 / k, easeInCubic(clamp(progress * 2.0, 0.0, 1.0)));
  float sB = mix(1.0 / k, 1.0, easeOutCubic(clamp(progress * 2.0 - 1.0, 0.0, 1.0)));
  vec4 a = getFromEdge(0.5 + (uv - 0.5) / sA);
  vec4 b = getToEdge(0.5 + (uv - 0.5) / sB);
  return mix(a, b, smoothstep(0.4, 0.6, progress));
}`, [N('strength', 'עוצמת זום', 0.2, 3, 0.8)], 0.5),
  T('zoomBlur', 'זום מהיר מטושטש', 'זום', `
vec4 transition(vec2 uv){
  float e = progress;
  float sA = 1.0 + p_strength * easeInCubic(clamp(e * 2.0, 0.0, 1.0));
  float sB = 1.0 + p_strength * (1.0 - easeOutCubic(clamp(e * 2.0 - 1.0, 0.0, 1.0)));
  float bl = p_blur * 0.5 * pow(bell(e), 1.5);
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  for (int i = 0; i < 20; i++) {
    float k = float(i) / 19.0;
    float z = 1.0 + bl * k;
    a += getFromColor(0.5 + (uv - 0.5) / (sA * z));
    b += getToColor(0.5 + (uv - 0.5) / (sB * z));
  }
  return mix(a, b, smoothstep(0.42, 0.58, e)) / 20.0;
}`, [N('strength', 'עוצמת זום', 0.2, 3, 1.4), N('blur', 'טשטוש', 0, 1, 0.6)], 0.45),
  T('crossZoom', 'זום מוצלב', 'זום', `
vec4 transition(vec2 uv){
  vec2 c = vec2(p_centerX, p_centerY);
  float s = p_strength * bell(progress);
  float m = smoothstep(0.3, 0.7, progress);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float k = float(i) / 23.0;
    vec2 q = c + (uv - c) * (1.0 - s * 0.5 * k) / (1.0 + s * 0.25);
    acc += mix(getFromEdge(q), getToEdge(q), m);
  }
  return acc / 24.0;
}`, [N('strength', 'עוצמה', 0, 1, 0.6), N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)], 0.6),
  /* ---------------- צורות ---------------- */
  T('circleOpen', 'עיגול נפתח', 'צורות', `
vec4 transition(vec2 uv){
  vec2 c = vec2(p_centerX, p_centerY);
  vec2 d = (uv - c) * vec2(ratio, 1.0);
  float maxR = length(max(c, 1.0 - c) * vec2(ratio, 1.0));
  float sw = max(p_softness, 0.001);
  float r = easeInOutCubic(progress) * (maxR + sw * 2.0);
  float m = 1.0 - smoothstep(r - sw, r, length(d));
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [SOFT(0.02), N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)], 0.6),
  T('circleClose', 'עיגול נסגר', 'צורות', `
vec4 transition(vec2 uv){
  vec2 c = vec2(p_centerX, p_centerY);
  vec2 d = (uv - c) * vec2(ratio, 1.0);
  float maxR = length(max(c, 1.0 - c) * vec2(ratio, 1.0));
  float sw = max(p_softness, 0.001);
  float r = (1.0 - easeInOutCubic(progress)) * (maxR + sw * 2.0);
  float m = smoothstep(r - sw, r, length(d));
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [SOFT(0.02), N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)], 0.6),
  T('diamond', 'יהלום', 'צורות', `
vec4 transition(vec2 uv){
  vec2 d = abs((uv - 0.5) * vec2(ratio, 1.0));
  float sw = max(p_softness, 0.001);
  float maxR = ratio * 0.5 + 0.5;
  float r = easeInOutCubic(progress) * (maxR + sw * 2.0);
  float m = 1.0 - smoothstep(r - sw, r, d.x + d.y);
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [SOFT(0.02)], 0.6),
  T('heartWipe', 'לב', 'צורות', `
vec4 transition(vec2 uv){
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  float maxR = length(vec2(ratio, 1.0) * 0.5) * 1.7;
  float r = easeInOutCubic(progress) * maxR + 1e-4;
  vec2 q = vec2(p.x, -p.y + r * 0.25) / r;
  float x2 = q.x * q.x;
  float k = x2 + q.y * q.y - 1.0;
  float f = k * k * k - x2 * q.y * q.y * q.y;
  float m = 1.0 - smoothstep(-0.02, 0.02, f);
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [], 0.7),
  T('starWipe', 'כוכב', 'צורות', `
vec4 transition(vec2 uv){
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  float maxR = length(vec2(ratio, 1.0) * 0.5) * 2.3;
  float r = easeInOutCubic(progress) * maxR;
  float a = atan(p.x, -p.y) + p_spin * progress * PI;
  float seg = TAU / 5.0;
  float k = abs(mod(a + seg * 0.5, seg) - seg * 0.5) / (seg * 0.5);
  float R = r * mix(1.0, 0.45, k);
  float m = 1.0 - smoothstep(R - 0.01, R + 0.01, length(p));
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [N('spin', 'סיבוב', 0, 2, 0.5)], 0.7),
  T('squares', 'ריבועים', 'צורות', `
vec4 transition(vec2 uv){
  vec2 grid = vec2(p_size, max(floor(p_size / ratio + 0.5), 1.0));
  vec2 g = uv * grid;
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float delay = hash12(cell + 0.5) * 0.6;
  float local = clamp((progress - delay) / 0.4, 0.0, 1.0);
  float d = max(abs(f.x), abs(f.y));
  float th = easeOutCubic(local) * 0.56;
  float m = 1.0 - smoothstep(th - 0.02, th + 0.005, d);
  m *= step(0.001, local);
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [N('size', 'ריבועים לרוחב', 3, 40, 9, 1)], 0.8),
  T('inkSpread', 'כתם דיו', 'צורות', `
vec4 transition(vec2 uv){
  vec2 c = vec2(p_centerX, p_centerY);
  vec2 d = (uv - c) * vec2(ratio, 1.0);
  float maxR = length(max(c, 1.0 - c) * vec2(ratio, 1.0)) + 0.35;
  float n = fbm(d * 4.0 + 3.1) - 0.5;
  float r = easeInOutCubic(progress) * maxR;
  float m = 1.0 - smoothstep(r - 0.02, r + 0.02, length(d) + n * 0.32 * bell(progress * 0.8 + 0.1));
  m = progress >= 0.999 ? 1.0 : m;
  return mix(getFromColor(uv), getToColor(uv), m);
}`, [N('centerX', 'מרכז X', 0, 1, 0.5), N('centerY', 'מרכז Y', 0, 1, 0.5)], 0.8),
  /* ---------------- דיגיטלי ---------------- */
  T('pixelate', 'פיקסלים', 'דיגיטלי', `
vec4 transition(vec2 uv){
  float bs = max(1.0, p_size * pow(bell(progress), 1.5));
  vec2 cells = u_res / bs;
  vec2 q = (floor(uv * cells) + 0.5) / cells;
  return mix(getFromColor(q), getToColor(q), smoothstep(0.45, 0.55, progress));
}`, [N('size', 'גודל פיקסל מרבי', 8, 160, 60, 1)], 0.6),
  T('glitch', 'גליץ׳', 'דיגיטלי', `
vec4 transition(vec2 uv){
  float s = bell(progress);
  float tq = floor(progress * 24.0);
  float row = floor(uv.y * 26.0);
  float rnd = hash12(vec2(row, tq));
  float shift = (hash12(vec2(row, tq + 3.0)) - 0.5) * 0.22 * s * step(0.45, rnd);
  vec2 q = uv + vec2(shift, 0.0);
  float ca = 0.025 * s * p_intensity;
  float pick = step(hash12(vec2(row * 0.37, tq * 1.7 + 0.5)), progress);
  vec4 r = mix(getFromColor(q + vec2(ca, 0.0)), getToColor(q + vec2(ca, 0.0)), pick);
  vec4 g = mix(getFromColor(q), getToColor(q), pick);
  vec4 b = mix(getFromColor(q - vec2(ca, 0.0)), getToColor(q - vec2(ca, 0.0)), pick);
  vec4 o = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
  float blk = step(0.93, hash12(floor(uv * vec2(8.0, 20.0)) + tq)) * s;
  o.rgb = mix(o.rgb, vec3(o.a) - o.rgb, blk * 0.8);
  return o;
}`, [N('intensity', 'עוצמה', 0, 2, 1)], 0.5),
  T('rgbSplit', 'פיצול RGB', 'דיגיטלי', `
vec4 transition(vec2 uv){
  float s = bell(progress) * p_amount;
  float m = smoothstep(0.45, 0.55, progress);
  vec2 o = vec2(s, s * 0.25);
  vec4 r = mix(getFromColor(uv + o), getToColor(uv + o), m);
  vec4 g = mix(getFromColor(uv), getToColor(uv), m);
  vec4 b = mix(getFromColor(uv - o), getToColor(uv - o), m);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`, [N('amount', 'מרחק', 0, 0.2, 0.06, 0.002)], 0.45),
  /* ---------------- קולנועי ---------------- */
  ...Object.keys(DIRS).map((d) => T('whip' + d, `וויפ ${DIRS[d].he}`, 'קולנועי', whip(d), [N('blur', 'טשטוש תנועה', 0, 1, 0.75)], 0.4)),
  T('spin', 'סיבוב', 'קולנועי', `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  float th = radians(p_angle);
  float z = 1.0 + bell(e) * p_zoom;
  vec2 p = toAsp(uv);
  float m = smoothstep(0.42, 0.58, progress);
  float vel = th * 0.12 * bell(progress);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float k = float(i) / 11.0 - 0.5;
    vec2 qa = fromAsp(rot2(-(th * e + vel * k)) * p / z);
    vec2 qb = fromAsp(rot2(-(th * (e - 1.0) + vel * k)) * p / z);
    acc += mix(getFromEdge(qa), getToEdge(qb), m);
  }
  return acc / 12.0;
}`, [N('angle', 'זווית', 30, 720, 180, 5), N('zoom', 'זום', 0, 1.5, 0.45)], 0.5),
  T('swirl', 'מערבולת', 'קולנועי', `
vec4 transition(vec2 uv){
  float s = bell(progress);
  vec2 p = toAsp(uv);
  float r = length(p);
  float R = 0.5 * max(ratio, 1.0) + 0.25;
  float a = p_strength * s * TAU * pow(max(1.0 - r / R, 0.0), 2.0);
  vec2 q = fromAsp(rot2(a) * p);
  return mix(getFromEdge(q), getToEdge(q), smoothstep(0.3, 0.7, progress));
}`, [N('strength', 'עוצמה', 0, 3, 1.2)], 0.7),
  T('ripple', 'אדוות מים', 'קולנועי', `
vec4 transition(vec2 uv){
  float s = bell(progress);
  vec2 p = toAsp(uv);
  float r = length(p);
  float w = sin(r * p_frequency - progress * p_speed) * p_amplitude * s;
  vec2 dir = r > 1e-5 ? p / r : vec2(0.0);
  vec2 q = fromAsp(p + dir * w);
  return mix(getFromEdge(q), getToEdge(q), smoothstep(0.35, 0.65, progress));
}`, [N('amplitude', 'עוצמה', 0, 0.1, 0.03, 0.001), N('frequency', 'צפיפות', 5, 80, 36, 1), N('speed', 'מהירות', 0, 60, 24, 1)], 0.8),
  T('filmBurn', 'שריפת פילם', 'קולנועי', `
vec4 transition(vec2 uv){
  float s = bell(progress);
  vec2 p = uv * vec2(ratio, 1.0);
  float n = fbm(p * 2.0 + vec2(progress * 3.0, progress * 1.3));
  float n2 = fbm(p * 4.3 - vec2(progress * 2.0, 0.0) + 5.0);
  float burn = smoothstep(0.15, 0.95, n + s * 1.1 - 0.55 + (1.0 - uv.x) * 0.15 * s) * s;
  vec3 fire = mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.86, 0.55), n2) * p_intensity;
  vec4 c = mix(getFromColor(uv), getToColor(uv), smoothstep(0.35, 0.65, progress));
  vec3 lit = 1.0 - (1.0 - c.rgb) * (1.0 - clamp(fire * burn, 0.0, 1.0));
  float a = max(c.a, clamp(burn * p_intensity, 0.0, 1.0));
  return vec4(lit, a);
}`, [N('intensity', 'עוצמה', 0, 1.5, 1)], 0.8),
  T('shake', 'רעידה', 'קולנועי', `
vec4 transition(vec2 uv){
  float s = bell(progress);
  float t = progress * 30.0;
  vec2 off = vec2(noise1(t, 1.0), noise1(t, 9.0)) * p_strength * s;
  float z = 1.0 + p_strength * 1.6 * s;
  vec2 q = (uv - 0.5) / z + 0.5 + off;
  return mix(getFromEdge(q), getToEdge(q), smoothstep(0.4, 0.6, progress));
}`, [N('strength', 'עוצמה', 0, 0.15, 0.04, 0.002)], 0.5),
  /* ---------------- תלת־ממד ---------------- */
  T('cube', 'קובייה', 'תלת־ממד', `
vec4 faceHit(vec3 oL, vec3 dL, float half_, out float tA, out vec2 uvA, out float tB, out vec2 uvB){
  tA = 1e9; tB = 1e9; uvA = vec2(-1.0); uvB = vec2(-1.0);
  if (abs(dL.z) > 1e-6) {
    float t = (-half_ - oL.z) / dL.z;
    vec3 h = oL + dL * t;
    if (t > 0.0 && abs(h.x) <= half_ && abs(h.y) <= 0.5) { tA = t; uvA = vec2(h.x / (2.0 * half_) + 0.5, h.y + 0.5); }
  }
  if (abs(dL.x) > 1e-6) {
    float t = (half_ - oL.x) / dL.x;
    vec3 h = oL + dL * t;
    if (t > 0.0 && abs(h.z) <= half_ && abs(h.y) <= 0.5) { tB = t; uvB = vec2(h.z / (2.0 * half_) + 0.5, h.y + 0.5); }
  }
  return vec4(0.0);
}
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  float ang = e * PI * 0.5;
  float half_ = ratio * 0.5;
  float f = 2.2;
  float pull = bell(e) * p_zoom;
  vec3 ro = vec3(0.0, 0.0, -f - pull);
  vec2 p = toAsp(uv);
  vec3 rd = vec3(p, f);
  vec3 o = ro - vec3(0.0, 0.0, half_);
  float c = cos(ang);
  float s = sin(ang);
  vec3 oL = vec3(o.x * c - o.z * s, o.y, o.x * s + o.z * c);
  vec3 dL = vec3(rd.x * c - rd.z * s, rd.y, rd.x * s + rd.z * c);
  float tA; float tB; vec2 uvA; vec2 uvB;
  faceHit(oL, dL, half_, tA, uvA, tB, uvB);
  if (tA < 1e8 && tA <= tB) return getFromColor(uvA) * mix(1.0, 0.55, s);
  if (tB < 1e8) return getToColor(uvB) * mix(0.55, 1.0, s);
  return vec4(0.0);
}`, [N('zoom', 'התרחקות', 0, 2, 0.9)], 0.7),
  T('doorway', 'דלתות', 'תלת־ממד', `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  vec4 b = getToColor(0.5 + (uv - 0.5) / mix(0.8, 1.0, e));
  b.rgb *= mix(0.35, 1.0, e);
  float w = 0.5 * (1.0 - e);
  vec4 a = vec4(0.0);
  if (uv.x < w) {
    float lx = uv.x / max(w, 1e-4);
    float sc = 1.0 + e * 0.45 * lx;
    float ay = (uv.y - 0.5) / sc + 0.5;
    if (ay >= 0.0 && ay <= 1.0) a = getFromColor(vec2(lx * 0.5, ay)) * mix(1.0, 0.6, e);
  } else if (uv.x > 1.0 - w) {
    float lx = (1.0 - uv.x) / max(w, 1e-4);
    float sc = 1.0 + e * 0.45 * lx;
    float ay = (uv.y - 0.5) / sc + 0.5;
    if (ay >= 0.0 && ay <= 1.0) a = getFromColor(vec2(1.0 - lx * 0.5, ay)) * mix(1.0, 0.6, e);
  }
  return over(a, b);
}`, [], 0.7),
  T('pageFlip', 'היפוך דף', 'תלת־ממד', `
vec4 transition(vec2 uv){
  float e = easeInOutCubic(progress);
  float fx = mix(1.0, -0.02, e);
  float backL = 2.0 * fx - 1.0;
  vec4 b = getToColor(uv);
  vec4 res;
  if (uv.x > fx) {
    res = b;
    float sh = exp(-(uv.x - fx) * 30.0) * 0.45 * bell(e);
    res.rgb *= 1.0 - sh;
  } else if (uv.x >= backL) {
    vec2 q = vec2(2.0 * fx - uv.x, uv.y);
    vec4 back = getFromColor(q);
    float shade = mix(0.62, 0.92, (fx - uv.x) / max(fx - backL, 1e-4));
    back.rgb = mix(back.rgb * shade, vec3(back.a * 0.9), 0.25);
    vec4 front = getFromColor(uv);
    res = over(back, front);
  } else {
    res = getFromColor(uv);
    float sh = exp(-(backL - uv.x) * 25.0) * 0.35;
    res.rgb *= 1.0 - sh;
  }
  return res;
}`, [], 0.7),
];

const TRANSITION_MAP = new Map(TRANSITIONS.map((t) => [t.id, t]));
export function getTransition(id) { return TRANSITION_MAP.get(id) || null; }

function paramDecl(params) {
  return params.map((p) => (p.type === 'color' ? `uniform vec3 p_${p.key};` : `uniform float p_${p.key};`)).join('\n');
}

function transitionFragment(def) {
  return `${HEADER}\n${paramDecl(def.params)}\n${def.glsl}\nvoid main(){\n  vec4 c = clamp(transition(v_uv), 0.0, 1.0);\n  c.a = max(c.a, max(c.r, max(c.g, c.b)));\n  fragColor = c;\n}`;
}

/** Compile (cached) the program for a transition id. Unknown id → crossfade. Null if compilation failed. */
export function compileTransition(gl, id) {
  const def = TRANSITION_MAP.get(id) || TRANSITION_MAP.get('crossfade');
  return getProgram(gl, `transition:${def.id}`, () => [QUAD_VS, transitionFragment(def)]);
}

function resolveParams(def, params) {
  const out = {};
  for (const p of def.params) {
    let v = params ? params[p.key] : undefined;
    if (v === undefined || v === null || v === '') v = p.default;
    if (p.type === 'color') out['p_' + p.key] = parseColor(v, parseColor(p.default)).slice(0, 3);
    else if (p.type === 'select') {
      let idx = typeof v === 'number' ? v : p.options.indexOf(String(v));
      if (idx < 0) idx = Number.isFinite(+v) ? +v : p.default;
      out['p_' + p.key] = Math.max(0, Math.min(p.options.length - 1, Math.round(idx)));
    } else {
      const n = Number(v);
      out['p_' + p.key] = Number.isFinite(n) ? n : p.default;
    }
  }
  return out;
}

/**
 * Draw transition `id` mixing fromTex → toTex at `progress` into the CURRENTLY BOUND framebuffer
 * (or opts.target = {fb}) with viewport 0,0,w,h and the current blend state. w/h = target pixel size.
 * opts.edge = true when both layers are opaque full-frame (enables mirrored edge sampling);
 * opts.ratio overrides the aspect (defaults to w/h); opts.res = logical canvas size for px-based params.
 * Returns false when the shader is unavailable (caller may fall back).
 */
export function drawTransition(gl, id, fromTex, toTex, progress, params, w, h, opts = {}) {
  const def = TRANSITION_MAP.get(id) || TRANSITION_MAP.get('crossfade');
  let prog = compileTransition(gl, def.id);
  let usedDef = def;
  if (!prog) { usedDef = TRANSITION_MAP.get('crossfade'); prog = compileTransition(gl, 'crossfade'); }
  if (!prog) return false;
  const fb = opts.target ? opts.target.fb : gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const uniforms = Object.assign({
    u_from: fromTex && fromTex.tex ? fromTex.tex : fromTex,
    u_to: toTex && toTex.tex ? toTex.tex : toTex,
    progress: Math.max(0, Math.min(1, +progress || 0)),
    ratio: opts.ratio || (w / Math.max(1, h)),
    u_res: opts.res || [w, h],
    u_edge: opts.edge ? 1 : 0,
  }, resolveParams(usedDef, params));
  drawQuad(gl, prog, fb ? { fb, w, h } : null, uniforms, { width: w, height: h });
  return true;
}

/** Compile every transition; returns [{kind:'transition', id, error}] failures. */
export function compileAllTransitions(gl) {
  const fails = [];
  for (const t of TRANSITIONS) {
    if (!compileTransition(gl, t.id)) {
      const key = `transition:${t.id}`;
      fails.push({ kind: 'transition', id: t.id, error: (programFailures(gl).find((f) => f.key === key) || {}).error });
    }
  }
  return fails;
}

/* =====================================================================================
 * Transition pairing on the timeline (shared by compositor.js and sources.js)
 * ===================================================================================== */

const VISUAL_TYPES = new Set(['video', 'image', 'text', 'caption', 'shape', 'sticker']);
export function isTransitionable(clip) { return !!clip && VISUAL_TYPES.has(clip.type) && !clip.disabled; }

/**
 * For one track: [{ a, b, id, params, d, cut, t0, t1 }] — clip A's transitionOut to the clip B that
 * starts at A's end (±1 frame). Duration is clamped to both clip lengths so windows never overlap.
 * `clips` must be the clips of that track (any order).
 */
export function findTransitionPairs(clips, fps = 30) {
  const sorted = clips.filter((c) => c && !c.disabled).slice().sort((x, y) => x.start - y.start || String(x.id).localeCompare(String(y.id)));
  const tol = 1 / Math.max(1, fps) + 1e-6;
  const out = [];
  for (const a of sorted) {
    const tr = a.transitionOut;
    if (!tr || !tr.id || tr.id === 'none' || !isTransitionable(a)) continue;
    const aEnd = a.start + a.duration;
    let b = null;
    for (const c of sorted) {
      if (c === a || !isTransitionable(c)) continue;
      if (Math.abs(c.start - aEnd) <= tol && (!b || Math.abs(c.start - aEnd) < Math.abs(b.start - aEnd))) b = c;
    }
    if (!b) continue;
    let d = Number(tr.duration);
    if (!Number.isFinite(d) || d <= 0) d = (TRANSITION_MAP.get(tr.id) || {}).defaultDuration || 0.5;
    d = Math.min(d, a.duration, b.duration);
    if (d <= 1e-4) continue;
    const cut = (aEnd + b.start) / 2;
    out.push({ a, b, id: TRANSITION_MAP.has(tr.id) ? tr.id : 'crossfade', params: tr.params || {}, d, cut, t0: cut - d / 2, t1: cut + d / 2 });
  }
  // a clip can be B of one pair and A of the next; windows never overlap thanks to the clamp,
  // but if two A's point to the same B keep only the earliest-starting one
  const seenB = new Set();
  return out.filter((p) => (seenB.has(p.b.id) ? false : (seenB.add(p.b.id), true)));
}

/**
 * Visible time range of a clip including transition handles: [start - preHalf, end + postHalf).
 * pairs = findTransitionPairs() of the clip's track.
 */
export function clipVisualRange(clip, pairs) {
  let s = clip.start;
  let e = clip.start + clip.duration;
  for (const p of pairs || []) {
    if (p.a === clip || p.a.id === clip.id) e = Math.max(e, p.t1);
    if (p.b === clip || p.b.id === clip.id) s = Math.min(s, p.t0);
  }
  return [s, e];
}
