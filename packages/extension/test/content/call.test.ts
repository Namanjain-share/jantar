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
import { CALL_SCRIPTS, type CallScript, type Fixture } from '../fixtures/scripts.js';
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
    // v0.10: every `call` carries the page's stable stage; none is stable on the first poll.
    expect(w.sent).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'none' }]);
    expect(w.answers).toEqual([{ button: true, notes: false }]);
    meet.join();
    // Admitted: Meet rewrites the URL to /meet/<code>, the same call.
    goTo(meetUrl('abc-defg-hij', 'meet'));
    await settle(TIMING.callPollMs);
    expect(w.sent.slice(1)).toEqual([{ t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'none' }]);
    expect(watch!.phase()).toBe('in');
    await settle(10 * TIMING.callPollMs);
    // v0.10: one poll later the call held two polls: one more `call` says so, and then nothing until the keep-alive.
    expect(w.sent.slice(2)).toEqual([{ t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'in', hook: 'meet:captions-button' }]);
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
    expect(w.lefts()).toEqual([{ t: 'call', site: 'meet', inCall: false, left: true, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'left', hook: 'page:left' }]);
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
    expect(w.sent.at(-1)).toEqual({ t: 'call', site: 'meet', inCall: true, callKey: 'xyz-abcd-efg', title: 'Weekly sync', stage: 'in', hook: 'meet:captions-button' });
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
    // v0.10: the fixture's call_end icon stays on screen without the other hooks, so the page reads as a waiting room.
    expect(w.sent.at(-1)).toEqual({ t: 'call', site: 'meet', inCall: false, callKey: 'xyz-abcd-efg', title: 'Weekly sync', stage: 'lobby', hook: 'meet:call_end' });
    expect(watch!.phase()).toBe('out');
    await settle(3 * TIMING.leaveGraceMs);
    expect(w.lefts()).toEqual([]);
  });

  it('a page only ever in the waiting room never sends `left`, also after a reload', async () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document, { state: 'waiting' });
    const w = watching(meetAdapter);
    await settle(5 * TIMING.leaveGraceMs);
    // v0.10: the waiting room beats every keepAliveMs (the arm's sign the page is still there), never in a call, never `left`.
    expect(w.sent.every((m) => m.inCall === false && m.stage !== 'in')).toBe(true);
    expect(w.lefts()).toEqual([]);
    watch!.stop();
    // The reload: a new content script on the same waiting room.
    const again = watching(meetAdapter);
    await settle(5 * TIMING.leaveGraceMs);
    expect(again.sent[0]).toEqual({ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'none' });
    expect(again.sent.slice(1).every((m) => m.inCall === false && m.stage === 'lobby' && m.hook === 'meet:call_end')).toBe(true);
    expect(again.lefts()).toEqual([]);
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
    // v0.10: out of the call the page beats only for a join screen, a waiting room or `left`, and never as in a call.
    expect(w.sent.slice(before).length).toBeGreaterThan(0);
    expect(w.sent.slice(before).every((m) => m.inCall === false && !m.left && m.stage !== 'in' && m.stage !== 'none')).toBe(true);
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
    expect(w.sent.at(-1)).toEqual({ t: 'call', site: 'meet', inCall: true, callKey: 'abc-defg-hij', title: 'Planning', stage: 'in', hook: 'meet:captions-button' });
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
    expect(w.sent).toEqual([{ t: 'call', site: 'teams', inCall: true, callKey: null, title: '', stage: 'none' }]);
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

/** A call script by name, its page at its own path. */
async function run(name: string, adapter: SiteAdapter, answer?: (msg: CallMessage) => CallAnswer | undefined) {
  const script = CALL_SCRIPTS.find((c) => c.name === name) as CallScript;
  if (script.path) goTo(script.path);
  const fx = script.build(document);
  const w = watching(adapter, answer);
  await settle();
  return {
    w,
    fx,
    async steps() {
      for (const step of script.steps) {
        await settle(step.wait);
        step.run(fx);
      }
    },
  };
}

/** Each stage change as the worker heard it: [inCall, stage, hook], repeats dropped. */
const stages = (sent: CallMessage[]) =>
  sent
    .map((m) => [m.inCall, m.stage, m.hook ?? ''] as const)
    .filter((m, i, all) => i === 0 || JSON.stringify(m) !== JSON.stringify(all[i - 1]));

describe('v0.10: the stage', () => {
  it('a page loaded on the join screen says so after two polls', async () => {
    goTo(meetUrl('abc-defg-hij', 'short'));
    buildMeet(document, { state: 'prejoin' });
    const w = watching(meetAdapter);
    await settle();
    expect(w.sent).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'none' }]);
    await settle(TIMING.callPollMs);
    expect(w.sent.slice(1)).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'prejoin', hook: 'meet:join-button' }]);
    expect(watch!.stage()).toBe('prejoin');
  });

  it(`${CALL_SCRIPTS[2]!.name}: one \`call\` per stable stage; entering keeps the stage before, \`in\` one poll later`, async () => {
    const r = await run('prejoin, lobby, admitted', meetAdapter);
    await r.steps();
    await settle(3 * TIMING.callPollMs);
    expect(stages(r.w.sent)).toEqual([
      [false, 'none', ''],
      [false, 'prejoin', 'meet:join-button'],
      [false, 'lobby', 'meet:call_end'],
      [true, 'lobby', 'meet:call_end'],
      [true, 'in', 'meet:captions-button'],
    ]);
    // The entering message and the one after it are a poll apart.
    const entered = r.w.sent.findIndex((m) => m.inCall);
    expect(r.w.sent[entered + 1]).toMatchObject({ inCall: true, stage: 'in' });
    expect(r.w.sent.filter((m) => m.stage === 'in')).toHaveLength(1);
  });

  it(`${CALL_SCRIPTS[3]!.name}: never \`in\`, also through the 60-s grace and the leave after it`, async () => {
    const r = await run('lobby with a one-poll hook flicker', meetAdapter);
    await r.steps();
    await settle(TIMING.callPollMs);
    // v0.5's phase still enters the call for that poll (inCall: true), unchanged.
    expect(r.w.phases).toEqual(['in', 'leaving']);
    expect(r.w.sent.some((m) => m.inCall)).toBe(true);
    await settle(TIMING.leaveGraceMs + 5 * TIMING.callPollMs);
    expect(r.w.lefts()).toHaveLength(1);
    expect(r.w.sent.some((m) => m.stage === 'in')).toBe(false);
    // Never in the call, so never `left` either: the waiting room it is.
    expect(r.w.lefts()[0]).toMatchObject({ stage: 'lobby', hook: 'meet:call_end' });
    expect(r.w.sent.at(-1)).toMatchObject({ inCall: false, stage: 'lobby' });
  });

  it('a join screen or waiting room beats every keepAliveMs; a page with neither does not', async () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document, { state: 'lobby' });
    const w = watching(meetAdapter);
    await settle(TIMING.callPollMs);
    const first = w.sent.length;
    await settle(3 * TIMING.keepAliveMs);
    expect(w.sent.length - first).toBe(3);
    expect(w.sent.slice(first).every((m) => m.stage === 'lobby' && !m.inCall)).toBe(true);
    watch!.stop();
    document.body.replaceChildren();
    goTo('/landing');
    const none = watching(meetAdapter);
    await settle(3 * TIMING.keepAliveMs);
    expect(none.sent).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: null, title: '', stage: 'none' }]);
  });

  it('after `left` the stage is `left` until a real join hook, the call, or a new code', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document);
    const w = watching(meetAdapter);
    await settle(2 * TIMING.callPollMs);
    expect(watch!.stage()).toBe('in');
    meet.leave();
    await settle(TIMING.leaveGraceMs + 2 * TIMING.callPollMs);
    expect(w.lefts()).toEqual([expect.objectContaining({ stage: 'left', hook: 'page:left' })]);
    // "You left": the code alone is no proof of a join screen.
    await settle(3 * TIMING.keepAliveMs);
    expect(watch!.stage()).toBe('left');
    expect(w.sent.at(-1)).toMatchObject({ inCall: false, stage: 'left' });
    // Rejoin shows the join screen: a real hook.
    document.body.replaceChildren();
    buildMeet(document, { state: 'prejoin' });
    await settle(2 * TIMING.callPollMs);
    expect(watch!.stage()).toBe('prejoin');
    // Left again, then another call's code: no longer `left`.
    document.body.replaceChildren();
    const again = buildMeet(document);
    await settle(2 * TIMING.callPollMs);
    again.leave();
    await settle(TIMING.leaveGraceMs + 2 * TIMING.callPollMs);
    expect(watch!.stage()).toBe('left');
    goTo(meetUrl('xyz-abcd-efg'));
    await settle(2 * TIMING.callPollMs);
    expect(watch!.stage()).toBe('prejoin');
    expect(w.sent.at(-1)).toMatchObject({ callKey: 'xyz-abcd-efg', stage: 'prejoin', hook: 'meet:code' });
  });

  it('`hide` sends one `call` with stage none and hook page:hide, with what the worker last heard; the next poll says where the page is', async () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document, { state: 'lobby' });
    const w = watching(meetAdapter);
    await settle(TIMING.callPollMs);
    const before = w.sent.length;
    watch!.hide();
    expect(w.sent.slice(before)).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync', stage: 'none', hook: 'page:hide' }]);
    await settle(TIMING.callPollMs);
    expect(w.sent.at(-1)).toMatchObject({ stage: 'lobby', hook: 'meet:call_end' });
    watch!.stop();
    const after = w.sent.length;
    watch!.hide();
    expect(w.sent).toHaveLength(after);
  });

  it(`${CALL_SCRIPTS[4]!.name}: the light-meetings join screen, the waiting room after Join now, the call`, async () => {
    const r = await run('teams join, lobby, admitted', teamsAdapter);
    await r.steps();
    await settle(3 * TIMING.callPollMs);
    expect(stages(r.w.sent)).toEqual([
      [false, 'none', ''],
      [false, 'prejoin', 'teams:prejoin-join'],
      [false, 'lobby', 'teams:after-join'],
      [true, 'lobby', 'teams:after-join'],
      [true, 'in', 'teams:anon-hangup-button'],
    ]);
    // Leave: the same URL, but the join seen before the call proves no waiting room now.
    (r.fx as ReturnType<typeof buildTeams>).leave();
    await settle(TIMING.leaveGraceMs + 3 * TIMING.callPollMs);
    expect(watch!.stage()).toBe('left');
  });

  it(`${CALL_SCRIPTS[5]!.name}: the join screen, then none`, async () => {
    const r = await run('teams pre-join then Chat', teamsAdapter);
    await r.steps();
    await settle(3 * TIMING.callPollMs);
    expect(stages(r.w.sent)).toEqual([
      [false, 'none', ''],
      [false, 'prejoin', 'teams:prejoin-join'],
      [false, 'none', ''],
    ]);
    // Chat beats no more.
    const n = r.w.sent.length;
    await settle(3 * TIMING.keepAliveMs);
    expect(r.w.sent).toHaveLength(n);
  });

  it('every `call` names a stage, and a hook only as one of our own ids', async () => {
    const r = await run('prejoin, lobby, admitted', meetAdapter);
    await r.steps();
    await settle(TIMING.leaveGraceMs);
    for (const m of r.w.sent) {
      expect(['none', 'prejoin', 'lobby', 'in', 'left']).toContain(m.stage);
      if (m.hook !== undefined) expect(m.hook).toMatch(/^[a-z0-9:_-]{1,40}$/);
    }
  });
});
