// Frame Studio — local HTTP server (SPEC §5): static files with Range, JSON API, SSE live sync,
// project store with atomic saves and a 300-step snapshot undo/redo, media import pipeline, upload,
// local transcription jobs, and mounting of server/library.mjs + server/export.mjs.
//
//   node server/main.mjs [--port 7788]
//
// Everything runs offline on 127.0.0.1. Paths may contain Hebrew and spaces: child processes always get args arrays.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import util from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import * as media from './media.mjs';
import * as appConfig from './config.mjs';
import { findChrome as findBrowser, openUrlCommand } from './config.mjs';
import { transcribeFile, asrStatus } from './asr.mjs';

// ---------------------------------------------------------------- paths, config, logging

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SERVER_DIR, '..');
// user data: <dataDir>/projects (dataDir = ROOT for a git clone; the installed app uses Documents/Frame Studio — server/config.mjs)
export const DATA_DIR = typeof appConfig.dataDir === 'function' ? appConfig.dataDir() : ROOT;
const PROJECTS = path.join(DATA_DIR, 'projects');
const TRASH = path.join(PROJECTS, '.trash');
const LOG_FILE = path.join(ROOT, 'server.log');
const MAX_HISTORY = 300;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
export const PORT = Number(argValue('--port') || process.env.FRAME_STUDIO_PORT || 7788);
let VERSION = '1.0.0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || VERSION; } catch { /* default */ }

fs.mkdirSync(PROJECTS, { recursive: true });
try {
  const st = fs.statSync(LOG_FILE);
  if (st.size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, path.join(ROOT, 'server.old.log'));
} catch { /* no log yet */ }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.on('error', () => {});

export function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 160 }))).join(' ');
  try { process.stdout.write(line + '\n'); } catch { /* detached */ }
  logStream.write(line + '\n');
}

// ---------------------------------------------------------------- HTTP helpers

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const NEXT = Symbol.for('frame-studio.next-route');

export function sendJson(res, code, obj) {
  if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
  const body = JSON.stringify(obj === undefined ? null : obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Read the whole request body → Buffer (limit bytes, default 1.5 GB) */
export function readBody(req, limit = 1.5 * 1024 * 1024 * 1024) {
  if (req._fsBody) return Promise.resolve(req._fsBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'גוף הבקשה גדול מדי')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { req._fsBody = Buffer.concat(chunks); resolve(req._fsBody); });
    req.on('error', reject);
  });
}

/** Read a JSON body → object ({} when empty) */
export async function readJson(req) {
  const buf = await readBody(req, 256 * 1024 * 1024);
  const txt = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { throw new HttpError(400, 'גוף הבקשה אינו JSON תקין'); }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const stripBom = (s) => s.replace(/^\uFEFF/, '');
const nowIso = () => new Date().toISOString();
const rand = (n = 8) => {
  const a = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += (a[i] % 36).toString(36);
  return s;
};
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function normalizeInputPath(p) {
  let s = String(p || '').trim().replace(/^["']+|["']+$/g, '');
  if (/^file:\/\//i.test(s)) { try { s = fileURLToPath(s); } catch { /* keep */ } }
  if (!s) throw new HttpError(400, 'נתיב קובץ ריק');
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(ROOT, s);
}
const pathKey = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const normBy = (by) => (by === 'claude' ? 'claude' : 'user');

// ---------------------------------------------------------------- shared modules (model.js / ops.js) — loaded dynamically

const moduleSlots = {
  model: { label: 'shared/model.js', url: process.env.FRAME_STUDIO_MODEL ? pathToFileURL(path.resolve(process.env.FRAME_STUDIO_MODEL)).href : pathToFileURL(path.join(ROOT, 'shared', 'model.js')).href },
  ops: { label: 'shared/ops.js', url: process.env.FRAME_STUDIO_OPS ? pathToFileURL(path.resolve(process.env.FRAME_STUDIO_OPS)).href : pathToFileURL(path.join(ROOT, 'shared', 'ops.js')).href },
};
for (const s of Object.values(moduleSlots)) Object.assign(s, { mod: null, err: null, at: 0, attempt: 0, loading: null });

async function need(name) {
  const s = moduleSlots[name];
  if (s.mod) return s.mod;
  if (!s.loading && (!s.err || Date.now() - s.at > 3000)) {
    const url = s.attempt++ ? `${s.url}?retry=${Date.now()}` : s.url;
    s.loading = import(url)
      .then((m) => { s.mod = m; s.err = null; log(`נטען ${s.label}`); })
      .catch((e) => { s.err = e; s.at = Date.now(); log(`שגיאה בטעינת ${s.label}:`, e && e.stack ? e.stack : String(e)); })
      .finally(() => { s.loading = null; });
  }
  if (s.loading) await s.loading;
  if (s.mod) return s.mod;
  throw new HttpError(503, `${s.label} לא נטען: ${s.err ? s.err.message : 'לא ידוע'}`);
}
const tryModel = async () => { try { return await need('model'); } catch { return null; } };

function newId(prefix, taken) {
  for (;;) {
    let id;
    const M = moduleSlots.model.mod;
    try { id = M && typeof M.uid === 'function' ? M.uid(prefix) : prefix + rand(8); } catch { id = prefix + rand(8); }
    if (!taken || !taken[id]) return id;
  }
}

function projectDuration(p) {
  const M = moduleSlots.model.mod;
  if (M && typeof M.projectDuration === 'function') { try { return M.projectDuration(p); } catch { /* fall through */ } }
  let d = 0;
  for (const c of Object.values(p.clips || {})) d = Math.max(d, (+c.start || 0) + (+c.duration || 0));
  return d;
}

// ---------------------------------------------------------------- project store

const store = new Map(); // id → { project, undo:[], redo:[] }
const locks = new Map();

export const projectDir = (id) => path.join(PROJECTS, id);
const projectFile = (id) => path.join(projectDir(id), 'project.json');
export const validId = (id) => typeof id === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id);

function checkId(id) {
  if (!validId(id)) throw new HttpError(400, `מזהה פרויקט לא תקין: ${id} (אותיות לטיניות קטנות, ספרות ומקפים)`);
  return id;
}

/**
 * Ids a new project may not take: folder names the app's machine caches use when the cache folder is the projects
 * folder itself (developer layout: config cacheDir() === <data>/projects → sounds/ holds the sound index + peaks).
 */
const CACHE_FOLDER_NAMES = new Set(['sounds', 'peaks', 'cache', 'index']);
function reservedId(id) {
  if (!CACHE_FOLDER_NAMES.has(id)) return false;
  try {
    const c = typeof appConfig.cacheDir === 'function' ? appConfig.cacheDir() : null;
    return !!c && path.resolve(c).toLowerCase() === path.resolve(PROJECTS).toLowerCase();
  } catch { return false; }
}
/** True when <projects>/<id> is taken — by a project, a reserved cache name, or any other folder. */
function idTaken(id) { return reservedId(id) || fs.existsSync(projectDir(id)); }

/** serialize all mutations of one project */
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

function normalizeProject(p, id) {
  p.id = id;
  if (!Number.isFinite(p.rev)) p.rev = 0;
  if (!p.media || typeof p.media !== 'object') p.media = {};
  if (!Array.isArray(p.tracks)) p.tracks = [];
  if (!p.clips || typeof p.clips !== 'object') p.clips = {};
  if (!Array.isArray(p.markers)) p.markers = [];
  if (!p.meta || typeof p.meta !== 'object') p.meta = {};
  return p;
}

function readProjectFile(id) {
  let txt;
  try { txt = fs.readFileSync(projectFile(id), 'utf8'); } catch { return null; }
  try { return normalizeProject(JSON.parse(stripBom(txt)), id); } catch (e) {
    throw new HttpError(500, `קובץ הפרויקט פגום (${id}/project.json): ${e.message}`);
  }
}

function getEntry(id) {
  checkId(id);
  let e = store.get(id);
  if (e) return e;
  const p = readProjectFile(id);
  if (!p) throw new HttpError(404, `הפרויקט "${id}" לא נמצא`);
  e = { project: p, undo: [], redo: [] };
  store.set(id, e);
  // media left "processing" by a previous run → resume
  setImmediate(() => {
    for (const m of Object.values(p.media || {})) if (m && m.status === 'processing') startDerivatives(id, m.id);
  });
  return e;
}

/** current project (internal, treat as immutable) */
export function loadProject(id) { return getEntry(id).project; }

function writeProjectFile(p) {
  const dir = projectDir(p.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = projectFile(p.id);
  const tmp = `${file}.${process.pid}.${rand(4)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw new HttpError(500, `שמירת הפרויקט נכשלה: ${e.message}`);
      }
      sleepSync(25 * (i + 1));
    }
  }
}

const pack = (p) => zlib.deflateRawSync(Buffer.from(JSON.stringify(p)), { level: 1 });
const unpack = (b) => JSON.parse(zlib.inflateRawSync(b).toString('utf8'));
const histInfo = (e) => ({
  undo: e.undo.length, redo: e.redo.length,
  undoSummary: e.undo.length ? e.undo[e.undo.length - 1].summary : null,
  redoSummary: e.redo.length ? e.redo[e.redo.length - 1].summary : null,
});
const contentKey = (p) => JSON.stringify({ ...p, rev: 0, meta: null });

/**
 * Commit a new version of a project: rev++, meta.modified, atomic save, optional history push, broadcast.
 * by: "user"|"claude"|"system" ("system" keeps meta.lastEditor)
 */
function commit(id, prev, next, { by = 'user', summary = '', history = true, broadcastEvent = true } = {}) {
  const e = getEntry(id);
  const t = nowIso();
  const lastEditor = by === 'user' || by === 'claude' ? by : (prev.meta && prev.meta.lastEditor) || 'user';
  const out = normalizeProject({ ...next, rev: (prev.rev || 0) + 1, meta: { ...(next.meta || {}), modified: t, lastEditor } }, id);
  writeProjectFile(out);
  if (history) {
    // media removed by this step (removeMedia op / DELETE media): a redo must remove it again (see undoRedo)
    const removed = Object.keys(prev.media || {}).filter((k) => !(out.media || {})[k]);
    e.undo.push({ data: pack(prev), summary: summary || 'עריכה', by, rev: prev.rev, time: t, mediaRemoved: removed.length ? removed : undefined });
    if (e.undo.length > MAX_HISTORY) e.undo.splice(0, e.undo.length - MAX_HISTORY);
    e.redo.length = 0;
  }
  e.project = out;
  if (broadcastEvent) broadcast(id, { type: 'project', rev: out.rev, by, summary, project: out, history: histInfo(e) });
  return out;
}

const OP_LABELS = {
  setSettings: 'הגדרות פרויקט', addTrack: 'הוספת ערוץ', updateTrack: 'עדכון ערוץ', removeTrack: 'מחיקת ערוץ', moveTrack: 'הזזת ערוץ',
  addClip: 'הוספת קליפ', updateClip: 'עדכון קליפ', removeClip: 'מחיקת קליפ', moveClip: 'הזזת קליפ', trimClip: 'קיצור קליפ',
  splitClip: 'פיצול קליפ', duplicateClip: 'שכפול קליפ', setKeyframe: 'קיפריים', removeKeyframe: 'מחיקת קיפריים',
  clearKeyframes: 'ניקוי קיפריימים', setTransition: 'מעבר', removeTransition: 'הסרת מעבר', addEffect: 'הוספת אפקט',
  updateEffect: 'עדכון אפקט', removeEffect: 'הסרת אפקט', addCaptions: 'כתוביות', setTranscript: 'תמלול', addMarker: 'סמן',
  removeMarker: 'מחיקת סמן', rippleDelete: 'מחיקה מגלגלת', insertGap: 'הוספת רווח', removeClips: 'מחיקת קליפים', sfx: 'אפקט קולי',
};
function autoSummary(ops, results) {
  const labels = [];
  ops.forEach((o, i) => {
    if (!o || (results[i] && results[i].ok === false)) return;
    const l = OP_LABELS[o.op] || o.op;
    if (l && !labels.includes(l)) labels.push(l);
  });
  if (!labels.length) return 'עריכה';
  const n = ops.length;
  return (n > 1 ? `${n} פעולות: ` : '') + labels.slice(0, 4).join(', ') + (labels.length > 4 ? '…' : '');
}

const HEB2LAT = { 'א': 'a', 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z', 'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': 'a', 'פ': 'p', 'ף': 'f', 'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't' };
export function slugify(s) {
  const t = String(s || '').toLowerCase().replace(/[\u0591-\u05C7]/g, '').replace(/[א-ת]/g, (c) => HEB2LAT[c] || '');
  return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}
export function uniqueId(base) {
  let b = slugify(base) || 'project';
  if (!/^[a-z0-9]/.test(b)) b = 'p-' + b;
  if (!idTaken(b)) return b;
  for (let n = 2; ; n++) { const id = `${b}-${n}`.slice(0, 64); if (!idTaken(id)) return id; }
}

function ensureProjectDirs(id) {
  const d = projectDir(id);
  for (const sub of ['media', 'cache/proxy', 'cache/audio', 'cache/peaks', 'cache/thumbs', 'exports', 'snapshots']) fs.mkdirSync(path.join(d, sub), { recursive: true });
}

/** create a new project on disk (rev 0) */
async function createProject({ id, name, width, height, fps, tracks = 'default', by = 'user' } = {}) {
  const M = await need('model');
  name = String(name || '').trim() || 'פרויקט חדש';
  id = id ? checkId(String(id)) : uniqueId(name);
  if (reservedId(id)) throw new HttpError(409, `המזהה "${id}" שמור לתיקייה פנימית של Frame Studio — בחרו מזהה אחר`);
  if (fs.existsSync(projectDir(id)) && !fs.existsSync(projectFile(id))) {
    throw new HttpError(409, `בתיקיית הפרויקטים כבר יש תיקייה בשם "${id}" שאינה פרויקט — בחרו מזהה אחר`);
  }
  if (fs.existsSync(projectDir(id))) throw new HttpError(409, `כבר קיים פרויקט עם המזהה "${id}"`);
  const W = width != null ? Math.round(+width) : undefined, H = height != null ? Math.round(+height) : undefined, F = fps != null ? +fps : undefined;
  if (W != null && !(W >= 16 && W <= 8192)) throw new HttpError(400, 'רוחב לא תקין (16–8192)');
  if (H != null && !(H >= 16 && H <= 8192)) throw new HttpError(400, 'גובה לא תקין (16–8192)');
  if (F != null && !(F >= 1 && F <= 240)) throw new HttpError(400, 'קצב פריימים לא תקין');
  const args = { id, name };
  if (W) args.width = W; if (H) args.height = H; if (F) args.fps = F;
  let p = M.newProject(args);
  p = normalizeProject(p, id);
  p.name = name;
  p.settings = { ...(p.settings || {}) };
  if (W) p.settings.width = W; if (H) p.settings.height = H; if (F) p.settings.fps = F;
  if (tracks === 'empty') { p.tracks = []; p.clips = {}; }
  else if (!p.tracks.length && typeof M.DEFAULT_TRACKS === 'function') {
    p.tracks = M.DEFAULT_TRACKS().map((t) => (t && t.id ? t : (typeof M.newTrack === 'function' ? M.newTrack(t.kind, t) : { id: newId('t_'), ...t })));
  }
  p.rev = 0;
  const t = nowIso();
  p.meta = { ...(p.meta || {}), created: (p.meta && p.meta.created) || t, modified: t, lastEditor: normBy(by) };
  ensureProjectDirs(id);
  writeProjectFile(p);
  store.set(id, { project: p, undo: [], redo: [] });
  log(`נוצר פרויקט ${id} ("${name}") ${p.settings.width}x${p.settings.height}@${p.settings.fps}`);
  broadcast(null, { type: 'projects', action: 'created', projectId: id });
  return p;
}

function summarizeProject(p) {
  const s = p.settings || {};
  const firstVisual = Object.values(p.media || {}).find((m) => m && (m.kind === 'video' || m.kind === 'image') && m.thumbs);
  return {
    id: p.id, name: p.name, width: s.width, height: s.height, fps: s.fps,
    duration: Math.round(projectDuration(p) * 1000) / 1000,
    modified: p.meta && p.meta.modified, created: p.meta && p.meta.created, lastEditor: p.meta && p.meta.lastEditor,
    clipCount: Object.keys(p.clips || {}).length, mediaCount: Object.keys(p.media || {}).length, rev: p.rev,
    cover: firstVisual ? `/api/projects/${p.id}/media/${firstVisual.id}/thumb?t=${firstVisual.kind === 'video' ? Math.min(1, firstVisual.duration / 2 || 0) : 0}` : null,
  };
}

async function listProjects() {
  await tryModel();
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS, { withFileTypes: true }); } catch { /* none */ }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.') || !validId(d.name)) continue;
    try {
      const p = store.has(d.name) ? store.get(d.name).project : readProjectFile(d.name);
      if (p) out.push(summarizeProject(p));
    } catch (e) { out.push({ id: d.name, name: d.name, error: e.message }); }
  }
  out.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')));
  return out;
}

// ---------------------------------------------------------------- media registration / derivatives

function sanitizeFileName(name) {
  let n = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 160);
  if (!n) n = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n;
}
function uniqueFileIn(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let f = path.join(dir, name);
  for (let n = 2; fs.existsSync(f); n++) f = path.join(dir, `${stem}-${n}${ext}`);
  return f;
}

async function copyIntoProject(id, abs) {
  const dir = path.join(projectDir(id), 'media');
  await fsp.mkdir(dir, { recursive: true });
  const name = sanitizeFileName(path.basename(abs));
  const same = path.join(dir, name);
  const st = await fsp.stat(abs);
  const st2 = await fsp.stat(same).catch(() => null);
  if (st2 && st2.size === st.size) return same;
  const dst = uniqueFileIn(dir, name);
  await fsp.copyFile(abs, dst);
  return dst;
}

/** add a file to draft.project.media (dedupe by path). Throws Error with a Hebrew message. */
async function registerPath(id, draft, p, { copy = false, library, name } = {}) {
  let abs = normalizeInputPath(p);
  if (!isFile(abs)) throw new Error(`הקובץ לא נמצא: ${abs}`);
  if (copy && !isInside(abs, projectDir(id))) abs = await copyIntoProject(id, abs);
  const key = pathKey(abs);
  const existing = Object.values(draft.project.media).find((m) => m && m.path && pathKey(m.path) === key);
  if (existing) {
    if (existing.status === 'error') draft.requeue.add(existing.id);
    if (library && !existing.library) { draft.project.media[existing.id] = { ...existing, library }; return draft.project.media[existing.id]; }
    return existing;
  }
  const mid = newId('m_', draft.project.media);
  const m = await media.mediaFromFile(abs, { id: mid, name });
  if (library) m.library = library;
  draft.project.media[mid] = m;
  draft.added.push(m);
  return m;
}

const makeDraft = (cur) => ({ project: { ...cur, media: { ...(cur.media || {}) } }, added: [], requeue: new Set() });

/**
 * Import paths into a project (outside of an ops batch). Not an undo step.
 * → { media:[Media|null in input order], errors:[{path,error}] }
 */
async function importInternal(id, paths, { copy = false, by = 'user' } = {}) {
  if (!Array.isArray(paths)) paths = paths ? [paths] : [];
  if (!paths.length) throw new HttpError(400, 'לא נבחרו קבצים לייבוא');
  const r = await withLock(id, async () => {
    const cur = loadProject(id);
    const draft = makeDraft(cur);
    const list = [], errors = [];
    for (const p of paths) {
      try { list.push(await registerPath(id, draft, p, { copy })); } catch (e) { list.push(null); errors.push({ path: String(p), error: e.message }); }
    }
    let project = cur;
    if (contentKey(cur) !== contentKey(draft.project)) {
      const n = draft.added.length;
      project = commit(id, cur, draft.project, { by: normBy(by), summary: n ? `ייבוא ${n === 1 ? 'קובץ' : n + ' קבצים'}` : 'עדכון מדיה', history: false });
    }
    return { list: list.map((m) => (m ? project.media[m.id] || m : null)), errors, toStart: [...draft.added.map((m) => m.id), ...draft.requeue] };
  });
  for (const mid of r.toStart) startDerivatives(id, mid);
  if (r.errors.length) log(`ייבוא ל-${id}: ${r.errors.length} שגיאות`, r.errors);
  return { media: r.list, errors: r.errors };
}

const runningDerivs = new Set();
const thumbCounts = new Map();

function startDerivatives(id, mid) {
  const key = `${id}/${mid}`;
  if (runningDerivs.has(key)) return;
  runningDerivs.add(key);
  (async () => {
    let m;
    try { m = loadProject(id).media[mid]; } catch { return; }
    if (!m) return;
    if (m.status !== 'processing') m = (await patchMedia(id, mid, { status: 'processing', error: undefined })) || m;
    const jobBase = { id: `media_${mid}`, type: 'media', projectId: id, mediaId: mid, name: m.name };
    broadcast(id, { type: 'job', job: { ...jobBase, status: 'running', state: 'running', stage: 'start', label: 'מכין מדיה', progress: 0 } });
    let patch;
    const t0 = Date.now();
    try {
      patch = await media.ensureDerivatives(projectDir(id), m, (p) => {
        broadcast(id, { type: 'job', job: { ...jobBase, status: 'running', state: 'running', stage: p.stage, label: p.label, progress: p.progress } });
      });
    } catch (e) { patch = { status: 'error', error: e.message }; }
    thumbCounts.delete(key);
    const nm = await patchMedia(id, mid, patch);
    const ok = patch.status === 'ready';
    log(`מדיה ${mid} (${m.name}) בפרויקט ${id}: ${ok ? 'מוכנה' : 'שגיאה — ' + patch.error} (${((Date.now() - t0) / 1000).toFixed(1)} ש')`);
    broadcast(id, { type: 'job', job: { ...jobBase, status: ok ? 'done' : 'error', state: ok ? 'done' : 'error', stage: 'done', label: ok ? 'מוכן' : 'שגיאה', progress: 1, error: ok ? undefined : patch.error, media: nm || undefined } });
  })().catch((e) => log('שגיאה בהכנת מדיה', e && e.stack ? e.stack : e)).finally(() => runningDerivs.delete(key));
}

/** merge fields into one media item (not an undo step) → new media or null */
function patchMedia(id, mid, patch) {
  return withLock(id, () => {
    let cur;
    try { cur = loadProject(id); } catch { return null; }
    const m = cur.media && cur.media[mid];
    if (!m) return null;
    const nm = { ...m, ...patch };
    if (nm.status === 'ready' || nm.status === 'processing') delete nm.error;
    for (const k of Object.keys(nm)) if (nm[k] === undefined) delete nm[k];
    const next = { ...cur, media: { ...cur.media, [mid]: nm } };
    const out = commit(id, cur, next, { by: 'system', history: false, broadcastEvent: false });
    broadcast(id, { type: 'media', projectId: id, rev: out.rev, media: nm });
    return nm;
  });
}

// ---------------------------------------------------------------- library bridge (resolveSound)

const mounted = { library: null, export: null };

function normalizeSound(r) {
  if (!r) return null;
  if (typeof r === 'string') return isFile(r) ? { abs: path.resolve(r) } : null;
  if (typeof r === 'object') {
    let abs = r.abs || r.path || null;
    if (!abs && r.file) abs = path.isAbsolute(r.file) ? r.file : path.join(ROOT, 'library', 'sounds', r.file);
    if (abs && isFile(abs)) return { abs: path.resolve(abs), id: r.id, name: r.name };
  }
  return null;
}

/** sfx `sound` → { abs, id?, name? } | null */
async function resolveSound(q) {
  if (q == null || String(q).trim() === '') return null;
  const s = String(q).trim();
  const lib = mounted.library && mounted.library.mod;
  if (lib && typeof lib.resolveSound === 'function') {
    try { const r = normalizeSound(await lib.resolveSound(s)); if (r) return r; } catch (e) { log('resolveSound נכשל:', e && e.message); }
  }
  for (const cand of [s, path.join(ROOT, 'library', 'sounds', s)]) {
    if (path.isAbsolute(cand) && isFile(cand)) return { abs: path.resolve(cand), name: path.basename(cand) };
  }
  return null;
}

// ---------------------------------------------------------------- ops pipeline

/**
 * Apply ops to a project and broadcast (SPEC §5 ops route). Imports `path` fields of addClip, resolves `sfx` sounds.
 * → { rev, results, project, history, warnings? }
 */
// The ops engine validates effect/transition/caption ids strictly only when the render catalogs are loaded.
// Load them once (same module instance ops.js uses) so server results match the browser's optimistic apply.
let catalogReady = null;
function ensureCatalog() {
  if (!catalogReady) {
    catalogReady = import(pathToFileURL(path.join(ROOT, 'shared', 'catalog.js')).href)
      .then((m) => m.getCatalog())
      .catch((e) => { console.error('[catalog] טעינת הקטלוג נכשלה:', e?.message || e); return null; });
  }
  return catalogReady;
}
setTimeout(() => { ensureCatalog(); }, 0);

export async function applyAndBroadcast(id, ops, by = 'user', summary = '', opts = {}) {
  const OPS = await need('ops');
  await ensureCatalog();
  if (typeof ops === 'string') { try { ops = JSON.parse(ops); } catch { throw new HttpError(400, 'רשימת הפעולות אינה JSON תקין'); } }
  if (ops && !Array.isArray(ops) && typeof ops === 'object') ops = Array.isArray(ops.ops) ? ops.ops : [ops];
  if (!Array.isArray(ops)) throw new HttpError(400, 'יש לשלוח מערך פעולות (ops)');
  by = normBy(by);
  const r = await withLock(id, async () => {
    const cur = loadProject(id);
    const draft = makeDraft(cur);
    const prepared = [];
    const importErrors = new Map();
    for (let i = 0; i < ops.length; i++) {
      let op = ops[i];
      if (!op || typeof op !== 'object') { prepared.push(op); continue; }
      op = { ...op };
      try {
        if (op.op === 'addClip' && op.path != null && op.path !== '' && !op.mediaId) {
          const m = await registerPath(id, draft, op.path, { copy: !!op.copy });
          op.mediaId = m.id;
          delete op.path; delete op.copy;
        } else if (op.op === 'sfx' && !op.mediaId) {
          const snd = op.path ? normalizeSound(normalizeInputPath(op.path)) : await resolveSound(op.sound);
          if (snd) {
            // library sounds keep the library's cleaned title as the media name
            const m = await registerPath(id, draft, snd.abs, { library: snd.id ? { soundId: snd.id } : undefined, name: snd.id && snd.name ? snd.name : undefined });
            op.mediaId = m.id;
            op.path = m.path;
          } else importErrors.set(i, `לא נמצא צליל מתאים בספרייה: "${op.sound ?? op.path ?? ''}"`);
        }
      } catch (e) { importErrors.set(i, e.message); }
      prepared.push(op);
    }
    let out;
    try { out = OPS.applyOps(draft.project, prepared, { atomic: !!opts.atomic, media: draft.project.media, by }); }
    catch (e) { log('applyOps זרק שגיאה:', e && e.stack ? e.stack : e); throw new HttpError(500, `שגיאה במנוע הפעולות: ${e.message}`); }
    if (!out || typeof out !== 'object' || !out.project) throw new HttpError(500, 'מנוע הפעולות החזיר תוצאה לא תקינה');
    let results = prepared.map((op, i) => {
      const res = (out.results || [])[i] || { ok: false, error: 'אין תוצאה לפעולה' };
      return importErrors.has(i) && res.ok === false ? { ok: false, error: importErrors.get(i) } : res;
    });
    // atomic batch with a failure: NOTHING is applied (not even the media the batch imported). The ops that ran
    // fine are marked rolledBack so no client reports them as done.
    const rolledBack = !!opts.atomic && results.some((x) => !x || x.ok !== true);
    if (rolledBack) results = results.map((x) => (x && x.ok === true ? { ...x, rolledBack: true } : x));
    let project = cur;
    let warnings;
    if (!rolledBack && contentKey(cur) !== contentKey(out.project)) {
      project = commit(id, cur, out.project, { by, summary: summary || autoSummary(prepared, results), history: true });
      const M = moduleSlots.model.mod;
      if (M && typeof M.validateProject === 'function') { try { const w = M.validateProject(project); if (Array.isArray(w) && w.length) warnings = w; } catch { /* advisory only */ } }
    }
    const toStart = rolledBack ? [] : [...draft.added.map((m) => m.id), ...draft.requeue].filter((mid) => project.media && project.media[mid]);
    const res = { rev: project.rev, results, project, history: histInfo(getEntry(id)), warnings, toStart };
    if (opts.atomic) { res.atomic = true; res.applied = !rolledBack; if (rolledBack) res.rolledBack = true; }
    return res;
  });
  for (const mid of r.toStart) startDerivatives(id, mid);
  delete r.toStart;
  if (!r.warnings) delete r.warnings;
  return r;
}

async function undoRedo(id, which, by) {
  by = normBy(by);
  return withLock(id, () => {
    const e = getEntry(id);
    const cur = e.project;
    const from = which === 'undo' ? e.undo : e.redo;
    const to = which === 'undo' ? e.redo : e.undo;
    if (!from.length) throw new HttpError(409, which === 'undo' ? 'אין פעולה לביטול' : 'אין פעולה לביצוע מחדש');
    const item = from.pop();
    const snap = unpack(item.data);
    to.push({ data: pack(cur), summary: item.summary, by: item.by, rev: cur.rev, time: nowIso(), mediaRemoved: item.mediaRemoved });
    // media (and its processing state) is not part of the undo history: keep the current bin (fresher status),
    // bring back items a history step removed; only a redo of "remove media" removes them again
    const restored = { ...snap, media: { ...(snap.media || {}), ...(cur.media || {}) } };
    if (which === 'redo' && Array.isArray(item.mediaRemoved)) for (const mid of item.mediaRemoved) delete restored.media[mid];
    const label = which === 'undo' ? 'ביטול' : 'ביצוע מחדש';
    const out = commit(id, cur, restored, { by, summary: `${label}: ${item.summary || 'עריכה'}`, history: false });
    return { rev: out.rev, project: out, history: histInfo(e), [which === 'undo' ? 'undone' : 'redone']: item.summary };
  });
}

/** ctx.saveProject: write a whole project as a new revision (history + broadcast) */
async function saveProjectExternal(project, { by = 'user', summary = '', history = true } = {}) {
  if (!project || typeof project !== 'object') throw new HttpError(400, 'פרויקט לא תקין');
  const id = checkId(project.id);
  return withLock(id, () => {
    let cur = null;
    try { cur = loadProject(id); } catch (e) { if (e.status !== 404) throw e; }
    if (!cur) {
      const p = normalizeProject(JSON.parse(JSON.stringify(project)), id);
      p.rev = p.rev || 0;
      ensureProjectDirs(id);
      writeProjectFile(p);
      store.set(id, { project: p, undo: [], redo: [] });
      return p;
    }
    return commit(id, cur, JSON.parse(JSON.stringify(project)), { by: by === 'system' ? 'system' : normBy(by), summary: summary || 'שמירה', history });
  });
}

// ---------------------------------------------------------------- SSE

const sseClients = new Set();

export function broadcast(projectId, event) {
  const ev = { ...event };
  if (projectId && ev.projectId == null) ev.projectId = projectId;
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of sseClients) {
    if (c.projectId && projectId && c.projectId !== projectId) continue;
    if (c.projectId && !projectId && ev.type !== 'projects') continue;
    try { c.res.write(data); } catch { sseClients.delete(c); }
  }
}

function handleEvents(req, res, query) {
  const projectId = query.get('project') || null;
  if (projectId) checkId(projectId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  let rev = null, history;
  if (projectId) { try { const e = getEntry(projectId); rev = e.project.rev; history = histInfo(e); } catch { rev = null; } }
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', rev, projectId, version: VERSION, history })}\n\n`);
  const client = { res, projectId };
  sseClients.add(client);
  const done = () => sseClients.delete(client);
  req.on('close', done);
  res.on('error', done);
}

const heartbeat = setInterval(() => {
  for (const c of sseClients) { try { c.res.write(': ping\n\n'); } catch { sseClients.delete(c); } }
}, 15000);
heartbeat.unref();

// ---------------------------------------------------------------- background jobs (transcription)
// The job registry is owned by export.mjs (`externalJobs`): /api/jobs/:job, /wait and SSE "job" events.
// Only when export.mjs failed to load does main.mjs keep its own minimal registry (served by the routes below).

const asrJobs = new Map();
const jobWaiters = new Map();
const FINISHED = new Set(['done', 'error', 'canceled']);

function publicJob(j) { return j ? { ...j } : null; }
function localUpdate(job, patch) {
  Object.assign(job, patch);
  job.updatedAt = nowIso();
  if (FINISHED.has(job.status)) {
    job.finishedAt = job.finishedAt || nowIso();
    for (const w of jobWaiters.get(job.id) || []) w();
    jobWaiters.delete(job.id);
    setTimeout(() => asrJobs.delete(job.id), 2 * 3600 * 1000).unref();
  }
  broadcast(job.projectId, { type: 'job', job: publicJob(job) });
  return publicJob(job);
}

/** { create(type, projectId, fields) → job, update(id, patch), finish(id, status, extra) } */
function jobsBackend() {
  const ex = mounted.export && mounted.export.mod && mounted.export.mod.externalJobs;
  if (ex && typeof ex.create === 'function' && typeof ex.update === 'function' && typeof ex.finish === 'function') {
    return {
      create: (type, projectId, fields) => ex.create(type, projectId, fields),
      update: (id, patch) => ex.update(id, patch),
      finish: (id, status, extra) => ex.finish(id, status, extra),
    };
  }
  return {
    create(type, projectId, fields) {
      const t = nowIso();
      const job = {
        id: `${String(type).slice(0, 3)}_${Date.now().toString(36)}${rand(4)}`, type, projectId, status: 'running', phase: 'running',
        progress: 0, outputs: [], report: null, warnings: [], error: null, createdAt: t, startedAt: t, finishedAt: null, ...fields,
      };
      asrJobs.set(job.id, job);
      return localUpdate(job, {});
    },
    update(id, patch) {
      const job = asrJobs.get(id);
      if (!job || FINISHED.has(job.status)) return null;
      const { status, ...rest } = patch;
      if (Number.isFinite(rest.progress)) rest.progress = Math.min(0.99, Math.max(0, rest.progress));
      return localUpdate(job, rest);
    },
    finish(id, status = 'done', { report = null, outputs = null, error = null, ...rest } = {}) {
      const job = asrJobs.get(id);
      if (!job) return null;
      const patch = { ...rest, status: status === 'done' ? 'done' : 'error', phase: status === 'done' ? 'done' : 'error', error };
      if (status === 'done') patch.progress = 1;
      if (report) patch.report = report;
      if (outputs) patch.outputs = outputs;
      return localUpdate(job, patch);
    },
  };
}

function waitJob(job, ms) {
  if (FINISHED.has(job.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); const l = jobWaiters.get(job.id); if (l) { const i = l.indexOf(done); if (i >= 0) l.splice(i, 1); } resolve(); }
    if (!jobWaiters.has(job.id)) jobWaiters.set(job.id, []);
    jobWaiters.get(job.id).push(done);
  });
}

async function startTranscribe(id, body) {
  const p = loadProject(id);
  const dir = projectDir(id);
  let mediaId = body.mediaId || null;
  let src = null, wav = null;
  if (mediaId) {
    const m = p.media[mediaId];
    if (!m) throw new HttpError(404, `המדיה "${mediaId}" לא נמצאה בפרויקט`);
    if (!m.hasAudio) throw new HttpError(400, `לקובץ "${m.name}" אין ערוץ שמע`);
    src = m.path;
    if (m.audio && isFile(path.join(dir, m.audio))) wav = path.join(dir, m.audio);
  } else if (body.path) {
    src = normalizeInputPath(body.path);
    if (!isFile(src)) throw new HttpError(404, `הקובץ לא נמצא: ${src}`);
    const ex = Object.values(p.media).find((m) => m && m.path && pathKey(m.path) === pathKey(src));
    if (ex) { mediaId = ex.id; if (ex.audio && isFile(path.join(dir, ex.audio))) wav = path.join(dir, ex.audio); }
  } else throw new HttpError(400, 'יש לציין mediaId או path לתמלול');
  const st = asrStatus();
  if (!st.ok) throw new HttpError(503, st.error);
  const model = String(body.model || 'small');
  const jobsApi = jobsBackend();
  const job = jobsApi.create('transcribe', id, {
    mediaId, path: src, model, phase: 'prepare', label: 'מכין שמע', progress: 0.01,
  });
  const by = normBy(body.by);
  const update = (patch) => { try { jobsApi.update(job.id, patch); } catch { /* registry gone */ } };
  (async () => {
    let tmp = null;
    try {
      if (!wav) {
        tmp = path.join(dir, 'cache', 'audio', `asr-${rand(6)}.wav`);
        await fsp.mkdir(path.dirname(tmp), { recursive: true });
        await media.enqueue(() => media.runFfmpeg(['-i', src, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp]), 1);
        wav = tmp;
      }
      const r = await transcribeFile(wav, {
        model, language: body.language || 'he', snap: body.snap !== false, log,
        onProgress: (o) => update({ phase: o.stage, label: o.label, progress: Math.round(o.progress * 1000) / 1000 }),
      });
      // media time → timeline time
      let words = r.words;
      let offset = 0, mapped = null;
      const cur = loadProject(id);
      if (Number.isFinite(+body.offset) && body.offset !== null && body.offset !== '') offset = +body.offset;
      else if (mediaId) {
        const clips = Object.values(cur.clips || {}).filter((c) => c && c.mediaId === mediaId && !c.disabled);
        const roleOf = (c) => ((cur.tracks || []).find((t) => t.id === c.trackId) || {}).role;
        clips.sort((a, b) => (roleOf(a) === 'voice' ? 0 : 1) - (roleOf(b) === 'voice' ? 0 : 1) || a.start - b.start);
        mapped = clips[0] || null;
      }
      if (mapped) {
        const sp = +mapped.speed || 1, cin = +mapped.in || 0, end = cin + (+mapped.duration || 0) * sp;
        words = words.filter((w) => w.e > cin - 0.05 && w.s < end + 0.05)
          .map((w) => ({ w: w.w, s: Math.round((mapped.start + (Math.max(cin, w.s) - cin) / sp) * 1000) / 1000, e: Math.round((mapped.start + (Math.min(end, w.e) - cin) / sp) * 1000) / 1000 }));
        offset = mapped.start - cin / sp;
      } else if (offset) {
        words = words.map((w) => ({ w: w.w, s: Math.round((w.s + offset) * 1000) / 1000, e: Math.round((w.e + offset) * 1000) / 1000 }));
      }
      update({ phase: 'apply', label: 'מעדכן את הפרויקט', progress: 0.98 });
      const ops = [{ op: 'setTranscript', words, mediaId: mediaId || undefined }];
      if (body.captions) ops.push({ op: 'addCaptions', words: 'transcript', ...(typeof body.captions === 'object' ? body.captions : {}) });
      const res = await applyAndBroadcast(id, ops, by, `תמלול אוטומטי: ${words.length} מילים${body.captions ? ' + כתוביות' : ''}`);
      const failed = res.results.find((x) => x && x.ok === false);
      const result = {
        words: words.length, snapped: r.moved, offset: Math.round(offset * 1000) / 1000, clipId: mapped ? mapped.id : null, rev: res.rev,
        captionIds: res.results[1] && res.results[1].ids, transcript: words, warning: failed ? failed.error : undefined,
      };
      jobsApi.finish(job.id, 'done', { report: result, result, label: 'התמלול הסתיים', phase: 'done' });
      log(`תמלול ${job.id} בפרויקט ${id}: ${words.length} מילים (${r.moved} יושרו)`);
    } catch (e) {
      log(`תמלול ${job.id} נכשל:`, e && e.message);
      try { jobsApi.finish(job.id, 'error', { error: e.message || String(e), label: 'התמלול נכשל', phase: 'error' }); } catch { /* ignore */ }
    } finally {
      if (tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  })();
  return job;
}

// ---------------------------------------------------------------- open editor window

function findChrome() {
  // env FRAME_STUDIO_CHROME → config "chrome" → Google Chrome → Chromium → Microsoft Edge (server/config.mjs)
  try { return findBrowser({ allowEdge: true }) || null; } catch { return null; }
}
function openEditor(projectId, { dry = false } = {}) {
  const url = `http://127.0.0.1:${PORT}/` + (projectId ? `?project=${encodeURIComponent(projectId)}` : '');
  const chrome = findChrome();
  const cmd = chrome ? [chrome, `--app=${url}`, '--new-window', '--window-size=1600,950'] : openUrlCommand(url);
  if (!dry) {
    const ch = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: false, env: typeof appConfig.browserEnv === 'function' ? appConfig.browserEnv() : process.env });
    ch.on('error', (e) => log('פתיחת החלון נכשלה:', e.message));
    ch.unref();
    log(`נפתח חלון עורך: ${url}`);
  }
  return { ok: true, url, browser: chrome || 'default', cmd, dry: !!dry };
}

// ---------------------------------------------------------------- static files

const STATIC = [
  ['/app/', 'app'], ['/render/', 'render'], ['/shared/', 'shared'], ['/library/fonts/', 'library/fonts'],
  ['/library/luts/', 'library/luts'], ['/docs/', 'docs'],
];

async function serveStatic(req, res, pathname) {
  let rel = null, base = null;
  if (pathname === '/' || pathname === '/index.html') { base = path.join(ROOT, 'app'); rel = 'index.html'; }
  else if (pathname === '/favicon.ico') { base = path.join(ROOT, 'app'); rel = 'icon.ico'; }
  else {
    for (const [prefix, dir] of STATIC) {
      if (pathname.startsWith(prefix)) { base = path.join(ROOT, dir); rel = pathname.slice(prefix.length); break; }
    }
  }
  if (base == null) return false;
  let decoded;
  try { decoded = rel.split('/').map(decodeURIComponent).join('/'); } catch { throw new HttpError(400, 'כתובת לא תקינה'); }
  if (decoded.includes('\0')) throw new HttpError(400, 'כתובת לא תקינה');
  const abs = path.resolve(base, decoded);
  if (abs !== base && !isInside(abs, base)) throw new HttpError(403, 'גישה נדחתה');
  if (isDir(abs)) {
    const idx = path.join(abs, 'index.html');
    if (isFile(idx)) return media.serveFile(req, res, idx, { cacheControl: 'no-cache' });
    throw new HttpError(404, 'הנתיב לא נמצא');
  }
  if (!isFile(abs)) {
    if (rel === 'index.html' && pathname === '/') {
      const html = '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>Frame Studio</title><body style="background:#101014;color:#f2f2f2;font:18px Segoe UI,Arial;padding:40px">' +
        '<h1>Frame Studio</h1><p>השרת פועל, אבל ממשק העורך (app/index.html) עדיין לא הותקן.</p></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return true;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
    log(`404 קובץ סטטי: ${pathname}`);
    throw new HttpError(404, `הקובץ לא נמצא: ${pathname}`);
  }
  const fonts = pathname.startsWith('/library/fonts/');
  return media.serveFile(req, res, abs, { cacheControl: fonts ? 'public, max-age=604800' : 'no-cache' });
}

// ---------------------------------------------------------------- routes

const P = '([a-z0-9][a-z0-9-]{0,63})';
const M_ID = '([A-Za-z0-9_-]{1,80})';
const coreRoutes = [];
const route = (method, re, handler) => coreRoutes.push({ method, pattern: re, handler, owner: 'main' });

route('GET', /^\/api\/health$/, (req, res) => sendJson(res, 200, {
  ok: true, app: 'frame-studio', version: VERSION, root: ROOT, dataDir: DATA_DIR, port: PORT, pid: process.pid, uptime: Math.round(process.uptime()),
  modules: {
    model: !!moduleSlots.model.mod, ops: !!moduleSlots.ops.mod,
    library: !!(mounted.library && mounted.library.mod), export: !!(mounted.export && mounted.export.mod),
  },
  errors: Object.fromEntries(Object.entries({ model: moduleSlots.model.err, ops: moduleSlots.ops.err, library: mounted.library && mounted.library.error, export: mounted.export && mounted.export.error })
    .filter(([, e]) => e).map(([k, e]) => [k, e.message || String(e)])),
  queue: media.queueStats(), asr: asrStatus().ok,
}));

route('GET', /^\/api\/projects$/, async (req, res) => sendJson(res, 200, await listProjects()));

route('POST', /^\/api\/projects$/, async (req, res) => {
  const b = await readJson(req);
  const p = await createProject({ id: b.id, name: b.name, width: b.width, height: b.height, fps: b.fps, tracks: b.tracks === 'empty' ? 'empty' : 'default', by: b.by });
  sendJson(res, 201, p);
});

route('GET', new RegExp(`^/api/projects/${P}$`), (req, res, m) => {
  const e = getEntry(m[1]);
  res.setHeader('X-Rev', String(e.project.rev));
  res.setHeader('X-History', `${e.undo.length},${e.redo.length}`);
  sendJson(res, 200, e.project);
});

route('PATCH', new RegExp(`^/api/projects/${P}$`), async (req, res, m) => {
  const id = m[1];
  const b = await readJson(req);
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'יש לציין שם לפרויקט');
  const out = await withLock(id, () => {
    const cur = loadProject(id);
    if (cur.name === name) return cur;
    return commit(id, cur, { ...cur, name }, { by: normBy(b.by), summary: `שינוי שם הפרויקט ל"${name}"`, history: true });
  });
  broadcast(null, { type: 'projects', action: 'renamed', projectId: id });
  sendJson(res, 200, out);
});

route('DELETE', new RegExp(`^/api/projects/${P}$`), async (req, res, m) => {
  const id = checkId(m[1]);
  const dir = projectDir(id);
  if (!isDir(dir)) throw new HttpError(404, `הפרויקט "${id}" לא נמצא`);
  const dest = await withLock(id, async () => {
    await fsp.mkdir(TRASH, { recursive: true });
    const stamp = nowIso().replace(/[:.]/g, '-');
    const target = path.join(TRASH, `${id}-${stamp}`);
    for (let i = 0; ; i++) {
      try { await fsp.rename(dir, target); break; } catch (e) {
        if (i >= 15 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
          throw new HttpError(409, `לא ניתן להעביר את הפרויקט לסל: קבצים בשימוש (${e.code}). נסו שוב בעוד רגע.`);
        }
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    store.delete(id);
    return target;
  });
  log(`פרויקט ${id} הועבר לסל: ${dest}`);
  broadcast(id, { type: 'deleted', projectId: id });
  broadcast(null, { type: 'projects', action: 'deleted', projectId: id });
  sendJson(res, 200, { ok: true, id, trash: dest });
});

route('POST', new RegExp(`^/api/projects/${P}/ops$`), async (req, res, m) => {
  const b = await readJson(req);
  const r = await applyAndBroadcast(m[1], b.ops, b.by, b.summary, { atomic: !!b.atomic });
  sendJson(res, 200, r);
});

route('POST', new RegExp(`^/api/projects/${P}/(undo|redo)$`), async (req, res, m) => {
  const b = await readJson(req);
  sendJson(res, 200, await undoRedo(m[1], m[2], b.by));
});

route('GET', new RegExp(`^/api/projects/${P}/history$`), (req, res, m) => {
  const e = getEntry(m[1]);
  const map = (x) => ({ summary: x.summary, by: x.by, rev: x.rev, time: x.time });
  sendJson(res, 200, { rev: e.project.rev, undo: e.undo.map(map), redo: e.redo.map(map), max: MAX_HISTORY });
});

route('POST', new RegExp(`^/api/projects/${P}/import$`), async (req, res, m) => {
  const b = await readJson(req);
  getEntry(m[1]);
  const r = await importInternal(m[1], b.paths || b.path, { copy: !!b.copy, by: b.by });
  const list = r.media.filter(Boolean);
  if (!list.length) throw new HttpError(400, r.errors.map((x) => x.error).join(' | ') || 'הייבוא נכשל', { errors: r.errors });
  sendJson(res, 200, { media: list, errors: r.errors.length ? r.errors : undefined });
});

route('POST', new RegExp(`^/api/projects/${P}/upload$`), async (req, res, m, ctx, query) => {
  const id = m[1];
  getEntry(id);
  const name = sanitizeFileName(query.get('name') || req.headers['x-file-name'] || `upload-${Date.now()}`);
  const dir = path.join(projectDir(id), 'media');
  await fsp.mkdir(dir, { recursive: true });
  const dst = uniqueFileIn(dir, name);
  const tmp = dst + '.part';
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await fsp.rename(tmp, dst);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new HttpError(500, `שמירת הקובץ שהועלה נכשלה: ${e.message}`);
  }
  const st = await fsp.stat(dst);
  if (!st.size) { await fsp.rm(dst, { force: true }); throw new HttpError(400, 'הקובץ שהועלה ריק'); }
  const r = await importInternal(id, [dst], { by: query.get('by') });
  if (!r.media[0]) { await fsp.rm(dst, { force: true }).catch(() => {}); throw new HttpError(400, r.errors.map((x) => x.error).join(' | ') || 'ייבוא הקובץ נכשל'); }
  sendJson(res, 200, { media: [r.media[0]] });
});

function getMedia(id, mid) {
  const p = loadProject(id);
  const m = p.media && p.media[mid];
  if (!m) throw new HttpError(404, `המדיה "${mid}" לא נמצאה בפרויקט`);
  return m;
}

route('GET', new RegExp(`^/api/projects/${P}/media/${M_ID}$`), (req, res, m) => sendJson(res, 200, getMedia(m[1], m[2])));

route('DELETE', new RegExp(`^/api/projects/${P}/media/${M_ID}$`), async (req, res, m, ctx, query) => {
  const [, id, mid] = m;
  const out = await withLock(id, () => {
    const cur = loadProject(id);
    if (!cur.media[mid]) throw new HttpError(404, `המדיה "${mid}" לא נמצאה בפרויקט`);
    const used = Object.values(cur.clips || {}).filter((c) => c && c.mediaId === mid);
    if (used.length) throw new HttpError(409, `המדיה בשימוש ב-${used.length} קליפים בציר הזמן — מחקו אותם קודם`);
    const nm = { ...cur.media };
    const name = nm[mid].name;
    delete nm[mid];
    return commit(id, cur, { ...cur, media: nm }, { by: normBy(query.get('by')), summary: `הסרת "${name}" מהמדיה`, history: true });
  });
  sendJson(res, 200, { rev: out.rev, project: out });
});

route('POST', new RegExp(`^/api/projects/${P}/media/${M_ID}/regenerate$`), async (req, res, m) => {
  const [, id, mid] = m;
  const md = getMedia(id, mid);
  const rel = media.derivativePaths(md);
  for (const k of Object.keys(rel)) await fsp.rm(path.join(projectDir(id), rel[k]), { recursive: true, force: true }).catch(() => {});
  const nm = await patchMedia(id, mid, { status: 'processing', proxy: undefined, audio: undefined, peaks: undefined, thumbs: undefined });
  startDerivatives(id, mid);
  sendJson(res, 200, { media: nm });
});

route('GET', new RegExp(`^/api/projects/${P}/media/${M_ID}/(file|proxy|audio|peaks|thumb)$`), async (req, res, m, ctx, query) => {
  const [, id, mid, what] = m;
  const md = getMedia(id, mid);
  const dir = projectDir(id);
  const rp = (r) => (r ? path.join(dir, r) : null);
  if (what === 'file') return media.serveFile(req, res, md.path, { contentType: md.kind === 'video' && /\.(mov|m4v)$/i.test(md.path) ? 'video/mp4' : undefined });
  if (what === 'proxy') {
    const f = rp(md.proxy);
    if (f && isFile(f)) return media.serveFile(req, res, f, { contentType: 'video/mp4' });
    return media.serveFile(req, res, md.path, { headers: { 'X-Frame-Studio-Fallback': 'file' } });
  }
  if (what === 'audio') {
    const f = rp(md.audio);
    if (f && isFile(f)) return media.serveFile(req, res, f, { contentType: 'audio/wav' });
    if (!md.hasAudio) throw new HttpError(404, 'לקובץ הזה אין שמע');
    return media.serveFile(req, res, md.path, { headers: { 'X-Frame-Studio-Fallback': 'file' } });
  }
  if (what === 'peaks') {
    const f = rp(md.peaks);
    if (f && isFile(f)) return media.serveFile(req, res, f, { contentType: 'application/json; charset=utf-8' });
    throw new HttpError(404, md.hasAudio ? 'צורת הגל עדיין בהכנה' : 'לקובץ הזה אין שמע');
  }
  // thumb?t=<sec> → nearest 1 s jpg
  const tdir = rp(md.thumbs);
  if (!tdir || !isDir(tdir)) {
    if (md.kind === 'image') return media.serveFile(req, res, md.path);
    throw new HttpError(404, 'התמונות הממוזערות עדיין בהכנה');
  }
  const key = `${id}/${mid}`;
  let count = thumbCounts.get(key);
  if (!count) { count = await media.countThumbs(tdir); if (count) thumbCounts.set(key, count); }
  if (!count) throw new HttpError(404, 'אין תמונות ממוזערות');
  const t = Math.max(0, Number(query.get('t')) || 0);
  const n = Math.min(count, Math.max(1, Math.round(t) + 1));
  return media.serveFile(req, res, path.join(tdir, String(n).padStart(5, '0') + '.jpg'), { contentType: 'image/jpeg', cacheControl: 'public, max-age=3600' });
});

route('GET', /^\/api\/events$/, (req, res, m, ctx, query) => handleEvents(req, res, query));

route('POST', new RegExp(`^/api/projects/${P}/transcribe$`), async (req, res, m) => {
  const b = await readJson(req);
  const job = await startTranscribe(m[1], b);
  sendJson(res, 202, publicJob(job));
});

route('GET', /^\/api\/asr\/status$/, (req, res) => sendJson(res, 200, asrStatus()));

// fallback job registry (only used when export.mjs failed to load); any other job id falls through to export.mjs
route('GET', /^\/api\/jobs\/([A-Za-z0-9_-]+)$/, (req, res, m) => {
  const job = asrJobs.get(m[1]);
  if (!job) return NEXT;
  sendJson(res, 200, publicJob(job));
});
route('GET', /^\/api\/jobs\/([A-Za-z0-9_-]+)\/wait$/, async (req, res, m, ctx, query) => {
  const job = asrJobs.get(m[1]);
  if (!job) return NEXT;
  const ms = Math.min(600, Math.max(1, Number(query.get('timeout')) || 600)) * 1000;
  req.socket.setTimeout(0);
  await waitJob(job, ms);
  sendJson(res, 200, publicJob(job));
});

route('POST', /^\/api\/open$/, async (req, res) => {
  const b = await readJson(req);
  if (b.project) { checkId(String(b.project)); getEntry(String(b.project)); }
  sendJson(res, 200, openEditor(b.project ? String(b.project) : null, { dry: !!b.dry }));
});

route('POST', /^\/api\/shutdown$/, (req, res) => {
  sendJson(res, 200, { ok: true, message: 'השרת נסגר' });
  setTimeout(() => shutdown('api'), 150);
});

// ---------------------------------------------------------------- module context + mounting

export const ctx = {
  ROOT, DATA_DIR, PORT, VERSION, NEXT, HttpError,
  loadProject: (id) => structuredClone(loadProject(id)),
  saveProject: (project, opts) => saveProjectExternal(project, opts),
  applyAndBroadcast: (id, ops, by, summary, opts) => applyAndBroadcast(id, ops, by, summary, opts),
  broadcast, sendJson, readJson, readBody,
  serveFile: (req, res, absPath, opts) => media.serveFile(req, res, absPath, opts),
  projectDir, log,
  importPaths: (id, paths, opts) => importInternal(id, paths, opts || {}),
  getMedia: (id, mid) => structuredClone(getMedia(id, mid)),
  withLock, media, need,
};

async function mountModule(file) {
  const slot = { mod: null, routes: [], error: null };
  // FRAME_STUDIO_SKIP=export,library — diagnostics: run the server without a module
  const skip = String(process.env.FRAME_STUDIO_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (skip.includes(file.replace(/\.mjs$/, ''))) {
    slot.error = new Error('דולג (FRAME_STUDIO_SKIP)');
    log(`server/${file} לא נטען (FRAME_STUDIO_SKIP)`);
    return slot;
  }
  try {
    slot.mod = await import(pathToFileURL(path.join(SERVER_DIR, file)).href);
    if (typeof slot.mod.routes !== 'function') { log(`server/${file}: אין פונקציית routes()`); return slot; }
    const list = await slot.mod.routes(ctx);
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r.handler !== 'function') continue;
      let pattern = r.pattern;
      if (typeof pattern === 'string') pattern = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
      if (!(pattern instanceof RegExp)) continue;
      slot.routes.push({ method: String(r.method || 'GET').toUpperCase(), pattern, handler: r.handler, owner: file });
    }
    log(`נטען server/${file} (${slot.routes.length} נתיבים)`);
  } catch (e) {
    slot.error = e;
    log(`שגיאה בטעינת server/${file} — השרת ממשיך בלעדיו:`, e && e.stack ? e.stack : String(e));
  }
  return slot;
}

let allRoutes = [...coreRoutes];

// ---------------------------------------------------------------- request handling

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

async function handle(req, res) {
  const method = req.method.toUpperCase();
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${PORT}`); } catch { return sendJson(res, 400, { error: 'כתובת לא תקינה' }); }
  const pathname = url.pathname;
  req.pathname = pathname;
  req.query = Object.fromEntries(url.searchParams);
  req.searchParams = url.searchParams;

  // DNS-rebinding / cross-site protection: only local hosts, and no foreign-origin writes
  const host = String(req.headers.host || '').toLowerCase();
  if (host && !ALLOWED_HOSTS.has(host)) return sendJson(res, 403, { error: 'גישה מותרת רק מהמחשב הזה' });
  const origin = req.headers.origin;
  if (origin && method !== 'GET' && method !== 'HEAD' && origin !== 'null') {
    let ok = false;
    try { ok = ALLOWED_HOSTS.has(new URL(origin).host); } catch { ok = false; }
    if (!ok) return sendJson(res, 403, { error: 'בקשה מאתר חיצוני נחסמה' });
  }
  if (method === 'OPTIONS') { res.writeHead(204, { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' }); return res.end(); }

  try {
    for (const r of allRoutes) {
      if (r.method !== '*' && r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      r.pattern.lastIndex = 0;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const ret = await r.handler(req, res, m, ctx, url.searchParams);
      if (ret === NEXT || ret === false) { if (res.headersSent || res.writableEnded) return; continue; }
      return;
    }
    if ((method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api/')) {
      if (await serveStatic(req, res, pathname)) return;
    }
    if (pathname.startsWith('/api/')) throw new HttpError(404, `נתיב API לא קיים: ${method} ${pathname}`);
    throw new HttpError(404, `הנתיב לא נמצא: ${pathname}`);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e && e.status) || 500;
    if (status >= 500) log(`שגיאה ב-${method} ${pathname}:`, e && e.stack ? e.stack : e);
    if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
    sendJson(res, status, { error: (e && e.message) || 'שגיאה פנימית בשרת', ...(e && e.extra ? e.extra : {}) });
  }
}

// ---------------------------------------------------------------- start

const server = http.createServer((req, res) => { handle(req, res).catch((e) => { log('שגיאה לא מטופלת:', e); try { sendJson(res, 500, { error: 'שגיאה פנימית בשרת' }); } catch { /* closed */ } }); });
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 30000;

let shuttingDown = false;
function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`השרת נסגר (${why})`);
  for (const c of sseClients) { try { c.res.end(); } catch { /* ignore */ } }
  media.killAll();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
process.on('uncaughtException', (e) => log('שגיאה לא צפויה:', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => log('הבטחה שנדחתה ללא טיפול:', e && e.stack ? e.stack : e));

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    let h = null;
    try { h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { h = null; }
    if (h && h.ok && h.app === 'frame-studio') {
      log(`Frame Studio כבר פועל על פורט ${PORT} (pid ${h.pid}) — אין צורך בשרת נוסף`);
      process.exit(0);
    }
    const msg = `הפורט ${PORT} תפוס על ידי תוכנה אחרת. סגרו אותה או הפעילו את השרת עם --port אחר.`;
    log(msg);
    console.error(msg);
    process.exit(1);
  }
  log('שגיאת שרת:', e && e.stack ? e.stack : e);
  process.exit(1);
});

async function main() {
  await Promise.all([need('model').catch(() => {}), need('ops').catch(() => {})]);
  mounted.library = await mountModule('library.mjs');
  mounted.export = await mountModule('export.mjs');
  allRoutes = [...coreRoutes, ...mounted.library.routes, ...mounted.export.routes];
  server.listen(PORT, '127.0.0.1', () => {
    log(`Frame Studio ${VERSION} מאזין על http://127.0.0.1:${PORT}/  (תיקייה: ${ROOT}${DATA_DIR !== ROOT ? ` · נתונים: ${DATA_DIR}` : ''})`);
    if (process.argv.includes('--open')) openEditor(null);
  });
}
main();
