/**
 * Posts (v0.7): plans for what the user posts on social media by hand.
 * Jantar never posts, never fetches a link and calls no network: it keeps
 * the text, rings at the time (pings.ts, the todo ring), and counts what is
 * marked Posted against the weekly goals.
 *
 * - A new post is an idea or ready (default idea); past
 *   LIFE_LIMITS.openPosts open ones (idea and ready) it is conflict. Posted
 *   and skipped posts are history, never pruned.
 * - Any status may follow any other (the phone). The daemon owns postedAt:
 *   stamped on the way into posted (kept while it stays posted), cleared
 *   with the posted link on the way out. A posted link only while posted.
 * - Empty optional text (only spaces) is left out, never stored.
 * - The open list sorts as todos do (byDue); the done list is the newest
 *   POSTS_DONE_PAGE posted or skipped.
 * - The week runs Monday 00:00 to the next Monday 00:00 in the Life zone. A
 *   post counts when its postedAt falls inside it; a goal counts its
 *   platform's posts, and its kind's when it has one. Goals live in meta.
 * - Every write saves, re-arms the ring, pokes the scheduler, then emits
 *   life.changed. Replies carry ids only; refusals are fixed sentences.
 */
import { instantAt, shiftDay, weekdayOf } from '@jantar/life-core';
import {
  LIFE_LIMITS,
  POSTS_DONE_PAGE,
  PostGoalsBodySchema,
  PostSchema,
  type Post,
  type PostBody,
  type PostGoalsBody,
  type PostPatch,
  type PostsQuery,
  type PostsResponse,
} from '@jantar/protocol';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, PostsModule } from '../../contracts.js';
import { byDue } from '../todos/module.js';
import { armPost, isOpen, postPingHandler } from './pings.js';
import { PostsRepo } from './repo.js';

/** What a refused call says: fixed daemon text, never user text. */
export const POSTS_SENTENCES = {
  none: 'That post is gone.',
  full: `You have ${LIFE_LIMITS.openPosts} posts to make. Post, skip or delete one to add another.`,
  invalid: 'That post is not valid.',
  postedLink: 'Mark it posted before adding the posted link.',
  goals: 'Those weekly goals are not valid.',
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };

/** Optional text with its ends trimmed, or undefined when nothing is left. */
function text(v: string | null | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

const TEXT_FIELDS = ['where', 'title', 'text', 'notes'] as const;

/** The Monday that starts `day`'s week, and that week's Sunday. */
export function weekOf(day: string): { from: string; to: string } {
  const from = shiftDay(day, -((weekdayOf(day) + 6) % 7));
  return { from, to: shiftDay(from, 6) };
}

class Posts implements PostsModule {
  readonly name = 'posts' as const;

  constructor(
    private readonly core: LifeCore,
    private readonly repo: PostsRepo,
  ) {}

  private stamp(): string {
    return this.core.now().toISOString();
  }

  /** Check, save, re-arm the ring, and tell the screens. `before`: the post as stored (null on create). */
  private saved(p: Post, before: Post | null): LifeResult {
    if (!PostSchema.safeParse(p).success) return refuse('invalid_request', POSTS_SENTENCES.invalid);
    this.repo.put(p);
    const fresh = !before || before.due?.day !== p.due?.day || before.due?.time !== p.due?.time;
    armPost(this.core, p, this.repo.pingAt(p.id), { fresh });
    this.core.scheduler.poke();
    this.core.changed();
    return OK;
  }

  list(q: PostsQuery): LifeResult<PostsResponse> {
    const today = this.core.today();
    const tz = this.core.tz();
    const { from, to } = weekOf(today);
    const posted = this.repo.postedBetween(instantAt(from, '00:00', tz).toISOString(), instantAt(shiftDay(from, 7), '00:00', tz).toISOString());
    const goals = this.repo.goals().map((g) => ({ ...g, done: posted.filter((p) => p.platform === g.platform && (!g.kind || p.kind === g.kind)).length }));
    const posts = q.done ? this.repo.done(POSTS_DONE_PAGE) : this.repo.open().sort(byDue);
    return { ok: true, value: { today, week: { from, to, posted: posted.length, goals }, posts } };
  }

  create(body: PostBody, _actor: Actor): LifeResult<{ id: string }> {
    if (this.repo.countOpen() >= LIFE_LIMITS.openPosts) return refuse('conflict', POSTS_SENTENCES.full);
    const at = this.stamp();
    const p: Post = { id: this.core.newId(), platform: body.platform, kind: body.kind ?? 'post', status: body.status ?? 'idea', createdAt: at, updatedAt: at };
    for (const key of TEXT_FIELDS) {
      const v = text(body[key]);
      if (v !== undefined) p[key] = v;
    }
    if (body.link !== undefined) p.link = body.link;
    if (body.due !== undefined) p.due = body.due;
    const r = this.saved(p, null);
    return r.ok ? { ok: true, value: { id: p.id } } : r;
  }

  update(id: string, patch: PostPatch, _actor: Actor): LifeResult {
    const p = this.repo.get(id);
    if (!p) return refuse('not_found', POSTS_SENTENCES.none);
    const at = this.stamp();
    const next: Post = { ...p, updatedAt: at };
    if (patch.platform !== undefined) next.platform = patch.platform;
    if (patch.kind !== undefined) next.kind = patch.kind;
    for (const key of TEXT_FIELDS) {
      if (patch[key] === undefined) continue;
      const v = text(patch[key]);
      if (v === undefined) delete next[key];
      else next[key] = v;
    }
    if (patch.link === null) delete next.link;
    else if (patch.link !== undefined) next.link = patch.link;
    if (patch.due === null) delete next.due;
    else if (patch.due !== undefined) next.due = patch.due;
    if (patch.status !== undefined) next.status = patch.status;
    // The daemon owns postedAt: stamped on the way in, kept while posted, cleared (with the posted link) on the way out.
    if (next.status === 'posted' && p.status !== 'posted') next.postedAt = at;
    if (next.status !== 'posted') {
      delete next.postedAt;
      delete next.postedUrl;
    }
    if (patch.postedUrl === null) delete next.postedUrl;
    else if (patch.postedUrl !== undefined) {
      if (next.status !== 'posted') return refuse('invalid_request', POSTS_SENTENCES.postedLink);
      next.postedUrl = patch.postedUrl;
    }
    // Back to the list from posted or skipped (Undo, Not posted): the cap holds.
    if (!isOpen(p.status) && isOpen(next.status) && this.repo.countOpen() >= LIFE_LIMITS.openPosts) return refuse('conflict', POSTS_SENTENCES.full);
    return this.saved(next, p);
  }

  remove(id: string, _actor: Actor): LifeResult {
    if (!this.repo.delete(id)) return refuse('not_found', POSTS_SENTENCES.none);
    this.core.scheduler.clear('post', id);
    this.core.scheduler.poke();
    this.core.changed();
    return OK;
  }

  setGoals(body: PostGoalsBody, _actor: Actor): LifeResult {
    const parsed = PostGoalsBodySchema.safeParse(body);
    if (!parsed.success) return refuse('invalid_request', POSTS_SENTENCES.goals);
    this.repo.setGoals(parsed.data.goals);
    this.core.changed();
    return OK;
  }

  /** Today's part: open posts due on `day`, and due before it (late). */
  today(day: string): { posts: { today: number; late: number } } {
    let today = 0;
    let late = 0;
    for (const p of this.repo.openDueBy(day)) {
      if (p.due?.day === day) today += 1;
      else late += 1;
    }
    return { posts: { today, late } };
  }
}

/**
 * Builds the module on `core` and registers its `post` ping handler.
 * Every call reads core.db afresh (a restore swaps it).
 */
export function buildPostsModule(core: LifeCore, deps: LifeModuleDeps): PostsModule {
  const repo = new PostsRepo(core, deps.ctx.log.child({ part: 'life', module: 'posts' }));
  core.scheduler.register(postPingHandler(core, repo));
  return new Posts(core, repo);
}
