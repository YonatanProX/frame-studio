// Frame Studio — quick, self-contained test of the MCP server protocol (mcp/server.mjs): no Frame Studio server,
// no Chrome, no media. It checks JSON-RPC framing, version negotiation, tools/list schemas, resources, prompts, argument
// validation, error codes and the tools that work without a server. The full end-to-end test is MCP.test.mjs.
//   node tools/tests/MCP-proto.test.mjs

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP = path.join(ROOT, 'mcp', 'server.mjs');
const PORT = 47000 + (process.pid % 1000); // nothing should listen here; autostart is off

function start(env = {}) {
  const child = spawn(process.execPath, [MCP], {
    cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, FRAME_STUDIO_PORT: String(PORT), FRAME_STUDIO_NO_AUTOSTART: '1', ...env },
  });
  const c = { child, pending: new Map(), extra: [], raw: [], seq: 0 };
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let nl;
    while ((nl = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      c.raw.push(line);
      const msg = JSON.parse(line); // throws → test fails: stdout must be pure JSON-RPC
      const p = c.pending.get(msg.id);
      if (p) { c.pending.delete(msg.id); p(msg); } else c.extra.push(msg);
    }
  });
  c.stderr = '';
  child.stderr.on('data', (d) => { c.stderr += d; });
  c.exit = new Promise((r) => child.on('exit', r));
  c.req = (method, params, id = ++c.seq) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}\n${c.stderr}`)), 20000);
    c.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
  c.call = async (name, args) => {
    const m = await c.req('tools/call', { name, arguments: args });
    assert.ok(m.result, `${name}: ${JSON.stringify(m.error)}`);
    return { text: m.result.content.map((x) => x.text || '').join('\n'), isError: !!m.result.isError, content: m.result.content };
  };
  return c;
}

let n = 0;
const ok = (s) => { n++; console.log(`  ok  ${s}`); };

const c = start();
const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proto-test', version: '1' } });
assert.equal(init.result.protocolVersion, '2025-06-18');
assert.equal(init.result.serverInfo.name, 'frame-studio');
assert.ok(init.result.instructions.length > 500 && init.result.instructions.length < 4000, 'instructions are concise');
c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
for (const [asked, want] of [['2024-11-05', '2024-11-05'], ['2025-03-26', '2025-03-26'], ['2025-11-25', '2025-11-25'], ['2099-01-01', '2025-11-25']]) {
  const o = start();
  assert.equal((await o.req('initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'x', version: '1' } })).result.protocolVersion, want);
  o.child.stdin.end();
  assert.equal(await o.exit, 0);
}
ok('initialize + version negotiation + exit 0 on stdin end');

const { tools } = (await c.req('tools/list')).result;
assert.equal(tools.length, 19);
for (const t of tools) {
  const s = t.inputSchema;
  assert.equal(s.type, 'object', t.name);
  for (const r of s.required || []) assert.ok(s.properties[r], `${t.name}: required "${r}" is a property`);
  for (const [k, p] of Object.entries(s.properties || {})) assert.ok(p.type || p.anyOf, `${t.name}.${k} has a type`);
  assert.ok(t.description.length >= 40 && t.description.length < 4000, `${t.name} description length`);
  assert.equal(typeof t.title, 'string');
}
assert.ok(tools.find((t) => t.name === 'apply_ops').description.includes('addCaptions'));
ok(`tools/list: ${tools.length} tools with valid schemas`);

assert.match((await c.call('get_editing_guide', {})).text, /Most used ops/);
assert.match((await c.call('get_editing_guide', { topic: 'splitClip' })).text, /newId/);
assert.match((await c.call('get_editing_guide', { topic: '4.7' })).text, /setTransition/);
const cat = await c.call('get_catalog', { kind: 'transitions' });
assert.ok(!cat.isError && /crossfade/.test(cat.text) && /params:|default/.test(cat.text));
assert.match((await c.call('get_catalog', { kind: 'clip-anims' })).text, /animIn/);
ok('get_editing_guide + get_catalog work without a server');

const st = await c.call('frame_studio_status', {});
assert.ok(st.isError && /not running/.test(st.text) && /לא פעיל/.test(st.text), st.text);
const miss = await c.call('create_project', { format: '9:16' });
assert.ok(miss.isError && /Missing required argument "name"/.test(miss.text));
const badEnum = await c.call('create_project', { name: 'x', format: '7:3' });
assert.ok(badEnum.isError && /Allowed: 9:16/.test(badEnum.text));
const badType = await c.call('snapshot', { project: 'p', times: 'not-a-list', scale: 'big' });
assert.ok(badType.isError);
ok('no server → isError (Hebrew + English); argument validation');

assert.equal((await c.req('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
assert.equal((await c.req('nope/nope')).error.code, -32601);
assert.deepEqual((await c.req('ping')).result, {});
const before = c.extra.length;
c.child.stdin.write('not json at all\n');
c.child.stdin.write(JSON.stringify([{ jsonrpc: '2.0', id: 'b1', method: 'ping' }, { jsonrpc: '2.0', id: 'b2', method: 'ping' }]) + '\n');
await new Promise((r) => setTimeout(r, 300));
const got = c.extra.slice(before);
assert.ok(got.some((m) => m.error && m.error.code === -32700 && m.id === null), 'parse error');
assert.ok(got.some((m) => m.id === 'b1') && got.some((m) => m.id === 'b2'), 'batch');
ok('error codes -32602 / -32601 / -32700, ping, batch');

const resList = (await c.req('resources/list')).result.resources;
assert.ok(resList.some((r) => r.uri === 'frame-studio://docs/claude-api'));
assert.ok((await c.req('resources/read', { uri: 'frame-studio://docs/claude-api' })).result.contents[0].text.length > 10000);
assert.deepEqual((await c.req('resources/templates/list')).result, { resourceTemplates: [] });
assert.ok((await c.req('prompts/get', { name: 'edit_video', arguments: { request: 'r' } })).result.messages.length === 1);
assert.equal((await c.req('prompts/get', { name: 'edit_video', arguments: {} })).error.code, -32602);
ok('resources + prompts');

// framing: a request split inside a multi-byte character; a line separator (U+2028) in the output is escaped
const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'u1', method: 'tools/call', params: { name: 'get_editing_guide', arguments: { topic: 'שלום\u2028עולם' } } }) + '\n');
const cut = body.indexOf(Buffer.from('ש')) + 1;
const pu = new Promise((r) => c.pending.set('u1', r));
c.child.stdin.write(body.subarray(0, cut));
await new Promise((r) => setTimeout(r, 50));
c.child.stdin.write(body.subarray(cut));
const u = await pu;
assert.match(u.result.content[0].text, /שלום\u2028עולם/);
assert.ok(c.raw.every((l) => !l.includes('\u2028')), 'U+2028 never raw on the wire');
ok('UTF-8 split across writes, U+2028 escaped');

c.child.stdin.end();
assert.equal(await c.exit, 0);
console.log(`MCP protocol: all ${n} checks passed`);
