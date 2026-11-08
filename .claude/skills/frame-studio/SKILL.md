---
name: frame-studio
description: Edit videos in Frame Studio — the local CapCut-style editor that Claude drives with code (the Frame Studio MCP tools, or the `cutx` CLI / HTTP ops) while the user watches the timeline update live and keeps editing by hand. Use whenever the user asks to edit, cut, assemble, caption, add sound effects/music/voice-over/transitions/effects to, check, or export a video in Frame Studio, or says "open it in the editor", "put it on the timeline", "ערוך", "תערוך את הסרטון", "תכניס לעורך", "טיימליין", "כתוביות", "אפקטים קוליים", "מעברים", "ייצוא".
---

# Frame Studio — editing with code

Frame Studio runs a local server on `http://127.0.0.1:7788` and an editor window (a Chrome / Edge app window). Every edit
you make is a JSON **op** applied by the server; the editor updates live and shows the user a toast with your summary.
The user can undo your edits or keep editing by hand — so always re-read the state before a new round.

**Full reference:** `docs/CLAUDE-API.md` in the Frame Studio folder (ops, fields, time references, catalog ids, recipes).
Read the relevant section before using an op you haven't used in this conversation.

## First choice: the Frame Studio MCP tools

If the Frame Studio MCP tools (`mcp__frame-studio__*`) are available in this session, **use them instead of the `cutx`
CLI**. They need no shell, no quoting of Hebrew paths and no Bash permission prompts, and `snapshot` returns the frames
to you as images. The order:

1. `frame_studio_status` — starts the local server if needed; shows the sound library and whether transcription is on.
2. `get_editing_guide` — once per conversation, before the first edit (`topic` = an op name such as `addCaptions`, or a
   keyword such as `captions`, `transitions`, `recipe`, for details).
3. `create_project` (or `list_projects` / `get_project`) → `open_editor`, so the user watches live.
4. `import_media` with absolute paths (files or a folder) → media ids `m_…`.
5. `apply_ops` with a short `summary` in the user's language — one batch per logical step. `get_catalog` for ids,
   `search_sounds` for sound effects, `transcribe` or `set_transcript` for word timings.
6. `snapshot` → look at every frame, fix with `apply_ops`, snapshot again.
7. `export_video` (long exports: `wait_job`); if the speech margin fails, `balance_audio` and export again.
   `undo` / `redo` when needed. Call `get_project` before each new round: the user may have edited by hand.

The rules under **Essentials** below apply to the MCP tools too. Use the `cutx` CLI only when these tools are not
available (for example, the MCP server is not registered in this Claude Code setup).

## Fallback: the `cutx` CLI — where it is and how to call it

- Root = the folder that contains `cutx`, `cutx.cmd`, `server/`, `docs/` (find it if unsure: it is the folder with this
  skill's `.claude/` directory, or ask the user).
- Git Bash / macOS / Linux: `./cutx <command>` from the root (or `node <root>/cli/cutx.mjs <command>`).
  cmd / PowerShell: `cutx.cmd <command>`. Do **not** call `cutx.cmd` from Git Bash (quoting breaks).
- The server auto-starts on the first command. `cutx open <id>` opens the editor window so the user can watch.
- `--json` on any command gives machine output. Exit code 0 = ok, 2 = some ops failed / target missed, 1 = error.

## The golden loop with `cutx` (always)

1. `cutx show <id>` — current tracks/clips/ids (the user may have changed things).
2. `cutx ops <id> edit.json --summary "<short description in the user's language>"` — one batch per logical step.
   Use client ids (`"id":"s1"`) so later ops in the batch can reference new clips. Prefer `--atomic` for builds.
3. `cutx snapshot <id> --at <times> --scale 0.5 --sheet` — then **Read the PNG(s)** and actually look:
   cut-off or overlapping text, wrong RTL order, black frames, captions over important content, safe-area violations.
4. Fix and repeat. Then `cutx export <id>` (‑14 LUFS, true peak ≤ ‑1 dBTP, speech-over-background check ≥ 12 dB).
   If the speech margin fails, run `cutx balance <id>` (automatic local dips on the guilty music/sfx clips) and export again.

## Essentials

- Times: seconds, or word refs from the transcript: `"word:ביצים!"`, `"word:דקות:1:-0.1"` (word, occurrence, offset),
  `"marker:שיא"`, `"clip:s2:end"`, `"end"`. Load word timings first: `cutx transcript <id> asr.json [--script "…"]`
  (the `--script` option replaces Whisper's misspellings with the real script words) or `cutx transcribe <id> <media>`
  (MCP: `set_transcript` / `transcribe`).
- Tracks are listed top-to-bottom; the top track is drawn on top. Roles: effects, text (captions = text track with
  `captions:true`), overlay, main, voice, music, sfx. `addClip` picks a track by type/role and creates a new one on overlap.
- Coordinates: `transform.x/y` are pixel offsets of the clip centre from the canvas centre (y down). Absolute from top:
  `yAbs` / `xAbs` shorthands.
- Sound effects come **only from the library** (`cutx sounds "<query>"` or MCP `search_sounds`, then the `sfx` op with
  `gain_db`, `len`, `fade`).
  Never synthesize whooshes/booms.
- Catalog ids (transitions, effects, filters, animations, caption styles, text presets, stickers, fonts, LUTs):
  `cutx catalog <kind>` or MCP `get_catalog` — never guess an id.
- Transitions need adjacent clips on the same track (end of A = start of B); `closeGaps` snaps them.
- Effect clips (`type:"effect"`, e.g. `zoomPunch`, `flash`, `shake`, `glitch`) apply to everything below them for their duration.
- Mistake? `cutx undo <id>` or MCP `undo` (the user sees it too).

## Reporting to the user

Tell the user what changed in plain words, which snapshot frames you checked, and the export report numbers
(duration, LUFS, speech margin). Send the exported file or a contact sheet when useful.
