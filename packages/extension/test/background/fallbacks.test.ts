/**
 * What each message answers when its handler fails in a way it never
 * should (storage or the key store throwing): the page's `call` takes the
 * button and notes away, `lines` keeps the lines for a retry, a screenshot
 * says "Not saved: try again.", the popup's `state` reads as Jantar down
 * and its other messages say "Something went wrong. Try again.". Every
 * accepted message is answered.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SHOT, TRY_AGAIN } from '../../src/background/sentences.js';
import { MEET_CODE, setupWorker, type WorkerUnderTest } from './chrome.js';

let w: WorkerUnderTest;
afterEach(() => w?.close());

const broken = async (): Promise<never> => {
  throw new Error('broken');
};

/** chrome.storage.session fails from now on. */
function breakStorage(): void {
  w.chrome.storage.session.get = broken;
  w.chrome.storage.session.set = broken;
}

describe('from the page', () => {
  it('call: no button and no notes', async () => {
    w = setupWorker();
    await w.meetTab(7);
    breakStorage();
    expect(await w.page(7, { t: 'call', site: 'meet', inCall: true, callKey: MEET_CODE, title: 'Weekly sync' })).toEqual({ button: false, notes: false });
  });

  it('lines: kept in the page for a retry', async () => {
    w = setupWorker();
    await w.meetTab(7);
    breakStorage();
    expect(await w.page(7, { t: 'lines', lines: [] })).toEqual({ ok: false, retry: true });
  });

  it('a screenshot: "Not saved: try again."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.keys.get = broken;
    expect(await w.page(7, { t: 'shot' })).toEqual({ ok: false, text: SHOT.tryAgain });
    expect(w.model.captures).toEqual([]);
  });

  it('captions: answered with nothing', async () => {
    w = setupWorker();
    await w.meetTab(7);
    breakStorage();
    expect(await w.page(7, { t: 'captions', state: 'reading' })).toBeUndefined();
  });
});

describe('from the popup', () => {
  it('state: Jantar down, nothing known', async () => {
    w = setupWorker();
    w.keys.get = broken;
    expect(await w.popup({ t: 'state', tabId: 7 })).toEqual({ connection: 'down', pageButton: false, projects: null, tab: null, lastShot: null, shortcut: '', reads: false });
  });

  it('start, end, pair and unpair: "Something went wrong. Try again."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    breakStorage();
    w.keys.set = broken;
    w.keys.clear = broken;
    expect(await w.popup({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false })).toEqual({ ok: false, error: TRY_AGAIN });
    expect(await w.popup({ t: 'end', tabId: 7 })).toEqual({ ok: false, error: TRY_AGAIN });
    expect(await w.popup({ t: 'unpair' })).toEqual({ ok: false, error: TRY_AGAIN });
    expect(await w.popup({ t: 'pair', text: 'jantar-ext:47123:C0DEc0de_C0DE-c0deC0' })).toEqual({ ok: false, error: TRY_AGAIN });
  });

  it('a screenshot: "Not saved: try again."', async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.keys.get = broken;
    expect(await w.popup({ t: 'shot', tabId: 7 })).toEqual({ ok: false, text: SHOT.tryAgain });
  });
});
