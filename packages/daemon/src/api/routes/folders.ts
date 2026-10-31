/**
 * Folder routes (WP-L owns this file): foldersRoots, foldersList,
 * foldersRecent, foldersPin, foldersCreate. Each calls
 * `s.deps.launcher.folders` (FolderBrowser), which goes through the one path
 * policy.
 *
 * The pipeline has already checked the device, the scope (foldersCreate:
 * launch) and `launch.enabled`, and validated the query or the strict body
 * (FolderNameSchema for a new folder's name). Here: the per-device
 * `s.folderCreateLimiter` (the launcher also applies
 * settings.launch.rate.foldersPerHour) and `s.foldersLimiter` for the reads
 * (launchPreview shares it), and the audit params of the two writes: paths
 * and ids only. Path refusals are audited by Files (files.denied, and the
 * probe alarm), as its own are.
 */
import type { FolderCreateBody, FolderPinBody, FoldersListQuery } from '@jantar/protocol';
import type { LaunchResult } from '../../contracts.js';
import { ApiError } from '../errors.js';
import { actorName } from '../request.js';
import { needActor, type Call, type RouteTable } from '../route-kit.js';
import type { ApiServices } from '../services.js';

type Refused = Extract<LaunchResult, { ok: false }> & { retryAfterMs?: number };

/** A launcher refusal as an API error (LaunchErrorCode names are API error codes). */
export function launchError(r: Refused): ApiError {
  const headers: Record<string, string> = {};
  if (r.code === 'rate_limited' && r.retryAfterMs !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
  return new ApiError(r.code, r.reason, headers);
}

/** Folder reads and previews per device (V03_LIMITS.folders). */
export function foldersLimit(c: Call, s: ApiServices): void {
  const limited = s.foldersLimiter.hit(actorName(c.auth));
  if (!limited.ok) {
    throw new ApiError('rate_limited', 'Too many folder requests; wait a moment', {
      'retry-after': String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))),
    });
  }
}

/** The value of a launcher answer, or its refusal thrown as an API error. */
export function unwrap<T extends object>(r: LaunchResult<T>): T {
  if (!r.ok) throw launchError(r);
  return r;
}

export const FOLDERS_ROUTE_IMPLS: RouteTable = {
  foldersRoots: {
    handle: async (c, s) => {
      foldersLimit(c, s);
      return { roots: await s.deps.launcher.folders.roots(needActor(c.auth)) };
    },
  },

  foldersList: {
    handle: async (c: Call<Record<string, string>, FoldersListQuery>, s) => {
      foldersLimit(c, s);
      return unwrap(await s.deps.launcher.folders.list(c.query, needActor(c.auth))).listing;
    },
  },

  foldersRecent: {
    handle: async (c, s) => {
      foldersLimit(c, s);
      return { recent: await s.deps.launcher.folders.recent(needActor(c.auth)) };
    },
  },

  foldersPin: {
    handle: async (c: Call<Record<string, string>, unknown, FolderPinBody>, s) => {
      unwrap(await s.deps.launcher.folders.pin(c.body, needActor(c.auth)));
      return { ok: true };
    },
    audit: (c: Call<Record<string, string>, unknown, FolderPinBody>) => ({
      target: c.body.root,
      params: { root: c.body.root, path: c.body.path, pinned: c.body.pinned },
    }),
  },

  foldersCreate: {
    handle: async (c: Call<Record<string, string>, unknown, FolderCreateBody>, s) => {
      const actor = needActor(c.auth);
      const limited = s.folderCreateLimiter.hit(actorName(c.auth));
      if (!limited.ok) {
        throw new ApiError('rate_limited', 'Too many new folders; try again later', {
          'retry-after': String(Math.ceil(limited.retryAfterMs / 1000)),
        });
      }
      const { created } = unwrap(await s.deps.launcher.folders.create(c.body, actor));
      return created;
    },
    audit: (c: Call<Record<string, string>, unknown, FolderCreateBody>, out) => ({
      target: c.body.root,
      params: { root: c.body.root, parent: c.body.parent, name: c.body.name, rel: (out.body as { path?: string } | null)?.path },
    }),
  },
};
