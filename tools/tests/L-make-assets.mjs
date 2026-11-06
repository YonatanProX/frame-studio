// Agent L: (re)generate the small synthetic media used by the timeline/library tests (tools/tests/L-assets, ~11 MB).
// Usage: node tools/tests/L-make-assets.mjs [--clean]   (--clean removes the generated folder)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSET_DIR = path.join(HERE, 'L-assets');

function ff(args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: ASSET_DIR, windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`);
}

export function ensureAssets({ force = false } = {}) {
  const marker = path.join(ASSET_DIR, 'thumbs', 'i_photo', '00001.jpg');
  if (!force && fs.existsSync(marker)) return false;
  for (const d of ['thumbs/v_demo', 'thumbs/v_demo2', 'thumbs/i_photo']) fs.mkdirSync(path.join(ASSET_DIR, d), { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=16', '-f', 'lavfi', '-i', 'sine=f=330:d=16', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'v_demo.mp4']);
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'v_demo2.mp4']);
  ff(['-f', 'lavfi', '-i', 'gradients=s=1080x1350:c0=0x13b6e4:c1=0xff8a66:d=1,format=rgb24', '-frames:v', '1', 'i_photo.png']);
  ff(['-f', 'lavfi', '-i', 'anoisesrc=d=14:c=pink:a=0.5', '-af', "volume='0.2+0.8*abs(sin(2*PI*t*1.7))*gt(sin(2*PI*t*0.45),-0.3)':eval=frame,lowpass=f=3000", '-ar', '48000', '-ac', '2', 'a_voice.wav']);
  ff(['-f', 'lavfi', '-i', 'sine=f=55:d=20', '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=white:a=0.3', '-filter_complex',
    "[0]volume='if(lt(mod(t,0.5),0.08),1.0,0.05)':eval=frame[k];[1]volume='if(lt(mod(t+0.25,0.5),0.04),0.6,0.0)':eval=frame,highpass=f=6000[h];[k][h]amix=inputs=2:normalize=0",
    '-ar', '48000', '-ac', '2', 'a_music.wav']);
  ff(['-i', 'v_demo.mp4', '-vf', 'fps=1,scale=-2:120', 'thumbs/v_demo/%05d.jpg']);
  ff(['-i', 'v_demo2.mp4', '-vf', 'fps=1,scale=-2:120', 'thumbs/v_demo2/%05d.jpg']);
  ff(['-i', 'i_photo.png', '-vf', 'scale=-2:120', 'thumbs/i_photo/00001.jpg']);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--clean')) { fs.rmSync(ASSET_DIR, { recursive: true, force: true }); console.log('L-assets removed'); }
  else console.log(ensureAssets({ force: process.argv.includes('--force') }) ? 'L-assets generated' : 'L-assets already present');
}
