// Runs a small probe page in headless Chrome; the page posts its text to /result/probe.txt.
import { startServer, findChromeExe, OUT, profileDir, TEST_PORT } from './A-server.mjs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fsp from 'node:fs/promises';

const page = process.argv[2] || 'A-comp-probe.html';
let resolveDone;
const done = new Promise((r) => { resolveDone = r; });
const srv = await startServer({ port: TEST_PORT, onResult: (name, body) => { if (name === 'probe.txt') resolveDone(body.toString('utf8')); } });
const profile = profileDir('A-chrome-profile-probe');
const chrome = spawn(findChromeExe(), ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', `http://127.0.0.1:${TEST_PORT}/tools/tests/${page}`], { stdio: 'ignore' });
const t = setTimeout(() => resolveDone('TIMEOUT'), 60000);
console.log(await done);
clearTimeout(t);
spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
await srv.close();
await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
