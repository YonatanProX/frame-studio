// render/sources.js — Frame Studio SourceProvider (agent R).
//
// Supplies TexImageSources (video elements / ImageBitmaps / canvas copies) to the Compositor.
//  * preview: a pool of muted <video playsinline preload=auto> elements on proxy URLs, one slot per active clip
//    (two clips of the same media — e.g. both halves of a split joined by a transition — get two elements).
//    getSync() never blocks: returns the element when it shows the requested frame (±1.5 frames), otherwise the
//    last good canvas copy while a (coalesced) seek runs. startPlayback/tick/stopPlayback run native playback with
//    playbackRate = speed and keep drift < 0.08 s (rate nudging for small drift, re-seek for large).
//  * export (and exact stills in preview): getExact() seeks, awaits 'seeked' + requestVideoFrameCallback
//    (with timeout fallbacks) and resolves with the element showing exactly that frame.
//  * images: fetched and decoded once into a premultiplied ImageBitmap (EXIF orientation applied, capped 4096 px).
// Dispatches a 'frame' Event whenever new pixels became available (seek done, image decoded) — the Compositor
// listens and redraws the preview.
//
// Node-importable: DOM is touched only inside methods.

import { findTransitionPairs, clipVisualRange } from './transitions-gl.js';

const Base = typeof EventTarget === 'function' ? EventTarget : class {
  addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hasDom = () => typeof document !== 'undefined' && !!document.createElement;
const MEDIA_CLIPS = new Set(['video', 'image']);

export class SourceProvider extends Base {
  /**
   * @param opts { mode:"preview"|"export", projectId, apiBase:"", maxVideos?, seekTimeout?:4000 ms,
   *               frameTimeout?:50 ms (requestVideoFrameCallback fallback), loadTimeout?:20000 ms,
   *               seekEpsilon?:0.001 s, maxImageSize?:4096, urlFor?(media, kind) → url }
   */
  constructor({ mode = 'preview', projectId = '', apiBase = '', maxVideos, seekTimeout = 4000, frameTimeout = 50,
    loadTimeout = 20000, seekEpsilon = 0.001, maxImageSize = 4096, urlFor = null } = {}) {
    super();
    this.mode = mode === 'export' ? 'export' : 'preview';
    this.projectId = projectId || '';
    this.apiBase = apiBase || '';
    this.maxVideos = maxVideos || (this.mode === 'export' ? 16 : 10);
    this.seekTimeout = seekTimeout;
    this.frameTimeout = frameTimeout;
    this.loadTimeout = loadTimeout;
    this.seekEpsilon = seekEpsilon;
    this.maxImageSize = maxImageSize;
    this.urlFor = typeof urlFor === 'function' ? urlFor : null;
    this.maxDrift = 0.08;
    this.project = null;
    this.playing = false;
    this.slots = new Map();   // clipId → slot (assigned)
    this.free = new Map();    // mediaId → [slot] (loaded, unassigned)
    this.images = new Map();  // mediaId → { url, bitmap, error, promise }
    this.stats = { seeks: 0, exactSeeks: 0, frameCallbacks: 0, frameTimeouts: 0, seekTimeouts: 0, reseeks: 0 };
    this._struct = null;
    this._host = null;
    this._emitQueued = false;
    this._lastEvict = 0;
    this._disposed = false;
  }

  /* ------------------------------------------------------------------ project */

  setProject(project) {
    this.project = project || null;
    this._struct = null;
    if (!project) return;
    if (project.id) this.projectId = project.id;
    const media = project.media || {};
    // media URL changes (proxy became ready) → reload those elements keeping their position
    for (const slot of this._allSlots()) {
      const m = media[slot.mediaId];
      if (!m) { this._destroySlot(slot); continue; }
      const url = this.mediaUrl(m);
      if (url !== slot.url) this._setSrc(slot, url);
    }
    // clips that vanished / changed media → release their slots
    for (const [clipId, slot] of [...this.slots]) {
      const c = project.clips && project.clips[clipId];
      if (!c || c.type !== 'video' || c.mediaId !== slot.mediaId) this._releaseSlot(clipId);
    }
    for (const [id, e] of [...this.images]) {
      const m = media[id];
      if (!m) { this._closeImage(e); this.images.delete(id); }
    }
  }

  /** URL of a media file. kind: "auto" (proxy for video when available) | "file". */
  mediaUrl(media, kind = 'auto') {
    if (this.urlFor) {
      try { const u = this.urlFor(media, kind); if (u) return u; } catch (_) { /* fall back */ }
    }
    const base = `${this.apiBase}/api/projects/${encodeURIComponent(this.projectId)}/media/${encodeURIComponent(media.id)}`;
    if (kind === 'file' || media.kind === 'image') return `${base}/file`;
    return `${base}/${media.proxy ? 'proxy' : 'file'}`;
  }

  /* ------------------------------------------------------------------ preview: synchronous frames */

  /** → TexImageSource | null. Never blocks; schedules a seek when the element is elsewhere. */
  getSync(clip, sourceTime) {
    if (!clip || !this.project || this._disposed) return null;
    const media = this._media(clip);
    if (!media) return null;
    if (clip.type === 'image' || media.kind === 'image') {
      const e = this._imageEntry(media);
      return e ? e.bitmap : null;
    }
    if (!hasDom()) return null;
    const slot = this._slotFor(clip, media);
    if (!slot) return null;
    slot.lastUsed = now();
    this._watchdog(slot);
    const el = slot.el;
    const fps = this._fps(media);
    const target = this._clampTime(sourceTime, media, slot, fps);
    const nativePlaying = this.playing && slot.playingNative && !el.paused;
    if (!nativePlaying) {
      const ref = slot.seeking ? slot.target : el.currentTime;
      if (Math.abs(ref - target) > 0.3 / fps || (slot.seeking && slot.pending != null)) this._seek(slot, target);
    }
    const ready = el.readyState >= 2 && !el.seeking && !slot.seeking;
    const drift = Math.abs(el.currentTime - target);
    if (ready && drift <= 1.5 / fps) return el;
    if (ready && nativePlaying && drift <= 0.25) return el;
    if (slot.lastGood) return slot.lastGood;
    return ready ? el : null;
  }

  /* ------------------------------------------------------------------ exact frames */

  /** Seek & await the exact frame. Resolves with the element (or ImageBitmap) — null on failure. */
  async getExact(clip, sourceTime) {
    if (!clip || !this.project || this._disposed) return null;
    const media = this._media(clip);
    if (!media) return null;
    if (clip.type === 'image' || media.kind === 'image') {
      const e = this._imageEntry(media);
      return e ? e.promise : null;
    }
    if (!hasDom()) return null;
    const slot = this._slotFor(clip, media);
    if (!slot) return null;
    slot.lastUsed = now();
    const run = async () => {
      if (this._disposed || slot.destroyed) return null;
      slot.exactBusy = (slot.exactBusy || 0) + 1;
      try {
        const ok = await this._whenLoaded(slot, this.loadTimeout);
        const el = slot.el;
        if (!ok) return el.readyState >= 2 ? el : null;
        const fps = this._fps(media);
        const target = this._clampTime(num(sourceTime, 0) + this.seekEpsilon, media, slot, fps);
        if (slot.playingNative && !el.paused) { try { el.pause(); } catch (_) { /* ignore */ } slot.playingNative = false; }
        slot.pending = null;
        if (slot.seeking) await this._waitSeeked(slot, this.seekTimeout);
        const there = el.readyState >= 2 && !el.seeking && Math.abs(el.currentTime - target) < 1e-4 && slot.exactAt === target;
        if (!there) {
          await this._seekExact(slot, target);
          slot.exactAt = target;
        }
        return el.readyState >= 2 ? el : (slot.lastGood || null);
      } finally {
        slot.exactBusy--;
      }
    };
    slot.chain = (slot.chain || Promise.resolve()).then(run, run);
    return slot.chain;
  }

  /* ------------------------------------------------------------------ preview playback */

  startPlayback(t, project) {
    if (project && project !== this.project) this.setProject(project);
    this.playing = true;
    this.tick(t);
  }

  stopPlayback() {
    this.playing = false;
    for (const slot of this._allSlots()) {
      slot.startAfterSeek = null;
      if (slot.playingNative || !slot.el.paused) { try { slot.el.pause(); } catch (_) { /* ignore */ } }
      slot.playingNative = false;
      try { slot.el.playbackRate = 1; } catch (_) { /* ignore */ }
    }
  }

  /** Called by the viewer every animation frame with the master clock time (timeline seconds). */
  tick(t) {
    if (!this.project || !hasDom() || this._disposed) return;
    t = num(t, 0);
    const st = this._structure();
    const keep = new Set();
    for (const it of st.videos) {
      if (t >= it.s - 1e-9 && t < it.e - 1e-9) {
        const media = this._media(it.clip);
        if (!media) continue;
        const slot = this._slotFor(it.clip, media);
        if (!slot) continue;
        keep.add(slot);
        slot.lastUsed = now();
        this._drive(slot, it.clip, media, t);
      }
    }
    // pre-roll clips that start within the next 1.2 s so their first frame is decoded
    for (const it of st.videos) {
      if (it.s > t && it.s <= t + 1.2) {
        const media = this._media(it.clip);
        if (!media) continue;
        const slot = this._slotFor(it.clip, media);
        if (!slot || keep.has(slot)) continue;
        keep.add(slot);
        slot.lastUsed = now();
        const fps = this._fps(media);
        const target = this._clampTime(this._srcTime(it.clip, it.s), media, slot, fps);
        if (!slot.playingNative && !slot.seeking && Math.abs(slot.el.currentTime - target) > 0.5 / fps) this._seek(slot, target);
      }
    }
    for (const slot of this.slots.values()) if (!keep.has(slot)) this._pauseSlot(slot);
    this._maybeEvict(t);
  }

  /** Warm up sources needed soon (videos within ~3 s, images within ~10 s). */
  preloadAround(t) {
    if (!this.project || this._disposed) return;
    t = num(t, 0);
    const st = this._structure();
    if (hasDom()) {
      for (const it of st.videos) {
        if (it.e < t - 0.5 || it.s > t + 3) continue;
        const media = this._media(it.clip);
        if (!media) continue;
        const slot = this._slotFor(it.clip, media);
        if (!slot) continue;
        slot.lastUsed = now();
        if (!this.playing && slot.el.paused && !slot.seeking) {
          const fps = this._fps(media);
          const target = this._clampTime(this._srcTime(it.clip, Math.max(t, it.s)), media, slot, fps);
          if (Math.abs(slot.el.currentTime - target) > 0.5 / fps) this._seek(slot, target);
        }
      }
    }
    for (const it of st.images) {
      if (it.e < t - 2 || it.s > t + 10) continue;
      const media = this._media(it.clip);
      if (media) this._imageEntry(media);
    }
    this._maybeEvict(t);
  }

  /** Resolves when every source needed at time t has data (handy before the first export frame). */
  async whenReady(t, timeoutMs = 15000) {
    if (!this.project) return true;
    const st = this._structure();
    const jobs = [];
    for (const it of st.images) if (t >= it.s && t < it.e) { const m = this._media(it.clip); if (m) jobs.push(this._imageEntry(m).promise); }
    if (hasDom()) {
      for (const it of st.videos) {
        if (t >= it.s && t < it.e) {
          const m = this._media(it.clip);
          const slot = m && this._slotFor(it.clip, m);
          if (slot) jobs.push(this._whenLoaded(slot, timeoutMs));
        }
      }
    }
    await Promise.race([Promise.all(jobs), delay(timeoutMs)]);
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this.stopPlayback();
    this._disposed = true;
    for (const slot of this._allSlots()) this._destroySlot(slot);
    this.slots.clear();
    this.free.clear();
    for (const e of this.images.values()) this._closeImage(e);
    this.images.clear();
    if (this._host && this._host.parentNode) this._host.parentNode.removeChild(this._host);
    this._host = null;
    this.project = null;
  }

  /* ------------------------------------------------------------------ internals: structure */

  _media(clip) {
    if (!clip || !clip.mediaId || !this.project || !this.project.media) return null;
    return this.project.media[clip.mediaId] || null;
  }

  _fps(media) {
    const f = num(media && media.fps, 0);
    if (f > 1 && f < 1000) return f;
    return num(this.project && this.project.settings && this.project.settings.fps, 30) || 30;
  }

  _srcTime(clip, t) {
    const sp = clip.speed > 0 ? clip.speed : 1;
    const local = t - (clip.start || 0);
    return clip.reverse ? (clip.in || 0) + ((clip.duration || 0) - local) * sp : (clip.in || 0) + local * sp;
  }

  /** Clamp to [0, last frame] (half a frame before the end so the last frame stays visible). */
  _clampTime(st, media, slot, fps) {
    let dur = num(media && media.duration, 0);
    const ed = slot && slot.el ? slot.el.duration : NaN;
    if (Number.isFinite(ed) && ed > 0) dur = dur > 0 ? Math.min(dur, ed) : ed;
    st = num(st, 0);
    if (dur > 0) return clamp(st, 0, Math.max(0, dur - 0.5 / fps));
    return Math.max(0, st);
  }

  _structure() {
    if (this._struct && this._struct.project === this.project) return this._struct;
    const p = this.project;
    const fps = num(p.settings && p.settings.fps, 30) || 30;
    const byTrack = new Map();
    for (const c of Object.values(p.clips || {})) {
      if (!c || c.disabled) continue;
      if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
      byTrack.get(c.trackId).push(c);
    }
    const videos = [];
    const images = [];
    for (const track of p.tracks || []) {
      if (!track || track.kind === 'audio' || track.hidden) continue;
      const clips = byTrack.get(track.id) || [];
      const pairs = findTransitionPairs(clips, fps);
      for (const c of clips) {
        if (!MEDIA_CLIPS.has(c.type) || !c.mediaId) continue;
        const [s, e] = clipVisualRange(c, pairs);
        (c.type === 'video' ? videos : images).push({ clip: c, s, e });
      }
    }
    this._struct = { project: p, videos, images };
    return this._struct;
  }

  /* ------------------------------------------------------------------ internals: video slots */

  _allSlots() {
    const out = new Set(this.slots.values());
    for (const list of this.free.values()) for (const s of list) out.add(s);
    return [...out];
  }

  _hostEl() {
    if (this._host && this._host.isConnected) return this._host;
    if (!hasDom() || !document.body) return null;
    const d = document.createElement('div');
    d.setAttribute('aria-hidden', 'true');
    d.setAttribute('data-frame-studio', 'sources');
    d.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(d);
    this._host = d;
    return d;
  }

  _crossOrigin(url) {
    try {
      if (typeof location === 'undefined' || !/^https?:/i.test(url)) return false;
      return new URL(url, location.href).origin !== location.origin;
    } catch (_) { return false; }
  }

  _createSlot(media, url) {
    if (!hasDom()) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.defaultMuted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('muted', '');
    el.preload = 'auto';
    el.controls = false;
    el.loop = false;
    try { el.disablePictureInPicture = true; el.disableRemotePlayback = true; } catch (_) { /* ignore */ }
    if (this._crossOrigin(url)) el.crossOrigin = 'anonymous';
    el.style.cssText = 'width:2px;height:2px;';
    const slot = {
      el, mediaId: media.id, url, clipId: null, seeking: false, target: null, pending: null, seekStart: 0, exactBusy: 0,
      lastGood: null, lastGoodCtx: null, playingNative: false, startAfterSeek: null, error: null,
      lastUsed: now(), releasedAt: 0, exactAt: null, chain: null, destroyed: false, seekWaiters: [],
    };
    this._resetLoaded(slot);
    slot.onSeeked = () => this._onSeeked(slot);
    slot.onLoaded = () => { slot.error = null; this._bump(slot); slot.resolveLoaded(true); this._emitFrame(); };
    slot.onMeta = () => {
      if (slot.pending != null && !slot.seeking) { const p = slot.pending; slot.pending = null; this._seek(slot, p); }
    };
    slot.onError = () => {
      slot.error = el.error || new Error('שגיאת וידאו');
      slot.seeking = false;
      slot.resolveLoaded(false);
      this._flushSeekWaiters(slot);
    };
    el.addEventListener('seeked', slot.onSeeked);
    el.addEventListener('loadeddata', slot.onLoaded);
    el.addEventListener('loadedmetadata', slot.onMeta);
    el.addEventListener('error', slot.onError);
    const host = this._hostEl();
    if (host) host.appendChild(el);
    el.src = url;
    return slot;
  }

  _resetLoaded(slot) {
    slot.loaded = new Promise((res) => { slot.resolveLoaded = res; });
  }

  _setSrc(slot, url) {
    const el = slot.el;
    const keepT = el.currentTime || 0;
    slot.url = url;
    slot.seeking = false;
    slot.exactAt = null;
    slot.pending = keepT;
    slot.error = null;
    this._resetLoaded(slot);
    this._flushSeekWaiters(slot);
    try { el.src = url; } catch (_) { /* ignore */ }
  }

  _slotFor(clip, media) {
    let s = this.slots.get(clip.id);
    if (s && s.mediaId === media.id && !s.destroyed) return s;
    if (s) this._releaseSlot(clip.id);
    const list = this.free.get(media.id);
    if (list && list.length) {
      // prefer the free element whose position is closest to where this clip starts
      let best = 0, bestD = Infinity;
      const want = clip.in || 0;
      for (let i = 0; i < list.length; i++) { const d = Math.abs((list[i].el.currentTime || 0) - want); if (d < bestD) { bestD = d; best = i; } }
      s = list.splice(best, 1)[0];
      if (!list.length) this.free.delete(media.id);
      const url = this.mediaUrl(media);
      if (url !== s.url) this._setSrc(s, url);
    } else {
      if (this._allSlots().length >= this.maxVideos) this._evictOne();
      s = this._createSlot(media, this.mediaUrl(media));
      if (!s) return null;
    }
    s.clipId = clip.id;
    s.exactAt = null;
    this.slots.set(clip.id, s);
    return s;
  }

  _releaseSlot(clipId) {
    const s = this.slots.get(clipId);
    if (!s) return;
    this.slots.delete(clipId);
    this._pauseSlot(s);
    s.clipId = null;
    s.releasedAt = now();
    if (s.destroyed) return;
    if (!this.free.has(s.mediaId)) this.free.set(s.mediaId, []);
    this.free.get(s.mediaId).push(s);
  }

  _destroySlot(s) {
    if (!s || s.destroyed) return;
    s.destroyed = true;
    if (s.clipId && this.slots.get(s.clipId) === s) this.slots.delete(s.clipId);
    const list = this.free.get(s.mediaId);
    if (list) { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); if (!list.length) this.free.delete(s.mediaId); }
    const el = s.el;
    el.removeEventListener('seeked', s.onSeeked);
    el.removeEventListener('loadeddata', s.onLoaded);
    el.removeEventListener('loadedmetadata', s.onMeta);
    el.removeEventListener('error', s.onError);
    try { el.pause(); } catch (_) { /* ignore */ }
    try { el.removeAttribute('src'); el.load(); } catch (_) { /* ignore */ }
    if (el.parentNode) el.parentNode.removeChild(el);
    s.resolveLoaded(false);
    this._flushSeekWaiters(s);
    s.lastGood = null;
    s.lastGoodCtx = null;
  }

  _evictOne() {
    let victim = null;
    for (const list of this.free.values()) for (const s of list) if (!victim || s.releasedAt < victim.releasedAt) victim = s;
    if (!victim) {
      const t = now();
      for (const s of this.slots.values()) if (t - s.lastUsed > 1000 && (!victim || s.lastUsed < victim.lastUsed)) victim = s;
      if (victim) this._releaseSlot(victim.clipId);
    }
    if (victim) this._destroySlot(victim);
  }

  _maybeEvict(t) {
    const n = now();
    if (n - this._lastEvict < 1500) return;
    this._lastEvict = n;
    const st = this._structure();
    const near = new Set();
    for (const it of st.videos) if (it.e >= t - 3 && it.s <= t + 5) near.add(it.clip.id);
    for (const [clipId, s] of [...this.slots]) {
      if (!near.has(clipId) && n - s.lastUsed > 3000) this._releaseSlot(clipId);
    }
    const all = this._allSlots();
    if (all.length > Math.ceil(this.maxVideos / 2)) {
      for (const list of [...this.free.values()]) {
        for (const s of [...list]) if (n - s.releasedAt > 20000) this._destroySlot(s);
      }
    }
  }

  _pauseSlot(slot) {
    slot.startAfterSeek = null;
    if (!slot.el.paused) { try { slot.el.pause(); } catch (_) { /* ignore */ } }
    slot.playingNative = false;
  }

  _bump(slot) { slot.el._fsVersion = (slot.el._fsVersion | 0) + 1; }

  _watchdog(slot) {
    if (slot.seeking && now() - slot.seekStart > this.seekTimeout) {
      this.stats.seekTimeouts++;
      slot.seeking = false;
      this._flushSeekWaiters(slot);
      if (slot.pending != null) { const p = slot.pending; slot.pending = null; this._seek(slot, p); }
    }
  }

  /** Copy the currently shown frame into the slot's canvas (shown while the next seek runs). */
  _capture(slot) {
    const el = slot.el;
    const w = el.videoWidth, h = el.videoHeight;
    if (!w || !h || el.readyState < 2) return;
    const k = Math.min(1, 960 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    let c = slot.lastGood;
    if (!c) {
      c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(cw, ch) : document.createElement('canvas');
      slot.lastGood = c;
      slot.lastGoodCtx = c.getContext('2d', { alpha: false });
    }
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    try {
      slot.lastGoodCtx.drawImage(el, 0, 0, cw, ch);
      c._fsVersion = (c._fsVersion | 0) + 1;
      c._fsW = w; c._fsH = h;
    } catch (_) { /* not ready / tainted */ }
  }

  _seek(slot, time) {
    if (slot.destroyed || slot.exactBusy > 0) return;   // an exact seek owns the element right now
    const el = slot.el;
    if (slot.seeking) { slot.pending = Math.abs(slot.target - time) < 1e-6 ? null : time; return; }
    if (el.readyState < 1) { slot.pending = time; return; }
    if (el.readyState >= 2 && !el.seeking) this._capture(slot);
    slot.seeking = true;
    slot.target = time;
    slot.pending = null;
    slot.seekStart = now();
    slot.exactAt = null;
    this.stats.seeks++;
    try { el.currentTime = time; } catch (_) { slot.seeking = false; }
  }

  _onSeeked(slot) {
    slot.seeking = false;
    this._bump(slot);
    const el = slot.el;
    if (slot.pending != null) {
      const p = slot.pending;
      slot.pending = null;
      if (Math.abs(p - el.currentTime) > 1e-4) { this._seek(slot, p); if (slot.seeking) return; }
    }
    this._flushSeekWaiters(slot);
    if (slot.startAfterSeek && this.playing && !slot.destroyed) {
      try { el.playbackRate = slot.startAfterSeek; } catch (_) { /* ignore */ }
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => {});
      slot.playingNative = true;
    }
    slot.startAfterSeek = null;
    this._emitFrame();
  }

  _flushSeekWaiters(slot) {
    const w = slot.seekWaiters;
    slot.seekWaiters = [];
    for (const fn of w) { try { fn(); } catch (_) { /* ignore */ } }
  }

  _waitSeeked(slot, timeout) {
    if (!slot.seeking) return Promise.resolve();
    return new Promise((res) => {
      const to = setTimeout(res, timeout);
      slot.seekWaiters.push(() => { clearTimeout(to); res(); });
    });
  }

  _whenLoaded(slot, timeout) {
    if (slot.el.readyState >= 2) return Promise.resolve(true);
    if (slot.error) return Promise.resolve(false);
    return Promise.race([slot.loaded, delay(timeout).then(() => slot.el.readyState >= 2)]);
  }

  _seekExact(slot, target) {
    const el = slot.el;
    this.stats.exactSeeks++;
    return new Promise((resolve) => {
      let done = false;
      let to1 = null, to2 = null;
      const finish = (how) => {
        if (done) return;
        done = true;
        clearTimeout(to1); clearTimeout(to2);
        el.removeEventListener('seeked', onSeeked);
        if (how === 'rvfc') this.stats.frameCallbacks++;
        else if (how === 'frame-timeout') this.stats.frameTimeouts++;
        else if (how === 'seek-timeout') this.stats.seekTimeouts++;
        resolve();
      };
      const onSeeked = () => {
        el.removeEventListener('seeked', onSeeked);
        // Chrome already exposes the seeked frame to texImage2D at 'seeked'; requestVideoFrameCallback is an extra
        // guarantee. When this browser never delivers callbacks for hidden elements, stop paying the timeout.
        const st = this.stats;
        const wait = st.frameCallbacks === 0 && st.frameTimeouts >= 8 ? 0 : this.frameTimeout;
        if (typeof el.requestVideoFrameCallback === 'function' && wait > 0) {
          const t0 = now();
          to2 = setTimeout(() => finish('frame-timeout'), wait);
          try {
            el.requestVideoFrameCallback(() => {
              const dt = now() - t0;
              st.frameCallbackMs = st.frameCallbackMs == null ? dt : st.frameCallbackMs * 0.9 + dt * 0.1;
              finish('rvfc');
            });
          } catch (_) { finish('no-rvfc'); }
        } else finish('no-rvfc');
      };
      el.addEventListener('seeked', onSeeked);
      to1 = setTimeout(() => { slot.seeking = false; finish('seek-timeout'); }, this.seekTimeout);
      slot.seeking = true;
      slot.target = target;
      slot.pending = null;
      slot.seekStart = now();
      try { el.currentTime = target; } catch (_) { slot.seeking = false; finish('error'); }
    });
  }

  /** Native playback driver for one active clip. */
  _drive(slot, clip, media, t) {
    const el = slot.el;
    const fps = this._fps(media);
    const raw = this._srcTime(clip, t);
    const target = this._clampTime(raw, media, slot, fps);
    const speed = clip.speed > 0 ? clip.speed : 1;
    const hold = Math.abs(raw - target) > 1e-6;   // before the media start / after its end → frozen frame
    const canNative = this.playing && !clip.reverse && speed >= 0.0625 && speed <= 16 && !hold;
    if (!canNative || el.readyState < 2) {
      if (slot.playingNative || !el.paused) { try { el.pause(); } catch (_) { /* ignore */ } slot.playingNative = false; }
      if (slot.seeking ? Math.abs(slot.target - target) > 0.5 / fps : Math.abs(el.currentTime - target) > 0.5 / fps) this._seek(slot, target);
      return;
    }
    if (slot.seeking) return;
    const drift = el.currentTime - target;
    if (el.paused || !slot.playingNative) {
      if (Math.abs(drift) > 1.0 / fps) {
        slot.startAfterSeek = speed;
        this._seek(slot, target + Math.min(0.12, 0.04 * speed));
        return;
      }
      try { el.playbackRate = speed; } catch (_) { /* ignore */ }
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => { slot.playingNative = false; });
      slot.playingNative = true;
      return;
    }
    if (Math.abs(drift) > this.maxDrift) {
      this.stats.reseeks++;
      this._seek(slot, target + Math.min(0.15, 0.05 * speed));
      return;
    }
    let rate = speed;
    if (Math.abs(drift) > 0.012) rate = clamp(speed * (1 - drift * 2.5), speed * 0.8, speed * 1.2);
    if (Math.abs(el.playbackRate - rate) > 1e-3) { try { el.playbackRate = rate; } catch (_) { /* ignore */ } }
  }

  /* ------------------------------------------------------------------ internals: images */

  _imageEntry(media) {
    const url = this.mediaUrl(media, 'file');
    let e = this.images.get(media.id);
    if (e && e.url === url && !e.error) return e;
    if (e) this._closeImage(e);
    e = { url, bitmap: null, error: null, promise: null };
    e.promise = this._decodeImage(url).then((bmp) => {
      if (this._disposed || this.images.get(media.id) !== e) { if (bmp && bmp.close) bmp.close(); return null; }
      e.bitmap = bmp;
      this._emitFrame();
      return bmp;
    }).catch((err) => { e.error = err; return null; });
    this.images.set(media.id, e);
    return e;
  }

  async _decodeImage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`טעינת תמונה נכשלה (${res.status})`);
    const blob = await res.blob();
    const opts = { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default', imageOrientation: 'from-image' };
    let bmp = await createImageBitmap(blob, opts);
    const W = bmp.width, H = bmp.height;
    if (Math.max(W, H) > this.maxImageSize) {
      const k = this.maxImageSize / Math.max(W, H);
      const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(W * k)), resizeHeight: Math.max(1, Math.round(H * k)), resizeQuality: 'high', premultiplyAlpha: 'premultiply' });
      bmp.close();
      bmp = small;
    }
    try { bmp._fsW = W; bmp._fsH = H; } catch (_) { /* non-extensible */ }
    return bmp;
  }

  _closeImage(e) {
    if (e && e.bitmap && typeof e.bitmap.close === 'function') { try { e.bitmap.close(); } catch (_) { /* ignore */ } }
    if (e) e.bitmap = null;
  }

  _emitFrame() {
    if (this._emitQueued || this._disposed) return;
    this._emitQueued = true;
    const fire = () => {
      this._emitQueued = false;
      if (this._disposed) return;
      try { this.dispatchEvent(new Event('frame')); } catch (_) { /* ignore */ }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(fire); else Promise.resolve().then(fire);
  }
}

export default SourceProvider;
