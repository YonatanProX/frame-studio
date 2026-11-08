// Frame Studio — tools/tests/U-mock-server.mjs (agent U self-test)
// Mock of the SPEC §5 server for testing the editor UI in isolation on port 7794.
// Serves ROOT statically, fakes projects/ops/undo/redo/SSE/media/library/export jobs, using shared/ops.js when present.
// Test hooks: POST /__test/claude {ops, summary} → applies ops as "claude" and broadcasts (live-sync test).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MEDIA_DIR = path.join(HERE, 'U-media'); // gitignored — generated below with ffmpeg when missing
const PORT = Number(process.env.PORT || 7794);

/** Generate the fixture media (video + image + voice/music/sfx tones + 8 thumbnails) on a fresh clone. */
function ensureMedia() {
  const ff = process.env.FRAME_STUDIO_FFMPEG || 'ffmpeg';
  const run = (args) => {
    const r = spawnSync(ff, ['-v', 'error', '-y', ...args], { cwd: MEDIA_DIR, windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error(`ffmpeg failed (${args.at(-1)}): ${r.error ? r.error.message : r.stderr}`);
  };
  const want = {
    'video.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=8',
      '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', 'video.mp4'],
    'image.png': ['-f', 'lavfi', '-i', 'gradients=size=1080x1080:duration=1', '-frames:v', '1', 'image.png'],
    'voice.wav': ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6', '-af', 'volume=0.5', '-ac', '2', 'voice.wav'],
    'music.wav': ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-af', 'volume=0.3', '-ac', '2', 'music.wav'],
    'sfx.wav': ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=0.6', '-af', 'afade=t=out:st=0.2:d=0.4', '-ac', '2', 'sfx.wav'],
  };
  try {
    fs.mkdirSync(path.join(MEDIA_DIR, 'thumbs'), { recursive: true });
    for (const [f, args] of Object.entries(want)) if (!fs.existsSync(path.join(MEDIA_DIR, f))) { console.log(`[mock] generating U-media/${f}`); run(args); }
    if (!fs.existsSync(path.join(MEDIA_DIR, 'thumbs', '00008.jpg'))) {
      console.log('[mock] generating U-media/thumbs');
      run(['-i', 'video.mp4', '-vf', 'fps=1,scale=160:-2', '-frames:v', '8', path.join('thumbs', '%05d.jpg')]);
    }
  } catch (e) { console.warn('[mock] could not generate the test media (is ffmpeg on PATH?):', e.message); }
}
ensureMedia();

let ops = null; let model = null;
try { ops = await import(pathToFileURL(path.join(ROOT, 'shared/ops.js')).href); } catch (e) { console.warn('[mock] ops.js unavailable:', e.message); }
try { model = await import(pathToFileURL(path.join(ROOT, 'shared/model.js')).href); } catch (e) { console.warn('[mock] model.js unavailable:', e.message); }
// a real server should preload the render catalogs so catalog-based ids (caption styles, effects…) validate server-side
try { const cat = await import(pathToFileURL(path.join(ROOT, 'shared/catalog.js')).href); const c = await cat.getCatalog(); console.log('[mock] catalog loaded:', c.loaded, (c.errors || []).join(' | ')); } catch (e) { console.warn('[mock] catalog unavailable:', e.message); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.cube': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

// ------------------------------------------------------------------ store
const projects = new Map(); // id -> { project, undo:[], redo:[] }
const clients = new Map();  // projectId -> Set<res>
const jobs = new Map();

const now = () => new Date().toISOString();
function hist(e) { return { undo: e.undo.length, redo: e.redo.length, undoSummary: e.undo.at(-1)?.summary || null, redoSummary: e.redo.at(-1)?.summary || null }; }
function broadcast(pid, ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients.get(pid) || []) { try { res.write(data); } catch { /* ignore */ } }
}
function commit(pid, next, by, summary) {
  const e = projects.get(pid);
  e.undo.push({ data: JSON.stringify(e.project), summary }); e.redo = [];
  next.rev = (e.project.rev || 0) + 1; next.meta = { ...(next.meta || {}), modified: now(), lastEditor: by };
  e.project = next;
  broadcast(pid, { type: 'project', rev: next.rev, by, summary, project: next, history: hist(e) });
  return next;
}
let claudeSeenAt = 0;
function runOps(pid, list, by, summary, atomic) {
  const e = projects.get(pid);
  if (by === 'claude') claudeSeenAt = Date.now();
  if (!ops) { return { project: e.project, results: list.map(() => ({ ok: false, error: 'ops.js לא זמין בשרת הדמה' })) }; }
  const r = ops.applyOps(e.project, list, { atomic });
  const changed = r.results.some((x) => x.ok);
  if (changed) commit(pid, r.project, by, summary || (ops.summarizeOps ? ops.summarizeOps(list) : 'עריכה'));
  return { rev: projects.get(pid).project.rev, results: r.results, project: projects.get(pid).project, history: hist(projects.get(pid)) };
}

function media(id, kind, file, extra) {
  return { id, kind, name: file, path: path.join(MEDIA_DIR, file), status: 'ready', size: fs.existsSync(path.join(MEDIA_DIR, file)) ? fs.statSync(path.join(MEDIA_DIR, file)).size : 0, ...extra };
}

function seedProject() {
  const base = model?.newProject ? model.newProject({ id: 'u-demo', name: 'סרטון הדגמה — עריכה', width: 1080, height: 1920, fps: 30 }) : null;
  let p = base || { version: 1, id: 'u-demo', name: 'סרטון הדגמה', rev: 0, settings: { width: 1080, height: 1920, fps: 30, background: '#000000', sampleRate: 48000, safeArea: 'reels', masterGainDb: 0, targetLufs: -14 }, media: {}, tracks: [], clips: {}, markers: [], transcript: { words: [] }, meta: {} };
  p.settings.safeArea = 'reels';
  if (!ops) return p;
  const M = [
    media('m_vid', 'video', 'video.mp4', { duration: 8, width: 540, height: 960, fps: 30, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000, proxy: 'video.mp4', audio: 'video.mp4', thumbs: 'thumbs' }),
    media('m_img', 'image', 'image.png', { duration: 0, width: 1080, height: 1080, hasVideo: true, hasAudio: false }),
    media('m_voice', 'audio', 'voice.wav', { duration: 6, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, audio: 'voice.wav' }),
    media('m_music', 'audio', 'music.wav', { duration: 10, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, audio: 'music.wav' }),
    media('m_sfx', 'audio', 'sfx.wav', { duration: 0.6, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, audio: 'sfx.wav' }),
  ];
  const words = [['ככה', 3.0, 3.3], ['עורכים', 3.32, 3.8], ['סרטונים', 3.85, 4.4], ['בקלות!', 4.45, 5.1]];
  const list = [
    { op: 'addMedia', media: M },
    { op: 'addClip', id: 'c_vid', type: 'video', mediaId: 'm_vid', start: 0, duration: 8, role: 'main', name: 'צילום אתר' },
    { op: 'addClip', id: 'c_img', type: 'image', mediaId: 'm_img', start: 1, duration: 4, role: 'overlay', set: { 'transform.scale': 0.55, 'transform.y': -420, 'mask.type': 'none' } },
    { op: 'setKeyframes', id: 'c_img', prop: 'transform.scale', keys: [{ t: 0, v: 0.4 }, { t: 0.6, v: 0.6, ease: 'spring' }, { t: 3, v: 0.55, ease: 'easeInOut' }] },
    { op: 'addClip', id: 'c_title', type: 'text', start: 0, duration: 3, content: 'ככה עורכים סרטונים', set: { 'transform.y': -640, 'text.size': 104, 'text.stroke.width': 10, 'text.color': '#ffffff' } },
    { op: 'addClip', id: 'c_shape', type: 'shape', start: 2, duration: 3, role: 'overlay', set: { 'shape.kind': 'roundrect', 'shape.w': 640, 'shape.h': 120, 'shape.fill': '#3b82f6', 'transform.y': 520 } },
    { op: 'addClip', id: 'c_sticker', type: 'sticker', start: 1.5, duration: 2, set: { 'sticker.value': '🔥', 'transform.x': 300, 'transform.y': -200 } },
    { op: 'addCaptions', words, style: 'popWords', maxWords: 2, hot: ['סרטונים'], y: 330 },
    { op: 'addClip', id: 'c_voice', type: 'audio', mediaId: 'm_voice', start: 0.5, role: 'voice', name: 'קריינות' },
    { op: 'addClip', id: 'c_music', type: 'audio', mediaId: 'm_music', start: 0, duration: 8, role: 'music', name: 'מוזיקה', volume: 0.5, fadeOut: 1 },
    { op: 'addClip', id: 'c_sfx', type: 'audio', mediaId: 'm_sfx', start: 2.9, role: 'sfx', name: 'וושש' },
    // (no setTransition here: c_vid is the only main clip, a transition needs an adjacent clip after it)
    { op: 'addMarker', t: 3, label: 'הוק' }, { op: 'addMarker', t: 6, label: 'דרופ', color: '#ff4d6d' },
    { op: 'setTranscript', words },
  ];
  const r = ops.applyOps(p, list);
  const bad = r.results.filter((x) => !x.ok);
  if (bad.length) console.warn('[mock] seed op errors:', bad.map((b) => `${b.op}: ${b.error}`).join(' | '));
  p = r.project; p.rev = 1;
  return p;
}
projects.set('u-demo', { project: seedProject(), undo: [], redo: [] });

// ------------------------------------------------------------------ http helpers
function sendJson(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); res.end(b); }
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
async function readJson(req) { const b = await readBody(req); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch { return {}; } }
async function serveFile(req, res, abs) {
  let st; try { st = await fsp.stat(abs); } catch { return sendJson(res, 404, { error: 'הקובץ לא נמצא' }); }
  if (st.isDirectory()) return sendJson(res, 404, { error: 'תיקייה' });
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range); let a = m[1] ? Number(m[1]) : 0; let b = m[2] ? Number(m[2]) : st.size - 1;
    if (!m[1] && m[2]) { a = st.size - Number(m[2]); b = st.size - 1; }
    b = Math.min(b, st.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 });
    fs.createReadStream(abs, { start: a, end: b }).pipe(res); return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
}

function listItem(e) {
  const p = e.project; let dur = 0; for (const c of Object.values(p.clips || {})) dur = Math.max(dur, c.start + c.duration);
  return { id: p.id, name: p.name, width: p.settings.width, height: p.settings.height, fps: p.settings.fps, duration: dur, modified: p.meta?.modified || now(), clipCount: Object.keys(p.clips || {}).length };
}

// ------------------------------------------------------------------ export job simulation
function startJob(pid, body) {
  const id = `job_${Date.now().toString(36)}`;
  const e = projects.get(pid);
  let dur = 0; for (const c of Object.values(e.project.clips)) dur = Math.max(dur, c.start + c.duration);
  const fps = body.fps || 30; const total = Math.ceil(((body.to ?? dur) - (body.from ?? 0)) * fps);
  const job = { id, type: 'export', projectId: pid, status: 'running', phase: 'video', progress: 0, frames: 0, totalFrames: total, eta: null, outputs: [], report: null, error: null, body };
  jobs.set(id, job);
  const t0 = Date.now(); const ms = Number(process.env.JOB_MS || 2500);
  job.timer = setInterval(() => {
    if (job.status !== 'running') { clearInterval(job.timer); return; }
    const p = Math.min(1, (Date.now() - t0) / ms);
    job.progress = p; job.frames = Math.round(total * p); job.eta = Math.max(0, (ms - (Date.now() - t0)) / 1000);
    job.phase = p < 0.9 ? 'video' : 'finishing';
    if (p >= 1) {
      clearInterval(job.timer);
      job.status = 'done'; job.phase = 'done'; job.progress = 1;
      job.outputs = [path.join(ROOT, 'projects', pid, 'exports', `${pid}-test.mp4`).replace(/\\/g, '/')];
      job.report = { duration: dur, size: 4_812_345, lufs: -14.1, truePeak: -1.2, speech: { min: 13.4, median: 17.9 } };
    }
    broadcast(pid, { type: 'job', job: publicJob(job) });
  }, 200);
  return publicJob(job);
}
const publicJob = (j) => { const { timer, ...rest } = j; return rest; };

// ------------------------------------------------------------------ routes
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(u.pathname);
  try {
    if (p === '/api/health') return sendJson(res, 200, { ok: true, version: 'mock', root: ROOT, port: PORT });
    // Claude indicator (server/library.mjs claudeStatus): set up but not used yet → "ready"; a Claude edit → "connected"
    if (p === '/api/claude/status' || (p === '/api/claude/hello' && req.method === 'POST')) {
      const connected = claudeSeenAt > 0 && Date.now() - claudeSeenAt < 15 * 60_000;
      return sendJson(res, 200, { ok: true, connected, ready: true, state: connected ? 'connected' : 'ready', lastSeen: claudeSeenAt ? new Date(claudeSeenAt).toISOString() : null,
        client: connected ? 'mock' : null, desktop: { installed: true, configured: true, broken: false, file: null }, code: { skill: false } });
    }
    if (p === '/api/projects' && req.method === 'GET') return sendJson(res, 200, [...projects.values()].map(listItem));
    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readJson(req);
      const id = b.id || `p-${Date.now().toString(36)}`;
      const pr = model?.newProject ? model.newProject({ id, name: b.name, width: b.width, height: b.height, fps: b.fps }) : { id, name: b.name, rev: 0, settings: { width: b.width, height: b.height, fps: b.fps }, tracks: [], clips: {}, media: {}, markers: [] };
      if (b.tracks === 'empty') pr.tracks = [];
      projects.set(id, { project: pr, undo: [], redo: [] });
      return sendJson(res, 200, pr);
    }
    if (p === '/api/events') {
      const pid = u.searchParams.get('project');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const e = projects.get(pid);
      res.write(`data: ${JSON.stringify({ type: 'hello', rev: e?.project.rev ?? 0, history: e ? hist(e) : null })}\n\n`);
      if (!clients.has(pid)) clients.set(pid, new Set());
      clients.get(pid).add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); clients.get(pid)?.delete(res); });
      return;
    }
    if (p === '/__test/claude' && req.method === 'POST') {
      const b = await readJson(req);
      const pid = b.project || 'u-demo';
      return sendJson(res, 200, runOps(pid, b.ops || [], 'claude', b.summary || 'עריכה של קלוד'));
    }
    let m;
    if ((m = /^\/api\/projects\/([^/]+)$/.exec(p))) {
      const e = projects.get(m[1]);
      if (!e) return sendJson(res, 404, { error: 'הפרויקט לא נמצא' });
      if (req.method === 'DELETE') { projects.delete(m[1]); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 200, e.project);
    }
    if ((m = /^\/api\/projects\/([^/]+)\/ops$/.exec(p)) && req.method === 'POST') {
      const e = projects.get(m[1]); if (!e) return sendJson(res, 404, { error: 'הפרויקט לא נמצא' });
      const b = await readJson(req);
      await new Promise((r) => setTimeout(r, Number(process.env.OPS_DELAY || 30)));
      return sendJson(res, 200, runOps(m[1], b.ops || [], b.by || 'user', b.summary, b.atomic));
    }
    if ((m = /^\/api\/projects\/([^/]+)\/(undo|redo)$/.exec(p)) && req.method === 'POST') {
      const e = projects.get(m[1]); if (!e) return sendJson(res, 404, { error: 'הפרויקט לא נמצא' });
      const from = m[2] === 'undo' ? e.undo : e.redo; const to = m[2] === 'undo' ? e.redo : e.undo;
      if (!from.length) return sendJson(res, 400, { error: m[2] === 'undo' ? 'אין מה לבטל' : 'אין מה לבצע מחדש' });
      const item = from.pop(); to.push({ data: JSON.stringify(e.project), summary: item.summary });
      const next = JSON.parse(item.data); next.rev = e.project.rev + 1; e.project = next;
      broadcast(m[1], { type: 'project', rev: next.rev, by: 'user', summary: `${m[2] === 'undo' ? 'ביטול' : 'ביצוע מחדש'}: ${item.summary}`, project: next, history: hist(e) });
      return sendJson(res, 200, { rev: next.rev, project: next, history: hist(e) });
    }
    if ((m = /^\/api\/projects\/([^/]+)\/media\/([^/]+)\/(file|proxy|audio|peaks|thumb)$/.exec(p))) {
      const e = projects.get(m[1]); const md = e?.project.media?.[m[2]];
      if (!md) return sendJson(res, 404, { error: 'מדיה לא נמצאה' });
      if (m[3] === 'thumb') {
        const t = Math.max(0, Math.floor(Number(u.searchParams.get('t') || 0)));
        const n = Math.min(8, t + 1);
        const f = md.kind === 'image' ? path.join(MEDIA_DIR, 'image.png') : path.join(MEDIA_DIR, 'thumbs', `${String(n).padStart(5, '0')}.jpg`);
        return serveFile(req, res, f);
      }
      if (m[3] === 'peaks') {
        const n = Math.round((md.duration || 1) * 100); const peaks = [];
        for (let i = 0; i < n; i++) peaks.push(Math.round((0.25 + 0.6 * Math.abs(Math.sin(i / 7)) * (0.6 + 0.4 * Math.sin(i / 53))) * 1000) / 1000);
        return sendJson(res, 200, { rate: 100, peaks });
      }
      return serveFile(req, res, md.path);
    }
    if ((m = /^\/api\/projects\/([^/]+)\/upload$/.exec(p)) && req.method === 'POST') {
      await readBody(req);
      return sendJson(res, 200, { media: [] });
    }
    if ((m = /^\/api\/projects\/([^/]+)\/export$/.exec(p)) && req.method === 'POST') {
      const b = await readJson(req);
      return sendJson(res, 200, startJob(m[1], b));
    }
    if ((m = /^\/api\/jobs\/([^/]+)$/.exec(p))) { const j = jobs.get(m[1]); return j ? sendJson(res, 200, publicJob(j)) : sendJson(res, 404, { error: 'משימה לא נמצאה' }); }
    if ((m = /^\/api\/jobs\/([^/]+)\/(cancel|fail)$/.exec(p)) && req.method === 'POST') {
      const j = jobs.get(m[1]); if (!j) return sendJson(res, 404, { error: 'משימה לא נמצאה' });
      j.status = 'canceled'; j.error = 'המשימה בוטלה'; broadcast(j.projectId, { type: 'job', job: publicJob(j) });
      return sendJson(res, 200, publicJob(j));
    }
    if (p === '/api/library/fonts') return sendJson(res, 200, [
      { family: 'Heebo', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], url: '/library/fonts/Heebo-VariableFont_wght.ttf', system: false, license: 'OFL' },
      { family: 'Assistant', weights: [200, 300, 400, 500, 600, 700, 800], system: false, license: 'OFL' },
      { family: 'Arial', weights: [400, 700], system: true }, { family: 'David', weights: [400, 700], system: true }, { family: 'Gisha', weights: [400, 700], system: true },
    ]);
    if (p === '/api/library/luts') { const files = (await fsp.readdir(path.join(ROOT, 'library/luts')).catch(() => [])).filter((f) => f.endsWith('.cube')); return sendJson(res, 200, files); }
    if (p.startsWith('/api/library/sounds')) return sendJson(res, 200, p.endsWith('/categories') ? [] : { items: [], total: 0 });
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: `נתיב דמה לא קיים: ${p}` });

    // static
    let rel = p === '/' ? '/app/index.html' : p;
    if (!/^\/(app|render|shared|library\/fonts|library\/luts|tools\/tests)\//.test(rel)) return sendJson(res, 404, { error: 'לא נמצא' });
    const abs = path.resolve(ROOT, '.' + rel);
    if (!abs.startsWith(ROOT)) return sendJson(res, 403, { error: 'אסור' });
    return serveFile(req, res, abs);
  } catch (err) {
    console.error('[mock]', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[mock] Frame Studio UI mock on http://127.0.0.1:${PORT}`));
