# Contributing to Frame Studio

Thanks for helping! Bug reports, fixes, new transitions/effects and docs are all welcome.

## Getting started

1. You need Node 24+, Google Chrome or Microsoft Edge, and ffmpeg. On Windows `install.cmd` sets it up in place
   (portable Node.js / ffmpeg in `runtime\` when missing) and writes `config.json`; elsewhere put them on `PATH`.
   `node tools/check-setup.mjs` shows what is found. No `npm install` is needed — there are no dependencies.
2. Optionally copy `config.example.json` to `config.json` and adjust it for your machine.
3. Run `node server/main.mjs` and open http://127.0.0.1:7788 (or `start.cmd` on Windows).
4. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), for the operation engine [`docs/CLAUDE-API.md`](docs/CLAUDE-API.md),
   and for the original module contracts [`docs/dev/SPEC.md`](docs/dev/SPEC.md).

## Ground rules

- **No runtime dependencies, no CDN, no network at runtime.** Vanilla ES modules only.
- `shared/` and `render/` are imported by **both Node and the browser**: no DOM access at module top level, no Node built-ins.
- **Determinism:** a rendered frame is a pure function of *(project, time)*. No `Math.random`, `Date.now` or timers inside
  renderers — use `hash(seed, n)` / `noise1` from `shared/anim.js`.
- **Ops are pure:** `applyOps` never mutates its input; every UI edit goes through an operation so Claude and the user share
  one history. New editing features should be new ops (with an `OPS_HELP` entry) rather than UI-only state.
- Child processes always get **argument arrays**, never shell strings (paths contain spaces and Hebrew).
- User-visible strings are Hebrew today; keep code identifiers and ids in English.
- Machine-specific paths go in `config.json` via `server/config.mjs` — never hard-code a path from your machine.

## Adding a transition, effect or filter

Transitions live in `render/transitions-gl.js` (`TRANSITIONS`), effects and filters in `render/effects-gl.js`
(`EFFECTS`, `FILTERS`). Each entry has an id, a Hebrew name, a category, typed params and original GLSL. Write your
own shaders — do not paste code under an incompatible license. Check it with `cutx catalog transitions` and a
`cutx snapshot` at a few times through the transition.

## Tests

`tools/tests/` is for development only (users never need it). **`npm test`** runs the self-contained tests
(`tools/run-tests.mjs`: operation engine, `cutx balance`, script/ASR alignment, every example in `docs/CLAUDE-API.md`,
timeline edit planning, the CLI against a mock server, and the MCP server protocol) — no server, Chrome or media files needed; run it before
every PR. The other scripts are plain Node scripts (`node tools/tests/<name>.mjs`); most need the server running on
port 7788, some need Chrome, ffmpeg or local media. Run the ones related to what you changed and include the output in
your PR.

## Installer and releases

- The Windows installer is `install.cmd` → `tools/install.ps1` (shared helpers in `tools/setup-common.ps1`); the
  one-line installer `install.ps1` in the repository root downloads the latest release and then runs the same script.
  Test changes with `install.cmd -DryRun -NoPause` (add `-ForcePortable` to see the Node.js / ffmpeg download path) — it
  never installs or changes anything in that mode except its log (`-LogFile <file>` to put the log elsewhere). For a
  real test install that leaves your own setup alone, run the one-line installer from a local folder or ZIP
  (`install.ps1 -Source <folder|zip> -AppDir <dir>`) with `-DataDir`, `-ShortcutDir`, `-NoPath`, `-NoRegistry`,
  `-ClaudeDesktopConfig <file>` and `-ClaudeHome <dir>`. The `.ps1` files with Hebrew text are UTF-8 **with BOM** (Windows
  PowerShell 5.1 needs it); `.cmd` files must be UTF-8 **without** BOM and CRLF.
- `tools/config-set.mjs key=value …` changes single values in `config.json` and leaves the rest of the file untouched.
- `npm run release` builds `dist/frame-studio-<version>.zip` from the files git would publish (version from
  `package.json`) and refuses to build if audio, video, `config.json` or project content would be included.

## Never commit

Audio files, `projects/`, exports, snapshots, `config.json`, logs or browser profiles. `.gitignore` covers these;
`node tools/list-publishable.mjs` prints exactly what would be published. Sound libraries such as Sonniss and Mixkit
may not be redistributed.

## Pull requests

Keep PRs focused, describe what changed and how you checked it (screenshots or snapshots for visual changes).
By contributing you agree that your contribution is licensed under the MIT License of this project.
