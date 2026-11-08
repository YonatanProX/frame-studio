// Frame Studio — library panel: sound FX browser + music/voice ("אודיו") tabs (agent L).
// Server-side search (/api/library/sounds), category tree, duration filter, audition with moving progress line,
// mini waveforms (entry.wave), license badges, drag & drop + add at playhead.
// Sound folders: the library reads folders wherever they are on the computer (nothing is moved or copied).
// "הוספת תיקיית צלילים" opens the native folder picker (POST /api/library/folders/pick) and adds the folder
// (POST /api/library/folders); the folder list is managed from the "תיקיות צלילים" control (inside "סינון").
// The sound FX list stays near the top: search + "סינון" (categories, length, folders) on one row, role chips below.

import { api } from './api.js';
import { h, icon, escapeHtml, formatDuration } from './tl-util.js';
import { startDrag, endDrag } from './lib-dnd.js';
import * as M from './tl-menu.js';

const COLL_SFX = 'אפקטים קוליים';
const COLL_MUSIC = 'מוזיקה';
const FREE_PACK_URL = 'https://sonniss.com/gameaudiogdc';
const LS_PROMO = 'frameStudio.soundsPromoHidden';

const LIC = {
  starter: { label: 'Frame Studio', cls: 'starter', title: 'צליל מקורי של Frame Studio — חופשי לכל שימוש, גם מסחרי, בלי קרדיט (MIT)' },
  sonniss: { label: 'Sonniss', cls: '', title: 'Sonniss GDC — ללא תמלוגים, מסחרי, בלי קרדיט. אסור לאמן עליו בינה מלאכותית.' },
  mixkit: { label: 'Mixkit', cls: 'mixkit', title: 'Mixkit — חינמי למסחרי ברשתות ובפרסומות, בלי קרדיט. אסור להפיץ את הקבצים עצמם.' },
  own: { label: 'שלי', cls: 'own', title: 'קובץ שלך מתיקייה במחשב' },
  other: { label: 'אחר', cls: 'own', title: 'צליל מתיקייה שהוספת — ודאו שמותר לכם להשתמש בו' },
};

const DUR_FILTERS = [
  { id: 'all', label: 'הכל' },
  { id: 'short', label: 'עד 1 ש׳', max: 1 },
  { id: 'mid', label: '1–3 ש׳', min: 1, max: 3 },
  { id: 'long', label: '3–10 ש׳', min: 3, max: 10 },
  { id: 'xl', label: '10 ש׳+', min: 10 },
];

// ───────────────────────── audition (one shared player) ─────────────────────────

const player = {
  audio: null, id: null, row: null, raf: 0, entry: null,
  play(entry, row) {
    if (this.id === entry.id) { this.stop(); return; }
    this.stop();
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.addEventListener('ended', () => this.stop());
      this.audio.addEventListener('error', () => { if (this.id) M.toast('לא ניתן לנגן את הצליל', 'error'); this.stop(); });
    }
    this.id = entry.id; this.row = row; this.entry = entry;
    this.audio.src = api.url(`/api/library/sounds/${encodeURIComponent(entry.id)}/file`);
    this.audio.currentTime = 0;
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => {});
    row.classList.add('playing');
    const pl = row.querySelector('.pl');
    if (pl) pl.innerHTML = icon('stop', 13);
    const tick = () => {
      if (!this.id) return;
      const d = this.audio.duration || entry.duration || 1;
      drawWave(row._wv, entry.wave, Math.min(1, this.audio.currentTime / d));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  stop() {
    cancelAnimationFrame(this.raf);
    if (this.audio) { try { this.audio.pause(); } catch { /* ignore */ } }
    if (this.row) {
      this.row.classList.remove('playing');
      const pl = this.row.querySelector('.pl');
      if (pl) pl.innerHTML = icon('play', 13);
      if (this.entry) drawWave(this.row._wv, this.entry.wave, -1);
    }
    this.id = null; this.row = null; this.entry = null;
  },
};
export function stopAudition() { player.stop(); }

function drawWave(cv, wave, progress) {
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 70, hh = 22;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  const pts = wave && wave.length ? wave : new Array(64).fill(0.05);
  const n = pts.length;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0.04, Math.min(1, pts[i]));
    const bh = v * (hh - 2);
    const xx = i * bw; // time flows left→right inside the waveform (also in the RTL panel)
    ctx.fillStyle = progress >= 0 && i / n <= progress ? '#3fcaf0' : 'rgba(170,180,192,.55)';
    ctx.fillRect(xx + 0.15, (hh - bh) / 2, Math.max(0.6, bw - 0.4), bh);
  }
  if (progress >= 0) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(progress * w), 0, 1.2, hh);
  }
}

// ───────────────────────── rows ─────────────────────────

function soundRow(entry, ctx, { role = 'sfx' } = {}) {
  const lic = LIC[entry.license] || LIC.other;
  const row = h('div.lb-snd', { title: `${entry.name}\n${entry.category} · ${entry.pack || entry.collection}\nלחיצה — האזנה · גרירה לציר הזמן · + הוספה בסמן הניגון`, draggable: 'true' });
  row.innerHTML = `<button class="pl" title="האזנה">${icon('play', 13)}</button>
    <div class="nm" dir="auto">${escapeHtml(entry.name)}</div>
    <canvas class="wv" width="70" height="22"></canvas>
    <div class="meta">${entry.role ? `<span class="lb-role" title="תפקיד בסרטון${entry.suggest ? ` · עוצמה מומלצת ${entry.suggest.gainDb} dB` : ''}">${escapeHtml(entry.role)}</span>` : ''}<span class="lb-lic ${lic.cls}" title="${escapeHtml(lic.title)}">${lic.label}</span><span class="cat">${escapeHtml(entry.category)}${entry.pack && entry.license !== 'starter' ? ` · ${escapeHtml(entry.pack.replace(/^.*? - /, ''))}` : ''}</span></div>
    <div class="dur">${formatDuration(entry.duration)}</div>
    <button class="lb-icon-btn add" title="הוספה בסמן הניגון">${icon('plus', 15)}</button>`;
  row._wv = row.querySelector('.wv');
  drawWave(row._wv, entry.wave, -1);
  const payload = () => ({ kind: 'sound', id: entry.id, abs: entry.abs, name: entry.name, duration: entry.duration, role, license: entry.license, suggest: entry.suggest || null });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.add')) { ctx.insert(payload()); return; }
    player.play(entry, row);
  });
  row.addEventListener('dblclick', (e) => { e.preventDefault(); ctx.insert(payload()); });
  row.addEventListener('dragstart', (e) => { startDrag(e, payload(), { label: entry.name }); });
  row.addEventListener('dragend', () => endDrag());
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    M.showMenu([
      { label: 'האזנה', icon: 'play', onClick: () => player.play(entry, row) },
      { label: 'הוספה בסמן הניגון', icon: 'plus', onClick: () => ctx.insert(payload()) },
      ...(entry.suggest ? [{ label: `הוספה עם העוצמה המומלצת (${entry.suggest.gainDb} dB)`, icon: 'volume', onClick: () => ctx.insert({ ...payload(), gainDb: entry.suggest.gainDb }) }] : []),
      '-',
      { label: 'העתקת מזהה הצליל', icon: 'copy', onClick: () => copyText(entry.id) },
      { label: 'העתקת הנתיב', icon: 'copy', onClick: () => copyText(entry.abs || entry.file) },
      { label: 'רישיון', icon: 'license', onClick: () => ctx.showLicenses() },
    ], e.clientX, e.clientY);
  });
  return row;
}

function copyText(s) {
  try { navigator.clipboard.writeText(String(s)); M.toast('הועתק'); } catch { M.toast(String(s)); }
}

// ───────────────────────── sound folders ─────────────────────────

let treeCache = null;
const folderListeners = new Set();
/** Something changed in the folder list (added / removed) — every open view refreshes. */
function foldersChanged() { treeCache = null; for (const fn of [...folderListeners]) { try { fn(); } catch { /* view gone */ } } }

/** Open the free sound bundle page in the user's default browser (the server runs the OS "open" command). */
export async function openFreePack() {
  try { await api.post('/api/open-url', { url: FREE_PACK_URL }); M.toast('דף ההורדה נפתח בדפדפן'); }
  catch {
    const w = window.open(FREE_PACK_URL, '_blank', 'noopener');
    if (!w) M.toast(`פתחו בדפדפן: ${FREE_PACK_URL}`, 'warn');
  }
}

/**
 * Add a sound folder: native folder picker → add → background indexing.
 * When the picker is not available the user can paste a path instead.
 * → Promise<boolean> (true when a folder was added)
 */
export async function addSoundFolderFlow(btn) {
  const label = btn ? btn.innerHTML : null;
  const busy = (on, text) => { if (!btn) return; btn.disabled = on; btn.innerHTML = on ? `<span class="lb-spin"></span><span>${escapeHtml(text)}</span>` : label; };
  busy(true, 'בחרו תיקייה בחלון שנפתח…');
  let picked = null;
  try {
    const r = await api.post('/api/library/folders/pick', {});
    if (r && r.canceled) { busy(false); return false; }
    picked = r && r.path;
  } catch (e) {
    if (e.status === 409) { busy(false); M.toast(e.message, 'warn'); return false; }
    // no native picker here → let the user paste the path
    picked = await M.promptDialog({ title: 'הוספת תיקיית צלילים', message: 'הדביקו את הנתיב המלא של התיקייה (בסייר הקבצים: לחיצה ימנית על התיקייה ← "העתק כנתיב").', placeholder: 'C:\\Users\\…\\Sounds', okLabel: 'הוספה' });
    if (picked) picked = picked.trim().replace(/^"(.*)"$/, '$1');
  }
  if (!picked) { busy(false); return false; }
  busy(true, 'מוסיף את התיקייה…');
  try {
    const r = await api.post('/api/library/folders', { path: picked });
    busy(false);
    if (!r.added) {
      M.toast(r.already === 'user' ? 'התיקייה הזו כבר בספרייה' : 'התיקייה הזו כבר נסרקת כחלק מהספרייה', 'info');
      return false;
    }
    M.toast(`התיקייה נוספה: ${folderName(r.folder)} — הצלילים יופיעו תוך כדי סריקה`);
    foldersChanged();
    return true;
  } catch (e) {
    busy(false);
    M.toast(e.message || 'לא ניתן להוסיף את התיקייה', 'error');
    return false;
  }
}

const folderName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

async function removeFolderFlow(f) {
  const ok = await M.confirmDialog({ title: 'להסיר את התיקייה מהספרייה?', message: `"${f.name}" — הצלילים שלה לא יופיעו יותר בעורך. התיקייה והקבצים במחשב לא נמחקים ולא משתנים.`, okLabel: 'הסרה מהספרייה' });
  if (!ok) return false;
  try {
    const r = await fetch(api.url('/api/library/folders'), { method: 'DELETE', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ path: f.path }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `שגיאה (${r.status})`);
    M.toast('התיקייה הוסרה מהספרייה');
    foldersChanged();
    return true;
  } catch (e) { M.toast(e.message, 'error'); return false; }
}

/**
 * "תיקיות צלילים" — a small collapsible control: the folders the library reads, with add / remove.
 * → { el, refresh(), destroy() }
 */
function folderManager(st) {
  const btn = h('button.lb-treebtn.lb-foldbtn', { type: 'button' });
  const box = h('div.lb-folders', { style: { display: st.foldersOpen ? '' : 'none' } });
  const el = h('div', null, btn, box);
  let data = null;
  const renderBtn = () => {
    const user = data ? data.folders.filter((f) => f.kind === 'user') : [];
    const off = user.filter((f) => !f.exists).length;
    btn.innerHTML = `${icon('folder', 14)}<span class="grow">תיקיות צלילים${user.length ? ` <span class="lb-cnt">${user.length}</span>` : ''}${off ? ` <span class="lb-warn" title="תיקייה לא נמצאה — אולי כונן חיצוני שלא מחובר">${icon('info', 12)}</span>` : ''}</span>${icon('chevronDown', 13)}`;
    btn.classList.toggle('open', !!st.foldersOpen);
  };
  const renderBox = () => {
    box.textContent = '';
    if (!data) { box.appendChild(h('div.lb-status', { html: '<span class="lb-spin"></span><span>טוען…</span>' })); return; }
    for (const f of data.folders) {
      const row = h('div.lb-fold', { title: f.path });
      const sub = !f.exists ? 'לא נמצאה — אולי כונן שלא מחובר' : `${f.count} צלילים${f.kind === 'builtin' ? ' · מובנה' : ''}`;
      row.innerHTML = `<span class="fi">${icon(f.kind === 'builtin' ? 'sparkles' : 'folder', 15)}</span>
        <span class="tx"><b dir="auto">${escapeHtml(f.name)}</b><span class="${f.exists ? '' : 'off'}">${escapeHtml(sub)}</span></span>`;
      if (f.removable) {
        const rm = h('button.lb-icon-btn', { title: 'הסרה מהספרייה (הקבצים לא נמחקים)', 'aria-label': 'הסרה מהספרייה', html: icon('x', 13) });
        rm.addEventListener('click', () => removeFolderFlow(f));
        row.appendChild(rm);
      }
      box.appendChild(row);
    }
    const add = h('button.lb-btn.primary.small', { type: 'button', html: `${icon('plus', 13)}<span>הוספת תיקיית צלילים</span>` });
    add.addEventListener('click', () => addSoundFolderFlow(add));
    const dl = h('button.lb-btn.ghost.small', { type: 'button', html: `${icon('upload', 13)}<span>חבילת צלילים חינמית</span>`, title: FREE_PACK_URL });
    dl.querySelector('svg').style.transform = 'rotate(180deg)';
    dl.addEventListener('click', openFreePack);
    box.append(h('div.lb-fold-actions', null, add, dl),
      h('div.lb-fold-note', { text: 'הקבצים נשארים במקום שלהם — Frame Studio רק קורא אותם.' }));
  };
  const refresh = async () => {
    try { data = await api.get('/api/library/folders'); } catch { data = data || { folders: [] }; }
    renderBtn(); if (st.foldersOpen) renderBox();
    return data;
  };
  btn.addEventListener('click', () => {
    st.foldersOpen = !st.foldersOpen;
    box.style.display = st.foldersOpen ? '' : 'none';
    renderBtn(); if (st.foldersOpen) renderBox();
  });
  renderBtn();
  return { el, refresh, get data() { return data; } };
}

/** Friendly first-run screen: no sounds yet → add a folder from the computer, or download the free bundle. */
function emptyState({ title = 'אין עדיין צלילים', music = false, ctx = null } = {}) {
  const box = h('div.lb-emptystate');
  const add = h('button.lb-bigbtn.primary', { type: 'button', html: `${icon('folder', 20)}<span>${music ? 'הוספת תיקייה עם שירים' : 'הוספת תיקיית צלילים מהמחשב'}</span>` });
  add.addEventListener('click', () => addSoundFolderFlow(add));
  const kids = [h('div.es-ic', { html: icon(music ? 'music' : 'sfx', 30) }), h('h3', { text: title })];
  if (music) {
    kids.push(h('p', { text: 'הוסיפו תיקייה עם שירים או קריינות מהמחשב — הם יופיעו כאן.' }), add);
    if (ctx && typeof ctx.selectTab === 'function') {
      const up = h('button.lb-bigbtn', { type: 'button', html: `${icon('upload', 20)}<span>העלאת קובץ שמע אחד</span>`, title: 'בלשונית מדיה' });
      up.addEventListener('click', () => ctx.selectTab('media'));
      kids.push(up);
    }
    kids.push(h('p.small', { text: 'אפשר גם לגרור קובץ שמע מהסייר ישר לציר הזמן.' }));
  } else {
    const dl = h('button.lb-bigbtn', { type: 'button', html: `${icon('upload', 20)}<span>הורדת חבילת צלילים חינמית</span>`, title: FREE_PACK_URL });
    dl.querySelector('svg').style.transform = 'rotate(180deg)';
    dl.addEventListener('click', openFreePack);
    kids.push(add, dl, h('p', { text: 'הורידו, חלצו לאן שנוח, ולחצו "הוספת תיקיית צלילים".' }));
  }
  kids.push(h('p.small', { text: 'הקבצים נשארים במקום שלהם — שום דבר לא מועתק.' }));
  box.append(...kids);
  return box;
}

/** Compact card shown while the library only has the built-in Starter Pack. */
function starterPromo(count, onClose) {
  const card = h('div.lb-promo');
  const add = h('button.lb-btn.primary.small', { type: 'button', html: `${icon('folder', 13)}<span>הוספת תיקיית צלילים</span>` });
  add.addEventListener('click', () => addSoundFolderFlow(add));
  const dl = h('button.lb-btn.small', { type: 'button', html: `<span>חבילה חינמית</span>`, title: FREE_PACK_URL });
  dl.addEventListener('click', openFreePack);
  const x = h('button.lb-icon-btn.x', { type: 'button', title: 'הסתרה', 'aria-label': 'הסתרה', html: icon('x', 12) });
  x.addEventListener('click', () => { try { localStorage.setItem(LS_PROMO, '1'); } catch { /* ignore */ } card.remove(); if (onClose) onClose(); });
  card.append(x, h('div.txt', null, h('b', { text: `${count} צלילי פתיחה מוכנים לשימוש` }), 'רוצים עוד? הוסיפו תיקייה מהמחשב או הורידו חבילה חינמית.'),
    h('div.btns', null, add, dl));
  return card;
}
const promoHidden = () => { try { return localStorage.getItem(LS_PROMO) === '1'; } catch { return false; } };

// ───────────────────────── sound FX tab ─────────────────────────

export function renderSfx(ctx) {
  const st = ctx.tabState('sfx', { q: '', dur: 'all', collection: '', node: null, treeOpen: false, open: {}, foldersOpen: false, filtersOpen: false });
  const { body } = ctx;
  ctx.setTitle('אפקטים קוליים', 'ספרייה מקומית חוקית');
  ctx.setActions([
    { icon: 'folder', title: 'תיקיות צלילים', onClick: () => { st.foldersOpen = true; st.filtersOpen = true; draw(); } },
    { icon: 'license', title: 'רישיונות הספרייה', onClick: () => ctx.showLicenses() },
  ]);
  let alive = true, cleanupView = null, pollT = 0;
  const onFolders = () => { if (alive) draw(); };
  folderListeners.add(onFolders);

  // decide between the first-run screen and the browser (based on the index status)
  const draw = async () => {
    clearTimeout(pollT);
    let info = null;
    try { info = await api.get('/api/library/folders'); } catch { info = null; }
    if (!alive) return;
    const s = info && info.status;
    if (s && s.ready && !s.indexing && s.count === 0 && s.starterPack !== 'generating' && s.starterPack !== 'unknown') {
      if (cleanupView) { cleanupView(); cleanupView = null; }
      body.textContent = '';
      body.appendChild(emptyState());
      const fm = folderManager(st);
      if ((info.folders || []).some((f) => f.kind === 'user')) { body.appendChild(fm.el); fm.refresh(); }
      return;
    }
    if (s && s.count === 0 && (s.indexing || !s.ready || s.starterPack === 'generating' || s.starterPack === 'unknown')) {
      if (cleanupView) { cleanupView(); cleanupView = null; }
      body.textContent = '';
      body.appendChild(h('div.lb-status', { html: `<span class="lb-spin"></span><span>${s.starterPack === 'generating' ? 'מכין את צלילי הפתיחה…' : s.indexing && s.total ? `סורק צלילים ${s.done}/${s.total}` : 'טוען את ספריית הצלילים…'}</span>` }));
      pollT = setTimeout(() => { if (alive && ctx.isActive('sfx')) draw(); }, 1200);
      return;
    }
    if (cleanupView) cleanupView();
    cleanupView = browseSfx(ctx, st, info);
  };
  draw();
  return () => { alive = false; clearTimeout(pollT); folderListeners.delete(onFolders); if (cleanupView) cleanupView(); player.stop(); };
}

function browseSfx(ctx, st, info) {
  const { body } = ctx;
  body.textContent = '';

  const fm = folderManager(st);
  fm.refresh();
  const s = info && info.status;
  if (s && s.count > 0 && s.count === s.starter && !s.indexing && !promoHidden() && !(info.folders || []).some((f) => f.kind === 'user')) {
    body.appendChild(starterPromo(s.starter));
  }

  // one row: search + "סינון" (categories, length and sound folders fold into one panel, so the list starts high)
  const search = h('div.lb-search');
  search.innerHTML = `<span class="ic-s">${icon('search', 15)}</span>`;
  const input = h('input', { type: 'text', placeholder: 'חיפוש: ווש, בום, riser, קליק…', value: st.q, dir: 'auto', spellcheck: false });
  const clear = h('button.lb-icon-btn.lb-clear', { title: 'ניקוי', html: icon('x', 13) });
  search.append(input, clear);
  if (st.q) search.classList.add('has');
  const filterBtn = h('button.lb-filterbtn', { type: 'button', title: 'סינון לפי קטגוריה, אורך ותיקייה', 'aria-expanded': String(!!st.filtersOpen) });
  body.appendChild(h('div.lb-row', null, search, filterBtn));

  const roles = h('div.lb-chips.roles', { title: 'סינון לפי תפקיד בסרטון — גלגלת לגלילה הצידה' });
  roles.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    roles.scrollLeft -= e.deltaY; // RTL strip: wheel down moves toward the end (left)
  }, { passive: false });
  body.appendChild(roles);
  const filters = h('div.lb-filters', { style: { display: st.filtersOpen ? '' : 'none' } });
  const treeBtn = h('button.lb-treebtn', null);
  const treeBox = h('div.lb-tree', { style: { display: st.treeOpen ? '' : 'none' } });
  const chips = h('div.lb-chips');
  for (const f of DUR_FILTERS) {
    const c = h('button.lb-chip', { text: f.label });
    if (st.dur === f.id) c.classList.add('on');
    c.addEventListener('click', () => { st.dur = f.id; chips.querySelectorAll('.lb-chip').forEach((x) => x.classList.toggle('on', x === c)); renderFilterBtn(); refresh(); });
    chips.appendChild(c);
  }
  filters.append(h('div.lb-flbl', { text: 'קטגוריה' }), treeBtn, treeBox, h('div.lb-flbl', { text: 'אורך' }), chips, fm.el);
  body.appendChild(filters);
  const renderFilterBtn = () => {
    const n = (st.node && !st.node.role ? 1 : 0) + (st.dur !== 'all' ? 1 : 0);
    filterBtn.innerHTML = `${icon('funnel', 14)}<span>סינון</span>${n ? `<span class="lb-cnt">${n}</span>` : ''}${icon('chevronDown', 12)}`;
    filterBtn.classList.toggle('on', !!st.filtersOpen);
    filterBtn.classList.toggle('active', n > 0);
    filterBtn.setAttribute('aria-expanded', String(!!st.filtersOpen));
  };
  filterBtn.addEventListener('click', () => { st.filtersOpen = !st.filtersOpen; filters.style.display = st.filtersOpen ? '' : 'none'; renderFilterBtn(); });
  renderFilterBtn();
  const status = h('div.lb-status');
  const list = h('div');
  const more = h('div.lb-more');
  body.append(status, list, more);

  const renderTreeBtn = () => {
    const n = st.node;
    treeBtn.innerHTML = `${icon('list', 14)}<span class="grow">${n ? `קטגוריה: <b>${escapeHtml(n.name)}</b>` : 'כל הקטגוריות'}</span>${n ? `<span class="lb-icon-btn" data-x="1" title="ניקוי">${icon('x', 12)}</span>` : ''}${icon('chevronDown', 13)}`;
  };
  treeBtn.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) { st.node = null; renderTreeBtn(); renderRoles(); markTree(); renderFilterBtn(); refresh(); return; }
    st.treeOpen = !st.treeOpen;
    treeBox.style.display = st.treeOpen ? '' : 'none';
  });
  renderTreeBtn();

  const markTree = () => treeBox.querySelectorAll('.lb-tnode').forEach((x) => x.classList.toggle('on', !!st.node && x.dataset.id === st.node.id));
  const renderTree = (tree) => {
    treeBox.textContent = '';
    // this tab shows sound effects only: their categories are the top level (music has its own tab)
    const sfx = tree.find((n) => n.collection === COLL_SFX && String(n.id).startsWith('col:'));
    const top = sfx ? sfx.children || [] : tree.filter((n) => n.id !== 'roles' && n.collection !== COLL_MUSIC);
    const build = (nodes, parent) => {
      for (const n of nodes) {
        const kids = (n.children || []).filter((k) => k.count > 0);
        const node = h('div.lb-tnode', { dataset: { id: n.id }, title: `${n.name} (${n.count})` });
        node.innerHTML = `<span class="tw">${kids.length ? icon('chevronLeft', 11) : ''}</span><span class="nm">${escapeHtml(n.name || 'ללא תיקייה')}</span><span class="ct">${n.count}</span>`;
        const kidBox = h('div.lb-tkids', { style: { display: st.open[n.id] ? '' : 'none' } });
        if (st.open[n.id]) node.classList.add('open');
        node.addEventListener('click', (e) => {
          if (e.target.closest('.tw') && kids.length) {
            st.open[n.id] = !st.open[n.id];
            kidBox.style.display = st.open[n.id] ? '' : 'none';
            node.classList.toggle('open', !!st.open[n.id]);
            return;
          }
          st.node = st.node && st.node.id === n.id ? null : n;
          if (kids.length && !st.open[n.id]) { st.open[n.id] = true; kidBox.style.display = ''; node.classList.add('open'); }
          renderTreeBtn(); renderRoles(); markTree(); renderFilterBtn(); refresh();
        });
        parent.appendChild(node);
        if (kids.length) { parent.appendChild(kidBox); build(kids, kidBox); }
      }
    };
    build(top, treeBox);
    if (!top.length) treeBox.appendChild(h('div.lb-empty', { text: 'אין עדיין קטגוריות' }));
    markTree();
  };
  const renderRoles = () => {
    roles.textContent = '';
    const rnode = treeCache && treeCache.find((n) => n.id === 'roles');
    if (!rnode) return;
    for (const r of rnode.children) {
      const c = h('button.lb-chip.role', { text: r.name, title: `${r.count} צלילים לתפקיד "${r.name}"` });
      if (st.node && st.node.id === r.id) c.classList.add('on');
      c.addEventListener('click', () => { st.node = st.node && st.node.id === r.id ? null : r; renderTreeBtn(); renderRoles(); markTree(); renderFilterBtn(); refresh(); });
      roles.appendChild(c);
    }
  };
  const loadTree = async () => {
    try {
      treeCache = await api.get('/api/library/sounds/categories');
      renderTree(treeCache); renderRoles();
    } catch (e) { treeBox.textContent = ''; treeBox.appendChild(h('div.lb-empty', { text: `הקטגוריות לא נטענו: ${e.message}` })); }
  };
  if (treeCache) { renderTree(treeCache); renderRoles(); } else loadTree();

  let ctrl = null, timer = 0, offset = 0, reqN = 0, wasIndexing = false, alive = true;
  const query = () => {
    const f = DUR_FILTERS.find((x) => x.id === st.dur) || DUR_FILTERS[0];
    const qs = new URLSearchParams();
    if (st.q) qs.set('q', st.q);
    const n = st.node;
    qs.set('collection', (n && n.collection) || COLL_SFX);
    if (n) {
      if (n.role) qs.set('role', n.role);
      if (n.category) qs.set('category', n.category);
      if (n.pack != null && n.id && String(n.id).startsWith('pack:')) qs.set('pack', n.pack);
    }
    if (f.min != null) qs.set('min', String(f.min));
    if (f.max != null) qs.set('max', String(f.max));
    qs.set('limit', '120');
    qs.set('offset', String(offset));
    return qs.toString();
  };
  const refresh = (append = false) => {
    if (!alive) return;
    if (!append) offset = 0;
    clearTimeout(timer);
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const my = ++reqN;
    if (!append) { status.innerHTML = `<span class="lb-spin"></span><span>מחפש…</span>`; }
    fetch(api.url(`/api/library/sounds?${query()}`), { signal: ctrl.signal })
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || r.status)))))
      .then((res) => {
        if (my !== reqN || !alive) return;
        const items = Array.isArray(res) ? res : res.items || [];
        const total = Array.isArray(res) ? items.length : res.total;
        if (!append) { list.textContent = ''; player.stop(); }
        for (const e of items) list.appendChild(soundRow(e, ctx, { role: 'sfx' }));
        offset += items.length;
        const idx = res.indexing;
        status.innerHTML = idx ? `<span class="lb-spin"></span><span>סורק צלילים ${idx.done}/${idx.total}</span><span class="bar"><i style="width:${Math.round((idx.done / Math.max(1, idx.total)) * 100)}%"></i></span>` : `<span>${total} צלילים${st.q ? ` עבור "${escapeHtml(st.q)}"` : ''}</span>`;
        more.textContent = '';
        if (offset < total) {
          const b = h('button.lb-btn.small', { text: `טעינת עוד (${total - offset})` });
          b.addEventListener('click', () => refresh(true));
          more.appendChild(b);
        }
        if (!total) list.appendChild(h('div.lb-empty', null, h('b', { text: 'לא נמצאו צלילים' }), 'נסו מילה אחרת — בעברית או באנגלית (whoosh, impact, riser), או נקו את הסינון.'));
        renderFilterBtn();
        if (idx) {
          wasIndexing = true;
          setTimeout(() => { if (alive && my === reqN && ctx.isActive('sfx')) { refresh(); loadTree(); fm.refresh(); } }, 2500);
        } else if (wasIndexing) { wasIndexing = false; loadTree(); fm.refresh(); }
      })
      .catch((e) => { if (e.name === 'AbortError') return; status.innerHTML = ''; list.textContent = ''; list.appendChild(h('div.lb-empty', null, h('b', { text: 'ספריית הצלילים לא זמינה' }), e.message)); });
  };
  input.addEventListener('input', () => {
    st.q = input.value.trim();
    search.classList.toggle('has', !!input.value);
    clearTimeout(timer);
    timer = setTimeout(() => refresh(), 160);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; st.q = ''; search.classList.remove('has'); refresh(); } });
  clear.addEventListener('click', () => { input.value = ''; st.q = ''; search.classList.remove('has'); refresh(); input.focus(); });
  refresh();
  setTimeout(() => input.focus({ preventScroll: true }), 0);
  return () => { alive = false; player.stop(); if (ctrl) ctrl.abort(); clearTimeout(timer); };
}

// ───────────────────────── music / voice tab ─────────────────────────

export function renderAudio(ctx) {
  const st = ctx.tabState('audio', { q: '', foldersOpen: false });
  const { body } = ctx;
  ctx.setTitle('אודיו', 'מוזיקה וקריינות מהמחשב');
  ctx.setActions([
    { icon: 'folder', title: 'תיקיות צלילים', onClick: () => { st.foldersOpen = true; load(); } },
    { icon: 'license', title: 'רישיונות', onClick: () => ctx.showLicenses() },
  ]);
  let alive = true, all = [], pollT = 0;
  const fm = folderManager(st);
  const search = h('div.lb-search');
  search.innerHTML = `<span class="ic-s">${icon('search', 15)}</span>`;
  const input = h('input', { type: 'text', placeholder: 'חיפוש שיר או קריינות…', value: st.q, dir: 'auto' });
  search.appendChild(input);
  const out = h('div');
  const draw = (indexing) => {
    out.textContent = '';
    const q = st.q.toLowerCase();
    const items = all.filter((e) => !q || e.name.toLowerCase().includes(q) || (e.pack || '').toLowerCase().includes(q));
    const groups = [['מוזיקה', items.filter((e) => e.category !== 'קריינות'), 'music'], ['קריינות', items.filter((e) => e.category === 'קריינות'), 'voice']];
    for (const [title, list, role] of groups) {
      if (!list.length) continue;
      out.appendChild(h('div.lb-section', { text: `${title} (${list.length})` }));
      for (const e of list) out.appendChild(soundRow(e, ctx, { role }));
    }
    if (indexing) out.prepend(h('div.lb-status', { html: `<span class="lb-spin"></span><span>סורק תיקיות ${indexing.done}/${indexing.total}</span><span class="bar"><i style="width:${Math.round((indexing.done / Math.max(1, indexing.total)) * 100)}%"></i></span>` }));
    if (!items.length && all.length) out.appendChild(h('div.lb-empty', null, h('b', { text: 'אין התאמה לחיפוש' })));
  };
  const load = async () => {
    clearTimeout(pollT);
    let res;
    try { res = await api.get(`/api/library/sounds?collection=${encodeURIComponent(COLL_MUSIC)}&limit=1000&sort=name`); }
    catch (e) { body.textContent = ''; body.appendChild(h('div.lb-empty', null, h('b', { text: 'הספרייה לא זמינה' }), e.message)); return; }
    if (!alive) return;
    all = Array.isArray(res) ? res : res.items || [];
    body.textContent = '';
    if (!all.length && !res.indexing) {
      body.appendChild(emptyState({ title: 'אין עדיין מוזיקה או קריינות', music: true, ctx }));
      fm.refresh().then((d) => { if (alive && d && d.folders.some((f) => f.kind === 'user')) body.appendChild(fm.el); });
      return;
    }
    body.append(fm.el, h('div.lb-row', null, search), out);
    fm.refresh();
    draw(res.indexing);
    if (res.indexing) pollT = setTimeout(() => { if (alive && ctx.isActive('audio')) load(); }, 2500);
  };
  const onFolders = () => { if (alive) load(); };
  folderListeners.add(onFolders);
  body.textContent = '';
  body.appendChild(h('div.lb-status', { html: '<span class="lb-spin"></span><span>טוען…</span>' }));
  input.addEventListener('input', () => { st.q = input.value.trim(); draw(null); });
  load();
  return () => { alive = false; clearTimeout(pollT); folderListeners.delete(onFolders); player.stop(); };
}
