// Regression test: the app is closed while a sound folder is being indexed for the first time.
// After a restart every sound must still end up in the library (the half-written index must not be
// trusted as complete).
//   node tools/tests/S-test-library-resume.mjs [--port 7821] [--root <frame-studio folder>] [--files 100] [--keep]
// Needs ffmpeg on PATH. Uses only temp folders (config, data, cache, sounds) — never the real config.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', path.join(HERE, '..', '..')));
const PORT = Number(arg('--port', 7821));
const N = Math.max(70, Number(arg('--files', 100)));
const KEEP = argv.includes('--keep');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = path.join(os.tmpdir(), 'fs-wf', 'core-fixer', `lib-resume-${process.pid}-${Date.now()}`);
const SOUNDS = path.join(TMP, 'צלילים בדיקה');   // Hebrew + space on purpose
const DATA = path.join(TMP, 'data');
const CACHE = path.join(TMP, 'cache');
const CONFIG = path.join(TMP, 'config.json');
const INDEX = path.join(CACHE, 'sounds', 'index.json');

let pass = 0, fail = 0;
const check = (ok, name, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`); };

/** A 16-bit PCM WAV with a sine tone (long enough that decoding 100 of them takes a few seconds). */
function wav(freq, seconds = 6, rate = 44100) {
  const n = Math.round(seconds * rate), ch = 2;
  const buf = Buffer.alloc(44 + n * 2 * ch);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2 * ch, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2 * ch, 28); buf.writeUInt16LE(2 * ch, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2 * ch, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * (1 - i / n));
    for (let c = 0; c < ch; c++) buf.writeInt16LE(v, 44 + (i * ch + c) * 2);
  }
  return buf;
}

function startServer(tag) {
  const env = {
    ...process.env,
    FRAME_STUDIO_CONFIG: CONFIG, FRAME_STUDIO_DATA: DATA, FRAME_STUDIO_CACHE: CACHE,
    FRAME_STUDIO_NO_STARTER: '1', FRAME_STUDIO_CLAUDE_CONFIG: 'none', FRAME_STUDIO_CLAUDE_HOME: path.join(TMP, 'claude-home'),
  };
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'main.mjs'), '--port', String(PORT)], { cwd: ROOT, env, windowsHide: true });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  p.exited = new Promise((r) => p.on('exit', r));
  p.tag = tag;
  return p;
}
async function waitUp(p) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${BASE}/api/library/sounds/status`); if (r.ok) return; } catch { /* not yet */ }
    if (p.exitCode != null) throw new Error(`server (${p.tag}) exited:\n${p.log}`);
    await sleep(100);
  }
  throw new Error(`server (${p.tag}) did not start on ${PORT}:\n${p.log}`);
}
const status = async () => (await fetch(`${BASE}/api/library/sounds/status`)).json();
async function stop(p) {
  try { await fetch(`${BASE}/api/shutdown`, { method: 'POST' }); } catch { /* already gone */ }
  await Promise.race([p.exited, sleep(5000)]);
  if (p.exitCode == null) p.kill();
  await p.exited;
}
const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return null; } };

let srv = null;
try {
  await fsp.mkdir(SOUNDS, { recursive: true });
  await fsp.mkdir(DATA, { recursive: true });
  await fsp.writeFile(CONFIG, '{}\n');
  for (let i = 0; i < N; i++) await fsp.writeFile(path.join(SOUNDS, `tone ${String(i).padStart(3, '0')}.wav`), wav(220 + i * 7));
  console.log(`root ${ROOT}\n${N} test sounds in ${SOUNDS}`);

  // ── run 1: add the folder, close the app as soon as a partial index has been saved ──
  srv = startServer('run 1');
  await waitUp(srv);
  // sounds that are already in the library (the built-in folder), so the test works with or without them
  let base = null;
  for (let i = 0; i < 600; i++) { const b = await status(); if (b.ready && !b.indexing) { base = b.count; break; } await sleep(100); }
  if (base == null) throw new Error('the built-in library never finished indexing');
  await sleep(300);
  const T = base + N;
  console.log(`${base} built-in sound(s) already indexed → expecting ${T} in total`);
  const add = await fetch(`${BASE}/api/library/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: SOUNDS }) });
  check(add.ok, 'sound folder added', String(add.status));
  let partial = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const j = readIndex();
    if (j && j.count > base && j.count < T) { partial = j; break; }
    if (j && j.count >= T) break;
    await sleep(5);
  }
  const s1 = await status().catch(() => null);
  await stop(srv); srv = null;
  check(!!partial, 'a partial index was saved mid-build (the app closed during indexing)',
    partial ? `saved ${partial.count} of ${T}, status done=${s1 && s1.done}` : 'build finished before a partial save — use more --files');
  if (partial) {
    check(partial.signature == null || partial.partial === true, 'the mid-build save is not marked as a complete index',
      `signature=${partial.signature == null ? 'null' : 'set'} partial=${partial.partial}`);
  }

  // ── run 2: restart — every sound must come back ──
  srv = startServer('run 2');
  await waitUp(srv);
  let s = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    s = await status();
    if (!s.indexing && s.count >= T) break;
    if (!s.indexing && Date.now() - t1 > 8000) break;   // settled below N → the bug
    await sleep(250);
  }
  check(s && s.count === T, 'after the restart all sounds are in the library', s ? `count=${s.count} done=${s.done} total=${s.total} indexing=${s.indexing}` : 'no status');
  const resumed = /indexing (\d+) file/.exec(srv.log);
  check(!!resumed && Number(resumed[1]) < N, 'the restart decodes only the missing files', resumed ? `${resumed[1]} decoded again` : srv.log.split('\n').filter((l) => l.includes('[library]')).join(' | '));
  await stop(srv); srv = null;
  const fin = readIndex();
  check(fin && fin.count === T && fin.signature && !fin.partial, 'the final index is complete and signed', fin ? `count=${fin.count}` : 'no index');

  // ── run 3: a clean restart uses the cache (no decoding) ──
  srv = startServer('run 3');
  await waitUp(srv);
  await sleep(800);
  const s3 = await status();
  check(s3.count === T && !s3.indexing && /index loaded from cache/.test(srv.log), 'third start loads the complete index from cache', `count=${s3.count}`);
  await stop(srv); srv = null;
} catch (e) {
  fail++; console.log('FAIL  ' + (e && e.stack || e));
} finally {
  if (srv) await stop(srv).catch(() => {});
  if (!KEEP) await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n${fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} checks passed`}`);
process.exitCode = fail ? 1 : 0;
