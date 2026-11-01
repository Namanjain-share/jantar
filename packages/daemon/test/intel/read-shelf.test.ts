/**
 * Read items on the shelf (spec 2.2, 7): the typed keys come only from the
 * daemon's own captures file (a bot's file can never claim frames, a job
 * state or a transcript), each cut to its cap; a tombstone removes its id;
 * search reads the creator, the platform, the caption, the transcript, the
 * on-screen text, the points, the background and the note, without case; a
 * word equal to or inside the creator scores like a tag; links are compared
 * in their canonical form; a list row carries the platform, the creator, the
 * read's state and whether there is a thumbnail. Synthetic records only.
 */
import { describe, expect, it } from 'vitest';
import { INTEL_READ_LIMITS } from '@jantar/protocol';
import { listItem, mapRecord, type MappedRecord } from '../../src/intel/map.js';
import { Shelf } from '../../src/intel/shelf.js';

function rec(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, captured_at: '2026-11-01T10:00:00.000Z', title: `Example ${id}`, url: `https://example.com/${id}`, ...extra };
}
function mapped(source: string, raw: Record<string, unknown>): MappedRecord {
  const m = mapRecord(raw, source);
  if (!m) throw new Error('not mapped');
  return m;
}

const RICH = {
  platform: 'instagram',
  creator: 'Example Cook',
  posted_at: '2026-10-30T08:00:00.000Z',
  depth: 'standard',
  read: { state: 'saved', depth: 'standard', done: 'standard', tier: 'chrome', at: '2026-11-01T10:01:00.000Z' },
  caption: 'Three ways to cook DAL at home',
  transcript: '[0:01] first you soak the lentils',
  on_screen: 'SOAK OVERNIGHT',
  points: ['Use a pressure cooker'],
  background: 'Dal is a staple across South Asia.',
  note: 'for sunday lunch',
  frames: 3,
};

describe('the mapper', () => {
  it('captures: the typed keys, each checked and cut', () => {
    const m = mapped('captures', rec('A1', { ...RICH, caption: 'c'.repeat(5_000), transcript: 't'.repeat(20_000), frames: 99, platform: 'myspace' }));
    expect(m.item).toMatchObject({ creator: 'Example Cook', postedAt: '2026-10-30T08:00:00.000Z', depth: 'standard', read: { state: 'saved', tier: 'chrome' }, onScreen: 'SOAK OVERNIGHT', points: ['Use a pressure cooker'], frames: INTEL_READ_LIMITS.thumbsMax });
    expect(m.item.caption?.length).toBeLessThanOrEqual(INTEL_READ_LIMITS.captionMax);
    expect(m.item.transcript?.length).toBeLessThanOrEqual(INTEL_READ_LIMITS.transcriptMax);
    expect(m.item.platform).toBeUndefined();
    expect(m.item.fields.map((f) => f.key)).not.toContain('caption');
  });

  it('any other source: the same keys are plain fields, never a read, frames or a transcript', () => {
    const m = mapped('bot', rec('B1', RICH));
    for (const k of ['platform', 'creator', 'read', 'caption', 'transcript', 'onScreen', 'frames', 'depth']) expect(m.item, k).not.toHaveProperty(k);
    expect(m.item.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['platform', 'creator', 'caption', 'transcript', 'frames']));
  });

  it('a tombstone is captures only and needs its own id', () => {
    expect(mapRecord({ id: 'A1', deleted: true }, 'captures')).toMatchObject({ rid: 'A1', deleted: true });
    expect(mapRecord({ deleted: true }, 'captures')).toBeNull();
    expect(mapRecord({ id: 'A1', deleted: true }, 'bot')).toBeNull();
  });

  it('a list row: platform, creator, the read\'s state and reason, a thumb', () => {
    const row = listItem(mapped('captures', rec('A1', { ...RICH, read: { state: 'failed', depth: 'light', reason: 'The page took too long to answer.' } })).item);
    expect(row).toMatchObject({ platform: 'instagram', creator: 'Example Cook', read: { state: 'failed', reason: 'The page took too long to answer.' }, thumb: true });
    expect(row).not.toHaveProperty('transcript');
    expect(listItem(mapped('captures', rec('A2')).item)).not.toHaveProperty('thumb');
  });
});

describe('search over read items', () => {
  function shelf(): Shelf {
    const s = new Shelf();
    s.add('captures', [mapped('captures', rec('A1', RICH)), mapped('captures', rec('A2', { title: 'Another example', what_it_is: 'Mentions example cook in passing' }))]);
    s.add('bot', [mapped('bot', rec('B1', { title: 'A bot item', transcript: 'lentils from a bot' }))]);
    return s;
  }
  const ids = (s: Shelf, q: string) => s.list({ q, limit: 50 }).items.map((i) => i.id);

  it('finds a word that is only in the caption, the transcript, the on-screen text, the points, the background or the note, without case', () => {
    const s = shelf();
    for (const q of ['dal', 'lentils', 'overnight', 'pressure', 'staple', 'sunday', 'instagram']) expect(ids(s, q), q).toContain('captures:A1');
    // A bot's "transcript" is a plain field: still searched as a field, never as a read.
    expect(ids(s, 'lentils')).toEqual(expect.arrayContaining(['captures:A1', 'bot:B1']));
    expect(ids(s, 'nowhere-word')).toEqual([]);
    expect(ids(s, 'soak lentils')).toEqual(['captures:A1']);
  });

  it('a word equal to the creator scores like a tag, above a word found anywhere else', () => {
    const s = shelf();
    expect(ids(s, '"example cook"')).toEqual(['captures:A1', 'captures:A2']);
  });

  it('a shared link with tracking parameters is the item already saved', () => {
    const s = new Shelf();
    s.add('captures', [mapped('captures', rec('A1', { url: 'https://www.instagram.com/reel/AbC123xyz/' }))]);
    expect(s.findUrl('https://instagram.com/reel/AbC123xyz/?igsh=abc&utm_source=ig_web_copy_link')).toBe('captures:A1');
    expect(s.findUrl('https://www.instagram.com/reel/Other12345/')).toBeNull();
  });

  it('a tombstone removes the item', () => {
    const s = shelf();
    s.add('captures', [mapped('captures', { id: 'A1', deleted: true })]);
    expect(s.get('captures:A1')).toBeNull();
    expect(ids(s, 'lentils')).toEqual(['bot:B1']);
  });
});
