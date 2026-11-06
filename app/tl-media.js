// Frame Studio — timeline media caches: thumbnails (1 per second), waveform peaks, beat detection (agent L).
// Browser-only at call time (Image/fetch), safe to import anywhere.

import { api } from './api.js';

const MAX_PARALLEL_THUMBS = 6;

function enc(s) { return encodeURIComponent(s); }

export class MediaCache {
  constructor(onUpdate) {
    this.onUpdate = onUpdate || (() => {});
    this.thumbs = new Map();   // key → {img, state:"loading"|"ok"|"error"}
    this.queue = [];           // keys waiting
    this.loading = 0;
    this.peaks = new Map();    // key → {state, rate, data:Float32Array, mip:[Float32Array…]}
    this.beats = new Map();    // key → number[] (source seconds)
    this.version = new Map();  // mediaId → bump counter (invalidation)
    this.projectId = null;
    this._notifyScheduled = false;
    this.rev = 0;              // bumps whenever new data arrives
    this.mrev = new Map();     // mediaId → data revision (canvas cache key per clip)
  }

  mediaRev(id) { return this.mrev.get(id) || 0; }
  _bump(id) { this.mrev.set(id, (this.mrev.get(id) || 0) + 1); this.rev++; }

  setProject(projectId) {
    if (projectId !== this.projectId) {
      this.projectId = projectId;
      this.thumbs.clear(); this.peaks.clear(); this.beats.clear(); this.queue = []; this.version.clear();
    }
  }

  /** Drop caches for one media (e.g. it became "ready"). */
  invalidate(mediaId) {
    this.version.set(mediaId, (this.version.get(mediaId) || 0) + 1);
    for (const k of [...this.thumbs.keys()]) if (k.startsWith(mediaId + '|')) this.thumbs.delete(k);
    for (const k of [...this.peaks.keys()]) if (k.startsWith(mediaId + '|')) this.peaks.delete(k);
    for (const k of [...this.beats.keys()]) if (k.startsWith(mediaId + '|')) this.beats.delete(k);
    this.queue = this.queue.filter((q) => !q.key.startsWith(mediaId + '|'));
    this._bump(mediaId);
  }

  _notify() {
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    requestAnimationFrame(() => { this._notifyScheduled = false; this.onUpdate(); });
  }

  /** Thumbnail image for media at whole second `sec` (null while loading). */
  thumb(media, sec) {
    if (!media || !this.projectId) return null;
    const v = this.version.get(media.id) || 0;
    const s = media.kind === 'image' ? 0 : Math.max(0, Math.floor(sec));
    const key = `${media.id}|${v}|${s}`;
    const e = this.thumbs.get(key);
    if (e) return e.state === 'ok' ? e.img : null;
    if (media.status && media.status !== 'ready' && media.kind !== 'image') return null;
    const url = media.kind === 'image'
      ? api.url(`/api/projects/${enc(this.projectId)}/media/${enc(media.id)}/thumb?t=0`)
      : api.url(`/api/projects/${enc(this.projectId)}/media/${enc(media.id)}/thumb?t=${s}`);
    const fallback = media.kind === 'image' ? api.url(`/api/projects/${enc(this.projectId)}/media/${enc(media.id)}/file`) : null;
    this.thumbs.set(key, { img: null, state: 'queued' });
    this.queue.push({ key, url, fallback });
    this._pump();
    return null;
  }

  /** Nearest already-loaded thumbnail (for smooth display while others load). */
  nearestThumb(media, sec) {
    const v = this.version.get(media.id) || 0;
    const s = Math.max(0, Math.floor(sec));
    for (let d = 1; d < 30; d++) {
      for (const c of [s - d, s + d]) {
        const e = this.thumbs.get(`${media.id}|${v}|${c}`);
        if (e && e.state === 'ok') return e.img;
      }
    }
    return null;
  }

  _pump() {
    while (this.loading < MAX_PARALLEL_THUMBS && this.queue.length) {
      // newest requests first: they belong to what is on screen now
      const q = this.queue.pop();
      const e = this.thumbs.get(q.key);
      if (!e || e.state !== 'queued') continue;
      e.state = 'loading';
      this.loading++;
      const img = new Image();
      img.decoding = 'async';
      let triedFallback = false;
      img.onload = () => { e.img = img; e.state = 'ok'; this.loading--; this._bump(q.key.split('|')[0]); this._notify(); this._pump(); };
      img.onerror = () => {
        if (q.fallback && !triedFallback) { triedFallback = true; img.src = q.fallback; return; }
        e.state = 'error'; this.loading--; this._pump();
      };
      img.src = q.url;
    }
    // cap queue (stale requests from fast scrolling)
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
  }

  /**
   * Peaks for a media: { rate, data:Float32Array, mips:[{factor,data}] } or null while loading.
   * url: /api/projects/:id/media/:mediaId/peaks → {rate, peaks}
   */
  peaksFor(media) {
    if (!media || !this.projectId) return null;
    if (media.hasAudio === false && media.kind === 'video') return null;
    const v = this.version.get(media.id) || 0;
    const key = `${media.id}|${v}`;
    const e = this.peaks.get(key);
    if (e) return e.state === 'ok' ? e : null;
    if (media.status && media.status !== 'ready') return null;
    const entry = { state: 'loading' };
    this.peaks.set(key, entry);
    fetch(api.url(`/api/projects/${enc(this.projectId)}/media/${enc(media.id)}/peaks`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const arr = Array.isArray(j) ? j : (j.peaks || []);
        entry.rate = j.rate || 100;
        entry.data = Float32Array.from(arr);
        entry.mips = buildMips(entry.data);
        entry.state = 'ok';
        this._bump(media.id);
        this._notify();
      })
      .catch(() => { entry.state = 'error'; });
    return null;
  }

  /** Beat/onset times (source seconds) detected from peaks. */
  beatsFor(media) {
    const pk = this.peaksFor(media);
    if (!pk) return null;
    const v = this.version.get(media.id) || 0;
    const key = `${media.id}|${v}`;
    if (this.beats.has(key)) return this.beats.get(key);
    const b = detectBeats(pk.data, pk.rate);
    this.beats.set(key, b);
    return b;
  }
}

/** Max-pyramid for fast drawing at low zoom: factors 4, 16, 64, 256. */
function buildMips(data) {
  const mips = [];
  let src = data;
  let factor = 1;
  for (let level = 0; level < 4 && src.length > 64; level++) {
    const n = Math.ceil(src.length / 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * 4; j < i * 4 + 4 && j < src.length; j++) if (src[j] > m) m = src[j];
      out[i] = m;
    }
    factor *= 4;
    mips.push({ factor, data: out });
    src = out;
  }
  return mips;
}

/** Choose the coarsest array whose resolution still gives ≥ 1 value per pixel. */
export function pickLevel(pk, peaksPerPixel) {
  let best = { factor: 1, data: pk.data };
  for (const m of pk.mips || []) if (m.factor <= peaksPerPixel) best = m;
  return best;
}

/**
 * Simple onset detector on a 100/s peak envelope: spectral-flux-like rise detection with an adaptive threshold.
 * Returns onset times in seconds (source time).
 */
export function detectBeats(env, rate = 100) {
  const n = env.length;
  if (n < rate) return [];
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    // rise relative to a short trailing average
    let avg = 0, k = 0;
    for (let j = Math.max(0, i - 6); j < i; j++) { avg += env[j]; k++; }
    avg /= k || 1;
    flux[i] = Math.max(0, env[i] - avg);
  }
  const win = Math.round(rate * 1.5);
  const out = [];
  let last = -1e9;
  const minGap = Math.round(rate * 0.22);
  // global floor so silence / room noise is ignored
  let gmax = 0;
  for (let i = 0; i < n; i++) if (flux[i] > gmax) gmax = flux[i];
  const floor = gmax * 0.12;
  let sum = 0, sum2 = 0;
  const half = Math.floor(win / 2);
  // running window stats
  for (let i = 0; i < Math.min(n, win); i++) { sum += flux[i]; sum2 += flux[i] * flux[i]; }
  for (let i = 1; i < n - 1; i++) {
    const a = i - half - 1, b = i + half;
    if (b < n && b >= win) { sum += flux[b]; sum2 += flux[b] * flux[b]; }
    if (a >= 0 && b >= win) { sum -= flux[a]; sum2 -= flux[a] * flux[a]; }
    const cnt = Math.min(n, win);
    const mean = sum / cnt;
    const sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
    const th = Math.max(floor, mean + 1.4 * sd);
    if (flux[i] > th && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last >= minGap) {
      out.push(i / rate);
      last = i;
    }
  }
  return out;
}
