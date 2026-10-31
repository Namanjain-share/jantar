/**
 * The shelf in memory: newest first (no time last), ids per source, search
 * over every text, type and tag filters, chip counts, paging by cursor, the
 * cap, the url lookup captures use, and the 100 ms answer over a full
 * shelf (spec 9.6, at INTEL_MAX_ITEMS).
 */
import { describe, expect, it } from 'vitest';
import { INTEL_MAX_ITEMS, IntelListResponseSchema, type IntelListQuery } from '@jantar/protocol';
import { intelRecord, perfBudgetMs } from '@jantar/fixtures';
import { mapRecord, type MappedRecord } from '../../src/intel/map.js';
import { Shelf, urlKey } from '../../src/intel/shelf.js';

function rec(source: string, r: Record<string, unknown>): MappedRecord {
  const m = mapRecord(r, source);
  if (!m) throw new Error('no item');
  return m;
}

const q = (over: Partial<IntelListQuery> = {}): IntelListQuery => ({ limit: 50, ...over });

function ids(s: Shelf, over: Partial<IntelListQuery> = {}): string[] {
  const r = s.list(q({ limit: 100, ...over }));
  expect(IntelListResponseSchema.safeParse(r).success).toBe(true);
  return r.items.map((i) => i.id);
}

describe('order and ids', () => {
  it('newest first by time, then later in the file first; items with no time last; two sources never collide', () => {
    const s = new Shelf();
    s.replace('a', [
      rec('a', { id: '1', title: 'One', at: '2026-10-29T08:00:00Z' }),
      rec('a', { id: '2', title: 'Two', at: '2026-10-29T09:00:00Z' }),
      rec('a', { id: '3', title: 'Three' }),
      rec('a', { id: '4', title: 'Four', at: '2026-10-29T08:00:00Z' }),
      rec('a', { id: '5', title: 'Five' }),
    ]);
    s.add('b', [rec('b', { id: '1', title: 'Other one', at: '2026-10-29T08:30:00Z' })]);
    expect(ids(s)).toEqual(['a:2', 'b:1', 'a:4', 'a:1', 'a:5', 'a:3']);
    expect(s.get('a:1')?.title).toBe('One');
    expect(s.get('b:1')?.title).toBe('Other one');
    expect(s.get('nope')).toBeNull();
    expect(s.get('c:1')).toBeNull();
    expect(s.count('a')).toBe(5);
    s.remove('b');
    expect(s.get('b:1')).toBeNull();
    expect(s.size()).toBe(5);
  });

  it('a replace forgets what the source had; an add replaces the same id', () => {
    const s = new Shelf();
    s.replace('a', [rec('a', { id: '1', title: 'One' }), rec('a', { id: '2', title: 'Two' })]);
    s.add('a', [rec('a', { id: '1', title: 'One again' })]);
    expect(ids(s)).toEqual(['a:1', 'a:2']);
    expect(s.get('a:1')?.title).toBe('One again');
    s.replace('a', [rec('a', { id: '3', title: 'Three' })]);
    expect(ids(s)).toEqual(['a:3']);
  });
});

describe('search and filters', () => {
  const shelf = () => {
    const s = new Shelf();
    s.replace('intel', [
      rec('intel', { id: 'h', title: 'Claude Code hooks cookbook', type: 'tool', tags: ['Hooks', 'claude'], at: '2026-10-29T10:00:00Z' }),
      rec('intel', { id: 's', title: 'Something else', what_it_is: 'mentions HOOKS in passing', type: 'repo', tags: ['misc'], at: '2026-10-29T09:00:00Z' }),
      rec('intel', { id: 'w', title: 'Why one', why_it_matters: 'a hook matters', type: 'tool', tags: ['hooks'], at: '2026-10-29T08:00:00Z' }),
      rec('intel', { id: 'f', title: 'Field one', handle: '@hook-maker', type: 'teardown', at: '2026-10-29T07:00:00Z' }),
      rec('intel', { id: 'n', title: 'Nothing (a.b)*', type: 'tool', tags: ['other'], at: '2026-10-29T06:00:00Z' }),
    ]);
    return s;
  };

  it('searches title, summary, why, tags and field values, case-insensitively, as plain text', () => {
    const s = shelf();
    expect(ids(s, { q: 'hook' })).toEqual(['intel:h', 'intel:s', 'intel:w', 'intel:f']);
    // A tag counts: w's "hooks" matches, f's "@hook-maker" does not.
    expect(ids(s, { q: 'HOOKS' })).toEqual(['intel:h', 'intel:s', 'intel:w']);
    expect(ids(s, { q: '(a.b)*' })).toEqual(['intel:n']);
    expect(ids(s, { q: '   ' })).toHaveLength(5);
    expect(ids(s, { q: 'no match anywhere' })).toEqual([]);
  });

  it('type filters exactly, tag case-insensitively; counts follow the other filters', () => {
    const s = shelf();
    expect(ids(s, { type: 'tool' })).toEqual(['intel:h', 'intel:w', 'intel:n']);
    expect(ids(s, { type: 'Tool' })).toEqual([]);
    expect(ids(s, { tag: 'HOOKS' })).toEqual(['intel:h', 'intel:w']);
    const all = s.list(q());
    expect(all.total).toBe(5);
    expect(all.types).toEqual([
      { type: 'tool', n: 3 },
      { type: 'repo', n: 1 },
      { type: 'teardown', n: 1 },
    ]);
    // Hooks and hooks count once, under the casing seen first.
    expect(all.tags).toEqual([
      { tag: 'Hooks', n: 2 },
      { tag: 'claude', n: 1 },
      { tag: 'misc', n: 1 },
      { tag: 'other', n: 1 },
    ]);
    // With a type picked, the type chips still offer the others (counted over the search and tag only).
    const tools = s.list(q({ type: 'tool' }));
    expect(tools.total).toBe(3);
    expect(tools.types.map((t) => t.type)).toEqual(['tool', 'repo', 'teardown']);
    expect(tools.tags).toEqual([
      { tag: 'Hooks', n: 2 },
      { tag: 'claude', n: 1 },
      { tag: 'other', n: 1 },
    ]);
    const hooked = s.list(q({ tag: 'hooks', q: 'cookbook' }));
    expect(hooked.total).toBe(1);
    expect(hooked.types).toEqual([{ type: 'tool', n: 1 }]);
  });

  it('counts at most 30 tags, the most used first', () => {
    const s = new Shelf();
    s.replace('a', Array.from({ length: 40 }, (_, i) => rec('a', { id: String(i), title: `T${i}`, tags: [`t${String(i).padStart(2, '0')}`, ...(i < 5 ? ['common'] : [])] })));
    const r = s.list(q());
    expect(r.tags).toHaveLength(30);
    expect(r.tags[0]).toEqual({ tag: 'common', n: 5 });
  });
});

describe('paging', () => {
  it('pages by the cursor until next is null, and carries on after an item that went away', () => {
    const s = new Shelf();
    s.replace('intel', Array.from({ length: 7 }, (_, i) => rec('intel', intelRecord(i))));
    const p1 = s.list(q({ limit: 3 }));
    expect(p1.items.map((i) => i.id)).toEqual(['intel:ex-6', 'intel:ex-5', 'intel:ex-4']);
    expect(p1.next).toMatch(/^2026-.*\|intel\|ex-4$/);
    expect(p1.total).toBe(7);
    const p2 = s.list(q({ limit: 3, before: p1.next ?? '' }));
    expect(p2.items.map((i) => i.id)).toEqual(['intel:ex-3', 'intel:ex-2', 'intel:ex-1']);
    const p3 = s.list(q({ limit: 3, before: p2.next ?? '' }));
    expect(p3.items.map((i) => i.id)).toEqual(['intel:ex-0']);
    expect(p3.next).toBeNull();
    // ex-1 leaves the shelf: the page after it starts at what is older.
    s.replace('intel', Array.from({ length: 7 }, (_, i) => i).filter((i) => i !== 1).map((i) => rec('intel', intelRecord(i))));
    expect(s.list(q({ limit: 3, before: p2.next ?? '' })).items.map((i) => i.id)).toEqual(['intel:ex-0']);
    expect(s.list(q({ before: 'garbage' })).items).toHaveLength(6);
    expect(s.list(q({ limit: 3, before: '|intel|gone' })).items).toEqual([]);
  });

  it('after an undated item that went away, the undated ones are offered again, never lost', () => {
    const s = new Shelf();
    const dated = [rec('a', { id: 'd1', title: 'D1', at: '2026-10-29T08:00:00Z' }), rec('a', { id: 'd2', title: 'D2', at: '2026-10-29T09:00:00Z' })];
    const undated = (except: string) => ['u1', 'u2', 'u3', 'u4'].filter((id) => id !== except).map((id) => rec('a', { id, title: id }));
    s.replace('a', [...dated, ...undated('')]);
    const p1 = s.list(q({ limit: 4 }));
    expect(p1.items.map((i) => i.id)).toEqual(['a:d2', 'a:d1', 'a:u4', 'a:u3']);
    expect(p1.next).toBe('|a|u3');
    // u3 leaves its file: what comes after it is still offered (u4 again; the phone shows each id once).
    s.replace('a', [...dated, ...undated('u3')]);
    const p2 = s.list(q({ limit: 4, before: p1.next ?? '' }));
    expect(p2.items.map((i) => i.id)).toEqual(['a:u4', 'a:u2', 'a:u1']);
    expect(p2.next).toBeNull();
  });
});

describe('the cap and the url lookup', () => {
  it('past the cap the oldest go, and are counted', () => {
    const s = new Shelf(5);
    s.replace('a', Array.from({ length: 4 }, (_, i) => rec('a', intelRecord(i))));
    s.add('b', Array.from({ length: 3 }, (_, i) => rec('b', intelRecord(i + 10))));
    expect(s.size()).toBe(5);
    expect(s.dropped).toBe(2);
    expect(ids(s)).toEqual(['b:ex-12', 'b:ex-11', 'b:ex-10', 'a:ex-3', 'a:ex-2']);
    expect(new Shelf().list(q()).total).toBe(0);
    expect(INTEL_MAX_ITEMS).toBe(5_000);
  });

  it('finds the newest item with a url, comparing scheme and host case', () => {
    const s = new Shelf();
    s.replace('a', [rec('a', { id: '1', title: 'Old', url: 'https://Example.com', at: '2026-10-28T00:00:00Z' }), rec('a', { id: '2', title: 'New', url: 'https://example.com/', at: '2026-10-29T00:00:00Z' })]);
    expect(s.findUrl('HTTPS://EXAMPLE.COM')).toBe('a:2');
    expect(s.findUrl('https://example.com/other')).toBeNull();
    s.add('a', [rec('a', { id: '3', title: 'Other', url: 'https://example.com/other' })]);
    expect(s.findUrl('https://example.com/other')).toBe('a:3');
    expect(urlKey('not a url')).toBe('not a url');
  });
});

describe('spec 9.6: a full shelf (INTEL_MAX_ITEMS)', () => {
  it('answers a search with filters in under 100 ms', () => {
    const s = new Shelf();
    s.replace('intel', Array.from({ length: INTEL_MAX_ITEMS }, (_, i) => rec('intel', intelRecord(i))));
    s.list(q());
    const times: number[] = [];
    for (const query of [q({ q: 'example 19' }), q({ q: 'nothing like this', type: 'tool' }), q({ tag: 'example', limit: 100 }), q({ q: 'sentence', tag: 'repo' })]) {
      const t0 = performance.now();
      const r = s.list(query);
      times.push(performance.now() - t0);
      expect(r.items.length).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...times), times.map((t) => t.toFixed(1)).join(' ')).toBeLessThan(perfBudgetMs(100));
  });
});
