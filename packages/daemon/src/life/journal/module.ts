/**
 * v0.11 People (P2): her journal (spec 3.11, O3). Entries and comments in
 * her space (`journal_entries`, `journal_comments`); comment authorship is
 * the `by_person` column, never json.
 *
 * - Only she writes, edits and deletes her entries (D22): no method here
 *   takes his hand on her words. Deleting an entry deletes its comments.
 * - A one-tap check-in is idempotent on its client id (a double tap makes
 *   one entry). An entry's day may be today or earlier, never later.
 * - Either person comments under an entry (his needs `comment.journal`);
 *   each deletes only their own. A comment of his pushes her once ("Sam
 *   commented on your journal"), a reply of hers pushes him: important
 *   tier, counted against the recipient's caps, held by her holds and her
 *   pause. No push, Activity row, audit row or log ever carries entry or
 *   comment text (O15); her Activity says "Sam commented on your entry of
 *   3 Nov".
 * - The streak (life-core `journalStreak`): a day counts with any entry,
 *   check-in or review entry; `hideStreaks` gives null on both sides.
 * - Kept out of every chat tool, `jantar mcp` and the CLI's output (M14):
 *   only her routes, his journal routes (through `ownerViewOf`), the mirror
 *   and her export import this file.
 */
import { PEOPLE_LABEL } from '@jantar/protocol/people-core';
import { JOURNAL_PROMPTS, journalStreak, promptForDay } from '@jantar/life-core';
import {
  JournalCommentSchema,
  JournalEntrySchema,
  type JournalComment,
  type JournalCreateBody,
  type JournalEntry,
  type JournalEntryFull,
  type JournalList,
  type JournalPatchBody,
} from '@jantar/protocol/people';
import type { LifeCore, LifeResult } from '../../contracts.js';
import { newId } from '../../core/ids.js';
import type { PeopleModule } from '../people/module.js';
import { CLOSED, NO_PERSON, OK, dayLabel, refuse, type Refusal } from '../people/kit.js';

export const JOURNAL_REASONS = {
  noEntry: 'No such entry.',
  noComment: 'No such comment.',
  future: 'An entry can be for today or an earlier day.',
  empty: 'An entry needs text or a mood.',
  paused: (name: string) => `${name} has paused. Comments wait until sharing resumes.`,
} as const;

const PAGE = 50;

interface EntryRow {
  id: string;
  day: string;
  at: string;
  json: string;
}

export interface JournalDeps {
  people: PeopleModule;
  core: () => LifeCore | null;
}

export class JournalModule {
  constructor(private readonly d: JournalDeps) {}

  private get people(): PeopleModule {
    return this.d.people;
  }

  private core(): LifeCore | null {
    return this.d.core();
  }

  private entryOf(r: EntryRow, comments?: number): JournalEntry | null {
    try {
      const p = JournalEntrySchema.safeParse({ ...(JSON.parse(r.json) as object), id: r.id, day: r.day, at: r.at, ...(comments !== undefined ? { comments } : {}) });
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  }

  private find(c: LifeCore, pid: string, id: string): JournalEntry | null {
    const r = c.db.prepare('SELECT id, day, at, json FROM journal_entries WHERE space = ? AND id = ?').get(pid, id) as EntryRow | undefined;
    return r ? this.entryOf(r) : null;
  }

  private saveEntry(c: LifeCore, pid: string, e: JournalEntry, clientId?: string): void {
    const { id, day, at, comments: _n, ...rest } = JournalEntrySchema.parse(e);
    c.db
      .prepare(
        `INSERT INTO journal_entries (id, space, day, at, client_id, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET day = excluded.day, json = excluded.json`,
      )
      .run(id, pid, day, at, clientId ?? null, JSON.stringify(rest));
  }

  private commentsOf(c: LifeCore, pid: string, entryId: string): JournalComment[] {
    const rows = c.db.prepare('SELECT id, entry_id, by_person, at, json FROM journal_comments WHERE space = ? AND entry_id = ? ORDER BY at, id').all(pid, entryId) as {
      id: string;
      entry_id: string;
      by_person: string;
      at: string;
      json: string;
    }[];
    return rows.flatMap((r) => {
      try {
        const p = JournalCommentSchema.safeParse({ ...(JSON.parse(r.json) as object), id: r.id, entryId: r.entry_id, by: r.by_person, at: r.at });
        return p.success ? [p.data] : [];
      } catch {
        return [];
      }
    });
  }

  /** Her journal, newest first (50 a page), with comment counts, the streak (null when hidden) and the day's prompt. */
  list(pid: string, q: { before?: string | undefined; day?: string | undefined }): LifeResult<JournalList> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const args: string[] = [pid];
    let sql = 'SELECT id, day, at, json FROM journal_entries WHERE space = ?';
    if (q.day) {
      sql += ' AND day = ?';
      args.push(q.day);
    }
    if (q.before) {
      sql += ' AND at < ?';
      args.push(q.before);
    }
    sql += ` ORDER BY at DESC, id DESC LIMIT ${PAGE}`;
    const rows = c.db.prepare(sql).all(...args) as unknown as EntryRow[];
    const counts = new Map<string, number>();
    for (const r of c.db.prepare('SELECT entry_id, COUNT(*) AS n FROM journal_comments WHERE space = ? GROUP BY entry_id').all(pid) as { entry_id: string; n: number }[]) {
      counts.set(r.entry_id, Number(r.n));
    }
    const entries = rows.flatMap((r) => this.entryOf(r, counts.get(r.id) ?? 0) ?? []);
    const days = (c.db.prepare('SELECT DISTINCT day FROM journal_entries WHERE space = ?').all(pid) as { day: string }[]).map((r) => r.day);
    const p = this.people.person(pid);
    const s = journalStreak(days, c.today());
    const streak = p?.prefs.hideStreaks ? null : { current: s.current, best: s.longest, ...(s.milestone !== null ? { milestoneToday: s.milestone } : {}) };
    return { ok: true, value: { entries, streak, before: rows.length === PAGE ? (rows[rows.length - 1]?.at ?? null) : null, prompt: promptForDay(JOURNAL_PROMPTS, c.today()) } };
  }

  get(pid: string, id: string): LifeResult<JournalEntryFull> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const entry = this.find(c, pid, id);
    if (!entry) return refuse('not_found', JOURNAL_REASONS.noEntry);
    const comments = this.commentsOf(c, pid, id);
    return { ok: true, value: { entry: { ...entry, comments: comments.length }, comments } };
  }

  /** Her entry or check-in. The same client id answers with the same entry. */
  create(pid: string, body: JournalCreateBody): LifeResult<{ id: string }> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const dup = c.db.prepare('SELECT id FROM journal_entries WHERE space = ? AND client_id = ?').get(pid, body.clientId) as { id: string } | undefined;
    if (dup) return { ok: true, value: { id: dup.id } };
    const day = body.day ?? c.today();
    if (day > c.today()) return refuse('invalid_request', JOURNAL_REASONS.future);
    const e: JournalEntry = {
      id: newId(),
      day,
      at: c.now().toISOString(),
      kind: body.kind,
      ...(body.text ? { text: body.text } : {}),
      ...(body.mood !== undefined ? { mood: body.mood } : {}),
      ...(body.emotions && body.emotions.length > 0 ? { emotions: [...new Set(body.emotions)] } : {}),
    };
    this.saveEntry(c, pid, e, body.clientId);
    this.wrote(pid);
    return { ok: true, value: { id: e.id } };
  }

  /** "Also save to my journal" from her evening review: a `review` entry with the same note and mood. */
  reviewEntry(pid: string, day: string, note: string | undefined, mood: number | undefined): void {
    const c = this.core();
    if (!c) return;
    this.saveEntry(c, pid, { id: newId(), day, at: c.now().toISOString(), kind: 'review', ...(note ? { text: note.slice(0, 8000) } : {}), ...(mood ? { mood } : {}) });
    this.wrote(pid);
  }

  update(pid: string, id: string, patch: JournalPatchBody): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const e = this.find(c, pid, id);
    if (!e) return refuse('not_found', JOURNAL_REASONS.noEntry);
    if (patch.day !== undefined && patch.day > c.today()) return refuse('invalid_request', JOURNAL_REASONS.future);
    const next: JournalEntry = { ...e, editedAt: c.now().toISOString() };
    if (patch.text === null || patch.text === '') delete next.text;
    else if (patch.text !== undefined) next.text = patch.text;
    if (patch.mood === null) delete next.mood;
    else if (patch.mood !== undefined) next.mood = patch.mood;
    if (patch.emotions !== undefined) {
      if (patch.emotions.length === 0) delete next.emotions;
      else next.emotions = [...new Set(patch.emotions)];
    }
    if (patch.day !== undefined) next.day = patch.day;
    if (next.text === undefined && next.mood === undefined) return refuse('invalid_request', JOURNAL_REASONS.empty);
    this.saveEntry(c, pid, next);
    this.wrote(pid);
    return OK;
  }

  /** Delete an entry of hers, and every comment under it (his included). */
  remove(pid: string, id: string): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (!this.find(c, pid, id)) return refuse('not_found', JOURNAL_REASONS.noEntry);
    c.db.tx(() => {
      c.db.prepare('DELETE FROM journal_comments WHERE space = ? AND entry_id = ?').run(pid, id);
      c.db.prepare('DELETE FROM journal_entries WHERE space = ? AND id = ?').run(pid, id);
    });
    this.wrote(pid);
    return OK;
  }

  /**
   * A comment under one of her entries: hers (`by` her id) or his (`by`
   * '', with `comment.journal`, refused while she is paused). The other
   * person hears it once, with no text.
   */
  comment(pid: string, entryId: string, by: string, text: string): LifeResult<{ id: string }> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (by === '') {
      const g = this.hisGate(pid);
      if (g) return g;
    }
    const entry = this.find(c, pid, entryId);
    if (!entry) return refuse('not_found', JOURNAL_REASONS.noEntry);
    const at = c.now().toISOString();
    const id = newId();
    c.db.prepare('INSERT INTO journal_comments (id, space, entry_id, by_person, at, json) VALUES (?, ?, ?, ?, ?, ?)').run(id, pid, entryId, by, at, JSON.stringify({ text }));
    const alerts = this.people.alerts;
    if (by === '') {
      this.people.record(pid, { actor: 'owner', action: 'journal.commented', area: 'journal', ref: entry.day, title: `your entry of ${dayLabel(entry.day)}` });
      this.people.hisWrote(pid, 'plan');
      alerts?.deliverPush(pid, { kind: 'life', title: PEOPLE_LABEL, body: `${this.people.ownerName()} commented on your journal.`, url: `/p/journal?id=${entryId}`, tag: `people:comment:${entryId}` }, { kind: 'comment', sender: '' });
    } else {
      this.wrote(pid);
      const name = this.people.nameOf(pid);
      alerts?.deliverPush('', { kind: 'life', title: PEOPLE_LABEL, body: `${name} replied in the journal.`, url: `/people/${pid}?tab=journal&id=${entryId}`, tag: `people:comment:${entryId}` }, { kind: 'comment', sender: pid, about: pid, area: 'journal' });
    }
    return { ok: true, value: { id } };
  }

  /** Delete a comment: each person only their own (another's answers as one that doesn't exist). */
  removeComment(pid: string, entryId: string, cid: string, by: string): LifeResult {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (by === '') {
      const g = this.hisGate(pid);
      if (g) return g;
    }
    const n = Number(c.db.prepare('DELETE FROM journal_comments WHERE space = ? AND entry_id = ? AND id = ? AND by_person = ?').run(pid, entryId, cid, by).changes);
    if (n === 0) return refuse('not_found', JOURNAL_REASONS.noComment);
    if (by === '') this.people.hisWrote(pid, 'plan');
    else this.wrote(pid);
    return OK;
  }

  private hisGate(pid: string): Refusal | null {
    const reach = this.people.ownerReach(pid);
    const a = this.people.agreement(pid);
    if ((reach !== 'active' && reach !== 'paused') || !a?.see.journal || !a.comment.journal) return refuse('not_found', NO_PERSON);
    if (reach === 'paused') return refuse('conflict', JOURNAL_REASONS.paused(this.people.nameOf(pid)));
    return null;
  }

  /** Every entry and comment of hers (her export: both people's comments). */
  exportRows(pid: string): { journal: JournalEntry[]; journalComments: JournalComment[] } {
    const c = this.core();
    if (!c) return { journal: [], journalComments: [] };
    const entries = (c.db.prepare('SELECT id, day, at, json FROM journal_entries WHERE space = ? ORDER BY at').all(pid) as unknown as EntryRow[]).flatMap((r) => this.entryOf(r) ?? []);
    const comments = entries.flatMap((e) => this.commentsOf(c, pid, e.id));
    return { journal: entries, journalComments: comments };
  }

  private wrote(pid: string): void {
    this.people.herWrote(pid, 'journal', 'plan');
  }
}
