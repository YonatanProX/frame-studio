// Frame Studio — builds the GitHub Release download: dist/frame-studio-<version>.zip
//
//   node tools/make-release.mjs [--dry-run] [--out <folder>]        (npm run release)
//
// • The file list is what git would publish: `git ls-files --cached --others --exclude-standard` (tracked files plus
//   untracked files that .gitignore does not exclude). Files deleted from the working tree are skipped.
// • Refuses to build (exit 2) if anything personal or licensed would be included: audio / video files, config.json
//   (or its .bak), anything in projects/ except .gitkeep, anything in library/sounds/ except README.md, logs,
//   shortcuts, browser profiles, files over 20 MB, or text that contains your home folder path.
// • Line endings are written the way a fresh checkout produces them (.gitattributes): .cmd / .bat / .ps1 with CRLF,
//   other text files with LF. Everything sits under one top folder "frame-studio-<version>/".
// • Warns about relative links in the Markdown docs that point at files that are not in the zip (e.g. a missing
//   screenshot).
// Zero dependencies: a small ZIP writer on top of node:zlib (deflate + crc32).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const outDir = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist');

function fail(msg, code = 2) { console.error(`make-release: ${msg}`); process.exit(code); }
if (typeof zlib.crc32 !== 'function') fail('needs Node.js 24 or newer (zlib.crc32)');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
const top = `frame-studio-${version}/`;
const zipName = `frame-studio-${version}.zip`;

// ───────────────────────── file list (git) ─────────────────────────

const git = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'buffer', windowsHide: true });
if (git.error || git.status !== 0) fail(`git ls-files failed — git must be installed and this must be a git repository (${git.error ? git.error.message : String(git.stderr).trim()})`);
const listed = [...new Set(git.stdout.toString('utf8').split('\0').filter(Boolean))].sort((a, b) => a.localeCompare(b));
const gone = [];
const files = [];
for (const rel of listed) {
  if (rel.startsWith('dist/')) continue;
  const abs = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(abs); } catch { gone.push(rel); continue; }
  if (st.isFile()) files.push({ rel, abs, size: st.size, mtime: st.mtime });
}

// ───────────────────────── safety checks ─────────────────────────

const AUDIO = /\.(wav|mp3|flac|ogg|m4a|aif|aiff|aac|opus|wma)$/i;
const VIDEO = /\.(mp4|mov|mkv|webm|avi|m4v|mts|wmv)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?|zip|pdf|exe|dll|node)$/i;
const MAX_MB = 20;
const home = os.homedir();
const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
const needles = [...new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'),
  user && user.length >= 4 ? `Users\\${user}` : null, user && user.length >= 4 ? `Users/${user}` : null].filter(Boolean))];

const problems = [];
for (const f of files) {
  const why = [];
  const r = f.rel;
  if (AUDIO.test(r)) why.push('audio file');
  if (VIDEO.test(r)) why.push('video file');
  if (/(^|\/)config\.json(\.bak)?$/i.test(r)) why.push('personal config.json');
  if (r.startsWith('projects/') && r !== 'projects/.gitkeep') why.push('project content');
  if (r.startsWith('library/sounds/') && r !== 'library/sounds/README.md') why.push('sound library content');
  if (/(^|\/)library\/sources\.json$/.test(r)) why.push('personal library sources');
  if (/\.(log|lnk|bak|tmp)$/i.test(r)) why.push('log / shortcut / backup / temp file');
  if (/(^|\/)([^/]*chrome-(prof|render)[^/]*|node_modules)\//i.test(r)) why.push('browser profile / node_modules');
  if (f.size > MAX_MB * 1048576) why.push(`larger than ${MAX_MB} MB`);
  if (!BINARY.test(r) && f.size < 8 * 1048576) {
    let txt = null;
    try { txt = fs.readFileSync(f.abs, 'utf8'); } catch (e) { why.push(`cannot be read (${e.code || e.message})`); }
    const hit = txt != null && needles.find((n) => txt.includes(n));
    if (hit) why.push(`contains your home folder / user name (line ${txt.split(/\r?\n/).findIndex((l) => l.includes(hit)) + 1})`);
  }
  if (why.length) problems.push(`${r} — ${why.join('; ')}`);
}

// ───────────────────────── link check (warnings) ─────────────────────────

const have = new Set(files.map((f) => f.rel));
const dirs = new Set();
for (const f of files) { let d = path.posix.dirname(f.rel); while (d && d !== '.') { dirs.add(d); d = path.posix.dirname(d); } }
const warnings = [];
for (const f of files.filter((x) => x.rel.endsWith('.md'))) {
  const md = fs.readFileSync(f.abs, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of md.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1];
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (!clean) continue;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), clean)).replace(/\/$/, '');
    if (!have.has(rel) && !dirs.has(rel)) warnings.push(`${f.rel}: link to "${target}" — not in the release`);
  }
}

// ───────────────────────── report / build ─────────────────────────

const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
const total = files.reduce((s, f) => s + f.size, 0);
console.log(`Frame Studio ${version}: ${files.length} files, ${fmt(total)} before compression`);
if (gone.length) console.log(`  (skipped ${gone.length} file(s) listed by git but missing on disk: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', …' : ''})`);
for (const w of new Set(warnings)) console.log(`  warning: ${w}`);
if (problems.length) {
  console.error(`\nRefusing to build — ${problems.length} file(s) must not be published:`);
  for (const p of problems.slice(0, 40)) console.error(`  ! ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  console.error('Add them to .gitignore (or delete them) and run again.');
  process.exit(2);
}
if (!files.length) fail('no files to package');
if (files.length > 65000) fail('too many files for a simple ZIP');
if (dry) { console.log('Dry run: checks passed, no zip written.'); process.exit(0); }

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function content(f) {
  let data = fs.readFileSync(f.abs);
  const binary = BINARY.test(f.rel) || data.subarray(0, 8000).includes(0);
  if (!binary) {
    const s = data.toString('latin1');                       // byte-preserving; UTF-8 never contains bare CR/LF bytes
    data = Buffer.from(/\.(cmd|bat|ps1)$/i.test(f.rel) ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'), 'latin1');
  }
  return { data, binary };
}

const locals = [];
const central = [];
let offset = 0;
for (const f of files) {
  const { data, binary } = content(f);
  const name = Buffer.from(top + f.rel, 'utf8');
  const crc = zlib.crc32(data) >>> 0;
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const { time, date } = dosDateTime(f.mtime);
  const flags = 0x0800;                                      // UTF-8 names
  const method = stored ? 0 : 8;
  const mode = f.rel === 'cutx' || f.rel.endsWith('.sh') ? 0o100755 : 0o100644;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, name, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
  ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(binary ? 0 : 1, 36);
  ch.writeUInt32LE((mode << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
  central.push(ch, name);

  offset += lh.length + name.length + body.length;
  if (offset > 0xfffffff0) fail('release is larger than 4 GB');
}
const cdSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, ...central, end]);
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, zipName);
fs.writeFileSync(out + '.tmp', zip);
fs.renameSync(out + '.tmp', out);
const sha = crypto.createHash('sha256').update(zip).digest('hex');
console.log(`\nWrote ${path.relative(ROOT, out)}: ${files.length} files, ${fmt(zip.length)} (${zip.length} bytes)`);
console.log(`SHA-256 ${sha}`);
console.log(`Upload it to a GitHub Release (tag v${version}); users extract it and double-click install.cmd.`);
