// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Deal-record maths — the pure half of everything that happens to ONE opportunity after it
// exists: why it was lost, where it came from, and when it's meant to close. `pipeline.ts` owns
// the stage rules and `insights.ts` the book-wide rollups; this file sits between them.
//
// v0.13 Work keeps Noblot's rules on Jantar's shapes: a loss is one of eight fixed codes (no
// per-workspace additions), and an expected close is a DAY KEY in the Life zone, so "days until
// close" is calendar arithmetic on two keys and never reads the host's clock or zone. Won-revenue
// reconciliation belongs with invoices (a later phase) and is left out with its tests.

// ── structured lost reasons ──────────────────────────────────────────────────────────
/** THE loss taxonomy. A free-text note rides alongside (`lostNote`) for the detail that never
 *  fits a bucket — the code is what a breakdown can actually count, and free text alone is why
 *  "too expensive" / "price" / "cost" reads as three unrelated losses. */
export const LOST_REASON_CODES = [
  "price",
  "timing",
  "competitor",
  "no_budget",
  "no_response",
  "not_a_fit",
  "lost_internally",
  "other",
] as const;
export type LostReasonCode = (typeof LOST_REASON_CODES)[number];

export const LOST_REASON_LABELS: Record<LostReasonCode, string> = {
  price: "Price",
  timing: "Bad timing",
  competitor: "Went with a competitor",
  no_budget: "No budget",
  no_response: "Went quiet",
  not_a_fit: "Not a fit",
  lost_internally: "Killed internally",
  other: "Other",
};

/** Label for one stored code ("Unspecified" when the loss was saved without one). */
export function lostReasonLabel(code: LostReasonCode | undefined | null): string {
  if (!code) return "Unspecified";
  return LOST_REASON_LABELS[code] ?? "Other";
}

export interface LostDeal {
  /** Set once the deal was lost (any truthy instant); open and won deals leave it unset. */
  lostAt?: Date | string | undefined;
  lostCode?: LostReasonCode | undefined;
  value?: number | undefined;
}

export interface LossCodeRow {
  /** null = the deal was lost without picking a reason. */
  code: LostReasonCode | null;
  label: string;
  count: number;
  /** Value walked out of the door under this reason, in minor units. */
  value: number;
  /** Share of lost deals, 0–1. */
  share: number;
}

/**
 * Losses grouped by CODE, biggest first. Only genuinely lost deals count — passing the whole
 * book in is the normal call site (the caller shouldn't have to pre-filter and get it wrong).
 */
export function lossCodeBreakdown(deals: readonly LostDeal[]): LossCodeRow[] {
  const lost = deals.filter((d) => d.lostAt !== undefined);
  if (lost.length === 0) return [];
  const by = new Map<LostReasonCode | null, { count: number; value: number }>();
  for (const d of lost) {
    const key = d.lostCode ?? null;
    const row = by.get(key) ?? { count: 0, value: 0 };
    row.count += 1;
    row.value += d.value ?? 0;
    by.set(key, row);
  }
  return [...by.entries()]
    .map(([code, row]) => ({
      code,
      label: lostReasonLabel(code),
      count: row.count,
      value: row.value,
      share: row.count / lost.length,
    }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
}

// ── sources ──────────────────────────────────────────────────────────────────────────
/** Grouping key for a source. Case and surrounding space are noise: "Referral" and "referral"
 *  are one channel, and treating them as two is how a source report becomes useless. */
export function normalizeSource(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The spelling to STORE for a typed source: whatever is already in use for the same
 * normalized key, else the user's own trimmed text. So the tenth "Referral" joins the existing
 * nine rather than minting a tenth variant, and the first one still gets to set the casing.
 */
export function canonicalSource(raw: string, existing: readonly string[]): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed === "") return "";
  const key = normalizeSource(trimmed);
  return existing.find((e) => normalizeSource(e) === key) ?? trimmed;
}

/** Typeahead over the sources already in use — prefix matches first, then substring. */
export function sourceTypeahead(existing: readonly string[], query: string, limit = 8): string[] {
  const seen = new Map<string, string>();
  for (const e of existing) {
    const key = normalizeSource(e);
    if (key && !seen.has(key)) seen.set(key, e.trim());
  }
  const q = normalizeSource(query);
  const all = [...seen.values()].sort((a, b) => a.localeCompare(b));
  if (!q) return all.slice(0, limit);
  const prefix = all.filter((s) => normalizeSource(s).startsWith(q));
  const rest = all.filter((s) => !normalizeSource(s).startsWith(q) && normalizeSource(s).includes(q));
  return [...prefix, ...rest].slice(0, limit);
}

// ── expected close ───────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** How a still-open deal's close date reads today. Terminal deals have no state — a won deal
 *  whose date slipped is a fact, not an alarm. */
export type CloseState = "overdue" | "today" | "soon" | "later";

/** `soon` starts here — one working week of runway. */
export const CLOSING_SOON_DAYS = 7;
/** The "closing this month" window, forward from today. */
export const CLOSING_MONTH_DAYS = 31;

function utcDay(key: string): number {
  const m = DAY_KEY.exec(key);
  if (!m) throw new RangeError(`not a day key: "${key}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * CALENDAR days from `today` to the close day, negative when it has passed. Both are day keys
 * already resolved in the Life zone, so this is plain calendar arithmetic: a deal due today is 0
 * all day long, and no clock change can move it.
 */
export function daysUntilClose(expectedClose: string, today: string): number {
  return Math.round((utcDay(expectedClose) - utcDay(today)) / DAY_MS);
}

export function expectedCloseState(expectedClose: string | undefined | null, today: string): CloseState | null {
  if (!expectedClose) return null;
  const days = daysUntilClose(expectedClose, today);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  return days <= CLOSING_SOON_DAYS ? "soon" : "later";
}

export type ClosingWindow = "overdue" | "week" | "month";

/**
 * The board's "closing…" filter. `week`/`month` are FORWARD windows from today (7 / 31 days) and
 * both INCLUDE anything already overdue: a deal that should have closed last Tuesday is the
 * most urgent thing in "closing this week", and hiding it behind a separate filter is how it
 * gets forgotten.
 */
export function inClosingWindow(expectedClose: string | undefined | null, window: ClosingWindow, today: string): boolean {
  if (!expectedClose) return false;
  const days = daysUntilClose(expectedClose, today);
  if (window === "overdue") return days < 0;
  return days <= (window === "week" ? CLOSING_SOON_DAYS : CLOSING_MONTH_DAYS);
}
