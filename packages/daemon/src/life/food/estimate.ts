/**
 * Ask Claude (spec 4.6): "2 rotis and dal" goes to one isolated headless
 * `claude -p` and comes back as editable rows. Nothing is saved here: the
 * phone adds the rows it confirms as ordinary entries.
 *
 * The run is Rewrite's (rewrite/run.ts), so it is isolated the same way: the
 * same flags (no tools, no MCP, no slash commands, no hooks or user
 * settings, no persistence, one turn, our system prompt), the same env scrub
 * and PATH rule, an empty 0700 cwd. Its own run dir (paths.foodEstimateDir)
 * and system prompt (assets/food/estimate-v1.md, Appendix A). The meal is on
 * stdin only, inside `<meal>` with any "</meal>" in it escaped, never in
 * argv. The account: rewrite/pick.ts (shared with the meeting summary), so
 * never a kept or held account (cswap mode) and account 0 with `claude -p`
 * directly (single mode). A refused option
 * the run can do without is learned in this module's own set and left out
 * of the retry and of every later estimate (runDroppingRefused).
 *
 * The answer counts only as JSON that FoodEstimateSchema accepts (one code
 * fence around it is tolerated); anything else is estimate_failed with a
 * fixed sentence, so the model's words reach the phone only as checked
 * `items[].name` and `note`. One `food.estimate` audit row per estimate
 * ({ length, ms, ok, account, model, promptVersion, outcome }), never text.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FOOD_ESTIMATE_TEXT_MAX, FoodEstimateSchema, type AccountId, type FoodEstimate, type RewriteModel } from '@jantar/protocol';
import type { Actor, LifeModuleDeps, LifeResult, Logger } from '../../contracts.js';
import { actorId } from '../../core/actor.js';
import { pickSharedRunAccount, runVia } from '../../rewrite/pick.js';
import { DROPPABLE_OPTIONS, execRewrite, prepareRunDir, runDroppingRefused, type RunOutcome, type RunVia } from '../../rewrite/run.js';

/** D5: Sonnet at low effort, Haiku when Sonnet is not there. */
export const FOOD_ESTIMATE_MODEL: RewriteModel = 'sonnet';
export const FOOD_ESTIMATE_FALLBACK_MODEL: RewriteModel = 'haiku';
export const FOOD_ESTIMATE_EFFORT = 'low';
/** One short run, well under Cloudflare's 100 s cut. */
export const FOOD_ESTIMATE_TIMEOUT_MS = 45_000;
/** Bump with the prompt's text; the audit row records it. */
export const FOOD_PROMPT_VERSION = 'v1';
export const FOOD_PROMPT_ASSET = `food/estimate-${FOOD_PROMPT_VERSION}.md`;

export const ESTIMATE_SENTENCES = {
  noRunner: 'Ask Claude needs Claude Code on this Mac.',
  noAccount: 'No account has room for an estimate right now. Type the calories instead.',
  failed: "Claude couldn't estimate that. Type the calories instead.",
  empty: 'Type what you ate first.',
} as const;

/** What claude reads on stdin: the meal as data, unable to close its own tag. */
export function mealInput(text: string): string {
  return `<meal>\n${text.replace(/<\/(meal)/gi, '<\\/$1')}\n</meal>`;
}

/** The estimate in claude's result text: one JSON object, maybe inside one code fence; null when it is not a valid estimate. */
export function parseEstimate(result: string): FoodEstimate | null {
  let text = result.trim();
  const fenced = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = FoodEstimateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class FoodEstimator {
  /** Options claude refused that an estimate can do without: left out until the daemon restarts. */
  private readonly learned = new Set<string>();
  /** Refused options already logged ("" for one that couldn't be read). */
  private readonly logged = new Set<string>();
  /** Runs going now (stop() aborts them). */
  private readonly running = new Set<AbortController>();
  private readonly log: Logger;

  constructor(private readonly deps: LifeModuleDeps) {
    this.log = deps.ctx.log.child({ part: 'life', module: 'food' });
  }

  /** LifeStatus.estimate: the program a run needs is there (single mode: claude; cswap mode: cswap). */
  status(): { available: boolean; reason?: string } {
    return this.via() ? { available: true } : { available: false, reason: ESTIMATE_SENTENCES.noRunner };
  }

  async estimate(text: string, signal: AbortSignal, actor: Actor): Promise<LifeResult<FoodEstimate>> {
    const ctx = this.deps.ctx;
    const meal = text.trim();
    if (!meal || meal.length > FOOD_ESTIMATE_TEXT_MAX) return { ok: false, code: 'invalid_request', reason: ESTIMATE_SENTENCES.empty };
    const via = this.via();
    if (!via) {
      this.audit(actor, { length: meal.length, ms: 0, account: null, outcome: 'unavailable' });
      return { ok: false, code: 'unavailable', reason: ESTIMATE_SENTENCES.noRunner };
    }
    const single = 'claude' in via;
    const account = await this.pickAccount();
    if (account === null) {
      this.audit(actor, { length: meal.length, ms: 0, account: null, outcome: 'no_account' });
      return { ok: false, code: 'conflict', reason: ESTIMATE_SENTENCES.noAccount };
    }

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
    this.running.add(abort);
    const started = ctx.clock.now();
    let outcome: RunOutcome | null = null;
    try {
      const dir = await prepareRunDir(ctx.paths, { dir: ctx.paths.foodEstimateDir, asset: FOOD_PROMPT_ASSET });
      if (dir.workEntries > 0) await emptyDir(dir.cwd);
      const once = (dropped: ReadonlySet<string>) =>
        execRewrite(ctx, {
          via,
          flags: {
            account: single ? null : account,
            model: FOOD_ESTIMATE_MODEL,
            fallbackModel: FOOD_ESTIMATE_FALLBACK_MODEL,
            effort: FOOD_ESTIMATE_EFFORT,
            systemPromptFile: dir.systemPromptFile,
            dropped,
          },
          input: mealInput(meal),
          cwd: dir.cwd,
          timeoutMs: FOOD_ESTIMATE_TIMEOUT_MS,
          signal: abort.signal,
        });
      outcome = (await runDroppingRefused(once, this.learned, (option) => this.refused(option), abort.signal)).outcome;
    } catch (e) {
      // A code only: the run dir's path or anything else in the message stays out of the log.
      this.log.error('food: Ask Claude could not run', { code: (e as { code?: unknown }).code ?? (e instanceof Error ? e.name : 'unknown') });
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.running.delete(abort);
    }

    const ms = Math.max(0, ctx.clock.now() - started);
    const estimate = outcome?.kind === 'ok' ? parseEstimate(outcome.result) : null;
    const kind = outcome === null ? 'failed' : outcome.kind === 'ok' && !estimate ? 'unreadable' : outcome.kind;
    this.audit(actor, { length: meal.length, ms, account, outcome: kind });
    if (estimate) return { ok: true, value: estimate };
    if (outcome?.kind === 'unavailable') return { ok: false, code: 'unavailable', reason: ESTIMATE_SENTENCES.noRunner };
    return { ok: false, code: 'estimate_failed', reason: ESTIMATE_SENTENCES.failed };
  }

  /** Kill every run going (the daemon is stopping). */
  stop(): void {
    for (const a of this.running) a.abort();
  }

  private via(): RunVia | null {
    return runVia(this.deps.ctx);
  }

  /** As Rewrite picks: never a kept or held account, the most room first; account 0 with one login. */
  private pickAccount(): Promise<AccountId | null> {
    return pickSharedRunAccount(this.deps.ctx, { usage: this.deps.usage, ccwLegacy: this.deps.ccwLegacy, log: this.log });
  }

  /** claude (or cswap) refused an option: one log line per option for the daemon's life. */
  private refused(option: string | null): void {
    const key = option ?? '';
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log.warn('food: claude refused an option of Ask Claude', { option, dropped: option !== null && DROPPABLE_OPTIONS.includes(option) });
  }

  private audit(actor: Actor, r: { length: number; ms: number; account: AccountId | null; outcome: string }): void {
    const { ctx } = this.deps;
    const ok = r.outcome === 'ok';
    try {
      ctx.db.audit.append({
        ts: ctx.clock.iso(),
        actor: actorId(actor),
        action: 'food.estimate',
        params: { length: r.length, ms: r.ms, ok, account: r.account, model: FOOD_ESTIMATE_MODEL, promptVersion: FOOD_PROMPT_VERSION, outcome: r.outcome },
        result: ok ? 'ok' : 'failed',
      });
    } catch {
      this.log.error('food: audit write failed');
    }
  }
}

/** Empty the run's own work dir (nothing should be there: the run has no tools). */
async function emptyDir(dir: string): Promise<void> {
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}
