// Frame Studio — library panel: sound FX browser + music/voice ("אודיו") tabs (agent L).
// Server-side search (/api/library/sounds), category tree, duration filter, audition with moving progress line,
// mini waveforms (entry.wave), license badges, drag & drop + add at playhead.

import { api } from './api.js';
import { h, icon, escapeHtml, formatDuration } from './tl-util.js';
import { startDrag, endDrag } from './lib-dnd.js';
import * as M from './tl-menu.js';

const LIC = {
  sonniss: { label: 'Sonniss', cls: '', title: 'Sonniss GDC 2026 — ללא תמלוגים, מסחרי, בלי קרדיט. אסור לאמן עליו בינה מלאכותית.' },
  mixkit: { label: 'Mixkit', cls: 'mixkit', title: 'Mixkit — חינמי למסחרי ברשתות ובפרסומות, בלי קרדיט. אסור להפיץ את הקבצים עצמם.' },
  own: { label: 'שלי', cls: 'own', title: 'קובץ שלך (תיקייה מ-"library.music" ב-config.json)' },
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
  const lic = LIC[entry.license] || LIC.sonniss;
  const row = h('div.lb-snd', { title: `${entry.name}\n${entry.category} · ${entry.pack || entry.collection}\nלחיצה — האזנה · גרירה לציר הזמן · + הוספה בסמן הניגון`, draggable: 'true' });
  row.innerHTML = `<button class="pl" title="האזנה">${icon('play', 13)}</button>
    <div class="nm" dir="auto">${escapeHtml(entry.name)}</div>
    <canvas class="wv" width="70" height="22"></canvas>
    <div class="meta">${entry.role ? `<span class="lb-role" title="תפקיד מומלץ במפת האפקטים של Chordix${entry.suggest ? ` · ${entry.suggest.gainDb} dB` : ''}">${escapeHtml(entry.role)}</span>` : ''}<span class="lb-lic ${lic.cls}" title="${escapeHtml(lic.title)}">${lic.label}</span><span class="cat">${escapeHtml(entry.category)}${entry.pack && entry.collection !== 'נבחרים לסושיאל' ? ` · ${escapeHtml(entry.pack.replace(/^.*? - /, ''))}` : ''}</span></div>
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

// ───────────────────────── sound FX tab ─────────────────────────

let treeCache = null;

export function renderSfx(ctx) {
  const st = ctx.tabState('sfx', { q: '', dur: 'all', collection: '', node: null, treeOpen: false, open: {} });
  const { body } = ctx;
  ctx.setTitle('אפקטים קוליים', 'ספרייה מקומית חוקית');
  ctx.setActions([{ icon: 'license', title: 'רישיונות הספרייה', onClick: () => ctx.showLicenses() }]);
  body.textContent = '';

  const search = h('div.lb-search');
  search.innerHTML = `<span class="ic-s">${icon('search', 15)}</span>`;
  const input = h('input', { type: 'text', placeholder: 'חיפוש: ווש, בום, riser, קליק, מחיאות כפיים…', value: st.q, dir: 'auto', spellcheck: false });
  const clear = h('button.lb-icon-btn.lb-clear', { title: 'ניקוי', html: icon('x', 13) });
  search.append(input, clear);
  if (st.q) search.classList.add('has');
  body.appendChild(h('div.lb-row', null, search));

  const roles = h('div.lb-chips.roles', { title: 'תפקידים מומלצים (מפת האפקטים של Chordix) — גלגלת לגלילה הצידה' });
  roles.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    roles.scrollLeft -= e.deltaY; // RTL strip: wheel down moves toward the end (left)
  }, { passive: false });
  body.appendChild(roles);
  const treeBtn = h('button.lb-treebtn', null);
  const treeBox = h('div.lb-tree', { style: { display: st.treeOpen ? '' : 'none' } });
  body.append(treeBtn, treeBox);
  const chips = h('div.lb-chips');
  for (const f of DUR_FILTERS) {
    const c = h('button.lb-chip', { text: f.label });
    if (st.dur === f.id) c.classList.add('on');
    c.addEventListener('click', () => { st.dur = f.id; chips.querySelectorAll('.lb-chip').forEach((x) => x.classList.toggle('on', x === c)); refresh(); });
    chips.appendChild(c);
  }
  body.appendChild(chips);
  const status = h('div.lb-status');
  const list = h('div');
  const more = h('div.lb-more');
  body.append(status, list, more);

  const renderTreeBtn = () => {
    const n = st.node;
    treeBtn.innerHTML = `${icon('list', 14)}<span class="grow">${n ? `קטגוריה: <b>${escapeHtml(n.name)}</b>` : 'כל הקטגוריות'}</span>${n ? `<span class="lb-icon-btn" data-x="1" title="ניקוי">${icon('x', 12)}</span>` : ''}${icon('chevronDown', 13)}`;
  };
  treeBtn.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) { st.node = null; renderTreeBtn(); renderRoles(); markTree(); refresh(); return; }
    st.treeOpen = !st.treeOpen;
    treeBox.style.display = st.treeOpen ? '' : 'none';
  });
  renderTreeBtn();

  const markTree = () => treeBox.querySelectorAll('.lb-tnode').forEach((x) => x.classList.toggle('on', !!st.node && x.dataset.id === st.node.id));
  const renderTree = (tree) => {
    treeBox.textContent = '';
    const build = (nodes, parent, depth) => {
      for (const n of nodes) {
        if (depth === 0 && n.id === 'roles') continue; // roles shown as chips
        const kids = (n.children || []).filter((k) => k.count > 0);
        const node = h('div.lb-tnode', { dataset: { id: n.id }, title: `${n.name} (${n.count})` });
        node.innerHTML = `<span class="tw">${kids.length ? icon('chevronLeft', 11) : ''}</span><span class="nm">${escapeHtml(n.name)}</span><span class="ct">${n.count}</span>`;
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
          renderTreeBtn(); renderRoles(); markTree(); refresh();
        });
        parent.appendChild(node);
        if (kids.length) { parent.appendChild(kidBox); build(kids, kidBox, depth + 1); }
      }
    };
    build(tree, treeBox, 0);
    markTree();
  };
  const renderRoles = () => {
    roles.textContent = '';
    const rnode = treeCache && treeCache.find((n) => n.id === 'roles');
    if (!rnode) return;
    for (const r of rnode.children) {
      const c = h('button.lb-chip.role', { text: r.name, title: `${r.count} צלילים מומלצים לתפקיד "${r.name}" (מפת האפקטים של Chordix)` });
      if (st.node && st.node.id === r.id) c.classList.add('on');
      c.addEventListener('click', () => { st.node = st.node && st.node.id === r.id ? null : r; renderTreeBtn(); renderRoles(); markTree(); refresh(); });
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

  let ctrl = null, timer = 0, offset = 0, reqN = 0;
  const query = () => {
    const f = DUR_FILTERS.find((x) => x.id === st.dur) || DUR_FILTERS[0];
    const qs = new URLSearchParams();
    if (st.q) qs.set('q', st.q);
    const n = st.node;
    if (n) {
      if (n.role) qs.set('role', n.role);
      if (n.collection) qs.set('collection', n.collection);
      if (n.category) qs.set('category', n.category);
      if (n.pack) qs.set('pack', n.pack);
    }
    if (f.min != null) qs.set('min', String(f.min));
    if (f.max != null) qs.set('max', String(f.max));
    qs.set('limit', '120');
    qs.set('offset', String(offset));
    return qs.toString();
  };
  const refresh = (append = false) => {
    if (!append) offset = 0;
    clearTimeout(timer);
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const my = ++reqN;
    if (!append) { status.innerHTML = `<span class="lb-spin"></span><span>מחפש…</span>`; }
    fetch(api.url(`/api/library/sounds?${query()}`), { signal: ctrl.signal })
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || r.status)))))
      .then((res) => {
        if (my !== reqN) return;
        const items = Array.isArray(res) ? res : res.items || [];
        const total = Array.isArray(res) ? items.length : res.total;
        if (!append) { list.textContent = ''; player.stop(); }
        for (const e of items) list.appendChild(soundRow(e, ctx, { role: 'sfx' }));
        offset += items.length;
        const idx = res.indexing;
        status.innerHTML = idx ? `<span class="lb-spin"></span><span>מאנדקס את הספרייה ${idx.done}/${idx.total}</span><span class="bar"><i style="width:${Math.round((idx.done / Math.max(1, idx.total)) * 100)}%"></i></span>` : `<span>${total} צלילים${st.q ? ` עבור "${escapeHtml(st.q)}"` : ''}</span>`;
        more.textContent = '';
        if (offset < total) {
          const b = h('button.lb-btn.small', { text: `טעינת עוד (${total - offset})` });
          b.addEventListener('click', () => refresh(true));
          more.appendChild(b);
        }
        if (!total) list.appendChild(h('div.lb-empty', null, h('b', { text: 'לא נמצאו צלילים' }), 'נסה מילה אחרת — בעברית או באנגלית (whoosh, impact, riser), או נקה את הסינון.'));
        if (idx) setTimeout(() => { if (my === reqN && ctx.isActive('sfx')) { refresh(); if (!treeCache || treeCache.length < 2) loadTree(); } }, 2500);
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
  return () => { player.stop(); if (ctrl) ctrl.abort(); clearTimeout(timer); };
}

// ───────────────────────── music / voice tab ─────────────────────────

export function renderAudio(ctx) {
  const st = ctx.tabState('audio', { q: '' });
  const { body } = ctx;
  ctx.setTitle('אודיו', 'מוזיקה וקריינות מהמחשב');
  ctx.setActions([{ icon: 'license', title: 'רישיונות', onClick: () => ctx.showLicenses() }]);
  body.textContent = '';
  const search = h('div.lb-search');
  search.innerHTML = `<span class="ic-s">${icon('search', 15)}</span>`;
  const input = h('input', { type: 'text', placeholder: 'חיפוש שיר או קריינות…', value: st.q, dir: 'auto' });
  search.appendChild(input);
  body.appendChild(h('div.lb-row', null, search));
  const out = h('div');
  body.appendChild(out);
  let all = [];
  const draw = () => {
    out.textContent = '';
    const q = st.q.toLowerCase();
    const items = all.filter((e) => !q || e.name.toLowerCase().includes(q) || (e.pack || '').toLowerCase().includes(q));
    const groups = [['מוזיקה', items.filter((e) => e.category !== 'קריינות'), 'music'], ['קריינות', items.filter((e) => e.category === 'קריינות'), 'voice']];
    for (const [title, list, role] of groups) {
      if (!list.length) continue;
      out.appendChild(h('div.lb-section', { text: `${title} (${list.length})` }));
      for (const e of list) out.appendChild(soundRow(e, ctx, { role }));
    }
    if (!items.length) out.appendChild(h('div.lb-empty', null, h('b', { text: all.length ? 'אין התאמה לחיפוש' : 'אין קובצי מוזיקה' }),
      all.length ? '' : 'אפשר להוסיף תיקיות ב-config.json תחת "library" → "music", או לייבא קבצים בלשונית "מדיה".'));
  };
  out.appendChild(h('div.lb-status', { html: '<span class="lb-spin"></span><span>טוען…</span>' }));
  api.get(`/api/library/sounds?collection=${encodeURIComponent('מוזיקה')}&limit=1000&sort=name`).then((res) => { all = Array.isArray(res) ? res : res.items || []; draw(); })
    .catch((e) => { out.textContent = ''; out.appendChild(h('div.lb-empty', null, h('b', { text: 'הספרייה לא זמינה' }), e.message)); });
  input.addEventListener('input', () => { st.q = input.value.trim(); draw(); });
  return () => player.stop();
}
