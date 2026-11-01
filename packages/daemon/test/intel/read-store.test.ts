/**
 * captures.jsonl's one writer (spec 2.1, 2.4, 5.3), tests G16 and G17:
 *
 * - G16: on start every item whose last line is `queued` gets the stopped
 *   failed line and nothing is re-queued; starting twice runs no job;
 *   reading on starts nothing; reading off and a daemon stop write failed
 *   lines for the running job and every waiting one.
 * - G17: appends and compactions are serialised by one lock; a compaction
 *   keeps the last line of each live id in file order, drops a deleted
 *   item's text, is atomic (temp + rename, 0600, never through a symlink)
 *   and the shelf follows the new inode; the 50 MB cap refuses a new item
 *   (`shelfFull`) after a compaction; the thumbnail sweep runs only with
 *   Intel on and after a good pass, keeps the folders of live ids past the
 *   shelf's cap and every folder changed in the last hour.
 *
 * Synthetic records only (example.com links, made-up creators).
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEL_READ_REASONS, INTEL_SOURCE_MAX_BYTES } from '@jantar/protocol';
import { memoryLogger } from '../../src/core/log.js';
import { newId } from '../../src/core/ids.js';
import { sweepThumbs } from '../../src/intel/read/files.js';
import { CapturesStore } from '../../src/intel/read/store.js';
import { TINY_JPEG } from './read-helpers.js';
import { hangingClaude, readEnv, until, type ReadEnv } from './read-env.js';

let envs: ReadEnv[] = [];
afterEach(async () => {
  for (const e of envs.reverse()) await e.cleanup();
  envs = [];
});
async function env(o: Parameters<typeof readEnv>[0] = {}): Promise<ReadEnv> {
  const e = await readEnv(o);
  envs.push(e);
  return e;
}

const mode = (p: string) => statSync(p).mode & 0o777;
const MARKER = 'SYNTHETIC-PRIVATE-MARKER-7f3a';

function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  return { id, captured_at: '2026-11-01T10:00:00.000Z', title: `Example item ${id}`, url: `https://example.com/${id.toLowerCase()}`, ...extra };
}

/** A store on its own dir (no service), for the lock and compaction. */
async function bareStore(): Promise<{ store: CapturesStore; dir: string; file: string; e: ReadEnv }> {
  const e = await env({ start: false });
  const dir = e.ctx.paths.intelDir;
  return { store: new CapturesStore(dir, memoryLogger()), dir, file: join(dir, 'captures.jsonl'), e };
}

function fileLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------- G16

describe('G16: nothing resumes after a restart', () => {
  const A = newId();
  const B = newId();
  const C = newId();
  function seed(e: ReadEnv): void {
    mkdirSync(e.ctx.paths.intelDir, { recursive: true, mode: 0o700 });
    const lines = [
      rec(A, { platform: 'web', type: 'link', depth: 'standard', note: 'for later', read: { state: 'queued', depth: 'standard' } }),
      rec(B, { platform: 'web', type: 'link', depth: 'light', read: { state: 'queued', depth: 'light' } }),
      rec(B, { platform: 'web', type: 'link', depth: 'light', title: 'Read already', what_it_is: 'Done.', read: { state: 'saved', depth: 'light', done: 'light', at: '2026-11-01T10:01:00.000Z' } }),
      rec(C),
    ];
    writeFileSync(e.file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });
  }

  it('an item left queued gets the stopped failed line at start; nothing is queued and no read runs', async () => {
    const first = await env({ start: false });
    seed(first);
    await first.intel.start();
    const items = first.items();
    expect(items.get(A)).toMatchObject({ title: `Example item ${A}`, note: 'for later', url: `https://example.com/${A.toLowerCase()}`, read: { state: 'failed', depth: 'standard', reason: INTEL_READ_REASONS.stopped } });
    expect(items.get(B)).toMatchObject({ title: 'Read already', read: { state: 'saved' } });
    expect(items.get(C)).not.toHaveProperty('read');
    expect(first.lines()).toHaveLength(5);
    expect(first.intel.queue.counts()).toEqual({ waiting: 0, running: 0 });
    expect(first.intel.jobs().jobs).toEqual([]);
    expect(first.exec.calls).toEqual([]);
    // One count in the log, never the item's text.
    const logged = JSON.stringify(first.ctx.log.records);
    expect(logged).toContain('"count":1');
    expect(logged).not.toContain('example.com');
    expect(logged).not.toContain('for later');
    // The shelf shows it failed, with Retry's reason.
    expect(first.intel.get(`captures:${A}`)?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.stopped });
  });

  it('starting twice in a row runs no job and writes nothing more', async () => {
    const first = await env({ start: false });
    seed(first);
    await first.intel.start();
    const after = readFileSync(first.file, 'utf8');
    await first.intel.stop();
    const second = await env({ base: first.base });
    expect(readFileSync(second.file, 'utf8')).toBe(after);
    expect(second.intel.queue.counts()).toEqual({ waiting: 0, running: 0 });
    expect(second.exec.calls).toEqual([]);
  });

  it('turning reading on starts nothing by itself', async () => {
    const e = await env({ start: false, intel: { read: false } });
    seed(e);
    await e.intel.start();
    await e.ctx.settings.patch({ intel: { read: true } });
    await e.intel.refresh();
    await new Promise((r) => setTimeout(r, 30));
    expect(e.intel.queue.counts()).toEqual({ waiting: 0, running: 0 });
    expect(e.exec.calls.some((c) => c.file.endsWith('claude'))).toBe(false);
  });

  it('reading off fails the running job and every waiting one (stopped); later saves are plain', async () => {
    const started = { n: 0 };
    const e = await env({ handlers: [hangingClaude(started)] });
    const ids: string[] = [];
    for (const text of ['first synthetic note', 'second synthetic note', 'third synthetic note']) {
      const r = await e.intel.read({ text }, { via: 'cli' });
      if (!r.ok) throw new Error(r.reason);
      ids.push(r.value.id.slice('captures:'.length));
    }
    await until(() => started.n === 1, 5_000, 'the first job to reach claude');
    expect(e.intel.queue.counts()).toEqual({ waiting: 2, running: 1 });
    await e.ctx.settings.patch({ intel: { read: false } });
    await until(() => e.intel.queue.counts().running === 0, 6_000, 'the running job to stop');
    const items = e.items();
    for (const id of ids) expect(items.get(id)?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.stopped });
    expect(started.n).toBe(1);
    const jobs = e.intel.jobs();
    expect(jobs.reading).toMatchObject({ on: false, canRun: false });
    expect(jobs.jobs.map((j) => j.state)).toEqual(['failed', 'failed', 'failed']);
  });

  it('a daemon stop fails the running job and every waiting one the same way', async () => {
    const started = { n: 0 };
    const e = await env({ handlers: [hangingClaude(started)] });
    const ids: string[] = [];
    for (const text of ['one synthetic note', 'two synthetic note']) {
      const r = await e.intel.read({ text }, { via: 'cli' });
      if (!r.ok) throw new Error(r.reason);
      ids.push(r.value.id.slice('captures:'.length));
    }
    await until(() => started.n === 1, 5_000, 'the first job to reach claude');
    await e.intel.stop();
    const items = e.items();
    for (const id of ids) expect(items.get(id)?.read).toMatchObject({ state: 'failed', reason: INTEL_READ_REASONS.stopped });
    // And the next start finds nothing queued.
    const again = await env({ base: e.base });
    expect(again.intel.queue.counts()).toEqual({ waiting: 0, running: 0 });
    expect([...again.items().values()].every((l) => (l.read as { state: string }).state === 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------- G17

describe('G17: the one writer', () => {
  it('every write waits for the lock: nothing lands while another write holds it', async () => {
    const { store, file } = await bareStore();
    await store.load();
    let release!: () => void;
    const held = store.locked(() => new Promise<void>((r) => (release = r)));
    const id = newId();
    const write = store.append([rec(id)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(file)).toBe(false);
    release();
    await held;
    expect(await write).toBe('ok');
    expect(fileLines(file).map((l) => l.id)).toEqual([id]);
  });

  it('appends, deletes and compactions at once: whole lines only, each id at its last state', async () => {
    const { store, file } = await bareStore();
    await store.load();
    const ids = Array.from({ length: 12 }, () => newId());
    const work: Promise<unknown>[] = [];
    for (const [i, id] of ids.entries()) {
      work.push(store.append([rec(id, { n: 1 })]));
      work.push(store.append([rec(id, { n: 2 })]));
      if (i % 3 === 0) work.push(store.remove(id));
      if (i % 4 === 0) work.push(store.compact());
    }
    await Promise.all(work);
    const lines = fileLines(file);
    const last = new Map(lines.map((l) => [l.id as string, l]));
    for (const [i, id] of ids.entries()) {
      if (i % 3 === 0) expect(last.has(id) && last.get(id)?.deleted !== true).toBe(false);
      else expect(last.get(id)).toMatchObject({ n: 2 });
    }
    expect(store.liveIds().size).toBe(ids.length - Math.ceil(ids.length / 3));
  });

  it('a compaction keeps the last line of each live id in file order and a deleted item\'s text leaves the disk', async () => {
    const e = await env();
    const [a, b, c] = [newId(), newId(), newId()];
    await e.intel.store.append([rec(a, { v: 1 }), rec(b, { v: 1, note: MARKER, caption: MARKER }), rec(a, { v: 2 }), rec(c, { v: 1 })]);
    await e.intel.refresh();
    expect(e.intel.list({ limit: 50 }).total).toBe(3);
    const before = lstatSync(e.file).ino;
    const r = await e.intel.remove(`captures:${b}`);
    expect(r).toEqual({ ok: true, value: true });
    const text = readFileSync(e.file, 'utf8');
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(`"id":"${b}"`);
    expect(fileLines(e.file)).toEqual([rec(a, { v: 2 }), rec(c, { v: 1 })]);
    // Temp + rename: a new inode, 0600, no temp left.
    expect(lstatSync(e.file).ino).not.toBe(before);
    expect(mode(e.file)).toBe(0o600);
    expect(existsSync(`${e.file}.tmp`)).toBe(false);
    // The shelf follows the new inode from the start.
    await e.intel.refresh();
    expect(e.intel.get(`captures:${b}`)).toBeNull();
    expect(e.intel.get(`captures:${a}`)).not.toBeNull();
    expect(e.intel.list({ limit: 50 }).total).toBe(2);
    expect(await e.intel.remove(`captures:${b}`)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('never writes through a symlink at the temp name', async () => {
    const { store, file, e } = await bareStore();
    const outside = join(e.base, 'outside.txt');
    writeFileSync(outside, 'keep me');
    const a = newId();
    await store.append([rec(a), rec(a, { v: 2 })]);
    symlinkSync(outside, `${file}.tmp`);
    await store.compact();
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    expect(fileLines(file)).toEqual([rec(a, { v: 2 })]);
  });

  it('compacts by itself when dead lines are over half of a file over 1 MB', async () => {
    const { store, file } = await bareStore();
    const a = newId();
    const pad = 'x'.repeat(20_000);
    for (let i = 0; i < 60; i++) await store.append([rec(a, { i, pad })]);
    expect(store.compactions).toBeGreaterThan(0);
    expect(statSync(file).size).toBeLessThan(1024 * 1024 + 30_000);
    expect(fileLines(file).at(-1)).toMatchObject({ i: 59 });
    expect(store.deadLines()).toBeLessThan(60);
  });

  it('a file changed behind its back (a new inode) is read again before the next write', async () => {
    const { store, file } = await bareStore();
    const [a, b] = [newId(), newId()];
    await store.append([rec(a)]);
    writeFileSync(`${file}.hand`, `${JSON.stringify(rec(b))}\n`, { mode: 0o600 });
    const { renameSync } = await import('node:fs');
    renameSync(`${file}.hand`, file);
    await store.append([rec(b, { v: 2 })]);
    expect(store.has(a)).toBe(false);
    await store.compact();
    expect(fileLines(file)).toEqual([rec(b, { v: 2 })]);
  });

  it('past 50 MB after a compaction a new item is refused (shelfFull); a line for an item already there is still written', async () => {
    const e = await env();
    mkdirSync(e.ctx.paths.intelDir, { recursive: true });
    // 51 MB of live items, one 200 KB line each (under the 256 KiB line cap).
    const fd = openSync(e.file, 'w', 0o600);
    const pad = 'p'.repeat(200_000);
    const live: string[] = [];
    let size = 0;
    while (size <= INTEL_SOURCE_MAX_BYTES + 1_000_000) {
      const id = newId();
      live.push(id);
      const line = `${JSON.stringify(rec(id, { pad }))}\n`;
      writeSync(fd, line);
      size += line.length;
    }
    closeSync(fd);
    const r = await e.intel.read({ text: 'https://example.com/new-one a synthetic note' }, { via: 'cli' });
    expect(r).toEqual({ ok: false, code: 'unavailable', reason: INTEL_READ_REASONS.shelfFull });
    const cap = await e.intel.capture({ title: 'Example capture', url: 'https://example.com/another' }, { via: 'cli' });
    expect(cap).toEqual({ ok: false, code: 'unavailable', reason: INTEL_READ_REASONS.shelfFull });
    expect(await e.intel.store.append([rec(live[0] as string, { v: 2 })])).toBe('ok');
    expect(fileLines(e.file).at(-1)).toMatchObject({ id: live[0], v: 2 });
  }, 60_000);

  it('past 50 MB with dead lines: the compaction makes room and the save goes through', async () => {
    const e = await env();
    mkdirSync(e.ctx.paths.intelDir, { recursive: true });
    const fd = openSync(e.file, 'w', 0o600);
    const pad = 'p'.repeat(200_000);
    const id = newId();
    let size = 0;
    let i = 0;
    while (size <= INTEL_SOURCE_MAX_BYTES + 1_000_000) {
      const line = `${JSON.stringify(rec(id, { i: (i += 1), pad }))}\n`;
      writeSync(fd, line);
      size += line.length;
    }
    closeSync(fd);
    // A fresh store (the service's own pass ran before the file grew).
    const store = new CapturesStore(e.ctx.paths.intelDir, memoryLogger());
    expect(await store.append([rec(newId())], { fresh: true })).toBe('ok');
    expect(store.compactions).toBe(1);
    expect(statSync(e.file).size).toBeLessThan(1_000_000);
  }, 60_000);
});

describe('G17: the thumbnail sweep', () => {
  function thumbsFor(e: ReadEnv, rid: string, ageMs: number): string {
    const dir = join(e.ctx.paths.intelDir, 'media', rid);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '0.jpg'), TINY_JPEG, { mode: 0o600 });
    const t = (e.ctx.clock.now() - ageMs) / 1000;
    utimesSync(dir, t, t);
    return dir;
  }
  const HOUR = 60 * 60_000;

  it('removes a dead id\'s folder only with Intel on, right after the store\'s pass', async () => {
    const e = await env({ start: false, intel: { enabled: false } });
    const dead = thumbsFor(e, newId(), 2 * HOUR);
    await e.intel.start();
    expect(existsSync(dead)).toBe(true);
    await e.ctx.settings.patch({ intel: { enabled: true } });
    await e.intel.refresh();
    await until(() => !existsSync(dead), 3_000, 'the sweep');
  });

  it('never runs after a failed pass (captures.jsonl unreadable)', async () => {
    const e = await env({ start: false });
    mkdirSync(e.file, { recursive: true });
    const dead = thumbsFor(e, newId(), 2 * HOUR);
    await e.intel.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(dead)).toBe(true);
    expect(e.intel.store.passed).toBe(false);
  });

  it('keeps the folders of live ids past the shelf\'s cap, and folders changed in the last hour', async () => {
    const e = await env({ start: false, maxItems: 2 });
    mkdirSync(e.ctx.paths.intelDir, { recursive: true });
    const live = [newId(), newId(), newId(), newId()];
    writeFileSync(e.file, `${live.map((id) => JSON.stringify(rec(id, { frames: 1 }))).join('\n')}\n`, { mode: 0o600 });
    const liveDirs = live.map((id) => thumbsFor(e, id, 2 * HOUR));
    const fresh = thumbsFor(e, newId(), 10 * 60_000);
    const dead = thumbsFor(e, newId(), 2 * HOUR);
    await e.intel.start();
    expect(e.intel.list({ limit: 50 }).total).toBe(2);
    await until(() => !existsSync(dead), 3_000, 'the sweep');
    for (const d of liveDirs) expect(existsSync(d)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it('sweepThumbs: a .new or .old folder of a dead id goes too; names that are not ids are never touched', async () => {
    const e = await env({ start: false });
    const media = join(e.ctx.paths.intelDir, 'media');
    const id = newId();
    for (const name of [`${id}.new`, `${id}.old`, 'not-an-id']) {
      mkdirSync(join(media, name), { recursive: true });
      const t = (e.ctx.clock.now() - 2 * HOUR) / 1000;
      utimesSync(join(media, name), t, t);
    }
    expect(await sweepThumbs(e.ctx.paths.intelDir, new Set(), e.ctx.clock.now())).toBe(2);
    expect(readdirSync(media)).toEqual(['not-an-id']);
  });
});
