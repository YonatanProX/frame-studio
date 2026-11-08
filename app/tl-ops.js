// Frame Studio — pure edit planning for the timeline (agent L).
// Every function takes a project and returns { ops, summary, select? } (ops per SPEC §3) — no DOM, no state.
// Used by app/timeline.js (drag/trim/menus/keys) and app/library-panel.js (add at playhead / drops).

import {
  clipEnd, overlapping, isFree, trackById, trackIndex, clipsOnTrack, kindOfType, frameOf, fpsOf, maxDurationFor,
  uid, ROLE_DEFAULT_NAMES, nextAdjacent, prevAdjacent, mediaOf, isMediaType, keyframeTimes, clamp, snapToFrame,
  TYPE_LABELS,
} from './tl-util.js';

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const TOL = 1e-4;

// ───────────────────────── track selection ─────────────────────────

/** Index where a NEW track of `kind` should be inserted ("top" of its group or "bottom"). */
export function newTrackIndex(p, kind, where = 'top', relativeTo = null) {
  const tracks = p.tracks || [];
  if (relativeTo) {
    const i = trackIndex(p, relativeTo);
    if (i >= 0) return kind === 'video' ? i : i + 1; // video: just above, audio: just below
  }
  const idx = tracks.map((t, i) => (t.kind === kind ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return kind === 'video' ? 0 : tracks.length;
  if (where === 'top') return idx[0];
  return idx[idx.length - 1] + 1;
}

export function makeNewTrack(p, kind, role, index, name) {
  const id = uid('t_');
  const base = name || ROLE_DEFAULT_NAMES[role] || (kind === 'audio' ? 'שמע' : 'וידאו');
  const same = (p.tracks || []).filter((t) => (name ? (t.name || '').startsWith(base) : t.role === role)).length;
  return { op: 'addTrack', id, kind, role, name: same ? `${base} ${same + 1}` : base, index };
}

/** Guess a track role for a clip/payload. */
export function roleFor(type, { name = '', duration = 0, role } = {}) {
  if (role) return role;
  if (type === 'audio') {
    if (/קריינות|קול|voice|\bvo\b|narrat/i.test(name)) return 'voice';
    if (/שיר|מוזיקה|music|song|track|beat/i.test(name) || duration > 20) return 'music';
    return 'sfx';
  }
  if (type === 'text' || type === 'caption') return 'text';
  if (type === 'effect' || type === 'adjustment') return 'effects';
  if (type === 'sticker' || type === 'shape') return 'overlay';
  return 'main';
}

/**
 * Pick a track for a new clip of `type` over [start, start+dur).
 * @returns {{ trackId?:string, newTrack?:object (addTrack op), insert?:{ trackId, at } }}
 */
export function chooseTrack(p, { type, start, dur, hoverTrackId, zone, magnetic, role, exclude, name }) {
  const kind = kindOfType(type);
  const end = start + dur;
  const r = roleFor(type, { role, name, duration: dur });
  if (zone === 'top' || zone === 'bottom') {
    const idx = newTrackIndex(p, kind, zone);
    return { newTrack: makeNewTrack(p, kind, kind === 'video' && r === 'main' ? 'overlay' : r, idx) };
  }
  let hover = hoverTrackId ? trackById(p, hoverTrackId) : null;
  // the main track only takes video/image (text, stickers, effects go to their own tracks)
  if (hover && hover.role === 'main' && type !== 'video' && type !== 'image') hover = null;
  if (hover && hover.kind === kind && !hover.locked) {
    if (hover.role === 'main' && magnetic && (type === 'video' || type === 'image')) {
      return { trackId: hover.id, insert: { trackId: hover.id, at: magneticInsertTime(p, hover.id, start, exclude) } };
    }
    if (isFree(p, hover.id, start, end, exclude)) return { trackId: hover.id };
    return { newTrack: makeNewTrack(p, kind, hover.role === 'main' ? 'overlay' : hover.role, newTrackIndex(p, kind, 'top', hover.id)) };
  }
  // no (compatible) hover: role preference (caption tracks only take captions)
  const cands = (p.tracks || []).filter((t) => t.kind === kind && !t.locked && (type === 'caption' || !isCaptionTrack(t)));
  const byRole = cands.filter((t) => t.role === r);
  if (r === 'main' && byRole.length && magnetic && (type === 'video' || type === 'image')) {
    const mt = byRole[0];
    if (isFree(p, mt.id, start, end, exclude)) return { trackId: mt.id };
  }
  for (const t of byRole) if (isFree(p, t.id, start, end, exclude)) return { trackId: t.id };
  if (r === 'main') {
    const ov = cands.filter((t) => t.role === 'overlay');
    for (const t of ov) if (isFree(p, t.id, start, end, exclude)) return { trackId: t.id };
    const mainT = byRole[0];
    return { newTrack: makeNewTrack(p, kind, 'overlay', newTrackIndex(p, kind, 'top', mainT ? mainT.id : null)) };
  }
  if (!byRole.length) {
    // no track of that role yet: create one at the natural place
    const idx = kind === 'video' ? (r === 'effects' ? 0 : newTrackIndex(p, kind, 'top')) : newTrackIndex(p, kind, r === 'voice' ? 'top' : 'bottom');
    return { newTrack: makeNewTrack(p, kind, r, idx) };
  }
  const last = byRole[kind === 'video' ? 0 : byRole.length - 1];
  return { newTrack: makeNewTrack(p, kind, r, newTrackIndex(p, kind, 'top', last.id)) };
}

/** The auto-created captions track (SPEC: role text, name כתוביות). */
export function isCaptionTrack(t) { return !!t && (t.captions === true || (t.role === 'text' && t.name === 'כתוביות')); }

/** Insertion time on a magnetic main track for a pointer time `t` (between clips). */
export function magneticInsertTime(p, trackId, t, exclude) {
  const ex = exclude || new Set();
  const list = clipsOnTrack(p, trackId).filter((c) => !ex.has(c.id));
  if (!list.length) return 0;
  for (const c of list) if (c.start + c.duration / 2 > t) return c.start;
  return clipEnd(list[list.length - 1]);
}

// ───────────────────────── move ─────────────────────────

/**
 * Plan a move of clips.
 * drag: { ids:[...], primaryId, dt, targetTrackId?, zone?: "top"|"bottom", magnetic, duplicate, pointerT? }
 * Returns { newTracks:[addTrack ops], moves:[{id,start,trackId}], shifts:[{id,start}] } — also used for live preview.
 */
export function planMove(p, drag) {
  const ids = drag.ids.filter((id) => p.clips[id]);
  const clips = ids.map((id) => p.clips[id]);
  const idSet = new Set(ids);
  const primary = p.clips[drag.primaryId] || clips[0];
  const out = { newTracks: [], moves: [], shifts: [] };
  if (!primary) return out;
  const excl = drag.duplicate ? new Set() : idSet; // clips excluded from collision tests
  const magnetic = !!drag.magnetic;
  const mainT = (p.tracks || []).find((t) => t.role === 'main');

  // 1. target track per clip
  const kindLists = { video: p.tracks.filter((t) => t.kind === 'video'), audio: p.tracks.filter((t) => t.kind === 'audio') };
  const pKind = kindOfType(primary.type);
  const pList = kindLists[pKind];
  const pSrcIdx = pList.findIndex((t) => t.id === primary.trackId);
  let delta = 0;
  let zone = drag.zone || null;
  const tgt = drag.targetTrackId ? trackById(p, drag.targetTrackId) : null;
  if (!zone && tgt) {
    if (tgt.kind === pKind) delta = pList.findIndex((t) => t.id === tgt.id) - pSrcIdx;
    else {
      // dragged a video clip over audio tracks (or vice versa): stay on the nearest compatible track
      const edgeTrack = pKind === 'video' ? pList[pList.length - 1] : pList[0];
      delta = pList.indexOf(edgeTrack) - pSrcIdx;
    }
  }
  const groups = new Map(); // targetTrackId|newKey → clips
  for (const c of clips) {
    const k = kindOfType(c.type);
    const list = kindLists[k];
    let target;
    if (zone) target = `new:${zone}:${k}:${c.trackId}`;
    else {
      const si = list.findIndex((t) => t.id === c.trackId);
      const ti = clamp(si + (k === pKind ? delta : 0), 0, list.length - 1);
      target = list[ti] ? list[ti].id : c.trackId;
      if (list[ti] && list[ti].locked) target = c.trackId;
    }
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(c);
  }

  const dt = drag.dt || 0;
  const minStart = Math.min(...clips.map((c) => c.start));
  const dtc = Math.max(dt, -minStart); // never before 0

  // 2. magnetic main track handling (CapCut-style: no gaps are created, neighbours slide)
  if (mainT && magnetic) {
    const toMainAll = groups.get(mainT.id) || [];
    const toMain = toMainAll.filter((c) => c.type === 'video' || c.type === 'image');
    const fromMain = drag.duplicate ? [] : clips.filter((c) => c.trackId === mainT.id);
    if (toMain.length || fromMain.length) {
      const removedIds = new Set(fromMain.map((c) => c.id));
      const rest = clipsOnTrack(p, mainT.id).filter((c) => !removedIds.has(c.id));
      const shifted = new Map(rest.map((c) => {
        let s = c.start;
        for (const r of fromMain) if (clipEnd(r) <= c.start + TOL) s -= r.duration;
        return [c.id, Math.max(0, s)];
      }));
      if (toMain.length) {
        const block = [...toMain].sort((a, b) => a.start - b.start);
        const blockLen = block.reduce((acc, c) => acc + c.duration, 0);
        const pointer = drag.pointerT != null ? drag.pointerT : primary.start + dtc;
        const restSorted = rest.map((c) => ({ c, s: shifted.get(c.id) })).sort((x, y) => x.s - y.s);
        let T = 0;
        if (restSorted.length) {
          T = null;
          for (const { c, s } of restSorted) if (s + c.duration / 2 > pointer) { T = s; break; }
          if (T == null) { const l = restSorted[restSorted.length - 1]; T = l.s + l.c.duration; }
        }
        for (const { c, s } of restSorted) if (s >= T - TOL) shifted.set(c.id, s + blockLen);
        let cur = T;
        for (const c of block) { out.moves.push({ id: c.id, start: r6(cur), trackId: mainT.id }); cur += c.duration; }
        const others = toMainAll.filter((c) => !toMain.includes(c));
        if (others.length) groups.set(mainT.id, others); else groups.delete(mainT.id);
      }
      for (const c of rest) {
        const s = shifted.get(c.id);
        if (Math.abs(s - c.start) > TOL) out.shifts.push({ id: c.id, start: r6(s) });
      }
    }
  }

  // 3. other groups: collision → new track
  const shiftedIds = new Set(out.shifts.map((s) => s.id));
  for (const [target, list] of groups) {
    let trackId = target;
    if (target.startsWith('new:')) {
      const [, z, k] = target.split(':');
      const src = trackById(p, list[0].trackId);
      const role = src && src.role !== 'main' ? src.role : (k === 'video' ? 'overlay' : 'sfx');
      const nt = makeNewTrack(p, k, role, newTrackIndex(p, k, z === 'top' ? 'top' : 'bottom'));
      out.newTracks.push(nt);
      trackId = nt.id;
    } else {
      const collide = list.some((c) => {
        const s = c.start + dtc, e = s + c.duration;
        return overlapping(p, target, s, e, excl).some((o) => !shiftedIds.has(o.id));
      });
      if (collide) {
        const t = trackById(p, target);
        const k = t.kind;
        const role = t.role === 'main' ? 'overlay' : t.role;
        const nt = makeNewTrack(p, k, role, newTrackIndex(p, k, 'top', target));
        out.newTracks.push(nt);
        trackId = nt.id;
      }
    }
    for (const c of list) out.moves.push({ id: c.id, start: r6(c.start + dtc), trackId });
  }
  return out;
}

export function moveOps(p, plan, { duplicate } = {}) {
  const ops = [...plan.newTracks];
  // shifts first (right-moving ones from the end), then the dragged clips
  const right = plan.shifts.filter((s) => s.start > p.clips[s.id].start).sort((a, b) => b.start - a.start);
  const left = plan.shifts.filter((s) => s.start <= p.clips[s.id].start).sort((a, b) => a.start - b.start);
  for (const s of [...left, ...right]) ops.push({ op: 'moveClip', id: s.id, start: s.start, overlap: 'allow' });
  for (const m of plan.moves) {
    const c = p.clips[m.id];
    if (duplicate) ops.push({ op: 'duplicateClip', id: m.id, newId: uid('c_'), start: m.start, track: m.trackId, overlap: 'allow' });
    else if (Math.abs(c.start - m.start) > TOL || c.trackId !== m.trackId) {
      const op = { op: 'moveClip', id: m.id, start: m.start, overlap: 'allow' };
      if (c.trackId !== m.trackId) op.track = m.trackId;
      ops.push(op);
    }
  }
  return ops;
}

// ───────────────────────── trim ─────────────────────────

/**
 * Plan a trim. args: { id, edge:"start"|"end", t (pointer timeline time), ripple }
 * Returns { start, end, in, duration, shifts:[{id,start}], limit:"media"|"neighbor"|"min"|null }
 */
export function planTrim(p, { id, edge, t, ripple }) {
  const c = p.clips[id];
  const f = frameOf(p);
  const sp = c.speed || 1;
  const media = isMediaType(c.type) && c.type !== 'image';
  const oldStart = c.start, oldEnd = clipEnd(c), oldIn = c.in || 0;
  const others = clipsOnTrack(p, c.trackId).filter((o) => o.id !== id);
  let limit = null;
  const res = { start: oldStart, end: oldEnd, in: oldIn, duration: c.duration, shifts: [], limit: null };
  if (edge === 'end') {
    let ne = Math.max(t, oldStart + f);
    if (ne === oldStart + f && t < ne) limit = 'min';
    const maxD = maxDurationFor(p, c, oldIn);
    if (media && oldStart + maxD < ne) { ne = oldStart + maxD; limit = 'media'; }
    if (!ripple) {
      const next = others.filter((o) => o.start >= oldEnd - TOL).sort((a, b) => a.start - b.start)[0];
      if (next && ne > next.start) { ne = next.start; limit = 'neighbor'; }
    }
    res.end = r6(ne); res.duration = r6(ne - oldStart);
    if (ripple) {
      const d = ne - oldEnd;
      for (const o of others) if (o.start >= oldEnd - TOL) res.shifts.push({ id: o.id, start: r6(Math.max(0, o.start + d)) });
    }
  } else {
    let ns = Math.min(t, oldEnd - f);
    if (ns === oldEnd - f && t > ns) limit = 'min';
    if (media) {
      const minS = oldStart - oldIn / sp;
      if (ns < minS) { ns = minS; limit = 'media'; }
    }
    if (ns < 0) { ns = 0; limit = limit || 'neighbor'; }
    if (!ripple) {
      const prev = others.filter((o) => clipEnd(o) <= oldStart + TOL).sort((a, b) => clipEnd(b) - clipEnd(a))[0];
      if (prev && ns < clipEnd(prev)) { ns = clipEnd(prev); limit = 'neighbor'; }
      res.start = r6(ns);
      res.duration = r6(oldEnd - ns);
      res.in = media ? r6(oldIn + (ns - oldStart) * sp) : oldIn;
    } else {
      // ripple head trim: clip keeps its start, everything after it slides by the change
      const d = ns - oldStart; // >0 shortens
      res.start = oldStart;
      res.duration = r6(c.duration - d);
      res.end = r6(oldStart + res.duration);
      res.in = media ? r6(oldIn + d * sp) : oldIn;
      res.trimStart = r6(ns);
      for (const o of others) if (o.start >= oldEnd - TOL) res.shifts.push({ id: o.id, start: r6(Math.max(0, o.start - d)) });
    }
  }
  res.limit = limit;
  return res;
}

export function trimOps(p, id, edge, plan, ripple) {
  const c = p.clips[id];
  const ops = [];
  const right = plan.shifts.filter((s) => s.start > p.clips[s.id].start).sort((a, b) => b.start - a.start);
  const left = plan.shifts.filter((s) => s.start <= p.clips[s.id].start).sort((a, b) => a.start - b.start);
  if (edge === 'end') {
    for (const s of right) ops.push({ op: 'moveClip', id: s.id, start: s.start, overlap: 'allow' });
    if (Math.abs(plan.end - clipEnd(c)) > TOL) ops.push({ op: 'trimClip', id, end: plan.end, ...(ripple ? { overlap: 'allow' } : {}) });
    for (const s of left) ops.push({ op: 'moveClip', id: s.id, start: s.start, overlap: 'allow' });
  } else if (!ripple) {
    if (Math.abs(plan.start - c.start) > TOL) ops.push({ op: 'trimClip', id, start: plan.start });
  } else {
    for (const s of right) ops.push({ op: 'moveClip', id: s.id, start: s.start, overlap: 'allow' });
    if (Math.abs(plan.trimStart - c.start) > TOL) {
      ops.push({ op: 'trimClip', id, start: plan.trimStart, overlap: 'allow' });
      ops.push({ op: 'moveClip', id, start: c.start, overlap: 'allow' });
    }
    for (const s of left) ops.push({ op: 'moveClip', id: s.id, start: s.start, overlap: 'allow' });
  }
  return ops;
}

// ───────────────────────── delete / split / duplicate / paste ─────────────────────────

/** Delete clips. ripple → close the gap on the same track (also always on the magnetic main track). */
export function deleteOps(p, ids, { ripple = false, magnetic = false } = {}) {
  const mainT = (p.tracks || []).find((t) => t.role === 'main');
  const list = ids.map((id) => p.clips[id]).filter(Boolean);
  const ops = [];
  const shift = new Map(); // id → new start
  const byTrack = new Map();
  for (const c of list) {
    const rip = ripple || (magnetic && mainT && c.trackId === mainT.id);
    if (!rip) continue;
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  const del = new Set(list.map((c) => c.id));
  for (const [trackId, removed] of byTrack) {
    for (const o of clipsOnTrack(p, trackId)) {
      if (del.has(o.id)) continue;
      let s = o.start;
      for (const r of removed) if (clipEnd(r) <= o.start + TOL) s -= r.duration;
      if (Math.abs(s - o.start) > TOL) shift.set(o.id, r6(Math.max(0, s)));
    }
  }
  for (const c of list) ops.push({ op: 'removeClip', id: c.id });
  for (const [id, s] of [...shift].sort((a, b) => a[1] - b[1])) ops.push({ op: 'moveClip', id, start: s, overlap: 'allow' });
  return ops;
}

export function splitOps(p, ids, at) {
  const t = snapToFrame(at, fpsOf(p));
  const ops = [];
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    const tr = trackById(p, c.trackId);
    if (tr && tr.locked) continue;
    if (c.start + TOL < t && t < clipEnd(c) - TOL) ops.push({ op: 'splitClip', id, at: r6(t) });
  }
  return ops;
}

/** Fields copied into addClip when pasting. */
function clipFields(c) {
  const o = JSON.parse(JSON.stringify(c));
  delete o.id; delete o.trackId; delete o.start;
  return o;
}

export function makeClipboard(p, ids) {
  const list = ids.map((id) => p.clips[id]).filter(Boolean).sort((a, b) => a.start - b.start);
  if (!list.length) return null;
  const base = list[0].start;
  return {
    v: 1, projectId: p.id, base,
    items: list.map((c) => {
      const tr = trackById(p, c.trackId);
      return { clip: clipFields(c), offset: c.start - base, trackId: c.trackId, role: tr ? tr.role : null, kind: kindOfType(c.type) };
    }),
  };
}

export function pasteOps(p, clip, at, { magnetic = false } = {}) {
  if (!clip || !clip.items || !clip.items.length) return { ops: [], select: [] };
  const ops = [];
  const select = [];
  const created = []; // simulated occupancy for later items: {trackId,start,end}
  const newTracks = new Map(); // key → addTrack op
  const freeWith = (trackId, s, e) => isFree(p, trackId, s, e) && !created.some((c) => c.trackId === trackId && c.start < e - TOL && c.end > s + TOL);
  for (const it of clip.items) {
    const start = r6(Math.max(0, at + it.offset));
    const end = start + (it.clip.duration || 1);
    let trackId = null;
    const orig = trackById(p, it.trackId);
    if (orig && orig.kind === it.kind && !orig.locked && freeWith(orig.id, start, end)) trackId = orig.id;
    if (!trackId) {
      const cands = (p.tracks || []).filter((t) => t.kind === it.kind && !t.locked && (t.role === it.role || !it.role));
      for (const t of cands) if (freeWith(t.id, start, end)) { trackId = t.id; break; }
    }
    if (!trackId) {
      const key = `${it.kind}:${it.role}`;
      if (!newTracks.has(key)) {
        const nt = makeNewTrack(p, it.kind, it.role === 'main' ? 'overlay' : (it.role || (it.kind === 'audio' ? 'sfx' : 'overlay')), newTrackIndex(p, it.kind, 'top', orig ? orig.id : null));
        newTracks.set(key, nt);
        ops.push(nt);
      }
      trackId = newTracks.get(key).id;
    }
    // media of another project cannot be pasted
    if (it.clip.mediaId && p.media && !p.media[it.clip.mediaId]) continue;
    const id = uid('c_');
    ops.push({ op: 'addClip', id, ...it.clip, start, track: trackId });
    created.push({ trackId, start, end });
    select.push(id);
  }
  void magnetic;
  return { ops, select };
}

export function duplicateOps(p, ids) {
  const list = ids.map((id) => p.clips[id]).filter(Boolean).sort((a, b) => a.start - b.start);
  if (!list.length) return [];
  const g0 = Math.min(...list.map((c) => c.start));
  const g1 = Math.max(...list.map(clipEnd));
  const dt = g1 - g0;
  const ops = [];
  const newTracks = new Map();
  for (const c of list) {
    const s = r6(c.start + dt), e = s + c.duration;
    let track = c.trackId;
    if (!isFree(p, track, s, e)) {
      if (!newTracks.has(track)) {
        const tr = trackById(p, track);
        const nt = makeNewTrack(p, tr.kind, tr.role === 'main' ? 'overlay' : tr.role, newTrackIndex(p, tr.kind, 'top', track));
        newTracks.set(track, nt);
        ops.push(nt);
      }
      track = newTracks.get(track).id;
    }
    ops.push({ op: 'duplicateClip', id: c.id, newId: uid('c_'), start: s, track, overlap: 'allow' });
  }
  return ops;
}

/** Detach a video clip's audio into an audio clip on an audio track + mute the video's audio. */
export function detachAudioOps(p, id) {
  const c = p.clips[id];
  if (!c || c.type !== 'video') return null;
  const m = mediaOf(p, c);
  if (m && m.hasAudio === false) return null;
  const s = c.start, e = clipEnd(c);
  const ops = [];
  let track = null;
  for (const t of p.tracks) if (t.kind === 'audio' && !t.locked && t.role !== 'music' && isFree(p, t.id, s, e)) { track = t.id; break; }
  if (!track) {
    const nt = makeNewTrack(p, 'audio', 'voice', newTrackIndex(p, 'audio', 'top'), 'שמע מקורי');
    ops.push(nt);
    track = nt.id;
  }
  const nid = uid('c_');
  ops.push({
    op: 'addClip', id: nid, type: 'audio', mediaId: c.mediaId, start: s, duration: c.duration, in: c.in || 0, speed: c.speed || 1,
    reverse: !!c.reverse, volume: c.volume == null ? 1 : c.volume, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, pan: c.pan || 0,
    name: `${c.name || (m && m.name) || 'וידאו'} — שמע`, track, overlap: 'allow',
  });
  ops.push({ op: 'updateClip', id, set: { muteAudio: true } });
  return { ops, select: [nid] };
}

/** Change speed (keeps the same source range → duration scales). Ripple on the magnetic main track. */
export function speedOps(p, ids, speed, { magnetic = false } = {}) {
  const ops = [];
  const mainT = (p.tracks || []).find((t) => t.role === 'main');
  for (const id of ids) {
    const c = p.clips[id];
    if (!c || !(c.type === 'video' || c.type === 'audio')) continue;
    const old = c.speed || 1;
    let d = r6(c.duration * old / speed);
    const m = mediaOf(p, c);
    if (m && m.duration > 0) d = Math.min(d, r6((m.duration - (c.in || 0)) / speed));
    d = Math.max(d, frameOf(p));
    ops.push({ op: 'updateClip', id, set: { speed, duration: d } });
    if (magnetic && mainT && c.trackId === mainT.id) {
      const delta = d - c.duration;
      for (const o of clipsOnTrack(p, mainT.id)) if (o.id !== id && o.start >= clipEnd(c) - TOL) ops.push({ op: 'moveClip', id: o.id, start: r6(o.start + delta), overlap: 'allow' });
    }
  }
  return ops;
}

/** Move all keyframes at clip-local time `from` to `to`. */
export function moveKeyframeOps(clip, from, to) {
  const ops = [];
  const at = keyframeTimes(clip).find((k) => Math.abs(k.t - from) < 1e-3);
  if (!at) return ops;
  const nt = r6(clamp(to, 0, clip.duration));
  for (const { prop, k } of at.props) {
    ops.push({ op: 'removeKeyframe', id: clip.id, prop, t: k.t });
    const o = { op: 'setKeyframe', id: clip.id, prop, t: nt, v: k.v };
    if (k.ease) o.ease = k.ease;
    ops.push(o);
  }
  return ops;
}
export function removeKeyframesAtOps(clip, t) {
  const at = keyframeTimes(clip).find((k) => Math.abs(k.t - t) < 1e-3);
  return at ? at.props.map(({ prop, k }) => ({ op: 'removeKeyframe', id: clip.id, prop, t: k.t })) : [];
}

export function markerUpdateOps(m, patch) {
  const next = { ...m, ...patch };
  return [{ op: 'removeMarker', id: m.id }, { op: 'addMarker', id: m.id, t: r6(next.t), label: next.label || '', color: next.color || '#f5c518' }];
}

// ───────────────────────── library payload → ops ─────────────────────────

function payloadClip(p, payload) {
  switch (payload.kind) {
    case 'media': {
      const m = p.media ? p.media[payload.mediaId] : null;
      const kind = (m && m.kind) || payload.mediaKind || 'video';
      const dur = kind === 'image' ? 3 : (m && m.duration > 0 ? m.duration : payload.duration || 3);
      return { type: kind, dur, name: (m && m.name) || payload.name || '', fields: { mediaId: payload.mediaId }, label: TYPE_LABELS[kind] };
    }
    case 'sound': {
      const len = payload.len || (payload.suggest && payload.suggest.len && payload.useSuggest ? payload.suggest.len : null);
      return { type: 'audio', dur: len || payload.duration || 2, name: payload.name || '', sound: true, role: payload.role || 'sfx', label: 'צליל' };
    }
    case 'text': {
      const pr = payload.preset || {};
      const fields = { name: pr.name || '' };
      // text presets carry their style in `text` and a demo line in `sample` (render/text-render.js)
      const content = payload.content || (pr.text && pr.text.content) || pr.sample || pr.name || 'טקסט';
      fields.text = { ...(pr.text || {}), content };
      if (pr.textAnim) fields.textAnim = pr.textAnim;
      return { type: 'text', dur: payload.duration || 3, name: pr.name || 'טקסט', fields, label: 'טקסט' };
    }
    case 'sticker': {
      const s = payload.sticker || {};
      return { type: 'sticker', dur: 2, name: payload.name || '', fields: { name: payload.name || '', sticker: { kind: s.kind || 'emoji', value: s.value, size: s.size || 220 } }, label: 'מדבקה' };
    }
    case 'shape': {
      const s = payload.shape || {};
      return { type: 'shape', dur: 2, name: payload.name || '', fields: { name: payload.name || '', shape: { ...s } }, label: 'צורה' };
    }
    case 'effect':
      return { type: 'effect', dur: payload.duration || 2, name: payload.name || '', fields: { name: payload.name || '', effects: [{ id: payload.id, params: payload.params || {}, enabled: true }] }, label: 'אפקט' };
    case 'filter':
      return { type: 'adjustment', dur: 3, name: payload.name || '', fields: { name: payload.name || '', filter: { id: payload.id, amount: 1 } }, label: 'פילטר' };
    case 'lut':
      return { type: 'adjustment', dur: 3, name: payload.name || '', fields: { name: payload.name || payload.file, lut: { file: payload.file, amount: 1 } }, label: 'LUT' };
    default:
      return null;
  }
}

/** Kinds that create a new clip (vs. modify an existing one). */
export const CREATE_KINDS = new Set(['media', 'sound', 'text', 'sticker', 'shape', 'effect', 'filter', 'lut']);
/** Kinds that apply onto a clip. */
export const APPLY_KINDS = new Set(['effect', 'transition', 'filter', 'anim', 'caption', 'lut']);

/** Does `payload` apply to `clip` (drop on clip)? */
export function canApplyTo(payload, clip) {
  if (!clip) return false;
  switch (payload.kind) {
    case 'effect': return clip.type !== 'audio';
    case 'filter': case 'lut': return ['video', 'image', 'adjustment', 'text', 'sticker', 'shape'].includes(clip.type);
    case 'transition': return clip.type !== 'audio';
    case 'caption': return clip.type === 'caption';
    case 'anim':
      if (payload.text) return clip.type === 'text' || clip.type === 'caption';
      return clip.type !== 'audio' && clip.type !== 'effect' && clip.type !== 'adjustment';
    default: return false;
  }
}

/** Estimated duration of the clip a payload would create (for drop ghosts). */
export function payloadDuration(p, payload) {
  const pc = payloadClip(p, payload);
  return pc ? pc.dur : 0;
}
export function payloadType(p, payload) {
  const pc = payloadClip(p, payload);
  return pc ? pc.type : null;
}

/** Junction (outgoing clip) for applying a transition to a clip. */
export function junctionFor(p, clip, pointerT) {
  const next = nextAdjacent(p, clip);
  const prev = prevAdjacent(p, clip);
  if (next && prev && pointerT != null) return pointerT > clip.start + clip.duration / 2 ? clip : prev;
  if (next) return clip;
  if (prev) return prev;
  return null;
}

export function transitionOps(p, outgoingId, transition, duration) {
  const a = p.clips[outgoingId];
  if (!a) return [];
  const b = nextAdjacent(p, a);
  let d = duration || 0.5;
  if (b) d = Math.min(d, a.duration, b.duration);
  return [{ op: 'setTransition', id: outgoingId, transition, duration: r6(Math.max(0.05, d)) }];
}

/**
 * Apply a payload onto a clip (or the clip set).
 * @returns {{ops, summary}|null}
 */
export function applyPayloadOps(p, payload, clipIds, { pointerT } = {}) {
  const clips = clipIds.map((id) => p.clips[id]).filter((c) => c && canApplyTo(payload, c));
  if (!clips.length) return null;
  const ops = [];
  let summary = '';
  switch (payload.kind) {
    case 'effect':
      for (const c of clips) ops.push({ op: 'addEffect', id: c.id, effect: payload.id, ...(payload.params ? { params: payload.params } : {}) });
      summary = `אפקט "${payload.name || payload.id}"`;
      break;
    case 'filter':
      for (const c of clips) ops.push({ op: 'updateClip', id: c.id, set: { 'filter.id': payload.id, 'filter.amount': payload.amount != null ? payload.amount : 1 } });
      summary = `פילטר "${payload.name || payload.id}"`;
      break;
    case 'lut':
      for (const c of clips) ops.push({ op: 'updateClip', id: c.id, set: { 'lut.file': payload.file, 'lut.amount': 1 } });
      summary = `LUT "${payload.name || payload.file}"`;
      break;
    case 'transition': {
      const done = new Set();
      for (const c of clips) {
        const j = junctionFor(p, c, clips.length === 1 ? pointerT : null);
        if (!j || done.has(j.id)) continue;
        done.add(j.id);
        ops.push(...transitionOps(p, j.id, payload.id, payload.duration || payload.defaultDuration || 0.5));
      }
      summary = `מעבר "${payload.name || payload.id}"`;
      break;
    }
    case 'anim': {
      const slot = payload.slot || 'in';
      for (const c of clips) {
        if (payload.text) ops.push({ op: 'updateClip', id: c.id, set: { [`textAnim.${slot}`]: payload.id } });
        else {
          const key = slot === 'in' ? 'animIn' : slot === 'out' ? 'animOut' : 'animLoop';
          const set = { [`${key}.id`]: payload.id };
          if (slot !== 'loop' && payload.duration) set[`${key}.duration`] = payload.duration;
          ops.push({ op: 'updateClip', id: c.id, set });
        }
      }
      summary = `אנימציה "${payload.name || payload.id}"`;
      break;
    }
    case 'caption': {
      const d = payload.defaults || {};
      for (const c of clips) {
        const set = { 'caption.style': payload.id };
        if (d.activeColor) set['caption.activeColor'] = d.activeColor;
        if (d.hotColor) set['caption.hotColor'] = d.hotColor;
        const op = { op: 'updateClip', id: c.id, set };
        if (d.text) op.merge = { text: d.text };
        ops.push(op);
      }
      summary = `סגנון כתוביות "${payload.name || payload.id}"`;
      break;
    }
    default: return null;
  }
  return ops.length ? { ops, summary } : null;
}

/**
 * Insert a library payload as a new clip at time t.
 * opts: { t, hoverTrackId?, zone?, magnetic }
 * @returns {{ops, summary, select}|null}
 */
export function insertPayloadOps(p, payload, { t = 0, hoverTrackId = null, zone = null, magnetic = true } = {}) {
  const pc = payloadClip(p, payload);
  if (!pc) return null;
  const start = r6(Math.max(0, snapToFrame(t, fpsOf(p))));
  const ch = chooseTrack(p, { type: pc.type, start, dur: pc.dur, hoverTrackId, zone, magnetic, role: pc.role, name: pc.name });
  const ops = [];
  let trackId = ch.trackId;
  let at = start;
  if (ch.newTrack) { ops.push(ch.newTrack); trackId = ch.newTrack.id; }
  if (ch.insert) {
    at = ch.insert.at;
    // push following main-track clips right by the new clip's duration (descending order)
    const after = clipsOnTrack(p, ch.insert.trackId).filter((c) => c.start >= at - TOL).sort((a, b) => b.start - a.start);
    for (const c of after) ops.push({ op: 'moveClip', id: c.id, start: r6(c.start + pc.dur), overlap: 'allow' });
  }
  const id = uid('c_');
  if (pc.sound) {
    const op = { op: 'sfx', id, sound: payload.id || payload.abs, at, track: trackId };
    if (payload.gainDb != null) op.gain_db = payload.gainDb;
    else if (payload.suggest && payload.suggest.gainDb != null && payload.role === 'sfx') op.gain_db = payload.suggest.gainDb;
    if (payload.len) op.len = payload.len;
    if (payload.role && payload.role !== 'sfx') {
      // music / voice from the library: plain audio clip by absolute path (server imports it)
      ops.push({ op: 'addClip', id, type: 'audio', path: payload.abs, start: at, track: trackId, name: payload.name || '' });
    } else ops.push(op);
  } else {
    const op = { op: 'addClip', id, type: pc.type, start: at, track: trackId, ...pc.fields };
    if (pc.type === 'image' || !isMediaType(pc.type)) op.duration = pc.dur;
    ops.push(op);
  }
  const where = ch.newTrack ? ` (רצועה חדשה)` : '';
  return { ops, summary: `הוספת ${pc.label}${pc.name ? ` "${pc.name}"` : ''}${where}`, select: [id], trackId, at };
}
