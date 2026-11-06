// Frame Studio — tools/tests/U-real-setup.mjs (agent U integration test against S's real server)
// Creates a throwaway project "u-int-test" on BASE, imports the U-media test files through /import, waits for the
// derivatives (proxy/audio/peaks/thumbs), then seeds the same clips the mock uses (ids c_vid, c_img, c_title, …).
// usage: node tools/tests/U-real-setup.mjs [--clean]   (--clean deletes the project → projects/.trash)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:7794';
const ID = process.env.PROJECT || 'u-int-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${typeof j === 'object' ? j.error : j}`);
  return j;
}

if (process.argv.includes('--clean')) {
  try { await call('DELETE', `/api/projects/${ID}`); console.log('deleted', ID); } catch (e) { console.log('delete:', e.message); }
  process.exit(0);
}

try { await call('DELETE', `/api/projects/${ID}`); } catch { /* not there */ }
const p = await call('POST', '/api/projects', { id: ID, name: 'בדיקת אינטגרציה — U', width: 1080, height: 1920, fps: 30, tracks: 'default' });
console.log('created', p.id, 'rev', p.rev);
const files = ['video.mp4', 'image.png', 'voice.wav', 'music.wav', 'sfx.wav'].map((f) => path.join(HERE, 'U-media', f));
const imp = await call('POST', `/api/projects/${ID}/import`, { paths: files });
const byName = Object.fromEntries(imp.media.map((m) => [m.name.replace(/\.[^.]+$/, '').toLowerCase(), m]));
console.log('imported', imp.media.map((m) => `${m.id}:${m.kind}:${m.status}`).join(' '));
for (let i = 0; i < 120; i++) {
  const pr = await call('GET', `/api/projects/${ID}`);
  const st = Object.values(pr.media).map((m) => m.status);
  if (st.every((s) => s !== 'processing')) { console.log('media ready:', st.join(',')); break; }
  await sleep(500);
}
const M = (n) => byName[n].id;
const words = [['ככה', 3.0, 3.3], ['מנגנים', 3.32, 3.8], ['אקורדים', 3.85, 4.4], ['בקלות!', 4.45, 5.1]];
const res = await call('POST', `/api/projects/${ID}/ops`, {
  by: 'user', summary: 'הכנת פרויקט בדיקה',
  ops: [
    { op: 'addClip', id: 'c_vid', type: 'video', mediaId: M('video'), start: 0, duration: 8, role: 'main', name: 'צילום אתר' },
    { op: 'addClip', id: 'c_img', type: 'image', mediaId: M('image'), start: 1, duration: 4, role: 'overlay', set: { 'transform.scale': 0.55, 'transform.y': -420 } },
    { op: 'setKeyframes', id: 'c_img', prop: 'transform.scale', keys: [{ t: 0, v: 0.4 }, { t: 0.6, v: 0.6, ease: 'spring' }, { t: 3, v: 0.55, ease: 'easeInOut' }] },
    { op: 'addClip', id: 'c_title', type: 'text', start: 0, duration: 3, content: 'ככה מנגנים אקורדים', set: { 'transform.y': -640, 'text.size': 104, 'text.stroke.width': 10 } },
    { op: 'addClip', id: 'c_shape', type: 'shape', start: 2, duration: 3, role: 'overlay', set: { 'shape.kind': 'roundrect', 'shape.w': 640, 'shape.h': 120, 'shape.fill': '#13b6e4', 'transform.y': 520 } },
    { op: 'addClip', id: 'c_sticker', type: 'sticker', start: 1.5, duration: 2, set: { 'sticker.value': '🔥', 'transform.x': 300, 'transform.y': -200 } },
    { op: 'setTranscript', words },
    { op: 'addCaptions', words, style: 'chordix', maxWords: 2, hot: ['אקורדים'], y: 330 },
    { op: 'addClip', id: 'c_voice', type: 'audio', mediaId: M('voice'), start: 0.5, role: 'voice', name: 'קריינות' },
    { op: 'addClip', id: 'c_music', type: 'audio', mediaId: M('music'), start: 0, duration: 8, role: 'music', name: 'מוזיקה', volume: 0.5, fadeOut: 1 },
    { op: 'addClip', id: 'c_sfx', type: 'audio', mediaId: M('sfx'), start: 2.9, role: 'sfx', name: 'וושש' },
    { op: 'addMarker', t: 3, label: 'הוק' }, { op: 'addMarker', t: 6, label: 'דרופ', color: '#ff8a66' },
    { op: 'setSettings', set: { safeArea: 'reels' } },
  ],
});
const bad = res.results.filter((r) => !r.ok);
console.log('seeded rev', res.rev, bad.length ? `errors: ${bad.map((b) => b.error).join(' | ')}` : 'ok');
