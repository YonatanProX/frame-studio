// Frame Studio — optional local transcription (faster-whisper in a Python you configure as "asr.python" in
// config.json) + energy snapping of word starts. Not configured → the feature is reported as disabled with a hint.
// Some Windows Pythons break on absolute Hebrew paths, so it always runs with cwd = the audio folder and relative names.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, decodePcmMono, rmsFrames, runFfmpeg } from './media.mjs';
import { asrConfig, ffmpegDir } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASR_SCRIPT = path.join(ROOT, 'tools', 'asr.py');
/** The configured python (config.json "asr.python" or env FRAME_STUDIO_ASR_PYTHON), or null when not configured. */
export function pythonPath() { return asrConfig().python; }
export const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'];

// one transcription at a time (CPU heavy)
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function modelCached(model) {
  const hub = process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
  return fs.existsSync(path.join(hub, `models--Systran--faster-whisper-${model}`));
}

/** Is the local ASR usable? → { ok, configured, python, script, models:[cached model names], defaultModel, error?, hint? } */
export function asrStatus() {
  const cfg = asrConfig();
  const PYTHON = cfg.python;
  const okPy = !!PYTHON && fs.existsSync(PYTHON);
  const okScript = fs.existsSync(ASR_SCRIPT);
  const cached = MODELS.filter(modelCached);
  const error = !cfg.configured ? cfg.hint
    : !okPy ? `פייתון לתמלול לא נמצא: ${PYTHON} · Transcription python not found (check "asr.python" in config.json)`
      : !okScript ? `סקריפט התמלול חסר: ${ASR_SCRIPT}` : undefined;
  return {
    ok: okPy && okScript, configured: cfg.configured,
    python: PYTHON, script: ASR_SCRIPT, models: cached, defaultModel: cfg.model,
    error, hint: !cfg.configured || !okPy ? cfg.hint : undefined,
  };
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Move each word start to the first rise of RMS above `rel` (10%) of the local max within ±win (0.3 s).
 * rms: Float32Array of 10 ms frames (0..1). words: [{w,s,e}] (seconds, media time). Returns new array + count moved.
 *  - start inside silence → moves forward to where the voice actually begins;
 *  - start already loud → moves back to the onset, but never across the previous word.
 */
export function snapWordStarts(words, rms, { win = 0.3, rel = 0.1, floorDb = -50, fps = 100 } = {}) {
  const out = words.map((w) => ({ ...w }));
  const floor = 10 ** (floorDb / 20);
  let moved = 0;
  const N = rms.length;
  if (!N) return { words: out, moved };
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const s0 = w.s;
    const prev = i > 0 ? out[i - 1] : null;
    let lo = s0 - win;
    if (prev) lo = Math.max(lo, prev.s + 0.05, Math.min(prev.e, s0) - 0.02);
    lo = Math.max(0, lo);
    let hi = s0 + win;
    if (w.e > s0) hi = Math.min(hi, w.e - 0.03);
    const a = Math.max(0, Math.floor(lo * fps));
    const b = Math.min(N - 1, Math.ceil(hi * fps));
    const k0 = Math.min(N - 1, Math.max(0, Math.round(s0 * fps)));
    if (b <= a) continue;
    // local max within ±win around the ASR start
    let mx = 0;
    const ma = Math.max(0, Math.floor((s0 - win) * fps)), mb = Math.min(N - 1, Math.ceil((s0 + win) * fps));
    for (let k = ma; k <= mb; k++) if (rms[k] > mx) mx = rms[k];
    if (mx < floor) continue;
    const thr = rel * mx;
    let found = -1;
    if (rms[k0] < thr) {
      for (let k = Math.max(k0, a); k <= b; k++) { if (rms[k] >= thr) { found = k; break; } }
    } else {
      for (let k = k0; k > a; k--) { if (rms[k - 1] < thr) { found = k; break; } }
    }
    if (found < 0) continue;
    const ns = r3(found / fps);
    if (Math.abs(ns - s0) < 0.005) continue;
    w.s = ns;
    if (w.e < w.s + 0.05) w.e = r3(w.s + 0.05);
    if (prev && prev.e > w.s) prev.e = r3(Math.max(prev.s + 0.03, w.s));
    moved++;
  }
  return { words: out, moved };
}

/**
 * Transcribe a WAV/any audio file in an ASCII-safe folder.
 * opts: { model="small", language="he", snap=true, onProgress({stage,label,progress}), log }
 * → { words:[{w,s,e}], raw:[[w,s,e]], moved, model, duration }
 */
export function transcribeFile(audioPath, opts = {}) {
  return serial(() => transcribeNow(audioPath, opts));
}

async function transcribeNow(audioPath, { model, language, snap = true, onProgress, log = () => {} } = {}) {
  const st = asrStatus();
  if (!st.ok) throw new Error(st.error);
  const PYTHON = st.python;
  const cfg = asrConfig();
  model = model || cfg.model;
  language = language || cfg.language;
  if (!MODELS.includes(model) && !/^[\w.-]+$/.test(model)) throw new Error(`מודל תמלול לא מוכר: ${model}`);
  const abs = path.resolve(audioPath);
  if (!fs.existsSync(abs)) throw new Error(`קובץ השמע לתמלול לא נמצא: ${abs}`);

  // the python wants relative ASCII names in its cwd; when the folder/name is not plain ASCII, convert to a temp wav first
  let workDir = path.dirname(abs), inName = path.basename(abs), tmpWav = null;
  if (!/^[\x20-\x7e]+$/.test(abs)) {
    workDir = path.join(os.tmpdir(), 'frame-studio-asr');
    await fsp.mkdir(workDir, { recursive: true });
    inName = `in-${crypto.randomBytes(4).toString('hex')}.wav`;
    tmpWav = path.join(workDir, inName);
    await runFfmpeg(['-i', abs, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmpWav]);
  }
  const outName = `asr-${crypto.randomBytes(5).toString('hex')}.json`;
  const outAbs = path.join(workDir, outName);
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  // tools/asr.py calls `ffmpeg` itself: make a configured (non-PATH) ffmpeg visible to it
  const ffDir = ffmpegDir();
  if (ffDir) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = ffDir + path.delimiter + (env[key] || '');
  }
  if (modelCached(model)) { env.HF_HUB_OFFLINE = '1'; env.TRANSFORMERS_OFFLINE = '1'; }
  const report = (o) => { try { onProgress && onProgress(o); } catch { /* ignore */ } };
  const STAGES = { load: 'טוען מודל', decode: 'מפענח שמע', transcribe: 'מתמלל' };
  let duration = 0, pyError = '', buf = '';
  report({ stage: 'load', label: STAGES.load, progress: 0.02 });
  log(`ASR: ${PYTHON} ${ASR_SCRIPT} ${inName} (cwd ${workDir}, model ${model})`);
  try {
    const res = await run(PYTHON, ['-u', ASR_SCRIPT, inName, outName, model, language], {
      cwd: workDir, env, collectStdout: false, maxStderr: 8000,
      onStdout: (b) => {
        buf += b.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.error) pyError = o.error;
          if (o.stage) {
            if (o.duration) duration = o.duration;
            report({ stage: o.stage, label: STAGES[o.stage] || o.stage, progress: o.stage === 'transcribe' ? 0.12 : o.stage === 'decode' ? 0.08 : 0.03 });
          }
          if (o.progress != null) report({ stage: 'transcribe', label: STAGES.transcribe, progress: 0.12 + 0.8 * o.progress });
        }
      },
    }).catch((e) => { throw new Error(e.code === 'ENOENT' ? `פייתון לתמלול לא נמצא: ${PYTHON}` : `הפעלת התמלול נכשלה: ${e.message}`); });
    if (res.code !== 0) {
      let msg = pyError || res.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      if (/No module named 'faster_whisper'/.test(msg)) msg = 'faster-whisper אינו מותקן בסביבת הפייתון של התמלול';
      throw new Error(`התמלול נכשל: ${msg}`);
    }
    const raw = JSON.parse(await fsp.readFile(outAbs, 'utf8'));
    let words = raw.filter((x) => Array.isArray(x) && x.length >= 3 && String(x[0]).trim())
      .map(([w, s, e]) => ({ w: String(w).trim(), s: Number(s), e: Number(e) }));
    let moved = 0;
    if (snap && words.length) {
      report({ stage: 'snap', label: 'מיישר לפי עוצמת הקול', progress: 0.94 });
      const pcm = await decodePcmMono(tmpWav || abs, 16000);
      const r = snapWordStarts(words, rmsFrames(pcm, 160));
      words = r.words; moved = r.moved;
      if (!duration) duration = pcm.length / 16000;
    }
    report({ stage: 'done', label: 'הסתיים', progress: 1 });
    return { words, raw, moved, model, duration };
  } finally {
    await fsp.rm(outAbs, { force: true }).catch(() => {});
    if (tmpWav) await fsp.rm(tmpWav, { force: true }).catch(() => {});
  }
}
