/**
 * Small pure helpers every client uses the same way: labels, board order,
 * "needs you", a session's project by folder, e-mail masking.
 */
import type { PendingRequest, Session } from './models.js';
import type { State } from './state.js';

/** Basename of a path, for display ("/a/b/my-app" -> "my-app"). */
export function folderOf(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || '/';
}

const PENDING_WORD: Record<PendingRequest['kind'], string> = {
  permission: 'Permission',
  question: 'Question',
  plan: 'Plan approval',
  'subagent-info': 'Subagent waiting',
};

const STATUS_WORD: Record<Session['status'], string> = {
  working: 'Working',
  idle: 'Done',
  waiting: 'Waiting',
  compacting: 'Compacting',
  ended: 'Ended',
};

export function statusWord(session: Session, pending?: PendingRequest | null): string {
  if (pending) return PENDING_WORD[pending.kind];
  return STATUS_WORD[session.status];
}

/** "status · folder · session", the label used on the board and in pushes. */
export function sessionLabel(session: Session, pending?: PendingRequest | null): string {
  const name = session.name?.trim() || session.sid.slice(0, 8);
  return `${statusWord(session, pending)} · ${session.folder} · ${name}`;
}

/** Open (or decided but unconfirmed) cards of a session, oldest first. */
export function pendingFor(state: State, sid: string): PendingRequest[] {
  return Object.values(state.pending)
    .filter((p) => p.sid === sid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The session needs the user: an open card, or Claude says it is waiting. */
export function needsYou(state: State, sid: string): boolean {
  const s = state.sessions[sid];
  if (!s) return false;
  if (s.status === 'waiting') return true;
  return Object.values(state.pending).some(
    (p) => p.sid === sid && p.state === 'open' && p.kind !== 'subagent-info',
  );
}

function rank(state: State, s: Session): number {
  if (needsYou(state, s.sid)) return 0;
  switch (s.status) {
    case 'idle':
      return 1; // your turn
    case 'working':
      return 2;
    case 'compacting':
      return 3;
    case 'waiting':
      return 0;
    case 'ended':
      return 4;
  }
}

/**
 * When a session started needing the user: its oldest open card, else when
 * it began waiting. Only meaningful while needsYou() is true.
 */
export function needsSince(state: State, sid: string): string {
  let oldest: string | null = null;
  for (const p of Object.values(state.pending)) {
    if (p.sid !== sid || p.state !== 'open' || p.kind === 'subagent-info') continue;
    if (oldest === null || p.createdAt < oldest) oldest = p.createdAt;
  }
  return oldest ?? state.sessions[sid]?.statusSince ?? '';
}

/**
 * Board order: "your turn" first (needs you, then done), then working, then
 * the rest. Needs-you sessions are a queue, oldest wait first (direction.md
 * 5.1), so "1", Start and the first row are the one waiting longest. Every
 * other group shows the latest change first.
 */
export function boardOrder(state: State): Session[] {
  const keyed = Object.values(state.sessions).map((s) => {
    const r = rank(state, s);
    return { s, r, since: r === 0 ? needsSince(state, s.sid) : s.statusSince };
  });
  keyed.sort((a, b) => {
    if (a.r !== b.r) return a.r - b.r;
    const t = a.r === 0 ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since);
    if (t !== 0) return t;
    return a.s.sid.localeCompare(b.s.sid);
  });
  return keyed.map((k) => k.s);
}

/**
 * A project's folder holds `cwd` (the folder itself or anything under it).
 * v0.5.3: moved here from the web, so the Board's chip and the daemon's
 * folder todos agree.
 */
export function inFolder(cwd: string, folder: string): boolean {
  if (!folder.startsWith('/')) return false;
  const base = folder.length > 1 ? folder.replace(/\/+$/, '') : folder;
  return cwd === base || cwd.startsWith(base === '/' ? '/' : `${base}/`);
}

/** The project whose folder holds `cwd`; the deepest folder wins when two do. */
export function projectFor<P extends { folder?: string | null }>(cwd: string, projects: readonly P[]): P | null {
  let best: P | null = null;
  for (const p of projects) {
    if (p.folder && inFolder(cwd, p.folder) && (!best || (best.folder?.length ?? 0) < p.folder.length)) best = p;
  }
  return best;
}

/**
 * Mask an e-mail address for display: "alice@example.com" -> "a***@e***.com".
 * Keeps the first character of the local part and of the domain, and the TLD.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email ? `${email[0]}***` : '';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${host ? `${host[0]}***` : ''}${tld}`;
}
