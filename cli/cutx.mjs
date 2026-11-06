#!/usr/bin/env node
// cli/cutx.mjs — Frame Studio command line. Claude's main entry point for editing while the user watches.
// Talks to the local server (http://127.0.0.1:7788, override with CUTX_URL). Auto-starts server/main.mjs when needed.
// Human-readable Hebrew output by default, --json for machine output.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { OPS_HELP, resolveTime, summarizeOps, normalizeWord } from '../shared/ops.js';
import { interpolateKeyframes, partEase, parsePartEase, getEase } from '../shared/anim.js';
import {
  validateProject, formatTimecode, projectDuration, clipEnd, clipsOnTrack, CLIP_TYPE_LABELS, ROLE_LABELS,
  TRACK_KIND_LABELS, gainToDb,
} from '../shared/model.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_URL = 'http://127.0.0.1:7788';
const BASE = String(process.env.CUTX_URL || DEFAULT_URL).replace(/\/+$/, '');
const VERSION = '1.0.0';

export class CliError extends Error {
  constructor(msg, code = 1) { super(msg); this.name = 'CliError'; this.code = code; }
}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (x) => (Number.isFinite(+x) ? (+x).toFixed(2) : String(x));

// ───────────────────────────── argument parsing ─────────────────────────────

const BOOL_FLAGS = new Set(['json', 'empty', 'copy', 'atomic', 'sheet', 'no-check', 'check', 'ripple', 'abs', 'captions', 'replace',
  'hook0', 'force', 'help', 'quiet', 'wait', 'no-wait', 'keep-duration', 'reverse', 'no-comma', 'headless', 'no-headless', 'stems', 'dry-run', 'dry']);
const MULTI_FLAGS = new Set(['set', 'param']);

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const multi = { set: [], param: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      let k = a.slice(2);
      let v;
      const eq = k.indexOf('=');
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
      else if (BOOL_FLAGS.has(k)) v = true;
      else {
        v = argv[i + 1];
        if (v === undefined) throw new CliError(`חסר ערך לדגל --${k}`);
        i++;
      }
      if (MULTI_FLAGS.has(k)) multi[k].push(String(v));
      else flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags, set: multi.set, param: multi.param };
}

/** "1.5" → 1.5, "true" → true, '{"a":1}' → object, "#fff" → "#fff", "שלום" → "שלום". */
export function parseValue(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (t === '') return '';
  if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^[[{"]/.test(t)) { try { return JSON.parse(t); } catch { /* keep string */ } }
  return s;
}

/** key=value list → {key: parsedValue} */
export function parseAssignments(list) {
  const set = {};
  for (const item of list) {
    const eq = String(item).indexOf('=');
    if (eq <= 0) throw new CliError(`הגדרה לא תקינה "${item}" — צריך מפתח=ערך (למשל transform.scale=1.2)`);
    set[item.slice(0, eq).trim()] = parseValue(item.slice(eq + 1));
  }
  return set;
}

/** Time argument: numbers become numbers; "word:…", "marker:…", "clip:…", timecodes stay strings (resolved by the ops engine). */
export function parseTimeArg(s) {
  if (s === undefined || s === null || s === true) return undefined;
  const t = String(s).trim();
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  return t;
}

/** Split "0.5,3,word:שיר,,6.2" on commas that start a new time (handles commas inside words). */
export function splitTimes(s) {
  if (Array.isArray(s)) return s;
  return String(s).split(/,(?=\s*(?:-?\d|\.\d|word:|marker:|clip:|end\b|start\b))/).map((x) => x.trim()).filter(Boolean);
}

const SIZE_PRESETS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '4:3': [1440, 1080], '3:4': [1080, 1440], '21:9': [2520, 1080] };
export function parseSize(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  if (SIZE_PRESETS[t]) return SIZE_PRESETS[t];
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(t);
  if (m) return [Number(m[1]), Number(m[2])];
  throw new CliError(`גודל לא תקין: "${s}" (למשל 1080x1920, 9:16, 16:9, 1:1, 4:5)`);
}

/** ASR json in any common shape → [[w,s,e]…] */
export function normalizeAsr(data) {
  let list = data;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    if (Array.isArray(list.words)) list = list.words;
    else if (Array.isArray(list.asr)) list = list.asr;
    else if (Array.isArray(list.segments)) list = list.segments.flatMap((sg) => sg.words || []);
    else if (list.transcript && Array.isArray(list.transcript.words)) list = list.transcript.words;
  }
  if (!Array.isArray(list)) throw new CliError('קובץ התמלול לא בפורמט מוכר ([[מילה,התחלה,סוף]…] או [{w,s,e}…])');
  const outList = [];
  for (const x of list) {
    if (Array.isArray(x)) { if (typeof x[0] === 'string') outList.push([x[0].trim(), Number(x[1]), Number(x[2])]); continue; }
    if (x && typeof x === 'object') {
      const w = x.w ?? x.word ?? x.text;
      const s = x.s ?? x.start;
      const e = x.e ?? x.end;
      if (typeof w === 'string' && w.trim()) outList.push([w.trim(), Number(s), Number(e)]);
    }
  }
  if (!outList.length) throw new CliError('לא נמצאו מילים בקובץ התמלול');
  for (const [w, s, e] of outList) if (!Number.isFinite(s) || !Number.isFinite(e)) throw new CliError(`זמן לא תקין במילה "${w}"`);
  return outList;
}

function readJsonFile(file) {
  let text;
  if (file === '-') text = fs.readFileSync(0, 'utf8');
  else {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new CliError(`הקובץ לא נמצא: ${abs}`);
    text = fs.readFileSync(abs, 'utf8');
  }
  text = text.replace(/^﻿/, '');
  try { return JSON.parse(text); } catch (e) { throw new CliError(`JSON לא תקין ב-${file}: ${e.message}`); }
}

function looksLikeMediaId(s) { return /^m_[A-Za-z0-9_-]+$/.test(s) && !fs.existsSync(path.resolve(s)); }

/** "א,ב، ג" → ["א","ב","ג"] */
function splitList(v) { return String(v).split(/[,،]/).map((x) => x.trim()).filter(Boolean); }

/**
 * --script "text" | --script-file <file>. A .json file may be a Chordix video.json ({script}), {script|text} or [tokens];
 * anything else is read as plain text. → string | string[] | null
 */
export function readScriptArg(F) {
  if (F.script !== undefined && F.script !== true) {
    const s = String(F.script).trim();
    if (!s) throw new CliError('--script ריק');
    return s;
  }
  const file = F['script-file'];
  if (file === undefined || file === true) return null;
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) throw new CliError(`קובץ התסריט לא נמצא: ${abs}`);
  const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  if (/\.json$/i.test(abs)) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new CliError(`JSON לא תקין ב-${abs}: ${e.message}`); }
    const sc = Array.isArray(data) ? data : data && (data.script ?? data.text);
    if (Array.isArray(sc) && sc.length) return sc.map(String);
    if (typeof sc === 'string' && sc.trim()) return sc.trim();
    throw new CliError(`לא נמצא שדה "script" ב-${abs}`);
  }
  if (!text.trim()) throw new CliError(`קובץ התסריט ריק: ${abs}`);
  return text.trim();
}

// ───────────────────────────── HTTP ─────────────────────────────

async function request(method, p, body, { timeout = 120000 } = {}) {
  const init = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(body);
  }
  if (timeout) init.signal = AbortSignal.timeout(timeout);
  let res;
  try {
    res = await fetch(BASE + p, init);
  } catch (e) {
    const code = e && e.cause && e.cause.code ? e.cause.code : e && e.name === 'TimeoutError' ? 'timeout' : e && e.message;
    throw new CliError(`אין חיבור לשרת ${BASE} (${code})`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && data.error ? data.error : `${res.status} ${res.statusText}`;
    const e = new CliError(`השרת החזיר שגיאה (${res.status}): ${msg}`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

async function health() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

let serverReady = false;
async function ensureServer() {
  if (serverReady) return;
  if (await health()) { serverReady = true; return; }
  if (process.env.CUTX_NO_AUTOSTART === '1' || BASE !== DEFAULT_URL) throw new CliError(`השרת לא פעיל ב-${BASE}`);
  const main = path.join(ROOT, 'server', 'main.mjs');
  if (!fs.existsSync(main)) throw new CliError(`השרת לא פעיל ולא נמצא הקובץ ${main}`);
  err('מפעיל את שרת Frame Studio…');
  const child = spawn(process.execPath, [main], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    await sleep(300);
    if (await health()) { serverReady = true; return; }
  }
  throw new CliError(`השרת לא עלה תוך 10 שניות — בדוק את ${path.join(ROOT, 'server.log')}`);
}

const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
  del: (p, o) => request('DELETE', p, undefined, o),
};
const enc = encodeURIComponent;

async function getProject(id) { return api.get(`/api/projects/${enc(id)}`); }

async function postOps(id, ops, { summary, atomic } = {}) {
  return api.post(`/api/projects/${enc(id)}/ops`, { ops, by: 'claude', summary: summary || summarizeOps(ops), atomic: !!atomic });
}

// ───────────────────────────── jobs ─────────────────────────────

function jobState(j) {
  if (!j || typeof j !== 'object') return 'running';
  const s = String(j.status ?? j.state ?? '').toLowerCase();
  if (['done', 'finished', 'complete', 'completed', 'success', 'succeeded', 'ok'].includes(s) || j.done === true || j.finished === true) return 'done';
  if (['failed', 'fail', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'timeout'].includes(s)) return 'failed';
  if (!s && j.error) return 'failed';
  return 'running';
}

function jobId(j) { return j && (j.id || j.jobId || j.job || (j.job && j.job.id)); }

function progressLine(label, j) {
  const p = Number(j.progress);
  const pct = Number.isFinite(p) ? Math.round(p * 100) : null;
  const eta = Number(j.eta);
  return `${label}${pct !== null ? ` ${pct}%` : '…'}${j.frames ? ` (${j.frames}${j.totalFrames ? '/' + j.totalFrames : ''} פריימים)` : ''}${Number.isFinite(eta) && eta > 0 ? ` · נותרו כ-${Math.ceil(eta)} שנ'` : ''}`;
}

async function waitJob(job0, label, { quiet = false, maxMs = 30 * 60 * 1000 } = {}) {
  let job = job0 && job0.job && typeof job0.job === 'object' ? job0.job : job0;
  const id = typeof job === 'string' ? job : jobId(job);
  if (!id) return job;
  if (typeof job === 'object' && jobState(job) === 'done') return job;
  const t0 = Date.now();
  let lastShown = '';
  const tty = process.stderr.isTTY;
  for (;;) {
    job = await api.get(`/api/jobs/${enc(id)}`);
    const st = jobState(job);
    if (st === 'done') { if (!quiet && tty && lastShown) process.stderr.write('\n'); return job; }
    if (st === 'failed') { if (!quiet && tty && lastShown) process.stderr.write('\n'); throw new CliError(`${label} נכשל: ${job.error || job.message || 'שגיאה לא ידועה'}`); }
    if (!quiet) {
      const line = progressLine(label, job);
      if (line !== lastShown) {
        if (tty) process.stderr.write('\r' + line.padEnd(60));
        else if (!lastShown || Math.abs((Number(job.progress) || 0) * 10 - Math.round((Number(job.progress) || 0) * 10)) < 0.05) err(line);
        lastShown = line;
      }
    }
    if (Date.now() - t0 > maxMs) throw new CliError(`${label}: תם הזמן להמתנה (job ${id})`);
    await sleep(700);
  }
}

/** Collect file paths from a finished job (outputs/files/pngs/paths/out/output/result), absolute. */
function jobFiles(job) {
  const found = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === 'string') { found.push(v); return; }
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v === 'object') {
      if (typeof v.path === 'string') found.push(v.path);
      else if (typeof v.file === 'string') found.push(v.file);
      else if (typeof v.abs === 'string') found.push(v.abs);
      else Object.values(v).forEach(push);
    }
  };
  for (const k of ['outputs', 'files', 'pngs', 'paths', 'out', 'output', 'sheet']) push(job[k]);
  if (job.result && typeof job.result === 'object') for (const k of ['outputs', 'files', 'pngs', 'paths', 'out', 'output', 'sheet']) push(job.result[k]);
  const seen = new Set();
  return found.map((f) => (path.isAbsolute(f) ? f : path.resolve(ROOT, f))).filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
}

// ───────────────────────────── formatting ─────────────────────────────

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const dbStr = (g) => { const d = gainToDb(Number(g)); return Number.isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(1)} dB` : '-∞ dB'; };

function clipLabel(c) {
  if (c.type === 'text' || c.type === 'caption') return `"${trunc(c.text && c.text.content, 40)}"`;
  if (c.type === 'sticker') return `${c.sticker && c.sticker.value}`;
  if (c.type === 'shape') return `${c.shape && c.shape.kind}`;
  if (c.type === 'effect') return (c.effects || []).map((e) => e.id).join('+') || 'אפקט';
  return c.name ? `"${trunc(c.name, 40)}"` : '';
}

function clipExtras(c, P) {
  const x = [];
  if (c.disabled) x.push('מושבת');
  if (c.mediaId) {
    const m = P.media && P.media[c.mediaId];
    x.push(`מדיה ${c.mediaId}${m && m.status && m.status !== 'ready' ? ` (${m.status === 'processing' ? 'בעיבוד' : 'שגיאה'})` : ''}`);
    if (c.in) x.push(`in ${f2(c.in)}`);
    if (c.speed && c.speed !== 1) x.push(`מהירות ×${c.speed}`);
    if (c.reverse) x.push('הפוך');
  }
  if (c.type === 'audio' || (c.type === 'video' && !c.muteAudio)) {
    if (c.volume !== undefined && Math.abs(c.volume - 1) > 1e-6) x.push(dbStr(c.volume));
    if (c.fadeIn) x.push(`כניסה ${f2(c.fadeIn)}`);
    if (c.fadeOut) x.push(`יציאה ${f2(c.fadeOut)}`);
  }
  if (c.type === 'video' && c.muteAudio) x.push('מושתק');
  if (c.animIn && c.animIn.id !== 'none') x.push(`אנימציה↓${c.animIn.id}`);
  if (c.animOut && c.animOut.id !== 'none') x.push(`אנימציה↑${c.animOut.id}`);
  if (c.animLoop && c.animLoop.id !== 'none') x.push(`לולאה ${c.animLoop.id}`);
  if (c.transitionOut && c.transitionOut.id !== 'none') x.push(`מעבר→ ${c.transitionOut.id} ${f2(c.transitionOut.duration)}`);
  if (c.effects && c.effects.length && c.type !== 'effect') x.push(`אפקטים: ${c.effects.map((e) => e.id).join(',')}`);
  if (c.filter && c.filter.id && c.filter.id !== 'none') x.push(`פילטר ${c.filter.id}`);
  const kf = Object.entries(c.keyframes || {}).filter(([, v]) => v && v.length);
  if (kf.length) x.push(`קיפריימים: ${kf.map(([k, v]) => `${k}(${v.length})`).join(' ')}`);
  if (c.type === 'caption') {
    const hot = (c.caption.words || []).filter((w) => w.hot).map((w) => w.w);
    x.push(`סגנון ${c.caption.style}`);
    if (hot.length) x.push(`מודגש: ${hot.join(' ')}`);
  }
  if (c.transform && (c.transform.x || c.transform.y)) x.push(`מיקום (${Math.round(c.transform.x)},${Math.round(c.transform.y)})`);
  if (c.transform && c.transform.scale !== 1) x.push(`קנה מידה ${c.transform.scale}`);
  return x;
}

function printProject(P) {
  const S = P.settings || {};
  const dur = projectDuration(P);
  out(`פרויקט "${P.name}" (${P.id}) · ${S.width}×${S.height} · ${S.fps}fps · משך ${f2(dur)} שנ' (${formatTimecode(dur, S.fps)}) · rev ${P.rev}`);
  out('');
  out('ערוצים (מלמעלה למטה; הערוץ העליון מצויר מעל):');
  (P.tracks || []).forEach((t, i) => {
    const flags = [t.hidden && 'מוסתר', t.muted && 'מושתק', t.locked && 'נעול', t.solo && 'סולו', t.kind === 'audio' && t.volume !== 1 && `עוצמה ${dbStr(t.volume)}`, t.captions && 'כתוביות'].filter(Boolean);
    const n = clipsOnTrack(P, t.id).length;
    out(`  ${pad(i, 3)}${pad(t.id, 16)}${pad(TRACK_KIND_LABELS[t.kind] || t.kind, 7)}${pad(ROLE_LABELS[t.role] || t.role, 14)}${pad(`"${t.name}"`, 20)}${pad(`${n} קליפים`, 11)}${flags.join(' · ')}`);
  });
  out('');
  const total = Object.keys(P.clips || {}).length;
  out(`קליפים (${total}):`);
  for (const t of P.tracks || []) {
    const list = clipsOnTrack(P, t.id);
    if (!list.length) continue;
    out(`  [${t.name} · ${t.id}]`);
    for (const c of list) {
      const ex = clipExtras(c, P);
      out(`    ${pad(c.id, 14)}${pad(CLIP_TYPE_LABELS[c.type] || c.type, 11)}${pad(`${f2(c.start)}–${f2(clipEnd(c))}`, 14)}${pad(`(${f2(c.duration)})`, 9)}${clipLabel(c)}${ex.length ? '  · ' + ex.join(' · ') : ''}`);
    }
  }
  const orphan = Object.values(P.clips || {}).filter((c) => !(P.tracks || []).some((t) => t.id === c.trackId));
  for (const c of orphan) out(`  ! ${c.id} בערוץ לא קיים (${c.trackId})`);
  out('');
  if ((P.markers || []).length) {
    out('סמנים:');
    for (const m of P.markers) out(`  ${pad(m.id, 14)}${pad(f2(m.t), 8)}"${m.label || ''}"`);
    out('');
  }
  const words = (P.transcript && P.transcript.words) || [];
  if (words.length) out(`תמלול: ${words.length} מילים (${f2(words[0].s)}–${f2(words[words.length - 1].e)}) — רשימה מלאה: cutx words ${P.id}`);
  else out('תמלול: אין (cutx transcript / cutx transcribe)');
  const media = Object.values(P.media || {});
  out(`מדיה: ${media.length} קבצים${media.some((m) => m.status === 'processing') ? ` (${media.filter((m) => m.status === 'processing').length} בעיבוד)` : ''} — cutx media ${P.id}`);
  const probs = validateProject(P);
  if (probs.length) { out(''); out(`אזהרות (${probs.length}):`); for (const p of probs) out(`  ⚠ ${p}`); }
}

function printResults(r, ops) {
  const results = (r && r.results) || [];
  let bad = 0;
  results.forEach((x, i) => {
    const op = ops && ops[i] ? ops[i].op : x.op;
    if (x.ok) {
      const ids = x.ids && x.ids.length ? ` → ${x.ids.length > 6 ? x.ids.slice(0, 6).join(', ') + ` …(${x.ids.length})` : x.ids.join(', ')}` : x.id ? ` → ${x.id}` : '';
      const extra = [x.track && `ערוץ ${x.track}`, x.start !== undefined && `התחלה ${f2(x.start)}`, x.duration !== undefined && `משך ${f2(x.duration)}`, x.chunks && `מקטעים [${x.chunks.join(',')}]`].filter(Boolean);
      out(`✓ ${pad(i + 1, 3)}${pad(op, 16)}${ids}${extra.length ? '  (' + extra.join(', ') + ')' : ''}`);
    } else {
      bad++;
      out(`✗ ${pad(i + 1, 3)}${pad(op || '?', 16)}${x.error}`);
    }
    if (x.ok && x.coverage !== undefined && x.method) {
      out(`      יישור לתסריט: ${x.count} מילים מ-${x.asrCount} מילות ASR · התאמת אותיות ${Math.round(x.coverage * 100)}%${x.method === 'index' ? ' (לפי הסדר בלבד!)' : ''}`);
      const ch = x.changes || [];
      for (const c of ch.slice(0, 60)) out(`      ${pad(f2(c.s), 7)}${c.asr ? `"${c.asr}"` : '(חסר ב-ASR)'} → ${c.script ? `"${c.script}"` : '(לא בתסריט — הושמט)'}`);
      if (ch.length > 60) out(`      … ועוד ${ch.length - 60} תיקונים`);
      if (!ch.length) out('      התמלול זהה לתסריט');
    }
    for (const w of x.warnings || []) out(`      ⚠ ${w}`);
  });
  if (r && r.rev !== undefined) out(`\nגרסה ${r.rev}${bad ? ` · ${bad} פעולות נכשלו` : ' · הכול הצליח'}`);
  return bad;
}

const REPORT_LABELS = {
  duration: 'משך', size: 'גודל', lufs: 'עוצמה (LUFS)', integratedLufs: 'עוצמה (LUFS)', truePeak: 'שיא אמיתי (dBTP)', tp: 'שיא אמיתי (dBTP)',
  out: 'קובץ', output: 'קובץ', file: 'קובץ', fps: 'פריימים לשנייה', frames: 'פריימים', width: 'רוחב', height: 'גובה', elapsed: 'זמן עבודה',
};

function fmtBytes(n) { n = Number(n); if (!Number.isFinite(n)) return String(n); return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`; }

function printSpeechMargin(sm) {
  if (!sm || typeof sm !== 'object') return;
  const min = sm.min ?? sm.minDb ?? (sm.worst && typeof sm.worst === 'object' ? sm.worst.margin : sm.worst);
  if ((min === null || min === undefined) && !(Array.isArray(sm.below) && sm.below.length)) {
    out('הקול מעל הרקע: לא נמדד (אין קריינות פעילה בערוץ קריינות)');
    return;
  }
  const med = sm.median ?? sm.medianDb;
  const belowList = sm.below ?? sm.belowTimes ?? sm.windowsBelow ?? sm.under;
  const count = Array.isArray(belowList) ? belowList.length : sm.countBelow ?? sm.belowCount ?? (typeof belowList === 'number' ? belowList : 0);
  const okMargin = sm.ok !== undefined ? sm.ok !== false : Number.isFinite(+min) && min !== null ? +min >= 12 : count === 0;
  out(`הקול מעל הרקע: מינימום ${f2(min)} dB · חציון ${f2(med)} dB · חלונות מתחת ל-12 dB: ${count}  ${okMargin ? '✓ עומד ביעד (≥ 12 dB)' : '✗ לא עומד ביעד — הנמך מוזיקה/אפקטים בזמנים האלה'}`);
  if (Array.isArray(belowList) && belowList.length) {
    const shown = belowList.slice(0, 20).map((b) => (typeof b === 'number' ? f2(b) : b && typeof b === 'object' ? `${f2(b.t ?? b.time ?? b.s)}${b.db !== undefined || b.margin !== undefined ? ` (${f2(b.db ?? b.margin)} dB)` : ''}` : String(b)));
    out(`  זמנים: ${shown.join(', ')}${belowList.length > 20 ? ' …' : ''}`);
  }
}

function marginFailed(sm) {
  if (!sm || typeof sm !== 'object') return false;
  if (sm.ok === false) return true;
  return Number.isFinite(+sm.min) && sm.min !== null && +sm.min < 12;
}

function printReport(rep) {
  if (!rep || typeof rep !== 'object') return;
  if (typeof rep.summary === 'string' && rep.summary.trim()) {
    for (const line of rep.summary.split('\n')) out(`  ${line}`);
    const lufs = rep.lufs ?? rep.integratedLufs;
    if (Number.isFinite(+lufs) && lufs !== null) out(`  ${Math.abs(+lufs + 14) <= 1 ? '✓ עוצמה סביב ‎-14 LUFS (סטנדרט רשתות)' : '⚠ העוצמה רחוקה מ-‎-14 LUFS'}`);
    const sm = rep.speechMargin || rep.speech || rep.margin;
    if (sm && typeof sm === 'object') printSpeechMargin(sm);
    return;
  }
  for (const [k, v] of Object.entries(rep)) {
    if (k === 'speechMargin' || k === 'speech' || k === 'margin') continue;
    if (v === null || v === undefined || typeof v === 'object') continue;
    const label = REPORT_LABELS[k] || k;
    let val = v;
    if (k === 'size') val = fmtBytes(v);
    else if (typeof v === 'number') val = f2(v);
    out(`  ${pad(label + ':', 20)}${val}`);
  }
  const lufs = rep.lufs ?? rep.integratedLufs;
  if (Number.isFinite(+lufs)) out(`  ${Math.abs(+lufs + 14) <= 1 ? '✓ עוצמה סביב ‎-14 LUFS (סטנדרט רשתות)' : '⚠ העוצמה רחוקה מ-‎-14 LUFS'}`);
  printSpeechMargin(rep.speechMargin || rep.speech || rep.margin);
}

// ───────────────────────────── balance: voice above background ─────────────────────────────
// Like the Chordix workshop "מאזן" (build-video.py): wherever speech is active the voice must be ≥ target dB above
// music + sfx. check-audio reports the failing 0.1 s windows; for each one we find the background clips audible there,
// estimate who is to blame (peaks × volume × keyframes × fades × track volume × ducking — the renderer's gain model),
// lower ONLY those clips, ONLY there (volume keyframes: dip = window ±0.1 s with 0.05 s ramps, depth = deficit + 1 dB,
// merged with neighbouring dips, existing keyframes/fades preserved), apply as one batch, re-check. Never raises the voice.

export const BALANCE = Object.freeze({ win: 0.1, grid: 0.05, pad: 0.1, extraDb: 1, maxDipDb: 48, mergeGap: 0.2, step: 0.01 });
const DECLICK = 0.002; // render/audio-engine.js de-click ramp at clip edges

const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const lin = (db) => Math.pow(10, db / 20);
const toDb = (g) => (g > 1e-12 ? 20 * Math.log10(g) : -240);

/** Audible non-voice clips (the "background" stem): audio clips and video clips with sound, on non-voice tracks. */
export function backgroundItems(P) {
  const tracks = new Map((P.tracks || []).map((t) => [t.id, t]));
  const solo = (P.tracks || []).some((t) => t.solo);
  const items = [];
  for (const c of Object.values(P.clips || {})) {
    if (!c || c.disabled || c.muteAudio || (c.type !== 'audio' && c.type !== 'video')) continue;
    const m = P.media && P.media[c.mediaId];
    if (!m) continue;
    if (c.type === 'video' && !(m.hasAudio || m.audio)) continue;
    if (c.type === 'audio' && m.hasAudio === false && !m.audio) continue;
    const t = tracks.get(c.trackId);
    if (!t || t.role === 'voice' || t.muted || (solo && !t.solo)) continue;
    if (!(numOr(c.duration, 0) > 0)) continue;
    items.push({ clip: c, media: m, track: t });
  }
  return items;
}

/** clip volume × volume keyframes at timeline time t (same as render/audio-engine.js volumeAt). */
export function clipVolumeAt(c, t) {
  const base = clampN(numOr(c.volume, 1), 0, 4);
  const list = c.keyframes && c.keyframes.volume;
  if (!Array.isArray(list) || !list.length) return base;
  return clampN(numOr(interpolateKeyframes(list, t - c.start, base), base), 0, 4);
}

/** fades + de-click at timeline time t (same as render/audio-engine.js edgeGainAt). */
export function clipEdgeAt(c, t) {
  const dur = Math.max(0, numOr(c.duration, 0));
  let fi = Math.max(numOr(c.fadeIn, 0), DECLICK), fo = Math.max(numOr(c.fadeOut, 0), DECLICK);
  if (fi + fo > dur && dur > 0) { const k = dur / (fi + fo); fi *= k; fo *= k; }
  const u = t - c.start;
  if (u < 0 || u > dur) return 0;
  const shape = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.sin(p * Math.PI * 0.5));
  let g = 1;
  if (u < fi) g *= shape(u / fi);
  if (dur - u < fo) g *= shape((dur - u) / fo);
  return g;
}

function itemGainAt(it, t) {
  const fx = it.clip.audioFx || {};
  const duck = fx.duckUnderVoice ? lin(Math.min(0, numOr(fx.duckDb, -10))) : 1; // speech windows → fully ducked
  return clipVolumeAt(it.clip, t) * clipEdgeAt(it.clip, t) * clampN(numOr(it.track.volume, 1), 0, 4) * duck;
}

/** Source position (s, forward media time) of timeline time t. */
function sourcePos(c, t) {
  const speed = clampN(Number(c.speed) || 1, 0.05, 16);
  const inn = Math.max(0, Number(c.in) || 0);
  const u = t - c.start;
  return c.reverse ? inn + c.duration * speed - u * speed : inn + u * speed;
}

/** peaks: {rate, peaks:[0..1]} | null → |sample| peak at source time (unknown peaks → a flat 0.3). */
function peakAt(pk, pos) {
  if (!pk || !Array.isArray(pk.peaks) || !pk.peaks.length) return 0.3;
  const i = Math.floor(pos * (pk.rate || 100));
  return i >= 0 && i < pk.peaks.length ? numOr(pk.peaks[i], 0) : 0;
}

/** Mean energy estimate of a background item in [t0, t1) (relative units — only shares matter). */
export function itemLevel(it, pk, t0, t1, step = BALANCE.step) {
  const a = Math.max(t0, it.clip.start), b = Math.min(t1, it.clip.start + it.clip.duration);
  if (!(b > a)) return 0;
  let e = 0, n = 0;
  for (let t = a + step / 2; t < b; t += step) { const v = peakAt(pk, sourcePos(it.clip, t)) * itemGainAt(it, t); e += v * v; n++; }
  if (!n) { const t = (a + b) / 2; const v = peakAt(pk, sourcePos(it.clip, t)) * itemGainAt(it, t); e = v * v; n = 1; }
  return (e / n) * ((b - a) / (t1 - t0));
}

/**
 * One balancing round: failing windows → dips per guilty clip.
 * below: [{t, margin}] from check-audio (window = [t, t+win)); peaks: Map mediaId → {rate, peaks}
 * → { dips: Map clipId → [{t0, t1, depth, share}], windows:[{t, margin, deficit, guilty:[{id, share}], depth, reason?}], locked:Set }
 */
export function planBalance(P, below, { target = 12, peaks = new Map(), win = BALANCE.win, extraDb = BALANCE.extraDb, maxDipDb = BALANCE.maxDipDb } = {}) {
  const items = backgroundItems(P);
  const dips = new Map();
  const windows = [];
  const locked = new Set();
  for (const b of below || []) {
    const margin = Number(b && (b.margin ?? b.db));
    const t0 = Number(b && (b.t ?? b.time));
    if (!Number.isFinite(margin) || !Number.isFinite(t0)) continue;
    const deficit = target - margin;
    if (!(deficit > 0)) continue;
    const t1 = t0 + win;
    const act = items.filter((it) => it.clip.start < t1 && it.clip.start + it.clip.duration > t0);
    if (!act.length) { windows.push({ t: t0, margin, deficit, guilty: [], depth: 0, reason: 'אין קליפ רקע פעיל בחלון' }); continue; }
    const lv = act.map((it) => ({ it, e: itemLevel(it, peaks.get(it.clip.mediaId), t0, t1) }));
    let total = lv.reduce((a, x) => a + x.e, 0);
    if (!(total > 0)) { lv.forEach((x) => { x.e = 1; }); total = lv.length; }
    lv.sort((a, b2) => b2.e - a.e);
    const allowed = Math.pow(10, -(deficit + extraDb) / 10); // background energy fraction that may remain
    const guilty = [];
    let rest = total;
    for (const x of lv) {
      if (rest / total <= allowed / 2 || !(x.e > 0)) break;
      guilty.push(x);
      rest -= x.e;
    }
    const r = Math.max(0, rest / total);
    const depth = Math.min(maxDipDb, Math.max(deficit + extraDb, 10 * Math.log10((1 - r) / Math.max(1e-12, allowed - r))));
    const w = { t: t0, margin, deficit: r6(deficit), depth: Math.round(depth * 100) / 100, guilty: guilty.map((x) => ({ id: x.it.clip.id, share: Math.round((x.e / total) * 1000) / 1000 })) };
    windows.push(w);
    for (const x of guilty) {
      if (x.it.track.locked) { locked.add(x.it.clip.id); continue; }
      if (!dips.has(x.it.clip.id)) dips.set(x.it.clip.id, []);
      dips.get(x.it.clip.id).push({ t0, t1, depth: w.depth, share: x.e / total });
    }
  }
  return { dips, windows, locked };
}

/**
 * Dips → gain envelope points [{t, db}] (absolute time, db ≤ 0; piecewise linear in gain between points).
 * Plateau = window ±pad on a `grid` lattice, ramps of one grid step, dips closer than mergeGap are bridged.
 */
export function dipEnvelope(dips, { grid = BALANCE.grid, pad = BALANCE.pad, mergeGap = BALANCE.mergeGap } = {}) {
  const m = new Map();
  for (const d of dips) {
    const i0 = Math.round((d.t0 - pad) / grid), i1 = Math.round((d.t1 + pad) / grid);
    for (let i = i0; i <= i1; i++) m.set(i, Math.max(m.get(i) || 0, d.depth));
  }
  let idx = [...m.keys()].sort((a, b) => a - b);
  const gapSteps = Math.round(mergeGap / grid);
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    if (b - a > 1 && b - a <= gapSteps) { const d = Math.min(m.get(a), m.get(b)); for (let i = a + 1; i < b; i++) m.set(i, d); }
  }
  idx = [...m.keys()].sort((a, b) => a - b);
  const pts = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (k === 0 || idx[k - 1] !== i - 1) pts.push({ t: r6((i - 1) * grid), db: 0 });
    pts.push({ t: r6(i * grid), db: -m.get(i) });
    if (k === idx.length - 1 || idx[k + 1] !== i + 1) pts.push({ t: r6((i + 1) * grid), db: 0 });
  }
  // drop plateau interior points
  return pts.filter((p, k) => k === 0 || k === pts.length - 1 || !(pts[k - 1].db === p.db && pts[k + 1].db === p.db));
}

/** Envelope gain (linear) at absolute time t. */
export function envelopeGain(env, t) {
  if (!env.length || t <= env[0].t || t >= env[env.length - 1].t) return 1;
  let i = 0;
  while (i < env.length - 2 && env[i + 1].t <= t) i++;
  const a = env[i], b = env[i + 1];
  const p = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return lin(a.db) + (lin(b.db) - lin(a.db)) * p;
}

/** Insert a keyframe at local time t without changing the curve (eased segments are split exactly with part(a,b,ease)). */
function insertKey(keys, t, base) {
  if (!keys.length) return [{ t, v: base, ease: 'linear' }];
  if (t < keys[0].t) return [{ t, v: keys[0].v, ease: 'linear' }, ...keys];
  const last = keys[keys.length - 1];
  if (t > last.t) return [...keys, { t, v: last.v, ease: 'linear' }];
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const v = interpolateKeyframes(keys, t, base);
  const ez = b.ease || 'linear';
  const out = keys.slice();
  const pc = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  if (ez === 'linear' || ez === 'hold') { out.splice(i + 1, 0, { t, v, ease: ez }); return out; }
  const part = parsePartEase(ez);
  const inner = getEase(part ? part.inner : ez);
  const A0 = part ? part.a : 0, B0 = part ? part.b : 1, M = A0 + (B0 - A0) * pc;
  const exact = Math.abs(inner(M) - inner(A0)) > 1e-9 && Math.abs(inner(B0) - inner(M)) > 1e-9;
  if (!exact) { out.splice(i + 1, 0, { t, v, ease: 'linear' }); return out; }
  out[i + 1] = { ...b, ease: partEase(ez, pc, 1) };
  out.splice(i + 1, 0, { t, v, ease: partEase(ez, 0, pc) });
  return out;
}

/** Remove keys that do not change the curve. */
function simplifyKeys(keys) {
  const k = keys.slice();
  const same = (a, b) => Math.abs(a - b) < 1e-6;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < k.length - 1; i++) {
      const p = k[i - 1], c = k[i], n = k[i + 1];
      const flat = same(p.v, c.v) && same(c.v, n.v);
      const straight = c.ease === 'linear' && n.ease === 'linear' && n.t > p.t && same(p.v + ((n.v - p.v) * (c.t - p.t)) / (n.t - p.t), c.v);
      if (flat || straight) { k.splice(i, 1); changed = true; break; }
    }
  }
  while (k.length >= 2 && same(k[0].v, k[1].v)) k.shift();
  while (k.length >= 2 && same(k[k.length - 1].v, k[k.length - 2].v)) k.pop();
  return k;
}

/**
 * Compose a dip envelope (absolute time) into a clip's volume keyframes. Keeps the existing curve (keyframes, base volume)
 * and multiplies it by the envelope. → keys [{t (local), v, ease}] | [] (no keyframes needed) | null (envelope misses the clip)
 */
export function composeVolumeKeys(c, env) {
  const S = c.start, dur = c.duration;
  const base = clampN(numOr(c.volume, 1), 0, 4);
  if (!env.length || env[env.length - 1].t <= S || env[0].t >= S + dur) return null;
  const old = (Array.isArray(c.keyframes && c.keyframes.volume) ? c.keyframes.volume : [])
    .filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.v)).map((k) => ({ t: k.t, v: k.v, ease: k.ease || 'linear' }))
    .sort((a, b) => a.t - b.t);
  // envelope breakpoints inside the clip (a point exactly on an edge counts), plus the edges when a dip crosses them
  const bps = env.map((p) => r6(p.t - S)).filter((t) => t >= -1e-6 && t <= dur + 1e-6).map((t) => clampN(t, 0, r6(dur)));
  if (envelopeGain(env, S) < 1 - 1e-9) bps.push(0);
  if (envelopeGain(env, S + dur) < 1 - 1e-9) bps.push(r6(dur));
  let keys = old;
  for (const t of bps) {
    if (keys.some((k) => Math.abs(k.t - t) < 0.002)) continue; // an existing key there — reuse it
    keys = insertKey(keys, t, base);
  }
  keys = keys.map((k) => ({ t: r6(k.t), v: r6(clampN(k.v * envelopeGain(env, S + k.t), 0, 4)), ease: k.ease }));
  keys = simplifyKeys(keys);
  if (keys.length === 1 && Math.abs(keys[0].v - base) < 1e-6) keys = [];
  return keys;
}

/** Plan → ops (one setKeyframes / clearKeyframes per guilty clip). */
export function balanceOps(P, plan, opts = {}) {
  const ops = [];
  for (const [id, list] of plan.dips) {
    const c = P.clips[id];
    if (!c) continue;
    const keys = composeVolumeKeys(c, dipEnvelope(list, opts));
    if (keys === null) continue;
    ops.push(keys.length ? { op: 'setKeyframes', id, prop: 'volume', replace: true, keys } : { op: 'clearKeyframes', id, prop: 'volume' });
  }
  return ops;
}

/** Total reduction per clip between two project states → [{id, name, regions, seconds, maxDb}] */
export function dipSummary(P0, P1, ids) {
  const out = [];
  for (const id of ids) {
    const a = P0.clips[id], b = P1.clips[id];
    if (!a || !b) continue;
    let regions = 0, secs = 0, maxDb = 0, inside = false;
    const step = BALANCE.step;
    for (let t = b.start; t < b.start + b.duration; t += step) {
      const g0 = clipVolumeAt(a, t), g1 = clipVolumeAt(b, t);
      const red = g0 > 1e-9 ? toDb(Math.max(g1, 1e-12) / g0) : 0;
      if (red < -0.5) { if (!inside) regions++; inside = true; secs += step; maxDb = Math.min(maxDb, red); } else inside = false;
    }
    out.push({ id, name: b.name || id, track: b.trackId, regions, seconds: Math.round(secs * 100) / 100, maxDb: Math.round(maxDb * 10) / 10 });
  }
  return out;
}

/** Speech spans from the transcript (merged when < 0.12 s apart). */
function speechSpans(P) {
  const words = ((P.transcript && P.transcript.words) || []).filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e)).sort((x, y) => x.s - y.s);
  const spans = [];
  for (const w of words) {
    const last = spans[spans.length - 1];
    if (last && w.s - last.e < 0.12) { last.e = Math.max(last.e, w.e); last.w2 = w.w; } else spans.push({ s: w.s, e: w.e, w1: w.w, w2: w.w });
  }
  return spans;
}

/** sfx clips that sit mostly on top of speech → suggestion to move them into a gap between words. */
export function sfxSuggestions(P, ids, peaks) {
  const spans = speechSpans(P);
  if (!spans.length) return [];
  const gaps = [];
  if (spans[0].s >= 0.15) gaps.push({ s: 0, e: spans[0].s, before: null, after: spans[0].w1 });
  for (let i = 0; i < spans.length - 1; i++) if (spans[i + 1].s - spans[i].e >= 0.15) gaps.push({ s: spans[i].e, e: spans[i + 1].s, before: spans[i].w2, after: spans[i + 1].w1 });
  const inSpeech = (t) => spans.some((s) => t >= s.s && t < s.e);
  const items = backgroundItems(P).filter((it) => ids.includes(it.clip.id) && it.track.role === 'sfx');
  const out = [];
  for (const it of items) {
    const c = it.clip, pk = peaks.get(c.mediaId);
    let eAll = 0, eSp = 0, best = -1, peakT = c.start;
    for (let t = c.start + BALANCE.step / 2; t < c.start + c.duration; t += BALANCE.step) {
      const v = peakAt(pk, sourcePos(c, t)) * itemGainAt(it, t);
      const e = v * v;
      eAll += e;
      if (inSpeech(t)) eSp += e;
      if (v > best) { best = v; peakT = t; }
    }
    if (!(eAll > 0) || eSp / eAll <= 0.5) continue;
    const gap = gaps.filter((g) => g.e - g.s >= 0.15).sort((x, y) => Math.abs((x.s + x.e) / 2 - peakT) - Math.abs((y.s + y.e) / 2 - peakT))[0];
    const sug = { id: c.id, name: c.name || c.id, onSpeech: Math.round((eSp / eAll) * 100), peakAt: Math.round(peakT * 100) / 100 };
    if (gap) {
      const mid = (gap.s + gap.e) / 2;
      Object.assign(sug, { gap: [Math.round(gap.s * 100) / 100, Math.round(gap.e * 100) / 100], before: gap.before, after: gap.after, start: Math.max(0, Math.round((mid - (peakT - c.start)) * 100) / 100) });
    }
    out.push(sug);
  }
  return out;
}

async function fetchPeaks(projectId, P) {
  const map = new Map();
  for (const it of backgroundItems(P)) {
    const m = it.media;
    if (map.has(m.id)) continue;
    let pk = null;
    try { pk = await api.get(`/api/projects/${enc(projectId)}/media/${enc(m.id)}/peaks`, { timeout: 20000 }); } catch { pk = null; }
    if ((!pk || !Array.isArray(pk.peaks)) && m.library && m.library.soundId) {
      try { pk = await api.get(`/api/library/sounds/${enc(m.library.soundId)}/peaks`, { timeout: 60000 }); } catch { pk = null; }
    }
    if (Array.isArray(pk)) pk = { rate: 100, peaks: pk };
    if (!pk || !Array.isArray(pk.peaks)) {
      try { pk = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects', projectId, 'cache', 'peaks', `${m.id}.json`), 'utf8')); } catch { pk = null; }
    }
    map.set(m.id, pk && Array.isArray(pk.peaks) ? { rate: numOr(pk.rate, 100), peaks: pk.peaks } : null);
  }
  return map;
}

async function speechCheck(id, target, quiet) {
  let job;
  try { job = await api.post(`/api/projects/${enc(id)}/check-audio`, { threshold: target }); }
  catch (e) {
    if (e.status !== 404 && e.status !== 405) throw e;
    job = await api.post(`/api/projects/${enc(id)}/export`, { stemsOnly: true, audioOnly: true, check: true, threshold: target });
  }
  const done = await waitJob(job, 'בדיקת שמע', { quiet });
  const rep = done.report || done.result || done;
  return rep.speechMargin || rep.speech || rep.margin || null;
}

const smLine = (sm, target) => `מינימום ${f2(sm.min)} dB${sm.worst ? ` ב-${f2(sm.worst.t)} שנ'` : ''} · חציון ${f2(sm.median)} dB · ${sm.belowCount ?? (sm.below || []).length} חלונות מתחת ל-${target} dB`;
const smOk = (sm, target) => sm && (sm.min === null || sm.min === undefined || +sm.min >= target);

async function cmdBalance(A, id) {
  const F = A.flags;
  need(id, 'מזהה פרויקט');
  const target = F.target !== undefined ? Number(F.target) : 12;
  const maxRounds = F['max-rounds'] !== undefined ? Math.max(1, Math.trunc(Number(F['max-rounds']))) : 8;
  if (!Number.isFinite(target)) throw new CliError('--target חייב להיות מספר (dB)');
  const dry = !!(F.dry || F['dry-run']);
  const quiet = !!F.json;
  const log = (s) => { if (!quiet) out(s); };
  const P0 = await getProject(id);
  const peaks = await fetchPeaks(id, P0);
  const missing = [...peaks].filter(([, v]) => !v).map(([k]) => k);
  log(`איזון קול מול רקע — "${P0.name}" (${id}) · יעד: הקול ≥ ${target} dB מעל מוזיקה+אפקטים${dry ? ' · תוכנית בלבד (--dry)' : ''}`);
  if (missing.length) log(`⚠ אין צורת גל ל-${missing.join(', ')} — האשמה שם לפי עוצמה בלבד`);
  let P = P0;
  const rounds = [];
  const touched = new Set();
  const lockedAll = new Set();
  let sm = await speechCheck(id, target, quiet);
  if (!sm || sm.error) throw new CliError(`בדיקת השמע לא החזירה מרווח דיבור${sm && sm.error ? `: ${sm.error}` : ' (אין קריינות בערוץ voice?)'}`);
  if (sm.min === null || sm.min === undefined) {
    log('אין חלונות דיבור פעילים (אין קריינות בערוץ קריינות) — אין מה לאזן');
    if (F.json) out(JSON.stringify({ ok: true, target, rounds: [], final: sm }, null, 2));
    return 0;
  }
  const first = sm;
  let applied = 0;
  for (let round = 1; round <= maxRounds && !smOk(sm, target); round++) {
    const plan = planBalance(P, sm.below || [], { target });
    for (const x of plan.locked) lockedAll.add(x);
    const ops = balanceOps(P, plan);
    const rec = { round, before: { min: sm.min, median: sm.median, belowCount: sm.belowCount }, windows: plan.windows.length, clips: [...plan.dips.keys()], ops: ops.length };
    rounds.push(rec);
    log(`סבב ${round}: ${smLine(sm, target)} → ${ops.length ? `הנמכה ב-${ops.length} קליפים (${plan.windows.length} חלונות)` : 'לא נמצא קליפ להנמיך'}`);
    if (dry) {
      for (const [cid, list] of plan.dips) {
        const c = P.clips[cid];
        const ts = list.map((d) => f2(d.t0));
        log(`  ${pad(cid, 14)}${pad(`"${trunc(c && c.name, 34)}"`, 38)}${list.length} חלונות (${ts.slice(0, 8).join(', ')}${ts.length > 8 ? ' …' : ''}) · עד ‎-${f2(Math.max(...list.map((d) => d.depth)))} dB`);
      }
      for (const w of plan.windows.filter((x) => !x.guilty.length)) log(`  ⚠ ${f2(w.t)}: ${w.reason || 'לא נמצא אשם'}`);
      for (const x of plan.locked) log(`  ⚠ ${x}: הערוץ נעול — לא הונמך`);
      if (F.json) out(JSON.stringify({ dry: true, target, check: sm, plan: { windows: plan.windows, ops } }, null, 2));
      return smOk(sm, target) ? 0 : 2;
    }
    if (!ops.length) break;
    const r = await postOps(id, ops, { summary: `איזון קול מול רקע (סבב ${round})` });
    const bad = (r.results || []).filter((x) => !x.ok);
    for (const b of bad) log(`  ✗ ${b.op}: ${b.error}`);
    applied++;
    ops.forEach((o, i) => { if (r.results && r.results[i] && r.results[i].ok) touched.add(o.id); });
    P = r.project || (await getProject(id));
    sm = await speechCheck(id, target, quiet);
    if (!sm || sm.error) throw new CliError('בדיקת השמע נכשלה באמצע האיזון');
  }
  const ok = smOk(sm, target);
  const clips = dipSummary(P0, P, [...touched]);
  const suggestions = sfxSuggestions(P0, [...touched], peaks);
  if (F.json) {
    out(JSON.stringify({ ok, target, rounds, applied, initial: { min: first.min, median: first.median, belowCount: first.belowCount },
      final: { min: sm.min, median: sm.median, belowCount: sm.belowCount, below: sm.below }, clips, suggestions, locked: [...lockedAll] }, null, 2));
    return ok ? 0 : 2;
  }
  out('');
  if (ok) out(`✓ היעד הושג${applied ? ` אחרי ${applied} סבבי הנמכה` : ' (לא נדרשה הנמכה)'}: ${smLine(sm, target)}`);
  else out(`✗ לא הגענו ליעד אחרי ${applied} סבבים: ${smLine(sm, target)}${(sm.below || []).length ? ` · זמנים: ${(sm.below || []).slice(0, 10).map((b) => f2(b.t)).join(', ')}` : ''}`);
  out(`  לפני: ${smLine(first, target)}`);
  if (clips.length) {
    out('הנמכות לפי קליפ (הקול לא הוגבר):');
    for (const c of clips) {
      const t = (P.tracks || []).find((x) => x.id === c.track);
      out(`  ${pad(c.id, 14)}${pad(`"${trunc(c.name, 34)}"`, 38)}${pad(t ? t.name : c.track, 16)}${c.regions} אזורים · ${f2(c.seconds)} שנ' · עד ${f2(c.maxDb)} dB`);
    }
  }
  for (const x of lockedAll) out(`  ⚠ ${x}: הערוץ נעול — לא הונמך (שחרר את הנעילה או הנמך ידנית)`);
  for (const s of suggestions) {
    out(`הצעה: האפקט "${trunc(s.name, 40)}" (${s.id}) יושב בעיקר על דיבור (${s.onSpeech}%) ולכן הונמך מאוד.`);
    if (s.start !== undefined) out(`   עדיף להזיז אותו לרווח בין מילים: הרווח ${f2(s.gap[0])}–${f2(s.gap[1])}${s.before ? ` אחרי "${s.before}"` : ''}${s.after ? ` לפני "${s.after}"` : ''} → cutx move ${id} ${s.id} ${f2(s.start)}  (ואז שוב cutx balance ${id})`);
    else out('   עדיף להזיז אותו לרווח בין מילים (או לפתוח רווח עם insertGap).');
  }
  if (!ok) out('מה עוד אפשר: להזיז אפקט לרווח בין מילים, להוריד gain לאפקט/מוזיקה, או duckUnderVoice על המוזיקה — לא להגביר את הקול.');
  return ok ? 0 : 2;
}

// ───────────────────────────── help ─────────────────────────────

const COMMANDS = [
  ['help [פקודה|ops|שם-פעולה]', 'עזרה. "cutx help ops" = כל הפעולות; "cutx help addCaptions" = פרטי פעולה'],
  ['health', 'בדיקת השרת'],
  ['projects', 'רשימת פרויקטים'],
  ['new <id> [--name "שם"] [--size 1080x1920|9:16|16:9|1:1|4:5] [--fps 30] [--empty]', 'פרויקט חדש (ברירת מחדל 9:16, 30fps, ערוצי ברירת מחדל)'],
  ['show <id> [--json]', 'ערוצים, קליפים (מזהה, סוג, זמנים, טקסט), סמנים, משך ואזהרות'],
  ['ops <id> <file.json|-|JSON> [--summary "…"] [--atomic]', 'שליחת רצף פעולות (מערך או {ops:[…]}). ראה docs/CLAUDE-API.md'],
  ['import <id> <path…> [--copy] [--wait]', 'ייבוא קבצים לפרויקט (וידאו/תמונה/אודיו)'],
  ['add <id> video|image|audio|text|caption|shape|sticker|effect|adjustment <path|text|kind|id> [--at 1.2|--at word:ובום!] [--dur 2] [--track ID|--role sfx] [--set key=value …] [--id myId] [--in 0] [--speed 1] [--overlap newTrack|allow|overwrite|insert] [--style chordix] [--preset id] [--name "…"]', 'הוספת קליפ'],
  ['sfx <id> "<חיפוש|soundId|נתיב>" --at <t|word:…> [--gain -12] [--len 1.5] [--fade 0.2] [--from 0] [--track ID] [--name "…"]', 'אפקט קולי מהספרייה בזמן/מילה'],
  ['sounds "<חיפוש>" [--category …] [--collection …] [--min 0.2] [--max 3] [--limit 20]', 'חיפוש בספריית הצלילים'],
  ['catalog [transitions|effects|filters|anims|text-anims|captions|text-presets|stickers|shapes|fonts|luts]', 'קטלוגים לפי מזהה'],
  ['transcript <id> [<asr.json>] [--script "טקסט התסריט" | --script-file file.txt|video.json] [--hot "א,ב"]', 'הגדרת זמני מילים ([[w,s,e]…] או [{w,s,e}]). עם --script: המילים הנכונות מהתסריט על זמני ה-ASR (יישור לפי אותיות); בלי asr.json — יישור התמלול הקיים'],
  ['words <id> [--json]', 'הצגת התמלול עם אינדקסים ומופעים (לזמנים לפי מילה)'],
  ['captions <id> [--asr file.json] [--script "…" | --script-file f] [--style chordix] [--max 3] [--max-chars 18] [--chunks 1,3,3] [--hot "מילה,מילה"] [--y 330 | --yabs 330] [--hold 0.7] [--gap 0] [--hook0] [--replace] [--no-comma]', 'כתוביות מהתמלול'],
  ['transcribe <id> <mediaId|path> [--captions] [--style …] [--model small]', 'תמלול מקומי (faster-whisper) ואופציונלית כתוביות'],
  ['set <id> <clipId[,clipId…]> key=value …', 'עדכון שדות (updateClip)'],
  ['move <id> <clipId> <start> [--track ID] [--overlap allow]', 'הזזת קליפ'],
  ['trim <id> <clipId> [--start a] [--end b] [--head 0.2] [--tail 0.2] [--dur d]', 'חיתוך קצוות'],
  ['split <id> <clipId> <at>', 'פיצול'],
  ['remove <id> <clipId…> [--ripple]', 'מחיקה'],
  ['dup <id> <clipId> [--at t] [--track ID]', 'שכפול'],
  ['key <id> <clipId> <prop> <t> <v> [--ease spring] [--abs]', 'קיפריים (t יחסי לקליפ; --abs או word:… = זמן מוחלט)'],
  ['transition <id> <clipId> <transitionId|none> [--dur 0.5] [--param k=v]', 'מעבר לקליפ הבא'],
  ['effect <id> <clipId> <effectId> [--param k=v] [--index n]', 'אפקט לקליפ'],
  ['marker <id> <t|word:…> [label] [--color #hex]', 'סמן'],
  ['undo <id> / redo <id>', 'ביטול / ביצוע מחדש'],
  ['snapshot <id> --at 0.5,3,word:ובום! [--scale 0.5] [--sheet] [--out dir]', 'תמונות מהפריימים (קרא אותן כדי לראות את העריכה)'],
  ['export <id> [--out file.mp4] [--from a --to b] [--fps 30] [--crf 18] [--preset medium] [--lufs -14] [--no-check]', 'ייצוא MP4 + דוח עוצמה ומרווח דיבור'],
  ['check-audio <id>', 'בדיקת מרווח הדיבור מול הרקע (≥ 12 dB)'],
  ['balance <id> [--target 12] [--max-rounds 8] [--dry]', 'איזון אוטומטי של הקול מול הרקע: בכל חלון דיבור שבו הקול פחות מ-target dB מעל מוזיקה+אפקטים — הנמכה מקומית (קיפריימים של volume) רק לקליפים האשמים, ובדיקה חוזרת עד שעומד ביעד. --dry = רק התוכנית'],
  ['media <id> [--json]', 'רשימת המדיה בפרויקט'],
  ['validate <id>', 'בדיקת תקינות הפרויקט'],
  ['time <id> <ref>', 'חישוב זמן (word:… / marker:… / clip:…:end)'],
  ['open [<id>]', 'פתיחת חלון העורך (המשתמש צופה בזמן אמת)'],
  ['import-chordix <dir> [--id …] [--name …]', 'ייבוא פרויקט מסדנת Chordix'],
  ['wait <jobId>', 'המתנה לסיום משימה'],
];

function printHelp(topic) {
  if (!topic) {
    out(`cutx ${VERSION} — שליטה ב-Frame Studio משורת הפקודה (שרת: ${BASE})`);
    out('');
    for (const [usage, desc] of COMMANDS) { out(`  cutx ${usage}`); out(`      ${desc}`); }
    out('');
    out('זמנים: מספר שניות, word:מילה[:מופע[:היסט[:end]]] (למשל word:ובום!:1:-0.1), marker:תווית, clip:מזהה:end, או MM:SS:FF');
    out('דגל כללי: --json לפלט מכונה. תיעוד מלא: docs/CLAUDE-API.md');
    return;
  }
  if (topic === 'ops') {
    out('פעולות (op) — שליחה עם cutx ops <id> file.json:');
    for (const h of OPS_HELP) { out(`  ${pad(h.op, 17)}${h.he}`); out(`  ${pad('', 17)}שדות: ${h.fields}`); }
    return;
  }
  const c = COMMANDS.filter(([u]) => u.split(/[\s/]/)[0] === topic || u.startsWith(topic + ' '));
  for (const [u, d] of c) { out(`cutx ${u}`); out(`  ${d}`); }
  const h = OPS_HELP.find((x) => x.op === topic);
  if (h) {
    if (c.length) out('');
    out(`פעולה ${h.op} — ${h.he}`);
    out(`שדות: ${h.fields}`);
    out('דוגמה:');
    out(JSON.stringify(h.example, null, 2));
  }
  if (!c.length && !h) throw new CliError(`אין עזרה עבור "${topic}". נסה: cutx help`);
}

// ───────────────────────────── commands ─────────────────────────────

function need(v, what) { if (v === undefined || v === null || v === '') throw new CliError(`חסר ${what}`); return v; }

async function runOps(A, id, ops, summary) {
  const r = await postOps(id, ops, { summary: A.flags.summary || summary, atomic: !!A.flags.atomic });
  if (A.flags.json) { out(JSON.stringify({ rev: r.rev, results: r.results }, null, 2)); }
  else printResults(r, ops);
  const bad = (r.results || []).filter((x) => !x.ok).length;
  return bad ? 2 : 0;
}

function buildAddOp(A) {
  const [, type, arg] = A.pos;
  need(type, 'סוג קליפ (video|image|audio|text|caption|shape|sticker|effect|adjustment)');
  const op = { op: 'addClip', type };
  const F = A.flags;
  switch (type) {
    case 'video': case 'image': case 'audio':
      need(arg, 'נתיב קובץ או mediaId');
      if (looksLikeMediaId(arg)) op.mediaId = arg; else op.path = path.resolve(arg);
      break;
    case 'text': op.content = need(arg, 'טקסט'); break;
    case 'caption': op.content = need(arg, 'טקסט הכתובית'); if (F.style) op.style = F.style; break;
    case 'shape': op.kind = arg || 'rect'; break;
    case 'sticker': op.value = need(arg, 'מדבקה (אימוג\'י או מזהה)'); break;
    case 'effect': op.effect = need(arg, 'מזהה אפקט'); break;
    case 'adjustment': if (arg && arg !== 'none') op.filter = arg; break;
    default: throw new CliError(`סוג קליפ לא מוכר: ${type}`);
  }
  if (F.at !== undefined) op.start = parseTimeArg(F.at);
  if (F.start !== undefined) op.start = parseTimeArg(F.start);
  if (F.dur !== undefined) op.duration = Number(F.dur);
  if (F.duration !== undefined) op.duration = Number(F.duration);
  if (F.end !== undefined) op.end = parseTimeArg(F.end);
  if (F.track) op.track = F.track;
  if (F.role) op.role = F.role;
  if (F.id) op.id = F.id;
  if (F.in !== undefined) op.in = Number(F.in);
  if (F.speed !== undefined) op.speed = Number(F.speed);
  if (F.overlap) op.overlap = F.overlap;
  if (F.name) op.name = F.name;
  if (F.preset) op.preset = F.preset;
  if (F.style && type !== 'caption') op.style = F.style;
  if (A.param.length && (type === 'effect' || type === 'adjustment')) op.params = parseAssignments(A.param);
  if (A.set.length) op.set = parseAssignments(A.set);
  return op;
}

async function resolveTimesFor(id, list) {
  const needsProject = list.some((t) => typeof t !== 'number');
  if (!needsProject) return list;
  const P = await getProject(id);
  return list.map((t) => {
    try { return resolveTime(P, t); } catch (e) { throw new CliError(`זמן "${t}": ${e.message}`); }
  });
}

async function cmd(A) {
  const [c, id] = A.pos;
  const F = A.flags;
  switch (c) {
    case undefined: case 'help': case '-h': printHelp(A.pos[1]); return 0;
    case 'version': out(VERSION); return 0;
    case 'health': {
      const h = await health();
      if (!h) throw new CliError(`השרת לא פעיל ב-${BASE}`);
      if (F.json) out(JSON.stringify(h)); else out(`השרת פעיל · גרסה ${h.version ?? '?'} · ${h.root ?? ''} · פורט ${h.port ?? ''}`);
      return 0;
    }
    case 'catalog': return cmdCatalog(A);
  }
  await ensureServer();
  switch (c) {
    case 'projects': {
      const list = await api.get('/api/projects');
      if (F.json) { out(JSON.stringify(list, null, 2)); return 0; }
      if (!list || !list.length) { out('אין פרויקטים. צור אחד: cutx new <id> --name "שם"'); return 0; }
      out(`${pad('מזהה', 26)}${pad('שם', 28)}${pad('גודל', 12)}${pad('fps', 5)}${pad('משך', 8)}${pad('קליפים', 8)}עודכן`);
      for (const p of list) out(`${pad(p.id, 26)}${pad(trunc(p.name, 26), 28)}${pad(`${p.width}×${p.height}`, 12)}${pad(p.fps, 5)}${pad(f2(p.duration), 8)}${pad(p.clipCount ?? '', 8)}${p.modified ?? ''}`);
      return 0;
    }
    case 'new': {
      need(id, 'מזהה פרויקט (a-z, 0-9, מקף)');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CliError(`מזהה פרויקט לא תקין "${id}" — רק אותיות לטיניות קטנות, ספרות ומקף`);
      const size = parseSize(F.size || '9:16');
      const body = { id, name: F.name || id, width: size[0], height: size[1], fps: F.fps ? Number(F.fps) : 30, tracks: F.empty ? 'empty' : 'default' };
      const P = await api.post('/api/projects', body);
      if (F.json) out(JSON.stringify(P, null, 2));
      else out(`נוצר פרויקט "${P.name}" (${P.id}) · ${P.settings.width}×${P.settings.height} · ${P.settings.fps}fps · ${P.tracks.length} ערוצים`);
      return 0;
    }
    case 'show': {
      const P = await getProject(need(id, 'מזהה פרויקט'));
      if (F.json) out(JSON.stringify(P, null, 2)); else printProject(P);
      return 0;
    }
    case 'media': {
      const P = await getProject(need(id, 'מזהה פרויקט'));
      const list = Object.values(P.media || {});
      if (F.json) { out(JSON.stringify(list, null, 2)); return 0; }
      if (!list.length) { out('אין מדיה בפרויקט'); return 0; }
      for (const m of list) out(`${pad(m.id, 22)}${pad(m.kind, 7)}${pad(f2(m.duration), 8)}${pad(m.width ? `${m.width}×${m.height}` : '', 11)}${pad(m.status || '', 11)}${m.name}${m.library ? ` (ספרייה ${m.library.soundId})` : ''}${m.error ? ` — ${m.error}` : ''}`);
      return 0;
    }
    case 'validate': {
      const P = await getProject(need(id, 'מזהה פרויקט'));
      const probs = validateProject(P);
      if (F.json) { out(JSON.stringify(probs, null, 2)); return probs.length ? 2 : 0; }
      if (!probs.length) out('✓ הפרויקט תקין'); else probs.forEach((p) => out(`⚠ ${p}`));
      return probs.length ? 2 : 0;
    }
    case 'time': {
      const P = await getProject(need(id, 'מזהה פרויקט'));
      const ref = need(A.pos[2], 'זמן');
      let t;
      try { t = resolveTime(P, parseTimeArg(ref)); } catch (e) { throw new CliError(e.message); }
      out(F.json ? JSON.stringify({ t }) : `${f2(t)} (${formatTimecode(t, P.settings.fps)})`);
      return 0;
    }
    case 'words': {
      const P = await getProject(need(id, 'מזהה פרויקט'));
      const words = (P.transcript && P.transcript.words) || [];
      if (F.json) { out(JSON.stringify(words, null, 2)); return 0; }
      if (!words.length) { out('אין תמלול'); return 0; }
      const seen = new Map();
      words.forEach((w, i) => {
        const k = normalizeWord(w.w);
        const n = seen.get(k) || 0;
        seen.set(k, n + 1);
        out(`${pad(i, 5)}${pad(f2(w.s), 8)}${pad(f2(w.e), 8)}${pad(w.w, 18)}${n ? `word:${w.w}:${n}` : `word:${w.w}`}${w.hot ? '  (מודגש)' : ''}`);
      });
      return 0;
    }
    case 'ops': {
      need(id, 'מזהה פרויקט');
      const src = need(A.pos[2], 'קובץ JSON או - (stdin)');
      let data = /^\s*[[{]/.test(src) ? (() => { try { return JSON.parse(src); } catch (e) { throw new CliError(`JSON לא תקין: ${e.message}`); } })() : readJsonFile(src);
      let ops = Array.isArray(data) ? data : data && Array.isArray(data.ops) ? data.ops : data && data.op ? [data] : null;
      if (!ops) throw new CliError('הקובץ צריך להכיל מערך פעולות או {"ops":[…]}');
      if (data && !Array.isArray(data)) { if (data.summary && !F.summary) F.summary = data.summary; if (data.atomic) F.atomic = true; }
      return runOps(A, id, ops);
    }
    case 'import': {
      need(id, 'מזהה פרויקט');
      const paths = A.pos.slice(2).map((p) => path.resolve(p));
      if (!paths.length) throw new CliError('חסרים נתיבים לייבוא');
      for (const p of paths) if (!fs.existsSync(p)) err(`⚠ הקובץ לא נמצא: ${p}`);
      const r = await api.post(`/api/projects/${enc(id)}/import`, { paths, copy: !!F.copy });
      let media = (r && r.media) || [];
      if (F.wait) {
        const t0 = Date.now();
        while (media.some((m) => m.status === 'processing') && Date.now() - t0 < 10 * 60 * 1000) {
          await sleep(1000);
          const P = await getProject(id);
          media = media.map((m) => (P.media && P.media[m.id]) || m);
        }
      }
      if (F.json) { out(JSON.stringify(media, null, 2)); return 0; }
      for (const m of media) out(`${pad(m.id, 22)}${pad(m.kind, 7)}${pad(f2(m.duration), 8)}${pad(m.status || '', 11)}${m.name}${m.error ? ` — ${m.error}` : ''}`);
      return media.some((m) => m.status === 'error') ? 2 : 0;
    }
    case 'add': {
      need(id, 'מזהה פרויקט');
      const op = buildAddOp({ ...A, pos: A.pos.slice(1) });
      return runOps(A, id, [op], `הוספת ${CLIP_TYPE_LABELS[op.type] || op.type}`);
    }
    case 'sfx': {
      need(id, 'מזהה פרויקט');
      const q = need(A.pos[2], 'צליל (חיפוש, מזהה או נתיב)');
      const op = { op: 'sfx', sound: fs.existsSync(path.resolve(q)) && /[\\/.]/.test(q) ? path.resolve(q) : q, at: parseTimeArg(need(F.at, '--at')) };
      if (F.gain !== undefined) op.gain_db = Number(F.gain);
      if (F.len !== undefined) op.len = Number(F.len);
      if (F.fade !== undefined) op.fade = Number(F.fade);
      if (F['fade-in'] !== undefined) op.fadeIn = Number(F['fade-in']);
      if (F.from !== undefined) op.from = Number(F.from);
      if (F.track) op.track = F.track;
      if (F.name) op.name = F.name;
      if (F.id) op.id = F.id;
      if (F.overlap) op.overlap = F.overlap;
      return runOps(A, id, [op], `אפקט קולי: ${q}`);
    }
    case 'sounds': {
      const q = A.pos[1] || '';
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      for (const k of ['category', 'collection', 'min', 'max', 'offset']) if (F[k] !== undefined) params.set(k, F[k]);
      params.set('limit', F.limit || '20');
      const r = await api.get(`/api/library/sounds?${params}`);
      const list = Array.isArray(r) ? r : (r && (r.items || r.results || r.sounds)) || [];
      if (F.json) { out(JSON.stringify(r, null, 2)); return 0; }
      if (!list.length) { out('לא נמצאו צלילים'); return 0; }
      out(`${pad('מזהה', 14)}${pad('משך', 7)}${pad('שיא', 8)}${pad('קטגוריה', 18)}${pad('רישיון', 9)}שם`);
      for (const s of list) out(`${pad(s.id, 14)}${pad(f2(s.duration), 7)}${pad(s.peakDb !== undefined ? f2(s.peakDb) : '', 8)}${pad(trunc(s.category, 16), 18)}${pad(s.license || '', 9)}${s.name}${s.role ? `  [${s.role}]` : ''}`);
      const total = r && !Array.isArray(r) ? r.total : undefined;
      if (total !== undefined && total > list.length) out(`… ${total} תוצאות בסך הכול (--limit / --offset)`);
      out('\nשימוש: cutx sfx <id> <מזהה> --at word:… --gain -14 --len 0.8');
      return 0;
    }
    case 'transcript': {
      need(id, 'מזהה פרויקט');
      const script = readScriptArg(F);
      const file = A.pos[2];
      if (!file && !script) throw new CliError('חסר קובץ asr.json (או --script / --script-file ליישור התמלול הקיים לתסריט)');
      const words = file ? normalizeAsr(readJsonFile(file)) : 'transcript';
      const op = { op: 'setTranscript', words };
      if (script) op.script = script;
      if (F.hot) op.hot = splitList(F.hot);
      if (F['media-id']) op.mediaId = F['media-id'];
      const n = file ? words.length : null;
      return runOps(A, id, [op], script ? `תמלול מיושר לתסריט${n ? ` (${n} מילות ASR)` : ''}` : `תמלול (${n} מילים)`);
    }
    case 'captions': {
      need(id, 'מזהה פרויקט');
      const ops = [];
      const script = readScriptArg(F);
      // with a script: fix the transcript first (script words on the ASR times), then caption the transcript as is
      if (script) ops.push({ op: 'setTranscript', words: F.asr ? normalizeAsr(readJsonFile(F.asr)) : 'transcript', script });
      else if (F.asr) ops.push({ op: 'setTranscript', words: normalizeAsr(readJsonFile(F.asr)) });
      const op = { op: 'addCaptions', words: 'transcript' };
      if (F.style) op.style = F.style;
      if (F.max !== undefined) op.maxWords = Number(F.max);
      if (F['max-words'] !== undefined) op.maxWords = Number(F['max-words']);
      if (F['max-chars'] !== undefined) op.maxChars = Number(F['max-chars']);
      if (F.chunks) op.chunks = String(F.chunks).split(/[,\s]+/).filter(Boolean).map(Number);
      if (F.hot) op.hot = splitList(F.hot);
      if (F.y !== undefined) op.y = Number(F.y);
      if (F.yabs !== undefined) op.yAbs = Number(F.yabs);
      if (F.hold !== undefined) op.hold = Number(F.hold);
      if (F.gap !== undefined) op.gap = Number(F.gap);
      if (F.tail !== undefined) op.tail = Number(F.tail);
      if (F.track) op.track = F.track;
      if (F.hook0) op.hook0 = true;
      if (F.replace) op.replace = true;
      if (F['no-comma']) op.commaBreak = false;
      ops.push(op);
      return runOps(A, id, ops, `כתוביות${op.style ? ` (${op.style})` : ''}`);
    }
    case 'transcribe': {
      need(id, 'מזהה פרויקט');
      const src = need(A.pos[2], 'mediaId או נתיב');
      const body = looksLikeMediaId(src) ? { mediaId: src } : fs.existsSync(path.resolve(src)) ? { path: path.resolve(src) } : { mediaId: src };
      if (F.model) body.model = F.model;
      if (F.captions) {
        body.captions = { words: 'transcript' };
        if (F.style) body.captions.style = F.style;
        if (F.max !== undefined) body.captions.maxWords = Number(F.max);
        if (F.hot) body.captions.hot = String(F.hot).split(',').map((s) => s.trim()).filter(Boolean);
        if (F.yabs !== undefined) body.captions.yAbs = Number(F.yabs);
        if (F.y !== undefined) body.captions.y = Number(F.y);
      }
      const before = await getProject(id);
      const job = await api.post(`/api/projects/${enc(id)}/transcribe`, body, { timeout: 60000 });
      let done = null;
      try { done = await waitJob(job, 'תמלול', { quiet: !!F.json }); }
      catch (e) {
        if (!(e.status === 404)) throw e;
        // job not exposed through /api/jobs → wait for the project transcript to change
        const t0 = Date.now();
        for (;;) {
          await sleep(1000);
          const P = await getProject(id);
          if (P.rev !== before.rev && (P.transcript?.words?.length || 0) > 0) break;
          if (Date.now() - t0 > 20 * 60 * 1000) throw new CliError('התמלול לא הסתיים תוך 20 דקות');
        }
      }
      const P = await getProject(id);
      const words = (P.transcript && P.transcript.words) || [];
      if (F.json) { out(JSON.stringify({ job: done, words: words.length }, null, 2)); return 0; }
      out(`✓ תמלול: ${words.length} מילים${words.length ? ` (${f2(words[0].s)}–${f2(words[words.length - 1].e)})` : ''}`);
      out(words.slice(0, 40).map((w) => w.w).join(' ') + (words.length > 40 ? ' …' : ''));
      if (F.captions) out(`כתוביות: ${Object.values(P.clips).filter((x) => x.type === 'caption').length} מקטעים`);
      return 0;
    }
    case 'set': {
      need(id, 'מזהה פרויקט');
      const ids = String(need(A.pos[2], 'מזהה קליפ')).split(',').map((s) => s.trim()).filter(Boolean);
      const set = parseAssignments([...A.pos.slice(3), ...A.set]);
      if (!Object.keys(set).length) throw new CliError('חסרות הגדרות key=value');
      return runOps(A, id, [{ op: 'updateClip', ids, set, ...(F.force ? { force: true } : {}) }], 'עדכון קליפ');
    }
    case 'move': {
      need(id, 'מזהה פרויקט');
      const op = { op: 'moveClip', id: need(A.pos[2], 'מזהה קליפ') };
      const st = A.pos[3] ?? F.at ?? F.start;
      if (st !== undefined) op.start = parseTimeArg(st);
      if (F.by !== undefined) op.by = Number(F.by);
      if (F.track) op.track = F.track;
      if (F.overlap) op.overlap = F.overlap;
      if (op.start === undefined && op.by === undefined && !op.track) throw new CliError('חסר זמן התחלה חדש, --by או --track');
      return runOps(A, id, [op], 'הזזת קליפ');
    }
    case 'trim': {
      need(id, 'מזהה פרויקט');
      const op = { op: 'trimClip', id: need(A.pos[2], 'מזהה קליפ') };
      if (F.start !== undefined) op.start = parseTimeArg(F.start);
      if (F.end !== undefined) op.end = parseTimeArg(F.end);
      if (F.head !== undefined) op.head = Number(F.head);
      if (F.tail !== undefined) op.tail = Number(F.tail);
      if (F.dur !== undefined) op.duration = Number(F.dur);
      if (F.overlap) op.overlap = F.overlap;
      if (Object.keys(op).length <= 2) throw new CliError('חסר --start / --end / --head / --tail / --dur');
      return runOps(A, id, [op], 'חיתוך קליפ');
    }
    case 'split': {
      need(id, 'מזהה פרויקט');
      return runOps(A, id, [{ op: 'splitClip', id: need(A.pos[2], 'מזהה קליפ'), at: parseTimeArg(need(A.pos[3] ?? F.at, 'זמן פיצול')) }], 'פיצול');
    }
    case 'remove': case 'rm': {
      need(id, 'מזהה פרויקט');
      const ids = A.pos.slice(2).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
      if (!ids.length) throw new CliError('חסרים מזהי קליפים');
      return runOps(A, id, [{ op: 'removeClips', ids, ripple: !!F.ripple }], `מחיקת ${ids.length} קליפים`);
    }
    case 'dup': {
      need(id, 'מזהה פרויקט');
      const op = { op: 'duplicateClip', id: need(A.pos[2], 'מזהה קליפ') };
      if (F.at !== undefined || A.pos[3] !== undefined) op.start = parseTimeArg(F.at ?? A.pos[3]);
      if (F.track) op.track = F.track;
      if (F.id) op.newId = F.id;
      return runOps(A, id, [op], 'שכפול קליפ');
    }
    case 'key': {
      need(id, 'מזהה פרויקט');
      const [, , clipId, prop, t, v] = A.pos;
      const op = { op: 'setKeyframe', id: need(clipId, 'מזהה קליפ'), prop: need(prop, 'מאפיין (למשל transform.scale)'), t: parseTimeArg(need(t, 'זמן')) };
      if (v !== undefined) op.v = Number(v);
      if (F.ease) op.ease = F.ease;
      if (F.abs) op.abs = true;
      return runOps(A, id, [op], `קיפריים ${prop}`);
    }
    case 'transition': {
      need(id, 'מזהה פרויקט');
      const clipId = need(A.pos[2], 'מזהה קליפ');
      const tr = need(A.pos[3], 'מזהה מעבר (cutx catalog transitions)');
      const op = tr === 'none' ? { op: 'removeTransition', id: clipId } : { op: 'setTransition', id: clipId, transition: tr };
      if (F.dur !== undefined) op.duration = Number(F.dur);
      if (A.param.length) op.params = parseAssignments(A.param);
      if (F.force) op.force = true;
      return runOps(A, id, [op], `מעבר ${tr}`);
    }
    case 'effect': {
      need(id, 'מזהה פרויקט');
      const op = { op: 'addEffect', id: need(A.pos[2], 'מזהה קליפ'), effect: need(A.pos[3], 'מזהה אפקט (cutx catalog effects)') };
      if (A.param.length) op.params = parseAssignments(A.param);
      if (F.index !== undefined) op.index = Number(F.index);
      return runOps(A, id, [op], `אפקט ${op.effect}`);
    }
    case 'marker': {
      need(id, 'מזהה פרויקט');
      const op = { op: 'addMarker', t: parseTimeArg(need(A.pos[2], 'זמן')) };
      if (A.pos[3] !== undefined) op.label = A.pos.slice(3).join(' ');
      if (F.label) op.label = F.label;
      if (F.color) op.color = F.color;
      if (F.id) op.id = F.id;
      return runOps(A, id, [op], `סמן ${op.label || ''}`.trim());
    }
    case 'undo': case 'redo': {
      need(id, 'מזהה פרויקט');
      const r = await api.post(`/api/projects/${enc(id)}/${c}`, {});
      if (F.json) out(JSON.stringify({ rev: r.rev }, null, 2)); else out(`${c === 'undo' ? '↶ בוטל' : '↷ בוצע מחדש'} · גרסה ${r.rev}`);
      return 0;
    }
    case 'snapshot': {
      need(id, 'מזהה פרויקט');
      const times = await resolveTimesFor(id, splitTimes(need(F.at ?? F.times ?? A.pos[2], '--at (זמנים מופרדים בפסיק)')).map(parseTimeArg));
      const body = { times };
      if (F.scale !== undefined) body.scale = Number(F.scale);
      if (F.sheet) body.sheet = true;
      const job = await api.post(`/api/projects/${enc(id)}/snapshot`, body);
      const done = await waitJob(job, 'צילום פריימים', { quiet: !!F.json });
      let files = jobFiles(done);
      if (F.out) {
        const dir = path.resolve(F.out);
        fs.mkdirSync(dir, { recursive: true });
        files = files.map((f) => { const dst = path.join(dir, path.basename(f)); try { fs.copyFileSync(f, dst); return dst; } catch { return f; } });
      }
      if (F.json) { out(JSON.stringify({ times, files, job: done }, null, 2)); return 0; }
      out(`צולמו ${times.length} פריימים (${times.map(f2).join(', ')}):`);
      for (const f of files) out(f);
      if (!files.length) out('(המשימה הסתיימה בלי קבצים — בדוק את פרטי המשימה: cutx wait ' + jobId(done) + ')');
      return 0;
    }
    case 'export': {
      need(id, 'מזהה פרויקט');
      const body = {};
      if (F.out) body.out = path.resolve(F.out);
      if (F.from !== undefined) body.from = parseTimeArg(F.from);
      if (F.to !== undefined) body.to = parseTimeArg(F.to);
      if (typeof body.from === 'string' || typeof body.to === 'string') {
        const [a, b] = await resolveTimesFor(id, [body.from ?? 0, body.to ?? 0]);
        if (F.from !== undefined) body.from = a;
        if (F.to !== undefined) body.to = b;
      }
      if (F.fps !== undefined) body.fps = Number(F.fps);
      if (F.crf !== undefined) body.crf = Number(F.crf);
      if (F.preset) body.preset = F.preset;
      if (F.lufs !== undefined) body.lufs = Number(F.lufs);
      body.check = !F['no-check'];
      if (F['no-headless']) body.headless = false;
      const job = await api.post(`/api/projects/${enc(id)}/export`, body);
      const done = await waitJob(job, 'ייצוא', { quiet: !!F.json });
      if (F.json) { out(JSON.stringify(done, null, 2)); return 0; }
      const files = jobFiles(done).filter((f) => /\.(mp4|mov|webm|mkv)$/i.test(f));
      out('✓ הייצוא הסתיים');
      if (files.length) out(files.join('\n'));
      printReport(done.report || done.result || {});
      const sm = done.report && (done.report.speechMargin || done.report.speech);
      if (marginFailed(sm)) return 2;
      return 0;
    }
    case 'check-audio': {
      need(id, 'מזהה פרויקט');
      let job;
      try { job = await api.post(`/api/projects/${enc(id)}/check-audio`, {}); }
      catch (e) {
        if (e.status !== 404 && e.status !== 405) throw e;
        job = await api.post(`/api/projects/${enc(id)}/export`, { stemsOnly: true, audioOnly: true, check: true });
      }
      const done = await waitJob(job, 'בדיקת שמע', { quiet: !!F.json });
      if (F.json) { out(JSON.stringify(done, null, 2)); return 0; }
      const rep = done.report || done.result || done;
      printReport(rep);
      const sm = rep.speechMargin || rep.speech || rep.margin;
      if (!sm) out('לא התקבל דוח מרווח דיבור (אין קריינות בערוץ voice?)');
      return marginFailed(sm) ? 2 : 0;
    }
    case 'balance': return cmdBalance(A, id);
    case 'open': {
      const r = await api.post('/api/open', id ? { project: id } : {});
      if (F.json) out(JSON.stringify(r)); else out(`נפתח חלון העורך${id ? ` על ${id}` : ''}`);
      return 0;
    }
    case 'import-chordix': {
      const dir = path.resolve(need(A.pos[1], 'תיקיית פרויקט בסדנה'));
      if (!fs.existsSync(path.join(dir, 'video.json'))) err(`⚠ לא נמצא video.json ב-${dir}`);
      const body = { dir };
      if (F.id) body.id = F.id;
      if (F.name) body.name = F.name;
      const P = await api.post('/api/import-chordix', body, { timeout: 10 * 60 * 1000 });
      if (F.json) { out(JSON.stringify(P, null, 2)); return 0; }
      out(`✓ יובא מהסדנה: "${P.name}" (${P.id})`);
      printProject(P);
      return 0;
    }
    case 'wait': {
      const j = need(A.pos[1], 'מזהה משימה');
      const done = await waitJob(j, 'משימה', { quiet: !!F.json });
      if (F.json) out(JSON.stringify(done, null, 2));
      else { out('✓ המשימה הסתיימה'); for (const f of jobFiles(done)) out(f); printReport(done.report || {}); }
      return 0;
    }
    default:
      throw new CliError(`פקודה לא מוכרת: "${c}". הרץ: cutx help`);
  }
}

const CATALOG_KINDS = {
  transitions: 'transitions', effects: 'effects', filters: 'filters', anims: 'clipAnims', 'clip-anims': 'clipAnims', 'text-anims': 'textAnims',
  captions: 'captionStyles', 'caption-styles': 'captionStyles', 'text-presets': 'textPresets', presets: 'textPresets', stickers: 'stickers',
  shapes: 'shapes', fonts: 'fonts', luts: 'luts',
};

async function cmdCatalog(A) {
  const kindArg = A.pos[1];
  const F = A.flags;
  const { getCatalog } = await import('../shared/catalog.js');
  const cat = await getCatalog();
  const serverAlive = !!(await health());
  const groups = {};
  const want = kindArg ? CATALOG_KINDS[kindArg] : null;
  if (kindArg && !want) throw new CliError(`קטלוג לא מוכר: "${kindArg}". אפשר: ${Object.keys(CATALOG_KINDS).join(', ')}`);
  const pick = (k) => !want || want === k || (want === 'clipAnims' && k === 'textAnims' && kindArg === 'anims');
  for (const k of ['transitions', 'effects', 'filters', 'clipAnims', 'textAnims', 'captionStyles', 'textPresets', 'stickers', 'shapes']) if (pick(k)) groups[k] = cat[k];
  if (pick('fonts')) {
    let fonts = cat.fonts;
    if (serverAlive) { try { fonts = await api.get('/api/library/fonts'); } catch { /* local list */ } }
    groups.fonts = fonts;
  }
  if (pick('luts')) {
    let luts = [];
    if (serverAlive) { try { luts = await api.get('/api/library/luts'); } catch { luts = []; } }
    if (!luts || !luts.length) {
      try { luts = fs.readdirSync(path.join(ROOT, 'library', 'luts')).filter((f) => /\.cube$/i.test(f)); } catch { luts = []; }
    }
    groups.luts = luts;
  }
  if (F.json) { out(JSON.stringify(kindArg && kindArg !== 'anims' ? groups[want] ?? groups : groups, null, 2)); return 0; }
  const TITLES = { transitions: 'מעברים', effects: 'אפקטים', filters: 'פילטרים', clipAnims: 'אנימציות קליפ', textAnims: 'אנימציות טקסט', captionStyles: 'סגנונות כתוביות', textPresets: 'סגנונות טקסט', stickers: 'מדבקות', shapes: 'צורות', fonts: 'גופנים', luts: 'LUT' };
  for (const [k, v] of Object.entries(groups)) {
    if (v && !Array.isArray(v) && typeof v === 'object' && (v.in || v.out || v.loop)) {
      out(`${TITLES[k]}:`);
      for (const part of ['in', 'out', 'loop']) {
        const list = v[part] || [];
        out(`  ${part === 'in' ? 'כניסה (animIn)' : part === 'out' ? 'יציאה (animOut)' : 'לולאה (animLoop)'}: ${list.length}`);
        for (const a of list) out(`    ${pad(a.id, 16)}${a.name || ''}`);
      }
      out('');
      continue;
    }
    const list = Array.isArray(v) ? v : [];
    out(`${TITLES[k]} (${list.length}):`);
    if (!list.length) out(k === 'luts' ? '  (אין קבצי .cube ב-library/luts)' : '  (הקטלוג לא נטען — מודול הרינדור עוד לא מוכן)');
    for (const it of list) {
      if (typeof it === 'string') { out(`  ${it}`); continue; }
      const idv = it.id || it.family || it.name;
      const extra = [it.category, it.defaultDuration !== undefined && `${it.defaultDuration} שנ'`, it.kind, it.value, it.weights && `משקלים ${[].concat(it.weights).join(',')}`, it.license].filter(Boolean).join(' · ');
      out(`  ${pad(idv, 20)}${pad(it.name && it.name !== idv ? it.name : '', 24)}${extra}`);
      if (Array.isArray(it.params) && it.params.length && want) {
        out(`  ${pad('', 20)}פרמטרים: ${it.params.map((p) => `${p.key}${p.default !== undefined ? '=' + JSON.stringify(p.default) : ''}${p.min !== undefined ? ` [${p.min}..${p.max}]` : ''}`).join(', ')}`);
      }
    }
    out('');
  }
  if (cat.errors && cat.errors.length && !F.quiet) err(`⚠ ${cat.errors.length} מודולי קטלוג לא נטענו`);
  return 0;
}

export async function main(argv) {
  let A;
  try {
    A = parseArgs(argv);
    if (A.flags.help) { printHelp(A.pos[0]); return 0; }
    return await cmd(A);
  } catch (e) {
    if (e instanceof CliError) {
      if (A && A.flags && A.flags.json) out(JSON.stringify({ error: e.message }));
      else err(`שגיאה: ${e.message}`);
      return e.code || 1;
    }
    err(`שגיאה פנימית: ${e && e.stack ? e.stack : e}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === __filename.toLowerCase(); } catch { return false; }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
