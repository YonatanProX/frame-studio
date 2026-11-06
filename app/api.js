/**
 * Frame Studio — app/api.js  (owner: U)
 * ============================================================================
 * The tiny client layer every app module uses (SPEC §6). Contract:
 *
 *   import { api, applyOps, onEvent, state, on } from './api.js';
 *
 *   api.get(path)            → Promise<json|text>   (GET, throws Error(msg) with .status on 4xx/5xx)
 *   api.post(path, body)     → Promise<json>        (object → JSON body; Blob/File/ArrayBuffer/TypedArray → raw body)
 *   api.del(path)            → Promise<json>
 *   api.url(path)            → absolute URL string for <img>/<video>/<audio>/EventSource
 *                              e.g. api.url(`/api/projects/${state.projectId}/media/${id}/thumb?t=3`)
 *
 *   applyOps(ops, summary?, opts?) → Promise<{ ok, rev, results, project, error? }>
 *       Posts `{ops, by:"user", summary}` to /api/projects/<current>/ops.
 *       OPTIMISTIC: runs shared/ops.js locally first, so state.project updates synchronously
 *       (before the promise resolves). The server response / SSE then replaces state.project
 *       with the authoritative version (newer rev). Requests are serialized (one in flight).
 *       Creation ops (addClip/addTrack/addMarker/sfx) without an `id` get a client id assigned
 *       here, so the optimistic object and the server object share the same id (selection stays valid).
 *       opts: { atomic?:bool, by?:"user"|"claude", silent?:bool (no error toast) }
 *       Never throws: on network/server failure resolves { ok:false, error } and rolls back.
 *
 *   previewOps(ops)          → applies ops LOCALLY ONLY (no server, no history) — for live slider /
 *                              drag feedback. Follow with applyOps(sameOps) on release to commit.
 *   applyOpsLocal(project, ops) → { project, results } | null   pure helper (shared/ops.js), no state change.
 *   undo() / redo()          → Promise<{ok, rev, project}> via POST /api/projects/:id/undo|redo
 *   openProject(id)          → loads project + connects SSE; sets state.projectId/state.project.
 *   reloadProject()          → refetch current project from the server.
 *
 *   onEvent(type, fn) → unsubscribe()
 *       Server-sent events from /api/events?project=<id>: "project" | "media" | "job" | "hello"
 *       fn(eventObject). Plus local pseudo events:
 *         "claude"     {summary, rev, changedIds:[clipIds], project}  — a project event made by Claude
 *         "connection" {connected:boolean}
 *         "error"      {message}                                      — api/ops failure (main.js toasts it)
 *         "sync"       {pending:number, inflight:boolean, rev}        — save status for the top bar
 *         "*"          every event
 *
 *   state  — EventTarget store. Fields:
 *       state.projectId      string|null
 *       state.project        Project|null   (optimistic view: server project + pending local ops)
 *       state.selection      Set<clipId>    (always a Set; state.set accepts arrays too)
 *       state.playhead       seconds
 *       state.zoom           timeline px per second (default 80)
 *       state.playing        boolean
 *       state.tool           "select" | "blade"
 *       state.snapping       boolean
 *       state.previewScale   0.25 | 0.5 | 1   (default 0.5)
 *     extensions (also U-owned, safe for L to read/write):
 *       state.range          { in:number|null, out:number|null }   I/O range (aliases: state.inPoint / state.outPoint)
 *       state.loop           boolean  (loop playback inside range)
 *       state.connected      boolean  (SSE connected)
 *       state.thirds         boolean  (rule-of-thirds overlay)
 *       state.flash          { ids:[clipId], at:ms } — clips changed by Claude (timeline may highlight)
 *       state.activeKeyframe { clipId, prop, t } | null  (keyframe selected in the timeline, optional)
 *       state.history        { undo, redo, undoSummary, redoSummary, known } — server undo stack info
 *       state.duration       (getter) projectDuration(state.project)
 *
 *   state.set(partial, meta?) — assigns and dispatches ONE "change" event:
 *       e.detail = { keys:[changed keys], source?:meta.source, ...meta }
 *       sources used by U: "server" | "local" | "preview" | "media" | "viewer" | "user"
 *   on(key | key[] | "*", fn) → unsubscribe();  fn(value, keys, detail)
 *
 *   Keyboard: global shortcuts are handled by app/main.js on window (capture phase) and call
 *   e.preventDefault(). Other modules should ignore keydown events where e.defaultPrevented is true.
 *   Clips changed by Claude flash once in the timeline (CSS class "fs-flash", driven by state.flash in
 *   timeline.js) — styles.css defines the subtle animation. main.js shows one short toast per edit.
 * ============================================================================
 */

// ---------- optional shared modules (top-level await; failure tolerated) ----------
let opsMod = null;
let modelMod = null;
try { opsMod = await import('../shared/ops.js'); } catch (e) { console.warn('[api] shared/ops.js לא נטען — אין עדכון אופטימי', e); }
try { modelMod = await import('../shared/model.js'); } catch (e) { console.warn('[api] shared/model.js לא נטען', e); }

const API_BASE = '';

// ---------- HTTP ----------
function isRawBody(b) {
  return (typeof Blob !== 'undefined' && b instanceof Blob) || b instanceof ArrayBuffer || ArrayBuffer.isView(b);
}

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined && body !== null) {
    if (isRawBody(body)) {
      init.body = body;
      init.headers['Content-Type'] = (body.type) || 'application/octet-stream';
    } else if (typeof body === 'string') {
      init.body = body;
      init.headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
    }
  }
  let res;
  try {
    res = await fetch(API_BASE + path, init);
  } catch (e) {
    const err = new Error('אין חיבור לשרת של Frame Studio');
    err.status = 0; err.cause = e;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  let data;
  if (res.status === 204) data = null;
  else if (ct.includes('json')) { try { data = await res.json(); } catch { data = null; } }
  else data = await res.text();
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.error) ? data.error
      : (typeof data === 'string' && data.trim() && data.length < 300 ? data : `שגיאת שרת (${res.status})`);
    const err = new Error(msg);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  del: (path) => request('DELETE', path),
  put: (path, body = {}) => request('PUT', path, body),
  url: (path) => {
    if (/^https?:/i.test(path)) return path;
    const base = API_BASE || (typeof location !== 'undefined' ? location.origin : '');
    return base + path;
  },
};

// ---------- event bus (SSE + local pseudo events) ----------
const listeners = new Map(); // type -> Set<fn>
export function onEvent(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}
function emit(type, ev) {
  const run = (set) => { if (set) for (const fn of [...set]) { try { fn(ev); } catch (e) { console.error(`[api] listener "${type}" נכשל`, e); } } };
  run(listeners.get(type));
  run(listeners.get('*'));
}

// ---------- store ----------
const DEFAULTS = {
  projectId: null,
  project: null,
  selection: new Set(),
  playhead: 0,
  zoom: 80,
  playing: false,
  tool: 'select',
  snapping: true,
  previewScale: 0.5,
  range: { in: null, out: null },
  loop: false,
  connected: false,
  thirds: false,
  flash: { ids: [], at: 0 },
  activeKeyframe: null,
  history: { undo: 0, redo: 0, undoSummary: null, redoSummary: null, known: false },
};

class Store extends EventTarget {
  constructor() {
    super();
    for (const [k, v] of Object.entries(DEFAULTS)) this[k] = (v instanceof Set) ? new Set(v) : (v && typeof v === 'object' ? { ...v } : v);
  }
  get inPoint() { return this.range?.in ?? null; }
  get outPoint() { return this.range?.out ?? null; }
  get duration() { return projectDurationOf(this.project); }
  /** assign + dispatch one "change" event with the changed keys */
  set(partial, meta = {}) {
    if (!partial || typeof partial !== 'object') return;
    const p = { ...partial };
    // aliases
    if ('inPoint' in p || 'outPoint' in p) {
      p.range = { in: ('inPoint' in p ? p.inPoint : this.range.in), out: ('outPoint' in p ? p.outPoint : this.range.out) };
      delete p.inPoint; delete p.outPoint;
    }
    if ('selection' in p) {
      const s = p.selection;
      p.selection = s instanceof Set ? s : new Set(Array.isArray(s) ? s : (s == null ? [] : [s]));
    }
    if ('playhead' in p) { const v = Number(p.playhead); p.playhead = Number.isFinite(v) ? Math.max(0, v) : 0; }
    if ('zoom' in p) { const v = Number(p.zoom); p.zoom = Number.isFinite(v) ? Math.min(4000, Math.max(1, v)) : this.zoom; }
    if ('previewScale' in p) { const v = Number(p.previewScale); p.previewScale = [0.25, 0.5, 1].includes(v) ? v : (v > 0 && v <= 2 ? v : 0.5); }
    if ('range' in p && p.range) p.range = { in: p.range.in ?? null, out: p.range.out ?? null };
    const keys = [];
    for (const [k, v] of Object.entries(p)) {
      const old = this[k];
      const primitive = v === null || typeof v !== 'object';
      if (primitive && old === v) continue;
      this[k] = v;
      keys.push(k);
    }
    if (!keys.length) return;
    this.dispatchEvent(new CustomEvent('change', { detail: { ...meta, keys, changed: keys } }));
  }
}
export const state = new Store();

export function on(key, fn) {
  const wanted = Array.isArray(key) ? key : [key];
  const handler = (e) => {
    const keys = e.detail?.keys || [];
    if (wanted.includes('*') || keys.some((k) => wanted.includes(k))) {
      try { fn(wanted.length === 1 && wanted[0] !== '*' ? state[wanted[0]] : state, keys, e.detail); }
      catch (err) { console.error('[api] state listener נכשל', err); }
    }
  };
  state.addEventListener('change', handler);
  return () => state.removeEventListener('change', handler);
}

// ---------- helpers ----------
function projectDurationOf(p) {
  if (!p) return 0;
  if (modelMod?.projectDuration) { try { return modelMod.projectDuration(p); } catch { /* fallthrough */ } }
  let end = 0;
  for (const c of Object.values(p.clips || {})) end = Math.max(end, (c.start || 0) + (c.duration || 0));
  return Math.max(end, 1 / (p.settings?.fps || 30));
}

function makeUid(prefix) {
  if (modelMod?.uid) { try { return modelMod.uid(prefix); } catch { /* fallthrough */ } }
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes); else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = ''; for (const b of bytes) s += chars[b % 36];
  return prefix + s;
}

const CREATE_PREFIX = { addClip: 'c_', addTrack: 't_', addMarker: 'm_', sfx: 'c_' };
function prepareOps(ops) {
  return ops.filter(Boolean).map((op) => {
    const o = { ...op };
    if (CREATE_PREFIX[o.op] && !o.id) o.id = makeUid(CREATE_PREFIX[o.op]);
    return o;
  });
}

export function applyOpsLocal(project, ops) {
  if (!project || !opsMod?.applyOps) return null;
  try {
    const r = opsMod.applyOps(project, ops, { local: true });
    if (!r || !r.project) return null;
    return r;
  } catch (e) {
    console.warn('[api] applyOps מקומי נכשל', e);
    return null;
  }
}

function cleanSelection(project, sel) {
  if (!project) return new Set();
  const out = new Set();
  for (const id of sel) if (project.clips && project.clips[id]) out.add(id);
  return out;
}

function changedClipIds(prev, next) {
  const ids = [];
  const a = prev?.clips || {}; const b = next?.clips || {};
  for (const [id, c] of Object.entries(b)) {
    if (!a[id] || JSON.stringify(a[id]) !== JSON.stringify(c)) ids.push(id);
  }
  return ids;
}

// ---------- sync engine ----------
const sync = {
  base: null,        // last authoritative server project
  baseRev: -1,
  queue: [],         // tasks waiting to be sent: {kind, ops, summary, by, atomic, resolve}
  inflight: null,    // task being sent {.., echoed:boolean}
  es: null,
  esProject: null,
};

function pendingOpsForRebase({ includeInflight }) {
  const out = [];
  if (includeInflight && sync.inflight && sync.inflight.kind === 'ops') out.push(...sync.inflight.ops);
  for (const t of sync.queue) if (t.kind === 'ops') out.push(...t.ops);
  return out;
}

function emitSync() {
  emit('sync', { pending: sync.queue.length + (sync.inflight ? 1 : 0), inflight: !!sync.inflight, rev: sync.baseRev });
}

function publishProject(project, meta) {
  const sel = cleanSelection(project, state.selection);
  const patch = { project };
  if (sel.size !== state.selection.size) patch.selection = sel;
  state.set(patch, meta);
}

/** take an authoritative project from server; rebase pending local ops on top of it */
function acceptServerProject(project, { source, by, summary, includeInflight = false, force = false } = {}) {
  if (!project || typeof project !== 'object') return false;
  const rev = Number(project.rev ?? -1);
  if (rev < sync.baseRev && !force) {
    // stale — unless it is clearly newer in wall time (servers that restore an older rev on undo)
    const a = Date.parse(project.meta?.modified || '') || 0;
    const b = Date.parse(sync.base?.meta?.modified || '') || 0;
    if (!(source === 'sse' && !sync.inflight && a > b)) return false;
  }
  const prevView = state.project;
  sync.base = project;
  sync.baseRev = rev;
  let view = project;
  const pending = pendingOpsForRebase({ includeInflight });
  if (pending.length) {
    const r = applyOpsLocal(project, pending);
    if (r) view = r.project;
  }
  publishProject(view, { source: 'server', by, summary, rev, origin: source });
  if (by === 'claude') {
    const changedIds = changedClipIds(prevView, project);
    state.set({ flash: { ids: changedIds, at: Date.now() } }, { source: 'server', by: 'claude' });
    emit('claude', { summary: summary || '', rev, changedIds, project });
  }
  emitSync();
  return true;
}

function enqueue(task) {
  return new Promise((resolve) => {
    task.resolve = resolve;
    sync.queue.push(task);
    emitSync();
    pump();
  });
}

async function pump() {
  if (sync.inflight || !sync.queue.length) return;
  const task = sync.queue.shift();
  sync.inflight = task;
  task.echoed = false;
  emitSync();
  const pid = task.projectId;
  let out;
  try {
    let res;
    if (task.kind === 'ops') {
      res = await api.post(`/api/projects/${encodeURIComponent(pid)}/ops`, {
        ops: task.ops, by: task.by || 'user', summary: task.summary || '', ...(task.atomic ? { atomic: true } : {}),
      });
    } else {
      res = await api.post(`/api/projects/${encodeURIComponent(pid)}/${task.kind}`, {});
    }
    sync.inflight = null;
    if (pid === state.projectId && res?.history) setHistory(res.history);
    if (pid === state.projectId && res && res.project) {
      // the response is authoritative for this task; queued (unsent) tasks get rebased
      const force = task.kind !== 'ops';
      const rrev = Number(res.project.rev ?? -1);
      const alreadyHave = !force && task.echoed && rrev === sync.baseRev; // SSE echo already delivered this exact rev
      if (alreadyHave) { /* view is already base + queued — nothing to republish */ }
      else if (force || rrev >= sync.baseRev) acceptServerProject(res.project, { source: 'response', by: task.by || 'user', summary: task.summary, force });
      else recomputeView();
    }
    const results = res?.results || [];
    const failed = results.filter((r) => r && r.ok === false);
    if (failed.length && !task.silent) {
      emit('error', { message: failed.map((f) => f.error).filter(Boolean).slice(0, 3).join(' · ') || 'חלק מהפעולות נכשלו' });
    }
    out = { ok: failed.length === 0, rev: res?.rev ?? res?.project?.rev, results, project: res?.project || state.project, localResults: task.localResults };
  } catch (e) {
    sync.inflight = null;
    // roll back optimistic changes of this task: rebuild view from base + still-queued tasks
    recomputeView();
    if (!task.silent) {
      const label = task.kind === 'undo' ? 'ביטול פעולה נכשל' : task.kind === 'redo' ? 'ביצוע מחדש נכשל' : 'השינוי לא נשמר';
      emit('error', { message: `${label}: ${e.message}` });
    }
    out = { ok: false, error: e.message, results: [], project: state.project };
    if (e.status === 409 || e.status === 0) { reloadProject().catch(() => {}); }
  }
  emitSync();
  task.resolve(out);
  pump();
}

function recomputeView() {
  if (!sync.base) return;
  let view = sync.base;
  const pending = pendingOpsForRebase({ includeInflight: !!(sync.inflight && !sync.inflight.echoed) });
  if (pending.length) { const r = applyOpsLocal(sync.base, pending); if (r) view = r.project; }
  publishProject(view, { source: 'server', rev: sync.baseRev });
}

export function applyOps(ops, summary = '', opts = {}) {
  if (!Array.isArray(ops)) ops = [ops];
  const prepared = prepareOps(ops);
  if (!prepared.length) return Promise.resolve({ ok: true, results: [], rev: sync.baseRev, project: state.project });
  if (!state.projectId) {
    emit('error', { message: 'אין פרויקט פתוח' });
    return Promise.resolve({ ok: false, error: 'אין פרויקט פתוח', results: [] });
  }
  let localResults = null;
  const local = applyOpsLocal(state.project, prepared);
  if (local) {
    localResults = local.results;
    publishProject(local.project, { source: 'local', summary });
  }
  return enqueue({ kind: 'ops', ops: prepared, summary, by: opts.by || 'user', atomic: !!opts.atomic, silent: !!opts.silent, projectId: state.projectId, localResults });
}

export function previewOps(ops) {
  if (!Array.isArray(ops)) ops = [ops];
  const r = applyOpsLocal(state.project, ops.filter(Boolean));
  if (r) publishProject(r.project, { source: 'preview' });
  return r;
}

export function undo() {
  if (!state.projectId) return Promise.resolve({ ok: false, error: 'אין פרויקט פתוח' });
  return enqueue({ kind: 'undo', ops: [], projectId: state.projectId, by: 'user' });
}
export function redo() {
  if (!state.projectId) return Promise.resolve({ ok: false, error: 'אין פרויקט פתוח' });
  return enqueue({ kind: 'redo', ops: [], projectId: state.projectId, by: 'user' });
}

export function isSyncing() { return !!sync.inflight || sync.queue.length > 0; }

// ---------- SSE ----------
function setHistory(hh) {
  if (!hh || typeof hh !== 'object') return;
  state.set({ history: { undo: hh.undo | 0, redo: hh.redo | 0, undoSummary: hh.undoSummary ?? null, redoSummary: hh.redoSummary ?? null, known: true } }, { source: 'server' });
}

function handleServerEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.history && (ev.type === 'project' || ev.type === 'hello')) setHistory(ev.history);
  switch (ev.type) {
    case 'project': {
      if (ev.project) {
        let includeInflight = false;
        if (sync.inflight && sync.inflight.kind === 'ops') {
          if ((ev.by || 'user') === 'user') sync.inflight.echoed = true;   // most likely our own echo
          else includeInflight = !sync.inflight.echoed;                    // someone else's change; ours not applied yet
        }
        acceptServerProject(ev.project, { source: 'sse', by: ev.by, summary: ev.summary, includeInflight });
      } else if (Number(ev.rev) > sync.baseRev) {
        reloadProject().then(() => {
          if (ev.by === 'claude') emit('claude', { summary: ev.summary || '', rev: ev.rev, changedIds: [], project: state.project });
        }).catch(() => {});
      }
      break;
    }
    case 'media': {
      const m = ev.media;
      if (m && m.id && state.project) {
        const merge = (p) => (p ? { ...p, media: { ...(p.media || {}), [m.id]: { ...((p.media || {})[m.id] || {}), ...m } } } : p);
        sync.base = merge(sync.base);
        state.set({ project: merge(state.project) }, { source: 'media', mediaId: m.id });
      }
      break;
    }
    case 'hello': {
      if (ev.rev != null && Number(ev.rev) !== sync.baseRev && state.projectId) reloadProject().catch(() => {});
      break;
    }
    default: break;
  }
  emit(ev.type || 'message', ev);
}

function connectEvents(projectId) {
  if (sync.es) { try { sync.es.close(); } catch { /* ignore */ } sync.es = null; }
  if (!projectId || typeof EventSource === 'undefined') return;
  const es = new EventSource(api.url(`/api/events?project=${encodeURIComponent(projectId)}`));
  sync.es = es; sync.esProject = projectId;
  const parse = (e) => { try { handleServerEvent(JSON.parse(e.data)); } catch (err) { console.warn('[api] SSE לא תקין', err, e.data); } };
  es.onmessage = parse;
  for (const t of ['project', 'media', 'job', 'hello']) es.addEventListener(t, parse);
  es.onopen = () => { if (!state.connected) { state.set({ connected: true }, { source: 'sse' }); emit('connection', { connected: true }); } };
  es.onerror = () => {
    if (state.connected) { state.set({ connected: false }, { source: 'sse' }); emit('connection', { connected: false }); }
  };
}

export async function openProject(id) {
  const project = await api.get(`/api/projects/${encodeURIComponent(id)}`);
  sync.base = null; sync.baseRev = -1; sync.queue = []; sync.inflight = null;
  state.set({ projectId: id, selection: new Set(), playhead: 0, range: { in: null, out: null } }, { source: 'user' });
  acceptServerProject(project, { source: 'load' });
  connectEvents(id);
  return project;
}

export async function reloadProject() {
  if (!state.projectId) return null;
  const project = await api.get(`/api/projects/${encodeURIComponent(state.projectId)}`);
  acceptServerProject(project, { source: 'reload', includeInflight: !!sync.inflight && !sync.inflight.echoed, force: true });
  return project;
}

export function closeEvents() { if (sync.es) { try { sync.es.close(); } catch { /* ignore */ } sync.es = null; } }

/** emit a local error/info event (used by other U modules) */
export function reportError(message) { emit('error', { message }); }

export const hasLocalOps = () => !!opsMod?.applyOps;
