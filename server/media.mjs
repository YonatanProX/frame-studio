// Frame Studio — media: ffprobe, derivative generation (proxy / wav / peaks / thumbs), ffmpeg queue,
// PCM decoding helpers and HTTP file serving with Range support.
// Paths may contain Hebrew and spaces: every child process gets an args array (never a shell string).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import { ffmpegPath, ffprobePath } from './config.mjs';

// env FRAME_STUDIO_FFMPEG / FRAME_STUDIO_FFPROBE → config.json "ffmpeg" / "ffprobe" → PATH
export const FFMPEG = ffmpegPath();
export const FFPROBE = ffprobePath();
export const MAX_CONCURRENT = 2;
export const PROXY_LONG_SIDE = 1920;
export const THUMB_HEIGHT = 120;

// ---------------------------------------------------------------- MIME types

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.mts': 'video/mp2t',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.wma': 'audio/x-ms-wma',
  '.cube': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.pdf': 'application/pdf', '.xml': 'application/xml',
};

export function mimeFor(p) {
  return MIME[path.extname(String(p)).toLowerCase()] || 'application/octet-stream';
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif', '.svg', '.jfif']);
export const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aif', '.aiff', '.wma']);
export const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.ts', '.mts', '.gif']);

// ---------------------------------------------------------------- child processes

const children = new Set();

/** Kill every running ffmpeg/ffprobe child (server shutdown). */
export function killAll() {
  for (const ch of children) { try { ch.kill(); } catch { /* already gone */ } }
  children.clear();
}

/**
 * Spawn a process and collect its output.
 * opts: { cwd, env, onStdout(buf), onStderr(buf), collectStdout=true, maxStderr=16384, signal }
 * → Promise<{ code, stdout:Buffer, stderr:string }>
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let ch;
    try {
      ch = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    children.add(ch);
    const out = [];
    let err = '';
    const maxErr = opts.maxStderr ?? 16384;
    ch.stdout.on('data', (b) => { if (opts.onStdout) opts.onStdout(b); if (opts.collectStdout !== false) out.push(b); });
    ch.stderr.on('data', (b) => {
      if (opts.onStderr) opts.onStderr(b);
      err += b.toString('utf8');
      if (err.length > maxErr * 2) err = err.slice(-maxErr);
    });
    if (opts.signal) {
      const abort = () => { try { ch.kill(); } catch { /* ignore */ } };
      if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort, { once: true });
    }
    ch.on('error', (e) => { children.delete(ch); reject(e); });
    ch.on('close', (code) => {
      children.delete(ch);
      resolve({ code, stdout: Buffer.concat(out), stderr: err.slice(-maxErr) });
    });
  });
}

function tail(s, n = 600) {
  s = String(s || '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

/**
 * Run ffmpeg with machine-readable progress. duration (s) is used to turn out_time into 0..1.
 * → Promise<void>; rejects with a Hebrew message + stderr tail.
 */
export async function runFfmpeg(args, { duration = 0, onProgress, signal, cwd } = {}) {
  let buf = '';
  let last = -1;
  const full = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', ...args];
  const res = await run(FFMPEG, full, {
    cwd, signal, collectStdout: false,
    onStdout: (b) => {
      if (!onProgress) return;
      buf += b.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration > 0) {
          const p = Math.max(0, Math.min(1, Number(m[1]) / 1e6 / duration));
          if (p - last >= 0.01) { last = p; onProgress(p); }
        } else if (line === 'progress=end') { onProgress(1); }
      }
    },
  }).catch((e) => { throw new Error(e && e.code === 'ENOENT' ? 'ffmpeg לא נמצא ב-PATH' : `הפעלת ffmpeg נכשלה: ${e.message}`); });
  if (res.code !== 0) throw new Error(`ffmpeg נכשל (קוד ${res.code}): ${tail(res.stderr)}`);
}

// ---------------------------------------------------------------- queue (max 2 concurrent ffmpeg)

const queue = [];
let active = 0;

/** Enqueue an async task (one ffmpeg process). priority: lower runs first (default 5). */
export function enqueue(fn, priority = 5) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject, priority, seq: seqNo++ });
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    pump();
  });
}
let seqNo = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}

export function queueStats() { return { active, waiting: queue.length, max: MAX_CONCURRENT }; }

// ---------------------------------------------------------------- probe

/** ffprobe -v error -show_streams -show_format -of json <path> → parsed JSON */
export async function probe(p) {
  let res;
  try {
    res = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', p]);
  } catch (e) {
    throw new Error(e && e.code === 'ENOENT' ? 'ffprobe לא נמצא ב-PATH' : `הפעלת ffprobe נכשלה: ${e.message}`);
  }
  if (res.code !== 0) throw new Error(`לא ניתן לקרוא את הקובץ (ffprobe): ${tail(res.stderr, 300) || path.basename(p)}`);
  try { return JSON.parse(res.stdout.toString('utf8')); } catch { throw new Error('פלט ffprobe לא תקין'); }
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function parseRate(r) {
  if (!r || typeof r !== 'string') return 0;
  const [a, b] = r.split('/').map(Number);
  if (!b) return num(a);
  const v = a / b;
  return Number.isFinite(v) ? v : 0;
}

function rotationOf(stream) {
  let rot = 0;
  if (stream.tags && stream.tags.rotate != null) rot = num(stream.tags.rotate);
  for (const sd of stream.side_data_list || []) if (sd.rotation != null) rot = num(sd.rotation);
  rot = ((Math.round(rot) % 360) + 360) % 360;
  return rot;
}

/** Read width/height of an SVG file (probe cannot decode SVG without librsvg). */
async function svgSize(p) {
  try {
    const txt = (await fsp.readFile(p, 'utf8')).slice(0, 8192);
    const tag = /<svg\b[^>]*>/i.exec(txt);
    if (!tag) return null;
    const attr = (n) => { const m = new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag[0]); return m ? m[1] : null; };
    let w = parseFloat(attr('width') || ''), h = parseFloat(attr('height') || '');
    const vb = attr('viewBox');
    if ((!w || !h) && vb) {
      const v = vb.split(/[\s,]+/).map(Number);
      if (v.length === 4 && v[2] > 0 && v[3] > 0) {
        if (!w && !h) { w = v[2]; h = v[3]; } else if (!w) { w = h * v[2] / v[3]; } else { h = w * v[3] / v[2]; }
      }
    }
    if (!w || !h) return { width: 1080, height: 1080 };
    return { width: Math.round(w), height: Math.round(h) };
  } catch { return null; }
}

/**
 * Build a Media object (status "processing") from a file path. Probes it with ffprobe.
 * → Media (SPEC §2). Throws a Hebrew Error when the file is not usable.
 */
export async function mediaFromFile(absPath, { id, name } = {}) {
  const st = await fsp.stat(absPath).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`הקובץ לא נמצא: ${absPath}`);
  const ext = path.extname(absPath).toLowerCase();
  const base = {
    id, kind: 'video', name: name || path.basename(absPath), path: absPath,
    duration: 0, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: false, channels: 0, sampleRate: 0,
    size: st.size, status: 'processing',
  };
  if (ext === '.svg') {
    const s = await svgSize(absPath);
    if (!s) throw new Error(`קובץ SVG לא תקין: ${path.basename(absPath)}`);
    return { ...base, kind: 'image', width: s.width, height: s.height };
  }
  const info = await probe(absPath);
  const streams = info.streams || [];
  const fmt = info.format || {};
  const vids = streams.filter((s) => s.codec_type === 'video');
  const v = vids.find((s) => !(s.disposition && s.disposition.attached_pic)) || null;
  const a = streams.find((s) => s.codec_type === 'audio') || null;
  const fmtName = String(fmt.format_name || '');
  const fmtDur = num(fmt.duration);
  const duration = Math.max(fmtDur, v ? num(v.duration) : 0, a ? num(a.duration) : 0);

  let kind;
  if (v) {
    const nbFrames = num(v.nb_frames, 0);
    const imageFormat = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|gif_pipe|avif|j2k_pipe|jpegls_pipe|qoi_pipe|svg_pipe)(,|$)/.test(fmtName);
    const isGif = v.codec_name === 'gif';
    if (isGif) kind = (nbFrames > 1 || duration > 0.15) ? 'video' : 'image';
    else if (!a && (imageFormat || (IMAGE_EXT.has(ext) && !(duration > 0.2)))) kind = 'image';
    else kind = 'video';
  } else if (a) {
    kind = 'audio';
  } else {
    throw new Error(`הקובץ אינו וידאו, תמונה או שמע נתמכים: ${path.basename(absPath)}`);
  }

  const m = { ...base, kind };
  if (v) {
    let w = num(v.width), h = num(v.height);
    const rot = rotationOf(v);
    if (rot === 90 || rot === 270) [w, h] = [h, w];
    // non-square pixels: display width
    const sar = String(v.sample_aspect_ratio || '1:1').split(':').map(Number);
    if (kind === 'video' && sar.length === 2 && sar[0] > 0 && sar[1] > 0 && sar[0] !== sar[1]) {
      if (rot === 90 || rot === 270) h = Math.round(h * sar[0] / sar[1]); else w = Math.round(w * sar[0] / sar[1]);
    }
    m.width = w; m.height = h;
  }
  if (kind === 'video') {
    m.hasVideo = true;
    let fps = parseRate(v.avg_frame_rate);
    if (!(fps > 0 && fps < 1000)) fps = parseRate(v.r_frame_rate);
    if (!(fps > 0 && fps < 1000)) fps = 30;
    m.fps = Math.round(fps * 1000) / 1000;
    m.duration = Math.round(duration * 1000) / 1000;
  } else if (kind === 'audio') {
    m.duration = Math.round(duration * 1000) / 1000;
  } else {
    m.duration = 0;
  }
  if (a && kind !== 'image') {
    m.hasAudio = true;
    m.channels = num(a.channels, 2);
    m.sampleRate = num(a.sample_rate, 48000);
  }
  if (kind !== 'image' && !(m.duration > 0)) throw new Error(`לא ניתן לקבוע את אורך הקובץ: ${path.basename(absPath)}`);
  if (fmt.size) m.size = num(fmt.size, st.size);
  return m;
}

// ---------------------------------------------------------------- PCM helpers

/** Decode any audio to mono signed 16-bit PCM at `rate` Hz → Int16Array */
export async function decodePcmMono(p, rate = 16000, { from, duration } = {}) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error'];
  if (from) args.push('-ss', String(from));
  if (duration) args.push('-t', String(duration));
  args.push('-i', p, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-');
  const res = await run(FFMPEG, args).catch((e) => { throw new Error(`פענוח שמע נכשל: ${e.message}`); });
  if (res.code !== 0) throw new Error(`פענוח שמע נכשל: ${tail(res.stderr)}`);
  const b = res.stdout;
  const n = b.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2);
  return out;
}

/** RMS per frame (hop samples) normalised to 0..1 → Float32Array */
export function rmsFrames(pcm, hop) {
  const n = Math.floor(pcm.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i++) { const x = pcm[o + i]; s += x * x; }
    out[f] = Math.sqrt(s / hop) / 32768;
  }
  return out;
}

/**
 * Loudest 50 ms window of a sound file (used by the Chordix importer for peak_at / peak_db):
 * → { t (s, window centre), db (RMS dBFS) }
 */
export async function peakInfo(p) {
  const pcm = await decodePcmMono(p, 8000);
  const r = rmsFrames(pcm, 400);
  if (!r.length) return { t: 0, db: -120 };
  let k = 0;
  for (let i = 1; i < r.length; i++) if (r[i] > r[k]) k = i;
  return { t: k * 0.05 + 0.025, db: 20 * Math.log10(r[k] + 1e-9) };
}

// ---------------------------------------------------------------- derivatives

async function isFresh(p, srcMtime) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return false;
  if (st.isDirectory()) {
    const list = await fsp.readdir(p).catch(() => []);
    return list.some((f) => f.endsWith('.jpg')) && st.mtimeMs + 2000 >= srcMtime;
  }
  return st.size > 0 && st.mtimeMs + 2000 >= srcMtime;
}

async function replaceFile(tmp, dst) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, dst); return; } catch (e) {
      if (i >= 12 || !['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
      if (i === 3) await fsp.rm(dst, { recursive: true, force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

function even(n) { n = Math.max(2, Math.round(n)); return n % 2 ? n - 1 : n; }

/** Proxy size: keep aspect, long side ≤ 1920, even dimensions. */
export function proxySize(w, h) {
  if (!(w > 0 && h > 0)) return null;
  const long = Math.max(w, h);
  const k = long > PROXY_LONG_SIDE ? PROXY_LONG_SIDE / long : 1;
  return { w: even(w * k), h: even(h * k) };
}

async function makeProxy(src, dst, media, onProgress) {
  const tmp = dst.replace(/\.mp4$/i, '.tmp.mp4');
  const sz = proxySize(media.width, media.height);
  // out_range=tv: full-range (yuvj) sources are converted to standard limited range so every proxy decodes the same
  const vf = sz ? `scale=${sz.w}:${sz.h}:flags=bicubic:out_range=tv,setsar=1,format=yuv420p` : "scale='min(1920,iw)':-2:out_range=tv,format=yuv420p";
  const args = ['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
    '-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart'];
  if (media.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  else args.push('-an');
  args.push('-sn', '-dn', '-map_metadata', '-1', tmp);
  try {
    await runFfmpeg(args, { duration: media.duration, onProgress });
    await replaceFile(tmp, dst);
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

async function makeWav(src, dst, media, onProgress) {
  const tmp = dst.replace(/\.wav$/i, '.tmp.wav');
  try {
    await runFfmpeg(['-i', src, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', tmp], { duration: media.duration, onProgress });
    await replaceFile(tmp, dst);
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

/** peaks → {rate:100, peaks:[0..1 max abs per 10 ms, mono]} from `ffmpeg -f s16le -ac 1 -ar 8000 -` */
export async function computePeaks(src, { onProgress, duration = 0 } = {}) {
  const HOP = 80; // 10 ms at 8 kHz
  const peaks = [];
  let carry = null;
  let cur = 0, cnt = 0, total = 0, lastP = -1;
  const handle = (b) => {
    if (carry) { b = Buffer.concat([carry, b]); carry = null; }
    const n = b.length >> 1;
    if (b.length & 1) carry = b.subarray(b.length - 1);
    for (let i = 0; i < n; i++) {
      let x = b.readInt16LE(i * 2);
      if (x < 0) x = -x;
      if (x > cur) cur = x;
      if (++cnt === HOP) { peaks.push(cur); cur = 0; cnt = 0; }
    }
    total += n;
    if (onProgress && duration > 0) {
      const p = Math.min(1, total / 8000 / duration);
      if (p - lastP >= 0.02) { lastP = p; onProgress(p); }
    }
  };
  const res = await run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-i', src, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { collectStdout: false, onStdout: handle }).catch((e) => { throw new Error(`חישוב צורת הגל נכשל: ${e.message}`); });
  if (res.code !== 0) throw new Error(`חישוב צורת הגל נכשל: ${tail(res.stderr)}`);
  if (cnt > 0) peaks.push(cur);
  return { rate: 100, duration: Math.round(total / 8000 * 1000) / 1000, peaks: peaks.map((x) => Math.round(Math.min(1, x / 32768) * 1000) / 1000) };
}

async function makePeaks(src, dst, media, onProgress) {
  const data = await computePeaks(src, { onProgress, duration: media.duration });
  const tmp = dst + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data));
  await replaceFile(tmp, dst);
}

async function makeThumbs(src, dstDir, media, onProgress) {
  const tmpDir = dstDir + '.tmp';
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(tmpDir, { recursive: true });
  try {
    if (media.kind === 'image') {
      const ext = path.extname(src).toLowerCase();
      const args = ['-i', src, '-frames:v', '1', '-vf', `scale=-2:${THUMB_HEIGHT}:flags=bicubic,format=yuvj420p`, '-q:v', '4', path.join(tmpDir, '00001.jpg')];
      if (ext === '.svg') {
        // ffmpeg may not decode SVG: fall back to a neutral placeholder thumbnail
        try { await runFfmpeg(args); } catch {
          await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x1d2a33:s=${THUMB_HEIGHT}x${THUMB_HEIGHT}`, '-frames:v', '1', path.join(tmpDir, '00001.jpg')]);
        }
      } else {
        await runFfmpeg(args);
      }
    } else {
      await runFfmpeg(['-i', src, '-map', '0:v:0', '-an', '-sn', '-vf', `fps=1,scale=-2:${THUMB_HEIGHT}:flags=bilinear,format=yuvj420p`, '-q:v', '5',
        path.join(tmpDir, '%05d.jpg')], { duration: media.duration, onProgress });
    }
    const list = (await fsp.readdir(tmpDir)).filter((f) => f.endsWith('.jpg'));
    if (!list.length) throw new Error('לא נוצרו תמונות ממוזערות');
    await fsp.rm(dstDir, { recursive: true, force: true }).catch(() => {});
    await replaceFile(tmpDir, dstDir);
  } finally { await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}

/** Which derivatives a media needs: subset of ["proxy","audio","peaks","thumbs"] */
export function neededDerivatives(media) {
  const need = [];
  if (media.kind === 'video') need.push('thumbs', 'proxy');
  if (media.kind === 'image') need.push('thumbs');
  if (media.hasAudio && media.kind !== 'image') need.push('audio', 'peaks');
  return need;
}

/** Project-relative output paths (forward slashes). */
export function derivativePaths(media) {
  return {
    proxy: `cache/proxy/${media.id}.mp4`,
    audio: `cache/audio/${media.id}.wav`,
    peaks: `cache/peaks/${media.id}.json`,
    thumbs: `cache/thumbs/${media.id}`,
  };
}

const STAGE_HE = { proxy: 'פרוקסי', audio: 'שמע', peaks: 'צורת גל', thumbs: 'תמונות ממוזערות' };

/**
 * Generate all derivatives of a media item (skips outputs that already exist and are newer than the source).
 * Each derivative is one queued ffmpeg task (max 2 concurrent globally).
 * onProgress({ stage, label, progress (0..1 overall), stageProgress }) is called while working.
 * → Promise<patch> where patch = { status:"ready"|"error", error?, proxy?, audio?, peaks?, thumbs? }
 */
export async function ensureDerivatives(projectDir, media, onProgress) {
  const src = media.path;
  const st = await fsp.stat(src).catch(() => null);
  if (!st) return { status: 'error', error: `קובץ המקור חסר: ${src}` };
  const rel = derivativePaths(media);
  const need = neededDerivatives(media);
  const weights = { proxy: 5, thumbs: 2, audio: 1, peaks: 1 };
  const totalW = need.reduce((s, k) => s + weights[k], 0) || 1;
  const prog = Object.fromEntries(need.map((k) => [k, 0]));
  let lastSent = 0;
  const report = (stage, p, force) => {
    prog[stage] = p;
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastSent < 250) return;
    lastSent = now;
    const overall = need.reduce((s, k) => s + weights[k] * prog[k], 0) / totalW;
    try { onProgress({ stage, label: STAGE_HE[stage], stageProgress: p, progress: Math.round(overall * 1000) / 1000 }); } catch { /* listener errors are not ours */ }
  };
  for (const d of ['proxy', 'audio', 'peaks', 'thumbs']) await fsp.mkdir(path.join(projectDir, 'cache', d), { recursive: true });

  const makers = {
    // audio/peaks first: they are fast and let the waveform/AudioEngine work early
    audio: { prio: 2, fn: (abs, cb) => makeWav(src, abs, media, cb) },
    peaks: { prio: 2, fn: (abs, cb) => makePeaks(src, abs, media, cb) },
    thumbs: { prio: 3, fn: (abs, cb) => makeThumbs(src, abs, media, cb) },
    proxy: { prio: 4, fn: (abs, cb) => makeProxy(src, abs, media, cb) },
  };
  const patch = {};
  const errors = [];
  await Promise.all(need.map(async (k) => {
    const abs = path.join(projectDir, rel[k]);
    if (await isFresh(abs, st.mtimeMs)) { patch[k] = rel[k]; report(k, 1); return; }
    try {
      await enqueue(() => makers[k].fn(abs, (p) => report(k, p)), makers[k].prio);
      patch[k] = rel[k];
      report(k, 1, true);
    } catch (e) {
      errors.push(`${STAGE_HE[k]}: ${e.message}`);
    }
  }));
  if (errors.length) {
    patch.status = 'error';
    patch.error = errors.join(' | ');
  } else {
    patch.status = 'ready';
  }
  return patch;
}

/** Count of thumbnail jpgs in a thumbs dir (cached by caller). */
export async function countThumbs(dir) {
  const list = await fsp.readdir(dir).catch(() => []);
  return list.filter((f) => /^\d{5}\.jpg$/.test(f)).length;
}

// ---------------------------------------------------------------- HTTP file serving (Range)

/**
 * Serve a file with Range (206), HEAD, ETag/304, correct MIME.
 * opts: { contentType, cacheControl="no-cache", headers }
 * → Promise<boolean> (false when the file does not exist — caller decides the 404)
 */
export async function serveFile(req, res, absPath, opts = {}) {
  let st;
  try { st = await fsp.stat(absPath); } catch { st = null; }
  if (!st || !st.isFile()) {
    if (opts.notFound === false) return false;
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: `הקובץ לא נמצא: ${path.basename(absPath)}` }));
    }
    return false;
  }
  const size = st.size;
  const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': opts.contentType || mimeFor(absPath),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': opts.cacheControl || 'no-cache',
    ...(opts.headers || {}),
  };
  const range = req.headers.range;
  let start = 0, end = size - 1, status = 200;
  const ifRange = req.headers['if-range'];
  const rangeOk = range && (!ifRange || ifRange === etag || ifRange === headers['Last-Modified']);
  if (rangeOk) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        const suffix = Number(m[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (start >= size || start > end || size === 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'טווח הבתים המבוקש אינו תקין' }));
        return true;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  } else if (!range) {
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(/\s*,\s*/).includes(etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'], 'Accept-Ranges': 'bytes' });
      res.end();
      return true;
    }
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return true; }
  await new Promise((resolve) => {
    const rs = fs.createReadStream(absPath, { start, end });
    pipeline(rs, res, () => resolve());
  });
  return true;
}
