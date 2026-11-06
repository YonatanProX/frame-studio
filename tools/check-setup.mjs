// Frame Studio — checks that this computer has what the editor needs, exactly as the server will look for it
// (server/config.mjs: environment variables > config.json > PATH > the usual install folders).
//
//   node tools/check-setup.mjs [--json] [--problems-only]
//
// Required: Node.js 24+, ffmpeg, ffprobe.  Recommended: Google Chrome (exports and snapshots need it; Edge can only
// show the editor window).  Optional: local transcription (faster-whisper).
// Exit code: 0 = everything required is there, 1 = something required is missing (start.cmd then points to install.cmd).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPath, ffprobePath, findChrome, asrConfig, which, configStatus } from '../server/config.mjs';

const MIN_NODE = 24;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const problemsOnly = args.includes('--problems-only');

function probe(exe) {
  const abs = path.isAbsolute(exe) ? (fs.existsSync(exe) ? exe : null) : which(exe);
  if (!abs) return { ok: false, path: null, version: null };
  const r = spawnSync(abs, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const line = String(r.stdout || '').split(/\r?\n/)[0].trim();
  return { ok: r.status === 0, path: abs, version: line.replace(/\s+Copyright.*$/, '') || null };
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const ffmpeg = probe(ffmpegPath());
const ffprobe = probe(ffprobePath());
const chrome = findChrome();
const browser = chrome || findChrome({ allowEdge: true });
const asr = asrConfig();
const cfg = configStatus();

const checks = [
  { id: 'node', required: true, ok: nodeMajor >= MIN_NODE, detail: `v${process.versions.node} (${process.execPath})`,
    en: `Node.js ${MIN_NODE} or newer`, he: `Node.js גרסה ${MIN_NODE} ומעלה` },
  { id: 'ffmpeg', required: true, ok: ffmpeg.ok, detail: ffmpeg.path ? `${ffmpeg.path}  ${ffmpeg.version || ''}`.trim() : 'not found',
    en: 'ffmpeg (video processing)', he: 'ffmpeg (עיבוד וידאו)' },
  { id: 'ffprobe', required: true, ok: ffprobe.ok, detail: ffprobe.path || 'not found',
    en: 'ffprobe (comes with ffmpeg)', he: 'ffprobe (מגיע עם ffmpeg)' },
  { id: 'chrome', required: false, ok: !!chrome, detail: chrome || (browser ? `only ${browser}` : 'not found'),
    en: 'Google Chrome (editor window, export and snapshots)', he: 'Google Chrome (חלון העורך, ייצוא וצילומי פריימים)' },
  { id: 'asr', required: false, optional: true, ok: !!(asr.python && fs.existsSync(asr.python)), detail: asr.python || 'off',
    en: 'Local transcription (optional)', he: 'תמלול מקומי (רשות)' },
];
const missing = checks.filter((c) => c.required && !c.ok);

if (asJson) {
  console.log(JSON.stringify({ ok: !missing.length, config: cfg, checks }, null, 2));
} else {
  if (cfg.error) console.log(`  ! ${cfg.error}`);
  for (const c of checks) {
    if (problemsOnly && (c.ok || !c.required)) continue;
    const mark = c.ok ? 'OK  ' : c.required ? 'MISSING' : c.optional ? 'off ' : 'WARN';
    console.log(`  [${mark}] ${c.en} · ${c.he}`);
    console.log(`          ${c.detail}`);
  }
  if (!problemsOnly && !chrome && browser) {
    console.log('  The editor window will open in Edge, but export and snapshots need Google Chrome.');
    console.log('  חלון העורך ייפתח ב-Edge, אבל לייצוא ולצילומי פריימים צריך Google Chrome.');
  }
}
process.exitCode = missing.length ? 1 : 0;
