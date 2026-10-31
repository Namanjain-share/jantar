#!/usr/bin/env node
// Draws the app icons and favicons from the brand mark: the 2x2 legend
// (needs-you cell, working filled, your-turn outline, no-update dashed) on a
// night-navy tile. Colours are read from src/styles/tokens.css (night block),
// so the icons follow the palette. Writes PNG and SVG files into public/,
// and the Chrome extension's toolbar sizes (16, 32 and 48 px, drawn from the
// favicon's 16-unit grid so every edge lands on a whole pixel) into
// packages/extension/static/. The extension's 128 px icon is icon-192.png.
//
// No dependencies: every shape is an axis-aligned rect, each pixel is 4x4
// supersampled, and the PNG is encoded with node:zlib. Run it again only when
// the mark or the palette changes; the outputs are committed.
//
//   node packages/web/scripts/gen-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const pub = join(web, 'public');
const iconsDir = join(pub, 'icons');
mkdirSync(iconsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Colours: the night theme, because the tile is deep navy in both themes.

const tokens = readFileSync(join(web, 'src', 'styles', 'tokens.css'), 'utf8');
function nightVar(name) {
  const start = tokens.indexOf(":root[data-theme='dark']");
  const block = tokens.slice(start, tokens.indexOf('}', start));
  const m = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`tokens.css night block has no ${name}`);
  return m[1].toLowerCase();
}
const BG = nightVar('--bg');
const INK = nightVar('--ink');
const QUIET = nightVar('--ink-4');
const SIGNAL = nightVar('--signal');

// ---------------------------------------------------------------------------
// The mark on a 14-unit grid (kit/Mark.tsx): 6-unit cells, 2-unit gap.

/** Rects [x, y, w, h, colour] in mark units. `needs` lights the ember cell. */
function markRects(needs) {
  const ink = INK;
  return [
    [0, 0, 6, 6, needs ? SIGNAL : QUIET],
    [8, 0, 6, 6, ink],
    // your turn: outline
    [0, 8, 6, 1, ink],
    [0, 13, 6, 1, ink],
    [0, 9, 1, 4, ink],
    [5, 9, 1, 4, ink],
    // no update: dashed outline
    [8, 8, 2, 1, ink],
    [12, 8, 2, 1, ink],
    [8, 13, 2, 1, ink],
    [12, 13, 2, 1, ink],
    [8, 10, 1, 2, ink],
    [13, 10, 1, 2, ink],
  ];
}

function hex(c) {
  const n = Number.parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A drawing in a `box`-unit square: an optional rounded tile, then the mark
 * scaled by `unit` and centred. Returns { box, tile, rects } in box units.
 */
function design({ box = 512, unit = 18, radius = 112, background = true, needs = false, mono = false }) {
  const size = 14 * unit;
  const off = (box - size) / 2;
  const rects = markRects(needs).map(([x, y, w, h, c]) => [off + x * unit, off + y * unit, w * unit, h * unit, mono ? '#ffffff' : c]);
  return { box, radius, background, rects };
}

// ---------------------------------------------------------------------------
// Raster

function render(px, d) {
  const out = new Uint8Array(px * px * 4);
  const S = 4;
  const bg = hex(BG);
  const k = d.box / px;
  const r = d.radius;
  const half = d.box / 2;
  const inTile = (x, y) => {
    if (!d.background) return false;
    if (r <= 0) return true;
    const qx = Math.max(Math.abs(x - half) - (half - r), 0);
    const qy = Math.max(Math.abs(y - half) - (half - r), 0);
    return qx * qx + qy * qy <= r * r;
  };
  const rects = d.rects.map(([x, y, w, h, c]) => [x, y, w, h, hex(c)]);
  for (let j = 0; j < px; j += 1) {
    for (let i = 0; i < px; i += 1) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let ca = 0;
      for (let sj = 0; sj < S; sj += 1) {
        for (let si = 0; si < S; si += 1) {
          const x = (i + (si + 0.5) / S) * k;
          const y = (j + (sj + 0.5) / S) * k;
          let col = null;
          if (inTile(x, y)) col = bg;
          for (const [rx, ry, rw, rh, c] of rects) if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) col = c;
          if (col) {
            cr += col[0];
            cg += col[1];
            cb += col[2];
            ca += 1;
          }
        }
      }
      const o = (j * px + i) * 4;
      out[o] = ca ? Math.round(cr / ca) : 0;
      out[o + 1] = ca ? Math.round(cg / ca) : 0;
      out[o + 2] = ca ? Math.round(cb / ca) : 0;
      out[o + 3] = Math.round((ca / (S * S)) * 255);
    }
  }
  return encodePng(px, px, out);
}

// ---------------------------------------------------------------------------
// PNG encoder (RGBA, 8 bit, no interlace)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// SVG (same drawing, vector; presentation attributes only, no <style>)

function svg(d) {
  const parts = [];
  if (d.background) parts.push(`<rect width="${d.box}" height="${d.box}" rx="${d.radius}" fill="${BG}"/>`);
  parts.push('<g shape-rendering="crispEdges">');
  for (const [x, y, w, h, c] of d.rects) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`);
  parts.push('</g>');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.box} ${d.box}">${parts.join('')}</svg>\n`;
}

// ---------------------------------------------------------------------------

const app = (o = {}) => design({ box: 512, unit: 18, radius: 112, ...o });
const outputs = [
  ['icons/icon-192.png', () => render(192, app())],
  ['icons/icon-512.png', () => render(512, app())],
  // Maskable: full-bleed tile, the mark well inside the 80% safe zone.
  ['icons/icon-maskable-512.png', () => render(512, app({ radius: 0, unit: 16 }))],
  // iOS rounds the corners itself and shows black behind transparency.
  ['icons/apple-touch-icon.png', () => render(180, app({ radius: 0 }))],
  // Android status-bar badge: white on transparent.
  ['icons/badge-96.png', () => render(96, app({ background: false, mono: true, unit: 26 }))],
];

for (const [name, make] of outputs) {
  writeFileSync(join(pub, name), make());
  process.stdout.write(`wrote public/${name}\n`);
}
writeFileSync(join(iconsDir, 'icon.svg'), svg(app()));
// Favicons: a 16-unit tile with the mark at 1 unit per cell-unit, 1 unit in.
const fav = (needs) => design({ box: 16, unit: 1, radius: 3, needs });
writeFileSync(join(pub, 'favicon.svg'), svg(fav(false)));
writeFileSync(join(pub, 'favicon-needs.svg'), svg(fav(true)));
process.stdout.write('wrote public/icons/icon.svg, public/favicon.svg, public/favicon-needs.svg\n');
// The extension's small icons: the favicon tile at 1, 2 and 3 px per unit.
const extStatic = join(web, '..', 'extension', 'static');
for (const px of [16, 32, 48]) {
  writeFileSync(join(extStatic, `icon-${px}.png`), render(px, fav(false)));
  process.stdout.write(`wrote packages/extension/static/icon-${px}.png\n`);
}
