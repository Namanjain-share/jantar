/**
 * Life shell routes: lifeStatus (also on ctl.sock), lifeToday, and the
 * ctl.sock-only lifeBackup and lifeRestore (`localOnly`: over TCP the
 * pipeline refuses them before a handler runs). Status, backup and restore
 * answer while life.db is broken; that is how it is repaired.
 *
 * The pipeline has already checked control scope, the switch and a broken
 * life.db, and validated the strict bodies. Write replies carry a file name
 * and a time, never Life text; the audit row names the backup file. Backup
 * and restore (the Mac only) are not counted against s.lifeWriteLimiter;
 * the pipeline counts every write behind a Life switch.
 */
import type { LifeRestoreBody } from '@jantar/protocol';
import { lifeValue, type Call, type RouteTable } from '../route-kit.js';

type DayQuery = { day?: string };

export const LIFE_ROUTE_IMPLS: RouteTable = {
  lifeStatus: {
    handle: (_c: Call, s) => s.deps.life.status(),
  },

  lifeToday: {
    handle: (c: Call<Record<string, string>, DayQuery>, s) => lifeValue(s.deps.life.today(c.query.day)),
  },

  lifeBackup: {
    handle: async (_c: Call, s) => lifeValue(await s.deps.life.backup()),
    audit: (_c, out) => {
      const file = (out.body as { file?: unknown } | null)?.file;
      return typeof file === 'string' ? { target: file } : {};
    },
  },

  lifeRestore: {
    handle: async (c: Call<Record<string, string>, unknown, LifeRestoreBody>, s) => {
      const { kept } = lifeValue(await s.deps.life.restore(c.body.file));
      return { ok: true as const, kept };
    },
    audit: (c: Call<Record<string, string>, unknown, LifeRestoreBody>) => ({ target: c.body.file }),
  },
};
