// Frame Studio — export / snapshot / audio-check jobs (agent A)
//
// Mounted by server/main.mjs through `routes(ctx)` (SPEC §5). Responsibilities:
//  • job registry (export | snapshot | audio) + long-poll wait + SSE progress (ctx.broadcast)
//  • headless Chrome render workers (render/render.html) with launch / idle-kill / watchdog / profile-lock cleanup
//  • ffmpeg rawvideo pipe (RGBA frames → H.264) with backpressure
//  • audio mastering: measured ebur128 gain → oversampled alimiter (level=false) → AAC 256k, target LUFS / TP ≤ -1
//  • mux, ffprobe report, speech-margin report from voice/background stems
//  • snapshot PNGs (+ optional contact sheet via ffmpeg tile)

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { findChrome as findChromeConfigured, angleBackend, ffmpegPath, ffprobePath } from './config.mjs';

/* ================================================================== configuration */

// env FRAME_STUDIO_FFMPEG / FRAME_STUDIO_FFPROBE → config.json "ffmpeg" / "ffprobe" → PATH
const FFMPEG = ffmpegPath();
const FFPROBE = ffprobePath();
const IS_WIN = process.platform === 'win32';

export const LIMITS = Object.freeze({
  poolSize: 2,                    // max concurrent headless Chrome workers
  workerIdleMs: 60_000,           // kill an idle worker after this
  startupTimeoutMs: 45_000,       // page must contact the server within this after assignment
  stallTimeoutMs: 90_000,         // headless page silent for this long → job failed
  inAppStallTimeoutMs: 180_000,   // editor-driven job silent for this long → failed
  waitingTimeoutMs: 15 * 60_000,  // headless:false job never picked up by the editor
  maxJobMs: 4 * 3600_000,         // absolute ceiling
  waitMaxSec: 600,                // /wait long-poll ceiling (SPEC: ≤ 10 min)
  keepFinishedJobs: 200,
  finishedJobTtlMs: 6 * 3600_000,
  snapshotFoldersKept: 40,
  maxFrameBytes: 8192 * 8192 * 4,
  maxAudioBytes: 4 * 1024 ** 3,
});

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

/* ================================================================== small utils */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, d) => {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return d;
};
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** File-name safe (keeps Hebrew), never empty. */
export function safeFileName(name, fallback = 'video') {
  const s = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return s.slice(0, 80) || fallback;
}

function projectDuration(p) {
  let end = 0;
  for (const c of Object.values(p?.clips || {})) end = Math.max(end, numOr(c?.start, 0) + Math.max(0, numOr(c?.duration, 0)));
  const fps = numOr(p?.settings?.fps, 30) || 30;
  return Math.max(end, 1 / fps);
}

const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => (g > 1e-12 ? 20 * Math.log10(g) : -240);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : v);

/* ================================================================== process helpers */

/** Runs a command (args array, no shell). Resolves { code, stdout, stderr } (stderr tail ≤ 256 KB). */
export function runProcess(cmd, args, { timeoutMs = 0, cwd, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e) });
      return;
    }
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < 4 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024); });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function ffErr(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-4).join(' | ').slice(0, 600);
}

function killTree(proc) {
  if (!proc || proc.exitCode != null) return;
  try {
    if (IS_WIN && proc.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else proc.kill('SIGKILL');
  } catch { /* ignore */ }
}

function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else process.kill(pid, 'SIGKILL');
  } catch { /* ignore */ }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* ================================================================== loudness (ebur128) */

/** Parses the Summary block of ffmpeg's ebur128 filter. Values: numbers (LUFS / LU / dBFS) or null. */
export function parseEbur128(text) {
  const s = String(text || '');
  const idx = s.lastIndexOf('Summary:');
  const part = idx >= 0 ? s.slice(idx) : s;
  const val = (re) => {
    const m = part.match(re);
    if (!m) return null;
    if (/-?inf/i.test(m[1])) return -Infinity;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const I = val(/I:\s+(-?inf|-?[\d.]+)\s+LUFS/i);
  const threshold = val(/Integrated loudness:[\s\S]*?Threshold:\s+(-?inf|-?[\d.]+)\s+LUFS/i);
  const LRA = val(/LRA:\s+(-?inf|-?[\d.]+)\s+LU/i);
  const tpBlock = part.match(/True peak:\s*[\r\n]+\s*Peak:\s+(-?inf|-?[\d.]+)\s+dBFS/i);
  const spBlock = part.match(/Sample peak:\s*[\r\n]+\s*Peak:\s+(-?inf|-?[\d.]+)\s+dBFS/i);
  const conv = (m) => (m ? (/-?inf/i.test(m[1]) ? -Infinity : Number(m[1])) : null);
  const truePeak = conv(tpBlock);
  const samplePeak = conv(spBlock);
  const found = idx >= 0 && I != null;
  return { I, threshold, LRA, truePeak, samplePeak, found, silent: I == null || I <= -69.5 };
}

/** Single gain (dB) that brings integrated loudness to target, clamped ±maxDb. Silence → 0. */
export function computeLoudnessGain(measuredLufs, targetLufs = -14, maxDb = 20) {
  if (!isNum(measuredLufs) || measuredLufs <= -69.5) return 0;
  return clamp(targetLufs - measuredLufs, -maxDb, maxDb);
}

export async function measureLoudness(file) {
  const r = await runProcess(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { timeoutMs: 15 * 60_000 });
  const m = parseEbur128(r.stderr);
  if (r.code !== 0 || !m.found) throw new Error(`מדידת עוצמה נכשלה: ${ffErr(r.stderr)}`);
  return m;
}

function masterFilter(gainDb, limit) {
  // 4× oversampling makes the sample-peak limiter behave close to a true-peak limiter.
  return [
    `volume=${gainDb.toFixed(3)}dB`,
    'aresample=192000',
    `alimiter=limit=${limit.toFixed(4)}:level=false:latency=true:attack=1:release=80`,
    'aresample=48000',
  ].join(',');
}

async function encodeAac(inFile, outFile, { gainDb = 0, limit = null } = {}) {
  const af = limit == null ? 'aresample=48000' : masterFilter(gainDb, limit);
  const r = await runProcess(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-vn', '-af', af,
    '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '256k', outFile], { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw new Error(`קידוד השמע נכשל: ${ffErr(r.stderr)}`);
}

/**
 * Loudness mastering: measure → one gain (±20 dB) → limiter (level=false) → AAC; re-measure and correct
 * (at most two corrections) until |I − target| ≤ 0.3 and true peak ≤ truePeakMax.
 */
export async function masterAudio(inWav, outFile, { targetLufs = -14, truePeakMax = -1 } = {}) {
  const input = await measureLoudness(inWav);
  if (input.silent) {
    await encodeAac(inWav, outFile, {});
    return { silent: true, input, output: input, gainDb: 0, limit: null, passes: [] };
  }
  let gainDb = computeLoudnessGain(input.I, targetLufs);
  let limit = 0.89;
  const passes = [];
  let output = null;
  let best = null;
  const MAX_PASSES = 4;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    await encodeAac(inWav, outFile, { gainDb, limit });
    output = await measureLoudness(outFile);
    const rec = { pass, gainDb: r2(gainDb), limit: Math.round(limit * 1e4) / 1e4, lufs: output.I, truePeak: output.truePeak };
    passes.push(rec);
    const loudOk = Math.abs(output.I - targetLufs) <= 0.3;
    const peakOk = !(output.truePeak > truePeakMax);
    if (peakOk && (!best || Math.abs(output.I - targetLufs) < Math.abs(best.lufs - targetLufs))) best = { ...rec };
    if ((loudOk && peakOk) || pass === MAX_PASSES) break;
    if (!peakOk) limit = clamp(limit * dbToGain(truePeakMax - output.truePeak - 0.2), 0.3, 1);
    if (!loudOk) {
      // Secant step: the limiter swallows part of every extra dB on dynamic mixes, so learn the real slope.
      let slope = 1;
      if (passes.length >= 2) {
        const a = passes[passes.length - 2], b = passes[passes.length - 1];
        if (Math.abs(b.gainDb - a.gainDb) > 0.05) slope = clamp((b.lufs - a.lufs) / (b.gainDb - a.gainDb), 0.15, 1);
      }
      const next = clamp(gainDb + (targetLufs - output.I) / slope, -20, 20);
      if (Math.abs(next - gainDb) < 0.05 && peakOk) break;          // pinned at the ±20 dB clamp
      gainDb = next;
    }
  }
  // If the last pass broke the peak ceiling but an earlier one was compliant and closer, re-encode that one.
  const last = passes[passes.length - 1];
  if (best && (last.truePeak > truePeakMax || Math.abs(best.lufs - targetLufs) + 0.05 < Math.abs(last.lufs - targetLufs)) && best.pass !== last.pass) {
    gainDb = best.gainDb; limit = best.limit;
    await encodeAac(inWav, outFile, { gainDb, limit });
    output = await measureLoudness(outFile);
    passes.push({ pass: passes.length + 1, gainDb: r2(gainDb), limit, lufs: output.I, truePeak: output.truePeak, reverted: true });
  }
  const reached = Math.abs(output.I - targetLufs) <= 0.5 && !(output.truePeak > truePeakMax);
  const warning = reached ? null
    : output.truePeak > truePeakMax
      ? `השיא האמיתי ${r2(output.truePeak)} dBTP מעל ${truePeakMax}`
      : `העוצמה הסופית ${r2(output.I)} LUFS במקום ${targetLufs} — המיקס דינמי מאוד (בומים חזקים מול דיבור שקט); כדאי להנמיך את האפקטים החזקים או להגביר את הקול`;
  return { silent: false, input, output, gainDb, limit, passes, reached, warning };
}

/* ================================================================== WAV + speech margin */

/** Minimal RIFF/WAVE reader: PCM 8/16/24/32, float 32/64, WAVE_FORMAT_EXTENSIBLE. → { sampleRate, channels, frames, data:[Float32Array] } */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('קובץ WAV לא תקין');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = body;
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      dataLen = size;
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('קובץ WAV חסר fmt/data');
  const { format, channels, bits, sampleRate } = fmt;
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v;
      if (format === 3) v = bits === 64 ? buf.readDoubleLE(p) : buf.readFloatLE(p);
      else if (bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (bits === 24) v = buf.readIntLE(p, 3) / 8388608;
      else if (bits === 32) v = buf.readInt32LE(p) / 2147483648;
      else if (bits === 8) v = (buf.readUInt8(p) - 128) / 128;
      else throw new Error(`עומק ביטים לא נתמך: ${bits}`);
      data[c][i] = v;
      p += bps;
    }
  }
  return { sampleRate, channels, frames, data, format, bits };
}

function windowRms(wav, win) {
  const n = Math.floor(wav.frames / win);
  const out = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let s = 0;
    for (let c = 0; c < wav.channels; c++) {
      const d = wav.data[c];
      for (let i = w * win, e = i + win; i < e; i++) s += d[i] * d[i];
    }
    out[w] = Math.sqrt(s / (win * wav.channels));
  }
  return out;
}

/**
 * Speech margin: voice minus background (dB) in `windowSec` windows where voice RMS > activeRatio × its peak window RMS.
 * voice/background: parsed WAVs (parseWav) or Buffers. offset: timeline time of sample 0 (report times are timeline times).
 */
export function computeSpeechMargin(voice, background, { windowSec = 0.1, activeRatio = 0.3, thresholdDb = 12, offset = 0, maxList = 30 } = {}) {
  const V = Buffer.isBuffer(voice) ? parseWav(voice) : voice;
  const B = Buffer.isBuffer(background) ? parseWav(background) : background;
  if (V.sampleRate !== B.sampleRate) throw new Error('קצב הדגימה של שכבות הבדיקה שונה');
  const win = Math.max(1, Math.round(windowSec * V.sampleRate));
  const vr = windowRms(V, win), br = windowRms(B, win);
  const n = Math.min(vr.length, br.length);
  let peak = 0;
  for (let i = 0; i < n; i++) if (vr[i] > peak) peak = vr[i];
  const res = {
    windowSec, activeRatio, thresholdDb, windows: n, activeWindows: 0,
    voicePeakDb: r2(gainToDb(peak)), min: null, median: null, p10: null,
    belowCount: 0, below: [], worst: null, ok: true, summary: '',
  };
  if (peak <= 1e-6) { res.summary = 'אין קריינות בשכבת הקול — לא נמדד מרווח דיבור'; return res; }
  const margins = [];
  for (let i = 0; i < n; i++) {
    if (vr[i] <= activeRatio * peak) continue;
    const m = Math.min(120, gainToDb(vr[i]) - gainToDb(Math.max(br[i], 1e-9)));
    const t = offset + i * windowSec;
    margins.push({ t: r2(t), margin: r2(m), voiceDb: r2(gainToDb(vr[i])), backgroundDb: r2(gainToDb(br[i])) });
  }
  res.activeWindows = margins.length;
  if (!margins.length) { res.summary = 'לא נמצאו חלונות דיבור פעילים'; return res; }
  const sorted = margins.map((m) => m.margin).sort((a, b) => a - b);
  res.min = sorted[0];
  res.median = r2(sorted[Math.floor(sorted.length / 2)]);
  res.p10 = r2(sorted[Math.floor(sorted.length * 0.1)]);
  const below = margins.filter((m) => m.margin < thresholdDb);
  res.belowCount = below.length;
  res.below = below.sort((a, b) => a.margin - b.margin).slice(0, maxList).sort((a, b) => a.t - b.t);
  res.worst = margins.reduce((a, b) => (b.margin < a.margin ? b : a));
  res.ok = below.length === 0;
  res.summary = res.ok
    ? `מרווח הדיבור תקין: מינימום ${res.min} dB, חציון ${res.median} dB (יעד ≥ ${thresholdDb} dB)`
    : `הקול מתחת ליעד ב-${below.length} חלונות (מינימום ${res.min} dB ב-${res.worst.t} שנ׳, חציון ${res.median} dB). מומלץ להנמיך את הרקע בזמנים: ${res.below.slice(0, 8).map((b) => `${b.t}s`).join(', ')}`;
  return res;
}

/* ================================================================== ffmpeg rawvideo pipe */

/** RGBA frames → H.264 mp4 through ffmpeg stdin, with backpressure. */
export class FramePipe {
  constructor({ width, height, fps, out, crf = 18, preset = 'medium', outWidth, outHeight, ffmpeg = FFMPEG }) {
    this.width = width; this.height = height; this.fps = fps; this.out = out;
    this.crf = crf; this.preset = preset;
    this.outWidth = even(outWidth || width); this.outHeight = even(outHeight || height);
    this.ffmpeg = ffmpeg;
    this.frameBytes = width * height * 4;
    this.framesWritten = 0;
    this.proc = null;
    this.failed = null;
    this.stderr = '';
    this.closed = null;
  }

  start() {
    if (this.proc) return this;
    const g = Math.max(1, Math.round(this.fps * 2));
    const vf = `scale=${this.outWidth}:${this.outHeight}:flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${this.width}x${this.height}`, '-r', String(this.fps), '-i', '-',
      '-vf', vf, '-c:v', 'libx264', '-preset', this.preset, '-crf', String(this.crf), '-pix_fmt', 'yuv420p',
      '-g', String(g), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', this.out];
    this.proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', (d) => { this.stderr += d; if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-32 * 1024); });
    this.proc.stdin.on('error', (e) => { if (!this.failed) this.failed = new Error(`ffmpeg סגר את הצינור: ${e.message} ${ffErr(this.stderr)}`); });
    this.closed = new Promise((resolve) => {
      let settled = false;
      const settle = (code) => { if (!settled) { settled = true; this.exitCode = code; resolve(code); } };
      this.proc.on('error', (e) => { this.failed = new Error(`הפעלת ffmpeg נכשלה: ${e.message}`); settle(-1); });
      this.proc.on('close', (code) => {
        if (code !== 0 && !this.failed && !this._finishing) this.failed = new Error(`ffmpeg נעצר (קוד ${code}): ${ffErr(this.stderr)}`);
        settle(code ?? -1);
      });
    });
    return this;
  }

  /** Writes one RGBA frame; resolves once ffmpeg has accepted it (waits for 'drain'). */
  async write(buf) {
    if (!this.proc) this.start();
    if (this.failed) throw this.failed;
    if (buf.length !== this.frameBytes) throw new Error(`גודל פריים שגוי: ${buf.length} במקום ${this.frameBytes}`);
    const stdin = this.proc.stdin;
    const ok = stdin.write(buf);
    this.framesWritten++;
    if (!ok) {
      await new Promise((resolve, reject) => {
        const done = () => { stdin.off('drain', onDrain); this.proc.off('close', onClose); };
        const onDrain = () => { done(); resolve(); };
        const onClose = () => { done(); reject(this.failed || new Error('ffmpeg נסגר באמצע הקידוד')); };
        if (this.exitCode != null) { onClose(); return; }
        stdin.once('drain', onDrain);
        this.proc.once('close', onClose);
      });
    }
    if (this.failed) throw this.failed;
  }

  /** Closes stdin and waits for ffmpeg. Throws on failure. */
  async finish() {
    if (!this.proc) throw new Error('לא התקבלו פריימים');
    this._finishing = true;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const code = await this.closed;
    if (this.failed) throw this.failed;
    if (code !== 0) throw new Error(`קידוד הווידאו נכשל (קוד ${code}): ${ffErr(this.stderr)}`);
    return { code, frames: this.framesWritten };
  }

  kill() {
    if (this.proc && this.proc.exitCode == null) {
      this._finishing = true;
      try { this.proc.stdin.destroy(); } catch { /* ignore */ }
      try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

/* ================================================================== mux / probe / sheet */

export async function muxAv(videoFile, audioFile, outFile, { title } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoFile, '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart'];
  if (title) args.push('-metadata', `title=${title}`);
  args.push('-metadata', 'comment=Frame Studio', outFile);
  const r = await runProcess(FFMPEG, args, { timeoutMs: 30 * 60_000 });
  if (r.code !== 0) throw new Error(`מיזוג הווידאו והשמע נכשל: ${ffErr(r.stderr)}`);
}

export async function probeFile(file) {
  const r = await runProcess(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,nb_frames',
    '-of', 'json', file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`ffprobe נכשל: ${ffErr(r.stderr)}`);
  return JSON.parse(r.stdout || '{}');
}

async function silentAudio(outFile, seconds) {
  const r = await runProcess(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', seconds.toFixed(4), '-c:a', 'aac', '-b:a', '128k', outFile], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`יצירת שמע שקט נכשלה: ${ffErr(r.stderr)}`);
}

function findLabelFont() {
  const cands = IS_WIN ? ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf'] : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  return cands.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

/** Contact sheet: every PNG scaled to one cell width, labelled "#n  t.ttS", tiled. */
export async function makeContactSheet(items, outFile, { width, height } = {}) {
  if (!items.length) throw new Error('אין תמונות לגיליון');
  const portrait = (height || 1920) >= (width || 1080);
  const n = items.length;
  const cols = n <= 4 ? n : portrait ? Math.min(6, Math.ceil(Math.sqrt(n * 1.8))) : Math.min(4, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const cellW = portrait ? (cols <= 3 ? 360 : 300) : (cols <= 2 ? 640 : 480);
  const font = findLabelFont();
  const fontSize = Math.round(cellW / 12);
  const build = (withText) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const it of items) args.push('-i', it.path);
    const parts = items.map((it, k) => {
      let f = `[${k}:v]scale=${cellW}:-2:flags=lanczos,format=rgb24`;
      if (withText && font) {
        const label = `#${k + 1}  ${Number(it.t).toFixed(2)}s`;
        const ff = font.replace(/\\/g, '/').replace(/:/g, '\\:');
        f += `,drawtext=fontfile='${ff}':text='${label}':x=10:y=10:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`;
      }
      return `${f}[c${k}]`;
    });
    const chain = `${items.map((_, k) => `[c${k}]`).join('')}concat=n=${n}:v=1:a=0,tile=${cols}x${rows}:padding=8:margin=8:color=0x161616[out]`;
    args.push('-filter_complex', `${parts.join(';')};${chain}`, '-map', '[out]', '-frames:v', '1', '-update', '1', outFile);
    return args;
  };
  let r = await runProcess(FFMPEG, build(true), { timeoutMs: 120_000 });
  if (r.code !== 0) r = await runProcess(FFMPEG, build(false), { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`יצירת גיליון התמונות נכשלה: ${ffErr(r.stderr)}`);
  return { path: outFile, cols, rows, cellWidth: cellW };
}

/* ================================================================== HTTP helpers */

let CTX = null;

function send(res, code, obj, ctx = CTX) {
  if (res.headersSent || res.writableEnded) return;
  if (ctx && typeof ctx.sendJson === 'function') return ctx.sendJson(res, code, obj);
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function log(...a) {
  try { if (CTX && typeof CTX.log === 'function') CTX.log('[export]', ...a); else console.log('[export]', ...a); } catch { /* ignore */ }
}

function queryOf(req) {
  try { return new URL(req.url, 'http://127.0.0.1').searchParams; } catch { return new URLSearchParams(); }
}

function bodyConsumed(req) { return req.readableEnded || req.complete && req.readable === false; }

/** Reads the whole request body (falls back to ctx.readBody if the stream was already consumed upstream). */
async function readRaw(req, limit, ctx = CTX) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req._fsBody)) return req._fsBody;          // already read by main.mjs readBody()
  if (bodyConsumed(req) && ctx && typeof ctx.readBody === 'function') return ctx.readBody(req);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('הבקשה גדולה מדי'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, ctx = CTX) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const buf = await readRaw(req, 16 * 1024 * 1024, ctx);
  if (!buf || !buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('גוף הבקשה אינו JSON תקין'), { status: 400 }); }
}

/** Streams the request body into a file (atomic: tmp + rename). Returns bytes written. */
async function bodyToFile(req, file, limit, ctx = CTX) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  if (Buffer.isBuffer(req.body) || Buffer.isBuffer(req._fsBody) || bodyConsumed(req)) {
    const buf = await readRaw(req, limit, ctx);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    return buf.length;
  }
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; ws.destroy(); fsp.unlink(tmp).catch(() => {}); reject(e); };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(Object.assign(new Error('הקובץ גדול מדי'), { status: 413 })); req.destroy(); return; }
      if (!ws.write(c)) { req.pause(); ws.once('drain', () => req.resume()); }
    });
    req.on('end', () => { if (failed) return; ws.end(() => fsp.rename(tmp, file).then(() => resolve(size), fail)); });
    req.on('error', fail);
    ws.on('error', fail);
  });
}

/* ================================================================== job registry */

const jobs = new Map();   // id → public job object
const priv = new Map();   // id → internal state

const FINISHED = new Set(['done', 'error', 'canceled']);
const isFinished = (job) => FINISHED.has(job.status);

function newJobId(type) {
  return `${type.slice(0, 3)}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** Public, JSON-safe view of a job (also the job config the render page reads). */
export function publicJob(job) {
  if (!job) return null;
  const p = priv.get(job.id);
  const out = { ...job };
  if (p) out.log = p.logs.slice(-30);
  if (job.status === 'running' && job.startedAt) out.elapsed = r2((Date.now() - Date.parse(job.startedAt)) / 1000);
  return out;
}

export function getJob(id) { return jobs.get(id) || null; }
export function listJobs(projectId) {
  return [...jobs.values()].filter((j) => !projectId || j.projectId === projectId).map(publicJob);
}

function createJob(type, projectId, fields, internals) {
  const id = newJobId(type);
  const job = {
    id, type, projectId, status: 'queued', phase: 'queued', progress: 0,
    frames: 0, totalFrames: 0, eta: null, outputs: [], report: null, warnings: [], error: null,
    createdAt: nowIso(), startedAt: null, finishedAt: null, ...fields,
  };
  jobs.set(id, job);
  priv.set(id, {
    logs: [], waiters: new Set(), lastContact: Date.now(), createdMs: Date.now(), broadcastAt: 0, broadcastTimer: null,
    worker: null, assignedAt: 0, retries: 0, pipe: null, frameChain: Promise.resolve(), audioFile: null,
    audioPromise: null, stems: {}, pngs: [], finishing: null, firstFrameMs: 0, dir: null, ...internals,
  });
  pruneJobs();
  return job;
}

function pruneJobs() {
  const finished = [...jobs.values()].filter(isFinished).sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  const now = Date.now();
  for (const j of finished) {
    if (finished.length - (finished.indexOf(j)) > LIMITS.keepFinishedJobs || now - Date.parse(j.finishedAt) > LIMITS.finishedJobTtlMs) {
      jobs.delete(j.id); priv.delete(j.id);
    }
  }
}

function jobLog(job, level, msg) {
  const p = priv.get(job.id);
  const line = `${new Date().toISOString().slice(11, 19)} ${level}: ${String(msg).slice(0, 1500)}`;
  if (p) { p.logs.push(line); if (p.logs.length > 300) p.logs.splice(0, p.logs.length - 300); }
  if (level === 'error') log(`[${job.id}]`, msg);
}

function broadcastJob(job, force = false) {
  const ctx = CTX;
  const p = priv.get(job.id);
  if (!ctx || typeof ctx.broadcast !== 'function' || !p) return;
  const fire = () => {
    p.broadcastAt = Date.now();
    p.broadcastTimer = null;
    try { ctx.broadcast(job.projectId, { type: 'job', job: publicJob(job) }); } catch { /* ignore */ }
  };
  const since = Date.now() - p.broadcastAt;
  if (force || since >= 300) { if (p.broadcastTimer) { clearTimeout(p.broadcastTimer); p.broadcastTimer = null; } fire(); }
  else if (!p.broadcastTimer) p.broadcastTimer = setTimeout(fire, 300 - since);
}

function touch(job) {
  const p = priv.get(job.id);
  if (p) p.lastContact = Date.now();
  if (['queued', 'waiting', 'starting'].includes(job.status)) {
    job.status = 'running';
    job.startedAt ||= nowIso();
    broadcastJob(job, true);
  }
}

function finishJob(job, status, { error = null } = {}) {
  if (isFinished(job)) return;
  const p = priv.get(job.id);
  job.status = status;
  job.finishedAt = nowIso();
  job.eta = null;
  if (status === 'done') { job.progress = 1; job.phase = 'done'; }
  else { job.phase = status; job.error = error || job.error || (status === 'canceled' ? 'המשימה בוטלה' : 'המשימה נכשלה'); }
  if (job.startedAt) job.elapsed = r2((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000);
  if (p) {
    if (p.pipe) { if (status !== 'done') p.pipe.kill(); }
    for (const w of p.waiters) { try { w(); } catch { /* ignore */ } }
    p.waiters.clear();
    if (status !== 'done') jobLog(job, 'error', job.error);
  }
  broadcastJob(job, true);
  releaseWorker(job, status !== 'done');
  cleanupJobFiles(job).catch(() => {});
  log(`${job.id} ${job.type} → ${status}${job.error ? `: ${job.error}` : ''}`);
}

function failJob(job, message) { finishJob(job, 'error', { error: message }); }

async function cleanupJobFiles(job) {
  const p = priv.get(job.id);
  if (!p || !p.dir) return;
  await sleep(1500);
  if (job.status !== 'done') {
    try { await fsp.writeFile(`${p.dir}.log`, p.logs.join('\n'), 'utf8'); } catch { /* ignore */ }
  }
  await fsp.rm(p.dir, { recursive: true, force: true }).catch(() => {});
}

async function ensureJobDir(job) {
  const p = priv.get(job.id);
  if (p.dir) return p.dir;
  const base = CTX && typeof CTX.projectDir === 'function' ? CTX.projectDir(job.projectId) : path.join(CTX?.ROOT || '.', 'projects', job.projectId);
  p.dir = path.join(base, 'cache', 'jobs', job.id);
  await fsp.mkdir(p.dir, { recursive: true });
  return p.dir;
}

/**
 * Lets other server modules (e.g. transcription in main.mjs) publish their background jobs through the same
 * /api/jobs/:job, /api/jobs/:job/wait and SSE "job" events. Their jobs never touch Chrome or ffmpeg here.
 */
export const externalJobs = {
  create(type, projectId, fields = {}) {
    const job = createJob(String(type || 'task'), projectId, { headless: false, external: true, ...fields }, {});
    job.status = 'running'; job.phase = fields.phase || 'running'; job.startedAt = nowIso();
    broadcastJob(job, true);
    return publicJob(job);
  },
  update(id, patch = {}) {
    const job = jobs.get(id);
    if (!job || isFinished(job)) return null;
    const { status, ...rest } = patch;
    Object.assign(job, rest);
    if (isNum(job.progress)) job.progress = clamp(job.progress, 0, 0.99);
    touch(job);
    broadcastJob(job);
    return publicJob(job);
  },
  finish(id, status = 'done', { report = null, outputs = null, error = null, ...rest } = {}) {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, rest);
    if (report) job.report = report;
    if (outputs) job.outputs = outputs;
    finishJob(job, status === 'done' ? 'done' : status === 'canceled' ? 'canceled' : 'error', { error });
    return publicJob(job);
  },
  get: (id) => publicJob(jobs.get(id)),
};

/* ================================================================== Chrome render workers */

/** Chrome/Chromium for headless rendering: env FRAME_STUDIO_CHROME → config.json "chrome" → per-OS auto-detection. */
export function findChrome() {
  return findChromeConfigured();
}

let gpuMode = process.env.FRAME_STUDIO_RENDER_GPU === 'swiftshader' ? 'swiftshader' : 'gpu';
const workers = [];                 // pool slots
const queue = [];                   // job ids waiting for a worker
const LOCK_FILES = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function profileBase() {
  return process.env.FRAME_STUDIO_CHROME_PROFILE || path.join(CTX?.ROOT || process.cwd(), 'projects', '.chrome-render');
}

/** Kills a Chrome left over from a previous server run and removes stale profile locks. Returns the usable profile dir. */
async function prepareProfile(w) {
  let dir = w.index === 0 ? profileBase() : `${profileBase()}-${w.index + 1}`;
  await fsp.mkdir(dir, { recursive: true });
  const pidFile = path.join(dir, 'frame-studio-chrome.pid');
  try {
    const pid = Number((await fsp.readFile(pidFile, 'utf8')).trim());
    if (pid && pid !== process.pid && pidAlive(pid)) { killTreeSync(pid); await sleep(400); }
  } catch { /* no pid file */ }
  let locked = false;
  for (const f of LOCK_FILES) {
    const fp = path.join(dir, f);
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await fsp.rm(fp, { force: true }); break; }
      catch (e) {
        if (attempt === 3) { locked = true; log(`נעילת פרופיל כרום לא שוחררה (${f}): ${e.code}`); }
        else await sleep(300);
      }
    }
  }
  if (locked) {
    dir = `${dir}-${process.pid}-${Date.now().toString(36)}`;
    await fsp.mkdir(dir, { recursive: true });
    w.tempProfile = dir;
  }
  return { dir, pidFile };
}

function chromeArgs(profileDir, width, height, url) {
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`,
    '--autoplay-policy=no-user-gesture-required'];
  if (gpuMode === 'gpu') args.push('--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${angleBackend()}`, '--enable-unsafe-swiftshader');
  else args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
  args.push(`--window-size=${Math.max(64, Math.round(width))},${Math.max(64, Math.round(height))}`,
    '--mute-audio', '--hide-scrollbars', '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-component-update', '--metrics-recording-only',
    '--password-store=basic', '--enable-logging=stderr', '--log-level=2', url);
  return args;
}

function getWorkerSlot() {
  const idleLive = workers.find((w) => w.proc && !w.busy && !w.killing);
  if (idleLive) return idleLive;
  const freeSlot = workers.find((w) => !w.proc && !w.busy && !w.launching);
  if (freeSlot) return freeSlot;
  if (workers.length < LIMITS.poolSize) {
    const w = { index: workers.length, id: null, proc: null, busy: null, assigned: null, waiter: null, idleTimer: null, launching: false, killing: false, tempProfile: null };
    workers.push(w);
    return w;
  }
  return null;
}

function enqueueHeadless(job, front = false) {
  job.status = 'queued';
  job.phase = 'queued';
  if (front) queue.unshift(job.id); else queue.push(job.id);
  broadcastJob(job, true);
  pump();
}

function pump() {
  while (queue.length) {
    const job = jobs.get(queue[0]);
    if (!job || isFinished(job)) { queue.shift(); continue; }
    const w = getWorkerSlot();
    if (!w) return;
    queue.shift();
    assignJob(w, job);
  }
}

function respondWaiter(w, payload) {
  if (!w.waiter) return false;
  const { res, timer } = w.waiter;
  w.waiter = null;
  clearTimeout(timer);
  send(res, 200, payload);
  return true;
}

function assignJob(w, job) {
  const p = priv.get(job.id);
  w.busy = job.id;
  if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null; }
  p.worker = w;
  p.assignedAt = Date.now();
  p.lastContact = Date.now();
  job.status = 'starting';
  job.phase = 'starting';
  broadcastJob(job, true);
  if (w.proc && !w.killing) {
    if (!respondWaiter(w, { job: job.id })) w.assigned = job.id;
  } else {
    launchWorker(w, job).catch((e) => failJob(job, `הפעלת כרום נכשלה: ${e.message}`));
  }
}

async function launchWorker(w, job) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome לא נמצא במחשב (נדרש לרינדור) — התקינו Chrome או הגדירו "chrome" ב-config.json · Google Chrome not found (needed for rendering): install it or set "chrome" in config.json');
  w.launching = true;
  try {
    const { dir, pidFile } = await prepareProfile(w);
    w.id = `w${w.index}-${crypto.randomBytes(4).toString('hex')}`;
    const port = CTX?.PORT || 7788;
    const url = `http://127.0.0.1:${port}/render/render.html?job=${encodeURIComponent(job.id)}&worker=${encodeURIComponent(w.id)}`;
    const args = chromeArgs(dir, job.width || 1080, job.height || 1920, url);
    const logFile = path.join(dir, 'chrome-stderr.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });
    let logged = 0;
    const proc = spawn(chrome, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    w.proc = proc;
    w.profileDir = dir;
    w.pidFile = pidFile;
    w.gpu = gpuMode;
    proc.stderr.on('data', (d) => { if (logged < 2 * 1024 * 1024) { logged += d.length; logStream.write(d); } });
    try { await fsp.writeFile(pidFile, String(proc.pid)); } catch { /* ignore */ }
    const myId = w.id;
    const onGone = (why) => {
      if (w.id !== myId) return;
      try { logStream.end(); } catch { /* ignore */ }
      w.proc = null;
      w.assigned = null;
      respondWaiter(w, { exit: true });
      fsp.rm(pidFile, { force: true }).catch(() => {});
      if (w.tempProfile) { const t = w.tempProfile; w.tempProfile = null; setTimeout(() => fsp.rm(t, { recursive: true, force: true }).catch(() => {}), 2000); }
      const busyId = w.busy;
      w.busy = null;
      w.killing = false;
      if (busyId) {
        const bj = jobs.get(busyId);
        if (bj && !isFinished(bj)) handleWorkerLoss(bj, why);
      }
      pump();
    };
    proc.on('error', (e) => onGone(`כרום לא הופעל: ${e.message}`));
    proc.on('exit', (code) => onGone(`כרום נסגר (קוד ${code})`));
    log(`render worker ${w.id} (${gpuMode}) → ${job.id}`);
  } finally {
    w.launching = false;
  }
}

function killWorker(w, reason) {
  if (!w.proc) return;
  w.killing = true;
  respondWaiter(w, { exit: true });
  log(`killing render worker ${w.id}: ${reason}`);
  killTree(w.proc);
}

function scheduleIdleKill(w) {
  if (w.idleTimer) clearTimeout(w.idleTimer);
  w.idleTimer = setTimeout(() => { w.idleTimer = null; if (!w.busy) killWorker(w, 'idle'); }, LIMITS.workerIdleMs);
  if (w.idleTimer.unref) w.idleTimer.unref();
}

function releaseWorker(job, failed) {
  const p = priv.get(job.id);
  const w = p?.worker;
  if (!w) return;
  p.worker = null;
  if (w.busy !== job.id) return;
  w.busy = null;
  if (w.assigned === job.id) w.assigned = null;
  if (failed && w.proc) killWorker(w, `job ${job.id} ${job.status}`);   // never reuse a page in an unknown state
  else if (w.proc) scheduleIdleKill(w);
  setImmediate(pump);
}

/** Chrome died / hung while owning a job: retry once from scratch if nothing was produced yet. */
function handleWorkerLoss(job, why) {
  const p = priv.get(job.id);
  jobLog(job, 'error', why);
  if (p.retries < 1 && job.frames === 0 && p.pngs.length === 0) {
    p.retries++;
    resetJobForRetry(job);
    jobLog(job, 'warn', 'מנסה שוב עם כרום חדש');
    enqueueHeadless(job, true);
  } else {
    failJob(job, `${why} — הרינדור הופסק`);
  }
}

function resetJobForRetry(job) {
  const p = priv.get(job.id);
  if (p.pipe) { p.pipe.kill(); p.pipe = null; }
  p.worker = null;
  p.audioPromise = null; p.audioFile = null; p.stems = {}; p.pngs = []; p.firstFrameMs = 0;
  p.frameChain = Promise.resolve();
  job.frames = 0; job.progress = 0; job.outputs = []; job.eta = null; job.startedAt = null;
}

/* ================================================================== watchdog */

let watchdog = null;
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (isFinished(job)) continue;
      const p = priv.get(job.id);
      if (!p) continue;
      if (now - p.createdMs > LIMITS.maxJobMs) { failJob(job, 'חרגנו מזמן הרינדור המרבי'); continue; }
      if (job.headless) {
        if (job.status === 'starting' && now - p.assignedAt > LIMITS.startupTimeoutMs) {
          const w = p.worker;
          const why = 'דף הרינדור לא נטען בזמן';
          if (w) { w.busy = null; killWorker(w, why); }
          if (gpuMode === 'gpu' && p.retries < 1) { gpuMode = 'swiftshader'; log('עובר לרינדור תוכנה (SwiftShader) אחרי כשל הפעלה'); }
          handleWorkerLoss(job, why);
        } else if (job.status === 'running' && now - p.lastContact > LIMITS.stallTimeoutMs) {
          failJob(job, 'דף הרינדור הפסיק להגיב (נתקע)');
        }
      } else if (job.status === 'waiting' && now - p.createdMs > LIMITS.waitingTimeoutMs) {
        failJob(job, 'העורך לא התחיל את הייצוא בזמן');
      } else if (job.status === 'running' && now - p.lastContact > LIMITS.inAppStallTimeoutMs) {
        failJob(job, 'הייצוא מהעורך הפסיק להגיב');
      }
    }
    pruneJobs();
  }, 3000);
  if (watchdog.unref) watchdog.unref();
  process.once('exit', () => {
    for (const w of workers) if (w.proc) killTreeSync(w.proc.pid);
    for (const p of priv.values()) if (p.pipe) p.pipe.kill();
  });
}

/* ================================================================== job creation */

async function loadProjectSafe(ctx, id) {
  try { return (await ctx.loadProject(id)) || null; } catch { return null; }
}

/** Number | numeric string | time ref ({word}|{marker}|{clip} | "word:…" | "marker:…") → seconds. */
async function resolveTimeValue(project, v, dflt) {
  if (v == null || v === '') return dflt;
  const n = numOr(v, null);
  if (n != null) return n;
  let ref = v;
  if (typeof v === 'string') {
    const m = v.match(/^(word|marker|clip):(.+)$/);
    if (!m) throw Object.assign(new Error(`זמן לא תקין: ${v}`), { status: 400 });
    ref = m[1] === 'word' ? { word: m[2] } : m[1] === 'marker' ? { marker: m[2] } : { clip: m[2] };
  }
  try {
    const ops = await import('../shared/ops.js');
    if (typeof ops.resolveTime === 'function') {
      const r = ops.resolveTime(project, ref);
      const rv = isNum(r) ? r : isNum(r?.t) ? r.t : null;
      if (rv != null) return rv;
    }
  } catch { /* fall back below */ }
  if (ref && typeof ref === 'object') {
    const off = numOr(ref.offset, 0);
    if (ref.marker != null) {
      const mk = (project.markers || []).find((m) => m.label === ref.marker || m.id === ref.marker);
      if (mk) return mk.t + off;
    }
    if (ref.clip != null) {
      const c = project.clips?.[ref.clip];
      if (c) return (ref.edge === 'end' ? c.start + c.duration : c.start) + off;
    }
    if (ref.word != null) {
      const norm = (s) => String(s).replace(/[\u0591-\u05C7]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
      const words = project.transcript?.words || [];
      let hits = words.filter((w) => w.w === ref.word);
      if (!hits.length) hits = words.filter((w) => norm(w.w) === norm(ref.word));
      const w = hits[numOr(ref.n, 0)];
      if (w) return (ref.edge === 'end' ? w.e : w.s) + off;
    }
  }
  throw Object.assign(new Error(`לא הצלחתי לפענח את הזמן ${JSON.stringify(v)}`), { status: 400 });
}

function resolveOutputFile(ctx, projectId, project, out) {
  const exportsDir = path.join(ctx.projectDir(projectId), 'exports');
  const defaultName = `${safeFileName(project.name, projectId)}-${stamp()}.mp4`;
  if (!out || !String(out).trim()) return path.join(exportsDir, defaultName);
  const raw = String(out).trim();
  let file = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(exportsDir, raw);
  let isDir = /[\\/]$/.test(raw);
  if (!isDir) { try { isDir = fs.statSync(file).isDirectory(); } catch { /* new file */ } }
  if (isDir) return path.join(file, defaultName);
  if (!/\.mp4$/i.test(file)) file += '.mp4';
  return file;
}

function parseSize(body, W, H) {
  let ow = numOr(body.width, null), oh = numOr(body.height, null);
  if (typeof body.size === 'string') {
    const m = body.size.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (m) { ow = Number(m[1]); oh = Number(m[2]); }
  }
  const sc = numOr(body.scale, null);
  if (sc && sc > 0 && !ow && !oh) { ow = W * sc; oh = H * sc; }
  if (ow && !oh) oh = (ow * H) / W;
  if (oh && !ow) ow = (oh * W) / H;
  return { outWidth: even(clamp(ow || W, 16, 8192)), outHeight: even(clamp(oh || H, 16, 8192)) };
}

async function hExport(req, res, match, ctx) {
  const projectId = decodeURIComponent(match.groups?.id ?? match[1]);
  const body = await readJsonBody(req, ctx);
  const project = await loadProjectSafe(ctx, projectId);
  if (!project) return send(res, 404, { error: 'הפרויקט לא נמצא' }, ctx);
  const s = project.settings || {};
  const W = Math.round(numOr(s.width, 1080)), H = Math.round(numOr(s.height, 1920));
  const fps = clamp(numOr(body.fps, numOr(s.fps, 30)), 1, 240);
  const from = Math.max(0, await resolveTimeValue(project, body.from, 0));
  const to = await resolveTimeValue(project, body.to, projectDuration(project));
  if (!(to > from)) return send(res, 400, { error: 'טווח הייצוא ריק (to חייב להיות אחרי from)' }, ctx);
  const totalFrames = Math.max(1, Math.ceil((to - from) * fps - 1e-6));
  const preset = PRESETS.includes(body.preset) ? body.preset : 'medium';
  const crf = Math.round(clamp(numOr(body.crf, 18), 0, 51));
  const lufs = clamp(numOr(body.lufs, numOr(s.targetLufs, -14)), -40, -5);
  const check = body.check !== false;
  const out = resolveOutputFile(ctx, projectId, project, body.out);
  const { outWidth, outHeight } = parseSize(body, W, H);
  const job = createJob('export', projectId, {
    projectName: project.name || projectId, from, to: from + totalFrames / fps, fps, totalFrames,
    width: W, height: H, outWidth, outHeight, sampleRate: 48000, stems: check, check, crf, preset, lufs,
    headless: body.headless !== false, out, projectRev: project.rev ?? null,
  }, { projectJson: JSON.stringify(project) });
  if (job.headless) enqueueHeadless(job);
  else { job.status = 'waiting'; job.phase = 'waiting'; broadcastJob(job, true); }
  send(res, 200, publicJob(job), ctx);
}

async function pruneSnapshotFolders(base) {
  try {
    const ents = (await fsp.readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{8}-\d{6}/.test(e.name)).map((e) => e.name).sort();
    const extra = ents.length - LIMITS.snapshotFoldersKept;
    for (let i = 0; i < extra; i++) await fsp.rm(path.join(base, ents[i]), { recursive: true, force: true });
  } catch { /* none yet */ }
}

async function hSnapshot(req, res, match, ctx) {
  const projectId = decodeURIComponent(match.groups?.id ?? match[1]);
  const body = await readJsonBody(req, ctx);
  const project = await loadProjectSafe(ctx, projectId);
  if (!project) return send(res, 404, { error: 'הפרויקט לא נמצא' }, ctx);
  let raw = body.times ?? body.at ?? [];
  if (!Array.isArray(raw)) raw = typeof raw === 'string' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [raw];
  if (!raw.length) return send(res, 400, { error: 'יש לציין לפחות זמן אחד (times)' }, ctx);
  if (raw.length > 200) return send(res, 400, { error: 'יותר מדי תמונות בבקשה אחת (עד 200)' }, ctx);
  const times = [];
  for (const v of raw) times.push(Math.max(0, await resolveTimeValue(project, v, 0)));
  const s = project.settings || {};
  const scale = clamp(numOr(body.scale, 1), 0.05, 2);
  const snapBase = path.join(ctx.projectDir(projectId), 'snapshots');
  let dir;
  if (body.out && String(body.out).trim()) dir = path.isAbsolute(body.out) ? path.resolve(body.out) : path.resolve(snapBase, body.out);
  else { await pruneSnapshotFolders(snapBase); dir = path.join(snapBase, `${stamp()}-${crypto.randomBytes(2).toString('hex')}`); }
  const job = createJob('snapshot', projectId, {
    projectName: project.name || projectId, times, scale, sheet: !!body.sheet, dir,
    width: Math.round(numOr(s.width, 1080)), height: Math.round(numOr(s.height, 1920)),
    fps: numOr(s.fps, 30), totalFrames: times.length, headless: body.headless !== false, projectRev: project.rev ?? null,
  }, { projectJson: JSON.stringify(project) });
  if (job.headless) enqueueHeadless(job);
  else { job.status = 'waiting'; job.phase = 'waiting'; broadcastJob(job, true); }
  send(res, 200, publicJob(job), ctx);
}

async function hCheckAudio(req, res, match, ctx) {
  const projectId = decodeURIComponent(match.groups?.id ?? match[1]);
  const body = await readJsonBody(req, ctx);
  const project = await loadProjectSafe(ctx, projectId);
  if (!project) return send(res, 404, { error: 'הפרויקט לא נמצא' }, ctx);
  const s = project.settings || {};
  const from = Math.max(0, await resolveTimeValue(project, body.from, 0));
  const to = await resolveTimeValue(project, body.to, projectDuration(project));
  if (!(to > from)) return send(res, 400, { error: 'טווח הבדיקה ריק' }, ctx);
  const job = createJob('audio', projectId, {
    projectName: project.name || projectId, from, to, fps: numOr(s.fps, 30), sampleRate: 48000, stems: true, check: true,
    lufs: clamp(numOr(body.lufs, numOr(s.targetLufs, -14)), -40, -5), threshold: numOr(body.threshold, 12),
    width: Math.round(numOr(s.width, 1080)), height: Math.round(numOr(s.height, 1920)),
    headless: body.headless !== false, projectRev: project.rev ?? null,
  }, { projectJson: JSON.stringify(project) });
  if (job.headless) enqueueHeadless(job);
  else { job.status = 'waiting'; job.phase = 'waiting'; broadcastJob(job, true); }
  send(res, 200, publicJob(job), ctx);
}

/* ================================================================== job endpoints (page side) */

function jobFrom(match) {
  const id = decodeURIComponent(match.groups?.job ?? match[1]);
  return jobs.get(id) || null;
}

function goneOr(res, job, ctx) {
  if (!job) { send(res, 404, { error: 'המשימה לא נמצאה' }, ctx); return true; }
  if (isFinished(job)) { send(res, 410, { error: job.status === 'canceled' ? 'המשימה בוטלה' : 'המשימה כבר הסתיימה', status: job.status }, ctx); return true; }
  return false;
}

async function hProgress(req, res, match, ctx) {
  const job = jobFrom(match);
  const body = await readJsonBody(req, ctx).catch(() => ({}));
  if (goneOr(res, job, ctx)) return;
  touch(job);
  if (typeof body.phase === 'string' && body.phase !== 'heartbeat') job.phase = body.phase;
  if (job.type !== 'export' && isNum(body.progress)) job.progress = clamp(body.progress, 0, 0.99);
  if (job.type === 'export' && body.phase === 'audio' && isNum(body.progress) && job.frames === 0) job.progress = clamp(body.progress * 0.04, 0, 0.04);
  broadcastJob(job);
  send(res, 200, { ok: true, status: job.status }, ctx);
}

async function hFrame(req, res, match, ctx) {
  const job = jobFrom(match);
  if (goneOr(res, job, ctx)) { req.resume(); return; }
  if (job.type !== 'export') { req.resume(); return send(res, 400, { error: 'משימה זו אינה ייצוא וידאו' }, ctx); }
  const p = priv.get(job.id);
  const n = parseInt(req.headers['x-frame'], 10);
  const frameBytes = job.width * job.height * 4;
  let buf;
  try { buf = await readRaw(req, Math.min(LIMITS.maxFrameBytes, frameBytes + 64), ctx); }
  catch (e) { return send(res, e.status || 400, { error: e.message }, ctx); }
  if (buf.length !== frameBytes) return send(res, 400, { error: `גודל פריים שגוי: ${buf.length} במקום ${frameBytes}` }, ctx);
  const work = p.frameChain.then(async () => {
    if (isFinished(job)) return { code: 410, body: { error: 'המשימה הסתיימה' } };
    touch(job);
    const idx = Number.isFinite(n) ? n : job.frames;
    if (idx < job.frames) return { code: 200, body: { ok: true, duplicate: true, n: idx } };
    if (idx > job.frames) return { code: 400, body: { error: `פריים ${job.frames} חסר (התקבל ${idx})` } };
    if (idx >= job.totalFrames) return { code: 400, body: { error: 'התקבלו יותר פריימים מהמתוכנן' } };
    if (!p.pipe) {
      const dir = await ensureJobDir(job);
      p.pipe = new FramePipe({ width: job.width, height: job.height, fps: job.fps, out: path.join(dir, 'video.mp4'),
        crf: job.crf, preset: job.preset, outWidth: job.outWidth, outHeight: job.outHeight }).start();
      p.firstFrameMs = Date.now();
    }
    await p.pipe.write(buf);
    job.frames++;
    job.phase = 'video';
    job.progress = clamp(0.04 + 0.92 * (job.frames / job.totalFrames), 0, 0.96);
    const el = (Date.now() - p.firstFrameMs) / 1000;
    const rate = job.frames / Math.max(el, 1e-3);
    job.renderFps = r2(rate);
    job.eta = job.frames > 3 ? Math.round((job.totalFrames - job.frames) / Math.max(rate, 1e-3)) : null;
    broadcastJob(job);
    return { code: 200, body: { ok: true, n: idx } };
  });
  p.frameChain = work.catch(() => {});
  try {
    const r = await work;
    send(res, r.code, r.body, ctx);
  } catch (e) {
    failJob(job, `קידוד הווידאו נכשל: ${e.message}`);
    send(res, 500, { error: e.message }, ctx);
  }
}

async function hAudio(req, res, match, ctx) {
  const job = jobFrom(match);
  if (goneOr(res, job, ctx)) { req.resume(); return; }
  if (job.type === 'snapshot') { req.resume(); return send(res, 400, { error: 'למשימת תמונות אין שמע' }, ctx); }
  touch(job);
  const p = priv.get(job.id);
  const dir = await ensureJobDir(job);
  const file = path.join(dir, 'mix.wav');
  try { await bodyToFile(req, file, LIMITS.maxAudioBytes, ctx); }
  catch (e) { return send(res, e.status || 500, { error: `שמירת השמע נכשלה: ${e.message}` }, ctx); }
  p.audioFile = file;
  if (job.type === 'export') {
    job.phase = 'audio';
    const target = job.lufs;
    p.audioPromise = masterAudio(file, path.join(dir, 'audio.m4a'), { targetLufs: target, truePeakMax: -1 });
    p.audioPromise.catch((e) => jobLog(job, 'error', `מאסטרינג נכשל: ${e.message}`));
  }
  broadcastJob(job);
  send(res, 200, { ok: true }, ctx);
}

async function hStems(req, res, match, ctx) {
  const job = jobFrom(match);
  if (goneOr(res, job, ctx)) { req.resume(); return; }
  const kind = queryOf(req).get('kind');
  if (kind !== 'voice' && kind !== 'background') { req.resume(); return send(res, 400, { error: 'kind חייב להיות voice או background' }, ctx); }
  touch(job);
  const p = priv.get(job.id);
  const dir = await ensureJobDir(job);
  const file = path.join(dir, `stem-${kind}.wav`);
  try { await bodyToFile(req, file, LIMITS.maxAudioBytes, ctx); }
  catch (e) { return send(res, e.status || 500, { error: `שמירת שכבת השמע נכשלה: ${e.message}` }, ctx); }
  p.stems[kind] = file;
  send(res, 200, { ok: true }, ctx);
}

async function hPng(req, res, match, ctx) {
  const job = jobFrom(match);
  if (goneOr(res, job, ctx)) { req.resume(); return; }
  if (job.type !== 'snapshot') { req.resume(); return send(res, 400, { error: 'משימה זו אינה צילום תמונות' }, ctx); }
  touch(job);
  const p = priv.get(job.id);
  const q = queryOf(req);
  const t = numOr(q.get('t'), 0);
  const i = Math.max(0, Math.round(numOr(q.get('i'), p.pngs.length)));
  const file = path.join(job.dir, `${String(i + 1).padStart(2, '0')}_${t.toFixed(2)}s.png`);
  try { await bodyToFile(req, file, 256 * 1024 * 1024, ctx); }
  catch (e) { return send(res, e.status || 500, { error: `שמירת התמונה נכשלה: ${e.message}` }, ctx); }
  p.pngs = p.pngs.filter((x) => x.i !== i);
  p.pngs.push({ i, t, path: file });
  job.frames = p.pngs.length;
  job.progress = clamp(p.pngs.length / Math.max(1, job.times.length), 0, 0.98);
  job.phase = 'snapshot';
  broadcastJob(job);
  send(res, 200, { ok: true, path: file }, ctx);
}

async function hLog(req, res, match, ctx) {
  const job = jobFrom(match);
  const body = await readJsonBody(req, ctx).catch(() => ({}));
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  const p = priv.get(job.id);
  if (p) p.lastContact = Date.now();
  jobLog(job, body.level === 'error' ? 'page-error' : 'page-warn', body.msg || '');
  send(res, 200, { ok: true }, ctx);
}

async function hFail(req, res, match, ctx) {
  const job = jobFrom(match);
  const body = await readJsonBody(req, ctx).catch(() => ({}));
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  if (isFinished(job)) return send(res, 200, publicJob(job), ctx);
  const msg = String(body.error || 'הרינדור נכשל').slice(0, 2000);
  if (body.stack) jobLog(job, 'page-error', body.stack);
  const p = priv.get(job.id);
  if (body.canceled) { finishJob(job, 'canceled'); return send(res, 200, publicJob(job), ctx); }
  // WebGL failure before anything was produced on the GPU path → retry once with SwiftShader.
  if (job.headless && gpuMode === 'gpu' && /webgl|gl context|context lost|getContext/i.test(msg) && job.frames === 0 && p.pngs.length === 0 && p.retries < 1) {
    gpuMode = 'swiftshader';
    log(`WebGL נכשל בכרום (${msg}) — עובר ל-SwiftShader`);
    const w = p.worker;
    p.retries++;
    if (w) { w.busy = null; killWorker(w, 'webgl failure'); }
    resetJobForRetry(job);
    enqueueHeadless(job, true);
    return send(res, 200, publicJob(job), ctx);
  }
  failJob(job, msg);
  send(res, 200, publicJob(job), ctx);
}

async function hCancel(req, res, match, ctx) {
  const job = jobFrom(match);
  req.resume();
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  if (!isFinished(job)) {
    const qi = queue.indexOf(job.id);
    if (qi >= 0) queue.splice(qi, 1);
    finishJob(job, 'canceled');
  }
  send(res, 200, publicJob(job), ctx);
}

async function hDone(req, res, match, ctx) {
  const job = jobFrom(match);
  const body = await readJsonBody(req, ctx).catch(() => ({}));
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  if (isFinished(job)) return send(res, job.status === 'done' ? 200 : 410, publicJob(job), ctx);
  touch(job);
  const p = priv.get(job.id);
  if (Array.isArray(body.warnings)) for (const w of body.warnings) if (w && !job.warnings.includes(w)) job.warnings.push(String(w));
  if (!p.finishing) {
    job.status = 'finishing';
    job.phase = 'encoding';
    broadcastJob(job, true);
    p.finishing = (async () => {
      try {
        await p.frameChain;
        if (job.type === 'export') await finalizeExport(job);
        else if (job.type === 'snapshot') await finalizeSnapshot(job);
        else await finalizeAudioCheck(job);
        finishJob(job, 'done');
      } catch (e) {
        failJob(job, e.message || String(e));
      }
    })();
  }
  await p.finishing;
  send(res, job.status === 'done' ? 200 : 500, publicJob(job), ctx);
}

/* ================================================================== finalizers */

async function marginFromStems(job, p) {
  if (!job.check || !p.stems.voice || !p.stems.background) return null;
  try {
    const [v, b] = await Promise.all([fsp.readFile(p.stems.voice), fsp.readFile(p.stems.background)]);
    return computeSpeechMargin(v, b, { offset: job.from, thresholdDb: numOr(job.threshold, 12) });
  } catch (e) {
    jobLog(job, 'warn', `בדיקת מרווח הדיבור נכשלה: ${e.message}`);
    return { error: e.message };
  }
}

async function finalizeExport(job) {
  const p = priv.get(job.id);
  const dir = await ensureJobDir(job);
  if (job.frames !== job.totalFrames) throw new Error(`התקבלו ${job.frames} פריימים מתוך ${job.totalFrames}`);
  job.phase = 'encoding';
  job.progress = 0.97;
  broadcastJob(job, true);
  await p.pipe.finish();
  const duration = job.totalFrames / job.fps;
  let audioReport = null;
  let audioFile = path.join(dir, 'audio.m4a');
  if (p.audioPromise) {
    job.phase = 'loudness';
    broadcastJob(job, true);
    audioReport = await p.audioPromise;
    if (audioReport.warning) job.warnings.push(audioReport.warning);
  } else {
    job.warnings.push('לא התקבל שמע מהרינדור — נוסף פס שמע שקט');
    await silentAudio(audioFile, duration);
  }
  job.phase = 'mux';
  job.progress = 0.99;
  broadcastJob(job, true);
  await fsp.mkdir(path.dirname(job.out), { recursive: true });
  const part = job.out.replace(/\.mp4$/i, '.part.mp4');
  await muxAv(path.join(dir, 'video.mp4'), audioFile, part, { title: job.projectName });
  await fsp.rm(job.out, { force: true }).catch(() => {});
  try {
    await fsp.rename(part, job.out);
  } catch (e) {
    // Target locked (e.g. open in a player) → keep the export under a fresh name instead of failing it.
    const alt = job.out.replace(/\.mp4$/i, `-${stamp()}.mp4`);
    await fsp.rename(part, alt);
    job.warnings.push(`הקובץ ${path.basename(job.out)} היה נעול (${e.code || e.message}) — נשמר בשם ${path.basename(alt)}`);
    job.out = alt;
  }
  const probe = await probeFile(job.out);
  const fmt = probe.format || {};
  const vs = (probe.streams || []).find((s) => s.codec_type === 'video') || {};
  const as = (probe.streams || []).find((s) => s.codec_type === 'audio') || {};
  const size = numOr(fmt.size, 0) || (await fsp.stat(job.out)).size;
  const margin = await marginFromStems(job, p);
  const lufs = audioReport?.output?.I ?? null;
  const tp = audioReport?.output?.truePeak ?? null;
  const renderSec = job.startedAt ? (Date.now() - Date.parse(job.startedAt)) / 1000 : null;
  const report = {
    file: job.out, size, sizeMB: r2(size / 1048576), duration: r2(numOr(fmt.duration, duration)),
    width: vs.width ?? job.outWidth, height: vs.height ?? job.outHeight, fps: job.fps, frames: job.totalFrames,
    videoCodec: vs.codec_name || 'h264', audioCodec: as.codec_name || 'aac', from: job.from, to: job.to,
    lufs: isNum(lufs) ? r2(lufs) : lufs, truePeak: isNum(tp) ? r2(tp) : tp,
    loudness: audioReport ? {
      targetLufs: job.lufs, silent: !!audioReport.silent,
      inputLufs: r2(audioReport.input?.I), inputTruePeak: r2(audioReport.input?.truePeak),
      gainDb: r2(audioReport.gainDb), limiter: audioReport.limit, lra: r2(audioReport.output?.LRA), passes: audioReport.passes,
    } : null,
    speechMargin: margin,
    renderSeconds: renderSec != null ? r2(renderSec) : null,
    renderFps: job.renderFps ?? null,
    warnings: job.warnings,
  };
  const lines = [
    `נשמר: ${job.out}`,
    `משך ${report.duration} שנ׳ · ${report.width}×${report.height} · ${job.fps}fps · ${report.sizeMB}MB`,
  ];
  if (audioReport?.silent) lines.push('השמע שקט לגמרי — לא בוצע נרמול עוצמה');
  else if (audioReport) lines.push(`עוצמה ${report.lufs} LUFS (יעד ${job.lufs}) · שיא אמיתי ${report.truePeak} dBTP`);
  if (margin?.summary) lines.push(margin.summary);
  for (const w of job.warnings) lines.push(`אזהרה: ${w}`);
  report.summary = lines.join('\n');
  job.report = report;
  job.outputs = [{ kind: 'video', path: job.out, size }];
}

async function finalizeSnapshot(job) {
  const p = priv.get(job.id);
  const items = p.pngs.slice().sort((a, b) => a.i - b.i);
  if (!items.length) throw new Error('לא התקבלו תמונות');
  if (items.length < job.times.length) job.warnings.push(`התקבלו ${items.length} תמונות מתוך ${job.times.length}`);
  job.outputs = items.map((x) => ({ kind: 'png', t: x.t, i: x.i, path: x.path }));
  let sheet = null;
  if (job.sheet && items.length > 0) {
    job.phase = 'snapshot';
    broadcastJob(job, true);
    try {
      const r = await makeContactSheet(items, path.join(job.dir, 'sheet.png'), { width: job.width, height: job.height });
      sheet = r.path;
      job.outputs.push({ kind: 'sheet', path: sheet });
    } catch (e) {
      job.warnings.push(e.message);
    }
  }
  job.report = {
    dir: job.dir, count: items.length, files: items.map((x) => x.path), sheet, scale: job.scale, warnings: job.warnings,
    summary: [`${items.length} תמונות נשמרו בתיקייה ${job.dir}`, ...(sheet ? [`גיליון: ${sheet}`] : []), ...job.warnings.map((w) => `אזהרה: ${w}`)].join('\n'),
  };
}

async function finalizeAudioCheck(job) {
  const p = priv.get(job.id);
  if (!p.audioFile) throw new Error('לא התקבל שמע לבדיקה');
  const m = await measureLoudness(p.audioFile);
  const margin = await marginFromStems(job, p);
  const gain = computeLoudnessGain(m.I, job.lufs);
  const report = {
    from: job.from, to: job.to, duration: r2(job.to - job.from),
    mixLufs: isNum(m.I) ? r2(m.I) : m.I, mixTruePeak: isNum(m.truePeak) ? r2(m.truePeak) : m.truePeak, lra: r2(m.LRA),
    targetLufs: job.lufs, exportGainDb: r2(gain), silent: m.silent, speechMargin: margin, warnings: job.warnings,
  };
  const lines = [
    m.silent ? 'המיקס שקט' : `עוצמת המיקס לפני נרמול: ${report.mixLufs} LUFS, שיא ${report.mixTruePeak} dBTP (בייצוא ${gain >= 0 ? "יוגבר" : "יונמך"} ב-${Math.abs(report.exportGainDb)} dB אל ${job.lufs} LUFS)`,
  ];
  if (margin?.summary) lines.push(margin.summary);
  for (const w of job.warnings) lines.push(`אזהרה: ${w}`);
  report.summary = lines.join('\n');
  job.report = report;
}

/* ================================================================== status endpoints */

async function hGetJob(req, res, match, ctx) {
  const job = jobFrom(match);
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  send(res, 200, publicJob(job), ctx);
}

async function hJobProject(req, res, match, ctx) {
  const job = jobFrom(match);
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  const p = priv.get(job.id);
  if (p) p.lastContact = Date.now();
  if (!p?.projectJson) {
    const pr = await loadProjectSafe(ctx, job.projectId);
    if (!pr) return send(res, 404, { error: 'הפרויקט לא נמצא' }, ctx);
    return send(res, 200, pr, ctx);
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(p.projectJson);
}

async function hListJobs(req, res, match, ctx) {
  send(res, 200, listJobs(queryOf(req).get('project') || null), ctx);
}

/** Long-poll until the job finishes (≤ 10 min). Headers go out at once and a space is trickled every 15 s so
 *  HTTP clients (undici's 300 s header/body timeouts) never give up; the body is JSON (leading whitespace is valid). */
async function hWait(req, res, match, ctx) {
  const job = jobFrom(match);
  if (!job) return send(res, 404, { error: 'המשימה לא נמצאה' }, ctx);
  if (isFinished(job)) return send(res, 200, { ...publicJob(job), finished: true }, ctx);
  const timeoutSec = clamp(numOr(queryOf(req).get('timeout'), LIMITS.waitMaxSec), 1, LIMITS.waitMaxSec);
  const p = priv.get(job.id);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearInterval(keep); clearTimeout(timer);
    p?.waiters.delete(finish);
    try { res.end(JSON.stringify({ ...publicJob(job), finished: isFinished(job) })); } catch { /* client gone */ }
  };
  const keep = setInterval(() => { try { res.write(' '); } catch { /* ignore */ } }, 15_000);
  const timer = setTimeout(finish, timeoutSec * 1000);
  p?.waiters.add(finish);
  req.on('close', () => { if (!ended) { ended = true; clearInterval(keep); clearTimeout(timer); p?.waiters.delete(finish); } });
}

/** Render-worker pull: the idle headless page asks for its next job (held ≤ 20 s). */
async function hWorkerNext(req, res, match, ctx) {
  const wid = queryOf(req).get('worker');
  const w = workers.find((x) => x.id && x.id === wid);
  if (!w || w.killing) return send(res, 200, { exit: true }, ctx);
  if (w.assigned) {
    const id = w.assigned;
    w.assigned = null;
    return send(res, 200, { job: id }, ctx);
  }
  if (w.waiter) respondWaiter(w, { job: null });
  const timer = setTimeout(() => respondWaiter(w, { job: null }), 20_000);
  w.waiter = { res, timer };
  req.on('close', () => { if (w.waiter && w.waiter.res === res) { clearTimeout(w.waiter.timer); w.waiter = null; } });
  if (!w.busy) scheduleIdleKillIfNeeded(w);
}

function scheduleIdleKillIfNeeded(w) { if (!w.idleTimer && !w.busy) scheduleIdleKill(w); }

/* ================================================================== routes */

function wrap(handler) {
  return async (req, res, match, ctx) => {
    const c = ctx || CTX;
    try {
      await handler(req, res, match, c);
    } catch (e) {
      log('handler error:', e?.stack || e);
      if (!res.headersSent) send(res, e?.status || 500, { error: e?.message || 'שגיאה פנימית בייצוא' }, c);
      else { try { res.end(); } catch { /* ignore */ } }
    }
  };
}

const Q = '(?:\\?.*)?$';
const ID = '([^/?]+)';

/** SPEC §5 mounting contract. */
export function routes(ctx) {
  CTX = ctx;
  startWatchdog();
  const r = (method, re, handler) => ({ method, pattern: new RegExp(`^${re}${Q}`), handler: wrap(handler) });
  return [
    r('POST', `/api/projects/${ID}/export`, hExport),
    r('POST', `/api/projects/${ID}/snapshot`, hSnapshot),
    r('POST', `/api/projects/${ID}/check-audio`, hCheckAudio),
    r('GET', '/api/jobs', hListJobs),
    r('GET', `/api/jobs/${ID}/wait`, hWait),
    r('GET', `/api/jobs/${ID}/project`, hJobProject),
    r('POST', `/api/jobs/${ID}/progress`, hProgress),
    r('POST', `/api/jobs/${ID}/frame`, hFrame),
    r('POST', `/api/jobs/${ID}/audio`, hAudio),
    r('POST', `/api/jobs/${ID}/stems`, hStems),
    r('POST', `/api/jobs/${ID}/png`, hPng),
    r('POST', `/api/jobs/${ID}/done`, hDone),
    r('POST', `/api/jobs/${ID}/fail`, hFail),
    r('POST', `/api/jobs/${ID}/log`, hLog),
    r('POST', `/api/jobs/${ID}/cancel`, hCancel),
    r('GET', `/api/jobs/${ID}`, hGetJob),
    r('GET', '/api/render-worker/next', hWorkerNext),
  ];
}

export default routes;
