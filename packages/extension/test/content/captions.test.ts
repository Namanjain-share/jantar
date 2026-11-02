/**
 * v0.10: the call's captions switched on when notes start (captions.ts,
 * through the capture loop), with fake timers, on the synthetic fixtures:
 * - only after `start({cc: true})`: never before notes start (MP6), never
 *   without `cc` (the Settings switch off);
 * - turns captions on from off, once, and says how ("turned-on" and the
 *   hook); never clicks when they are on ("was-on");
 * - at most CC_TIMING.tries tries, CC_TIMING.gapMs apart, then "failed";
 * - a click nothing on the page confirms (a Teams guest before anyone
 *   speaks) is "clicked" and never made twice;
 * - never turns them back on after he turned them off; stops with notes;
 * - leaves a menu he opened alone; an organizer's "no captions" is final;
 * - the lines then come in as usual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import type { SiteAdapter } from '../../src/content/adapters/types.js';
import { CC_TIMING } from '../../src/content/captions.js';
import { createCapture, type Capture, type LinesMessage } from '../../src/content/capture.js';
import type { CcResult } from '../../src/shared/messages.js';
import { TIMING } from '../../src/shared/wire.js';
import { h } from '../fixtures/dom.js';
import { buildMeet, meetUrl } from '../fixtures/meet.js';
import { buildTeams } from '../fixtures/teams.js';
import { goTo, settle, watchConsole } from './chrome.js';

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

function capturing(adapter: SiteAdapter = meetAdapter) {
  const sent: LinesMessage[] = [];
  const reports: [CcResult, string][] = [];
  capture = createCapture({
    adapter,
    doc: document,
    send: async (msg) => {
      sent.push(structuredClone(msg));
      return { ok: true };
    },
    captions: () => undefined,
    cc: (result, hook) => reports.push([result, hook]),
    bubble: () => undefined,
    nonce: () => 'ccnonce1',
  });
  return { reports, lines: () => sent.flatMap((m) => m.lines.map((l) => [l.speaker, l.text])), capture };
}

/** Long enough for every try and its checks. */
const ALL_TRIES = CC_TIMING.tries * (CC_TIMING.gapMs + CC_TIMING.verifyMs);

describe('only once notes start, and only when the switch is on', () => {
  it('MP6: nothing is read or clicked before start(); start() without cc clicks nothing', async () => {
    const meet = buildMeet(document, { captions: false });
    const state = vi.spyOn(meetAdapter.cc, 'state');
    const turnOn = vi.spyOn(meetAdapter.cc, 'turnOn');
    const c = capturing();
    await settle(ALL_TRIES);
    expect(state).not.toHaveBeenCalled();
    expect(turnOn).not.toHaveBeenCalled();
    c.capture.start();
    await settle(ALL_TRIES);
    expect(turnOn).not.toHaveBeenCalled();
    expect(meet.ccLog).toEqual([]);
    expect(c.reports).toEqual([]);
  });
});

describe('Meet', () => {
  it('turns captions on from off, once, says so, and reads the lines', async () => {
    const meet = buildMeet(document, { captions: false });
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(0);
    expect(meet.ccLog).toEqual(['button']);
    expect(meet.captionsShown()).toBe(true);
    await settle(CC_TIMING.pollMs);
    expect(c.reports).toEqual([['turned-on', 'meet:cc-button']]);
    meet.say('Sam', 'Now we have notes');
    await settle(TIMING.callPollMs + TIMING.linesEveryMs);
    expect(c.lines()).toEqual([['Sam', 'Now we have notes']]);
    await settle(ALL_TRIES);
    expect(meet.ccLog).toEqual(['button']);
  });

  it('"Captions and translation": through its pop-up, closed again', async () => {
    const meet = buildMeet(document, { cc: 'popup', captions: false });
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(CC_TIMING.verifyMs);
    expect(meet.ccLog).toEqual(['popup-open', 'toggle', 'popup-close']);
    expect(meet.popupOpen()).toBe(false);
    expect(c.reports).toEqual([['turned-on', 'meet:cc-popup']]);
  });

  it('never clicks when captions are on', async () => {
    const meet = buildMeet(document);
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(meet.ccLog).toEqual([]);
    expect(c.reports).toEqual([['was-on', 'meet:captions-button']]);
  });

  it(`at most ${CC_TIMING.tries} tries, ${CC_TIMING.gapMs / 1000} s apart (the last one presses c), then "failed"`, async () => {
    buildMeet(document, { captions: false }).hooksOff();
    // A toggle that says off whatever is done to it.
    const dead = h(document, 'button', { jsname: 'RrG0hf', 'aria-pressed': 'false' }, h(document, 'i', { class: 'google-symbols' }, 'closed_caption_off'));
    document.body.append(dead);
    const at: [string, number][] = [];
    const began = Date.now();
    dead.addEventListener('click', () => at.push(['click', Date.now() - began]));
    document.addEventListener('keydown', (ev) => at.push([ev.key, Date.now() - began]), { once: true });
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(10 * ALL_TRIES);
    expect(at).toEqual([
      ['click', 0],
      ['click', CC_TIMING.gapMs],
      ['c', 2 * CC_TIMING.gapMs],
    ]);
    expect(c.reports).toEqual([['failed', 'meet:key-c']]);
  });

  it('never turns them back on after he turned them off', async () => {
    const meet = buildMeet(document, { captions: false });
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(CC_TIMING.pollMs);
    expect(c.reports).toEqual([['turned-on', 'meet:cc-button']]);
    (document.querySelector('button[jsname="RrG0hf"]') as HTMLButtonElement).click();
    expect(meet.captionsShown()).toBe(false);
    await settle(ALL_TRIES);
    expect(meet.ccLog).toEqual(['button', 'button']);
    expect(c.reports).toHaveLength(1);
  });

  it('a control whose state cannot be read is never touched', async () => {
    const meet = buildMeet(document, { captions: false });
    const b = document.querySelector('button[jsname="RrG0hf"]')!;
    b.removeAttribute('aria-pressed');
    b.setAttribute('aria-label', 'Untertitel');
    b.querySelector('i')!.textContent = 'closed_caption';
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(10 * ALL_TRIES);
    expect(meet.ccLog).toEqual([]);
    expect(c.reports).toEqual([['failed', 'meet:captions-button']]);
  });

  it('stops with notes: no more tries and nothing reported', async () => {
    buildMeet(document, { captions: false }).hooksOff();
    const turnOn = vi.spyOn(meetAdapter.cc, 'turnOn');
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(0);
    expect(turnOn).toHaveBeenCalledTimes(1);
    await c.capture.stop();
    await settle(10 * ALL_TRIES);
    expect(turnOn).toHaveBeenCalledTimes(1);
    expect(c.reports).toEqual([]);
  });
});

describe('Teams', () => {
  it('light meetings, as a guest: More › Captions once ("clicked": nothing shows until someone speaks), then the lines with their speakers', async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: false, lateRegion: true });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'item']);
    expect(teams.menuOpen()).toBe(false);
    expect(c.reports).toEqual([['clicked', 'teams:cc-more-item']]);
    teams.say('Sam', 'Shall we begin?');
    teams.say('Priya', 'Yes, go ahead.');
    await settle(TIMING.callPollMs + TIMING.linesEveryMs);
    expect(c.lines()).toEqual([
      ['Sam', 'Shall we begin?'],
      ['Priya', 'Yes, go ahead.'],
    ]);
    expect(teams.ccLog).toEqual(['more-open', 'item']);
  });

  it('signed in: the item says off, the captions come on: "turned-on"', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more', captions: false });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(CC_TIMING.verifyMs);
    expect(teams.ccLog).toEqual(['more-open', 'item']);
    expect(c.reports).toEqual([['turned-on', 'teams:cc-more-item']]);
  });

  it("the organizer's policy (no captions in More) is final: More opened once and closed, \"failed\"", async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'disabled', captions: false });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(10 * ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(c.reports).toEqual([['failed', 'teams:no-cc-item']]);
  });

  it('More he opened himself: no try while it is open (none counted), then one once he closed it', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more', captions: false });
    const more = document.querySelector('#callingButtons-showMoreBtn') as HTMLButtonElement;
    more.click();
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(5 * CC_TIMING.gapMs);
    expect(teams.ccLog).toEqual(['more-open']);
    more.click();
    await settle(CC_TIMING.gapMs + CC_TIMING.verifyMs);
    expect(teams.ccLog).toEqual(['more-open', 'more-close', 'more-open', 'item']);
    expect(c.reports).toEqual([['turned-on', 'teams:cc-more-item']]);
  });
});
