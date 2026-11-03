// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Pipeline insights — the PURE maths behind Work's Insights (win rate, sales cycle, revenue-won
// trend, per-stage funnel, source performance, weighted forecast, weekly flow, time in stage).
// Every number the daemon serves is computed here so the phone, Chat and the Mac can never
// disagree about what a "win rate" is.
//
// Two rules run through the whole file:
//   1. NO DATA IS NOT ZERO. A period with nothing closed reports `null`, never 0% and never
//      NaN — a 0% win rate is a claim about lost deals that never happened.
//   2. Still-open deals never enter a closed-deal denominator. Win rate is won/(won+lost).
//
// Money is integer minor units throughout. v0.13 Work never adds currencies together (W17):
// the caller splits the book by currency (`groupByCurrency`) and runs each money figure on one
// currency at a time. Left out from Noblot: the contact → deal sequence (Work's deals are rows
// of their own with a created time) and the free-text loss breakdown (Work counts loss CODES,
// `deal.ts` lossCodeBreakdown). Added: the Indian financial year as a period (`fy`, from
// 1 April in the Life zone).
import { TZDate } from "@date-fns/tz";
import { weightedAmount, type PipelineStage } from "./pipeline.js";

/** A deal flattened for analysis: one row per opportunity. */
export interface AnalyticsDeal {
  /** When the opportunity began — the clock days-to-close measures from. */
  startedAt: Date;
  /** Deal value in minor units; 0 when unpriced (an unpriced deal is still a deal). */
  value: number;
  stageId?: string;
  source?: string;
  expectedCloseAt?: Date;
  wonAt?: Date;
  lostAt?: Date;
}

export type DealOutcome = "won" | "lost" | "open";

/** won beats lost if both markers are somehow set (the state machine clears the loser). */
export function dealOutcome(deal: Pick<AnalyticsDeal, "wonAt" | "lostAt">): DealOutcome {
  if (deal.wonAt) return "won";
  if (deal.lostAt) return "lost";
  return "open";
}

/** The instant a deal closed, or null while it is still in play. */
export function dealClosedAt(deal: Pick<AnalyticsDeal, "wonAt" | "lostAt">): Date | null {
  return deal.wonAt ?? deal.lostAt ?? null;
}

/** Deals whose CLOSE date falls in [from, to]. Open deals are never "closed in a period". */
export function closedInPeriod<T extends Pick<AnalyticsDeal, "wonAt" | "lostAt">>(deals: readonly T[], from: Date, to: Date): T[] {
  return deals.filter((d) => {
    const at = dealClosedAt(d);
    return at !== null && at >= from && at <= to;
  });
}

/** One book per currency (null: deals with no currency), in first-seen order. Money is never summed across them. */
export function groupByCurrency<T extends { currency?: string | null | undefined }>(deals: readonly T[]): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>();
  for (const d of deals) {
    const key = d.currency ?? null;
    const list = out.get(key);
    if (list) list.push(d);
    else out.set(key, [d]);
  }
  return out;
}

// ── win rate ─────────────────────────────────────────────────────────────────────────
export interface WinRate {
  won: number;
  lost: number;
  /** won + lost — the ONLY denominator. */
  closed: number;
  /** Still in play; reported for context, never counted against the rate. */
  open: number;
  /** won / closed, or null when nothing closed ("no data" — never 0%, never NaN). */
  rate: number | null;
}

export function winRateOf(deals: readonly Pick<AnalyticsDeal, "wonAt" | "lostAt">[]): WinRate {
  let won = 0;
  let lost = 0;
  let open = 0;
  for (const d of deals) {
    const o = dealOutcome(d);
    if (o === "won") won++;
    else if (o === "lost") lost++;
    else open++;
  }
  const closed = won + lost;
  return { won, lost, closed, open, rate: closed === 0 ? null : won / closed };
}

// ── sales cycle ──────────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

export interface CycleStats {
  /** Mean days from deal start to win, or null when nothing has been won. */
  averageDays: number | null;
  sample: number;
  fastestDays: number | null;
  slowestDays: number | null;
}

/**
 * Days-to-close over WON deals — the sales-cycle number. Losses are excluded on purpose: a
 * deal that died in month nine is not "a nine-month sale", and mixing the two produces a
 * cycle length that no forecast can use. A backdated close clamps to 0 rather than reporting
 * negative days.
 */
export function averageDaysToClose(deals: readonly AnalyticsDeal[]): CycleStats {
  const spans: number[] = [];
  for (const d of deals) {
    if (!d.wonAt) continue;
    spans.push(Math.max(0, (d.wonAt.getTime() - d.startedAt.getTime()) / DAY_MS));
  }
  if (spans.length === 0) {
    return { averageDays: null, sample: 0, fastestDays: null, slowestDays: null };
  }
  const total = spans.reduce((a, b) => a + b, 0);
  return {
    averageDays: round1(total / spans.length),
    sample: spans.length,
    fastestDays: round1(Math.min(...spans)),
    slowestDays: round1(Math.max(...spans)),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── month bucketing ──────────────────────────────────────────────────────────────────
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-07" for an instant, resolved in the Life zone (a late-evening win must not land in
 *  last month because the server thinks in UTC). */
export function monthKey(at: Date, tz: string): string {
  const z = new TZDate(at.getTime(), tz);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}`;
}

/** "Jul 2026" — the chart axis label for a month key. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const idx = Number(m) - 1;
  return `${MONTH_NAMES[idx] ?? m} ${y}`;
}

/** Every month key from `from` to `to` inclusive, contiguous (so a chart has no holes). */
export function monthRange(from: Date, to: Date, tz: string): string[] {
  const start = new TZDate(from.getTime(), tz);
  const end = new TZDate(to.getTime(), tz);
  let y = start.getFullYear();
  let m = start.getMonth();
  const endY = end.getFullYear();
  const endM = end.getMonth();
  const out: string[] = [];
  // Guard against a reversed window and against a pathological range (an "all time" period on
  // a clock-skewed record) filling memory: 10 years of buckets is already unreadable.
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    if (out.length >= 120) break;
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

export interface MonthBucket {
  month: string;
  label: string;
  value: number;
  count: number;
}

export interface MonthWindow {
  from: Date;
  to: Date;
  tz: string;
}

/**
 * Revenue WON per month, zero-filled across the window. Lost and open deals contribute
 * nothing — this is money booked, not money hoped for (that's `forecastByMonth`).
 *
 * A bounded window (30d/90d/6m/12m/ytd/fy) is zero-filled end to end — picking "12 months" must
 * show 12 months, dry ones included. Only an unbounded window (>24 months, i.e. "all time" back
 * to the epoch) starts at the first win, so it charts real history instead of empty bars.
 */
export function revenueByMonth(deals: readonly AnalyticsDeal[], win: MonthWindow): MonthBucket[] {
  const wins = deals.filter((d): d is AnalyticsDeal & { wonAt: Date } => d.wonAt !== undefined && d.wonAt >= win.from && d.wonAt <= win.to);
  const firstWin = wins.reduce<Date | null>((min, d) => (min === null || d.wonAt < min ? d.wonAt : min), null);
  const span = monthRange(win.from, win.to, win.tz).length;
  const start = span > 24 ? (firstWin ?? win.to) : win.from;

  const buckets = new Map<string, { value: number; count: number }>();
  for (const key of monthRange(start, win.to, win.tz)) {
    buckets.set(key, { value: 0, count: 0 });
  }
  for (const d of wins) {
    const b = buckets.get(monthKey(d.wonAt, win.tz));
    if (!b) continue;
    b.value += d.value;
    b.count += 1;
  }
  return [...buckets].map(([month, b]) => ({ month, label: monthLabel(month), ...b }));
}

// ── source performance ───────────────────────────────────────────────────────────────
export interface SourceRow {
  /** null = no source recorded ("Unattributed" in the UI). */
  source: string | null;
  deals: number;
  won: number;
  lost: number;
  open: number;
  /** Won value, minor units. */
  revenue: number;
  /** Value still in play from this source, minor units. */
  openValue: number;
  /** won/(won+lost) for this source, or null when it has closed nothing yet. */
  winRate: number | null;
}

/** Which channels actually pay. Sorted by revenue, then by volume — an all-open source with
 *  no closes reports `winRate: null` rather than a 0% that reads like failure. */
export function sourcePerformance(deals: readonly AnalyticsDeal[]): SourceRow[] {
  const byKey = new Map<string, SourceRow>();
  for (const d of deals) {
    const raw = d.source?.trim();
    const key = raw ? raw.toLowerCase() : "";
    const row =
      byKey.get(key) ??
      ({
        source: raw ?? null,
        deals: 0,
        won: 0,
        lost: 0,
        open: 0,
        revenue: 0,
        openValue: 0,
        winRate: null,
      } satisfies SourceRow);
    row.deals += 1;
    const outcome = dealOutcome(d);
    if (outcome === "won") {
      row.won += 1;
      row.revenue += d.value;
    } else if (outcome === "lost") {
      row.lost += 1;
    } else {
      row.open += 1;
      row.openValue += d.value;
    }
    byKey.set(key, row);
  }
  return [...byKey.values()].map((r) => ({ ...r, winRate: r.won + r.lost === 0 ? null : r.won / (r.won + r.lost) })).sort((a, b) => b.revenue - a.revenue || b.deals - a.deals);
}

// ── stage funnel ─────────────────────────────────────────────────────────────────────
/** One stage move. `fromStageId` absent = the deal ENTERED the pipeline here (added on it). */
export interface StageTransition {
  fromStageId?: string;
  toStageId: string;
}

export interface FunnelRow {
  stageId: string;
  name: string;
  kind: PipelineStage["kind"];
  order: number;
  entered: number;
  exited: number;
  /** Exits to a LATER, non-lost stage — the only exits that count as progress. */
  advanced: number;
  /** Exits straight to the lost stage. */
  lostFrom: number;
  /** entered − exited: what the window left sitting here (negative when deals that entered
   *  before the window left inside it — the window is a slice, not a census). */
  net: number;
  /** advanced / entered, or null when nothing entered (no data ≠ 0% conversion). */
  conversionRate: number | null;
}

export interface StageFunnel {
  rows: FunnelRow[];
  /** Moves INTO a stage that no longer exists (deleted stage). Kept visible so the counts
   *  reconcile against the raw transition list instead of quietly losing rows. */
  unknownEntered: number;
  /** Moves OUT of a stage that no longer exists. */
  unknownExited: number;
}

/**
 * Entered/exited per stage, built from the stage-move log. Reconciliation is exact:
 *   Σ entered + unknownEntered === transitions.length
 *   Σ exited  + unknownExited  === transitions with a fromStageId
 */
export function stageFunnel(stages: readonly PipelineStage[], transitions: readonly StageTransition[]): StageFunnel {
  const rows = [...stages]
    .sort((a, b) => a.order - b.order)
    .map<FunnelRow>((s) => ({
      stageId: s.id,
      name: s.name,
      kind: s.kind,
      order: s.order,
      entered: 0,
      exited: 0,
      advanced: 0,
      lostFrom: 0,
      net: 0,
      conversionRate: null,
    }));
  const byId = new Map(rows.map((r) => [r.stageId, r]));

  let unknownEntered = 0;
  let unknownExited = 0;

  for (const t of transitions) {
    const to = byId.get(t.toStageId);
    if (to) to.entered += 1;
    else unknownEntered += 1;

    if (t.fromStageId === undefined) continue;
    const from = byId.get(t.fromStageId);
    if (!from) {
      unknownExited += 1;
      continue;
    }
    from.exited += 1;
    if (to?.kind === "lost") from.lostFrom += 1;
    else if (to && to.order > from.order) from.advanced += 1;
  }

  for (const r of rows) {
    r.net = r.entered - r.exited;
    r.conversionRate = r.entered === 0 ? null : r.advanced / r.entered;
  }

  return { rows, unknownEntered, unknownExited };
}

// ── weighted forecast by expected close month ────────────────────────────────────────
export interface ForecastMonth extends MonthBucket {
  /** value × the stage's close probability. */
  weighted: number;
}

export interface ForecastByMonth {
  months: ForecastMonth[];
  /** Open deals with no expected close date — real money, no date to hang it on. */
  unscheduled: { value: number; weighted: number; count: number };
}

/**
 * The commit-by-month view: every OPEN deal weighted by its stage probability and bucketed by
 * expected close month. A deal on a stage since deleted weights at 0 rather than NaN. Closed
 * deals are excluded — they are revenue, not forecast.
 */
export function forecastByMonth(deals: readonly AnalyticsDeal[], probabilityByStage: Readonly<Record<string, number>>, opts: { tz: string }): ForecastByMonth {
  const unscheduled = { value: 0, weighted: 0, count: 0 };
  const hits: { key: string; value: number; weighted: number }[] = [];

  for (const d of deals) {
    if (dealOutcome(d) !== "open") continue;
    const probability = (d.stageId ? probabilityByStage[d.stageId] : undefined) ?? 0;
    const weighted = weightedAmount(d.value, probability);
    if (!d.expectedCloseAt) {
      unscheduled.value += d.value;
      unscheduled.weighted += weighted;
      unscheduled.count += 1;
      continue;
    }
    hits.push({ key: monthKey(d.expectedCloseAt, opts.tz), value: d.value, weighted });
  }

  if (hits.length === 0) return { months: [], unscheduled };

  const keys = hits.map((h) => h.key).sort();
  const buckets = new Map<string, ForecastMonth>();
  for (const key of monthRange(monthStart(keys[0]!), monthStart(keys[keys.length - 1]!), "UTC")) {
    buckets.set(key, { month: key, label: monthLabel(key), value: 0, weighted: 0, count: 0 });
  }
  for (const h of hits) {
    const b = buckets.get(h.key);
    if (!b) continue;
    b.value += h.value;
    b.weighted += h.weighted;
    b.count += 1;
  }
  return { months: [...buckets.values()], unscheduled };
}

/** "2026-08" → the UTC instant of its 1st, so monthRange can walk between two keys. */
function monthStart(key: string): Date {
  const [y, m] = key.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1));
}

// ── weekly trend windows ─────────────────────────────────────────────────────────────
/** One Monday-to-Sunday bucket, resolved in the Life zone. Half-open [start, end): the last
 *  bucket of a live period runs into the future, which is what makes "this week so far" appear
 *  on the chart instead of vanishing until Sunday night. */
export interface TrendWeek {
  /** The Monday's YYYY-MM-DD in the Life zone — a LOCAL day name, never a UTC slice. */
  key: string;
  /** "6 Jul" — the chart axis label. */
  label: string;
  start: Date;
  end: Date;
}

/** The Monday 00:00 (Life-zone local) of the week containing `at`. */
function weekStartInTz(at: Date, tz: string): TZDate {
  const z = new TZDate(at.getTime(), tz);
  // getDay(): Sunday=0 … Saturday=6. Shift so Monday=0, matching every other weekly bucket.
  const offset = (z.getDay() + 6) % 7;
  return new TZDate(z.getFullYear(), z.getMonth(), z.getDate() - offset, 0, 0, 0, 0, tz);
}

function localDayKey(z: TZDate): string {
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}-${String(z.getDate()).padStart(2, "0")}`;
}

/**
 * Every Monday-start week from `from` to `to` inclusive, contiguous, in the Life zone. `cap`
 * bounds a pathological range (an "all time" period reaching back to the epoch) — a
 * two-thousand-bar chart is not a chart.
 *
 * The cap bites at the START, never the end: "all time" resolves `from` to 1970, and truncating
 * forwards would hand back sixty empty weeks of 1970 while the live book showed as ₹0 open.
 */
export function weekWindows(from: Date, to: Date, tz: string, cap = 60): TrendWeek[] {
  const out: TrendWeek[] = [];
  const last = weekStartInTz(to, tz);
  const earliest = new TZDate(last.getFullYear(), last.getMonth(), last.getDate() - 7 * (cap - 1), 0, 0, 0, 0, tz);
  let cursor = weekStartInTz(from, tz);
  if (cursor.getTime() < earliest.getTime()) cursor = earliest;
  const toMs = to.getTime();
  while (cursor.getTime() <= toMs && out.length < cap) {
    const next = new TZDate(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7, 0, 0, 0, 0, tz);
    out.push({
      key: localDayKey(cursor),
      label: `${cursor.getDate()} ${MONTH_NAMES[cursor.getMonth()]!}`,
      start: new Date(cursor.getTime()),
      end: new Date(next.getTime()),
    });
    cursor = next;
  }
  return out;
}

/** One week of pipeline flow: what came in, what closed, and what the book was worth at the end. */
export interface TrendRow {
  key: string;
  label: string;
  /** Opportunities that STARTED in this week. */
  added: number;
  won: number;
  lost: number;
  addedValue: number;
  wonValue: number;
  lostValue: number;
  /** Value still in play at the week's END — the pipeline-value trend line. */
  openValue: number;
  openCount: number;
}

/**
 * The weekly flow of the whole book: added vs won vs lost, plus the open-pipeline value at each
 * week's end. Event-derived — every date it reads (`startedAt`, `wonAt`, `lostAt`) is already on
 * the deal; nothing new is written to produce this chart.
 *
 * The trend line values each historical week at the deal's CURRENT amount, because nothing
 * keeps a per-week value history — a deal renegotiated from ₹2L to ₹5L reads as ₹5L for every
 * week it was open.
 */
export function pipelineTrend(deals: readonly AnalyticsDeal[], weeks: readonly TrendWeek[]): TrendRow[] {
  return weeks.map((w) => {
    const row: TrendRow = {
      key: w.key,
      label: w.label,
      added: 0,
      won: 0,
      lost: 0,
      addedValue: 0,
      wonValue: 0,
      lostValue: 0,
      openValue: 0,
      openCount: 0,
    };
    for (const d of deals) {
      if (d.startedAt >= w.start && d.startedAt < w.end) {
        row.added += 1;
        row.addedValue += d.value;
      }
      if (d.wonAt && d.wonAt >= w.start && d.wonAt < w.end) {
        row.won += 1;
        row.wonValue += d.value;
      }
      if (d.lostAt && d.lostAt >= w.start && d.lostAt < w.end) {
        row.lost += 1;
        row.lostValue += d.value;
      }
      // Open AS OF the week's end: started on or before it and not yet closed by then. A deal
      // closed inside the week is correctly absent from that week's standing value.
      const closedAt = dealClosedAt(d);
      if (d.startedAt < w.end && (closedAt === null || closedAt >= w.end)) {
        row.openCount += 1;
        row.openValue += d.value;
      }
    }
    return row;
  });
}

// ── time in stage ────────────────────────────────────────────────────────────────────
/** One dated stage move off the log. `dealKey` groups the moves belonging to one deal. */
export interface DealMove {
  dealKey: string;
  toStageId: string;
  at: Date;
}

/** A deal that is on an open stage RIGHT NOW, and when it landed there (its `stageMovedAt`). */
export interface OpenDealPosition {
  stageId: string;
  since: Date;
}

export interface StageDwellRow {
  stageId: string;
  name: string;
  kind: PipelineStage["kind"];
  order: number;
  /** Mean days a deal sat here before moving on. null = nothing has LEFT this stage in the
   *  window yet — which is not the same as "instant", and must never render as 0. */
  averageDays: number | null;
  /** The median is the honest headline when one abandoned deal skews the mean by months. */
  medianDays: number | null;
  /** Completed dwells behind the two figures above. */
  sample: number;
  /** Deals whose last recorded move landed them here and never left — still sitting at `now`. */
  sittingCount: number;
  /** The longest of those current dwells. THE bottleneck number: a stage with a null average
   *  because nothing ever leaves it is exactly the stage that is killing the pipeline. */
  oldestSittingDays: number | null;
}

/**
 * Average time-in-stage, reconstructed from the stage-move log: consecutive moves on the same
 * deal bracket a dwell, and the last move on a deal that is still on an open stage is a dwell
 * that hasn't finished yet.
 *
 * Only `open` stages are measured. Time "spent in Won" is not a thing.
 *
 * `openNow` is the PRESENT-TENSE half and should always be passed by a caller that windows
 * `moves` to a period: "sitting now" is a fact about today, and deriving it from a 90-day event
 * scan reports 0 stuck deals on the stage where one has been rotting for 120 — the exact
 * bottleneck the column exists to name. Without it, the trailing move on each deal is used as a
 * (window-bounded) approximation.
 */
export function timeInStage(stages: readonly PipelineStage[], moves: readonly DealMove[], now: Date, openNow?: readonly OpenDealPosition[]): StageDwellRow[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const completed = new Map<string, number[]>();
  const sitting = new Map<string, number[]>();

  const byDeal = new Map<string, DealMove[]>();
  for (const m of moves) {
    const list = byDeal.get(m.dealKey);
    if (list) list.push(m);
    else byDeal.set(m.dealKey, [m]);
  }

  for (const list of byDeal.values()) {
    const ordered = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    for (let i = 0; i < ordered.length; i++) {
      const move = ordered[i]!;
      if (byId.get(move.toStageId)?.kind !== "open") continue;
      const until = ordered[i + 1]?.at ?? now;
      const days = Math.max(0, (until.getTime() - move.at.getTime()) / DAY_MS);
      const trailing = i + 1 === ordered.length;
      // With a real `openNow` the trailing move is NOT evidence the deal is still there — it may
      // have moved on before the window opened, or since closed.
      if (trailing && openNow) continue;
      const bucket = trailing ? sitting : completed;
      const spans = bucket.get(move.toStageId);
      if (spans) spans.push(days);
      else bucket.set(move.toStageId, [days]);
    }
  }

  if (openNow) {
    for (const p of openNow) {
      if (byId.get(p.stageId)?.kind !== "open") continue;
      const days = Math.max(0, (now.getTime() - p.since.getTime()) / DAY_MS);
      const spans = sitting.get(p.stageId);
      if (spans) spans.push(days);
      else sitting.set(p.stageId, [days]);
    }
  }

  return [...stages]
    .filter((s) => s.kind === "open")
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const spans = completed.get(s.id) ?? [];
      const open = sitting.get(s.id) ?? [];
      return {
        stageId: s.id,
        name: s.name,
        kind: s.kind,
        order: s.order,
        averageDays: spans.length === 0 ? null : round1(spans.reduce((a, b) => a + b, 0) / spans.length),
        medianDays: spans.length === 0 ? null : round1(median(spans)),
        sample: spans.length,
        sittingCount: open.length,
        oldestSittingDays: open.length === 0 ? null : round1(Math.max(...open)),
      };
    });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ── period presets ───────────────────────────────────────────────────────────────────
/** `fy`: the financial year so far, from 1 April (India's); `ytd` from 1 January. */
export const ANALYTICS_PERIODS = ["30d", "90d", "6m", "12m", "ytd", "fy", "all"] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

export interface ResolvedPeriod {
  preset: AnalyticsPeriod;
  from: Date;
  to: Date;
}

/** The month the financial year starts in (0-based: April). */
const FY_START_MONTH = 3;

/** The date window a preset means, resolved in the Life zone (ytd needs the local Jan 1, fy the
 *  local 1 April, not UTC's). Rolling windows end at `now`. */
export function resolveAnalyticsPeriod(preset: AnalyticsPeriod, now: Date, tz: string): ResolvedPeriod {
  const to = now;
  if (preset === "30d") return { preset, from: new Date(now.getTime() - 30 * DAY_MS), to };
  if (preset === "90d") return { preset, from: new Date(now.getTime() - 90 * DAY_MS), to };
  if (preset === "6m") return { preset, from: monthsBack(now, 6), to };
  if (preset === "12m") return { preset, from: monthsBack(now, 12), to };
  if (preset === "ytd") {
    const z = new TZDate(now.getTime(), tz);
    return { preset, from: new Date(new TZDate(z.getFullYear(), 0, 1, 0, 0, 0, 0, tz).getTime()), to };
  }
  if (preset === "fy") {
    const z = new TZDate(now.getTime(), tz);
    const year = z.getMonth() >= FY_START_MONTH ? z.getFullYear() : z.getFullYear() - 1;
    return { preset, from: new Date(new TZDate(year, FY_START_MONTH, 1, 0, 0, 0, 0, tz).getTime()), to };
  }
  return { preset, from: new Date(Date.UTC(1970, 0, 1)), to };
}

/** N calendar months before `at`, clamping the day (Mar 31 − 1 month → Feb 28). */
function monthsBack(at: Date, months: number): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() - months;
  const day = at.getUTCDate();
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetY, targetM, Math.min(day, lastDay), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()));
}
