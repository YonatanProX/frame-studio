// Frame Studio — library panel (agent L).  SPEC §6 "library-panel.js".
// Vertical tab strip (RTL start side) + tab content: מדיה, אודיו (מוזיקה וקריינות | אפקטים קוליים), טקסט, כתוביות,
// מדבקות, אפקטים, מעברים, פילטרים. Animations are picked in the inspector. Items are dragged to the timeline
// (lib-dnd payloads) or added at the playhead.

import { api, onEvent, state, on } from './api.js';
import { h, icon, injectStyle, escapeHtml } from './tl-util.js';
import { LIB_CSS } from './lib-style.js';
import * as M from './tl-menu.js';
import { insertPayload } from './timeline.js';
import { renderSfx, renderAudio, stopAudition } from './lib-sounds.js';
import { renderMedia, doUpload } from './lib-media.js';
import { renderText, renderCaptions, renderStickers, renderEffects, renderTransitions, renderFilters } from './lib-grids.js';
import { mediaFilesOf } from './lib-upload.js';
import { loadCatalog } from './lib-catalog.js';

const TABS = [
  { id: 'media', label: 'מדיה', icon: 'folder', render: renderMedia, deps: ['project'] },
  { id: 'audio', label: 'אודיו', icon: 'music', render: renderAudioTab },
  { id: 'text', label: 'טקסט', icon: 'text', render: renderText },
  { id: 'captions', label: 'כתוביות', icon: 'caption', render: renderCaptions, deps: ['project'] },
  { id: 'stickers', label: 'מדבקות', icon: 'sticker', render: renderStickers },
  { id: 'effects', label: 'אפקטים', icon: 'effects', render: renderEffects },
  { id: 'transitions', label: 'מעברים', icon: 'transition', render: renderTransitions },
  { id: 'filters', label: 'פילטרים', icon: 'filter', render: renderFilters, deps: ['selection'] },
];
// old saved tab ids → current tabs (sound effects now live inside "אודיו"; animations are in the inspector)
const TAB_ALIAS = { sfx: 'audio', anims: 'media' };
// sound effects first: they are ready on first run (Starter Pack); music & voice-over need the user's own files
const AUDIO_MODES = [{ id: 'sfx', label: 'אפקטים קוליים' }, { id: 'music', label: 'מוזיקה וקריינות' }];
const LS_KEY = 'frameStudio.library';

const P = { mounted: false, root: null, tabsEl: null, head: null, title: null, actions: null, hint: null, body: null, active: null,
  cleanup: null, states: {}, hintKind: null, timers: {}, dragDepth: 0, renderSeq: 0 };

function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify({ tab: P.active, audioMode: P.audioMode, audioPicked: !!P.audioPicked })); } catch { /* ignore */ } }
function loadPrefs() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } }

const ctx = {
  get body() { return P.body; },
  setTitle(t, sub) { P.title.innerHTML = `${escapeHtml(t)}${sub ? `<span class="lb-sub">${escapeHtml(sub)}</span>` : ''}`; },
  setActions(list) {
    P.actions.textContent = '';
    for (const a of list || []) {
      const b = h('button.lb-icon-btn', { title: a.title, 'aria-label': a.title, html: icon(a.icon, 16) });
      b.addEventListener('click', a.onClick);
      P.actions.appendChild(b);
    }
  },
  setHint(kind) { P.hintKind = kind; updateHint(); },
  tabState(id, defaults) { if (!P.states[id]) P.states[id] = { ...defaults }; return P.states[id]; },
  insert(payload, opts) {
    try { return insertPayload(payload, opts || {}); } catch (e) { M.toast(`ההוספה נכשלה: ${e.message}`, 'error'); return null; }
  },
  rerender(id) { if (P.active === id) scheduleRender(); },
  selectTab: (id) => selectTab(id),
  isActive(id) { return P.active === id; },
  showLicenses,
  watchJob,
  updateUploads: null,
};

function updateHint() {
  const el = P.hint;
  if (!el) return;
  const kind = { effects: 'effect', filters: 'filter', transitions: 'transition' }[P.active] || null;
  const n = state.selection ? state.selection.size || 0 : 0;
  if (!kind || !P.hintKind) { el.classList.remove('show'); return; }
  let txt;
  if (n) txt = kind === 'transition' ? `לחיצה תוסיף מעבר לחיבור של הקליפ הנבחר` : `לחיצה תחיל על ${n === 1 ? 'הקליפ הנבחר' : `${n} הקליפים הנבחרים`}`;
  else txt = kind === 'effect' ? 'אין בחירה — לחיצה תוסיף שכבת אפקט בסמן הניגון' : kind === 'filter' ? 'אין בחירה — לחיצה תוסיף שכבת התאמה בסמן הניגון' : 'גררו אל חיבור בין שני קליפים (או בחרו קליפ)';
  el.innerHTML = `${icon('info', 13)}<span>${escapeHtml(txt)}</span>`;
  el.classList.add('show');
}

export function mount(el) {
  if (P.mounted) { el.appendChild(P.root); return; }
  P.mounted = true;
  injectStyle('fs-l-library-css', LIB_CSS);
  const root = h('div.fs-lib', { dir: 'rtl', 'aria-label': 'ספרייה' });
  P.root = root;
  P.tabsEl = h('nav.lb-tabs', { role: 'tablist' });
  for (const t of TABS) {
    const b = h('button.lb-tab', { role: 'tab', title: t.label, dataset: { tab: t.id }, html: `${icon(t.icon, 20)}<span>${escapeHtml(t.label)}</span>` });
    b.addEventListener('click', () => selectTab(t.id));
    P.tabsEl.appendChild(b);
  }
  P.title = h('div.lb-title');
  P.actions = h('div', { style: { display: 'flex', gap: '2px' } });
  P.head = h('div.lb-head', null, P.title, P.actions);
  P.hint = h('div.lb-hint');
  P.body = h('div.lb-body');
  const dropAll = h('div.lb-dropall', { html: `${icon('upload', 30)}<span>שחררו כאן כדי לייבא לפרויקט</span>` });
  const main = h('div.lb-main', null, P.head, P.hint, P.body);
  root.append(P.tabsEl, main, dropAll);
  el.appendChild(root);

  // Explorer files dropped anywhere on the panel → upload into the media bin
  root.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); P.dragDepth++; root.classList.add('filedrag'); } });
  root.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  root.addEventListener('dragleave', (e) => { if (hasFiles(e)) { P.dragDepth = Math.max(0, P.dragDepth - 1); if (!P.dragDepth) root.classList.remove('filedrag'); } });
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    P.dragDepth = 0;
    root.classList.remove('filedrag');
    const files = mediaFilesOf(e.dataTransfer);
    if (!files.length) { M.toast('סוג הקובץ לא נתמך — וידאו, תמונה או אודיו', 'warn'); return; }
    if (!state.projectId) { M.toast('פתחו פרויקט קודם', 'warn'); return; }
    selectTab('media');
    doUpload(files, ctx);
  });

  on('project', () => { const t = TABS.find((x) => x.id === P.active); if (t && t.deps && t.deps.includes('project')) scheduleRender(); });
  on('selection', () => { updateHint(); const t = TABS.find((x) => x.id === P.active); if (t && t.deps && t.deps.includes('selection')) scheduleRender(); });
  on('projectId', () => { if (P.active === 'media' || P.active === 'captions') scheduleRender(); });
  onEvent('media', () => { if (P.active === 'media') scheduleRender(); });
  loadCatalog().catch(() => {});
  const prefs = loadPrefs();
  // "אודיו" opens on the ready sound effects unless the user picked "מוזיקה וקריינות" themselves
  P.audioPicked = !!prefs.audioPicked;
  P.audioMode = P.audioPicked && prefs.audioMode === 'music' ? 'music' : 'sfx';
  const want = TAB_ALIAS[prefs.tab] || prefs.tab;
  selectTab(TABS.some((t) => t.id === want) ? want : 'media');
}

/** "אודיו": one tab, two modes (segmented control) — music & voice-over | sound effects. */
function renderAudioTab(ctx0) {
  const seg = h('div.lb-seg', { role: 'tablist', 'aria-label': 'סוג האודיו' });
  const host = h('div.lb-audio-body');
  let cleanup = null;
  const sub = Object.create(ctx0, {
    body: { get: () => host },
    // lib-sounds checks isActive('sfx') to keep refreshing while the sound index is being built
    isActive: { value: (id) => P.active === 'audio' && (id === 'audio' || id === P.audioMode || (id === 'sfx' && P.audioMode === 'sfx')) },
  });
  const show = async () => {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    stopAudition();
    for (const b of seg.children) { const on = b.dataset.mode === P.audioMode; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    const r = await (P.audioMode === 'sfx' ? renderSfx(sub) : renderAudio(sub));
    cleanup = typeof r === 'function' ? r : null;
    ctx0.setTitle('אודיו', P.audioMode === 'sfx' ? 'ספריית צלילים מקומית' : 'מוזיקה וקריינות מהמחשב');
  };
  for (const m of AUDIO_MODES) {
    const b = h('button', { type: 'button', role: 'tab', dataset: { mode: m.id }, text: m.label, title: m.label });
    b.addEventListener('click', () => { if (P.audioMode === m.id) return; P.audioMode = m.id; P.audioPicked = true; savePrefs(); show(); });
    seg.appendChild(b);
  }
  ctx0.body.textContent = '';
  ctx0.body.append(seg, host);
  show();
  return () => { if (cleanup) { try { cleanup(); } catch { /* ignore */ } } };
}

function hasFiles(e) { return [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files'); }

export function selectTab(id) {
  if (!P.mounted) return;
  if (id === 'sfx') P.audioMode = 'sfx';
  id = TAB_ALIAS[id] || id;
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  if (P.active !== tab.id) {
    if (P.cleanup) { try { P.cleanup(); } catch { /* ignore */ } P.cleanup = null; }
    stopAudition();
    P.active = tab.id;
    P.hintKind = null;
    P.body.scrollTop = 0;
    savePrefs();
  }
  for (const b of P.tabsEl.children) b.classList.toggle('on', b.dataset.tab === tab.id);
  renderNow();
}

function scheduleRender() {
  clearTimeout(P.timers.render);
  P.timers.render = setTimeout(renderNow, 120);
}

async function renderNow() {
  const tab = TABS.find((t) => t.id === P.active);
  if (!tab) return;
  const seq = ++P.renderSeq;
  const scroll = P.body.scrollTop;
  if (P.cleanup && tab.id !== 'audio') { try { P.cleanup(); } catch { /* ignore */ } P.cleanup = null; }
  // the sound tab keeps its own live state; re-rendering it only happens on tab switch
  if (tab.id === 'audio' && P.cleanup && P.renderedTab === tab.id) return;
  P.hintKind = null;
  updateHint();
  try {
    const r = await tab.render(ctx);
    if (seq !== P.renderSeq) return;
    if (typeof r === 'function') P.cleanup = r;
    P.renderedTab = tab.id;
    P.body.scrollTop = scroll;
  } catch (e) {
    console.error('[library] render failed', e);
    P.body.textContent = '';
    P.body.appendChild(h('div.lb-empty', null, h('b', { text: 'הלשונית לא נטענה' }), String(e && e.message || e)));
  }
}

// ───────────────────────── licenses dialog ─────────────────────────

function mdToHtml(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let inList = false, table = null;
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter((r) => !/^\s*\|?\s*-{2,}/.test(r));
    out.push('<table>' + rows.map((r, i) => {
      const cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      return '<tr>' + cells.map((c) => (i === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('') + '</tr>';
    }).join('') + '</table>');
    table = null;
  };
  for (const l of lines) {
    if (/^\s*\|/.test(l)) { if (inList) { out.push('</ul>'); inList = false; } (table = table || []).push(l); continue; }
    flushTable();
    if (/^#\s+/.test(l)) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h1>${inline(l.replace(/^#\s+/, ''))}</h1>`); }
    else if (/^##+\s+/.test(l)) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h2>${inline(l.replace(/^##+\s+/, ''))}</h2>`); }
    else if (/^\s*[-*]\s+/.test(l)) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`); }
    else if (!l.trim()) { if (inList) { out.push('</ul>'); inList = false; } }
    else { if (inList) { out.push('</ul>'); inList = false; } out.push(`<p>${inline(l)}</p>`); }
  }
  flushTable();
  if (inList) out.push('</ul>');
  return out.join('');
}

async function showLicenses() {
  let md;
  try { md = await api.get('/api/library/licenses'); } catch (e) { md = `# רישיונות\n\nלא ניתן לטעון: ${e.message}`; }
  const box = h('div.fsm-dialog', { style: { maxWidth: '640px', width: '92vw' } });
  const body = h('div.lb-lic-md', { html: mdToHtml(typeof md === 'string' ? md : JSON.stringify(md)) });
  const close = h('button.fsm-btn.fsm-primary', { text: 'סגירה' });
  box.append(body, h('div.fsm-btns', null, close));
  const back = h('div.fsm-dialog-back', null, box);
  const done = () => { back.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
  close.addEventListener('click', done);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) done(); });
  document.addEventListener('keydown', key, true);
  M.closeMenus();
  M.ensureMenuCss();
  document.body.appendChild(back);
}

// ───────────────────────── jobs ─────────────────────────

const jobWatchers = new Map();
let jobSub = null;
function watchJob(jobId, fn) {
  if (!jobId) return;
  jobWatchers.set(jobId, fn);
  if (!jobSub) {
    jobSub = onEvent('job', (ev) => {
      const j = ev && (ev.job || ev);
      if (!j || !j.id) return;
      const w = jobWatchers.get(j.id);
      if (w) { w(j); if (isFinished(j)) jobWatchers.delete(j.id); }
    });
  }
  // polling fallback (when job events are not broadcast for this job type)
  const poll = async () => {
    if (!jobWatchers.has(jobId)) return;
    try {
      const j = await api.get(`/api/jobs/${encodeURIComponent(jobId)}`);
      const job = j && (j.job || j);
      if (job && jobWatchers.has(jobId)) { fn(job); if (isFinished(job)) { jobWatchers.delete(jobId); return; } }
    } catch { /* the route may not exist for this job; SSE still works */ }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 1500);
}
function isFinished(j) { return ['done', 'error', 'failed', 'finished', 'canceled'].includes(j.status || j.state) || j.done === true || !!j.error; }
