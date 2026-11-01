/**
 * Posts (feature `posts`, v0.7). The list and an add are on ctl.sock too
 * (`jantar post list`, `jantar post add`); changing, deleting and the weekly
 * goals are device routes only. Each will call `s.deps.life.posts`
 * (life/posts/module.ts).
 *
 * Wave 0: every route is a stub that answers 501 until lane A replaces this
 * table with handlers in the shape of routes/places.ts (`lifeValue`, `okOf`,
 * `needActor`, writes audited with `lifeAudit`, the target id only) and the
 * ctl.sock hourly limit on postCreate.
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

export const POSTS_ROUTE_IMPLS: RouteTable = {
  postsList: notImplementedRoute('Posts'),
  postCreate: notImplementedRoute('Posts'),
  postUpdate: notImplementedRoute('Posts'),
  postDelete: notImplementedRoute('Posts'),
  postGoalsSet: notImplementedRoute('Posts'),
};
