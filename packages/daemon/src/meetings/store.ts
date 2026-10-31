/**
 * The MeetingsStore over an open meetings.db (db.ts). Synchronous
 * (node:sqlite). The shell (index.ts) makes one when it opens the file and
 * drops it when it closes, so the builders read `core.store()` on every
 * call and never keep it.
 *
 * - A meeting's record (name, site, people, switches, summary) is the `json`
 *   column, checked with MeetingRecordSchema on every write and read; a row
 *   that fails on read is skipped and logged by its id only.
 * - Lines are kept by (meeting, line id) at the highest revision sent, so
 *   the extension's retries and late corrections are harmless.
 * - Screenshot rows are unique per (meeting, the extension's key): a retried
 *   upload answers the stored id (`shotByKey` before any file is written,
 *   `addShot` for two uploads that raced). The files are the caller's
 *   (files.ts).
 * - Search matches the name, people and summary text and any line's text,
 *   with LIKE on escaped input (no pattern characters from the phone).
 */
import { z } from 'zod';
import { EndReasonSchema, MEETING_LIMITS, MeetingSiteSchema, MeetingSummarySchema, type EndReason, type MeetingsQuery } from '@jantar/protocol';
import type { Logger, MeetingRecord, MeetingRow, MeetingsStore, StoredLine, StoredShot } from '../contracts.js';
import { silentLogger } from '../core/log.js';
import type { MeetingsDb } from './db.js';

/** What a meeting row's `json` holds. Strict: an unknown key is a bug. */
export const MeetingRecordSchema = z.strictObject({
  name: z.string().min(1).max(MEETING_LIMITS.name),
  site: MeetingSiteSchema,
  people: z.string().max(MEETING_LIMITS.people).optional(),
  autoTodos: z.boolean(),
  notes: z.boolean(),
  endReason: EndReasonSchema.optional(),
  summary: MeetingSummarySchema,
});

type Row = {
  id: string;
  ext_id: string;
  client_id: string;
  started_at: string;
  ended_at: string | null;
  last_at: string;
  project_id: string | null;
  json: string;
};

type LineRow = { line_id: string; rev: number; at: number; speaker: string; text: string };
type ShotRow = { id: string; key: string; at: number; bytes: number };

/** `%text%` for LIKE ... ESCAPE '\': the phone's % and _ match themselves. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The list cursor `<started_at>|<id>`, or null for anything else. */
function cursorOf(before: string | undefined): { at: string; id: string } | null {
  if (!before) return null;
  const bar = before.lastIndexOf('|');
  if (bar <= 0 || bar === before.length - 1) return null;
  return { at: before.slice(0, bar), id: before.slice(bar + 1) };
}

export function createMeetingsStore(db: MeetingsDb, log: Logger = silentLogger): MeetingsStore {
  const record = (r: MeetingRecord): string => JSON.stringify(MeetingRecordSchema.parse(r));

  const fromRow = (r: Row | undefined): MeetingRow | null => {
    if (!r) return null;
    let parsed: ReturnType<typeof MeetingRecordSchema.safeParse>;
    try {
      parsed = MeetingRecordSchema.safeParse(JSON.parse(r.json));
    } catch {
      parsed = MeetingRecordSchema.safeParse(null);
    }
    if (!parsed.success) {
      log.error('meetings: a meeting row failed its check', { meetingId: r.id });
      return null;
    }
    return {
      id: r.id,
      extId: r.ext_id,
      clientId: r.client_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      lastAt: r.last_at,
      projectId: r.project_id,
      record: parsed.data,
    };
  };
  const rows = (list: Row[]): MeetingRow[] => list.map(fromRow).filter((m): m is MeetingRow => m !== null);
  const count = (sql: string, ...args: (string | number)[]): number => Number((db.prepare(sql).get(...args) as { n: number | null } | undefined)?.n ?? 0);

  const store: MeetingsStore = {
    byClient(extId, clientId) {
      return fromRow(db.prepare('SELECT * FROM meetings WHERE ext_id = ? AND client_id = ?').get(extId, clientId) as Row | undefined);
    },

    create(m) {
      db.prepare(
        'INSERT INTO meetings (id, ext_id, client_id, started_at, ended_at, last_at, project_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(m.id, m.extId, m.clientId, m.startedAt, m.endedAt, m.lastAt, m.projectId, record(m.record));
    },

    get(id) {
      return fromRow(db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined);
    },

    update(id, fn) {
      return db.tx(() => {
        const current = store.get(id);
        if (!current) return false;
        db.prepare('UPDATE meetings SET json = ? WHERE id = ?').run(record(fn(structuredClone(current.record))), id);
        return true;
      });
    },

    setProject(id, projectId) {
      return Number(db.prepare('UPDATE meetings SET project_id = ? WHERE id = ?').run(projectId, id).changes) > 0;
    },

    touch(id, at) {
      db.prepare('UPDATE meetings SET last_at = ? WHERE id = ?').run(at, id);
    },

    end(id, at, reason: EndReason) {
      return db.tx(() => {
        const current = store.get(id);
        if (!current || current.endedAt !== null) return false;
        const next = record({ ...current.record, endReason: reason });
        db.prepare('UPDATE meetings SET ended_at = ?, json = ? WHERE id = ?').run(at, next, id);
        return true;
      });
    },

    remove(id) {
      // Lines and screenshot rows go with it (ON DELETE CASCADE).
      const gone = Number(db.prepare('DELETE FROM meetings WHERE id = ?').run(id).changes) > 0;
      if (gone) {
        // secure_delete zeroed the pages; the WAL still holds their old frames until a checkpoint. Deletes are rare.
        try {
          db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        } catch (e) {
          log.warn('meetings: the WAL was not checkpointed after a delete', { error: e instanceof Error ? e.name : 'unknown' });
        }
      }
      return gone;
    },

    count() {
      return count('SELECT COUNT(*) AS n FROM meetings');
    },

    openCount() {
      return count('SELECT COUNT(*) AS n FROM meetings WHERE ended_at IS NULL');
    },

    list(q: MeetingsQuery) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (q.project === 'none') where.push('project_id IS NULL');
      else if (q.project) {
        where.push('project_id = ?');
        args.push(q.project);
      }
      const cursor = cursorOf(q.before);
      if (cursor) {
        where.push('(started_at < ? OR (started_at = ? AND id < ?))');
        args.push(cursor.at, cursor.at, cursor.id);
      }
      if (q.q) {
        const like = contains(q.q);
        where.push(
          `(json_extract(json, '$.name') LIKE ? ESCAPE '\\' OR json_extract(json, '$.people') LIKE ? ESCAPE '\\'` +
            ` OR json_extract(json, '$.summary.text') LIKE ? ESCAPE '\\'` +
            ` OR EXISTS (SELECT 1 FROM lines WHERE lines.meeting_id = meetings.id AND lines.text LIKE ? ESCAPE '\\'))`,
        );
        args.push(like, like, like, like);
      }
      const sql = `SELECT * FROM meetings${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`;
      const found = db.prepare(sql).all(...args, q.limit + 1) as Row[];
      const page = found.slice(0, q.limit);
      const last = page[page.length - 1];
      return { rows: rows(page), next: found.length > q.limit && last ? `${last.started_at}|${last.id}` : null };
    },

    newestOpen() {
      return fromRow(db.prepare('SELECT * FROM meetings WHERE ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1').get() as Row | undefined);
    },

    upsertLines(id, lines: readonly StoredLine[]) {
      return db.tx(() => {
        let changed = 0;
        const put = db.prepare(
          `INSERT INTO lines (meeting_id, line_id, rev, at, speaker, text) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (meeting_id, line_id) DO UPDATE SET rev = excluded.rev, at = excluded.at, speaker = excluded.speaker, text = excluded.text
           WHERE excluded.rev > lines.rev`,
        );
        for (const l of lines) changed += Number(put.run(id, l.lineId, l.rev, l.at, l.speaker, l.text).changes);
        return changed;
      });
    },

    lines(id) {
      const list = db.prepare('SELECT line_id, rev, at, speaker, text FROM lines WHERE meeting_id = ? ORDER BY at ASC, line_id ASC').all(id) as LineRow[];
      return list.map((l) => ({ lineId: l.line_id, rev: Number(l.rev), at: Number(l.at), speaker: l.speaker, text: l.text }));
    },

    lineCount(id) {
      return count('SELECT COUNT(*) AS n FROM lines WHERE meeting_id = ?', id);
    },

    knownLineIds(id, lineIds) {
      const known = new Set<string>();
      // At most 200 ids in one statement (a post carries at most 200 lines).
      for (let i = 0; i < lineIds.length; i += 200) {
        const part = lineIds.slice(i, i + 200);
        const sql = `SELECT line_id FROM lines WHERE meeting_id = ? AND line_id IN (${part.map(() => '?').join(', ')})`;
        for (const r of db.prepare(sql).all(id, ...part) as { line_id: string }[]) known.add(r.line_id);
      }
      return known;
    },

    lineChars(id) {
      return count('SELECT SUM(length(text)) AS n FROM lines WHERE meeting_id = ?', id);
    },

    addShot(id, shot: StoredShot) {
      return db.tx(() => {
        const known = db.prepare('SELECT id FROM shots WHERE meeting_id = ? AND key = ?').get(id, shot.key) as { id: string } | undefined;
        if (known) return { id: known.id, duplicate: true };
        db.prepare('INSERT INTO shots (id, meeting_id, key, at, bytes) VALUES (?, ?, ?, ?, ?)').run(shot.id, id, shot.key, shot.at, shot.bytes);
        return { id: shot.id, duplicate: false };
      });
    },

    shots(id) {
      const list = db.prepare('SELECT id, key, at, bytes FROM shots WHERE meeting_id = ? ORDER BY at ASC, id ASC').all(id) as ShotRow[];
      return list.map((s) => ({ id: s.id, key: s.key, at: Number(s.at), bytes: Number(s.bytes) }));
    },

    shot(id, shotId) {
      const s = db.prepare('SELECT id, key, at, bytes FROM shots WHERE meeting_id = ? AND id = ?').get(id, shotId) as ShotRow | undefined;
      return s ? { id: s.id, key: s.key, at: Number(s.at), bytes: Number(s.bytes) } : null;
    },

    shotByKey(id, key) {
      const s = db.prepare('SELECT id, key, at, bytes FROM shots WHERE meeting_id = ? AND key = ?').get(id, key) as ShotRow | undefined;
      return s ? { id: s.id, key: s.key, at: Number(s.at), bytes: Number(s.bytes) } : null;
    },

    shotCount(id) {
      return count('SELECT COUNT(*) AS n FROM shots WHERE meeting_id = ?', id);
    },

    shotBytesTotal() {
      return count('SELECT SUM(bytes) AS n FROM shots');
    },

    staleOpen(beforeIso) {
      return rows(db.prepare('SELECT * FROM meetings WHERE ended_at IS NULL AND last_at < ? ORDER BY last_at ASC').all(beforeIso) as Row[]);
    },

    summaryWaiting() {
      return rows(
        db.prepare("SELECT * FROM meetings WHERE json_extract(json, '$.summary.state') IN ('queued', 'running') ORDER BY started_at ASC").all() as Row[],
      );
    },
  };
  return store;
}
