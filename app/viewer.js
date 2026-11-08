// Frame Studio — app/viewer.js (owner: U)
// Preview canvas + transport. Compositor (R) + SourceProvider (R) + AudioEngine (A) + ensureFonts (T).
// Exports (SPEC §6): mount(el), play(), pause(), seek(t), togglePlay(), getCompositor()
// Extras used by main.js: shuttle(dir), stepFrames(n), stepSeconds(s), isPlaying(), currentTime(), getCanvas(), refresh()
import { state, on, applyOps } from './api.js';
import { h, iconBtn, clamp, store, menu, toast } from './ui-kit.js';
import { icon, hydrateIcons } from './ui-icons.js';
import * as M from './ui-model.js';

// ---------------------------------------------------------------- safe areas (px at 1080×1920)
const SAFE_AREAS = {
  reels: { label: 'ריילס', top: 250, bottom: 350, left: 80, right: 80, rightLow: 140, lowFrom: 0.5 },
  tiktok: { label: 'טיקטוק', top: 160, bottom: 420, left: 60, right: 60, rightLow: 160, lowFrom: 0.42 },
  youtube: { label: 'שורטס', top: 180, bottom: 380, left: 60, right: 60, rightLow: 150, lowFrom: 0.45 },
};
const SAFE_LABELS = { none: 'ללא', reels: 'ריילס', tiktok: 'טיקטוק', youtube: 'יוטיוב / שורטס' };

// ---------------------------------------------------------------- module state
const V = {
  el: null, stage: null, frame: null, canvas: null, fbCanvas: null, fbCtx: null, overlay: null,
  g: {}, tcCur: null, tcTot: null, playBtn: null, meterEls: null, notice: null, badge: null, shuttleBadge: null,
  compositor: null, sources: null, engine: null, ensureFonts: null, textMod: null,
  ready: false, fallback: false, renderErrors: 0,
  W: 1080, H: 1920, dispW: 0, dispH: 0, k: 1,
  dirty: true, overlayDirty: true, safeDirty: true,
  preview: null,            // project used for local drag preview (compositor only)
  drag: null, guides: [], hoverId: null, primaryId: null,
  flash: { ids: [], until: 0 },
  fontsKey: '', audioKey: '', audioLoad: null, audioTimer: null,
  fbBounds: new Map(),
  exactBusy: false, exactWanted: null, exactTimer: null,
  peak: { l: -90, r: -90, hl: -90, hr: -90, holdL: 0, holdR: 0 },
  lastTc: '', lastPlayIcon: null,
};
const clock = { mode: 'none', t0: 0, w0: 0, rate: 1 };
let shuttleRate = 0;

const fpsOf = () => state.project?.settings?.fps || 30;
const durOf = () => M.projectDuration(state.project);
const curProject = () => V.preview || state.project;

// ---------------------------------------------------------------- mount
export function mount(el) {
  V.el = el;
  el.classList.add('viewer-host');
  el.innerHTML = '';
  const head = h('div.vw-head',
    h('div.ph-title', { html: `${icon('video', 14)}<span>נגן</span>` }),
    h('div.ph-spacer'),
    V.notice = h('span.vw-badge.warn', { hidden: true }, ''),
  );
  V.badge = h('span.vw-badge', ''); // size · fps (kept detached: the project settings show it)
  V.stage = h('div.vw-stage');
  V.frame = h('div.vw-frame');
  V.canvas = h('canvas.vw-canvas', { width: 540, height: 960 });
  V.fbCanvas = h('canvas.vw-fallback', { width: 540, height: 960, hidden: true });
  V.overlay = svg('svg', { class: 'vw-overlay', viewBox: '0 0 1080 1920', preserveAspectRatio: 'none' });
  for (const name of ['safe', 'thirds', 'flash', 'hover', 'sel', 'guides']) { V.g[name] = svg('g', { class: `g-${name}` }); V.overlay.appendChild(V.g[name]); }
  V.frame.append(V.canvas, V.fbCanvas, V.overlay);
  V.empty = h('div.vw-empty', { hidden: true, html: `${icon('film', 30)}<div></div>` });
  V.emptyText = V.empty.querySelector('div');
  V.stage.append(V.frame, V.empty, h('div.vw-drop'));
  const transport = buildTransport();
  el.append(h('div.viewer', head, V.stage, transport));
  hydrateIcons(el);

  new ResizeObserver(() => { layout(); }).observe(V.stage);
  bindPointer();
  bindDrop();

  on('project', (p, keys, d) => onProject(p, d));
  on('playhead', (t, keys, d) => {
    if (d.source === 'viewer') return;
    if (state.playing) restartClockAt(t);
    else { V.dirty = true; scheduleExact(); }
    V.overlayDirty = true;
  });
  on('selection', () => { V.overlayDirty = true; const sel = [...state.selection]; if (!sel.includes(V.primaryId)) V.primaryId = sel[sel.length - 1] || null; });
  on('previewScale', () => { applyScale(); });
  on(['thirds', 'range', 'loop'], () => { V.overlayDirty = true; syncTransportToggles(); });
  on('playing', () => updatePlayButton());
  // Claude's edits: the timeline flashes the changed clips once — the player stays calm (no second flash here)
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));

  initEngines();
  requestAnimationFrame(loop);
  onProject(state.project, { source: 'mount' });
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ---------------------------------------------------------------- transport bar
function buildTransport() {
  const tc = h('div.timecode', { title: 'דקות:שניות — והפריים בקטן' }, V.tcCur = h('span.tc-cur', { html: M.tcHtml(0) }), h('span.tc-sep', '/'), V.tcTot = h('span.tc-tot', { html: M.tcHtml(0) }));
  V.shuttleBadge = h('span.shuttle-badge', '');
  V.playBtn = iconBtn('play', 'ניגון / השהיה (רווח)', () => togglePlay(), { cls: 'tp-play', size: 18 });
  V.loopBtn = iconBtn('loop', 'ניגון בלולאה (בטווח I/O אם הוגדר)', () => state.set({ loop: !state.loop }));
  V.thirdsBtn = iconBtn('grid', 'רשת שלישים', () => state.set({ thirds: !state.thirds }));
  V.safeBtn = iconBtn('safe', 'אזור בטוח לרשתות', (e) => openSafeMenu(e.currentTarget));
  V.qualitySel = h('select.select.tp-select', { title: 'איכות תצוגה מקדימה', on: { change: (e) => state.set({ previewScale: Number(e.target.value) }) } },
    h('option', { value: '0.25' }, 'תצוגה 25%'), h('option', { value: '0.5' }, 'תצוגה 50%'), h('option', { value: '1' }, 'תצוגה 100%'));
  V.qualitySel.value = String(state.previewScale);
  const meters = h('div.meters', { title: 'עוצמת שמע (dBFS)' });
  const mk = () => { const m = h('div.meter'); const lvl = h('div.lvl'); const pk = h('div.pk'); m.append(lvl, pk); meters.appendChild(m); return { lvl, pk }; };
  const ml = mk(); const mr = mk();
  V.meterDb = h('span.meter-db', '-∞');
  V.meterEls = { ml, mr };
  const left = h('div.tp-left', tc, V.shuttleBadge);
  const center = h('div.tp-center',
    iconBtn('toStart', 'להתחלה (Home)', () => seek(0)),
    iconBtn('stepBack', 'פריים אחורה (←)', () => stepFrames(-1)),
    V.playBtn,
    iconBtn('stepFwd', 'פריים קדימה (→)', () => stepFrames(1)),
    iconBtn('toEnd', 'לסוף (End)', () => seek(durOf())),
    V.loopBtn,
  );
  const right = h('div.tp-right', meters, V.meterDb, V.safeBtn, V.thirdsBtn, V.qualitySel,
    iconBtn('fullscreen', 'מסך מלא', () => toggleFullscreen()));
  syncTransportToggles();
  return h('div.transport', left, center, right);
}

function syncTransportToggles() {
  if (!V.loopBtn) return;
  V.loopBtn.classList.toggle('on', !!state.loop);
  V.thirdsBtn.classList.toggle('on', !!state.thirds);
  const sa = state.project?.settings?.safeArea || 'none';
  V.safeBtn.classList.toggle('on', sa !== 'none');
  if (V.qualitySel && V.qualitySel.value !== String(state.previewScale)) V.qualitySel.value = String(state.previewScale);
}

function openSafeMenu(anchor) {
  const cur = state.project?.settings?.safeArea || 'none';
  menu(anchor, [
    { header: 'אזור בטוח' },
    ...Object.entries(SAFE_LABELS).map(([id, label]) => ({
      label, checked: cur === id,
      onClick: () => applyOps([{ op: 'setSettings', set: { safeArea: id } }], `אזור בטוח: ${label}`),
    })),
  ]);
}

function toggleFullscreen() {
  const target = V.el;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else target.requestFullscreen?.().catch(() => toast('לא ניתן לעבור למסך מלא', { type: 'warn' }));
}

function updatePlayButton() {
  const playing = !!state.playing;
  if (V.lastPlayIcon === playing) return;
  V.lastPlayIcon = playing;
  V.playBtn.innerHTML = icon(playing ? 'pause' : 'play', 18);
  V.playBtn.title = playing ? 'השהיה (רווח)' : 'ניגון (רווח)';
}

// ---------------------------------------------------------------- engines
async function initEngines() {
  const [c, s, a, t] = await Promise.allSettled([
    import('../render/compositor.js'), import('../render/sources.js'), import('../render/audio-engine.js'), import('../render/text-render.js'),
  ]);
  const projectId = state.projectId;
  if (t.status === 'fulfilled') { V.textMod = t.value; V.ensureFonts = t.value.ensureFonts || null; }
  else console.warn('[viewer] text-render.js לא נטען', t.reason);
  if (s.status === 'fulfilled' && s.value.SourceProvider) {
    try { V.sources = new s.value.SourceProvider({ mode: 'preview', projectId, apiBase: '' }); } catch (e) { console.error('[viewer] SourceProvider נכשל', e); }
  } else console.warn('[viewer] sources.js לא נטען', s.reason);
  if (c.status === 'fulfilled' && c.value.Compositor) {
    try { V.compositor = new c.value.Compositor(V.canvas, { mode: 'preview', scale: state.previewScale }); }
    catch (e) { console.error('[viewer] Compositor נכשל', e); V.compositor = null; }
  } else console.warn('[viewer] compositor.js לא נטען', c.reason);
  if (a.status === 'fulfilled' && a.value.AudioEngine) {
    try { V.engine = new a.value.AudioEngine({ projectId, apiBase: '' }); } catch (e) { console.error('[viewer] AudioEngine נכשל', e); }
  } else console.warn('[viewer] audio-engine.js לא נטען', a.reason);

  V.fallback = !V.compositor;
  V.canvas.hidden = V.fallback;
  V.fbCanvas.hidden = !V.fallback;
  if (V.fallback) {
    V.fbCtx = V.fbCanvas.getContext('2d');
    setNotice('תצוגה בסיסית — מנוע WebGL לא זמין');
  }
  if (!V.engine) setNotice((V.fallback ? 'תצוגה בסיסית · ' : '') + 'ללא שמע — מנוע האודיו לא נטען');
  V.ready = true;
  V.fontsKey = ''; V.audioKey = '';
  onProject(state.project, { source: 'engines' });
  applyScale();
}

function setNotice(text) {
  if (!V.notice) return;
  V.notice.hidden = !text;
  V.notice.textContent = text || '';
}

export function getCompositor() { return V.compositor; }
/** canvas-px bounds {cx,cy,w,h,rotation,corners} of a clip at time t (compositor or 2D fallback) */
export function getClipBounds(id, t = state.playhead) { return boundsOf(id, t); }
export function canvasSize() { return { width: V.W, height: V.H }; }
export function getCanvas() { return V.fallback ? V.fbCanvas : V.canvas; }
export function getAudioEngine() { return V.engine; }
export function getSources() { return V.sources; }

// ---------------------------------------------------------------- project changes
function onProject(p, detail = {}) {
  if (!p) { V.empty.hidden = true; return; }
  const s = p.settings || {};
  const sizeChanged = s.width !== V.W || s.height !== V.H;
  V.W = s.width || 1080; V.H = s.height || 1920;
  if (sizeChanged) { layout(); applyScale(); }
  V.badge.textContent = `${V.W}×${V.H} · ${s.fps || 30}fps`;
  V.empty.hidden = Object.keys(p.clips || {}).length > 0;
  if (!V.empty.hidden) syncEmptyHint(p);
  V.tcTot.innerHTML = M.tcHtml(Object.keys(p.clips || {}).length ? durOf() : 0, fpsOf());
  if (!V.ready) return;
  if (!V.drag) V.preview = null;
  const target = V.preview || p;
  try { V.compositor?.setProject(target); } catch (e) { console.error('[viewer] setProject', e); }
  try { V.sources?.setProject(target); } catch (e) { console.error('[viewer] sources.setProject', e); }
  const audioKey = audioSignature(p);
  if (V.engine) {
    try { V.engine.setProject(p); } catch (e) { console.error('[viewer] engine.setProject', e); }
    if (audioKey !== V.audioKey) {
      const first = !V.audioKey;
      V.audioKey = audioKey;
      clearTimeout(V.audioTimer);
      V.audioTimer = setTimeout(() => loadAudio(), first ? 0 : 350);
    }
  }
  const fk = fontsSignature(p);
  if (fk !== V.fontsKey && V.ensureFonts) {
    V.fontsKey = fk;
    Promise.resolve().then(() => V.ensureFonts(p)).then(() => { V.dirty = true; scheduleExact(); }).catch((e) => console.warn('[viewer] ensureFonts', e));
  }
  V.safeDirty = true; V.overlayDirty = true; V.dirty = true;
  syncTransportToggles();
  if (!state.playing) scheduleExact();
}

/** empty timeline: tell the novice the NEXT step — import first, or (once media is in) put it on the timeline */
function syncEmptyHint(p) {
  if (!V.emptyText) return;
  const media = Object.values(p.media || {}).filter((m) => m.status !== 'error');
  const noun = !media.length ? '' : media.some((m) => m.kind === 'video') ? 'הסרטון' : media.some((m) => m.kind === 'image') ? 'התמונה' : 'הקובץ';
  if (V.emptyText.dataset.k === noun) return;
  V.emptyText.dataset.k = noun;
  V.emptyText.innerHTML = noun
    ? `השלב הבא: <b>גררו את ${noun} לציר הזמן</b><br>(או לחיצה כפולה ${noun === 'התמונה' ? 'עליה' : 'עליו'} בלשונית מדיה).`
    : 'הפרויקט ריק.<br>ייבאו סרטון בלשונית מדיה (או גררו קובץ לכאן), או בקשו מ-Claude.';
}

function loadAudio() {
  if (!V.engine?.load) return;
  const wasPlaying = state.playing && clock.mode === 'audio';
  V.audioLoad = Promise.resolve().then(() => V.engine.load()).catch((e) => { console.warn('[viewer] טעינת שמע נכשלה', e); });
  V.audioLoad.then(() => {
    // audio graph changed while playing → reschedule from the current position
    if (wasPlaying && state.playing && clock.mode === 'audio') restartClockAt(currentTime());
  });
}

function audioSignature(p) {
  const parts = [];
  for (const t of p.tracks || []) parts.push([t.id, t.kind, t.role, t.muted, t.solo, t.volume, t.hidden].join(':'));
  for (const c of Object.values(p.clips || {})) {
    if (c.type !== 'audio' && c.type !== 'video') continue;
    parts.push(JSON.stringify([c.id, c.trackId, c.mediaId, c.start, c.duration, c.in, c.speed, c.reverse, c.volume, c.fadeIn, c.fadeOut, c.pan, c.muteAudio, c.disabled, c.audioFx, c.keyframes?.volume]));
  }
  for (const m of Object.values(p.media || {})) parts.push(`${m.id}:${m.status}:${m.audio || ''}`);
  parts.push(String(p.settings?.masterGainDb ?? 0));
  return parts.join('|');
}

function fontsSignature(p) {
  const set = new Set();
  for (const c of Object.values(p.clips || {})) if (c.text && (c.type === 'text' || c.type === 'caption')) set.add(`${c.text.font}:${c.text.weight}:${c.text.italic ? 1 : 0}`);
  return [...set].sort().join('|');
}

// ---------------------------------------------------------------- layout & scale
function layout() {
  if (!V.stage) return;
  const r = V.stage.getBoundingClientRect();
  const pad = document.fullscreenElement ? 0 : 18;
  const aw = Math.max(10, r.width - pad * 2); const ah = Math.max(10, r.height - pad * 2);
  const s = Math.min(aw / V.W, ah / V.H);
  V.dispW = Math.max(1, Math.floor(V.W * s)); V.dispH = Math.max(1, Math.floor(V.H * s));
  V.k = V.W / V.dispW;
  Object.assign(V.frame.style, { width: `${V.dispW}px`, height: `${V.dispH}px`, left: `${Math.round((r.width - V.dispW) / 2)}px`, top: `${Math.round((r.height - V.dispH) / 2)}px` });
  V.overlay.setAttribute('viewBox', `0 0 ${V.W} ${V.H}`);
  V.safeDirty = true; V.overlayDirty = true; V.dirty = true;
  // the empty-project hint wraps inside the frame, however small the preview is
  const hint = V.empty && V.empty.querySelector('div');
  if (hint) hint.style.maxWidth = `${Math.max(140, Math.min(260, V.dispW - 20))}px`;
  // narrow player (small laptop screens): the preview-quality menu shows just "50%" (its tooltip says what it is)
  if (V.qualitySel) {
    const narrow = r.width < 560;
    if (V.qualitySel.dataset.narrow !== String(narrow)) {
      V.qualitySel.dataset.narrow = String(narrow);
      for (const o of V.qualitySel.options) o.textContent = `${narrow ? '' : 'תצוגה '}${Math.round(Number(o.value) * 100)}%`;
    }
  }
}

function applyScale() {
  const scale = state.previewScale || 0.5;
  const w = Math.max(2, Math.round(V.W * scale)); const h2 = Math.max(2, Math.round(V.H * scale));
  for (const c of [V.canvas, V.fbCanvas]) if (c && (c.width !== w || c.height !== h2)) { c.width = w; c.height = h2; }
  try { V.compositor?.setScale(scale); } catch (e) { console.error('[viewer] setScale', e); }
  syncTransportToggles();
  V.dirty = true;
  if (!state.playing) scheduleExact();
}

// ---------------------------------------------------------------- clock / transport API
function validRange() {
  const r = state.range;
  if (!r || r.in == null || r.out == null || r.out - r.in < 1 / fpsOf()) return null;
  return r;
}

export function currentTime() {
  if (!state.playing) return state.playhead;
  if (clock.mode === 'audio' && V.engine) { const t = Number(V.engine.currentTime); if (Number.isFinite(t)) return t; }
  return clock.t0 + ((performance.now() - clock.w0) / 1000) * clock.rate;
}
export function isPlaying() { return !!state.playing; }

function startClock(t, rate) {
  clock.t0 = t; clock.w0 = performance.now(); clock.rate = rate;
  clock.mode = 'wall';
  try { V.engine?.pause(); } catch { /* ignore */ }
  if (rate === 1 && V.engine) {
    try { V.engine.play(t); clock.mode = 'audio'; } catch (e) { console.warn('[viewer] engine.play נכשל', e); clock.mode = 'wall'; }
  }
  try {
    if (rate > 0) V.sources?.startPlayback?.(t, state.project);
    else V.sources?.stopPlayback?.();
  } catch (e) { console.warn('[viewer] startPlayback', e); }
}

function restartClockAt(t) {
  const rate = shuttleRate || 1;
  startClock(clamp(t, 0, durOf()), rate);
}

export function play() {
  if (!state.project) return;
  if (state.playing && shuttleRate === 1) return;
  const fps = fpsOf(); const dur = durOf();
  let t = state.playing ? currentTime() : state.playhead;
  const r = validRange();
  if (state.loop && r && (t < r.in || t >= r.out - 0.5 / fps)) t = r.in;
  else if (t >= dur - 0.5 / fps) t = 0;
  shuttleRate = 1;
  startClock(t, 1);
  V.shuttleBadge.textContent = '';
  state.set({ playing: true, playhead: t }, { source: 'viewer' });
  updatePlayButton();
}

export function pause() {
  if (!state.playing) return;
  const t = currentTime();
  try { V.engine?.pause(); } catch { /* ignore */ }
  try { V.sources?.stopPlayback?.(); } catch { /* ignore */ }
  clock.mode = 'none'; shuttleRate = 0;
  V.shuttleBadge.textContent = '';
  const fps = fpsOf();
  state.set({ playing: false, playhead: clamp(M.snapToFrame(t, fps), 0, durOf()) }, { source: 'viewer' });
  updatePlayButton();
  decayMeters(true);
  V.dirty = true; V.overlayDirty = true;
  scheduleExact();
}

export function togglePlay() { if (state.playing) pause(); else play(); }

export function seek(t) {
  if (!state.project) return;
  const tt = clamp(Number(t) || 0, 0, durOf());
  if (state.playing) restartClockAt(tt);
  state.set({ playhead: tt }, { source: 'viewer' });
  try { if (!state.playing) V.engine?.seek?.(tt); } catch { /* ignore */ }
  V.dirty = true; V.overlayDirty = true;
  if (!state.playing) scheduleExact();
}

export function stepFrames(n) {
  if (state.playing) pause();
  const fps = fpsOf();
  const f = Math.round(state.playhead * fps) + n;
  seek(f / fps);
}
export function stepSeconds(s) {
  if (state.playing) pause();
  seek(M.snapToFrame(state.playhead + s, fpsOf()));
}

/** J/K/L shuttle: dir +1 = L (faster forward), -1 = J (faster backward), 0 = K (stop) */
export function shuttle(dir) {
  if (!state.project) return;
  if (dir === 0) { pause(); return; }
  let rate;
  if (dir > 0) rate = shuttleRate <= 0 ? 1 : Math.min(shuttleRate * 2, 8);
  else rate = shuttleRate >= 0 ? -1 : Math.max(shuttleRate * 2, -8);
  const t = state.playing ? currentTime() : state.playhead;
  shuttleRate = rate;
  startClock(t, rate);
  V.shuttleBadge.textContent = rate === 1 ? '' : `${rate > 0 ? '▶' : '◀'} ${Math.abs(rate)}×`;
  state.set({ playing: true, playhead: t }, { source: 'viewer' });
  updatePlayButton();
}

// ---------------------------------------------------------------- render loop
function loop() {
  requestAnimationFrame(loop);
  if (!state.project) return;
  if (state.playing) {
    let t = currentTime();
    const dur = durOf(); const r = validRange();
    if (shuttleRate >= 0) {
      if (state.loop && r && t >= r.out) { t = r.in; restartClockAt(t); }
      else if (t >= dur) {
        if (state.loop && !r) { t = 0; restartClockAt(0); }
        else { state.set({ playhead: dur }, { source: 'viewer' }); pause(); return; }
      }
    } else {
      const lo = state.loop && r ? r.in : 0;
      if (t <= lo) { state.set({ playhead: lo }, { source: 'viewer' }); pause(); return; }
    }
    state.set({ playhead: t }, { source: 'viewer' });
    try { V.sources?.tick?.(t); } catch { /* ignore */ }
    renderSync(t);
    if (shuttleRate < 0) scheduleExact(true);
    updateMeters();
    V.overlayDirty = true;
  } else if (V.dirty) {
    V.dirty = false;
    renderSync(state.playhead);
  }
  updateTimecode();
  if (!state.playing) decayMeters(false);
  if (V.flash.until && performance.now() < V.flash.until) V.overlayDirty = true;
  if (V.safeDirty) renderSafe();
  if (V.overlayDirty) { V.overlayDirty = false; renderOverlay(); }
}

function renderSync(t) {
  if (!V.ready) return;
  if (V.fallback) { fallbackRender(t); return; }
  try { V.compositor.renderFrameSync(t, V.sources); V.renderErrors = 0; }
  catch (e) { if (V.renderErrors++ < 3) console.error('[viewer] renderFrameSync', e); }
}

/** crisp still when paused: await exact source frames (latest request wins) */
function scheduleExact(immediate = false) {
  V.exactWanted = state.playing ? currentTime() : state.playhead;
  clearTimeout(V.exactTimer);
  V.exactTimer = setTimeout(runExact, immediate ? 0 : 45);
}
async function runExact() {
  if (V.exactBusy || !V.ready) return;
  V.exactBusy = true;
  try {
    while (V.exactWanted != null) {
      const t = V.exactWanted; V.exactWanted = null;
      if (state.playing && shuttleRate >= 0) break;
      if (V.fallback) { await prefetchExact(t); fallbackRender(t); continue; }
      try {
        if (typeof V.compositor.renderFrame === 'function') await V.compositor.renderFrame(t, V.sources);
        else { await prefetchExact(t); V.compositor.renderFrameSync(t, V.sources); }
      } catch (e) {
        if (V.renderErrors++ < 3) console.warn('[viewer] renderFrame', e);
        try { await prefetchExact(t); V.compositor.renderFrameSync(t, V.sources); } catch { /* ignore */ }
      }
      // a newer scrub position may have been requested while we awaited
      const now = state.playing ? null : state.playhead;
      if (now != null && Math.abs(now - t) > 1e-6 && V.exactWanted == null) V.exactWanted = now;
    }
  } finally { V.exactBusy = false; }
}
async function prefetchExact(t) {
  const p = curProject(); if (!p || !V.sources?.getExact) return;
  const jobs = [];
  for (const c of M.activeClipsAt(p, t)) {
    if (c.type !== 'video' && c.type !== 'image') continue;
    const m = p.media?.[c.mediaId];
    jobs.push(Promise.resolve().then(() => V.sources.getExact(c, M.sourceTimeAt(c, t, m))).catch(() => null));
  }
  await Promise.all(jobs);
}

/** force a redraw (used after external changes) */
export function refresh() { V.dirty = true; V.overlayDirty = true; if (!state.playing) scheduleExact(); }

// ---------------------------------------------------------------- timecode & meters
function updateTimecode() {
  const t = state.playing ? currentTime() : state.playhead;
  const s = M.tcHtml(t, fpsOf());
  if (s !== V.lastTc) { V.lastTc = s; V.tcCur.innerHTML = s; }
}

function dbToFrac(db) { return clamp((db + 60) / 60, 0, 1); }
function updateMeters() {
  if (!V.engine?.getMeters) return;
  let m;
  try { m = V.engine.getMeters(); } catch { return; }
  if (!m) return;
  const now = performance.now();
  const P = V.peak;
  const l = Number.isFinite(m.l) ? m.l : -90; const r = Number.isFinite(m.r) ? m.r : -90;
  P.l = Math.max(l, P.l - 1.2); P.r = Math.max(r, P.r - 1.2);
  if (l >= P.hl || now - P.holdL > 1200) { P.hl = l; P.holdL = now; }
  if (r >= P.hr || now - P.holdR > 1200) { P.hr = r; P.holdR = now; }
  drawMeters();
}
function decayMeters(reset) {
  const P = V.peak;
  if (reset) { P.hl = -90; P.hr = -90; }
  if (P.l <= -89 && P.r <= -89) return;
  P.l = Math.max(-90, P.l - 2); P.r = Math.max(-90, P.r - 2);
  P.hl = Math.max(-90, P.hl - 1.5); P.hr = Math.max(-90, P.hr - 1.5);
  drawMeters();
}
function drawMeters() {
  const P = V.peak; const { ml, mr } = V.meterEls;
  ml.lvl.style.height = `${dbToFrac(P.l) * 100}%`; mr.lvl.style.height = `${dbToFrac(P.r) * 100}%`;
  ml.pk.style.bottom = `${dbToFrac(P.hl) * 100}%`; mr.pk.style.bottom = `${dbToFrac(P.hr) * 100}%`;
  const top = Math.max(P.hl, P.hr);
  V.meterDb.textContent = top <= -60 ? '-∞' : top.toFixed(1);
  V.meterDb.classList.toggle('clip', top > -0.5);
}

// ---------------------------------------------------------------- bounds / hit test
function boundsOf(id, t = state.playhead) {
  if (V.fallback) return V.fbBounds.get(id) || null;
  if (!V.compositor?.clipBounds) return null;
  try { const b = V.compositor.clipBounds(t, id); return b && b.corners ? b : null; } catch { return null; }
}
function hitTestAt(x, y, t = state.playhead) {
  if (V.fallback) {
    const order = [...V.fbBounds.keys()].reverse(); // drawn last = on top
    for (const id of order) { const b = V.fbBounds.get(id); if (b && pointInQuad(x, y, b.corners)) return id; }
    return null;
  }
  if (!V.compositor?.hitTest) return null;
  try { return V.compositor.hitTest(t, x, y) || null; } catch { return null; }
}
function pointInQuad(x, y, q) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]; const [xj, yj] = q[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)) inside = !inside;
  }
  return inside;
}
function toCanvas(e) {
  const r = V.frame.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * V.W, y: ((e.clientY - r.top) / r.height) * V.H };
}

// ---------------------------------------------------------------- overlay rendering
function renderSafe() {
  V.safeDirty = false;
  const g = V.g.safe; g.innerHTML = '';
  const id = state.project?.settings?.safeArea || 'none';
  const W = V.W; const H = V.H;
  if (id === 'none' || !state.project) return;
  const portrait = H > W * 1.2;
  let path;
  if (portrait && SAFE_AREAS[id]) {
    const a = SAFE_AREAS[id]; const sx = W / 1080; const sy = H / 1920;
    const x0 = a.left * sx; const y0 = a.top * sy; const x1 = W - a.right * sx; const y1 = H - a.bottom * sy;
    const xr = W - a.rightLow * sx; const ys = H * a.lowFrom;
    path = `M${x0} ${y0}H${x1}V${ys}H${xr}V${y1}H${x0}Z`;
    g.appendChild(svg('path', { class: 'safe-shade', d: `M0 0H${W}V${H}H0Z ${path}`, 'fill-rule': 'evenodd' }));
    g.appendChild(svg('path', { class: 'safe-line', d: path }));
    // the label must fit inside the safe box at the current preview size (a small 9:16 preview is ~150 px wide)
    const room = (x1 - x0) / V.k - 12;
    const text = [`אזור בטוח · ${a.label}`, a.label].find((s) => s.length * 6 <= room);
    if (text) {
      const label = svg('text', { class: 'safe-label', x: x1 - 6 * V.k, y: y0 + 15 * V.k, 'text-anchor': 'start', direction: 'rtl', style: `font-size:${Math.round(10.5 * V.k)}px;direction:rtl` });
      label.textContent = text;
      g.appendChild(label);
    }
  } else {
    // landscape / square: action-safe 95% + title-safe 90%
    for (const [f, dash] of [[0.05, ''], [0.1, '3 5']]) {
      const r = svg('rect', { class: 'safe-line', x: (W * f) / 2, y: (H * f) / 2, width: W * (1 - f), height: H * (1 - f) });
      if (dash) r.setAttribute('stroke-dasharray', dash);
      g.appendChild(r);
    }
    const room = (W * 0.9) / V.k - 12;
    const text = ['אזור בטוח לפעולה / לכותרות', 'אזור בטוח'].find((s) => s.length * 6 <= room);
    if (text) {
      const label = svg('text', { class: 'safe-label', x: W * 0.95 - 6 * V.k, y: H * 0.05 + 15 * V.k, 'text-anchor': 'start', direction: 'rtl', style: `font-size:${Math.round(10.5 * V.k)}px;direction:rtl` });
      label.textContent = text;
      g.appendChild(label);
    }
  }
}

function polyPoints(corners) { return corners.map((c) => `${c[0]},${c[1]}`).join(' '); }

function renderOverlay() {
  const t = state.playing ? currentTime() : state.playhead;
  const k = V.k; const W = V.W; const H = V.H;
  // thirds
  const gt = V.g.thirds; gt.innerHTML = '';
  if (state.thirds) {
    for (const x of [W / 3, (2 * W) / 3]) gt.appendChild(svg('line', { class: 'thirds', x1: x, y1: 0, x2: x, y2: H }));
    for (const y of [H / 3, (2 * H) / 3]) gt.appendChild(svg('line', { class: 'thirds', x1: 0, y1: y, x2: W, y2: y }));
  }
  // flash (clips changed by Claude)
  const gf = V.g.flash; gf.innerHTML = '';
  const now = performance.now();
  if (V.flash.until > now) {
    const a = clamp((V.flash.until - now) / 1500, 0, 1);
    for (const id of V.flash.ids) {
      const b = boundsOf(id, t); if (!b) continue;
      gf.appendChild(svg('polygon', { class: 'flash-box', points: polyPoints(b.corners), opacity: a.toFixed(3) }));
    }
  }
  // hover
  const gh = V.g.hover; gh.innerHTML = '';
  if (V.hoverId && !state.selection.has(V.hoverId) && !V.drag && !state.playing) {
    const b = boundsOf(V.hoverId, t);
    if (b) gh.appendChild(svg('polygon', { class: 'hover-box', points: polyPoints(b.corners) }));
  }
  // selection + handles
  const gs = V.g.sel; gs.innerHTML = '';
  const p = curProject();
  const primary = pickPrimary(t);
  for (const id of state.selection) {
    const c = p?.clips?.[id]; if (!c || !M.VISUAL_TYPES.has(c.type)) continue;
    if (!(c.start <= t && t < M.clipEnd(c))) continue;
    const b = boundsOf(id, t); if (!b) continue;
    gs.appendChild(svg('polygon', { class: 'sel-box' + (id === primary ? '' : ' secondary'), points: polyPoints(b.corners) }));
    if (id !== primary || state.playing) continue;
    const locked = isLocked(c);
    if (locked) continue;
    const hs = 5.5 * k;
    const names = ['nw', 'ne', 'se', 'sw'];
    b.corners.forEach((pt, i) => {
      gs.appendChild(svg('rect', { class: `handle h-${names[i]}`, 'data-h': `scale-${names[i]}`, x: pt[0] - hs, y: pt[1] - hs, width: hs * 2, height: hs * 2, rx: 1.5 * k }));
    });
    // rotate handle above top edge
    const [a0, a1] = [b.corners[0], b.corners[1]];
    const mx = (a0[0] + a1[0]) / 2; const my = (a0[1] + a1[1]) / 2;
    let dx = mx - b.cx; let dy = my - b.cy; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const rx = mx + dx * 34 * k; const ry = my + dy * 34 * k;
    gs.appendChild(svg('line', { class: 'rot-line', x1: mx, y1: my, x2: rx, y2: ry }));
    gs.appendChild(svg('circle', { class: 'rot-handle', 'data-h': 'rotate', cx: rx, cy: ry, r: 6 * k }));
    if (V.drag && V.drag.kind !== 'move') {
      const lbl = svg('text', { class: 'dim-label', x: b.cx, y: b.cy, 'text-anchor': 'middle', style: `font-size:${Math.round(13 * k)}px` });
      lbl.textContent = V.drag.label || '';
      gs.appendChild(lbl);
    }
  }
  // guides
  const gg = V.g.guides; gg.innerHTML = '';
  for (const gd of V.guides) {
    if (gd.x != null) gg.appendChild(svg('line', { class: 'guide', x1: gd.x, y1: 0, x2: gd.x, y2: H }));
    if (gd.y != null) gg.appendChild(svg('line', { class: 'guide', x1: 0, y1: gd.y, x2: W, y2: gd.y }));
  }
  V.overlay.classList.toggle('tool-move', !!V.hoverId && !state.playing);
}

function pickPrimary(t) {
  const p = curProject(); if (!p) return null;
  const ok = (id) => { const c = p.clips?.[id]; return c && M.VISUAL_TYPES.has(c.type) && c.start <= t && t < M.clipEnd(c); };
  if (V.primaryId && state.selection.has(V.primaryId) && ok(V.primaryId)) return V.primaryId;
  const sel = [...state.selection].reverse();
  return sel.find(ok) || null;
}

function isLocked(c) { const tr = M.trackOf(state.project, c); return !!tr?.locked; }

// ---------------------------------------------------------------- value helpers (keyframe aware)
const DEF = { 'transform.x': 0, 'transform.y': 0, 'transform.scale': 1, 'transform.scaleX': 1, 'transform.scaleY': 1, 'transform.rotation': 0, 'transform.opacity': 1 };
function baseValue(c, prop) { const v = M.getPath(c, prop); return Number.isFinite(v) ? v : (DEF[prop] ?? 0); }
function valueAt(c, prop, t) {
  const base = baseValue(c, prop);
  if (c.keyframes?.[prop]?.length) return M.evalKeyframed(c, prop, clamp(t - c.start, 0, c.duration), base);
  return base;
}
const hasKf = (c, prop) => !!c.keyframes?.[prop]?.length;

/** ops that set props at time t (setKeyframe for keyframed props, updateClip otherwise) */
function propOps(c, values, t) {
  const ops = []; const set = {};
  const lt = clamp(M.snapToFrame(t - c.start, fpsOf()), 0, c.duration);
  for (const [prop, v] of Object.entries(values)) {
    if (hasKf(c, prop)) ops.push({ op: 'setKeyframe', id: c.id, prop, t: lt, v });
    else set[prop] = v;
  }
  if (Object.keys(set).length) ops.unshift({ op: 'updateClip', id: c.id, set });
  return ops;
}

/** fast local preview without ops.js: patch transform props (and keyframes at t) */
function patchPreview(base, entries, t) {
  let p = { ...base, clips: { ...base.clips } };
  for (const { id, values } of entries) {
    let c = p.clips[id]; if (!c) continue;
    const lt = clamp(M.snapToFrame(t - c.start, fpsOf()), 0, c.duration);
    for (const [prop, v] of Object.entries(values)) {
      if (hasKf(c, prop)) {
        const kfs = [...c.keyframes[prop]];
        const i = kfs.findIndex((kf) => Math.abs(kf.t - lt) < 0.5 / fpsOf());
        if (i >= 0) kfs[i] = { ...kfs[i], v }; else { kfs.push({ t: lt, v, ease: 'easeInOut' }); kfs.sort((a, b) => a.t - b.t); }
        c = { ...c, keyframes: { ...c.keyframes, [prop]: kfs } };
      } else c = M.setIn(c, prop, v);
    }
    p.clips[id] = c;
  }
  return p;
}

function setPreview(p) {
  V.preview = p;
  try { V.compositor?.setProject(p); } catch { /* ignore */ }
  try { V.sources?.setProject(p); } catch { /* ignore */ }
  V.dirty = true; V.overlayDirty = true;
}
function endPreview() {
  V.preview = null;
  const p = state.project;
  try { V.compositor?.setProject(p); } catch { /* ignore */ }
  try { V.sources?.setProject(p); } catch { /* ignore */ }
  V.dirty = true; V.overlayDirty = true;
  if (!state.playing) scheduleExact();
}

// ---------------------------------------------------------------- pointer interaction
function bindPointer() {
  const ov = V.overlay;
  ov.addEventListener('pointerdown', onPointerDown);
  ov.addEventListener('pointermove', onHoverMove);
  ov.addEventListener('pointerleave', () => { if (V.hoverId) { V.hoverId = null; V.overlayDirty = true; } });
  ov.addEventListener('dblclick', onDblClick);
  ov.addEventListener('contextmenu', onContextMenu);
}

let hoverRaf = 0;
function onHoverMove(e) {
  if (V.drag || state.playing) return;
  if (hoverRaf) return;
  const pt = toCanvas(e);
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const id = hitTestAt(pt.x, pt.y);
    if (id !== V.hoverId) { V.hoverId = id; V.overlayDirty = true; }
  });
}

function onPointerDown(e) {
  if (e.button !== 0 || !state.project) return;
  if (state.playing) pause();
  const pt = toCanvas(e);
  const handle = e.target?.getAttribute?.('data-h');
  const t = state.playhead;
  const primary = pickPrimary(t);
  if (handle && primary) { e.preventDefault(); startHandleDrag(handle, pt, e, primary); return; }
  const id = hitTestAt(pt.x, pt.y);
  if (!id) {
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && state.selection.size) state.set({ selection: new Set() }, { source: 'viewer' });
    return;
  }
  let sel = new Set(state.selection);
  if (e.shiftKey || e.ctrlKey || e.metaKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
  else if (!sel.has(id)) sel = new Set([id]);
  V.primaryId = sel.has(id) ? id : V.primaryId;
  state.set({ selection: sel }, { source: 'viewer' });
  if (sel.has(id)) { e.preventDefault(); startMoveDrag(pt, e); }
}

function dragTargets(t) {
  const p = state.project;
  return [...state.selection].map((id) => p.clips[id]).filter((c) => c && M.VISUAL_TYPES.has(c.type) && c.type !== 'effect' && c.type !== 'adjustment' && !isLocked(c) && c.start <= t && t < M.clipEnd(c));
}

function startMoveDrag(pt0, e) {
  const t = state.playhead;
  const targets = dragTargets(t);
  if (!targets.length) {
    const c = state.project.clips[[...state.selection][0]];
    if (c && isLocked(c)) toast('הרצועה נעולה — שחררו את הנעילה כדי להזיז', { type: 'warn' });
    return;
  }
  const base = targets.map((c) => ({ id: c.id, c, x: valueAt(c, 'transform.x', t), y: valueAt(c, 'transform.y', t) }));
  const b0 = boundsOf(pickPrimary(t) || targets[0].id, t);
  const startProject = state.project;
  const drag = { kind: 'move', moved: false, ops: null };
  V.drag = drag;
  const ov = V.overlay;
  try { ov.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const sx = e.clientX; const sy = e.clientY;
  const move = (ev) => {
    if (!drag.moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    drag.moved = true;
    const pt = toCanvas(ev);
    let dx = pt.x - pt0.x; let dy = pt.y - pt0.y;
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    V.guides = [];
    if (b0 && !ev.altKey && state.snapping !== false) {
      const thr = 8 * V.k;
      const xs = b0.corners.map((c) => c[0]); const ys = b0.corners.map((c) => c[1]);
      const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
      const candX = [[b0.cx + dx, V.W / 2, V.W / 2], [minX + dx, 0, 0], [maxX + dx, V.W, V.W]];
      const candY = [[b0.cy + dy, V.H / 2, V.H / 2], [minY + dy, 0, 0], [maxY + dy, V.H, V.H]];
      for (const [v, target, gx] of candX) if (Math.abs(v - target) < thr) { dx += target - v; V.guides.push({ x: gx }); break; }
      for (const [v, target, gy] of candY) if (Math.abs(v - target) < thr) { dy += target - v; V.guides.push({ y: gy }); break; }
    }
    const entries = base.map((b) => ({ id: b.id, values: { 'transform.x': Math.round(b.x + dx), 'transform.y': Math.round(b.y + dy) } }));
    drag.entries = entries;
    setPreview(patchPreview(startProject, entries, t));
  };
  const up = () => {
    ov.removeEventListener('pointermove', move);
    ov.removeEventListener('pointerup', up);
    ov.removeEventListener('pointercancel', up);
    V.guides = [];
    V.drag = null;
    if (drag.moved && drag.entries) {
      const ops = drag.entries.flatMap((en) => propOps(state.project.clips[en.id] || base.find((b) => b.id === en.id).c, en.values, t));
      applyOps(ops, base.length > 1 ? 'הזזת קליפים בתצוגה' : `הזזת "${clipLabel(base[0].c)}"`);
    }
    endPreview();
  };
  ov.addEventListener('pointermove', move);
  ov.addEventListener('pointerup', up);
  ov.addEventListener('pointercancel', up);
}

function startHandleDrag(handle, pt0, e, primaryId) {
  const t = state.playhead;
  const targets = dragTargets(t);
  const b0 = boundsOf(primaryId, t);
  if (!b0 || !targets.length) return;
  const startProject = state.project;
  const center = { x: b0.cx, y: b0.cy };
  const d0 = Math.hypot(pt0.x - center.x, pt0.y - center.y) || 1;
  const a0 = Math.atan2(pt0.y - center.y, pt0.x - center.x);
  const base = targets.map((c) => ({ id: c.id, c, s: valueAt(c, 'transform.scale', t), r: valueAt(c, 'transform.rotation', t) }));
  const isRot = handle === 'rotate';
  const drag = { kind: isRot ? 'rotate' : 'scale', moved: false, label: '' };
  V.drag = drag;
  const ov = V.overlay;
  try { ov.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const move = (ev) => {
    drag.moved = true;
    const pt = toCanvas(ev);
    let entries;
    if (isRot) {
      let da = ((Math.atan2(pt.y - center.y, pt.x - center.x) - a0) * 180) / Math.PI;
      const prim = base.find((b) => b.id === primaryId) || base[0];
      let r = prim.r + da;
      if (ev.shiftKey) r = Math.round(r / 15) * 15;
      else { const near = Math.round(r / 90) * 90; if (Math.abs(r - near) < 3) r = near; }
      da = r - prim.r;
      entries = base.map((b) => ({ id: b.id, values: { 'transform.rotation': Math.round((b.r + da) * 10) / 10 } }));
      drag.label = `${Math.round(r * 10) / 10}°`;
    } else {
      let f = Math.hypot(pt.x - center.x, pt.y - center.y) / d0;
      const prim = base.find((b) => b.id === primaryId) || base[0];
      let s = clamp(prim.s * f, 0.02, 40);
      if (ev.shiftKey) s = Math.round(s * 20) / 20;
      f = s / (prim.s || 1);
      entries = base.map((b) => ({ id: b.id, values: { 'transform.scale': Math.round(clamp(b.s * f, 0.02, 40) * 1000) / 1000 } }));
      drag.label = `${Math.round(s * 100)}%`;
    }
    drag.entries = entries;
    setPreview(patchPreview(startProject, entries, t));
  };
  const up = () => {
    ov.removeEventListener('pointermove', move);
    ov.removeEventListener('pointerup', up);
    ov.removeEventListener('pointercancel', up);
    V.drag = null;
    if (drag.moved && drag.entries) {
      const ops = drag.entries.flatMap((en) => propOps(state.project.clips[en.id] || base.find((b) => b.id === en.id).c, en.values, t));
      applyOps(ops, isRot ? 'סיבוב בתצוגה' : 'שינוי גודל בתצוגה');
    }
    endPreview();
  };
  ov.addEventListener('pointermove', move);
  ov.addEventListener('pointerup', up);
  ov.addEventListener('pointercancel', up);
}

function clipLabel(c) {
  if (!c) return '';
  if (c.name) return c.name;
  if (c.type === 'text' && c.text?.content) return c.text.content.slice(0, 24);
  return M.CLIP_TYPE_LABELS[c.type] || c.type;
}

function onContextMenu(e) {
  e.preventDefault();
  const pt = toCanvas(e);
  const id = hitTestAt(pt.x, pt.y);
  const c = id ? state.project?.clips?.[id] : null;
  if (!c) return;
  if (!state.selection.has(id)) state.set({ selection: new Set([id]) }, { source: 'viewer' });
  const t = state.playhead;
  menu({ x: e.clientX, y: e.clientY }, [
    { header: clipLabel(c) },
    { label: 'מרכז בפריים', icon: 'move', onClick: () => applyOps(propOps(c, { 'transform.x': 0, 'transform.y': 0 }, t), 'מרכוז') },
    { label: 'איפוס גודל וסיבוב', icon: 'reset', onClick: () => applyOps(propOps(c, { 'transform.scale': 1, 'transform.rotation': 0 }, t), 'איפוס טרנספורם') },
    { label: 'היפוך אופקי', icon: 'flipH', onClick: () => applyOps([{ op: 'updateClip', id, set: { 'transform.flipX': !c.transform?.flipX } }], 'היפוך אופקי') },
    { label: 'היפוך אנכי', icon: 'flipV', onClick: () => applyOps([{ op: 'updateClip', id, set: { 'transform.flipY': !c.transform?.flipY } }], 'היפוך אנכי') },
    c.type === 'text' ? { label: 'עריכת טקסט', icon: 'text', onClick: () => openTextEditor(c) } : null,
    { sep: true },
    { label: 'פיצול בסמן', icon: 'scissors', hint: 'S', disabled: !(c.start < t && t < M.clipEnd(c)), onClick: () => applyOps([{ op: 'splitClip', id, at: t }], 'פיצול קליפ') },
    { label: 'שכפול', icon: 'copy', hint: 'Ctrl+D', onClick: () => applyOps([{ op: 'duplicateClip', id }], 'שכפול קליפ') },
    { label: 'מחיקה', icon: 'trash', danger: true, hint: 'Delete', onClick: () => applyOps([{ op: 'removeClip', id }], 'מחיקת קליפ') },
  ]);
}

// ---------------------------------------------------------------- inline text editing
function onDblClick(e) {
  const pt = toCanvas(e);
  const id = hitTestAt(pt.x, pt.y);
  const c = id ? state.project?.clips?.[id] : null;
  if (c && c.type === 'text') openTextEditor(c);
}

function openTextEditor(c) {
  if (state.playing) pause();
  const t = state.playhead;
  const b = boundsOf(c.id, t);
  const fr = V.frame.getBoundingClientRect(); const st = V.stage.getBoundingClientRect();
  const s = V.dispW / V.W;
  let left; let top; let w; let hh;
  if (b) {
    const xs = b.corners.map((q) => q[0]); const ys = b.corners.map((q) => q[1]);
    left = Math.min(...xs) * s; top = Math.min(...ys) * s; w = (Math.max(...xs) - Math.min(...xs)) * s; hh = (Math.max(...ys) - Math.min(...ys)) * s;
  } else { w = V.dispW * 0.8; hh = 80; left = (V.dispW - w) / 2; top = V.dispH / 2 - hh / 2; }
  w = Math.max(180, w + 24); hh = Math.max(44, hh + 16);
  const ox = fr.left - st.left; const oy = fr.top - st.top;
  const fs = clamp((c.text?.size || 96) * s * (valueAt(c, 'transform.scale', t) || 1), 12, 72);
  const ta = h('textarea.vw-text-edit', { dir: 'auto', spellcheck: false });
  ta.value = c.text?.content || '';
  Object.assign(ta.style, {
    left: `${ox + left - 12 + (b ? 0 : 0)}px`, top: `${oy + top - 8}px`, width: `${w}px`, height: `${hh}px`,
    fontSize: `${fs}px`, fontFamily: `"${c.text?.font || 'Heebo'}", Heebo, sans-serif`, fontWeight: String(c.text?.weight || 800),
    color: c.text?.color || '#fff', textAlign: c.text?.align || 'center', lineHeight: String(c.text?.lineHeight || 1.15),
  });
  V.stage.appendChild(ta);
  ta.focus(); ta.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const val = ta.value;
    ta.remove();
    if (commit && val !== (c.text?.content || '')) applyOps([{ op: 'updateClip', id: c.id, set: { 'text.content': val } }], 'עריכת טקסט בתצוגה');
  };
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(true); }
  });
  ta.addEventListener('blur', () => finish(true));
}
export function editText(clipId) { const c = state.project?.clips?.[clipId]; if (c && c.type === 'text') openTextEditor(c); }

// ---------------------------------------------------------------- drop from library onto the viewer
const DND = 'application/x-frame-studio';
const APPLY_KINDS = new Set(['effect', 'filter', 'transition', 'anim', 'caption', 'lut']);
let insertHandler = null;
/** main.js passes agent L's timeline insertPayload(payload, {t}) so viewer drops share the timeline's placement rules */
export function setInsertHandler(fn) { insertHandler = typeof fn === 'function' ? fn : null; }
function bindDrop() {
  const st = V.stage;
  st.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes(DND)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    st.classList.add('dropping');
  });
  st.addEventListener('dragleave', (e) => { if (!st.contains(e.relatedTarget)) st.classList.remove('dropping'); });
  st.addEventListener('drop', (e) => {
    st.classList.remove('dropping');
    const raw = e.dataTransfer?.getData(DND);
    if (!raw) return;
    e.preventDefault();
    let item; try { item = JSON.parse(raw); } catch { return; }
    const pt = toCanvas(e);
    const target = hitTestAt(pt.x, pt.y);
    if (insertHandler) {
      // apply-kinds go to the clip under the pointer; create-kinds land at the playhead
      if (target && APPLY_KINDS.has(item.kind)) state.set({ selection: new Set([target]) }, { source: 'viewer' });
      try { insertHandler(item, { t: state.playhead }); return; } catch (err) { console.warn('[viewer] insertPayload נכשל — משתמש בגיבוי', err); }
    }
    const ops = dropOps(item, target);
    if (ops.length) applyOps(ops, dropSummary(item)).then((r) => {
      const created = ops.find((o) => o.op === 'addClip' || o.op === 'sfx');
      if (r.ok && created?.id) state.set({ selection: new Set([created.id]) }, { source: 'viewer' });
    });
  });
}

function dropOps(item, targetId) {
  const t = state.playhead; const p = state.project;
  const target = targetId ? p.clips[targetId] : null;
  const kind = item.kind;
  const id = M.uid('c_');
  const x = (item.item && typeof item.item === 'object') ? { ...item.item, ...item } : item;
  switch (kind) {
    case 'media': {
      const mediaId = x.mediaId || x.id;
      const m = p.media?.[mediaId];
      if (!m) return [];
      return [{ op: 'addClip', id, type: m.kind === 'audio' ? 'audio' : m.kind, mediaId, start: t }];
    }
    case 'sound':
      return [{ op: 'sfx', id, sound: x.soundId || x.id || x.path || x.file, at: t }];
    case 'text': {
      const preset = x.preset || x;
      const op = { op: 'addClip', id, type: 'text', start: t };
      if (preset.text) op.text = preset.text;
      if (preset.textAnim) op.textAnim = preset.textAnim;
      if (x.content) op.text = { ...(op.text || {}), content: x.content };
      return [op];
    }
    case 'sticker': {
      const st = x.sticker || { kind: x.stickerKind || (x.kind2) || (x.builtin ? 'builtin' : 'emoji'), value: x.value ?? x.emoji ?? x.id };
      if (x.type === 'builtin' || x.kindOf === 'builtin') st.kind = 'builtin';
      return [{ op: 'addClip', id, type: 'sticker', start: t, sticker: st }];
    }
    case 'shape': {
      const shape = (x.shape && typeof x.shape === 'object') ? { ...x.shape } : { kind: x.shape || x.shapeKind || x.value || x.id || 'rect' };
      return [{ op: 'addClip', id, type: 'shape', start: t, shape }];
    }
    case 'effect': {
      const effect = x.effect || x.effectId || x.id;
      if (target && M.VISUAL_TYPES.has(target.type)) return [{ op: 'addEffect', id: target.id, effect }];
      return [{ op: 'addClip', id, type: 'effect', start: t, effects: [{ id: effect, params: x.params || {}, enabled: true }] }];
    }
    case 'filter': {
      if (!target) { toast('שחררו את הפילטר מעל קליפ בתצוגה', { type: 'warn' }); return []; }
      return [{ op: 'updateClip', id: target.id, set: { 'filter.id': x.filter || x.filterId || x.id, 'filter.amount': 1 } }];
    }
    case 'anim': {
      if (!target) { toast('שחררו את האנימציה מעל קליפ בתצוגה', { type: 'warn' }); return []; }
      const slot = x.slot || x.group || x.phase || 'in';
      const animId = x.anim || x.animId || x.id;
      if (x.text || x.scope === 'text') return [{ op: 'updateClip', id: target.id, set: { [`textAnim.${slot}`]: animId } }];
      const key = slot === 'out' ? 'animOut' : slot === 'loop' ? 'animLoop' : 'animIn';
      return [{ op: 'updateClip', id: target.id, set: { [`${key}.id`]: animId } }];
    }
    case 'transition': {
      if (target && !nextVisualAdjacent(p, target.id)) { toast('למעבר צריך קליפ צמוד אחרי הקליפ הזה באותה רצועה', { type: 'warn' }); return []; }
      if (!target) { toast('שחררו את המעבר מעל קליפ — או על המפגש בציר הזמן', { type: 'warn' }); return []; }
      return [{ op: 'setTransition', id: target.id, transition: x.transition || x.transitionId || x.id, duration: x.duration || x.defaultDuration }];
    }
    case 'caption': {
      const caps = target && target.type === 'caption' ? [target.id] : Object.values(p.clips).filter((c) => c.type === 'caption').map((c) => c.id);
      if (!caps.length) { toast('קודם צריך טקסט לכתוביות: בלשונית "כתוביות" — כתיבה ידנית, תמלול אוטומטי או ייבוא קובץ SRT. אפשר גם לבקש מ-Claude.', { type: 'warn' }); return []; }
      return [{ op: 'styleCaptions', ids: caps, style: x.style || x.id }];
    }
    case 'lut': {
      if (!target) { toast('שחררו את ה־LUT מעל קליפ בתצוגה', { type: 'warn' }); return []; }
      return [{ op: 'updateClip', id: target.id, set: { 'lut.file': x.file || x.id, 'lut.amount': 1 } }];
    }
    default: return [];
  }
}
function nextVisualAdjacent(p, id) {
  const c = p.clips[id]; if (!c) return null;
  const end = M.clipEnd(c); const fr = 1 / (p.settings?.fps || 30);
  return Object.values(p.clips).find((x) => x.trackId === c.trackId && x.id !== id && Math.abs(x.start - end) <= fr + 1e-6) || null;
}
function dropSummary(item) {
  return ({ media: 'הוספת מדיה מהתצוגה', sound: 'הוספת אפקט קולי', text: 'הוספת טקסט', sticker: 'הוספת מדבקה', shape: 'הוספת צורה', effect: 'הוספת אפקט', filter: 'החלת פילטר', anim: 'החלת אנימציה', transition: 'הוספת מעבר', caption: 'סגנון כתוביות', lut: 'החלת LUT' })[item.kind] || 'הוספה מהספרייה';
}

// ---------------------------------------------------------------- 2D fallback renderer (no WebGL compositor)
const fbImages = new Map();
function fallbackRender(t) {
  const ctx = V.fbCtx; const p = curProject();
  if (!ctx || !p) return;
  const sc = V.fbCanvas.width / V.W;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = p.settings?.background || '#000';
  ctx.fillRect(0, 0, V.fbCanvas.width, V.fbCanvas.height);
  V.fbBounds.clear();
  const tracks = (p.tracks || []).filter((tr) => tr.kind === 'video' && !tr.hidden);
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    const clips = Object.values(p.clips || {}).filter((c) => c.trackId === tr.id && !c.disabled && c.start <= t && t < M.clipEnd(c));
    for (const c of clips) {
      try { drawFallbackClip(ctx, c, t, p, sc); } catch (e) { if (V.renderErrors++ < 3) console.warn('[viewer] fallback', e); }
    }
  }
}

function drawFallbackClip(ctx, c, t, p, sc) {
  if (c.type === 'effect' || c.type === 'adjustment') return;
  const W = V.W; const H = V.H;
  const x = valueAt(c, 'transform.x', t); const y = valueAt(c, 'transform.y', t);
  const s = valueAt(c, 'transform.scale', t); const sx = valueAt(c, 'transform.scaleX', t); const sy = valueAt(c, 'transform.scaleY', t);
  const rot = valueAt(c, 'transform.rotation', t); const op = clamp(valueAt(c, 'transform.opacity', t), 0, 1);
  let w = 0; let hh = 0; let draw = null;
  if (c.type === 'video' || c.type === 'image') {
    const m = p.media?.[c.mediaId];
    const mw = m?.width || W; const mh = m?.height || H;
    const fit = c.fit || 'cover';
    const k = fit === 'fill' ? null : fit === 'none' ? 1 : fit === 'contain' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh);
    w = k == null ? W : mw * k; hh = k == null ? H : mh * k;
    let src = null;
    try { src = V.sources?.getSync?.(c, M.sourceTimeAt(c, t, m)) || null; } catch { src = null; }
    if (!src && c.type === 'image' && c.mediaId) src = fbImage(c.mediaId);
    draw = (cw, ch) => {
      if (src) { try { ctx.drawImage(src, -cw / 2, -ch / 2, cw, ch); return; } catch { /* fallthrough */ } }
      ctx.fillStyle = '#1d2b33'; ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = `${Math.round(28 * sc)}px Heebo, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.direction = 'rtl'; ctx.fillText(m?.name || clipLabel(c), 0, 0);
    };
  } else if (c.type === 'text' || c.type === 'caption') {
    let r = null;
    if (V.textMod?.rasterize) { try { r = V.textMod.rasterize(c, t, p, sc); } catch { r = null; } }
    if (r && r.canvas) {
      w = r.w || r.canvas.width / sc; hh = r.h || r.canvas.height / sc;
      const ox = r.cx || 0; const oy = r.cy || 0;
      draw = (cw, ch) => ctx.drawImage(r.canvas, -cw / 2 + ox * sc, -ch / 2 + oy * sc, cw, ch);
    } else {
      const tx = c.text || {};
      const size = (tx.size || 96);
      const content = c.type === 'caption' ? (c.caption?.words || []).map((wd) => wd.w).join(' ') : (tx.content || '');
      const lines = String(content).split('\n');
      ctx.font = `${tx.italic ? 'italic ' : ''}${tx.weight || 800} ${size * sc}px "${tx.font || 'Heebo'}", Heebo, sans-serif`;
      w = Math.max(...lines.map((l) => ctx.measureText(l).width / sc), 10); hh = lines.length * size * (tx.lineHeight || 1.15);
      draw = (cw, ch) => {
        ctx.font = `${tx.italic ? 'italic ' : ''}${tx.weight || 800} ${size * sc}px "${tx.font || 'Heebo'}", Heebo, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'rtl';
        if (tx.stroke?.width) { ctx.lineWidth = tx.stroke.width * sc; ctx.strokeStyle = tx.stroke.color || '#000'; ctx.lineJoin = 'round'; }
        lines.forEach((l, i) => {
          const ly = -ch / 2 + (i + 0.5) * (ch / lines.length);
          if (tx.stroke?.width) ctx.strokeText(l, 0, ly);
          ctx.fillStyle = tx.color || '#fff'; ctx.fillText(l, 0, ly);
        });
      };
    }
  } else if (c.type === 'shape') {
    const sh = c.shape || {};
    w = sh.w || 400; hh = sh.h || 400;
    draw = (cw, ch) => {
      ctx.fillStyle = sh.fill || '#13b6e4';
      ctx.beginPath();
      if (sh.kind === 'ellipse') ctx.ellipse(0, 0, cw / 2, ch / 2, 0, 0, Math.PI * 2);
      else if (sh.kind === 'roundrect' && ctx.roundRect) ctx.roundRect(-cw / 2, -ch / 2, cw, ch, (sh.radius || 40) * sc);
      else ctx.rect(-cw / 2, -ch / 2, cw, ch);
      ctx.fill();
      if (sh.strokeWidth) { ctx.lineWidth = sh.strokeWidth * sc; ctx.strokeStyle = sh.stroke || '#fff'; ctx.stroke(); }
    };
  } else if (c.type === 'sticker') {
    const st = c.sticker || {};
    w = hh = st.size || 220;
    draw = (cw, ch) => {
      ctx.font = `${ch * 0.86}px "Segoe UI Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(st.kind === 'emoji' ? (st.value || '⭐') : '★', 0, ch * 0.04);
    };
  } else return;
  const fx = (c.transform?.flipX ? -1 : 1); const fy = (c.transform?.flipY ? -1 : 1);
  const cw = w * s * sx; const ch = hh * s * sy;
  const cx = W / 2 + x; const cy = H / 2 + y;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.setTransform(sc, 0, 0, sc, 0, 0);
  ctx.translate(cx, cy); ctx.rotate((rot * Math.PI) / 180); ctx.scale(fx, fy);
  // draw in canvas px space; inner draws are in device px → compensate
  ctx.scale(1 / sc, 1 / sc);
  draw(cw * sc, ch * sc);
  ctx.restore();
  const rad = (rot * Math.PI) / 180; const cos = Math.cos(rad); const sin = Math.sin(rad);
  const corner = (ux, uy) => [cx + ux * cos - uy * sin, cy + ux * sin + uy * cos];
  V.fbBounds.set(c.id, { cx, cy, w: cw, h: ch, rotation: rot, corners: [corner(-cw / 2, -ch / 2), corner(cw / 2, -ch / 2), corner(cw / 2, ch / 2), corner(-cw / 2, ch / 2)] });
}

function fbImage(mediaId) {
  if (fbImages.has(mediaId)) { const im = fbImages.get(mediaId); return im.complete && im.naturalWidth ? im : null; }
  const im = new Image();
  im.onload = () => { V.dirty = true; };
  im.src = `/api/projects/${encodeURIComponent(state.projectId)}/media/${encodeURIComponent(mediaId)}/file`;
  fbImages.set(mediaId, im);
  return null;
}

// persist preview scale choice per machine
const savedScale = store.get('fs.previewScale');
if ([0.25, 0.5, 1].includes(savedScale)) state.set({ previewScale: savedScale }, { source: 'viewer' });
on('previewScale', (v) => store.set('fs.previewScale', v));
