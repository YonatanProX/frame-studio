// Frame Studio — import a Chordix "video workshop" project (video.json + render/) into a Frame Studio project.
// READ ONLY on the workshop folder: nothing is ever written there.
//
// What is created (one undo step):
//   main track: render/video.mp4 (muteAudio, it already has burned-in captions → name "וידאו מהסדנה")
//   voice:      render/st_vo.wav | render/vo.wav | <vo> from video.json
//   music:      render/st_music.wav | render/music.wav | <song> from video.json (offset so the drop lands on "drop")
//   sfx:        one audio clip per video.json.sfx entry (gain, len, fade, from, peak_at/peak_db like build-video.py)
//   transcript: script tokens with ASR times (letter alignment, same as build-video.py)
//   captions:   hidden "כתוביות" track built from chunks + hot words (style chordix)
//   markers:    one per video.json.beats entry — only with opts.markers === true (opt-in; off by default so the ruler stays clean)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peakInfo, mediaFromFile } from './media.mjs';
import { chordixConfig } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CURATED_SFX = path.join(ROOT, 'library', 'sounds', 'נבחרים לסושיאל');

/** Extra folders searched for workshop sound effects: env CHORDIX_SFX + config.json "chordix.sfx" (optional). */
export function extraSfxRoots() { return chordixConfig().sfx; }

/**
 * Workshop project folder from user input. Absolute paths are used as-is; a bare/relative name
 * ("05-בלדה-עממית" or "projects/05-…") is resolved against config.json "chordix.workshop" when it is set.
 */
export function resolveWorkshopDir(dir) {
  const s = String(dir || '').trim().replace(/^"+|"+$/g, '');
  if (!s || path.isAbsolute(s)) return path.resolve(s || '.');
  const ws = chordixConfig().workshop;
  if (ws) {
    for (const cand of [path.join(ws, 'projects', s), path.join(ws, s)]) if (existsFile(path.join(cand, 'video.json'))) return cand;
  }
  return path.resolve(s);
}

export const BEAT_LABELS = {
  noRes: 'אין תוצאות', phone: 'הטלפון נכנס', chip: 'הקובץ נכנס', work: 'ניתוח', progress: 'התקדמות',
  srvIn: 'לא עולה לשרת', srvOut: 'חזרה מהשרת', result: 'תוצאה', key: 'סולם', bpm: 'קצב', tape: 'מבנה',
  drop: 'דרופ', verse: 'בית', chorus: 'פזמון', all: 'הכול', play: 'נגינה', end: 'כרטיס סיום', cta: 'קריאה לפעולה',
  rewind: 'חזרה לאחור', hook: 'הוק',
};
const BEAT_COLORS = { drop: '#ff8a66', end: '#3fe0f5', cta: '#3fe0f5', phone: '#13b6e4', noRes: '#ff5c5c' };

/** letters/digits only (Hebrew incl. final forms, Latin, digits) — same as build-video.py `heb()` */
export const heb = (s) => String(s).replace(/[^א-תA-Za-z0-9]/g, '');

/** difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks() without the sentinel */
export function matchingBlocks(a, b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    const c = b[j];
    if (!b2j.has(c)) b2j.set(c, []);
    b2j.get(c).push(j);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  };
  const queue = [[0, a.length, 0, b.length]];
  const blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return blocks;
}

/**
 * Align script tokens to ASR word times by letters (build-video.py step 1).
 * asr: [[token, s, e]…], script: string, hot: [tokens]
 * → { words:[{w,s,e,hot}], coverage 0..1, method:"letters"|"index" }
 */
export function alignScript(script, asr, hot = []) {
  const tokens = String(script || '').trim().split(/[ \t\r\n]+/).filter(Boolean);
  const hotSet = new Set(hot || []);
  if (!tokens.length) {
    return { words: asr.map(([w, s, e]) => ({ w: String(w), s: +s, e: +e, hot: hotSet.has(w) })), coverage: 1, method: 'asr' };
  }
  const chars = [], times = [];
  for (const [tok, s, e] of asr) {
    const t = heb(tok);
    for (let k = 0; k < t.length; k++) { chars.push(t[k]); times.push(+s + (+e - +s) * (k + 0.5) / Math.max(1, t.length)); }
  }
  const S = tokens.map(heb).join('');
  const Aj = chars.join('');
  const m = new Array(S.length).fill(null);
  for (const [a, b, n] of matchingBlocks(S, Aj)) for (let k = 0; k < n; k++) m[a + k] = times[b + k];
  const known = [];
  for (let i = 0; i < m.length; i++) if (m[i] != null) known.push(i);
  const coverage = known.length / Math.max(1, S.length);

  if (coverage < 0.3 || !known.length) {
    // fallback (SPEC): index mapping up to the shorter list
    const n = Math.min(tokens.length, asr.length);
    const words = [];
    for (let i = 0; i < tokens.length; i++) {
      const src = asr[Math.min(i, n - 1)] || [tokens[i], 0, 0];
      words.push({ w: tokens[i], s: +src[1], e: +src[2], hot: hotSet.has(tokens[i]) });
    }
    return { words, coverage, method: 'index' };
  }
  // linear fill of unmatched letters
  let ki = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] != null) continue;
    while (ki < known.length && known[ki] < i) ki++;
    const lo = ki > 0 ? known[ki - 1] : null;
    const hi = ki < known.length ? known[ki] : null;
    m[i] = hi == null ? m[lo] : lo == null ? m[hi] : m[lo] + (m[hi] - m[lo]) * (i - lo) / (hi - lo);
  }
  const words = [];
  let p = 0;
  for (const x of tokens) {
    const n = heb(x).length;
    let s, e;
    if (n === 0) { s = e = m[Math.min(p, m.length - 1)] ?? (words.length ? words[words.length - 1].e : 0); }
    else { s = m[p]; e = m[p + n - 1]; }
    p += n;
    words.push({ w: x, s: Math.round((s - 0.05) * 1000) / 1000, e: Math.round((e + 0.05) * 1000) / 1000, hot: hotSet.has(x) });
  }
  for (let i = 0; i < words.length - 1; i++) words[i].e = Math.min(words[i].e, words[i + 1].s);
  for (const w of words) { if (w.s < 0) w.s = 0; if (w.e < w.s) w.e = w.s; }
  return { words, coverage, method: 'letters' };
}

/** time spec → seconds: number | "word" | [word, n, offset] (build-video.py t_of) */
export function makeTimeOf(words) {
  return (spec) => {
    if (typeof spec === 'number') return spec;
    if (spec == null) return null;
    const [word, nth = 0, off = 0] = Array.isArray(spec) ? spec : [spec, 0, 0];
    if (typeof word === 'number') return word + (+off || 0);
    let hits = words.filter((x) => x.w === word);
    if (!hits.length) { const h = heb(word); hits = h ? words.filter((x) => heb(x.w) === h) : []; }
    const hit = hits[+nth || 0];
    return hit ? Math.round((hit.s + (+off || 0)) * 1000) / 1000 : null;
  };
}

function existsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** find a file, also trying .mp3/.wav/.flac with the same name */
function findWithAlt(file) {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (const e of [ext, '.wav', '.mp3', '.flac', '.m4a']) if (e && existsFile(stem + e)) return stem + e;
  return null;
}

export function resolveSfxFile(rel) {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return findWithAlt(rel);
  const roots = [CURATED_SFX, ...extraSfxRoots()];
  for (const r of roots) { const f = findWithAlt(path.join(r, rel)); if (f) return f; }
  // the curated copy may have been reorganised: search by file name
  const name = path.basename(rel).toLowerCase();
  for (const r of roots) {
    const hit = findByName(r, name, 4);
    if (hit) return hit;
  }
  return null;
}

function findByName(dir, nameLower, depth) {
  if (depth < 0) return null;
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const d of list) if (d.isFile() && d.name.toLowerCase() === nameLower) return path.join(dir, d.name);
  for (const d of list) if (d.isDirectory()) { const r = findByName(path.join(dir, d.name), nameLower, depth - 1); if (r) return r; }
  return null;
}

/** ascii id from the workshop folder name ("05-בלדה-עממית" → "chordix-05") */
export function idFromDir(dir) {
  const base = path.basename(path.resolve(dir));
  const ascii = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ('chordix-' + (ascii || 'project')).slice(0, 60).replace(/-+$/, '');
}

/**
 * Read a workshop project and describe what to import (no side effects).
 * → { config, dir, renderDir, total, words, coverage, method, files:{video,voice,music}, voiceKind, musicKind, musicIn, sfx:[…], warnings }
 */
export async function readChordixProject(dir) {
  const abs = resolveWorkshopDir(dir);
  const vj = path.join(abs, 'video.json');
  if (!existsFile(vj)) throw new Error(`לא נמצא video.json בתיקייה: ${abs}`);
  let C;
  try { C = JSON.parse((await fsp.readFile(vj, 'utf8')).replace(/^\uFEFF/, '')); } catch (e) { throw new Error(`video.json אינו JSON תקין: ${e.message}`); }
  const warnings = [];
  const renderDir = path.join(abs, C.render_dir || 'render');
  const pick = (...c) => c.find((f) => f && existsFile(f)) || null;

  // words
  let asr = [];
  if (C.asr) {
    const f = path.join(abs, C.asr);
    if (existsFile(f)) {
      try { asr = JSON.parse((await fsp.readFile(f, 'utf8')).replace(/^\uFEFF/, '')); } catch { warnings.push(`קובץ התמלול ${C.asr} אינו תקין`); }
    } else warnings.push(`קובץ התמלול ${C.asr} חסר`);
  } else warnings.push('אין תמלול (asr) ב-video.json — אין כתוביות וסמנים לפי מילים');
  asr = (Array.isArray(asr) ? asr : []).filter((x) => Array.isArray(x) && x.length >= 3);
  const al = asr.length ? alignScript(C.script, asr, C.hot) : { words: [], coverage: 0, method: 'none' };
  if (asr.length && al.coverage < 0.75) warnings.push(`התאמה נמוכה בין התסריט לתמלול (${Math.round(al.coverage * 100)}%)`);
  const words = al.words;
  const T = makeTimeOf(words);

  const files = {
    video: pick(path.join(renderDir, 'video.mp4')),
    voice: pick(path.join(renderDir, 'st_vo.wav'), path.join(renderDir, 'vo.wav')),
    music: pick(path.join(renderDir, 'st_music.wav'), path.join(renderDir, 'music.wav')),
  };
  let voiceKind = files.voice ? (path.basename(files.voice) === 'st_vo.wav' ? 'stem' : 'render') : null;
  if (!files.voice && C.vo) { files.voice = findWithAlt(path.join(abs, C.vo)); voiceKind = files.voice ? 'raw' : null; }
  let musicKind = files.music ? (path.basename(files.music) === 'st_music.wav' ? 'stem' : 'render') : null;
  let musicIn = 0;
  if (!files.music && C.song) {
    files.music = findWithAlt(path.join(abs, C.song));
    if (files.music) {
      musicKind = 'raw';
      const drop = T(C.beats && C.beats.drop) ?? T(C.drop_at);
      if (C.song_drop != null && drop != null) musicIn = Math.max(0, C.song_drop - drop);
    }
  }
  if (!files.video) warnings.push('render/video.mp4 חסר — הפרויקט ייבנה בלי הווידאו מהסדנה');
  if (!files.voice) warnings.push('קובץ הקריינות חסר');
  if (!files.music) warnings.push('קובץ המוזיקה חסר');

  // sfx entries (build-video.py mix_stems semantics)
  const sfx = [];
  for (const [i, c] of (Array.isArray(C.sfx) ? C.sfx : []).entries()) {
    const file = resolveSfxFile(c.file);
    if (!file) { warnings.push(`אפקט קולי חסר בספרייה: ${c.file}`); continue; }
    let fr = +c.from || 0;
    let t0, gain = c.gain_db ?? -12;
    if (c.peak_at != null || c.peak_db != null) {
      const pk = await peakInfo(file).catch(() => null);
      if (c.peak_at != null) {
        const tp = T(c.peak_at);
        if (tp == null) { warnings.push(`לא נמצאה המילה לאפקט "${c.cue || i}"`); continue; }
        t0 = pk ? tp - (pk.t - fr) : tp;
      }
      if (c.peak_db != null && pk) gain = c.peak_db - pk.db;
    }
    if (t0 == null) {
      t0 = T(c.at);
      if (t0 == null) { warnings.push(`לא נמצאה המילה לאפקט "${c.cue || i}" (${JSON.stringify(c.at)})`); continue; }
    }
    if (t0 < 0) { fr -= t0; t0 = 0; }
    sfx.push({
      cue: c.cue || path.basename(file), file, at: Math.round(t0 * 1000) / 1000, from: Math.round(fr * 1000) / 1000,
      len: c.len ?? 4, fade: c.fade ?? 0.3, gainDb: Math.round(gain * 100) / 100,
    });
  }
  return { config: C, dir: abs, renderDir, total: +C.total || 0, words, coverage: al.coverage, method: al.method, files, voiceKind, musicKind, musicIn, sfx, warnings, timeOf: T };
}

/**
 * Import a workshop project.
 * api (provided by server/main.mjs): {
 *   uniqueId(base) → id, createProject({id,name,width,height,fps,tracks:"default"}) → project,
 *   importPaths(projectId, absPaths[]) → Media[] (same order), applyOps(projectId, ops, by, summary) → {project, results},
 *   setMeta(projectId, patch) → project, log(...)
 * }
 * opts: { dir, id?, name?, by?, markers? }  (markers: true → also add a ruler marker per video.json beat)
 * → { project, report:{ warnings, words, sfx, coverage, method } }
 */
export async function importChordix(opts, api) {
  const info = await readChordixProject(opts.dir);
  const C = info.config;
  const warnings = [...info.warnings];

  // canvas from the rendered video (fallback 1080x1920 @ 30)
  let width = 1080, height = 1920, fps = 30;
  if (info.files.video) {
    try {
      const m = await mediaFromFile(info.files.video, { id: 'probe' });
      if (m.width > 0 && m.height > 0) { width = m.width; height = m.height; }
      if (m.fps > 0) fps = Math.round(m.fps * 1000) / 1000;
    } catch (e) { warnings.push(`לא ניתן לקרוא את הווידאו: ${e.message}`); }
  }
  const id = api.uniqueId(opts.id || idFromDir(info.dir));
  const name = opts.name || C.name || path.basename(info.dir);
  let project = await api.createProject({ id, name, width, height, fps, tracks: 'default' });
  const by = opts.by === 'claude' ? 'claude' : 'user';

  // import every file once (sfx files are often reused)
  const order = [info.files.video, info.files.voice, info.files.music, ...info.sfx.map((s) => s.file)].filter(Boolean);
  const unique = [...new Set(order)];
  const mediaList = unique.length ? await api.importPaths(id, unique) : [];
  const byPath = new Map();
  unique.forEach((p, i) => { if (mediaList[i] && mediaList[i].id) byPath.set(p, mediaList[i]); });

  const trackOf = (role) => (project.tracks || []).find((t) => t.role === role);
  const ops = [];
  const total = info.total;
  const durFor = (m, from = 0) => {
    const avail = Math.max(0.05, (m.duration || 0) - from);
    return Math.round((total > 0 ? Math.min(avail, total - 0) : avail) * 1000) / 1000;
  };
  const tr = (role) => { const t = trackOf(role); return t ? { track: t.id } : { role }; };

  if (info.files.video && byPath.get(info.files.video)) {
    const m = byPath.get(info.files.video);
    ops.push({ op: 'addClip', type: 'video', ...tr('main'), start: 0, mediaId: m.id, duration: durFor(m), name: 'וידאו מהסדנה', muteAudio: true });
  }
  if (info.files.voice && byPath.get(info.files.voice)) {
    const m = byPath.get(info.files.voice);
    const vg = (C.mix && C.mix.voice_gain) || 2.2;
    const clip = { op: 'addClip', type: 'audio', ...tr('voice'), start: 0, mediaId: m.id, duration: durFor(m), name: 'קריינות' };
    if (info.voiceKind === 'raw') { clip.volume = Math.min(4, vg); clip.audioFx = { voiceEnhance: true, denoise: false, eqPreset: 'none', duckUnderVoice: false, duckDb: -10 }; }
    ops.push(clip);
  }
  if (info.files.music && byPath.get(info.files.music)) {
    const m = byPath.get(info.files.music);
    const clip = { op: 'addClip', type: 'audio', ...tr('music'), start: 0, mediaId: m.id, in: info.musicIn, duration: durFor(m, info.musicIn), name: 'מוזיקה' };
    if (info.musicKind !== 'stem') {
      // raw music was not ducked by the workshop mixer — let the engine duck it under the voice
      const mdb = (C.mix && C.mix.music_db) ?? -2;
      clip.volume = Math.round(10 ** (mdb / 20) * 1000) / 1000;
      clip.audioFx = { voiceEnhance: false, denoise: false, eqPreset: 'none', duckUnderVoice: true, duckDb: -10 };
    }
    if (total > 0) clip.fadeOut = 0.9;
    ops.push(clip);
  }
  for (const s of info.sfx) {
    const m = byPath.get(s.file);
    if (!m) continue;
    const avail = Math.max(0.05, (m.duration || s.len) - s.from);
    const dur = Math.round(Math.min(s.len, avail) * 1000) / 1000;
    ops.push({
      op: 'addClip', type: 'audio', role: 'sfx', overlap: 'newTrack', start: s.at, mediaId: m.id, in: s.from, duration: dur,
      name: s.cue, volume: Math.round(Math.min(4, 10 ** (s.gainDb / 20)) * 10000) / 10000, fadeOut: Math.min(s.fade, dur),
      audioFx: { voiceEnhance: false, denoise: false, eqPreset: 'none', duckUnderVoice: true, duckDb: -8 },
    });
  }

  if (info.words.length) {
    ops.push({ op: 'setTranscript', words: info.words.map(({ w, s, e }) => ({ w, s, e })) });
    const capTrack = `t_capx${Math.random().toString(36).slice(2, 8)}`;
    ops.push({ op: 'addTrack', id: capTrack, kind: 'video', role: 'text', name: 'כתוביות', index: 0, captions: true });
    ops.push({ op: 'updateTrack', id: capTrack, set: { hidden: true } });
    const cap = { op: 'addCaptions', words: info.words.map(({ w, s, e, hot }) => ({ w, s, e, hot: !!hot })), style: 'chordix', track: capTrack, hot: C.hot || [] };
    const chunks = Array.isArray(C.chunks) ? C.chunks.map(Number) : null;
    if (chunks && chunks.reduce((a, b) => a + b, 0) === info.words.length) cap.chunks = chunks;
    else { cap.maxWords = 3; if (chunks) warnings.push(`סכום chunks (${chunks.reduce((a, b) => a + b, 0)}) שונה ממספר המילים (${info.words.length}) — חלוקה אוטומטית`); }
    ops.push(cap);
  }
  const T = info.timeOf;
  const wantMarkers = opts.markers === true || opts.markers === 'true' || opts.markers === 1;
  for (const [key, spec] of wantMarkers ? Object.entries(C.beats || {}) : []) {
    const t = T(spec);
    if (t == null) { warnings.push(`לא נמצא זמן לסמן "${key}"`); continue; }
    ops.push({ op: 'addMarker', t: Math.max(0, t), label: BEAT_LABELS[key] || key, color: BEAT_COLORS[key] || '#f5c518' });
  }

  const res = await api.applyOps(id, ops, by, `ייבוא מסדנת Chordix: ${name}`);
  project = res.project;
  (res.results || []).forEach((r, i) => {
    if (r && r.ok === false) warnings.push(`פעולה ${i + 1} (${ops[i] && ops[i].op}) נכשלה: ${r.error}`);
  });
  const report = {
    source: 'chordix', dir: info.dir, at: new Date().toISOString(), words: info.words.length, coverage: Math.round(info.coverage * 1000) / 1000,
    method: info.method, sfx: info.sfx.length, voice: info.voiceKind, music: info.musicKind, warnings,
  };
  if (api.setMeta) project = await api.setMeta(id, { import: report });
  if (api.log) api.log(`ייבוא Chordix "${name}" → ${id}: ${ops.length} פעולות, ${warnings.length} אזהרות`);
  return { project, report };
}
