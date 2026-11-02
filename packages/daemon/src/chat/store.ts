/**
 * Chat's rows in chat.db (spec 0.10 B3): turns, their changes (with the
 * Undo journal), their cards (with the checked action a tap runs) and the
 * photo rows. Synchronous (node:sqlite). Every JSON column is zod-checked on
 * read; a row that fails is skipped (logged by code by the caller, never its
 * text).
 *
 * Nothing here logs, emits or audits: the service does, with ids and counts.
 */
import { z } from 'zod';
import {
  CHAT_PAGE,
  ChatChangeOpSchema,
  ChatModuleSchema,
  ChatTurnSchema,
  type ChatCard,
  type ChatChange,
  type ChatTurn,
} from '@jantar/protocol';
import type { LifeDb } from '../contracts.js';

/** A turn as stored: the phone's shape without changes and cards, plus who sent it (an actor id, for the audit). */
export const TurnRecordSchema = ChatTurnSchema.omit({ changes: true, cards: true }).extend({ by: z.string() });
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

const ChangeJsonSchema = z.object({ module: ChatModuleSchema, op: ChatChangeOpSchema, ref: z.string(), label: z.string().max(160), undoable: z.boolean() });
export type ChangeJson = z.infer<typeof ChangeJsonSchema>;

const CardJsonSchema = z.object({
  kind: z.enum(['confirm', 'do']),
  module: ChatModuleSchema,
  op: z.string().max(24),
  ref: z.string().nullable(),
  label: z.string().max(200),
  reason: z.string().optional(),
  /** The checked action the tap runs (chat/actions.ts reads it again). */
  action: z.unknown(),
});
export type CardJson = z.infer<typeof CardJsonSchema>;

export type ChangeState = ChatChange['state'];
export type CardState = ChatCard['state'];

export interface PhotoRow {
  id: string;
  turnId: string | null;
  at: string;
  bytes: number;
  w: number;
  h: number;
  type: string;
}

function parse<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export class ChatStore {
  constructor(private readonly db: LifeDb) {}

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }

  // ------------------------------------------------------------------ turns

  insertTurn(t: TurnRecord): void {
    this.db.prepare('INSERT INTO turns (id, at, state, json) VALUES (?, ?, ?, ?)').run(t.id, t.at, t.state, JSON.stringify(TurnRecordSchema.parse(t)));
  }

  turn(id: string): TurnRecord | null {
    const row = this.db.prepare('SELECT json FROM turns WHERE id = ?').get(id) as Row | undefined;
    return row ? parse(TurnRecordSchema, str(row.json)) : null;
  }

  /** Replace a turn through `fn`; false when it is gone. */
  updateTurn(id: string, fn: (t: TurnRecord) => TurnRecord): boolean {
    return this.db.tx(() => {
      const cur = this.turn(id);
      if (!cur) return false;
      const next = TurnRecordSchema.parse(fn(cur));
      this.db.prepare('UPDATE turns SET state = ?, json = ? WHERE id = ?').run(next.state, JSON.stringify(next), id);
      return true;
    });
  }

  /** The newest `limit` turns before `before` (a turn id), oldest first, and whether older ones exist. */
  page(before: string | undefined, limit = CHAT_PAGE): { turns: TurnRecord[]; older: string | null } {
    let rows: Row[];
    if (before) {
      const b = this.db.prepare('SELECT at, id FROM turns WHERE id = ?').get(before) as Row | undefined;
      if (!b) return { turns: [], older: null };
      rows = this.db
        .prepare('SELECT json FROM turns WHERE at < ? OR (at = ? AND id < ?) ORDER BY at DESC, id DESC LIMIT ?')
        .all(str(b.at), str(b.at), str(b.id), limit + 1) as Row[];
    } else rows = this.db.prepare('SELECT json FROM turns ORDER BY at DESC, id DESC LIMIT ?').all(limit + 1) as Row[];
    const more = rows.length > limit;
    const turns = rows
      .slice(0, limit)
      .map((r) => parse(TurnRecordSchema, str(r.json)))
      .filter((t): t is TurnRecord => t !== null)
      .reverse();
    return { turns, older: more && turns[0] ? turns[0].id : null };
  }

  /** The newest `limit` turns before turn `id`, oldest first (the run's history block). */
  before(id: string, limit: number): TurnRecord[] {
    return this.page(id, limit).turns;
  }

  /** Turns queued or running, oldest first. */
  unfinished(): TurnRecord[] {
    const rows = this.db.prepare("SELECT json FROM turns WHERE state IN ('queued', 'running') ORDER BY at, id").all() as Row[];
    return rows.map((r) => parse(TurnRecordSchema, str(r.json))).filter((t): t is TurnRecord => t !== null);
  }

  turnCount(): number {
    return num((this.db.prepare('SELECT COUNT(*) AS n FROM turns').get() as Row).n);
  }

  // ------------------------------------------------------------------ changes

  addChange(turnId: string, at: string, c: ChangeJson, journal: unknown): number {
    return this.db.tx(() => {
      const n = num((this.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE turn_id = ?').get(turnId) as Row).n);
      this.db
        .prepare("INSERT INTO changes (turn_id, n, at, state, json, journal) VALUES (?, ?, ?, 'done', ?, ?)")
        .run(turnId, n, at, JSON.stringify(ChangeJsonSchema.parse(c)), journal === undefined ? null : JSON.stringify(journal));
      return n;
    });
  }

  changes(turnId: string): ChatChange[] {
    const rows = this.db.prepare('SELECT n, state, json FROM changes WHERE turn_id = ? ORDER BY n').all(turnId) as Row[];
    const out: ChatChange[] = [];
    for (const r of rows) {
      const j = parse(ChangeJsonSchema, str(r.json));
      if (j) out.push({ n: num(r.n), ...j, state: str(r.state) as ChangeState });
    }
    return out;
  }

  change(turnId: string, n: number): { change: ChatChange; at: string; journal: unknown } | null {
    const r = this.db.prepare('SELECT n, at, state, json, journal FROM changes WHERE turn_id = ? AND n = ?').get(turnId, n) as Row | undefined;
    if (!r) return null;
    const j = parse(ChangeJsonSchema, str(r.json));
    if (!j) return null;
    let journal: unknown = null;
    if (typeof r.journal === 'string') {
      try {
        journal = JSON.parse(r.journal);
      } catch {
        journal = null;
      }
    }
    return { change: { n: num(r.n), ...j, state: str(r.state) as ChangeState }, at: str(r.at), journal };
  }

  setChangeState(turnId: string, n: number, state: ChangeState): void {
    this.db.prepare('UPDATE changes SET state = ? WHERE turn_id = ? AND n = ?').run(state, turnId, n);
  }

  // ------------------------------------------------------------------ cards

  addCard(turnId: string, at: string, c: CardJson): number {
    return this.db.tx(() => {
      const n = num((this.db.prepare('SELECT COUNT(*) AS n FROM confirms WHERE turn_id = ?').get(turnId) as Row).n);
      this.db.prepare("INSERT INTO confirms (turn_id, n, at, state, json) VALUES (?, ?, ?, 'waiting', ?)").run(turnId, n, at, JSON.stringify(CardJsonSchema.parse(c)));
      return n;
    });
  }

  cards(turnId: string): ChatCard[] {
    const rows = this.db.prepare('SELECT n, state, json FROM confirms WHERE turn_id = ? ORDER BY n').all(turnId) as Row[];
    const out: ChatCard[] = [];
    for (const r of rows) {
      const j = parse(CardJsonSchema, str(r.json));
      if (!j) continue;
      out.push({ n: num(r.n), kind: j.kind, module: j.module, op: j.op, ref: j.ref, label: j.label, state: str(r.state) as CardState, ...(j.reason ? { reason: j.reason } : {}) });
    }
    return out;
  }

  card(turnId: string, n: number): { card: CardJson; state: CardState; at: string } | null {
    const r = this.db.prepare('SELECT at, state, json FROM confirms WHERE turn_id = ? AND n = ?').get(turnId, n) as Row | undefined;
    if (!r) return null;
    const j = parse(CardJsonSchema, str(r.json));
    return j ? { card: j, state: str(r.state) as CardState, at: str(r.at) } : null;
  }

  setCardState(turnId: string, n: number, state: CardState, reason?: string): void {
    this.db.tx(() => {
      const cur = this.card(turnId, n);
      if (!cur) return;
      const json = { ...cur.card, ...(reason ? { reason } : {}) };
      if (!reason) delete json.reason;
      this.db.prepare('UPDATE confirms SET state = ?, json = ? WHERE turn_id = ? AND n = ?').run(state, JSON.stringify(json), turnId, n);
    });
  }

  /** The turn as the phone sees it. */
  full(t: TurnRecord): ChatTurn {
    const { by: _by, ...turn } = t;
    return { ...turn, changes: this.changes(t.id), cards: this.cards(t.id) };
  }

  // ------------------------------------------------------------------ photos

  addPhoto(p: PhotoRow): void {
    this.db.prepare('INSERT INTO photos (id, turn_id, at, bytes, w, h, type) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.id, p.turnId, p.at, p.bytes, p.w, p.h, p.type);
  }

  photo(id: string): PhotoRow | null {
    const r = this.db.prepare('SELECT id, turn_id, at, bytes, w, h, type FROM photos WHERE id = ?').get(id) as Row | undefined;
    return r ? this.photoRow(r) : null;
  }

  photosOf(turnId: string): PhotoRow[] {
    return (this.db.prepare('SELECT id, turn_id, at, bytes, w, h, type FROM photos WHERE turn_id = ? ORDER BY at, id').all(turnId) as Row[]).map((r) => this.photoRow(r));
  }

  /** Give unattached photos to a turn; the ids that were free (in the order asked). */
  attach(turnId: string, ids: readonly string[]): string[] {
    return this.db.tx(() => {
      const taken: string[] = [];
      for (const id of ids) {
        const r = this.db.prepare('UPDATE photos SET turn_id = ? WHERE id = ? AND turn_id IS NULL').run(turnId, id);
        if (num(r.changes) === 1) taken.push(id);
      }
      return taken;
    });
  }

  removePhoto(id: string): void {
    this.db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  }

  photoBytes(): number {
    return num((this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM photos').get() as Row).n);
  }

  photoCount(): number {
    return num((this.db.prepare('SELECT COUNT(*) AS n FROM photos').get() as Row).n);
  }

  /** Every photo, oldest first (the store-wide cap). */
  photosOldestFirst(): PhotoRow[] {
    return (this.db.prepare('SELECT id, turn_id, at, bytes, w, h, type FROM photos ORDER BY at, id').all() as Row[]).map((r) => this.photoRow(r));
  }

  private photoRow(r: Row): PhotoRow {
    return { id: str(r.id), turnId: r.turn_id === null || r.turn_id === undefined ? null : str(r.turn_id), at: str(r.at), bytes: num(r.bytes), w: num(r.w), h: num(r.h), type: str(r.type) };
  }

  // ------------------------------------------------------------------ retention

  /**
   * The sweep (spec 0.10 B3): turns older than `cutoffIso` and past the
   * newest `maxTurns` go with their changes, cards and photo rows; journals
   * older than `undoCutoffIso` are dropped (state expired); cards still
   * waiting older than it expire; photos never attached older than
   * `unattachedCutoffIso` go. Returns the photo rows removed (their files are
   * the caller's) and how many turns went. A running or queued turn is never
   * swept.
   */
  sweep(o: { cutoffIso: string; maxTurns: number; undoCutoffIso: string; unattachedCutoffIso: string }): { photos: PhotoRow[]; turns: number } {
    return this.db.tx(() => {
      const old = (this.db.prepare("SELECT id FROM turns WHERE at < ? AND state NOT IN ('queued', 'running')").all(o.cutoffIso) as Row[]).map((r) => str(r.id));
      const overflow = (
        this.db
          .prepare("SELECT id FROM turns WHERE state NOT IN ('queued', 'running') ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?")
          .all(o.maxTurns) as Row[]
      ).map((r) => str(r.id));
      const gone = [...new Set([...old, ...overflow])];
      const photos: PhotoRow[] = [];
      for (const id of gone) {
        photos.push(...this.photosOf(id));
        this.db.prepare('DELETE FROM photos WHERE turn_id = ?').run(id);
        this.db.prepare('DELETE FROM changes WHERE turn_id = ?').run(id);
        this.db.prepare('DELETE FROM confirms WHERE turn_id = ?').run(id);
        this.db.prepare('DELETE FROM turns WHERE id = ?').run(id);
      }
      this.db.prepare("UPDATE changes SET journal = NULL, state = CASE WHEN state = 'done' THEN 'expired' ELSE state END WHERE at < ? AND (journal IS NOT NULL OR state = 'done')").run(o.undoCutoffIso);
      this.db.prepare("UPDATE confirms SET state = 'expired' WHERE at < ? AND state = 'waiting'").run(o.undoCutoffIso);
      const loose = (this.db.prepare('SELECT id, turn_id, at, bytes, w, h, type FROM photos WHERE turn_id IS NULL AND at < ?').all(o.unattachedCutoffIso) as Row[]).map((r) => this.photoRow(r));
      for (const p of loose) this.removePhoto(p.id);
      photos.push(...loose);
      return { photos, turns: gone.length };
    });
  }

  /** Clear: every row goes, then VACUUM (secure_delete has overwritten the freed pages). */
  clear(): void {
    this.db.tx(() => {
      for (const t of ['photos', 'changes', 'confirms', 'turns']) this.db.prepare(`DELETE FROM ${t}`).run();
    });
    try {
      this.db.raw.exec('VACUUM');
      this.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // a busy file keeps its pages; secure_delete already overwrote them
    }
  }
}
