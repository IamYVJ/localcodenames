// Generates docs/icons/icon-192.png and icon-512.png with zero dependencies
// (raw RGBA raster -> zlib deflate -> PNG chunks). Run: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');
mkdirSync(outDir, { recursive: true });

const COLORS = {
  bg: [0x0a, 0x0e, 0x0d, 255],
  glow: [0x11, 0x22, 0x1c, 255],
  surface: [0x16, 0x1d, 0x1b, 255],
  mint: [0x2f, 0xf0, 0xa8, 255],
  red: [0xe5, 0x56, 0x4e, 255],
  blue: [0x4e, 0x8e, 0xe5, 255],
  neutral: [0xc9, 0xb9, 0x8e, 255],
  assassin: [0x05, 0x08, 0x0a, 255],
};

// 3x3 layout mirroring icon.svg.
const GRID = [
  ['surface', 'red', 'surface'],
  ['blue', 'mint', 'surface'],
  ['surface', 'neutral', 'assassin'],
];

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };

  // Background with a soft top glow.
  const cx = size * 0.5, cy = size * 0.22, rad = size * 0.9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / rad;
      const t = Math.max(0, Math.min(1, d));
      const c = [
        Math.round(COLORS.glow[0] * (1 - t) + COLORS.bg[0] * t),
        Math.round(COLORS.glow[1] * (1 - t) + COLORS.bg[1] * t),
        Math.round(COLORS.glow[2] * (1 - t) + COLORS.bg[2] * t),
        255,
      ];
      set(x, y, c);
    }
  }

  // Grid of rounded-ish cards inside the maskable safe zone (~62% centered).
  const area = size * 0.62;
  const start = (size - area) / 2;
  const gap = area * 0.06;
  const cell = (area - gap * 2) / 3;
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      const name = GRID[r][col];
      const fill = COLORS[name];
      const x0 = Math.round(start + col * (cell + gap));
      const y0 = Math.round(start + r * (cell + gap));
      const w = Math.round(cell), h = Math.round(cell * 0.82);
      const radius = Math.round(cell * 0.16);
      const outline = (name === 'surface' || name === 'assassin');
      drawRoundRect(set, x0, y0, w, h, radius, fill, outline ? COLORS.mint : null, Math.max(2, Math.round(size * 0.006)));
    }
  }
  return px;
}

function drawRoundRect(set, x0, y0, w, h, radius, fill, stroke, sw) {
  const inCorner = (x, y) => {
    const corners = [
      [x0 + radius, y0 + radius], [x0 + w - radius, y0 + radius],
      [x0 + radius, y0 + h - radius], [x0 + w - radius, y0 + h - radius],
    ];
    if (x >= x0 + radius && x <= x0 + w - radius) return true;
    if (y >= y0 + radius && y <= y0 + h - radius) return true;
    for (const [cxp, cyp] of corners) {
      if (Math.hypot(x - cxp, y - cyp) <= radius) return true;
    }
    return false;
  };
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inCorner(x, y)) continue;
      const edge = stroke && (x < x0 + sw || x > x0 + w - sw || y < y0 + sw || y > y0 + h - sw
        || !inCorner(x + sw, y) || !inCorner(x - sw, y) || !inCorner(x, y + sw) || !inCorner(x, y - sw));
      set(x, y, edge ? stroke : fill);
    }
  }
}

// --- PNG encoding ---------------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines, each prefixed by filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [192, 512]) {
  const png = encodePng(size, makeIcon(size));
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log('wrote', file, png.length, 'bytes');
}
