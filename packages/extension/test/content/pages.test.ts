// @vitest-environment node
/**
 * The fixture pages for the end-to-end suite (spec 9.2): each page's HTML
 * holds no inline script or style, its bundled driver builds the meeting the
 * adapters read (in a JSDOM at the real meeting URL), and `__step` drives
 * it. On node: esbuild, which bundles the driver, does not run under the
 * jsdom environment.
 */
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import { FIXTURE_PAGES, FIXTURE_SCRIPT_PATH, PAGE_BACKGROUND, STRICT_CSP, fixtureDriverScript, fixturePageHtml, type FixturePageName } from '../fixtures/pages.js';

// jsdom ships no types and the workspace adds none: the little used here, typed by hand.
type Dom = { window: Window & typeof globalThis & { eval(code: string): unknown } };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, opts: object) => Dom };

let driver: string;

beforeAll(async () => {
  driver = await fixtureDriverScript();
}, 60_000);

const URLS: Record<'meet' | 'teams', string> = {
  meet: 'https://meet.google.com/meet/abc-defg-hij',
  teams: 'https://teams.cloud.microsoft/v2/',
};

function open(name: FixturePageName) {
  const site = name.startsWith('meet') ? 'meet' : 'teams';
  const dom = new JSDOM(fixturePageHtml(name), { url: URLS[site], runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(driver);
  const step = (s: string, ...args: unknown[]) => (dom.window as unknown as { __step(n: string, ...a: unknown[]): unknown }).__step(s, ...args);
  return { dom, doc: dom.window.document, adapter: site === 'meet' ? meetAdapter : teamsAdapter, step };
}

describe('the fixture pages', () => {
  it('hold no inline script or style, and load the driver from their own origin', () => {
    for (const name of FIXTURE_PAGES) {
      const html = fixturePageHtml(name);
      expect(html).toContain(`<script src="${FIXTURE_SCRIPT_PATH}"></script>`);
      expect(html).not.toMatch(/<script\b[^>]*>[^<]/);
      expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/i);
      expect(html).toContain(`data-fixture="${name}"`);
    }
    expect(STRICT_CSP).toBe("default-src 'self'; style-src 'self'; require-trusted-types-for 'script'");
  });

  it('the driver writes no HTML (a Trusted Types page runs it) and fetches nothing', () => {
    expect(driver).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(|XMLHttpRequest/);
  });

  it.each(FIXTURE_PAGES.map((n) => [n]))('%s builds a page its adapter reads', (name) => {
    const { doc, adapter, step, dom } = open(name);
    expect(dom.window.getComputedStyle(doc.body).backgroundColor).toBe(PAGE_BACKGROUND);
    const waiting = name === 'meet-waiting' || name === 'teams-lobby';
    expect(adapter.inCall(doc)).toBe(!waiting);
    if (waiting) step('join');
    expect(adapter.inCall(doc)).toBe(true);
    if (name === 'teams-loose') expect(adapter.region(doc)).toBeNull();
    expect(step('say', 'Sam', 'So the plan for Friday')).toBe(0);
    step('say', null, 'Is everyone here?');
    step('grow', 0, 'is to ship.');
    const region = adapter.region(doc)!;
    expect(region).not.toBeNull();
    const blocks = adapter.blocks(region).map((b) => [b.speaker, b.text]);
    expect(blocks).toEqual([
      ['Sam', 'So the plan for Friday is to ship.'],
      // Meet's structural fallback is strict: a turn without a name is not read (MX9).
      ...(name === 'meet-renamed' ? [] : [[null, 'Is everyone here?']]),
    ]);
    expect(step('shown')).toEqual(['So the plan for Friday is to ship.', 'Is everyone here?']);
  });

  it('drives the hooks, the captions, a redraw and a new Meet code', () => {
    const { doc, step, dom } = open('meet-call');
    expect(meetAdapter.callKey(dom.window.location as unknown as Location)).toBe('abc-defg-hij');
    expect(meetAdapter.title(doc)).toBe('Weekly sync');
    step('say', 'Priya', 'Hello');
    step('hooksOff');
    expect(meetAdapter.inCall(doc)).toBe(false);
    step('say', 'Sam', 'Said while the hooks were gone');
    step('hooksOn');
    expect(meetAdapter.blocks(meetAdapter.region(doc)!).map((b) => b.text)).toEqual(['Hello', 'Said while the hooks were gone']);
    const before = meetAdapter.region(doc);
    step('replaceRegion');
    expect(meetAdapter.region(doc)).not.toBe(before);
    step('captionsOff');
    expect(meetAdapter.region(doc)).toBeNull();
    step('captionsOn');
    expect(meetAdapter.region(doc)).not.toBeNull();
    step('trimFront', 1, 2);
    step('setSpeaker', 1, 'Alex');
    expect(meetAdapter.blocks(meetAdapter.region(doc)!).at(-1)).toMatchObject({ speaker: 'Alex', text: 'the hooks were gone' });
    step('goTo', '/meet/xyz-abcd-efg');
    expect(meetAdapter.callKey(dom.window.location as unknown as Location)).toBe('xyz-abcd-efg');
    expect(() => step('nope')).toThrow(/no fixture step nope/);
  });

  it('drives the Teams virtual list: an item unmounted and remounted is a new element with the same words', () => {
    const { doc, step } = open('teams-v2');
    step('say', 'Sam', 'First item');
    step('say', 'Priya', 'Second item');
    const first = teamsAdapter.blocks(teamsAdapter.region(doc)!)[0]!.el;
    step('unmount', 0);
    expect(teamsAdapter.blocks(teamsAdapter.region(doc)!).map((b) => b.text)).toEqual(['Second item']);
    step('remount', 0);
    const again = teamsAdapter.blocks(teamsAdapter.region(doc)!);
    expect(again.map((b) => b.text)).toEqual(['First item', 'Second item']);
    expect(again[0]!.el).not.toBe(first);
  });

  it('the anonymous guest and the Teams title', () => {
    const { doc } = open('teams-anon');
    expect(doc.querySelector('[data-tid="anon-hangup-button"]')).not.toBeNull();
    expect(teamsAdapter.title(doc)).toBe('');
    expect(teamsAdapter.title(open('teams-2026-right').doc)).toBe('Weekly sync');
  });
});
