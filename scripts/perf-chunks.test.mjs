// node --test scripts/
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LAZY_MAX, LAZY_SCREENS, analyze, chunkName, failures, importsOf } from './perf-chunks.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'perf-chunks.mjs');
const realDist = join(dirname(script), '..', 'packages', 'web', 'dist');

/** About `kb` kB once gzipped: random bytes in base64 gzip back to about their own size. */
const filler = (kb) => `export const x=${JSON.stringify(randomBytes(kb * 1000).toString('base64'))};`;

/**
 * A dist shaped like Vite's: index.html loads index-AAAAAAAA.js, which
 * imports shared-BBBBBBBB.js and loads every screen lazily; Today imports
 * the shared chunk and Sheet, and loads Late lazily.
 */
function writeDist(dir, over = {}) {
  const files = {
    'index.html': '<!doctype html><script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script><link rel="modulepreload" crossorigin href="/assets/shared-BBBBBBBB.js"><link rel="stylesheet" crossorigin href="/assets/index-CCCCCCCC.css">',
    'assets/index-AAAAAAAA.js': `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/Today-DDDDDDDD.js"])))=>i.map(i=>d[i]);\nimport{a as b}from"./shared-BBBBBBBB.js";${LAZY_SCREENS.map((s) => `import(\`./${s}-DDDDDDDD.js\`);`).join('')}${filler(5)}`,
    'assets/shared-BBBBBBBB.js': filler(30),
    'assets/index-CCCCCCCC.css': 'body{margin:0}',
    'assets/Sheet-EEEEEEEE.js': `import"./shared-BBBBBBBB.js";${filler(10)}`,
    'assets/Late-FFFFFFFF.js': filler(3),
    ...Object.fromEntries(LAZY_SCREENS.map((s) => [`assets/${s}-DDDDDDDD.js`, `import{a}from"./shared-BBBBBBBB.js";${filler(2)}`])),
    'assets/Today-DDDDDDDD.js': `import{a}from"./shared-BBBBBBBB.js";import{s}from"./Sheet-EEEEEEEE.js";${filler(2)};const late=()=>import(\`./Late-FFFFFFFF.js\`);`,
    ...over,
  };
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

function withDist(over, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jantar-test-chunks-'));
  try {
    writeDist(dir, over);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test("every lazy screen Shell.tsx loads with a gate is listed, v0.5.3's Ask among them", () => {
  const shell = readFileSync(join(dirname(script), '..', 'packages', 'web', 'src', 'ui', 'shell', 'Shell.tsx'), 'utf8');
  assert.match(shell, /import\('\.\.\/screens\/ask\/Ask\.js'\)/);
  assert.ok(LAZY_SCREENS.includes('Ask'));
  assert.ok(LAZY_SCREENS.includes('Meetings'));
});

test('a chunk name drops its hash', () => {
  assert.equal(chunkName('Today-CUumKW6f.js'), 'Today');
  assert.equal(chunkName('IconBase.es-BRGskf_J.js'), 'IconBase.es');
  assert.equal(chunkName('pdf.worker.min--Ao2iAXA.mjs'), 'pdf.worker.min');
});

test('static imports are the leading statements only; import() anywhere', () => {
  const code = [
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/a-11111111.js"])))=>i.map(i=>d[i]);',
    'import{i as e}from"./jsx-runtime-DyZJNswf.js";import"./side-22222222.js";export{x}from"./re-33333333.js";import*as y from"./ns-44444444.js";',
    'var s=`import{a}from"./not-a-chunk.js"`;const l=()=>import(`./Lazy-55555555.js`),m=()=>import("./Lazy-55555555.js");',
  ].join('\n');
  assert.deepEqual(importsOf(code), {
    statics: ['jsx-runtime-DyZJNswf.js', 'side-22222222.js', 're-33333333.js', 'ns-44444444.js'],
    dynamics: ['Lazy-55555555.js'],
  });
});

test('the main load is the entry and what it imports; a screen counts only what the main load lacks', () => {
  withDist({}, (dir) => {
    const r = analyze(dir);
    assert.deepEqual(r.main.files.sort(), ['index-AAAAAAAA.js', 'shared-BBBBBBBB.js']);
    assert.ok(r.main.js > 33_000 && r.main.js < 40_000, `main ${r.main.js}`);
    assert.ok(r.main.css > 0);
    const today = r.lazy.find((l) => l.name === 'Today');
    // Today and Sheet; the shared chunk is in the main load already.
    assert.deepEqual(today.files.sort(), ['Sheet-EEEEEEEE.js', 'Today-DDDDDDDD.js']);
    assert.ok(today.total > 11_000 && today.total < 14_000, `Today ${today.total}`);
    assert.ok(today.own < today.total);
    // What a screen loads lazily in turn is gated too, under its own name.
    assert.deepEqual(r.lazy.find((l) => l.file === 'Late-FFFFFFFF.js')?.name, 'Today > Late');
    assert.deepEqual(r.lazy.map((l) => l.name).slice(0, LAZY_SCREENS.length), LAZY_SCREENS);
    assert.deepEqual(failures(r), []);
  });
});

test('a screen past 80 kB with its shared chunks fails, naming it; so does a main load past its budget', () => {
  withDist({ 'assets/Sheet-EEEEEEEE.js': filler(90) }, (dir) => {
    const r = analyze(dir);
    const f = failures(r);
    assert.equal(f.length, 1);
    assert.match(f[0], /^Today \(Today-DDDDDDDD\.js\) pulls in \d+\.\d kB, over 80\.0 kB$/);
    assert.deepEqual(failures(r, { mainJs: 10_000, mainCss: 1, lazy: 1_000_000 }).length, 2);
    const cli = run(['--dist', dir]);
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /perf-chunks: Today \(Today-DDDDDDDD\.js\) pulls in/);
  });
  assert.equal(LAZY_MAX, 80_000);
});

test('a missing dist or screen chunk exits 2 with the reason', () => {
  const none = run(['--dist', join(tmpdir(), 'jantar-no-such-dist')]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /index\.html is missing: run pnpm build first/);
  withDist({ 'assets/index-AAAAAAAA.js': `import{a as b}from"./shared-BBBBBBBB.js";${filler(1)}` }, (dir) => {
    assert.throws(() => analyze(dir), /no lazy chunk for the Today screen/);
    const cli = run(['--dist', dir]);
    assert.equal(cli.status, 2);
  });
  withDist({}, (dir) => {
    const ok = run(['--dist', dir, '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).failures, []);
  });
});

// The built app itself: `pnpm build` runs before `pnpm test` (pnpm check and CI).
test('the built web app holds every size gate', { skip: !existsSync(join(realDist, 'index.html')) && !process.env.CI && 'packages/web/dist is missing (run pnpm build)' }, () => {
  const cli = run([]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});
