// Frame Studio — tests for `cutx balance` planning (cli/cutx.mjs): guilt attribution, dip envelope, keyframe composition,
// ops that apply cleanly, never touching the voice, sfx-on-speech suggestions. Pure (no server).
// Run: node "tools/tests/X-balance.test.mjs"

import assert from 'node:assert/strict';

const ROOT = new URL('../../', import.meta.url);
const cli = await import(new URL('cli/cutx.mjs', ROOT).href);
const { applyOps } = await import(new URL('shared/ops.js', ROOT).href);
const { newProject } = await import(new URL('shared/model.js', ROOT).href);
const { planBalance, dipEnvelope, composeVolumeKeys, balanceOps, clipVolumeAt, clipEdgeAt, envelopeGain, sfxSuggestions, dipSummary, BALANCE } = cli;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ? msg + ': ' : ''}expected ≈${b} (±${eps}), got ${a}`);
const db = (g) => 20 * Math.log10(g);

/** voice 0–10 s, music 0–10 s (vol 0.5), boom sfx 1–3 s, a video with sound on main 0–10 s (optional) */
function fixture({ video = false, lockSfx = false, musicKeys = null } = {}) {
  const P0 = newProject({ id: 'x-bal' });
  const media = (id, kind, duration) => ({ id, kind, name: id, path: `C:/x/${id}`, duration, width: kind === 'audio' ? 0 : 1080, height: kind === 'audio' ? 0 : 1920,
    hasVideo: kind !== 'audio', hasAudio: true, status: 'ready' });
  P0.media = { m_vo: media('m_vo', 'audio', 10), m_song: media('m_song', 'audio', 60), m_boom: media('m_boom', 'audio', 5), m_vid: media('m_vid', 'video', 20) };
  const ops = [
    { op: 'addClip', type: 'audio', mediaId: 'm_vo', start: 0, duration: 10, track: 't_voice', id: 'vo' },
    { op: 'addClip', type: 'audio', mediaId: 'm_song', start: 0, duration: 10, track: 't_music', id: 'mus', volume: 0.5, fadeOut: 1 },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 1, duration: 2, track: 't_sfx', id: 'boom', volume: 0.8 },
  ];
  if (video) ops.push({ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 10, track: 't_main', id: 'vid' });
  if (musicKeys) ops.push({ op: 'setKeyframes', id: 'mus', prop: 'volume', keys: musicKeys });
  if (lockSfx) ops.push({ op: 'updateTrack', id: 't_sfx', set: { locked: true } });
  const r = applyOps(P0, ops);
  r.results.forEach((x, i) => assert.ok(x.ok, `fixture op ${i}: ${x.error}`));
  const P = r.project;
  P.transcript = { words: [{ w: 'שקשוקה!', s: 0.2, e: 0.8 }, { w: 'בעשר', s: 1.2, e: 1.5 }, { w: 'דקות', s: 1.5, e: 2.4 }, { w: 'בלבד', s: 2.5, e: 3.0 }, { w: 'כאן', s: 4.0, e: 4.5 }] };
  // peaks @100/s: song steady 0.2, boom 1.0 for its first second then 0.3, video 0.1
  const peaks = new Map([
    ['m_song', { rate: 100, peaks: new Array(6000).fill(0.2) }],
    ['m_boom', { rate: 100, peaks: [...new Array(100).fill(1.0), ...new Array(400).fill(0.3)] }],
    ['m_vid', { rate: 100, peaks: new Array(2000).fill(0.1) }],
    ['m_vo', { rate: 100, peaks: new Array(1000).fill(0.5) }],
  ]);
  return { P, peaks };
}

test('dipEnvelope: window ±0.1 s plateau with 0.05 s ramps', () => {
  const env = dipEnvelope([{ t0: 1.3, t1: 1.4, depth: 10 }]);
  assert.deepEqual(env, [{ t: 1.15, db: 0 }, { t: 1.2, db: -10 }, { t: 1.5, db: -10 }, { t: 1.55, db: 0 }]);
  near(envelopeGain(env, 1.35), 10 ** (-10 / 20), 1e-9);
  near(envelopeGain(env, 1.0), 1, 1e-12);
  near(envelopeGain(env, 1.175), (1 + 10 ** (-0.5)) / 2, 1e-9, 'linear-in-gain ramp');
});

test('dipEnvelope: neighbouring dips merge (gap bridged at the shallower depth), far ones do not', () => {
  const env = dipEnvelope([{ t0: 1.0, t1: 1.1, depth: 6 }, { t0: 1.4, t1: 1.5, depth: 12 }]);
  // plateaus [0.9,1.2] and [1.3,1.6] → bridged: no 0 dB point between them
  assert.ok(!env.some((p) => p.t > 0.86 && p.t < 1.64 && p.db === 0), JSON.stringify(env));
  near(envelopeGain(env, 1.25), 10 ** (-6 / 20), 1e-9, 'bridge = shallower depth');
  near(envelopeGain(env, 1.45), 10 ** (-12 / 20), 1e-9);
  const far = dipEnvelope([{ t0: 1.0, t1: 1.1, depth: 6 }, { t0: 2.0, t1: 2.1, depth: 6 }]);
  near(envelopeGain(far, 1.6), 1, 1e-12, 'no bridge across 0.7 s');
});

test('planBalance: the loud boom alone is guilty when the music is small', () => {
  const { P, peaks } = fixture();
  const plan = planBalance(P, [{ t: 1.3, margin: 6 }], { target: 12, peaks });
  assert.deepEqual([...plan.dips.keys()], ['boom']);
  const w = plan.windows[0];
  assert.ok(w.depth >= 7 && w.depth <= 9, `depth ≈ deficit+1 (+ remainder), got ${w.depth}`);
  assert.ok(w.guilty[0].share > 0.9);
});

test('planBalance: both guilty when one dip is not enough; voice never touched; depth ≥ deficit + 1', () => {
  const { P, peaks } = fixture();
  const plan = planBalance(P, [{ t: 1.3, margin: -15 }], { target: 12, peaks });
  assert.deepEqual([...plan.dips.keys()].sort(), ['boom', 'mus']);
  assert.ok(!plan.dips.has('vo'));
  assert.ok(plan.windows[0].depth >= 28 - 1e-9);
  // music only in a window without the boom
  const p2 = planBalance(P, [{ t: 5.0, margin: 9 }], { target: 12, peaks });
  assert.deepEqual([...p2.dips.keys()], ['mus']);
  near(p2.windows[0].depth, 4, 1e-6, 'single contributor → exactly deficit + 1');
});

test('planBalance: windows that already pass are ignored; locked tracks are reported, not dipped', () => {
  const { P, peaks } = fixture({ lockSfx: true });
  const plan = planBalance(P, [{ t: 1.3, margin: 12.5 }, { t: 1.4, margin: 2 }], { target: 12, peaks });
  assert.equal(plan.windows.length, 1);
  assert.ok(plan.locked.has('boom'));
  assert.ok(!plan.dips.has('boom'));
});

test('planBalance: a video clip with sound counts as background; muteAudio does not', () => {
  const { P, peaks } = fixture({ video: true });
  const plan = planBalance(P, [{ t: 5.0, margin: -5 }], { target: 12, peaks });
  assert.ok(plan.dips.has('vid'), 'video with sound is guilty too');
  P.clips.vid.muteAudio = true;
  const plan2 = planBalance(P, [{ t: 5.0, margin: -5 }], { target: 12, peaks });
  assert.ok(!plan2.dips.has('vid'));
});

test('composeVolumeKeys: no keys before → base outside, base×dip inside; ops apply; fades untouched', () => {
  const { P, peaks } = fixture();
  const plan = planBalance(P, [{ t: 5.0, margin: 9 }], { target: 12, peaks });
  const ops = balanceOps(P, plan);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'setKeyframes');
  const r = applyOps(P, ops);
  assert.ok(r.results[0].ok, r.results[0].error);
  const c = r.project.clips.mus;
  near(clipVolumeAt(c, 2.0), 0.5, 1e-9);
  near(clipVolumeAt(c, 8.0), 0.5, 1e-9);
  near(db(clipVolumeAt(c, 5.05) / 0.5), -4, 1e-4);
  near(db(clipVolumeAt(c, 4.9) / 0.5), -4, 1e-4, 'plateau starts 0.1 s before the window');
  near(clipVolumeAt(c, 4.85), 0.5, 1e-9, 'ramp starts at window − 0.15');
  assert.equal(c.fadeOut, 1);
  assert.deepEqual(r.project.clips.vo, P.clips.vo, 'voice untouched');
  assert.deepEqual(r.project.clips.boom, P.clips.boom, 'non-guilty clip untouched');
});

test('composeVolumeKeys keeps an existing eased curve (exact on the plateau, close on the ramps)', () => {
  const keys0 = [{ t: 0, v: 1 }, { t: 6, v: 0.25, ease: 'easeInOut' }, { t: 9, v: 0.6, ease: 'spring' }];
  const { P } = fixture({ musicKeys: keys0 });
  const c0 = P.clips.mus;
  const env = dipEnvelope([{ t0: 3.0, t1: 3.1, depth: 9 }, { t0: 7.5, t1: 7.6, depth: 5 }]);
  const keys = composeVolumeKeys(c0, env);
  const r = applyOps(P, [{ op: 'setKeyframes', id: 'mus', prop: 'volume', replace: true, keys }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const c1 = r.project.clips.mus;
  for (let t = 0; t <= 10; t += 0.01) {
    const want = clipVolumeAt(c0, t) * envelopeGain(env, t);
    const got = clipVolumeAt(c1, t);
    const onRamp = env.some((p, i) => i < env.length - 1 && env[i].db !== env[i + 1].db && t > env[i].t && t < env[i + 1].t);
    near(got, want, onRamp ? 0.02 : 1e-5, `t=${t.toFixed(2)}`);
  }
  // original keys survive (same times)
  for (const k of keys0) assert.ok(c1.keyframes.volume.some((x) => Math.abs(x.t - k.t) < 1e-6), `key ${k.t} kept`);
});

test('composeVolumeKeys: a dip crossing the clip start gets a key at 0; envelope outside the clip → null', () => {
  const { P } = fixture();
  const c = P.clips.boom; // 1–3 s
  // plateau 0.85–1.15 covers the clip start: dipped from the first sample, back to 0.8 after the ramp
  const keys = composeVolumeKeys(c, dipEnvelope([{ t0: 0.95, t1: 1.05, depth: 6 }]));
  const ck = { ...c, keyframes: { volume: keys } };
  near(clipVolumeAt(ck, 1.0), 0.8 * 10 ** (-6 / 20), 1e-6);
  near(clipVolumeAt(ck, 1.1), 0.8 * 10 ** (-6 / 20), 1e-6);
  near(clipVolumeAt(ck, 1.3), 0.8, 1e-9);
  // ramp that starts exactly at the clip start (window 1.15: ramp 1.0→1.05) keeps a key at 0 with the full volume
  const env2 = dipEnvelope([{ t0: 1.15, t1: 1.25, depth: 6 }]);
  assert.equal(env2[0].t, 1.0);
  const keys2 = composeVolumeKeys(c, env2);
  assert.equal(keys2[0].t, 0);
  near(keys2[0].v, 0.8, 1e-9);
  near(clipVolumeAt({ ...c, keyframes: { volume: keys2 } }, 1.025), 0.8 * envelopeGain(env2, 1.025), 1e-6);
  assert.equal(composeVolumeKeys(c, dipEnvelope([{ t0: 6, t1: 6.1, depth: 6 }])), null);
});

test('repeated rounds compose multiplicatively (deeper where still failing)', () => {
  const { P, peaks } = fixture();
  const r1 = applyOps(P, balanceOps(P, planBalance(P, [{ t: 5.0, margin: 9 }], { target: 12, peaks })));
  const P1 = r1.project;
  const r2 = applyOps(P1, balanceOps(P1, planBalance(P1, [{ t: 5.0, margin: 10 }], { target: 12, peaks })));
  near(db(clipVolumeAt(r2.project.clips.mus, 5.05) / 0.5), -7, 1e-4);
  const sum = dipSummary(P, r2.project, ['mus']);
  assert.equal(sum[0].regions, 1);
  near(sum[0].maxDb, -7, 0.05);
});

test('sfxSuggestions: an sfx mostly on speech → move it into the nearest gap between words', () => {
  const { P, peaks } = fixture();
  const s = sfxSuggestions(P, ['boom', 'mus'], peaks);
  assert.equal(s.length, 1, 'only sfx-track clips get suggestions');
  assert.equal(s[0].id, 'boom');
  assert.ok(s[0].onSpeech > 50);
  assert.deepEqual(s[0].gap, [0.8, 1.2]);
  near(s[0].start, 1.0 - (s[0].peakAt - 1), 0.011);
});

test('clipEdgeAt matches fades (equal-power) and de-click', () => {
  const c = { start: 0, duration: 4, fadeIn: 1, fadeOut: 1 };
  near(clipEdgeAt(c, 0.5), Math.sin(0.25 * Math.PI), 1e-9);
  near(clipEdgeAt(c, 2), 1, 1e-12);
  near(clipEdgeAt(c, 3.5), Math.sin(0.25 * Math.PI), 1e-9);
  assert.equal(clipEdgeAt(c, 4.5), 0);
  assert.equal(BALANCE.extraDb, 1);
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`✓ ${t.name}`); }
  catch (e) { fail++; console.log(`✗ ${t.name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); }
}
console.log(`\n${pass}/${pass + fail} בדיקות עברו`);
if (fail) process.exitCode = 1;
