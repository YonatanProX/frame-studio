// Agent S: media edge cases (image, svg, mp3 with cover art, animated gif, rotated phone video, silent video, Hebrew file names).
//   node tools/tests/S-test-media.mjs   (server on 7788)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:7788';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'tools', 'tests', 'S-media-tmp', 'קבצים בעברית');
fs.mkdirSync(DIR, { recursive: true });
const ff = (...a) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a]); if (r.status) throw new Error(r.stderr.toString()); };
const F = {
  png: path.join(DIR, 'תמונה.png'), svg: path.join(DIR, 'לוגו.svg'), mp3: path.join(DIR, 'שיר עם עטיפה.mp3'),
  gif: path.join(DIR, 'אנימציה.gif'), rot: path.join(DIR, 'טלפון מסובב.mp4'), silent: path.join(DIR, 'שקט.mp4'),
};
ff('-f', 'lavfi', '-i', 'testsrc2=s=1200x800:d=1', '-frames:v', '1', F.png);
fs.writeFileSync(F.svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#3b82f6"/></svg>');
ff('-f', 'lavfi', '-i', 'sine=f=330:d=2', '-i', F.png, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', F.mp3);
ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1.5:r=10', F.gif);
ff('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:d=2:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata:s:v:0', 'rotate=90', path.join(DIR, 'tmp.mp4'));
// display-matrix rotation (what phones write)
ff('-display_rotation', '90', '-i', path.join(DIR, 'tmp.mp4'), '-c', 'copy', F.rot);
fs.rmSync(path.join(DIR, 'tmp.mp4'));
ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=1.5:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', F.silent);

let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const j = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };

await j('DELETE', '/api/projects/s-media');
let r = await j('POST', '/api/projects', { id: 's-media', name: 'מדיה', width: 1080, height: 1920 });
ok(r.status === 201, 'create');
r = await j('POST', '/api/projects/s-media/import', { paths: Object.values(F) });
ok(r.status === 200 && r.data.media.length === 6, 'import 6 files', r.data);
const by = Object.fromEntries(r.data.media.map((m) => [path.basename(m.path), m]));
const png = by['תמונה.png'], svg = by['לוגו.svg'], mp3 = by['שיר עם עטיפה.mp3'], gif = by['אנימציה.gif'], rot = by['טלפון מסובב.mp4'], sil = by['שקט.mp4'];
ok(png.kind === 'image' && png.width === 1200 && png.height === 800 && png.duration === 0 && !png.hasAudio, 'png → image', png);
ok(svg.kind === 'image' && svg.width === 400 && svg.height === 200, 'svg → image (viewBox size)', svg);
ok(mp3.kind === 'audio' && mp3.hasAudio && !mp3.hasVideo && Math.abs(mp3.duration - 2) < 0.1, 'mp3 with cover art → audio', mp3);
ok(gif.kind === 'video' && gif.width === 320 && !gif.hasAudio, 'animated gif → video', gif);
ok(rot.kind === 'video' && rot.width === 1080 && rot.height === 1920, 'rotated phone video → display size 1080x1920', { w: rot.width, h: rot.height });
ok(sil.kind === 'video' && !sil.hasAudio, 'silent video', sil);

// wait until nothing is processing
const t0 = Date.now();
let p;
for (;;) {
  p = (await j('GET', '/api/projects/s-media')).data;
  if (!Object.values(p.media).some((m) => m.status === 'processing')) break;
  if (Date.now() - t0 > 120000) break;
  await new Promise((res) => setTimeout(res, 500));
}
const M = (m) => p.media[m.id];
ok(Object.values(p.media).every((m) => m.status === 'ready'), 'all ready', Object.values(p.media).map((m) => [m.name, m.status, m.error]));
ok(M(png).thumbs && !M(png).proxy && !M(png).audio, 'image: thumb only');
ok(M(mp3).audio && M(mp3).peaks && !M(mp3).thumbs && !M(mp3).proxy, 'audio: wav + peaks only');
ok(M(sil).proxy && M(sil).thumbs && !M(sil).audio && !M(sil).peaks, 'silent video: proxy + thumbs, no audio');
const rp = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', path.join(ROOT, 'projects', 's-media', M(rot).proxy)], { encoding: 'utf8' });
const rs = JSON.parse(rp.stdout).streams[0];
ok(rs.width === 1080 && rs.height === 1920 && !(rs.side_data_list || []).some((s) => s.rotation), 'rotated proxy is upright 1080x1920', rs);
let rr = await fetch(`${BASE}/api/projects/s-media/media/${png.id}/thumb?t=0`);
ok(rr.status === 200 && rr.headers.get('content-type') === 'image/jpeg', 'image thumb');
rr = await fetch(`${BASE}/api/projects/s-media/media/${svg.id}/file`);
ok(rr.status === 200 && rr.headers.get('content-type') === 'image/svg+xml', 'svg file MIME');
rr = await fetch(`${BASE}/api/projects/s-media/media/${png.id}/proxy`);
ok(rr.status === 200 && rr.headers.get('content-type') === 'image/png', 'image /proxy falls back to file');
rr = await fetch(`${BASE}/api/projects/s-media/media/${sil.id}/peaks`);
ok(rr.status === 404, 'no peaks for silent video → 404');
// re-import same path → dedupe
r = await j('POST', '/api/projects/s-media/import', { paths: [F.png] });
ok(r.data.media[0].id === png.id && Object.keys((await j('GET', '/api/projects/s-media')).data.media).length === 6, 'dedupe by path');
// copy import
r = await j('POST', '/api/projects/s-media/import', { paths: [F.mp3], copy: true });
ok(r.data.media[0].id !== mp3.id && r.data.media[0].path.includes(path.join('s-media', 'media')), 'copy:true copies into project media/', r.data.media[0].path);
// regenerate
r = await j('POST', `/api/projects/s-media/media/${sil.id}/regenerate`, {});
ok(r.status === 200 && r.data.media.status === 'processing', 'regenerate → processing');
for (let i = 0; i < 60; i++) { p = (await j('GET', '/api/projects/s-media')).data; if (p.media[sil.id].status !== 'processing') break; await new Promise((res) => setTimeout(res, 300)); }
ok(p.media[sil.id].status === 'ready' && p.media[sil.id].proxy, 'regenerated ready');

r = await j('DELETE', '/api/projects/s-media');
if (r.data.trash) fs.rmSync(r.data.trash, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'tools', 'tests', 'S-media-tmp'), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
