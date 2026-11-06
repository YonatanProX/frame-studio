// Frame Studio — library panel: project media bin (agent L).
// Explorer drag & drop upload, "ייבוא מנתיב", thumbnails, durations, processing state (SSE 'media' via state.project),
// drag to timeline, double-click / "+" adds at playhead.

import { api, state } from './api.js';
import { h, icon, formatDuration, clipEnd } from './tl-util.js';
import { startDrag, endDrag } from './lib-dnd.js';
import { uploadFile, importPaths, mediaFilesOf } from './lib-upload.js';
import * as M from './tl-menu.js';

const KIND_ICON = { video: 'video', image: 'image', audio: 'audio' };
const KIND_LABEL = { video: 'וידאו', image: 'תמונה', audio: 'שמע' };
const uploads = new Map(); // name → {name, progress, error}

function enc(s) { return encodeURIComponent(s); }

function thumbUrl(m) {
  const pid = state.projectId || (state.project && state.project.id);
  if (!pid) return null;
  if (m.kind === 'image') return api.url(`/api/projects/${enc(pid)}/media/${enc(m.id)}/thumb?t=0`);
  if (m.kind === 'video') return api.url(`/api/projects/${enc(pid)}/media/${enc(m.id)}/thumb?t=${Math.max(0, Math.min(1, Math.floor((m.duration || 0) / 3)))}`);
  return null;
}

const peaksCache = new Map();
function drawAudioThumb(cv, m) {
  const pid = state.projectId || (state.project && state.project.id);
  const ctx = cv.getContext('2d');
  const w = cv.width, hh = cv.height;
  const paint = (peaks) => {
    ctx.clearRect(0, 0, w, hh);
    const g = ctx.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, '#12352a'); g.addColorStop(1, '#0c1d18');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, hh);
    ctx.fillStyle = 'rgba(120,230,170,.9)';
    const n = 80;
    for (let i = 0; i < n; i++) {
      let v = 0.08;
      if (peaks && peaks.length) {
        const a = Math.floor((i * peaks.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / n));
        for (let j = a; j < b; j++) if (peaks[j] > v) v = peaks[j];
      }
      const bh = Math.min(1, Math.pow(v, 0.8)) * hh * 0.8;
      ctx.fillRect((i * w) / n + 0.5, (hh - bh) / 2, Math.max(1, w / n - 1.2), Math.max(1, bh));
    }
  };
  if (peaksCache.has(m.id)) { paint(peaksCache.get(m.id)); return; }
  paint(null);
  if (m.status !== 'ready' || !pid) return;
  fetch(api.url(`/api/projects/${enc(pid)}/media/${enc(m.id)}/peaks`)).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (!j) return;
    const pk = Array.isArray(j) ? j : j.peaks || [];
    peaksCache.set(m.id, pk);
    paint(pk);
  }).catch(() => {});
}

function usedMediaIds(p) {
  const s = new Set();
  for (const c of Object.values((p && p.clips) || {})) if (c.mediaId) s.add(c.mediaId);
  return s;
}

function parsePaths(text) {
  return String(text || '')
    .split(/[\r\n;]+/)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim())
    .filter(Boolean);
}

export async function doUpload(files, ctx, { addAtPlayhead = false } = {}) {
  const ok = files.filter((f) => mediaFilesOf({ files: [f] }).length);
  if (!ok.length) { M.toast('סוג הקובץ לא נתמך — וידאו, תמונה או אודיו', 'warn'); return []; }
  const out = [];
  let t = state.playhead;
  for (const f of ok) {
    uploads.set(f.name, { name: f.name, progress: 0 });
    ctx.rerender('media');
    try {
      const media = await uploadFile(f, (pr) => { const u = uploads.get(f.name); if (u) { u.progress = pr; ctx.updateUploads && ctx.updateUploads(); } });
      uploads.delete(f.name);
      out.push(...media);
      if (addAtPlayhead) for (const m of media) { await ctx.insert({ kind: 'media', mediaId: m.id, mediaKind: m.kind, duration: m.duration, name: m.name }, { t }); t += m.kind === 'image' ? 3 : (m.duration || 3); }
    } catch (e) {
      uploads.set(f.name, { name: f.name, progress: 1, error: e.message });
      M.toast(`העלאת "${f.name}" נכשלה: ${e.message}`, 'error');
      setTimeout(() => { uploads.delete(f.name); ctx.rerender('media'); }, 5000);
    }
    ctx.rerender('media');
  }
  if (out.length) M.toast(out.length > 1 ? `יובאו ${out.length} קבצים` : `יובא "${out[0].name}"`, 'success');
  return out;
}

export function renderMedia(ctx) {
  const st = ctx.tabState('media', { kind: 'all', q: '', pathOpen: false });
  const { body } = ctx;
  const p = state.project;
  const media = Object.values((p && p.media) || {});
  ctx.setTitle('מדיה', p ? `${media.length} קבצים בפרויקט` : '');
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*', style: { display: 'none' } });
  fileInput.addEventListener('change', () => { const files = [...fileInput.files]; fileInput.value = ''; if (files.length) doUpload(files, ctx); });
  ctx.setActions([
    { icon: 'upload', title: 'ייבוא קבצים מהמחשב', onClick: () => fileInput.click() },
    { icon: 'path', title: 'ייבוא מנתיב', onClick: () => { st.pathOpen = !st.pathOpen; ctx.rerender('media'); } },
  ]);
  body.textContent = '';
  body.appendChild(fileInput);
  if (!p) { body.appendChild(h('div.lb-empty', null, h('b', { text: 'אין פרויקט פתוח' }), 'פתח או צור פרויקט כדי לייבא מדיה.')); return; }

  // import-by-path
  if (st.pathOpen || !media.length) {
    const inp = h('input.lb-input', { type: 'text', placeholder: 'C:\\…\\סרטון.mp4  (אפשר כמה נתיבים, מופרדים ב-;)', dir: 'ltr', spellcheck: false });
    const go = h('button.lb-btn.primary.small', { text: 'ייבוא' });
    const copy = h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--lb-text3)', whiteSpace: 'nowrap' } }, h('input', { type: 'checkbox' }), 'העתקה לפרויקט');
    const run = async () => {
      const paths = parsePaths(inp.value);
      if (!paths.length) { inp.focus(); return; }
      go.disabled = true;
      try {
        const res = await importPaths(paths, { copy: copy.querySelector('input').checked });
        inp.value = '';
        M.toast(res.length ? `מייבא ${res.length} קבצים…` : 'לא יובא דבר', res.length ? 'success' : 'warn');
      } catch (e) { M.toast(`הייבוא נכשל: ${e.message}`, 'error'); }
      go.disabled = false;
    };
    go.addEventListener('click', run);
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') run(); });
    inp.addEventListener('paste', () => setTimeout(() => { inp.value = parsePaths(inp.value).join('; '); }, 0));
    body.appendChild(h('div.lb-section', { text: 'ייבוא מנתיב' }));
    body.appendChild(h('div.lb-row', null, inp, go));
    body.appendChild(h('div.lb-row', { style: { marginTop: '-4px' } }, copy));
  }

  // drop zone
  const dz = h('div.lb-drop', { html: `<b>${icon('upload', 18)}</b><b>גרור לכאן קבצים מהסייר</b>וידאו, תמונות ושמע — או לחץ לבחירה` });
  dz.querySelector('b').style.display = 'flex';
  dz.querySelector('b').style.justifyContent = 'center';
  dz.style.cursor = 'pointer';
  dz.addEventListener('click', () => fileInput.click());
  body.appendChild(dz);

  // uploads in progress
  const upBox = h('div');
  ctx.updateUploads = () => {
    upBox.textContent = '';
    for (const u of uploads.values()) {
      upBox.appendChild(h('div.lb-up', null, u.error ? h('span', { html: icon('x', 12), style: { color: '#ff6b70' } }) : h('span.lb-spin'), h('span.nm', { text: u.name }),
        h('span.bar', null, h('i', { style: { width: `${Math.round((u.progress || 0) * 100)}%`, background: u.error ? '#ff5c63' : '' } }))));
    }
  };
  ctx.updateUploads();
  body.appendChild(upBox);

  if (!media.length) return;

  // filters
  const chips = h('div.lb-chips');
  const counts = { all: media.length, video: 0, image: 0, audio: 0 };
  for (const m of media) counts[m.kind] = (counts[m.kind] || 0) + 1;
  for (const [id, label] of [['all', 'הכל'], ['video', 'וידאו'], ['image', 'תמונות'], ['audio', 'שמע']]) {
    if (id !== 'all' && !counts[id]) continue;
    const c = h('button.lb-chip', { text: `${label} ${counts[id]}` });
    if (st.kind === id) c.classList.add('on');
    c.addEventListener('click', () => { st.kind = id; ctx.rerender('media'); });
    chips.appendChild(c);
  }
  body.appendChild(chips);
  if (media.length > 8) {
    const search = h('div.lb-search');
    search.innerHTML = `<span class="ic-s">${icon('search', 15)}</span>`;
    const inp = h('input', { type: 'text', placeholder: 'חיפוש לפי שם…', value: st.q, dir: 'auto' });
    inp.addEventListener('input', () => { st.q = inp.value; drawGrid(); });
    search.appendChild(inp);
    body.appendChild(h('div.lb-row', null, search));
  }
  const grid = h('div.lb-grid');
  body.appendChild(grid);
  const used = usedMediaIds(p);
  const drawGrid = () => {
    grid.textContent = '';
    const q = (st.q || '').toLowerCase();
    const list = media.filter((m) => (st.kind === 'all' || m.kind === st.kind) && (!q || (m.name || '').toLowerCase().includes(q)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
    for (const m of list) grid.appendChild(mediaCard(m, ctx, used.has(m.id)));
    if (!list.length) grid.appendChild(h('div.lb-empty', { text: 'אין קבצים מתאימים', style: { gridColumn: '1/-1' } }));
  };
  drawGrid();
}

function mediaCard(m, ctx, used) {
  const card = h('div.lb-card', { draggable: m.status === 'error' ? 'false' : 'true', title: `${m.name}\n${KIND_LABEL[m.kind] || ''}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.duration ? ` · ${formatDuration(m.duration)}` : ''}${m.fps ? ` · ${Math.round(m.fps * 100) / 100}fps` : ''}\nלחיצה כפולה או + — הוספה בסמן הניגון · גרירה לציר הזמן` });
  if (used) card.classList.add('used');
  const th = h('div.th');
  if (m.kind === 'audio') {
    const cv = h('canvas', { width: 220, height: 138 });
    th.appendChild(cv);
    drawAudioThumb(cv, m);
  } else {
    const url = thumbUrl(m);
    if (url && (m.status === 'ready' || m.kind === 'image')) {
      const img = h('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' });
      img.addEventListener('error', () => { img.remove(); th.appendChild(h('span.ph', { html: icon(KIND_ICON[m.kind] || 'video', 28) })); }, { once: true });
      th.appendChild(img);
    } else th.appendChild(h('span.ph', { html: icon(KIND_ICON[m.kind] || 'video', 28) }));
  }
  if (m.kind !== 'image' && m.duration) th.appendChild(h('span.badge', { text: formatDuration(m.duration) }));
  th.appendChild(h('span.kind', { html: icon(KIND_ICON[m.kind] || 'video', 11), title: KIND_LABEL[m.kind] }));
  if (m.status === 'processing') th.appendChild(h('div.proc', null, h('span.lb-spin'), 'מעבד…'));
  if (m.status === 'error') th.appendChild(h('div.err', { text: m.error || 'שגיאה בעיבוד הקובץ' }));
  const add = h('button.add', { title: 'הוספה בסמן הניגון', html: icon('plus', 15) });
  card.append(th, add, h('div.nm', { text: m.name || m.id, dir: 'auto' }));
  const payload = () => ({ kind: 'media', mediaId: m.id, mediaKind: m.kind, duration: m.duration, name: m.name });
  add.addEventListener('click', (e) => { e.stopPropagation(); ctx.insert(payload()); });
  card.addEventListener('dblclick', () => { if (m.status !== 'error') ctx.insert(payload()); });
  card.addEventListener('dragstart', (e) => startDrag(e, payload(), { label: m.name }));
  card.addEventListener('dragend', () => endDrag());
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const clips = Object.values((state.project && state.project.clips) || {}).filter((c) => c.mediaId === m.id);
    M.showMenu([
      { label: 'הוספה בסמן הניגון', icon: 'plus', disabled: m.status === 'error', onClick: () => ctx.insert(payload()) },
      { label: 'הוספה בסוף הסרטון', icon: 'chevronRight', disabled: m.status === 'error', onClick: () => {
        const p = state.project;
        let end = 0;
        for (const c of Object.values(p.clips || {})) end = Math.max(end, clipEnd(c));
        ctx.insert(payload(), { t: end });
      } },
      { label: clips.length ? `בחירת ${clips.length} הקליפים שמשתמשים בקובץ` : 'הקובץ לא בשימוש', icon: 'check', disabled: !clips.length, onClick: () => state.set({ selection: new Set(clips.map((c) => c.id)) }) },
      '-',
      { label: 'העתקת הנתיב', icon: 'copy', onClick: () => { try { navigator.clipboard.writeText(m.path || ''); M.toast('הנתיב הועתק'); } catch { M.toast(m.path || ''); } } },
      { label: 'העתקת מזהה המדיה', icon: 'copy', onClick: () => { try { navigator.clipboard.writeText(m.id); M.toast('המזהה הועתק'); } catch { M.toast(m.id); } } },
    ], e.clientX, e.clientY);
  });
  return card;
}
