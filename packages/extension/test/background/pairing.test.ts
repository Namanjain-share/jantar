/**
 * Pairing in the worker (spec 3.10) and MP9: the pasted line is parsed as
 * the spec says, the code is claimed on that port, and `{ port, key }` is
 * kept in the KeyStore only (never in chrome.storage); every known tab
 * hears `button` after a pair, an unpair or a 401. Also the popup's
 * `state` answer: the connection from the info read, the projects, the
 * page-button grant and the tab.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parsePairLine } from '../../src/background/pairing.js';
import { BAD_CODE, MISMATCH, NOT_RUNNING, PAIR_AGAIN } from '../../src/background/sentences.js';
import { EXTENSION_KEY_HEADER } from '../../src/shared/wire.js';
import { KEY, PORT, ULID, daemonError, setupWorker, watchConsole, type WorkerUnderTest } from './chrome.js';

const CODE = 'C0DEc0de_C0DE-c0deC0';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole> | undefined;
afterEach(() => {
  // The key and the code never reach the console.
  if (watched) {
    expect(watched.text()).not.toContain(KEY);
    expect(watched.text()).not.toContain(CODE);
  }
  watched = undefined;
  w?.close();
});

describe('parsePairLine', () => {
  it('reads jantar-ext:<port>:<code>, whitespace trimmed', () => {
    expect(parsePairLine(`  jantar-ext:7421:${CODE}\n`)).toEqual({ port: 7421, code: CODE });
    expect(parsePairLine(`jantar-ext:80:${'a'.repeat(128)}`)).toEqual({ port: 80, code: 'a'.repeat(128) });
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      CODE,
      `jantar-ext:7421:short`,
      `jantar-ext:7421:${'a'.repeat(129)}`,
      `jantar-ext:7:${CODE}`,
      `jantar-ext:99999:${CODE}`,
      `jantar-ext:742100:${CODE}`,
      `jantar-ext:7421:${CODE} extra`,
      `jantar:7421:${CODE}`,
      `http://127.0.0.1:7421/pair#c=${CODE}`,
      `jantar-ext:7421:${CODE.slice(0, 10)}!${CODE.slice(10)}`,
      7421,
      null,
    ]) {
      expect(parsePairLine(bad), String(bad)).toBeNull();
    }
  });
});

describe('pair', () => {
  it('claims the code on that port, keeps { port, key } in the key store only, and shows the button', async () => {
    w = setupWorker({ paired: false });
    watched = watchConsole();
    await w.meetTab(7);
    expect(w.toPage(7)).toEqual([]);
    expect(await w.popup({ t: 'pair', text: ` jantar-ext:${PORT + 1}:${CODE} ` })).toEqual({ ok: true });
    const [claim] = w.daemon.calls;
    expect(claim).toMatchObject({ op: 'claim', method: 'POST', url: `http://127.0.0.1:${PORT + 1}/v1/ext/pair`, credentials: 'omit', body: { code: CODE } });
    expect(claim?.headers[EXTENSION_KEY_HEADER]).toBeUndefined();
    expect(await w.keys.get()).toMatchObject({ port: PORT + 1, key: KEY });
    expect(w.toPage(7)).toEqual([{ t: 'button', on: true }]);
    // MP9: the key is never in chrome.storage.
    expect(JSON.stringify([...w.model.session.entries()])).not.toContain(KEY);
    // And it goes, in its header, with every capture call from now on.
    await w.popup({ t: 'state', tabId: 7 });
    expect(w.daemon.of('info')[0]).toMatchObject({ url: `http://127.0.0.1:${PORT + 1}/v1/ext/info` });
    expect(w.daemon.of('info')[0]?.headers[EXTENSION_KEY_HEADER]).toBe(KEY);
  });

  it('a line that is not a pairing line never reaches the daemon', async () => {
    w = setupWorker({ paired: false });
    expect(await w.popup({ t: 'pair', text: 'hello' })).toEqual({ ok: false, error: BAD_CODE });
    expect(w.daemon.calls).toEqual([]);
  });

  it('a wrong or expired code, Jantar down, too many tries', async () => {
    w = setupWorker({ paired: false });
    w.daemon.on('claim', daemonError(403, 'that code is not valid'));
    expect(await w.popup({ t: 'pair', text: `jantar-ext:${PORT}:${CODE}` })).toEqual({ ok: false, error: BAD_CODE });
    w.daemon.on('claim', 'down');
    expect(await w.popup({ t: 'pair', text: `jantar-ext:${PORT}:${CODE}` })).toEqual({ ok: false, error: NOT_RUNNING });
    w.daemon.on('claim', daemonError(429, 'too many pairing attempts; wait a minute and try again'));
    expect(await w.popup({ t: 'pair', text: `jantar-ext:${PORT}:${CODE}` })).toEqual({ ok: false, error: 'too many pairing attempts; wait a minute and try again' });
    w.daemon.on('claim', { status: 200, body: { id: ULID, key: 'bad key with spaces' } });
    expect(await w.popup({ t: 'pair', text: `jantar-ext:${PORT}:${CODE}` })).toEqual({ ok: false, error: BAD_CODE });
    expect(await w.keys.get()).toBeNull();
  });
});

describe('unpair', () => {
  it("ends each tab's meeting as End does, then forgets the key here, stops notes and takes the button away", async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.meetTab(8, { windowId: 2 });
    await w.meetTab(9, { windowId: 3 });
    await w.popup({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false });
    await w.page(9, { t: 'shot' });
    const noting = w.tabState(7)?.clientId;
    const shotOnly = w.tabState(9)?.clientId;
    expect(await w.popup({ t: 'unpair' })).toEqual({ ok: true });
    expect(await w.keys.get()).toBeNull();
    // Ended with the key that still worked: reason user, so the summary comes now rather than at the stale sweep.
    const ends = w.daemon.of('end');
    expect(ends.map((c) => c.clientId).sort()).toEqual([noting, shotOnly].sort());
    for (const end of ends) expect(end.body).toMatchObject({ reason: 'user' });
    expect(ends.every((c) => c.headers['x-jantar-extension-key'] !== undefined)).toBe(true);
    expect(w.toPage(7).slice(-2)).toEqual([{ t: 'capture', on: false }, { t: 'button', on: false }]);
    expect(w.toPage(8)).toEqual([{ t: 'button', on: false }]);
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.tabState(9)?.clientId).toBeUndefined();
    // The daemon side is `jantar meetings unpair`: nothing else was called for it.
    expect(w.daemon.ops().filter((op) => op !== 'end')).toEqual(['open', 'open', 'shot']);
    expect(await w.page(7, { t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'x' })).toEqual({ button: false, notes: false });
  });

  it('goes on when Jantar does not take the end', async () => {
    w = setupWorker();
    await w.meetTab(7);
    await w.popup({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false });
    w.daemon.on('end', 'down');
    expect(await w.popup({ t: 'unpair' })).toEqual({ ok: true });
    expect(await w.keys.get()).toBeNull();
    expect(w.daemon.of('end')).toHaveLength(1);
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.toPage(7).at(-1)).toEqual({ t: 'button', on: false });
  });
});

describe('the popup state', () => {
  it('connected: the projects, the page-button grant and the tab', async () => {
    w = setupWorker();
    w.daemon.on('info', { status: 200, body: { projects: [{ id: ULID, name: 'Acme site', emoji: '🚀' }, { id: '01JFZ8X8Y3T0V5G9WQK2M4N6QR', name: 'Home' }] } });
    await w.meetTab(7, { title: 'Weekly sync' });
    const at = w.clock.t;
    await w.page(7, { t: 'shot' });
    w.model.shortcut = '⌥⇧S';
    expect(await w.popup({ t: 'state', tabId: 7 })).toEqual({
      connection: 'ok',
      pageButton: false,
      projects: [{ id: ULID, name: 'Acme site', emoji: '🚀' }, { id: '01JFZ8X8Y3T0V5G9WQK2M4N6QR', name: 'Home' }],
      tab: { site: 'meet', inCall: true, title: 'Weekly sync', name: 'Weekly sync', notes: false, shots: 1, captions: 'unknown' },
      lastShot: { at, from: 'page', tabId: 7, ok: true, text: 'Saved', step: 'saved' },
      shortcut: '⌥⇧S',
    });
    w.model.granted.add('<all_urls>');
    await w.page(7, { t: 'captions', state: 'reading' });
    expect(await w.popup({ t: 'state', tabId: 7 })).toMatchObject({ pageButton: true, tab: { captions: 'reading' } });
  });

  it("v0.5.3: the last try in any tab and Chrome's shortcut; a record that is not one reads as none, a shortcut Chrome will not list as ''", async () => {
    w = setupWorker();
    await w.meetTab(7);
    w.model.failCapture('permission');
    await w.page(7, { t: 'shot' });
    // Asked from another tab: the record is the last try anywhere.
    expect(await w.popup({ t: 'state', tabId: 3 })).toMatchObject({ lastShot: { tabId: 7, from: 'page', ok: false, step: 'grant' }, shortcut: '' });
    w.model.session.set('lastShot', { at: 'now', from: 'page', tabId: 7, ok: false, text: 'x', step: 'grant' });
    w.model.shortcut = 'Alt+Shift+S';
    expect(await w.popup({ t: 'state', tabId: 3 })).toMatchObject({ lastShot: null, shortcut: 'Alt+Shift+S' });
    w.model.session.set('lastShot', { at: 1, from: 'page', tabId: 7, ok: true, text: 'Saved', step: 'minimized' });
    w.chrome.commands.getAll = async () => {
      throw new Error('broken');
    };
    expect(await w.popup({ t: 'state', tabId: 3 })).toMatchObject({ connection: 'ok', lastShot: null, shortcut: '' });
  });

  it('projects null while Todos are off; no tab for a tab that is not a meeting tab', async () => {
    w = setupWorker();
    w.daemon.on('info', { status: 200, body: { projects: null } });
    expect(await w.popup({ t: 'state', tabId: 3 })).toEqual({ connection: 'ok', pageButton: false, projects: null, tab: null, lastShot: null, shortcut: '' });
  });

  it('not paired: no daemon call', async () => {
    w = setupWorker({ paired: false });
    expect(await w.popup({ t: 'state', tabId: 3 })).toEqual({ connection: 'unpaired', pageButton: false, projects: null, tab: null, lastShot: null, shortcut: '' });
    expect(w.daemon.calls).toEqual([]);
  });

  it('each answer of the info read: 401 unpaired, every 403 off, the rest down', async () => {
    w = setupWorker();
    const cases = [
      [daemonError(403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'), { connection: 'off', sentence: 'Meetings are off. Turn them on at your Mac: jantar meetings on' }],
      [daemonError(403, 'only the Jantar extension on this Mac can call this'), { connection: 'off', sentence: 'only the Jantar extension on this Mac can call this' }],
      ['down', { connection: 'down' }],
      [daemonError(400, 'bad'), { connection: 'down', sentence: MISMATCH }],
      [daemonError(429, 'too many requests'), { connection: 'down', sentence: 'too many requests' }],
      [daemonError(503, 'Meetings data could not be opened. The file is untouched.'), { connection: 'down', sentence: 'Meetings data could not be opened. The file is untouched.' }],
      [daemonError(401, 'The Jantar extension is not paired.'), { connection: 'unpaired', sentence: PAIR_AGAIN }],
    ] as const;
    for (const [answer, want] of cases) {
      w.daemon.on('info', answer);
      const state = (await w.popup({ t: 'state', tabId: 3 })) as Record<string, unknown>;
      expect({ connection: state.connection, sentence: state.sentence }, JSON.stringify(answer)).toEqual({ sentence: undefined, ...want });
      expect(state.projects).toBeNull();
    }
    expect(await w.keys.get()).toBeNull();
  });
});
