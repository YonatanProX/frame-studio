#!/usr/bin/env node
// mcp/server.mjs — Frame Studio as an MCP server, so you can ask Claude (Claude Desktop chat or Claude Code) to edit
// videos. Zero dependencies: newline-delimited JSON-RPC 2.0 over stdio. Every tool talks to the local Frame Studio
// HTTP server (http://127.0.0.1:7788; FRAME_STUDIO_PORT / CUTX_URL override) and starts it in the background when
// it is not running.
//
//   node <Frame Studio>/mcp/server.mjs          (started by Claude; see docs/MCP.md)
//
// stdout carries protocol messages only. Every log line goes to stderr.

for (const k of ['log', 'info', 'debug']) console[k] = (...a) => console.error(...a); // nothing may print to stdout

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const cutx = await imp('cli/cutx.mjs');
const guide = await imp('mcp/guide.mjs');
const { OPS_HELP, summarizeOps, normalizeWord, resolveTime } = await imp('shared/ops.js');
const { projectDuration } = await imp('shared/model.js');
const cfg = await imp('server/config.mjs').catch(() => ({}));

let VERSION = '1.0.0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || VERSION; } catch { /* default */ }

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PORT = Number(process.env.FRAME_STUDIO_PORT) || 7788;
const BASE = String(process.env.FRAME_STUDIO_PORT ? `http://127.0.0.1:${PORT}` : process.env.CUTX_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const BASE_URL = new URL(BASE);
const LOCAL = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(BASE_URL.hostname);
const MAX_TEXT = 60000; // chars per text block (Claude Code warns above ~25k tokens)
const MAX_IMAGES = 6;
const IMAGE_BOX = 1000; // longest side of a returned frame, px

const log = (...a) => { try { process.stderr.write(`[frame-studio-mcp] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`); } catch { /* closed */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (x) => (Number.isFinite(+x) && x !== null ? (+x).toFixed(2) : String(x));
const enc = encodeURIComponent;
const dataDir = () => { try { return typeof cfg.dataDir === 'function' ? cfg.dataDir() : ROOT; } catch { return ROOT; } };

/** A tool failure the model should see (isError result), Hebrew + English. */
class ToolError extends Error {
  constructor(he, en) { super(en ? `${he}\n${en}` : he); this.name = 'ToolError'; }
}

// ───────────────────────────── Frame Studio HTTP client ─────────────────────────────

async function request(method, p, body, { timeout = 120000, signal } = {}) {
  const init = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) { init.headers['content-type'] = 'application/json; charset=utf-8'; init.body = JSON.stringify(body); }
  const signals = [timeout ? AbortSignal.timeout(timeout) : null, signal].filter(Boolean);
  if (signals.length) init.signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  let res;
  try { res = await fetch(BASE + p, init); } catch (e) {
    if (signal && signal.aborted) throw new ToolError('הפעולה בוטלה', 'Cancelled');
    const code = (e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timeout' : e && e.message);
    throw new ToolError(`אין חיבור לשרת Frame Studio ב-${BASE} (${code})`, `Cannot reach the Frame Studio server at ${BASE} (${code}). Call frame_studio_status to start it.`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && data.error ? String(data.error) : `${res.status} ${res.statusText}`;
    let route = p.split('?')[0];
    try { route = decodeURIComponent(route); } catch { /* keep */ }
    const e = new ToolError(`השרת החזיר שגיאה (${res.status}): ${msg}`, `Frame Studio server error ${res.status} on ${method} ${route}: ${serverErrorEn(msg)}`);
    e.status = res.status; e.data = data; e.serverMessage = msg;
    throw e;
  }
  return data;
}

// The Frame Studio server answers in Hebrew. English for the messages the tools can run into (Claude reads both).
const HEB = /[֐-׿]/;
const SERVER_MESSAGES = [
  [/^הקובץ לא נמצא: (.+)$/s, (m) => `File not found: ${m[1]}`],
  [/^הקובץ אינו וידאו, תמונה או שמע נתמכים: (.+)$/s, (m) => `Not a supported video, image or audio file: ${m[1]} (ffprobe cannot read it)`],
  [/^לא ניתן לקרוא את הקובץ \(ffprobe\): (.+)$/s, (m) => `Not a supported video, image or audio file (ffprobe cannot read it): ${m[1]}`],
  [/^לא ניתן לקבוע את אורך הקובץ: (.+)$/s, (m) => `Cannot tell how long this file is (damaged or not a media file): ${m[1]}`],
  [/^(ffmpeg|ffprobe) לא נמצא ב-PATH$/, (m) => `${m[1]} was not found on this computer. Run install.cmd again (it installs ffmpeg)`],
  [/^הפעלת (ffmpeg|ffprobe) נכשלה: (.+)$/s, (m) => `Starting ${m[1]} failed: ${m[2]}`],
  [/^(ffmpeg) נכשל \(קוד (-?\d+)\): (.*)$/s, (m) => `ffmpeg failed (code ${m[2]}): ${m[3]}`],
  [/^פענוח שמע נכשל: (.*)$/s, (m) => `Decoding the audio failed: ${m[1]}`],
  [/^חישוב צורת הגל נכשל: (.*)$/s, (m) => `Computing the waveform failed: ${m[1]}`],
  [/^קובץ SVG לא תקין: (.+)$/s, (m) => `Invalid SVG file: ${m[1]}`],
  [/^הפרויקט "(.+)" לא נמצא$/s, (m) => `Project "${m[1]}" not found (list_projects shows the ids)`],
  [/^המדיה "(.+)" לא נמצאה בפרויקט$/s, (m) => `Media "${m[1]}" is not in this project (get_project lists the media ids)`],
  [/^המשימה לא נמצאה$/, () => 'No job with this id. Jobs are kept only while the Frame Studio server runs: if it restarted, start the export / snapshot again'],
  [/^אין פעולה לביטול$/, () => 'Nothing to undo'],
  [/^אין פעולה לביצוע מחדש$/, () => 'Nothing to redo'],
  [/^כבר קיים פרויקט עם המזהה "(.+)"$/s, (m) => `A project with the id "${m[1]}" already exists`],
  [/^המדיה בשימוש ב-(\d+) קליפים/, (m) => `The media is used by ${m[1]} clip(s) on the timeline: remove those clips first`],
  [/^צורת הגל עדיין בהכנה$/, () => 'The waveform is still being prepared: try again in a few seconds'],
  [/^לקובץ הזה אין שמע$/, () => 'This file has no audio'],
  [/^לקובץ "(.+)" אין ערוץ שמע$/s, (m) => `"${m[1]}" has no audio stream`],
  [/^התמונות הממוזערות עדיין בהכנה$/, () => 'Thumbnails are still being prepared'],
  [/^אין תמונות ממוזערות$/, () => 'No thumbnails'],
  [/^נתיב API לא קיים: (.+)$/s, (m) => `Unknown API route ${m[1]}: the running Frame Studio server is probably an older version. Close Frame Studio and start it again`],
  [/^(הנתיב|הקובץ) לא נמצא/, () => 'Not found'],
  [/^מזהה פרויקט לא תקין/, () => 'Invalid project id (lowercase a-z, 0-9 and "-")'],
  [/^לא נבחרו קבצים לייבוא$/, () => 'No files to import'],
  [/^נתיב קובץ ריק$/, () => 'Empty file path'],
  [/^ייבוא הקובץ נכשל$|^הייבוא נכשל$/, () => 'The import failed'],
  [/^יש לשלוח מערך פעולות/, () => 'Send an array of operations (ops)'],
  [/^רשימת הפעולות אינה JSON תקין$/, () => 'The ops list is not valid JSON'],
  [/^יש לציין שם לפרויקט$/, () => 'A project name is required'],
  [/^יש לציין mediaId או path לתמלול$/, () => 'Give a media id or a file path to transcribe'],
  [/^(רוחב|גובה) לא תקין/, (m) => `Invalid ${m[1] === 'רוחב' ? 'width' : 'height'} (16–8192)`],
  [/^קצב פריימים לא תקין$/, () => 'Invalid frame rate'],
  [/^פרויקט לא תקין$/, () => 'Invalid project'],
  [/^גוף הבקשה אינו JSON תקין$/, () => 'The request body is not valid JSON'],
  [/^גוף הבקשה גדול מדי$/, () => 'The request is too large'],
  [/^גישה נדחתה$/, () => 'Access denied'],
  [/^כתובת לא תקינה$/, () => 'Invalid address'],
  [/^שמירת הפרויקט נכשלה: (.+)$/s, (m) => `Saving the project failed: ${m[1]}`],
  [/^קובץ הפרויקט פגום \((.+?)\): (.+)$/s, (m) => `The project file is damaged (${m[1]}): ${m[2]}`],
  [/^שגיאה במנוע הפעולות: (.+)$/s, (m) => `Error in the ops engine: ${m[1]}`],
  [/^לא ניתן להעביר את הפרויקט לסל/, () => 'The project cannot be moved to the trash right now: files are in use. Try again in a moment'],
];

/** English for a (Hebrew) server error message. Several messages joined with " | " are translated one by one. */
function serverErrorEn(msg) {
  const s = String(msg ?? '').trim();
  if (!s) return 'no details';
  if (!HEB.test(s)) return s; // already English
  if (s.includes(' · ')) { const en = s.split(' · ').filter((x) => !HEB.test(x)); if (en.length) return en.join(' · '); } // "עברית · English"
  return s.split(' | ').map((part) => {
    const t = part.trim();
    for (const [re, fn] of SERVER_MESSAGES) { const m = re.exec(t); if (m) return fn(m); }
    return '(no English text for this message: read the Hebrew line above)';
  }).join(' | ');
}
const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
};

/** → {state:'up', h} | {state:'other'} | {state:'down'} */
async function probe() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(2000) });
    const h = await r.json().catch(() => null);
    return h && h.app === 'frame-studio' ? { state: 'up', h } : { state: 'other' };
  } catch { return { state: 'down' }; }
}

let starting = null;
let startedByUs = false;
/** Make sure the server answers; start server/main.mjs (detached) when it does not. → health object */
async function ensureServer() {
  const p0 = await probe();
  if (p0.state === 'up') return p0.h;
  if (p0.state === 'other') {
    throw new ToolError(`הכתובת ${BASE} תפוסה על ידי תוכנה אחרת (לא Frame Studio).`,
      `${BASE} is used by another program, not Frame Studio. Close it, or set FRAME_STUDIO_PORT to a free port in the MCP config.`);
  }
  if (!LOCAL || process.env.FRAME_STUDIO_NO_AUTOSTART === '1') {
    throw new ToolError(`השרת של Frame Studio לא פעיל ב-${BASE}.`, `The Frame Studio server is not running at ${BASE}. Start Frame Studio (desktop shortcut) and try again.`);
  }
  if (!starting) starting = startServer().finally(() => { starting = null; });
  return starting;
}

async function startServer() {
  const main = path.join(ROOT, 'server', 'main.mjs');
  if (!fs.existsSync(main)) throw new ToolError(`לא נמצא ${main}`, `Missing ${main}: the Frame Studio folder is incomplete. Run install.cmd again.`);
  log(`starting ${main} on port ${BASE_URL.port || PORT}`);
  const child = spawn(process.execPath, [main, '--port', String(BASE_URL.port || PORT)], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  let exited = null;
  child.on('error', (e) => { exited = e.message; });
  child.on('exit', (code) => { exited = exited || `exit code ${code}`; });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(300);
    const p = await probe();
    if (p.state === 'up') { startedByUs = true; return p.h; }
    if (exited && p.state === 'down') break;
  }
  const logFile = path.join(ROOT, 'server.log');
  throw new ToolError(`השרת של Frame Studio לא עלה (${exited || 'timeout'}). פרטים: ${logFile}`,
    `The Frame Studio server did not start (${exited || 'no answer within 30 s'}). See ${logFile}. Is Node.js 24+ installed?`);
}

// ───────────────────────────── jobs (export, snapshot, audio check, transcription) ─────────────────────────────

/**
 * Poll a job until it finishes or the call's time budget runs out.
 * → {done:true, job} | {done:false, job}; throws ToolError when the job failed.
 */
async function waitJob(job0, C, label) {
  let job = job0 && job0.job && typeof job0.job === 'object' ? job0.job : job0;
  const id = job && (job.id || job.jobId);
  if (!id) return { done: true, job };
  const type = job.type;
  try {
    for (;;) {
      const st = cutx.jobState(job);
      if (st === 'done') { C.progress(100, `${label}: done`); return { done: true, job }; }
      if (st === 'failed') throw new ToolError(`${label} נכשל: ${job.error || job.message || 'שגיאה לא ידועה'}`, `${label} failed (job ${id}): ${serverErrorEn(job.error || job.message || 'unknown error')}`);
      const p = Number(job.progress);
      if (Number.isFinite(p)) C.progress(Math.min(99, Math.round(p * 100)), `${label} ${Math.round(p * 100)}%`);
      if (C.left() < 800) return { done: false, job };
      await sleep(Math.min(700, Math.max(100, C.left() - 500)));
      if (C.signal.aborted) throw new ToolError('הפעולה בוטלה', 'Cancelled');
      job = await api.get(`/api/jobs/${enc(id)}`, { timeout: 20000, signal: C.signal });
    }
  } catch (e) {
    // the user stopped the tool call → stop the render too (a transcription cannot be interrupted; it just finishes)
    if (C.signal.aborted && type !== 'transcribe') api.post(`/api/jobs/${enc(id)}/cancel`, {}, { timeout: 5000 }).catch(() => {});
    throw e;
  }
}

function stillRunning(job, label) {
  const p = Number(job.progress);
  return `⏳ ${label} עדיין רץ${Number.isFinite(p) ? ` (${Math.round(p * 100)}%)` : ''} · ${label} is still running.\n` +
    `Call wait_job with job_id "${job.id}" to keep waiting (it returns the result when done). Tell the user it is in progress.`;
}

// ───────────────────────────── helpers ─────────────────────────────

async function listProjects() {
  const list = await api.get('/api/projects');
  return Array.isArray(list) ? list : [];
}

/** Accept a project id, or (leniently) its exact name. */
async function resolveProject(arg) {
  const want = String(arg ?? '').trim();
  if (!want) throw new ToolError('חסר מזהה פרויקט', 'Missing "project" (a project id from list_projects).');
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(want)) {
    try { return await api.get(`/api/projects/${enc(want)}`); } catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }
  }
  const list = await listProjects();
  const lc = want.toLowerCase();
  const hit = list.find((p) => p.id === want) || list.find((p) => String(p.name || '').trim().toLowerCase() === lc);
  if (hit) return api.get(`/api/projects/${enc(hit.id)}`);
  const names = list.slice(0, 20).map((p) => `${p.id} ("${p.name}")`).join(', ');
  throw new ToolError(`הפרויקט "${want}" לא נמצא`, `Project "${want}" not found. ${list.length ? `Existing projects: ${names}` : 'There are no projects yet: use create_project.'}`);
}

function absPath(p, what = 'path') {
  let s = String(p ?? '').trim().replace(/^["']+|["']+$/g, '');
  if (/^file:\/\//i.test(s)) { try { s = fileURLToPath(s); } catch { /* keep */ } }
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  if (!s) throw new ToolError(`חסר נתיב (${what})`, `Missing ${what}.`);
  if (!path.isAbsolute(s)) throw new ToolError(`נתיב חייב להיות מלא: ${s}`, `"${s}" is not an absolute path. Use the full path, e.g. C:\\Users\\<name>\\Videos\\clip.mp4.`);
  return path.resolve(s);
}

// The file types Frame Studio imports (same lists as server/media.mjs IMAGE_EXT / AUDIO_EXT / VIDEO_EXT).
const MEDIA_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.ts', '.mts', '.gif',
  '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aif', '.aiff', '.wma',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.svg', '.jfif',
]);
const MAX_FOLDER_FILES = 60;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/** Media files directly inside a folder; when it has none, the ones in its sub-folders (one level). → {files, others, sub} */
function folderMedia(dir) {
  const read = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { throw new ToolError(`אין גישה לתיקייה: ${d}`, `Cannot read the folder ${d} (${e.code || e.message}).`); } };
  const isMedia = (n) => MEDIA_EXT.has(path.extname(n).toLowerCase()) && !n.startsWith('.') && !n.startsWith('~$');
  const entries = read(dir);
  const files = entries.filter((e) => e.isFile() && isMedia(e.name)).map((e) => path.join(dir, e.name)).sort(byName);
  const others = entries.filter((e) => e.isFile() && !isMedia(e.name)).map((e) => e.name).sort(byName);
  if (files.length) return { files, others, sub: false };
  const sub = [];
  for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort((x, y) => byName(x.name, y.name))) {
    let inner = [];
    try { inner = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }); } catch { continue; }
    for (const f of inner) if (f.isFile() && isMedia(f.name)) sub.push(path.join(dir, e.name, f.name));
  }
  return { files: sub.sort(byName), others, sub: sub.length > 0 };
}

/** import_media paths: folders → the media files inside them; drops duplicates. → {files, folders, missing} */
function expandImportPaths(paths) {
  const files = [], folders = [], missing = [];
  const seen = new Set();
  const add = (f) => { const k = process.platform === 'win32' ? f.toLowerCase() : f; if (!seen.has(k)) { seen.add(k); files.push(f); } };
  for (const p of paths) {
    let st = null;
    try { st = fs.statSync(p); } catch { /* missing */ }
    if (!st) { missing.push(p); continue; }
    if (!st.isDirectory()) { add(p); continue; }
    const r = folderMedia(p);
    if (!r.files.length) {
      const what = r.others.length ? ` It contains only other files: ${r.others.slice(0, 10).join(', ')}${r.others.length > 10 ? ` … (${r.others.length})` : ''}.` : ' It is empty.';
      throw new ToolError(`בתיקייה אין קובצי וידאו, תמונה או שמע: ${p}`,
        `The folder ${p} has no video, image or audio files (also not one level down).${what} Ask the user where the files are.`);
    }
    if (r.files.length > MAX_FOLDER_FILES) {
      throw new ToolError(`בתיקייה יש ${r.files.length} קובצי מדיה — יותר מדי לייבוא בבת אחת`,
        `The folder ${p} has ${r.files.length} media files: too many to import at once (max ${MAX_FOLDER_FILES} per folder). ` +
        `Pick the ones you need and pass their full paths in "paths". The first ones: ${r.files.slice(0, 25).map((f) => path.relative(p, f)).join(', ')}`);
    }
    folders.push({ dir: p, count: r.files.length, sub: r.sub, skipped: r.others.length });
    for (const f of r.files) add(f);
  }
  return { files, folders, missing };
}

function slugify(name) {
  const s = String(name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return /^[a-z0-9]/.test(s) ? s : '';
}

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return null;
}

function ffmpegExe() {
  try { if (typeof cfg.ffmpegPath === 'function') return cfg.ffmpegPath() || 'ffmpeg'; } catch { /* fall back */ }
  return 'ffmpeg';
}

/** Shrink a PNG so its longest side is ≤ box (ffmpeg); returns the original when it already fits or ffmpeg fails. */
async function fitPng(file, box) {
  const buf = await fsp.readFile(file);
  const sz = pngSize(buf);
  if (!sz || Math.max(sz.w, sz.h) <= box) return { buf, ...sz };
  const k = box / Math.max(sz.w, sz.h);
  const w = Math.max(2, Math.round((sz.w * k) / 2) * 2), h = Math.max(2, Math.round((sz.h * k) / 2) * 2);
  const out = file.replace(/\.png$/i, '') + `-${w}x${h}.png`;
  const ok = await new Promise((resolve) => {
    const ch = spawn(ffmpegExe(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `scale=${w}:${h}:flags=lanczos`, '-frames:v', '1', '-update', '1', out], { windowsHide: true, stdio: 'ignore' });
    ch.on('error', () => resolve(false));
    ch.on('exit', (c) => resolve(c === 0));
  });
  if (ok) { try { const b = await fsp.readFile(out); return { buf: b, w, h, path: out }; } catch { /* fall through */ } }
  return { buf, ...sz };
}

/** `cutx words` style list: index, start, end, word, exact reference. */
function wordsText(P, limit = 800) {
  const words = (P.transcript && P.transcript.words) || [];
  if (!words.length) return '';
  const seen = new Map();
  const lines = [`תמלול · Transcript words (${words.length}) — index · start · end · word · reference to use in ops:`];
  words.slice(0, limit).forEach((w, i) => {
    const k = normalizeWord(w.w);
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    lines.push(`${String(i).padEnd(5)}${f2(w.s).padEnd(8)}${f2(w.e).padEnd(8)}${String(w.w).padEnd(16)}${n ? `word:${w.w}:${n}` : `word:${w.w}`}${w.hot ? '  (hot)' : ''}`);
  });
  if (words.length > limit) lines.push(`… ${words.length - limit} more words`);
  return lines.join('\n');
}

function mediaText(P) {
  const list = Object.values(P.media || {});
  if (!list.length) return 'מדיה · Media: none yet (import_media).';
  const lines = [`מדיה · Media (${list.length}) — use the id as "mediaId" in addClip:`];
  for (const m of list) {
    lines.push(`  ${String(m.id).padEnd(16)}${String(m.kind || '').padEnd(7)}${(m.duration ? f2(m.duration) + 's' : '').padEnd(9)}${(m.width ? `${m.width}×${m.height}` : '').padEnd(11)}` +
      `${m.status && m.status !== 'ready' ? `[${m.status}] ` : ''}${m.name || ''}${m.library ? ` (library ${m.library.soundId})` : ''}${m.error ? ` — ${m.error}` : ''}`);
  }
  return lines.join('\n');
}

/** A time argument (seconds or a "word:…" / "marker:…" / "clip:…" / "end" reference) → seconds, as cutx does it. */
function timeOf(P, t) {
  const v = typeof t === 'string' ? cutx.parseTimeArg(t) : t;
  try { return resolveTime(P, v); } catch (e) {
    throw new ToolError(`זמן "${typeof t === 'string' ? t : JSON.stringify(t)}": ${e.message}`,
      'Invalid time. Use seconds, or a reference like "word:<word>", "word:<word>:1:-0.1", "marker:<label>", "clip:<id>:end", "end". get_project lists the exact word references.');
  }
}

/**
 * An empty project still has a 1-frame length (projectDuration), so "length > 0" is not a test.
 * → null, or {he, en} saying why there is nothing to render.
 */
function emptyProject(P) {
  const clips = Object.values((P && P.clips) || {});
  if (!clips.length) {
    return { he: 'הפרויקט ריק: אין בו קליפים', en: 'The project is empty (no clips on the timeline): import_media, then apply_ops addClip first.' };
  }
  const fps = Number(P.settings && P.settings.fps) || 30;
  const d = projectDuration(P);
  if (!(d > 1 / fps + 1e-6)) {
    return { he: `הפרויקט קצר מדי (${f2(d)} שנ')`, en: `The project is only ${f2(d)} s long (one frame). Give the clips a real duration with apply_ops first.` };
  }
  return null;
}

function truncate(s, max = MAX_TEXT) {
  s = String(s ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… [truncated: ${s.length - max} more characters. Ask for a smaller part.]` : s;
}

const text = (s) => ({ type: 'text', text: truncate(s) });

// ───────────────────────────── catalog ─────────────────────────────

const CATALOG_KINDS = {
  transitions: 'transitions', effects: 'effects', filters: 'filters', 'clip-anims': 'clipAnims', 'text-anims': 'textAnims',
  'caption-styles': 'captionStyles', 'text-presets': 'textPresets', stickers: 'stickers', shapes: 'shapes', fonts: 'fonts', luts: 'luts',
};
const CATALOG_USE = {
  transitions: 'setTransition.transition', effects: 'addEffect.effect / addClip type:"effect" effect', filters: 'filter (addClip/updateClip) or filter.id',
  clipAnims: 'animIn / animOut / animLoop', textAnims: 'textAnim.in / textAnim.out / textAnim.loop', captionStyles: 'addCaptions.style / styleCaptions.style',
  textPresets: 'addClip type:"text" preset', stickers: 'addClip type:"sticker" value', shapes: 'addClip type:"shape" kind', fonts: 'text.font', luts: 'lut (file name)',
};

async function catalogText(kind) {
  const want = CATALOG_KINDS[kind];
  if (!want) throw new ToolError(`קטלוג לא מוכר: ${kind}`, `Unknown catalog kind "${kind}". Use one of: ${Object.keys(CATALOG_KINDS).join(', ')}.`);
  let list;
  if (want === 'fonts' || want === 'luts') {
    await ensureServer();
    try { list = await api.get(`/api/library/${want}`); } catch { list = null; }
    if (!list && want === 'luts') { try { list = fs.readdirSync(path.join(ROOT, 'library', 'luts')).filter((f) => /\.cube$/i.test(f)); } catch { list = []; } }
    if (!list) { const { getCatalog } = await imp('shared/catalog.js'); list = (await getCatalog()).fonts; }
  } else {
    const { getCatalog } = await imp('shared/catalog.js');
    list = (await getCatalog())[want];
  }
  const lines = [`${kind} — use as: ${CATALOG_USE[want]}`];
  const item = (it) => {
    if (typeof it === 'string') return `  ${it}`;
    const idv = it.id || it.family || it.name || it.file;
    const extra = [it.category, it.defaultDuration !== undefined && `default ${it.defaultDuration}s`, it.kind, it.value, it.weights && `weights ${[].concat(it.weights).join(',')}`].filter(Boolean).join(' · ');
    let s = `  ${String(idv).padEnd(20)}${(it.name && it.name !== idv ? it.name : '').padEnd(26)}${extra}`;
    if (Array.isArray(it.params) && it.params.length) {
      s += `\n  ${''.padEnd(20)}params: ${it.params.map((p) => `${p.key}${p.default !== undefined ? '=' + JSON.stringify(p.default) : ''}${p.min !== undefined ? ` [${p.min}..${p.max}]` : ''}`).join(', ')}`;
    }
    return s;
  };
  if (list && !Array.isArray(list) && typeof list === 'object' && (list.in || list.out || list.loop)) {
    for (const part of ['in', 'out', 'loop']) {
      const l = list[part] || [];
      lines.push(`${part === 'in' ? want === 'clipAnims' ? 'animIn' : 'textAnim.in' : part === 'out' ? want === 'clipAnims' ? 'animOut' : 'textAnim.out' : want === 'clipAnims' ? 'animLoop' : 'textAnim.loop'} (${l.length}):`);
      for (const a of l) lines.push(item(a));
    }
  } else {
    const l = Array.isArray(list) ? list : [];
    lines[0] += ` (${l.length})`;
    if (!l.length) lines.push('  (empty)');
    for (const it of l) lines.push(item(it));
  }
  return lines.join('\n');
}

// ───────────────────────────── audio balance (cutx balance logic, with a time budget) ─────────────────────────────

async function fetchPeaks(projectId, P, C) {
  const map = new Map();
  for (const it of cutx.backgroundItems(P)) {
    const m = it.media;
    if (map.has(m.id)) continue;
    let pk = null;
    try { pk = await api.get(`/api/projects/${enc(projectId)}/media/${enc(m.id)}/peaks`, { timeout: 20000, signal: C.signal }); } catch { pk = null; }
    if ((!pk || !Array.isArray(pk.peaks)) && m.library && m.library.soundId) {
      try { pk = await api.get(`/api/library/sounds/${enc(m.library.soundId)}/peaks`, { timeout: 60000, signal: C.signal }); } catch { pk = null; }
    }
    if (Array.isArray(pk)) pk = { rate: 100, peaks: pk };
    if (!pk || !Array.isArray(pk.peaks)) {
      try { pk = JSON.parse(fs.readFileSync(path.join(dataDir(), 'projects', projectId, 'cache', 'peaks', `${m.id}.json`), 'utf8')); } catch { pk = null; }
    }
    map.set(m.id, pk && Array.isArray(pk.peaks) ? { rate: Number(pk.rate) || 100, peaks: pk.peaks } : null);
  }
  return map;
}

async function speechCheck(id, target, C) {
  const job = await api.post(`/api/projects/${enc(id)}/check-audio`, { threshold: target }, { signal: C.signal });
  const r = await waitJob(job, C, 'בדיקת שמע · audio check');
  if (!r.done) return { pending: r.job };
  const rep = r.job.report || r.job.result || r.job;
  return { sm: rep.speechMargin || rep.speech || rep.margin || null, report: rep };
}

const smLine = (sm, target) => `min ${f2(sm.min)} dB${sm.worst ? ` at ${f2(sm.worst.t)}s` : ''} · median ${f2(sm.median)} dB · ${sm.belowCount ?? (sm.below || []).length} windows below ${target} dB`;
const smOk = (sm, target) => sm && (sm.min === null || sm.min === undefined || +sm.min >= target);

async function balance(id, { target = 12, dry = false, maxRounds = 8 }, C) {
  const P0 = await api.get(`/api/projects/${enc(id)}`);
  const peaks = await fetchPeaks(id, P0, C);
  const lines = [`איזון קול מול רקע · Voice-over balance — "${P0.name}" (${id}) · target: voice ≥ ${target} dB above music + sfx${dry ? ' · plan only (dry_run)' : ''}`];
  const missing = [...peaks].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) lines.push(`⚠ no waveform for ${missing.join(', ')}: blame estimated from volume only`);
  let c = await speechCheck(id, target, C);
  if (c.pending) return { text: `${lines.join('\n')}\n${stillRunning(c.pending, 'audio check')}\n(Then call balance_audio again.)` };
  let sm = c.sm;
  if (!sm || sm.error) throw new ToolError('בדיקת השמע לא החזירה מרווח דיבור', `The audio check returned no speech margin${sm && sm.error ? `: ${sm.error}` : ''}. Is there a voice-over clip on a voice track?`);
  if (sm.min === null || sm.min === undefined) return { text: `${lines.join('\n')}\nNo active speech windows (no voice-over on a voice track). Nothing to balance.` };
  const first = sm;
  let P = P0;
  const touched = new Set();
  const locked = new Set();
  let applied = 0;
  let stoppedEarly = false;
  for (let round = 1; round <= maxRounds && !smOk(sm, target); round++) {
    const plan = cutx.planBalance(P, sm.below || [], { target });
    for (const x of plan.locked) locked.add(x);
    const ops = cutx.balanceOps(P, plan);
    lines.push(`round ${round}: ${smLine(sm, target)} → ${ops.length ? `lowering ${ops.length} clips (${plan.windows.length} windows)` : 'no clip to lower'}`);
    if (dry) {
      for (const [cid, list] of plan.dips) {
        const cl = P.clips[cid];
        lines.push(`  ${cid.padEnd(14)}"${(cl && cl.name) || cid}" · ${list.length} windows (${list.slice(0, 8).map((d) => f2(d.t0)).join(', ')}${list.length > 8 ? ' …' : ''}) · up to -${f2(Math.max(...list.map((d) => d.depth)))} dB`);
      }
      for (const x of plan.locked) lines.push(`  ⚠ ${x}: track is locked, not lowered`);
      return { text: lines.join('\n') };
    }
    if (!ops.length) break;
    const r = await api.post(`/api/projects/${enc(id)}/ops`, { ops, by: 'claude', summary: `איזון קול מול רקע (סבב ${round})` }, { signal: C.signal });
    for (const b of (r.results || []).filter((x) => !x.ok)) lines.push(`  ✗ ${b.op}: ${b.error}`);
    applied++;
    ops.forEach((o, i) => { if (r.results && r.results[i] && r.results[i].ok) touched.add(o.id); });
    P = r.project || (await api.get(`/api/projects/${enc(id)}`));
    if (C.left() < 8000) { stoppedEarly = true; break; }
    c = await speechCheck(id, target, C);
    if (c.pending) { stoppedEarly = true; break; }
    sm = c.sm;
    if (!sm || sm.error) throw new ToolError('בדיקת השמע נכשלה באמצע האיזון', 'The audio check failed during balancing.');
  }
  const clips = cutx.dipSummary(P0, P, [...touched]);
  const sugg = cutx.sfxSuggestions(P0, [...touched], peaks);
  lines.push('');
  if (stoppedEarly) lines.push(`⏳ Stopped after ${applied} round(s) to stay within the time limit. Call balance_audio again to continue (each round is saved).`);
  else if (smOk(sm, target)) lines.push(`✓ Target reached${applied ? ` after ${applied} round(s)` : ' (nothing needed lowering)'}: ${smLine(sm, target)}`);
  else lines.push(`✗ Target not reached after ${applied} round(s): ${smLine(sm, target)}${(sm.below || []).length ? ` · at ${(sm.below || []).slice(0, 10).map((b) => f2(b.t)).join(', ')}` : ''}`);
  lines.push(`  before: ${smLine(first, target)}`);
  if (clips.length) {
    lines.push('Lowered clips (the voice was never raised):');
    for (const x of clips) lines.push(`  ${x.id.padEnd(14)}"${x.name}" · ${x.regions} regions · ${f2(x.seconds)}s · down to ${f2(x.maxDb)} dB`);
  }
  for (const x of locked) lines.push(`  ⚠ ${x}: track is locked, not lowered`);
  for (const s of sugg) {
    lines.push(`Suggestion: sound "${s.name}" (${s.id}) sits mostly on speech (${s.onSpeech}%), so it was lowered a lot.` +
      (s.start !== undefined ? ` Better move it into the gap ${f2(s.gap[0])}–${f2(s.gap[1])}s: apply_ops [{"op":"moveClip","id":"${s.id}","start":${f2(s.start)}}], then balance_audio again.` : ' Better move it into a gap between words.'));
  }
  if (applied) lines.push('Each round is one undo step (summary "איזון קול מול רקע").');
  return { text: lines.join('\n') };
}

// ───────────────────────────── snapshot images ─────────────────────────────

async function snapshotContent(job, P, { sheet }) {
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const pngs = outputs.filter((o) => o && o.kind === 'png' && o.path);
  const sheetOut = outputs.find((o) => o && o.kind === 'sheet' && o.path);
  const S = P ? P.settings || {} : {};
  const content = [];
  const head = [`Snapshot of "${P ? P.name : job.projectName || job.projectId}" · ${pngs.length} frame(s) · canvas ${S.width || job.width}×${S.height || job.height}` +
    `${P ? ` · project length ${f2(projectDuration(P))}s` : ''}`];
  if (job.dir) head.push(`Saved in: ${job.dir}`);
  const empty = P ? emptyProject(P) : null;
  if (empty) head.push(`⚠ ${empty.en} These frames show only the background colour; they are not a rendering problem.`);
  for (const w of job.warnings || []) head.push(`⚠ ${w}`);
  head.push('Look at every image carefully: text cut off or outside the safe area, wrong RTL word order, black/empty frames, captions over faces, overlapping elements.');
  content.push(text(head.join('\n')));
  if (sheet && sheetOut) {
    const img = await fitPng(sheetOut.path, 1600);
    content.push(text(`Contact sheet (frames numbered in order: ${pngs.map((o, i) => `#${i + 1} ${f2(o.t)}s`).join(', ')}) · ${img.w}×${img.h} · ${sheetOut.path}`));
    content.push({ type: 'image', data: img.buf.toString('base64'), mimeType: 'image/png' });
    return content;
  }
  for (const [i, o] of pngs.slice(0, MAX_IMAGES).entries()) {
    const img = await fitPng(o.path, IMAGE_BOX);
    content.push(text(`Frame ${i + 1} at ${f2(o.t)}s · ${img.w}×${img.h} · ${o.path}`));
    content.push({ type: 'image', data: img.buf.toString('base64'), mimeType: 'image/png' });
  }
  if (pngs.length > MAX_IMAGES) content.push(text(`(${pngs.length - MAX_IMAGES} more frames saved in ${job.dir} — use sheet:true to see them all at once)`));
  return content;
}

function exportText(job) {
  const rep = job.report || job.result || {};
  const files = cutx.jobFiles(job).filter((f) => /\.(mp4|mov|webm|mkv)$/i.test(f));
  const lines = ['✓ הייצוא הסתיים · Export finished'];
  if (files.length) lines.push(`File: ${files.join(', ')}`);
  lines.push(cutx.formatReport(rep));
  const sm = rep.speechMargin || rep.speech;
  if (cutx.marginFailed(sm)) lines.push('✗ The voice is not always ≥ 12 dB above music + sfx. Run balance_audio, then export_video again.');
  lines.push('Tell the user where the file is, plus duration, LUFS and the speech margin.');
  return lines.join('\n');
}

function audioText(job) {
  const rep = job.report || job.result || job;
  const lines = [cutx.formatReport(rep)];
  const sm = rep.speechMargin || rep.speech || rep.margin;
  if (!sm || sm.min === null || sm.min === undefined) lines.push('Speech margin not measured: there is no voice-over clip on a voice track (role "voice"), so there is nothing to balance.');
  else if (cutx.marginFailed(sm)) lines.push('✗ Below the 12 dB target → run balance_audio (lowers only the guilty music/sfx clips, only where needed).');
  else lines.push('✓ Speech margin OK.');
  return lines.join('\n');
}

async function transcriptResult(id, job) {
  const P = await api.get(`/api/projects/${enc(id)}`);
  const words = (P.transcript && P.transcript.words) || [];
  const lines = [`✓ תמלול · Transcribed: ${words.length} words${words.length ? ` (${f2(words[0].s)}–${f2(words[words.length - 1].e)}s)` : ''}`];
  if (words.length) lines.push(words.slice(0, 60).map((w) => w.w).join(' ') + (words.length > 60 ? ' …' : ''));
  if (job && job.captions) lines.push(`Captions: ${Object.values(P.clips).filter((x) => x.type === 'caption').length} segments`);
  lines.push('Whisper misspells words. If you have the real script, call set_transcript with project and script (no words) to fix the spelling while keeping the timings.',
    'Use get_project to see every word with its exact reference (word:…).');
  return lines.join('\n');
}

// ───────────────────────────── tools ─────────────────────────────

const S = {
  project: { type: 'string', description: 'Project id (from list_projects / create_project).' },
  time: { description: 'Seconds (number) or a time reference string: "word:<word>[:occurrence[:offset[:end]]]", "marker:<label>", "clip:<id>:end", "MM:SS:FF", "end".', anyOf: [{ type: 'number' }, { type: 'string' }] },
};

const TOOLS = [
  {
    name: 'frame_studio_status',
    title: 'Frame Studio status',
    description: 'Check that Frame Studio is running. It starts the local server in the background when it is not running. Reports version, projects, sound library, local transcription and the editor address. Call it first in a new conversation, or when another tool says it cannot reach the server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run() {
      const h = await ensureServer();
      const [projects, asr, snd] = await Promise.all([
        listProjects().catch(() => []), api.get('/api/asr/status').catch(() => null), api.get('/api/library/sounds/status').catch(() => null),
      ]);
      const mods = h.modules || {};
      const bad = Object.entries(mods).filter(([, v]) => !v).map(([k]) => k);
      const lines = [
        `✓ Frame Studio ${h.version} is running at ${BASE}${startedByUs ? ' (just started in the background)' : ''} · program folder ${h.root}${h.dataDir ? ` · projects in ${path.join(h.dataDir, 'projects')}` : ''}`,
        `Editor: ${BASE}/ → call open_editor (optionally with a project) so the user can watch edits live.`,
        `Projects: ${projects.length}${projects.length ? ` (latest: ${projects.slice(0, 5).map((p) => p.id).join(', ')})` : ' (create one with create_project)'}`,
        snd ? `Sound library: ${snd.count} sounds${snd.indexing ? ` (indexing ${snd.done}/${snd.total}…)` : ''}${!snd.count && !snd.indexing ? ' (empty: the user can add a folder of sound effects in the editor, see library/sounds/README.md)' : ''}` : 'Sound library: unknown',
        asr ? `Local transcription (Whisper): ${asr.ok ? `ready (model ${asr.defaultModel})` : 'not installed: captions need word timings from set_transcript, or install it with tools\\install-transcription.cmd'}` : '',
        bad.length ? `⚠ Modules not loaded: ${bad.join(', ')}. ${Object.values(h.errors || {}).join(' | ')}` : '',
        'Before your first edit, call get_editing_guide once.',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    name: 'open_editor',
    title: 'Open the editor window',
    description: 'Open the Frame Studio editor window on the user\'s screen, optionally showing one project. The user then watches every edit live and can keep editing by hand. Call it after create_project, or when the user wants to see the project.',
    inputSchema: { type: 'object', properties: { project: S.project }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      await ensureServer();
      const id = a.project ? (await resolveProject(a.project)).id : null;
      const r = await api.post('/api/open', { ...(id ? { project: id } : {}), ...(process.env.FRAME_STUDIO_MCP_DRY_OPEN === '1' ? { dry: true } : {}) });
      return `✓ The editor window was opened${id ? ` on "${id}"` : ''} (${r.url}${r.browser && r.browser !== 'default' ? '' : ', default browser'}). Edits you apply now appear there live.`;
    },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List the Frame Studio projects: id, name, size, fps, length, clip count and last change. Use the id in every other tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run() {
      await ensureServer();
      const list = await listProjects();
      if (!list.length) return 'No projects yet. Create one with create_project.';
      const lines = [`${'id'.padEnd(26)}${'name'.padEnd(30)}${'size'.padEnd(12)}${'fps'.padEnd(5)}${'length'.padEnd(9)}${'clips'.padEnd(7)}modified`];
      for (const p of list) lines.push(`${String(p.id).padEnd(26)}${String(p.name || '').slice(0, 28).padEnd(30)}${`${p.width}×${p.height}`.padEnd(12)}${String(p.fps).padEnd(5)}${(f2(p.duration) + 's').padEnd(9)}${String(p.clipCount ?? '').padEnd(7)}${p.modified ?? ''}`);
      return lines.join('\n');
    },
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description: 'Create a new video project with the default tracks (text, overlay, main, voice, music, sfx). format: "9:16" vertical 1080×1920 for Reels/TikTok/Shorts (default), "16:9" landscape 1920×1080 for YouTube, "1:1" square, "4:5" portrait feed. Afterwards call open_editor so the user can watch.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name shown to the user (any language).' },
        format: { type: 'string', enum: ['9:16', '16:9', '1:1', '4:5'], description: 'Aspect ratio (default "9:16").' },
        fps: { type: 'number', description: 'Frames per second (default 30).' },
        id: { type: 'string', description: 'Optional id: lowercase a-z, 0-9 and "-". Made from the name when omitted.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a) {
      await ensureServer();
      const name = String(a.name || '').trim();
      if (!name) throw new ToolError('חסר שם לפרויקט', 'Missing "name".');
      const size = cutx.parseSize(a.format || '9:16');
      const fps = a.fps !== undefined ? Number(a.fps) : 30;
      if (!(fps >= 1 && fps <= 120)) throw new ToolError('fps לא תקין', '"fps" must be between 1 and 120.');
      let id = a.id ? String(a.id).trim() : '';
      if (id && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new ToolError(`מזהה לא תקין "${id}"`, `Invalid id "${id}": use lowercase a-z, 0-9 and "-".`);
      const taken = new Set((await listProjects()).map((p) => p.id));
      if (!id) {
        const base = slugify(name) || `video-${new Date().toISOString().slice(0, 10)}`;
        id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      } else if (taken.has(id)) throw new ToolError(`הפרויקט "${id}" כבר קיים`, `Project "${id}" already exists: pick another id, or edit it.`);
      const P = await api.post('/api/projects', { id, name, width: size[0], height: size[1], fps, tracks: 'default', by: 'claude' });
      return `✓ Created project "${P.name}" · id ${P.id} · ${P.settings.width}×${P.settings.height} · ${P.settings.fps}fps · tracks: ${P.tracks.map((t) => `${t.id} (${t.role})`).join(', ')}\n` +
        'Next: open_editor (so the user watches), import_media for the user\'s files, then apply_ops.';
    },
  },
  {
    name: 'get_project',
    title: 'Read a project',
    description: 'Read the current state of a project: every track (top track draws on top) and every clip with its id, type, start–end, text and effects. Also lists markers, media ids and the transcript words with ready-made word references. ALWAYS call it before a new round of edits, because the user may have edited by hand. detail:"json" returns the raw project JSON (large).',
    inputSchema: {
      type: 'object',
      properties: { project: S.project, detail: { type: 'string', enum: ['summary', 'json'], description: '"summary" (default) or "json".' } },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a) {
      await ensureServer();
      const P = await resolveProject(a.project);
      if (a.detail === 'json') return JSON.stringify(P, null, 1);
      // the cutx text ends with CLI hints for the transcript and media; this tool shows both in full instead
      const show = cutx.formatProject(P).split('\n').filter((l) => !/^(תמלול|מדיה):/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const words = wordsText(P) || 'תמלול · Transcript: none (captions and "word:" times need one: transcribe or set_transcript).';
      return [show, mediaText(P), words].join('\n\n');
    },
  },
  {
    name: 'import_media',
    title: 'Import media files',
    description: 'Add the user\'s video, image or audio files to a project, using absolute paths (Hebrew and spaces are fine). A folder path imports the media files inside it (sorted by name, other files skipped, up to 60). Waits until they are processed and returns their media ids (m_…). Use those ids in addClip ops ("mediaId"). This does not put anything on the timeline yet. copy:true copies the files into the project folder.',
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Absolute file or folder paths, e.g. "C:\\Users\\me\\Videos\\clip.mp4" or "C:\\Users\\me\\Videos\\Trip".' },
        copy: { type: 'boolean', description: 'Copy into the project folder instead of linking the original (default false).' },
      },
      required: ['project', 'paths'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P0 = await resolveProject(a.project);
      const { files, folders, missing } = expandImportPaths((Array.isArray(a.paths) ? a.paths : [a.paths]).map((p) => absPath(p, 'paths')));
      if (!files.length) {
        throw new ToolError(`הקבצים לא נמצאו: ${missing.join(', ')}`,
          `Not found: ${missing.join(', ')}. Check the spelling of the path (or ask the user for it); a folder path imports the media files inside it.`);
      }
      let r;
      try {
        r = await api.post(`/api/projects/${enc(P0.id)}/import`, { paths: files, copy: !!a.copy, by: 'claude' }, { signal: C.signal });
      } catch (e) {
        // every file failed: list each one with its reason
        const errs = e && e.data && Array.isArray(e.data.errors) ? e.data.errors : null;
        if (!errs || !errs.length) throw e;
        throw new ToolError(`אף קובץ לא יובא: ${errs.map((x) => x.error).join(' | ')}`,
          `No file was imported:\n${errs.map((x) => `  ✗ ${x.path}: ${serverErrorEn(x.error)}`).join('\n')}${missing.length ? `\n  ✗ not found: ${missing.join(', ')}` : ''}\nFrame Studio imports video, image and audio files.`);
      }
      let media = (r && r.media) || [];
      while (media.some((m) => m.status === 'processing') && C.left() > 1500) {
        C.progress(Math.round((media.filter((m) => m.status !== 'processing').length / media.length) * 100), 'processing media');
        await sleep(800);
        const P = await api.get(`/api/projects/${enc(P0.id)}`, { signal: C.signal });
        media = media.map((m) => (P.media && P.media[m.id]) || m);
      }
      const lines = [];
      for (const f of folders) {
        lines.push(`Folder ${f.dir}: ${f.count} media file(s)${f.sub ? ' from its sub-folders (one level down)' : ''}${f.skipped ? `, ${f.skipped} other file(s) skipped` : ''}.`);
      }
      lines.push(`Imported ${media.length} file(s) into "${P0.id}":`);
      for (const m of media) {
        lines.push(`  ${String(m.id).padEnd(16)}${String(m.kind).padEnd(7)}${(m.duration ? f2(m.duration) + 's' : '').padEnd(9)}${(m.width ? `${m.width}×${m.height}` : '').padEnd(11)}` +
          `${m.hasAudio ? 'audio ' : ''}${m.status === 'ready' ? '' : `[${m.status}] `}${m.name}${m.error ? ` — ${m.error}${HEB.test(String(m.error)) ? ` · ${serverErrorEn(m.error)}` : ''}` : ''}`);
      }
      for (const e of (r && r.errors) || []) lines.push(`  ✗ ${e.path || ''}: ${e.error}${HEB.test(String(e.error)) ? ` · ${serverErrorEn(e.error)}` : ''}`);
      for (const p of missing) lines.push(`  ✗ not found: ${p}`);
      if (media.some((m) => m.status === 'processing')) lines.push('Some files are still being processed in the background. You can already add them; snapshot and export wait for them.');
      lines.push('Next: apply_ops with addClip {"type":"video"|"image"|"audio","mediaId":"<id>",…}.');
      return { text: lines.join('\n'), isError: !media.length || media.every((m) => m.status === 'error') };
    },
  },
  {
    name: 'apply_ops',
    title: 'Edit: apply operations',
    description: `The main editing tool. It applies a batch of JSON operations to a project. The editor updates live and shows the user your summary.
Results come back per op: ok + new ids, or the error. A failed op does not stop the others, unless atomic:true is set (then nothing is saved).
Give new clips your own "id" so later ops in the same batch can refer to them. Times: seconds, or "word:<w>[:occurrence[:offset]]", "marker:<label>", "clip:<id>:end", "end".
Positions: x/y = pixel offset of the clip centre from the canvas centre (y down). yAbs/xAbs = measured from the top-left corner (a 9:16 canvas is 1080×1920).
Key ops (examples):
{"op":"addClip","type":"video","mediaId":"m_1","start":0,"id":"s1","muteAudio":true} · {"op":"addClip","type":"video","mediaId":"m_2","start":"clip:s1:end","in":1.5,"duration":3}
{"op":"addClip","type":"audio","mediaId":"m_vo","start":0,"role":"voice"} · {"op":"addClip","type":"audio","mediaId":"m_song","start":0,"end":"end","role":"music","volume":0.5,"audioFx":{"duckUnderVoice":true}}
{"op":"addClip","type":"text","content":"שלום","start":0,"duration":2,"yAbs":600,"preset":"title","animIn":"pop"} · {"op":"addClip","type":"sticker","value":"🔥","start":1,"x":300,"y":-300}
{"op":"addClip","type":"effect","effect":"zoomPunch","at":"word:wow","duration":0.5} · {"op":"addClip","type":"adjustment","filter":"cinematic","start":0,"end":"end"}
{"op":"updateClip","id":"s1","set":{"transform.scale":1.2,"text.color":"#ffcc00"}} · {"op":"moveClip","id":"s1","start":2} · {"op":"trimClip","id":"s1","head":0.3} · {"op":"splitClip","id":"s1","at":4,"newId":"s1b"} · {"op":"removeClips","ids":["s1b"],"ripple":true}
{"op":"setTransition","id":"s1","transition":"crossfade","duration":0.5} (on the outgoing clip; the next clip must start exactly at its end, same track; {"op":"closeGaps","track":"main"} snaps)
{"op":"addEffect","id":"s1","effect":"shake"} · {"op":"setKeyframes","id":"s1","prop":"transform.scale","keys":[{"t":0,"v":1},{"t":0.5,"v":1.3,"ease":"spring"}]}
{"op":"sfx","sound":"<id from search_sounds>","at":"word:boom:0:-0.1","gain_db":-12,"len":1.5,"fade":0.2}
{"op":"addCaptions","words":"transcript","style":"popWords","maxWords":3,"yAbs":1250,"hook0":true,"replace":true} (needs a transcript: transcribe or set_transcript)
{"op":"addMarker","t":3.2,"label":"drop"} · {"op":"insertGap","at":4,"duration":0.5} · {"op":"rippleDelete","from":4,"to":4.6} · {"op":"setSettings","set":{"background":"#000000"}}
Ids for transitions, effects, filters, animations, styles, presets and stickers: get_catalog (never guess). Any op's fields: get_editing_guide with topic "<opName>". Afterwards check your work with snapshot.`,
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, minItems: 1, description: 'Operations, applied in order.' },
        summary: { type: 'string', description: 'One short sentence in the user\'s language, describing the edit. It is shown in the editor and in the undo history.' },
        atomic: { type: 'boolean', description: 'All or nothing (default false).' },
      },
      required: ['project', 'ops', 'summary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      let ops = a.ops;
      if (typeof ops === 'string') { try { ops = JSON.parse(ops); } catch (e) { throw new ToolError('ops אינו JSON תקין', `"ops" is not valid JSON: ${e.message}`); } }
      if (ops && !Array.isArray(ops) && Array.isArray(ops.ops)) ops = ops.ops;
      if (ops && !Array.isArray(ops) && ops.op) ops = [ops];
      if (!Array.isArray(ops) || !ops.length) throw new ToolError('חסרות פעולות', '"ops" must be a non-empty array of {"op": …} objects.');
      const bad = ops.findIndex((o) => !o || typeof o !== 'object' || typeof o.op !== 'string');
      if (bad >= 0) throw new ToolError(`פעולה ${bad + 1} בלי "op"`, `Op #${bad + 1} has no "op" name.`);
      const P = await resolveProject(a.project);
      const r = await api.post(`/api/projects/${enc(P.id)}/ops`, { ops, by: 'claude', summary: String(a.summary || '').trim() || summarizeOps(ops), atomic: !!a.atomic }, { signal: C.signal });
      const { text: t, failed } = cutx.formatResults(r, ops);
      const lines = [t];
      if (failed && a.atomic) lines.push('atomic: nothing was saved. Fix the failing op and send the whole batch again.');
      else if (failed) lines.push(`${failed} op(s) failed (the rest were applied). Fix them and send only those again. Use get_project for current ids; get_editing_guide("<op>") for fields.`);
      if (!failed) lines.push('Next: check the result with snapshot (at the times you changed).');
      return { text: lines.join('\n'), isError: failed > 0 && (!!a.atomic || failed === ops.length) };
    },
  },
  {
    name: 'get_catalog',
    title: 'Look up catalog ids',
    description: 'List the valid ids, with their parameters and defaults, for one catalog: transitions (setTransition), effects (addEffect / effect clips), filters, clip-anims (animIn/animOut/animLoop), text-anims (textAnim), caption-styles (addCaptions style), text-presets (text preset), stickers, shapes, fonts, luts. Never guess an id: look it up here.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: Object.keys(CATALOG_KINDS), description: 'Which catalog.' } },
      required: ['kind'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a) { return catalogText(a.kind); },
  },
  {
    name: 'search_sounds',
    title: 'Search sound effects',
    description: 'Search the local sound-effects library (whoosh, boom, riser, click, glitch, swoosh, impact…). Returns sound ids with duration, peak level (peakDb), category and a suggested role. Put one on the timeline with the "sfx" op in apply_ops: {"op":"sfx","sound":"<id>","at":<time>,"gain_db":-14,"len":1.2,"fade":0.2}. Lower gain_db for loud files (peakDb near 0). Never synthesize sounds.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search words, e.g. "whoosh", "boom impact", "riser". Empty = browse.' },
        limit: { type: 'number', description: 'Max results (default 15, max 50).' },
        category: { type: 'string', description: 'Optional category name (as returned in results).' },
        min_duration: { type: 'number', description: 'Minimum length in seconds.' },
        max_duration: { type: 'number', description: 'Maximum length in seconds.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a) {
      await ensureServer();
      const q = new URLSearchParams();
      if (a.query) q.set('q', String(a.query));
      if (a.category) q.set('category', String(a.category));
      if (a.min_duration !== undefined) q.set('min', String(a.min_duration));
      if (a.max_duration !== undefined) q.set('max', String(a.max_duration));
      q.set('limit', String(Math.min(50, Math.max(1, Math.round(Number(a.limit) || 15)))));
      const r = await api.get(`/api/library/sounds?${q}`, { timeout: 120000 });
      const list = Array.isArray(r) ? r : (r && (r.items || r.results || r.sounds)) || [];
      const idx = r && r.indexing ? ` (the library is still indexing: ${r.indexing.done}/${r.indexing.total})` : '';
      if (!list.length) {
        let st = null;
        try { st = await api.get('/api/library/sounds/status'); } catch { /* ignore */ }
        if (st && !st.count && (st.indexing || st.ready === false)) return 'The sound library is still being indexed. Try again in a minute.';
        if (st && !st.count && !st.indexing) {
          return 'The sound library is empty. Tell the user how to add sounds: download a free sound pack (for example the Sonniss #GameAudioGDC bundle), then add its folder in the editor\'s Audio tab, or drop the files into the Frame Studio sounds folder (see library/sounds/README.md). The "sfx" op also accepts a full path to an audio file.';
        }
        return `No sounds match "${a.query || ''}"${idx}. Try other words (English file names), e.g. whoosh, swoosh, impact, hit, riser, click, glitch, pop.`;
      }
      const lines = [`${'id'.padEnd(14)}${'length'.padEnd(8)}${'peakDb'.padEnd(8)}${'category'.padEnd(20)}${'role'.padEnd(10)}name`];
      for (const s of list) lines.push(`${String(s.id).padEnd(14)}${(f2(s.duration) + 's').padEnd(8)}${(s.peakDb !== undefined ? f2(s.peakDb) : '').padEnd(8)}${String(s.category || '').slice(0, 18).padEnd(20)}${String(s.role || '').padEnd(10)}${s.name}`);
      const total = r && !Array.isArray(r) ? r.total : undefined;
      if (total !== undefined && total > list.length) lines.push(`… ${total} matches in total (raise limit or refine the query)`);
      if (idx) lines.push(`Note${idx}: more sounds will appear in a minute.`);
      lines.push('Use: apply_ops [{"op":"sfx","sound":"<id>","at":"word:…","gain_db":-14,"len":1.2,"fade":0.2}]');
      return lines.join('\n');
    },
  },
  {
    name: 'set_transcript',
    title: 'Set word timings',
    description: 'Set the project transcript, which gives captions and "word:…" time references their timings. Give either words (a list of [word, start, end] or {w,s,e} in seconds), or asr_file (an absolute path to a Whisper/ASR JSON file). Add script (the real text that was spoken) to keep the ASR timings but use the script\'s correct spelling and punctuation. With only script (no words), it re-aligns the existing transcript, for example after transcribe. hot = words to highlight in captions. Then caption it with apply_ops {"op":"addCaptions","words":"transcript",…}.',
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        words: { type: 'array', description: '[["word",start,end],…] or [{"w":"word","s":0.1,"e":0.4},…]', items: { anyOf: [{ type: 'array' }, { type: 'object' }] } },
        asr_file: { type: 'string', description: 'Absolute path to an ASR JSON file ([[w,s,e]…], {words:[…]} or {segments:[{words}]}).' },
        script: { type: 'string', description: 'The exact spoken text (fixes ASR spelling).' },
        hot: { type: 'array', items: { type: 'string' }, description: 'Words to highlight.' },
        media_id: { type: 'string', description: 'Optional: the voice-over media these timings belong to.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P = await resolveProject(a.project);
      let words;
      try {
        if (a.words !== undefined && a.words !== null) words = cutx.normalizeAsr(typeof a.words === 'string' ? JSON.parse(a.words) : a.words);
        else if (a.asr_file) {
          const f = absPath(a.asr_file, 'asr_file');
          if (!fs.existsSync(f)) throw new ToolError(`הקובץ לא נמצא: ${f}`, `File not found: ${f}`);
          words = cutx.normalizeAsr(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')));
        }
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(`תמלול לא תקין: ${e.message}`, 'Invalid words: use [["word",start,end],…] or [{"w":"word","s":0.1,"e":0.4},…].');
      }
      const script = typeof a.script === 'string' && a.script.trim() ? a.script.trim() : null;
      if (!words && !script) throw new ToolError('חסר תמלול', 'Give "words", "asr_file", or "script" (to re-align the existing transcript).');
      if (!words && !((P.transcript && P.transcript.words) || []).length) throw new ToolError('אין תמלול קיים ליישור', 'The project has no transcript yet: give "words"/"asr_file" with the script, or use transcribe.');
      const op = { op: 'setTranscript', words: words || 'transcript' };
      if (script) op.script = script;
      if (Array.isArray(a.hot) && a.hot.length) op.hot = a.hot.map(String);
      if (a.media_id) op.mediaId = String(a.media_id);
      const summary = script ? `תמלול מיושר לתסריט${words ? ` (${words.length} מילים)` : ''}` : `תמלול (${words.length} מילים)`;
      const r = await api.post(`/api/projects/${enc(P.id)}/ops`, { ops: [op], by: 'claude', summary }, { signal: C.signal });
      const { text: t, failed } = cutx.formatResults(r, [op]);
      return { text: `${t}\n${failed ? '' : 'Next: get_project shows each word with its reference. Then apply_ops {"op":"addCaptions","words":"transcript",…}.'}`, isError: failed > 0 };
    },
  },
  {
    name: 'transcribe',
    title: 'Transcribe speech (local)',
    description: 'Get word timings from a voice-over or video with speech, using local Whisper on the user\'s computer (optional add-on). media = a media id from the project, or an absolute file path. captions:true also creates captions. If local transcription is not installed, it explains what to do. Long files can take minutes: when it is still running, call wait_job.',
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        media: { type: 'string', description: 'Media id (m_…) or absolute path of the audio/video with speech.' },
        language: { type: 'string', description: 'Speech language code, e.g. "he" (default) or "en".' },
        model: { type: 'string', enum: ['tiny', 'base', 'small', 'medium', 'large-v3'], description: 'Whisper model (default small).' },
        captions: { type: 'boolean', description: 'Also add captions (default false).' },
        caption_style: { type: 'string', description: 'Caption style id (get_catalog caption-styles), with captions:true.' },
      },
      required: ['project', 'media'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P = await resolveProject(a.project);
      const st = await api.get('/api/asr/status');
      if (!st || !st.ok) {
        return {
          isError: true,
          text: 'התמלול המקומי לא מותקן · Local transcription is not installed on this computer.\n' +
            `What to tell the user: double-click "tools\\install-transcription.cmd" in the Frame Studio folder (${ROOT}). It installs free offline Whisper; it takes a few minutes. Then try again.\n` +
            'Alternative: if the user has word timings from another tool (a Whisper/ASR JSON file), use set_transcript with asr_file (and the script).' +
            (st && st.error ? `\nServer said: ${st.error}` : ''),
        };
      }
      const src = String(a.media || '').trim();
      const body = /^m_[A-Za-z0-9_-]+$/.test(src) && P.media && P.media[src] ? { mediaId: src } : { path: absPath(src, 'media') };
      if (a.model) body.model = a.model;
      if (a.language) body.language = String(a.language);
      if (a.captions) body.captions = { words: 'transcript', ...(a.caption_style ? { style: String(a.caption_style) } : {}) };
      body.by = 'claude';
      const job = await api.post(`/api/projects/${enc(P.id)}/transcribe`, body, { timeout: 60000, signal: C.signal });
      const r = await waitJob(job, C, 'תמלול · transcription');
      if (!r.done) return stillRunning(r.job, 'transcription');
      return transcriptResult(P.id, { ...r.job, captions: !!a.captions });
    },
  },
  {
    name: 'snapshot',
    title: 'See frames (snapshot)',
    description: `Render exact frames of the project, with the same renderer as the export, and RETURN THEM AS IMAGES so you can see your edit. Look at each one: text cut off or outside the safe area, wrong right-to-left word order, black frames, captions over faces, overlaps. Fix, then snapshot again.
times: up to ${MAX_IMAGES} times (seconds or refs like "word:<w>", "clip:s2:end", "end"). With more than ${MAX_IMAGES} times, or sheet:true, you get one contact sheet (max 30 frames). Good picks: 0.3, every cut, every text or caption, the key moment, and "end".`,
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        times: { type: 'array', items: S.time, minItems: 1, maxItems: 30, description: 'Frame times.' },
        sheet: { type: 'boolean', description: 'One contact-sheet image instead of separate frames.' },
        scale: { type: 'number', description: `Render scale 0.1–1. The default fits each frame in ${IMAGE_BOX} px. Lower = faster and smaller.` },
      },
      required: ['project', 'times'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P = await resolveProject(a.project);
      let times = a.times;
      if (typeof times === 'string' || typeof times === 'number') times = cutx.splitTimes(String(times)).map(cutx.parseTimeArg);
      if (!Array.isArray(times) || !times.length) throw new ToolError('חסרים זמנים', 'Give "times": e.g. [0.5, "word:hello", "end"].');
      times = times.flatMap((t) => (typeof t === 'string' && t.includes(',') ? cutx.splitTimes(t) : [t]))
        .slice(0, 30).map((t) => (typeof t === 'string' ? cutx.parseTimeArg(t) : t));
      const sheet = !!a.sheet || times.length > MAX_IMAGES;
      const W = (P.settings && P.settings.width) || 1080, H = (P.settings && P.settings.height) || 1920;
      const fit = Math.min(1, IMAGE_BOX / Math.max(W, H));
      const cell = sheet ? Math.min(1, (H >= W ? 360 : 640) / W) : fit;
      let scale = Number(a.scale);
      scale = Number.isFinite(scale) && scale > 0 ? Math.min(scale, sheet ? 1 : fit) : cell;
      scale = Math.max(0.1, Math.round(scale * 1000) / 1000);
      // "end" (= the project length) is one frame past the last picture: show the last frame instead of black
      const lastFrame = Math.max(0, projectDuration(P) - 1 / ((P.settings && P.settings.fps) || 30));
      times = times.map((t) => Math.min(Math.max(0, timeOf(P, t)), projectDuration(P) > 0 ? Math.round(lastFrame * 1e4) / 1e4 : Infinity));
      const job = await api.post(`/api/projects/${enc(P.id)}/snapshot`, { times, scale, sheet }, { signal: C.signal });
      const r = await waitJob(job, C, 'צילום פריימים · snapshot');
      if (!r.done) return stillRunning(r.job, 'snapshot');
      return { content: await snapshotContent(r.job, P, { sheet }) };
    },
  },
  {
    name: 'export_video',
    title: 'Export MP4',
    description: 'Export the project to an MP4 (H.264/AAC), loudness-normalized to -14 LUFS (true peak ≤ -1 dBTP). It also checks that the voice stays at least 12 dB above music + sfx. Returns the file path and the report. out = absolute file or folder path (default: the project\'s exports folder). from/to export only part. Long videos can take minutes: when it is still running, call wait_job. If the speech margin fails: balance_audio, then export again.',
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        out: { type: 'string', description: 'Absolute output file (.mp4) or folder. Optional.' },
        lufs: { type: 'number', description: 'Loudness target (default -14).' },
        from: S.time,
        to: S.time,
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P = await resolveProject(a.project);
      const empty = emptyProject(P);
      if (empty) throw new ToolError(empty.he, `${empty.en} Nothing was exported.`);
      const body = { check: true };
      if (a.out) body.out = absPath(a.out, 'out');
      if (a.lufs !== undefined) body.lufs = Number(a.lufs);
      if (a.from !== undefined) body.from = timeOf(P, a.from);
      if (a.to !== undefined) body.to = timeOf(P, a.to);
      const job = await api.post(`/api/projects/${enc(P.id)}/export`, body, { signal: C.signal });
      const r = await waitJob(job, C, 'ייצוא · export');
      if (!r.done) return stillRunning(r.job, 'export');
      return exportText(r.job);
    },
  },
  {
    name: 'check_audio',
    title: 'Check speech vs. background',
    description: 'Measure (audio only, fast) whether the voice-over stays at least 12 dB above music + sound effects in every 0.1 s speech window. Also reports the mix loudness. If it fails, run balance_audio.',
    inputSchema: { type: 'object', properties: { project: S.project }, required: ['project'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P = await resolveProject(a.project);
      const job = await api.post(`/api/projects/${enc(P.id)}/check-audio`, {}, { signal: C.signal });
      const r = await waitJob(job, C, 'בדיקת שמע · audio check');
      if (!r.done) return stillRunning(r.job, 'audio check');
      return audioText(r.job);
    },
  },
  {
    name: 'balance_audio',
    title: 'Fix speech vs. background',
    description: 'Automatically keep the voice-over audible. Wherever the voice is less than target dB (default 12) above music + sfx, it lowers only the guilty music/sfx clips, and only there (volume keyframes). Then it re-checks, round after round. The voice is never raised. Each round is one undo step. dry_run:true only shows the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        project: S.project,
        target: { type: 'number', description: 'Required margin in dB (default 12).' },
        dry_run: { type: 'boolean', description: 'Only show what would change.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const P = await resolveProject(a.project);
      const target = a.target !== undefined ? Number(a.target) : 12;
      if (!Number.isFinite(target)) throw new ToolError('target חייב להיות מספר', '"target" must be a number (dB).');
      return balance(P.id, { target, dry: !!a.dry_run }, C);
    },
  },
  {
    name: 'undo',
    title: 'Undo',
    description: 'Undo the last edit in a project (yours or the user\'s; the user sees it too). Up to 300 steps.',
    inputSchema: { type: 'object', properties: { project: S.project }, required: ['project'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a) { return undoRedo(a, 'undo'); },
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redo the last edit that was undone in a project (with undo, or by the user in the editor).',
    inputSchema: { type: 'object', properties: { project: S.project }, required: ['project'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(a) { return undoRedo(a, 'redo'); },
  },
  {
    name: 'wait_job',
    title: 'Wait for a running job',
    description: 'Keep waiting for an export, snapshot, audio check or transcription that was still running when its tool returned. Returns the finished result, or "still running" again (then call it again).',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string', description: 'The job id from the "still running" message.' } }, required: ['job_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a, C) {
      await ensureServer();
      const id = String(a.job_id || '').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ToolError('מזהה משימה לא תקין', 'Invalid job_id.');
      let job;
      try { job = await api.get(`/api/jobs/${enc(id)}`); } catch (e) {
        if (e.status !== 404) throw e;
        throw new ToolError(`לא נמצאה משימה בשם "${id}"`, `No job "${id}". Use the exact job_id from the "still running" message. Jobs are kept only while the Frame Studio server runs: if it restarted, run the export / snapshot / check again.`);
      }
      const type = String(job.type || '');
      const label = { export: 'export', snapshot: 'snapshot', audio: 'audio check', transcribe: 'transcription' }[type] || 'job';
      const r = await waitJob(job, C, label);
      if (!r.done) return stillRunning(r.job, label);
      const j = r.job;
      if (type === 'snapshot') {
        let P = null;
        try { P = await api.get(`/api/projects/${enc(j.projectId)}`); } catch { /* deleted */ }
        return { content: await snapshotContent(j, P, { sheet: !!j.sheet }) };
      }
      if (type === 'export') return exportText(j);
      if (type === 'audio') return audioText(j);
      if (type === 'transcribe' && j.projectId) return transcriptResult(j.projectId, j);
      return `✓ Job ${id} finished.\n${cutx.formatReport(j.report || {})}`;
    },
  },
  {
    name: 'get_editing_guide',
    title: 'Editing guide',
    description: 'How to edit well in Frame Studio. With no topic, it returns the condensed guide: the model, time references, the most used ops with examples, sound and caption rules, and the list of reference sections. Call it once before your first edit. topic = an op name (e.g. "addCaptions", "setKeyframes") for its fields and an example, a section number (e.g. "4.9"), or a word (e.g. "captions", "transitions", "keyframes", "recipe").',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Optional op name, section number or keyword.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(a) {
      const topic = String(a.topic || '').trim();
      if (!topic) return `${guide.GUIDE}${guide.docToc()}\n\n(Full reference as an MCP resource: frame-studio://docs/claude-api)`;
      const parts = [];
      const h = OPS_HELP.find((x) => x.op.toLowerCase() === topic.toLowerCase());
      if (h) {
        parts.push(`op "${h.op}" — ${h.he}\nfields: ${h.fields}\nexample: ${JSON.stringify(h.example)}`);
        const sec = guide.sectionForOp(h.op);
        if (sec) parts.push(`From the reference, "${sec.title}":\n${sec.text}`);
      } else {
        for (const s of guide.findSections(topic)) parts.push(s.text);
      }
      if (!parts.length) {
        const near = OPS_HELP.filter((x) => x.op.toLowerCase().includes(topic.toLowerCase())).map((x) => x.op);
        return `Nothing found for "${topic}".${near.length ? ` Ops with that name: ${near.join(', ')}.` : ''}\nSections:\n${guide.docToc()}`;
      }
      return parts.join('\n\n---\n\n');
    },
  },
];

async function undoRedo(a, which) {
  await ensureServer();
  const P = await resolveProject(a.project);
  const r = await api.post(`/api/projects/${enc(P.id)}/${which}`, { by: 'claude' });
  const hist = await api.get(`/api/projects/${enc(P.id)}/history`).catch(() => null);
  const nextUndo = hist && hist.undo && hist.undo.length ? hist.undo[hist.undo.length - 1].summary : null;
  return `${which === 'undo' ? '↶ Undone' : '↷ Redone'} · revision ${r.rev}${nextUndo ? ` · next undo would revert: "${nextUndo}"` : ''}`;
}

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ───────────────────────────── argument validation (the JSON-schema subset the tools use) ─────────────────────────────

function typeOk(v, s) {
  if (s.anyOf) return s.anyOf.some((x) => typeOk(v, x));
  switch (s.type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

// Common misspellings of argument names → the real name (used only when the real one is a property of that tool and
// was not given too). camelCase → snake_case (dryRun → dry_run, jobId → job_id, minDuration → min_duration) is automatic.
const ARG_ALIASES = {
  projectId: 'project', project_id: 'project', projectName: 'project', project_name: 'project',
  path: 'paths', file: 'paths', files: 'paths', file_paths: 'paths', filePaths: 'paths',
  output: 'out', output_path: 'out', outputPath: 'out', out_path: 'out', outPath: 'out', outFile: 'out', out_file: 'out',
  dry: 'dry_run', dryrun: 'dry_run', job: 'job_id', jobid: 'job_id', id: 'job_id',
  mediaId: 'media_id', asrFile: 'asr_file', captionStyle: 'caption_style', q: 'query',
};
const snakeCase = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();

/**
 * Light coercion ("1.5" → 1.5, "true" → true, a JSON string for an array) + checks → {args, notes}, or throws ToolError.
 * With additionalProperties:false an unknown argument is an error (a typo must never silently change what a tool does,
 * e.g. balance_audio {dryRun:true} running a REAL balance); obvious aliases are renamed and reported in `notes`.
 */
function validateArgs(tool, args) {
  const sch = tool.inputSchema || {};
  const a = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) };
  const props = sch.properties || {};
  const notes = [];
  const unknown = [];
  for (const k of Object.keys(a)) {
    if (Object.hasOwn(props, k)) continue;
    if (a[k] === undefined || a[k] === null) { delete a[k]; continue; }
    const to = [ARG_ALIASES[k], snakeCase(k), String(k).toLowerCase()].find((c) => c && c !== k && Object.hasOwn(props, c));
    if (to && (a[to] === undefined || a[to] === null)) {
      a[to] = a[k];
      delete a[k];
      notes.push(`"${k}" was read as "${to}"`);
    } else unknown.push(k);
  }
  if (unknown.length && sch.additionalProperties === false) {
    const allowed = Object.keys(props);
    throw new ToolError(`פרמטר לא מוכר: ${unknown.join(', ')}`,
      `Unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} for ${tool.name}. ` +
      `${allowed.length ? `Allowed: ${allowed.join(', ')}.` : 'This tool takes no arguments.'} Nothing was done: call it again with the right names.`);
  }
  for (const [k, p] of Object.entries(props)) {
    let v = a[k];
    if (v === undefined || v === null) { delete a[k]; continue; }
    if (p.type === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
    if (p.type === 'boolean' && typeof v === 'string' && /^(true|false)$/i.test(v)) v = /^true$/i.test(v);
    if (p.type === 'array' && typeof v === 'string') { const s = v.trim(); if (s.startsWith('[')) { try { v = JSON.parse(s); } catch { /* checked below */ } } else if (k !== 'ops') v = [v]; }
    if (p.type === 'string' && typeof v === 'number') v = String(v);
    a[k] = v;
    if (k === 'ops') continue; // apply_ops is lenient about its shape and checks it itself
    if (!typeOk(v, p)) throw new ToolError(`פרמטר לא תקין: ${k}`, `Invalid argument "${k}": expected ${p.type || 'a different type'}.`);
    if (p.enum && !p.enum.includes(v)) throw new ToolError(`ערך לא תקין ל-${k}: ${v}`, `Invalid "${k}": ${JSON.stringify(v)}. Allowed: ${p.enum.join(', ')}.`);
  }
  for (const k of sch.required || []) {
    if (a[k] === undefined || a[k] === '') throw new ToolError(`חסר פרמטר: ${k}`, `Missing required argument "${k}".`);
  }
  return { args: a, notes };
}

// ───────────────────────────── resources & prompts ─────────────────────────────

const RESOURCES = [
  { uri: 'frame-studio://docs/claude-api', name: 'claude-api', title: 'Frame Studio editing reference', description: 'The full reference: every op and field, time references, catalog ids, sound library, recipes, troubleshooting (Hebrew + English).', mimeType: 'text/markdown', file: path.join(ROOT, 'docs', 'CLAUDE-API.md') },
  { uri: 'frame-studio://docs/mcp', name: 'mcp', title: 'Frame Studio with Claude (MCP setup)', description: 'How the Claude integration works and how to set it up / troubleshoot it.', mimeType: 'text/markdown', file: path.join(ROOT, 'docs', 'MCP.md') },
];

const PROMPTS = [
  {
    name: 'edit_video',
    title: 'Edit a video in Frame Studio',
    description: 'Start an editing session: Claude creates or opens a project, imports your files, edits while you watch, checks the frames and exports.',
    arguments: [
      { name: 'request', description: 'What you want (e.g. "a 30 s TikTok from these clips with captions and a whoosh on every cut").', required: true },
      { name: 'files', description: 'Optional: full paths of your video / audio / image files, one per line.', required: false },
    ],
    build: (a) => `I want to edit a video in Frame Studio.\n\nRequest: ${a.request || ''}\n${a.files ? `\nMy files:\n${a.files}\n` : ''}\n` +
      'Please: 1) frame_studio_status and get_editing_guide, 2) create (or find) the project and open_editor so I can watch, 3) import my files, ' +
      '4) edit with apply_ops in small steps with a short summary each, 5) snapshot and actually look at the frames, fix what looks off, ' +
      '6) export_video and tell me the file path and the report. Ask me if something important is unclear (format, length, style).',
  },
];

// ───────────────────────────── JSON-RPC over stdio ─────────────────────────────

let clientInfo = {};
let protocolVersion = PROTOCOLS[1];
const inflight = new Map(); // request id → AbortController

function send(msg) {
  const line = JSON.stringify(msg).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  try { process.stdout.write(line + '\n'); } catch (e) { log('stdout write failed:', e.message); }
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

function budgetMs() {
  const env = Number(process.env.FRAME_STUDIO_MCP_WAIT);
  if (Number.isFinite(env) && env > 0) return env * 1000;
  // Claude Desktop (and most clients) give a tool call about 60 s; Claude Code waits much longer.
  return /claude-code/i.test(String(clientInfo.name || '')) ? 240000 : 45000;
}

function callContext(id, params) {
  const ac = new AbortController();
  inflight.set(id, ac);
  const t0 = Date.now();
  const budget = budgetMs();
  const token = params && params._meta && params._meta.progressToken;
  let last = -1;
  return {
    signal: ac.signal,
    left: () => budget - (Date.now() - t0),
    progress: (pct, message) => {
      if (token === undefined || token === null || !(pct > last)) return;
      last = pct;
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: pct, total: 100, ...(message ? { message } : {}) } });
    },
    done: () => inflight.delete(id),
  };
}

function normalizeResult(r) {
  if (r && typeof r === 'object' && Array.isArray(r.content)) return { content: r.content, isError: !!r.isError };
  if (r && typeof r === 'object' && typeof r.text === 'string') return { content: [text(r.text)], isError: !!r.isError };
  return { content: [text(typeof r === 'string' ? r : JSON.stringify(r, null, 1))], isError: false };
}

async function handleRequest(msg) {
  const { id, method } = msg;
  const params = msg.params || {};
  switch (method) {
    case 'initialize': {
      clientInfo = params.clientInfo || {};
      const asked = String(params.protocolVersion || '');
      protocolVersion = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
      log(`initialize from ${clientInfo.name || '?'} ${clientInfo.version || ''} (protocol ${asked || '?'} → ${protocolVersion})`);
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'frame-studio', title: 'Frame Studio', version: VERSION },
        instructions: guide.INSTRUCTIONS,
      });
    }
    case 'ping': return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case 'tools/call': {
      const tool = TOOL_MAP.get(params.name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params.name}`);
      const C = callContext(id, params);
      const t0 = Date.now();
      let result;
      try {
        const { args, notes } = validateArgs(tool, params.arguments);
        result = normalizeResult(await tool.run(args, C));
        if (notes.length) result.content.push(text(`(Note: argument ${notes.join(', ')}. Use the exact names from the tool schema.)`));
      } catch (e) {
        if (C.signal.aborted) { C.done(); log(`${tool.name} cancelled`); return undefined; }
        const known = e instanceof ToolError;
        if (!known) log(`${tool.name} crashed:`, e && e.stack ? e.stack : String(e));
        result = { content: [text(`✗ ${known ? e.message : `שגיאה פנימית · Internal error: ${e && e.message ? e.message : e}`}`)], isError: true };
      }
      C.done();
      if (C.signal.aborted) return undefined;
      log(`${tool.name} ${result.isError ? 'failed' : 'ok'} in ${Date.now() - t0} ms`);
      return reply(id, result);
    }
    case 'resources/list':
      return reply(id, { resources: RESOURCES.filter((r) => fs.existsSync(r.file)).map(({ file, ...r }) => r) });
    case 'resources/templates/list': return reply(id, { resourceTemplates: [] });
    case 'resources/read': {
      const r = RESOURCES.find((x) => x.uri === params.uri);
      if (!r || !fs.existsSync(r.file)) return replyError(id, -32002, `Resource not found: ${params.uri}`, { uri: params.uri });
      return reply(id, { contents: [{ uri: r.uri, mimeType: r.mimeType, text: fs.readFileSync(r.file, 'utf8').replace(/^\uFEFF/, '') }] });
    }
    case 'prompts/list':
      return reply(id, { prompts: PROMPTS.map(({ build, ...p }) => p) });
    case 'prompts/get': {
      const p = PROMPTS.find((x) => x.name === params.name);
      if (!p) return replyError(id, -32602, `Unknown prompt: ${params.name}`);
      const a = params.arguments || {};
      for (const arg of p.arguments) if (arg.required && !a[arg.name]) return replyError(id, -32602, `Missing argument: ${arg.name}`);
      return reply(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.build(a) } }] });
    }
    case 'logging/setLevel': return reply(id, {});
    case 'completion/complete': return reply(id, { completion: { values: [], total: 0, hasMore: false } });
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(msg) {
  if (msg.method === 'notifications/cancelled') {
    const rid = msg.params && msg.params.requestId;
    const ac = inflight.get(rid);
    if (ac) { ac.abort(); inflight.delete(rid); }
  }
  // notifications/initialized, notifications/roots/list_changed, … need no answer
}

function dispatch(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    if (msg && msg.id !== undefined) replyError(msg.id ?? null, -32600, 'Invalid Request');
    return;
  }
  if (typeof msg.method !== 'string') return; // a response to something we never send
  if (msg.id === undefined || msg.id === null) { handleNotification(msg); return; }
  Promise.resolve().then(() => handleRequest(msg)).catch((e) => {
    log('request failed:', e && e.stack ? e.stack : String(e));
    replyError(msg.id, -32603, `Internal error: ${e && e.message ? e.message : e}`);
  });
}

function onLine(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { replyError(null, -32700, 'Parse error'); return; }
  if (Array.isArray(msg)) { for (const m of msg) dispatch(m); return; } // 2025-03-26 batches
  dispatch(msg);
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  let nl;
  while ((nl = pending.indexOf(0x0a)) >= 0) {
    const line = pending.subarray(0, nl);
    pending = pending.subarray(nl + 1);
    onLine(line);
  }
});
process.stdin.on('end', () => {
  if (pending.length) onLine(pending);
  log('stdin closed, exiting');
  // let in-flight replies flush, then leave (the Frame Studio server keeps running for the editor)
  setTimeout(() => process.exit(0), inflight.size ? 1500 : 100).unref();
});
process.on('uncaughtException', (e) => log('uncaught:', e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e && e.stack ? e.stack : String(e)));
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

log(`Frame Studio MCP ${VERSION} ready · server ${BASE} · folder ${ROOT}`);
