// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Merge planning — the PURE half of "these two clients are one": which fields a human has to rule
// on, and what the survivor looks like after absorbing the loser. The daemon's Work module does
// the writing (repointing deals, the log, follow-ups, projects and people, then the tombstone);
// this decides what the survivor should say.
//
// v0.13 Work keeps Noblot's rules on Work's contact: the survivor wins every scalar it has, the
// loser only fills blanks unless the picker names the field, lists union (never lose a phone),
// and a pick can never blank a value out. Work's scalars are its own (name, company, title,
// city, source, notes, folder, check-in days); a lead, a client and past merge to the more
// active of the two; and whose words they are (`from`) moves with them, so an imported value can
// never lose its mark by landing on a clean contact (B3). Relationships, referrals, important
// dates, healthcare and custom fields are not Work's and are left out.
import { normalizeContactEmail, normalizeContactPhone } from "./contacts.js";
import { normalizeTags } from "./tags.js";

/** The scalars a merge can take from either side. */
export const MERGE_FIELDS = ["name", "companyId", "title", "city", "source", "notes", "folder", "checkInDays"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  name: "Name",
  companyId: "Company",
  title: "Title",
  city: "City",
  source: "Source",
  notes: "Notes",
  folder: "Folder",
  checkInDays: "Check-in cadence",
};

export type MergeState = "lead" | "client" | "past";

/** The part of a Work contact a merge reasons about. */
export interface MergeableContact {
  id?: string;
  name: string;
  state: MergeState;
  companyId?: string | undefined;
  title?: string | undefined;
  city?: string | undefined;
  source?: string | undefined;
  notes?: string | undefined;
  folder?: string | undefined;
  checkInDays?: number | undefined;
  phones: readonly { value: string; label?: string | undefined }[];
  emails: readonly string[];
  links: readonly string[];
  tags: readonly string[];
  from?: "import" | "meeting" | undefined;
  notDuplicateOf?: readonly string[] | undefined;
}

export interface MergedContactFields {
  name: string;
  state: MergeState;
  companyId?: string;
  title?: string;
  city?: string;
  source?: string;
  notes?: string;
  folder?: string;
  checkInDays?: number;
  phones: { value: string; label?: string }[];
  emails: string[];
  links: string[];
  tags: string[];
  from?: "import" | "meeting";
  notDuplicateOf: string[];
}

function unionBy<T>(survivor: readonly T[], loser: readonly T[], key: (v: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const v of [...survivor, ...loser]) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** How a scalar reads in the side-by-side. "" means the record has no value. */
function fieldText(c: MergeableContact, field: MergeField): string {
  const v = c[field];
  if (v === undefined) return "";
  if (field === "checkInDays") return `every ${v}d`;
  return String(v).trim();
}

/** One field where BOTH records hold a value and the two disagree — the picker's rows. */
export interface MergeConflict {
  field: MergeField;
  label: string;
  survivor: string;
  loser: string;
}

/**
 * The fields a human actually has to rule on. A field where only one side has a value is NOT
 * a conflict — `planContactMerge` already fills a survivor blank from the loser, and offering
 * a choice there would only invite blanking out the one value that exists.
 */
export function contactMergeConflicts(survivor: MergeableContact, loser: MergeableContact): MergeConflict[] {
  const out: MergeConflict[] = [];
  for (const field of MERGE_FIELDS) {
    const a = fieldText(survivor, field);
    const b = fieldText(loser, field);
    if (a && b && a !== b) out.push({ field, label: MERGE_FIELD_LABELS[field], survivor: a, loser: b });
  }
  return out;
}

/** The more active of two states: a client over a lead over past. */
function activeState(a: MergeState, b: MergeState): MergeState {
  if (a === "client" || b === "client") return "client";
  if (a === "lead" || b === "lead") return "lead";
  return "past";
}

/**
 * What the SURVIVOR should look like after absorbing the loser. Survivor wins every scalar it
 * actually has; the loser only fills blanks. Lists union (survivor-first, deduped by their
 * comparison identity), so nothing the loser knew is silently discarded — a merge should never
 * lose a phone number.
 *
 * `preferLoser` is the per-field picker's answer: the fields on which the LOSER's value wins
 * instead. It can only ever REPLACE a value, never blank one out.
 *
 * The survivor is never its own company, and neither party stays in the other's "not a
 * duplicate" list: after the merge the two are ONE.
 */
export function planContactMerge(survivor: MergeableContact, loser: MergeableContact, preferLoser: readonly MergeField[] = []): MergedContactFields {
  const parties = new Set([survivor.id, loser.id].filter((x): x is string => Boolean(x)));
  const takeLoser = new Set(preferLoser);
  const has = (v: unknown) => v !== undefined && (typeof v !== "string" || v.trim() !== "");
  const scalar = (field: MergeField): string | number | undefined => {
    const a = survivor[field];
    const b = loser[field];
    if (takeLoser.has(field) && has(b)) return b;
    return has(a) ? a : has(b) ? b : undefined;
  };
  const out: MergedContactFields = {
    name: (scalar("name") as string | undefined) ?? survivor.name,
    state: activeState(survivor.state, loser.state),
    phones: unionBy(survivor.phones, loser.phones, (p) => normalizeContactPhone(p.value) || p.value.trim()).map((p) => ({ value: p.value, ...(p.label ? { label: p.label } : {}) })),
    emails: unionBy(survivor.emails, loser.emails, (e) => normalizeContactEmail(e) || e.trim()),
    links: unionBy(survivor.links, loser.links, (l) => l),
    tags: normalizeTags([...survivor.tags, ...loser.tags]),
    notDuplicateOf: [...new Set([...(survivor.notDuplicateOf ?? []), ...(loser.notDuplicateOf ?? [])])].filter((x) => !parties.has(x)),
  };
  for (const field of ["title", "city", "source", "notes", "folder"] as const) {
    const v = scalar(field) as string | undefined;
    if (v !== undefined) out[field] = v;
  }
  const company = scalar("companyId") as string | undefined;
  if (company !== undefined && !parties.has(company)) out.companyId = company;
  const days = scalar("checkInDays") as number | undefined;
  if (days !== undefined) out.checkInDays = days;
  // Whose words: the survivor's mark, else the loser's (anything it brings may be its words).
  const from = survivor.from ?? loser.from;
  if (from) out.from = from;
  return out;
}
