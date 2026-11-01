/**
 * What an open `subagent-info` card adds to the dock (direction.md 5.2).
 *
 * v0.4.2: a subagent's prompt is answered like any other terminal dialog,
 * from TermDialogDock (TermDialog.tsx), titled "A subagent asks · <tool>".
 * While the screen shows no dialog the dock can turn into buttons, this
 * says which tool waits and shows its command from the card.
 *
 * v0.6 (Fleet): the words for a paired machine, shared by the session
 * screen, its cards, the Board, Accounts, New session and Machines. The
 * name is always the one the Mac gave the machine (`machineName`), never
 * the machine's own, so a server can't make its card read as the Mac's.
 * While no machine is paired (`hasMachines`) none of it shows anywhere.
 */
import {
  FLEET_COPY,
  machineName,
  machineOf,
  typeRefusal,
  type NodeBackend,
  type NodeOs,
  type NodeView,
  type PendingRequest,
  type Session,
  type State,
} from '@jantar/protocol';
import { summarizeTool } from '../../../lib/describe.js';
import { clock } from '../../../lib/format.js';
import { CmdBox } from './Fields.js';

/** "A subagent asks", plus the tool the card names. */
export function subagentTitle(p: PendingRequest): string {
  return p.tool ? `A subagent asks · ${p.tool}` : 'A subagent asks';
}

export function SubagentAsk({ p }: { p: PendingRequest }) {
  const first = summarizeTool(p.tool, p.input).fields[0];
  return (
    <>
      <p className="mt-8 type-body text-ink">A subagent is waiting in the terminal{p.tool ? ` (${p.tool})` : ''}.</p>
      {first ? <CmdBox text={first.text} className="mt-12" /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// v0.6: paired machines

export const OS_WORD: Record<NodeOs, string> = { macos: 'macOS', linux: 'Linux', wsl: 'Linux (WSL)', windows: 'Windows' };
/** How a machine reaches its terminals, in one word ("watch": native Windows, cards only). */
export const BACKEND_WORD: Record<NodeBackend, string> = { 'terminal-app': 'Terminal', tmux: 'tmux', none: 'watch' };

/** At least one machine is paired: until then every screen looks as it did before Fleet (an older daemon sends no `nodes`). */
export function hasMachines(state: Pick<State, 'nodes'>): boolean {
  return state.nodes !== undefined && Object.keys(state.nodes).length > 0;
}

/** "offline since 14:02" */
export function offlineSince(node: Pick<NodeView, 'since'>, now: number): string {
  const at = clock(node.since, now);
  return at ? `offline since ${at}` : 'offline';
}

/** The session header's machine line, "build-1 · Linux · tmux" (offline: "· offline since 14:02"); null for the Mac's own sessions. */
export function machineLine(state: Pick<State, 'nodes'>, session: Pick<Session, 'node'>, now: number): string | null {
  if (session.node === undefined) return null;
  const node = machineOf(state, session.node);
  if (!node) return machineName(state, session.node);
  const parts = [node.name, OS_WORD[node.os], BACKEND_WORD[node.backend]];
  if (!node.online) parts.push(offlineSince(node, now));
  return parts.join(' · ');
}

/**
 * Whether the Mac can read a session's screen: the Mac's own, and a
 * server's while it is online and the session has a terminal to read (a
 * tmux pane; never native Windows). A watch-only server's screen reads
 * too, where it has one.
 */
export function screenReadable(state: Pick<State, 'nodes'>, session: Pick<Session, 'node' | 'paneId'>): boolean {
  if (session.node === undefined) return true;
  const node = machineOf(state, session.node);
  if (!node?.online) return false;
  if (node.backend === 'tmux') return Boolean(session.paneId);
  return node.backend === 'terminal-app';
}

/** A hook card from a paired machine: the machine's name, and why it can't be answered now (offline, watch-only). */
export interface CardMachine {
  name: string;
  blocked: string | null;
}

export function cardMachine(state: Pick<State, 'nodes'>, session: Pick<Session, 'node' | 'paneId'>): CardMachine | undefined {
  if (session.node === undefined) return undefined;
  const name = machineName(state, session.node);
  const key = typeRefusal(state, session);
  return { name, blocked: key === 'offline' ? `${name} is offline` : key === 'readOnlyNode' ? FLEET_COPY.readOnlyNode(name) : null };
}

/** "build-1 asks · Permission · Bash": the Mac's name for the machine heads its cards. */
export function cardTitle(title: string, m: CardMachine | undefined): string {
  return m ? `${m.name} asks · ${title}` : title;
}

/**
 * A machine's permission card whose input was too large to send to the phone: the Mac cut it to `{}`
 * (a tool that takes no input reads the same). A plan or question card that lacks its plan or options
 * says so in its own words, right either way: read or answer it at that machine.
 */
export function tooLarge(p: Pick<PendingRequest, 'kind' | 'input'>, m: CardMachine | undefined): boolean {
  const input = p.input;
  return (
    m !== undefined &&
    p.kind === 'permission' &&
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0
  );
}

/** The lines a machine's card adds: its input was too large to show (`tooLarge`), and why it is off. */
export function CardMachineLines({ p, m }: { p: PendingRequest; m: CardMachine | undefined }) {
  if (!m) return null;
  return (
    <>
      {tooLarge(p, m) ? <p className="mt-8 type-small text-ink-2">{FLEET_COPY.cardTooLarge(m.name)}</p> : null}
      {m.blocked ? <p className="mt-12 type-mono text-ink-3">{m.blocked}</p> : null}
    </>
  );
}
