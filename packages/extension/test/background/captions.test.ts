/**
 * v0.9.1, captions on when notes start, the worker's part: Settings › Turn on
 * captions when notes start is on by default (chrome.storage.local
 * `autoCaptions`), and then every `capture {on: true}` (Start, a start by
 * itself) and every call answer with notes on carries `cc`; switched off,
 * none does. The page's `cc` (how switching went) and its captions state's
 * client (and why none) reach the popup; the badge says `!` while notes
 * are on with no captions yet (not while captions are on and nobody has
 * spoken: `waiting`), and ON again with the first line; a reload's
 * `page:hide` takes a stale `!` away. Synthetic data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO } from '../../src/background/sentences.js';
import { MEET_CODE, markerIn, setupWorker, watchConsole, type WorkerUnderTest } from './chrome.js';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole> | undefined;
afterEach(() => {
  if (watched) expect(markerIn(watched.text())).toBe(false);
  watched = undefined;
  w?.close();
});

const start = (tabId = 7) => w.popup({ t: 'start', tabId, name: 'Weekly sync', autoTodos: false });
const call = (tabId = 7) => w.page(tabId, { t: 'call', site: 'meet', inCall: true, callKey: MEET_CODE, title: 'Weekly sync', stage: 'in', hook: 'meet:captions-button' });
const tabOf = async (tabId = 7) => ((await w.popup({ t: 'state', tabId })) as { tab: Record<string, unknown> }).tab;

describe('Turn on captions when notes start', () => {
  it('is on by default: Start tells the page to switch captions on, and so does the answer that resumes notes', async () => {
    w = setupWorker();
    watched = watchConsole();
    await w.meetTab(7);
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ autoCaptions: true });
    expect(await start()).toEqual({ ok: true });
    expect(w.toPage(7)).toEqual([{ t: 'capture', on: true, cc: true }]);
    expect(await call()).toEqual({ button: true, notes: true, cc: true });
    expect(w.model.local.has('autoCaptions')).toBe(false);
  });

  it('switched off in Settings: kept in chrome.storage.local, and neither Start, a start by itself nor an answer carries cc', async () => {
    w = setupWorker();
    await w.meetTab(7);
    expect(await w.popup({ t: 'autoCaptions', on: false })).toEqual({ ok: true });
    expect(w.model.local.get('autoCaptions')).toBe(false);
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ autoCaptions: false });
    await start();
    expect(w.toPage(7)).toEqual([{ t: 'capture', on: true }]);
    expect(await call()).toEqual({ button: true, notes: true });
    // A start by itself (Start when I join), switch still off.
    w.model.addTab({ id: 8, windowId: 1, url: 'https://meet.google.com/xyz-abcd-efg', active: true });
    w.model.onTabMessage(8, () => ({ ok: true }));
    const at = (stage: 'prejoin' | 'in') => w.page(8, { t: 'call', site: 'meet', inCall: stage === 'in', callKey: 'xyz-abcd-efg', title: 'Other', stage });
    await at('prejoin');
    expect(await w.popup({ t: 'arm', tabId: 8, name: '', autoTodos: false })).toEqual({ ok: true });
    await at('in');
    expect(w.toPage(8).at(-1)).toEqual({ t: 'capture', on: true, text: AUTO.started });
    // On again.
    expect(await w.popup({ t: 'autoCaptions', on: true })).toEqual({ ok: true });
    expect(await call()).toEqual({ button: true, notes: true, cc: true });
  });

  it("the page's report and its client reach the popup while notes are on, and go with the meeting", async () => {
    w = setupWorker();
    await w.meetTab(7);
    expect(await tabOf()).toMatchObject({ client: 'meet', cc: null });
    // Before notes: a report is not kept.
    await w.page(7, { t: 'cc', result: 'turned-on', hook: 'meet:cc-button' });
    expect(await tabOf()).toMatchObject({ cc: null });
    await start();
    await w.page(7, { t: 'cc', result: 'turned-on', hook: 'meet:cc-popup' });
    await w.page(7, { t: 'captions', state: 'none', client: 'meet' });
    expect(await tabOf()).toMatchObject({ captions: 'none', client: 'meet', cc: { result: 'turned-on', hook: 'meet:cc-popup' } });
    await w.popup({ t: 'end', tabId: 7 });
    expect(await tabOf()).toMatchObject({ notes: false, captions: 'unknown', cc: null });
  });

  it('a Teams guest: the client the page names is kept (light)', async () => {
    w = setupWorker();
    w.model.addTab({ id: 9, windowId: 1, url: 'https://teams.microsoft.com/light-meetings/launch?anon=true&p=made-up', active: true });
    w.model.onTabMessage(9, () => ({ ok: true }));
    await w.page(9, { t: 'call', site: 'teams', inCall: true, callKey: null, title: 'Weekly sync | Microsoft Teams', stage: 'in', hook: 'teams:hangup-button' });
    expect(await tabOf(9)).toMatchObject({ client: 'teams' });
    await start(9);
    await w.page(9, { t: 'captions', state: 'none', client: 'light', why: 'clicked' });
    expect(await tabOf(9)).toMatchObject({ client: 'light', captions: 'none', why: 'clicked' });
    // Why goes with `none`.
    await w.page(9, { t: 'captions', state: 'waiting', client: 'light' });
    expect(await tabOf(9)).not.toHaveProperty('why');
    expect(await tabOf(9)).toMatchObject({ captions: 'waiting' });
  });
});

describe('the badge', () => {
  it('`!` while notes are on with no captions yet; ON again with the first line; nothing once notes end', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start();
    expect(w.model.badge(7).text).toBe('ON');
    await w.page(7, { t: 'captions', state: 'none', client: 'meet' });
    expect(w.model.badge(7)).toEqual({ text: '!', color: '#a67a0c', title: 'Jantar: keeping notes, but no captions yet. Open Jantar for why.' });
    await w.page(7, { t: 'captions', state: 'reading', client: 'meet' });
    expect(w.model.badge(7)).toEqual({ text: 'ON', color: '#16203a', title: 'Jantar: keeping notes in this tab' });
    await w.page(7, { t: 'captions', state: 'none', client: 'meet' });
    await w.popup({ t: 'end', tabId: 7 });
    expect(w.model.badge(7).text).toBe('');
  });

  it('captions on and nobody speaking yet (`waiting`) is ON, no `!`', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start();
    await w.page(7, { t: 'captions', state: 'waiting', client: 'meet' });
    expect(w.model.badge(7).text).toBe('ON');
  });

  it('a reload (the page going, `page:hide`) takes a stale `!` away until the next page says', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await start();
    await w.page(7, { t: 'captions', state: 'none', client: 'meet', why: 'off' });
    expect(w.model.badge(7).text).toBe('!');
    await w.page(7, { t: 'call', site: 'meet', inCall: true, callKey: MEET_CODE, title: 'Weekly sync', stage: 'none', hook: 'page:hide' });
    expect(await tabOf()).toMatchObject({ notes: true, captions: 'unknown' });
    expect(w.model.badge(7).text).toBe('ON');
  });
});
