// Agent S self-test: exercises the server end to end on http://127.0.0.1:7788 (server must be running).
//   node tools/tests/S-test.mjs [--no-asr] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:7788';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// the Chordix import part needs config.json "chordix.workshop" (or env FRAME_STUDIO_TEST_WORKSHOP)
const { chordixConfig } = await import('../../server/config.mjs');
const WORKSHOP = process.env.FRAME_STUDIO_TEST_WORKSHOP || chordixConfig().workshop || path.join(ROOT, 'missing-chordix-workshop');
const WS = path.join(WORKSHOP, 'projects', '05-בלדה-עממית').split(path.sep).join('/');
const VIDEO = `${WS}/render/video.mp4`;
const SFX = `${ROOT}/library/sounds/נבחרים לסושיאל/מיקסקיט/ווש/Air zoom vacuum.wav`;
const noAsr = process.argv.includes('--no-asr');
const keep = process.argv.includes('--keep');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };
const j = async (method, p, body, headers = {}) => {
  const r = await fetch(BASE + p, { method, headers: body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json', ...headers } : headers, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: r.status, data, headers: r.headers };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- SSE collector
const events = [];
async function sse(project) {
  const r = await fetch(`${BASE}/api/events?project=${project}`);
  const rd = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    for (;;) {
      const { value, done } = await rd.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
      }
    }
  })();
  return () => rd.cancel().catch(() => {});
}
async function waitFor(pred, ms = 120000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const e = events.find(pred); if (e) return e; await sleep(200); }
  throw new Error('timeout waiting for ' + label);
}

console.log('— health / static');
let r = await j('GET', '/api/health');
ok(r.status === 200 && r.data.ok && r.data.port === 7788, 'health', r.data);
r = await fetch(BASE + '/shared/model.js');
ok(r.status === 200 && /text\/javascript/.test(r.headers.get('content-type')), 'static js MIME', r.headers.get('content-type'));
r = await fetch(BASE + '/library/fonts/heebo-hebrew.woff2');
ok(r.status === 200 && r.headers.get('content-type') === 'font/woff2', 'font MIME');
r = await fetch(BASE + '/');
ok(r.status === 200 && /text\/html/.test(r.headers.get('content-type')), 'index');
r = await fetch(BASE + '/app/..%2f..%2fpackage.json');
ok(r.status === 403 || r.status === 404, 'path traversal blocked', r.status);
r = await fetch(BASE + '/api/projects', { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
ok(r.status === 403, 'foreign origin write blocked', r.status);

console.log('— project create');
{ const d = (await j('DELETE', '/api/projects/s-test')).data; if (d && d.trash) fs.rmSync(d.trash, { recursive: true, force: true }); }
r = await j('POST', '/api/projects', { id: 's-test', name: 'בדיקת שרת', width: 1080, height: 1920, fps: 30 });
ok(r.status === 201 && r.data.id === 's-test' && r.data.tracks.length === 6 && r.data.rev === 0, 'create project', r.data);
r = await j('POST', '/api/projects', { id: 's-test', name: 'כפול' });
ok(r.status === 409, 'duplicate id 409', r.data);
r = await j('GET', '/api/projects');
ok(Array.isArray(r.data) && r.data.some((p) => p.id === 's-test'), 'list projects');
const stop = await sse('s-test');
await waitFor((e) => e.type === 'hello', 5000, 'hello');
ok(true, 'SSE hello');

console.log('— import video');
r = await j('POST', '/api/projects/s-test/import', { paths: [VIDEO, 'C:/nope/missing.mp4'] });
ok(r.status === 200 && r.data.media.length === 1 && r.data.media[0].status === 'processing' && r.data.errors.length === 1, 'import returns processing + error for missing', r.data);
const vid = r.data.media[0];
ok(vid.kind === 'video' && vid.width === 1080 && vid.height === 1920 && vid.duration > 20 && vid.hasAudio, 'probe fields', vid);
const ready = await waitFor((e) => e.type === 'media' && e.media.id === vid.id && e.media.status !== 'processing', 180000, 'media ready');
ok(ready.media.status === 'ready' && ready.media.proxy && ready.media.audio && ready.media.peaks && ready.media.thumbs, 'media ready event with derivatives', ready.media);
ok(events.some((e) => e.type === 'job' && e.job.mediaId === vid.id && e.job.progress > 0 && e.job.progress < 1), 'job progress events');
const pdir = `${ROOT}/projects/s-test`;
const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt', '-of', 'json', `${pdir}/${ready.media.proxy}`], { encoding: 'utf8' });
const ps = JSON.parse(pr.stdout).streams[0];
ok(ps.codec_name === 'h264' && ps.width === 1080 && ps.height === 1920 && ps.pix_fmt === 'yuv420p', 'proxy h264 1080x1920 yuv420p', ps);
const kf = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', `${pdir}/${ready.media.proxy}`], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).map((l) => parseFloat(l)).filter((x) => Number.isFinite(x));
const gap = Math.max(...kf.slice(1).map((t, i) => t - kf[i]));
ok(kf.length > 50 && gap <= 0.34, `proxy keyframes every ≤10 frames (n=${kf.length}, max gap ${gap.toFixed(3)} s)`);
const peaks = JSON.parse(fs.readFileSync(`${pdir}/${ready.media.peaks}`, 'utf8'));
ok(peaks.rate === 100 && Math.abs(peaks.peaks.length - vid.duration * 100) < 10 && Math.max(...peaks.peaks) <= 1 && Math.max(...peaks.peaks) > 0.05, `peaks (${peaks.peaks.length})`);
const thumbs = fs.readdirSync(`${pdir}/${ready.media.thumbs}`);
ok(thumbs.length >= 20 && thumbs.length <= 22, `thumbs (${thumbs.length})`);
const wav = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'json', `${pdir}/${ready.media.audio}`], { encoding: 'utf8' });
const ws = JSON.parse(wav.stdout).streams[0];
ok(ws.codec_name === 'pcm_s16le' && ws.sample_rate === '48000' && ws.channels === 2, 'audio wav 48k stereo', ws);

console.log('— media routes / Range');
let rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/proxy`, { headers: { Range: 'bytes=0-99' } });
ok(rr.status === 206 && rr.headers.get('content-length') === '100' && /^bytes 0-99\//.test(rr.headers.get('content-range')) && (await rr.arrayBuffer()).byteLength === 100, 'Range 0-99 → 206');
rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/file`, { headers: { Range: 'bytes=-500' } });
ok(rr.status === 206 && rr.headers.get('content-length') === '500', 'suffix Range → 206');
rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/file`, { headers: { Range: 'bytes=999999999-' } });
ok(rr.status === 416, 'unsatisfiable Range → 416');
rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/proxy`, { method: 'HEAD' });
ok(rr.status === 200 && rr.headers.get('accept-ranges') === 'bytes' && rr.headers.get('content-type') === 'video/mp4', 'HEAD proxy');
rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/thumb?t=3.4`);
ok(rr.status === 200 && rr.headers.get('content-type') === 'image/jpeg', 'thumb?t=3.4');
rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/peaks`);
ok(rr.status === 200 && (await rr.json()).rate === 100, 'peaks route');
rr = await fetch(`${BASE}/api/projects/s-test/media/${vid.id}/audio`, { headers: { Range: 'bytes=44-1043' } });
ok(rr.status === 206 && rr.headers.get('content-type') === 'audio/wav', 'audio Range');

console.log('— ops / undo / redo');
const revBefore = (await j('GET', '/api/projects/s-test')).data.rev;
r = await j('POST', '/api/projects/s-test/ops', { by: 'claude', summary: 'בדיקה: וידאו + אפקט', ops: [
  { op: 'addClip', type: 'video', track: 't_main', start: 0, mediaId: vid.id, id: 'c_vid', muteAudio: true },
  { op: 'addClip', type: 'audio', role: 'sfx', start: 1, path: SFX, id: 'c_sfx1' },
  { op: 'sfx', sound: 'whoosh', at: 3, id: 'c_sfx2' },
  { op: 'addClip', type: 'audio', role: 'sfx', start: 1, path: 'C:/nope/missing.wav' },
] });
ok(r.status === 200 && r.data.rev === revBefore + 1 && r.data.results[0].ok && r.data.results[1].ok && r.data.results[2].ok, 'ops batch ok (path import + sfx resolve)', r.data.results);
ok(r.data.results[3].ok === false && /לא נמצא/.test(r.data.results[3].error), 'missing path → Hebrew error result', r.data.results[3]);
const proj = r.data.project;
const sfxMedia = Object.values(proj.media).filter((m) => m.kind === 'audio');
ok(sfxMedia.length === 2 && sfxMedia.some((m) => m.library && m.library.soundId), 'imported sfx media (+library soundId)', sfxMedia.map((m) => [m.name, m.library]));
ok(proj.clips.c_vid && proj.clips.c_sfx1 && proj.clips.c_sfx1.mediaId, 'clips created');
const pev = await waitFor((e, i) => e.type === 'project' && e.rev === revBefore + 1, 5000, 'project event');
ok(pev.by === 'claude' && pev.summary === 'בדיקה: וידאו + אפקט' && pev.project && pev.history.undo === 1, 'SSE project event', { by: pev.by, s: pev.summary, h: pev.history });
r = await j('POST', '/api/projects/s-test/ops', { ops: [{ op: 'updateClip', id: 'c_vid', set: { 'transform.scale': 1.5, name: 'וידאו' } }] });
ok(r.data.rev >= revBefore + 2 && r.data.project.clips.c_vid.transform.scale === 1.5, 'updateClip');
const revAfterUpdate = r.data.rev;
r = await j('POST', '/api/projects/s-test/ops', { ops: [{ op: 'updateClip', id: 'nope', set: { name: 'x' } }] });
ok(r.data.rev === revAfterUpdate && r.data.results[0].ok === false, 'no-op batch does not bump rev', r.data.rev);
r = await j('POST', '/api/projects/s-test/undo', {});
ok(r.status === 200 && r.data.project.clips.c_vid.transform.scale === 1 && r.data.rev > revAfterUpdate, 'undo restores previous state', r.data.project && r.data.project.clips.c_vid.transform);
r = await j('POST', '/api/projects/s-test/undo', {});
ok(r.status === 200 && !r.data.project.clips.c_vid && Object.keys(r.data.project.media).length === 3 && r.data.project.media[vid.id].status === 'ready', 'second undo removes clips but keeps media bin (ready)');
r = await j('POST', '/api/projects/s-test/undo', {});
ok(r.status === 409 && /אין/.test(r.data.error), 'undo on empty stack → 409', r.data);
r = await j('POST', '/api/projects/s-test/redo', {});
ok(r.status === 200 && r.data.project.clips.c_vid && r.data.project.clips.c_vid.transform.scale === 1, 'redo 1');
r = await j('POST', '/api/projects/s-test/redo', {});
ok(r.status === 200 && r.data.project.clips.c_vid.transform.scale === 1.5 && r.data.history.redo === 0, 'redo 2');
r = await j('GET', '/api/projects/s-test/history');
ok(r.data.undo.length === 2 && r.data.redo.length === 0, 'history endpoint', r.data);
// history cap
const many = []; for (let i = 0; i < 310; i++) many.push(j('POST', '/api/projects/s-test/ops', { ops: [{ op: 'updateClip', id: 'c_vid', set: { 'transform.x': i + 1 } }] }));
await Promise.all(many);
r = await j('GET', '/api/projects/s-test/history');
ok(r.data.undo.length === 300, `history capped at 300 (${r.data.undo.length})`);
r = await j('GET', '/api/projects/s-test');
ok(r.data.clips.c_vid.transform.x === 310, 'serialized concurrent batches applied in order', r.data.clips.c_vid.transform.x);
const onDisk = JSON.parse(fs.readFileSync(`${pdir}/project.json`, 'utf8'));
ok(onDisk.rev === r.data.rev && onDisk.clips.c_vid.transform.x === 310, 'atomic save on disk matches');
ok(!fs.readdirSync(pdir).some((f) => f.endsWith('.tmp')), 'no tmp files left');
r = await j('PATCH', '/api/projects/s-test', { name: 'בדיקת שרת 2' });
ok(r.status === 200 && r.data.name === 'בדיקת שרת 2', 'rename project');

console.log('— upload');
const tmpWav = `${ROOT}/tools/tests/S-upload.wav`;
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-ar', '44100', tmpWav]);
const body = new Uint8Array(fs.readFileSync(tmpWav));
r = await j('POST', `/api/projects/s-test/upload?name=${encodeURIComponent('צליל בדיקה.wav')}`, body, { 'Content-Type': 'application/octet-stream' });
ok(r.status === 200 && r.data.media[0].kind === 'audio' && r.data.media[0].name === 'צליל בדיקה.wav' && Math.abs(r.data.media[0].duration - 1.5) < 0.05, 'upload → media', r.data);
const up = r.data.media[0];
await waitFor((e) => e.type === 'media' && e.media.id === up.id && e.media.status === 'ready', 60000, 'upload ready');
ok(fs.existsSync(`${pdir}/media/צליל בדיקה.wav`), 'upload saved in project media/');
fs.rmSync(tmpWav, { force: true });
r = await j('DELETE', `/api/projects/s-test/media/${up.id}`);
ok(r.status === 200 && !r.data.project.media[up.id], 'remove unused media from bin');
r = await j('POST', '/api/projects/s-test/undo', {});
ok(r.status === 200 && r.data.project.media[up.id] && r.data.project.media[up.id].status === 'ready', 'undo brings media back');
r = await j('POST', '/api/projects/s-test/redo', {});
ok(r.status === 200 && !r.data.project.media[up.id], 'redo removes media again');
r = await j('DELETE', `/api/projects/s-test/media/${vid.id}`);
ok(r.status === 409, 'cannot remove media used by clips', r.data);

console.log('— open (dry)');
r = await j('POST', '/api/open', { project: 's-test', dry: true });
ok(r.status === 200 && /--app=http:\/\/127\.0\.0\.1:7788\/\?project=s-test/.test(r.data.cmd.join(' ')), 'open dry-run command', r.data.cmd);

console.log('— chordix import (05)');
{ const d = (await j('DELETE', '/api/projects/s-chordix')).data; if (d && d.trash) fs.rmSync(d.trash, { recursive: true, force: true }); }
const t0 = Date.now();
r = await j('POST', '/api/import-chordix', { dir: WS, id: 's-chordix' });
ok(r.status === 201 && r.data.id === 's-chordix', `import-chordix → project (${((Date.now() - t0) / 1000).toFixed(1)} s)`, r.data.error || r.data.id);
const cp = r.data;
if (cp && cp.clips) {
  const clips = Object.values(cp.clips);
  const tr = (id) => cp.tracks.find((t) => t.id === id) || {};
  const sfxClips = clips.filter((c) => c.type === 'audio' && tr(c.trackId).role === 'sfx');
  const caps = clips.filter((c) => c.type === 'caption');
  const vclip = clips.find((c) => c.type === 'video');
  ok(vclip && vclip.muteAudio === true && vclip.name === 'וידאו מהסדנה' && Math.abs(vclip.duration - 20.6) < 0.05, 'video clip', vclip && { d: vclip.duration, n: vclip.name });
  ok(clips.some((c) => c.type === 'audio' && tr(c.trackId).role === 'voice'), 'voice clip');
  ok(clips.some((c) => c.type === 'audio' && tr(c.trackId).role === 'music'), 'music clip');
  ok(sfxClips.length === 16, `sfx clips (${sfxClips.length})`);
  ok(caps.length === 20 && tr(caps[0].trackId).hidden === true && tr(caps[0].trackId).name === 'כתוביות', `captions on hidden track (${caps.length})`);
  ok(cp.transcript.words.length === 44, `transcript words (${cp.transcript.words.length})`);
  ok(cp.markers.length === 18, `markers (${cp.markers.length})`);
  const boom = cp.transcript.words.find((w) => w.w === 'ובום!');
  const drop = sfxClips.find((c) => c.name === 'הדרופ — בראאאם');
  ok(boom && drop && Math.abs(drop.start - (boom.s + 0.05)) < 0.002 && Math.abs(drop.volume - 10 ** (-10 / 20)) < 0.001 && drop.fadeOut === 1, 'sfx timing/volume/fade from word', { boom, drop: drop && { s: drop.start, v: drop.volume, f: drop.fadeOut } });
  ok(cp.meta.import && cp.meta.import.coverage > 0.75, 'import report in meta', cp.meta.import);
  console.log('    warnings:', JSON.stringify(cp.meta.import && cp.meta.import.warnings));
  // wait for derivatives of the chordix project
  const stop2 = await sse('s-chordix');
  const t1 = Date.now();
  for (;;) {
    const p = (await j('GET', '/api/projects/s-chordix')).data;
    const st = Object.values(p.media).map((m) => m.status);
    if (!st.includes('processing')) { ok(st.every((s) => s === 'ready'), `chordix media ready (${st.length}) in ${((Date.now() - t1) / 1000).toFixed(1)} s`, st); break; }
    if (Date.now() - t1 > 240000) { ok(false, 'chordix media timeout'); break; }
    await sleep(1000);
  }
  if (!noAsr) {
    console.log('— transcribe (faster-whisper)');
    const p = (await j('GET', '/api/projects/s-chordix')).data;
    const voice = Object.values(p.clips).find((c) => c.type === 'audio' && tr(c.trackId).role === 'voice');
    const t2 = Date.now();
    r = await j('POST', '/api/projects/s-chordix/transcribe', { mediaId: voice.mediaId, model: 'small', by: 'claude' });
    ok(r.status === 202 && r.data.id && r.data.type === 'transcribe', 'transcribe job created', r.data);
    const w = await j('GET', `/api/jobs/${r.data.id}/wait?timeout=300`);
    ok(w.data.status === 'done' && w.data.result.words > 30, `transcribe done: ${w.data.result && w.data.result.words} words, ${w.data.result && w.data.result.snapped} snapped (${((Date.now() - t2) / 1000).toFixed(1)} s)`, w.data);
    if (w.data.result) console.log('    first words:', JSON.stringify(w.data.result.transcript.slice(0, 6)));
    const p2 = (await j('GET', '/api/projects/s-chordix')).data;
    ok(p2.transcript.words.length === w.data.result.words, 'transcript set via ops');
  }
  stop2();
  if (!keep) { const d = (await j('DELETE', '/api/projects/s-chordix')).data; if (d && d.trash) fs.rmSync(d.trash, { recursive: true, force: true }); }
}

stop();
if (!keep) {
  r = await j('DELETE', '/api/projects/s-test');
  ok(r.status === 200 && r.data.trash && fs.existsSync(r.data.trash), 'delete → .trash', r.data);
  if (r.data.trash) fs.rmSync(r.data.trash, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
