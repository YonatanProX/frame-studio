// Frame Studio — sound folders: the folders the sound library indexes, wherever they are on the computer.
//
// Nothing is moved or copied: the user picks a folder ("הוסף תיקיית צלילים") and the library simply reads it.
// The list is kept in <dataDir>/sound-folders.json:
//   { "version": 1, "folders": [ { "path": "D:/Sounds/Sonniss GDC 2026", "addedAt": "2026-11-06T12:00:00.000Z" } ] }
//
// The library ALWAYS indexes, in addition to the folders in that list:
//   • ROOT/library/sounds      (the built-in folder — the generated Starter Pack lives here)
//   • soundsDir()              (<dataDir>/Sounds — a plain folder where users may drop files)
//
// dataDir comes from server/config.mjs (dataDir()) when it exists; otherwise env FRAME_STUDIO_DATA, otherwise ROOT.
// User folders are only ever READ. Caches live in <dataDir>/.cache, never inside a user folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as cfg from './config.mjs';

const IS_WIN = process.platform === 'win32';
let ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let DATA_OVERRIDE = null;

/** Override ROOT / dataDir (tests and tools). */
export function configureFolders({ root, dataDir } = {}) {
  if (root) ROOT = path.resolve(root);
  if (dataDir !== undefined) DATA_OVERRIDE = dataDir ? path.resolve(dataDir) : null;
}

/** Absolute user-data folder (projects, sound-folders.json, .cache). */
export function dataDir() {
  if (DATA_OVERRIDE) return DATA_OVERRIDE;
  if (typeof cfg.dataDir === 'function') {
    try { const d = cfg.dataDir(); if (d) return path.resolve(d); } catch { /* fall back */ }
  }
  const env = String(process.env.FRAME_STUDIO_DATA || '').trim();
  return env ? path.resolve(env) : ROOT;
}

/** <dataDir>/Sounds — never created here (config.mjs may create it on demand). */
export function soundsDir() {
  if (!DATA_OVERRIDE && typeof cfg.soundsDir === 'function') {
    try { const d = cfg.soundsDir(); if (d) return path.resolve(d); } catch { /* fall back */ }
  }
  return path.join(dataDir(), 'Sounds');
}

/** ROOT/library/sounds — the built-in sound folder (Starter Pack). */
export function builtinSoundsDir() { return path.join(ROOT, 'library', 'sounds'); }

/**
 * Cache folder for the sound index and waveform peaks — never inside a user's sound folder.
 * Developer layout (data in ROOT): ROOT/library/sounds/.index (gitignored, skipped by the walk).
 * Installed copy: config.mjs cacheDir()/sounds (Windows: %LOCALAPPDATA%/Frame Studio/cache — no clutter in Documents),
 * otherwise <dataDir>/.cache/sounds.
 */
export function cacheDir() {
  if (DATA_OVERRIDE) return path.join(DATA_OVERRIDE, '.cache', 'sounds');
  const dd = dataDir();
  if (pathKey(dd) === pathKey(ROOT)) return path.join(builtinSoundsDir(), '.index');
  if (typeof cfg.cacheDir === 'function') {
    try { const c = cfg.cacheDir(); if (c) return path.join(path.resolve(c), 'sounds'); } catch { /* fall back */ }
  }
  return path.join(dd, '.cache', 'sounds');
}

function listFile() { return path.join(dataDir(), 'sound-folders.json'); }

// ───────────────────────────── path helpers ─────────────────────────────

/** Normalized absolute path with forward slashes, no trailing slash (except a drive root). */
export function normPath(p) {
  let s = path.resolve(String(p)).split(path.sep).join('/');
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  if (IS_WIN && /^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}
/** Key for comparing paths (case-insensitive on Windows / macOS). */
export function pathKey(p) {
  const s = normPath(p);
  return IS_WIN || process.platform === 'darwin' ? s.toLowerCase() : s;
}
/** true when `child` is `parent` or inside it. */
export function isInside(child, parent) {
  const c = pathKey(child), p = pathKey(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// ───────────────────────────── persisted list ─────────────────────────────

function readList() {
  try {
    const j = JSON.parse(fs.readFileSync(listFile(), 'utf8').replace(/^\uFEFF/, ''));
    const arr = Array.isArray(j) ? j : Array.isArray(j.folders) ? j.folders : [];
    const out = [];
    const seen = new Set();
    for (const it of arr) {
      const p = typeof it === 'string' ? it : it && typeof it.path === 'string' ? it.path : null;
      if (!p || !path.isAbsolute(p)) continue;
      const k = pathKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ path: normPath(p), addedAt: (it && it.addedAt) || null });
    }
    return out;
  } catch { return []; }
}

function writeList(list) {
  const file = listFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, folders: list.map((f) => ({ path: f.path, addedAt: f.addedAt })) }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** Folders the user added → [{ path, name, addedAt, exists }] (paths with forward slashes). */
export function listSoundFolders() {
  return readList().map((f) => ({ ...f, name: path.basename(f.path) || f.path, exists: isDir(f.path) }));
}

/**
 * Every folder the library indexes, in order: built-in, <dataDir>/Sounds, then the user's folders.
 * → [{ path, name, kind:'builtin'|'data'|'user', exists, removable }]
 * Folders that are inside another listed folder are dropped (no double indexing).
 */
export function allSoundRoots() {
  const roots = [];
  const push = (p, kind, extra = {}) => {
    if (roots.some((r) => isInside(p, r.path))) return;
    roots.push({ path: normPath(p), name: path.basename(p) || p, kind, exists: isDir(p), removable: kind === 'user', ...extra });
  };
  push(builtinSoundsDir(), 'builtin');
  push(soundsDir(), 'data');
  for (const f of readList()) push(f.path, 'user', { addedAt: f.addedAt });
  return roots;
}

class FolderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Folders that make no sense to index as a whole (a drive root, the home folder, Windows, Program Files…). */
function forbiddenReason(abs) {
  const n = pathKey(abs);
  const parsed = path.parse(path.resolve(abs));
  if (pathKey(parsed.root) === n || n === '/') return 'אי אפשר להוסיף כונן שלם — בחרו את התיקייה שבה נמצאים הצלילים';
  const bad = [os.homedir(), process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData,
    process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  for (const b of bad) if (pathKey(b) === n) return 'התיקייה הזו גדולה מדי — בחרו את התיקייה שבה נמצאים הצלילים עצמם';
  return null;
}

/**
 * Add a folder (absolute path). Throws FolderError (status 400) with a Hebrew message when it cannot be added.
 * → { ok, added:boolean, already?:'builtin'|'data'|'user', folder, replaced:[paths], folders }
 */
export function addSoundFolder(absPath) {
  const raw = String(absPath || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new FolderError('חסר נתיב של תיקייה');
  if (!path.isAbsolute(raw)) throw new FolderError('צריך נתיב מלא לתיקייה (למשל C:\\Users\\…\\Sounds)');
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs)) throw new FolderError(`התיקייה לא נמצאה: ${abs}`);
  if (!isDir(abs)) throw new FolderError('זה קובץ ולא תיקייה — בחרו את התיקייה שמכילה את הצלילים');
  const why = forbiddenReason(abs);
  if (why) throw new FolderError(why);
  const folder = normPath(abs);
  const list = readList();
  // already covered by the built-in folders or by a folder in the list?
  for (const r of allSoundRoots()) {
    if (isInside(folder, r.path)) {
      return { ok: true, added: false, already: r.kind, folder: r.path, replaced: [], folders: listSoundFolders() };
    }
  }
  // a parent folder replaces the folders inside it
  const replaced = list.filter((f) => isInside(f.path, folder)).map((f) => f.path);
  const next = list.filter((f) => !isInside(f.path, folder));
  next.push({ path: folder, addedAt: new Date().toISOString() });
  writeList(next);
  return { ok: true, added: true, folder, replaced, folders: listSoundFolders() };
}

/** Remove a folder from the list (the folder itself is never touched). → { ok, removed:boolean, folders } */
export function removeSoundFolder(absPath) {
  const raw = String(absPath || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new FolderError('חסר נתיב של תיקייה');
  const k = pathKey(raw);
  const list = readList();
  const next = list.filter((f) => pathKey(f.path) !== k);
  const removed = next.length !== list.length;
  if (removed) writeList(next);
  else if (allSoundRoots().some((r) => r.kind !== 'user' && pathKey(r.path) === k)) {
    throw new FolderError('זו תיקיית הצלילים המובנית של Frame Studio — אי אפשר להסיר אותה');
  }
  return { ok: true, removed, folders: listSoundFolders() };
}

// ───────────────────────────── native folder picker ─────────────────────────────

// Windows: the modern Explorer-style folder dialog (IFileOpenDialog + FOS_PICKFOLDERS) through a tiny inline C# type,
// owned by an invisible TopMost window so it opens above the editor window. Falls back to FolderBrowserDialog.
// The chosen path is printed as base64(UTF-8) so Hebrew / spaces survive any console code page.
const PICK_PS = String.raw`
$ErrorActionPreference = 'Stop'
$title = '__TITLE__'
$okLabel = '__OK__'
$start = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__START__'))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$code = @'
using System;
using System.Runtime.InteropServices;
public static class FsFolderPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCo {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(IShellItem psi, uint hint, out int order);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint c, IntPtr specs);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem ppsi);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);
  public static string Pick(IntPtr owner, string title, string ok, string start) {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogCo();
    uint o; dlg.GetOptions(out o);
    dlg.SetOptions(o | 0x20u | 0x40u | 0x800u | 0x8u);   // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST | NOCHANGEDIR
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel(ok);
    if (!String.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
      try { Guid g = typeof(IShellItem).GUID; IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, ref g, out si); dlg.SetFolder(si); } catch { }
    }
    int hr = dlg.Show(owner);
    if (hr != 0) return null;                              // canceled (0x800704C7) or failed
    IShellItem res; dlg.GetResult(out res);
    string p; res.GetDisplayName(0x80058000u, out p);      // SIGDN_FILESYSPATH
    return p;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(1, 1)
# the first ShowWindow of a process started hidden is ignored → show, hide, show
$owner.Show(); $owner.Hide(); $owner.Show(); $owner.Activate()
$picked = $null
try {
  Add-Type -TypeDefinition $code -Language CSharp
  $picked = [FsFolderPick]::Pick($owner.Handle, $title, $okLabel, $start)
} catch {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $title
  $d.ShowNewFolderButton = $false
  if ($start -and (Test-Path -LiteralPath $start)) { $d.SelectedPath = $start }
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $d.SelectedPath }
}
$owner.Close()
if ($picked) { [Console]::Out.Write('FSPICK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picked))) }
else { [Console]::Out.Write('FSPICK-CANCEL') }
`;

let picking = null;   // { child, promise } — one picker at a time

/** The picker process currently open (for tests / cancel), or null. */
export function currentPicker() { return picking ? { pid: picking.child.pid } : null; }

/**
 * Open a native folder picker on the user's screen. Never blocks the event loop (child process).
 * → Promise<{ path } | { canceled:true }>; rejects with FolderError (409 when one is already open, 501 when unsupported).
 */
export function pickFolder({ title = 'בחרו את תיקיית הצלילים', okLabel = 'הוספת התיקייה', start, timeoutMs = 15 * 60_000 } = {}) {
  if (picking) return Promise.reject(new FolderError('חלון בחירת התיקייה כבר פתוח — הוא אולי מאחורי החלון הזה', 409));
  const home = os.homedir();
  const startDir = start || [path.join(home, 'Downloads'), home].find(isDir) || '';
  let cmd, args;
  if (IS_WIN) {
    const ps = PICK_PS.replace('__TITLE__', title.replace(/'/g, "''")).replace('__OK__', okLabel.replace(/'/g, "''"))
      .replace('__START__', Buffer.from(startDir, 'utf8').toString('base64'));
    const sysPs = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    cmd = fs.existsSync(sysPs) ? sysPs : 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')];
  } else if (process.platform === 'darwin') {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    cmd = 'osascript';
    args = ['-e', `POSIX path of (choose folder with prompt "${esc(title)}"${startDir ? ` default location (POSIX file "${esc(startDir)}")` : ''})`];
  } else {
    cmd = 'zenity';
    args = ['--file-selection', '--directory', `--title=${title}`, ...(startDir ? [`--filename=${startDir}/`] : [])];
  }
  const promise = new Promise((resolve, reject) => {
    let out = '', err = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new FolderError(`לא ניתן לפתוח חלון בחירת תיקייה: ${e.message}`, 501)); return; }
    picking = { child, promise: null };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { if (err.length < 4000) err += b; });
    child.on('error', (e) => {
      clearTimeout(timer); picking = null;
      reject(new FolderError(e.code === 'ENOENT' ? 'אין במחשב הזה חלון בחירת תיקיות — הדביקו את הנתיב של התיקייה' : `חלון בחירת התיקייה נכשל: ${e.message}`, 501));
    });
    child.on('close', (code) => {
      clearTimeout(timer); picking = null;
      const s = out.trim();
      if (IS_WIN) {
        const m = /FSPICK:([A-Za-z0-9+/=]+)/.exec(s);
        if (m) { resolve({ path: normPath(Buffer.from(m[1], 'base64').toString('utf8')) }); return; }
        resolve({ canceled: true });
        return;
      }
      if (code === 0 && s) { resolve({ path: normPath(s.split(/\r?\n/)[0]) }); return; }
      resolve({ canceled: true });
    });
  });
  if (picking) picking.promise = promise;
  return promise;
}

export { FolderError };
