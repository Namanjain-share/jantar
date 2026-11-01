#!/usr/bin/env node
// Builds the project's website from site/src into a static folder for GitHub
// Pages (default site/dist), from the repository's own files only:
//
//   colours   packages/web/src/styles/tokens.css (the day and night blocks,
//             radii and easings), written above site/src/site.css
//   fonts     Archivo and JetBrains Mono, the web app's own woff2 files from
//             @fontsource-variable (OFL-1.1), with their licence files
//   pictures  docs/img/<name>.png and <name>-dark.png for each slot in
//             site/src/figures.json, made into WebP at the slot's widths by
//             playwright-core's own Chromium (offline, every request refused)
//   brand     docs/brand/logo.svg and logo-dark.svg (the header mark and
//             favicon.svg), docs/brand/social-preview.png
//   film      docs/brand/launch.mp4, launch.webm and launch-poster.jpg (FILM, as
//             scripts/launch-video.mjs writes them), copied to media/ with the
//             poster made into WebP; demo.gif beside them. Until all three
//             are there, the band shows the night banner. The phone cut
//             (launch-narrow.*) plays on a narrow screen when it is there too;
//             the film's words, scene by scene, come from the script's SCENES
//   copy      the Quickstart block from README.md, the one-line install from
//             docs/install.md, the copyright line from LICENSE, the version
//             from package.json (and its date from CHANGELOG.md) and the
//             extension's manifest.json
//   pages     site/src/index.html, privacy.html and answers/*.html (served at
//             answers/<name>/); llms.txt and install.sh, with the version and
//             repository filled in
//
// Nothing is fetched. The pages load nothing from another server: a CSP meta
// allows 'self' only, and the inline theme script by its hash.
//
// Usage:
//   node scripts/build-site.mjs [--out DIR] [--no-resize] [--repo URL] [--film DIR]
//   node scripts/build-site.mjs --serve [--base /jantar/] [--port N]   build, then serve on 127.0.0.1
//
// --out must be inside site/ or the OS temp folder (it is emptied first).
// --no-resize copies the PNGs instead of making WebP (quick, for tests).
// --film takes FILM's files (launch.mp4, launch.webm, launch-poster.jpg, the
// launch-narrow.* three, demo.gif) from DIR instead of docs/brand/ (a render
// not yet committed).
// The repository URL comes from GITHUB_SERVER_URL and GITHUB_REPOSITORY (CI),
// else package.json's repository; SITE_URL (CI: actions/configure-pages)
// adds the canonical, Open Graph tags and sitemap.xml.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, endCard } from './launch-video.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
const SRC = join(ROOT, 'site', 'src');
const IMG = join(ROOT, 'docs', 'img');
const BRAND = join(ROOT, 'docs', 'brand');
const WEB = join(ROOT, 'packages', 'web');

/** The two font files the site ships, and the name each package's licence gets. */
export const FONTS = [
  { pkg: '@fontsource-variable/archivo', file: 'archivo-latin-wdth-normal.woff2', licence: 'archivo-OFL.txt', name: 'Archivo' },
  { pkg: '@fontsource-variable/jetbrains-mono', file: 'jetbrains-mono-latin-wght-normal.woff2', licence: 'jetbrains-mono-OFL.txt', name: 'JetBrains Mono' },
];

/** Tokens site.css uses; the build stops if tokens.css lacks one. */
export const TOKENS_USED = [
  'page', 'bg', 'surface', 'hover', 'select', 'raised', 'line', 'line-strong', 'ink', 'ink-2', 'ink-3', 'ink-4',
  'signal', 'term', 'term-ink', 'term-dim', 'jup-fill', 'shadow-float-v',
];
const THEME_VARS = ['radius-chip', 'radius-btn', 'radius-dock', 'ease-out', 'ease-ui'];

/** Absolute links a page may carry (in <a href> only). */
export const ALLOWED_ABSOLUTE = /^https:\/\/(?:github\.com|docs\.github\.com)\//;

const WEBP_QUALITY = 0.82;

/**
 * The launch film and the README's GIF, where scripts/launch-video.mjs writes
 * them. The site plays the film (WebM first, then the H.264 MP4) over its
 * poster; with any of the three missing it shows the night banner, still,
 * and no play control. A screen under NARROW gets the phone cut instead
 * (its poster by <picture>, its video by motion.js), when its three are
 * there. Each is served under media/ by its own name.
 */
export const FILM = {
  mp4: 'docs/brand/launch.mp4',
  webm: 'docs/brand/launch.webm',
  poster: 'docs/brand/launch-poster.jpg',
  mp4Narrow: 'docs/brand/launch-narrow.mp4',
  webmNarrow: 'docs/brand/launch-narrow.webm',
  posterNarrow: 'docs/brand/launch-narrow-poster.jpg',
  gif: 'docs/brand/demo.gif',
};
/** The screens that get the phone cut: the site's one-column widths, where the wide film is under 736 px across. */
export const NARROW = '(max-width: 767px)';
/** Where each is served. */
export const FILM_SERVED = Object.fromEntries(Object.entries(FILM).map(([k, f]) => [k, `media/${basename(f)}`]));
const FILM_WIDTHS = [960, 1440, 1920];
const FILM_SIZES = '(min-width: 1280px) 1184px, (min-width: 1024px) calc(100vw - 96px), (min-width: 768px) calc(100vw - 64px), calc(100vw - 32px)';
const NARROW_WIDTHS = [360, 720, 1080];
const NARROW_SIZES = 'calc(100vw - 32px)';
const FILM_ALT = "A frame from the film, with example data: a Bash prompt waiting in Terminal on the Mac, and the same prompt on the phone with Claude's options as buttons.";
const BANNER_ALT =
  "Jantar: every Claude Code session on your Mac, on your phone. Three phone screens with example data: the board, a plan waiting for approval, and a meeting's summary.";

// ---------------------------------------------------------------------------
// small helpers

function fail(msg) {
  const e = new Error(msg);
  e.siteBuild = true;
  throw e;
}

const read = (p) => readFileSync(p, 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest();
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shown(p) {
  const r = relative(ROOT, p);
  return r.startsWith('..') ? p : r;
}

export function parseArgs(argv) {
  const out = { out: join(ROOT, 'site', 'dist'), resize: true, serve: false, base: '/jantar/', port: 0, repo: null, film: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--out') out.out = resolve(next());
    else if (a === '--no-resize') out.resize = false;
    else if (a === '--serve') out.serve = true;
    else if (a === '--base') out.base = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--repo') out.repo = next();
    else if (a === '--film') out.film = resolve(next());
    else fail(`unknown argument ${a} (see the usage at the top of scripts/build-site.mjs)`);
  }
  if (!out.base.startsWith('/')) out.base = `/${out.base}`;
  if (!out.base.endsWith('/')) out.base = `${out.base}/`;
  return out;
}

/** The out folder is emptied, so it must be inside site/ or the OS temp folder. */
export function safeOut(dir) {
  const target = resolve(dir);
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const parent = real(dirname(target));
  const full = join(parent, target.slice(dirname(target).length + 1));
  const inside = (base) => {
    const b = real(base);
    return full !== b && (full + sep).startsWith(b + sep);
  };
  if (!inside(join(ROOT, 'site')) && !inside(tmpdir())) {
    fail(`--out ${dir} is outside site/ and the temp folder; refusing to empty it`);
  }
  if (full === real(SRC) || (full + sep).startsWith(real(SRC) + sep)) fail('--out may not be site/src');
  return target;
}

// ---------------------------------------------------------------------------
// values

export function readValues(opts = {}) {
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const manifest = JSON.parse(read(join(ROOT, 'packages', 'extension', 'manifest.json')));
  let repo = opts.repo ?? null;
  if (!repo && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) {
    repo = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  }
  if (!repo) {
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (url) repo = url.replace(/^git\+/, '').replace(/\.git$/, '');
  }
  if (!repo) fail('no repository URL: set package.json "repository", or pass --repo');
  repo = repo.replace(/\/+$/, '');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) fail(`the repository URL ${repo} is not https://github.com/<owner>/<name>`);
  const license = read(join(ROOT, 'LICENSE'));
  const m = /^## Notice\s*\n+([^\n]+)/m.exec(license);
  if (!m) fail('LICENSE has no "## Notice" line to take the copyright from');
  // GitHub Pages reports a custom domain as http:// until its certificate is ready and HTTPS is enforced;
  // the site is served over https, so its canonical and Open Graph links use https from the first deploy.
  const siteUrl = (process.env.SITE_URL || '').trim().replace(/\/+$/, '').replace(/^http:\/\//, 'https://') || null;
  if (siteUrl && !/^https:\/\//.test(siteUrl)) fail(`SITE_URL must start with https:// (got ${siteUrl})`);
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? '')?.[1];
  if (!pnpm) fail('package.json "packageManager" is not pnpm@<x.y.z>');
  return { version: pkg.version, extVersion: manifest.version, repo, copyright: m[1].trim(), siteUrl, pnpm, released: releaseDate(pkg.version) };
}

/** The date of the version's CHANGELOG.md heading ("## 0.5.2 (1 November 2026)"), or null. */
export function releaseDate(version, text = existsSync(join(ROOT, 'CHANGELOG.md')) ? read(join(ROOT, 'CHANGELOG.md')) : '') {
  const v = version.replace(/[.]/g, '\\.');
  return new RegExp(`^## ${v} \\(([^)]+)\\)\\s*$`, 'm').exec(text)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// tokens and fonts

export function tokenBlocks() {
  const css = read(join(WEB, 'src', 'styles', 'tokens.css'));
  const day = /:root\s*\{([^}]*--page:[^}]*)\}/.exec(css);
  const night = /:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(css);
  if (!day || !night) fail('tokens.css: the day :root block or the [data-theme=\'dark\'] block is missing');
  const decls = (body) =>
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
  const dayDecls = decls(day[1]);
  const nightDecls = decls(night[1]);
  const has = (list, name) => list.some((d) => d.startsWith(`--${name}:`));
  for (const t of TOKENS_USED) {
    if (!has(dayDecls, t)) fail(`tokens.css: the day block has no --${t}`);
    if (!has(nightDecls, t)) fail(`tokens.css: the night block has no --${t}`);
  }
  const vars = [];
  for (const v of THEME_VARS) {
    const mm = new RegExp(`--${v}:\\s*([^;]+);`).exec(css);
    if (!mm) fail(`tokens.css: no --${v}`);
    vars.push(`--${v}:${mm[1].replace(/\s*\/\*.*$/, '').trim()}`);
  }
  const value = (list, name) => list.find((d) => d.startsWith(`--${name}:`)).split(':').slice(1).join(':').trim();
  const block = (list) => list.map((d) => d.replace(/\s*:\s*/, ':')).join(';');
  return {
    css:
      `:root{${block(dayDecls)}}\n` +
      `@media (prefers-color-scheme: dark){:root:not([data-theme]){${block(nightDecls)}}}\n` +
      `:root[data-theme='dark']{${block(nightDecls)}}\n` +
      `:root{${vars.join(';')}}\n`,
    day: { bg: value(dayDecls, 'bg'), signal: value(dayDecls, 'signal'), ink: value(dayDecls, 'ink') },
    night: { bg: value(nightDecls, 'bg'), signal: value(nightDecls, 'signal'), ink: value(nightDecls, 'ink') },
  };
}

export function fontSources() {
  const req = createRequire(join(WEB, 'package.json'));
  return FONTS.map((f) => {
    let dir;
    try {
      dir = dirname(req.resolve(`${f.pkg}/package.json`));
    } catch {
      fail(`${f.pkg} is not installed in packages/web (run pnpm install)`);
    }
    const file = join(dir, 'files', f.file);
    const licence = join(dir, 'LICENSE');
    if (!existsSync(file)) fail(`${shown(file)} is missing`);
    if (!existsSync(licence)) fail(`${shown(licence)} is missing`);
    return { ...f, src: file, licenceSrc: licence };
  });
}

/** The app's @font-face blocks (fonts.css), pointing at assets/fonts/. */
export function fontFaceCss() {
  const css = read(join(WEB, 'src', 'styles', 'fonts.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  if (blocks.length < 3) fail('packages/web/src/styles/fonts.css: expected the Archivo, JetBrains Mono and fallback @font-face blocks');
  return blocks
    .map((b) =>
      b.replace(/url\('@fontsource-variable\/[^/]+\/files\/([^']+)'\)/g, (_, file) => {
        if (!FONTS.some((f) => f.file === file)) fail(`fonts.css names ${file}, which the site does not ship`);
        return `url('fonts/${file}')`;
      }),
    )
    .map((b) => b.replace(/\s+/g, ' ').replace(/\s*([{};:,])\s*/g, '$1').replace(/;}/g, '}'))
    .join('\n');
}

// ---------------------------------------------------------------------------
// pictures

export function loadFigures() {
  const figs = JSON.parse(read(join(SRC, 'figures.json'))).slots;
  for (const [slot, f] of Object.entries(figs)) {
    for (const k of ['file', 'frame', 'widths', 'sizes', 'alt']) if (!f[k]) fail(`figures.json: slot ${slot} has no ${k}`);
    for (const v of [f.file, `${f.file}-dark`]) {
      const p = join(IMG, `${v}.png`);
      if (!existsSync(p)) fail(`docs/img/${v}.png is missing (slot ${slot}): run scripts/screenshots.mjs first`);
    }
  }
  return figs;
}

/** Width and height from a PNG's IHDR. */
export function pngSize(path) {
  const b = readFileSync(path);
  if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') fail(`${shown(path)} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Width and height from a JPEG's frame header (SOFn). */
export function jpegSize(path) {
  const b = readFileSync(path);
  if (b[0] !== 0xff || b[1] !== 0xd8) fail(`${shown(path)} is not a JPEG`);
  let at = 2;
  while (at + 9 <= b.length) {
    if (b[at] !== 0xff) fail(`${shown(path)}: a broken JPEG segment at byte ${at}`);
    const m = b[at + 1];
    if (m === 0xff) {
      at += 1;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      at += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
    at += 2 + b.readUInt16BE(at + 2);
  }
  fail(`${shown(path)}: no JPEG frame header`);
}

/** PNG or JPEG, by the file's name. */
export const imageSize = (path) => (/\.jpe?g$/i.test(path) ? jpegSize(path) : pngSize(path));

async function makeWebp(jobs) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return false;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    if (process.env.CI) fail(`Chromium is not installed (pnpm exec playwright-core install --only-shell chromium): ${e.message.split('\n')[0]}`);
    return false;
  }
  try {
    const ctx = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    await ctx.route('**/*', (r) => r.abort());
    const page = await ctx.newPage();
    await page.setContent('<!doctype html><title>resize</title>');
    for (const job of jobs) {
      const b64 = readFileSync(job.src).toString('base64');
      const type = /\.jpe?g$/i.test(job.src) ? 'image/jpeg' : 'image/png';
      const out = await page.evaluate(
        async ({ b64, outs, q, type }) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type });
          const res = [];
          for (const o of outs) {
            const bmp = await createImageBitmap(blob, { resizeWidth: o.w, resizeHeight: o.h, resizeQuality: 'high' });
            const c = new OffscreenCanvas(o.w, o.h);
            c.getContext('2d').drawImage(bmp, 0, 0);
            const webp = await c.convertToBlob({ type: 'image/webp', quality: q });
            if (webp.type !== 'image/webp') throw new Error('this Chromium has no WebP encoder');
            const buf = new Uint8Array(await webp.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            res.push(btoa(s));
          }
          return res;
        },
        { b64, outs: job.outs.map(({ w, h }) => ({ w, h })), q: WEBP_QUALITY, type },
      );
      job.outs.forEach((o, i) => writeFileSync(o.path, Buffer.from(out[i], 'base64')));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return true;
}

/**
 * Writes dist/img/* and returns, per slot, what the <picture> needs. Each of
 * `stills` (the film's posters, or the banner) is made into WebP in the same
 * pass and gets its list of files.
 */
async function buildImages(figs, dist, resize, log, stills = []) {
  const imgDir = join(dist, 'img');
  mkdirSync(imgDir, { recursive: true });
  const plan = {};
  const jobs = [];
  for (const still of stills) {
    const widths = [...new Set(still.widths.map((w) => Math.min(w, still.size.width)))].sort((a, b) => a - b);
    const outs = widths.map((w) => ({ w, h: Math.round((w * still.size.height) / still.size.width), path: join(imgDir, `${still.name}-${w}.webp`), rel: `img/${still.name}-${w}.webp` }));
    jobs.push({ src: still.src, outs, still, name: still.name, ext: extname(still.src) });
  }
  for (const [slot, f] of Object.entries(figs)) {
    const size = pngSize(join(IMG, `${f.file}.png`));
    const dark = pngSize(join(IMG, `${f.file}-dark.png`));
    if (dark.width !== size.width || dark.height !== size.height) fail(`docs/img/${f.file}-dark.png is not the size of ${f.file}.png`);
    const widths = [...new Set(f.widths.map((w) => Math.min(w, size.width)))].sort((a, b) => a - b);
    plan[slot] = { ...f, size, light: [], dark: [] };
    for (const variant of ['light', 'dark']) {
      const name = variant === 'dark' ? `${f.file}-dark` : f.file;
      const outs = widths.map((w) => ({ w, h: Math.round((w * size.height) / size.width), path: join(imgDir, `${name}-${w}.webp`), rel: `img/${name}-${w}.webp` }));
      jobs.push({ src: join(IMG, `${name}.png`), outs, slot, variant, name });
    }
  }
  const done = resize ? await makeWebp(jobs) : false;
  if (resize && !done) log('warning: no Chromium to resize with; the pages use the PNGs as they are (slower to load)');
  for (const job of jobs) {
    if (job.still) {
      const rel = `img/${job.name}${job.ext}`;
      if (!done) copyFileSync(job.src, join(dist, rel));
      job.still.list = done ? job.outs.map((o) => ({ w: o.w, rel: o.rel })) : [{ w: job.still.size.width, rel }];
    } else if (done) {
      plan[job.slot][job.variant] = job.outs.map((o) => ({ w: o.w, rel: o.rel }));
    } else {
      const rel = `img/${job.name}.png`;
      if (!existsSync(join(dist, rel))) copyFileSync(job.src, join(dist, rel));
      plan[job.slot][job.variant] = [{ w: plan[job.slot].size.width, rel }];
    }
  }
  return plan;
}

function pictureHtml(slot, p, root) {
  const set = (list) => list.map((i) => `${root}${i.rel} ${i.w}w`).join(', ');
  const eager = p.eager === true;
  const img =
    `<img src="${root}${p.light[0].rel}" srcset="${set(p.light)}" sizes="${esc(p.sizes)}" ` +
    `width="${p.size.width}" height="${p.size.height}" alt="${esc(p.alt)}" ` +
    `${eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
  const pic = `<picture><source media="(prefers-color-scheme: dark)" data-dark srcset="${set(p.dark)}" sizes="${esc(p.sizes)}">${img}</picture>`;
  const cls = [p.frame === 'mac' ? 'mac' : 'phone', p.cls].filter(Boolean).join(' ');
  return `<div class="${cls}" data-slot="${slot}">${pic}</div>`;
}

// ---------------------------------------------------------------------------
// the film

/** Length, codec and layout from an MP4's boxes: the movie header (mvhd), an H.264 track, moov before mdat. */
export function mp4Info(path) {
  const b = readFileSync(path);
  const boxes = (start, end) => {
    const out = [];
    let at = start;
    while (at + 8 <= end) {
      let size = b.readUInt32BE(at);
      let head = 8;
      if (size === 1) {
        size = Number(b.readBigUInt64BE(at + 8));
        head = 16;
      } else if (size === 0) size = end - at;
      if (size < head || at + size > end) break;
      out.push({ type: b.toString('latin1', at + 4, at + 8), start: at + head, end: at + size });
      at += size;
    }
    return out;
  };
  const top = boxes(0, b.length);
  if (top[0]?.type !== 'ftyp') fail(`${shown(path)} is not an MP4 (no ftyp box first)`);
  const moov = top.find((x) => x.type === 'moov');
  const mvhd = moov && boxes(moov.start, moov.end).find((x) => x.type === 'mvhd');
  if (!mvhd) fail(`${shown(path)} has no movie header (moov/mvhd)`);
  const v1 = b[mvhd.start] === 1;
  const scale = b.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
  const length = v1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16);
  if (!scale) fail(`${shown(path)}: a movie header with no timescale`);
  const mdat = top.findIndex((x) => x.type === 'mdat');
  return {
    seconds: length / scale,
    h264: b.subarray(moov.start, moov.end).includes('avc1'),
    faststart: mdat < 0 || top.indexOf(moov) < mdat,
  };
}

/** "0:53" */
export function clock(seconds) {
  const t = Math.round(seconds);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** An MP4 Safari can play from its first bytes, and a WebM that is whole enough to be one. */
function checkVideo(mp4, webm) {
  const info = mp4Info(mp4);
  if (!info.h264) fail(`${shown(mp4)} has no H.264 (avc1) track, which Safari needs`);
  if (!info.faststart) fail(`${shown(mp4)}: the movie header comes after the media; encode it with -movflags +faststart`);
  const ebml = readFileSync(webm).subarray(0, 4);
  if (ebml.length < 4 || ebml.readUInt32BE(0) !== 0x1a45dfa3) fail(`${shown(webm)} is not a WebM`);
  return info;
}

/**
 * Which film the build has: { video, narrow, files, info, still, stillNarrow }.
 * The video needs all three of the MP4, the WebM and the poster; without them
 * the band shows the night banner, still. The phone cut needs its own three
 * and the same length (motion.js swaps one for the other mid-play).
 */
export function filmFiles(dir = null) {
  const at = (rel) => (dir ? join(dir, basename(rel)) : join(ROOT, rel));
  const files = Object.fromEntries(Object.entries(FILM).map(([k, rel]) => [k, existsSync(at(rel)) ? at(rel) : null]));
  const video = Boolean(files.mp4 && files.webm && files.poster);
  const info = video ? checkVideo(files.mp4, files.webm) : null;
  let narrow = false;
  if (video && files.mp4Narrow && files.webmNarrow && files.posterNarrow) {
    const n = checkVideo(files.mp4Narrow, files.webmNarrow);
    if (Math.abs(n.seconds - info.seconds) > 0.5) fail(`${shown(files.mp4Narrow)} is ${n.seconds.toFixed(1)} s and ${shown(files.mp4)} ${info.seconds.toFixed(1)} s: the two cuts must be as long`);
    narrow = true;
  }
  const src = video ? files.poster : join(BRAND, 'banner-dark.png');
  const still = { src, name: basename(src).replace(/\.[a-z]+$/i, ''), size: imageSize(src), widths: FILM_WIDTHS, alt: video ? FILM_ALT : BANNER_ALT };
  const stillNarrow = narrow ? { src: files.posterNarrow, name: basename(files.posterNarrow).replace(/\.[a-z]+$/i, ''), size: imageSize(files.posterNarrow), widths: NARROW_WIDTHS } : null;
  return { video, narrow, files, info, still, stillNarrow };
}

/** The film's words, scene by scene: what each shows and its captions, for <details> under the film (it has no sound). */
export function filmScript(version) {
  const end = endCard(version);
  return SCENES.map((s) => ({
    at: clock(s.start),
    what: s.id === 'S9' ? `The end card: ${end.name}. ${end.tagline} ${end.url}. ${end.meta}. ${end.foot}` : s.what,
    kicker: s.kicker ?? null,
    lines: s.captions.map((c) => c.lines.join(' ')),
  }));
}

/** The band's figure: the poster with a play link, pause and full-screen buttons and the film's words, or the still alone. */
function filmHtml(film, root, version) {
  const s = film.still;
  const set = (list) => list.map((i) => `${root}${i.rel} ${i.w}w`).join(', ');
  const img =
    `<img src="${root}${s.list[0].rel}" srcset="${set(s.list)}" sizes="${FILM_SIZES}" width="${s.size.width}" height="${s.size.height}" ` +
    `alt="${esc(s.alt)}" loading="lazy" decoding="async">`;
  const gif = film.files.gif ? ` <a href="${root}${FILM_SERVED.gif}">A shorter cut, as a GIF</a>` : '';
  if (!film.video) {
    return `<figure class="film-fig"><div class="film-box film-box--still">${img}</div><figcaption class="film-cap"><span class="rail">Example data</span> The board, a plan waiting for approval and a meeting's summary, on the phone.${gif}</figcaption></figure>`;
  }
  const n = film.stillNarrow;
  // a narrow screen gets the phone cut's poster, at its own shape
  const pic = n
    ? `<picture><source media="${NARROW}" srcset="${set(n.list)}" sizes="${NARROW_SIZES}" width="${n.size.width}" height="${n.size.height}">${img}</picture>`
    : img;
  const narrowData = film.narrow ? ` data-webm-narrow="${root}${FILM_SERVED.webmNarrow}" data-mp4-narrow="${root}${FILM_SERVED.mp4Narrow}"` : '';
  const secs = Math.round(film.info.seconds);
  const words = filmScript(version)
    .map(
      (w) =>
        `<li><span class="rail">${w.at}</span><div><p>${esc(w.what)}</p>` +
        (w.kicker ? `<p class="film-kick">On screen: ${w.kicker.startsWith('jantar ') ? `<code>${esc(w.kicker)}</code>` : esc(w.kicker)}</p>` : '') +
        w.lines.map((l) => `<p class="film-said">${esc(l)}</p>`).join('') +
        '</div></li>',
    )
    .join('');
  return (
    `<figure class="film-fig"><div class="film-box" data-film data-webm="${root}${FILM_SERVED.webm}" data-mp4="${root}${FILM_SERVED.mp4}"${narrowData}>${pic}` +
    `<a class="film-play" href="${root}${FILM_SERVED.mp4}"><span class="film-btn"><x-icon name="play"></x-icon></span><span class="film-act">Play the film</span><span class="rail">${clock(secs)} · no sound</span></a></div>` +
    '<div class="film-tools" hidden><button class="film-ctl" type="button" data-act="pause" aria-label="Pause the film"><x-icon name="pause"></x-icon></button>' +
    '<button class="film-ctl" type="button" data-act="full" aria-label="Play the film full screen"><x-icon name="corners-out"></x-icon></button></div>' +
    `<figcaption class="film-cap"><span class="rail">Example data</span> A ${secs}-second film with captions and no sound: a session waits in Terminal, your phone gets the question, one tap answers it, and the session carries on.${gif}</figcaption></figure>` +
    `<details class="film-words"><summary>Read the film's captions</summary><p>What the film shows, scene by scene, and the words on screen. Every screen in it is example data.</p><ol>${words}</ol></details>`
  );
}

// ---------------------------------------------------------------------------
// brand

function logoRects(svg) {
  return [...svg.matchAll(/<rect\b([^>]*)\/>/g)].map((m) => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([a-z-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    return attrs;
  });
}

/** The logo's own viewBox, so the mark and favicon follow docs/brand/logo.svg. */
export function logoViewBox(svg = read(join(BRAND, 'logo.svg'))) {
  const v = /<svg\b[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1];
  if (!v || !/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(v.trim())) fail('docs/brand/logo.svg has no viewBox of four numbers');
  return v.trim();
}

/** The header mark, inline: the logo's rects with fills from the tokens. */
export function markSvg(tokens) {
  const svg = read(join(BRAND, 'logo.svg'));
  const rects = logoRects(svg);
  if (!rects.length) fail('docs/brand/logo.svg has no <rect>s');
  const body = rects
    .map((r) => {
      const cls = r.fill?.toLowerCase() === tokens.day.signal.toLowerCase() ? 'mk-s' : 'mk-i';
      return `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" class="${cls}"/>`;
    })
    .join('');
  return `<svg class="mark" viewBox="${logoViewBox(svg)}" width="20" height="20" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** favicon.svg: the day logo's rects, switched to the night logo's colours by the browser's own scheme. */
export function faviconSvg() {
  const daySvg = read(join(BRAND, 'logo.svg'));
  const nightSvg = read(join(BRAND, 'logo-dark.svg'));
  const day = logoRects(daySvg);
  const night = logoRects(nightSvg);
  if (day.length !== night.length) fail('docs/brand/logo.svg and logo-dark.svg differ in their rects');
  if (logoViewBox(daySvg) !== logoViewBox(nightSvg)) fail('docs/brand/logo.svg and logo-dark.svg differ in their viewBox');
  const colours = [...new Set(day.map((r) => r.fill))];
  const cls = (fill) => `c${colours.indexOf(fill)}`;
  const nightOf = (fill) => night[day.findIndex((r) => r.fill === fill)].fill;
  const style =
    colours.map((c) => `.${cls(c)}{fill:${c}}`).join('') +
    `@media (prefers-color-scheme: dark){${colours.map((c) => `.${cls(c)}{fill:${nightOf(c)}}`).join('')}}`;
  const body = day.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" class="${cls(r.fill)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${logoViewBox(daySvg)}" width="64" height="64" shape-rendering="crispEdges"><style>${style}</style>${body}</svg>\n`;
}

/** The hairline dial: two quarter arcs round the lower-left corner, a tick every 6 degrees, one in mustard. */
export function dialSvg() {
  const S = 240;
  const arc = (r) => `<path d="M${r} ${S} A${r} ${r} 0 0 0 0 ${S - r}"/>`;
  const ticks = [];
  for (let deg = 0; deg <= 90; deg += 6) {
    const a = (deg * Math.PI) / 180;
    const p = (r) => [(r * Math.cos(a)).toFixed(2), (S - r * Math.sin(a)).toFixed(2)];
    const [x1, y1] = p(220);
    const [x2, y2] = p(deg % 18 === 0 ? 234 : 228);
    ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${deg === 54 ? ' class="now"' : ''}/>`);
  }
  return `<svg class="dial" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" aria-hidden="true" focusable="false">${arc(200)}${arc(220)}${ticks.join('')}</svg>`;
}

export function iconSvgs() {
  const src = read(join(SRC, 'icons.svg'));
  const icons = {};
  for (const m of src.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)"><path d="([^"]+)"\/><\/symbol>/g)) {
    icons[m[1]] = `<svg class="ic" viewBox="${m[2]}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${m[3]}"/></svg>`;
  }
  return icons;
}

// ---------------------------------------------------------------------------
// README and docs

/** The step-by-step ```sh block under README's ## Quickstart (the one that starts with git clone), verbatim. */
export function quickstartBlock() {
  const readme = read(join(ROOT, 'README.md'));
  const at = readme.search(/^#{1,3} Quickstart\s*$/m);
  if (at < 0) fail('README.md has no Quickstart heading');
  const m = /```sh\n(git clone [\s\S]*?)\n```/.exec(readme.slice(at));
  if (!m) fail('README.md: no ```sh block that starts with git clone under Quickstart');
  return m[1];
}

/** The first ```sh block under docs/install.md's "## Install in one line", verbatim. */
export function oneLineBlock(text = read(join(ROOT, 'docs', 'install.md'))) {
  const at = text.search(/^## Install in one line\s*$/m);
  if (at < 0) fail('docs/install.md has no "## Install in one line" heading');
  const m = /```sh\n([\s\S]*?)\n```/.exec(text.slice(at));
  if (!m) fail('docs/install.md: no ```sh block under "Install in one line"');
  if (!/^curl -fsSL https:\/\/\S+\/install\.sh \| bash$/m.test(m[1])) fail('docs/install.md: the one-line block has no "curl -fsSL https://.../install.sh | bash" line');
  return m[1];
}

/** HTML for the quickstart: escaped, each shell comment in a dim span. */
export function quickstartHtml(text) {
  return text
    .split('\n')
    .map((line) => {
      let q = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          return `${esc(line.slice(0, i))}<span class="c">${esc(line.slice(i))}</span>`;
        }
      }
      return esc(line);
    })
    .join('\n');
}

/** GitHub's heading anchors for a Markdown file (fenced code skipped, repeats numbered). */
export function markdownAnchors(text) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const plain = m[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '');
    let slug = plain
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    out.add(slug);
  }
  return out;
}

function docUrl(target, repo) {
  const [path, anchor] = target.split('#');
  const full = join(ROOT, path);
  if (!existsSync(full)) return null;
  if (anchor !== undefined) {
    if (!path.endsWith('.md')) fail(`{{doc ${target}}}: an #anchor needs a Markdown file`);
    if (!markdownAnchors(read(full)).has(anchor)) fail(`{{doc ${target}}}: ${path} has no heading for #${anchor}`);
  }
  return `${repo}/blob/main/${path}${anchor !== undefined ? `#${anchor}` : ''}`;
}

// ---------------------------------------------------------------------------
// pages

function themeSwitch() {
  return (
    '<div class="seg" role="group" aria-label="Theme" hidden>' +
    ['system', 'light', 'dark']
      .map((t) => `<button type="button" data-theme-set="${t}" aria-pressed="${t === 'system'}">${t[0].toUpperCase()}${t.slice(1)}</button>`)
      .join('') +
    '</div>'
  );
}

export function cspFor(inlineScripts) {
  const hashes = inlineScripts.map((s) => `'sha256-${sha256(s).toString('base64')}'`).join(' ');
  return [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "media-src 'self'",
    `script-src 'self' ${hashes}`.trim(),
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function socialTags(page, values, ogImage) {
  if (!values.siteUrl) return '';
  const url = `${values.siteUrl}/${page.path}`;
  const title = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? 'Jantar';
  const desc = /<meta name="description" content="([^"]*)">/.exec(page.html)?.[1] ?? '';
  return [
    `<link rel="canonical" href="${url}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Jantar">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${values.siteUrl}/${ogImage.name}">`,
    `<meta property="og:image:width" content="${ogImage.width}">`,
    `<meta property="og:image:height" content="${ogImage.height}">`,
    '<meta property="og:image:alt" content="Jantar: every Claude Code session on your Mac, on your phone. Two phone screens: the board and a plan waiting for approval.">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n');
}

/**
 * A text link's last word and its arrow icon go in one <span class="nw">, so
 * the arrow never starts a line on its own. Buttons and header cells (links
 * with a class) lay their icon out with flex and are left alone.
 */
export function nowrapArrows(html) {
  return html.replace(
    /(<a\b(?![^>]*\sclass=)[^>]*>[^<]*?)([^\s<>]+)(<x-icon name="[^"]+"><\/x-icon>)<\/a>/g,
    (_, open, word, icon) => `${open}<span class="nw">${word}${icon}</span></a>`,
  );
}

/**
 * A separator dot between words (" · ") is glued to the word before it with a
 * no-break space, so a wrapped line never starts with "·". Text only, not tags.
 */
export function keepDots(html) {
  return html.replace(/>([^<]+)</g, (_, text) => `>${text.replace(/ \u00b7 /g, '&nbsp;\u00b7 ')}<`);
}

/** Where a page in site/src is served: index.html at the root, privacy.html at privacy/, answers/x.html at answers/x/. */
export function pagePath(name) {
  if (name === 'index.html') return '';
  const base = name.replace(/\.html$/, '');
  return base.endsWith('/index') ? base.slice(0, -'index'.length) : `${base}/`;
}

export function renderPage(name, ctx) {
  const path = pagePath(name);
  const depth = path.split('/').length - 1;
  const root = '../'.repeat(depth);
  const home = depth ? root : './';
  let html = read(join(SRC, name));
  html = html
    .replace('<x-header></x-header>', read(join(SRC, 'header.html')).trim())
    .replace('<x-footer></x-footer>', read(join(SRC, 'footer.html')).trim());
  if (ctx.film) {
    html = html.replace('<x-film></x-film>', filmHtml(ctx.film, root, ctx.values.version)).replace(
      '<x-film-link></x-film-link>',
      ctx.film.video
        ? `<p class="watch"><a href="#film">Watch the film<x-icon name="play"></x-icon></a> <span class="rail">${clock(ctx.film.info.seconds)} · no sound</span></p>`
        : '',
    );
  }
  const changelog = existsSync(join(ROOT, 'CHANGELOG.md'));
  if (!changelog) html = html.replace(/\s*<a href="\{\{doc CHANGELOG\.md\}\}"[^>]*>Changelog<\/a>/, '');
  html = keepDots(nowrapArrows(html));
  html = html
    .replace(/<x-figure slot="([^"]+)"><\/x-figure>/g, (_, slot) => {
      const p = ctx.images[slot];
      if (!p) fail(`${name}: no figure slot "${slot}" in figures.json`);
      ctx.usedSlots.add(slot);
      return pictureHtml(slot, p, root);
    })
    .replace(/<x-icon name="([^"]+)"><\/x-icon>/g, (_, n) => ctx.icons[n] ?? fail(`${name}: no icon "${n}" in icons.svg`))
    .replace(/<x-mark><\/x-mark>/g, ctx.mark)
    .replace(/<x-dial><\/x-dial>/g, ctx.dial)
    .replace(/<x-theme><\/x-theme>/g, themeSwitch())
    .replace('<x-quickstart></x-quickstart>', ctx.quickstart)
    .replace('<x-install-line></x-install-line>', ctx.oneLine);
  html = html.replace(/\{\{doc ([^}]+)\}\}/g, (_, target) => docUrl(target.trim(), ctx.values.repo) ?? fail(`{{doc ${target}}}: ${target.split('#')[0]} does not exist`));
  const page = { path, html };
  const vars = {
    csp: ctx.csp,
    'theme-color': [
      `<meta name="theme-color" content="${ctx.tokens.day.bg}" media="(prefers-color-scheme: light)">`,
      `<meta name="theme-color" content="${ctx.tokens.night.bg}" media="(prefers-color-scheme: dark)">`,
    ].join('\n'),
    'theme-init': `<script>${ctx.themeInit}</script>`,
    social: socialTags(page, ctx.values, ctx.ogImage),
    root,
    home,
    css: ctx.cssPath,
    js: ctx.jsPath,
    'motion-js': ctx.motionPath,
    // filled after keepDots, so its dots carry their no-break spaces already
    'film-lbl': ctx.film?.video ? `the film&nbsp;· ${clock(ctx.film.info.seconds)}&nbsp;· no sound` : 'three screens&nbsp;· example data',
    'release-on': ctx.values.released ? `, ${esc(ctx.values.released)}` : '',
    repo: ctx.values.repo,
    version: esc(ctx.values.version),
    'ext-version': esc(ctx.values.extVersion),
    copyright: esc(ctx.values.copyright),
  };
  html = html.replace(/\{\{([a-z-]+)\}\}/g, (all, k) => (k in vars ? vars[k] : fail(`${name}: unknown placeholder ${all}`)));
  // Comments in the source are notes for whoever edits it; the page doesn't need them.
  html = html.replace(/\n?<!--[\s\S]*?-->\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return html;
}

/** Fills a text file's {{placeholders}} from `vars`; any other one stops the build. */
function fillText(name, text, vars) {
  return text.replace(/\{\{([a-z-]+)\}\}/g, (all, k) => (k in vars ? vars[k] : fail(`${name}: unknown placeholder ${all}`)));
}

/** install.sh, served at the site's root, for the release in package.json. */
export function installSh(values = readValues()) {
  return fillText('site/src/install.sh', read(join(SRC, 'install.sh')), { version: values.version, repo: values.repo, pnpm: values.pnpm });
}

/**
 * llms.txt: the site's own pages by its address (or relative, with no
 * SITE_URL), the docs as raw Markdown from the repository's main branch. Every
 * file it names must exist.
 */
export function llmsTxt(values = readValues()) {
  const raw = values.repo.replace(/^https:\/\/github\.com\//, 'https://raw.githubusercontent.com/') + '/main';
  const oneLine = /^curl -fsSL (https:\/\/\S+\/install\.sh) \| bash$/m.exec(oneLineBlock());
  const text = fillText('site/src/llms.txt', read(join(SRC, 'llms.txt')), {
    version: values.version,
    repo: values.repo,
    raw,
    site: values.siteUrl ? `${values.siteUrl}/` : '',
    'one-line': oneLine[0],
    'install-url': oneLine[1],
  });
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (!m[1].startsWith(`${raw}/`)) continue;
    const file = m[1].slice(raw.length + 1);
    if (!existsSync(join(ROOT, file))) fail(`site/src/llms.txt names ${file}, which does not exist`);
  }
  return text;
}

function fontsIndex(ctx) {
  const items = FONTS.map((f) => `<li><a href="${f.file}">${f.file}</a> · <a href="${f.licence}">${f.licence}</a> (${f.name}, SIL Open Font License 1.1)</li>`).join('\n');
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ctx.csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fonts: Jantar</title>
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="../../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../${ctx.cssPath.replace(/^assets\//, '')}">
<script>${ctx.themeInit}</script>
</head>
<body>
<main class="sec g-bg doc-page" id="main"><div class="frame"><div class="prose">
<h1 class="h1 h1--page">The fonts on this site</h1>
<p class="lede">Archivo and JetBrains Mono, the web app's own variable fonts (latin subset), from Fontsource. Each is under the SIL Open Font License 1.1.</p>
<ul class="ledger ledger--plain">
${items}
</ul>
<p class="more"><a href="../../">Back to the site</a></p>
</div></div></main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// the build

export async function build(opts, log = (s) => process.stdout.write(`${s}\n`)) {
  const out = safeOut(opts.out);
  const values = readValues({ repo: opts.repo });
  const tokens = tokenBlocks();
  const fonts = fontSources();
  const figs = loadFigures();
  for (const f of ['logo.svg', 'logo-dark.svg', 'social-preview.png']) {
    if (!existsSync(join(BRAND, f))) fail(`docs/brand/${f} is missing: run scripts/brand.mjs first`);
  }
  const appleIcon = join(WEB, 'public', 'icons', 'apple-touch-icon.png');
  if (!existsSync(appleIcon)) fail(`${shown(appleIcon)} is missing`);
  const film = filmFiles(opts.film ?? null);
  const answers = readdirSync(join(SRC, 'answers'))
    .filter((f) => f.endsWith('.html'))
    .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)))
    .map((f) => `answers/${f}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets', 'fonts'), { recursive: true });
  mkdirSync(join(out, 'privacy'), { recursive: true });

  for (const f of fonts) {
    copyFileSync(f.src, join(out, 'assets', 'fonts', f.file));
    copyFileSync(f.licenceSrc, join(out, 'assets', 'fonts', f.licence));
  }

  const siteCss = read(join(SRC, 'site.css'));
  const css =
    '/* Jantar site. Colours from packages/web/src/styles/tokens.css; Archivo and JetBrains Mono (OFL-1.1) from @fontsource-variable. */\n' +
    tokens.css +
    `${fontFaceCss()}\n` +
    siteCss
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n') +
    '\n';
  const cssPath = `assets/site.${sha256(css).toString('hex').slice(0, 8)}.css`;
  writeFileSync(join(out, cssPath), css);
  const js = read(join(SRC, 'site.js'));
  const jsPath = `assets/site.${sha256(js).toString('hex').slice(0, 8)}.js`;
  writeFileSync(join(out, jsPath), js);
  const motion = read(join(SRC, 'motion.js'));
  const motionPath = `assets/motion.${sha256(motion).toString('hex').slice(0, 8)}.js`;
  writeFileSync(join(out, motionPath), motion);
  const themeInit = read(join(SRC, 'theme-init.js')).trim();

  const images = await buildImages(figs, out, opts.resize, log, [film.still, film.stillNarrow].filter(Boolean));
  if (film.video || film.files.gif) mkdirSync(join(out, 'media'), { recursive: true });
  if (film.video) {
    for (const k of ['mp4', 'webm', ...(film.narrow ? ['mp4Narrow', 'webmNarrow'] : [])]) copyFileSync(film.files[k], join(out, FILM_SERVED[k]));
  } else {
    const have = Object.entries(film.files).filter(([k, f]) => f && ['mp4', 'webm', 'poster'].includes(k));
    if (have.length) log(`note: the film needs ${FILM.mp4}, ${FILM.webm} and ${FILM.poster}; with only ${have.map(([k]) => k).join(', ')} the site shows the banner`);
  }
  if (film.files.gif) copyFileSync(film.files.gif, join(out, FILM_SERVED.gif));

  const social = join(BRAND, 'social-preview.png');
  copyFileSync(social, join(out, 'social-preview.png'));
  writeFileSync(join(out, 'favicon.svg'), faviconSvg());
  copyFileSync(appleIcon, join(out, 'apple-touch-icon.png'));

  const ctx = {
    values,
    tokens,
    images,
    usedSlots: new Set(),
    icons: iconSvgs(),
    mark: markSvg(tokens),
    dial: dialSvg(),
    quickstart: quickstartHtml(quickstartBlock()),
    oneLine: quickstartHtml(oneLineBlock()),
    film,
    themeInit,
    csp: cspFor([themeInit]),
    cssPath,
    jsPath,
    motionPath,
    ogImage: { name: 'social-preview.png', ...pngSize(social) },
  };
  const pages = ['index.html', 'privacy.html', ...answers];
  for (const name of pages) {
    const dir = join(out, pagePath(name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), renderPage(name, ctx));
  }
  writeFileSync(join(out, 'assets', 'fonts', 'index.html'), keepDots(fontsIndex(ctx)));
  const unused = Object.keys(figs).filter((s) => !ctx.usedSlots.has(s));
  if (unused.length) fail(`figures.json slots no page uses: ${unused.join(', ')}`);

  writeFileSync(join(out, 'llms.txt'), llmsTxt(values));
  writeFileSync(join(out, 'install.sh'), installSh(values));
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${values.siteUrl ? `Sitemap: ${values.siteUrl}/sitemap.xml\n` : ''}`);
  if (values.siteUrl) {
    writeFileSync(
      join(out, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        pages.map((name) => `  <url><loc>${values.siteUrl}/${pagePath(name)}</loc></url>\n`).join('') +
        '</urlset>\n',
    );
  }

  const problems = checkDist(out, { siteUrl: values.siteUrl });
  if (problems.length) fail(`the built site has problems:\n  ${problems.join('\n  ')}`);

  const files = listFiles(out);
  const total = files.reduce((n, f) => n + statSync(join(out, f)).size, 0);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const size = (rel) => statSync(join(out, rel)).size;
  const heroLight = images.hero.light.find((i) => i.w >= 400) ?? images.hero.light.at(-1);
  const firstView = size('index.html') + size(cssPath) + size('assets/fonts/archivo-latin-wdth-normal.woff2') + size(heroLight.rel);
  log(`built ${shown(out)}: ${files.length} files, ${kb(total)}`);
  log(`  index.html ${kb(size('index.html'))} · ${cssPath} ${kb(size(cssPath))} · ${jsPath} ${kb(size(jsPath))} · ${motionPath} ${kb(size(motionPath))}`);
  log(`  first view (html, css, Archivo, the hero phone at 2x): ${kb(firstView)}`);
  const cut = (mp4, webm, still) => files.filter((f) => f === mp4 || f === webm || f.startsWith(`img/${still.name}-`) || f === `img/${basename(still.src)}`).reduce((n, f) => n + size(f), 0);
  log(film.video ? `  the film (${clock(film.info.seconds)}): MP4, WebM and poster ${kb(cut(FILM_SERVED.mp4, FILM_SERVED.webm, film.still))}` : `  no film yet (${FILM.mp4}, ${FILM.webm}, ${FILM.poster}): the band shows the banner`);
  if (film.narrow) log(`  the phone cut: MP4, WebM and poster ${kb(cut(FILM_SERVED.mp4Narrow, FILM_SERVED.webmNarrow, film.stillNarrow))}`);
  log(`  repository ${values.repo}${values.siteUrl ? ` · site ${values.siteUrl}` : ' · no SITE_URL: no canonical or Open Graph tags'}`);
  return { out, cssPath, jsPath, motionPath, values, files, film };
}

// ---------------------------------------------------------------------------
// checks (the build runs them; scripts/build-site.test.mjs runs them too)

export function listFiles(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, base, acc);
    else acc.push(relative(base, p).split(sep).join('/'));
  }
  return acc.sort();
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The file a relative URL from `fromRel` names in `dist`, or null. */
function resolveIn(dist, fromRel, url) {
  const clean = url.split('#')[0].split('?')[0];
  let target = clean === '' ? fromRel : posix.normalize(posix.join(posix.dirname(fromRel), clean));
  if (target.startsWith('..')) return null;
  if (clean.endsWith('/') || clean === '' || clean === '.') target = clean === '' ? fromRel : posix.join(target, 'index.html');
  const full = join(dist, target);
  if (existsSync(full) && statSync(full).isDirectory()) return existsSync(join(full, 'index.html')) ? posix.join(target, 'index.html') : null;
  return existsSync(full) ? target : null;
}

export function checkDist(dist, { siteUrl = null } = {}) {
  const problems = [];
  const files = listFiles(dist);
  const html = files.filter((f) => f.endsWith('.html'));
  const ids = new Map(html.map((f) => [f, new Set([...read(join(dist, f)).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));
  for (const f of html) {
    const text = read(join(dist, f));
    const p = (s) => problems.push(`${f}: ${s}`);
    if (!/<html lang="en-GB">/.test(text)) p('<html> is not lang="en-GB"');
    const h1 = (text.match(/<h1\b/g) ?? []).length;
    if (h1 !== 1) p(`${h1} <h1> elements (want 1)`);
    const head = /<head>\s*<meta charset="utf-8">\s*<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(text);
    if (!head) p('the CSP meta is not the first element after the charset');
    else {
      const csp = head[1];
      if (/\*|unsafe-/.test(csp)) p(`the CSP allows too much: ${csp}`);
      const inline = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      for (const s of inline) {
        if (!csp.includes(`'sha256-${sha256(s).toString('base64')}'`)) p('an inline script is not allowed by its hash in the CSP');
      }
    }
    if (/\sstyle="/.test(text)) p('a style="" attribute (the CSP refuses it)');
    if (/<style\b/.test(text)) p('a <style> element (the CSP refuses it)');
    if (/\{\{|<x-[a-z]/.test(text)) p('an unfilled {{placeholder}} or <x-...> element');
    let eager = 0;
    for (const m of text.matchAll(/<img\b[^>]*>/g)) {
      const tag = m[0];
      for (const a of ['alt', 'width', 'height', 'decoding']) if (!attr(tag, a)) p(`<img> without ${a}: ${tag.slice(0, 80)}`);
      const loading = attr(tag, 'loading');
      if (loading === 'eager') eager++;
      else if (loading !== 'lazy') p(`<img> without loading="lazy": ${tag.slice(0, 80)}`);
    }
    if (eager > 1) p(`${eager} eager images (want at most 1)`);
    // every resource a page loads is ours and relative
    const resources = [];
    for (const m of text.matchAll(/<(?:img|source|script|link)\b[^>]*>/g)) {
      const tag = m[0];
      const rel = attr(tag, 'rel');
      for (const a of ['src', 'href']) {
        const v = attr(tag, a);
        if (v === undefined) continue;
        if (tag.startsWith('<link') && rel === 'canonical') {
          if (!siteUrl || !v.startsWith(siteUrl)) p(`a canonical link outside SITE_URL: ${v}`);
          continue;
        }
        resources.push(v);
      }
      const srcset = attr(tag, 'srcset');
      if (srcset) for (const part of srcset.split(',')) resources.push(part.trim().split(/\s+/)[0]);
    }
    // the film's sources, which motion.js puts in a <video>
    for (const m of text.matchAll(/\sdata-(?:webm|mp4)(?:-narrow)?="([^"]*)"/g)) resources.push(m[1]);
    for (const v of resources) {
      if (/^(?:[a-z]+:|\/\/|\/)/i.test(v)) p(`a resource that is not relative: ${v}`);
      else if (!resolveIn(dist, f, v)) p(`a resource that is not in the build: ${v}`);
    }
    for (const m of text.matchAll(/<meta property="og:[a-z:]+" content="([^"]*)">/g)) {
      if (/^https?:/.test(m[1]) && (!siteUrl || !m[1].startsWith(siteUrl))) p(`an Open Graph URL outside SITE_URL: ${m[1]}`);
    }
    for (const m of text.matchAll(/<a\b[^>]*>/g)) {
      const href = attr(m[0], 'href');
      if (href === undefined) continue;
      if (/^[a-z]+:|^\/\//i.test(href)) {
        if (!ALLOWED_ABSOLUTE.test(href)) p(`a link outside GitHub: ${href}`);
        continue;
      }
      if (href.startsWith('/')) {
        p(`a root-relative link (breaks under a sub-path): ${href}`);
        continue;
      }
      const target = resolveIn(dist, f, href);
      if (!target) {
        p(`a link to nothing: ${href}`);
        continue;
      }
      const hash = href.split('#')[1];
      if (hash && target.endsWith('.html') && !ids.get(target)?.has(hash)) p(`a link to a missing #${hash} in ${target}`);
    }
  }
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const text = read(join(dist, f));
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const v = m[1];
      if (v.startsWith('data:')) continue;
      if (/^(?:[a-z]+:|\/\/|\/)/i.test(v)) problems.push(`${f}: url() that is not relative: ${v}`);
      else if (!resolveIn(dist, f, v)) problems.push(`${f}: url() not in the build: ${v}`);
    }
    if (/@import/.test(text)) problems.push(`${f}: @import`);
  }
  for (const need of ['index.html', 'privacy/index.html', 'answers/index.html', 'favicon.svg', 'apple-touch-icon.png', 'social-preview.png', 'robots.txt', 'llms.txt', 'install.sh']) {
    if (!files.includes(need)) problems.push(`missing ${need}`);
  }
  for (const f of FONTS) {
    for (const n of [f.file, f.licence]) if (!files.includes(`assets/fonts/${n}`)) problems.push(`missing assets/fonts/${n}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// --serve

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Serves `dir` at http://127.0.0.1:<port><base>, as Pages would under a project sub-path. */
export function serve(dir, { base = '/jantar/', port = 0 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let path = decodeURIComponent(url.pathname);
    if (path === base.slice(0, -1)) {
      res.writeHead(301, { location: base });
      res.end();
      return;
    }
    if (!path.startsWith(base)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    path = path.slice(base.length);
    let file = resolve(dir, path);
    if (!(file + sep).startsWith(resolve(dir) + sep) && file !== resolve(dir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      ok({ url: `http://127.0.0.1:${p}${base}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const opts = parseArgs(process.argv.slice(2));
    const r = await build(opts);
    if (opts.serve) {
      const s = await serve(r.out, { base: opts.base, port: opts.port });
      process.stdout.write(`serving ${shown(r.out)} at ${s.url} (Ctrl-C stops it)\n`);
    } else {
      process.stdout.write(`preview: node scripts/build-site.mjs --serve   (serves it at http://127.0.0.1:<port>${opts.base})\n`);
    }
  };
  main().catch((e) => {
    process.stderr.write(`build-site: ${e?.siteBuild ? e.message : (e?.stack ?? String(e))}\n`);
    process.exit(1);
  });
}
