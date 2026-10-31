/**
 * One ledger row (direction.md 5.1). Two lines: 52 px on desktop (padding
 * 8 / 16), 64 px on phone (10 / 16); an ended row is one line (36 / 44).
 *
 *   [■] web-app  fix login redirect  +2 agents              waiting 12m
 *       Question: Which module should own the session cookie?   03 · 81
 *
 * Line 2 by state: the kind word and what it asks (needs you), the tool line
 * in mono (working), the first line of the last reply (your turn). On the
 * right: the project chip while Life is on (v0.4), the files it changed on
 * a your-turn row while Files is on (`4 files` in mono, spec 5.2.1), then
 * the account and its 5-hour %, or an in-flight move. Phones show the
 * account id only and drop the agents tag. With one Claude login (v0.4
 * single-account mode) there is no account to tell apart and no usage, so
 * the account column is left out.
 *
 * Selected: --select fill and the 2 px --ink tick, never ember. Unseen
 * your-turn rows: folder at 680. Status is the glyph plus the rail word.
 *
 * The row's menu (spec 5.3.1, while launching is on, live sessions only):
 * long press, right click or the menu key opens it (`menu`; the Ledger holds
 * the one menu); the click that follows a long press is dropped.
 */
import clsx from 'clsx';
import { m } from 'motion/react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Session } from '@jantar/protocol';
import { routePath } from '../../../lib/router.js';
import { justLongPressed, useLongPress, type PressGuard } from '../../kit/longPress.js';
import { pastCeiling } from '../../kit/meterMath.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import type { GlyphState } from '../../kit/glyph.js';
import { useAccountsMode, useFeatures } from '../../shell/data.js';
import { ProjectChip } from '../life/todos/ProjectChip.js';
import { filesText, type RowModel } from './model.js';

/** How a row opens the ledger's menu: the rows share one guard (the click after a long press) and one hint. */
export interface RowMenuHook {
  open: (row: RowModel, anchor: HTMLAnchorElement) => void;
  guard: PressGuard;
  /** The sr-only line that says how to open the menu. */
  hintId: string;
}

/** A row with no menu never fires a long press, so nothing writes to this. */
const NO_PRESS: PressGuard = { at: -Infinity };

/** FLIP reorder: 180 ms tween on the settle curve. Reduced motion turns it off (MotionConfig). */
export const FLIP = { layout: { type: 'tween' as const, duration: 0.18, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] } };

/**
 * Count real events for a working session: a new observation, tool or
 * subagent count. The glyph dips once per event, never on a timer.
 */
function useEventCount(s: Session, glyph: GlyphState): number {
  const sig = `${s.statusAt ?? ''}|${s.now?.tool ?? ''}|${s.now?.text ?? ''}|${s.subagentsRunning}`;
  const prev = useRef(sig);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (prev.current === sig) return;
    prev.current = sig;
    if (glyph === 'working') setN((x) => x + 1);
  }, [sig, glyph]);
  return n;
}

function Line2({ row, ceiling }: { row: RowModel; ceiling: number }) {
  const l = row.line2;
  let body = null;
  if (l.kind === 'needs') {
    body = (
      <>
        <span className="font-medium">{l.text ? `${l.word}:` : l.word}</span>
        {l.text ? ' ' : null}
        {l.text ? l.code ? <code className="type-mono">{l.text}</code> : l.text : null}
      </>
    );
  } else if (l.kind === 'tool') {
    body = (
      <span className="type-mono">
        <span className="text-ink-2">{l.verb}</span>
        {'\u00a0 '}
        <span className="text-ink-3">{l.arg}</span>
      </span>
    );
  } else if (l.kind === 'text') {
    body = l.text;
  }
  const a = row.account;
  const { life } = useFeatures();
  const single = useAccountsMode() === 'single';
  return (
    <span data-line2 className="mt-4 flex h-20 min-w-0 items-center pl-24 text-small md:mt-0 md:h-18">
      <span className={clsx('min-w-0 flex-1 truncate', l.kind === 'needs' ? 'text-ink' : 'text-ink-2')}>{body}</span>
      {/* v0.4: the project whose folder holds this session (WP-W's chip; nothing while Life is off). */}
      {life ? <ProjectChip cwd={row.session.cwd} /> : null}
      {row.files !== null ? (
        <span data-files className="ml-12 flex-none type-mono text-ink-3">
          {filesText(row.files)}
        </span>
      ) : null}
      {single ? null : row.move ? (
        <span data-acct className="ml-12 flex-none type-mono text-ink-3">
          {row.move}
        </span>
      ) : a ? (
        <span data-acct className="ml-12 flex-none type-mono text-ink-3">
          {a.id}
          <span className="hidden md:inline">
            <span aria-hidden="true"> · </span>
            <span className="sr-only">5h </span>
            <b className={clsx('font-data', pastCeiling(a.pct, ceiling) ? 'text-signal-text' : 'text-ink-2')}>{a.pct ?? '–'}</b>
            <span className="sr-only">%</span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** The inside of a row, shared by the real rows and the empty board's example. */
export function RowBody({ row, ceiling, unseen = false, events = 0 }: { row: RowModel; ceiling: number; unseen?: boolean; events?: number }) {
  const ended = row.glyph === 'ended';
  return (
    <>
      <span className="flex h-20 min-w-0 items-center md:h-18">
        <span key={events} className={clsx('mr-8 flex-none', events > 0 && 'animate-dim')}>
          <StatusGlyph state={row.glyph} />
        </span>
        <span
          className={clsx(
            'min-w-0 max-w-3/5 flex-initial truncate type-row',
            ended ? 'text-ink-2' : 'text-ink',
            unseen ? 'font-strong' : ended ? 'font-regular' : 'font-medium',
          )}
        >
          {row.folder}
        </span>
        <span className={clsx('ml-8 min-w-0 flex-initial truncate type-row', ended ? 'text-ink-3' : 'text-ink-2')}>{row.name}</span>
        {row.tag ? <span className="ml-8 hidden flex-none type-mono text-ink-3 md:inline">{row.tag}</span> : null}
        <span className={clsx('ml-auto flex-none pl-12 type-mono', row.ageEmber ? 'text-signal-text' : 'text-ink-3')}>{row.age}</span>
      </span>
      {ended ? null : <Line2 row={row} ceiling={ceiling} />}
    </>
  );
}

export function rowClass(row: RowModel, ground: 'surface' | 'bg', selected: boolean): string {
  const ended = row.glyph === 'ended';
  return clsx(
    'relative block scroll-mt-28 border-b border-line px-16 transition-colors duration-120 ease-hover focus-visible:-outline-offset-2',
    ended ? 'pb-11 pt-12 md:pb-8 md:pt-9' : 'pb-9 pt-10 md:pb-7 md:pt-8',
    selected ? 'row-tick bg-select' : clsx(ground === 'surface' ? 'bg-surface' : 'bg-bg', 'hover:bg-hover'),
  );
}

export function Row({
  row,
  ceiling,
  ground,
  selected,
  unseen,
  wash,
  layoutSig,
  onOpen,
  menu,
}: {
  row: RowModel;
  ceiling: number;
  ground: 'surface' | 'bg';
  selected: boolean;
  unseen: boolean;
  /** Bumped when the row enters NEEDS YOU: replays the one-shot ember wash. */
  wash: number;
  layoutSig: string;
  onOpen: (row: RowModel, href: string) => void;
  /** The row's menu (long press, right click); absent while it has none. */
  menu?: RowMenuHook;
}) {
  const events = useEventCount(row.session, row.glyph);
  const href = routePath({ name: 'session', sid: row.sid });
  const press = useLongPress<HTMLAnchorElement>(menu ? (el) => menu.open(row, el) : undefined, menu?.guard ?? NO_PRESS);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (menu && justLongPressed(menu.guard)) {
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(row, href);
  };
  return (
    <m.a
      layout="position"
      layoutDependency={layoutSig}
      transition={FLIP}
      href={href}
      data-sid={row.sid}
      data-glyph={row.glyph}
      aria-current={selected ? 'page' : undefined}
      aria-describedby={menu?.hintId}
      onClick={onClick}
      {...press}
      className={clsx(rowClass(row, ground, selected), menu && 'select-none [-webkit-touch-callout:none]')}
    >
      {wash > 0 ? <span key={wash} aria-hidden="true" className="pointer-events-none absolute inset-0 bg-signal opacity-0 animate-wash" /> : null}
      <RowBody row={row} ceiling={ceiling} unseen={unseen} events={events} />
    </m.a>
  );
}
