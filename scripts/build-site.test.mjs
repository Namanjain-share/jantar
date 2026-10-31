// node --test scripts/build-site.test.mjs
// The website: what scripts/build-site.mjs writes, that every page loads only
// its own files and links out only to GitHub, that the copy keeps the repo's
// rules, and, in a Chromium when one is installed, that it fits every width
// in both themes with nothing loaded from another host.
//
// It builds into a temp folder with --no-resize (quick), or checks an existing
// build when SITE_DIST names one (the Pages workflow checks site/dist, the
// folder it deploys). Read-only toward the repository.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ABSOLUTE,
  ROOT,
  build,
  checkDist,
  dialSvg,
  faviconSvg,
  listFiles,
  loadFigures,
  logoViewBox,
  keepDots,
  markdownAnchors,
  nowrapArrows,
  quickstartBlock,
  quickstartHtml,
  readValues,
  safeOut,
  serve,
  tokenBlocks,
} from './build-site.mjs';

const SRC = join(ROOT, 'site', 'src');
const read = (p) => readFileSync(p, 'utf8');
const unescape = (s) =>
  s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

let dist;
let tmp;
let built = false;

before(async () => {
  if (process.env.SITE_DIST) {
    dist = resolve(ROOT, process.env.SITE_DIST);
    assert.ok(existsSync(join(dist, 'index.html')), `SITE_DIST=${process.env.SITE_DIST} has no index.html: run scripts/build-site.mjs first`);
  } else {
    tmp = mkdtempSync(join(tmpdir(), 'jantar-site-test-'));
    dist = join(tmp, 'dist');
    await build({ out: dist, resize: false, repo: 'https://github.com/example/jantar' }, () => {});
    built = true;
  }
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const page = (rel) => read(join(dist, rel));
const htmlFiles = () => listFiles(dist).filter((f) => f.endsWith('.html'));

// ---------------------------------------------------------------------------
// the build

test('the build passes its own checks: files, relative links, anchors, CSP, images', () => {
  assert.deepEqual(checkDist(dist, { siteUrl: (process.env.SITE_URL || '').replace(/\/+$/, '') || null }), []);
});

test('every figure slot is on the page, framed, in both themes', () => {
  const html = page('index.html');
  for (const [slot, f] of Object.entries(loadFigures())) {
    const at = html.indexOf(`data-slot="${slot}"`);
    assert.ok(at > 0, `slot ${slot} is not on the page`);
    const pic = html.slice(at, html.indexOf('</picture>', at));
    assert.match(pic, new RegExp(`img/${f.file}-dark[-.]`), `${slot}: no dark source`);
    assert.match(pic, new RegExp(`img/${f.file}[-.][^"]*"`), `${slot}: no light image`);
    assert.match(pic, /<source media="\(prefers-color-scheme: dark\)" data-dark /, `${slot}: the dark <source> follows the scheme`);
  }
  assert.doesNotMatch(html, /<a\b[^>]*>\s*<div class="(?:phone|mac)/, 'pictures are not wrapped in links');
});

test('pages load only their own files; links leave only for GitHub', () => {
  for (const f of htmlFiles()) {
    const html = page(f);
    for (const m of html.matchAll(/<(img|source|script|link)\b[^>]*>/g)) {
      const tag = m[0];
      if (/rel="canonical"/.test(tag)) continue;
      assert.doesNotMatch(tag, /\s(?:src|href|srcset)="(?:[a-z]+:|\/\/)/i, `${f}: ${tag.slice(0, 100)}`);
      assert.doesNotMatch(tag, /srcset="[^"]*(?:https?:|\/\/)/i, `${f}: ${tag.slice(0, 100)}`);
    }
    for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
      if (/^[a-z]+:|^\/\//i.test(m[1])) assert.match(m[1], ALLOWED_ABSOLUTE, `${f}: a link outside GitHub: ${m[1]}`);
    }
    assert.doesNotMatch(html, /<iframe|<form|<object|<embed/, `${f}: no frames, forms or plugins`);
  }
  for (const f of listFiles(dist).filter((x) => x.endsWith('.css') || x.endsWith('.js'))) {
    assert.doesNotMatch(page(f), /https?:\/\/|url\(\s*['"]?\/\//, `${f} names another host`);
  }
});

test('the CSP allows this site only, and the inline theme script by its hash', () => {
  for (const f of htmlFiles()) {
    const html = page(f);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    assert.ok(csp, `${f}: no CSP`);
    const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    assert.deepEqual(d['default-src'], ["'none'"]);
    for (const k of ['img-src', 'style-src', 'font-src']) assert.deepEqual(d[k], ["'self'"], `${f}: ${k}`);
    assert.deepEqual(d['connect-src'], ["'none'"]);
    assert.deepEqual(d['base-uri'], ["'none'"]);
    assert.deepEqual(d['form-action'], ["'none'"]);
    assert.equal(d['script-src'][0], "'self'");
    assert.ok(d['script-src'].slice(1).every((h) => /^'sha256-[A-Za-z0-9+/=]+'$/.test(h)), `${f}: script-src is 'self' and hashes only`);
    assert.doesNotMatch(html, /\sstyle="/, `${f}: a style attribute`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${f}: an inline event handler`);
  }
  const init = read(join(SRC, 'theme-init.js')).trim();
  assert.ok(Buffer.byteLength(init) < 400, `theme-init.js is ${Buffer.byteLength(init)} bytes (under 400)`);
});

test('one h1 and lang="en-GB" on every page; every image has alt, size and decoding; one eager image', () => {
  for (const f of htmlFiles()) {
    const html = page(f);
    assert.match(html, /<html lang="en-GB">/, f);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${f}: h1 count`);
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of imgs) {
      assert.match(tag, /\salt="[^"]+"/, tag);
      assert.match(tag, /\swidth="\d+"/, tag);
      assert.match(tag, /\sheight="\d+"/, tag);
      assert.match(tag, /\sdecoding="async"/, tag);
    }
    const eager = imgs.filter((t) => /loading="eager"/.test(t));
    assert.ok(eager.length <= 1, `${f}: ${eager.length} eager images`);
    assert.equal(imgs.filter((t) => /loading="lazy"/.test(t)).length, imgs.length - eager.length, `${f}: the rest are lazy`);
  }
  assert.equal([...page('index.html').matchAll(/loading="eager"/g)].length, 1, 'the hero phone is the one eager image');
});

// ---------------------------------------------------------------------------
// the copy

test('the site source keeps the copy rules', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const text = read(join(SRC, f));
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${f}: an en or em dash`);
    assert.doesNotMatch(text, /\bopen[- ]source\b/i, `${f}: say source-available`);
    assert.doesNotMatch(text, /\bccw\b/i, `${f}: the legacy tool stays in docs/upgrading.md`);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, `${f}: an e-mail address`);
    assert.doesNotMatch(text, /\sstyle="/, `${f}: a style attribute`);
    const words = text.replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, '').replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(words, /!|\b(?:seamless|powerful|effortless|supercharge|unlock|magic|blazing|next-gen)\b/i, `${f}: hype or an exclamation mark`);
  }
  const css = read(join(SRC, 'site.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'site.css holds no hex colour: colours are tokens');
  assert.doesNotMatch(css, /\brgba?\(|\bhsla?\(/i, 'site.css holds no colour literal');
  assert.doesNotMatch(read(join(SRC, 'site.css')), /tastemaker|critique/i, 'no process notes in the shipped CSS');
});

test("the footer's copyright is LICENSE's Notice line, which only LICENSE holds", () => {
  const notice = /^## Notice\s*\n+([^\n]+)/m.exec(read(join(ROOT, 'LICENSE')))[1].trim();
  for (const f of ['index.html', 'privacy/index.html']) assert.ok(page(f).includes(`${notice}. FSL-1.1-MIT.`), f);
  for (const f of readdirSync(SRC)) assert.ok(!read(join(SRC, f)).includes(notice), `site/src/${f} names the licensor`);
  for (const f of ['build-site.mjs', 'build-site.test.mjs']) assert.ok(!read(join(ROOT, 'scripts', f)).includes(notice), f);
});

test("the install block is README's Quickstart, verbatim, with its comments dimmed", () => {
  const block = /<code id="qs-code">([\s\S]*?)<\/code>/.exec(page('index.html'))?.[1];
  assert.ok(block, 'no #qs-code block');
  assert.equal(unescape(block), quickstartBlock());
  assert.match(block, /<span class="c"># asks a few questions/);
  assert.equal(quickstartHtml('echo "a # b" # c'), 'echo &quot;a # b&quot; <span class="c"># c</span>');
});

test("the doctor strip is written in jantar doctor's own words: its titles, labels and summary", () => {
  const doctor = read(join(ROOT, 'packages', 'cli', 'src', 'lib', 'doctor.ts'));
  const titles = new Set([...doctor.matchAll(/title: '([^']+)'/g)].map((m) => m[1]));
  const labels = new Set(Object.values(Object.fromEntries([.../LABEL[^=]*=\s*\{([^}]+)\}/.exec(doctor)[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]))));
  assert.ok(titles.has('macOS') && labels.has('ok'), 'doctor.ts was read');
  const html = page('index.html');
  assert.match(html, /<p class="doc-title">jantar doctor<\/p>/, "formatReport's first line");
  const lines = [...html.matchAll(/<li><span class="st">([^<]+)<\/span><span class="ti">([^<]+)<\/span><span class="de">([\s\S]*?)<\/span><\/li>/g)];
  for (const [, , , de] of lines) {
    assert.doesNotMatch(de.replace(/<wbr>|<span class="nw">|<\/span>/g, ''), /</, `only <wbr> and .nw inside a detail: ${de}`);
  }
  assert.match(html, /written out for a synthetic Mac/, 'the strip says it was written out, not captured from a run');
  assert.doesNotMatch(html, /real output of/);
  assert.ok(lines.length >= 5, `${lines.length} check lines`);
  for (const [, st, ti] of lines) {
    assert.ok(labels.has(st), `"${st}" is not a status formatReport prints`);
    assert.ok(titles.has(ti), `"${ti}" is not a check title in doctor.ts`);
  }
  const sum = /<li class="doc-sum">.*?(\d+) ok, (\d+) warnings?, (\d+) failures?, (\d+) notes?<\/li>/.exec(html);
  assert.ok(sum, 'the summary line, as formatReport words it');
  const total = sum.slice(1).reduce((n, x) => n + Number(x), 0);
  assert.match(html, new RegExp(`${lines.length} of its ${total} checks`), 'the strip says how many of the checks it shows');
  assert.match(html, /Serve: https:\/\/mac\.example\.ts\.net -&gt; 127\.0\.0\.1:7420 \(tailnet only\)/, "the Tailscale line is doctor's");
  assert.match(doctor, /detail: `Serve: \$\{url \?\? name\} -> 127\.0\.0\.1:\$\{port\} \(tailnet only\)`/);
  assert.match(doctor, /detail: 'macOS \(launchd, Terminal\.app\)'/);
});

test('every {{doc}} link names a file and heading that exist (GitHub anchors)', () => {
  const anchors = markdownAnchors(read(join(ROOT, 'SECURITY.md')));
  assert.ok(anchors.has('compare-and-type-and-what-it-cant-close'));
  assert.ok(anchors.has('threat-model-summary'));
  assert.ok(markdownAnchors(read(join(ROOT, 'docs', 'real-mac-checks.md'))).has('meetings-v05'));
  assert.deepEqual([...markdownAnchors('# A\n```sh\n# not a heading\n```\n## A\n')], ['a', 'a-1']);
  const repo = built ? 'https://github.com/example/jantar' : readValues().repo;
  for (const f of htmlFiles()) {
    for (const m of page(f).matchAll(new RegExp(`href="${repo.replace(/[.]/g, '\\.')}/blob/main/([^"#]+)(?:#([^"]+))?"`, 'g'))) {
      assert.ok(existsSync(join(ROOT, m[1])), `${f}: ${m[1]} does not exist`);
      if (m[2]) assert.ok(markdownAnchors(read(join(ROOT, m[1]))).has(m[2]), `${f}: ${m[1]} has no #${m[2]}`);
    }
  }
});

test('colours, the mark and the favicon come from the tokens and docs/brand', () => {
  const t = tokenBlocks();
  assert.match(t.css, /^:root\{--page:/);
  assert.match(t.css, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme\]\)\{--page:/);
  const fav = faviconSvg();
  assert.match(fav, /@media \(prefers-color-scheme: dark\)/);
  assert.ok(fav.includes(t.day.signal) && fav.includes(t.night.signal), 'the needs-you cell in both schemes');
  assert.match(page('index.html'), /<svg class="mark"[^>]*>(?:<rect [^>]*class="mk-[is]"\/>)+<\/svg>/);
  const vb = logoViewBox();
  assert.ok(page('index.html').includes(`<svg class="mark" viewBox="${vb}"`), 'the mark keeps the logo\'s viewBox');
  assert.ok(fav.includes(`viewBox="${vb}"`), 'the favicon keeps the logo\'s viewBox');
  assert.equal(logoViewBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><rect/></svg>'), '0 0 14 14');
  assert.equal((dialSvg().match(/class="now"/g) ?? []).length, 1, 'one mustard tick');
  const css = page(listFiles(dist).find((f) => /^assets\/site\.[0-9a-f]{8}\.css$/.test(f)));
  assert.match(css, /@font-face\{font-family:'Archivo Variable'/);
  assert.match(css, /url\('fonts\/archivo-latin-wdth-normal\.woff2'\)/);
});

test('a separator dot stays with the word before it', () => {
  assert.equal(keepDots('<p class="lbl" title="a · b">a · b <a href="x">c</a> · d</p>'), '<p class="lbl" title="a · b">a&nbsp;· b <a href="x">c</a>&nbsp;· d</p>');
  for (const f of htmlFiles()) {
    const text = page(f).replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<[^>]+>/g, '\n');
    assert.doesNotMatch(text, / \u00b7 /, `${f}: a " · " with a breaking space before the dot`);
  }
});

test('a text link keeps its last word and its arrow on one line', () => {
  assert.equal(
    nowrapArrows('<a href="x">The app, screen by screen<x-icon name="i"></x-icon></a> <a class="btn" href="y">Install<x-icon name="i"></x-icon></a>'),
    '<a href="x">The app, screen by <span class="nw">screen<x-icon name="i"></x-icon></span></a> <a class="btn" href="y">Install<x-icon name="i"></x-icon></a>',
  );
  for (const f of htmlFiles()) {
    for (const m of page(f).matchAll(/<a\b(?![^>]*\sclass=)[^>]*>([\s\S]*?)<\/a>/g)) {
      if (!m[1].includes('<svg class="ic"')) continue;
      assert.match(m[1], /<span class="nw">[^<\s]+<svg class="ic"[^>]*>[\s\S]*?<\/svg><\/span>$/, `${f}: ${m[0].slice(0, 120)}`);
    }
  }
});

test('the Pages workflow pins every action to a full commit SHA', () => {
  const yml = read(join(ROOT, '.github', 'workflows', 'pages.yml'));
  const uses = [...yml.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 6, `${uses.length} uses: lines`);
  for (const [line, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `not pinned to a SHA: ${line.trim()}`);
    assert.match(rest, /^ # v\d/, `no # vN comment: ${line.trim()}`);
  }
});

test('sizes stay small', () => {
  const files = listFiles(dist);
  const size = (f) => statSync(join(dist, f)).size;
  const css = files.find((f) => /^assets\/site\.[0-9a-f]{8}\.css$/.test(f));
  const js = files.find((f) => /^assets\/site\.[0-9a-f]{8}\.js$/.test(f));
  assert.ok(size(js) < 3 * 1024, `${js} is ${size(js)} bytes`);
  assert.ok(size(css) < 48 * 1024, `${css} is ${size(css)} bytes`);
  assert.ok(size('index.html') < 96 * 1024, `index.html is ${size('index.html')} bytes`);
  const webp = files.filter((f) => f.endsWith('.webp'));
  if (webp.length) {
    for (const f of webp) assert.ok(size(f) < 170 * 1024, `${f} is ${size(f)} bytes`);
    const hero = /<img src="(img\/[^"]+)" srcset="([^"]+)"[^>]*loading="eager"/.exec(page('index.html'));
    const at2x = hero[2].split(', ').map((s) => s.split(' ')[0]).find((u) => /-(4\d\d|5\d\d)\.webp$/.test(u)) ?? hero[1];
    const first = size('index.html') + size(css) + size('assets/fonts/archivo-latin-wdth-normal.woff2') + size(at2x);
    assert.ok(first < 260 * 1024, `the first view is ${first} bytes`);
  }
});

test('the out folder must be inside site/ or the temp folder', () => {
  assert.throws(() => safeOut(join(ROOT, 'docs')), /outside site\/ and the temp folder/);
  assert.throws(() => safeOut(join(ROOT, 'site', 'src')), /site\/src/);
  assert.equal(safeOut(join(ROOT, 'site', 'dist')), join(ROOT, 'site', 'dist'));
});

// ---------------------------------------------------------------------------
// in a browser

/**
 * Runs in the page: every .chip inside the window and inside its .panel. A chip
 * that hangs off to the left never widens the page, so scrollWidth misses it.
 */
function chipProblems() {
  const out = [];
  for (const c of document.querySelectorAll('.chip')) {
    const a = c.getBoundingClientRect();
    if (!a.width) continue;
    const name = [...c.classList].find((x) => x.startsWith('chip--')) ?? 'chip';
    const b = c.closest('.panel')?.getBoundingClientRect();
    const span = (r) => `${r.left.toFixed(1)} to ${r.right.toFixed(1)}`;
    if (a.left < 0 || a.right > innerWidth) out.push(`${name} leaves the window (${span(a)} of ${innerWidth})`);
    if (!b) out.push(`${name} is not in a .panel`);
    else if (a.left < b.left - 0.5 || a.right > b.right + 0.5 || a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5) {
      out.push(`${name} leaves its panel (${span(a)}; the panel ${span(b)})`);
    }
  }
  return out;
}

/** Runs in the page: no wrapped line of text starts with a separator dot. */
function dotsAtLineStart() {
  const out = [];
  const range = document.createRange();
  const rectOf = (node, i) => {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    return range.getBoundingClientRect();
  };
  let prev = null;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('pre, .term, .doc, .vh, script') || !el.checkVisibility()) continue;
    const t = n.data;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      if (t[i] === '\u00b7' && prev) {
        const d = rectOf(n, i);
        const q = rectOf(prev.node, prev.i);
        if (d.height && q.height && q.bottom <= d.top + 2) out.push(`"${t.slice(Math.max(0, i - 24), i + 24).replace(/\s+/g, ' ').trim()}"`);
      }
      prev = { node: n, i };
    }
  }
  return out;
}

test('in Chromium: every width fits, both themes, nothing from another host, JS off works', async (t) => {
  let browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch();
  } catch (e) {
    t.skip(`no Chromium for playwright-core (pnpm exec playwright-core install --only-shell chromium): ${String(e?.message ?? e).split('\n')[0]}`);
    return;
  }
  const server = await serve(dist, { base: '/jantar/' });
  const night = tokenBlocks().night.bg;
  try {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ colorScheme: scheme, serviceWorkers: 'block' });
      const p = await ctx.newPage();
      const problems = [];
      p.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      p.on('request', (r) => !r.url().startsWith('http://127.0.0.1:') && problems.push(`request to ${r.url()}`));
      for (const width of [320, 360, 390, 768, 1024, 1280, 1440]) {
        await p.setViewportSize({ width, height: 800 });
        for (const path of ['privacy/', '']) {
          await p.goto(`${server.url}${path}`, { waitUntil: 'load' });
          const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
          assert.ok(sw <= iw, `${scheme} ${width}px /${path}: the page scrolls sideways (${sw} > ${iw})`);
          assert.deepEqual(await p.evaluate(dotsAtLineStart), [], `${scheme} ${width}px /${path}: a line starts with a dot`);
        }
        assert.deepEqual(await p.evaluate(chipProblems), [], `${scheme} ${width}px: every chip inside the window and its panel`);
        const hero = await p.evaluate(() => {
          const r = (s) => document.querySelector(s)?.getBoundingClientRect();
          const a = r('.hero-phone .phone');
          const b = r('.term--hero');
          const term = document.querySelector('.term--hero');
          return { overlap: a && b ? !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) : false, termFits: term.scrollWidth <= term.clientWidth };
        });
        assert.ok(hero.termFits, `${scheme} ${width}px: the hero terminal's lines fit`);
        if (width < 1024) assert.equal(hero.overlap, false, `${scheme} ${width}px: the hero phone covers the terminal`);
      }
      await p.setViewportSize({ width: 1280, height: 800 });
      await p.goto(server.url, { waitUntil: 'load' });
      const fold = await p.evaluate(() => [document.querySelector('h1').getBoundingClientRect().bottom, document.querySelector('.hero .btn-pri').getBoundingClientRect().bottom]);
      assert.ok(fold.every((y) => y <= 800), `${scheme}: the h1 and Install are above the fold at 1280 x 800 (${fold})`);
      const bg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
      if (scheme === 'dark') assert.equal(bg, night, 'prefers-color-scheme: dark gives the night ground');
      await p.click('.ftr .seg [data-theme-set="dark"]');
      assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark');
      assert.equal(await p.evaluate(() => document.querySelector('source[data-dark]').media), 'all');
      await p.click('.ftr .seg [data-theme-set="light"]');
      assert.equal(await p.evaluate(() => document.querySelector('source[data-dark]').media), 'not all');
      await p.click('.ftr .seg [data-theme-set="system"]');
      assert.equal(await p.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
      assert.deepEqual(problems, []);
      await ctx.close();
    }

    // Every 8 px from 320 to 1440: chips in place, no sideways scroll.
    const scan = await browser.newContext({ serviceWorkers: 'block' });
    const sc = await scan.newPage();
    await sc.setViewportSize({ width: 320, height: 800 });
    await sc.goto(server.url, { waitUntil: 'load' });
    const found = [];
    for (let w = 320; w <= 1440; w += 8) {
      await sc.setViewportSize({ width: w, height: 800 });
      for (const x of await sc.evaluate(chipProblems)) found.push(`${w}px: ${x}`);
      const [sw, iw] = await sc.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      if (sw > iw) found.push(`${w}px: the page scrolls sideways (${sw} > ${iw})`);
    }
    assert.deepEqual(found, []);
    // The Life strip is a tab stop only while it scrolls.
    await sc.setViewportSize({ width: 390, height: 800 });
    await sc.waitForFunction(() => document.querySelector('.life-strip').getAttribute('tabindex') === '0', undefined, { timeout: 5000 });
    await sc.setViewportSize({ width: 1440, height: 800 });
    await sc.waitForFunction(() => !document.querySelector('.life-strip').hasAttribute('tabindex'), undefined, { timeout: 5000 });
    await scan.close();

    const still = await browser.newContext({ reducedMotion: 'reduce' });
    const sp = await still.newPage();
    await sp.goto(server.url, { waitUntil: 'load' });
    assert.equal(await sp.evaluate(() => document.querySelector('.strip').getAnimations({ subtree: true }).length), 0, 'reduced motion: the strip does not move');
    await still.close();

    const nojs = await browser.newContext({ javaScriptEnabled: false });
    const np = await nojs.newPage();
    await np.goto(server.url, { waitUntil: 'load' });
    assert.ok(await np.isVisible('h1'));
    assert.equal(await np.isVisible('.copy'), false, 'no dead Copy button without JS');
    assert.equal(await np.isVisible('.seg'), false, 'no dead theme switch without JS');
    await np.click('#faq details summary');
    assert.equal(await np.evaluate(() => document.querySelector('#faq details').open), true, 'the FAQ opens without JS');
    await nojs.close();
  } finally {
    await server.close();
    await browser.close();
  }
});
