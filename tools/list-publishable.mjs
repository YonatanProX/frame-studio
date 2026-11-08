// Frame Studio — lists every file that WOULD be committed given the root .gitignore, without touching git.
// Applies standard gitignore semantics (negation, anchoring, dir-only "/", *, **, ?, [..]; an ignored directory
// cannot be re-included) for the root .gitignore, then flags anything suspicious before publishing:
// audio / video files, large files, and text files that contain your home folder path or user name.
//
//   node tools/list-publishable.mjs [--summary] [--json] [--max-mb 2]
//
// Exit code: 0 = clean, 2 = suspicious entries found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const summaryOnly = args.includes('--summary');
const maxMb = Number(args[args.indexOf('--max-mb') + 1]) || 2;

// ───────────────────────── gitignore ─────────────────────────

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevSlash = i === 0 || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/';
        if (prevSlash && nextSlash) { re += '(?:.*/)?'; i += 2; continue; }   // "**/"
        if (prevSlash && i + 2 === glob.length) { re += '.*'; i += 1; continue; } // trailing "/**"
        re += '.*'; i += 1; continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j < 0) { re += '\\['; continue; }
      let cls = glob.slice(i + 1, j).replace(/\\/g, '\\\\');
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += `[${cls}]`; i = j;
    } else if (c === '\\' && i + 1 < glob.length) { re += '\\' + glob[++i]; }
    else re += /[.+^${}()|\\/]/.test(c) ? '\\' + c : c;
  }
  return re;
}

function parseGitignore(text) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globToRegex(line);
    const re = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
    rules.push({ re, negate, dirOnly, src: (negate ? '!' : '') + line + (dirOnly ? '/' : '') });
  }
  return rules;
}

function isIgnored(rules, rel, isDir) {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) ignored = !r.negate;
  }
  return ignored;
}

// ───────────────────────── walk ─────────────────────────

const giFile = path.join(ROOT, '.gitignore');
const rules = fs.existsSync(giFile) ? parseGitignore(fs.readFileSync(giFile, 'utf8')) : [];
const files = [];
(function walk(dir, relDir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    const isDir = e.isDirectory();
    if (isIgnored(rules, rel, isDir)) continue;
    if (isDir) walk(abs, rel);
    else if (e.isFile()) files.push({ rel, size: fs.statSync(abs).size });
  }
})(ROOT, '');
files.sort((a, b) => a.rel.localeCompare(b.rel));

// ───────────────────────── checks ─────────────────────────

const AUDIO = /\.(wav|mp3|flac|ogg|m4a|aif|aiff|aac|opus|wma)$/i;
const VIDEO = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;
const TEXT = /\.(m?js|cjs|json|md|txt|html|css|cmd|bat|ps1|py|sh|cube|svg|ya?ml|gitignore)$/i;
const home = os.homedir();
const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
const needles = [...new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'),
  user && user.length >= 4 ? user : null].filter(Boolean))];
const suspicious = [];
for (const f of files) {
  const why = [];
  if (AUDIO.test(f.rel)) why.push('audio file');
  if (VIDEO.test(f.rel)) why.push('video file');
  if (f.size > maxMb * 1024 * 1024) why.push(`larger than ${maxMb} MB`);
  if (/(^|\/)(config\.json|sources\.json|server\.log)$/.test(f.rel)) why.push('personal config / log');
  if (TEXT.test(f.rel) || !path.extname(f.rel)) {
    try {
      const txt = fs.readFileSync(path.join(ROOT, f.rel), 'utf8');
      const hit = needles.find((n) => txt.includes(n));
      if (hit) {
        const line = txt.split(/\r?\n/).findIndex((l) => l.includes(hit)) + 1;
        why.push(`contains your home path / user name (line ${line})`);
      }
    } catch { /* unreadable */ }
  }
  if (why.length) suspicious.push({ ...f, why });
}

const total = files.reduce((s, f) => s + f.size, 0);
const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const byTop = {};
for (const f of files) {
  const top = f.rel.includes('/') ? f.rel.split('/')[0] + '/' : '(root)';
  byTop[top] = byTop[top] || { count: 0, size: 0 };
  byTop[top].count++; byTop[top].size += f.size;
}

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, count: files.length, size: total, byTop, suspicious, files }, null, 2));
} else {
  if (!summaryOnly) for (const f of files) console.log(`${fmt(f.size).padStart(10)}  ${f.rel}`);
  console.log('\nBy folder:');
  for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1].size - a[1].size)) console.log(`  ${k.padEnd(14)} ${String(v.count).padStart(4)} files  ${fmt(v.size).padStart(10)}`);
  console.log(`\nPublishable: ${files.length} files, ${fmt(total)}  (rules from ${path.relative(ROOT, giFile) || '.gitignore'}: ${rules.length})`);
  if (suspicious.length) {
    console.log(`\nSuspicious (${suspicious.length}):`);
    for (const s of suspicious) console.log(`  ! ${s.rel} — ${s.why.join('; ')}`);
  } else console.log('No suspicious entries (no audio/video, nothing large, no personal paths).');
}
process.exitCode = suspicious.length ? 2 : 0;
