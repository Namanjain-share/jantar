/**
 * 0.13.0 Work's deals, pure helpers for their screens: where a deal and a
 * stage's list sit in the address, what a card says (its days in stage, its
 * next step, its close day), each stage's open and weighted value per
 * currency (never added across currencies, W17), the pipeline's totals,
 * which stage the phone opens on, how a move goes (Won and Lost ask first,
 * an open stage moves at once), the eight reasons a deal was lost, the
 * insights' periods and their words for no data ("–", never 0 %), and the
 * plans the stage and milestone editors send.
 */
import type { WorkDealCard, WorkInsightsBook, WorkLostCode, WorkStageColumn, WorkStageKind, WorkSum } from '@jantar/protocol/work';
import { formatAmount } from '../../../lib/money.js';
import { routePath, type WorkDealsShow } from '../../../lib/router.js';
import { dayLabel } from '../life/shared/DayNav.js';
import { dueWord } from './model.js';

/** A deal's place in Work (`/work?tab=deals&id=`), or the deals with a stage's page or a Today filter. */
export function dealPath(id?: string, o: { stage?: string | undefined; show?: WorkDealsShow | undefined } = {}): string {
  return routePath({ name: 'work', tab: 'deals', ...(id ? { id } : {}), ...(o.stage ? { stage: o.stage } : {}), ...(o.show ? { show: o.show } : {}) });
}

/** Insights' place. */
export const INSIGHTS_PATH = routePath({ name: 'work', tab: 'insights' });

/** What Today's Work card counts, as the deals list says them. */
export const SHOW_LABEL: Record<WorkDealsShow, string> = { nostep: 'No next step', quiet: 'Quiet', closing: 'Closing this week' };

/** The cards a Today filter keeps: open deals with no next step, quiet ones, or ones closing this week (overdue ones too). */
export function showing(cards: readonly WorkDealCard[], show: WorkDealsShow): WorkDealCard[] {
  if (show === 'nostep') return cards.filter((c) => c.kind === 'open' && !c.next);
  if (show === 'quiet') return cards.filter((c) => c.kind === 'open' && c.quiet);
  return cards.filter((c) => c.kind === 'open' && (c.closeState === 'overdue' || c.closeState === 'today' || c.closeState === 'soon'));
}

// ---------------------------------------------------------------------------
// A card's words

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 days", "1 day", "new today": how long it has sat on its stage. */
export function daysInStageText(days: number): string {
  return days === 0 ? 'new today' : plural(days, 'day', 'days');
}

/** "next Thu 15:00", "next: Send the quote" (no day), or "no next step" (W12). */
export function nextStepText(card: Pick<WorkDealCard, 'next'>, today: string): string {
  const n = card.next;
  if (!n) return 'no next step';
  return n.due ? `next ${dueWord(n.due, today)}` : `next: ${n.title}`;
}

/** "closes 30 Nov", "closes today", "close day passed 28 Nov" (ember), or null with no close day or once closed. */
export function closeText(card: Pick<WorkDealCard, 'expectedClose' | 'closeState' | 'kind'>): { text: string; late: boolean } | null {
  if (card.kind !== 'open' || !card.expectedClose) return null;
  const day = dayLabel(card.expectedClose).replace(/^\w+ /, '');
  if (card.closeState === 'overdue') return { text: `close day passed ${day}`, late: true };
  if (card.closeState === 'today') return { text: 'closes today', late: false };
  return { text: `closes ${day}`, late: false };
}

/** A closed deal's day: "won 2 Nov", "lost 28 Oct". */
export function closedText(card: Pick<WorkDealCard, 'kind' | 'wonAt' | 'lostAt'>, tzDay: (iso: string) => string): string | null {
  if (card.kind === 'won' && card.wonAt) return `won ${dayLabel(tzDay(card.wonAt)).replace(/^\w+ /, '')}`;
  if (card.kind === 'lost' && card.lostAt) return `lost ${dayLabel(tzDay(card.lostAt)).replace(/^\w+ /, '')}`;
  return null;
}

/** A card's value, or null without one. */
export function valueText(card: Pick<WorkDealCard, 'value' | 'currency'>): string | null {
  return card.value !== undefined ? formatAmount(card.value, card.currency) : null;
}

// ---------------------------------------------------------------------------
// Totals, per currency (W17)

/** The sums with something in them, the Life currency first, then by code (no currency last). */
function ordered(sums: readonly WorkSum[], first?: string | null): WorkSum[] {
  return sums
    .filter((s) => s.amount > 0)
    .sort((a, b) => {
      const rank = (s: WorkSum) => (s.currency === first ? 0 : s.currency === null ? 2 : 1);
      return rank(a) - rank(b) || (a.currency ?? '').localeCompare(b.currency ?? '');
    });
}

/**
 * A stage's totals, one line per currency: "₹6,50,000 open · ₹3,90,000 weighted"; Won's "₹4,50,000
 * won", Lost's "₹2,00,000 lost" (over the last 30 days). Nothing for a stage with no value.
 */
export function stageTotals(col: Pick<WorkStageColumn, 'kind' | 'value' | 'weighted'>, first?: string | null): string[] {
  const values = ordered(col.value, first);
  if (col.kind !== 'open') return values.map((v) => `${formatAmount(v.amount, v.currency)} ${col.kind}`);
  return values.map((v) => {
    const w = col.weighted.find((x) => x.currency === v.currency);
    const open = `${formatAmount(v.amount, v.currency)} open`;
    return w && w.amount > 0 ? `${open} · ${formatAmount(w.amount, w.currency)} weighted` : open;
  });
}

/** Sums of the same currency added together (never across currencies). */
export function addSums(lists: readonly (readonly WorkSum[])[]): WorkSum[] {
  const by = new Map<string | null, number>();
  for (const l of lists) for (const s of l) by.set(s.currency, (by.get(s.currency) ?? 0) + s.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount }));
}

/**
 * The pipeline's header, one line per currency: "Open ₹14,20,000 · weighted ₹7,90,000 · won in 30 days
 * ₹4,50,000". The open stages' deals and Won's last 30 days.
 */
export function pipelineTotals(cols: readonly WorkStageColumn[], first?: string | null): string[] {
  const open = cols.filter((c) => c.kind === 'open');
  const value = addSums(open.map((c) => c.value));
  const weighted = addSums(open.map((c) => c.weighted));
  const won = addSums(cols.filter((c) => c.kind === 'won').map((c) => c.value));
  const currencies = ordered(addSums([value, won]), first).map((s) => s.currency);
  return currencies.map((cur) => {
    const amount = (list: readonly WorkSum[]) => list.find((s) => s.currency === cur)?.amount ?? 0;
    const parts: string[] = [];
    if (amount(value) > 0) parts.push(`Open ${formatAmount(amount(value), cur)}`);
    if (amount(weighted) > 0) parts.push(`weighted ${formatAmount(amount(weighted), cur)}`);
    if (amount(won) > 0) parts.push(`won in 30 days ${formatAmount(amount(won), cur)}`);
    return parts.join(' · ');
  });
}

// ---------------------------------------------------------------------------
// Stages and moves

/** The stage the phone's picker opens on: the first open stage with deals, else the first open stage. */
export function firstStage(cols: readonly WorkStageColumn[]): string | undefined {
  return (cols.find((c) => c.kind === 'open' && c.count > 0) ?? cols.find((c) => c.kind === 'open') ?? cols[0])?.id;
}

/** The cards of each stage, in the stages' order (a card whose stage is gone is left out). */
export function byStage(cards: readonly WorkDealCard[], cols: readonly Pick<WorkStageColumn, 'id'>[]): Map<string, WorkDealCard[]> {
  const out = new Map<string, WorkDealCard[]>(cols.map((c) => [c.id, []]));
  for (const card of cards) out.get(card.stage)?.push(card);
  return out;
}

/**
 * How moving to a stage goes: Won asks "Make a project for it?" (W33), Lost asks why; an open stage moves
 * at once with Undo. Moving to the stage it is on is nothing.
 */
export type MoveStep = 'none' | 'open' | 'won' | 'lost';
export function moveStep(from: string, to: { id: string; kind: WorkStageKind }): MoveStep {
  if (from === to.id) return 'none';
  return to.kind;
}

/** The eight reasons a deal was lost, in the order the Lost sheet offers them (life-core LOST_REASON_LABELS; a test compares them). */
export const LOST_REASONS: readonly { key: WorkLostCode; label: string }[] = [
  { key: 'price', label: 'Price' },
  { key: 'timing', label: 'Bad timing' },
  { key: 'competitor', label: 'Went with a competitor' },
  { key: 'no_budget', label: 'No budget' },
  { key: 'no_response', label: 'Went quiet' },
  { key: 'not_a_fit', label: 'Not a fit' },
  { key: 'lost_internally', label: 'Killed internally' },
  { key: 'other', label: 'Other' },
];
export function lostLabel(code: WorkLostCode | undefined): string {
  return LOST_REASONS.find((r) => r.key === code)?.label ?? 'No reason given';
}

// ---------------------------------------------------------------------------
// Insights (W36): no data is "–" (the app's dash for no value, as Accounts'), never 0 %

/** The periods, as chips (life-core ANALYTICS_PERIODS; `fy` from 1 April). */
export const INSIGHT_PERIODS = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: '6m', label: '6 months' },
  { key: '12m', label: '12 months' },
  { key: 'fy', label: 'This FY' },
  { key: 'all', label: 'All' },
] as const;
export type InsightPeriod = (typeof INSIGHT_PERIODS)[number]['key'];

/** A rate as a percent ("42%"), or "–" with nothing to rate. */
export function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '–' : `${Math.round(rate * 100)}%`;
}

/** A number of days ("12 days", "1 day", "0.5 days"), or "–" with no sample. */
export function daysText(days: number | null | undefined): string {
  if (days === null || days === undefined) return '–';
  const n = Math.round(days * 10) / 10;
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/** An amount in a book's currency. */
export function money(amount: number, currency: string | null): string {
  return formatAmount(amount, currency);
}

/** "17 Oct 2025 – 15 Jan 2026" for the period's days (in the Life zone, by `dayOf`), or "All time". */
export function rangeText(period: { preset: string; from: string; to: string }, dayOf: (iso: string) => string): string {
  if (period.preset === 'all') return 'All time';
  const say = (iso: string) => new Date(`${dayOf(iso)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${say(period.from)} – ${say(period.to)}`;
}

/** A card's name: "Win rate", or "Win rate · USD" once there are books in two currencies or more. */
export function bookLabel(label: string, currency: string | null, books: number): string {
  return books > 1 ? `${label} · ${currency ?? 'no currency'}` : label;
}

/** Whether a period has anything to read: a deal closed, open, or started in it, in any currency. */
export function anyDeals(books: readonly Pick<WorkInsightsBook, 'winRate' | 'open' | 'sources'>[]): boolean {
  return books.some((b) => b.winRate.closed > 0 || b.open.count > 0 || b.sources.length > 0);
}

/** "2 won · 1 lost of 3 closed", or "Nothing closed" (W36: the rate is then "–"). */
export function closedLine(w: WorkInsightsBook['winRate']): string {
  if (w.closed === 0) return 'Nothing closed';
  return `${w.won} won · ${w.lost} lost of ${w.closed} closed`;
}

/** "1 deal", "3 deals". */
export function dealsText(n: number): string {
  return plural(n, 'deal', 'deals');
}

// ---------------------------------------------------------------------------
// The stage editor's plan (PUT /v1/work/stages)

export interface StageDraft {
  /** A kept stage's id; none for a new one. */
  id?: string | undefined;
  name: string;
  kind: WorkStageKind;
  /** Deals on it now. */
  deals: number;
  /** Its own close probability as typed ('' is the ramp). */
  probability: string;
  /** Its own quiet days as typed ('' is Work's). */
  quietDays: string;
}

export interface StagesPlan {
  ok: boolean;
  /** Why Save is off, in one sentence. */
  problem?: string;
  body?: { stages: { id?: string; name: string; probability?: number | null; quietDays?: number | null }[]; moves?: { from: string; to: string }[] };
}

const intIn = (s: string, lo: number, hi: number): number | null | 'bad' => {
  const t = s.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return 'bad';
  const n = Number(t);
  return n >= lo && n <= hi ? n : 'bad';
};

/**
 * What Save sends for the edited stages: the list in order (a kept stage by id; a new one without), each
 * open stage's own probability (0-100) and quiet days (1-90) or null for none, and, for each removed
 * stage that holds deals, the open stage its deals go to. Won and Lost stay (they can't be removed).
 */
export function stagesPlan(drafts: readonly StageDraft[], removed: readonly { id: string; deals: number; moveTo: string }[]): StagesPlan {
  if (drafts.length < 3) return { ok: false, problem: 'Keep at least three stages.' };
  if (drafts.length > 12) return { ok: false, problem: 'Twelve stages at most.' };
  if (!drafts.some((d) => d.kind === 'open')) return { ok: false, problem: 'Keep at least one open stage.' };
  const names = new Set<string>();
  const stages: NonNullable<StagesPlan['body']>['stages'] = [];
  for (const d of drafts) {
    const name = d.name.trim();
    if (!name || name.length > 30) return { ok: false, problem: 'Every stage needs a name of up to 30 characters.' };
    if (names.has(name.toLowerCase())) return { ok: false, problem: 'Two stages have the same name.' };
    names.add(name.toLowerCase());
    if (d.kind !== 'open') {
      stages.push({ ...(d.id ? { id: d.id } : {}), name });
      continue;
    }
    const probability = intIn(d.probability, 0, 100);
    const quietDays = intIn(d.quietDays, 1, 90);
    if (probability === 'bad') return { ok: false, problem: 'A probability is a whole number from 0 to 100.' };
    if (quietDays === 'bad') return { ok: false, problem: 'Quiet days are a whole number from 1 to 90.' };
    stages.push({ ...(d.id ? { id: d.id } : {}), name, probability, quietDays });
  }
  const keptOpen = new Set(drafts.filter((d) => d.kind === 'open' && d.id).map((d) => d.id));
  const moves: { from: string; to: string }[] = [];
  for (const r of removed) {
    if (r.deals === 0) continue;
    if (!keptOpen.has(r.moveTo)) return { ok: false, problem: 'Say where the deals of a removed stage go.' };
    moves.push({ from: r.id, to: r.moveTo });
  }
  return { ok: true, body: { stages, ...(moves.length ? { moves } : {}) } };
}
