// tools/tests/R-server.mjs — tiny static server for agent R's headless render tests (port 7791).
// Serves ROOT files, fakes /api/projects/:id/media/:mediaId/{proxy,file} from tools/tests/R-assets,
// /library/luts/* (ROOT first, then R-assets/luts), and collects results posted by the test page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const ASSETS = path.join(HERE, 'R-assets');
export const OUT = path.join(HERE, 'R-out');

const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.cube': 'text/plain; charset=utf-8',
};

function serveFile(req, res, abs) {
  let st;
  try { st = fs.statSync(abs); } catch { res.writeHead(404); res.end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (m && !m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(abs).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeJoin(base, rel) {
  const abs = path.resolve(base, '.' + path.sep + rel);
  if (!abs.startsWith(path.resolve(base))) return null;
  return abs;
}

/** start({port, onDone, onLog}) → Promise<http.Server> */
export function startServer({ port = 7791, onDone = () => {}, onLog = () => {} } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8')); } catch { /* none yet */ }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = decodeURIComponent(url.pathname);
      if (req.method === 'POST' && p === '/__save') {
        const name = path.basename(url.searchParams.get('name') || 'out.bin');
        fs.writeFileSync(path.join(OUT, name), await readBody(req));
        res.writeHead(200); res.end('ok'); return;
      }
      if (req.method === 'POST' && p === '/__log') {
        onLog((await readBody(req)).toString('utf8'));
        res.writeHead(200); res.end('ok'); return;
      }
      if (req.method === 'POST' && p === '/__done') {
        const body = (await readBody(req)).toString('utf8');
        fs.writeFileSync(path.join(OUT, 'R-results.json'), body);
        res.writeHead(200); res.end('ok');
        onDone(body);
        return;
      }
      const mm = /^\/api\/projects\/([^/]+)\/media\/([^/]+)\/(proxy|file)$/.exec(p);
      if (mm) {
        const f = manifest[mm[2]];
        if (!f) { res.writeHead(404); res.end('no media'); return; }
        serveFile(req, res, path.join(ASSETS, f)); return;
      }
      if (p.startsWith('/library/luts/')) {
        const name = p.slice('/library/luts/'.length);
        const a = safeJoin(path.join(ROOT, 'library', 'luts'), name);
        if (a && fs.existsSync(a)) { serveFile(req, res, a); return; }
        const b = safeJoin(path.join(ASSETS, 'luts'), name);
        if (b) { serveFile(req, res, b); return; }
      }
      if (/^\/(render|shared|library|tools|app)\//.test(p)) {
        const abs = safeJoin(ROOT, p.slice(1));
        if (abs) { serveFile(req, res, abs); return; }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
