// Frame Studio — app/main.js (owner: U)
// Boot: project manager or open ?project=ID → SSE live sync → mount viewer, inspector, timeline (L), library (L).
// Top bar (logo, name, undo/redo, save state, quiet "קלוד מחובר" indicator, export), resizable splitters, one short
// toast per Claude edit (the timeline flashes the changed clips once), global shortcuts, file drops, export dialog.
import { state, on, onEvent, api, applyOps, undo, redo, openProject } from './api.js';
import { h, toast, store, relTime, clamp, escapeHtml } from './ui-kit.js';
import { hydrateIcons, icon } from './ui-icons.js';
import * as M from './ui-model.js';
import * as viewer from './viewer.js';
import * as inspector from './inspector.js';
import { openProjectManager } from './ui-projects.js';
import { openExportDialog, jobInfo, dialogTracks } from './ui-export.js';
import { installShortcuts, openShortcutsHelp } from './ui-shortcuts.js';

const $ = (sel) => document.querySelector(sel);
let timelineModule = null; // agent L's timeline.js once mounted (its `commands` back the global shortcuts)
const LAYOUT_KEY = 'fs.layout';
const DEFAULT_LAYOUT = { lib: 340, insp: 330, timeline: 330 };

boot();

async function boot() {
  hydrateIcons(document);
  setupSplitters();
  setupTopbar();
  setupLiveSync();
  guardFileDrops();
  installShortcuts({ viewer, openExport, openProjects, getTimeline: () => timelineModule });
  window.FrameStudio = { state, api, applyOps, undo, redo, viewer, inspector, toast, version: 1 };

  const id = new URLSearchParams(location.search).get('project');
  if (!id) { document.body.classList.add('no-project'); openProjectManager({ closable: false }); return; }
  try {
    await openProject(id);
  } catch (e) {
    const msg = e.status === 404 ? `הפרויקט "${id}" לא נמצא` : `לא ניתן לפתוח את הפרויקט "${id}": ${e.message}`;
    openProjectManager({ closable: false, error: msg });
    return;
  }
  await mountModules();
  store.set('fs.lastProject', id);
}

function openExport() { openExportDialog(viewer); }
function openProjects() { openProjectManager({ closable: true }); }

// ---------------------------------------------------------------- modules
async function mountModules() {
  mountSafe('נגן', () => viewer.mount($('#viewer')), $('#viewer'));
  mountSafe('מאפיינים', () => inspector.mount($('#inspector')), $('#inspector'));
  const tlEl = $('#timeline'); const libEl = $('#library');
  loading(tlEl, 'טוען ציר זמן…'); loading(libEl, 'טוען ספרייה…');
  const [tl, lib] = await Promise.allSettled([import('./timeline.js'), import('./library-panel.js')]);
  if (mountDynamic(tl, tlEl, 'ציר הזמן')) {
    timelineModule = tl.value;
    if (typeof tl.value.insertPayload === 'function') viewer.setInsertHandler(tl.value.insertPayload);
  }
  mountDynamic(lib, libEl, 'הספרייה');
}
function loading(el, text) { el.innerHTML = ''; el.appendChild(h('div.mod-loading', h('span.spinner'), text)); }
function mountSafe(label, fn, el) {
  try { fn(); }
  catch (e) { console.error(`[main] mount ${label}`, e); failBox(el, label, e); }
}
function mountDynamic(res, el, label) {
  el.innerHTML = '';
  if (res.status !== 'fulfilled' || typeof res.value?.mount !== 'function') {
    const err = res.status === 'rejected' ? res.reason : new Error('mount(el) לא נמצא במודול');
    console.error(`[main] ${label} לא נטען`, err);
    failBox(el, label, err);
    return false;
  }
  try { res.value.mount(el); return true; } catch (e) { console.error(`[main] mount ${label}`, e); el.innerHTML = ''; failBox(el, label, e); return false; }
}
function failBox(el, label, err) {
  el.appendChild(h('div.mod-fail', { html: `${icon('alert', 26)}<b>ה${escapeHtml(label.replace(/^ה/, ''))} לא נטען</b>שאר העורך ממשיך לעבוד. רענון (F5) יטען שוב.<code>${escapeHtml(String(err?.message || err))}</code>` }));
}

// ---------------------------------------------------------------- splitters
function setupSplitters() {
  const root = document.documentElement;
  let L = { ...DEFAULT_LAYOUT, ...(store.get(LAYOUT_KEY, {}) || {}) };
  const apply = () => {
    const W = window.innerWidth; const H = window.innerHeight;
    L.lib = clamp(L.lib, 220, Math.max(240, W * 0.4));
    L.insp = clamp(L.insp, 250, Math.max(260, W * 0.4));
    L.timeline = clamp(L.timeline, 150, Math.max(170, H - 300));
    root.style.setProperty('--lib-w', `${Math.round(L.lib)}px`);
    root.style.setProperty('--insp-w', `${Math.round(L.insp)}px`);
    root.style.setProperty('--timeline-h', `${Math.round(L.timeline)}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  for (const sp of document.querySelectorAll('.splitter')) {
    const which = sp.dataset.split;
    sp.addEventListener('dblclick', () => { L[which] = DEFAULT_LAYOUT[which]; apply(); store.set(LAYOUT_KEY, L); });
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX; const sy = e.clientY; const start = L[which];
      sp.classList.add('dragging'); document.body.classList.add('resizing');
      document.body.style.cursor = which === 'timeline' ? 'row-resize' : 'col-resize';
      try { sp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const move = (ev) => {
        const dx = ev.clientX - sx; const dy = ev.clientY - sy;
        // RTL: library is the rightmost column (grows when dragging left); inspector is leftmost (grows dragging right)
        if (which === 'lib') L.lib = start - dx;
        else if (which === 'insp') L.insp = start + dx;
        else L.timeline = start - dy;
        apply();
      };
      const up = () => {
        sp.classList.remove('dragging'); document.body.classList.remove('resizing'); document.body.style.cursor = '';
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        store.set(LAYOUT_KEY, L);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}

// ---------------------------------------------------------------- top bar
function setupTopbar() {
  const nameIn = $('#projName');
  const fitName = () => { nameIn.style.width = `${clamp((nameIn.value.length || 6) * 7.6 + 26, 90, 320)}px`; };
  nameIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') nameIn.blur();
    if (e.key === 'Escape') { nameIn.value = state.project?.name || ''; nameIn.blur(); }
  });
  nameIn.addEventListener('input', fitName);
  nameIn.addEventListener('change', () => {
    const v = nameIn.value.trim();
    if (!v) { nameIn.value = state.project?.name || ''; fitName(); return; }
    if (v !== state.project?.name) applyOps([{ op: 'renameProject', name: v }], `שינוי שם הפרויקט ל"${v}"`);
  });
  $('#btnUndo').addEventListener('click', () => undo());
  $('#btnRedo').addEventListener('click', () => redo());
  $('#btnExport').addEventListener('click', openExport);
  $('#btnKeys').addEventListener('click', () => openShortcutsHelp());
  const brand = $('#brand');
  brand.addEventListener('click', openProjects);
  brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProjects(); } });

  // size / fps / duration live in the project settings (inspector with nothing selected), not in the top bar
  const paint = () => {
    const p = state.project;
    if (!p) return;
    if (document.activeElement !== nameIn) { nameIn.value = p.name || p.id; fitName(); }
    document.title = `${p.name || p.id} — Frame Studio`;
  };
  on('project', paint);
  paint();

  const undoBtn = $('#btnUndo'); const redoBtn = $('#btnRedo');
  on('history', (hh) => {
    if (!hh?.known) return;
    undoBtn.disabled = !hh.undo; redoBtn.disabled = !hh.redo;
    undoBtn.title = hh.undo ? `ביטול: ${hh.undoSummary || 'פעולה אחרונה'} (Ctrl+Z)` : 'אין מה לבטל';
    redoBtn.title = hh.redo ? `ביצוע מחדש: ${hh.redoSummary || ''} (Ctrl+Shift+Z)` : 'אין מה לבצע מחדש';
  });

  // save state
  const ss = $('#saveState'); const txt = ss.querySelector('.txt');
  let errTimer = null;
  onEvent('sync', (s) => {
    if (ss.classList.contains('error') && !s.pending) return;
    ss.classList.toggle('saving', s.pending > 0);
    txt.textContent = s.pending > 0 ? 'שומר…' : 'נשמר';
    ss.title = s.rev >= 0 ? `גרסה ${s.rev}` : '';
  });
  onEvent('error', (ev) => {
    toast(ev.message, { type: 'error' });
    ss.classList.add('error'); ss.classList.remove('saving'); txt.textContent = 'שגיאה';
    clearTimeout(errTimer); errTimer = setTimeout(() => { ss.classList.remove('error'); txt.textContent = 'נשמר'; }, 5000);
  });
}

// ---------------------------------------------------------------- live sync: Claude indicator, one short toast
function setupLiveSync() {
  const ind = $('#claudeInd'); const label = ind.querySelector('.txt');
  let lastClaude = null; let activeTimer = null;
  const paint = () => {
    const c = state.connected;
    ind.classList.toggle('on', c); ind.classList.toggle('off', !c);
    if (!ind.classList.contains('active')) label.textContent = c ? 'קלוד מחובר' : (state.projectId ? 'אין חיבור' : 'מתחבר…');
    ind.title = c
      ? `מחובר לשרת Frame Studio — קלוד עורך דרך ה־API והשינויים מופיעים כאן בזמן אמת${lastClaude ? `\nעריכה אחרונה של קלוד: ${relTime(lastClaude.at)} — ${lastClaude.summary || ''}` : ''}`
      : 'החיבור לשרת נותק — מנסה להתחבר מחדש…';
  };
  on('connected', paint);
  paint();
  let everConnected = false; let droppedAt = 0;
  onEvent('connection', ({ connected }) => {
    if (!connected) {
      if (everConnected && !droppedAt) { droppedAt = Date.now(); toast('החיבור לשרת נותק — מנסה להתחבר מחדש…', { type: 'warn', timeout: 3500 }); }
      return;
    }
    if (droppedAt) toast('החיבור לשרת חזר', { type: 'success', timeout: 2000 });
    droppedAt = 0; everConnected = true;
  });

  onEvent('claude', (ev) => {
    lastClaude = { at: Date.now(), summary: ev.summary };
    // quiet: the dot changes colour for a moment, one short toast, and the timeline flashes the changed clips once
    ind.classList.add('active');
    label.textContent = 'קלוד עורך…';
    clearTimeout(activeTimer);
    activeTimer = setTimeout(() => { ind.classList.remove('active'); paint(); }, 3000);
    paint();
    const line = String(ev.summary || 'עדכון בפרויקט').split('\n')[0];
    toast(line, { type: 'claude', timeout: 3000 });
  });

  // jobs started elsewhere (Claude's CLI export/snapshot, transcription) → short toasts
  const seen = new Set();
  onEvent('job', (ev) => {
    const info = jobInfo(ev.job);
    if (!info?.id || seen.has(info.id)) return;
    if (info.status !== 'done' && info.status !== 'failed') return;
    if (info.type === 'media') return; // media derivatives are shown in the media bin
    seen.add(info.id);
    if (dialogTracks(info.id)) return;
    if (info.status === 'done') {
      if (info.type === 'export') toast(info.output || 'הקובץ נשמר בתיקיית exports', { type: 'success', title: 'ייצוא הושלם', timeout: 8000, action: info.output ? { label: 'העתקת נתיב', onClick: () => navigator.clipboard?.writeText(info.output) } : null });
      // snapshots are Claude's own QA renders — no toast
      else if (info.type === 'transcribe') toast('התמלול הסתיים', { type: 'success' });
    } else if (info.type === 'export') toast(info.error || 'הייצוא נכשל', { type: 'error', title: 'ייצוא נכשל' });
  });
}

// ---------------------------------------------------------------- audio scrub while dragging the playhead (timeline)
let lastExternalSeek = 0;
on('playhead', (t, keys, d) => {
  if (!d || state.playing || d.source === 'viewer') return;
  const now = performance.now();
  const dragging = now - lastExternalSeek < 180;
  lastExternalSeek = now;
  if (!dragging) return;
  try { viewer.getAudioEngine?.()?.scrub?.(t); } catch { /* ignore */ }
});

// ---------------------------------------------------------------- file drops from Explorer
function guardFileDrops() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    if (e.defaultPrevented) return; // a panel (media bin / timeline) already handled it
    e.preventDefault();
    if (!state.projectId) { toast('פתחו פרויקט קודם', { type: 'warn' }); return; }
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    const onViewer = !!e.target?.closest?.('#viewer');
    await uploadFiles(files, { addAtPlayhead: onViewer });
  });
}

const MEDIA_RE = /\.(mp4|mov|m4v|webm|mkv|avi|png|jpe?g|webp|gif|bmp|wav|mp3|m4a|aac|flac|ogg|aiff?)$/i;
export async function uploadFiles(files, { addAtPlayhead = false } = {}) {
  const ok = files.filter((f) => MEDIA_RE.test(f.name));
  if (!ok.length) { toast('סוג הקובץ לא נתמך — וידאו, תמונה או אודיו בלבד', { type: 'warn' }); return []; }
  const t0 = state.playhead;
  const tt = toast(`מעלה ${ok.length} קבצים…`, { timeout: 0 });
  const media = [];
  for (const f of ok) {
    try {
      const res = await api.post(`/api/projects/${encodeURIComponent(state.projectId)}/upload?name=${encodeURIComponent(f.name)}`, f);
      const list = Array.isArray(res?.media) ? res.media : res?.media ? [res.media] : res?.id ? [res] : [];
      media.push(...list);
    } catch (err) { toast(`העלאת ${f.name} נכשלה: ${err.message}`, { type: 'error' }); }
  }
  tt.dismiss();
  if (!media.length) return [];
  toast(media.length > 1 ? `יובאו ${media.length} קבצים לספריית המדיה` : `"${media[0].name || ok[0].name}" יובא לספריית המדיה`, { type: 'success' });
  if (addAtPlayhead) {
    let t = t0; const ops = [];
    for (const m of media) {
      const type = m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video';
      ops.push({ op: 'addClip', type, mediaId: m.id, start: M.snapToFrame(t, state.project?.settings?.fps || 30) });
      t += m.kind === 'image' ? 3 : (m.duration || 3);
    }
    applyOps(ops, 'הוספת מדיה שנגררה לנגן');
  }
  return media;
}
