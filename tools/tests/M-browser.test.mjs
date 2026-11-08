// Frame Studio — runs shared/model.js, anim.js, ops.js, catalog.js inside headless Chrome (agent M).
// Tiny static server on port 7713 serves the project root; Chrome loads tools/tests/M-browser.html and we read the DOM.
// Run: node "tools/tests/M-browser.test.mjs"

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.FS_TEST_PORT) || 7713; // FS_TEST_PORT: run beside another test / server
// FRAME_STUDIO_CHROME → Google Chrome → Microsoft Edge
const CHROME = [process.env.FRAME_STUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((f) => f && fs.existsSync(f));
if (!CHROME) { console.error('Chrome / Edge not found (set FRAME_STUDIO_CHROME)'); process.exit(1); }
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm-chrome-'));
const url = `http://127.0.0.1:${PORT}/tools/tests/M-browser.html`;
const dom = await new Promise((resolve) => {
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--virtual-time-budget=15000', '--dump-dom', url], { windowsHide: true });
  let so = '';
  const timer = setTimeout(() => child.kill(), 60000);
  child.stdout.on('data', (d) => { so += d; });
  child.on('close', () => { clearTimeout(timer); resolve(so); });
});
server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }

const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
const text = m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : dom.slice(0, 2000);
console.log(text);
const ok = /DONE/.test(text) && !/FAIL/.test(text) && /PASS/.test(text);
console.log(ok ? '\n✓ המודולים המשותפים עובדים בדפדפן' : '\n✗ כשל בדפדפן');
process.exitCode = ok ? 0 : 1;
