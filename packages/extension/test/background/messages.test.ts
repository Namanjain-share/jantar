/**
 * MP10, the worker's part: message hygiene. Only this extension's own
 * messages; a page message needs a tab on a meeting host over https and
 * never names a tab; popup messages come only from the extension's own
 * pages; unknown `t` and malformed fields are ignored. Ignored means no
 * answer and nothing done (no daemon call, no state, no capture).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { siteOfUrl } from '../../src/background/accept.js';
import { MEETING_HOSTS, siteOf } from '../../src/shared/sites.js';
import { MEET_URL, setupWorker, type WorkerUnderTest } from './chrome.js';

let w: WorkerUnderTest;
afterEach(() => w?.close());

/** Nothing happened: no daemon call, no tab record, no capture, nothing sent to a page. */
function nothingDone(tabIds: number[] = [7]) {
  expect(w.daemon.calls).toEqual([]);
  expect(w.model.captures).toEqual([]);
  for (const id of tabIds) expect(w.toPage(id)).toEqual([]);
}

describe('the meeting hosts', () => {
  it("are shared/sites.ts's over https only, with the same site each", () => {
    for (const host of MEETING_HOSTS) {
      expect(siteOfUrl(`https://${host}/x`), host).toBe(siteOf(host));
      expect(siteOfUrl(`http://${host}/x`), host).toBeNull();
    }
    expect(siteOfUrl('https://mail.example.com/')).toBeNull();
    expect(siteOfUrl('not a url')).toBeNull();
  });
});

describe('the worker ignores', () => {
  it('a message from another extension', async () => {
    w = setupWorker();
    w.model.addTab({ id: 7, windowId: 1, url: MEET_URL, active: true });
    const sender = { ...w.model.pageSender(7), id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'shot' }, sender)).toBeUndefined();
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'unpair' }, { ...w.model.extensionSender(), id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).toBeUndefined();
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'state', tabId: 7 }, { url: w.model.extensionSender().url })).toBeUndefined();
    nothingDone();
    expect(await w.keys.get()).not.toBeNull();
  });

  it('a page that is not a meeting host, or not https', async () => {
    w = setupWorker();
    for (const [id, url] of [
      [7, 'https://example.com/meet.google.com'],
      [8, 'http://meet.google.com/abc-defg-hij'],
      [9, 'https://meet.google.com.example.com/abc-defg-hij'],
    ] as const) {
      w.model.addTab({ id, windowId: 1, url, active: true });
      expect(await w.page(id, { t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'x' })).toBeUndefined();
      expect(await w.page(id, { t: 'shot' })).toBeUndefined();
    }
    nothingDone([7, 8, 9]);
    expect(w.model.session.size).toBe(0);
  });

  it('a page message without a tab', async () => {
    w = setupWorker();
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'shot' }, { id: w.chrome.runtime.id, url: MEET_URL })).toBeUndefined();
    nothingDone();
  });

  it('a page claiming a tabId', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.addTab({ id: 8, windowId: 2, url: MEET_URL, active: true });
    const before = w.daemon.calls.length;
    expect(await w.page(8, { t: 'shot', tabId: 7 })).toBeUndefined();
    expect(await w.page(8, { t: 'lines', tabId: 7, lines: [] })).toBeUndefined();
    expect(w.daemon.calls.length).toBe(before);
    expect(w.model.captures).toEqual([]);
  });

  it('unknown t, popup messages from a page, and malformed fields', async () => {
    w = setupWorker();
    w.model.addTab({ id: 7, windowId: 1, url: MEET_URL, active: true });
    for (const msg of [
      { t: 'upload', url: 'http://127.0.0.1:1/v1/settings' },
      { t: 'pair', text: 'jantar-ext:7421:C0DEc0de_C0DE-c0deC0' },
      { t: 'unpair' },
      { t: 'state', tabId: 7 },
      { t: 'end', tabId: 7 },
      { t: 'call', site: 'teams', inCall: true, callKey: null, title: 'x' },
      { t: 'call', site: 'meet', inCall: 'yes', callKey: null, title: 'x' },
      { t: 'call', site: 'meet', inCall: true, left: false, callKey: null, title: 'x' },
      { t: 'lines', lines: 'not a list' },
      { t: 'captions', state: 'loud' },
      ['shot'],
      'shot',
      null,
    ]) {
      expect(await w.page(7, msg), JSON.stringify(msg)).toBeUndefined();
    }
    nothingDone();
    expect(w.model.session.size).toBe(0);
    expect(await w.keys.get()).not.toBeNull();
  });

  it("popup messages from anywhere but the extension's own pages, and with bad fields", async () => {
    w = setupWorker();
    await w.meetTab(7);
    const before = w.daemon.calls.length;
    const other = { id: w.chrome.runtime.id, url: 'https://example.com/popup.html' };
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'unpair' }, other)).toBeUndefined();
    for (const msg of [{ t: 'shot', tabId: '7' }, { t: 'start', tabId: 7, name: 'x' }, { t: 'state' }, { t: 'pair', text: 7 }, { t: 'nope' }]) {
      expect(await w.popup(msg), JSON.stringify(msg)).toBeUndefined();
    }
    expect(w.daemon.calls.length).toBe(before);
    expect(await w.keys.get()).not.toBeNull();
  });
});

describe('the worker takes', () => {
  it('a page message on each meeting host, with its tab from the sender', async () => {
    w = setupWorker();
    const hosts = ['https://meet.google.com/abc-defg-hij', 'https://teams.microsoft.com/v2/', 'https://teams.live.com/v2/', 'https://teams.cloud.microsoft/v2/'];
    for (const [i, url] of hosts.entries()) {
      const tabId = 20 + i;
      w.model.addTab({ id: tabId, windowId: 1, url, active: true });
      const site = url.includes('meet') ? 'meet' : 'teams';
      expect(await w.page(tabId, { t: 'call', site, inCall: false, callKey: null, title: '' })).toEqual({ button: true, notes: false });
      expect(w.tabState(tabId)).toMatchObject({ site, inCall: false });
    }
  });

  it('popup messages from the popup page, also when it is open in a tab of its own', async () => {
    w = setupWorker();
    expect(await w.popup({ t: 'state', tabId: 3 })).toMatchObject({ connection: 'ok', tab: null });
    w.model.addTab({ id: 3, windowId: 9, url: w.model.extensionSender('popup.html?tab=7').url as string, active: true });
    const sender = { ...w.model.pageSender(3) };
    expect(await w.chrome.runtime.onMessage.dispatch({ t: 'state', tabId: 7 }, sender)).toMatchObject({ connection: 'ok' });
  });
});
