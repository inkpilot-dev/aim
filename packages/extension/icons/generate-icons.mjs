#!/usr/bin/env node
/**
 * Renders icons/icon{16,32,48,128}.png from the same geometry as icon.svg, with no native image
 * dependencies: a tiny software rasteriser (supersampled signed-distance fill) plus a hand-written
 * PNG encoder (zlib from Node). Run: node icons/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Geometry in a 128-unit design space (matches icon.svg).
const DESIGN = 128;
const CORNER = 28;
const ARROW = [[40, 24], [40, 96], [58, 80], [71, 108], [85, 101], [72, 74], [96, 74]];
const STROKE = 7;
const BLACK = [0x0b, 0x0b, 0x0d];
const TEAL = [0x1a, 0xbf, 0xb0];
const WHITE = [0xff, 0xff, 0xff];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distToPolygonEdge(x, y, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    d = Math.min(d, distToSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  }
  return d;
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectSdf(x, y, w, h, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** Colour (RGBA 0..1) of a design-space point. */
function sample(x, y) {
  const bg = roundedRectSdf(x, y, DESIGN, DESIGN, CORNER);
  if (bg > 0) return [0, 0, 0, 0];
  const inside = pointInPolygon(x, y, ARROW);
  const edge = distToPolygonEdge(x, y, ARROW);
  const half = STROKE / 2;
  if (edge <= half) return [...WHITE, 1];
  if (inside) return [...TEAL, 1];
  // Soft teal glow just outside the white outline.
  const glow = Math.max(0, 1 - (edge - half) / 10) * 0.28;
  const r = BLACK[0] + (TEAL[0] - BLACK[0]) * glow;
  const g = BLACK[1] + (TEAL[1] - BLACK[1]) * glow;
  const b = BLACK[2] + (TEAL[2] - BLACK[2]) * glow;
  return [r, g, b, 1];
}

function render(size) {
  const ss = size >= 64 ? 4 : 8; // supersampling factor
  const scale = DESIGN / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          const [cr, cg, cb, ca] = sample(x, y);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = ss * ss;
      const idx = (py * size + px) * 4;
      if (a > 0) {
        out[idx] = Math.round(r / a);
        out[idx + 1] = Math.round(g / a);
        out[idx + 2] = Math.round(b / a);
      }
      out[idx + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// --- PNG encoding -------------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = join(here, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log('wrote', file);
}
