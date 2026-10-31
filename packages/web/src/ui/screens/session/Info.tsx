/**
 * What an open `subagent-info` card adds to the dock (direction.md 5.2).
 *
 * v0.4.2: a subagent's prompt is answered like any other terminal dialog,
 * from TermDialogDock (TermDialog.tsx), titled "A subagent asks · <tool>".
 * While the screen shows no dialog the dock can turn into buttons, this
 * says which tool waits and shows its command from the card.
 */
import type { PendingRequest } from '@jantar/protocol';
import { summarizeTool } from '../../../lib/describe.js';
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
