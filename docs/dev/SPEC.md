# Frame Studio — technical spec (the original module contracts)

> This is the spec the modules were first built against. The code has grown since (MCP server, sound folders, the
> Windows installer, Microsoft Edge support…); [`../ARCHITECTURE.md`](../ARCHITECTURE.md) is the current map. Where the
> two differ, the code wins.

Offline desktop video editor (CapCut-style UX + selected Premiere pro features) that Claude
can drive programmatically (HTTP API + CLI) while the user watches the edit happen live
and keeps editing by hand. Hebrew UI (RTL). Social video focus (9:16 1080x1920 default).

Root: the repository folder (call it ROOT).
Runtime: Node 24 (global `fetch`, `WebSocket`, no npm deps at all), Google Chrome or Microsoft Edge
(auto-detected per OS, or `"chrome"` in ROOT/config.json) for the UI window (`--app=`) and for
headless export, ffmpeg/ffprobe on PATH (Gyan full build 9.x), Python 3.12 optional.
Machine-specific settings live in ROOT/config.json (gitignored; documented in config.example.json), read by `server/config.mjs`.
**NO external dependencies, NO CDN, NO internet at runtime. Vanilla ES modules only.**
`package.json` at ROOT: `{"name":"frame-studio","type":"module","private":true}`.

## 0. Golden rules for every module

1. Pure ES modules. Files under `shared/` and `render/` must be importable by BOTH the browser and
   Node: no DOM/window access at module top level (only inside functions), no Node built-ins.
   `server/` and `cli/` may use Node built-ins (`node:fs`, `node:path`, `node:child_process`, `node:http`, `node:crypto`, `node:os`, `node:url`, `node:stream`).
2. Times are seconds (float). Never mutate a project object passed in; ops return new objects.
3. Every user-visible string is Hebrew. Code identifiers/ids are English.
4. Paths may contain Hebrew and spaces. Always pass args arrays to `spawn` (never shell strings).
   Use `path.resolve`, forward or back slashes both OK. URLs: encodeURIComponent each segment.
5. Determinism: a rendered frame is a pure function of (project, t). No Math.random at render
   time — use `hash(seed, n)` from shared/anim.js. No timers inside renderers.
6. Hebrew text: set direction per text run/canvas (`ctx.direction='rtl'`); never put
   `dir=rtl` on the export render page's <html>. Wait for fonts (`document.fonts.load`) before
   measuring. Never reveal Hebrew words through a moving mask line (whole-word motions only).
7. The timeline itself is LTR (time flows left→right) even in the RTL UI.

## 1. Folder layout and file ownership

```
ROOT/
  package.json  start.cmd  cutx.cmd  README.md            (S = server group; cutx.cmd = C)
  server/main.mjs          S  HTTP server, routing, static, SSE, project store, history
  server/media.mjs         S  ffprobe, proxy/audio/peaks/thumbs generation, file serving
  server/asr.mjs           S  local faster-whisper transcription
  server/library.mjs       L  sound library index/search/categories/licenses, fonts list, LUT list
  server/export.mjs        A  export/snapshot jobs, headless Chrome, ffmpeg pipes, loudness, mux, audio check
  shared/model.js          M  data model, defaults, factories, time helpers, validation
  shared/ops.js            M  operation engine (pure)
  shared/anim.js           M  easing, springs, keyframe eval, clip animation presets, hash
  shared/catalog.js        M  re-exports catalogs from render/* and shared/anim.js + `getCatalog()`
  render/compositor.js     R  WebGL2 compositor (preview + export)
  render/transitions-gl.js R  transition shaders + TRANSITIONS metadata
  render/effects-gl.js     R  effects/filters/color/LUT/mask/chroma shaders + EFFECTS, FILTERS metadata
  render/sources.js        R  SourceProvider (video/image elements, preview sync, exact seek for export)
  render/text-render.js    T  text/caption/shape/sticker rasterizer + FONTS, TEXT_ANIMS, CAPTION_STYLES, TEXT_PRESETS, SHAPES, STICKERS
  render/audio-engine.js   A  WebAudio engine (preview + OfflineAudioContext export), meters, ducking, WAV encode
  render/render.html       A  headless page for export/snapshot
  render/render-page.js    A  drives Compositor + AudioEngine for export/snapshot jobs
  app/index.html           U  editor shell
  app/styles.css           U
  app/main.js              U  boot, project manager, store, API client, SSE live sync, undo/redo, shortcuts, toasts, export dialog
  app/viewer.js            U  preview canvas + transport (play/pause/scrub/JKL), safe-area overlay, on-canvas transform handles
  app/inspector.js         U  property panels for selected clip(s)/track/project
  app/timeline.js          L  timeline (tracks, clips, trim/move/split, snapping, markers, keyframes, transitions, zoom)
  app/library-panel.js     L  left panel tabs: media, audio, sound FX, text, captions, stickers, effects, transitions, filters
  app/api.js               U  tiny fetch wrapper used by all app modules (see §6)
  cli/cutx.mjs             M  command line for Claude
  docs/CLAUDE-API.md       M  how Claude edits: ops reference + recipes
  library/sounds/…         (gitignored) the generated Starter Pack; user sounds live in folders the user adds
  library/fonts/           (exists) assistant-*.woff2, heebo-*.woff2, Heebo-VariableFont_wght.ttf
  library/luts/            .cube files (L generates a few built-in .cube LUTs)
  projects/<projectId>/project.json, media/, cache/{proxy,audio,peaks,thumbs}/, exports/, snapshots/
```
Letters = the module group a file belongs to (S server, L library + timeline, A audio + export, M model / ops / CLI,
R renderer, T text, U editor UI, C CLI launcher). Modules talk to each other only through the interfaces in this spec.

## 2. Data model (shared/model.js)

```js
Project = {
  version: 1,
  id: "my-video",                // folder name under ROOT/projects; [a-z0-9-]+ (or Hebrew allowed? NO: ascii slug)
  name: "שם הפרויקט",
  rev: 0,                        // server increments on every change
  settings: { width:1080, height:1920, fps:30, background:"#000000", sampleRate:48000,
              safeArea:"reels" /* none|reels|tiktok|youtube */, masterGainDb:0, targetLufs:-14 },
  media: { [mediaId]: Media },
  tracks: [ Track ],             // ORDER = top-to-bottom in the timeline UI. Compositing draws
                                 // visual tracks from LAST to FIRST (tracks[0] ends on top).
  clips: { [clipId]: Clip },
  markers: [ { id, t, label:"", color:"#f5c518" } ],
  transcript: { words: [ { w:"שלום", s:0.12, e:0.48 } ], mediaId?:string },   // optional, used for word-time refs
  meta: { created: iso, modified: iso, lastEditor: "user"|"claude" }
}

Media = { id, kind:"video"|"image"|"audio", name, path /* absolute source path */,
  duration /* s; images: 0 */, width, height, fps, hasVideo, hasAudio, channels, sampleRate, size,
  status:"ready"|"processing"|"error", error?,
  proxy? /* project-relative path of H.264 proxy mp4, video only */,
  audio? /* project-relative wav 48k stereo for anything with audio */,
  peaks? /* project-relative json */, thumbs? /* project-relative dir of jpg, 1 per second */,
  library?: { soundId } }

Track = { id, kind:"video"|"audio", name, role:"main"|"overlay"|"text"|"effects"|"voice"|"music"|"sfx",
  hidden:false, muted:false, locked:false, solo:false, volume:1 /* linear, audio */, height?:number }
// "video" tracks hold visual clips (video,image,text,caption,shape,sticker,effect,adjustment).
// "audio" tracks hold audio clips (and nothing else).

Clip = {
  id, trackId, type: "video"|"image"|"audio"|"text"|"caption"|"shape"|"sticker"|"effect"|"adjustment",
  name:"", start:0, duration:5, color?:"#hex" /* timeline tint */, disabled:false,
  // media-backed (video|image|audio):
  mediaId?, in:0 /* source in-point s */, speed:1, reverse:false,
  // visual (all visual types):
  transform:{ x:0, y:0 /* px offset of clip center from canvas center */, scale:1, scaleX:1, scaleY:1,
              rotation:0 /* deg */, opacity:1, anchorX:0.5, anchorY:0.5, flipX:false, flipY:false },
  fit:"contain"|"cover"|"fill"|"none",      // base size of media relative to canvas; default video/image: "cover" if aspect within 5% else "contain"
  crop:{ l:0, t:0, r:0, b:0 },               // fractions of source
  blend:"normal"|"multiply"|"screen"|"overlay"|"add"|"darken"|"lighten"|"softlight"|"difference",
  keyframes:{ [prop]: [ { t /* s, relative to clip start */, v:number, ease:"linear"|"easeIn"|"easeOut"|"easeInOut"|"hold"|"spring"|"bounce"|"back"|"elastic" } ] },
      // keyframable props: "transform.x","transform.y","transform.scale","transform.scaleX","transform.scaleY",
      // "transform.rotation","transform.opacity","volume","color.<any color key>","crop.l|t|r|b","effects.<index>.<param>"
      // ease on keyframe k applies to the segment ARRIVING at k (from k-1 to k).
  animIn:  { id:"none", duration:0.4 },  animOut:{ id:"none", duration:0.4 },
  animLoop:{ id:"none", speed:1, intensity:1 },
  color:{ exposure:0, brightness:0, contrast:0, saturation:0, vibrance:0, temperature:0, tint:0,
          highlights:0, shadows:0, hue:0, vignette:0, sharpen:0, grain:0, fade:0 },   // each -1..1 (hue -180..180)
  filter:{ id:"none", amount:1 },              // id from FILTERS
  lut:{ file:null, amount:1 },                 // file = name in library/luts
  effects:[ { id, params:{…}, enabled:true } ],// ids from EFFECTS; applied in order to this clip's layer
  mask:{ type:"none"|"rect"|"ellipse"|"linear"|"mirror", x:0, y:0, w:0.6, h:0.6 /* fractions of layer */, rotation:0, feather:0.05, invert:false },
  chroma:{ enabled:false, color:"#00ff00", similarity:0.35, smoothness:0.08, spill:0.5 },
  transitionOut:{ id:"none", duration:0.5, params:{} }, // transition between THIS clip and the next clip on the same track that starts at this clip's end (±1 frame). Centered on the cut.
  // audio (audio clips AND video clips with audio):
  volume:1 /* linear 0..4 */, fadeIn:0, fadeOut:0, pan:0 /* -1..1 */, muteAudio:false,
  audioFx:{ voiceEnhance:false, denoise:false, eqPreset:"none", duckUnderVoice:false, duckDb:-10 },
  // text:
  text:{ content:"טקסט", font:"Heebo", weight:800, size:96 /* px at canvas scale */, color:"#ffffff",
         align:"center", lineHeight:1.15, letterSpacing:0, maxWidth:900, dir:"auto", italic:false, underline:false,
         stroke:{ color:"#000000", width:0 }, shadow:{ color:"rgba(0,0,0,0.6)", blur:12, x:0, y:4 },
         background:{ color:"#000000", opacity:0, padding:24, radius:24 },
         glow:{ color:"#ffd60a", blur:0 }, gradient:null /* {from,to,angle} */ },
  textAnim:{ in:"none", out:"none", loop:"none", inDuration:0.4, outDuration:0.3, perWord:false },
  // caption (one clip = one on-screen chunk of 1-6 words):
  caption:{ words:[ { w, s, e, hot:false } ] /* s/e ABSOLUTE timeline seconds */, style:"karaoke",
            activeColor:"#ffd60a", hotColor:"#ff4d6d" },  // plus clip.text for base styling
  // shape:
  shape:{ kind:"rect"|"roundrect"|"ellipse"|"line"|"arrow"|"star"|"triangle"|"heart"|"burst"|"progress",
          w:400, h:400, fill:"#13b6e4", stroke:"#ffffff", strokeWidth:0, radius:40, progressFrom:0, progressTo:1 },
  // sticker:
  sticker:{ kind:"emoji"|"builtin", value:"🔥", size:220 },
  // effect / adjustment clips (on video tracks): apply to the COMPOSITE of all tracks below them during [start,end):
  //   effect: uses clip.effects[0..] ; adjustment: uses color/filter/lut/effects
}
```
Defaults: `newClip(type, props)` fills every field above with defaults (deep-merged with props).
Helpers to export from model.js:
`uid(prefix)` (e.g. "c_" + 8 base36 chars, deterministic-safe: crypto.getRandomValues if available else Math.random — only used at edit time),
`newProject({id,name,width,height,fps})`, `newTrack(kind, props)`, `newClip(type, props)`, `clipEnd(c)`,
`projectDuration(p)` (max clip end, min 1/fps), `clipsOnTrack(p, trackId)` sorted by start, `activeClipsAt(p,t)`
(clips with start<=t<end, not disabled), `nextClipOnTrack(p, clip)` (adjacent within 1 frame),
`sourceTimeAt(clip, t, media)` (in + (t-start)*speed, reverse aware, clamped to [0, media.duration]),
`snapToFrame(t, fps)`, `formatTimecode(t, fps)` → "MM:SS:FF", `deepMerge(a,b)`, `getPath(obj,"a.b")`, `setPath(obj,"a.b",v)` (immutable),
`validateProject(p)` → array of problems (strings), `DEFAULT_TRACKS()` → [text "טקסט", overlay "שכבה", main "ראשי", voice "קריינות", music "מוזיקה", sfx "אפקטים קוליים"],
`ROLE_LABELS` Hebrew, `CLIP_TYPE_LABELS` Hebrew.

## 3. Operations (shared/ops.js)

`applyOps(project, ops, ctx={}) → { project, results }` — pure; deep-clones; each op returns a result
`{ ok:true, id?, ids? } | { ok:false, error:"Hebrew message" }`; an op error does NOT abort the batch
unless `ctx.atomic` (then the original project is returned unchanged and all results report).
`ctx.media` may supply resolved media for path-based ops (server pre-imports paths, see §5).

Time values anywhere a time is expected (`start`, `at`, keyframe `t` with `abs:true`, marker `t`) may be:
- a number (seconds)
- `{ "word":"ביצים!", "n":0, "offset":-0.05, "edge":"start"|"end" }` → resolved against project.transcript.words
  (exact match first, then match ignoring punctuation/niqqud; `n` = occurrence index)
- `{ "marker":"label", "offset":0 }`, `{ "clip":"clipId", "edge":"start"|"end", "offset":0 }`

Ops (field `op`), all accept an optional client-chosen `id` for created objects (so later ops in the same batch can reference it):
- `setSettings { set:{…} }`
- `addTrack { kind, name?, role?, index? }` → id ; `updateTrack { id, set }` ; `removeTrack { id }` (and its clips) ; `moveTrack { id, index }`
- `addClip { type, track? (id) | role? ("main","overlay","text","voice","music","sfx","effects"), start, duration?, mediaId? | path?, in?, …any clip fields }`
  → id. If no track given: choose by role/type (video/image→main if free at that time else overlay; text→text; caption→"captions" track created on demand with role text and name "כתוביות"; audio→sfx unless role given; effect/adjustment→"effects" track created on demand at index 0).
  If the target track is occupied at that time and the op has `"overlap":"newTrack"` (default for overlay/sfx/text), create a new track of same role just above (video) / below (audio). `"overlap":"allow"` keeps it.
  duration default: media duration/speed minus in (video/audio), 3 s images, 3 s text, 2 s shapes/stickers, 1 s effects.
- `updateClip { id, set:{ "path.to.prop": value, … } }` (paths per §2; set "text.content" etc.) also `merge:{…}` deep-merge
- `removeClip { id, ripple?:false }` ; `moveClip { id, start, track? }` ; `trimClip { id, start?, end? }` (adjusts `in` for media)
- `splitClip { id, at }` → ids [left,right] (handles keyframes, captions words, fades)
- `duplicateClip { id, start?, track? }` → id
- `setKeyframe { id, prop, t, v, ease? }` (t relative to clip start unless `abs:true`) ; `removeKeyframe { id, prop, t }` ; `clearKeyframes { id, prop? }`
- `setTransition { id /* outgoing clip */, transition, duration?, params? }` ; `removeTransition { id }`
- `addEffect { id, effect, params?, index? }` ; `updateEffect { id, index, params }` ; `removeEffect { id, index }`
- `addCaptions { words:[[w,s,e]…] | [{w,s,e}…] | "transcript", chunks?:[n…] | maxWords?:3, maxChars?:18, style?, hot?:[words], track?, text?:{…style overrides}, y?:number /* transform.y */ , gap?:0.0 }`
  → ids. Each chunk = one caption clip from its first word start to next chunk start (last: last word end + 0.4 s). Sentences break chunks after words ending with . ! ? (and not crossing).
- `setTranscript { words }`
- `addMarker { t, label?, color? }` → id ; `removeMarker { id }`
- `rippleDelete { from, to, tracks?:[ids] }` ; `insertGap { at, duration, tracks? }`
- `removeClips { ids }` ; `select` is NOT an op (UI-only).
- `sfx { sound:"query or soundId or path", at, gain_db?, len?, fade?, from? /* offset into file */, track? }`
  sugar for addClip type audio role sfx: server resolves `sound` via library search (best match) → path.
Export from ops.js also: `OPS_HELP` (array of {op, fields, he:"תיאור"}) used by CLI help and docs, and `resolveTime(project, v)`.

## 4. Animation (shared/anim.js)

`EASINGS` map name→fn(p∈[0,1])→[0,1] (+overshoot allowed for back/elastic/spring/bounce).
`spring(p, {zeta=0.55, omega=…})` closed-form underdamped step response normalized so value(1)=1 exactly.
`evalKeyframed(clip, prop, localT, fallback)` → number. `evalClipProps(clip, localT)` → resolved transform/opacity/volume/color/effect params.
`CLIP_ANIMS` = { in:[…], out:[…], loop:[…] } each `{ id, name /* Hebrew */ }`; ids at least:
 in: none, fadeIn, zoomIn, zoomOut, slideLeft, slideRight, slideUp, slideDown, pop, bounceIn, spinIn, blurIn, dropIn, swingIn, flipIn, stretchIn, glitchIn, whipIn
 out: none, fadeOut, zoomIn, zoomOut, slideLeft, slideRight, slideUp, slideDown, popOut, spinOut, blurOut, dropOut, flipOut, whipOut
 loop: none, pulse, float, shake, wobble, spin, swing, heartbeat, flicker, kenBurns, drift, breathe, jiggle
`animState(clip, localT, canvasW, canvasH)` → `{ dx, dy, scale, scaleX, scaleY, rotation, opacity, blur, glitch }`
combined from animIn (during first inDuration), animOut (last outDuration), animLoop (always). Compositor
multiplies scale/opacity and adds dx/dy/rotation on top of evaluated transform; blur/glitch → extra shader pass.
`hash(seed, n)` → [0,1) deterministic. `noise1(t, seed)` smooth value noise.

## 5. Server (server/main.mjs) — HTTP API on http://127.0.0.1:7788

Static: `/` → app/index.html ; `/app/*`, `/render/*`, `/shared/*`, `/library/fonts/*`, `/library/luts/*` from ROOT.
Correct MIME types (js → text/javascript, wasm, woff2, ttf, css, html, json, png, jpg, svg, mp4, wav, mp3, m4a, ogg, flac, cube→text/plain).
All media files with HTTP Range support (206) — required for <video>/<audio> seeking.
JSON in/out, UTF-8. Errors: `{error:"Hebrew message"}` with 4xx/5xx.

- `GET  /api/health` → `{ok:true, version, root, port}`
- `GET  /api/projects` → `[ {id,name,width,height,fps,duration,modified,clipCount} ]`
- `POST /api/projects {id?, name, width?, height?, fps?, tracks?:"default"|"empty"}` → project
- `GET  /api/projects/:id` → project ; `DELETE /api/projects/:id` → moves folder to ROOT/projects/.trash
- `POST /api/projects/:id/ops {ops:[…], by:"user"|"claude", summary?:"Hebrew", atomic?}` →
  `{rev, results, project}`. Server first walks ops: any `path` field (addClip) is imported (same as /import) and replaced by `mediaId`;
  `sfx` ops resolve `sound` via library.mjs `resolveSound(q)`. Then applyOps, rev++, meta.modified, save (atomic write: tmp + rename), push history snapshot, broadcast SSE.
- `POST /api/projects/:id/undo` / `redo` → `{rev, project}` (server-side snapshot history, max 300; redo cleared on new change). Broadcast.
- `POST /api/projects/:id/import {paths:[…], copy?:false}` → `{media:[Media]}` returns immediately with status "processing"; background generation; SSE `media` event when ready.
- `POST /api/projects/:id/upload?name=<file name>` raw body → saved to project media/ then imported.
- `GET  /api/projects/:id/media/:mediaId/{file|proxy|audio|peaks|thumb?t=<sec>}` (thumb → nearest 1 s jpg)
- `GET  /api/events?project=:id` SSE. Events (JSON in `data:`): `{type:"project", rev, by, summary, project}`,
  `{type:"media", media}`, `{type:"job", job}` (progress), `{type:"hello", rev}`. Heartbeat comment every 15 s.
- `POST /api/projects/:id/transcribe {mediaId | path, model?:"small", captions?:{…addCaptions options}}` → job; on finish sets transcript (and captions if asked) via ops by "claude"/"user".
- Library (server/library.mjs, mounted by main.mjs via `export function routes()`), see §7.
- Export (server/export.mjs, mounted via `export function routes()`), see §8.
- `POST /api/open {project?}` → opens a Chrome app window on the editor (`chrome --app=http://127.0.0.1:7788/?project=ID --new-window`).

Module mounting contract: each of library.mjs / export.mjs exports
`export function routes(ctx)` returning `[{method, pattern /* RegExp with groups */, handler: async (req,res,match,ctx)=>{}}]`
where `ctx = { ROOT, PORT, loadProject(id), saveProject(project), applyAndBroadcast(id, ops, by, summary), broadcast(projectId, event), sendJson(res, code, obj), readJson(req), readBody(req) /* Buffer */, serveFile(req,res,absPath), projectDir(id), log(...) }`.
main.mjs imports `./library.mjs` and `./export.mjs` and registers their routes.

media.mjs: `probe(path)` (ffprobe -v error -show_streams -show_format -of json), `ensureDerivatives(projectDir, media, onProgress)`:
- video → proxy `cache/proxy/<id>.mp4`: `-vf scale='min(1920,iw)':-2` keeping aspect (long side ≤1920), libx264 `-crf 17 -preset veryfast -g 10 -keyint_min 10 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart`, audio aac 192k 48k (if any). (Fast seeking in Chrome.)
- anything with audio → `cache/audio/<id>.wav` pcm_s16le 48000 2ch.
- peaks → `cache/peaks/<id>.json` `{rate:100, peaks:[0..1 max abs per 10 ms, mono]}` computed in Node from `ffmpeg -f s16le -ac 1 -ar 8000 -` stdout.
- thumbs → `cache/thumbs/<id>/%05d.jpg` `fps=1,scale=-2:120` (video); images: one thumb.
- images: probe width/height (ffprobe works for png/jpg/webp/gif); kind image; duration 0.
Run derivative jobs in a queue (max 2 concurrent ffmpeg).

asr.mjs: run the Python configured as `asr.python` in ROOT/config.json (optional; not configured → transcription disabled with a hint) with ROOT/tools/asr.py (faster-whisper, language he,
word_timestamps, prints JSON) with cwd = the audio's folder and relative file names
(Hebrew absolute paths break that python), output `[[w,s,e]…]` → words. Then energy-snap word starts (like asr-snap: move each word
start to first rise of RMS above 10% of local max within ±0.3 s) — implement in Node from the wav.

## 6. Browser app (app/*) — RTL Hebrew, dark CapCut-like theme

`app/api.js` (owned by U, used by L too): `export const api = { get(path), post(path, body), del(path), url(path) }`,
`export async function applyOps(ops, summary)` (posts to current project, by "user"), `export function onEvent(type, fn)`,
`export const state` (EventTarget-based store: `state.project`, `state.selection:Set<clipId>`, `state.playhead`, `state.zoom` (px per second),
`state.playing`, `state.tool` ("select"|"blade"), `state.snapping`, `state.previewScale`), `state.set(partial)` dispatches "change" with keys,
`export function on(key, fn)`. Optimistic local apply: `applyOps` runs shared/ops.js locally immediately (for snappy UI), then the server
response/SSE replaces state.project when its rev is newer.

Layout (CSS grid, full window, no page scroll): top bar (logo "Frame Studio", project name editable, undo/redo, "קלוד מחובר" live
indicator, export button) · right column (RTL start side): library panel (library-panel.js) · center: viewer (viewer.js) · left column:
inspector (inspector.js) · bottom (full width, resizable splitter): timeline (timeline.js).
Project manager overlay on start (if no ?project=): list projects, create new with aspect presets 9:16 / 16:9 / 1:1 / 4:5 / custom, fps 24/25/30/60, open, delete.
Live sync: when an SSE project event with `by:"claude"` arrives, show a toast "קלוד ערך: <summary>" and briefly flash the changed clips (diff by clip JSON).
Keyboard: Space play/pause, J/K/L shuttle, ←/→ frame step (Shift = 1 s), Home/End, S or Ctrl+B split at playhead, Delete/Backspace delete,
Shift+Delete ripple delete, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Ctrl+C/V/D, Ctrl+A, M marker, I/O in/out range, +/- timeline zoom, B blade, V select, N snapping.

Module contracts (all export a `mount(el)` function):
- `viewer.js`: `mount(el)`; uses `Compositor` + `SourceProvider` + `AudioEngine`; listens to state; exports `play()`, `pause()`, `seek(t)`, `togglePlay()`, `getCompositor()`.
  Playback master clock = AudioEngine clock. Preview resolution = settings × state.previewScale (0.5 default; options 0.25/0.5/1).
  On-canvas: click selects topmost visual clip under pointer; drag moves; corner handle scales; rotate handle; double-click text = edit inline.
  Overlays: safe-area guides (reels: top 250, bottom 350, sides 80, right 140 in lower half — px at 1080x1920 scale), rule-of-thirds toggle.
  Transport bar: timecode current/total, play, frame step, loop range toggle, preview quality select, fullscreen.
- `inspector.js`: `mount(el)`; tabs per selection type: "בסיסי" (transform, opacity, blend, fit, crop, flip), "אנימציה" (in/out/loop + durations),
  "צבע" (all color sliders, filter + amount, LUT), "אפקטים" (list, add, params, enable), "מסכה", "מפתח כרום", "מהירות" (speed, reverse),
  "אודיו" (volume dB, fades, pan, voice enhance, denoise, duck under voice), "טקסט" (content textarea, font, weight, size, color, stroke, shadow,
  background, glow, align, spacing, presets), "כתוביות" (style, colors, words table with times + hot toggles), "צורה"/"מדבקה".
  Each numeric field: slider + number input + keyframe diamond button (adds/removes keyframe at playhead for keyframable props; highlighted when
  a keyframe exists at the playhead; arrows to jump prev/next keyframe). Multi-select edits apply to all. Nothing selected → project settings
  (size, fps, background, safe area, target LUFS) + track list.
- `timeline.js` (L): `mount(el)`; canvas or DOM (DOM with virtualization is fine) timeline: ruler with timecode, playhead (drag to scrub),
  track headers (name, role icon, mute/hide/lock/solo, volume for audio, add-track menu, reorder by drag), clips with thumbnails
  (video: thumb strip via `/media/:id/thumb?t=`), waveforms (peaks JSON), text preview, caption words, colors by type; drag to move (across
  tracks of compatible kind, creates new track when dropped in empty space above/below), trim edges (respect media length unless image/text),
  blade tool, multi-select (Ctrl/Shift click, marquee), snapping to playhead/clip edges/markers/keyframes (toggle N), magnetic main track option
  (ripple on main track like CapCut), transition badge at each junction (click → choose transition; drop transition from library), keyframe
  diamonds on selected clip, markers on ruler, zoom (Ctrl+wheel, slider, fit), horizontal scroll, auto-scroll during playback, in/out range shading,
  drop targets for library items (media, sounds, text presets, stickers, effects, transitions) via HTML5 DnD with dataTransfer type
  "application/x-frame-studio" JSON `{kind:"media"|"sound"|"text"|"caption"|"sticker"|"shape"|"effect"|"transition"|"filter"|"anim", …}`.
  Context menu (right click): split, delete, ripple delete, duplicate, copy/paste, detach audio (video→ separate audio clip + muteAudio), speed, add marker, rename, color.
  All edits go through `applyOps` with a Hebrew summary.
- `library-panel.js` (L): `mount(el)`; vertical tab strip with icons + Hebrew labels:
  מדיה (project media bin: import by drag&drop from Explorer → upload, "ייבוא מנתיב" input, grid with thumbs/duration, status, drag to timeline, double-click adds at playhead),
  אודיו (music/voice files from library sources),
  אפקטים קוליים (sound library: category tree + search box + filter by duration; each row: name, category, duration, mini waveform; click = audition
  (play/stop), drag to timeline or "+" adds at playhead on sfx track; shows license badge),
  טקסט (text presets grid rendered with text-render.js thumbnails), כתוביות (caption styles + "תמלול אוטומטי" button + import SRT/JSON),
  מדבקות (emoji + built-in SVG stickers + shapes), אפקטים (EFFECTS grid with animated thumbnails optional), מעברים (TRANSITIONS grid), פילטרים (FILTERS),
  אנימציות (CLIP_ANIMS / TEXT_ANIMS, drag onto clip).

## 7. Library (server/library.mjs)

Scans `ROOT/library/sounds/**` for .wav .mp3 .flac .ogg .m4a .aif .aiff (also extra music/voice folders from ROOT/config.json
`"library": {"music":[ "D:/My music" ]}`; the legacy `ROOT/library/sources.json` `{"music":[…]}` is still read when config.json has none).
Index cached at `ROOT/library/sounds/index.json` (rebuild if folder mtime changed or `?rebuild=1`), built with a worker queue using ffprobe for
duration/channels/sampleRate and a fast peak scan (ffmpeg astats or reading PCM at 4 kHz mono) for `peakDb` and a 64-point mini waveform.
Entry: `{ id /* sha1(relPath).slice(0,12) */, name /* cleaned title */, file /* relPath from ROOT/library/sounds or abs for sources */,
 abs, collection:"אפקטים קוליים"|"מוזיקה", pack /* the folder below a "…Sonniss…" folder (e.g. "344 Audio - Bass Drops & Downers Vol. 1"), else the parent folder */,
 category /* Hebrew category from the UCS prefix or name keywords */, ucs /* e.g. DSGNBass */, tags:[…English+Hebrew], duration, channels,
 sampleRate, peakDb, wave:[64 floats], license:"sonniss"|"mixkit"|"own"|"other", role?, suggest?:{gainDb,len} /* generic role in a video, see below */ }`.
UCS prefix → Hebrew category map (Sonniss filenames start with e.g. AERO, AMB, ANML, BELL, CART, CLOCK, CRWD, DSGN(+Bass/Bram/Impt/Erie/Rise/Swsh…), ELEC,
FGHT, FIRE, FOLY, GLAS, HORN, IMPT, MAGC, MECH, METL, MOTR, PAPR, ROCK, SCIF, SWSH, TOON, UI, VEH, VOX, WATR, WEAP, WIND, WHSH, WOOD, etc.)
e.g. בומים ומכות / וושים ומעברים / עולים ומתח / בס נופל / ממשק ולחיצות / פולי / קולות / אווירה / רכבים / טבע / קריקטורה / נשק וקרב / מדע בדיוני / אימה / שונות.
Sound effects get a generic `role` (first match): braam "בראאאם", glitch "גליץ׳", riser "עולה", zoom "זום" (by name keywords), then by category:
"בס נופל", "מכה" (בומים ומכות), "מעבר" (וושים ומעברים), "מתח" (עולים ומתח / אימה), "לחיצה" (ממשק ולחיצות) — each with a starting gain/length (`suggest`).
Routes: `GET /api/library/sounds?q=&category=&collection=&min=&max=&limit=200&offset=0` (search over name/tags/pack/category, Hebrew+English,
ranked), `GET /api/library/sounds/categories` → tree with counts, `GET /api/library/sounds/:id` (entry), `GET /api/library/sounds/:id/file` (Range),
`GET /api/library/sounds/:id/peaks` (full peaks, computed+cached in ROOT/library/sounds/.peaks/<id>.json),
`GET /api/library/fonts` → `[ {family, weights:[…], url?, system:bool, license} ]` (local files in library/fonts + Windows system Hebrew fonts:
Arial, David, Frank Ruehl, Gisha, Rod, Segoe UI, Tahoma, Bahnschrift, Impact (latin), Segoe UI Emoji),
`GET /api/library/luts` → names, `GET /api/library/licenses` → markdown text of ROOT/library/LICENSES.md (write it: Sonniss GDC bundle =
royalty-free, commercial use, no attribution, no AI training; Mixkit = free license for commercial social/ads use, no credit, do not redistribute the files;
transitions/effects/filters/stickers/LUTs = original code of Frame Studio, free; fonts: Heebo/Assistant = SIL OFL; Windows fonts = licensed with Windows for use in output).
Export also `resolveSound(q)` (id | relPath | abs path | file name | role name | best search match) for the server's `sfx` op.
Also generate 8 built-in .cube LUTs (size 17) into library/luts if missing: teal-orange, warm-film, cool-night, bleach-bypass, vintage-fade, mono-contrast, golden-hour, cyan-night.

## 8. Rendering engine (render/*)

### compositor.js (R)
```js
export class Compositor {
  constructor(canvas /* HTMLCanvasElement|OffscreenCanvas */, { mode:"preview"|"export", scale:1 })
  setProject(project)                 // also invalidates caches when clips change
  setScale(scale)                     // preview resolution factor
  async renderFrame(t, sources)       // export: awaits exact source frames; draws final frame
  renderFrameSync(t, sources)         // preview: never awaits; uses whatever frames sources have
  readPixels() → Uint8Array           // RGBA, top-to-bottom rows, settings.width*height*4 (export mode, scale 1)
  hitTest(t, x, y) → clipId|null      // canvas-pixel coords (unscaled); topmost visual clip whose transformed quad contains point
  clipBounds(t, clipId) → {cx,cy,w,h,rotation,corners:[[x,y]…4]} // canvas px, for viewer handles
  dispose()
}
```
Pipeline per frame (WebGL2, premultiplied alpha throughout, FBO pool):
1. comp = clear(settings.background). Walk visual tracks from last to first (skip hidden). For each active clip (incl. transition partners):
2. layer texture: source (video element / image / text canvas from text-render.js / shape / sticker) → upload texture (cache by key; video every frame)
   → crop → chroma key → color (all color params) → filter preset → LUT (3D texture from .cube via fetch `/library/luts/<file>`) → clip effects
   (in order) → mask → animState blur/glitch.
3. draw layer onto comp with model matrix (fit base size, transform evaluated with keyframes + animState, anchor, flip, rotation), opacity, blend mode.
4. Transitions: if t within [cut - d/2, cut + d/2] of clip A's transitionOut to adjacent next clip B: render A and B each as full-canvas
   transformed layers (A uses source times beyond its end if media allows, else holds last frame; B before its start likewise), combine with the
   transition shader at progress p = (t - (cut - d/2)) / d, draw result with normal blend.
5. Effect/adjustment clips on a track: apply to the current comp (everything drawn so far = tracks below) during their time.
6. Final blit to canvas (flip Y correctly; readPixels returns top-down).
Text/caption/shape/sticker layers come from `text-render.js` `rasterize(clip, t, project, scale)` (see T) — returns canvas + bounds in canvas px.
Must handle lost context, and never throw on a missing frame (draw nothing for that clip).

### transitions-gl.js (R)
`export const TRANSITIONS = [ { id, name /* Hebrew */, category /* "בסיסי"|"החלקה"|"ניגוב"|"זום"|"צורות"|"דיגיטלי"|"קולנועי"|"תלת־ממד" */, defaultDuration, params:[{key,name,type:"number"|"color"|"select",min,max,default,options?}] , glsl } ]`
At least 36, all original GLSL (fragment shader body using `getFromColor(uv)`, `getToColor(uv)`, `progress`, `ratio`, params uniforms):
crossfade, dipBlack, dipWhite, flashWhite, slideLeft, slideRight, slideUp, slideDown, pushLeft, pushRight, pushUp, pushDown,
coverLeft, coverRight, wipeLeft, wipeRight, wipeUp, wipeDown, wipeDiagonal, circleOpen, circleClose, diamond, clockWipe, blinds,
squares, zoomIn, zoomOut, zoomBlur (whip zoom), whipLeft, whipRight (directional motion blur), spin, swirl, ripple, pixelate,
glitch, rgbSplit, filmBurn (procedural light leak), lumaDissolve (noise), crossZoom, cube (3D), doorway, pageFlip-lite (fold), shake, splitReveal.
`export function compileTransition(gl, id)` → program cache; `export function drawTransition(gl, id, fromTex, toTex, progress, params, w, h)`.

### effects-gl.js (R)
`export const EFFECTS = [ { id, name, category, params:[…], glsl, appliesTo:"clip"|"both" } ]` at least 32 original effects:
blur, directionalBlur, zoomBlur, radialBlur(spin), shake, zoomPunch (scale pulse with spring at start, params: strength, time),
flash, strobe, glitch, rgbSplit, vhs, filmGrain, scanlines, crt, vignette, lightLeak, bloom/glow, neonEdges, pixelate, mosaicBlocks,
mirror, kaleidoscope, invert, posterize, duotone, blackWhite, sepia, halftone, sharpen, shockwave (expanding ring distortion), whip (motion streak),
letterbox (cinematic bars), wave (distortion), fisheye, tvOff, colorPop (keep one hue), lensDistortion, chromaticAberration-edge, rainbow, heat-haze.
Time-based effects get `time` (seconds since clip/effect start) and `progress`.
`export const FILTERS = [ { id, name, color:{…color params}, lut? } ]` ≥ 20: natural, vivid, cinematic, tealOrange, warm, cool, vintage, fadeMatte,
blackWhite, noir, sepia, dramatic, pastel, sunset, moody, neonNight, film, retro80, summer, winter, cyanNight (cyan/night), cleanSkin.
Also exports `applyColor(gl, tex, colorParams, …)`, `applyEffect(gl, effectId, tex, params, time, …)`, `applyMask`, `applyChroma`, `loadCubeLut(gl, text)`.
(R decides internal factoring; compositor.js is the only consumer.)

### sources.js (R)
```js
export class SourceProvider {
  constructor({ mode:"preview"|"export", projectId, apiBase:"" })
  setProject(project)
  // preview: maintains one <video muted playsinline preload=auto> per (mediaId) pool slot, src = proxy URL; images as ImageBitmap
  getSync(clip, sourceTime)          // → TexImageSource|null (video element if its currentTime within 1.5 frames, else last good canvas copy)
  async getExact(clip, sourceTime)   // export: seek & await 'seeked' + requestVideoFrameCallback; returns element; caches images
  startPlayback(t, project) / stopPlayback() / tick(t)  // preview: play videos that are active at t with playbackRate=speed, keep drift < 0.08 s (re-seek), pause inactive
  preloadAround(t)                    // warm next clips
  dispose()
}
```
Media URLs: proxy `/api/projects/${id}/media/${mediaId}/proxy` (fallback `/file` when no proxy, e.g. images use `/file`).

### text-render.js (T)
```js
export const FONTS = [ { family:"Heebo", weights:[100…900], src:"/library/fonts/Heebo-VariableFont_wght.ttf" }, { family:"Assistant", … woff2 },
  …system: "Arial","David","Frank Ruehl","Gisha","Rod","Segoe UI","Tahoma","Bahnschrift","Impact" ]
export async function ensureFonts(project)          // registers @font-face (FontFace API) + document.fonts.load for every family/weight used, with Hebrew sample "אבג"
export function rasterize(clip, t /* timeline time */, project, scale=1) → { canvas, w, h, cx, cy } | null
   // canvas in DEVICE pixels = canvas px * scale; (cx,cy) = where the canvas center sits relative to the clip's anchor point in canvas px
   // (normally 0,0). Cache by content key; re-render only if key changes (animated text → key includes quantized time).
export const TEXT_PRESETS = [ { id, name, text:{…}, textAnim:{…} } ]   // ≥ 24 styles: title, subtitle, neon cyan, outline bold, white pill, black box,
   // yellow highlight, gradient pop, shadow 3D, handwriting-ish (Gisha italic), brand title (Heebo 900 paper + coral hot), quote, lower third, countdown, etc.
export const TEXT_ANIMS = { in:[…], out:[…], loop:[…] }   // per-text animations incl. per-word/per-char: typewriter, wordPop, wordSlideUp, charFade,
   // charDrop, blurIn, glitchType, scaleWords, karaokeFill(word color sweep — whole word color change, not mask), bounceWords, wave(loop), shimmer(loop), pulse(loop)
export const CAPTION_STYLES = [ { id, name, defaults:{ text:{…}, activeColor, hotColor } } ]  // ≥ 8:
   // "popWords" (Heebo 900 98px paper, stroke 14 dark, shadow; current word yellow #ffd60a, hot words red #ff4d6d; each word pops 1.28→1 in 0.13 s
   //   with outBack and rises 30 px exactly when spoken; upcoming words reserve space transparent so the line doesn't move),
   // "pill" (white rounded rect radius 20, black weight-800 text, switches on one frame, no animation),
   // "kinetic" (words spring in from blur with slight overshoot, strongest/hot word heavier & larger with underline sweep),
   // "karaoke" (all chunk words visible white, active word colored + scale 1.12),
   // "boldPop" (one word at a time, huge, stroke, pop), "boxHighlight" (active word gets colored rounded box behind it),
   // "minimal" (white + soft shadow, fade), "typewriter" (chars appear in order of speech).
export const SHAPES = [ … ], STICKERS = [ { id, name, kind:"emoji"|"builtin", value } ]  // ≥ 40 emoji + ≥ 16 built-in vector stickers drawn in code (arrow, circle highlight, underline swoosh, star burst, speech bubble, checkmark, x mark, subscribe-style bell, heart, fire, sparkles, click cursor, finger tap, magnifier, play button, website search bar)
export function drawThumbnail(kind, item, canvas)  // for library grid previews
```
Caption timing: words carry absolute s/e; a word is "active" while s <= t < next word s (or e + 0.15 for last). Hot words (`hot:true`) use hotColor.
RTL: Hebrew runs laid out right-to-left with per-word measurement so animations are per word; numbers/latin inside keep LTR (use canvas bidi per word).
Line wrapping to `maxWidth`, multi-line, align.

### audio-engine.js (A)
```js
export class AudioEngine {
  constructor({ projectId, apiBase:"" })
  setProject(project)
  async load()                         // fetch+decode all audio needed (media audio wav / library files) into AudioBuffers (cache by mediaId)
  play(fromT) / pause() / seek(t)      // preview; schedules AudioBufferSourceNodes for clips overlapping [t, ∞) with exact offsets, speed (playbackRate), gain automation
  get currentTime()                    // timeline time (master clock while playing)
  get playing()
  getMeters() → { l, r, lufsShort? } peak/rms in dBFS for the master bus (AnalyserNode)
  async renderOffline({ from=0, to=duration, sampleRate=48000, stems=false }) → { mix:AudioBuffer, voice?:AudioBuffer, background?:AudioBuffer }
  static encodeWav(audioBuffer) → ArrayBuffer (16-bit PCM)
}
```
Per clip graph: source → [voiceEnhance chain: highpass 80Hz, peaking 220Hz -3dB, peaking 3.2kHz +2.5dB, highshelf 10kHz +1.5dB, compressor 3:1]
→ clip gain (volume × keyframes × fadeIn/fadeOut ramps × track volume; muted/solo respected) → panner → bus (voice / music / sfx / other by track role)
→ music & sfx buses get ducking when any clip has `audioFx.duckUnderVoice` (gain automation computed from voice clips' peaks: duckDb when voice
envelope > -35 dBFS, attack 0.08 s, release 0.4 s, precomputed curve → setValueCurveAtTime in both preview and offline)
→ master (masterGainDb) → DynamicsCompressor glue (threshold -6, ratio 1.5) → destination. Preview and offline MUST build the identical graph.

### render-page.js + render.html (A)
`render.html?job=<jobId>&project=<id>` (no dir=rtl on html; black body; canvas sized width×height). The page fetches `/api/jobs/:job` →
`{type:"export"|"snapshot", projectId, from, to, fps, times?, scale?}`; loads project, `ensureFonts`, creates Compositor(mode export) + SourceProvider(export)
+ AudioEngine. Export: for each frame n: t = from + n/fps → `await renderFrame(t)` → `readPixels()` → `POST /api/jobs/:job/frame` (body raw RGBA,
header `X-Frame: n`), wait for 200 before next (backpressure). Then `renderOffline` → `POST /api/jobs/:job/audio` (WAV), optional stems → `/stems?kind=voice|background`,
then `POST /api/jobs/:job/done`. Errors → `POST /api/jobs/:job/fail {error}`. Snapshot: render each time → PNG (canvas.toBlob) → `POST /api/jobs/:job/png?t=`.
Also usable from the editor window: export dialog in app/main.js calls `runJobInPage(jobId)` exported by render-page.js using an offscreen canvas,
so export works both headless (CLI) and in-app with a progress bar.

### server/export.mjs (A)
Routes: `POST /api/projects/:id/export { out?, from?, to?, fps?, crf?:18, preset?:"medium", lufs?:-14, headless?:true, check?:true }` → job;
`POST /api/projects/:id/snapshot { times:[…], scale?:1, sheet?:false }` → job (PNGs to project/snapshots/, + contact sheet via ffmpeg tile if sheet);
`GET /api/jobs/:job` (job state incl. progress 0..1, frames, eta, outputs, report); `POST /api/jobs/:job/{frame,audio,stems,png,done,fail}`;
`GET /api/jobs/:job/wait` (long-poll until finished, ≤ 10 min) — used by CLI.
Video: spawn ffmpeg `-f rawvideo -pix_fmt rgba -s WxH -r fps -i - -c:v libx264 -preset <p> -crf <crf> -pix_fmt yuv420p -movflags +faststart tmp_video.mp4`, write frames to stdin with backpressure.
Audio: received WAV → measure integrated loudness with `ffmpeg -af ebur128=peak=true -f null -` → single gain to reach target LUFS (clamped ±20 dB) → `alimiter=limit=0.89:level=false` → resample 48k (`-ar 48000`) → aac 256k; re-measure, correct once if off by >0.3.
Mux → `out` (default `projects/<id>/exports/<name>-<yyyyMMdd-HHmmss>.mp4`). Report: duration, size, LUFS, true peak, and if stems were sent and `check`:
speech margin (voice minus background dB in 0.1 s windows where voice RMS > 30% of its peak): min/median, count of windows below 12 dB with times.
Headless Chrome: `chrome.exe --headless=new --no-first-run --no-default-browser-check --user-data-dir=<ROOT/projects/.chrome-render> --autoplay-policy=no-user-gesture-required
--enable-gpu --ignore-gpu-blocklist --use-angle=d3d11 --enable-unsafe-swiftshader --window-size=W,H "http://127.0.0.1:7788/render/render.html?job=…"`; kill when job ends/fails/timeouts.
In-app export: `headless:false` → job waits for the editor page to drive it.

## 9. CLI (cli/cutx.mjs) — Claude's main entry point (M)

`cutx.cmd` = `@node "%~dp0cli\cutx.mjs" %*`. Auto-starts the server (detached `node server/main.mjs`) if `/api/health` fails, waits ≤ 10 s.
Output human-readable Hebrew by default, `--json` for machine output. Commands:
```
cutx help [command]
cutx projects
cutx new <id> [--name "שם"] [--size 1080x1920|9:16|16:9|1:1|4:5] [--fps 30] [--empty]
cutx show <id> [--json]                  # tracks + clips table (id, type, track, start–end, name/text), markers, duration, warnings
cutx ops <id> <file.json|-> [--summary "…"] [--atomic]
cutx import <id> <path…> [--copy]
cutx add <id> video|image|audio|text|caption|shape|sticker|effect <path|text> [--at 1.2|--at word:ביצים!] [--dur 2] [--track ID|--role sfx] [--set key=value …] [--id myId]
cutx sfx <id> "<query|soundId|path>" --at <t|word:…> [--gain -12] [--len 1.5] [--fade 0.2] [--from 0]
cutx sounds "<query>" [--category …] [--limit 20]        # search library
cutx catalog [transitions|effects|filters|anims|text-anims|captions|text-presets|stickers|fonts|luts]
cutx transcript <id> <asr.json>          # [[w,s,e]…] or [{w,s,e}]
cutx captions <id> [--asr file.json] [--style popWords] [--max 3] [--chunks 1,3,3] [--hot "מילה,מילה"] [--y 330]
cutx transcribe <id> <mediaId|path> [--captions] [--style …]
cutx set <id> <clipId> key=value …       # updateClip
cutx move|trim|split|remove|dup <id> <clipId> …
cutx key <id> <clipId> <prop> <t> <v> [--ease spring]
cutx transition <id> <clipId> <transitionId> [--dur 0.5]
cutx effect <id> <clipId> <effectId> [--param k=v]
cutx marker <id> <t|word:…> [label]
cutx undo|redo <id>
cutx snapshot <id> --at 0.5,3,6.2 [--scale 0.5] [--sheet] [--out dir]   # PNG paths printed — Claude then Reads them to SEE the edit
cutx export <id> [--out file.mp4] [--from a --to b] [--crf 18] [--lufs -14] [--no-check]
cutx check-audio <id>                    # speech margin report via a stems-only job
cutx open [<id>]                         # opens the editor window (user watches live)
```
`docs/CLAUDE-API.md`: full ops reference with JSON examples, time refs, track roles, catalog ids, recipes ("בניית סרטון מאפס", "הוספת כתוביות
מתמלול", "וושים על כל זום", "בום לפני הדרופ", "בדיקה בתמונות", "ייצוא"), and the golden workflow: edit via ops → snapshot → look → fix → export.

## 10. start.cmd / desktop shortcut (S)

`start.cmd`: starts `node server\main.mjs` (if not already running: check health with a tiny node one-liner) minimized, then
`chrome.exe --app=http://127.0.0.1:7788/ --new-window --window-size=1600,950`. Also `tools/make-shortcut.ps1` that creates
`%USERPROFILE%\Desktop\Frame Studio.lnk` pointing to start.cmd with an icon `app/icon.ico` (generate a simple .ico with Node — write a valid
ICO containing a 256x256 PNG you build in pure Node (zlib deflate) — a film-frame mark in cyan #13b6e4 on near-black #0b0e13).
Server logs to ROOT/server.log. Port 7788; if busy and not ours, exit with Hebrew message.
