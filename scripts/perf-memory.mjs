#!/usr/bin/env node
// Spec 9.6's memory gate: jantard at rest with every Life module on and a
// full Intel shelf may use at most 25 MB more than with everything off
// (which is what v0.3 ran).
//
// Each run is its own process: jantard in-process on a synthetic HOME
// through the integration harness (test/integration/harness.ts: the
// production wiring, fake binaries, an ephemeral 127.0.0.1 port, no
// terminal). It starts with everything off and a paired phone, rests, and
// reads process.memoryUsage(); then turns every Life module and the shelf on
// over ctl.sock (as `jantar life on` and `jantar intel source add` do), adds
// a month of Life rows from the phone and a shelf of INTEL_MAX_ITEMS records
// shaped like a bot's (about 1.5 kB a line), rests and reads it again. The
// difference is what turning everything on costs at rest: what the daemon
// holds once garbage is collected (the V8 heap and the memory outside it;
// verdict() says why not RSS). Resting is 3 s idle, then a full garbage
// collection. Three runs by default; the medians count. A MB here is
// 1,000,000 bytes.
//
// Nothing here talks to a running daemon or reads your home: every file is
// in a temp folder the harness removes.
//
// Usage: node scripts/perf-memory.mjs [--items N] [--runs N] [--json]
//
// Exits 1 when the extra memory is over the gate, 2 when a run fails. The
// harness is TypeScript, so each run is this file again under tsx
// (packages/cli's), with test/integration's tsconfig and the workspace's
// source condition: it measures the code as it is now, with no build.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHILD_ENV = 'JANTAR_PERF_MEMORY_CHILD';
const RESULT = 'perf-memory-result ';

/** Spec 9.6: at most this much more memory at rest with everything on. */
export const EXTRA_MAX = 25_000_000;

export function mb(bytes) {
  return `${bytes >= 0 ? '+' : ''}${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Record `i` of a full shelf: the bot's fields (fixtures' intelRecord) with texts as long as a working shelf's. */
export function shelfRecord(intelRecord, i) {
  const say = (what, n) => Array.from({ length: n }, (_, k) => `${what} ${i}, sentence ${k + 1}: a synthetic line about an example tool.`).join(' ');
  return intelRecord(i, {
    title: `Example tool ${i}: a synthetic title of usual length`,
    what_it_is: say('What it is', 5),
    why_it_matters: say('Why it matters', 5),
    how_it_was_built: say('How it was built', 3),
    product_angle: say('Product angle', 2),
    tags: ['example', 'synthetic', `tag-${i % 40}`],
  });
}

/**
 * The medians of the runs' differences (after minus before). The gate is on
 * what the daemon holds once garbage is collected: the V8 heap plus the
 * memory outside it that V8 counts (Buffers). That comes out the same to
 * 0.1 MB run after run. Not in it: SQLite's page cache for life.db, which
 * SQLite caps at about 2 MB a connection. RSS is reported too, but it
 * still counts pages the allocator has given back and the system has not
 * taken yet (and, under tsx, what compiling the TypeScript at start left
 * behind), so it moves by 20 MB or more between two identical runs.
 */
export function verdict(runs, max = EXTRA_MAX) {
  const extra = (f) => median(runs.map((r) => f(r.after) - f(r.before)));
  const held = extra((m) => m.heapUsed + m.external);
  return { extra: held, extraHeap: extra((m) => m.heapUsed), extraRss: extra((m) => m.rss), ok: held <= max };
}

function parseArgs(argv) {
  const out = { items: null, runs: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--items') out.items = Number(argv[++i]);
    else if (a === '--runs') out.runs = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else {
      process.stderr.write(`perf-memory: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  if ((out.items !== null && !(out.items >= 0)) || !(out.runs >= 1)) {
    process.stderr.write('perf-memory: --items and --runs take a number\n');
    process.exit(2);
  }
  return out;
}

/** One run in a fresh process. */
function runOnce(items) {
  const tsx = join(root, 'packages', 'cli', 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) throw new Error('tsx is missing: run pnpm install first');
  const r = spawnSync(tsx, ['--conditions=@jantar/source', '--tsconfig', join(root, 'test', 'integration', 'tsconfig.json'), fileURLToPath(import.meta.url)], {
    encoding: 'utf8',
    env: { ...process.env, [CHILD_ENV]: JSON.stringify({ items }) },
    timeout: 180_000,
  });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith(RESULT));
  if (r.status !== 0 || !line) throw new Error(`a run failed (exit ${r.status}):\n${(r.stderr ?? '').slice(-2000)}`);
  return JSON.parse(line.slice(RESULT.length));
}

/** The child: boot with everything off, measure, turn everything on and fill it, measure, stop. */
async function child({ items }) {
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { bootDaemon } = await import('../test/integration/harness.ts');
  const { cookieFrom, eventually, http, rememberSecret } = await import('../test/integration/http.ts');
  const { callDaemon, createCtlClient } = await import('../packages/cli/src/index.ts');
  const fx = await import('../test/fixtures/src/index.ts');
  const { DEVICE_COOKIE, INTEL_MAX_ITEMS } = await import('../packages/protocol/src/index.ts');
  const count = items ?? INTEL_MAX_ITEMS;
  const rest = async () => {
    await new Promise((r) => setTimeout(r, 3_000));
    for (let i = 0; i < 3; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 200));
    }
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, external: m.external };
  };

  let shelf = '';
  const d = await bootDaemon({
    noTerminal: true,
    // The bot's file is there from the start; the daemon reads it once the shelf is on.
    before: async (home) => {
      shelf = join(home.home, 'bot', 'intel.jsonl');
      await mkdir(dirname(shelf), { recursive: true });
      const lines = Array.from({ length: count }, (_, i) => JSON.stringify(shelfRecord(fx.intelRecord, i)));
      await writeFile(shelf, lines.length ? `${lines.join('\n')}\n` : '');
    },
  });
  try {
    const ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 20_000, 'the control socket');
    const start = await callDaemon(ctl, 'POST', '/v1/pair/start', { name: 'perf phone', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'perf phone' } });
    if (claim.status !== 200) throw new Error(`pairing failed: ${claim.text}`);
    const cookie = cookieFrom(claim, DEVICE_COOKIE);
    rememberSecret(cookie, claim.body);
    const before = await rest();

    await callDaemon(ctl, 'PATCH', '/v1/settings', {
      life: { todos: true, medicines: true, food: true, places: true, finance: true, timezone: 'UTC', currency: 'INR' },
      intel: { enabled: true, sources: [shelf] },
    });
    // 186 writes: under the 240 a minute one device may make.
    const send = async (method, path, body) => {
      const r = await http(d.port, method, path, { cookie, body });
      if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${r.text}`);
    };
    const ago = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) await send('POST', '/v1/projects', fx.projectBody({ name: `Example project ${i}` }));
    for (let i = 0; i < 40; i++) await send('POST', '/v1/todos', fx.todoBody({ title: `Example todo ${i}`, due: { day: ago(i % 30) } }));
    await send('POST', '/v1/medicines', fx.medBody());
    await send('POST', '/v1/medicines', fx.PLACEBIN);
    for (let i = 0; i < 60; i++) await send('POST', '/v1/food', fx.foodBody({ day: ago(i % 30), name: `Sample food ${i}`, kcal: 100 + i }));
    for (let i = 0; i < 30; i++) await send('PUT', `/v1/weights/${ago(i)}`, { kg: 72 + (i % 5) / 10 });
    for (let i = 0; i < 10; i++) await send('POST', '/v1/places', fx.placeBody({ name: `Example Café ${i}` }));
    for (let i = 0; i < 40; i++) await send('POST', '/v1/money', fx.moneyBody({ day: ago(i % 30), amount: 10_000 + i }));
    await send('POST', '/v1/bills', fx.billBody({ nextDue: ago(0) }));
    await eventually(async () => (await callDaemon(ctl, 'GET', '/v1/intel?limit=1')).total === count, 60_000, `the shelf to hold ${count} items`);
    // Read every page once, as a phone scrolling the shelf would.
    await callDaemon(ctl, 'GET', '/v1/intel?limit=100&q=example');
    const after = await rest();
    process.stdout.write(`${RESULT}${JSON.stringify({ items: count, before, after })}\n`);
  } finally {
    await d.stop();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runs = [];
  try {
    for (let i = 0; i < opts.runs; i++) runs.push(runOnce(opts.items));
  } catch (e) {
    process.stderr.write(`perf-memory: ${e.message}\n`);
    return 2;
  }
  const v = verdict(runs);
  if (opts.json) process.stdout.write(`${JSON.stringify({ runs, ...v, gate: EXTRA_MAX }, null, 2)}\n`);
  else {
    for (const r of runs) {
      const d = (f) => mb(f(r.after) - f(r.before));
      process.stdout.write(`run: held ${d((m) => m.heapUsed + m.external)} (heap ${d((m) => m.heapUsed)}), RSS ${d((m) => m.rss)} from ${mb(r.before.rss).slice(1)}\n`);
    }
    process.stdout.write(
      `every Life module on and ${runs[0].items} intel items, at rest, median of ${runs.length}: held ${mb(v.extra)} (at most ${mb(EXTRA_MAX)}), heap ${mb(v.extraHeap)}, RSS ${mb(v.extraRss)}\n`,
    );
    process.stdout.write(v.ok ? 'perf-memory: the gate holds.\n' : 'perf-memory: over the gate.\n');
  }
  return v.ok ? 0 : 1;
}

if (process.env[CHILD_ENV]) {
  child(JSON.parse(process.env[CHILD_ENV])).then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
