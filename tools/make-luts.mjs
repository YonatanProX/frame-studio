// Generates the 8 built-in .cube LUTs (size 17) into library/luts.
// Usage: node tools/make-luts.mjs [--force] [--size 33]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, ensureLuts, LUT_NAMES } from '../server/library.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
configure({ root, log: () => {} });
const force = process.argv.includes('--force');
const si = process.argv.indexOf('--size');
const size = si > 0 ? Math.max(2, Math.min(65, parseInt(process.argv[si + 1], 10) || 17)) : 17;
const written = await ensureLuts({ force, size });
if (written.length) {
  console.log(`נוצרו ${written.length} קובצי LUT בגודל ${size}:`);
  for (const f of written) console.log(`  ${f}  —  ${LUT_NAMES[f] || ''}`);
} else {
  console.log('כל קובצי ה-LUT כבר קיימים (הוסף --force כדי ליצור מחדש).');
}
