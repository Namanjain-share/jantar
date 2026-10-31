/**
 * The keypad (controls/keypad.ts, spec 3) against the scripted terminal: it
 * types the composed moves and one Return in one compare-and-type write, and
 * only on a screen with no buttons that still shows exactly what the phone
 * was shown, with a visible pointer and no prompt box (K1-K7). The rig
 * reads with the shipped gates (Up on since SP14) unless a test passes OFF.
 */
import { describe, expect, it } from 'vitest';
import { NOT_DIALOG_SCREENS, dialogFixture } from '@jantar/fixtures';
import { DIALOG_GATES, KEYPAD_ESCAPE, SettingsSchema, type DialogGates, type PendingRequest, type SessionKeypadBody } from '@jantar/protocol';
import type { ControlResult } from '../../src/contracts.js';
import { CANT_CHECK } from '../../src/controls/dialog.js';
import { ESCAPE_UNVERIFIED } from '../../src/controls/keys.js';
import { HAS_BUTTONS, KEYPAD_ESCAPE_OFF, KEYPAD_UP_OFF, NO_POINTER, POINTER_NOT_LAST, PROMPT_BOX, SCREEN_CHANGED } from '../../src/controls/keypad.js';
import { rawSlice, screenKey, screenKeyRange } from '../../src/terminal/dialog.js';
import { PHONE, SID, T0, claudeScreen, drive, makeRig, type Rig } from './helpers.js';

const PICKER = NOT_DIALOG_SCREENS.MODEL_PICKER as string;
const LINES = 40;
/** Every gate off: the keypad before SP14 passed. */
const OFF: DialogGates = { up: false, tall: false, noFirst: false };

function keypadRig(
  screen: string,
  opts: { status?: 'waiting' | 'working' | 'idle'; settings?: Parameters<typeof SettingsSchema.parse>[0]; gates?: DialogGates } = {},
): Rig {
  const rig = makeRig({
    session: { status: opts.status ?? 'waiting' },
    ...(opts.settings ? { settings: SettingsSchema.parse(opts.settings) } : {}),
    ...(opts.gates ? { gates: opts.gates } : {}),
  });
  rig.terminal.screen = screen;
  return rig;
}

/** The body the phone sends for what it was shown. */
const bodyFor = (screen: string, over: Partial<SessionKeypadBody> = {}): SessionKeypadBody => ({ screen: screenKey(screen, LINES), lines: LINES, move: 0, key: 'enter', ...over });

function send(rig: Rig, body: SessionKeypadBody): Promise<ControlResult> {
  return drive(rig.clock, rig.controls.keypad(SID, body, PHONE));
}

describe('the keypad', () => {
  it('sends the moves and the Return in one write, compare-and-type on the lines the phone was shown', async () => {
    const rig = keypadRig(PICKER);
    expect(await send(rig, bodyFor(PICKER, { move: 2 }))).toEqual({ ok: true });
    const range = screenKeyRange(PICKER, LINES);
    expect(rig.terminal.pressed).toEqual(['down']);
    expect(rig.terminal.keyOpts).toEqual([{ expect: rawSlice(PICKER, range.from, range.to), repeat: 2 }]);
    // The checked text covers the rows and the pointer.
    expect(rig.terminal.keyOpts[0]?.expect).toContain(' ❯ 1. Default (recommended)  ✔');
  });

  it('Enter alone is an empty write (the highlighted row); it works on an MCP form too', async () => {
    const form = NOT_DIALOG_SCREENS.MCP_FORM as string;
    const rig = keypadRig(form);
    expect(await send(rig, bodyFor(form))).toEqual({ ok: true });
    expect(rig.terminal.pressed).toEqual(['enter']);
    expect(rig.terminal.keyOpts[0]?.repeat).toBeUndefined();
  });

  it('works on a screen whose dialog gets a note (scrolled, unsure, No first, its top off screen)', async () => {
    for (const name of ['Q_SCROLLED', 'Q_NUM_GAP', 'PERM_DEFAULT_NO', 'Q_PREVIEW', 'PERM_OVERWRITE_3', 'PERM_BASH_TALL']) {
      const screen = dialogFixture(name).screen;
      const rig = keypadRig(screen);
      expect(await send(rig, bodyFor(screen, { move: 1 })), name).toEqual({ ok: true });
      expect(rig.terminal.pressed, name).toEqual(['down']);
    }
  });

  it('K1: the prompt box with no dialog: refused, nothing typed', async () => {
    for (const screen of [claudeScreen(), claudeScreen({ draft: 'half a prompt' }), NOT_DIALOG_SCREENS.INTERRUPTED as string, NOT_DIALOG_SCREENS.IDLE_DRAFT as string]) {
      const rig = keypadRig(screen, { status: 'idle' });
      expect(await send(rig, bodyFor(screen, { move: 1 }))).toEqual({ ok: false, code: 'refused', reason: PROMPT_BOX });
      expect(rig.terminal.pressed).toEqual([]);
    }
  });

  it('K1: a bash-mode prompt box (`!` under the edge) is the prompt box too, even with a ❯ elsewhere on screen', async () => {
    const withPointer = claudeScreen({ draft: 'x', above: ['', '❯ an earlier prompt'] });
    for (const draft of ['! make clean', '!']) {
      const screen = withPointer.replace('\n❯ x\n', `\n${draft}\n`);
      expect(screen).toContain(`\n${draft}\n`);
      const rig = keypadRig(screen, { status: 'idle' });
      expect(await send(rig, bodyFor(screen)), draft).toEqual({ ok: false, code: 'refused', reason: PROMPT_BOX });
      expect(rig.terminal.pressed, draft).toEqual([]);
    }
    // A `!` line that isn't right under an edge (a shell command in the transcript) is not a box.
    const picker = ['⏺ Ran a shell command', '! make clean', '', PICKER].join('\n');
    expect(await send(keypadRig(picker), bodyFor(picker))).toEqual({ ok: true });
  });

  it('K2: a changed screen is a 409; the key covers exactly the lines shown', async () => {
    const rig = keypadRig(PICKER);
    const moved = PICKER.replace(' ❯ 1. Default', '   1. Default').replace('   2. Opus', ' ❯ 2. Opus');
    rig.terminal.screen = moved;
    expect(await send(rig, bodyFor(PICKER, { move: 1 }))).toEqual({ ok: false, code: 'conflict', reason: SCREEN_CHANGED });
    expect(rig.terminal.pressed).toEqual([]);
    // A line above what the phone was shown may change; one it was shown may not.
    const tall = [...Array.from({ length: 50 }, (_, i) => `older line ${i}`), PICKER].join('\n');
    const rig2 = keypadRig(tall.replace('older line 0', 'older line zero'));
    expect(await send(rig2, bodyFor(tall))).toEqual({ ok: true });
    // A tall screen asked for with another line count is another key.
    const rig3 = keypadRig(tall);
    expect(await send(rig3, { ...bodyFor(tall), lines: 41 })).toEqual({ ok: false, code: 'conflict', reason: SCREEN_CHANGED });
    expect(rig2.terminal.pressed).toEqual(['enter']);
    expect(rig3.terminal.pressed).toEqual([]);
  });

  it('K3: a dialog that has buttons: refused (use them)', async () => {
    for (const name of ['Q_SINGLE', 'Q_ON_CHAT', 'PERM_CREATE_2', 'PLAN_80COL', 'Q_REVIEW']) {
      const screen = dialogFixture(name).screen;
      const rig = keypadRig(screen);
      expect(await send(rig, bodyFor(screen, { move: 1 })), name).toEqual({ ok: false, code: 'refused', reason: HAS_BUTTONS });
      expect(rig.terminal.pressed).toEqual([]);
    }
  });

  it('K4: Escape needs KEYPAD_ESCAPE and controls.escapeVerified, and never takes moves', async () => {
    const rig = keypadRig(PICKER);
    expect(KEYPAD_ESCAPE).toBe(false);
    expect(await send(rig, bodyFor(PICKER, { key: 'escape' }))).toEqual({ ok: false, code: 'refused', reason: KEYPAD_ESCAPE_OFF });
    expect(await send(rig, bodyFor(PICKER, { key: 'escape', move: 2 }))).toMatchObject({ ok: false });
    expect(rig.terminal.pressed).toEqual([]);
    const unverified = keypadRig(PICKER, { settings: { controls: { escapeVerified: false } } });
    const r = await send(unverified, bodyFor(PICKER, { key: 'escape' }));
    expect(r).toEqual(KEYPAD_ESCAPE ? { ok: false, code: 'escape_unverified', reason: ESCAPE_UNVERIFIED } : { ok: false, code: 'refused', reason: KEYPAD_ESCAPE_OFF });
  });

  it('K5: no ❯ or › in the lines shown: refused (Terminal shares no colours)', async () => {
    const list = NOT_DIALOG_SCREENS.NO_POINTER_LIST as string;
    const rig = keypadRig(list);
    expect(await send(rig, bodyFor(list, { move: 1 }))).toEqual({ ok: false, code: 'refused', reason: NO_POINTER });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('K5: a ❯ in Claude\'s output above a live screen without one (a saved screen printed): refused, it is not the live pointer', async () => {
    for (const name of ['SAVED_OVER_FORM', 'SAVED_IN_TRANSCRIPT_VIEW']) {
      const screen = NOT_DIALOG_SCREENS[name] as string;
      const rig = keypadRig(screen);
      expect(await send(rig, bodyFor(screen)), name).toEqual({ ok: false, code: 'refused', reason: POINTER_NOT_LAST });
      expect(rig.terminal.pressed, name).toEqual([]);
    }
    // The live form with its own ❯ under the same output: its list ends the screen.
    const form = (NOT_DIALOG_SCREENS.SAVED_OVER_FORM as string).replace(' > my notes', ' Share it?\n ❯ Yes\n   No');
    expect(await send(keypadRig(form), bodyFor(form))).toEqual({ ok: true });
  });

  it('K6: a move up is refused while the up gate is off', async () => {
    const rig = keypadRig(PICKER, { gates: OFF });
    expect(await send(rig, bodyFor(PICKER, { move: -1 }))).toEqual({ ok: false, code: 'invalid_request', reason: KEYPAD_UP_OFF });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('K6, as shipped (SP14): a move up is Up runs and the Return in one guarded write', async () => {
    expect(DIALOG_GATES.up).toBe(true);
    // The /model picker with its pointer moved down to row 3 at the Mac.
    const lower = PICKER.replace(' ❯ 1. Default', '   1. Default').replace('   3. Haiku', ' ❯ 3. Haiku');
    expect(lower).not.toBe(PICKER);
    const rig = keypadRig(lower);
    expect(await send(rig, bodyFor(lower, { move: -2 }))).toEqual({ ok: true });
    const range = screenKeyRange(lower, LINES);
    expect(rig.terminal.pressed).toEqual(['up']);
    expect(rig.terminal.keyOpts).toEqual([{ expect: rawSlice(lower, range.from, range.to), repeat: 2 }]);
    // Still refused, nothing typed: Claude's prompt box (↑ there brings back the last prompt) and a dialog with buttons.
    const box = keypadRig(claudeScreen(), { status: 'idle' });
    expect(await send(box, bodyFor(claudeScreen(), { move: -1 }))).toEqual({ ok: false, code: 'refused', reason: PROMPT_BOX });
    const chat = dialogFixture('Q_ON_CHAT').screen;
    const buttons = keypadRig(chat);
    expect(await send(buttons, bodyFor(chat, { move: -1 }))).toEqual({ ok: false, code: 'refused', reason: HAS_BUTTONS });
    for (const r of [box, buttons]) expect(r.terminal.pressed).toEqual([]);
  });

  it('K7: a screen that changes between the read and the write: 409, nothing typed', async () => {
    const rig = keypadRig(PICKER);
    const read = rig.terminal.readScreen.bind(rig.terminal);
    rig.terminal.readScreen = async () => {
      const r = await read();
      rig.terminal.screen = PICKER.replace(' ❯ 1. Default', '   1. Default').replace('   3. Haiku', ' ❯ 3. Haiku');
      return r;
    };
    expect(await send(rig, bodyFor(PICKER, { move: 1 }))).toEqual({ ok: false, code: 'conflict', reason: SCREEN_CHANGED });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it("refuses a terminal that can't give its raw text", async () => {
    const rig = keypadRig(PICKER);
    rig.terminal.readScreen = async () => ({ ok: true, text: PICKER, at: T0 });
    expect(await send(rig, bodyFor(PICKER))).toEqual({ ok: false, code: 'unsupported', reason: CANT_CHECK });
  });

  it('a main card blocks it; a subagent card does not; controls off refuses first', async () => {
    const card = (kind: PendingRequest['kind']): PendingRequest => ({
      id: `01JTESTCARD000000000000000${kind === 'permission' ? '3' : '4'}abc`,
      sid: SID,
      kind,
      tool: 'Bash',
      input: { command: 'date' },
      suggestions: [],
      correlationKey: `${SID}|Bash|{}`,
      createdAt: T0,
      settleUntil: T0,
      state: 'open',
    });
    const main = keypadRig(PICKER);
    main.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card('permission') } });
    expect(await send(main, bodyFor(PICKER))).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/card is open/) });
    expect(main.terminal.pressed).toEqual([]);
    const sub = keypadRig(PICKER);
    sub.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card('subagent-info') } });
    expect(await send(sub, bodyFor(PICKER))).toEqual({ ok: true });
    const off = keypadRig(PICKER, { settings: { controls: { enabled: false } } });
    expect(await send(off, bodyFor(PICKER))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(off.terminal.pressed).toEqual([]);
  });

  it('a screen with a dialog above its prompt box (answered, in the scrollback) is the prompt box', async () => {
    const answered = NOT_DIALOG_SCREENS.ANSWERED_ABOVE_BOX as string;
    const rig = keypadRig(answered, { status: 'idle' });
    expect(await send(rig, bodyFor(answered, { move: 1 }))).toEqual({ ok: false, code: 'refused', reason: PROMPT_BOX });
  });
});
