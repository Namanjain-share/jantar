/**
 * The capture loop (spec 3.6) with fake timers:
 * - MP6 (the page's part): before Start the adapter's `blocks()` is never
 *   called and nothing is observed;
 * - MX6 (the page's part): lines wait in the page. With the worker answering
 *   `retry: true` every pending upsert stays and goes again after 2 s; `ok`
 *   drops exactly what was sent (a newer revision stays); `retry: false`
 *   stops notes, drops the map and shows the text; 20,000 waiting stop
 *   notes; the not-answering bubble shows once per outage; captions that
 *   never settle still go at least every 2 s;
 * - the captions state: `none` after 10 s, `notFound` after 60 s on a page
 *   that changed, each with its bubble once, `reading` otherwise; the
 *   tracker is flushed when the region goes;
 * - End sends what waits before it answers; pagehide sends it unawaited.
 */
import type { LineUpsert } from '@jantar/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import type { SiteAdapter } from '../../src/content/adapters/types.js';
import { NOT_ANSWERING, NOT_ANSWERING_MS, NOT_FOUND, PENDING_MAX, UNREACHABLE, createCapture, makeNonce, type Capture, type LinesMessage } from '../../src/content/capture.js';
import type { CaptionsState, LinesAnswer } from '../../src/shared/messages.js';
import { TIMING, WIRE_LIMITS } from '../../src/shared/wire.js';
import { h } from '../fixtures/dom.js';
import { buildMeet, meetUrl, type MeetFixture } from '../fixtures/meet.js';
import { MEETING_MARKER, goTo, settle, watchConsole } from './chrome.js';

type Reply = (msg: LinesMessage) => LinesAnswer | undefined | Promise<LinesAnswer | undefined>;

let capture: Capture | null = null;
let console_: ReturnType<typeof watchConsole>;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-30T10:00:00.000Z') });
  goTo(meetUrl('abc-defg-hij'));
  console_ = watchConsole();
});

afterEach(async () => {
  await capture?.stop();
  capture = null;
  vi.useRealTimers();
  document.body.replaceChildren();
  goTo('/');
  expect(console_.said()).toEqual([]);
});

function capturing(opts: { adapter?: SiteAdapter; reply?: Reply; nonce?: string } = {}) {
  const sent: LinesMessage[] = [];
  const bubbles: string[] = [];
  const states: CaptionsState[] = [];
  const stops: number[] = [];
  const io = { reply: opts.reply ?? (() => ({ ok: true }) as LinesAnswer) };
  capture = createCapture({
    adapter: opts.adapter ?? meetAdapter,
    doc: document,
    send: async (msg) => {
      sent.push(structuredClone(msg));
      return io.reply(msg);
    },
    captions: (s) => states.push(s),
    bubble: (t) => bubbles.push(t),
    onStop: () => stops.push(Date.now()),
    nonce: () => opts.nonce ?? 'testnnce',
  });
  const lines = () => sent.flatMap((m) => m.lines);
  return { sent, bubbles, states, stops, io, lines, capture };
}

/** A change, read after the debounce, then the send timer. */
const afterChange = () => settle(TIMING.debounceMs + 10);

describe('MP6: nothing is read before Start', () => {
  it('never calls blocks() and observes nothing until start()', async () => {
    const meet = buildMeet(document);
    meet.say('Sam', `Before Start ${MEETING_MARKER}`);
    const blocks = vi.spyOn(meetAdapter, 'blocks');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const c = capturing();
    await settle(5 * TIMING.leaveGraceMs);
    meet.say('Priya', 'Still before Start');
    await settle(TIMING.leaveGraceMs);
    expect(blocks).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(c.sent).toEqual([]);
    expect(c.states).toEqual([]);
    c.capture.start();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0]).toBe(meet.region());
    expect(observe.mock.calls[0]![1]).toEqual({ childList: true, characterData: true, subtree: true });
    expect(blocks).toHaveBeenCalled();
  });
});

describe('MX6: lines wait in the page', () => {
  it('sends what changed, at most 200 a message, at most every linesEveryMs, one in flight', async () => {
    const meet = buildMeet(document);
    let release: (() => void) | null = null;
    const c = capturing({ reply: () => new Promise((r) => (release = () => r({ ok: true }))) });
    c.capture.start();
    for (let i = 0; i < 250; i += 1) meet.say(i % 2 ? 'Sam' : 'Priya', `Line ${i} of the long meeting`);
    await afterChange();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.lines).toHaveLength(WIRE_LIMITS.linesPerPost);
    expect(c.sent[0]!.lines[0]).toMatchObject({ lineId: 'testnnce-1', rev: 1, speaker: 'Priya', text: 'Line 0 of the long meeting' });
    // One in flight: nothing more goes until it is answered.
    await settle(5 * TIMING.linesEveryMs);
    expect(c.sent).toHaveLength(1);
    release!();
    await settle(TIMING.linesEveryMs);
    expect(c.sent).toHaveLength(2);
    expect(c.sent[1]!.lines).toHaveLength(50);
    release!();
    await settle(TIMING.linesEveryMs);
    expect(c.capture.pending()).toBe(0);
  });

  it('captions that never settle (a change every 200 ms) still go: a lines message at least every 2 s, not only once the speaker stops', async () => {
    const meet = buildMeet(document);
    const at: number[] = [];
    const c = capturing({
      reply: () => {
        at.push(Date.now());
        return { ok: true };
      },
    });
    c.capture.start();
    const began = Date.now();
    const t = meet.say('Sam', 'So');
    for (let i = 1; i <= 40; i += 1) {
      await settle(200);
      t.grow(`word${i}`);
    }
    const stopped = Date.now();
    expect(at.length).toBeGreaterThanOrEqual(4);
    expect(at[0]! - began).toBeLessThanOrEqual(2_000);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeLessThanOrEqual(2_000);
    expect(stopped - at.at(-1)!).toBeLessThanOrEqual(2_000);
    // Each message carries the words read so far: the turn as it grew, never held back.
    const sizes = c.sent.map((m) => m.lines[0]!.text.split(' ').length);
    expect(sizes).toEqual([...sizes].sort((x, y) => x - y));
    await afterChange();
    await settle(TIMING.linesEveryMs);
    expect(c.lines().at(-1)!.text.split(' ')).toHaveLength(41);
  });

  it('retry: true keeps every pending upsert and sends it again after 2 s; the bubble shows once per outage', async () => {
    const meet = buildMeet(document);
    const c = capturing({ reply: () => ({ ok: false, retry: true }) });
    c.capture.start();
    meet.say('Sam', 'Jantar is restarting');
    await afterChange();
    expect(c.sent).toHaveLength(1);
    await settle(TIMING.linesRetryMs - 50);
    expect(c.sent).toHaveLength(1);
    await settle(100);
    expect(c.sent).toHaveLength(2);
    expect(c.sent[1]).toEqual(c.sent[0]);
    expect(c.capture.pending()).toBe(1);
    expect(c.bubbles).toEqual([]);
    await settle(NOT_ANSWERING_MS);
    expect(c.bubbles).toEqual([NOT_ANSWERING]);
    await settle(10 * NOT_ANSWERING_MS);
    expect(c.bubbles).toEqual([NOT_ANSWERING]);
    // A worker that gives no answer at all is the same as retry.
    c.io.reply = () => undefined;
    await settle(TIMING.linesRetryMs);
    expect(c.capture.pending()).toBe(1);
    // Back: the lines land; the next outage says so again.
    c.io.reply = () => ({ ok: true });
    await settle(TIMING.linesRetryMs);
    expect(c.capture.pending()).toBe(0);
    c.io.reply = () => ({ ok: false, retry: true });
    meet.turns[0]!.grow('and is back.');
    await afterChange();
    await settle(NOT_ANSWERING_MS + TIMING.linesRetryMs);
    expect(c.bubbles).toEqual([NOT_ANSWERING, NOT_ANSWERING]);
    expect(c.capture.on).toBe(true);
  });

  it('ok drops exactly what was sent: a newer revision that arrived meanwhile stays and goes next', async () => {
    const meet = buildMeet(document);
    let release: (() => void) | null = null;
    const c = capturing({ reply: () => new Promise((r) => (release = () => r({ ok: true }))) });
    c.capture.start();
    meet.say('Sam', 'So the plan');
    meet.say('Priya', 'Agreed');
    await afterChange();
    expect(c.sent[0]!.lines.map((l) => [l.lineId, l.rev])).toEqual([
      ['testnnce-1', 1],
      ['testnnce-2', 1],
    ]);
    meet.turns[0]!.grow('for Friday');
    await afterChange();
    release!();
    await settle(0);
    expect(c.capture.pending()).toBe(1);
    await settle(TIMING.linesEveryMs);
    expect(c.sent[1]!.lines).toEqual([{ lineId: 'testnnce-1', rev: 2, speaker: 'Sam', text: 'So the plan for Friday', at: c.sent[0]!.lines[0]!.at }]);
    release!();
    await settle(0);
    expect(c.capture.pending()).toBe(0);
  });

  it('retry: false stops notes, drops the map and shows the text', async () => {
    const meet = buildMeet(document);
    const observe = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const c = capturing({ reply: () => ({ ok: false, retry: false, text: 'Meetings are off. Turn them on at your Mac: jantar meetings on' }) });
    c.capture.start();
    meet.say('Sam', 'Words that will not be kept');
    await afterChange();
    await settle(0);
    expect(c.capture.on).toBe(false);
    expect(c.capture.pending()).toBe(0);
    expect(c.bubbles).toEqual(['Meetings are off. Turn them on at your Mac: jantar meetings on']);
    expect(c.stops).toHaveLength(1);
    expect(observe).toHaveBeenCalled();
    meet.say('Priya', 'Not read any more');
    await settle(10 * TIMING.linesRetryMs);
    expect(c.sent).toHaveLength(1);
  });

  it(`${PENDING_MAX.toLocaleString('en')} waiting upserts stop notes`, async () => {
    const region = h(document, 'div');
    const els = Array.from({ length: PENDING_MAX }, () => h(document, 'div'));
    region.append(...els);
    document.body.append(region);
    const adapter: SiteAdapter = { ...meetAdapter, region: () => region, blocks: () => els.map((el, i) => ({ el, speaker: 'Sam', text: `Line ${i}` })) };
    const c = capturing({ adapter, reply: () => ({ ok: false, retry: true }) });
    c.capture.start();
    await settle(0);
    expect(c.capture.on).toBe(false);
    expect(c.capture.pending()).toBe(0);
    expect(c.bubbles).toEqual([UNREACHABLE]);
    expect(c.stops).toHaveLength(1);
  });
});

describe('the captions state', () => {
  it('none after noCaptionsMs with no region (the howTo bubble, once), then reading', async () => {
    const meet = buildMeet(document, { captions: false });
    const c = capturing();
    c.capture.start();
    await settle(TIMING.noCaptionsMs - TIMING.callPollMs);
    expect(c.states).toEqual([]);
    await settle(TIMING.callPollMs);
    expect(c.states).toEqual(['none']);
    expect(c.bubbles).toEqual([meetAdapter.howTo]);
    await settle(TIMING.notFoundMs);
    expect(c.bubbles).toEqual([meetAdapter.howTo]);
    meet.captionsOn();
    meet.say('Sam', 'Captions are on now');
    await settle(TIMING.callPollMs + 10);
    expect(c.states).toEqual(['none', 'reading']);
    expect(c.lines().map((l) => l.text)).toEqual(['Captions are on now']);
    // Off again: the nudge again, once.
    meet.captionsOff();
    await settle(TIMING.noCaptionsMs + TIMING.callPollMs);
    expect(c.states).toEqual(['none', 'reading', 'none']);
    expect(c.bubbles).toEqual([meetAdapter.howTo, meetAdapter.howTo]);
  });

  it('notFound when the region shows text but nothing reads for notFoundMs (the bubble, once)', async () => {
    // A redesign: the region is there with text, in a shape no candidate knows.
    const region = h(document, 'div', { role: 'region', 'aria-label': 'Captions' }, h(document, 'p', {}, 'Sam: words in a shape nobody knows'));
    document.body.append(buildMeet(document, { captions: false }).root, region);
    const c = capturing();
    c.capture.start();
    await settle(TIMING.notFoundMs - TIMING.callPollMs);
    expect(c.states).toEqual([]);
    await settle(2 * TIMING.callPollMs);
    expect(c.states).toEqual(['notFound']);
    expect(c.bubbles).toEqual([NOT_FOUND]);
    await settle(TIMING.notFoundMs);
    expect(c.bubbles).toEqual([NOT_FOUND]);
    expect(c.sent).toEqual([]);
  });

  it('an empty region (only its controls show text) is neither none nor notFound', async () => {
    buildMeet(document);
    const c = capturing();
    c.capture.start();
    await settle(2 * TIMING.notFoundMs);
    expect(c.states).toEqual([]);
    expect(c.bubbles).toEqual([]);
  });

  it('flushes the tracker when the region goes; a region drawn again is read on, not flushed', async () => {
    const meet = buildMeet(document);
    const c = capturing();
    c.capture.start();
    meet.say('Priya', 'One of them could start next month');
    await afterChange();
    meet.replaceRegion();
    await settle(TIMING.callPollMs);
    meet.turns[0]!.grow('if the budget allows it.');
    await afterChange();
    await settle(TIMING.linesEveryMs);
    expect(c.lines().map((l) => [l.lineId, l.text])).toEqual([
      ['testnnce-1', 'One of them could start next month'],
      ['testnnce-1', 'One of them could start next month if the budget allows it.'],
    ]);
    meet.captionsOff();
    await settle(TIMING.callPollMs);
    meet.captionsOn();
    await settle(TIMING.callPollMs);
    // The same turn after the gap: its line was closed, so a late change is a new line, never a rewrite.
    meet.turns[0]!.set('One of them could start next month if the budget allows it. Or the one after.');
    await afterChange();
    await settle(TIMING.linesEveryMs);
    expect(c.lines().at(-1)).toMatchObject({ lineId: 'testnnce-2', text: 'Or the one after.' });
  });
});

describe('stopping', () => {
  it('End (final) closes the lines and sends what waits before it resolves', async () => {
    const meet = buildMeet(document);
    const c = capturing();
    c.capture.start();
    meet.say('Sam', 'The last words');
    // Still in its debounce when End comes.
    await settle(10);
    let done = false;
    const stopping = c.capture.stop({ final: true }).then(() => (done = true));
    await settle(0);
    await stopping;
    expect(done).toBe(true);
    expect(c.lines().map((l) => l.text)).toEqual(['The last words']);
    expect(c.capture.on).toBe(false);
    expect(c.capture.pending()).toBe(0);
  });

  it('End waits for the lines already in flight, and gives up at the first refusal', async () => {
    const meet = buildMeet(document);
    let release: (() => void) | null = null;
    const c = capturing({ reply: () => new Promise((r) => (release = () => r({ ok: true }))) });
    c.capture.start();
    meet.say('Sam', 'In flight');
    await afterChange();
    meet.say('Priya', 'Still waiting');
    await afterChange();
    c.io.reply = () => ({ ok: false, retry: true });
    const stopping = c.capture.stop({ final: true });
    await settle(0);
    expect(c.sent).toHaveLength(1);
    release!();
    await stopping;
    expect(c.sent.map((m) => m.lines.map((l) => l.text))).toEqual([['In flight'], ['Still waiting']]);
    expect(c.bubbles).toEqual([]);
    expect(c.capture.pending()).toBe(0);
  });

  it('a stop with a reason drops what waits and shows it', async () => {
    const meet = buildMeet(document);
    const c = capturing({ reply: () => ({ ok: false, retry: true }) });
    c.capture.start();
    meet.say('Sam', 'Waiting');
    await afterChange();
    await c.capture.stop({ text: 'This meeting was deleted on your phone.' });
    expect(c.capture.pending()).toBe(0);
    expect(c.bubbles).toEqual(['This meeting was deleted on your phone.']);
    await settle(10 * TIMING.linesRetryMs);
    expect(c.sent).toHaveLength(1);
  });

  it('pagehide sends what waits once, without waiting for an answer', async () => {
    const meet = buildMeet(document);
    const c = capturing({ reply: () => new Promise(() => undefined) });
    c.capture.start();
    meet.say('Sam', 'First');
    await afterChange();
    meet.say('Priya', 'Said as the tab closes');
    c.capture.last();
    expect(c.sent.map((m) => m.lines.map((l) => l.text))).toEqual([['First'], ['First', 'Said as the tab closes']]);
  });

  it('every start reads with a new nonce: a resumed page never reuses a line id', async () => {
    const meet = buildMeet(document);
    const nonces = ['aaaaaaaa', 'bbbbbbbb'];
    const sent: LineUpsert[] = [];
    capture = createCapture({
      adapter: meetAdapter,
      doc: document,
      send: async (m) => {
        sent.push(...m.lines);
        return { ok: true };
      },
      captions: () => undefined,
      bubble: () => undefined,
      nonce: () => nonces.shift()!,
    });
    meet.say('Sam', 'One');
    capture.start();
    await afterChange();
    await capture.stop({ final: true });
    meet.say('Sam', 'Two');
    capture.start();
    await settle(TIMING.linesEveryMs);
    expect(sent.map((l) => l.lineId)).toEqual(['aaaaaaaa-1', 'bbbbbbbb-1', 'bbbbbbbb-2']);
  });

  it('a new Start while End still sends its last lines: the two runs never mix', async () => {
    const meet = buildMeet(document);
    const nonces = ['oldnonce', 'newnonce'];
    const sent: LinesMessage[] = [];
    let release: (() => void) | null = null;
    capture = createCapture({
      adapter: meetAdapter,
      doc: document,
      send: async (m) => {
        sent.push(structuredClone(m));
        if (sent.length === 1) await new Promise<void>((r) => (release = r));
        return { ok: true };
      },
      captions: () => undefined,
      bubble: () => undefined,
      nonce: () => nonces.shift()!,
    });
    capture.start();
    meet.say('Sam', 'Old meeting words');
    await afterChange();
    meet.say('Priya', 'More old words');
    await afterChange();
    const ending = capture.stop({ final: true });
    capture.start();
    meet.say('Alex', 'New meeting words');
    release!();
    await ending;
    await settle(TIMING.linesEveryMs);
    expect(capture.on).toBe(true);
    for (const m of sent) expect(new Set(m.lines.map((l) => l.lineId.split('-')[0])).size).toBe(1);
    expect(sent.flatMap((m) => m.lines.filter((l) => l.lineId.startsWith('oldnonce')).map((l) => l.text))).toEqual(['Old meeting words', 'More old words']);
    expect(sent.flatMap((m) => m.lines.filter((l) => l.lineId.startsWith('newnonce')).map((l) => l.text))).toContain('New meeting words');
  });

  it('makeNonce gives 8 characters a line id may hold, different each time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeNonce()));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(n).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});

describe('a Meet page with the fixtures', () => {
  it('reads what the driver says, and nothing outside the region', async () => {
    const meet: MeetFixture = buildMeet(document);
    document.body.append(h(document, 'div', { class: 'chat' }, h(document, 'div', { class: 'ygicle' }, 'A chat message, not a caption')));
    const c = capturing();
    c.capture.start();
    meet.say('Sam', 'Only captions are read');
    await afterChange();
    expect(c.lines().map((l) => l.text)).toEqual(['Only captions are read']);
  });
});
