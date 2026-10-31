/**
 * The fixture pages' driver, bundled by `fixtureDriverScript()` (pages.ts)
 * and served beside the page at FIXTURE_SCRIPT_PATH, so a page with a strict
 * CSP (script-src 'self', Trusted Types) runs it too. It builds the page
 * <html data-fixture> names with DOM calls only, paints its background
 * through CSSOM, and gives the end-to-end suite `window.__step(name, ...args)`:
 *
 *   await page.evaluate(() => window.__step('say', 'Sam', 'So the plan'));   // -> the turn's index
 *   await page.evaluate(() => window.__step('grow', 0, 'for Friday.'));
 *   await page.evaluate(() => window.__step('hooksOff'));
 *   await page.evaluate(() => window.__step('goTo', '/meet/xyz-abcd-efg'));
 *
 * Steps: join, say(speaker, text), set(i, text), grow(i, more),
 * trimFront(i, words) (Meet), setSpeaker(i, name), unmount(i) and
 * remount(i) (Teams), hooksOff, hooksOn, captionsOff, captionsOn,
 * replaceRegion, goTo(path), shown() (the words of every turn).
 */
import { buildMeet, type MeetFixture } from './meet.js';
import { PAGE_BACKGROUND, PAGE_SPECS, type FixturePageName } from './specs.js';
import { buildTeams, type TeamsFixture } from './teams.js';

type Step = (...args: unknown[]) => unknown;

function start(): void {
  const name = document.documentElement.getAttribute('data-fixture') as FixturePageName | null;
  const spec = name ? PAGE_SPECS[name] : undefined;
  if (!spec) return;
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('background', PAGE_BACKGROUND);
    el.style.setProperty('margin', '0');
    el.style.setProperty('min-height', '100vh');
  }
  const meet: MeetFixture | null = spec.site === 'meet' ? buildMeet(document, spec.options) : null;
  const teams: TeamsFixture | null = spec.site === 'teams' ? buildTeams(document, spec.options) : null;
  const fx = (meet ?? teams)!;
  const one = (i: unknown) => (meet ? meet.turns[Number(i)] : teams!.items[Number(i)]);

  const steps: Record<string, Step> = {
    join: () => fx.join(),
    say: (speaker, text) => {
      if (meet) meet.say(speaker as string | null, String(text));
      else teams!.say(speaker as string | null, String(text));
      return (meet ? meet.turns.length : teams!.items.length) - 1;
    },
    set: (i, text) => one(i)?.set(String(text)),
    grow: (i, more) => one(i)?.grow(String(more)),
    trimFront: (i, n) => meet?.turns[Number(i)]?.trimFront(Number(n)),
    setSpeaker: (i, who) => (meet ? meet.turns[Number(i)]?.setSpeaker(who as string | null) : teams!.items[Number(i)]?.setAuthor(who as string | null)),
    unmount: (i) => teams && teams.unmount(teams.items[Number(i)]!),
    remount: (i) => teams && teams.remount(teams.items[Number(i)]!),
    hooksOff: () => fx.hooksOff(),
    hooksOn: () => fx.hooksOn(),
    captionsOff: () => fx.captionsOff(),
    captionsOn: () => fx.captionsOn(),
    replaceRegion: () => fx.replaceRegion(),
    goTo: (path) => history.pushState({}, '', String(path)),
    shown: () => (meet ? meet.turns.map((t) => t.text()) : teams!.items.map((t) => t.text())),
  };

  (window as unknown as { __step: (name: string, ...args: unknown[]) => unknown }).__step = (step, ...args) => {
    const fn = steps[step];
    if (!fn) throw new Error(`no fixture step ${step}`);
    return fn(...args);
  };
}

start();
