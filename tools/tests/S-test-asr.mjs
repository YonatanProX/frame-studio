// Transcription job through whichever job registry is active (export.mjs externalJobs or the main.mjs fallback),
// with captions, offset mapping onto a clip that starts later on the timeline.
//   node tools/tests/S-test-asr.mjs --voice <speech.wav|mp3> [--port 7788]
// Needs local transcription set up (tools/install-transcription.cmd) and a voice-over file with at least ~10 s of
// speech; env FRAME_STUDIO_TEST_VOICE works instead of --voice. Skipped when no file is given.
import fs from 'node:fs';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = `http://127.0.0.1:${Number(arg('--port')) || 7788}`;
const VO = arg('--voice') || process.env.FRAME_STUDIO_TEST_VOICE;
if (!VO || !fs.existsSync(VO)) { console.log('  - skipped: pass --voice <speech file> (or env FRAME_STUDIO_TEST_VOICE)'); process.exit(0); }
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 600) : ''); } };
const j = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };

const health = (await j('GET', '/api/health')).data;
console.log('  export module loaded:', health.modules.export);
await j('DELETE', '/api/projects/s-asr');
await j('POST', '/api/projects', { id: 's-asr', name: 'תמלול' });
// voice clip placed at 2.0 s, trimmed 1.0 s into the file → word times must shift by +1.0
let r = await j('POST', '/api/projects/s-asr/ops', { by: 'claude', ops: [{ op: 'addClip', type: 'audio', role: 'voice', path: VO, start: 2, in: 1, duration: 8, id: 'c_vo' }] });
ok(r.status === 200 && r.data.results[0].ok, 'voice clip from path', r.data.results);
const mid = r.data.project.clips.c_vo.mediaId;
const t0 = Date.now();
r = await j('POST', '/api/projects/s-asr/transcribe', { mediaId: mid, captions: { maxWords: 3, style: 'karaoke' }, by: 'claude' });
ok(r.status === 202 && r.data.id, 'job', r.data);
const w = await j('GET', `/api/jobs/${r.data.id}/wait?timeout=300`);
ok(w.data.status === 'done', `done in ${((Date.now() - t0) / 1000).toFixed(1)} s`, w.data);
const res = w.data.result || w.data.report || {};
ok(res.offset === 1 && res.clipId === 'c_vo', 'mapped onto clip (offset +1.0)', res);
const p = (await j('GET', '/api/projects/s-asr')).data;
const words = p.transcript.words;
ok(words.length > 10 && words[0].s >= 2 && words[words.length - 1].e <= 10.05, `transcript in timeline time (${words.length} words, ${words[0] && words[0].s}–${words.length && words[words.length - 1].e})`);
const caps = Object.values(p.clips).filter((c) => c.type === 'caption');
ok(caps.length >= 4 && Array.isArray(res.captionIds) && res.captionIds.length === caps.length, `captions created (${caps.length})`);
r = await j('POST', '/api/projects/s-asr/transcribe', {});
ok(r.status === 400, 'missing mediaId/path → 400', r.data);
r = await j('POST', '/api/projects/s-asr/transcribe', { mediaId: 'nope' });
ok(r.status === 404, 'unknown media → 404', r.data);
r = await j('DELETE', '/api/projects/s-asr');
if (r.data.trash) fs.rmSync(r.data.trash, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
