// tools/tests/R-run.mjs — agent R render self-test runner.
//   node tools/tests/R-run.mjs [--keep] [--timeout 600]
// 1. generates test assets with ffmpeg into tools/tests/R-assets (once)
// 2. starts the static test server on 127.0.0.1:7791
// 3. runs headless Chrome (SwiftShader WebGL2) on tools/tests/R-test.html
// 4. the page renders every transition/effect/filter/feature, posts contact sheets + JSON results
// Results land in tools/tests/R-out (R-results.json + R-*.png).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startServer, ASSETS, OUT, ROOT } from './R-server.mjs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 7791;
const args = process.argv.slice(2);
const timeoutS = Number(args[args.indexOf('--timeout') + 1]) || 900;
const page = args.includes('--page') ? args[args.indexOf('--page') + 1] : 'R-test.html';

function ff(argv) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + argv.join(' ') + '\n' + r.stderr);
}

function makeCube(file) {
  const N = 17;
  const lines = ['TITLE "R channel rotate + warm"', `LUT_3D_SIZE ${N}`];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const R = r / (N - 1), G = g / (N - 1), B = b / (N - 1);
    lines.push(`${(G * 0.9 + 0.1).toFixed(6)} ${B.toFixed(6)} ${R.toFixed(6)}`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function makeAssets() {
  fs.mkdirSync(path.join(ASSETS, 'luts'), { recursive: true });
  const manifest = {
    m_pat: 'pattern.mp4', m_cnt: 'counter.mp4', m_photo: 'photo.png', m_card: 'card.png',
    m_alpha: 'alpha.png', m_green: 'green.png', m_pat2: 'pattern-land.mp4',
  };
  const A = (f) => path.join(ASSETS, f);
  const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-crf', '18', '-preset', 'veryfast', '-movflags', '+faststart'];
  if (!fs.existsSync(A('pattern.mp4'))) ff(['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=4', ...enc, A('pattern.mp4')]);
  if (!fs.existsSync(A('pattern-land.mp4'))) ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', ...enc, A('pattern-land.mp4')]);
  if (!fs.existsSync(A('counter.mp4'))) ff(['-f', 'lavfi', '-i', "color=c=black:size=64x64:rate=30:duration=3,format=gray,geq=lum='mod(N*5,256)'", ...enc, A('counter.mp4')]);
  if (!fs.existsSync(A('photo.png'))) ff(['-f', 'lavfi', '-i', "nullsrc=size=720x1280,format=rgb24,geq=r='255*X/W':g='255*Y/H':b='128+120*sin(X/45)*cos(Y/60)'", '-vf',
    'drawbox=x=80:y=120:w=200:h=200:color=white:t=fill,drawbox=x=440:y=900:w=200:h=260:color=black:t=fill,drawbox=x=300:y=520:w=120:h=240:color=0x3fe0f5:t=fill,drawgrid=w=90:h=90:t=3:c=white@0.6',
    '-frames:v', '1', A('photo.png')]);
  if (!fs.existsSync(A('card.png'))) ff(['-f', 'lavfi', '-i', 'color=c=0x13b6e4:size=360x640', '-vf',
    'drawbox=x=0:y=200:w=360:h=80:color=white:t=fill,drawbox=x=60:y=400:w=240:h=120:color=0x071822:t=fill,drawbox=x=40:y=40:w=80:h=80:color=0xff8a66:t=fill,drawgrid=w=40:h=40:t=1:c=white@0.4',
    '-frames:v', '1', A('card.png')]);
  if (!fs.existsSync(A('alpha.png'))) ff(['-f', 'lavfi', '-i', "nullsrc=size=400x400,format=rgba,geq=r='255':g='60':b='40':a='255*clip((180-hypot(X-200,Y-200))/30,0,1)'",
    '-frames:v', '1', A('alpha.png')]);
  if (!fs.existsSync(A('green.png'))) ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:size=360x640', '-vf',
    'drawbox=x=100:y=180:w=160:h=280:color=0xff8a33:t=fill,drawbox=x=140:y=230:w=80:h=80:color=0x8833ff:t=fill,drawbox=x=120:y=480:w=120:h=40:color=0x22aa22:t=fill',
    '-frames:v', '1', A('green.png')]);
  if (!fs.existsSync(path.join(ASSETS, 'luts', 'R-test-rotate.cube'))) makeCube(path.join(ASSETS, 'luts', 'R-test-rotate.cube'));
  fs.writeFileSync(A('manifest.json'), JSON.stringify(manifest, null, 2));
}

async function main() {
  makeAssets();
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/\.(png|json)$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const logs = [];
  const server = await startServer({ port: PORT, onDone: (b) => resolveDone(b), onLog: (l) => { logs.push(l); if (/error|fail|warn/i.test(l)) console.log('[page]', l.slice(0, 400)); } });
  const profile = path.join(OUT, 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const url = `http://127.0.0.1:${PORT}/tools/tests/${page}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900', url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const t0 = Date.now();
  const timer = new Promise((r) => setTimeout(() => r(null), timeoutS * 1000));
  const body = await Promise.race([done, timer]);
  try { chrome.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  server.close();
  fs.writeFileSync(path.join(OUT, 'R-page-log.txt'), logs.join('\n'));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
  if (!body) { console.log(`TIMEOUT after ${timeoutS}s`); process.exit(2); }
  const res = JSON.parse(body);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(JSON.stringify(res.summary, null, 2));
  process.exit(res.summary && res.summary.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
