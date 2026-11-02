/**
 * v0.9.1: the call's captions switched on when notes start (captions.ts,
 * through the capture loop), with fake timers, on the synthetic fixtures:
 * - only after `start({cc: true})`: never before notes start (MP6), never
 *   without `cc` (the Settings switch off);
 * - turns captions on from off, once, and says how ("turned-on" and the
 *   hook); never clicks when they are on ("was-on");
 * - at most CC_TIMING.tries tries, CC_TIMING.gapMs apart, then "failed";
 * - a click nothing on the page confirms (a Teams guest before anyone
 *   speaks) is "clicked" and never made twice; a guest's item that says
 *   nothing is clicked blind only when notes start just after the page came
 *   into the call, once per page, and never with a caption container on
 *   the page ("unsure" otherwise);
 * - never turns them back on after he turned them off, also across notes
 *   runs in the page (End then Start); a new page (a reload) starts fresh;
 * - stops with notes, mid-try too: nothing clicked or pressed after;
 * - leaves a menu he opened alone; an organizer's "no captions" is final
 *   the second time; a menu whose items come late is waited for;
 * - the caption watch: captions on (or seen on) and nobody speaking is
 *   `waiting` (no bubble); only a control that says off gets "Turn them
 *   on"; an unconfirmed click, "unsure" and no captions have their own words;
 * - the lines then come in as usual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import type { SiteAdapter } from '../../src/content/adapters/types.js';
import { CC_TIMING, ccMemory, type CcMemory } from '../../src/content/captions.js';
import { NO_CAPTIONS_BUBBLE_MS, createCapture, type Capture, type LinesMessage } from '../../src/content/capture.js';
import { CC_WAITING, noCaptions } from '../../src/shared/captions.js';
import type { CaptionsState, CaptionsWhy, CcResult } from '../../src/shared/messages.js';
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

/** `inSince`: when the page came into the call (the call watch's; default: just now, so a blind click is allowed); `memory`: the page's. */
function capturing(adapter: SiteAdapter = meetAdapter, opts: { inSince?: number | null; memory?: CcMemory } = {}) {
  const sent: LinesMessage[] = [];
  const reports: [CcResult, string][] = [];
  const states: [CaptionsState, CaptionsWhy | undefined][] = [];
  const bubbles: [string, number | undefined][] = [];
  const inSince = opts.inSince === undefined ? Date.now() : opts.inSince;
  capture = createCapture({
    adapter,
    doc: document,
    send: async (msg) => {
      sent.push(structuredClone(msg));
      return { ok: true };
    },
    captions: (state, why) => states.push([state, why]),
    cc: (result, hook) => reports.push([result, hook]),
    bubble: (text, ms) => bubbles.push([text, ms]),
    nonce: () => 'ccnonce1',
    memory: opts.memory ?? ccMemory(),
    inSince: () => inSince,
  });
  return { reports, states, bubbles, lines: () => sent.flatMap((m) => m.lines.map((l) => [l.speaker, l.text])), capture };
}

/** Keys pressed on the page from now on. */
function keys(): string[] {
  const out: string[] = [];
  document.addEventListener('keydown', (ev) => out.push(ev.key));
  return out;
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

  it("the organizer's policy (no captions in More) is final the second time: More opened twice and closed, \"unavailable\", and the minute says so in its own words", async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'disabled', captions: false });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(TIMING.noCaptionsMs);
    expect(teams.ccLog).toEqual(['more-open', 'more-close', 'more-open', 'more-close']);
    expect(c.reports).toEqual([['unavailable', 'teams:no-cc-item']]);
    expect(c.states).toEqual([['none', 'unavailable']]);
    expect(c.bubbles).toEqual([[noCaptions('teams', 'unavailable'), NO_CAPTIONS_BUBBLE_MS]]);
    expect(noCaptions('teams', 'unavailable')).not.toMatch(/Turn them on|More/);
  });

  it('a menu whose items come a moment after it: waited for, the item clicked on the first try', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more', captions: false, itemsMs: 600 });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(CC_TIMING.verifyMs);
    expect(teams.ccLog).toEqual(['more-open', 'item']);
    expect(c.reports).toEqual([['turned-on', 'teams:cc-more-item']]);
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

describe('the page remembers (blocking: a manual off is respected, a guest\'s item is clicked blind once at most)', () => {
  it('Meet: End then Start in the same call after he turned captions off: nothing is clicked again ("kept")', async () => {
    const meet = buildMeet(document, { captions: false });
    const memory = ccMemory();
    const c = capturing(meetAdapter, { memory });
    c.capture.start({ cc: true });
    await settle(CC_TIMING.pollMs);
    expect(c.reports).toEqual([['turned-on', 'meet:cc-button']]);
    (document.querySelector('button[jsname="RrG0hf"]') as HTMLButtonElement).click();
    expect(meet.captionsShown()).toBe(false);
    await c.capture.stop({ final: true });
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(meet.ccLog).toEqual(['button', 'button']);
    expect(meet.captionsShown()).toBe(false);
    expect(c.reports).toEqual([
      ['turned-on', 'meet:cc-button'],
      ['kept', 'meet:captions-button'],
    ]);
    // The minute without a line: they are off, so the nudge says how to turn them on (his choice).
    await settle(TIMING.noCaptionsMs);
    expect(c.states.at(-1)).toEqual(['none', 'off']);
    // Turned on again by him: "were on", nothing clicked.
    meet.captionsOn();
    await c.capture.stop({ final: true });
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(c.reports.at(-1)).toEqual(['was-on', 'meet:captions-button']);
    expect(meet.ccLog).toEqual(['button', 'button']);
  });

  it('Meet: another call (a new code) or a new page (a reload) starts fresh', async () => {
    const meet = buildMeet(document, { captions: false });
    const memory = ccMemory();
    const c = capturing(meetAdapter, { memory });
    c.capture.start({ cc: true });
    await settle(CC_TIMING.pollMs);
    meet.captionsOff();
    await c.capture.stop({ final: true });
    goTo(meetUrl('xyz-wxyz-xyz'));
    c.capture.start({ cc: true });
    await settle(CC_TIMING.pollMs);
    expect(meet.ccLog).toEqual(['button', 'button']);
    expect(c.reports.at(-1)).toEqual(['turned-on', 'meet:cc-button']);
    meet.captionsOff();
    await c.capture.stop({ final: true });
    capture = null;
    const d = capturing(meetAdapter, { memory: ccMemory() });
    d.capture.start({ cc: true });
    await settle(CC_TIMING.pollMs);
    expect(meet.ccLog).toEqual(['button', 'button', 'button']);
    await c.capture.stop();
  });

  it('Repro C: a light-meetings guest with captions on, nobody speaking yet, Start long after joining: More is opened and closed, the item never clicked ("unsure"), captions stay on', async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: true, lateRegion: true });
    expect(teams.captionsShown()).toBe(true);
    const c = capturing(teamsAdapter, { inSince: Date.now() - 5 * 60_000 });
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(teams.menuOpen()).toBe(false);
    expect(teams.captionsShown()).toBe(true);
    expect(c.reports).toEqual([['unsure', 'teams:cc-more-item']]);
    // The minute: nothing says whether they are on, so the words ask him only if none show when people speak.
    await settle(TIMING.noCaptionsMs);
    expect(c.states).toEqual([['none', 'unsure']]);
    expect(c.bubbles[0]?.[0]).toBe(noCaptions('light', 'unsure'));
    expect(noCaptions('light', 'unsure')).toBe("No captions yet: Jantar writes notes from the call's live captions. If none appear when people speak, turn them on: More (…) › Captions.");
    teams.say('Sam', 'Hello all');
    await settle(TIMING.callPollMs + TIMING.linesEveryMs);
    expect(c.lines()).toEqual([['Sam', 'Hello all']]);
  });

  it('without the call watch (no time it came into the call), no blind click either', async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: false, lateRegion: true });
    const c = capturing(teamsAdapter, { inSince: null });
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(c.reports).toEqual([['unsure', 'teams:cc-more-item']]);
  });

  it(`a guest: notes started within ${CC_TIMING.blindMs / 1000} s of coming into the call: the one blind click; End then Start: never a second one ("kept")`, async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: false, lateRegion: true });
    const memory = ccMemory();
    const c = capturing(teamsAdapter, { inSince: Date.now() - CC_TIMING.blindMs, memory });
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'item']);
    expect(c.reports).toEqual([['clicked', 'teams:cc-more-item']]);
    expect(memory.blind).toBe(true);
    await c.capture.stop({ final: true });
    // He turns them off himself (More › Captions), then notes start again.
    (document.querySelector('#callingButtons-showMoreBtn') as HTMLButtonElement).click();
    (document.querySelector('#closed-captions-button') as HTMLElement).click();
    expect(teams.captionsShown()).toBe(false);
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'item', 'more-open', 'item']);
    expect(teams.captionsShown()).toBe(false);
    expect(c.reports.at(-1)).toEqual(['kept', 'teams:no-cc']);
    // Nothing says whether they are on, and the earlier "on" may be his off now: the words that ask only if none show.
    await settle(TIMING.noCaptionsMs);
    expect(c.states.at(-1)).toEqual(['none', 'unsure']);
  });

  it('a guest: a caption container of any kind on the page (not a control, not in a menu or the toolbar): no blind click', async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: false, lateRegion: true });
    document.body.append(h(document, 'div', { 'data-tid': 'closed-caption-banner-made-up' }));
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(c.reports).toEqual([['unsure', 'teams:cc-more-item']]);
  });
});

describe('notes stopping mid-try: nothing clicked or pressed after', () => {
  it('Repro D: Meet\'s pop-up not open yet when notes stop: no c, nothing reported', async () => {
    const meet = buildMeet(document, { cc: 'popup', captions: false, popupMs: 1_000 });
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(0);
    expect(meet.ccLog).toEqual(['popup-open']);
    const after = keys();
    await c.capture.stop();
    await settle(ALL_TRIES);
    expect(after).toEqual([]);
    expect(meet.ccLog).toEqual(['popup-open']);
    expect(meet.captionsShown()).toBe(false);
    expect(c.reports).toEqual([]);
  });

  it('Teams: More open when notes stop: its item is not clicked, More is closed', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more', captions: false, itemsMs: 600 });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(0);
    expect(teams.ccLog).toEqual(['more-open']);
    await c.capture.stop();
    await settle(ALL_TRIES);
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(teams.menuOpen()).toBe(false);
    expect(teams.captionsShown()).toBe(false);
    expect(c.reports).toEqual([]);
  });
});

describe('the caption watch knows what the switch found (blocking: no "Turn them on" while they are on)', () => {
  it('Repro A1: Meet, captions on, nobody speaks for 4 minutes: `waiting`, no bubble, no `none`', async () => {
    const meet = buildMeet(document);
    const c = capturing();
    c.capture.start({ cc: true });
    await settle(TIMING.noCaptionsMs + TIMING.captionsRecheckMs + 2 * TIMING.callPollMs);
    expect(c.reports).toEqual([['was-on', 'meet:captions-button']]);
    expect(c.states).toEqual([['waiting', undefined]]);
    expect(c.bubbles).toEqual([]);
    expect(meet.ccLog).toEqual([]);
    expect(CC_WAITING).toBe('Captions are on; lines appear once someone speaks.');
    // Then he turns them off: now the nudge, in the words for off.
    meet.captionsOff();
    await settle(2 * TIMING.callPollMs);
    expect(c.states).toEqual([
      ['waiting', undefined],
      ['none', 'off'],
    ]);
    expect(c.bubbles).toEqual([[noCaptions('meet'), NO_CAPTIONS_BUBBLE_MS]]);
  });

  it('Meet\'s words never say "press c" (it toggles)', () => {
    expect(noCaptions('meet')).toBe("No captions yet: Jantar writes notes from the call's live captions. Turn them on: Captions and translation (CC) › Turn on captions.");
    for (const why of ['off', 'clicked', 'unsure', 'unavailable'] as const) expect(noCaptions('meet', why)).not.toMatch(/press c/);
  });

  it('Repro A2: a guest whose item Jantar clicked, nobody speaking: `none` in words that are no toggle instruction', async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: false, lateRegion: true });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(TIMING.noCaptionsMs + 2 * TIMING.callPollMs);
    expect(c.reports).toEqual([['clicked', 'teams:cc-more-item']]);
    expect(teams.captionsShown()).toBe(true);
    expect(c.states).toEqual([['none', 'clicked']]);
    const words = c.bubbles.map(([t]) => t);
    expect(words).toEqual([noCaptions('light', 'clicked')]);
    expect(words[0]).toBe('Jantar turned captions on. If none appear when people speak, check More (…) › Captions.');
    expect(words.join(' ')).not.toMatch(/Turn them on/);
  });

  it('Teams signed in, captions on and nobody speaking (the item said on): `waiting`', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more', lateRegion: true });
    const c = capturing(teamsAdapter);
    c.capture.start({ cc: true });
    await settle(TIMING.noCaptionsMs + TIMING.captionsRecheckMs + 2 * TIMING.callPollMs);
    expect(c.reports).toEqual([['was-on', 'teams:cc-more-item']]);
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(c.states).toEqual([['waiting', undefined]]);
    expect(c.bubbles).toEqual([]);
  });

  it('R-C3: Meet\'s empty container stays with captions off: turned off after lines came is still `none` a minute later', async () => {
    const meet = buildMeet(document, { emptyContainer: true });
    const c = capturing();
    c.capture.start();
    meet.say('Sam', 'First words');
    await settle(TIMING.callPollMs + TIMING.linesEveryMs);
    expect(c.states).toEqual([['reading', undefined]]);
    meet.captionsOff();
    expect(meetAdapter.region(document)?.getAttribute('jscontroller')).toBe('D1tHje');
    await settle(TIMING.noCaptionsMs + 2 * TIMING.callPollMs);
    expect(c.states).toEqual([
      ['reading', undefined],
      ['none', 'off'],
    ]);
  });
});
