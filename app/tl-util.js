// Frame Studio — shared helpers for the timeline and library panel (agent L).
// Pure helpers (no DOM at module top level) + small DOM builders used inside functions.

export const EPS = 1e-6;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clipEnd = (c) => (c ? (c.start || 0) + (c.duration || 0) : 0);
export const fpsOf = (p) => (p && p.settings && p.settings.fps) || 30;
export const frameOf = (p) => 1 / fpsOf(p);

export function snapToFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

/** "MM:SS:FF" (or "H:MM:SS:FF" ≥ 1h). */
export function formatTimecode(t, fps = 30) {
  if (!Number.isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  let totalFrames = Math.round(t * fps);
  const ff = totalFrames % fps;
  let secs = Math.floor(totalFrames / fps);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return (neg ? '-' : '') + (h ? `${h}:${p2(m)}:${p2(s)}:${p2(ff)}` : `${p2(m)}:${p2(s)}:${p2(ff)}`);
}

/**
 * Short label for the ruler: "0:05", "1:20" (minutes:seconds). Zoomed in to frames, the ticks between whole seconds
 * read "10f", "20f" — never "0:00:10", which looks like ten seconds.
 */
export function rulerLabel(t, fps, withFrames) {
  const totalFrames = Math.round(t * fps);
  const ff = totalFrames % fps;
  const secs = Math.floor(totalFrames / fps);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  if (withFrames && ff) return `${ff}f`;
  return `${m}:${p2(s)}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  // short clicks are fractions of a second: "0.2 ש׳", "0.05 ש׳" — never "0 ש׳"
  if (sec < 0.1) return `${Math.max(0.01, Math.round(sec * 100) / 100)} ש׳`;
  if (sec < 10) return sec.toFixed(1).replace(/\.0$/, '') + ' ש׳';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function uid(prefix = 'x_') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += chars[b % 36];
  return prefix + s;
}

export const VISUAL_TYPES = new Set(['video', 'image', 'text', 'caption', 'shape', 'sticker', 'effect', 'adjustment']);
export const kindOfType = (type) => (type === 'audio' ? 'audio' : 'video');
export const isMediaType = (type) => type === 'video' || type === 'image' || type === 'audio';

export const TYPE_LABELS = {
  video: 'וידאו', image: 'תמונה', audio: 'שמע', text: 'טקסט', caption: 'כתוביות', shape: 'צורה',
  sticker: 'מדבקה', effect: 'אפקט', adjustment: 'שכבת התאמה',
};
export const ROLE_LABELS = {
  main: 'ראשי', overlay: 'שכבה', text: 'טקסט', effects: 'אפקטים', voice: 'קריינות', music: 'מוזיקה', sfx: 'אפקטים קוליים',
};
export const ROLE_DEFAULT_NAMES = {
  main: 'ראשי', overlay: 'שכבה', text: 'טקסט', effects: 'אפקטים', voice: 'קריינות', music: 'מוזיקה', sfx: 'אפקטים קוליים',
};
export const VIDEO_ROLES = ['overlay', 'text', 'effects', 'main'];
export const AUDIO_ROLES = ['voice', 'music', 'sfx'];

/** Base colors per clip type (timeline bars). Audio clips are colored by track role. */
export const TYPE_COLORS = {
  video: '#1f6f8f', image: '#2a5f9e', text: '#7b4fd6', caption: '#b2479a', shape: '#c08b1d', sticker: '#c4507a',
  effect: '#6b46c1', adjustment: '#55606e', audio: '#2c8a57',
};
export const ROLE_AUDIO_COLORS = { voice: '#2c8a57', music: '#2d6fa8', sfx: '#b8742a' };

/** Timeline tint: model.js stores it in clip.tint (clip.color is the color-correction object). */
export function clipTint(clip) {
  if (clip && typeof clip.tint === 'string' && clip.tint) return clip.tint;
  if (clip && typeof clip.color === 'string' && clip.color) return clip.color;
  return null;
}
export function clipColor(clip, track) {
  const tint = clipTint(clip);
  if (tint) return tint;
  if (clip.type === 'audio') return ROLE_AUDIO_COLORS[track && track.role] || TYPE_COLORS.audio;
  return TYPE_COLORS[clip.type] || '#4a5563';
}

export const CLIP_PALETTE = ['#e5484d', '#f76b15', '#f5c518', '#30a46c', '#12a594', '#13b6e4', '#3e63dd', '#8e4ec6', '#d6409f', '#8d8d8d'];
export const MARKER_PALETTE = ['#f5c518', '#ff4d6d', '#e5484d', '#30a46c', '#13b6e4', '#ffd60a', '#8e4ec6', '#ffffff'];

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [80, 90, 100];
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function shade(hex, f) { // f>0 lighten, f<0 darken
  const [r, g, b] = hexToRgb(hex);
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  const c = (v) => Math.round((t - v) * p + v);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}
export function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; }

export const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function dbFromGain(g) { return g <= 0.00001 ? -Infinity : 20 * Math.log10(g); }
export function gainFromDb(db) { return Math.pow(10, db / 20); }
export function formatDb(g) { const d = dbFromGain(g); return Number.isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(1)} dB` : '-∞ dB'; }

// ───────────────────────── project helpers (pure) ─────────────────────────

export function trackById(p, id) { return p && p.tracks ? p.tracks.find((t) => t.id === id) || null : null; }
export function trackIndex(p, id) { return p && p.tracks ? p.tracks.findIndex((t) => t.id === id) : -1; }
export function clipsOnTrack(p, trackId) {
  if (!p || !p.clips) return [];
  return Object.values(p.clips).filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
export function projectDuration(p) {
  let end = 0;
  if (p && p.clips) for (const c of Object.values(p.clips)) end = Math.max(end, clipEnd(c));
  return Math.max(end, 1 / fpsOf(p));
}
export function mainTrack(p) { return p && p.tracks ? p.tracks.find((t) => t.role === 'main') || null : null; }
export function isCompatible(track, clipOrType) {
  const type = typeof clipOrType === 'string' ? clipOrType : clipOrType.type;
  return !!track && track.kind === kindOfType(type);
}
/** Clips on track overlapping [a,b) (strict, with epsilon), excluding ids. */
export function overlapping(p, trackId, a, b, exclude) {
  const ex = exclude || new Set();
  const out = [];
  for (const c of Object.values(p.clips || {})) {
    if (c.trackId !== trackId || ex.has(c.id)) continue;
    if (c.start < b - 1e-4 && clipEnd(c) > a + 1e-4) out.push(c);
  }
  return out;
}
export function isFree(p, trackId, a, b, exclude) { return overlapping(p, trackId, a, b, exclude).length === 0; }

/** Adjacent clip that starts at this clip's end on the same track (within 1 frame). */
export function nextAdjacent(p, clip) {
  const f = frameOf(p) + 1e-4;
  const end = clipEnd(clip);
  let best = null;
  for (const c of Object.values(p.clips || {})) {
    if (c.trackId !== clip.trackId || c.id === clip.id) continue;
    if (Math.abs(c.start - end) <= f && (!best || Math.abs(c.start - end) < Math.abs(best.start - end))) best = c;
  }
  return best;
}
export function prevAdjacent(p, clip) {
  const f = frameOf(p) + 1e-4;
  for (const c of Object.values(p.clips || {})) {
    if (c.trackId !== clip.trackId || c.id === clip.id) continue;
    if (Math.abs(clipEnd(c) - clip.start) <= f) return c;
  }
  return null;
}

export function mediaOf(p, clip) { return clip && clip.mediaId && p && p.media ? p.media[clip.mediaId] || null : null; }

/** Max timeline duration a media clip can have given its in-point & speed (Infinity if unbounded). */
export function maxDurationFor(p, clip, inPoint = clip.in || 0) {
  if (!isMediaType(clip.type) || clip.type === 'image') return Infinity;
  const m = mediaOf(p, clip);
  if (!m || !(m.duration > 0)) return Infinity;
  const sp = clip.speed || 1;
  return Math.max(0, (m.duration - inPoint) / sp);
}

/** Absolute times of every keyframe of a clip → [{t, props:[{prop, k}]}] sorted, merged within 1 ms. */
export function keyframeTimes(clip) {
  const map = new Map();
  const kf = clip && clip.keyframes ? clip.keyframes : {};
  for (const [prop, list] of Object.entries(kf)) {
    if (!Array.isArray(list)) continue;
    for (const k of list) {
      const key = Math.round(k.t * 1000);
      if (!map.has(key)) map.set(key, { t: k.t, props: [] });
      map.get(key).props.push({ prop, k });
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

export function trackLabel(t) {
  return t.name || ROLE_LABELS[t.role] || (t.kind === 'audio' ? 'שמע' : 'וידאו');
}

export function clipLabel(p, clip) {
  if (clip.name) return clip.name;
  if (clip.type === 'text') return (clip.text && clip.text.content) || 'טקסט';
  if (clip.type === 'caption') return ((clip.caption && clip.caption.words) || []).map((w) => w.w).join(' ') || 'כתוביות';
  if (clip.type === 'sticker') return (clip.sticker && clip.sticker.value && clip.sticker.kind === 'emoji') ? clip.sticker.value : 'מדבקה';
  if (clip.type === 'shape') return 'צורה';
  if (clip.type === 'effect') return ((clip.effects || []).map((e) => e.id).join(', ')) || 'אפקט';
  if (clip.type === 'adjustment') return 'שכבת התאמה';
  const m = mediaOf(p, clip);
  if (m) return m.name || TYPE_LABELS[clip.type];
  return TYPE_LABELS[clip.type] || clip.type;
}

// ───────────────────────── DOM helpers (call only in browser) ─────────────────────────

/** h('div.cls1.cls2', {attrs/props/on*}, ...children) */
export function h(sel, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:\.[\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) el.className = m[2].split('.').filter(Boolean).join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function injectStyle(id, css) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  if (el.textContent !== css) el.textContent = css;
  return el;
}

// ───────────────────────── icons (24×24, stroke) ─────────────────────────

const P = {
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5-9 9"/>',
  audio: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  sfx: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z"/>',
  text: '<path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6"/>',
  caption: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6"/>',
  shape: '<rect x="3" y="3" width="10" height="10" rx="1.5"/><circle cx="15.5" cy="15.5" r="5.5"/>',
  sticker: '<path d="M15.5 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h9.5L21 15.5V6a3 3 0 0 0-3-3z"/><path d="M8.5 13.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9h.01M15 9h.01"/>',
  effect: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2L10.8 4.8M3 21l9-9"/><path d="M12.5 11.5l-1-1"/>',
  adjustment: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>',
  overlay: '<rect x="3" y="3" width="13" height="13" rx="2"/><rect x="8" y="8" width="13" height="13" rx="2"/>',
  main: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M10 9.5v5l4.5-2.5z"/>',
  effects: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  eye: '<path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10.5 7 10.5 7a17 17 0 0 1-3.2 4M6.6 6.6C3.4 8.6 1.5 12 1.5 12s4 7 10.5 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.6 5.5a9.5 9.5 0 0 1 0 13"/>',
  volumeOff: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  lock: '<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11M14.5 11.5v6M11.5 14.5h6"/>',
  magnet: '<path d="M6 15V9a6 6 0 0 1 12 0v6"/><path d="M6 15a6 6 0 0 0 12 0M6 11.5h3.5M14.5 11.5H18M9.5 9v6a2.5 2.5 0 0 0 5 0V9"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/>',
  marker: '<path d="M6 3h12v15l-6-4-6 4z"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-5.6-5.6M10.5 7.5v6M7.5 10.5h6"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-5.6-5.6M7.5 10.5h6"/>',
  fit: '<path d="M3 9V4h5M21 9V4h-5M3 15v5h5M21 15v5h-5M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2"/>',
  cursor: '<path d="M5 3l14 7.5-6 1.8-2.4 6.2z"/>',
  blade: '<path d="M14.5 3.5l6 6L9 21H3v-6z"/><path d="M11.5 6.5l6 6"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  pause: '<path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  transition: '<path d="M3 5l9 7-9 7zM21 5l-9 7 9 7z"/>',
  keyframe: '<path d="M12 3l9 9-9 9-9-9z"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.6-4.6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2.5h6.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  wand: '<path d="M4 20L16 8M14.5 3.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7zM19 10l.5 1.5L21 12l-1.5.5L19 14l-.5-1.5L17 12l1.5-.5z"/>',
  filter: '<circle cx="9" cy="9" r="6"/><circle cx="15" cy="15" r="6"/>',
  funnel: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  anim: '<circle cx="15" cy="12" r="5"/><path d="M3 9h4M2 12h5M3 15h4"/>',
  split: '<path d="M12 2v20M5 7l-3 5 3 5M19 7l3 5-3 5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  detach: '<path d="M3 7h18M3 17h7M14 17h7M12 11v3M10 13l2 2 2-2"/>',
  speed: '<path d="M12 14l4-4"/><path d="M3.5 18a9.5 9.5 0 1 1 17 0"/>',
  ripple: '<path d="M3 6h7v12H3zM14 6h7v12h-7M10 12h4"/>',
  height: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>',
  solo: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.3c-.5-.9-1.6-1.5-2.8-1.5-1.5 0-2.7.8-2.7 2.1 0 2.9 5.7 1.6 5.7 4.3 0 1.3-1.3 2.1-2.9 2.1-1.4 0-2.5-.6-3-1.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  inPoint: '<path d="M8 4v16M8 4h6M8 20h6"/>',
  outPoint: '<path d="M16 4v16M16 4h-6M16 20h-6"/>',
  sparkles: '<path d="M9.5 3l1.6 4.4L15.5 9l-4.4 1.6L9.5 15l-1.6-4.4L3.5 9l4.4-1.6zM17.5 13l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  license: '<path d="M12 2.5l7.5 3v6c0 4.6-3.2 8.6-7.5 10-4.3-1.4-7.5-5.4-7.5-10v-6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  heart: '<path d="M12 20.5s-8.5-5.3-8.5-11A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 2.9c0 5.7-8.5 11-8.5 11z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  path: '<path d="M4 7h16M4 12h10M4 17h7"/><path d="M17 15l3 3-3 3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.6L3 9M4 13a8 8 0 0 0 14.6 4.6L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
};
const FILLED = new Set(['keyframe', 'play', 'pause', 'stop', 'marker', 'sfx']);

/** SVG icon element/string. */
export function icon(name, size = 16, { filled, cls } = {}) {
  const d = P[name] || P.info;
  const fill = filled != null ? filled : FILLED.has(name);
  return `<svg class="ic${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${fill ? 0 : 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
export function iconEl(name, size = 16, opts) {
  const t = document.createElement('template');
  t.innerHTML = icon(name, size, opts);
  return t.content.firstChild;
}

export function roleIcon(track) {
  if (!track) return 'video';
  if (track.kind === 'audio') return track.role === 'music' ? 'music' : track.role === 'voice' ? 'voice' : track.role === 'sfx' ? 'sfx' : 'audio';
  return track.role === 'text' ? 'text' : track.role === 'effects' ? 'effects' : track.role === 'overlay' ? 'overlay' : 'main';
}
export const TYPE_ICONS = { video: 'video', image: 'image', audio: 'audio', text: 'text', caption: 'caption', shape: 'shape', sticker: 'sticker', effect: 'effect', adjustment: 'adjustment' };
