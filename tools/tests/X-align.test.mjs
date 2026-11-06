// Frame Studio — tests for shared/align.js (script ↔ ASR alignment), setTranscript/addCaptions with `script`,
// and the CLI's --script-file reader. Uses the real Chordix workshop files READ-ONLY (never written).
// Run: node "tools/tests/X-align.test.mjs"

import assert from 'node:assert/strict';
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const align = await import(new URL('shared/align.js', ROOT).href);
const { applyOps, resolveTime } = await import(new URL('shared/ops.js', ROOT).href);
const { newProject } = await import(new URL('shared/model.js', ROOT).href);
const cli = await import(new URL('cli/cutx.mjs', ROOT).href);
const { alignScriptToAsr, letterKey, tokenizeScript, asrWords, matchingBlocks } = align;

// Real Chordix workshop data (read-only). Location comes from config.json → chordix.workshop; skipped when absent.
const { getConfig, resolvePath } = await import(new URL('server/config.mjs', ROOT).href);
const WS_ROOT = getConfig()?.chordix?.workshop ? resolvePath(getConfig().chordix.workshop) : null;
const WS = WS_ROOT ? `${WS_ROOT}/projects/05-בלדה-עממית` : null;
const ASR_FILE = WS ? `${WS}/vo3-asr.json` : '';
const VIDEO_JSON = WS ? `${WS}/video.json` : '';
const HAVE_REAL = !!WS && fs.existsSync(ASR_FILE) && fs.existsSync(VIDEO_JSON);
const ASR = HAVE_REAL ? JSON.parse(fs.readFileSync(ASR_FILE, 'utf8').replace(/^\uFEFF/, '')) : null;
const VJ = HAVE_REAL ? JSON.parse(fs.readFileSync(VIDEO_JSON, 'utf8').replace(/^\uFEFF/, '')) : null;
const SCRIPT = VJ ? VJ.script : '';

const tests = [];
const test = (name, fn, { real = name.startsWith('real ') } = {}) => tests.push({ name, fn, real });
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ? msg + ': ' : ''}expected ≈${b} (±${eps}), got ${a}`);
const byWord = (words, w, n = 0) => words.filter((x) => x.w === w)[n];

// ───────────── real workshop files ─────────────

test('real 05: every script token, in order, with ASR times', () => {
  const r = alignScriptToAsr(SCRIPT, ASR, { hot: VJ.hot });
  const tokens = tokenizeScript(SCRIPT);
  assert.equal(r.method, 'letters');
  assert.equal(r.words.length, tokens.length);
  assert.equal(tokens.length, 44);
  assert.equal(r.asrCount, 42);
  assert.deepEqual(r.words.map((w) => w.w), tokens, 'the script words (with punctuation) are kept exactly');
  assert.ok(r.coverage > 0.85, `coverage ${r.coverage}`);
  for (let i = 1; i < r.words.length; i++) {
    assert.ok(r.words[i].s >= r.words[i - 1].s - 1e-9, `monotonic start at ${i}`);
    assert.ok(r.words[i].s >= r.words[i - 1].e - 1e-6, `no overlap at ${i} (${r.words[i - 1].w} → ${r.words[i].w})`);
  }
  for (const w of r.words) assert.ok(w.e >= w.s, `e >= s for ${w.w}`);
}, { real: true });

test('real 05: "ובום!" lands near 12.0 s and "סולם!" near 10.0 s (ASR: "וום," / "סלם,")', () => {
  const { words } = alignScriptToAsr(SCRIPT, ASR);
  near(byWord(words, 'ובום!').s, 12.0, 0.05, 'ובום!');
  near(byWord(words, 'ובום!').e, 12.16, 0.05, 'ובום! end');
  near(byWord(words, 'סולם!').s, 10.02, 0.05, 'סולם!');
  near(byWord(words, 'הקובץ').s, 8.4, 0.02, 'הקובץ (ASR "הכובץ")');
  near(byWord(words, 'הדפדפן!').s, 7.28, 0.02, 'הדפדפן! (ASR "הדבדפן,")');
  near(byWord(words, 'ועכשיו?').s, 15.28, 0.02, 'ועכשיו? (ASR "ואחשו?")');
  near(byWord(words, 'רגע!').s, 0, 0.02);
  near(byWord(words, 'קורדיקס!').s, 17.06, 0.02);
  // exact ASR times when the words match 1:1
  near(byWord(words, 'וקורדיקס').s, 5.34, 1e-6);
  near(byWord(words, 'וקורדיקס').e, 5.78, 1e-6);
}, { real: true });

test('real 05: ASR merged "לא עולה" into "הולה" → the time is split by letters', () => {
  const { words } = alignScriptToAsr(SCRIPT, ASR);
  const la = byWord(words, 'לא'), ola = byWord(words, 'עולה');
  near(la.s, 9.1, 1e-6);
  near(ola.e, 9.34, 1e-6);
  near(la.e, ola.s, 1e-6, 'contiguous');
  near(la.e, 9.1 + (0.24 * 2) / 6, 0.005, 'לא = 2 of 6 letters');
}, { real: true });

test('real 05: a word the ASR dropped ("רק") shares the neighbour proportionally', () => {
  const { words, changes } = alignScriptToAsr(SCRIPT, ASR);
  const tsarich = byWord(words, 'צריך'), rak = byWord(words, 'רק'), lehit = byWord(words, 'להתחבר!');
  near(tsarich.s, 18.24, 1e-6);
  assert.ok(rak.s >= tsarich.e - 1e-6 && rak.e > rak.s + 0.05, `רק gets real time ${rak.s}–${rak.e}`);
  near(lehit.e, 19.0, 1e-6);
  near(rak.e, lehit.s, 1e-6);
  assert.ok(changes.some((c) => c.asr === 'להתחבר.' && c.script === 'רק להתחבר!'));
}, { real: true });

test('real 05: changes list the Whisper misspellings', () => {
  const { changes } = alignScriptToAsr(SCRIPT, ASR);
  const has = (a, s) => changes.some((c) => c.asr === a && c.script === s);
  assert.ok(has('וום,', 'ובום!'));
  assert.ok(has('סלם,', 'סולם!'));
  assert.ok(has('הכובץ', 'הקובץ'));
  assert.ok(has('הולה', 'לא עולה'));
  assert.ok(!changes.some((c) => c.asr === 'וקורדיקס'), 'unchanged words are not reported');
}, { real: true });

test('real 05: setTranscript {words, script} → word refs resolve to the corrected words', () => {
  const P0 = newProject({ id: 'x-align' });
  const { project: P, results } = applyOps(P0, [{ op: 'setTranscript', words: ASR, script: SCRIPT, hot: VJ.hot, mediaId: 'm_vo' }]);
  assert.ok(results[0].ok, results[0].error);
  assert.equal(results[0].count, 44);
  assert.equal(results[0].method, 'letters');
  assert.ok(!(results[0].warnings || []).length, `no warnings: ${results[0].warnings}`);
  assert.equal(P.transcript.mediaId, 'm_vo');
  assert.deepEqual(P.transcript.words.map((w) => w.w), tokenizeScript(SCRIPT));
  near(resolveTime(P, 'word:ובום!'), 12.0, 0.05);
  near(resolveTime(P, 'word:סולם!'), 10.02, 0.05);
  near(resolveTime(P, { word: 'הקובץ' }), 8.4, 0.02);
  assert.ok(P.transcript.words.find((w) => w.w === 'ובום!').hot, 'hot flag from hot list');
  // ASR spellings are gone
  assert.throws(() => resolveTime(P, 'word:וום,'), /לא נמצאה/);
}, { real: true });

test('real 05: setTranscript words:"transcript" + script re-aligns the existing transcript (mediaId kept)', () => {
  let P = applyOps(newProject({ id: 'x-align' }), [{ op: 'setTranscript', words: ASR, mediaId: 'm_vo' }]).project;
  assert.equal(P.transcript.words.length, 42);
  const r = applyOps(P, [{ op: 'setTranscript', words: 'transcript', script: SCRIPT }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  P = r.project;
  assert.equal(P.transcript.words.length, 44);
  assert.equal(P.transcript.mediaId, 'm_vo');
  near(resolveTime(P, 'word:ובום!'), 12.0, 0.05);
  // the same with words omitted
  const r2 = applyOps(applyOps(newProject({ id: 'y' }), [{ op: 'setTranscript', words: ASR }]).project, [{ op: 'setTranscript', script: SCRIPT }]);
  assert.ok(r2.results[0].ok);
  assert.equal(r2.project.transcript.words.length, 44);
}, { real: true });

test('real 05: addCaptions uses the corrected transcript as is (script words + punctuation, chunks from video.json)', () => {
  const P0 = applyOps(newProject({ id: 'x-align' }), [{ op: 'setTranscript', words: ASR, script: SCRIPT }]).project;
  const r = applyOps(P0, [{ op: 'addCaptions', words: 'transcript', style: 'chordix', chunks: VJ.chunks, hot: VJ.hot }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  assert.deepEqual(r.results[0].chunks, VJ.chunks);
  const caps = Object.values(r.project.clips).filter((c) => c.type === 'caption').sort((a, b) => a.start - b.start);
  const all = caps.flatMap((c) => c.caption.words.map((w) => w.w));
  assert.deepEqual(all, tokenizeScript(SCRIPT));
  const boom = caps.find((c) => c.caption.words.some((w) => w.w === 'ובום!'));
  near(boom.start, 12.0, 0.05);
  assert.equal(boom.text.content, 'ובום!');
}, { real: true });

test('real 05: addCaptions {words: asr, script} aligns for the captions only', () => {
  const P0 = applyOps(newProject({ id: 'x-align' }), [{ op: 'setTranscript', words: ASR }]).project;
  const r = applyOps(P0, [{ op: 'addCaptions', words: ASR, script: SCRIPT, maxWords: 3 }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const words = Object.values(r.project.clips).filter((c) => c.type === 'caption').flatMap((c) => c.caption.words);
  assert.ok(words.some((w) => w.w === 'סולם!' && Math.abs(w.s - 10.02) < 0.05));
  assert.equal(r.project.transcript.words.length, 42, 'transcript untouched');
}, { real: true });

test('real 05: cli readScriptArg reads video.json "script" (and plain --script)', () => {
  assert.equal(cli.readScriptArg({ 'script-file': VIDEO_JSON }), SCRIPT.trim());
  assert.equal(cli.readScriptArg({ script: '  רגע! יש  ' }), 'רגע! יש');
  assert.equal(cli.readScriptArg({}), null);
  assert.throws(() => cli.readScriptArg({ 'script-file': `${WS}/nope.txt` }), /לא נמצא/);
}, { real: true });

// ───────────── synthetic ─────────────

test('letterKey: niqqud/punctuation out, final letters = regular, latin lowercase', () => {
  assert.equal(letterKey('סוּלָם!'), 'סולמ');
  assert.equal(letterKey('"הַקּוֹבֶץ,"'), 'הקובצ');
  assert.equal(letterKey('Chordix-2'), 'chordix2');
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
  const r = alignScriptToAsr('קורדיקס! חינם', [['קור', 1.0, 1.2], ['דיקס', 1.2, 1.6], ['חינם', 1.8, 2.2]]);
  assert.deepEqual(r.words.map((w) => [w.w, w.s, w.e]), [['קורדיקס!', 1.0, 1.6], ['חינם', 1.8, 2.2]]);
  assert.ok(r.changes.some((c) => c.asr === 'קור דיקס' && c.script === 'קורדיקס!'));
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
  const r = alignScriptToAsr('רגע — יש', [['רגע', 0, 0.4], ['יש', 0.6, 0.8]]);
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
let pass = 0, fail = 0, skip = 0;
for (const t of tests) {
  if (t.real && !HAVE_REAL) { skip++; console.log(`- ${t.name} (דילוג: קבצי הסדנה לא נמצאו)`); continue; }
  try { await t.fn(); pass++; console.log(`✓ ${t.name}`); }
  catch (e) { fail++; console.log(`✗ ${t.name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e}`); }
}
console.log(`\n${pass}/${pass + fail} בדיקות עברו${skip ? ` (${skip} דולגו)` : ''}`);
if (fail) process.exitCode = 1;
