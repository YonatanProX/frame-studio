// Frame Studio — tests for cli/cutx.mjs (agent M). A mock server (port 7713) implements the §5/§7/§8 routes the CLI uses,
// applying ops with the real shared/ops.js. Run: node "tools/tests/M-cli.test.mjs"

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'cli', 'cutx.mjs');
const TMP = path.join(HERE, 'M-tmp');
const PORT = 7713;

const { applyOps } = await import(new URL('../../shared/ops.js', import.meta.url).href);
const { newProject, projectDuration } = await import(new URL('../../shared/model.js', import.meta.url).href);
const cli = await import(new URL('../../cli/cutx.mjs', import.meta.url).href);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ───────────── mock server ─────────────
const projects = new Map();
const history = new Map();
const jobs = new Map();
let jobSeq = 0;
const calls = [];
const SOUNDS = [
  { id: 'snd_whoosh01', name: 'Fast whoosh transition', file: 'נבחרים לסושיאל/מיקסקיט/ווש/Fast whoosh transition.wav', abs: 'C:/lib/fast whoosh.wav', category: 'וושים ומעברים', duration: 1.1, peakDb: -3.2, license: 'mixkit', role: 'זום' },
  { id: 'snd_boom0001', name: 'Booms 011', file: 'x/booms.wav', abs: 'C:/lib/booms.wav', category: 'בומים ומכות', duration: 4.2, peakDb: -1, license: 'sonniss', role: 'דרופ' },
];
let mediaSeq = 0;

function mediaFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  const kind = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? 'image' : ['.wav', '.mp3', '.m4a', '.flac'].includes(ext) ? 'audio' : 'video';
  return { id: `m_mock${++mediaSeq}`, kind, name: path.basename(p), path: p, duration: kind === 'image' ? 0 : 8, width: 1080, height: 1920, fps: 30,
    hasVideo: kind !== 'audio', hasAudio: kind !== 'image', status: 'ready' };
}

function newJob(type, extra) {
  const id = `job${++jobSeq}`;
  const j = { id, type, status: 'running', progress: 0, polls: 0, ...extra };
  jobs.set(id, j);
  return j;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

function commit(id, next) {
  const P = projects.get(id);
  if (!history.has(id)) history.set(id, { undo: [], redo: [] });
  const h = history.get(id);
  h.undo.push(P); h.redo = [];
  next.rev = P.rev + 1;
  projects.set(id, next);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(u.pathname);
  calls.push(`${req.method} ${p}`);
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, version: 'mock', root: ROOT, port: PORT });
    if (p === '/api/projects' && req.method === 'GET') return send(res, 200, [...projects.values()].map((P) => ({ id: P.id, name: P.name, width: P.settings.width, height: P.settings.height, fps: P.settings.fps, duration: projectDuration(P), modified: P.meta.modified, clipCount: Object.keys(P.clips).length })));
    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readJson(req);
      if (projects.has(b.id)) return send(res, 409, { error: 'הפרויקט כבר קיים' });
      const P = newProject(b);
      projects.set(P.id, P);
      return send(res, 200, P);
    }
    if (p === '/api/import-chordix') {
      const b = await readJson(req);
      const P = newProject({ id: b.id || 'chordix-import', name: b.name || 'ייבוא' });
      projects.set(P.id, P);
      return send(res, 200, P);
    }
    if (p === '/api/open') { await readJson(req); return send(res, 200, { ok: true }); }
    if (p === '/api/library/sounds') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const list = SOUNDS.filter((s) => !q || s.name.toLowerCase().includes(q) || s.category.includes(q));
      return send(res, 200, { total: list.length, items: list.slice(0, Number(u.searchParams.get('limit') || 200)) });
    }
    if (p === '/api/library/fonts') return send(res, 200, [{ family: 'Heebo', weights: [100, 900], system: false, license: 'OFL' }]);
    if (p === '/api/library/luts') return send(res, 200, ['teal-orange.cube']);
    let m = /^\/api\/jobs\/([^/]+)$/.exec(p);
    if (m) {
      const j = jobs.get(m[1]);
      if (!j) return send(res, 404, { error: 'אין משימה כזו' });
      j.polls++;
      if (j.polls >= 2) { j.status = 'done'; j.progress = 1; } else j.progress = 0.5;
      return send(res, 200, j);
    }
    m = /^\/api\/projects\/([^/]+)(?:\/(.+))?$/.exec(p);
    if (m) {
      const id = m[1], sub = m[2];
      const P = projects.get(id);
      if (!P) return send(res, 404, { error: `הפרויקט ${id} לא נמצא` });
      if (!sub && req.method === 'GET') return send(res, 200, P);
      if (sub === 'ops') {
        const b = await readJson(req);
        const media = {};
        const sounds = {};
        const ops = b.ops.map((op) => {
          if (op.op === 'addClip' && op.path) {
            const existing = Object.values(P.media).find((x) => x.path === op.path);
            const md = existing || mediaFromPath(op.path);
            media[md.id] = md;
            const { path: _p, ...rest } = op;
            return { ...rest, mediaId: md.id };
          }
          if (op.op === 'sfx' && !op.mediaId) {
            const s = SOUNDS.find((x) => x.id === op.sound) || SOUNDS.find((x) => x.name.toLowerCase().includes(String(op.sound).toLowerCase()));
            if (s) sounds[op.sound] = s;
          }
          return op;
        });
        const r = applyOps(P, ops, { media, sounds, atomic: b.atomic });
        commit(id, r.project);
        calls.push(`summary:${b.summary}|by:${b.by}`);
        return send(res, 200, { rev: projects.get(id).rev, results: r.results, project: projects.get(id) });
      }
      if (sub === 'undo' || sub === 'redo') {
        const h = history.get(id) || { undo: [], redo: [] };
        const from = sub === 'undo' ? h.undo : h.redo, to = sub === 'undo' ? h.redo : h.undo;
        if (!from.length) return send(res, 400, { error: 'אין מה לבטל' });
        to.push(P);
        const prev = from.pop();
        const next = { ...prev, rev: P.rev + 1 };
        projects.set(id, next);
        return send(res, 200, { rev: next.rev, project: next });
      }
      if (sub === 'import') {
        const b = await readJson(req);
        const list = b.paths.map((x) => ({ ...mediaFromPath(x), status: 'processing' }));
        const next = { ...P, media: { ...P.media } };
        for (const md of list) next.media[md.id] = { ...md, status: 'ready' };
        projects.set(id, next);
        return send(res, 200, { media: list });
      }
      if (sub === 'snapshot') {
        const b = await readJson(req);
        const outputs = b.times.map((t, i) => {
          const f = path.join(TMP, `snap-${i}-${t}.png`);
          fs.writeFileSync(f, 'png');
          return f;
        });
        return send(res, 200, newJob('snapshot', { times: b.times, outputs }));
      }
      if (sub === 'export') {
        const b = await readJson(req);
        calls.push(`export:${JSON.stringify(b)}`);
        const outFile = b.out || path.join(TMP, 'out.mp4');
        return send(res, 200, newJob('export', { outputs: b.stemsOnly ? [] : [outFile], report: { duration: 13.6, size: 4200000, lufs: -14.1, truePeak: -1.3, speechMargin: { min: 12.4, median: 21.7, below: [] } } }));
      }
      if (sub === 'check-audio') return send(res, 404, { error: 'לא קיים' });
      if (sub === 'transcribe') {
        const b = await readJson(req);
        const r = applyOps(P, [{ op: 'setTranscript', words: [['שלום', 0.1, 0.5], ['לכם!', 0.6, 1.0]] }, ...(b.captions ? [{ op: 'addCaptions', ...b.captions }] : [])]);
        commit(id, r.project);
        return send(res, 200, newJob('transcribe', {}));
      }
    }
    return send(res, 404, { error: `לא נמצא: ${p}` });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message) });
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

function run(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CUTX_URL: `http://127.0.0.1:${PORT}`, CUTX_NO_AUTOSTART: '1' }, cwd: ROOT });
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); } else child.stdin.end();
    child.on('close', (code) => resolve({ code, out: so, err: se }));
  });
}

// ───────────── runner ─────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('pure helpers: parseArgs, parseValue, splitTimes, parseSize, normalizeAsr, parseTimeArg', () => {
  const A = cli.parseArgs(['add', 'p', 'text', 'שלום', '--at', 'word:ובום!', '--set', 'a=1', '--set', 'b.c=true', '--gain', '-12', '--json', '--dur=2']);
  assert.deepEqual(A.pos, ['add', 'p', 'text', 'שלום']);
  assert.equal(A.flags.at, 'word:ובום!'); assert.equal(A.flags.gain, '-12'); assert.equal(A.flags.json, true); assert.equal(A.flags.dur, '2');
  assert.deepEqual(A.set, ['a=1', 'b.c=true']);
  assert.deepEqual(cli.parseAssignments(['a=1', 'b.c=true', 'text.content=שלום עולם', 'x={"k":2}', 'col=#ff0000', 'n=-0.5']), { a: 1, 'b.c': true, 'text.content': 'שלום עולם', x: { k: 2 }, col: '#ff0000', n: -0.5 });
  assert.throws(() => cli.parseAssignments(['nokey']));
  assert.deepEqual(cli.splitTimes('0.5,3,word:שיר,,6.2,word:ובום!:1'), ['0.5', '3', 'word:שיר,', '6.2', 'word:ובום!:1']);
  assert.deepEqual(cli.parseSize('9:16'), [1080, 1920]); assert.deepEqual(cli.parseSize('1920x1080'), [1920, 1080]);
  assert.throws(() => cli.parseSize('big'));
  assert.deepEqual(cli.normalizeAsr([['א', 0, 1]]), [['א', 0, 1]]);
  assert.deepEqual(cli.normalizeAsr({ segments: [{ words: [{ word: ' שלום', start: 0.1, end: 0.4 }] }] }), [['שלום', 0.1, 0.4]]);
  assert.deepEqual(cli.normalizeAsr([{ w: 'x', s: 1, e: 2 }]), [['x', 1, 2]]);
  assert.throws(() => cli.normalizeAsr({ foo: 1 }));
  assert.equal(cli.parseTimeArg('1.25'), 1.25); assert.equal(cli.parseTimeArg('word:x'), 'word:x');
});

test('health / new / projects / show', async () => {
  let r = await run(['health']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /השרת פעיל/);
  r = await run(['new', 'demo', '--name', 'דמו', '--size', '9:16']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /נוצר פרויקט "דמו" \(demo\) · 1080×1920/);
  r = await run(['new', 'Bad Id']);
  assert.equal(r.code, 1); assert.match(r.err, /מזהה פרויקט לא תקין/);
  r = await run(['projects']);
  assert.match(r.out, /demo/);
  r = await run(['projects', '--json']);
  assert.equal(JSON.parse(r.out)[0].id, 'demo');
});

test('import / add (path → server import) / text with --set', async () => {
  const vid = path.join(TMP, 'סרטון בדיקה.mp4');
  fs.writeFileSync(vid, 'x');
  let r = await run(['import', 'demo', vid]);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /סרטון בדיקה\.mp4/);
  r = await run(['add', 'demo', 'video', vid, '--at', '0', '--dur', '3', '--id', 'v1']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /✓ 1\s+addClip\s+→ v1/);
  r = await run(['add', 'demo', 'text', 'רגע!', '--at', '0.1', '--dur', '1', '--set', 'transform.y=-600', '--set', 'text.size=120', '--id', 'hook']);
  assert.equal(r.code, 0, r.err + r.out);
  const P = projects.get('demo');
  assert.equal(P.clips.v1.duration, 3); assert.equal(P.clips.hook.transform.y, -600); assert.equal(P.clips.hook.text.size, 120);
  assert.ok(calls.some((c) => c.includes('by:claude')), 'ops sent by claude');
});

test('transcript / words / time / captions / sfx / marker', async () => {
  const asr = path.join(TMP, 'asr.json');
  fs.writeFileSync(asr, JSON.stringify([['רֶגַע!', 0.12, 0.48], ['יש', 0.8, 0.95], ['לכם', 0.97, 1.2], ['שיר,', 1.22, 1.6], ['ובום!', 2.0, 2.5], ['ובום!', 3.0, 3.4]]));
  let r = await run(['transcript', 'demo', asr]);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['words', 'demo']);
  assert.match(r.out, /word:ובום!:1/);
  r = await run(['time', 'demo', 'word:ובום!:1:-0.1']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^2\.90/);
  r = await run(['captions', 'demo', '--style', 'chordix', '--max', '3', '--hot', 'ובום,לכם', '--yabs', '330', '--hook0']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /addCaptions/);
  const caps = Object.values(projects.get('demo').clips).filter((c) => c.type === 'caption');
  assert.ok(caps.length >= 3); assert.equal(Math.min(...caps.map((c) => c.start)), 0);
  assert.ok(caps.every((c) => c.transform.y === -630));
  r = await run(['sfx', 'demo', 'whoosh', '--at', 'word:ובום!', '--gain', '-14', '--len', '0.8', '--fade', '0.1']);
  assert.equal(r.code, 0, r.err + r.out);
  const s = Object.values(projects.get('demo').clips).find((c) => c.type === 'audio');
  assert.equal(s.start, 2); assert.equal(s.duration, 0.8); assert.ok(Math.abs(s.volume - Math.pow(10, -14 / 20)) < 1e-9);
  r = await run(['sfx', 'demo', 'לא-קיים', '--at', '1']);
  assert.equal(r.code, 2); assert.match(r.out, /✗/);
  r = await run(['marker', 'demo', 'word:ובום!:1', 'דרופ']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(projects.get('demo').markers[0].t, 3);
});

test('set / key / split / transition / effect / move / trim / dup / remove', async () => {
  let r = await run(['set', 'demo', 'v1', 'transform.scale=1.2', 'animIn.id=zoomIn']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['key', 'demo', 'v1', 'transform.scale', '0.5', '1.5', '--ease', 'spring']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['split', 'demo', 'v1', '1.5', '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const right = JSON.parse(r.out).results[0].ids[1];
  r = await run(['transition', 'demo', 'v1', 'crossfade', '--dur', '0.4']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['effect', 'demo', right, 'zoomPunch', '--param', 'strength=0.3']);
  assert.equal(r.code, 0, r.err + r.out);
  let P = projects.get('demo');
  assert.equal(P.clips.v1.transitionOut.id, 'crossfade'); assert.deepEqual(P.clips[right].effects[0].params, { strength: 0.3 });
  assert.equal(P.clips.v1.transform.scale, 1.2); assert.equal(P.clips.v1.animIn.id, 'zoomIn');
  r = await run(['dup', 'demo', 'hook', '--at', '5', '--id', 'hook2']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['move', 'demo', 'hook2', '6']);
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['trim', 'demo', 'hook2', '--end', '6.5']);
  assert.equal(r.code, 0, r.err + r.out);
  P = projects.get('demo');
  assert.equal(P.clips.hook2.start, 6); assert.equal(P.clips.hook2.duration, 0.5);
  r = await run(['remove', 'demo', 'hook2']);
  assert.equal(r.code, 0, r.err + r.out); assert.equal(projects.get('demo').clips.hook2, undefined);
  r = await run(['trim', 'demo', 'hook']);
  assert.equal(r.code, 1); assert.match(r.err, /חסר/);
});

test('show / validate / media in Hebrew', async () => {
  let r = await run(['show', 'demo']);
  assert.equal(r.code, 0, r.err);
  for (const s of ['פרויקט "דמו"', 'ערוצים', 'קליפים', '[כתוביות', 'מעבר→ crossfade', 'סמנים', 'תמלול: 6 מילים', 'מדיה:']) assert.ok(r.out.includes(s), `show missing ${s}\n${r.out}`);
  r = await run(['show', 'demo', '--json']);
  assert.equal(JSON.parse(r.out).id, 'demo');
  r = await run(['validate', 'demo']);
  assert.ok([0, 2].includes(r.code));
  r = await run(['media', 'demo']);
  assert.match(r.out, /m_mock/);
});

test('ops from file, stdin and inline JSON; failures → exit 2; --atomic', async () => {
  const f = path.join(TMP, 'ops.json');
  fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ summary: 'בדיקת ops', ops: [{ op: 'addClip', type: 'sticker', value: '🔥', start: 1 }, { op: 'splitClip', id: 'nope', at: 1 }] }));
  let r = await run(['ops', 'demo', f]);
  assert.equal(r.code, 2); assert.match(r.out, /✓ 1/); assert.match(r.out, /✗ 2\s+splitClip\s+הקליפ "nope" לא נמצא/);
  assert.ok(calls.includes('summary:בדיקת ops|by:claude'));
  r = await run(['ops', 'demo', '-'], { input: JSON.stringify([{ op: 'addMarker', t: 4, label: 'סוף' }]) });
  assert.equal(r.code, 0, r.err + r.out);
  r = await run(['ops', 'demo', '[{"op":"addMarker","t":5}]', '--json']);
  assert.equal(JSON.parse(r.out).results[0].ok, true);
  const rev = projects.get('demo').rev;
  r = await run(['ops', 'demo', '[{"op":"addMarker","t":6},{"op":"nope"}]', '--atomic']);
  assert.equal(r.code, 2);
  assert.ok(!projects.get('demo').markers.some((m) => m.t === 6), 'atomic: nothing applied');
  assert.equal(projects.get('demo').rev, rev + 1);
  r = await run(['ops', 'demo', path.join(TMP, 'missing.json')]);
  assert.equal(r.code, 1); assert.match(r.err, /לא נמצא/);
});

test('undo / redo', async () => {
  const before = projects.get('demo').markers.length;
  let r = await run(['marker', 'demo', '7', 'זמני']);
  assert.equal(projects.get('demo').markers.length, before + 1);
  r = await run(['undo', 'demo']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /בוטל/);
  assert.equal(projects.get('demo').markers.length, before);
  r = await run(['redo', 'demo']);
  assert.equal(projects.get('demo').markers.length, before + 1);
});

test('snapshot (word times resolved locally, --out copies), export report, check-audio fallback', async () => {
  const outDir = path.join(TMP, 'snaps');
  let r = await run(['snapshot', 'demo', '--at', '0.5,word:ובום!,end', '--scale', '0.5', '--out', outDir]);
  assert.equal(r.code, 0, r.err + r.out);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /צולמו 3 פריימים \(0\.50, 2\.00,/);
  assert.ok(lines.slice(1).every((l) => l.startsWith(outDir) && fs.existsSync(l)), r.out);
  r = await run(['export', 'demo', '--out', path.join(TMP, 'final.mp4'), '--lufs', '-14']);
  assert.equal(r.code, 0, r.err + r.out);
  for (const s of ['הייצוא הסתיים', 'final.mp4', '-14.10', 'עומד ביעד']) assert.ok(r.out.includes(s), `export missing ${s}\n${r.out}`);
  assert.ok(calls.some((c) => c.startsWith('export:') && c.includes('"lufs":-14') && c.includes('"check":true')));
  r = await run(['check-audio', 'demo']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /הקול מעל הרקע: מינימום 12\.40/);
  assert.ok(calls.some((c) => c.startsWith('export:') && c.includes('"stemsOnly":true')));
});

test('transcribe waits for the job; sounds; catalog; open; import-chordix; help', async () => {
  let r = await run(['transcribe', 'demo', 'm_mock1', '--captions', '--style', 'pill']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /תמלול: 2 מילים/);
  r = await run(['sounds', 'whoosh']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /snd_whoosh01/); assert.match(r.out, /mixkit/);
  r = await run(['catalog', 'luts']);
  assert.match(r.out, /teal-orange\.cube/);
  r = await run(['catalog', 'anims', '--json']);
  assert.ok(JSON.parse(r.out).clipAnims.in.length >= 18);
  r = await run(['catalog']);
  assert.match(r.out, /אנימציות קליפ/);
  r = await run(['open', 'demo']);
  assert.equal(r.code, 0); assert.match(r.out, /נפתח חלון העורך/);
  r = await run(['import-chordix', path.join(TMP, 'no-such-dir'), '--id', 'from-ws']);
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.err, /לא נמצא video\.json/); assert.ok(projects.has('from-ws'));
  r = await run(['help', 'ops']);
  assert.match(r.out, /addCaptions/); assert.match(r.out, /rippleDelete/);
  r = await run(['help', 'sfx']);
  assert.match(r.out, /cutx sfx/);
  r = await run(['bogus']);
  assert.equal(r.code, 1); assert.match(r.err, /פקודה לא מוכרת/);
});

test('server down → clear Hebrew error (no autostart for custom URL)', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'projects'], { env: { ...process.env, CUTX_URL: 'http://127.0.0.1:7714' }, cwd: ROOT });
    let se = '';
    child.stderr.on('data', (d) => { se += d; });
    child.on('close', (code) => resolve({ code, err: se }));
  });
  assert.equal(r.code, 1); assert.match(r.err, /השרת לא פעיל ב-http:\/\/127\.0\.0\.1:7714/);
});

let pass = 0, failN = 0;
for (const t of tests) {
  try { await t.fn(); pass++; }
  catch (e) { failN++; console.log(`✗ ${t.name}\n   ${(e && e.stack ? e.stack : e).toString().split('\n').slice(0, 6).join('\n   ')}`); }
}
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${tests.length} בדיקות CLI עברו${failN ? `, ${failN} נכשלו` : ''}`);
process.exitCode = failN ? 1 : 0;
