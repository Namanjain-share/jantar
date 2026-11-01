// node --test scripts/build-site.test.mjs
// The website: what scripts/build-site.mjs writes, that every page loads only
// its own files and links out only to GitHub, that the copy keeps the repo's
// rules, and, in a Chromium when one is installed, that it fits every width
// in both themes with nothing loaded from another host.
//
// It builds into a temp folder with --no-resize (quick), or checks an existing
// build when SITE_DIST names one (the Pages workflow checks site/dist, the
// folder it deploys). A second build takes its film from a temp folder: real
// clips when ffmpeg is on the PATH (or FFMPEG names it), else files that are
// only shaped like an MP4 and a WebM. Read-only toward the repository.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ABSOLUTE,
  FILM,
  FILM_SERVED,
  NARROW,
  ROOT,
  build,
  checkDist,
  clock,
  dialSvg,
  faviconSvg,
  filmFiles,
  filmScript,
  installSh,
  jpegSize,
  listFiles,
  llmsTxt,
  loadFigures,
  logoViewBox,
  keepDots,
  markdownAnchors,
  mp4Info,
  nowrapArrows,
  oneLineBlock,
  pagePath,
  quickstartBlock,
  quickstartHtml,
  readValues,
  releaseDate,
  safeOut,
  serve,
  tokenBlocks,
} from './build-site.mjs';
import { SCENES } from './launch-video.mjs';

const SRC = join(ROOT, 'site', 'src');
const read = (p) => readFileSync(p, 'utf8');
/** Every file under site/src, as paths relative to it. */
const srcFiles = () => listFiles(SRC);
const unescape = (s) =>
  s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

let dist;
let tmp;
let built = false;
/** A build whose film comes from a temp folder; `playable` when ffmpeg made real clips. */
let filmDist;
let playable = false;

/** A file with an MP4's boxes and nothing playable: ftyp, moov (mvhd v0 and an avc1 tag), then mdat. */
function fakeMp4(seconds, { faststart = true } = {}) {
  const box = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const moov = box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', Buffer.from('....avc1....', 'latin1'))]));
  const mdat = box('mdat', Buffer.alloc(16));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomavc1', 'latin1'));
  return Buffer.concat(faststart ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

/** The start of a JPEG: its frame header says width x height (320 x 180), and nothing decodes. */
const fakeJpeg = (w = 320, h = 180) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

/** FILM's six files in `dir`, by their names: two seconds of ffmpeg's test source (wide, and portrait for the phone cut), or fakes. */
function makeFilm(dir) {
  mkdirSync(dir, { recursive: true });
  const name = (k) => join(dir, FILM[k].split('/').pop());
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  try {
    for (const [size, mp4, webm, poster] of [
      ['320x180', 'mp4', 'webm', 'poster'],
      ['180x320', 'mp4Narrow', 'webmNarrow', 'posterNarrow'],
    ]) {
      const src = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=15:d=2`];
      execFileSync(ffmpeg, [...src, '-frames:v', '1', name(poster)], { stdio: 'ignore' });
      execFileSync(ffmpeg, [...src, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '45', '-an', name(webm)], { stdio: 'ignore' });
      execFileSync(ffmpeg, [...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', name(mp4)], { stdio: 'ignore' });
    }
    return true;
  } catch {
    for (const [mp4, webm, poster, jpeg] of [
      ['mp4', 'webm', 'poster', fakeJpeg()],
      ['mp4Narrow', 'webmNarrow', 'posterNarrow', fakeJpeg(180, 320)],
    ]) {
      writeFileSync(name(mp4), fakeMp4(53));
      writeFileSync(name(webm), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
      writeFileSync(name(poster), jpeg);
    }
    return false;
  }
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'jantar-site-test-'));
  if (process.env.SITE_DIST) {
    dist = resolve(ROOT, process.env.SITE_DIST);
    assert.ok(existsSync(join(dist, 'index.html')), `SITE_DIST=${process.env.SITE_DIST} has no index.html: run scripts/build-site.mjs first`);
  } else {
    dist = join(tmp, 'dist');
    await build({ out: dist, resize: false, repo: 'https://github.com/example/jantar' }, () => {});
    built = true;
  }
  playable = makeFilm(join(tmp, 'film'));
  filmDist = join(tmp, 'film-dist');
  await build({ out: filmDist, resize: false, repo: 'https://github.com/example/jantar', film: join(tmp, 'film') }, () => {});
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const page = (rel) => read(join(dist, rel));
/** SITE_URL as the build reads it (the Pages workflow sets it). */
const siteUrl = () => (process.env.SITE_URL || '').replace(/\/+$/, '').replace(/^http:\/\//, 'https://') || null;
const htmlFiles = () => listFiles(dist).filter((f) => f.endsWith('.html'));

// ---------------------------------------------------------------------------
// the build

test('the build passes its own checks: files, relative links, anchors, CSP, images', () => {
  assert.deepEqual(checkDist(dist, { siteUrl: siteUrl() }), []);
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
    for (const k of ['img-src', 'style-src', 'font-src', 'media-src']) assert.deepEqual(d[k], ["'self'"], `${f}: ${k}`);
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
  const files = srcFiles().filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 9);
  assert.ok(files.filter((f) => f.startsWith('answers/')).length >= 5, 'the answers are checked too');
  for (const f of srcFiles().filter((x) => /\.(?:txt|sh|js)$/.test(x))) {
    const text = read(join(SRC, f));
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${f}: an en or em dash`);
    assert.doesNotMatch(text, /\bopen[- ]source\b/i, `${f}: say source-available`);
  }
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
  for (const f of ['index.html', 'privacy/index.html', 'answers/index.html']) assert.ok(page(f).includes(`${notice}. FSL-1.1-MIT.`), f);
  for (const f of srcFiles()) assert.ok(!read(join(SRC, f)).includes(notice), `site/src/${f} names the licensor`);
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
  const motion = files.find((f) => /^assets\/motion\.[0-9a-f]{8}\.js$/.test(f));
  // deferred, and nothing waits on it: the motions, and the film's play, pause, full screen and phone cut
  assert.ok(size(motion) < 5 * 1024, `${motion} is ${size(motion)} bytes`);
  assert.ok(size(css) < 48 * 1024, `${css} is ${size(css)} bytes`);
  assert.ok(size('index.html') < 96 * 1024, `index.html is ${size('index.html')} bytes`);
  const webp = files.filter((f) => f.endsWith('.webp'));
  // each cut of the film: what a browser can fetch for it (MP4, WebM, every poster width) stays under 6 MB
  const wide = files.filter((f) => f === FILM_SERVED.mp4 || f === FILM_SERVED.webm || /^img\/(?:launch-poster|banner-dark)[-.]/.test(f));
  const narrow = files.filter((f) => f === FILM_SERVED.mp4Narrow || f === FILM_SERVED.webmNarrow || /^img\/launch-narrow-poster[-.]/.test(f));
  for (const [cut, list] of [['wide', wide], ['phone', narrow]]) {
    const bytes = list.reduce((n, f) => n + size(f), 0);
    assert.ok(bytes <= 6 * 1024 * 1024, `the ${cut} film's files are ${bytes} bytes`);
  }
  const film = [...wide, ...narrow];
  if (files.includes(FILM_SERVED.gif)) assert.ok(size(FILM_SERVED.gif) < 8 * 1024 * 1024, 'the GIF is under 8 MB');
  if (webp.length) {
    for (const f of webp.filter((x) => !film.includes(x))) assert.ok(size(f) < 170 * 1024, `${f} is ${size(f)} bytes`);
    for (const f of webp.filter((x) => film.includes(x))) assert.ok(size(f) < 400 * 1024, `${f} is ${size(f)} bytes`);
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

test("the README's status lines name package.json's version", () => {
  const { version } = readValues();
  const v = version.replace(/[.]/g, '\\.');
  const readme = read(join(ROOT, 'README.md'));
  assert.match(readme, new RegExp(`\\*\\*v${v}, early\\*\\*`), 'the line under the intro');
  assert.match(readme, new RegExp(`^- v${v}\\. `, 'm'), 'Status and limits');
  assert.equal(releaseDate('0.5.2', '## 0.5.2 (1 November 2026)\n'), '1 November 2026');
  assert.equal(releaseDate('0.5.20', '## 0.5.2 (1 November 2026)\n'), null);
  assert.equal(releaseDate('0.4.2', '## 0.4.2 (31 October 2026, shipped in 0.5.1)\n'), '31 October 2026');
  assert.equal(releaseDate('0.5.3', '## 0.5.3 (unreleased)\n'), null);
});

test('a deploy (SITE_URL set) builds only a released version: one with a dated CHANGELOG.md heading', () => {
  const was = process.env.SITE_URL;
  try {
    process.env.SITE_URL = 'https://site.example';
    const { version } = JSON.parse(read(join(ROOT, 'package.json')));
    if (releaseDate(version)) assert.equal(readValues().released, releaseDate(version));
    else assert.throws(() => readValues(), new RegExp(`"## ${version.replace(/[.]/g, '\\.')}" heading has no date`));
    delete process.env.SITE_URL;
    assert.equal(readValues().released, releaseDate(version), 'a local build takes any version');
  } finally {
    if (was === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = was;
  }
});

test('the answers: one per page under answers/, each linked from the index and llms.txt', () => {
  assert.equal(pagePath('index.html'), '');
  assert.equal(pagePath('privacy.html'), 'privacy/');
  assert.equal(pagePath('answers/index.html'), 'answers/');
  assert.equal(pagePath('answers/a-b.html'), 'answers/a-b/');
  const slugs = readdirSync(join(SRC, 'answers')).filter((f) => f.endsWith('.html') && f !== 'index.html').map((f) => f.slice(0, -5));
  assert.ok(slugs.length >= 4, `${slugs.length} answers`);
  const index = page('answers/index.html');
  const llms = page('llms.txt');
  for (const slug of slugs) {
    const html = page(`answers/${slug}/index.html`);
    assert.ok(index.includes(`href="${slug}/"`), `answers/ links to ${slug}`);
    assert.ok(llms.includes(`answers/${slug}/)`), `llms.txt names ${slug}`);
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(html)[1];
    assert.match(h1, /\?$/, `${slug}: the h1 is the question`);
    assert.ok(index.includes(`>${h1}</a>`), `${slug}: the index lists it by its question`);
    assert.match(html, /<div class="summary">/, `${slug}: the answer comes first`);
    const words = html.replace(/[\s\S]*<main id="main">|<\/main>[\s\S]*/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean);
    assert.ok(words.length < 600, `${slug}: ${words.length} words (under 600)`);
    assert.match(html, new RegExp(`answered for v${readValues().version.replace(/[.]/g, '\\.')}`), `${slug}: says which version it answers for`);
  }
  assert.match(page('index.html'), /href="answers\/"/, 'the FAQ links to the answers');
});

test('llms.txt: the version, the one-line install, and only files that exist', () => {
  const values = { ...readValues({ repo: 'https://github.com/example/jantar' }), siteUrl: 'https://site.example' };
  const text = llmsTxt(values);
  assert.match(text, /^# Jantar\n\n> /);
  assert.ok(text.includes(`v${values.version}`));
  assert.ok(text.includes(oneLineBlock().split('\n').find((l) => l.startsWith('curl '))), 'the curl line from docs/install.md');
  assert.match(text, /\(https:\/\/site\.example\/answers\/[a-z-]+\/\)/, 'answers by the site address');
  const raw = [...text.matchAll(/\(https:\/\/raw\.githubusercontent\.com\/example\/jantar\/main\/([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(raw.length >= 8, `${raw.length} docs`);
  for (const f of raw) assert.ok(existsSync(join(ROOT, f)), f);
  assert.doesNotMatch(text, /\{\{|[\u2013\u2014]|open[- ]source/i);
});

test("install.sh: the release and pnpm from package.json, the one-line block's URL", () => {
  const values = readValues({ repo: 'https://github.com/example/jantar' });
  const sh = page('install.sh');
  if (built) assert.equal(sh, installSh(values));
  assert.match(sh, new RegExp(`^DEFAULT_VERSION='${values.version.replace(/[.]/g, '\\.')}'$`, 'm'));
  assert.match(sh, new RegExp(`^PNPM_VERSION='${values.pnpm.replace(/[.]/g, '\\.')}'$`, 'm'));
  assert.doesNotMatch(sh, /\{\{/);
  const url = /curl -fsSL (https:\/\/\S+) \| bash/.exec(oneLineBlock())[1];
  assert.ok(sh.includes(`curl -fsSL ${url} | bash`), 'the script names the address the docs give');
  assert.match(page('index.html'), /<code id="one-code">curl -fsSL https:\/\/\S+\/install\.sh \| bash/);
  assert.match(page('index.html'), /<a href="install\.sh">Read the script<\/a>/);
});

test('the film: read from its MP4, played only from files in the build, the banner until it exists', () => {
  const dir = join(tmp, 'mp4');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.mp4'), fakeMp4(53.2));
  writeFileSync(join(dir, 'b.mp4'), fakeMp4(12, { faststart: false }));
  assert.deepEqual(mp4Info(join(dir, 'a.mp4')), { seconds: 53.2, h264: true, faststart: true });
  assert.equal(mp4Info(join(dir, 'b.mp4')).faststart, false);
  assert.equal(clock(53.2), '0:53');
  assert.equal(clock(59.6), '1:00');
  assert.equal(clock(83), '1:23');
  for (const k of Object.keys(FILM)) assert.match(FILM[k], /^docs\/brand\/(?:launch|demo)[-.]/);
  assert.deepEqual(jpegSize(join(tmp, 'film', 'launch-poster.jpg')), { width: 320, height: 180 });
  assert.deepEqual(jpegSize(join(tmp, 'film', 'launch-narrow-poster.jpg')), { width: 180, height: 320 });
  assert.equal(filmFiles(join(tmp, 'nothing-here')).video, false);
  // the wide three alone: the film plays, wide everywhere
  const wideOnly = join(tmp, 'wide-only');
  mkdirSync(wideOnly, { recursive: true });
  for (const k of ['mp4', 'webm', 'poster']) copyFileSync(join(tmp, 'film', FILM[k].split('/').pop()), join(wideOnly, FILM[k].split('/').pop()));
  assert.deepEqual([filmFiles(wideOnly).video, filmFiles(wideOnly).narrow], [true, false]);
  const half = join(tmp, 'half-written');
  mkdirSync(half, { recursive: true });
  for (const k of ['mp4', 'poster']) copyFileSync(join(tmp, 'film', FILM[k].split('/').pop()), join(half, FILM[k].split('/').pop()));
  writeFileSync(join(half, FILM.webm.split('/').pop()), '');
  assert.throws(() => filmFiles(half), /is not a WebM/, 'a WebM still being written stops the build with a plain message');
  assert.equal(filmFiles(join(tmp, 'film')).video, true);
  assert.equal(filmFiles(join(tmp, 'film')).narrow, true);

  // with the film
  const html = read(join(filmDist, 'index.html'));
  assert.deepEqual(checkDist(filmDist, { siteUrl: siteUrl() }), []);
  assert.match(
    html,
    /<div class="film-box" data-film data-webm="media\/launch\.webm" data-mp4="media\/launch\.mp4" data-webm-narrow="media\/launch-narrow\.webm" data-mp4-narrow="media\/launch-narrow\.mp4">/,
  );
  assert.match(html, /<a class="film-play" href="media\/launch\.mp4">/, 'without JS the poster links to the MP4');
  assert.match(html, /<div class="film-tools" hidden><button class="film-ctl" type="button" data-act="pause" aria-label="Pause the film">/);
  assert.match(html, /<button class="film-ctl" type="button" data-act="full" aria-label="Play the film full screen">/);
  // a narrow screen gets the phone cut's poster, at its own shape
  assert.ok(html.includes(`<picture><source media="${NARROW}" srcset="img/launch-narrow-poster`), 'the phone cut has its poster');
  assert.match(html, /<source media="\(max-width: 767px\)" srcset="[^"]+" sizes="[^"]+" width="180" height="320">/);
  assert.ok(existsSync(join(filmDist, FILM_SERVED.webmNarrow)) && existsSync(join(filmDist, FILM_SERVED.mp4Narrow)));
  // the film has no sound: its words, scene by scene, are on the page (WCAG 1.2.1)
  const words = /<details class="film-words"><summary>Read the film's captions<\/summary>[\s\S]*?<\/details>/.exec(html)?.[0];
  assert.ok(words, 'a <details> with the film\'s words');
  const text = unescape(words.replace(/&nbsp;/g, ' '));
  for (const s of SCENES) {
    assert.ok(text.includes(s.id === 'S9' ? 'The end card: Jantar.' : s.what), `${s.id}: what it shows`);
    if (s.kicker) assert.ok(text.includes(s.kicker), `${s.id}: its kicker`);
    for (const c of s.captions) assert.ok(text.includes(c.lines.join(' ')), `${s.id}: "${c.lines.join(' ')}"`);
  }
  assert.equal(filmScript('0.5.2').length, SCENES.length);
  const endCard = filmScript('0.5.2').at(-1).what;
  assert.ok(endCard.includes('jantar.namanbuilt.com'), 'the end card names the site');
  assert.match(endCard, /v0\.5\.2.*Example data throughout\. Not affiliated with Anthropic\./);
  assert.match(html, /<p class="watch"><a href="#film">Watch the <span class="nw">film<svg/);
  assert.ok(existsSync(join(filmDist, FILM_SERVED.webm)) && existsSync(join(filmDist, FILM_SERVED.mp4)));
  assert.doesNotMatch(html, /<video\b|\sautoplay\b/, 'no <video> in the page: motion.js adds it when the film is in view');
  const fig = /<figure class="film-fig">[\s\S]*?<\/figure>/.exec(html)[0];
  assert.match(fig, /<img [^>]*loading="lazy"/, 'the poster loads lazily');
  assert.match(fig, /<span class="rail">Example data<\/span>/);

  // without it
  const still = /<figure class="film-fig">[\s\S]*?<\/figure>/.exec(page('index.html'))?.[0];
  if (!filmFiles().video && built) {
    assert.match(still, /<div class="film-box film-box--still"><img src="img\/banner-dark[-.]/);
    assert.doesNotMatch(page('index.html'), /data-film|class="watch"|media\/launch\.mp4/);
  }
});

// ---------------------------------------------------------------------------
// in a browser

/**
 * Runs in the page: every .chip inside the window and inside its .panel. A chip
 * that hangs off to the left never widens the page, so scrollWidth misses it.
 */
function chipProblems() {
  // a chip still sliding in is measured where it ends up
  for (const a of document.getAnimations()) if (a.timeline === document.timeline && a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
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
      const answers = listFiles(join(dist, 'answers')).map((f) => `answers/${f.replace(/index\.html$/, '')}`);
      for (const width of [320, 360, 390, 768, 1024, 1280, 1440]) {
        await p.setViewportSize({ width, height: 800 });
        for (const path of ['privacy/', ...answers, '']) {
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
    for (const sel of ['.tabs-panel', '.chip--board', '.film']) {
      await sp.locator(sel).scrollIntoViewIfNeeded();
      await sp.waitForTimeout(300);
    }
    assert.equal(await sp.evaluate(() => document.documentElement.hasAttribute('data-motion')), false, 'reduced motion: no start states');
    for (const sel of ['.hero', '.strip', '.tabs-panel', '.board-panel']) {
      assert.equal(await sp.evaluate((s) => document.querySelector(s).getAnimations({ subtree: true }).length, sel), 0, `reduced motion: ${sel} does not move`);
    }
    await still.close();

    // Motion allowed: every animated part ends in its finished state.
    const moving = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 1280, height: 800 } });
    const mp = await moving.newPage();
    await mp.goto(server.url, { waitUntil: 'load' });
    await mp.waitForFunction(() => document.documentElement.hasAttribute('data-motion'));
    for (const sel of ['.tabs-panel', '.chip--board']) {
      await mp.locator(sel).scrollIntoViewIfNeeded();
      await mp.waitForFunction((s) => document.querySelector(s).classList.contains('play'), sel, { timeout: 5000 });
    }
    await mp.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.timeline === document.timeline && a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished),
      ),
    );
    const ends = await mp.evaluate(() => {
      const cs = (el, pseudo) => getComputedStyle(el, pseudo);
      const shown = (t) => t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
      const out = [];
      for (const el of document.querySelectorAll('.term--hero > *, .chip, .tabs-cap')) if (cs(el).opacity !== '1') out.push(`${el.className} at opacity ${cs(el).opacity}`);
      for (const el of document.querySelectorAll('.tab--need')) if (!shown(cs(el, '::before').transform)) out.push(`${el.textContent}'s square is ${cs(el, '::before').transform}`);
      if (!shown(cs(document.querySelector('.chip--board'), '::after').transform)) out.push('the hold bar is not full');
      return out;
    });
    assert.deepEqual(ends, [], 'motion allowed: everything ends shown');
    await moving.close();

    // JS off: the band shows the poster (or the banner) and no control that does nothing.
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

test('in Chromium: the film loads when in view, plays muted and looped, pauses on request, and stays a poster under reduced motion', async (t) => {
  let browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch();
  } catch (e) {
    t.skip(`no Chromium for playwright-core: ${String(e?.message ?? e).split('\n')[0]}`);
    return;
  }
  const server = await serve(filmDist, { base: '/jantar/' });
  const videoOf = () => {
    const v = document.querySelector('.film-box video');
    return v && { muted: v.muted, loop: v.loop, inline: v.hasAttribute('playsinline'), sources: [...v.querySelectorAll('source')].map((s) => s.getAttribute('src')) };
  };
  try {
    const ctx = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const problems = [];
    const media = [];
    p.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1:')) problems.push(`request to ${r.url()}`);
      if (r.url().includes('/media/')) media.push(r.url());
    });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await p.goto(server.url, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(videoOf), null, 'no <video> before the film is in view');
    assert.deepEqual(media, [], 'nothing of the film is fetched before it is in view');
    await p.locator('.film-box').scrollIntoViewIfNeeded();
    await p.waitForSelector('.film-box video', { state: 'attached' });
    assert.deepEqual(await p.evaluate(videoOf), { muted: true, loop: true, inline: true, sources: [FILM_SERVED.webm, FILM_SERVED.mp4] });
    assert.ok(media.every((u) => !u.includes('-narrow')), 'a wide screen loads nothing of the phone cut');
    const PAUSE = '.film-tools [data-act="pause"]';
    const FULL = '.film-tools [data-act="full"]';
    if (playable) {
      await p.waitForSelector('.film-fig.on', { timeout: 10000 });
      assert.ok(await p.isVisible(PAUSE), 'the pause button shows while it plays');
      assert.ok(await p.isVisible(FULL), 'and the full-screen button beside it');
      // under the film, off the picture
      const [film, tools] = await p.evaluate(() => ['.film-box', '.film-tools'].map((s) => document.querySelector(s).getBoundingClientRect().toJSON()));
      assert.ok(tools.top >= film.bottom, 'the controls sit under the film');
      assert.equal(await p.isVisible('.film-play'), false);
      await p.click(FULL);
      await p.waitForFunction(() => document.fullscreenElement === document.querySelector('.film-box video'), undefined, { timeout: 5000 });
      assert.equal(await p.evaluate(() => document.querySelector('.film-box video').controls), true, 'full screen has the player\'s controls');
      await p.evaluate(() => document.exitFullscreen());
      await p.waitForFunction(() => !document.fullscreenElement && !document.querySelector('.film-box video').controls);
      await p.locator('.film-box').scrollIntoViewIfNeeded();
      await p.waitForSelector('.film-fig.on', { timeout: 5000 });
      await p.click(PAUSE);
      await p.waitForFunction(() => document.querySelector('.film-box video').paused && !document.querySelector('.film-fig').classList.contains('on'));
      assert.ok(await p.isVisible('.film-play'), 'paused, the play link is back');
      assert.equal(await p.evaluate(() => document.activeElement?.className), 'film-play', 'and has the focus');
      assert.equal(await p.isVisible(PAUSE), false, 'paused, no pause button');
      await p.evaluate(() => scrollTo(0, 0));
      await p.waitForTimeout(200);
      await p.locator('.film-box').scrollIntoViewIfNeeded();
      await p.waitForTimeout(500);
      assert.equal(await p.evaluate(() => document.querySelector('.film-box video').paused), true, 'paused by hand, it stays paused in view');
      await p.click('.film-play');
      await p.waitForSelector('.film-fig.on');
      assert.equal(await p.evaluate(() => document.activeElement?.dataset.act), 'pause', 'played by hand, the focus goes to pause');
      await p.evaluate(() => scrollTo(0, 0));
      await p.waitForFunction(() => document.querySelector('.film-box video').paused, undefined, { timeout: 5000 });
    }
    assert.deepEqual(problems, []);
    await ctx.close();

    // A phone: the phone cut, its poster, and the wide film once the screen turns wide (same place in the film).
    const phone = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const pp = await phone.newPage();
    const phoneMedia = [];
    pp.on('request', (r) => r.url().includes('/media/') && phoneMedia.push(r.url()));
    await pp.goto(server.url, { waitUntil: 'load' });
    await pp.locator('.film-box').scrollIntoViewIfNeeded();
    await pp.waitForFunction(() => document.querySelector('.film-box img').complete);
    assert.match(await pp.evaluate(() => document.querySelector('.film-box img').currentSrc), /launch-narrow-poster/, 'the phone cut\'s poster');
    await pp.waitForSelector('.film-box video', { state: 'attached' });
    assert.deepEqual((await pp.evaluate(videoOf)).sources, [FILM_SERVED.webmNarrow, FILM_SERVED.mp4Narrow]);
    if (playable) {
      await pp.waitForSelector('.film-fig.on', { timeout: 10000 });
      assert.ok(phoneMedia.length > 0 && phoneMedia.every((u) => u.includes('-narrow')), `a phone loads only the phone cut (${phoneMedia.join(', ')})`);
      await pp.setViewportSize({ width: 844, height: 390 });
      await pp.waitForFunction((src) => document.querySelector('.film-box video source')?.getAttribute('src') === src, FILM_SERVED.webm, { timeout: 5000 });
    }
    await phone.close();

    const still = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    const sp = await still.newPage();
    await sp.goto(server.url, { waitUntil: 'load' });
    await sp.locator('.film-box').scrollIntoViewIfNeeded();
    await sp.waitForTimeout(800);
    assert.equal(await sp.evaluate(videoOf), null, 'reduced motion: the poster stays');
    assert.ok(await sp.isVisible('.film-play'), 'reduced motion: the film plays on a click');
    await sp.click('.film-play');
    await sp.waitForSelector('.film-box video', { state: 'attached' });
    if (playable) await sp.waitForSelector('.film-fig.on', { timeout: 10000 });
    await still.close();

    const nojs = await browser.newContext({ javaScriptEnabled: false });
    const np = await nojs.newPage();
    await np.goto(server.url, { waitUntil: 'load' });
    await np.locator('.film-box').scrollIntoViewIfNeeded();
    assert.ok(await np.isVisible('.film-play'));
    assert.equal(await np.getAttribute('.film-play', 'href'), FILM_SERVED.mp4, 'JS off: the poster links to the MP4');
    assert.equal(await np.isVisible('.film-tools'), false, 'JS off: no pause or full-screen button that does nothing');
    await np.click('.film-words summary');
    assert.equal(await np.evaluate(() => document.querySelector('.film-words').open), true, 'JS off: the film\'s words open');
    await nojs.close();
  } finally {
    await server.close();
    await browser.close();
  }
});
