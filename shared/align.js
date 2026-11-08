// shared/align.js — script ↔ ASR alignment (pure ES module, Browser + Node, no built-ins).
//
// Whisper misspells Hebrew ("גבניות," for "עגבניות.", "שבורת." for "שבורות.", "המכבת" for "המחבת") and sometimes merges
// ("לריקה" for "לא ריקה") or drops ("עם") words. The script has the correct words, the ASR has the times.
// alignScriptToAsr() gives every script token (split on spaces, punctuation kept) the time of the speech it matches:
//
//   1. letters only (Hebrew incl. finals → regular forms, Latin lowercase, digits) of the whole script and the whole ASR
//   2. difflib-style matching blocks (SequenceMatcher(None, a, b, autojunk=False), as in Python's difflib)
//      → every script letter is matched, "replaced" (inside a differing stretch: mapped
//      proportionally onto the ASR letters of that stretch) or "deleted" (no ASR letters at all)
//   3. tokens that share an ASR word form a group: one ASR word ↔ several tokens (ASR merged them) → the ASR time is
//      split between the tokens in proportion to their letter counts; one token ↔ several ASR words (ASR split it)
//      → first start … last end; crossing groups → boundaries at the matched letters
//   4. tokens with no ASR letters at all (a word the ASR dropped) → into a real pause when there is one, otherwise
//      they share the slower neighbouring group proportionally
//   5. coverage (matched script letters) < minCoverage → fallback: by index (equal counts) or proportional over the span
//
// alignScriptToAsr(script, asr, { hot?, minCoverage? }) →
//   { words:[{w,s,e,hot?}], coverage, method:"letters"|"index"|"asr", tokens, asrCount, changes:[{asr, script, s, e}] }

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Comparison letters of a word: Hebrew letters (finals → regular), latin lowercase, digits; nothing else. */
export function letterKey(s) {
  return String(s ?? '').normalize('NFC').toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^א-תa-z0-9]/g, '');
}

/** Script text (or an array of tokens) → tokens, split on whitespace, punctuation kept. */
export function tokenizeScript(script) {
  if (Array.isArray(script)) return script.map((x) => String(x ?? '').trim()).filter(Boolean);
  return String(script ?? '').trim().split(/\s+/).filter(Boolean);
}

/** ASR in any common shape → [{w,s,e}] sorted by start. [[w,s,e]…] | [{w|word|text, s|start, e|end}] | {words|asr|segments|transcript}. */
export function asrWords(input) {
  let list = input;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    if (Array.isArray(list.words)) list = list.words;
    else if (Array.isArray(list.asr)) list = list.asr;
    else if (Array.isArray(list.segments)) list = list.segments.flatMap((sg) => (sg && sg.words) || []);
    else if (list.transcript && Array.isArray(list.transcript.words)) list = list.transcript.words;
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    let w, s, e;
    if (Array.isArray(x)) [w, s, e] = x;
    else if (x && typeof x === 'object') { w = x.w ?? x.word ?? x.text; s = x.s ?? x.start; e = x.e ?? x.end; }
    else continue;
    if (typeof w !== 'string' || !w.trim()) continue;
    s = Number(s); e = Number(e);
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e < s) e = s;
    out.push({ w: w.trim(), s, e });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks() without the sentinel → [[i, j, n]…]. */
export function matchingBlocks(a, b) {
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    const c = b[j];
    if (!b2j.has(c)) b2j.set(c, []);
    b2j.get(c).push(j);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  };
  const queue = [[0, a.length, 0, b.length]];
  const blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return blocks;
}

/** Split [S,E] between items in proportion to weights → [[s,e]…] (all-zero weights → equal parts). */
function splitSpan(S, E, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const ws = total > 0 ? weights : weights.map(() => 1);
  const tot = total > 0 ? total : ws.length;
  const out = [];
  let acc = 0;
  for (const w of ws) {
    const s = S + ((E - S) * acc) / tot;
    acc += w;
    out.push([s, S + ((E - S) * acc) / tot]);
  }
  return out;
}

/**
 * Align script tokens to ASR word times by letters.
 * script: string | [tokens]; asr: see asrWords(); opts: { hot?: [words], minCoverage?: 0.3 }
 */
export function alignScriptToAsr(script, asr, opts = {}) {
  const tokens = tokenizeScript(script);
  const A = asrWords(asr);
  const hotSet = new Set((Array.isArray(opts.hot) ? opts.hot : opts.hot ? [opts.hot] : []).map(letterKey).filter(Boolean));
  const mk = (w, s, e) => {
    const o = { w, s: r3(Math.max(0, s)), e: r3(Math.max(0, e, s)) };
    if (hotSet.size && hotSet.has(letterKey(w))) o.hot = true;
    return o;
  };
  if (!tokens.length) return { words: A.map((x) => mk(x.w, x.s, x.e)), coverage: 1, method: 'asr', tokens: 0, asrCount: A.length, changes: [] };
  if (!A.length) return { words: [], coverage: 0, method: 'none', tokens: tokens.length, asrCount: 0, changes: [] };

  // 1. letters
  const tokKeys = tokens.map(letterKey);
  const sTok = [];
  let S = '';
  tokKeys.forEach((k, i) => { S += k; for (let q = 0; q < k.length; q++) sTok.push(i); });
  const aWord = [], aLs = [], aLe = [];
  let AS = '';
  A.forEach((x, j) => {
    const k = letterKey(x.w);
    AS += k;
    for (let q = 0; q < k.length; q++) {
      aWord.push(j);
      aLs.push(x.s + ((x.e - x.s) * q) / k.length);
      aLe.push(x.s + ((x.e - x.s) * (q + 1)) / k.length);
    }
  });

  // 2. matching blocks → per script letter: exact ASR letter, or proportional inside a "replace" stretch, or -1
  const map = new Int32Array(S.length).fill(-1);
  let matched = 0;
  const blocks = AS.length && S.length ? matchingBlocks(S, AS) : [];
  let pi = 0, pj = 0;
  for (const [i, j, n] of [...blocks, [S.length, AS.length, 0]]) {
    if (i > pi && j > pj) for (let p = pi; p < i; p++) map[p] = pj + Math.floor(((p - pi) * (j - pj)) / (i - pi));
    for (let k = 0; k < n; k++) map[i + k] = j + k;
    matched += n;
    pi = i + n; pj = j + n;
  }
  const coverage = S.length ? matched / S.length : 0;
  const minCoverage = Number.isFinite(opts.minCoverage) ? opts.minCoverage : 0.3;

  if (coverage < minCoverage) {
    // 5. fallback
    let words;
    if (tokens.length === A.length) words = tokens.map((t, i) => mk(t, A[i].s, A[i].e));
    else {
      const spans = splitSpan(A[0].s, A[A.length - 1].e, tokKeys.map((k) => Math.max(1, k.length)));
      words = tokens.map((t, i) => mk(t, spans[i][0], spans[i][1]));
    }
    return { words, coverage: r3(coverage), method: 'index', tokens: tokens.length, asrCount: A.length, changes: [] };
  }

  // 3. token → ASR word range (through mapped letters)
  const T = tokens.map((w, i) => ({ i, w, n: tokKeys[i].length, a0: Infinity, a1: -1, first: -1, last: -1, mapped: 0 }));
  for (let p = 0; p < S.length; p++) {
    const t = T[sTok[p]];
    if (t.first < 0) t.first = p;
    t.last = p;
    if (map[p] >= 0) { t.mapped++; const j = aWord[map[p]]; if (j < t.a0) t.a0 = j; if (j > t.a1) t.a1 = j; }
  }
  // a token with most of its letters missing from the ASR only touched a neighbour by chance (e.g. "שתיים" sharing
  // the "ש" of "שלוש") — treat it as dropped instead of letting it steal that word
  for (const t of T) if (t.a1 >= 0 && t.mapped * 2 < t.n) { t.a0 = Infinity; t.a1 = -1; }
  // groups of tokens sharing ASR words; tokens without ASR letters are "orphans" (kept in order)
  const items = []; // { kind:"g", toks:[…], a0, a1 } | { kind:"o", toks:[…] }
  for (const t of T) {
    if (t.n === 0) continue; // punctuation-only tokens are placed at the end
    const last = items[items.length - 1];
    if (t.a1 < 0) {
      if (last && last.kind === 'o') last.toks.push(t); else items.push({ kind: 'o', toks: [t] });
      continue;
    }
    if (last && last.kind === 'g' && last.a1 >= t.a0) { last.toks.push(t); last.a1 = Math.max(last.a1, t.a1); }
    else items.push({ kind: 'g', toks: [t], a0: t.a0, a1: t.a1, prop: false });
  }
  const span = (g) => (g.S !== undefined ? [g.S, g.E] : [A[g.a0].s, A[g.a1].e]);
  const changes = [];
  // 4. orphans: free ASR words between the neighbours → their own group; a real pause → there; else the slower neighbour
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.kind !== 'o') continue;
    const P = k > 0 && items[k - 1].kind === 'g' ? items[k - 1] : null;
    const N = k + 1 < items.length && items[k + 1].kind === 'g' ? items[k + 1] : null;
    const lo = P ? P.a1 + 1 : 0, hi = N ? N.a0 - 1 : A.length - 1;
    if (hi >= lo) { Object.assign(it, { kind: 'g', a0: lo, a1: hi, prop: true }); continue; }
    const letters = it.toks.reduce((a, t) => a + t.n, 0);
    const gs = P ? span(P)[1] : 0;
    const ge = N ? span(N)[0] : gs + 0.15 * letters;
    if (ge - gs >= 0.15) {
      // a real pause next to the dropped word(s): put them there, right after the previous word (or right before the next)
      const d = Math.min(ge - gs, 0.08 * letters + 0.1);
      const pad = Math.min(0.03, (ge - gs - d) / 2);
      Object.assign(it, { kind: 'g', S: P ? gs + pad : ge - pad - d, prop: true });
      it.E = it.S + d;
      changes.push({ asr: '', script: it.toks.map((t) => t.w).join(' '), s: r3(it.S), e: r3(it.E) });
      continue;
    }
    const rate = (g) => { const [s, e] = span(g); return (e - s) / Math.max(1, g.toks.reduce((a, t) => a + t.n, 0)); };
    const target = P && N ? (rate(N) > rate(P) ? N : P) : P || N;
    if (!target) continue;
    if (target === N) target.toks.unshift(...it.toks); else target.toks.push(...it.toks);
    target.prop = true;
    it.kind = 'x';
  }
  const groups = items.filter((g) => g.kind === 'g');
  const times = new Map(); // token index → [s, e]
  for (const g of groups) {
    const [gs, ge] = span(g);
    if (g.toks.length === 1) { times.set(g.toks[0].i, [gs, ge]); }
    else if (g.prop || g.a0 === g.a1 || g.S !== undefined) {
      splitSpan(gs, ge, g.toks.map((t) => t.n)).forEach((sp, q) => times.set(g.toks[q].i, sp));
    } else {
      // crossing group (several tokens ↔ several ASR words): boundaries at the matched letters
      const prop = splitSpan(gs, ge, g.toks.map((t) => t.n));
      const bounds = [gs];
      for (let q = 0; q < g.toks.length - 1; q++) {
        const L = g.toks[q], R = g.toks[q + 1];
        const ql = map[L.last], qr = map[R.first];
        let b = ql >= 0 && qr >= 0 ? (aLe[ql] + aLs[qr]) / 2 : ql >= 0 ? aLe[ql] : qr >= 0 ? aLs[qr] : prop[q][1];
        b = Math.min(ge, Math.max(bounds[bounds.length - 1], b));
        bounds.push(b);
      }
      bounds.push(ge);
      g.toks.forEach((t, q) => times.set(t.i, [bounds[q], bounds[q + 1]]));
    }
    if (g.a0 !== undefined && g.S === undefined) {
      const asrText = A.slice(g.a0, g.a1 + 1).map((x) => x.w).join(' ');
      const scriptText = g.toks.map((t) => t.w).join(' ');
      if (asrText !== scriptText) changes.push({ asr: asrText, script: scriptText, s: r3(gs), e: r3(ge) });
    }
  }
  // ASR words no token claimed (the ASR heard something that is not in the script)
  const claimed = new Uint8Array(A.length);
  for (const g of groups) if (g.a0 !== undefined && g.S === undefined) for (let j = g.a0; j <= g.a1; j++) claimed[j] = 1;
  A.forEach((x, j) => { if (!claimed[j]) changes.push({ asr: x.w, script: '', s: r3(x.s), e: r3(x.e) }); });
  changes.sort((a, b) => a.s - b.s);

  // assemble in script order; punctuation-only tokens sit at the previous token's end
  const words = [];
  let prevE = 0, prevS = 0;
  for (const t of T) {
    let tm = times.get(t.i);
    if (!tm) { const nx = T.slice(t.i + 1).map((u) => times.get(u.i)).find(Boolean); const at = words.length ? prevE : nx ? nx[0] : 0; tm = [at, at]; }
    let [s, e] = tm;
    if (s < prevS) s = prevS;
    if (e < s) e = s;
    words.push(mk(t.w, s, e));
    prevS = s; prevE = e;
  }
  return { words, coverage: r3(coverage), method: 'letters', tokens: tokens.length, asrCount: A.length, changes };
}
