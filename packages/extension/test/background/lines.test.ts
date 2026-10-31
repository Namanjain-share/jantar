/**
 * MX6 and MP6, the worker's part: caption lines go from the page to the
 * daemon one post per message, and the answer says what the page does with
 * them. No answer, a 5xx or a 429 keep them (retry); a 404 clears the tab's
 * meeting and stops notes; a 401 forgets the key; a 400 or 413 is the
 * mismatch. A message too big for the route's body limit goes as more than
 * one post. No lines ever go for a meeting a screenshot made before Start.
 */
import { MEETING_MARKER, extLinesBody, lineUpsert, transcriptLines } from '@jantar/fixtures';
import { MAX_BODY_BYTES } from '@jantar/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { LINES_POST_BYTES, linePosts } from '../../src/background/lines.js';
import { MISMATCH, NOT_OPEN, PAIR_AGAIN } from '../../src/background/sentences.js';
import { daemonError, markerIn, setupWorker, watchConsole, type WorkerUnderTest } from './chrome.js';

let w: WorkerUnderTest;
let watched: ReturnType<typeof watchConsole>;
afterEach(() => {
  // MP7: caption text and speakers never reach the console.
  expect(markerIn(watched.text())).toBe(false);
  w?.close();
});

const LINES = extLinesBody(3, { marked: true }).lines;

/** A Meet tab in a call whose notes are on. */
async function noting(tabId = 7) {
  await w.meetTab(tabId);
  expect(await w.popup({ t: 'start', tabId, name: 'Weekly sync', autoTodos: false })).toEqual({ ok: true });
  return w.tabState(tabId)?.clientId as string;
}

describe('lines from the page', () => {
  it("become one post for the tab's meeting; 2xx is ok", async () => {
    w = setupWorker();
    watched = watchConsole();
    const clientId = await noting();
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: true });
    expect(w.daemon.of('lines')).toEqual([expect.objectContaining({ clientId, body: { lines: LINES } })]);
    expect(JSON.stringify(w.daemon.of('lines')[0]?.body)).toContain(MEETING_MARKER);
  });

  it('carry only the five fields the daemon takes', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    await w.page(7, { t: 'lines', lines: [{ ...lineUpsert(), final: true, html: '<b>x</b>' }] });
    expect(w.daemon.of('lines')[0]?.body).toEqual({ lines: [lineUpsert()] });
  });

  it('wait in the page when Jantar does not answer, answers 5xx or 429', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    for (const answer of ['down', daemonError(500, 'internal'), daemonError(503, 'Meetings data could not be opened.'), daemonError(429, 'too many requests')] as const) {
      w.daemon.on('lines', answer);
      expect(await w.page(7, { t: 'lines', lines: LINES }), JSON.stringify(answer)).toEqual({ ok: false, retry: true });
    }
    expect(w.tabState(7)).toMatchObject({ notes: true });
  });

  it("a 404 clears the tab's meeting and stops notes with the sentence; no new meeting is made", async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    w.daemon.on('lines', daemonError(404, NOT_OPEN));
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false, text: NOT_OPEN });
    expect(w.tabState(7)?.clientId).toBeUndefined();
    expect(w.tabState(7)).toMatchObject({ notes: false });
    expect(w.daemon.of('open')).toHaveLength(1);
    expect(await w.page(7, { t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Weekly sync' })).toEqual({ button: true, notes: false });
  });

  it("a 403 or 409 stops notes with the daemon's sentence and keeps the meeting", async () => {
    w = setupWorker();
    watched = watchConsole();
    const clientId = await noting();
    w.daemon.on('lines', daemonError(403, 'Meetings are off. Turn them on at your Mac: jantar meetings on'));
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false, text: 'Meetings are off. Turn them on at your Mac: jantar meetings on' });
    expect(w.tabState(7)).toMatchObject({ clientId, notes: false });
    // The page's next keep-alive does not turn notes back on.
    expect(await w.page(7, { t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Weekly sync' })).toEqual({ button: true, notes: false });
    await w.popup({ t: 'start', tabId: 7, name: 'Weekly sync', autoTodos: false });
    w.daemon.on('lines', daemonError(409, 'This meeting has 20,000 lines; notes stopped.'));
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false, text: 'This meeting has 20,000 lines; notes stopped.' });
  });

  it('a 401 forgets the key: notes stop with "Pair again" and the button goes', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    w.daemon.on('lines', daemonError(401, 'The Jantar extension is not paired.'));
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false, text: PAIR_AGAIN });
    expect(await w.keys.get()).toBeNull();
    expect(w.toPage(7)).toContainEqual({ t: 'button', on: false });
    expect(w.tabState(7)?.clientId).toBeUndefined();
  });

  it('a 400 is the mismatch sentence', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    w.daemon.on('lines', daemonError(400, 'body/lines/0/rev: Invalid input'));
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false, text: MISMATCH });
  });

  it('a 413 is the mismatch sentence', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    w.daemon.on('lines', daemonError(413, 'request body is larger than 64 KB'));
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false, text: MISMATCH });
  });

  it('MP6: nothing goes for a meeting a screenshot made before Start, or for a tab with no meeting', async () => {
    w = setupWorker();
    watched = watchConsole();
    await w.meetTab(7);
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false });
    expect(await w.page(7, { t: 'shot' })).toEqual({ ok: true, text: 'Saved' });
    expect(w.daemon.of('open')[0]?.body).toMatchObject({ captions: false });
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false });
    expect(w.daemon.of('lines')).toEqual([]);
  });

  it('after End, a late post goes nowhere', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    await w.popup({ t: 'end', tabId: 7 });
    expect(await w.page(7, { t: 'lines', lines: LINES })).toEqual({ ok: false, retry: false });
    expect(w.daemon.of('lines')).toEqual([]);
  });
});

describe('a message too big for one post (a catch-up after an outage)', () => {
  /** The bytes a post's body takes on the wire. */
  const bytesOf = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).length;

  it("goes as posts under the route's 64 KB body limit, every line once and in order", async () => {
    expect(LINES_POST_BYTES).toBeLessThan(MAX_BODY_BYTES);
    w = setupWorker();
    watched = watchConsole();
    const clientId = await noting();
    // 200 lines of 4,000 characters: the most one page message holds.
    const lines = transcriptLines(200, { chars: 4_000, marked: true });
    expect(await w.page(7, { t: 'lines', lines })).toEqual({ ok: true });
    const posts = w.daemon.of('lines');
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) {
      expect(p.clientId).toBe(clientId);
      expect(bytesOf(p.body)).toBeLessThanOrEqual(LINES_POST_BYTES);
    }
    expect(posts.flatMap((p) => (p.body as { lines: unknown[] }).lines)).toEqual(lines);
  });

  it('counts bytes, not characters: three-byte text splits sooner', () => {
    const wide = transcriptLines(40, { chars: 2_000 }).map((l) => ({ ...l, text: '会'.repeat(2_000) }));
    const posts = linePosts(wide);
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) expect(bytesOf({ lines: p })).toBeLessThanOrEqual(LINES_POST_BYTES);
    expect(posts.flat()).toEqual(wide);
  });

  it('a small message and an empty one are one post', () => {
    expect(linePosts(LINES)).toEqual([LINES]);
    expect(linePosts([])).toEqual([[]]);
  });

  it('the first post that is not ok is the answer; the page sends them all again (upserts)', async () => {
    w = setupWorker();
    watched = watchConsole();
    await noting();
    const lines = transcriptLines(200, { chars: 4_000 });
    w.daemon.on('lines', { status: 200, body: { ok: true } }, 'down');
    expect(await w.page(7, { t: 'lines', lines })).toEqual({ ok: false, retry: true });
    expect(w.daemon.of('lines')).toHaveLength(2);
  });
});
