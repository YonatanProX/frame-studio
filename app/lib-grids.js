// Frame Studio — library panel catalog grids: text presets, captions, stickers & shapes, effects, transitions,
// filters (+ LUTs), animations (agent L). Previews: render/text-render.js drawThumbnail (agent T) when available,
// otherwise the original 2D preview painters from lib-catalog.js.

import { api, applyOps, state } from './api.js';
import { h, icon, escapeHtml } from './tl-util.js';
import { startDrag, endDrag } from './lib-dnd.js';
import * as M from './tl-menu.js';
import {
  loadCatalog, getTextRender, drawTransitionPreview, drawFilterPreview, drawEffectPreview, drawAnimPreview, drawTextFallback,
  drawShapeFallback, sampleScene, portraitScene,
} from './lib-catalog.js';

const TW = 150, TH = 94; // tile canvas backing size (16:10)

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = x[key] || 'כללי'; if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

/** Generic tile: canvas preview + name, click/double-click/drag/"+" (and optional hover animation). */
function tile(ctx, { name, title, draw, animate, payload, cls = '', w = TW, hh = TH, onClick, current = false }) {
  const cv = h('canvas.cv', { width: w, height: hh });
  const t = h('div.lb-tile', { title: title || name, draggable: 'true' }, cv, h('div.nm', { text: name }), h('button.add', { title: 'הוספה / החלה', html: icon('plus', 13) }));
  if (cls) t.classList.add(...cls.split(' '));
  if (current) t.classList.add('cur');
  const c2 = cv.getContext('2d');
  try { draw(c2, cv, 0); } catch (e) { console.warn('[library] preview failed', name, e); }
  if (animate) {
    let raf = 0, t0 = 0;
    t.addEventListener('mouseenter', () => {
      t0 = performance.now();
      const loop = (now) => { try { animate(c2, cv, (now - t0) / 1000); } catch { /* ignore */ } raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    });
    t.addEventListener('mouseleave', () => { cancelAnimationFrame(raf); try { draw(c2, cv, 0); } catch { /* ignore */ } });
  }
  const act = () => (onClick ? onClick() : ctx.insert(payload()));
  t.addEventListener('click', (e) => { e.preventDefault(); act(); });
  t.addEventListener('dragstart', (e) => startDrag(e, payload(), { label: name }));
  t.addEventListener('dragend', () => endDrag());
  return t;
}

function catChips(ctx, st, cats, onPick) {
  const box = h('div.lb-chips');
  for (const c of ['הכל', ...cats]) {
    const b = h('button.lb-chip', { text: c });
    if ((st.cat || 'הכל') === c) b.classList.add('on');
    b.addEventListener('click', () => { st.cat = c; box.querySelectorAll('.lb-chip').forEach((x) => x.classList.toggle('on', x === b)); onPick(c); });
    box.appendChild(b);
  }
  return box;
}

function fallbackNote(cat, key) {
  return cat.fallback && cat.fallback[key] ? h('div.lb-status', { html: `${icon('info', 13)}<span>הקטלוג המלא לא נטען — מוצגת רשימת הבסיס</span>` }) : null;
}

function bg(ctx, cv) {
  const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
  g.addColorStop(0, '#1d2b38'); g.addColorStop(1, '#0d1219');
  ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
}

// ───────────────────────── text ─────────────────────────

export async function renderText(ctx) {
  const { body } = ctx;
  ctx.setTitle('טקסט', 'סגנונות מוכנים');
  ctx.setActions([]);
  body.textContent = '';
  const cat = await loadCatalog();
  const tr = await getTextRender();
  const add = h('button.lb-btn.primary', { html: `${icon('plus', 15)}<span>הוספת טקסט</span>`, style: { width: '100%', justifyContent: 'center', height: '34px', marginBottom: '10px' } });
  add.addEventListener('click', () => ctx.insert({ kind: 'text', name: 'טקסט', content: 'טקסט חדש', preset: { name: 'טקסט' } }));
  body.appendChild(add);
  const note = fallbackNote(cat, 'textPresets');
  if (note) body.appendChild(note);
  const grid = h('div.lb-grid');
  for (const p of cat.textPresets) {
    grid.appendChild(tile(ctx, {
      name: p.name, title: `${p.name} — לחיצה מוסיפה בסמן הניגון, או גרירה לציר הזמן`,
      draw: (c2, cv) => {
        bg(c2, cv);
        if (tr && tr.drawThumbnail) {
          const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height;
          tr.drawThumbnail('textPreset', p, tmp, {});
          c2.drawImage(tmp, 0, 0);
        } else drawTextFallback(c2, cv.width, cv.height, p.text, { sample: p.text && p.text.content ? p.text.content : p.name });
      },
      animate: tr && tr.drawThumbnail ? (c2, cv, t) => {
        bg(c2, cv);
        const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height;
        tr.drawThumbnail('textPreset', p, tmp, { t: t % 3 });
        c2.drawImage(tmp, 0, 0);
      } : null,
      payload: () => ({ kind: 'text', id: p.id, name: p.name, preset: { id: p.id, name: p.name, text: p.text, textAnim: p.textAnim, sample: p.sample } }),
    }));
  }
  body.appendChild(grid);
}

// ───────────────────────── captions ─────────────────────────

function parseSrt(text) {
  const words = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/);
  const tc = (s) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : null; };
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const s = tc(a), e = tc(z);
    if (s == null || e == null || e <= s) continue;
    const txt = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    const ws = txt.split(/\s+/).filter(Boolean);
    const total = ws.reduce((acc, w) => acc + Math.max(1, w.length), 0) || 1;
    let cur = s;
    for (const w of ws) { const d = ((e - s) * Math.max(1, w.length)) / total; words.push({ w, s: Math.round(cur * 1000) / 1000, e: Math.round((cur + d) * 1000) / 1000 }); cur += d; }
  }
  return words;
}
function parseWordsJson(text) {
  const j = JSON.parse(text);
  const arr = Array.isArray(j) ? j : Array.isArray(j.words) ? j.words : Array.isArray(j.asr) ? j.asr : null;
  if (!arr) throw new Error('מבנה JSON לא מוכר — צפוי [[מילה, התחלה, סוף]…] או [{w,s,e}…]');
  return arr.map((x) => (Array.isArray(x) ? { w: String(x[0]), s: +x[1], e: +x[2] } : { w: String(x.w ?? x.word ?? x.text), s: +(x.s ?? x.start), e: +(x.e ?? x.end) }))
    .filter((x) => x.w && isFinite(x.s) && isFinite(x.e));
}

export async function renderCaptions(ctx) {
  const st = ctx.tabState('captions', { style: 'chordix' });
  const { body } = ctx;
  ctx.setTitle('כתוביות', 'סגנונות ותמלול');
  ctx.setActions([]);
  body.textContent = '';
  const cat = await loadCatalog();
  const tr = await getTextRender();
  const p = state.project;

  // auto transcription
  const audioMedia = Object.values((p && p.media) || {}).filter((m) => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio !== false));
  const voiceClip = p ? Object.values(p.clips || {}).find((c) => c.mediaId && (p.tracks.find((t) => t.id === c.trackId) || {}).role === 'voice') : null;
  const selMedia = p ? [...(state.selection || [])].map((id) => p.clips[id]).find((c) => c && c.mediaId && (c.type === 'audio' || c.type === 'video')) : null;
  const pick = h('select.lb-input', { style: { height: '30px' } });
  for (const m of audioMedia) pick.appendChild(h('option', { value: m.id, text: m.name || m.id }));
  const defId = (selMedia && selMedia.mediaId) || (voiceClip && voiceClip.mediaId) || (audioMedia[0] && audioMedia[0].id);
  if (defId) pick.value = defId;
  const go = h('button.lb-btn.primary', { html: `${icon('sparkles', 14)}<span>תמלול אוטומטי</span>` });
  const job = h('div.lb-job');
  go.disabled = !audioMedia.length;
  go.addEventListener('click', async () => {
    if (!pick.value) return;
    go.disabled = true;
    job.innerHTML = '<span class="lb-spin"></span><span>מתמלל… (מקומי, faster-whisper)</span>';
    try {
      const res = await api.post(`/api/projects/${encodeURIComponent(state.projectId)}/transcribe`, { mediaId: pick.value, captions: { style: st.style, maxWords: 3 } });
      const j = res && (res.job || res);
      ctx.watchJob(j && j.id, (jj) => {
        if (jj.status === 'done' || jj.state === 'done' || jj.done) { job.innerHTML = `${icon('check', 14)}<span>התמלול הסתיים — הכתוביות נוספו לציר הזמן</span>`; go.disabled = false; }
        else if (jj.status === 'error' || jj.state === 'error' || jj.error) { job.innerHTML = `<span style="color:#ff8a8f">התמלול נכשל: ${escapeHtml(jj.error || '')}</span>`; go.disabled = false; }
        else job.innerHTML = `<span class="lb-spin"></span><span>מתמלל… ${jj.progress != null ? Math.round(jj.progress * 100) + '%' : ''}</span>`;
      });
    } catch (e) { job.innerHTML = `<span style="color:#ff8a8f">${escapeHtml(e.message)}</span>`; go.disabled = false; }
  });
  body.appendChild(h('div.lb-card-wide', null, h('div.txt', { html: '<b>תמלול אוטומטי</b>מזהה את הדיבור (עברית) ויוצר כתוביות מסונכרנות מילה-מילה בסגנון שנבחר.' })));
  if (audioMedia.length) body.appendChild(h('div.lb-row', null, pick, go));
  else body.appendChild(h('div.lb-status', { text: 'אין בפרויקט קובץ עם שמע לתמלול — ייבא קריינות קודם.' }));
  body.appendChild(job);

  // import SRT / JSON
  const fi = h('input', { type: 'file', accept: '.srt,.json,.vtt', style: { display: 'none' } });
  const imp = h('button.lb-btn', { html: `${icon('upload', 14)}<span>ייבוא SRT / JSON</span>` });
  imp.addEventListener('click', () => fi.click());
  fi.addEventListener('change', async () => {
    const f = fi.files[0]; fi.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const words = /\.json$/i.test(f.name) ? parseWordsJson(text) : parseSrt(text);
      if (!words.length) throw new Error('לא נמצאו מילים בקובץ');
      await applyOps([{ op: 'setTranscript', words }, { op: 'addCaptions', words, style: st.style, maxWords: 3 }], `ייבוא כתוביות מ"${f.name}" (${words.length} מילים)`);
      M.toast(`נוספו כתוביות: ${words.length} מילים`, 'success');
    } catch (e) { M.toast(`ייבוא הכתוביות נכשל: ${e.message}`, 'error'); }
  });
  body.appendChild(h('div.lb-row', null, imp, fi));

  body.appendChild(h('div.lb-section', { text: 'סגנונות כתוביות' }));
  const note = fallbackNote(cat, 'captionStyles');
  if (note) body.appendChild(note);
  const grid = h('div.lb-grid');
  for (const s of cat.captionStyles) {
    grid.appendChild(tile(ctx, {
      name: s.name, title: `${s.name} — לחיצה מחילה על הכתוביות הנבחרות (או על כולן)`, current: st.style === s.id,
      draw: (c2, cv) => {
        c2.fillStyle = '#0f1318'; c2.fillRect(0, 0, cv.width, cv.height);
        c2.drawImage(sampleScene(cv.width, cv.height, 1), 0, 0); c2.fillStyle = 'rgba(0,0,0,.35)'; c2.fillRect(0, 0, cv.width, cv.height);
        if (tr && tr.drawThumbnail) { const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; tr.drawThumbnail('captionStyle', s, tmp, {}); c2.drawImage(tmp, 0, 0); }
        else drawCaptionFallback(c2, cv, s, 0.68);
      },
      animate: (c2, cv, t) => {
        c2.drawImage(sampleScene(cv.width, cv.height, 1), 0, 0); c2.fillStyle = 'rgba(0,0,0,.35)'; c2.fillRect(0, 0, cv.width, cv.height);
        if (tr && tr.drawThumbnail) { const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; tr.drawThumbnail('captionStyle', s, tmp, { t: t % 1.6 }); c2.drawImage(tmp, 0, 0); }
        else drawCaptionFallback(c2, cv, s, t % 1.6);
      },
      payload: () => ({ kind: 'caption', id: s.id, name: s.name, defaults: s.defaults || {} }),
      onClick: () => { st.style = s.id; grid.querySelectorAll('.lb-tile').forEach((x, i) => x.classList.toggle('cur', cat.captionStyles[i] && cat.captionStyles[i].id === s.id)); ctx.insert({ kind: 'caption', id: s.id, name: s.name, defaults: s.defaults || {} }); },
    }));
  }
  body.appendChild(grid);
}

function drawCaptionFallback(c2, cv, s, t) {
  const words = ['ככה', 'זה', 'נשמע'];
  const d = s.defaults || {};
  const tx = d.text || {};
  const active = Math.min(words.length - 1, Math.floor((t / 1.6) * words.length));
  c2.save();
  const size = cv.height * 0.2;
  c2.font = `${tx.weight || 800} ${Math.round(size)}px "${tx.font || 'Heebo'}", Heebo, Arial`;
  c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.direction = 'rtl';
  const gap = size * 0.3;
  const widths = words.map((w) => c2.measureText(w).width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (words.length - 1);
  let x = cv.width / 2 + total / 2;
  words.forEach((w, i) => {
    const ww = widths[i];
    const cx = x - ww / 2;
    if (s.id === 'boldPop' && i !== active) { x -= ww + gap; return; }
    if (s.id === 'boxHighlight' && i === active) { c2.fillStyle = d.activeColor || '#7c4dff'; c2.fillRect(cx - ww / 2 - 4, cv.height / 2 - size * 0.62, ww + 8, size * 1.24); }
    if (tx.background && tx.background.opacity) { c2.fillStyle = tx.background.color; c2.fillRect(cx - ww / 2 - 5, cv.height / 2 - size * 0.62, ww + 10, size * 1.24); }
    if (tx.stroke && tx.stroke.width) { c2.lineWidth = Math.max(2, tx.stroke.width / 5); c2.strokeStyle = tx.stroke.color; c2.lineJoin = 'round'; c2.strokeText(w, cx, cv.height / 2); }
    c2.fillStyle = i === active && s.id !== 'pill' && s.id !== 'minimal' ? (i === 2 ? d.hotColor || '#ff8a66' : d.activeColor || '#3fe0f5') : tx.color || '#fff';
    c2.fillText(w, cx, cv.height / 2);
    x -= ww + gap;
  });
  c2.restore();
}

// ───────────────────────── stickers & shapes ─────────────────────────

export async function renderStickers(ctx) {
  const { body } = ctx;
  ctx.setTitle('מדבקות', 'אימוג׳י, מדבקות וצורות');
  ctx.setActions([]);
  body.textContent = '';
  const cat = await loadCatalog();
  const tr = await getTextRender();
  const emoji = cat.stickers.filter((s) => s.kind === 'emoji');
  const built = cat.stickers.filter((s) => s.kind !== 'emoji');
  if (emoji.length) {
    body.appendChild(h('div.lb-section', { text: 'אימוג׳י' }));
    const g = h('div.lb-grid.g5');
    for (const s of emoji) {
      const payload = () => ({ kind: 'sticker', id: s.id, name: s.name || s.value, sticker: { kind: 'emoji', value: s.value } });
      const el = h('div.lb-emoji', { text: s.value, title: `${s.name || s.value} — לחיצה מוסיפה בסמן הניגון`, draggable: 'true' });
      el.addEventListener('click', () => ctx.insert(payload()));
      el.addEventListener('dragstart', (e) => startDrag(e, payload(), { label: s.value }));
      el.addEventListener('dragend', () => endDrag());
      g.appendChild(el);
    }
    body.appendChild(g);
  }
  if (built.length) {
    body.appendChild(h('div.lb-section', { text: 'מדבקות מצוירות' }));
    const g = h('div.lb-grid.g3');
    for (const s of built) {
      g.appendChild(tile(ctx, {
        name: s.name, cls: 'sq', w: 96, hh: 96,
        draw: (c2, cv) => {
          c2.fillStyle = '#12161b'; c2.fillRect(0, 0, cv.width, cv.height);
          if (tr && tr.drawThumbnail) { const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; tr.drawThumbnail('sticker', s, tmp, {}); c2.drawImage(tmp, 0, 0); }
          else drawShapeFallback(c2, cv.width, cv.height, s.value || s.id, '#3fcaf0');
        },
        animate: tr && tr.drawThumbnail ? (c2, cv, t) => { c2.fillStyle = '#12161b'; c2.fillRect(0, 0, cv.width, cv.height); const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; tr.drawThumbnail('sticker', s, tmp, { t: t % 3 }); c2.drawImage(tmp, 0, 0); } : null,
        payload: () => ({ kind: 'sticker', id: s.id, name: s.name, sticker: { kind: s.kind || 'builtin', value: s.value || s.id } }),
      }));
    }
    body.appendChild(g);
  }
  if (cat.shapes.length) {
    body.appendChild(h('div.lb-section', { text: 'צורות' }));
    const g = h('div.lb-grid.g3');
    for (const s of cat.shapes) {
      const shape = s.shape || { kind: s.kind || s.id };
      g.appendChild(tile(ctx, {
        name: s.name, cls: 'sq', w: 96, hh: 96,
        draw: (c2, cv) => {
          c2.fillStyle = '#12161b'; c2.fillRect(0, 0, cv.width, cv.height);
          if (tr && tr.drawThumbnail) { const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; tr.drawThumbnail('shape', s, tmp, {}); c2.drawImage(tmp, 0, 0); }
          else drawShapeFallback(c2, cv.width, cv.height, shape.kind, shape.fill || '#13b6e4');
        },
        payload: () => ({ kind: 'shape', id: s.id, name: s.name, shape: { ...shape } }),
      }));
    }
    body.appendChild(g);
  }
}

// ───────────────────────── effects ─────────────────────────

export async function renderEffects(ctx) {
  const st = ctx.tabState('effects', { cat: 'הכל' });
  const { body } = ctx;
  ctx.setTitle('אפקטים', 'גרירה לקליפ או לציר הזמן');
  ctx.setActions([]);
  ctx.setHint('effect');
  body.textContent = '';
  const cat = await loadCatalog();
  const groups = groupBy(cat.effects, 'category');
  const grid = h('div.lb-grid.g3');
  const draw = () => {
    grid.textContent = '';
    for (const e of cat.effects.filter((x) => st.cat === 'הכל' || (x.category || 'כללי') === st.cat)) {
      grid.appendChild(tile(ctx, {
        name: e.name, title: `${e.name}${e.category ? ` · ${e.category}` : ''}\nלחיצה — החלה על הקליפים הנבחרים (או שכבת אפקט בסמן הניגון) · גרירה לקליפ`,
        w: 120, hh: 75,
        draw: (c2, cv) => drawEffectPreview(c2, cv.width, cv.height, e.id, 0.45),
        animate: (c2, cv, t) => drawEffectPreview(c2, cv.width, cv.height, e.id, t),
        payload: () => ({ kind: 'effect', id: e.id, name: e.name }),
      }));
    }
  };
  const note = fallbackNote(cat, 'effects');
  if (note) body.appendChild(note);
  body.appendChild(catChips(ctx, st, [...groups.keys()], draw));
  body.appendChild(grid);
  draw();
}

// ───────────────────────── transitions ─────────────────────────

export async function renderTransitions(ctx) {
  const st = ctx.tabState('transitions', { cat: 'הכל' });
  const { body } = ctx;
  ctx.setTitle('מעברים', 'גרירה אל חיבור בין שני קליפים');
  ctx.setActions([]);
  ctx.setHint('transition');
  body.textContent = '';
  const cat = await loadCatalog();
  const groups = groupBy(cat.transitions, 'category');
  const grid = h('div.lb-grid.g3');
  const draw = () => {
    grid.textContent = '';
    for (const t of cat.transitions.filter((x) => st.cat === 'הכל' || (x.category || 'כללי') === st.cat)) {
      grid.appendChild(tile(ctx, {
        name: t.name, title: `${t.name}${t.category ? ` · ${t.category}` : ''} · ${(t.defaultDuration || 0.5).toFixed(2)} ש׳\nגרירה אל החיבור בין קליפים, או לחיצה להחלה על הקליפ הנבחר`,
        w: 120, hh: 75,
        draw: (c2, cv) => drawTransitionPreview(c2, cv.width, cv.height, t.id, 0.4),
        animate: (c2, cv, s) => drawTransitionPreview(c2, cv.width, cv.height, t.id, Math.min(1, (s % 1.5) / 1.1)),
        payload: () => ({ kind: 'transition', id: t.id, name: t.name, duration: t.defaultDuration || 0.5 }),
      }));
    }
  };
  const note = fallbackNote(cat, 'transitions');
  if (note) body.appendChild(note);
  body.appendChild(catChips(ctx, st, [...groups.keys()], draw));
  body.appendChild(grid);
  draw();
}

// ───────────────────────── filters + LUTs ─────────────────────────

const LUT_HE = {
  'teal-orange.cube': 'טורקיז-כתום', 'warm-film.cube': 'פילם חם', 'cool-night.cube': 'לילה קריר', 'bleach-bypass.cube': 'בליץ׳ ביי־פאס',
  'vintage-fade.cube': 'וינטג׳ דהוי', 'mono-contrast.cube': 'שחור-לבן חד', 'golden-hour.cube': 'שעת זהב', 'chordix-cyan.cube': 'Chordix ציאן',
};
const lutCache = new Map();
async function loadCube(file) {
  if (lutCache.has(file)) return lutCache.get(file);
  const p = fetch(api.url(`/library/luts/${encodeURIComponent(file)}`)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))).then((txt) => {
    let size = 0;
    const data = [];
    for (const line of txt.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      if (/^LUT_3D_SIZE/i.test(l)) { size = parseInt(l.split(/\s+/)[1], 10); continue; }
      if (/^[A-Z_]/i.test(l)) continue;
      const v = l.split(/\s+/).map(Number);
      if (v.length >= 3 && v.every(isFinite)) data.push(v[0], v[1], v[2]);
    }
    return size ? { size, data: Float32Array.from(data) } : null;
  });
  lutCache.set(file, p);
  return p;
}
function applyLut(ctx2, w, hh, lut) {
  const img = ctx2.getImageData(0, 0, w, hh);
  const d = img.data, n = lut.size, L = lut.data;
  const at = (r, g, b, c) => L[((b * n + g) * n + r) * 3 + c];
  for (let i = 0; i < d.length; i += 4) {
    const fr = (d[i] / 255) * (n - 1), fg = (d[i + 1] / 255) * (n - 1), fb = (d[i + 2] / 255) * (n - 1);
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const r1 = Math.min(n - 1, r0 + 1), g1 = Math.min(n - 1, g0 + 1), b1 = Math.min(n - 1, b0 + 1);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    for (let c = 0; c < 3; c++) {
      const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
      const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
      const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
      const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
      const c0 = c00 * (1 - dg) + c10 * dg, c1 = c01 * (1 - dg) + c11 * dg;
      d[i + c] = Math.max(0, Math.min(255, (c0 * (1 - db) + c1 * db) * 255));
    }
  }
  ctx2.putImageData(img, 0, 0);
}

export async function renderFilters(ctx) {
  const { body } = ctx;
  ctx.setTitle('פילטרים', 'החלה על הקליפים הנבחרים');
  ctx.setActions([]);
  ctx.setHint('filter');
  body.textContent = '';
  const cat = await loadCatalog();
  const note = fallbackNote(cat, 'filters');
  if (note) body.appendChild(note);
  const p = state.project;
  const selIds = [...(state.selection || [])];
  const curFilter = p && selIds.length === 1 && p.clips[selIds[0]] && p.clips[selIds[0]].filter ? p.clips[selIds[0]].filter.id : null;
  const st = ctx.tabState('filters', { cat: 'הכל' });
  const groups = groupBy(cat.filters, 'category');
  const grid = h('div.lb-grid.g3');
  const drawFilters = () => {
  grid.textContent = '';
  grid.appendChild(tile(ctx, {
    name: 'ללא', w: 120, hh: 75, current: curFilter === 'none',
    draw: (c2, cv) => c2.drawImage(portraitScene(cv.width, cv.height), 0, 0),
    payload: () => ({ kind: 'filter', id: 'none', name: 'ללא פילטר' }),
  }));
  for (const f of cat.filters.filter((x) => st.cat === 'הכל' || (x.category || 'כללי') === st.cat)) {
    grid.appendChild(tile(ctx, {
      name: f.name, w: 120, hh: 75, current: curFilter === f.id, title: `${f.name} — לחיצה מחילה על הקליפים הנבחרים (או שכבת התאמה בסמן הניגון)`,
      draw: (c2, cv) => drawFilterPreview(c2, cv.width, cv.height, f),
      payload: () => ({ kind: 'filter', id: f.id, name: f.name }),
    }));
  }
  };
  if (groups.size > 1) body.appendChild(catChips(ctx, st, [...groups.keys()], drawFilters));
  body.appendChild(grid);
  drawFilters();
  // LUTs
  body.appendChild(h('div.lb-section', { text: 'LUT — טבלאות צבע' }));
  const lgrid = h('div.lb-grid.g3');
  body.appendChild(lgrid);
  try {
    let luts = await api.get('/api/library/luts?detail=1');
    luts = (luts || []).map((x) => (typeof x === 'string' ? { file: x, name: LUT_HE[x] || x.replace(/\.cube$/i, '') } : x));
    for (const l of luts) {
      const t = tile(ctx, {
        name: l.name, w: 120, hh: 75, title: `${l.name} (${l.file}) — לחיצה מחילה על הקליפים הנבחרים`,
        draw: (c2, cv) => { c2.drawImage(portraitScene(cv.width, cv.height), 0, 0); },
        payload: () => ({ kind: 'lut', file: l.file, name: l.name }),
      });
      lgrid.appendChild(t);
      loadCube(l.file).then((lut) => { if (!lut) return; const cv = t.querySelector('canvas'); const c2 = cv.getContext('2d'); c2.drawImage(portraitScene(cv.width, cv.height), 0, 0); applyLut(c2, cv.width, cv.height, lut); }).catch(() => {});
    }
    if (!luts.length) lgrid.appendChild(h('div.lb-empty', { text: 'אין קובצי LUT בתיקייה library/luts', style: { gridColumn: '1/-1' } }));
  } catch (e) { lgrid.appendChild(h('div.lb-empty', { text: `רשימת ה-LUT לא נטענה: ${e.message}`, style: { gridColumn: '1/-1' } })); }
}

// ───────────────────────── animations ─────────────────────────

export async function renderAnims(ctx) {
  const st = ctx.tabState('anims', { target: 'clip', slot: 'in' });
  const { body } = ctx;
  ctx.setTitle('אנימציות', 'גרירה אל קליפ או לחיצה להחלה על הנבחרים');
  ctx.setActions([]);
  ctx.setHint('anim');
  body.textContent = '';
  const cat = await loadCatalog();
  const tr = await getTextRender();
  const seg1 = h('div.lb-seg');
  for (const [id, label] of [['clip', 'קליפ'], ['text', 'טקסט (מילים ואותיות)']]) {
    const b = h('button', { text: label });
    if (st.target === id) b.classList.add('on');
    b.addEventListener('click', () => { st.target = id; ctx.rerender('anims'); });
    seg1.appendChild(b);
  }
  const seg2 = h('div.lb-seg');
  for (const [id, label] of [['in', 'כניסה'], ['out', 'יציאה'], ['loop', 'לולאה']]) {
    const b = h('button', { text: label });
    if (st.slot === id) b.classList.add('on');
    b.addEventListener('click', () => { st.slot = id; ctx.rerender('anims'); });
    seg2.appendChild(b);
  }
  body.append(seg1, seg2);
  const isText = st.target === 'text';
  const groups = isText ? cat.textAnims : cat.clipAnims;
  const list = (groups && groups[st.slot]) || [];
  const p = state.project;
  const selIds = [...(state.selection || [])];
  const sc = p && selIds.length === 1 ? p.clips[selIds[0]] : null;
  const cur = sc ? (isText ? sc.textAnim && sc.textAnim[st.slot] : (st.slot === 'in' ? sc.animIn : st.slot === 'out' ? sc.animOut : sc.animLoop) && (st.slot === 'in' ? sc.animIn : st.slot === 'out' ? sc.animOut : sc.animLoop).id) : null;
  const grid = h('div.lb-grid.g3');
  for (const a of list) {
    grid.appendChild(tile(ctx, {
      name: a.name || a.id, w: 120, hh: 75, current: cur === a.id,
      title: `${a.name || a.id} — לחיצה מחילה על הקליפים הנבחרים · גרירה אל קליפ`,
      draw: (c2, cv) => {
        c2.fillStyle = '#10141a'; c2.fillRect(0, 0, cv.width, cv.height);
        if (isText && tr && tr.drawThumbnail) { const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; tr.drawThumbnail('textAnim', { id: a.id, phase: st.slot }, tmp, { phase: st.slot }); c2.drawImage(tmp, 0, 0); }
        else { const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height; drawAnimPreview(tmp.getContext('2d'), cv.width, cv.height, a.id, st.slot, st.slot === 'loop' ? 0.2 : 0.55, { text: isText }); c2.drawImage(tmp, 0, 0); }
      },
      animate: (c2, cv, t) => {
        c2.fillStyle = '#10141a'; c2.fillRect(0, 0, cv.width, cv.height);
        if (isText && tr && tr.drawThumbnail) {
          const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height;
          tr.drawThumbnail('textAnim', { id: a.id, phase: st.slot }, tmp, { phase: st.slot, t: st.slot === 'out' ? 1.2 + (t % 1.2) * 0.66 : t % 2 });
          c2.drawImage(tmp, 0, 0);
        } else {
          const ph = st.slot === 'loop' ? (t % 1.6) / 1.6 : Math.min(1, (t % 1.4) / 0.9);
          const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height;
          drawAnimPreview(tmp.getContext('2d'), cv.width, cv.height, a.id, st.slot, ph, { text: isText });
          c2.drawImage(tmp, 0, 0);
        }
      },
      payload: () => ({ kind: 'anim', slot: st.slot, id: a.id, name: a.name || a.id, text: isText }),
    }));
  }
  if (!list.length) grid.appendChild(h('div.lb-empty', { text: 'אין אנימציות בקטגוריה', style: { gridColumn: '1/-1' } }));
  body.appendChild(grid);
}
