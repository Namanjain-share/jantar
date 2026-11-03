// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Contact identity — the PURE half of Work's clients: the names, e-mails and phones a duplicate
// check compares by, typed links, the initials avatar, duplicate groups, how a logged call reads,
// what counts as a touch, and vCard both ways. No db, no ids minted here: the daemon's Work
// module does the writing, this module decides what the writes should say.
//
// v0.13 Work keeps Noblot's rules and drops what Work does not have: typed contact↔contact
// edges, important dates, healthcare profiles and custom fields. A person points at one company
// by id (the daemon's `companyId`), so nothing here reasons about a free-text company. Merge
// planning comes with merging (a later phase).
import { TAG_PALETTE, type TagColor } from "./tags.js";

// ── normalization (dedupe identity) ──────────────────────────────────────────────────
const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "shri", "smt", "sri"]);

/**
 * The identity a name is compared BY: case-folded, accent-folded, punctuation-folded and
 * honorific-stripped. "Dr. Riya Sharma" and "riya sharma" are the same person.
 *
 * Letters and digits of ANY script are kept ("डेल्टा ट्रेडर्स", "山田商事"), with the marks a
 * script needs inside its words (a Devanagari vowel sign is a mark, not punctuation). A name made
 * only of symbols ("★", "—") folds to "", and "" is never an identity: callers must not match on it.
 */
export function normalizeContactName(raw: string): string {
  const folded = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Latin combining accents: José → Jose
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’]/g, "") // O'Brien → obrien (not "o brien")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  if (!folded) return "";
  const words = folded.split(" ");
  while (words.length > 1 && HONORIFICS.has(words[0]!)) words.shift();
  return words.join(" ");
}

export function normalizeContactEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Phones compare on their LAST 10 digits, so "+91 98765-43210", "098765 43210" and
 * "9876543210" are one number. Anything under 7 digits is an extension or a typo, not an
 * identity — it returns "" and never groups anyone. A shorter foreign number (7 to 9
 * digits) compares on all of its digits.
 */
export function normalizeContactPhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 7) return "";
  return digits.slice(-10);
}

// ── identity links ───────────────────────────────────────────────────────────────────
export type ContactLinkType = "linkedin" | "instagram" | "twitter" | "website" | "other";

export interface ContactLink {
  type: ContactLinkType;
  url: string;
  label?: string;
}

export interface ContactLinkInput {
  url: string;
  type?: ContactLinkType | undefined;
  label?: string | undefined;
}

const LINK_HOSTS: [RegExp, ContactLinkType][] = [
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(twitter\.com|x\.com)$/, "twitter"],
];

/** Infer a link's type from its host — the user pastes a URL, we do the typing. */
export function inferContactLinkType(url: string): ContactLinkType {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  for (const [re, type] of LINK_HOSTS) if (re.test(host)) return type;
  return "website";
}

/**
 * "linkedin.com/in/riya" → {type:"linkedin", url:"https://linkedin.com/in/riya"}. Returns
 * null for anything that still isn't a URL after the scheme is added, so a bad paste is
 * dropped rather than stored as a dead link. v0.13: an `http:` link is stored as `https:`
 * (Work keeps https links only).
 */
export function normalizeContactLink(input: ContactLinkInput): ContactLink | null {
  const raw = input.url.trim();
  if (!raw) return null;
  const url = /^https?:\/\//i.test(raw) ? raw.replace(/^http:\/\//i, "https://") : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A hostname with no dot ("not a url at all" → "not") is a typo, not a site.
  if (!parsed.hostname.includes(".")) return null;
  const label = input.label?.trim();
  return {
    type: input.type ?? inferContactLinkType(url),
    url,
    ...(label ? { label } : {}),
  };
}

// ── initials avatar ──────────────────────────────────────────────────────────────────
/** "Riya Kumari Sharma" → "RS"; "Nimbus" → "NI"; nameless → "?". */
export function contactInitials(name: string): string {
  const words = normalizeContactName(name).split(" ").filter(Boolean);
  if (words.length === 0) return "?";
  // By code point, so a letter outside the BMP is never cut in half.
  const first = Array.from(words[0]!);
  const last = Array.from(words[words.length - 1]!);
  const initials = words.length === 1 ? first.slice(0, 2).join("") : `${first[0]}${last[0]}`;
  return initials.toUpperCase();
}

/** Stable palette pick — same name, same colour, forever. Reuses the tag palette so the
 *  app has ONE set of tints, not two. */
export function contactAvatarColor(name: string): TagColor {
  let h = 0;
  for (const ch of normalizeContactName(name)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length]!;
}

// ── duplicate detection ──────────────────────────────────────────────────────────────
export interface DuplicateCandidate {
  id: string;
  name: string;
  emails: readonly string[];
  phones: readonly string[];
}

export type DuplicateReason = "email" | "name" | "phone";

export interface DuplicateGroup {
  /** The lowest contact id in the group — a stable key for the screen and for "dismissed" state. */
  key: string;
  contactIds: string[];
  reasons: DuplicateReason[];
}

/** The order-independent identity of a "these two are not duplicates" ruling. One helper so
 *  the dismissal written on both contacts and the lookup done here can never disagree. */
export function duplicatePairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Cluster contacts that share a normalized email, phone or name. TRANSITIVE: a~b on email
 * and b~c on phone yields one group of three, because merging them pairwise would other-
 * wise leave a duplicate behind. Union-find over the signature map.
 *
 * `dismissed` carries the pairs a human has already ruled "not a duplicate"
 * (`duplicatePairKey`). A group survives while ANY pair inside it is still undecided —
 * dismissing Riya~Riya Sharma must not also hide a third record neither ruling covered.
 *
 * O(n·α) over the whole contact book held in memory — fine at Work's cap (5,000).
 */
export function findDuplicateGroups(
  contacts: readonly DuplicateCandidate[],
  dismissed?: ReadonlySet<string>,
): DuplicateGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // signature → the contacts carrying it
  const bySig = new Map<string, { reason: DuplicateReason; ids: string[] }>();
  const push = (reason: DuplicateReason, value: string, id: string) => {
    if (!value) return;
    const sig = `${reason}:${value}`;
    const entry = bySig.get(sig) ?? { reason, ids: [] };
    if (!entry.ids.includes(id)) entry.ids.push(id);
    bySig.set(sig, entry);
  };

  for (const c of contacts) {
    parent.set(c.id, c.id);
    push("name", normalizeContactName(c.name), c.id);
    for (const e of c.emails) push("email", normalizeContactEmail(e), c.id);
    for (const p of c.phones) push("phone", normalizeContactPhone(p), c.id);
  }

  for (const { ids } of bySig.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);
  }

  const members = new Map<string, string[]>();
  for (const c of contacts) {
    const root = find(c.id);
    const list = members.get(root);
    if (list) list.push(c.id);
    else members.set(root, [c.id]);
  }

  const reasonsByRoot = new Map<string, Set<DuplicateReason>>();
  for (const { reason, ids } of bySig.values()) {
    if (ids.length < 2) continue;
    const root = find(ids[0]!);
    const set = reasonsByRoot.get(root) ?? new Set<DuplicateReason>();
    set.add(reason);
    reasonsByRoot.set(root, set);
  }

  const groups: DuplicateGroup[] = [];
  for (const [root, ids] of members) {
    if (ids.length < 2) continue;
    if (dismissed && allPairsDismissed(ids, dismissed)) continue;
    groups.push({
      key: [...ids].sort()[0]!,
      contactIds: ids,
      reasons: [...(reasonsByRoot.get(root) ?? [])].sort(),
    });
  }
  groups.sort((a, b) => b.contactIds.length - a.contactIds.length || a.key.localeCompare(b.key));
  return groups;
}

function allPairsDismissed(ids: readonly string[], dismissed: ReadonlySet<string>): boolean {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (!dismissed.has(duplicatePairKey(ids[i]!, ids[j]!))) return false;
    }
  }
  return true;
}

// ── the log ──────────────────────────────────────────────────────────────────────────
/** What he logs with a client (v0.13 Work's log kinds; `stage` and `created` rows are the daemon's). */
export type LogChannel = "call" | "meeting" | "email" | "message" | "note";
export type LogOutcome = "good" | "neutral" | "bad" | "no_answer";

/**
 * How a logged call/meeting/email reads in the timeline. In core so every screen words the same
 * interaction identically — the daemon stores only the structured row, never a sentence.
 */
export const LOG_CHANNEL_LABELS: Record<LogChannel, string> = {
  call: "Call",
  meeting: "Meeting",
  email: "Email",
  message: "Message",
  note: "Note",
};

/** How an outcome reads. "No answer" is a real outcome, not a missing one — the absence of
 *  `outcome` means "not graded", which is why it has no label here. */
export const LOG_OUTCOME_LABELS: Record<LogOutcome, string> = {
  good: "Went well",
  neutral: "OK",
  bad: "Went badly",
  no_answer: "No answer",
};

export interface LogLineLike {
  kind: LogChannel;
  direction?: "out" | "in" | undefined;
  minutes?: number | undefined;
  outcome?: LogOutcome | undefined;
}

/** "Outbound call · 25m · Went well"; with no direction, just the channel ("Note"). */
export function formatLogLine(row: LogLineLike): string {
  const label = LOG_CHANNEL_LABELS[row.kind];
  const parts = [row.direction === undefined ? label : `${row.direction === "in" ? "Inbound" : "Outbound"} ${label.toLowerCase()}`];
  if (row.minutes !== undefined) {
    const h = Math.floor(row.minutes / 60);
    const m = row.minutes % 60;
    parts.push(h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`);
  }
  if (row.outcome) parts.push(LOG_OUTCOME_LABELS[row.outcome]);
  return parts.join(" · ");
}

// ── what counts as a "touch" for the check-in cadence ────────────────────────────────
/**
 * Something he did WITH the client, not something done TO the record. Editing a client's
 * details, a stage move and the "created" row never reset the "quiet N days" clock, so the
 * flag never lies after a tidy-up (Noblot's default touch kinds: notes and communications).
 */
export const TOUCH_KINDS: readonly LogChannel[] = ["call", "meeting", "email", "message", "note"];

/** Whether a log row of `kind` is a touch. */
export function countsAsTouch(kind: string): boolean {
  return (TOUCH_KINDS as readonly string[]).includes(kind);
}

/** The newest touch among `rows` (ISO instants compare as strings), or null when none is a touch. */
export function lastTouchAt(rows: readonly { kind: string; at: string }[]): string | null {
  let best: string | null = null;
  for (const r of rows) if (countsAsTouch(r.kind) && (best === null || r.at > best)) best = r.at;
  return best;
}

// ── vCard interchange ────────────────────────────────────────────────────────────────
/**
 * The phone-address-book subset of a contact — what a .vcf can actually carry both ways.
 * Tags, notes, the log and follow-ups have no vCard representation and are dropped rather
 * than smuggled into NOTE. Photos are never read.
 */
export interface VCardContact {
  name: string;
  emails?: readonly string[];
  phones?: readonly string[];
  company?: string | undefined;
  title?: string | undefined;
  address?: string | undefined;
  urls?: readonly string[];
}

/** vCard escaping: backslash, comma, semicolon and newlines are the four structural chars. */
function vcardEscape(value: string): string {
  return value.replace(/([\\,;])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

function vcardUnescape(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\([\\,;])/g, "$1");
}

/** Split a structured value (N / ORG / ADR) on its UNESCAPED semicolons. Splitting after
 *  unescaping would tear "Acme\; Ltd" — one company — into two components. */
function vcardComponents(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === ";") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(vcardUnescape);
}

/**
 * Serialize to vCard 3.0 — the version every phone, Google Contacts and macOS Contacts
 * import without complaint (4.0 is still refused by parts of the Android ecosystem).
 * No 75-octet line folding: every consumer targeted accepts long lines.
 */
export function toVCard(contacts: readonly VCardContact[]): string {
  const out: string[] = [];
  for (const c of contacts) {
    out.push("BEGIN:VCARD", "VERSION:3.0");
    out.push(`FN:${vcardEscape(c.name)}`);
    // N is mandatory in 3.0; the book stores ONE display name, so the whole of it is the
    // family-name slot rather than a guess at where the given name stops.
    out.push(`N:${vcardEscape(c.name)};;;;`);
    if (c.company) out.push(`ORG:${vcardEscape(c.company)}`);
    if (c.title) out.push(`TITLE:${vcardEscape(c.title)}`);
    for (const email of c.emails ?? []) out.push(`EMAIL;TYPE=INTERNET:${vcardEscape(email)}`);
    for (const phone of c.phones ?? []) out.push(`TEL;TYPE=CELL:${vcardEscape(phone)}`);
    if (c.address) out.push(`ADR;TYPE=HOME:;;${vcardEscape(c.address)};;;;`);
    for (const url of c.urls ?? []) out.push(`URL:${vcardEscape(url)}`);
    out.push("END:VCARD");
  }
  return out.join("\r\n") + (out.length > 0 ? "\r\n" : "");
}

/**
 * Read a .vcf back. Tolerant by design — exports in the wild are 2.1, 3.0 and 4.0, with
 * arbitrary parameters and folded lines — so unknown properties (PHOTO among them) are
 * skipped rather than failing the file, and a card with no name at all is dropped (a
 * nameless contact is not a contact).
 *
 * QUOTED-PRINTABLE bodies (vCard 2.1 from very old exports) are passed through verbatim.
 */
export function parseVCard(text: string): VCardContact[] {
  // Unfold first: a continuation line begins with a space or tab and belongs to the previous.
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length > 0) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }

  const cards: VCardContact[] = [];
  let current: {
    fn?: string;
    n?: string;
    emails: string[];
    phones: string[];
    urls: string[];
    company?: string;
    title?: string;
    address?: string;
  } | null = null;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = { emails: [], phones: [], urls: [] };
      continue;
    }
    if (upper === "END:VCARD") {
      if (current) {
        const name = (current.fn ?? current.n ?? "").trim();
        if (name) {
          cards.push({
            name,
            ...(current.emails.length > 0 ? { emails: current.emails } : {}),
            ...(current.phones.length > 0 ? { phones: current.phones } : {}),
            ...(current.urls.length > 0 ? { urls: current.urls } : {}),
            ...(current.company ? { company: current.company } : {}),
            ...(current.title ? { title: current.title } : {}),
            ...(current.address ? { address: current.address } : {}),
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(";")[0]!.trim().toUpperCase();
    // vCard 4.0 groups properties as "item1.EMAIL:…" — the group prefix carries no meaning here.
    const prop = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
    const raw = line.slice(colon + 1).trim();
    if (!raw) continue;
    const value = vcardUnescape(raw);

    switch (prop) {
      case "FN":
        current.fn = value;
        break;
      case "N": {
        // "family;given;middle;prefix;suffix" → "given family", the way a human reads it.
        const [family, given] = vcardComponents(raw);
        current.n = [given, family].filter(Boolean).join(" ").trim();
        break;
      }
      case "EMAIL":
        current.emails.push(value);
        break;
      case "TEL":
        current.phones.push(value);
        break;
      case "ORG":
        current.company = vcardComponents(raw).filter(Boolean).join(", ");
        break;
      case "TITLE":
        current.title = value;
        break;
      case "ADR":
        // "pobox;ext;street;locality;region;postcode;country" — join the parts that exist.
        current.address = vcardComponents(raw)
          .map((p) => p.trim())
          .filter(Boolean)
          .join(", ");
        break;
      case "URL":
        current.urls.push(value);
        break;
      default:
        break;
    }
  }
  return cards;
}
