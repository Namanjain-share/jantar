// node --test scripts/
// The pictures: the list scripts/screenshots.mjs takes, the files in docs/img
// that it wrote, and the images the README and the docs pages show, kept in
// step. Taking the pictures needs a built web app and a Chromium; this only reads.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SIZES, SHOTS, SIZES, THEMES, fileName, fixtureKey, sidOf, sizesOf, variants } from './screenshots.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'screenshots.mjs');
const repo = join(dirname(script), '..');
const img = join(repo, 'docs', 'img');

/** The variants web-fixture-v051.ts knows. */
const FIXTURE_VARIANTS = ['phone-control', 'keypad', 'ask', 'posts'];

test('every screen has a unique name, a path in the app, and two themes for each size it asks for', () => {
  const names = SHOTS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const s of SHOTS) {
    assert.match(s.name, /^[a-z][a-z-]*$/);
    assert.match(s.path, /^\//);
    assert.ok(s.accounts === undefined || s.accounts === 'single' || s.accounts === 'cswap', s.name);
    assert.ok(s.variant === undefined || FIXTURE_VARIANTS.includes(s.variant), `${s.name}: variant ${s.variant}`);
    assert.ok(s.sizes === undefined || (s.sizes.length > 0 && s.sizes.every((k) => SIZES.some((z) => z.key === k))), `${s.name}: sizes`);
    assert.ok(sizesOf(s).length > 0, s.name);
  }
  assert.deepEqual(THEMES, ['light', 'dark']);
  assert.deepEqual(DEFAULT_SIZES, ['phone', 'desktop']);
  assert.deepEqual(
    SIZES.map((s) => [s.key, s.width, s.height, s.scale]),
    [
      ['phone', 390, 844, 2],
      ['desktop', 1440, 900, 1],
    ],
  );
  assert.equal(
    variants().length,
    SHOTS.reduce((n, s) => n + sizesOf(s).length * THEMES.length, 0),
  );
  assert.equal(fileName(SHOTS[0], SIZES[0], 'light'), `${SHOTS[0].name}-phone`);
  assert.equal(fileName(SHOTS[0], SIZES[1], 'dark'), `${SHOTS[0].name}-desktop-dark`);
});

test('the screens the README and the docs promise are all taken, at the sizes they show', () => {
  const byName = new Map(SHOTS.map((s) => [s.name, s]));
  const both = ['board', 'start', 'accounts'];
  const phone = [
    'card',
    'dialog-plan',
    'dialog-question',
    'dialog-permission',
    'keypad',
    'attach',
    'accounts-single',
    'today',
    'ask',
    'todos',
    'reminders',
    'projects',
    'meds',
    'dose',
    'food',
    'places',
    'posts',
    'money',
    'intel',
    'meetings',
    'meeting',
    'meeting-transcript',
  ];
  for (const n of both) assert.deepEqual(sizesOf(byName.get(n) ?? {}).map((s) => s.key), ['phone', 'desktop'], n);
  for (const n of phone) assert.deepEqual(sizesOf(byName.get(n) ?? {}).map((s) => s.key), ['phone'], n);
  assert.equal(SHOTS.length, both.length + phone.length, 'a screen no page shows');
  assert.equal(byName.get('accounts-single')?.accounts, 'single');
  for (const n of ['dialog-plan', 'dialog-question', 'dialog-permission']) assert.equal(byName.get(n)?.variant, 'phone-control', n);
  assert.equal(byName.get('keypad')?.variant, 'keypad');
  // Ask is off until the Mac turns it on: only its own picture shows it.
  assert.equal(byName.get('ask')?.variant, 'ask');
  // v0.7: Posts is off until the Mac turns it on, like Ask.
  assert.equal(byName.get('posts')?.variant, 'posts');
  assert.equal(byName.get('posts')?.path, '/posts');
  // The hook card is the same session as the Bash dialog, with its card: the default fixture.
  assert.equal(byName.get('card')?.variant, undefined);
  assert.equal(byName.get('card')?.path, byName.get('dialog-permission')?.path);
});

test('shots share one fixture per accounts mode and variant', () => {
  const keys = new Set(SHOTS.map(fixtureKey));
  assert.deepEqual([...keys].sort(), ['cswap:ask', 'cswap:default', 'cswap:keypad', 'cswap:phone-control', 'cswap:posts', 'single:default']);
  assert.equal(fixtureKey({ name: 'x', path: '/' }), 'cswap:default');
});

test("session paths are the fixture's session ids", () => {
  assert.equal(sidOf(3), 'a1b2c3d4-0003-4000-8000-000000000003');
  // web-fixture.ts builds them the same way.
  const src = readFileSync(join(repo, 'test', 'integration', 'web-fixture.ts'), 'utf8');
  assert.ok(src.includes("`a1b2c3d4-${String(n).padStart(4, '0')}-4000-8000-00000000${String(n).padStart(4, '0')}`"));
  for (const s of SHOTS.filter((x) => x.path.startsWith('/s/'))) assert.match(s.path, /^\/s\/a1b2c3d4-000[1-4]-4000-8000-00000000000[1-4]$/, s.name);
});

test('--only takes a screen (every variant) or one file', () => {
  assert.deepEqual(
    variants(new Set(['today'])).map((v) => v.file),
    ['today-phone', 'today-phone-dark'],
  );
  assert.deepEqual(
    variants(new Set(['board'])).map((v) => v.file),
    ['board-phone', 'board-phone-dark', 'board-desktop', 'board-desktop-dark'],
  );
  assert.deepEqual(
    variants(new Set(['meds-phone-dark'])).map((v) => v.file),
    ['meds-phone-dark'],
  );
  // A size the screen doesn't take is no file.
  assert.deepEqual(variants(new Set(['today-desktop'])), []);
});

test('--list prints the files it would write and starts nothing', () => {
  const r = spawnSync(process.execPath, [script, '--list', '--only', 'board,keypad'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'docs/img/board-phone.png',
    'docs/img/board-phone-dark.png',
    'docs/img/board-desktop.png',
    'docs/img/board-desktop-dark.png',
    'docs/img/keypad-phone.png',
    'docs/img/keypad-phone-dark.png',
  ]);
});

test('docs/img holds exactly the pictures the script takes, each a PNG of its size', () => {
  const want = variants()
    .map((v) => `${v.file}.png`)
    .sort();
  const have = readdirSync(img)
    .filter((f) => !f.startsWith('.'))
    .sort();
  assert.deepEqual(have, want);
  for (const v of variants()) {
    const f = `${v.file}.png`;
    const head = readFileSync(join(img, f)).subarray(0, 24);
    assert.equal(head.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', f);
    assert.deepEqual([head.readUInt32BE(16), head.readUInt32BE(20)], [v.size.width * v.size.scale, v.size.height * v.size.scale], f);
    assert.ok(statSync(join(img, f)).size < 512 * 1024, `${f} is over 512 KB`);
  }
});

/** Every image a Markdown page shows: `![](…)`, `<img src>` and `<source srcset>`, with its line. */
function imagesOf(text) {
  return [...text.matchAll(/(?:src|srcset)=["']([^"']+)["']|!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1] ?? m[2]);
}

test('every picture the README and the docs pages show is one the script takes', () => {
  const taken = new Set(variants().map((v) => `docs/img/${v.file}.png`));
  const pages = ['README.md', ...readdirSync(join(repo, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  let readmeShots = 0;
  for (const page of pages) {
    const shown = imagesOf(readFileSync(join(repo, page), 'utf8'));
    // Only local pictures: no image from another site.
    for (const p of shown) assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(p), `${page}: ${p}`);
    for (const p of shown) {
      const path = relative(repo, normalize(join(repo, dirname(page), p.split('#')[0] ?? ''))).split('\\').join('/');
      if (!path.startsWith('docs/img/')) continue;
      assert.ok(taken.has(path), `${page}: ${p}`);
      if (page === 'README.md') readmeShots += 1;
    }
  }
  assert.ok(readmeShots > 0, 'the README shows no screenshot');
});

test('the default fixture is web-fixture-v051.ts, which draws its pictures in Chromium', () => {
  const src = readFileSync(script, 'utf8');
  assert.ok(src.includes("join(root, 'test', 'integration', 'web-fixture-v051.ts')"));
  assert.ok(src.includes("exportName: 'webFixtureV051'"));
  const fixture = readFileSync(join(repo, 'test', 'integration', 'web-fixture-v051.ts'), 'utf8');
  assert.match(fixture, /export function webFixtureV051\(/);
  assert.match(fixture, /export const SCREENSHOT_ART\b/);
  // The screens copy dialogs.ts's layouts, never its planted marker or its /tmp paths.
  assert.ok(!/velvet|quokka|DIALOG_SECRET|\/tmp\//.test(fixture));
});
