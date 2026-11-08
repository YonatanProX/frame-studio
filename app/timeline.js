// Frame Studio — timeline (agent L).  SPEC §6 "timeline.js".
// DOM timeline with transform-positioned clips, canvas-drawn visible portions (thumbnail strips, waveforms,
// caption words, beats), custom scrolling (one rAF pipeline → no header/ruler lag), snapping, magnetic main
// track, trim/ripple, blade, marquee, keyframes, transitions, markers, in/out range, library drag & drop.
// Every edit goes through applyOps(ops, summary) from app/api.js.

import * as API from './api.js';
import { api, applyOps, onEvent, state, on } from './api.js';
import * as U from './tl-util.js';
import * as O from './tl-ops.js';
import { MediaCache, pickLevel } from './tl-media.js';
import * as M from './tl-menu.js';
import { getDragPayload, isFileDrag, endDrag } from './lib-dnd.js';
import { TL_CSS } from './tl-style.js';
import { loadCatalog, catalogSync, transitionById, drawTransitionPreview } from './lib-catalog.js';
import { uploadFiles, mediaFilesOf } from './lib-upload.js';

const { h, icon, clamp, clipEnd } = U;

const RULER_H = 30, HS_H = 12, VS_W = 10, TOP_PAD = 12, BOTTOM_PAD = 56, GAP = 2;
const SNAP_PX = 8, EDGE_PX = 7, DRAG_THRESH = 4, MIN_ZOOM = 1, MAX_ZOOM = 4000;
const ROLE_H = { main: 62, overlay: 44, text: 34, effects: 24, voice: 46, music: 44, sfx: 34 };
const ROLE_COL = { main: '#13b6e4', overlay: '#3e63dd', text: '#8e4ec6', effects: '#6b46c1', voice: '#2fd27a', music: '#3d8bd8', sfx: '#e8902e' };
const D_RENDER = 1, D_LAYOUT = 2, D_VIEW = 4, D_PH = 8, D_SEL = 16;
const LS_KEY = 'frameStudio.timeline';

const S = {
  mounted: false, root: null, els: {}, p: null, pid: null,
  vw: 0, vh: 0, sx: 0, sy: 0, zoom: 80,
  layout: [], byTrack: new Map(), contentH: 0, contentW: 0,
  clipEls: new Map(), laneEls: new Map(), headEls: new Map(),
  preview: new Map(), trackH: new Map(), drag: null, cache: null, dirty: 0, raf: 0,
  magnetic: true, follow: true, clipboard: null, pointer: null, fitDone: new Set(), mediaStatus: new Map(),
  hoverLaneId: null, kfDrag: null, lastSelKey: '',
  // empty tracks are hidden in the view (never deleted); these stay visible anyway: created by the user this session
  keepTracks: new Set(),
};

// ───────────────────────────── helpers ─────────────────────────────

function loadPrefs() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (typeof j.magnetic === 'boolean') S.magnetic = j.magnetic;
    if (typeof j.follow === 'boolean') S.follow = j.follow;
    if (j.clipboard) S.clipboard = j.clipboard;
  } catch { /* storage unavailable */ }
}
function savePrefs() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ magnetic: S.magnetic, follow: S.follow, clipboard: S.clipboard })); } catch { /* ignore */ }
}

const fps = () => U.fpsOf(S.p);
const frame = () => 1 / fps();
const projDur = () => (S.p ? U.projectDuration(S.p) : 0);
const sel = () => (state.selection instanceof Set ? state.selection : new Set(state.selection || []));
const rangeOf = () => state.range || { in: state.inPoint ?? null, out: state.outPoint ?? null };

function invalidate(flags) {
  S.dirty |= flags;
  if (!S.raf) S.raf = requestAnimationFrame(flush);
}

function eff(c) {
  const pv = S.preview.get(c.id);
  return pv ? { ...c, ...pv } : c;
}

function trackH(t) {
  if (S.trackH.has(t.id)) return S.trackH.get(t.id);
  return clamp(t.height || ROLE_H[t.role] || (t.kind === 'audio' ? 48 : 48), 24, 180);
}

function viewRect() { return S.els.view.getBoundingClientRect(); }
function timeAtClient(clientX) { const r = viewRect(); return Math.max(0, (clientX - r.left + S.sx) / S.zoom); }
function contentYAt(clientY) { const r = viewRect(); return clientY - r.top + S.sy; }
const xOf = (t) => t * S.zoom;

function trackAtY(cy) {
  const L = S.layout;
  if (!L.length) return { track: null, zone: 'top' };
  if (cy < L[0].y - 2) return { track: null, zone: 'top' };
  const last = L[L.length - 1];
  if (cy > last.y + last.h + 2) return { track: null, zone: 'bottom' };
  for (const l of L) if (cy >= l.y - GAP / 2 - 1 && cy <= l.y + l.h + GAP / 2 + 1) return { track: l.track, zone: null, l };
  return { track: null, zone: null };
}

function seek(t) {
  state.set({ playhead: Math.max(0, t) }, { source: 'timeline' });
}

function setSelection(ids) {
  const next = new Set(ids);
  const cur = sel();
  if (next.size === cur.size && [...next].every((x) => cur.has(x))) return;
  state.set({ selection: next, activeKeyframe: null }, { source: 'timeline' });
}

async function commit(ops, summary, select) {
  if (!ops || !ops.length) return null;
  const res = applyOps(ops, summary);
  if (select && select.length) {
    // ids are client-chosen, so the optimistic clips and the server clips share them
    const exists = () => select.filter((id) => state.project && state.project.clips && state.project.clips[id]);
    const local = exists();
    if (local.length) setSelection(local);
    res.then(() => { const ok = exists(); if (ok.length) setSelection(ok); }).catch(() => {});
  }
  return res;
}

// ───────────────────────────── mount ─────────────────────────────

export function mount(el) {
  if (S.mounted) { el.appendChild(S.root); return; }
  S.mounted = true;
  U.injectStyle('fs-l-timeline-css', TL_CSS);
  loadPrefs();
  S.cache = new MediaCache(() => invalidate(D_VIEW));
  S.zoom = clamp(state.zoom || 80, MIN_ZOOM, MAX_ZOOM);
  buildDom(el);
  wireEvents();
  loadCatalog().catch(() => {});

  on('project', () => onProject());
  on('selection', () => invalidate(D_SEL | D_VIEW));
  on('playhead', () => onPlayhead());
  on('playing', () => { updateToolbar(); invalidate(D_PH); });
  on('zoom', (z, keys, detail) => { if (!detail || detail.source !== 'timeline') setZoom(z, null, { silent: true }); });
  on('tool', () => { updateToolbar(); S.root.classList.toggle('tool-blade', state.tool === 'blade'); });
  on('snapping', () => updateToolbar());
  on('range', () => invalidate(D_VIEW | D_LAYOUT));
  on('flash', (f) => flashClips(f && f.ids));
  on('activeKeyframe', () => invalidate(D_SEL));
  onEvent('media', (ev) => {
    const m = ev && (ev.media || ev);
    if (!m || !m.id) return;
    const prev = S.mediaStatus.get(m.id);
    if (m.status !== prev) { S.mediaStatus.set(m.id, m.status); if (m.status === 'ready') S.cache.invalidate(m.id); }
    invalidate(D_RENDER);
  });
  // other panels (inspector → project settings → add track) ask to keep a freshly created empty track visible
  window.addEventListener('fs:keep-track', (e) => { const id = e && e.detail && e.detail.id; if (id) { S.keepTracks.add(id); invalidate(D_RENDER | D_LAYOUT | D_VIEW); } });
  onProject();
  S.root.classList.toggle('tool-blade', state.tool === 'blade');
}

function buildDom(host) {
  const root = h('div.fs-tl', { tabindex: '0', 'aria-label': 'ציר זמן' });
  S.root = root;
  const E = S.els;
  // toolbar
  E.bar = h('div.tl-bar');
  const btn = (name, title, fn, opts = {}) => {
    const b = h('button.tl-btn', { title, 'aria-label': title, html: icon(name, 17) + (opts.text ? `<span class="tl-btn-txt">${opts.text}</span>` : '') });
    b.addEventListener('click', (e) => { e.preventDefault(); fn(e); S.root.focus({ preventScroll: true }); });
    return b;
  };
  E.bSelect = btn('cursor', 'כלי בחירה (V)', () => state.set({ tool: 'select' }));
  E.bBlade = btn('blade', 'כלי חיתוך — לחיצה על קליפ חותכת (B)', () => state.set({ tool: state.tool === 'blade' ? 'select' : 'blade' }));
  E.bSplit = btn('scissors', 'פיצול בסמן הניגון (S / Ctrl+B)', () => commands.split());
  E.bDelete = btn('trash', 'מחיקה (Delete) · Shift — מחיקה וסגירת רווח', (e) => commands.del({ ripple: e.shiftKey }));
  E.bDup = btn('duplicate', 'שכפול (Ctrl+D)', () => commands.duplicate());
  E.bMarker = btn('marker', 'הוספת סמן (M)', () => commands.addMarker());
  E.bSnap = btn('magnet', 'הצמדה (N)', () => commands.toggleSnapping());
  E.bMagnetic = btn('link', 'מסלול ראשי מגנטי — ללא רווחים, הזזה דוחפת קליפים', () => commands.toggleMagnetic());
  // the timecode lives in the player; the timeline keeps a detached element so updateTimecode() stays harmless
  E.tc = h('div.tl-tc', { title: 'זמן נוכחי / אורך הסרטון' });
  E.zoomOut = btn('zoomOut', 'הקטנת זום (-)', () => commands.zoomOut());
  E.zoomIn = btn('zoomIn', 'הגדלת זום (+)', () => commands.zoomIn());
  E.zoomFit = btn('fit', 'התאמה לחלון (\\)', () => commands.zoomFit());
  E.zoomSlider = h('input', { type: 'range', min: '0', max: '1000', step: '1', title: 'זום ציר הזמן (Ctrl+גלגלת)' });
  E.zoomSlider.addEventListener('input', () => setZoom(sliderToZoom(+E.zoomSlider.value), null));
  E.bar.append(E.bSelect, E.bBlade, h('div.tl-sep'), E.bSplit, E.bDelete, E.bDup, h('div.tl-sep'), E.bMarker,
    h('div.tl-spacer'), E.bSnap, E.bMagnetic, h('div.tl-sep'),
    h('div.tl-zoom', null, E.zoomOut, E.zoomSlider, E.zoomIn, E.zoomFit));

  // body
  E.body = h('div.tl-body');
  E.corner = h('div.tl-corner');
  const addTrackBtn = h('button.tl-btn.tl-addtrack', { title: 'הוספת רצועה חדשה (וידאו, טקסט, שמע…)', 'aria-label': 'הוספת רצועה', html: icon('plus', 15) + '<span class="tl-btn-txt">הוספת רצועה</span>' });
  addTrackBtn.addEventListener('click', (e) => { const r = addTrackBtn.getBoundingClientRect(); M.showMenu(addTrackMenu(), r.right, r.bottom + 4); e.stopPropagation(); });
  E.corner.append(addTrackBtn);
  E.ruler = h('div.tl-ruler');
  E.rulerCv = h('canvas');
  E.mkLayer = h('div', { style: { position: 'absolute', left: '0', top: '0', height: '30px', willChange: 'transform' } });
  E.ruler.append(E.rulerCv, E.mkLayer);
  E.heads = h('div.tl-heads');
  E.headsIn = h('div.tl-heads-in');
  E.thDrop = h('div.tl-th-drop');
  E.heads.append(E.headsIn, E.thDrop);
  E.view = h('div.tl-view');
  E.content = h('div.tl-content');
  E.lanes = h('div.tl-lanes');
  E.clips = h('div.tl-clips');
  E.over = h('div.tl-over');
  E.content.append(E.lanes, E.clips, E.over);
  E.snap = h('div.tl-snapline');
  E.blade = h('div.tl-bladeline');
  E.marquee = h('div.tl-marquee');
  E.newTrack = h('div.tl-newtrack', { 'data-label': 'רצועה חדשה' });
  E.ghost = h('div.tl-ghost');
  E.insert = h('div.tl-insert');
  E.rangeShade = h('div.tl-range-shade', { style: { display: 'none' } });
  E.endShade = h('div.tl-endshade');
  E.over.append(E.rangeShade, E.endShade, E.snap, E.blade, E.newTrack, E.ghost, E.insert);
  E.view.append(E.content, E.marquee);
  E.fileOver = h('div.tl-fileover', { text: 'שחררו כאן כדי לייבא ולהוסיף לציר הזמן' });
  E.empty = h('div.tl-empty', null, h('b', { text: 'ציר הזמן ריק' }), h('span', { text: 'גררו לכאן מדיה, צלילים, טקסט או אפקטים מהספרייה — או בקשו מ-Claude לבנות את הסרטון' }));
  E.ph = h('div.tl-ph');
  E.phLine = h('div.tl-ph-line');
  E.phHead = h('div.tl-ph-head', { title: 'סמן הניגון — גרירה לגלילה' });
  E.ph.append(E.phLine, E.phHead);
  E.hs = h('div.tl-hs');
  E.hsThumb = h('div.tl-hs-thumb', null, h('div.tl-hs-grip.l', { title: 'גרירה לשינוי זום' }), h('div.tl-hs-grip.r', { title: 'גרירה לשינוי זום' }));
  E.hs.append(E.hsThumb);
  E.vs = h('div.tl-vs');
  E.vsThumb = h('div.tl-vs-thumb');
  E.vs.append(E.vsThumb);
  E.body.append(E.view, E.heads, E.ruler, E.corner, E.empty, E.fileOver, E.ph, E.hs, E.vs, h('div.tl-cornerbr'));
  root.append(E.bar, E.body);
  host.appendChild(root);
  const ro = new ResizeObserver(() => onResize());
  ro.observe(E.body);
  onResize();
  updateToolbar();
}

function onResize() {
  const r = S.els.view.getBoundingClientRect();
  S.vw = Math.max(1, Math.round(r.width));
  S.hw = S.els.view.offsetLeft;
  S.vh = Math.max(1, Math.round(r.height));
  if (S.p && !S.fitDone.has(S.p.id) && S.vw > 50) { S.fitDone.add(S.p.id); fitZoom(); }
  invalidate(D_LAYOUT | D_VIEW | D_PH);
}

// ───────────────────────────── state reactions ─────────────────────────────

function onProject() {
  const p = state.project;
  const pidChanged = (p && p.id) !== S.pid;
  S.p = p;
  if (pidChanged) {
    S.pid = p ? p.id : null;
    S.cache.setProject(S.pid);
    S.preview.clear(); S.trackH.clear();
    S.sx = 0; S.sy = 0;
    if (p && S.vw > 50 && !S.fitDone.has(p.id)) { S.fitDone.add(p.id); fitZoom(); }
  }
  if (S.drag && S.drag.kind !== 'scrub') { S.pendingRender = true; return; }
  invalidate(D_RENDER | D_LAYOUT | D_VIEW | D_SEL | D_PH);
}

function onPlayhead() {
  if (state.playing && S.follow && S.p && !S.drag) {
    const x = state.playhead * S.zoom - S.sx;
    if (x > S.vw * 0.72) S.sx = clampSx(state.playhead * S.zoom - S.vw * 0.72);
    else if (x < 0) S.sx = clampSx(state.playhead * S.zoom - S.vw * 0.1);
    if (S.sx !== S.lastSx) invalidate(D_VIEW);
  }
  invalidate(D_PH);
}

function flashClips(ids) {
  if (!ids || !ids.length) return;
  requestAnimationFrame(() => {
    for (const id of ids) {
      const el = S.clipEls.get(id);
      if (!el) continue;
      el.classList.remove('fs-flash');
      void el.offsetWidth;
      el.classList.add('fs-flash');
      setTimeout(() => el.classList.remove('fs-flash'), 1700);
    }
  });
}

// ───────────────────────────── render pipeline ─────────────────────────────

function flush() {
  S.raf = 0;
  const d = S.dirty;
  S.dirty = 0;
  const t0 = performance.now();
  try {
    if (d & D_RENDER) renderStructure();
    if (d & (D_RENDER | D_SEL)) renderSelection();
    if (d & (D_RENDER | D_LAYOUT)) layoutAll();
    if (d & (D_RENDER | D_LAYOUT | D_VIEW | D_SEL)) updateView();
    if (d & (D_RENDER | D_LAYOUT | D_VIEW | D_PH)) updatePlayhead();
  } catch (e) {
    console.error('[timeline] render failed', e);
  }
  // frame-cost statistics (inspected by tests via _debug().S.stats)
  const ms = performance.now() - t0;
  const st = S.stats || (S.stats = { n: 0, total: 0, max: 0, viewN: 0, viewTotal: 0, viewMax: 0 });
  st.n++; st.total += ms; if (ms > st.max) st.max = ms;
  if (!(d & (D_RENDER | D_LAYOUT))) { st.viewN++; st.viewTotal += ms; if (ms > st.viewMax) st.viewMax = ms; }
}

/** View-only: empty tracks are not drawn (the data keeps them — Claude refers to them by id). Always shown: the main
 *  track, any track with clips, and tracks the user created by hand in this session. */
function trackVisible(t, used) {
  return t.role === 'main' || used.has(t.id) || S.keepTracks.has(t.id);
}
function computeLayout() {
  const L = [];
  let y = TOP_PAD;
  const tracks = (S.p && S.p.tracks) || [];
  const used = new Set(Object.values((S.p && S.p.clips) || {}).map((c) => c.trackId));
  tracks.forEach((t, i) => {
    if (!trackVisible(t, used)) return;
    const hh = trackH(t);
    L.push({ track: t, y, h: hh, index: i, pos: L.length });
    y += hh + GAP;
  });
  S.layout = L;
  S.byTrack = new Map(L.map((l) => [l.track.id, l]));
  S.contentH = y + BOTTOM_PAD;
}

/** y of the insertion line where a (not drawn) track at full index `fullIdx` sits / will appear. */
function slotY(fullIdx) {
  const L = S.layout;
  const nx = L.find((l) => l.index >= fullIdx);
  if (nx) return nx.y - GAP / 2;
  return L.length ? L[L.length - 1].y + L[L.length - 1].h + GAP / 2 : TOP_PAD;
}

function contentWidth() {
  const d = projDur();
  return Math.max((d + Math.max(15, d * 0.3)) * S.zoom, S.vw + 1);
}

function renderStructure() {
  const p = S.p;
  computeLayout();
  const E = S.els;
  E.empty.style.display = p && Object.keys(p.clips || {}).length ? 'none' : 'flex';
  if (!p) {
    for (const el of S.clipEls.values()) el.remove();
    S.clipEls.clear();
    E.lanes.textContent = ''; E.headsIn.textContent = ''; S.laneEls.clear(); S.headEls.clear();
    return;
  }
  // lanes + headers
  const seenT = new Set();
  S.layout.forEach((l, i) => {
    const t = l.track;
    seenT.add(t.id);
    let lane = S.laneEls.get(t.id);
    if (!lane) { lane = h('div.tl-lane', { dataset: { trackId: t.id } }); S.laneEls.set(t.id, lane); E.lanes.appendChild(lane); }
    lane.className = `tl-lane${i % 2 ? ' alt' : ''}${t.role === 'main' ? ' main' : ''}${t.locked ? ' locked' : ''}`;
    lane.style.top = `${l.y}px`;
    lane.style.height = `${l.h}px`;
    let head = S.headEls.get(t.id);
    if (!head) { head = buildHeader(t); S.headEls.set(t.id, head); E.headsIn.appendChild(head); }
    updateHeader(head, t, l, i);
  });
  for (const [id, el] of [...S.laneEls]) if (!seenT.has(id)) { el.remove(); S.laneEls.delete(id); }
  for (const [id, el] of [...S.headEls]) if (!seenT.has(id)) { el.remove(); S.headEls.delete(id); }
  E.headsIn.style.height = `${S.contentH}px`;

  // clips
  const seen = new Set();
  for (const c of Object.values(p.clips || {})) {
    const l = S.byTrack.get(c.trackId);
    if (!l) continue;
    seen.add(c.id);
    let el = S.clipEls.get(c.id);
    if (!el) { el = h('div.tl-clip', { dataset: { clipId: c.id, id: c.id } }); S.clipEls.set(c.id, el); E.clips.appendChild(el); }
    updateClipEl(el, c, l.track);
  }
  for (const [id, el] of [...S.clipEls]) if (!seen.has(id)) { el.remove(); S.clipEls.delete(id); }

  renderTransitions();
  renderMarkers();
}

// ───── clip elements ─────

function clipSig(c, t) {
  const m = U.mediaOf(S.p, c);
  return JSON.stringify([c.type, c.name, U.clipLabel(S.p, c), U.clipTint(c), c.disabled, c.muteAudio, c.speed, c.reverse, (c.effects || []).length,
    c.filter && c.filter.id, c.text && [c.text.content, c.text.color, c.text.font, c.text.weight], c.sticker && c.sticker.value, c.shape && c.shape.kind,
    t.hidden, t.muted, t.locked, t.role, m && [m.status, m.hasAudio, m.kind], c.animIn && c.animIn.id, c.animOut && c.animOut.id]);
}

function audioCapable(c) {
  if (c.type === 'audio') return true;
  if (c.type !== 'video') return false;
  const m = U.mediaOf(S.p, c);
  return !(m && m.hasAudio === false);
}

function updateClipEl(el, c, t) {
  el._clip = c;
  el._track = t;
  const sig = clipSig(c, t);
  if (el._sig !== sig) {
    el._sig = sig;
    const color = U.clipColor(c, t);
    el.style.setProperty('--cc', color);
    const m = U.mediaOf(S.p, c);
    // text / captions: one plain line with the words themselves (word timing is edited in the inspector)
    const label = c.type === 'text' ? ((c.text && c.text.content) || c.name || 'טקסט').replace(/\s+/g, ' ')
      : c.type === 'caption' ? (((c.caption && c.caption.words) || []).map((w) => w.w).join(' ') || c.name || 'כתוביות')
        : U.clipLabel(S.p, c);
    // only two quiet badges: muted, has effects
    let badges = '';
    const muted = (c.type === 'video' && c.muteAudio && (!m || m.hasAudio !== false)) || (c.type === 'audio' && c.volume === 0);
    if (muted) badges += `<span class="tl-clip-badge" title="השמע של הקליפ מושתק">${icon('volumeOff', 11)}</span>`;
    if (c.type !== 'effect' && (c.effects || []).length) badges += `<span class="tl-clip-badge" title="לקליפ יש אפקטים">${icon('effect', 11)}</span>`;
    const tIcon = c.type === 'audio' ? U.roleIcon(t) : U.TYPE_ICONS[c.type];
    let inner = `<canvas class="tl-clip-cv"></canvas><div class="tl-clip-head">${icon(tIcon, 12)}<span class="tl-clip-name" dir="auto">${U.escapeHtml(label)}</span>${badges}</div>`;
    inner += `<div class="tl-trim l" data-edge="start"></div><div class="tl-trim r" data-edge="end"></div>`;
    if (audioCapable(c) && !(c.type === 'video' && c.muteAudio)) inner += `<div class="tl-fadeh" data-fade="in" title="Fade in"></div><div class="tl-fadeh" data-fade="out" title="Fade out"></div>`;
    if (c.type === 'audio') inner += `<div class="tl-vol" title="עוצמה — גרירה למעלה/למטה"></div>`;
    inner += `<div class="tl-kfs"></div>`;
    el.innerHTML = inner;
    el._cv = el.querySelector('.tl-clip-cv');
    el._head = el.querySelector('.tl-clip-head');
    el._kfs = el.querySelector('.tl-kfs');
    el._vol = el.querySelector('.tl-vol');
    el._fin = el.querySelector('.tl-fadeh[data-fade="in"]');
    el._fout = el.querySelector('.tl-fadeh[data-fade="out"]');
    el._trimL = el.querySelector('.tl-trim.l');
    el._trimR = el.querySelector('.tl-trim.r');
    el._headW = 0;
    el._cvKey = '';
    el._kfKey = '';
    const state_ = m && m.status === 'processing' ? ' · המדיה בעיבוד…' : m && m.status === 'error' ? ` · שגיאה במדיה: ${m.error || ''}` : c.mediaId && !m ? ' · המדיה חסרה בפרויקט' : '';
    el.title = `${U.TYPE_LABELS[c.type] || c.type}: ${label}${state_}`;
  }
  el.className = `tl-clip t-${c.type}${c.disabled ? ' disabled' : ''}${t.hidden ? ' hiddentrack' : ''}${t.muted ? ' mutedtrack' : ''}${t.locked ? ' locked' : ''}${state.tool === 'blade' ? ' blade' : ''}${sel().has(c.id) ? ' sel' : ''}`;
}

function renderSelection() {
  const s = sel();
  for (const [id, el] of S.clipEls) el.classList.toggle('sel', s.has(id));
  for (const [id, head] of S.headEls) {
    let any = false;
    for (const cid of s) { const c = S.p && S.p.clips[cid]; if (c && c.trackId === id) { any = true; break; } }
    head.classList.toggle('sel', any);
  }
  // keyframe diamonds on selected clips (≤ 6)
  const show = s.size <= 6 ? s : new Set();
  for (const [id, el] of S.clipEls) {
    if (!el._kfs) continue;
    const c = S.p && S.p.clips[id];
    if (!c || !show.has(id)) { if (el._kfs.firstChild) el._kfs.textContent = ''; el._kfKey = ''; continue; }
    const times = U.keyframeTimes(c);
    const ak = state.activeKeyframe;
    const key = JSON.stringify(times.map((k) => k.t)) + (ak && ak.clipId === id ? ak.t : '');
    if (el._kfKey === key) continue;
    el._kfKey = key;
    el._kfs.textContent = '';
    for (const k of times) {
      const d = h('div.tl-kf', { style: { left: `${k.t * S.zoom}px` }, dataset: { t: String(k.t) }, title: `קיפריים ${U.formatTimecode(c.start + k.t, fps())} · ${k.props.map((x) => x.prop).join(', ')}`, html: icon('keyframe', 12) });
      if (ak && ak.clipId === id && Math.abs(ak.t - k.t) < 1e-3) d.classList.add('active');
      el._kfs.appendChild(d);
    }
  }
}

function layoutAll() {
  if (!S.p) return;
  S.contentW = contentWidth();
  const E = S.els;
  E.content.style.width = `${S.contentW}px`;
  E.content.style.height = `${S.contentH}px`;
  for (const lane of S.laneEls.values()) lane.style.width = `${S.contentW}px`;
  for (const [id, el] of S.clipEls) {
    const c = S.p.clips[id];
    if (c) layoutClip(el, c);
  }
  layoutTransitions();
  layoutMarkers();
  // project end shading
  const endX = projDur() * S.zoom;
  E.endShade.style.left = `${endX}px`;
  E.endShade.style.width = `${Math.max(0, S.contentW - endX)}px`;
  E.endShade.style.height = `${S.contentH}px`;
  const r = rangeOf();
  if (r.in != null || r.out != null) {
    const a = (r.in ?? 0) * S.zoom, b = (r.out ?? projDur()) * S.zoom;
    E.rangeShade.style.display = 'block';
    E.rangeShade.style.left = `${Math.min(a, b)}px`;
    E.rangeShade.style.width = `${Math.abs(b - a)}px`;
    E.rangeShade.style.height = `${S.contentH}px`;
  } else E.rangeShade.style.display = 'none';
  E.snap.style.height = `${S.contentH}px`;
}

function clipY(c, l) {
  const pv = S.preview.get(c.id);
  if (pv && pv.y != null) return pv.y;
  return l.y + 1;
}

function layoutClip(el, c0) {
  const c = eff(c0);
  const l = S.byTrack.get(c0.trackId);
  if (!l) return;
  const x = c.start * S.zoom;
  const w = Math.max(2, c.duration * S.zoom);
  const y = clipY(c0, l);
  const hh = (S.preview.get(c0.id) && S.preview.get(c0.id).h) || l.h - 2;
  if (el._x !== x || el._y !== y) el.style.transform = `translate3d(${x}px,${y}px,0)`;
  if (el._w !== w) el.style.width = `${w}px`;
  if (el._h !== hh) el.style.height = `${hh}px`;
  el._x = x; el._w = w; el._y = y; el._h = hh;
  const narrow = w < 26;
  if (el._head) el._head.style.display = narrow || hh < 16 ? 'none' : '';
  if (el._trimL) { el._trimL.style.width = narrow ? '4px' : `${EDGE_PX + 1}px`; el._trimR.style.width = narrow ? '4px' : `${EDGE_PX + 1}px`; }
  if (el._fin) {
    const fi = (c.fadeIn || 0) * S.zoom, fo = (c.fadeOut || 0) * S.zoom;
    el._fin.style.left = `${clamp(fi, 6, w - 6)}px`;
    el._fout.style.left = `${clamp(w - fo, 6, w - 6)}px`;
    el._fin.style.display = el._fout.style.display = w < 40 || hh < 26 ? 'none' : '';
  }
  if (el._vol) {
    const hasKf = c.keyframes && Array.isArray(c.keyframes.volume) && c.keyframes.volume.length;
    el._vol.style.display = hasKf || hh < 26 ? 'none' : '';
    el._vol.style.top = `${volY(c.volume == null ? 1 : c.volume) * hh}px`;
  }
  if (el._kfs && el._kfs.firstChild) {
    for (const d of el._kfs.children) d.style.left = `${(+d.dataset.t) * S.zoom}px`;
  }
}

function volY(g) {
  const db = U.dbFromGain(g);
  const v = Number.isFinite(db) ? db : -60;
  return clamp((12 - v) / 52, 0.06, 0.96);
}
function gainFromVolY(y) {
  const db = 12 - clamp(y, 0, 1) * 52;
  return db <= -39.5 ? 0 : U.gainFromDb(db);
}

// ───── transitions ─────

function junctions() {
  const out = [];
  if (!S.p) return out;
  for (const t of S.p.tracks) {
    if (t.kind !== 'video') continue;
    const list = U.clipsOnTrack(S.p, t.id);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      const media = (x) => x.type === 'video' || x.type === 'image';
      if (Math.abs(b.start - clipEnd(a)) <= frame() + 1e-4 && media(a) && media(b)) out.push({ a, b, track: t });
    }
  }
  return out;
}

function renderTransitions() {
  const E = S.els;
  for (const el of E.over.querySelectorAll('.tl-tr,.tl-trspan')) el.remove();
  S.trEls = [];
  for (const j of junctions()) {
    const on = j.a.transitionOut && j.a.transitionOut.id && j.a.transitionOut.id !== 'none';
    const tr = on ? transitionById(j.a.transitionOut.id) : null;
    const badge = h('div.tl-tr', { dataset: { a: j.a.id, b: j.b.id }, title: on ? `מעבר: ${tr ? tr.name : j.a.transitionOut.id} (${(+j.a.transitionOut.duration || 0).toFixed(2)} ש׳) — לחיצה לעריכה` : 'הוספת מעבר', html: icon(on ? 'transition' : 'plus', 11, { filled: on }) });
    if (on) badge.classList.add('on');
    const span = on ? h('div.tl-trspan') : null;
    E.over.appendChild(badge);
    if (span) E.over.appendChild(span);
    S.trEls.push({ j, badge, span });
  }
}

function layoutTransitions() {
  for (const { j, badge, span } of S.trEls || []) {
    const l = S.byTrack.get(j.track.id);
    if (!l) continue;
    const a = eff(j.a);
    const cut = clipEnd(a);
    const hide = S.preview.has(j.a.id) || S.preview.has(j.b.id);
    badge.style.display = hide || l.h < 26 ? 'none' : '';
    badge.style.left = `${cut * S.zoom}px`;
    badge.style.top = `${l.y + l.h / 2 - 10}px`;
    if (span) {
      const d = +j.a.transitionOut.duration || 0.5;
      span.style.display = hide ? 'none' : '';
      span.style.left = `${(cut - d / 2) * S.zoom}px`;
      span.style.width = `${Math.max(2, d * S.zoom)}px`;
      span.style.top = `${l.y + 3}px`;
      span.style.height = `${l.h - 6}px`;
    }
  }
}

// ───── markers ─────

function renderMarkers() {
  const E = S.els;
  E.mkLayer.textContent = '';
  for (const el of E.over.querySelectorAll('.tl-mkline,.tl-range-h')) el.remove();
  S.mkEls = [];
  for (const m of (S.p && S.p.markers) || []) {
    // a small coloured tick on the ruler; the label shows only as a tooltip
    const el = h('div.tl-mk', { dataset: { markerId: m.id }, title: `${m.label || 'סמן'} · ${U.formatTimecode(m.t, fps())}` });
    el.style.setProperty('--mc', m.color || '#f5c518');
    el.append(h('div.tl-mk-tick'));
    E.mkLayer.appendChild(el);
    S.mkEls.push({ m, el });
  }
  const r = rangeOf();
  S.rangeHandles = [];
  for (const which of ['in', 'out']) {
    if (r[which] == null) continue;
    const hd = h('div.tl-range-h', { dataset: { range: which }, title: which === 'in' ? 'נקודת כניסה (I) — גרירה' : 'נקודת יציאה (O) — גרירה' });
    E.mkLayer.appendChild(hd);
    S.rangeHandles.push({ which, el: hd });
  }
}

function layoutMarkers() {
  for (const { m, el } of S.mkEls || []) {
    const t = S.markerPreview && S.markerPreview.id === m.id ? S.markerPreview.t : m.t;
    el.style.left = `${t * S.zoom}px`;
  }
  const r = rangeOf();
  for (const { which, el } of S.rangeHandles || []) el.style.left = `${(r[which] || 0) * S.zoom}px`;
}

// ───── view (scroll) ─────

function clampSx(v) { return clamp(v, 0, Math.max(0, S.contentW - S.vw)); }
function clampSy(v) { return clamp(v, 0, Math.max(0, S.contentH - S.vh)); }

function updateView() {
  const E = S.els;
  if (!S.p) { drawRuler(); updateScrollbars(); return; }
  S.contentW = contentWidth();
  S.sx = clampSx(S.sx);
  S.sy = clampSy(S.sy);
  S.lastSx = S.sx;
  E.content.style.transform = `translate3d(${-S.sx}px,${-S.sy}px,0)`;
  E.headsIn.style.transform = `translate3d(0,${-S.sy}px,0)`;
  E.mkLayer.style.transform = `translate3d(${-S.sx}px,0,0)`;
  drawRuler();
  updateScrollbars();
  drawVisibleClips();
  updateTimecode();
}

const FRAME_BUDGET_MS = 6;
/** Label width estimate (no DOM read → no forced layout while scrolling). */
function estimateHeadWidth(el) {
  const name = el._head.querySelector('.tl-clip-name');
  const txt = name ? name.textContent : '';
  return Math.min(el._w, 26 + txt.length * 6.6 + el._head.querySelectorAll('.tl-clip-badge').length * 28);
}
function drawVisibleClips() {
  const v0 = S.sx - 120, v1 = S.sx + S.vw + 120;
  const y0 = S.sy - 40, y1 = S.sy + S.vh + 40;
  const t0 = performance.now();
  // while the zoom is changing, existing canvases are stretched (GPU) and redrawn once it settles;
  // otherwise canvases are redrawn within a per-frame budget and the rest continue on the next frame.
  const zooming = t0 - (S.zoomAt || 0) < 140;
  let pending = false;
  for (const [id, el] of S.clipEls) {
    const c0 = S.p.clips[id];
    if (!c0) continue;
    const x = el._x, w = el._w;
    const vis = x + w > v0 && x < v1 && el._y + el._h > y0 && el._y < y1;
    if (!vis) { if (el._cv && el._cv.style.display !== 'none') { el._cv.style.display = 'none'; el._cvKey = ''; } continue; }
    // sticky label
    if (el._head && el._head.style.display !== 'none') {
      if (!el._headW) el._headW = estimateHeadWidth(el);
      const off = clamp(S.sx - x, 0, Math.max(0, w - el._headW - 4));
      el._head.style.transform = off ? `translate3d(${off}px,0,0)` : '';
    }
    const defer = zooming || performance.now() - t0 > FRAME_BUDGET_MS;
    if (drawClipCanvas(el, eff(c0), c0, defer) === 'deferred') pending = true;
  }
  if (pending) {
    clearTimeout(S.settleT);
    if (zooming) S.settleT = setTimeout(() => invalidate(D_VIEW), 150);
    else invalidate(D_VIEW);
  }
}

// ───────────────────────────── clip canvas drawing ─────────────────────────────

function srcTime(c, lt) {
  const sp = c.speed || 1;
  const d = c.duration;
  return c.reverse ? (c.in || 0) + (d - lt) * sp : (c.in || 0) + lt * sp;
}

/** Draw the visible part of a clip into its canvas. Returns "same" | "deferred" | "drawn" | "none". */
function drawClipCanvas(el, c, c0, allowDefer = false) {
  const cv = el._cv;
  if (!cv) return 'none';
  const type = c.type;
  if (!['video', 'image', 'audio', 'effect', 'adjustment'].includes(type)) { cv.style.display = 'none'; return 'none'; }
  const x0 = el._x, w = el._w, hh = el._h;
  const a = Math.max(x0, S.sx - 120), b = Math.min(x0 + w, S.sx + S.vw + 120);
  if (b <= a) { cv.style.display = 'none'; return 'none'; }
  const lx0 = a - x0, lx1 = b - x0;
  const cw = Math.ceil(lx1 - lx0), ch = Math.max(1, Math.round(hh));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const m = U.mediaOf(S.p, c);
  const pk = m && audioCapable(c) ? S.cache.peaksFor(m) : null;
  const key = `${m ? S.cache.mediaRev(m.id) : 0}|${Math.round(lx0)}|${cw}|${ch}|${S.zoom}|${c.start}|${c.duration}|${c.in}|${c.speed}|${c.reverse}|${c.volume}|${c.fadeIn}|${c.fadeOut}|${c.muteAudio}|${m ? m.status : ''}|${pk ? 1 : 0}|${el._track && el._track.role}`;
  if (el._cvKey === key && cv.style.display !== 'none') return 'same';
  const info = el._cvInfo;
  if (allowDefer) {
    if (info && cv.style.display !== 'none' && info.ch === ch) {
      // keep the old pixels, stretched to the new zoom, until there is time to redraw
      const k = S.zoom / info.zoom;
      cv.style.left = `${info.lx0 * k}px`;
      cv.style.width = `${info.cw * k}px`;
    }
    // never drawn yet: the clip shows its plain color for a frame or two
    return 'deferred';
  }
  el._cvKey = key;
  cv.style.display = '';
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  }
  cv.style.width = `${cw}px`; cv.style.height = `${ch}px`;
  cv.style.left = `${lx0}px`;
  el._cvInfo = { lx0, cw, ch, zoom: S.zoom };
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(-lx0, 0);
  const color = U.clipColor(c, el._track);
  if (type === 'video' || type === 'image') {
    const hasWave = type === 'video' && audioCapable(c) && !c.muteAudio && ch >= 46;
    const thumbH = hasWave ? Math.round(ch * 0.68) : ch;
    drawThumbs(ctx, c, m, lx0, lx1, 0, thumbH, color);
    if (hasWave) {
      ctx.fillStyle = 'rgba(8,24,30,.88)';
      ctx.fillRect(lx0, thumbH, lx1 - lx0, ch - thumbH);
      drawWave(ctx, c, m, pk, lx0, lx1, thumbH + 1, ch - thumbH - 2, 'rgba(110,210,235,.85)');
      drawFades(ctx, c, thumbH, ch - thumbH, lx0, lx1);
    }
  } else if (type === 'audio') {
    const top = ch >= 30 ? 16 : 0;
    drawWave(ctx, c, m, pk, lx0, lx1, top, ch - top - 1, waveColor(el._track));
    drawFades(ctx, c, 0, ch, lx0, lx1);
    if (c.keyframes && Array.isArray(c.keyframes.volume) && c.keyframes.volume.length) drawVolumeKeys(ctx, c, ch, lx0, lx1);
    if (el._track && el._track.role === 'music' && m) drawBeats(ctx, c, m, lx0, lx1);
  } else {
    // effect / adjustment: diagonal stripes
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 6;
    const start = Math.floor(lx0 / 16) * 16 - ch;
    ctx.beginPath();
    for (let x = start; x < lx1 + ch; x += 16) { ctx.moveTo(x, ch); ctx.lineTo(x + ch, 0); }
    ctx.stroke();
  }
  ctx.restore();
  return 'drawn';
}

function waveColor(t) {
  const r = t && t.role;
  return r === 'voice' ? 'rgba(150,240,190,.95)' : r === 'music' ? 'rgba(160,205,255,.95)' : r === 'sfx' ? 'rgba(255,214,160,.95)' : 'rgba(200,240,215,.95)';
}

function drawThumbs(ctx, c, m, lx0, lx1, top, th, color) {
  ctx.fillStyle = U.shade(color, -0.35);
  ctx.fillRect(lx0, top, lx1 - lx0, th);
  if (!m) {
    ctx.fillStyle = 'rgba(255,92,99,.25)';
    ctx.fillRect(lx0, top, lx1 - lx0, th);
    return;
  }
  if (m.status === 'processing' && m.kind !== 'image') {
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 8;
    ctx.beginPath();
    for (let x = Math.floor(lx0 / 20) * 20 - th; x < lx1 + th; x += 20) { ctx.moveTo(x, top + th); ctx.lineTo(x + th, top); }
    ctx.stroke();
    return;
  }
  const aspect = m.width && m.height ? m.width / m.height : 16 / 9;
  const tw = clamp(Math.round(th * aspect), 18, 260);
  const i0 = Math.floor(lx0 / tw), i1 = Math.ceil(lx1 / tw);
  const maxLt = c.duration;
  for (let i = i0; i < i1; i++) {
    const tx = i * tw;
    const lt = clamp((tx + tw / 2) / S.zoom, 0, maxLt);
    const st = m.kind === 'image' ? 0 : srcTime(c, lt);
    const img = S.cache.thumb(m, st) || (m.kind === 'image' ? null : S.cache.nearestThumb(m, st));
    if (img && img.naturalWidth) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const s = Math.max(tw / iw, th / ih);
      const dw = iw * s, dh = ih * s;
      ctx.save();
      ctx.beginPath(); ctx.rect(tx, top, tw, th); ctx.clip();
      ctx.drawImage(img, tx + (tw - dw) / 2, top + (th - dh) / 2, dw, dh);
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.fillRect(tx + tw - 1, top, 1, th);
  }
}

function drawWave(ctx, c, m, pk, lx0, lx1, top, wh, col) {
  const mid = top + wh / 2;
  if (!pk || !m) {
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(lx0, mid - 0.5, lx1 - lx0, 1);
    return;
  }
  const rate = pk.rate || 100;
  const sp = c.speed || 1;
  const peaksPerPx = (rate * sp) / S.zoom;
  const lvl = pickLevel(pk, peaksPerPx);
  const data = lvl.data, f = lvl.factor;
  // normalized display (like Premiere's normalized waveform), gently scaled by the clip volume
  if (pk.max == null) { let mx = 0; for (let i = 0; i < pk.data.length; i++) if (pk.data[i] > mx) mx = pk.data[i]; pk.max = mx; }
  const vol = c.volume == null ? 1 : c.volume;
  const gain = (Math.sqrt(Math.max(0.05, Math.min(4, vol))) / Math.max(0.05, pk.max)) * (c.muteAudio ? 0.3 : 1);
  const half = wh / 2;
  const xs0 = Math.floor(lx0), xs1 = Math.ceil(lx1);
  const amps = new Float32Array(xs1 - xs0 + 1);
  for (let px = xs0; px <= xs1; px++) {
    let s0 = srcTime(c, px / S.zoom), s1 = srcTime(c, (px + 1) / S.zoom);
    if (s0 > s1) { const t = s0; s0 = s1; s1 = t; }
    let i0 = Math.floor((s0 * rate) / f), i1 = Math.max(i0 + 1, Math.ceil((s1 * rate) / f));
    if (i0 < 0) i0 = 0;
    if (i1 > data.length) i1 = data.length;
    let mx = 0;
    for (let i = i0; i < i1; i++) if (data[i] > mx) mx = data[i];
    amps[px - xs0] = Math.min(1, Math.pow(mx * gain, 0.85) * 0.92);
  }
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(xs0, mid);
  for (let px = xs0; px <= xs1; px++) ctx.lineTo(px, mid - Math.max(0.5, amps[px - xs0] * half));
  for (let px = xs1; px >= xs0; px--) ctx.lineTo(px, mid + Math.max(0.5, amps[px - xs0] * half));
  ctx.closePath();
  ctx.fill();
}

function drawFades(ctx, c, top, fh, lx0, lx1) {
  const fi = (c.fadeIn || 0) * S.zoom, fo = (c.fadeOut || 0) * S.zoom, w = c.duration * S.zoom;
  ctx.save();
  if (fi > 0.5 && lx0 < fi) {
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(fi, top); ctx.lineTo(0, top + fh); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, top + fh); ctx.lineTo(fi, top); ctx.stroke();
  }
  if (fo > 0.5 && lx1 > w - fo) {
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    ctx.beginPath(); ctx.moveTo(w, top); ctx.lineTo(w - fo, top); ctx.lineTo(w, top + fh); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w, top + fh); ctx.lineTo(w - fo, top); ctx.stroke();
  }
  ctx.restore();
}

function drawVolumeKeys(ctx, c, ch, lx0, lx1) {
  const ks = [...c.keyframes.volume].sort((a, b) => a.t - b.t);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,236,150,.95)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  const yAt = (v) => volY(v) * ch;
  ctx.moveTo(lx0, yAt(ks[0].v));
  ctx.lineTo(ks[0].t * S.zoom, yAt(ks[0].v));
  for (const k of ks) ctx.lineTo(k.t * S.zoom, yAt(k.v));
  ctx.lineTo(Math.max(lx1, ks[ks.length - 1].t * S.zoom), yAt(ks[ks.length - 1].v));
  ctx.stroke();
  ctx.fillStyle = '#f5c518';
  for (const k of ks) { const x = k.t * S.zoom, y = yAt(k.v); ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.fill(); }
  ctx.restore();
}

function drawBeats(ctx, c, m, lx0, lx1) {
  const beats = S.cache.beatsFor(m);
  if (!beats || !beats.length) return;
  const sp = c.speed || 1, inP = c.in || 0;
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  for (const b of beats) {
    const lt = c.reverse ? c.duration - (b - inP) / sp : (b - inP) / sp;
    if (lt < 0 || lt > c.duration) continue;
    const x = lt * S.zoom;
    if (x < lx0 - 4 || x > lx1 + 4) continue;
    ctx.beginPath(); ctx.arc(x, 4, 1.8, 0, Math.PI * 2); ctx.fill();
  }
}

// ───────────────────────────── ruler ─────────────────────────────

function tickSteps() {
  const f = fps();
  const cands = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  let major = cands.find((s) => s * S.zoom >= 84) || 3600;
  let minor = major;
  const majorFrames = Math.round(major * f);
  for (const n of [10, 5, 4, 2]) {
    const m = major / n;
    if (m * S.zoom < 7) continue;
    if (major < 1 && majorFrames % n !== 0) continue;
    minor = m;
    break;
  }
  return { major, minor };
}

function drawRuler() {
  const cv = S.els.rulerCv;
  const w = S.vw, hh = RULER_H;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${hh}px`;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#15181d';
  ctx.fillRect(0, 0, w, hh);
  if (!S.p) return;
  // after-end shading
  const endX = projDur() * S.zoom - S.sx;
  if (endX < w) { ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(Math.max(0, endX), 0, w - Math.max(0, endX), hh); }
  // range
  const r = rangeOf();
  if (r.in != null || r.out != null) {
    const a = (r.in ?? 0) * S.zoom - S.sx, b = (r.out ?? projDur()) * S.zoom - S.sx;
    ctx.fillStyle = 'rgba(19,182,228,.22)';
    ctx.fillRect(Math.min(a, b), 15, Math.abs(b - a), hh - 15);
  }
  const { major, minor } = tickSteps();
  const t0 = S.sx / S.zoom, t1 = (S.sx + w) / S.zoom;
  ctx.strokeStyle = '#3a414b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const n0 = Math.floor(t0 / minor), n1 = Math.ceil(t1 / minor);
  const ratio = Math.round(major / minor);
  for (let n = n0; n <= n1; n++) {
    if (n % ratio === 0) continue;
    const x = Math.round(n * minor * S.zoom - S.sx) + 0.5;
    ctx.moveTo(x, hh - 5); ctx.lineTo(x, hh);
  }
  ctx.stroke();
  ctx.strokeStyle = '#6a727d';
  ctx.beginPath();
  ctx.fillStyle = '#9aa1ab';
  ctx.font = '10.5px "Cascadia Mono", Consolas, monospace';
  ctx.textBaseline = 'top';
  const withFrames = major < 1;
  const m0 = Math.floor(t0 / major), m1 = Math.ceil(t1 / major);
  for (let n = m0; n <= m1; n++) {
    const t = n * major;
    const x = Math.round(t * S.zoom - S.sx) + 0.5;
    ctx.moveTo(x, hh - 11); ctx.lineTo(x, hh);
    ctx.fillText(U.rulerLabel(t, fps(), withFrames), x + 4, 4);
  }
  ctx.stroke();
}

function updateScrollbars() {
  const E = S.els;
  const cw = Math.max(S.contentW, S.vw + 1);
  const tw = Math.max(24, (S.vw / cw) * S.vw);
  const tx = (S.sx / Math.max(1, cw - S.vw)) * (S.vw - tw);
  E.hsThumb.style.width = `${tw}px`;
  E.hsThumb.style.transform = `translate3d(${isFinite(tx) ? tx : 0}px,0,0)`;
  const ch = Math.max(S.contentH, S.vh);
  const need = S.contentH > S.vh + 1;
  E.vsThumb.style.display = need ? '' : 'none';
  if (need) {
    const th = Math.max(20, (S.vh / ch) * S.vh);
    const ty = (S.sy / Math.max(1, ch - S.vh)) * (S.vh - th);
    E.vsThumb.style.height = `${th}px`;
    E.vsThumb.style.transform = `translate3d(0,${ty}px,0)`;
  }
  // zoom slider
  E.zoomSlider.value = String(zoomToSlider(S.zoom));
  E.zoomSlider.style.setProperty('--p', `${zoomToSlider(S.zoom) / 10}%`);
}

function updatePlayhead() {
  const x = state.playhead * S.zoom - S.sx;
  const E = S.els;
  const hw = S.hw != null ? S.hw : (S.hw = E.view.offsetLeft);
  const visible = x >= -8 && x <= S.vw + 8;
  E.ph.style.display = visible && S.p ? '' : 'none';
  E.ph.style.transform = `translate3d(${hw + x}px,0,0)`;
  updateTimecode();
}

function updateTimecode() {
  const f = fps();
  S.els.tc.innerHTML = `${U.formatTimecode(state.playhead || 0, f)} <span>/ ${U.formatTimecode(S.p ? projDur() : 0, f)}</span>`;
}

function updateToolbar() {
  const E = S.els;
  if (!E.bSelect) return;
  E.bSelect.classList.toggle('on', state.tool !== 'blade');
  E.bBlade.classList.toggle('on', state.tool === 'blade');
  E.bSnap.classList.toggle('on', !!state.snapping);
  E.bMagnetic.classList.toggle('on', S.magnetic);
  E.bSnap.title = `הצמדה ${state.snapping ? 'פעילה' : 'כבויה'} (N)`;
  E.bMagnetic.title = `מסלול ראשי מגנטי ${S.magnetic ? 'פעיל' : 'כבוי'} — ללא רווחים, הזזה דוחפת קליפים`;
  for (const [id, head] of S.headEls) { const t = S.p && U.trackById(S.p, id); if (t) updateHeader(head, t, S.byTrack.get(id), S.layout.indexOf(S.byTrack.get(id))); }
}

// ───────────────────────────── zoom ─────────────────────────────

function fitZoomValue() {
  const d = Math.max(projDur(), 3);
  return clamp((S.vw - 40) / d, MIN_ZOOM, MAX_ZOOM);
}
function minZoom() { return Math.max(MIN_ZOOM, Math.min(fitZoomValue() * 0.5, 20)); }
function zoomToSlider(z) { const a = Math.log(minZoom()), b = Math.log(MAX_ZOOM); return Math.round(((Math.log(clamp(z, minZoom(), MAX_ZOOM)) - a) / (b - a)) * 1000); }
function sliderToZoom(v) { const a = Math.log(minZoom()), b = Math.log(MAX_ZOOM); return Math.exp(a + (v / 1000) * (b - a)); }

/** anchorClientX: keep the time under that x fixed (null → playhead if visible, else view center). */
function setZoom(z, anchorClientX, { silent = false } = {}) {
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  if (!isFinite(z) || Math.abs(z - S.zoom) < 1e-6) return;
  let ax, at;
  if (anchorClientX != null) { ax = anchorClientX - viewRect().left; at = (ax + S.sx) / S.zoom; }
  else {
    const px = state.playhead * S.zoom - S.sx;
    if (px >= 0 && px <= S.vw) { ax = px; at = state.playhead; }
    else { ax = S.vw / 2; at = (ax + S.sx) / S.zoom; }
  }
  S.zoom = z;
  S.zoomAt = performance.now();
  S.contentW = contentWidth();
  S.sx = clampSx(at * z - ax);
  if (!silent) state.set({ zoom: z }, { source: 'timeline' });
  invalidate(D_LAYOUT | D_VIEW | D_PH);
}
function fitZoom() {
  const z = fitZoomValue();
  S.zoom = z;
  S.sx = 0;
  state.set({ zoom: z }, { source: 'timeline' });
  invalidate(D_LAYOUT | D_VIEW | D_PH);
}

// ───────────────────────────── snapping ─────────────────────────────

function snapPoints(excludeIds = new Set(), { keyframesOf = null } = {}) {
  const pts = [{ t: 0, kind: 'start' }];
  if (!S.p) return pts;
  pts.push({ t: state.playhead, kind: 'playhead' });
  for (const c of Object.values(S.p.clips)) {
    if (excludeIds.has(c.id)) continue;
    pts.push({ t: c.start, kind: 'edge' }, { t: clipEnd(c), kind: 'edge' });
    if (c.type === 'audio') {
      const t = U.trackById(S.p, c.trackId);
      const m = U.mediaOf(S.p, c);
      if (t && t.role === 'music' && m) {
        const beats = S.cache.beatsFor(m) || [];
        for (const b of beats) {
          const lt = (b - (c.in || 0)) / (c.speed || 1);
          if (lt >= 0 && lt <= c.duration) pts.push({ t: c.start + lt, kind: 'beat' });
        }
      }
    }
  }
  for (const m of S.p.markers || []) pts.push({ t: m.t, kind: 'marker' });
  const r = rangeOf();
  if (r.in != null) pts.push({ t: r.in, kind: 'range' });
  if (r.out != null) pts.push({ t: r.out, kind: 'range' });
  const kc = keyframesOf || [...sel()].filter((id) => !excludeIds.has(id)).map((id) => S.p.clips[id]).filter(Boolean);
  for (const c of kc) for (const k of U.keyframeTimes(c)) pts.push({ t: c.start + k.t, kind: 'keyframe' });
  return pts;
}

/** Best snap for any of the candidate times. Returns {delta, at} or null. */
function bestSnap(cands, pts, px = SNAP_PX) {
  if (!state.snapping) return null;
  const th = px / S.zoom;
  let best = null;
  for (const c of cands) for (const p of pts) {
    const d = p.t - c;
    if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: p.t, kind: p.kind };
  }
  return best;
}

function showSnap(at) {
  const E = S.els;
  if (at == null) { E.snap.style.display = 'none'; return; }
  E.snap.style.display = 'block';
  E.snap.style.left = `${at * S.zoom}px`;
  E.snap.style.top = '0px';
  E.snap.style.height = `${S.contentH}px`;
}

// ───────────────────────────── pointer drags ─────────────────────────────

function startDrag(e, d) {
  S.drag = d;
  S.pointer = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  d.moved = false;
  d.x0 = e.clientX; d.y0 = e.clientY;
  try { (d.captureEl || S.els.view).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const move = (ev) => {
    S.pointer = { x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey || ev.metaKey };
    if (!d.moved && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < (d.threshold ?? DRAG_THRESH)) return;
    if (!d.moved) { d.moved = true; if (d.begin) d.begin(ev); }
    d.move && d.move(ev);
    ensureAutoScroll();
  };
  const up = (ev) => {
    cleanup();
    if (d.moved) d.up && d.up(ev); else d.click && d.click(ev);
    finishDrag();
  };
  const key = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cleanup(); d.cancel && d.cancel(); finishDrag(true); }
    else if (ev.key === 'Shift' || ev.key === 'Alt') { S.pointer.shift = ev.shiftKey; S.pointer.alt = ev.altKey; if (d.moved && d.move) d.move({ clientX: S.pointer.x, clientY: S.pointer.y, shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey }); }
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('keyup', key, true);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', key, true);
}

function finishDrag() {
  S.drag = null;
  M.hideTip();
  showSnap(null);
  const E = S.els;
  E.newTrack.style.display = 'none';
  E.marquee.style.display = 'none';
  E.insert.style.display = 'none';
  clearDupGhosts();
  for (const el of S.clipEls.values()) el.classList.remove('dragging', 'anim');
  if (S.preview.size) S.preview.clear();
  S.markerPreview = null;
  invalidate(D_RENDER | D_LAYOUT | D_VIEW | D_PH | D_SEL);
  S.pendingRender = false;
}

let autoRaf = 0;
function ensureAutoScroll() {
  if (autoRaf) return;
  const tick = () => {
    autoRaf = 0;
    const d = S.drag;
    if (!d || !d.moved || !d.autoScroll || !S.pointer) return;
    const r = viewRect();
    const x = S.pointer.x, y = S.pointer.y;
    let dx = 0, dy = 0;
    const edge = 36;
    if (x < r.left + edge) dx = -Math.min(40, (r.left + edge - x) * 0.6 + 2);
    else if (x > r.right - edge) dx = Math.min(40, (x - (r.right - edge)) * 0.6 + 2);
    if (d.autoScroll === 'xy') {
      if (y < r.top + 20) dy = -Math.min(24, (r.top + 20 - y) * 0.5 + 2);
      else if (y > r.bottom - 20) dy = Math.min(24, (y - (r.bottom - 20)) * 0.5 + 2);
    }
    if (dx || dy) {
      const ox = S.sx, oy = S.sy;
      if (dx) { S.contentW = Math.max(S.contentW, S.sx + S.vw + dx + 200); S.sx = clamp(S.sx + dx, 0, Math.max(0, S.contentW - S.vw)); }
      if (dy) S.sy = clampSy(S.sy + dy);
      if (S.sx !== ox || S.sy !== oy) {
        S.els.content.style.width = `${S.contentW}px`;
        invalidate(D_VIEW | D_PH);
        d.move && d.move({ clientX: x, clientY: y, shiftKey: S.pointer.shift, altKey: S.pointer.alt, ctrlKey: S.pointer.ctrl });
      }
      autoRaf = requestAnimationFrame(tick);
    }
  };
  autoRaf = requestAnimationFrame(tick);
}

// ───── lanes pointerdown dispatcher ─────

function onViewPointerDown(e) {
  if (e.button === 1) { startPan(e); return; }
  if (e.button !== 0) return;
  S.root.focus({ preventScroll: true });
  M.closeMenus();
  const t = e.target;
  const tr = t.closest('.tl-tr');
  if (tr) { e.preventDefault(); onTransitionBadge(tr, e); return; }
  const kf = t.closest('.tl-kf');
  const clipEl = t.closest('.tl-clip');
  if (kf && clipEl) { e.preventDefault(); startKeyframeDrag(e, clipEl, kf); return; }
  if (clipEl) {
    const c = S.p.clips[clipEl.dataset.clipId];
    if (!c) return;
    const tk = U.trackById(S.p, c.trackId);
    e.preventDefault();
    if (state.tool === 'blade') { bladeClick(e, c); return; }
    if (tk && tk.locked) { M.toast('הרצועה נעולה — בטלו את הנעילה כדי לערוך', 'warn'); return; }
    const trim = t.closest('.tl-trim');
    if (trim) { selectOnDown(c, e, true); startTrim(e, c, trim.dataset.edge); return; }
    const fade = t.closest('.tl-fadeh');
    if (fade) { selectOnDown(c, e, true); startFade(e, c, fade.dataset.fade, clipEl); return; }
    const vol = t.closest('.tl-vol');
    if (vol) { selectOnDown(c, e, true); startVolume(e, c, clipEl); return; }
    // edge zones even without hitting the handle element (narrow clips)
    const r = clipEl.getBoundingClientRect();
    if (r.width > 18 && e.clientX - r.left <= 4) { selectOnDown(c, e, true); startTrim(e, c, 'start'); return; }
    if (r.width > 18 && r.right - e.clientX <= 4) { selectOnDown(c, e, true); startTrim(e, c, 'end'); return; }
    selectOnDown(c, e, false);
    startMove(e, c);
    return;
  }
  // empty area
  e.preventDefault();
  if (state.tool === 'blade') return;
  startMarquee(e);
}

function selectOnDown(c, e, force) {
  const s = new Set(sel());
  if (e.ctrlKey || e.metaKey) { if (s.has(c.id)) s.delete(c.id); else s.add(c.id); setSelection(s); return; }
  if (e.shiftKey && !force) { s.add(c.id); setSelection(s); return; }
  if (!s.has(c.id) || force) setSelection([c.id]);
}

// ───── move ─────

function startMove(e, c) {
  const p = S.p;
  const s = sel();
  if (e.ctrlKey || e.metaKey) {
    if (!s.has(c.id)) return; // toggled off
  }
  const ids = (s.has(c.id) ? [...s] : [c.id]).filter((id) => {
    const cc = p.clips[id];
    const tk = cc && U.trackById(p, cc.trackId);
    return cc && !(tk && tk.locked);
  });
  const t0 = timeAtClient(e.clientX);
  const minStart = Math.min(...ids.map((id) => p.clips[id].start));
  const maxEnd = Math.max(...ids.map((id) => clipEnd(p.clips[id])));
  const pts = snapPoints(new Set(ids));
  const d = {
    kind: 'move', autoScroll: 'xy', plan: null, dup: false,
    begin() {
      for (const id of ids) { const el = S.clipEls.get(id); if (el) el.classList.add('dragging'); }
    },
    move(ev) {
      const t = timeAtClient(ev.clientX);
      let dt = t - t0;
      if (dt < -minStart) dt = -minStart;
      const sn = bestSnap([minStart + dt, maxEnd + dt, c.start + dt, clipEnd(c) + dt], pts);
      if (sn) dt += sn.delta; else dt = Math.round(dt * fps()) / fps();
      if (dt < -minStart) dt = -minStart;
      showSnap(sn ? sn.at : null);
      const cy = contentYAt(ev.clientY);
      const at = trackAtY(cy);
      d.dup = !!ev.altKey;
      const plan = O.planMove(p, { ids, primaryId: c.id, dt, targetTrackId: at.track ? at.track.id : null, zone: at.zone, magnetic: S.magnetic, duplicate: d.dup, pointerT: t });
      d.plan = plan;
      previewMove(plan, ids, d.dup);
      const tk = plan.newTracks.length ? 'רצועה חדשה' : (() => { const mv = plan.moves.find((m) => m.id === c.id); const tt = mv && U.trackById(p, mv.trackId); return tt ? U.trackLabel(tt) : ''; })();
      const mv = plan.moves.find((m) => m.id === c.id);
      const delta = mv ? mv.start - c.start : dt;
      M.showTip(`${U.formatTimecode(mv ? mv.start : c.start + dt, fps())}  ${delta >= 0 ? '+' : '−'}${U.formatTimecode(Math.abs(delta), fps())}${tk ? '  ·  ' : ''}${tk}${d.dup ? '  ·  שכפול' : ''}`, ev.clientX, ev.clientY);
    },
    up() {
      const plan = d.plan;
      if (!plan) return;
      const ops = O.moveOps(p, plan, { duplicate: d.dup });
      if (!ops.length) return;
      const n = ids.length;
      const summary = d.dup ? (n > 1 ? `שכפול ${n} קליפים` : 'שכפול קליפ') : (n > 1 ? `הזזת ${n} קליפים` : `הזזת "${U.clipLabel(p, c)}"`) + (plan.newTracks.length ? ' לרצועה חדשה' : '');
      commit(ops, summary);
    },
    click(ev) {
      // plain click on a multi-selection collapses it
      if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey) && sel().size > 1) setSelection([c.id]);
    },
    cancel() {},
  };
  startDrag(e, d);
}

function clearDupGhosts() {
  for (const g of S.dupGhosts || []) g.remove();
  S.dupGhosts = [];
}

function previewMove(plan, ids, dup) {
  const prevIds = new Set(S.preview.keys());
  S.preview.clear();
  clearDupGhosts();
  const E = S.els;
  let ntY = null;
  const hiddenTarget = plan.moves.map((m) => m.trackId).find((id) => !S.byTrack.has(id) && U.trackById(S.p, id));
  if (plan.newTracks.length || hiddenTarget) {
    ntY = plan.newTracks.length ? slotY(plan.newTracks[0].index) : slotY(U.trackIndex(S.p, hiddenTarget));
    E.newTrack.dataset.label = plan.newTracks.length ? 'רצועה חדשה' : U.trackLabel(U.trackById(S.p, hiddenTarget));
    E.newTrack.style.display = 'block';
    E.newTrack.style.top = `${ntY}px`;
    E.newTrack.style.width = `${S.contentW}px`;
  } else E.newTrack.style.display = 'none';
  const ntIds = new Set(plan.newTracks.map((t) => t.id));
  for (const m of plan.moves) {
    const c = S.p.clips[m.id];
    let y;
    let hh;
    if (ntIds.has(m.trackId) || !S.byTrack.has(m.trackId)) { const l = S.byTrack.get(c.trackId); hh = Math.max(24, (l ? l.h : 44) - 2); y = ntY - hh / 2; }
    else { const l = S.byTrack.get(m.trackId); y = l ? l.y + 1 : 0; hh = l ? l.h - 2 : 40; }
    if (dup) {
      const g = h('div.tl-ghost', { text: U.clipLabel(S.p, c), style: { display: 'block', left: `${m.start * S.zoom}px`, top: `${y}px`, width: `${Math.max(2, c.duration * S.zoom)}px`, height: `${hh}px` } });
      E.over.appendChild(g);
      S.dupGhosts.push(g);
    } else S.preview.set(m.id, { start: m.start, y, h: hh });
  }
  for (const s of plan.shifts) {
    S.preview.set(s.id, { start: s.start });
    const el = S.clipEls.get(s.id);
    if (el) el.classList.add('anim');
  }
  for (const id of new Set([...prevIds, ...S.preview.keys()])) {
    const el = S.clipEls.get(id);
    const c = S.p.clips[id];
    if (el && c) layoutClip(el, c);
    if (el && !S.preview.has(id)) el.classList.remove('anim');
  }
  layoutTransitions();
  drawVisibleClips();
  void ids;
}

// ───── trim ─────

function startTrim(e, c, edge) {
  const p = S.p;
  const tk = U.trackById(p, c.trackId);
  const pts = snapPoints(new Set([c.id]));
  const el = S.clipEls.get(c.id);
  const d = {
    kind: 'trim', autoScroll: 'x', plan: null, threshold: 1,
    move(ev) {
      let t = timeAtClient(ev.clientX);
      const sn = bestSnap([t], pts);
      if (sn) t += sn.delta; else t = Math.round(t * fps()) / fps();
      showSnap(sn ? sn.at : null);
      const ripple = !!ev.shiftKey || (S.magnetic && tk && tk.role === 'main');
      const plan = O.planTrim(p, { id: c.id, edge, t, ripple });
      d.plan = plan; d.ripple = ripple;
      const prevIds = new Set(S.preview.keys());
      S.preview.clear();
      S.preview.set(c.id, { start: plan.start, duration: plan.duration, in: plan.in });
      for (const s of plan.shifts) S.preview.set(s.id, { start: s.start });
      for (const id of new Set([...prevIds, ...S.preview.keys()])) { const e2 = S.clipEls.get(id); const c2 = p.clips[id]; if (e2 && c2) layoutClip(e2, c2); }
      if (el) {
        const hEl = edge === 'start' ? el._trimL : el._trimR;
        if (hEl) hEl.classList.toggle('limit', plan.limit === 'media');
      }
      layoutTransitions();
      drawVisibleClips();
      const dd = plan.duration - c.duration;
      M.showTip(`${edge === 'start' ? 'התחלה' : 'סוף'} ${U.formatTimecode(edge === 'start' ? (plan.trimStart ?? plan.start) : plan.end, fps())} · אורך ${U.formatTimecode(plan.duration, fps())} (${dd >= 0 ? '+' : '−'}${U.formatTimecode(Math.abs(dd), fps())})${plan.limit === 'media' ? ' · סוף המדיה' : ''}${ripple ? ' · דחיפה' : ''}`, ev.clientX, ev.clientY);
    },
    up() {
      if (el) { el._trimL && el._trimL.classList.remove('limit'); el._trimR && el._trimR.classList.remove('limit'); }
      if (!d.plan) return;
      const ops = O.trimOps(p, c.id, edge, d.plan, d.ripple);
      commit(ops, `קיצוץ ${edge === 'start' ? 'תחילת' : 'סוף'} "${U.clipLabel(p, c)}"${d.ripple ? ' (דחיפה)' : ''}`);
    },
  };
  startDrag(e, d);
}

// ───── fades / volume ─────

function startFade(e, c, which, el) {
  const p = S.p;
  const d = {
    kind: 'fade', threshold: 1, value: c[which === 'in' ? 'fadeIn' : 'fadeOut'] || 0,
    move(ev) {
      const r = el.getBoundingClientRect();
      const lx = ev.clientX - r.left;
      let v = which === 'in' ? lx / S.zoom : (r.width - lx) / S.zoom;
      v = clamp(Math.round(v * fps()) / fps(), 0, c.duration / 2);
      d.value = v;
      S.preview.set(c.id, which === 'in' ? { fadeIn: v } : { fadeOut: v });
      layoutClip(el, c);
      el._cvKey = '';
      drawVisibleClips();
      M.showTip(`Fade ${which === 'in' ? 'in' : 'out'}: ${v.toFixed(2)} ש׳`, ev.clientX, ev.clientY);
    },
    up() {
      commit([{ op: 'updateClip', id: c.id, set: { [which === 'in' ? 'fadeIn' : 'fadeOut']: Math.round(d.value * 1000) / 1000 } }], `${which === 'in' ? 'הופעה הדרגתית' : 'היעלמות הדרגתית'} של "${U.clipLabel(p, c)}"`);
    },
  };
  startDrag(e, d);
}

function startVolume(e, c, el) {
  const p = S.p;
  const d = {
    kind: 'volume', threshold: 1, value: c.volume == null ? 1 : c.volume,
    move(ev) {
      const r = el.getBoundingClientRect();
      const g = clamp(gainFromVolY((ev.clientY - r.top) / r.height), 0, 4);
      d.value = Math.round(g * 1000) / 1000;
      S.preview.set(c.id, { volume: d.value });
      layoutClip(el, c);
      el._cvKey = '';
      drawVisibleClips();
      M.showTip(`עוצמה ${U.formatDb(d.value)}`, ev.clientX, ev.clientY);
    },
    up() { commit([{ op: 'updateClip', id: c.id, set: { volume: d.value } }], `עוצמת "${U.clipLabel(p, c)}" ${U.formatDb(d.value)}`); },
    click(ev) { if (ev.detail >= 2) commit([{ op: 'updateClip', id: c.id, set: { volume: 1 } }], 'איפוס עוצמה'); },
  };
  startDrag(e, d);
}

// ───── keyframes ─────

function startKeyframeDrag(e, clipEl, kfEl) {
  const c = S.p.clips[clipEl.dataset.clipId];
  if (!c) return;
  const t0 = +kfEl.dataset.t;
  const pts = snapPoints(new Set([c.id]), { keyframesOf: [] });
  const d = {
    kind: 'kf', threshold: 3, value: t0,
    move(ev) {
      let t = timeAtClient(ev.clientX);
      const sn = bestSnap([t], pts);
      if (sn) t += sn.delta;
      let lt = clamp(Math.round((t - c.start) * fps()) / fps(), 0, c.duration);
      d.value = lt;
      kfEl.style.left = `${lt * S.zoom}px`;
      showSnap(sn ? sn.at : null);
      M.showTip(`קיפריים ${U.formatTimecode(c.start + lt, fps())}`, ev.clientX, ev.clientY);
    },
    up() {
      if (Math.abs(d.value - t0) < 1e-4) return;
      const ops = O.moveKeyframeOps(c, t0, d.value);
      commit(ops, 'הזזת קיפריים');
      state.set({ activeKeyframe: { clipId: c.id, prop: null, t: d.value } }, { source: 'timeline' });
    },
    click() {
      seek(c.start + t0);
      const kt = U.keyframeTimes(c).find((k) => Math.abs(k.t - t0) < 1e-3);
      state.set({ activeKeyframe: { clipId: c.id, prop: kt ? kt.props[0].prop : null, t: t0 } }, { source: 'timeline' });
      if (!sel().has(c.id)) setSelection([c.id]);
    },
  };
  startDrag(e, d);
}

// ───── blade ─────

function bladeClick(e, c) {
  let t = timeAtClient(e.clientX);
  const sn = bestSnap([t], snapPoints(new Set()), 6);
  if (sn) t += sn.delta;
  t = Math.round(t * fps()) / fps();
  let ids = [c.id];
  if (e.shiftKey) ids = Object.values(S.p.clips).filter((x) => x.start < t && clipEnd(x) > t).map((x) => x.id);
  const ops = O.splitOps(S.p, ids, t);
  if (ops.length) commit(ops, ids.length > 1 ? `חיתוך כל הרצועות ב-${U.formatTimecode(t, fps())}` : `חיתוך "${U.clipLabel(S.p, c)}"`);
}

function updateBladeHover(e) {
  const E = S.els;
  if (state.tool !== 'blade' || S.drag || !S.p) { E.blade.style.display = 'none'; return; }
  let t = timeAtClient(e.clientX);
  const sn = bestSnap([t], snapPoints(new Set()), 6);
  if (sn) t += sn.delta;
  const cy = contentYAt(e.clientY);
  const at = trackAtY(cy);
  if (!at.track && !e.shiftKey) { E.blade.style.display = 'none'; return; }
  E.blade.style.display = 'block';
  E.blade.style.left = `${t * S.zoom}px`;
  if (e.shiftKey || !at.l) { E.blade.style.top = '0px'; E.blade.style.height = `${S.contentH}px`; }
  else { E.blade.style.top = `${at.l.y}px`; E.blade.style.height = `${at.l.h}px`; }
}

// ───── marquee / click on empty ─────

function startMarquee(e) {
  const E = S.els;
  const base = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(sel()) : new Set();
  const r0 = viewRect();
  const cx0 = e.clientX - r0.left + S.sx, cy0 = e.clientY - r0.top + S.sy;
  const d = {
    kind: 'marquee', autoScroll: 'xy',
    move(ev) {
      const r = viewRect();
      const cx1 = ev.clientX - r.left + S.sx, cy1 = ev.clientY - r.top + S.sy;
      const x0 = Math.min(cx0, cx1), x1 = Math.max(cx0, cx1), y0 = Math.min(cy0, cy1), y1 = Math.max(cy0, cy1);
      E.marquee.style.display = 'block';
      E.marquee.style.left = `${x0 - S.sx}px`;
      E.marquee.style.top = `${y0 - S.sy}px`;
      E.marquee.style.width = `${x1 - x0}px`;
      E.marquee.style.height = `${y1 - y0}px`;
      const s = new Set(base);
      for (const [id, el] of S.clipEls) {
        const tk = el._track;
        if (tk && tk.locked) continue;
        if (el._x < x1 && el._x + el._w > x0 && el._y < y1 && el._y + el._h > y0) s.add(id);
      }
      setSelection(s);
    },
    up() {},
    click(ev) {
      if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey)) setSelection([]);
      let t = timeAtClient(ev.clientX);
      const sn = bestSnap([t], snapPoints(new Set()), 6);
      if (sn) t += sn.delta;
      seek(t);
    },
  };
  startDrag(e, d);
}

function startPan(e) {
  e.preventDefault();
  const sx0 = S.sx, sy0 = S.sy;
  startDrag(e, {
    kind: 'pan', threshold: 0,
    move(ev) { S.sx = clampSx(sx0 - (ev.clientX - e.clientX)); S.sy = clampSy(sy0 - (ev.clientY - e.clientY)); invalidate(D_VIEW | D_PH); },
  });
}

// ───── ruler: scrub / markers / range ─────

function onRulerPointerDown(e) {
  if (e.button !== 0 || !S.p) return;
  e.preventDefault();
  S.root.focus({ preventScroll: true });
  const mk = e.target.closest('.tl-mk');
  if (mk) { startMarkerDrag(e, mk); return; }
  const rh = e.target.closest('.tl-range-h');
  if (rh) { startRangeDrag(e, rh.dataset.range); return; }
  startScrub(e);
}

function startScrub(e) {
  const pts = snapPoints(new Set());
  const doSeek = (ev) => {
    const r = S.els.ruler.getBoundingClientRect();
    let t = Math.max(0, (ev.clientX - r.left + S.sx) / S.zoom);
    if (!ev.shiftKey) { const sn = bestSnap([t], pts.filter((p) => p.kind !== 'playhead'), 6); if (sn) t += sn.delta; }
    seek(Math.round(t * fps()) / fps());
  };
  doSeek(e);
  startDrag(e, { kind: 'scrub', threshold: 0, autoScroll: 'x', captureEl: S.els.ruler, move: doSeek, click: () => {} });
}

function startMarkerDrag(e, mkEl) {
  const m = (S.p.markers || []).find((x) => x.id === mkEl.dataset.markerId);
  if (!m) return;
  if (e.detail >= 2) { renameMarker(m); return; }
  const pts = snapPoints(new Set()).filter((p) => p.kind !== 'marker' || Math.abs(p.t - m.t) > 1e-6);
  const d = {
    kind: 'marker', threshold: 3, autoScroll: 'x', captureEl: S.els.ruler, value: m.t,
    move(ev) {
      const r = S.els.ruler.getBoundingClientRect();
      let t = Math.max(0, (ev.clientX - r.left + S.sx) / S.zoom);
      const sn = bestSnap([t], pts, 6);
      if (sn) t += sn.delta; else t = Math.round(t * fps()) / fps();
      d.value = t;
      S.markerPreview = { id: m.id, t };
      layoutMarkers();
      M.showTip(`${m.label || 'סמן'} · ${U.formatTimecode(t, fps())}`, ev.clientX, ev.clientY);
    },
    up() { commit(O.markerUpdateOps(m, { t: d.value }), 'הזזת סמן'); },
    click() { seek(m.t); },
  };
  startDrag(e, d);
}

function startRangeDrag(e, which) {
  startDrag(e, {
    kind: 'range', threshold: 0, autoScroll: 'x', captureEl: S.els.ruler,
    move(ev) {
      const r = S.els.ruler.getBoundingClientRect();
      const t = Math.round(Math.max(0, (ev.clientX - r.left + S.sx) / S.zoom) * fps()) / fps();
      const cur = rangeOf();
      const next = { in: cur.in, out: cur.out };
      next[which] = t;
      if (next.in != null && next.out != null && next.in > next.out) { const x = next.in; next.in = next.out; next.out = x; }
      state.set({ range: next }, { source: 'timeline' });
      M.showTip(`${which === 'in' ? 'כניסה' : 'יציאה'} ${U.formatTimecode(t, fps())}`, ev.clientX, ev.clientY);
    },
  });
}

async function renameMarker(m) {
  const v = await M.promptDialog({ title: 'שם הסמן', value: m.label || '', placeholder: 'למשל: דרופ' });
  if (v == null) return;
  commit(O.markerUpdateOps(m, { label: v.trim() }), 'שינוי שם סמן');
}

// ───── scrollbars ─────

function onHsDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = e.target.closest('.tl-hs-grip');
  const thumbR = S.els.hsThumb.getBoundingClientRect();
  const hsR = S.els.hs.getBoundingClientRect();
  if (grip) {
    // zoom handle: keep the opposite edge fixed
    const isL = grip.classList.contains('l');
    const tA = S.sx / S.zoom, tB = (S.sx + S.vw) / S.zoom;
    startDrag(e, {
      kind: 'hszoom', threshold: 0, captureEl: S.els.hs,
      move(ev) {
        const x = clamp(ev.clientX - hsR.left, 0, S.vw);
        const totalT = S.contentW / S.zoom;
        if (isL) {
          const newA = clamp((x / S.vw) * totalT, 0, tB - 0.2);
          const z = clamp(S.vw / (tB - newA), MIN_ZOOM, MAX_ZOOM);
          S.zoom = z; S.contentW = contentWidth(); S.sx = clampSx(tB * z - S.vw);
        } else {
          const newB = Math.max(tA + 0.2, (x / S.vw) * totalT);
          const z = clamp(S.vw / (newB - tA), MIN_ZOOM, MAX_ZOOM);
          S.zoom = z; S.contentW = contentWidth(); S.sx = clampSx(tA * z);
        }
        S.zoomAt = performance.now();
        state.set({ zoom: S.zoom }, { source: 'timeline' });
        invalidate(D_LAYOUT | D_VIEW | D_PH);
      },
    });
    return;
  }
  if (e.target === S.els.hs) {
    const x = e.clientX - hsR.left - thumbR.width / 2;
    S.sx = clampSx((x / (S.vw - thumbR.width)) * (S.contentW - S.vw));
    invalidate(D_VIEW | D_PH);
  }
  const sx0 = S.sx, x0 = e.clientX;
  startDrag(e, {
    kind: 'hs', threshold: 0, captureEl: S.els.hs,
    move(ev) {
      const k = (S.contentW - S.vw) / Math.max(1, S.vw - S.els.hsThumb.offsetWidth);
      S.sx = clampSx(sx0 + (ev.clientX - x0) * k);
      invalidate(D_VIEW | D_PH);
    },
  });
}

function onVsDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const sy0 = S.sy, y0 = e.clientY;
  startDrag(e, {
    kind: 'vs', threshold: 0, captureEl: S.els.vs,
    move(ev) {
      const k = (S.contentH - S.vh) / Math.max(1, S.vh - S.els.vsThumb.offsetHeight);
      S.sy = clampSy(sy0 + (ev.clientY - y0) * k);
      invalidate(D_VIEW);
    },
  });
}

// ───── wheel ─────

function onWheel(e) {
  if (!S.p) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    setZoom(S.zoom * f, e.clientX);
    return;
  }
  const overHeads = S.els.heads.contains(e.target);
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 30; dy *= 30; }
  if (overHeads || e.shiftKey) {
    // vertical scroll (Shift+wheel or over the track headers)
    S.sy = clampSy(S.sy + (e.shiftKey && !overHeads ? dy || dx : dy));
  } else {
    S.sx = clampSx(S.sx + (Math.abs(dx) > Math.abs(dy) ? dx : dy));
  }
  invalidate(D_VIEW | D_PH);
}

// ───────────────────────────── track headers ─────────────────────────────

function buildHeader(t) {
  const el = h('div.tl-th', { dataset: { trackId: t.id } });
  el.innerHTML = `<div class="tl-th-color"></div><div class="tl-th-grip" title="גרירה לשינוי סדר הרצועות">${icon('grip', 12)}</div>
    <div class="tl-th-main"><span class="tl-th-ic"></span><span class="tl-th-name" dir="auto"></span><span class="tl-th-btns"></span></div>
    <div class="tl-th-resize" title="גרירה לשינוי גובה"></div>`;
  el._ic = el.querySelector('.tl-th-ic');
  el._name = el.querySelector('.tl-th-name');
  el._r2 = el.querySelector('.tl-th-btns');
  el._name.addEventListener('dblclick', (e) => { e.stopPropagation(); inlineRename(el, el._trackId); });
  el.querySelector('.tl-th-grip').addEventListener('pointerdown', (e) => startTrackReorder(e, el._trackId));
  el.querySelector('.tl-th-resize').addEventListener('pointerdown', (e) => startTrackResize(e, el._trackId));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); const tk = U.trackById(S.p, el._trackId); if (tk) M.showMenu(trackMenu(tk), e.clientX, e.clientY); });
  return el;
}

function updateHeader(el, t, l, i) {
  if (!l) return;
  el._trackId = t.id;
  el.style.top = `${l.y}px`;
  el.style.height = `${l.h}px`;
  el.className = `tl-th${i % 2 ? ' alt' : ''}${l.h < 34 ? ' compact' : ''}`;
  const rc = ROLE_COL[t.role] || '#6f7681';
  el.style.setProperty('--rc', rc);
  const ic = U.roleIcon(t);
  if (el._icName !== ic) { el._ic.innerHTML = icon(ic, 14); el._icName = ic; }
  const nm = U.trackLabel(t);
  if (el._name.textContent !== nm) el._name.textContent = nm;
  el._name.title = `${nm} · ${U.ROLE_LABELS[t.role] || ''} — לחיצה כפולה לשינוי שם`;
  // buttons (track volume lives in the inspector: audio clip → אודיו → רצועה)
  const key = JSON.stringify([t.kind, t.hidden, t.muted, t.locked, t.solo]);
  if (el._btnKey === key) return;
  el._btnKey = key;
  const r2 = el._r2;
  r2.textContent = '';
  const tb = (name, title, on, fn, cls = '') => {
    const b = h('button.tl-tb', { title, 'aria-label': title, html: icon(name, 13) });
    if (cls) b.classList.add(...cls.split(' '));
    if (on) b.classList.add('on');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  if (t.kind === 'video') r2.appendChild(tb(t.hidden ? 'eyeOff' : 'eye', t.hidden ? 'הצגת הרצועה' : 'הסתרת הרצועה', t.hidden, () => updateTrack(t, { hidden: !t.hidden }, t.hidden ? 'הצגת רצועה' : 'הסתרת רצועה'), 'red'));
  r2.appendChild(tb(t.muted ? 'volumeOff' : 'volume', t.muted ? 'ביטול השתקה' : 'השתקת הרצועה', t.muted, () => updateTrack(t, { muted: !t.muted }, t.muted ? 'ביטול השתקת רצועה' : 'השתקת רצועה'), 'red'));
  r2.appendChild(tb(t.locked ? 'lock' : 'unlock', t.locked ? 'ביטול נעילה' : 'נעילת הרצועה', t.locked, () => updateTrack(t, { locked: !t.locked }, t.locked ? 'ביטול נעילת רצועה' : 'נעילת רצועה')));
  if (t.kind === 'audio') r2.appendChild(tb('solo', t.solo ? 'ביטול סולו' : 'סולו — רק הרצועה הזו תישמע', t.solo, () => updateTrack(t, { solo: !t.solo }, t.solo ? 'ביטול סולו' : 'סולו לרצועה'), 'solo'));
}

function updateTrack(t, set, summary) {
  commit([{ op: 'updateTrack', id: t.id, set }], `${summary} "${U.trackLabel(t)}"`);
}

function inlineRename(el, trackId) {
  const t = U.trackById(S.p, trackId);
  if (!t) return;
  const input = h('input', { type: 'text', value: U.trackLabel(t), dir: 'auto', spellcheck: false,
    style: { flex: '1', minWidth: '0', height: '20px', fontSize: '11.5px', background: '#0e1013', color: '#fff', border: '1px solid #13b6e4', borderRadius: '4px', padding: '0 5px', outline: 'none' } });
  el._name.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    input.replaceWith(el._name);
    const v = input.value.trim();
    if (ok && v && v !== t.name) commit([{ op: 'updateTrack', id: t.id, set: { name: v } }], `שינוי שם רצועה ל"${v}"`);
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}

function startTrackReorder(e, trackId) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const head = S.headEls.get(trackId);
  const from = S.layout.findIndex((l) => l.track.id === trackId);
  const d = {
    kind: 'reorder', threshold: 3, autoScroll: null, captureEl: S.els.heads, index: from,
    begin() { head.classList.add('reorder'); },
    move(ev) {
      const r = S.els.heads.getBoundingClientRect();
      const cy = ev.clientY - r.top + S.sy;
      let idx = S.layout.length;
      for (let i = 0; i < S.layout.length; i++) if (cy < S.layout[i].y + S.layout[i].h / 2) { idx = i; break; }
      d.index = idx;
      const y = idx < S.layout.length ? S.layout[idx].y - GAP / 2 : S.layout[S.layout.length - 1].y + S.layout[S.layout.length - 1].h + GAP / 2;
      S.els.thDrop.style.display = 'block';
      S.els.thDrop.style.top = `${y - S.sy}px`;
    },
    up() {
      head.classList.remove('reorder');
      S.els.thDrop.style.display = 'none';
      // d.index is a slot in the visible list; moveTrack wants an index in p.tracks (empty tracks are not drawn)
      if (d.index === from || d.index === from + 1) return;
      const fromFull = U.trackIndex(S.p, trackId);
      const slot = d.index < S.layout.length ? S.layout[d.index].index : S.p.tracks.length;
      const to = slot > fromFull ? slot - 1 : slot;
      if (to === fromFull) return;
      const t = U.trackById(S.p, trackId);
      commit([{ op: 'moveTrack', id: trackId, index: to }], `הזזת הרצועה "${U.trackLabel(t)}"`);
    },
    cancel() { head.classList.remove('reorder'); S.els.thDrop.style.display = 'none'; },
  };
  startDrag(e, d);
}

function startTrackResize(e, trackId) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const t = U.trackById(S.p, trackId);
  const h0 = trackH(t);
  const d = {
    kind: 'resize', threshold: 0, captureEl: S.els.heads, value: h0,
    move(ev) {
      d.value = clamp(Math.round(h0 + (ev.clientY - e.clientY)), 24, 180);
      S.trackH.set(trackId, d.value);
      invalidate(D_RENDER | D_LAYOUT | D_VIEW);
    },
    up() {
      const v = d.value;
      commit([{ op: 'updateTrack', id: trackId, set: { height: v } }], `גובה רצועה ${v}px`).then(() => { S.trackH.delete(trackId); invalidate(D_RENDER | D_LAYOUT | D_VIEW); });
    },
    cancel() { S.trackH.delete(trackId); },
  };
  startDrag(e, d);
}

// ───────────────────────────── transitions picker ─────────────────────────────

function onTransitionBadge(badge, e) {
  const aId = badge.dataset.a;
  startDrag(e, { kind: 'trbadge', threshold: 4, click: () => openTransitionPicker(aId, badge.getBoundingClientRect()) });
}

async function openTransitionPicker(aId, rect) {
  const cat = await loadCatalog();
  const p = S.p;
  const a = p.clips[aId];
  if (!a) return;
  const b = U.nextAdjacent(p, a);
  const cur = a.transitionOut && a.transitionOut.id !== 'none' ? a.transitionOut : null;
  const maxD = Math.max(0.1, Math.min(3, a.duration, b ? b.duration : 3));
  let dur = clamp(cur ? +cur.duration : 0.5, 0.05, maxD);
  let chosen = cur ? cur.id : null;
  const list = cat.transitions || [];
  const cats = ['הכל', ...new Set(list.map((t) => t.category).filter(Boolean))];
  let curCat = 'הכל';
  const box = h('div.tlp');
  const catsEl = h('div.tlp-cats');
  const grid = h('div.tlp-grid');
  const durIn = h('input', { type: 'range', min: '0.05', max: String(maxD.toFixed(2)), step: '0.05', value: String(dur) });
  const durVal = h('span.tlp-val', { text: `${dur.toFixed(2)}s` });
  const removeBtn = h('button.fsm-btn', { text: 'הסרת המעבר' });
  const allBtn = h('button.fsm-btn', { text: 'החלה על כל החיבורים ברצועה' });
  box.append(catsEl, grid, h('div.tlp-row', null, h('label', { text: 'משך' }), durIn, durVal), h('div.tlp-actions', null, allBtn, removeBtn));
  const anims = [];
  const apply = (id) => {
    chosen = id;
    commit(O.transitionOps(S.p, aId, id, dur), `מעבר "${(transitionById(id) || {}).name || id}"`);
    grid.querySelectorAll('.tlp-item').forEach((x) => x.classList.toggle('on', x.dataset.id === id));
  };
  const renderGrid = () => {
    grid.textContent = '';
    for (const a2 of anims) cancelAnimationFrame(a2.raf);
    anims.length = 0;
    for (const t of list.filter((x) => curCat === 'הכל' || x.category === curCat)) {
      const cv = h('canvas', { width: 128, height: 80 });
      const item = h('div.tlp-item', { dataset: { id: t.id }, title: t.name }, cv, h('span', { text: t.name }));
      if (t.id === chosen) item.classList.add('on');
      const ctx = cv.getContext('2d');
      drawTransitionPreview(ctx, 128, 80, t.id, 0.4);
      const an = { raf: 0 };
      anims.push(an);
      item.addEventListener('mouseenter', () => {
        const t0 = performance.now();
        const loop = (now) => { const ph = ((now - t0) / 1400) % 1.3; drawTransitionPreview(ctx, 128, 80, t.id, clamp(ph / 1.0, 0, 1)); an.raf = requestAnimationFrame(loop); };
        an.raf = requestAnimationFrame(loop);
      });
      item.addEventListener('mouseleave', () => { cancelAnimationFrame(an.raf); drawTransitionPreview(ctx, 128, 80, t.id, 0.4); });
      item.addEventListener('click', () => apply(t.id));
      grid.appendChild(item);
    }
  };
  for (const c of cats) {
    const b2 = h('button.tlp-cat', { text: c });
    if (c === curCat) b2.classList.add('on');
    b2.addEventListener('click', () => { curCat = c; catsEl.querySelectorAll('.tlp-cat').forEach((x) => x.classList.toggle('on', x === b2)); renderGrid(); });
    catsEl.appendChild(b2);
  }
  renderGrid();
  durIn.addEventListener('input', () => { dur = +durIn.value; durVal.textContent = `${dur.toFixed(2)}s`; });
  durIn.addEventListener('change', () => { if (chosen) commit(O.transitionOps(S.p, aId, chosen, dur), `משך מעבר ${dur.toFixed(2)} ש׳`); });
  removeBtn.addEventListener('click', () => { commit([{ op: 'removeTransition', id: aId }], 'הסרת מעבר'); M.closePopover(); });
  allBtn.addEventListener('click', () => {
    const id = chosen || (list[0] && list[0].id);
    if (!id) return;
    const ops = [];
    for (const j of junctions()) if (j.track.id === a.trackId) ops.push(...O.transitionOps(S.p, j.a.id, id, dur));
    commit(ops, `מעבר "${(transitionById(id) || {}).name || id}" על כל הרצועה`);
    M.closePopover();
  });
  removeBtn.disabled = !cur;
  M.showPopover(box, rect, { title: `מעבר בין "${U.clipLabel(p, a)}" ל"${b ? U.clipLabel(p, b) : ''}"`, width: 470, onClose: () => anims.forEach((x) => cancelAnimationFrame(x.raf)) });
}

// ───────────────────────────── context menus ─────────────────────────────

function addTrackMenu(atIndex = null) {
  const mk = (kind, role) => () => {
    const idx = atIndex != null ? atIndex : O.newTrackIndex(S.p, kind, kind === 'video' ? 'top' : 'bottom');
    const op = O.makeNewTrack(S.p, kind, role, idx);
    S.keepTracks.add(op.id);
    commit([op], `הוספת רצועת ${U.ROLE_LABELS[role]}`);
  };
  return [
    { title: 'רצועות וידאו' },
    { label: 'שכבה (וידאו/תמונה)', icon: 'overlay', onClick: mk('video', 'overlay') },
    { label: 'טקסט וכתוביות', icon: 'text', onClick: mk('video', 'text') },
    { label: 'אפקטים', icon: 'effects', onClick: mk('video', 'effects') },
    { label: 'ראשי', icon: 'main', onClick: mk('video', 'main'), disabled: !!U.mainTrack(S.p) },
    '-',
    { title: 'רצועות שמע' },
    { label: 'קריינות', icon: 'voice', onClick: mk('audio', 'voice') },
    { label: 'מוזיקה', icon: 'music', onClick: mk('audio', 'music') },
    { label: 'אפקטים קוליים', icon: 'sfx', onClick: mk('audio', 'sfx') },
  ];
}

function trackMenu(t) {
  const idx = U.trackIndex(S.p, t.id);
  const n = U.clipsOnTrack(S.p, t.id).length;
  const heights = [['נמוך', 32], ['רגיל', ROLE_H[t.role] || 48], ['גבוה', 84], ['גבוה מאוד', 128]];
  return [
    { label: 'שינוי שם…', icon: 'text', onClick: () => inlineRename(S.headEls.get(t.id), t.id) },
    { label: 'בחירת כל הקליפים ברצועה', icon: 'check', onClick: () => setSelection(U.clipsOnTrack(S.p, t.id).map((c) => c.id)), disabled: !n },
    '-',
    { label: 'הוספת רצועה מעל', icon: 'plus', submenu: addTrackMenu(idx) },
    { label: 'הוספת רצועה מתחת', icon: 'plus', submenu: addTrackMenu(idx + 1) },
    { label: 'הזזה למעלה', icon: 'chevronDown', disabled: idx <= 0, onClick: () => commit([{ op: 'moveTrack', id: t.id, index: idx - 1 }], 'הזזת רצועה למעלה') },
    { label: 'הזזה למטה', icon: 'chevronDown', disabled: idx >= S.p.tracks.length - 1, onClick: () => commit([{ op: 'moveTrack', id: t.id, index: idx + 1 }], 'הזזת רצועה למטה') },
    { label: 'גובה', icon: 'height', submenu: heights.map(([lbl, v]) => ({ label: lbl, checked: trackH(t) === v, onClick: () => commit([{ op: 'updateTrack', id: t.id, set: { height: v } }], `גובה רצועה: ${lbl}`) })) },
    '-',
    { label: n ? `מחיקת הרצועה (${n} קליפים)` : 'מחיקת הרצועה', icon: 'trash', danger: true, onClick: async () => {
      if (n) {
        const ok = await M.confirmDialog({ title: 'למחוק את הרצועה?', message: `הרצועה "${U.trackLabel(t)}" ו-${n} הקליפים שבה יימחקו. אפשר לבטל עם Ctrl+Z.`, okLabel: 'מחיקה', danger: true });
        if (!ok) return;
      }
      commit([{ op: 'removeTrack', id: t.id }], `מחיקת הרצועה "${U.trackLabel(t)}"`);
    } },
  ];
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function clipMenu(c, t) {
  const p = S.p;
  const s = sel();
  const ids = s.has(c.id) ? [...s] : [c.id];
  const multi = ids.length > 1;
  const m = U.mediaOf(p, c);
  const ph = state.playhead;
  const canSplit = ids.some((id) => { const x = p.clips[id]; return x && x.start < ph && clipEnd(x) > ph; });
  const next = U.nextAdjacent(p, c);
  const prev = U.prevAdjacent(p, c);
  const hasTr = c.transitionOut && c.transitionOut.id && c.transitionOut.id !== 'none';
  const items = [
    { label: 'פיצול בסמן הניגון', icon: 'scissors', kbd: 'S', disabled: !canSplit, onClick: () => commands.split(ids) },
    { label: 'העתקה', icon: 'copy', kbd: 'Ctrl+C', onClick: () => commands.copy(ids) },
    { label: 'גזירה', icon: 'scissors', kbd: 'Ctrl+X', onClick: () => commands.cut(ids) },
    { label: 'הדבקה בסמן הניגון', icon: 'duplicate', kbd: 'Ctrl+V', disabled: !S.clipboard, onClick: () => commands.paste() },
    { label: 'שכפול', icon: 'duplicate', kbd: 'Ctrl+D', onClick: () => commands.duplicate(ids) },
    '-',
    { label: multi ? `מחיקת ${ids.length} קליפים` : 'מחיקה', icon: 'trash', kbd: 'Del', danger: true, onClick: () => commands.del({ ids }) },
    { label: 'מחיקה וסגירת הרווח', icon: 'ripple', kbd: 'Shift+Del', danger: true, onClick: () => commands.del({ ids, ripple: true }) },
    '-',
  ];
  if (c.type === 'video' && (!m || m.hasAudio !== false)) {
    items.push({ label: 'הפרדת השמע לרצועה נפרדת', icon: 'detach', disabled: !!c.muteAudio, onClick: () => commands.detachAudio(c.id) });
    items.push({ label: c.muteAudio ? 'ביטול השתקת הקליפ' : 'השתקת הקליפ', icon: c.muteAudio ? 'volume' : 'volumeOff', onClick: () => commit(ids.map((id) => ({ op: 'updateClip', id, set: { muteAudio: !c.muteAudio } })), c.muteAudio ? 'ביטול השתקה' : 'השתקת קליפ') });
  }
  if (c.type === 'video' || c.type === 'audio') {
    items.push({ label: 'מהירות', icon: 'speed', submenu: SPEEDS.map((v) => ({ label: `${v}×`, checked: Math.abs((c.speed || 1) - v) < 1e-6, onClick: () => commit(O.speedOps(p, ids, v, { magnetic: S.magnetic }), `מהירות ${v}×`) })) });
    items.push({ label: c.reverse ? 'ניגון רגיל (ביטול היפוך)' : 'ניגון לאחור', icon: 'undo', onClick: () => commit(ids.map((id) => ({ op: 'updateClip', id, set: { reverse: !c.reverse } })), c.reverse ? 'ביטול היפוך' : 'ניגון לאחור') });
  }
  if (c.type !== 'audio' && (next || prev)) {
    items.push({ label: hasTr ? 'עריכת המעבר…' : 'הוספת מעבר…', icon: 'transition', onClick: () => {
      const j = next ? c : prev;
      const badge = S.els.over.querySelector(`.tl-tr[data-a="${j.id}"]`);
      openTransitionPicker(j.id, badge ? badge.getBoundingClientRect() : S.clipEls.get(c.id).getBoundingClientRect());
    } });
    if (hasTr) items.push({ label: 'הסרת המעבר', icon: 'x', onClick: () => commit([{ op: 'removeTransition', id: c.id }], 'הסרת מעבר') });
  }
  if (c.keyframes && Object.keys(c.keyframes).some((k) => (c.keyframes[k] || []).length)) {
    items.push({ label: 'ניקוי כל הקיפריימים', icon: 'keyframe', onClick: () => commit([{ op: 'clearKeyframes', id: c.id }], 'ניקוי קיפריימים') });
  }
  items.push('-');
  items.push({ label: c.disabled ? 'הפעלת הקליפ' : 'השבתת הקליפ', icon: c.disabled ? 'eye' : 'eyeOff', onClick: () => commit(ids.map((id) => ({ op: 'updateClip', id, set: { disabled: !c.disabled } })), c.disabled ? 'הפעלת קליפ' : 'השבתת קליפ') });
  items.push({ label: 'שינוי שם…', icon: 'text', disabled: multi, onClick: async () => {
    const v = await M.promptDialog({ title: 'שם הקליפ', value: c.name || U.clipLabel(p, c) });
    if (v != null) commit([{ op: 'updateClip', id: c.id, set: { name: v.trim() } }], 'שינוי שם קליפ');
  } });
  items.push({ label: 'צבע בציר הזמן', icon: 'filter', submenu: [{ swatches: { colors: [null, ...U.CLIP_PALETTE], value: U.clipTint(c), onPick: (col) => commit(ids.map((id) => ({ op: 'updateClip', id, set: { tint: col } })), 'צבע קליפ בציר הזמן') } }] });
  items.push({ label: 'הוספת סמן כאן', icon: 'marker', kbd: 'M', onClick: () => commands.addMarker(S.menuT != null ? S.menuT : ph) });
  items.push({ label: 'בחירת כל הקליפים מימין', icon: 'chevronRight', onClick: () => setSelection(Object.values(p.clips).filter((x) => x.start >= c.start - 1e-6).map((x) => x.id)) });
  void t;
  return items;
}

function emptyMenu(tAt, track) {
  return [
    { label: 'הדבקה כאן', icon: 'duplicate', kbd: 'Ctrl+V', disabled: !S.clipboard, onClick: () => commands.paste(tAt) },
    { label: 'הוספת סמן כאן', icon: 'marker', onClick: () => commands.addMarker(tAt) },
    { label: 'הזזת סמן הניגון לכאן', icon: 'play', onClick: () => seek(tAt) },
    '-',
    { label: 'סגירת הרווח כאן', icon: 'ripple', disabled: !track, onClick: () => closeGapAt(track, tAt) },
    { label: 'בחירת הכל', icon: 'check', kbd: 'Ctrl+A', onClick: () => commands.selectAll() },
    { label: 'הוספת רצועה', icon: 'plus', submenu: addTrackMenu() },
    { label: 'התאמת הזום לחלון', icon: 'fit', kbd: '\\', onClick: () => commands.zoomFit() },
    { label: 'גלילה אוטומטית בזמן ניגון', checked: S.follow, onClick: () => { S.follow = !S.follow; savePrefs(); } },
  ];
}

function closeGapAt(track, t) {
  const list = U.clipsOnTrack(S.p, track.id);
  const prev = list.filter((c) => clipEnd(c) <= t + 1e-6).pop();
  const next = list.find((c) => c.start >= t - 1e-6);
  if (!next) { M.toast('אין רווח לסגירה כאן'); return; }
  const gapStart = prev ? clipEnd(prev) : 0;
  const gap = next.start - gapStart;
  if (gap <= 1e-4) { M.toast('אין רווח לסגירה כאן'); return; }
  const ops = list.filter((c) => c.start >= next.start - 1e-6).map((c) => ({ op: 'moveClip', id: c.id, start: Math.round((c.start - gap) * 1e6) / 1e6, overlap: 'allow' }));
  commit(ops, `סגירת רווח של ${gap.toFixed(2)} ש׳`);
}

function rulerMenu(t) {
  const r = rangeOf();
  return [
    { label: 'הוספת סמן כאן', icon: 'marker', onClick: () => commands.addMarker(t) },
    { label: 'נקודת כניסה כאן', icon: 'inPoint', kbd: 'I', onClick: () => state.set({ range: { in: t, out: r.out != null && r.out < t ? null : r.out } }, { source: 'timeline' }) },
    { label: 'נקודת יציאה כאן', icon: 'outPoint', kbd: 'O', onClick: () => state.set({ range: { in: r.in != null && r.in > t ? null : r.in, out: t } }, { source: 'timeline' }) },
    { label: 'ניקוי הטווח', icon: 'x', disabled: r.in == null && r.out == null, onClick: () => state.set({ range: { in: null, out: null } }, { source: 'timeline' }) },
  ];
}

function markerMenu(m) {
  return [
    { label: 'קפיצה לסמן', icon: 'play', onClick: () => seek(m.t) },
    { label: 'שינוי שם…', icon: 'text', onClick: () => renameMarker(m) },
    { label: 'צבע', icon: 'filter', submenu: [{ swatches: { colors: U.MARKER_PALETTE, value: m.color || '#f5c518', onPick: (col) => commit(O.markerUpdateOps(m, { color: col }), 'צבע סמן') } }] },
    { label: 'העברה לסמן הניגון', icon: 'marker', onClick: () => commit(O.markerUpdateOps(m, { t: state.playhead }), 'הזזת סמן') },
    '-',
    { label: 'מחיקת הסמן', icon: 'trash', danger: true, onClick: () => commit([{ op: 'removeMarker', id: m.id }], 'מחיקת סמן') },
  ];
}

function kfMenu(c, t) {
  return [
    { label: 'קפיצה לקיפריים', icon: 'play', onClick: () => seek(c.start + t) },
    { label: 'מחיקת הקיפריים', icon: 'trash', danger: true, onClick: () => commit(O.removeKeyframesAtOps(c, t), 'מחיקת קיפריים') },
  ];
}

function onContextMenu(e) {
  e.preventDefault();
  if (!S.p) return;
  const tAt = timeAtClient(e.clientX);
  S.menuT = tAt;
  const kf = e.target.closest('.tl-kf');
  const clipEl = e.target.closest('.tl-clip');
  if (kf && clipEl) { const c = S.p.clips[clipEl.dataset.clipId]; if (c) M.showMenu(kfMenu(c, +kf.dataset.t), e.clientX, e.clientY); return; }
  const tr = e.target.closest('.tl-tr');
  if (tr) {
    const a = S.p.clips[tr.dataset.a];
    if (a) M.showMenu([
      { label: 'עריכת המעבר…', icon: 'transition', onClick: () => openTransitionPicker(a.id, tr.getBoundingClientRect()) },
      { label: 'הסרת המעבר', icon: 'x', disabled: !(a.transitionOut && a.transitionOut.id !== 'none'), onClick: () => commit([{ op: 'removeTransition', id: a.id }], 'הסרת מעבר') },
    ], e.clientX, e.clientY);
    return;
  }
  if (clipEl) {
    const c = S.p.clips[clipEl.dataset.clipId];
    if (!c) return;
    if (!sel().has(c.id)) setSelection([c.id]);
    M.showMenu(clipMenu(c, U.trackById(S.p, c.trackId)), e.clientX, e.clientY);
    return;
  }
  const at = trackAtY(contentYAt(e.clientY));
  M.showMenu(emptyMenu(tAt, at.track), e.clientX, e.clientY);
}

function onRulerContext(e) {
  e.preventDefault();
  if (!S.p) return;
  const mk = e.target.closest('.tl-mk');
  if (mk) { const m = (S.p.markers || []).find((x) => x.id === mk.dataset.markerId); if (m) M.showMenu(markerMenu(m), e.clientX, e.clientY); return; }
  const r = S.els.ruler.getBoundingClientRect();
  M.showMenu(rulerMenu(Math.round(Math.max(0, (e.clientX - r.left + S.sx) / S.zoom) * fps()) / fps()), e.clientX, e.clientY);
}

// ───────────────────────────── library drag & drop ─────────────────────────────

function dropTarget(ev, payload) {
  const p = S.p;
  let t = timeAtClient(ev.clientX);
  const pts = snapPoints(new Set());
  const cy = contentYAt(ev.clientY);
  const at = trackAtY(cy);
  const clipEl = ev.target && ev.target.closest ? ev.target.closest('.tl-clip') : null;
  const trEl = ev.target && ev.target.closest ? ev.target.closest('.tl-tr') : null;
  const clip = clipEl ? p.clips[clipEl.dataset.clipId] : null;
  if (payload.kind === 'transition') {
    if (trEl) return { mode: 'transition', aId: trEl.dataset.a, el: trEl };
    if (clip && O.canApplyTo(payload, clip)) { const j = O.junctionFor(p, clip, t); if (j) return { mode: 'transition', aId: j.id, el: S.els.over.querySelector(`.tl-tr[data-a="${j.id}"]`) }; }
    return { mode: 'none' };
  }
  if (O.APPLY_KINDS.has(payload.kind) && clip && O.canApplyTo(payload, clip)) {
    const ids = sel().has(clip.id) ? [...sel()].filter((id) => p.clips[id] && O.canApplyTo(payload, p.clips[id])) : [clip.id];
    return { mode: 'apply', ids, el: clipEl, t };
  }
  if (!O.CREATE_KINDS.has(payload.kind)) return { mode: 'none' };
  const dur = O.payloadDuration(p, payload);
  const sn = bestSnap([t, t + dur], pts);
  if (sn) t += sn.delta;
  t = Math.max(0, Math.round(t * fps()) / fps());
  return { mode: 'create', t, hoverTrackId: at.track ? at.track.id : null, zone: at.zone, dur, snapAt: sn ? sn.at : null };
}

function showDropFeedback(tg, payload) {
  const E = S.els;
  clearDropFeedback(true);
  if (tg.mode === 'transition' && tg.el) { tg.el.classList.add('drop'); return; }
  if (tg.mode === 'apply') { for (const id of tg.ids) { const el = S.clipEls.get(id); if (el) el.classList.add('drop-on'); } return; }
  if (tg.mode !== 'create') return;
  const p = S.p;
  const type = O.payloadType(p, payload);
  const ch = O.chooseTrack(p, { type, start: tg.t, dur: tg.dur, hoverTrackId: tg.hoverTrackId, zone: tg.zone, magnetic: S.magnetic, role: payload.kind === 'sound' ? (payload.role || 'sfx') : undefined, name: payload.name });
  let y, hh, x = tg.t * S.zoom;
  const hiddenTk = !ch.newTrack && !S.byTrack.has(ch.trackId) ? U.trackById(p, ch.trackId) : null;
  if (ch.newTrack || hiddenTk) {
    y = ch.newTrack ? slotY(ch.newTrack.index) : slotY(U.trackIndex(p, hiddenTk.id));
    E.newTrack.style.display = 'block';
    E.newTrack.style.top = `${y}px`;
    E.newTrack.style.width = `${S.contentW}px`;
    E.newTrack.dataset.label = ch.newTrack ? `רצועה חדשה · ${U.ROLE_LABELS[ch.newTrack.role] || ''}` : U.trackLabel(hiddenTk);
    hh = 36; y -= 18;
  } else {
    const l = S.byTrack.get(ch.trackId);
    y = l.y + 1; hh = l.h - 2;
    const lane = S.laneEls.get(ch.trackId);
    if (lane) lane.classList.add('drop-target');
    if (ch.insert) {
      x = ch.insert.at * S.zoom;
      E.insert.style.display = 'block';
      E.insert.style.left = `${x}px`;
      E.insert.style.top = `${l.y}px`;
      E.insert.style.height = `${l.h}px`;
    }
  }
  E.ghost.style.display = 'block';
  E.ghost.style.left = `${x}px`;
  E.ghost.style.top = `${y}px`;
  E.ghost.style.width = `${Math.max(8, tg.dur * S.zoom)}px`;
  E.ghost.style.height = `${hh}px`;
  E.ghost.textContent = `${payload.name || ''} · ${U.formatTimecode(ch.insert ? ch.insert.at : tg.t, fps())}`;
  showSnap(tg.snapAt);
}

function clearDropFeedback(keepRoot) {
  const E = S.els;
  E.ghost.style.display = 'none';
  E.newTrack.style.display = 'none';
  E.insert.style.display = 'none';
  showSnap(null);
  for (const el of E.over.querySelectorAll('.tl-tr.drop')) el.classList.remove('drop');
  for (const el of E.clips.querySelectorAll('.drop-on')) el.classList.remove('drop-on');
  for (const el of E.lanes.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  if (!keepRoot) { S.root.classList.remove('dropping'); E.fileOver.style.display = 'none'; }
}

function onDragOver(e) {
  if (!S.p) return;
  const payload = getDragPayload(e);
  if (!payload) {
    if (isFileDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      S.root.classList.add('dropping');
      S.els.fileOver.style.display = 'flex';
      const tg = { mode: 'create', t: Math.round(timeAtClient(e.clientX) * fps()) / fps(), hoverTrackId: (trackAtY(contentYAt(e.clientY)).track || {}).id || null, zone: trackAtY(contentYAt(e.clientY)).zone, dur: 3 };
      showDropFeedback(tg, { kind: 'media', mediaKind: 'video', name: 'קבצים' });
    }
    return;
  }
  const tg = dropTarget(e, payload);
  if (tg.mode === 'none') { e.dataTransfer.dropEffect = 'none'; clearDropFeedback(true); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  S.root.classList.add('dropping');
  showDropFeedback(tg, payload);
  // auto-scroll near edges while dragging from the library
  const r = viewRect();
  if (e.clientX > r.right - 30) { S.sx = clampSx(S.sx + 12); invalidate(D_VIEW | D_PH); }
  else if (e.clientX < r.left + 20 && S.sx > 0) { S.sx = clampSx(S.sx - 12); invalidate(D_VIEW | D_PH); }
}

function onDragLeave(e) {
  if (e.relatedTarget && S.els.view.contains(e.relatedTarget)) return;
  clearDropFeedback(false);
}

async function onDrop(e) {
  if (!S.p) return;
  const payload = getDragPayload(e);
  e.preventDefault();
  clearDropFeedback(false);
  endDrag();
  if (!payload) {
    const files = mediaFilesOf(e.dataTransfer);
    if (!files.length) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) M.toast('סוג הקובץ לא נתמך', 'warn'); return; }
    const at = trackAtY(contentYAt(e.clientY));
    let t = Math.round(timeAtClient(e.clientX) * fps()) / fps();
    M.toast(`מעלה ${files.length} קבצים…`);
    const media = await uploadFiles(files, (f, pr, m, err) => { if (err) M.toast(`העלאת "${f.name}" נכשלה: ${err.message}`, 'error'); });
    for (const m of media) {
      const r = O.insertPayloadOps(state.project, { kind: 'media', mediaId: m.id, mediaKind: m.kind, duration: m.duration, name: m.name }, { t, hoverTrackId: at.track ? at.track.id : null, zone: at.zone, magnetic: S.magnetic });
      if (r) { await commit(r.ops, r.summary, r.select); t = r.at + (m.kind === 'image' ? 3 : (m.duration || 3)); }
    }
    return;
  }
  const tg = dropTarget(e, payload);
  insertPayloadAt(payload, tg);
}

function insertPayloadAt(payload, tg) {
  const p = state.project;
  if (!p) return null;
  if (tg.mode === 'transition') {
    const tr = transitionById(payload.id);
    return commit(O.transitionOps(p, tg.aId, payload.id, payload.duration || (tr && tr.defaultDuration) || 0.5), `מעבר "${payload.name || payload.id}"`);
  }
  if (tg.mode === 'apply') {
    const r = O.applyPayloadOps(p, payload, tg.ids, { pointerT: tg.t });
    return r ? commit(r.ops, r.summary) : null;
  }
  if (tg.mode === 'create') {
    const r = O.insertPayloadOps(p, payload, { t: tg.t, hoverTrackId: tg.hoverTrackId, zone: tg.zone, magnetic: S.magnetic });
    if (!r) return null;
    const res = commit(r.ops, r.summary, r.select);
    showSettled(payload, r);
    return res;
  }
  if (payload.kind === 'anim' || payload.kind === 'caption') M.toast(payload.kind === 'anim' ? 'גררו את האנימציה אל קליפ' : 'גררו את סגנון הכתוביות אל קליפ כתוביות', 'warn');
  return null;
}

/**
 * New text with an "in" animation is invisible on its first frame — paused there, "add text" looks like it did
 * nothing. After a UI insert the playhead moves to where the text has fully appeared (only when it sits inside the
 * animation; never while playing).
 */
function showSettled(payload, r) {
  if (!payload || payload.kind !== 'text' || state.playing || !r) return;
  const ta = (payload.preset && payload.preset.textAnim) || payload.textAnim || null;
  if (!ta || !ta.in || ta.in === 'none') return;
  const inD = Math.max(0.05, Number(ta.inDuration) || 0.4);
  const dur = Number(payload.duration) || 3;
  const settle = r.at + Math.min(dur * 0.6, inD + 0.15);
  const ph = state.playhead || 0;
  if (ph < r.at - 1e-6 || ph >= settle) return;
  seek(Math.round(settle * fps()) / fps());
}

/**
 * Insert/apply a library payload programmatically (used by the library panel: "+" / double-click).
 * opts: { t?:number (default playhead), trackId?:string }
 * Applies to the selected clips when the payload is an "apply" kind (effect/filter/transition/anim/caption/lut)
 * and something compatible is selected; otherwise creates a clip at t.
 */
export function insertPayload(payload, opts = {}) {
  const p = state.project;
  if (!p) { M.toast('אין פרויקט פתוח', 'warn'); return null; }
  const t = opts.t != null ? opts.t : state.playhead;
  const selIds = [...sel()].filter((id) => p.clips[id]);
  if (O.APPLY_KINDS.has(payload.kind)) {
    const ids = selIds.filter((id) => O.canApplyTo(payload, p.clips[id]));
    if (payload.kind === 'transition') {
      const base = ids.length ? ids : Object.values(p.clips).filter((c) => c.type !== 'audio' && c.start <= t && clipEnd(c) >= t).map((c) => c.id);
      const r = O.applyPayloadOps(p, payload, base, { pointerT: t });
      if (!r) { M.toast('בחרו קליפ שצמוד לקליפ נוסף כדי להוסיף מעבר', 'warn'); return null; }
      return commit(r.ops, r.summary);
    }
    if (ids.length) { const r = O.applyPayloadOps(p, payload, ids, { pointerT: t }); return r ? commit(r.ops, r.summary) : null; }
    if (payload.kind === 'caption') {
      const caps = Object.values(p.clips).filter((c) => c.type === 'caption').map((c) => c.id);
      if (!caps.length) { M.toast('קודם צריך טקסט לכתוביות: בלשונית "כתוביות" — כתיבה ידנית, תמלול אוטומטי או ייבוא קובץ SRT. אפשר גם לבקש מ-Claude.', 'warn'); return null; }
      const r = O.applyPayloadOps(p, payload, caps);
      return r ? commit(r.ops, `${r.summary} לכל הכתוביות`) : null;
    }
    if (payload.kind === 'anim') { M.toast('בחרו קליפ כדי להחיל עליו את האנימציה', 'warn'); return null; }
  }
  const r = O.insertPayloadOps(p, payload, { t, hoverTrackId: opts.trackId || null, magnetic: S.magnetic });
  if (!r) return null;
  const res = commit(r.ops, r.summary, r.select);
  showSettled(payload, r);
  return res;
}

// ───────────────────────────── commands (also exported for main.js) ─────────────────────────────

export const commands = {
  split(ids) {
    const p = S.p; if (!p) return;
    const t = state.playhead;
    let list = ids || [...sel()];
    list = list.filter((id) => { const c = p.clips[id]; return c && c.start < t && clipEnd(c) > t; });
    if (!list.length) {
      const under = Object.values(p.clips).filter((c) => c.start < t && clipEnd(c) > t && !(U.trackById(p, c.trackId) || {}).locked);
      const mt = U.mainTrack(p);
      const onMain = under.filter((c) => mt && c.trackId === mt.id);
      list = (onMain.length ? onMain : under.sort((a, b) => U.trackIndex(p, a.trackId) - U.trackIndex(p, b.trackId)).slice(0, 1)).map((c) => c.id);
    }
    const ops = O.splitOps(p, list, t);
    if (!ops.length) { M.toast('אין קליפ לפיצול בסמן הניגון'); return; }
    commit(ops, ops.length > 1 ? `פיצול ${ops.length} קליפים` : `פיצול "${U.clipLabel(p, p.clips[ops[0].id])}"`);
  },
  del({ ids, ripple = false } = {}) {
    const p = S.p; if (!p) return;
    const list = (ids || [...sel()]).filter((id) => p.clips[id] && !(U.trackById(p, p.clips[id].trackId) || {}).locked);
    if (!list.length) return;
    const ops = O.deleteOps(p, list, { ripple, magnetic: S.magnetic });
    setSelection([]);
    commit(ops, `${ripple ? 'מחיקה וסגירת רווח' : 'מחיקת'} ${list.length > 1 ? `${list.length} קליפים` : `"${U.clipLabel(p, p.clips[list[0]])}"`}`);
  },
  rippleDelete() { commands.del({ ripple: true }); },
  copy(ids) {
    const p = S.p; if (!p) return false;
    const cb = O.makeClipboard(p, ids || [...sel()]);
    if (!cb) return false;
    S.clipboard = cb; savePrefs();
    return true;
  },
  cut(ids) { if (commands.copy(ids)) commands.del({ ids }); },
  paste(at) {
    const p = S.p; if (!p || !S.clipboard) return;
    const r = O.pasteOps(p, S.clipboard, at != null ? at : state.playhead, { magnetic: S.magnetic });
    if (!r.ops.length) { M.toast('אין מה להדביק (מדיה מפרויקט אחר?)', 'warn'); return; }
    commit(r.ops, r.select.length > 1 ? `הדבקת ${r.select.length} קליפים` : 'הדבקת קליף', r.select);
  },
  duplicate(ids) {
    const p = S.p; if (!p) return;
    const ops = O.duplicateOps(p, ids || [...sel()]);
    if (ops.length) commit(ops, 'שכפול', ops.filter((o) => o.op === 'duplicateClip').map((o) => o.newId));
  },
  selectAll() { if (S.p) setSelection(Object.values(S.p.clips).filter((c) => !(U.trackById(S.p, c.trackId) || {}).locked).map((c) => c.id)); },
  deselect() { setSelection([]); },
  addMarker(t) {
    if (!S.p) return;
    const at = Math.round((t != null ? t : state.playhead) * fps()) / fps();
    const n = (S.p.markers || []).length + 1;
    commit([{ op: 'addMarker', id: U.uid('m_'), t: at, label: `סמן ${n}`, color: U.MARKER_PALETTE[(n - 1) % U.MARKER_PALETTE.length] }], `הוספת סמן ב-${U.formatTimecode(at, fps())}`);
  },
  detachAudio(id) {
    const p = S.p; if (!p) return;
    const r = O.detachAudioOps(p, id || [...sel()][0]);
    if (!r) { M.toast('לקליפ הזה אין שמע להפרדה', 'warn'); return; }
    commit(r.ops, 'הפרדת שמע', r.select);
  },
  zoomIn() { setZoom(S.zoom * 1.35, null); },
  zoomOut() { setZoom(S.zoom / 1.35, null); },
  zoomFit() { fitZoom(); },
  setTool(tool) { state.set({ tool }); },
  toggleSnapping() { state.set({ snapping: !state.snapping }); },
  toggleMagnetic() { S.magnetic = !S.magnetic; savePrefs(); state.set({ magnetic: S.magnetic }, { source: 'timeline' }); updateToolbar(); },
  nudge(frames) {
    const p = S.p; if (!p) return;
    const ids = [...sel()].filter((id) => p.clips[id]);
    if (!ids.length) return;
    const dt = frames / fps();
    const minStart = Math.min(...ids.map((id) => p.clips[id].start));
    const d = Math.max(dt, -minStart);
    commit(ids.map((id) => ({ op: 'moveClip', id, start: Math.round((p.clips[id].start + d) * 1e6) / 1e6, overlap: 'allow' })), `הזזה ב-${frames} פריימים`);
  },
  jumpEdit(dir) {
    const p = S.p; if (!p) return;
    const t = state.playhead;
    const edges = [...new Set(Object.values(p.clips).flatMap((c) => [c.start, clipEnd(c)]))].sort((a, b) => a - b);
    const target = dir > 0 ? edges.find((x) => x > t + 1e-4) : [...edges].reverse().find((x) => x < t - 1e-4);
    if (target != null) seek(target);
  },
  scrollToTime(t) { S.sx = clampSx(t * S.zoom - S.vw * 0.3); invalidate(D_VIEW | D_PH); },
};

// ───────────────────────────── keyboard ─────────────────────────────

function onKeyDown(e) {
  if (e.defaultPrevented || !S.p) return;
  const tg = e.target;
  if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  let handled = true;
  if ((k === 'Delete' || k === 'Backspace') && !ctrl) commands.del({ ripple: e.shiftKey });
  else if (ctrl && (k === 'c' || k === 'C')) commands.copy();
  else if (ctrl && (k === 'x' || k === 'X')) commands.cut();
  else if (ctrl && (k === 'v' || k === 'V')) commands.paste();
  else if (ctrl && (k === 'd' || k === 'D')) commands.duplicate();
  else if (ctrl && (k === 'a' || k === 'A')) commands.selectAll();
  else if ((ctrl && (k === 'b' || k === 'B' || k === 'k' || k === 'K')) || (!ctrl && (k === 's' || k === 'S'))) commands.split();
  else if (!ctrl && (k === 'm' || k === 'M')) commands.addMarker();
  else if (!ctrl && (k === 'b' || k === 'B')) state.set({ tool: 'blade' });
  else if (!ctrl && (k === 'v' || k === 'V')) state.set({ tool: 'select' });
  else if (!ctrl && (k === 'n' || k === 'N')) commands.toggleSnapping();
  else if (!ctrl && (k === '+' || k === '=')) commands.zoomIn();
  else if (!ctrl && (k === '-' || k === '_')) commands.zoomOut();
  else if (!ctrl && k === '\\') commands.zoomFit();
  else if (k === 'Escape') { if (state.tool === 'blade') state.set({ tool: 'select' }); else commands.deselect(); }
  else if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) commands.nudge((k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
  else if (!ctrl && (k === 'ArrowUp' || k === 'ArrowDown')) commands.jumpEdit(k === 'ArrowDown' ? 1 : -1);
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

// ───────────────────────────── events wiring ─────────────────────────────

function wireEvents() {
  const E = S.els;
  E.view.addEventListener('pointerdown', onViewPointerDown);
  E.view.addEventListener('contextmenu', onContextMenu);
  E.view.addEventListener('pointermove', (e) => {
    updateBladeHover(e);
    if (!S.drag) {
      const at = trackAtY(contentYAt(e.clientY));
      const id = at.track ? at.track.id : null;
      if (id !== S.hoverLaneId) {
        if (S.hoverLaneId) { const l = S.laneEls.get(S.hoverLaneId); if (l) l.classList.remove('tl-lane-hover'); }
        S.hoverLaneId = id;
      }
      // transition badges of the hovered track become visible
      for (const { j, badge } of S.trEls || []) badge.classList.toggle('hot', j.track.id === id);
      E.over.classList.toggle('tl-lane-hover', !!id);
    }
  });
  E.view.addEventListener('pointerleave', () => { E.blade.style.display = 'none'; E.over.classList.remove('tl-lane-hover'); });
  E.view.addEventListener('dblclick', (e) => {
    const clipEl = e.target.closest('.tl-clip');
    if (!clipEl) return;
    const c = S.p && S.p.clips[clipEl.dataset.clipId];
    if (c) seek(clamp(timeAtClient(e.clientX), c.start, clipEnd(c) - frame()));
  });
  E.view.addEventListener('wheel', onWheel, { passive: false });
  E.ruler.addEventListener('wheel', onWheel, { passive: false });
  E.heads.addEventListener('wheel', onWheel, { passive: false });
  E.ruler.addEventListener('pointerdown', onRulerPointerDown);
  E.ruler.addEventListener('contextmenu', onRulerContext);
  E.ruler.addEventListener('dblclick', (e) => { const mk = e.target.closest('.tl-mk'); if (mk) { const m = (S.p.markers || []).find((x) => x.id === mk.dataset.markerId); if (m) renameMarker(m); } });
  E.phHead.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); e.stopPropagation(); startScrub(e); } });
  E.hs.addEventListener('pointerdown', onHsDown);
  E.vs.addEventListener('pointerdown', onVsDown);
  E.view.addEventListener('dragover', onDragOver);
  E.view.addEventListener('dragenter', (e) => { if (getDragPayload(e) || isFileDrag(e)) e.preventDefault(); });
  E.view.addEventListener('dragleave', onDragLeave);
  E.view.addEventListener('drop', onDrop);
  S.root.addEventListener('keydown', onKeyDown);
  window.addEventListener('dragend', () => clearDropFeedback(false));
}

/** For tests / integrator: the timeline root element and internal view state. */
export function _debug() { return { S, invalidate, flushNow: () => { cancelAnimationFrame(S.raf); S.raf = 0; S.dirty |= D_RENDER | D_LAYOUT | D_VIEW | D_PH | D_SEL; flush(); } }; }
export function getVisibleRange() { return { from: S.sx / S.zoom, to: (S.sx + S.vw) / S.zoom }; }
export function scrollToTime(t) { commands.scrollToTime(t); }
export { flashClips };
