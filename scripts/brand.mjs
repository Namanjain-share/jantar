#!/usr/bin/env node
// The brand files in docs/brand/, drawn from the app's own tokens, fonts and
// screenshots, with no network and no dependency beyond playwright-core:
//
//   docs/brand/logo.svg            the mark (the 2x2 legend, needs-you cell lit), day colours
//   docs/brand/logo-dark.svg       the same in night colours
//   docs/brand/banner.png          1600 x 520 (800 x 260 at 2x): wordmark, tagline, three phones
//   docs/brand/banner-dark.png     the same at night, with the -dark screenshots
//   docs/brand/social-preview.png  1280 x 640 (640 x 320 at 2x), for GitHub's social preview
//
// Colours come from packages/web/src/styles/tokens.css (the day :root block
// and the night [data-theme='dark'] block), the mark from the 12 rects of
// kit/Mark.tsx (the same as public/icons/icon.svg), the type from the app's
// self-hosted Archivo and JetBrains Mono (OFL-1.1, packages/web's
// node_modules), inlined as data: URLs. The phones are docs/img/*-phone.png,
// so run scripts/screenshots.mjs first. Each page is rendered by
// playwright-core's own Chromium in a fresh context that is offline and
// refuses every request: a page is only what it holds.
//
// The logos are plain <rect>s with crispEdges on a 16-unit grid (the mark's
// 14 units and one unit around it), so they are sharp at 16, 32 and 64 px.
// There is no text in an SVG: an <img> on GitHub can't load a web font, so the
// wordmark lives only in the PNGs.
//
// Usage (after scripts/screenshots.mjs):
//   node scripts/brand.mjs [--out DIR] [--img DIR] [--only banner,logo,...] [--list]
//
// Review every file by eye before committing it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const web = join(root, 'packages', 'web');

/** Every file this script writes, in docs/brand/. */
export const BRAND_FILES = ['logo.svg', 'logo-dark.svg', 'banner.png', 'banner-dark.png', 'social-preview.png'];

/** CSS size and scale of each picture. */
export const PICTURES = {
  banner: { width: 800, height: 260, scale: 2 },
  social: { width: 640, height: 320, scale: 2 },
};

/** The words on the pictures: the wordmark, one tagline and the mono lines. Nothing else. */
export const WORDS = {
  name: 'Jantar',
  tagline: 'Every Claude Code session on your Mac, on your phone.',
  /** Two lines, so neither picture breaks it in an odd place. */
  mono: ['macOS · Terminal.app', 'One Claude account or many'],
  license: 'Source-available · FSL-1.1-MIT',
};

/** The screenshots each picture frames (docs/img/<name>.png, with -dark at night). */
export const PHONES = {
  banner: ['board-phone', 'dialog-plan-phone', 'meeting-phone'],
  social: ['board-phone', 'dialog-plan-phone'],
};

// ---------------------------------------------------------------------------
// Tokens

const TOKENS_CSS = join(web, 'src', 'styles', 'tokens.css');

/** The colour tokens of one theme from tokens.css: { '--bg': '#f7f5ef', ... } (hex values only). */
export function tokens(theme, css = readFileSync(TOKENS_CSS, 'utf8')) {
  const head = theme === 'dark' ? ":root[data-theme='dark'] {" : ':root {\n  --page';
  const start = css.indexOf(head);
  if (start < 0) throw new Error(`tokens.css has no ${theme} block`);
  const block = css.slice(start, css.indexOf('}', start));
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  // The app's one shadow, its ring in this theme's --line.
  const shadow = /--shadow-float-v\s*:\s*([^;]+);/.exec(block);
  if (shadow) out['--shadow-float-v'] = shadow[1].trim().replace('var(--line)', out['--line'] ?? 'transparent');
  for (const need of ['--bg', '--ink', '--ink-2', '--ink-3', '--line', '--line-strong', '--raised', '--signal', '--jup', '--shadow-float-v']) {
    if (!out[need]) throw new Error(`tokens.css ${theme} block has no ${need}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The mark (kit/Mark.tsx): a 14-unit grid, 6-unit cells, a 2-unit gap

/** [x, y, w, h, role]: role 'needs' is the needs-you cell, 'ink' the rest. */
export const MARK_RECTS = Object.freeze([
  [0, 0, 6, 6, 'needs'],
  [8, 0, 6, 6, 'ink'],
  // your turn: an outline
  [0, 8, 6, 1, 'ink'],
  [0, 13, 6, 1, 'ink'],
  [0, 9, 1, 4, 'ink'],
  [5, 9, 1, 4, 'ink'],
  // no update: a dashed outline
  [8, 8, 2, 1, 'ink'],
  [12, 8, 2, 1, 'ink'],
  [8, 13, 2, 1, 'ink'],
  [12, 13, 2, 1, 'ink'],
  [8, 10, 1, 2, 'ink'],
  [13, 10, 1, 2, 'ink'],
]);

/** The mark's rects as SVG, `unit` px per grid unit, moved by `at` units. */
function markParts(t, unit = 1, at = 0) {
  return MARK_RECTS.map(
    ([x, y, w, h, role]) => `<rect x="${(x + at) * unit}" y="${(y + at) * unit}" width="${w * unit}" height="${h * unit}" fill="${role === 'needs' ? t['--signal'] : t['--ink']}"/>`,
  ).join('');
}

/** logo.svg / logo-dark.svg: the mark, one unit of room around it, transparent. */
export function logoSvg(theme, t = tokens(theme)) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="64" height="64" shape-rendering="crispEdges">${markParts(t, 1, 1)}</svg>\n`;
}

/** The mark at `px` CSS pixels (14 units), inline. */
function markSvg(t, px) {
  return `<svg class="mark" viewBox="0 0 14 14" width="${px}" height="${px}" shape-rendering="crispEdges" aria-hidden="true">${markParts(t)}</svg>`;
}

// ---------------------------------------------------------------------------
// Fonts: the app's own, inlined

const FONTS = [
  {
    family: 'Archivo Variable',
    file: join(web, 'node_modules', '@fontsource-variable', 'archivo', 'files', 'archivo-latin-wdth-normal.woff2'),
    extra: 'font-weight: 100 900; font-stretch: 62% 125%;',
  },
  {
    family: 'JetBrains Mono Variable',
    file: join(web, 'node_modules', '@fontsource-variable', 'jetbrains-mono', 'files', 'jetbrains-mono-latin-wght-normal.woff2'),
    extra: 'font-weight: 100 800;',
  },
];

/** @font-face rules for Archivo and JetBrains Mono as data: URLs (the files in packages/web's node_modules). */
export function fontFaces() {
  return FONTS.map((f) => {
    if (!existsSync(f.file)) throw new Error(`${relative(root, f.file)} is missing: run pnpm install first`);
    const data = readFileSync(f.file).toString('base64');
    return `@font-face { font-family: '${f.family}'; font-style: normal; font-display: block; ${f.extra} src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// The pages

/**
 * The observatory's nod: two quarter arcs round (cx, cy), a tick every 6
 * degrees on the outer one, one of them mustard. Decorative: --line only.
 */
function dial(t, { width, height, cx, cy, r1, r2, from = 0, to = 90, jup = 54, flip = false }) {
  const parts = [];
  const pt = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    const x = cx + (flip ? -1 : 1) * r * Math.cos(a);
    const y = cy - r * Math.sin(a);
    return [x.toFixed(2), y.toFixed(2)];
  };
  const arc = (r) => {
    const [x0, y0] = pt(r, from);
    const [x1, y1] = pt(r, to);
    return `<path d="M${x0} ${y0} A${r} ${r} 0 0 ${flip ? 1 : 0} ${x1} ${y1}" fill="none" stroke="${t['--line']}" stroke-width="1"/>`;
  };
  parts.push(arc(r1), arc(r2));
  for (let deg = from; deg <= to; deg += 6) {
    const long = deg % 30 === 0;
    const [x0, y0] = pt(r2, deg);
    const [x1, y1] = pt(r2 + (long ? 12 : 6), deg);
    const now = deg === jup;
    parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${now ? t['--jup'] : t['--line']}" stroke-width="${now ? 2 : 1}"/>`);
  }
  return `<svg class="dial" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join('')}</svg>`;
}

/** A phone: the screenshot's screen rounded 14 px in a plain 5 px bezel (no notch, no buttons). */
function phone(src, { left, top, width, front = false }) {
  return `<div class="phone${front ? ' front' : ''}" style="left:${left}px;top:${top}px;width:${width}px"><img src="${src}" alt=""></div>`;
}

function page(t, theme, size, body, extraCss = '') {
  const night = theme === 'dark';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces()}
html, body { margin: 0; padding: 0; background: transparent; }
body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; -webkit-font-smoothing: antialiased; }
.ground { position: absolute; inset: 0; background: ${t['--bg']}; overflow: hidden; }
.dial { position: absolute; left: 0; top: 0; }
.word { position: absolute; display: flex; flex-direction: column; }
.name { display: flex; align-items: center; }
.name b { font: 600 56px/1 'Archivo Variable', sans-serif; font-stretch: 125%; letter-spacing: -0.02em; color: ${t['--ink']}; }
.tag { margin: 0; font: 420 18px/24px 'Archivo Variable', sans-serif; color: ${t['--ink-2']}; text-wrap: balance; }
.mono { margin: 0; font: 500 11px/14px 'JetBrains Mono Variable', monospace; letter-spacing: 0.06em; text-transform: uppercase; color: ${t['--ink-3']}; }
.phone { position: absolute; box-sizing: border-box; padding: 5px; border-radius: 19px; background: ${night ? t['--raised'] : t['--ink']};${night ? ` box-shadow: 0 0 0 1px ${t['--line-strong']};` : ''} }
.phone img { display: block; width: 100%; height: auto; border-radius: 14px; }
.phone.front { z-index: 2; box-shadow: ${night ? `0 0 0 1px ${t['--line-strong']}, ` : ''}${t['--shadow-float-v']}; }
${extraCss}
</style></head><body>${body}</body></html>`;
}

/** banner.png / banner-dark.png: 800 x 260, rounded 12 px, transparent outside. */
export function bannerHtml(theme, shots, t = tokens(theme)) {
  const size = PICTURES.banner;
  const [board, plan, meeting] = shots;
  const body = `<div class="ground" style="border-radius:12px">
  ${dial(t, { width: size.width, height: size.height, cx: 0, cy: size.height, r1: 210, r2: 230, jup: 72 })}
  <div class="word" style="left:40px;top:0;bottom:0;width:340px;justify-content:center">
    <div class="name">${markSvg(t, 36)}<b style="margin-left:14px">${WORDS.name}</b></div>
    <p class="tag" style="margin-top:16px">${WORDS.tagline}</p>
    <p class="mono" style="margin-top:16px">${WORDS.mono.join('<br>')}</p>
  </div>
  ${phone(board, { left: 410, top: 40, width: 124 })}
  ${phone(plan, { left: 528, top: -96, width: 132, front: true })}
  ${phone(meeting, { left: 654, top: 40, width: 124 })}
</div>`;
  return page(t, theme, size, body);
}

/** social-preview.png: 640 x 320, full bleed, 40 px safe margin for the words. */
export function socialHtml(theme, shots, t = tokens(theme)) {
  const size = PICTURES.social;
  const [board, plan] = shots;
  const css = `.name b { font-size: 64px; } .tag { font-size: 22px; line-height: 28px; }`;
  const body = `<div class="ground">
  ${dial(t, { width: size.width, height: size.height, cx: size.width, cy: size.height, r1: 290, r2: 310, flip: true, jup: 24 })}
  <div class="word" style="left:40px;top:40px;bottom:40px;width:330px">
    <div class="name" style="margin-top:6px">${markSvg(t, 32)}<b style="margin-left:14px">${WORDS.name}</b></div>
    <p class="tag" style="margin-top:20px">${WORDS.tagline}</p>
    <p class="mono" style="margin-top:16px;font-size:12px;line-height:16px">${WORDS.mono.join('<br>')}</p>
    <p class="mono" style="margin-top:auto">${WORDS.license}</p>
  </div>
  ${phone(board, { left: 390, top: 96, width: 140 })}
  ${phone(plan, { left: 474, top: 44, width: 140, front: true })}
</div>`;
  return page(t, theme, size, body, css);
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: join(root, 'docs', 'brand'), img: join(root, 'docs', 'img'), only: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--out') out.out = resolve(value());
    else if (a === '--img') out.img = resolve(value());
    else if (a === '--only') out.only = new Set(value().split(','));
    else if (a === '--list') out.list = true;
    else fail(`unknown argument ${a}`);
  }
  return out;
}

function fail(message, code = 2) {
  process.stderr.write(`brand: ${message}\n`);
  process.exit(code);
}

const shown = (file) => (file.startsWith(`${root}/`) ? relative(root, file) : file);

/** The files to write: every one, or those whose name (or name without extension) is in `only`. */
export function wanted(only = null) {
  return BRAND_FILES.filter((f) => !only || only.has(f) || only.has(f.replace(/\.[a-z]+$/, '')) || only.has(f.replace(/(-dark)?\.[a-z]+$/, '')));
}

/** A docs/img screenshot as a data: URL. */
function shot(dir, name) {
  const file = join(dir, `${name}.png`);
  if (!existsSync(file)) fail(`${shown(file)} is missing: run scripts/screenshots.mjs first`);
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

async function draw(opts) {
  const todo = wanted(opts.only);
  if (!todo.length) fail(`--only matched nothing (files: ${BRAND_FILES.join(', ')})`);
  mkdirSync(opts.out, { recursive: true, mode: 0o755 });
  const css = readFileSync(TOKENS_CSS, 'utf8');
  const theme = { light: tokens('light', css), dark: tokens('dark', css) };
  for (const f of todo.filter((x) => x.endsWith('.svg'))) {
    const out = join(opts.out, f);
    writeFileSync(out, logoSvg(f.includes('-dark') ? 'dark' : 'light', theme[f.includes('-dark') ? 'dark' : 'light']));
    process.stdout.write(`${shown(out)}\n`);
  }
  const pngs = todo.filter((x) => x.endsWith('.png'));
  if (!pngs.length) return;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  try {
    for (const f of pngs) {
      const dark = f.includes('-dark');
      const t = theme[dark ? 'dark' : 'light'];
      const social = f.startsWith('social');
      const size = social ? PICTURES.social : PICTURES.banner;
      const shots = PHONES[social ? 'social' : 'banner'].map((n) => shot(opts.img, dark ? `${n}-dark` : n));
      const html = social ? socialHtml(dark ? 'dark' : 'light', shots, t) : bannerHtml(dark ? 'dark' : 'light', shots, t);
      const ctx = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        offline: true,
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
        colorScheme: dark ? 'dark' : 'light',
      });
      try {
        await ctx.route('**/*', (route) => route.abort());
        const p = await ctx.newPage();
        await p.setContent(html, { waitUntil: 'load' });
        await p.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map((i) => i.decode()));
        });
        const out = join(opts.out, f);
        await p.screenshot({ path: out, omitBackground: !social });
        process.stdout.write(`${shown(out)}  ${size.width}x${size.height}@${size.scale}x\n`);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const f of wanted(opts.only)) process.stdout.write(`${shown(join(opts.out, f))}\n`);
  } else {
    draw(opts).catch((e) => {
      process.stderr.write(`brand: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
  }
}
