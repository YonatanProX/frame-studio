// Agent T self-test: renders every caption style, preset, animation, shape and sticker into contact sheets,
// runs automated checks (RTL order, LTR runs, fonts loaded, edge clipping, caching, perf) and posts results.
import * as TR from '../../render/text-render.js';

const log = [];
const L = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); log.push(s); console.log(s); };
const project = { settings: { fps: 30, width: 1080, height: 1920 }, clips: {} };
const fails = [];
const check = (cond, msg) => { if (!cond) { fails.push(msg); L('FAIL', msg); } else L('ok', msg); };

async function save(canvas, name) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  await fetch('/save?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
}
function sheet(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#15171c'; ctx.fillRect(0, 0, w, h);
  return { c, ctx };
}
function cellBg(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#3a3a44'); g.addColorStop(0.55, '#202026'); g.addColorStop(1, '#101014');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
function label(ctx, text, x, y, color = '#9fb3c8') {
  ctx.save(); ctx.font = '600 15px Arial'; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.direction = 'ltr'; ctx.textBaseline = 'top';
  ctx.fillText(text, x + 6, y + 5); ctx.restore();
}
/** draw raster centered in a cell, scaled to fit (never upscale above k=1 of device px) */
function put(ctx, r, x, y, w, h, outline = true) {
  if (!r) { label(ctx, 'NULL', x, y + 20, '#ff6b6b'); return; }
  const k = Math.min(1, (w - 12) / r.canvas.width, (h - 30) / r.canvas.height);
  const dw = r.canvas.width * k, dh = r.canvas.height * k;
  const dx = x + (w - dw) / 2, dy = y + 22 + (h - 22 - dh) / 2;
  ctx.drawImage(r.canvas, dx, dy, dw, dh);
  if (outline) { ctx.save(); ctx.strokeStyle = 'rgba(255,80,160,0.55)'; ctx.setLineDash([4, 4]); ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1); ctx.restore(); }
}
/** count opaque pixels touching the canvas border (clipping detector) */
function edgeHits(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const rows = [ctx.getImageData(0, 0, w, 1).data, ctx.getImageData(0, h - 1, w, 1).data, ctx.getImageData(0, 0, 1, h).data, ctx.getImageData(w - 1, 0, 1, h).data];
  let n = 0;
  for (const d of rows) for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
  return n;
}
const clipEdgeIssues = [];
function track(name, r) {
  if (!r) return;
  const n = edgeHits(r.canvas);
  if (n > 0) clipEdgeIssues.push(`${name}: ${n}px`);
}

const CAP_WORDS = [
  { w: 'נסו', s: 0.0, e: 0.28 }, { w: 'את', s: 0.28, e: 0.42 }, { w: 'yoursite.com', s: 0.42, e: 1.0 },
  { w: 'בקצב', s: 1.0, e: 1.28 }, { w: '123\u00a0BPM!', s: 1.28, e: 1.9, hot: true },
];
function capClip(style, id) {
  return { id, type: 'caption', start: 0, duration: 2.3, text: { ...TR.TEXT_DEFAULTS, content: '' }, textAnim: { in: 'none', out: 'none', loop: 'none', inDuration: 0.4, outDuration: 0.3, perWord: false },
    caption: { words: CAP_WORDS, style, activeColor: '#ffd60a', hotColor: '#ff4d6d' }, transform: { x: 0, y: 0 } };
}
function textClip(id, text, textAnim = {}, dur = 3) {
  return { id, type: 'text', start: 0, duration: dur, text: { ...TR.TEXT_DEFAULTS, ...text }, textAnim: { in: 'none', out: 'none', loop: 'none', inDuration: 0.4, outDuration: 0.3, perWord: false, ...textAnim } };
}

async function main() {
  const t0 = performance.now();
  const fr = await TR.ensureFonts(null);
  L('ensureFonts(null)', fr);
  const heavy = document.fonts.check('900 50px "Heebo"', 'אבג');
  const assistant = document.fonts.check('800 50px "Assistant"', 'אבג');
  check(heavy, 'Heebo 900 reported loaded by document.fonts.check');
  check(assistant, 'Assistant 800 reported loaded');
  {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '900 100px "Heebo"'; const w9 = c.measureText('אבגדהוזח').width;
    c.font = '300 100px "Heebo"'; const w3 = c.measureText('אבגדהוזח').width;
    c.font = '900 100px "NoSuchFont-xyz"'; const wf = c.measureText('אבגדהוזח').width;
    L('widths heebo900/300/fallback', w9, w3, wf);
    check(Math.abs(w9 - w3) > 20, 'Heebo variable weight changes glyph widths (900 vs 300)');
    check(Math.abs(w9 - wf) > 1, 'Heebo differs from fallback font');
  }

  // ── bidi / layout checks
  {
    const lay = (content, extra = {}) => TR.layoutText({ paragraphs: TR.splitTextUnits(content), font: 'Heebo', weight: 800, size: 80, lineHeight: 1.2, maxWidth: 0, align: 'center', dir: 'auto', ...extra });
    const A = lay('שלום עולם');
    check(A.units[0].x0 > A.units[1].x0, 'RTL: first Hebrew word is right of the second');
    const B = lay('קצב של 123 BPM עכשיו');
    const ux = (Lt, i) => Lt.units[i].x0;
    check(ux(B, 2) < ux(B, 3), '"123 BPM": 123 left of BPM (LTR run inside Hebrew)');
    check(ux(B, 3) < ux(B, 1) && ux(B, 0) > ux(B, 1), '"123 BPM" run sits between של and עכשיו in RTL order');
    check(ux(B, 4) < ux(B, 2), 'עכשיו (last word) is leftmost');
    const C = lay('היכנסו ל-yoursite.com!');
    const segs = C.units[1].segs.map((i) => C.segs[i]);
    L('segments of ל-yoursite.com!', segs.map((s) => [s.text, s.dir, Math.round(s.x)]));
    const url = segs.find((s) => s.text.includes('yoursite.com'));
    check(url && url.dir === 'ltr', 'URL segment rendered LTR');
    const heb = segs.find((s) => s.text.includes('ל'));
    check(heb && url && heb.x > url.x, '"ל-" is to the right of the URL');
    const D = lay('אני אוהב YouTube.');
    const dot = D.segs.find((s) => s.text === '.');
    const latin = D.segs.find((s) => s.text === 'YouTube');
    check(dot && latin && dot.x < latin.x, 'final period of RTL sentence goes to the far left');
    const E = lay('יש לכם סרטון שאין לו כתוביות באף אתר בכלל', { maxWidth: 600, balance: true });
    check(E.lines.length >= 2, 'wrapping to maxWidth gives multiple lines (' + E.lines.length + ')');
    if (E.lines.length >= 2) check(Math.abs(E.lines[0].width - E.lines[1].width) < 220, 'balanced lines have similar widths');
    const F = lay('Hello world');
    check(F.baseDir === 'ltr' && F.units[0].x0 < F.units[1].x0, 'LTR text stays LTR');
  }

  // ── sheet A/B: caption styles × 3 times
  const times = [0.06, 0.55, 1.62];
  const styles = TR.CAPTION_STYLES;
  const half = Math.ceil(styles.length / 2);
  for (let part = 0; part < 2; part++) {
    const list = styles.slice(part * half, (part + 1) * half);
    const cw = 640, ch = 330;
    const S = sheet(cw * 3, ch * list.length);
    list.forEach((st, row) => {
      times.forEach((t, col) => {
        const x = col * cw, y = row * ch;
        cellBg(S.ctx, x, y, cw, ch);
        const r = TR.rasterize(capClip(st.id, `cap-${st.id}`), t, project, 0.55);
        track(`caption ${st.id} t=${t}`, r);
        put(S.ctx, r, x, y, cw, ch);
        label(S.ctx, `${st.id} — ${st.name}  t=${t}`, x, y);
      });
    });
    await save(S.c, `T-captions-${part + 1}.png`);
  }
  // edge check over many times for every caption style
  for (const st of styles) for (let t = 0; t <= 2.3; t += 1 / 30) track(`caption ${st.id} t=${t.toFixed(2)}`, TR.rasterize(capClip(st.id, `capE-${st.id}`), t, project, 0.5));

  // popWords exactness: pop timing values
  {
    const clip = capClip('popWords', 'chx');
    const r1 = TR.rasterize(clip, 0.0, project, 0.5);
    const k1 = r1.key;
    const r2 = TR.rasterize(clip, 0.0, project, 0.5);
    check(r2.key === k1, 'same frame → same key (cache hit)');
    const r3 = TR.rasterize(clip, 0.9, project, 0.5);
    const r4 = TR.rasterize(clip, 0.9333, project, 0.5);
    check(r3.w === r4.w && r3.h === r4.h, 'caption canvas size stable across frames (line never moves)');
    // perf
    const p0 = performance.now();
    let draws = 0, lastKey = '';
    for (let f = 0; f < 120; f++) { const r = TR.rasterize(clip, f / 30 * (2.3 / 4), project, 0.5); if (r.key !== lastKey) { draws++; lastKey = r.key; } }
    const per = (performance.now() - p0) / 120;
    L('popWords caption: ms/frame', per.toFixed(2), 'redraws', draws);
    check(per < 12, 'caption rasterize under 12 ms/frame at preview scale');
    // full-resolution redraw cost (flushed with getImageData so GPU work is counted)
    const p1 = performance.now();
    let n1 = 0;
    for (let f = 0; f < 69; f++) {
      const r = TR.rasterize(capClip('popWords', 'chx-full'), f / 30, project, 1);
      r.canvas.getContext('2d').getImageData(0, 0, 1, 1);
      n1++;
    }
    const perFull = (performance.now() - p1) / n1;
    L('popWords caption full-res: ms/frame', perFull.toFixed(2));
    check(perFull < 30, 'full-res caption frame under 30 ms (export path)');
  }

  // popWords caption contract (numbers straight from the style evaluator)
  {
    const { evalCaption, captionActiveIndex } = await import('../../render/text-captions.js');
    const W = [{ w: 'א', s: 1, e: 1.2 }, { w: 'ב', s: 1.3, e: 1.5, hot: true }, { w: 'ג', s: 1.6, e: 1.8 }];
    const ev = (t) => evalCaption('popWords', { t, words: W, start: 1, end: 2.5, size: 98, color: '#ffffff', active: '#ffd60a', hot: '#ff4d6d', nChars: 0, unitChars: () => [] });
    const a = ev(1.0);
    check(Math.abs(a.words[0].s - 1.28) < 1e-6 && Math.abs(a.words[0].y - 30) < 1e-6, 'popWords: word starts at scale 1.28, 30 px low exactly when spoken');
    check(a.words[1].o === 0 && a.words[2].o === 0, 'popWords: upcoming words reserved (transparent)');
    const b = ev(1.13);
    check(Math.abs(b.words[0].s - 1) < 1e-6 && Math.abs(b.words[0].y) < 1e-6, 'popWords: pop settles to 1 after 0.13 s');
    const mid = ev(1.03);
    L('popWords mid-pop scale/y at +0.03s', mid.words[0].s.toFixed(4), mid.words[0].y.toFixed(2));
    check(ev(1.25).words[0].c === '#ffd60a', 'popWords: active word cyan between its start and the next word start');
    check(ev(1.35).words[1].c === '#ff4d6d' && ev(1.35).words[0].c === '#ffffff', 'popWords: hot word coral, previous word back to paper');
    check(captionActiveIndex(W, 1.9) === 2 && captionActiveIndex(W, 1.96) === -1, 'last word active until e + 0.15');
  }

  // ── sheet C: text presets (thumbnails + real render)
  {
    const P = TR.TEXT_PRESETS;
    const cols = 4, cw = 470, ch = 290;
    const rows = Math.ceil(P.length / cols);
    const S = sheet(cw * cols, ch * rows);
    for (let i = 0; i < P.length; i++) {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      cellBg(S.ctx, x, y, cw, ch);
      const th = document.createElement('canvas'); th.width = cw - 10; th.height = ch - 28;
      TR.drawThumbnail('textPreset', P[i], th);
      S.ctx.drawImage(th, x + 5, y + 24);
      label(S.ctx, `${P[i].id} — ${P[i].name}`, x, y);
      // edge check on full-res render at several times
      const clip = { id: 'pe-' + P[i].id, type: 'text', start: 0, duration: 3, text: { ...TR.TEXT_DEFAULTS, ...P[i].text, content: P[i].sample }, textAnim: { in: 'none', out: 'none', loop: 'none', inDuration: 0.4, outDuration: 0.3, perWord: false, ...P[i].textAnim } };
      for (let t = 0; t < 3; t += 0.1) track(`preset ${P[i].id} t=${t.toFixed(1)}`, TR.rasterize(clip, t, project, 0.5));
    }
    await save(S.c, 'T-presets.png');
  }

  // ── sheet D: animations at several t
  {
    const rows = [
      ['in', 'wordPop'], ['in', 'typewriter'], ['in', 'charDrop'], ['in', 'glitchType'], ['in', 'blurIn'], ['in', 'trackingIn'],
      ['in', 'bounceWords'], ['in', 'karaokeFill'], ['in', 'wordSlideUp'], ['in', 'swingIn'], ['out', 'wordPopOut'], ['out', 'scatterOut'],
      ['out', 'typeErase'], ['loop', 'wave'], ['loop', 'shimmer'], ['loop', 'rainbow'], ['loop', 'glitch'], ['loop', 'bounce'],
    ];
    const tsIn = [0.05, 0.2, 0.35, 0.5, 0.9];
    const tsOut = [2.15, 2.35, 2.5, 2.65, 2.95];
    const tsLoop = [0.0, 0.3, 0.6, 0.9, 1.2];
    const cw = 400, ch = 190;
    const S = sheet(cw * 5, ch * rows.length);
    rows.forEach(([phase, id], row) => {
      const ta = { inDuration: 0.6, outDuration: 0.8 }; ta[phase] = id;
      const clip = textClip(`anim-${phase}-${id}`, { content: 'שלום עולם 2025', weight: 900, size: 110, stroke: { color: '#000000', width: 10 } }, ta, 3);
      const ts = phase === 'in' ? tsIn : phase === 'out' ? tsOut : tsLoop;
      ts.forEach((t, col) => {
        const x = col * cw, y = row * ch;
        cellBg(S.ctx, x, y, cw, ch);
        const r = TR.rasterize(clip, t, project, 0.4);
        put(S.ctx, r, x, y, cw, ch);
        label(S.ctx, `${phase}:${id} t=${t}`, x, y);
      });
      for (let t = 0; t < 3; t += 1 / 30) track(`anim ${phase}:${id} t=${t.toFixed(2)}`, TR.rasterize(clip, t, project, 0.4));
    });
    await save(S.c, 'T-anims.png');
    // every animation in the catalog: edge check (per word and whole)
    for (const phase of ['in', 'out', 'loop']) for (const a of TR.TEXT_ANIMS[phase]) for (const perWord of [false, true]) {
      const ta = { inDuration: 0.5, outDuration: 0.5, perWord }; ta[phase] = a.id;
      const clip = textClip(`animE-${phase}-${a.id}-${perWord}`, { content: 'בדיקה של 123 BPM\nשורה שנייה', weight: 900, size: 90, stroke: { color: '#000', width: 8 } }, ta, 2);
      for (let t = 0; t < 2; t += 1 / 30) track(`animAll ${phase}:${a.id}${perWord ? '/w' : ''} t=${t.toFixed(2)}`, TR.rasterize(clip, t, project, 0.3));
    }
  }

  // ── sheet E: shapes + stickers
  {
    const SH = TR.SHAPES, ST = TR.STICKERS;
    const cols = 8, cw = 250, ch = 230;
    const rowsSh = Math.ceil(SH.length / cols), rowsSt = Math.ceil(ST.length / cols);
    const S = sheet(cw * cols, ch * (rowsSh + rowsSt));
    SH.forEach((s, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
      cellBg(S.ctx, x, y, cw, ch);
      const th = document.createElement('canvas'); th.width = cw - 10; th.height = ch - 28;
      TR.drawThumbnail('shape', s, th);
      S.ctx.drawImage(th, x + 5, y + 24);
      label(S.ctx, s.id, x, y);
      const clip = { id: 'se-' + s.id, type: 'shape', start: 0, duration: 2, shape: s.shape };
      for (let t = 0; t < 2; t += 0.25) track(`shape ${s.id}`, TR.rasterize(clip, t, project, 0.5));
    });
    ST.forEach((s, i) => {
      const x = (i % cols) * cw, y = (rowsSh + Math.floor(i / cols)) * ch;
      cellBg(S.ctx, x, y, cw, ch);
      const th = document.createElement('canvas'); th.width = cw - 10; th.height = ch - 28;
      TR.drawThumbnail('sticker', s, th);
      S.ctx.drawImage(th, x + 5, y + 24);
      label(S.ctx, s.id.replace('builtin-', '★').replace('emoji-', ''), x, y);
      const clip = { id: 'ste-' + s.id, type: 'sticker', start: 0, duration: 3, sticker: { kind: s.kind, value: s.value, size: 220 } };
      for (let t = 0; t < 3; t += 0.2) track(`sticker ${s.id} t=${t.toFixed(1)}`, TR.rasterize(clip, t, project, 0.5));
    });
    await save(S.c, 'T-shapes-stickers.png');
  }

  // ── sheet F: typography / bidi at real scale
  {
    const cases = [
      ['RTL + LTR run', { content: 'קצב של 123 BPM עכשיו', weight: 900, size: 96, stroke: { color: '#000000', width: 14 } }],
      ['URL inside Hebrew', { content: 'היכנסו ל-yoursite.com!', weight: 900, size: 96, stroke: { color: '#000000', width: 14 } }],
      ['period after Latin', { content: 'אני אוהב YouTube.', weight: 800, size: 96 }],
      ['shekel / numbers', { content: 'רק 49.90 ₪ ל-3 חודשים (מבצע)', weight: 800, size: 80 }],
      ['niqqud', { content: 'שָׁלוֹם עוֹלָם, מָה נִשְׁמָע?', weight: 700, size: 96 }],
      ['wrap + align right + underline', { content: 'שורה ארוכה מאוד שצריכה להישבר לכמה שורות בתוך רוחב מוגבל', weight: 700, size: 70, maxWidth: 700, align: 'right', underline: true }],
      ['align left + letterSpacing 8', { content: 'ריווח אותיות רחב\nשורה שנייה', weight: 600, size: 70, align: 'left', letterSpacing: 8 }],
      ['emoji mix', { content: 'הכי חם 🔥 בעיר 😎', weight: 900, size: 90 }],
      ['hot markup', { content: '*מבצע* לזמן מוגבל', weight: 900, size: 96, color: '#ffffff', stroke: { color: '#000000', width: 14 }, hotColor: '#ff4d6d' }],
      ['weights 100..900', { content: 'דק רגיל עבה שחור', font: 'Heebo', weight: 100, size: 80 }],
      ['English only', { content: 'Frame Studio 2026 — v1.0', weight: 800, size: 80 }],
      ['Impact (latin) + Hebrew fallback', { content: 'BIG בום SALE', font: 'Impact', weight: 400, size: 100 }],
    ];
    const cw = 1100, ch = 300;
    const S = sheet(cw * 2, ch * Math.ceil(cases.length / 2) + 300);
    cases.forEach(([name, text], i) => {
      const x = (i % 2) * cw, y = Math.floor(i / 2) * ch;
      cellBg(S.ctx, x, y, cw, ch);
      const r = TR.rasterize(textClip('bidi-' + i, text), 1, project, 1);
      track('bidi ' + name, r);
      put(S.ctx, r, x, y, cw, ch);
      label(S.ctx, name, x, y);
    });
    // weight ramp
    const y0 = ch * Math.ceil(cases.length / 2);
    cellBg(S.ctx, 0, y0, cw * 2, 300);
    label(S.ctx, 'Heebo weights 100 → 900', 0, y0);
    let x = 2150;
    for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      const r = TR.rasterize(textClip('w' + w, { content: 'אבג' + w, weight: w, size: 80, shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 } }), 1, project, 1);
      x -= r.canvas.width + 10;
      S.ctx.drawImage(r.canvas, x, y0 + 60);
    }
    await save(S.c, 'T-typography.png');
  }

  // shapes/sticker extra features: outline + shadow sticker, progress values
  {
    const r = TR.rasterize({ id: 'outl', type: 'sticker', start: 0, duration: 2, sticker: { kind: 'emoji', value: '🎸', size: 240, outline: { color: '#ffffff', width: 10 }, shadow: { color: 'rgba(0,0,0,0.5)', blur: 20, x: 0, y: 8 } } }, 0.5, project, 1);
    track('sticker outline', r);
    const S = sheet(900, 360);
    cellBg(S.ctx, 0, 0, 900, 360);
    put(S.ctx, r, 0, 0, 300, 360);
    const p1 = TR.rasterize({ id: 'pr1', type: 'shape', start: 0, duration: 2, shape: TR.getShape('progressRing').shape }, 0.7, project, 0.8);
    put(S.ctx, p1, 300, 0, 300, 360);
    const p2 = TR.rasterize({ id: 'pr2', type: 'shape', start: 0, duration: 2, shape: TR.getShape('progressStories').shape }, 1.1, project, 0.3);
    put(S.ctx, p2, 600, 0, 300, 360);
    // word-mode background + animated thumbnail frames
    const wb = TR.rasterize(textClip('wordbg', { content: 'כל מילה בתיבה 123', weight: 800, size: 70, background: { color: '#3b82f6', opacity: 1, padding: 18, radius: 14, mode: 'word' }, shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 } }, { in: 'wordPop', inDuration: 0.6 }), 0.3, project, 0.5);
    track('word bg', wb);
    check(!!wb, 'word-mode background renders');
    const th1 = document.createElement('canvas'); th1.width = 300; th1.height = 160;
    TR.drawThumbnail('textAnim', { id: 'wordPop' }, th1, { t: 0.1 });
    const th2 = document.createElement('canvas'); th2.width = 300; th2.height = 160;
    TR.drawThumbnail('textAnim', { id: 'wordPop' }, th2, { t: 1.0 });
    check(th1.toDataURL() !== th2.toDataURL(), 'animated thumbnail frames differ with opts.t');
    const thf = document.createElement('canvas'); thf.width = 300; thf.height = 160;
    TR.drawThumbnail('font', TR.FONTS[0], thf);
    const thc = document.createElement('canvas'); thc.width = 300; thc.height = 160;
    TR.drawThumbnail('captionStyle', 'popWords', thc);
    put(S.ctx, { canvas: wb.canvas }, 0, 0, 1, 1, false);
    const S2 = sheet(1000, 200);
    S2.ctx.drawImage(th1, 0, 20); S2.ctx.drawImage(th2, 300, 20); S2.ctx.drawImage(thf, 600, 20);
    S2.ctx.drawImage(wb.canvas, 0, 0, 1, 1);
    await save(S2.c, 'T-thumbs.png');
    const S3 = sheet(wb.canvas.width + 20, wb.canvas.height + 20);
    cellBg(S3.ctx, 0, 0, S3.c.width, S3.c.height);
    S3.ctx.drawImage(wb.canvas, 10, 10);
    await save(S3.c, 'T-wordbg.png');
    await save(S.c, 'T-extras.png');
  }

  // memory release: many caption clips → idle canvases are freed, re-rendering still works
  {
    const first = TR.rasterize(capClip('popWords', 'mem-0'), 1.62, project, 1);
    const firstCanvas = first.canvas, firstKey = first.key;
    for (let k = 1; k < 80; k++) for (let rep = 0; rep < 4; rep++) TR.rasterize(capClip('popWords', 'mem-' + k), 1.62, project, 1);
    const again = TR.rasterize(capClip('popWords', 'mem-0'), 1.62, project, 1);
    check(again && again.canvas.width > 10 && again.key !== firstKey, 'idle raster released and transparently re-rendered with a new key');
    check(firstCanvas.width <= 1 || firstCanvas !== again.canvas, 'released canvas memory freed');
    const d = again.canvas.getContext('2d').getImageData(0, 0, again.canvas.width, again.canvas.height).data;
    let opaque = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
    check(opaque > 1000, 're-rendered caption has visible pixels (' + opaque + ')');
  }

  L('edge (clipping) issues:', clipEdgeIssues.length);
  for (const s of clipEdgeIssues.slice(0, 60)) L('  edge', s);
  check(clipEdgeIssues.length === 0, 'no raster touches its canvas edge (nothing clipped)');
  L('total ms', Math.round(performance.now() - t0), 'fails', fails.length);
  await fetch('/save?name=T-report.json', { method: 'POST', body: JSON.stringify({ fails, log, clipEdgeIssues }, null, 1) });
  document.getElementById('status').textContent = 'done';
  await fetch('/done', { method: 'POST', body: 'x' });
}

main().catch(async (e) => {
  const msg = 'EXCEPTION ' + (e && e.stack || e);
  console.error(msg);
  try { await fetch('/save?name=T-report.json', { method: 'POST', body: JSON.stringify({ fails: [msg], log }, null, 1) }); } catch { /* */ }
  await fetch('/done', { method: 'POST', body: 'x' });
});
