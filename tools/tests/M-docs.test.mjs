// Frame Studio — docs/CLAUDE-API.md smoke test (agent M): every ```json example parses, and each block of op examples
// runs (in order, as one batch) against a fixture project with the real render catalog loaded.
// Run: node "tools/tests/M-docs.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { applyOps } = await import(new URL('../../shared/ops.js', import.meta.url).href);
const { newProject } = await import(new URL('../../shared/model.js', import.meta.url).href);
const { getCatalog } = await import(new URL('../../shared/catalog.js', import.meta.url).href);
const cat = await getCatalog();

const md = fs.readFileSync(path.join(ROOT, 'docs', 'CLAUDE-API.md'), 'utf8').replace(/\r\n/g, '\n');
const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

/** Split text into top-level JSON values (objects/arrays), honoring strings. */
function splitJsonValues(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  if (depth !== 0) throw new Error('סוגריים לא מאוזנים');
  return out;
}

function fixture() {
  const p = newProject({ id: 'docs-fixture', name: 'דוגמאות' });
  const W = [['רֶגַע!', 0.12, 0.48], ['יש', 0.8, 0.95], ['לכם', 0.97, 1.2], ['שיר,', 1.22, 1.6], ['שאין', 1.7, 2.0], ['לו', 2.02, 2.15], ['אקורדים', 2.18, 2.8],
    ['באף', 2.85, 3.1], ['אתר?', 3.12, 3.6], ['תסתכלו', 4.4, 4.9], ['על', 4.92, 5.05], ['זה', 5.07, 5.3], ['ובום!', 5.4, 5.9], ['סולם!', 6.3, 6.8], ['קצב!', 7.0, 7.4],
    ['מבנה!', 7.6, 8.1], ['ובום!', 9.8, 10.3], ['קורדיקס!', 11.0, 11.6], ['חינם,', 11.8, 12.2], ['נסו', 12.3, 12.5], ['עכשיו!', 12.55, 13.1]];
  p.transcript = { words: W.map(([w, s, e]) => ({ w, s, e })) };
  const media = (id, kind, duration, extra = {}) => ({ id, kind, name: id, path: `C:/x/${id}`, duration, width: kind === 'audio' ? 0 : 1080, height: kind === 'audio' ? 0 : 1920,
    hasVideo: kind !== 'audio', hasAudio: kind !== 'image', status: 'ready', ...extra });
  p.media = Object.fromEntries([
    media('m_vo', 'audio', 14), media('m_song', 'audio', 30), media('m_ab12cd34', 'video', 20), media('m_logo', 'image', 0), media('m_a', 'video', 10),
    media('m_b', 'video', 20), media('m_end', 'image', 0), media('m_old', 'audio', 2), media('m_vid', 'video', 30), media('m_boom', 'audio', 4, { library: { soundId: 'a1b2c3d4e5f6' } }),
  ].map((m) => [m.id, m]));
  const seed = [
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 0, duration: 5.4, id: 'shot1', track: 't_main' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 5.4, in: 2, duration: 4.4, id: 'shot2', track: 't_main', effects: [{ id: 'vignette' }] },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 9.8, in: 8, duration: 4, id: 'shot3', track: 't_main' },
    { op: 'addClip', type: 'video', mediaId: 'm_vid', start: 14, duration: 2, id: 'main1', track: 't_main' },
    { op: 'addClip', type: 'image', mediaId: 'm_logo', start: 16, duration: 2, id: 'c_logo', track: 't_main' },
    { op: 'addClip', type: 'text', content: 'כותרת', start: 0.1, duration: 0.9, id: 'c_title' },
    { op: 'addClip', type: 'text', content: 'א', start: 2, id: 'c_a' },
    { op: 'addClip', type: 'text', content: 'ב', start: 5, id: 'c_b' },
    { op: 'addClip', type: 'text', content: 'ג', start: 8, id: 'c_c' },
    { op: 'addClip', type: 'text', content: '1', start: 11, id: 'c_1' },
    { op: 'addClip', type: 'text', content: '2', start: 14, id: 'c_2' },
    { op: 'addClip', type: 'text', content: 'ישן', start: 17, id: 'c_old' },
    { op: 'addClip', type: 'audio', mediaId: 'm_boom', start: 1, id: 'c_hit' },
    { op: 'addCaptions', words: 'transcript', style: 'chordix', idPrefix: 'c_cap' },
    { op: 'addClip', type: 'text', content: 'רגע!', start: 0.12, duration: 0.9, id: 'hook', track: 't_overlay' },
    { op: 'addClip', type: 'video', mediaId: 'm_a', start: 20, duration: 3, id: 's1', track: 't_main' },
    { op: 'addClip', type: 'video', mediaId: 'm_b', start: 23, duration: 3, id: 's2', track: 't_main' },
    { op: 'addClip', type: 'video', mediaId: 'm_b', start: 26, duration: 3, id: 's3', track: 't_main' },
    { op: 'addMarker', t: 9.8, label: 'דרופ', id: 'mk_drop' },
  ];
  const r = applyOps(p, seed, { catalog: cat });
  r.results.forEach((x, i) => assert.ok(x.ok, `seed ${i}: ${x.error}`));
  return r.project;
}

// Errors that are expected offline: path imports are done by the server before applyOps.
const SERVER_ONLY = /עוד לא יובא/;
const SOUNDS = new Proxy({}, { get: (_, q) => ({ id: `snd_${String(q).length}`, name: String(q), abs: `C:/lib/${String(q)}.wav`, duration: 4 }) });

let okOps = 0, serverOnly = 0;
const fails = [];
blocks.forEach((b, bi) => {
  let values;
  try { values = splitJsonValues(b).map((t) => JSON.parse(t)); }
  catch (e) { fails.push(`בלוק ${bi}: JSON לא תקין — ${e.message}`); return; }
  const ops = values.flatMap((v) => (Array.isArray(v) ? v : v && Array.isArray(v.ops) ? v.ops : v && v.op ? [v] : []));
  if (!ops.length) return;
  // ids this block creates itself are removed from the fixture first (the examples read as a sequence)
  const P = fixture();
  for (const o of ops) {
    const created = ['addClip', 'sfx', 'addMarker'].includes(o.op) ? o.id : ['splitClip', 'duplicateClip', 'detachAudio'].includes(o.op) ? o.newId : null;
    if (typeof created !== 'string') continue;
    delete P.clips[created];
    P.markers = P.markers.filter((m) => m.id !== created);
  }
  const r = applyOps(P, ops, { catalog: cat, sounds: SOUNDS });
  r.results.forEach((x, i) => {
    if (x.ok) okOps++;
    else if (SERVER_ONLY.test(x.error)) serverOnly++;
    else fails.push(`בלוק ${bi} פעולה ${i} (${ops[i].op}): ${x.error}`);
  });
});
console.log(`${blocks.length} בלוקי JSON · ${okOps} פעולות לדוגמה רצו בהצלחה · ${serverOnly} דורשות שרת (ייבוא נתיב)`);
if (fails.length) { console.log(fails.map((f) => '✗ ' + f).join('\n')); process.exitCode = 1; }
else console.log('✓ כל הדוגמאות במסמך תקינות');
