// mcp/guide.mjs — the texts the MCP server teaches Claude with: the `instructions` sent on initialize, the condensed
// editing guide (get_editing_guide with no topic), and section lookup in docs/CLAUDE-API.md (the full reference).
// Claude Desktop has no skill and no CLI, so everything Claude needs to edit well has to be reachable from here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const API_DOC = path.join(ROOT, 'docs', 'CLAUDE-API.md');

/** Sent once on initialize. Short: the client may put it in every prompt. */
export const INSTRUCTIONS = `Frame Studio is a video editor that runs on the user's computer. You edit with JSON operations (ops) while the user watches the timeline update live in the editor window and keeps editing by hand.
Frame Studio הוא עורך וידאו מקומי: אתה עורך בפעולות JSON, והמשתמש רואה כל שינוי בזמן אמת בחלון העורך וממשיך לערוך ביד.

The golden loop · לולאת הזהב:
1. get_project: read the current state first, because the user may have changed things by hand. (קרא את המצב.)
2. apply_ops: one batch per logical step, with a short summary in the user's language. The summary pops up in the editor. (ערוך.)
3. snapshot: LOOK at the frames it returns. Check for cut-off or overlapping text, wrong right-to-left order, black frames, captions over faces, and text outside the safe area. (הסתכל בתמונות.)
4. Fix what looks wrong and repeat. (תקן.)
5. export_video: writes an MP4 at -14 LUFS with a check that speech stays at least 12 dB above music and sound effects. If that check fails, run balance_audio and export again. (ייצוא.)

Rules · כללים:
- New video: create_project, then open_editor so the user can watch. Bring the user's files in with import_media (absolute file paths, or a folder path to take every media file in it). It returns media ids (m_…) for addClip.
- Never guess ids for transitions, effects, filters, animations, caption styles, text presets, stickers, fonts or LUTs. Look them up with get_catalog.
- Sound effects come only from the library: search_sounds, then the "sfx" op. Never synthesize sounds.
- Times are seconds or references: "word:hello", "word:hello:1:-0.1" (word, occurrence, offset), "marker:drop", "clip:s1:end", "end".
- Captions and word references need word timings. Get them with transcribe (local Whisper, optional) or set_transcript (words plus the real script).
- Coordinates: transform.x/y are pixel offsets of the clip centre from the canvas centre (y points down). yAbs/xAbs are measured from the top-left corner.
- Made a mistake? Use undo. Not sure what fields an op takes? Call get_editing_guide with topic "<opName>". Call get_editing_guide once, before your first edit.
- Talk to the user in their language. When you finish, tell them what changed, which frames you checked, and the export numbers (file, duration, LUFS, speech margin).`;

/** get_editing_guide with no topic. Written for the MCP tools (the docs speak in cutx commands). */
export const GUIDE = `# Frame Studio editing guide (MCP) · מדריך עריכה

## Tools ↔ CLI
Some reference sections show \`cutx\` commands. These tools do the same things:
show = get_project · ops = apply_ops · import = import_media · catalog = get_catalog · sounds = search_sounds ·
transcript = set_transcript · transcribe = transcribe · snapshot = snapshot · export = export_video ·
check-audio = check_audio · balance = balance_audio · undo / redo · open = open_editor · new = create_project.
For anything else (add, sfx, set, move, trim, split, key, transition, effect, marker, captions), send the op itself with apply_ops.

## Model
- A project has tracks, listed top to bottom. The top track is drawn on top. Default tracks: t_text, t_overlay, t_main, t_voice, t_music, t_sfx.
  These are created when needed: t_captions (a text track with captions:true) and t_effects (always on top).
- Track roles: effects (effect/adjustment clips that apply to everything below them), text, overlay, main, voice, music, sfx.
  You can name a track by id, by name, or by role ("track":"main").
- Clip types: video, image, audio, text, caption, shape, sticker, effect, adjustment. addClip picks the track by type or role.
  If that track is busy at that time, it makes a new track (overlap: newTrack | allow | overwrite | insert | error).
- Times are in seconds. A 9:16 canvas is 1080×1920 and its centre is (540, 960).
  Safe area for Reels/TikTok/Shorts: keep important text out of the top 250 px, the bottom 350 px, 80 px on each side, and 140 px on the right in the lower half.

## Time references (any start / at / end / t)
3.25 · "00:03:15" (MM:SS:FF) · "word:ביצים!" · "word:דקות:1:-0.13" (2nd occurrence, 0.13 s earlier) · "word:מחבת:0:0:end" (end of the word) ·
{"word":"שקשוקה","n":0,"offset":-0.1,"edge":"start"} · "marker:דרופ" · "clip:s2:end" · "clip:logo:end:0.1" · "end".
Words match without niqqud or punctuation. When a word is missing, the error suggests the closest words.
get_project lists every transcript word with its exact reference.

## apply_ops basics
- {"project":"<id>","summary":"<short, user's language>","ops":[…],"atomic":true?}. A failed op does not stop the others, unless "atomic":true is set (then nothing is saved).
- Give new clips your own ids ("id":"s1") so later ops in the same batch can refer to them. For splitClip and duplicateClip the new id is "newId".
- Shorthands in addClip and updateClip: content → text.content · x, y, scale, rotation, opacity → transform.* · animIn:"pop" · filter:"vivid" ·
  lut:"teal-orange.cube" · gain_db → volume · fade → fadeOut · xAbs / yAbs = position measured from the top-left corner.
- updateClip "set" takes paths: "text.size", "transform.scale", "color.contrast", "audioFx.duckUnderVoice", "animIn.id"… Objects you set are merged into what is there.

## Most used ops (examples)
{"op":"addClip","type":"video","mediaId":"m_ab12","start":0,"id":"s1","muteAudio":true}
{"op":"addClip","type":"video","mediaId":"m_cd34","start":"clip:s1:end","in":2,"duration":3.5,"id":"s2"}
{"op":"addClip","type":"image","mediaId":"m_logo","start":"word:ובתיאבון","end":"end","fit":"contain","animIn":"zoomIn","animLoop":"breathe"}
{"op":"addClip","type":"audio","mediaId":"m_vo","start":0,"role":"voice","audioFx":{"voiceEnhance":true}}
{"op":"addClip","type":"audio","mediaId":"m_song","start":0,"end":"end","role":"music","volume":0.5,"fadeOut":1,"audioFx":{"duckUnderVoice":true,"duckDb":-12}}
{"op":"addClip","type":"text","content":"שקשוקה!","start":0,"duration":1.2,"yAbs":700,"preset":"title","animIn":"pop","set":{"text.size":160}}
{"op":"addClip","type":"sticker","value":"🔥","start":2,"duration":1.5,"x":300,"y":-300,"animIn":"pop","animLoop":"wobble"}
{"op":"addClip","type":"effect","effect":"zoomPunch","params":{"strength":0.4},"at":"word:בצל","duration":0.5}
{"op":"addClip","type":"adjustment","filter":"cinematic","start":0,"end":"end","color":{"contrast":0.1}}
{"op":"updateClip","id":"s1","set":{"transform.scale":1.1,"color.saturation":0.15}}
{"op":"moveClip","id":"logo","start":"word:ובתיאבון"} · {"op":"trimClip","id":"s2","head":0.2,"tail":0.1} · {"op":"splitClip","id":"s2","at":5,"newId":"s2b"}
{"op":"removeClips","ids":["c_1","c_2"],"ripple":true} · {"op":"closeGaps","track":"main"} · {"op":"rippleDelete","from":4.0,"to":4.6} · {"op":"insertGap","at":"word:פלפל:0:-0.05","duration":0.35}
{"op":"setTransition","id":"s1","transition":"whipLeft","duration":0.3}. Set it on the OUTGOING clip. The next clip must start exactly where it ends, on the same track.
{"op":"addEffect","id":"s2","effect":"shake","params":{"strength":0.3}}
{"op":"setKeyframes","id":"s2","prop":"transform.scale","keys":[{"t":0,"v":1},{"t":0.4,"v":1.3,"ease":"spring"}]}. t is relative to the clip start, unless you set "abs":true or use word: refs.
{"op":"sfx","sound":"<sound id from search_sounds>","at":"word:ביצים!:0:-0.1","gain_db":-12,"len":1.2,"fade":0.2}
{"op":"setTranscript","words":[["שלום",0.1,0.5],["לכולם!",0.55,1.1]],"script":"שלום לכולם!"}
{"op":"addCaptions","words":"transcript","style":"popWords","maxWords":3,"hot":["ביצים!"],"yAbs":1250,"hook0":true,"replace":true}
{"op":"styleCaptions","style":"boxHighlight","activeColor":"#ffd60a"} · {"op":"addMarker","t":"word:ביצים!","label":"שיא"} · {"op":"setSettings","set":{"background":"#000000"}}

Full op list: setSettings, renameProject, addTrack, updateTrack, removeTrack, moveTrack, addClip, updateClip, removeClip, removeClips, moveClip, moveClips,
trimClip, slipClip, splitClip, splitAt, duplicateClip, pasteClips, setSpeed, detachAudio, closeGaps, setKeyframe, setKeyframes, removeKeyframe,
clearKeyframes, setTransition, removeTransition, addEffect, updateEffect, removeEffect, moveEffect, addCaptions, styleCaptions, setHotWords,
setCaptionWord, splitCaption, mergeCaptions, setTranscript, addMarker, updateMarker, removeMarker, clearMarkers, rippleDelete, insertGap, sfx,
addMedia, updateMedia, removeMedia. For the fields and an example of any op, call get_editing_guide with topic "<opName>".

## Sound
- Sound effects: search_sounds("whoosh"), then the sfx op with the id. Check peakDb, because files can differ by up to 15 dB.
  Starting points under a voice-over: whoosh/transition -14 dB 1.2 s · zoom -14 dB 0.6 s · riser -14 dB 2.5 s ending on the hit · boom/impact -10 dB 2.5 s · click -16 dB 0.6 s.
  No more than 2 overlapping effects. Put a big hit in a gap between words (insertGap can open one).
- Music: role "music", audioFx.duckUnderVoice:true. Never raise the voice above +6 dB. Speech must stay at least 12 dB above music and effects: check_audio measures it and balance_audio fixes it.

## Captions
Word timings first: transcribe (local Whisper, if installed) or set_transcript (from an ASR json file / word list).
Always pass the real script when you have it: Whisper misspells, and the script words replace its words while keeping its timings.
Then use addCaptions with words:"transcript". Short chunks (1–3 words) read best. Put a word with "!" in its own chunk with "chunks":[1,3,2,…]. Use hook0:true so there is a caption on the first frame.

## Snapshot and look
snapshot(times:[0.3, "word:…", "end"]) returns the frames as images. Look at every one.
Over 6 frames, it returns one contact sheet. Check the opening frame, every cut, every text or caption, the key moment and the last frame.

## Reference sections (get_editing_guide topic = number or word)
`;

// ───────────────────────────── docs/CLAUDE-API.md sections ─────────────────────────────

let docCache = null;

/** → [{level, num, title, start, end}] over the lines of the reference (fenced code is not scanned for headings). */
export function docSections() {
  let text;
  try { text = fs.readFileSync(API_DOC, 'utf8').replace(/^﻿/, ''); } catch { return { text: '', lines: [], sections: [] }; }
  if (docCache && docCache.text === text) return docCache;
  const lines = text.split(/\r?\n/);
  const sections = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence) return;
    const m = /^(#{2,4})\s+(.*)$/.exec(l);
    if (!m) return;
    const title = m[2].trim();
    const num = (/^(\d+(?:\.\d+)*)\.?\s/.exec(title) || [])[1] || '';
    sections.push({ level: m[1].length, num, title, start: i, end: lines.length });
  });
  for (let k = 0; k < sections.length; k++) {
    const s = sections[k];
    const next = sections.slice(k + 1).find((x) => x.level <= s.level);
    s.end = next ? next.start : lines.length;
  }
  docCache = { text, lines, sections };
  return docCache;
}

export function docToc() {
  const { sections } = docSections();
  return sections.filter((s) => s.level <= 3).map((s) => `${s.level === 3 ? '  ' : ''}- ${s.title}`).join('\n');
}

const norm = (s) => String(s || '').toLowerCase().replace(/[֑-ׇ]/g, '').trim();

/** Sections that match a topic: a section number ("4.9"), words of a heading, or (fallback) text inside sections. */
export function findSections(topic, { max = 3 } = {}) {
  const { lines, sections } = docSections();
  const t = norm(topic).replace(/^§/, '');
  if (!t) return [];
  const body = (s) => lines.slice(s.start, s.end).join('\n');
  let hits = /^\d+(\.\d+)*$/.test(t) ? sections.filter((s) => s.num === t) : [];
  if (!hits.length) hits = sections.filter((s) => norm(s.title).includes(t));
  if (!hits.length) {
    const words = t.split(/\s+/).filter((w) => w.length > 1);
    hits = sections.filter((s) => s.level >= 3 && words.every((w) => norm(body(s)).includes(w)));
    hits.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  }
  // drop a hit that is already inside an earlier, bigger hit
  const out = [];
  for (const s of hits) if (!out.some((o) => s.start >= o.start && s.end <= o.end)) out.push(s);
  return out.slice(0, max).map((s) => ({ title: s.title, text: body(s) }));
}

/** The smallest section of the reference that shows an example of `"op": "<op>"`. */
export function sectionForOp(op) {
  const { lines, sections } = docSections();
  const re = new RegExp(`"op"\\s*:\\s*"${op.replace(/[^A-Za-z]/g, '')}"`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx < 0) return null;
  const inside = sections.filter((s) => s.start <= idx && s.end > idx).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  return inside ? { title: inside.title, text: lines.slice(inside.start, inside.end).join('\n') } : null;
}
