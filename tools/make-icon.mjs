// Frame Studio — builds app/icon.ico in pure Node (no dependencies):
// a cyan (#13b6e4) film-frame mark with a play triangle on night (#071822), rendered with 4x4 supersampling,
// stored as PNG images (zlib deflate) inside a valid ICO container: 16, 24, 32, 48, 64, 128, 256 px.
//   node tools/make-icon.mjs [out.ico] [--png out.png]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const pngIdx = args.indexOf('--png');
const PNG_OUT = pngIdx >= 0 ? args[pngIdx + 1] : null;
const OUT = args.find((a, i) => !a.startsWith('--') && (pngIdx < 0 || i !== pngIdx + 1)) || path.join(ROOT, 'app', 'icon.ico');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const CYAN = hex('#13b6e4');
const CYAN_HI = hex('#5fd8f7');
const NIGHT = hex('#071822');
const NIGHT_TOP = hex('#0d2a3a');

// ---------------------------------------------------------------- geometry (unit square, y down)

function inRoundRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const dx = Math.max(x0 + r - u, 0, u - (x1 - r));
  const dy = Math.max(y0 + r - v, 0, v - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}
function inTriangle(u, v, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const pt = [u, v];
  const d1 = s(pt, a, b), d2 = s(pt, b, c), d3 = s(pt, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** colour of one sample point → [r,g,b,a] (straight alpha 0..1) */
function shade(u, v, size) {
  const small = size <= 24;
  // app tile: rounded square with a soft vertical gradient
  if (!inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.2)) return [0, 0, 0, 0];
  let col = mix(NIGHT_TOP, NIGHT, Math.min(1, Math.max(0, (v - 0.02) / 0.96)));
  // thin cyan rim (only where it stays crisp)
  if (!small && !inRoundRect(u, v, 0.035, 0.035, 0.965, 0.965, 0.186)) col = mix(col, CYAN, 0.35);
  // film frame body
  const bx0 = small ? 0.1 : 0.13, bx1 = small ? 0.9 : 0.87, by0 = small ? 0.2 : 0.23, by1 = small ? 0.8 : 0.77;
  if (inRoundRect(u, v, bx0, by0, bx1, by1, small ? 0.08 : 0.065)) {
    col = mix(CYAN_HI, CYAN, Math.min(1, Math.max(0, (v - by0) / (by1 - by0))));
    // sprocket holes along the top and bottom bands
    if (!small) {
      const holes = 6, hw = 0.062, gap = (bx1 - bx0 - 0.08 - holes * hw) / (holes - 1);
      for (let i = 0; i < holes; i++) {
        const x0 = bx0 + 0.04 + i * (hw + gap);
        if (inRoundRect(u, v, x0, by0 + 0.045, x0 + hw, by0 + 0.095, 0.014) || inRoundRect(u, v, x0, by1 - 0.095, x0 + hw, by1 - 0.045, 0.014)) col = NIGHT;
      }
    }
    // picture window
    const wy0 = small ? by0 + 0.12 : by0 + 0.14, wy1 = small ? by1 - 0.12 : by1 - 0.14;
    if (inRoundRect(u, v, bx0 + (small ? 0.08 : 0.065), wy0, bx1 - (small ? 0.08 : 0.065), wy1, small ? 0.03 : 0.025)) {
      col = NIGHT;
      // play triangle
      const cx = 0.515, cy = (wy0 + wy1) / 2, h = (wy1 - wy0) * 0.62, w = h * 0.9;
      if (inTriangle(u, v, [cx - w * 0.45, cy - h / 2], [cx - w * 0.45, cy + h / 2], [cx + w * 0.55, cy])) col = CYAN;
    }
  }
  return [col[0], col[1], col[2], 1];
}

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, size);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const n = SS * SS, o = (y * size + x) * 4;
      const al = a / n;
      px[o] = al > 0 ? Math.round(r / a) : 0;
      px[o + 1] = al > 0 ? Math.round(g / a) : 0;
      px[o + 2] = al > 0 ? Math.round(b / a) : 0;
      px[o + 3] = Math.round(al * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------- PNG

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- ICO

export function encodeIco(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size; dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...images.map((x) => x.png)]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((size) => ({ size, png: encodePng(render(size), size, size) }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodeIco(images));
if (PNG_OUT) fs.writeFileSync(PNG_OUT, images[images.length - 1].png);
console.log(`נוצר ${OUT} (${SIZES.join(', ')} px, ${fs.statSync(OUT).size} בתים)`);
