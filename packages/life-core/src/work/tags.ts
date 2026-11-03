// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Contact tags — the generic classifier. Pure half only: normalization, the deterministic
// colour fallback, rename/merge planning and the editor typeahead.
//
// Tags are CANONICAL LOWERCASE. Case-insensitive dedupe at the string level is the whole
// reason a filter and a merge can agree on what "vip" is without a separate tags table.

/** v0.13 Work: a client's tag is at most 30 characters (Noblot's was 40). */
export const TAG_MAX_LENGTH = 30;

/** Palette keys — the web maps these to its own colours; core stays styling-agnostic. */
export const TAG_PALETTE = [
  "slate",
  "blue",
  "green",
  "amber",
  "rose",
  "violet",
  "teal",
  "orange",
] as const;
export type TagColor = (typeof TAG_PALETTE)[number];

/**
 * "  VIP  Client " → "vip client". Commas are stripped (the editors are comma-separated);
 * `.` and `$` are stripped too, as they always were, so a tag stays one plain word group.
 */
export function normalizeTag(raw: string): string {
  return raw
    .replace(/[,.$]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, TAG_MAX_LENGTH);
}

/** Normalize + drop blanks + dedupe, preserving first-seen order. */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Stable palette pick for a tag with no explicit colour — same tag, same colour, forever. */
export function defaultTagColor(tag: string): TagColor {
  let h = 0;
  for (const ch of normalizeTag(tag)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length]!;
}

/** Explicit colour if set, else the deterministic fallback. */
export function resolveTagColor(tag: string, colors?: Record<string, string>): TagColor {
  const explicit = colors?.[normalizeTag(tag)];
  return (TAG_PALETTE as readonly string[]).includes(explicit ?? "")
    ? (explicit as TagColor)
    : defaultTagColor(tag);
}

export type TagRenamePlan =
  | { ok: true; from: string; to: string; merge: boolean }
  | { ok: false; error: string };

/**
 * Decide what a rename actually is before touching the store. `merge:true` means the target
 * already exists, so contacts carrying BOTH must end up with one copy.
 */
export function planTagRename(from: string, to: string, existing: readonly string[]): TagRenamePlan {
  const f = normalizeTag(from);
  const t = normalizeTag(to);
  if (!f) return { ok: false, error: "tag to rename is empty" };
  if (!t) return { ok: false, error: "new tag name is empty" };
  if (f === t) return { ok: false, error: "new tag name is the same as the old one" };
  return { ok: true, from: f, to: t, merge: existing.map(normalizeTag).includes(t) };
}

const TYPEAHEAD_LIMIT = 12;

/** Editor suggestions: prefix matches first, then substring, excluding already-picked tags. */
export function tagTypeahead(
  all: readonly string[],
  query: string,
  selected: readonly string[],
): string[] {
  const q = normalizeTag(query);
  const taken = new Set(normalizeTags(selected));
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const raw of all) {
    const tag = normalizeTag(raw);
    if (!tag || taken.has(tag)) continue;
    if (!q) prefix.push(tag);
    else if (tag.startsWith(q)) prefix.push(tag);
    else if (tag.includes(q)) contains.push(tag);
  }
  return [...prefix, ...contains].slice(0, TYPEAHEAD_LIMIT);
}
