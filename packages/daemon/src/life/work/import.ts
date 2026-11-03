/**
 * Work's import (W27): a CSV or vCard file he hands over (the phone's file
 * picker, or `jantar work import <file>` at the Mac), read into rows that
 * fit Work's caps, each with its duplicate warning. Never another app's
 * database, never the web.
 *
 * - CSV: columns mapped by their header names (life-core
 *   guessImportMapping) unless he changed the mapping; a column mapped to
 *   notes keeps its header. vCard: life-core parseVCard (photos are never
 *   read).
 * - Each value is checked against Work's schemas: an e-mail or phone that
 *   isn't one (a phone under 7 digits) is dropped, a link is https (an http one is upgraded, a bad
 *   one dropped), text is clipped to its cap, tags are normalized.
 * - A row with no name but a company is that company; a row with neither is
 *   skipped (counted).
 * - Duplicates warn and never block (W29): the same e-mail, then phone
 *   (its last 10 digits), then name (a hint). The default is Skip for an
 *   e-mail or phone match and Add otherwise.
 *
 * A preview is kept in memory for 30 minutes (at most 2 at a time) so the
 * phone sends the file once; nothing of it is logged.
 */
import { guessImportMapping, importRowFields, normalizeContactLink, normalizeContactPhone, normalizeTags, parseCsv, parseVCard, similarContacts, vcardRowFields, type ImportField, type ImportRow, type SimilarCandidate } from '@jantar/life-core';
import { ContactEmailSchema, ContactPhoneValueSchema, WORK_LIMITS, type WorkImportAction, type WorkImportField, type WorkImportFields, type WorkSimilarWhySchema } from '@jantar/protocol/work';
import type { z } from 'zod';

type Why = z.infer<typeof WorkSimilarWhySchema>;

/** A file read: its columns (CSV) and its rows' cells, or its cards' rows (vCard). */
export interface ImportSource {
  format: 'csv' | 'vcf';
  columns: string[];
  /** CSV: each row's cells (the header excluded). */
  cells: string[][];
  /** vCard: each card as a row. */
  cards: ImportRow[];
}

/** One previewed row: what Work would store, its warning and its default. */
export interface PreviewRow {
  index: number;
  fields: WorkImportFields;
  dup?: { id: string; name: string; why: Why };
  action: WorkImportAction;
}

/** What a file can't be, as a fixed sentence's key. */
export type ImportProblem = 'unreadable' | 'tooManyRows' | 'tooManyColumns' | 'mapping';

const clip = (v: string | undefined, n: number): string | undefined => {
  const t = v?.trim();
  return t ? t.slice(0, n).trim() : undefined;
};

/** Read a file's text. */
export function readSource(format: 'csv' | 'vcf', text: string): ImportSource | ImportProblem {
  if (format === 'vcf') {
    let cards: ImportRow[];
    try {
      cards = parseVCard(text).map(vcardRowFields);
    } catch {
      return 'unreadable';
    }
    if (cards.length === 0) return 'unreadable';
    if (cards.length > WORK_LIMITS.importRows) return 'tooManyRows';
    return { format, columns: [], cells: [], cards };
  }
  let grid: string[][];
  try {
    grid = parseCsv(text);
  } catch {
    return 'unreadable';
  }
  const [header, ...rows] = grid;
  if (!header || header.length === 0 || rows.length === 0) return 'unreadable';
  if (header.length > WORK_LIMITS.importColumns) return 'tooManyColumns';
  if (rows.length > WORK_LIMITS.importRows) return 'tooManyRows';
  return { format, columns: header.map((h) => h.trim().slice(0, 80)), cells: rows, cards: [] };
}

/** The mapping a preview uses: his, when it fits the columns, else the guessed one. */
export function mappingFor(src: ImportSource, given: readonly WorkImportField[] | undefined): WorkImportField[] | ImportProblem {
  if (src.format === 'vcf') return [];
  if (given === undefined) return guessImportMapping(src.columns);
  if (given.length !== src.columns.length) return 'mapping';
  return [...given];
}

/** One row, capped as Work stores it; null when it has no name and no company. */
export function fitRow(row: ImportRow): WorkImportFields | null {
  let name = clip(row.name, 80);
  let company = clip(row.company, 80);
  let kind: WorkImportFields['kind'] = 'person';
  if (!name && company) {
    name = company;
    company = undefined;
    kind = 'company';
  }
  if (!name) return null;
  const emails = [...new Set(row.emails.map((e) => e.trim()).filter((e) => ContactEmailSchema.safeParse(e).success))].slice(0, WORK_LIMITS.emails);
  // A "phone" under 7 digits is an extension or a typo (life-core's identity rule): an import drops it.
  const phones = [...new Set(row.phones.map((p) => p.trim()).filter((p) => ContactPhoneValueSchema.safeParse(p).success && normalizeContactPhone(p) !== ''))].slice(0, WORK_LIMITS.phones);
  const links: string[] = [];
  for (const raw of row.links) {
    const l = normalizeContactLink({ url: raw });
    if (l && l.url.length <= 300 && !links.includes(l.url)) links.push(l.url);
    if (links.length >= WORK_LIMITS.links) break;
  }
  const tags = normalizeTags(row.tags)
    .map((t) => t.slice(0, 30).trim())
    .filter(Boolean)
    .slice(0, WORK_LIMITS.tags);
  const out: WorkImportFields = { name, kind, emails, phones, tags, links };
  if (company) out.company = company;
  const title = clip(row.title, 60);
  if (title) out.title = title;
  const notes = clip(row.notes, 2000);
  if (notes) out.notes = notes;
  const source = clip(row.source, 60);
  if (source) out.source = source;
  const city = clip(row.city, 60);
  if (city) out.city = city;
  if (row.state) out.state = row.state;
  return out;
}

/** Every row of a file under `mapping`, with its warning against `book` and its default; and how many were skipped. */
export function previewRows(src: ImportSource, mapping: readonly ImportField[], book: readonly (SimilarCandidate & { name: string })[]): { rows: PreviewRow[]; skipped: number } {
  const raw = src.format === 'vcf' ? src.cards : src.cells.map((cells) => importRowFields(cells, src.columns, mapping));
  const names = new Map(book.map((c) => [c.id, c.name]));
  const rows: PreviewRow[] = [];
  let skipped = 0;
  raw.forEach((r, index) => {
    const fields = fitRow(r);
    if (!fields) {
      skipped += 1;
      return;
    }
    const hit = similarContacts({ name: fields.name, emails: fields.emails, phones: fields.phones }, book, 1)[0];
    const row: PreviewRow = { index, fields, action: hit && hit.why !== 'name' ? 'skip' : 'add' };
    if (hit) row.dup = { id: hit.id, name: names.get(hit.id) ?? '', why: hit.why };
    rows.push(row);
  });
  return { rows, skipped };
}

/** A kept preview: the file read, when it was made, and its mapping. */
export interface KeptPreview {
  id: string;
  at: number;
  src: ImportSource;
  mapping: WorkImportField[];
}

/** The previews kept for their import: at most WORK_LIMITS.importPreviews, each for WORK_LIMITS.importPreviewMs. */
export class PreviewStore {
  private readonly kept: KeptPreview[] = [];

  put(p: KeptPreview): void {
    this.kept.push(p);
    while (this.kept.length > WORK_LIMITS.importPreviews) this.kept.shift();
  }

  get(id: string, now: number): KeptPreview | null {
    this.drop(now);
    return this.kept.find((p) => p.id === id) ?? null;
  }

  remove(id: string): void {
    const i = this.kept.findIndex((p) => p.id === id);
    if (i >= 0) this.kept.splice(i, 1);
  }

  private drop(now: number): void {
    for (let i = this.kept.length - 1; i >= 0; i--) if (now - (this.kept[i]?.at ?? 0) > WORK_LIMITS.importPreviewMs) this.kept.splice(i, 1);
  }
}
