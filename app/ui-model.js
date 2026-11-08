// Frame Studio — app/ui-model.js (owner: U)
// Thin bridge to shared/model.js + shared/anim.js (agent M) with safe fallbacks, so the editor UI
// keeps working (degraded) if a shared module is missing or fails to load.

let model = {};
let anim = {};
try { model = await import('../shared/model.js'); } catch (e) { console.warn('[ui-model] shared/model.js לא נטען', e); }
try { anim = await import('../shared/anim.js'); } catch (e) { console.warn('[ui-model] shared/anim.js לא נטען', e); }

export const hasModel = !!model.newClip;
export const hasAnim = !!anim.evalKeyframed;

const fpsOf = (p) => p?.settings?.fps || 30;

export const clipEnd = model.clipEnd || ((c) => (c.start || 0) + (c.duration || 0));

export function projectDuration(p) {
  if (!p) return 0;
  if (model.projectDuration) { try { return model.projectDuration(p); } catch { /* fallthrough */ } }
  let end = 0;
  for (const c of Object.values(p.clips || {})) end = Math.max(end, clipEnd(c));
  return Math.max(end, 1 / fpsOf(p));
}

export function snapToFrame(t, fps = 30) {
  if (model.snapToFrame) { try { return model.snapToFrame(t, fps); } catch { /* fallthrough */ } }
  return Math.round(t * fps) / fps;
}

export function formatTimecode(t, fps = 30) {
  if (model.formatTimecode) { try { return model.formatTimecode(t, fps); } catch { /* fallthrough */ } }
  if (!Number.isFinite(t) || t < 0) t = 0;
  const total = Math.round(t * fps);
  const f = total % fps; const s = Math.floor(total / fps);
  const mm = Math.floor(s / 60); const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/**
 * Timecode split for display: { main:"MM:SS" (or "H:MM:SS"), ff:"FF" } — the player shows the frames smaller and
 * dimmer so "00:05:00" never reads as five minutes.
 */
export function tcParts(t, fps = 30) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const total = Math.round(t * fps);
  const f = total % fps; const s = Math.floor(total / fps);
  const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return { main: hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`, ff: p2(f) };
}
/** "00:05<span class=tc-ff>:12</span>" (minutes:seconds, frames dimmed) */
export function tcHtml(t, fps = 30) {
  const { main, ff } = tcParts(t, fps);
  return `${main}<span class="tc-ff">:${ff}</span>`;
}

/**
 * A length in words a creator reads at a glance: "4.5 ש׳", "12 ש׳", "1:05 דק׳", "1:02:03 שע׳".
 * For project cards, the project panel and export summaries (frame timecodes stay in the player and ruler).
 */
export function fmtLength(t) {
  if (!Number.isFinite(t) || t <= 0) return '0 ש׳';
  if (t < 10) return `${(Math.round(t * 10) / 10).toString()} ש׳`;
  if (t < 60) return `${Math.round(t)} ש׳`;
  const s = Math.round(t);
  const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)} שע׳` : `${mm}:${p2(ss)} דק׳`;
}

/** Project length for people: "ריק" when there is nothing on the timeline. */
export function fmtProjectLength(p) {
  if (!p) return '—';
  const clips = p.clips ? Object.keys(p.clips).length : p.clipCount;
  if (!clips) return 'ריק';
  return fmtLength(p.clips ? projectDuration(p) : p.duration);
}

export function clipsOnTrack(p, trackId) {
  if (model.clipsOnTrack) { try { return model.clipsOnTrack(p, trackId); } catch { /* fallthrough */ } }
  return Object.values(p?.clips || {}).filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function activeClipsAt(p, t) {
  if (model.activeClipsAt) { try { return model.activeClipsAt(p, t); } catch { /* fallthrough */ } }
  return Object.values(p?.clips || {}).filter((c) => !c.disabled && c.start <= t && t < clipEnd(c));
}

export function sourceTimeAt(clip, t, media) {
  if (model.sourceTimeAt) { try { const v = model.sourceTimeAt(clip, t, media); if (Number.isFinite(v)) return v; } catch { /* fallthrough */ } }
  const sp = clip.speed || 1;
  const local = (t - (clip.start || 0)) * sp;
  let s = clip.reverse ? (clip.in || 0) + (clip.duration || 0) * sp - local : (clip.in || 0) + local;
  const d = media?.duration;
  if (d) s = Math.min(d, s);
  return Math.max(0, s);
}

/** immutable set by dotted path (numeric keys index arrays) */
export function setIn(obj, path, value) {
  const keys = String(path).split('.');
  const rec = (o, i) => {
    const k = keys[i];
    const isArr = Array.isArray(o);
    const copy = isArr ? [...o] : { ...(o || {}) };
    if (i === keys.length - 1) copy[k] = value;
    else {
      const next = o ? o[k] : undefined;
      copy[k] = rec(next ?? (/^\d+$/.test(keys[i + 1]) ? [] : {}), i + 1);
    }
    return copy;
  };
  return rec(obj, 0);
}

export function getPath(obj, path) {
  if (model.getPath) { try { return model.getPath(obj, path); } catch { /* fallthrough */ } }
  let o = obj;
  for (const k of String(path).split('.')) { if (o == null) return undefined; o = o[k]; }
  return o;
}

export function uid(prefix = 'x_') {
  if (model.uid) { try { return model.uid(prefix); } catch { /* fallthrough */ } }
  return prefix + Math.random().toString(36).slice(2, 10);
}

export function newClipDefaults(type, props = {}) {
  if (model.newClip) { try { return model.newClip(type, props); } catch { /* fallthrough */ } }
  return { type, ...props };
}

/** keyframe evaluation (clip-local time) */
export function evalKeyframed(clip, prop, localT, fallback) {
  if (anim.evalKeyframed) { try { const v = anim.evalKeyframed(clip, prop, localT, fallback); if (Number.isFinite(v)) return v; } catch { /* fallthrough */ } }
  const kfs = clip?.keyframes?.[prop];
  if (!kfs || !kfs.length) return fallback;
  const ks = [...kfs].sort((a, b) => a.t - b.t);
  if (localT <= ks[0].t) return ks[0].v;
  if (localT >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1]; const b = ks[i];
    if (localT <= b.t) {
      if (b.ease === 'hold') return a.v;
      let p = (localT - a.t) / Math.max(1e-9, b.t - a.t);
      if (b.ease === 'easeIn') p = p * p; else if (b.ease === 'easeOut') p = 1 - (1 - p) * (1 - p);
      else if (b.ease === 'easeInOut') p = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
      return a.v + (b.v - a.v) * p;
    }
  }
  return fallback;
}

export const EASING_LABELS = {
  linear: 'ליניארי', easeIn: 'האצה', easeOut: 'האטה', easeInOut: 'האצה והאטה', hold: 'החזקה',
  spring: 'קפיץ', bounce: 'קפיצה', back: 'חריגה', elastic: 'אלסטי',
};

export const CLIP_TYPE_LABELS = {
  video: 'וידאו', image: 'תמונה', audio: 'אודיו', text: 'טקסט', caption: 'כתוביות', shape: 'צורה',
  sticker: 'מדבקה', effect: 'אפקט', adjustment: 'שכבת התאמה', ...(model.CLIP_TYPE_LABELS || {}),
};
export const ROLE_LABELS = {
  main: 'ראשי', overlay: 'שכבה', text: 'טקסט', effects: 'אפקטים', voice: 'קריינות', music: 'מוזיקה', sfx: 'אפקטים קוליים',
  ...(model.ROLE_LABELS || {}),
};

export const VISUAL_TYPES = new Set(['video', 'image', 'text', 'caption', 'shape', 'sticker', 'effect', 'adjustment']);
export const MEDIA_TYPES = new Set(['video', 'image', 'audio']);

export function clipHasAudio(clip, project) {
  if (clip.type === 'audio') return true;
  if (clip.type !== 'video') return false;
  const m = project?.media?.[clip.mediaId];
  return !m || m.hasAudio !== false;
}

export function trackOf(project, clip) { return (project?.tracks || []).find((t) => t.id === clip?.trackId) || null; }

export const KEYFRAMABLE = (prop) => /^(transform\.(x|y|scale|scaleX|scaleY|rotation|opacity)|volume|color\.\w+|crop\.[ltrb]|effects\.\d+\.\w+)$/.test(prop);

export { model as modelModule, anim as animModule };
