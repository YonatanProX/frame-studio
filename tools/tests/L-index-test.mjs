// Library self-test: real sound-library indexing + search + roles + resolveSound + fonts + LUTs + routes contract.
// Works on every copy: the Starter Pack (library/sounds/Starter Pack, 24 sounds) is always checked. The big-library
// checks (>= 300 sounds, searches like "כלב" / "רכבת") run only when a large library (e.g. Sonniss) is installed;
// otherwise they are reported as SKIP. Another Frame Studio folder via --root.
// Usage: node tools/tests/L-index-test.mjs [--root <frame studio folder>] [--fresh] [--port 7796]
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import * as L from '../../server/library.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const ROOT = path.resolve(arg('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PORT = Number(arg('--port')) || 7796;
L.configure({ root: ROOT, log: (...a) => console.log('  [lib]', ...a) });
const fresh = process.argv.includes('--fresh');
const idx = path.join(ROOT, 'library', 'sounds', 'index.json');
if (fresh && fs.existsSync(idx)) fs.unlinkSync(idx);

let fails = 0, skips = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const skip = (msg) => { console.log('SKIP ' + msg); skips++; };

const t0 = Date.now();
await L.ensureIndex();
const st = L.indexStatus();
const ms = Date.now() - t0;
console.log(`\nindex: ${st.count} sounds, ensureIndex took ${ms} ms (build ms recorded: ${st.ms}), errors: ${st.errors.length}`);
for (const e of st.errors) console.log('   error:', e.file, e.error);

const all = L.searchSounds({ limit: 5000 }).items;
const byCol = {}, byCat = {}, byLic = {};
for (const e of all) {
  byCol[e.collection] = (byCol[e.collection] || 0) + 1;
  byCat[`${e.collection} / ${e.category}`] = (byCat[`${e.collection} / ${e.category}`] || 0) + 1;
  byLic[e.license] = (byLic[e.license] || 0) + 1;
}
console.log('\nper collection:', byCol);
console.log('per license:', byLic);
console.log('per category:');
for (const [k, v] of Object.entries(byCat).sort((a, b) => a[0].localeCompare(b[0], 'he'))) console.log(`   ${String(v).padStart(4)}  ${k}`);
const roles = all.filter((e) => e.role);
const byRole = {};
for (const e of roles) byRole[e.role] = (byRole[e.role] || 0) + 1;
console.log(`\nroles: ${roles.length}`, byRole);
ok(roles.every((e) => e.collection !== 'מוזיקה'), 'roles only on sound effects');
ok(roles.every((e) => e.suggest && typeof e.suggest.gainDb === 'number' && e.suggest.len > 0), 'every role has a suggested gain/len');
ok(L.ROLE_LIST.every((r) => typeof r === 'string') && Object.keys(byRole).every((r) => L.ROLE_LIST.includes(r)), 'role names come from ROLE_LIST');

const starterN = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'sounds', 'Starter Pack', 'starter-pack.json'), 'utf8')).sounds.length; } catch { return 0; } })();
const starterIn = all.filter((e) => e.license === 'starter').length;
ok(starterN > 0 && starterIn === starterN, `Starter Pack fully indexed (${starterIn}/${starterN})`);
// "big library" = at least 300 sounds that are not the Starter Pack (Sonniss GDC bundles etc., downloaded by the user)
const BIG = all.length - starterIn >= 300;
if (BIG) ok(st.count >= 300, `indexed >= 300 sounds (${st.count})`);
else skip(`big-library checks — only ${all.length - starterIn} sounds besides the Starter Pack (add Sonniss to run them)`);
ok(all.every((e) => e.wave && e.wave.length === 64), 'every entry has a 64-point wave');
ok(all.every((e) => e.duration > 0), 'every entry has duration > 0');
ok(all.every((e) => typeof e.peakDb === 'number'), 'every entry has peakDb');
ok(all.every((e) => /^[0-9a-f]{12}$/.test(e.id)), 'ids are sha1[0:12]');
const misc = all.filter((e) => e.category === 'שונות');
if (BIG) ok(misc.length < all.length * 0.12, `"שונות" under 12% (${misc.length})`);
else ok(misc.length === 0, `Starter Pack sounds all have a real category (${misc.length} in "שונות")`);
if (misc.length) console.log('   misc:', misc.slice(0, 30).map((e) => e.name + ' {' + e.pack + '}').join(' | '));

// searches the Starter Pack alone must answer, then the ones that need a big library
const starterQueries = ['ווש', 'whoosh', 'בום', 'בס נופל', 'riser', 'עולה', 'מתח', 'קליק', 'ממשק', 'שעון', 'רוח', 'זום', 'גליץ׳', 'impact', 'braam', 'קסם'];
const bigQueries = ['נייר', 'קהל', 'מחיאות כפיים', 'גשם', 'כלב', 'מכונת כתיבה', 'קריקטורה', 'אווירה', 'רכבת', 'זכוכית'];
const queries = BIG ? [...starterQueries, ...bigQueries] : starterQueries;
if (!BIG) skip(`${bigQueries.length} big-library searches (${bigQueries.join(', ')})`);
console.log('\nsearch:');
for (const q of queries) {
  const t = process.hrtime.bigint();
  const r = L.searchSounds({ q, limit: 3 });
  const us = Number(process.hrtime.bigint() - t) / 1000;
  console.log(`   "${q}" → ${r.total} (${us.toFixed(0)} µs): ${r.items.map((e) => `${e.name} [${e.category}]`).join(' | ')}`);
  ok(r.total > 0, `search "${q}" has results`);
}
const dur = L.searchSounds({ q: 'ווש', max: 1.5, limit: 500 });
ok(dur.items.every((e) => e.duration <= 1.5), `duration filter max=1.5 (${dur.total})`);
const cat = L.searchSounds({ category: 'וושים ומעברים', limit: 5000 });
ok(cat.total > 0 && cat.items.every((e) => e.category === 'וושים ומעברים'), `category filter "וושים ומעברים" (${cat.total})`);
const roleF = L.searchSounds({ role: 'מעבר', limit: 5000 });
ok(roleF.total > 0 && roleF.items.every((e) => e.role === 'מעבר'), `role filter "מעבר" (${roleF.total})`);

const tree = L.categoryTree();
console.log('\ncategory tree:\n   ' + tree.map((n) => `${n.name}(${n.count}) → ${n.children.map((c) => `${c.name}:${c.count}`).join(', ')}`).join('\n   '));

console.log('\nresolveSound:');
const sfxOnly = all.filter((e) => e.collection !== 'מוזיקה');
for (const q of ['מעבר', 'מכה', 'whoosh', sfxOnly[3].file, all[0].id, all[5].abs, path.basename(sfxOnly[7].file).replace(/\.[^.]+$/, '')]) {
  const r = await L.resolveSound(q);
  console.log(`   ${String(q).slice(0, 60)} → ${r ? `${r.name} (${r.id || '-'}) ${fs.existsSync(r.path) ? 'exists' : 'MISSING'}` : 'null'}`);
  ok(r && fs.existsSync(r.path), `resolveSound(${String(q).slice(0, 30)})`);
}
ok((await L.resolveSound('xqzzqx-no-such-sound')) === null, 'resolveSound(no match) → null');

const peaks = await L.soundPeaks(all[0].id);
ok(peaks && peaks.rate === 100 && peaks.peaks.length > 0, `peaks cache (${peaks && peaks.peaks.length} points)`);

const fonts = await L.listFonts();
console.log('\nfonts:', fonts.map((f) => `${f.family}${f.system ? '(sys' + (f.available ? '' : ' missing') + ')' : ''}`).join(', '));
ok(fonts.some((f) => f.family === 'Heebo' && f.url), 'Heebo local font listed');
const luts = await L.listLuts();
console.log('luts:', luts.join(', '));
ok(luts.length >= 8, '8 LUTs');

// routes contract over real HTTP (with a minimal ctx)
const ctx = {
  ROOT,
  sendJson: (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); },
  serveFile: L.serveFileFallback,
  log: () => {},
};
const rts = L.routes(ctx);
const srv = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  for (const r of rts) { const m = r.method === req.method && r.pattern.exec(p); if (m) return r.handler(req, res, m, ctx); }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;
const j = async (u) => (await fetch(base + u)).json();
const s1 = await j('/api/library/sounds?q=' + encodeURIComponent('ווש') + '&limit=5');
ok(s1.items && s1.items.length && typeof s1.total === 'number', `GET /api/library/sounds?q=ווש → ${s1.total}`);
const cats = await j('/api/library/sounds/categories');
ok(Array.isArray(cats) && cats.length >= 2 && cats.some((n) => n.id === 'roles'), 'GET categories tree (+ roles node)');
const one = await j('/api/library/sounds/' + s1.items[0].id);
ok(one.id === s1.items[0].id, 'GET /sounds/:id');
const pk = await j('/api/library/sounds/' + s1.items[0].id + '/peaks');
ok(pk.peaks && pk.peaks.length, 'GET /sounds/:id/peaks');
const fr = await fetch(base + '/api/library/sounds/' + s1.items[0].id + '/file', { headers: { Range: 'bytes=0-99' } });
ok(fr.status === 206 && (await fr.arrayBuffer()).byteLength === 100, 'GET /sounds/:id/file Range 206');
const lic = await (await fetch(base + '/api/library/licenses')).text();
ok(lic.includes('Sonniss') && lic.includes('Mixkit'), 'GET licenses markdown');
const lj = await j('/api/library/luts');
ok(Array.isArray(lj) && lj.includes('teal-orange.cube'), 'GET luts');
const fj = await j('/api/library/fonts');
ok(Array.isArray(fj) && fj.length >= 10, 'GET fonts');
const nf = await fetch(base + '/api/library/sounds/000000000000');
ok(nf.status === 404 && (await nf.json()).error, '404 with Hebrew error');
srv.close();

console.log(`\n${fails ? fails + ' FAILED' : 'ALL PASSED'}${skips ? ` (${skips} skipped: Starter Pack only)` : ''}  (total ${Date.now() - t0} ms)`);
process.exit(fails ? 1 : 0);
