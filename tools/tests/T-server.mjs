// Agent T self-test server: serves ROOT statically on 127.0.0.1:7792, launches headless Chrome on a test page,
// receives PNG/JSON results via POST /save?name=…, exits when the page calls POST /done.
// Usage: node tools/tests/T-server.mjs [page=T-sheet.html] [--keep]   (outputs in tools/tests/T-out/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(HERE, 'T-out');
const PORT = 7792;
const page = process.argv.find((a) => a.endsWith('.html')) || 'T-sheet.html';
const keep = process.argv.includes('--keep');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

let chrome = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'POST' && (url.pathname === '/save' || url.pathname === '/done' || url.pathname === '/log')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (url.pathname === '/save') {
        const name = path.basename(url.searchParams.get('name') || 'out.bin');
        fs.writeFileSync(path.join(OUT, name), body);
        console.log('saved', name, body.length);
      } else if (url.pathname === '/log') {
        console.log('[page]', body.toString('utf8'));
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      if (url.pathname === '/done') {
        console.log('done');
        setTimeout(() => { try { chrome && chrome.kill(); } catch { /* */ } server.close(); process.exit(0); }, 300);
      }
    });
    return;
  }
  if (url.pathname === '/api/library/fonts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/tools/tests/' + page;
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('T test server on', PORT, 'page', page);
  if (keep) return;
  const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const profile = path.join(OUT, '.chrome-profile');
  chrome = spawn(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1400,1000', '--hide-scrollbars',
    `http://127.0.0.1:${PORT}/tools/tests/${page}`], { stdio: 'ignore' });
  chrome.on('exit', (code) => console.log('chrome exited', code));
  setTimeout(() => { console.log('timeout'); try { chrome.kill(); } catch { /* */ } process.exit(2); }, 180000);
});
