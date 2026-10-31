/**
 * The screen path's answer (controls/dialog.ts, spec 2.4) against the
 * scripted terminal, with the shared dialog fixtures on its screen: the
 * guard (fingerprint under the lock, compare-and-type), the rows' rules
 * (text, hold, locked), the cards (a main card wins, a subagent's doesn't),
 * and the after-reads that decide `done` or `unchanged`, including the one
 * lone Return for long text Terminal's CR left in the row (D1, D2, D4-D8,
 * D10, D14). Every refusal types nothing. The rig reads with the shipped
 * gates (Up and tall on since SP14 and SP15) unless a test passes OFF.
 */
import { describe, expect, it } from 'vitest';
import { DIALOG_FIXTURES, TYPED_ANSWER, TYPED_PLAN_NOTE, dialogFixture, withGates, type DialogFixture } from '@jantar/fixtures';
import {
  DIALOG_COUNTDOWN_MIN_S,
  DIALOG_GATES,
  DIALOG_NOTES,
  SettingsSchema,
  type DialogGates,
  type PendingRequest,
  type SessionDialogBody,
  type TerminalDialog,
} from '@jantar/protocol';
import type { ControlResult, DialogAnswer } from '../../src/contracts.js';
import { BUSY_REASON, LOCK_WAIT_MS, SHARED_PROCESS } from '../../src/controls/common.js';
import {
  AFTER_READ_MS,
  AFTER_READ_STEP_MS,
  CANT_CHECK,
  COUNTDOWN_LATE,
  DIALOG_CHANGED,
  DIALOG_GONE,
  HOLD_TO_CONFIRM,
  NEEDS_TEXT,
  NO_SUCH_ROW,
  ROW_LOCKED,
  TEXT_ELSEWHERE,
  rowProblem,
} from '../../src/controls/dialog.js';
import { dialogOfScreen, rawExpect, readDialog } from '../../src/terminal/dialog.js';
import { lastLines, screenLines } from '../../src/terminal/screen.js';
import { PHONE, SID, T0, TTY, drive, flush, makeRig, type Rig } from './helpers.js';

const R80 = '─'.repeat(80);
const D80 = '╌'.repeat(80);
/** Every gate off: the screen path before SP14 and SP15 passed. */
const OFF: DialogGates = { up: false, tall: false, noFirst: false };
/** Claude at work after an answer: the dialog closed, the prompt box below. */
const WORKING = ['● Writing the file now.', '', '✻ Working… (3s · esc to interrupt)', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');

const screenOf = (name: string) => dialogFixture(name).screen;
/** What the phone was shown for `screen` (the shipped gates unless `gates` says otherwise). */
function shownOn(screen: string, gates: DialogGates = DIALOG_GATES): TerminalDialog {
  const d = dialogOfScreen(screen, gates).dialog;
  if (!d) throw new Error('no dialog on that screen');
  return d;
}
/** The raw text the write must find: the dialog from its top through its last line (around Claude's countdown's time, its parts). */
function blockOf(screen: string): string | string[] {
  const { block } = dialogOfScreen(screen);
  if (!block) throw new Error('no block');
  return rawExpect(screen, block.from, block.to, readDialog(screen).countdown);
}

function waitingRig(screen: string, settings?: Parameters<typeof SettingsSchema.parse>[0], gates?: DialogGates): Rig {
  const rig = makeRig({ session: { status: 'waiting' }, ...(settings ? { settings: SettingsSchema.parse(settings) } : {}), ...(gates ? { gates } : {}) });
  rig.terminal.screen = screen;
  return rig;
}

function answer(rig: Rig, body: SessionDialogBody): Promise<ControlResult<DialogAnswer>> {
  return drive(rig.clock, rig.controls.answerDialog(SID, body, PHONE));
}

/** After each key press the screen becomes the next of `screens` (the last one stays). */
function thenShow(rig: Rig, ...screens: string[]): void {
  let i = 0;
  rig.terminal.onKey = () => {
    rig.terminal.screen = screens[Math.min(i, screens.length - 1)] as string;
    i += 1;
  };
}

function card(over: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: '01JTESTCARD0000000000000002abc',
    sid: SID,
    kind: 'permission',
    tool: 'Write',
    input: { file_path: '/tmp/demo/notes.md' },
    suggestions: [],
    correlationKey: `${SID}|Write|{}`,
    createdAt: T0,
    settleUntil: T0,
    state: 'open',
    ...over,
  };
}

describe('answering a dialog', () => {
  it('moves from the pointer it just read, with the dialog block as the compare-and-type text, and is done when the dialog closes', async () => {
    const screen = screenOf('PLAN_80COL');
    const rig = waitingRig(screen);
    thenShow(rig, WORKING);
    const d = shownOn(screen);
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 1 })).toEqual({ ok: true, outcome: 'done', dialog: null, kind: 'plan', role: 'pick', options: 3 });
    expect(rig.terminal.pressed).toEqual(['down']);
    expect(rig.terminal.keyOpts).toEqual([{ expect: blockOf(screen), repeat: 1 }]);
    // The block starts at "Ready to code?": the transcript above it is not compared.
    expect((blockOf(screen) as string).startsWith('   Ready to code?')).toBe(true);
  });

  it('the highlighted row is Return alone (an empty write); a hold row needs confirm: true', async () => {
    const screen = screenOf('PLAN_80COL');
    const rig = waitingRig(screen);
    thenShow(rig, WORKING);
    const d = shownOn(screen);
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 0 })).toEqual({ ok: false, code: 'needs_confirm', reason: HOLD_TO_CONFIRM });
    expect(rig.terminal.pressed).toEqual([]);
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 0, confirm: true })).toMatchObject({ ok: true, outcome: 'done' });
    expect(rig.terminal.pressed).toEqual(['enter']);
    expect(rig.terminal.keyOpts).toEqual([{ expect: blockOf(screen) }]);
  });

  it('D5: every hold kind of the fixtures needs confirm', async () => {
    for (const name of ['PERM_CREATE_ALWAYS', 'PERM_BASH_PREFIX', 'PERM_READ_OUTSIDE', 'PLAN_CLEAR', 'PERM_BASH_DONT_ASK']) {
      const screen = screenOf(name);
      const d = shownOn(screen);
      for (const [i, o] of d.options.entries()) {
        if (!o.hold || o.role === 'locked') continue;
        const rig = waitingRig(screen);
        expect(await answer(rig, { fingerprint: d.fingerprint, option: i }), `${name} ${i}`).toEqual({ ok: false, code: 'needs_confirm', reason: HOLD_TO_CONFIRM });
        expect(rig.terminal.pressed).toEqual([]);
      }
    }
  });

  it('D4: a text row needs text, and only a text row takes it; the text follows the arrows in the same write', async () => {
    const screen = screenOf('Q_SINGLE');
    const d = shownOn(screen);
    const rig = waitingRig(screen);
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 3 })).toEqual({ ok: false, code: 'invalid_request', reason: NEEDS_TEXT });
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 1, text: 'teal' })).toEqual({ ok: false, code: 'invalid_request', reason: TEXT_ELSEWHERE });
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 4, text: 'teal' })).toEqual({ ok: false, code: 'invalid_request', reason: TEXT_ELSEWHERE });
    expect(rig.terminal.pressed).toEqual([]);
    thenShow(rig, WORKING);
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 3, text: 'teal' })).toMatchObject({ ok: true, outcome: 'done', role: 'text' });
    expect(rig.terminal.pressed).toEqual(['down']);
    expect(rig.terminal.keyOpts).toEqual([{ expect: blockOf(screen), repeat: 3, text: 'teal' }]);
  });

  it('a locked row is refused with its own note; a row past the end too', async () => {
    const typed = shownOn(screenOf('Q_TYPED'));
    const rig = waitingRig(screenOf('Q_TYPED'));
    expect(await answer(rig, { fingerprint: typed.fingerprint, option: 3, text: 'teal' })).toEqual({ ok: false, code: 'invalid_request', reason: DIALOG_NOTES.typed });
    expect(await answer(rig, { fingerprint: typed.fingerprint, option: 9 })).toEqual({ ok: false, code: 'invalid_request', reason: NO_SUCH_ROW });
    const multi = waitingRig(screenOf('Q_MULTI'));
    expect(await answer(multi, { fingerprint: shownOn(screenOf('Q_MULTI')).fingerprint, option: 3, text: 'kiwi' })).toEqual({ ok: false, code: 'invalid_request', reason: DIALOG_NOTES.multiText });
    // Chat about this lies across the typed row: no arrow is sent through it.
    expect(await answer(rig, { fingerprint: typed.fingerprint, option: 4 })).toEqual({ ok: false, code: 'invalid_request', reason: DIALOG_NOTES.pastTyped });
    const pending = waitingRig(screenOf('Q_TEXT_PENDING'));
    expect(await answer(pending, { fingerprint: shownOn(screenOf('Q_TEXT_PENDING')).fingerprint, option: 4 })).toEqual({ ok: false, code: 'invalid_request', reason: DIALOG_NOTES.pastTyped });
    for (const r of [rig, multi, pending]) expect(r.terminal.pressed).toEqual([]);
  });

  it("gates off: a row on a plan showing ↓ and a row above the pointer are refused with the gate's note", async () => {
    const tall = waitingRig(screenOf('PLAN_FULLSCREEN'), undefined, OFF);
    const plan = shownOn(screenOf('PLAN_FULLSCREEN'), OFF);
    expect(await answer(tall, { fingerprint: plan.fingerprint, option: 1 })).toEqual({ ok: false, code: 'invalid_request', reason: DIALOG_NOTES.tall });
    const above = waitingRig(screenOf('PERM_OVERWRITE_3_TOP'), undefined, OFF);
    const top = shownOn(screenOf('PERM_OVERWRITE_3_TOP'), OFF);
    expect(await answer(above, { fingerprint: top.fingerprint, option: 0 })).toEqual({ ok: false, code: 'invalid_request', reason: DIALOG_NOTES.up });
    for (const r of [tall, above]) expect(r.terminal.pressed).toEqual([]);
  });

  it('SP14, as shipped: a row above the pointer is one Up per row, compare-and-type on the dialog block, then done', async () => {
    const cases: [string, number, number, string | undefined][] = [
      ['PERM_OVERWRITE_3_TOP', 0, 1, undefined],
      ['Q_ON_CHAT', 0, 4, undefined],
      ['Q_ON_CHAT', 3, 1, 'teal'],
      ['Q_MULTI_TICKED', 0, 2, undefined],
    ];
    for (const [name, option, ups, text] of cases) {
      const screen = screenOf(name);
      const rig = waitingRig(screen);
      thenShow(rig, WORKING);
      const r = await answer(rig, { fingerprint: shownOn(screen).fingerprint, option, ...(text ? { text } : {}) });
      expect(r, `${name} ${option}`).toMatchObject({ ok: true, outcome: 'done' });
      expect(rig.terminal.pressed, `${name} ${option}`).toEqual(['up']);
      expect(rig.terminal.keyOpts, `${name} ${option}`).toEqual([{ expect: blockOf(screen), repeat: ups, ...(text ? { text } : {}) }]);
    }
  });

  it('SP15, as shipped: every row of a plan showing ↓ is Downs from the pointer, the feedback row with its note', async () => {
    const screen = screenOf('PLAN_FULLSCREEN');
    const plan = shownOn(screen);
    expect(plan.options.map((o) => o.role)).toEqual(['pick', 'pick', 'text']);
    const manual = waitingRig(screen);
    thenShow(manual, WORKING);
    expect(await answer(manual, { fingerprint: plan.fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done', kind: 'plan', role: 'pick' });
    expect(manual.terminal.pressed).toEqual(['down']);
    expect(manual.terminal.keyOpts).toEqual([{ expect: blockOf(screen), repeat: 1 }]);
    const note = waitingRig(screen);
    thenShow(note, WORKING);
    expect(await answer(note, { fingerprint: plan.fingerprint, option: 2, text: 'shorter please' })).toMatchObject({ ok: true, outcome: 'done', role: 'text' });
    expect(note.terminal.keyOpts).toEqual([{ expect: blockOf(screen), repeat: 2, text: 'shorter please' }]);
  });

  it('as shipped, a dialog whose top is off screen still has no buttons: no tap types anything (PERM_OVERWRITE_3, PERM_BASH_TALL)', async () => {
    // Even the fingerprint the same dialog had scrolled into view.
    const whole = shownOn(screenOf('PERM_OVERWRITE_3_TOP'));
    for (const name of ['PERM_OVERWRITE_3', 'PERM_BASH_TALL']) {
      expect(dialogOfScreen(screenOf(name))).toEqual({ dialog: null, note: DIALOG_NOTES.unsure, block: null });
      const rig = waitingRig(screenOf(name));
      for (const option of [0, 1]) {
        expect(await answer(rig, { fingerprint: whole.fingerprint, option }), `${name} ${option}`).toEqual({ ok: false, code: 'conflict', reason: DIALOG_GONE });
      }
      expect(rig.terminal.pressed, name).toEqual([]);
    }
  });

  /** Answer every row of `f` read with `gates`: each write as its bytes, or null when refused (nothing typed). */
  async function bytesOf(f: DialogFixture, gates: DialogGates): Promise<(string | null)[]> {
    const d = dialogOfScreen(f.screen, gates).dialog;
    if (!d) return [];
    const bytes: (string | null)[] = [];
    for (const [i, o] of d.options.entries()) {
      const rig = waitingRig(f.screen, undefined, gates);
      thenShow(rig, WORKING);
      const body: SessionDialogBody = { fingerprint: d.fingerprint, option: i, ...(o.role === 'text' ? { text: 'teal' } : {}), ...(o.hold ? { confirm: true } : {}) };
      const r = await answer(rig, body);
      if (!r.ok) {
        expect(rig.terminal.pressed, `${f.name} ${i}`).toEqual([]);
        bytes.push(null);
        continue;
      }
      expect(r, `${f.name} ${i}`).toMatchObject({ ok: true, outcome: 'done' });
      const [key] = rig.terminal.pressed;
      const opts = rig.terminal.keyOpts[0] ?? {};
      const arrow = key === 'down' ? '\u001b[B' : key === 'up' ? '\u001b[A' : '';
      expect(opts.expect, `${f.name} ${i}`).toEqual(blockOf(f.screen));
      bytes.push(arrow.repeat(opts.repeat ?? 1) + (opts.text ?? ''));
    }
    return bytes;
  }

  it('D3, gates off: the bytes for every fixture row the phone can answer are Down runs (and text), from the pointer read', async () => {
    for (const f of DIALOG_FIXTURES) {
      if (!dialogOfScreen(f.screen, OFF).dialog) continue;
      const bytes = await bytesOf(f, OFF);
      expect(bytes, f.name).toEqual(f.bytes);
      for (const b of bytes) expect(b ?? '', f.name).not.toContain('\u001b[A');
    }
  });

  it('D3, the shipped gates: rows above the pointer are Up runs, every row of a plan showing ↓ is Downs; the rest as with the gates off', async () => {
    let ups = 0;
    for (const f of DIALOG_FIXTURES) {
      const d = dialogOfScreen(f.screen).dialog;
      if (!d) continue;
      const bytes = await bytesOf(f, DIALOG_GATES);
      expect(bytes, f.name).toEqual(withGates(f, DIALOG_GATES).bytes);
      bytes.forEach((b, i) => {
        if (b === null || i >= d.current) return;
        expect(b.replace(/teal$/u, ''), `${f.name} ${i}`).toBe('\u001b[A'.repeat(d.current - i));
        ups += 1;
      });
    }
    // PERM_OVERWRITE_3_TOP's Yes, Q_ON_CHAT's four rows above Chat about this, Q_MULTI_TICKED's Apple and Banana.
    expect(ups).toBe(7);
    expect(withGates(dialogFixture('PLAN_FULLSCREEN'), DIALOG_GATES).bytes).toEqual(['', '\u001b[B', '\u001b[B\u001b[Bteal']);
  });
});

describe('the guard', () => {
  const base = screenOf('Q_TABS');
  const phone = shownOn(base);

  it('D1: types nothing when the dialog changed (title / question / body / label / count / checked / tabs / pointer)', async () => {
    const swap = (s: string, a: string, b: string) => {
      expect(s.includes(a), a).toBe(true);
      return s.replace(a, b);
    };
    const multi = screenOf('Q_MULTI');
    const create = screenOf('PERM_CREATE_2');
    const bash = screenOf('PERM_BASH_PREFIX');
    const cases: [string, string, string][] = [
      ['title', create, swap(create, ' Create file', ' Create notes')],
      ['question', base, swap(base, 'What level should the role be?', 'What level should the hire be?')],
      ['body', bash, swap(bash, ' date > a.txt', ' date > c.txt')],
      ['label', base, swap(base, '  2. Junior-mid, 1-3 yrs', '  2. Junior-mid, 1-4 yrs')],
      ['count', create, swap(create, '   2. No', '   2. No\n   3. No, and stop')],
      ['checked', multi, swap(multi, '  2. [ ] Banana', '  2. [✔] Banana')],
      ['tabs', base, swap(base, '☐ Scope', '☒ Scope')],
      ['pointer', base, swap(swap(base, '❯ 1. Junior, 0-1 yrs', '  1. Junior, 0-1 yrs'), '  2. Junior-mid, 1-3 yrs', '❯ 2. Junior-mid, 1-3 yrs')],
    ];
    for (const [what, seen, now] of cases) {
      const rig = waitingRig(now);
      const r = await answer(rig, { fingerprint: shownOn(seen).fingerprint, option: 1 });
      expect(r, what).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
      expect(rig.terminal.pressed, what).toEqual([]);
    }
  });

  it('SP4: a stale tap landing on the queued twin of a heredoc whose text draws a rule: 409, nothing typed', async () => {
    const prompt = (file: string) =>
      [
        '● I will write two notes files.',
        '',
        R80,
        ' Bash command',
        ` Write the notes to ${file}`,
        D80,
        ` cat > ${file} <<'EOF'`,
        ' # Notes',
        ` ${'─'.repeat(30)}`,
        ' first point',
        ' EOF',
        D80,
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        '',
        ' Esc to cancel · Tab to amend',
      ].join('\n');
    // The one dialog both twins read as when the rule in their text was taken for the top: title "first point".
    const stale = shownOn([R80, ' first point', ' EOF', D80, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'].join('\n'));
    for (const file of ['a.md', 'b.md']) {
      const rig = waitingRig(prompt(file));
      expect(await answer(rig, { fingerprint: stale.fingerprint, option: 1 }), file).toEqual({ ok: false, code: 'conflict', reason: DIALOG_GONE });
      expect(rig.terminal.pressed, file).toEqual([]);
    }
  });

  it("rowProblem: a row above the pointer is refused while the up gate is off, even one the model didn't lock; with the shipped gates it passes", () => {
    const d: TerminalDialog = {
      kind: 'permission',
      title: 'Create file',
      question: 'Do you want to create b.txt?',
      body: [],
      options: [
        { label: 'Yes', role: 'pick' },
        { label: 'No', role: 'pick' },
      ],
      current: 1,
      fingerprint: '0'.repeat(64),
    };
    expect(rowProblem(d, { fingerprint: d.fingerprint, option: 0 }, OFF)).toEqual({ ok: false, code: 'invalid_request', reason: ROW_LOCKED });
    expect(rowProblem(d, { fingerprint: d.fingerprint, option: 1 }, OFF)).toBeNull();
    expect(rowProblem(d, { fingerprint: d.fingerprint, option: 0 }, { up: true, tall: false, noFirst: false })).toBeNull();
    expect(rowProblem(d, { fingerprint: d.fingerprint, option: 0 })).toBeNull();
  });

  it('D7: no dialog on screen (closed, unknown, scrolled, a preview, unsure): no write', async () => {
    for (const screen of [WORKING, screenOf('Q_SCROLLED'), screenOf('Q_PREVIEW'), screenOf('Q_NUM_GAP'), screenOf('PERM_DEFAULT_NO')]) {
      const rig = waitingRig(screen);
      expect(await answer(rig, { fingerprint: phone.fingerprint, option: 0 })).toEqual({ ok: false, code: 'conflict', reason: DIALOG_GONE });
      expect(rig.terminal.pressed).toEqual([]);
    }
  });

  it('D10: a screen that changes between the guarded read and the write: 409, nothing typed', async () => {
    const rig = waitingRig(base);
    const moved = base.replace('❯ 1. Junior, 0-1 yrs', '  1. Junior, 0-1 yrs').replace('  2. Junior-mid, 1-3 yrs', '❯ 2. Junior-mid, 1-3 yrs');
    const read = rig.terminal.readScreen.bind(rig.terminal);
    rig.terminal.readScreen = async () => {
      const r = await read();
      rig.terminal.screen = moved; // the Mac moved the pointer right after Jantar read it
      return r;
    };
    expect(await answer(rig, { fingerprint: phone.fingerprint, option: 1 })).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it("refuses a terminal that can't give its raw text, or can't press keys", async () => {
    const rig = waitingRig(base);
    rig.terminal.readScreen = async () => ({ ok: true, text: base, at: T0 });
    expect(await answer(rig, { fingerprint: phone.fingerprint, option: 1 })).toEqual({ ok: false, code: 'unsupported', reason: CANT_CHECK });
    expect(rig.terminal.pressed).toEqual([]);
    const noKeys = waitingRig(base);
    (noKeys.terminal as { pressKey?: unknown }).pressKey = undefined;
    expect(await answer(noKeys, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('controls off, an ended session, Claude not in front, a ccw move: refused, nothing typed', async () => {
    const off = waitingRig(base, { controls: { enabled: false } });
    expect(await answer(off, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: false, code: 'forbidden' });
    const ended = makeRig({ session: { status: 'ended' } });
    ended.terminal.screen = base;
    expect(await answer(ended, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: false, code: 'refused' });
    const shell = waitingRig(base);
    shell.terminal.foreground = 'shell';
    expect(await answer(shell, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: false, code: 'refused' });
    const moving = waitingRig(base);
    moving.ccw.moving = SID;
    expect(await answer(moving, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/move/) });
    for (const r of [off, ended, shell, moving]) expect(r.terminal.pressed).toEqual([]);
  });

  it('another running session on the same Claude process (a /resume inside it): refused, nothing typed; once it ends, answered', async () => {
    const screen = screenOf('PERM_CREATE_2');
    const rig = waitingRig(screen);
    const own = rig.ctx.store.getState().sessions[SID] as NonNullable<ReturnType<typeof rig.ctx.store.getState>['sessions'][string]>;
    const other = { ...own, sid: '22222222-2222-4222-8222-222222222222' };
    rig.ctx.store.emit({ type: 'session.added', sid: other.sid, data: { session: other } });
    expect(await answer(rig, { fingerprint: shownOn(screen).fingerprint, option: 0 })).toEqual({ ok: false, code: 'refused', reason: SHARED_PROCESS });
    expect(await drive(rig.clock, rig.controls.keypad(other.sid, { screen: 'a'.repeat(64), lines: 40, move: 0, key: 'enter' }, PHONE))).toEqual({
      ok: false,
      code: 'refused',
      reason: SHARED_PROCESS,
    });
    expect(rig.terminal.pressed).toEqual([]);
    rig.ctx.store.emit({ type: 'session.updated', sid: other.sid, data: { patch: { status: 'ended' } } });
    expect(await answer(rig, { fingerprint: shownOn(screen).fingerprint, option: 0 })).toMatchObject({ ok: true });
  });

  it('a session that is working, not waiting, may still be answered (its file can be late)', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    rig.terminal.screen = base;
    thenShow(rig, WORKING);
    expect(await answer(rig, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done' });
  });

  it('D6: a main card blocks; a subagent card does not', async () => {
    const rig = waitingRig(base);
    rig.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card() } });
    expect(await answer(rig, { fingerprint: phone.fingerprint, option: 1 })).toEqual({
      ok: false,
      code: 'refused',
      reason: 'A permission card is open for this session; answer the card.',
    });
    expect(rig.terminal.pressed).toEqual([]);
    const sub = waitingRig(base);
    sub.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card({ kind: 'subagent-info', tool: 'Bash' }) } });
    thenShow(sub, WORKING);
    expect(await answer(sub, { fingerprint: phone.fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done' });
    expect(sub.terminal.pressed).toEqual(['down']);
  });

  it('D2: a late lock types nothing', async () => {
    const rig = waitingRig(base);
    let release!: () => void;
    const held = rig.writer.withPaneLock({ id: 'p', backend: 'terminal-app', handle: '1:1', tty: TTY, foreground: 'claude' }, () => new Promise<void>((r) => (release = r)));
    const r = rig.controls.answerDialog(SID, { fingerprint: phone.fingerprint, option: 1 }, PHONE);
    await flush();
    rig.clock.advance(LOCK_WAIT_MS);
    expect(await r).toEqual({ ok: false, code: 'refused', reason: BUSY_REASON });
    release();
    await held;
    await flush();
    expect(rig.terminal.pressed).toEqual([]);
  });

  it("D2: a second answer waits for the first one's after-reads, then finds the dialog gone", async () => {
    const rig = waitingRig(base);
    thenShow(rig, WORKING);
    const both = Promise.all([
      rig.controls.answerDialog(SID, { fingerprint: phone.fingerprint, option: 1 }, PHONE),
      rig.controls.answerDialog(SID, { fingerprint: phone.fingerprint, option: 1 }, PHONE),
    ]);
    const [first, second] = await drive(rig.clock, both);
    expect(first).toMatchObject({ ok: true, outcome: 'done' });
    expect(second).toEqual({ ok: false, code: 'conflict', reason: DIALOG_GONE });
    expect(rig.terminal.pressed).toEqual(['down']);
  });

  it('a timed-out write is reported, not retried', async () => {
    const rig = waitingRig(base);
    rig.terminal.pressResult = { ok: false, code: 'timeout', reason: 'Terminal did not answer in time' };
    expect(await answer(rig, { fingerprint: phone.fingerprint, option: 1 })).toEqual({ ok: false, code: 'timeout', reason: 'Terminal did not answer in time' });
    expect(rig.terminal.pressed).toEqual(['down']);
  });
});

describe('outcome (D8)', () => {
  it('the queued twin (same rows, another command) is a new dialog: done, with the twin', async () => {
    const rig = waitingRig(screenOf('PERM_BASH_PREFIX'));
    thenShow(rig, screenOf('PERM_BASH_TWIN'));
    const r = await answer(rig, { fingerprint: shownOn(screenOf('PERM_BASH_PREFIX')).fingerprint, option: 0 });
    expect(r).toMatchObject({ ok: true, outcome: 'done' });
    expect(r.ok && r.dialog).toEqual(shownOn(screenOf('PERM_BASH_TWIN')));
  });

  it('a dialog whose top is off screen has no buttons: any answer is refused before a write (PERM_OVERWRITE_3)', async () => {
    const rig = waitingRig(screenOf('PERM_OVERWRITE_3'));
    // Even the fingerprint the scrolled-into-view dialog had.
    const r = await answer(rig, { fingerprint: shownOn(screenOf('PERM_OVERWRITE_3_TOP')).fingerprint, option: 1 });
    expect(r).toEqual({ ok: false, code: 'conflict', reason: DIALOG_GONE });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('answered, then the queued twin drawn alike below its top shows with its top off screen: unchanged, and no dialog comes back for it', async () => {
    const a = screenOf('PERM_BASH_LONG');
    // The twin removes another folder; an 80x24 Terminal shows only its last rows, the same as the first's.
    const twin = lastLines(a.replace('./build-cache', './src'), 24).join('\n');
    expect(twin).toBe(lastLines(a, 24).join('\n'));
    const rig = waitingRig(a);
    thenShow(rig, twin);
    const r = await answer(rig, { fingerprint: shownOn(a).fingerprint, option: 0 });
    expect(r).toMatchObject({ ok: true, outcome: 'unchanged', dialog: null });
    expect(rig.terminal.pressed).toEqual(['enter']);
    // A second tap with the same fingerprint finds no dialog to answer: nothing typed.
    expect(await answer(rig, { fingerprint: shownOn(a).fingerprint, option: 0 })).toEqual({ ok: false, code: 'conflict', reason: DIALOG_GONE });
    expect(rig.terminal.pressed).toEqual(['enter']);
  });

  it('scrolled out of view (the title goes, the body loses lines at the top): unchanged, not done, and no buttons back', async () => {
    const rig = waitingRig(screenOf('PERM_OVERWRITE_3_TOP'));
    thenShow(rig, screenOf('PERM_OVERWRITE_3'));
    const r = await answer(rig, { fingerprint: shownOn(screenOf('PERM_OVERWRITE_3_TOP')).fingerprint, option: 1 });
    expect(r).toMatchObject({ ok: true, outcome: 'unchanged', dialog: null });
    // A body cut at the top while the top is still on screen is another dialog's.
    const cut = screenOf('PERM_OVERWRITE_3_TOP').replace(' 1 -# Notes\n 1 +# Notes for the demo\n', '');
    const moved = waitingRig(screenOf('PERM_OVERWRITE_3_TOP'));
    thenShow(moved, cut);
    expect(await answer(moved, { fingerprint: shownOn(screenOf('PERM_OVERWRITE_3_TOP')).fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done' });
  });

  it('one half-drawn read is not done: two reads in a row must agree', async () => {
    const rig = waitingRig(screenOf('PERM_CREATE_2'));
    const d = shownOn(screenOf('PERM_CREATE_2'));
    const read = rig.terminal.readScreen.bind(rig.terminal);
    let typed = false;
    let reads = 0;
    rig.terminal.onKey = () => {
      typed = true;
    };
    // After the write the screen flickers: gone, back, gone, back, ...
    rig.terminal.readScreen = async () => {
      if (typed) rig.terminal.screen = reads++ % 2 === 0 ? WORKING : screenOf('PERM_CREATE_2');
      return read();
    };
    expect(await answer(rig, { fingerprint: d.fingerprint, option: 0 })).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(reads).toBe(AFTER_READ_MS / AFTER_READ_STEP_MS);
  });

  it('a failed after-read is logged and breaks a run: gone, failed, gone is never done; two gone after it are', async () => {
    /** After the write the dialog is gone, and the reads in `failing` (1-based) fail. */
    const rigWith = (failing: (n: number) => boolean) => {
      const rig = waitingRig(screenOf('PERM_CREATE_2'));
      const read = rig.terminal.readScreen.bind(rig.terminal);
      let typed = false;
      let reads = 0;
      rig.terminal.onKey = () => {
        typed = true;
        rig.terminal.screen = WORKING;
      };
      rig.terminal.readScreen = async () => {
        if (!typed) return read();
        reads += 1;
        return failing(reads) ? { ok: false, code: 'unreadable', reason: 'synthetic' } : read();
      };
      return { rig, reads: () => reads };
    };
    const d = shownOn(screenOf('PERM_CREATE_2'));
    const odd = rigWith((n) => n % 2 === 0);
    expect(await answer(odd.rig, { fingerprint: d.fingerprint, option: 0 })).toMatchObject({ ok: true, outcome: 'unchanged', dialog: null });
    expect(odd.reads()).toBe(AFTER_READ_MS / AFTER_READ_STEP_MS);
    expect(odd.rig.ctx.log.records.filter((l) => l.msg === 'dialog after-read failed').map((l) => l.fields)).toEqual([{ code: 'unreadable' }, { code: 'unreadable' }]);
    const first = rigWith((n) => n === 1);
    expect(await answer(first.rig, { fingerprint: d.fingerprint, option: 0 })).toMatchObject({ ok: true, outcome: 'done', dialog: null });
    expect(first.reads()).toBe(3);
  });

  it('a pointer that moved but chose nothing: unchanged (the row above it greyed by the up gate while that is off, a pick as shipped)', async () => {
    const tabs = screenOf('Q_TABS');
    const moved = tabs.replace('❯ 1. Junior, 0-1 yrs', '  1. Junior, 0-1 yrs').replace('  2. Junior-mid, 1-3 yrs', '❯ 2. Junior-mid, 1-3 yrs');
    for (const [gates, role] of [
      [OFF, 'locked'],
      [DIALOG_GATES, 'pick'],
    ] as const) {
      const rig = waitingRig(tabs, undefined, gates);
      thenShow(rig, moved);
      const r = await answer(rig, { fingerprint: shownOn(tabs, gates).fingerprint, option: 1 });
      expect(r, role).toMatchObject({ ok: true, outcome: 'unchanged' });
      expect(r.ok && r.dialog?.current, role).toBe(1);
      expect(r.ok && r.dialog?.options[0]?.role, role).toBe(role);
    }
  });

  it('nothing changes at all: unchanged after the reads, with the live dialog', async () => {
    const screen = screenOf('PERM_CREATE_2');
    const rig = waitingRig(screen);
    const r = await answer(rig, { fingerprint: shownOn(screen).fingerprint, option: 1 });
    expect(r).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(r.ok && r.dialog).toEqual(shownOn(screen));
  });

  it('the next question is done at once, with that question', async () => {
    const tabs = screenOf('Q_TABS');
    const next = tabs.replace('←  ☒ Level  ☐ Scope', '←  ☒ Level  ☒ Scope').replace('What level should the role be?', 'Where should the role sit?');
    const rig = waitingRig(tabs);
    thenShow(rig, next);
    const r = await answer(rig, { fingerprint: shownOn(tabs).fingerprint, option: 2 });
    expect(r).toMatchObject({ ok: true, outcome: 'done' });
    expect(r.ok && r.dialog?.question).toBe('Where should the role sit?');
  });
});

describe('a multi-select, then the review', () => {
  it('toggle, toggle, Submit, then the review\'s Submit answers: one guarded write each', async () => {
    const multi = screenOf('Q_MULTI');
    const apple = multi.replace('❯ 1. [ ] Apple', '❯ 1. [✔] Apple');
    const cherry = screenOf('Q_MULTI_TICKED');
    const review = screenOf('Q_REVIEW');
    const rig = waitingRig(multi);
    thenShow(rig, apple, cherry, review, WORKING);
    let d = shownOn(multi);
    const step = async (option: number) => {
      const r = await answer(rig, { fingerprint: d.fingerprint, option });
      expect(r, `option ${option}`).toMatchObject({ ok: true, outcome: 'done' });
      if (r.ok && r.dialog) d = r.dialog;
      return r;
    };
    expect((await step(0)).ok && d.options[0]).toMatchObject({ role: 'toggle', checked: true });
    expect((await step(2)).ok && d.options[2]).toMatchObject({ role: 'toggle', checked: true });
    expect(d.current).toBe(2);
    expect(d.options[4]).toEqual({ label: 'Submit', role: 'submit' });
    expect((await step(4)).ok && d.kind).toBe('review');
    expect(await step(0)).toMatchObject({ dialog: null, kind: 'review', role: 'pick' });
    expect(rig.terminal.pressed).toEqual(['enter', 'down', 'down', 'enter']);
    expect(rig.terminal.keyOpts.map((o) => o?.repeat)).toEqual([undefined, 2, 2, undefined]);
  });
});

describe('long text: the one guarded lone Return (D14)', () => {
  it('Q_TEXT_PENDING: the row holds the whole answer on two reads, so one Return follows, then done', async () => {
    const rig = waitingRig(screenOf('Q_SINGLE'));
    thenShow(rig, screenOf('Q_TEXT_PENDING'), WORKING);
    const r = await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: TYPED_ANSWER });
    expect(r).toMatchObject({ ok: true, outcome: 'done', dialog: null, role: 'text' });
    expect(rig.terminal.pressed).toEqual(['down', 'enter']);
    expect(rig.terminal.keyOpts[0]).toEqual({ expect: blockOf(screenOf('Q_SINGLE')), repeat: 3, text: TYPED_ANSWER });
    // The Return is compare-and-type on the screen that showed the waiting text.
    expect(rig.terminal.keyOpts[1]).toEqual({ expect: blockOf(screenOf('Q_TEXT_PENDING')) });
  });

  it('PLAN_TEXT_PENDING: the same for a plan note', async () => {
    const rig = waitingRig(screenOf('PLAN_80COL'));
    thenShow(rig, screenOf('PLAN_TEXT_PENDING'), WORKING);
    const r = await answer(rig, { fingerprint: shownOn(screenOf('PLAN_80COL')).fingerprint, option: 2, text: TYPED_PLAN_NOTE });
    expect(r).toMatchObject({ ok: true, outcome: 'done', dialog: null });
    expect(rig.terminal.pressed).toEqual(['down', 'enter']);
    expect(rig.terminal.keyOpts[1]).toEqual({ expect: blockOf(screenOf('PLAN_TEXT_PENDING')) });
  });

  it('never a second Return: a row that still waits after it is unchanged', async () => {
    const rig = waitingRig(screenOf('Q_SINGLE'));
    thenShow(rig, screenOf('Q_TEXT_PENDING'));
    const r = await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: TYPED_ANSWER });
    expect(r).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(r.ok && r.dialog?.options[3]?.note).toBe(DIALOG_NOTES.typed);
    expect(rig.terminal.pressed).toEqual(['down', 'enter']);
  });

  it('a lone Return that fails (the screen changed, or a timeout) is logged with its code; the reads go on, never another Return', async () => {
    for (const code of ['changed', 'timeout'] as const) {
      const rig = waitingRig(screenOf('Q_SINGLE'));
      thenShow(rig, screenOf('Q_TEXT_PENDING'));
      const press = rig.terminal.pressKey.bind(rig.terminal);
      let calls = 0;
      rig.terminal.pressKey = async (pane, key, opts) => {
        calls += 1;
        return calls === 2 ? { ok: false, code, reason: 'synthetic' } : press(pane, key, opts);
      };
      const r = await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: TYPED_ANSWER });
      expect(r, code).toMatchObject({ ok: true, outcome: 'unchanged', role: 'text' });
      expect(r.ok && r.dialog?.options[3]?.note, code).toBe(DIALOG_NOTES.typed);
      expect(calls, code).toBe(2);
      expect(rig.terminal.pressed, code).toEqual(['down']);
      expect(rig.ctx.log.records.filter((l) => l.msg === 'dialog text commit not typed').map((l) => l.fields), code).toEqual([{ code }]);
    }
  });

  it('the text still in its row on a screen that no longer reads as a dialog (header scrolled off, a word left alone): unchanged, no Return', async () => {
    const first = 'first line of a long answer that the user typed on the phone and then';
    const cases: [string, string][] = [
      [screenLines(screenOf('Q_TEXT_PENDING')).slice(4).join('\n'), TYPED_ANSWER],
      [screenOf('Q_SINGLE').replace('❯ 1. Red', '  1. Red').replace('  4. Type something.', `❯ 4. ${first}\n     Next`), `${first} Next`],
    ];
    for (const [after, text] of cases) {
      expect(dialogOfScreen(after).dialog).toBeNull();
      const rig = waitingRig(screenOf('Q_SINGLE'));
      thenShow(rig, after);
      const r = await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text });
      expect(r).toMatchObject({ ok: true, outcome: 'unchanged', dialog: null });
      expect(rig.terminal.pressed).toEqual(['down']);
      // The same screen after a text it doesn't hold is the dialog gone.
      const other = waitingRig(screenOf('Q_SINGLE'));
      thenShow(other, after);
      expect(await answer(other, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: 'teal' })).toMatchObject({ ok: true, outcome: 'done' });
    }
  });

  it('short text: submitted by the write itself, no second write', async () => {
    const rig = waitingRig(screenOf('Q_SINGLE'));
    thenShow(rig, WORKING);
    expect(await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: 'teal' })).toMatchObject({ ok: true, outcome: 'done' });
    expect(rig.terminal.pressed).toEqual(['down']);
  });

  it('row text differs from what was typed: no Return, unchanged (not done)', async () => {
    const rig = waitingRig(screenOf('Q_SINGLE'));
    thenShow(rig, screenOf('Q_TEXT_PENDING'));
    const other = `${TYPED_ANSWER.slice(0, -1)} too.`;
    const r = await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: other });
    expect(r).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(rig.terminal.pressed).toEqual(['down']);
  });

  it('anything else different on the screen: no Return', async () => {
    const rig = waitingRig(screenOf('Q_SINGLE'));
    // The typed text waits, but the pointer is elsewhere.
    const elsewhere = screenOf('Q_TEXT_PENDING').replace('❯ 4. ', '  4. ').replace('  1. Red', '❯ 1. Red');
    thenShow(rig, elsewhere);
    expect(await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: TYPED_ANSWER })).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(rig.terminal.pressed).toEqual(['down']);
  });

  it('only two pending reads in a row send it: a pending read between two others does not', async () => {
    const rig = waitingRig(screenOf('Q_SINGLE'));
    const read = rig.terminal.readScreen.bind(rig.terminal);
    let typed = false;
    let reads = 0;
    rig.terminal.onKey = () => {
      typed = true;
    };
    rig.terminal.readScreen = async () => {
      if (typed) rig.terminal.screen = reads++ % 2 === 0 ? screenOf('Q_TEXT_PENDING') : screenOf('Q_SINGLE');
      return read();
    };
    expect(await answer(rig, { fingerprint: shownOn(screenOf('Q_SINGLE')).fingerprint, option: 3, text: TYPED_ANSWER })).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(rig.terminal.pressed).toEqual(['down']);
  });
});

describe("v0.5.2: a workflow agent's prompt and Claude's auto-block countdown", () => {
  const at133 = screenOf('PERM_WORKFLOW_133');
  const at132 = screenOf('PERM_WORKFLOW_132');
  /** The same prompt at another second of its countdown. */
  const tick = (time: string) => at133.replace('in 1:33,', `in ${time},`);

  it("a tap made at 1:33 is answered at 1:32: compare-and-type on the parts around the countdown's time, then done", async () => {
    const rig = waitingRig(at132);
    thenShow(rig, WORKING);
    const r = await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 });
    expect(r).toEqual({ ok: true, outcome: 'done', dialog: null, kind: 'permission', role: 'pick', options: 2 });
    expect(rig.terminal.pressed).toEqual(['down']);
    // The parts of the block read at 1:32: the title through "… request in ", then ", to avoid …" through the hint.
    const parts = rig.terminal.keyOpts[0]?.expect;
    expect(parts).toEqual(blockOf(at132));
    expect(Array.isArray(parts) && parts.length).toBe(2);
    expect((parts as string[])[0]?.endsWith('⚠ Claude Code will automatically block this request in ')).toBe(true);
    expect((parts as string[])[1]?.startsWith(', to avoid holding up an')).toBe(true);
    expect(JSON.stringify(parts)).not.toMatch(/1:3\d/u);
    // The Yes row is the highlighted one: Return alone.
    const yes = waitingRig(screenOf('PERM_WORKFLOW_005'));
    thenShow(yes, WORKING);
    expect(await answer(yes, { fingerprint: shownOn(at133).fingerprint, option: 0 })).toMatchObject({ ok: true, outcome: 'done' });
    expect(yes.terminal.pressed).toEqual(['enter']);
  });

  it('the countdown ticks between the guarded read and the write: still typed (only the countdown changed)', async () => {
    const rig = waitingRig(at133);
    thenShow(rig, WORKING);
    const read = rig.terminal.readScreen.bind(rig.terminal);
    let first = true;
    rig.terminal.readScreen = async () => {
      const r = await read();
      if (first) rig.terminal.screen = tick('1:32'); // the Mac's countdown moved on right after Jantar read it
      first = false;
      return r;
    };
    expect(await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done' });
    expect(rig.terminal.pressed).toEqual(['down']);
  });

  it('only the countdown ticking after the write is no answer: unchanged with the live dialog, never done', async () => {
    const rig = waitingRig(at133);
    const read = rig.terminal.readScreen.bind(rig.terminal);
    let typed = false;
    let reads = 0;
    // The write didn't take: the dialog stays, its countdown ticking about every third read.
    const times = ['1:32', '1:32', '1:32', '1:31', '1:31', '1:31'];
    rig.terminal.onKey = () => {
      typed = true;
    };
    rig.terminal.readScreen = async () => {
      if (typed) rig.terminal.screen = tick(times[Math.min(reads++, times.length - 1)] as string);
      return read();
    };
    const r = await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 });
    expect(r).toMatchObject({ ok: true, outcome: 'unchanged' });
    expect(r.ok && r.dialog?.fingerprint).toBe(shownOn(at133).fingerprint);
    expect(r.ok && r.dialog?.blocksIn).toBe('1:31');
    expect(rig.terminal.pressed).toEqual(['down']);
  });

  it('two queued workflow prompts that differ only in their command: a stale tap for the first is refused on the second, nothing typed', async () => {
    const a = screenOf('PERM_WORKFLOW_TWIN_A');
    const b = screenOf('PERM_WORKFLOW_TWIN_B');
    const rig = waitingRig(b);
    for (const option of [0, 1]) {
      expect(await answer(rig, { fingerprint: shownOn(a).fingerprint, option }), `${option}`).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
    }
    // The same at any second of either countdown.
    rig.terminal.screen = b.replace('in 1:58,', 'in 0:31,');
    expect(await answer(rig, { fingerprint: shownOn(a.replace('in 1:58,', 'in 1:40,')).fingerprint, option: 0 })).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
    expect(rig.terminal.pressed).toEqual([]);
    // Answered, the first gives way to its twin: done, with the twin.
    const first = waitingRig(a);
    thenShow(first, b);
    const r = await answer(first, { fingerprint: shownOn(a).fingerprint, option: 0 });
    expect(r).toMatchObject({ ok: true, outcome: 'done' });
    expect(r.ok && r.dialog?.fingerprint).toBe(shownOn(b).fingerprint);
  });

  it('the twin taking its place between the guarded read and the write: 409, nothing typed', async () => {
    const a = screenOf('PERM_WORKFLOW_TWIN_A');
    const rig = waitingRig(a);
    const read = rig.terminal.readScreen.bind(rig.terminal);
    rig.terminal.readScreen = async () => {
      const r = await read();
      rig.terminal.screen = screenOf('PERM_WORKFLOW_TWIN_B').replace('in 1:58,', 'in 1:57,');
      return r;
    };
    expect(await answer(rig, { fingerprint: shownOn(a).fingerprint, option: 1 })).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('the countdown gone, or anything but a time in its place, between the guarded read and the write: 409, nothing typed', async () => {
    const lines = screenLines(at133);
    const at = lines.findIndex((l) => l.includes('automatically block'));
    const drawn = lines.slice(at, at + 2).join('\n');
    const swaps = {
      gone: at133.replace(`${drawn}\n`, ''),
      line: at133.replace('in 1:33,', 'in 1:33\n │ rm -rf $HOME/demo\n,'),
      word: at133.replace('in 1:33,', 'in soon,'),
      longer: at133.replace('in 1:33,', 'in 101:33,'),
      empty: at133.replace('in 1:33,', 'in ,'),
    };
    for (const [what, swapped] of Object.entries(swaps)) {
      const rig = waitingRig(at133);
      const read = rig.terminal.readScreen.bind(rig.terminal);
      rig.terminal.readScreen = async () => {
        const r = await read();
        rig.terminal.screen = swapped;
        return r;
      };
      expect(await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 }), what).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
      expect(rig.terminal.pressed, what).toEqual([]);
    }
  });

  it(`under ${DIALOG_COUNTDOWN_MIN_S} s left (0:04) nothing is typed and Claude's own block is named; at 0:05 the tap goes`, async () => {
    for (const time of ['0:04', '0:01', '0:00']) {
      const rig = waitingRig(tick(time));
      for (const option of [0, 1]) {
        expect(await answer(rig, { fingerprint: shownOn(at133).fingerprint, option }), `${time} ${option}`).toEqual({ ok: false, code: 'conflict', reason: COUNTDOWN_LATE });
      }
      expect(rig.terminal.pressed, time).toEqual([]);
    }
    const rig = waitingRig(screenOf('PERM_WORKFLOW_005'));
    thenShow(rig, WORKING);
    expect(await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done' });
    expect(rig.terminal.pressed).toEqual(['down']);
    // "about N seconds" counts as N, "about N minutes" as 60 N.
    expect(await answer(waitingRig(tick('about 3 seconds')), { fingerprint: shownOn(at133).fingerprint, option: 1 })).toEqual({ ok: false, code: 'conflict', reason: COUNTDOWN_LATE });
    const minutes = waitingRig(tick('about 1 minute'));
    thenShow(minutes, WORKING);
    expect(await answer(minutes, { fingerprint: shownOn(at133).fingerprint, option: 1 })).toMatchObject({ ok: true, outcome: 'done' });
  });

  it('Claude blocking the ask by itself during the after-reads is never taken for this answer: unchanged, with what the Mac shows', async () => {
    // The write is slow (an osascript run stalled for 4 s) and doesn't take; Claude blocks the ask at 0:00 and
    // the next queued prompt (or none) shows. Two reads of it would otherwise make `done`.
    const run = async (time: string, next: string) => {
      const rig = waitingRig(tick(time));
      const press = rig.terminal.pressKey.bind(rig.terminal);
      let blocksAt = Number.POSITIVE_INFINITY;
      rig.terminal.pressKey = async (...args) => {
        blocksAt = rig.clock.now() + 4_000;
        await rig.clock.sleep(4_000);
        return press(...args);
      };
      const read = rig.terminal.readScreen.bind(rig.terminal);
      rig.terminal.readScreen = async () => {
        if (rig.clock.now() >= blocksAt) rig.terminal.screen = next;
        return read();
      };
      const r = await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 });
      expect(rig.terminal.pressed).toEqual(['down']);
      return r;
    };
    const twin = screenOf('PERM_WORKFLOW_TWIN_B');
    expect(await run('0:05', WORKING)).toEqual({ ok: true, outcome: 'unchanged', dialog: null, kind: 'permission', role: 'pick', options: 2 });
    expect(await run('0:05', twin)).toEqual({ ok: true, outcome: 'unchanged', dialog: shownOn(twin), kind: 'permission', role: 'pick', options: 2 });
    // Far from the countdown's end the same screens are the answer taking (nothing else could have closed it).
    expect(await run('1:33', WORKING)).toMatchObject({ ok: true, outcome: 'done', dialog: null });
    expect(await run('1:33', twin)).toMatchObject({ ok: true, outcome: 'done', dialog: shownOn(twin) });
  });

  it('a changed command, question, label or pointer under a ticking countdown still refuses, nothing typed', async () => {
    const changed = {
      command: tick('1:20').replace('rm -rf $T/out/*; done', 'rm -rf $T/*; done'),
      question: tick('1:20').replace(' Do you want to proceed?', ' Do you want to run it?'),
      label: tick('1:20').replace('   2. No', '   2. No, and tell Claude what to do differently (esc)'),
      pointer: tick('1:20').replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No'),
    };
    for (const [what, screen] of Object.entries(changed)) {
      const rig = waitingRig(screen);
      expect(await answer(rig, { fingerprint: shownOn(at133).fingerprint, option: 1 }), what).toEqual({ ok: false, code: 'conflict', reason: DIALOG_CHANGED });
      expect(rig.terminal.pressed, what).toEqual([]);
    }
  });
});
