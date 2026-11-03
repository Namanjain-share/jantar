/**
 * Work's tables in life.db (schema 5): `work_contacts`, `work_log` and
 * `work_deals`, a few indexed columns beside each row's JSON, which is
 * checked with Work's protocol schema on every read and write. A row that
 * no longer parses is left out of every answer (never repaired, never
 * deleted) and counted in the log by table, never by content.
 *
 * - Only this folder names a `work_` table (a source scan pins it), and no
 *   statement here touches `todos` or `projects`: those are the Todos
 *   module's.
 * - Owner-only by construction: no `space` column, no person ever reaches
 *   a statement here.
 * - Every call reads `core.db` afresh: a restore swaps the handle.
 * - Nothing here logs, emits or audits a name, a phone, an e-mail or any
 *   other text of a row: table names and counts only.
 */
import { ContactSchema, DealSchema, WorkLogJsonSchema, type Contact, type Deal, type WorkLogJson, type WorkStoredLogKind } from '@jantar/protocol/work';
import { normalizeContactName } from '@jantar/life-core';
import type { LifeCore, Logger } from '../../contracts.js';

/** One work_log row as stored: its columns and its json. */
export interface LogRecord {
  id: string;
  contactId: string | null;
  dealId: string | null;
  projectId: string | null;
  meetingId: string | null;
  at: string;
  kind: WorkStoredLogKind;
  json: WorkLogJson;
}

/** A contact with its newest touch (the column, rebuilt from the log). */
export interface ContactRecord extends Contact {
  lastTouchAt?: string;
}

interface ContactRow {
  json: string;
  last_touch_at: string | null;
}

interface LogRow {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  project_id: string | null;
  meeting_id: string | null;
  at: string;
  kind: string;
  json: string;
}

/** The kinds a touch can be (life-core TOUCH_KINDS, W14), as SQL reads them. */
const TOUCH_SQL = "kind IN ('call', 'meeting', 'email', 'message', 'note') AND json_extract(json, '$.off') IS NULL";
const LOG_COLUMNS = 'id, contact_id, deal_id, project_id, meeting_id, at, kind, json';
const LOG_KINDS = new Set<string>(['call', 'meeting', 'email', 'message', 'note', 'stage', 'created']);

export class WorkRepo {
  constructor(
    private readonly core: Pick<LifeCore, 'db'>,
    private readonly log: Logger,
  ) {}

  private bad(table: string, n: number): void {
    if (n > 0) this.log.warn('life rows left out: they no longer parse', { table, rows: n });
  }

  private contacts(rows: readonly ContactRow[]): ContactRecord[] {
    const out: ContactRecord[] = [];
    let bad = 0;
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.json);
      } catch {
        bad += 1;
        continue;
      }
      const p = ContactSchema.safeParse(value);
      if (!p.success) {
        bad += 1;
        continue;
      }
      out.push(r.last_touch_at ? { ...p.data, lastTouchAt: r.last_touch_at } : p.data);
    }
    this.bad('work_contacts', bad);
    return out;
  }

  private logs(rows: readonly LogRow[]): LogRecord[] {
    const out: LogRecord[] = [];
    let bad = 0;
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.json);
      } catch {
        bad += 1;
        continue;
      }
      const p = WorkLogJsonSchema.safeParse(value);
      if (!p.success || !LOG_KINDS.has(r.kind)) {
        bad += 1;
        continue;
      }
      out.push({ id: r.id, contactId: r.contact_id, dealId: r.deal_id, projectId: r.project_id, meetingId: r.meeting_id, at: r.at, kind: r.kind as WorkStoredLogKind, json: p.data });
    }
    this.bad('work_log', bad);
    return out;
  }

  // --- contacts ----------------------------------------------------------------

  contact(id: string): ContactRecord | null {
    const r = this.core.db.prepare('SELECT json, last_touch_at FROM work_contacts WHERE id = ? AND merged_into IS NULL').get(id) as ContactRow | undefined;
    return r ? (this.contacts([r])[0] ?? null) : null;
  }

  /** Every contact (none merged away), by folded name. */
  allContacts(): ContactRecord[] {
    return this.contacts(this.core.db.prepare('SELECT json, last_touch_at FROM work_contacts WHERE merged_into IS NULL ORDER BY name_key, id').all() as unknown as ContactRow[]);
  }

  /** A company's people. */
  peopleOf(companyId: string): ContactRecord[] {
    return this.contacts(this.core.db.prepare('SELECT json, last_touch_at FROM work_contacts WHERE company_id = ? AND merged_into IS NULL ORDER BY name_key, id').all(companyId) as unknown as ContactRow[]);
  }

  /** Companies whose folded name is `key` (an exact match: "Acme" and "acme" are one). */
  companiesNamed(key: string): ContactRecord[] {
    return this.contacts(this.core.db.prepare("SELECT json, last_touch_at FROM work_contacts WHERE kind = 'company' AND name_key = ? AND merged_into IS NULL ORDER BY id").all(key) as unknown as ContactRow[]);
  }

  /** Contacts with this folded name (any kind). */
  named(key: string): ContactRecord[] {
    return this.contacts(this.core.db.prepare('SELECT json, last_touch_at FROM work_contacts WHERE name_key = ? AND merged_into IS NULL ORDER BY id').all(key) as unknown as ContactRow[]);
  }

  /** Contacts one import added. */
  ofBatch(batch: string): ContactRecord[] {
    return this.contacts(this.core.db.prepare("SELECT json, last_touch_at FROM work_contacts WHERE json_extract(json, '$.importBatch') = ? AND merged_into IS NULL").all(batch) as unknown as ContactRow[]);
  }

  contactCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM work_contacts').get() as { n: number }).n);
  }

  hasContact(id: string): boolean {
    return this.core.db.prepare('SELECT 1 AS one FROM work_contacts WHERE id = ? AND merged_into IS NULL').get(id) !== undefined;
  }

  /** Insert or update (the touch column is the log's: never written here). */
  saveContact(c: Contact): void {
    const { lastTouchAt: _t, ...rest } = c as ContactRecord;
    const json = JSON.stringify(ContactSchema.parse(rest));
    this.core.db
      .prepare(
        `INSERT INTO work_contacts (id, kind, state, company_id, name_key, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, state = excluded.state, company_id = excluded.company_id,
           name_key = excluded.name_key, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(c.id, c.kind, c.state, c.companyId ?? null, normalizeContactName(c.name), c.updatedAt, json);
  }

  /** P3b: a merged client is kept hidden (every read leaves it out), pointing at the one it went into. */
  tombstone(id: string, into: string, at: string): void {
    this.core.db.prepare('UPDATE work_contacts SET merged_into = ?, updated_at = ? WHERE id = ?').run(into, at, id);
  }

  /** P3b: a merged client's deals and log rows move to the one it went into (a meeting both were linked to keeps one row). */
  repointContact(from: string, to: string, at: string): void {
    const db = this.core.db;
    db.prepare("UPDATE work_deals SET contact_id = ?, json = json_set(json, '$.contactId', ?), updated_at = ? WHERE contact_id = ?").run(to, to, at, from);
    db.prepare('DELETE FROM work_log WHERE contact_id = ? AND meeting_id IS NOT NULL AND meeting_id IN (SELECT meeting_id FROM work_log WHERE contact_id = ? AND meeting_id IS NOT NULL)').run(from, to);
    db.prepare('UPDATE work_log SET contact_id = ? WHERE contact_id = ?').run(to, from);
  }

  deleteContact(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM work_contacts WHERE id = ?').run(id).changes) === 1;
  }

  /** The newest touch of a contact, written into its column (null: none). Called in the transaction of every log change. */
  retouch(contactId: string): void {
    this.core.db
      .prepare(`UPDATE work_contacts SET last_touch_at = (SELECT MAX(at) FROM work_log WHERE contact_id = ? AND ${TOUCH_SQL}) WHERE id = ?`)
      .run(contactId, contactId);
  }

  /** Every contact's touch rebuilt from the log (start: repairs drift). How many changed. */
  retouchAll(): number {
    return Number(
      this.core.db
        .prepare(
          `UPDATE work_contacts SET last_touch_at = (SELECT MAX(at) FROM work_log WHERE work_log.contact_id = work_contacts.id AND ${TOUCH_SQL})
           WHERE last_touch_at IS NOT (SELECT MAX(at) FROM work_log WHERE work_log.contact_id = work_contacts.id AND ${TOUCH_SQL})`,
        )
        .run().changes,
    );
  }

  // --- the log -------------------------------------------------------------------

  logRow(id: string): LogRecord | null {
    const r = this.core.db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE id = ?`).get(id) as LogRow | undefined;
    return r ? (this.logs([r])[0] ?? null) : null;
  }

  /** A contact's rows he can see (none he unlinked), newest first, older than `before` when given. */
  logOf(contactId: string, before: { at: string; id: string } | null, limit: number): LogRecord[] {
    const db = this.core.db;
    const rows = before
      ? db
          .prepare(
            `SELECT ${LOG_COLUMNS} FROM work_log WHERE contact_id = ? AND json_extract(json, '$.off') IS NULL AND (at < ? OR (at = ? AND id < ?))
             ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(contactId, before.at, before.at, before.id, limit)
      : db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE contact_id = ? AND json_extract(json, '$.off') IS NULL ORDER BY at DESC, id DESC LIMIT ?`).all(contactId, limit);
    return this.logs(rows as unknown as LogRow[]);
  }

  /** A project's rows he can see, newest first. */
  logOfProject(projectId: string, limit: number): LogRecord[] {
    const rows = this.core.db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE project_id = ? AND json_extract(json, '$.off') IS NULL ORDER BY at DESC, id DESC LIMIT ?`).all(projectId, limit);
    return this.logs(rows as unknown as LogRow[]);
  }

  /** How many rows name the contact. */
  logCountOf(contactId: string): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM work_log WHERE contact_id = ?').get(contactId) as { n: number }).n);
  }

  logCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM work_log').get() as { n: number }).n);
  }

  insertLog(r: LogRecord): void {
    this.core.db
      .prepare('INSERT INTO work_log (id, contact_id, deal_id, project_id, meeting_id, at, kind, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.contactId, r.dealId, r.projectId, r.meetingId, r.at, r.kind, JSON.stringify(WorkLogJsonSchema.parse(r.json)));
  }

  updateLog(r: LogRecord): void {
    this.core.db
      .prepare('UPDATE work_log SET contact_id = ?, deal_id = ?, project_id = ?, meeting_id = ?, at = ?, kind = ?, json = ? WHERE id = ?')
      .run(r.contactId, r.dealId, r.projectId, r.meetingId, r.at, r.kind, JSON.stringify(WorkLogJsonSchema.parse(r.json)), r.id);
  }

  deleteLog(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM work_log WHERE id = ?').run(id).changes) === 1;
  }

  /** A deleted client's rows. How many. */
  deleteLogOf(contactId: string): number {
    return Number(this.core.db.prepare('DELETE FROM work_log WHERE contact_id = ?').run(contactId).changes);
  }

  // --- meetings (rows with a meeting id) ----------------------------------------------

  /** Every row of one meeting (his, automatic and unlinked). */
  meetingRows(meetingId: string): LogRecord[] {
    return this.logs(this.core.db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE meeting_id = ? ORDER BY id`).all(meetingId) as unknown as LogRow[]);
  }

  /** Every automatic meeting row (the start's repair compares them with the meetings). */
  autoMeetingRows(): LogRecord[] {
    return this.logs(this.core.db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE meeting_id IS NOT NULL AND json_extract(json, '$.auto') = 1`).all() as unknown as LogRow[]);
  }

  /** A deleted meeting's rows. The contacts they named. */
  deleteMeeting(meetingId: string): string[] {
    const db = this.core.db;
    const contacts = (db.prepare('SELECT DISTINCT contact_id AS id FROM work_log WHERE meeting_id = ? AND contact_id IS NOT NULL').all(meetingId) as unknown as { id: string }[]).map((r) => r.id);
    db.prepare('DELETE FROM work_log WHERE meeting_id = ?').run(meetingId);
    return contacts;
  }

  // --- a deleted project (Todos' hook, inside its transaction) --------------------------

  /** A deleted project's automatic meeting links (they came from its client) and their contacts. */
  deleteAutoOfProject(projectId: string): string[] {
    const db = this.core.db;
    const contacts = (
      db.prepare("SELECT DISTINCT contact_id AS id FROM work_log WHERE project_id = ? AND meeting_id IS NOT NULL AND json_extract(json, '$.auto') = 1 AND contact_id IS NOT NULL").all(projectId) as unknown as { id: string }[]
    ).map((r) => r.id);
    db.prepare("DELETE FROM work_log WHERE project_id = ? AND meeting_id IS NOT NULL AND json_extract(json, '$.auto') = 1").run(projectId);
    return contacts;
  }

  clearProject(projectId: string, at: string): void {
    const db = this.core.db;
    db.prepare('UPDATE work_log SET project_id = NULL WHERE project_id = ?').run(projectId);
    db.prepare("UPDATE work_deals SET json = json_remove(json, '$.projectId'), updated_at = ? WHERE json_extract(json, '$.projectId') = ?").run(at, projectId);
  }

  // --- deals (P3) --------------------------------------------------------------------

  private dealRows(rows: readonly { json: string }[]): Deal[] {
    const out: Deal[] = [];
    let bad = 0;
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.json);
      } catch {
        bad += 1;
        continue;
      }
      const p = DealSchema.safeParse(value);
      if (p.success) out.push(p.data);
      else bad += 1;
    }
    this.bad('work_deals', bad);
    return out;
  }

  hasDeal(id: string): boolean {
    return this.core.db.prepare('SELECT 1 AS one FROM work_deals WHERE id = ?').get(id) !== undefined;
  }

  deal(id: string): Deal | null {
    const r = this.core.db.prepare('SELECT json FROM work_deals WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? (this.dealRows([r])[0] ?? null) : null;
  }

  /** Every deal, open or closed (oldest first). */
  allDeals(): Deal[] {
    return this.dealRows(this.core.db.prepare('SELECT json FROM work_deals ORDER BY id').all() as unknown as { json: string }[]);
  }

  /** The deals of some clients (oldest first). */
  dealsOf(contactIds: readonly string[]): Deal[] {
    if (contactIds.length === 0) return [];
    const marks = contactIds.map(() => '?').join(', ');
    return this.dealRows(this.core.db.prepare(`SELECT json FROM work_deals WHERE contact_id IN (${marks}) ORDER BY id`).all(...contactIds) as unknown as { json: string }[]);
  }

  dealCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM work_deals').get() as { n: number }).n);
  }

  openDealCount(): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM work_deals WHERE closed_at IS NULL').get() as { n: number }).n);
  }

  /** How many deals sit on each stage (open and closed). */
  dealsByStage(): Record<string, number> {
    const rows = this.core.db.prepare('SELECT stage, COUNT(*) AS n FROM work_deals GROUP BY stage').all() as unknown as { stage: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.stage, Number(r.n)]));
  }

  /** Insert or update; `closed_at` is its win or loss (null while open). */
  saveDeal(d: Deal): void {
    const json = JSON.stringify(DealSchema.parse(d));
    this.core.db
      .prepare(
        `INSERT INTO work_deals (id, contact_id, stage, closed_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET contact_id = excluded.contact_id, stage = excluded.stage, closed_at = excluded.closed_at,
           updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(d.id, d.contactId, d.stage, d.wonAt ?? d.lostAt ?? null, d.updatedAt, json);
  }

  deleteDeal(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM work_deals WHERE id = ?').run(id).changes) === 1;
  }

  /**
   * A deleted deal's own rows (its stage moves and its "added") go; a call or a note logged with it stays
   * on the client, with no deal. How many rows went.
   */
  forgetDealLog(dealId: string): number {
    const db = this.core.db;
    const n = Number(db.prepare("DELETE FROM work_log WHERE deal_id = ? AND kind IN ('stage', 'created')").run(dealId).changes);
    db.prepare('UPDATE work_log SET deal_id = NULL WHERE deal_id = ?').run(dealId);
    return n;
  }

  /** A deal's own rows (its moves and its "added") follow it to another client. */
  moveDealLog(dealId: string, contactId: string): void {
    this.core.db.prepare("UPDATE work_log SET contact_id = ? WHERE deal_id = ? AND kind IN ('stage', 'created')").run(contactId, dealId);
  }

  /** A removed stage's deals re-filed on another (a re-filing, not a move: their stage time stays). How many. */
  refileStage(from: string, to: string, at: string): number {
    return Number(
      this.core.db.prepare("UPDATE work_deals SET stage = ?, json = json_set(json, '$.stage', ?), updated_at = ? WHERE stage = ?").run(to, to, at, from).changes,
    );
  }

  /** A deal's rows he can see, newest first. */
  logOfDeal(dealId: string, limit: number): LogRecord[] {
    const rows = this.core.db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE deal_id = ? AND json_extract(json, '$.off') IS NULL ORDER BY at DESC, id DESC LIMIT ?`).all(dealId, limit);
    return this.logs(rows as unknown as LogRow[]);
  }

  /** Every deal's moves and "added" rows at or after `since` (oldest first): the funnel and time in stage. */
  stageRows(since: string): LogRecord[] {
    const rows = this.core.db.prepare(`SELECT ${LOG_COLUMNS} FROM work_log WHERE deal_id IS NOT NULL AND kind IN ('stage', 'created') AND at >= ? ORDER BY at, id`).all(since);
    return this.logs(rows as unknown as LogRow[]);
  }

  /** Open deals per contact: how many, and their values per currency (P3's rows; none before). */
  openDeals(): Map<string, { count: number; sums: { currency: string | null; amount: number }[] }> {
    const rows = this.core.db
      .prepare(
        `SELECT contact_id AS id, json_extract(json, '$.currency') AS currency, COUNT(*) AS n, SUM(COALESCE(json_extract(json, '$.value'), 0)) AS amount
           FROM work_deals WHERE closed_at IS NULL GROUP BY contact_id, currency`,
      )
      .all() as unknown as { id: string; currency: string | null; n: number; amount: number | null }[];
    const out = new Map<string, { count: number; sums: { currency: string | null; amount: number }[] }>();
    for (const r of rows) {
      const cur = out.get(r.id) ?? { count: 0, sums: [] };
      cur.count += Number(r.n);
      cur.sums.push({ currency: typeof r.currency === 'string' ? r.currency : null, amount: Number(r.amount ?? 0) });
      out.set(r.id, cur);
    }
    return out;
  }

  dealCountOf(contactId: string): number {
    return Number((this.core.db.prepare('SELECT COUNT(*) AS n FROM work_deals WHERE contact_id = ?').get(contactId) as { n: number }).n);
  }

  /** A deleted client's deals and their log rows. How many deals, and how many rows went with them. */
  deleteDealsOf(contactId: string): { deals: number; ids: string[]; log: number } {
    const db = this.core.db;
    const ids = (db.prepare('SELECT id FROM work_deals WHERE contact_id = ?').all(contactId) as unknown as { id: string }[]).map((r) => r.id);
    let log = 0;
    for (const id of ids) log += Number(db.prepare('DELETE FROM work_log WHERE deal_id = ?').run(id).changes);
    db.prepare('DELETE FROM work_deals WHERE contact_id = ?').run(contactId);
    return { deals: ids.length, ids, log };
  }
}
