// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Pipeline configuration + deal maths — the PURE half of Work's deals. The daemon's Work module
// owns the writes (the stage list, moving deals off a removed stage); everything it has to
// *decide* lives here so the phone, Chat and the daemon can never disagree about what a legal
// pipeline looks like.
//
// v0.13 Work keeps Noblot's stage invariant, stage deletion, probabilities and forecast. It
// leaves out what Work does not have: task-reminder defaults, a multi-workspace threshold, stage
// checklists, the one-live-deal rule (a client can have several open deals, W9) and the lead
// CSV's deal columns (a later import).

/** A stage as these rules read it (Work's `meta.work_stages` entries carry more). */
export type StageKind = "open" | "won" | "lost";
export interface PipelineStage {
  id: string;
  name: string;
  kind: StageKind;
  order: number;
  /** Close probability in percent (open stages only; terminals are pinned). */
  probability?: number | undefined;
}

// ── quiet threshold ──────────────────────────────────────────────────────────────────
/** The out-of-the-box "this deal has gone quiet" threshold, in days. */
export const DEFAULT_QUIET_DAYS = 14;
const MAX_QUIET_DAYS = 365;

/**
 * A configured threshold, or the default. Out-of-range values fall back rather than throwing:
 * this runs inside reads, and a 0 stored by some future bug would otherwise mark the entire
 * book quiet.
 */
export function resolveQuietDays(configured: number | undefined | null): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_QUIET_DAYS;
  const n = Math.round(configured);
  if (n < 1 || n > MAX_QUIET_DAYS) return DEFAULT_QUIET_DAYS;
  return n;
}

// ── stage configuration ──────────────────────────────────────────────────────────────
/**
 * The pipeline shape invariant, as a message (null = valid). Empty is legal here (Work's own
 * schema asks for 3 to 12). A non-empty pipeline needs exactly one won and one lost stage (a
 * move to Won or Lost resolves its target by kind), and ids must be unique because a deal's
 * stage points at one.
 */
export function stageInvariantError(stages: readonly { id?: string; kind: StageKind }[]): string | null {
  if (stages.length === 0) return null;
  const ids = stages.map((s) => s.id).filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length) return "duplicate stage id";
  const won = stages.filter((s) => s.kind === "won").length;
  const lost = stages.filter((s) => s.kind === "lost").length;
  if (won !== 1 || lost !== 1) {
    return "a pipeline must have exactly one won stage and one lost stage";
  }
  return null;
}

export interface StageMigration {
  fromStageId: string;
  toStageId: string;
}

export interface BlockedStageDeletion {
  stageId: string;
  name: string;
  count: number;
}

export type StageDeletionPlan = { ok: true; moves: StageMigration[] } | { ok: false; blocked: BlockedStageDeletion[] };

/**
 * Move-then-delete. A stage that still holds deals may NOT simply disappear — silently
 * dumping its cards on "the first open stage" is how a pipeline quietly rewrites history —
 * so deleting one requires an explicit surviving destination. Empty stages delete freely.
 *
 * Returns every blocked stage at once so the UI can ask about all of them in one pass.
 */
export function planStageDeletions(
  current: readonly Pick<PipelineStage, "id" | "name">[],
  next: readonly Pick<PipelineStage, "id">[],
  countByStageId: Readonly<Record<string, number>>,
  migrations: readonly StageMigration[],
): StageDeletionPlan {
  const surviving = new Set(next.map((s) => s.id));
  const target = new Map(migrations.map((m) => [m.fromStageId, m.toStageId]));

  const moves: StageMigration[] = [];
  const blocked: BlockedStageDeletion[] = [];

  for (const stage of current) {
    if (surviving.has(stage.id)) continue;
    const count = countByStageId[stage.id] ?? 0;
    if (count === 0) continue;
    const to = target.get(stage.id);
    if (!to || !surviving.has(to)) {
      blocked.push({ stageId: stage.id, name: stage.name, count });
      continue;
    }
    moves.push({ fromStageId: stage.id, toStageId: to });
  }

  return blocked.length > 0 ? { ok: false, blocked } : { ok: true, moves };
}

// ── weighted forecast ────────────────────────────────────────────────────────────────
/**
 * Close probability per stage, in percent. Terminals are FACTS, not forecasts — won is 100
 * and lost is 0 whatever anybody typed into the settings form. Open stages use their
 * configured probability, or a positional ramp (stage i of n open → (i+1)/(n+1)) so a fresh
 * pipeline produces a sane forecast before anyone tunes anything.
 */
export function stageProbabilities(stages: readonly PipelineStage[]): Record<string, number> {
  const open = [...stages].filter((s) => s.kind === "open").sort((a, b) => a.order - b.order);
  const rampByStageId = new Map(open.map((s, i) => [s.id, Math.round((100 * (i + 1)) / (open.length + 1))]));
  const out: Record<string, number> = {};
  for (const s of stages) {
    if (s.kind === "won") out[s.id] = 100;
    else if (s.kind === "lost") out[s.id] = 0;
    else out[s.id] = s.probability ?? rampByStageId.get(s.id) ?? 0;
  }
  return out;
}

/** `amount` (minor units) × probability%, rounded to whole minor units. */
export function weightedAmount(amount: number, probability: number): number {
  return Math.round((amount * probability) / 100);
}

export interface ForecastColumn {
  stageId: string;
  kind: StageKind;
  /** Total deal value on the stage, in minor units. */
  value: number;
  probability: number;
}

export interface PipelineForecast {
  /** Un-weighted value still in play (open stages only). */
  openValue: number;
  /** Probability-weighted value still in play — the number a forecast quotes. */
  weighted: number;
  /** Already closed-won, shown alongside so the two are never added together by accident. */
  wonValue: number;
}

/** One currency's columns at a time: a caller with two currencies forecasts each separately. */
export function pipelineForecast(columns: readonly ForecastColumn[]): PipelineForecast {
  let openValue = 0;
  let weighted = 0;
  let wonValue = 0;
  for (const c of columns) {
    if (c.kind === "won") wonValue += c.value;
    else if (c.kind === "open") {
      openValue += c.value;
      weighted += weightedAmount(c.value, c.probability);
    }
  }
  return { openValue, weighted, wonValue };
}

// ── deal lifecycle ───────────────────────────────────────────────────────────────────
interface DealLike {
  wonAt?: unknown;
  lostAt?: unknown;
  [key: string]: unknown;
}

/** A deal is closed once it has been won or lost. */
export function dealIsClosed(deal: DealLike | null | undefined): boolean {
  return !!deal && (deal.wonAt !== undefined || deal.lostAt !== undefined);
}
