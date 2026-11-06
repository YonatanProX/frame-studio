// Agent A integration smoke: real render modules + my export pipeline → snapshot of real visual clips.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ROOT, PROJ, OUT } from './A-server.mjs';

process.env.FRAME_STUDIO_CHROME_PROFILE = path.join(path.dirname(OUT), 'A-chrome-render');
const { startServer } = await import('./A-server.mjs');
const model = await import(pathToFileURL(path.join(ROOT, 'shared', 'model.js')).href);

const p = model.newProject({ id: 'e2evis', name: 'בדיקה חזותית', width: 540, height: 960, fps: 30 });
const textTrack = p.tracks.find((t) => t.role === 'text');
const overlay = p.tracks.find((t) => t.role === 'overlay') || p.tracks[1];
const t1 = model.newClip('text', { id: 'c_text', trackId: textTrack.id, start: 0, duration: 3, text: { content: 'שלום עולם 2026', size: 64, color: '#ffffff', stroke: { color: '#071822', width: 8 } }, transform: { y: -200 } });
const s1 = model.newClip('shape', { id: 'c_shape', trackId: overlay.id, start: 0, duration: 3, shape: { kind: 'roundrect', w: 300, h: 300, fill: '#13b6e4', radius: 40 }, transform: { y: 150 } });
p.clips = { [t1.id]: t1, [s1.id]: s1 };
await fsp.mkdir(path.join(PROJ, p.id), { recursive: true });
await fsp.writeFile(path.join(PROJ, p.id, 'project.json'), JSON.stringify(p, null, 2));

const srv = await startServer({ port: 7793, useStubs: false, mountExport: true });
const B = 'http://127.0.0.1:7793';
const r = await (await fetch(`${B}/api/projects/${p.id}/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ times: [0.1, 1.5], sheet: true, scale: 0.5 }) })).json();
const j = JSON.parse(await (await fetch(`${B}/api/jobs/${r.id}/wait?timeout=120`)).text());
console.log('status', j.status, j.error || '', '\nlog:', (j.log || []).join('\n     '));
const sheet = (j.outputs || []).find((o) => o.kind === 'sheet');
if (sheet) { await fsp.copyFile(sheet.path, path.join(OUT, 'vis-sheet.png')); console.log('sheet →', path.join(OUT, 'vis-sheet.png')); }
await srv.close();
process.exit(j.status === 'done' ? 0 : 1);
