/**
 * The site adapters on the synthetic fixtures (spec 3.4): the call key in
 * both Meet URL forms, the waiting room and the lobby never in a call, the
 * title cleaned, the region's candidates in order (the loose Teams match
 * never the toolbar's Captions control), the turns with their speakers,
 * nothing read inside a button, and MX9: Meet's structural fallback is
 * strict.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import { h } from '../fixtures/dom.js';
import { buildMeet, meetUrl } from '../fixtures/meet.js';
import { buildTeams } from '../fixtures/teams.js';
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

  it('has its nudge and spot', () => {
    expect(meetAdapter.howTo).toMatch(/^No captions on screen\. Turn them on with the CC button, or press c\./);
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

  it('has its nudge and spot', () => {
    expect(teamsAdapter.howTo).toContain('Language and speech › Live captions, or Cmd+Shift+A');
    expect(teamsAdapter.spot).toEqual({ left: '76px', top: '50%' });
  });
});
