/**
 * Slash commands from the phone (controls addendum; research controls.md
 * 2.3): /plan, /model <name>, /effort <level>, /compact, /rewind and /clear.
 * Only SlashCommandSchema's names and arguments ever get here (the model and
 * effort words from fixed lists, no control characters anywhere).
 *
 * - Everything but /clear goes through the writer, the same send-with-proof
 *   as a prompt: its gates (no card, no dialog, Claude in front, the input
 *   box readable), its Enter rules, its transcript proof (/compact's comes
 *   only when compaction ends: compactProofMs). The answer waits up to 20 s:
 *   a command still unproven then answers `proven: false` and its
 *   send.progress events tell the rest. So does one the writer failed after
 *   its text left the input box: Claude most likely ran it (some commands may
 *   write no transcript line, spike S6), and a retry would run it twice.
 *   The writer's reasons that quote text not the daemon's own (a dialog's
 *   title is screen text; the waiting word is Claude's) become fixed
 *   sentences, since the reply is kept for its Idempotency-Key and its
 *   message lands in the audit row.
 * - /clear starts a new transcript, so the writer refuses it (writer/text.ts).
 *   It is typed here, under the pane's writer lock, into an empty input box,
 *   and proven by the next SessionStart hook with `source: "clear"` from
 *   this session (its id, or its Claude pid as the hook's parent or, behind
 *   a shim, its grandparent: one ps call). Terminal's own Return normally
 *   sends it; if it still sits in the box after 2.5 s, one Enter more.
 *   Never typed twice.
 *
 * `/model <name>` and `/effort <level>` also save that choice as the default
 * for new sessions (Claude's behaviour); the phone says so before sending.
 */
import { HOOK_TAG, SlashCommandSchema, type HookPayload, type SlashCommand } from '@jantar/protocol';
import type { Actor, ControlResult, DaemonContext, HooksBridge, TimerId } from '../contracts.js';
import { cLocale } from '../core/exec.js';
import { squash } from '../terminal/screen.js';
import {
  DIALOG_REASON,
  WAITING_REASON,
  controlsOn,
  foregroundGate,
  locate,
  readState,
  refuse,
  stateGate,
  withLock,
  type ControlsDeps,
} from './common.js';
import { NO_INPUT_BOX } from './keys.js';

/** How long the API waits for a command's proof before answering `proven: false`. */
export const COMMAND_WAIT_MS = 20_000;
/** /clear: one more Enter if it still sits in the box after this long. */
export const CLEAR_ENTER_MS = 2_500;
/** /clear: how long the SessionStart hook is waited for, from typing. */
export const CLEAR_PROOF_MS = 15_000;

export const CLEAR_TEXT = '/clear';
/** The one ps call that names a hook shim's parent. */
const PS_TIMEOUT_MS = 2_000;

/** How the writer starts the reasons that quote text not the daemon's, and its failure once the text left the box. */
const WRITER_DIALOG = 'a dialog is open in the terminal';
const WRITER_WAITING = 'the session is waiting for an answer';
const WRITER_LEFT_BOX = 'the prompt left the input box';

/** The writer's reason as this module may repeat it (see the top of the file). */
export function writerReason(reason: string | undefined, fallback: string): string {
  if (!reason) return fallback;
  if (reason.startsWith(WRITER_DIALOG)) return DIALOG_REASON;
  if (reason.startsWith(WRITER_WAITING)) return WAITING_REASON;
  return reason;
}

/** The text typed for a command: "/model opus", "/compact keep the API notes". */
export function commandText(cmd: SlashCommand): string {
  const args = cmd.args?.trim();
  return args ? `/${cmd.name} ${args}` : `/${cmd.name}`;
}

/** The parent of `pid`, or null when ps can't name it. */
async function parentOf(ctx: DaemonContext, pid: number): Promise<number | null> {
  const r = await ctx.exec(ctx.bins.ps, ['-o', 'ppid=', '-p', String(pid)], { env: cLocale(ctx.env), timeoutMs: PS_TIMEOUT_MS });
  if (r.spawnError || r.timedOut || r.code !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Waits for this session's SessionStart hook with source "clear". */
function clearProof(ctx: DaemonContext, hooks: HooksBridge, sid: string, pid: number) {
  let seen = false;
  const waiters = new Set<() => void>();
  const saw = () => {
    seen = true;
    for (const w of [...waiters]) w();
  };
  const off = hooks.onHookEvent((p: HookPayload) => {
    if (p.hook_event_name !== 'SessionStart' || p.source !== 'clear') return;
    // /clear gives the session a new id, so the hook's parent pid names it.
    const ppid = p[HOOK_TAG]?.ppid;
    if (p.session_id === sid || ppid === pid) return saw();
    // Or a shim right under Claude (docs/hook-protocol.md). A shim that has
    // exited before ps runs can't be traced: the answer is then proven: false.
    if (ppid === undefined || ppid <= 1) return;
    void parentOf(ctx, ppid).then((up) => {
      if (up === pid) saw();
    });
  });
  return {
    /** True once the hook has come, waiting at most `ms` for it. */
    within(ms: number): Promise<boolean> {
      if (seen) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: TimerId | undefined;
        const done = (v: boolean) => {
          ctx.clock.clearTimeout(timer);
          waiters.delete(hit);
          resolve(v);
        };
        const hit = () => done(true);
        waiters.add(hit);
        timer = ctx.clock.setTimeout(() => done(seen), Math.max(0, ms));
      });
    },
    stop: off,
  };
}

async function clearConversation(ctx: DaemonContext, deps: ControlsDeps, sid: string): Promise<ControlResult<{ proven: boolean }>> {
  const early = await stateGate(ctx, deps, sid, { waiting: false });
  if (early) return early;
  const found = await locate(ctx, deps, sid);
  if (!found.ok) return found;
  const { pane, session } = found;
  return withLock(ctx, deps, pane, async () => {
    const state = await stateGate(ctx, deps, sid, { waiting: false });
    if (state) return state;
    const fg = await foregroundGate(deps, pane);
    if (fg) return fg;
    const screen = await readState(deps, pane);
    if (!screen.ok) return screen;
    const { dialog, inputBox } = screen.state;
    if (dialog) return refuse('dialog_open', DIALOG_REASON);
    if (!inputBox) return refuse('refused', NO_INPUT_BOX);
    // Typed after a draft, /clear would be sent as part of it.
    if (inputBox.text !== '') return refuse('input_not_empty', "Claude's input box holds a draft; clear it first");

    const proof = clearProof(ctx, deps.hooks, sid, session.pid);
    try {
      const typed = await deps.terminal.type(pane, CLEAR_TEXT);
      if (!typed.ok) return typed;
      if (!(await proof.within(CLEAR_ENTER_MS))) {
        const box = await deps.terminal.readInputBox(pane);
        if (box.ok && squash(box.text) === CLEAR_TEXT) await deps.terminal.pressEnter(pane);
      }
      return { ok: true, proven: await proof.within(CLEAR_PROOF_MS - CLEAR_ENTER_MS) };
    } finally {
      proof.stop();
    }
  });
}

async function throughWriter(
  deps: ControlsDeps,
  sid: string,
  cmd: SlashCommand,
  actor: Actor,
): Promise<ControlResult<{ proven: boolean }>> {
  const r = await deps.writer.submit({ sid, text: commandText(cmd), onDraft: 'refuse', actor });
  if (!r.ok) return refuse(r.code === 'not_found' ? 'not_found' : 'refused', writerReason(r.reason, 'the command was refused'));
  const job = (await deps.writer.wait(r.job.id, COMMAND_WAIT_MS)) ?? r.job;
  switch (job.stage) {
    case 'proven':
    case 'proven-merged':
      return { ok: true, proven: true };
    case 'refused':
      return refuse('refused', writerReason(job.reason, 'the command was refused'));
    case 'failed':
      if (job.reason?.startsWith(WRITER_LEFT_BOX)) return { ok: true, proven: false };
      return refuse('failed', writerReason(job.reason, 'the command was not proven sent'));
    default:
      return { ok: true, proven: false };
  }
}

export async function runCommand(
  ctx: DaemonContext,
  deps: ControlsDeps,
  sid: string,
  cmd: SlashCommand,
  actor: Actor,
): Promise<ControlResult<{ proven: boolean }>> {
  const off = controlsOn(ctx);
  if (off) return off;
  // The API validated the body already; this part is reachable from elsewhere too.
  const checked = SlashCommandSchema.safeParse(cmd);
  if (!checked.success) return refuse('refused', 'that is not an allowed slash command');
  if (checked.data.name === 'clear') return clearConversation(ctx, deps, sid);
  return throughWriter(deps, sid, checked.data, actor);
}
