/**
 * v0.13 Work, P3: what Work's deal reads compute from rows it has already
 * read (no SQL here): a deal's card, each stage's column, the deals CSV and
 * the insights. The maths is life-core's (Noblot's, ported with its tests);
 * this file feeds it Work's rows.
 *
 * - Money is never added across currencies (W17): every sum is per
 *   currency, and insights run one book per currency.
 * - A deal's next step is its earliest open todo, else its client's (W12).
 * - A deal is quiet when neither a move nor a touch with its client
 *   happened in its stage's quiet days (Work's setting by default).
 */
import {
  averageDaysToClose,
  closedInPeriod,
  expectedCloseState,
  forecastByMonth,
  groupByCurrency,
  instantAt,
  lossCodeBreakdown,
  pipelineTrend,
  resolveAnalyticsPeriod,
  resolveStageQuietDays,
  revenueByMonth,
  sourcePerformance,
  stageFunnel,
  stageHealth,
  stageProbabilities,
  timeInStage,
  toCsv,
  weekWindows,
  weightedAmount,
  winRateOf,
  type AnalyticsDeal,
  type PipelineStage,
} from '@jantar/life-core';
import type { Todo } from '@jantar/protocol';
import {
  WORK_LIMITS,
  type Deal,
  type WorkDealCard,
  type WorkInsightPeriodSchema,
  type WorkInsightsBook,
  type WorkInsightsReply,
  type WorkStage,
  type WorkStageColumn,
  type WorkStageKind,
  type WorkSum,
} from '@jantar/protocol/work';
import type { z } from 'zod';
import type { ContactRecord, LogRecord } from './repo.js';

const DAY_MS = 86_400_000;
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));

/** A stage with its place and its close probability (set, or ramped by position). */
export interface StageInfo {
  stage: WorkStage;
  order: number;
  probability: number;
}

export function pipelineStages(stages: readonly WorkStage[]): PipelineStage[] {
  return stages.map((s, order) => ({ id: s.id, name: s.name, kind: s.kind, order, ...(s.probability !== undefined ? { probability: s.probability } : {}) }));
}

export function stageIndex(stages: readonly WorkStage[]): Map<string, StageInfo> {
  const probs = stageProbabilities(pipelineStages(stages));
  return new Map(stages.map((s, order) => [s.id, { stage: s, order, probability: probs[s.id] ?? 0 }]));
}

/** A deal's kind: its stage's, else (a stage gone) what its times say. */
export function dealKind(d: Deal, stages: ReadonlyMap<string, StageInfo>): WorkStageKind {
  const k = stages.get(d.stage)?.stage.kind;
  if (k) return k;
  return d.wonAt ? 'won' : d.lostAt ? 'lost' : 'open';
}

export interface CardContext {
  stages: ReadonlyMap<string, StageInfo>;
  contacts: ReadonlyMap<string, ContactRecord>;
  /** The earliest open todo of each deal, and of each client (by due). */
  nextByDeal: ReadonlyMap<string, Todo>;
  nextByClient: ReadonlyMap<string, Todo>;
  today: string;
  now: number;
  /** Work's quiet days (a stage's own wins). */
  quietDays: number;
}

/** The first open todo per deal and per client, from open todos in due order. */
export function nextSteps(dealTodos: readonly Todo[], clientTodos: readonly Todo[]): { nextByDeal: Map<string, Todo>; nextByClient: Map<string, Todo> } {
  const nextByDeal = new Map<string, Todo>();
  for (const t of dealTodos) if (t.dealId && !nextByDeal.has(t.dealId)) nextByDeal.set(t.dealId, t);
  const nextByClient = new Map<string, Todo>();
  for (const t of clientTodos) if (t.contactId && !nextByClient.has(t.contactId)) nextByClient.set(t.contactId, t);
  return { nextByDeal, nextByClient };
}

/** Days since the deal's last sign of life: its move, or a touch with its client. */
export function quietFor(d: Deal, ctx: Pick<CardContext, 'contacts' | 'now'>): number {
  const touch = ctx.contacts.get(d.contactId)?.lastTouchAt;
  const last = touch && touch > d.stageMovedAt ? touch : d.stageMovedAt;
  return daysSince(last, ctx.now);
}

export function dealCard(d: Deal, ctx: CardContext): WorkDealCard {
  const info = ctx.stages.get(d.stage);
  const kind = dealKind(d, ctx.stages);
  const client = ctx.contacts.get(d.contactId);
  const open = kind === 'open';
  const next = open ? (ctx.nextByDeal.get(d.id) ?? ctx.nextByClient.get(d.contactId)) : undefined;
  const close = open ? expectedCloseState(d.expectedClose, ctx.today) : null;
  return {
    id: d.id,
    title: d.title,
    client: { id: d.contactId, name: client?.name ?? '', ...(client?.from ? { from: client.from } : {}) },
    stage: d.stage,
    stageName: info?.stage.name ?? d.stage,
    kind,
    ...(d.value !== undefined ? { value: d.value } : {}),
    currency: d.currency ?? null,
    daysInStage: daysSince(d.stageMovedAt, ctx.now),
    ...(d.expectedClose ? { expectedClose: d.expectedClose } : {}),
    ...(close ? { closeState: close } : {}),
    ...(next ? { next: { todoId: next.id, title: next.title, ...(next.due ? { due: next.due } : {}) } } : {}),
    quiet: open && quietFor(d, ctx) >= resolveStageQuietDays(info?.stage, ctx.quietDays),
    ...(d.source ? { source: d.source } : {}),
    ...(d.business ? { business: d.business } : {}),
    ...(d.projectId ? { projectId: d.projectId } : {}),
    ...(d.wonAt ? { wonAt: d.wonAt } : {}),
    ...(d.lostAt ? { lostAt: d.lostAt } : {}),
    ...(d.lostCode ? { lostCode: d.lostCode } : {}),
    ...(d.from ? { from: d.from } : {}),
  };
}

/** Amounts per currency, in first-seen order (null: no currency), never added across. */
export function sumsOf(items: readonly { currency: string | null; amount: number }[]): WorkSum[] {
  const by = new Map<string | null, number>();
  for (const i of items) by.set(i.currency, (by.get(i.currency) ?? 0) + i.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount }));
}

/**
 * Each stage's column, in stage order: an open stage's open deals; Won's and Lost's deals closed in the
 * last `WORK_LIMITS.closedDays` days. Value and weighted value per currency; how many are quiet.
 */
export function stageColumns(deals: readonly Deal[], ctx: CardContext): WorkStageColumn[] {
  const since = ctx.now - WORK_LIMITS.closedDays * DAY_MS;
  const out: WorkStageColumn[] = [];
  for (const info of [...ctx.stages.values()].sort((a, b) => a.order - b.order)) {
    const s = info.stage;
    const on = deals.filter((d) => {
      if (d.stage !== s.id) return false;
      if (s.kind === 'open') return dealKind(d, ctx.stages) === 'open';
      const closed = d.wonAt ?? d.lostAt;
      return closed !== undefined && Date.parse(closed) >= since;
    });
    const health = stageHealth(s, s.kind === 'open' ? on.map((d) => quietFor(d, ctx)) : [], ctx.quietDays);
    out.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      probability: info.probability,
      count: on.length,
      value: sumsOf(on.map((d) => ({ currency: d.currency ?? null, amount: d.value ?? 0 }))),
      weighted: s.kind === 'lost' ? [] : sumsOf(on.map((d) => ({ currency: d.currency ?? null, amount: weightedAmount(d.value ?? 0, info.probability) }))),
      quiet: health.quiet,
    });
  }
  return out;
}

/** Hundredths as a plain decimal ("4500.00"), for a spreadsheet. */
const decimal = (v: number | undefined) => (v === undefined ? '' : `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`);

/** The deals CSV (newest first): every column a spreadsheet needs, words as he wrote them. */
export function dealsCsv(deals: readonly Deal[], ctx: Pick<CardContext, 'stages' | 'contacts'>, names: { business: ReadonlyMap<string, string>; project: ReadonlyMap<string, string> }): string {
  const head = ['Title', 'Client', 'Stage', 'Value', 'Currency', 'Expected close', 'Source', 'Business', 'Project', 'Added', 'In stage since', 'Won', 'Lost', 'Lost reason', 'Lost note'];
  const rows = [...deals]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .map((d) => [
      d.title,
      ctx.contacts.get(d.contactId)?.name ?? '',
      ctx.stages.get(d.stage)?.stage.name ?? d.stage,
      decimal(d.value),
      d.currency ?? '',
      d.expectedClose ?? '',
      d.source ?? '',
      d.business ? (names.business.get(d.business) ?? '') : '',
      d.projectId ? (names.project.get(d.projectId) ?? '') : '',
      d.createdAt,
      d.stageMovedAt,
      d.wonAt ?? '',
      d.lostAt ?? '',
      d.lostCode ?? '',
      d.lostNote ?? '',
    ]);
  return `${toCsv(head, rows)}\r\n`;
}

/** A deal as the insights read it (its close day at noon in the Life zone, so it lands in its own month). */
function analytic(d: Deal, tz: string): AnalyticsDeal {
  return {
    startedAt: new Date(d.createdAt),
    value: d.value ?? 0,
    stageId: d.stage,
    ...(d.source ? { source: d.source } : {}),
    ...(d.expectedClose ? { expectedCloseAt: instantAt(d.expectedClose, '12:00', tz) } : {}),
    ...(d.wonAt ? { wonAt: new Date(d.wonAt) } : {}),
    ...(d.lostAt ? { lostAt: new Date(d.lostAt) } : {}),
  };
}

export interface InsightsInput {
  period: z.infer<typeof WorkInsightPeriodSchema>;
  deals: readonly Deal[];
  stages: readonly WorkStage[];
  /** The deals' moves and "added" rows since the period's start (the funnel and time in stage). */
  moves: readonly LogRecord[];
  now: Date;
  tz: string;
  /** The Life currency: its book comes first. */
  currency: string | null;
}

/** Insights (W36): one book per currency for money and rates; the funnel and time in stage over every deal. */
export function insightsOf(input: InsightsInput): WorkInsightsReply {
  const { deals, tz, now } = input;
  const period = resolveAnalyticsPeriod(input.period, now, tz);
  const stages = pipelineStages(input.stages);
  const probs = stageProbabilities(stages);
  const books: WorkInsightsBook[] = [];
  for (const [currency, list] of groupByCurrency(deals)) {
    // Each deal as the maths reads it, with its loss code beside it.
    const as = list.map((d) => ({ ...analytic(d, tz), lostCode: d.lostCode }));
    const closed = closedInPeriod(as, period.from, period.to);
    const win = winRateOf(closed);
    const open = as.filter((a) => !a.wonAt && !a.lostAt);
    books.push({
      currency,
      winRate: { ...win, open: open.length },
      cycle: averageDaysToClose(closed),
      revenueByMonth: revenueByMonth(as, { from: period.from, to: period.to, tz }),
      losses: lossCodeBreakdown(closed.filter((a) => a.lostAt && !a.wonAt)),
      sources: sourcePerformance(as.filter((a) => a.startedAt >= period.from && a.startedAt <= period.to)),
      forecast: forecastByMonth(as, probs, { tz }),
      trend: pipelineTrend(as, weekWindows(period.from, period.to, tz)),
      open: {
        count: open.length,
        value: open.reduce((n, a) => n + a.value, 0),
        weighted: open.reduce((n, a) => n + weightedAmount(a.value, (a.stageId ? probs[a.stageId] : undefined) ?? 0), 0),
      },
    });
  }
  books.sort((a, b) => (a.currency === input.currency ? -1 : b.currency === input.currency ? 1 : 0));
  const ids = new Set(deals.map((d) => d.id));
  const moves = input.moves.filter((r) => r.dealId !== null && ids.has(r.dealId) && r.json.stageTo !== undefined && Date.parse(r.at) <= period.to.getTime());
  const funnel = stageFunnel(
    stages,
    moves.map((r) => (r.kind === 'stage' && r.json.stageFrom ? { fromStageId: r.json.stageFrom, toStageId: r.json.stageTo as string } : { toStageId: r.json.stageTo as string })),
  );
  const dwell = timeInStage(
    stages,
    moves.map((r) => ({ dealKey: r.dealId as string, toStageId: r.json.stageTo as string, at: new Date(r.at) })),
    now,
    deals.filter((d) => !d.wonAt && !d.lostAt).map((d) => ({ stageId: d.stage, since: new Date(d.stageMovedAt) })),
  );
  return { period: { preset: period.preset, from: period.from.toISOString(), to: period.to.toISOString() }, books, funnel, timeInStage: dwell };
}
