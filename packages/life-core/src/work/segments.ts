// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Client lists — the ONE translation from a list's filter definition to which clients it holds,
// plus the one-line summary the screen shows under each name, and the starter lists.
//
// Why the predicate lives here rather than in the daemon: a list's members, its COUNT and any
// export of it must all agree exactly. One function, unit-tested without a database.
//
// v0.13 Work: Noblot built a Mongo filter; Work's book is at most 5,000 clients read into memory,
// so a list is an in-memory predicate over one client and its open deals. Lifecycles are Work's
// states (lead, client, past), a check-in is due by Work's rule (no touch in its days, never for
// a past client), and custom fields are not Work's (left out).
import { normalizeSource } from "./deal.js";
import { normalizeTags } from "./tags.js";

const DAY_MS = 86_400_000;

export interface ClientListFilters {
  state?: "lead" | "client" | "past" | undefined;
  kind?: "person" | "company" | undefined;
  tags?: readonly string[] | undefined;
  excludeTags?: readonly string[] | undefined;
  /** due: a check-in cadence with no touch in its days (never a past client); ok: cadenced, not due; none: no cadence. */
  cadence?: "due" | "ok" | "none" | undefined;
  /** No touch in this many days or more (never touched: counted from when it was added). */
  quietDays?: number | undefined;
  /** A touch within this many days. */
  activeWithinDays?: number | undefined;
  /** true: an open deal; false: none open (a won or lost one qualifies). */
  hasOpenDeal?: boolean | undefined;
  /** An open deal on this stage. */
  stageId?: string | undefined;
  /** The client's source, any case, whole (never a pattern). */
  source?: string | undefined;
  hasEmail?: boolean | undefined;
}

/** One client as a list reads it. */
export interface ListClient {
  state: "lead" | "client" | "past";
  kind: "person" | "company";
  tags: readonly string[];
  emails: readonly string[];
  source?: string | undefined;
  checkInDays?: number | undefined;
  lastTouchAt?: string | undefined;
  createdAt: string;
  /** The stages of its open deals. */
  openDealStages: readonly string[];
}

const daysSince = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));

/**
 * Whether a client is on a list. Every clause is AND-ed (a list narrows; it never unions). `now` is
 * injected so counts, lists and tests all agree on one instant.
 */
export function matchesClientList(c: ListClient, f: ClientListFilters, now: Date): boolean {
  if (f.state && c.state !== f.state) return false;
  if (f.kind && c.kind !== f.kind) return false;

  // An include always wins over the same tag in the exclusion list — a self-contradicting list
  // that quietly matches nothing is a worse answer than the obvious one.
  const include = normalizeTags(f.tags ?? []);
  const exclude = normalizeTags(f.excludeTags ?? []).filter((t) => !include.includes(t));
  if (include.some((t) => !c.tags.includes(t))) return false;
  if (exclude.some((t) => c.tags.includes(t))) return false;

  const idle = daysSince(c.lastTouchAt ?? c.createdAt, now);
  if (f.cadence === "none" && c.checkInDays !== undefined) return false;
  if (f.cadence === "due" || f.cadence === "ok") {
    if (c.checkInDays === undefined) return false;
    const due = c.state !== "past" && idle >= c.checkInDays;
    if ((f.cadence === "due") !== due) return false;
  }

  if (f.quietDays !== undefined && idle < f.quietDays) return false;
  if (f.activeWithinDays !== undefined && (!c.lastTouchAt || daysSince(c.lastTouchAt, now) > f.activeWithinDays)) return false;

  // false must mean "no OPEN deal" (a won or lost one qualifies), not "no deal at all".
  if (f.hasOpenDeal !== undefined && (c.openDealStages.length > 0) !== f.hasOpenDeal) return false;
  if (f.stageId && !c.openDealStages.includes(f.stageId)) return false;

  // Sources are typed by hand ("Referral" / "referral"): any case, but the WHOLE source.
  if (f.source && normalizeSource(c.source ?? "") !== normalizeSource(f.source)) return false;

  if (f.hasEmail !== undefined && (c.emails.length > 0) !== f.hasEmail) return false;
  return true;
}

/** A named list offered as a one-tap starting point on the Clients screen. */
export interface StarterList {
  id: string;
  name: string;
  filters: ClientListFilters;
}

/**
 * The starter lists. Every one is expressible in `ClientListFilters` and therefore counts and
 * lists through the same predicate as any other — a starter is a saved filter, never a special
 * case. "Needs a check-in" comes first: it is the daily queue.
 */
export function starterClientLists(): StarterList[] {
  return [
    { id: "check-in", name: "Needs a check-in", filters: { cadence: "due" } },
    { id: "open-deals", name: "Open deals", filters: { hasOpenDeal: true } },
    { id: "quiet-leads", name: "Quiet leads (14 days)", filters: { state: "lead", quietDays: 14 } },
    { id: "gone-quiet", name: "Gone quiet (30 days)", filters: { state: "client", quietDays: 30 } },
    { id: "no-email", name: "Missing an email", filters: { kind: "person", hasEmail: false } },
  ];
}

const STATE_LABEL: Record<string, string> = { lead: "Leads", client: "Clients", past: "Past" };
const CADENCE_LABEL: Record<string, string> = { due: "check-in due", ok: "check-in on track", none: "no check-in cadence" };

/** The subtitle under a list's name — so a list always says what it actually is. `stageNames`
 *  (id → name) is optional; without it a stage reads as its id rather than an invented label. */
export function describeClientList(f: ClientListFilters, stageNames?: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  if (f.state) parts.push(STATE_LABEL[f.state] ?? f.state);
  if (f.kind) parts.push(f.kind === "company" ? "Companies" : "People");
  const include = normalizeTags(f.tags ?? []);
  if (include.length > 0) parts.push(`tagged ${include.join(" + ")}`);
  const exclude = normalizeTags(f.excludeTags ?? []).filter((t) => !include.includes(t));
  if (exclude.length > 0) parts.push(`not tagged ${exclude.join(", ")}`);
  if (f.cadence) parts.push(CADENCE_LABEL[f.cadence] ?? f.cadence);
  if (f.quietDays !== undefined) parts.push(`quiet ${f.quietDays}d+`);
  if (f.activeWithinDays !== undefined) parts.push(`active in ${f.activeWithinDays}d`);
  if (f.hasOpenDeal !== undefined) parts.push(f.hasOpenDeal ? "open deal" : "no open deal");
  if (f.stageId) parts.push(`at ${stageNames?.[f.stageId] ?? f.stageId}`);
  if (f.source) parts.push(`from ${f.source}`);
  if (f.hasEmail !== undefined) parts.push(f.hasEmail ? "has email" : "no email");
  return parts.length > 0 ? parts.join(" · ") : "All clients";
}
