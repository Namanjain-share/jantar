/**
 * The Intel shelf (v0.4 spec 5.8, 5.10) against the fake API: every state
 * (loading, empty with and without sources, nothing matching, a switch off,
 * offline, an error, success), search after typing stops, the type and tag
 * filters in the address, Show more, the item page, the Add sheet (saved,
 * duplicate, not saved), and the gates: LI4 (a `<script>` title is text)
 * and LW2 (the url and field values are links only when they are one whole
 * http(s) address, with target _blank and rel noopener noreferrer).
 * v0.5.3: "12 matches" while searching, the search's words marked in each
 * row (case, Devanagari whole, the `İ` skip; S13: text nodes only), the
 * clear button, and `focus=search` from the header's magnifier.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntelItem, IntelListItem, IntelListResponse, IntelSource } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { FieldValue } from '../src/ui/screens/intel/ItemPage.js';
import { ADD_SOURCE_COMMAND, hasFilters, httpHref, itemsWord, marks, matchesWord, shelfDate, shelfPath, shelfTime, tagsFrom, termsOf } from '../src/ui/screens/intel/model.js';
import { emit, fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('intel');

afterEach(() => vi.unstubAllGlobals());

const ON = stateWith({ features: { intel: true } });

function row(i: number, over: Partial<IntelListItem> = {}): IntelListItem {
  return {
    id: `intel:ex-${i}`,
    source: 'intel',
    at: `2026-01-1${i % 10}T08:00:00.000Z`,
    title: `Example tool ${i}`,
    url: `https://example.com/${i}`,
    type: 'tool',
    tags: ['example'],
    summary: `What example ${i} is, in a sentence.`,
    ...over,
  };
}

function page(items: IntelListItem[], over: Partial<IntelListResponse> = {}): IntelListResponse {
  return {
    items,
    next: null,
    total: items.length,
    types: [
      { type: 'tool', n: 214 },
      { type: 'repo', n: 98 },
    ],
    tags: [
      { tag: 'example', n: 12 },
      { tag: 'hooks', n: 3 },
    ],
    ...over,
  };
}

function item(over: Partial<IntelItem> = {}): IntelItem {
  return {
    id: 'intel:ex-1',
    source: 'intel',
    at: '2026-01-14T08:00:00.000Z',
    title: 'Example tool 1',
    url: 'https://example.com/1',
    type: 'tool',
    tags: ['example', 'hooks'],
    summary: 'What example 1 is, in a sentence.',
    why: 'Why example 1 matters, in a sentence.',
    fields: [
      { key: 'source_post_url', value: 'https://example.com/post/1' },
      { key: 'source_handle', value: '@example' },
    ],
    ...over,
  };
}

const source = (id: string, over: Partial<IntelSource> = {}): IntelSource => ({ id, label: id, items: 0, skipped: 0, updatedAt: null, ...over });
const SOURCES = { sources: [source('captures'), source('intel', { items: 2 })] };

function shelfApi(over: Partial<Api> = {}) {
  return fakeApi({
    intelList: vi.fn(async () => page([row(2), row(1)])),
    intelSources: vi.fn(async () => SOURCES),
    ...over,
  });
}

function open(path: string, api: Api, status: 'live' | 'offline' = 'live') {
  return renderApp({ path, state: ON, api, status });
}

describe('the model', () => {
  it('httpHref takes one whole http(s) address and nothing else', () => {
    expect(httpHref('https://example.com/x')).toBe('https://example.com/x');
    expect(httpHref(' http://example.com ')).toBe('http://example.com/');
    // The daemon sends a url as the URL parser writes it (map.ts httpLink): a space in it arrives as %20, and links.
    expect(httpHref('https://example.com/a%20b')).toBe('https://example.com/a%20b');
    expect(httpHref('https://example.com/a b')).toBeNull();
    for (const no of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', '/relative', 'example.com', 'see https://example.com', 'https://example.com and more', 'ftp://example.com', 'https://', '', null, undefined]) {
      expect(httpHref(no), String(no)).toBeNull();
    }
  });

  it('dates, tags, paths and counts', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    expect(shelfDate('2026-01-14T12:00:00.000Z', now)).toBe('14 Jan');
    expect(shelfDate('2025-01-14T12:00:00.000Z', now)).toBe('14 Jan 2025');
    expect(shelfDate(null, now)).toBe('');
    expect(shelfTime('2026-01-14T12:00:00.000Z')).toMatch(/^14 Jan 2026 \d{2}:\d{2}$/);
    expect(tagsFrom(' hooks, cli ,, Hooks,repo ')).toEqual(['hooks', 'cli', 'repo']);
    expect(shelfPath({ q: 'a b', type: 'tool' }, 'intel:ex-1')).toBe('/intel?q=a+b&type=tool&item=intel%3Aex-1');
    expect(shelfPath({})).toBe('/intel');
    expect(hasFilters({ tag: 'x' })).toBe(true);
    expect([itemsWord(1), itemsWord(612)]).toEqual(['1 item', '612 items']);
    expect(ADD_SOURCE_COMMAND).toBe('jantar intel source add <file.jsonl>');
    expect([matchesWord(1), matchesWord(12), matchesWord(1200)]).toEqual(['1 match', '12 matches', '1,200 matches']);
  });

  it('v0.5.3: marks the search words without case, joins back to the text, and skips a text lowercasing would lengthen', () => {
    const joined = (text: string, terms: string[]) => marks(text, terms).map((p) => p.text).join('');
    const shown = (text: string, q: string) => marks(text, termsOf(q)).map((p) => (p.hit ? `[${p.text}]` : p.text)).join('');
    expect(termsOf(undefined)).toEqual([]);
    expect(termsOf('Prisma "DB migrate"')).toEqual(['prisma', 'db migrate']);
    expect(shown('Claude Code hooks cookbook', 'HOOK code')).toBe('Claude [Code] [hook]s cookbook');
    expect(shown('Prisma DB Migrate guide', '"db migrate"')).toBe('Prisma [DB Migrate] guide');
    // Overlapping and touching words make one mark; every place a word is, is marked.
    expect(shown('hooks and hooks', 'hook ooks')).toBe('[hooks] and [hooks]');
    expect(shown('abc', 'a b c')).toBe('[abc]');
    expect(shown('Nothing here', 'zzz')).toBe('Nothing here');
    expect(marks('', ['a'])).toEqual([{ text: '', hit: false }]);
    // Devanagari: a word with its vowel signs is marked whole, never split at a sign.
    expect(shown('नमस्ते दुनिया', 'दुनिया')).toBe('नमस्ते [दुनिया]');
    expect(shown('नमस्ते दुनिया', 'नमस्ते')).toBe('[नमस्ते] दुनिया');
    // "İ" lowercases to two characters: the offsets would drift, so nothing is marked.
    expect(marks('İstanbul guide', ['guide'])).toEqual([{ text: 'İstanbul guide', hit: false }]);
    for (const [text, q] of [['Claude Code hooks', 'o'], ['a<b>c</b>', 'b'], ['x', '']] as const) expect(joined(text, termsOf(q))).toBe(text);
  });
});

describe('the shelf', () => {
  it('lists newest first with the total, type chips with counts and the row anatomy', async () => {
    const api = shelfApi();
    open('/intel', api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Intel' })).toBeTruthy();
    expect(await screen.findByText('Example tool 2')).toBeTruthy();
    expect(screen.getByText('2 items')).toBeTruthy();
    const rows = screen.getAllByRole('listitem').filter((li) => li.querySelector('a[href^="/intel?item="]'));
    expect(rows.map((r) => within(r).getByText(/^Example tool/).textContent)).toEqual(['Example tool 2', 'Example tool 1']);
    expect(within(rows[0] as HTMLElement).getByText(/^tool · intel · 12 Jan$/)).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('What example 2 is, in a sentence.')).toBeTruthy();
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/intel?item=intel%3Aex-2');
    expect(screen.getByRole('button', { name: 'tool, 214' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(api.intelList).toHaveBeenCalledWith({ q: undefined, type: undefined, tag: undefined, limit: 50 });
  });

  it('shows the heading and the skeleton while it loads', async () => {
    const api = shelfApi({ intelList: vi.fn(() => new Promise<never>(() => undefined)) });
    open('/intel', api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Intel' })).toBeTruthy();
    expect(screen.getByLabelText('Search the shelf')).toBeTruthy();
  });

  it('searches 300 ms after typing stops, through the address', async () => {
    const api = shelfApi();
    const { router } = open('/intel', api);
    await screen.findByText('Example tool 2');
    fireEvent.change(screen.getByLabelText('Search the shelf'), { target: { value: 'hook' } });
    fireEvent.change(screen.getByLabelText('Search the shelf'), { target: { value: 'hooks' } });
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks' }));
    await waitFor(() => expect(api.intelList).toHaveBeenLastCalledWith({ q: 'hooks', type: undefined, tag: undefined, limit: 50 }));
    expect((api.intelList as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[0] as { q?: string }).q === 'hook')).toBe(false);
    fireEvent.change(screen.getByLabelText('Search the shelf'), { target: { value: '' } });
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel' }));
  });

  it('a type chip and a tag filter the shelf; the tag sheet picks a tag, and its chip takes it off', async () => {
    const api = shelfApi();
    const { router } = open('/intel?q=hooks', api);
    await screen.findByText('Example tool 2');
    fireEvent.click(screen.getByRole('button', { name: 'repo, 98' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks', type: 'repo' }));
    await waitFor(() => expect(api.intelList).toHaveBeenLastCalledWith({ q: 'hooks', type: 'repo', tag: undefined, limit: 50 }));
    fireEvent.click(await screen.findByRole('button', { name: /^Tags/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Tags' });
    fireEvent.click(within(sheet).getByRole('button', { name: /^hooks/ }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks', type: 'repo', tag: 'hooks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tag hooks: take it off' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks', type: 'repo' }));
    // Tapping the picked type again takes it off.
    fireEvent.click(await screen.findByRole('button', { name: 'repo, 98' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks' }));
  });

  it('the tag filter comes right after All, before every type chip, so a shelf with many types still shows it', async () => {
    const api = shelfApi();
    open('/intel?tag=hooks', api);
    await screen.findByText('Example tool 2');
    const names = within(screen.getByRole('group', { name: 'Filter the shelf' }))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(names.slice(0, 3)).toEqual(['All', 'Tag hooks: take it off', 'Tags']);
    expect(names.slice(3).length).toBeGreaterThan(0);
    expect(names.slice(3).every((n) => /, \d+$/.test(n))).toBe(true);
  });

  it('a filter change keeps the chip row while the next view loads: the pressed chip stays, with focus', async () => {
    // Only the first view answers; every other one is still loading.
    const intelList = vi.fn((q?: { q?: string; type?: string; tag?: string }) => (q?.q || q?.type || q?.tag ? new Promise<never>(() => undefined) : Promise.resolve(page([row(2), row(1)]))));
    const api = shelfApi({ intelList });
    const { router } = open('/intel', api);
    await screen.findByText('Example tool 2');
    const group = screen.getByRole('group', { name: 'Filter the shelf' });
    const repo = screen.getByRole('button', { name: 'repo, 98' });
    repo.focus();
    fireEvent.click(repo);
    await waitFor(() => expect(intelList).toHaveBeenLastCalledWith({ q: undefined, type: 'repo', tag: undefined, limit: 50 }));
    expect(router.getState().route).toEqual({ name: 'intel', type: 'repo' });
    // The list waits; the row, the chip just pressed and its focus stay.
    expect(screen.queryByText('Example tool 2')).toBeNull();
    expect(group.isConnected).toBe(true);
    expect(repo.isConnected).toBe(true);
    expect(repo.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(repo);
    expect(within(group).getByRole('button', { name: /^Tags/ })).toBeTruthy();
    // The Tags sheet still offers the last tags, and the search keeps the row too.
    fireEvent.click(within(group).getByRole('button', { name: /^Tags/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Tags' });
    fireEvent.click(within(sheet).getByRole('button', { name: /^hooks/ }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', type: 'repo', tag: 'hooks' }));
    fireEvent.change(screen.getByLabelText('Search the shelf'), { target: { value: 'hooks' } });
    await waitFor(() => expect(intelList).toHaveBeenLastCalledWith({ q: 'hooks', type: 'repo', tag: 'hooks', limit: 50 }));
    expect(group.isConnected).toBe(true);
    expect(within(group).getByRole('button', { name: 'Tag hooks: take it off' })).toBeTruthy();
  });

  it('Show more fetches the next 50 after the cursor and appends them', async () => {
    const first = page(Array.from({ length: 50 }, (_, i) => row(100 - i, { id: `intel:p1-${i}`, title: `First page ${i}` })), { next: 'cursor-1', total: 52 });
    const second = page([row(1, { id: 'intel:p2-0', title: 'Second page 0' }), row(0, { id: 'intel:p2-1', title: 'Second page 1' })], { next: null, total: 52 });
    const intelList = vi.fn(async (q?: { before?: string }) => (q?.before === 'cursor-1' ? second : first));
    const api = shelfApi({ intelList });
    open('/intel', api);
    await screen.findByText('First page 0');
    expect(screen.getByText('52 items')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Second page 1')).toBeTruthy();
    expect(intelList).toHaveBeenLastCalledWith({ q: undefined, type: undefined, tag: undefined, before: 'cursor-1', limit: 50 });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('Show more never lists an item twice, even one that comes back on a later page', async () => {
    const first = page([row(9, { id: 'intel:a', title: 'Row a' }), row(8, { id: 'intel:b', title: 'Row b' })], { next: 'c1', total: 5 });
    const second = page([row(7, { id: 'intel:c', title: 'Row c' }), row(6, { id: 'intel:a', title: 'Row a' })], { next: 'c2', total: 5 });
    const third = page([row(6, { id: 'intel:c', title: 'Row c' }), row(5, { id: 'intel:d', title: 'Row d' })], { next: null, total: 5 });
    const intelList = vi.fn(async (q?: { before?: string }) => (q?.before === 'c2' ? third : q?.before === 'c1' ? second : first));
    const api = shelfApi({ intelList });
    open('/intel', api);
    await screen.findByText('Row a');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('Row c');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('Row d');
    const titles = screen.getAllByRole('listitem').flatMap((li) => (li.querySelector('a[href^="/intel?item="]') ? [within(li).getByText(/^Row /).textContent] : []));
    expect(titles).toEqual(['Row a', 'Row b', 'Row c', 'Row d']);
  });

  it('reloads when lifeTick moves, asking for the rows already shown', async () => {
    const first = page(Array.from({ length: 50 }, (_, i) => row(i, { id: `intel:p1-${i}`, title: `Row ${i}` })), { next: 'c1', total: 60 });
    const more = page(Array.from({ length: 10 }, (_, i) => row(i, { id: `intel:p2-${i}`, title: `More ${i}` })), { next: null, total: 60 });
    const intelList = vi.fn(async (q?: { before?: string }) => (q?.before ? more : first));
    const api = shelfApi({ intelList });
    const { store } = open('/intel', api);
    await screen.findByText('Row 0');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('More 9');
    act(() => emit(store, [{ seq: 11, ts: '2026-01-15T10:05:00.000Z', type: 'life.changed', data: {} }]));
    await waitFor(() => expect(intelList).toHaveBeenLastCalledWith({ q: undefined, type: undefined, tag: undefined, limit: 60 }));
  });

  it('a reload keeps a list shown past 100 rows: pages of 100 after the cursor until it has them all', async () => {
    // A shelf of 260, newest first, paged as the daemon pages it: `before` is the last row's id.
    let shelf = Array.from({ length: 260 }, (_, i) => row(i, { id: `intel:r-${i}`, title: `Shelf row ${i}` }));
    const intelList = vi.fn(async (q?: { before?: string; limit?: number }) => {
      const start = q?.before ? shelf.findIndex((r) => r.id === q.before) + 1 : 0;
      const items = shelf.slice(start, start + (q?.limit ?? 50));
      return page(items, { total: shelf.length, next: start + items.length < shelf.length ? (items.at(-1)?.id ?? null) : null });
    });
    const api = shelfApi({ intelList });
    const { store } = open('/intel', api);
    await screen.findByText('Shelf row 49');
    for (const last of [99, 149]) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      await screen.findByText(`Shelf row ${last}`);
    }
    const rows = () => screen.getAllByRole('listitem').filter((li) => li.querySelector('a[href^="/intel?item="]'));
    expect(rows()).toHaveLength(150);
    // A bot appends one while the list is open: the reload brings back 150 rows, the new one first.
    shelf = [row(999, { id: 'intel:new', title: 'Appended row' }), ...shelf];
    intelList.mockClear();
    act(() => emit(store, [{ seq: 11, ts: '2026-01-15T10:06:00.000Z', type: 'life.changed', data: {} }]));
    await screen.findByText('Appended row');
    expect(intelList.mock.calls).toEqual([
      [{ q: undefined, type: undefined, tag: undefined, limit: 100 }],
      [{ q: undefined, type: undefined, tag: undefined, before: 'intel:r-98', limit: 50 }],
    ]);
    expect(rows()).toHaveLength(150);
    expect(within(rows()[149] as HTMLElement).getByText('Shelf row 148')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('a source the Mac refuses shows its sentence at the foot', async () => {
    const api = shelfApi({ intelSources: vi.fn(async () => ({ sources: [source('captures'), source('intel', { error: "Can't be read" })] })) });
    open('/intel', api);
    const foot = await screen.findByRole('list', { name: 'Sources not read' });
    expect(foot.textContent).toBe("intel Can't be read");
  });
});

describe('v0.5.3: searching', () => {
  const found = () =>
    page(
      [
        row(2, { title: 'Claude Code hooks cookbook', summary: 'What a HOOK can block.' }),
        row(1, { title: 'Something else', summary: 'Mentions hooks in passing.' }),
      ],
      { total: 12 },
    );
  const rowTexts = () =>
    screen.getAllByRole('listitem').flatMap((li) => (li.querySelector('a[href^="/intel?"]') ? [li.querySelector('p')?.textContent ?? ''] : []));

  it('the count line says matches while the search has words, items otherwise; rows mark the words in the title and summary', async () => {
    const api = shelfApi({ intelList: vi.fn(async () => found()) });
    const a = open('/intel?q=hook', api);
    expect(await screen.findByText('12 matches')).toBeTruthy();
    expect(rowTexts()).toEqual(['Claude Code hooks cookbook', 'Something else']);
    expect([...document.querySelectorAll('main mark')].map((m) => m.textContent)).toEqual(['hook', 'HOOK', 'hook']);
    const mark = document.querySelector('main mark') as HTMLElement;
    expect(mark.className).toContain('bg-select');
    expect(mark.className).toContain('text-ink');
    // The daemon ranks: the phone asks with no sort of its own.
    expect(api.intelList).toHaveBeenCalledWith({ q: 'hook', type: undefined, tag: undefined, limit: 50 });
    a.unmount();
    open('/intel?type=tool', shelfApi({ intelList: vi.fn(async () => found()) }));
    expect(await screen.findByText('12 items')).toBeTruthy();
    expect(document.querySelector('main mark')).toBeNull();
    expect(screen.queryByText(/matches$/)).toBeNull();
  });

  it('S13: a hostile title stays text with its match marked; nothing runs', async () => {
    const hostile = '<img src=x onerror="window.__pwned=3">';
    const api = shelfApi({ intelList: vi.fn(async () => page([row(1, { id: 'intel:ex-img', title: hostile, summary: '<b>img</b> in bold' })])) });
    open('/intel?q=img', api);
    await screen.findByText('1 match');
    expect(rowTexts()).toEqual([hostile]);
    expect([...document.querySelectorAll('main mark')].map((m) => m.textContent)).toEqual(['img', 'img']);
    expect(document.querySelector('main img, main b, script')).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('the clear button shows with text, clears the box and the address at once, and keeps the focus there', async () => {
    const api = shelfApi();
    const { router } = open('/intel?q=hooks&type=tool', api);
    await screen.findByText('Example tool 2');
    const box = screen.getByLabelText('Search the shelf') as HTMLInputElement;
    const clear = screen.getByRole('button', { name: 'Clear the search' });
    expect(clear.querySelector('svg')).toBeTruthy();
    fireEvent.click(clear);
    expect(box.value).toBe('');
    expect(router.getState().route).toEqual({ name: 'intel', type: 'tool' });
    expect(document.activeElement).toBe(box);
    expect(screen.queryByRole('button', { name: 'Clear the search' })).toBeNull();
    // Typed but not yet searched: the button clears the box only.
    fireEvent.change(box, { target: { value: 'half' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(box.value).toBe('');
    await new Promise((r) => setTimeout(r, 350));
    expect(router.getState().route).toEqual({ name: 'intel', type: 'tool' });
  });

  it('focus=search focuses the box and leaves the address; the filters stay', async () => {
    const api = shelfApi();
    const { router } = open('/intel?q=hooks&focus=search', api);
    const box = (await screen.findByLabelText('Search the shelf')) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(box));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', q: 'hooks' }));
    expect(box.value).toBe('hooks');
  });
});

describe('empty and failing', () => {
  it('with no sources: the sentence and the Mac command in mono; Add once, in the header', async () => {
    const api = shelfApi({ intelList: vi.fn(async () => page([], { types: [], tags: [] })), intelSources: vi.fn(async () => ({ sources: [source('captures')] })) });
    open('/intel', api);
    const code = await screen.findByText('jantar intel source add <file.jsonl>');
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement?.textContent).toBe('Nothing on the shelf yet. Add a JSONL file on your Mac: jantar intel source add <file.jsonl>');
    expect(screen.getAllByRole('button', { name: 'Add' })).toHaveLength(1);
  });

  it('with sources but nothing on them yet: the short sentence', async () => {
    const api = shelfApi({ intelList: vi.fn(async () => page([], { types: [], tags: [] })) });
    open('/intel', api);
    expect(await screen.findByText('Nothing on the shelf yet.')).toBeTruthy();
    expect(screen.queryByText(/source add/)).toBeNull();
  });

  it('nothing matching the search offers to clear it', async () => {
    const api = shelfApi({ intelList: vi.fn(async () => page([], { types: [], tags: [] })) });
    const { router } = open('/intel?q=zzz&tag=x', api);
    expect(await screen.findByText('Nothing on the shelf matches.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search and filters' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel' }));
  });

  it('the shelf switched off at the Mac: its sentence with the command in mono, no retry', async () => {
    const api = shelfApi({ intelList: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'The Intel shelf is off. Turn it on at your Mac: jantar intel on', 403))) });
    open('/intel', api);
    expect((await screen.findByText('jantar intel on')).tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 1, name: 'Intel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('no control scope says so; another failure retries', async () => {
    const noScope = shelfApi({ intelList: vi.fn(async () => Promise.reject(new ApiError('forbidden', 'this device does not have the control scope', 403))) });
    const a = open('/intel', noScope);
    expect(await screen.findByText(/Life needs control access/)).toBeTruthy();
    a.unmount();
    let fail = true;
    const intelList = vi.fn(async () => {
      if (fail) throw new ApiError('internal', 'boom', 500);
      return page([row(1)]);
    });
    open('/intel', shelfApi({ intelList }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('heading', { level: 1, name: 'Intel' })).toBeTruthy();
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Example tool 1')).toBeTruthy();
  });

  it('offline: the last list stays, Add is off and says why', async () => {
    const api = shelfApi();
    const { store } = open('/intel', api);
    await screen.findByText('Example tool 2');
    act(() => store.getState().setConn({ status: 'offline', lastOkAt: 0 }));
    expect(screen.getByText('Example tool 2')).toBeTruthy();
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    const down = shelfApi({ intelList: vi.fn(async () => Promise.reject(new ApiError('network', 'offline', 0))) });
    open('/intel', down, 'offline');
    expect(await screen.findByText("Can't reach the Mac. The last list stays here until it's back.")).toBeTruthy();
  });
});

describe('the item page', () => {
  it('title, Open link, what and why, tags, every field, and type · source · time last', async () => {
    const api = shelfApi({ intelGet: vi.fn(async () => ({ item: item() })) });
    open(`/intel?q=hooks&item=${encodeURIComponent('intel:ex-1')}`, api);
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Example tool 1' });
    expect(h1).toBeTruthy();
    expect(api.intelGet).toHaveBeenCalledWith('intel:ex-1');
    const openLink = screen.getByRole('link', { name: 'Open link' });
    expect(openLink.getAttribute('href')).toBe('https://example.com/1');
    expect(openLink.getAttribute('target')).toBe('_blank');
    expect(openLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('What example 1 is, in a sentence.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Why it matters' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Tags' })).getByRole('link', { name: 'hooks' }).getAttribute('href')).toBe('/intel?tag=hooks');
    const terms = [...document.querySelectorAll('dt')].map((d) => d.textContent);
    expect(terms).toEqual(['source_post_url', 'source_handle']);
    expect(screen.getByRole('link', { name: 'https://example.com/post/1' }).getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/^tool · intel · 14 Jan 2026 \d{2}:\d{2}$/)).toBeTruthy();
    // Back to the list as it was (the nav has its own Intel link).
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Intel' }).getAttribute('href')).toBe('/intel?q=hooks');
  });

  it('an item no longer on the shelf says so; no Try again', async () => {
    const api = shelfApi({ intelGet: vi.fn(async () => Promise.reject(new ApiError('not_found', 'That item is no longer on the shelf.', 404))) });
    open(`/intel?item=${encodeURIComponent('intel:gone')}`, api);
    expect(await screen.findByText('That item is no longer on the shelf.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Intel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('LI4 and LW2: hostile items', () => {
  it('a <script> title is text, in the list and on its page', async () => {
    const hostile = '<script>window.__pwned=1</script>';
    const api = shelfApi({
      intelList: vi.fn(async () => page([row(1, { id: 'intel:ex-script', title: hostile, summary: '<img src=x onerror="window.__pwned=2">' })])),
      intelGet: vi.fn(async () => ({ item: item({ id: 'intel:ex-script', title: hostile, summary: '<b>bold</b>' }) })),
    });
    const a = open('/intel', api);
    expect((await screen.findByText(hostile)).tagName).toBe('P');
    expect(document.querySelector('script, img[onerror], b')).toBeNull();
    a.unmount();
    open(`/intel?item=${encodeURIComponent('intel:ex-script')}`, api);
    expect(await screen.findByRole('heading', { level: 1, name: hostile })).toBeTruthy();
    expect(screen.getByText('<b>bold</b>')).toBeTruthy();
    expect(document.querySelector('script, b')).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('only one whole http(s) address becomes a link, opened apart from this page', async () => {
    const api = shelfApi({
      intelGet: vi.fn(async () => ({
        item: item({
          url: 'javascript:alert(1)' as string,
          fields: [
            { key: 'web', value: 'https://example.com/ok' },
            { key: 'plain', value: 'http://example.com' },
            { key: 'js', value: 'javascript:alert(2)' },
            { key: 'data', value: 'data:text/html,<script>alert(3)</script>' },
            { key: 'relative', value: '/etc/passwd' },
            { key: 'sentence', value: 'see https://example.com/inside for more' },
            { key: 'handle', value: '@example' },
          ],
        }),
      })),
    });
    open(`/intel?item=${encodeURIComponent('intel:ex-1')}`, api);
    await screen.findByRole('heading', { level: 1, name: 'Example tool 1' });
    // The client checks the url again: a javascript: one never becomes Open link.
    expect(screen.queryByRole('link', { name: 'Open link' })).toBeNull();
    const outside = [...document.querySelectorAll('article a[target]')];
    expect(outside.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/ok', 'http://example.com/']);
    for (const a of outside) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    for (const text of ['javascript:alert(2)', 'data:text/html,<script>alert(3)</script>', '/etc/passwd', 'see https://example.com/inside for more']) {
      expect(screen.getByText(text).tagName, text).toBe('DD');
    }
    for (const a of document.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^(javascript|data):/i);
  });

  it('FieldValue on its own', () => {
    const { container } = render(
      <>
        <FieldValue value="https://example.com/a?b=c" />
        <FieldValue value="JavaScript:alert(1)" />
      </>,
    );
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.textContent).toBe('https://example.com/a?b=cJavaScript:alert(1)');
  });
});

describe('the Add sheet', () => {
  async function openSheet(api: Api) {
    const r = open('/intel', api);
    await screen.findByText('Example tool 2');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add to the shelf' });
    const field = (name: string) => within(sheet).getByLabelText(name) as HTMLInputElement;
    return { ...r, sheet, field };
  }

  it('sends title, link, type, tags and note as one capture; a new item closes the sheet and reloads', async () => {
    const intelCapture = vi.fn(async () => ({ id: 'captures:01JSYNTHCAPTURE00000000000', duplicate: false }));
    const api = shelfApi({ intelCapture });
    const { sheet, field, toasts } = await openSheet(api);
    const add = within(sheet).getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(field('Title'), { target: { value: '  Example capture ' } });
    fireEvent.change(field('Link'), { target: { value: 'https://example.com/new' } });
    fireEvent.change(field('Type'), { target: { value: 'tool' } });
    fireEvent.change(field('Tags'), { target: { value: 'example, hooks,' } });
    fireEvent.change(field('Note'), { target: { value: 'A synthetic note' } });
    const calls = (api.intelList as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to the shelf' })).toBeNull());
    expect(intelCapture).toHaveBeenCalledWith({ title: 'Example capture', url: 'https://example.com/new', type: 'tool', tags: ['example', 'hooks'], note: 'A synthetic note' }, expect.any(String));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Added to the shelf.');
    await waitFor(() => expect((api.intelList as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls));
  });

  it('a link already on the shelf says so and offers to open it', async () => {
    const api = shelfApi({ intelCapture: vi.fn(async () => ({ id: 'intel:ex-2', duplicate: true })) });
    const { sheet, field, router } = await openSheet(api);
    fireEvent.change(field('Title'), { target: { value: 'Example' } });
    fireEvent.change(field('Link'), { target: { value: 'https://example.com/2' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(await within(sheet).findByText('Already on the shelf.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('link', { name: 'Open it' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', item: 'intel:ex-2' }));
  });

  it('a failed save keeps the sheet and its values, and a retry of the same capture sends the same key', async () => {
    let n = 0;
    const intelCapture = vi.fn(async (): Promise<{ id: string; duplicate: boolean }> => {
      n += 1;
      if (n === 1) throw new ApiError('network', 'offline', 0);
      return { id: 'captures:01JSYNTHCAPTURE00000000000', duplicate: false };
    });
    const api = shelfApi({ intelCapture });
    const { sheet, field } = await openSheet(api);
    fireEvent.change(field('Title'), { target: { value: 'Example' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect((await within(sheet).findByRole('alert')).textContent).toMatch(/^Not saved\. /);
    expect(field('Title').value).toBe('Example');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(intelCapture).toHaveBeenCalledTimes(2));
    const keys = intelCapture.mock.calls.map((c) => (c as unknown[])[1]);
    expect(keys[0]).toBe(keys[1]);
  });

  it('closing (Cancel or Escape) forgets what the last try said and keeps the values typed', async () => {
    let n = 0;
    const intelCapture = vi.fn(async (): Promise<{ id: string; duplicate: boolean }> => {
      n += 1;
      if (n === 1) return { id: 'intel:ex-2', duplicate: true };
      throw new ApiError('network', 'offline', 0);
    });
    const api = shelfApi({ intelCapture });
    const { sheet, field } = await openSheet(api);
    fireEvent.change(field('Title'), { target: { value: 'Example' } });
    fireEvent.change(field('Link'), { target: { value: 'https://example.com/2' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(await within(sheet).findByText('Already on the shelf.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to the shelf' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const again = await screen.findByRole('dialog', { name: 'Add to the shelf' });
    expect(within(again).queryByText('Already on the shelf.')).toBeNull();
    expect((within(again).getByLabelText('Title') as HTMLInputElement).value).toBe('Example');
    // A failed save, then Escape: reopened, the sheet says nothing about it.
    fireEvent.click(within(again).getByRole('button', { name: 'Add' }));
    expect(await within(again).findByRole('alert')).toBeTruthy();
    fireEvent.keyDown(within(again).getByLabelText('Title'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add to the shelf' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const third = await screen.findByRole('dialog', { name: 'Add to the shelf' });
    expect(within(third).queryByRole('alert')).toBeNull();
  });

  it('a link that is not http(s) is refused before sending, with a hint', async () => {
    const api = shelfApi();
    const { sheet, field } = await openSheet(api);
    fireEvent.change(field('Title'), { target: { value: 'Example' } });
    fireEvent.change(field('Link'), { target: { value: 'javascript:alert(1)' } });
    expect(within(sheet).getByText('A link starts with http:// or https://')).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.intelCapture).not.toHaveBeenCalled();
  });
});
