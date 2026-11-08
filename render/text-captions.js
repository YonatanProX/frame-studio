// Frame Studio — caption styles (CAPTION_STYLES) and per-word caption state evaluation.
// One caption clip = one on-screen chunk of 1–6 words; words carry ABSOLUTE timeline times {w,s,e,hot}.
// Active word: words[i].s <= t < words[i+1].s (last word: until e + 0.15). Hot words use hotColor.
// Upcoming words keep their layout slot (transparent) so the line never moves when a word appears.
// Pure module (no DOM).

import { clamp01, EASE, outBack, outBackPop, outBounce, spring } from './text-util.js';

const { out2, out3, in2 } = EASE;

export const ACTIVE_TAIL = 0.15;

/** Index of the active word at time t (absolute), or -1. */
export function captionActiveIndex(words, t) {
  if (!Array.isArray(words) || !words.length) return -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const s = Number(w.s) || 0;
    const end = i + 1 < words.length ? Number(words[i + 1].s) || 0 : (Number(w.e) || s) + ACTIVE_TAIL;
    if (t >= s && t < end) return i;
  }
  return -1;
}

const DARK = '#000000';
const PAPER = '#ffffff';

// text overrides per style (merged over the model's default text block)
const popText = {
  font: 'Heebo', weight: 900, size: 98, color: PAPER, align: 'center', lineHeight: 1.08, letterSpacing: 0, maxWidth: 1000,
  stroke: { color: DARK, width: 14 }, shadow: { color: 'rgba(0,0,0,0.6)', blur: 30, x: 0, y: 10 },
  background: { color: '#000000', opacity: 0, padding: 24, radius: 24 }, glow: { color: '#ffd60a', blur: 0 }, gradient: null,
  wordSpacing: 24, balance: true,
};

export const CAPTION_STYLES = [
  { id: 'popWords', name: 'מילים קופצות — קפיצה ועלייה', description: 'Heebo 900, קו מתאר כהה וצל. כל מילה קופצת מ-1.28 ל-1 ועולה 30px בדיוק כשנאמרת; המילה הנוכחית בצהוב, מילים חמות באדום.',
    defaults: { text: popText, activeColor: '#ffd60a', hotColor: '#ff4d6d' } },
  { id: 'popSlam', name: 'מילים קופצות — מילה חמה נוחתת', description: 'כמו "מילים קופצות", ומילים חמות נוחתות גדולות פי 1.9 ומוטות.',
    defaults: { text: popText, activeColor: '#ffd60a', hotColor: '#ff4d6d' } },
  { id: 'pill', name: 'גלולה לבנה', description: 'מלבן לבן מעוגל, טקסט שחור במשקל 800. מתחלף בפריים אחד, בלי אנימציה.',
    defaults: { text: { font: 'Heebo', weight: 800, size: 72, color: '#111111', lineHeight: 1.3, maxWidth: 940, stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0.35)', blur: 18, x: 0, y: 6 }, background: { color: '#ffffff', opacity: 1, padding: 22, radius: 20, mode: 'line' }, balance: true },
    activeColor: '#111111', hotColor: '#e8590c' } },
  { id: 'kinetic', name: 'קינטי', description: 'מילים קופצות מטשטוש עם קפיץ קל; המילה החמה כבדה וגדולה יותר עם קו תחתון שנמתח.',
    defaults: { text: { font: 'Heebo', weight: 800, size: 92, color: '#ffffff', lineHeight: 1.12, maxWidth: 960, stroke: { color: '#0b0f14', width: 8 },
      shadow: { color: 'rgba(0,0,0,0.5)', blur: 20, x: 0, y: 6 }, balance: true, wordSpacing: 6 },
    activeColor: '#ffffff', hotColor: '#ffd60a' } },
  { id: 'karaoke', name: 'קריוקי', description: 'כל מילות המקטע לבנות; המילה הנאמרת צבועה וגדלה ל-1.12.',
    defaults: { text: { font: 'Heebo', weight: 800, size: 88, color: '#ffffff', lineHeight: 1.12, maxWidth: 960, stroke: { color: '#000000', width: 10 },
      shadow: { color: 'rgba(0,0,0,0.55)', blur: 16, x: 0, y: 5 }, balance: true, wordSpacing: 16 },
    activeColor: '#ffd60a', hotColor: '#ff4d6d' } },
  { id: 'boldPop', name: 'מילה ענקית', description: 'מילה אחת בכל פעם, ענקית, עם קו מתאר וקפיצה.',
    defaults: { text: { font: 'Heebo', weight: 900, size: 150, color: '#ffffff', lineHeight: 1.05, maxWidth: 1000, stroke: { color: '#000000', width: 18 },
      shadow: { color: 'rgba(0,0,0,0.6)', blur: 24, x: 0, y: 8 } },
    activeColor: '#ffffff', hotColor: '#ffd60a' } },
  { id: 'boxHighlight', name: 'תיבה מדגישה', description: 'המילה הנאמרת מקבלת תיבה צבעונית מעוגלת מאחוריה.',
    defaults: { text: { font: 'Heebo', weight: 800, size: 84, color: '#ffffff', lineHeight: 1.25, maxWidth: 940, stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0.55)', blur: 14, x: 0, y: 4 }, balance: true, wordSpacing: 14 },
    activeColor: '#7c5cff', hotColor: '#ffd60a', activeTextColor: '#ffffff' } },
  { id: 'minimal', name: 'מינימליסטי', description: 'טקסט לבן עם צל רך, נכנס ויוצא בדעיכה.',
    defaults: { text: { font: 'Heebo', weight: 600, size: 64, color: '#ffffff', lineHeight: 1.2, maxWidth: 900, stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0.55)', blur: 18, x: 0, y: 3 }, balance: true },
    activeColor: '#ffffff', hotColor: '#ffe08a' } },
  { id: 'typewriter', name: 'מכונת כתיבה', description: 'האותיות מופיעות לפי סדר הדיבור.',
    defaults: { text: { font: 'Heebo', weight: 700, size: 78, color: '#ffffff', lineHeight: 1.15, maxWidth: 940, stroke: { color: '#000000', width: 8 },
      shadow: { color: 'rgba(0,0,0,0.5)', blur: 12, x: 0, y: 4 }, balance: true },
    activeColor: '#ffffff', hotColor: '#ffd60a' } },
  { id: 'neon', name: 'ניאון', description: 'זוהר ציאן; מילים שעוד לא נאמרו עמומות, המילה הנאמרת זוהרת חזק.',
    defaults: { text: { font: 'Heebo', weight: 800, size: 90, color: '#f4fdff', lineHeight: 1.15, maxWidth: 960, stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 }, glow: { color: '#ffd60a', blur: 26 }, balance: true, wordSpacing: 6 },
    activeColor: '#ffffff', hotColor: '#ff4fd8' } },
  { id: 'highlighter', name: 'מרקר', description: 'פס מרקר צהוב נמתח מאחורי המילה הנאמרת.',
    defaults: { text: { font: 'Heebo', weight: 900, size: 86, color: '#ffffff', lineHeight: 1.2, maxWidth: 960, stroke: { color: '#111111', width: 10 },
      shadow: { color: 'rgba(0,0,0,0.45)', blur: 12, x: 0, y: 4 }, balance: true, wordSpacing: 10 },
    activeColor: '#ffd60a', hotColor: '#ff4d6d', activeTextColor: '#111111' } },
  { id: 'wordByWord', name: 'מילה אחר מילה', description: 'מילה אחת בכל פעם, בלי אנימציה.',
    defaults: { text: { font: 'Heebo', weight: 900, size: 130, color: '#ffffff', lineHeight: 1.05, maxWidth: 1000, stroke: { color: '#000000', width: 14 },
      shadow: { color: 'rgba(0,0,0,0.55)', blur: 18, x: 0, y: 6 } },
    activeColor: '#ffffff', hotColor: '#ffd60a' } },
  { id: 'bounce', name: 'נחיתה קופצנית', description: 'כל מילה נופלת מלמעלה ונוחתת בקפיצה כשהיא נאמרת.',
    defaults: { text: { font: 'Heebo', weight: 900, size: 96, color: '#ffffff', lineHeight: 1.1, maxWidth: 980, stroke: { color: '#1a1a1a', width: 12 },
      shadow: { color: 'rgba(0,0,0,0.5)', blur: 16, x: 0, y: 6 }, balance: true, wordSpacing: 10 },
    activeColor: '#5ef38c', hotColor: '#ff4d6d' } },
  { id: 'softFade', name: 'חשיפה רכה', description: 'מילים נחשפות בעדינות מטשטוש קל, בגופן Assistant.',
    defaults: { text: { font: 'Assistant', weight: 700, size: 74, color: '#ffffff', lineHeight: 1.18, maxWidth: 940, stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0.6)', blur: 20, x: 0, y: 4 }, balance: true, wordSpacing: 4 },
    activeColor: '#ffffff', hotColor: '#ffd479' } },
];

const BY_ID = new Map(CAPTION_STYLES.map((s) => [s.id, s]));
export function getCaptionStyle(id) { return BY_ID.get(id) || BY_ID.get('karaoke'); }

/** Static per-word layout overrides (size/weight) — must not depend on time so the line never moves. */
export function captionUnitProps(styleId, word) {
  if (styleId === 'kinetic' && word && word.hot) return { sizeMul: 1.22, weight: 900 };
  return null;
}
/** Styles that show a single word at a time (each word laid out alone, centered). */
export function captionIsSingle(styleId) { return styleId === 'boldPop' || styleId === 'wordByWord'; }
/** Styles that need per-character states. */
export function captionNeedsChars(styleId) { return styleId === 'typewriter'; }

/**
 * Evaluate a caption style.
 * @param {string} styleId
 * @param {object} c { t (absolute), words:[{w,s,e,hot}], start, end (clip), size, color (base), active, hot, activeText,
 *                     unitChars(i) → [global char indices], nChars, unitWidth(i) → px, gap (px between words) }
 * @returns {{words:Array<state|null>, chars?:Array, boxes?:Array, single?:number, visible:boolean}}
 *   state: {o,x,y,s,sx,sy,r,b,c,sc,g,gc,ul,ulc}; boxes[i] = {color, alpha, scale, mode:'box'|'marker', grow}
 */
export function evalCaption(styleId, c) {
  const W = c.words;
  const n = W.length;
  const t = c.t;
  const act = captionActiveIndex(W, t);
  const scaleK = c.size / 98;
  const out = { words: new Array(n), chars: null, boxes: null, single: -1, active: act };
  const colorOf = (i, activeCol = c.active) => (W[i].hot ? c.hot : (i === act ? activeCol : c.color));
  const st = (o) => ({ o: 1, x: 0, y: 0, s: 1, sx: 1, sy: 1, r: 0, b: 0, ...o });
  switch (styleId) {
    case 'popWords':
    case 'popSlam': {
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (t < w.s) { out.words[i] = st({ o: 0 }); continue; }
        const a = (t - w.s) / 0.13;
        if (styleId === 'popSlam' && w.hot) {
          out.words[i] = st({ s: 1.9 - 0.9 * outBackPop(a / 1.5), r: -7 * (1 - out3(a / 1.5)), y: (1 - out3(a)) * 40 * scaleK, c: colorOf(i) });
        } else {
          out.words[i] = st({ s: 1.28 - 0.28 * outBackPop(a), y: (1 - out3(a)) * 30 * scaleK, c: colorOf(i) });
        }
      }
      break;
    }
    case 'pill': {
      for (let i = 0; i < n; i++) out.words[i] = st({ c: colorOf(i) });
      break;
    }
    case 'kinetic': {
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (t < w.s) { out.words[i] = st({ o: 0 }); continue; }
        const p = (t - w.s) / 0.3;
        const s0 = st({
          o: out2(clamp01(p * 2.2)), b: (1 - out3(p)) * 0.16 * c.size, s: 0.7 + 0.3 * spring(p, 0.5, 13),
          y: (1 - out3(p)) * 0.12 * c.size, c: colorOf(i),
        });
        if (w.hot) { s0.ul = out3((t - w.s - 0.05) / 0.3); s0.ulc = c.hot; }
        out.words[i] = s0;
      }
      break;
    }
    case 'karaoke': {
      for (let i = 0; i < n; i++) {
        const w = W[i];
        let k = 0;
        if (i === act) {
          const end = i + 1 < n ? W[i + 1].s : w.e + ACTIVE_TAIL;
          k = clamp01((t - w.s) / 0.08) * (1 - clamp01((t - end + 0.08) / 0.08));
        }
        // grow at most into 35% of the word gap on each side so the active word never touches its neighbours
        const uw = c.unitWidth ? c.unitWidth(i) : 0;
        const maxGrow = uw > 0 && c.gap > 0 ? Math.min(0.12, (0.7 * c.gap) / uw) : 0.12;
        out.words[i] = st({ s: 1 + maxGrow * out2(k), c: w.hot && i !== act ? c.hot : (i === act ? c.active : c.color) });
      }
      break;
    }
    case 'boldPop':
    case 'wordByWord': {
      let idx = act;
      if (idx < 0 && n && t >= W[n - 1].s) idx = n - 1; // hold the last word until the chunk ends
      out.single = idx;
      for (let i = 0; i < n; i++) out.words[i] = st({ o: 0 });
      if (idx >= 0) {
        const w = W[idx];
        if (styleId === 'boldPop') {
          const p = (t - w.s) / 0.16;
          out.words[idx] = st({ o: clamp01(p * 5), s: 1.45 - 0.45 * outBack(p), r: (idx % 2 ? 3 : -3) * (1 - out3(p)), c: w.hot ? c.hot : c.color });
        } else {
          out.words[idx] = st({ c: w.hot ? c.hot : c.color });
        }
      }
      break;
    }
    case 'boxHighlight': {
      out.boxes = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (i === act) {
          const p = (t - w.s) / 0.12;
          out.boxes[i] = { color: c.active, alpha: clamp01(p * 4), scale: 0.85 + 0.15 * outBack(p), mode: 'box' };
          out.words[i] = st({ c: c.activeText || '#ffffff', s: 1 + 0.04 * (1 - out3(p)) });
        } else out.words[i] = st({ c: w.hot ? c.hot : c.color });
      }
      break;
    }
    case 'minimal': {
      const fin = out2((t - c.start) / 0.18);
      const fout = 1 - in2((t - (c.end - 0.18)) / 0.18);
      for (let i = 0; i < n; i++) out.words[i] = st({ o: clamp01(Math.min(fin, fout)), c: W[i].hot ? c.hot : c.color });
      break;
    }
    case 'typewriter': {
      out.chars = new Array(c.nChars).fill(null);
      for (let i = 0; i < n; i++) {
        const w = W[i];
        out.words[i] = st({ c: w.hot ? c.hot : (i === act ? c.active : c.color) });
        const idx = c.unitChars(i);
        const span = Math.max(0.04, Math.min(Math.max(0.05, (w.e || w.s) - w.s), 0.35));
        for (let k = 0; k < idx.length; k++) {
          const at = w.s + (k / Math.max(1, idx.length)) * span;
          out.chars[idx[k]] = t >= at ? null : { o: 0 };
        }
      }
      break;
    }
    case 'neon': {
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (t < w.s) { out.words[i] = st({ o: 0.28, c: w.hot ? c.hot : c.color }); continue; }
        if (i === act) {
          const p = (t - w.s) / 0.15;
          out.words[i] = st({ o: 1, s: 1 + 0.06 * out2(clamp01(p)), g: 1.2, c: w.hot ? c.hot : c.active, gc: w.hot ? c.hot : undefined });
        } else out.words[i] = st({ c: w.hot ? c.hot : c.color, gc: w.hot ? c.hot : undefined });
      }
      break;
    }
    case 'highlighter': {
      out.boxes = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (i === act) {
          const p = (t - w.s) / 0.16;
          out.boxes[i] = { color: c.active, alpha: 0.95, scale: 1, mode: 'marker', grow: out3(p) };
          out.words[i] = st({ c: c.activeText || '#111111', sc: c.active });
        } else out.words[i] = st({ c: w.hot ? c.hot : c.color });
      }
      break;
    }
    case 'bounce': {
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (t < w.s) { out.words[i] = st({ o: 0 }); continue; }
        const p = (t - w.s) / 0.42;
        out.words[i] = st({ o: clamp01(p * 6), y: -(1 - outBounce(p)) * 0.75 * c.size, c: colorOf(i) });
      }
      break;
    }
    case 'softFade': {
      for (let i = 0; i < n; i++) {
        const w = W[i];
        if (t < w.s) { out.words[i] = st({ o: 0 }); continue; }
        const p = (t - w.s) / 0.28;
        out.words[i] = st({ o: out2(p), y: (1 - out3(p)) * 0.1 * c.size, b: (1 - out3(p)) * 0.07 * c.size, c: colorOf(i) });
      }
      break;
    }
    default: {
      for (let i = 0; i < n; i++) out.words[i] = st({ c: colorOf(i) });
    }
  }
  return out;
}
