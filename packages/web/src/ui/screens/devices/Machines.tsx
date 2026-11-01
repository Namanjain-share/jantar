/**
 * v0.6 (Fleet): Machines, the paired servers, inside Devices (spec 0.7).
 * Its own chunk, shown only once a machine is paired.
 *
 *   MACHINES 3
 *   build-1   Linux · tmux                 online · 3 sessions
 *             Jantar 0.6.0
 *   build-2   Linux (WSL) · tmux           online · 1 session
 *             Jantar 0.5.9 · Mac has 0.6.0
 *             build-2 runs an older link version: update Jantar there
 *   build-3   Linux · tmux                 offline since 14:02
 *             Jantar 0.6.0                              [ Remove… ]
 *   Pair one at the Mac: jantar node pair
 *
 * From state.nodes, so every device sees it. Remove… (two taps, admin
 * devices only, as Revoke is for a device) sends DELETE /v1/machines/:id
 * with this device's secret: the machine's link closes and its sessions
 * leave the board. Pairing happens at the Mac only.
 */
import clsx from 'clsx';
import { useState } from 'react';
import { CLI_NAME, FLEET_COPY, type NodeView } from '@jantar/protocol';
import { errorText } from '../../../lib/api.js';
import { newIdempotencyKey } from '../../../lib/ids.js';
import { useApp, useDeps, useNow } from '../../context.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { BACKEND_WORD, OS_WORD, offlineSince } from '../session/Info.js';
import { TwoTap } from '../session/TwoTap.js';
import { readLocalDevice } from './local.js';
import { InlineError, Receipt } from './parts.js';

export const PAIR_LINE = `${CLI_NAME} node pair`;

/** "online · 3 sessions", or "offline since 14:02". */
export function presenceText(n: NodeView, sessions: number, now: number): string {
  return n.online ? `online · ${sessions} session${sessions === 1 ? '' : 's'}` : offlineSince(n, now);
}

/** "Jantar 0.6.0", with the Mac's version when it differs ("Jantar 0.5.9 · Mac has 0.6.0"). */
export function versionText(n: Pick<NodeView, 'version'>, mac: string | undefined): string {
  const own = `Jantar ${n.version || 'unknown'}`;
  return mac && n.version !== mac ? `${own} · Mac has ${mac}` : own;
}

function MachineRow({
  n,
  sessions,
  mac,
  now,
  admin,
  removing,
  error,
  onRemove,
}: {
  n: NodeView;
  sessions: number;
  mac: string | undefined;
  now: number;
  admin: boolean;
  removing: boolean;
  error: string | null;
  onRemove: () => void;
}) {
  return (
    <li data-machine={n.name} className="border-b border-line py-8">
      <div className="flex min-h-40 flex-wrap items-center gap-x-12 gap-y-4">
        <span className={clsx('min-w-0 truncate type-row font-medium', n.online ? 'text-ink' : 'text-ink-3')}>{n.name}</span>
        <span className="type-mono text-ink-2">
          {OS_WORD[n.os]} · {BACKEND_WORD[n.backend]}
        </span>
        <span className="ml-auto type-mono text-ink-3">{presenceText(n, sessions, now)}</span>
      </div>
      <div className="flex min-h-32 flex-wrap items-center gap-x-12 gap-y-4">
        <span className="min-w-0 flex-1 type-mono text-ink-3">{versionText(n, mac)}</span>
        {admin ? (
          <TwoTap size="md" disabled={removing} onConfirm={onRemove} confirmLabel={`Tap again to remove ${n.name}`}>
            Remove…
          </TwoTap>
        ) : null}
      </div>
      {n.problem === 'version' ? <p className="pb-4 type-small text-ink-2">{FLEET_COPY.versionProblem(n.name)}</p> : null}
      {error ? <InlineError>{error}</InlineError> : null}
    </li>
  );
}

export function Machines() {
  const { api } = useDeps();
  const nodes = useApp((s) => s.state.nodes);
  const sessions = useApp((s) => s.state.sessions);
  const mac = useApp((s) => s.state.daemon?.daemonVersion);
  const now = useNow(30_000);
  const me = readLocalDevice();
  // As for Paired devices: a device that knows it was paired without admin is offered no Remove.
  const admin = !(me !== null && Array.isArray(me.scopes) && !me.scopes.includes('admin'));
  const [removing, setRemoving] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const list = Object.values(nodes ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  const count = (id: string) => Object.values(sessions).filter((s) => s.node === id).length;

  const remove = async (n: NodeView) => {
    setRemoving(n.id);
    setFailed(null);
    setDone(null);
    try {
      await api.machineRevoke(n.id, newIdempotencyKey());
      setDone(`${n.name} is removed. Pair it again at the Mac to bring it back.`);
    } catch (e) {
      setFailed({ id: n.id, text: errorText(e) });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section aria-label="Machines">
      <RailLabel ground="bg" sticky={false} inset={false} count={list.length} className="mt-40">
        Machines
      </RailLabel>
      <ul aria-label="Machines">
        {list.map((n) => (
          <MachineRow
            key={n.id}
            n={n}
            sessions={count(n.id)}
            mac={mac}
            now={now}
            admin={admin}
            removing={removing === n.id}
            error={failed?.id === n.id ? failed.text : null}
            onRemove={() => void remove(n)}
          />
        ))}
      </ul>
      {done ? <Receipt className="mt-12">{done}</Receipt> : null}
      <p className="mt-12 type-small text-ink-3">
        Pair one at the Mac: <code className="type-mono text-ink-2">{PAIR_LINE}</code>
      </p>
    </section>
  );
}
