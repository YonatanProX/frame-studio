// Frame Studio — runs the self-contained development tests (no server, no Chrome, no media files needed).
//   npm test          or   node tools/run-tests.mjs [--verbose]
// The other scripts in tools/tests/ need a running server, Chrome, ffmpeg or local media — run them one by one
// (see CONTRIBUTING.md).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');

const TESTS = [
  ['M-ops.test.mjs', 'data model, keyframes, operation engine'],
  ['X-balance.test.mjs', 'cutx balance planning'],
  ['X-align.test.mjs', 'script / ASR alignment (synthetic Hebrew fixtures)'],
  ['M-docs.test.mjs', 'every example in docs/CLAUDE-API.md runs'],
  ['L-ops-test.mjs', 'timeline edit planning (app/tl-ops.js)'],
  ['M-cli.test.mjs', 'cutx CLI against a mock server (port 7713)'],
  ['MCP-proto.test.mjs', 'MCP server for Claude: protocol, tools/list, validation (no server)'],
];

let failed = 0;
const t0 = Date.now();
for (const [file, what] of TESTS) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, 'tests', file)], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
  const ok = r.status === 0;
  if (!ok) failed++;
  const last = out.split(/\r?\n/).filter((l) => l.trim()).pop() || '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(20)} ${String(((Date.now() - t) / 1000).toFixed(1)).padStart(5)} s  ${what}`);
  if (!ok || verbose) console.log(out.replace(/^/gm, '      ') + '\n');
  else if (last) console.log(`      ${last.trim()}`);
}
console.log(`\n${failed ? `${failed} of ${TESTS.length} test files FAILED` : `all ${TESTS.length} test files passed`} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exitCode = failed ? 1 : 0;
