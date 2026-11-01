/**
 * Ghost rows (spec 5.3.4): a launch that is still on its way shows on the
 * Board under its own STARTING rail until the real session's row takes its
 * place (the session's sid arrives in state, and the ledger's normal entry
 * runs). Same anatomy as a ledger row:
 *
 *   [■] foo  Starting                            (working ink; ember in a dialog)
 *       07 · opened a window · 12s               mono
 *
 * In a dialog the glyph turns needs-you and line 2 says what Claude asks, so
 * the state reads in words too, not by colour alone. Tapping a row opens
 * the launch's receipt. v0.6: once a machine is paired, line 1 names the
 * machine it starts on; a server's launches show by that server's own
 * starting switch.
 */
import clsx from 'clsx';
import { useMemo } from 'react';
import { machineName, type LaunchJob } from '@jantar/protocol';
import { routePath } from '../../../lib/router.js';
import { useApp, useNow } from '../../context.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { useAccountsMode } from '../../shell/data.js';
import { Link } from '../../shell/Link.js';
import { elapsed, folderName, ghostWord, isFinal, launchAccount } from '../launch/stages.js';
import { useCanStart } from '../new/machines.js';
import { hasMachines } from '../session/Info.js';

/** Launches not done yet whose session has no row of its own, oldest first. */
export function ghostLaunches(launches: Record<string, LaunchJob>, sessions: Record<string, unknown>): LaunchJob[] {
  return Object.values(launches)
    .filter((j) => !isFinal(j.stage) && !(j.sid in sessions))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function GhostRow({ job, ground, now }: { job: LaunchJob; ground: 'surface' | 'bg'; now: number }) {
  const dialog = job.stage === 'dialog';
  // One Claude login: every launch is on it, so the line names no account.
  const single = useAccountsMode() === 'single';
  const machine = useApp((s) => (hasMachines(s.state) ? machineName(s.state, job.node) : null));
  const href = routePath({ name: 'new', root: job.rootId, launch: job.id });
  return (
    <Link
      href={href}
      data-launch={job.id}
      data-glyph={dialog ? 'needs' : 'working'}
      // The ledger row's frame (Row.tsx rowClass): hairline, 52 / 64 px, hover. A ghost is never selected.
      className={clsx(
        'relative block scroll-mt-28 border-b border-line px-16 pb-9 pt-10 transition-colors duration-120 ease-hover hover:bg-hover focus-visible:-outline-offset-2 md:pb-7 md:pt-8',
        ground === 'surface' ? 'bg-surface' : 'bg-bg',
      )}
    >
      <span className="flex h-20 min-w-0 items-center md:h-18">
        <span className="mr-8 flex-none">
          <StatusGlyph state={dialog ? 'needs' : 'working'} />
        </span>
        <span className="min-w-0 max-w-3/5 flex-initial truncate type-row font-medium text-ink">{folderName(job.display)}</span>
        <span className="ml-8 min-w-0 flex-initial truncate type-row text-ink-2">Starting</span>
        {machine ? (
          <span data-machine className="ml-auto max-w-1/3 flex-none truncate pl-12 type-mono text-ink-3">
            {machine}
          </span>
        ) : null}
      </span>
      <span className="mt-4 flex h-20 min-w-0 items-center pl-24 type-mono text-ink-3 md:mt-0 md:h-18">
        <span className="min-w-0 truncate">
          {single ? null : `${launchAccount(job)} · `}
          <span className={dialog ? 'text-ink' : 'text-ink-2'}>{ghostWord(job)}</span> · {elapsed(job.createdAt, now)}
        </span>
      </span>
    </Link>
  );
}

/** The STARTING rail and its ghost rows; nothing while launching is off or nothing is starting. */
export function GhostRows({ ground }: { ground: 'surface' | 'bg' }) {
  const launches = useApp((s) => s.state.launches);
  const sessions = useApp((s) => s.state.sessions);
  const on = useCanStart();
  // While launching is off the launches slice is not even read.
  const ghosts = useMemo(() => (on ? ghostLaunches(launches, sessions) : []), [on, launches, sessions]);
  if (!on || !ghosts.length) return null;
  return <GhostList ghosts={ghosts} ground={ground} />;
}

/** Mounted only while something is starting, so the 1 s clock for "12s" runs only then. */
function GhostList({ ghosts, ground }: { ghosts: LaunchJob[]; ground: 'surface' | 'bg' }) {
  const now = useNow(1000);
  return (
    <div data-ghosts>
      <RailLabel sticky={false} ground={ground} count={ghosts.length}>
        Starting
      </RailLabel>
      {ghosts.map((j) => (
        <GhostRow key={j.id} job={j} ground={ground} now={now} />
      ))}
    </div>
  );
}
