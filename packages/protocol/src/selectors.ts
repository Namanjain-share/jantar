/**
 * Small pure helpers every client uses the same way: labels, board order,
 * "needs you", a session's project by folder, e-mail masking. v0.6: which
 * machine a session runs on, its features, its account, and whether Jantar
 * can type into it. v0.6.1: the status the board shows while a session waits
 * on background work (`shownStatus`), and the words for that work.
 */
import { FLEET_COPY, HUB_MACHINE_NAME, type FleetCopyKey } from './constants.js';
import {
  NO_FEATURES,
  type Account,
  type Features,
  type NodeView,
  type PendingRequest,
  type Session,
  type SessionStatus,
} from './models.js';
import { stateFeatures, type State } from './state.js';

/** Basename of a path, for display ("/a/b/my-app" -> "my-app"; a Windows node's "C:\\code\\api" -> "api"). */
export function folderOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
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
  return STATUS_WORD[shownStatus(session)];
}

/** "status · folder · session", the label `jantar status` and `jantar send` print. */
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
  switch (shownStatus(s)) {
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

// ---------------------------------------------------------------------------
// v0.6.1: background work (workflows, agents, shells, monitors) between turns.

/** v0.6.1: workflows plus background agents running; 0 for an ended session. Shells and monitors never count. */
export function backgroundRunning(s: Pick<Session, 'status' | 'background'>): number {
  if (s.status === 'ended' || !s.background) return 0;
  return (s.background.workflows ?? 0) + (s.background.agents ?? 0);
}

/** v0.6.1: the status the board shows: idle with background work running reads as working. */
export function shownStatus(s: Pick<Session, 'status' | 'background'>): SessionStatus {
  return s.status === 'idle' && backgroundRunning(s) > 0 ? 'working' : s.status;
}

export interface BackgroundText {
  /** "1 workflow running", "2 agents running", "1 workflow and 2 agents running"; null with neither. */
  running: string | null;
  /** The newest running workflow's name, "+N" for the other workflows: "demo-sweep", "demo-sweep +1"; null with none named. */
  name: string | null;
  /** The quiet count: "6 shells", "1 monitor", "6 shells · 1 monitor"; null with neither. */
  quiet: string | null;
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** v0.6.1: the words for a session's background work (all null for an ended session or none). */
export function backgroundText(s: Pick<Session, 'status' | 'background'>): BackgroundText {
  const b = s.status === 'ended' ? undefined : s.background;
  const workflows = b?.workflows ?? 0;
  const agents = b?.agents ?? 0;
  const kinds = [workflows ? count(workflows, 'workflow') : '', agents ? count(agents, 'agent') : ''].filter(Boolean);
  const newest = workflows ? b?.names?.[0] : undefined;
  const quiet = [b?.shells ? count(b.shells, 'shell') : '', b?.monitors ? count(b.monitors, 'monitor') : ''].filter(Boolean);
  return {
    running: kinds.length ? `${kinds.join(' and ')} running` : null,
    name: newest ? (workflows > 1 ? `${newest} +${workflows - 1}` : newest) : null,
    quiet: quiet.length ? quiet.join(' · ') : null,
  };
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

// ---------------------------------------------------------------------------
// v0.6: Fleet. The hub's own sessions have no `node`; a paired machine's do.

/**
 * The hub's own sessions (no `node`): every daemon reader of sessions goes
 * through this or `localSession`, so a server's session never reaches the
 * Mac's own parts (Files, folder history, Auto, the planner). Own keys only,
 * in an object with no prototype, so `"constructor"` finds nothing.
 */
export function localSessions(state: Pick<State, 'sessions'>): Record<string, Session> {
  const out = Object.create(null) as Record<string, Session>;
  for (const [sid, s] of Object.entries(state.sessions)) if (s.node === undefined) out[sid] = s;
  return out;
}

/** One of the hub's own sessions, or undefined (a server's session, an unknown sid, or a name like "constructor"). */
export function localSession(state: Pick<State, 'sessions'>, sid: string): Session | undefined {
  if (!Object.hasOwn(state.sessions, sid)) return undefined;
  const s = state.sessions[sid];
  return s && s.node === undefined ? s : undefined;
}

/** A paired machine's view, or null for the hub (no node) and for a node the state doesn't know. */
export function machineOf(state: Pick<State, 'nodes'>, node: string | undefined): NodeView | null {
  if (node === undefined || !state.nodes || !Object.hasOwn(state.nodes, node)) return null;
  return state.nodes[node] ?? null;
}

/** What the phone calls a machine: "Mac" for the hub, else the name the hub gave the node. */
export function machineName(state: Pick<State, 'nodes'>, node: string | undefined): string {
  if (node === undefined) return HUB_MACHINE_NAME;
  return machineOf(state, node)?.name ?? 'a server';
}

/** The hub is always online; a node while its link is up. */
export function machineOnline(state: Pick<State, 'nodes'>, node: string | undefined): boolean {
  if (node === undefined) return true;
  return machineOf(state, node)?.online === true;
}

/** The accounts of a machine: the hub's `state.accounts`, or a node's own (never mixed: every server has an account 0). */
export function accountsOf(state: Pick<State, 'accounts' | 'nodes'>, node?: string): Record<string, Account> {
  if (node === undefined) return state.accounts;
  return machineOf(state, node)?.accounts ?? {};
}

/** The account a session runs on, from its own machine's accounts; null when it can't be told. */
export function sessionAccount(state: Pick<State, 'accounts' | 'nodes'>, session: Pick<Session, 'account' | 'node'>): Account | null {
  if (session.account === null) return null;
  const accounts = accountsOf(state, session.node);
  const key = String(session.account);
  return Object.hasOwn(accounts, key) ? (accounts[key] ?? null) : null;
}

/** The feature switches that govern a session: its own machine's (everything off for a node the state doesn't know). */
export function sessionFeatures(state: Pick<State, 'daemon' | 'nodes'>, session: Pick<Session, 'node'>): Readonly<Features> {
  if (session.node === undefined) return stateFeatures(state);
  return machineOf(state, session.node)?.features ?? NO_FEATURES;
}

/**
 * Why Jantar can't type into a session (the FLEET_COPY line the phone shows
 * instead of the composer), or null when it can. The hub's own sessions and
 * a Mac server's can always be tried (the terminal answers for itself); a
 * tmux server's only once the server has tied the session to a pane
 * (`paneId`); a server with no backend (native Windows) never.
 */
export function typeRefusal(state: Pick<State, 'nodes'>, session: Pick<Session, 'node' | 'paneId'>): FleetCopyKey | null {
  if (session.node === undefined) return null;
  const node = machineOf(state, session.node);
  if (!node || !node.online) return 'offline';
  if (node.readOnly) return 'readOnlyNode';
  switch (node.backend) {
    case 'terminal-app':
      return null;
    case 'tmux':
      return session.paneId ? null : 'notInTmux';
    case 'none':
      return node.os === 'windows' ? 'watchOnlyWindows' : 'notInTmux';
  }
}

/** Whether the phone offers the composer, keypad and control bar for a session (typeRefusal says why not). */
export function canType(state: Pick<State, 'nodes'>, session: Pick<Session, 'node' | 'paneId'>): boolean {
  return typeRefusal(state, session) === null;
}

/** The sentence for a typeRefusal, with the machine's name. */
export function typeRefusalText(state: Pick<State, 'nodes'>, session: Pick<Session, 'node' | 'paneId'>): string | null {
  const key = typeRefusal(state, session);
  return key === null ? null : FLEET_COPY[key](machineName(state, session.node));
}
