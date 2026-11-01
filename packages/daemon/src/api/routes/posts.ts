/**
 * Posts (feature `posts`, v0.7). The list and an add are on ctl.sock too
 * (`jantar post list`, `jantar post add`); changing, deleting and the weekly
 * goals are device routes only. Each calls `s.deps.life.posts`
 * (life/posts/module.ts).
 *
 * Scripts and Claude sessions add at most V07_LIMITS.postCtl posts an hour
 * over ctl.sock (s.postCtlLimiter, every ctl.sock peer being the one actor
 * `cli`), counted before the module answers: a looping session must not
 * schedule hundreds of pushes. The phone's adds are never counted there.
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, validated the strict bodies and counted every write against
 * s.lifeWriteLimiter. Write replies carry ids only (`lifeValue` turns a
 * LifeResult into the value or the API error); writes audit their target id
 * and nothing else (`lifeAudit`).
 */
import type { PostBody, PostGoalsBody, PostPatch, PostsQuery } from '@jantar/protocol';
import type { LifeResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { lifeAudit, lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';
import { V07_LIMITS } from '../services.js';

type Id = { id: string };

/** What a script or a Claude session hears past the hourly limit. */
export const POSTS_CTL_LIMITED = `Scripts and Claude sessions added ${V07_LIMITS.postCtl.limit} posts this hour. Add more on the phone, or try again later.`;

/** A write that answers `{ ok: true }`: the module's refusal as the API error, else ok. */
function okOf(r: LifeResult): { ok: true } {
  lifeValue(r);
  return { ok: true };
}

export const POSTS_ROUTE_IMPLS: RouteTable = {
  postsList: {
    handle: (c: Call<unknown, PostsQuery>, s) => lifeValue(s.deps.life.posts.list(c.query)),
  },
  postCreate: {
    handle: (c: Call<unknown, unknown, PostBody>, s) => {
      if (c.auth.transport === 'ctl') {
        const limited = s.postCtlLimiter.hit(actorName(c.auth));
        if (!limited.ok) throw new ApiError('rate_limited', POSTS_CTL_LIMITED, { 'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) });
      }
      return lifeValue(s.deps.life.posts.create(c.body, needActor(c.auth)));
    },
    audit: lifeAudit,
  },
  postUpdate: {
    handle: (c: Call<Id, unknown, PostPatch>, s) => okOf(s.deps.life.posts.update(c.params.id, c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
  postDelete: {
    handle: (c: Call<Id>, s) => okOf(s.deps.life.posts.remove(c.params.id, needActor(c.auth))),
    audit: lifeAudit,
  },
  postGoalsSet: {
    handle: (c: Call<unknown, unknown, PostGoalsBody>, s) => okOf(s.deps.life.posts.setGoals(c.body, needActor(c.auth))),
    audit: lifeAudit,
  },
};
