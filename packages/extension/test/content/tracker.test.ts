/**
 * MX4: the tracker on the synthetic mutation scripts (research 3's edge
 * table, word-boundary revisions near the front, new items that share a
 * word or a line end with a gone one): the right final lines, no
 * duplicates, the right speakers, and a page reload (a new nonce) never
 * reuses a line id. Plus the wire's limits, the revision and takeover
 * rules, and the 9.5 gate (a scan over 300 blocks, the first one too).
 */
import type { LineUpsert } from '@jantar/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import type { Block } from '../../src/content/adapters/types.js';
import { ADOPT_LOOKBACK, IDLE_MS, RESET_SHRINK, SETTLE_MS, createTracker } from '../../src/content/tracker.js';
import { WIRE_LIMITS } from '../../src/shared/wire.js';
import { h } from '../fixtures/dom.js';
import { buildMeet, meetUrl } from '../fixtures/meet.js';
import { SCRIPTS, type MutationScript } from '../fixtures/scripts.js';
import { MEETING_MARKER, goTo, watchConsole } from './chrome.js';

const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const LINE_ID = /^[A-Za-z0-9_-]{1,40}$/;
let console_: ReturnType<typeof watchConsole>;

beforeEach(() => {
  console_ = watchConsole();
});

afterEach(() => {
  // MP7: nothing the tracker or the adapters do writes to the console.
  expect(console_.said().join('\n')).not.toContain(MEETING_MARKER);
  expect(console_.said()).toEqual([]);
  document.body.replaceChildren();
  goTo('/');
});

/** Every upsert a run sent, checked as the daemon would take them, and the final line per id. */
class Sent {
  readonly all: LineUpsert[] = [];
  readonly lines = new Map<string, LineUpsert>();
  take(ups: readonly LineUpsert[]): LineUpsert[] {
    for (const up of ups) {
      expect(up.lineId).toMatch(LINE_ID);
      expect(up.text.length).toBeGreaterThan(0);
      expect(up.text.length).toBeLessThanOrEqual(WIRE_LIMITS.lineText);
      expect(up.speaker.length).toBeLessThanOrEqual(WIRE_LIMITS.speaker);
      const had = this.lines.get(up.lineId);
      // The revision only ever moves on, by one per change; the first-seen time never moves.
      if (had) {
        expect(up.rev).toBeGreaterThan(had.rev);
        expect(up.at).toBe(had.at);
      } else expect(up.rev).toBe(1);
      this.lines.set(up.lineId, up);
      this.all.push(up);
    }
    return [...ups];
  }
  /** The final lines in the order they were first seen. */
  final(): LineUpsert[] {
    const n = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1));
    return [...this.lines.values()].sort((a, b) => n(a.lineId) - n(b.lineId));
  }
}

/** Run a script as the capture loop would: re-find the region after each step, flush when it goes, scan it. */
function play(s: MutationScript, nonce = 'n0nce123'): Sent {
  if (s.site === 'meet') goTo(meetUrl('abc-defg-hij'));
  const adapter = s.site === 'meet' ? meetAdapter : teamsAdapter;
  const fx = s.build(document);
  const tracker = createTracker({ nonce });
  const sent = new Sent();
  let region: Element | null = null;
  let now = T0;
  for (const step of s.steps) {
    now += step.wait;
    step.run(fx);
    const r = adapter.region(document);
    if (region && !r) tracker.flush();
    region = r;
    if (r) sent.take(tracker.scan(adapter.blocks(r), now));
  }
  return sent;
}

describe('MX4: the mutation scripts', () => {
  it.each(SCRIPTS.map((s) => [s.name, s] as const))('%s', (_name, script) => {
    const sent = play(script);
    const final = sent.final();
    expect(final.map((l) => ({ speaker: l.speaker, text: l.text }))).toEqual(script.expect);
    // No duplicates: no text is the same line twice.
    expect(new Set(final.map((l) => l.text)).size).toBe(final.length);
    for (const l of final) expect(l.lineId.startsWith('n0nce123-')).toBe(true);
  });

  it('a page reload (a new nonce) never reuses a line id', () => {
    const script = SCRIPTS.find((s) => s.name === 'a new speaker')!;
    const first = play(script, 'aaaaaaaa');
    document.body.replaceChildren();
    const again = play(script, 'bbbbbbbb');
    const ids = new Set(first.final().map((l) => l.lineId));
    expect(again.final().some((l) => ids.has(l.lineId))).toBe(false);
    expect(again.final().map((l) => l.text)).toEqual(first.final().map((l) => l.text));
  });

  it('a line is sent while it grows, not only once it is final', () => {
    const sent = play(SCRIPTS.find((s) => s.name === 'grow')!);
    expect(sent.all.map((u) => [u.rev, u.text])).toEqual([
      [1, 'So the plan'],
      [2, 'So the plan for Friday is'],
      [3, 'So the plan for Friday is to ship the new site.'],
    ]);
  });
});

describe('the tracker', () => {
  const block = (el: Element, speaker: string | null, text: string): Block => ({ el, speaker, text });
  const els = (n: number) => {
    const list = h(document, 'div');
    document.body.append(list);
    return Array.from({ length: n }, () => {
      const el = h(document, 'div');
      list.append(el);
      return el;
    });
  };

  it('sends nothing for a scan that changed nothing, and collapses whitespace', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    const first = t.scan([block(a!, '  Sam ', '  So   the\nplan ')], T0);
    expect(first).toEqual([{ lineId: 'abcdefgh-1', rev: 1, speaker: 'Sam', text: 'So the plan', at: T0 }]);
    expect(t.scan([block(a!, 'Sam', 'So the plan')], T0 + 1_000)).toEqual([]);
  });

  it('keeps "You", fills in "Unknown" and a borrowed name once the real name comes', () => {
    const [a, b, c] = els(3);
    const t = createTracker({ nonce: 'abcdefgh' });
    const one = t.scan([block(a!, null, 'Hello there'), block(b!, 'You', 'Hi'), block(c!, '', 'Who is this?')], T0);
    expect(one.map((u) => u.speaker)).toEqual(['Unknown', 'You', 'You']);
    const two = t.scan([block(a!, 'Alex', 'Hello there'), block(b!, 'You', 'Hi'), block(c!, 'Priya', 'Who is this?')], T0 + 500);
    expect(two.map((u) => [u.lineId, u.rev, u.speaker])).toEqual([
      ['abcdefgh-1', 2, 'Alex'],
      ['abcdefgh-3', 2, 'Priya'],
    ]);
  });

  it('a shrink of more than RESET_SHRINK on one element is a reset, even when the new words would align', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    const long = `${'word '.repeat(60)}and the end of it`;
    expect(long.length).toBeGreaterThan(RESET_SHRINK + 20);
    t.scan([block(a!, 'Sam', long)], T0);
    // "of it" sits at the end of the old text: aligning would glue the new words onto the old line.
    const ups = t.scan([block(a!, 'Sam', 'of it and more')], T0 + 500);
    expect(ups.map((u) => [u.lineId, u.rev, u.text])).toEqual([['abcdefgh-2', 1, 'of it and more']]);
  });

  it('a line followed by a newer block settles after SETTLE_MS; the newest one only after IDLE_MS', () => {
    const [a, b] = els(2);
    const t = createTracker({ nonce: 'abcdefgh' });
    t.scan([block(a!, 'Sam', 'First words here'), block(b!, 'Priya', 'Second')], T0);
    // Within the settle time, a correction lands on Sam's line.
    expect(t.scan([block(a!, 'Sam', 'First words here too'), block(b!, 'Priya', 'Second')], T0 + SETTLE_MS - 1).map((u) => u.lineId)).toEqual(['abcdefgh-1']);
    // Past it, a correction to the older block is dropped.
    expect(t.scan([block(a!, 'Sam', 'First words here too, fixed'), block(b!, 'Priya', 'Second')], T0 + 2 * SETTLE_MS + 1)).toEqual([]);
    // The newest block still takes changes until IDLE_MS.
    expect(t.scan([block(a!, 'Sam', 'First words here too'), block(b!, 'Priya', 'Second line')], T0 + IDLE_MS - 1).map((u) => u.lineId)).toEqual(['abcdefgh-2']);
  });

  it('flush closes every line: the same element then only starts a new line for new words', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    t.scan([block(a!, 'Sam', 'Before the gap')], T0);
    t.flush();
    expect(t.scan([block(a!, 'Sam', 'Before the gap')], T0 + 100)).toEqual([]);
    expect(t.scan([block(a!, 'Sam', 'Before the gap and after it')], T0 + 200).map((u) => [u.lineId, u.text])).toEqual([['abcdefgh-2', 'and after it']]);
  });

  it('the same words on screen twice are two lines (adoption only takes a line whose element is gone)', () => {
    const [a, b] = els(2);
    const t = createTracker({ nonce: 'abcdefgh' });
    const said = 'Yes, that sounds right to me.';
    t.scan([block(a!, 'Sam', said)], T0);
    expect(t.scan([block(a!, 'Sam', said), block(b!, 'Sam', said)], T0 + 3_000).map((u) => [u.lineId, u.text])).toEqual([['abcdefgh-2', said]]);
  });

  it('a remounted element takes its old line; a short one ("Yes.") may genuinely repeat', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    t.scan([block(a!, 'Sam', 'The budget is approved for this quarter')], T0);
    a!.remove();
    expect(t.scan([], T0 + 500)).toEqual([]);
    const [again] = els(1);
    expect(t.scan([block(again!, 'Sam', 'The budget is approved for this quarter')], T0 + 1_000)).toEqual([]);
    const [yes] = els(1);
    t.scan([block(yes!, 'Sam', 'Yes.')], T0 + 1_500);
    yes!.remove();
    t.scan([], T0 + 2_000);
    const [yesAgain] = els(1);
    expect(t.scan([block(yesAgain!, 'Sam', 'Yes.')], T0 + 2_500).map((u) => u.text)).toEqual(['Yes.']);
  });

  it('an element that takes over a closed line keeps its own words: those past the line are a new line, even with a newer block after it', () => {
    const [a, b] = els(2);
    const t = createTracker({ nonce: 'abcdefgh' });
    const said = 'First we look at the budget for the quarter.';
    t.scan([block(a!, 'Sam', said), block(b!, 'Priya', 'Then the hiring plan.')], T0);
    // Unmounted: the line closes. Drawn again with more words than it held.
    a!.remove();
    t.scan([block(b!, 'Priya', 'Then the hiring plan.')], T0 + 700);
    const [again] = els(1);
    const ups = t.scan([block(again!, 'Sam', `${said} And the rent.`), block(b!, 'Priya', 'Then the hiring plan.')], T0 + 1_400);
    expect(ups.map((u) => [u.lineId, u.speaker, u.text])).toEqual([['abcdefgh-3', 'Sam', 'And the rent.']]);
  });

  it('a redraw over a trimmed front takes the old line at the trimmed offset, every word kept', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    const all = Array.from({ length: 40 }, (_, i) => `word${i}`);
    t.scan([block(a!, 'Sam', all.slice(0, 30).join(' '))], T0);
    a!.remove();
    const [again] = els(1);
    const ups = t.scan([block(again!, 'Sam', all.slice(8).join(' '))], T0 + 500);
    expect(ups.map((u) => [u.lineId, u.text])).toEqual([['abcdefgh-1', all.join(' ')]]);
  });

  it(`a redraw of more turns than ADOPT_LOOKBACK: the newest ${ADOPT_LOOKBACK} keep their lines (the lines it makes never push them out)`, () => {
    const turns = ADOPT_LOOKBACK + 3;
    const said = (i: number) => `Turn ${i} is about the launch and the venue.`;
    const t = createTracker({ nonce: 'abcdefgh' });
    const first = els(turns);
    t.scan(first.map((el, i) => block(el, i % 2 ? 'Sam' : 'Priya', said(i))), T0);
    for (const el of first) el.remove();
    const again = els(turns);
    const ups = t.scan(again.map((el, i) => block(el, i % 2 ? 'Sam' : 'Priya', said(i))), T0 + 500);
    // Only the turns older than the lookback come again as new lines.
    expect(ups.map((u) => u.text)).toEqual([said(0), said(1), said(2)]);
  });

  it('another text altogether on the same element (a reset too short for RESET_SHRINK) starts over: the old line stays', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    const before = 'and the room booking for the workshop is still open';
    t.scan([block(a!, 'Sam', before)], T0);
    const ups = t.scan([block(a!, 'Sam', 'Right, so moving on to the next item.')], T0 + 500);
    expect(before.length).toBeLessThan(RESET_SHRINK);
    expect(ups.map((u) => [u.lineId, u.text])).toEqual([['abcdefgh-2', 'Right, so moving on to the next item.']]);
  });

  it('a revision whose words do not line up is still the same line, never a second one', () => {
    const [a, b] = els(2);
    const t = createTracker({ nonce: 'abcdefgh' });
    t.scan([block(a!, 'Sam', 'Hey'), block(b!, 'Priya', 'Thanks everyone for coming')], T0);
    const ups = t.scan([block(a!, 'Sam', 'Okay'), block(b!, 'Priya', 'Thank you all for coming today')], T0 + 500);
    expect(ups.map((u) => [u.lineId, u.text])).toEqual([
      ['abcdefgh-1', 'Okay'],
      ['abcdefgh-2', 'Thank you all for coming today'],
    ]);
  });

  it('keeps every line within the wire limits: a 5,000-character turn with no sentence end splits, a long name is cut', () => {
    const [a] = els(1);
    const t = createTracker({ nonce: 'abcdefgh' });
    const ups = t.scan([block(a!, 'N'.repeat(200), 'lorem '.repeat(840).trim())], T0);
    expect(ups.length).toBeGreaterThan(2);
    for (const u of ups) {
      expect(u.text.length).toBeLessThanOrEqual(WIRE_LIMITS.lineText);
      expect(u.speaker).toHaveLength(WIRE_LIMITS.speaker);
    }
    expect(ups.map((u) => u.text).join(' ')).toBe('lorem '.repeat(840).trim());
  });

  it('9.5: a scan over 300 blocks takes at most 3 ms (median)', () => {
    const items = els(300);
    const t = createTracker({ nonce: 'abcdefgh' });
    const blocks = items.map((el, i) => block(el, i % 2 ? 'Sam' : 'Priya', `Line ${i} about the launch, the quote and the room booking for the week.`));
    t.scan(blocks, T0);
    const times: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const last = blocks.length - 1;
      blocks[last] = block(items[last]!, 'Sam', `${blocks[last]!.text} more`);
      const start = performance.now();
      t.scan(blocks, T0 + 100 * i);
      times.push(performance.now() - start);
    }
    times.sort((x, y) => x - y);
    expect(times[15]).toBeLessThanOrEqual(3);
  });

  it('9.5: the first scan of 300 new blocks (a Start, a redraw) takes at most 3 ms (median)', () => {
    const said = (i: number) => `Line ${i} about the launch, the quote and the room booking for the week.`;
    const times: number[] = [];
    for (let r = 0; r < 31; r += 1) {
      const t = createTracker({ nonce: 'abcdefgh' });
      // A redraw: the tracker already has lines whose elements are gone, so every new block tries them.
      const gone = els(ADOPT_LOOKBACK);
      t.scan(gone.map((el, i) => block(el, i % 2 ? 'Sam' : 'Priya', said(1_000 + i))), T0);
      for (const el of gone) el.remove();
      const blocks = els(300).map((el, i) => block(el, i % 2 ? 'Sam' : 'Priya', said(i)));
      const start = performance.now();
      t.scan(blocks, T0 + 500);
      times.push(performance.now() - start);
      document.body.replaceChildren();
    }
    times.sort((x, y) => x - y);
    expect(times[15]).toBeLessThanOrEqual(3);
  });
});
