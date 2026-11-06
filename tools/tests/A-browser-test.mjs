// Agent A self-test (headless Chrome): audio-engine offline render of a 3-clip project, verified in Node.
// Run after A-node-test.mjs (it generates the WAV assets): node "tools/tests/A-browser-test.mjs"
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT, OUT, findChromeExe } from './A-server.mjs';

const ex = await import(pathToFileURL(path.join(ROOT, 'server', 'export.mjs')).href);
const PORT = 7793;
let failures = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  — ${extra}` : ''}`); if (!cond) failures++; };

let doneResolve;
const done = new Promise((r) => { doneResolve = r; });
const srv = await startServer({ port: PORT, onResult: (name) => { if (name === 'done') doneResolve(); } });
const profile = path.join(path.dirname(OUT), 'A-chrome-profile');
await fsp.rm(profile, { recursive: true, force: true });
const chrome = spawn(findChromeExe(), ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio',
  `http://127.0.0.1:${PORT}/tools/tests/A-audio-test.html`], { stdio: 'ignore', windowsHide: true });
const timeout = setTimeout(() => doneResolve('timeout'), 90_000);
const res = await done;
clearTimeout(timeout);
spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
await srv.close();
ok(res !== 'timeout', 'browser page finished');
const summary = JSON.parse(await fsp.readFile(path.join(OUT, 'browser-summary.json'), 'utf8'));
console.log('summary:', JSON.stringify(summary));
ok(summary.ok, 'page ran without exceptions', summary.error || '');

const W = async (n) => ex.parseWav(await fsp.readFile(path.join(OUT, `browser-${n}`)));

// Hann-windowed Goertzel amplitude of a sine at f around time t (40 ms window), channel 0.
function amp(wav, f, t, win = 0.04) {
  const sr = wav.sampleRate, N = Math.round(win * sr), s0 = Math.round(t * sr - N / 2);
  const d = wav.data[0];
  let re = 0, im = 0, wsum = 0;
  for (let i = 0; i < N; i++) {
    const x = d[s0 + i] || 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const ph = (2 * Math.PI * f * (s0 + i)) / sr;
    re += x * w * Math.cos(ph); im -= x * w * Math.sin(ph);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}
const db = (a) => 20 * Math.log10(Math.max(a, 1e-9));
const near = (a, b, tolDb) => Math.abs(db(a) - db(b)) <= tolDb;
function check(wav, f, t, expected, tolDb, label) {
  const a = amp(wav, f, t);
  ok(expected === 0 ? a < 0.003 : near(a, expected, tolDb), label, `${f} Hz @ ${t}s = ${a.toFixed(4)} (expected ${expected})`);
}
function onset(wav, from, to, thr = 0.02) {
  const sr = wav.sampleRate, d = wav.data[0];
  for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) if (Math.abs(d[i]) > thr) return i / sr;
  return null;
}

if (summary.ok) {
  const mix = await W('A-mix.wav'), voice = await W('A-voice.wav'), bg = await W('A-background.wav');
  ok(mix.frames === 480000 && voice.frames === 480000 && bg.frames === 480000 && mix.channels === 2, 'offline render: 10 s @ 48 kHz stereo mix + 2 stems', `${mix.frames}/${voice.frames}/${bg.frames}`);
  // fades (equal power), ducking with look-ahead attack/hold/release, voice level, keyframed sfx volume
  check(mix, 220, 0.5, 0.0707, 0.3, 'music fade-in midpoint = -3 dB (equal power)');
  check(mix, 220, 1.5, 0.1, 0.3, 'music at full level before the voice');
  check(mix, 220, 1.96, 0.1 * 10 ** (-5 / 20), 1.0, 'duck attack is already half way 40 ms before the voice (look-ahead)');
  check(mix, 220, 3.0, 0.1 * 10 ** (-10 / 20), 0.4, 'music ducked by -10 dB under voice');
  check(mix, 220, 4.12, 0.1 * 10 ** (-10 / 20), 0.6, 'duck held for 0.15 s after the voice stops');
  check(mix, 220, 4.35, 0.1 * 10 ** (-5 / 20), 1.0, 'duck releasing (half way at hold+0.2 s)');
  check(mix, 220, 5.0, 0.1, 0.3, 'music fully recovered after release');
  check(mix, 220, 6.5, 0.1 * 10 ** (-10 / 20), 0.4, 'second voice phrase ducks again');
  check(mix, 220, 9.5, 0.0707, 0.3, 'music fade-out midpoint = -3 dB');
  check(mix, 600, 3.0, 0.3, 0.3, 'voice level untouched (glue compressor make-up cancelled)');
  check(mix, 600, 1.5, 0, 0, 'no voice before its phrase');
  check(mix, 1500, 8.5, 0.2 * 0.625, 0.3, 'sfx volume keyframes 0.25→1.0: 0.625 at local 0.5 s');
  check(mix, 1500, 9.25, 0.2, 0.3, 'sfx after last keyframe = 1.0');
  check(mix, 1500, 9.7, 0, 0, 'sfx silent after its clip ends');
  const on = onset(voice, 1.9, 2.2, 0.02);
  ok(on != null && Math.abs(on - 2.0) < 0.0015, 'voice onset sample-accurate at 2.000 s (latencies compensated)', `onset=${on}`);
  // mix == voice stem + background stem, sample by sample (stems delayed like the glue compressor; glue unity below threshold)
  let resid = 0;
  for (let i = 0; i < mix.frames; i++) resid = Math.max(resid, Math.abs(mix.data[0][i] - voice.data[0][i] - bg.data[0][i]));
  ok(resid < 0.002, 'stems are sample-aligned with the mix (mix − voice − background ≈ 0)', `max residual=${resid.toFixed(5)}`);
  // the opening 50 ms must not dip (fresh-compressor start-up transient is warmed away)
  check(mix, 220, 0.03, 0.1 * Math.sin(0.03 * Math.PI / 2), 0.6, 'no compressor start-up dip at t=0 (fade-in value at 30 ms)');
  // stems
  check(voice, 600, 3.0, 0.3, 0.3, 'voice stem carries the voice');
  check(voice, 220, 1.5, 0, 0, 'voice stem has no music');
  check(bg, 220, 3.0, 0.1 * 10 ** (-10 / 20), 0.4, 'background stem carries ducked music');
  check(bg, 1500, 9.25, 0.2, 0.3, 'background stem carries sfx');
  check(bg, 600, 3.0, 0, 0, 'background stem has no voice');
  const margin = ex.computeSpeechMargin(await fsp.readFile(path.join(OUT, 'browser-A-voice.wav')), await fsp.readFile(path.join(OUT, 'browser-A-background.wav')));
  ok(margin.min > 15 && margin.min < 22, 'speech margin from rendered stems ≈ 20 dB (voice 0.3 vs ducked music 0.0316)', margin.summary);
  // sub-range render equals the matching span of the full render
  const part = await W('A-part.wav');
  let maxDiff = 0;
  const off = Math.round(2.5 * 48000);
  for (let i = 200; i < part.frames - 200; i++) maxDiff = Math.max(maxDiff, Math.abs(part.data[0][i] - mix.data[0][off + i]));
  ok(part.frames === 96000 && maxDiff < 0.002, 'partial render (2.5–4.5 s) matches the full render (pre-roll)', `frames=${part.frames} maxDiff=${maxDiff.toFixed(5)}`);

  // Scenario B: reverse + voice-enhance on the voice, speed ×2 on the sfx
  const mixB = await W('B-mix.wav');
  const vB = await W('B-voice.wav');
  const enhanced = 0.3 * 10 ** (2 / 20);   // loudness-preserving make-up + 2 dB presence
  check(mixB, 600, 1.5, enhanced, 1.0, 'reversed voice: phrase heard at 1–2 s, voice-enhance keeps loudness (+2 dB)');
  check(mixB, 600, 3.0, 0, 0, 'reversed voice: silence at 3 s');
  check(mixB, 600, 5.0, enhanced, 1.0, 'reversed voice: phrase heard at 4–6 s');
  check(mixB, 600, 1.03, enhanced, 1.0, 'voice-enhance compressor has no start-up dip (30 ms into the clip)');
  check(mixB, 220, 5.0, 0.1 * 10 ** (-10 / 20), 0.6, 'ducking follows the reversed voice');
  check(mixB, 220, 3.0, 0.1, 0.4, 'no ducking where the reversed voice is silent');
  const onB = onset(vB, 3.9, 4.2, 0.02);
  ok(onB != null && Math.abs(onB - 4.0) < 0.0015, 'voice-enhance chain latency compensated (onset at 4.000 s)', `onset=${onB}`);
  check(mixB, 3000, 8.5, 0.2 * 0.625, 0.5, 'sfx at speed ×2 → 3 kHz, keyframes still applied');
  check(mixB, 3000, 9.25, 0, 0, 'sfx at speed ×2 runs out of source at 9.0 s');
  const enh = amp(mixB, 600, 5.0);
  console.log(`      voice-enhance level change: ${(db(enh) - db(0.3)).toFixed(2)} dB (compressor 3:1 @ -24 dB, make-up cancelled, +2 dB)`);

  // preview path
  const pv = summary.preview || {};
  ok(pv.ctxState === 'running', 'preview AudioContext running headless', pv.ctxState);
  ok(Math.abs(pv.currentTime - 2.5 - pv.wallElapsed) < 0.25, 'preview clock advances with wall time', `currentTime=${pv.currentTime?.toFixed(3)} wall=${pv.wallElapsed?.toFixed(3)}`);
  ok(pv.maxPeakDb > -20 && pv.maxPeakDb < 0, 'master meters read the playing signal', `peak=${pv.maxPeakDb?.toFixed(2)} dBFS lufsShort=${pv.lufsShort?.toFixed?.(1)}`);
  ok(pv.afterSeek >= 6.5 && pv.afterSeek < 6.8, 'seek while playing restarts at the new time', String(pv.afterSeek));
  ok(pv.pausedStable, 'clock frozen while paused');
}

await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
