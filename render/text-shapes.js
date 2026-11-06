// Frame Studio — vector shapes (SHAPES) drawn with canvas 2D paths.
// shape = { kind: rect|roundrect|ellipse|line|arrow|star|triangle|heart|burst|progress, w, h, fill, stroke, strokeWidth,
//           radius, progressFrom, progressTo,  (+ optional: points, innerRatio, thickness, dash, trackColor, direction 'rtl'|'ltr',
//           style 'bar'|'ring'|'segments', segments, gap, showValue, valueColor, gradient {from,to,angle|stops}, shadow {color,blur,x,y}, cap) }
// Pure module (no DOM at top level).

import { clamp01, num, isVisibleColor, roundRectPath, makeLinearGradient, DEG } from './text-util.js';
import { fontString } from './text-fonts.js';

export const SHAPE_DEFAULTS = Object.freeze({
  kind: 'rect', w: 400, h: 400, fill: '#13b6e4', stroke: '#ffffff', strokeWidth: 0, radius: 40, progressFrom: 0, progressTo: 1,
});

export const SHAPES = [
  { id: 'rect', name: 'מלבן', kind: 'rect', shape: { kind: 'rect', w: 400, h: 300, fill: '#13b6e4' } },
  { id: 'roundrect', name: 'מלבן מעוגל', kind: 'roundrect', shape: { kind: 'roundrect', w: 420, h: 300, radius: 48, fill: '#13b6e4' } },
  { id: 'card', name: 'כרטיס כהה', kind: 'roundrect', shape: { kind: 'roundrect', w: 900, h: 520, radius: 40, fill: 'rgba(7,24,34,0.78)', stroke: 'rgba(63,224,245,0.55)', strokeWidth: 3 } },
  { id: 'glassCard', name: 'כרטיס זכוכית', kind: 'roundrect', shape: { kind: 'roundrect', w: 900, h: 520, radius: 44, fill: 'rgba(255,255,255,0.14)', stroke: 'rgba(255,255,255,0.45)', strokeWidth: 2, shadow: { color: 'rgba(0,0,0,0.35)', blur: 40, x: 0, y: 18 } } },
  { id: 'gradientCard', name: 'כרטיס צבעוני', kind: 'roundrect', shape: { kind: 'roundrect', w: 900, h: 520, radius: 44, gradient: { from: '#13b6e4', to: '#7c5cff', angle: 135 } } },
  { id: 'frame', name: 'מסגרת', kind: 'roundrect', shape: { kind: 'roundrect', w: 700, h: 700, radius: 36, fill: 'none', stroke: '#ffffff', strokeWidth: 12 } },
  { id: 'circle', name: 'עיגול', kind: 'ellipse', shape: { kind: 'ellipse', w: 320, h: 320, fill: '#13b6e4' } },
  { id: 'ring', name: 'טבעת', kind: 'ellipse', shape: { kind: 'ellipse', w: 360, h: 360, fill: 'none', stroke: '#3fe0f5', strokeWidth: 16 } },
  { id: 'ellipse', name: 'אליפסה', kind: 'ellipse', shape: { kind: 'ellipse', w: 520, h: 320, fill: '#ff8a66' } },
  { id: 'line', name: 'קו', kind: 'line', shape: { kind: 'line', w: 600, h: 12, thickness: 12, fill: '#ffffff' } },
  { id: 'dashedLine', name: 'קו מקווקו', kind: 'line', shape: { kind: 'line', w: 600, h: 10, thickness: 10, fill: '#ffffff', dash: [26, 18] } },
  { id: 'arrow', name: 'חץ', kind: 'arrow', shape: { kind: 'arrow', w: 420, h: 200, fill: '#ffd60a', stroke: '#111111', strokeWidth: 6 } },
  { id: 'arrowLeft', name: 'חץ שמאלה', kind: 'arrow', shape: { kind: 'arrow', w: 420, h: 200, fill: '#ffd60a', stroke: '#111111', strokeWidth: 6, direction: 'rtl' } },
  { id: 'star', name: 'כוכב', kind: 'star', shape: { kind: 'star', w: 340, h: 340, fill: '#ffd60a', points: 5, innerRatio: 0.45 } },
  { id: 'triangle', name: 'משולש', kind: 'triangle', shape: { kind: 'triangle', w: 340, h: 300, fill: '#13b6e4' } },
  { id: 'heart', name: 'לב', kind: 'heart', shape: { kind: 'heart', w: 340, h: 310, fill: '#ff3b5c' } },
  { id: 'burst', name: 'פיצוץ', kind: 'burst', shape: { kind: 'burst', w: 380, h: 380, fill: '#ffd60a', stroke: '#111111', strokeWidth: 6, points: 16, innerRatio: 0.74 } },
  { id: 'badge', name: 'תג משונן', kind: 'burst', shape: { kind: 'burst', w: 340, h: 340, fill: '#ff8a66', points: 28, innerRatio: 0.88 } },
  { id: 'highlightBar', name: 'פס הדגשה', kind: 'rect', shape: { kind: 'rect', w: 720, h: 96, fill: '#ffd60a' } },
  { id: 'progress', name: 'פס התקדמות', kind: 'progress', shape: { kind: 'progress', w: 1000, h: 18, radius: 9, fill: '#3fe0f5', trackColor: 'rgba(255,255,255,0.25)', progressFrom: 0, progressTo: 1, direction: 'rtl' } },
  { id: 'progressLtr', name: 'פס התקדמות (משמאל)', kind: 'progress', shape: { kind: 'progress', w: 1000, h: 18, radius: 9, fill: '#3fe0f5', trackColor: 'rgba(255,255,255,0.25)', progressFrom: 0, progressTo: 1, direction: 'ltr' } },
  { id: 'progressStories', name: 'פס סטוריז', kind: 'progress', shape: { kind: 'progress', style: 'segments', segments: 4, gap: 12, w: 1000, h: 10, radius: 5, fill: '#ffffff', trackColor: 'rgba(255,255,255,0.35)', progressFrom: 0, progressTo: 1, direction: 'rtl' } },
  { id: 'progressRing', name: 'טבעת התקדמות', kind: 'progress', shape: { kind: 'progress', style: 'ring', w: 320, h: 320, thickness: 28, fill: '#3fe0f5', trackColor: 'rgba(255,255,255,0.2)', progressFrom: 0, progressTo: 1, showValue: true, valueColor: '#ffffff' } },
];

const SHAPE_BY_ID = new Map(SHAPES.map((s) => [s.id, s]));
export function getShape(id) { return SHAPE_BY_ID.get(id) || null; }

/** Progress value 0..1 at local time (linear from progressFrom to progressTo over the clip). */
export function progressValue(sh, localT, dur) {
  const a = num(sh.progressFrom, 0), b = num(sh.progressTo, 1);
  const p = dur > 0 ? clamp01(localT / dur) : 1;
  return clamp01(a + (b - a) * p);
}

/** Box (canvas px) of a shape without padding. */
export function shapeBox(sh) {
  const w = Math.max(1, num(sh.w, 400));
  if (sh.kind === 'line') return { w, h: Math.max(1, lineThickness(sh)) };
  return { w, h: Math.max(1, num(sh.h, 400)) };
}
function lineThickness(sh) {
  return num(sh.thickness, num(sh.strokeWidth, 0) > 0 ? sh.strokeWidth : Math.min(Math.max(2, num(sh.h, 12)), 60));
}
export function shapePad(sh) {
  let pad = 2 + Math.max(0, num(sh.strokeWidth, 0)) / 2;
  if (sh.shadow && isVisibleColor(sh.shadow.color)) pad += num(sh.shadow.blur, 0) * 1.5 + Math.max(Math.abs(num(sh.shadow.x, 0)), Math.abs(num(sh.shadow.y, 0)));
  if (sh.kind === 'star' || sh.kind === 'burst' || sh.kind === 'triangle' || sh.kind === 'arrow') pad += Math.max(0, num(sh.strokeWidth, 0)) * 0.9; // miter joins
  return Math.ceil(pad);
}

function starPath(ctx, cx, cy, rx, ry, points, inner, rot = -90) {
  ctx.beginPath();
  const n = Math.max(3, Math.round(points));
  for (let i = 0; i < n * 2; i++) {
    const a = (rot + (i * 180) / n) * DEG;
    const r = i % 2 === 0 ? 1 : inner;
    const x = cx + Math.cos(a) * rx * r, y = cy + Math.sin(a) * ry * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
export function heartPath(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y + h * 0.98);
  ctx.bezierCurveTo(x + w * 0.1, y + h * 0.66, x - w * 0.02, y + h * 0.38, x + w * 0.06, y + h * 0.2);
  ctx.bezierCurveTo(x + w * 0.16, y - h * 0.02, x + w * 0.44, y - h * 0.02, x + w / 2, y + h * 0.2);
  ctx.bezierCurveTo(x + w * 0.56, y - h * 0.02, x + w * 0.84, y - h * 0.02, x + w * 0.94, y + h * 0.2);
  ctx.bezierCurveTo(x + w * 1.02, y + h * 0.38, x + w * 0.9, y + h * 0.66, x + w / 2, y + h * 0.98);
  ctx.closePath();
}
function arrowPath(ctx, w, h, rtl) {
  const head = Math.min(w * 0.45, h * 0.95);
  const shaft = h * 0.38;
  const pts = [[0, h / 2 - shaft / 2], [w - head, h / 2 - shaft / 2], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h / 2 + shaft / 2], [0, h / 2 + shaft / 2]];
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const X = rtl ? w - x : x; if (i === 0) ctx.moveTo(X, y); else ctx.lineTo(X, y); });
  ctx.closePath();
}

function fillStyleFor(ctx, sh, x, y, w, h) {
  if (sh.gradient) return makeLinearGradient(ctx, sh.gradient, x, y, w, h);
  return isVisibleColor(sh.fill) ? sh.fill : null;
}

/**
 * Draw a shape into ctx with its box at (0,0)-(w,h) in the current user space (canvas px).
 * @param {number} value progress 0..1 (progress kind only)
 * @param {number} devScale device scale (for shadow blur/offset which ignore transforms)
 */
export function drawShape(ctx, sh, value = 1, devScale = 1) {
  const { w, h } = shapeBox(sh);
  const sw = Math.max(0, num(sh.strokeWidth, 0));
  const strokeOn = sw > 0 && isVisibleColor(sh.stroke);
  const fill = fillStyleFor(ctx, sh, 0, 0, w, h);
  const setShadow = () => {
    if (sh.shadow && isVisibleColor(sh.shadow.color)) {
      ctx.shadowColor = sh.shadow.color;
      ctx.shadowBlur = num(sh.shadow.blur, 0) * devScale;
      ctx.shadowOffsetX = num(sh.shadow.x, 0) * devScale;
      ctx.shadowOffsetY = num(sh.shadow.y, 0) * devScale;
    }
  };
  const clearShadow = () => { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const paint = () => {
    ctx.save();
    setShadow();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); clearShadow(); }
    if (strokeOn) { ctx.lineWidth = sw; ctx.strokeStyle = sh.stroke; ctx.stroke(); }
    ctx.restore();
  };
  switch (sh.kind) {
    case 'rect': ctx.beginPath(); ctx.rect(0, 0, w, h); paint(); break;
    case 'roundrect': roundRectPath(ctx, 0, 0, w, h, num(sh.radius, 40)); paint(); break;
    case 'ellipse': ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); paint(); break;
    case 'triangle': ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.lineJoin = 'round'; paint(); break;
    case 'star': starPath(ctx, w / 2, h / 2 + h * 0.04, w / 2, h / 2 * 1.02, num(sh.points, 5), num(sh.innerRatio, 0.45)); paint(); break;
    case 'burst': starPath(ctx, w / 2, h / 2, w / 2, h / 2, num(sh.points, 16), num(sh.innerRatio, 0.76), -90 + 180 / Math.max(3, num(sh.points, 16)) / 2); paint(); break;
    case 'heart': heartPath(ctx, 0, 0, w, h); paint(); break;
    case 'arrow': arrowPath(ctx, w, h, sh.direction === 'rtl'); ctx.lineJoin = 'round'; paint(); break;
    case 'line': {
      const th = lineThickness(sh);
      ctx.save();
      setShadow();
      ctx.beginPath();
      ctx.moveTo(th / 2, th / 2);
      ctx.lineTo(w - th / 2, th / 2);
      ctx.lineWidth = th;
      ctx.lineCap = sh.cap || 'round';
      if (Array.isArray(sh.dash) && sh.dash.length) ctx.setLineDash(sh.dash.map((d) => Math.max(0, Number(d) || 0)));
      ctx.strokeStyle = fill || sh.stroke || '#ffffff';
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'progress': drawProgress(ctx, sh, w, h, value, devScale, setShadow, clearShadow); break;
    default: ctx.beginPath(); ctx.rect(0, 0, w, h); paint();
  }
}

function drawProgress(ctx, sh, w, h, value, devScale, setShadow, clearShadow) {
  const track = sh.trackColor ?? 'rgba(255,255,255,0.25)';
  const fill = fillStyleFor(ctx, sh, 0, 0, w, h) || '#3fe0f5';
  const rtl = sh.direction === 'rtl';
  const style = sh.style || 'bar';
  if (style === 'ring') {
    const th = num(sh.thickness, Math.max(6, Math.min(w, h) * 0.1));
    const r = Math.max(1, Math.min(w, h) / 2 - th / 2);
    ctx.save();
    ctx.lineWidth = th;
    ctx.lineCap = 'round';
    if (isVisibleColor(track)) { ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2); ctx.strokeStyle = track; ctx.stroke(); }
    if (value > 0.0005) {
      setShadow();
      ctx.beginPath();
      const a0 = -Math.PI / 2;
      const sweep = Math.PI * 2 * value;
      if (rtl) ctx.arc(w / 2, h / 2, r, a0, a0 - sweep, true); else ctx.arc(w / 2, h / 2, r, a0, a0 + sweep, false);
      ctx.strokeStyle = fill;
      ctx.stroke();
      clearShadow();
    }
    if (sh.showValue) {
      const size = r * 0.62;
      ctx.font = fontString(sh.valueFont || 'Heebo', 900, size, false);
      ctx.fillStyle = sh.valueColor || '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.direction = 'ltr';
      ctx.fillText(`${Math.round(value * 100)}%`, w / 2, h / 2 + size * 0.04);
    }
    ctx.restore();
    return;
  }
  const radius = Math.min(num(sh.radius, h / 2), h / 2);
  if (style === 'segments') {
    const n = Math.max(1, Math.round(num(sh.segments, 4)));
    const gap = Math.max(0, num(sh.gap, 10));
    const segW = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const k = rtl ? n - 1 - i : i; // k = visual slot (left→right)
      const x = k * (segW + gap);
      const local = clamp01(value * n - i);
      if (isVisibleColor(track)) { roundRectPath(ctx, x, 0, segW, h, radius); ctx.fillStyle = track; ctx.fill(); }
      if (local > 0) {
        ctx.save();
        roundRectPath(ctx, x, 0, segW, h, radius);
        ctx.clip();
        ctx.fillStyle = fill;
        const fw = segW * local;
        ctx.fillRect(rtl ? x + segW - fw : x, 0, fw, h);
        ctx.restore();
      }
    }
    return;
  }
  // bar
  if (isVisibleColor(track)) { roundRectPath(ctx, 0, 0, w, h, radius); ctx.fillStyle = track; ctx.fill(); }
  if (value > 0.0005) {
    const fw = Math.max(h * 0.0, w * value);
    ctx.save();
    setShadow();
    roundRectPath(ctx, rtl ? w - fw : 0, 0, fw, h, Math.min(radius, fw / 2));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }
  const sw = Math.max(0, num(sh.strokeWidth, 0));
  if (sw > 0 && isVisibleColor(sh.stroke)) { roundRectPath(ctx, 0, 0, w, h, radius); ctx.lineWidth = sw; ctx.strokeStyle = sh.stroke; ctx.stroke(); }
}
