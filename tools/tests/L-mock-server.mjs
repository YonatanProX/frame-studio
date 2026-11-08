// Agent L mock server (port 7795): serves ROOT statically + a fake project API backed by the real ops engine,
// the REAL server/library.mjs routes (sound index, fonts, LUTs, licenses), thumbnails/peaks from tools/tests/L-assets.
// Usage: node tools/tests/L-mock-server.mjs   (then open http://127.0.0.1:7795/tools/tests/L-test.html)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyOps } from '../../shared/ops.js';
import * as LIB from '../../server/library.mjs';
import { makeFixture, ASSETS } from './L-fixture.mjs';
import { ensureAssets } from './L-make-assets.mjs';

if (ensureAssets()) console.log('generated test media in tools/tests/L-assets');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = +(process.env.PORT || 7795);
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.cube': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon' };

let project = makeFixture();
const opsLog = [];
const clients = new Set();
const THUMB_DIR = { m_v1: 'v_demo', m_v2: 'v_demo2', m_img: 'i_photo', m_proc: 'v_demo' };

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function readBody(req) { const ch = []; for await (const c of req) ch.push(c); return Buffer.concat(ch); }
async function readJson(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
function broadcast(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); }

function serveFile(req, res, abs) { return LIB.serveFileFallback(req, res, abs); }
function serveStatic(req, res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    if (/^(audio|video)\//.test(type)) return serveFile(req, res, abs);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  });
}

const peaksCache = new Map();
function computePeaks(abs) {
  if (peaksCache.has(abs)) return peaksCache.get(abs);
  const p = new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', abs, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true });
    const peaks = []; let m = 0, n = 0; let carry = null;
    ff.stdout.on('data', (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      if (buf.length & 1) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
      for (let i = 0; i < buf.length; i += 2) { let v = buf.readInt16LE(i); if (v < 0) v = -v; if (v > m) m = v; if (++n === 80) { peaks.push(Math.round((m / 32768) * 1000) / 1000); m = 0; n = 0; } }
    });
    ff.on('close', () => resolve({ rate: 100, peaks }));
    ff.on('error', () => resolve({ rate: 100, peaks: [] }));
  });
  peaksCache.set(abs, p);
  return p;
}

const ctx = { ROOT, PORT, sendJson, readJson, readBody, serveFile, log: (...a) => console.log(...a), broadcast: () => {}, projectDir: () => ROOT };
const libRoutes = LIB.routes(ctx);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(u.pathname);
  try {
    for (const r of libRoutes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(p);
      if (m) return await r.handler(req, res, m, ctx);
    }
    if (p === '/api/health') return sendJson(res, 200, { ok: true, version: 'mock-L', root: ROOT, port: PORT });
    if (p === '/api/ops-log') return sendJson(res, 200, opsLog);
    if (p === '/api/reset' && req.method === 'POST') {
      project = makeFixture(); opsLog.length = 0;
      const big = Math.min(2000, +(u.searchParams.get('big') || 0));
      if (big) {
        // stress: many clips over 4 extra tracks (sfx-like audio + text), 60 s long
        const extra = [['t_b1', 'audio', 'sfx'], ['t_b2', 'audio', 'sfx'], ['t_b3', 'video', 'text'], ['t_b4', 'video', 'overlay']];
        for (const [id, kind, role] of extra) project.tracks.push({ id, kind, role, name: `עומס ${id.slice(-1)}`, hidden: false, muted: false, locked: false, solo: false, volume: 1 });
        for (let i = 0; i < big; i++) {
          const [tid, kind] = extra[i % 4];
          const start = Math.floor(i / 4) * (60 / Math.ceil(big / 4));
          const dur = (60 / Math.ceil(big / 4)) * 0.85;
          const base = { id: `c_big${i}`, trackId: tid, start, duration: dur, name: `קליפ ${i}`, disabled: false, keyframes: {}, effects: [] };
          project.clips[base.id] = kind === 'audio' ? { ...base, type: 'audio', mediaId: i % 2 ? 'm_vo' : 'm_mus', in: (i % 7) * 0.5, speed: 1, volume: 0.6, fadeIn: 0, fadeOut: 0 }
            : { ...base, type: i % 8 === 2 ? 'text' : 'image', mediaId: 'm_img', text: { content: `טקסט ${i}`, color: '#fff', weight: 800 }, color: {} };
        }
      } broadcast({ type: 'project', rev: project.rev, by: 'user', summary: 'reset', project }); return sendJson(res, 200, { ok: true }); }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', rev: project.rev })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/projects' && req.method === 'GET') return sendJson(res, 200, [{ id: project.id, name: project.name, width: 1080, height: 1920, fps: 30, duration: 15, modified: new Date().toISOString(), clipCount: Object.keys(project.clips).length }]);
    let m = /^\/api\/projects\/([^/]+)$/.exec(p);
    if (m && req.method === 'GET') return sendJson(res, 200, project);
    m = /^\/api\/projects\/([^/]+)\/ops$/.exec(p);
    if (m && req.method === 'POST') {
      const body = await readJson(req);
      const r = applyOps(project, body.ops || [], { atomic: !!body.atomic });
      project = { ...r.project, rev: (project.rev || 0) + 1 };
      opsLog.push({ ops: body.ops, summary: body.summary, by: body.by, results: r.results });
      console.log(`[ops] ${body.summary || ''} :: ${(body.ops || []).map((o) => o.op).join(', ')} :: ${r.results.map((x) => (x && x.ok === false ? 'ERR ' + x.error : 'ok')).join(', ')}`);
      broadcast({ type: 'project', rev: project.rev, by: body.by || 'user', summary: body.summary || '', project });
      return sendJson(res, 200, { rev: project.rev, results: r.results, project });
    }
    m = /^\/api\/projects\/([^/]+)\/(undo|redo)$/.exec(p);
    if (m) return sendJson(res, 200, { rev: project.rev, project });
    m = /^\/api\/projects\/([^/]+)\/media\/([^/]+)\/(thumb|peaks|file|proxy|audio)$/.exec(p);
    if (m) {
      const media = project.media[m[2]];
      if (!media) return sendJson(res, 404, { error: 'מדיה לא נמצאה' });
      if (m[3] === 'thumb') {
        const dir = path.join(ASSETS, 'thumbs', THUMB_DIR[m[2]] || 'v_demo');
        const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
        const t = Math.max(0, Math.floor(+u.searchParams.get('t') || 0));
        const f = files[Math.min(files.length - 1, t)];
        return serveStatic(req, res, path.join(dir, f));
      }
      if (m[3] === 'peaks') return sendJson(res, 200, await computePeaks(media.path));
      return serveFile(req, res, media.path);
    }
    m = /^\/api\/projects\/([^/]+)\/upload$/.exec(p);
    if (m && req.method === 'POST') {
      const buf = await readBody(req);
      const name = u.searchParams.get('name') || 'upload.bin';
      const id = 'm_up' + Object.keys(project.media).length;
      const media = { id, kind: /\.(wav|mp3|m4a)$/i.test(name) ? 'audio' : /\.(png|jpe?g|webp)$/i.test(name) ? 'image' : 'video', name, path: path.join(ASSETS, 'v_demo.mp4'), duration: 5, width: 640, height: 360, status: 'processing', size: buf.length, hasAudio: true };
      project = { ...project, media: { ...project.media, [id]: media } };
      setTimeout(() => { media.status = 'ready'; broadcast({ type: 'media', media }); }, 800);
      return sendJson(res, 200, { media: [media] });
    }
    m = /^\/api\/projects\/([^/]+)\/import$/.exec(p);
    if (m && req.method === 'POST') { const b = await readJson(req); return sendJson(res, 200, { media: (b.paths || []).map((x, i) => ({ id: 'm_imp' + i, kind: 'video', name: path.basename(x), path: x, status: 'processing' })) }); }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: `נתיב לא קיים במוק: ${p}` });
    // static
    let rel = p === '/' ? '/tools/tests/L-test.html' : p;
    const abs = path.join(ROOT, ...rel.split('/').filter(Boolean));
    if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    return serveStatic(req, res, abs);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock server on http://127.0.0.1:${PORT}/tools/tests/L-test.html`));
setInterval(() => { for (const c of clients) c.write(': hb\n\n'); }, 15000);
