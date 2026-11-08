// Agent A test server (port 7793): static ROOT + fake project/media API + optional export.mjs routes.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const ASSETS = path.join(HERE, 'A-assets');
export const OUT = path.join(HERE, 'A-out');
// test projects live inside the gitignored A-out/ folder, never loose in tools/tests
export const PROJ = path.join(OUT, 'proj');
/** Browser profiles for the A tests: in the OS temp folder, never inside the repository (they hold cookies/history). */
export const profileDir = (name) => path.join(os.tmpdir(), 'frame-studio-tests', name);
const STUBS = path.join(HERE, 'A-stubs');

const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.png': 'image/png', '.css': 'text/css', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
}
async function serveFile(req, res, abs) {
  try {
    const st = await fsp.stat(abs);
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(abs).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'לא נמצא' });
  }
}

/** Port of the A tests (FS_TEST_PORT overrides 7793, to run beside another test / server). */
export const TEST_PORT = Number(process.env.FS_TEST_PORT) || 7793;

export async function startServer({ port = TEST_PORT, useStubs = false, mountExport = false, onResult = null } = {}) {
  await fsp.mkdir(OUT, { recursive: true });
  const events = [];
  const ctx = {
    ROOT, PORT: port,
    async loadProject(id) { return JSON.parse(await fsp.readFile(path.join(PROJ, id, 'project.json'), 'utf8')); },
    async saveProject() {},
    async applyAndBroadcast() {},
    broadcast(projectId, ev) { events.push({ projectId, ev }); },
    sendJson, readJson: async (req) => JSON.parse((await readBody(req)).toString('utf8') || '{}'), readBody, serveFile,
    projectDir: (id) => path.join(PROJ, id),
    log: (...a) => console.log('   [server]', ...a),
  };
  let routes = [];
  if (mountExport) {
    const ex = await import(pathToFileURL(path.join(ROOT, 'server', 'export.mjs')).href);
    routes = ex.routes(ctx);
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = decodeURIComponent(url.pathname);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname + url.search);
        if (m) { await r.handler(req, res, m, ctx); return; }
      }
      let m;
      if ((m = /^\/api\/projects\/([^/]+)\/media\/([^/]+)\/(audio|file)$/.exec(p))) {
        return serveFile(req, res, path.join(ASSETS, `${m[2]}.wav`));
      }
      if ((m = /^\/api\/projects\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        try { return sendJson(res, 200, await ctx.loadProject(m[1])); } catch { return sendJson(res, 404, { error: 'אין פרויקט' }); }
      }
      if ((m = /^\/result\/([\w.-]+)$/.exec(p)) && req.method === 'POST') {
        const body = await readBody(req);
        await fsp.writeFile(path.join(OUT, `browser-${m[1]}`), body);
        sendJson(res, 200, { ok: true });
        if (onResult) onResult(m[1], body);
        return;
      }
      if (useStubs && /^\/render\/(compositor|sources|text-render)\.js$/.test(p)) {
        return serveFile(req, res, path.join(STUBS, path.basename(p)));
      }
      if (/^\/(render|shared|tools|library\/fonts|app)\//.test(p)) {
        const abs = path.join(ROOT, p);
        if (!abs.startsWith(ROOT)) return sendJson(res, 403, { error: 'אסור' });
        if (!useStubs && /^\/render\/(compositor|sources|text-render)\.js$/.test(p) && !fs.existsSync(abs)) {
          return serveFile(req, res, path.join(STUBS, path.basename(p)));
        }
        return serveFile(req, res, abs);
      }
      sendJson(res, 404, { error: 'לא נמצא' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, ctx, events, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export function findChromeExe() {
  // FRAME_STUDIO_CHROME → Google Chrome → Microsoft Edge (preinstalled on Windows 10/11, Chromium too)
  return [process.env.FRAME_STUDIO_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    .find((f) => f && fs.existsSync(f));
}
