// Frame Studio — stickers: emoji (rendered with "Segoe UI Emoji") + built-in vector stickers drawn in code.
// sticker = { kind:'emoji'|'builtin', value:'🔥'|'<builtin id>', size (height in canvas px),
//             (+ optional: color, color2, text, animate:true, outline:{color,width}, shadow:{color,blur,x,y}, chord) }
// Built-in stickers are original drawings (Frame Studio code). Animated ones are pure functions of local time.
// Pure module (no DOM at top level).

import { clamp01, EASE, outBack, num, DEG, roundRectPath, noise1, isVisibleColor } from './text-util.js';
import { fontString, EMOJI_FONT_STACK } from './text-fonts.js';
import { heartPath } from './text-shapes.js';
import { detectDir } from './text-bidi.js';

const { out3, out2, inOut2 } = EASE;
const TAU = Math.PI * 2;

const EMOJI = [
  ['fire', '🔥', 'אש'], ['joy', '😂', 'צוחק עד דמעות'], ['heartEyes', '😍', 'מאוהב'], ['mindBlown', '🤯', 'מפוצץ מוח'], ['scream', '😱', 'בהלם'],
  ['clap', '👏', 'מחיאות כפיים'], ['raised', '🙌', 'ידיים למעלה'], ['thumbsUp', '👍', 'אגודל למעלה'], ['thumbsDown', '👎', 'אגודל למטה'], ['redHeart', '❤️', 'לב אדום'],
  ['hundred', '💯', 'מאה'], ['sparkles', '✨', 'ניצוצות'], ['star', '⭐', 'כוכב'], ['party', '🎉', 'מסיבה'], ['note', '🎵', 'תו'],
  ['notes', '🎶', 'תווים'], ['guitar', '🎸', 'גיטרה'], ['piano', '🎹', 'פסנתר'], ['mic', '🎤', 'מיקרופון'], ['headphones', '🎧', 'אוזניות'],
  ['drum', '🥁', 'תוף'], ['sax', '🎷', 'סקסופון'], ['trumpet', '🎺', 'חצוצרה'], ['violin', '🎻', 'כינור'], ['boom', '💥', 'בום'],
  ['zap', '⚡', 'ברק'], ['eyes', '👀', 'עיניים'], ['thinking', '🤔', 'חושב'], ['cool', '😎', 'מגניב'], ['partyFace', '🥳', 'חוגג'],
  ['sob', '😭', 'בוכה'], ['pray', '🙏', 'תודה'], ['muscle', '💪', 'שריר'], ['pointRight', '👉', 'מצביע ימינה'], ['pointLeft', '👈', 'מצביע שמאלה'],
  ['pointUp', '👆', 'מצביע למעלה'], ['pointDown', '👇', 'מצביע למטה'], ['check', '✅', 'וי ירוק'], ['cross', '❌', 'איקס'], ['warning', '⚠️', 'אזהרה'],
  ['rocket', '🚀', 'טיל'], ['bulb', '💡', 'רעיון'], ['chartUp', '📈', 'גרף עולה'], ['pushpin', '📌', 'נעץ'], ['bell', '🔔', 'פעמון'],
  ['speech', '💬', 'בועת דיבור'], ['trophy', '🏆', 'גביע'], ['crown', '👑', 'כתר'], ['target', '🎯', 'מטרה'], ['starStruck', '🤩', 'מוקסם'],
  ['sweat', '😅', 'מבוכה'], ['heartHands', '🫶', 'לב בידיים'], ['question', '❓', 'שאלה'], ['exclaim', '❗', 'קריאה'], ['loud', '🔊', 'רמקול'],
  ['phone', '📱', 'טלפון'], ['laptop', '💻', 'מחשב נייד'], ['clapper', '🎬', 'קלאפר'], ['alarm', '⏰', 'שעון מעורר'], ['money', '💰', 'כסף'],
  ['gift', '🎁', 'מתנה'], ['wink', '😉', 'קריצה'], ['shush', '🤫', 'ששש'], ['salute', '🫡', 'הצדעה'], ['wave', '👋', 'נפנוף'],
];

// ───────────────────────────── drawing helpers ─────────────────────────────

function arrowHead(ctx, x, y, angle, len, spread = 32) {
  ctx.moveTo(x + Math.cos(angle + Math.PI - spread * DEG) * len, y + Math.sin(angle + Math.PI - spread * DEG) * len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + Math.cos(angle + Math.PI + spread * DEG) * len, y + Math.sin(angle + Math.PI + spread * DEG) * len);
}
function strokeTwice(ctx, buildPath, color, outline, lw, olw) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (outline && olw > 0) { buildPath(); ctx.strokeStyle = outline; ctx.lineWidth = lw + olw * 2; ctx.stroke(); }
  buildPath(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
}
/** Fill a (possibly multi-part) shape with an outline drawn UNDER the fill so internal seams disappear. */
function fillOutlined(ctx, buildPath, fill, outline, olw) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (outline && olw > 0) { buildPath(); ctx.strokeStyle = outline; ctx.lineWidth = olw * 2; ctx.stroke(); }
  buildPath(); ctx.fillStyle = fill; ctx.fill();
}
function sparklePath(ctx, cx, cy, r) {
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + r * 0.12, cy - r * 0.12, cx + r, cy);
  ctx.quadraticCurveTo(cx + r * 0.12, cy + r * 0.12, cx, cy + r);
  ctx.quadraticCurveTo(cx - r * 0.12, cy + r * 0.12, cx - r, cy);
  ctx.quadraticCurveTo(cx - r * 0.12, cy - r * 0.12, cx, cy - r);
  ctx.closePath();
}
function starPoly(ctx, cx, cy, r, n, inner, rot = -90) {
  for (let i = 0; i < n * 2; i++) {
    const a = (rot + (i * 180) / n) * DEG, rr = i % 2 ? r * inner : r;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function drawLabel(ctx, text, x, y, size, color, { weight = 900, font = 'Heebo', align = 'center', maxW = Infinity, dir } = {}) {
  if (!text) return;
  let s = size;
  const d = dir || detectDir(text) || 'rtl';
  ctx.direction = d;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.font = fontString(font, weight, s, false);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const w = ctx.measureText(text).width;
  if (w > maxW && w > 0) { s = s * maxW / w; ctx.font = fontString(font, weight, s, false); }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + s * 0.04);
}
function ripple(ctx, x, y, t, period, maxR, color, lw) {
  const ph = (t % period) / period;
  for (let k = 0; k < 2; k++) {
    const p = ph - k * 0.22;
    if (p <= 0 || p >= 1) continue;
    ctx.beginPath();
    ctx.arc(x, y, maxR * out2(p), 0, TAU);
    ctx.strokeStyle = color;
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.lineWidth = lw * (1 - p * 0.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function rotateAbout(ctx, x, y, deg, s = 1) {
  ctx.translate(x, y);
  if (deg) ctx.rotate(deg * DEG);
  if (s !== 1) ctx.scale(s, s);
  ctx.translate(-x, -y);
}

const CHORDS = {
  Am: [-1, 0, 2, 2, 1, 0], A: [-1, 0, 2, 2, 2, 0], C: [-1, 3, 2, 0, 1, 0], G: [3, 2, 0, 0, 0, 3], Em: [0, 2, 2, 0, 0, 0],
  E: [0, 2, 2, 1, 0, 0], D: [-1, -1, 0, 2, 3, 2], Dm: [-1, -1, 0, 2, 3, 1], F: [1, 3, 3, 2, 1, 1], B7: [-1, 2, 1, 2, 0, 2], E7: [0, 2, 0, 1, 0, 0],
};

// ───────────────────────────── built-in stickers ─────────────────────────────
// draw(ctx, w, h, o) with o = { t, color, color2, text, animate, chord }

const B = [];
const def = (id, name, aspect, colors, draw, animated = false) => B.push({ id, name, aspect, colors, draw, animated });

def('arrow', 'חץ', 2, { color: '#ffffff', color2: '#111111' }, (ctx, w, h, o) => {
  const lw = h * 0.15;
  strokeTwice(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(w * 0.08, h * 0.64);
    ctx.quadraticCurveTo(w * 0.45, h * 0.36, w * 0.86, h * 0.5);
    arrowHead(ctx, w * 0.9, h * 0.5, 0.08, h * 0.36, 38);
  }, o.color, o.color2, lw, h * 0.045);
});
def('curvedArrow', 'חץ מעוקל', 1.3, { color: '#ffd60a', color2: '#111111' }, (ctx, w, h, o) => {
  const lw = h * 0.1;
  const x0 = w * 0.14, y0 = h * 0.86, c1x = w * 0.08, c1y = h * 0.18, c2x = w * 0.78, c2y = h * 0.02, x1 = w * 0.84, y1 = h * 0.62;
  const ang = Math.atan2(y1 - c2y, x1 - c2x);
  strokeTwice(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x1, y1);
    arrowHead(ctx, x1, y1, ang, h * 0.24, 36);
  }, o.color, o.color2, lw, h * 0.035);
});
def('circleHighlight', 'עיגול הדגשה', 1.6, { color: '#ff3b30' }, (ctx, w, h, o) => {
  const prog = o.animate ? out3(o.t / 0.5) : 1;
  const steps = 90;
  const a0 = -100 * DEG, a1 = 300 * DEG;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    const k = i / steps;
    const rx = w * 0.44 * (1 + 0.035 * Math.sin(3 * a)), ry = h * 0.4 * (1 + 0.05 * Math.cos(2 * a));
    pts.push([w / 2 + Math.cos(a) * rx + k * w * 0.03, h / 2 + Math.sin(a) * ry - k * h * 0.04]);
  }
  const last = Math.max(1, Math.round(steps * prog));
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= last; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = h * 0.065;
  ctx.strokeStyle = o.color;
  ctx.stroke();
}, true);
def('underlineSwoosh', 'קו תחתון מתנפנף', 4, { color: '#ffd60a' }, (ctx, w, h, o) => {
  const prog = o.animate ? out3(o.t / 0.45) : 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(w * (1 - prog), -h, w * prog + 1, h * 3); // grows from the right (Hebrew reading start)
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(w * 0.97, h * 0.34);
  ctx.quadraticCurveTo(w * 0.52, h * 0.2, w * 0.03, h * 0.62);
  ctx.quadraticCurveTo(w * 0.02, h * 0.8, w * 0.1, h * 0.76);
  ctx.quadraticCurveTo(w * 0.5, h * 0.44, w * 0.96, h * 0.52);
  ctx.quadraticCurveTo(w * 1.01, h * 0.43, w * 0.97, h * 0.34);
  ctx.closePath();
  ctx.fillStyle = o.color;
  ctx.fill();
  ctx.restore();
}, true);
def('starBurst', 'פיצוץ כוכב', 1, { color: '#ffd60a', color2: '#111111' }, (ctx, w, h, o) => {
  const rot = o.animate ? o.t * 18 : 0;
  const pul = o.animate ? 1 + 0.04 * Math.sin(TAU * o.t * 1.6) : 1;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, rot, pul);
  fillOutlined(ctx, () => { ctx.beginPath(); starPoly(ctx, w / 2, h / 2, h * 0.47, 14, 0.7); }, o.color, o.color2, h * 0.022);
  ctx.beginPath(); starPoly(ctx, w / 2, h / 2, h * 0.32, 14, 0.74, -90 + 180 / 14);
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();
  ctx.restore();
  if (o.text) drawLabel(ctx, o.text, w / 2, h / 2, h * 0.26, o.color2, { maxW: w * 0.6 });
}, true);
def('speechBubble', 'בועת דיבור', 1.25, { color: '#ffffff', color2: '#111111' }, (ctx, w, h, o) => {
  const outlinePath = () => {
    ctx.beginPath();
    roundRectPath(ctx, w * 0.04, h * 0.05, w * 0.92, h * 0.68, h * 0.2, false);
    ctx.moveTo(w * 0.26, h * 0.7); ctx.lineTo(w * 0.17, h * 0.95); ctx.lineTo(w * 0.46, h * 0.7); ctx.closePath();
  };
  fillOutlined(ctx, outlinePath, o.color, o.color2, h * 0.03);
  drawLabel(ctx, o.text ?? 'היי!', w / 2, h * 0.39, h * 0.3, o.color2, { maxW: w * 0.8 });
});
def('thoughtBubble', 'בועת מחשבה', 1.25, { color: '#ffffff', color2: '#111111' }, (ctx, w, h, o) => {
  const circles = [[0.3, 0.36, 0.2], [0.5, 0.26, 0.22], [0.7, 0.36, 0.2], [0.62, 0.52, 0.19], [0.38, 0.52, 0.19], [0.5, 0.44, 0.22]];
  const path = () => {
    ctx.beginPath();
    for (const [x, y, r] of circles) { ctx.moveTo(w * x + h * r, h * y); ctx.arc(w * x, h * y, h * r, 0, TAU); }
    ctx.moveTo(w * 0.24 + h * 0.07, h * 0.78); ctx.arc(w * 0.24, h * 0.78, h * 0.07, 0, TAU);
    ctx.moveTo(w * 0.14 + h * 0.04, h * 0.92); ctx.arc(w * 0.14, h * 0.92, h * 0.04, 0, TAU);
  };
  fillOutlined(ctx, path, o.color, o.color2, h * 0.025);
  if (o.text) drawLabel(ctx, o.text, w / 2, h * 0.41, h * 0.22, o.color2, { maxW: w * 0.62 });
  else {
    ctx.fillStyle = o.color2;
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(w / 2 + i * h * 0.13, h * 0.42, h * 0.04, 0, TAU); ctx.fill(); }
  }
});
def('checkmark', 'וי', 1, { color: '#22c55e', color2: '#ffffff' }, (ctx, w, h, o) => {
  const pop = o.animate ? outBack(o.t / 0.28) : 1;
  const draw = o.animate ? out3((o.t - 0.15) / 0.3) : 1;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, 0, Math.max(0.001, pop));
  ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.46, 0, TAU); ctx.fillStyle = o.color; ctx.fill();
  const pts = [[0.27, 0.52], [0.43, 0.68], [0.74, 0.34]];
  const L1 = Math.hypot(0.16, 0.16), L2 = Math.hypot(0.31, 0.34), L = L1 + L2;
  const d = draw * L;
  ctx.beginPath();
  ctx.moveTo(w * pts[0][0], h * pts[0][1]);
  if (d <= L1) { const k = d / L1; ctx.lineTo(w * (0.27 + 0.16 * k), h * (0.52 + 0.16 * k)); }
  else { ctx.lineTo(w * pts[1][0], h * pts[1][1]); const k = (d - L1) / L2; ctx.lineTo(w * (0.43 + 0.31 * k), h * (0.68 - 0.34 * k)); }
  ctx.lineWidth = h * 0.11; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = o.color2;
  if (draw > 0) ctx.stroke();
  ctx.restore();
}, true);
def('xMark', 'איקס', 1, { color: '#ef4444', color2: '#ffffff' }, (ctx, w, h, o) => {
  const pop = o.animate ? outBack(o.t / 0.28) : 1;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, o.animate ? (1 - out3(o.t / 0.3)) * -40 : 0, Math.max(0.001, pop));
  ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.46, 0, TAU); ctx.fillStyle = o.color; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.32, h * 0.32); ctx.lineTo(w * 0.68, h * 0.68);
  ctx.moveTo(w * 0.68, h * 0.32); ctx.lineTo(w * 0.32, h * 0.68);
  ctx.lineWidth = h * 0.11; ctx.lineCap = 'round'; ctx.strokeStyle = o.color2; ctx.stroke();
  ctx.restore();
}, true);
def('bell', 'פעמון', 1, { color: '#ffcc00', color2: '#7a5200' }, (ctx, w, h, o) => {
  let ang = 0;
  if (o.animate) { const ph = o.t % 2; const amp = ph < 1.1 ? 18 * (1 - ph / 1.1) : 0; ang = amp * Math.sin(TAU * 3.5 * ph); }
  ctx.save();
  rotateAbout(ctx, w / 2, h * 0.1, ang);
  const body = () => {
    ctx.beginPath();
    ctx.moveTo(w * 0.2, h * 0.72);
    ctx.bezierCurveTo(w * 0.2, h * 0.3, w * 0.32, h * 0.15, w * 0.5, h * 0.15);
    ctx.bezierCurveTo(w * 0.68, h * 0.15, w * 0.8, h * 0.3, w * 0.8, h * 0.72);
    ctx.lineTo(w * 0.89, h * 0.81);
    ctx.lineTo(w * 0.11, h * 0.81);
    ctx.closePath();
    ctx.moveTo(w * 0.5 + h * 0.06, h * 0.11); ctx.arc(w * 0.5, h * 0.11, h * 0.06, 0, TAU);
    ctx.moveTo(w * 0.5 + h * 0.085, h * 0.86); ctx.arc(w * 0.5, h * 0.86, h * 0.085, 0, TAU);
  };
  fillOutlined(ctx, body, o.color, o.color2, h * 0.022);
  ctx.beginPath(); ctx.moveTo(w * 0.33, h * 0.62); ctx.quadraticCurveTo(w * 0.33, h * 0.3, w * 0.48, h * 0.24);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = h * 0.045; ctx.lineCap = 'round'; ctx.stroke();
  ctx.restore();
  if (o.animate && Math.abs(ang) > 3) {
    ctx.strokeStyle = o.color; ctx.lineWidth = h * 0.035; ctx.lineCap = 'round';
    ctx.globalAlpha = Math.min(1, Math.abs(ang) / 10);
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.arc(w / 2, h * 0.45, h * 0.5, (s > 0 ? -25 : 205) * DEG, (s > 0 ? 5 : 175) * DEG, s < 0); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}, true);
def('heart', 'לב', 1, { color: '#ff2d55' }, (ctx, w, h, o) => {
  let s = 1;
  if (o.animate) { const b = (o.t * 1.2) % 1; s = 1 + 0.1 * Math.exp(-((b - 0.1) ** 2) / 0.003) + 0.06 * Math.exp(-((b - 0.3) ** 2) / 0.003); }
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, 0, s);
  heartPath(ctx, w * 0.05, h * 0.08, w * 0.9, h * 0.86);
  ctx.fillStyle = o.color; ctx.fill();
  ctx.beginPath(); ctx.ellipse(w * 0.3, h * 0.3, w * 0.1, h * 0.06, -35 * DEG, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.42)'; ctx.fill();
  ctx.restore();
}, true);
def('fire', 'אש', 0.8, { color: '#ff4d00', color2: '#ffd23f' }, (ctx, w, h, o) => {
  const sway = o.animate ? noise1(o.t * 3.2, 5) * w * 0.07 : 0;
  const sy = o.animate ? 1 + noise1(o.t * 4.1, 9) * 0.04 : 1;
  ctx.save();
  ctx.translate(0, h); ctx.scale(1, sy); ctx.translate(0, -h);
  const outer = () => {
    ctx.beginPath();
    ctx.moveTo(w * 0.5 + sway, h * 0.03);
    ctx.bezierCurveTo(w * 0.72, h * 0.28, w * 0.96, h * 0.48, w * 0.92, h * 0.7);
    ctx.bezierCurveTo(w * 0.88, h * 0.9, w * 0.7, h * 0.98, w * 0.5, h * 0.98);
    ctx.bezierCurveTo(w * 0.28, h * 0.98, w * 0.08, h * 0.88, w * 0.08, h * 0.68);
    ctx.bezierCurveTo(w * 0.08, h * 0.5, w * 0.22, h * 0.42, w * 0.28, h * 0.26);
    ctx.bezierCurveTo(w * 0.34, h * 0.36, w * 0.38, h * 0.42, w * 0.42, h * 0.44);
    ctx.bezierCurveTo(w * 0.4, h * 0.3, w * 0.44, h * 0.16, w * 0.5 + sway, h * 0.03);
    ctx.closePath();
  };
  outer();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, o.color2); g.addColorStop(0.55, o.color); g.addColorStop(1, '#d92800');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.5 + sway * 0.6, h * 0.4);
  ctx.bezierCurveTo(w * 0.64, h * 0.56, w * 0.76, h * 0.68, w * 0.73, h * 0.8);
  ctx.bezierCurveTo(w * 0.7, h * 0.93, w * 0.6, h * 0.97, w * 0.5, h * 0.97);
  ctx.bezierCurveTo(w * 0.38, h * 0.97, w * 0.27, h * 0.92, w * 0.27, h * 0.8);
  ctx.bezierCurveTo(w * 0.27, h * 0.66, w * 0.4, h * 0.56, w * 0.5 + sway * 0.6, h * 0.4);
  ctx.closePath();
  ctx.fillStyle = '#fff2a8'; ctx.fill();
  ctx.restore();
}, true);
def('sparkles', 'ניצוצות', 1, { color: '#ffd60a', color2: '#ffffff' }, (ctx, w, h, o) => {
  const stars = [[0.42, 0.52, 0.36, 0], [0.78, 0.22, 0.17, 0.33], [0.8, 0.76, 0.13, 0.66]];
  stars.forEach(([x, y, r, ph], i) => {
    const k = o.animate ? 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(TAU * (o.t * 1.3 + ph))) : 1;
    ctx.save();
    rotateAbout(ctx, w * x, h * y, o.animate ? Math.sin(TAU * (o.t * 0.5 + ph)) * 10 : 0);
    ctx.beginPath(); sparklePath(ctx, w * x, h * y, h * r * k);
    ctx.fillStyle = i === 0 ? o.color : o.color2; ctx.fill();
    ctx.restore();
  });
}, true);
def('clickCursor', 'סמן לחיצה', 0.85, { color: '#ffffff', color2: '#111111', accent: '#ffd60a' }, (ctx, w, h, o) => {
  const tipX = w * 0.3, tipY = h * 0.22;
  const ph = o.animate ? (o.t % 1.4) / 1.4 : 0.5;
  const press = o.animate && ph < 0.12 ? 0.88 : 1;
  if (o.animate) ripple(ctx, tipX, tipY, o.t, 1.4, h * 0.26, o.accent || '#ffd60a', h * 0.03);
  ctx.save();
  rotateAbout(ctx, tipX, tipY, 0, press);
  const k = h / 50 * 0.78;
  const path = () => {
    ctx.beginPath();
    const P = [[3, 2], [3, 42], [13, 33], [20, 48], [27, 45], [20, 30], [33, 30]];
    P.forEach(([x, y], i) => { const X = tipX + (x - 3) * k, Y = tipY + (y - 2) * k; if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
    ctx.closePath();
  };
  fillOutlined(ctx, path, o.color, o.color2, h * 0.028);
  ctx.restore();
}, true);
def('fingerTap', 'אצבע לוחצת', 0.85, { color: '#ffffff', color2: '#111111', accent: '#ffd60a' }, (ctx, w, h, o) => {
  const ph = o.animate ? (o.t % 1.2) / 1.2 : 0.6;
  const dy = o.animate ? (ph < 0.15 ? out2(ph / 0.15) : ph < 0.35 ? 1 - inOut2((ph - 0.15) / 0.2) : 0) * h * 0.05 : 0;
  const tipX = w * 0.42, tipY = h * 0.1;
  if (o.animate && ph < 0.6) ripple(ctx, tipX, tipY + h * 0.04, (ph) * 1.2, 1.2, h * 0.2, o.accent || '#ffd60a', h * 0.028);
  ctx.save();
  ctx.translate(0, dy);
  const path = () => {
    ctx.beginPath();
    roundRectPath(ctx, w * 0.33, h * 0.08, w * 0.19, h * 0.5, w * 0.095, false);           // index finger
    roundRectPath(ctx, w * 0.5, h * 0.36, w * 0.16, h * 0.26, w * 0.08, false);            // middle
    roundRectPath(ctx, w * 0.64, h * 0.41, w * 0.15, h * 0.24, w * 0.075, false);           // ring
    roundRectPath(ctx, w * 0.77, h * 0.47, w * 0.13, h * 0.2, w * 0.065, false);            // pinky
    roundRectPath(ctx, w * 0.3, h * 0.5, w * 0.6, h * 0.42, w * 0.16, false);               // palm
  };
  const thumb = () => {
    ctx.beginPath();
    ctx.save();
    rotateAbout(ctx, w * 0.27, h * 0.66, -38);
    roundRectPath(ctx, w * 0.12, h * 0.6, w * 0.34, h * 0.15, h * 0.075, false);
    ctx.restore();
  };
  const all = () => { path(); };
  // outline pass (under) then fill pass
  ctx.lineJoin = 'round';
  thumb(); ctx.strokeStyle = o.color2; ctx.lineWidth = h * 0.05; ctx.stroke();
  all(); ctx.stroke();
  thumb(); ctx.fillStyle = o.color; ctx.fill();
  all(); ctx.fill();
  // finger separation lines
  ctx.strokeStyle = o.color2; ctx.lineWidth = h * 0.014; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(w * 0.52, h * 0.5); ctx.lineTo(w * 0.52, h * 0.6);
  ctx.moveTo(w * 0.66, h * 0.52); ctx.lineTo(w * 0.66, h * 0.62);
  ctx.moveTo(w * 0.78, h * 0.56); ctx.lineTo(w * 0.78, h * 0.64);
  ctx.stroke();
  ctx.restore();
}, true);
def('magnifier', 'זכוכית מגדלת', 1, { color: '#1f2937', color2: '#ffd60a' }, (ctx, w, h, o) => {
  const sx = o.animate ? Math.sin(TAU * o.t * 0.6) * w * 0.05 : 0;
  ctx.save();
  ctx.translate(sx, 0);
  const cx = w * 0.42, cy = h * 0.42, r = h * 0.3;
  ctx.beginPath(); ctx.moveTo(cx + r * 0.72, cy + r * 0.72); ctx.lineTo(w * 0.88, h * 0.88);
  ctx.lineWidth = h * 0.13; ctx.lineCap = 'round'; ctx.strokeStyle = o.color; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = 'rgba(63,224,245,0.28)'; ctx.fill();
  ctx.lineWidth = h * 0.085; ctx.strokeStyle = o.color; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.68, 200 * DEG, 260 * DEG); ctx.lineWidth = h * 0.04; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.stroke();
  ctx.restore();
}, true);
def('playButton', 'כפתור ניגון', 1, { color: '#3b82f6', color2: '#ffffff' }, (ctx, w, h, o) => {
  if (o.animate) ripple(ctx, w / 2, h / 2, o.t, 1.6, h * 0.5, o.color, h * 0.03);
  const s = o.animate ? 1 + 0.03 * Math.sin(TAU * o.t * 1.25) : 1;
  ctx.save(); rotateAbout(ctx, w / 2, h / 2, 0, s);
  ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.4, 0, TAU); ctx.fillStyle = o.color; ctx.fill();
  ctx.beginPath(); ctx.moveTo(w * 0.42, h * 0.32); ctx.lineTo(w * 0.68, h * 0.5); ctx.lineTo(w * 0.42, h * 0.68); ctx.closePath();
  ctx.lineJoin = 'round'; ctx.lineWidth = h * 0.05; ctx.strokeStyle = o.color2; ctx.fillStyle = o.color2; ctx.fill(); ctx.stroke();
  ctx.restore();
}, true);
def('searchBar', 'שורת חיפוש', 5.2, { color: '#ffffff', color2: '#3b82f6', ink: '#1f2937' }, (ctx, w, h, o) => {
  const pad = h * 0.08;
  ctx.save();
  ctx.shadowColor = 'rgba(19,182,228,0.6)';
  ctx.shadowBlur = h * 0.28 * (o.devScale || 1);
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, h);
  ctx.fillStyle = o.color; ctx.fill();
  ctx.restore();
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, h);
  ctx.lineWidth = h * 0.045; ctx.strokeStyle = o.color2; ctx.stroke();
  // magnifier on the left
  const mx = pad + h * 0.48, my = h / 2, mr = h * 0.15;
  ctx.beginPath(); ctx.arc(mx, my - h * 0.02, mr, 0, TAU);
  ctx.moveTo(mx + mr * 0.72, my - h * 0.02 + mr * 0.72); ctx.lineTo(mx + mr * 1.55, my - h * 0.02 + mr * 1.55);
  ctx.lineWidth = h * 0.06; ctx.lineCap = 'round'; ctx.strokeStyle = o.ink || '#1f2937'; ctx.stroke();
  const full = o.text ?? 'yoursite.com';
  const chars = Array.from(full);
  const typed = o.animate ? Math.round(chars.length * clamp01((o.t - 0.3) / 0.8)) : chars.length;
  const txt = chars.slice(0, typed).join('');
  const dir = detectDir(full) || 'ltr';
  const size = h * 0.42;
  ctx.font = fontString('Assistant', 800, size, false);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const avail = w - pad * 2 - h * 1.15;
  let fs = size;
  const fullW = ctx.measureText(full).width;
  if (fullW > avail) { fs = size * avail / fullW; ctx.font = fontString('Assistant', 800, fs, false); }
  ctx.fillStyle = o.ink || '#1f2937';
  ctx.textBaseline = 'middle';
  ctx.direction = dir;
  const x0 = pad + h * 0.86;
  let caretX;
  if (dir === 'rtl') { ctx.textAlign = 'right'; const xr = w - pad - h * 0.3; ctx.fillText(txt, xr, h / 2 + fs * 0.04); caretX = xr - ctx.measureText(txt).width - fs * 0.08; }
  else { ctx.textAlign = 'left'; ctx.fillText(txt, x0, h / 2 + fs * 0.04); caretX = x0 + ctx.measureText(txt).width + fs * 0.08; }
  const typing = o.animate && o.t >= 0.3 && typed < chars.length;
  const blinkOn = !o.animate ? false : typing || (o.t < 0.3) || Math.floor((o.t - 1.1) / 0.5) % 2 === 0;
  if (blinkOn) { ctx.fillStyle = o.color2; ctx.fillRect(caretX, h / 2 - fs * 0.5, Math.max(2, fs * 0.07), fs); }
}, true);
def('subscribeButton', 'כפתור הרשמה', 3.2, { color: '#e5484d', color2: '#ffffff', done: '#3a3f47' }, (ctx, w, h, o) => {
  const pressT = 1.0;
  const pressed = o.animate && o.t >= pressT;
  const dip = o.animate && o.t >= pressT && o.t < pressT + 0.2 ? 0.93 : 1;
  const pulse = !pressed && o.animate ? 1 + 0.025 * Math.sin(TAU * o.t * 1.5) : 1;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, 0, dip * pulse);
  roundRectPath(ctx, w * 0.03, h * 0.12, w * 0.94, h * 0.76, h);
  ctx.fillStyle = pressed ? (o.done || '#3a3f47') : o.color; ctx.fill();
  // bell icon at the right (RTL start)
  const bx = w * 0.82, by = h * 0.5, bs = h * 0.36;
  ctx.beginPath();
  ctx.moveTo(bx - bs * 0.42, by + bs * 0.28);
  ctx.bezierCurveTo(bx - bs * 0.42, by - bs * 0.25, bx - bs * 0.25, by - bs * 0.5, bx, by - bs * 0.5);
  ctx.bezierCurveTo(bx + bs * 0.25, by - bs * 0.5, bx + bs * 0.42, by - bs * 0.25, bx + bs * 0.42, by + bs * 0.28);
  ctx.lineTo(bx + bs * 0.55, by + bs * 0.4); ctx.lineTo(bx - bs * 0.55, by + bs * 0.4); ctx.closePath();
  ctx.moveTo(bx + bs * 0.14, by + bs * 0.52); ctx.arc(bx, by + bs * 0.52, bs * 0.14, 0, TAU);
  ctx.fillStyle = o.color2; ctx.fill();
  drawLabel(ctx, pressed ? (o.text2 ?? 'נרשמתם ✓') : (o.text ?? 'הירשמו'), w * 0.42, h * 0.5, h * 0.36, o.color2, { maxW: w * 0.58 });
  ctx.restore();
}, true);
def('likeButton', 'לייק', 1, { color: '#3b82f6', color2: '#ffffff' }, (ctx, w, h, o) => {
  const pop = o.animate ? outBack(o.t / 0.3) : 1;
  const rot = o.animate ? Math.sin(TAU * o.t * 0.8) * 6 * Math.min(1, o.t / 0.4) : 0;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, rot, Math.max(0.001, pop));
  ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.46, 0, TAU); ctx.fillStyle = o.color; ctx.fill();
  ctx.fillStyle = o.color2;
  roundRectPath(ctx, w * 0.24, h * 0.47, w * 0.12, h * 0.3, w * 0.025); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.4, h * 0.47);
  ctx.lineTo(w * 0.5, h * 0.26);
  ctx.quadraticCurveTo(w * 0.555, h * 0.16, w * 0.6, h * 0.24);
  ctx.lineTo(w * 0.58, h * 0.42);
  ctx.lineTo(w * 0.72, h * 0.42);
  ctx.quadraticCurveTo(w * 0.79, h * 0.43, w * 0.78, h * 0.5);
  ctx.lineTo(w * 0.74, h * 0.73);
  ctx.quadraticCurveTo(w * 0.72, h * 0.77, w * 0.67, h * 0.77);
  ctx.lineTo(w * 0.4, h * 0.77);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}, true);
def('musicNotes', 'תווים', 1, { color: '#ffd60a', color2: '#000000' }, (ctx, w, h, o) => {
  const bob = o.animate ? Math.sin(TAU * o.t * 0.9) * h * 0.035 : 0;
  const rot = o.animate ? Math.sin(TAU * o.t * 0.6) * 6 : 0;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, rot);
  ctx.translate(0, bob);
  const draw = (fill, grow) => {
    ctx.fillStyle = fill; ctx.strokeStyle = fill; ctx.lineCap = 'round';
    for (const [x, y] of [[0.3, 0.76], [0.7, 0.66]]) { ctx.beginPath(); ctx.ellipse(w * x, h * y, h * 0.13 + grow, h * 0.095 + grow, -22 * DEG, 0, TAU); ctx.fill(); }
    ctx.lineWidth = h * 0.06 + grow * 2;
    ctx.beginPath(); ctx.moveTo(w * 0.41, h * 0.73); ctx.lineTo(w * 0.41, h * 0.16); ctx.moveTo(w * 0.81, h * 0.63); ctx.lineTo(w * 0.81, h * 0.06); ctx.stroke();
    ctx.lineWidth = h * 0.11 + grow * 2;
    ctx.beginPath(); ctx.moveTo(w * 0.41, h * 0.17); ctx.lineTo(w * 0.81, h * 0.07); ctx.stroke();
  };
  draw(o.color2, h * 0.025);
  draw(o.color, 0);
  ctx.restore();
}, true);
def('lightning', 'ברק', 0.8, { color: '#ffd60a', color2: '#111111' }, (ctx, w, h, o) => {
  const flash = o.animate ? (hashFlash(o.t) ? 1 : 0) : 0;
  const P = [[0.62, 0.02], [0.12, 0.56], [0.46, 0.56], [0.32, 0.98], [0.9, 0.38], [0.54, 0.38], [0.74, 0.02]];
  const path = () => { ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(w * x, h * y) : ctx.moveTo(w * x, h * y))); ctx.closePath(); };
  if (flash) { ctx.save(); ctx.shadowColor = o.color; ctx.shadowBlur = h * 0.25 * (o.devScale || 1); path(); ctx.fillStyle = o.color; ctx.fill(); ctx.restore(); }
  fillOutlined(ctx, path, flash ? '#fff7c2' : o.color, o.color2, h * 0.025);
}, true);
function hashFlash(t) { const f = Math.floor(t * 10); return (f % 17 === 0) || (f % 17 === 2); }
def('exclamation', 'סימן קריאה', 1, { color: '#ff3b30', color2: '#ffffff' }, (ctx, w, h, o) => {
  const sh = o.animate ? noise1(o.t * 16, 3) * 5 : 0;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, sh);
  ctx.beginPath(); starPoly(ctx, w / 2, h / 2, h * 0.47, 12, 0.78);
  ctx.fillStyle = o.color; ctx.fill();
  drawLabel(ctx, '!', w / 2, h * 0.5, h * 0.55, o.color2, { dir: 'ltr' });
  ctx.restore();
}, true);
def('newBadge', 'תג "חדש!"', 1, { color: '#ff2d55', color2: '#ffffff' }, (ctx, w, h, o) => {
  const rot = -12 + (o.animate ? Math.sin(TAU * o.t * 0.5) * 4 : 0);
  const s = o.animate ? 1 + 0.035 * Math.sin(TAU * o.t * 1.4) : 1;
  ctx.save();
  rotateAbout(ctx, w / 2, h / 2, rot, s);
  ctx.beginPath(); starPoly(ctx, w / 2, h / 2, h * 0.47, 20, 0.86);
  ctx.fillStyle = o.color; ctx.fill();
  ctx.beginPath(); ctx.arc(w / 2, h / 2, h * 0.34, 0, TAU); ctx.lineWidth = h * 0.015; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke();
  drawLabel(ctx, o.text ?? 'חדש!', w / 2, h / 2, h * 0.24, o.color2, { maxW: h * 0.6 });
  ctx.restore();
}, true);
def('pin', 'סיכת מיקום', 0.8, { color: '#ff3b30', color2: '#ffffff' }, (ctx, w, h, o) => {
  let dy = 0;
  if (o.animate) { const ph = (o.t % 1.8) / 1.8; dy = ph < 0.35 ? -Math.sin(Math.PI * ph / 0.35) * h * 0.08 : 0; }
  ctx.beginPath(); ctx.ellipse(w / 2, h * 0.95, w * 0.2 * (1 + dy / h), h * 0.035, 0, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();
  ctx.save(); ctx.translate(0, dy);
  const cx = w / 2, cy = h * 0.36, r = w * 0.4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 145 * DEG, 35 * DEG);
  ctx.quadraticCurveTo(cx + r * 0.55, cy + r * 1.1, cx, h * 0.93);
  ctx.quadraticCurveTo(cx - r * 0.55, cy + r * 1.1, cx + Math.cos(145 * DEG) * r, cy + Math.sin(145 * DEG) * r);
  ctx.closePath();
  ctx.fillStyle = o.color; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.42, 0, TAU); ctx.fillStyle = o.color2; ctx.fill();
  ctx.restore();
}, true);
def('crown', 'כתר', 1.25, { color: '#ffcc00', color2: '#a86b00' }, (ctx, w, h, o) => {
  const rot = o.animate ? Math.sin(TAU * o.t * 0.5) * 5 : 0;
  ctx.save(); rotateAbout(ctx, w / 2, h * 0.8, rot);
  const P = [[0.08, 0.78], [0.08, 0.3], [0.3, 0.52], [0.5, 0.18], [0.7, 0.52], [0.92, 0.3], [0.92, 0.78]];
  const body = () => {
    ctx.beginPath();
    P.forEach(([x, y], i) => (i ? ctx.lineTo(w * x, h * y) : ctx.moveTo(w * x, h * y)));
    ctx.closePath();
    roundRectPath(ctx, w * 0.06, h * 0.76, w * 0.88, h * 0.14, h * 0.04, false);
    for (const [x, y] of [[0.08, 0.27], [0.5, 0.14], [0.92, 0.27]]) { ctx.moveTo(w * x + h * 0.06, h * y); ctx.arc(w * x, h * y, h * 0.06, 0, TAU); }
  };
  fillOutlined(ctx, body, o.color, o.color2, h * 0.02);
  for (const [x, c] of [[0.3, '#ff3b5c'], [0.5, '#ffd60a'], [0.7, '#22c55e']]) { ctx.beginPath(); ctx.arc(w * x, h * 0.66, h * 0.05, 0, TAU); ctx.fillStyle = c; ctx.fill(); }
  ctx.restore();
}, true);
def('timer', 'שעון עצר', 0.88, { color: '#ffffff', color2: '#111111', accent: '#ff3b30' }, (ctx, w, h, o) => {
  const cx = w / 2, cy = h * 0.57, r = h * 0.38;
  ctx.fillStyle = o.color2;
  roundRectPath(ctx, cx - w * 0.09, h * 0.04, w * 0.18, h * 0.09, h * 0.02); ctx.fill();
  ctx.fillRect(cx - w * 0.035, h * 0.12, w * 0.07, h * 0.08);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = o.color2; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, TAU); ctx.fillStyle = o.color; ctx.fill();
  ctx.strokeStyle = o.color2; ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    ctx.lineWidth = i % 3 === 0 ? h * 0.03 : h * 0.016;
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r * 0.72, cy - Math.cos(a) * r * 0.72); ctx.lineTo(cx + Math.sin(a) * r * 0.8, cy - Math.cos(a) * r * 0.8); ctx.stroke();
  }
  const a = o.animate ? (o.t / 5) * TAU : 0.35 * TAU;
  ctx.strokeStyle = o.accent || '#ff3b30'; ctx.lineWidth = h * 0.04;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(a) * r * 0.66, cy - Math.cos(a) * r * 0.66); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, h * 0.04, 0, TAU); ctx.fillStyle = o.accent || '#ff3b30'; ctx.fill();
}, true);
def('soundWave', 'גלי קול', 1.6, { color: '#ffd60a', color2: '#3b82f6' }, (ctx, w, h, o) => {
  const n = 9;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, o.color); g.addColorStop(1, o.color2);
  ctx.strokeStyle = g; ctx.lineCap = 'round';
  const bw = (w * 0.86) / n;
  ctx.lineWidth = bw * 0.55;
  for (let i = 0; i < n; i++) {
    const base = 0.25 + 0.6 * Math.exp(-(((i - (n - 1) / 2) / 2.6) ** 2));
    const v = o.animate ? base * (0.45 + 0.55 * Math.abs(Math.sin(o.t * (3.1 + i * 0.37) + i * 1.7))) : base;
    const bh = Math.max(bw * 0.6, h * 0.9 * v);
    const x = w * 0.07 + bw * (i + 0.5);
    ctx.beginPath(); ctx.moveTo(x, h / 2 - bh / 2 + ctx.lineWidth / 2); ctx.lineTo(x, h / 2 + bh / 2 - ctx.lineWidth / 2); ctx.stroke();
  }
}, true);
def('recDot', 'הקלטה REC', 2.4, { color: '#ff3b30', color2: '#ffffff' }, (ctx, w, h, o) => {
  roundRectPath(ctx, w * 0.02, h * 0.1, w * 0.96, h * 0.8, h); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();
  const on = !o.animate || Math.floor(o.t * 1.6) % 2 === 0;
  ctx.beginPath(); ctx.arc(w * 0.24, h / 2, h * 0.2, 0, TAU); ctx.fillStyle = on ? o.color : 'rgba(255,59,48,0.25)'; ctx.fill();
  drawLabel(ctx, o.text ?? 'REC', w * 0.62, h / 2, h * 0.42, o.color2, { weight: 800, dir: 'ltr', maxW: w * 0.5 });
}, true);
def('chordBox', 'דיאגרמת אקורד', 0.82, { color: '#ffffff', color2: '#1f2937', accent: '#3b82f6' }, (ctx, w, h, o) => {
  const name = o.chord && CHORDS[o.chord] ? o.chord : (o.text && CHORDS[o.text] ? o.text : 'Am');
  const frets = CHORDS[name];
  roundRectPath(ctx, w * 0.03, h * 0.02, w * 0.94, h * 0.96, h * 0.07);
  ctx.fillStyle = o.color; ctx.fill();
  drawLabel(ctx, name, w / 2, h * 0.13, h * 0.13, '#000000', { dir: 'ltr' });
  const gx = w * 0.2, gw = w * 0.6, gy = h * 0.3, gh = h * 0.58, nF = 4;
  ctx.strokeStyle = o.color2; ctx.lineCap = 'butt';
  for (let s = 0; s < 6; s++) { ctx.lineWidth = h * 0.009; ctx.beginPath(); ctx.moveTo(gx + (gw * s) / 5, gy); ctx.lineTo(gx + (gw * s) / 5, gy + gh); ctx.stroke(); }
  for (let f = 0; f <= nF; f++) { ctx.lineWidth = f === 0 ? h * 0.03 : h * 0.009; ctx.beginPath(); ctx.moveTo(gx - h * 0.005, gy + (gh * f) / nF); ctx.lineTo(gx + gw + h * 0.005, gy + (gh * f) / nF); ctx.stroke(); }
  const barre = name === 'F';
  if (barre) { roundRectPath(ctx, gx - w * 0.03, gy + gh / nF * 0.5 - h * 0.035, gw + w * 0.06, h * 0.07, h * 0.035); ctx.fillStyle = o.accent; ctx.fill(); }
  frets.forEach((f, s) => {
    const x = gx + (gw * s) / 5;
    if (f < 0) {
      const y = gy - h * 0.06, r = h * 0.025;
      ctx.lineWidth = h * 0.012; ctx.strokeStyle = o.color2;
      ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
    } else if (f === 0) {
      ctx.beginPath(); ctx.arc(x, gy - h * 0.06, h * 0.025, 0, TAU); ctx.lineWidth = h * 0.012; ctx.strokeStyle = o.color2; ctx.stroke();
    } else if (!(barre && f === 1)) {
      ctx.beginPath(); ctx.arc(x, gy + (gh * (f - 0.5)) / nF, h * 0.045, 0, TAU); ctx.fillStyle = o.accent; ctx.fill();
    }
  });
});
def('guitarPick', 'מפרט גיטרה', 0.86, { color: '#3b82f6', color2: '#ffd60a' }, (ctx, w, h, o) => {
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.97);
  ctx.bezierCurveTo(w * 0.2, h * 0.75, w * 0.03, h * 0.42, w * 0.07, h * 0.2);
  ctx.bezierCurveTo(w * 0.11, h * 0.04, w * 0.3, h * 0.02, w * 0.5, h * 0.02);
  ctx.bezierCurveTo(w * 0.7, h * 0.02, w * 0.89, h * 0.04, w * 0.93, h * 0.2);
  ctx.bezierCurveTo(w * 0.97, h * 0.42, w * 0.8, h * 0.75, w * 0.5, h * 0.97);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, o.color2); g.addColorStop(1, o.color);
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.ellipse(w * 0.34, h * 0.2, w * 0.14, h * 0.06, -20 * DEG, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fill();
  if (o.text) drawLabel(ctx, o.text, w / 2, h * 0.42, h * 0.16, '#000000', { maxW: w * 0.7 });
});
def('loading', 'טעינה', 1, { color: '#ffd60a' }, (ctx, w, h, o) => {
  const n = 12;
  const head = o.animate ? Math.floor(o.t * 12) % n : 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const age = (head - i + n) % n;
    ctx.globalAlpha = 0.15 + 0.85 * Math.pow(1 - age / n, 2);
    ctx.beginPath(); ctx.arc(w / 2 + Math.sin(a) * h * 0.36, h / 2 - Math.cos(a) * h * 0.36, h * 0.065, 0, TAU);
    ctx.fillStyle = o.color; ctx.fill();
  }
  ctx.globalAlpha = 1;
}, true);
def('swipeUp', 'החלקה למעלה', 0.72, { color: '#ffffff' }, (ctx, w, h, o) => {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = o.color; ctx.lineWidth = h * 0.06;
  for (let i = 0; i < 3; i++) {
    const ph = o.animate ? ((o.t * 1.2 + i / 3) % 1) : i / 3;
    const y = h * (0.78 - ph * 0.55);
    ctx.globalAlpha = Math.sin(Math.PI * ph);
    ctx.beginPath(); ctx.moveTo(w * 0.18, y + h * 0.12); ctx.lineTo(w * 0.5, y - h * 0.04); ctx.lineTo(w * 0.82, y + h * 0.12); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (o.text) drawLabel(ctx, o.text, w / 2, h * 0.94, h * 0.09, o.color, { weight: 800, maxW: w * 1.2 });
}, true);

const THUMB_T = { subscribeButton: 0.6, bell: 0.35, clickCursor: 0.35, fingerTap: 0.1, playButton: 0.5 };
for (const b of B) b.thumbT = THUMB_T[b.id] ?? 1.5;
const BUILTIN_BY_ID = new Map(B.map((b) => [b.id, b]));
export function getBuiltinSticker(id) { return BUILTIN_BY_ID.get(id) || null; }

/** Public sticker catalog (plain data). */
export const STICKERS = [
  ...EMOJI.map(([id, value, name]) => ({ id: 'emoji-' + id, name, kind: 'emoji', value, category: 'אימוג׳י' })),
  ...B.map((b) => ({ id: 'builtin-' + b.id, name: b.name, kind: 'builtin', value: b.id, category: 'מדבקות', animated: b.animated, aspect: b.aspect, thumbT: b.thumbT })),
];
export function getSticker(id) { return STICKERS.find((s) => s.id === id || (s.value === id)) || null; }

/** Box size (canvas px, without padding) of a sticker. size = height. */
export function stickerBox(st) {
  const size = Math.max(4, num(st.size, 220));
  if (st.kind === 'builtin') {
    const b = BUILTIN_BY_ID.get(st.value);
    const aspect = b ? b.aspect : 1;
    return { w: size * aspect, h: size };
  }
  return { w: size, h: size };
}
export function stickerPad(st) {
  const { h } = stickerBox(st);
  let pad = h * 0.12 + 2;
  if (st.outline && num(st.outline.width, 0) > 0) pad += num(st.outline.width, 0);
  if (st.shadow && isVisibleColor(st.shadow.color)) pad += num(st.shadow.blur, 0) * 1.5 + Math.max(Math.abs(num(st.shadow.x, 0)), Math.abs(num(st.shadow.y, 0)));
  return Math.ceil(pad);
}
export function stickerIsAnimated(st) {
  if (st.kind !== 'builtin' || st.animate === false) return false;
  const b = BUILTIN_BY_ID.get(st.value);
  return !!(b && b.animated);
}

/** Draw a sticker with its box at (0,0)-(w,h) in current user space. */
export function drawStickerContent(ctx, st, t, devScale = 1) {
  const { w, h } = stickerBox(st);
  if (st.kind === 'builtin') {
    const b = BUILTIN_BY_ID.get(st.value) || BUILTIN_BY_ID.get('starBurst');
    const o = {
      t: Math.max(0, t), animate: st.animate !== false, devScale,
      color: st.color || b.colors.color, color2: st.color2 || b.colors.color2, accent: st.accent || b.colors.accent,
      ink: b.colors.ink, done: b.colors.done, text: st.text, text2: st.text2, chord: st.chord,
    };
    ctx.save();
    b.draw(ctx, w, h, o);
    ctx.restore();
    return;
  }
  // emoji: fit the glyph's ink box into the sticker box
  const value = String(st.value || '🔥');
  const ref = 100;
  ctx.save();
  ctx.font = `${ref}px ${EMOJI_FONT_STACK}, sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = 'ltr';
  const m = ctx.measureText(value);
  const L = num(m.actualBoundingBoxLeft, 0), R = num(m.actualBoundingBoxRight, m.width || ref);
  const A = num(m.actualBoundingBoxAscent, ref * 0.8), D = num(m.actualBoundingBoxDescent, ref * 0.2);
  const inkW = Math.max(1, L + R), inkH = Math.max(1, A + D);
  const k = Math.min(w / inkW, h / inkH) * 0.96;
  ctx.font = `${ref * k}px ${EMOJI_FONT_STACK}, sans-serif`;
  const x = w / 2 - ((R - L) / 2) * k;
  const y = h / 2 + ((A - D) / 2) * k;
  ctx.fillStyle = st.color || '#ffffff';
  ctx.fillText(value, x, y);
  ctx.restore();
}
