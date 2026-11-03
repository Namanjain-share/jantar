/**
 * v0.13 Work: the owner's projects as a hub, one search across Jantar, and
 * projects made from his client folders (P1). Clients, the log and
 * follow-ups (P2), deals and insights (P3) add their shapes here.
 *
 * Rules (life.ts's, and these):
 * - Owner-only. Every Work route is a `control` route on his host, never
 *   under `/v1/p/`. Work's fields never go into TodoBodySchema,
 *   TodoPatchSchema, ProjectBodySchema or ProjectPatchSchema: her own to-do
 *   and project routes reuse those (`@jantar/protocol/people`), so Work
 *   extends them in owner-only schemas instead.
 * - Bodies are strict; writes answer ids (and counts) only; a refusal is a
 *   fixed daemon sentence, never a client's name, phone or e-mail.
 */
import { z } from 'zod';
import { DueSchema, LifeIdSchema, ProjectBodySchema, ProjectViewSchema, TodoSchema } from './life.js';

/** Work's caps (LIFE_LIMITS' style); a call past one is refused with a fixed sentence. */
export const WORK_LIMITS = Object.freeze({
  /** GET /v1/search: the query's length, and the most results in one group. */
  searchMin: 2,
  searchMax: 80,
  searchPerGroup: 5,
  /** POST /v1/work/seed: folders in one call. */
  seedItems: 50,
  /** The project hub: its newest done todos, and the weeks of its done trend (oldest first, this week last). */
  hubRecentDone: 10,
  hubWeeks: 8,
  /** An active project with no change to it or its todos in more than this many days is quiet. */
  projectQuietDays: 14,
});

// ---------------------------------------------------------------------------
// The project hub (GET /v1/projects/:id)

export const ProjectHealthSchema = z.object({
  /** Open todos past due (Life's rule: before today, or today at a time before now), as the project's row counts them. */
  overdue: z.number().int().nonnegative(),
  /** The soonest-due open todo, overdue or not; absent when none has a due day. */
  nextDue: z.object({ todoId: LifeIdSchema, due: DueSchema }).optional(),
  /** Whole days since the project or one of its todos last changed, for an active project quiet past WORK_LIMITS.projectQuietDays. */
  quietDays: z.number().int().positive().optional(),
  /** Todos done in each of the last WORK_LIMITS.hubWeeks weeks (Monday to Monday in the Life zone), oldest first. */
  doneByWeek: z.array(z.number().int().nonnegative()).length(WORK_LIMITS.hubWeeks),
});
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

/**
 * One project on one screen: the project with its counts, its open todos
 * (by due), how many were done this week, the newest done, and its health.
 * Meetings come from `GET /v1/meetings?project=` (while Meetings is on), and
 * live sessions from the board's own state (the project's folder).
 */
export const ProjectHubSchema = z.object({
  project: ProjectViewSchema,
  open: z.array(TodoSchema),
  doneThisWeek: z.number().int().nonnegative(),
  recentDone: z.array(TodoSchema).max(WORK_LIMITS.hubRecentDone),
  health: ProjectHealthSchema,
});
export type ProjectHub = z.infer<typeof ProjectHubSchema>;

// ---------------------------------------------------------------------------
// One search across Jantar (GET /v1/search)

/** What a result is, in the order the search sheet lists its groups. */
export const SEARCH_KINDS = ['client', 'project', 'deal', 'todo', 'meeting', 'session', 'intel', 'place', 'post'] as const;
export const SearchKindSchema = z.enum(SEARCH_KINDS);
export type SearchKind = z.infer<typeof SearchKindSchema>;

/** `?q=` (2 to 80 characters once trimmed) and `?limit=` (results per group, at most 5). */
export const SearchQuerySchema = z.object({
  q: z.string().trim().min(WORK_LIMITS.searchMin).max(WORK_LIMITS.searchMax),
  limit: z.coerce.number().int().min(1).max(WORK_LIMITS.searchPerGroup).default(WORK_LIMITS.searchPerGroup),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** One result: what it is, its id, the words to show, and the app path that opens it (ids only). */
export const SearchItemSchema = z.object({
  kind: SearchKindSchema,
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  sub: z.string().max(200).optional(),
  href: z.string().max(400),
});
export type SearchItem = z.infer<typeof SearchItemSchema>;

export const SearchGroupSchema = z.object({ kind: SearchKindSchema, items: z.array(SearchItemSchema).min(1).max(WORK_LIMITS.searchPerGroup) });
export type SearchGroup = z.infer<typeof SearchGroupSchema>;

/** Only the groups with a match, in SEARCH_KINDS order; a group whose switch is off is never asked. */
export const SearchResponseSchema = z.object({ groups: z.array(SearchGroupSchema) });
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ---------------------------------------------------------------------------
// Projects from his client folders (POST /v1/work/seed)

/**
 * One folder, as the folder browsers address it (a root id from
 * `GET /v1/folders/roots` or Files' roots, and a path under it), and the
 * project's name. The root must be a configured one (folders.roots).
 */
export const WorkSeedItemSchema = z.strictObject({
  root: z.string().min(1).max(160),
  path: z.string().min(1).max(1024),
  name: ProjectBodySchema.shape.name,
});
export type WorkSeedItem = z.infer<typeof WorkSeedItemSchema>;

export const WorkSeedBodySchema = z.strictObject({ items: z.array(WorkSeedItemSchema).min(1).max(WORK_LIMITS.seedItems) });
export type WorkSeedBody = z.infer<typeof WorkSeedBodySchema>;

/** The new projects' ids, in the order given; `skipped`: folders a project already links. */
export const WorkSeedReplySchema = z.object({ projects: z.array(LifeIdSchema), skipped: z.number().int().nonnegative() });
export type WorkSeedReply = z.infer<typeof WorkSeedReplySchema>;
