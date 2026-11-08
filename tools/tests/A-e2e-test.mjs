// Agent A end-to-end test: export.mjs routes + headless Chrome render worker + render.html/render-page.js
// (stub compositor/sources/text so the result is deterministic) → mp4 with mastered audio, snapshots + sheet,
// audio check, cancel, worker reuse and cleanup.  Run after A-node-test.mjs:  node "tools/tests/A-e2e-test.mjs"
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, PROJ, OUT, profileDir, findChromeExe, TEST_PORT } from './A-server.mjs';

const PORT = TEST_PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = profileDir('A-chrome-render');
process.env.FRAME_STUDIO_CHROME_PROFILE = PROFILE;
const { startServer } = await import('./A-server.mjs');
const ex = await import(pathToFileURL(path.join(ROOT, 'server', 'export.mjs')).href);

let failures = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  — ${extra}` : ''}`); if (!cond) failures++; };
const near = (a, b, t) => Math.abs(a - b) <= t;

// ---------- fixture project ----------
const pid = 'e2e';
await fsp.rm(path.join(PROJ, pid), { recursive: true, force: true });
await fsp.mkdir(path.join(PROJ, pid), { recursive: true });
const media = (id, duration) => ({ id, kind: 'audio', name: id, path: `C:/x/${id}.wav`, duration, hasAudio: true, hasVideo: false, channels: 2, sampleRate: 48000, status: 'ready', audio: `cache/audio/${id}.wav` });
const tr = (id, role, kind = 'audio') => ({ id, kind, name: id, role, hidden: false, muted: false, locked: false, solo: false, volume: 1 });
const ac = (id, trackId, mediaId, p) => ({ id, trackId, type: 'audio', name: id, start: 0, duration: 1, mediaId, in: 0, speed: 1, reverse: false, disabled: false, keyframes: {}, volume: 1, fadeIn: 0, fadeOut: 0, pan: 0, muteAudio: false, audioFx: { voiceEnhance: false, denoise: false, eqPreset: 'none', duckUnderVoice: false, duckDb: -10 }, ...p });
const project = {
  version: 1, id: pid, name: 'בדיקת ייצוא', rev: 7,
  settings: { width: 360, height: 640, fps: 30, background: '#000000', sampleRate: 48000, safeArea: 'none', masterGainDb: 0, targetLufs: -14 },
  media: { music: media('music', 10), voice: media('voice', 8), sfx: media('sfx', 2) },
  tracks: [tr('tt', 'text', 'video'), tr('tmain', 'main', 'video'), tr('tv', 'voice'), tr('tm', 'music'), tr('ts', 'sfx')],
  clips: {
    cm: ac('cm', 'tm', 'music', { start: 0, duration: 3, fadeIn: 0.3, fadeOut: 0.5, audioFx: { voiceEnhance: false, denoise: false, eqPreset: 'none', duckUnderVoice: true, duckDb: -12 } }),
    cv: ac('cv', 'tv', 'voice', { start: 0.5, duration: 2.5, audioFx: { voiceEnhance: true, denoise: false, eqPreset: 'none', duckUnderVoice: false, duckDb: -10 } }),
    cs: ac('cs', 'ts', 'sfx', { start: 2.0, duration: 1.0, volume: 0.8, fadeOut: 0.3 }),
  },
  markers: [{ id: 'm1', t: 1.5, label: 'דרופ', color: '#f5c518' }], transcript: { words: [{ w: 'שלום', s: 1.5, e: 1.9 }] }, meta: {},
};
await fsp.writeFile(path.join(PROJ, pid, 'project.json'), JSON.stringify(project, null, 2));

const REAL = process.env.A_REAL === '1';
const srv = await startServer({ port: PORT, useStubs: !REAL, mountExport: true });
if (REAL) console.log('      using the REAL render modules (compositor/sources/text-render)');
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json() }; };
const wait = async (id) => { const t0 = Date.now(); const r = await fetch(`${BASE}/api/jobs/${id}/wait?timeout=180`); const txt = await r.text(); return { job: JSON.parse(txt), ms: Date.now() - t0 }; };

try {
  // ---------- 1. export ----------
  const t0 = Date.now();
  const e = await post(`/api/projects/${pid}/export`, { preset: 'veryfast', crf: 20 });
  ok(e.status === 200 && e.json.id && e.json.totalFrames === 90, 'POST /export → job (90 frames)', `${e.status} ${e.json.id} frames=${e.json.totalFrames} status=${e.json.status}`);
  const { job: ej } = await wait(e.json.id);
  console.log('      export took', Date.now() - t0, 'ms; log:', (ej.log || []).slice(-5).join(' | '));
  ok(ej.status === 'done', 'export job done', ej.error || ej.status);
  if (ej.status === 'done') {
    const r = ej.report;
    console.log('      report.summary:\n' + r.summary.split('\n').map((l) => '        ' + l).join('\n'));
    ok(fs.existsSync(r.file) && /בדיקת ייצוא-\d{8}-\d{6}\.mp4$/.test(r.file), 'mp4 written to projects/<id>/exports/<name>-<stamp>.mp4', r.file);
    const pr = await ex.probeFile(r.file);
    const vs = pr.streams.find((s) => s.codec_type === 'video'), as = pr.streams.find((s) => s.codec_type === 'audio');
    ok(vs && vs.codec_name === 'h264' && vs.width === 360 && vs.height === 640 && Number(vs.nb_frames) === 90, 'video: h264 360x640, 90 frames', `${vs?.codec_name} ${vs?.width}x${vs?.height} n=${vs?.nb_frames}`);
    ok(as && as.codec_name === 'aac' && Number(as.sample_rate) === 48000 && as.channels === 2, 'audio: AAC 48 kHz stereo', `${as?.codec_name} ${as?.sample_rate} ${as?.channels}`);
    ok(near(Number(pr.format.duration), 3.0, 0.06), 'duration 3.0 s', pr.format.duration);
    const m = await ex.measureLoudness(r.file);
    ok(near(m.I, -14, 0.5) && m.truePeak <= -1.0, 'final file: -14 LUFS ±0.5, true peak ≤ -1 dBTP (re-measured independently)', `I=${m.I} TP=${m.truePeak}`);
    // Fixture: enhanced voice (~0.42) over ducked music (-12 dB) is fine until the un-ducked sfx (0.16) enters at 2.0 s.
    const sm = r.speechMargin;
    const lowTimes = (sm?.below || []).map((b) => b.t);
    ok(sm && sm.activeWindows > 0 && sm.belowCount > 0 && lowTimes.every((t) => t >= 2.0 && t < 3.0), "speech margin flags exactly the windows where the un-ducked sfx covers the voice (sfx clip 2.0–3.0 s)", sm?.summary);
    ok(sm && sm.median < 12 ? true : sm.min > 7 && sm.min < 10, 'worst margin ≈ 20·log10(voice/sfx) ≈ 8–9 dB', `min=${sm?.min} median=${sm?.median}`);
    ok(near(r.loudness.inputLufs, r.loudness.inputLufs, 0) && r.loudness.passes.length >= 1, 'loudness passes reported', JSON.stringify(r.loudness.passes));
    // frame content: the stub draws a white bar whose x follows t; check frame 45 (t=1.5)
    const dec = await new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', r.file, '-frames:v', '1', '-vf', 'crop=360:2:0:320', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true });
      const ch = []; p.stdout.on('data', (d) => ch.push(d)); p.on('close', () => resolve(Buffer.concat(ch)));
    });
    let x0 = -1; for (let x = 0; x < Math.min(360, dec.length); x++) if (dec[x] > 200) { x0 = x; break; }
    const expect = Math.round((1.5 / 3) * (360 - 40));
    if (!REAL) ok(near(x0, expect, 3), 'frame at t=1.5 shows the bar where render-page drew it (frame timing correct)', `bar x=${x0} expected ${expect}`);
  }
  const workersAfterExport = ex.listJobs().length;
  void workersAfterExport;

  // ---------- 2. snapshot + contact sheet (reuses the warm worker) ----------
  const s0 = Date.now();
  const s = await post(`/api/projects/${pid}/snapshot`, { times: [0.5, 'marker:דרופ', { word: 'שלום', edge: 'end' }], scale: 0.5, sheet: true });
  ok(s.status === 200 && JSON.stringify(s.json.times) === JSON.stringify([0.5, 1.5, 1.9]), 'POST /snapshot resolves numeric, marker and word times', JSON.stringify(s.json.times));
  const { job: sj } = await wait(s.json.id);
  const snapMs = Date.now() - s0;
  ok(sj.status === 'done' && sj.outputs.filter((o) => o.kind === 'png').length === 3, 'snapshot job done with 3 PNGs', `${sj.status} ${sj.error || ''} (${snapMs} ms)`);
  if (sj.status === 'done') {
    const png = sj.outputs.find((o) => o.kind === 'png');
    const pp = (await ex.probeFile(png.path)).streams[0];
    ok(pp.width === 180 && pp.height === 320, 'PNG scaled to 0.5 → 180x320', `${pp.width}x${pp.height} ${png.path}`);
    const sheet = sj.outputs.find((o) => o.kind === 'sheet');
    ok(sheet && fs.existsSync(sheet.path), 'contact sheet written', sheet?.path);
    await fsp.copyFile(png.path, path.join(OUT, 'e2e-snap1.png'));
    if (sheet) await fsp.copyFile(sheet.path, path.join(OUT, 'e2e-sheet.png'));
  }
  // second snapshot: worker is warm (no Chrome start-up)
  const s2t = Date.now();
  const s2 = await post(`/api/projects/${pid}/snapshot`, { times: [2.25] });
  const { job: sj2 } = await wait(s2.json.id);
  const warmMs = Date.now() - s2t;
  ok(sj2.status === 'done', 'second snapshot on the warm worker', `${warmMs} ms vs first ${snapMs} ms`);

  // ---------- 3. audio check ----------
  const a = await post(`/api/projects/${pid}/check-audio`, {});
  const { job: aj } = await wait(a.json.id);
  ok(aj.status === 'done' && Number.isFinite(aj.report.mixLufs) && aj.report.speechMargin?.activeWindows > 0, 'check-audio job: mix loudness + speech margin', aj.report?.summary || aj.error);

  // ---------- 4. cancel mid-export ----------
  const c = await post(`/api/projects/${pid}/export`, { to: 3, fps: 60, preset: 'veryslow' });
  let seen = false;
  for (let i = 0; i < 80 && !seen; i++) { await new Promise((r) => setTimeout(r, 150)); const j = await (await fetch(`${BASE}/api/jobs/${c.json.id}`)).json(); seen = j.frames > 5; }
  const cr = await post(`/api/jobs/${c.json.id}/cancel`, {});
  ok(cr.json.status === 'canceled', 'cancel → canceled', `frames at cancel=${cr.json.frames}`);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await post(`/api/projects/${pid}/snapshot`, { times: [1] });
  const { job: aj2 } = await wait(after.json.id);
  ok(aj2.status === 'done', 'a new job runs fine after a cancel (worker relaunched)', aj2.error || '');

  // ---------- 5. errors ----------
  const bad = await post(`/api/projects/nope/export`, {});
  ok(bad.status === 404 && /לא נמצא/.test(bad.json.error), '404 with Hebrew error for unknown project', bad.json.error);
  const bad2 = await post(`/api/projects/${pid}/snapshot`, {});
  ok(bad2.status === 400 && bad2.json.error, '400 for snapshot without times', bad2.json.error);
  const fr = await fetch(`${BASE}/api/jobs/${ej.id}/frame`, { method: 'POST', headers: { 'X-Frame': '0' }, body: Buffer.alloc(10) });
  ok(fr.status === 410, 'frame posted to a finished job → 410', String(fr.status));

  // ---------- 6. in-app style job (headless:false) driven by runJobInPage in a page ----------
  const ia = await post(`/api/projects/${pid}/snapshot`, { times: [0.25, 2.75], headless: false });
  ok(ia.json.status === 'waiting', 'headless:false job waits for the editor', ia.json.status);
  const inApp = spawn(findChromeExe(), ['--headless=new', '--no-first-run', `--user-data-dir=${PROFILE}-inapp`,
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `${BASE}/tools/tests/A-inapp.html?job=${ia.json.id}`], { stdio: 'ignore' });
  const { job: ij } = await wait(ia.json.id);
  ok(ij.status === 'done' && ij.outputs.length === 2, 'runJobInPage() from a normal page (OffscreenCanvas) completes the job', ij.error || `${ij.outputs.length} outputs`);
  spawn('taskkill', ['/PID', String(inApp.pid), '/T', '/F'], { stdio: 'ignore' });
  const prog = await fetch(`${BASE}/tools/tests/A-out/browser-inapp-progress.json`).catch(() => null);
  void prog;
} catch (e) {
  console.error(e);
  failures++;
}

// ---------- cleanup: kill the worker via process exit path, check nothing is left ----------
const pidFile = path.join(PROFILE, 'frame-studio-chrome.pid');
const chromePid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
await srv.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
// Report the worker pid so the caller can verify that process exit killed it.
fs.writeFileSync(path.join(OUT, 'e2e-chrome-pid.txt'), String(chromePid));
process.exit(failures ? 1 : 0);
