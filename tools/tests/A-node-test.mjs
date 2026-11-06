// Agent A self-test (Node): export.mjs building blocks on synthetic media.
// Run: node "tools/tests/A-node-test.mjs"
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ASSETS = path.join(HERE, 'A-assets');
const OUT = path.join(HERE, 'A-out');
await fs.mkdir(ASSETS, { recursive: true });
await fs.mkdir(OUT, { recursive: true });

const ex = await import(pathToFileURL(path.join(ROOT, 'server', 'export.mjs')).href);
const ae = await import(pathToFileURL(path.join(ROOT, 'render', 'audio-engine.js')).href);

let failures = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  — ${extra}` : ''}`); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function ff(args) {
  const r = await ex.runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

/* ---------- synthetic assets (also used by the browser tests) ---------- */
const A = (f) => path.join(ASSETS, f);
await ff(['-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*220*t)|0.1*sin(2*PI*220*t):s=48000:d=10', '-c:a', 'pcm_s16le', A('music.wav')]);
await ff(['-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*600*t)*(between(t\\,1\\,2.9999)+between(t\\,5\\,5.9999))|0.3*sin(2*PI*600*t)*(between(t\\,1\\,2.9999)+between(t\\,5\\,5.9999)):s=48000:d=8', '-c:a', 'pcm_s16le', A('voice.wav')]);
await ff(['-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*1500*t)|0.2*sin(2*PI*1500*t):s=48000:d=2', '-c:a', 'pcm_s16le', A('sfx.wav')]);
// Speech-margin fixtures (float): voice 300 Hz bursts (0.3 s on / 0.2 s off) at 0.25; background 1 kHz at 0.025, 0.125 in [3,3.5)
await ff(['-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*300*t)*lt(mod(t\\,0.5)\\,0.3)|0.25*sin(2*PI*300*t)*lt(mod(t\\,0.5)\\,0.3):s=48000:d=6', '-c:a', 'pcm_f32le', A('stem-voice.wav')]);
await ff(['-f', 'lavfi', '-i', 'aevalsrc=(0.025+0.1*between(t\\,3\\,3.4999))*sin(2*PI*1000*t)|(0.025+0.1*between(t\\,3\\,3.4999))*sin(2*PI*1000*t):s=48000:d=6', '-c:a', 'pcm_f32le', A('stem-bg.wav')]);
// Typical dynamic mix: pink-noise bed (≈ -25 LUFS) + a boom at 2 s peaking ≈ -4 dBFS.
await ff(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:a=0.2:d=8:s=7', '-f', 'lavfi', '-i', "aevalsrc=0.6*sin(2*PI*60*t)*exp(-6*(t-2))*gte(t\\,2):s=48000:d=8",
  '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo', '-c:a', 'pcm_f32le', A('mix-real.wav')]);
// Extreme crest factor: same bed + a near-full-scale boom (needs > 12 dB of limiting to reach -14 LUFS).
await ff(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:a=0.08:d=8:s=7', '-f', 'lavfi', '-i', "aevalsrc=0.9*sin(2*PI*60*t)*exp(-6*(t-2))*gte(t\\,2):s=48000:d=8",
  '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo', '-c:a', 'pcm_f32le', A('mix-loud.wav')]);
console.log('assets generated in', ASSETS);

/* ---------- 1. ebur128 parsing + gain maths ---------- */
const sample = `[Parsed_ebur128_0 @ 0000] Summary:

  Integrated loudness:
    I:         -23.4 LUFS
    Threshold: -33.7 LUFS

  Loudness range:
    LRA:         5.1 LU
    Threshold: -43.6 LUFS
    LRA low:   -26.0 LUFS
    LRA high:  -20.9 LUFS

  True peak:
    Peak:       -3.2 dBFS`;
const pe = ex.parseEbur128(sample);
ok(pe.I === -23.4 && pe.LRA === 5.1 && pe.truePeak === -3.2 && pe.threshold === -33.7 && pe.found && !pe.silent, 'parseEbur128 parses I / LRA / true peak / threshold', JSON.stringify(pe));
const silentParse = ex.parseEbur128('Summary:\n  Integrated loudness:\n    I:         -70.0 LUFS\n  True peak:\n    Peak:       -inf dBFS');
ok(silentParse.silent && silentParse.truePeak === -Infinity, 'parseEbur128 detects silence and -inf peak');
ok(ex.computeLoudnessGain(-23.4, -14) === 9.4 - 0 || near(ex.computeLoudnessGain(-23.4, -14), 9.4, 1e-9), 'gain -23.4 → -14 = +9.4 dB');
ok(ex.computeLoudnessGain(-40, -14) === 20 && ex.computeLoudnessGain(10, -14) === -20, 'gain clamped to ±20 dB');
ok(ex.computeLoudnessGain(-70, -14) === 0 && ex.computeLoudnessGain(NaN, -14) === 0, 'silence/invalid → 0 dB');
const realM = await ex.measureLoudness(A('music.wav'));
// 220 Hz sine, amplitude 0.1 stereo: 0.1 peak = -20 dBFS; K-weighted loudness ≈ -20 - 3.01 (rms) - 0.691 + 3.01 (2 ch) ≈ -20.7 LUFS
ok(realM.found && near(realM.I, -20.7, 0.6) && near(realM.truePeak, -20, 0.3), 'measureLoudness on a real file (220 Hz @ -20 dBFS)', `I=${realM.I} TP=${realM.truePeak}`);

/* ---------- 2. WAV reader + speech margin ---------- */
const v = ex.parseWav(await fs.readFile(A('stem-voice.wav')));
ok(v.sampleRate === 48000 && v.channels === 2 && near(v.frames, 288000, 1) && v.format === 3, 'parseWav reads float32 stereo', `${v.sampleRate}/${v.channels}/${v.frames}`);
const s16 = ex.parseWav(await fs.readFile(A('music.wav')));
let pk = 0; for (const x of s16.data[0]) pk = Math.max(pk, Math.abs(x));
ok(near(pk, 0.1, 0.002), 'parseWav reads pcm16 with correct scale', `peak=${pk.toFixed(4)}`);
const margin = ex.computeSpeechMargin(await fs.readFile(A('stem-voice.wav')), await fs.readFile(A('stem-bg.wav')), { offset: 0 });
ok(margin.belowCount === 3, 'margin: exactly the 3 voiced windows in [3,3.5) are below 12 dB', `below=${margin.belowCount} ${JSON.stringify(margin.below)}`);
ok(near(margin.min, 6.02, 0.15), 'margin: min ≈ 20·log10(0.25/0.125) = 6.02 dB', `min=${margin.min}`);
ok(near(margin.median, 20, 0.15), 'margin: median ≈ 20 dB', `median=${margin.median}`);
ok(margin.below.every((b) => b.t >= 3 && b.t < 3.5), 'margin: low windows reported at the right times', margin.below.map((b) => b.t).join(','));
ok(margin.activeWindows === 36, 'margin: 36 active windows (0.3 s of every 0.5 s over 6 s)', `active=${margin.activeWindows}`);
ok(/מתחת ליעד/.test(margin.summary), 'margin: Hebrew summary', margin.summary);

/* ---------- 3. WAV encoder (audio-engine) round trip ---------- */
const fake = { numberOfChannels: 2, sampleRate: 48000, length: 4800, getChannelData: (c) => Float32Array.from({ length: 4800 }, (_, i) => (c ? -1 : 1) * 0.5 * Math.sin(2 * Math.PI * 1000 * i / 48000)) };
const w16 = ex.parseWav(Buffer.from(ae.encodeWav(fake)));
const wf = ex.parseWav(Buffer.from(ae.encodeWav(fake, { float: true })));
let e16 = 0, ef = 0;
for (let i = 0; i < 4800; i++) { e16 = Math.max(e16, Math.abs(w16.data[0][i] - fake.getChannelData(0)[i])); ef = Math.max(ef, Math.abs(wf.data[1][i] - fake.getChannelData(1)[i])); }
ok(w16.bits === 16 && e16 < 3 / 32768, 'encodeWav 16-bit (TPDF dither) round trip error < 3 LSB', `err=${(e16 * 32768).toFixed(2)} LSB`);
ok(wf.bits === 32 && wf.format === 3 && ef === 0, 'encodeWav float32 is bit exact', `err=${ef}`);
const probeW = await ex.probeFile(await (async () => { const f = path.join(OUT, 'enc-float.wav'); await fs.writeFile(f, Buffer.from(ae.encodeWav(fake, { float: true }))); return f; })());
ok(probeW.streams?.[0]?.codec_name === 'pcm_f32le', 'ffprobe accepts the float WAV', probeW.streams?.[0]?.codec_name);

/* ---------- 4. audio-engine pure maths ---------- */
const env = ae.duckEnvelopeFromLevels(Float32Array.from({ length: 300 }, (_, i) => (i >= 100 && i < 200 ? 0.5 : 0)), 100);
ok(env[99] > 0.85 && env[92] < 0.05 && env[150] === 1, 'duck envelope: look-ahead attack completes at voice onset', `env[92]=${env[92].toFixed(2)} env[99]=${env[99].toFixed(2)}`);
ok(env[199 + 15] === 1 && near(env[199 + 15 + 20], 0.5, 0.03) && env[199 + 15 + 41] === 0, 'duck envelope: 0.15 s hold then 0.4 s release', `${env[214]} ${env[234].toFixed(2)} ${env[255]}`);
ok(near(ae.compressorMakeupDb(-6, 6, 1.5), 0.61, 0.05), 'glue make-up gain (Chromium formula) ≈ 0.6 dB', ae.compressorMakeupDb(-6, 6, 1.5).toFixed(3));
const clip = { start: 2, duration: 4, fadeIn: 1, fadeOut: 2, volume: 0.5, keyframes: { volume: [{ t: 0, v: 0.2 }, { t: 2, v: 1, ease: 'linear' }] } };
ok(near(ae.edgeGainAt(clip, 2.5), Math.SQRT1_2, 1e-9) && ae.edgeGainAt(clip, 3.5) === 1 && near(ae.edgeGainAt(clip, 5), Math.SQRT1_2, 1e-9), 'equal-power fades');
ok(near(ae.volumeAt(clip, 3), 0.6, 1e-9), 'volume keyframes (local evaluator) linear interpolation');

/* ---------- 5. mastering to -14 LUFS / TP ≤ -1 ---------- */
const t0 = Date.now();
const mres = await ex.masterAudio(A('mix-real.wav'), path.join(OUT, 'mastered.m4a'), { targetLufs: -14, truePeakMax: -1 });
ok(near(mres.output.I, -14, 0.3), 'mastered loudness within ±0.3 LU of -14 (realistic mix)', `in=${mres.input.I} gain=${mres.gainDb.toFixed(2)} out=${mres.output.I} passes=${mres.passes.length}`);
ok(mres.output.truePeak <= -1.0, 'mastered true peak ≤ -1 dBTP', `TP=${mres.output.truePeak} limit=${mres.limit}`);
console.log('      mastering passes:', JSON.stringify(mres.passes), `${Date.now() - t0} ms`);
const xres = await ex.masterAudio(A('mix-loud.wav'), path.join(OUT, 'mastered-x.m4a'), { targetLufs: -14, truePeakMax: -1 });
ok(xres.output.truePeak <= -1.0 && (near(xres.output.I, -14, 0.5) || !!xres.warning), 'extreme crest factor: TP respected, target reached or a Hebrew warning explains why', `out=${xres.output.I} TP=${xres.output.truePeak} warning=${xres.warning}`);
console.log('      extreme passes:', JSON.stringify(xres.passes));
const quiet = await ex.masterAudio(A('music.wav'), path.join(OUT, 'mastered-quiet.m4a'), { targetLufs: -14 });
ok(near(quiet.output.I, -14, 0.3) && quiet.output.truePeak <= -1, 'quiet sine boosted to -14 LUFS', `in=${quiet.input.I} out=${quiet.output.I} TP=${quiet.output.truePeak}`);

/* ---------- 6. rawvideo pipe → mp4 → mux ---------- */
const W = 360, H = 640, FPS = 30, N = 60;
const pipe = new ex.FramePipe({ width: W, height: H, fps: FPS, out: path.join(OUT, 'pipe-video.mp4'), crf: 20, preset: 'veryfast' }).start();
const tp0 = Date.now();
for (let n = 0; n < N; n++) {
  const buf = Buffer.alloc(W * H * 4);
  const bar = Math.round((n / (N - 1)) * (W - 40));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const inBar = x >= bar && x < bar + 40;
    buf[i] = inBar ? 255 : 7; buf[i + 1] = inBar ? 255 : 24; buf[i + 2] = inBar ? 255 : 34; buf[i + 3] = 255;
    if (y < 40) { buf[i] = 19; buf[i + 1] = 182; buf[i + 2] = 228; }
  }
  await pipe.write(buf);
}
await pipe.finish();
const pv = await ex.probeFile(path.join(OUT, 'pipe-video.mp4'));
const vs = pv.streams.find((s) => s.codec_type === 'video');
ok(vs.codec_name === 'h264' && vs.width === W && vs.height === H && Number(vs.nb_frames) === N, 'FramePipe → h264 360x640, 60 frames', `${vs.codec_name} ${vs.width}x${vs.height} frames=${vs.nb_frames} (${Date.now() - tp0} ms)`);
ok(near(Number(pv.format.duration), 2.0, 0.05), 'video duration 2.0 s', pv.format.duration);
const pix = await ex.runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_space,color_primaries,color_transfer', '-of', 'csv=p=0', path.join(OUT, 'pipe-video.mp4')]);
ok(/yuv420p,bt709,bt709,bt709/.test(pix.stdout.trim()), 'yuv420p + bt709 tagged', pix.stdout.trim());
// colour accuracy: decode the cyan header pixel back to RGB
const dec = await ex.runProcess('ffmpeg', ['-v', 'error', '-i', path.join(OUT, 'pipe-video.mp4'), '-frames:v', '1', '-vf', 'crop=8:8:100:10,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
const rgb = Buffer.from(dec.stdout, 'latin1');
const decoded = await new Promise((resolve) => {
  import('node:child_process').then(({ spawn }) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', path.join(OUT, 'pipe-video.mp4'), '-frames:v', '1', '-vf', 'crop=8:8:100:10,scale=1:1:flags=area:in_color_matrix=bt709:in_range=tv', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    const chunks = []; p.stdout.on('data', (d) => chunks.push(d)); p.on('close', () => resolve(Buffer.concat(chunks)));
  });
});
void rgb;
ok(decoded.length === 3 && near(decoded[0], 19, 6) && near(decoded[1], 182, 6) && near(decoded[2], 228, 6), 'colour survives RGB→bt709 YUV→RGB (cyan #13b6e4)', `[${[...decoded].join(',')}]`);
// odd-size frames are evened for yuv420p
const odd = new ex.FramePipe({ width: 101, height: 51, fps: 25, out: path.join(OUT, 'pipe-odd.mp4'), preset: 'ultrafast' }).start();
for (let n = 0; n < 5; n++) await odd.write(Buffer.alloc(101 * 51 * 4, 128));
await odd.finish();
const po = (await ex.probeFile(path.join(OUT, 'pipe-odd.mp4'))).streams[0];
ok(po.width % 2 === 0 && po.height % 2 === 0, 'odd input size → even output', `${po.width}x${po.height}`);
// wrong-size frame is rejected
let threw = false; try { await new ex.FramePipe({ width: 10, height: 10, fps: 1, out: path.join(OUT, 'x.mp4') }).write(Buffer.alloc(5)); } catch { threw = true; }
ok(threw, 'wrong frame size rejected');

await ex.masterAudio(A('voice.wav'), path.join(OUT, 'mux-audio.m4a'), { targetLufs: -14 });
await ex.muxAv(path.join(OUT, 'pipe-video.mp4'), path.join(OUT, 'mux-audio.m4a'), path.join(OUT, 'muxed.mp4'), { title: 'בדיקה' });
const pm = await ex.probeFile(path.join(OUT, 'muxed.mp4'));
ok(pm.streams.some((s) => s.codec_type === 'video') && pm.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), 'mux: video + aac audio', pm.streams.map((s) => s.codec_name).join('+'));

/* ---------- 7. contact sheet ---------- */
const pngs = [];
for (let i = 0; i < 5; i++) {
  const f = path.join(OUT, `snap-${i}.png`);
  await ff(['-f', 'lavfi', '-i', `color=c=0x${(20 + i * 40).toString(16).padStart(2, '0')}4488:s=540x960`, '-frames:v', '1', f]);
  pngs.push({ i, t: i * 0.75, path: f });
}
const sheet = await ex.makeContactSheet(pngs, path.join(OUT, 'sheet.png'), { width: 1080, height: 1920 });
const ps = (await ex.probeFile(sheet.path)).streams[0];
ok(sheet.cols * sheet.rows >= 5 && ps.width > 0, 'contact sheet built', `${sheet.cols}x${sheet.rows} → ${ps.width}x${ps.height}`);

/* ---------- 8. misc ---------- */
ok(ex.safeFileName('סרטון: "חדש"?') === 'סרטון חדש', 'safeFileName keeps Hebrew, strips illegal characters', ex.safeFileName('סרטון: "חדש"?'));
ok(/^\d{8}-\d{6}$/.test(ex.stamp()), 'stamp yyyyMMdd-HHmmss');
ok(!!ex.findChrome(), 'Chrome found', ex.findChrome());

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
