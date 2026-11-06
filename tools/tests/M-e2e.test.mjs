// Frame Studio — end-to-end CLI test against the REAL server (agent M).
// Starts server/main.mjs on port 7713, drives it with cli/cutx.mjs, then deletes the test project.
// Run: node "tools/tests/M-e2e.test.mjs" [--render]   (--render also runs snapshot + a 1-second export through headless Chrome)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'cli', 'cutx.mjs');
const TMP = path.join(HERE, 'M-e2e-tmp');
const PORT = 7713;
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'm-e2e-test';
const RENDER = process.argv.includes('--render');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'main.mjs')], {
  cwd: ROOT, env: { ...process.env, FRAME_STUDIO_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function health() { try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1000) }); return r.ok ? r.json() : null; } catch { return null; } }
for (let i = 0; i < 50 && !(await health()); i++) await new Promise((r) => setTimeout(r, 200));

function run(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CUTX_URL: BASE }, cwd: ROOT });
    let so = '', se = '';
    const timer = setTimeout(() => { child.kill(); se += '\n[timeout]'; }, timeoutMs);
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: so, err: se }); });
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const results = [];

const vid = path.join(TMP, 'שוט בדיקה.mp4');
const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', vid], { encoding: 'utf8' });

test('server is up (real main.mjs)', async () => {
  const h = await health();
  assert.ok(h && h.ok, `server not healthy:\n${serverLog.slice(-2000)}`);
  assert.equal(ff.status, 0, ff.stderr);
});

test('new project + import + add video by path + text', async () => {
  await fetch(`${BASE}/api/projects/${PID}`, { method: 'DELETE' }).catch(() => {});
  let r = await run(['new', PID, '--name', 'בדיקת M', '--size', '9:16']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['add', PID, 'video', vid, '--at', '0', '--id', 'v1']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['add', PID, 'text', 'רגע!', '--at', '0.2', '--dur', '1.2', '--set', 'transform.y=-500', '--set', 'text.size=150', '--id', 'hook']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['show', PID, '--json']);
  const P = JSON.parse(r.out);
  assert.equal(P.clips.v1.type, 'video'); assert.ok(P.clips.v1.duration > 3.5, `duration from probe: ${P.clips.v1.duration}`);
  assert.equal(P.clips.hook.text.size, 150);
});

test('transcript + captions (chordix) + sfx from the real library + marker + keyframes + split + transition', async () => {
  const asr = path.join(TMP, 'asr.json');
  fs.writeFileSync(asr, JSON.stringify([['רֶגַע!', 0.2, 0.6], ['יש', 0.9, 1.05], ['לכם', 1.1, 1.4], ['שיר,', 1.45, 1.8], ['ובום!', 2.4, 2.9], ['סולם!', 3.2, 3.6]]));
  let r = await run(['transcript', PID, asr]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['captions', PID, '--style', 'chordix', '--hot', 'ובום', '--yabs', '330', '--hook0']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['sounds', 'whoosh', '--limit', '5']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(/whoosh/i.test(r.out), r.out);
  r = await run(['sfx', PID, 'Air zoom vacuum', '--at', 'word:סולם!:0:-0.1', '--gain', '-14', '--len', '0.6', '--fade', '0.1']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['sfx', PID, 'Booms_Vol2_011', '--at', 'word:ובום!:0:-0.13', '--gain', '-8', '--len', '1.5']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['marker', PID, 'word:ובום!', 'דרופ']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['key', PID, 'v1', 'transform.scale', 'word:סולם!', '1.6', '--ease', 'spring']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['split', PID, 'v1', '2.4', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['transition', PID, 'v1', 'zoomBlur', '--dur', '0.3']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['show', PID]);
  assert.equal(r.code, 0, r.err);
  for (const s of ['כתוביות', 'מעבר→ zoomBlur', 'דרופ', 'Air zoom']) assert.ok(r.out.includes(s), `show missing ${s}:\n${r.out}`);
  r = await run(['validate', PID]);
  results.push(['validate', r.out.trim()]);
});

test('undo / redo through the server history', async () => {
  let r = await run(['marker', PID, '3.9', 'זמני']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['undo', PID]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['show', PID, '--json']);
  assert.ok(!JSON.parse(r.out).markers.some((m) => m.label === 'זמני'));
  r = await run(['redo', PID]);
  assert.equal(r.code, 0, r.err + r.out);
});

if (RENDER) {
  test('snapshot through headless Chrome (PNG files exist)', async () => {
    const r = await run(['snapshot', PID, '--at', '0.5,word:ובום!', '--scale', '0.25'], 240000);
    results.push(['snapshot', (r.out + r.err).trim()]);
    assert.equal(r.code, 0, r.err + r.out);
    const files = r.out.split('\n').filter((l) => /\.png$/i.test(l.trim()));
    assert.ok(files.length >= 2 && files.every((f) => fs.existsSync(f.trim())), r.out);
  });
  test('export 1 s with report (LUFS + speech margin)', async () => {
    const r = await run(['export', PID, '--from', '0', '--to', '1', '--out', path.join(TMP, 'e2e.mp4')], 300000);
    results.push(['export', (r.out + r.err).trim()]);
    assert.ok([0, 2].includes(r.code), r.err + r.out);
    assert.ok(fs.existsSync(path.join(TMP, 'e2e.mp4')), r.out);
  });
}

let pass = 0, failN = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`✓ ${t.name}`); }
  catch (e) { failN++; console.log(`✗ ${t.name}\n   ${(e && e.stack ? e.stack : e).toString().split('\n').slice(0, 8).join('\n   ')}`); }
}
for (const [k, v] of results) console.log(`\n--- ${k} ---\n${v}`);
const KEEP = process.argv.includes('--keep');
if (KEEP) { server.kill(); console.log(`
(--keep: הפרויקט ${PID} והקבצים נשמרו)`); process.exit(failN ? 1 : 0); }
// cleanup: delete the test project (moved to .trash) and remove it from the trash too
try { await fetch(`${BASE}/api/projects/${PID}`, { method: 'DELETE' }); } catch { /* ignore */ }
server.kill();
await new Promise((r) => setTimeout(r, 400));
for (const dir of [path.join(ROOT, 'projects', PID), path.join(ROOT, 'projects', '.trash')]) {
  if (!fs.existsSync(dir)) continue;
  if (dir.endsWith('.trash')) { for (const d of fs.readdirSync(dir)) if (d.startsWith(PID)) fs.rmSync(path.join(dir, d), { recursive: true, force: true }); }
  else fs.rmSync(dir, { recursive: true, force: true });
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${tests.length} בדיקות קצה-לקצה עברו${failN ? `, ${failN} נכשלו` : ''}`);
process.exitCode = failN ? 1 : 0;
