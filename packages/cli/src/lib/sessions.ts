/**
 * Resolve the session a user means: a full session id, a unique id prefix
 * (at least 4 characters), or a unique session name / folder name.
 */
import type { Session } from '@jantar/protocol';

export type SessionMatch =
  | { ok: true; session: Session }
  | { ok: false; reason: 'none' | 'ambiguous'; candidates: Session[] };

export function resolveSession(sessions: readonly Session[], query: string): SessionMatch {
  const q = query.trim();
  if (!q) return { ok: false, reason: 'none', candidates: [] };
  const live = sessions.filter((s) => s.status !== 'ended');
  const pools = [live, sessions];

  const exact = sessions.find((s) => s.sid === q);
  if (exact) return { ok: true, session: exact };

  const lower = q.toLowerCase();
  const tests: Array<(s: Session) => boolean> = [
    (s) => q.length >= 4 && s.sid.toLowerCase().startsWith(lower),
    (s) => (s.name ?? '').trim().toLowerCase() === lower,
    (s) => s.folder.toLowerCase() === lower,
  ];
  for (const test of tests) {
    for (const pool of pools) {
      const hits = pool.filter(test);
      if (hits.length === 1) return { ok: true, session: hits[0] as Session };
      if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits };
    }
  }
  return { ok: false, reason: 'none', candidates: [] };
}
