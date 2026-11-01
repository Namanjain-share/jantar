/**
 * v0.6 (Fleet): the Accounts of each paired machine, under the Mac's, one
 * section per machine by name (spec 0.6). Its own chunk: it loads only once
 * a machine is paired.
 *
 *   build-1 · cswap                      Read at build-1
 *     01  ▇▇▇▁▁▁▁▁  35%  resets 15:40     (the phone rows, read at that machine)
 *   build-2 · 2 config dirs              No usage numbers on this machine
 *     claude   ~/.claude                 1 session
 *     work     ~/.claude-work            2 sessions
 *   win-1 · 1 login                      No usage numbers on this machine
 *     claude   ~/.claude                 1 session
 *
 * A machine's accounts are its own (`accountsOf`): they never mix with the
 * Mac's, as every server has an account 0. With config dirs (`dirs`) the
 * account 0 is ~/.claude and every other one ~/.claude-<alias>; nothing
 * reads usage there. Logins stay at the machine: nothing here changes one.
 */
import { boardOrder, FLEET_COPY, type Account, type NodeView, type State } from '@jantar/protocol';
import { useMemo, useState } from 'react';
import { useApp, useNow } from '../../context.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { useFrame } from '../../shell/layout.js';
import { offlineSince } from '../session/Info.js';
import { ceilingOf } from './hooks.js';
import { buildRows } from './model.js';
import { PhoneRows } from './PhoneRows.js';
import { SessionList, sessionCells } from './SessionCells.js';
import { sessionsText } from './Single.js';

/** "cswap", "2 config dirs", "1 login": how a machine's accounts are read. */
export function modeWord(node: Pick<NodeView, 'accountsMode' | 'accounts'>): string {
  if (node.accountsMode === 'cswap') return 'cswap';
  const n = Object.keys(node.accounts).length;
  return n === 1 ? '1 login' : `${n} config dirs`;
}

/** A config-dir account's folder: ~/.claude for account 0, else ~/.claude-<alias>. */
export function dirOf(a: Pick<Account, 'id' | 'alias'>): string {
  return a.id === 0 || !a.alias ? '~/.claude' : `~/.claude-${a.alias}`;
}

/** What the section says on the right: offline, where cswap was read, or that nothing reads usage there. */
export function asideOf(node: NodeView, now: number): string {
  if (!node.online) return offlineSince(node, now);
  return node.accountsMode === 'cswap' ? `Read at ${node.name}` : FLEET_COPY.noUsage(node.name);
}

function DirAccounts({ node, state, now, phone }: { node: NodeView; state: State; now: number; phone: boolean }) {
  const order = useMemo(() => boardOrder(state).filter((s) => s.node === node.id), [state, node.id]);
  const accounts = Object.values(node.accounts).sort((a, b) => a.id - b.id);
  return (
    <ul aria-label={`Accounts on ${node.name}`}>
      {accounts.map((a) => {
        const cells = sessionCells(
          state,
          order.filter((s) => s.account === a.id),
          now,
        );
        return (
          <li key={a.id} data-account={a.id} className={phone ? 'border-b border-line px-16 pb-8 pt-12' : 'border-b border-line pb-8 pt-12'}>
            <div className="flex h-20 min-w-0 items-center gap-12">
              <span className="min-w-0 truncate type-row font-medium text-ink">{a.alias ?? `account ${a.id}`}</span>
              {node.accountsMode === 'dirs' ? <span className="min-w-0 truncate type-mono text-ink-3">{dirOf(a)}</span> : null}
              <span className="ml-auto flex-none type-mono text-ink-3">{sessionsText(cells.length)}</span>
            </div>
            {cells.length ? (
              <div className={phone ? 'mt-4' : 'mt-4 px-16'}>
                <SessionList cells={cells} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function CswapAccounts({ node, state, now, phone }: { node: NodeView; state: State; now: number; phone: boolean }) {
  // The Mac's ceiling plan reads the Mac's cswap only: a server's bars mark the default ceiling.
  const ceiling = ceilingOf(null);
  const rows = useMemo(() => buildRows(state, null, ceiling, now, node.id), [state, ceiling, now, node.id]);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (id: number) =>
    setOpen((cur) => {
      const s = new Set(cur);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  return <PhoneRows rows={rows} state={state} ceiling={ceiling} weeklyCeiling={null} now={now} bar={phone ? 200 : 320} open={open} onToggle={toggle} />;
}

export function MachineAccounts() {
  const state = useApp((s) => s.state);
  const now = useNow(30_000);
  const phone = useFrame() === 'phone';
  const nodes = Object.values(state.nodes ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!nodes.length) return null;
  return (
    <section aria-label="Accounts on other machines" className={phone ? 'pb-24' : 'px-32 pb-32'}>
      <div className={phone ? '' : 'max-w-640'}>
        {nodes.map((node) => (
          <section key={node.id} aria-label={`${node.name} accounts`} data-machine={node.name} className={node.online ? 'mt-24' : 'mt-24 opacity-60'}>
            <RailLabel ground="bg" sticky={false} inset={phone} aside={asideOf(node, now)}>
              {`${node.name} · ${modeWord(node)}`}
            </RailLabel>
            {node.accountsMode === 'cswap' ? (
              <CswapAccounts node={node} state={state} now={now} phone={phone} />
            ) : (
              <DirAccounts node={node} state={state} now={now} phone={phone} />
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
