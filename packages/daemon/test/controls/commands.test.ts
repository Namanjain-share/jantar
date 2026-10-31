/** Slash commands: through the writer with proof, and /clear proven by its SessionStart hook (C5). */
import { describe, expect, it } from 'vitest';
import type { PendingRequest, SlashCommand } from '@jantar/protocol';
import { DIALOG_REASON, WAITING_REASON } from '../../src/controls/common.js';
import { CLEAR_PROOF_MS, COMMAND_WAIT_MS, commandText } from '../../src/controls/commands.js';
import { createFakeExec, onCommand } from '../../src/core/testing.js';
import { readScreenState, screenBlocker } from '../../src/terminal/screen.js';
import { stateBlocker } from '../../src/writer/preconditions.js';
import { CLI, PID, SCREEN_SECRET, SID, T0, claudeScreen, dialogScreen, drive, makeRig, makeSession } from './helpers.js';

const NEW_SID = '99999999-9999-4999-8999-999999999999';

describe('slash commands through the writer', () => {
  it('types each allowed command as text and answers whether it was proven', async () => {
    const rig = makeRig();
    const cmds: SlashCommand[] = [
      { name: 'plan' },
      { name: 'model', args: 'opus' },
      { name: 'effort', args: 'high' },
      { name: 'compact', args: '  keep the API notes ' },
      { name: 'rewind' },
    ];
    for (const cmd of cmds) expect(await rig.controls.command(SID, cmd, CLI), cmd.name).toEqual({ ok: true, proven: true });
    expect(rig.writer.submits.map((s) => s.text)).toEqual(['/plan', '/model opus', '/effort high', '/compact keep the API notes', '/rewind']);
    expect(rig.writer.submits.every((s) => s.onDraft === 'refuse' && s.sid === SID && s.actor === CLI)).toBe(true);
    expect(rig.writer.waits.every((w) => w.timeoutMs === COMMAND_WAIT_MS)).toBe(true);
    // The writer itself presses the keys; nothing else is typed.
    expect(rig.terminal.typed).toEqual([]);
    expect(rig.terminal.pressed).toEqual([]);
  });

  it('a command still waiting for its proof answers proven: false (/compact records only when it ends)', async () => {
    const rig = makeRig();
    rig.writer.finalStage = 'enter';
    expect(await rig.controls.command(SID, { name: 'compact' }, CLI)).toEqual({ ok: true, proven: false });
  });

  it('a refused or failed send is an error with the writer reason', async () => {
    const rig = makeRig();
    rig.writer.submitResult = () => ({ ok: false, code: 'refused', reason: 'a permission card is open for this session; answer it first' });
    expect(await rig.controls.command(SID, { name: 'plan' }, CLI)).toEqual({ ok: false, code: 'refused', reason: 'a permission card is open for this session; answer it first' });
    rig.writer.submitResult = (req) => ({ ok: true, job: rig.writer.job(req, 'queued'), duplicate: false });
    rig.writer.finalStage = 'failed';
    rig.writer.finalReason = 'the prompt was not proven sent';
    expect(await rig.controls.command(SID, { name: 'plan' }, CLI)).toMatchObject({ ok: false, code: 'failed', reason: 'the prompt was not proven sent' });
  });

  it("never repeats text the writer's reason quotes: a dialog's title (screen text) or Claude's waiting word", async () => {
    const rig = makeRig();
    // The writer's own sentences, built the way it builds them.
    // screenBlocker no longer quotes the title (v0.4.2); a writer reason that did is still mapped.
    expect(screenBlocker(readScreenState(dialogScreen().replace(' Bash command', ` Edit ${SCREEN_SECRET}`)))).toBe(DIALOG_REASON);
    const dialog = `a dialog is open in the terminal: Edit ${SCREEN_SECRET}`;
    const waiting = stateBlocker(rig.ctx, rig.hooks, makeSession({ status: 'waiting', waitingFor: SCREEN_SECRET })) ?? '';
    expect(waiting).toContain(SCREEN_SECRET);

    rig.writer.submitResult = () => ({ ok: false, code: 'refused', reason: dialog });
    expect(await rig.controls.command(SID, { name: 'plan' }, CLI)).toEqual({ ok: false, code: 'refused', reason: DIALOG_REASON });
    rig.writer.submitResult = () => ({ ok: false, code: 'refused', reason: waiting });
    expect(await rig.controls.command(SID, { name: 'plan' }, CLI)).toEqual({ ok: false, code: 'refused', reason: WAITING_REASON });
    // The same once the job is under way, refused or failed.
    rig.writer.submitResult = (req) => ({ ok: true, job: rig.writer.job(req, 'queued'), duplicate: false });
    for (const stage of ['refused', 'failed'] as const) {
      rig.writer.finalStage = stage;
      rig.writer.finalReason = dialog;
      expect(await rig.controls.command(SID, { name: 'plan' }, CLI), stage).toEqual({ ok: false, code: stage, reason: DIALOG_REASON });
    }
  });

  it('a send the writer failed after its text left the box answers proven: false (Claude most likely ran it; a retry would run it twice)', async () => {
    const rig = makeRig();
    rig.writer.finalStage = 'failed';
    rig.writer.finalReason = "the prompt left the input box after 1 press of Enter, but Claude's transcript never recorded it";
    for (const name of ['plan', 'compact', 'rewind'] as const) {
      expect(await rig.controls.command(SID, { name }, CLI), name).toEqual({ ok: true, proven: false });
    }
    // Still in the box, or never typed: not sent.
    rig.writer.finalReason = "Claude didn't record the prompt after 2 presses of Enter (it may still be in the input box)";
    expect(await rig.controls.command(SID, { name: 'plan' }, CLI)).toMatchObject({ ok: false, code: 'failed' });
  });

  it('refuses anything outside the allowlist before the writer sees it', async () => {
    const rig = makeRig();
    const bad = [
      { name: 'model', args: 'gpt' },
      { name: 'effort' },
      { name: 'plan', args: 'a\u001b[201~b' },
      { name: 'clear', args: 'now' },
      { name: 'bash', args: 'rm -rf /' },
    ] as SlashCommand[];
    for (const cmd of bad) expect(await rig.controls.command(SID, cmd, CLI), JSON.stringify(cmd)).toMatchObject({ ok: false, code: 'refused' });
    expect(rig.writer.submits).toEqual([]);
  });

  it('commandText trims and joins', () => {
    expect(commandText({ name: 'model', args: 'sonnet' })).toBe('/model sonnet');
    expect(commandText({ name: 'compact', args: '   ' })).toBe('/compact');
  });
});

describe('/clear (C5)', () => {
  it('is typed under the pane lock into an empty box and proven by SessionStart source "clear" from the same Claude', async () => {
    const rig = makeRig();
    rig.terminal.onType = () => rig.hooks.emit({ hook_event_name: 'SessionStart', session_id: NEW_SID, source: 'clear' }, PID);
    expect(await drive(rig.clock, rig.controls.command(SID, { name: 'clear' }, CLI))).toEqual({ ok: true, proven: true });
    expect(rig.terminal.typed).toEqual(['/clear']);
    expect(rig.terminal.enters).toBe(0);
    // The writer refuses /clear, so it never goes there.
    expect(rig.writer.submits).toEqual([]);
    expect(rig.hooks.listening()).toBe(0);
  });

  it('counts a hook from the same session id too, and presses Enter once more if /clear still sits in the box', async () => {
    const rig = makeRig();
    rig.terminal.onType = () => (rig.terminal.screen = claudeScreen({ draft: '/clear' }));
    const enter = rig.terminal.pressEnter.bind(rig.terminal);
    rig.terminal.pressEnter = async () => {
      rig.hooks.emit({ hook_event_name: 'SessionStart', session_id: SID, source: 'clear' }, 1);
      return enter();
    };
    expect(await drive(rig.clock, rig.controls.command(SID, { name: 'clear' }, CLI))).toEqual({ ok: true, proven: true });
    expect(rig.terminal.enters).toBe(1);
    expect(rig.terminal.typed).toEqual(['/clear']);
  });

  it('counts a hook from a shim right under the same Claude (one ps call), not one under another process', async () => {
    const SHIM = 52001;
    const exec = createFakeExec(onCommand('ps', (call) => ({ stdout: call.args.at(-1) === String(SHIM) ? ` ${PID}\n` : ' 1\n' }), ['-o', 'ppid=', '-p']));
    const rig = makeRig({ ctx: { exec } });
    rig.terminal.onType = () => rig.hooks.emit({ hook_event_name: 'SessionStart', session_id: NEW_SID, source: 'clear' }, SHIM);
    expect(await drive(rig.clock, rig.controls.command(SID, { name: 'clear' }, CLI))).toEqual({ ok: true, proven: true });
    expect(exec.calls.map((c) => c.args)).toEqual([['-o', 'ppid=', '-p', String(SHIM)]]);

    const other = makeRig({ ctx: { exec } });
    other.terminal.onType = () => other.hooks.emit({ hook_event_name: 'SessionStart', session_id: NEW_SID, source: 'clear' }, 52002);
    expect(await drive(other.clock, other.controls.command(SID, { name: 'clear' }, CLI))).toEqual({ ok: true, proven: false });
    expect(other.terminal.typed).toEqual(['/clear']);
  });

  it('is not proven by another session, another source or another hook, and is never typed twice', async () => {
    const rig = makeRig();
    rig.terminal.onType = () => {
      rig.hooks.emit({ hook_event_name: 'SessionStart', session_id: NEW_SID, source: 'clear' }, 777);
      rig.hooks.emit({ hook_event_name: 'SessionStart', session_id: SID, source: 'startup' });
      rig.hooks.emit({ hook_event_name: 'UserPromptSubmit', session_id: SID, source: 'clear' });
    };
    const started = rig.clock.now();
    expect(await drive(rig.clock, rig.controls.command(SID, { name: 'clear' }, CLI))).toEqual({ ok: true, proven: false });
    expect(rig.clock.now() - started).toBeGreaterThanOrEqual(CLEAR_PROOF_MS);
    expect(rig.terminal.typed).toEqual(['/clear']);
    expect(rig.hooks.listening()).toBe(0);
  });

  it('refuses a draft, a dialog or an open card, and types nothing', async () => {
    const draft = makeRig();
    draft.terminal.screen = claudeScreen({ draft: 'my half prompt' });
    expect(await drive(draft.clock, draft.controls.command(SID, { name: 'clear' }, CLI))).toMatchObject({ ok: false, code: 'input_not_empty' });

    const dialog = makeRig();
    dialog.terminal.screen = dialogScreen();
    expect(await drive(dialog.clock, dialog.controls.command(SID, { name: 'clear' }, CLI))).toMatchObject({ ok: false, code: 'dialog_open' });

    const carded = makeRig();
    const card: PendingRequest = {
      id: '01JTESTCARD0000000000000002abc',
      sid: SID,
      kind: 'question',
      tool: 'AskUserQuestion',
      input: {},
      suggestions: [],
      correlationKey: `${SID}|AskUserQuestion|{}`,
      createdAt: T0,
      settleUntil: T0,
      state: 'open',
    };
    carded.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: card } });
    expect(await drive(carded.clock, carded.controls.command(SID, { name: 'clear' }, CLI))).toMatchObject({ ok: false, code: 'refused', reason: expect.stringMatching(/question card/) });
    for (const rig of [draft, dialog, carded]) expect(rig.terminal.typed).toEqual([]);
  });
});
