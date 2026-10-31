/**
 * The Meetings screens (v0.5 spec 5.2 to 5.6) against the fake API: the
 * list (day rails, the running line, project chips, search, Show more, the
 * last rows kept while a new search loads, the rows and scroll back from a
 * meeting, the held Delete), the meeting page in each summary state, action items added
 * and removed under Undo, the transcript with its screenshots loaded as
 * they come into view, the viewer, Edit, Export text, and every state
 * (loading, empty, nothing matching, the switch off, broken, an error, no
 * control, offline, gone). The 10 s ask-again runs only while a meeting is
 * open, the page is visible and the Mac can be reached; on the list it asks
 * for the running line alone. Gates: MW2 (meeting text renders as text)
 * and MW3 (screenshots only as blobs from the API, their object URLs
 * revoked on unmount, and the service worker leaving /v1 alone).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTES, type LifeStatus, type Meeting, type MeetingDetail, type MeetingsList, type ProjectView } from '@jantar/protocol';
import { meetingDetail } from '@jantar/fixtures';
import { ApiError, type Api } from '../src/lib/api.js';
import { EXPORTED_MS, POLL_MS } from '../src/ui/screens/meetings/model.js';
import { NOW, fakeApi, renderApp, stateWith } from './helpers.js';

const D = meetingDetail();
const ID = D.meeting.id;
const PROJECT = D.meeting.projectId as string;
const SHOT = D.shots[0]?.id as string;
const EVIL = '<img src=x onerror=window.__pwned=1>';

const ON = stateWith({ features: { meetings: true } });
const LIFE = stateWith({ features: { meetings: true, life: true } });

/** HH:MM of an instant on this machine's clock, as the phone shows it. */
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const mid = (n: number) => `01JFZ8X8Y3T0V5G9WQK2M4N7${String(n).padStart(2, '0')}`;

function meeting(n: number, over: Partial<Meeting> = {}): Meeting {
  return { ...D.meeting, id: mid(n), name: `Example meeting ${n}`, startedAt: ago(50 + n), endedAt: ago(8 + n), gist: `What meeting ${n} agreed.`, ...over };
}

function list(meetings: Meeting[], over: Partial<MeetingsList> = {}): MeetingsList {
  return { meetings, next: null, running: null, ...over };
}

function detail(over: { meeting?: Partial<Meeting>; summary?: Partial<MeetingDetail['summary']>; lines?: MeetingDetail['lines']; shots?: MeetingDetail['shots'] } = {}): MeetingDetail {
  return {
    meeting: { ...D.meeting, ...over.meeting },
    summary: { ...D.summary, ...over.summary },
    lines: over.lines ?? D.lines,
    shots: over.shots ?? D.shots,
  };
}

const STATUS: LifeStatus = {
  open: true,
  timezone: 'UTC',
  today: '2026-01-15',
  currency: null,
  lockScreenDetails: false,
  modules: { todos: true, medicines: false, food: false, places: false, finance: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 0, webpush: false },
};

const project = (id: string, name: string, status: ProjectView['status'] = 'active'): ProjectView => ({ id, name, status, createdAt: ago(1000), updatedAt: ago(1000), open: 0, overdue: 0 });
const PROJECTS = { projects: [project(PROJECT, 'Acme site'), project(mid(90), 'Example app'), project(mid(91), 'Old work', 'paused')] };

function meetingsApi(over: Partial<Api> = {}) {
  return fakeApi({
    meetingsList: vi.fn(async () => list([meeting(1), meeting(2, { projectName: undefined, shots: 0, gist: undefined })])),
    meetingGet: vi.fn(async () => D),
    meetingShot: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })),
    lifeStatus: vi.fn(async () => STATUS),
    projectsList: vi.fn(async () => PROJECTS),
    ...over,
  });
}

function open(path: string, api: Api, opts: { state?: ReturnType<typeof stateWith>; status?: 'live' | 'offline' } = {}) {
  return renderApp({ path, api, state: opts.state ?? ON, status: opts.status ?? 'live' });
}

const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The page's ‹ Meetings (the nav has a Meetings link too). */
const back = () => within(screen.getByRole('main')).getByRole('link', { name: 'Meetings' });

async function menu(name: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

/** Object URLs in jsdom: what is made and what is revoked. */
function objectUrls() {
  let n = 0;
  const made: string[] = [];
  const create = vi.fn((_b: Blob) => {
    const u = `blob:http://127.0.0.1:7420/m-${++n}`;
    made.push(u);
    return u;
  });
  const revoke = vi.fn((_u: string) => undefined);
  Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true });
  return { create, revoke, made };
}

/** IntersectionObserver stand-ins: `show()` reports every observed box as in view; `inits` are their options. */
function fakeObservers() {
  const made: { targets: Element[]; init?: IntersectionObserverInit | undefined; show: () => void }[] = [];
  class FakeObserver {
    targets: Element[] = [];
    constructor(
      readonly cb: IntersectionObserverCallback,
      readonly init?: IntersectionObserverInit,
    ) {
      made.push(this);
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      this.targets = [];
    }
    takeRecords() {
      return [];
    }
    show() {
      const entries = this.targets.map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 }) as unknown as IntersectionObserverEntry);
      if (entries.length) act(() => this.cb(entries, this as unknown as IntersectionObserver));
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return { show: () => made.forEach((o) => o.show()), inits: () => made.map((o) => o.init) };
}

let urls: ReturnType<typeof objectUrls>;
beforeEach(() => {
  urls = objectUrls();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'canShare');
  Reflect.deleteProperty(window, '__pwned');
});

// ---------------------------------------------------------------------------

describe('the list', () => {
  it('shows meetings newest first under day rails, with the row anatomy', async () => {
    const api = meetingsApi({
      meetingsList: vi.fn(async () => list([meeting(1), meeting(2, { projectName: undefined, shots: 0, gist: undefined, startedAt: ago(26 * 60), endedAt: ago(25 * 60) })])),
    });
    open('/meetings', api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
    const today = await screen.findByRole('group', { name: 'Today' });
    const row = within(today).getByRole('listitem');
    expect(within(row).getByText('Example meeting 1')).toBeTruthy();
    expect(within(row).getByText(`${hm(ago(51))} · 42 min`)).toBeTruthy();
    expect(within(row).getByText('Acme site')).toBeTruthy();
    expect(within(row).getByText('1 screenshot')).toBeTruthy();
    expect(within(row).getByText('What meeting 1 agreed.')).toBeTruthy();
    expect(within(row).getByRole('link').getAttribute('href')).toBe(`/meetings?id=${mid(1)}`);
    const yesterday = screen.getByRole('group', { name: 'Yesterday' });
    expect(within(yesterday).getByText('Example meeting 2')).toBeTruthy();
    expect(within(yesterday).queryByText(/screenshot/)).toBeNull();
    // A day is a group, not a landmark: a long list would be dozens of regions.
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull();
    expect(api.meetingsList).toHaveBeenCalledWith({ project: undefined, q: undefined, limit: 30 });
  });

  it('shows "running" for an open meeting, and the running line that opens it', async () => {
    const live = meeting(0, { name: 'Weekly sync', endedAt: null, lines: 34, shots: 3, summary: 'none', gist: undefined });
    open('/meetings', meetingsApi({ meetingsList: vi.fn(async () => list([live, meeting(1)], { running: live })) }));
    const line = await screen.findByRole('link', { name: /Meeting running · Weekly sync/ });
    expect(line.getAttribute('href')).toBe(`/meetings?id=${live.id}`);
    expect(within(line).getByText('34 lines · 3 screenshots')).toBeTruthy();
    expect(line.querySelector('.bg-jup')).toBeTruthy();
    expect(screen.getByText(`${hm(live.startedAt)} · running`)).toBeTruthy();
  });

  it('shows the heading, search and skeleton while it loads', async () => {
    open('/meetings', meetingsApi({ meetingsList: vi.fn(() => new Promise<never>(() => undefined)) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
    expect(screen.getByLabelText('Search meetings')).toBeTruthy();
  });

  it('says how to set up the extension when there are none, the command in mono', async () => {
    open('/meetings', meetingsApi({ meetingsList: vi.fn(async () => list([])) }));
    const code = await screen.findByText('jantar pair --extension');
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('type-mono');
    expect(code.parentElement?.textContent).toBe('No meetings yet. Set up the Chrome extension at your Mac: jantar pair --extension');
  });

  it('says nothing matches a search or filter, and clears it', async () => {
    const api = meetingsApi({ meetingsList: vi.fn(async () => list([])) });
    const { router } = open('/meetings?q=launch&project=none', api);
    expect(await screen.findByText('No meetings match.')).toBeTruthy();
    expect(api.meetingsList).toHaveBeenCalledWith({ project: 'none', q: 'launch', limit: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search and filter' }));
    expect(router.getState().route).toEqual({ name: 'meetings' });
  });

  it('searches 300 ms after typing stops, through the address', async () => {
    const api = meetingsApi();
    const { router } = open('/meetings', api);
    await screen.findByText('Example meeting 1');
    fireEvent.change(screen.getByLabelText('Search meetings'), { target: { value: 'quote' } });
    expect(router.getState().route).toEqual({ name: 'meetings' });
    await waitFor(() => expect(router.getState().route).toEqual({ name: 'meetings', q: 'quote' }));
    await waitFor(() => expect(api.meetingsList).toHaveBeenLastCalledWith({ project: undefined, q: 'quote', limit: 30 }));
  });

  it('filters by the active projects or none, and has no chips while Todos are off', async () => {
    const api = meetingsApi();
    const { router, unmount } = open('/meetings', api, { state: LIFE });
    const chips = await screen.findByRole('group', { name: 'Filter by project' });
    await waitFor(() => expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Acme site', 'Example app', 'No project']));
    expect(within(chips).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(chips).getByRole('button', { name: 'Example app' }));
    expect(router.getState().route).toEqual({ name: 'meetings', project: mid(90) });
    await waitFor(() => expect(api.meetingsList).toHaveBeenLastCalledWith({ project: mid(90), q: undefined, limit: 30 }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter by project' })).getByRole('button', { name: 'No project' }));
    expect(router.getState().route).toEqual({ name: 'meetings', project: 'none' });
    unmount();

    // Todos off (or Life off altogether): no chips, and projects are not asked for.
    const off = meetingsApi({ lifeStatus: vi.fn(async () => ({ ...STATUS, modules: { ...STATUS.modules, todos: false } })) });
    open('/meetings', off, { state: LIFE });
    await screen.findByText('Example meeting 1');
    await waitFor(() => expect(off.lifeStatus).toHaveBeenCalled());
    expect(screen.queryByRole('group', { name: 'Filter by project' })).toBeNull();
    expect(off.projectsList).not.toHaveBeenCalled();
  });

  it('shows more through the cursor', async () => {
    const meetingsList = vi.fn(async (q?: { before?: string }) =>
      q?.before ? list([meeting(3), meeting(4)]) : list([meeting(1), meeting(2)], { next: 'cursor-1' }),
    );
    open('/meetings', meetingsApi({ meetingsList }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Example meeting 4')).toBeTruthy();
    expect(meetingsList).toHaveBeenLastCalledWith({ project: undefined, q: undefined, before: 'cursor-1', limit: 30 });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says when Show more fails, keeps the rows, and tries again', async () => {
    let fail = true;
    const meetingsList = vi.fn(async (q?: { before?: string }) => {
      if (!q?.before) return list([meeting(1), meeting(2)], { next: 'cursor-1' });
      if (fail) throw new ApiError('internal', 'The meetings could not be read.', 500);
      return list([meeting(3)]);
    });
    open('/meetings', meetingsApi({ meetingsList }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('The meetings could not be read.')).toBeTruthy();
    expect(screen.getByText('Example meeting 2')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Example meeting 3')).toBeTruthy();
    expect(screen.queryByText('The meetings could not be read.')).toBeNull();
  });

  it('a reload after Show more brings back as many rows, following the cursor past one page', async () => {
    // 70 meetings, as many per page as asked for; the cursor is how many came before.
    const meetingsList = vi.fn(async (q: { before?: string; limit?: number } = {}) => {
      const from = q.before ? Number(q.before) : 0;
      const n = Math.min(q.limit ?? 30, 70 - from);
      return list(
        Array.from({ length: n }, (_, i) => meeting(from + i + 1)),
        { next: from + n < 70 ? String(from + n) : null },
      );
    });
    open('/meetings', meetingsApi({ meetingsList }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Example meeting 60')).toBeTruthy();
    meetingsList.mockClear();
    // Back into view: one page of 50 (the most one asks for), then the 10 more that were on screen.
    setVisibility('visible');
    await waitFor(() => expect(meetingsList).toHaveBeenCalledTimes(2));
    expect(meetingsList.mock.calls).toEqual([[{ project: undefined, q: undefined, limit: 50 }], [{ project: undefined, q: undefined, before: '50', limit: 10 }]]);
    expect(screen.getByText('Example meeting 60')).toBeTruthy();
    expect(screen.queryByText('Example meeting 61')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('a new search keeps the last rows on screen, dimmed and busy, until its own answer comes', async () => {
    let answer: (l: MeetingsList) => void = () => undefined;
    const meetingsList = vi.fn(async (q: { q?: string } = {}) => (q.q ? new Promise<MeetingsList>((r) => (answer = r)) : list([meeting(1), meeting(2)])));
    const { router } = open('/meetings', meetingsApi({ meetingsList }));
    await screen.findByText('Example meeting 1');
    act(() => router.getState().navigate('/meetings?q=quote', { replace: true }));
    await waitFor(() => expect(meetingsList).toHaveBeenLastCalledWith({ project: undefined, q: 'quote', limit: 30 }));
    const kept = screen.getByText('Example meeting 1');
    expect(kept.closest('[aria-busy="true"]')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Actions for Example meeting 1' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => answer(list([meeting(3)])));
    expect(await screen.findByText('Example meeting 3')).toBeTruthy();
    expect(screen.queryByText('Example meeting 1')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('coming back from a meeting brings back as many rows as were shown, and the scroll it opened at', async () => {
    const meetingsList = vi.fn(async (q: { before?: string; limit?: number } = {}) => {
      const from = q.before ? Number(q.before) : 0;
      const n = Math.min(q.limit ?? 30, 70 - from);
      return list(
        Array.from({ length: n }, (_, i) => meeting(from + i + 1)),
        { next: from + n < 70 ? String(from + n) : null },
      );
    });
    open('/meetings', meetingsApi({ meetingsList }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Example meeting 60')).toBeTruthy();
    // The shell's box scrolls (jsdom has no styles to say so).
    const box = screen.getByRole('main');
    box.style.overflowY = 'auto';
    let top = 0;
    Object.defineProperty(box, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    top = 1840;
    fireEvent.click(document.querySelector(`[data-meeting="${mid(45)}"] a`) as HTMLAnchorElement);
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly sync' })).toBeTruthy();
    top = 0;
    meetingsList.mockClear();
    fireEvent.click(back());
    expect(await screen.findByText('Example meeting 60')).toBeTruthy();
    expect(meetingsList.mock.calls).toEqual([[{ project: undefined, q: undefined, limit: 50 }], [{ project: undefined, q: undefined, before: '50', limit: 10 }]]);
    expect(top).toBe(1840);
    Reflect.deleteProperty(box, 'scrollTop');
  });

  it('Delete asks nothing: the row leaves with a 5 s Undo, and the DELETE goes when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingDelete = vi.fn(async () => ({ ok: true as const }));
    open('/meetings', meetingsApi({ meetingDelete }));
    await menu('Example meeting 1', 'Delete');
    expect(screen.queryByText('Example meeting 1')).toBeNull();
    expect(screen.getByText('Deleted: Example meeting 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Example meeting 1')).toBeTruthy();
    await flush(6_000);
    expect(meetingDelete).not.toHaveBeenCalled();

    await menu('Example meeting 1', 'Delete');
    await flush(5_100);
    expect(meetingDelete).toHaveBeenCalledWith(mid(1), expect.any(String));
    expect(screen.queryByText('Example meeting 1')).toBeNull();
  });

  it('a held delete that fails brings the row back with Not saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingDelete = vi.fn(async (): Promise<never> => {
      throw new ApiError('internal', 'The meeting could not be deleted.', 500);
    });
    open('/meetings', meetingsApi({ meetingDelete }));
    await menu('Example meeting 1', 'Delete');
    await flush(5_100);
    expect(await screen.findByText('Example meeting 1')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Not saved. The meeting could not be deleted.');
    // It stays with the list: a meeting opened next does not carry it.
    fireEvent.click(document.querySelector(`[data-meeting="${mid(2)}"] a`) as HTMLAnchorElement);
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly sync' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the states', () => {
  const failing = (e: ApiError) => meetingsApi({ meetingsList: vi.fn(async () => Promise.reject(e)), meetingGet: vi.fn(async () => Promise.reject(e)) });

  it('shows the switch-off sentence with its command in mono', async () => {
    for (const path of ['/meetings', `/meetings?id=${ID}`]) {
      const { unmount } = open(path, failing(new ApiError('forbidden', 'Meetings are off. Turn them on at your Mac: jantar meetings on', 403)));
      expect(await screen.findByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
      const code = await screen.findByText('jantar meetings on');
      expect(code.tagName).toBe('CODE');
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      unmount();
    }
  });

  it('shows the broken sentence as it came, with no Try again', async () => {
    const sentence = 'Meetings data could not be opened. The file is untouched. Move meetings.db aside at your Mac to start again (docs/extension.md).';
    for (const path of ['/meetings', `/meetings?id=${ID}`]) {
      const { unmount } = open(path, failing(new ApiError('meetings_unavailable', sentence, 503)));
      expect(await screen.findByText(sentence)).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      unmount();
    }
  });

  it('says a read-only device needs control, in Meetings words', async () => {
    for (const path of ['/meetings', `/meetings?id=${ID}`]) {
      const { unmount } = open(path, failing(new ApiError('forbidden', 'this device does not have the control scope', 403)));
      expect(await screen.findByText('This device can read sessions only. Meetings need control access: pair it again from your Mac.')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      unmount();
    }
  });

  it("shows the daemon's sentence, or Couldn't load, with Try again", async () => {
    const api = failing(new ApiError('internal', '', 500));
    open('/meetings', api);
    expect(await screen.findByText("Couldn't load. Try again.")).toBeTruthy();
    (api.meetingsList as ReturnType<typeof vi.fn>).mockImplementation(async () => list([meeting(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Example meeting 1')).toBeTruthy();
  });

  it('keeps the last list offline, with writes off and the reason; the search and chips wait for the Mac', async () => {
    open('/meetings', meetingsApi(), { state: LIFE, status: 'offline' });
    expect(await screen.findByText('Example meeting 1')).toBeTruthy();
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Actions for Example meeting 1' }) as HTMLButtonElement).disabled).toBe(true);
    // A new search or project would drop the list for one the Mac cannot answer.
    expect((screen.getByLabelText('Search meetings') as HTMLInputElement).disabled).toBe(true);
    const chips = await screen.findByRole('group', { name: 'Filter by project' });
    await waitFor(() => expect(within(chips).getAllByRole('button').length).toBeGreaterThan(1));
    for (const chip of within(chips).getAllByRole('button')) expect((chip as HTMLButtonElement).disabled, chip.textContent ?? '').toBe(true);
  });

  it('keeps the meeting offline, with every write off and the reason', async () => {
    const { unmount } = open(`/meetings?id=${ID}`, meetingsApi(), { state: LIFE, status: 'offline' });
    const items = await screen.findByRole('region', { name: 'Action items' });
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
    const add = (await within(items).findByRole('button', { name: 'Add to Acme site: Send the revised quote' })) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect((within(items).getByRole('button', { name: 'Remove from todos: Book the review room' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Weekly sync' }));
    expect((await screen.findByRole('menuitem', { name: 'Edit' })).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('aria-disabled')).toBe('true');
    // The text export needs nothing from the Mac.
    expect(screen.getByRole('menuitem', { name: 'Export text' }).getAttribute('aria-disabled')).toBeNull();
    unmount();

    const none = detail({ summary: { state: 'none', reason: 'Too little was said for a summary.', decisions: [], items: [], text: undefined } });
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => none) }), { status: 'offline' });
    expect(((await screen.findByRole('button', { name: 'Summarize' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Offline: changes need your Mac')).toBeTruthy();
  });

  it('says a meeting that is gone is gone, under the Meetings heading', async () => {
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => Promise.reject(new ApiError('not_found', 'no such meeting', 404))) }));
    expect(await screen.findByText('That meeting is no longer here.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
    expect(back().getAttribute('href')).toBe('/meetings');
  });

  it('shows the heading while the meeting loads', async () => {
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(() => new Promise<never>(() => undefined)) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Meetings' })).toBeTruthy();
  });
});

describe('the 10 s ask-again', () => {
  it('asks for the running line alone every 10 s while it shows and the page is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live = meeting(0, { endedAt: null, summary: 'none', lines: 3, shots: 2 });
    const meetingsList = vi.fn(async () => list([live, meeting(1)], { running: live }));
    open('/meetings', meetingsApi({ meetingsList }));
    expect(await screen.findByText('3 lines · 2 screenshots')).toBeTruthy();
    expect(meetingsList).toHaveBeenCalledTimes(1);
    live = { ...live, lines: 4 };
    await flush(POLL_MS);
    // One row: the pages on screen are not asked for again.
    await waitFor(() => expect(meetingsList).toHaveBeenCalledTimes(2));
    expect(meetingsList).toHaveBeenLastCalledWith({ limit: 1 });
    expect(await screen.findByText('4 lines · 2 screenshots')).toBeTruthy();
    expect(screen.getByText('Example meeting 1')).toBeTruthy();
    setVisibility('hidden');
    await flush(POLL_MS * 3);
    expect(meetingsList).toHaveBeenCalledTimes(2);
    // Back in view: the list's own reload at once, then the line every 10 s again.
    setVisibility('visible');
    await waitFor(() => expect(meetingsList).toHaveBeenCalledTimes(3));
    expect(meetingsList).toHaveBeenLastCalledWith({ project: undefined, q: undefined, limit: 30 });
    await flush(POLL_MS);
    await waitFor(() => expect(meetingsList).toHaveBeenCalledTimes(4));
    expect(meetingsList).toHaveBeenLastCalledWith({ limit: 1 });
  });

  it('asks nothing while the Mac cannot be reached, and again once it can', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const live = meeting(0, { endedAt: null, summary: 'none' });
    const meetingsList = vi.fn(async () => list([live], { running: live }));
    const first = open('/meetings', meetingsApi({ meetingsList }), { status: 'offline' });
    await screen.findByText(/^Meeting running/);
    await flush(POLL_MS * 3);
    expect(meetingsList).toHaveBeenCalledTimes(1);
    act(() => first.store.getState().setConn({ status: 'live', lastOkAt: NOW }));
    await flush(POLL_MS);
    await waitFor(() => expect(meetingsList).toHaveBeenCalledTimes(2));
    first.unmount();

    const d = detail({ meeting: { endedAt: null, summary: 'none' }, summary: { state: 'none', decisions: [], items: [], text: undefined } });
    const meetingGet = vi.fn(async () => d);
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet }), { status: 'offline' });
    await screen.findByText('The summary comes after the meeting ends.');
    await flush(POLL_MS * 3);
    expect(meetingGet).toHaveBeenCalledTimes(1);
  });

  it('does not ask again while nothing runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = meetingsApi();
    open('/meetings', api);
    await screen.findByText('Example meeting 1');
    await flush(POLL_MS * 3);
    expect(api.meetingsList).toHaveBeenCalledTimes(1);
  });

  it("asks for an open meeting's page every 10 s while visible, and stops once it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let d = detail({ meeting: { endedAt: null, summary: 'none', lines: 3 }, summary: { state: 'none', decisions: [], items: [], text: undefined } });
    const meetingGet = vi.fn(async () => d);
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet }));
    expect(await screen.findByText('The summary comes after the meeting ends.')).toBeTruthy();
    expect(screen.getByText(/^Running · 3 lines · 1 screenshot$/)).toBeTruthy();
    d = detail({ meeting: { endedAt: null, summary: 'none', lines: 4 }, summary: { state: 'none', decisions: [], items: [], text: undefined }, lines: [...D.lines, { id: 'a1b2c3d4-4', at: ago(-50), speaker: 'Sam', text: 'One more thing.' }] });
    await flush(POLL_MS);
    expect(await screen.findByText('One more thing.')).toBeTruthy();
    expect(meetingGet).toHaveBeenCalledTimes(2);
    setVisibility('hidden');
    await flush(POLL_MS * 2);
    expect(meetingGet).toHaveBeenCalledTimes(2);
    setVisibility('visible');
    await waitFor(() => expect(meetingGet).toHaveBeenCalledTimes(3));

    d = { ...d, meeting: { ...d.meeting, endedAt: ago(-60) }, summary: { ...d.summary, state: 'queued' } };
    await flush(POLL_MS);
    expect(await screen.findByText('Writing the summary…')).toBeTruthy();
    const calls = meetingGet.mock.calls.length;
    await flush(POLL_MS * 3);
    expect(meetingGet).toHaveBeenCalledTimes(calls);
  });
});

describe('the meeting page', () => {
  it("wraps a long name instead of cutting it: it shows in full nowhere else on the page", async () => {
    const name = 'Quarterly planning with the platform and design teams';
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => detail({ meeting: { name } })) }));
    const h1 = await screen.findByRole('heading', { level: 1, name });
    expect(within(h1).getByText(name).className).toContain('whitespace-normal');
  });

  it('shows the meeting: when and where, who, summary, decisions, items and transcript', async () => {
    const api = meetingsApi();
    open(`/meetings?id=${ID}`, api, { state: LIFE });
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekly sync' })).toBeTruthy();
    const day = new Date(D.meeting.startedAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
    expect(screen.getByText(`${day} · ${hm(D.meeting.startedAt)} to ${hm(D.meeting.endedAt as string)} · Google Meet`)).toBeTruthy();
    expect(screen.getByText('Acme site · Sam, Priya')).toBeTruthy();
    expect(screen.getByText(D.summary.text as string).className).toContain('whitespace-pre-wrap');
    const decisions = screen.getByRole('region', { name: 'Decisions' });
    expect(within(decisions).getAllByRole('listitem').map((li) => li.textContent)).toEqual(D.summary.decisions);
    const items = screen.getByRole('region', { name: 'Action items' });
    expect(await within(items).findByRole('button', { name: 'Add to Acme site: Send the revised quote' })).toBeTruthy();
    expect(within(items).getByText('In todos')).toBeTruthy();
    expect(within(items).getByRole('button', { name: 'Remove from todos: Book the review room' })).toBeTruthy();
    const transcript = screen.getByRole('list', { name: 'Transcript' });
    const turns = [...transcript.querySelectorAll('[data-turn]')].map((t) => t.textContent);
    expect(turns).toEqual([
      `Sam${hm(D.lines[0]!.at)}So the plan for Friday is to ship the new site.`,
      `Priya${hm(D.lines[1]!.at)}Then I will update the quote today.`,
      `You${hm(D.lines[2]!.at)}Sounds good, I will book the room.`,
    ]);
    // The screenshot at 10:05 sits between Priya's turn (10:03) and yours (10:06).
    const order = [...transcript.children].map((li) => (li.querySelector('figure') ? 'shot' : li.matches('[data-turn]') ? 'turn' : li.textContent));
    expect(order).toEqual(['turn', 'turn', 'shot', 'turn']);
    expect(back().getAttribute('href')).toBe('/meetings');
  });

  it('keeps the filters on the way back', async () => {
    open(`/meetings?project=none&q=quote&id=${ID}`, meetingsApi());
    await screen.findByRole('heading', { level: 1, name: 'Weekly sync' });
    expect(back().getAttribute('href')).toBe('/meetings?project=none&q=quote');
  });

  it('says what each summary state is, with Summarize and Try again', async () => {
    const none = { decisions: [], items: [], text: undefined };
    const cases: [MeetingDetail, string, string | null][] = [
      [detail({ summary: { ...none, state: 'queued' } }), 'Writing the summary…', null],
      [detail({ summary: { ...none, state: 'running' } }), 'Writing the summary…', null],
      [detail({ summary: { ...none, state: 'failed', reason: 'Claude did not answer in time.' } }), 'Claude did not answer in time.', 'Try again'],
      [detail({ summary: { ...none, state: 'none', reason: 'Too little was said for a summary.' } }), 'Too little was said for a summary.', 'Summarize'],
      [detail({ summary: { ...none, state: 'none' }, lines: [] }), 'No transcript: notes were not started.', null],
      [detail({ meeting: { endedAt: null }, summary: { ...none, state: 'none' } }), 'The summary comes after the meeting ends.', null],
      // Opened by a screenshot before Start: no notes, so no summary to wait for.
      [detail({ meeting: { endedAt: null, notes: false, lines: 0 }, summary: { ...none, state: 'none' }, lines: [] }), 'No transcript: notes were not started.', null],
    ];
    for (const [d, says, button] of cases) {
      const meetingSummarize = vi.fn(async () => ({ ok: true as const }));
      const api = meetingsApi({ meetingGet: vi.fn(async () => d), meetingSummarize });
      const { unmount } = open(`/meetings?id=${ID}`, api);
      const summary = await screen.findByRole('region', { name: 'Summary' });
      expect(within(summary).getByText(says)).toBeTruthy();
      // Said to a screen reader when it changes.
      expect(within(summary).getByText(says).closest('[role="status"]')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Decisions' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Action items' })).toBeNull();
      if (button) {
        fireEvent.click(within(summary).getByRole('button', { name: button }));
        await waitFor(() => expect(meetingSummarize).toHaveBeenCalledWith(ID, expect.any(String)));
        await waitFor(() => expect(api.meetingGet).toHaveBeenCalledTimes(2));
      } else {
        expect(within(summary).queryByRole('button')).toBeNull();
      }
      unmount();
    }
  });

  it('says the summary is being written once Summarize is taken, until the meeting comes back', async () => {
    const none = { decisions: [], items: [], text: undefined };
    let answer: (d: MeetingDetail) => void = () => undefined;
    const meetingGet = vi.fn(async () => detail({ summary: { ...none, state: 'none', reason: 'Too little was said for a summary.' } }));
    const meetingSummarize = vi.fn(async () => ({ ok: true as const }));
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet, meetingSummarize }));
    const summary = await screen.findByRole('region', { name: 'Summary' });
    meetingGet.mockImplementation(
      () =>
        new Promise<MeetingDetail>((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(await within(summary).findByRole('button', { name: 'Summarize' }));
    expect(await within(summary).findByText('Writing the summary…')).toBeTruthy();
    expect(within(summary).queryByRole('button')).toBeNull();
    await waitFor(() => expect(meetingGet).toHaveBeenCalledTimes(2));
    // The run could not even start: the meeting comes back failed already, and says so.
    await act(async () => answer(detail({ summary: { ...none, state: 'failed', reason: 'No account could write the summary.' } })));
    expect(await within(summary).findByText('No account could write the summary.')).toBeTruthy();
    expect(within(summary).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(meetingSummarize).toHaveBeenCalledTimes(1);
  });

  it('shows a refused Summarize as Not saved', async () => {
    const d = detail({ summary: { state: 'none', reason: 'Too little was said for a summary.', decisions: [], items: [], text: undefined } });
    const meetingSummarize = vi.fn(async (): Promise<never> => {
      throw new ApiError('forbidden', 'Summaries are off while Jantar is read-only.', 403);
    });
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => d), meetingSummarize }));
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved. Summaries are off while Jantar is read-only.');
  });

  it('hides Decisions and Action items when the summary has none', async () => {
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => detail({ summary: { decisions: [], items: [] } })) }), { state: LIFE });
    await screen.findByText(D.summary.text as string);
    expect(screen.queryByRole('region', { name: 'Decisions' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Action items' })).toBeNull();
  });
});

describe('action items', () => {
  it('adds one to the project todos and reads the meeting again', async () => {
    const meetingItemTodo = vi.fn(async () => ({ id: mid(50) }));
    const api = meetingsApi({ meetingItemTodo });
    open(`/meetings?id=${ID}`, api, { state: LIFE });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Acme site: Send the revised quote' }));
    await waitFor(() => expect(meetingItemTodo).toHaveBeenCalledWith(ID, 0, expect.any(String)));
    await waitFor(() => expect(api.meetingGet).toHaveBeenCalledTimes(2));
  });

  it('shows an added item in todos until the meeting comes back with it, so it cannot be added twice', async () => {
    let answer: (d: MeetingDetail) => void = () => undefined;
    const meetingGet = vi.fn(async () => D);
    const meetingItemTodo = vi.fn(async () => ({ id: mid(50) }));
    open(`/meetings?id=${ID}`, meetingsApi({ meetingGet, meetingItemTodo }), { state: LIFE });
    const items = await screen.findByRole('region', { name: 'Action items' });
    const name = 'Add to Acme site: Send the revised quote';
    meetingGet.mockImplementation(
      () =>
        new Promise<MeetingDetail>((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(await within(items).findByRole('button', { name }));
    await waitFor(() => expect(within(items).queryByRole('button', { name })).toBeNull());
    expect(within(items).getAllByText('In todos')).toHaveLength(2);
    await waitFor(() => expect(meetingGet).toHaveBeenCalledTimes(2));
    await act(async () => answer(detail({ summary: { items: D.summary.items.map((it, i) => (i === 0 ? { ...it, todoId: mid(50) } : it)) } })));
    expect(within(items).getAllByText('In todos')).toHaveLength(2);
    expect(within(items).queryByRole('button', { name })).toBeNull();
    expect(meetingItemTodo).toHaveBeenCalledTimes(1);
  });

  it('says Add to todos without a project, and shows neither button while Todos are off', async () => {
    const noProject = detail({ meeting: { projectId: undefined, projectName: undefined } });
    const { unmount } = open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => noProject) }), { state: LIFE });
    expect(await screen.findByRole('button', { name: 'Add to todos: Send the revised quote' })).toBeTruthy();
    unmount();

    open(`/meetings?id=${ID}`, meetingsApi());
    const items = await screen.findByRole('region', { name: 'Action items' });
    expect(within(items).getByText('Send the revised quote')).toBeTruthy();
    expect(within(items).queryByRole('button')).toBeNull();
  });

  it('Remove is held under Undo; Add while it waits takes it back; the DELETE goes when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingItemUntodo = vi.fn(async () => ({ ok: true as const }));
    const meetingItemTodo = vi.fn(async () => ({ id: mid(50) }));
    const api = meetingsApi({ meetingItemUntodo, meetingItemTodo });
    open(`/meetings?id=${ID}`, api, { state: LIFE });
    const items = await screen.findByRole('region', { name: 'Action items' });
    fireEvent.click(await within(items).findByRole('button', { name: 'Remove from todos: Book the review room' }));
    expect(screen.getByText('Removed from todos')).toBeTruthy();
    expect(within(items).queryByText('In todos')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(within(items).getByText('In todos')).toBeTruthy();

    fireEvent.click(within(items).getByRole('button', { name: 'Remove from todos: Book the review room' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Add to Acme site: Book the review room' }));
    expect(within(items).getByText('In todos')).toBeTruthy();
    await flush(6_000);
    expect(meetingItemUntodo).not.toHaveBeenCalled();
    expect(meetingItemTodo).not.toHaveBeenCalled();

    fireEvent.click(within(items).getByRole('button', { name: 'Remove from todos: Book the review room' }));
    await flush(5_100);
    expect(meetingItemUntodo).toHaveBeenCalledWith(ID, 1, expect.any(String));
    await waitFor(() => expect(api.meetingGet).toHaveBeenCalledTimes(2));
  });

  it('a Remove that fails puts the todo back with Not saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingItemUntodo = vi.fn(async (): Promise<never> => {
      throw new ApiError('network', 'offline', 0);
    });
    open(`/meetings?id=${ID}`, meetingsApi({ meetingItemUntodo }), { state: LIFE });
    const items = await screen.findByRole('region', { name: 'Action items' });
    fireEvent.click(await within(items).findByRole('button', { name: 'Remove from todos: Book the review room' }));
    await flush(5_100);
    expect(await within(items).findByText('In todos')).toBeTruthy();
    expect(within(items).getByRole('alert').textContent).toMatch(/^Not saved\. Could not reach the Mac/);
  });

  it('a Remove held on a page that was left still shows on that page opened again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingItemUntodo = vi.fn(async () => ({ ok: true as const }));
    const meetingGet = vi.fn(async () => D);
    const api = meetingsApi({ meetingItemUntodo, meetingGet, meetingsList: vi.fn(async () => list([D.meeting])) });
    const { store } = open(`/meetings?id=${ID}`, api, { state: LIFE });
    const remove = 'Remove from todos: Book the review room';
    const add = 'Add to Acme site: Book the review room';
    const row = () => document.querySelector<HTMLAnchorElement>(`[data-meeting="${ID}"] a`);
    const reopen = async () => {
      fireEvent.click(back());
      await waitFor(() => expect(row()).not.toBeNull());
      fireEvent.click(row() as HTMLAnchorElement);
      return screen.findByRole('region', { name: 'Action items' });
    };

    fireEvent.click(await within(await screen.findByRole('region', { name: 'Action items' })).findByRole('button', { name: remove }));
    let items = await reopen();
    // Opened again under the same Undo: the item shows removed, and Undo there puts it back.
    expect(screen.getByText('Removed from todos')).toBeTruthy();
    expect(within(items).getByRole('button', { name: add })).toBeTruthy();
    expect(within(items).queryByText('In todos')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(within(items).getByText('In todos')).toBeTruthy();
    await flush(6_000);
    expect(meetingItemUntodo).not.toHaveBeenCalled();

    // Left again and the Undo runs out: the removal is sent once, and the item stays removed
    // until the meeting comes back without the todo (Life's tick).
    fireEvent.click(within(items).getByRole('button', { name: remove }));
    items = await reopen();
    await flush(5_100);
    await waitFor(() => expect(meetingItemUntodo).toHaveBeenCalledTimes(1));
    expect(within(items).queryByText('In todos')).toBeNull();
    expect((within(items).getByRole('button', { name: add }) as HTMLButtonElement).disabled).toBe(true);
    meetingGet.mockImplementation(async () => detail({ summary: { items: D.summary.items.map((it) => ({ ...it, todoId: undefined })) } }));
    act(() => store.setState((s) => ({ state: { ...s.state, lifeTick: (s.state.lifeTick ?? 0) + 1 } })));
    await waitFor(() => expect((within(items).getByRole('button', { name: add }) as HTMLButtonElement).disabled).toBe(false));
    expect(meetingItemUntodo).toHaveBeenCalledTimes(1);
  });

  it('an Add that Todos refuse says why', async () => {
    const meetingItemTodo = vi.fn(async (): Promise<never> => {
      throw new ApiError('forbidden', 'Todos are off. Turn them on at your Mac: jantar life on todos', 403);
    });
    open(`/meetings?id=${ID}`, meetingsApi({ meetingItemTodo }), { state: LIFE });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Acme site: Send the revised quote' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved. Todos are off. Turn them on at your Mac: jantar life on todos');
  });
});

describe('screenshots (MW3)', () => {
  it('keep a 16:10 box until they come into view, then load as a blob from the API', async () => {
    const observers = fakeObservers();
    const api = meetingsApi();
    const { unmount } = open(`/meetings?id=${ID}`, api);
    // The shells scroll <main> (or a box in it), not the page: "near the view" is measured there.
    const main = screen.getByRole('main');
    main.style.overflowY = 'auto';
    const figure = (await screen.findByRole('list', { name: 'Transcript' })).querySelector('figure') as HTMLElement;
    expect(figure.querySelector('[data-placeholder]')?.className).toContain('aspect-16/10');
    expect(within(figure).getByText(hm(D.shots[0]!.at))).toBeTruthy();
    expect(api.meetingShot).not.toHaveBeenCalled();
    expect(observers.inits()).toEqual([{ root: main, rootMargin: '400px 0px' }]);

    observers.show();
    await waitFor(() => expect(api.meetingShot).toHaveBeenCalledWith(ID, SHOT, { signal: expect.any(AbortSignal) }));
    const img = (await within(figure).findByRole('img', { name: `Screenshot ${hm(D.shots[0]!.at)}` })) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(urls.made[0]);
    expect(urls.create).toHaveBeenCalledWith(expect.any(Blob));
    expect(figure.querySelector('[data-placeholder]')).toBeNull();

    unmount();
    for (const u of urls.made) expect(urls.revoke).toHaveBeenCalledWith(u);
  });

  it('open in the viewer with the bytes already here, its time and Close', async () => {
    const api = meetingsApi();
    open(`/meetings?id=${ID}`, api);
    const at = hm(D.shots[0]!.at);
    await screen.findByRole('img', { name: `Screenshot ${at}` });
    fireEvent.click(screen.getByRole('button', { name: `Open the screenshot from ${at}` }));
    const viewer = await screen.findByRole('dialog', { name: `Screenshot ${at}` });
    expect(within(viewer).getByRole('img', { name: `Screenshot ${at}` }).getAttribute('src')).toBe(urls.made[1]);
    expect(api.meetingShot).toHaveBeenCalledTimes(1);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[1]);
    expect(urls.revoke).not.toHaveBeenCalledWith(urls.made[0]);
  });

  it('say when one did not load, and try again', async () => {
    let fail = true;
    const meetingShot = vi.fn(async () => {
      if (fail) throw new ApiError('internal', 'no', 500);
      return new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    });
    open(`/meetings?id=${ID}`, meetingsApi({ meetingShot }));
    expect(await screen.findByText("Couldn't load the screenshot.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: `Screenshot ${hm(D.shots[0]!.at)}` })).toBeTruthy();
  });

  it('one that failed while the Mac could not be reached loads again by itself once it can', async () => {
    let fail = true;
    const meetingShot = vi.fn(async () => {
      if (fail) throw new ApiError('network', 'offline', 0);
      return new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    });
    const { store } = open(`/meetings?id=${ID}`, meetingsApi({ meetingShot }), { status: 'offline' });
    expect(await screen.findByText("Couldn't load the screenshot.")).toBeTruthy();
    expect(meetingShot).toHaveBeenCalledTimes(1);
    fail = false;
    act(() => store.getState().setConn({ status: 'live', lastOkAt: NOW }));
    expect(await screen.findByRole('img', { name: `Screenshot ${hm(D.shots[0]!.at)}` })).toBeTruthy();
    expect(meetingShot).toHaveBeenCalledTimes(2);
    // Losing the Mac again changes nothing on a screenshot that is here.
    act(() => store.getState().setConn({ status: 'offline', lastOkAt: NOW }));
    act(() => store.getState().setConn({ status: 'live', lastOkAt: NOW }));
    expect(meetingShot).toHaveBeenCalledTimes(2);
  });

  it('say to wait when the Mac has sent too many screenshot bytes lately', async () => {
    const meetingShot = vi.fn(async (): Promise<never> => {
      throw new ApiError('rate_limited', 'too many screenshot bytes in the last 10 minutes; wait a little and try again', 429);
    });
    open(`/meetings?id=${ID}`, meetingsApi({ meetingShot }));
    expect(await screen.findByText('Too many screenshots loaded in the last 10 minutes. Wait a little and try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('open in the viewer before the transcript has them, which asks for them itself', async () => {
    fakeObservers();
    const api = meetingsApi();
    open(`/meetings?id=${ID}`, api);
    const at = hm(D.shots[0]!.at);
    fireEvent.click(await screen.findByRole('button', { name: `Open the screenshot from ${at}` }));
    const viewer = await screen.findByRole('dialog', { name: `Screenshot ${at}` });
    const img = await within(viewer).findByRole('img', { name: `Screenshot ${at}` });
    expect(api.meetingShot).toHaveBeenCalledTimes(1);
    expect(api.meetingShot).toHaveBeenCalledWith(ID, SHOT, { signal: expect.any(AbortSignal) });
    expect(img.getAttribute('src')).toBe(urls.made[0]);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(urls.revoke).toHaveBeenCalledWith(urls.made[0]);
  });

  it('come over /v1, which the service worker never caches', () => {
    expect(ROUTES.meetingShot.path.startsWith('/v1/')).toBe(true);
    const sw = readFileSync(join(__dirname, '..', 'sw', 'sw.js'), 'utf8');
    expect(sw).toContain("pathname.startsWith('/v1/')");
  });
});

describe('MW2: meeting text renders as text', () => {
  it('shows hostile names, people, summaries, decisions, items, speakers and captions literally', async () => {
    const d = detail({
      meeting: { name: EVIL, people: EVIL, projectName: EVIL },
      summary: { text: `**bold** ${EVIL}`, decisions: [EVIL], items: [{ title: EVIL, owner: 'Sam' }] },
      lines: [{ id: 'x-1', at: D.lines[0]!.at, speaker: EVIL, text: EVIL }],
      shots: [],
    });
    const { unmount } = open(`/meetings?id=${ID}`, meetingsApi({ meetingGet: vi.fn(async () => d) }), { state: LIFE });
    expect(await screen.findByRole('heading', { level: 1, name: EVIL })).toBeTruthy();
    expect(screen.getByText(`**bold** ${EVIL}`)).toBeTruthy();
    expect(screen.getByText(`${EVIL} · ${EVIL}`)).toBeTruthy();
    expect(screen.getAllByText(EVIL).length).toBeGreaterThanOrEqual(4);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('strong, b')).toBeNull();
    unmount();

    open('/meetings', meetingsApi({ meetingsList: vi.fn(async () => list([meeting(1, { name: EVIL, gist: EVIL, projectName: EVIL })])) }));
    expect(await screen.findAllByText(EVIL)).toHaveLength(3);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

describe('Edit', () => {
  async function editSheet(api: Api, state = LIFE) {
    const { unmount } = open(`/meetings?id=${ID}`, api, { state });
    await menu('Weekly sync', 'Edit');
    return { sheet: await screen.findByRole('dialog', { name: 'Edit meeting' }), unmount };
  }

  it('sends only what changed: a trimmed name, no project as null, cleared people as null', async () => {
    const meetingUpdate = vi.fn(async () => ({ ok: true as const }));
    const api = meetingsApi({ meetingUpdate });
    const { sheet } = await editSheet(api);
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly sync');
    const select = within(sheet).getByLabelText('Project') as HTMLSelectElement;
    // Every project not done, paused ones too, as Todos' own sheet offers them.
    await waitFor(() => expect([...select.options].map((o) => o.textContent)).toEqual(['No project', 'Acme site', 'Example app', 'Old work']));
    expect(select.value).toBe(PROJECT);
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: '  Launch review ' } });
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.change(within(sheet).getByLabelText('People'), { target: { value: ' ' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(meetingUpdate).toHaveBeenCalledWith(ID, { name: 'Launch review', projectId: null, people: null }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(api.meetingGet).toHaveBeenCalledTimes(2));
  });

  it('offers auto todos only before the summary runs and with a project', async () => {
    const meetingUpdate = vi.fn(async () => ({ ok: true as const }));
    const before = detail({ summary: { state: 'queued', decisions: [], items: [], text: undefined } });
    let { sheet } = await editSheet(meetingsApi({ meetingGet: vi.fn(async () => before), meetingUpdate }));
    const auto = within(sheet).getByRole('checkbox', { name: "Action items go to this project's todos" }) as HTMLInputElement;
    expect(auto.checked).toBe(false);
    fireEvent.click(auto);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(meetingUpdate).toHaveBeenCalledWith(ID, { autoTodos: true }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // No project chosen: gone.
    await menu('Weekly sync', 'Edit');
    sheet = await screen.findByRole('dialog', { name: 'Edit meeting' });
    fireEvent.change(within(sheet).getByLabelText('Project'), { target: { value: '' } });
    expect(within(sheet).queryByRole('checkbox')).toBeNull();
  });

  it('has no auto todos while the summary runs or once it is done, and no Project while Todos are off', async () => {
    const done = await editSheet(meetingsApi());
    expect(within(done.sheet).queryByRole('checkbox')).toBeNull();
    done.unmount();
    const running = await editSheet(meetingsApi({ meetingGet: vi.fn(async () => detail({ summary: { state: 'running', decisions: [], items: [], text: undefined } })) }));
    expect(within(running.sheet).queryByRole('checkbox')).toBeNull();
    running.unmount();
    // A failed summary added nothing: Try again reads the switch as it is then.
    const failed = await editSheet(meetingsApi({ meetingGet: vi.fn(async () => detail({ summary: { state: 'failed', reason: 'The summary did not work. Try again.', decisions: [], items: [], text: undefined } })) }));
    expect(within(failed.sheet).getByRole('checkbox', { name: "Action items go to this project's todos" })).toBeTruthy();
    failed.unmount();
    const { sheet } = await editSheet(meetingsApi(), ON);
    expect(within(sheet).queryByLabelText('Project')).toBeNull();
    expect(within(sheet).getByLabelText('People')).toBeTruthy();
  });

  it('a failed save keeps the sheet open with Not saved', async () => {
    const meetingUpdate = vi.fn(async (): Promise<never> => {
      throw new ApiError('invalid_request', 'The name is too long.', 400);
    });
    const { sheet } = await editSheet(meetingsApi({ meetingUpdate }));
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Another name' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('Not saved. The name is too long.');
    expect((within(sheet).getByLabelText('Name') as HTMLInputElement).value).toBe('Another name');
  });
});

describe('Export text', () => {
  it('shares the Markdown file and points to the CLI for the screenshots', async () => {
    const share = vi.fn(async (_d: ShareData) => undefined);
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: ShareData) => Boolean(d.files?.length) });
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    open(`/meetings?id=${ID}`, meetingsApi());
    await menu('Weekly sync', 'Export text');
    const status = await screen.findByText(/^Text exported\./);
    expect(status.textContent).toBe(`Text exported. With the screenshots: jantar meetings export ${ID} at your Mac`);
    expect(within(status).getByText(`jantar meetings export ${ID}`).className).toContain('type-mono');
    const file = share.mock.calls[0]?.[0].files?.[0] as File;
    expect(file.name).toMatch(/^2026-10-(29|30|31)-weekly-sync\.md$/);
    expect(file.type).toBe('text/markdown');
    const md = await file.text();
    expect(md).toMatch(/^# Weekly sync\n/);
    expect(md).toContain(`*Screenshot ${hm(D.shots[0]!.at)}*`);
  });

  it('downloads it where the phone cannot share a file, revoking the link after', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });
    open(`/meetings?id=${ID}`, meetingsApi());
    await menu('Weekly sync', 'Export text');
    expect(await screen.findByText(/^Text exported\./)).toBeTruthy();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toMatch(/-weekly-sync\.md$/);
    const url = clicks[0]?.href as string;
    expect(urls.made).toContain(url);
    expect(document.querySelector('a[download]')).toBeNull();
    await flush(1_100);
    expect(urls.revoke).toHaveBeenCalledWith(url);
    // The line goes once there has been time to read the command.
    await flush(EXPORTED_MS);
    expect(screen.queryByText(/^Text exported\./)).toBeNull();
  });

  it('says nothing when the share sheet is closed', async () => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn(async () => Promise.reject(Object.assign(new Error('closed'), { name: 'AbortError' }))) });
    open(`/meetings?id=${ID}`, meetingsApi());
    await menu('Weekly sync', 'Export text');
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    expect(screen.queryByText(/^Text exported\./)).toBeNull();
  });
});

describe('Delete from the page', () => {
  it('goes back to the list at once, holds the delete there under Undo, then sends it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingDelete = vi.fn(async () => ({ ok: true as const }));
    const api = meetingsApi({ meetingDelete, meetingsList: vi.fn(async () => list([D.meeting, meeting(1)])) });
    const { router } = open(`/meetings?q=sync&id=${ID}`, api);
    await menu('Weekly sync', 'Delete');
    expect(router.getState().route).toEqual({ name: 'meetings', q: 'sync' });
    expect(await screen.findByText('Example meeting 1')).toBeTruthy();
    expect(screen.queryByText('Weekly sync')).toBeNull();
    expect(screen.getByText('Deleted: Weekly sync')).toBeTruthy();
    expect(meetingDelete).not.toHaveBeenCalled();
    await flush(5_100);
    expect(meetingDelete).toHaveBeenCalledWith(ID, expect.any(String));
  });

  it('Undo brings it back on the list, and sends nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const meetingDelete = vi.fn(async () => ({ ok: true as const }));
    open(`/meetings?id=${ID}`, meetingsApi({ meetingDelete, meetingsList: vi.fn(async () => list([D.meeting])) }));
    await menu('Weekly sync', 'Delete');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Weekly sync')).toBeTruthy();
    await flush(6_000);
    expect(meetingDelete).not.toHaveBeenCalled();
  });
});
