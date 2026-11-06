<div align="center">

# Frame Studio

### The video editor Claude can actually edit in.

A CapCut-style editor with Premiere-style pro features that runs **100% offline on your computer** —
and that **Claude Code edits for you, live, while you watch**. Then you keep editing by hand.

[Install](#install-in-3-clicks) · [עברית](#עברית) · [Claude API](docs/CLAUDE-API.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## Install in 3 clicks

**Windows 10 / 11**

1. **Download** — click the green **Code** button at the top of this page → **Download ZIP**
   (or download `frame-studio-<version>.zip` from the latest **[Release](https://github.com/YonatanProX/frame-studio/releases/latest)**).
2. **Extract** — right-click the ZIP → **Extract All…** → pick a folder you will keep (for example *Documents*).
3. **Double-click `install.cmd`** in the extracted folder.

`install.cmd` checks for **Node.js 24+**, **ffmpeg** and **Google Chrome**, asks you once (Y/N) and installs whatever is
missing, then puts a **Frame Studio** shortcut on your desktop and opens the editor. From then on just double-click
**Frame Studio** on your desktop. Running `install.cmd` again is always safe — it only repairs what is missing
(also after you move the folder).

> Windows may show *"Windows protected your PC"* for a downloaded file: click **More info → Run anyway**.
> While Node.js or Chrome install, Windows may ask for permission — click **Yes**.

### Get sounds (free)

The download contains no audio (the free sound libraries do not allow sharing their files). Get the free **Sonniss
#GameAudioGDC** bundle and drop it into `library/sounds/` — step by step in **[library/sounds/README.md](library/sounds/README.md)**.

### Use with Claude Code

1. Open the Frame Studio folder in [Claude Code](https://claude.com/claude-code) — the bundled skill teaches Claude the editor.
2. Ask for an edit: *"Open project promo-01, add karaoke captions from the voice-over and a whoosh on every zoom."*
3. Watch the timeline change live in the editor window, then keep editing by hand ([more below](#use-it-with-claude-code)).

Optional — **local transcription** (automatic captions, runs on your CPU): double-click **`tools\install-transcription.cmd`**.

---

## What it is

![Frame Studio editor](docs/images/editor.png)

Most AI video tools either generate a finished clip you can't touch, or edit through a fragile chain of mouse clicks.
Frame Studio takes a different route: **the edit itself is data**. Every change — adding a clip, a whoosh on a word, a
keyframe, a caption style — is a small JSON *operation*. Claude Code sends operations through a CLI (`cutx`) or the
local HTTP API; the editor window updates instantly, flashes what changed and shows *"Claude edited: …"*. Your own
edits in the UI go through the exact same operation engine, so you and Claude work on the same timeline, with the same
300-step undo history.

Claude can also **see** its work: `cutx snapshot` renders exact frames to PNG with the export renderer, Claude reads
them, fixes what looks off, and exports a loudness-normalized MP4 with a report.

- **Local-first.** Node server with zero npm dependencies, a Chrome app window, WebGL2 rendering, ffmpeg. No cloud, no account, no upload.
- **Social-video focus.** 9:16 1080×1920 by default (16:9, 1:1, 4:5 and custom too), safe-area guides for Reels / TikTok / Shorts.
- **Hebrew first, RTL done right** — and fine for any left-to-right language.

## Features

**Editing**
- Multi-track timeline: main / overlay / text / captions / effects tracks, voice / music / SFX audio tracks; magnetic main track, snapping, markers, in/out range, blade tool, multi-select, copy/paste, J/K/L shuttle.
- Pro operations: ripple delete, insert gap, close gaps, slip, overwrite / insert edits, split at playhead, detach audio, adjustment and effect layers that apply to everything below them.
- **48 operation types** in the engine — everything the UI does, Claude can do (`cutx help ops`).
- Speed and reverse, crop, fit modes, blend modes (multiply, screen, overlay, add, soft light, difference…).
- **Keyframes** on position, scale, rotation, opacity, volume, crop, every color control and every effect parameter, with **35 easing curves** (spring, bounce, back, elastic, expo, sine…).
- **Clip animations**: 20 in, 16 out, 15 loop (pop, whip, glitch, Ken Burns, breathe, heartbeat…).

**Look**
- **54 transitions** (crossfade, push, cover, wipes, whip pans, zoom blur, cross zoom, ink spread, glitch, film burn, cube, doorway, page flip…).
- **51 effects** (zoom punch, shake, shockwave, light leak, bloom, VHS, CRT, film grain, RGB split, kaleidoscope, thermal, halftone, drop shadow…).
- **27 filters**, full color panel (exposure, contrast, temperature, tint, highlights, shadows, vibrance, vignette, grain, fade…) and **.cube LUTs** (8 built-in, drop in your own).
- **Chroma key** (color, similarity, smoothness, spill), **masks** (rectangle, ellipse, linear, mirror; feather, invert).

**Text & captions**
- **Captions with word timing** — **14 caption styles** (karaoke, word pop, kinetic, pill, box highlight, typewriter, neon…), hot words in a second color, per-word animation. Proper **Hebrew RTL** layout with mixed Latin/numbers, niqqud-aware word matching.
- **38 text presets** and per-word / per-character **text animations** (33 in, 19 out, 17 loop: typewriter, word pop, char drop, karaoke fill, wave, shimmer…).
- **98 stickers** (65 emoji + 33 vector stickers drawn in code) and **23 shapes** (arrows, bursts, progress bars…).
- Fonts: Heebo and Assistant bundled (SIL OFL), plus your Windows fonts.
- Optional **local Whisper transcription** (faster-whisper, CPU) → word timestamps → captions in one command.

**Audio**
- WebAudio engine with per-clip volume / pan / fades, **voice enhance**, denoise, EQ presets, **automatic ducking** of music and SFX under the voice, master meters.
- Sound-effects library browser with search, categories, waveforms and audition — indexes whatever you put in `library/sounds` (see [Sounds](#sounds--licensing)).
- **Export at −14 LUFS** (true peak ≤ −1 dBTP) with a **speech-over-background check**: voice vs. music + SFX margin measured in 0.1 s windows, reported with timestamps.

**Made for an AI collaborator**
- `cutx` CLI + HTTP API, JSON ops with time references like `word:"boom!"`, `marker:drop`, `clip:logo:end`.
- **Snapshots** so Claude can *see* frames (`cutx snapshot … --sheet` for a contact sheet).
- Live sync over SSE: the editor shows each Claude edit with a toast and a flash on the changed clips.

| | |
|---|---|
| ![Project manager](docs/images/manager.png) | ![Audio](docs/images/tab-audio.png) |
| ![Effects](docs/images/tab-effects.png) | ![Transitions](docs/images/tab-transitions.png) |
| ![Captions](docs/images/tab-captions.png) | ![Text styles](docs/images/tab-text.png) |

## Requirements

On Windows, **`install.cmd` installs all of these for you** (with winget).

| | |
|---|---|
| OS | **Windows 10 / 11** (tested). macOS / Linux: the code auto-detects Chrome and ffmpeg there too, but it is untested — reports and PRs welcome. |
| Node.js | **24+** (built-in `fetch` / `WebSocket`; there is **no `npm install`**) |
| Browser | **Google Chrome** (the editor window, and headless rendering for snapshots and export; Edge can show the editor but cannot export) |
| ffmpeg | `ffmpeg` and `ffprobe` (a full build with libx264 — e.g. the gyan.dev "full" build on Windows, winget `Gyan.FFmpeg`) |
| Optional | Python 3.10–3.13 with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) for local transcription (`tools\install-transcription.cmd` sets it up) |

## Manual install (developers, macOS / Linux)

```bash
git clone https://github.com/YonatanProX/frame-studio.git
cd frame-studio
node tools/check-setup.mjs    # what is found / missing (Node 24+, ffmpeg, ffprobe, Chrome, transcription)
node server/main.mjs          # or: npm start — then open http://127.0.0.1:7788
```

On Windows, `install.cmd` (or `npm run install-app`) does the setup; `start.cmd` is the daily launcher that the desktop
shortcut runs — it starts the local server (minimized) and opens the editor in a Chrome app window. Installer options:
`install.cmd -DryRun` (only show what it would do), `-Yes` (no question), `-NoStart`, `-NoShortcut`.

The server listens on `127.0.0.1:7788` only. Logs go to `server.log`. Projects are saved in `projects/<id>/`
(auto-saved after every change; exports in `projects/<id>/exports/`).

### Configuration (optional)

Everything machine-specific lives in **`config.json`** (gitignored; `install.cmd` creates it). All keys are documented in
[`config.example.json`](config.example.json); set only what you need:

```json
{
  "chrome": null,
  "ffmpeg": "ffmpeg",
  "asr": { "python": "C:/Users/you/.frame-studio/asr/Scripts/python.exe", "model": "small", "language": "he" },
  "library": { "music": ["D:/My music"] }
}
```

- `chrome` — `null` auto-detects Chrome / Chromium per OS.
- `ffmpeg` / `ffprobe` — a name on `PATH` or a full path. If neither works, the server also looks in the usual install folders (winget, Chocolatey, Scoop, `C:\ffmpeg\bin`, Homebrew).
- `asr.python` — a Python with `faster-whisper`. Without it, transcription is simply disabled and the editor tells you how to enable it.
- `library.music` — your own music / voice-over folders, shown in the Audio tab as "mine".
- Environment variables still win: `FRAME_STUDIO_CHROME`, `FRAME_STUDIO_FFMPEG`, `FRAME_STUDIO_FFPROBE`, `FRAME_STUDIO_ASR_PYTHON`, `FRAME_STUDIO_PORT`, `FRAME_STUDIO_CONFIG`.

### Local transcription (optional)

Windows: double-click **`tools\install-transcription.cmd`**. It finds or installs Python 3.12, creates a private
environment in `%USERPROFILE%\.frame-studio\asr`, installs `faster-whisper`, downloads the speech model once
(`asr.model`, `small` ≈ 500 MB) and writes `asr.python` into `config.json`. Elsewhere: `pip install faster-whisper` in a
virtual environment and set `asr.python` to its Python.

## Use it with Claude Code

1. Open this folder in [Claude Code](https://claude.com/claude-code).
2. The bundled project skill **[`.claude/skills/frame-studio`](.claude/skills/frame-studio/SKILL.md)** teaches Claude the
   workflow; the full reference is **[`docs/CLAUDE-API.md`](docs/CLAUDE-API.md)** (ops, time references, catalogs, recipes).
3. Ask for an edit and watch it happen:

   > *"Open project `promo-01`, put `intro.mp4` on the main track, add karaoke captions from the voice-over,
   > a whoosh on every zoom and a boom right before the drop. Snapshot the hook and show me."*

Claude's golden loop:

```
cutx show <id>                        1. read the current state (you may have edited by hand!)
cutx ops <id> edit.json --summary "…" 2. edit with operations
cutx snapshot <id> --at 0.5,3,word:… 3. render frames …
(Read the PNGs)                       4. … and look at them
(fix → back to 2)                     5. iterate
cutx export <id>                      6. MP4 at −14 LUFS + speech-margin report
```

An operation batch looks like this:

```json
{ "summary": "Hook: 'Wait!' title with a hit and a zoom",
  "ops": [
    { "op": "addClip", "type": "text", "id": "hook", "content": "Wait!", "at": { "word": "Wait!" }, "duration": 0.9,
      "y": -480, "animIn": "pop", "set": { "text.size": 180, "text.weight": 900 } },
    { "op": "sfx", "sound": "boom", "at": { "word": "Wait!", "offset": -0.05 }, "gain_db": -8 },
    { "op": "setKeyframes", "id": "hook", "prop": "transform.scale",
      "keys": [ { "t": 0, "v": 1.3 }, { "t": 0.15, "v": 1, "ease": "back" } ] }
  ] }
```

## CLI quick reference

`cutx.cmd` (cmd / PowerShell) and `./cutx` (Git Bash, macOS, Linux) are in the repo root. The CLI starts the server if
it is not running. Add `--json` to any command for machine-readable output. Full list: `cutx help`.

| Command | What it does |
|---|---|
| `cutx projects` · `cutx new <id> --size 9:16 --fps 30` | list / create projects |
| `cutx open <id>` | open the editor window on a project (watch live) |
| `cutx show <id> [--json]` | tracks, clips, markers, warnings |
| `cutx import <id> <path…>` | import media (proxies, waveforms, thumbnails are built in the background) |
| `cutx add <id> video\|image\|audio\|text\|sticker\|shape\|effect … --at <t\|word:…>` | add one clip |
| `cutx ops <id> <file.json\|->` | apply a batch of operations |
| `cutx sfx <id> "whoosh" --at word:zoom` · `cutx sounds "riser"` | sound effects from the library |
| `cutx transcribe <id> <mediaId> --captions --style karaoke` | local Whisper → transcript → captions |
| `cutx captions <id> --asr words.json --style kinetic --max 3` | captions from existing word timings |
| `cutx key <id> <clip> transform.scale 0 1.2 --ease spring` | keyframes |
| `cutx transition <id> <clip> whipLeft --dur 0.4` · `cutx effect <id> <clip> zoomPunch` | transitions, effects |
| `cutx catalog transitions\|effects\|filters\|captions\|text-presets\|stickers\|fonts\|luts` | catalogs by id |
| `cutx snapshot <id> --at 0.5,3,6.2 [--sheet]` | render frames to PNG |
| `cutx export <id> [--lufs -14] [--out f.mp4]` · `cutx check-audio <id>` | export + loudness / speech report |
| `cutx undo <id>` · `cutx redo <id>` | server-side history (300 steps) |

## Architecture

```
   you (mouse, keyboard)                                   Claude Code
           |                                                    |  cutx ... / HTTP JSON
           v                                                    v
+--------------------- Chrome app window ---------------+   +--------- cli/cutx.mjs ----------+
| app/   editor UI (RTL): timeline, inspector, library  |   | ops, snapshot, export, sounds,  |
|        viewer -> render/compositor.js (WebGL2)        |   | transcribe, catalog ...         |
|                  render/audio-engine.js (WebAudio)    |   +----------------+----------------+
|        shared/ops.js applied optimistically           |                    |
+---------------+---------------------^-----------------+                    |
                | POST ops            | SSE (project / media / job events)   |
                v                     |                                      v
+------------------------ server/main.mjs  (Node 24, 127.0.0.1:7788, zero deps) ------------------+
|  project store, atomic saves, 300-step history  |  media.mjs   ffprobe, proxies, peaks, thumbs  |
|  shared/ops.js  (pure operation engine)         |  library.mjs sounds index, fonts, LUTs        |
|  config.mjs     (config.json)                   |  asr.mjs     faster-whisper (optional)        |
|                                                 |  export.mjs  jobs, headless Chrome, ffmpeg    |
+--------------------------------------------------+-----------------------+-----------------------+
                                                                          | spawns
                                                                          v
                          headless Chrome: render/render.html + render-page.js
                          (the SAME compositor.js + audio-engine.js as the editor)
                              | RGBA frames            | WAV mix + voice/background stems
                              v                        v
                          ffmpeg (libx264) <---- ebur128 loudness -> gain -> limiter -> AAC ----> MP4 + report
```

Folder map: `server/` Node HTTP server and jobs · `shared/` data model, operation engine, easing/keyframes (runs in
both Node and the browser) · `render/` WebGL2 compositor, transitions, effects, text/caption rasterizer, audio engine,
headless render page · `app/` the editor UI · `cli/` `cutx` · `library/` fonts, LUTs, your sounds · `tools/` installer,
shortcut, setup check, release builder, icon / LUT generators, screenshots, development tests · `docs/` Claude API,
architecture (`docs/dev/` = the original module spec). More in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Why the preview matches the export

There is **one renderer**. The editor's preview and the exporter both run `render/compositor.js` (WebGL2) and
`render/audio-engine.js` (WebAudio); export simply runs them in a **headless Chrome** page instead of the editor window.

- A frame is a pure function of *(project, time)*: no timers, no `Math.random` at render time (seeded hashes instead).
- Export seeks every video source to the exact frame and waits for it (`requestVideoFrameCallback`) before drawing; the
  preview takes whatever frame is ready, so it stays real-time.
- Frames are read back as RGBA and streamed to ffmpeg with backpressure; audio is rendered with an
  `OfflineAudioContext` through the identical node graph (ducking, voice enhance, fades) used for playback.
- The mix is measured with ffmpeg `ebur128`, gained to the target (−14 LUFS by default), limited to −1 dBTP and
  re-measured; voice and background stems give the speech-margin report.
- Snapshots use the same path, so what Claude "sees" is what you will export.

## Sounds & licensing

**This repository ships no audio.** The recommended free libraries let you use their sounds in your videos but do not
allow redistributing the files, so you download them yourself into `library/sounds/` — see
**[`library/sounds/README.md`](library/sounds/README.md)**:

- **Sonniss #GameAudioGDC bundles** — free, royalty-free, commercial use, no attribution. Get them at
  [sonniss.com/gameaudiogdc](https://sonniss.com/gameaudiogdc) and drop the folders in.
- **Mixkit** sound effects (optional).
- Your own music / voice folders via `config.json` → `library.music`.

The editor indexes whatever audio is in that folder (with UCS category detection, waveforms and search).
Details for every asset type: [`library/LICENSES.md`](library/LICENSES.md). Bundled fonts: Heebo and Assistant under the
SIL Open Font License 1.1 ([`library/fonts/FONTS.md`](library/fonts/FONTS.md)).

## Troubleshooting

- **Something is missing / the editor does not open** — double-click `install.cmd` again; it repairs paths and the
  shortcut. `node tools/check-setup.mjs` (or `npm run check`) shows what the server finds. The installer writes `install.log`.
- **"Port 7788 is used by another program"** — another app holds the port; close it (or run the server with `--port`).
- **The server did not start** — see `server.log` in the Frame Studio folder.
- **Export fails, the editor works** — exports need Google Chrome (Edge only shows the editor window).

## Development

- `npm test` runs the self-contained tests (`tools/run-tests.mjs`: operation engine, CLI with a mock server, docs
  examples, alignment, balance). **`tools/tests/` is for development only** — most other scripts there need a running
  server, Chrome, ffmpeg or local media; see [CONTRIBUTING.md](CONTRIBUTING.md).
- `npm run release` builds `dist/frame-studio-<version>.zip` for a GitHub Release from the files git would publish, and
  refuses to include audio, video, `config.json` or project content. `node tools/list-publishable.mjs` lists them too.
- The original module-by-module spec is in [`docs/dev/SPEC.md`](docs/dev/SPEC.md).

## Roadmap

- Tested macOS / Linux launchers (`start.sh`) and CI on all three OSes
- English UI strings (the UI is Hebrew today; the code and docs are English-friendly)
- Hardware video encoding (NVENC / Quick Sync / VideoToolbox) and faster long exports
- An MCP server wrapping `cutx`, so any MCP client can edit
- More caption languages and word-alignment for transcription
- Custom shader plug-ins (drop-in transitions / effects)
- Templates: reusable timelines with placeholders

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The ground rules in short: no runtime
npm dependencies, no network access at runtime, `shared/` and `render/` must stay importable by both Node and the
browser, and never commit audio, projects or `config.json`.

## License

[MIT](LICENSE) © 2026 Frame Studio contributors. Bundled fonts: SIL OFL 1.1. Sound libraries are not included and keep
their own licenses.

---

<div dir="rtl">

## עברית

### התקנה בשלוש לחיצות

**Windows 10 / 11**

1. **הורדה** — לוחצים על הכפתור הירוק **Code** בראש הדף ← **Download ZIP**
   (או מורידים את `frame-studio-<version>.zip` מה-**[Release](https://github.com/YonatanProX/frame-studio/releases/latest)** האחרון).
2. **חילוץ** — לחיצה ימנית על קובץ ה-ZIP ← **חלץ הכל…** ← בוחרים תיקייה קבועה (למשל "מסמכים").
3. **לחיצה כפולה על `install.cmd`** בתיקייה שחולצה.

`install.cmd` בודק אם יש במחשב **Node.js 24 ומעלה**, **ffmpeg** ו-**Google Chrome**, שואל פעם אחת (Y/N) ומתקין את מה שחסר,
יוצר בשולחן העבודה קיצור דרך **Frame Studio** ופותח את העורך. מעכשיו פשוט לוחצים פעמיים על **Frame Studio** בשולחן העבודה.
מותר להפעיל את `install.cmd` שוב בכל פעם — הוא רק מתקן את מה שחסר (גם אחרי שמעבירים את התיקייה).

> אם Windows מציג "Windows הגן על המחשב שלך" — לוחצים **מידע נוסף ← הפעל בכל זאת**.
> בזמן ההתקנה של Node.js או Chrome ייתכן ש-Windows יבקש אישור — לוחצים **כן**.

### צלילים (בחינם)

ההורדה לא כוללת קובצי שמע (ספריות הצלילים החינמיות לא מתירות להפיץ את הקבצים). מורידים את החבילה החינמית של
**Sonniss ‏#GameAudioGDC** ומכניסים אותה ל-`library/sounds/` — הוראות צעד אחר צעד ב-**[library/sounds/README.md](library/sounds/README.md)**.

### עבודה עם Claude Code

1. פותחים את תיקיית Frame Studio ב-[Claude Code](https://claude.com/claude-code) — הסקיל המצורף מלמד את קלוד את העורך.
2. מבקשים עריכה: *"פתח את הפרויקט promo-01, תוסיף כתוביות קריוקי מהקריינות ווש על כל זום."*
3. צופים בציר הזמן משתנה בזמן אמת בחלון העורך, וממשיכים לערוך ביד ([פרטים למטה](#עבודה-עם-claude-code-בהרחבה)).

רשות — **תמלול מקומי** (כתוביות אוטומטיות, רץ על המעבד): לחיצה כפולה על **`tools\install-transcription.cmd`**.

---

### מה זה

![העורך](docs/images/editor.png)

עורך בסגנון CapCut, עם כלים מקצועיים בסגנון Premiere, שרץ **כולו על המחשב שלכם בלי אינטרנט** —
ו**Claude Code עורך בו בשבילכם, בזמן אמת, כשאתם צופים**. אחר כך ממשיכים לערוך ביד.

רוב כלי הווידאו עם בינה מלאכותית מייצרים קליפ מוכן שאי אפשר לגעת בו, או "עורכים" דרך שרשרת שבירה של לחיצות עכבר.
ב-Frame Studio **העריכה עצמה היא נתונים**: כל שינוי — הוספת קליפ, ווש על מילה, קיפריים, סגנון כתוביות — הוא *פעולה* קטנה
ב-JSON. קלוד שולח פעולות דרך שורת הפקודה (`cutx`) או ה-API המקומי, חלון העורך מתעדכן מיד, מהבהב על מה שהשתנה
ומציג "קלוד ערך: …". גם העריכות שלכם בממשק עוברות באותו מנוע פעולות — אתם וקלוד עובדים על אותו ציר זמן, עם אותה
היסטוריית ביטול של 300 צעדים.

קלוד גם **רואה** את מה שעשה: `cutx snapshot` מצייר פריימים מדויקים ל-PNG עם מנוע הייצוא, קלוד קורא אותם, מתקן מה שלא
נראה טוב, ומייצא MP4 בעוצמה מנורמלת עם דוח.

- **הכול מקומי.** שרת Node בלי שום חבילת npm, חלון אפליקציה של Chrome, רינדור WebGL2, ffmpeg. בלי ענן, בלי חשבון, בלי העלאות.
- **מיועד לרשתות.** ברירת מחדל 9:16 ‏1080×1920 (גם 16:9, 1:1, 4:5 וגודל חופשי), קווי אזור בטוח לרילס / טיקטוק / שורטס.
- **עברית קודם, ו-RTL כמו שצריך** — ועובד מצוין גם בשפות משמאל לימין.

### יכולות

**עריכה**
- ציר זמן רב-ערוצי: ראשי / שכבה / טקסט / כתוביות / אפקטים, וערוצי קריינות / מוזיקה / אפקטים קוליים; ערוץ ראשי מגנטי, הצמדה, סמנים, טווח כניסה/יציאה, להב, בחירה מרובה, העתק/הדבק, ניווט J/K/L.
- פעולות מקצועיות: מחיקה מתגלגלת, הוספת רווח, סגירת רווחים, slip, עריכת overwrite / insert, פיצול בסמן, ניתוק שמע, שכבות התאמה ואפקט שחלות על כל מה שמתחתן.
- **48 סוגי פעולות** במנוע — כל מה שהממשק עושה, קלוד יכול לעשות (`cutx help ops`).
- מהירות והיפוך, חיתוך, מצבי התאמה, מצבי מיזוג.
- **קיפריימים** על מיקום, גודל, סיבוב, שקיפות, עוצמה, חיתוך, כל בקרי הצבע וכל פרמטר של אפקט, עם **35 עקומות האצה** (קפיץ, קפיצה, back, אלסטי…).
- **אנימציות לקליפים**: 20 כניסות, 16 יציאות, 15 לולאות.

**מראה**
- **54 מעברים**, **51 אפקטים**, **27 פילטרים**, פאנל צבע מלא ו-**LUT** בפורמט ‎.cube (8 מובנים, ואפשר להוסיף משלכם).
- **מפתח כרום** ו**מסכות** (מלבן, אליפסה, לינארית, מראה; ריכוך והיפוך).

**טקסט וכתוביות**
- **כתוביות לפי זמני מילים** — **14 סגנונות** (קריוקי, מילה קופצת, קינטי, גלולה, הדגשה בתיבה, מכונת כתיבה, ניאון…), מילים חמות בצבע נוסף, אנימציה לכל מילה. פריסת **עברית RTL** נכונה עם לטינית ומספרים בתוך הטקסט, והתאמת מילים שמתעלמת מניקוד.
- **38 סגנונות טקסט** ו**אנימציות טקסט** לכל מילה / לכל אות (33 כניסות, 19 יציאות, 17 לולאות).
- **98 מדבקות** (65 אימוג'י + 33 מדבקות וקטוריות) ו-**23 צורות**.
- גופנים: Heebo ו-Assistant מצורפים (SIL OFL), ועוד גופני Windows שלכם.
- **תמלול מקומי עם Whisper** (רשות; faster-whisper על המעבד) ← זמני מילים ← כתוביות בפקודה אחת.

![סגנונות טקסט](docs/images/tab-text.png)

**שמע**
- מנוע WebAudio עם עוצמה / פאן / דעיכות לכל קליפ, **שיפור קול**, הפחתת רעש, פריסטים של EQ, **הנמכה אוטומטית** של מוזיקה ואפקטים מתחת לדיבור, מדי עוצמה.
- דפדפן ספריית אפקטים קוליים עם חיפוש, קטגוריות, צורות גל והאזנה — מאנדקס כל מה שתשימו ב-`library/sounds`.
- **ייצוא ב-‎−14 LUFS** (שיא אמיתי ≤ ‎−1 dBTP) עם **בדיקת "הדיבור מעל הרקע"**: מרווח הקול מול מוזיקה ואפקטים בחלונות של 0.1 שנ', עם זמנים בדוח.

![שמע](docs/images/tab-audio.png)

**בנוי לעבודה עם קלוד**
- `cutx` ו-API ב-HTTP, פעולות JSON עם הפניות זמן כמו `word:"ובום!"`, `marker:דרופ`, `clip:logo:end`.
- **צילומי פריימים** כדי שקלוד *יראה* (`cutx snapshot … --sheet` לגיליון מקבץ).
- סנכרון חי: העורך מציג כל עריכה של קלוד בהודעה ובהבהוב על הקליפים שהשתנו.

### דרישות

ב-Windows ‏**`install.cmd` מתקין את כל אלה בשבילכם** (עם winget).

- **Windows 10 / 11** (נבדק). ב-macOS / Linux הקוד מזהה את Chrome ו-ffmpeg, אבל זה עדיין לא נבדק.
- **Node.js 24 ומעלה** — אין `npm install`.
- **Google Chrome** — לחלון העורך ולרינדור ברקע (ב-Edge אפשר לראות את העורך, אבל לא לייצא).
- **ffmpeg ו-ffprobe** (גרסה מלאה עם libx264, למשל `Gyan.FFmpeg`).
- רשות: Python 3.10–3.13 עם `faster-whisper` לתמלול מקומי (`tools\install-transcription.cmd` מתקין הכול).

### התקנה ידנית (למפתחים, macOS / Linux)

```bash
git clone https://github.com/YonatanProX/frame-studio.git
cd frame-studio
node tools/check-setup.mjs    # מה נמצא ומה חסר
node server/main.mjs          # או npm start, ואז לפתוח http://127.0.0.1:7788
```

- ב-Windows ‏`install.cmd` (או `npm run install-app`) מבצע את ההתקנה; `start.cmd` הוא המשגר היומי שקיצור הדרך מפעיל — מפעיל את
  השרת (ממוזער) ופותח את העורך בחלון Chrome. אפשרויות להתקנה: `install.cmd -DryRun` (רק להראות מה ייעשה), `-Yes`, `-NoStart`, `-NoShortcut`.
- הפרויקטים נשמרים ב-`projects/<מזהה>/` (שמירה אוטומטית אחרי כל שינוי; סרטונים מוכנים ב-`exports/`). יומן: `server.log`.

**הגדרות (רשות):** כל מה שתלוי במחשב נמצא ב-**`config.json`** (לא נכנס ל-git; `install.cmd` יוצר אותו). כל המפתחות מתועדים ב-`config.example.json`:
`chrome` (‏`null` = זיהוי אוטומטי), `ffmpeg` / `ffprobe` (שם ב-PATH או נתיב מלא; אם לא נמצא, השרת מחפש גם בתיקיות ההתקנה הרגילות),
`asr.python` (פייתון עם faster-whisper — בלעדיו התמלול פשוט כבוי, והעורך מסביר איך להפעיל), `library.music` (תיקיות מוזיקה וקריינות שלכם).
משתני סביבה (`FRAME_STUDIO_CHROME` וכו') גוברים על הקובץ.

**תמלול מקומי (רשות):** לחיצה כפולה על `tools\install-transcription.cmd` — מוצא או מתקין Python 3.12, יוצר סביבה פרטית
ב-`%USERPROFILE%\.frame-studio\asr`, מתקין את `faster-whisper`, מוריד פעם אחת את מודל הדיבור (`small` ≈ ‏500MB) וכותב את `asr.python` ל-`config.json`.

### עבודה עם Claude Code בהרחבה

1. פותחים את התיקייה ב-Claude Code.
2. הסקיל המצורף **[`.claude/skills/frame-studio`](.claude/skills/frame-studio/SKILL.md)** מלמד את קלוד את שיטת העבודה; המדריך המלא: **[`docs/CLAUDE-API.md`](docs/CLAUDE-API.md)**.
3. מבקשים עריכה וצופים בה קורית, למשל: *"פתח את הפרויקט promo-01, שים את intro.mp4 בערוץ הראשי, כתוביות קריוקי מהקריינות, ווש על כל זום ובום לפני הדרופ. צלם לי את ההוק."*

לולאת הזהב של קלוד: `cutx show` (קורא את המצב — אולי ערכתם ביד) ← `cutx ops` (עורך) ← `cutx snapshot` ← קורא את התמונות ← מתקן ← `cutx export`.

### שורת הפקודה בקצרה

`cutx.cmd` (‏cmd / PowerShell) ו-`./cutx` (‏Git Bash) נמצאים בשורש. השרת עולה לבד אם הוא לא פעיל. `--json` = פלט למכונה. הכול: `cutx help`.

| פקודה | מה עושה |
|---|---|
| `cutx projects` · `cutx new <id> --size 9:16` | רשימה / פרויקט חדש |
| `cutx open <id>` | פתיחת העורך על פרויקט (צפייה בזמן אמת) |
| `cutx show <id>` | ערוצים, קליפים, סמנים, אזהרות |
| `cutx import <id> <נתיב…>` · `cutx add <id> <סוג> … --at <זמן\|word:…>` | ייבוא / הוספת קליפ |
| `cutx ops <id> <file.json>` | שליחת רצף פעולות |
| `cutx sfx <id> "ווש" --at word:זום` · `cutx sounds "עולה"` | אפקטים קוליים מהספרייה |
| `cutx transcribe <id> <mediaId> --captions` | תמלול מקומי וכתוביות |
| `cutx key` · `cutx transition` · `cutx effect` | קיפריימים, מעברים, אפקטים |
| `cutx snapshot <id> --at 0.5,3 [--sheet]` | תמונות מהסרטון |
| `cutx export <id>` · `cutx check-audio <id>` | ייצוא ודוח עוצמה / דיבור |
| `cutx undo <id>` · `cutx redo <id>` | ביטול / ביצוע מחדש (300 צעדים) |

### ארכיטקטורה, ולמה התצוגה זהה לייצוא

שרת Node מקומי (`server/`) מחזיק את הפרויקטים, מריץ את מנוע הפעולות (`shared/ops.js`), מכין מדיה עם ffmpeg ומשדר
שינויים לעורך ב-SSE. העורך (`app/`) והייצוא משתמשים **באותו מנוע רינדור**: `render/compositor.js` (‏WebGL2)
ו-`render/audio-engine.js` (‏WebAudio). בייצוא אותו קוד רץ בדף Chrome נסתר: כל פריים הוא פונקציה טהורה של (פרויקט, זמן),
כל מקור וידאו מחכה לפריים המדויק, הפיקסלים נשלחים ל-ffmpeg, השמע מרונדר באותו גרף צמתים, נמדד ב-ebur128 ומנורמל
ל-‎−14 LUFS. גם צילומי הפריימים עוברים באותה דרך — מה שקלוד רואה הוא מה שייצא. התרשים המלא למעלה ובקובץ
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### צלילים ורישיונות

**המאגר לא כולל קובצי שמע.** הספריות החינמיות המומלצות מתירות שימוש בצלילים בסרטונים שלכם אבל לא הפצה של הקבצים,
לכן מורידים אותן בעצמכם ל-`library/sounds/` (הוראות ב-[`library/sounds/README.md`](library/sounds/README.md)):
חבילות **Sonniss ‏#GameAudioGDC** (חינם, ללא תמלוגים, מסחרי, בלי קרדיט — [sonniss.com/gameaudiogdc](https://sonniss.com/gameaudiogdc)),
ואם רוצים גם **Mixkit**. העורך מאנדקס כל קובץ שמע שבתיקייה. כל הפרטים ב-[`library/LICENSES.md`](library/LICENSES.md).

### פתרון בעיות

- **משהו חסר / העורך לא נפתח** — מפעילים שוב את `install.cmd`; הוא מתקן נתיבים ואת קיצור הדרך. `node tools/check-setup.mjs` (או `npm run check`) מראה מה השרת מוצא. ההתקנה כותבת יומן ל-`install.log`.
- **"הפורט 7788 תפוס"** — תוכנה אחרת משתמשת בפורט; סוגרים אותה (או מפעילים את השרת עם `--port`).
- **השרת לא עלה** — הפרטים ב-`server.log` בתיקיית התוכנה.
- **הייצוא נכשל אבל העורך עובד** — לייצוא צריך Google Chrome (ב-Edge אפשר רק לראות את העורך).

### פיתוח

`npm test` מריץ את הבדיקות העצמאיות (`tools/run-tests.mjs`). **התיקייה `tools/tests/` מיועדת לפיתוח בלבד** — רוב הסקריפטים
האחרים בה צריכים שרת פעיל, Chrome, ffmpeg או מדיה מקומית. `npm run release` בונה את `dist/frame-studio-<version>.zip` ל-Release
ב-GitHub (ומסרב לכלול שמע, וידאו, `config.json` או פרויקטים). המפרט המקורי של המודולים: [`docs/dev/SPEC.md`](docs/dev/SPEC.md).

### תוכנית להמשך

משגרים נבדקים ל-macOS / Linux · ממשק באנגלית · קידוד וידאו בחומרה · שרת MCP סביב `cutx` · עוד שפות לתמלול ·
תוספים של שיידרים (מעברים / אפקטים) · תבניות.

### תרומה ורישיון

תרומות יתקבלו בשמחה — ראו [CONTRIBUTING.md](CONTRIBUTING.md). הקוד ברישיון [MIT](LICENSE); הגופנים המצורפים ב-SIL OFL 1.1;
ספריות הצלילים לא כלולות ושומרות על הרישיונות שלהן.

</div>
