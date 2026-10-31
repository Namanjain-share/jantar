/**
 * LI2 and LI3: the follower survives every bad line the fixture holds (a
 * 300 KB line, not JSON, a JSON array, no title, a partial last line), a
 * duplicate id replaces the earlier item, 5,000 past the cap keep the newest
 * INTEL_MAX_ITEMS; nothing it reads is logged and the counts are right. Truncating,
 * replacing or rewriting a source in place reads it again, once.
 */
import { appendFileSync, readFileSync, renameSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEL_MAX_ITEMS, IntelItemSchema } from '@jantar/protocol';
import { INTEL_PARTIAL_LINE, appendIntel, intelRecord, writeIntelJsonl } from '@jantar/fixtures';
import { JsonlFollower } from '../../src/intel/follow.js';
import { intelEnv, type IntelEnv } from './helpers.js';

let env: IntelEnv;
afterEach(async () => {
  await env?.cleanup();
});

const ALL = { q: undefined, limit: 100 } as const;

function logged(e: IntelEnv): string {
  return JSON.stringify(e.ctx.log.records);
}

describe('LI2: a source with every kind of bad line', () => {
  it('holds the right items and skipped count, survives each line, and logs none of it', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    const written = await writeIntelJsonl(file, { count: 20, extras: true });
    await env.setIntel({ sources: [file] });
    const [captures, intel] = env.intel.sources();
    expect(captures).toMatchObject({ id: 'captures', items: 0, skipped: 0, updatedAt: null });
    expect(intel).toMatchObject({ id: 'intel', label: 'intel', items: written.items, skipped: written.skipped });
    expect(intel?.error).toBeUndefined();
    const list = env.intel.list({ ...ALL, limit: 100 });
    expect(list.total).toBe(written.items);
    expect(new Set(list.items.map((i) => i.id))).toEqual(new Set(written.ids.map((id) => `intel:${id}`)));
    // The duplicate id later in the file replaced the first item.
    expect(env.intel.get('intel:ex-0')?.title).toBe('Example tool 0, retitled');
    // The partial last line is not an item yet, nor skipped.
    expect(env.intel.get('intel:ex-partial')).toBeNull();
    for (const item of list.items) expect(IntelItemSchema.safeParse(env.intel.get(item.id)).success).toBe(true);
    expect(logged(env)).not.toMatch(/Example tool|not json|an array|notitle|xxxxxxxx|ex-/);
  });

  it('a partial last line becomes an item once the rest of it is appended', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    const written = await writeIntelJsonl(file, { count: 3, extras: true });
    await env.setIntel({ sources: [file] });
    appendFileSync(file, '","url":"https://example.com/partial"}\n');
    await env.intel.refresh();
    expect(env.intel.get('intel:ex-partial')).toMatchObject({ title: 'Example partial', url: 'https://example.com/partial' });
    expect(env.intel.sources()[1]).toMatchObject({ items: written.items + 1, skipped: written.skipped });
    expect(INTEL_PARTIAL_LINE.endsWith('Example partial')).toBe(true);
  });

  it('a line growing past 256 KiB across appends is skipped whole, and the next line still reads', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    writeFileSync(file, `${JSON.stringify(intelRecord(1))}\n{"id":"ex-big","title":"Big","what_it_is":"${'x'.repeat(200 * 1024)}`);
    await env.setIntel({ sources: [file] });
    expect(env.intel.sources()[1]).toMatchObject({ items: 1, skipped: 0 });
    appendFileSync(file, `${'y'.repeat(200 * 1024)}"}\n${JSON.stringify(intelRecord(2))}\n`);
    await env.intel.refresh();
    expect(env.intel.sources()[1]).toMatchObject({ items: 2, skipped: 1 });
    expect(env.intel.get('intel:ex-big')).toBeNull();
    expect(env.intel.get('intel:ex-2')?.title).toBe('Example tool 2');
  });

  it('appends show up on the next poll, a duplicate id replaces in place, and blank lines count for nothing', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 2 });
    await env.setIntel({ sources: [file] });
    await appendIntel(file, intelRecord(5));
    appendFileSync(file, '\n\n   \n');
    await appendIntel(file, intelRecord(1, { title: 'Example tool 1, again' }));
    await env.intel.refresh();
    expect(env.intel.list(ALL).items.map((i) => i.id)).toEqual(['intel:ex-5', 'intel:ex-1', 'intel:ex-0']);
    expect(env.intel.get('intel:ex-1')?.title).toBe('Example tool 1, again');
    expect(env.intel.sources()[1]).toMatchObject({ items: 3, skipped: 0 });
    expect(env.intel.stats().reads.intel).toBe(1);
  });

  it('5,000 items past the cap: the newest INTEL_MAX_ITEMS stay and the rest are counted as dropped', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    const over = 5_000;
    await writeIntelJsonl(file, { count: INTEL_MAX_ITEMS + over });
    await env.setIntel({ sources: [file] });
    expect(env.intel.sources()[1]).toMatchObject({ items: INTEL_MAX_ITEMS, skipped: 0 });
    expect(env.intel.stats().dropped).toBe(over);
    expect(env.intel.get(`intel:ex-${over - 1}`)).toBeNull();
    expect(env.intel.get(`intel:ex-${over}`)).not.toBeNull();
    const first = env.intel.list({ ...ALL, limit: 1 });
    expect(first.total).toBe(INTEL_MAX_ITEMS);
    expect(first.items[0]?.id).toBe(`intel:ex-${INTEL_MAX_ITEMS + over - 1}`);
    expect(logged(env)).not.toMatch(/Example tool/);
  }, 60_000);
});

describe('LI3: truncating or replacing a source reads it again, once', () => {
  it('a truncated file is read from the start once, then followed again', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 5 });
    await env.setIntel({ sources: [file] });
    expect(env.intel.stats().reads.intel).toBe(1);
    truncateSync(file, 0);
    await appendIntel(file, intelRecord(100));
    await env.intel.refresh();
    await env.intel.refresh();
    expect(env.intel.stats().reads.intel).toBe(2);
    expect(env.intel.list(ALL).items.map((i) => i.id)).toEqual(['intel:ex-100']);
    await appendIntel(file, intelRecord(101));
    await env.intel.refresh();
    expect(env.intel.stats().reads.intel).toBe(2);
    expect(env.intel.list(ALL).total).toBe(2);
  });

  it('a file replaced by a rename (a new inode, even a bigger one) is read from the start once', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 3 });
    await env.setIntel({ sources: [file] });
    const next = join(env.bot, 'intel.jsonl.tmp');
    await writeIntelJsonl(next, { count: 10 });
    appendFileSync(next, `${JSON.stringify(intelRecord(0, { title: 'Example tool 0, rewritten' }))}\n`);
    renameSync(next, file);
    await env.intel.refresh();
    await env.intel.refresh();
    expect(env.intel.stats().reads.intel).toBe(2);
    expect(env.intel.list(ALL).total).toBe(10);
    expect(env.intel.get('intel:ex-0')?.title).toBe('Example tool 0, rewritten');
  });

  it('a file rewritten in place (the same inode) is read again once, at the same size or longer', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 3 });
    await env.setIntel({ sources: [file] });
    const { ino } = statSync(file);
    // The same size: one title changed by a letter, written over the file (as a script's open "w" does).
    const before = readFileSync(file, 'utf8');
    const same = before.replace('Example tool 1', 'Example tool X');
    expect(same.length).toBe(before.length);
    writeFileSync(file, same);
    const t = statSync(file).mtime;
    utimesSync(file, t, new Date(t.getTime() + 2000));
    await env.intel.refresh();
    await env.intel.refresh();
    expect(statSync(file).ino).toBe(ino);
    expect(env.intel.stats().reads.intel).toBe(2);
    expect(env.intel.get('intel:ex-1')?.title).toBe('Example tool X');
    // Longer: a record written first moves every line, so the old offset lands inside one.
    const longer = Buffer.from(`${JSON.stringify(intelRecord(50))}\n${same}`);
    expect(longer[Buffer.byteLength(same) - 1]).not.toBe(0x0a);
    writeFileSync(file, longer);
    await env.intel.refresh();
    await env.intel.refresh();
    expect(statSync(file).ino).toBe(ino);
    expect(env.intel.stats().reads.intel).toBe(3);
    expect(env.intel.sources()[1]).toMatchObject({ items: 4, skipped: 0 });
    expect(env.intel.get('intel:ex-50')).not.toBeNull();
    // Appends after it are read on, not read again.
    await appendIntel(file, intelRecord(51));
    await env.intel.refresh();
    expect(env.intel.stats().reads.intel).toBe(3);
    expect(env.intel.list(ALL).total).toBe(5);
  });

  it('a source that goes away holds nothing, and comes back on the next poll', async () => {
    env = await intelEnv();
    const file = join(env.bot, 'intel.jsonl');
    await writeIntelJsonl(file, { count: 3 });
    await env.setIntel({ sources: [file] });
    renameSync(file, join(env.bot, 'moved.txt'));
    await env.intel.refresh();
    expect(env.intel.sources()[1]).toMatchObject({ items: 0, error: "Can't be read" });
    expect(env.intel.list(ALL).total).toBe(0);
    renameSync(join(env.bot, 'moved.txt'), file);
    await env.intel.refresh();
    expect(env.intel.sources()[1]).toMatchObject({ items: 3 });
    expect(env.intel.sources()[1]?.error).toBeUndefined();
  });
});

describe('the follower alone', () => {
  it('reads nothing when nothing changed, and counts a JSON array, prose and a record with no title', async () => {
    env = await intelEnv({ start: false });
    const file = join(env.bot, 'x.jsonl');
    writeFileSync(file, '["an","array"]\nprose\n{"id":"a"}\n{"title":"Kept"}\n');
    const f = new JsonlFollower({ id: 'x', path: file, isProtected: (p) => env.files.policy.isProtected(p) });
    const read = await f.poll();
    expect(read?.reset).toBe(true);
    expect(read?.records.map((r) => r.item.title)).toEqual(['Kept']);
    expect(f.skipped).toBe(3);
    expect(f.updatedAt).not.toBeNull();
    expect(await f.poll()).toBeNull();
    expect(f.reads).toBe(1);
  });

  it('the captures file may not exist yet: no error, nothing held', async () => {
    env = await intelEnv({ start: false });
    const f = new JsonlFollower({ id: 'captures', path: join(env.home, '.jantar', 'intel', 'captures.jsonl'), own: true, isProtected: () => true });
    expect(await f.poll()).toBeNull();
    expect(f.error).toBeUndefined();
    expect(f.updatedAt).toBeNull();
  });
});
