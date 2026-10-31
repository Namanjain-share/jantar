// node --test scripts/
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { EXTRA_MAX, mb, median, shelfRecord, verdict } from './perf-memory.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'perf-memory.mjs');
const tsx = join(dirname(script), '..', 'packages', 'cli', 'node_modules', '.bin', 'tsx');

const usage = (heapUsed, external, rss) => ({ heapUsed, external, rss });

test('medians and megabytes', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(mb(14_600_000), '+14.6 MB');
  assert.equal(mb(-2_300_000), '-2.3 MB');
  assert.equal(EXTRA_MAX, 25_000_000);
});

test('the gate is on the median of what the daemon holds more (heap and external), not on RSS', () => {
  const run = (held, rss) => ({ items: 5000, before: usage(30e6, 4e6, 150e6), after: usage(30e6 + held, 4e6, 150e6 + rss) });
  const ok = verdict([run(14.6e6, 60e6), run(14.6e6, -40e6), run(14.7e6, 2e6)]);
  assert.equal(ok.ok, true);
  assert.equal(Math.round(ok.extra), 14_600_000);
  assert.equal(Math.round(ok.extraRss), 2_000_000);
  const over = verdict([run(26e6, 0), run(25.5e6, 0), run(1e6, 0)]);
  assert.equal(over.ok, false);
  assert.equal(Math.round(over.extra), 25_500_000);
});

test("a shelf record is shaped like a bot's, about 1.5 kB a line", async () => {
  const intelRecord = (i, over) => ({ id: `ex-${i}`, type: 'tool', url: `https://example.com/${i}`, source_session: '00000000-0000-4000-8000-000000000000', ...over });
  const sizes = [0, 7, 4_999].map((i) => JSON.stringify(shelfRecord(intelRecord, i)).length);
  for (const n of sizes) assert.ok(n > 1_100 && n < 1_800, `${n} bytes`);
  const r = shelfRecord(intelRecord, 7);
  assert.equal(r.id, 'ex-7');
  assert.match(r.what_it_is, /What it is 7, sentence 1/);
  assert.deepEqual(r.tags, ['example', 'synthetic', 'tag-7']);
});

// The whole run, small: a daemon on a synthetic HOME under tsx, before and after.
test('one small run boots, fills and measures', { skip: !existsSync(tsx) && 'tsx is missing (pnpm install)', timeout: 180_000 }, () => {
  const r = spawnSync(process.execPath, [script, '--items', '200', '--runs', '1', '--json'], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].items, 200);
  assert.ok(out.extraHeap > 0, `heap ${out.extraHeap}`);
  assert.ok(out.extra < EXTRA_MAX);
});
