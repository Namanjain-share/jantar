/**
 * v0.4.2 terminal dialogs end to end (spec 9.3 flows 1-7): jantard
 * in-process on a synthetic HOME with the real Terminal.app backend (the one
 * constant AppleScript, argv only) against the fake `osascript`, and a phone
 * paired with read and control. Each flow puts a dialog fixture's screen
 * (test/fixtures/src/dialogs.ts, Claude Code 2.1.314's layouts with neutral
 * words) on the session's fake tab, reads it the way the phone does
 * (GET screen), answers it (POST dialog), and draws the screen Claude would
 * draw next when a write lands. Every write is checked byte for byte at the
 * osascript argv: `typeif <bytes> <the dialog's raw text>`.
 *
 * 1. Hook-less plan: option 1 is ESC[B, the plan closes, `done`.
 * 2. A plan whose box scrolls (SP15, the `tall` gate on): the highlighted
 *    auto-mode row wants a hold, then is an empty write; row 2 is ESC[B,
 *    the feedback row its Downs and the note.
 * 2b. Long text: "Type something." with 120 characters; Terminal's Return
 *    is swallowed (the row shows the text), so one lone Return follows;
 *    when even that leaves the row as it was, no third write: `unchanged`.
 * 2c. Queued twin: the next Bash prompt with the same rows and another
 *    command is a new dialog (`done`), never the same one.
 * 2e. v0.5.2, a workflow agent's prompt with Claude's auto-block countdown:
 *    the phone reads it at 1:33, the daemon at 1:32, the tab shows 1:31 at
 *    the write; one typeif with the two parts around the countdown's time,
 *    `done`. Its queued twin (another command, counting down too) refuses a
 *    stale tap, and a tap with 4 s left is refused, nothing typed.
 * 3. Three questions, in the order Claude draws them (each answer ticks its
 *    tab), then the review of all three, then Submit.
 * 4. Multi-select: two ticks, a third above the pointer with ESC[A (SP14,
 *    the `up` gate on), Submit, the review's Submit.
 * 5. Changed at the Mac: between the daemon's read and its write the tab
 *    changes, so the fake answers __JANTAR_CHANGED__ and nothing is typed
 *    (409); a phone that saw an older dialog gets 409 with no write at all.
 * 6. Cards win: a held PermissionRequest card refuses the screen path, a
 *    subagent's card does not; once the card closes, the dialog answers.
 * 7. Keypad: moves (Up too, since SP14) and Enter on a screen with no
 *    buttons; refused on the prompt box, with no visible pointer, on a
 *    dialog with buttons, and on a screen that changed since the phone read
 *    it; Escape waits for SP1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIALOG_SECRET, NOT_DIALOG_SCREENS, TYPED_ANSWER, dialogFixture, withGates } from '@jantar/fixtures';
import { dialogOfScreen, rawExpect, rawSlice, readDialog } from '@jantar/daemon/terminal/dialog';
import {
  DEVICE_COOKIE,
  DIALOG_GATES,
  DIALOG_NOTES,
  type PairStartResponse,
  type PendingRequest,
  type ScreenResponse,
  type SessionDialogResponse,
  type SessionsResponse,
  type StateResponse,
  type TerminalDialog,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, type CtlClient } from '../../packages/cli/src/index.js';
import { FakeTabs, bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, hookTag, http, rememberSecret, sendHook, type HttpResult } from './http.js';

const SID = '61616161-6161-4616-8616-616161616161';
const TTY = '/dev/ttys061';
const ESC_B = '\u001b[B';
const ESC_A = '\u001b[A';
const R80 = '─'.repeat(80);
/** Claude at work after an answer: no dialog, the prompt box below. */
const WORKING = ['● Writing the file now.', '', '✻ Working… (3s · esc to interrupt)', '', R80, '❯ ', R80, '  ⏸ manual mode on · ? for shortcuts'].join('\n');

const screenOf = (name: string) => dialogFixture(name).screen;
/** A fixture's model as the daemon must read it with the shipped gates (Up and tall on), without its fingerprint. */
const modelOf = (name: string) => withGates(dialogFixture(name), DIALOG_GATES).expected.dialog;
const withoutPrint = (d: TerminalDialog | null | undefined) => {
  if (!d) return d;
  const { fingerprint: _f, ...rest } = d;
  return rest;
};
/** The raw text the compare-and-type write must find: the dialog from its top through its last line. */
function blockOf(screen: string): string {
  const read = dialogOfScreen(screen);
  if (!read.block) throw new Error('no dialog block on this screen');
  return rawSlice(screen, read.block.from, read.block.to);
}

/**
 * The second of three questions (Q_TABS's layout, other words). Q_TABS shows the first question again with
 * its answer already ticked (☒ Level); answering it moves on to Scope, so the bar is drawn as it was.
 */
const SECOND_QUESTION = screenOf('Q_TABS')
  .replace('What level should the role be?', 'Where should the role sit?')
  .replace('❯ 1. Junior, 0-1 yrs', '❯ 1. Remote')
  .replace('  2. Junior-mid, 1-3 yrs', '  2. Office')
  .replace('  3. Senior, 3+ yrs', '  3. Hybrid');
/** The third question: Scope's answer ticks its tab, Setup is still open. */
const THIRD_QUESTION = screenOf('Q_TABS')
  .replace('←  ☒ Level  ☐ Scope  ☐ Setup', '←  ☒ Level  ☒ Scope  ☐ Setup')
  .replace('What level should the role be?', 'How should the role be set up?')
  .replace('❯ 1. Junior, 0-1 yrs', '❯ 1. Full-time')
  .replace('  2. Junior-mid, 1-3 yrs', '  2. Part-time')
  .replace('  3. Senior, 3+ yrs', '  3. Contract');
/** Q_REVIEW's layout for these three questions: every tab ticked, each question with its answer. */
const REVIEW_ANSWERS = [' ● Pick a colour', '   → purple', ' ● Pick a size', `   → Large (${DIALOG_SECRET})`];
const THREE_ANSWERS = [
  ' ● What level should the role be?',
  '   → Junior-mid, 1-3 yrs',
  ' ● Where should the role sit?',
  '   → Hybrid',
  ' ● How should the role be set up?',
  `   → Part-time (${DIALOG_SECRET})`,
];
const REVIEW_THREE = screenOf('Q_REVIEW')
  .replace('←  ☒ Colour  ☒ Size  ✔ Submit  →', '←  ☒ Level  ☒ Scope  ☒ Setup  ✔ Submit  →')
  .replace(REVIEW_ANSWERS.join('\n'), THREE_ANSWERS.join('\n'));
/** Q_MULTI after the first tick: Apple's box drawn ticked, the pointer still on it. */
const MULTI_APPLE = screenOf('Q_MULTI').replace('❯ 1. [ ] Apple', '❯ 1. [✔] Apple');
/** Q_MULTI_TICKED after Banana, above the pointer, was ticked with one Up: the pointer on Banana. */
const MULTI_BANANA = screenOf('Q_MULTI_TICKED').replace('  2. [ ] Banana', '❯ 2. [✔] Banana').replace('❯ 3. [✔] Cherry', '  3. [✔] Cherry');

describe('v0.4.2 dialogs: the screen path and the keypad through the fake osascript', () => {
  let d: Daemon;
  let tabs: FakeTabs;
  let ctl: CtlClient;
  let phone = '';

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  /** What the phone reads: the screen, its dialog (with a fingerprint) or note, and the keypad's key. */
  async function read(lines = 40): Promise<ScreenResponse> {
    const r = await http(d.port, 'GET', `/v1/sessions/${SID}/screen?lines=${lines}`, { cookie: phone });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as ScreenResponse;
  }

  const post = (path: string, body: unknown) =>
    http(d.port, 'POST', `/v1/sessions/${SID}/${path}`, { cookie: phone, body, headers: { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` } });

  /** One tap on the dialog the phone was shown. */
  async function tap(dialog: TerminalDialog, option: number, more: { text?: string; confirm?: boolean } = {}): Promise<HttpResult> {
    return post('dialog', { fingerprint: dialog.fingerprint, option, ...more });
  }

  async function answered(dialog: TerminalDialog, option: number, more: { text?: string; confirm?: boolean } = {}): Promise<SessionDialogResponse> {
    const r = await tap(dialog, option, more);
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as SessionDialogResponse;
  }

  /** Put `screen` on the tab and read it as the phone does; the dialog must parse. */
  async function shown(screen: string): Promise<TerminalDialog> {
    await tabs.show(TTY, screen);
    const s = await read();
    if (!s.dialog) throw new Error(`no dialog read from the screen (note: ${s.dialogNote ?? 'none'})\n${dumpLog()}`);
    return s.dialog;
  }

  /** After each write that lands, the tab shows the next of `next` (the last one stays). */
  function then(...next: string[]): void {
    let i = 0;
    tabs.on(TTY, {
      after: async () => {
        const screen = next[Math.min(i, next.length - 1)];
        i += 1;
        if (screen !== undefined) await tabs.show(TTY, screen);
      },
    });
  }

  const writes = () => tabs.writesTo(TTY);

  beforeAll(async () => {
    d = await bootDaemon({
      home: { sessions: [{ sid: SID, pid: 61001, account: 1, project: 'demo-app', status: 'waiting', waitingFor: 'approve Write', tty: 'ttys061', transcript: [] }] },
      terminalApp: { wrapExec: (exec, home) => (tabs = new FakeTabs(home)).wrap(exec) },
    });
    await tabs.show(TTY, WORKING);
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.some((s) => s.sid === SID), 15_000, 'the live session');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'dialogs', scopes: ['read', 'control'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'dialogs phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
  }, 60_000);

  afterAll(async () => {
    await d?.stop();
  }, 30_000);

  it('1. a plan with no hook card: option 1 is one ESC[B, the plan closes, done', async () => {
    const screen = screenOf('PLAN_80COL');
    const dialog = await shown(screen);
    expect(withoutPrint(dialog)).toEqual(modelOf('PLAN_80COL'));
    then(WORKING);
    const before = writes().length;
    const r = await answered(dialog, 1);
    expect(r).toEqual({ outcome: 'done', dialog: null });
    expect(writes().slice(before)).toEqual([{ tty: TTY, mode: 'typeif', bytes: ESC_B, expected: blockOf(screen), out: 'ok' }]);
    // At the process level: the constant script on stdin, the bytes and the block only in argv.
    const call = (await d.home.calls('osascript')).filter((c) => c.args[2] === 'typeif').at(-1);
    expect(call?.args).toEqual(['-', TTY, 'typeif', ESC_B, blockOf(screen)]);
    expect(call?.stdin).not.toContain(DIALOG_SECRET);
    // The audit row: what kind, which row, how it went; never the screen.
    const row = d.ctx.db.audit.list({ after: 0, limit: 1000 }).filter((e) => e.action === 'sessionDialog').at(-1);
    expect(row?.params).toEqual({ sid: SID, option: 1, kind: 'plan', options: 3, role: 'pick', outcome: 'done' });
    expect(JSON.stringify(row)).not.toContain(DIALOG_SECRET);
  });

  it('2. a plan whose box scrolls (SP15): every row answers, the highlighted one wants a hold', async () => {
    const screen = screenOf('PLAN_FULLSCREEN');
    let dialog = await shown(screen);
    expect(withoutPrint(dialog)).toEqual(modelOf('PLAN_FULLSCREEN'));
    expect(dialog.options.map((o) => o.role)).toEqual(['pick', 'pick', 'text']);
    then(WORKING);
    const before = writes().length;
    const unheld = await tap(dialog, 0);
    expect(unheld.status).toBe(409);
    expect((unheld.body as { error: { code: string } }).error.code).toBe('needs_confirm');
    expect(writes().length).toBe(before);
    expect(await answered(dialog, 0, { confirm: true })).toEqual({ outcome: 'done', dialog: null });
    // Down on a plan whose box scrolls moves the highlight, as SP15 found on a real Mac.
    dialog = await shown(screen);
    then(WORKING);
    expect(await answered(dialog, 1)).toEqual({ outcome: 'done', dialog: null });
    dialog = await shown(screen);
    then(WORKING);
    expect(await answered(dialog, 2, { text: 'shorter please' })).toEqual({ outcome: 'done', dialog: null });
    expect(writes().slice(before)).toEqual([
      { tty: TTY, mode: 'typeif', bytes: '', expected: blockOf(screen), out: 'ok' },
      { tty: TTY, mode: 'typeif', bytes: ESC_B, expected: blockOf(screen), out: 'ok' },
      { tty: TTY, mode: 'typeif', bytes: `${ESC_B.repeat(2)}shorter please`, expected: blockOf(screen), out: 'ok' },
    ]);
  });

  it('2b. long text: the typed answer waits in its row, one lone Return commits it, never a second', async () => {
    const single = screenOf('Q_SINGLE');
    const pending = screenOf('Q_TEXT_PENDING');
    let dialog = await shown(single);
    then(pending, WORKING);
    let before = writes().length;
    expect(await answered(dialog, 3, { text: TYPED_ANSWER })).toEqual({ outcome: 'done', dialog: null });
    expect(writes().slice(before)).toEqual([
      { tty: TTY, mode: 'typeif', bytes: ESC_B.repeat(3) + TYPED_ANSWER, expected: blockOf(single), out: 'ok' },
      { tty: TTY, mode: 'typeif', bytes: '', expected: blockOf(pending), out: 'ok' },
    ]);

    // The same, but the lone Return changes nothing either: no third write, and the phone hears "unchanged".
    dialog = await shown(single);
    then(pending);
    before = writes().length;
    const r = await answered(dialog, 3, { text: TYPED_ANSWER });
    expect(r.outcome).toBe('unchanged');
    expect(withoutPrint(r.dialog)).toEqual(modelOf('Q_TEXT_PENDING'));
    expect(writes().slice(before).map((w) => w.bytes)).toEqual([ESC_B.repeat(3) + TYPED_ANSWER, '']);

    // A short answer is submitted by Terminal's own Return: one write.
    dialog = await shown(single);
    then(WORKING);
    before = writes().length;
    expect(await answered(dialog, 3, { text: 'teal' })).toEqual({ outcome: 'done', dialog: null });
    expect(writes().slice(before).map((w) => w.bytes)).toEqual([`${ESC_B.repeat(3)}teal`]);
  });

  it('2c. the next queued Bash prompt (same rows, another command) is a new dialog: done, with the twin', async () => {
    const dialog = await shown(screenOf('PERM_BASH_PREFIX'));
    then(screenOf('PERM_BASH_TWIN'));
    const before = writes().length;
    const r = await answered(dialog, 0);
    expect(r.outcome).toBe('done');
    expect(withoutPrint(r.dialog)).toEqual(modelOf('PERM_BASH_TWIN'));
    expect(r.dialog?.fingerprint).not.toBe(dialog.fingerprint);
    expect(writes().slice(before).map((w) => w.bytes)).toEqual(['']);
    // The twin is answered on its own fingerprint; the first one's is stale now.
    expect((await tap(dialog, 0)).status).toBe(409);
  });

  it('2d. the next queued Bash prompt drawn alike below a top that is off screen: no button for it, and a second tap types nothing', async () => {
    const long = screenOf('PERM_BASH_LONG');
    const dialog = await shown(long);
    // Its twin removes another folder; an 80x24 Terminal shows only its last rows, the same as the first's.
    const twin = long.replace('./build-cache', './src').split('\n').slice(-24).join('\n');
    then(twin);
    const before = writes().length;
    expect(await answered(dialog, 0)).toEqual({ outcome: 'unchanged', dialog: null });
    expect(writes().slice(before).map((w) => w.bytes)).toEqual(['']);
    // The phone's read of it: no buttons, the note, the keypad's key.
    const s = await read();
    expect(s.dialog).toBeUndefined();
    expect(s.dialogNote).toBe(DIALOG_NOTES.unsure);
    // A second tap on the first dialog's fingerprint: 409, nothing typed.
    expect((await tap(dialog, 0)).status).toBe(409);
    expect(writes().length).toBe(before + 1);
  });

  it("2e. a workflow agent's prompt whose countdown ticks between the phone's read, the daemon's and the write: answered, its twin not", async () => {
    const at = (time: string) => screenOf('PERM_WORKFLOW_133').replace('in 1:33,', `in ${time},`);
    const dialog = await shown(at('1:33'));
    expect(withoutPrint(dialog)).toEqual(modelOf('PERM_WORKFLOW_133'));
    expect(dialog.blocksIn).toBe('1:33');
    // A second later the phone's next read: the same fingerprint, the new time.
    await tabs.show(TTY, at('1:32'));
    const next = await read();
    expect(next.dialog?.fingerprint).toBe(dialog.fingerprint);
    expect(next.dialog?.blocksIn).toBe('1:32');
    // The tap made at 1:33: the daemon reads 1:32, and the tab has ticked again when the write runs.
    tabs.on(TTY, {
      before: () => tabs.show(TTY, at('1:31')),
      after: () => tabs.show(TTY, WORKING),
    });
    const before = writes().length;
    expect(await answered(dialog, 1)).toEqual({ outcome: 'done', dialog: null });
    const live = readDialog(at('1:32'));
    const parts = rawExpect(at('1:32'), live.block?.from ?? 0, live.block?.to ?? 0, live.countdown);
    expect(Array.isArray(parts) && parts.length).toBe(2);
    expect(JSON.stringify(parts)).not.toContain('1:32');
    expect(writes().slice(before)).toEqual([{ tty: TTY, mode: 'typeif', bytes: ESC_B, expected: parts, out: 'ok' }]);
    const call = (await d.home.calls('osascript')).filter((c) => c.args[2] === 'typeif').at(-1);
    expect(call?.args).toEqual(['-', TTY, 'typeif', ESC_B, ...(parts as string[])]);
    // The audit row says what kind and which row, never the screen or the time.
    const row = d.ctx.db.audit.list({ after: 0, limit: 1000 }).filter((e) => e.action === 'sessionDialog').at(-1);
    expect(row?.params).toEqual({ sid: SID, option: 1, kind: 'permission', options: 2, role: 'pick', outcome: 'done' });
    expect(JSON.stringify(row)).not.toMatch(/1:3\d|automatically block/u);

    // Two queued workflow prompts that differ only in their command: a tap for the first never answers the second.
    const first = await shown(screenOf('PERM_WORKFLOW_TWIN_A'));
    tabs.on(TTY, {});
    await tabs.show(TTY, screenOf('PERM_WORKFLOW_TWIN_B').replace('in 1:58,', 'in 1:57,'));
    const stale = writes().length;
    const r = await tap(first, 0);
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe('conflict');
    expect(writes().length).toBe(stale);

    // Four seconds left: Claude blocks it by itself in a moment and draws the next ask, so nothing is typed.
    const late = await shown(at('0:04'));
    expect(late.blocksIn).toBe('0:04');
    const tooLate = await tap(late, 1);
    expect(tooLate.status).toBe(409);
    expect((tooLate.body as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'conflict',
      message: 'Claude blocks this at the Mac in a moment. Answer it there.',
    });
    expect(writes().length).toBe(stale);
  });

  it('3. three questions, then the review, then Submit', async () => {
    const answeredTabs = (dialog: TerminalDialog | null) => dialog?.tabs?.map((t) => t.answered);
    const first = await shown(screenOf('Q_TABS'));
    expect(answeredTabs(first)).toEqual([true, false, false]);
    then(SECOND_QUESTION);
    const r1 = await answered(first, 1);
    expect(r1.outcome).toBe('done');
    expect(r1.dialog?.question).toBe('Where should the role sit?');
    expect(r1.dialog?.options.map((o) => o.label).slice(0, 3)).toEqual(['Remote', 'Office', 'Hybrid']);
    expect(answeredTabs(r1.dialog)).toEqual([true, false, false]);

    then(THIRD_QUESTION);
    const r2 = await answered(r1.dialog as TerminalDialog, 2);
    expect(r2.outcome).toBe('done');
    expect(r2.dialog?.question).toBe('How should the role be set up?');
    expect(answeredTabs(r2.dialog)).toEqual([true, true, false]);

    then(REVIEW_THREE);
    const r3 = await answered(r2.dialog as TerminalDialog, 1);
    expect(r3.outcome).toBe('done');
    expect(withoutPrint(r3.dialog)).toEqual({
      ...modelOf('Q_REVIEW'),
      tabs: ['Level', 'Scope', 'Setup'].map((label) => ({ label, answered: true })),
      body: THREE_ANSWERS.map((l) => l.slice(1)),
    });

    then(WORKING);
    expect(await answered(r3.dialog as TerminalDialog, 0)).toEqual({ outcome: 'done', dialog: null });
    expect(writes().slice(-4).map((w) => w.bytes)).toEqual([ESC_B, ESC_B.repeat(2), ESC_B, '']);
  });

  it('4. multi-select: tick, tick, tick above the pointer with Up, Submit, then the review', async () => {
    const start = await shown(screenOf('Q_MULTI'));
    expect(start.options.map((o) => o.role)).toEqual(['toggle', 'toggle', 'toggle', 'locked', 'submit', 'chat']);
    then(MULTI_APPLE);
    const apple = await answered(start, 0);
    expect(apple.outcome).toBe('done');
    expect(apple.dialog?.options[0]?.checked).toBe(true);

    then(screenOf('Q_MULTI_TICKED'));
    const cherry = await answered(apple.dialog as TerminalDialog, 2);
    expect(cherry.outcome).toBe('done');
    expect(withoutPrint(cherry.dialog)).toEqual(modelOf('Q_MULTI_TICKED'));
    // Above the pointer now: Apple and Banana are Ups from it (SP14).
    expect(cherry.dialog?.options.map((o) => o.role)).toEqual(['toggle', 'toggle', 'toggle', 'locked', 'submit', 'chat']);
    // "Type something" in a multi-select is answered at the Mac.
    const typeRow = await tap(cherry.dialog as TerminalDialog, 3, { text: 'kiwi' });
    expect(typeRow.status).toBe(400);
    expect((typeRow.body as { error: { message: string } }).error.message).toBe(DIALOG_NOTES.multiText);

    then(MULTI_BANANA);
    const banana = await answered(cherry.dialog as TerminalDialog, 1);
    expect(banana.outcome).toBe('done');
    expect(banana.dialog?.current).toBe(1);
    expect(banana.dialog?.options.slice(0, 3).map((o) => o.checked)).toEqual([true, true, true]);

    then(screenOf('Q_REVIEW'));
    const submit = await answered(banana.dialog as TerminalDialog, 4);
    expect(submit.outcome).toBe('done');
    expect(submit.dialog?.kind).toBe('review');
    then(WORKING);
    expect(await answered(submit.dialog as TerminalDialog, 0)).toEqual({ outcome: 'done', dialog: null });
    expect(writes().slice(-5).map((w) => w.bytes)).toEqual(['', ESC_B.repeat(2), ESC_A, ESC_B.repeat(3), '']);
  });

  it('5. changed at the Mac: nothing is typed, 409', async () => {
    // Between the daemon's guarded read and its write, the pointer moves at the Mac.
    const create = screenOf('PERM_CREATE_2');
    const moved = create.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No');
    const dialog = await shown(create);
    tabs.on(TTY, { before: async () => tabs.show(TTY, moved) });
    const before = writes().length;
    const r = await tap(dialog, 1);
    expect(r.status, r.text).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe('conflict');
    expect(writes().slice(before)).toEqual([{ tty: TTY, mode: 'typeif', bytes: ESC_B, expected: blockOf(create), out: '__JANTAR_CHANGED__' }]);

    // The phone still holds the old dialog: refused at the guarded read, no write at all.
    tabs.on(TTY, {});
    const stale = await tap(dialog, 1);
    expect(stale.status).toBe(409);
    expect(writes().length).toBe(before + 1);
    // The fresh read is answerable.
    const fresh = await shown(moved);
    then(WORKING);
    expect(await answered(fresh, 1)).toEqual({ outcome: 'done', dialog: null });
    expect(writes().at(-1)?.bytes).toBe('');
  });

  it('6. cards win: a main card refuses the screen path, a subagent card does not', async () => {
    const s = d.home.session(SID);
    const dialog = await shown(screenOf('PERM_CREATE_2'));
    const open = (kind: string) =>
      eventually(async () => {
        const st = await callDaemon<StateResponse>(ctl, 'GET', '/v1/state');
        return Object.values(st.state.pending).find((p: PendingRequest) => p.sid === SID && p.state === 'open' && p.kind === kind) ?? null;
      }, 10_000, `a ${kind} card`);

    const conn = sendHook(
      d.ctx.paths.hooksSock,
      {
        hook_event_name: 'PermissionRequest',
        session_id: SID,
        transcript_path: s.transcriptPath,
        cwd: s.cwd,
        permission_mode: 'default',
        tool_name: 'Write',
        tool_input: { file_path: `${s.cwd}/b.txt`, content: 'hello' },
        _jantar: hookTag(s.pid, true, s.configDir),
      },
      true,
    );
    let card: PendingRequest | null = null;
    try {
      card = await open('permission');
      const before = writes().length;
      const refused = await tap(dialog, 0);
      expect(refused.status, refused.text).toBe(422);
      expect(writes().length).toBe(before);
    } finally {
      conn.close();
    }
    // Claude answered at the Mac: the hook's connection ends and the card closes.
    await eventually(async () => {
      const st = await callDaemon<StateResponse>(ctl, 'GET', '/v1/state');
      const p = st.state.pending[card?.id ?? ''];
      return !p || p.state !== 'open';
    }, 10_000, 'the card to close');

    // A subagent's prompt opens a note, not a card to answer: the screen path answers its dialog.
    await sendHook(
      d.ctx.paths.hooksSock,
      {
        hook_event_name: 'PermissionRequest',
        session_id: SID,
        transcript_path: s.transcriptPath,
        cwd: s.cwd,
        permission_mode: 'default',
        agent_id: 'agent-demo-1',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'date > c.txt', description: 'Write the date' },
        _jantar: hookTag(s.pid, false, s.configDir),
      },
      false,
    ).reply;
    await open('subagent-info');
    const again = await shown(screenOf('PERM_CREATE_2'));
    then(WORKING);
    expect(await answered(again, 0)).toEqual({ outcome: 'done', dialog: null });
  });

  it('7. the keypad: moves and Enter on a screen with no buttons, refused everywhere else', async () => {
    const form = NOT_DIALOG_SCREENS.MCP_FORM as string;
    await tabs.show(TTY, form);
    const s = await read(40);
    expect(s.dialog).toBeUndefined();
    expect(s.screenKey).toMatch(/^[0-9a-f]{64}$/);
    tabs.on(TTY, {});
    let before = writes().length;
    const ok = await post('keypad', { screen: s.screenKey, lines: 40, move: 1, key: 'enter' });
    expect(ok.status, `${ok.text}\n${dumpLog()}`).toBe(200);
    const w = writes().slice(before);
    expect(w.map((x) => [x.mode, x.bytes, x.out])).toEqual([['typeif', ESC_B, 'ok']]);
    // Compare-and-type over the lines the phone was shown, the rows included.
    expect(form).toContain(w[0]?.expected ?? '\u0000');
    expect(w[0]?.expected).toContain('❯ Yes');
    const audit = d.ctx.db.audit.list({ after: 0, limit: 1000 }).filter((e) => e.action === 'sessionKeypad').at(-1);
    expect(audit?.params).toEqual({ sid: SID, move: 1, key: 'enter' });

    // A stale screen key: 409, nothing typed.
    await tabs.show(TTY, form.replace('> my notes', '> my notes and more'));
    before = writes().length;
    expect((await post('keypad', { screen: s.screenKey, lines: 40, move: 1, key: 'enter' })).status).toBe(409);
    expect(writes().length).toBe(before);

    // Refused, nothing typed: Claude's prompt box, no visible pointer, a dialog with buttons.
    for (const screen of [NOT_DIALOG_SCREENS.INTERRUPTED, NOT_DIALOG_SCREENS.IDLE_DRAFT, NOT_DIALOG_SCREENS.NO_POINTER_LIST, screenOf('Q_SINGLE')]) {
      await tabs.show(TTY, screen as string);
      const now = await read(40);
      const r = await post('keypad', { screen: now.screenKey, lines: 40, move: 0, key: 'enter' });
      expect(r.status, r.text).toBe(422);
    }
    expect(writes().length).toBe(before);
    // Escape waits for its real-Mac check (SP1); Up passed its own (SP14): one ESC[A and the Return, guarded the same way.
    await tabs.show(TTY, form);
    const again = await read(40);
    expect((await post('keypad', { screen: again.screenKey, lines: 40, move: 0, key: 'escape' })).status).toBe(422);
    expect(writes().length).toBe(before);
    const up = await post('keypad', { screen: again.screenKey, lines: 40, move: -1, key: 'enter' });
    expect(up.status, `${up.text}\n${dumpLog()}`).toBe(200);
    expect(writes().slice(before).map((x) => [x.mode, x.bytes, x.out])).toEqual([['typeif', ESC_A, 'ok']]);
  });

  it('nothing on screen reached an audit row, an event, the card history or a log line', async () => {
    const sources = {
      audit: d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      events: d.ctx.db.events.since(0),
      'card history': d.ctx.db.pending.list({ limit: 1000 }),
      logs: d.log.records,
    };
    // Flow 6 opened two cards, so the card history is not empty.
    expect(sources['card history'].length).toBeGreaterThanOrEqual(2);
    for (const [what, value] of Object.entries(sources)) {
      const text = JSON.stringify(value);
      expect(text, what).not.toContain(DIALOG_SECRET);
      expect(text, what).not.toContain(TYPED_ANSWER.slice(0, 40));
    }
  });
});
