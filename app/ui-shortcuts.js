// Frame Studio — app/ui-shortcuts.js (owner: U)
// Global keyboard shortcuts (SPEC §6). Uses KeyboardEvent.code for letters so shortcuts work
// with the Hebrew keyboard layout too. Registered on window in the CAPTURE phase; every handled
// key calls preventDefault() — other modules should skip keydown events with e.defaultPrevented.
import { state, applyOps, undo, redo } from './api.js';
import { h, toast, modal, isTypingTarget, topModal, closeTopModal, store, closeMenu } from './ui-kit.js';
import * as M from './ui-model.js';

let deps = null;
let clipboard = null;

/** run a timeline command (agent L's exported `commands`) when available, else the local fallback */
function tl(name, args = [], fallback = null) {
  const cmds = deps?.getTimeline?.()?.commands;
  if (cmds && typeof cmds[name] === 'function') {
    try { cmds[name](...args); return; } catch (e) { console.warn(`[shortcuts] timeline.${name} נכשל — משתמש בגיבוי`, e); }
  }
  fallback?.();
}

export function installShortcuts(d) {
  deps = d;
  window.addEventListener('keydown', onKey, true);
}

const fps = () => state.project?.settings?.fps || 30;
const tracksById = () => new Map((state.project?.tracks || []).map((t) => [t.id, t]));
const isLockedClip = (c) => !!tracksById().get(c.trackId)?.locked;
function selected() { const p = state.project; return [...state.selection].map((id) => p?.clips?.[id]).filter(Boolean); }

function onKey(e) {
  if (e.defaultPrevented) return;
  const typing = isTypingTarget(e.target) || isTypingTarget(document.activeElement);
  if (e.key === 'Escape') {
    if (closeTopModal()) { e.preventDefault(); return; }
    if (typing) { document.activeElement?.blur?.(); e.preventDefault(); return; }
    if (state.selection.size) { state.set({ selection: new Set() }, { source: 'user' }); e.preventDefault(); }
    return;
  }
  if (typing) return;
  if (topModal()) return;
  if (document.querySelector('.pm-back')) return; // project manager open
  if (!state.project) return;
  const ctrl = e.ctrlKey || e.metaKey; const shift = e.shiftKey; const alt = e.altKey;
  const code = e.code; const key = e.key;
  const V = deps.viewer;
  const handled = () => { e.preventDefault(); e.stopPropagation(); closeMenu(); };

  // ---- transport
  if (code === 'Space' && !ctrl) { handled(); V.togglePlay(); return; }
  if (!ctrl && !alt && code === 'KeyJ') { handled(); V.shuttle(-1); return; }
  if (!ctrl && !alt && code === 'KeyK') { handled(); V.shuttle(0); return; }
  if (!ctrl && !alt && code === 'KeyL') { handled(); V.shuttle(1); return; }
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && alt && !ctrl) { handled(); tl('nudge', [(key === 'ArrowRight' ? 1 : -1) * (shift ? 10 : 1)]); return; }
  if (key === 'ArrowLeft' && !ctrl) { handled(); if (shift) V.stepSeconds(-1); else V.stepFrames(-1); return; }
  if (key === 'ArrowRight' && !ctrl) { handled(); if (shift) V.stepSeconds(1); else V.stepFrames(1); return; }
  if (key === 'ArrowUp' && !ctrl) { handled(); jumpEdit(-1); return; }
  if (key === 'ArrowDown' && !ctrl) { handled(); jumpEdit(1); return; }
  if (key === 'Home') { handled(); V.seek(0); return; }
  if (key === 'End') { handled(); V.seek(M.projectDuration(state.project)); return; }

  // ---- history
  if (ctrl && code === 'KeyZ') { handled(); if (shift) redo(); else undo(); return; }
  if (ctrl && code === 'KeyY') { handled(); redo(); return; }

  // ---- editing
  if ((code === 'KeyS' && !ctrl && !alt && !shift) || (ctrl && code === 'KeyB')) { handled(); tl('split', [], splitAtPlayhead); return; }
  if (key === 'Delete' || key === 'Backspace') { handled(); tl('del', [{ ripple: shift }], () => deleteSelected(shift)); return; }
  if (ctrl && code === 'KeyC') { handled(); tl('copy', [], copySelected); return; }
  if (ctrl && code === 'KeyX') { handled(); tl('cut', [], () => { if (copySelected()) deleteSelected(false, 'גזירה'); }); return; }
  if (ctrl && code === 'KeyV') { handled(); tl('paste', [], paste); return; }
  if (ctrl && code === 'KeyD') { handled(); tl('duplicate', [], duplicateSelected); return; }
  if (ctrl && code === 'KeyA') { handled(); tl('selectAll', [], () => state.set({ selection: new Set(Object.keys(state.project.clips || {})) }, { source: 'user' })); return; }
  if (ctrl && code === 'KeyE') { handled(); deps.openExport(); return; }
  if (ctrl && code === 'KeyO') { handled(); deps.openProjects(); return; }
  if (ctrl && code === 'KeyS') { handled(); toast('הפרויקט נשמר אוטומטית בכל שינוי', { type: 'success', timeout: 1800 }); return; }
  if (ctrl) return;

  // ---- markers & range
  if (code === 'KeyM' && !alt) { handled(); tl('addMarker', [], () => applyOps([{ op: 'addMarker', t: M.snapToFrame(state.playhead, fps()), label: '' }], 'הוספת סמן')); return; }
  if (code === 'KeyI' && !alt) { handled(); setRange('in'); return; }
  if (code === 'KeyO' && !alt) { handled(); setRange('out'); return; }
  if (code === 'KeyX' && alt) { handled(); state.set({ range: { in: null, out: null } }, { source: 'user' }); return; }

  // ---- timeline view & tools
  if (code === 'Equal' || code === 'NumpadAdd' || key === '+') { handled(); tl('zoomIn', [], () => state.set({ zoom: state.zoom * 1.25 }, { source: 'user' })); return; }
  if (code === 'Minus' || code === 'NumpadSubtract' || key === '-') { handled(); tl('zoomOut', [], () => state.set({ zoom: state.zoom / 1.25 }, { source: 'user' })); return; }
  if (code === 'Backslash') { handled(); tl('zoomFit'); return; }
  if (code === 'KeyV') { handled(); state.set({ tool: 'select' }, { source: 'user' }); return; }
  if (code === 'KeyN') { handled(); const v = !state.snapping; state.set({ snapping: v }, { source: 'user' }); return; }
  if (code === 'KeyB' && shift) { handled(); tl('toggleMagnetic'); return; }
  if (code === 'KeyB') { handled(); state.set({ tool: 'blade' }, { source: 'user' }); return; }
  if (code === 'Slash' && shift) { handled(); openShortcutsHelp(); return; }
  if (key === '?') { handled(); openShortcutsHelp(); }
}

// ---------------------------------------------------------------- actions
function jumpEdit(dir) {
  const p = state.project; const t = state.playhead; const eps = 0.5 / fps();
  const pts = new Set([0, M.projectDuration(p)]);
  for (const c of Object.values(p.clips || {})) { pts.add(c.start); pts.add(M.clipEnd(c)); }
  for (const m of p.markers || []) pts.add(m.t);
  const sorted = [...pts].sort((a, b) => a - b);
  const target = dir > 0 ? sorted.find((x) => x > t + eps) : [...sorted].reverse().find((x) => x < t - eps);
  if (target != null) deps.viewer.seek(target);
}

export function splitAtPlayhead() {
  const p = state.project; const t = M.snapToFrame(state.playhead, fps()); const fr = 1 / fps();
  const inside = (c) => c.start + fr <= t && t <= M.clipEnd(c) - fr;
  let targets = selected().filter(inside);
  if (!targets.length && !state.selection.size) targets = Object.values(p.clips || {}).filter((c) => inside(c) && !c.disabled);
  targets = targets.filter((c) => !isLockedClip(c));
  if (!targets.length) { toast('אין קליפ לפיצול במיקום הסמן', { type: 'warn', timeout: 1800 }); return; }
  applyOps(targets.map((c) => ({ op: 'splitClip', id: c.id, at: t })), targets.length > 1 ? `פיצול ${targets.length} קליפים` : 'פיצול קליפ');
}

export function deleteSelected(ripple, label) {
  const clips = selected().filter((c) => !isLockedClip(c));
  if (!clips.length) { if (state.selection.size) toast('הקליפים שנבחרו נמצאים ברצועה נעולה', { type: 'warn' }); return; }
  let ops;
  if (ripple) ops = [...clips].sort((a, b) => b.start - a.start).map((c) => ({ op: 'removeClip', id: c.id, ripple: true }));
  else ops = [{ op: 'removeClips', ids: clips.map((c) => c.id) }];
  state.set({ selection: new Set() }, { source: 'user' });
  const what = clips.length > 1 ? `${clips.length} קליפים` : 'קליפ';
  applyOps(ops, ripple ? `מחיקה וסגירת רווח (${what})` : label ? `${label}: ${what}` : `מחיקת ${what}`);
}

export function copySelected() {
  const clips = selected();
  if (!clips.length) return false;
  clipboard = JSON.parse(JSON.stringify(clips));
  store.set('fs.clipboard', { projectId: state.projectId, clips: clipboard });
  return true;
}

export function paste() {
  let clips = clipboard;
  if (!clips) { const s = store.get('fs.clipboard'); clips = s?.clips || null; }
  if (!clips?.length) { toast('הלוח ריק — העתיקו קליפ קודם (Ctrl+C)', { type: 'warn' }); return; }
  const p = state.project; const tracks = tracksById();
  const minStart = Math.min(...clips.map((c) => c.start));
  const t = M.snapToFrame(state.playhead, fps());
  const ids = [];
  const ops = [];
  for (const c of clips) {
    if (c.mediaId && !p.media?.[c.mediaId]) continue; // media from another project
    const { id: _old, trackId, ...rest } = c;
    const id = M.uid('c_');
    ids.push(id);
    const op = { ...rest, op: 'addClip', id, type: c.type, start: M.snapToFrame(t + (c.start - minStart), fps()), overlap: 'newTrack' };
    if (tracks.has(trackId) && !tracks.get(trackId).locked) op.track = trackId;
    ops.push(op);
  }
  if (!ops.length) { toast('המדיה של הקליפים שהועתקו לא קיימת בפרויקט הזה', { type: 'warn' }); return; }
  applyOps(ops, ops.length > 1 ? `הדבקת ${ops.length} קליפים` : 'הדבקת קליפ').then((r) => {
    const created = (r.results || []).map((x) => x?.id).filter((x) => x && state.project.clips?.[x]);
    state.set({ selection: new Set(created.length ? created : ids.filter((x) => state.project.clips?.[x])) }, { source: 'user' });
  });
}

export function duplicateSelected() {
  const clips = selected().filter((c) => !isLockedClip(c));
  if (!clips.length) return;
  applyOps(clips.map((c) => ({ op: 'duplicateClip', id: c.id })), clips.length > 1 ? `שכפול ${clips.length} קליפים` : 'שכפול קליפ').then((r) => {
    const created = (r.results || []).map((x) => x?.id).filter((x) => x && state.project.clips?.[x]);
    if (created.length) state.set({ selection: new Set(created) }, { source: 'user' });
  });
}

function setRange(which) {
  const t = M.snapToFrame(state.playhead, fps());
  const r = { ...(state.range || { in: null, out: null }) };
  if (which === 'in') { r.in = t; if (r.out != null && r.out <= t) r.out = null; }
  else { r.out = t; if (r.in != null && r.in >= t) r.in = null; if (r.in == null) r.in = 0; }
  state.set({ range: r }, { source: 'user' });
}

// ---------------------------------------------------------------- help overlay
const KEYS = [
  ['ניגון / השהיה', ['רווח']], ['אחורה / עצירה / קדימה (מהירות)', ['J', 'K', 'L']], ['פריים אחורה / קדימה', ['←', '→']],
  ['שנייה אחורה / קדימה', ['Shift', '← →']], ['נקודת עריכה קודמת / הבאה', ['↑', '↓']], ['להתחלה / לסוף', ['Home', 'End']],
  ['פיצול בסמן', ['S']], ['פיצול (חלופה)', ['Ctrl', 'B']], ['מחיקה', ['Delete']], ['מחיקה וסגירת רווח', ['Shift', 'Delete']],
  ['ביטול', ['Ctrl', 'Z']], ['ביצוע מחדש', ['Ctrl', 'Shift', 'Z']], ['העתקה / גזירה / הדבקה', ['Ctrl', 'C / X / V']], ['שכפול', ['Ctrl', 'D']],
  ['בחירת הכל', ['Ctrl', 'A']], ['הוספת סמן', ['M']], ['נקודת כניסה / יציאה', ['I', 'O']], ['ניקוי טווח', ['Alt', 'X']],
  ['הגדלה / הקטנה של ציר הזמן', ['+', '-']], ['התאמת ציר הזמן למסך', ['\\']], ['הזזת קליפ בפריים / 10 פריימים', ['Alt', '← →']], ['כלי חיתוך / בחירה', ['B', 'V']], ['הצמדה', ['N']], ['ייצוא', ['Ctrl', 'E']],
  ['מנהל פרויקטים', ['Ctrl', 'O']], ['ביטול בחירה / סגירה', ['Esc']], ['עריכת טקסט בנגן', ['לחיצה כפולה']], ['קיצורי מקלדת', ['?']],
];
export function openShortcutsHelp() {
  const grid = h('div.keys-grid');
  for (const [label, keys] of KEYS) {
    grid.appendChild(h('div.key-row', h('span', label), h('span.keys', ...keys.map((k) => h('kbd', k)))));
  }
  modal({ title: 'קיצורי מקלדת', width: 720, body: [grid, h('div.hint', 'הקיצורים עובדים גם כשהמקלדת בעברית. בזמן הקלדה בשדה טקסט הקיצורים מושבתים.')], actions: [{ label: 'סגירה', primary: true }] });
}
