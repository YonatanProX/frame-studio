// Agent L: tiny Chrome DevTools Protocol driver (Node 24 global WebSocket, no deps).
// Usage: node tools/tests/L-cdp.mjs "<url>" <out.png> [width] [height] [timeoutMs]
// Waits until document.title === "DONE", prints #result text + console errors, saves a screenshot.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, outPng, W = '1600', H = '950', TO = '30000'] = process.argv.slice(2);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9300 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-l-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const logs = [];
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) throw new Error('chrome did not start');
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.type; if (t === 'error' || t === 'warning' || t === 'log') logs.push(`[console.${t}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('[log.error] ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const t0 = Date.now();
  let title = '';
  while (Date.now() - t0 < +TO) {
    await sleep(300);
    try { title = (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)).result.value; } catch { /* navigating */ }
    if (title === 'DONE') break;
  }
  await sleep(400);
  const res = await send('Runtime.evaluate', { expression: '(document.getElementById("result")||{}).textContent || ""', returnByValue: true }, sessionId);
  console.log('--- result ---\n' + res.result.value);
  if (title !== 'DONE') console.log('(timeout — title was "' + title + '")');
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (outPng) { fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64')); console.log('screenshot →', outPng); }
  if (logs.length) console.log('--- console ---\n' + logs.slice(0, 60).join('\n'));
} catch (e) {
  console.error('CDP failed:', e.message);
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
  process.exit(0);
}
