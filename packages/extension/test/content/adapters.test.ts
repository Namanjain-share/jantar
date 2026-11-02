/**
 * The site adapters on the synthetic fixtures (spec 3.4): the call key in
 * both Meet URL forms, the waiting room and the lobby never in a call, the
 * title cleaned, the region's candidates in order (the loose Teams match
 * never the toolbar's Captions control), the turns with their speakers,
 * nothing read inside a button, and MX9: Meet's structural fallback is
 * strict.
 */
import { MEETING_MARKER } from '@jantar/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { TEAMS_LOBBY, teamsAdapter } from '../../src/content/adapters/teams.js';
import { pageAt } from '../../src/content/adapters/dom.js';
import { h } from '../fixtures/dom.js';
import { buildMeet, meetUrl } from '../fixtures/meet.js';
import { buildTeams, type TeamsCc } from '../fixtures/teams.js';
import { goTo } from './chrome.js';

const said = (blocks: { speaker: string | null; text: string }[]) => blocks.map((b) => [b.speaker, b.text]);

afterEach(() => {
  document.body.replaceChildren();
  document.title = '';
  goTo('/');
});

describe('Meet', () => {
  it('reads the call code from both URL forms, and nothing else', () => {
    const at = (path: string) => meetAdapter.callKey(new URL(`https://meet.google.com${path}`) as unknown as Location);
    expect(at(meetUrl('abc-defg-hij', 'short'))).toBe('abc-defg-hij');
    expect(at(meetUrl('abc-defg-hij', 'meet'))).toBe('abc-defg-hij');
    expect(at('/ABC-DEFG-HIJ?authuser=0')).toBe('abc-defg-hij');
    expect(at('/abcd-efgh-ijkl/')).toBe('abcd-efgh-ijkl');
    for (const p of ['/', '/landing', '/new', '/abc-defg', '/abc-defgh-hij-x']) expect(at(p), p).toBeNull();
  });

  it('is in a call with the code and the captions button or the region; never in the waiting room', () => {
    const meet = buildMeet(document, { state: 'waiting' });
    goTo(meetUrl('abc-defg-hij'));
    // The waiting room shows call_end, but no captions button.
    expect(document.body.textContent).toContain('call_end');
    expect(meetAdapter.inCall(document)).toBe(false);
    meet.join();
    expect(meetAdapter.inCall(document)).toBe(true);
    meet.captionsOff();
    expect(meetAdapter.inCall(document)).toBe(true);
    meet.hooksOff();
    expect(meetAdapter.inCall(document)).toBe(false);
    meet.hooksOn();
    goTo('/landing');
    expect(meetAdapter.inCall(document)).toBe(false);
  });

  it('prefers data-meeting-title, else the page title without "Meet – "; the bare code is no name', () => {
    buildMeet(document, { title: '  Weekly   sync ' });
    expect(meetAdapter.title(document)).toBe('Weekly sync');
    document.body.replaceChildren();
    buildMeet(document, { title: null });
    document.title = 'Meet – Budget review';
    expect(meetAdapter.title(document)).toBe('Budget review');
    document.title = 'Meet - Budget review';
    expect(meetAdapter.title(document)).toBe('Budget review');
    for (const t of ['Meet – abc-defg-hij', 'Meet', 'Google Meet', '']) {
      document.title = t;
      expect(meetAdapter.title(document), t).toBe('');
    }
    document.title = `Meet – ${'x'.repeat(300)}`;
    expect(meetAdapter.title(document)).toHaveLength(120);
  });

  it('finds the region by its candidates in order', () => {
    expect(meetAdapter.region(document)).toBeNull();
    const meet = buildMeet(document);
    expect(meetAdapter.region(document)).toBe(meet.region());
    // A localized label still has "aption" or "ubtit"; then the jsname hooks.
    meet.region().setAttribute('aria-label', 'Subtitles');
    expect(meetAdapter.region(document)).toBe(meet.region());
    meet.region().removeAttribute('role');
    expect(meetAdapter.region(document)).toBe(meet.region());
    meet.region().removeAttribute('jsname');
    expect(meetAdapter.region(document)).toBeNull();
  });

  it('reads each turn with its name, in DOM order, and nothing in the trailing controls', () => {
    const meet = buildMeet(document);
    meet.say('Sam', 'So the plan for Friday');
    meet.say('You', 'Sounds   good\n to me.');
    meet.say(null, 'And the room?');
    const blocks = meetAdapter.blocks(meet.region());
    expect(said(blocks)).toEqual([
      ['Sam', 'So the plan for Friday'],
      ['You', 'Sounds good to me.'],
      [null, 'And the room?'],
    ]);
    expect(blocks.map((b) => b.el)).toEqual(meet.turns.map((t) => t.el));
    expect(blocks.some((b) => /Jump|Settings/.test(b.text))).toBe(false);
  });

  it('never reads a caption class inside a button', () => {
    const meet = buildMeet(document);
    meet.say('Sam', 'Real words');
    meet.region().querySelector('.tail-a button')!.append(h(document, 'div', { class: 'ygicle' }, 'button words'));
    expect(said(meetAdapter.blocks(meet.region()))).toEqual([['Sam', 'Real words']]);
  });

  describe('MX9: the structural fallback is strict', () => {
    it('with every known class renamed, blocks come from the structure', () => {
      const meet = buildMeet(document, { renamed: true });
      expect(meet.region().querySelector('.ygicle, .NWpY1d, .bh44bd, .iTTPOb, .zs7s8d, .KcIKyf, .adE6rb')).toBeNull();
      meet.say('Sam', 'The fallback reads this');
      meet.say('Priya', 'And this one too.');
      const blocks = meetAdapter.blocks(meet.region());
      expect(said(blocks)).toEqual([
        ['Sam', 'The fallback reads this'],
        ['Priya', 'And this one too.'],
      ]);
      expect(blocks.map((b) => b.el)).toEqual(meet.turns.map((t) => t.el));
    });

    it('a child whose name or text part is empty is never a block', () => {
      const meet = buildMeet(document, { renamed: true });
      meet.say('Sam', 'Kept');
      meet.say(null, 'No name, so not a turn here');
      meet.say('Priya', '');
      expect(said(meetAdapter.blocks(meet.region()))).toEqual([['Sam', 'Kept']]);
    });

    it('a trailing child holding a button or [role=button] is never a block, even with text in both parts', () => {
      const meet = buildMeet(document, { renamed: true });
      meet.say('Sam', 'Kept');
      const list = meet.region().firstElementChild!;
      list.append(h(document, 'div', {}, h(document, 'span', {}, 'Label'), h(document, 'button', {}, 'Looks like text')));
      list.append(h(document, 'div', {}, h(document, 'span', {}, 'Label'), h(document, 'span', {}, 'Text'), h(document, 'div', { role: 'button' }, 'More')));
      expect(said(meetAdapter.blocks(meet.region()))).toEqual([['Sam', 'Kept']]);
    });

    it('a region that is itself the list works too', () => {
      const region = h(document, 'div', { role: 'region', 'aria-label': 'Captions' });
      region.append(h(document, 'div', {}, h(document, 'div', {}, 'Alex'), h(document, 'div', {}, 'Straight in the region')));
      document.body.append(region);
      expect(said(meetAdapter.blocks(region))).toEqual([['Alex', 'Straight in the region']]);
    });
  });

  it('has its spot, and names Meet as the way to turn captions on', () => {
    expect(meetAdapter.cc.client(document)).toBe('meet');
    expect(meetAdapter.spot).toEqual({ left: '12px', top: '50%' });
  });
});

describe('Teams', () => {
  it('has no call key: the tab is the call', () => {
    expect(teamsAdapter.callKey(new URL('https://teams.cloud.microsoft/v2/') as unknown as Location)).toBeNull();
  });

  it('is in a call by a hang-up button or a caption container; never in the lobby', () => {
    const lobby = buildTeams(document, { state: 'lobby' });
    expect(document.querySelector('#prejoin-join-button')).not.toBeNull();
    expect(teamsAdapter.inCall(document)).toBe(false);
    lobby.join();
    expect(teamsAdapter.inCall(document)).toBe(true);
    lobby.captionsOff();
    expect(teamsAdapter.inCall(document)).toBe(true);
    lobby.hooksOff();
    expect(teamsAdapter.inCall(document)).toBe(false);
    lobby.remove();
    buildTeams(document, { layout: 'v2', anon: true, captions: false });
    expect(teamsAdapter.inCall(document)).toBe(true);
    for (const tid of ['hangup-leave-button', 'hangup-end-meeting-button', 'hangup-button']) {
      document.body.replaceChildren(h(document, 'button', { 'data-tid': tid }, 'Leave'));
      expect(teamsAdapter.inCall(document), tid).toBe(true);
    }
    // Only the specific hooks count: the loose substring match is region()'s fallback, never asked every second.
    document.body.replaceChildren(h(document, 'div', { 'data-tid': 'closed-caption-pane' }, h(document, 'span', { 'data-tid': 'closed-caption-text' }, 'Hello')));
    expect(teamsAdapter.region(document)).not.toBeNull();
    expect(teamsAdapter.inCall(document)).toBe(false);
  });

  it('cleans the page title', () => {
    const cases: [string, string][] = [
      ['Weekly sync | Microsoft Teams', 'Weekly sync'],
      ['(3) Weekly sync | Microsoft Teams', 'Weekly sync'],
      ['Chat | Weekly sync | Microsoft Teams', 'Weekly sync'],
      ['Calendar | Microsoft Teams', ''],
      ['Activity | Microsoft Teams', ''],
      ['Meet now | Microsoft Teams', ''],
      ['Meeting with Sam | Microsoft Teams', ''],
      ['Microsoft Teams', ''],
    ];
    for (const [title, want] of cases) {
      document.title = title;
      expect(teamsAdapter.title(document), title).toBe(want);
    }
  });

  it.each(['v2', '2026-bottom', '2026-right'] as const)('finds the %s container first', (layout) => {
    const teams = buildTeams(document, { layout });
    expect(teamsAdapter.region(document)).toBe(teams.region());
  });

  it('takes the loose match only when it holds caption text, never the toolbar Captions control', () => {
    const teams = buildTeams(document, { layout: 'loose' });
    const toggle = document.querySelector('[data-tid="closed-captions-button-on"]')!;
    // The toggle comes first in the page and matches the loose selector.
    expect(document.querySelector('[data-tid*="closed-caption"]')).toBe(toggle);
    // Nothing said yet: the loose container holds no caption text, and the toggle never counts.
    expect(teamsAdapter.region(document)).toBeNull();
    teams.say('Sam', 'Now it reads');
    expect(teamsAdapter.region(document)).toBe(teams.region());
    expect(said(teamsAdapter.blocks(teams.region()))).toEqual([['Sam', 'Now it reads']]);
    teams.captionsOff();
    expect(teamsAdapter.region(document)).toBeNull();
  });

  it.each(['v2', '2026-bottom', '2026-right'] as const)('%s: each utterance with its author; a missing author is null', (layout) => {
    const teams = buildTeams(document, { layout });
    teams.say('Sam', 'Can everyone see my screen?');
    teams.say(null, 'Yes we can.');
    teams.say('Priya', 'Go ahead.');
    const blocks = teamsAdapter.blocks(teams.region());
    expect(said(blocks)).toEqual([
      ['Sam', 'Can everyone see my screen?'],
      [null, 'Yes we can.'],
      ['Priya', 'Go ahead.'],
    ]);
    // One element per utterance: the Fluent UI item where there is one, else the list item.
    blocks.forEach((b, i) => expect(b.el === teams.items[i]!.el || b.el === teams.items[i]!.el.querySelector('.fui-ChatMessageCompact')).toBe(true));
  });

  it('also reads closed-caption-message and closed-caption-author', () => {
    const region = h(document, 'div', { 'data-tid': 'closed-captions-renderer' });
    region.append(h(document, 'div', {}, h(document, 'span', { 'data-tid': 'closed-caption-author' }, 'Alex'), h(document, 'span', { 'data-tid': 'closed-caption-message' }, 'Older Teams')));
    document.body.append(region);
    expect(teamsAdapter.region(document)).toBe(region);
    expect(said(teamsAdapter.blocks(region))).toEqual([['Alex', 'Older Teams']]);
  });

  it('has its spot, and names signed-in Teams or a light-meetings guest as the way to turn captions on', () => {
    goTo('/v2/');
    expect(teamsAdapter.cc.client(document)).toBe('teams');
    goTo('/light-meetings/launch?anon=true&p=made-up');
    expect(teamsAdapter.cc.client(document)).toBe('light');
    goTo('/v2/');
    buildTeams(document, { layout: 'v2', anon: true });
    expect(teamsAdapter.cc.client(document)).toBe('light');
    expect(teamsAdapter.spot).toEqual({ left: '76px', top: '50%' });
  });
});

describe('v0.10: the screens around the call', () => {
  const none = { joinHookAt: null };

  it('Meet: the join screen, the waiting room, the call and the screen after Leave, each by its hook', () => {
    goTo(meetUrl('abc-defg-hij', 'short'));
    const meet = buildMeet(document, { state: 'prejoin' });
    expect(meetAdapter.waiting(document, none)).toEqual({ stage: 'prejoin', hook: 'meet:join-button', strong: true });
    expect(meetAdapter.inCallHook(document)).toBeNull();
    meet.askToJoin();
    expect(meetAdapter.waiting(document, none)).toEqual({ stage: 'lobby', hook: 'meet:call_end', strong: true });
    expect(meetAdapter.inCall(document)).toBe(false);
    meet.admit();
    expect(meetAdapter.inCallHook(document)).toBe('meet:captions-button');
    expect(meetAdapter.inCall(document)).toBe(true);
    expect(meetAdapter.waiting(document, none)).toBeNull();
    // The region alone still counts, as inCall did.
    document.querySelector('button[jsname="RrG0hf"]')!.remove();
    expect(meetAdapter.inCallHook(document)).toBe('meet:caption-region');
    meet.leave();
    expect(meetAdapter.inCallHook(document)).toBeNull();
    // "You left": the code alone, a fallback (the call watch's memory makes it `left`).
    expect(meetAdapter.waiting(document, none)).toEqual({ stage: 'prejoin', hook: 'meet:code', strong: false });
    goTo('/landing');
    expect(meetAdapter.waiting(document, none)).toBeNull();
  });

  it('Meet: the captions control by its icon is in the call too, with captions off (the 2026-10-22 "Captions and translation" button)', () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { state: 'lobby', cc: 'popup', captions: false });
    // The waiting room has no captions icon (call_end only).
    expect(meetAdapter.inCallHook(document)).toBeNull();
    meet.admit();
    meet.captionsOff();
    // No jsname on the new button, no region: the icon decides.
    expect(document.querySelector('button[jsname="RrG0hf"]')).toBeNull();
    expect(meetAdapter.inCallHook(document)).toBe('meet:captions-icon');
    expect(meetAdapter.waiting(document, none)).toBeNull();
    // Only a pressed button or a pop-up's, holding exactly a captions glyph.
    document.body.replaceChildren();
    document.body.append(h(document, 'button', {}, h(document, 'i', { class: 'google-symbols' }, 'closed_caption')));
    document.body.append(h(document, 'button', { 'aria-pressed': 'false' }, h(document, 'i', { class: 'google-symbols' }, 'closed_caption_disabled')));
    document.body.append(h(document, 'button', { 'aria-pressed': 'false' }, 'closed_caption_off'));
    expect(meetAdapter.inCallHook(document)).toBeNull();
    for (const icon of ['translate_cc', 'closed_caption', 'closed_caption_off']) {
      document.body.replaceChildren(h(document, 'button', { 'aria-pressed': 'false' }, h(document, 'i', { class: 'google-material-icons' }, icon)));
      expect(meetAdapter.inCallHook(document), icon).toBe('meet:captions-icon');
    }
  });

  it("Meet: v0.5's waiting room (call_end and an Ask to join without the jsname) reads as the waiting room", () => {
    goTo(meetUrl('abc-defg-hij'));
    buildMeet(document, { state: 'waiting' });
    expect(meetAdapter.waiting(document, none)).toEqual({ stage: 'lobby', hook: 'meet:call_end', strong: true });
  });

  it('Meet: call_end only as an icon inside a button, exactly that glyph name', () => {
    goTo(meetUrl('abc-defg-hij'));
    document.body.append(h(document, 'div', {}, h(document, 'i', { class: 'google-symbols' }, 'call_end')));
    document.body.append(h(document, 'button', {}, h(document, 'i', { class: 'google-symbols' }, 'call_end_alt')));
    document.body.append(h(document, 'button', {}, 'call_end'));
    expect(meetAdapter.waiting(document, none)).toMatchObject({ hook: 'meet:code' });
    document.body.append(h(document, 'button', {}, h(document, 'i', { class: 'material-icons-extended' }, ' call_end ')));
    expect(meetAdapter.waiting(document, none)).toMatchObject({ stage: 'lobby', hook: 'meet:call_end' });
  });

  it('Teams: the join screen, the waiting room after Join now at the same URL, nothing at another', () => {
    goTo('/v2/?meetingjoin=true&p=made-up');
    const teams = buildTeams(document, { state: 'prejoin' });
    expect(teamsAdapter.waiting(document, none)).toEqual({ stage: 'prejoin', hook: 'teams:prejoin-join', strong: true });
    teams.clickJoin();
    const seen = { joinHookAt: pageAt(document.location) };
    expect(teamsAdapter.waiting(document, seen)).toEqual({ stage: 'lobby', hook: 'teams:after-join', strong: true });
    // Never seen a join button: the join link alone, a fallback.
    expect(teamsAdapter.waiting(document, none)).toEqual({ stage: 'prejoin', hook: 'teams:join-link', strong: false });
    teams.admit();
    expect(teamsAdapter.inCallHook(document)).toBe('teams:hangup-button');
    expect(teamsAdapter.waiting(document, seen)).toBeNull();
    teams.leave();
    goTo('/v2/');
    expect(teamsAdapter.waiting(document, seen)).toBeNull();
  });

  it('Teams: off a join link a join screen seen before proves no waiting room (v2 keeps /v2/ for Chat too)', () => {
    goTo('/v2/');
    const teams = buildTeams(document, { state: 'prejoin' });
    expect(teamsAdapter.waiting(document, none)).toEqual({ stage: 'prejoin', hook: 'teams:prejoin-join', strong: true });
    const seen = { joinHookAt: pageAt(document.location) };
    teams.toChat();
    expect(teamsAdapter.waiting(document, seen)).toBeNull();
    teams.clickJoin();
    expect(teamsAdapter.waiting(document, seen)).toBeNull();
  });

  it('Teams: a join link by its path alone; Chat and Calendar are none', () => {
    buildTeams(document, { state: 'waiting', light: true });
    for (const path of ['/light-meetings/launch?anon=1&p=made-up', '/l/meetup-join/made-up-thread/0?context=x', '/meet/1234567890?p=made-up', '/dl/launcher/launcher.html?type=meetup-join']) {
      goTo(path);
      expect(teamsAdapter.waiting(document, none), path).toEqual({ stage: 'prejoin', hook: 'teams:join-link', strong: false });
    }
    for (const path of ['/v2/', '/v2/#/calendar', '/_#/conversations/made-up']) {
      goTo(path);
      expect(teamsAdapter.waiting(document, none), path).toBeNull();
    }
  });

  it('Teams: each hang-up has its own hook id; an anonymous guest is in the call', () => {
    buildTeams(document, { layout: 'v2', anon: true, captions: false });
    expect(teamsAdapter.inCallHook(document)).toBe('teams:anon-hangup-button');
    for (const [tid, id] of [
      ['hangup-main-btn', 'teams:hangup-main-btn'],
      ['hangup-leave-button', 'teams:hangup-leave-button'],
      ['hangup-end-meeting-button', 'teams:hangup-end-meeting-button'],
      ['hangup-button', 'teams:hangup-button-tid'],
    ]) {
      document.body.replaceChildren(h(document, 'button', { 'data-tid': tid! }, 'Leave'));
      expect(teamsAdapter.inCallHook(document), tid).toBe(id);
    }
    document.body.replaceChildren(h(document, 'div', { 'data-tid': 'closed-caption-renderer-wrapper' }));
    expect(teamsAdapter.inCallHook(document)).toBe('teams:caption-region');
  });

  it('Teams (open risk, R12): no lobby-only hook is known yet, so a waiting room showing a hang-up reads as in the call', () => {
    expect(TEAMS_LOBBY).toEqual([]);
    goTo('/v2/');
    buildTeams(document, { state: 'waiting', lobbyHangup: true });
    expect(teamsAdapter.inCall(document)).toBe(true);
    expect(teamsAdapter.waiting(document, none)).toBeNull();
  });

  it('MP6: neither adapter calls region() or blocks(), and nothing said reaches a stage or a hook', () => {
    const spies = [vi.spyOn(meetAdapter, 'region'), vi.spyOn(meetAdapter, 'blocks'), vi.spyOn(teamsAdapter, 'region'), vi.spyOn(teamsAdapter, 'blocks')];
    const outputs: unknown[] = [];
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { state: 'lobby' });
    meet.admit();
    meet.say('Sam', `Said in the call ${MEETING_MARKER}`);
    document.title = `Meet – ${MEETING_MARKER}`;
    outputs.push(meetAdapter.inCallHook(document), meetAdapter.waiting(document, none));
    meet.leave();
    outputs.push(meetAdapter.inCallHook(document), meetAdapter.waiting(document, none));
    document.body.replaceChildren();
    goTo('/light-meetings/launch?anon=1');
    const teams = buildTeams(document, { layout: 'v2', light: true });
    teams.say('Priya', `Also said ${MEETING_MARKER}`);
    outputs.push(teamsAdapter.inCallHook(document), teamsAdapter.waiting(document, none));
    teams.leave();
    outputs.push(teamsAdapter.inCallHook(document), teamsAdapter.waiting(document, { joinHookAt: pageAt(document.location) }));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(outputs)).not.toContain(MEETING_MARKER);
    expect(JSON.stringify(outputs)).not.toMatch(/Sam|Priya|said/i);
  });
});

describe('v0.10: light meetings (the guest client) and the call\'s captions control', () => {
  /** Keys pressed on the page from now on. */
  const keys = () => {
    const out: string[] = [];
    document.addEventListener('keydown', (ev) => out.push(ev.key));
    return out;
  };
  /** A try: `blind` allows the one blind click (default: notes started just after the page came into the call). */
  const tries = (attempt = 1, o: { blind?: boolean } = {}) => ({ wait: async () => undefined, attempt, blind: o.blind ?? true, live: () => true });

  it('Teams light meetings: the guest tree (no Fluent UI item) reads each entry with its author; #hangup-button is in the call', () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true });
    expect(teamsAdapter.inCallHook(document)).toBe('teams:hangup-button');
    teams.say('Sam', 'Can everyone hear me?');
    teams.say(null, 'Yes, loud and clear.');
    teams.say('Priya', 'Then let us start.');
    const region = teamsAdapter.region(document)!;
    expect(region.getAttribute('data-tid')).toBe('closed-caption-renderer-wrapper');
    expect(region.querySelector('.fui-ChatMessageCompact')).toBeNull();
    expect(said(teamsAdapter.blocks(region))).toEqual([
      ['Sam', 'Can everyone hear me?'],
      [null, 'Yes, loud and clear.'],
      ['Priya', 'Then let us start.'],
    ]);
  });

  it('Teams: the virtual list alone is a region too (the last exact candidate); authors beside their texts pair by order', () => {
    const list = h(
      document,
      'div',
      { 'data-tid': 'closed-caption-v2-virtual-list-content' },
      h(
        document,
        'div',
        {},
        h(document, 'span', { 'data-tid': 'author' }, 'Sam'),
        h(document, 'span', { 'data-tid': 'closed-caption-text' }, 'First words.'),
        h(document, 'span', { 'data-tid': 'closed-caption-text' }, 'More from Sam.'),
        h(document, 'span', { 'data-tid': 'author' }, 'Priya'),
        h(document, 'span', { 'data-tid': 'closed-caption-text' }, 'My turn.'),
      ),
    );
    document.body.append(list);
    expect(teamsAdapter.region(document)).toBe(list);
    expect(teamsAdapter.inCallHook(document)).toBe('teams:caption-region');
    expect(said(teamsAdapter.blocks(list))).toEqual([
      ['Sam', 'First words.'],
      [null, 'More from Sam.'],
      ['Priya', 'My turn.'],
    ]);
  });

  it('Meet, the old toggle: on and off from aria-pressed; a try clicks it only when off, and the last try presses c', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { captions: false });
    expect(meetAdapter.cc.state(document)).toEqual({ state: 'off', hook: 'meet:captions-button' });
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'meet:cc-button' });
    expect(meet.captionsShown()).toBe(true);
    meet.say('Sam', 'Now on');
    expect(meetAdapter.cc.state(document)).toEqual({ state: 'on', hook: 'meet:caption-region' });
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'on', hook: 'meet:captions-button' });
    expect(meet.ccLog).toEqual(['button']);
    meet.captionsOff();
    expect(await meetAdapter.cc.turnOn(document, tries(3))).toEqual({ result: 'clicked', hook: 'meet:key-c' });
    expect(meet.ccLog).toEqual(['button', 'key-c']);
    expect(meet.captionsShown()).toBe(true);
  });

  it("Meet, the old toggle: with neither aria-pressed, a known icon nor an English label, it is unknown and never touched", async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { captions: false });
    const b = document.querySelector('button[jsname="RrG0hf"]')!;
    b.removeAttribute('aria-pressed');
    b.setAttribute('aria-label', 'Untertitel');
    b.querySelector('i')!.textContent = 'closed_caption';
    expect(meetAdapter.cc.state(document)).toEqual({ state: 'unknown', hook: 'meet:captions-button' });
    expect(await meetAdapter.cc.turnOn(document, tries(3))).toEqual({ result: 'none', hook: 'meet:captions-button' });
    expect(meet.ccLog).toEqual([]);
    // The icon alone says off; the English label alone too.
    b.querySelector('i')!.textContent = 'closed_caption_off';
    expect(meetAdapter.cc.state(document).state).toBe('off');
    b.querySelector('i')!.textContent = 'closed_caption';
    b.setAttribute('aria-label', 'Turn on captions');
    expect(meetAdapter.cc.state(document).state).toBe('off');
    b.setAttribute('aria-label', 'Turn off captions');
    expect(meetAdapter.cc.state(document).state).toBe('on');
  });

  it('Meet, "Captions and translation": a try opens the pop-up, turns the toggle on and closes the pop-up', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { cc: 'popup', captions: false });
    expect(meetAdapter.cc.state(document)).toEqual({ state: 'off', hook: 'meet:captions-icon' });
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'meet:cc-popup' });
    expect(meet.ccLog).toEqual(['popup-open', 'toggle', 'popup-close']);
    expect(meet.captionsShown()).toBe(true);
    expect(meet.popupOpen()).toBe(false);
    expect(meetAdapter.cc.state(document)).toEqual({ state: 'on', hook: 'meet:captions-icon' });
    // On: nothing is opened or clicked.
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'on', hook: 'meet:captions-icon' });
    expect(meet.ccLog).toHaveLength(3);
  });

  it('Meet: a pop-up he opened himself is left alone; a pop-up with no toggle falls back to c (the control said off)', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { cc: 'popup', captions: false });
    const button = document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
    button.click();
    meet.ccLog.length = 0;
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'busy', hook: 'meet:captions-icon' });
    expect(meet.ccLog).toEqual([]);
    button.click();
    meet.ccLog.length = 0;
    // A redesign that draws no toggle in the pop-up.
    document.querySelector('[role="dialog"]')?.remove();
    const lone = h(document, 'button', { 'aria-haspopup': 'dialog', 'aria-pressed': 'false', 'aria-label': 'Captions and translation' }, h(document, 'i', { class: 'google-symbols' }, 'translate_cc'));
    button.replaceWith(lone);
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'meet:key-c' });
    expect(meet.ccLog).toEqual(['key-c']);
    expect(meet.captionsShown()).toBe(true);
  });

  it('Meet: no captions control at all is none, and an empty caption container is not "on"', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { captions: false, emptyContainer: true });
    expect(meetAdapter.region(document)?.getAttribute('jscontroller')).toBe('D1tHje');
    expect(meetAdapter.cc.state(document).state).toBe('off');
    meet.hooksOff();
    expect(meetAdapter.cc.state(document)).toEqual({ state: 'unknown', hook: 'meet:no-cc' });
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'none', hook: 'meet:no-cc' });
    expect(meet.ccLog).toEqual([]);
  });

  it('Teams, pinned in the toolbar: its data-tid says on or off; a try clicks it only when off', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: '2026-bottom', captions: false });
    expect(teamsAdapter.cc.state(document)).toEqual({ state: 'off', hook: 'teams:cc-toggle' });
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'teams:cc-pinned' });
    expect(teams.captionsShown()).toBe(true);
    expect(teamsAdapter.cc.state(document)).toEqual({ state: 'on', hook: 'teams:caption-region' });
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'on', hook: 'teams:cc-pinned' });
    expect(teams.ccLog).toEqual(['pinned']);
  });

  const cases: [string, { cc: TeamsCc; light?: true }, string[], string, true?][] = [
    ['More › Captions, signed in (the item says off)', { cc: 'more' }, ['more-open', 'item'], 'teams:cc-more-item'],
    ['More › Captions, a light-meetings guest (the item says nothing: the blind click)', { cc: 'more', light: true }, ['more-open', 'item'], 'teams:cc-more-item', true],
    ['More › Language and speech › Show live captions', { cc: 'lang-speech' }, ['more-open', 'language-and-speech', 'item'], 'teams:cc-lang-speech'],
  ];
  for (const [name, o, log, hook, blind] of cases) {
    it(`Teams, ${name}: a try opens More, clicks the item, and the menu is closed after`, async () => {
      goTo(o.light ? '/light-meetings/launch?anon=true&p=made-up' : '/v2/');
      const teams = buildTeams(document, { layout: o.light ? 'guest' : 'v2', captions: false, lateRegion: true, ...o });
      expect(teamsAdapter.cc.state(document).state).toBe('unknown');
      expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook, ...(blind ? { blind } : {}) });
      expect(teams.ccLog).toEqual(log);
      expect(teams.captionsShown()).toBe(true);
      expect(teams.menuOpen()).toBe(false);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });
  }

  it('Teams: an item that says on is never clicked; More is closed again', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more', lateRegion: true });
    // Captions on, but nobody has spoken: nothing on the page says so until More is opened.
    expect(teamsAdapter.cc.state(document).state).toBe('unknown');
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'on', hook: 'teams:cc-more-item' });
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(teams.captionsShown()).toBe(true);
    expect(teams.menuOpen()).toBe(false);
  });

  it("Teams: More with no captions item (the organizer's policy) is none, and More is closed; More he opened himself is left alone; no More is none", async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'disabled', captions: false });
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'unavailable', hook: 'teams:no-cc-item' });
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(teams.menuOpen()).toBe(false);
    (document.querySelector('#callingButtons-showMoreBtn') as HTMLButtonElement).click();
    teams.ccLog.length = 0;
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'busy', hook: 'teams:more-open' });
    expect(teams.ccLog).toEqual([]);
    expect(teams.menuOpen()).toBe(true);
    document.body.replaceChildren();
    buildTeams(document, { layout: 'v2', cc: 'absent', captions: false });
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'none', hook: 'teams:no-more' });
  });

  it('Teams: Escape closes a menu that More did not close; an English item matches only exactly', async () => {
    goTo('/v2/');
    buildTeams(document, { layout: 'v2', cc: 'absent', captions: false });
    // A More whose menu has only an item named in English, and which never says it is open.
    const more = h(document, 'button', { 'aria-label': 'More actions' }, '…');
    const items = [h(document, 'div', { role: 'menuitem' }, 'Captions settings'), h(document, 'div', { role: 'menuitem' }, '  Live   captions ')];
    let clicked = '';
    for (const item of items) item.addEventListener('click', () => (clicked = item.textContent ?? ''));
    const menu = h(document, 'div', { role: 'menu' }, ...items);
    let escaped = false;
    menu.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        escaped = true;
        menu.remove();
      }
    });
    more.addEventListener('click', () => document.body.append(menu));
    // The English label counts only in the call's own bar (beside its hang-up).
    document.querySelector('[role="toolbar"]')!.append(more);
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'teams:cc-text', blind: true });
    expect(clicked).toBe('  Live   captions ');
    expect(escaped).toBe(true);
    expect(menu.isConnected).toBe(false);
  });

  it("Teams: a guest's item that says nothing, without a blind click allowed, is \"unsure\": not clicked, More closed", async () => {
    goTo('/light-meetings/launch?anon=true&p=made-up');
    const teams = buildTeams(document, { layout: 'guest', light: true, hangupId: true, captions: true, lateRegion: true });
    expect(await teamsAdapter.cc.turnOn(document, tries(1, { blind: false }))).toEqual({ result: 'unsure', hook: 'teams:cc-more-item' });
    expect(teams.ccLog).toEqual(['more-open', 'more-close']);
    expect(teams.captionsShown()).toBe(true);
    // Allowed, it is the blind click, said so.
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'teams:cc-more-item', blind: true });
    // An item that says off is no blind click.
    document.body.replaceChildren();
    goTo('/v2/');
    buildTeams(document, { layout: 'v2', cc: 'more', captions: false, lateRegion: true });
    expect(await teamsAdapter.cc.turnOn(document, tries(1, { blind: false }))).toEqual({ result: 'clicked', hook: 'teams:cc-more-item' });
  });

  it('Teams: a "More options" outside the call\'s bar (a tile\'s, a chat message\'s) is not More', async () => {
    goTo('/v2/');
    buildTeams(document, { layout: 'v2', cc: 'absent', captions: false });
    const tile = h(document, 'button', { 'aria-label': 'More options' }, '…');
    let opened = 0;
    tile.addEventListener('click', () => (opened += 1));
    document.body.prepend(h(document, 'div', { class: 'tile' }, tile));
    expect(await teamsAdapter.cc.turnOn(document, tries())).toEqual({ result: 'none', hook: 'teams:no-more' });
    expect(opened).toBe(0);
  });

  it('Meet: the pop-up is taken only when new and named as the button; its toggle is the first button that says what captions are', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { cc: 'popup', captions: false });
    // Someone asks to join: a dialog already on the page, before the click.
    const asking = h(document, 'div', { role: 'dialog', 'aria-label': 'Captions and translation' }, h(document, 'button', { 'aria-label': 'Turn on captions' }, 'Admit'));
    let admitted = 0;
    asking.querySelector('button')!.addEventListener('click', () => (admitted += 1));
    document.body.prepend(asking);
    // A Close button first in the pop-up, saying nothing about captions.
    const close = h(document, 'button', { 'aria-label': 'Close' }, 'x');
    let closed = 0;
    close.addEventListener('click', () => (closed += 1));
    document.querySelector('button[aria-haspopup="dialog"]')!.addEventListener('click', () => {
      const dialog = document.querySelector('[data-jantar-fixture] [role="dialog"]');
      if (dialog && !dialog.contains(close)) dialog.prepend(close);
    });
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'meet:cc-popup' });
    expect(meet.ccLog).toEqual(['popup-open', 'toggle', 'popup-close']);
    expect([admitted, closed]).toEqual([0, 0]);
    expect(meet.captionsShown()).toBe(true);
  });

  it('Meet: the pop-up\'s toggle and the toolbar disagree: nothing is clicked or pressed, the pop-up is closed', async () => {
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document, { cc: 'popup', captions: false });
    // The toolbar says off (aria-pressed false); the toggle, once open, says on.
    document.querySelector('button[aria-haspopup="dialog"]')!.addEventListener('click', () => {
      document.querySelector('[role="dialog"] button:not([aria-haspopup])')?.setAttribute('aria-label', 'Turn off captions');
    });
    const pressed = keys();
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'none', hook: 'meet:cc-disagree' });
    expect(meet.ccLog).toEqual(['popup-open', 'popup-close']);
    expect(pressed).toEqual([]);
    expect(meet.captionsShown()).toBe(false);
  });

  it('Meet: a control with aria-haspopup "true" or "menu" is no plain toggle: its pop-up is opened and closed again (a menu with no toggle, then c: it said off)', async () => {
    goTo(meetUrl('abc-defg-hij'));
    let meet = buildMeet(document, { cc: 'popup', captions: false });
    document.querySelector('button[aria-haspopup="dialog"]')!.setAttribute('aria-haspopup', 'true');
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'meet:cc-popup' });
    expect(meet.ccLog).toEqual(['popup-open', 'toggle', 'popup-close']);
    expect(meet.popupOpen()).toBe(false);
    document.body.replaceChildren();
    meet = buildMeet(document, { cc: 'popup', captions: false });
    const button = document.querySelector('button[aria-haspopup="dialog"]')!;
    button.setAttribute('aria-haspopup', 'menu');
    // What it opens is a menu, not a dialog.
    button.addEventListener('click', () => document.querySelector('[data-jantar-fixture] [role="dialog"]')?.setAttribute('role', 'menu'));
    expect(await meetAdapter.cc.turnOn(document, tries())).toEqual({ result: 'clicked', hook: 'meet:key-c' });
    expect(meet.ccLog).toEqual(['popup-open', 'popup-close', 'key-c']);
    expect(meet.popupOpen()).toBe(false);
    expect(meet.captionsShown()).toBe(true);
  });

  it('MP6: the captions control never reads caption text into what it says', async () => {
    goTo('/v2/');
    const teams = buildTeams(document, { layout: 'v2', cc: 'more' });
    teams.say('Sam', `Said ${MEETING_MARKER}`);
    const outs = [teamsAdapter.cc.state(document), await teamsAdapter.cc.turnOn(document, tries())];
    document.body.replaceChildren();
    goTo(meetUrl('abc-defg-hij'));
    const meet = buildMeet(document);
    meet.say('Priya', `Said ${MEETING_MARKER}`);
    outs.push(meetAdapter.cc.state(document), await meetAdapter.cc.turnOn(document, tries()));
    expect(JSON.stringify(outs)).not.toContain(MEETING_MARKER);
    expect(JSON.stringify(outs)).not.toMatch(/Sam|Priya/);
  });
});
