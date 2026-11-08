// Frame Studio — sets values in config.json without disturbing anything else in it.
// Used by tools/install.ps1 and tools/install-transcription.ps1.
//
//   node tools/config-set.mjs [--dry-run] [--json] key=value [key.sub=value …]
//   node tools/config-set.mjs --get key[.sub]            prints the value from config.json as JSON (null if unset)
//
// • config.json missing → it is created from config.example.json (comments and layout kept), then the values are set.
// • Only the given keys change; every other byte of the file stays as it was (key order, blank lines, "_comment"s).
//   A key whose value is already equal is left alone; when nothing changes the file is not touched at all.
// • Before an existing file is changed it is copied to config.json.bak. Invalid JSON is never overwritten.
// • value "null" → null, "true"/"false" → booleans, anything else is a string.
// Exit code: 0 = ok, 2 = config.json is not valid JSON / bad arguments.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE, EXAMPLE_FILE } from '../server/config.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const asJson = args.includes('--json');

function fail(msg) {
  console.error(`config-set: ${msg}`);
  process.exit(2);
}

const readText = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');

/** Walk JSON text and record the [start, end) span of every value, keyed by its path ("a\u0000b"). */
export function valueSpans(text) {
  const spans = new Map();
  const members = new Map();             // object path → [{ key, keyStart, valueEnd }]
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const expect = (ch) => { ws(); if (text[i] !== ch) throw new Error(`expected '${ch}' at offset ${i}`); i++; };
  const string = () => {
    const s = i++;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '"') return JSON.parse(text.slice(s, ++i));
      else i++;
    }
    throw new Error('unterminated string');
  };
  const value = (p) => {
    ws();
    const start = i, c = text[i];
    if (c === '{') {
      i++; ws();
      const list = [];
      if (text[i] === '}') i++;
      else for (;;) {
        ws();
        const keyStart = i;
        if (text[i] !== '"') throw new Error(`expected a key at offset ${i}`);
        const k = string();
        expect(':');
        value([...p, k]);
        list.push({ key: k, keyStart, valueEnd: spans.get([...p, k].join('\u0000'))[1] });
        ws();
        if (text[i] === ',') { i++; continue; }
        expect('}');
        break;
      }
      members.set(p.join('\u0000'), list);
    } else if (c === '[') {
      i++; ws();
      let n = 0;
      if (text[i] === ']') i++;
      else for (;;) {
        value([...p, String(n++)]);
        ws();
        if (text[i] === ',') { i++; continue; }
        expect(']');
        break;
      }
    } else if (c === '"') string();
    else { while (i < text.length && !/[\s,\]}]/.test(text[i])) i++; if (i === start) throw new Error(`unexpected character at offset ${i}`); }
    spans.set(p.join('\u0000'), [start, i]);
  };
  value([]);
  ws();
  if (i < text.length) throw new Error(`unexpected text at offset ${i}`);
  return { spans, members };
}

const getIn = (obj, keys) => keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Set one value in JSON text with a minimal edit. → new text */
export function setInText(text, keys, val) {
  const { spans, members } = valueSpans(text);
  const at = spans.get(keys.join('\u0000'));
  if (at) return text.slice(0, at[0]) + JSON.stringify(val) + text.slice(at[1]);
  // key missing: insert it into the deepest existing object on its path
  let depth = keys.length - 1;
  while (depth > 0 && !members.has(keys.slice(0, depth).join('\u0000'))) depth--;
  const parent = keys.slice(0, depth);
  const list = members.get(parent.join('\u0000'));
  if (!list) throw new Error(`"${parent.join('.')}" is not an object`);
  let nested = val;
  for (let d = keys.length - 1; d > depth; d--) nested = { [keys[d]]: nested };
  const member = `${JSON.stringify(keys[depth])}: ${JSON.stringify(nested)}`;
  const pspan = spans.get(parent.join('\u0000'));
  if (!list.length) return text.slice(0, pspan[0]) + `{ ${member} }` + text.slice(pspan[1]);
  const last = list[list.length - 1];
  const lineStart = text.lastIndexOf('\n', last.keyStart) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, last.keyStart))[0];
  const sep = lineStart > pspan[0] ? `,\n${indent}` : ', ';
  return text.slice(0, last.valueEnd) + sep + member + text.slice(last.valueEnd);
}

const parseValue = (s) => (s === 'null' ? null : s === 'true' ? true : s === 'false' ? false : s);

// ───────────────────────── main ─────────────────────────

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

function main() {
  const gi = args.indexOf('--get');
  if (gi >= 0) {
    const key = args[gi + 1];
    if (!key) fail('--get needs a key');
    let obj = {};
    if (fs.existsSync(CONFIG_FILE)) { try { obj = JSON.parse(readText(CONFIG_FILE)); } catch (e) { fail(`config.json is not valid JSON (${e.message})`); } }
    const v = getIn(obj, key.split('.'));
    console.log(JSON.stringify(v === undefined ? null : v));
    return;
  }

  const pairs = args.filter((a) => !a.startsWith('--')).map((a) => {
    const eq = a.indexOf('=');
    if (eq <= 0) fail(`expected key=value, got "${a}"`);
    return { keys: a.slice(0, eq).split('.'), value: parseValue(a.slice(eq + 1)) };
  });

  const exists = fs.existsSync(CONFIG_FILE);
  let text = exists ? readText(CONFIG_FILE) : fs.existsSync(EXAMPLE_FILE) ? readText(EXAMPLE_FILE) : '{}\n';
  try { JSON.parse(text); valueSpans(text); } catch (e) {
    fail(`${exists ? 'config.json' : 'config.example.json'} is not valid JSON — fix or delete it first (${e.message})`);
  }

  const changes = [];
  for (const { keys, value } of pairs) {
    const old = getIn(JSON.parse(text), keys);
    if (same(old, value)) continue;
    text = setInText(text, keys, value);
    changes.push({ key: keys.join('.'), from: old === undefined ? null : old, to: value });
  }
  const after = JSON.parse(text);                     // must still be valid
  for (const { keys, value } of pairs) if (!same(getIn(after, keys), value)) fail(`could not set ${keys.join('.')}`);

  const willWrite = !exists || changes.length > 0;
  if (willWrite && !dry) {
    if (exists && changes.length) fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak');
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
  }

  if (asJson) {
    console.log(JSON.stringify({ file: CONFIG_FILE, created: !exists, changes, written: willWrite && !dry, dryRun: dry }));
    return;
  }
  const tag = dry ? ' (dry run — nothing written)' : '';
  if (!exists) console.log(`config.json: ${dry ? 'would be created' : 'created'} from config.example.json${tag}`);
  for (const c of changes) console.log(`config.json: ${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}${tag}`);
  if (exists && !changes.length) console.log('config.json: already up to date (not changed)');
}
