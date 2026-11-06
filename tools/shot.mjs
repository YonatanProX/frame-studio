// Frame Studio — tools/shot.mjs
// Screenshot the editor (or any URL) in headless Chrome over the DevTools protocol, collect console errors,
// optionally run JS steps first. Used for QA and for README screenshots.
//
//   node tools/shot.mjs <url> <out.png> [--wait 4000] [--size 1600x950] [--eval "js"] [--eval-file steps.js] [--gpu]
//
// Prints a JSON line: { ok, out, errors:[…], evalResult }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome, angleBackend } from '../server/config.mjs';

const args = process.argv.slice(2);
const url = args[0];
const out = path.resolve(args[1] || 'shot.png');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const wait = Number(opt('--wait', 4000));
const [W, H] = String(opt('--size', '1600x950')).split('x').map(Number);
let evalJs = opt('--eval', '');
const evalFile = opt('--eval-file', '');
if (evalFile) evalJs = fs.readFileSync(evalFile, 'utf8');
const gpu = args.includes('--gpu');
if (!url) { console.error('usage: node tools/shot.mjs <url> <out.png> [--wait ms] [--size WxH] [--eval js]'); process.exit(1); }

const CHROME = findChrome();   // env FRAME_STUDIO_CHROME → config.json "chrome" → auto-detect
if (!CHROME) { console.log(JSON.stringify({ ok: false, error: 'Google Chrome not found (set "chrome" in config.json)' })); process.exit(1); }
const port = 9300 + Math.floor(Math.random() * 500);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-shot-'));
const flags = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`, '--hide-scrollbars'];
flags.push(...(gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${angleBackend()}`] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']));
const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws; let seq = 0; const pending = new Map(); const errors = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
async function main() {
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* starting */ }
    if (!ws) await sleep(150);
  }
  if (!ws) throw new Error('Chrome DevTools לא זמין');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push('log: ' + msg.params.entry.text + (msg.params.entry.url ? ' ' + msg.params.entry.url : ''));
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(wait);
  let evalResult;
  if (evalJs) {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${evalJs} })()`, awaitPromise: true, returnByValue: true });
    evalResult = r.exceptionDetails ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text } : r.result?.value;
    await sleep(Number(opt('--after', 1200)));
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ ok: true, out, errors, evalResult }));
}
main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e?.message || e), errors })); process.exitCode = 1; })
  .finally(async () => { try { chrome.kill(); } catch { /* gone */ } await sleep(400); try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* locked */ } });
