/**
 * The `posts` table (life.db migration 2): a few indexed columns beside the
 * post's JSON, which is checked with PostSchema on every read and write. A
 * row that no longer parses is left out of every answer (never repaired,
 * never deleted) and counted in the log by table, not by content. The
 * weekly goals live in `meta('post_goals')`, as JSON checked on read.
 *
 * Every call reads `core.db` afresh: a restore swaps the handle.
 */
import { z } from 'zod';
import { POST_GOALS_MAX, PostGoalSchema, PostSchema, type Post, type PostGoal, type PostKind, type PostPlatform } from '@jantar/protocol';
import type { LifeCore, Logger } from '../../contracts.js';

interface JsonRow {
  json: string;
}

/** The meta key of the weekly goals. */
export const POST_GOALS_KEY = 'post_goals';
const GoalsSchema = z.array(PostGoalSchema).max(POST_GOALS_MAX);

/** Idea and ready: the posts still to make (they ring, and count against the cap). */
const OPEN = "status IN ('idea', 'ready')";

export class PostsRepo {
  constructor(
    private readonly core: Pick<LifeCore, 'db'>,
    private readonly log: Logger,
  ) {}

  private parse(rows: readonly JsonRow[]): Post[] {
    const out: Post[] = [];
    let bad = 0;
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.json);
      } catch {
        bad += 1;
        continue;
      }
      const p = PostSchema.safeParse(value);
      if (p.success) out.push(p.data);
      else bad += 1;
    }
    if (bad > 0) this.log.warn('life rows left out: they no longer parse', { table: 'posts', rows: bad });
    return out;
  }

  private all(sql: string, ...args: (string | number)[]): Post[] {
    return this.parse(this.core.db.prepare(sql).all(...args) as unknown as JsonRow[]);
  }

  get(id: string): Post | null {
    return this.all('SELECT json FROM posts WHERE id = ?', id)[0] ?? null;
  }

  put(p: Post): void {
    const json = JSON.stringify(PostSchema.parse(p));
    this.core.db
      .prepare(
        `INSERT INTO posts (id, status, due_day, posted_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, due_day = excluded.due_day,
           posted_at = excluded.posted_at, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(p.id, p.status, p.due?.day ?? null, p.postedAt ?? null, p.updatedAt, json);
  }

  /** True when there was one to delete. */
  delete(id: string): boolean {
    return Number(this.core.db.prepare('DELETE FROM posts WHERE id = ?').run(id).changes) === 1;
  }

  /** Idea and ready posts, unsorted. */
  open(): Post[] {
    return this.all(`SELECT json FROM posts WHERE ${OPEN}`);
  }

  /** Open posts due on or before `day` (Today's part). */
  openDueBy(day: string): Post[] {
    return this.all(`SELECT json FROM posts WHERE ${OPEN} AND due_day IS NOT NULL AND due_day <= ?`, day);
  }

  /** The newest posted and skipped posts, by when they were posted (else last changed). */
  done(limit: number): Post[] {
    return this.all("SELECT json FROM posts WHERE status IN ('posted', 'skipped') ORDER BY COALESCE(posted_at, updated_at) DESC, id DESC LIMIT ?", limit);
  }

  /** Open posts with a due time: the ones that ring. */
  openTimed(): Post[] {
    return this.all(`SELECT json FROM posts WHERE ${OPEN} AND json_extract(json, '$.due.time') IS NOT NULL`);
  }

  countOpen(): number {
    return Number((this.core.db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE ${OPEN}`).get() as { n: number }).n);
  }

  /** The platform and kind of each post posted in [fromIso, toIso). */
  postedBetween(fromIso: string, toIso: string): { platform: PostPlatform; kind: PostKind }[] {
    return this.all("SELECT json FROM posts WHERE status = 'posted' AND posted_at >= ? AND posted_at < ?", fromIso, toIso).map((p) => ({ platform: p.platform, kind: p.kind }));
  }

  /** A post's ping row's next_at (null: no row, or parked after its ring). The scheduler writes `pings`; this only reads it. */
  pingAt(id: string): string | null {
    const r = this.core.db.prepare("SELECT next_at FROM pings WHERE kind = 'post' AND ref = ?").get(id) as { next_at: string | null } | undefined;
    return r?.next_at ?? null;
  }

  /** Every `post` ping row's next_at by ref. */
  pingTimes(): Map<string, string | null> {
    const rows = this.core.db.prepare("SELECT ref, next_at FROM pings WHERE kind = 'post'").all() as unknown as { ref: string; next_at: string | null }[];
    return new Map(rows.map((r) => [r.ref, r.next_at]));
  }

  /** The weekly goals; an unreadable value reads as none (logged by key only). */
  goals(): PostGoal[] {
    const raw = this.core.db.meta(POST_GOALS_KEY);
    if (raw === undefined) return [];
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const parsed = GoalsSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    this.log.warn('life meta value left out: it does not parse', { key: POST_GOALS_KEY });
    return [];
  }

  /** Replaces the goals; none removes the key. */
  setGoals(goals: readonly PostGoal[]): void {
    if (goals.length === 0) this.core.db.deleteMeta(POST_GOALS_KEY);
    else this.core.db.setMeta(POST_GOALS_KEY, JSON.stringify(GoalsSchema.parse(goals)));
  }
}
