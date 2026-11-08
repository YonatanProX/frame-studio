// Frame Studio — tests for shared/align.js (script ↔ ASR alignment), setTranscript/addCaptions with `script`,
// and the CLI's --script-file reader. Self-contained: the fixtures are built in the test.
// Run: node "tools/tests/X-align.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url);
const align = await import(new URL('shared/align.js', ROOT).href);
const { applyOps, resolveTime } = await import(new URL('shared/ops.js', ROOT).href);
const { newProject } = await import(new URL('shared/model.js', ROOT).href);
const cli = await import(new URL('cli/cutx.mjs', ROOT).href);
const { alignScriptToAsr, letterKey, tokenizeScript, asrWords, matchingBlocks } = align;

// Synthetic fixture: a Hebrew voice-over script (a cooking short) and the word list a Whisper-style ASR gave for it.
// The ASR misspells ("המכבת" for "המחבת", "גבניות," for "עגבניות.", "שבורת." for "שבורות.", "ואחשו?" for "ועכשיו?"),
// merges two words ("לריקה" for "לא ריקה") and drops one ("עם").
const SCRIPT = 'שקשוקה. יש לכם ביצים, בלי רעיון? בואו נבשל יחד. מחממים את המחבת, והשמן מתחמם לאט. הבצל נכנס ראשון. המחבת כבר לא ריקה בכלל. עגבניות. ביצים שבורות. ועכשיו? פשוט מחכים. בסוף, מגישים עם לחם.';
const ASR = [
  ['שקשוקה,', 0.0, 0.8], ['יש', 1.06, 1.42], ['לכם', 1.42, 1.64], ['ביצים', 1.64, 2.1], ['בלי', 2.1, 2.3], ['רעיון?', 2.3, 2.9],
  ['בואו', 3.46, 3.88], ['נבשל', 3.88, 3.96], ['יחד,', 3.96, 4.12], ['מחממים', 4.52, 4.8], ['את', 4.8, 4.9], ['המכבת,', 4.9, 5.3],
  ['והשמן', 5.34, 5.78], ['מתחמם', 5.78, 6.08], ['לאט,', 6.08, 6.48], ['הבצל', 6.8, 7.0], ['נכנס', 7.0, 7.28], ['רישון,', 7.28, 7.9],
  ['המכבת', 8.4, 8.8], ['כבר', 8.8, 9.1], ['לריקה', 9.1, 9.34], ['בכלל.', 9.34, 9.9], ['גבניות,', 10.4, 10.6], ['ביצים', 10.7, 11.2],
  ['שבורת.', 11.2, 11.8], ['ואחשו?', 12.2, 12.7], ['פשוט', 12.8, 13.1], ['מחכים,', 13.1, 13.8], ['בסוף,', 14.2, 14.6],
  ['מגישים', 14.6, 14.9], ['לחם,', 14.9, 15.6],
];
const HOT = ['שקשוקה.', 'עגבניות.', 'שבורות.'];
const CHUNKS = [1, 3, 2, 3, 3, 3, 3, 2, 3, 1, 2, 1, 2, 1, 3];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ? msg + ': ' : ''}expected ≈${b} (±${eps}), got ${a}`);
const byWord = (words, w, n = 0) => words.filter((x) => x.w === w)[n];

// ───────────── script + misspelled ASR ─────────────

test('fixture: every script token, in order, with ASR times', () => {
  const r = alignScriptToAsr(SCRIPT, ASR, { hot: HOT });
  const tokens = tokenizeScript(SCRIPT);
  assert.equal(r.method, 'letters');
  assert.equal(r.words.length, tokens.length);
  assert.equal(tokens.length, 33);
  assert.equal(r.asrCount, 31);
  assert.deepEqual(r.words.map((w) => w.w), tokens, 'the script words (with punctuation) are kept exactly');
  assert.ok(r.coverage > 0.85, `coverage ${r.coverage}`);
  for (let i = 1; i < r.words.length; i++) {
    assert.ok(r.words[i].s >= r.words[i - 1].s - 1e-9, `monotonic start at ${i}`);
    assert.ok(r.words[i].s >= r.words[i - 1].e - 1e-6, `no overlap at ${i} (${r.words[i - 1].w} → ${r.words[i].w})`);
  }
  for (const w of r.words) assert.ok(w.e >= w.s, `e >= s for ${w.w}`);
});

test('fixture: misspelled words get the time of the speech they match', () => {
  const { words } = alignScriptToAsr(SCRIPT, ASR);
  near(byWord(words, 'עגבניות.').s, 10.4, 0.05, 'עגבניות. (ASR "גבניות,")');
  near(byWord(words, 'עגבניות.').e, 10.6, 0.05, 'עגבניות. end');
  near(byWord(words, 'שבורות.').s, 11.2, 0.05, 'שבורות. (ASR "שבורת.")');
  near(byWord(words, 'המחבת').s, 8.4, 0.02, 'המחבת (ASR "המכבת")');
  near(byWord(words, 'ראשון.').s, 7.28, 0.02, 'ראשון. (ASR "רישון,")');
  near(byWord(words, 'ועכשיו?').s, 12.2, 0.02, 'ועכשיו? (ASR "ואחשו?")');
  near(byWord(words, 'שקשוקה.').s, 0, 0.02);
  // exact ASR times when the words match 1:1
  near(byWord(words, 'והשמן').s, 5.34, 1e-6);
  near(byWord(words, 'והשמן').e, 5.78, 1e-6);
  near(byWord(words, 'מחכים.').s, 13.1, 1e-6);
  near(byWord(words, 'מחכים.').e, 13.8, 1e-6);
});

test('fixture: ASR merged "לא ריקה" into "לריקה" → the time is split by letters', () => {
  const { words } = alignScriptToAsr(SCRIPT, ASR);
  const la = byWord(words, 'לא'), ola = byWord(words, 'ריקה');
  near(la.s, 9.1, 1e-6);
  near(ola.e, 9.34, 1e-6);
  near(la.e, ola.s, 1e-6, 'contiguous');
  near(la.e, 9.1 + (0.24 * 2) / 6, 0.005, 'לא = 2 of 6 letters');
});

test('fixture: a word the ASR dropped ("עם") shares the neighbour proportionally', () => {
  const { words, changes } = alignScriptToAsr(SCRIPT, ASR);
  const tsarich = byWord(words, 'מגישים'), rak = byWord(words, 'עם'), lehit = byWord(words, 'לחם.');
  near(tsarich.s, 14.6, 1e-6);
  assert.ok(rak.s >= tsarich.e - 1e-6 && rak.e > rak.s + 0.05, `עם gets real time ${rak.s}–${rak.e}`);
  near(lehit.e, 15.6, 1e-6);
  near(rak.e, lehit.s, 1e-6);
  assert.ok(changes.some((c) => c.asr === 'לחם,' && c.script === 'עם לחם.'));
});

test('fixture: changes list the ASR misspellings', () => {
  const { changes } = alignScriptToAsr(SCRIPT, ASR);
  const has = (a, s) => changes.some((c) => c.asr === a && c.script === s);
  assert.ok(has('גבניות,', 'עגבניות.'));
  assert.ok(has('שבורת.', 'שבורות.'));
  assert.ok(has('המכבת', 'המחבת'));
  assert.ok(has('לריקה', 'לא ריקה'));
  assert.ok(!changes.some((c) => c.asr === 'והשמן'), 'unchanged words are not reported');
});

test('fixture: setTranscript {words, script} → word refs resolve to the corrected words', () => {
  const P0 = newProject({ id: 'x-align' });
  const { project: P, results } = applyOps(P0, [{ op: 'setTranscript', words: ASR, script: SCRIPT, hot: HOT, mediaId: 'm_vo' }]);
  assert.ok(results[0].ok, results[0].error);
  assert.equal(results[0].count, 33);
  assert.equal(results[0].method, 'letters');
  assert.ok(!(results[0].warnings || []).length, `no warnings: ${results[0].warnings}`);
  assert.equal(P.transcript.mediaId, 'm_vo');
  assert.deepEqual(P.transcript.words.map((w) => w.w), tokenizeScript(SCRIPT));
  near(resolveTime(P, 'word:עגבניות.'), 10.4, 0.05);
  near(resolveTime(P, 'word:שבורות.'), 11.2, 0.05);
  near(resolveTime(P, { word: 'המחבת', n: 1 }), 8.4, 0.02);
  assert.ok(P.transcript.words.find((w) => w.w === 'עגבניות.').hot, 'hot flag from hot list');
  // ASR spellings are gone
  assert.throws(() => resolveTime(P, 'word:ואחשו?'), /לא נמצאה/);
});

test('fixture: setTranscript words:"transcript" + script re-aligns the existing transcript (mediaId kept)', () => {
  let P = applyOps(newProject({ id: 'x-align' }), [{ op: 'setTranscript', words: ASR, mediaId: 'm_vo' }]).project;
  assert.equal(P.transcript.words.length, 31);
  const r = applyOps(P, [{ op: 'setTranscript', words: 'transcript', script: SCRIPT }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  P = r.project;
  assert.equal(P.transcript.words.length, 33);
  assert.equal(P.transcript.mediaId, 'm_vo');
  near(resolveTime(P, 'word:עגבניות.'), 10.4, 0.05);
  // the same with words omitted
  const r2 = applyOps(applyOps(newProject({ id: 'y' }), [{ op: 'setTranscript', words: ASR }]).project, [{ op: 'setTranscript', script: SCRIPT }]);
  assert.ok(r2.results[0].ok);
  assert.equal(r2.project.transcript.words.length, 33);
});

test('fixture: addCaptions uses the corrected transcript as is (script words + punctuation, explicit chunks)', () => {
  const P0 = applyOps(newProject({ id: 'x-align' }), [{ op: 'setTranscript', words: ASR, script: SCRIPT }]).project;
  const r = applyOps(P0, [{ op: 'addCaptions', words: 'transcript', style: 'popWords', chunks: CHUNKS, hot: HOT }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  assert.deepEqual(r.results[0].chunks, CHUNKS);
  const caps = Object.values(r.project.clips).filter((c) => c.type === 'caption').sort((a, b) => a.start - b.start);
  const all = caps.flatMap((c) => c.caption.words.map((w) => w.w));
  assert.deepEqual(all, tokenizeScript(SCRIPT));
  const hop = caps.find((c) => c.caption.words.some((w) => w.w === 'עגבניות.'));
  near(hop.start, 10.4, 0.05);
  assert.equal(hop.text.content, 'עגבניות.');
});

test('fixture: addCaptions {words: asr, script} aligns for the captions only', () => {
  const P0 = applyOps(newProject({ id: 'x-align' }), [{ op: 'setTranscript', words: ASR }]).project;
  const r = applyOps(P0, [{ op: 'addCaptions', words: ASR, script: SCRIPT, maxWords: 3 }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const words = Object.values(r.project.clips).filter((c) => c.type === 'caption').flatMap((c) => c.caption.words);
  assert.ok(words.some((w) => w.w === 'שבורות.' && Math.abs(w.s - 11.2) < 0.05));
  assert.equal(r.project.transcript.words.length, 31, 'transcript untouched');
});

test('cli readScriptArg reads {"script"} from a .json file, a text file and plain --script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-x-align-'));
  try {
    const json = path.join(dir, 'תסריט.json');
    fs.writeFileSync(json, JSON.stringify({ script: SCRIPT, hot: HOT }));
    assert.equal(cli.readScriptArg({ 'script-file': json }), SCRIPT.trim());
    const txt = path.join(dir, 'תסריט.txt');
    fs.writeFileSync(txt, `﻿${SCRIPT}\n`);
    assert.equal(cli.readScriptArg({ 'script-file': txt }), SCRIPT.trim());
    assert.equal(cli.readScriptArg({ script: '  שקשוקה. יש  ' }), 'שקשוקה. יש');
    assert.equal(cli.readScriptArg({}), null);
    assert.throws(() => cli.readScriptArg({ 'script-file': path.join(dir, 'nope.txt') }), /לא נמצא/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ───────────── synthetic ─────────────

test('letterKey: niqqud/punctuation out, final letters = regular, latin lowercase', () => {
  assert.equal(letterKey('לֶחֶם!'), 'לחמ');
  assert.equal(letterKey('"הַתַּבְלִין,"'), 'התבלינ');
  assert.equal(letterKey('Frame-2'), 'frame2');
  assert.equal(letterKey('—'), '');
  assert.deepEqual(tokenizeScript('  א  ב\nג '), ['א', 'ב', 'ג']);
  assert.deepEqual(tokenizeScript(['א', ' ', 'ב ']), ['א', 'ב']);
});

test('asrWords accepts [[w,s,e]], [{w,s,e}], {words}, faster-whisper segments', () => {
  const a = asrWords([['ב', 1, 1.5], { word: 'א', start: 0, end: 0.5 }]);
  assert.deepEqual(a.map((x) => x.w), ['א', 'ב']);
  assert.equal(asrWords({ segments: [{ words: [{ word: ' שלום', start: 0.1, end: 0.4 }] }] })[0].w, 'שלום');
  assert.equal(asrWords({ words: [['x', 0, 1]] }).length, 1);
});

test('matchingBlocks = difflib get_matching_blocks', () => {
  assert.deepEqual(matchingBlocks('abxcd', 'abcd'), [[0, 0, 2], [3, 2, 2]]);
  assert.deepEqual(matchingBlocks('', 'abc'), []);
});

test('identical script → exact ASR times, no changes', () => {
  const asr = [['שלום', 0.1, 0.5], ['לכם', 0.6, 0.9]];
  const r = alignScriptToAsr('שלום לכם', asr);
  assert.deepEqual(r.words, [{ w: 'שלום', s: 0.1, e: 0.5 }, { w: 'לכם', s: 0.6, e: 0.9 }]);
  assert.deepEqual(r.changes, []);
  assert.equal(r.coverage, 1);
});

test('ASR split one word in two → first start … last end', () => {
  const r = alignScriptToAsr('עגבניות! טריות', [['עגב', 1.0, 1.2], ['ניות', 1.2, 1.6], ['טריות', 1.8, 2.2]]);
  assert.deepEqual(r.words.map((w) => [w.w, w.s, w.e]), [['עגבניות!', 1.0, 1.6], ['טריות', 1.8, 2.2]]);
  assert.ok(r.changes.some((c) => c.asr === 'עגב ניות' && c.script === 'עגבניות!'));
});

test('ASR merged two words → proportional split by letters', () => {
  const r = alignScriptToAsr('יש לכם', [['ישלכם', 2.0, 2.5]]);
  near(r.words[0].s, 2.0, 1e-9);
  near(r.words[0].e, 2.2, 1e-9); // 2 of 5 letters
  near(r.words[1].s, 2.2, 1e-9);
  near(r.words[1].e, 2.5, 1e-9);
});

test('dropped word next to a real pause goes into the pause', () => {
  const r = alignScriptToAsr('אחת שתיים שלוש', [['אחת', 0, 0.4], ['שלוש', 1.4, 1.8]]);
  const two = r.words[1];
  assert.equal(two.w, 'שתיים');
  assert.ok(two.s >= 0.4 && two.e <= 1.4 && two.e - two.s > 0.2, `in the pause: ${two.s}–${two.e}`);
  assert.ok(r.changes.some((c) => c.asr === '' && c.script === 'שתיים'));
});

test('ASR word that is not in the script is reported and skipped', () => {
  const r = alignScriptToAsr('שלום לכם', [['שלום', 0, 0.4], ['אממ', 0.5, 0.7], ['לכם', 0.8, 1.1]]);
  assert.deepEqual(r.words.map((w) => [w.w, w.s]), [['שלום', 0], ['לכם', 0.8]]);
  assert.ok(r.changes.some((c) => c.asr === 'אממ' && c.script === ''));
});

test('punctuation-only token sits at the previous word end', () => {
  const r = alignScriptToAsr('שקשוקה — יש', [['שקשוקה', 0, 0.4], ['יש', 0.6, 0.8]]);
  assert.equal(r.words.length, 3);
  assert.deepEqual([r.words[1].w, r.words[1].s, r.words[1].e], ['—', 0.4, 0.4]);
});

test('unrelated script → index fallback + warning in setTranscript', () => {
  const asr = [['שלום', 0, 0.4], ['לכם', 0.5, 0.9]];
  const r = alignScriptToAsr('בננה תפוז', asr);
  assert.equal(r.method, 'index');
  assert.deepEqual(r.words.map((w) => [w.w, w.s]), [['בננה', 0], ['תפוז', 0.5]]);
  const o = applyOps(newProject({ id: 'z' }), [{ op: 'setTranscript', words: asr, script: 'בננה תפוז' }]);
  assert.ok(o.results[0].ok);
  assert.ok((o.results[0].warnings || []).some((w) => /לפי הסדר/.test(w)));
});

test('setTranscript with script but no words at all → Hebrew error', () => {
  const o = applyOps(newProject({ id: 'z' }), [{ op: 'setTranscript', script: 'שלום' }]);
  assert.equal(o.results[0].ok, false);
  assert.match(o.results[0].error, /אין זמני מילים/);
});

test('setTranscript without script is unchanged (plain words)', () => {
  const o = applyOps(newProject({ id: 'z' }), [{ op: 'setTranscript', words: [['וום,', 1, 1.2]] }]);
  assert.ok(o.results[0].ok);
  assert.deepEqual(o.project.transcript.words, [{ w: 'וום,', s: 1, e: 1.2 }]);
  assert.equal(o.results[0].coverage, undefined);
});

// ───────────── run ─────────────
let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`✓ ${t.name}`); }
  catch (e) { fail++; console.log(`✗ ${t.name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); }
}
console.log(`\n${pass}/${pass + fail} בדיקות עברו`);
if (fail) process.exitCode = 1;
