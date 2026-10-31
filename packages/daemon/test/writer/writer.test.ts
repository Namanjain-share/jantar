import { describe, expect, it } from 'vitest';
import { makeMove, makePending, queueOperation, queuedCommand, slashCommand } from '@jantar/fixtures';
import type { SendJob } from '@jantar/protocol';
import { KeyedQueue, createWriterWith } from '../../src/writer/index.js';
import {
  FakeSessions,
  FakeTerminal,
  MultiTerminal,
  PERMISSION_DIALOG,
  PID,
  PID2,
  RecordingNotifier,
  SID,
  SID2,
  TRANSCRIPT,
  TRANSCRIPT2,
  TTY2,
  START_MS,
  advance,
  flush,
  makeRig,
  userEntry,
  type WriterRig,
} from './helpers.js';

const CLI = { kind: 'cli' } as const;
const PROMPT = 'Add a logout button to the synthetic header and cover it with a test';

async function send(rig: WriterRig, text = PROMPT, extra: { idempotencyKey?: string; onDraft?: 'refuse' | 'replace'; sid?: string } = {}) {
  return rig.writer.submit({ sid: extra.sid ?? SID, text, onDraft: extra.onDraft ?? 'refuse', actor: CLI, ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}) });
}

/** Submit, drive the clock until the job is final (or `ms` passes), return the final job. */
async function sendAndRun(rig: WriterRig, text = PROMPT, ms = 40_000): Promise<SendJob> {
  const r = await send(rig, text);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  await advance(rig.clock, ms);
  const job = rig.writer.get(r.job.id);
  if (!job) throw new Error('job vanished');
  return job;
}

describe('writer: accepted proofs (gate 4)', () => {
  it('a user entry proves the send; progress goes queued -> checking -> typed -> enter -> proven', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(job.proof?.kind).toBe('user');
    expect(job.attempts).toBe(1);
    expect(rig.jobStages(job.id)).toEqual(['queued', 'checking', 'typed', 'enter', 'proven']);
    expect(rig.terminal.ops('type').map((c) => c.text)).toEqual([PROMPT]);
    // Enter 2.5 s after typing.
    const typedAt = rig.terminal.ops('type')[0]?.at as number;
    expect((rig.terminal.ops('enter')[0]?.at as number) - typedAt).toBe(2500);
  });

  it('a prompt Claude takes straight from typing is proven without any Enter', async () => {
    const rig = makeRig();
    rig.terminal.onType = () => {
      rig.transcripts.append(SID, [userEntry(rig.at(), rig.terminal.box)]);
      rig.terminal.box = '';
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(job.attempts).toBe(0);
    expect(rig.terminal.ops('enter')).toHaveLength(0);
  });

  it('a queued_command attachment proves a prompt typed while Claude works', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    rig.takeOnEnter(2, (box, at) => queuedCommand(at, box));
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(job.proof?.kind).toBe('queued_command');
    expect(job.attempts).toBe(2);
  });

  it('a queue-operation enqueue proves it once Claude takes it from the queue', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    rig.takeOnEnter(1, (box, at) => queueOperation(at, 'enqueue', box));
    const r = await send(rig);
    if (!r.ok) throw new Error(r.reason);
    await advance(rig.clock, 20_000);
    // Queued, not yet taken: not final, and no further Enter (the box is empty or the user's).
    expect(rig.writer.get(r.job.id)?.stage).toBe('enter');
    expect(rig.terminal.ops('enter')).toHaveLength(1);
    rig.transcripts.append(SID, [queueOperation(rig.at(), 'remove')]);
    await advance(rig.clock, 1000);
    const job = rig.writer.get(r.job.id);
    expect(job?.stage).toBe('proven');
    expect(job?.proof?.kind).toBe('queue-operation');
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });

  it('a slash command is proven in its <command-name> form', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1, (_box, at) => slashCommand(at, '/compact', 'keep the API notes'));
    const job = await sendAndRun(rig, '/compact keep the API notes');
    expect(job.stage).toBe('proven');
    expect(job.proof?.kind).toBe('user');
  });

  it("a merged draft is proof, flagged proven-merged (Terminal.app can't tell a draft from a suggestion)", async () => {
    const rig = makeRig();
    rig.terminal.box = 'half typed idea ';
    rig.takeOnEnter(1);
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven-merged');
    expect(job.reason).toMatch(/already in the input box went out with it/);
  });
});

describe('writer: rejected proofs (gate 4)', () => {
  it('a prefix-only match is not proof: failed (and no Enter once the box is empty)', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1, (box, at) => userEntry(at, box.slice(0, 40)));
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.reason).toMatch(/only the beginning/);
  });

  it('an earlier identical prompt (before the recorded offset) is not proof', async () => {
    const rig = makeRig({ history: (at) => [userEntry(at, PROMPT)] });
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.attempts).toBe(12);
    expect(job.reason).toMatch(/didn't record the prompt after 12 presses of Enter/);
  });

  it('an identical prompt written after the offset but timestamped before typing - 5 s is not proof', async () => {
    const rig = makeRig();
    const old = { ...rig.at(), at: new Date(Date.parse(rig.at().at) - 60_000).toISOString() };
    rig.takeOnEnter(1, () => userEntry(old, PROMPT));
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
  });

  it('the screen is never proof: the prompt showing as sent on screen does not count', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n !== 1) return;
      rig.terminal.history.push(`> ${rig.terminal.box}`, '⏺ Working on it.');
      rig.terminal.box = '';
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
  });

  it('slash commands get at most 2 Enters', async () => {
    const rig = makeRig();
    const job = await sendAndRun(rig, '/cost');
    expect(job.stage).toBe('failed');
    expect(rig.terminal.ops('enter')).toHaveLength(2);
  });

  it('Enter goes every 2.5 s, at most 12 times, then the job fails', async () => {
    const rig = makeRig();
    const job = await sendAndRun(rig);
    const typedAt = rig.terminal.ops('type')[0]?.at as number;
    expect(rig.terminal.ops('enter').map((c) => c.at - typedAt)).toEqual(Array.from({ length: 12 }, (_, i) => 2500 * (i + 1)));
    expect(Date.parse(job.updatedAt) - typedAt).toBe(2500 * 13);
  });
});

describe('writer: stops before an Enter that would be wrong', () => {
  it('a dialog appearing mid-send stops Enter at once', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n === 1) rig.terminal.dialog = PERMISSION_DIALOG;
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/a dialog is open in the terminal; answer it/);
    expect(job.reason).not.toMatch(/Bash command/);
    expect(job.reason).toMatch(/Enter was not pressed/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
    expect(rig.terminal.ops('clear')).toHaveLength(0);
  });

  it('the session starting to wait mid-send stops Enter', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = () => {
      rig.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'waiting', waitingFor: 'permission' } } });
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/waiting for an answer \(permission\)/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });

  it('a card opening mid-send stops Enter', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = () => {
      rig.hooks.cards = [makePending({ sid: SID, kind: 'question', tool: 'AskUserQuestion' })];
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/question card is open/);
  });

  it('claude leaving the foreground mid-send stops Enter (Enter would run the text in a shell)', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = () => {
      rig.terminal.foreground = 'shell';
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/foreground program in its terminal tab \(shell\)/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });

  it('a proof that lands just as a dialog appears still counts', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n !== 1) return;
      rig.transcripts.appendRaw(SID, ''); // nothing yet
      rig.terminal.dialog = PERMISSION_DIALOG; // Claude took the prompt and immediately asked for a tool
      rig.transcripts.append(SID, [userEntry(rig.at(), rig.terminal.box)]);
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
  });
});

describe('writer: failure alert (gate 4)', () => {
  it('pushes "Prompt NOT sent" within 1 s of giving up, before the input box is cleaned up', async () => {
    const rig = makeRig({ writer: {} });
    const notifier = new RecordingNotifier(rig.clock);
    const writer = createWriterWith(
      rig.ctx,
      { sessions: new FakeSessions(), terminal: rig.terminal, transcripts: rig.transcripts, hooks: rig.hooks, ccwLegacy: rig.ccw },
      { notifiers: [notifier] },
    );
    rig.terminal.clearDelayMs = 5000;
    const r = await writer.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI });
    expect(r.ok).toBe(true);
    let failedAt = -1;
    rig.ctx.store.subscribe((ev) => {
      if (ev.type === 'send.progress' && ev.data.job.stage === 'failed') failedAt = rig.clock.now();
    });
    await advance(rig.clock, 45_000);
    const typedAt = rig.terminal.ops('type')[0]?.at as number;
    const gaveUpAt = typedAt + 2500 * 13; // after the 12th Enter's wait
    expect(failedAt).toBeGreaterThanOrEqual(gaveUpAt);
    expect(failedAt - gaveUpAt).toBeLessThan(1000);
    expect(notifier.sent).toHaveLength(1);
    expect((notifier.sent[0]?.at as number) - gaveUpAt).toBeLessThan(1000);
    expect(notifier.sent[0]?.n.kind).toBe('send-failed');
    expect(notifier.sent[0]?.n.title).toBe('Not delivered to alpha-app');
    expect(notifier.sent[0]?.n.url).toContain(`/s/${SID}`);
    // The cleanup (Ctrl-U, here slow) only starts after the alert went out.
    const clear = rig.terminal.ops('clear')[0];
    expect(clear?.at).toBeGreaterThanOrEqual(failedAt);
    expect(rig.terminal.box).toBe('');
  });

  it('a job refused after it was accepted alerts too; an immediate refusal is only returned', async () => {
    const rig = makeRig();
    const notifier = new RecordingNotifier(rig.clock);
    const writer = createWriterWith(
      rig.ctx,
      { sessions: new FakeSessions(), terminal: rig.terminal, transcripts: rig.transcripts, hooks: rig.hooks, ccwLegacy: rig.ccw },
      { notifiers: [notifier] },
    );
    rig.terminal.foreground = 'shell';
    const r = await writer.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI });
    expect(r.ok).toBe(true);
    await advance(rig.clock, 1000);
    expect(writer.get(r.ok ? r.job.id : '')?.stage).toBe('refused');
    expect(notifier.sent).toHaveLength(1);

    rig.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'waiting' } } });
    const before = rig.progress.length;
    const r2 = await writer.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI });
    expect(r2.ok).toBe(false);
    expect(rig.progress.length).toBe(before);
    expect(notifier.sent).toHaveLength(1);
  });
});

describe('writer: preconditions refuse without typing', () => {
  async function refusedAsync(rig: WriterRig): Promise<SendJob> {
    const r = await send(rig);
    expect(r.ok).toBe(true);
    await advance(rig.clock, 2000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('refused');
    expect(rig.terminal.ops('type')).toHaveLength(0);
    expect(rig.terminal.ops('enter')).toHaveLength(0);
    return job;
  }

  it('the pid is dead', async () => {
    const rig = makeRig();
    rig.probe.alive.delete(PID);
    expect((await refusedAsync(rig)).reason).toMatch(/process has exited/);
  });

  it('the pid was reused (procStart does not match ps)', async () => {
    const rig = makeRig();
    rig.starts[PID] = START_MS + 3600_000;
    expect((await refusedAsync(rig)).reason).toMatch(/pid now belongs to another process/);
  });

  it('claude is not the foreground program', async () => {
    const rig = makeRig();
    rig.terminal.foreground = 'shell';
    expect((await refusedAsync(rig)).reason).toMatch(/\(shell\)/);
  });

  it('the screen cannot be read (never type blind)', async () => {
    const rig = makeRig();
    rig.terminal.screenReadable = false;
    expect((await refusedAsync(rig)).reason).toMatch(/screen couldn't be read/);
  });

  it("Claude's input box is not on screen", async () => {
    const rig = makeRig();
    rig.terminal.screenOverride = ['⏺ Some output', '  more output'].join('\n');
    expect((await refusedAsync(rig)).reason).toMatch(/input box isn't on screen/);
  });

  it('a dialog is on screen', async () => {
    const rig = makeRig();
    rig.terminal.dialog = PERMISSION_DIALOG;
    const reason = (await refusedAsync(rig)).reason;
    expect(reason).toMatch(/a dialog is open in the terminal; answer it/);
    expect(reason).not.toMatch(/Bash command/);
  });

  it('the session file is gone by the time the job runs', async () => {
    const rig = makeRig();
    const r = await send(rig);
    rig.ctx.store.emit({ type: 'session.removed', sid: SID, data: { reason: 'ended' } });
    await advance(rig.clock, 1000);
    expect(rig.writer.get(r.ok ? r.job.id : '')?.reason).toMatch(/no longer running/);
  });

  it.each([
    ['waiting', { status: 'waiting' as const, waitingFor: 'permission' }, /waiting for an answer/],
    ['ended', { status: 'ended' as const }, /has ended/],
    ['a ccw move on the session', { move: makeMove({ sid: SID, step: 'restarting' }) }, /ccw is moving this session \(restarting\)/],
  ])('refuses at once when %s', async (_name, patch, re) => {
    const rig = makeRig();
    rig.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch } });
    const r = await send(rig);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('refused');
      expect(r.reason).toMatch(re);
      expect(r.job?.stage).toBe('refused');
    }
    expect(rig.progress).toHaveLength(0);
    expect(rig.terminal.ops('find')).toHaveLength(0);
  });

  it('refuses at once with an open card (store or hooks bridge)', async () => {
    const rig = makeRig();
    rig.ctx.store.emit({ type: 'pending.opened', sid: SID, data: { pending: makePending({ sid: SID }) } });
    const r = await send(rig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/permission card is open/);

    const rig2 = makeRig();
    rig2.hooks.cards = [makePending({ sid: SID, kind: 'subagent-info', agentId: 'agent-1' })];
    const r2 = await send(rig2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/subagent card is open/);
  });

  it.each(['saving', 'restarting', 'continuing'] as const)('refuses while a ccw move is %s', async (step) => {
    const rig = makeRig();
    rig.ccw.moveMap.set(SID, makeMove({ sid: SID, step }));
    const r = await send(rig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(`ccw is moving this session (${step})`);
  });

  it("refuses while ccw holds the session's move lock", async () => {
    const rig = makeRig();
    rig.ccw.locked.add(SID);
    const r = await send(rig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/move lock/);
  });

  it("refuses when ccw's move state can't be read; ignores ccw when it isn't installed", async () => {
    const rig = makeRig();
    rig.ccw.throwOnMove = true;
    const r = await send(rig);
    expect(r.ok).toBe(false);
    rig.ccw.isPresent = false;
    rig.takeOnEnter(1);
    const r2 = await send(rig);
    expect(r2.ok).toBe(true);
  });

  it('a parked session is sent to, with a note that the prompt un-parks it', async () => {
    const rig = makeRig();
    rig.ccw.moveMap.set(SID, makeMove({ sid: SID, step: 'parked' }));
    rig.takeOnEnter(1);
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(job.reason).toMatch(/un-parks it/);
  });

  it('no terminal tab, unknown session, bad text', async () => {
    const rig = makeRig();
    rig.terminal.paneFound = false;
    const r = await send(rig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no terminal tab found for this session \(that Terminal tab is no longer open\)/);

    const r2 = await send(rig, PROMPT, { sid: '99999999-9999-4999-8999-999999999999' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('not_found');
    // an Object.prototype member is no session either
    for (const sid of ['constructor', '__proto__', 'toString']) {
      const r = await send(rig, PROMPT, { sid });
      expect(r.ok, sid).toBe(false);
      if (!r.ok) expect(r.code, sid).toBe('not_found');
    }

    for (const bad of ['   ', 'escape \u001b[201~ me']) {
      const r3 = await send(rig, bad);
      expect(r3.ok).toBe(false);
    }
    expect(rig.terminal.ops('type')).toHaveLength(0);
  });
});

describe('writer: drafts and never typing twice', () => {
  it("re-sending text that is still in the box from a failed try presses Enter only", async () => {
    const rig = makeRig();
    rig.terminal.clearWorks = false; // the box keeps our text after the failure
    const first = await sendAndRun(rig);
    expect(first.stage).toBe('failed');
    expect(rig.terminal.box).toBe(PROMPT);

    rig.takeOnEnter(rig.terminal.enters + 1);
    const second = await sendAndRun(rig);
    expect(second.stage).toBe('proven');
    expect(second.reason).toMatch(/only Enter was pressed/);
    expect(rig.terminal.ops('type')).toHaveLength(1);
  });

  it('refuses when an earlier unproven prompt of ours is still in the box and a different one is sent', async () => {
    const rig = makeRig();
    rig.terminal.clearWorks = false;
    await sendAndRun(rig);
    const r = await send(rig, 'a completely different request');
    expect(r.ok).toBe(true);
    await advance(rig.clock, 1000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('refused');
    expect(job.reason).toMatch(/earlier prompt that was never proven sent/);
    expect(rig.terminal.ops('type')).toHaveLength(1);
  });

  it("a short suggestion in the box after an earlier failure isn't mistaken for the leftover", async () => {
    const rig = makeRig();
    rig.terminal.clearWorks = false;
    await sendAndRun(rig);
    rig.terminal.box = 'header'; // e.g. Claude's grey suggestion, a word that occurs in the earlier prompt
    rig.takeOnEnter(rig.terminal.enters + 1);
    const job = await sendAndRun(rig, 'now write the changelog entry');
    expect(job.stage).toBe('proven-merged');
  });

  it('after a failure, Ctrl-U clears the box only when it shows exactly our text', async () => {
    const rig = makeRig();
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(rig.terminal.ops('clear')).toHaveLength(1);
    expect(rig.terminal.box).toBe('');

    const merged = makeRig();
    merged.terminal.box = 'some draft ';
    await sendAndRun(merged);
    expect(merged.terminal.ops('clear')).toHaveLength(0);
  });

  it("after a failure, the box is left alone while Claude's vim mode is out of INSERT (End does nothing there)", async () => {
    for (const vim of ['NORMAL', 'VISUAL']) {
      const rig = makeRig();
      rig.terminal.vim = vim;
      expect((await sendAndRun(rig)).stage, vim).toBe('failed');
      expect(rig.terminal.ops('clear'), vim).toHaveLength(0);
      expect(rig.terminal.box).toBe(PROMPT);
    }
    const insert = makeRig();
    insert.terminal.vim = 'INSERT';
    expect((await sendAndRun(insert)).stage).toBe('failed');
    expect(insert.terminal.ops('clear')).toHaveLength(1);
    expect(insert.terminal.box).toBe('');
  });

  it('a styled backend refuses a real draft unless onDraft is "replace"', async () => {
    const rig = makeRig();
    rig.terminal.styled = true;
    rig.terminal.box = 'my own draft';
    const r = await send(rig);
    await advance(rig.clock, 1000);
    expect(rig.writer.get(r.ok ? r.job.id : '')?.reason).toMatch(/unsent draft/);

    rig.takeOnEnter(1);
    const r2 = await send(rig, PROMPT, { onDraft: 'replace' });
    await advance(rig.clock, 10_000);
    const job = rig.writer.get(r2.ok ? r2.job.id : '') as SendJob;
    expect(job.stage).toBe('proven');
    expect(job.reason).toMatch(/draft that was in the input box was replaced/);
    const ops = rig.terminal.calls.map((c) => c.op).filter((op) => op === 'clear' || op === 'type');
    expect(ops).toEqual(['clear', 'type']);
  });

  it('multi-line text is typed as one piece and proven whole', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const text = 'first line\nsecond line\n\tindented';
    const job = await sendAndRun(rig, text);
    expect(job.stage).toBe('proven');
    expect(rig.terminal.ops('type')[0]?.text).toBe(text);
  });
});

describe('writer: queue and idempotency', () => {
  it('two prompts to one pane never interleave: the second starts after the first is proven', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = () => {
      rig.transcripts.append(SID, [userEntry(rig.at(), rig.terminal.box)]);
      rig.terminal.box = '';
    };
    const a = await send(rig, 'first prompt for the queue');
    const b = await send(rig, 'second prompt for the queue');
    expect(a.ok && b.ok).toBe(true);
    await advance(rig.clock, 20_000);
    const ja = rig.writer.get(a.ok ? a.job.id : '') as SendJob;
    const jb = rig.writer.get(b.ok ? b.job.id : '') as SendJob;
    expect(ja.stage).toBe('proven');
    expect(jb.stage).toBe('proven');
    const types = rig.terminal.ops('type');
    expect(types.map((c) => c.text)).toEqual(['first prompt for the queue', 'second prompt for the queue']);
    const bChecking = rig.progress.find((j) => j.id === jb.id && j.stage === 'checking');
    expect(Date.parse(bChecking?.updatedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(ja.updatedAt));
  });

  it('different panes run side by side', async () => {
    const rig = makeRig();
    const t2 = new FakeTerminal(rig.clock, TTY2);
    const terminal = new MultiTerminal({ [rig.terminal.tty]: rig.terminal, [TTY2]: t2 });
    rig.ctx.store.emit({
      type: 'session.added',
      sid: SID2,
      data: { session: rig.session({ sid: SID2, pid: PID2, procStart: 'Thu Jan 15 09:01:00 2026', tty: TTY2, folder: 'bravo-api' }) },
    });
    const transcripts = rig.transcripts;
    transcripts.create(SID2, TRANSCRIPT2, []);
    const writer = createWriterWith(rig.ctx, { sessions: new FakeSessions(), terminal, transcripts, hooks: rig.hooks, ccwLegacy: rig.ccw });
    rig.terminal.onEnter = () => transcripts.append(SID, [userEntry(rig.at(), rig.terminal.box)]);
    t2.onEnter = () => transcripts.append(SID2, [userEntry({ ...rig.at(), sessionId: SID2 }, t2.box)]);
    const a = await writer.submit({ sid: SID, text: 'prompt for pane one', onDraft: 'refuse', actor: CLI });
    const b = await writer.submit({ sid: SID2, text: 'prompt for pane two', onDraft: 'refuse', actor: CLI });
    await advance(rig.clock, 10_000);
    expect(writer.get(a.ok ? a.job.id : '')?.stage).toBe('proven');
    expect(writer.get(b.ok ? b.job.id : '')?.stage).toBe('proven');
    // Both were typed at the same moment: panes don't share a lock.
    expect(rig.terminal.ops('type')[0]?.at).toBe(t2.ops('type')[0]?.at);
  });

  it('the same Idempotency-Key returns the same job and types once', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const a = await send(rig, PROMPT, { idempotencyKey: 'phone-retry-1' });
    const b = await send(rig, PROMPT, { idempotencyKey: 'phone-retry-1' });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.duplicate).toBe(true);
      expect(b.job.id).toBe(a.job.id);
    }
    await advance(rig.clock, 10_000);
    const c = await send(rig, PROMPT, { idempotencyKey: 'phone-retry-1' });
    expect(c.ok && c.job.stage).toBe('proven');
    expect(rig.terminal.ops('type')).toHaveLength(1);

    const d = await send(rig, 'something else', { idempotencyKey: 'phone-retry-1' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/already used for a different prompt/);
  });

  it('idempotency keys survive a restart (kept in the db)', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const a = await send(rig, PROMPT, { idempotencyKey: 'k-restart' });
    await advance(rig.clock, 10_000);
    const again = createWriterWith(rig.ctx, {
      sessions: new FakeSessions(),
      terminal: rig.terminal,
      transcripts: rig.transcripts,
      hooks: rig.hooks,
      ccwLegacy: rig.ccw,
    });
    await again.start();
    const b = await again.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI, idempotencyKey: 'k-restart' });
    expect(b.ok && b.duplicate).toBe(true);
    if (a.ok && b.ok) expect(b.job.id).toBe(a.job.id);
    expect(rig.terminal.ops('type')).toHaveLength(1);
  });

  it('wait() resolves at the final stage, or with the job as it stands on timeout', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const r = await send(rig);
    const id = r.ok ? r.job.id : '';
    const early = rig.writer.wait(id, 1000);
    const final = rig.writer.wait(id);
    await advance(rig.clock, 1500);
    expect((await early)?.stage).not.toBe('proven');
    await advance(rig.clock, 5000);
    expect((await final)?.stage).toBe('proven');
    expect(await rig.writer.wait('no-such-job')).toBeUndefined();
  });

  it('stop() ends a running job as failed and says why', async () => {
    const rig = makeRig();
    const r = await send(rig);
    await advance(rig.clock, 6000);
    await rig.writer.stop();
    await flush();
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/daemon stopped/);
    const r2 = await send(rig);
    expect(r2.ok).toBe(false);
  });
});

describe('writer: transcripts', () => {
  it('a brand-new session whose transcript appears with the prompt is proven (timestamps decide)', async () => {
    const rig = makeRig({ noTranscript: true });
    rig.takeOnEnter(1);
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
  });

  it('...but an old identical prompt in a transcript that only shows up later is not proof', async () => {
    const rig = makeRig({ noTranscript: true });
    const old = { ...rig.at(), at: '2026-01-15T09:30:00.000Z' };
    rig.terminal.onEnter = (n) => {
      if (n === 1) rig.transcripts.files.set(TRANSCRIPT, `${JSON.stringify(userEntry(old, PROMPT))}\n`);
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
  });

  it('a half-written last line is read once it is complete', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      const line = JSON.stringify(userEntry(rig.at(), PROMPT));
      if (n === 1) rig.transcripts.appendRaw(SID, line.slice(0, 20));
      if (n === 2) rig.transcripts.appendRaw(SID, `${line.slice(20)}\n`);
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(job.attempts).toBe(2);
  });
});

describe('writer: no prompt text leaves the writer', () => {
  it('events, logs, the audit log and the db never hold the prompt', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1);
    const secret = 'synthetic secret prompt text 4f2a9c';
    const ok = await sendAndRun(rig, secret);
    expect(ok.stage).toBe('proven');
    const bad = makeRig();
    const failed = await sendAndRun(bad, secret);
    expect(failed.stage).toBe('failed');
    for (const r of [rig, bad]) {
      const dump = [
        ...r.rawEvents,
        JSON.stringify(r.ctx.log.records),
        JSON.stringify(r.ctx.db.audit.list({ limit: 1000 })),
        JSON.stringify(r.ctx.db.kv.get('writer.idempotency.v1') ?? null),
      ].join('\n');
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain('4f2a9c');
    }
    const audit = rig.ctx.db.audit.list({ limit: 10 });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'cli', action: 'session.prompt', target: SID, result: 'ok' });
    expect((audit[0]?.params as { proof?: { kind: string } }).proof?.kind).toBe('user');
    expect(bad.ctx.db.audit.list({ limit: 10 })[0]?.result).toBe('failed');
  });

  it('immediate refusals are audited', async () => {
    const rig = makeRig({ session: { status: 'waiting' } });
    await send(rig);
    expect(rig.ctx.db.audit.list({ limit: 10 })[0]).toMatchObject({ result: 'refused', action: 'session.prompt' });
  });
});

describe('KeyedQueue', () => {
  it('runs tasks on one key in order, one at a time, and keys independently', async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = q.run('p1', async () => {
      log.push('a start');
      await gate;
      log.push('a end');
    });
    const b = q.run('p1', async () => {
      log.push('b');
      throw new Error('b fails');
    });
    const c = q.run('p1', async () => log.push('c'));
    const other = q.run('p2', async () => log.push('other'));
    await other;
    expect(log).toEqual(['a start', 'other']);
    release();
    await a;
    await expect(b).rejects.toThrow('b fails');
    await c;
    expect(log).toEqual(['a start', 'other', 'a end', 'b', 'c']);
    await flush();
    expect(q.busy()).toEqual([]);
  });
});

describe('writer: Enter only while the box holds exactly our text (W1)', () => {
  it("a draft the user types after Claude took the prompt is never submitted", async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n !== 1) return;
      // Claude takes the prompt without a transcript entry proof matches, then the user starts typing.
      rig.terminal.box = 'my own half typed thought';
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/no longer holds just this prompt/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
    expect(rig.terminal.ops('clear')).toHaveLength(0);
    expect(rig.terminal.box).toBe('my own half typed thought');
  });

  it('once our text has left the box no more Enters are pressed; proof is still waited for', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n === 1) rig.terminal.box = '';
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.reason).toMatch(/left the input box/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
    const typedAt = rig.terminal.ops('type')[0]?.at as number;
    expect(Date.parse(job.updatedAt) - typedAt).toBe(2500 * 13);

    const late = makeRig();
    late.terminal.onEnter = (n) => {
      if (n === 1) late.terminal.box = '';
    };
    const r = await send(late);
    await advance(late.clock, 12_000);
    late.transcripts.append(SID, [userEntry(late.at(), PROMPT)]);
    await advance(late.clock, 2000);
    const proven = late.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(proven.stage).toBe('proven');
    expect(late.terminal.ops('enter')).toHaveLength(1);
  });

  it("a merged draft or Claude's collapsed paste still counts as our text", async () => {
    const rig = makeRig();
    rig.terminal.box = 'half typed idea ';
    rig.takeOnEnter(2);
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven-merged');
    expect(rig.terminal.ops('enter')).toHaveLength(2);

    const paste = makeRig();
    const text = 'first line\nsecond line\nthird line';
    paste.terminal.onType = () => {
      paste.terminal.box = '[Pasted text #1 +2 lines]';
    };
    paste.takeOnEnter(2, (_box, at) => userEntry(at, text));
    const pj = await sendAndRun(paste, text);
    expect(pj.stage).toBe('proven');
    expect(paste.terminal.ops('enter')).toHaveLength(2);
  });

  it('a prompt that wraps mid-word on screen is still recognised', async () => {
    const rig = makeRig();
    rig.terminal.onType = (text) => {
      rig.terminal.box = `${text.slice(0, 33)}\n${text.slice(33)}`; // the screen wraps inside "header"
    };
    rig.takeOnEnter(2, (_box, at) => userEntry(at, PROMPT));
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(rig.terminal.ops('enter')).toHaveLength(2);
  });
});

describe('writer: nothing changes unchecked between the last look and typing (W2)', () => {
  it('a card and a dialog that open right after the box read stop the typing', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    const read = rig.terminal.readInputBox.bind(rig.terminal);
    rig.terminal.readInputBox = async (p) => {
      const r = await read(p);
      rig.hooks.cards = [makePending({ sid: SID })];
      rig.terminal.dialog = PERMISSION_DIALOG;
      return r;
    };
    const r = await send(rig);
    expect(r.ok).toBe(true);
    await advance(rig.clock, 2000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('refused');
    expect(job.reason).toMatch(/permission card is open/);
    expect(rig.terminal.ops('type')).toHaveLength(0);
    expect(rig.terminal.ops('enter')).toHaveLength(0);
  });

  it('the transcript offset is recorded before the box is read, so the box read is the last look before typing', async () => {
    const rig = makeRig();
    const order: string[] = [];
    const size = rig.transcripts.size.bind(rig.transcripts);
    rig.transcripts.size = async (p) => {
      order.push('size');
      return size(p);
    };
    const read = rig.terminal.readInputBox.bind(rig.terminal);
    rig.terminal.readInputBox = async (p) => {
      order.push('box');
      return read(p);
    };
    rig.terminal.onType = () => order.push('type');
    rig.takeOnEnter(1);
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    const typeAt = order.indexOf('type');
    expect(order.slice(0, typeAt)).toEqual(['size', 'box']);
  });
});

describe('writer: never typing twice without memory (W3)', () => {
  it('after a restart, our unproven prompt still in the box gets Enter only, never a second copy', async () => {
    const rig = makeRig();
    const r = await send(rig);
    await advance(rig.clock, 6000);
    await rig.writer.stop();
    await flush();
    expect(rig.writer.get(r.ok ? r.job.id : '')?.stage).toBe('failed');
    expect(rig.terminal.box).toBe(PROMPT);

    const again = createWriterWith(rig.ctx, {
      sessions: new FakeSessions(),
      terminal: rig.terminal,
      transcripts: rig.transcripts,
      hooks: rig.hooks,
      ccwLegacy: rig.ccw,
    });
    await again.start();
    rig.takeOnEnter(rig.terminal.enters + 1);
    const r2 = await again.submit({ sid: SID, text: PROMPT, onDraft: 'refuse', actor: CLI });
    await advance(rig.clock, 10_000);
    const job = again.get(r2.ok ? r2.job.id : '') as SendJob;
    expect(job.stage).toBe('proven');
    expect(job.reason).toMatch(/only Enter was pressed/);
    expect(rig.terminal.ops('type')).toHaveLength(1);
  });

  it('refuses, with no memory, when the box holds our prompt together with other text', async () => {
    const rig = makeRig();
    rig.terminal.box = `${PROMPT} and a note`;
    const r = await send(rig);
    await advance(rig.clock, 1000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('refused');
    expect(job.reason).toMatch(/already holds this prompt/);
    expect(rig.terminal.ops('type')).toHaveLength(0);
  });

  it('a recorded prompt that is our prompt twice is flagged as a double send, not plain proof', async () => {
    const rig = makeRig();
    rig.takeOnEnter(1, (_box, at) => userEntry(at, `${PROMPT} ${PROMPT}`));
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven-merged');
    expect(job.reason).toMatch(/went out twice/);
  });
});

describe('writer: slash commands whose proof comes late (W5)', () => {
  it("/compact is proven when its entry lands after compaction, without more Enters", async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n === 1) {
        rig.terminal.box = '';
        rig.ctx.store.emit({ type: 'session.updated', sid: SID, data: { patch: { status: 'compacting' } } });
      }
    };
    const typedAt = { at: '' };
    rig.terminal.onType = () => {
      typedAt.at = rig.clock.iso();
    };
    const r = await send(rig, '/compact');
    await advance(rig.clock, 60_000, 500);
    expect(rig.writer.get(r.ok ? r.job.id : '')?.stage).toBe('enter');
    // Claude appends the command entry once compaction is done, stamped with the time it was typed.
    rig.transcripts.append(SID, [slashCommand({ ...rig.at(), at: typedAt.at }, '/compact')]);
    await advance(rig.clock, 2000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('proven');
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });

  it('/compact that left the box but never shows up fails only after the longer wait', async () => {
    const rig = makeRig();
    rig.terminal.onEnter = (n) => {
      if (n === 1) rig.terminal.box = '';
    };
    const r = await send(rig, '/compact');
    await advance(rig.clock, 60_000, 500);
    expect(rig.writer.get(r.ok ? r.job.id : '')?.stage).toBe('enter');
    await advance(rig.clock, 300_000, 1000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/left the input box after 1 press of Enter/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });

  it('/compact still in the box after its 2 Enters fails at the usual time', async () => {
    const rig = makeRig();
    const job = await sendAndRun(rig, '/compact');
    expect(job.stage).toBe('failed');
    expect(rig.terminal.ops('enter')).toHaveLength(2);
  });

  it('collapsed pasted text in the box is refused when nothing is remembered (it may be an earlier copy)', async () => {
    const rig = makeRig();
    rig.terminal.box = '[Pasted text #1 +2 lines]';
    const r = await send(rig, 'first line\nsecond line\nthird line');
    await advance(rig.clock, 1000);
    const job = rig.writer.get(r.ok ? r.job.id : '') as SendJob;
    expect(job.stage).toBe('refused');
    expect(job.reason).toMatch(/collapsed pasted text/);
    expect(rig.terminal.ops('type')).toHaveLength(0);
  });
});

describe('writer: prompts that can never be proven sent', () => {
  it.each(['/clear', '/clear now', '/reset', '/new'])('refuses %s (it starts a new transcript, so it could never be proven)', async (text) => {
    const rig = makeRig();
    const r = await send(rig, text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/new transcript/);
    expect(rig.terminal.ops('type')).toHaveLength(0);
  });
});

describe("writer: '!' prompts (W6)", () => {
  it("refuses a prompt that starts with '!' (Claude would run it as a shell command)", async () => {
    const rig = makeRig();
    const r = await send(rig, '!git push origin main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/shell command/);
    expect(rig.terminal.ops('type')).toHaveLength(0);
    // A '!' later in the text is just text.
    rig.takeOnEnter(1);
    const job = await sendAndRun(rig, 'ship it!');
    expect(job.stage).toBe('proven');
  });
});

/** A queue-operation Claude writes when the queue is put back into the input box (Esc or Up at the Mac). */
function popAll(at: ReturnType<WriterRig['at']>, content?: string) {
  return { ...queueOperation(at, 'remove', content), operation: 'popAll' };
}

describe('writer: a queued prompt popped back unsent is not proven (W9)', () => {
  it('enqueue, then Esc at the Mac puts it back in the box: failed, no more Enters, the box is left alone', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    rig.takeOnEnter(1, (box, at) => queueOperation(at, 'enqueue', box));
    const r = await send(rig);
    if (!r.ok) throw new Error(r.reason);
    await advance(rig.clock, 8000);
    // The user presses Esc: Claude stops and the queued text is back in the input box.
    rig.transcripts.append(SID, [popAll(rig.at())]);
    rig.terminal.box = PROMPT;
    await advance(rig.clock, 40_000);
    const job = rig.writer.get(r.job.id);
    expect(job?.stage).toBe('failed');
    expect(job?.reason).toMatch(/put back into the input box/);
    expect(job?.proof).toBeUndefined();
    // Never an Enter for text the user deliberately pulled back, and never a Ctrl-U of it.
    expect(rig.terminal.ops('enter')).toHaveLength(1);
    expect(rig.terminal.ops('clear')).toHaveLength(0);
    expect(rig.terminal.box).toBe(PROMPT);
  });

  it('enqueue, then a queued_command attachment: proven by that attachment', async () => {
    const rig = makeRig({ session: { status: 'working' } });
    rig.takeOnEnter(1, (box, at) => queueOperation(at, 'enqueue', box));
    const r = await send(rig);
    if (!r.ok) throw new Error(r.reason);
    await advance(rig.clock, 6000);
    rig.transcripts.append(SID, [queuedCommand(rig.at(), PROMPT)]);
    await advance(rig.clock, 1000);
    expect(rig.writer.get(r.job.id)?.stage).toBe('proven');
    expect(rig.writer.get(r.job.id)?.proof?.kind).toBe('queued_command');
  });

  it('still waiting in the queue when the watch ends: proven, and the reason says it is queued', async () => {
    const rig = makeRig({ session: { status: 'working' }, writer: { queuedProofMs: 60_000 } });
    rig.takeOnEnter(1, (box, at) => queueOperation(at, 'enqueue', box));
    const r = await send(rig);
    if (!r.ok) throw new Error(r.reason);
    await advance(rig.clock, 50_000);
    expect(rig.writer.get(r.job.id)?.stage).toBe('enter');
    await advance(rig.clock, 20_000);
    const job = rig.writer.get(r.job.id);
    expect(job?.stage).toBe('proven');
    expect(job?.proof?.kind).toBe('queue-operation');
    expect(job?.reason).toMatch(/still waiting in Claude's queue/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });
});

describe('writer: a typing or Enter error still looks for proof (W7)', () => {
  it('typing times out but Terminal delivers the keys a second later: proven, with no Enter', async () => {
    const rig = makeRig();
    rig.terminal.type = async (_pane, text) => {
      rig.terminal.calls.push({ op: 'type', at: rig.clock.now(), tty: rig.terminal.tty, text });
      // osascript gave up waiting; Terminal runs the "do script" anyway, a moment later.
      rig.clock.setTimeout(() => rig.transcripts.append(SID, [userEntry(rig.at(), text)]), 1000);
      return { ok: false, code: 'timeout', reason: 'Terminal did not answer in time' };
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(job.proof?.kind).toBe('user');
    expect(rig.terminal.ops('enter')).toHaveLength(0);
  });

  it('typing times out and nothing arrives: failed only after the proof window, never an Enter, and not a definite "not sent"', async () => {
    const rig = makeRig();
    rig.terminal.type = async (_pane, text) => {
      rig.terminal.calls.push({ op: 'type', at: rig.clock.now(), tty: rig.terminal.tty, text });
      return { ok: false, code: 'timeout', reason: 'Terminal did not answer in time' };
    };
    const r = await send(rig);
    if (!r.ok) throw new Error(r.reason);
    let failedAt = -1;
    rig.ctx.store.subscribe((ev) => {
      if (ev.type === 'send.progress' && ev.data.job.stage === 'failed') failedAt = rig.clock.now();
    });
    await advance(rig.clock, 45_000);
    const job = rig.writer.get(r.job.id);
    expect(job?.stage).toBe('failed');
    expect(job?.reason).toMatch(/typing into the terminal failed \(Terminal did not answer in time\)/);
    expect(job?.reason).toMatch(/not proven sent/);
    expect(job?.reason).toMatch(/may still arrive/);
    const typedAt = rig.terminal.ops('type')[0]?.at as number;
    expect(failedAt - typedAt).toBeGreaterThanOrEqual(2500 + 12 * 2500);
    expect(rig.terminal.ops('enter')).toHaveLength(0);
  });

  it('keys that land late in the window still count (25 s after a typing timeout)', async () => {
    const rig = makeRig();
    rig.terminal.type = async (_pane, text) => {
      rig.terminal.calls.push({ op: 'type', at: rig.clock.now(), tty: rig.terminal.tty, text });
      rig.clock.setTimeout(() => rig.transcripts.append(SID, [userEntry(rig.at(), text)]), 25_000);
      return { ok: false, code: 'failed', reason: 'Terminal is not responding (-1712)' };
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(rig.terminal.ops('enter')).toHaveLength(0);
  });

  it('a definite typing failure (the tab is gone) fails at once, as before', async () => {
    const rig = makeRig();
    rig.terminal.type = async () => ({ ok: false, code: 'not_found', reason: 'that Terminal tab is no longer open' });
    const r = await send(rig);
    if (!r.ok) throw new Error(r.reason);
    await advance(rig.clock, 1000);
    const job = rig.writer.get(r.job.id);
    expect(job?.stage).toBe('failed');
    expect(job?.reason).toMatch(/typing into the terminal failed \(that Terminal tab is no longer open\)/);
  });

  it('an Enter fails but the prompt shows up a few seconds later: proven, and no Enter after the failed one', async () => {
    const rig = makeRig();
    rig.terminal.failEnter = true;
    let scheduled = false;
    const realEnter = rig.terminal.pressEnter.bind(rig.terminal);
    rig.terminal.pressEnter = async (pane) => {
      const res = await realEnter(pane);
      if (!scheduled) {
        scheduled = true;
        rig.clock.setTimeout(() => {
          rig.transcripts.append(SID, [userEntry(rig.at(), PROMPT)]);
          rig.terminal.box = '';
        }, 4000);
      }
      return res;
    };
    const job = await sendAndRun(rig);
    expect(job.stage).toBe('proven');
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });

  it('an Enter fails and nothing arrives: failed after the window with no more Enters', async () => {
    const rig = makeRig();
    rig.terminal.failEnter = true;
    const job = await sendAndRun(rig, PROMPT, 45_000);
    expect(job.stage).toBe('failed');
    expect(job.reason).toMatch(/pressing Enter failed \(osascript failed\)/);
    expect(job.reason).toMatch(/not proven sent/);
    expect(rig.terminal.ops('enter')).toHaveLength(1);
  });
});
