# Frame Studio — Architecture

A concise map of the code. The detailed module contracts are in [`dev/SPEC.md`](dev/SPEC.md) (the original build spec); the operation reference for
Claude is [`CLAUDE-API.md`](CLAUDE-API.md).

## Principles

1. **Offline, zero dependencies.** Node 24 (built-in `fetch` / `WebSocket`), Google Chrome, ffmpeg/ffprobe. No npm
   packages, no CDN, no network at runtime. Vanilla ES modules.
2. **The edit is data.** A project is one JSON document. Every change — from the UI or from Claude — is an *operation*
   applied by a pure engine (`shared/ops.js`). Same history, same undo, same validation for both.
3. **One renderer.** The editor preview and the exporter run the same WebGL2 compositor and WebAudio graph. Export runs
   them in headless Chrome. A frame is a pure function of *(project, t)*.
4. **Shared code is isomorphic.** `shared/` and `render/` import cleanly in both Node and the browser (no DOM at module
   top level, no Node built-ins).
5. **Times are seconds (float).** Paths may contain spaces and Hebrew; child processes always get argument arrays.

## Layout

```
server/   main.mjs        HTTP server (127.0.0.1:7788), static files, routing, SSE, project store, history
          config.mjs      machine settings from config.json (Chrome, ffmpeg, ASR python, extra library folders)
          media.mjs       ffprobe, proxies / wav / peaks / thumbnails, ffmpeg queue, Range file serving
          library.mjs     sound index + search + categories, fonts list, LUTs, licenses   (mounted via routes(ctx))
          export.mjs      export / snapshot / audio-check jobs, headless Chrome workers, ffmpeg, loudness (routes(ctx))
          asr.mjs         optional local faster-whisper transcription + energy snapping of word starts
          chordix-import.mjs  optional importer for Chordix "video workshop" projects
shared/   model.js        data model, defaults, factories, time helpers, validation
          ops.js          operation engine (pure): applyOps(project, ops) → { project, results }
          anim.js         easings, springs, keyframe evaluation, clip animation presets, deterministic hash/noise
          catalog.js      one place to load every catalog (transitions, effects, filters, text, captions, stickers…)
render/   compositor.js   WebGL2 compositor (preview + export)
          transitions-gl.js / effects-gl.js   transition, effect, filter, color, LUT, mask, chroma shaders + metadata
          sources.js      video/image sources: real-time sync for preview, exact seeking for export
          text-*.js       text / caption / shape / sticker rasterizer, bidi + RTL layout, presets, animations
          audio-engine.js WebAudio engine (preview + OfflineAudioContext export), meters, ducking, WAV encoding
          render.html / render-page.js   the headless page that drives export and snapshot jobs
app/      index.html, main.js, viewer.js, timeline.js, inspector.js, library-panel.js, …   the editor UI (RTL)
cli/      cutx.mjs        the command line Claude uses (auto-starts the server)
library/  fonts/ luts/ sounds/ (user-provided, gitignored) LICENSES.md
projects/ <id>/project.json, media/, cache/{proxy,audio,peaks,thumbs}/, exports/, snapshots/   (gitignored)
tools/    install.ps1 (+ setup-common.ps1, run by install.cmd), install-transcription.ps1/.cmd, make-shortcut.ps1,
          check-setup.mjs, config-set.mjs, find-chrome.mjs, make-release.mjs, run-tests.mjs (npm test),
          shot.mjs (screenshots), make-icon.mjs, make-luts.mjs, list-publishable.mjs, asr.py, tests/ (development)
```

## Data model (summary)

```
Project  { version, id, name, rev, settings{ width, height, fps, background, sampleRate, safeArea, masterGainDb, targetLufs },
           media{ id → Media }, tracks[ Track ], clips{ id → Clip }, markers[], transcript{ words[{w,s,e}] }, meta }
Track    { id, kind: video|audio, name, role: main|overlay|text|effects|voice|music|sfx, hidden, muted, locked, solo, volume }
Clip     { id, trackId, type: video|image|audio|text|caption|shape|sticker|effect|adjustment, start, duration,
           in, speed, reverse, transform{…}, fit, crop, blend, keyframes{ prop → [{t, v, ease}] },
           animIn/animOut/animLoop, color{…}, filter, lut, effects[], mask, chroma, transitionOut,
           volume, fadeIn, fadeOut, pan, audioFx{ voiceEnhance, denoise, eqPreset, duckUnderVoice, duckDb },
           text{…}, textAnim{…}, caption{ words, style, activeColor, hotColor }, shape{…}, sticker{…} }
```

Track order is the timeline order top-to-bottom; visual tracks are composited from last to first (track 0 on top).
Effect and adjustment clips apply to the composite of everything below them.

## Operations

`applyOps(project, ops, ctx)` deep-clones, applies each op and returns per-op results (`{ok, id?, ids?, warnings?}` or
`{ok:false, error}`); a failing op does not abort the batch unless `atomic`. Times can be numbers, timecodes or
references (`word:…`, `marker:…`, `clip:…:end`) resolved against the transcript, markers and clips. The server
pre-imports any `path` fields and resolves `sfx` queries against the sound library before applying.

## Server and live sync

- `POST /api/projects/:id/ops {ops, by:"user"|"claude", summary}` → apply, `rev++`, atomic save (tmp + rename), push a
  history snapshot (300 steps, server-side undo/redo), broadcast an SSE `project` event.
- `GET /api/events?project=:id` — SSE: `project`, `media` (derivatives ready), `job` (progress) events.
- The editor applies ops optimistically with the same `shared/ops.js`, then adopts the server's project when its `rev`
  is newer. Edits by Claude show a toast and flash the changed clips.
- Media import returns immediately; proxies (H.264, short GOP for fast seeking), 48 kHz WAV, peaks and 1 fps thumbnails
  are generated in a queue (max 2 concurrent ffmpeg).
- `library.mjs` and `export.mjs` are mounted through `routes(ctx)`; a failing module is reported in `/api/health`
  instead of taking the server down.

## Rendering pipeline (per frame, WebGL2, premultiplied alpha)

1. Clear to the background. Walk visual tracks from last to first; for each active clip:
2. Source texture (video frame / image / rasterized text, caption, shape, sticker) → crop → chroma key → color → filter
   → LUT (3D texture from `.cube`) → clip effects in order → mask → animation blur/glitch.
3. Draw with the model matrix (fit, keyframed transform + animation state, anchor, flip, rotation), opacity and blend mode.
4. Transitions: around a cut, render both clips full-frame and combine with the transition shader at progress *p*.
5. Effect / adjustment clips process the composite so far.

Preview (`renderFrameSync`) never waits and uses whatever frames are ready; export (`renderFrame`) seeks every source
to the exact frame first.

## Export

`POST /api/projects/:id/export` creates a job. A headless Chrome worker opens `render/render.html?job=…`, loads the
project and fonts, renders each frame, reads back RGBA and posts it to the server, which pipes it into ffmpeg
(`rawvideo` → libx264, backpressure). The audio mix (and voice / background stems) is rendered offline through the
identical WebAudio graph, measured with `ebur128`, gained to the target (−14 LUFS default), limited (true peak ≤ −1 dBTP),
re-measured, encoded to AAC and muxed. The report includes duration, size, loudness, true peak and the speech margin
(voice minus background in 0.1 s windows; windows under 12 dB are listed). Snapshots use the same page and write PNGs
(optionally a contact sheet). The editor can also drive the same job in-page with a progress bar.

## Configuration

`server/config.mjs` merges `config.json` (gitignored; see `config.example.json`) over built-in defaults, with
environment variables taking precedence. It auto-detects Chrome per OS, uses ffmpeg/ffprobe from `PATH` unless
configured (and falls back to the usual install folders — winget, Chocolatey, Scoop, `C:/ffmpeg/bin`, Homebrew — when a
configured path is gone or `PATH` is stale), disables transcription with a bilingual hint when no Python is configured,
and still honours the legacy `library/sources.json`.

`install.cmd` → `tools/install.ps1` installs the prerequisites with winget and writes absolute paths into `config.json`
only where the current settings cannot find a program (`tools/config-set.mjs` edits single values and keeps the rest of the
file byte-for-byte). `start.cmd` runs `tools/check-setup.mjs` (the server's own view of Node / ffmpeg / Chrome) before it
starts the server.
