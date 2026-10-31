/** Control keys from the phone: the gates (C2), Ctrl+C spacing (C3), Escape and the pane lock. */
import { describe, expect, it } from 'vitest';
import { SettingsSchema, type PendingRequest } from '@jantar/protocol';
import { BUSY_REASON, LOCK_WAIT_MS } from '../../src/controls/common.js';
import {
  BOX_CUT_OFF,
  CLEAR_UNVERIFIED,
  CTRL_C_SPACING_MS,
  DRAFT_MAY_BE_HIDDEN,
  DRAFT_TOO_TALL,
  ESCAPE_UNVERIFIED,
  INPUT_NOT_EMPTY,
  MENU_REFUSED,
  NO_INPUT_BOX,
  NO_TAB_ROWS,
  QUIT_REFUSED,
  VIM_NOT_INSERT,
  keySent,
} from '../../src/controls/keys.js';
import { readOnlyTerminal } from '../../src/modes.js';
import { buildControlsService } from '../../src/controls/service.js';
import { RULE, SID, T0, TTY, claudeScreen, dialogScreen, drive, flush, makeRig } from './helpers.js';

function card(over: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: '01JTESTCARD0000000000000001abc',
    sid: SID,
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'npm test' },
    suggestions: [],
    correlationKey: `${SID}|Bash|{}`,
    createdAt: T0,
    settleUntil: T0,
    state: 'open',
    ...over,
  };
}

/** Clear draft and Escape are on by default (verified by the 30 Oct 2026 spike); a config can turn them off. */
const CLEAR_VERIFIED = SettingsSchema.parse({});
const UNVERIFIED = SettingsSchema.parse({ controls: { escapeVerified: false, clearVerified: false } });

/** A draft on `rows` rows of Claude's input box (vim: the vim mode shown under it). */
const tallDraft = (rows: number, vim?: string) =>
  claudeScreen({ draft: 'row 1 of the draft', more: Array.from({ length: rows - 1 }, (_, i) => `row ${i + 2} of the draft`), ...(vim ? { vim } : {}) });

describe('control keys', () => {
  it('presses the key once every gate passes', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toEqual({ ok: true });
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    expect(rig.terminal.pressed).toEqual(['interrupt', 'clearInput']);
    // Clear draft carries the rows of the box it just read; other keys carry nothing.
    expect(rig.terminal.keyOpts).toEqual([undefined, { rows: 1 }]);
  });

  it('Escape and Clear draft are on by default (spikes S2 and S1, 30 Oct 2026)', () => {
    expect(SettingsSchema.parse({}).controls).toMatchObject({ escapeVerified: true, clearVerified: true });
  });

  it('C2: a dialog on screen refuses shiftTab, clearInput and interrupt, and nothing is typed', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    rig.terminal.screen = dialogScreen();
    for (const key of ['shiftTab', 'clearInput', 'interrupt'] as const) {
      const r = await drive(rig.clock, rig.controls.key(SID, key, { kind: 'cli' }));
      expect(r, key).toMatchObject({ ok: false, code: 'dialog_open' });
      // The reason never quotes the screen.
      expect(JSON.stringify(r)).not.toContain('echo');
    }
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('Clear draft is refused while a config turns controls.clearVerified off, and nothing is typed', async () => {
    const rig = makeRig({ settings: UNVERIFIED });
    rig.terminal.screen = claudeScreen({ draft: 'half a prompt' });
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: CLEAR_UNVERIFIED });
    expect(rig.terminal.pressed).toEqual([]);
    expect(rig.terminal.findCalls).toBe(0);
    await rig.ctx.settings.patch({ controls: { clearVerified: true } });
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    expect(rig.terminal.pressed).toEqual(['clearInput']);
  });

  it('C2: shiftTab needs an empty input box (its Return would send the draft); Clear draft does not', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    rig.terminal.screen = claudeScreen({ draft: 'half a prompt' });
    expect(await drive(rig.clock, rig.controls.key(SID, 'shiftTab', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'input_not_empty' });
    expect(rig.terminal.pressed).toEqual([]);
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    rig.terminal.screen = ['⏺ Working…', '', ''].join('\n');
    expect(await drive(rig.clock, rig.controls.key(SID, 'shiftTab', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/input box/) });
    expect(rig.terminal.pressed).toEqual(['clearInput']);
  });

  it('C2: Clear draft clears a draft on several rows: the press carries the rows the box shows (1, 2, 5, 30)', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    // A tab 80 rows tall: Claude's full-screen display would show up to 35 rows of the box.
    rig.terminal.tabRows = 80;
    rig.terminal.screen = ['⏺ Done.', '', RULE, '❯ the first line of a draft', '  and its second line', RULE, '  ⏸ manual mode on (shift+tab to cycle)', ''].join('\n');
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    for (const rows of [1, 5, 30]) {
      rig.terminal.screen = tallDraft(rows);
      expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' })), `${rows} rows`).toEqual({ ok: true });
    }
    expect(rig.terminal.pressed).toEqual(['clearInput', 'clearInput', 'clearInput', 'clearInput']);
    expect(rig.terminal.keyOpts).toEqual([{ rows: 2 }, { rows: 1 }, { rows: 5 }, { rows: 30 }]);
  });

  it('C2: Clear draft is refused for a draft taller than 30 rows, and with no input box (never typed blind)', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    rig.terminal.screen = tallDraft(31);
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: DRAFT_TOO_TALL });
    expect(DRAFT_TOO_TALL).toBe('the draft is taller than 30 rows; clear it at the Mac');
    rig.terminal.screen = ['⏺ Working…', '', ''].join('\n');
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: NO_INPUT_BOX });
    // A screen that can't be read refuses too.
    rig.terminal.readScreen = async () => ({ ok: false, code: 'failed', reason: 'osascript failed' });
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'unreadable' });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it("C2: Clear draft is refused when Claude's full-screen display may hide rows: 6 rows go in an 80x24 tab, 7 do not", async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    // In 24 rows the full-screen display shows at most 7 rows of the box, the ones around the cursor; a box
    // that shows 7 may hold 10, and End and 16 Ctrl+U would leave the first rows for the Return to send.
    rig.terminal.screen = tallDraft(6);
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    rig.terminal.screen = tallDraft(7);
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: DRAFT_MAY_BE_HIDDEN });
    // The same 7 rows in a taller tab go.
    rig.terminal.tabRows = 40;
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    // A tab whose height can't be read refuses, even a one-row draft.
    rig.terminal.tabRows = null;
    rig.terminal.screen = claudeScreen({ draft: 'half a prompt' });
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: NO_TAB_ROWS });
    expect(rig.terminal.pressed).toEqual(['clearInput', 'clearInput']);
    expect(rig.terminal.keyOpts).toEqual([{ rows: 6 }, { rows: 7 }]);
  });

  it("C2: Clear draft is refused while Claude's vim mode is out of INSERT (NORMAL drops End, and its Return submits)", async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    for (const vim of ['NORMAL', 'VISUAL', 'VISUAL LINE']) {
      for (const rows of [1, 3]) {
        rig.terminal.screen = tallDraft(rows, vim);
        expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' })), `${vim}, ${rows} rows`).toEqual({
          ok: false,
          code: 'refused',
          reason: VIM_NOT_INSERT,
        });
      }
    }
    expect(rig.terminal.pressed).toEqual([]);
    rig.terminal.screen = tallDraft(3, 'INSERT');
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: true });
    expect(rig.terminal.keyOpts).toEqual([{ rows: 3 }]);
  });

  it("C2: Clear draft is refused when the box's bottom edge is off screen (blank rows there would not be counted)", async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    rig.terminal.screen = ['⏺ Done.', '', RULE, '❯ the first line of a draft', '  ', '  ', ''].join('\n');
    expect(await drive(rig.clock, rig.controls.key(SID, 'clearInput', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: BOX_CUT_OFF });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('C2: Interrupt is refused while the input box holds a draft (mid-run, Ctrl+C may keep it and the Return would send it)', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    rig.terminal.screen = claudeScreen({ mode: null, draft: 'typed while Claude works' });
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toEqual({ ok: false, code: 'input_not_empty', reason: INPUT_NOT_EMPTY });
    // Interrupt sent as Escape meets the same gate.
    await rig.ctx.settings.patch({ controls: { interruptKey: 'escape', escapeVerified: true } });
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'input_not_empty' });
    expect(rig.terminal.pressed).toEqual([]);
    rig.terminal.screen = claudeScreen({ mode: null });
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toEqual({ ok: true });
    expect(rig.terminal.pressed).toEqual(['escape']);
  });

  it('keySent: Interrupt types settings.controls.interruptKey, every other key itself', async () => {
    const rig = makeRig();
    expect(keySent(rig.ctx, 'interrupt')).toBe('interrupt');
    expect(keySent(rig.ctx, 'clearInput')).toBe('clearInput');
    await rig.ctx.settings.patch({ controls: { interruptKey: 'escape' } });
    expect(keySent(rig.ctx, 'interrupt')).toBe('escape');
  });

  it('C2: Claude not in front of its pane is refused, nothing typed', async () => {
    const rig = makeRig();
    for (const fg of ['shell', 'other', 'gone'] as const) {
      rig.terminal.foreground = fg;
      expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' })), fg).toMatchObject({ ok: false, code: 'refused' });
    }
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('C2: an open card refuses every key (answer the card)', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    rig.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card() } });
    for (const key of ['interrupt', 'shiftTab', 'clearInput'] as const) {
      expect(await drive(rig.clock, rig.controls.key(SID, key, { kind: 'cli' })), key).toMatchObject({
        ok: false,
        code: 'refused',
        reason: expect.stringMatching(/card is open/),
      });
    }
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('C2: a ccw move in progress refuses', async () => {
    const rig = makeRig();
    rig.ccw.moving = SID;
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/move/) });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('a session waiting in the terminal refuses keys as a dialog', async () => {
    const rig = makeRig({ session: { status: 'waiting' } });
    expect(await drive(rig.clock, rig.controls.key(SID, 'shiftTab', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'dialog_open' });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('never presses up, down or enter (their Return picks an option nothing checked), even on a waiting dialog with no card', async () => {
    const rig = makeRig({ session: { status: 'waiting' } });
    rig.terminal.screen = dialogScreen();
    for (const key of ['up', 'down', 'enter'] as const) {
      expect(await drive(rig.clock, rig.controls.key(SID, key, { kind: 'cli' })), key).toEqual({ ok: false, code: 'refused', reason: MENU_REFUSED });
    }
    expect(rig.terminal.pressed).toEqual([]);
    expect(rig.terminal.findCalls).toBe(0);
  });

  it('never presses quit (it ends the session, and the phone has no confirm for it)', async () => {
    const rig = makeRig();
    expect(await drive(rig.clock, rig.controls.key(SID, 'quit', { kind: 'cli' }))).toEqual({ ok: false, code: 'refused', reason: QUIT_REFUSED });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('C3: a second Ctrl+C to the pane within 3 s is refused; after 3 s it goes', async () => {
    const rig = makeRig({ settings: CLEAR_VERIFIED });
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toEqual({ ok: true });
    rig.clock.advance(1000);
    expect(await rig.controls.key(SID, 'interrupt', { kind: 'cli' })).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(rig.terminal.pressed).toEqual(['interrupt']);
    rig.clock.advance(CTRL_C_SPACING_MS);
    expect(await rig.controls.key(SID, 'interrupt', { kind: 'cli' })).toEqual({ ok: true });
    expect(rig.terminal.pressed).toEqual(['interrupt', 'interrupt']);
    // Other keys are not spaced.
    expect(await rig.controls.key(SID, 'clearInput', { kind: 'cli' })).toEqual({ ok: true });
  });

  it('escape is refused (409 escape_unverified) while a config turns controls.escapeVerified off', async () => {
    const rig = makeRig({ settings: UNVERIFIED });
    expect(await drive(rig.clock, rig.controls.key(SID, 'escape', { kind: 'cli' }))).toEqual({ ok: false, code: 'escape_unverified', reason: ESCAPE_UNVERIFIED });
    await rig.ctx.settings.patch({ controls: { interruptKey: 'escape' } });
    // Interrupt follows interruptKey, and so meets the same refusal.
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toMatchObject({ ok: false, code: 'escape_unverified' });
    expect(rig.terminal.pressed).toEqual([]);
    await rig.ctx.settings.patch({ controls: { escapeVerified: true } });
    expect(await drive(rig.clock, rig.controls.key(SID, 'interrupt', { kind: 'cli' }))).toEqual({ ok: true });
    expect(rig.terminal.pressed).toEqual(['escape']);
  });

  it('refuses everything while controls are off, and for a session that is not running', async () => {
    const rig = makeRig({ settings: SettingsSchema.parse({ controls: { enabled: false } }) });
    expect(await rig.controls.key(SID, 'interrupt', { kind: 'cli' })).toMatchObject({ ok: false, code: 'forbidden', reason: expect.stringMatching(/jantar controls on/) });
    const on = makeRig();
    expect(await on.controls.key('no-such-session', 'interrupt', { kind: 'cli' })).toMatchObject({ ok: false, code: 'not_found' });
    on.terminal.noPane = true;
    expect(await on.controls.key(SID, 'interrupt', { kind: 'cli' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(on.terminal.pressed).toEqual([]);
  });

  it('waits for the pane lock, gives up after 8 s, and never presses late', async () => {
    const rig = makeRig();
    let release!: () => void;
    const held = rig.writer.withPaneLock({ id: 'p', backend: 'terminal-app', handle: '1:1', tty: TTY, foreground: 'claude' }, () => new Promise<void>((r) => (release = r)));
    const r = rig.controls.key(SID, 'interrupt', { kind: 'cli' });
    await flush();
    rig.clock.advance(LOCK_WAIT_MS - 1);
    await flush();
    expect(rig.terminal.pressed).toEqual([]);
    rig.clock.advance(1);
    expect(await r).toEqual({ ok: false, code: 'refused', reason: BUSY_REASON });
    release();
    await held;
    await flush();
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('G8: under --read-only the backend refuses the key, so nothing is typed', async () => {
    const rig = makeRig();
    const controls = buildControlsService(rig.ctx, {
      sessions: { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null },
      terminal: readOnlyTerminal(rig.terminal),
      writer: rig.writer,
      hooks: rig.hooks,
      transcripts: {} as never,
      ccwLegacy: rig.ccw,
    });
    const r = await drive(rig.clock, controls.key(SID, 'interrupt', { kind: 'cli' }));
    expect(r).toMatchObject({ ok: false, code: 'unsupported', reason: expect.stringMatching(/read-only/) });
    expect(rig.terminal.pressed).toEqual([]);
  });
});
