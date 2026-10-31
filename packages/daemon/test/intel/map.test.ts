/**
 * The mapping (spec 4.9) on the bot-shaped fixture and on other shapes, and
 * LI4 (daemon part): `javascript:`, `data:` and relative urls never become
 * `url`; every item passes IntelItemSchema.
 */
import { describe, expect, it } from 'vitest';
import { INTEL_T0, intelRecord } from '@jantar/fixtures';
import { IntelItemSchema, IntelListItemSchema } from '@jantar/protocol';
import { cut, httpLink, listItem, mapRecord } from '../../src/intel/map.js';

function mapped(rec: unknown, source = 'intel') {
  const m = mapRecord(rec, source);
  if (!m) throw new Error('no item');
  expect(IntelItemSchema.safeParse(m.item).success).toBe(true);
  return m;
}

describe('the bot-shaped record', () => {
  it('maps as the table says: title, url, type, tags, time, what and why; the rest as fields in file order', () => {
    const rec = intelRecord(3);
    const { rid, item, atMs } = mapped(rec);
    expect(rid).toBe('ex-3');
    expect(item).toMatchObject({
      id: 'intel:ex-3',
      source: 'intel',
      at: new Date(Date.parse(INTEL_T0) + 3 * 60_000).toISOString(),
      title: 'Example tool 3',
      url: 'https://example.com/3',
      type: 'tool',
      tags: ['example', 'tool'],
      summary: 'What example 3 is, in a sentence.',
      why: 'Why example 3 matters, in a sentence.',
    });
    expect(atMs).toBe(Date.parse(INTEL_T0) + 3 * 60_000);
    // source_metrics is an object: skipped. Everything else plain, in file order.
    expect(item.fields.map((f) => f.key)).toEqual([
      'source_post_url',
      'source_handle',
      'how_it_was_built',
      'product_angle',
      'replicable',
      'depth',
      'status',
      'verified',
      'workspace',
      'source_session',
    ]);
    expect(item.fields.find((f) => f.key === 'source_post_url')?.value).toBe('https://example.com/post/3');
    expect(item.fields.find((f) => f.key === 'replicable')?.value).toBe('false');
    expect(item.fields.find((f) => f.key === 'source_handle')?.value).toBe('@example');
  });

  it('the list row keeps no why and no fields, and cuts the summary to two lines', () => {
    const { item } = mapped(intelRecord(1, { what_it_is: 'w'.repeat(1000) }));
    const row = listItem(item);
    expect(IntelListItemSchema.safeParse(row).success).toBe(true);
    expect(row).not.toHaveProperty('why');
    expect(row).not.toHaveProperty('fields');
    expect(row.summary?.length).toBe(240);
    expect(row.summary?.endsWith('…')).toBe(true);
  });
});

describe('other shapes', () => {
  it('takes the first usable candidate for each field', () => {
    const { item } = mapped({ name: 'Example name', link: 'https://example.com/l', created_at: 1_790_000_000, kind: 'repo', description: 'About it', why: 'Because' });
    expect(item).toMatchObject({ title: 'Example name', url: 'https://example.com/l', at: new Date(1_790_000_000 * 1000).toISOString(), type: 'repo', summary: 'About it', why: 'Because', fields: [] });
    expect(mapped({ headline: 'H', ts: 1_790_000_000_123, text: 'T' }).item).toMatchObject({ title: 'H', at: new Date(1_790_000_000_123).toISOString(), summary: 'T' });
    // A title that is blank falls through to name; the blank one is not a field either.
    expect(mapped({ title: '  ', name: 'N' }).item).toMatchObject({ title: 'N', fields: [] });
    // An unreadable time is no time, and stays as a field.
    const odd = mapped({ title: 'T', date: 'someday' });
    expect(odd.item.at).toBeNull();
    expect(odd.atMs).toBe(-1);
    expect(odd.item.fields).toEqual([{ key: 'date', value: 'someday' }]);
  });

  it('needs a JSON object with a title', () => {
    for (const bad of [null, 3, 'text', ['an', 'array'], {}, { id: 'x', url: 'https://example.com' }, { title: 7 }, { title: '   ' }]) {
      expect(mapRecord(bad, 'intel'), JSON.stringify(bad)).toBeNull();
    }
  });

  it('ids: a printable id up to 128, else a hash of the source, url and title', () => {
    expect(mapped({ id: 42, title: 'T' }).rid).toBe('42');
    const long = mapped({ id: 'x'.repeat(129), title: 'T', url: 'https://example.com/a' });
    expect(long.rid).toMatch(/^[0-9a-f]{24}$/);
    expect(mapped({ id: 'has space', title: 'T', url: 'https://example.com/a' }).rid).toBe(long.rid);
    expect(mapped({ title: 'T', url: 'https://example.com/a' }, 'other').rid).not.toBe(long.rid);
    expect(mapped({ title: 'T' }).rid).toBe(mapped({ title: 'T' }).rid);
    // A 128-character id after a 32-character source would pass 160: hashed, so the wire id fits.
    const wide = mapped({ id: 'y'.repeat(128), title: 'T' }, 's'.repeat(32));
    expect(wide.rid).toMatch(/^[0-9a-f]{24}$/);
    expect(mapped({ id: 'y'.repeat(127), title: 'T' }, 's'.repeat(32)).rid).toBe('y'.repeat(127));
  });

  it('cuts what is too long and keeps at most 20 tags and 20 fields', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, `v${i}`]));
    const { item } = mapped({
      title: 't'.repeat(400),
      type: 'k'.repeat(50),
      tags: [...Array.from({ length: 25 }, (_, i) => `tag${i}`), 5, '', 'g'.repeat(60)],
      summary: 's'.repeat(3000),
      ...many,
      ['a-very-long-field-name-that-goes-past-forty-characters']: 'x',
    });
    expect(item.title.length).toBe(300);
    expect(item.type?.length).toBe(40);
    expect(item.tags).toHaveLength(20);
    expect(item.summary?.length).toBe(2000);
    expect(item.fields).toHaveLength(20);
    expect(item.fields[0]).toEqual({ key: 'f0', value: 'v0' });
    expect(mapped({ title: 'T', tags: ['a', 'b', 'c'], list: ['x', 'y'], mixed: ['x', 1], nested: { a: 1 }, nothing: null, inf: Infinity }).item.fields).toEqual([
      { key: 'list', value: 'x, y' },
    ]);
  });

  it('never splits an emoji when it cuts', () => {
    expect(cut('ab😀cd', 4)).toBe('ab…');
    expect(cut('abc', 3)).toBe('abc');
  });
});

describe('LI4: only http(s) becomes a link', () => {
  it('drops javascript:, data:, relative and odd urls from `url`', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', '/relative/path', 'relative', '//example.com/x', 'ftp://example.com/x', 'https://', 'mailto:a@example.com']) {
      expect(httpLink(bad), bad).toBeUndefined();
      const { item } = mapped({ title: 'T', url: bad });
      expect(item.url, bad).toBeUndefined();
    }
    expect(httpLink(' https://example.com/x ')).toBe('https://example.com/x');
    expect(httpLink('http://example.com')).toBe('http://example.com/');
  });

  it('a link is kept as the URL parser writes it, so the phone takes it as one whole address too', () => {
    // The phone's httpHref (web screens/intel/model.ts) links only this shape.
    const phoneLinks = /^https?:\/\/\S+$/i;
    const cases: [string, string][] = [
      ['https://example.com/a b', 'https://example.com/a%20b'],
      ['HTTPS://EXAMPLE.com/Path?q=a b#c d', 'https://example.com/Path?q=a%20b#c%20d'],
      ['https://example.com/ünï', 'https://example.com/%C3%BCn%C3%AF'],
      ['https://example.com/x', 'https://example.com/x'],
    ];
    for (const [raw, href] of cases) {
      expect(httpLink(raw), raw).toBe(href);
      expect(href).toMatch(phoneLinks);
      expect(mapped({ title: 'T', url: raw }).item.url, raw).toBe(href);
    }
    // Encoding a link already at the protocol's 2,000 characters would pass it: dropped.
    const wide = `https://example.com/${'a '.repeat(985)}x`;
    expect(wide.length).toBeLessThanOrEqual(2000);
    expect(httpLink(wide)).toBeUndefined();
  });

  it('a bad url does not hide a good link; a script in the title stays text', () => {
    expect(mapped({ title: 'T', url: 'javascript:alert(1)', link: 'https://example.com/ok' }).item.url).toBe('https://example.com/ok');
    const { item } = mapped(intelRecord(9003, { id: 'ex-script', title: '<script>window.__pwned=1</script>' }));
    expect(item.title).toBe('<script>window.__pwned=1</script>');
  });
});
