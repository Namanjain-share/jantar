/**
 * v0.6 (Fleet): where a session can start, for New session and each way
 * into it (the Board's New, a row's "New session here", a launch waiting on
 * you, the ⌘K entry). Each machine keeps its own switches: the Mac while
 * its own starting is on, a paired machine while it is not watch-only, with
 * starting on there. So `jantar launch on` on a server is enough for the
 * phone to start a session there, whatever the Mac's own switch says. New
 * session exists by those switches alone; the Where row offers only the
 * machines online now, so a link that drops for a second never takes the
 * screen (or the form) away. Small on purpose: the shell loads it with the app.
 */
import { machineOf, stateFeatures, type NodeView, type State } from '@jantar/protocol';
import { useApp } from '../../context.js';

/** A paired machine whose own switch lets a session start there: not watch-only, with starting on. */
function launchOn(n: NodeView): boolean {
  return !n.readOnly && n.features.launch;
}

/** A paired machine a session can start on now: online, with its switch on. */
function startsOn(n: NodeView): boolean {
  return n.online && launchOn(n);
}

/** The paired machines whose switch lets a session start there, online or not, by name. */
export function launchMachines(nodes: State['nodes']): NodeView[] {
  return Object.values(nodes ?? {})
    .filter(launchOn)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The paired machines a session can start on now, by name (the Where row's choices). */
export function startMachines(nodes: State['nodes']): NodeView[] {
  return launchMachines(nodes).filter((n) => n.online);
}

/** A session can start on this machine now (`node` absent: the Mac, while its own starting is on). */
export function canStartOn(state: Pick<State, 'daemon' | 'nodes'>, node: string | undefined): boolean {
  if (node === undefined) return stateFeatures(state).launch;
  const n = machineOf(state, node);
  return n !== null && startsOn(n);
}

/**
 * Starting is on somewhere: on the Mac, or on a paired machine by its own
 * switch (online or not). New session, its Board button, the ⌘K entry and
 * the needs-you count of launches exist while this holds.
 */
export function canStartAnywhere(state: Pick<State, 'daemon' | 'nodes'>): boolean {
  return stateFeatures(state).launch || launchMachines(state.nodes).length > 0;
}

/** canStartAnywhere, kept up to date. */
export function useCanStart(): boolean {
  return useApp((s) => canStartAnywhere(s.state));
}
