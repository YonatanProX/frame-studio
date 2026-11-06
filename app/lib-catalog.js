// Frame Studio — catalog access for the library panel & timeline (agent L).
// Loads shared/catalog.js getCatalog() (render-side catalogs) and fills any missing list with the spec ids
// (SPEC §4, §8) so the UI stays usable while a render module is missing. Ids are exactly the spec ids.

const FALLBACK = {
  transitions: [
    ['crossfade', 'מעבר הדרגתי', 'בסיסי', 0.5], ['dipBlack', 'דרך שחור', 'בסיסי', 0.6], ['dipWhite', 'דרך לבן', 'בסיסי', 0.6],
    ['flashWhite', 'הבזק', 'בסיסי', 0.4], ['slideLeft', 'החלקה שמאלה', 'החלקה', 0.5], ['slideRight', 'החלקה ימינה', 'החלקה', 0.5],
    ['slideUp', 'החלקה למעלה', 'החלקה', 0.5], ['slideDown', 'החלקה למטה', 'החלקה', 0.5], ['pushLeft', 'דחיפה שמאלה', 'החלקה', 0.5],
    ['pushRight', 'דחיפה ימינה', 'החלקה', 0.5], ['pushUp', 'דחיפה למעלה', 'החלקה', 0.5], ['pushDown', 'דחיפה למטה', 'החלקה', 0.5],
    ['coverLeft', 'כיסוי שמאלה', 'החלקה', 0.5], ['coverRight', 'כיסוי ימינה', 'החלקה', 0.5], ['wipeLeft', 'ניגוב שמאלה', 'ניגוב', 0.5],
    ['wipeRight', 'ניגוב ימינה', 'ניגוב', 0.5], ['wipeUp', 'ניגוב למעלה', 'ניגוב', 0.5], ['wipeDown', 'ניגוב למטה', 'ניגוב', 0.5],
    ['wipeDiagonal', 'ניגוב אלכסוני', 'ניגוב', 0.5], ['clockWipe', 'שעון', 'ניגוב', 0.6], ['blinds', 'תריסים', 'ניגוב', 0.6],
    ['splitReveal', 'חשיפה מפוצלת', 'ניגוב', 0.6], ['circleOpen', 'עיגול נפתח', 'צורות', 0.6], ['circleClose', 'עיגול נסגר', 'צורות', 0.6],
    ['diamond', 'יהלום', 'צורות', 0.6], ['squares', 'ריבועים', 'צורות', 0.7], ['zoomIn', 'זום פנימה', 'זום', 0.5],
    ['zoomOut', 'זום החוצה', 'זום', 0.5], ['zoomBlur', 'זום מהיר', 'זום', 0.4], ['crossZoom', 'זום צולב', 'זום', 0.6],
    ['whipLeft', 'הצלפה שמאלה', 'קולנועי', 0.35], ['whipRight', 'הצלפה ימינה', 'קולנועי', 0.35], ['spin', 'סיבוב', 'זום', 0.5],
    ['swirl', 'מערבולת', 'דיגיטלי', 0.7], ['ripple', 'אדוות', 'דיגיטלי', 0.7], ['pixelate', 'פיקסלים', 'דיגיטלי', 0.5],
    ['glitch', 'גליץ׳', 'דיגיטלי', 0.4], ['rgbSplit', 'פיצול RGB', 'דיגיטלי', 0.4], ['filmBurn', 'צריבת פילם', 'קולנועי', 0.8],
    ['lumaDissolve', 'התמוססות', 'קולנועי', 0.8], ['shake', 'רעידה', 'קולנועי', 0.4], ['cube', 'קובייה', 'תלת־ממד', 0.7],
    ['doorway', 'דלתות', 'תלת־ממד', 0.7], ['pageFlip', 'דף מתהפך', 'תלת־ממד', 0.7],
  ].map(([id, name, category, defaultDuration]) => ({ id, name, category, defaultDuration, params: [] })),
  effects: [
    ['blur', 'טשטוש', 'בסיסי'], ['directionalBlur', 'טשטוש כיווני', 'בסיסי'], ['zoomBlur', 'טשטוש זום', 'תנועה'], ['radialBlur', 'טשטוש סיבובי', 'תנועה'],
    ['shake', 'רעידה', 'תנועה'], ['zoomPunch', 'פאנץ׳ זום', 'תנועה'], ['flash', 'הבזק', 'אור'], ['strobe', 'סטרובו', 'אור'],
    ['glitch', 'גליץ׳', 'דיגיטלי'], ['rgbSplit', 'פיצול RGB', 'דיגיטלי'], ['vhs', 'VHS', 'רטרו'], ['filmGrain', 'גרעיניות פילם', 'רטרו'],
    ['scanlines', 'קווי סריקה', 'רטרו'], ['crt', 'מסך CRT', 'רטרו'], ['vignette', 'וינייט', 'בסיסי'], ['lightLeak', 'דליפת אור', 'אור'],
    ['bloom', 'זוהר', 'אור'], ['neonEdges', 'קצוות ניאון', 'אמנותי'], ['pixelate', 'פיקסלים', 'דיגיטלי'], ['mosaicBlocks', 'פסיפס', 'דיגיטלי'],
    ['mirror', 'מראה', 'עיוות'], ['kaleidoscope', 'קליידוסקופ', 'עיוות'], ['invert', 'היפוך צבעים', 'צבע'], ['posterize', 'פוסטר', 'אמנותי'],
    ['duotone', 'דואוטון', 'צבע'], ['blackWhite', 'שחור-לבן', 'צבע'], ['sepia', 'ספיה', 'צבע'], ['halftone', 'רסטר', 'אמנותי'],
    ['sharpen', 'חידוד', 'בסיסי'], ['shockwave', 'גל הלם', 'עיוות'], ['whip', 'שובל תנועה', 'תנועה'], ['letterbox', 'פסים קולנועיים', 'קולנועי'],
    ['wave', 'גלים', 'עיוות'], ['fisheye', 'עין דג', 'עיוות'], ['tvOff', 'כיבוי טלוויזיה', 'רטרו'], ['colorPop', 'צבע בודד', 'צבע'],
    ['lensDistortion', 'עיוות עדשה', 'עיוות'], ['chromaticAberration', 'סטייה כרומטית', 'דיגיטלי'], ['rainbow', 'קשת', 'אמנותי'], ['heatHaze', 'אוויר חם', 'עיוות'],
  ].map(([id, name, category]) => ({ id, name, category, params: [] })),
  filters: [
    ['natural', 'טבעי', { contrast: 0.05, saturation: 0.05 }], ['vivid', 'חי', { saturation: 0.35, vibrance: 0.25, contrast: 0.12 }],
    ['cinematic', 'קולנועי', { contrast: 0.2, saturation: -0.1, temperature: -0.05, fade: 0.08, vignette: 0.25 }],
    ['tealOrange', 'טורקיז-כתום', { contrast: 0.15, saturation: 0.15, temperature: 0.05, tint: -0.05 }],
    ['warm', 'חם', { temperature: 0.3, saturation: 0.08 }], ['cool', 'קר', { temperature: -0.3, tint: 0.04 }],
    ['vintage', 'וינטג׳', { saturation: -0.25, fade: 0.25, temperature: 0.15, contrast: -0.05 }], ['fadeMatte', 'מט דהוי', { fade: 0.35, contrast: -0.12 }],
    ['blackWhite', 'שחור-לבן', { saturation: -1, contrast: 0.1 }], ['noir', 'נואר', { saturation: -1, contrast: 0.45, exposure: -0.1, vignette: 0.4 }],
    ['sepia', 'ספיה', { saturation: -0.75, temperature: 0.45, fade: 0.1 }], ['dramatic', 'דרמטי', { contrast: 0.4, saturation: -0.15, shadows: -0.2, vignette: 0.35 }],
    ['pastel', 'פסטל', { saturation: -0.2, brightness: 0.12, fade: 0.2, contrast: -0.15 }], ['sunset', 'שקיעה', { temperature: 0.45, tint: 0.12, saturation: 0.2 }],
    ['moody', 'מלנכולי', { exposure: -0.15, saturation: -0.3, temperature: -0.12, fade: 0.12 }], ['neonNight', 'לילה ניאון', { saturation: 0.4, tint: 0.25, temperature: -0.3, contrast: 0.2 }],
    ['film', 'פילם', { contrast: 0.12, fade: 0.12, grain: 0.3, saturation: -0.05 }], ['retro80', 'רטרו 80', { tint: 0.2, saturation: 0.25, fade: 0.15, hue: -8 }],
    ['summer', 'קיץ', { temperature: 0.2, saturation: 0.25, brightness: 0.08 }], ['winter', 'חורף', { temperature: -0.35, saturation: -0.15, brightness: 0.05 }],
    ['chordix', 'Chordix', { temperature: -0.25, tint: -0.05, contrast: 0.18, saturation: 0.1, shadows: -0.1 }], ['cleanSkin', 'עור נקי', { brightness: 0.06, contrast: -0.05, saturation: -0.05, temperature: 0.06 }],
  ].map(([id, name, color]) => ({ id, name, color })),
  clipAnims: {
    in: ['none:ללא', 'fadeIn:הופעה', 'zoomIn:זום פנימה', 'zoomOut:זום החוצה', 'slideLeft:החלקה משמאל', 'slideRight:החלקה מימין', 'slideUp:החלקה מלמטה',
      'slideDown:החלקה מלמעלה', 'pop:קפיצה', 'bounceIn:ניתור', 'spinIn:סיבוב', 'blurIn:מטושטש לחד', 'dropIn:נפילה', 'swingIn:נדנוד', 'flipIn:היפוך',
      'stretchIn:מתיחה', 'glitchIn:גליץ׳', 'whipIn:הצלפה'],
    out: ['none:ללא', 'fadeOut:היעלמות', 'zoomIn:זום פנימה', 'zoomOut:זום החוצה', 'slideLeft:החלקה שמאלה', 'slideRight:החלקה ימינה', 'slideUp:החלקה למעלה',
      'slideDown:החלקה למטה', 'popOut:קפיצה החוצה', 'spinOut:סיבוב', 'blurOut:טשטוש', 'dropOut:נפילה', 'flipOut:היפוך', 'whipOut:הצלפה'],
    loop: ['none:ללא', 'pulse:פעימה', 'float:ריחוף', 'shake:רעידה', 'wobble:התנודדות', 'spin:סיבוב', 'swing:נדנדה', 'heartbeat:דופק', 'flicker:הבהוב',
      'kenBurns:קן ברנס', 'drift:סחיפה', 'breathe:נשימה', 'jiggle:ריטוט'],
  },
  textAnims: {
    in: ['none:ללא', 'typewriter:מכונת כתיבה', 'wordPop:מילים קופצות', 'wordSlideUp:מילים עולות', 'charFade:אותיות מופיעות', 'charDrop:אותיות נופלות',
      'blurIn:מטושטש לחד', 'glitchType:הקלדת גליץ׳', 'scaleWords:מילים גדלות', 'karaokeFill:קריוקי', 'bounceWords:מילים מנתרות'],
    out: ['none:ללא', 'fadeOut:היעלמות', 'wordPop:מילים קופצות', 'charFade:אותיות נעלמות', 'blurOut:טשטוש'],
    loop: ['none:ללא', 'wave:גל', 'shimmer:נצנוץ', 'pulse:פעימה'],
  },
  captionStyles: [
    ['chordix', 'Chordix', { text: { font: 'Heebo', weight: 900, size: 98, color: '#f4efe6', stroke: { color: '#071822', width: 14 } }, activeColor: '#3fe0f5', hotColor: '#ff8a66' }],
    ['pill', 'גלולה לבנה', { text: { font: 'Heebo', weight: 800, size: 80, color: '#000000', background: { color: '#ffffff', opacity: 1, padding: 22, radius: 20 } }, activeColor: '#000000', hotColor: '#e5484d' }],
    ['kinetic', 'קינטי', { text: { font: 'Heebo', weight: 900, size: 92, color: '#ffffff' }, activeColor: '#3fe0f5', hotColor: '#ff8a66' }],
    ['karaoke', 'קריוקי', { text: { font: 'Heebo', weight: 800, size: 86, color: '#ffffff', stroke: { color: '#000000', width: 10 } }, activeColor: '#f5c518', hotColor: '#ff8a66' }],
    ['boldPop', 'מילה ענקית', { text: { font: 'Heebo', weight: 900, size: 150, color: '#ffffff', stroke: { color: '#000000', width: 16 } }, activeColor: '#ffffff', hotColor: '#f5c518' }],
    ['boxHighlight', 'הדגשה בקופסה', { text: { font: 'Heebo', weight: 800, size: 86, color: '#ffffff' }, activeColor: '#7c4dff', hotColor: '#ff8a66' }],
    ['minimal', 'מינימלי', { text: { font: 'Heebo', weight: 600, size: 70, color: '#ffffff', shadow: { color: 'rgba(0,0,0,0.6)', blur: 16, x: 0, y: 3 } }, activeColor: '#ffffff', hotColor: '#3fe0f5' }],
    ['typewriter', 'מכונת כתיבה', { text: { font: 'Assistant', weight: 700, size: 76, color: '#ffffff' }, activeColor: '#ffffff', hotColor: '#3fe0f5' }],
  ].map(([id, name, defaults]) => ({ id, name, defaults })),
  textPresets: [
    ['title', 'כותרת', { content: 'כותרת ראשית', font: 'Heebo', weight: 900, size: 120, color: '#ffffff', stroke: { color: '#000000', width: 0 } }],
    ['subtitle', 'כתובית משנה', { content: 'כתובית משנה', font: 'Heebo', weight: 600, size: 64, color: '#e7e9ec' }],
    ['neonCyan', 'ניאון ציאן', { content: 'ניאון', font: 'Heebo', weight: 800, size: 110, color: '#3fe0f5', glow: { color: '#13b6e4', blur: 30 } }],
    ['outlineBold', 'קו מתאר', { content: 'קו מתאר', font: 'Heebo', weight: 900, size: 110, color: '#ffffff', stroke: { color: '#000000', width: 12 } }],
    ['whitePill', 'גלולה לבנה', { content: 'גלולה', font: 'Heebo', weight: 800, size: 72, color: '#000000', background: { color: '#ffffff', opacity: 1, padding: 24, radius: 40 } }],
    ['blackBox', 'קופסה שחורה', { content: 'קופסה', font: 'Heebo', weight: 800, size: 72, color: '#ffffff', background: { color: '#000000', opacity: 0.85, padding: 24, radius: 12 } }],
    ['yellowHighlight', 'הדגשה צהובה', { content: 'הדגשה', font: 'Heebo', weight: 900, size: 90, color: '#000000', background: { color: '#f5c518', opacity: 1, padding: 18, radius: 8 } }],
    ['chordixBrand', 'מותג Chordix', { content: 'Chordix', font: 'Heebo', weight: 900, size: 110, color: '#f4efe6', stroke: { color: '#071822', width: 12 } }],
  ].map(([id, name, text]) => ({ id, name, text, textAnim: { in: 'wordPop', out: 'none', loop: 'none' } })),
  stickers: [
    ...['🔥', '⭐', '✨', '💥', '❤️', '😂', '😍', '😮', '😱', '🤯', '🤔', '👍', '👏', '🙌', '👀', '💯', '✅', '❌', '⚡', '🎵', '🎶', '🎸', '🎹', '🎤',
      '🎧', '🥁', '🎉', '🎁', '🚀', '💡', '📌', '📍', '🔔', '⏰', '💰', '🏆', '👑', '💎', '🌈', '☀️', '🌙', '⬆️', '➡️', '⬅️', '⬇️', '👉', '👈', '☝️']
      .map((v, i) => ({ id: `emoji${i}`, name: v, kind: 'emoji', value: v })),
    ...[['arrow', 'חץ'], ['circleHighlight', 'עיגול הדגשה'], ['underlineSwoosh', 'קו תחתון'], ['starBurst', 'פיצוץ כוכב'], ['speechBubble', 'בועת דיבור'],
      ['checkmark', 'וי'], ['xMark', 'איקס'], ['bell', 'פעמון הרשמה'], ['heart', 'לב'], ['fire', 'אש'], ['sparkles', 'ניצוצות'], ['clickCursor', 'סמן לחיצה'],
      ['fingerTap', 'הקשה'], ['magnifier', 'זכוכית מגדלת'], ['playButton', 'כפתור נגינה'], ['searchBar', 'שורת חיפוש']]
      .map(([v, name]) => ({ id: v, name, kind: 'builtin', value: v })),
  ],
  shapes: [
    ['rect', 'מלבן'], ['roundrect', 'מלבן מעוגל'], ['ellipse', 'אליפסה'], ['line', 'קו'], ['arrow', 'חץ'], ['star', 'כוכב'], ['triangle', 'משולש'],
    ['heart', 'לב'], ['burst', 'פיצוץ'], ['progress', 'פס התקדמות'],
  ].map(([kind, name]) => ({ id: kind, name, kind, shape: { kind, w: kind === 'line' || kind === 'progress' ? 600 : 400, h: kind === 'line' ? 12 : kind === 'progress' ? 40 : 400, fill: '#13b6e4' } })),
};

const toAnims = (lists) => Object.fromEntries(Object.entries(lists).map(([k, arr]) => [k, arr.map((s) => { const [id, name] = s.split(':'); return { id, name }; })]));
FALLBACK.clipAnims = toAnims(FALLBACK.clipAnims);
FALLBACK.textAnims = toAnims(FALLBACK.textAnims);

let catalog = null;
let loadingP = null;
let textRender = null;
let textRenderTried = false;

const nonEmpty = (a) => Array.isArray(a) && a.length > 0;
const groupsNonEmpty = (g) => g && ['in', 'out', 'loop'].some((k) => nonEmpty(g[k]));

/**
 * Normalized catalog: { transitions, effects, filters, clipAnims, textAnims, captionStyles, textPresets, stickers, shapes, luts, fallback:{…bool} }
 */
export function loadCatalog({ reload = false } = {}) {
  if (catalog && !reload) return Promise.resolve(catalog);
  if (loadingP && !reload) return loadingP;
  loadingP = (async () => {
    let cat = null;
    try {
      const mod = await import('../shared/catalog.js');
      cat = mod.getCatalog ? await mod.getCatalog(reload ? { reload: true } : undefined) : null;
    } catch (e) { console.warn('[library] shared/catalog.js לא נטען', e); }
    const out = { fallback: {} };
    const pick = (key, ok) => {
      if (cat && ok(cat[key])) out[key] = cat[key];
      else { out[key] = FALLBACK[key]; out.fallback[key] = true; }
    };
    pick('transitions', nonEmpty); pick('effects', nonEmpty); pick('filters', nonEmpty);
    pick('captionStyles', nonEmpty); pick('textPresets', nonEmpty); pick('stickers', nonEmpty); pick('shapes', nonEmpty);
    pick('clipAnims', groupsNonEmpty); pick('textAnims', groupsNonEmpty);
    out.errors = (cat && cat.errors) || [];
    catalog = out;
    loadingP = null;
    return out;
  })();
  return loadingP;
}

export function catalogSync() { return catalog; }

export function transitionById(id) {
  const list = (catalog && catalog.transitions) || FALLBACK.transitions;
  return list.find((t) => t.id === id) || null;
}

/** text-render.js (agent T) drawThumbnail, or null when unavailable. */
export async function getTextRender() {
  if (textRenderTried) return textRender;
  textRenderTried = true;
  try { textRender = await import('../render/text-render.js'); } catch (e) { console.warn('[library] render/text-render.js לא נטען — תצוגות מקדימות פשוטות', e); textRender = null; }
  return textRender;
}

// ───────────────────────── 2D preview drawing (thumbnails; original code) ─────────────────────────

const sceneCache = new Map();
/** A small procedural "photo": sky gradient, sun, hills, a figure. variant 0 = A (day/cyan), 1 = B (sunset/coral). */
export function sampleScene(w, h, variant = 0) {
  const key = `${w}x${h}:${variant}`;
  if (sceneCache.has(key)) return sceneCache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h);
  if (variant === 0) { sky.addColorStop(0, '#1b6fa8'); sky.addColorStop(0.6, '#5cc6e8'); sky.addColorStop(1, '#bfeaf5'); }
  else { sky.addColorStop(0, '#2d1b4e'); sky.addColorStop(0.55, '#c8546b'); sky.addColorStop(1, '#ffb36b'); }
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = variant === 0 ? '#fff6c9' : '#ffd27a';
  g.beginPath(); g.arc(w * (variant ? 0.3 : 0.72), h * 0.36, h * 0.13, 0, Math.PI * 2); g.fill();
  g.fillStyle = variant === 0 ? '#2f8f5b' : '#5a2a4a';
  g.beginPath(); g.moveTo(0, h * 0.72);
  for (let x = 0; x <= w; x += 4) g.lineTo(x, h * 0.72 - Math.sin(x / w * Math.PI * 2 + variant) * h * 0.07 - h * 0.03);
  g.lineTo(w, h); g.lineTo(0, h); g.fill();
  g.fillStyle = variant === 0 ? '#1f6b44' : '#3a1733';
  g.beginPath(); g.moveTo(0, h * 0.86);
  for (let x = 0; x <= w; x += 4) g.lineTo(x, h * 0.84 - Math.cos(x / w * Math.PI * 3) * h * 0.05);
  g.lineTo(w, h); g.lineTo(0, h); g.fill();
  // figure
  g.fillStyle = variant === 0 ? '#16324a' : '#1b0f22';
  const fx = w * (variant ? 0.66 : 0.36), fy = h * 0.62;
  g.beginPath(); g.arc(fx, fy - h * 0.15, h * 0.055, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(fx, fy, h * 0.07, h * 0.1, 0, 0, Math.PI * 2); g.fill();
  sceneCache.set(key, c);
  return c;
}

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Draw one frame of a transition preview (p in 0..1). */
export function drawTransitionPreview(ctx, w, h, id, p) {
  const A = sampleScene(w, h, 0), B = sampleScene(w, h, 1);
  const e = ease(clamp01(p));
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const both = (fa, fb) => { ctx.save(); fa(); ctx.restore(); ctx.save(); fb(); ctx.restore(); };
  const clipRect = (x, y, rw, rh) => { ctx.beginPath(); ctx.rect(x, y, rw, rh); ctx.clip(); };
  switch (true) {
    case /^dip(Black|White)$/.test(id): {
      const col = id === 'dipBlack' ? '#000' : '#fff';
      ctx.drawImage(e < 0.5 ? A : B, 0, 0);
      ctx.globalAlpha = 1 - Math.abs(e - 0.5) * 2; ctx.fillStyle = col; ctx.fillRect(0, 0, w, h);
      break;
    }
    case id === 'flashWhite': {
      ctx.drawImage(e < 0.5 ? A : B, 0, 0);
      ctx.globalAlpha = Math.pow(1 - Math.abs(e - 0.5) * 2, 0.5); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      break;
    }
    case /^(slide|push|cover)(Left|Right|Up|Down)$/.test(id): {
      const m = /^(slide|push|cover)(Left|Right|Up|Down)$/.exec(id);
      const dx = m[2] === 'Left' ? -1 : m[2] === 'Right' ? 1 : 0, dy = m[2] === 'Up' ? -1 : m[2] === 'Down' ? 1 : 0;
      const ax = m[1] === 'cover' ? 0 : dx * w * e, ay = m[1] === 'cover' ? 0 : dy * h * e;
      ctx.drawImage(A, ax * (m[1] === 'slide' ? 0.3 : 1), ay * (m[1] === 'slide' ? 0.3 : 1));
      ctx.drawImage(B, -dx * w * (1 - e), -dy * h * (1 - e));
      break;
    }
    case /^wipe(Left|Right|Up|Down|Diagonal)$/.test(id) || id === 'splitReveal': {
      ctx.drawImage(A, 0, 0);
      ctx.save();
      if (id === 'wipeLeft') clipRect(w * (1 - e), 0, w * e, h);
      else if (id === 'wipeRight') clipRect(0, 0, w * e, h);
      else if (id === 'wipeUp') clipRect(0, h * (1 - e), w, h * e);
      else if (id === 'wipeDown') clipRect(0, 0, w, h * e);
      else if (id === 'splitReveal') clipRect(w / 2 - (w / 2) * e, 0, w * e, h);
      else { ctx.beginPath(); const d = (w + h) * e; ctx.moveTo(0, 0); ctx.lineTo(d, 0); ctx.lineTo(0, d); ctx.closePath(); ctx.clip(); }
      ctx.drawImage(B, 0, 0);
      ctx.restore();
      break;
    }
    case id === 'clockWipe': {
      ctx.drawImage(A, 0, 0);
      ctx.save(); ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.arc(w / 2, h / 2, w + h, -Math.PI / 2, -Math.PI / 2 + e * Math.PI * 2); ctx.closePath(); ctx.clip();
      ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    }
    case id === 'blinds': {
      ctx.drawImage(A, 0, 0);
      ctx.save(); ctx.beginPath();
      const n = 6; for (let i = 0; i < n; i++) ctx.rect(0, i * h / n, w, (h / n) * e);
      ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    }
    case /^(circleOpen|circleClose|diamond)$/.test(id): {
      const R = Math.hypot(w, h) / 2;
      if (id === 'circleClose') {
        ctx.drawImage(B, 0, 0);
        ctx.save(); ctx.beginPath(); ctx.arc(w / 2, h / 2, R * (1 - e), 0, Math.PI * 2); ctx.clip(); ctx.drawImage(A, 0, 0); ctx.restore();
      } else {
        ctx.drawImage(A, 0, 0);
        ctx.save(); ctx.beginPath();
        if (id === 'diamond') { const r = R * 1.42 * e; ctx.moveTo(w / 2, h / 2 - r); ctx.lineTo(w / 2 + r, h / 2); ctx.lineTo(w / 2, h / 2 + r); ctx.lineTo(w / 2 - r, h / 2); ctx.closePath(); }
        else ctx.arc(w / 2, h / 2, R * e, 0, Math.PI * 2);
        ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
      }
      break;
    }
    case id === 'squares': {
      ctx.drawImage(A, 0, 0);
      const n = 6, m = Math.ceil(n * h / w), cw = w / n, ch = h / m;
      ctx.save(); ctx.beginPath();
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const k = clamp01(e * 2 - ((i * 7 + j * 3) % 10) / 10);
        if (k > 0) ctx.rect(i * cw + cw / 2 * (1 - k), j * ch + ch / 2 * (1 - k), cw * k, ch * k);
      }
      ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    }
    case /^(zoomIn|zoomOut|zoomBlur|crossZoom|spin)$/.test(id): {
      const out = id === 'zoomOut';
      both(() => {
        const s = out ? 1 - 0.5 * e : 1 + 1.2 * e;
        ctx.globalAlpha = 1 - e;
        ctx.translate(w / 2, h / 2); if (id === 'spin') ctx.rotate(e * Math.PI); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
        if (id === 'zoomBlur' || id === 'crossZoom') ctx.filter = `blur(${(Math.sin(e * Math.PI) * 3).toFixed(1)}px)`;
        ctx.drawImage(A, 0, 0);
      }, () => {
        const s = out ? 1.6 - 0.6 * e : 0.4 + 0.6 * e;
        ctx.globalAlpha = e;
        ctx.translate(w / 2, h / 2); if (id === 'spin') ctx.rotate(-(1 - e) * Math.PI); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2);
        if (id === 'zoomBlur' || id === 'crossZoom') ctx.filter = `blur(${(Math.sin(e * Math.PI) * 3).toFixed(1)}px)`;
        ctx.drawImage(B, 0, 0);
      });
      break;
    }
    case /^whip(Left|Right)$/.test(id): {
      const dir = id === 'whipLeft' ? -1 : 1;
      const blur = Math.sin(e * Math.PI) * 6;
      ctx.filter = `blur(${blur.toFixed(1)}px)`;
      ctx.drawImage(A, dir * w * e, 0);
      ctx.drawImage(B, dir * w * e - dir * w, 0);
      break;
    }
    case id === 'pixelate': {
      const src = e < 0.5 ? A : B;
      const k = Math.max(1, Math.round(Math.sin(e * Math.PI) * 12));
      const t = document.createElement('canvas'); t.width = Math.max(1, Math.round(w / k)); t.height = Math.max(1, Math.round(h / k));
      t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(t, 0, 0, w, h);
      break;
    }
    case /^(glitch|rgbSplit|shake)$/.test(id): {
      const src = e < 0.5 ? A : B;
      const amt = Math.sin(e * Math.PI);
      if (id === 'shake') { ctx.drawImage(src, Math.sin(e * 40) * 6 * amt, Math.cos(e * 33) * 4 * amt); break; }
      ctx.drawImage(src, 0, 0);
      if (id === 'rgbSplit') {
        ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.6 * amt;
        ctx.drawImage(src, 6 * amt, 0); ctx.drawImage(src, -6 * amt, 0);
      } else {
        for (let i = 0; i < 7; i++) {
          const y = ((i * 37 + Math.floor(e * 20) * 13) % h), hh = 3 + (i * 5) % 9;
          ctx.drawImage(src, 0, y, w, hh, ((i % 2 ? 1 : -1) * 10 * amt), y, w, hh);
        }
      }
      break;
    }
    case /^(swirl|ripple)$/.test(id): {
      const src = e < 0.5 ? A : B;
      const amt = Math.sin(e * Math.PI);
      for (let y = 0; y < h; y += 2) ctx.drawImage(src, 0, y, w, 2, Math.sin(y / (id === 'ripple' ? 5 : 12) + e * 8) * 8 * amt, y, w, 2);
      break;
    }
    case /^(filmBurn|lumaDissolve)$/.test(id): {
      ctx.drawImage(A, 0, 0);
      ctx.globalAlpha = e; ctx.drawImage(B, 0, 0); ctx.globalAlpha = 1;
      if (id === 'filmBurn') {
        const g = ctx.createRadialGradient(w * 0.2, h * 0.5, 2, w * 0.2, h * 0.5, w);
        g.addColorStop(0, 'rgba(255,220,140,0.95)'); g.addColorStop(0.5, 'rgba(255,90,30,0.55)'); g.addColorStop(1, 'rgba(255,40,0,0)');
        ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = Math.sin(e * Math.PI); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      }
      break;
    }
    case /^(cube|doorway|pageFlip)$/.test(id): {
      if (id === 'doorway') {
        ctx.drawImage(B, 0, 0);
        const half = w / 2 * (1 - e);
        ctx.drawImage(A, 0, 0, w / 2, h, -w / 2 * e, 0, half, h);
        ctx.drawImage(A, w / 2, 0, w / 2, h, w - half + w / 2 * e * 0, 0, half, h);
      } else if (id === 'pageFlip') {
        ctx.drawImage(B, 0, 0);
        const x = w * (1 - e);
        ctx.drawImage(A, 0, 0, x, h, 0, 0, x, h);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x - 6, 0, 6, h);
      } else {
        const aw = w * (1 - e), bw = w * e;
        ctx.drawImage(A, 0, 0, w, h, 0, 0, aw, h);
        ctx.drawImage(B, 0, 0, w, h, aw, 0, bw, h);
        ctx.fillStyle = `rgba(0,0,0,${0.35 * Math.sin(e * Math.PI)})`; ctx.fillRect(0, 0, aw, h);
      }
      break;
    }
    default: { // crossfade & unknown
      ctx.drawImage(A, 0, 0);
      ctx.globalAlpha = e; ctx.drawImage(B, 0, 0);
    }
  }
  ctx.restore();
}

/** Portrait-like sample (neutral wall, skin, white shirt, color swatches) — shows white balance / saturation / contrast. */
export function portraitScene(w, h) {
  const key = `${w}x${h}:portrait`;
  if (sceneCache.has(key)) return sceneCache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const wall = g.createLinearGradient(0, 0, w, h);
  wall.addColorStop(0, '#9aa3ab'); wall.addColorStop(1, '#5d666f');
  g.fillStyle = wall; g.fillRect(0, 0, w, h);
  // color swatches (left)
  const sw = [['#d8473f', 0.12], ['#f2c14e', 0.34], ['#3f8fd8', 0.56], ['#46a35f', 0.78]];
  for (const [col, y] of sw) { g.fillStyle = col; g.fillRect(w * 0.06, h * y - h * 0.08, w * 0.16, h * 0.16); }
  // window light (right)
  const lg = g.createRadialGradient(w * 0.92, h * 0.1, 2, w * 0.92, h * 0.1, w * 0.5);
  lg.addColorStop(0, 'rgba(255,248,230,.95)'); lg.addColorStop(1, 'rgba(255,248,230,0)');
  g.fillStyle = lg; g.fillRect(0, 0, w, h);
  // shoulders / white shirt
  g.fillStyle = '#ecebe7';
  g.beginPath(); g.ellipse(w * 0.58, h * 1.02, w * 0.3, h * 0.32, 0, 0, Math.PI * 2); g.fill();
  // neck + face (skin)
  g.fillStyle = '#c98d6b'; g.fillRect(w * 0.545, h * 0.55, w * 0.07, h * 0.18);
  const sk = g.createRadialGradient(w * 0.56, h * 0.4, 2, w * 0.58, h * 0.45, h * 0.3);
  sk.addColorStop(0, '#f0c3a2'); sk.addColorStop(1, '#b97a57');
  g.fillStyle = sk; g.beginPath(); g.ellipse(w * 0.58, h * 0.44, h * 0.17, h * 0.22, 0, 0, Math.PI * 2); g.fill();
  // hair
  g.fillStyle = '#2b1d16'; g.beginPath(); g.ellipse(w * 0.58, h * 0.3, h * 0.19, h * 0.12, 0, Math.PI, 0); g.fill();
  sceneCache.set(key, c);
  return c;
}

function hexRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Approximate color grade of a sample scene (filter thumbnails): color params + R's "look" (gain, lift, curve, split tint). */
export function drawFilterPreview(ctx, w, h, filter) {
  const src = portraitScene(w, h);
  ctx.drawImage(src, 0, 0);
  const K = 1.35; // exaggerate a little so differences read on small tiles
  const c = (filter && filter.color) || {};
  const look = (filter && filter.look) || {};
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const ex = Math.pow(2, (c.exposure || 0) * 1.5 * K), br = (c.brightness || 0) * 0.35 * K, ct = 1 + (c.contrast || 0) * K;
  const sat = Math.max(0, 1 + ((c.saturation || 0) + (c.vibrance || 0) * 0.5) * K), temp = (c.temperature || 0) * 0.2 * K, tint = (c.tint || 0) * 0.14 * K;
  const fade = (c.fade || 0) * 0.4 * K, vig = (c.vignette || 0) * K, hl = (c.highlights || 0) * 0.25 * K, sh = (c.shadows || 0) * 0.25 * K;
  const hue = ((c.hue || 0) * Math.PI) / 180, cosH = Math.cos(hue), sinH = Math.sin(hue);
  const gain = Array.isArray(look.gain) ? look.gain : null;
  const lift = Array.isArray(look.lift) ? look.lift : (typeof look.lift === 'number' ? [look.lift, look.lift, look.lift] : null);
  const curve = (look.curve || 0) * K;
  const shT = hexRgb01(look.shadowTint), hiT = hexRgb01(look.highlightTint), tAmt = (look.tintAmount || 0) * K * 0.6;
  const bleach = (look.bleach || 0) * K;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    r *= ex; g *= ex; b *= ex;
    r += br + temp; g += br; b += br - temp;
    r += tint * 0.4; b += tint * 0.4; g -= tint * 0.6;
    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const lw = l > 0.5 ? hl * (l - 0.5) * 2 : sh * (0.5 - l) * 2;
    r += lw; g += lw; b += lw;
    r = (r - 0.5) * ct + 0.5; g = (g - 0.5) * ct + 0.5; b = (b - 0.5) * ct + 0.5;
    l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    if (hue) {
      const Y = 0.299 * r + 0.587 * g + 0.114 * b, I = 0.596 * r - 0.274 * g - 0.322 * b, Q = 0.211 * r - 0.523 * g + 0.312 * b;
      const I2 = I * cosH - Q * sinH, Q2 = I * sinH + Q * cosH;
      r = Y + 0.956 * I2 + 0.621 * Q2; g = Y - 0.272 * I2 - 0.647 * Q2; b = Y - 1.106 * I2 + 1.703 * Q2;
    }
    if (gain) { r *= gain[0]; g *= gain[1]; b *= gain[2]; }
    if (lift) { r = lift[0] + r * (1 - lift[0]); g = lift[1] + g * (1 - lift[1]); b = lift[2] + b * (1 - lift[2]); }
    if (curve) {
      const sc = (v) => { const q = clamp01(v); return q + curve * (q * q * (3 - 2 * q) - q); };
      r = sc(r); g = sc(g); b = sc(b);
    }
    if (tAmt && (shT || hiT)) {
      l = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const ws = (1 - l) * (1 - l), wh = l * l;
      if (shT) { r += (shT[0] - 0.5) * tAmt * ws; g += (shT[1] - 0.5) * tAmt * ws; b += (shT[2] - 0.5) * tAmt * ws; }
      if (hiT) { r += (hiT[0] - 0.5) * tAmt * wh; g += (hiT[1] - 0.5) * tAmt * wh; b += (hiT[2] - 0.5) * tAmt * wh; }
    }
    if (bleach) {
      l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = r + (l - r) * bleach * 0.5; g = g + (l - g) * bleach * 0.5; b = b + (l - b) * bleach * 0.5;
    }
    r = fade + r * (1 - fade); g = fade + g * (1 - fade); b = fade + b * (1 - fade);
    if (vig) { const dx = x / w - 0.5, dy = y / h - 0.5; const v = 1 - vig * Math.min(1, (dx * dx + dy * dy) * 2.2); r *= v; g *= v; b *= v; }
    d[i] = clamp01(r) * 255; d[i + 1] = clamp01(g) * 255; d[i + 2] = clamp01(b) * 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Effect preview at time t (seconds, loops). */
export function drawEffectPreview(ctx, w, h, id, t = 0.6) {
  const src = sampleScene(w, h, (Math.floor(t / 2) % 2));
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const ph = (t % 1.2) / 1.2;
  const pulse = Math.sin(ph * Math.PI);
  const key = String(id || '').toLowerCase();
  const filters = {
    blur: 'blur(2.5px)', directionalblur: 'blur(1.5px)', invert: 'invert(1)', blackwhite: 'grayscale(1) contrast(1.1)', sepia: 'sepia(1)',
    sharpen: 'contrast(1.35) saturate(1.1)', posterize: 'contrast(1.8) saturate(1.6)', duotone: 'grayscale(1) sepia(1) hue-rotate(160deg) saturate(3)',
    colorpop: 'saturate(0.15)', neonedges: 'invert(1) hue-rotate(180deg) contrast(2.5) saturate(3)', bloom: 'brightness(1.15) saturate(1.2)',
    halftone: 'grayscale(1) contrast(2)',
  };
  if (filters[key]) ctx.filter = filters[key];
  if (key === 'shake') ctx.translate(Math.sin(t * 40) * 3, Math.cos(t * 31) * 2);
  if (key === 'zoompunch') { const s = 1 + 0.18 * Math.max(0, Math.sin(ph * Math.PI * 2)) ; ctx.translate(w / 2, h / 2); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2); }
  if (key === 'zoomblur' || key === 'radialblur') { ctx.filter = 'blur(1px)'; for (let i = 0; i < 4; i++) { ctx.globalAlpha = 0.35; const s = 1 + i * 0.04 * (1 + pulse); ctx.save(); ctx.translate(w / 2, h / 2); if (key === 'radialblur') ctx.rotate(i * 0.03); ctx.scale(s, s); ctx.translate(-w / 2, -h / 2); ctx.drawImage(src, 0, 0); ctx.restore(); } ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.restore(); return; }
  if (key === 'pixelate' || key === 'mosaicblocks') {
    const k = key === 'pixelate' ? 6 : 10;
    const tc = document.createElement('canvas'); tc.width = Math.ceil(w / k); tc.height = Math.ceil(h / k);
    tc.getContext('2d').drawImage(src, 0, 0, tc.width, tc.height);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(tc, 0, 0, w, h);
    if (key === 'mosaicblocks') { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; for (let x = 0; x < w; x += k) for (let y = 0; y < h; y += k) ctx.strokeRect(x + 0.5, y + 0.5, k, k); }
    ctx.restore(); return;
  }
  if (key === 'mirror' || key === 'kaleidoscope') {
    ctx.drawImage(src, 0, 0, w / 2, h, 0, 0, w / 2, h);
    ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1); ctx.drawImage(src, 0, 0, w / 2, h, 0, 0, w / 2, h); ctx.restore();
    if (key === 'kaleidoscope') { ctx.save(); ctx.translate(0, h); ctx.scale(1, -1); ctx.globalAlpha = 0.5; ctx.drawImage(ctx.canvas, 0, 0, w, h / 2, 0, 0, w, h / 2); ctx.restore(); }
    ctx.restore(); return;
  }
  if (key === 'wave' || key === 'heathaze' || key === 'shockwave' || key === 'fisheye' || key === 'lensdistortion') {
    const amp = key === 'heathaze' ? 2 : key === 'wave' ? 5 : 4;
    for (let y = 0; y < h; y += 2) {
      let off = Math.sin(y / 6 + t * 6) * amp;
      if (key === 'shockwave') { const r = ph * h; off = Math.abs(y - h / 2 - r / 2) < 6 ? 6 : 0; }
      if (key === 'fisheye' || key === 'lensdistortion') off = (y / h - 0.5) * (y / h - 0.5) * 30 * (key === 'fisheye' ? 1 : -1);
      ctx.drawImage(src, 0, y, w, 2, off, y, w, 2);
    }
    ctx.restore(); return;
  }
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  switch (key) {
    case 'glitch': case 'vhs': case 'chromaticaberration': case 'rgbsplit': {
      ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.55;
      ctx.drawImage(src, 3 + pulse * 3, 0); ctx.drawImage(src, -3 - pulse * 3, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      if (key !== 'rgbsplit' && key !== 'chromaticaberration') for (let i = 0; i < 5; i++) { const y = (i * 41 + Math.floor(t * 12) * 17) % h; ctx.drawImage(src, 0, y, w, 4, (i % 2 ? 7 : -7) * pulse, y, w, 4); }
      if (key === 'vhs') { ctx.fillStyle = 'rgba(255,255,255,0.08)'; for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1); }
      break;
    }
    case 'scanlines': case 'crt': {
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1.2);
      if (key === 'crt') { const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.75); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
      break;
    }
    case 'vignette': { const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.7); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.75)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); break; }
    case 'filmgrain': { for (let i = 0; i < 400; i++) { const x = (i * 97 + Math.floor(t * 24) * 31) % w, y = (i * 53 + Math.floor(t * 24) * 17) % h; ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.3)'; ctx.fillRect(x, y, 1, 1); } break; }
    case 'flash': case 'strobe': { ctx.fillStyle = `rgba(255,255,255,${key === 'flash' ? Math.max(0, 1 - ph * 2.5) : (Math.floor(t * 8) % 2 ? 0.75 : 0)})`; ctx.fillRect(0, 0, w, h); break; }
    case 'lightleak': { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, `rgba(255,120,40,${0.5 + 0.3 * pulse})`); g.addColorStop(0.5, 'rgba(255,200,120,0.15)'); g.addColorStop(1, 'rgba(255,0,80,0)'); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); break; }
    case 'letterbox': { const bh = h * 0.14; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, bh); ctx.fillRect(0, h - bh, w, bh); break; }
    case 'tvoff': { const k = Math.max(0.02, 1 - ph * 1.4); ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); ctx.drawImage(src, 0, h / 2 - (h * k) / 2, w, h * k); break; }
    case 'rainbow': { const g = ctx.createLinearGradient(0, 0, w, 0); ['#ff004c', '#ffb000', '#3fe000', '#00c8ff', '#8a2bff'].forEach((c, i) => g.addColorStop(i / 4, c)); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.6; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); break; }
    case 'whip': { ctx.globalAlpha = 0.3; for (let i = 1; i < 5; i++) ctx.drawImage(src, -i * 4 * pulse, 0); break; }
    default: break;
  }
  ctx.restore();
}

/** Animation preview: a rounded "clip" card moving per animation id. slot: in|out|loop, p 0..1 (loops). */
export function drawAnimPreview(ctx, w, h, id, slot, p, { text = false } = {}) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const bw = w * 0.46, bh = h * 0.52;
  let dx = 0, dy = 0, s = 1, sx = 1, sy = 1, rot = 0, alpha = 1, blur = 0;
  const k = slot === 'out' ? 1 - p : p; // visible amount
  const e = ease(clamp01(k));
  const back = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const key = String(id || '');
  if (slot !== 'loop') {
    if (/fade/i.test(key)) alpha = e;
    else if (key === 'zoomIn') { s = slot === 'out' ? 1 + (1 - e) * 0.8 : 0.3 + 0.7 * e; alpha = e; }
    else if (key === 'zoomOut') { s = slot === 'out' ? e : 1.8 - 0.8 * e; alpha = e; }
    else if (/^slide/.test(key)) {
      const d = key.replace('slide', '');
      const sign = slot === 'out' ? 1 : -1;
      if (d === 'Left') dx = sign * (1 - e) * w * 0.6 * (slot === 'out' ? -1 : 1);
      if (d === 'Right') dx = -sign * (1 - e) * w * 0.6 * (slot === 'out' ? -1 : 1);
      if (d === 'Up') dy = (slot === 'out' ? -1 : 1) * (1 - e) * h * 0.6;
      if (d === 'Down') dy = (slot === 'out' ? 1 : -1) * (1 - e) * h * 0.6;
    } else if (/pop|bounce|wordPop|scaleWords|bounceWords/i.test(key)) { s = Math.max(0, back(clamp01(k))); alpha = clamp01(k * 3); }
    else if (/spin/i.test(key)) { rot = (1 - e) * Math.PI * (slot === 'out' ? -1 : 1); s = 0.4 + 0.6 * e; alpha = e; }
    else if (/blur/i.test(key)) { blur = (1 - e) * 6; alpha = e; }
    else if (/drop|charDrop/i.test(key)) { dy = -(1 - Math.min(1, back(clamp01(k)))) * h * 0.6; alpha = clamp01(k * 2); }
    else if (/swing/i.test(key)) { rot = (1 - e) * 0.9 * Math.sin(k * 10); alpha = e; }
    else if (/flip/i.test(key)) { sx = Math.cos((1 - e) * Math.PI / 2); }
    else if (/stretch/i.test(key)) { sx = 0.4 + 0.6 * e; sy = 1.5 - 0.5 * e; alpha = e; }
    else if (/glitch/i.test(key)) { dx = k < 1 ? Math.sin(k * 60) * 6 * (1 - k) : 0; alpha = k > 0.1 ? 1 : 0; }
    else if (/whip/i.test(key)) { dx = (1 - e) * w * 0.7 * (slot === 'out' ? -1 : 1); blur = (1 - e) * 4; }
    else if (/typewriter|charFade|karaoke|glitchType|wordSlideUp/i.test(key)) { alpha = 1; }
    else if (key === 'none') { alpha = slot === 'out' ? 1 : 1; }
  } else {
    const t = p * Math.PI * 2;
    if (key === 'pulse' || key === 'breathe') s = 1 + Math.sin(t) * (key === 'pulse' ? 0.12 : 0.06);
    else if (key === 'float' || key === 'drift') { dy = Math.sin(t) * h * 0.08; if (key === 'drift') dx = Math.cos(t) * w * 0.06; }
    else if (key === 'shake' || key === 'jiggle') { dx = Math.sin(t * 6) * 4; dy = Math.cos(t * 5) * (key === 'jiggle' ? 3 : 1); }
    else if (key === 'wobble') rot = Math.sin(t * 2) * 0.12;
    else if (key === 'spin') rot = t;
    else if (key === 'swing') rot = Math.sin(t) * 0.35;
    else if (key === 'heartbeat') s = 1 + Math.max(0, Math.sin(t * 2)) * 0.15;
    else if (key === 'flicker') alpha = Math.sin(t * 7) > -0.3 ? 1 : 0.35;
    else if (key === 'kenBurns') { s = 1 + p * 0.25; dx = p * w * 0.05; }
    else if (key === 'wave' || key === 'shimmer') { /* per-char below */ }
  }
  ctx.globalAlpha = clamp01(alpha);
  if (blur) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  ctx.translate(w / 2 + dx, h / 2 + dy);
  ctx.rotate(rot);
  ctx.scale(s * sx, s * sy);
  if (text) {
    const word = 'אבג דה';
    ctx.font = `800 ${Math.round(h * 0.3)}px Heebo, "Segoe UI", Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'rtl';
    const chars = [...word];
    const reveal = /typewriter|charFade|glitchType|karaoke/i.test(key) && slot !== 'loop' ? Math.floor(clamp01(k) * chars.length + 0.001) : chars.length;
    if (reveal >= chars.length && !/wave|shimmer|karaoke/i.test(key)) {
      ctx.fillStyle = '#ffffff'; ctx.fillText(word, 0, 0);
    } else {
      const total = ctx.measureText(word).width;
      let x = total / 2;
      chars.forEach((ch, i) => {
        const cw = ctx.measureText(ch).width;
        let yy = 0;
        if (key === 'wave') yy = Math.sin(p * Math.PI * 2 + i * 0.9) * h * 0.06;
        ctx.globalAlpha = i < reveal ? 1 : 0.12;
        ctx.fillStyle = key === 'karaokeFill' && i < reveal ? '#3fe0f5' : key === 'shimmer' && Math.abs(i - p * chars.length) < 1 ? '#3fe0f5' : '#ffffff';
        ctx.fillText(ch, x - cw / 2, yy);
        x -= cw;
      });
    }
  } else {
    const r = 7;
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + r, -bh / 2); ctx.lineTo(bw / 2 - r, -bh / 2); ctx.quadraticCurveTo(bw / 2, -bh / 2, bw / 2, -bh / 2 + r);
    ctx.lineTo(bw / 2, bh / 2 - r); ctx.quadraticCurveTo(bw / 2, bh / 2, bw / 2 - r, bh / 2); ctx.lineTo(-bw / 2 + r, bh / 2);
    ctx.quadraticCurveTo(-bw / 2, bh / 2, -bw / 2, bh / 2 - r); ctx.lineTo(-bw / 2, -bh / 2 + r); ctx.quadraticCurveTo(-bw / 2, -bh / 2, -bw / 2 + r, -bh / 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(sampleScene(Math.round(bw), Math.round(bh), 1), -bw / 2, -bh / 2);
  }
  ctx.restore();
}

/** Fallback text-preset / caption-style thumbnail when text-render.js is unavailable. */
export function drawTextFallback(ctx, w, h, text, { sample } = {}) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const t = text || {};
  const content = sample || t.content || 'טקסט';
  const size = Math.max(10, Math.min(h * 0.42, (w * 0.9) / Math.max(2, [...content].length * 0.55)));
  ctx.font = `${t.italic ? 'italic ' : ''}${t.weight || 700} ${Math.round(size)}px "${t.font || 'Heebo'}", Heebo, "Segoe UI", Arial`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'rtl';
  const bg = t.background;
  const tw = ctx.measureText(content).width;
  if (bg && bg.opacity > 0) {
    ctx.globalAlpha = bg.opacity;
    ctx.fillStyle = bg.color || '#000';
    const pad = size * 0.35, rr = Math.min(size * 0.5, (bg.radius || 0) * size / 96);
    const x = w / 2 - tw / 2 - pad, y = h / 2 - size * 0.62, bw2 = tw + pad * 2, bh2 = size * 1.24;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, bw2, bh2, rr) : ctx.rect(x, y, bw2, bh2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (t.glow && t.glow.blur) { ctx.shadowColor = t.glow.color || '#3fe0f5'; ctx.shadowBlur = Math.min(16, t.glow.blur / 3); }
  else if (t.shadow && t.shadow.blur) { ctx.shadowColor = t.shadow.color || 'rgba(0,0,0,.6)'; ctx.shadowBlur = Math.min(8, t.shadow.blur / 3); ctx.shadowOffsetY = 1; }
  if (t.stroke && t.stroke.width) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1.5, t.stroke.width * size / 96); ctx.strokeStyle = t.stroke.color || '#000'; ctx.strokeText(content, w / 2, h / 2); }
  if (t.gradient && t.gradient.from) {
    const g = ctx.createLinearGradient(w / 2 - tw / 2, 0, w / 2 + tw / 2, 0); g.addColorStop(0, t.gradient.from); g.addColorStop(1, t.gradient.to || t.gradient.from);
    ctx.fillStyle = g;
  } else ctx.fillStyle = t.color || '#fff';
  ctx.fillText(content, w / 2, h / 2);
  ctx.restore();
}

/** Builtin sticker/shape fallback glyphs. */
export function drawShapeFallback(ctx, w, h, kind, fill = '#13b6e4') {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = fill; ctx.strokeStyle = fill; ctx.lineWidth = Math.max(2, h * 0.06); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.34;
  ctx.beginPath();
  switch (kind) {
    case 'rect': ctx.rect(cx - r, cy - r * 0.75, r * 2, r * 1.5); ctx.fill(); break;
    case 'roundrect': ctx.roundRect ? ctx.roundRect(cx - r, cy - r * 0.75, r * 2, r * 1.5, r * 0.3) : ctx.rect(cx - r, cy - r * 0.75, r * 2, r * 1.5); ctx.fill(); break;
    case 'ellipse': ctx.ellipse(cx, cy, r * 1.1, r * 0.8, 0, 0, Math.PI * 2); ctx.fill(); break;
    case 'line': ctx.moveTo(cx - r * 1.2, cy); ctx.lineTo(cx + r * 1.2, cy); ctx.stroke(); break;
    case 'arrow': case 'arrowSticker': ctx.moveTo(cx - r * 1.1, cy); ctx.lineTo(cx + r * 0.9, cy); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx + r * 1.15, cy); ctx.lineTo(cx + r * 0.45, cy - r * 0.55); ctx.lineTo(cx + r * 0.45, cy + r * 0.55); ctx.closePath(); ctx.fill(); break;
    case 'triangle': ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r * 0.8); ctx.lineTo(cx - r, cy + r * 0.8); ctx.closePath(); ctx.fill(); break;
    case 'star': case 'burst': case 'starBurst': {
      const n = kind === 'star' ? 5 : 12, ri = kind === 'star' ? r * 0.45 : r * 0.7;
      for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + (i * Math.PI) / n, rr = i % 2 ? ri : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill(); break;
    }
    case 'heart': ctx.moveTo(cx, cy + r * 0.85); ctx.bezierCurveTo(cx - r * 1.4, cy - r * 0.1, cx - r * 0.6, cy - r * 1.1, cx, cy - r * 0.35); ctx.bezierCurveTo(cx + r * 0.6, cy - r * 1.1, cx + r * 1.4, cy - r * 0.1, cx, cy + r * 0.85); ctx.fill(); break;
    case 'progress': ctx.globalAlpha = 0.3; ctx.fillRect(cx - r * 1.2, cy - r * 0.18, r * 2.4, r * 0.36); ctx.globalAlpha = 1; ctx.fillRect(cx - r * 1.2, cy - r * 0.18, r * 1.5, r * 0.36); break;
    case 'circleHighlight': ctx.ellipse(cx, cy, r * 1.2, r * 0.8, -0.1, 0, Math.PI * 2); ctx.stroke(); break;
    case 'underlineSwoosh': ctx.moveTo(cx - r * 1.2, cy + r * 0.2); ctx.quadraticCurveTo(cx, cy - r * 0.3, cx + r * 1.2, cy + r * 0.1); ctx.stroke(); break;
    case 'speechBubble': ctx.roundRect ? ctx.roundRect(cx - r * 1.1, cy - r * 0.8, r * 2.2, r * 1.3, r * 0.3) : ctx.rect(cx - r, cy - r * 0.8, r * 2, r * 1.3); ctx.fill(); ctx.beginPath(); ctx.moveTo(cx - r * 0.3, cy + r * 0.45); ctx.lineTo(cx - r * 0.6, cy + r); ctx.lineTo(cx + r * 0.1, cy + r * 0.45); ctx.fill(); break;
    case 'checkmark': ctx.strokeStyle = '#2fd27a'; ctx.lineWidth = r * 0.3; ctx.moveTo(cx - r * 0.8, cy); ctx.lineTo(cx - r * 0.2, cy + r * 0.6); ctx.lineTo(cx + r * 0.9, cy - r * 0.6); ctx.stroke(); break;
    case 'xMark': ctx.strokeStyle = '#ff5c63'; ctx.lineWidth = r * 0.3; ctx.moveTo(cx - r * 0.7, cy - r * 0.7); ctx.lineTo(cx + r * 0.7, cy + r * 0.7); ctx.moveTo(cx + r * 0.7, cy - r * 0.7); ctx.lineTo(cx - r * 0.7, cy + r * 0.7); ctx.stroke(); break;
    case 'playButton': ctx.fillStyle = '#ff3b3b'; ctx.roundRect ? ctx.roundRect(cx - r * 1.2, cy - r * 0.8, r * 2.4, r * 1.6, r * 0.4) : ctx.rect(cx - r, cy - r * 0.8, r * 2, r * 1.6); ctx.fill(); ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.moveTo(cx - r * 0.3, cy - r * 0.45); ctx.lineTo(cx + r * 0.5, cy); ctx.lineTo(cx - r * 0.3, cy + r * 0.45); ctx.fill(); break;
    case 'searchBar': ctx.fillStyle = '#ffffff'; ctx.roundRect ? ctx.roundRect(cx - r * 1.35, cy - r * 0.35, r * 2.7, r * 0.7, r * 0.35) : ctx.rect(cx - r * 1.35, cy - r * 0.35, r * 2.7, r * 0.7); ctx.fill(); ctx.beginPath(); ctx.strokeStyle = '#13b6e4'; ctx.lineWidth = r * 0.12; ctx.arc(cx + r * 0.95, cy - r * 0.04, r * 0.16, 0, Math.PI * 2); ctx.stroke(); break;
    default: {
      const glyph = { bell: '🔔', heart: '❤️', fire: '🔥', sparkles: '✨', clickCursor: '👆', fingerTap: '👇', magnifier: '🔍' }[kind] || '★';
      ctx.font = `${Math.round(h * 0.6)}px "Segoe UI Emoji", "Segoe UI", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph, cx, cy + h * 0.03);
    }
  }
  ctx.restore();
}
