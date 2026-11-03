// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Stage HYGIENE — what a column knows about itself beyond its name: how many of its deals have
// gone quiet. `pipeline.ts` owns the pipeline-shape invariants and the forecast; this is
// per-column.
//
// v0.13 Work keeps the quiet threshold and the column's health. WIP limits and stage
// automations (a reminder, a tag, a close-date prompt on entering a stage) are left out with
// their tests: Work has neither (design non-goals), and a follow-up is always a todo he sets.
import { resolveQuietDays } from "./pipeline.js";

/** A stage's own quiet threshold, or the default (Work's settings). Per-stage first:
 *  "Negotiation shouldn't sit 14 days" is the whole point of the override. */
export function resolveStageQuietDays(stage: { quietDays?: number | undefined } | undefined | null, fallback: number | undefined | null): number {
  const own = stage?.quietDays;
  if (typeof own === "number" && Number.isFinite(own) && own >= 1 && own <= 365) {
    return Math.round(own);
  }
  return resolveQuietDays(fallback);
}

export interface StageHealth {
  count: number;
  /** The threshold cards on this stage are measured against. */
  quietDays: number;
  /** How many of them have sat quiet that long or longer. */
  quiet: number;
  /** null = healthy. The column's warning line. */
  warning: string | null;
}

/**
 * One column's health. `quietDaysPerCard` is days since each deal's last sign of life (a stage
 * move or a touch with its client) — NOT days-in-stage, because a deal you spoke to yesterday
 * isn't quiet just because it hasn't advanced.
 */
export function stageHealth(stage: { quietDays?: number | undefined }, quietDaysPerCard: readonly number[], fallback: number | undefined | null): StageHealth {
  const count = quietDaysPerCard.length;
  const quietDays = resolveStageQuietDays(stage, fallback);
  const quiet = quietDaysPerCard.filter((d) => d >= quietDays).length;
  return {
    count,
    quietDays,
    quiet,
    warning: quiet > 0 ? `${quiet} quiet ${quiet === 1 ? "deal" : "deals"} (${quietDays}d+)` : null,
  };
}
