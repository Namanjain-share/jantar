/**
 * Board: the attention ledger (direction.md 5.1). One display line ("3 need
 * you" + Start, or "All clear · 6 working"), then the sessions under sticky
 * rails: NEEDS YOU, YOUR TURN, WORKING, ENDED. Two-line rows (52 px desktop,
 * 64 px phone) read "status · folder · session", what it is doing, and the
 * account with its 5-hour %.
 *
 * Frames: the 340 / 440 px --surface ledger column beside the Desk or a
 * session when the board's SplitPane is split (0.11: by the pane's width,
 * kit/SplitPane.tsx), full width otherwise, and the phone list under the
 * shell header.
 * The display line stays put; only the rows scroll.
 *
 * States (5.6): skeleton rows before the first sync with nothing cached; the
 * cached state painted at once otherwise (no spinner over data you have);
 * the empty board teaches with the legend and an EXAMPLE DATA row.
 *
 * Keys (j / k, Enter, 1-9) live in the shell and follow the same board order.
 */
import clsx from 'clsx';
import { useCallback, useLayoutEffect, useMemo } from 'react';
import { routePath } from '../../lib/router.js';
import { EmptyState } from '../kit/EmptyState.js';
import { SkeletonRows } from '../kit/Skeleton.js';
import { useApp, useDeps, useNavigate, useNow, useRoute } from '../context.js';
import { launchesNeedingYou, useCeiling } from '../shell/data.js';
import { useCanStart } from './new/machines.js';
import { useSplit } from '../kit/SplitPane.js';
import { useLayout } from '../shell/layout.js';
import { wireStateCache } from './board/cache.js';
import { DisplayLine } from './board/DisplayLine.js';
import { GhostRows } from './board/GhostRow.js';
import { Ledger } from './board/Ledger.js';
import { groupRows, ledgerGroups, type RowModel } from './board/model.js';
import { NewButton, WithNewButton } from './board/NewButton.js';
import { Queue } from './board/Queue.js';
import { RowBody } from './board/Row.js';
import { useSeen } from './board/seen.js';

/** The ghosted row on the empty board, stamped EXAMPLE DATA by EmptyState. */
const EXAMPLE: RowModel = {
  sid: 'example',
  session: {
    sid: 'example',
    pid: 0,
    procStart: '',
    account: 3,
    configDir: '',
    cwd: '',
    folder: 'web-app',
    name: 'fix login redirect',
    entrypoint: 'cli',
    status: 'waiting',
    statusSource: 'hook',
    statusSince: '1970-01-01T00:00:00.000Z',
    subagentsRunning: 0,
  },
  glyph: 'needs',
  group: 'needs',
  folder: 'web-app',
  name: 'fix login redirect',
  age: 'waiting 4m',
  ageEmber: false,
  line2: { kind: 'needs', word: 'Question', text: 'Which module should own the session cookie?', code: false },
  account: { id: '03', pct: 81 },
  move: null,
  tag: null,
  files: null,
};

function EmptyBoard({ ceiling, ground }: { ceiling: number; ground: 'surface' | 'bg' }) {
  return (
    <EmptyState
      title="No Claude sessions running"
      legend
      example={
        <div className={clsx('relative block border-y border-line pb-9 pt-10 desk:pb-7 desk:pt-8', ground === 'surface' ? 'bg-surface' : 'bg-bg')}>
          <RowBody row={EXAMPLE} ceiling={ceiling} />
        </div>
      }
    >
      <p>
        Start <code className="type-mono text-ink">claude</code> in a Terminal tab on your Mac and it shows up here, tagged with its account.
      </p>
      <NewButton wide className="mt-16" />
    </EmptyState>
  );
}

export function Board() {
  const { store, now: clock = Date.now } = useDeps();
  const state = useApp((s) => s.state);
  const conn = useApp((s) => s.conn.status);
  const route = useRoute();
  const navigate = useNavigate();
  const phone = useLayout().chrome === 'phone';
  // The --surface column beside a session or the Desk (or over a session, c25); the page's ground when the ledger is the page.
  const splitCtx = useSplit();
  const split = (splitCtx?.split ?? false) || Boolean(splitCtx?.overlay?.open);
  // 0.11 (c25): a single-mode Board beside the phone (an iPad in portrait) has the waiting cards above its ledger.
  const queue = !phone && !(splitCtx?.split ?? false) && !splitCtx?.overlay;
  const now = useNow(10_000);
  const ceiling = useCeiling();

  // Paint the last known state before the first paint on later loads, and keep it current.
  useLayoutEffect(() => wireStateCache(store), [store]);

  const groups = useMemo(() => ledgerGroups(state, now), [state, now]);
  const selectedSid = route.name === 'session' ? route.sid : null;
  const { unseen, markSeen } = useSeen(state, selectedSid, clock);
  const ground = split ? 'surface' : 'bg';
  const needs = groupRows(groups, 'needs');
  // A launch waiting on its trust card needs you too (U8): counted with the sessions, after them.
  // v0.6: a launch on a server needs you as one on the Mac does (each machine keeps its own starting switch).
  const canStart = useCanStart();
  const waitingLaunches = useMemo(() => (canStart ? launchesNeedingYou(state) : []), [canStart, state]);
  const working = groupRows(groups, 'working').length;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  const open = useCallback(
    (row: RowModel, href: string) => {
      markSeen(row.session);
      navigate(href);
    },
    [markSeen, navigate],
  );

  if (total === 0) {
    if (state.seq === 0 && (conn === 'connecting' || conn === 'offline')) {
      return (
        <section aria-label="Sessions" aria-busy="true" className="flex h-full min-h-0 flex-col">
          <div className="flex h-pane flex-none items-center border-b border-line px-16" aria-hidden="true">
            <span className="h-12 w-136 bg-line" />
          </div>
          <SkeletonRows />
        </section>
      );
    }
    return (
      <section aria-label="Sessions" className="no-scrollbar h-full overflow-y-auto">
        <GhostRows ground={ground} />
        <EmptyBoard ceiling={ceiling} ground={ground} />
      </section>
    );
  }

  const first = needs[0];
  return (
    <section aria-label="Sessions" className="flex h-full min-h-0 flex-col">
      <WithNewButton ground={ground}>
        <DisplayLine
          needs={needs.length + waitingLaunches.length}
          working={working}
          ground={ground}
          phone={phone}
          onStart={() => {
            const card = waitingLaunches[0];
            if (first) open(first, `/s/${encodeURIComponent(first.sid)}`);
            else if (card) navigate(routePath({ name: 'new', root: card.rootId, launch: card.id }));
          }}
        />
      </WithNewButton>
      <Ledger groups={groups} ceiling={ceiling} ground={ground} selectedSid={selectedSid} unseen={unseen} onOpen={open} head={queue && needs.length ? <Queue /> : null} />
    </section>
  );
}
