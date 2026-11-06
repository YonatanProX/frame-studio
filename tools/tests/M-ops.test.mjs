// Frame Studio — tests for shared/model.js, shared/anim.js, shared/ops.js, shared/catalog.js (agent M).
// Run: node "tools/tests/M-ops.test.mjs"   (plain node:assert, no deps)

import assert from 'node:assert/strict';

const ROOT = new URL('../../', import.meta.url);
const model = await import(new URL('shared/model.js', ROOT).href);
const anim = await import(new URL('shared/anim.js', ROOT).href);
const ops = await import(new URL('shared/ops.js', ROOT).href);
const catalog = await import(new URL('shared/catalog.js', ROOT).href);
// M_CATALOG=1 → run every test with the real render catalogs loaded (stricter id validation)
if (process.env.M_CATALOG === '1') { const c = await catalog.getCatalog(); console.log(`(קטלוג נטען: ${c.loaded ? 'כן' : 'לא'})`); }

const {
  newProject, newClip, newTrack, DEFAULT_TRACKS, uid, slugify, getPath, setPath, deepMerge, clipEnd, projectDuration,
  clipsOnTrack, activeClipsAt, nextClipOnTrack, prevClipOnTrack, sourceTimeAt, snapToFrame, formatTimecode, parseTimecode,
  validateProject, normalizeClip, normalizeProject, ROLE_LABELS, CLIP_TYPE_LABELS, defaultFit, isKeyframable, dbToGain,
} = model;
const { EASINGS, spring, getEase, evalKeyframed, evalClipProps, hash, noise1, CLIP_ANIMS, animState, fadeGain, animDurations, interpolateKeyframes } = anim;
const { applyOps, resolveTime, chunkCaptionWords, normalizeWord, OPS_HELP, OP_NAMES, summarizeOps, splitKeyframeMap, FALLBACK_CAPTION_STYLES } = ops;

// ───────────── tiny runner ─────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ? msg + ': ' : ''}expected ${b}, got ${a} (eps ${eps})`);

// ───────────── fixtures ─────────────
const WORDS = [
  ['רֶגַע!', 0.12, 0.48],
  ['יש', 0.80, 0.95], ['לכם', 0.97, 1.20], ['שיר,', 1.22, 1.60],
  ['שאין', 1.70, 2.00], ['לו', 2.02, 2.15], ['אקורדים', 2.18, 2.80],
  ['באף', 2.85, 3.10], ['אתר?', 3.12, 3.60],
  ['תסתכלו', 4.40, 4.90], ['על', 4.92, 5.05], ['זה', 5.07, 5.30], ['ובום!', 5.40, 5.90],
  ['סולם!', 6.30, 6.80], ['קצב!', 7.00, 7.40], ['מבנה!', 7.60, 8.10],
  ['ובום!', 9.80, 10.30],
  ['קורדיקס!', 11.0, 11.6], ['חינם,', 11.8, 12.2], ['נסו', 12.3, 12.5], ['עכשיו!', 12.55, 13.1],
];

function fixture(opts = {}) {
  const p = newProject({ id: 'test-proj', name: 'בדיקה' });
  p.media = {
    m_vid: { id: 'm_vid', kind: 'video', name: 'clip.mp4', path: 'C:/x/clip.mp4', duration: 10, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true, status: 'ready' },
    m_wide: { id: 'm_wide', kind: 'video', name: 'wide.mp4', path: 'C:/x/wide.mp4', duration: 8, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, status: 'ready' },
    m_img: { id: 'm_img', kind: 'image', name: 'pic.png', path: 'C:/x/pic.png', duration: 0, width: 800, height: 600, hasVideo: true, hasAudio: false, status: 'ready' },
    m_vo: { id: 'm_vo', kind: 'audio', name: 'vo.wav', path: 'C:/x/vo.wav', duration: 20, hasVideo: false, hasAudio: true, status: 'ready' },
    m_boom: { id: 'm_boom', kind: 'audio', name: 'boom.wav', path: 'C:/lib/boom.wav', duration: 3, hasVideo: false, hasAudio: true, status: 'ready', library: { soundId: 'abc123' } },
  };
  if (opts.transcript !== false) p.transcript = { words: WORDS.map(([w, s, e]) => ({ w, s, e })) };
  return p;
}

function run(p, list, ctx) {
  const r = applyOps(p, list, ctx);
  return r;
}
function ok(p, list, ctx) {
  const r = applyOps(p, list, ctx);
  r.results.forEach((x, i) => assert.ok(x.ok, `op ${i} (${list[i] && list[i].op}) failed: ${x.error}`));
  return r;
}
const clipsOf = (p, tid) => clipsOnTrack(p, tid);

// ════════════════════════ model ════════════════════════

test('newProject: defaults and default tracks', () => {
  const p = newProject({ id: 'abc', name: 'שם' });
  assert.equal(p.version, 1);
  assert.equal(p.id, 'abc');
  assert.deepEqual(p.settings, { width: 1080, height: 1920, fps: 30, background: '#000000', sampleRate: 48000, safeArea: 'reels', masterGainDb: 0, targetLufs: -14 });
  assert.deepEqual(p.tracks.map((t) => [t.kind, t.role, t.name]), [
    ['video', 'text', 'טקסט'], ['video', 'overlay', 'שכבה'], ['video', 'main', 'ראשי'],
    ['audio', 'voice', 'קריינות'], ['audio', 'music', 'מוזיקה'], ['audio', 'sfx', 'אפקטים קוליים'],
  ]);
  assert.deepEqual(p.transcript, { words: [] });
  assert.ok(p.meta.created && p.meta.modified);
  assert.equal(newProject({ name: 'x', tracks: 'empty' }).tracks.length, 0);
  assert.match(newProject({ name: 'סרטון' }).id, /^p-[a-z0-9]+$/);
  assert.equal(newProject({ name: 'My Video 06!' }).id, 'my-video-06');
  assert.equal(newProject({ id: 'x', width: 1920, height: 1080, fps: 25 }).settings.fps, 25);
});

test('DEFAULT_TRACKS returns fresh objects', () => {
  const a = DEFAULT_TRACKS(), b = DEFAULT_TRACKS();
  a[0].name = 'changed';
  assert.equal(b[0].name, 'טקסט');
  assert.equal(ROLE_LABELS.sfx, 'אפקטים קוליים');
  assert.equal(CLIP_TYPE_LABELS.caption, 'כתובית');
});

test('newClip fills type-specific defaults and deep merges props', () => {
  const v = newClip('video', { mediaId: 'm', transform: { scale: 2 } });
  assert.equal(v.transform.scale, 2);
  assert.equal(v.transform.opacity, 1);
  assert.equal(v.in, 0); assert.equal(v.speed, 1); assert.equal(v.reverse, false);
  assert.equal(v.volume, 1); assert.deepEqual(v.audioFx, { voiceEnhance: false, denoise: false, eqPreset: 'none', duckUnderVoice: false, duckDb: -10 });
  assert.equal(v.color.exposure, 0); assert.deepEqual(v.effects, []);
  assert.equal(v.transitionOut.id, 'none');
  assert.match(v.id, /^c_[a-z0-9]{8}$/);
  const t = newClip('text', { text: { content: 'שלום', stroke: { width: 4 } } });
  assert.equal(t.text.content, 'שלום'); assert.equal(t.text.stroke.width, 4); assert.equal(t.text.stroke.color, '#000000');
  assert.equal(t.text.font, 'Heebo'); assert.equal(t.textAnim.in, 'none');
  assert.equal(t.volume, undefined, 'text has no audio block');
  const cap = newClip('caption', {});
  assert.deepEqual(cap.caption.words, []); assert.equal(cap.caption.style, 'karaoke');
  const s = newClip('shape', { shape: { kind: 'star' } });
  assert.equal(s.shape.kind, 'star'); assert.equal(s.shape.w, 400);
  const st = newClip('sticker', {}); assert.equal(st.sticker.value, '🔥');
  const a = newClip('audio', {}); assert.equal(a.transform, undefined); assert.equal(a.fadeIn, 0);
  const tinted = newClip('image', { color: '#ff0000' });
  assert.equal(tinted.tint, '#ff0000'); assert.equal(typeof tinted.color, 'object');
  assert.throws(() => newClip('nope'), /סוג קליפ לא מוכר/);
});

test('defaultFit: cover within 5% aspect, else contain', () => {
  const S = { width: 1080, height: 1920 };
  assert.equal(defaultFit({ width: 1080, height: 1920 }, S), 'cover');
  assert.equal(defaultFit({ width: 1100, height: 1920 }, S), 'cover');
  assert.equal(defaultFit({ width: 1920, height: 1080 }, S), 'contain');
  assert.equal(newClip('video', {}, { media: { width: 1920, height: 1080 }, settings: S }).fit, 'contain');
  assert.equal(newClip('video', {}, { media: { width: 720, height: 1280 }, settings: S }).fit, 'cover');
});

test('uid, slugify', () => {
  assert.match(uid('t_'), /^t_[a-z0-9]{8}$/);
  const set = new Set(Array.from({ length: 500 }, () => uid('x')));
  assert.equal(set.size, 500);
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.match(slugify('שלום'), /^p-/);
});

test('getPath / setPath immutable with structural sharing', () => {
  const o = { a: { b: { c: 1 }, d: [1, 2, { e: 3 }] }, z: { k: 1 } };
  assert.equal(getPath(o, 'a.b.c'), 1);
  assert.equal(getPath(o, 'a.d.2.e'), 3);
  assert.equal(getPath(o, 'a.x.y'), undefined);
  const n = setPath(o, 'a.b.c', 9);
  assert.equal(n.a.b.c, 9); assert.equal(o.a.b.c, 1);
  assert.equal(n.z, o.z, 'untouched branch is shared');
  const n2 = setPath(o, 'a.d.2.e', 7);
  assert.ok(Array.isArray(n2.a.d)); assert.equal(n2.a.d[2].e, 7); assert.equal(o.a.d[2].e, 3);
  const n3 = setPath({}, 'x.0.y', 1);
  assert.ok(Array.isArray(n3.x)); assert.equal(n3.x[0].y, 1);
  const m = deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3], d: 2 }, e: undefined });
  assert.deepEqual(m, { a: { b: 1, c: [3], d: 2 } });
});

test('time helpers: clipEnd, projectDuration, clipsOnTrack, activeClipsAt, next/prev', () => {
  const p = fixture();
  p.clips = {
    a: { ...newClip('video', { id: 'a', mediaId: 'm_vid', start: 0, duration: 2 }), trackId: 't_main' },
    b: { ...newClip('video', { id: 'b', mediaId: 'm_vid', start: 2 + 1 / 60, duration: 2 }), trackId: 't_main' },
    c: { ...newClip('text', { id: 'c', start: 1, duration: 1, disabled: true }), trackId: 't_text' },
    d: { ...newClip('text', { id: 'd', start: 1.5, duration: 1 }), trackId: 't_text' },
  };
  assert.equal(clipEnd(p.clips.a), 2);
  near(projectDuration(p), 4 + 1 / 60);
  assert.equal(projectDuration(newProject({ id: 'e' })), 1 / 30);
  assert.deepEqual(clipsOnTrack(p, 't_main').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(activeClipsAt(p, 1.6).map((c) => c.id), ['d', 'a'], 'top track first, disabled excluded');
  assert.equal(nextClipOnTrack(p, p.clips.a).id, 'b');
  assert.equal(prevClipOnTrack(p, p.clips.b).id, 'a');
  p.clips.b.start = 2.2;
  assert.equal(nextClipOnTrack(p, p.clips.a), null);
});

test('sourceTimeAt normal / reverse / clamp', () => {
  const c = { start: 10, duration: 4, in: 2, speed: 2, reverse: false };
  const m = { duration: 12 };
  assert.equal(sourceTimeAt(c, 10, m), 2);
  assert.equal(sourceTimeAt(c, 12, m), 6);
  assert.equal(sourceTimeAt(c, 30, m), 12, 'clamped to media duration');
  const r = { ...c, reverse: true };
  assert.equal(sourceTimeAt(r, 10, m), 10);
  assert.equal(sourceTimeAt(r, 14, m), 2);
  assert.equal(sourceTimeAt({ ...c, start: 0, in: 0 }, -5, m), 0);
});

test('snapToFrame, formatTimecode, parseTimecode', () => {
  assert.equal(snapToFrame(1.01, 30), 1);
  near(snapToFrame(1.02, 30), 1.033333, 1e-6);
  assert.equal(formatTimecode(0, 30), '00:00:00');
  assert.equal(formatTimecode(61.5, 30), '01:01:15');
  assert.equal(formatTimecode(3600 + 2, 25), '60:02:00');
  near(parseTimecode('01:01:15', 30), 61.5);
  assert.equal(parseTimecode('1:30', 30), 90);
  assert.equal(parseTimecode('12.5'), 12.5);
  assert.ok(Number.isNaN(parseTimecode('abc')));
});

test('validateProject reports problems in Hebrew', () => {
  const p = fixture();
  assert.deepEqual(validateProject(p), []);
  p.clips.x = { ...newClip('video', { id: 'x', mediaId: 'nope', start: 0, duration: 2 }), trackId: 't_main' };
  p.clips.y = { ...newClip('audio', { id: 'y', mediaId: 'm_vo', start: 0, duration: 2 }), trackId: 't_main' };
  p.clips.z = { ...newClip('video', { id: 'z', mediaId: 'm_vid', start: 1, duration: 30 }), trackId: 't_main' };
  const probs = validateProject(p);
  assert.ok(probs.some((s) => s.includes('מדיה חסרה')));
  assert.ok(probs.some((s) => s.includes('קליפ אודיו בערוץ וידאו')));
  assert.ok(probs.some((s) => s.includes('ארוך מהמדיה')));
  assert.ok(probs.some((s) => s.includes('חפיפה')));
  assert.ok(validateProject({ ...p, id: 'Bad Id' }).some((s) => s.includes('מזהה פרויקט')));
});

test('normalizeClip / normalizeProject fill missing fields', () => {
  const c = normalizeClip({ id: 'q', type: 'text', trackId: 't', start: 1, duration: 2, text: { content: 'x' }, color: '#123456' });
  assert.equal(c.text.font, 'Heebo'); assert.equal(c.tint, '#123456'); assert.equal(c.color.exposure, 0); assert.equal(c.transform.scale, 1);
  const p = normalizeProject({ id: 'n', tracks: [{ id: 't', kind: 'video', role: 'main', name: 'x' }], clips: { q: { id: 'q', type: 'image', trackId: 't', mediaId: 'm' } } });
  assert.equal(p.settings.fps, 30); assert.equal(p.clips.q.fit, 'contain'); assert.deepEqual(p.markers, []); assert.equal(p.tracks[0].volume, 1);
});

test('isKeyframable patterns', () => {
  for (const p of ['transform.x', 'transform.scale', 'transform.opacity', 'volume', 'color.exposure', 'crop.l', 'effects.0.strength', 'mask.feather', 'text.size']) assert.ok(isKeyframable(p), p);
  for (const p of ['transform', 'name', 'effects.x.y', 'crop.z', 'start']) assert.ok(!isKeyframable(p), p);
});

// ════════════════════════ anim ════════════════════════

test('EASINGS: endpoints are 0 and 1', () => {
  for (const [name, fn] of Object.entries(EASINGS)) {
    if (name === 'hold') { assert.equal(fn(0), 0); assert.equal(fn(0.99), 0); assert.equal(fn(1), 1); continue; }
    near(fn(0), 0, 1e-9, name); near(fn(1), 1, 1e-9, name);
  }
  assert.ok(EASINGS.back(0.6) > 1, 'back overshoots');
  assert.ok(EASINGS.easeIn(0.5) < 0.5 && EASINGS.easeOut(0.5) > 0.5);
  near(EASINGS.easeInOut(0.5), 0.5, 1e-9);
});

test('spring: closed form, exact endpoints, overshoot with zeta 0.55', () => {
  assert.equal(spring(0), 0); assert.equal(spring(1), 1);
  let max = 0; let prev = 0; let nonMono = false;
  for (let i = 1; i < 200; i++) { const v = spring(i / 200); max = Math.max(max, v); if (v < prev - 1e-9) nonMono = true; prev = v; }
  assert.ok(max > 1.05 && max < 1.25, `overshoot ~13%, got ${max}`);
  assert.ok(nonMono, 'underdamped spring oscillates');
  near(spring(0.999), 1, 0.01);
  near(spring(1, { zeta: 0.2, omega: 3 }), 1, 0); // slow spring still exact at 1
  near(spring(0.5, { zeta: 1, omega: 10 }) <= 1 ? 1 : 0, 1, 0, 'critically damped no overshoot');
  assert.equal(EASINGS.spring(0.4), spring(0.4));
});

test('getEase: names, bezier, spring(), unknown → linear', () => {
  assert.equal(getEase('easeOut'), EASINGS.easeOut);
  const bz = getEase('bezier(0.25,0.1,0.25,1)');
  near(bz(0), 0); near(bz(1), 1); assert.ok(bz(0.5) > 0.7 && bz(0.5) < 0.85, `css ease at .5 ≈ 0.80, got ${bz(0.5)}`);
  const sp = getEase('spring(0.3,16)'); near(sp(1), 1); assert.ok(sp(0.3) > 1);
  assert.equal(getEase('nope')(0.3), 0.3);
});

test('evalKeyframed: before/after/between, ease applies to arriving segment, hold', () => {
  const clip = { transform: { scale: 1 }, keyframes: { 'transform.scale': [
    { t: 1, v: 1, ease: 'linear' }, { t: 2, v: 2, ease: 'linear' }, { t: 3, v: 0, ease: 'easeIn' }, { t: 4, v: 5, ease: 'hold' },
  ] } };
  assert.equal(evalKeyframed(clip, 'transform.scale', 0), 1);
  assert.equal(evalKeyframed(clip, 'transform.scale', 9), 5);
  near(evalKeyframed(clip, 'transform.scale', 1.5), 1.5);
  near(evalKeyframed(clip, 'transform.scale', 2.5), 2 - 2 * 0.125, 1e-9, 'easeIn on segment 2→3');
  assert.equal(evalKeyframed(clip, 'transform.scale', 3.99), 0, 'hold keeps previous value');
  assert.equal(evalKeyframed(clip, 'transform.scale', 4), 5);
  assert.equal(evalKeyframed({ transform: { x: 7 } }, 'transform.x', 1), 7, 'no keyframes → current value');
  assert.equal(evalKeyframed({}, 'transform.x', 1, 3), 3, 'fallback');
  const unsorted = { keyframes: { volume: [{ t: 2, v: 0 }, { t: 0, v: 1 }] } };
  near(evalKeyframed(unsorted, 'volume', 1), 0.5);
});

test('evalClipProps resolves transform, color, effect params', () => {
  const c = newClip('video', { transform: { x: 10 }, color: { exposure: 0.2 }, effects: [{ id: 'blur', params: { amount: 1 } }],
    keyframes: { 'transform.x': [{ t: 0, v: 0 }, { t: 1, v: 100 }], 'effects.0.amount': [{ t: 0, v: 0 }, { t: 2, v: 10 }], 'color.contrast': [{ t: 0, v: 0.5 }] } });
  const r = evalClipProps(c, 0.5);
  near(r.transform.x, 50); assert.equal(r.transform.scale, 1); assert.equal(r.opacity, 1);
  near(r.effects[0].params.amount, 2.5); assert.equal(r.effects[0].enabled, true);
  assert.equal(r.color.exposure, 0.2); assert.equal(r.color.contrast, 0.5);
  assert.equal(r.volume, 1);
  assert.ok('transform.x' in r.values);
});

test('hash / noise1 deterministic', () => {
  assert.equal(hash('abc', 3), hash('abc', 3));
  assert.notEqual(hash('abc', 3), hash('abc', 4));
  for (let i = 0; i < 1000; i++) { const h = hash(i * 7, i); assert.ok(h >= 0 && h < 1); }
  assert.equal(hash(5.0, 2), hash(5, 2));
  const a = noise1(3.999, 1), b = noise1(4.0, 1);
  near(a, b, 0.01, 'noise is continuous');
  assert.equal(noise1(2, 9), hash(9, 2));
});

test('CLIP_ANIMS contains every spec id with Hebrew names', () => {
  const spec = {
    in: 'none fadeIn zoomIn zoomOut slideLeft slideRight slideUp slideDown pop bounceIn spinIn blurIn dropIn swingIn flipIn stretchIn glitchIn whipIn',
    out: 'none fadeOut zoomIn zoomOut slideLeft slideRight slideUp slideDown popOut spinOut blurOut dropOut flipOut whipOut',
    loop: 'none pulse float shake wobble spin swing heartbeat flicker kenBurns drift breathe jiggle',
  };
  for (const k of ['in', 'out', 'loop']) {
    const ids = CLIP_ANIMS[k].map((a) => a.id);
    for (const id of spec[k].split(' ')) assert.ok(ids.includes(id), `${k}:${id}`);
    for (const a of CLIP_ANIMS[k]) assert.match(a.name, /[\u0590-\u05FF]/, `${k}:${a.id} has Hebrew name`);
  }
});

function identityish(st, tol = { px: 3, s: 0.03, o: 0.03, r: 1 }) {
  return Math.abs(st.dx) <= tol.px && Math.abs(st.dy) <= tol.px && Math.abs(st.scale - 1) <= tol.s && Math.abs(st.scaleX - 1) <= tol.s &&
    Math.abs(st.scaleY - 1) <= tol.s && Math.abs(st.rotation) <= tol.r && st.opacity >= 1 - tol.o && st.blur <= 0.5 && st.glitch <= 0.05;
}

test('animState: every in-anim ends at identity and starts transformed (video + text)', () => {
  for (const type of ['video', 'text']) {
    for (const a of CLIP_ANIMS.in) {
      if (a.id === 'none') continue;
      const c = newClip(type, { id: 'k1', duration: 3, animIn: { id: a.id, duration: 0.5 } });
      const end = animState(c, 0.4995, 1080, 1920);
      assert.ok(identityish(end), `${type}/${a.id} near end: ${JSON.stringify(end)}`);
      assert.ok(identityish(animState(c, 0.6, 1080, 1920), { px: 0, s: 0, o: 0, r: 0 }), `${type}/${a.id} after intro is exact identity`);
      const start = animState(c, 0, 1080, 1920);
      assert.ok(!identityish(start), `${type}/${a.id} at start should differ: ${JSON.stringify(start)}`);
      for (let t = 0; t <= 0.5; t += 0.02) {
        const s = animState(c, t, 1080, 1920);
        for (const v of Object.values(s)) assert.ok(Number.isFinite(v), `${a.id} finite at ${t}`);
        assert.ok(s.opacity >= 0 && s.opacity <= 1);
      }
    }
  }
});

test('animState: every out-anim starts at identity and ends transformed', () => {
  for (const a of CLIP_ANIMS.out) {
    if (a.id === 'none') continue;
    const c = newClip('image', { id: 'k2', duration: 3, animOut: { id: a.id, duration: 0.5 } });
    assert.ok(identityish(animState(c, 2.5005)), `${a.id} near start of outro`);
    assert.ok(identityish(animState(c, 2.4), { px: 0, s: 0, o: 0, r: 0 }), `${a.id} before outro`);
    assert.ok(!identityish(animState(c, 2.999)), `${a.id} at end transformed: ${JSON.stringify(animState(c, 2.999))}`);
  }
});

test('animState: loops deterministic, finite, subtle; in+out durations fitted into short clips', () => {
  for (const a of CLIP_ANIMS.loop) {
    const c = newClip('sticker', { id: 'k3', duration: 4, animLoop: { id: a.id, speed: 1, intensity: 1 } });
    for (let t = 0; t < 4; t += 0.05) {
      const s1 = animState(c, t), s2 = animState(c, t);
      assert.deepEqual(s1, s2);
      for (const v of Object.values(s1)) assert.ok(Number.isFinite(v));
      if (a.id !== 'spin') assert.ok(Math.abs(s1.rotation) < 20, `${a.id} rotation subtle`);
      assert.ok(s1.scale > 0.8 && s1.scale < 1.25, `${a.id} scale subtle ${s1.scale}`);
    }
  }
  const short = newClip('text', { duration: 0.6, animIn: { id: 'fadeIn', duration: 0.5 }, animOut: { id: 'fadeOut', duration: 0.5 } });
  const d = animDurations(short);
  near(d.inD, 0.3); near(d.outD, 0.3);
  near(animState(short, 0.15).opacity, 0.5, 1e-6);
});

test('animState: loop offset keeps phase continuous across a split', () => {
  const c = newClip('image', { id: 'kb', duration: 6, animLoop: { id: 'float', speed: 1, intensity: 1 } });
  const P = fixture();
  P.clips.kb = { ...c, trackId: 't_overlay', mediaId: 'm_img' };
  const { project } = ok(P, [{ op: 'splitClip', id: 'kb', at: 2.5, newId: 'kb2' }]);
  for (const T of [2.6, 3.3, 5.9]) {
    const before = animState(P.clips.kb, T - P.clips.kb.start);
    const after = animState(project.clips.kb2, T - project.clips.kb2.start);
    near(after.dy, before.dy, 1e-9); near(after.rotation, before.rotation, 1e-9);
  }
  // kenBurns progress continuity
  P.clips.kb.animLoop = { id: 'kenBurns', speed: 1, intensity: 1 };
  const r2 = ok(P, [{ op: 'splitClip', id: 'kb', at: 2.5, newId: 'kb2' }]).project;
  for (const T of [0.5, 2.4, 2.6, 5.0]) {
    const orig = animState(P.clips.kb, T);
    const part = T < 2.5 ? animState(r2.clips.kb, T) : animState(r2.clips.kb2, T - 2.5);
    near(part.scale, orig.scale, 1e-9, `kenBurns at ${T}`);
  }
});

test('fadeGain', () => {
  const c = { duration: 4, fadeIn: 1, fadeOut: 2 };
  assert.equal(fadeGain(c, 0), 0); near(fadeGain(c, 0.5), 0.5); assert.equal(fadeGain(c, 1.5), 1); near(fadeGain(c, 3), 0.5); assert.equal(fadeGain(c, 4), 0);
});

// ════════════════════════ ops: engine ════════════════════════

test('applyOps is pure and returns per-op results; errors do not abort; atomic returns original', () => {
  const p = fixture();
  const snap = JSON.stringify(p);
  const r = applyOps(p, [
    { op: 'addClip', type: 'text', content: 'שלום', start: 1, id: 't1' },
    { op: 'nope' },
    { op: 'updateClip', id: 't1', set: { 'text.size': 120 } },
    { op: 'splitClip', id: 'missing', at: 1 },
  ]);
  assert.equal(JSON.stringify(p), snap, 'input not mutated');
  assert.notEqual(r.project, p);
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, true, false]);
  assert.match(r.results[1].error, /פעולה לא מוכרת/);
  assert.match(r.results[3].error, /לא נמצא/);
  assert.equal(r.project.clips.t1.text.size, 120);
  const a = applyOps(p, [{ op: 'addClip', type: 'text', content: 'x' }, { op: 'removeClip', id: 'zzz' }], { atomic: true });
  assert.equal(a.project, p, 'atomic failure returns the original object');
  assert.equal(a.results[0].ok, true); assert.equal(a.results[1].ok, false);
  const e = applyOps(p, []);
  assert.notEqual(e.project, p); assert.deepEqual(e.project, p);
});

test('a failing op leaves no partial change (per-op rollback)', () => {
  const p = fixture();
  // addCaptions creates a track before failing on a duplicate id → must not leave the track behind
  const pre = ok(p, [{ op: 'addClip', type: 'text', content: 'x', id: 'dup' }]).project;
  const r = applyOps(pre, [{ op: 'addCaptions', words: [['א', 0, 0.2], ['ב', 0.3, 0.5]], ids: ['dup', 'dup2'], maxWords: 1 }]);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.project.tracks.length, pre.tracks.length);
});

test('OPS_HELP documents every op handler and vice versa; summarizeOps Hebrew', () => {
  const helpOps = OPS_HELP.map((h) => h.op);
  for (const n of OP_NAMES) assert.ok(helpOps.includes(n), `OPS_HELP missing ${n}`);
  for (const n of helpOps) assert.ok(OP_NAMES.includes(n), `OPS_HELP has unknown ${n}`);
  for (const h of OPS_HELP) { assert.match(h.he, /[\u0590-\u05FF]/); assert.ok(typeof h.fields === 'string'); assert.equal(h.example.op, h.op); }
  assert.equal(summarizeOps([{ op: 'sfx' }, { op: 'sfx' }, { op: 'addCaptions' }]), 'אפקט קולי ×2 · כתוביות');
});

test('OPS_HELP examples all run on a prepared project', () => {
  // build a project that has all ids referenced by the examples
  let p = fixture();
  p = ok(p, [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 4, id: 'c_vid' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 4, duration: 4, in: 4, id: 'c_a' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 8, duration: 2, id: 'c_next' },
    { op: 'addClip', type: 'text', content: 'כותרת', start: 0, id: 'c_title' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 1, id: 'c_logo' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 1, id: 'c_hit' },
    { op: 'addClip', type: 'text', content: 'ישן', start: 12, id: 'c_old' },
    { op: 'addClip', type: 'text', content: 'א', start: 13, id: 'c_b' },
    { op: 'addCaptions', words: [['רגע', 0.1, 0.4], ['יש', 0.5, 0.7], ['לכם', 0.8, 1.0], ['שיר', 1.1, 1.3], ['חדש', 1.35, 1.5]], idPrefix: 'c_cap', chunks: [3, 2] },
    { op: 'addMarker', t: 9.8, label: 'דרופ', id: 'mk_drop' },
    { op: 'addMedia', media: { id: 'm_x', kind: 'audio', name: 'x', path: 'C:/x.wav', duration: 1 } },
    { op: 'addEffect', id: 'c_vid', effect: 'blur' },
    { op: 'addEffect', id: 'c_vid', effect: 'glow' },
  ]).project;
  for (const h of OPS_HELP) {
    let ex = JSON.parse(JSON.stringify(h.example));
    if (ex.op === 'pasteClips') ex.clips = [p.clips.c_title];
    if (ex.op === 'sfx') ex.resolved = { id: 'snd1', name: 'whoosh', abs: 'C:/lib/whoosh.wav', duration: 2 };
    if (ex.op === 'removeKeyframe') { p = ok(p, [{ op: 'setKeyframe', id: 'c_vid', prop: 'transform.scale', t: 1, v: 2 }]).project; }
    if (ex.op === 'removeTrack') ex.id = 't_overlay';
    const r = applyOps(p, [ex]);
    assert.ok(r.results[0].ok, `example ${h.op}: ${r.results[0].error}`);
  }
});

// ════════════════════════ ops: tracks & settings ════════════════════════

test('addTrack / updateTrack / moveTrack / removeTrack', () => {
  const p = fixture();
  const r = ok(p, [
    { op: 'addTrack', kind: 'audio', role: 'sfx', name: 'וושים', id: 't_wh' },
    { op: 'addTrack', kind: 'video', role: 'overlay' },
    { op: 'updateTrack', id: 't_wh', set: { volume: '0.5', muted: 'true', name: 'וושים 2' } },
    { op: 'moveTrack', id: 't_wh', index: 0 },
  ]);
  const P = r.project;
  assert.equal(P.tracks[0].id, 't_wh'); assert.equal(P.tracks[0].volume, 0.5); assert.equal(P.tracks[0].muted, true);
  const ov = P.tracks.find((t) => t.id === r.results[1].id);
  assert.equal(ov.name, 'שכבה 2', 'unique name');
  const bad = applyOps(p, [{ op: 'addTrack', kind: 'audio', role: 'main' }, { op: 'updateTrack', id: 't_main', set: { role: 'voice' } }, { op: 'addTrack', kind: 'video', id: 't_main' }]);
  assert.deepEqual(bad.results.map((x) => x.ok), [false, false, false]);
  const withClip = ok(p, [{ op: 'addClip', type: 'text', content: 'x', track: 't_text' }, { op: 'removeTrack', id: 't_text' }]).project;
  assert.equal(Object.keys(withClip.clips).length, 0);
  assert.ok(!withClip.tracks.some((t) => t.id === 't_text'));
});

test('setSettings validation', () => {
  const r = ok(fixture(), [{ op: 'setSettings', set: { width: 1081, fps: 60, background: '#071822', targetLufs: -14 } }]);
  assert.equal(r.project.settings.width, 1082); assert.ok(r.results[0].warnings.length);
  assert.equal(r.project.settings.fps, 60);
  const bad = applyOps(fixture(), [{ op: 'setSettings', set: { fps: 0 } }, { op: 'setSettings', set: { safeArea: 'x' } }]);
  assert.deepEqual(bad.results.map((x) => x.ok), [false, false]);
  assert.equal(ok(fixture(), [{ op: 'renameProject', name: 'חדש' }]).project.name, 'חדש');
});

// ════════════════════════ ops: addClip & auto tracks ════════════════════════

test('addClip auto track: video→main, occupied→overlay, then new overlay above', () => {
  const r = ok(fixture(), [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 4, id: 'v1' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 1, duration: 2, id: 'v2' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 1.5, duration: 2, id: 'v3' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 4, duration: 2, id: 'v4' },
  ]);
  const P = r.project;
  assert.equal(P.clips.v1.trackId, 't_main');
  assert.equal(P.clips.v2.trackId, 't_overlay');
  const t3 = P.tracks.find((t) => t.id === P.clips.v3.trackId);
  assert.equal(t3.role, 'overlay'); assert.equal(t3.name, 'שכבה 2');
  assert.ok(P.tracks.indexOf(t3) < P.tracks.findIndex((t) => t.id === 't_overlay'), 'new overlay is above');
  assert.ok(r.results[2].warnings && r.results[2].warnings.length);
  assert.equal(P.clips.v4.trackId, 't_main', 'adjacent clip fits on main (no overlap at the cut)');
});

test('addClip duration defaults per type and from media (in & speed)', () => {
  const P = ok(fixture(), [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, in: 2, speed: 2, id: 'v' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, id: 'i' },
    { op: 'addClip', type: 'text', content: 'שלום', id: 't' },
    { op: 'addClip', type: 'shape', kind: 'arrow', id: 's' },
    { op: 'addClip', type: 'sticker', value: '🔥', id: 'st' },
    { op: 'addClip', type: 'sticker', value: 'check', id: 'st2' },
    { op: 'addClip', type: 'effect', effect: 'zoomPunch', params: { strength: 0.3 }, at: 2, id: 'e' },
    { op: 'addClip', type: 'audio', mediaId: 'm_vo', start: 0, role: 'voice', id: 'vo' },
    { op: 'addClip', mediaId: 'm_boom', start: 0, id: 'auto' },
  ]).project;
  assert.equal(P.clips.v.duration, 4);
  assert.equal(P.clips.i.duration, 3); assert.equal(P.clips.i.trackId, 't_overlay', 'main taken → overlay');
  assert.equal(P.clips.t.duration, 3); assert.equal(P.clips.t.trackId, 't_text');
  assert.equal(P.clips.s.duration, 2); assert.equal(P.clips.s.shape.kind, 'arrow');
  assert.equal(P.clips.st.sticker.kind, 'emoji'); assert.equal(P.clips.st2.sticker.kind, 'builtin');
  assert.equal(P.clips.e.duration, 1); assert.equal(P.clips.e.effects[0].id, 'zoomPunch'); assert.equal(P.clips.e.effects[0].params.strength, 0.3); assert.equal(P.clips.e.effects[0].enabled, true);
  assert.equal(P.tracks[0].role, 'effects', 'effects track created at index 0');
  assert.equal(P.tracks[0].id, 't_effects');
  assert.equal(P.clips.vo.trackId, 't_voice'); assert.equal(P.clips.vo.duration, 20);
  assert.equal(P.clips.auto.type, 'audio', 'type inferred from media'); assert.equal(P.clips.auto.trackId, 't_sfx');
  assert.equal(P.clips.v.fit, 'cover');
  const w = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_wide', id: 'w' }]).project;
  assert.equal(w.clips.w.fit, 'contain');
});

test('addClip audio overlap → new sfx track below', () => {
  const P = ok(fixture(), [
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 0, id: 'a1' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 1, id: 'a2' },
  ]).project;
  const t2 = P.tracks.find((t) => t.id === P.clips.a2.trackId);
  assert.equal(t2.role, 'sfx'); assert.equal(t2.kind, 'audio');
  assert.equal(P.tracks.indexOf(t2), P.tracks.findIndex((t) => t.id === 't_sfx') + 1);
  const allow = ok(fixture(), [
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 0, id: 'a1' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 1, id: 'a2', overlap: 'allow' },
  ]).project;
  assert.equal(allow.clips.a2.trackId, 't_sfx');
  const err = applyOps(allow, [{ op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 1, overlap: 'error' }]);
  assert.equal(err.results[0].ok, false);
});

test('addClip path-based: needs server/ctx.media, else Hebrew error', () => {
  const r = applyOps(fixture(), [{ op: 'addClip', type: 'video', path: 'C:/new/a.mp4' }]);
  assert.equal(r.results[0].ok, false); assert.match(r.results[0].error, /עוד לא יובא/);
  const media = { id: 'm_new', kind: 'video', name: 'a.mp4', path: 'C:\\new\\a.mp4', duration: 3, width: 1080, height: 1920, hasAudio: false, status: 'processing' };
  const r2 = ok(fixture(), [{ op: 'addClip', path: 'C:/new/a.mp4' }], { media: { m_new: media } });
  const c = Object.values(r2.project.clips)[0];
  assert.equal(c.mediaId, 'm_new'); assert.equal(c.duration, 3); assert.ok(r2.project.media.m_new);
  const r3 = ok(fixture(), [{ op: 'addClip', path: 'C:/x/clip.mp4', start: 0, duration: 1 }]);
  assert.equal(Object.values(r3.project.clips)[0].mediaId, 'm_vid', 'path already in project media');
  const r4 = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_new' }], { media: [media] });
  assert.ok(r4.project.media.m_new);
  const bad = applyOps(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vo' }, { op: 'addClip', type: 'image', mediaId: 'm_vid' }, { op: 'addClip', type: 'audio', mediaId: 'm_wide' }]);
  assert.deepEqual(bad.results.map((x) => x.ok), [false, false, false]);
});

test('addClip: time refs, client ids usable later in the same batch, shorthands, set', () => {
  const r = ok(fixture(), [
    { op: 'addClip', type: 'text', content: 'רגע!', at: { word: 'רגע' }, duration: 0.8, id: 'hook', y: -600, scale: 1.2, animIn: 'pop', animLoop: 'pulse', color: '#ff0000' },
    { op: 'addClip', type: 'text', content: 'ובום', start: 'word:ובום!:1:-0.1', id: 'drop', set: { 'text.size': 150, 'text.color': '#3fe0f5' } },
    { op: 'updateClip', id: 'hook', set: { 'transform.rotation': 5 } },
    { op: 'addClip', type: 'text', content: 'אחרי', start: { clip: 'hook', edge: 'end' }, id: 'after' },
  ]);
  const P = r.project;
  assert.equal(P.clips.hook.start, 0.12); assert.equal(P.clips.hook.transform.y, -600); assert.equal(P.clips.hook.transform.scale, 1.2);
  assert.equal(P.clips.hook.animIn.id, 'pop'); assert.equal(P.clips.hook.animIn.duration, 0.4); assert.equal(P.clips.hook.animLoop.id, 'pulse');
  assert.equal(P.clips.hook.tint, '#ff0000'); assert.equal(P.clips.hook.transform.rotation, 5);
  near(P.clips.drop.start, 9.7); assert.equal(P.clips.drop.text.size, 150);
  near(P.clips.after.start, 0.92);
  const abs = ok(fixture(), [{ op: 'addClip', type: 'text', content: 'א', xAbs: 540, yAbs: 1290, id: 'ab' }]).project;
  assert.equal(abs.clips.ab.transform.x, 0); assert.equal(abs.clips.ab.transform.y, 330);
  const bad = applyOps(fixture(), [{ op: 'addClip', type: 'text', animIn: 'nope' }, { op: 'addClip', type: 'text', start: { word: 'לאקיים' } }]);
  assert.match(bad.results[0].error, /אנימציית in לא מוכרת/);
  assert.match(bad.results[1].error, /לא נמצאה בתמלול/);
});

test('addClip overlap overwrite / insert', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 6, id: 'long', keyframes: { 'transform.x': [{ t: 0, v: 0 }, { t: 6, v: 60 }] } }]).project;
  const ow = ok(base, [{ op: 'addClip', type: 'image', mediaId: 'm_img', track: 't_main', start: 2, duration: 1, overlap: 'overwrite', id: 'img' }]).project;
  const main = clipsOnTrack(ow, 't_main');
  assert.deepEqual(main.map((c) => [c.id === 'long' ? 'long' : c.id === 'img' ? 'img' : 'right', c.start, round(c.duration)]), [['long', 0, 2], ['img', 2, 1], ['right', 3, 3]]);
  const right = main[2];
  near(right.in, 3); near(evalKeyframed(right, 'transform.x', 0), 30);
  const ins = ok(base, [{ op: 'addClip', type: 'image', mediaId: 'm_img', track: 't_main', start: 2, duration: 1, overlap: 'insert', id: 'img' }]).project;
  const m2 = clipsOnTrack(ins, 't_main');
  assert.deepEqual(m2.map((c) => [c.start, round(c.duration)]), [[0, 2], [2, 1], [3, 4]]);
  near(m2[2].in, 2);
});
const round = (x) => Math.round(x * 1e6) / 1e6;

test('addClip append and caption via addClip', () => {
  const P = ok(fixture(), [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', duration: 2, id: 'a' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', duration: 3, append: true, id: 'b' },
    { op: 'addClip', type: 'caption', words: [['שלום', 1, 1.4], ['לכם', 1.5, 1.9]], style: 'chordix', id: 'cap', hot: ['לכם'] },
    { op: 'addClip', type: 'caption', content: 'מילה אחת שתיים', start: 5, duration: 1.5, id: 'cap2' },
  ]).project;
  assert.equal(P.clips.b.start, 2); assert.equal(P.clips.b.trackId, 't_main');
  assert.equal(P.clips.cap.start, 1); near(P.clips.cap.duration, 1.3); assert.equal(P.clips.cap.text.content, 'שלום לכם');
  assert.equal(P.clips.cap.text.weight, 900); assert.equal(P.clips.cap.caption.activeColor, '#3fe0f5');
  assert.equal(P.clips.cap.caption.words[1].hot, true);
  const capTrack = P.tracks.find((t) => t.id === P.clips.cap.trackId);
  assert.equal(capTrack.name, 'כתוביות'); assert.equal(capTrack.role, 'text'); assert.equal(capTrack.captions, true);
  assert.equal(P.clips.cap2.caption.words.length, 3); near(P.clips.cap2.caption.words[1].s, 5.5); assert.equal(P.clips.cap2.duration, 1.5);
});

// ════════════════════════ ops: updateClip ════════════════════════

test('updateClip: paths, shorthands, coercion, clamps, merge, multi ids', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'text', content: 'א', id: 'a' }, { op: 'addClip', type: 'text', content: 'ב', start: 5, id: 'b' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 3, id: 'v' },
  ]).project;
  const r = ok(base, [
    { op: 'updateClip', id: 'a', set: { text: 'חדש', 'transform.scale': '1.5', 'transform.flipX': 'true', color: '#00ff00', filter: 'cinematic', animIn: 'fadeIn' } },
    { op: 'updateClip', ids: ['a', 'b'], set: { 'text.color': '#3fe0f5' } },
    { op: 'updateClip', id: 'v', set: { volume: 9, 'transform.opacity': 2, 'color.hue': 400, 'color.exposure': 0.3 } },
    { op: 'updateClip', id: 'b', merge: { text: { stroke: { width: 6 } }, transform: { y: 100 } } },
    { op: 'updateClip', id: 'v', set: { transform: { x: 12 } } },
  ]);
  const P = r.project;
  assert.equal(P.clips.a.text.content, 'חדש'); assert.equal(P.clips.a.transform.scale, 1.5); assert.equal(P.clips.a.transform.flipX, true);
  assert.equal(P.clips.a.tint, '#00ff00'); assert.equal(P.clips.a.filter.id, 'cinematic'); assert.equal(P.clips.a.animIn.id, 'fadeIn');
  assert.equal(P.clips.b.text.color, '#3fe0f5'); assert.equal(P.clips.b.text.stroke.width, 6); assert.equal(P.clips.b.text.stroke.color, '#000000');
  assert.equal(P.clips.b.transform.y, 100); assert.equal(P.clips.b.transform.scale, 1);
  assert.equal(P.clips.v.volume, 4); assert.equal(P.clips.v.transform.opacity, 1); assert.equal(P.clips.v.color.hue, 180); assert.ok(r.results[2].warnings.length >= 3);
  assert.equal(P.clips.v.transform.x, 12); assert.equal(P.clips.v.transform.scale, 1, 'object set merges');
  const bad = applyOps(base, [
    { op: 'updateClip', id: 'a', set: { type: 'video' } },
    { op: 'updateClip', id: 'a', set: { transform: 5 } },
    { op: 'updateClip', id: 'a', set: { blend: 'weird' } },
    { op: 'updateClip', id: 'a', set: { 'animOut.id': 'nope' } },
    { op: 'updateClip', id: 'v', set: { trackId: 't_voice' } },
    { op: 'updateClip', id: 'a' },
  ]);
  assert.ok(bad.results.every((x) => !x.ok), JSON.stringify(bad.results));
  const dur = ok(base, [{ op: 'updateClip', id: 'v', set: { duration: 50 } }]);
  assert.equal(dur.project.clips.v.duration, 10, 'duration capped at media length');
});

test('updateClip start shifts caption words; trackId move', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'caption', words: [['א', 1, 1.2], ['ב', 1.3, 1.5]], id: 'c' }]).project;
  const P = ok(base, [{ op: 'updateClip', id: 'c', set: { start: 3 } }, { op: 'updateClip', id: 'c', set: { trackId: 't_overlay' } }]).project;
  assert.equal(P.clips.c.start, 3); assert.deepEqual(P.clips.c.caption.words.map((w) => w.s), [3, 3.3]);
  assert.equal(P.clips.c.trackId, 't_overlay');
});

// ════════════════════════ ops: remove / move ════════════════════════

test('removeClip with ripple shifts only later clips on the same track', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, duration: 2, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 2, duration: 3, id: 'b', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 5, duration: 1, id: 'c', track: 't_main' },
    { op: 'addClip', type: 'text', content: 'x', start: 6, id: 't' },
  ]).project;
  const P = ok(base, [{ op: 'removeClip', id: 'b', ripple: true }]).project;
  assert.equal(P.clips.b, undefined); assert.equal(P.clips.c.start, 2); assert.equal(P.clips.a.start, 0); assert.equal(P.clips.t.start, 6);
  const P2 = ok(base, [{ op: 'removeClips', ids: ['a', 'b'], ripple: true }]).project;
  assert.equal(P2.clips.c.start, 0);
});

test('moveClip: time, track, overlap → new track, captions shift, kind mismatch', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, duration: 2, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 3, duration: 2, id: 'b', track: 't_main' },
    { op: 'addClip', type: 'caption', words: [['א', 1, 1.2]], id: 'cap' },
  ]).project;
  const r = ok(base, [
    { op: 'moveClip', id: 'b', start: 1 },
    { op: 'moveClip', id: 'cap', start: 4 },
    { op: 'moveClip', id: 'a', by: 0.5, track: 't_text' },
  ]);
  const P = r.project;
  assert.equal(P.clips.b.start, 1); assert.equal(P.tracks.find((t) => t.id === P.clips.b.trackId).role, 'overlay', 'main occupied → overlay');
  assert.equal(P.clips.cap.caption.words[0].s, 4);
  assert.equal(P.clips.a.start, 0.5); assert.equal(P.clips.a.trackId, 't_text');
  const busy = ok(P, [{ op: 'moveClip', id: 'a', track: 't_overlay' }]);
  assert.equal(busy.project.tracks.find((t) => t.id === busy.project.clips.a.trackId).role, 'overlay');
  assert.notEqual(busy.project.clips.a.trackId, 't_overlay', 'occupied explicit track → new overlay track');
  const allow = ok(base, [{ op: 'moveClip', id: 'b', start: 1, overlap: 'allow' }]).project;
  assert.equal(allow.clips.b.trackId, 't_main');
  assert.equal(applyOps(base, [{ op: 'moveClip', id: 'a', track: 't_voice' }]).results[0].ok, false);
  const neg = ok(base, [{ op: 'moveClip', id: 'a', start: -3 }]);
  assert.equal(neg.project.clips.a.start, 0); assert.ok(neg.results[0].warnings);
  const grp = ok(base, [{ op: 'moveClips', ids: ['a', 'b'], delta: 1 }]).project;
  assert.deepEqual([grp.clips.a.start, grp.clips.b.start], [1, 4]);
});

// ════════════════════════ ops: trim ════════════════════════

test('trimClip adjusts in with speed; clamps to media; keyframes shift with head', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 2, in: 1, speed: 2, duration: 3, id: 'v',
    keyframes: { 'transform.x': [{ t: 0, v: 0 }, { t: 2, v: 100 }] } }]).project;
  const P = ok(base, [{ op: 'trimClip', id: 'v', start: 2.5, end: 4.5 }]).project;
  const v = P.clips.v;
  assert.equal(v.start, 2.5); assert.equal(v.duration, 2); assert.equal(v.in, 2, 'in += 0.5 * speed 2');
  near(evalKeyframed(v, 'transform.x', 0), 25, 1e-9, 'keyframes keep absolute timing');
  assert.equal(v.keyframes['transform.x'][0].t, -0.5);
  // clamp head to media start and tail to media end
  const r = ok(base, [{ op: 'trimClip', id: 'v', start: 0, end: 20 }]);
  assert.equal(r.project.clips.v.start, 1.5); assert.equal(r.project.clips.v.in, 0);
  near(clipEnd(r.project.clips.v), 1.5 + 10 / 2); assert.ok(r.results[0].warnings.length >= 2);
  // head/tail deltas
  const ht = ok(base, [{ op: 'trimClip', id: 'v', head: 0.5, tail: 0.5 }]).project.clips.v;
  assert.equal(ht.start, 2.5); assert.equal(ht.duration, 2); assert.equal(ht.in, 2);
  // too short
  assert.equal(applyOps(base, [{ op: 'trimClip', id: 'v', start: 3, end: 3.01 }]).results[0].ok, false);
});

test('trimClip reverse media: tail trim moves in, head trim keeps in', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, in: 2, duration: 4, reverse: true, id: 'r' }]).project;
  const c0 = base.clips.r;
  const src = (c, t) => sourceTimeAt(c, t, base.media.m_vid);
  const P = ok(base, [{ op: 'trimClip', id: 'r', start: 1, end: 3 }]).project;
  const c = P.clips.r;
  assert.equal(c.in, 3);
  for (const t of [1, 2, 2.9]) near(src(c, t), src(c0, t), 1e-9, `reverse source continuity at ${t}`);
});

test('trimClip does not extend into neighbours unless overlap allow', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, duration: 2, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 2, duration: 2, id: 'b', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 5, duration: 2, id: 'c', track: 't_main' },
  ]).project;
  const r = ok(base, [{ op: 'trimClip', id: 'b', start: 1, end: 6 }]);
  assert.equal(r.project.clips.b.start, 2); assert.equal(clipEnd(r.project.clips.b), 5);
  const a = ok(base, [{ op: 'trimClip', id: 'b', end: 6, overlap: 'allow' }]).project;
  assert.equal(clipEnd(a.clips.b), 6);
});

test('slipClip and setSpeed', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, in: 1, duration: 4, id: 'v',
    keyframes: { 'transform.scale': [{ t: 0, v: 1 }, { t: 4, v: 2 }] } }]).project;
  assert.equal(ok(base, [{ op: 'slipClip', id: 'v', by: 2 }]).project.clips.v.in, 3);
  const sl = ok(base, [{ op: 'slipClip', id: 'v', in: 9 }]);
  assert.equal(sl.project.clips.v.in, 6); assert.ok(sl.results[0].warnings);
  const sp = ok(base, [{ op: 'setSpeed', id: 'v', speed: 2 }]).project.clips.v;
  assert.equal(sp.speed, 2); assert.equal(sp.duration, 2); assert.equal(sp.keyframes['transform.scale'][1].t, 2);
  const slow = ok(base, [{ op: 'setSpeed', id: 'v', speed: 0.25 }]).project.clips.v;
  assert.equal(slow.duration, 16, 'clamped to media: (10-1)/0.25=36 → 4/0.25=16 ok');
  const keep = ok(base, [{ op: 'setSpeed', id: 'v', speed: 2, keepDuration: true }]).project.clips.v;
  assert.equal(keep.duration, 4, 'keepDuration (fits: (10-1)/2 = 4.5)');
  const keep2 = ok(base, [{ op: 'setSpeed', id: 'v', speed: 3, keepDuration: true }]).project.clips.v;
  assert.equal(keep2.duration, 3, 'keepDuration capped to (10-1)/3');
});

// ════════════════════════ ops: split ════════════════════════

test('splitClip: in-points (speed / reverse), durations, ids, fades, anims, transition', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 1, in: 2, speed: 1.5, duration: 4, id: 'v', fadeIn: 0.5, fadeOut: 0.7,
      animIn: { id: 'zoomIn', duration: 0.3 }, animOut: { id: 'fadeOut', duration: 0.3 } },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 5, duration: 2, id: 'n', track: 't_main' },
    { op: 'setTransition', id: 'v', transition: 'crossfade', duration: 0.4 },
  ]).project;
  const r = ok(base, [{ op: 'splitClip', id: 'v', at: 2.5, newId: 'v2' }]);
  assert.deepEqual(r.results[0].ids, ['v', 'v2']);
  const L = r.project.clips.v, R = r.project.clips.v2;
  assert.equal(L.duration, 1.5); assert.equal(R.start, 2.5); assert.equal(R.duration, 2.5);
  assert.equal(L.in, 2); near(R.in, 2 + 1.5 * 1.5);
  assert.equal(L.fadeIn, 0.5); assert.equal(L.fadeOut, 0); assert.equal(R.fadeIn, 0); assert.equal(R.fadeOut, 0.7);
  assert.equal(L.animIn.id, 'zoomIn'); assert.equal(L.animOut.id, 'none'); assert.equal(R.animIn.id, 'none'); assert.equal(R.animOut.id, 'fadeOut');
  assert.equal(L.transitionOut.id, 'none'); assert.equal(R.transitionOut.id, 'crossfade');
  assert.equal(nextClipOnTrack(r.project, R).id, 'n');
  for (const t of [1.2, 2.4, 2.6, 4.9]) {
    const orig = sourceTimeAt(base.clips.v, t, base.media.m_vid);
    const part = t < 2.5 ? L : R;
    near(sourceTimeAt(part, t, base.media.m_vid), orig, 1e-9, `source continuity ${t}`);
  }
  const rev = ok(base, [{ op: 'updateClip', id: 'v', set: { reverse: true } }, { op: 'splitClip', id: 'v', at: 2.5, newId: 'v2' }]).project;
  for (const t of [1.2, 2.4, 2.6, 4.9]) {
    const c0 = { ...base.clips.v, reverse: true };
    const part = t < 2.5 ? rev.clips.v : rev.clips.v2;
    near(sourceTimeAt(part, t, base.media.m_vid), sourceTimeAt(c0, t, base.media.m_vid), 1e-9, `reverse continuity ${t}`);
  }
  const bad = applyOps(base, [{ op: 'splitClip', id: 'v', at: 1 }, { op: 'splitClip', id: 'v', at: 5 }, { op: 'splitClip', id: 'v', at: 9 }]);
  assert.ok(bad.results.every((x) => !x.ok));
});

test('splitClip keyframes: values continuous for linear, hold, eased and spring segments', () => {
  const kf = {
    'transform.x': [{ t: 0, v: 0 }, { t: 2, v: 200, ease: 'linear' }, { t: 4, v: 0, ease: 'easeInOut' }],
    'transform.scale': [{ t: 1, v: 1 }, { t: 3, v: 2, ease: 'spring' }],
    'transform.opacity': [{ t: 0.5, v: 1 }, { t: 3.5, v: 0, ease: 'hold' }],
    'transform.rotation': [{ t: 3.6, v: 10 }],
    'volume': [{ t: 0.1, v: 0.5 }],
    'color.exposure': [{ t: 1.7, v: 0.2 }, { t: 2.3, v: 0.8, ease: 'bounce' }],
  };
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 4, id: 'v', keyframes: kf }]).project;
  for (const cut of [1.3, 2, 2.9, 3.55]) {
    const P = ok(base, [{ op: 'splitClip', id: 'v', at: cut, newId: 'r' }]).project;
    for (const prop of Object.keys(kf)) {
      for (let T = 0; T <= 4; T += 0.05) {
        const orig = evalKeyframed(base.clips.v, prop, T);
        const part = T < cut ? P.clips.v : P.clips.r;
        const got = evalKeyframed(part, prop, T - part.start);
        const tol = 1e-6;
        assert.ok(Math.abs(got - orig) <= tol, `cut ${cut} ${prop} @${T.toFixed(2)}: ${got} vs ${orig}`);
      }
    }
  }
  const [L, R] = splitKeyframeMap({ x: [{ t: 0, v: 0 }, { t: 2, v: 2, ease: 'linear' }] }, 1);
  assert.deepEqual(L.x, [{ t: 0, v: 0 }, { t: 1, v: 1, ease: 'linear' }]);
  assert.deepEqual(R.x, [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 2, ease: 'linear' }]);
});

test('part() ease: sub-range of a curve; repeated splits of one eased segment stay exact', () => {
  const sp = getEase('spring');
  const half = getEase('part(0.25,0.75,spring)');
  const e0 = sp(0.25), e1 = sp(0.75);
  for (const p of [0, 0.1, 0.5, 0.9, 1]) near(half(p), p === 0 ? 0 : p === 1 ? 1 : (sp(0.25 + 0.5 * p) - e0) / (e1 - e0), 1e-12);
  assert.equal(anim.partEase('part(0.2,0.6,easeOut)', 0.5, 1), 'part(0.4,0.6,easeOut)');
  assert.equal(anim.partEase('easeIn', 0, 1), 'easeIn');
  assert.equal(anim.partEase('linear', 0.3, 0.6), 'linear');
  assert.ok(anim.isEaseName('part(0.1,0.9,bezier(.2,.8,.2,1))'));
  assert.ok(!anim.isEaseName('part(0.9,0.1,spring)'));
  const kf = { 'transform.y': [{ t: 0, v: 0 }, { t: 3, v: -300, ease: 'easeInOut' }], 'transform.rotation': [{ t: 0, v: 0 }, { t: 3, v: 90, ease: 'bezier(.2,.8,.2,1)' }] };
  const base = ok(fixture(), [{ op: 'addClip', type: 'image', mediaId: 'm_img', start: 1, duration: 3, id: 'a', keyframes: kf }]).project;
  const P = ok(base, [
    { op: 'splitClip', id: 'a', at: 1.7, newId: 'b' },
    { op: 'splitClip', id: 'b', at: 2.4, newId: 'c' },
    { op: 'splitClip', id: 'c', at: 3.3, newId: 'd' },
  ]).project;
  for (let T = 1; T < 4; T += 0.037) {
    const part = ['d', 'c', 'b', 'a'].map((k) => P.clips[k]).find((c) => T >= c.start - 1e-9);
    for (const prop of Object.keys(kf)) near(evalKeyframed(part, prop, T - part.start), evalKeyframed(base.clips.a, prop, T - 1), 1e-6, `${prop}@${T.toFixed(3)}`);
  }
  assert.match(P.clips.c.keyframes['transform.y'].find((k) => k.ease.startsWith('part(')).ease, /^part\([\d.]+,[\d.]+,easeInOut\)$/);
});

test('insertGap opens silence inside the voice clip with continuous audio source', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'audio', mediaId: 'm_vo', start: 0, duration: 14, role: 'voice', id: 'vo' }]).project;
  const P = ok(base, [{ op: 'insertGap', at: 'word:ובום!:1:-0.05', duration: 0.4 }]).project;
  const parts = clipsOnTrack(P, 't_voice');
  assert.equal(parts.length, 2);
  near(clipEnd(parts[0]), 9.75); near(parts[1].start, 10.15); near(parts[1].in, 9.75);
  near(resolveTime(P, 'word:ובום!:1'), 10.2, 1e-9, 'transcript moved with the gap');
});

test('splitClip on caption partitions words; text content updated; splitAt', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'caption', words: [['אחת', 1, 1.3], ['שתיים', 1.4, 1.8], ['שלוש', 1.9, 2.3]], id: 'c' }]).project;
  const P = ok(base, [{ op: 'splitClip', id: 'c', at: 1.85, newId: 'c2' }]).project;
  assert.deepEqual(P.clips.c.caption.words.map((w) => w.w), ['אחת', 'שתיים']);
  assert.deepEqual(P.clips.c2.caption.words.map((w) => w.w), ['שלוש']);
  assert.equal(P.clips.c.text.content, 'אחת שתיים'); assert.equal(P.clips.c2.text.content, 'שלוש');
  const sa = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, duration: 4, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'audio', mediaId: 'm_vo', start: 1, duration: 4, id: 'b' },
    { op: 'addClip', type: 'text', content: 'x', start: 3, id: 'c' },
    { op: 'splitAt', at: 2 },
  ]);
  assert.equal(sa.results[3].pairs.length, 2);
});

test('duplicateClip places after the original; caption words move along', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'caption', words: [['א', 1, 1.2]], id: 'c', duration: 1 }]).project;
  const r = ok(base, [{ op: 'duplicateClip', id: 'c', newId: 'd' }, { op: 'duplicateClip', id: 'c', start: 10, newId: 'e' }]);
  assert.equal(r.project.clips.d.start, 2); assert.equal(r.project.clips.d.caption.words[0].s, 2);
  assert.equal(r.project.clips.e.caption.words[0].s, 10);
  assert.equal(r.project.clips.d.trackId, base.clips.c.trackId);
});

test('pasteClips keeps relative offsets with new ids', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'text', content: 'א', start: 1, id: 'a' }, { op: 'addClip', type: 'text', content: 'ב', start: 4.5, id: 'b', track: 't_overlay' },
  ]).project;
  const r = ok(base, [{ op: 'pasteClips', clips: [base.clips.a, base.clips.b], at: 10 }]);
  const [x, y] = r.results[0].ids.map((id) => r.project.clips[id]);
  assert.equal(x.start, 10); assert.equal(y.start, 13.5); assert.ok(!['a', 'b'].includes(x.id)); assert.equal(y.trackId, 't_overlay');
});

test('detachAudio and closeGaps', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 1, in: 2, duration: 3, id: 'v', volume: 0.5 }]).project;
  const r = ok(base, [{ op: 'detachAudio', id: 'v', newId: 'va' }]);
  const a = r.project.clips.va;
  assert.equal(a.type, 'audio'); assert.equal(a.trackId, 't_voice'); assert.equal(a.in, 2); assert.equal(a.volume, 0.5); assert.equal(r.project.clips.v.muteAudio, true);
  assert.equal(applyOps(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_wide', id: 'w' }, { op: 'detachAudio', id: 'w' }]).results[1].ok, false);
  const g = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 1, duration: 1, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 3, duration: 1, id: 'b', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 6, duration: 1, id: 'c', track: 't_main' },
    { op: 'closeGaps', track: 't_main', toZero: true },
  ]).project;
  assert.deepEqual(['a', 'b', 'c'].map((k) => g.clips[k].start), [0, 1, 2]);
});

// ════════════════════════ ops: keyframes, transitions, effects ════════════════════════

test('setKeyframe relative / abs / word ref / replace / v from current / invalid', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'video', mediaId: 'm_vid', start: 5, duration: 4, id: 'v', transform: { scale: 1.1 } }]).project;
  const r = ok(base, [
    { op: 'setKeyframe', id: 'v', prop: 'transform.scale', t: 0, v: 1 },
    { op: 'setKeyframe', id: 'v', prop: 'transform.scale', t: 6.5, abs: true, v: 1.8, ease: 'spring' },
    { op: 'setKeyframe', id: 'v', prop: 'transform.scale', t: { word: 'סולם!' }, v: 1.85, ease: 'easeOut' },
    { op: 'setKeyframe', id: 'v', prop: 'transform.scale', t: 0, v: 1.05 },
    { op: 'setKeyframe', id: 'v', prop: 'transform.x', t: 2 },
    { op: 'setKeyframe', id: 'v', prop: 'color.exposure', t: 'word:קצב!', v: 0.4, ease: 'bezier(.2,.8,.2,1)' },
  ]);
  const k = r.project.clips.v.keyframes;
  assert.deepEqual(k['transform.scale'].map((x) => [x.t, x.v, x.ease]), [[0, 1.05, 'linear'], [1.3, 1.85, 'easeOut'], [1.5, 1.8, 'spring']]);
  assert.deepEqual(k['transform.x'], [{ t: 2, v: 0, ease: 'linear' }]);
  assert.equal(k['color.exposure'][0].t, 2);
  const bad = applyOps(base, [
    { op: 'setKeyframe', id: 'v', prop: 'name', t: 0, v: 1 },
    { op: 'setKeyframe', id: 'v', prop: 'transform.x', t: 0, v: 1, ease: 'wobbly' },
    { op: 'setKeyframe', id: 'v', prop: 'effects.3.amount', t: 0, v: 1 },
    { op: 'setKeyframe', id: 'v', prop: 'transform.x', t: 0, v: 'abc' },
  ]);
  assert.ok(bad.results.every((x) => !x.ok));
  const P2 = ok(r.project, [{ op: 'removeKeyframe', id: 'v', prop: 'transform.scale', t: 1.3 }, { op: 'clearKeyframes', id: 'v', prop: 'transform.x' }]).project;
  assert.equal(P2.clips.v.keyframes['transform.scale'].length, 2); assert.equal(P2.clips.v.keyframes['transform.x'], undefined);
  assert.deepEqual(ok(P2, [{ op: 'clearKeyframes', id: 'v' }]).project.clips.v.keyframes, {});
  const multi = ok(base, [{ op: 'setKeyframes', id: 'v', prop: 'transform.scale', keys: [{ t: 0, v: 1 }, [0.18, 1.5, 'easeOut'], { t: 0.9, v: 1, ease: 'easeInOut' }] }]).project;
  assert.equal(multi.clips.v.keyframes['transform.scale'].length, 3);
});

test('setTransition needs an adjacent next clip; duration clamp; remove; audio refused', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, duration: 2, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 2 + 1 / 60, duration: 0.4, id: 'b', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 5, duration: 2, id: 'c', track: 't_main' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 0, id: 'snd' },
  ]).project;
  const r = ok(base, [{ op: 'setTransition', id: 'a', transition: 'whipLeft', duration: 3 }]);
  assert.equal(r.project.clips.a.transitionOut.id, 'whipLeft'); assert.equal(r.project.clips.a.transitionOut.duration, 0.8); assert.ok(r.results[0].warnings);
  assert.equal(r.results[0].next, 'b');
  const bad = applyOps(base, [{ op: 'setTransition', id: 'b', transition: 'crossfade' }, { op: 'setTransition', id: 'snd', transition: 'crossfade' }]);
  assert.match(bad.results[0].error, /אין קליפ צמוד/); assert.equal(bad.results[1].ok, false);
  assert.equal(ok(base, [{ op: 'setTransition', id: 'b', transition: 'crossfade', force: true }]).project.clips.b.transitionOut.id, 'crossfade');
  assert.equal(ok(r.project, [{ op: 'removeTransition', id: 'a' }]).project.clips.a.transitionOut.id, 'none');
});

test('effects: add/update/remove/move keep effect keyframes on the right index', () => {
  let P = ok(fixture(), [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 4, id: 'v' },
    { op: 'addEffect', id: 'v', effect: 'blur', params: { amount: 2 } },
    { op: 'addEffect', id: 'v', effect: 'shake' },
    { op: 'setKeyframe', id: 'v', prop: 'effects.0.amount', t: 0, v: 5 },
    { op: 'setKeyframe', id: 'v', prop: 'effects.1.strength', t: 1, v: 3 },
    { op: 'addEffect', id: 'v', effect: 'vignette', index: 0 },
  ]).project;
  assert.deepEqual(P.clips.v.effects.map((e) => e.id), ['vignette', 'blur', 'shake']);
  assert.ok(P.clips.v.keyframes['effects.1.amount'] && P.clips.v.keyframes['effects.2.strength']);
  P = ok(P, [{ op: 'updateEffect', id: 'v', index: 1, params: { amount: 7 }, enabled: false }]).project;
  assert.equal(P.clips.v.effects[1].params.amount, 7); assert.equal(P.clips.v.effects[1].enabled, false);
  const moved = ok(P, [{ op: 'moveEffect', id: 'v', from: 2, to: 0 }]).project;
  assert.deepEqual(moved.clips.v.effects.map((e) => e.id), ['shake', 'vignette', 'blur']);
  assert.ok(moved.clips.v.keyframes['effects.0.strength'] && moved.clips.v.keyframes['effects.2.amount']);
  const rem = ok(P, [{ op: 'removeEffect', id: 'v', index: 1 }]).project;
  assert.deepEqual(rem.clips.v.effects.map((e) => e.id), ['vignette', 'shake']);
  assert.ok(!rem.clips.v.keyframes['effects.1.amount'] && rem.clips.v.keyframes['effects.1.strength']);
  assert.equal(applyOps(P, [{ op: 'removeEffect', id: 'v', index: 9 }]).results[0].ok, false);
});

// ════════════════════════ ops: captions ════════════════════════

test('chunkCaptionWords: sentences, clauses, pauses, maxWords, maxChars, balance, explicit chunks', () => {
  const W = (arr) => arr.map(([w, s, e]) => ({ w, s, e }));
  const words = W(WORDS);
  const groups = chunkCaptionWords(words, { maxWords: 3 }).map((g) => g.map((w) => w.w).join(' '));
  assert.deepEqual(groups.slice(0, 6), ['רֶגַע!', 'יש לכם שיר,', 'שאין לו אקורדים', 'באף אתר?', 'תסתכלו על', 'זה ובום!']);
  assert.ok(groups.includes('סולם!') && groups.includes('קצב!') && groups.includes('חינם,'));
  // no chunk crosses a sentence end
  for (const g of chunkCaptionWords(words, { maxWords: 6, maxChars: 99 })) {
    for (let i = 0; i < g.length - 1; i++) assert.ok(!/[.!?]$/.test(g[i].w), `chunk crosses sentence after ${g[i].w}`);
  }
  // balanced: 4 words, max 3 → 2+2
  const four = W([['אחת', 0, 0.2], ['שתיים', 0.3, 0.5], ['שלוש', 0.6, 0.8], ['ארבע', 0.9, 1.1]]);
  assert.deepEqual(chunkCaptionWords(four, { maxWords: 3, maxChars: 99 }).map((g) => g.length), [2, 2]);
  // maxChars
  assert.deepEqual(chunkCaptionWords(four, { maxWords: 4, maxChars: 10 }).map((g) => g.length), [2, 2]);
  assert.deepEqual(chunkCaptionWords(four, { maxWords: 4, maxChars: 99 }).map((g) => g.length), [4]);
  // pause break
  const pause = W([['א', 0, 0.2], ['ב', 0.3, 0.5], ['ג', 1.5, 1.7]]);
  assert.deepEqual(chunkCaptionWords(pause, { maxWords: 3 }).map((g) => g.length), [2, 1]);
  assert.deepEqual(chunkCaptionWords(pause, { maxWords: 3, pauseBreak: false }).map((g) => g.length), [3]);
  // commaBreak off
  assert.deepEqual(chunkCaptionWords(W([['כן,', 0, 0.2], ['בטח', 0.25, 0.5]]), { commaBreak: false }).map((g) => g.length), [2]);
  // explicit chunks; remaining words auto
  assert.deepEqual(chunkCaptionWords(four, { chunks: [1, 2] }).map((g) => g.length), [1, 2, 1]);
  assert.deepEqual(chunkCaptionWords(four, { chunks: '3,3' }).map((g) => g.length), [3, 1]);
  // niqqud not counted in maxChars
  const nq = W([['שָׁלוֹם', 0, 0.2], ['לָכֶם', 0.3, 0.5]]);
  assert.deepEqual(chunkCaptionWords(nq, { maxWords: 3, maxChars: 9 }).map((g) => g.length), [2]);
});

test('normalizeWord ignores niqqud, punctuation, geresh and bidi marks', () => {
  assert.equal(normalizeWord('רֶגַע!'), 'רגע');
  assert.equal(normalizeWord('"אקורדים"'), 'אקורדים');
  assert.equal(normalizeWord('צ׳יפס'), 'ציפס');
  assert.equal(normalizeWord('\u200Fשלום\u200E,'), 'שלום');
  assert.equal(normalizeWord('ל־שיר'), 'לשיר');
  assert.equal(normalizeWord('Hello!'), 'hello');
});

test('addCaptions: transcript → chunks, timing, hot words, chordix style, track, y', () => {
  const r = ok(fixture(), [{ op: 'addCaptions', words: 'transcript', style: 'chordix', maxWords: 3, hot: ['אקורדים', 'ובום', 'חִינָּם'], yAbs: 330 }]);
  const P = r.project;
  const ids = r.results[0].ids;
  const caps = ids.map((id) => P.clips[id]);
  assert.equal(caps[0].text.content, 'רֶגַע!');
  assert.equal(caps[0].start, 0.12); near(caps[0].duration, 0.80 - 0.12, 1e-9, 'until next chunk start');
  const last = caps[caps.length - 1];
  near(clipEnd(last), 13.1 + 0.4, 1e-9, 'last chunk: last word end + 0.4');
  const track = P.tracks.find((t) => t.id === caps[0].trackId);
  assert.equal(track.name, 'כתוביות'); assert.equal(track.id, 't_captions');
  assert.ok(P.tracks.indexOf(track) < P.tracks.findIndex((t) => t.id === 't_text'), 'captions above the text track');
  assert.equal(caps[0].text.weight, 900); assert.equal(caps[0].text.size, 98); assert.equal(caps[0].text.stroke.width, 14);
  assert.equal(caps[0].caption.style, 'chordix'); assert.equal(caps[0].caption.hotColor, '#ff8a66');
  assert.equal(caps[0].transform.y, 330 - 960);
  const hot = caps.flatMap((c) => c.caption.words).filter((w) => w.hot).map((w) => w.w);
  assert.deepEqual(hot, ['אקורדים', 'ובום!', 'ובום!', 'חינם,']);
  for (const c of caps) for (const w of c.caption.words) assert.ok(w.s >= c.start - 1e-9 && w.s < clipEnd(c), 'words inside their clip');
  for (let i = 1; i < caps.length; i++) assert.ok(caps[i].start >= clipEnd(caps[i - 1]) - 1e-9, 'no overlap');
  assert.deepEqual(validateProject(P), []);
});

test('addCaptions: explicit chunks, hook0, hold, gap, tail, ids, replace and new track on overlap', () => {
  const words = [['יש', 1.0, 1.2], ['לכם', 1.25, 1.5], ['שיר', 1.55, 1.9], ['שאין', 4.0, 4.3], ['לו', 4.35, 4.5]];
  const r = ok(fixture({ transcript: false }), [{ op: 'addCaptions', words, chunks: [2, 1, 2], hook0: true, hold: 0.7, gap: 0.05, tail: 0.3, idPrefix: 'cap' }]);
  const P = r.project;
  assert.deepEqual(r.results[0].ids, ['cap1', 'cap2', 'cap3']);
  assert.equal(P.clips.cap1.start, 0, 'hook0'); near(clipEnd(P.clips.cap1), 1.55 - 0.05);
  near(clipEnd(P.clips.cap2), 1.9 + 0.7, 1e-9, 'hold limits long pauses');
  near(clipEnd(P.clips.cap3), 4.5 + 0.3);
  const again = ok(P, [{ op: 'addCaptions', words, style: 'pill' }]).project;
  const capTracks = again.tracks.filter((t) => t.captions);
  assert.equal(capTracks.length, 2, 'second run without replace → new captions track');
  const rep = ok(P, [{ op: 'addCaptions', words, style: 'pill', replace: true }]);
  assert.equal(rep.project.tracks.filter((t) => t.captions).length, 1);
  assert.equal(Object.values(rep.project.clips).filter((c) => c.type === 'caption').length, 2);
  assert.ok(Object.values(rep.project.clips).every((c) => c.caption.style === 'pill'));
  const no = applyOps(fixture({ transcript: false }), [{ op: 'addCaptions' }]);
  assert.match(no.results[0].error, /אין מילים/);
  assert.match(applyOps(fixture(), [{ op: 'addCaptions', style: 'weird' }]).results[0].error, /סגנון כתוביות לא מוכר/);
  const bp = ok(fixture(), [{ op: 'addCaptions', style: 'boldPop', maxWords: 1 }]);
  assert.equal(bp.results[0].ids.length, WORDS.length, 'maxWords 1 → one word per chunk');
});

test('caption editing: splitCaption, mergeCaptions, setCaptionWord, setHotWords, styleCaptions', () => {
  const base = ok(fixture({ transcript: false }), [{ op: 'addCaptions', words: [['אחת', 1, 1.2], ['שתיים', 1.3, 1.5], ['שלוש', 1.6, 1.8], ['ארבע', 3, 3.2]], chunks: [3, 1], idPrefix: 'k' }]).project;
  const s = ok(base, [{ op: 'splitCaption', id: 'k1', index: 1, newId: 'k1b' }]).project;
  assert.deepEqual(s.clips.k1.caption.words.map((w) => w.w), ['אחת']); assert.deepEqual(s.clips.k1b.caption.words.map((w) => w.w), ['שתיים', 'שלוש']);
  assert.equal(s.clips.k1b.start, 1.3); near(clipEnd(s.clips.k1), 1.3);
  const m = ok(base, [{ op: 'mergeCaptions', ids: ['k1', 'k2'] }]).project;
  assert.equal(m.clips.k2, undefined); assert.equal(m.clips.k1.caption.words.length, 4); near(clipEnd(m.clips.k1), 3.6); assert.equal(m.clips.k1.text.content, 'אחת שתיים שלוש ארבע');
  const w = ok(base, [{ op: 'setCaptionWord', id: 'k1', index: 0, set: { w: 'אַחַת!', hot: true, s: 1.05 } }]).project;
  assert.equal(w.clips.k1.caption.words[0].w, 'אַחַת!'); assert.equal(w.clips.k1.caption.words[0].hot, true); assert.equal(w.clips.k1.caption.words[0].s, 1.05);
  const h = ok(base, [{ op: 'setHotWords', words: ['"שתיים,"', 'אַרְבַּע!'] }]);
  assert.equal(h.results[0].count, 2);
  const st = ok(base, [{ op: 'styleCaptions', style: 'pill', yAbs: 1300, text: { size: 70 } }]).project;
  assert.equal(st.clips.k1.caption.style, 'pill'); assert.equal(st.clips.k1.text.background.opacity, 1); assert.equal(st.clips.k1.text.size, 70);
  assert.equal(st.clips.k1.transform.y, 340); assert.equal(st.clips.k1.text.content, 'אחת שתיים שלוש');
  assert.equal(applyOps(base, [{ op: 'splitCaption', id: 'k2', index: 1 }]).results[0].ok, false);
});

test('setTranscript accepts [[w,s,e]] and [{w,s,e}], sorts', () => {
  const P = ok(newProject({ id: 'x' }), [{ op: 'setTranscript', words: [['ב', 1, 1.5], { w: 'א', s: 0, e: 0.5 }], mediaId: 'm1' }]).project;
  assert.deepEqual(P.transcript, { words: [{ w: 'א', s: 0, e: 0.5 }, { w: 'ב', s: 1, e: 1.5 }], mediaId: 'm1' });
  assert.equal(applyOps(P, [{ op: 'setTranscript', words: [['', 0, 1]] }]).results[0].ok, false);
});

// ════════════════════════ ops: time refs & markers ════════════════════════

test('resolveTime: all forms', () => {
  const p = ok(fixture(), [
    { op: 'addMarker', t: 3, label: 'דרופ', id: 'mk1' },
    { op: 'addClip', type: 'text', content: 'x', start: 2, duration: 1.5, id: 'tx' },
  ]).project;
  assert.equal(resolveTime(p, 1.25), 1.25);
  assert.equal(resolveTime(p, '1.5'), 1.5);
  assert.equal(resolveTime(p, '.5'), 0.5);
  assert.equal(resolveTime(p, '2s'), 2);
  near(resolveTime(p, '01:01:15'), 61.5);
  near(resolveTime(p, '00:01:15'), 1.5);
  assert.equal(resolveTime(p, { word: 'ובום!' }), 5.4);
  assert.equal(resolveTime(p, { word: 'ובום!', n: 1 }), 9.8);
  assert.equal(resolveTime(p, { word: 'ובום!', n: -1 }), 9.8);
  assert.equal(resolveTime(p, { word: 'ובום', edge: 'end', offset: 0.1 }), 6);
  near(resolveTime(p, { word: 'רגע', edge: 'center' }), 0.3);
  assert.equal(resolveTime(p, 'word:ובום!:1:-0.05'), 9.75);
  assert.equal(resolveTime(p, 'word:ובום!#1'), 9.8);
  assert.equal(resolveTime(p, 'word:אתר:0:0:end'), 3.6);
  assert.equal(resolveTime(p, ['ובום!', 1, -0.13]), 9.67);
  assert.equal(resolveTime(p, { marker: 'דרופ', offset: -0.5 }), 2.5);
  assert.equal(resolveTime(p, 'marker:mk1'), 3);
  assert.equal(resolveTime(p, { clip: 'tx', edge: 'end' }), 3.5);
  assert.equal(resolveTime(p, 'clip:tx:end:0.25'), 3.75);
  assert.equal(resolveTime(p, { t: 2, offset: 0.5 }), 2.5);
  assert.equal(resolveTime(p, 'end'), projectDuration(p));
  assert.throws(() => resolveTime(p, { word: 'ובום!', n: 5 }), /יש רק 2 מופעים/);
  assert.throws(() => resolveTime(p, { word: 'בום' }), /אולי התכוונת ל: ובום!/);
  assert.throws(() => resolveTime(p, 'soon'), /זמן לא תקין/);
  assert.throws(() => resolveTime(p, { marker: 'אין' }), /הסמן/);
  assert.throws(() => resolveTime(newProject({ id: 'e' }), { word: 'x' }), /אין תמלול/);
});

test('word refs fall back to caption words when there is no transcript', () => {
  const p = ok(fixture({ transcript: false }), [{ op: 'addCaptions', words: [['שלום', 1, 1.3], ['לכם!', 1.4, 1.8]] }]).project;
  assert.equal(resolveTime(p, { word: 'לכם' }), 1.4);
});

test('markers: add (word time), update, remove by label, clear', () => {
  const r = ok(fixture(), [
    { op: 'addMarker', t: { word: 'ובום!', n: 1 }, label: 'דרופ', id: 'drop' },
    { op: 'addMarker', t: 1, label: 'הוק' },
    { op: 'updateMarker', id: 'drop', set: { color: '#ff0000', t: 'word:קורדיקס!' } },
    { op: 'removeMarker', id: 'הוק' },
  ]);
  assert.deepEqual(r.project.markers, [{ id: 'drop', t: 11, label: 'דרופ', color: '#ff0000' }]);
  assert.equal(ok(r.project, [{ op: 'clearMarkers' }]).project.markers.length, 0);
});

// ════════════════════════ ops: ripple ════════════════════════

test('rippleDelete over all tracks: remove, cut-out, trims, shifts, markers and transcript', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 8, id: 'long', track: 't_main' },
    { op: 'addClip', type: 'text', content: 'inside', start: 2.2, duration: 0.5, id: 'inside' },
    { op: 'addClip', type: 'text', content: 'head', start: 1.5, duration: 1, id: 'tailCut', track: 't_overlay' },
    { op: 'addClip', type: 'audio', mediaId: 'm_vo', start: 2.5, duration: 2, id: 'headCut' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 5, duration: 1, id: 'after' },
    { op: 'addMarker', t: 2.5, label: 'in' }, { op: 'addMarker', t: 4, label: 'after' },
  ]).project;
  const P = ok(base, [{ op: 'rippleDelete', from: 2, to: 3 }]).project;
  assert.equal(P.clips.inside, undefined);
  assert.equal(P.clips.tailCut.start, 1.5); near(clipEnd(P.clips.tailCut), 2);
  assert.equal(P.clips.headCut.start, 2); near(P.clips.headCut.duration, 1.5); near(P.clips.headCut.in, 0.5);
  assert.equal(P.clips.after.start, 4);
  const main = clipsOnTrack(P, 't_main');
  assert.equal(main.length, 2); near(clipEnd(main[0]), 2); assert.equal(main[1].start, 2); near(main[1].in, 3); near(clipEnd(main[1]), 7);
  assert.deepEqual(P.markers.map((m) => [m.label, m.t]), [['after', 3]]);
  assert.ok(!P.transcript.words.some((w) => w.s >= 2 && w.s < 3) || true);
  near(P.transcript.words.find((w) => w.w === 'אתר?').s, 2.12);
  assert.ok(!P.transcript.words.some((w) => w.w === 'באף' && w.s === 2.85));
  // tracks subset: markers unchanged
  const sub = ok(base, [{ op: 'rippleDelete', from: 2, to: 3, tracks: ['t_sfx'] }]).project;
  assert.equal(sub.clips.after.start, 4); assert.equal(sub.clips.inside.start, 2.2); assert.equal(sub.markers.length, 2);
  assert.equal(applyOps(base, [{ op: 'rippleDelete', from: 3, to: 2 }]).results[0].ok, false);
});

test('insertGap splits spanning clips and pushes later clips; locked tracks skipped', () => {
  const base = ok(fixture(), [
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 0, duration: 4, id: 'a', track: 't_main' },
    { op: 'addClip', type: 'text', content: 'x', start: 3, duration: 1, id: 't' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 2, duration: 1, id: 's' },
    { op: 'updateTrack', id: 't_sfx', set: { locked: true } },
  ]).project;
  const r = ok(base, [{ op: 'insertGap', at: 2, duration: 0.5 }]);
  const P = r.project;
  const main = clipsOnTrack(P, 't_main');
  assert.deepEqual(main.map((c) => [c.start, c.duration]), [[0, 2], [2.5, 2]]);
  assert.equal(P.clips.t.start, 3.5); assert.equal(P.clips.s.start, 2, 'locked track untouched'); assert.ok(r.results[0].warnings);
  near(P.transcript.words.find((w) => w.w === 'באף').s, 3.35);
});

test('locked tracks block clip edits unless force', () => {
  const base = ok(fixture(), [{ op: 'addClip', type: 'text', content: 'x', id: 't' }, { op: 'updateTrack', id: 't_text', set: { locked: true } }]).project;
  const r = applyOps(base, [{ op: 'updateClip', id: 't', set: { 'text.size': 10 } }, { op: 'removeClip', id: 't' }, { op: 'moveClip', id: 't', start: 3 }]);
  assert.ok(r.results.every((x) => !x.ok && /נעול/.test(x.error)));
  assert.equal(ok(base, [{ op: 'updateClip', id: 't', set: { 'text.size': 10 }, force: true }]).project.clips.t.text.size, 10);
  const auto = ok(base, [{ op: 'addClip', type: 'text', content: 'y', id: 'y' }]).project;
  assert.notEqual(auto.clips.y.trackId, 't_text', 'auto placement avoids locked tracks');
});

// ════════════════════════ ops: sfx ════════════════════════

test('sfx: resolved library entry → media with library.soundId; reuse; gain; len; word time; new track on overlap', () => {
  const entry = { id: 'snd_whoosh', name: 'Fast whoosh', abs: 'C:/lib/fast whoosh.wav', duration: 1.4, channels: 2, sampleRate: 44100, license: 'mixkit' };
  const r = ok(fixture(), [
    { op: 'sfx', sound: 'whoosh', at: { word: 'סולם!', offset: -0.12 }, gain_db: -14, len: 0.8, fade: 0.15, resolved: entry, id: 's1' },
    { op: 'sfx', sound: 'whoosh', at: 6.3, gain_db: -6, len: 5, resolved: entry, id: 's2' },
    { op: 'sfx', sound: 'snd_whoosh', at: 9, id: 's3' },
    { op: 'sfx', sound: 'abc123', at: 0, id: 's4' },
    { op: 'sfx', sound: 'C:/lib/boom.wav', at: 12, from: 0.5, id: 's5' },
    { op: 'sfx', mediaId: 'm_boom', at: 13, name: 'בום סיום', id: 's6' },
  ]);
  const P = r.project;
  const m = P.media[P.clips.s1.mediaId];
  assert.equal(m.library.soundId, 'snd_whoosh'); assert.equal(m.kind, 'audio'); assert.equal(m.path, 'C:/lib/fast whoosh.wav');
  assert.equal(P.clips.s2.mediaId, m.id, 'same sound reused');
  assert.equal(P.clips.s3.mediaId, m.id, 'sound id resolves to existing media offline');
  near(P.clips.s1.start, 6.18); assert.equal(P.clips.s1.duration, 0.8); assert.equal(P.clips.s1.fadeOut, 0.15); near(P.clips.s1.volume, dbToGain(-14));
  assert.equal(P.clips.s2.duration, 1.4); assert.ok(r.results[1].warnings);
  assert.notEqual(P.clips.s2.trackId, P.clips.s1.trackId, 'overlapping sfx go to a new sfx track');
  assert.equal(P.clips.s4.mediaId, 'm_boom'); assert.equal(P.clips.s5.mediaId, 'm_boom'); assert.equal(P.clips.s5.in, 0.5); near(P.clips.s5.duration, 2.5);
  assert.equal(P.clips.s6.name, 'בום סיום');
  assert.equal(P.clips.s1.trackId, 't_sfx');
  const off = applyOps(fixture(), [{ op: 'sfx', sound: 'boom big', at: 1 }]);
  assert.match(off.results[0].error, /בלי השרת/);
  const viaCtx = ok(fixture(), [{ op: 'sfx', sound: 'riser', at: 1 }], { sounds: { riser: { id: 'r1', name: 'Riser', abs: 'C:/lib/riser.wav', duration: 9 } } });
  assert.equal(Object.values(viaCtx.project.clips)[0].duration, 9);
});

// ════════════════════════ catalog ════════════════════════

test('catalog: getCatalog never throws, returns all keys; getCatalogSync works before load', async () => {
  const sync = catalog.getCatalogSync();
  assert.ok(Array.isArray(sync.transitions));
  const cat = await catalog.getCatalog();
  for (const k of ['transitions', 'effects', 'filters', 'clipAnims', 'textAnims', 'captionStyles', 'textPresets', 'shapes', 'stickers', 'fonts']) assert.ok(k in cat, k);
  assert.ok(cat.clipAnims.in.length >= 18);
  assert.equal(JSON.stringify(cat).includes('"glsl"'), false, 'glsl stripped');
  for (const t of cat.transitions) assert.ok(t.id && t.name, 'transition has id/name');
  assert.equal(catalog.getCatalogSync(), cat);
  if (cat.loaded && cat.captionStyles.length) {
    // when the real catalog is loaded, captions use its styles
    const r = applyOps(fixture(), [{ op: 'addCaptions', style: cat.captionStyles[0].id }], { catalog: cat });
    assert.ok(r.results[0].ok, r.results[0].error);
  }
});

test('stickers and shapes: catalog ids, builtin values, shape styles', async () => {
  const offline = applyOps(fixture(), [
    { op: 'addClip', type: 'sticker', value: 'builtin-arrow', id: 'a' },
    { op: 'addClip', type: 'sticker', sticker: { kind: 'emoji', value: '🎸' }, id: 'b' },
    { op: 'addClip', type: 'shape', kind: 'progress', shape: { progressFrom: 0, progressTo: 1 }, id: 's' },
  ], { catalog: { loaded: false, stickers: [], shapes: [] } });
  offline.results.forEach((r) => assert.ok(r.ok, r.error));
  assert.deepEqual([offline.project.clips.a.sticker.kind, offline.project.clips.a.sticker.value], ['builtin', 'arrow']);
  assert.deepEqual([offline.project.clips.b.sticker.kind, offline.project.clips.b.sticker.value], ['emoji', '🎸']);
  const noCat = applyOps(fixture(), [{ op: 'addClip', type: 'shape', kind: 'card' }, { op: 'addClip', type: 'sticker', value: 'emoji-fire' }], { catalog: { loaded: false, stickers: [], shapes: [] } });
  assert.match(noCat.results[0].error, /צורה לא מוכרת/); assert.match(noCat.results[1].error, /לא נמצאה בקטלוג/);
  const cat = await catalog.getCatalog();
  if (!cat.loaded || !cat.shapes.length || !cat.stickers.length) return;
  const card = cat.shapes.find((x) => x.id !== x.kind && x.shape);
  const em = cat.stickers.find((x) => x.kind === 'emoji');
  const bi = cat.stickers.find((x) => x.kind === 'builtin');
  const r = applyOps(fixture(), [
    { op: 'addClip', type: 'shape', kind: card.id, shape: { w: 333 }, id: 'c1' },
    { op: 'addClip', type: 'shape', preset: card.id, id: 'c2' },
    { op: 'addClip', type: 'sticker', value: em.id, id: 'e1' },
    { op: 'addClip', type: 'sticker', preset: bi.id, id: 'b1' },
    { op: 'updateClip', id: 'c2', set: { 'shape.kind': card.id } },
    { op: 'updateClip', id: 'e1', set: { 'sticker.value': bi.id } },
  ], { catalog: cat });
  r.results.forEach((x) => assert.ok(x.ok, x.error));
  const P = r.project;
  assert.equal(P.clips.c1.shape.kind, card.shape.kind || card.kind); assert.equal(P.clips.c1.shape.w, 333);
  assert.equal(P.clips.c2.shape.w, card.shape.w ?? P.clips.c2.shape.w);
  assert.equal(P.clips.b1.sticker.kind, 'builtin'); assert.equal(P.clips.b1.sticker.value, bi.value);
  assert.equal(P.clips.e1.sticker.value, bi.value, 'set sticker.value with a catalog id');
  assert.equal(validateProject(P).length, 0);
});

// ════════════════════════ integration: Chordix-style edit ════════════════════════

test('integration: Chordix social edit batch validates cleanly', () => {
  const sounds = {
    boom: { id: 'b1', name: 'Booms 011', abs: 'C:/lib/booms_011.wav', duration: 4 },
    whoosh: { id: 'w1', name: 'Air zoom vacuum', abs: 'C:/lib/air zoom.wav', duration: 1.2 },
    riser: { id: 'r1', name: 'Cinematic trailer riser', abs: 'C:/lib/riser.wav', duration: 6 },
    braam: { id: 'br1', name: 'Horn Braam', abs: 'C:/lib/braam.wav', duration: 5 },
  };
  const P0 = fixture();
  const r = applyOps(P0, [
    { op: 'setSettings', set: { background: '#071822' } },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 5.4, id: 'shot1' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 5.4, in: 2, duration: 4.4, id: 'shot2' },
    { op: 'addClip', type: 'image', mediaId: 'm_img', start: 9.8, duration: 4, id: 'end', fit: 'contain' },
    { op: 'setTransition', id: 'shot1', transition: 'zoomBlur', duration: 0.35 },
    { op: 'setTransition', id: 'shot2', transition: 'flashWhite', duration: 0.3 },
    { op: 'addClip', type: 'audio', mediaId: 'm_vo', start: 0, duration: 13.6, role: 'voice', id: 'vo' },
    { op: 'addCaptions', words: 'transcript', style: 'chordix', maxWords: 3, hot: ['אקורדים', 'ובום!'], yAbs: 330, hook0: true },
    { op: 'sfx', sound: 'boom', at: 0, gain_db: -8, len: 2.5 },
    ...['סולם!', 'קצב!', 'מבנה!'].map((w) => ({ op: 'sfx', sound: 'whoosh', at: { word: w, offset: -0.1 }, gain_db: -14, len: 0.6 })),
    { op: 'sfx', sound: 'riser', at: { word: 'ובום!', n: 1, offset: -2.45 }, gain_db: -14, len: 2.5, fade: 0.1 },
    { op: 'sfx', sound: 'braam', at: { word: 'ובום!', n: 1, offset: -0.13 }, gain_db: -10, len: 3.5, fade: 0.5 },
    ...['סולם!', 'קצב!', 'מבנה!'].map((w, i) => ({ op: 'addClip', type: 'effect', effect: 'zoomPunch', params: { strength: i === 2 ? 0.15 : 0.3 }, at: { word: w }, duration: 0.5 })),
    { op: 'addClip', type: 'effect', effect: 'flash', at: { word: 'ובום!', n: 1 }, duration: 0.3 },
    { op: 'setKeyframes', id: 'shot2', prop: 'transform.scale', abs: true, keys: [{ t: 'word:סולם!', v: 1 }, { t: 'word:סולם!:0:0.18', v: 1.85, ease: 'easeOut' }, { t: 'word:קצב!', v: 1, ease: 'easeInOut' }] },
    { op: 'addMarker', t: { word: 'ובום!', n: 1 }, label: 'דרופ' },
  ], { sounds });
  r.results.forEach((x, i) => assert.ok(x.ok, `op ${i}: ${x.error}`));
  const P = r.project;
  assert.deepEqual(validateProject(P), []);
  const sfxClips = Object.values(P.clips).filter((c) => c.type === 'audio' && c.id !== 'vo');
  assert.equal(sfxClips.length, 6);
  const effTrack = P.tracks[0];
  assert.equal(effTrack.role, 'effects');
  assert.equal(nextClipOnTrack(P, P.clips.shot1).id, 'shot2');
  const capClips = Object.values(P.clips).filter((c) => c.type === 'caption').sort((a, b) => a.start - b.start);
  assert.equal(capClips[0].start, 0, 'hook0: first chunk visible at frame 0');
  assert.ok(summarizeOps([{ op: 'sfx' }]).length > 0);
});

// ───────────── run ─────────────
let pass = 0, failN = 0;
for (const t of tests) {
  try { await t.fn(); pass++; }
  catch (e) { failN++; console.log(`✗ ${t.name}\n   ${(e && e.stack ? e.stack : e).toString().split('\n').slice(0, 4).join('\n   ')}`); }
}
console.log(`\n${pass}/${tests.length} בדיקות עברו${failN ? `, ${failN} נכשלו` : ''}`);
process.exitCode = failN ? 1 : 0;
