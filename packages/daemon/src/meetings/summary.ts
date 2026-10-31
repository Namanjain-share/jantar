/**
 * The summary queue and action items (spec 4.9, 4.10).
 *
 * One headless Claude run at a time, daemon-wide, oldest first, kept in
 * memory: `enqueue(id)` (capture's end and the stale sweep, for an ended
 * meeting with at least MEETING_SUMMARY_MIN_CHARS of captions) and
 * `request(id)` (the phone's Summarize or Try again) set the record's
 * summary to `queued` and kick the queue. Nothing resumes after a restart:
 * `start()` (the shell opened meetings.db) marks whatever a run left queued
 * or running `failed` with the stopped sentence, and `stop()` (the shell is
 * closing it) aborts the run going and does the same, so the phone offers
 * Try again. A run that ends after stop(), after meetings.db closed or after
 * its meeting was deleted keeps nothing; a delete also stops the run going
 * for that meeting (`cancel(id)`), so it spends no more quota.
 *
 * The run is Ask Claude's (life/food/estimate.ts) on the shared runner
 * (rewrite/run.ts): Rewrite's isolation flags, the env scrub, an empty 0700
 * cwd under paths.meetingSummaryDir, our system prompt as a file
 * (assets/meetings/summary-v1.md, spec Appendix A), the meeting and its
 * transcript on stdin only (input.ts), and the account from
 * rewrite/pick.ts, so never a kept or held account, and `claude -p` on
 * account 0 with one login. Never under --read-only: the status says so and
 * an end leaves the summary `none` with that sentence (the pipeline refuses
 * meetingSummarize first).
 *
 * The answer counts only as one JSON object SummaryAnswerSchema accepts
 * (one code fence tolerated); anything else, a timeout or a failed run is
 * `failed` with a fixed sentence and nothing partial is kept. Each state
 * change ticks (`life.changed {}`). One `meeting.summary` audit row per run
 * with counts only; logs carry outcomes and counts, never text.
 *
 * Action items: after a `done` summary, when the record's autoTodos is on,
 * its project is still in Life and Todos are on, one todo per item in order
 * (the system actor); a refused create stops the rest quietly and those stay
 * for a tap. `addTodo` and `removeTodo` are the phone's taps: one event each,
 * Life's own (the item's todoId is stored in the same turn).
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MEETING_SUMMARY_MIN_CHARS, type AccountId, type ActionItem, type RewriteModel } from '@jantar/protocol';
import type { Actor, Logger, MeetingRecord, MeetingRow, MeetingSummaries, MeetingsCore, MeetingsResult, MeetingsStore } from '../contracts.js';
import { SYSTEM_ACTOR, actorId } from '../core/actor.js';
import { READ_ONLY_SUMMARIES } from '../modes.js';
import { pickSharedRunAccount, runVia } from '../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, prepareRunDir, runDroppingRefused, type RunOutcome } from '../rewrite/run.js';
import { MEETING_REASONS, linesInOrder } from './common.js';
import { dayOf, summaryInput, type SummaryMeeting } from './input.js';

/** D2: Sonnet at medium effort, Haiku when Sonnet is not there. */
export const MEETING_SUMMARY_MODEL: RewriteModel = 'sonnet';
export const MEETING_SUMMARY_FALLBACK_MODEL: RewriteModel = 'haiku';
export const MEETING_SUMMARY_EFFORT = 'medium';
/** It runs in the background, so no request waits on it. */
export const MEETING_SUMMARY_TIMEOUT_MS = 180_000;
/** Bump with the prompt's text; the audit row records it. */
export const MEETING_SUMMARY_PROMPT_VERSION = 'v1';
export const MEETING_SUMMARY_ASSET = `meetings/summary-${MEETING_SUMMARY_PROMPT_VERSION}.md`;

export const SUMMARY_SENTENCES = {
  stopped: 'The summary was stopped before it finished. Try again.',
  noAccount: 'No account has room for a summary right now. Try again later.',
  noRunner: 'Summaries need Claude Code on this Mac.',
  failed: 'The summary did not work. Try again.',
  done: 'The summary is already written.',
  busy: 'The summary is being written.',
  open: 'The meeting is still going. Its summary is written when it ends.',
  noLines: 'This meeting has no transcript to summarize.',
  /**
   * An end under --read-only: kept with the record, so it says what happened
   * and stays true after a restart without --read-only (Summarize then works).
   */
  readOnlyEnded: 'Jantar was read-only when this meeting ended, so no summary was written.',
} as const;

export const ITEM_SENTENCES = {
  already: 'Already in todos.',
  noItem: 'No such action item.',
} as const;

/** Add to todos while Todos are off (as the API's FEATURE_OFF says it; the module answers it, so it is a 403). */
export const TODOS_OFF = 'Todos are off. Turn them on at your Mac: jantar life on todos';
export const NO_MEETING = MEETING_REASONS.noMeeting;
/** meetings.db closed between the pipeline's check and the call. */
export const MEETINGS_CLOSED = MEETING_REASONS.closed;

const line = (max: number) => z.string().trim().min(1).max(max);

/** An action item's owner as the record keeps it (ActionItemSchema's cap). */
const OWNER_MAX = 60;

/**
 * What claude must answer (Appendix A's shape). Unknown keys are dropped;
 * anything else fails the whole answer, except an owner (one written as null
 * counts as left out and a long one is cut: parseSummary) and a list left
 * out (none), so a label or an empty list never costs the meeting its notes.
 */
export const SummaryAnswerSchema = z.object({
  summary: line(2000),
  decisions: z.array(line(300)).max(20).default([]),
  actionItems: z
    .array(
      z.object({
        title: line(200),
        owner: z.string().nullish(),
      }),
    )
    .max(30)
    .default([]),
});

/** A checked answer, as the record keeps it. */
export interface SummaryAnswer {
  text: string;
  decisions: string[];
  items: ActionItem[];
}

/** The summary in claude's result text: one JSON object, maybe inside one code fence; null when it is not a valid answer. */
export function parseSummary(result: string): SummaryAnswer | null {
  let text = result.trim();
  const fenced = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = SummaryAnswerSchema.safeParse(value);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    text: a.summary,
    decisions: a.decisions,
    items: a.actionItems.map((i) => {
      const owner = ownerOf(i.owner);
      return owner ? { title: i.title, owner } : { title: i.title };
    }),
  };
}

/** Trimmed and at most OWNER_MAX characters, never ending on half of a surrogate pair; '' when blank or null. */
function ownerOf(owner: string | null | undefined): string {
  const cut = (owner ?? '').trim().slice(0, OWNER_MAX);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

type Refusal = Extract<MeetingsResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: MeetingsResult = { ok: true, value: true };

/** An error's code or class name for a log line: never its message (it can carry a path or text). */
function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

/** The record with its summary replaced. */
function withSummary(r: MeetingRecord, summary: MeetingRecord['summary']): MeetingRecord {
  return { ...r, summary };
}

const failedSummary = (reason: string): MeetingRecord['summary'] => ({ state: 'failed', reason, decisions: [], items: [] });

/** One run of the queue. `epoch` is the queue's when it began: start() and stop() move on, and an older run keeps nothing. */
interface Run {
  id: string;
  epoch: number;
  abort: AbortController;
}

class SummaryQueue implements MeetingSummaries {
  /** Waiting meeting ids, oldest first. */
  private readonly queue: string[] = [];
  /** The run going, until its process is gone (so a run never overlaps the next, even across stop() and start()). */
  private running: Run | null = null;
  private epoch = 0;
  /** Options claude refused that a summary can do without: left out until the daemon restarts. */
  private readonly learned = new Set<string>();
  /** Refused options already logged ("" for one that couldn't be read). */
  private readonly logged = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly core: MeetingsCore) {
    this.log = core.ctx.log.child({ part: 'meetings', module: 'summary' });
  }

  status(): { available: boolean; reason?: string } {
    if (this.core.readOnly) return { available: false, reason: READ_ONLY_SUMMARIES };
    return runVia(this.core.ctx) ? { available: true } : { available: false, reason: SUMMARY_SENTENCES.noRunner };
  }

  enqueue(id: string): void {
    const store = this.core.store();
    const row = store?.get(id);
    if (!store || !row || row.endedAt === null || row.record.summary.state !== 'none') return;
    if (store.lineChars(id) < MEETING_SUMMARY_MIN_CHARS) return;
    if (this.core.readOnly) {
      // The end's own tick shows it; the state stays none.
      store.update(id, (r) => withSummary(r, { state: 'none', reason: SUMMARY_SENTENCES.readOnlyEnded, decisions: [], items: [] }));
      return;
    }
    this.queueUp(store, id);
  }

  request(id: string, _actor: Actor): MeetingsResult {
    if (this.core.readOnly) return refuse('forbidden', READ_ONLY_SUMMARIES);
    const store = this.core.store();
    if (!store) return refuse('unavailable', MEETINGS_CLOSED);
    const row = store.get(id);
    if (!row) return refuse('not_found', NO_MEETING);
    const state = row.record.summary.state;
    if (state === 'done') return refuse('conflict', SUMMARY_SENTENCES.done);
    if (state === 'queued' || state === 'running') return refuse('conflict', SUMMARY_SENTENCES.busy);
    if (row.endedAt === null) return refuse('conflict', SUMMARY_SENTENCES.open);
    if (store.lineCount(id) === 0) return refuse('conflict', SUMMARY_SENTENCES.noLines);
    if (!this.queueUp(store, id)) return refuse('not_found', NO_MEETING);
    return OK;
  }

  addTodo(id: string, n: number, actor: Actor): MeetingsResult<{ id: string }> {
    if (!this.todosOn()) return refuse('forbidden', TODOS_OFF);
    const found = this.item(id, n);
    if (!found.ok) return found;
    const { store, row, item } = found.value;
    if (item.todoId) return refuse('conflict', ITEM_SENTENCES.already);
    const projectId = this.projectName(row.projectId) !== null ? row.projectId : null;
    const made = this.core.life.todos.createTodo(
      { title: item.title, ...(projectId ? { projectId } : {}), notes: this.todoNotes(row) },
      actor,
    );
    if (!made.ok) return made;
    // No tick of our own: Life's write ticked, and this lands in the same turn, before any screen can reload.
    store.update(id, (r) => withItems(r, (items) => items.map((it, i) => (i === n ? { ...it, todoId: made.value.id } : it))));
    return { ok: true, value: { id: made.value.id } };
  }

  removeTodo(id: string, n: number, actor: Actor): MeetingsResult {
    // While Todos are off Life's own delete is refused too (403): this is no way around the switch.
    if (!this.todosOn()) return refuse('forbidden', TODOS_OFF);
    const found = this.item(id, n);
    if (!found.ok) return found;
    const { store, item } = found.value;
    if (!item.todoId) return OK;
    const gone = this.core.life.todos.removeTodo(item.todoId, actor);
    // A todo deleted in Todos already counts as removed.
    if (!gone.ok && gone.code !== 'not_found') return gone;
    store.update(id, (r) =>
      withItems(r, (items) =>
        items.map((it, i) => {
          if (i !== n) return it;
          const { todoId: _gone, ...rest } = it;
          return rest;
        }),
      ),
    );
    // Life ticked for a todo it deleted (as for Add); one already gone wrote nothing there.
    if (!gone.ok) this.core.changed();
    return OK;
  }

  start(): void {
    this.epoch += 1;
    this.queue.length = 0;
    this.failWaiting();
  }

  stop(): void {
    this.epoch += 1;
    this.queue.length = 0;
    this.running?.abort.abort();
    this.failWaiting();
  }

  cancel(id: string): void {
    const at = this.queue.indexOf(id);
    if (at >= 0) this.queue.splice(at, 1);
    // Its process is killed; the run then finds no meeting to keep anything in, and the next one starts.
    if (this.running?.id === id) this.running.abort.abort();
  }

  // -------------------------------------------------------------------------

  /** Queued in the record and in memory, a tick, and the queue kicked; false when the meeting is gone. */
  private queueUp(store: MeetingsStore, id: string): boolean {
    if (!store.update(id, (r) => withSummary(r, { state: 'queued', decisions: [], items: [] }))) return false;
    this.queue.push(id);
    this.core.changed();
    this.kick();
    return true;
  }

  /** Every summary left queued or running: failed with the stopped sentence (Try again), one tick. */
  private failWaiting(): void {
    const store = this.core.store();
    if (!store) return;
    let n = 0;
    for (const row of store.summaryWaiting()) {
      if (store.update(row.id, (r) => withSummary(r, failedSummary(SUMMARY_SENTENCES.stopped)))) n += 1;
    }
    if (n === 0) return;
    this.log.info('meetings: summaries stopped before they finished', { count: n });
    this.core.changed();
  }

  /** Start the next run when none is going. */
  private kick(): void {
    if (this.running) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    const run: Run = { id, epoch: this.epoch, abort: new AbortController() };
    this.running = run;
    // Never inside the caller's own turn: the request that queued it answers first.
    void Promise.resolve()
      .then(() => this.run(run))
      .catch((e: unknown) => {
        this.log.error('meetings: a summary run failed', { error: errorKind(e) });
        try {
          this.finish(run, failedSummary(SUMMARY_SENTENCES.failed));
        } catch {
          // meetings.db went away meanwhile: the next start() marks it.
        }
      })
      .finally(() => {
        this.running = null;
        this.kick();
      });
  }

  /** The store while `run` still counts: null after stop(), start() or a close (drop the result then). */
  private live(run: Run): MeetingsStore | null {
    return run.epoch === this.epoch ? this.core.store() : null;
  }

  private async run(run: Run): Promise<void> {
    const { ctx } = this.core;
    const { id } = run;
    const before = this.live(run)?.get(id);
    if (!before || before.record.summary.state !== 'queued') return;
    const counts = { lines: 0, chars: 0 };

    const via = runVia(ctx);
    if (!via) {
      this.audit(id, { ...counts, ms: 0, account: null, outcome: 'unavailable' });
      this.finish(run, failedSummary(SUMMARY_SENTENCES.noRunner));
      return;
    }
    const account = await pickSharedRunAccount(ctx, { usage: this.core.usage, ccwLegacy: this.core.ccwLegacy, log: this.log });
    const store = this.live(run);
    const row = store?.get(id);
    if (!store || !row) return;
    if (account === null) {
      this.audit(id, { ...counts, ms: 0, account: null, outcome: 'no_account' });
      this.finish(run, failedSummary(SUMMARY_SENTENCES.noAccount));
      return;
    }

    const meeting: SummaryMeeting = { name: row.record.name, startedAt: row.startedAt };
    const project = this.projectName(row.projectId);
    if (project !== null) meeting.project = project;
    if (row.record.people) meeting.people = row.record.people;
    const lines = linesInOrder(store, id);
    const input = summaryInput(meeting, lines, this.core.tz());
    counts.lines = lines.length;
    counts.chars = input.length;
    if (!store.update(id, (r) => withSummary(r, { state: 'running', decisions: [], items: [] }))) return;
    this.core.changed();

    const single = 'claude' in via;
    const started = ctx.clock.now();
    let outcome: RunOutcome | null = null;
    try {
      const dir = await prepareRunDir(ctx.paths, { dir: ctx.paths.meetingSummaryDir, asset: MEETING_SUMMARY_ASSET });
      if (dir.workEntries > 0) await emptyDir(dir.cwd);
      const once = (dropped: ReadonlySet<string>) =>
        execRewrite(ctx, {
          via,
          flags: {
            account: single ? null : account,
            model: MEETING_SUMMARY_MODEL,
            fallbackModel: MEETING_SUMMARY_FALLBACK_MODEL,
            effort: MEETING_SUMMARY_EFFORT,
            systemPromptFile: dir.systemPromptFile,
            dropped,
          },
          input,
          cwd: dir.cwd,
          timeoutMs: MEETING_SUMMARY_TIMEOUT_MS,
          signal: run.abort.signal,
        });
      // stop() while the dir was made: nothing starts.
      if (run.abort.signal.aborted) outcome = { kind: 'cancelled' };
      else outcome = (await runDroppingRefused(once, this.learned, (option) => this.refused(option), run.abort.signal)).outcome;
    } catch (e) {
      // A code only: the run dir's path or anything else in the message stays out of the log.
      this.log.error('meetings: a summary could not run', { code: errorKind(e) });
    }

    const ms = Math.max(0, ctx.clock.now() - started);
    const answer = outcome?.kind === 'ok' ? parseSummary(outcome.result) : null;
    const kind = outcome === null ? 'failed' : outcome.kind === 'ok' && !answer ? 'unreadable' : outcome.kind;
    this.audit(id, { ...counts, ms, account, outcome: kind });
    if (!answer) {
      if (kind !== 'cancelled') this.log.warn('meetings: a summary did not work', { outcome: kind });
      this.finish(run, failedSummary(outcome?.kind === 'unavailable' ? SUMMARY_SENTENCES.noRunner : SUMMARY_SENTENCES.failed));
      return;
    }
    const done = this.live(run)?.get(id);
    if (!done) return;
    const items = this.autoTodos(done, answer.items);
    this.finish(run, { state: 'done', text: answer.text, decisions: answer.decisions, items, at: ctx.clock.iso() });
  }

  /** The run's last state, when it still counts and its meeting is still there; a tick. */
  private finish(run: Run, summary: MeetingRecord['summary']): void {
    const store = this.live(run);
    if (!store || !store.update(run.id, (r) => withSummary(r, summary))) return;
    this.core.changed();
  }

  /**
   * Action items into the meeting's project, by themselves: only with the
   * toggle on, Todos on and the project still in Life. In order, as the
   * system; the first refusal (a cap, Life closed) stops the rest, which
   * stay for a tap. Never blocks the summary.
   */
  private autoTodos(row: MeetingRow, items: ActionItem[]): ActionItem[] {
    if (!row.record.autoTodos || items.length === 0 || !this.todosOn()) return items;
    const projectId = row.projectId;
    if (projectId === null || this.projectName(projectId) === null) return items;
    const notes = this.todoNotes(row);
    const out = items.map((i) => ({ ...i }));
    try {
      for (const item of out) {
        const made = this.core.life.todos.createTodo({ title: item.title, projectId, notes }, SYSTEM_ACTOR);
        if (!made.ok) {
          this.log.warn('meetings: action items stopped going to todos', { code: made.code, added: out.filter((i) => i.todoId).length });
          break;
        }
        item.todoId = made.value.id;
      }
    } catch (e) {
      this.log.warn('meetings: action items stopped going to todos', { error: errorKind(e) });
    }
    return out;
  }

  /** The meeting and its action item `n` (a done summary's). */
  private item(id: string, n: number): MeetingsResult<{ store: MeetingsStore; row: MeetingRow; item: ActionItem }> {
    const store = this.core.store();
    if (!store) return refuse('unavailable', MEETINGS_CLOSED);
    const row = store.get(id);
    if (!row) return refuse('not_found', NO_MEETING);
    const item = row.record.summary.state === 'done' ? row.record.summary.items[n] : undefined;
    if (!item) return refuse('not_found', ITEM_SENTENCES.noItem);
    return { ok: true, value: { store, row, item } };
  }

  private todosOn(): boolean {
    return this.core.ctx.settings.get().life.todos;
  }

  /** The project's name while Todos are on and Life still has it (as the phone shows it); else null. */
  private projectName(projectId: string | null): string | null {
    if (projectId === null || !this.todosOn()) return null;
    try {
      const r = this.core.life.todos.listProjects();
      return r.ok ? (r.value.projects.find((p) => p.id === projectId)?.name ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Where a todo came from, in its notes. */
  private todoNotes(row: MeetingRow): string {
    return `From the meeting "${row.record.name}" on ${dayOf(row.startedAt, this.core.tz())}.`;
  }

  /** claude (or cswap) refused an option: one log line per option for the daemon's life. */
  private refused(option: string | null): void {
    const key = option ?? '';
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log.warn('meetings: claude refused an option of the summary', { option, dropped: option !== null && DROPPABLE_OPTIONS.includes(option) });
  }

  private audit(id: string, r: { lines: number; chars: number; ms: number; account: AccountId | null; outcome: string }): void {
    const { ctx } = this.core;
    const ok = r.outcome === 'ok';
    try {
      ctx.db.audit.append({
        ts: ctx.clock.iso(),
        actor: actorId(SYSTEM_ACTOR),
        action: 'meeting.summary',
        target: id,
        params: {
          lines: r.lines,
          chars: r.chars,
          ms: r.ms,
          account: r.account,
          model: MEETING_SUMMARY_MODEL,
          promptVersion: MEETING_SUMMARY_PROMPT_VERSION,
          outcome: r.outcome,
        },
        result: ok ? 'ok' : 'failed',
      });
    } catch {
      this.log.error('meetings: audit write failed');
    }
  }
}

/** The record with its action items mapped (a done summary only). */
function withItems(r: MeetingRecord, fn: (items: ActionItem[]) => ActionItem[]): MeetingRecord {
  return withSummary(r, { ...r.summary, items: fn(r.summary.items) });
}

/** Empty the run's own work dir (nothing should be there: the run has no tools). */
async function emptyDir(dir: string): Promise<void> {
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}

export function buildSummaries(core: MeetingsCore): MeetingSummaries {
  return new SummaryQueue(core);
}
