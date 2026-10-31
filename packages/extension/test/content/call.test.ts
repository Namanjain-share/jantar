/**
 * MX5 (the page's part): the leave grace with fake timers. The in-call hooks
 * gone for 10 s and back send no leave; gone for 60 s send one
 * `call {inCall: false, left: true}`; a new Meet code is sent at once; a
 * page only ever in the waiting room (also after a reload) never sends
 * `left`. Also: `call` on load, on entering, on a new title, and as the
 * 60-s keep-alive while in a call; polls are timers, never animation frames.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import type { SiteAdapter } from '../../src/content/adapters/types.js';
import { createCallWatch, type CallMessage, type CallPhase, type CallWatch } from '../../src/content/call.js';
import type { CallAnswer } from '../../src/shared/messages.js';
import { TIMING } from '../../src/shared/wire.js';
import { buildMeet, meetUrl } from '../fixtures/meet.js';
import { CALL_SCRIPTS, type Fixture } from '../fixtures/scripts.js';
import { buildTeams } from '../fixtures/teams.js';
import { goTo, settle } from './chrome.js';

let watch: CallWatch | null = null;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-30T10:00:00.000Z') });
});

afterEach(() => {
  watch?.stop();
  watch = null;
  vi.useRealTimers();
  document.body.replaceChildren();
  document.title = '';
  goTo('/');
});

function watching(adapter: SiteAdapter, answer: (msg: CallMessage) => CallAnswer | undefined = () => ({ button: true, notes: false })) {
  const sent: CallMessage[] = [];
  const phases: CallPhase[] = [];
  const answers: CallAnswer[] = [];
  watch = createCallWatch({
    adapter,
    doc: document,
    send: async (msg) => {
      sent.push(structuredClone(msg));
      return answer(msg);
    },
    onAnswer: (a) => answers.push(a),
    onPhase: (p) => phases.push(p),
  });
  watch.start();
  return { sent, phases, answers, lefts: () => sent.filter((m) => m.left) };
}

describe('MX5: the call watch', () => {
  it('sends `call` at page load, then on entering the call', async () => {
    goTo(meetUrl('abc-defg-hij', 'short'));
    const meet = buildMeet(document, { state: 'waiting' });
    const w = watching(meetAdapter);
    await settle();
    expect(w.sent).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync' }]);
    expect(w.answers).toEqual([{ button: true, notes: false }]);
    meet.join();
    // Admitted: Meet rewrites the URL to /meet/<code>, the same call.
    goTo(meetUrl('abc-defg-hij', 'meet'));
    await settle(TIMING.callPollMs);
    expect(w.sent.slice(1)).toEqual([{ t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Weekly sync' }]);
    expect(watch!.phase()).toBe('in');
    await settle(10 * TIMING.callPollMs);
    expect(w.sent).toHaveLength(2);
  });

  it(`${CALL_SCRIPTS[0]!.name}: no leave, the same call`, async () => {
    goTo(meetUrl('abc-defg-hij'));
    const script = CALL_SCRIPTS[0]!;
    const fx = script.build(document) as Fixture;
    const w = watching(meetAdapter);
    await settle();
    for (const step of script.steps) {
      await settle(step.wait);
      step.run(fx);
    }
    await settle(2 * TIMING.callPollMs);
    expect(w.phases).toEqual(['in', 'leaving', 'in']);
    await settle(TIMING.leaveGraceMs * 2);
    expect(w.lefts()).toEqual([]);
    expect(w.sent.every((m) => m.callKey === 'abc-defg-hij')).toBe(true);
  });

  it('the hooks gone for 60 s: one `call {inCall: false, left: true}`, and only then', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document);
    const w = watching(meetAdapter);
    await settle(TIMING.callPollMs);
    meet.hooksOff();
    await settle(TIMING.callPollMs);
    expect(watch!.phase()).toBe('leaving');
    await settle(TIMING.leaveGraceMs - 2 * TIMING.callPollMs);
    expect(w.lefts()).toEqual([]);
    await settle(2 * TIMING.callPollMs);
    expect(w.lefts()).toEqual([{ t: 'call', site: 'meet', inCall: false, left: true, callKey: 'abc-defg-hij', title: 'Weekly sync' }]);
    expect(watch!.phase()).toBe('out');
    await settle(5 * TIMING.leaveGraceMs);
    expect(w.lefts()).toHaveLength(1);
    // Back in the same call after the grace: a new entry, never a second leave.
    meet.hooksOn();
    await settle(TIMING.callPollMs);
    expect(w.sent.at(-1)).toMatchObject({ inCall: true, callKey: 'abc-defg-hij' });
    expect(w.sent.at(-1)).not.toHaveProperty('left');
  });

  it(`${CALL_SCRIPTS[1]!.name}: sent at once, no leave`, async () => {
    goTo(meetUrl('abc-defg-hij'));
    const script = CALL_SCRIPTS[1]!;
    const fx = script.build(document) as Fixture;
    const w = watching(meetAdapter);
    for (const step of script.steps) {
      await settle(step.wait);
      step.run(fx);
    }
    await settle(TIMING.callPollMs);
    expect(w.sent.at(-1)).toEqual({ t: 'call', site: 'meet', inCall: true, callKey: 'xyz-abcd-efg', title: 'Weekly sync' });
    expect(watch!.phase()).toBe('in');
    await settle(3 * TIMING.leaveGraceMs);
    expect(w.lefts()).toEqual([]);
  });

  it('a new code while leaving is sent at once too, and that waiting room never leaves', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document);
    const w = watching(meetAdapter);
    await settle(TIMING.callPollMs);
    meet.hooksOff();
    await settle(5 * TIMING.callPollMs);
    expect(watch!.phase()).toBe('leaving');
    goTo(meetUrl('xyz-abcd-efg'));
    await settle(TIMING.callPollMs);
    expect(w.sent.at(-1)).toEqual({ t: 'call', site: 'meet', inCall: false, callKey: 'xyz-abcd-efg', title: 'Weekly sync' });
    expect(watch!.phase()).toBe('out');
    await settle(3 * TIMING.leaveGraceMs);
    expect(w.lefts()).toEqual([]);
  });

  it('a page only ever in the waiting room never sends `left`, also after a reload', async () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document, { state: 'waiting' });
    const w = watching(meetAdapter);
    await settle(5 * TIMING.leaveGraceMs);
    expect(w.sent.map((m) => m.inCall)).toEqual([false]);
    watch!.stop();
    // The reload: a new content script on the same waiting room.
    const again = watching(meetAdapter);
    await settle(5 * TIMING.leaveGraceMs);
    expect(again.sent).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync' }]);
    expect(again.phases).toEqual([]);
  });

  it('repeats `call` every keepAliveMs while in the call (and while leaving), never in the waiting room', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document);
    const w = watching(meetAdapter);
    await settle();
    await settle(3 * TIMING.keepAliveMs);
    expect(w.sent.map((m) => m.inCall)).toEqual([true, true, true, true]);
    meet.hooksOff();
    await settle(TIMING.leaveGraceMs + TIMING.callPollMs);
    expect(w.lefts()).toHaveLength(1);
    const before = w.sent.length;
    await settle(3 * TIMING.keepAliveMs);
    expect(w.sent).toHaveLength(before);
  });

  it('a new title is sent', async () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document, { title: null });
    document.title = 'Meet – abc-defg-hij';
    const w = watching(meetAdapter);
    await settle();
    expect(w.sent.at(-1)?.title).toBe('');
    // The calendar title arrives a few seconds late.
    document.title = 'Meet – Planning';
    await settle(TIMING.callPollMs);
    expect(w.sent.at(-1)).toEqual({ t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Planning' });
  });

  it('sends an unanswered `call` again after linesRetryMs, an answered one never', async () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document);
    let answer = false;
    const w = watching(meetAdapter, () => (answer ? { button: true, notes: true } : undefined));
    await settle();
    expect(w.sent).toHaveLength(1);
    await settle(TIMING.linesRetryMs);
    expect(w.sent).toHaveLength(2);
    answer = true;
    await settle(TIMING.linesRetryMs);
    expect(w.sent).toHaveLength(3);
    expect(w.answers).toEqual([{ button: true, notes: true }]);
    await settle(10 * TIMING.linesRetryMs);
    expect(w.sent).toHaveLength(3);
  });

  it('Teams: no key, back in any call within the grace is the same call', async () => {
    const teams = buildTeams(document, { layout: '2026-bottom' });
    const w = watching(teamsAdapter);
    await settle();
    expect(w.sent).toEqual([{ t: 'call', site: 'teams', inCall: true, callKey: null, title: '' }]);
    // Chat opened: Teams shrinks the call to a mini window, the hooks go.
    teams.hooksOff();
    await settle(30_000);
    teams.hooksOn();
    await settle(TIMING.leaveGraceMs * 2);
    expect(w.lefts()).toEqual([]);
    expect(w.phases).toEqual(['in', 'leaving', 'in']);
  });

  it('polls with timers, never animation frames', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document);
    watching(meetAdapter);
    await settle(TIMING.leaveGraceMs);
    expect(raf).not.toHaveBeenCalled();
  });
});
