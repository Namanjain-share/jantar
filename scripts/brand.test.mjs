// node --test scripts/
// The brand files in docs/brand: what scripts/brand.mjs writes (beside the
// launch film and GIF of scripts/launch-video.mjs, tested there), their sizes,
// that the logos are plain rects in the app's colours, that the mark is the
// app's own, and that the README shows what exists. Drawing the PNGs needs
// a Chromium; this only reads (and builds the pages as text).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { BRAND_FILES, MARK_RECTS, PHONES, PICTURES, WORDS, bannerHtml, logoSvg, socialHtml, tokens, wanted } from './brand.mjs';
import { variants } from './screenshots.mjs';
import { OUT } from './launch-video.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'brand.mjs');
const repo = join(dirname(script), '..');
const brand = join(repo, 'docs', 'brand');

const pngSize = (file) => {
  const head = readFileSync(file).subarray(0, 26);
  assert.equal(head.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), colourType: head[25] };
};

test('docs/brand holds the files brand.mjs writes, and only the launch film and GIF besides', () => {
  const have = readdirSync(brand)
    .filter((f) => !f.startsWith('.'))
    .sort();
  const film = Object.values(OUT).map((f) => basename(f));
  for (const f of BRAND_FILES) assert.ok(have.includes(f), `${f} is missing`);
  assert.deepEqual(
    have.filter((f) => !BRAND_FILES.includes(f) && !film.includes(f)),
    [],
    'a file neither brand.mjs nor launch-video.mjs writes',
  );
});

test('the banners are 1600 x 520 with transparent corners, the social preview 1280 x 640, all small', () => {
  for (const f of ['banner.png', 'banner-dark.png']) {
    const s = pngSize(join(brand, f));
    assert.deepEqual([s.width, s.height], [PICTURES.banner.width * PICTURES.banner.scale, PICTURES.banner.height * PICTURES.banner.scale], f);
    assert.equal(s.colourType, 6, `${f} has an alpha channel (its corners are rounded)`);
    assert.ok(statSync(join(brand, f)).size < 512 * 1024, `${f} is over 512 KB`);
  }
  const s = pngSize(join(brand, 'social-preview.png'));
  assert.deepEqual([s.width, s.height], [1280, 640]);
  assert.deepEqual([PICTURES.social.width * PICTURES.social.scale, PICTURES.social.height * PICTURES.social.scale], [1280, 640]);
  // GitHub refuses a social preview of 1 MB or more.
  assert.ok(statSync(join(brand, 'social-preview.png')).size < 1024 * 1024);
});

test('each logo is plain rects with crisp edges in its theme colours, and is what brand.mjs writes now', () => {
  for (const [file, theme] of [
    ['logo.svg', 'light'],
    ['logo-dark.svg', 'dark'],
  ]) {
    const svg = readFileSync(join(brand, file), 'utf8');
    const t = tokens(theme);
    assert.equal(svg, logoSvg(theme), `${file} is out of date: run node scripts/brand.mjs --only logo`);
    const tags = [...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(tags)], ['svg', 'rect'], file);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16"/);
    assert.match(svg, /shape-rendering="crispEdges"/);
    assert.ok(!/<text|<style|<script|font|href|data:/i.test(svg), file);
    const fills = new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
    assert.deepEqual([...fills].sort(), [t['--ink'], t['--signal']].sort(), file);
    // The needs-you cell is the only signal-coloured rect.
    assert.equal([...svg.matchAll(new RegExp(`fill="${t['--signal']}"`, 'g'))].length, 1, file);
  }
  assert.equal(tokens('light')['--signal'], '#c63d2c');
  assert.equal(tokens('dark')['--signal'], '#ff6b57');
});

test("the mark is the app's own: kit/Mark.tsx and the icon both draw the same rects", () => {
  const mark = readFileSync(join(repo, 'packages', 'web', 'src', 'ui', 'kit', 'Mark.tsx'), 'utf8');
  const fromMark = [...mark.matchAll(/<rect\b[^>]*\bx="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((m) => m.slice(1, 5).map(Number));
  assert.deepEqual(
    fromMark,
    MARK_RECTS.map(([x, y, w, h]) => [x, y, w, h]),
  );
  // public/icons/icon.svg: the same rects at 18 units, 130 in (gen-icons.mjs).
  const icon = readFileSync(join(repo, 'packages', 'web', 'public', 'icons', 'icon.svg'), 'utf8');
  const fromIcon = [...icon.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((m) => {
    const [x, y, w, h] = m.slice(1, 5).map(Number);
    return [(x - 130) / 18, (y - 130) / 18, w / 18, h / 18];
  });
  assert.deepEqual(
    fromIcon,
    MARK_RECTS.map(([x, y, w, h]) => [x, y, w, h]),
  );
});

test('the pages hold only the words, the app colours and inlined pictures: nothing from the network', () => {
  const fake = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB', 'data:image/png;base64,CCCC'];
  for (const theme of ['light', 'dark']) {
    for (const html of [bannerHtml(theme, fake), socialHtml(theme, fake.slice(0, 2))]) {
      assert.ok(!/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(html), 'a URL in a page');
      assert.ok(!/<script|<link|@import/i.test(html), 'a script or a stylesheet link in a page');
      assert.ok(!/gradient|filter:\s*blur|text-shadow/i.test(html), 'a gradient or a glow (tokens.css bans colour blends)');
      for (const m of html.matchAll(/url\(([^)]+)\)/g)) assert.ok(m[1].startsWith('data:font/woff2;base64,'), 'only the inlined fonts');
      // Every hex colour is one of the theme's tokens.
      const t = new Set(Object.values(tokens(theme)));
      for (const m of html.matchAll(/#[0-9a-f]{6}\b/gi)) assert.ok(t.has(m[0].toLowerCase()), `${theme}: ${m[0]} is not a token`);
    }
  }
  const words = [WORDS.name, WORDS.tagline, ...WORDS.mono, WORDS.license].join(' ');
  assert.ok(!/open[- ]source/i.test(words), 'the project is source-available');
  assert.ok(words.includes('FSL-1.1-MIT'));
});

test('the phones are screenshots the screenshot script takes', () => {
  const taken = new Set(variants().map((v) => v.file));
  for (const n of [...PHONES.banner, ...PHONES.social]) {
    assert.ok(taken.has(n), n);
    assert.ok(taken.has(`${n}-dark`), `${n}-dark`);
  }
});

test('--only and --list', () => {
  assert.deepEqual(wanted(new Set(['banner'])), ['banner.png', 'banner-dark.png']);
  assert.deepEqual(wanted(new Set(['logo'])), ['logo.svg', 'logo-dark.svg']);
  assert.deepEqual(wanted(new Set(['social-preview'])), ['social-preview.png']);
  assert.deepEqual(wanted(new Set(['banner-dark.png'])), ['banner-dark.png']);
  const r = spawnSync(process.execPath, [script, '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.stdout.trim().split('\n'),
    BRAND_FILES.map((f) => `docs/brand/${f}`),
  );
});

test('the README shows only brand files that exist, the banner with its night copy', () => {
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  const shown = [...readme.matchAll(/(?:src|srcset)=["'](docs\/brand\/[^"']+)["']|!\[[^\]]*\]\((docs\/brand\/[^)\s]+)\)/g)].map((m) => m[1] ?? m[2]);
  const film = Object.values(OUT);
  for (const p of shown) assert.ok(BRAND_FILES.includes(p.slice('docs/brand/'.length)) || film.includes(p), p);
  if (shown.includes('docs/brand/banner.png')) {
    // its night copy, in a <source> whose media query asks for dark (alone, or with reduced motion when a GIF leads)
    assert.match(readme, /<source media="[^"]*\(prefers-color-scheme: dark\)[^"]*" srcset="docs\/brand\/banner-dark\.png">/);
  }
});
