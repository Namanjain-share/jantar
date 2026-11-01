/**
 * The Ask part (spec 4 to 6, 10, 11): turns in memory, one headless Claude
 * run at a time, and the taps that add a card's item to Life or undo it.
 *
 * Turns: a Map from the owner (`actorId`, a device) to its turns, oldest
 * first; anyone else asking for one gets not_found. Nothing is written to
 * disk: not life.db (its nightly backups never hold chat text) and no file
 * of its own, since a message can name a medicine or an amount. Pruned on
 * every send and list and every hour, every owner's: the newest
 * ASK_TURNS_KEPT each, and an older one while an item it added can still
 * be undone (ASK_APPLY_WITHIN_MS: Undo never vanishes inside its day);
 * none older than ASK_KEEP_DAYS. Clear forgets one device's, the switch
 * turning off and stop() forget everyone's, so a restart forgets them too;
 * items already added stay in Life.
 *
 * The queue: `queued -> running -> done | failed | cancelled`, one
 * unfinished turn per device, one run at a time daemon-wide, oldest first.
 * `kick()` never runs inside the caller's request. An epoch and `live()`
 * (as meetings/summary.ts) mean a run that ends after Cancel, Clear, the
 * switch turning off or stop() keeps nothing. stop() waits for the run it
 * killed (as Rewrite), so its audit row is written before later parts stop.
 *
 * The run is Ask Claude's (life/food/estimate.ts) on the shared runner
 * (rewrite/run.ts): Rewrite's isolation flags, the env scrub, an empty 0700
 * cwd under paths.askDir emptied before each run, our system prompt as a
 * file (assets/ask/assistant-v2.md), the input on stdin only (input.ts),
 * the account from rewrite/pick.ts (never a kept or held one; account 0
 * with `claude -p` directly on one login; a read of ccw's hold list that
 * hangs ends at Cancel or ASK_TIMEOUT_MS). Rewrite's model and fallback,
 * read when the run starts, at low effort, ASK_TIMEOUT_MS, the runner's
 * budget cap. No adopt step and no second account. A refused option the
 * run can do without is learned in this part's own set.
 *
 * Apply: Add, Skip and Undo are the phone's taps. Add re-checks the card
 * (or the phone's edit of it) against now (answer.ts checkWrite), then
 * calls the Life module with the tapping device as actor, so Life's own
 * checks, caps, pings and `life.changed` apply as they are; Undo removes
 * the item it made within ASK_APPLY_WITHIN_MS. A post card adds an idea
 * in-process, so the hourly limit on posts added over ctl.sock never
 * counts it. Dispatch is a fixed switch on the type, to eight calls: this
 * part holds only `life`, `usage` and `ccwLegacy`, so an answer reaches
 * nothing else (sessions, files, the shell, settings or other devices).
 *
 * No text anywhere but the owner's list: events are `life.changed {}` on
 * each turn state change, Skip, Clear and the switch turning off (Add and
 * Undo tick through Life); one `ask.run` audit row per run with counts
 * only; logs carry outcomes, codes and counts.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKeyOf, hhmmOf, isValidTimeZone } from '@jantar/life-core';
import {
  ASK_APPLY_WITHIN_MS,
  ASK_KEEP_DAYS,
  ASK_TEXT_MAX,
  ASK_TURNS_KEPT,
  FoodBodySchema,
  MoneyBodySchema,
  PostBodySchema,
  TodoBodySchema,
  type AccountId,
  type AskCard,
  type AskList,
  type AskTurn,
  type AskWriteAction,
  type RewriteModel,
} from '@jantar/protocol';
import type { Actor, AskService, CcwLegacySource, DaemonContext, LifeResult, LifeService, Logger, TimerId, Unsubscribe, UsageSource } from '../contracts.js';
import { actorId } from '../core/actor.js';
import { newId } from '../core/ids.js';
import { pickSharedRunAccount, runVia } from '../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, prepareRunDir, runDroppingRefused, type RunOutcome } from '../rewrite/run.js';
import { ASK_SENTENCES, asksReminder, checkWrite, parseAnswer, type AskProject, type AskScope, type ParsedAnswer } from './answer.js';
import { askInput } from './input.js';

/** Low effort: a short answer from a short input. */
export const ASK_EFFORT = 'low';
/** It runs in the background; the phone shows "Asking Claude…" with Cancel meanwhile. The account pick has as long again. */
export const ASK_TIMEOUT_MS = 90_000;
/** Turns are pruned this often too, so none stays in memory long past ASK_KEEP_DAYS when nobody opens Ask. */
export const ASK_SWEEP_MS = 60 * 60_000;
/** Bump with the prompt's text; the audit row records it. */
export const ASK_PROMPT_VERSION = 'v2';
export const ASK_PROMPT_ASSET = `ask/assistant-${ASK_PROMPT_VERSION}.md`;

/** The Life part each write type needs, and its switch's sentence (as the API's FEATURE_OFF says it). */
export const ASK_MODULE_OF = { todo: 'todos', food: 'food', money: 'finance', post: 'posts' } as const;
export const ASK_MODULE_OFF = {
  todos: 'Todos are off. Turn them on at your Mac: jantar life on todos',
  food: 'Food is off. Turn it on at your Mac: jantar life on food',
  finance: 'Finance is off. Turn it on at your Mac: jantar life on finance',
  posts: 'Posts are off. Turn them on at your Mac: jantar life on posts',
} as const;

export interface AskDeps {
  life: LifeService;
  usage: UsageSource;
  ccwLegacy: CcwLegacySource;
}

export interface AskOptions {
  /** jantard --read-only: told, not wrapped (the list says why; send is refused). */
  readOnly?: boolean;
}

/** How a run ended, as its audit row says it. */
type AuditOutcome = 'ok' | 'unavailable' | 'no_account' | 'timeout' | 'unreadable' | 'failed' | 'cancelled' | 'stopped';

/** One run of the queue. `epoch` is the part's when it began; `why` says who stopped it; `done` settles when it has ended. */
interface Run {
  owner: string;
  turnId: string;
  epoch: number;
  abort: AbortController;
  why?: 'cancelled' | 'stopped';
  done?: Promise<void>;
}

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };
const DAY_MS = 24 * 60 * 60_000;

const unfinished = (t: AskTurn) => t.state === 'queued' || t.state === 'running';

/** An error's code or class name for a log line: never its message (it can carry a path or text). */
function errorKind(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
}

/** Empty the run's own work dir (nothing should be there: the run has no tools). */
async function emptyDir(dir: string): Promise<void> {
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}

/** A finished run's audit outcome: ok, unreadable (ok but not an answer), timeout, unavailable, cancelled, else failed. */
function outcomeOf(outcome: RunOutcome | null, readable: boolean): AuditOutcome {
  if (outcome === null) return 'failed';
  if (outcome.kind === 'ok') return readable ? 'ok' : 'unreadable';
  if (outcome.kind === 'timeout' || outcome.kind === 'unavailable' || outcome.kind === 'cancelled') return outcome.kind;
  return 'failed';
}

/** The reason a failed run's turn shows. */
function failedReason(outcome: AuditOutcome): string {
  switch (outcome) {
    case 'unavailable':
      return ASK_SENTENCES.noRunner;
    case 'no_account':
      return ASK_SENTENCES.noAccount;
    case 'timeout':
      return ASK_SENTENCES.timeout;
    case 'unreadable':
      return ASK_SENTENCES.unreadable;
    default:
      return ASK_SENTENCES.failed;
  }
}

class AskServiceImpl implements AskService {
  /** Each owner's turns, oldest first. */
  private readonly turns = new Map<string, AskTurn[]>();
  /** Waiting turns, oldest first. */
  private readonly queue: { owner: string; turnId: string }[] = [];
  /** The run going, until its process is gone (so runs never overlap). */
  private running: Run | null = null;
  private epoch = 0;
  /** Options claude refused that an answer can do without: left out until the daemon restarts. */
  private readonly learned = new Set<string>();
  /** Refused options already logged ("" for one that couldn't be read). */
  private readonly logged = new Set<string>();
  private unsubscribe: Unsubscribe | null = null;
  private sweep: TimerId | undefined;
  private readonly log: Logger;
  private readonly readOnly: boolean;

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: AskDeps,
    opts: AskOptions,
  ) {
    this.log = ctx.log.child({ part: 'ask' });
    this.readOnly = opts.readOnly === true;
  }

  async start(): Promise<void> {
    this.unsubscribe ??= this.ctx.settings.subscribe((next, prev) => {
      if (prev.ask.enabled && !next.ask.enabled) {
        this.forgetAll('cancelled');
        this.changed();
      }
    });
    this.sweep ??= this.ctx.clock.setInterval(() => this.pruneAll(), ASK_SWEEP_MS);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx.clock.clearInterval(this.sweep);
    this.sweep = undefined;
    const run = this.running;
    this.forgetAll('stopped');
    await run?.done;
  }

  list(actor: Actor): LifeResult<AskList> {
    const owner = actorId(actor);
    this.pruneAll();
    const notReady = this.notReady();
    const turns = structuredClone(this.turns.get(owner) ?? []);
    return { ok: true, value: { ready: notReady === null, ...(notReady ? { reason: notReady.reason } : {}), turns } };
  }

  send(text: string, actor: Actor): LifeResult<{ id: string }> {
    const owner = actorId(actor);
    const message = text.trim();
    if (!message) return refuse('invalid_request', ASK_SENTENCES.noText);
    if (message.length > ASK_TEXT_MAX) return refuse('invalid_request', ASK_SENTENCES.tooLong);
    const notReady = this.notReady();
    if (notReady) return notReady;
    this.pruneAll();
    const list = this.turns.get(owner) ?? [];
    if (list.some(unfinished)) return refuse('conflict', ASK_SENTENCES.busy);
    const turn: AskTurn = { id: newId(), at: this.ctx.clock.iso(), text: message, state: 'queued', cards: [], dropped: 0 };
    list.push(turn);
    this.turns.set(owner, list);
    this.prune(owner);
    this.queue.push({ owner, turnId: turn.id });
    this.changed();
    this.kick();
    return { ok: true, value: { id: turn.id } };
  }

  cancel(id: string, actor: Actor): LifeResult {
    const owner = actorId(actor);
    const turn = this.turn(owner, id);
    if (!turn) return refuse('not_found', ASK_SENTENCES.noTurn);
    if (!unfinished(turn)) return OK;
    this.halt(owner, turn.id);
    turn.state = 'cancelled';
    turn.reason = ASK_SENTENCES.cancelled;
    this.changed();
    return OK;
  }

  clear(actor: Actor): LifeResult {
    const owner = actorId(actor);
    for (const t of this.turns.get(owner) ?? []) if (unfinished(t)) this.halt(owner, t.id);
    this.turns.delete(owner);
    this.changed();
    return OK;
  }

  add(id: string, n: number, edit: AskWriteAction | undefined, actor: Actor): LifeResult<{ id: string }> {
    const found = this.writeCard(actorId(actor), id, n);
    if (!found.ok) return found;
    const { turn, card, action } = found.value;
    if (card.state !== 'proposed') return refuse('conflict', card.state === 'added' ? ASK_SENTENCES.added : ASK_SENTENCES.skipped);
    if (this.tooOld(turn)) return refuse('conflict', ASK_SENTENCES.old);
    if (edit && edit.type !== action.type) return refuse('invalid_request', ASK_SENTENCES.editType);
    // An edit keeps the card's project or leaves it out: no id the phone (or anyone) names is taken.
    if (edit?.type === 'todo' && action.type === 'todo' && edit.projectId !== undefined && edit.projectId !== action.projectId) {
      return refuse('invalid_request', ASK_SENTENCES.editProject);
    }
    const wanted = edit ?? action;
    const checked = checkWrite(wanted, this.now(), { noTime: card.flag === 'no_time', noProject: card.flag === 'no_project' });
    if (!checked.ok) return refuse('invalid_request', checked.reason);
    const off = this.moduleOff(checked.action);
    if (off) return off;
    const made = this.apply(checked.action, actor);
    if (!made.ok) return made;
    // No tick of our own: Life's write ticked, and this lands in the same turn, before any screen can reload.
    card.action = checked.action;
    card.state = 'added';
    card.ref = made.value.id;
    if (checked.flag) card.flag = checked.flag;
    else delete card.flag;
    return { ok: true, value: { id: made.value.id } };
  }

  skip(id: string, n: number, actor: Actor): LifeResult {
    const found = this.writeCard(actorId(actor), id, n);
    if (!found.ok) return found;
    const { card } = found.value;
    if (card.state !== 'proposed') return refuse('conflict', card.state === 'added' ? ASK_SENTENCES.added : ASK_SENTENCES.skipped);
    card.state = 'skipped';
    this.changed();
    return OK;
  }

  undo(id: string, n: number, actor: Actor): LifeResult {
    const found = this.card(actorId(actor), id, n);
    if (!found.ok) return found;
    const { turn, card } = found.value;
    const action = card.action;
    if (action.type === 'show' || card.state !== 'added' || !card.ref) return refuse('conflict', ASK_SENTENCES.nothingToUndo);
    if (this.tooOld(turn)) return refuse('conflict', ASK_SENTENCES.oldUndo);
    // While the part is off Life's own delete is refused too (403): Undo is no way around a switch.
    const off = this.moduleOff(action);
    if (off) return off;
    const gone = this.remove(action, card.ref, actor);
    // An item deleted in Life already counts as removed.
    if (!gone.ok && gone.code !== 'not_found') return gone;
    card.state = 'proposed';
    delete card.ref;
    // Life ticked for an item it deleted; one already gone wrote nothing there.
    if (!gone.ok) this.changed();
    return OK;
  }

  // -------------------------------------------------------------------------
  // Turns

  private turn(owner: string, id: string): AskTurn | undefined {
    return this.turns.get(owner)?.find((t) => t.id === id);
  }

  /** The owner's turn `id` and its card `n`. */
  private card(owner: string, id: string, n: number): LifeResult<{ turn: AskTurn; card: AskCard }> {
    const turn = this.turn(owner, id);
    if (!turn) return refuse('not_found', ASK_SENTENCES.noTurn);
    const card = turn.cards[n];
    if (!card) return refuse('not_found', ASK_SENTENCES.noCard);
    return { ok: true, value: { turn, card } };
  }

  /** The card of a done turn, when it is a write. */
  private writeCard(owner: string, id: string, n: number): LifeResult<{ turn: AskTurn; card: AskCard; action: AskWriteAction }> {
    const found = this.card(owner, id, n);
    if (!found.ok) return found;
    const { turn, card } = found.value;
    if (turn.state !== 'done') return refuse('conflict', ASK_SENTENCES.notDone);
    const action = card.action;
    if (action.type === 'show') return refuse('conflict', ASK_SENTENCES.notWrite);
    return { ok: true, value: { turn, card, action } };
  }

  private tooOld(turn: AskTurn): boolean {
    return this.ctx.clock.now() - Date.parse(turn.at) > ASK_APPLY_WITHIN_MS;
  }

  /** A card of `turn` added an item that Undo can still remove. */
  private undoable(turn: AskTurn): boolean {
    return !this.tooOld(turn) && turn.cards.some((c) => c.state === 'added');
  }

  /**
   * The owner's newest ASK_TURNS_KEPT, and any older one while it is
   * undoable (at most a day's sends: the day budget bounds them); none older
   * than ASK_KEEP_DAYS.
   */
  private prune(owner: string): void {
    const list = this.turns.get(owner);
    if (!list) return;
    const cutoff = this.ctx.clock.now() - ASK_KEEP_DAYS * DAY_MS;
    const recent = list.filter((t) => Date.parse(t.at) >= cutoff);
    const newest = recent.length - ASK_TURNS_KEPT;
    const kept = recent.filter((t, i) => i >= newest || this.undoable(t));
    if (kept.length === 0) this.turns.delete(owner);
    else if (kept.length !== list.length) this.turns.set(owner, kept);
  }

  /** Every owner's, so a revoked device's turns age out too. */
  private pruneAll(): void {
    for (const owner of [...this.turns.keys()]) this.prune(owner);
  }

  /** Take a turn off the queue, or stop its run. The caller marks it (or forgets it). */
  private halt(owner: string, turnId: string): void {
    const at = this.queue.findIndex((q) => q.owner === owner && q.turnId === turnId);
    if (at >= 0) this.queue.splice(at, 1);
    const run = this.running;
    if (run && run.owner === owner && run.turnId === turnId) {
      run.why = 'cancelled';
      run.abort.abort();
    }
  }

  /** The switch turned off, or the daemon is stopping: the run stopped, the queue and every turn forgotten. */
  private forgetAll(why: 'cancelled' | 'stopped'): void {
    this.epoch += 1;
    this.queue.length = 0;
    const run = this.running;
    if (run) {
      run.why ??= why;
      run.abort.abort();
    }
    this.turns.clear();
  }

  private changed(): void {
    this.ctx.store.emit({ type: 'life.changed', data: {} });
  }

  /** Why Ask can't take a message now (a fixed sentence), or null. */
  private notReady(): Refusal | null {
    const s = this.ctx.settings.get();
    if (!s.ask.enabled) return refuse('forbidden', ASK_SENTENCES.off);
    if (this.readOnly) return refuse('forbidden', ASK_SENTENCES.readOnly);
    const broken = this.lifeBroken();
    if (broken !== null) return refuse('life_unavailable', broken);
    if (!runVia(this.ctx)) return refuse('conflict', ASK_SENTENCES.noRunner);
    const { todos, food, finance, medicines, posts } = s.life;
    if (!todos && !food && !finance && !medicines && !posts) return refuse('conflict', ASK_SENTENCES.noModules);
    return null;
  }

  private lifeBroken(): string | null {
    try {
      return this.deps.life.broken();
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Now, the zone and what the rules check against

  /** The Life zone (life.status().timezone), else the zone in settings or the Mac's. */
  private zone(): { timezone: string; currency: string | null } {
    const s = this.ctx.settings.get().life;
    try {
      const st = this.deps.life.status();
      return { timezone: st.timezone, currency: st.currency };
    } catch {
      const tz = s.timezone && isValidTimeZone(s.timezone) ? s.timezone : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
      return { timezone: tz, currency: s.currency };
    }
  }

  /** Today and now in the Life zone, read from one instant. */
  private now(): { today: string; now: string; timezone: string; currency: string | null } {
    const z = this.zone();
    const at = new Date(this.ctx.clock.now());
    return { today: dayKeyOf(at, z.timezone), now: hhmmOf(at, z.timezone), ...z };
  }

  /** What the parse checks an answer against now (Add needs only today and now). */
  private scope(text: string): AskScope {
    const life = this.ctx.settings.get().life;
    const { today, now } = this.now();
    return {
      today,
      now,
      modules: { todos: life.todos, food: life.food, finance: life.finance, medicines: life.medicines, posts: life.posts },
      projects: life.todos ? this.projects() : [],
      remind: asksReminder(text),
    };
  }

  private projects(): AskProject[] {
    try {
      const r = this.deps.life.todos.listProjects();
      return r.ok ? r.value.projects.map((p) => ({ id: p.id, name: p.name, status: p.status })) : [];
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Apply: a fixed switch to eight Life calls

  /** The part's switch is off (403 with its sentence), or life.db is broken (503). */
  private moduleOff(action: AskWriteAction): Refusal | null {
    const module = ASK_MODULE_OF[action.type];
    if (!this.ctx.settings.get().life[module]) return refuse('forbidden', ASK_MODULE_OFF[module]);
    const broken = this.lifeBroken();
    return broken !== null ? refuse('life_unavailable', broken) : null;
  }

  /** Life's own body, checked with its own schema before the module is called. */
  private apply(action: AskWriteAction, actor: Actor): LifeResult<{ id: string }> {
    const life = this.deps.life;
    switch (action.type) {
      case 'todo': {
        const body = TodoBodySchema.safeParse({
          title: action.title,
          ...(action.notes !== undefined ? { notes: action.notes } : {}),
          ...(action.due ? { due: action.due } : {}),
          ...(action.priority ? { priority: action.priority } : {}),
          ...(action.projectId ? { projectId: action.projectId } : {}),
          ...(action.repeat ? { repeat: { freq: action.repeat } } : {}),
        });
        return body.success ? life.todos.createTodo(body.data, actor) : refuse('invalid_request', ASK_SENTENCES.badItem);
      }
      case 'food': {
        const body = FoodBodySchema.safeParse({ day: action.day, name: action.name, kcal: action.kcal });
        return body.success ? life.food.add(body.data, actor) : refuse('invalid_request', ASK_SENTENCES.badItem);
      }
      case 'money': {
        const { type: _type, ...fields } = action;
        const body = MoneyBodySchema.safeParse(fields);
        return body.success ? life.finance.add(body.data, actor) : refuse('invalid_request', ASK_SENTENCES.badItem);
      }
      case 'post': {
        // Always an idea: Ask plans a post, the user writes and posts it.
        const body = PostBodySchema.safeParse({
          platform: action.platform,
          kind: action.kind,
          ...(action.where !== undefined ? { where: action.where } : {}),
          ...(action.title !== undefined ? { title: action.title } : {}),
          ...(action.due ? { due: action.due } : {}),
          status: 'idea',
        });
        return body.success ? life.posts.create(body.data, actor) : refuse('invalid_request', ASK_SENTENCES.badItem);
      }
    }
  }

  private remove(action: AskWriteAction, ref: string, actor: Actor): LifeResult {
    const life = this.deps.life;
    switch (action.type) {
      case 'todo':
        return life.todos.removeTodo(ref, actor);
      case 'food':
        return life.food.remove(ref, actor);
      case 'money':
        return life.finance.remove(ref, actor);
      case 'post':
        return life.posts.remove(ref, actor);
    }
  }

  // -------------------------------------------------------------------------
  // The queue and the run

  /** Start the next run when none is going. */
  private kick(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const run: Run = { ...next, epoch: this.epoch, abort: new AbortController() };
    this.running = run;
    // Never inside the caller's own request: the send that queued it answers first.
    run.done = Promise.resolve()
      .then(() => this.run(run))
      .catch((e: unknown) => {
        this.log.error('ask: a run failed', { error: errorKind(e) });
        this.finish(run, null);
      })
      .finally(() => {
        this.running = null;
        this.kick();
      });
  }

  /** The turn while `run` still counts: null after Cancel, Clear, the switch turning off or stop(). */
  private live(run: Run): AskTurn | null {
    if (run.epoch !== this.epoch) return null;
    const turn = this.turn(run.owner, run.turnId);
    return turn && unfinished(turn) ? turn : null;
  }

  private async run(run: Run): Promise<void> {
    const { ctx } = this;
    const queued = this.live(run);
    if (!queued || queued.state !== 'queued') return;
    const length = queued.text.length;
    const s = ctx.settings.get();
    const model = s.rewrite.model;
    const fallbackModel = s.rewrite.fallbackModel;
    const counts = { length, model, cards: 0, dropped: 0 };

    const via = runVia(ctx);
    if (!via) {
      this.audit(run, { ...counts, ms: 0, account: null, outcome: 'unavailable' });
      this.finish(run, { failed: 'unavailable' });
      return;
    }
    const picking = ctx.clock.now();
    const account = await this.pick(run);
    const turn = this.live(run);
    if (!turn || account === 'cancelled') {
      // Cancel, Clear, the switch or stop() while the account was picked: nothing ran.
      this.audit(run, { ...counts, ms: 0, account: null, outcome: run.why ?? 'cancelled' });
      return;
    }
    if (account === null || account === 'timeout') {
      const outcome = account === null ? 'no_account' : 'timeout';
      this.audit(run, { ...counts, ms: account === null ? 0 : Math.max(0, ctx.clock.now() - picking), account: null, outcome });
      this.finish(run, { failed: outcome });
      return;
    }
    const life = s.life;
    const input = askInput({
      ...this.now(),
      modules: { todos: life.todos, food: life.food, finance: life.finance, medicines: life.medicines, posts: life.posts },
      text: turn.text,
    });
    turn.state = 'running';
    this.changed();

    const single = 'claude' in via;
    const started = ctx.clock.now();
    let outcome: RunOutcome | null = null;
    try {
      const dir = await prepareRunDir(ctx.paths, { dir: ctx.paths.askDir, asset: ASK_PROMPT_ASSET });
      if (dir.workEntries > 0) await emptyDir(dir.cwd);
      const once = (dropped: ReadonlySet<string>) =>
        execRewrite(ctx, {
          via,
          flags: { account: single ? null : account, model, fallbackModel, effort: ASK_EFFORT, systemPromptFile: dir.systemPromptFile, dropped },
          input,
          cwd: dir.cwd,
          timeoutMs: ASK_TIMEOUT_MS,
          signal: run.abort.signal,
        });
      // Cancelled while the dir was made: nothing starts.
      if (run.abort.signal.aborted) outcome = { kind: 'cancelled' };
      else outcome = (await runDroppingRefused(once, this.learned, (option) => this.refused(option), run.abort.signal)).outcome;
    } catch (e) {
      // A code only: the run dir's path or anything else in the message stays out of the log.
      this.log.error('ask: a run could not start', { code: errorKind(e) });
    }

    const ms = Math.max(0, ctx.clock.now() - started);
    // Read against now (the answer may come a minute after it was asked), and only while the turn still counts.
    const kept = this.live(run) !== null;
    const answer = outcome?.kind === 'ok' && kept ? parseAnswer(outcome.result, this.scope(turn.text)) : null;
    const kind: AuditOutcome = run.why ?? (kept ? outcomeOf(outcome, answer !== null) : 'cancelled');
    this.audit(run, { ...counts, ms, account, outcome: kind, cards: answer?.cards.length ?? 0, dropped: answer?.dropped ?? 0 });
    this.log.info('ask: run ended', { outcome: kind, ms, cards: answer?.cards.length ?? 0, dropped: answer?.dropped ?? 0 });
    this.finish(run, answer ?? { failed: kind });
  }

  /**
   * The run's account (null: none has room), or the pick cut short: at
   * Cancel, Clear, the switch or stop() ('cancelled'), or after
   * ASK_TIMEOUT_MS ('timeout'). A read of ccw's hold list that hangs never
   * holds the queue; it is left to end on its own.
   */
  private async pick(run: Run): Promise<AccountId | null | 'cancelled' | 'timeout'> {
    const { signal } = run.abort;
    let timer: TimerId | undefined;
    let onAbort = () => {};
    const cut = new Promise<'cancelled' | 'timeout'>((resolve) => {
      onAbort = () => resolve('cancelled');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      timer = this.ctx.clock.setTimeout(() => resolve('timeout'), ASK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([pickSharedRunAccount(this.ctx, { usage: this.deps.usage, ccwLegacy: this.deps.ccwLegacy, log: this.log }), cut]);
    } finally {
      this.ctx.clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** The run's last state, when it still counts: done with the answer, or failed with its sentence; a tick. */
  private finish(run: Run, end: ParsedAnswer | { failed: AuditOutcome } | null): void {
    const turn = this.live(run);
    if (!turn) return;
    if (end && !('failed' in end)) {
      turn.state = 'done';
      if (end.reply !== undefined) turn.reply = end.reply;
      turn.cards = end.cards;
      turn.dropped = end.dropped;
    } else {
      turn.state = 'failed';
      turn.reason = failedReason(end?.failed ?? 'failed');
    }
    this.changed();
  }

  /** claude (or cswap) refused an option: one log line per option for the daemon's life. */
  private refused(option: string | null): void {
    const key = option ?? '';
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log.warn('ask: claude refused an option', { option, dropped: option !== null && DROPPABLE_OPTIONS.includes(option) });
  }

  private audit(
    run: Run,
    r: { length: number; ms: number; account: AccountId | null; model: RewriteModel; outcome: AuditOutcome; cards: number; dropped: number },
  ): void {
    const ok = r.outcome === 'ok';
    try {
      this.ctx.db.audit.append({
        ts: this.ctx.clock.iso(),
        actor: run.owner,
        action: 'ask.run',
        target: run.turnId,
        params: {
          turnId: run.turnId,
          length: r.length,
          ms: r.ms,
          account: r.account,
          model: r.model,
          promptVersion: ASK_PROMPT_VERSION,
          outcome: r.outcome,
          cards: r.cards,
          dropped: r.dropped,
        },
        result: ok ? 'ok' : 'failed',
      });
    } catch {
      this.log.error('ask: audit write failed');
    }
  }
}

export function buildAskService(ctx: DaemonContext, deps: AskDeps, opts: AskOptions = {}): AskService {
  return new AskServiceImpl(ctx, deps, opts);
}
