/**
 * Status precedence (docs/hook-protocol.md, section 7), shared by the
 * session-file source and the hooks bridge so both apply the same rules:
 *
 * 1. "ended" always wins, and only a session-file observation newer than the
 *    end revives the session: a live process writes that sid's file again
 *    (resumed in another process, or a second copy that outlived the first).
 * 2. Transcript heuristics only replace a status that itself came from the
 *    transcript (they never override hooks or Claude's session file).
 * 3. Otherwise the newest observation wins: an observation older than the
 *    session's `statusAt` (or `statusSince`) is stale and loses. This covers
 *    out-of-order async hooks and "a hook-derived state older than the
 *    session file's statusUpdatedAt loses".
 * 4. On a tie, hook beats session-file beats transcript.
 */
import type { Session, SessionOptionalKey, SessionPatch, SessionStatus, StatusSource } from '@jantar/protocol';

export interface StatusObservation {
  status: SessionStatus;
  source: StatusSource;
  /** Epoch ms of the observation (hook `_jantar.ts`, session file statusUpdatedAt, transcript entry time). */
  at: number;
  waitingFor?: string;
}

export type StatusFields = Pick<Session, 'status' | 'statusSource' | 'statusSince' | 'statusAt' | 'waitingFor'>;

export interface StatusChange {
  patch: SessionPatch;
  unset: SessionOptionalKey[];
}

const RANK: Record<StatusSource, number> = { hook: 3, 'session-file': 2, transcript: 1 };

/** Claude's session-file status word to ours. */
export function mapRawStatus(raw: string | undefined): SessionStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'busy':
    case 'working':
    case 'running':
      return 'working';
    case 'waiting':
      return 'waiting';
    case 'compacting':
      return 'compacting';
    default:
      return 'idle';
  }
}

/** Status fields for a brand-new session. */
export function initialStatus(obs: StatusObservation): StatusFields {
  const iso = new Date(obs.at).toISOString();
  const out: StatusFields = { status: obs.status, statusSource: obs.source, statusSince: iso, statusAt: iso };
  if (obs.status === 'waiting' && obs.waitingFor) out.waitingFor = obs.waitingFor;
  return out;
}

/**
 * The change `obs` makes to `current`, or null when it is stale, outranked
 * or changes nothing. Pure.
 */
export function mergeStatus(current: StatusFields | undefined, obs: StatusObservation): StatusChange | null {
  if (!current) {
    const f = initialStatus(obs);
    return { patch: f, unset: [] };
  }
  if (current.status === 'ended') {
    if (obs.source !== 'session-file' || obs.status === 'ended') return null;
    if (!(obs.at > Date.parse(current.statusAt ?? current.statusSince))) return null;
  }

  const iso = new Date(obs.at).toISOString();
  const nextWaiting = obs.status === 'waiting' ? obs.waitingFor : undefined;

  if (obs.status !== 'ended') {
    if (obs.source === 'transcript' && current.statusSource !== 'transcript') return null;
    const curAt = Date.parse(current.statusAt ?? current.statusSince);
    if (obs.at < curAt) return null;
    if (obs.at === curAt && RANK[obs.source] < RANK[current.statusSource]) return null;
  }

  const sameStatus = obs.status === current.status && nextWaiting === current.waitingFor;
  if (sameStatus) {
    const curAt = Date.parse(current.statusAt ?? current.statusSince);
    if (obs.at === curAt && obs.source === current.statusSource) return null;
    const patch: SessionPatch = { statusAt: iso };
    if (obs.source !== current.statusSource) patch.statusSource = obs.source;
    return { patch, unset: [] };
  }

  const patch: SessionPatch = { status: obs.status, statusSource: obs.source, statusSince: iso, statusAt: iso };
  const unset: SessionOptionalKey[] = [];
  if (nextWaiting !== undefined) patch.waitingFor = nextWaiting;
  else if (current.waitingFor !== undefined) unset.push('waitingFor');
  return { patch, unset };
}
