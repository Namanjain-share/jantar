/**
 * v0.4.2: every shared dialog fixture (test/fixtures/src/dialogs.ts) through
 * jantard in-process, with the real Terminal.app backend on the fake
 * `osascript`, read and answered over HTTP the way the phone does.
 *
 * - A fixture with buttons reads to its model with the shipped gates (Up
 *   and tall on since SP14 and SP15, No-first off: `withGates`). Each row
 *   the phone can answer is one compare-and-type write, at the osascript
 *   argv: exactly the fixture's bytes (Downs below the pointer, Ups above
 *   it, then the sample text for a text row) against the dialog's raw
 *   block; Claude's next screen comes and the answer is `done`. A row that
 *   saves or switches something wants `confirm: true` first (409, nothing
 *   typed). A locked row is refused with its own note, nothing typed.
 * - The guard: the tab changes between the daemon's read and its write
 *   (the fake answers `__JANTAR_CHANGED__`, 409, nothing typed); a phone
 *   holding the fingerprint of the dialog before gets 409 with no write.
 * - A fixture without buttons (its note says why) gets no answer from the
 *   dialog route, and the keypad moves and chooses there in one guarded
 *   write over the lines the phone was shown.
 * - With Controls off at the Mac, the dialog and keypad routes answer 403
 *   and type nothing; the screen read still shows the dialog (the phone
 *   greys its rows with the reason).
 * - Afterwards DIALOG_SECRET, planted in every fixture screen, is in no
 *   event, card, audit row, log line or reply to a tap: only the screen
 *   reads and the writes' block carry it.
 *
 * The taps go round PHONES paired devices: the dialog limiter allows 60 a
 * minute per device, and this file sends about three times that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, DIALOG_SECRET, NOT_DIALOG_SCREENS, SAMPLE_TEXT, withGates, type DialogFixture } from '@jantar/fixtures';
import { rawExpect, readDialog } from '@jantar/daemon/terminal/dialog';
import {
  DEVICE_COOKIE,
  DIALOG_GATES,
  ROUTES,
  type PairStartResponse,
  type ScreenResponse,
  type SessionDialogResponse,
  type SessionsResponse,
  type TerminalDialog,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { FakeTabs, bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';

const SID = '62626262-6262-4626-8626-626262626262';
const TTY = '/dev/ttys062';
const ESC_B = '\u001b[B';
const R80 = '─'.repeat(80);
/** Claude at work after an answer: no dialog, the prompt box below. */
const WORKING = ['● On it.', '', '✻ Working… (2s · esc to interrupt)', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');

const withoutPrint = (d: TerminalDialog | null | undefined) => {
  if (!d) return null;
  const { fingerprint: _f, ...rest } = d;
  return rest;
};

/** The raw text the compare-and-type write must find: the dialog from its top through its last line (around its countdown's time, its two parts). */
function blockOf(screen: string): string | string[] {
  const read = readDialog(screen);
  if (!read.dialog || !read.block) throw new Error('no dialog block on this screen');
  return rawExpect(screen, read.block.from, read.block.to, read.countdown);
}

/** Phones paired with read and control (the pairing limit is 8 claims a minute). */
const PHONES = 6;

/** What `f` reads to and types with the gates the daemon ships. */
const shipped = (f: DialogFixture) => withGates(f, DIALOG_GATES);
const withButtons = DIALOG_FIXTURES.filter((f) => shipped(f).expected.dialog !== null);
const withNote = DIALOG_FIXTURES.filter((f) => shipped(f).expected.dialog === null);

describe('v0.4.2: every dialog fixture answered through the daemon, with the guard', () => {
  let d: Daemon;
  let tabs: FakeTabs;
  let ctl: CtlClient;
  const phones: string[] = [];
  let turn = 0;

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function read(lines = 40): Promise<ScreenResponse> {
    const r = await http(d.port, 'GET', `/v1/sessions/${SID}/screen?lines=${lines}`, { cookie: phones[0] as string });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as ScreenResponse;
  }

  async function post(path: string, body: unknown): Promise<HttpResult> {
    const r = await http(d.port, 'POST', `/v1/sessions/${SID}/${path}`, {
      cookie: phones[turn++ % phones.length] as string,
      body,
      headers: { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` },
    });
    // A `done` or `unchanged` reply carries the next dialog by design; the rest are fixed sentences.
    replies.push((r.body as { dialog?: unknown } | null)?.dialog === undefined ? r.body : { ...(r.body as object), dialog: null });
    return r;
  }

  const tap = (dialog: TerminalDialog, option: number, more: { text?: string; confirm?: boolean } = {}): Promise<HttpResult> =>
    post('dialog', { fingerprint: dialog.fingerprint, option, ...more });

  /** Put `screen` on the tab and read it as the phone does. */
  async function shown(screen: string): Promise<ScreenResponse> {
    tabs.on(TTY, {});
    await tabs.show(TTY, screen);
    return read();
  }

  const writes = () => tabs.writesTo(TTY);
  const error = (r: HttpResult) => (r.body as { error: { code: string; message: string } }).error;
  /** Every reply to a tap or a key, for the privacy sweep. */
  const replies: unknown[] = [];

  beforeAll(async () => {
    d = await bootDaemon({
      home: { sessions: [{ sid: SID, pid: 62001, account: 1, project: 'demo-app', status: 'waiting', waitingFor: 'approve Write', tty: 'ttys062', transcript: [] }] },
      terminalApp: { wrapExec: (exec, home) => (tabs = new FakeTabs(home)).wrap(exec) },
    });
    await tabs.show(TTY, WORKING);
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.some((s) => s.sid === SID), 15_000, 'the live session');
    for (let i = 0; i < PHONES; i++) {
      const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: `every dialog ${i}`, scopes: ['read', 'control'] });
      const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: `every dialog phone ${i}` } });
      expect(claim.status, claim.text).toBe(200);
      const phone = cookieFrom(claim, DEVICE_COOKIE) as string;
      rememberSecret(phone, claim.body);
      phones.push(phone);
    }
  }, 60_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('has fixtures of every kind, with and without buttons', () => {
    expect(new Set(withButtons.map((f) => shipped(f).expected.dialog?.kind))).toEqual(new Set(['permission', 'plan', 'question', 'multi', 'review']));
    expect(withNote.length).toBeGreaterThan(0);
    // Up runs are among the bytes since SP14.
    expect(withButtons.some((f) => shipped(f).bytes.some((b) => b?.startsWith('\u001b[A')))).toBe(true);
  });

  for (const f of withButtons) {
    it(`${f.name}: each row it can answer is its own bytes against its block, then done; the rest are refused`, async () => {
      const model = shipped(f).expected.dialog as NonNullable<DialogFixture['expected']['dialog']>;
      for (const [i, o] of model.options.entries()) {
        const s = await shown(f.screen);
        expect(withoutPrint(s.dialog), f.name).toEqual(model);
        const dialog = s.dialog as TerminalDialog;
        const bytes = shipped(f).bytes[i];
        const text = o.role === 'text' ? SAMPLE_TEXT : undefined;
        const before = writes().length;
        if (bytes === null || bytes === undefined) {
          const r = await tap(dialog, i, text === undefined ? {} : { text });
          expect(r.status, `${f.name} ${i}: ${r.text}`).toBe(400);
          expect(error(r).message).toBe(o.note);
          expect(writes().length).toBe(before);
          continue;
        }
        if (o.hold) {
          const unheld = await tap(dialog, i, text === undefined ? {} : { text });
          expect(unheld.status, `${f.name} ${i}`).toBe(409);
          expect(error(unheld).code).toBe('needs_confirm');
          expect(writes().length).toBe(before);
        }
        tabs.on(TTY, { after: () => tabs.show(TTY, WORKING) });
        const r = await tap(dialog, i, { ...(text === undefined ? {} : { text }), ...(o.hold ? { confirm: true } : {}) });
        expect(r.status, `${f.name} ${i}: ${r.text}\n${dumpLog()}`).toBe(200);
        expect(r.body as SessionDialogResponse, `${f.name} ${i}`).toEqual({ outcome: 'done', dialog: null });
        expect(writes().slice(before), `${f.name} ${i}`).toEqual([{ tty: TTY, mode: 'typeif', bytes, expected: blockOf(f.screen), out: 'ok' }]);
      }
    }, 60_000);
  }

  it('the guard, on every fixture with buttons: changed between the read and the write, or a stale fingerprint, types nothing', async () => {
    for (const f of withButtons) {
      const model = shipped(f).expected.dialog as NonNullable<DialogFixture['expected']['dialog']>;
      const row = shipped(f).bytes.findIndex((b) => b !== null);
      const dialog = (await shown(f.screen)).dialog as TerminalDialog;
      if (row < 0) {
        // Every row locked (the pointer on text waiting in its row): a dialog that moved on is still refused first.
        await tabs.show(TTY, WORKING);
        const before = writes().length;
        expect((await tap(dialog, 0)).status, f.name).toBe(409);
        expect(writes().length).toBe(before);
        continue;
      }
      const o = model.options[row] as (typeof model.options)[number];
      const more = { ...(o.role === 'text' ? { text: SAMPLE_TEXT } : {}), ...(o.hold ? { confirm: true } : {}) };
      // The Mac moves on between the daemon's guarded read and its write.
      tabs.on(TTY, { before: () => tabs.show(TTY, WORKING) });
      const before = writes().length;
      const changed = await tap(dialog, row, more);
      expect(changed.status, `${f.name}: ${changed.text}`).toBe(409);
      expect(error(changed).code).toBe('conflict');
      expect(writes().slice(before), f.name).toEqual([{ tty: TTY, mode: 'typeif', bytes: shipped(f).bytes[row], expected: blockOf(f.screen), out: '__JANTAR_CHANGED__' }]);
      // The phone still holds that dialog: refused at the guarded read, no write at all.
      tabs.on(TTY, {});
      const stale = await tap(dialog, row, more);
      expect(stale.status, f.name).toBe(409);
      expect(writes().length).toBe(before + 1);
    }
  }, 120_000);

  for (const f of withNote) {
    it(`${f.name}: no buttons, its note; the dialog route answers nothing and the keypad moves and chooses`, async () => {
      const s = await shown(f.screen);
      expect(s.dialog, f.name).toBeUndefined();
      expect(s.dialogNote, f.name).toBe(shipped(f).expected.note);
      const before = writes().length;
      expect((await post('dialog', { fingerprint: 'a'.repeat(64), option: 0 })).status, f.name).toBe(409);
      expect(writes().length).toBe(before);
      const r = await post('keypad', { screen: s.screenKey, lines: 40, move: 1, key: 'enter' });
      expect(r.status, `${f.name}: ${r.text}`).toBe(200);
      const w = writes().slice(before);
      expect(w.map((x) => [x.mode, x.bytes, x.out])).toEqual([['typeif', ESC_B, 'ok']]);
      // Compare-and-type over the lines the phone was shown.
      expect(typeof w[0]?.expected).toBe('string');
      expect(f.screen).toContain((w[0]?.expected as string | undefined) ?? '\u0000');
      expect(w[0]?.expected).toMatch(/[❯›]/u);
    });
  }

  it('the keypad on the pickers Claude draws without a dialog: one guarded write each', async () => {
    for (const name of ['MODEL_PICKER', 'MCP_FORM'] as const) {
      const s = await shown(NOT_DIALOG_SCREENS[name] as string);
      expect(s.dialog, name).toBeUndefined();
      const before = writes().length;
      const r = await post('keypad', { screen: s.screenKey, lines: 40, move: 2, key: 'enter' });
      expect(r.status, `${name}: ${r.text}`).toBe(200);
      expect(writes().slice(before).map((x) => [x.mode, x.bytes, x.out])).toEqual([['typeif', ESC_B.repeat(2), 'ok']]);
    }
  });

  it('Controls off at the Mac: the dialog and the keypad answer 403 and type nothing; the screen read still shows the dialog', async () => {
    const patch = (enabled: boolean) => callDaemon(ctl, 'PATCH', ROUTES.patchSettings.path, { controls: { enabled } }, { idempotencyKey: `c-${enabled}-${Date.now()}` });
    const f = withButtons[0] as DialogFixture;
    await patch(false);
    try {
      const s = await shown(f.screen);
      expect(withoutPrint(s.dialog)).toEqual(shipped(f).expected.dialog);
      const before = writes().length;
      const r = await tap(s.dialog as TerminalDialog, shipped(f).bytes.findIndex((b) => b !== null));
      expect(r.status, r.text).toBe(403);
      expect(error(r).message).toContain('controls on');
      const k = await post('keypad', { screen: s.screenKey, lines: 40, move: 0, key: 'enter' });
      expect(k.status, k.text).toBe(403);
      expect(writes().length).toBe(before);
    } finally {
      await patch(true);
    }
    const again = await shown(f.screen);
    tabs.on(TTY, { after: () => tabs.show(TTY, WORKING) });
    const row = shipped(f).bytes.findIndex((b) => b !== null);
    const o = (shipped(f).expected.dialog as NonNullable<DialogFixture['expected']['dialog']>).options[row];
    expect((await tap(again.dialog as TerminalDialog, row, o?.hold ? { confirm: true } : {})).status).toBe(200);
  });

  it('the sweep: the planted marker is in no event, card, audit row, log line or reply', () => {
    const replay = d.ctx.store.replay(0);
    const sources: Record<string, unknown> = {
      'event ring': replay.kind === 'events' ? replay.events : [],
      'stored events': d.ctx.db.events.since(0),
      'card history': d.ctx.db.pending.list({ limit: 1000 }),
      'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      'log lines': d.log.records,
      replies,
    };
    for (const [what, value] of Object.entries(sources)) expect(JSON.stringify(value).includes(DIALOG_SECRET), what).toBe(false);
    // The writes did carry it, in the block they checked: the sweep looked where it could be.
    expect(writes().some((w) => (w.expected ?? '').includes(DIALOG_SECRET))).toBe(true);
    expect(replies.length).toBeGreaterThan(100);
  });
});
