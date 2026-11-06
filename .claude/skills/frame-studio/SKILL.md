---
name: frame-studio
description: Edit videos in Frame Studio — the local CapCut-style editor that Claude drives with code (the `cutx` CLI / HTTP ops) while the user watches the timeline update live and keeps editing by hand. Use whenever the user asks to edit, cut, assemble, caption, add sound effects/music/voice-over/transitions/effects to, check, or export a video in Frame Studio, or says "open it in the editor", "put it on the timeline", "ערוך", "תערוך את הסרטון", "תכניס לעורך", "טיימליין", "כתוביות", "אפקטים קוליים", "מעברים", "ייצוא".
---

# Frame Studio — editing with code

Frame Studio runs a local server on `http://127.0.0.1:7788` and an editor window (Chrome `--app`). Every edit you make is a
JSON **op** applied by the server; the editor updates live and shows the user a toast with your `--summary`. The user can
undo your edits or keep editing by hand — so always re-read the state before a new round.

**Full reference:** `docs/CLAUDE-API.md` in the Frame Studio folder (ops, fields, time references, catalog ids, recipes).
Read the relevant section before using an op you haven't used in this conversation.

## Where it is and how to call it

- Root = the folder that contains `cutx`, `cutx.cmd`, `server/`, `docs/` (find it if unsure: it is the folder with this
  skill's `.claude/` directory, or ask the user).
- Git Bash / macOS / Linux: `./cutx <command>` from the root (or `node <root>/cli/cutx.mjs <command>`).
  cmd / PowerShell: `cutx.cmd <command>`. Do **not** call `cutx.cmd` from Git Bash (quoting breaks).
- The server auto-starts on the first command. `cutx open <id>` opens the editor window so the user can watch.
- `--json` on any command gives machine output. Exit code 0 = ok, 2 = some ops failed / target missed, 1 = error.

## The golden loop (always)

1. `cutx show <id>` — current tracks/clips/ids (the user may have changed things).
2. `cutx ops <id> edit.json --summary "<short description in the user's language>"` — one batch per logical step.
   Use client ids (`"id":"s1"`) so later ops in the batch can reference new clips. Prefer `--atomic` for builds.
3. `cutx snapshot <id> --at <times> --scale 0.5 --sheet` — then **Read the PNG(s)** and actually look:
   cut-off or overlapping text, wrong RTL order, black frames, captions over important content, safe-area violations.
4. Fix and repeat. Then `cutx export <id>` (‑14 LUFS, true peak ≤ ‑1 dBTP, speech-over-background check ≥ 12 dB).
   If the speech margin fails, run `cutx balance <id>` (automatic local dips on the guilty music/sfx clips) and export again.

## Essentials

- Times: seconds, or word refs from the transcript: `"word:ובום!"`, `"word:קצב!:0:-0.1"` (word, occurrence, offset),
  `"marker:דרופ"`, `"clip:s2:end"`, `"end"`. Load word timings first: `cutx transcript <id> asr.json [--script "…"]`
  (the `--script` option replaces Whisper's misspellings with the real script words) or `cutx transcribe <id> <media>`.
- Tracks are listed top-to-bottom; the top track is drawn on top. Roles: effects, text (captions = text track with
  `captions:true`), overlay, main, voice, music, sfx. `addClip` picks a track by type/role and creates a new one on overlap.
- Coordinates: `transform.x/y` are pixel offsets of the clip centre from the canvas centre (y down). Absolute from top:
  `yAbs` / `xAbs` shorthands.
- Sound effects come **only from the library** (`cutx sounds "<query>"`, then `sfx` op with `gain_db`, `len`, `fade`).
  Never synthesize whooshes/booms.
- Catalog ids (transitions, effects, filters, animations, caption styles, text presets, stickers, fonts, LUTs):
  `cutx catalog <kind>` — never guess an id.
- Transitions need adjacent clips on the same track (end of A = start of B); `closeGaps` snaps them.
- Effect clips (`type:"effect"`, e.g. `zoomPunch`, `flash`, `shake`, `glitch`) apply to everything below them for their duration.
- Mistake? `cutx undo <id>` (the user sees it too).

## Reporting to the user

Tell the user what changed in plain words, which snapshot frames you checked, and the export report numbers
(duration, LUFS, speech margin). Send the exported file or a contact sheet when useful.
