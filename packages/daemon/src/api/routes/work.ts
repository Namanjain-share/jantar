/**
 * v0.13 Work's routes (feature `work`: life.work with life.todos; owner
 * routes on his host, never under /v1/p/). P1: foldersSeed, "Start from
 * your client folders": one project per folder he picked, its folder
 * linked. Never automatic.
 *
 * The folders come as the browsers address them (a root id and a path
 * under it), so a phone without admin, which never sees an absolute path,
 * can send them. Each must sit under a configured root (folders.roots),
 * checked by the one path policy Files and New session use (no symlink out,
 * nothing protected), and the call needs one of those two browsers on:
 * Work adds no new way to list the Mac's folders. Any refusal refuses the
 * whole call before a project is made.
 *
 * The pipeline has checked control scope, the switch, a broken life.db,
 * the strict body and the Life write limit. The reply is ids and a count;
 * the audit row has no target and no params: a folder's name can be a
 * client's.
 */
import type { WorkSeedBody } from '@jantar/protocol/work';
import { isRefusal, refusalResult } from '../../launcher/folders.js';
import { ApiError } from '../errors.js';
import { lifeValue, needActor, type Call, type RouteTable } from '../route-kit.js';

/** What the seed says while neither folder browser is on (W40). */
export const SEED_NEEDS_BROWSER = 'Picking folders needs Files or New session on. Turn one on at your Mac: jantar files on';
/** A folder outside the configured roots (a live session's own folder is not one). */
export const SEED_NEEDS_ROOT = 'Pick a folder inside one of your folders. Add one at your Mac, for example: jantar folders add-root ~/Desktop';

export const WORK_ROUTE_IMPLS: RouteTable = {
  foldersSeed: {
    handle: async (c: Call<Record<string, string>, unknown, WorkSeedBody>, s) => {
      const actor = needActor(c.auth);
      const settings = s.ctx.settings.get();
      if (!settings.files.enabled && !settings.launch.enabled) throw new ApiError('forbidden', SEED_NEEDS_BROWSER);
      const items: { folder: string; name: string }[] = [];
      for (const item of c.body.items) {
        const dir = await s.deps.files.policy.resolveDir(item.root, item.path);
        if (isRefusal(dir)) {
          const r = refusalResult(dir);
          throw new ApiError(r.code, r.reason);
        }
        if (dir.root.kind !== 'configured' || dir.rel === '') throw new ApiError('invalid_request', SEED_NEEDS_ROOT);
        items.push({ folder: dir.real, name: item.name });
      }
      return lifeValue(s.deps.life.work.seed(items, actor));
    },
    // No target and no params: the folders and names stay out of the audit log.
    audit: () => ({}),
  },
};
