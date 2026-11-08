// Frame Studio — checks that this computer has what the editor needs, exactly as the server will look for it
// (server/config.mjs: environment variables > config.json > PATH > runtime/ (the installer's portable copies) > the
// usual install folders).
//
//   node tools/check-setup.mjs [--json] [--problems-only]
//
// Required: Node.js 24+, ffmpeg, ffprobe, a browser (Google Chrome or Microsoft Edge — the editor window, snapshots and
// export). Optional: local transcription (faster-whisper).
// Exit code: 0 = everything required is there, 1 = something required is missing (start.cmd then points to the installer).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as cfgMod from '../server/config.mjs';
import { ffmpegPath, ffprobePath, findChrome, asrConfig, which, configStatus, ROOT } from '../server/config.mjs';

const MIN_NODE = 24;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const problemsOnly = args.includes('--problems-only');

function probe(exe, { encoders = false } = {}) {
  const abs = path.isAbsolute(exe) ? (fs.existsSync(exe) ? exe : null) : which(exe);
  if (!abs) return { ok: false, path: null, version: null };
  const r = spawnSync(abs, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const line = String(r.stdout || '').split(/\r?\n/)[0].trim();
  let x264 = null;
  if (encoders && r.status === 0) {
    const e = spawnSync(abs, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 << 20 });
    x264 = /libx264/.test(String(e.stdout || ''));
  }
  return { ok: r.status === 0, path: abs, version: line.replace(/\s+Copyright.*$/, '') || null, x264 };
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const ffmpeg = probe(ffmpegPath(), { encoders: true });
const ffprobe = probe(ffprobePath());
const browser = findChrome({ allowEdge: true });
const edge = typeof cfgMod.isEdge === 'function' ? cfgMod.isEdge(browser) : /msedge/i.test(String(browser || ''));
const asr = asrConfig();
const cfg = configStatus();
const dataDir = typeof cfgMod.dataDir === 'function' ? cfgMod.dataDir() : ROOT;

const checks = [
  { id: 'node', required: true, ok: nodeMajor >= MIN_NODE, detail: `v${process.versions.node} (${process.execPath})`,
    en: `Node.js ${MIN_NODE} or newer`, he: `Node.js גרסה ${MIN_NODE} ומעלה` },
  { id: 'ffmpeg', required: true, ok: ffmpeg.ok && ffmpeg.x264 !== false,
    detail: ffmpeg.path ? `${ffmpeg.path}  ${ffmpeg.version || ''}${ffmpeg.x264 === false ? '  (no libx264 encoder — MP4 export needs a full build)' : ''}`.trim() : 'not found',
    en: 'ffmpeg with libx264 (video processing and MP4 export)', he: 'ffmpeg עם libx264 (עיבוד וידאו וייצוא MP4)' },
  { id: 'ffprobe', required: true, ok: ffprobe.ok, detail: ffprobe.path || 'not found',
    en: 'ffprobe (comes with ffmpeg)', he: 'ffprobe (מגיע עם ffmpeg)' },
  { id: 'browser', required: true, ok: !!browser, detail: browser ? `${browser}${edge ? '  (Microsoft Edge)' : ''}` : 'not found',
    en: 'Browser: Google Chrome or Microsoft Edge (editor window, snapshots and export)', he: 'דפדפן: Google Chrome או Microsoft Edge (חלון העורך, צילומי פריימים וייצוא)' },
  { id: 'asr', required: false, optional: true, ok: !!(asr.python && fs.existsSync(asr.python)), detail: asr.python || 'off',
    en: 'Local transcription (optional)', he: 'תמלול מקומי (רשות)' },
];
const missing = checks.filter((c) => c.required && !c.ok);

if (asJson) {
  console.log(JSON.stringify({ ok: !missing.length, config: cfg, dataDir, checks }, null, 2));
} else {
  if (cfg.error) console.log(`  ! ${cfg.error}`);
  for (const c of checks) {
    if (problemsOnly && (c.ok || !c.required)) continue;
    const mark = c.ok ? 'OK  ' : c.required ? 'MISSING' : c.optional ? 'off ' : 'WARN';
    console.log(`  [${mark}] ${c.en} · ${c.he}`);
    console.log(`          ${c.detail}`);
  }
  if (!problemsOnly) {
    console.log(`  [info] Your projects folder · תיקיית הפרויקטים שלכם`);
    console.log(`          ${path.join(dataDir, 'projects')}`);
  }
}
process.exitCode = missing.length ? 1 : 0;
