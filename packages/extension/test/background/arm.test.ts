/**
 * v0.9.1, Start when I join, the worker's part (spec 4 to 6, 12): the popup
 * arms a tab on its join screen or in its waiting room with the sheet's
 * fields, making no daemon call; a `call` saying the page has been in the
 * call for two polls (stage `in`) starts notes exactly as Start would, and
 * nothing else does; the arm ends by every rule (used, Cancel, another call,
 * away, silent, expired, the tab closing, the tab on another site, Unpair,
 * a 401) and its alarm follows the earliest deadline; a failed start says
 * why (and "not running" is tried again); Always start when I join a call
 * arms every join screen, skips a call on Not this call or after End, and
 * never starts a page first seen in the call; the badge says ARM, ON or !.
 * Nothing of a URL or a title is kept in an arm, and nothing reaches the
 * console. Synthetic data only.
 */
import { MEETING_MARKER } from '@jantar/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALWAYS_ARMED, AUTO, JOIN_SCREEN_FIRST, NOT_RUNNING, NO_MEETING_TAB, OTHER_TAB, PAIR_AGAIN } from '../../src/background/sentences.js';
import { createWorker } from '../../src/background/worker.js';
import type { CallStage, ToPage } from '../../src/shared/messages.js';
import { ARM_ALARM, ARM_TIMING, READ_ALARM, TIMING } from '../../src/shared/wire.js';
import { KEY, MEET_CODE, MEET_URL, PORT, PROJECT_ID, TEAMS_URL, ULID, daemonError, markerIn, setupWorker, watchConsole, type WorkerUnderTest } from './chrome.js';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole> | undefined;
afterEach(() => {
  // MP7: nothing of a meeting reached the console.
  if (watched) expect(markerIn(watched.text())).toBe(false);
  watched = undefined;
  w?.close();
});

const HOOK: Partial<Record<CallStage, string>> = { prejoin: 'meet:join-button', lobby: 'meet:call_end', in: 'meet:captions-button', left: 'page:left' };
const OTHER_CODE = 'xyz-abcd-efg';
const MEETINGS_OFF = 'Meetings are off. Turn them on at your Mac: jantar meetings on';

/** A Meet page's `call` at a stage (inCall as the page would say it). */
function call(tabId: number, stage: CallStage, over: Record<string, unknown> = {}) {
  return w.page(tabId, { t: 'call', site: 'meet', inCall: stage === 'in', callKey: MEET_CODE, title: 'Weekly sync', stage, ...(HOOK[stage] ? { hook: HOOK[stage] } : {}), ...over });
}

/** A Meet tab whose page answers every message, then its `call` at `stage`. */
async function tabAt(tabId: number, stage: CallStage = 'prejoin', over: Record<string, unknown> = {}, url = MEET_URL) {
  w.model.addTab({ id: tabId, windowId: 1, url, active: true });
  w.model.onTabMessage(tabId, () => ({ ok: true }));
  await call(tabId, stage, over);
}

/** A Teams page's `call` at a stage (Teams v2: one address, no call key). */
function teamsCall(tabId: number, stage: CallStage, over: Record<string, unknown> = {}) {
  const hook = { prejoin: 'teams:prejoin-join', lobby: 'teams:join-link', in: 'teams:hangup-button', left: 'page:left' }[stage as string];
  return w.page(tabId, { t: 'call', site: 'teams', inCall: stage === 'in', callKey: null, title: 'Weekly sync', stage, ...(hook ? { hook } : {}), ...over });
}

async function teamsAt(tabId: number, stage: CallStage) {
  w.model.addTab({ id: tabId, windowId: 1, url: TEAMS_URL, active: true });
  w.model.onTabMessage(tabId, () => ({ ok: true }));
  await teamsCall(tabId, stage);
}

const arm = (tabId: number, over: Record<string, unknown> = {}) => w.popup({ t: 'arm', tabId, name: '', autoTodos: false, ...over });
const stored = (tabId: number) => w.model.session.get(`arm:${tabId}`) as Record<string, unknown> | undefined;
const captures = (tabId: number) => w.toPage(tabId).filter((m): m is Extract<ToPage, { t: 'capture' }> => m.t === 'capture');
const later = (ms: number) => {
  w.clock.t += ms;
};
/** The alarm fires: the sweep runs (the listener does not wait for it). */
async function fire(name = ARM_ALARM) {
  w.chrome.alarms.onAlarm.dispatch({ name, scheduledTime: w.clock.t });
  await w.worker.arms.sweep();
}

describe('arm (the popup)', () => {
  it("on the join screen: kept with the sheet's fields cleaned, no daemon call, ARM on that tab only", async () => {
    w = setupWorker();
    await tabAt(7);
    await tabAt(8);
    expect(await arm(7, { name: '  \n', projectId: 'not-a-ulid', people: ' Sam,\u0007 Priya ', autoTodos: true })).toEqual({ ok: true });
    expect(stored(7)).toEqual({
      from: 'popup',
      site: 'meet',
      callKey: MEET_CODE,
      name: '',
      people: 'Sam, Priya',
      autoTodos: false,
      at: w.clock.t,
      until: w.clock.t + ARM_TIMING.maxMs,
      heardAt: w.clock.t,
      tries: 0,
    });
    expect(w.daemon.ops()).toEqual([]);
    expect(w.toPage(7)).toEqual([]);
    expect(w.model.badge(7)).toEqual({ text: 'ARM', color: '#a67a0c', title: 'Jantar: notes start when you are in the call' });
    expect(w.model.badge(8).text).toBe('');
    // A ulid project keeps its todos switch.
    expect(await arm(8, { name: 'Planning', projectId: PROJECT_ID, autoTodos: true })).toEqual({ ok: true });
    expect(stored(8)).toMatchObject({ name: 'Planning', projectId: PROJECT_ID, autoTodos: true });
  });

  it('in the waiting room, and after leaving (a rejoin), too', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    expect(await arm(7)).toEqual({ ok: true });
    await tabAt(8, 'left');
    expect(await arm(8)).toEqual({ ok: true });
    // A one-poll flicker in the waiting room (inCall for the 60-s grace) still arms: only stage `in` is admitted.
    await tabAt(9, 'lobby', { inCall: true });
    expect(await arm(9)).toEqual({ ok: true });
    expect(w.daemon.ops()).toEqual([]);
  });

  it('says why it did not: no meeting tab, no join screen, not paired', async () => {
    w = setupWorker();
    expect(await arm(3)).toEqual({ ok: false, error: NO_MEETING_TAB });
    await tabAt(7, 'none', { callKey: null });
    expect(await arm(7)).toEqual({ ok: false, error: JOIN_SCREEN_FIRST });
    expect(stored(7)).toBeUndefined();
    await w.keys.clear();
    await tabAt(8);
    expect(await arm(8)).toEqual({ ok: false, error: PAIR_AGAIN });
    expect(stored(8)).toBeUndefined();
    expect(w.daemon.ops()).toEqual([]);
  });

  it('a tab already in the call starts now, exactly as Start', async () => {
    w = setupWorker();
    await tabAt(7, 'in');
    expect(await arm(7, { name: 'Planning', projectId: PROJECT_ID, autoTodos: true })).toEqual({ ok: true });
    expect(w.daemon.of('open')[0]?.body).toEqual({ site: 'meet', name: 'Planning', projectId: PROJECT_ID, autoTodos: true, captions: true, at: w.clock.t });
    expect(captures(7)).toEqual([{ t: 'capture', on: true, cc: true }]);
    expect(stored(7)).toBeUndefined();
    expect(w.model.badge(7).text).toBe('ON');
  });
});

describe('admission', () => {
  it('in the waiting room with the in-call hooks for one poll: nothing starts', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    expect(await call(7, 'lobby', { inCall: true })).toEqual({ button: true, notes: false });
    // Without a stage a message never starts notes either.
    await w.page(7, { t: 'call', site: 'meet', inCall: true, callKey: MEET_CODE, title: 'Weekly sync' });
    expect(w.daemon.ops()).toEqual([]);
    expect(captures(7)).toEqual([]);
    expect(stored(7)).toBeDefined();
  });

  it('in the call: the same open a popup Start with the same fields makes, the page told, the arm used, ON', async () => {
    w = setupWorker();
    watched = watchConsole();
    const fields = { name: `Planning ${MEETING_MARKER}`, projectId: PROJECT_ID, people: `Sam, Priya ${MEETING_MARKER}`, autoTodos: true };
    // Start, in another tab in the call.
    await tabAt(8, 'in');
    await w.popup({ t: 'start', tabId: 8, ...fields });
    const started = w.daemon.of('open')[0]!;
    // Start when I join, in this one.
    await tabAt(7, 'lobby');
    await arm(7, fields);
    later(30_000);
    // The answer comes after the `capture` message, so it says notes are on.
    expect(await call(7, 'in')).toEqual({ button: true, notes: true, cc: true });
    const auto = w.daemon.of('open')[1]!;
    expect(auto.body).toEqual({ ...(started.body as object), at: w.clock.t });
    expect(auto.clientId).not.toBe(started.clientId);
    expect(captures(7)).toEqual([{ t: 'capture', on: true, text: AUTO.started, cc: true }]);
    expect(stored(7)).toBeUndefined();
    expect(w.tabState(7)).toMatchObject({ notes: true, stage: 'in', auto: { at: w.clock.t, ok: true } });
    expect(w.model.badge(7)).toEqual({ text: 'ON', color: '#16203a', title: 'Jantar: keeping notes in this tab' });
    // The next keep-alive opens nothing again.
    later(TIMING.keepAliveMs);
    expect(await call(7, 'in')).toEqual({ button: true, notes: true, cc: true });
    expect(w.daemon.of('open')).toHaveLength(2);
    expect(captures(7)).toHaveLength(1);
  });

  it("an untouched name is the page's title when notes start", async () => {
    w = setupWorker();
    await tabAt(7, 'lobby', { title: '' });
    await arm(7);
    await call(7, 'in', { title: 'Budget review' });
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ name: 'Budget review', autoTodos: false });
  });

  it('a tab not armed: stage in opens nothing and reads nothing (MP6)', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await call(7, 'in');
    later(TIMING.keepAliveMs);
    await call(7, 'in');
    expect(w.daemon.ops()).toEqual([]);
    expect(captures(7)).toEqual([]);
  });

  it('two tabs on the same call: an arm on one never starts the other', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await tabAt(8, 'lobby');
    await arm(7);
    await call(8, 'in');
    expect(w.daemon.ops()).toEqual([]);
    expect(captures(8)).toEqual([]);
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(captures(8)).toEqual([]);
  });

  it('a Start that won the race: the arm is used, notes are not opened twice', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    // The entering `call` (inCall, the stage before), then Start pressed in the second before `in`.
    await call(7, 'lobby', { inCall: true });
    expect(await w.popup({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false })).toEqual({ ok: true });
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(stored(7)).toBeUndefined();
  });

  it('4.5: notes on with a live arm (a restart lost the capture message) sends `capture {on: true}` once and drops the arm', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    const kept = stored(7);
    await call(7, 'in');
    expect(captures(7)).toHaveLength(1);
    // As if the worker died after the open: the arm is back, the page heard nothing.
    w.model.session.set('arm:7', kept);
    later(TIMING.keepAliveMs);
    await call(7, 'in');
    expect(captures(7)).toEqual([
      { t: 'capture', on: true, text: AUTO.started, cc: true },
      { t: 'capture', on: true, cc: true },
    ]);
    expect(stored(7)).toBeUndefined();
    later(TIMING.keepAliveMs);
    await call(7, 'in');
    expect(captures(7)).toHaveLength(2);
    expect(w.daemon.of('open')).toHaveLength(1);
  });
});

describe('when an arm ends', () => {
  it('another Meet code: dropped, and that call does not start', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    await call(7, 'prejoin', { callKey: OTHER_CODE });
    expect(stored(7)).toBeUndefined();
    await call(7, 'in', { callKey: OTHER_CODE });
    expect(w.daemon.ops()).toEqual([]);
    expect(w.model.badge(7).text).toBe('');
  });

  it('a reload (pagehide, then the join screen within a minute) keeps it', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    await call(7, 'none', { hook: 'page:hide' });
    expect(stored(7)).toMatchObject({ awaySince: w.clock.t, awayHow: 'hide' });
    later(5_000);
    // The new page's first `call` knows nothing yet; two polls later the join screen.
    await call(7, 'none');
    later(2_000);
    await call(7, 'prejoin');
    expect(stored(7)).not.toHaveProperty('awaySince');
    expect(w.model.badge(7).text).toBe('ARM');
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
  });

  it('a minute with no join screen, waiting room or call: the alarm drops it, and a page still there is told', async () => {
    w = setupWorker();
    await tabAt(7);
    await tabAt(8);
    await arm(7);
    await arm(8);
    await call(7, 'none');
    await call(8, 'none', { hook: 'page:hide' });
    later(ARM_TIMING.awayMs);
    await fire();
    expect(stored(7)).toBeUndefined();
    expect(stored(8)).toBeUndefined();
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: AUTO.lost }]);
    // The page that went (pagehide) is not told.
    expect(captures(8)).toEqual([]);
    expect(w.model.badge(7).text).toBe('');
  });

  it('the same rule on the next `call`, before any alarm', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    await call(7, 'none');
    later(ARM_TIMING.awayMs);
    await call(7, 'in');
    expect(w.daemon.ops()).toEqual([]);
    expect(stored(7)).toBeUndefined();
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: AUTO.lost }]);
  });

  it('five minutes without a word from the page', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    later(ARM_TIMING.silentMs - 1);
    await fire();
    expect(stored(7)).toBeDefined();
    later(1);
    await fire();
    expect(stored(7)).toBeUndefined();
    expect(captures(7)).toEqual([]);
  });

  it('two hours unused, even while the page beats', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    for (let t = 0; t < ARM_TIMING.maxMs; t += TIMING.keepAliveMs) {
      later(TIMING.keepAliveMs);
      await call(7, 'lobby');
    }
    expect(stored(7)).toBeUndefined();
    await call(7, 'in');
    expect(w.daemon.ops()).toEqual([]);
  });

  it('the tab closes', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    w.chrome.tabs.onRemoved.dispatch(7);
    await vi.waitFor(() => expect(stored(7)).toBeUndefined());
    expect(w.model.alarms.has(ARM_ALARM)).toBe(false);
  });

  it('the popup finds the tab on another site', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    w.model.addTab({ id: 7, windowId: 1, url: 'https://mail.example.com/inbox', active: true });
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ tab: null });
    expect(stored(7)).toBeUndefined();
  });

  it('Cancel drops it; without Always nothing comes back', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    expect(await w.popup({ t: 'disarm', tabId: 7 })).toEqual({ ok: true });
    expect(stored(7)).toBeUndefined();
    expect(w.model.badge(7).text).toBe('');
    await call(7, 'in');
    expect(w.daemon.ops()).toEqual([]);
    expect(await w.popup({ t: 'disarm', tabId: 7 })).toEqual({ ok: true });
  });
});

describe('the alarm', () => {
  it('follows the earliest deadline, never sooner than 30 s; made again after a sweep; gone with the last arm', async () => {
    w = setupWorker();
    const t0 = w.clock.t;
    await tabAt(7);
    await arm(7);
    expect(w.model.alarms.get(ARM_ALARM)?.when).toBe(t0 + ARM_TIMING.silentMs);
    // A beat moves the silence deadline but does not make the alarm again.
    later(60_000);
    await call(7, 'prejoin');
    expect(w.model.alarms.get(ARM_ALARM)?.when).toBe(t0 + ARM_TIMING.silentMs);
    // The alarm then finds the page heard lately, and is made again for the new deadline.
    later(ARM_TIMING.silentMs - 60_000);
    await fire();
    expect(stored(7)).toBeDefined();
    expect(w.model.alarms.get(ARM_ALARM)?.when).toBe(t0 + 60_000 + ARM_TIMING.silentMs);
    // Away: the minute is the earliest now, and back on the join screen the silence deadline again.
    await call(7, 'none');
    expect(w.model.alarms.get(ARM_ALARM)?.when).toBe(w.clock.t + ARM_TIMING.awayMs);
    later(10_000);
    await call(7, 'prejoin');
    expect(w.model.alarms.get(ARM_ALARM)?.when).toBe(w.clock.t + ARM_TIMING.silentMs);
    // A deadline already past: 30 s from now at the soonest.
    later(ARM_TIMING.silentMs + 10_000);
    await tabAt(8);
    await arm(8);
    await w.worker.arms.schedule();
    expect(w.model.alarms.get(ARM_ALARM)?.when).toBe(w.clock.t + ARM_TIMING.alarmMinMs);
    await fire();
    expect(stored(7)).toBeUndefined();
    await w.popup({ t: 'disarm', tabId: 8 });
    expect(w.model.alarms.has(ARM_ALARM)).toBe(false);
  });

  it('is cleared when the browser starts or the extension is installed or reloaded (session storage is empty then)', async () => {
    w = setupWorker();
    await w.chrome.alarms.create(ARM_ALARM, { when: w.clock.t + 60_000 });
    w.chrome.runtime.onStartup.dispatch();
    await vi.waitFor(() => expect(w.model.alarms.has(ARM_ALARM)).toBe(false));
    await w.chrome.alarms.create(ARM_ALARM, { when: w.clock.t + 60_000 });
    w.chrome.runtime.onInstalled.dispatch({ reason: 'update' });
    await vi.waitFor(() => expect(w.model.alarms.has(ARM_ALARM)).toBe(false));
  });

  it('the reads ignore it, and the arms ignore the read alarm', async () => {
    w = setupWorker();
    await tabAt(7);
    await arm(7);
    later(ARM_TIMING.silentMs);
    const sweep = vi.spyOn(w.worker.arms, 'sweep');
    w.chrome.alarms.onAlarm.dispatch({ name: READ_ALARM, scheduledTime: w.clock.t });
    await new Promise((r) => setTimeout(r, 0));
    expect(stored(7)).toBeDefined();
    w.chrome.alarms.onAlarm.dispatch({ name: ARM_ALARM, scheduledTime: w.clock.t });
    await vi.waitFor(() => expect(stored(7)).toBeUndefined());
    expect(sweep).not.toHaveBeenCalled();
    // The read alarm asked the daemon for nothing: Read saved links is off.
    expect(w.daemon.of('readNext')).toEqual([]);
  });
});

describe('a worker restart', () => {
  it('a new worker over the same storage still starts on `in`, and still knows Always', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    await w.popup({ t: 'always', on: true });
    // The worker stops; Chrome starts a new one with the same listeners' events.
    w.chrome.runtime.onMessage.listeners.length = 0;
    const again = createWorker({ keys: w.keys, fetch: w.daemon.fetch, now: w.clock.now, sleep: w.clock.sleep });
    w.chrome.runtime.onMessage.addListener(again.onMessage as never);
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: true, text: AUTO.started, cc: true });
    expect(await again.arms.always()).toBe(true);
  });
});

describe('when notes cannot start', () => {
  it('Meetings off (403): the page and the popup say why, ! on the icon, nothing read', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    w.daemon.on('open', daemonError(403, MEETINGS_OFF));
    await call(7, 'in');
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: AUTO.notStarted(MEETINGS_OFF) }]);
    expect(stored(7)).toBeUndefined();
    expect(w.tabState(7)).toMatchObject({ notes: false, auto: { at: w.clock.t, ok: false, text: MEETINGS_OFF } });
    expect(w.model.badge(7)).toEqual({ text: '!', color: '#a67a0c', title: 'Jantar: notes did not start. Open Jantar for why.' });
    w.daemon.on('info', { status: 200, body: { projects: null } });
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ tab: { auto: { ok: false, text: MEETINGS_OFF }, arm: null } });
    // Ten minutes on, the ! and the popup's line are gone.
    later(ARM_TIMING.failedShowMs);
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ tab: { auto: null } });
    expect(w.model.badge(7).text).toBe('');
  });

  it('Jantar not running: said once, tried on the next two keep-alives, then given up with the reason', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    w.daemon.on('open', 'down');
    await call(7, 'in');
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: AUTO.retrying }]);
    expect(stored(7)).toMatchObject({ tries: 1 });
    expect(w.model.badge(7).text).toBe('ARM');
    later(TIMING.keepAliveMs);
    await call(7, 'in');
    expect(stored(7)).toMatchObject({ tries: 2 });
    expect(captures(7)).toHaveLength(1);
    later(TIMING.keepAliveMs);
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(3);
    expect(stored(7)).toBeUndefined();
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: false, text: AUTO.notStarted(NOT_RUNNING) });
    expect(w.model.badge(7).text).toBe('!');
  });

  it('Jantar back on a retry: notes start then', async () => {
    w = setupWorker();
    await tabAt(7, 'lobby');
    await arm(7);
    w.daemon.on('open', 'down', { status: 200, body: { id: '01JFZ8X8Y3T0V5G9WQK2M4N6SR' } });
    await call(7, 'in');
    later(TIMING.keepAliveMs);
    await call(7, 'in');
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: true, text: AUTO.started, cc: true });
    expect(w.tabState(7)).toMatchObject({ notes: true, auto: { ok: true } });
  });

  it('a 401: "Pair again", every arm dropped, Always kept; later join screens are never armed and say why', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await tabAt(8, 'prejoin');
    expect(stored(7)).toMatchObject({ from: 'always' });
    w.daemon.on('open', daemonError(401, 'The Jantar extension is not paired.'));
    await call(7, 'in');
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: false, text: AUTO.notStarted(PAIR_AGAIN) });
    expect(stored(7)).toBeUndefined();
    expect(stored(8)).toBeUndefined();
    expect(await w.keys.get()).toBeNull();
    expect(await w.worker.arms.always()).toBe(true);
    expect(w.model.badge(8).text).toBe('');
    // Another call's join screen: no arm, no ARM, and no promise; the page says why, once.
    await tabAt(9, 'none', { callKey: OTHER_CODE });
    await call(9, 'prejoin', { callKey: OTHER_CODE });
    expect(stored(9)).toBeUndefined();
    expect(captures(9)).toEqual([{ t: 'capture', on: false, text: AUTO.unpaired }]);
    expect(w.model.badge(9).text).toBe('');
    later(TIMING.keepAliveMs);
    await call(9, 'lobby', { callKey: OTHER_CODE });
    later(TIMING.keepAliveMs);
    await call(9, 'lobby', { callKey: OTHER_CODE });
    expect(captures(9)).toHaveLength(1);
    await call(9, 'in', { callKey: OTHER_CODE });
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(captures(9)).toHaveLength(1);
    expect(await w.popup({ t: 'state', tabId: 9 })).toMatchObject({ connection: 'unpaired', always: true, tab: { arm: null } });
  });

  it('no key at all (Always on, never paired): nothing armed, no ARM, no daemon call; the page says to pair once per visit', async () => {
    w = setupWorker({ paired: false });
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'none');
    await call(7, 'lobby');
    expect(stored(7)).toBeUndefined();
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: AUTO.unpaired }]);
    expect(AUTO.unpaired).not.toContain(ALWAYS_ARMED);
    expect(w.model.badge(7).text).toBe('');
    await call(7, 'in');
    expect(w.daemon.ops()).toEqual([]);
    expect(captures(7)).toHaveLength(1);
    // A reload of the join screen (pagehide, then the screen again) says it again.
    await call(7, 'none', { hook: 'page:hide' });
    await call(7, 'prejoin');
    expect(captures(7)).toHaveLength(2);
    // Turning Always on again while not paired arms nothing either.
    await w.popup({ t: 'always', on: true });
    expect(stored(7)).toBeUndefined();
    expect(w.model.badge(7).text).toBe('');
  });

  it('paired again with Always on: the tabs on a join screen are armed at once', async () => {
    w = setupWorker({ paired: false });
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'none');
    await call(7, 'prejoin');
    await tabAt(8, 'none', { callKey: null });
    w.daemon.on('claim', { status: 200, body: { id: ULID, key: KEY } });
    expect(await w.popup({ t: 'pair', text: `jantar-ext:${PORT}:C0DEc0de_C0DE-c0deC0` })).toEqual({ ok: true });
    expect(stored(7)).toMatchObject({ from: 'always', callKey: MEET_CODE });
    expect(stored(8)).toBeUndefined();
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: false, text: ALWAYS_ARMED });
    expect(w.model.badge(7).text).toBe('ARM');
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
  });
});

describe('Always start when I join a call', () => {
  it('off by default: a join screen makes no arm', async () => {
    w = setupWorker();
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ always: false });
    await tabAt(7);
    expect(stored(7)).toBeUndefined();
    await call(7, 'in');
    expect(w.daemon.of('open')).toEqual([]);
  });

  it("on: a join screen is armed with one bubble, and notes start once in the call with the page's title", async () => {
    w = setupWorker();
    expect(await w.popup({ t: 'always', on: true })).toEqual({ ok: true });
    expect(w.model.local.get('startOnJoin')).toBe(true);
    await tabAt(7, 'prejoin', { title: '' });
    expect(stored(7)).toMatchObject({ from: 'always', name: '', autoTodos: false });
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: ALWAYS_ARMED }]);
    await call(7, 'lobby', { title: '' });
    later(TIMING.keepAliveMs);
    await call(7, 'lobby', { title: '' });
    expect(captures(7)).toHaveLength(1);
    expect(w.model.badge(7).text).toBe('ARM');
    await call(7, 'in', { title: 'Weekly sync' });
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ name: 'Weekly sync', autoTodos: false, captions: true });
    expect(w.daemon.of('open')[0]?.body).not.toHaveProperty('projectId');
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: true, text: AUTO.started, cc: true });
  });

  it('turning it on arms every known tab on a join screen or in a waiting room, and nothing else', async () => {
    w = setupWorker();
    await tabAt(7, 'prejoin');
    await tabAt(8, 'lobby');
    await tabAt(9, 'in');
    await tabAt(10, 'none', { callKey: null });
    await w.popup({ t: 'always', on: true });
    expect(stored(7)).toMatchObject({ from: 'always' });
    expect(stored(8)).toMatchObject({ from: 'always' });
    expect(stored(9)).toBeUndefined();
    expect(stored(10)).toBeUndefined();
    expect(captures(8)).toEqual([{ t: 'capture', on: false, text: ALWAYS_ARMED }]);
    expect([7, 8, 9, 10].map((id) => w.model.badge(id).text)).toEqual(['ARM', 'ARM', '', '']);
  });

  it('Teams: a page that shows nothing of a call (Chat) is never armed, also when its `left` says so', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await teamsAt(7, 'none');
    later(TIMING.keepAliveMs);
    await teamsCall(7, 'none');
    expect(stored(7)).toBeUndefined();
    // A call, then Leave to Chat: the page's `left` names stage none (no rejoin on screen).
    await teamsCall(7, 'in');
    later(TIMING.leaveGraceMs);
    await teamsCall(7, 'none', { left: true, hook: 'page:left' });
    expect(stored(7)).toBeUndefined();
    expect(captures(7)).toEqual([]);
    expect(w.model.badge(7).text).toBe('');
  });

  it("Teams: Chat for a minute after the join screen or after leaving ends the arm, Always's and a popup one, and a later call is armed afresh", async () => {
    w = setupWorker();
    await teamsAt(7, 'prejoin');
    await arm(7, { name: 'Weekly sync', projectId: PROJECT_ID, autoTodos: true });
    // Chat: the page says none and then nothing (none never beats).
    await teamsCall(7, 'none');
    later(ARM_TIMING.awayMs);
    await fire();
    expect(stored(7)).toBeUndefined();
    expect(w.model.badge(7).text).toBe('');
    // Another meeting later in the same tab starts nothing.
    await teamsCall(7, 'prejoin', { title: 'Board review' });
    await teamsCall(7, 'in', { title: 'Board review' });
    expect(w.daemon.ops()).toEqual([]);
    // Always: End, Leave to Chat, a minute: the `off` arm goes, and another meeting starts.
    await w.popup({ t: 'start', tabId: 7, name: 'Board review', autoTodos: false });
    await w.popup({ t: 'always', on: true });
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: true });
    expect(stored(7)).toMatchObject({ off: true });
    later(TIMING.leaveGraceMs);
    await teamsCall(7, 'none', { left: true, hook: 'page:left' });
    later(20 * 60_000);
    await fire();
    expect(stored(7)).toBeUndefined();
    await teamsCall(7, 'prejoin', { title: 'Planning' });
    expect(stored(7)).toMatchObject({ from: 'always' });
    expect(stored(7)).not.toHaveProperty('off');
    await teamsCall(7, 'in', { title: 'Planning' });
    expect(w.daemon.of('open')).toHaveLength(2);
    expect(w.daemon.of('open')[1]?.body).toMatchObject({ site: 'teams', name: 'Planning' });
  });

  it('an Always arm ended by the away rule while its page came back to the join screen: no "can\'t see" bubble, just armed again', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'prejoin');
    expect(captures(7)).toEqual([{ t: 'capture', on: false, text: ALWAYS_ARMED }]);
    await call(7, 'none');
    later(ARM_TIMING.awayMs + 5_000);
    // The alarm was late: the page's own `call` finds the arm ended.
    await call(7, 'prejoin');
    expect(captures(7)).toEqual([
      { t: 'capture', on: false, text: ALWAYS_ARMED },
      { t: 'capture', on: false, text: ALWAYS_ARMED },
    ]);
    expect(stored(7)).toMatchObject({ from: 'always', at: w.clock.t });
  });

  it('a page first seen in the call is never started (a reload mid-call, an instant meeting)', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'none');
    await call(7, 'none', { inCall: true });
    await call(7, 'in');
    expect(stored(7)).toBeUndefined();
    expect(w.daemon.ops()).toEqual([]);
  });

  it('Not this call: the arm stays off, nothing starts, and Always does not come back for that call', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    expect(await w.popup({ t: 'disarm', tabId: 7 })).toEqual({ ok: true });
    expect(stored(7)).toMatchObject({ from: 'always', off: true });
    expect(w.model.badge(7).text).toBe('');
    later(TIMING.keepAliveMs);
    await call(7, 'lobby');
    expect(captures(7)).toHaveLength(1);
    await call(7, 'in');
    expect(w.daemon.ops()).toEqual([]);
    // A popup arm cancelled while Always is on stays off too.
    await tabAt(8, 'lobby');
    await arm(8, { name: 'Planning' });
    await w.popup({ t: 'disarm', tabId: 8 });
    await call(8, 'in');
    expect(w.daemon.ops()).toEqual([]);
  });

  it('he can still arm by hand after Not this call', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await w.popup({ t: 'disarm', tabId: 7 });
    await arm(7, { name: 'Planning' });
    expect(stored(7)).toMatchObject({ from: 'popup', name: 'Planning' });
    expect(stored(7)).not.toHaveProperty('off');
    await call(7, 'in');
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ name: 'Planning' });
  });

  it('End after a start by itself: Leave and Rejoin the same call does not start again; another call does', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: true });
    expect(stored(7)).toMatchObject({ off: true, callKey: MEET_CODE });
    later(TIMING.leaveGraceMs);
    await call(7, 'left', { left: true });
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
    // Another code: armed again.
    await call(7, 'prejoin', { callKey: OTHER_CODE });
    expect(stored(7)).toMatchObject({ from: 'always', callKey: OTHER_CODE });
    expect(stored(7)).not.toHaveProperty('off');
    await call(7, 'in', { callKey: OTHER_CODE });
    expect(w.daemon.of('open')).toHaveLength(2);
  });

  it('left for good, then Rejoin: a new meeting', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await call(7, 'in');
    later(TIMING.leaveGraceMs);
    await call(7, 'left', { left: true });
    expect(w.daemon.of('end')[0]?.body).toMatchObject({ reason: 'left' });
    expect(stored(7)).toMatchObject({ from: 'always' });
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(2);
  });

  it('a second tab on a Meet call another tab keeps notes for: not started, and told why', async () => {
    w = setupWorker();
    await tabAt(8, 'in');
    await w.popup({ t: 'start', tabId: 8, name: 'Weekly sync', autoTodos: false });
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await call(7, 'in');
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(captures(7).at(-1)).toEqual({ t: 'capture', on: false, text: AUTO.otherTab });
    expect(AUTO.otherTab).toBe(AUTO.notStarted(OTHER_TAB));
    expect(stored(7)).toBeUndefined();
  });

  it('off: its own arms go, the popup arms stay', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await tabAt(8, 'lobby');
    await w.popup({ t: 'disarm', tabId: 8 });
    await tabAt(9, 'lobby');
    await arm(9, { name: 'Planning' });
    expect(await w.popup({ t: 'always', on: false })).toEqual({ ok: true });
    expect(stored(7)).toBeUndefined();
    expect(stored(8)).toBeUndefined();
    expect(stored(9)).toMatchObject({ from: 'popup' });
    expect(w.model.local.get('startOnJoin')).toBe(false);
    expect([7, 9].map((id) => w.model.badge(id).text)).toEqual(['', 'ARM']);
  });

  it('Unpair turns it off and drops every arm', async () => {
    w = setupWorker();
    await w.popup({ t: 'always', on: true });
    await tabAt(7, 'lobby');
    await tabAt(8, 'lobby');
    await w.popup({ t: 'disarm', tabId: 8 });
    await tabAt(9, 'in');
    await w.popup({ t: 'start', tabId: 9, name: 'Weekly sync', autoTodos: false });
    expect(await w.popup({ t: 'unpair' })).toEqual({ ok: true });
    expect([7, 8, 9].map(stored)).toEqual([undefined, undefined, undefined]);
    expect(w.model.local.get('startOnJoin')).toBe(false);
    expect(await w.worker.arms.always()).toBe(false);
    expect([7, 8, 9].map((id) => w.model.badge(id).text)).toEqual(['', '', '']);
    expect(w.model.alarms.has(ARM_ALARM)).toBe(false);
  });
});

describe('privacy', () => {
  it('an arm holds no URL, no path and no title; nothing reaches the console', async () => {
    w = setupWorker();
    watched = watchConsole();
    const light = `https://teams.microsoft.com/light-meetings/launch?anon=1&p=made-up-${MEETING_MARKER.length}`;
    w.model.addTab({ id: 7, windowId: 1, url: light, active: true });
    w.model.onTabMessage(7, () => ({ ok: true }));
    await w.page(7, { t: 'call', site: 'teams', inCall: false, callKey: null, title: `Weekly sync ${MEETING_MARKER}`, stage: 'prejoin', hook: 'teams:join-link' });
    await arm(7);
    await w.popup({ t: 'always', on: true });
    await tabAt(8, 'lobby', { title: `Budget ${MEETING_MARKER}` });
    const arms = [...w.model.session.entries()].filter(([k]) => k.startsWith('arm:'));
    expect(arms).toHaveLength(2);
    const text = JSON.stringify(arms);
    expect(text).not.toMatch(/http|light-meetings|teams\.microsoft|meet\.google/);
    expect(text).not.toContain(MEETING_MARKER);
    expect(text).not.toContain('Weekly sync');
    // Nothing reached Jantar before the call.
    expect(w.daemon.ops()).toEqual([]);
  });
});
