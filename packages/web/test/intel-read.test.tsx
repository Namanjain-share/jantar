/**
 * v0.8 Intel reads links (spec 8) on the phone, against the fake API:
 *
 * - the model: state words (per tier while fetching), depth lines, which
 *   jobs the strip shows, a job's name, https-only Open original, the byline;
 * - Add post: the sheet's words, the depth (Standard picked, a line each),
 *   Save with an Idempotency-Key kept for a retry of the same thing, the
 *   Mac's own sentence when it did not queue, "Already saved." with Open and
 *   Read again, What's sent, Add by hand (the 0.7 form), and the 0.7 sheet
 *   unchanged with reading off (no jobs asked for);
 * - the Reading strip: every state word with its depth, a failed job's
 *   reason, Retry and Change depth, the Mac's sentence when reads can't run,
 *   saved jobs gone after an hour, no strip while filtering or when the jobs
 *   fail, and a reload on every life.changed;
 * - rows: frame 0 from the frames route, "platform · creator · date", and
 *   "Couldn't read" on a failed item with no job left (after a restart);
 * - the item page: the thumbnail strip and its larger view, Open original
 *   (https only, a new tab, no opener, no referrer), the read's state and
 *   notes, Read again as …, Retry, a running step with no buttons, Read it
 *   on a plain capture, each part labelled, the transcript folded, Claude's
 *   background labelled, Delete after a second tap (captures only), and a
 *   hostile title, summary, caption and transcript kept as text;
 * - Ask's save card: host and depth, Add and Skip with no Edit, then
 *   "Saved to Intel · Reading" with Open and Undo.
 *
 * Every creator, link and word here is made up (example.com hosts only).
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskCard, AskList, AskTurn, IntelItem, IntelJob, IntelJobsResponse, IntelListItem, IntelListResponse, LifeStatus } from '@jantar/protocol';
import { ApiError, type Api } from '../src/lib/api.js';
import { OPEN } from '../src/ui/screens/intel/AddPostSheet.js';
import { DEPTH_LINE, READ_COPY, bylineOf, httpsHref, jobName, stateWord, stripJobs } from '../src/ui/screens/intel/model.js';
import { NOW, emit, fakeApi, preloadPlaces, renderApp, stateWith } from './helpers.js';

preloadPlaces('intel', 'ask');

const ON = stateWith({ features: { intel: true, intelRead: true } });
const OFF = stateWith({ features: { intel: true } });
const RID = 'captures:01JSYNTHREAD0000000000000A';
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

let blobs: Blob[] = [];
beforeEach(() => {
  blobs = [];
  let n = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn((b: Blob) => {
      blobs.push(b);
      return `blob:http://127.0.0.1:7420/f-${++n}`;
    }),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
});
afterEach(() => vi.unstubAllGlobals());

function row(over: Partial<IntelListItem> = {}): IntelListItem {
  return {
    id: RID,
    source: 'captures',
    at: ago(30 * MIN),
    title: 'Three ways to cook dal at home',
    url: 'https://www.example.com/reel/AbC123xyz/',
    type: 'reel',
    tags: ['recipe', 'dal'],
    summary: 'A short reel on soaking, pressure cooking and tempering dal.',
    platform: 'instagram',
    creator: '@example_cook',
    read: { state: 'saved' },
    thumb: true,
    ...over,
  };
}

const plain = (n: number): IntelListItem => ({
  id: `intel:ex-${n}`,
  source: 'intel',
  at: ago(n * 60 * MIN),
  title: `Example tool ${n}`,
  url: `https://example.com/${n}`,
  type: 'tool',
  tags: ['example'],
  summary: `What example ${n} is.`,
});

function page(items: IntelListItem[]): IntelListResponse {
  return { items, next: null, total: items.length, types: [{ type: 'reel', n: 1 }], tags: [{ tag: 'dal', n: 1 }] };
}

function item(over: Partial<IntelItem> = {}): IntelItem {
  return {
    id: RID,
    source: 'captures',
    at: ago(30 * MIN),
    title: 'Three ways to cook dal at home',
    url: 'https://www.example.com/reel/AbC123xyz/',
    type: 'reel',
    tags: ['recipe', 'dal'],
    summary: 'A short reel on soaking, pressure cooking and tempering dal.',
    why: 'A weeknight dinner in under an hour.',
    fields: [{ key: 'via', value: 'shortcut' }],
    platform: 'instagram',
    creator: '@example_cook',
    postedAt: '2026-01-12T08:00:00.000Z',
    depth: 'standard',
    read: { state: 'saved', depth: 'standard', done: 'standard', tier: 'chrome', at: ago(29 * MIN), notes: ['Frames: only the cover image'] },
    caption: 'Dal three ways: soaked, pressured, tempered.',
    onScreen: 'SOAK OVERNIGHT\nTEMPER LAST',
    points: ['Soak the dal overnight', 'Temper with cumin at the end'],
    transcript: '[0:00] Today we make dal three ways.\n[0:12] First, soak it.',
    background: 'Dal is a staple of everyday cooking across South Asia.',
    note: 'try the second one',
    frames: 3,
    ...over,
  };
}

let jn = 0;
function job(over: Partial<IntelJob> = {}): IntelJob {
  jn += 1;
  return { id: `captures:01JSYNTHJOB00000000000000${String(jn).padStart(2, '0')}`, title: `Job ${jn}`, platform: 'web', depth: 'standard', state: 'queued', queuedAt: ago(5 * MIN), ...over };
}

const jobsOf = (jobs: IntelJob[], reading: IntelJobsResponse['reading'] = { on: true, canRun: true }): IntelJobsResponse => ({ jobs, reading });

function shelfApi(over: Partial<Api> = {}) {
  return fakeApi({
    intelList: vi.fn(async () => page([row(), plain(1)])),
    intelSources: vi.fn(async () => ({ sources: [{ id: 'captures', label: 'captures', items: 1, skipped: 0, updatedAt: null }] })),
    intelJobs: vi.fn(async () => jobsOf([])),
    intelGet: vi.fn(async () => ({ item: item() })),
    intelFrame: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })),
    ...over,
  });
}

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe('the model', () => {
  it('words each state, and while fetching where the page comes from', () => {
    expect(['queued', 'preparing', 'frames', 'transcribing', 'summarising', 'saved', 'failed'].map((s) => stateWord(s as IntelJob['state']))).toEqual([
      'Waiting',
      'Getting the Mac ready (once)',
      'Looking at frames',
      'Listening',
      'Summarising',
      'Saved',
      "Couldn't read",
    ]);
    expect(stateWord('fetching', 'chrome')).toBe('Opening in Chrome');
    expect(stateWord('fetching', 'browser')).toBe('Opening the page');
    expect(stateWord('fetching', 'download')).toBe('Downloading');
    expect(stateWord('fetching', 'ytdlp')).toBe('Downloading');
    expect(stateWord('fetching')).toBe('Opening the page');
    expect(DEPTH_LINE).toEqual({
      light: 'The page, caption and a summary',
      standard: 'Light, plus frames and the text on screen',
      full: 'Standard, plus what is said and links in your note',
    });
  });

  it('the strip keeps what is on its way and what failed; a saved read for an hour', () => {
    const waiting = job({ state: 'queued' });
    const failed = job({ state: 'failed', endedAt: ago(20 * 60 * MIN) });
    const fresh = job({ state: 'saved', endedAt: ago(59 * MIN) });
    const old = job({ state: 'saved', endedAt: ago(61 * MIN) });
    expect(stripJobs([waiting, failed, fresh, old], NOW)).toEqual([waiting, failed, fresh]);
    expect(jobName({ title: '  ', url: 'https://www.example.com/a/b' })).toBe('www.example.com');
    expect(jobName({ title: 'Instagram reel', url: 'https://www.example.com/a' })).toBe('Instagram reel');
    expect(jobName({ title: '' })).toBe('A note');
  });

  it('Open original takes one whole https address only; the byline is who, where and when', () => {
    expect(httpsHref('https://www.example.com/reel/AbC123xyz/')).toBe('https://www.example.com/reel/AbC123xyz/');
    for (const no of ['http://www.example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'see https://example.com', '', undefined, null]) expect(httpsHref(no), String(no)).toBeNull();
    expect(bylineOf({ creator: '@example_cook', platform: 'instagram', postedAt: '2026-01-12T08:00:00.000Z' }, NOW)).toBe('@example_cook · Instagram · 12 Jan');
    expect(bylineOf({ platform: 'web' }, NOW)).toBe('Web');
  });
});

describe('Add post', () => {
  async function openSheet(api: Api, state = ON) {
    const r = renderApp({ path: '/intel', state, api });
    await screen.findByText('Example tool 1');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const sheet = await screen.findByRole('dialog', { name: state === ON ? 'Add post' : 'Add to the shelf' });
    return { ...r, sheet };
  }
  const box = (sheet: HTMLElement) => within(sheet).getByLabelText('Link or text') as HTMLTextAreaElement;
  const depth = (sheet: HTMLElement, name: string) => within(within(sheet).getByRole('group', { name: 'Depth' })).getByRole('button', { name });

  it('says what it takes, picks Standard with its line, and saves the text and the depth with a key; the sheet closes and the shelf reloads', async () => {
    const intelRead = vi.fn(async () => ({ id: RID, duplicate: false, queued: true, message: 'Queued.' }));
    const api = shelfApi({ intelRead });
    const { sheet, toasts } = await openSheet(api);
    expect(within(sheet).getByText('A reel, video, post, article, PDF or any link, or just text.')).toBeTruthy();
    expect(box(sheet).maxLength).toBe(4000);
    expect(depth(sheet, 'Standard').getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByText('Light, plus frames and the text on screen')).toBeTruthy();
    const save = within(sheet).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box(sheet), { target: { value: '  https://www.example.com/reel/AbC123xyz/ the second one  ' } });
    fireEvent.click(depth(sheet, 'Full'));
    expect(within(sheet).getByText('Standard, plus what is said and links in your note')).toBeTruthy();
    const lists = fn(api.intelList).mock.calls.length;
    const jobs = fn(api.intelJobs).mock.calls.length;
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add post' })).toBeNull());
    expect(intelRead).toHaveBeenCalledWith({ text: 'https://www.example.com/reel/AbC123xyz/ the second one', depth: 'full' }, expect.any(String));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Saved. Reading it on your Mac.');
    await waitFor(() => expect(fn(api.intelList).mock.calls.length).toBeGreaterThan(lists));
    expect(fn(api.intelJobs).mock.calls.length).toBeGreaterThan(jobs);
  });

  it("says the Mac's own sentence when the read did not start", async () => {
    const api = shelfApi({ intelRead: vi.fn(async () => ({ id: RID, duplicate: false, queued: false, message: "Today's reads are used up. Retry tomorrow." })) });
    const { sheet, toasts } = await openSheet(api);
    fireEvent.change(box(sheet), { target: { value: 'just a thought about dal' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toasts.getState().toasts.map((t) => t.text)).toContain("Today's reads are used up. Retry tomorrow."));
  });

  it('a failed save keeps the sheet and its text; a retry of the same thing sends the same key, another depth a new one', async () => {
    let n = 0;
    const intelRead = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new ApiError('network', 'offline', 0);
      return { id: RID, duplicate: false, queued: true, message: 'Queued.' };
    });
    const api = shelfApi({ intelRead });
    const { sheet } = await openSheet(api);
    fireEvent.change(box(sheet), { target: { value: 'https://www.example.com/p/1' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect((await within(sheet).findByRole('alert')).textContent).toMatch(/^Not saved\. /);
    expect(box(sheet).value).toBe('https://www.example.com/p/1');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(intelRead).toHaveBeenCalledTimes(2));
    await within(sheet).findByRole('alert');
    fireEvent.click(depth(sheet, 'Light'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(intelRead).toHaveBeenCalledTimes(3));
    const keys = intelRead.mock.calls.map((c) => (c as unknown[])[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('a link already saved: "Already saved." with Open and Read again at the depth picked here', async () => {
    const intelReread = vi.fn(async (id: string) => ({ id }));
    const api = shelfApi({ intelRead: vi.fn(async () => ({ id: RID, duplicate: true, queued: false, message: 'Already saved.' })), intelReread });
    const { sheet, toasts, router } = await openSheet(api);
    fireEvent.change(box(sheet), { target: { value: 'https://www.example.com/reel/AbC123xyz/' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Already saved.')).toBeTruthy();
    const open = within(sheet).getByRole('link', { name: 'Open' });
    expect(open.getAttribute('href')).toBe(`/intel?item=${encodeURIComponent(RID)}`);
    // A text button like Read again: 44 px under a coarse pointer.
    expect(open.className).toBe(OPEN);
    expect(OPEN).toContain('coarse:min-h-44');
    fireEvent.click(depth(sheet, 'Full'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Read again as Full' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add post' })).toBeNull());
    expect(intelReread).toHaveBeenCalledWith(RID, 'full', expect.any(String));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Reading it again on your Mac.');
    expect(router.getState().route).toEqual({ name: 'intel' });
  });

  it("What's sent opens the exact words; Add by hand is the 0.7 form", async () => {
    const api = shelfApi();
    const { sheet } = await openSheet(api);
    expect(within(sheet).getByText('The page, pictures and what is said go to Claude.')).toBeTruthy();
    const more = within(sheet).getByRole('button', { name: "What's sent" });
    expect(within(sheet).queryByText(READ_COPY.sentAll)).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(within(sheet).getByText(READ_COPY.sentAll).textContent).toMatch(/no audio leaves it\.$/);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add by hand' }));
    const hand = await screen.findByRole('dialog', { name: 'Add to the shelf' });
    expect(within(hand).getByLabelText('Title')).toBeTruthy();
    expect(within(hand).getByLabelText('Link')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add post' })).toBeNull());
  });

  it('with reading off at the Mac, Add is the 0.7 sheet and no jobs are asked for', async () => {
    const api = shelfApi();
    const { sheet } = await openSheet(api, OFF);
    expect(within(sheet).getByLabelText('Title')).toBeTruthy();
    expect(within(sheet).queryByText('Link or text')).toBeNull();
    expect(api.intelJobs).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
  });
});

describe('the Reading strip', () => {
  const strip = () => screen.findByRole('region', { name: 'Reading' });

  it('lists each read with its state word and depth; a title (or its host) opens the item', async () => {
    const jobs = [
      job({ title: 'Instagram reel', platform: 'instagram', state: 'fetching', tier: 'chrome' }),
      job({ title: '', url: 'https://www.example.com/article', state: 'queued', depth: 'light' }),
      job({ state: 'preparing' }),
      job({ state: 'frames', depth: 'full' }),
      job({ state: 'transcribing', depth: 'full' }),
      job({ state: 'summarising' }),
      job({ state: 'fetching', tier: 'download' }),
      job({ state: 'saved', endedAt: ago(2 * MIN) }),
    ];
    renderApp({ path: '/intel', state: ON, api: shelfApi({ intelJobs: vi.fn(async () => jobsOf(jobs)) }) });
    const s = await strip();
    const rows = within(s).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('p')?.textContent?.trim())).toEqual([
      'Opening in Chrome · Standard',
      'Waiting · Light',
      'Getting the Mac ready (once) · Standard',
      'Looking at frames · Full',
      'Listening · Full',
      'Summarising · Standard',
      'Downloading · Standard',
      'Saved · Standard',
    ]);
    // The title and its state line are one link (one 44 px+ target).
    const first = within(rows[0]!).getByRole('link', { name: /^Instagram reel/ });
    expect(first.getAttribute('href')).toBe(`/intel?item=${encodeURIComponent(jobs[0]!.id)}`);
    expect(first.textContent).toContain('Opening in Chrome · Standard');
    expect(within(rows[1]!).getByRole('link').firstElementChild?.textContent).toBe('www.example.com');
    // The rail counts them; the list follows under it.
    expect(within(s).getByRole('heading', { name: /Reading/ }).textContent).toBe('Reading8');
    expect(within(s).queryByRole('button')).toBeNull();
  });

  it("a failed read says why, with Retry at its depth and Change depth in place", async () => {
    const failed = job({ title: 'A slow page', state: 'failed', depth: 'light', reason: 'The page took too long to answer.', endedAt: ago(MIN) });
    const intelReread = vi.fn(async (id: string) => ({ id }));
    const api = shelfApi({ intelJobs: vi.fn(async () => jobsOf([failed])), intelReread });
    renderApp({ path: '/intel', state: ON, api });
    const s = await strip();
    expect(within(s).getByText("Couldn't read · Light")).toBeTruthy();
    expect(within(s).getByText('The page took too long to answer.')).toBeTruthy();
    fireEvent.click(within(s).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(intelReread).toHaveBeenCalledWith(failed.id, 'light', expect.any(String)));
    fireEvent.click(within(s).getByRole('button', { name: 'Change depth' }));
    const picker = within(s).getByRole('group', { name: 'Read at' });
    expect(within(picker).getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(picker).getByRole('button', { name: 'Full' }));
    fireEvent.click(within(s).getByRole('button', { name: 'Read as Full' }));
    await waitFor(() => expect(intelReread).toHaveBeenLastCalledWith(failed.id, 'full', expect.any(String)));
    await waitFor(() => expect(within(s).queryByRole('group', { name: 'Read at' })).toBeNull());
  });

  it('a refused Retry keeps the row and says why', async () => {
    const failed = job({ state: 'failed', reason: 'Stopped before it finished. Retry.' });
    const intelReread = vi.fn(async () => {
      throw new ApiError('conflict', 'That item is being read now.', 409);
    });
    renderApp({ path: '/intel', state: ON, api: shelfApi({ intelJobs: vi.fn(async () => jobsOf([failed])), intelReread }) });
    const s = await strip();
    fireEvent.click(within(s).getByRole('button', { name: 'Retry' }));
    expect((await within(s).findByRole('alert')).textContent).toBe('Not saved. That item is being read now.');
    expect(within(s).getByText('Stopped before it finished. Retry.')).toBeTruthy();
  });

  it("the Mac's sentence shows under the rail when reads can't run, and Retry waits", async () => {
    const why = 'Reading is paused: Jantar runs read-only on the Mac.';
    const failed = job({ state: 'failed', reason: why });
    renderApp({ path: '/intel', state: ON, api: shelfApi({ intelJobs: vi.fn(async () => jobsOf([failed], { on: true, canRun: false, why })) }) });
    const s = await strip();
    expect(within(s).getAllByText(why)).toHaveLength(2);
    expect((within(s).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(s).getByRole('button', { name: 'Change depth' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads again on every life.changed; no strip with nothing to show, while filtering, or when the jobs fail', async () => {
    let jobs: IntelJob[] = [];
    const intelJobs = vi.fn(async () => jobsOf(jobs));
    const { store } = renderApp({ path: '/intel', state: ON, api: shelfApi({ intelJobs }) });
    await screen.findByText('Example tool 1');
    await waitFor(() => expect(intelJobs).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
    jobs = [job({ title: 'Now reading', state: 'frames' })];
    act(() => emit(store, [{ seq: 11, ts: new Date(NOW).toISOString(), type: 'life.changed', data: {} }]));
    expect(within(await strip()).getByText('Looking at frames · Standard')).toBeTruthy();
    expect(intelJobs).toHaveBeenCalledTimes(2);
  });

  it('hides while a search or filter is on, and when the jobs cannot be read', async () => {
    const jobs = [job({ state: 'frames' })];
    renderApp({ path: '/intel?type=reel', state: ON, api: shelfApi({ intelJobs: vi.fn(async () => jobsOf(jobs)) }) });
    await screen.findByText('Example tool 1');
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
  });

  it('a Mac whose reads are not built shows the shelf as it is', async () => {
    renderApp({ path: '/intel', state: ON, api: shelfApi({ intelJobs: vi.fn(async () => Promise.reject(new ApiError('not_implemented', 'not built yet', 501))) }) });
    await screen.findByText('Example tool 1');
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('rows of read items', () => {
  it("show frame 0 from the frames route, 'platform · creator · date', and nothing for a row with no thumbnail", async () => {
    const api = shelfApi();
    renderApp({ path: '/intel', state: ON, api });
    const title = await screen.findByText('Three ways to cook dal at home');
    const link = title.closest('a')!;
    expect(within(link).getByText(/^Instagram · @example_cook · /)).toBeTruthy();
    await waitFor(() => expect(link.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/));
    expect(api.intelFrame).toHaveBeenCalledWith(RID, 0, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.intelFrame).toHaveBeenCalledTimes(1);
    expect(link.querySelector('img')?.getAttribute('alt')).toBe('');
    // A row of a bot's file stays as 0.7 drew it: type · source · date, no picture.
    const other = screen.getByText('Example tool 1').closest('a')!;
    expect(within(other).getByText(/^tool · intel · /)).toBeTruthy();
    expect(other.querySelector('img, [data-thumb]')).toBeNull();
  });

  it("a failed read says Couldn't read on its row, with no job left in memory (after a restart)", async () => {
    const api = shelfApi({ intelList: vi.fn(async () => page([row({ read: { state: 'failed', reason: 'Stopped before it finished. Retry.' }, thumb: false })])) });
    renderApp({ path: '/intel', state: ON, api });
    const link = (await screen.findByText('Three ways to cook dal at home')).closest('a')!;
    expect(within(link).getByText("Couldn't read")).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
  });

  it('a frame that does not come leaves its quiet box', async () => {
    const api = shelfApi({ intelFrame: vi.fn(async () => Promise.reject(new ApiError('not_found', 'No such picture.', 404))) });
    renderApp({ path: '/intel', state: ON, api });
    const link = (await screen.findByText('Three ways to cook dal at home')).closest('a')!;
    await waitFor(() => expect(api.intelFrame).toHaveBeenCalled());
    expect(link.querySelector('[data-thumb]')).not.toBeNull();
    expect(link.querySelector('img')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the item page of a read item', () => {
  const openItem = (api: Api, state = ON) => renderApp({ path: `/intel?item=${encodeURIComponent(RID)}`, state, api });

  it('pictures, title, byline, Open original, the read, then each part labelled, and type · source · saved · depth last', async () => {
    const api = shelfApi();
    openItem(api);
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Three ways to cook dal at home' });
    const article = h1.closest('article')!;
    const pics = within(article).getByRole('list', { name: 'Pictures' });
    expect(within(pics).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Picture 1 of 3', 'Picture 2 of 3', 'Picture 3 of 3']);
    await waitFor(() => expect(pics.querySelectorAll('img')).toHaveLength(3));
    expect(fn(api.intelFrame).mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [RID, 0],
      [RID, 1],
      [RID, 2],
    ]);
    expect(within(article).getByText('@example_cook · Instagram · 12 Jan')).toBeTruthy();
    const original = within(article).getByRole('link', { name: 'Open original' });
    expect(original.getAttribute('href')).toBe('https://www.example.com/reel/AbC123xyz/');
    expect(original.getAttribute('target')).toBe('_blank');
    expect(original.getAttribute('rel')).toBe('noopener noreferrer');
    expect(original.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(within(article).queryByRole('link', { name: 'Open link' })).toBeNull();
    expect(within(article).getByText('Read at Standard')).toBeTruthy();
    expect(within(within(article).getByRole('list', { name: 'Left out' })).getByText('Frames: only the cover image')).toBeTruthy();
    const headings = within(article)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['What it is', 'Key points', 'Caption', 'On screen', 'Why it matters', 'Transcript', 'From Claude, not from the post', 'Your note']);
    expect(within(article).getByText('Soak the dal overnight')).toBeTruthy();
    expect(within(article).getByText(/^SOAK OVERNIGHT/).textContent).toBe('SOAK OVERNIGHT\nTEMPER LAST');
    expect(within(article).getByText('Dal is a staple of everyday cooking across South Asia.')).toBeTruthy();
    expect(within(article).getByText('try the second one')).toBeTruthy();
    expect(within(article).getByText(/^reel · captures · .* · Standard$/)).toBeTruthy();
    expect(within(within(article).getByRole('list', { name: 'Tags' })).getByRole('link', { name: 'dal' }).getAttribute('href')).toBe('/intel?tag=dal');
  });

  it('the transcript is folded until asked for', async () => {
    openItem(shelfApi());
    const fold = await screen.findByRole('button', { name: 'Transcript' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/Today we make dal three ways/)).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const text = screen.getByText(/Today we make dal three ways/);
    expect(text.textContent).toBe('[0:00] Today we make dal three ways.\n[0:12] First, soak it.');
    expect(fold.getAttribute('aria-controls')).toBe(text.id);
  });

  it('a picture opens larger with the bytes already here', async () => {
    const api = shelfApi();
    openItem(api);
    const pics = await screen.findByRole('list', { name: 'Pictures' });
    await waitFor(() => expect(pics.querySelectorAll('img')).toHaveLength(3));
    fireEvent.click(within(pics).getByRole('button', { name: 'Picture 2 of 3' }));
    const view = await screen.findByRole('dialog', { name: 'Picture 2 of 3' });
    expect(within(view).getByRole('img', { name: 'Picture 2 of 3' }).getAttribute('src')).toMatch(/^blob:/);
    expect(api.intelFrame).toHaveBeenCalledTimes(3);
  });

  it('Read again as … opens the depths in place and starts a read; the page follows the job', async () => {
    let current = item();
    let jobs: IntelJob[] = [];
    const intelReread = vi.fn(async (id: string) => {
      jobs = [{ id, title: 'Instagram reel', platform: 'instagram', depth: 'light', state: 'frames', queuedAt: ago(0) }];
      current = item({ read: { state: 'queued', depth: 'light' } });
      return { id };
    });
    const api = shelfApi({ intelGet: vi.fn(async () => ({ item: current })), intelJobs: vi.fn(async () => jobsOf(jobs)), intelReread });
    openItem(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Read again as …' }));
    const picker = screen.getByRole('group', { name: 'Read at' });
    expect(within(picker).getByRole('button', { name: 'Standard' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(picker).getByRole('button', { name: 'Light' }));
    expect(screen.getByText('The page, caption and a summary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read as Light' }));
    await waitFor(() => expect(intelReread).toHaveBeenCalledWith(RID, 'light', expect.any(String)));
    // The step the Mac is in, with no buttons while it runs.
    expect(await screen.findByText('Looking at frames · Light')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Read again|^Retry$|^Read it$/ })).toBeNull();
  });

  it("a failed read (after a restart too): Couldn't read, the reason, Retry at its depth", async () => {
    const intelReread = vi.fn(async (id: string) => ({ id }));
    const api = shelfApi({ intelGet: vi.fn(async () => ({ item: item({ read: { state: 'failed', depth: 'full', reason: 'Stopped before it finished. Retry.' }, frames: 0 }) })), intelReread });
    openItem(api);
    expect(await screen.findByText("Couldn't read · Full")).toBeTruthy();
    expect(screen.getByText('Stopped before it finished. Retry.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Pictures' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(intelReread).toHaveBeenCalledWith(RID, 'full', expect.any(String)));
  });

  it('a plain capture with a link offers Read it while the Mac reads links; with reading off it does not', async () => {
    const capture: IntelItem = { id: RID, source: 'captures', at: ago(MIN), title: 'A saved link', url: 'https://www.example.com/a', type: 'link', tags: [], fields: [{ key: 'via', value: 'shortcut' }] };
    const intelReread = vi.fn(async (id: string) => ({ id }));
    const api = shelfApi({ intelGet: vi.fn(async () => ({ item: capture })), intelReread });
    const r = openItem(api);
    // A plain capture keeps 0.7's look: Open link, no labels.
    expect(await screen.findByRole('link', { name: 'Open link' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read as Standard' }));
    await waitFor(() => expect(intelReread).toHaveBeenCalledWith(RID, 'standard', expect.any(String)));
    r.unmount();
    openItem(shelfApi({ intelGet: vi.fn(async () => ({ item: capture })) }), OFF);
    await screen.findByRole('link', { name: 'Open link' });
    expect(screen.queryByRole('button', { name: 'Read it' })).toBeNull();
  });

  it('no Open original for a link that is not https', async () => {
    openItem(shelfApi({ intelGet: vi.fn(async () => ({ item: item({ url: 'http://www.example.com/reel/AbC123xyz/' }) })) }));
    await screen.findByRole('heading', { level: 1, name: 'Three ways to cook dal at home' });
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
  });

  it('Delete needs a second tap, then leaves for the shelf and says so; only a captures item has it', async () => {
    const intelDelete = vi.fn(async () => ({ ok: true as const }));
    const api = shelfApi({ intelDelete });
    const { router, toasts } = openItem(api);
    const del = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(del);
    expect(intelDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(intelDelete).toHaveBeenCalledWith(RID, expect.any(String)));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel' }));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Deleted from the shelf.');
  });

  it("a bot's item has no Delete", async () => {
    openItem(shelfApi({ intelGet: vi.fn(async () => ({ item: item({ id: 'intel:ex-1', source: 'intel' }) })) }));
    await screen.findByRole('heading', { level: 1, name: 'Three ways to cook dal at home' });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('a hostile title, summary, caption, transcript and note stay text: no element, no link, nothing runs', async () => {
    const evil = '<img src=x onerror="alert(1)"> [click](https://evil.example.com) <script>alert(2)</script>';
    const api = shelfApi({
      intelGet: vi.fn(async () => ({
        item: item({ title: evil, summary: evil, caption: evil, onScreen: evil, transcript: evil, background: evil, note: evil, points: [evil], frames: 0, creator: '<b>@x</b>' }),
      })),
    });
    openItem(api);
    const h1 = await screen.findByRole('heading', { level: 1, name: evil });
    expect(h1.textContent).toBe(evil);
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    const article = h1.closest('article')!;
    expect(article.querySelector('img, script, b')).toBeNull();
    expect(within(article).getAllByText(evil).length).toBeGreaterThanOrEqual(7);
    const hrefs = [...article.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.filter((h) => h?.includes('evil'))).toEqual([]);
    expect(within(article).getByText(/^<b>@x<\/b> · Instagram/)).toBeTruthy();
  });
});

describe("Ask's save card", () => {
  const TID = '01JFZ8X8Y3T0V5G9WQK2M4N799';
  const STATUS: LifeStatus = {
    open: true,
    timezone: 'UTC',
    today: '2026-01-15',
    currency: 'INR',
    lockScreenDetails: false,
    modules: { todos: true, medicines: false, food: false, places: false, finance: false, posts: false },
    estimate: { available: false },
    backups: { last: null, count: 0 },
    push: { devices: 1, webpush: true },
  };
  const saveCard = (card: Partial<AskCard> = {}, depth?: 'light' | 'standard' | 'full'): AskCard => ({
    action: { type: 'save', url: 'https://www.example.com/reel/AbC123xyz/', ...(depth ? { depth } : {}) },
    state: 'proposed',
    ...card,
  });
  const turn = (cards: AskCard[]): AskTurn => ({ id: TID, at: ago(MIN), text: 'save this: https://www.example.com/reel/AbC123xyz/', state: 'done', reply: 'Save this to Intel?', cards, dropped: 0 });
  const openAsk = (cards: AskCard[], over: Partial<Api> = {}) => {
    let current: AskList = { ready: true, turns: [turn(cards)] };
    const api = fakeApi({ askList: vi.fn(async () => current), lifeStatus: vi.fn(async () => STATUS), projectsList: vi.fn(async () => ({ projects: [] })), ...over });
    const r = renderApp({ path: '/ask', api, state: stateWith({ features: { ask: true, life: true, intel: true, intelRead: true } }) });
    return { ...r, api, set: (l: AskList) => (current = l) };
  };

  it('names the host and the depth, with Add and Skip and no Edit', async () => {
    const askAdd = vi.fn(async () => ({ id: RID }));
    const { set } = openAsk([saveCard()], { askAdd });
    const card = (await screen.findByText('www.example.com')).closest('li')!;
    expect(within(card).getByText('Save to Intel')).toBeTruthy();
    expect(within(card).getByText('Standard')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Skip: www.example.com' })).toBeTruthy();
    set({ ready: true, turns: [turn([saveCard({ state: 'added', ref: RID })])] });
    fireEvent.click(within(card).getByRole('button', { name: 'Add: www.example.com' }));
    await waitFor(() => expect(askAdd).toHaveBeenCalledWith(TID, 0, undefined, expect.any(String)));
    expect(await screen.findByText('Saved to Intel · Reading')).toBeTruthy();
  });

  it('added: "Saved to Intel · Reading" with Open (the item on the shelf) and Undo', async () => {
    const askUndo = vi.fn(async () => ({ ok: true as const }));
    const { router } = openAsk([saveCard({ state: 'added', ref: RID }, 'full')], { askUndo });
    const card = (await screen.findByText('Saved to Intel · Reading')).closest('li')!;
    expect(within(card).getByText('Full')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Undo: www.example.com' }));
    await waitFor(() => expect(askUndo).toHaveBeenCalledWith(TID, 0, expect.any(String)));
    fireEvent.click(within(card).getByRole('link', { name: 'Open' }));
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'intel', item: RID }));
  });
});
