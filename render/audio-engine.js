// Frame Studio — audio engine (agent A)
// One WebAudio graph builder shared by live preview (AudioContext) and export (OfflineAudioContext).
//
//   source ─► [voice enhance] ─► [denoise] ─► [eq preset] ─► edge gain (fades + de-click)
//          ─► volume gain (volume × keyframes) ─► duck gain (precomputed curve) ─► panner
//          ─► track gain (volume / mute / solo) ─► bus (voice | music | sfx | other)
//          ─► master gain (masterGainDb) ─► glue compressor (-6 dB, 1.5:1) ─► make-up trim ─► out
//
// This module must import cleanly in Node: no DOM / WebAudio access at module top level.

/* ------------------------------------------------------------------ constants */

export const AUDIO_BUSES = ['voice', 'music', 'sfx', 'other'];

const CURVE_RATE = 100;        // volume-keyframe and duck curves (points per second)
const EDGE_RATE = 1000;        // fade / de-click curves (points per second)
const DECLICK = 0.002;         // minimum ramp at clip edges and cut points (s)
const LEAD = 0.08;             // preview scheduling lead (s)
const XFADE = 0.012;           // preview graph swap crossfade (s)
const MAX_CURVE_POINTS = 1 << 20;

export const DUCKING = Object.freeze({
  thresholdDb: -35,            // voice envelope above this → duck
  attack: 0.08,                // s (applied with look-ahead: fully ducked when the word starts)
  release: 0.4,                // s
  hold: 0.15,                  // s, bridges the short gaps between words
  rate: 100,                   // envelope resolution (Hz)
});

export const VOICE_ENHANCE = Object.freeze({
  highpass: { frequency: 80, Q: 0.707 },
  mud: { frequency: 220, Q: 1.0, gain: -3 },
  presence: { frequency: 3200, Q: 1.0, gain: 2.5 },
  air: { frequency: 10000, gain: 1.5 },
  // threshold is adaptive per clip (median syllable peak - 2 dB, clamped to [thresholdMin, thresholdMax]);
  // make-up = predicted average gain reduction, so the voice keeps its loudness and becomes more even.
  compressor: { threshold: -24, knee: 6, ratio: 3, attack: 0.003, release: 0.25 },
  thresholdBelowMedianPeakDb: 2,
  thresholdMin: -40,
  thresholdMax: -6,
  outputGainDb: 2,             // presence lift on top of loudness-preserving make-up
});

const PREROLL = 0.5;           // offline: audio rendered before `from` so compressors/ducking are in steady state
const WARM_LEAD = 0.03;        // compressors run with release=0 until this long before audio starts (kills start-up dip)

export const DENOISE = Object.freeze({
  highpass: { frequency: 100, Q: 0.707 },
  hiss: { frequency: 7500, Q: 0.9, gain: -3 },
  lowpass: { frequency: 11000, Q: 0.707 },
});

export const GLUE = Object.freeze({ threshold: -6, knee: 6, ratio: 1.5, attack: 0.01, release: 0.25 });

// Equalizer presets for clip.audioFx.eqPreset. Bands: {type, f, q?, gain?}
export const EQ_PRESETS = [
  { id: 'none', name: 'ללא', bands: [] },
  { id: 'voiceClear', name: 'קול ברור', bands: [
    { type: 'highpass', f: 90, q: 0.707 }, { type: 'peaking', f: 250, q: 1.1, gain: -2.5 },
    { type: 'peaking', f: 3000, q: 0.9, gain: 3 }, { type: 'highshelf', f: 9000, gain: 2 }] },
  { id: 'voiceWarm', name: 'קול חם', bands: [
    { type: 'highpass', f: 70, q: 0.707 }, { type: 'lowshelf', f: 180, gain: 2 },
    { type: 'peaking', f: 4500, q: 1, gain: -1.5 }] },
  { id: 'deepVoice', name: 'קול עמוק', bands: [
    { type: 'lowshelf', f: 140, gain: 4 }, { type: 'peaking', f: 2500, q: 1.2, gain: -1 }] },
  { id: 'bright', name: 'בהיר', bands: [
    { type: 'highshelf', f: 6000, gain: 4 }, { type: 'peaking', f: 300, q: 1, gain: -1.5 }] },
  { id: 'warm', name: 'חמים', bands: [
    { type: 'lowshelf', f: 250, gain: 3 }, { type: 'highshelf', f: 8000, gain: -2.5 }] },
  { id: 'bassBoost', name: 'הגברת בס', bands: [
    { type: 'lowshelf', f: 110, gain: 6 }, { type: 'peaking', f: 350, q: 1, gain: -1.5 }] },
  { id: 'telephone', name: 'טלפון', bands: [
    { type: 'highpass', f: 400, q: 0.9 }, { type: 'lowpass', f: 3200, q: 0.9 },
    { type: 'peaking', f: 1500, q: 1, gain: 4 }] },
  { id: 'radio', name: 'רדיו ישן', bands: [
    { type: 'highpass', f: 250, q: 0.8 }, { type: 'lowpass', f: 5000, q: 0.8 },
    { type: 'peaking', f: 1800, q: 1.4, gain: 5 }] },
  { id: 'muffled', name: 'מאחורי קיר', bands: [
    { type: 'lowpass', f: 700, q: 0.8 }, { type: 'lowshelf', f: 120, gain: 2 }] },
  { id: 'musicUnderVoice', name: 'מוזיקה מתחת לקול', bands: [
    { type: 'highpass', f: 35, q: 0.707 }, { type: 'peaking', f: 2200, q: 1.0, gain: -4 }] },
  { id: 'sfxUnderVoice', name: 'אפקטים מתחת לקול', bands: [
    { type: 'highpass', f: 30, q: 0.707 }, { type: 'peaking', f: 3000, q: 1.0, gain: -3 }] },
];

/* ------------------------------------------------------------------ small helpers */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 1e-12 ? 20 * Math.log10(g) : -240);

export function busForRole(role) {
  if (role === 'voice') return 'voice';
  if (role === 'music') return 'music';
  if (role === 'sfx') return 'sfx';
  return 'other';
}

function clipEndOf(c) { return num(c.start, 0) + Math.max(0, num(c.duration, 0)); }

function projectDurationOf(p) {
  let end = 0;
  for (const c of Object.values(p?.clips || {})) end = Math.max(end, clipEndOf(c));
  const fps = num(p?.settings?.fps, 30) || 30;
  return Math.max(end, 1 / fps);
}

/** Equal-power fade shape, p ∈ [0,1] → gain. */
export function fadeShape(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return Math.sin(p * Math.PI * 0.5);
}

/* ------------------------------------------------------------------ keyframes (fallback) */
// shared/anim.js is the canonical evaluator; this local copy is used only if it cannot be loaded.

function springEase(p, zeta = 0.55, omega = 2 * Math.PI * 1.6) {
  const raw = (x) => {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * x) * (Math.cos(wd * x) + (zeta * omega / wd) * Math.sin(wd * x));
  };
  return raw(p) / raw(1);
}
function bounceEase(p) {
  const n1 = 7.5625, d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) { p -= 1.5 / d1; return n1 * p * p + 0.75; }
  if (p < 2.5 / d1) { p -= 2.25 / d1; return n1 * p * p + 0.9375; }
  p -= 2.625 / d1; return n1 * p * p + 0.984375;
}
const LOCAL_EASE = {
  linear: (p) => p,
  easeIn: (p) => p * p * p,
  easeOut: (p) => 1 - Math.pow(1 - p, 3),
  easeInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  hold: (p) => (p >= 1 ? 1 : 0),
  spring: (p) => springEase(p),
  bounce: bounceEase,
  back: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  elastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
};

export function localEvalKeyframed(clip, prop, localT, fallback) {
  const list = clip?.keyframes?.[prop];
  if (!Array.isArray(list) || list.length === 0) return fallback;
  const ks = list.filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.v)).sort((a, b) => a.t - b.t);
  if (!ks.length) return fallback;
  if (localT <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (localT >= last.t) return last.v;
  let i = 0;
  while (i < ks.length - 2 && localT >= ks[i + 1].t) i++;
  const k0 = ks[i], k1 = ks[i + 1];
  const span = k1.t - k0.t;
  const p = span > 0 ? (localT - k0.t) / span : 1;
  const ease = LOCAL_EASE[k1.ease] || LOCAL_EASE.linear;
  return k0.v + (k1.v - k0.v) * ease(p);
}

/* ------------------------------------------------------------------ compressor maths */
// Chromium's DynamicsCompressorNode applies an automatic make-up gain:
//   makeup = (1 / saturate(1, k)) ^ 0.6   (DynamicsCompressorKernel)
// We cancel it so that a signal under the threshold passes at unity — preview and export
// levels then mean exactly what the user set. Pure maths, mirrors the kernel.

export function compressorMakeupDb(threshold, knee, ratio) {
  const db2lin = (d) => Math.pow(10, d / 20);
  const lin2db = (l) => (l > 0 ? 20 * Math.log10(l) : -1000);
  const linearThreshold = db2lin(threshold);
  const slope = 1 / ratio;
  const kneeCurve = (x, k) => (x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k);
  const slopeAt = (x, k) => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    const xDb = lin2db(x), x2Db = lin2db(x2);
    const yDb = lin2db(kneeCurve(x, k)), y2Db = lin2db(kneeCurve(x2, k));
    return (y2Db - yDb) / (x2Db - xDb);
  };
  const kneeX = db2lin(threshold + knee);
  let minK = 0.1, maxK = 10000, k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeX, k) < slope) maxK = k; else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const kneeThresholdDb = threshold + knee;
  const kneeThreshold = db2lin(kneeThresholdDb);
  const yKneeThresholdDb = lin2db(kneeCurve(kneeThreshold, k));
  const saturate = (x) => {
    if (x < kneeThreshold) return kneeCurve(x, k);
    const xDb = lin2db(x);
    return db2lin(yKneeThresholdDb + slope * (xDb - kneeThresholdDb));
  };
  const fullRangeGain = saturate(1);
  const makeup = Math.pow(1 / fullRangeGain, 0.6);
  return lin2db(makeup);
}

const latencyCache = new Map(); // `${sampleRate}|${threshold}` → seconds (Promise)

/** Measures the compressor look-ahead delay of this browser (Chromium: 6 ms) with a tiny offline render. */
export function measureCompressorLatency(sampleRate, opts) {
  const key = `${sampleRate}|${opts.threshold}|${opts.knee}|${opts.ratio}`;
  if (latencyCache.has(key)) return latencyCache.get(key);
  const p = (async () => {
    try {
      const OAC = globalThis.OfflineAudioContext;
      if (!OAC) return Math.floor(0.006 * sampleRate) / sampleRate;
      const len = 4096;
      const ctx = new OAC({ numberOfChannels: 1, length: len, sampleRate });
      const buf = ctx.createBuffer(1, 1, sampleRate);
      buf.getChannelData(0)[0] = dbToGain(opts.threshold - 20);
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      const comp = new DynamicsCompressorNode(ctx, compressorOptions(opts));
      src.connect(comp).connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let best = 0, idx = 0;
      for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > best) { best = a; idx = i; } }
      return best > 0 ? idx / sampleRate : Math.floor(0.006 * sampleRate) / sampleRate;
    } catch {
      return Math.floor(0.006 * sampleRate) / sampleRate;
    }
  })();
  latencyCache.set(key, p);
  return p;
}

function compressorOptions(o) {
  return { threshold: o.threshold, knee: o.knee, ratio: o.ratio, attack: o.attack, release: o.release };
}

/* ------------------------------------------------------------------ clip gain maths */

/** Effective fade lengths (scaled down proportionally if they overlap). */
function fadeLengths(clip) {
  const dur = Math.max(0, num(clip.duration, 0));
  let fi = Math.max(num(clip.fadeIn, 0), DECLICK);
  let fo = Math.max(num(clip.fadeOut, 0), DECLICK);
  if (fi + fo > dur && dur > 0) { const s = dur / (fi + fo); fi *= s; fo *= s; }
  return { fi, fo, dur };
}

/** Fades + de-click at timeline time t (no window cut ramps). */
export function edgeGainAt(clip, t) {
  const { fi, fo, dur } = fadeLengths(clip);
  const u = t - num(clip.start, 0);
  if (u < 0 || u > dur) return 0;
  let g = 1;
  if (u < fi) g *= fadeShape(u / fi);
  const rem = dur - u;
  if (rem < fo) g *= fadeShape(rem / fo);
  return g;
}

/** volume × keyframes (linear, 0..4) at timeline time t. */
export function volumeAt(clip, t, kfEval = localEvalKeyframed) {
  const base = clamp(num(clip.volume, 1), 0, 4);
  const list = clip?.keyframes?.volume;
  if (!Array.isArray(list) || !list.length) return base;
  let v;
  try { v = kfEval(clip, 'volume', t - num(clip.start, 0), base); } catch { v = localEvalKeyframed(clip, 'volume', t - num(clip.start, 0), base); }
  return clamp(num(v, base), 0, 4);
}

/**
 * Duck envelope from a voice level track (linear peak per frame at `rate`).
 * Returns Float32Array 0..1: 1 = fully ducked. Look-ahead attack, hold, then release.
 */
export function duckEnvelopeFromLevels(levels, rate = DUCKING.rate, opts = DUCKING) {
  const n = levels.length;
  const thr = dbToGain(opts.thresholdDb);
  const target = new Uint8Array(n);
  for (let i = 0; i < n; i++) target[i] = levels[i] > thr ? 1 : 0;
  const dt = 1 / rate;
  const holdFrames = Math.round(opts.hold * rate);
  const fwd = new Float32Array(n);
  let held = -1e9, v = 0;
  for (let i = 0; i < n; i++) {
    if (target[i]) { v = 1; held = i; }
    else if (i - held <= holdFrames) v = 1;
    else v = Math.max(0, v - dt / opts.release);
    fwd[i] = v;
  }
  const env = new Float32Array(n);
  let b = 0;
  for (let i = n - 1; i >= 0; i--) {
    b = target[i] ? 1 : Math.max(0, b - dt / opts.attack);
    env[i] = Math.max(fwd[i], b);
  }
  return env;
}

/* ------------------------------------------------------------------ WAV encoding */

function makePrng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Encodes an AudioBuffer (or any {numberOfChannels, sampleRate, length, getChannelData(i)}) to WAV.
 * Default: 16-bit PCM with deterministic TPDF dither. opts.float (or bitDepth:32) → 32-bit IEEE float.
 */
export function encodeWav(audioBuffer, opts = {}) {
  const float = opts.float === true || opts.bitDepth === 32;
  const nch = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const bps = float ? 4 : 2;
  const blockAlign = nch * bps;
  const dataBytes = len * blockAlign;
  const fmtSize = float ? 18 : 16;
  const factSize = float ? 12 : 0;
  const headerBytes = 12 + (8 + fmtSize) + factSize + 8;
  const ab = new ArrayBuffer(headerBytes + dataBytes);
  const dv = new DataView(ab);
  let o = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i)); };
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const u16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  str('RIFF'); u32(headerBytes + dataBytes - 8); str('WAVE');
  str('fmt '); u32(fmtSize);
  u16(float ? 3 : 1); u16(nch); u32(sr); u32(sr * blockAlign); u16(blockAlign); u16(bps * 8);
  if (float) u16(0);
  if (float) { str('fact'); u32(4); u32(len); }
  str('data'); u32(dataBytes);
  const chans = [];
  for (let c = 0; c < nch; c++) chans.push(audioBuffer.getChannelData(c));
  if (float) {
    // Interleave into an aligned scratch array, then copy bytes (the data chunk starts at byte 58).
    const f32 = new Float32Array(len * nch);
    for (let i = 0, k = 0; i < len; i++) for (let c = 0; c < nch; c++) f32[k++] = chans[c][i];
    new Uint8Array(ab, headerBytes).set(new Uint8Array(f32.buffer));
  } else {
    const rnd = makePrng(0x51f15e);
    const i16 = new Int16Array(ab, headerBytes, len * nch);
    for (let i = 0, k = 0; i < len; i++) {
      for (let c = 0; c < nch; c++) {
        const d = (rnd() - rnd()); // TPDF, ±1 LSB
        let v = chans[c][i] * 32767 + d;
        v = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
        i16[k++] = Math.round(v);
      }
    }
  }
  return ab;
}

/* ------------------------------------------------------------------ the engine */

/**
 * Level statistics of a voice buffer (50 ms windows, gate = loudest - 30 dB, >= -50 dBFS).
 * -> { loudnessDb, medianPeakDb, peakDb, threshold, makeupDb } for the adaptive voice-enhance compressor.
 */
export function voiceEnhanceStats(channels, sampleRate, opts = VOICE_ENHANCE) {
  const nch = channels.length;
  const len = nch ? channels[0].length : 0;
  const win = Math.max(1, Math.round(0.05 * sampleRate));
  const n = Math.floor(len / win);
  const pw = new Float64Array(n), pk = new Float64Array(n);
  let maxDb = -240;
  for (let w = 0; w < n; w++) {
    let s = 0, m = 0;
    for (let c = 0; c < nch; c++) {
      const d = channels[c];
      for (let i = w * win, e = i + win; i < e; i++) { const v = d[i]; s += v * v; const a = v < 0 ? -v : v; if (a > m) m = a; }
    }
    pw[w] = s / (win * nch);
    pk[w] = m;
    const db = 10 * Math.log10(pw[w] + 1e-24);
    if (db > maxDb) maxDb = db;
  }
  const gate = Math.max(-50, maxDb - 30);
  const act = [];
  for (let w = 0; w < n; w++) if (10 * Math.log10(pw[w] + 1e-24) > gate) act.push(w);
  const { ratio, knee } = opts.compressor;
  if (!act.length) return { loudnessDb: -240, medianPeakDb: -240, peakDb: -240, threshold: opts.compressor.threshold, knee, ratio, makeupDb: 0 };
  const peaksDb = act.map((w) => 20 * Math.log10(pk[w] + 1e-12)).sort((a, b) => a - b);
  const medianPeakDb = peaksDb[Math.floor(peaksDb.length / 2)];
  const threshold = clamp(medianPeakDb - opts.thresholdBelowMedianPeakDb, opts.thresholdMin, opts.thresholdMax);
  let inP = 0, outP = 0;
  for (const w of act) {
    const over = 20 * Math.log10(pk[w] + 1e-12) - threshold;
    const red = over > 0 ? over * (1 - 1 / ratio) : 0;   // the compressor's detector follows peaks
    inP += pw[w];
    outP += pw[w] * Math.pow(10, -red / 10);
  }
  const loudnessDb = 10 * Math.log10(inP / act.length);
  const makeupDb = Math.max(0, 10 * Math.log10(inP / Math.max(outP, 1e-30)));
  return { loudnessDb, medianPeakDb, peakDb: peaksDb[peaksDb.length - 1], threshold, knee, ratio, makeupDb };
}

const BaseTarget = typeof EventTarget === 'function' ? EventTarget : class { addEventListener() {} removeEventListener() {} dispatchEvent() { return true; } };

export class AudioEngine extends BaseTarget {
  constructor({ projectId = null, apiBase = '' } = {}) {
    super();
    this.projectId = projectId;
    this.apiBase = apiBase || '';
    this.project = null;
    this._entries = new Map();   // key → { key, mediaId, buffer, reversed, peaks1k }
    this._loading = new Map();   // key → Promise
    this._errors = new Map();    // key → message
    this._version = 0;           // bumps when buffers arrive
    this._kfEval = null;
    this._kfTried = false;
    this._sig = '';
    this._duck = null;           // { sig, rate, env }
    this._ctx = null;            // live AudioContext
    this._live = null;           // current live graph
    this._meter = null;
    this._playing = false;
    this._pos = 0;
    this._startT = 0;
    this._ctxStart = 0;
    this._clockFallback = null;  // when WebAudio is not available
    this._lat = { master: 0.006, chain: 0.006, rate: 0 };
    this._rebuildTimer = null;
    this._lastScrub = 0;
    this._lufsBlocks = [];
  }

  /* ---------- project / loading ---------- */

  setProject(project) {
    if (!project) return;
    if (project.id && this.projectId && project.id !== this.projectId) {
      this._entries.clear(); this._loading.clear(); this._errors.clear();
    }
    if (project.id) this.projectId = project.id;
    this.project = project;
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._duck = null;
      if (this._needsLoading()) {
        this.load().catch(() => {});
      }
      if (this._playing) this._scheduleRebuild();
    }
  }

  _rate() { return num(this.project?.settings?.sampleRate, 48000) || 48000; }

  _signature() {
    const p = this.project;
    if (!p) return '';
    const s = p.settings || {};
    const parts = [num(s.masterGainDb, 0), this._version];
    for (const t of p.tracks || []) parts.push([t.id, t.kind, t.role, !!t.muted, !!t.solo, num(t.volume, 1)]);
    const clips = Object.values(p.clips || {}).filter((c) => c && (c.type === 'audio' || c.type === 'video'));
    clips.sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const c of clips) {
      const m = p.media?.[c.mediaId];
      parts.push([c.id, c.trackId, c.type, c.start, c.duration, c.in, c.speed, !!c.reverse, c.volume,
        c.keyframes?.volume || null, c.fadeIn, c.fadeOut, c.pan, !!c.muteAudio, c.audioFx || null, !!c.disabled,
        c.mediaId, m ? [m.audio || null, m.hasAudio, m.kind, m.path] : null]);
    }
    return JSON.stringify(parts);
  }

  _mediaKey(media) { return `${media.id}|${media.audio || media.path || ''}`; }

  _mediaUrl(media) {
    const pid = encodeURIComponent(this.projectId || this.project?.id || '');
    const mid = encodeURIComponent(media.id);
    if (media.audio) return `${this.apiBase}/api/projects/${pid}/media/${mid}/audio`;
    if (media.kind === 'audio') return `${this.apiBase}/api/projects/${pid}/media/${mid}/file`;
    return null;
  }

  /** Clips that can make sound, with their media/track/bus. */
  _audibleItems(requireLoaded = true) {
    const p = this.project;
    if (!p) return [];
    const tracks = new Map((p.tracks || []).map((t) => [t.id, t]));
    const soloActive = (p.tracks || []).some((t) => t.solo);
    const items = [];
    for (const clip of Object.values(p.clips || {})) {
      if (!clip || clip.disabled || clip.muteAudio) continue;
      if (clip.type !== 'audio' && clip.type !== 'video') continue;
      const media = p.media?.[clip.mediaId];
      if (!media) continue;
      if (clip.type === 'video' && !(media.hasAudio || media.audio)) continue;
      if (clip.type === 'audio' && media.hasAudio === false && !media.audio) continue;
      const track = tracks.get(clip.trackId);
      if (!track) continue;
      if (!(num(clip.duration, 0) > 0)) continue;
      const key = this._mediaKey(media);
      const entry = this._entries.get(key);
      if (requireLoaded && !entry) continue;
      const trackAudible = !track.muted && (!soloActive || !!track.solo);
      items.push({ clip, media, track, key, entry, bus: busForRole(track.role), trackAudible });
    }
    return items;
  }

  _needsLoading() {
    for (const it of this._audibleItems(false)) {
      if (!this._entries.has(it.key) && !this._loading.has(it.key) && !this._errors.has(it.key) && this._mediaUrl(it.media)) return true;
    }
    return false;
  }

  async _ensureKf() {
    if (this._kfTried) return;
    this._kfTried = true;
    try {
      const m = await import('../shared/anim.js');
      if (typeof m.evalKeyframed === 'function') this._kfEval = m.evalKeyframed;
    } catch { /* fallback evaluator */ }
  }

  _kf() { return this._kfEval || localEvalKeyframed; }

  /** Fetches + decodes every audio buffer the project needs. Resolves with { loaded, failed:[{mediaId,error}], pending }. */
  async load() {
    await this._ensureKf();
    const todo = [];
    const pending = [];
    const seen = new Set();
    for (const it of this._audibleItems(false)) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      if (this._entries.has(it.key)) continue;
      const url = this._mediaUrl(it.media);
      if (!url) { pending.push(it.media.id); continue; }
      todo.push({ key: it.key, media: it.media, url });
    }
    const failed = [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const job = todo[next++];
        try { await this._loadOne(job); } catch (e) { failed.push({ mediaId: job.media.id, error: String(e?.message || e) }); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const [key, msg] of this._errors) {
      const mediaId = key.split('|')[0];
      if (seen.has(key) && !failed.some((f) => f.mediaId === mediaId)) failed.push({ mediaId, error: msg });
    }
    return { loaded: this._entries.size, failed, pending };
  }

  _loadOne({ key, media, url }) {
    if (this._entries.has(key)) return Promise.resolve(this._entries.get(key));
    if (this._loading.has(key)) return this._loading.get(key);
    const p = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`טעינת השמע של "${media.name || media.id}" נכשלה (${res.status})`);
        const data = await res.arrayBuffer();
        let buffer = await this._decode(data, media);
        if (buffer.numberOfChannels === 1) buffer = upmixToStereo(buffer);
        const entry = { key, mediaId: media.id, buffer, reversed: null, peaks1k: null };
        this._entries.set(key, entry);
        this._errors.delete(key);
        this._version++;
        this._sig = this._signature();
        this._duck = null;
        if (this._playing) this._scheduleRebuild();
        this._emit('load', { mediaId: media.id });
        return entry;
      } catch (e) {
        const msg = String(e?.message || e);
        this._errors.set(key, msg);
        this._emit('error', { mediaId: media.id, error: msg });
        throw e;
      } finally {
        this._loading.delete(key);
      }
    })();
    this._loading.set(key, p);
    return p;
  }

  async _decode(data, media) {
    const OAC = globalThis.OfflineAudioContext;
    if (!OAC) throw new Error('הדפדפן אינו תומך ב-WebAudio');
    if (!this._decodeCtx || this._decodeCtx.sampleRate !== this._rate()) {
      this._decodeCtx = new OAC({ numberOfChannels: 2, length: 1, sampleRate: this._rate() });
    }
    try {
      return await this._decodeCtx.decodeAudioData(data);
    } catch (e) {
      throw new Error(`פענוח השמע של "${media.name || media.id}" נכשל: ${e?.message || e}`);
    }
  }

  _reversedOf(entry) {
    if (entry.reversed) return entry.reversed;
    const b = entry.buffer;
    const r = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c);
      const dst = r.getChannelData(c);
      for (let i = 0, j = src.length - 1; j >= 0; i++, j--) dst[i] = src[j];
    }
    entry.reversed = r;
    return r;
  }

  _voiceStatsOf(entry) {
    if (!entry.voiceStats) {
      const b = entry.buffer;
      const ch = [];
      for (let c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c));
      entry.voiceStats = voiceEnhanceStats(ch, b.sampleRate);
    }
    return entry.voiceStats;
  }

  _peaksOf(entry) {
    if (entry.peaks1k) return entry.peaks1k;
    const b = entry.buffer;
    const bin = Math.max(1, Math.round(b.sampleRate / 1000));
    const n = Math.ceil(b.length / bin);
    const out = new Float32Array(n);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let k = 0, i = 0; k < n; k++) {
        let m = out[k];
        const end = Math.min(d.length, i + bin);
        for (; i < end; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
        out[k] = m;
      }
    }
    entry.peaks1k = { bin: bin / b.sampleRate, data: out };
    return entry.peaks1k;
  }

  /* ---------- timing maths ---------- */

  /** Source position (s) in the clip's (possibly reversed) buffer at timeline time t. */
  _bufferPos(clip, bufferDuration, t) {
    const S = num(clip.start, 0), dur = num(clip.duration, 0);
    const speed = clamp(num(clip.speed, 1) || 1, 0.05, 16);
    const inn = Math.max(0, num(clip.in, 0));
    if (clip.reverse) return bufferDuration - inn - dur * speed + (t - S) * speed;
    return inn + (t - S) * speed;
  }

  /** Global voice duck envelope at DUCKING.rate on the timeline, or null when nothing ducks. */
  _duckEnvelope(items) {
    const ducked = items.some((it) => it.bus !== 'voice' && it.clip.audioFx?.duckUnderVoice);
    if (!ducked) return null;
    const voices = items.filter((it) => it.bus === 'voice' && it.trackAudible);
    if (!voices.length) return null;
    if (this._duck && this._duck.sig === this._sig) return this._duck;
    const rate = DUCKING.rate;
    let end = 0;
    for (const it of items) end = Math.max(end, clipEndOf(it.clip));
    const n = Math.ceil((end + 1) * rate) + 2;
    const levels = new Float32Array(n);
    const kf = this._kf();
    for (const it of voices) {
      const { clip, entry, track } = it;
      const pk = this._peaksOf(entry);
      const bufDur = entry.buffer.duration;
      const S = num(clip.start, 0), E = clipEndOf(clip);
      const tv = clamp(num(track.volume, 1), 0, 4);
      const k0 = Math.max(0, Math.floor(S * rate)), k1 = Math.min(n - 1, Math.ceil(E * rate));
      for (let k = k0; k <= k1; k++) {
        const t0 = Math.max(S, k / rate), t1 = Math.min(E, (k + 1) / rate);
        if (t1 <= t0) continue;
        let p0 = this._bufferPos(clip, bufDur, t0), p1 = this._bufferPos(clip, bufDur, t1);
        if (p0 > p1) { const x = p0; p0 = p1; p1 = x; }
        if (p1 <= 0 || p0 >= bufDur) continue;
        const b0 = Math.max(0, Math.floor(p0 / pk.bin)), b1 = Math.min(pk.data.length - 1, Math.max(b0, Math.ceil(p1 / pk.bin) - 1)); // bins covering [p0, p1)
        let m = 0;
        for (let b = b0; b <= b1; b++) if (pk.data[b] > m) m = pk.data[b];
        const tm = (t0 + t1) / 2;
        const g = volumeAt(clip, tm, kf) * edgeGainAt(clip, tm) * tv;
        const v = m * g;
        if (v > levels[k]) levels[k] = v;
      }
    }
    const env = duckEnvelopeFromLevels(levels, rate);
    this._duck = { sig: this._sig, rate, env };
    return this._duck;
  }

  async _latencies(sampleRate) {
    if (this._lat.rate === sampleRate) return this._lat;
    const [master, chain] = await Promise.all([
      measureCompressorLatency(sampleRate, GLUE),
      measureCompressorLatency(sampleRate, VOICE_ENHANCE.compressor),
    ]);
    this._lat = { master, chain, rate: sampleRate };
    return this._lat;
  }

  /* ---------- graph construction (shared by preview and export) ---------- */

  /**
   * Builds the full mix graph into `ctx` for timeline window [W0, W1).
   * Timeline time t enters the post-source chain at ctx time base + (t - W0).
   * outputs: { mix: AudioNode, voice?: AudioNode, background?: AudioNode }
   * warmUntil: ctx time until which every compressor runs with release = 0 (Chromium compressors start
   * fully clamped and would otherwise dip ~8 dB for ~250 ms). Must be >= WARM_LEAD before any audio.
   */
  _buildGraph(ctx, { W0, W1, base, outputs, items, lat, warmUntil = 0 }) {
    const p = this.project;
    const nodes = [];
    const sources = [];
    const track = (n) => { nodes.push(n); return n; };
    const masterLin = dbToGain(num(p?.settings?.masterGainDb, 0));
    const compressor = (opts) => {
      const c = new DynamicsCompressorNode(ctx, compressorOptions(opts));
      if (warmUntil > ctx.currentTime + 1e-4) {
        c.release.setValueAtTime(0, ctx.currentTime);
        c.release.setValueAtTime(opts.release, warmUntil);
      }
      return c;
    };

    const buses = {};
    for (const b of AUDIO_BUSES) buses[b] = track(new GainNode(ctx, { gain: 1 }));
    const master = track(new GainNode(ctx, { gain: masterLin }));
    for (const b of AUDIO_BUSES) buses[b].connect(master);
    const glue = track(compressor(GLUE));
    const glueTrim = track(new GainNode(ctx, { gain: dbToGain(-compressorMakeupDb(GLUE.threshold, GLUE.knee, GLUE.ratio)) }));
    master.connect(glue);
    glue.connect(glueTrim);
    glueTrim.connect(outputs.mix);
    // Stems skip the glue compressor, so they get its look-ahead as a plain delay to stay sample-aligned with the mix.
    const stemDelay = () => track(new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: clamp(lat.master || 0, 0, 0.1) }));
    if (outputs.voice) {
      const sv = track(new GainNode(ctx, { gain: masterLin }));
      const dv = stemDelay();
      buses.voice.connect(sv); sv.connect(dv); dv.connect(outputs.voice);
    }
    if (outputs.background) {
      const sb = track(new GainNode(ctx, { gain: masterLin }));
      const dl = stemDelay();
      buses.music.connect(sb); buses.sfx.connect(sb); buses.other.connect(sb);
      sb.connect(dl); dl.connect(outputs.background);
    }

    const trackNodes = new Map();
    const trackNode = (it) => {
      let n = trackNodes.get(it.track.id);
      if (!n) {
        n = track(new GainNode(ctx, { gain: it.trackAudible ? clamp(num(it.track.volume, 1), 0, 4) : 0 }));
        n.connect(buses[it.bus]);
        trackNodes.set(it.track.id, n);
      }
      return n;
    };

    const duck = this._duckEnvelope(items);
    const kf = this._kf();
    const m = (t) => base + (t - W0);

    for (const it of items) {
      if (!it.trackAudible) continue;   // keep mute/solo cheap: silent tracks build nothing
      const { clip, entry } = it;
      const S = num(clip.start, 0), E = clipEndOf(clip);
      const a = Math.max(S, W0), b = Math.min(E, W1);
      if (b - a < 1e-3) continue;
      const speed = clamp(num(clip.speed, 1) || 1, 0.05, 16);
      const buf = clip.reverse ? this._reversedOf(entry) : entry.buffer;
      const R = buf.duration;
      let startT = a;
      let offset = this._bufferPos(clip, R, a);
      if (offset < 0) { startT = a + (-offset) / speed; offset = 0; }
      if (startT >= b - 1e-4 || offset >= R - 1e-6) continue;
      const fx = clip.audioFx || {};
      const chainLatency = fx.voiceEnhance ? lat.chain : 0;
      const when = m(startT) - chainLatency;
      const stopAt = m(b) - chainLatency;
      const now = ctx.currentTime;
      if (stopAt <= now) continue;

      const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: speed });
      sources.push(src);
      let head = src;
      const link = (n) => { head.connect(n); head = n; track(n); return n; };

      if (fx.voiceEnhance) {
        const v = VOICE_ENHANCE;
        link(new BiquadFilterNode(ctx, { type: 'highpass', frequency: v.highpass.frequency, Q: v.highpass.Q }));
        link(new BiquadFilterNode(ctx, { type: 'peaking', frequency: v.mud.frequency, Q: v.mud.Q, gain: v.mud.gain }));
        link(new BiquadFilterNode(ctx, { type: 'peaking', frequency: v.presence.frequency, Q: v.presence.Q, gain: v.presence.gain }));
        link(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: v.air.frequency, gain: v.air.gain }));
        const st = this._voiceStatsOf(entry);
        const c = { ...v.compressor, threshold: st.threshold };
        link(compressor(c));
        link(new GainNode(ctx, { gain: dbToGain(v.outputGainDb + st.makeupDb - compressorMakeupDb(c.threshold, c.knee, c.ratio)) }));
      }
      if (fx.denoise) {
        const d = DENOISE;
        link(new BiquadFilterNode(ctx, { type: 'highpass', frequency: d.highpass.frequency, Q: d.highpass.Q }));
        link(new BiquadFilterNode(ctx, { type: 'peaking', frequency: d.hiss.frequency, Q: d.hiss.Q, gain: d.hiss.gain }));
        link(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: d.lowpass.frequency, Q: d.lowpass.Q }));
      }
      const eq = EQ_PRESETS.find((e) => e.id === fx.eqPreset);
      if (eq && eq.bands.length) {
        for (const band of eq.bands) {
          const o = { type: band.type, frequency: band.f };
          if (band.q != null) o.Q = band.q;
          if (band.gain != null) o.gain = band.gain;
          link(new BiquadFilterNode(ctx, o));
        }
      }

      // Edge gain: fades + de-click (+ ramps where the window cuts the clip).
      const edge = link(new GainNode(ctx, { gain: 1 }));
      const cutStart = a > S + 1e-6, cutEnd = b < E - 1e-6;
      const { fi, fo } = fadeLengths(clip);
      const regions = [];
      const addRegion = (r0, r1) => { r0 = Math.max(r0, a); r1 = Math.min(r1, b); if (r1 - r0 > 1e-6) regions.push([r0, r1]); };
      addRegion(S, S + fi);
      addRegion(E - fo, E);
      if (cutStart) addRegion(a, a + DECLICK);
      if (cutEnd) addRegion(b - DECLICK, b);
      regions.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const r of regions) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      const g = (t) => {
        let v = edgeGainAt(clip, t);
        if (cutStart) v *= clamp((t - a) / DECLICK, 0, 1);
        if (cutEnd) v *= clamp((b - t) / DECLICK, 0, 1);
        return v;
      };
      if (!merged.length || merged[0][0] > a + 1e-6) edge.gain.setValueAtTime(g(a), m(a));
      for (const [r0, r1] of merged) {
        const n = clamp(Math.ceil((r1 - r0) * EDGE_RATE) + 1, 8, MAX_CURVE_POINTS);
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) curve[i] = g(r0 + ((r1 - r0) * i) / (n - 1));
        edge.gain.setValueCurveAtTime(curve, m(r0), r1 - r0);
      }

      // Volume × keyframes.
      const vol = link(new GainNode(ctx, { gain: volumeAt(clip, a, kf) }));
      const kfs = clip.keyframes?.volume;
      if (Array.isArray(kfs) && kfs.length > 1) {
        const n = clamp(Math.ceil((b - a) * CURVE_RATE) + 1, 2, MAX_CURVE_POINTS);
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) curve[i] = volumeAt(clip, a + ((b - a) * i) / (n - 1), kf);
        vol.gain.setValueCurveAtTime(curve, m(a), b - a);
      }

      // Ducking under voice (non-voice clips that ask for it).
      if (duck && fx.duckUnderVoice && it.bus !== 'voice') {
        const duckDb = Math.min(0, num(fx.duckDb, -10));
        const dk = link(new GainNode(ctx, { gain: 1 }));
        const n = clamp(Math.ceil((b - a) * duck.rate) + 1, 2, MAX_CURVE_POINTS);
        const curve = new Float32Array(n);
        let any = false;
        for (let i = 0; i < n; i++) {
          const t = a + ((b - a) * i) / (n - 1);
          const x = t * duck.rate;
          const k = Math.floor(x);
          const f = x - k;
          const e0 = duck.env[Math.min(duck.env.length - 1, Math.max(0, k))];
          const e1 = duck.env[Math.min(duck.env.length - 1, Math.max(0, k + 1))];
          const e = e0 + (e1 - e0) * f;
          if (e > 0) any = true;
          curve[i] = dbToGain(duckDb * e);
        }
        if (any) dk.gain.setValueCurveAtTime(curve, m(a), b - a);
      }

      link(new StereoPannerNode(ctx, { pan: clamp(num(clip.pan, 0), -1, 1) }));
      head.connect(trackNode(it));

      if (when < now) src.start(now, offset + (now - when) * speed);
      else src.start(when, offset);
      src.stop(stopAt);
    }
    return { nodes, sources, glueTrim };
  }

  /* ---------- preview ---------- */

  _ensureContext() {
    if (this._ctx && this._ctx.state !== 'closed') return this._ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { this._ctx = new AC({ latencyHint: 'interactive', sampleRate: this._rate() }); }
    catch { this._ctx = new AC({ latencyHint: 'interactive' }); }
    this._setupMeters(this._ctx);
    this._latencies(this._ctx.sampleRate).catch(() => {});
    const ctx = this._ctx;
    ctx.addEventListener('statechange', () => {
      if (ctx !== this._ctx) return;
      if (ctx.state === 'running' && this._playing && this._clockFallback) {
        const t = this.currentTime;      // wall-clock position reached while the device was blocked
        this._clockFallback = null;
        this.play(t);
      }
    });
    return this._ctx;
  }

  _setupMeters(ctx) {
    const input = new GainNode(ctx, { gain: 1 });
    input.connect(ctx.destination);
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    input.connect(split);
    const aL = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
    const aR = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
    split.connect(aL, 0); split.connect(aR, 1);
    // K-weighting (BS.1770) for the short-term loudness readout.
    const shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 1681, gain: 4 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 38, Q: 0.5 });
    input.connect(shelf); shelf.connect(hp);
    const ksplit = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    hp.connect(ksplit);
    const kL = new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0 });
    const kR = new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0 });
    ksplit.connect(kL, 0); ksplit.connect(kR, 1);
    this._meter = {
      input, aL, aR, kL, kR,
      bufL: new Float32Array(aL.fftSize), bufR: new Float32Array(aR.fftSize),
      kbufL: new Float32Array(kL.fftSize), kbufR: new Float32Array(kR.fftSize),
      holdL: -120, holdR: -120, holdAt: 0,
    };
  }

  _teardown(live, at, fade = true) {
    if (!live) return;
    const ctx = this._ctx;
    if (fade) {
      try {
        live.out.gain.cancelScheduledValues(at);
        live.out.gain.setValueAtTime(live.out.gain.value, at);
        live.out.gain.linearRampToValueAtTime(0, at + XFADE);
      } catch { /* context gone */ }
    }
    for (const s of live.sources) { try { s.stop(at + XFADE + 0.005); } catch { /* already stopped */ } }
    const kill = () => {
      for (const s of live.sources) { try { s.disconnect(); } catch { /* ignore */ } }
      for (const n of live.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
      try { live.out.disconnect(); } catch { /* ignore */ }
    };
    const delayMs = Math.max(0, (at + XFADE + 0.05 - (ctx ? ctx.currentTime : 0)) * 1000);
    if (typeof setTimeout === 'function') setTimeout(kill, delayMs); else kill();
  }

  _buildLive(W0, base, W1 = Infinity, fadeIn = true) {
    const ctx = this._ctx;
    const out = new GainNode(ctx, { gain: fadeIn ? 0 : 1 });
    out.connect(this._meter.input);
    if (fadeIn) { out.gain.setValueAtTime(0, base); out.gain.linearRampToValueAtTime(1, base + XFADE); }
    const items = this._audibleItems(true);
    const g = this._buildGraph(ctx, { W0, W1, base, outputs: { mix: out }, items, lat: this._lat, warmUntil: base - WARM_LEAD });
    return { out, nodes: g.nodes, sources: g.sources, W0, base };
  }

  _scheduleRebuild() {
    if (this._rebuildTimer || typeof setTimeout !== 'function') { if (typeof setTimeout !== 'function') this._rebuild(); return; }
    this._rebuildTimer = setTimeout(() => { this._rebuildTimer = null; this._rebuild(); }, 30);
  }

  _rebuild() {
    if (!this._playing || !this._ctx) return;
    const ctx = this._ctx;
    const at = ctx.currentTime + LEAD;
    const tl = this._startT + (at - this._ctxStart);
    const old = this._live;
    this._live = this._buildLive(tl, at, Infinity, true);
    this._teardown(old, at);
  }

  play(fromT = this._pos) {
    const t0 = Math.max(0, num(fromT, this._pos));
    const ctx = this._ensureContext();
    this._pos = t0;
    if (!ctx) {
      this._clockFallback = { t0, perf: nowMs() };
      this._playing = true;
      return;
    }
    // Autoplay-blocked / not yet running device: keep the transport moving on a wall clock and
    // re-sync the audio as soon as the context starts (statechange handler).
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      this._clockFallback = { t0, perf: nowMs() };
    } else {
      this._clockFallback = null;
    }
    const old = this._live;
    this._startT = t0;
    this._ctxStart = ctx.currentTime + LEAD;
    this._playing = true;
    this._lufsBlocks = [];
    this._live = this._buildLive(t0, this._ctxStart, Infinity, true);
    if (old) this._teardown(old, ctx.currentTime);
    if (this._needsLoading()) this.load().catch(() => {});
  }

  pause() {
    if (!this._playing) return;
    this._pos = this.currentTime;
    this._playing = false;
    this._clockFallback = null;
    if (this._rebuildTimer) { clearTimeout(this._rebuildTimer); this._rebuildTimer = null; }
    if (this._live && this._ctx) this._teardown(this._live, this._ctx.currentTime);
    this._live = null;
  }

  seek(t) {
    const tt = Math.max(0, num(t, 0));
    if (this._playing) this.play(tt);
    else this._pos = tt;
  }

  /** Short audition of the sound under the playhead while scrubbing (preview only). */
  scrub(t, length = 0.09) {
    if (this._playing) return;
    const ctx = this._ensureContext();
    if (!ctx) return;
    const n = nowMs();
    if (n - this._lastScrub < 40) return;
    this._lastScrub = n;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const base = ctx.currentTime + 0.06;
    const live = this._buildLive(Math.max(0, t), base, Math.max(0, t) + length, true);
    live.out.gain.setValueAtTime(1, base + length - XFADE);
    live.out.gain.linearRampToValueAtTime(0, base + length);
    this._teardown(live, base + length, false);
  }

  get playing() { return this._playing; }

  get currentTime() {
    if (!this._playing) return this._pos;
    if (this._clockFallback) return this._clockFallback.t0 + (nowMs() - this._clockFallback.perf) / 1000;
    const ctx = this._ctx;
    if (!ctx) return this._pos;
    let heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    if (typeof ctx.getOutputTimestamp === 'function' && ctx.state === 'running') {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        heard = Math.min(ctx.currentTime, ts.contextTime + (nowMs() - ts.performanceTime) / 1000);
      }
    }
    const t = this._startT + (heard - this._ctxStart - this._lat.master);
    return Math.max(this._startT, t);
  }

  /** Master-bus meters (dBFS). l/r = peak; rmsL/rmsR; holdL/holdR (peak hold, 20 dB/s decay); lufsShort (approx., 3 s). */
  getMeters() {
    const floor = -120;
    const m = this._meter;
    if (!m || !this._ctx) return { l: floor, r: floor, rmsL: floor, rmsR: floor, holdL: floor, holdR: floor, lufsShort: null, clip: false };
    const stats = (an, buf) => {
      an.getFloatTimeDomainData(buf);
      let pk = 0, sq = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; const a = v < 0 ? -v : v; if (a > pk) pk = a; sq += v * v; }
      return { pk, rms: Math.sqrt(sq / buf.length) };
    };
    const L = stats(m.aL, m.bufL), R = stats(m.aR, m.bufR);
    const toDb = (x) => Math.max(floor, gainToDb(x));
    const now = nowMs();
    const dt = m.holdAt ? (now - m.holdAt) / 1000 : 0;
    m.holdAt = now;
    m.holdL = Math.max(toDb(L.pk), m.holdL - 20 * dt);
    m.holdR = Math.max(toDb(R.pk), m.holdR - 20 * dt);
    let lufsShort = null;
    if (this._playing) {
      m.kL.getFloatTimeDomainData(m.kbufL); m.kR.getFloatTimeDomainData(m.kbufR);
      let s = 0;
      for (let i = 0; i < m.kbufL.length; i++) s += m.kbufL[i] * m.kbufL[i] + m.kbufR[i] * m.kbufR[i];
      const ms = s / m.kbufL.length;
      const t = this._ctx.currentTime;
      this._lufsBlocks.push({ t, ms });
      while (this._lufsBlocks.length && this._lufsBlocks[0].t < t - 3) this._lufsBlocks.shift();
      const avg = this._lufsBlocks.reduce((acc, b) => acc + b.ms, 0) / this._lufsBlocks.length;
      lufsShort = avg > 1e-12 ? Math.max(-70, -0.691 + 10 * Math.log10(avg)) : -70;
    }
    return { l: toDb(L.pk), r: toDb(R.pk), rmsL: toDb(L.rms), rmsR: toDb(R.rms), holdL: m.holdL, holdR: m.holdR, lufsShort, clip: L.pk >= 1 || R.pk >= 1 };
  }

  /** Releases the live context and every cached buffer. */
  dispose() {
    this.pause();
    if (this._ctx) { try { this._ctx.close(); } catch { /* ignore */ } }
    this._ctx = null; this._meter = null;
    this._entries.clear(); this._loading.clear(); this._errors.clear();
  }

  /* ---------- export ---------- */

  /**
   * Renders [from, to) offline with the same graph as preview.
   * → { mix, voice?, background?, sampleRate, from, to, warnings:[Hebrew] }
   */
  async renderOffline({ from = 0, to = null, sampleRate = 48000, stems = false, onProgress = null } = {}) {
    if (!this.project) throw new Error('לא נטען פרויקט למנוע השמע');
    const OAC = globalThis.OfflineAudioContext;
    if (!OAC) throw new Error('הדפדפן אינו תומך ברינדור שמע (OfflineAudioContext)');
    const loadRes = await this.load();
    const warnings = [];
    for (const f of loadRes.failed) warnings.push(`שמע חסר: ${f.error}`);
    for (const id of loadRes.pending) warnings.push(`השמע של "${this.project.media?.[id]?.name || id}" עדיין בעיבוד — הקטע ייצא בלי צליל`);
    const start = Math.max(0, num(from, 0));
    const end = to == null ? projectDurationOf(this.project) : num(to, projectDurationOf(this.project));
    const dur = Math.max(1 / sampleRate, end - start);
    const N = Math.max(1, Math.round(dur * sampleRate));
    const lat = await this._latencies(sampleRate);
    const base = lat.chain;                       // room for look-ahead of voice-enhanced clips
    // Timeline (start - PREROLL) enters the graph at ctx time `base`; the mix leaves the glue compressor
    // lat.master later. Everything before `delay` (pre-roll + latencies) is discarded.
    const delay = Math.round((PREROLL + base + lat.master) * sampleRate);
    const length = N + delay + 256;
    const channels = stems ? 6 : 2;
    const ctx = new OAC({ numberOfChannels: channels, length, sampleRate });
    const outputs = {};
    if (stems) {
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 6 });
      ctx.destination.channelCount = 6;
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'discrete';
      merger.connect(ctx.destination);
      const tap = (index) => {
        const g = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
        g.connect(split);
        split.connect(merger, 0, index);
        split.connect(merger, 1, index + 1);
        return g;
      };
      outputs.mix = tap(0); outputs.voice = tap(2); outputs.background = tap(4);
    } else {
      outputs.mix = ctx.destination;
    }
    const items = this._audibleItems(true);
    // Compressors warm up during the first 0.05 s of silence/pre-roll (release = 0), then run normally.
    this._buildGraph(ctx, { W0: start - PREROLL, W1: start + N / sampleRate, base, outputs, items, lat, warmUntil: 0.05 });
    if (typeof onProgress === 'function') {
      const total = length / sampleRate;
      for (let s = 2; s < total; s += 2) {
        const at = s;
        ctx.suspend(at).then(() => { try { onProgress(Math.min(1, at / total)); } catch { /* ignore */ } ctx.resume(); }).catch(() => {});
      }
    }
    const rendered = await ctx.startRendering();
    const cut = (c0) => {
      const out = new AudioBuffer({ length: N, numberOfChannels: 2, sampleRate });
      for (let c = 0; c < 2; c++) out.getChannelData(c).set(rendered.getChannelData(c0 + c).subarray(delay, delay + N));
      return out;
    };
    const result = { mix: cut(0), sampleRate, from: start, to: start + N / sampleRate, warnings };
    if (stems) { result.voice = cut(2); result.background = cut(4); }
    if (typeof onProgress === 'function') { try { onProgress(1); } catch { /* ignore */ } }
    return result;
  }

  static encodeWav(audioBuffer, opts) { return encodeWav(audioBuffer, opts); }

  _emit(type, detail) {
    try {
      const Ev = globalThis.CustomEvent;
      if (Ev) this.dispatchEvent(new Ev(type, { detail }));
    } catch { /* ignore */ }
  }
}

function upmixToStereo(b) {
  const out = new AudioBuffer({ length: b.length, numberOfChannels: 2, sampleRate: b.sampleRate });
  const d = b.getChannelData(0);
  out.getChannelData(0).set(d);
  out.getChannelData(1).set(d);
  return out;
}

function nowMs() {
  return (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}

export default AudioEngine;
