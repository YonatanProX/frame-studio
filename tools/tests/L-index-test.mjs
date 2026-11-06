// Agent L self-test: real library indexing + search + resolveSound + fonts + LUTs + routes contract.
// Usage: node tools/tests/L-index-test.mjs [--fresh]
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import * as L from '../../server/library.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
L.configure({ root: ROOT, log: (...a) => console.log('  [lib]', ...a) });
const fresh = process.argv.includes('--fresh');
const idx = path.join(ROOT, 'library', 'sounds', 'index.json');
if (fresh && fs.existsSync(idx)) fs.unlinkSync(idx);

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

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
console.log(`\ncurated roles: ${roles.length}`);
for (const e of roles.filter((e) => !e.roleAlt)) console.log(`   ${e.role.padEnd(16)} ${e.name}  ${e.suggest ? JSON.stringify(e.suggest) : ''}`);

ok(st.count >= 300, `indexed >= 300 sounds (${st.count})`);
ok(all.every((e) => e.wave && e.wave.length === 64), 'every entry has a 64-point wave');
ok(all.every((e) => e.duration > 0), 'every entry has duration > 0');
ok(all.every((e) => typeof e.peakDb === 'number'), 'every entry has peakDb');
ok(all.every((e) => /^[0-9a-f]{12}$/.test(e.id)), 'ids are sha1[0:12]');
const misc = all.filter((e) => e.category === 'שונות');
ok(misc.length < all.length * 0.12, `"שונות" under 12% (${misc.length})`);
if (misc.length) console.log('   misc:', misc.slice(0, 30).map((e) => e.name + ' {' + e.pack + '}').join(' | '));

const queries = ['ווש', 'whoosh', 'בום', 'בס נופל', 'riser', 'עולה', 'מתח', 'קליק', 'ממשק', 'נייר', 'שעון', 'קהל', 'מחיאות כפיים', 'גשם', 'רוח', 'כלב', 'דרופ', 'זום', 'גליץ׳', 'מכונת כתיבה', 'קריקטורה', 'impact', 'braam', 'אווירה', 'רכבת', 'קסם', 'זכוכית'];
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
const cat = L.searchSounds({ category: '2 בס נופל', limit: 50 });
ok(cat.total === 9, `category "2 בס נופל" has 9 (${cat.total})`);

const tree = L.categoryTree();
console.log('\ncategory tree:\n   ' + tree.map((n) => `${n.name}(${n.count}) → ${n.children.map((c) => `${c.name}:${c.count}`).join(', ')}`).join('\n   '));

console.log('\nresolveSound:');
for (const q of ['דרופ', 'whoosh', 'סוניס-נבחרים/1 בומים ובראאאם/EffectiveTrailer_Booms_Vol2_011.wav', all[0].id, all[5].abs, 'Air zoom vacuum']) {
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
await new Promise((r) => srv.listen(7796, '127.0.0.1', r));
const base = 'http://127.0.0.1:7796';
const j = async (u) => (await fetch(base + u)).json();
const s1 = await j('/api/library/sounds?q=' + encodeURIComponent('ווש') + '&limit=5');
ok(s1.items && s1.items.length && typeof s1.total === 'number', `GET /api/library/sounds?q=ווש → ${s1.total}`);
const cats = await j('/api/library/sounds/categories');
ok(Array.isArray(cats) && cats.length >= 3, 'GET categories tree');
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

console.log(`\n${fails ? fails + ' FAILED' : 'ALL PASSED'}  (total ${Date.now() - t0} ms)`);
process.exit(fails ? 1 : 0);
