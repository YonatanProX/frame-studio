// Frame Studio — machine-specific configuration (server side only).
//
// Everything that depends on the local machine lives in ROOT/config.json (gitignored). The committed
// ROOT/config.example.json documents every key. A missing config.json is fine: every value has a sensible
// default for Windows, macOS and Linux (browser auto-detection, ffmpeg/ffprobe from PATH, optional features off).
//
// Precedence for every value: environment variable  >  config.json  >  built-in default.
//   FRAME_STUDIO_CONFIG        alternative config file path
//   FRAME_STUDIO_CHROME        browser executable
//   FRAME_STUDIO_FFMPEG / FRAME_STUDIO_FFPROBE
//   FRAME_STUDIO_ASR_PYTHON    python with faster-whisper
//   CHORDIX_SFX                extra folder for Chordix workshop sound effects
//
// The file is re-read automatically when its modification time changes, so most edits apply without a restart
// (the ffmpeg path is read once by media.mjs / export.mjs at start-up).
//
// Relative paths inside config.json are resolved against ROOT.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = process.env.FRAME_STUDIO_CONFIG ? path.resolve(process.env.FRAME_STUDIO_CONFIG) : path.join(ROOT, 'config.json');
export const EXAMPLE_FILE = path.join(ROOT, 'config.example.json');
const LEGACY_SOURCES = path.join(ROOT, 'library', 'sources.json');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const DEFAULTS = Object.freeze({
  chrome: null,                       // null = auto-detect Google Chrome (then Chromium)
  ffmpeg: 'ffmpeg',                   // from PATH
  ffprobe: 'ffprobe',
  asr: { python: null, model: 'small', language: 'he' },   // python = null → local transcription disabled
  library: { music: null },           // extra folders indexed as music/voice ("שלי"); null = none (or legacy library/sources.json)
  chordix: { workshop: null, sfx: null },                  // optional Chordix workshop integration
  render: { angle: null },            // null = per OS (d3d11 on Windows, metal on macOS, default elsewhere)
});

let cache = { mtimeMs: -1, size: -1, data: null, error: null, exists: false };

function readJsonFile(file) {
  const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(txt);
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  const out = { ...base };
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue;                       // "_comment" keys
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Resolve a configured path: "~" → home, relative → ROOT. Returns null for empty values. */
export function resolvePath(p) {
  const s = str(p);
  if (!s) return null;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(1));
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(ROOT, s);
}

/** The merged configuration (re-read when config.json changes). Never throws. */
export function getConfig() {
  let st = null;
  try { st = fs.statSync(CONFIG_FILE); } catch { /* no config.json */ }
  const mtimeMs = st ? st.mtimeMs : 0, size = st ? st.size : 0;
  if (cache.data && cache.mtimeMs === mtimeMs && cache.size === size) return cache.data;
  let user = {}, error = null;
  if (st) {
    try { user = readJsonFile(CONFIG_FILE); }
    catch (e) { error = `config.json אינו JSON תקין — משתמשים בברירות המחדל · config.json is not valid JSON, using defaults (${e.message})`; }
  }
  cache = { mtimeMs, size, data: merge(DEFAULTS, user), error, exists: !!st };
  return cache.data;
}

/** Status for diagnostics: where the config comes from and whether it parsed. */
export function configStatus() {
  getConfig();
  return { file: CONFIG_FILE, exists: cache.exists, error: cache.error || undefined, example: EXAMPLE_FILE };
}

// ───────────────────────────── executables ─────────────────────────────

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** First match of an executable name on PATH (handles PATHEXT on Windows). */
export function which(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) return isFile(name) ? name : null;
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of IS_WIN && !path.extname(name) ? exts : ['']) {
      const f = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      if (isFile(f)) return f;
    }
  }
  return null;
}

function browserCandidates({ allowEdge = false } = {}) {
  const home = os.homedir();
  const c = [];
  if (IS_WIN) {
    const roots = [process.env.ProgramFiles || 'C:/Program Files', process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
      process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')];
    for (const r of roots) c.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const r of roots) c.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    if (allowEdge) for (const r of roots) c.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (IS_MAC) {
    for (const base of ['/Applications', path.join(home, 'Applications')]) {
      c.push(path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      c.push(path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      if (allowEdge) c.push(path.join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
    }
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', ...(allowEdge ? ['microsoft-edge', 'microsoft-edge-stable'] : [])]) {
      const f = which(n);
      if (f) c.push(f);
    }
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium');
  }
  return c;
}

/**
 * Google Chrome (or Chromium) executable, or null.
 * env FRAME_STUDIO_CHROME → config "chrome" → per-OS auto-detection. allowEdge adds Microsoft Edge as a last resort
 * (fine for opening the editor window; exports are tested with Chrome).
 */
export function findChrome({ allowEdge = false } = {}) {
  const cfg = getConfig();
  const explicit = [process.env.FRAME_STUDIO_CHROME, resolvePath(cfg.chrome)].filter(Boolean);
  for (const f of explicit) if (isFile(f)) return f;
  for (const f of browserCandidates({ allowEdge })) if (isFile(f)) return f;
  return null;
}

/** Command that opens a URL in the default browser (fallback when Chrome is missing). */
export function openUrlCommand(url) {
  if (IS_WIN) return ['explorer.exe', url];
  if (IS_MAC) return ['open', url];
  return ['xdg-open', url];
}

/** ANGLE backend for headless Chrome (export / snapshots). */
export function angleBackend() {
  const a = str(getConfig().render && getConfig().render.angle);
  if (a) return a;
  return IS_WIN ? 'd3d11' : IS_MAC ? 'metal' : 'default';
}

/**
 * ffmpeg executable (name on PATH or absolute path).
 * env FRAME_STUDIO_FFMPEG → config "ffmpeg" → when that is not usable (a bare name that is not on PATH, or an absolute
 * path that no longer exists, e.g. after `winget upgrade` renamed the versioned folder) → the usual install folders.
 */
export function ffmpegPath() {
  if (process.env.FRAME_STUDIO_FFMPEG) return process.env.FRAME_STUDIO_FFMPEG;
  return usableExe(getConfig().ffmpeg, 'ffmpeg');
}
/** ffprobe executable. If only ffmpeg was configured as a path, ffprobe next to it is used. */
export function ffprobePath() {
  if (process.env.FRAME_STUDIO_FFPROBE) return process.env.FRAME_STUDIO_FFPROBE;
  const cfg = getConfig();
  const p = resolveExe(cfg.ffprobe);
  const custom = p && p !== 'ffprobe';
  if (custom && (!path.isAbsolute(p) || isFile(p))) return p;
  const ff = ffmpegPath();
  if (path.isAbsolute(ff)) {
    const sib = path.join(path.dirname(ff), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
    if (isFile(sib)) return sib;
  }
  return usableExe(custom ? p : 'ffprobe', 'ffprobe');
}
function resolveExe(v) {
  const s = str(v);
  if (!s) return null;
  return /[\\/]/.test(s) ? resolvePath(s) : s;      // bare names stay bare (PATH lookup by spawn)
}

const exeCache = new Map();
/** The configured executable if it can be found, else the same program from a well-known install folder, else as configured. */
function usableExe(v, name) {
  const r = resolveExe(v) || name;
  const key = `${name}|${r}|${process.env.PATH || ''}`;
  if (exeCache.has(key)) return exeCache.get(key);
  let out = r;
  if (path.isAbsolute(r) ? !isFile(r) : !which(r)) out = knownExe(path.isAbsolute(r) ? name : r) || r;
  exeCache.set(key, out);
  return out;
}

/** Newest "<dir>/<match>[/<one level>]/<sub>/<file>" (the winget package folders carry a version in their name). */
function newestIn(dir, test, sub, file) {
  let best = null, bestT = -1, entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || !test(e.name)) continue;
    const base = path.join(dir, e.name);
    let inner = [];
    try { inner = fs.readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(base, x.name)); } catch { /* unreadable */ }
    for (const d of [base, ...inner]) {
      const f = path.join(d, sub, file);
      if (!isFile(f)) continue;
      const t = fs.statSync(f).mtimeMs;
      if (t > bestT) { best = f; bestT = t; }
    }
  }
  return best;
}

/**
 * An executable (ffmpeg / ffprobe) in the folders installers put it, for when PATH does not have it — a PATH change
 * made by an installer only reaches programs started after it. Windows: winget links, the winget FFmpeg package
 * folders (Gyan.FFmpeg, BtbN…), Chocolatey, Scoop, C:\ffmpeg\bin. macOS: Homebrew. Linux: /usr/local/bin, /snap/bin.
 * → absolute path or null.
 */
export function knownExe(name) {
  const home = os.homedir();
  if (IS_WIN) {
    const exe = path.extname(name) ? name : name + '.exe';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:/Program Files';
    const direct = [
      path.join(local, 'Microsoft', 'WinGet', 'Links', exe), path.join(pf, 'WinGet', 'Links', exe),
      path.join(process.env.ProgramData || 'C:/ProgramData', 'chocolatey', 'bin', exe),
      path.join(home, 'scoop', 'shims', exe),
      path.join('C:/ffmpeg', 'bin', exe), path.join(pf, 'ffmpeg', 'bin', exe),
    ];
    for (const f of direct) if (isFile(f)) return path.normalize(f);
    for (const pkgs of [path.join(local, 'Microsoft', 'WinGet', 'Packages'), path.join(pf, 'WinGet', 'Packages')]) {
      const f = newestIn(pkgs, (n) => /ffmpeg/i.test(n), 'bin', exe);
      if (f) return f;
    }
    return null;
  }
  for (const d of IS_MAC ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/usr/local/bin', '/usr/bin', '/snap/bin']) {
    const f = path.join(d, name);
    if (isFile(f)) return f;
  }
  return null;
}

/** Directory to prepend to PATH for child processes that call ffmpeg themselves (tools/asr.py), or null. */
export function ffmpegDir() {
  const f = ffmpegPath();
  return path.isAbsolute(f) ? path.dirname(f) : null;
}

// ───────────────────────────── local transcription (optional) ─────────────────────────────

export const ASR_HINT_HE = 'התמלול המקומי כבוי: לא הוגדר פייתון עם faster-whisper. התקינו (pip install faster-whisper) והגדירו את "asr.python" בקובץ config.json (דוגמה ב-config.example.json).';
export const ASR_HINT_EN = 'Local transcription is off: no Python with faster-whisper is configured. Install it (pip install faster-whisper) and set "asr.python" in config.json (see config.example.json).';

/** → { configured, python, model, language, hint } — python is null when the feature is not configured. */
export function asrConfig() {
  const cfg = getConfig();
  const a = cfg.asr || {};
  const python = str(process.env.FRAME_STUDIO_ASR_PYTHON) ? path.resolve(process.env.FRAME_STUDIO_ASR_PYTHON) : resolvePath(a.python);
  return {
    configured: !!python, python,
    model: str(a.model) || 'small', language: str(a.language) || 'he',
    hint: `${ASR_HINT_HE} · ${ASR_HINT_EN}`,
  };
}

// ───────────────────────────── sound library sources ─────────────────────────────

/**
 * Extra library folders. config.json `library.music` wins; otherwise the legacy library/sources.json
 * (`{"music":[…]}`) is still honoured. → { music:[absolute dirs], from:"config"|"legacy"|"none" }
 */
export function librarySources({ legacyFile = LEGACY_SOURCES } = {}) {
  const cfg = getConfig();
  const lib = cfg.library || {};
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map(resolvePath).filter(Boolean);
  if (lib.music != null) return { music: list(lib.music), from: 'config' };
  try {
    const j = readJsonFile(legacyFile);
    return { music: list(j.music), from: 'legacy' };
  } catch { return { music: [], from: 'none' }; }
}

// ───────────────────────────── Chordix workshop (optional) ─────────────────────────────

/** → { workshop: abs dir|null, sfx: [abs dirs] } (sfx = extra folders searched for workshop sound effects). */
export function chordixConfig() {
  const c = getConfig().chordix || {};
  const sfx = [process.env.CHORDIX_SFX, ...(Array.isArray(c.sfx) ? c.sfx : [c.sfx])].map(resolvePath).filter(Boolean);
  return { workshop: resolvePath(c.workshop), sfx };
}

/** Public, path-free summary (safe to show in the UI / health). */
export function featureSummary() {
  const a = asrConfig();
  return {
    config: cache.exists, chrome: !!findChrome({ allowEdge: true }), asrConfigured: a.configured,
    musicSources: librarySources().music.length, chordixWorkshop: !!chordixConfig().workshop,
  };
}
