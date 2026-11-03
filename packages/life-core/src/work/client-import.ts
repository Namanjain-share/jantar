/**
 * v0.13 Work (ours, on contacts.ts and csv.ts): what an import row says, and
 * the duplicate warning.
 *
 * - A CSV's columns are mapped by their header names (name, first and last
 *   name, e-mail, phone, company, title, tags, notes, source, city, state,
 *   website, LinkedIn, kind); he can change any mapping. A column mapped to
 *   `notes` is added to the notes as "Header: value"; `skip` drops it.
 *   Work's own clients export (`Emails`, `Phones`, `Links`, `Kind`) maps
 *   itself, so the file it writes imports back as the same clients.
 * - A vCard card maps to the same fields (photos are never read).
 * - Duplicates warn and never block (W29): the identity is an e-mail, or a
 *   phone by its last 10 digits; a name match is a hint only.
 *
 * No zod and no caps here: the daemon checks each field against Work's
 * schemas and clips or drops what does not fit.
 */
import { normalizeContactEmail, normalizeContactName, normalizeContactPhone, type VCardContact } from './contacts.js';
import { normalizeTags } from './tags.js';

/** Where an imported column can go. */
export const IMPORT_FIELDS = [
  'name',
  'firstName',
  'lastName',
  'email',
  'phone',
  'company',
  'title',
  'tags',
  'notes',
  'source',
  'city',
  'state',
  'website',
  'linkedin',
  'kind',
  'skip',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** A contact's state as a column may say it; anything else leaves the default. */
export type ImportState = 'lead' | 'client' | 'past';

/** A person or a company, as a column may say it; anything else leaves the default (a person). */
export type ImportKind = 'person' | 'company';

/** One row, as Work would store it (before the daemon's caps). */
export interface ImportRow {
  name: string;
  emails: string[];
  phones: string[];
  company?: string;
  title?: string;
  tags: string[];
  notes?: string;
  source?: string;
  city?: string;
  state?: ImportState;
  /** Set only when a column says it. */
  kind?: ImportKind;
  links: string[];
}

/** Header words (folded: lower case, letters and digits only) for each field. */
const HEADER_WORDS: Record<Exclude<ImportField, 'skip'>, readonly string[]> = {
  name: ['name', 'fullname', 'contact', 'contactname', 'displayname', 'client', 'clientname'],
  firstName: ['firstname', 'first', 'givenname', 'given'],
  lastName: ['lastname', 'last', 'surname', 'familyname', 'family'],
  email: ['email', 'emails', 'emailaddress', 'emailaddresses', 'mail', 'email1', 'emailaddress1', 'workemail', 'primaryemail'],
  phone: ['phone', 'phones', 'phonenumber', 'phonenumbers', 'mobile', 'mobilenumber', 'cell', 'tel', 'telephone', 'whatsapp', 'phone1', 'primaryphone', 'workphone'],
  company: ['company', 'companyname', 'organization', 'organisation', 'org', 'business', 'account', 'accountname'],
  title: ['title', 'jobtitle', 'role', 'position', 'designation'],
  tags: ['tags', 'tag', 'labels', 'label', 'groups', 'group'],
  notes: ['notes', 'note', 'description', 'comments', 'comment', 'about'],
  source: ['source', 'leadsource', 'channel', 'referral', 'referredby'],
  city: ['city', 'town', 'location'],
  state: ['state', 'status', 'stage', 'lifecycle', 'lifecyclestage', 'type'],
  website: ['website', 'websites', 'web', 'url', 'urls', 'site', 'homepage', 'link', 'links'],
  linkedin: ['linkedin', 'linkedinurl', 'linkedinprofile'],
  kind: ['kind', 'contactkind', 'clientkind'],
};

const headerKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Each header's field by its name; a header that names nothing known is `skip`. The first column to claim a single field keeps it. */
export function guessImportMapping(headers: readonly string[]): ImportField[] {
  const taken = new Set<ImportField>();
  return headers.map((h) => {
    const key = headerKey(h);
    for (const [field, words] of Object.entries(HEADER_WORDS) as [Exclude<ImportField, 'skip'>, readonly string[]][]) {
      if (!words.includes(key)) continue;
      // Notes and tags gather any number of columns; the rest take the first one.
      if (field !== 'notes' && field !== 'tags' && taken.has(field)) return 'skip';
      taken.add(field);
      return field;
    }
    return 'skip';
  });
}

/** A column's words as a state, when they say one ("Customer" is a client, "Prospect" a lead). */
export function importState(raw: string): ImportState | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'lead' || v === 'prospect' || v === 'new' || v === 'open') return 'lead';
  if (v === 'client' || v === 'customer' || v === 'active' || v === 'won') return 'client';
  if (v === 'past' || v === 'former' || v === 'inactive' || v === 'churned' || v === 'lost') return 'past';
  return undefined;
}

/** A column's words as a kind ("Organisation" is a company, "Individual" a person). */
export function importKind(raw: string): ImportKind | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'company' || v === 'organization' || v === 'organisation' || v === 'org' || v === 'business') return 'company';
  if (v === 'person' || v === 'individual' || v === 'people' || v === 'contact') return 'person';
  return undefined;
}

/** Split a cell that may hold several values ("a@x.test; b@x.test"). */
const many = (v: string) =>
  v
    .split(/[;,\n]|\s\/\s/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * One CSV row (cells in column order) under `mapping` (one field per
 * column). The name is the name column, else first and last name joined,
 * else '' (the daemon skips a nameless row).
 */
export function importRowFields(cells: readonly string[], headers: readonly string[], mapping: readonly ImportField[]): ImportRow {
  const out: ImportRow = { name: '', emails: [], phones: [], tags: [], links: [] };
  let first = '';
  let last = '';
  const notes: string[] = [];
  mapping.forEach((field, i) => {
    const value = (cells[i] ?? '').trim();
    if (!value) return;
    switch (field) {
      case 'name':
        out.name = value;
        break;
      case 'firstName':
        first = value;
        break;
      case 'lastName':
        last = value;
        break;
      case 'email':
        out.emails.push(...many(value));
        break;
      case 'phone':
        out.phones.push(...value.split(/[;,\n]|\s\/\s/).map((s) => s.trim()).filter(Boolean));
        break;
      case 'company':
        out.company = value;
        break;
      case 'title':
        out.title = value;
        break;
      case 'tags':
        out.tags.push(...many(value));
        break;
      case 'notes':
        // A notes column reads as itself; any other column he sent to the notes keeps its header.
        notes.push(HEADER_WORDS.notes.includes(headerKey(headers[i] ?? '')) ? value : `${(headers[i] ?? '').trim() || 'Note'}: ${value}`);
        break;
      case 'source':
        out.source = value;
        break;
      case 'city':
        out.city = value;
        break;
      case 'state': {
        const s = importState(value);
        if (s) out.state = s;
        break;
      }
      case 'website':
      case 'linkedin':
        out.links.push(...many(value));
        break;
      case 'kind': {
        const k = importKind(value);
        if (k) out.kind = k;
        break;
      }
      case 'skip':
        break;
    }
  });
  if (!out.name) out.name = [first, last].filter(Boolean).join(' ');
  if (notes.length > 0) out.notes = notes.join('\n');
  out.tags = normalizeTags(out.tags);
  return out;
}

/** One vCard card as an import row (the address becomes the notes; it has no field of its own in Work). */
export function vcardRowFields(card: VCardContact): ImportRow {
  return {
    name: card.name,
    emails: [...(card.emails ?? [])],
    phones: [...(card.phones ?? [])],
    ...(card.company ? { company: card.company } : {}),
    ...(card.title ? { title: card.title } : {}),
    tags: [],
    ...(card.address ? { notes: card.address } : {}),
    links: [...(card.urls ?? [])],
  };
}

// ── the duplicate warning (W29) ──────────────────────────────────────────────────────
export type SimilarWhy = 'email' | 'phone' | 'name';

export interface SimilarProbe {
  name?: string | undefined;
  emails?: readonly string[] | undefined;
  phones?: readonly string[] | undefined;
}

export interface SimilarCandidate {
  id: string;
  name: string;
  emails: readonly string[];
  phones: readonly string[];
}

/**
 * The contacts `probe` may be, strongest first: a shared e-mail, then a
 * shared phone (its last 10 digits), then the same folded name (a hint).
 * Each contact once, by its strongest reason; at most `limit`. `skip` holds
 * ids never to offer (the probe itself, or his "not a duplicate" rulings).
 */
export function similarContacts(
  probe: SimilarProbe,
  book: readonly SimilarCandidate[],
  limit = 5,
  skip: ReadonlySet<string> = new Set(),
): { id: string; why: SimilarWhy }[] {
  const emails = new Set((probe.emails ?? []).map(normalizeContactEmail).filter(Boolean));
  const phones = new Set((probe.phones ?? []).map(normalizeContactPhone).filter(Boolean));
  const name = probe.name ? normalizeContactName(probe.name) : '';
  const rank: Record<SimilarWhy, number> = { email: 0, phone: 1, name: 2 };
  const hits: { id: string; why: SimilarWhy; order: number }[] = [];
  book.forEach((c, order) => {
    if (skip.has(c.id)) return;
    let why: SimilarWhy | null = null;
    if (emails.size > 0 && c.emails.some((e) => emails.has(normalizeContactEmail(e)))) why = 'email';
    else if (phones.size > 0 && c.phones.some((p) => phones.has(normalizeContactPhone(p)))) why = 'phone';
    else if (name && normalizeContactName(c.name) === name) why = 'name';
    if (why) hits.push({ id: c.id, why, order });
  });
  hits.sort((a, b) => rank[a.why] - rank[b.why] || a.order - b.order);
  return hits.slice(0, limit).map(({ id, why }) => ({ id, why }));
}
