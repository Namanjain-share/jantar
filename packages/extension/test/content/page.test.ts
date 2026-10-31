/**
 * The content script as a whole (`startContent`, spec 3.6 to 3.8) against
 * the chrome fake and a stand-in worker:
 * - MX8 (the page's part): no button before pairing, none in the waiting
 *   room, shown after `button {on: true}`, gone after `{on: false}`;
 * - MP6: nothing read before `capture {on: true}` or a CallAnswer with
 *   notes on (a reload resumes with a new nonce, only once in the call);
 *   a later answer never starts notes, notes off in one stops them, and an
 *   answer that raced a `capture` message changes nothing on notes;
 * - capture keeps reading while the call watch is leaving, and only the
 *   worker stops it;
 * - MP10 (the page's part): only this extension's worker messages are
 *   answered; the page's own message types and unknown `t` never are; a
 *   page-button shot goes as `shot` only on a trusted click;
 * - after the extension is reloaded everything stops and the bubble says
 *   to reload the page, a camera click that finds it so included;
 * - MP7: nothing reaches the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import { RELOAD, SITE_ADAPTERS, startContent, type Content } from '../../src/content/index.js';
import type { CallAnswer } from '../../src/shared/messages.js';
import { MEETING_HOSTS, siteOf } from '../../src/shared/sites.js';
import { TIMING } from '../../src/shared/wire.js';
import { buildMeet, meetUrl } from '../fixtures/meet.js';
import { buildTeams } from '../fixtures/teams.js';
import { MEETING_MARKER, cameraHost, captureShadows, goTo, pageWorld, settle, trustedClick, watchConsole, type PageWorld } from './chrome.js';

const FRAME = 16;
let world: PageWorld;
let content: Content | null = null;
let shadows: ReturnType<typeof captureShadows>;
let console_: ReturnType<typeof watchConsole>;
let nonces: string[];

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-30T10:00:00.000Z') });
  goTo(meetUrl('abc-defg-hij'));
  shadows = captureShadows();
  console_ = watchConsole();
  nonces = ['pagenon1', 'pagenon2', 'pagenon3'];
});

afterEach(() => {
  content?.stop();
  content = null;
  world?.done();
  vi.useRealTimers();
  document.body.replaceChildren();
  document.title = '';
  goTo('/');
  expect(console_.said().join('\n')).not.toContain(MEETING_MARKER);
  expect(console_.said()).toEqual([]);
});

function start(opts: { paired?: boolean; notes?: boolean; site?: 'meet' | 'teams' } = {}) {
  world = pageWorld(opts);
  content = startContent({ adapter: opts.site === 'teams' ? teamsAdapter : meetAdapter, nonce: () => nonces.shift()! });
  return content!;
}

const rootOf = () => shadows.rootOf(cameraHost());
const cam = () => rootOf()?.querySelector('button.cam') as HTMLButtonElement | null | undefined;
const shown = () => Boolean(cameraHost() && cam() && !cam()!.hidden);
const tip = () => rootOf()?.querySelector('.bubble') as HTMLElement | null | undefined;

describe('startContent', () => {
  it('does nothing on a page that is no meeting host', () => {
    world = pageWorld();
    expect(startContent()).toBeNull();
    expect(world.chrome.runtime.onMessage.listeners).toHaveLength(1);
  });

  it('picks the adapter for exactly the meeting hosts, as shared/sites.ts names them', () => {
    for (const host of MEETING_HOSTS) expect(SITE_ADAPTERS[siteOf(host)!].site, host).toBe(siteOf(host));
    expect(Object.keys(SITE_ADAPTERS).sort()).toEqual(['meet', 'teams']);
  });

  it('tells the worker at once when the page loads', async () => {
    buildMeet(document, { state: 'waiting' });
    start();
    await settle(0);
    expect(world.worker.of('call')).toEqual([{ t: 'call', site: 'meet', inCall: false, callKey: 'abc-defg-hij', title: 'Weekly sync' }]);
  });
});

describe('MX8: the button only where it can work', () => {
  it('none before pairing, even in a call', async () => {
    buildMeet(document);
    start({ paired: false });
    await settle(5 * TIMING.callPollMs);
    expect(cameraHost()).toBeNull();
  });

  it('none in the waiting room; shown once in the call; `button` turns it off and on', async () => {
    const meet = buildMeet(document, { state: 'waiting' });
    start({ paired: true });
    await settle(5 * TIMING.callPollMs);
    expect(cameraHost()).toBeNull();
    meet.join();
    await settle(TIMING.callPollMs);
    expect(shown()).toBe(true);
    // Unpaired, or a 401 the worker saw.
    expect(await world.toPage({ t: 'button', on: false })).toEqual({ ok: true });
    expect(cameraHost()).toBeNull();
    await world.toPage({ t: 'button', on: true });
    expect(shown()).toBe(true);
  });

  it('shown after pairing (`button {on: true}`), within the call only', async () => {
    const meet = buildMeet(document);
    start({ paired: false });
    await settle(TIMING.callPollMs);
    expect(cameraHost()).toBeNull();
    await world.toPage({ t: 'button', on: true });
    expect(shown()).toBe(true);
    // Still shown while leaving; gone once the grace has run out.
    meet.hooksOff();
    await settle(30_000);
    expect(shown()).toBe(true);
    await settle(TIMING.leaveGraceMs);
    expect(cameraHost()).toBeNull();
  });
});

describe('MP6: nothing is read before Start', () => {
  it('blocks() never runs and nothing is observed until `capture {on: true}`; then lines go and the dot shows', async () => {
    const meet = buildMeet(document);
    meet.say('Sam', `Said before Start ${MEETING_MARKER}`);
    const blocks = vi.spyOn(meetAdapter, 'blocks');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    start();
    await settle(3 * TIMING.leaveGraceMs);
    expect(blocks).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(world.worker.of('lines')).toEqual([]);
    expect(await world.toPage({ t: 'capture', on: true })).toEqual({ ok: true });
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(false);
    meet.say('Priya', 'After Start');
    await settle(TIMING.linesEveryMs + 10);
    expect(world.worker.of('lines').flatMap((m) => m.lines.map((l) => [l.lineId, l.speaker]))).toEqual([
      ['pagenon1-1', 'Sam'],
      ['pagenon1-2', 'Priya'],
    ]);
    expect(world.worker.of('captions')).toEqual([{ t: 'captions', state: 'reading' }]);
  });

  it('a CallAnswer with notes on resumes notes after a reload, with a new nonce', async () => {
    const meet = buildMeet(document);
    meet.say('Sam', 'After the reload');
    start({ notes: true });
    nonces = ['reloadd1'];
    await settle(TIMING.debounceMs + 10);
    expect(content!.capture.on).toBe(true);
    expect(world.worker.of('lines').flatMap((m) => m.lines.map((l) => l.lineId))).toEqual(['reloadd1-1']);
  });

  it('a reload into the waiting room resumes notes only once the call is on again: no reading, no nudge before', async () => {
    const meet = buildMeet(document, { state: 'waiting' });
    start({ notes: true });
    await settle(TIMING.noCaptionsMs + 5 * TIMING.callPollMs);
    expect(content!.capture.on).toBe(false);
    expect(world.worker.of('captions')).toEqual([]);
    // No bubble (the howTo nudge) and no button: nothing of ours on the page.
    expect(cameraHost()).toBeNull();
    meet.join();
    meet.say('Sam', 'Back in the call');
    await settle(TIMING.callPollMs + TIMING.debounceMs + 10);
    expect(content!.capture.on).toBe(true);
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(false);
    expect(world.worker.of('lines').flatMap((m) => m.lines.map((l) => [l.lineId, l.text]))).toEqual([['pagenon1-1', 'Back in the call']]);
  });
});

describe('notes and the call', () => {
  it('keep reading while the call watch is leaving; only the worker stops them', async () => {
    const teams = buildTeams(document, { layout: '2026-bottom' });
    start({ site: 'teams' });
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    teams.say('Sam', 'Before the gap');
    await settle(TIMING.debounceMs + 10);
    teams.hooksOff();
    await settle(TIMING.callPollMs);
    expect(content!.call.phase()).toBe('leaving');
    expect(content!.capture.on).toBe(true);
    teams.say('Priya', 'Said while the window was small');
    await settle(10_000);
    teams.hooksOn();
    await settle(TIMING.callPollMs + TIMING.linesEveryMs);
    expect(world.worker.of('lines').flatMap((m) => m.lines.map((l) => l.text))).toEqual(['Before the gap', 'Said while the window was small']);
    // Gone past the grace: the page says `left`, and still reads until the worker answers with capture off.
    teams.hooksOff();
    await settle(TIMING.leaveGraceMs + TIMING.callPollMs);
    expect(world.worker.of('call').filter((m) => m.left)).toHaveLength(1);
    expect(content!.capture.on).toBe(true);
    await world.toPage({ t: 'capture', on: false });
    expect(content!.capture.on).toBe(false);
  });

  it('`capture {on: false}` (End) sends what waits, then answers; the dot goes', async () => {
    const meet = buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'The very last words');
    await settle(10);
    const answer = world.toPage({ t: 'capture', on: false });
    await settle(0);
    expect(await answer).toEqual({ ok: true });
    expect(world.worker.of('lines').flatMap((m) => m.lines.map((l) => l.text))).toEqual(['The very last words']);
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(true);
  });

  it('`capture {on: false, text}` drops what waits and shows why', async () => {
    const meet = buildMeet(document);
    start();
    world.worker.lines = () => ({ ok: false, retry: true });
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'Waiting for Jantar');
    await settle(TIMING.debounceMs + 10);
    await world.toPage({ t: 'capture', on: false, text: 'This meeting is no longer open in Jantar.' });
    expect(content!.capture.pending()).toBe(0);
    expect(tip()!.textContent).toBe('This meeting is no longer open in Jantar.');
  });

  it('the worker answering `retry: false` stops notes here: the dot goes and the text shows', async () => {
    const meet = buildMeet(document);
    start();
    world.worker.lines = () => ({ ok: false, retry: false, text: 'Pair again: jantar pair --extension' });
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'Lost');
    await settle(TIMING.debounceMs + 10);
    expect(content!.capture.on).toBe(false);
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(true);
    expect(tip()!.textContent).toBe('Pair again: jantar pair --extension');
  });

  it('a later answer with notes on never starts notes the page stopped itself', async () => {
    const meet = buildMeet(document);
    start();
    // A refusal that leaves the worker's notes on (a 400: the two disagree on the body).
    world.worker.lines = () => ({ ok: false, retry: false, text: 'Not saved: build and reload the extension.' });
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'Refused');
    await settle(TIMING.debounceMs + 10);
    expect(content!.capture.on).toBe(false);
    const calls = world.worker.of('call').length;
    const lines = world.worker.of('lines').length;
    await settle(3 * TIMING.keepAliveMs);
    expect(world.worker.of('call').length).toBeGreaterThanOrEqual(calls + 3);
    expect(content!.capture.on).toBe(false);
    expect(world.worker.of('lines')).toHaveLength(lines);
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(true);
  });

  it("notes off in an answer stops notes (the worker's own `capture` off never arrived)", async () => {
    const meet = buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'Before the meeting ended elsewhere');
    await settle(TIMING.debounceMs + 10);
    world.worker.call = () => ({ button: true, notes: false });
    await settle(TIMING.keepAliveMs);
    expect(content!.capture.on).toBe(false);
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(true);
  });

  it('an answer to a `call` sent before a `capture` message changes nothing on notes', async () => {
    buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    let release: ((a: CallAnswer) => void) | null = null;
    world.worker.call = () => new Promise<CallAnswer>((r) => (release = r));
    // A keep-alive goes; the worker answered it before Start, the answer arrives after.
    await settle(TIMING.keepAliveMs);
    expect(release).not.toBeNull();
    await world.toPage({ t: 'capture', on: true });
    release!({ button: true, notes: false });
    await settle(0);
    expect(content!.capture.on).toBe(true);
    expect(rootOf()!.querySelector('.dot')!.hasAttribute('hidden')).toBe(false);
  });

  it('pagehide sends what waits, once', async () => {
    const meet = buildMeet(document);
    start();
    world.worker.lines = () => ({ ok: false, retry: true });
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'Closing the tab now');
    await settle(TIMING.debounceMs + 10);
    const before = world.worker.of('lines').length;
    window.dispatchEvent(new Event('pagehide'));
    expect(world.worker.of('lines')).toHaveLength(before + 1);
  });
});

describe('MP10: message hygiene in the page', () => {
  it("answers only this extension's worker messages", async () => {
    buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    expect(await world.toPage({ t: 'capture', on: true }, { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js' })).toBeUndefined();
    expect(content!.capture.on).toBe(false);
    expect(await world.toPage({ t: 'surprise' })).toBeUndefined();
    expect(await world.toPage({ t: 'capture', on: true })).toEqual({ ok: true });
  });

  it("never answers its own message types (the fake's sendMessage reaches it, Chrome's would not)", () => {
    buildMeet(document);
    start();
    const page = world.chrome.runtime.onMessage.listeners.at(-1)!;
    const respond = vi.fn();
    for (const msg of [{ t: 'call', site: 'meet', inCall: true, callKey: null, title: '' }, { t: 'lines', lines: [] }, { t: 'captions', state: 'none' }, { t: 'shot' }]) {
      expect(page(msg as never, world.model.extensionSender('background.js'), respond)).toBeUndefined();
    }
    expect(respond).not.toHaveBeenCalled();
  });

  it('a page-button shot goes as `shot` on a trusted click only, with the worker\'s flash', async () => {
    buildMeet(document);
    start();
    world.worker.shot = () => ({ ok: false, text: 'Not saved: Meetings are off. Turn them on at your Mac: jantar meetings on' });
    await settle(TIMING.callPollMs);
    cam()!.click();
    await settle(2 * FRAME);
    expect(world.worker.of('shot')).toEqual([]);
    trustedClick(cam()!);
    await settle(2 * FRAME);
    expect(world.worker.of('shot')).toEqual([{ t: 'shot' }]);
    expect(tip()!.textContent).toBe('Not saved: Meetings are off. Turn them on at your Mac: jantar meetings on');
  });

  it('hide answers after two frames; show brings the button back with its flash', async () => {
    buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    let answer: unknown;
    void world.toPage({ t: 'hide' }).then((a) => (answer = a));
    await settle(FRAME);
    expect(answer).toBeUndefined();
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(FRAME);
    expect(answer).toEqual({ ok: true });
    expect(await world.toPage({ t: 'show', flash: 'Saved' })).toEqual({ ok: true });
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
    expect(tip()!.textContent).toBe('Saved');
  });
});

describe('the extension reloaded', () => {
  it('stops everything and says to reload the page', async () => {
    const meet = buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    await world.toPage({ t: 'capture', on: true });
    meet.say('Sam', 'Before the reload');
    await settle(TIMING.debounceMs + 10);
    const sent = world.worker.got.length;
    world.model.invalidate();
    meet.turns[0]!.grow('and after it');
    await settle(TIMING.debounceMs + TIMING.linesEveryMs);
    expect(content!.capture.on).toBe(false);
    expect(content!.call.phase()).toBe('in');
    expect(cam()!.hidden).toBe(true);
    expect(tip()!.textContent).toBe(RELOAD);
    await settle(3 * TIMING.keepAliveMs);
    expect(world.worker.got).toHaveLength(sent);
  });

  it('a click that finds it reloaded says to reload the page, not that the extension did not answer', async () => {
    buildMeet(document);
    start();
    await settle(TIMING.callPollMs);
    expect(shown()).toBe(true);
    world.model.invalidate();
    trustedClick(cam()!);
    await settle(2 * FRAME);
    expect(world.worker.of('shot')).toEqual([]);
    expect(cam()!.hidden).toBe(true);
    expect(tip()!.textContent).toBe(RELOAD);
  });
});
