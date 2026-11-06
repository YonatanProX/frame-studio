// Agent L self-test: timeline edit planning (app/tl-ops.js) applied with the real ops engine (shared/ops.js).
// Usage: node tools/tests/L-ops-test.mjs
import { applyOps } from '../../shared/ops.js';
import * as O from '../../app/tl-ops.js';
import { makeFixture } from './L-fixture.mjs';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const run = (p, ops, label) => {
  const r = applyOps(p, ops, {});
  const bad = r.results.filter((x) => x && x.ok === false);
  if (bad.length) console.log(`   ${label}: op errors →`, bad.map((b) => b.error));
  return r;
};
const pos = (p, ids) => ids.map((id) => `${id}@${p.clips[id].start.toFixed(2)}+${p.clips[id].duration.toFixed(2)}`).join(' ');

// 1. magnetic reorder on the main track
{
  const p = makeFixture();
  const plan = O.planMove(p, { ids: ['c_v2'], primaryId: 'c_v2', dt: 6, targetTrackId: 't_main', magnetic: true, pointerT: 9 });
  const r = run(p, O.moveOps(p, plan), 'reorder');
  const q = r.project;
  console.log('   ', pos(q, ['c_v1', 'c_v3', 'c_v2', 'c_v4']));
  ok(near(q.clips.c_v1.start, 0) && near(q.clips.c_v3.start, 4) && near(q.clips.c_v2.start, 8.5) && near(q.clips.c_v4.start, 12), 'magnetic reorder: v1,v3,v2,v4 contiguous');
  ok(q.tracks.length === p.tracks.length, 'magnetic reorder creates no track');
}
// 2. collision on a normal track → new track
{
  const p = makeFixture();
  const plan = O.planMove(p, { ids: ['c_t1'], primaryId: 'c_t1', dt: 7, targetTrackId: 't_text', magnetic: true });
  ok(plan.newTracks.length === 1, 'collision plans a new track');
  const r = run(p, O.moveOps(p, plan), 'collision');
  const q = r.project;
  const t = q.tracks.find((x) => x.id === plan.newTracks[0].id);
  ok(t && q.clips.c_t1.trackId === t.id && near(q.clips.c_t1.start, 7), `text moved to new track "${t && t.name}" at 7`);
  ok(q.tracks.findIndex((x) => x.id === t.id) === p.tracks.findIndex((x) => x.id === 't_text'), 'new video track inserted just above the target');
}
// 3. plain move on a free spot
{
  const p = makeFixture();
  const plan = O.planMove(p, { ids: ['c_s2'], primaryId: 'c_s2', dt: 1, targetTrackId: 't_sfx', magnetic: true });
  const ops = O.moveOps(p, plan);
  ok(ops.length === 1 && ops[0].op === 'moveClip' && near(ops[0].start, 4.8) && !ops[0].track, 'free move → single moveClip');
}
// 4. video clip dragged over audio lanes stays on the nearest video track
{
  const p = makeFixture();
  const plan = O.planMove(p, { ids: ['c_img'], primaryId: 'c_img', dt: 0, targetTrackId: 't_music', magnetic: false });
  ok(plan.moves[0].trackId === 't_main' || plan.newTracks.length === 1, `video over audio → ${plan.moves[0].trackId}`);
}
// 5. trim end: neighbour clamp vs ripple on the magnetic main track
{
  const p = makeFixture();
  const a = O.planTrim(p, { id: 'c_v1', edge: 'end', t: 6, ripple: false });
  ok(near(a.end, 4) && a.limit === 'neighbor', 'non-ripple trim clamps at the next clip');
  const b = O.planTrim(p, { id: 'c_v1', edge: 'end', t: 6, ripple: true });
  const r = run(p, O.trimOps(p, 'c_v1', 'end', b, true), 'ripple end');
  const q = r.project;
  console.log('   ', pos(q, ['c_v1', 'c_v2', 'c_v3', 'c_v4']));
  ok(near(q.clips.c_v1.duration, 6) && near(q.clips.c_v2.start, 6) && near(q.clips.c_v3.start, 9.5) && near(q.clips.c_v4.start, 14), 'ripple end-trim pushes following clips');
  const c = O.planTrim(p, { id: 'c_v1', edge: 'end', t: 30, ripple: true });
  ok(near(c.end, 16) && c.limit === 'media', 'media length limit (16 s)');
}
// 6. ripple head trim keeps the start
{
  const p = makeFixture();
  const plan = O.planTrim(p, { id: 'c_v2', edge: 'start', t: 5, ripple: true });
  const r = run(p, O.trimOps(p, 'c_v2', 'start', plan, true), 'ripple head');
  const q = r.project;
  console.log('   ', pos(q, ['c_v1', 'c_v2', 'c_v3', 'c_v4']), 'in', q.clips.c_v2.in);
  ok(near(q.clips.c_v2.start, 4) && near(q.clips.c_v2.duration, 2.5) && near(q.clips.c_v2.in, 3) && near(q.clips.c_v3.start, 6.5), 'ripple head-trim: start kept, in +1, next clips slide left');
}
// 7. head trim media limit
{
  const p = makeFixture();
  const plan = O.planTrim(p, { id: 'c_vo', edge: 'start', t: 0, ripple: false });
  ok(near(plan.start, 0.5) && plan.limit === 'media', 'head trim cannot go before the media start');
  const img = O.planTrim(p, { id: 'c_img', edge: 'end', t: 8.9, ripple: false });
  ok(near(img.end, 8.9) && !img.limit, 'images extend freely (no media limit)');
}
// 8. delete on the magnetic main track closes the gap
{
  const p = makeFixture();
  const r = run(p, O.deleteOps(p, ['c_v2'], { magnetic: true }), 'delete');
  const q = r.project;
  ok(!q.clips.c_v2 && near(q.clips.c_v3.start, 4) && near(q.clips.c_v4.start, 8.5), 'magnetic delete ripples the main track');
  const r2 = run(p, O.deleteOps(p, ['c_s2'], { magnetic: true }), 'delete sfx');
  ok(near(r2.project.clips.c_s3.start, 9), 'deleting on a normal track does not ripple');
  const r3 = run(p, O.deleteOps(p, ['c_s2'], { ripple: true }), 'ripple sfx');
  ok(near(r3.project.clips.c_s3.start, 8.2), 'Shift+Delete ripples the same track');
}
// 9. split
{
  const p = makeFixture();
  const r = run(p, O.splitOps(p, ['c_v1', 'c_mus'], 2), 'split');
  const n = Object.values(r.project.clips).length;
  ok(n === Object.values(p.clips).length + 2, 'split two clips at 2 s');
}
// 10. copy / paste
{
  const p = makeFixture();
  const cb = O.makeClipboard(p, ['c_s2', 'c_s4']);
  const pr = O.pasteOps(p, cb, 6);
  const r = run(p, pr.ops, 'paste');
  const q = r.project;
  const a = q.clips[pr.select[0]], b = q.clips[pr.select[1]];
  ok(a && b && near(a.start, 6) && near(b.start, 6 + (12 - 3.8)) && a.trackId === 't_sfx', `paste keeps offsets on the original track (${a && a.trackId})`);
}
// 11. insert media on the magnetic main track
{
  const p = makeFixture();
  const r0 = O.insertPayloadOps(p, { kind: 'media', mediaId: 'm_v2', mediaKind: 'video', name: 'x' }, { t: 5, hoverTrackId: 't_main', magnetic: true });
  const r = run(p, r0.ops, 'insert media');
  const q = r.project;
  const c = q.clips[r0.select[0]];
  console.log('   ', r0.summary, '→', c && `${c.trackId}@${c.start}+${c.duration}`);
  ok(c && c.trackId === 't_main' && near(c.start, 4) && near(q.clips.c_v2.start, 16), 'insert at the nearest cut and push the rest');
  const t2 = O.insertPayloadOps(p, { kind: 'text', preset: { name: 'כותרת', text: { content: 'שלום' } }, name: 'כותרת' }, { t: 6.5, hoverTrackId: 't_main', magnetic: true });
  const r2 = run(p, t2.ops, 'insert text');
  const tc = r2.project.clips[t2.select[0]];
  ok(tc && r2.project.tracks.find((x) => x.id === tc.trackId).role === 'text', `text never lands on the main track (→ ${tc && tc.trackId})`);
}
// 12. sfx payload → sfx op (server resolves)
{
  const p = makeFixture();
  const r0 = O.insertPayloadOps(p, { kind: 'sound', id: 'abcdef123456', abs: 'C:/x.wav', name: 'ווש', duration: 0.9, role: 'sfx', suggest: { gainDb: -12, len: 1.3 } }, { t: 5, magnetic: true });
  const op = r0.ops.find((o) => o.op === 'sfx');
  ok(op && op.sound === 'abcdef123456' && near(op.at, 5) && op.track === 't_sfx' && op.gain_db === -12, 'sound payload → sfx op with track + suggested gain');
  const r = applyOps(p, r0.ops, {});
  ok(r.results.length === r0.ops.length, `local apply of an unresolved sfx op does not throw (ok=${r.results[r.results.length - 1].ok})`);
}
// 13. transition via payload on a clip
{
  const p = makeFixture();
  const ap = O.applyPayloadOps(p, { kind: 'transition', id: 'wipeLeft', name: 'ניגוב' }, ['c_v2'], { pointerT: 7 });
  const r = run(p, ap.ops, 'transition');
  ok(r.project.clips.c_v2.transitionOut.id === 'wipeLeft', 'transition applied to the c_v2→c_v3 junction');
  const fx = O.applyPayloadOps(p, { kind: 'effect', id: 'glitch', name: 'גליץ׳' }, ['c_v1', 'c_s1']);
  ok(fx.ops.length === 1 && fx.ops[0].op === 'addEffect' && fx.ops[0].id === 'c_v1', 'effects skip audio clips');
  const an = O.applyPayloadOps(p, { kind: 'anim', slot: 'in', id: 'slideUp', text: true }, ['c_t1', 'c_v1']);
  ok(an.ops.length === 1 && an.ops[0].set['textAnim.in'] === 'slideUp', 'text animations only on text/caption clips');
}
// 14. detach audio
{
  const p = makeFixture();
  const d = O.detachAudioOps(p, 'c_v1');
  const r = run(p, d.ops, 'detach');
  const q = r.project;
  const a = q.clips[d.select[0]];
  ok(a && a.type === 'audio' && a.mediaId === 'm_v1' && near(a.start, 0) && near(a.duration, 4) && q.clips.c_v1.muteAudio === true, `detach audio → audio clip on ${a && q.tracks.find((t) => t.id === a.trackId).name}`);
  ok(O.detachAudioOps(p, 'c_v2') === null, 'no detach for media without audio');
}
// 15. speed + magnetic ripple
{
  const p = makeFixture();
  const r = run(p, O.speedOps(p, ['c_v3'], 2, { magnetic: true }), 'speed');
  const q = r.project;
  ok(near(q.clips.c_v3.duration, 2.25) && near(q.clips.c_v4.start, 9.75), 'speed 2× halves the duration and ripples the main track');
}
// 16. keyframe move
{
  const p = makeFixture();
  const r = run(p, O.moveKeyframeOps(p.clips.c_v2, 1.2, 2), 'kf');
  const ks = r.project.clips.c_v2.keyframes['transform.scale'].map((k) => k.t);
  ok(ks.includes(2) && !ks.some((t) => near(t, 1.2)), `keyframe moved 1.2 → 2 (${ks.join(', ')})`);
}
// 17. markers
{
  const p = makeFixture();
  const r = run(p, O.markerUpdateOps(p.markers[1], { label: 'הדרופ הגדול', t: 5.5 }), 'marker');
  const m = r.project.markers.find((x) => x.id === 'mk_drop');
  ok(m && m.label === 'הדרופ הגדול' && near(m.t, 5.5) && r.project.markers.length === 3, 'marker rename + move keeps its id');
}
// 18. duplicate (Ctrl+D)
{
  const p = makeFixture();
  const ops = O.duplicateOps(p, ['c_t2']);
  const r = run(p, ops, 'dup');
  const nid = ops.find((o) => o.op === 'duplicateClip').newId;
  ok(r.project.clips[nid] && near(r.project.clips[nid].start, 9), 'duplicate lands right after the original with the chosen id');
}

console.log(`\n${fails ? fails + ' FAILED' : 'ALL PASSED'}`);
process.exit(fails ? 1 : 0);
