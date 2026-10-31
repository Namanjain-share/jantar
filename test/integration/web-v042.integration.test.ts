/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * v0.4.2 in the BUILT web app, in a real headless Chromium, served by
 * jantard itself (in-process on a synthetic HOME) with its real headers and
 * the build's strict <meta> policy. The daemon runs the real Terminal.app
 * backend against the fake `osascript` (harness.ts FakeTabs), so the tab
 * shows a fixture's screen and every write the phone causes is recorded at
 * the argv. The browser pairs the way a phone does, with read and control.
 *
 * - A waiting session's dock shows the plan approval and the question as
 *   buttons in Claude's words; "Tell Claude what to change…" and "Type
 *   something…" open a text field. A tap types one compare-and-type write
 *   (the arrows, then the text) and the dialog leaves the dock ("Answered ·
 *   …" until the next screen read, which here shows Claude at work).
 * - A screen Jantar can't turn into buttons shows the keypad: ↓ then Enter
 *   is one guarded write of ESC[B.
 * - Tab walks the dock, its rows or its keys, in document order over
 *   visible, named stops that show a focus ring.
 * - The composer's +: the sheet's two rows; "From this session's folder"
 *   puts the file's `@path` in the box (nothing uploaded); an image pasted
 *   into the box becomes a chip (a blob: thumbnail), is uploaded to the
 *   session's uploads folder, and Send types the prompt with its path.
 * - Throughout, at 390 px and 1440 px: no console message about the Content
 *   Security Policy, no console error, no <style> element, nothing sticking
 *   out sideways.
 *
 * Every name and value is synthetic. Needs a built dist/ and a Chromium
 * (browser.ts).
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { SAMPLE_TEXT, dialogFixture, NOT_DIALOG_SCREENS } from '@jantar/fixtures';
import { dialogOfScreen, rawSlice } from '@jantar/daemon/terminal/dialog';
import type { PairStartResponse, SessionsResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { DESK, PHONE, browserReady, clean, expectSaneFocus, focusWalk, overflow, watchConsole, type Viewport, type Watch } from './browser.js';
import { FakeTabs, bootDaemon, fakeBinsSettings, type Daemon } from './harness.js';
import { eventually } from './http.js';

const ready = await browserReady('web-v042.integration');

const WAIT = '81818181-8181-4818-8818-818181818181';
const IDLE = '82828282-8282-4828-8828-828282828282';
const WAIT_TTY = '/dev/ttys081';
const IDLE_TTY = '/dev/ttys082';
const ESC_B = '\u001b[B';
const R80 = '─'.repeat(80);
/** Claude at work after an answer: no dialog, the prompt box below. */
const WORKING = ['● On it.', '', '✻ Working… (2s · esc to interrupt)', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');
/** An idle session: the empty prompt box, ready for a prompt. */
const READY = ['● Done.', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');

/** The raw text the compare-and-type write must find: the dialog from its top through its last line. */
function blockOf(screen: string): string {
  const read = dialogOfScreen(screen);
  if (!read.block) throw new Error('no dialog block on this screen');
  return rawSlice(screen, read.block.from, read.block.to);
}

/** A real 2x2 PNG (8-bit RGB), small enough to go to the Mac as it is. */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.from([0, 0x2a, 0x6f, 0x9e, 0x2a, 0x6f, 0x9e, 0, 0x2a, 0x6f, 0x9e, 0x2a, 0x6f, 0x9e]);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

describe.skipIf(!ready)('v0.4.2 in Chromium: the dock answers dialogs, the keypad, the composer attaches files', () => {
  let d: Daemon;
  let tabs: FakeTabs;
  let ctl: CtlClient;
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  const base = () => `http://127.0.0.1:${d.port}`;

  /** A browser context paired through the pairing page, as a phone scanning the Mac's code would be. */
  async function paired(vp: Viewport, name: string): Promise<{ page: Page; watch: Watch }> {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.phone === true,
      hasTouch: vp.phone === true,
      colorScheme: vp.scheme ?? 'light',
      locale: 'en-GB',
      serviceWorkers: 'block',
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    const watch = watchConsole(page);
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name, scopes: ['read', 'control'] });
    await page.goto(`${base()}/pair#c=${start.code}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Paired' }).waitFor();
    // Before the claim the app's first calls answer 401: expected, and over now.
    watch.errors.length = 0;
    return { page, watch };
  }

  /** Clean console, no <style>, nothing past the sides of the viewport. */
  async function check(page: Page, watch: Watch, what: string): Promise<void> {
    await page.waitForTimeout(300);
    await clean(page, watch);
    expect(await overflow(page), what).toEqual([]);
  }

  /** The dock's row for `label` (Claude's words, its description after them). */
  const row = (page: Page, label: string | RegExp) => page.getByRole('group', { name: 'Choices' }).getByRole('button', { name: label });

  /** The tab shows `screen`; the session's page is opened and its dock shows the dialog. */
  async function openWaiting(page: Page, screen: string, first: string | RegExp): Promise<void> {
    tabs.on(WAIT_TTY, {});
    await tabs.show(WAIT_TTY, screen);
    await page.goto(`${base()}/s/${WAIT}`, { waitUntil: 'load' });
    await row(page, first).waitFor();
    // A tap within 500 ms of the rows showing is dropped (TAP_GUARD_MS): the user looks first.
    await page.waitForTimeout(700);
  }

  beforeAll(async () => {
    if (!ready) return;
    d = await bootDaemon({
      home: {
        sessions: [
          { sid: WAIT, pid: 81001, account: 1, project: 'demo-app', status: 'waiting', waitingFor: 'approve Write', tty: 'ttys081', transcript: [] },
          // Not 82001: each session's shell is its pid less 1000 (fixtures home.ts), which would be WAIT's claude.
          { sid: IDLE, pid: 83001, account: 1, project: 'demo-notes', status: 'idle', tty: 'ttys082', transcript: [] },
        ],
      },
      settings: (home) => ({ bins: fakeBinsSettings(home), files: { enabled: true } }),
      terminalApp: { wrapExec: (exec, home) => (tabs = new FakeTabs(home)).wrap(exec) },
    });
    await tabs.show(WAIT_TTY, WORKING);
    await tabs.show(IDLE_TTY, READY);
    await writeFile(join(d.home.session(IDLE).cwd, 'notes.md'), '# Demo notes\n\nThe header should be teal.\n');
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => {
      const sids = (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.map((s) => s.sid);
      return sids.includes(WAIT) && sids.includes(IDLE);
    }, 15_000, 'the live sessions');
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    await d?.stop();
  }, 30_000);

  it('the plan approval as buttons (phone and desk): Claude\'s three rows, the note field, and a tap that types one guarded Down', async () => {
    const screen = dialogFixture('PLAN_80COL').screen;
    for (const vp of [PHONE, { ...DESK, scheme: 'dark' as const }]) {
      const { page, watch } = await paired(vp, `plan ${vp.width}`);
      await openWaiting(page, screen, /^Yes, manually approve edits/);
      expect(await row(page, /^Yes, and use auto mode/).count()).toBe(1);
      await row(page, /^Tell Claude what to change/).click();
      await page.getByLabel('What should change').waitFor();
      await check(page, watch, `plan dock ${vp.width}`);

      tabs.on(WAIT_TTY, { after: () => tabs.show(WAIT_TTY, WORKING) });
      const before = tabs.writesTo(WAIT_TTY).length;
      await row(page, /^Yes, manually approve edits/).click();
      await page.getByRole('group', { name: 'Choices' }).waitFor({ state: 'detached' });
      expect(tabs.writesTo(WAIT_TTY).slice(before)).toEqual([{ tty: WAIT_TTY, mode: 'typeif', bytes: ESC_B, expected: blockOf(screen), out: 'ok' }]);
      await check(page, watch, `plan answered ${vp.width}`);
    }
  }, 90_000);

  it('a question as buttons: its options, and "Type something…" sends the arrows and the typed answer in one write', async () => {
    const screen = dialogFixture('Q_SINGLE').screen;
    const { page, watch } = await paired(PHONE, 'question');
    await openWaiting(page, screen, /^Red/);
    for (const label of [/^Green/, /^Blue/, /^Chat about this/]) expect(await row(page, label).count()).toBe(1);
    await row(page, /^Type something/).click();
    await page.getByLabel('Your answer').fill(SAMPLE_TEXT);
    await check(page, watch, 'question with its text field');

    tabs.on(WAIT_TTY, { after: () => tabs.show(WAIT_TTY, WORKING) });
    const before = tabs.writesTo(WAIT_TTY).length;
    await page.getByRole('button', { name: 'Send answer' }).click();
    await page.getByRole('group', { name: 'Choices' }).waitFor({ state: 'detached' });
    expect(tabs.writesTo(WAIT_TTY).slice(before)).toEqual([{ tty: WAIT_TTY, mode: 'typeif', bytes: ESC_B.repeat(3) + SAMPLE_TEXT, expected: blockOf(screen), out: 'ok' }]);
    await check(page, watch, 'question answered');
  }, 60_000);

  it('a screen with no buttons shows the keypad: ↓ then Enter is one guarded write', async () => {
    const form = NOT_DIALOG_SCREENS.MCP_FORM as string;
    const { page, watch } = await paired(PHONE, 'keypad');
    tabs.on(WAIT_TTY, {});
    await tabs.show(WAIT_TTY, form);
    await page.goto(`${base()}/s/${WAIT}`, { waitUntil: 'load' });
    const keys = page.getByRole('region', { name: 'Keys' });
    await keys.waitFor();
    await page.waitForTimeout(700);
    await keys.getByRole('button', { name: 'Down' }).click();
    await keys.getByText('moves: ↓ 1').waitFor();
    await check(page, watch, 'keypad with a move');
    const before = tabs.writesTo(WAIT_TTY).length;
    await keys.getByRole('button', { name: /Enter/ }).click();
    await eventually(async () => tabs.writesTo(WAIT_TTY).length > before, 10_000, 'the keypad write');
    const w = tabs.writesTo(WAIT_TTY).slice(before);
    expect(w.map((x) => [x.mode, x.bytes, x.out])).toEqual([['typeif', ESC_B, 'ok']]);
    expect(form).toContain(w[0]?.expected ?? '\u0000');
    await check(page, watch, 'keypad sent');
  }, 60_000);

  it('focus: Tab walks the dock in document order over visible, named stops with a ring (rows, then the keypad)', async () => {
    const { page, watch } = await paired(PHONE, 'focus');
    await openWaiting(page, dialogFixture('PERM_CREATE_2').screen, /^Yes$/);
    const rows = await focusWalk(page);
    await expectSaneFocus(page, rows, { what: 'the dock with rows' });
    const names = rows.map((s) => s.what);
    // Every row, then Show on Mac, each reached by Tab.
    for (const want of ['button Yes', 'button No', 'button Show on Mac']) expect(names.some((n) => n.startsWith(want)), `${want}\n${names.join('\n')}`).toBe(true);
    // The dock's own Show on Mac comes after its rows (the header has one too).
    expect(names.findLastIndex((n) => n.startsWith('button Show on Mac')), names.join('\n')).toBeGreaterThan(names.findIndex((n) => n.startsWith('button No')));
    await check(page, watch, 'dock focus walk');

    tabs.on(WAIT_TTY, {});
    await tabs.show(WAIT_TTY, NOT_DIALOG_SCREENS.MCP_FORM as string);
    await page.goto(`${base()}/s/${WAIT}`, { waitUntil: 'load' });
    const keys = page.getByRole('region', { name: 'Keys' });
    await keys.waitFor();
    const stops = await focusWalk(page);
    await expectSaneFocus(page, stops, { what: 'the dock with the keypad' });
    for (const want of ['button Down', 'button Show on Mac']) expect(stops.some((s) => s.what.startsWith(want)), `${want}\n${stops.map((s) => s.what).join('\n')}`).toBe(true);
    await check(page, watch, 'keypad focus walk');
  }, 60_000);

  it('the composer: + opens its sheet, a file from the folder goes in by name, a pasted image becomes a chip and goes with Send', async () => {
    const { page, watch } = await paired(PHONE, 'composer');
    await page.goto(`${base()}/s/${IDLE}`, { waitUntil: 'load' });
    const box = page.getByLabel('Prompt for Claude');
    await box.waitFor();

    // Until the session's folder is listed, + is the file input's own label (which Chromium also names
    // "Add files"); then it is the button that opens the sheet.
    const plus = page.locator('button[aria-label="Add files"]');
    await plus.waitFor();
    await plus.click();
    const sheet = page.getByRole('dialog', { name: 'Add to the prompt' });
    await sheet.waitFor();
    expect(await sheet.getByLabel('Photos, camera or files').count()).toBe(1);
    await check(page, watch, 'the + sheet');
    await sheet.getByRole('button', { name: "From this session's folder" }).click();
    const folder = page.getByRole('dialog', { name: "From this session's folder" });
    await folder.getByText('notes.md').click();
    await folder.waitFor({ state: 'detached' });
    await eventually(async () => (await box.inputValue()) === '@notes.md ', 10_000, 'the file mention in the box');
    expect(await readdir(d.ctx.paths.uploadsDir).catch(() => [])).toEqual([]);

    // A screenshot pasted into the box: a file on the clipboard, no text.
    await box.fill('What is in this picture?');
    const png = [...tinyPng()];
    await box.evaluate((el, bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'screenshot.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, png);
    const chips = page.getByRole('list', { name: 'Attached files' });
    await chips.getByLabel('on the Mac').waitFor();
    expect(await chips.locator('img').first().getAttribute('src')).toMatch(/^blob:/);
    const stored = await readdir(join(d.ctx.paths.uploadsDir, IDLE));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^[0-9a-hjkmnp-tv-z]{26}\.png$/);
    await check(page, watch, 'a chip in the composer');

    const before = tabs.writesTo(IDLE_TTY).length;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const typed = await eventually(async () => tabs.writesTo(IDLE_TTY).slice(before).find((w) => w.mode === 'type' && w.bytes.includes('Attached files:')) ?? null, 15_000, 'the prompt typed');
    // The writer pastes a prompt of several lines as one bracketed paste.
    expect(typed.bytes).toBe(
      `\u001b[200~${['What is in this picture?', '', 'Attached files:', `- "screenshot.png": ${join(d.ctx.paths.uploadsDir, IDLE, stored[0] as string)}`].join('\n')}\u001b[201~`,
    );
    await check(page, watch, 'sent with the chip');
  }, 90_000);
});
