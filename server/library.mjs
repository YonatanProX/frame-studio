// Frame Studio — sound library index / search / categories / licenses, fonts list, LUT list (agent L)
// Mounted by server/main.mjs via `routes(ctx)`. Also exports resolveSound(q) for the `sfx` op.
//
// Sound folders (server/sound-folders.mjs): the library indexes ROOT/library/sounds (built-in, incl. the generated
// Starter Pack), <dataDir>/Sounds and every folder the user added — wherever it is. Nothing is moved, copied or written
// into those folders; they are only read. Index cache: <cacheDir>/index.json, full peaks: <cacheDir>/peaks/<id>.json —
// cacheDir() in sound-folders.mjs (developer layout: library/sounds/.index; installed: %LOCALAPPDATA%/Frame Studio/cache/
// sounds). The legacy library/sounds/index.json + .peaks are still read as a seed.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cfg from './config.mjs';
import {
  allSoundRoots, cacheDir, configureFolders, listSoundFolders, addSoundFolder, removeSoundFolder, pickFolder, isInside, pathKey, normPath,
  soundsDir as dataSoundsDir,
} from './sound-folders.mjs';

export { listSoundFolders, addSoundFolder, removeSoundFolder, pickFolder };

const { librarySources, ffmpegPath, ffprobePath, configStatus } = cfg;

// ───────────────────────────── configuration ─────────────────────────────

let ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aif', '.aiff']);
const INDEX_VERSION = 4;
const SEED_VERSIONS = new Set([3, 4]);   // older caches whose per-file scan results can be reused
const SCAN_RATE = 4000;          // Hz, mono s16le decode for peak scan
const PEAK_RATE = 100;           // peaks per second in the full-peaks cache
const WAVE_POINTS = 64;
const PARALLEL = 3;
const RECHECK_MS = 60_000;
const MAX_FILES_PER_FOLDER = 100_000;
const MUSIC_MIN_SEC = 45;        // files this long in a sound folder are music (Audio → music & voice-over)

const COLL_SFX = 'אפקטים קוליים';   // short sounds from every sound folder
const COLL_MUSIC = 'מוזיקה';         // long files from the sound folders + config.json → library.music
const COLLECTION_ORDER = [COLL_SFX, COLL_MUSIC];
export const STARTER_DIR = 'Starter Pack';
const STARTER_MANIFEST = 'starter-pack.json';

function soundsDir() { return path.join(ROOT, 'library', 'sounds'); }          // built-in folder
function peaksDir() { return path.join(cacheDir(), 'peaks'); }
function indexFile() { return path.join(cacheDir(), 'index.json'); }
function legacyIndexFile() { return path.join(soundsDir(), 'index.json'); }
function legacyPeaksDir() { return path.join(soundsDir(), '.peaks'); }
function sourcesFile() { return path.join(ROOT, 'library', 'sources.json'); }
function lutsDir() { return path.join(ROOT, 'library', 'luts'); }
function fontsDir() { return path.join(ROOT, 'library', 'fonts'); }
function licensesFile() { return path.join(ROOT, 'library', 'LICENSES.md'); }

let logFn = (...a) => { try { console.log('[library]', ...a); } catch { /* ignore */ } };

/** Override ROOT / dataDir (used by tests / tools). */
export function configure({ root, log, dataDir } = {}) {
  if (root) ROOT = path.resolve(root);
  if (log) logFn = log;
  configureFolders({ root: root || undefined, dataDir });
}

// ───────────────────────────── text helpers ─────────────────────────────

const NIQQUD_RE = /[\u0591-\u05C7]/g;
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

/** Lower-case, strip niqqud, unify final letters & punctuation → single spaces. */
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(NIQQUD_RE, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[׳״'"`]/g, '')
    .replace(/[_\-.,;:()[\]{}&+!?/\\|#~*=<>@%^$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isHebrew = (s) => /[\u05D0-\u05EA]/.test(s);

/** Variants of a query token: itself, Hebrew without common prefix letters / plural suffixes. */
function tokenVariants(tok) {
  const out = new Set([tok]);
  if (isHebrew(tok)) {
    let t = tok;
    // strip up to two prefix letters (ו ה ב ל מ ש כ) when the rest is still ≥ 2 letters
    for (let i = 0; i < 2; i++) {
      if (t.length > 3 && 'והבלמשכ'.includes(t[0])) { t = t.slice(1); out.add(t); } else break;
    }
    for (const v of [...out]) {
      if (v.length > 4 && (v.endsWith('ימ') || v.endsWith('ות'))) out.add(v.slice(0, -2));
      if (v.length > 3 && v.endsWith('ה')) out.add(v.slice(0, -1));
    }
  } else if (/^[a-z]+$/.test(tok)) {
    if (tok.length > 4 && tok.endsWith('es')) out.add(tok.slice(0, -2));
    if (tok.length > 3 && tok.endsWith('s')) out.add(tok.slice(0, -1));
    if (tok.length > 5 && tok.endsWith('ing')) out.add(tok.slice(0, -3));
  }
  return [...out];
}

// Hebrew ⇄ English synonym groups (normalized forms). Used both for query expansion and Hebrew tags.
const SYNONYM_GROUPS = [
  ['ווש', 'וווש', 'וושים', 'סוויש', 'whoosh', 'woosh', 'swoosh', 'swish', 'swsh', 'whsh', 'swing', 'sweep', 'zip'],
  ['בום', 'בומים', 'מכה', 'מכות', 'אימפקט', 'boom', 'impact', 'impt', 'hit', 'thud', 'slam', 'smash', 'thump', 'crash'],
  ['בראאאם', 'בראם', 'braam', 'bram', 'horn braam'],
  ['עולה', 'עולים', 'רייזר', 'riser', 'rise', 'swell', 'build', 'buildup', 'uplifter'],
  ['מתח', 'tension', 'suspense', 'drone', 'alarm', 'alarms', 'eerie', 'erie', 'sinister'],
  ['בס', 'בס נופל', 'נופל', 'דאונר', 'bass', 'drop', 'downer', 'sub'],
  ['דרופ', 'drop', 'braam', 'boom'],
  ['קליק', 'לחיצה', 'לחיצות', 'כפתור', 'click', 'button', 'tap', 'press'],
  ['ממשק', 'ui', 'interface', 'menu', 'notification', 'beep', 'blip', 'readout'],
  ['פופ', 'pop', 'bubble', 'pluck'],
  ['הודעה', 'התראה', 'notification', 'alert', 'ping', 'ding', 'chime'],
  ['אישור', 'accept', 'confirm', 'success', 'correct'],
  ['שגיאה', 'דחייה', 'deny', 'error', 'wrong', 'fail'],
  ['נייר', 'דף', 'paper', 'page', 'newspaper', 'papr'],
  ['שעון', 'תקתוק', 'clock', 'tick', 'ticking'],
  ['קהל', 'crowd', 'crwd', 'walla', 'audience'],
  ['מחיאות כפיים', 'תשואות', 'applause', 'cheer', 'clap'],
  ['גשם', 'rain'],
  ['רוח', 'wind', 'gust', 'breeze'],
  ['מים', 'water', 'watr', 'splash', 'liquid', 'wave', 'waves'],
  ['אש', 'fire', 'flame', 'campfire', 'burn'],
  ['פיצוץ', 'explosion', 'expl', 'blast', 'fireworks'],
  ['רעם', 'סערה', 'thunder', 'storm', 'lightning', 'thun'],
  ['ברד', 'hail'],
  ['קרח', 'ice', 'frozen'],
  ['זכוכית', 'glass', 'glas', 'shards', 'crystal'],
  ['מתכת', 'metal', 'metl'],
  ['עץ', 'wood'],
  ['אבן', 'rock', 'stone'],
  ['רכב', 'מכונית', 'רכבים', 'car', 'vehicle', 'veh', 'engine', 'drive'],
  ['אופנוע', 'motorcycle', 'moto', 'bike'],
  ['רכבת', 'train', 'tram', 'subway', 'trn'],
  ['מטוס', 'jet', 'aircraft', 'plane', 'aero'],
  ['צופר', 'horn', 'honk'],
  ['כלב', 'dog', 'bark'],
  ['חיה', 'חיות', 'animal', 'anml'],
  ['דינוזאור', 'dinosaur', 'dino', 'rept', 'reptile'],
  ['צחוק', 'laugh', 'laff'],
  ['בכי', 'cry'],
  ['קול', 'קולות', 'voice', 'vox', 'vocal'],
  ['גבר', 'male', 'man'],
  ['אישה', 'female', 'woman', 'fem'],
  ['נשימה', 'breath', 'brth', 'breathing'],
  ['קסם', 'magic', 'mag', 'magc', 'spell', 'sparkle'],
  ['גליץ', 'glitch', 'digital', 'static'],
  ['מדע בדיוני', 'scifi', 'sci fi', 'futuristic', 'space', 'laser', 'robot'],
  ['רובוט', 'robot', 'robt', 'servo'],
  ['חשמל', 'electric', 'elec', 'arc', 'zap', 'spark'],
  ['טלפון', 'telephone', 'phone', 'telph', 'ring'],
  ['מכונת כתיבה', 'typewriter', 'type'],
  ['רדיו', 'radio'],
  ['דלת', 'door'],
  ['צעדים', 'footsteps', 'steps', 'feet'],
  ['חרב', 'sword', 'blade', 'melee'],
  ['נשק', 'weapon', 'weap', 'gun', 'arrow', 'bow'],
  ['אגרוף', 'punch', 'fight', 'fght', 'combat', 'kick'],
  ['קרב', 'fight', 'fght', 'combat', 'battle'],
  ['קריקטורה', 'cartoon', 'toon', 'boing', 'funny', 'comedy'],
  ['אימה', 'horror', 'creepy', 'scary', 'haunting', 'haunted', 'ghost', 'ghostly', 'halloween'],
  ['רפאים', 'ghost', 'ghostly', 'spirit'],
  ['מפלצת', 'monster', 'creature', 'crea', 'undead', 'zombie'],
  ['חג המולד', 'christmas', 'xmas', 'cracker'],
  ['קזינו', 'casino', 'cards', 'chips', 'coins'],
  ['מטבע', 'מטבעות', 'coin', 'coins', 'ting'],
  ['מספרה', 'barbershop', 'scissors', 'razor'],
  ['ספר', 'ספרים', 'book', 'books'],
  ['בד', 'בגד', 'cloth', 'clth', 'fabric', 'tshirt'],
  ['פולי', 'foley', 'foly'],
  ['אווירה', 'ambience', 'ambient', 'amb', 'roomtone', 'atmosphere'],
  ['עיר', 'city', 'urban', 'traffic', 'traf', 'street'],
  ['טבע', 'nature', 'forest', 'birds', 'park', 'lake'],
  ['מכונה', 'machine', 'mach', 'mechanism', 'mech', 'motor'],
  ['מנעול', 'lock', 'latch', 'key'],
  ['משחק', 'game', 'board game', 'dice'],
  ['פעמון', 'bell', 'bells', 'church'],
  ['שריקה', 'whistle', 'whst'],
  ['מעבר', 'transition', 'whoosh', 'swoosh'],
  ['זום', 'zoom', 'whoosh', 'vacuum'],
  ['סיום', 'ending', 'outro', 'end', 'final'],
  ['פתיחה', 'intro', 'opening', 'start'],
  ['קונפטי', 'confetti', 'cofetti', 'celebration', 'party'],
  ['מוזיקה', 'שיר', 'music', 'song', 'track'],
  ['קריינות', 'voiceover', 'narration', 'vo'],
].map((g) => g.map(normalize));

const SYN_INDEX = new Map(); // normalized word → Set(group index)
SYNONYM_GROUPS.forEach((g, i) => g.forEach((w) => {
  if (!SYN_INDEX.has(w)) SYN_INDEX.set(w, new Set());
  SYN_INDEX.get(w).add(i);
}));

function synonymsOf(word) {
  const out = new Set();
  const gs = SYN_INDEX.get(word);
  if (gs) for (const gi of gs) for (const w of SYNONYM_GROUPS[gi]) if (w !== word) out.add(w);
  return [...out];
}

// ───────────────────────────── categorization ─────────────────────────────

// UCS CatID (top level) → Hebrew category
const UCS_CAT = {
  AERO: 'רכבים', AIR: 'שונות', ALRM: 'עולים ומתח', AMB: 'אווירה', ANML: 'חיות', ARCH: 'שונות',
  BEEP: 'ממשק ולחיצות', BELL: 'פולי', BIRD: 'חיות', BLLT: 'נשק וקרב', BOAT: 'רכבים', CART: 'קריקטורה',
  CERM: 'פולי', CHAN: 'פולי', CHEM: 'שונות', CLOCK: 'מכונות', CLOTH: 'פולי', COM: 'מכונות', COMP: 'ממשק ולחיצות',
  CREA: 'יצורים', CRWD: 'קהל', DEST: 'בומים ומכות', DIRT: 'טבע', DOOR: 'פולי', DRWR: 'פולי',
  DSGN: 'בומים ומכות', ELEC: 'מדע בדיוני', EQUI: 'פולי', EQUIP: 'פולי', EXPL: 'אש ופיצוצים', FART: 'קריקטורה',
  FEET: 'פולי', FGHT: 'נשק וקרב', FIRE: 'אש ופיצוצים', FIREWRK: 'אש ופיצוצים', FOLY: 'פולי', FOOD: 'פולי',
  GAME: 'משחקים', GEOT: 'טבע', GLAS: 'פולי', GORE: 'נשק וקרב', GUN: 'נשק וקרב', HAIL: 'טבע', HMN: 'קולות',
  HORN: 'רכבים', ICE: 'טבע', LASR: 'מדע בדיוני', LETH: 'פולי', LIQ: 'טבע', MACH: 'מכונות', MAG: 'קסם', MAGC: 'קסם',
  MECH: 'מכונות', METL: 'פולי', MOTR: 'רכבים', MOVE: 'פולי', MUSC: 'מוזיקלי', NATDIS: 'טבע', OBJ: 'פולי',
  PAPR: 'פולי', PLAS: 'פולי', RAIN: 'טבע', ROBO: 'מדע בדיוני', ROBT: 'מדע בדיוני', ROCK: 'טבע', ROOM: 'אווירה',
  ROPE: 'פולי', RUBR: 'פולי', SCI: 'מדע בדיוני', SCIF: 'מדע בדיוני', SNOW: 'טבע', SPRT: 'פולי', STORM: 'טבע',
  SWSH: 'וושים ומעברים', THUN: 'טבע', TOOL: 'פולי', TOON: 'קריקטורה', TOY: 'פולי', TRN: 'רכבים', UI: 'ממשק ולחיצות',
  VEH: 'רכבים', VOX: 'קולות', WATR: 'טבע', WEAP: 'נשק וקרב', WHSH: 'וושים ומעברים', WHST: 'קולות', WIND: 'טבע',
  WNDW: 'פולי', WOOD: 'פולי', WTHR: 'טבע', WING: 'חיות',
};
const UCS_CODES = Object.keys(UCS_CAT).sort((a, b) => b.length - a.length);
// UCS CatID full English names (for tags)
const UCS_NAME = {
  AERO: 'aircraft', AMB: 'ambience', ANML: 'animals', BELL: 'bells', CLOCK: 'clock', COM: 'communications', CREA: 'creature',
  CRWD: 'crowd', DSGN: 'designed', ELEC: 'electricity', EQUI: 'equipment', FGHT: 'fight', FIRE: 'fire', FOLY: 'foley',
  GAME: 'game', GLAS: 'glass', GORE: 'gore', HAIL: 'hail', HMN: 'human', ICE: 'ice', MACH: 'machine', MAG: 'magic',
  MECH: 'mechanical', METL: 'metal', MOVE: 'movement', MUSC: 'musical', OBJ: 'object', PAPR: 'paper', RAIN: 'rain',
  ROBT: 'robot', STORM: 'storm', SWSH: 'swoosh', THUN: 'thunder', TOON: 'cartoon', TRN: 'train', UI: 'interface',
  VEH: 'vehicle', VOX: 'voice', WATR: 'water', WEAP: 'weapon', WHST: 'whistle', WIND: 'wind', WOOD: 'wood',
};
// DSGN subcategory → Hebrew category (designed sounds are split by intent)
const DSGN_SUB = {
  bass: 'בס נופל', drop: 'בס נופל', down: 'בס נופל', bram: 'בומים ומכות', braam: 'בומים ומכות', impt: 'בומים ומכות',
  boom: 'בומים ומכות', hit: 'בומים ומכות', rise: 'עולים ומתח', riser: 'עולים ומתח', tens: 'עולים ומתח', erie: 'אימה',
  horr: 'אימה', swsh: 'וושים ומעברים', whsh: 'וושים ומעברים', trans: 'וושים ומעברים', tonl: 'מוזיקלי', synth: 'מוזיקלי',
  stngr: 'מוזיקלי', misc: 'שונות', mvmt: 'וושים ומעברים', airy: 'וושים ומעברים',
};
// keyword rules for non-UCS names (first match wins, matched on normalized "name + pack")
const KEYWORD_RULES = [
  [/\b(bass drop|downer|bass down)\b/, 'בס נופל'],
  [/\b(riser|rise|swell|suspense|alarms?|tension)\b/, 'עולים ומתח'],
  [/\b(braam|booms?|impacts?|hit|thud|slam|punch)\b/, 'בומים ומכות'],
  [/\b(whoosh|woosh|swoosh|swish|transition|sweep|zoom)\b/, 'וושים ומעברים'],
  [/\b(interface|ui|button|readout|accept|deny|ping|notification|menu|arp)\b/, 'ממשק ולחיצות'],
  [/\b(cartoon|toon|boing|bloopers?|dizzy|elf)\b/, 'קריקטורה'],
  [/\b(magic|spell|astral|evil presence)\b/, 'קסם'],
  [/\b(horror|haunt\w*|ghost\w*|creepy|halloween|sinister)\b/, 'אימה'],
  [/\b(ice|campfire|camp fire|storm|rain|wind|thunder|water|fire)\b/, 'טבע'],
  [/\b(fireworks|explosion)\b/, 'אש ופיצוצים'],
  [/\b(walla|crowd|cheer\w*|applause)\b/, 'קהל'],
  [/\b(church bells|bells?)\b/, 'פולי'],
  [/\b(wire cars|car|train|vehicle|motorcycle)\b/, 'רכבים'],
  [/\b(paper|page|newspaper|encyclopedia|coin|coins|confetti|cofetti)\b/, 'פולי'],
  [/\b(sci fi|scifi|drones?|space ship|robot|glitch\w*)\b/, 'מדע בדיוני'],
  [/\b(game)\b/, 'משחקים'],
  [/\b(flip flops?|footsteps?|shoes?|sandals?)\b/, 'פולי'],
  [/\b(volleyball|stadium|league|match)\b/, 'קהל'],
  [/\b(radio|tuner)\b/, 'מכונות'],
  [/\b(monster|creature|tentacle)\b/, 'יצורים'],
];
// English keyword → Hebrew tag (for Hebrew search over English names)
const HEB_TAGS = [];
for (const g of SYNONYM_GROUPS) {
  const he = g.filter(isHebrew);
  const en = g.filter((w) => !isHebrew(w));
  if (he.length) for (const w of en) HEB_TAGS.push([w, he]);
}

/// Generic "role in the video" for sound effects (derived from the category / file name, first match wins).
// gainDb / len = a conservative starting level and length for a sound under a voice-over (the user can change both).
const ROLE_RULES = [
  { role: 'בראאאם', re: /\b(braam|bram)\b/, gainDb: -10, len: 3.5 },
  { role: 'גליץ׳', re: /\bglitch\w*\b/, gainDb: -14, len: 1 },
  { role: 'עולה', re: /\b(riser|rise|rising|swell|build ?up|uplifter)\b/, gainDb: -14, len: 2.5 },
  { role: 'זום', re: /\b(zoom|vacuum)\b/, gainDb: -14, len: 0.6 },
  { role: 'בס נופל', cats: ['בס נופל'], gainDb: -12, len: 2.5 },
  { role: 'מכה', cats: ['בומים ומכות'], gainDb: -10, len: 2.5 },
  { role: 'מעבר', cats: ['וושים ומעברים'], gainDb: -14, len: 1.2 },
  { role: 'מתח', cats: ['עולים ומתח', 'אימה'], gainDb: -20, len: 3.5 },
  { role: 'לחיצה', cats: ['ממשק ולחיצות'], gainDb: -16, len: 0.6 },
];
export const ROLE_LIST = ['מכה', 'בראאאם', 'בס נופל', 'מעבר', 'זום', 'עולה', 'מתח', 'גליץ׳', 'לחיצה'];

/** → { role, suggest:{gainDb,len} } | null (sound-effect collection only) */
function roleFor(category, base, pack) {
  const hay = normalize(`${splitCamel(base)} ${pack || ''}`);
  for (const r of ROLE_RULES) {
    if ((r.re && r.re.test(hay)) || (r.cats && r.cats.includes(category))) return { role: r.role, suggest: { gainDb: r.gainDb, len: r.len } };
  }
  return null;
}

/** Parse a UCS-style file name: CatIDSub_FXName_Creator_Source → {code, sub, title} */
function parseUcs(base) {
  const m = /^([A-Z]{2,7})([A-Z][a-z]+|[a-z]+)?(?=[_ ]|$)/.exec(base);
  if (!m) return null;
  const head = m[1];
  let code = null;
  for (const c of UCS_CODES) {
    if (head.startsWith(c) && (head.length === c.length || head.length - c.length <= 1)) { code = c; break; }
  }
  if (!code) {
    // "CLOCKTick" style: full head is a code
    if (UCS_CAT[head]) code = head;
  }
  if (!code) return null;
  const sub = ((head.length > code.length ? head.slice(code.length) : '') + (m[2] || '')).trim();
  let rest = base.slice(m[0].length).replace(/^[_ ]+/, '');
  // FXName is before the next underscore (creator/source follow)
  const parts = rest.split('_').map((s) => s.trim()).filter(Boolean);
  const title = parts.length ? parts[0] : rest;
  return { code, sub, ucs: code + sub, title, extra: parts.slice(1).join(' ') };
}

function splitCamel(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z]{2,})(\d)/g, '$1 $2');
}

function cleanTitle(base, pack = '') {
  const u = parseUcs(base);
  let t = u ? u.title : base;
  if (!u) {
    // drop leading track numbers like "24 Campfire, …" only if followed by letters
    t = t.replace(/^\d{1,3}\s+(?=[A-Za-z\u05D0-\u05EA])/, '');
    t = splitCamel(t.replace(/_+/g, ' '));
  }
  t = t.replace(/_+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // code-only names ("NIG065", "FFG 002") → descriptive pack name + number
  const code = /^([A-Za-z]{2,5})\s?(\d{1,4})$/.exec(t);
  if (code && pack) {
    const tail = pack.includes(' - ') ? pack.slice(pack.indexOf(' - ') + 3) : pack;
    t = `${tail} ${code[2]}`;
  }
  return t || base;
}

function categoryFor({ collection, base, pack, ucs }) {
  if (collection === COLL_MUSIC) return /קריינות|voice|vo\b/i.test(`${base} ${pack || ''}`) ? 'קריינות' : 'מוזיקה';
  if (ucs) {
    if (ucs.code === 'DSGN') {
      const sub = ucs.sub.toLowerCase();
      for (const k of Object.keys(DSGN_SUB)) if (sub.startsWith(k) && DSGN_SUB[k] !== 'שונות') return DSGN_SUB[k];
      const hay = normalize(base + ' ' + pack);
      for (const [re, cat] of KEYWORD_RULES) if (re.test(hay)) return cat;
      return 'בומים ומכות';
    }
    if (ucs.code === 'FGHT' && /impt|hit/i.test(ucs.sub)) return 'נשק וקרב';
    if (ucs.code === 'VOX' || ucs.code === 'HMN') return 'קולות';
    return UCS_CAT[ucs.code] || 'שונות';
  }
  const hay = normalize(base + ' ' + pack);
  for (const [re, cat] of KEYWORD_RULES) if (re.test(hay)) return cat;
  if (/walla/i.test(pack)) return 'קהל';
  return 'שונות';
}

function buildTags(entry, base) {
  const words = new Set();
  const add = (s) => { for (const w of normalize(s).split(' ')) if (w && w.length > 1 && !/^\d+$/.test(w)) words.add(w); };
  add(splitCamel(base.replace(/_/g, ' ')));
  add(entry.pack);
  add(entry.category);
  if (entry.ucs) { add(entry.ucs); add(splitCamel(entry.ucs)); }
  const u = parseUcs(base);
  if (u && UCS_NAME[u.code]) add(UCS_NAME[u.code]);
  if (entry.role) add(entry.role);
  // Hebrew tags from English words
  const en = [...words];
  for (const [w, he] of HEB_TAGS) {
    if (w.includes(' ')) { if (normalize(base + ' ' + entry.pack).includes(w)) he.forEach((h) => words.add(h)); }
    else if (en.includes(w)) he.forEach((h) => words.add(h));
  }
  const STOP = new Set(['the', 'and', 'of', 'audio', 'vol', 'wav', 'esm', 'with', 'in', 'on', 'to', 'by', 'for', 'a', 'an', 'sndbts', 'jf', 'int']);
  return [...words].filter((w) => !STOP.has(w)).slice(0, 60);
}

// ───────────────────────────── file walking ─────────────────────────────

/**
 * Collect audio files under `dir` (any depth ≤ 12). Hidden folders/files (".peaks", ".cache") are skipped.
 * A linked folder (symlink / junction) is followed unless it points into another indexed folder (no double index)
 * or back into a folder already visited (no loops).
 */
async function walk(dir, out = [], depth = 0, opt = {}) {
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    if (out.length >= MAX_FILES_PER_FOLDER) { if (!opt.capped) { opt.capped = true; logFn(`more than ${MAX_FILES_PER_FOLDER} sounds under ${dir} — the rest is skipped`); } return out; }
    const abs = path.join(dir, it.name);
    let isDir = it.isDirectory();
    if (it.isSymbolicLink()) {
      isDir = await fsp.stat(abs).then((st) => st.isDirectory(), () => false);
      if (isDir) {
        const real = await fsp.realpath(abs).catch(() => null);
        if (!real) continue;
        if ((opt.skipRoots || []).some((r) => isInside(real, r))) continue;
        opt.seen = opt.seen || new Set();
        if (opt.seen.has(pathKey(real))) continue;
        opt.seen.add(pathKey(real));
      } else if (!AUDIO_EXT.has(path.extname(it.name).toLowerCase())) continue;
      else { out.push(abs); continue; }
    }
    if (isDir) { if (depth < 12) await walk(abs, out, depth + 1, opt); }
    else if (it.isFile() && AUDIO_EXT.has(path.extname(it.name).toLowerCase())) out.push(abs);
  }
  return out;
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Extra music / voice folders from config.json → "library": {"music":[…]} (legacy: library/sources.json).
 * Folders that do not exist are simply skipped by the walk.
 */
async function readSources() {
  try { return librarySources({ legacyFile: sourcesFile() }); } catch { return { music: [] }; }
}

/** License of a sound by its folder names: Mixkit / Sonniss folders, anything else = "other" (check it yourself). */
function licenseOf(rel) {
  if (/mixkit|מיקסקיט/i.test(rel)) return 'mixkit';
  if (/sonniss|סוניס|gameaudiogdc/i.test(rel)) return 'sonniss';
  return 'other';
}

/**
 * Pack (the folder a sound came in): the folder right below a "…Sonniss…" folder (a GDC bundle keeps one folder
 * per publisher pack), otherwise the folder that holds the file ('' for files directly in library/sounds).
 */
function packOf(segs) {
  const dirs = segs.slice(0, -1);
  const s = dirs.findIndex((d) => /sonniss|gameaudiogdc/i.test(d));
  if (s >= 0 && s + 1 < dirs.length) return dirs[s + 1];
  return dirs.length ? dirs[dirs.length - 1] : '';
}

/** Starter Pack manifest (written by tools/make-starter-sounds.mjs) → Map(fileName → meta). Cached per folder+mtime. */
const manifestCache = new Map();
function starterMeta(dir) {
  const file = path.join(dir, STARTER_MANIFEST);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = manifestCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs) return c.map;
  let map = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    map = new Map((j.sounds || []).map((s) => [String(s.file).toLowerCase(), s]));
  } catch { map = null; }
  manifestCache.set(file, { mtimeMs: st.mtimeMs, map });
  return map;
}
function attachStarter(f) {
  const dir = path.dirname(f.abs);
  if (path.basename(dir) !== STARTER_DIR) return f;
  const map = starterMeta(dir);
  const meta = map && map.get(path.basename(f.abs).toLowerCase());
  if (!meta) return f;
  return { ...f, license: 'starter', pack: STARTER_DIR, starter: meta };
}

/**
 * List every audio file of every sound folder with its static metadata (no decoding).
 * → files[] with files.offline = [root paths that are configured but not reachable right now (unplugged drive…)]
 */
async function listFiles() {
  const files = [];
  const seen = new Set();             // pathKey(abs) — a file is indexed once even if two folders overlap
  const offline = [];
  const roots = allSoundRoots();
  const push = (f) => { const k = pathKey(f.abs); if (seen.has(k)) return; seen.add(k); files.push(attachStarter(f)); };
  for (const root of roots) {
    if (!root.exists) { if (root.kind === 'user') offline.push(root.path); continue; }
    const base = path.resolve(root.path);
    const skipRoots = roots.filter((r) => r !== root && !isInside(r.path, root.path)).map((r) => r.path);
    for (const abs of await walk(base, [], 0, { skipRoots })) {
      const rel = toPosix(path.relative(base, abs));
      if (root.kind === 'builtin') {
        // built-in folder: ids/paths stay relative to library/sounds (stable across moves of the app folder)
        push({ abs, file: rel, collection: COLL_SFX, pack: packOf(rel.split('/')), license: licenseOf(rel), source: 'sounds', root: root.path });
      } else {
        const segs = [path.basename(base), ...rel.split('/')];
        push({ abs, file: toPosix(abs), collection: COLL_SFX, pack: packOf(segs), license: licenseOf(segs.join('/')), source: 'folder', root: root.path });
      }
    }
  }
  const src = await readSources();
  for (const dir of src.music || []) {
    const d = path.resolve(dir);
    for (const abs of await walk(d)) {
      const rel = toPosix(path.relative(d, abs));
      const segs = rel.split('/');
      push({ abs, file: toPosix(abs), collection: COLL_MUSIC, pack: segs.length > 1 ? segs[0] : path.basename(d), license: 'own', source: 'music', root: normPath(d) });
    }
  }
  await Promise.all(files.map(async (f) => {
    try { const st = await fsp.stat(f.abs); f.size = st.size; f.mtimeMs = Math.round(st.mtimeMs); } catch { f.size = 0; f.mtimeMs = 0; }
  }));
  files.offline = offline;
  return files;
}

function signatureOf(files) {
  const h = crypto.createHash('sha1');
  h.update(String(INDEX_VERSION));
  for (const f of [...files].sort((a, b) => (a.file < b.file ? -1 : 1))) h.update(`${f.file}|${f.size}|${f.mtimeMs}|${f.starter ? f.starter.id || 1 : ''}\n`);
  for (const o of files.offline || []) h.update(`offline|${pathKey(o)}\n`);
  return h.digest('hex');
}

const idFor = (relOrAbs) => crypto.createHash('sha1').update(relOrAbs).digest('hex').slice(0, 12);

// ───────────────────────────── decoding / peaks ─────────────────────────────

function parseFfmpegInfo(stderr) {
  const info = {};
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
  const a = /Stream #\d+:\d+[^:]*: Audio: [^,]+, (\d+) Hz, ([^,\n]+)/.exec(stderr);
  if (a) {
    info.sampleRate = +a[1];
    const lay = a[2].trim().toLowerCase();
    const LAYOUTS = { mono: 1, stereo: 2, '2.1': 3, '3.0': 3, quad: 4, '4.0': 4, '4.1': 5, '5.0': 5, '5.0(side)': 5, '5.1': 6, '5.1(side)': 6, '6.0': 6, '6.1': 7, '7.0': 7, '7.1': 8, hexagonal: 6, octagonal: 8 };
    const n = /(\d+)\s*channels/.exec(lay);
    info.channels = n ? +n[1] : (LAYOUTS[lay] || LAYOUTS[lay.replace(/\s.*$/, '')] || null);
  }
  return info;
}

function ffprobeInfo(abs) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(ffprobePath(), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate,duration:format=duration', '-of', 'json', abs], { windowsHide: true });
    p.stdout.on('data', (b) => { out += b; });
    p.on('error', () => resolve({}));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const s = (j.streams || [])[0] || {};
        resolve({ channels: s.channels || null, sampleRate: s.sample_rate ? +s.sample_rate : null, duration: parseFloat(s.duration || (j.format || {}).duration) || null });
      } catch { resolve({}); }
    });
  });
}

/** Decode a file to 4 kHz mono s16 and compute peakDb, a 64-point wave and 100/s peaks. */
function scanFile(abs) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-nostdin', '-i', abs, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(SCAN_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', '-'];
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const per = Math.round(SCAN_RATE / PEAK_RATE); // samples per peak bucket
    const peaks = [];
    let bucketMax = 0, bucketN = 0, maxAbs = 0, total = 0;
    let carry = null;
    let stderr = '';
    p.stdout.on('data', (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const n = buf.length >> 1;
      if (buf.length & 1) carry = buf.subarray(buf.length - 1);
      for (let i = 0; i < n; i++) {
        let v = buf.readInt16LE(i << 1);
        if (v < 0) v = -v;
        if (v > bucketMax) bucketMax = v;
        if (++bucketN === per) { peaks.push(bucketMax / 32768); if (bucketMax > maxAbs) maxAbs = bucketMax; bucketMax = 0; bucketN = 0; }
      }
      total += n;
    });
    p.stderr.on('data', (b) => { if (stderr.length < 20000) stderr += b; });
    p.on('error', (e) => resolve({ error: String(e && e.message || e) }));
    p.on('close', (code) => {
      if (bucketN > 0) { peaks.push(bucketMax / 32768); if (bucketMax > maxAbs) maxAbs = bucketMax; }
      if (code !== 0 && total === 0) { resolve({ error: (stderr.split('\n').filter(Boolean).pop() || 'ffmpeg failed').slice(0, 300) }); return; }
      const info = parseFfmpegInfo(stderr);
      const duration = total / SCAN_RATE;
      const peak = maxAbs / 32768;
      const peakDb = peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -120;
      const wave = new Array(WAVE_POINTS).fill(0);
      if (peaks.length) {
        for (let i = 0; i < WAVE_POINTS; i++) {
          const a = Math.floor(i * peaks.length / WAVE_POINTS);
          const b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / WAVE_POINTS));
          let m = 0;
          for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j];
          wave[i] = peak > 0 ? Math.round((m / peak) * 1000) / 1000 : 0;
        }
      }
      resolve({ duration: info.duration && Math.abs(info.duration - duration) < 1 ? info.duration : duration, sampleRate: info.sampleRate || null, channels: info.channels || null, peakDb, wave, peaks });
    });
  });
}

async function writePeaks(id, duration, peaks) {
  try {
    await fsp.mkdir(peaksDir(), { recursive: true });
    const tmp = path.join(peaksDir(), `${id}.json.tmp`);
    await fsp.writeFile(tmp, JSON.stringify({ rate: PEAK_RATE, duration, peaks: peaks.map((v) => Math.round(v * 1000) / 1000) }));
    await fsp.rename(tmp, path.join(peaksDir(), `${id}.json`));
  } catch (e) { logFn('peaks write failed', id, e.message); }
}

// ───────────────────────────── index state ─────────────────────────────

const lib = {
  entries: new Map(),     // id → entry
  byFile: new Map(),      // file → entry
  ready: false,           // a usable index exists (maybe partial while building)
  building: null,         // Promise while (re)building
  pending: false,         // another rebuild was requested while one was running
  progress: { done: 0, total: 0, todo: 0 },
  builtAt: null,
  signature: null,
  lastCheck: 0,
  lastBuildMs: 0,
  errors: [],
  offline: [],            // configured folders that are not reachable right now
  loadPromise: null,
};

const ROLE_SUGGEST = new Map(ROLE_RULES.map((r) => [r.role, { gainDb: r.gainDb, len: r.len }]));

function makeEntry(f, scan) {
  const base = path.basename(f.file).replace(/\.[^.]+$/, '');
  const duration = scan.duration != null ? Math.round(scan.duration * 1000) / 1000 : 0;
  // a long file in a sound folder is music (a song / a music bed), unless it is clearly a sound effect
  // (UCS-named, or from a Sonniss / Mixkit pack — long ambiences stay sound effects)
  let collection = f.collection, license = f.license;
  const ucs0 = collection === COLL_MUSIC ? null : parseUcs(base);
  if (f.source === 'folder' && !f.starter && duration > MUSIC_MIN_SEC && !ucs0 && license !== 'sonniss' && license !== 'mixkit') {
    collection = COLL_MUSIC;
    license = 'own';
  }
  const u = collection === COLL_MUSIC ? null : ucs0;
  const st = f.starter || null;
  const e = {
    id: idFor(f.file),
    name: st ? `${st.he} · ${st.en}` : cleanTitle(base, f.pack),
    file: f.file,
    abs: f.abs,
    collection,
    pack: f.pack,
    category: st && st.category ? st.category : categoryFor({ collection, base, pack: f.pack, ucs: u }),
    ucs: u ? u.ucs : null,
    tags: [],
    duration,
    channels: scan.channels || null,
    sampleRate: scan.sampleRate || null,
    peakDb: scan.peakDb != null ? scan.peakDb : null,
    wave: scan.wave || [],
    license,
    size: f.size,
    mtimeMs: f.mtimeMs,
  };
  if (f.root) e.folder = f.root;
  if (st) {
    if (st.role && ROLE_SUGGEST.has(st.role)) { e.role = st.role; e.suggest = { ...ROLE_SUGGEST.get(st.role), ...(st.suggest || {}) }; }
  } else {
    const role = collection === COLL_SFX ? roleFor(e.category, base, f.pack) : null;
    if (role) { e.role = role.role; e.suggest = role.suggest; }
  }
  if (scan.error) e.error = scan.error;
  e.tags = buildTags(e, base);
  if (st && Array.isArray(st.tags)) {
    for (const t of st.tags) for (const w of normalize(t).split(' ')) if (w.length > 1 && !e.tags.includes(w)) e.tags.push(w);
  }
  return e;
}

function prepareSearch(e) {
  const f = (s) => normalize(s);
  Object.defineProperty(e, '_s', {
    enumerable: false, configurable: true, writable: true,
    value: {
      name: f(e.name), nameWords: f(e.name).split(' '),
      // the whole name and each half of a bilingual "עברית · English" name — an exact query always ranks first
      exact: [...new Set([f(e.name), ...String(e.name || '').split(/\s+[·•|]\s+|\s+[—–]\s+/).map(f)].filter(Boolean))],
      tags: e.tags.map(f),
      cat: f(e.category), catWords: f(e.category).split(' '),
      pack: f(e.pack), packWords: f(e.pack).split(' '),
      role: f(e.role || ''),
      ucs: f(e.ucs || ''),
      file: f(e.file),
    },
  });
  return e;
}

function setEntries(list) {
  lib.entries = new Map();
  lib.byFile = new Map();
  for (const e of list) addEntry(e);
}
function addEntry(e) {
  prepareSearch(e);
  lib.entries.set(e.id, e);
  lib.byFile.set(e.file, e);
}
/** Entries that can be used right now (not in an unplugged folder). */
function* liveEntries() { for (const e of lib.entries.values()) if (!e.offline) yield e; }

// A save in the middle of a build is marked partial and unsigned: if the app is closed before the build ends, the next
// start must not trust it as complete (it resumes instead — every scanned file is reused, only the rest is decoded).
async function saveIndex({ partial = false } = {}) {
  const list = [...lib.entries.values()].map((e) => { const { abs, ...rest } = e; return rest; });
  const data = { version: INDEX_VERSION, builtAt: lib.builtAt || new Date().toISOString(), signature: partial ? null : lib.signature, ms: lib.lastBuildMs, count: list.length, entries: list };
  if (partial) data.partial = true;
  try {
    await fsp.mkdir(path.dirname(indexFile()), { recursive: true });
    const tmp = `${indexFile()}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, indexFile());
  } catch (e) { logFn('index save failed', e.message); }
}

/** The cached index, or (first run after an update) the legacy library/sounds/index.json as a seed. */
async function readIndexFile() {
  for (const file of [indexFile(), legacyIndexFile()]) {
    try {
      const j = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!j || !Array.isArray(j.entries)) continue;
      if (j.version === INDEX_VERSION && file === indexFile()) return j;
      if (SEED_VERSIONS.has(j.version)) return { ...j, signature: null, seed: true };   // reuse scans, never trust as-is
    } catch { /* none */ }
  }
  return null;
}

function absFor(entryLike, filesByRel) {
  const f = filesByRel.get(entryLike.file);
  if (f) return f.abs;
  if (/^[a-zA-Z]:\//.test(entryLike.file) || entryLike.file.startsWith('/')) return path.resolve(entryLike.file);
  return path.join(soundsDir(), ...entryLike.file.split('/'));
}

/** Old entries of folders that are configured but unplugged: kept (marked offline) so nothing is rescanned on return. */
function offlineCarry(old, files) {
  if (!old || !(files.offline || []).length) return [];
  const out = [];
  for (const o of old.entries) {
    if (!/^[a-zA-Z]:\/|^\//.test(o.file)) continue;
    if (!files.offline.some((r) => isInside(o.file, r))) continue;
    out.push({ ...o, abs: path.resolve(o.file), offline: true });
  }
  return out;
}

/** Build or refresh the index. Unchanged files are reused, changed/new ones are decoded (parallel 3). */
async function build({ force = false } = {}) {
  const t0 = Date.now();
  const files = await listFiles();
  const sig = signatureOf(files);
  const filesByRel = new Map(files.map((f) => [f.file, f]));
  const old = force ? null : await readIndexFile();
  const oldByFile = new Map();
  if (old) for (const e of old.entries) oldByFile.set(e.file, e);

  const keep = [];
  const todo = [];
  for (const f of files) {
    const o = oldByFile.get(f.file);
    if (o && o.size === f.size && o.mtimeMs === f.mtimeMs && !o.error && !o.offline) {
      // re-derive metadata (cheap) so category/role rule changes apply without decoding again
      keep.push(makeEntry(f, o));
    } else if (o && o.offline && o.size === f.size && o.mtimeMs === f.mtimeMs) {
      keep.push(makeEntry(f, o));          // a folder that was unplugged is back
    } else todo.push(f);
  }
  const carried = offlineCarry(old, files);
  setEntries([...keep, ...carried]);
  lib.offline = files.offline || [];
  lib.errors = [];
  lib.ready = lib.ready || keep.length > 0 || todo.length === 0;
  lib.progress = { done: keep.length, total: files.length, todo: todo.length };
  lib.signature = sig;
  if (todo.length) logFn(`indexing ${todo.length} file(s) (${keep.length} cached)`);
  if (carried.length) logFn(`${carried.length} sound(s) kept from ${lib.offline.length} unplugged folder(s)`);

  let i = 0, sinceSave = 0;
  const worker = async () => {
    while (i < todo.length) {
      const f = todo[i++];
      let scan = await scanFile(f.abs);
      if (!scan.error && (!scan.channels || !scan.sampleRate)) {
        const pr = await ffprobeInfo(f.abs);
        scan = { ...scan, channels: scan.channels || pr.channels, sampleRate: scan.sampleRate || pr.sampleRate };
      }
      const e = makeEntry(f, scan);
      if (scan.peaks && !scan.error) await writePeaks(e.id, e.duration, scan.peaks);
      if (scan.error) lib.errors.push({ file: f.file, error: scan.error });
      addEntry(e);
      lib.progress.done++;
      lib.ready = true;
      if (++sinceSave >= 60) { sinceSave = 0; lib.lastBuildMs = Date.now() - t0; await saveIndex({ partial: true }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(1, todo.length)) }, worker));
  lib.ready = true;
  lib.builtAt = new Date().toISOString();
  lib.lastBuildMs = Date.now() - t0;
  lib.lastCheck = Date.now();
  // absolute paths can change if ROOT moved; refresh them from the walk
  for (const e of lib.entries.values()) if (!e.offline) e.abs = absFor(e, filesByRel);
  if (todo.length || !old || old.seed || old.partial || old.signature !== sig || old.count !== lib.entries.size) await saveIndex();
  logFn(`index ready: ${lib.entries.size} sounds in ${lib.lastBuildMs} ms`);
  return lib;
}

/** Start a (re)build now, or right after the running one (folder added / removed while indexing). */
function startBuild() {
  if (lib.building) { lib.pending = true; return lib.building; }
  lib.building = (async () => {
    try {
      do { lib.pending = false; await build({ force: false }); } while (lib.pending);
    } finally { lib.building = null; }
    return lib;
  })();
  return lib.building;
}

/** Ensure an index is loaded. Fast path: cached index.json with a matching signature. */
export function ensureIndex({ rebuild = false } = {}) {
  if (rebuild) return startBuild();
  if (lib.ready && !lib.building) {
    if (Date.now() - lib.lastCheck > RECHECK_MS) {
      lib.lastCheck = Date.now();
      // background freshness check (never blocks a request): new files, removed files, a drive plugged back in
      listFiles().then((files) => {
        if (signatureOf(files) !== lib.signature && !lib.building) startBuild();
      }).catch(() => {});
    }
    return Promise.resolve(lib);
  }
  if (lib.building) return lib.building;
  if (!lib.loadPromise) {
    lib.loadPromise = (async () => {
      const t0 = Date.now();
      const [files, old] = await Promise.all([listFiles(), readIndexFile()]);
      const sig = signatureOf(files);
      // trust the cache only when it is complete: not a mid-build save, same signature, and every file on disk has an
      // entry (also heals an index that an older version saved half-way with the full signature)
      const oldFiles = old && !old.partial && old.signature === sig ? new Set(old.entries.map((o) => o.file)) : null;
      if (oldFiles && files.every((f) => oldFiles.has(f.file))) {
        const filesByRel = new Map(files.map((f) => [f.file, f]));
        setEntries(old.entries.map((o) => {
          const f = filesByRel.get(o.file);
          if (f) return makeEntry(f, o);
          if (o.offline) return { ...o, abs: path.resolve(o.file) };
          return makeEntry({ ...o, abs: absFor(o, filesByRel) }, o);
        }));
        lib.signature = sig;
        lib.offline = files.offline || [];
        lib.ready = true;
        lib.builtAt = old.builtAt;
        lib.lastBuildMs = old.ms || 0;
        lib.lastCheck = Date.now();
        lib.progress = { done: lib.entries.size, total: lib.entries.size, todo: 0 };
        logFn(`index loaded from cache: ${lib.entries.size} sounds (${Date.now() - t0} ms)`);
        return lib;
      }
      if (old && (old.partial || old.signature === sig)) logFn(`index incomplete (${old.entries.length} of ${files.length} sounds) — resuming`);
      return startBuild();
    })().finally(() => { lib.loadPromise = null; });
  }
  return lib.loadPromise;
}

/** Resolves when the index is usable (partial results are fine) or fully built (waitFull). */
async function usable({ waitFull = false, timeoutMs = 4000 } = {}) {
  const p = ensureIndex();
  if (waitFull) { await p; while (lib.building) await lib.building; return lib; }
  if (lib.ready) return lib;
  await Promise.race([p, new Promise((r) => setTimeout(r, timeoutMs))]);
  return lib;
}

export function indexStatus() {
  let count = 0, starter = 0, offline = 0;
  for (const e of lib.entries.values()) { if (e.offline) offline++; else { count++; if (e.license === 'starter') starter++; } }
  return {
    ready: lib.ready, indexing: !!lib.building, done: lib.progress.done, total: lib.progress.total,
    count, starter, offline, offlineFolders: lib.offline.slice(), builtAt: lib.builtAt, ms: lib.lastBuildMs, errors: lib.errors.slice(-20),
    starterPack: starterState.status,
  };
}

// ───────────────────────────── search ─────────────────────────────

function scoreField(variants, words, full, weight) {
  let best = 0;
  for (const { v, w: vw } of variants) {
    let s = 0;
    if (words.includes(v)) s = 3;
    else if (v.length >= 2 && words.some((x) => x.startsWith(v))) s = 2;
    else if (v.length >= 3 && full.includes(v)) s = 1.2;
    else if (v.includes(' ') && full.includes(v)) s = 3;
    s *= weight * vw;
    if (s > best) best = s;
  }
  return best;
}

function scoreEntry(e, tokens) {
  const S = e._s;
  let total = 0, matched = 0;
  for (const variants of tokens) {
    const t =
      Math.max(
        scoreField(variants, S.nameWords, S.name, 5),
        scoreField(variants, S.tags, S.tags.join(' '), 3),
        scoreField(variants, S.catWords, S.cat, 4),
        scoreField(variants, S.packWords, S.pack, 2),
        scoreField(variants, S.role ? S.role.split(' ') : [], S.role, 6),
        scoreField(variants, S.ucs ? [S.ucs] : [], S.ucs, 3),
        scoreField(variants, [], S.file, 0.8),
      );
    if (t > 0) { matched++; total += t; }
  }
  return { total, matched };
}

function buildTokens(q) {
  const nq = normalize(q);
  if (!nq) return [];
  const raw = nq.split(' ').filter(Boolean);
  // multi-word synonym phrases ("בס נופל", "מחיאות כפיים", "sci fi") are kept as one token when present
  const tokens = [];
  for (let i = 0; i < raw.length; i++) {
    const two = i + 1 < raw.length ? raw[i] + ' ' + raw[i + 1] : null;
    if (two && SYN_INDEX.has(two)) { tokens.push(two); i++; } else tokens.push(raw[i]);
  }
  return tokens.map((tok) => {
    const vs = new Map();
    for (const v of tokenVariants(tok)) {
      if (!vs.has(v)) vs.set(v, v === tok ? 1 : 0.9);
      for (const s of synonymsOf(v)) if (!vs.has(s)) vs.set(s, 0.7);
    }
    return [...vs].map(([v, w]) => ({ v, w }));
  });
}

function collRank(c) { const i = COLLECTION_ORDER.indexOf(c); return i < 0 ? 9 : i; }

/**
 * Search the library.
 * @param {{q?:string, category?:string, collection?:string, pack?:string, role?:string, min?:number, max?:number,
 *          limit?:number, offset?:number, sort?:"relevance"|"name"|"duration"|"-duration"}} opts
 * @returns {{ total:number, offset:number, limit:number, items:object[] }}
 */
export function searchSounds(opts = {}) {
  const q = String(opts.q || '').trim();
  const min = opts.min != null && opts.min !== '' ? +opts.min : null;
  const max = opts.max != null && opts.max !== '' ? +opts.max : null;
  const limit = Math.max(1, Math.min(2000, +opts.limit || 200));
  const offset = Math.max(0, +opts.offset || 0);
  const ncat = opts.category ? normalize(opts.category) : null;
  let list = [];
  for (const e of liveEntries()) {
    if (opts.collection && e.collection !== opts.collection) continue;
    if (ncat && e._s.cat !== ncat) continue;
    if (opts.pack && e.pack !== opts.pack) continue;
    if (opts.role && e.role !== opts.role) continue;
    if (min != null && !(e.duration >= min)) continue;
    if (max != null && !(e.duration <= max)) continue;
    if (opts.license && e.license !== opts.license) continue;
    list.push(e);
  }
  if (q) {
    const tokens = buildTokens(q);
    let scored = list.map((e) => ({ e, ...scoreEntry(e, tokens) }));
    const all = scored.filter((s) => s.matched === tokens.length);
    scored = all.length || opts.strict ? all : scored.filter((s) => s.matched > 0);
    const nq = normalize(q);
    for (const s of scored) {
      // an exact (case / niqqud-insensitive) match on the name, or on either half of "עברית · English", always wins
      if (s.e._s.exact.includes(nq)) { s.total += 1000; if (s.e.error) s.total -= 500; continue; }
      if (s.e.error) s.total *= 0.2;
      // the built-in Starter Pack is the fallback: for partial / tag matches a library the user added ranks first
      else if (s.e.license === 'starter') s.total *= 0.55;
    }
    scored.sort((a, b) => b.matched - a.matched || b.total - a.total || collRank(a.e.collection) - collRank(b.e.collection) || a.e.name.localeCompare(b.e.name));
    list = scored.map((s) => s.e);
  } else {
    list.sort((a, b) => collRank(a.collection) - collRank(b.collection) || a.category.localeCompare(b.category, 'he') || a.name.localeCompare(b.name));
  }
  if (opts.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  else if (opts.sort === 'duration') list.sort((a, b) => a.duration - b.duration);
  else if (opts.sort === '-duration') list.sort((a, b) => b.duration - a.duration);
  return { total: list.length, offset, limit, items: list.slice(offset, offset + limit) };
}

/** Category tree: collection → category → pack, with counts. */
export function categoryTree() {
  const cols = new Map();
  for (const e of liveEntries()) {
    if (!cols.has(e.collection)) cols.set(e.collection, { id: `col:${e.collection}`, name: e.collection, collection: e.collection, count: 0, children: new Map() });
    const c = cols.get(e.collection);
    c.count++;
    if (!c.children.has(e.category)) c.children.set(e.category, { id: `cat:${e.collection}:${e.category}`, name: e.category, collection: e.collection, category: e.category, count: 0, children: new Map() });
    const k = c.children.get(e.category);
    k.count++;
    if (e.collection === COLL_SFX) {
      if (!k.children.has(e.pack)) k.children.set(e.pack, { id: `pack:${e.collection}:${e.category}:${e.pack}`, name: e.pack, collection: e.collection, category: e.category, pack: e.pack, count: 0 });
      k.children.get(e.pack).count++;
    }
  }
  const out = [...cols.values()].sort((a, b) => collRank(a.collection) - collRank(b.collection)).map((c) => ({
    ...c,
    children: [...c.children.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'))
      .map((k) => ({ ...k, children: [...k.children.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) })),
  }));
  // a virtual "roles" node: quick filters by the sound's role in a video (whoosh, hit, riser…)
  const roles = new Map();
  for (const e of liveEntries()) if (e.role) roles.set(e.role, (roles.get(e.role) || 0) + 1);
  if (roles.size) {
    out.unshift({
      id: 'roles', name: 'תפקידים בסרטון', collection: null, count: [...roles.values()].reduce((a, b) => a + b, 0),
      children: ROLE_LIST.filter((r) => roles.has(r)).map((r) => ({ id: `role:${r}`, name: r, role: r, count: roles.get(r), children: [] })),
    });
  }
  return out;
}

export function getSound(id) { return lib.entries.get(id) || null; }

/**
 * Resolve a sound reference for the `sfx` op: id | relPath (from library/sounds) | absolute path | best search match.
 * @returns {Promise<object|null>} entry-like object `{ id?, abs, path, name, duration?, ... }` (path === abs) or null
 */
export async function resolveSound(q) {
  if (q == null) return null;
  const s = String(q).trim();
  if (!s) return null;
  // absolute path that exists (indexed or not)
  if (path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) {
    const abs = path.resolve(s);
    if (fs.existsSync(abs)) {
      await usable();
      const hit = [...liveEntries()].find((e) => path.resolve(e.abs).toLowerCase() === abs.toLowerCase());
      return hit ? { ...hit, path: hit.abs } : { abs, path: abs, name: path.basename(abs).replace(/\.[^.]+$/, ''), file: toPosix(abs) };
    }
  }
  await usable({ timeoutMs: 15000 });
  if (/^[0-9a-f]{12}$/i.test(s) && lib.entries.has(s.toLowerCase()) && !lib.entries.get(s.toLowerCase()).offline) { const e = lib.entries.get(s.toLowerCase()); return { ...e, path: e.abs }; }
  const rel = toPosix(s).replace(/^\.?\//, '').replace(/^library\/sounds\//, '');
  if (lib.byFile.has(rel) && !lib.byFile.get(rel).offline) { const e = lib.byFile.get(rel); return { ...e, path: e.abs }; }
  const relAbs = path.join(soundsDir(), ...rel.split('/'));
  if (/\.[a-z0-9]{2,4}$/i.test(rel) && fs.existsSync(relAbs)) return { abs: relAbs, path: relAbs, name: path.basename(relAbs).replace(/\.[^.]+$/, ''), file: rel };
  // file-name match anywhere
  const baseQ = normalize(path.basename(rel).replace(/\.[^.]+$/, ''));
  if (baseQ.length > 4) {
    const byName = [...liveEntries()].filter((e) => normalize(path.basename(e.file).replace(/\.[^.]+$/, '')) === baseQ)
      .sort((a, b) => collRank(a.collection) - collRank(b.collection));
    if (byName.length) return { ...byName[0], path: byName[0].abs };
  }
  if (lib.building && !lib.entries.size) await lib.building;
  // role name exactly ("מעבר", "מכה", "עולה") → the sound of that role whose length is closest to the role's usual length
  const ns = normalize(s);
  const lenDiff = (e) => Math.abs((e.duration || 0) - ((e.suggest && e.suggest.len) || 1));
  const byRole = [...liveEntries()].filter((e) => e.role && !e.error && normalize(e.role) === ns)
    .sort((a, b) => lenDiff(a) - lenDiff(b) || a.name.localeCompare(b.name) || (a.file < b.file ? -1 : 1));
  if (byRole.length) return { ...byRole[0], path: byRole[0].abs };
  const r = searchSounds({ q: s, limit: 1, strict: true });
  if (r.items.length) return { ...r.items[0], path: r.items[0].abs };
  return null;
}

/** Convenience: absolute path string or null. */
export async function resolveSoundPath(q) {
  const r = await resolveSound(q);
  return r ? r.abs : null;
}

/** Full peaks for a sound (cached in <cacheDir>/peaks/<id>.json). */
export async function soundPeaks(id) {
  const e = lib.entries.get(id);
  if (!e) return null;
  for (const dir of [peaksDir(), legacyPeaksDir()]) {
    try { return JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8')); } catch { /* next / compute */ }
  }
  if (e.offline) return { rate: PEAK_RATE, duration: e.duration, peaks: [], error: 'התיקייה של הצליל לא מחוברת כרגע' };
  const scan = await scanFile(e.abs);
  if (scan.error) return { rate: PEAK_RATE, duration: e.duration, peaks: [], error: scan.error };
  await writePeaks(id, scan.duration, scan.peaks);
  return { rate: PEAK_RATE, duration: scan.duration, peaks: scan.peaks.map((v) => Math.round(v * 1000) / 1000) };
}

// ───────────────────────────── fonts ─────────────────────────────

const SYSTEM_FONTS = [
  { family: 'Arial', weights: [400, 700], files: ['arial.ttf', 'arialbd.ttf'] },
  { family: 'David', weights: [400, 700], files: ['david.ttf', 'davidbd.ttf'] },
  { family: 'Frank Ruehl', weights: [400], files: ['frank.ttf'] },
  { family: 'Gisha', weights: [400, 700], files: ['gisha.ttf', 'gishabd.ttf'] },
  { family: 'Rod', weights: [400], files: ['rod.ttf'] },
  { family: 'Segoe UI', weights: [300, 400, 600, 700, 900], files: ['segoeui.ttf', 'segoeuib.ttf', 'segoeuil.ttf', 'seguisb.ttf', 'seguibl.ttf'] },
  { family: 'Tahoma', weights: [400, 700], files: ['tahoma.ttf', 'tahomabd.ttf'] },
  { family: 'Bahnschrift', weights: [300, 350, 400, 600, 700], files: ['bahnschrift.ttf'] },
  { family: 'Impact', weights: [400], files: ['impact.ttf'], latinOnly: true },
  { family: 'Segoe UI Emoji', weights: [400], files: ['seguiemj.ttf'] },
];
const LOCAL_FONT_META = {
  heebo: { family: 'Heebo', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  assistant: { family: 'Assistant', weights: [200, 300, 400, 500, 600, 700, 800] },
};

export async function listFonts() {
  const out = [];
  let files = [];
  try { files = await fsp.readdir(fontsDir()); } catch { /* none */ }
  const groups = new Map();
  for (const f of files) {
    if (!/\.(ttf|otf|woff2?)$/i.test(f)) continue;
    const key = f.toLowerCase().split(/[-_.]/)[0];
    const meta = LOCAL_FONT_META[key] || { family: f.replace(/[-_](variablefont|regular|bold).*$/i, '').replace(/\.[^.]+$/, ''), weights: [400] };
    if (!groups.has(meta.family)) groups.set(meta.family, { family: meta.family, weights: meta.weights, files: [], system: false, license: 'SIL Open Font License 1.1' });
    const subset = /hebrew/i.test(f) ? 'hebrew' : /latin/i.test(f) ? 'latin' : 'full';
    groups.get(meta.family).files.push({ url: `/library/fonts/${encodeURIComponent(f)}`, file: f, subset, format: path.extname(f).slice(1).toLowerCase() });
  }
  for (const g of groups.values()) {
    const full = g.files.find((x) => x.subset === 'full') || g.files.find((x) => x.subset === 'hebrew') || g.files[0];
    out.push({ ...g, url: full ? full.url : undefined, available: true });
  }
  const winFonts = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts');
  for (const s of SYSTEM_FONTS) {
    const available = s.files.some((f) => fs.existsSync(path.join(winFonts, f)));
    out.push({ family: s.family, weights: s.weights, system: true, available, latinOnly: !!s.latinOnly, license: 'גופן מערכת של Windows — מורשה לשימוש בתוצרים' });
  }
  return out;
}

// ───────────────────────────── LUTs ─────────────────────────────

export const LUT_NAMES = {
  'teal-orange.cube': 'טורקיז-כתום',
  'warm-film.cube': 'פילם חם',
  'cool-night.cube': 'לילה קריר',
  'bleach-bypass.cube': 'בליץ׳ ביי־פאס',
  'vintage-fade.cube': 'וינטג׳ דהוי',
  'mono-contrast.cube': 'שחור-לבן חד',
  'golden-hour.cube': 'שעת זהב',
  'cyan-night.cube': 'ציאן לילי',
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function filmicContrast(v, amount) { // smooth S-curve via smoothstep blend
  const s = v * v * (3 - 2 * v);
  return clamp01(mix(v, s, amount));
}
function sat(r, g, b, s) { const l = luma(r, g, b); return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s]; }
function lift(v, black, white) { return black + v * (white - black); }

const LUT_FUNCS = {
  'teal-orange.cube': (r, g, b) => {
    const l = luma(r, g, b);
    // split tone: shadows → teal, highlights → orange; protect skin by keeping warm hues warm
    const sh = 1 - smooth(0.0, 0.55, l), hi = smooth(0.45, 1.0, l);
    let R = r + (-0.06 * sh) + (0.08 * hi);
    let G = g + (0.03 * sh) + (0.02 * hi);
    let B = b + (0.07 * sh) + (-0.07 * hi);
    [R, G, B] = sat(R, G, B, 1.12);
    return [filmicContrast(clamp01(R), 0.35), filmicContrast(clamp01(G), 0.35), filmicContrast(clamp01(B), 0.35)];
  },
  'warm-film.cube': (r, g, b) => {
    let [R, G, B] = sat(r, g, b, 0.9);
    R = R * 1.06 + 0.02; G = G * 1.01 + 0.01; B = B * 0.9 + 0.015;
    R = lift(filmicContrast(clamp01(R), 0.25), 0.035, 0.97);
    G = lift(filmicContrast(clamp01(G), 0.25), 0.03, 0.96);
    B = lift(filmicContrast(clamp01(B), 0.25), 0.04, 0.92);
    return [R, G, B];
  },
  'cool-night.cube': (r, g, b) => {
    let [R, G, B] = sat(r, g, b, 0.75);
    const l = luma(R, G, B);
    R = R * 0.82; G = G * 0.92 + 0.01; B = B * 1.08 + 0.05 * (1 - l);
    const k = 0.9;
    return [clamp01(filmicContrast(clamp01(R * k), 0.3)), clamp01(filmicContrast(clamp01(G * k), 0.3)), clamp01(filmicContrast(clamp01(B * k + 0.02), 0.2))];
  },
  'bleach-bypass.cube': (r, g, b) => {
    const l = luma(r, g, b);
    // overlay blend of the image with its own luminance, then 45% desaturation
    const ov = (c) => (l < 0.5 ? 2 * c * l : 1 - 2 * (1 - c) * (1 - l));
    let R = mix(r, ov(r), 0.65), G = mix(g, ov(g), 0.65), B = mix(b, ov(b), 0.65);
    [R, G, B] = sat(R, G, B, 0.55);
    return [filmicContrast(clamp01(R), 0.2), filmicContrast(clamp01(G), 0.2), filmicContrast(clamp01(B), 0.2)];
  },
  'vintage-fade.cube': (r, g, b) => {
    let [R, G, B] = sat(r, g, b, 0.72);
    R = lift(clamp01(R * 1.03 + 0.02), 0.09, 0.93);
    G = lift(clamp01(G * 1.0 + 0.02), 0.08, 0.91);
    B = lift(clamp01(B * 0.88 + 0.02), 0.12, 0.84);
    return [R, G, B];
  },
  'mono-contrast.cube': (r, g, b) => {
    const l = luma(r, g, b);
    const v = filmicContrast(filmicContrast(l, 0.6), 0.3);
    return [v, v, v];
  },
  'golden-hour.cube': (r, g, b) => {
    const l = luma(r, g, b);
    const hi = smooth(0.35, 1.0, l), sh = 1 - smooth(0.0, 0.4, l);
    let R = r + 0.1 * hi + 0.015 * sh, G = g + 0.05 * hi - 0.005 * sh, B = b - 0.08 * hi + 0.02 * sh;
    [R, G, B] = sat(clamp01(R), clamp01(G), clamp01(B), 1.15);
    return [filmicContrast(clamp01(R), 0.2), filmicContrast(clamp01(G), 0.2), filmicContrast(clamp01(B), 0.15)];
  },
  'cyan-night.cube': (r, g, b) => {
    // deep blue-black shadows, cyan mids, warm accents in hot highlights
    const l = luma(r, g, b);
    const sh = 1 - smooth(0.0, 0.5, l), mid = smooth(0.15, 0.5, l) * (1 - smooth(0.55, 0.95, l)), hi = smooth(0.7, 1.0, l);
    const night = [0x07 / 255, 0x18 / 255, 0x22 / 255], cyan = [0x13 / 255, 0xb6 / 255, 0xe4 / 255], coral = [1, 0x8a / 255, 0x66 / 255];
    let R = mix(r, night[0] + r * 0.9, 0.5 * sh), G = mix(g, night[1] + g * 0.9, 0.5 * sh), B = mix(b, night[2] + b * 0.95, 0.5 * sh);
    R = mix(R, R * 0.85 + cyan[0] * 0.15 * l * 2, 0.4 * mid);
    G = mix(G, G * 0.85 + cyan[1] * 0.15 * l * 2, 0.4 * mid);
    B = mix(B, B * 0.85 + cyan[2] * 0.15 * l * 2, 0.4 * mid);
    R = mix(R, R * 0.95 + coral[0] * 0.05, 0.5 * hi);
    G = mix(G, G * 0.97 + coral[1] * 0.03, 0.5 * hi);
    B = mix(B, B * 0.97 + coral[2] * 0.03, 0.5 * hi);
    [R, G, B] = sat(clamp01(R), clamp01(G), clamp01(B), 1.1);
    return [filmicContrast(clamp01(R), 0.3), filmicContrast(clamp01(G), 0.3), filmicContrast(clamp01(B), 0.25)];
  },
};

/** .cube text (R fastest, size N). */
export function makeCube(file, size = 17) {
  const fn = LUT_FUNCS[file];
  if (!fn) throw new Error('unknown LUT ' + file);
  const lines = [
    `TITLE "Frame Studio ${file.replace(/\.cube$/i, '')}"`,
    '# Generated by Frame Studio (original, free to use)',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const n = size - 1;
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    const [R, G, B] = fn(ri / n, gi / n, bi / n);
    lines.push(`${clamp01(R).toFixed(6)} ${clamp01(G).toFixed(6)} ${clamp01(B).toFixed(6)}`);
  }
  return lines.join('\n') + '\n';
}

/** Write the 8 built-in LUTs if missing (or all with force). Returns list of written files. */
export async function ensureLuts({ force = false, size = 17 } = {}) {
  const dir = lutsDir();
  await fsp.mkdir(dir, { recursive: true });
  const written = [];
  for (const file of Object.keys(LUT_FUNCS)) {
    const abs = path.join(dir, file);
    if (!force && fs.existsSync(abs)) continue;
    await fsp.writeFile(abs, makeCube(file, size), 'utf8');
    written.push(file);
  }
  return written;
}

export async function listLuts() {
  try { await ensureLuts(); } catch { /* read-only */ }
  let files = [];
  try { files = await fsp.readdir(lutsDir()); } catch { /* none */ }
  return files.filter((f) => /\.cube$/i.test(f)).sort((a, b) => {
    const ia = Object.keys(LUT_NAMES).indexOf(a), ib = Object.keys(LUT_NAMES).indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

// ───────────────────────────── licenses ─────────────────────────────

export async function licensesText() {
  try { return await fsp.readFile(licensesFile(), 'utf8'); } catch { return '# רישיונות\n\nקובץ הרישיונות חסר (library/LICENSES.md).\n'; }
}

// ───────────────────────────── HTTP routes ─────────────────────────────

function sendJson(ctx, res, code, obj) {
  if (ctx && typeof ctx.sendJson === 'function') return ctx.sendJson(res, code, obj);
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
function queryOf(req) {
  const u = new URL(req.url, 'http://127.0.0.1');
  return Object.fromEntries(u.searchParams.entries());
}

/** Public entry (strips nothing — abs path is useful locally). */
function publicEntry(e) { return e; }

async function readJsonBody(ctx, req) {
  if (ctx && typeof ctx.readJson === 'function') return ctx.readJson(req);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const txt = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').trim();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { const e = new Error('גוף הבקשה אינו JSON תקין'); e.status = 400; throw e; }
}

// ───────────────────────────── Starter Pack ─────────────────────────────

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starterState = { status: 'unknown', dir: null, promise: null };

function runNode(args) {
  return new Promise((resolve) => {
    let err = '';
    const p = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (b) => { if (err.length < 4000) err += b; });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, error: err.trim().split('\n').pop() }));
  });
}

/**
 * Make sure the Starter Pack (tools/make-starter-sounds.mjs — 24 original sounds, MIT) exists in
 * ROOT/library/sounds/Starter Pack (or <dataDir>/Sounds/Starter Pack when the app folder is read-only).
 * Generated in a child process so the server never stalls; the index is refreshed when it is done.
 */
export function ensureStarterPack() {
  if (starterState.promise) return starterState.promise;
  starterState.promise = (async () => {
    const script = path.join(MODULE_ROOT, 'tools', 'make-starter-sounds.mjs');
    let gen;
    try { gen = await import(pathToFileURL(script).href); } catch (e) { starterState.status = 'unavailable'; logFn('starter pack generator missing:', e.message); return starterState; }
    const dirs = [path.join(soundsDir(), STARTER_DIR), path.join(dataSoundsDir(), STARTER_DIR)];
    for (const d of dirs) {
      if (gen.starterPackStatus(d).complete) { starterState.status = 'ready'; starterState.dir = d; return starterState; }
    }
    for (const d of dirs) {
      starterState.status = 'generating';
      logFn(`generating the Starter Pack → ${d}`);
      const r = await runNode([script, '--out', d, '--quiet']);
      if (gen.starterPackStatus(d).complete) {
        starterState.status = 'ready'; starterState.dir = d;
        startBuild().catch(() => {});
        return starterState;
      }
      logFn('starter pack generation failed:', r.error || 'unknown error');
    }
    starterState.status = 'failed';
    return starterState;
  })();
  return starterState.promise;
}

// ───────────────────────────── sound folders (API view) ─────────────────────────────

/** Indexed folders for the UI: built-in + data folder (when it exists) + user folders, with sound counts. */
export function foldersView() {
  const counts = new Map(), starter = new Map();
  for (const e of lib.entries.values()) {
    if (!e.folder) continue;
    const k = pathKey(e.folder);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (e.license === 'starter') starter.set(k, (starter.get(k) || 0) + 1);
  }
  const indexing = !!lib.building;
  const out = [];
  for (const r of allSoundRoots()) {
    if (r.kind === 'data' && (!r.exists || !counts.get(pathKey(r.path)))) continue;   // empty <dataDir>/Sounds: noise
    const k = pathKey(r.path);
    const n = counts.get(k) || 0;
    if (r.kind === 'builtin' && !n && !indexing) continue;             // empty built-in folder: nothing to show
    out.push({
      path: r.path, name: r.kind !== 'user' && n && n === (starter.get(k) || 0) ? 'צלילי הפתיחה של Frame Studio' : r.name,
      kind: r.kind, exists: r.exists, removable: r.removable, count: n, starter: starter.get(k) || 0, addedAt: r.addedAt || null,
    });
  }
  return out;
}

// ───────────────────────────── open a web page (download links) ─────────────────────────────

/** Sites the editor may open in the default browser (free sound downloads, the project page). */
export const OPEN_URL_HOSTS = new Set(['sonniss.com', 'www.sonniss.com', 'mixkit.co', 'www.mixkit.co', 'github.com', 'www.github.com']);

/** Validate a URL for POST /api/open-url → URL string or throws (400). */
export function checkOpenUrl(u) {
  let url;
  try { url = new URL(String(u || '')); } catch { const e = new Error('כתובת לא תקינה'); e.status = 400; throw e; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !OPEN_URL_HOSTS.has(url.hostname.toLowerCase())) {
    const e = new Error('אפשר לפתוח רק קישורי הורדה מוכרים (https)'); e.status = 400; throw e;
  }
  return url.href;
}

function openInBrowser(href) {
  const cmd = typeof cfg.openUrlCommand === 'function' ? cfg.openUrlCommand(href)
    : process.platform === 'win32' ? ['explorer.exe', href] : process.platform === 'darwin' ? ['open', href] : ['xdg-open', href];
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd[0], cmd.slice(1), { windowsHide: true, detached: true, stdio: 'ignore' });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.unref();
      setTimeout(() => resolve({ ok: true }), 150);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// ───────────────────────────── Claude connection (the editor's "Claude" indicator) ─────────────────────────────
// The browser's live link to this server says nothing about Claude. What the editor can honestly show:
//  • "connected" — Claude (MCP server / cutx) talked to this server recently: POST /api/claude/hello, a request with
//                  the x-frame-studio-client header, or any non-browser API request that reaches the library routes;
//  • "ready"     — Claude Desktop's config has the "frame-studio" MCP entry (or the Claude Code skill is installed);
//  • otherwise   — not connected: the editor shows how to connect.
// Read-only: Claude's own files are only read, never written. Test overrides: FRAME_STUDIO_CLAUDE_CONFIG (one desktop
// config file, or "none"), FRAME_STUDIO_CLAUDE_HOME (the ~/.claude folder).

const CLAUDE_RECENT_MS = 15 * 60_000;
const claudeSeen = { at: 0, client: null };
const CLIENT_RE = /^[a-z][a-z0-9 ._-]{0,39}$/i;

/** Remember that Claude (or another API client) just used the server. */
export function noteClaudeClient(client = 'api') {
  claudeSeen.at = Date.now();
  claudeSeen.client = CLIENT_RE.test(String(client)) ? String(client).toLowerCase() : 'api';
}

/** The client name when a request was made by Claude's tools rather than by a browser (editor window, headless renderer). */
export function agentClientOf(req) {
  const hdr = req && req.headers ? req.headers : {};
  const named = String(hdr['x-frame-studio-client'] || '').trim();
  if (named) return named;
  const ua = String(hdr['user-agent'] || '');
  if (/Mozilla\//.test(ua)) return null;
  return 'api';
}

function claudeDesktopConfigFiles() {
  const env = String(process.env.FRAME_STUDIO_CLAUDE_CONFIG || '').trim();
  if (env) return env.toLowerCase() === 'none' ? [] : [path.resolve(env)];
  const home = os.homedir();
  if (process.platform === 'win32') {
    const out = [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')];
    const pk = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    try {
      for (const d of fs.readdirSync(pk)) if (/^Claude_/i.test(d)) out.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    } catch { /* no Store apps folder */ }
    return out;
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json')];
}

let claudeCfgCache = { at: 0, value: null };
function claudeSetup() {
  if (claudeCfgCache.value && Date.now() - claudeCfgCache.at < 5000) return claudeCfgCache.value;
  const desktop = { installed: false, configured: false, broken: false, file: null };
  for (const file of claudeDesktopConfigFiles()) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { if (fs.existsSync(path.dirname(file))) desktop.installed = true; continue; }
    desktop.installed = true;
    let j = null;
    try { j = JSON.parse(raw.replace(/^﻿/, '') || '{}'); } catch { desktop.broken = true; desktop.file = file; continue; }
    const entry = j && j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers['frame-studio'] : null;
    if (!entry) continue;
    const script = Array.isArray(entry.args) ? entry.args.find((a) => /\.m?js$/i.test(String(a))) : null;
    if (script && !fs.existsSync(String(script))) { desktop.broken = true; desktop.file = file; continue; }
    desktop.configured = true; desktop.broken = false; desktop.file = file;
    break;
  }
  const codeHome = String(process.env.FRAME_STUDIO_CLAUDE_HOME || '').trim() || path.join(os.homedir(), '.claude');
  const code = { skill: fs.existsSync(path.join(codeHome, 'skills', 'frame-studio', 'SKILL.md')) };
  claudeCfgCache = { at: Date.now(), value: { desktop, code } };
  return claudeCfgCache.value;
}

/** → { connected, ready, state:"connected"|"ready"|"setup", lastSeen, client, desktop:{installed,configured,broken,file}, code:{skill} } */
export function claudeStatus() {
  const setup = claudeSetup();
  const recent = claudeSeen.at > 0 && Date.now() - claudeSeen.at < CLAUDE_RECENT_MS;
  const ready = setup.desktop.configured || setup.code.skill;
  return {
    connected: recent, ready, state: recent ? 'connected' : ready ? 'ready' : 'setup',
    lastSeen: claudeSeen.at ? new Date(claudeSeen.at).toISOString() : null, client: claudeSeen.client,
    desktop: setup.desktop, code: setup.code,
  };
}

// ───────────────────────────── editor helpers: transcription setup, show a file in its folder ─────────────────────────────

function spawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { windowsHide: false, detached: true, stdio: 'ignore', ...opts });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.unref();
      setTimeout(() => resolve({ ok: true }), 200);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

/** Show a file selected in the system file manager (Windows: Explorer /select). */
export function revealInFolder(file) {
  if (process.platform === 'win32') {
    // explorer parses its own command line: /select,"<path>" (Windows paths cannot contain quotes)
    return spawnDetached('explorer.exe', [`/select,"${path.resolve(file)}"`], { windowsVerbatimArguments: true, windowsHide: true });
  }
  if (process.platform === 'darwin') return spawnDetached('open', ['-R', file]);
  return spawnDetached('xdg-open', [path.dirname(file)]);
}

/** The bundled "set up local transcription" file (what the user would double-click), or null when it is not shipped. */
export function transcriptionInstaller() {
  const f = path.join(ROOT, 'tools', process.platform === 'win32' ? 'install-transcription.cmd' : 'install-transcription.ps1');
  return fs.existsSync(f) ? f : null;
}

/**
 * Routes for server/main.mjs. ctx per SPEC §5.
 * @returns {{method:string, pattern:RegExp, handler:Function}[]}
 */
export function routes(ctx = {}) {
  if (ctx.ROOT) { ROOT = path.resolve(ctx.ROOT); configureFolders({ root: ROOT }); }
  if (typeof ctx.log === 'function') logFn = (...a) => ctx.log('[library]', ...a);
  const cs = configStatus();
  logFn(cs.error ? cs.error : cs.exists ? `config: ${cs.file}` : 'config.json not found — using defaults (see config.example.json)');
  // warm up in the background: LUTs + Starter Pack + index (does not block server start)
  ensureLuts().catch((e) => logFn('LUT generation failed', e.message));
  ensureIndex().catch((e) => logFn('index failed', e.message));
  if (process.env.FRAME_STUDIO_NO_STARTER === '1') starterState.status = 'disabled';
  else ensureStarterPack().catch((e) => logFn('starter pack failed', e.message));

  const serveFile = (req, res, abs) => {
    if (typeof ctx.serveFile === 'function') return ctx.serveFile(req, res, abs);
    return serveFileFallback(req, res, abs);
  };
  const fail = (res, e) => sendJson(ctx, res, e && e.status ? e.status : 500, { error: (e && e.message) || 'שגיאה' });
  const foldersReply = (extra = {}) => ({ ...extra, folders: foldersView(), status: indexStatus() });
  const pathArg = async (req) => {
    const q = queryOf(req);
    if (q.path) return q.path;
    const b = await readJsonBody(ctx, req);
    return b && b.path;
  };
  const removeFolder = async (req, res) => {
    try {
      const r = removeSoundFolder(await pathArg(req));
      if (r.removed) startBuild().catch(() => {});
      sendJson(ctx, res, 200, foldersReply({ ok: true, removed: r.removed }));
    } catch (e) { fail(res, e); }
  };

  return [
    // not a real route: notes Claude's (non-browser) API requests for the "Claude" indicator, then routing continues
    {
      method: '*', pattern: /^\/api\//,
      handler: (req) => {
        const c = String(req.pathname || req.url || '').startsWith('/api/claude/status') ? null : agentClientOf(req);
        if (c) noteClaudeClient(c);
        return ctx.NEXT || false;
      },
    },
    {
      method: 'GET', pattern: /^\/api\/claude\/status\/?$/,
      handler: async (req, res) => sendJson(ctx, res, 200, claudeStatus()),
    },
    {
      // the MCP server / cutx say hello when they start working, so the editor can show "Claude connected"
      method: 'POST', pattern: /^\/api\/claude\/hello\/?$/,
      handler: async (req, res) => {
        let b = null;
        try { b = await readJsonBody(ctx, req); } catch { b = null; }
        noteClaudeClient((b && b.client) || agentClientOf(req) || 'api');
        sendJson(ctx, res, 200, { ok: true, ...claudeStatus() });
      },
    },
    {
      // "התקנת תמלול אוטומטי": opens the bundled installer in its own window (the user answers its questions there)
      method: 'POST', pattern: /^\/api\/asr\/install\/?$/,
      handler: async (req, res) => {
        try {
          const b = (await readJsonBody(ctx, req)) || {};
          const file = transcriptionInstaller();
          if (!file) return sendJson(ctx, res, 404, { error: 'קובץ ההתקנה של התמלול לא נמצא בתיקיית Frame Studio (tools\\install-transcription.cmd)' });
          const mode = b.reveal || process.platform !== 'win32' ? 'reveal' : 'run';
          if (b.dry) return sendJson(ctx, res, 200, { ok: true, dry: true, file, mode });
          // run = exactly what double-clicking the file does (its own console window)
          const r = mode === 'reveal' ? await revealInFolder(file) : await spawnDetached('explorer.exe', [file], { windowsHide: true });
          logFn(`transcription installer ${mode === 'reveal' ? 'shown in its folder' : 'started'}: ${file}`);
          sendJson(ctx, res, r.ok ? 200 : 500, r.ok ? { ok: true, file, mode } : { error: `לא ניתן לפתוח את ההתקנה: ${r.error}`, file });
        } catch (e) { fail(res, e); }
      },
    },
    {
      // "פתיחת התיקייה" after an export: shows the file in Explorer — only files inside the projects folder
      method: 'POST', pattern: /^\/api\/reveal\/?$/,
      handler: async (req, res) => {
        try {
          const b = (await readJsonBody(ctx, req)) || {};
          const p = String(b.path || '');
          if (!p || !path.isAbsolute(p)) return sendJson(ctx, res, 400, { error: 'נתיב לא תקין' });
          const abs = path.resolve(p);
          const base = typeof cfg.projectsDir === 'function' ? cfg.projectsDir() : path.join(ROOT, 'projects');
          if (!isInside(abs, base)) return sendJson(ctx, res, 403, { error: 'אפשר לפתוח רק קבצים מתיקיית הפרויקטים' });
          if (!fs.existsSync(abs)) return sendJson(ctx, res, 404, { error: 'הקובץ לא נמצא' });
          if (b.dry) return sendJson(ctx, res, 200, { ok: true, dry: true, path: abs });
          const r = await revealInFolder(abs);
          sendJson(ctx, res, r.ok ? 200 : 500, r.ok ? { ok: true, path: abs } : { error: `הסייר לא נפתח: ${r.error}` });
        } catch (e) { fail(res, e); }
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/sounds\/?$/,
      handler: async (req, res) => {
        const q = queryOf(req);
        if (q.rebuild === '1') ensureIndex({ rebuild: true }).catch(() => {});
        await usable();
        const r = searchSounds(q);
        sendJson(ctx, res, 200, { ...r, items: r.items.map(publicEntry), indexing: lib.building ? { done: lib.progress.done, total: lib.progress.total } : null });
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/sounds\/categories\/?$/,
      handler: async (req, res) => {
        await usable();
        sendJson(ctx, res, 200, categoryTree());
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/sounds\/status\/?$/,
      handler: async (req, res) => { ensureIndex().catch(() => {}); sendJson(ctx, res, 200, indexStatus()); },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/sounds\/([0-9a-f]{12})\/?$/i,
      handler: async (req, res, match) => {
        await usable();
        const e = getSound(match[1].toLowerCase());
        if (!e) return sendJson(ctx, res, 404, { error: 'הצליל לא נמצא בספרייה' });
        sendJson(ctx, res, 200, publicEntry(e));
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/sounds\/([0-9a-f]{12})\/file\/?$/i,
      handler: async (req, res, match) => {
        await usable();
        const e = getSound(match[1].toLowerCase());
        if (!e) return sendJson(ctx, res, 404, { error: 'הצליל לא נמצא בספרייה' });
        if (e.offline) return sendJson(ctx, res, 404, { error: 'התיקייה של הצליל לא מחוברת כרגע (כונן חיצוני?)' });
        if (!fs.existsSync(e.abs)) return sendJson(ctx, res, 404, { error: 'קובץ הצליל חסר בדיסק' });
        return serveFile(req, res, e.abs);
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/sounds\/([0-9a-f]{12})\/peaks\/?$/i,
      handler: async (req, res, match) => {
        await usable();
        const p = await soundPeaks(match[1].toLowerCase());
        if (!p) return sendJson(ctx, res, 404, { error: 'הצליל לא נמצא בספרייה' });
        sendJson(ctx, res, 200, p);
      },
    },
    // ── sound folders: index folders where they are (nothing is moved or copied) ──
    {
      method: 'GET', pattern: /^\/api\/library\/folders\/?$/,
      handler: async (req, res) => { ensureIndex().catch(() => {}); sendJson(ctx, res, 200, foldersReply()); },
    },
    {
      method: 'POST', pattern: /^\/api\/library\/folders\/?$/,
      handler: async (req, res) => {
        try {
          const r = addSoundFolder(await pathArg(req));
          if (r.added) startBuild().catch(() => {});
          sendJson(ctx, res, 200, foldersReply({ ok: true, added: r.added, already: r.already || null, folder: r.folder, replaced: r.replaced }));
        } catch (e) { fail(res, e); }
      },
    },
    { method: 'DELETE', pattern: /^\/api\/library\/folders\/?$/, handler: removeFolder },
    { method: 'POST', pattern: /^\/api\/library\/folders\/remove\/?$/, handler: removeFolder },
    {
      method: 'POST', pattern: /^\/api\/library\/folders\/pick\/?$/,
      handler: async (req, res) => {
        try {
          const b = await readJsonBody(ctx, req);
          const r = await pickFolder();
          if (r.canceled || !b || !b.add) return sendJson(ctx, res, 200, r);
          const a = addSoundFolder(r.path);
          if (a.added) startBuild().catch(() => {});
          sendJson(ctx, res, 200, foldersReply({ ok: true, path: r.path, added: a.added, already: a.already || null, folder: a.folder }));
        } catch (e) { fail(res, e); }
      },
    },
    {
      method: 'POST', pattern: /^\/api\/open-url\/?$/,
      handler: async (req, res) => {
        try {
          const b = await readJsonBody(ctx, req);
          const href = checkOpenUrl(b && b.url);
          if (b && b.dry) return sendJson(ctx, res, 200, { ok: true, url: href, dry: true });
          const r = await openInBrowser(href);
          sendJson(ctx, res, r.ok ? 200 : 500, r.ok ? { ok: true, url: href } : { error: `הדפדפן לא נפתח: ${r.error}` });
        } catch (e) { fail(res, e); }
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/fonts\/?$/,
      handler: async (req, res) => sendJson(ctx, res, 200, await listFonts()),
    },
    {
      method: 'GET', pattern: /^\/api\/library\/luts\/?$/,
      handler: async (req, res) => {
        const q = queryOf(req);
        const names = await listLuts();
        if (q.detail === '1') return sendJson(ctx, res, 200, names.map((f) => ({ file: f, name: LUT_NAMES[f] || f.replace(/\.cube$/i, ''), url: `/library/luts/${encodeURIComponent(f)}` })));
        sendJson(ctx, res, 200, names);
      },
    },
    {
      method: 'GET', pattern: /^\/api\/library\/licenses\/?$/,
      handler: async (req, res) => sendText(res, 200, await licensesText(), 'text/markdown; charset=utf-8'),
    },
  ];
}

/** Minimal Range-capable file server used only when ctx.serveFile is not provided (tests). */
export function serveFileFallback(req, res, abs) {
  let st;
  try { st = fs.statSync(abs); } catch { res.writeHead(404); res.end(); return; }
  const ext = path.extname(abs).toLowerCase();
  const TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aif': 'audio/aiff', '.aiff': 'audio/aiff' };
  const type = TYPES[ext] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] ? +range[1] : 0;
    let end = range[2] ? +range[2] : st.size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, st.size - +range[2]); end = st.size - 1; }
    if (start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs).pipe(res);
  }
}

export { COLL_SFX, COLL_MUSIC, MUSIC_MIN_SEC };
