/**
 * v0.6 (Fleet): where a session can start, for New session and each way
 * into it (the Board's New, a row's "New session here", a launch waiting on
 * you, the ⌘K entry). Each machine keeps its own switches: the Mac while
 * its own starting is on, a paired machine while it is online, not
 * watch-only, with starting on there. So `jantar launch on` on a server is
 * enough for the phone to start a session there, whatever the Mac's own
 * switch says. Small on purpose: the shell loads it with the app.
 */
import { machineOf, stateFeatures, type NodeView, type State } from '@jantar/protocol';
import { useApp } from '../../context.js';

/** A paired machine a session can start on now: online, not watch-only, with starting on there. */
function startsOn(n: NodeView): boolean {
  return n.online && !n.readOnly && n.features.launch;
}

/** The paired machines a session can start on now, by name. */
export function startMachines(nodes: State['nodes']): NodeView[] {
  return Object.values(nodes ?? {})
    .filter(startsOn)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A session can start on this machine now (`node` absent: the Mac, while its own starting is on). */
export function canStartOn(state: Pick<State, 'daemon' | 'nodes'>, node: string | undefined): boolean {
  if (node === undefined) return stateFeatures(state).launch;
  const n = machineOf(state, node);
  return n !== null && startsOn(n);
}

/** A session can start somewhere: on the Mac, or on a paired machine. New session exists while this holds. */
export function canStartAnywhere(state: Pick<State, 'daemon' | 'nodes'>): boolean {
  return stateFeatures(state).launch || startMachines(state.nodes).length > 0;
}

/** canStartAnywhere, kept up to date. */
export function useCanStart(): boolean {
  return useApp((s) => canStartAnywhere(s.state));
}
