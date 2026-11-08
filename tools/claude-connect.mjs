// Frame Studio — connects (and disconnects) Frame Studio to Claude. Used by tools/install.ps1 and uninstall.ps1.
//
//   node tools/claude-connect.mjs desktop-add    --config <claude_desktop_config.json> --node <node.exe> --server <mcp/server.mjs> [--dry-run]
//   node tools/claude-connect.mjs desktop-remove --config <claude_desktop_config.json> [--app <install folder>] [--dry-run]
//   node tools/claude-connect.mjs code-add       --config <.claude.json> --node <node.exe> --server <mcp/server.mjs> [--dry-run]
//   node tools/claude-connect.mjs code-remove    --config <.claude.json> [--app <install folder>] [--dry-run]
//   node tools/claude-connect.mjs skill-install  --home <~/.claude> --app <install folder> [--node <node.exe>] [--source <skill folder>] [--dry-run]
//   node tools/claude-connect.mjs skill-remove   --home <~/.claude> [--app <install folder>] [--dry-run]
//
// Claude Desktop: merges {"mcpServers":{"frame-studio":{"command":<node>,"args":[<server>]}}} into the config file —
// every other server and setting is kept; a missing file is created; a UTF-8 BOM is accepted; before an existing file
// is changed a backup copy is written next to it (<file>.frame-studio-backup, one file, overwritten); a file that is not valid JSON is
// never touched (exit 3). Nothing is written when the entry is already right.
// Claude Code MCP (code-add / code-remove): the same merge for Claude Code's user settings file — %USERPROFILE%\.claude.json,
// or %CLAUDE_CONFIG_DIR%\.claude.json — with the entry "claude mcp add --scope user" writes
// ({"type":"stdio","command":<node>,"args":[<server>],"env":{}}). Written directly, so it works without the claude
// command on PATH (e.g. Claude Code that came with Claude Desktop). Only the top-level "mcpServers" key is changed;
// code-remove never creates a missing file.
// Claude Code skill: copies the bundled skill (.claude/skills/frame-studio) into <home>/skills/frame-studio and writes this
// computer's install folder into it, plus a marker file so that only a copy we installed is ever replaced or removed.
// Exit codes: 0 ok · 2 bad arguments · 3 config file is not valid JSON · 4 the skill folder belongs to someone else.
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'frame-studio';
const MARKER = '.frame-studio-install.json';

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  if (k === 'dry-run') opt.dry = true;
  else opt[k] = rest[++i];
}
const dry = !!opt.dry;
const say = (s) => console.log(s);
function fail(msg, code = 2) { console.error(`claude-connect: ${msg}`); process.exit(code); }
const need = (k) => { if (!opt[k]) fail(`--${k} is required`); return path.resolve(opt[k]); };
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
const inside = (p, dir) => { const a = norm(p), b = norm(dir); return a === b || a.startsWith(b + path.sep.toLowerCase()) || a.startsWith(b + '/'); };

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {} };
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return { exists: true, data: {} };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the top level is not a JSON object');
    return { exists: true, data };
  } catch (e) {
    fail(`${file} is not valid JSON — it was not changed. Fix or delete it, then run the installer again. (${e.message})`, 3);
  }
}

// One backup file, overwritten each time (the file as it was just before our last change) — never a pile of copies in
// the user's Claude folder. Timestamped copies left by earlier versions (<file>.frame-studio-backup-<yyyymmdd-hhmmss>)
// are cleaned up.
function writeJson(file, data, existed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existed) {
    const bak = `${file}.frame-studio-backup`;
    fs.copyFileSync(file, bak);
    say(`backup: ${bak}`);
    const esc = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const old = new RegExp(`^${esc}\\.frame-studio-backup-\\d{8}-\\d{6}$`, 'i');
    try { for (const n of fs.readdirSync(path.dirname(file))) if (old.test(n)) fs.rmSync(path.join(path.dirname(file), n), { force: true }); } catch { /* best effort */ }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// kind: 'desktop' (Claude Desktop) or 'code' (Claude Code, user scope)
const LABEL = { desktop: 'Claude Desktop', code: 'Claude Code' };
function mcpEntry(kind, node, server) {
  return kind === 'code' ? { type: 'stdio', command: node, args: [server], env: {} } : { command: node, args: [server] };
}
function entryIsRight(kind, old, entry) {
  if (!old || typeof old !== 'object') return false;
  if (!same({ command: old.command, args: old.args }, { command: entry.command, args: entry.args })) return false;
  if (kind === 'code') {
    return old.type === 'stdio' && Object.keys(old).every((k) => ['type', 'command', 'args', 'env'].includes(k))
      && (old.env == null || (typeof old.env === 'object' && !Object.keys(old.env).length));
  }
  return Object.keys(old).every((k) => k === 'command' || k === 'args');
}

function mcpAdd(kind) {
  const file = need('config'), node = need('node'), server = need('server');
  const label = LABEL[kind];
  const { exists, data } = readJson(file);
  const entry = mcpEntry(kind, node, server);
  if (data.mcpServers != null && (typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers))) fail(`${file}: "mcpServers" is not an object — it was not changed.`, 3);
  const servers = data.mcpServers || {};
  const old = servers[NAME];
  if (entryIsRight(kind, old, entry)) { say(`${label}: already connected (${file})`); return; }
  const next = { ...data, mcpServers: { ...servers, [NAME]: entry } };
  if (dry) { say(`${label}: would ${old ? 'update' : 'add'} "${NAME}" in ${file}${exists ? '' : ' (new file)'}`); return; }
  writeJson(file, next, exists);
  say(`${label}: ${old ? 'updated' : 'added'} "${NAME}" in ${file}`);
}

function mcpRemove(kind) {
  const file = need('config');
  const label = LABEL[kind];
  if (!fs.existsSync(file)) { say(`${label}: nothing to remove (${file} does not exist)`); return; }
  const { data } = readJson(file);
  const old = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers[NAME] : null;
  if (!old) { say(`${label}: "${NAME}" is not in ${file}`); return; }
  if (opt.app) {
    const args = Array.isArray(old.args) ? old.args : [];
    const ours = [old.command, ...args].some((a) => typeof a === 'string' && inside(a, opt.app));
    if (!ours) { say(`${label}: "${NAME}" in ${file} points to another Frame Studio folder — left as it is`); return; }
  }
  const servers = { ...data.mcpServers };
  delete servers[NAME];
  if (dry) { say(`${label}: would remove "${NAME}" from ${file}`); return; }
  writeJson(file, { ...data, mcpServers: servers }, true);
  say(`${label}: removed "${NAME}" from ${file}`);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function skillDir() { return path.join(need('home'), 'skills', NAME); }

function readMarker(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch { return null; }
}

function installedNote(app, node) {
  const cutxCmd = path.join(app, 'cutx.cmd');
  const nodeCmd = node ? `"${node.replace(/\\/g, '/')}" "${path.join(app, 'cli', 'cutx.mjs').replace(/\\/g, '/')}"` : `node "${path.join(app, 'cli', 'cutx.mjs').replace(/\\/g, '/')}"`;
  return [
    '## On this computer',
    '',
    `Frame Studio is installed in \`${app}\` (that folder is the "root" this skill talks about).`,
    opt['on-path'] === '0'
      ? `- cmd / PowerShell: \`"${cutxCmd}" <command>\`.`
      : `- cmd / PowerShell: \`cutx <command>\` works in any new terminal (the folder is on PATH), or call \`"${cutxCmd}" <command>\`.`,
    `- Git Bash: \`${nodeCmd} <command>\` (do not call cutx.cmd from Git Bash).`,
    `- Full reference: \`${path.join(app, 'docs', 'CLAUDE-API.md')}\`.`,
    '',
  ].join('\n');
}

function skillInstall() {
  const app = need('app');
  const src = opt.source ? path.resolve(opt.source) : path.join(app, '.claude', 'skills', NAME);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) fail(`the skill is missing in this copy of Frame Studio: ${src}`);
  const dst = skillDir();
  if (fs.existsSync(dst) && !readMarker(dst)) {
    // a folder of the same name that we did not install: only replace it if it is clearly a Frame Studio skill
    let txt = '';
    try { txt = fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8'); } catch { /* none */ }
    if (!/^name:\s*frame-studio\s*$/m.test(txt)) fail(`${dst} already exists and was not installed by Frame Studio — left as it is.`, 4);
  }
  if (dry) { say(`Claude Code: would install the skill to ${dst}`); return; }
  const tmp = `${dst}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  copyDir(src, tmp);
  const skillFile = path.join(tmp, 'SKILL.md');
  let txt = fs.readFileSync(skillFile, 'utf8');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(txt);
  const note = installedNote(app, opt.node ? path.resolve(opt.node) : null);
  txt = m ? `${m[0]}\n${note}\n${txt.slice(m[0].length).replace(/^\r?\n/, '')}` : `${note}\n${txt}`;
  fs.writeFileSync(skillFile, txt, 'utf8');
  fs.writeFileSync(path.join(tmp, MARKER), JSON.stringify({ app, installedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(tmp, dst);
  say(`Claude Code: skill installed to ${dst}`);
}

function skillRemove() {
  const dst = skillDir();
  if (!fs.existsSync(dst)) { say(`Claude Code: no skill to remove (${dst})`); return; }
  const mk = readMarker(dst);
  if (!mk) { say(`Claude Code: ${dst} was not installed by Frame Studio — left as it is`); return; }
  if (opt.app && mk.app && norm(mk.app) !== norm(opt.app)) { say(`Claude Code: the skill in ${dst} belongs to another Frame Studio folder — left as it is`); return; }
  if (dry) { say(`Claude Code: would remove ${dst}`); return; }
  fs.rmSync(dst, { recursive: true, force: true });
  say(`Claude Code: removed ${dst}`);
}

const cmds = {
  'desktop-add': () => mcpAdd('desktop'), 'desktop-remove': () => mcpRemove('desktop'),
  'code-add': () => mcpAdd('code'), 'code-remove': () => mcpRemove('code'), 'skill-install': skillInstall, 'skill-remove': skillRemove };
if (!cmds[cmd]) fail(`unknown command "${cmd || ''}" — use one of: ${Object.keys(cmds).join(', ')}`);
try { cmds[cmd](); } catch (e) { fail(e && e.message ? e.message : String(e), 1); }
