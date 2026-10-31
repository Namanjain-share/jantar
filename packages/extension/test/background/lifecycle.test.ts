/**
 * MX5, the worker's part, and every lifecycle row of spec 3.9: one meeting
 * per tab and call. Start opens it (the same client id when a screenshot
 * made it; a new one after a 409), End ends it, a `call` with `left` or a
 * new Meet code ends it with `left`, a closed tab with `closed`; a page
 * load, the waiting room, a title change or the keep-alive never end one.
 * The keep-alive is one empty lines post a minute at most; its 404 clears
 * the meeting and stops notes, as a lines post's does.
 */
import { MEETING_MARKER } from '@jantar/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_ANSWER_MS } from '../../src/background/ctx.js';
import { MISMATCH, NOT_OPEN, NOT_RUNNING, NO_MEETING_TAB, JOIN_FIRST, PAIR_AGAIN } from '../../src/background/sentences.js';
import { TIMING } from '../../src/shared/wire.js';
import { MEET_CODE, PROJECT_ID, TEAMS_URL, UUID, daemonError, markerIn, setupWorker, watchConsole, type WorkerUnderTest } from './chrome.js';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole>;
afterEach(() => {
  // MP7: nothing of a meeting reached the console.
  if (watched) expect(markerIn(watched.text())).toBe(false);
  w?.close();
});

const start = (tabId: number, over: Record<string, unknown> = {}) => w.popup({ t: 'start', tabId, name: 'Weekly sync', autoTodos: false, ...over });
const call = (tabId: number, over: Record<string, unknown> = {}) => w.page(tabId, { t: 'call', site: 'meet', inCall: true, callKey: MEET_CODE, title: 'Weekly sync', ...over });

describe('Start', () => {
  it("opens the tab's meeting with captions on and the sheet's fields, then turns notes on in the page", async () => {
    w = setupWorker();
    watched = watchConsole();
    await w.meetTab(7, { title: `Weekly sync ${MEETING_MARKER}` });
    const done = await start(7, { name: `Planning ${MEETING_MARKER}`, projectId: PROJECT_ID, people: `Sam, Priya ${MEETING_MARKER}`, autoTodos: true });
    expect(done).toEqual({ ok: true });
    const [open] = w.daemon.of('open');
    expect(open?.clientId).toMatch(UUID);
    expect(open?.body).toEqual({ site: 'meet', name: `Planning ${MEETING_MARKER}`, projectId: PROJECT_ID, people: `Sam, Priya ${MEETING_MARKER}`, autoTodos: true, captions: true, at: w.clock.t });
    expect(w.toPage(7)).toEqual([{ t: 'capture', on: true }]);
    expect(w.tabState(7)).toMatchObject({ clientId: open?.clientId, name: `Planning ${MEETING_MARKER}`, notes: true, shots: 0 });
    expect(await call(7)).toEqual({ button: true, notes: true });
  });

  it('cleans the fields: the name from the page when blank, no blank people, no unknown project, auto todos only with a project', async () => {
    w = setupWorker();
    await w.meetTab(7, { title: '' });
    await start(7, { name: '  \n ', people: '   ', projectId: 'not-a-ulid', autoTodos: true });
    expect(w.daemon.of('open')[0]?.body).toEqual({ site: 'meet', name: 'Meet call', autoTodos: false, captions: true, at: w.clock.t });
    await w.meetTab(8, { url: TEAMS_URL, title: '\u2066Design review\u2069' });
    await start(8, { name: '', people: 'Alex\tand\u0007Sam\u0085and \u2068Priya\u2069 ' });
    expect(w.daemon.of('open')[1]?.body).toMatchObject({ site: 'teams', name: 'Design review', people: 'Alex and Sam and Priya' });
    await w.meetTab(9, { url: TEAMS_URL, title: '' });
    await start(9, { name: 'x'.repeat(300) });
    expect((w.daemon.of('open')[2]?.body as { name: string }).name).toHaveLength(120);
  });

  it('keeps the client id a screenshot already made, and turns notes on there', async () => {
    w = setupWorker();
    await w.meetTab(7);
    expect(await w.page(7, { t: 'shot' })).toEqual({ ok: true, text: 'Saved' });
    const made = w.daemon.of('open')[0];
    expect(made?.body).toMatchObject({ captions: false });
    expect(await start(7)).toEqual({ ok: true });
    const again = w.daemon.of('open')[1];
    expect(again?.clientId).toBe(made?.clientId);
    expect(again?.body).toMatchObject({ captions: true });
    expect(w.tabState(7)).toMatchObject({ clientId: made?.clientId, notes: true, shots: 1 });
  });

  it("gets a new client id when that client id's meeting has ended (409), and opens once more", async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.page(7, { t: 'shot' });
    const first = w.daemon.of('open')[0]?.clientId;
    w.daemon.on('open', daemonError(409, 'This meeting has ended. Start notes again from the Jantar icon.'), { status: 200, body: { id: '01JFZ8X8Y3T0V5G9WQK2M4N6SR' } });
    expect(await start(7)).toEqual({ ok: true });
    const [, ended, fresh] = w.daemon.of('open');
    expect(ended?.clientId).toBe(first);
    expect(fresh?.clientId).toMatch(UUID);
    expect(fresh?.clientId).not.toBe(first);
    expect(w.tabState(7)).toMatchObject({ clientId: fresh?.clientId, notes: true, shots: 0 });
  });

  it('a 409 on a new client id (the meetings cap) is shown, not retried', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.daemon.on('open', daemonError(409, 'You keep 5,000 meetings. Delete some in Jantar to start another.'));
    expect(await start(7)).toEqual({ ok: false, error: 'You keep 5,000 meetings. Delete some in Jantar to start another.' });
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(w.tabState(7)?.clientId).toBeUndefined();
  });

  it('says why it did not start: not running, Meetings off, a mismatch, unpaired', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.daemon.on('open', 'down');
    expect(await start(7)).toEqual({ ok: false, error: NOT_RUNNING });
    w.daemon.on('open', daemonError(403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'));
    expect(await start(7)).toEqual({ ok: false, error: 'Meetings are off. Turn them on at your Mac: jantar meetings on' });
    w.daemon.on('open', daemonError(400, 'body/name: Too big'));
    expect(await start(7)).toEqual({ ok: false, error: MISMATCH });
    expect(w.tabState(7)).toMatchObject({ notes: false });
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.toPage(7)).toEqual([]);
    w.daemon.on('open', daemonError(401, 'not paired'));
    expect(await start(7)).toEqual({ ok: false, error: PAIR_AGAIN });
    expect(await w.keys.get()).toBeNull();
    expect(w.toPage(7)).toEqual([{ t: 'button', on: false }]);
  });

  it("leaves nothing open when the tab's record went while the open was in flight", async () => {
    w = setupWorker();
    await w.meetTab(7);
    const held = w.daemon.hold('open');
    const started = start(7);
    await held.started;
    w.model.session.delete('tab:7');
    held.release();
    expect(await started).toEqual({ ok: false, error: NOT_OPEN });
    const [open] = w.daemon.of('open');
    expect(w.daemon.of('end')).toEqual([expect.objectContaining({ clientId: open?.clientId, body: { reason: 'closed', at: w.clock.t } })]);
    expect(w.toPage(7)).toEqual([]);
  });

  it('only in a call, and only on a tab the worker knows', async () => {
    w = setupWorker();
    await w.meetTab(7, { inCall: false });
    expect(await start(7)).toEqual({ ok: false, error: JOIN_FIRST });
    expect(await start(99)).toEqual({ ok: false, error: NO_MEETING_TAB });
    expect(w.daemon.of('open')).toEqual([]);
  });
});

describe('End', () => {
  it('stops notes, lets the lines in flight land, ends with reason user and clears the client id', async () => {
    // Real waits here: End holds for the page's lines answer (2 s at most).
    w = setupWorker({ deps: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } });
    await w.meetTab(7);
    await start(7);
    const clientId = w.tabState(7)?.clientId;
    const held = w.daemon.hold('lines');
    const lines = w.page(7, { t: 'lines', lines: [{ lineId: 'n0nce-1', rev: 1, speaker: 'Sam', text: 'Hello there', at: w.clock.t }] });
    await held.started;
    const ended = w.popup({ t: 'end', tabId: 7 });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.daemon.of('end')).toEqual([]);
    held.release();
    expect(await lines).toEqual({ ok: true });
    expect(await ended).toEqual({ ok: true });
    expect(w.daemon.ops()).toEqual(['open', 'lines', 'end']);
    expect(w.daemon.of('end')[0]).toMatchObject({ clientId, body: { reason: 'user', at: w.clock.t } });
    expect(w.toPage(7)).toEqual([{ t: 'capture', on: true }, { t: 'capture', on: false }]);
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.tabState(7)).toMatchObject({ notes: false, shots: 0 });
    expect(await call(7)).toEqual({ button: true, notes: false });
  });

  it('waits 2 s at most for a lines answer that does not come', async () => {
    w = setupWorker({ deps: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 40))) } });
    await w.meetTab(7);
    await start(7);
    const held = w.daemon.hold('lines');
    void w.page(7, { t: 'lines', lines: [] });
    await held.started;
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: true });
    expect(w.daemon.of('end')).toHaveLength(1);
    held.release();
  });

  it('is done when the daemon had already ended it (404); clears the meeting and says so when Jantar is down', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    w.daemon.on('end', daemonError(404, 'This meeting is not open in Jantar any more. Start notes again from the Jantar icon.'));
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: true });
    await start(7);
    w.daemon.on('end', 'down');
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: false, error: NOT_RUNNING });
    expect(w.tabState(7)?.clientId).toBeUndefined();
  });

  it('a page that never answers holds End 2 s at most', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    w.model.onTabMessage(7, () => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ended = w.popup({ t: 'end', tabId: 7 });
      await vi.advanceTimersByTimeAsync(PAGE_ANSWER_MS - 100);
      expect(w.daemon.of('end')).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      expect(await ended).toEqual({ ok: true });
      expect(w.daemon.of('end')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no meeting is nothing to do', async () => {
    w = setupWorker();
    await w.meetTab(7);
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: true });
    expect(w.daemon.of('end')).toEqual([]);
  });

  it('after End, Start or a screenshot makes a new meeting', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    await w.popup({ t: 'end', tabId: 7 });
    await start(7);
    const [a, b] = w.daemon.of('open');
    expect(b?.clientId).not.toBe(a?.clientId);
  });
});

describe('a call from the page', () => {
  it('with left (the 60-s grace ran out) stops notes and ends the meeting with left', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    const clientId = w.tabState(7)?.clientId;
    expect(await call(7, { inCall: false, left: true })).toEqual({ button: true, notes: false });
    expect(w.daemon.of('end')[0]).toMatchObject({ clientId, body: { reason: 'left' } });
    expect(w.toPage(7).at(-1)).toEqual({ t: 'capture', on: false });
    expect(w.tabState(7)).toMatchObject({ inCall: false, notes: false });
    expect(w.tabState(7)?.clientId).toBeUndefined();
  });

  it('with another Meet code ends the old meeting with left and keeps the new code with no meeting', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    const clientId = w.tabState(7)?.clientId;
    expect(await call(7, { callKey: 'xyz-abcd-efg' })).toEqual({ button: true, notes: false });
    expect(w.daemon.of('end')[0]).toMatchObject({ clientId, body: { reason: 'left' } });
    expect(w.tabState(7)).toMatchObject({ callKey: 'xyz-abcd-efg', inCall: true, notes: false });
    expect(w.tabState(7)?.clientId).toBeUndefined();
  });

  it('never ends a meeting on a page load, the waiting room, a title change or the keep-alive', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    // A reload: the page's first call, out of the call, then back in; a title change; the keep-alive a minute on.
    expect(await call(7, { inCall: false })).toEqual({ button: true, notes: true });
    expect(await call(7, { inCall: true })).toEqual({ button: true, notes: true });
    expect(await call(7, { title: 'Weekly sync (2)' })).toEqual({ button: true, notes: true });
    expect(w.tabState(7)).toMatchObject({ title: 'Weekly sync (2)', notes: true });
    w.clock.t += TIMING.keepAliveMs;
    expect(await call(7)).toEqual({ button: true, notes: true });
    expect(w.daemon.of('end')).toEqual([]);
    expect(w.daemon.of('lines')).toHaveLength(1);
  });

  it('on Teams, where the tab is the call, a call with no code never ends one', async () => {
    w = setupWorker();
    await w.meetTab(7, { url: TEAMS_URL });
    await start(7);
    expect(await w.page(7, { t: 'call', site: 'teams', inCall: true, callKey: null, title: 'Chat' })).toEqual({ button: true, notes: true });
    expect(w.daemon.of('end')).toEqual([]);
  });

  it('answers button only while paired', async () => {
    w = setupWorker({ paired: false });
    await w.meetTab(7);
    expect(await call(7)).toEqual({ button: false, notes: false });
  });
});

describe('the keep-alive', () => {
  it('is one empty lines post a minute at most, only for a tab in a call with a meeting', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await call(7);
    w.clock.t += TIMING.keepAliveMs;
    await call(7);
    expect(w.daemon.of('lines')).toEqual([]);
    await w.page(7, { t: 'shot' });
    const clientId = w.tabState(7)?.clientId;
    await call(7);
    expect(w.daemon.of('lines')).toEqual([]);
    w.clock.t += TIMING.keepAliveMs - 1;
    await call(7);
    expect(w.daemon.of('lines')).toEqual([]);
    w.clock.t += 1;
    await call(7);
    expect(w.daemon.of('lines')).toEqual([expect.objectContaining({ clientId, body: { lines: [] } })]);
    await call(7);
    expect(w.daemon.of('lines')).toHaveLength(1);
    w.clock.t += TIMING.keepAliveMs;
    await call(7, { inCall: false });
    expect(w.daemon.of('lines')).toHaveLength(1);
  });

  it('ignores errors but a 404: the call is still answered and nothing changes', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    const clientId = w.tabState(7)?.clientId;
    for (const answer of ['down', daemonError(500, 'internal'), daemonError(403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'), daemonError(429, 'too many requests')] as const) {
      w.daemon.on('lines', answer);
      w.clock.t += TIMING.keepAliveMs;
      expect(await call(7), JSON.stringify(answer)).toEqual({ button: true, notes: true });
    }
    expect(w.daemon.of('lines')).toHaveLength(4);
    expect(w.tabState(7)).toMatchObject({ clientId, notes: true });
    expect(w.toPage(7)).toEqual([{ t: 'capture', on: true }]);
  });

  it('a 404 (the stale sweep ended it while the Mac slept, or it was deleted on the phone) clears the meeting and stops notes', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    w.daemon.on('lines', daemonError(404, NOT_OPEN));
    w.clock.t += TIMING.keepAliveMs;
    expect(await call(7)).toEqual({ button: true, notes: false });
    expect(w.toPage(7).at(-1)).toEqual({ t: 'capture', on: false, text: NOT_OPEN });
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.tabState(7)).toMatchObject({ inCall: true, notes: false, shots: 0 });
    // Never ended or opened again from here; the next screenshot makes a new meeting.
    expect(w.daemon.of('end')).toEqual([]);
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(await w.page(7, { t: 'shot' })).toEqual({ ok: true, text: 'Saved' });
    expect(w.daemon.of('open')).toHaveLength(2);
  });

  it('a 404 for a meeting a screenshot made (notes off) clears it without a word to the page', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.page(7, { t: 'shot' });
    w.daemon.on('lines', daemonError(404, NOT_OPEN));
    w.clock.t += TIMING.keepAliveMs;
    expect(await call(7)).toEqual({ button: true, notes: false });
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.toPage(7)).toEqual([]);
  });
});

describe('a closed tab', () => {
  it('ends its meeting with closed and forgets the tab', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start(7);
    const clientId = w.tabState(7)?.clientId;
    w.model.removeTab(7);
    w.chrome.tabs.onRemoved.dispatch(7);
    await expect.poll(() => w.daemon.of('end').length).toBe(1);
    expect(w.daemon.of('end')[0]).toMatchObject({ clientId, body: { reason: 'closed' } });
    expect(w.tabState(7)).toBeUndefined();
  });

  it('with no meeting just goes', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.chrome.tabs.onRemoved.dispatch(7);
    await expect.poll(() => w.tabState(7)).toBeUndefined();
    w.chrome.tabs.onRemoved.dispatch(42);
    expect(w.daemon.of('end')).toEqual([]);
  });
});

describe('one meeting per tab', () => {
  it('the same call in two tabs is two meetings', async () => {
    w = setupWorker();
    await w.meetTab(7, { windowId: 1 });
    await w.meetTab(8, { windowId: 2 });
    await start(7);
    await start(8);
    const [a, b] = w.daemon.of('open');
    expect(a?.clientId).not.toBe(b?.clientId);
    expect(w.tabState(7)?.clientId).toBe(a?.clientId);
    expect(w.tabState(8)?.clientId).toBe(b?.clientId);
  });

  it('a screenshot and Start at once make one meeting', async () => {
    w = setupWorker();
    await w.meetTab(7);
    const [shot, started] = await Promise.all([w.page(7, { t: 'shot' }), start(7)]);
    expect(shot).toEqual({ ok: true, text: 'Saved' });
    expect(started).toEqual({ ok: true });
    const ids = new Set(w.daemon.of('open').map((c) => c.clientId));
    expect(ids.size).toBe(1);
    expect(w.daemon.of('shot')[0]?.clientId).toBe([...ids][0]);
  });
});
