/**
 * The camera button (spec 3.7, 3.8): a host on <html> with a closed shadow
 * root styled through adoptedStyleSheets and CSSOM only, placed per site;
 * MP10: a click counts only when `isTrusted`; the host hidden for two
 * frames before the shot is asked for, then shown with the flash; a hide
 * the worker asked for shows again by itself when its show never comes;
 * two clicks give two shots; one bubble at a time, 8 s or until clicked;
 * the notes-on dot; v0.5.3: a page-button shot with no answer in 25 s shows
 * the button again with "did not answer". And the content script's source:
 * no innerHTML, no <style> element, no style attribute, animation frames
 * only for the hide.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetAdapter } from '../../src/content/adapters/meet.js';
import { teamsAdapter } from '../../src/content/adapters/teams.js';
import { BUBBLE_MS, FLASH_MS, HIDE_GIVE_UP_MS, NOTES_TITLE, NO_ANSWER, PAGE_SHOT_LIMIT_MS, SHOT_LABEL, createCameraButton, type CameraButton } from '../../src/content/button.js';
import { SHOT_TIMEOUT_MS } from '../../src/background/client.js';
import { CAPTURE_TIMEOUT_MS, QUOTA_WAIT_MS } from '../../src/background/shots.js';
import type { ShotAnswer } from '../../src/shared/messages.js';
import { TIMING } from '../../src/shared/wire.js';
import { cameraHost, captureShadows, settle, trustedClick } from './chrome.js';

const FRAME = 16;
let button: CameraButton | null = null;
let shadows: ReturnType<typeof captureShadows>;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-30T10:00:00.000Z') });
  shadows = captureShadows();
});

afterEach(() => {
  button?.remove();
  button = null;
  vi.useRealTimers();
});

function camera(shoot: () => Promise<ShotAnswer | undefined> = async () => ({ ok: true, text: 'Saved' }), adapter = meetAdapter) {
  const shots: { at: number; hidden: string }[] = [];
  button = createCameraButton({
    doc: document,
    spot: adapter.spot,
    shoot: () => {
      shots.push({ at: Date.now(), hidden: cameraHost()?.style.getPropertyValue('visibility') ?? '' });
      return shoot();
    },
  });
  const root = () => shadows.rootOf(cameraHost())!;
  const cam = () => root().querySelector('button.cam') as HTMLButtonElement;
  const tip = () => root().querySelector('.bubble') as HTMLElement;
  return { b: button, shots, root, cam, tip };
}

describe('the host', () => {
  it('is on the page only while it shows something, appended to <html> with a closed shadow root', () => {
    const c = camera();
    expect(cameraHost()).toBeNull();
    c.b.setShown(true);
    const host = cameraHost()!;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.shadowRoot).toBeNull();
    expect(c.root().mode).toBe('closed');
    c.b.setShown(false);
    expect(cameraHost()).toBeNull();
  });

  it('is styled through one constructable stylesheet and CSSOM: no <style>, no style attribute inside, no inline markup', () => {
    const c = camera();
    c.b.setShown(true);
    const root = c.root();
    const sheets = (root as ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets;
    expect(sheets).toHaveLength(1);
    const css = Array.from(sheets[0]!.cssRules, (r) => r.cssText).join('\n');
    expect(css).toMatch(/:host\s*{[^}]*all: initial/);
    expect(css).toMatch(/:host\s*{[^}]*position: fixed/);
    expect(css).toMatch(/:host\s*{[^}]*z-index: 2147483647/);
    for (const prop of ['--bg', '--surface', '--line-strong', '--ink', '--ink-2', '--jup']) expect(css).toContain(prop);
    expect(css).toContain('prefers-color-scheme: dark');
    expect(root.querySelector('style')).toBeNull();
    expect(root.querySelector('[style]')).toBeNull();
    expect(document.querySelector('style')).toBeNull();
  });

  it.each([
    ['Meet', meetAdapter],
    ['Teams', teamsAdapter],
  ] as const)("sits where %s's adapter says", (_site, adapter) => {
    const c = camera(undefined, adapter);
    c.b.setShown(true);
    const host = cameraHost()!;
    expect(host.style.getPropertyValue('left')).toBe(adapter.spot.left);
    expect(host.style.getPropertyValue('top')).toBe(adapter.spot.top);
  });

  it('holds one round button with its label and a drawn camera (a rounded rect and a circle, no image)', () => {
    const c = camera();
    c.b.setShown(true);
    const cam = c.cam();
    expect(cam.type).toBe('button');
    expect(cam.getAttribute('aria-label')).toBe(SHOT_LABEL);
    const svg = cam.querySelector('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.querySelector('rect')?.getAttribute('rx')).toBeTruthy();
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(c.root().querySelector('img, image, [src], [href]')).toBeNull();
  });

  it('shows the notes-on dot and title while notes are on', () => {
    const c = camera();
    c.b.setShown(true);
    const dot = c.root().querySelector('.dot') as HTMLElement;
    expect(dot.hidden).toBe(true);
    expect(c.cam().hasAttribute('title')).toBe(false);
    c.b.setNotes(true);
    expect(dot.hidden).toBe(false);
    expect(c.cam().title).toBe(NOTES_TITLE);
    c.b.setNotes(false);
    expect(dot.hidden).toBe(true);
    expect(c.cam().hasAttribute('title')).toBe(false);
  });
});

describe('MP10: a shot from the page button', () => {
  it('a click a script made (isTrusted false) sends nothing', async () => {
    const c = camera();
    c.b.setShown(true);
    c.cam().click();
    c.cam().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(1_000);
    expect(c.shots).toEqual([]);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
  });

  it('a trusted click hides the host, waits two frames, asks for the shot, then shows it and flashes "Saved" for 1.2 s', async () => {
    let answer!: (a: ShotAnswer) => void;
    const c = camera(() => new Promise((r) => (answer = r)));
    c.b.setShown(true);
    const start = Date.now();
    trustedClick(c.cam());
    await settle(0);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(FRAME);
    expect(c.shots).toEqual([]);
    await settle(FRAME);
    expect(c.shots).toEqual([{ at: start + 2 * FRAME, hidden: 'hidden' }]);
    answer({ ok: true, text: 'Saved' });
    await settle(0);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
    expect(c.tip().hidden).toBe(false);
    expect(c.tip().textContent).toBe('Saved');
    await settle(FLASH_MS);
    expect(c.tip().hidden).toBe(true);
  });

  it('a refusal flashes the daemon\'s sentence as a bubble (MX8: Meetings off)', async () => {
    const off = 'Not saved: Meetings are off. Turn them on at your Mac: jantar meetings on';
    const c = camera(async () => ({ ok: false, text: off }));
    c.b.setShown(true);
    trustedClick(c.cam());
    await settle(2 * FRAME);
    expect(c.tip().textContent).toBe(off);
    await settle(FLASH_MS);
    expect(c.tip().hidden).toBe(false);
    await settle(BUBBLE_MS);
    expect(c.tip().hidden).toBe(true);
  });

  it('no answer at all still says so', async () => {
    const c = camera(async () => undefined);
    c.b.setShown(true);
    trustedClick(c.cam());
    await settle(2 * FRAME);
    expect(c.tip().textContent).toBe(NO_ANSWER);
  });

  it('v0.5.3: no answer within 25 s shows the button again with "did not answer"; a late answer changes nothing; the next click goes', async () => {
    const answers: ((a: ShotAnswer) => void)[] = [];
    const c = camera(() => new Promise((r) => answers.push(r)));
    c.b.setShown(true);
    trustedClick(c.cam());
    await settle(2 * FRAME);
    expect(c.shots).toHaveLength(1);
    await settle(PAGE_SHOT_LIMIT_MS - 1);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    expect(c.tip().hidden).toBe(true);
    await settle(1);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
    expect(c.tip().textContent).toBe(NO_ANSWER);
    // The worker's answer after the limit is dropped.
    answers[0]!({ ok: true, text: 'Saved' });
    await settle(0);
    expect(c.tip().textContent).toBe(NO_ANSWER);
    trustedClick(c.cam());
    await settle(2 * FRAME);
    expect(c.shots).toHaveLength(2);
    answers[1]!({ ok: true, text: 'Saved' });
    await settle(0);
    expect(c.tip().textContent).toBe('Saved');
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
  });

  it('v0.5.3: the limit is 25 s, above what the worker may wait for (a 5-s capture, its quota wait and gap, a 15-s upload)', () => {
    expect(PAGE_SHOT_LIMIT_MS).toBe(25_000);
    expect(PAGE_SHOT_LIMIT_MS).toBeGreaterThan(CAPTURE_TIMEOUT_MS + QUOTA_WAIT_MS + TIMING.shotGapMs + SHOT_TIMEOUT_MS);
  });

  it('a second click while one is in flight waits its turn: two clicks, two shots', async () => {
    const answers: ((a: ShotAnswer) => void)[] = [];
    const c = camera(() => new Promise((r) => answers.push(r)));
    c.b.setShown(true);
    trustedClick(c.cam());
    trustedClick(c.cam());
    await settle(10 * FRAME);
    expect(c.shots).toHaveLength(1);
    answers[0]!({ ok: true, text: 'Saved' });
    await settle(0);
    // The second hides again and waits its own two frames.
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(2 * FRAME);
    expect(c.shots).toHaveLength(2);
    expect(c.shots[1]!.hidden).toBe('hidden');
    answers[1]!({ ok: true, text: 'Saved' });
    await settle(0);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
  });
});

describe('a shot the worker takes (shortcut, popup)', () => {
  it('hide answers after two frames, never one; show brings it back with the flash', async () => {
    const c = camera();
    c.b.setShown(true);
    let hid = false;
    void c.b.hide().then(() => (hid = true));
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(FRAME);
    expect(hid).toBe(false);
    await settle(FRAME);
    expect(hid).toBe(true);
    c.b.show('Saved');
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
    expect(c.tip().textContent).toBe('Saved');
  });

  it('hide still answers when frames stop (a hidden tab)', async () => {
    const c = camera();
    c.b.setShown(true);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    let hid = false;
    void c.b.hide().then(() => (hid = true));
    await settle(1_000);
    expect(hid).toBe(true);
  });

  it('a hide whose show never comes shows the button again by itself after HIDE_GIVE_UP_MS; a late show then only flashes', async () => {
    let release: ((a: ShotAnswer) => void) | null = null;
    const c = camera(() => new Promise((r) => (release = r)));
    c.b.setShown(true);
    void c.b.hide();
    await settle(HIDE_GIVE_UP_MS - 1);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(1);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
    // A page-button shot hides it again; the late show leaves that hide alone.
    trustedClick(c.cam());
    await settle(2 * FRAME);
    expect(release).not.toBeNull();
    c.b.show('Saved');
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    expect(c.tip().textContent).toBe('Saved');
    release!({ ok: true, text: 'Saved' });
    await settle(0);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
  });

  it('two hides, one show: the other hide still shows the button again in time', async () => {
    const c = camera();
    c.b.setShown(true);
    void c.b.hide();
    await settle(1_000);
    const second = Date.now();
    void c.b.hide();
    await settle(2 * FRAME);
    // The show ends the first hide; the second gives up HIDE_GIVE_UP_MS after it began.
    c.b.show();
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(second + HIDE_GIVE_UP_MS - 1 - Date.now());
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('hidden');
    await settle(1);
    expect(cameraHost()!.style.getPropertyValue('visibility')).toBe('');
  });
});

describe('the bubble', () => {
  it('one at a time, 8 s or until clicked; it puts the host on the page outside a call too, and leaves with it', async () => {
    const c = camera();
    c.b.bubble('Not saved: join the call first.');
    expect(cameraHost()).not.toBeNull();
    expect(c.cam().hidden).toBe(true);
    expect(c.tip().getAttribute('role')).toBe('status');
    c.b.bubble('Jantar is not answering. Notes wait in this tab until it is back.');
    expect(c.root().querySelectorAll('.bubble')).toHaveLength(1);
    expect(c.tip().textContent).toBe('Jantar is not answering. Notes wait in this tab until it is back.');
    await settle(BUBBLE_MS - 1);
    expect(cameraHost()).not.toBeNull();
    await settle(1);
    expect(cameraHost()).toBeNull();
    c.b.bubble('Again');
    c.tip().click();
    expect(cameraHost()).toBeNull();
  });
});

describe("the content script's source", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../src/content');
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
  // The code only: comments may name what the code never does.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const source = files(dir).map((f) => [f.slice(dir.length + 1), code(readFileSync(f, 'utf8'))] as const);

  it('writes no HTML, no <style> element and no style attribute', () => {
    for (const [f, text] of source) {
      expect(text, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createElement\(['"]style['"]\)|setAttribute\(['"]style['"]|\.cssText\b/);
    }
  });

  it('asks for animation frames only to hide the button', () => {
    for (const [f, text] of source) if (f !== 'button.ts') expect(text, f).not.toMatch(/requestAnimationFrame/);
  });

  it('never names the extension key header or IndexedDB (MP9), and logs nothing (MP7)', () => {
    for (const [f, text] of source) {
      expect(text, f).not.toMatch(/x-jantar-extension-key|EXTENSION_KEY_HEADER|indexedDB/);
      expect(text, f).not.toMatch(/console\./);
    }
  });

  it('imports only types from @jantar/protocol', () => {
    for (const [f, text] of source) for (const line of text.split('\n').filter((l) => l.includes("'@jantar/protocol'"))) expect(line, f).toMatch(/^import type /);
  });
});
