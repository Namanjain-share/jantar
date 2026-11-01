#!/usr/bin/env node
// The web app's size gates (spec 9.6), over the BUILT app (packages/web/dist):
//
// 1. The main load: the entry chunk and every chunk it imports statically
//    (what index.html loads and preloads before the first screen), gzipped,
//    at most MAIN_JS_MAX; its stylesheet at most MAIN_CSS_MAX.
// 2. Each lazy Life or Intel screen (Shell.tsx's import() of Today, Todos,
//    Meds, Food, Places, Money and Intel; v0.5's Meetings and v0.5.3's
//    Ask too), and any chunk one of them loads
//    with import() in turn: its own chunk plus the shared chunks it imports
//    that the main load does not already hold, at most LAZY_MAX gzipped.
//    That is what a phone fetches the first time the screen opens.
//
// Sizes are gzip at zlib's default level, the "gzip:" column `vite build`
// prints; a kB is 1,000 bytes, as there. Chunks are read as Rolldown writes
// them: static imports first (`import{a as b}from"./x.js";`), then the
// code, with `import(`./x.js`)` where a lazy chunk loads.
//
// Usage (after `pnpm build`):
//   node scripts/perf-chunks.mjs [--dist DIR] [--json]
//
// Prints one line per gate and exits 1 when one fails, 2 when the dist is
// missing or a screen's chunk cannot be found (a rename in Shell.tsx needs
// LAZY_SCREENS here too).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = join(here, '..', 'packages', 'web', 'dist');

/**
 * v0.3 loaded 252 kB of JavaScript first; v0.4 265 kB; v0.4.2 279 kB, its dialog dock and keypad loaded
 * lazily; v0.5.1 (v0.4.2 with v0.5's Meetings) 279.6 kB, a picked file's preparation and the attachment
 * glyphs loaded lazily too. That leaves about 0.4 kB: the next split to try is in docs/LAYOUT.md's v0.5.1
 * section. Raise this only as a decision recorded there.
 */
export const MAIN_JS_MAX = 280_000;
export const MAIN_CSS_MAX = 16_000;
/** Spec 9.6: each lazy Life or Intel chunk; v0.5 holds Meetings to the same, v0.5.3 Ask. */
export const LAZY_MAX = 80_000;
/** The screens Shell.tsx loads lazily, by their file names (a chunk is named after its module). */
export const LAZY_SCREENS = ['Today', 'Todos', 'Meds', 'Food', 'Places', 'Money', 'Intel', 'Meetings', 'Ask'];

const STATIC_IMPORT = /^\s*(?:import|export)\s*(?:[^'"`;]*?\bfrom\s*)?(["'`])\.\/([^"'`]+)\1\s*;?/;
const DYNAMIC_IMPORT = /\bimport\(\s*(["'`])\.\/([^"'`]+)\1\s*\)/g;

/** A chunk's name without its hash: "Today-CUumKW6f.js" is "Today". */
export function chunkName(file) {
  return file.replace(/\.m?js$/, '').replace(/-[A-Za-z0-9_-]{8}$/, '');
}

/** The chunks `code` imports statically (its leading import and export-from statements) and with import(). */
export function importsOf(code) {
  const statics = [];
  // Vite puts its preload map first in a chunk that loads others lazily: one line, before the imports.
  let rest = code.replace(/^#![^\n]*\n/, '').replace(/^const __vite__mapDeps=[^\n]*\n/, '');
  for (;;) {
    rest = rest.replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)/, '');
    const m = STATIC_IMPORT.exec(rest);
    if (!m) break;
    statics.push(m[2]);
    rest = rest.slice(m[0].length);
  }
  const dynamics = [...code.matchAll(DYNAMIC_IMPORT)].map((m) => m[2]);
  return { statics, dynamics: [...new Set(dynamics)] };
}

/**
 * Reads a built dist: the main load from index.html, every chunk's gzipped
 * size and imports, and each lazy screen's cost. Throws (with `code` 2)
 * when the dist or a screen's chunk is missing.
 */
export function analyze(dist, screens = LAZY_SCREENS) {
  const index = join(dist, 'index.html');
  if (!existsSync(index)) throw Object.assign(new Error(`${index} is missing: run pnpm build first`), { code: 2 });
  const html = readFileSync(index, 'utf8');
  const assets = join(dist, 'assets');
  const chunks = new Map();
  for (const f of readdirSync(assets)) {
    if (!/\.m?js$/.test(f)) continue;
    const code = readFileSync(join(assets, f));
    chunks.set(f, { file: f, gz: gzipSync(code).length, ...importsOf(code.toString('utf8')) });
  }
  const closure = (roots) => {
    const seen = new Set();
    const todo = [...roots];
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f) || !chunks.has(f)) continue;
      seen.add(f);
      todo.push(...chunks.get(f).statics);
    }
    return seen;
  };
  const sum = (files) => [...files].reduce((n, f) => n + (chunks.get(f)?.gz ?? 0), 0);

  const entries = [...html.matchAll(/<script[^>]*\bsrc="\/assets\/([^"]+)"/g)].map((m) => m[1]);
  if (entries.length === 0) throw Object.assign(new Error(`${index} loads no script from /assets/`), { code: 2 });
  const main = closure(entries);
  const css = [...html.matchAll(/<link[^>]*\bhref="\/assets\/([^"]+\.css)"/g)].map((m) => m[1]);
  const cssGz = css.reduce((n, f) => n + gzipSync(readFileSync(join(assets, f))).length, 0);

  // The screens the main load imports lazily, then whatever those load lazily in turn.
  const fromMain = new Set([...main].flatMap((f) => chunks.get(f).dynamics));
  const lazy = [];
  const todo = [];
  for (const name of screens) {
    const file = [...fromMain].find((f) => chunkName(f) === name);
    if (!file) throw Object.assign(new Error(`no lazy chunk for the ${name} screen: Shell.tsx no longer loads it with import(), or it is named differently`), { code: 2 });
    todo.push({ name, file });
  }
  const done = new Set();
  while (todo.length) {
    const { name, file } = todo.shift();
    if (done.has(file) || main.has(file)) continue;
    done.add(file);
    const pulled = [...closure([file])].filter((f) => !main.has(f));
    lazy.push({ name, file, own: chunks.get(file).gz, total: sum(pulled), files: pulled });
    for (const f of pulled) for (const d of chunks.get(f).dynamics) todo.push({ name: `${name} > ${chunkName(d)}`, file: d });
  }
  return { main: { files: [...main], js: sum(main), css: cssGz }, lazy };
}

/** The gates `report` fails, as sentences (empty: every gate holds). */
export function failures(report, max = { mainJs: MAIN_JS_MAX, mainCss: MAIN_CSS_MAX, lazy: LAZY_MAX }) {
  const out = [];
  if (report.main.js > max.mainJs) out.push(`the main load is ${kb(report.main.js)} of JavaScript, over ${kb(max.mainJs)}`);
  if (report.main.css > max.mainCss) out.push(`the main stylesheet is ${kb(report.main.css)}, over ${kb(max.mainCss)}`);
  for (const l of report.lazy) if (l.total > max.lazy) out.push(`${l.name} (${l.file}) pulls in ${kb(l.total)}, over ${kb(max.lazy)}`);
  return out;
}

export function kb(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function main() {
  const argv = process.argv.slice(2);
  let dist = DEFAULT_DIST;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist' && argv[i + 1]) dist = resolve(argv[++i]);
    else if (argv[i] === '--json') json = true;
    else {
      process.stderr.write(`perf-chunks: unknown argument ${argv[i]}\n`);
      return 2;
    }
  }
  let report;
  try {
    report = analyze(dist);
  } catch (e) {
    process.stderr.write(`perf-chunks: ${e.message}\n`);
    return e.code ?? 2;
  }
  const failed = failures(report);
  if (json) process.stdout.write(`${JSON.stringify({ ...report, failures: failed }, null, 2)}\n`);
  else {
    process.stdout.write(`main load    ${kb(report.main.js)} JS (at most ${kb(MAIN_JS_MAX)}), ${kb(report.main.css)} CSS (at most ${kb(MAIN_CSS_MAX)}), ${report.main.files.length} chunks\n`);
    for (const l of report.lazy) process.stdout.write(`${l.name.padEnd(12)} ${kb(l.total)} with what it pulls in (its own chunk ${kb(l.own)}; at most ${kb(LAZY_MAX)})\n`);
    process.stdout.write(failed.length ? `\nperf-chunks: ${failed.join('; ')}.\n` : 'perf-chunks: every gate holds.\n');
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
