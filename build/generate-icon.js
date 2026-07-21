#!/usr/bin/env node
// Generates build/icon.png (1024x1024) — the master app icon.
// Pure Node (zlib only), no image dependencies. Run via `npm run icon`,
// which then packs the .icns with sips/iconutil.
//
// Design: brand-navy rounded square (macOS Big Sur metrics) with a beamed
// eighth-note pair in the app accent colour.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- geometry ----------
const SIZE = 1024;
const SS = 4;                       // supersamples per axis (anti-aliasing)
const INSET = 100;                  // Big Sur: 824pt content in a 1024pt canvas
const RADIUS = 185;
const HALF = (SIZE - INSET * 2) / 2; // 412
const CX = SIZE / 2;

// Rounded-rect signed distance (negative = inside)
function rrDist(x, y) {
  const qx = Math.abs(x - CX) - (HALF - RADIUS);
  const qy = Math.abs(y - CX) - (HALF - RADIUS);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

// Note glyph, defined in a 24-unit design space (mirrors the app's music icon)
const HEAD_RX = 3.35, HEAD_RY = 2.55, HEAD_ROT = -20 * Math.PI / 180;
const HEADS = [{ x: 6, y: 18 }, { x: 18, y: 16 }];
const STEM_HW = 0.85, BEAM_TH = 2.9;

// Half-width of the rotated head ellipse, so each stem's outer edge lines up
// flush with its note head instead of jutting past it.
const HEAD_HALF_W = Math.hypot(HEAD_RX * Math.cos(HEAD_ROT), HEAD_RY * Math.sin(HEAD_ROT));
const LEFT_X = HEADS[0].x + HEAD_HALF_W - STEM_HW;
const RIGHT_X = HEADS[1].x + HEAD_HALF_W - STEM_HW;
const beamTop = (u) => 3.0 + (u - LEFT_X) * (-2.0 / (RIGHT_X - LEFT_X));

function inNote(u, v) {
  const c = Math.cos(-HEAD_ROT), s = Math.sin(-HEAD_ROT);
  for (const h of HEADS) {
    const dx = u - h.x, dy = v - h.y;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    if ((rx / HEAD_RX) ** 2 + (ry / HEAD_RY) ** 2 <= 1) return true;
  }
  // Stem tops follow the beam's slant (per-column), so the union is seamless.
  if (u >= LEFT_X - STEM_HW && u <= LEFT_X + STEM_HW && v >= beamTop(u) && v <= HEADS[0].y) return true;
  if (u >= RIGHT_X - STEM_HW && u <= RIGHT_X + STEM_HW && v >= beamTop(u) && v <= HEADS[1].y) return true;
  if (u >= LEFT_X - STEM_HW && u <= RIGHT_X + STEM_HW) {
    const t = beamTop(u);
    if (v >= t && v <= t + BEAM_TH) return true;
  }
  return false;
}

// Measure the glyph so we can centre and scale it precisely.
let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
for (let u = -4; u <= 28; u += 0.02) {
  for (let v = -4; v <= 28; v += 0.02) {
    if (!inNote(u, v)) continue;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
}
const glyphCU = (minU + maxU) / 2, glyphCV = (minV + maxV) / 2;
const NOTE_SCALE = (SIZE - INSET * 2) * 0.58 / Math.max(maxU - minU, maxV - minV);
const noteTopPx = CX + (minV - glyphCV) * NOTE_SCALE;
const noteBotPx = CX + (maxV - glyphCV) * NOTE_SCALE;

// ---------- colours ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG_TOP = hex('#1a1a2e');      // --bg-primary
const BG_BOT = hex('#0f3460');      // --bg-card
const NOTE_TOP = hex('#ff6b81');    // --accent-hover
const NOTE_BOT = hex('#e94560');    // --accent
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

// ---------- render ----------
const out = Buffer.alloc(SIZE * SIZE * 4);
const step = 1 / SS, base = step / 2;

for (let py = 0; py < SIZE; py++) {
  const bgT = (py - INSET) / (SIZE - INSET * 2);
  const bg = [lerp(BG_TOP[0], BG_BOT[0], bgT), lerp(BG_TOP[1], BG_BOT[1], bgT), lerp(BG_TOP[2], BG_BOT[2], bgT)];
  const nT = (py - noteTopPx) / (noteBotPx - noteTopPx);
  const note = [lerp(NOTE_TOP[0], NOTE_BOT[0], nT), lerp(NOTE_TOP[1], NOTE_BOT[1], nT), lerp(NOTE_TOP[2], NOTE_BOT[2], nT)];

  for (let px = 0; px < SIZE; px++) {
    let covBg = 0, covNote = 0;
    for (let sy = 0; sy < SS; sy++) {
      const y = py + base + sy * step;
      for (let sx = 0; sx < SS; sx++) {
        const x = px + base + sx * step;
        if (rrDist(x, y) < 0) covBg++;
        const u = glyphCU + (x - CX) / NOTE_SCALE;
        const v = glyphCV + (y - CX) / NOTE_SCALE;
        if (inNote(u, v)) covNote++;
      }
    }
    const total = SS * SS;
    const aBg = covBg / total;
    const aNote = (covNote / total) * aBg; // clip glyph to the rounded square
    const i = (py * SIZE + px) * 4;
    out[i]     = Math.round(lerp(bg[0], note[0], aNote));
    out[i + 1] = Math.round(lerp(bg[1], note[1], aNote));
    out[i + 2] = Math.round(lerp(bg[2], note[2], aNote));
    out[i + 3] = Math.round(aBg * 255);
  }
}

const dest = path.join(__dirname, 'icon.png');
fs.writeFileSync(dest, encodePNG(SIZE, SIZE, out));
console.log(`wrote ${dest} (${SIZE}x${SIZE})`);
