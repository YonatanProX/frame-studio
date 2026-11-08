// Frame Studio — end-to-end test of the MCP server (mcp/server.mjs) against the REAL server.
// It spawns mcp/server.mjs exactly as Claude does (stdio, newline-delimited JSON-RPC), lets it auto-start
// server/main.mjs on a test port, and runs every tool. That includes a snapshot that must return valid PNG images
// and a short export. Test media is generated with ffmpeg (lavfi) in a temp folder whose name has Hebrew and spaces.
// The server it starts keeps all its data in that temp folder; at the end the test stops it and removes the folder.
//
//   node tools/tests/MCP.test.mjs [--port 7802] [--keep]   (the port must be free: the test starts its own server)
// Needs: Node 24+, ffmpeg + ffprobe, Google Chrome (headless rendering). Takes about 1–3 minutes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MCP = path.join(ROOT, 'mcp', 'server.mjs');
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const PORT = Number(argOf('--port') || process.env.MCP_TEST_PORT || 7802);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = argv.includes('--keep');
const TMP = path.join(process.env.FRAME_STUDIO_TEST_TMP || os.tmpdir(), `frame-studio-mcp-test-${process.pid}`);
const MEDIA_DIR = path.join(TMP, 'מדיה לבדיקה');
const PID = `mcp-test-${process.pid}`;

let passed = 0;
const created = new Set();
const t0 = Date.now();
const step = (name) => process.stdout.write(`  · ${name}\n`);

// ───────────── test media (ffmpeg lavfi) ─────────────

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`ffmpeg not found on PATH (${r.error.message})`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const F = {
  video: path.join(MEDIA_DIR, 'שוט פתיחה.mp4'),
  voice: path.join(MEDIA_DIR, 'קריינות.wav'),
  music: path.join(MEDIA_DIR, 'music bed.wav'),
  sfx: path.join(MEDIA_DIR, 'whoosh test.wav'),
  asr: path.join(MEDIA_DIR, 'asr.json'),
};
ff(['-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', F.video]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-af', 'volume=0.25', '-ar', '48000', F.voice]);
ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=4:amplitude=0.7', '-ar', '48000', F.music]);
ff(['-f', 'lavfi', '-i', 'anoisesrc=color=white:duration=0.6:amplitude=0.5', '-af', 'afade=t=out:st=0.2:d=0.4', '-ar', '48000', F.sfx]);
fs.writeFileSync(F.asr, JSON.stringify({ words: [{ word: 'שלום', start: 0.2, end: 0.6 }, { word: 'לכלם', start: 0.7, end: 1.3 }, { word: 'בתאבון', start: 1.6, end: 2.0 }] }));

// ───────────── JSON-RPC client over the child's stdio ─────────────

class Rpc {
  constructor(env) {
    this.child = spawn(process.execPath, [MCP], { cwd: os.homedir(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map();
    this.notes = [];
    this.badLines = [];
    this.stderr = '';
    this.seq = 0;
    let buf = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { this.badLines.push(line); continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p(msg); }
        else this.notes.push(msg);
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.exit = new Promise((r) => this.child.on('exit', (code) => r(code)));
  }
  write(s) { this.child.stdin.write(s); }
  send(obj) { this.write(JSON.stringify(obj) + '\n'); }
  request(method, params, { timeout = 60000, id } = {}) {
    const rid = id ?? ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error(`timeout waiting for ${method} (${rid})\n--- MCP stderr ---\n${this.stderr.slice(-3000)}`)); }, timeout);
      this.pending.set(rid, (msg) => { clearTimeout(timer); resolve(msg); });
      this.send({ jsonrpc: '2.0', id: rid, method, ...(params !== undefined ? { params } : {}) });
    });
  }
  async result(method, params, opts) {
    const m = await this.request(method, params, opts);
    if (m.error) throw new Error(`${method} → JSON-RPC error ${m.error.code}: ${m.error.message}`);
    return m.result;
  }
  /** tools/call → {text, images, isError, raw} */
  async call(name, args = {}, { timeout = 300000, allowError = false } = {}) {
    const r = await this.result('tools/call', { name, arguments: args }, { timeout });
    assert.ok(Array.isArray(r.content), `${name}: content must be an array`);
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const images = r.content.filter((c) => c.type === 'image');
    if (r.isError && !allowError) throw new Error(`${name} returned isError:\n${text}`);
    return { text, images, isError: !!r.isError, raw: r };
  }
  close() { try { this.child.stdin.end(); } catch { /* closed */ } return this.exit; }
}

async function health() {
  try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function http(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${t}`);
  return d;
}
function checkPng(img, maxSide) {
  assert.equal(img.mimeType, 'image/png');
  const b = Buffer.from(img.data, 'base64');
  assert.equal(b.readUInt32BE(0), 0x89504e47, 'PNG signature');
  assert.equal(b.subarray(12, 16).toString('latin1'), 'IHDR');
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  assert.ok(w > 16 && h > 16, `PNG size ${w}×${h}`);
  assert.ok(Math.max(w, h) <= maxSide, `PNG ${w}×${h} must fit ${maxSide}px`);
  assert.equal(b.subarray(b.length - 8, b.length - 4).toString('latin1'), 'IEND', 'PNG is complete');
  return { w, h, bytes: b.length };
}
const ok = (name) => { passed++; step(`ok  ${name}`); };

// ───────────── run ─────────────

// never touch a server (and data) that is not ours
if (await health()) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.error(`FAIL: port ${PORT} is already used by a running Frame Studio server. This test starts its own server with its own temp data — pick a free port: node tools/tests/MCP.test.mjs --port <port>`);
  process.exit(1);
}
// the auto-started server keeps ALL its data (projects, sound index, render profile) in the temp folder
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(DATA, 'Sounds'), { recursive: true });
fs.copyFileSync(F.sfx, path.join(DATA, 'Sounds', 'Whoosh fast swish.wav')); // <dataDir>/Sounds is always indexed
const rpc = new Rpc({
  FRAME_STUDIO_PORT: String(PORT), FRAME_STUDIO_MCP_DRY_OPEN: '1', FRAME_STUDIO_MCP_WAIT: '280',
  FRAME_STUDIO_DATA: DATA, FRAME_STUDIO_CACHE: path.join(TMP, 'cache'), FRAME_STUDIO_NO_STARTER: '1',
});
let failure = null;

try {
  console.log(`MCP test · port ${PORT} · temp ${TMP}`);

  // ── protocol ──
  const init = await rpc.result('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'frame-studio');
  assert.ok(init.capabilities.tools && init.capabilities.resources && init.capabilities.prompts);
  assert.match(init.instructions, /snapshot/);
  assert.match(init.instructions, /לולאת הזהב/);
  rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok('initialize (2025-06-18) + instructions');

  for (const [asked, want] of [['2024-11-05', '2024-11-05'], ['2025-03-26', '2025-03-26'], ['1999-01-01', '2025-11-25']]) {
    const other = new Rpc({ FRAME_STUDIO_PORT: String(PORT) });
    const r = await other.result('initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'neg', version: '1' } });
    assert.equal(r.protocolVersion, want, `negotiation ${asked}`);
    assert.equal(await other.close(), 0, 'exits 0 when stdin closes');
  }
  ok('protocol version negotiation + clean exit on stdin close');

  assert.deepEqual(await rpc.result('ping'), {});
  const bad = await rpc.request('no/such/method');
  assert.equal(bad.error.code, -32601);
  const unk = await rpc.request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unk.error.code, -32602);
  const parseErr = new Promise((resolve) => {
    const before = rpc.notes.length;
    const iv = setInterval(() => { const m = rpc.notes.slice(before).find((x) => x.error && x.error.code === -32700); if (m) { clearInterval(iv); resolve(m); } }, 20);
  });
  rpc.write('{this is not json\n');
  assert.equal((await parseErr).id, null);
  // a request split in the middle of a Hebrew (multi-byte) character must still parse
  const req = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'split-1', method: 'tools/call', params: { name: 'get_editing_guide', arguments: { topic: 'כתוביות' } } }) + '\n', 'utf8');
  const cut = req.indexOf(Buffer.from('כ', 'utf8')) + 1;
  const splitP = new Promise((resolve) => rpc.pending.set('split-1', resolve));
  rpc.write(req.subarray(0, cut)); await new Promise((r) => setTimeout(r, 50)); rpc.write(req.subarray(cut));
  const split = await splitP;
  assert.ok(split.result && !split.result.isError && /4\.9/.test(split.result.content[0].text), 'split UTF-8 request');
  ok('ping, -32601, -32602, -32700, UTF-8 split across writes');

  const { tools } = await rpc.result('tools/list');
  const names = tools.map((t) => t.name);
  for (const n of ['frame_studio_status', 'open_editor', 'list_projects', 'create_project', 'get_project', 'import_media', 'apply_ops', 'get_catalog',
    'search_sounds', 'set_transcript', 'transcribe', 'snapshot', 'export_video', 'check_audio', 'balance_audio', 'undo', 'redo', 'get_editing_guide', 'wait_job']) {
    assert.ok(names.includes(n), `tool ${n}`);
  }
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema`);
    assert.ok(t.description.length > 40, `${t.name} description`);
    assert.match(t.name, /^[a-z_]{3,40}$/);
  }
  ok(`tools/list (${tools.length} tools)`);

  const { resources } = await rpc.result('resources/list');
  assert.ok(resources.some((r) => r.uri === 'frame-studio://docs/claude-api'));
  const doc = await rpc.result('resources/read', { uri: 'frame-studio://docs/claude-api' });
  assert.match(doc.contents[0].text, /Claude Editing Reference/);
  assert.equal((await rpc.request('resources/read', { uri: 'frame-studio://nope' })).error.code, -32002);
  const { prompts } = await rpc.result('prompts/list');
  assert.ok(prompts.some((p) => p.name === 'edit_video'));
  const pg = await rpc.result('prompts/get', { name: 'edit_video', arguments: { request: 'סרטון קצר' } });
  assert.match(pg.messages[0].content.text, /סרטון קצר/);
  ok('resources/list + read, prompts/list + get');

  // ── tools that need no project ──
  const st = await rpc.call('frame_studio_status', {}, { timeout: 60000 });
  assert.match(st.text, /is running/);
  assert.ok(await health(), 'server is up (auto-started by the MCP server)');
  assert.match(st.text, /just started in the background/);
  ok('frame_studio_status (auto-started the server)');

  const g = await rpc.call('get_editing_guide');
  assert.match(g.text, /apply_ops/); assert.match(g.text, /Reference sections/);
  assert.match((await rpc.call('get_editing_guide', { topic: 'setKeyframes' })).text, /fields:/);
  assert.match((await rpc.call('get_editing_guide', { topic: '9.10' })).text, /balance/);
  assert.match((await rpc.call('get_editing_guide', { topic: 'zzzz-nothing' })).text, /Nothing found/);
  ok('get_editing_guide (default, op, section, miss)');

  for (const kind of ['transitions', 'effects', 'filters', 'clip-anims', 'text-anims', 'caption-styles', 'text-presets', 'stickers', 'shapes', 'fonts', 'luts']) {
    const c = await rpc.call('get_catalog', { kind });
    assert.ok(c.text.split('\n').length > 3, `catalog ${kind} has entries`);
  }
  assert.match((await rpc.call('get_catalog', { kind: 'transitions' })).text, /crossfade/);
  assert.match((await rpc.call('get_catalog', { kind: 'caption-styles' })).text, /popWords/);
  const badKind = await rpc.call('get_catalog', { kind: 'nope' }, { allowError: true });
  assert.ok(badKind.isError && /Allowed/.test(badKind.text));
  ok('get_catalog (11 kinds + invalid enum → isError)');

  for (let i = 0; i < 300; i++) { // the library indexes in the background after the server starts
    const s = await http('GET', '/api/library/sounds/status');
    if (s.ready && !s.indexing) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const snd = await rpc.call('search_sounds', { query: 'whoosh swish', limit: 10 });
  const soundId = (/^([0-9a-f]{12})\s.*Whoosh fast swish/im.exec(snd.text) || [])[1];
  assert.ok(soundId, `the test sound in <data>/Sounds is found: ${snd.text}`);
  assert.match((await rpc.call('search_sounds', { query: 'zzqqxx-nothing' })).text, /No sounds match|empty/);
  ok(`search_sounds (found ${soundId}; no match → hint)`);

  // ── project lifecycle ──
  const cp = await rpc.call('create_project', { name: 'בדיקת MCP', id: PID, format: '9:16', fps: 30 });
  created.add(PID);
  assert.match(cp.text, new RegExp(`id ${PID}`)); assert.match(cp.text, /1080×1920/);
  const dup = await rpc.call('create_project', { name: 'x', id: PID }, { allowError: true });
  assert.ok(dup.isError && /already exists/.test(dup.text));
  const cp2 = await rpc.call('create_project', { name: 'סרטון בלי אותיות לטיניות', format: '16:9' });
  const id2 = /id ([a-z0-9-]+)/.exec(cp2.text)[1];
  created.add(id2);
  assert.match(id2, /^video-\d{4}-\d{2}-\d{2}/); assert.match(cp2.text, /1920×1080/);
  const lp = await rpc.call('list_projects');
  assert.ok(lp.text.includes(PID) && lp.text.includes(id2));
  const oe = await rpc.call('open_editor', { project: PID });
  assert.match(oe.text, new RegExp(`project=${PID}`));
  const missing = await rpc.call('get_project', { project: 'no-such-project-xyz' }, { allowError: true });
  assert.ok(missing.isError && /not found/.test(missing.text));
  const byName = await rpc.call('get_project', { project: 'בדיקת MCP' });
  assert.match(byName.text, new RegExp(PID));
  ok('create_project (id, Hebrew-only name → slug, duplicate), list_projects, open_editor (dry), get_project by name');

  const im = await rpc.call('import_media', { project: PID, paths: [F.video, F.voice, F.music, F.sfx] }, { timeout: 180000 });
  const mid = (name) => { const m = new RegExp(`(m_[A-Za-z0-9_-]+)\\s.*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(im.text); assert.ok(m, `media id for ${name}\n${im.text}`); return m[1]; };
  const M = { video: mid('שוט פתיחה.mp4'), voice: mid('קריינות.wav'), music: mid('music bed.wav'), sfx: mid('whoosh test.wav') };
  assert.ok(!/\[processing\]/.test(im.text), 'media ready');
  const imBad = await rpc.call('import_media', { project: PID, paths: ['relative/file.mp4'] }, { allowError: true });
  assert.ok(imBad.isError && /absolute/.test(imBad.text));
  ok(`import_media (Hebrew paths, waits until ready) → ${Object.values(M).join(', ')}`);

  // a folder → the media files inside it (asr.json is skipped); the same files are not imported twice
  const imDir = await rpc.call('import_media', { project: PID, paths: [MEDIA_DIR] }, { timeout: 180000 });
  assert.match(imDir.text, /Folder .*: 4 media file\(s\), 1 other file\(s\) skipped/);
  for (const m of Object.values(M)) assert.ok(imDir.text.includes(m), `folder import reuses ${m}\n${imDir.text}`);
  assert.equal(Object.keys((await http('GET', `/api/projects/${PID}`)).media).length, 4, 'no duplicate media');
  const noMediaDir = path.join(TMP, 'תיקייה בלי מדיה');
  fs.mkdirSync(noMediaDir, { recursive: true });
  fs.writeFileSync(path.join(noMediaDir, 'notes.txt'), 'x');
  const imEmptyDir = await rpc.call('import_media', { project: PID, paths: [noMediaDir] }, { allowError: true });
  assert.ok(imEmptyDir.isError && /has no video, image or audio files/.test(imEmptyDir.text) && /notes\.txt/.test(imEmptyDir.text), imEmptyDir.text);
  const imNotMedia = await rpc.call('import_media', { project: PID, paths: [F.asr] }, { allowError: true });
  assert.ok(imNotMedia.isError && /Not a supported video, image or audio file/.test(imNotMedia.text), imNotMedia.text);
  assert.ok(!/message above is in Hebrew/.test(imNotMedia.text));
  const imMissing = await rpc.call('import_media', { project: PID, paths: [path.join(MEDIA_DIR, 'אין כזה.mp4')] }, { allowError: true });
  assert.ok(imMissing.isError && /Not found/.test(imMissing.text));
  ok('import_media (folder → its media files, folder without media, non-media file, missing file → English errors)');

  // unknown arguments are refused (a typo must not change what a tool does); obvious aliases are renamed
  const typo = await rpc.call('create_project', { name: 'x', foo: 1, id: `${PID}-typo` }, { allowError: true });
  assert.ok(typo.isError && /Unknown argument "foo" for create_project/.test(typo.text) && /Allowed: name, format, fps, id/.test(typo.text), typo.text);
  assert.ok(!(await http('GET', '/api/projects')).some((p) => p.id === `${PID}-typo`), 'nothing created on a typo');
  const noArgs = await rpc.call('list_projects', { verbose: true }, { allowError: true });
  assert.ok(noArgs.isError && /takes no arguments/.test(noArgs.text));
  const aliasGp = await rpc.call('get_project', { projectId: PID });
  assert.ok(aliasGp.text.includes(PID) && /"projectId" was read as "project"/.test(aliasGp.text), aliasGp.text);
  const both = await rpc.call('get_project', { project: PID, projectId: PID }, { allowError: true });
  assert.ok(both.isError && /Unknown argument "projectId"/.test(both.text));
  ok('unknown arguments → isError naming them; aliases (projectId → project) renamed with a note');

  // empty project: export refuses, snapshot says why the frame is black; server errors come with English + route
  const exEmpty = await rpc.call('export_video', { project: id2 }, { allowError: true });
  assert.ok(exEmpty.isError && /The project is empty/.test(exEmpty.text) && /Nothing was exported/.test(exEmpty.text), exEmpty.text);
  assert.ok(!fs.existsSync(path.join(DATA, 'projects', id2, 'exports')) || !fs.readdirSync(path.join(DATA, 'projects', id2, 'exports')).length, 'no file written');
  const snEmpty = await rpc.call('snapshot', { project: id2, times: [0] }, { timeout: 240000 });
  assert.equal(snEmpty.images.length, 1);
  assert.match(snEmpty.text, /The project is empty/);
  const unEmpty = await rpc.call('undo', { project: id2 }, { allowError: true });
  assert.ok(unEmpty.isError && new RegExp(`409 on POST /api/projects/${id2}/undo: Nothing to undo`).test(unEmpty.text), unEmpty.text);
  const wjBad = await rpc.call('wait_job', { job_id: 'no-such-job-123' }, { allowError: true });
  assert.ok(wjBad.isError && /No job "no-such-job-123"/.test(wjBad.text), wjBad.text);
  ok('empty project (export → isError, snapshot → note), server errors in English with the route, wait_job unknown id');

  const ops = [
    { op: 'addClip', type: 'video', mediaId: M.video, start: 0, id: 's1', muteAudio: true },
    { op: 'splitClip', id: 's1', at: 2, newId: 's2' },
    { op: 'setTransition', id: 's1', transition: 'crossfade', duration: 0.4 },
    { op: 'addClip', type: 'text', id: 'title', content: 'שלום עולם', start: 0, duration: 2, yAbs: 700, preset: 'title', animIn: 'pop' },
    { op: 'addClip', type: 'audio', mediaId: M.voice, start: 0.2, role: 'voice', id: 'vo' },
    { op: 'addClip', type: 'audio', mediaId: M.music, start: 0, role: 'music', id: 'mus', volume: 1 },
    { op: 'sfx', sound: F.sfx, at: 1.0, gain_db: -6, len: 0.6, id: 'wh' },
    { op: 'sfx', sound: soundId, at: 2.5, gain_db: -14, len: 0.5, id: 'wh2' },
  ];
  const ao = await rpc.call('apply_ops', { project: PID, ops, summary: 'בדיקה: שוטים, כותרת, קריינות, מוזיקה ווש' });
  assert.ok(!/✗/.test(ao.text), ao.text);
  assert.match(ao.text, /הכול הצליח/);
  const size0 = (await http('GET', `/api/projects/${PID}`)).clips.title.text.size;
  const atom = await rpc.call('apply_ops', { project: PID, atomic: true, summary: 'x', ops: [{ op: 'updateClip', id: 'title', set: { 'text.size': 133 } }, { op: 'updateClip', id: 'no-such-clip', set: { x: 1 } }] }, { allowError: true });
  assert.ok(atom.isError && /nothing was saved/.test(atom.text));
  assert.equal((await http('GET', `/api/projects/${PID}`)).clips.title.text.size, size0, 'atomic failure saves nothing');
  assert.notEqual(size0, 133);
  const part = await rpc.call('apply_ops', { project: PID, summary: 'חלקי', ops: JSON.stringify([{ op: 'addMarker', t: 1, label: 'שיא', id: 'mk1' }, { op: 'moveClip', id: 'nope', start: 1 }]) });
  assert.ok(!part.isError && /1 op\(s\) failed/.test(part.text));
  const noOps = await rpc.call('apply_ops', { project: PID, summary: 'x', ops: [] }, { allowError: true });
  assert.ok(noOps.isError);
  const missingArg = await rpc.call('apply_ops', { project: PID, ops: [{ op: 'addMarker', t: 2 }] }, { allowError: true });
  assert.ok(missingArg.isError && /summary/.test(missingArg.text));
  ok('apply_ops (build, atomic rollback, partial failure, ops as JSON string, validation)');

  const st1 = await rpc.call('set_transcript', { project: PID, asr_file: F.asr, script: 'שלום לכולם! בתיאבון!', hot: ['בתיאבון!'], media_id: M.voice });
  assert.match(st1.text, /לכולם!/); assert.match(st1.text, /בתיאבון!/);
  const st2 = await rpc.call('set_transcript', { project: PID, words: [['שלום', 0.2, 0.6], ['לכולם!', 0.7, 1.3], ['בתיאבון!', 1.6, 2.0]] });
  assert.ok(!/✗/.test(st2.text));
  const stBad = await rpc.call('set_transcript', { project: PID, words: [['x', 'a', 'b']] }, { allowError: true });
  assert.ok(stBad.isError);
  const cap = await rpc.call('apply_ops', { project: PID, summary: 'כתוביות', ops: [{ op: 'addCaptions', words: 'transcript', style: 'popWords', yAbs: 1250, hook0: true }] });
  assert.ok(!/✗/.test(cap.text), cap.text);
  ok('set_transcript (asr_file + script alignment, words, invalid) + captions');

  const gp = await rpc.call('get_project', { project: PID });
  for (const s of ['שלום עולם', M.video, 'word:בתיאבון!', 's1', 's2', 'mk1']) assert.ok(gp.text.includes(s), `get_project shows ${s}`);
  const gj = JSON.parse((await rpc.call('get_project', { project: PID, detail: 'json' })).text);
  assert.equal(gj.id, PID); assert.ok(gj.clips.title);
  ok('get_project (summary with media + word refs, json)');

  const sn = await rpc.call('snapshot', { project: PID, times: [0.5, 'word:לכולם!', 'end'] }, { timeout: 240000 });
  assert.equal(sn.images.length, 3, sn.text);
  const dims = sn.images.map((im2) => checkPng(im2, 1000));
  assert.ok(dims.every((d) => d.h >= 900 && d.w < d.h), `9:16 frames close to 1000 px tall: ${JSON.stringify(dims)}`);
  assert.match(sn.text, /Frame 3 at 3\.97s/, '"end" is the last frame, not the black frame after it');
  assert.ok(dims[2].bytes > 40000, `the last frame has content (${dims[2].bytes} bytes)`);
  assert.match(sn.text, /Frame 2 at 0\.70s/);
  const sheet = await rpc.call('snapshot', { project: PID, times: [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8] }, { timeout: 240000 });
  assert.equal(sheet.images.length, 1, 'more than 6 times → one contact sheet');
  checkPng(sheet.images[0], 1600);
  assert.match(sheet.text, /Contact sheet/);
  const snBad = await rpc.call('snapshot', { project: PID, times: ['word:לא-קיים'] }, { allowError: true });
  assert.ok(snBad.isError);
  ok(`snapshot (3 PNG frames ${dims.map((d) => `${d.w}×${d.h}`).join(', ')}; 8 times → contact sheet; bad word → isError)`);

  // wait_job: a job started outside the tool returns its images through wait_job
  const job = await http('POST', `/api/projects/${PID}/snapshot`, { times: [1], scale: 0.25 });
  const wj = await rpc.call('wait_job', { job_id: job.id }, { timeout: 240000 });
  assert.equal(wj.images.length, 1); checkPng(wj.images[0], 1000);
  ok('wait_job (snapshot job → image)');

  // cancellation: no reply for the cancelled call, the server keeps answering
  const cancelId = 'cancel-me';
  let cancelledReply = null;
  rpc.pending.set(cancelId, (m) => { cancelledReply = m; });
  rpc.send({ jsonrpc: '2.0', id: cancelId, method: 'tools/call', params: { name: 'check_audio', arguments: { project: PID } } });
  await new Promise((r) => setTimeout(r, 300));
  rpc.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelId, reason: 'test' } });
  assert.deepEqual(await rpc.result('ping'), {});
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(cancelledReply, null, 'no response after cancel');
  rpc.pending.delete(cancelId);
  ok('notifications/cancelled');

  const ca = await rpc.call('check_audio', { project: PID }, { timeout: 240000 });
  assert.match(ca.text, /LUFS|dB/);
  const rev0 = (await http('GET', `/api/projects/${PID}`)).rev;
  const bd = await rpc.call('balance_audio', { project: PID, dryRun: true }, { timeout: 240000 }); // camelCase alias of dry_run
  assert.match(bd.text, /Voice-over balance/);
  assert.match(bd.text, /plan only \(dry_run\)/);
  assert.match(bd.text, /"dryRun" was read as "dry_run"/);
  assert.equal((await http('GET', `/api/projects/${PID}`)).rev, rev0, 'dryRun changed nothing');
  const bl = await rpc.call('balance_audio', { project: PID }, { timeout: 280000 });
  assert.match(bl.text, /Target reached|Target not reached|Nothing to balance|Stopped after/);
  ok(`check_audio + balance_audio (${(/(✓ Target reached[^\n]*|✗ Target not reached[^\n]*|No active speech[^\n]*)/.exec(bl.text) || [''])[0].slice(0, 70)})`);

  const un = await rpc.call('undo', { project: PID });
  assert.match(un.text, /Undone/);
  const re = await rpc.call('redo', { project: PID });
  assert.match(re.text, /Redone/);
  ok('undo / redo');

  const tr = await rpc.call('transcribe', { project: PID, media: M.voice }, { allowError: true, timeout: 280000 });
  if (tr.isError) assert.match(tr.text, /install-transcription|set_transcript|נכשל|failed/);
  else assert.match(tr.text, /Transcribed/);
  ok(`transcribe (${tr.isError ? 'not installed / failed → explained' : 'ran local Whisper'})`);

  const outFile = path.join(TMP, 'ייצוא', 'בדיקה.mp4');
  const ex = await rpc.call('export_video', { project: PID, out: outFile, from: 0, to: 2 }, { timeout: 300000 });
  assert.match(ex.text, /Export finished/); assert.match(ex.text, /LUFS/);
  assert.ok(fs.existsSync(outFile) && fs.statSync(outFile).size > 10000, 'mp4 written');
  const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
  const dur = Number(pr.stdout.trim());
  assert.ok(Math.abs(dur - 2) < 0.2, `export duration ${dur}`);
  ok(`export_video (2 s MP4, ${dur.toFixed(2)} s, report with LUFS)`);

  assert.deepEqual(rpc.badLines, [], 'stdout carries only JSON-RPC lines');
  ok('stdout is clean JSON-RPC');
} catch (e) {
  failure = e;
} finally {
  // cleanup: the test projects, our server (all its data is in TMP), then TMP itself (--keep keeps TMP for a look)
  if (!KEEP) {
    for (const id of created) {
      try { await http('DELETE', `/api/projects/${id}`); } catch (e) { console.error(`cleanup ${id}: ${e.message}`); }
    }
  }
  const code = await rpc.close();
  if (!failure && code !== 0) failure = new Error(`MCP server exit code ${code}`);
  {
    try { await http('POST', '/api/shutdown', {}); } catch { /* already down */ }
    for (let i = 0; i < 50 && (await health()); i++) await new Promise((r) => setTimeout(r, 200));
    // our own headless render Chrome (profile in TMP/cache): give it 15 s to leave by itself, then stop it
    let pid = null;
    try { pid = Number(fs.readFileSync(path.join(TMP, 'cache', '.chrome-render', 'frame-studio-chrome.pid'), 'utf8').trim()) || null; } catch { /* never rendered */ }
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; pid && i < 75 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
    if (pid && alive()) { try { process.kill(pid); } catch { /* gone */ } await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!KEEP) {
    // the headless render browser may still hold its profile (in TMP/cache) for a moment after the server exits
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }); }
    catch (e) { console.error(`(could not remove ${TMP} yet: ${e.code}; delete it later)`); }
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (failure) {
  console.error(`\nFAIL after ${passed} checks (${secs} s): ${failure.stack || failure}`);
  console.error(`--- MCP stderr (tail) ---\n${rpc.stderr.slice(-2500)}`);
  process.exitCode = 1;
} else {
  console.log(`\nMCP: all ${passed} checks passed (${secs} s)`);
}
