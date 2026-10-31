/**
 * Small pieces the Life screens share (Today, Todos, Food, Cafés, Finance;
 * spec 5.0 and 5.10): the page frame with its one display line, the
 * labelled fields of a sheet and their 16 px input look, one write at a
 * time with a kept Idempotency-Key, the ··· row menu, the 2 px bar, the
 * 5 s Undo line (and the deletes held back behind it), the offline flag
 * and the Life clock. Ink only: the rows that may be ember live in TodoRow,
 * ProjectRow, CategoryRow and BillRow (design rule 3).
 */
import { Menu } from '@base-ui/react/menu';
import { DotsThreeIcon, PlusIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LifeStatus } from '@jantar/protocol';
import { isApiError } from '../../../../lib/api.js';
import { newIdempotencyKey } from '../../../../lib/ids.js';
import { useApp, useNow } from '../../../context.js';
import { Button } from '../../../kit/Button.js';
import { IconButton } from '../../../kit/IconButton.js';
import { LifeError, LifeLoading, OFFLINE_WRITE } from '../shared/states.js';
import type { LifeLoad } from '../shared/useLife.js';

// ---------------------------------------------------------------------------
// Page and states

/**
 * A Life page: the title as the one display line (an <h1>, in every state),
 * an aside on its right, then the body. `back` sits above the title. While
 * offline (the shell shows its banner) a mono line under the title says why
 * add and save are off.
 */
export function Page({ title, aside, back, undo, children }: { title: ReactNode; aside?: ReactNode; back?: ReactNode; undo?: Pick<Undo, 'offer' | 'take'>; children: ReactNode }) {
  const offline = useOffline();
  return (
    <div className="pb-48 animate-enter md:max-w-720">
      {back ? <div className="px-8 pt-8">{back}</div> : null}
      <header className={clsx('flex min-h-44 items-center gap-12 px-16 pb-8', back ? 'pt-4' : 'pt-16 md:pt-24')}>
        <h1 data-display className="min-w-0 flex-1 truncate type-display text-ink">
          {title}
        </h1>
        {aside}
      </header>
      {offline ? <OfflineLine className="px-16 pb-8" /> : null}
      {children}
      {/* Last, so it pins to the bottom of the visible area however far down the row was. */}
      {undo ? <UndoLine offer={undo.offer} onUndo={undo.take} /> : null}
    </div>
  );
}

/**
 * The body of a screen from its load: the data once there is some (kept on
 * screen while a reload runs or fails, with the failure's sentence above it;
 * a lost connection is the shell's banner, not said twice), the failure's
 * state when there is none, else the skeleton.
 */
export function Loaded<T>({ load, children, count }: { load: LifeLoad<T>; children: (data: T) => ReactNode; count?: number }) {
  const offline = useOffline();
  if (load.data !== null) {
    const say = load.error && !offline && !isApiError(load.error, 'network');
    return (
      <>
        {say ? <LifeError error={load.error} onRetry={load.reload} /> : null}
        {children(load.data)}
      </>
    );
  }
  if (load.error) return <LifeError error={load.error} offline={offline} onRetry={load.reload} />;
  return <LifeLoading {...(count !== undefined ? { count } : {})} />;
}

/** The connection is down: the last list stays, and add and save are off. */
export function useOffline(): boolean {
  return useApp((s) => s.conn.status === 'offline');
}

/** Under a disabled add or save while offline. */
export function OfflineLine({ className }: { className?: string }) {
  return <p className={clsx('type-mono text-ink-3', className)}>{OFFLINE_WRITE}</p>;
}

/** The "+" in a page header. */
export function AddButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <IconButton aria-label={label} onClick={onClick} disabled={disabled}>
      <PlusIcon size={20} aria-hidden="true" />
    </IconButton>
  );
}

// ---------------------------------------------------------------------------
// The Life clock

export interface LifeClock {
  /** YYYY-MM-DD in the Life zone. */
  day: string;
  /** HH:MM in the Life zone. */
  hhmm: string;
}

/** The day and the time now in `tz` (the Life zone from LifeStatus; the phone's own when unknown). */
export function clockIn(nowMs: number, tz?: string | null): LifeClock {
  const parts = (zone: string | undefined) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
      new Date(nowMs),
    );
  let p: Intl.DateTimeFormatPart[];
  try {
    p = parts(tz ?? undefined);
  } catch {
    p = parts(undefined);
  }
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` };
}

/**
 * Now on the Life clock. `today` (the daemon's word for it, from the last
 * load) wins over the phone's day while the Life zone is unknown; once it
 * is known the later of the two wins, so a screen left open past midnight
 * moves to the new day without a reload.
 */
export function lifeClockAt(nowMs: number, status: LifeStatus | null, today?: string): LifeClock {
  const c = clockIn(nowMs, status?.timezone);
  if (!today) return c;
  return { day: status?.timezone && c.day > today ? c.day : today, hhmm: c.hhmm };
}

/** Now on the Life clock, refreshed every 30 s. */
export function useLifeClock(status: LifeStatus | null, today?: string): LifeClock {
  return lifeClockAt(useNow(30_000), status, today);
}

/** HH:MM of an instant on the Life clock. */
export function timeOf(iso: string, tz?: string | null): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? clockIn(t, tz).hhmm : '';
}

// ---------------------------------------------------------------------------
// Sheets: fields and writes

/** A 16 px field (no iOS zoom), 44 px tall on touch. */
export const INPUT =
  'h-40 w-full min-w-0 rounded-btn border border-line-strong bg-bg px-12 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:text-ink-3 coarse:h-44';
export const TEXTAREA =
  'block min-h-88 w-full rounded-btn border border-line-strong bg-bg px-12 py-8 type-input text-ink outline-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** A label above its control. With `htmlFor` the label is a real <label>; otherwise it names a group. */
export function Field({ label, htmlFor, id, aside, children, className }: { label: ReactNode; htmlFor?: string; id?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  const cls = 'type-small text-ink-3';
  return (
    <div className={clsx('py-8', className)}>
      <div className="mb-6 flex items-center gap-8">
        {htmlFor ? (
          <label htmlFor={htmlFor} id={id} className={cls}>
            {label}
          </label>
        ) : (
          <span id={id} className={cls}>
            {label}
          </span>
        )}
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The bottom row of a sheet: the main action first and wide, the others after it. */
export function SheetActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('mt-16 flex flex-wrap items-center gap-8', className)}>{children}</div>;
}

export type WriteResult<T> = { ok: true; value: T } | { ok: false };

/**
 * One write at a time, with its failure kept for NotSaved. The same
 * Idempotency-Key goes with a retry of the same thing (`sig`), so a reply
 * lost on the way back is replayed, not done twice; a new thing, or a
 * success, gets a new key (the daemon refuses one key with two bodies).
 */
export function useWrite() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const kept = useRef<{ sig: string; key: string } | null>(null);
  const run = useCallback(async <T,>(sig: string, fn: (key: string) => Promise<T>): Promise<WriteResult<T>> => {
    if (!kept.current || kept.current.sig !== sig) kept.current = { sig, key: newIdempotencyKey() };
    const key = kept.current.key;
    setBusy(true);
    setError(null);
    try {
      const value = await fn(key);
      kept.current = null;
      return { ok: true, value };
    } catch (e) {
      setError(e);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}

/** A sheet's open state with a fresh key per opening, so its form starts from what it edits each time. */
export function useSheet<T>() {
  const [state, setState] = useState<{ open: boolean; item: T | null; n: number }>({ open: false, item: null, n: 0 });
  const open = useCallback((item: T | null = null) => setState((s) => ({ open: true, item, n: s.n + 1 })), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { open: state.open, item: state.item, key: state.n, show: open, close, onOpenChange: (o: boolean) => (o ? undefined : close()) };
}

// ---------------------------------------------------------------------------
// Rows

const ITEM =
  'flex h-32 cursor-pointer select-none items-center px-12 type-small text-ink outline-none transition-colors duration-120 ease-hover ' +
  'data-highlighted:bg-select data-disabled:cursor-default data-disabled:text-ink-3 coarse:h-44';

export interface MenuEntry {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * A row's ··· menu (and its long press, through `open`): groups of items,
 * an optional group label ("Snooze"). The trigger is named for the row.
 */
export function RowMenu({
  label,
  groups,
  open,
  onOpenChange,
  disabled,
}: {
  label: string;
  groups: { label?: string; items: MenuEntry[] }[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Menu.Root {...(open !== undefined ? { open } : {})} onOpenChange={(o) => onOpenChange?.(o)}>
      <Menu.Trigger render={<IconButton aria-label={label} disabled={disabled} />}>
        <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={12} className="z-30">
          <Menu.Popup aria-label={label} className="min-w-176 rounded-btn bg-raised py-4 text-ink shadow-float outline-none animate-pop">
            {groups.map((g, i) => (
              <Menu.Group key={g.label ?? i} className={i > 0 ? 'mt-4 border-t border-line pt-4' : undefined}>
                {g.label ? <Menu.GroupLabel className="px-12 py-4 type-small text-ink-3">{g.label}</Menu.GroupLabel> : null}
                {g.items.map((it) => (
                  <Menu.Item key={it.label} className={ITEM} disabled={it.disabled} onClick={it.onSelect}>
                    {it.label}
                  </Menu.Item>
                ))}
              </Menu.Group>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A 2 px bar: --ink on --line, full at `max` and past it. The numbers beside it say the same, so it is hidden from readers. */
export function LineBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  return (
    <span aria-hidden="true" data-bar={Math.round(pct)} className={clsx('relative block h-2 overflow-hidden bg-line', className)}>
      <span className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${pct}%` }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Undo

/** How long "Done · Undo", "Added · Undo" and "Deleted · Undo" stay (spec 5.2, 5.3, 5.5). */
export const UNDO_MS = 5_000;

interface UndoOffer {
  id: number;
  text: string;
  undo: () => void;
  /** What runs once the offer goes without Undo (a held-back delete). */
  commit?: (() => void) | undefined;
}

/**
 * One Undo at a time, for UNDO_MS. An offer with `commit` runs it exactly
 * once when it goes without Undo: its time is up, a newer offer replaced
 * it, the screen closed, or the app went to the background (a phone may
 * never wake a suspended page to finish the timer).
 */
export function useUndo(ms = UNDO_MS) {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const current = useRef<UndoOffer | null>(null);
  const set = (o: UndoOffer | null) => {
    current.current = o;
    setOffer(o);
  };
  /** Ends the current offer without Undo, running its commit. */
  const settle = useCallback((render: boolean) => {
    const o = current.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    if (render) setOffer(null);
    o?.commit?.();
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') settle(true);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      settle(false);
    };
  }, [settle]);
  const show = useCallback(
    (text: string, undo: () => void, commit?: () => void) => {
      settle(false);
      const o = { id: ++seq.current, text, undo, commit };
      set(o);
      timer.current = setTimeout(() => {
        if (current.current?.id === o.id) settle(true);
      }, ms);
    },
    [ms, settle],
  );
  const take = useCallback(() => {
    const o = current.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    set(null);
    o?.undo();
  }, []);
  return useMemo(() => ({ offer, show, take }), [offer, show, take]);
}

export type Undo = ReturnType<typeof useUndo>;

/**
 * Deleting with no confirm (todos, food entries, weights, saved foods,
 * cafés and finance entries): the row leaves the list at once and "Deleted:
 * … · Undo" stays for UNDO_MS on `undo`'s line. Nothing is sent until the
 * offer goes without Undo, so Undo puts back exactly what was there, with
 * its id, times and place; then `send` deletes it (and reloads). When that
 * fails the row comes back and the caller shows its "Not saved" line.
 * Totals and counts from the Mac follow once the delete is sent.
 */
export function useHeldDeletes(undo: Undo) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  // The key whose delete is the offer on the line now.
  const pending = useRef<string | null>(null);
  const { show, take } = undo;
  const unhide = useCallback((key: string) => setHidden((h) => new Set([...h].filter((k) => k !== key))), []);
  const remove = useCallback(
    (key: string, text: string, send: () => Promise<boolean>) => {
      const settled = () => {
        if (pending.current === key) pending.current = null;
      };
      setHidden((h) => new Set(h).add(key));
      show(
        text,
        () => {
          settled();
          unhide(key);
        },
        () => {
          settled();
          // A deleted row stays out of the list; the reload leaves it out too.
          void send().then((ok) => {
            if (!ok) unhide(key);
          });
        },
      );
      pending.current = key;
    },
    [show, unhide],
  );
  /** `key` is written again (a weight logged anew for its day): a delete still held for it is dropped unsent, and its row may show again. */
  const release = useCallback(
    (key: string) => {
      if (pending.current === key) take();
      else unhide(key);
    },
    [take, unhide],
  );
  const visible = useCallback(<T,>(list: readonly T[], keyOf: (x: T) => string): readonly T[] => (hidden.size ? list.filter((x) => !hidden.has(keyOf(x))) : list), [hidden]);
  return useMemo(() => ({ remove, release, visible }), [remove, release, visible]);
}

/**
 * The offer as a bar pinned to the bottom of its scroll area (sticky): put
 * it last in the container that holds the list, so a row deleted far down
 * a long list still has its Undo in view. Page renders it for a screen
 * (`undo`); a sheet puts it after its list on the sheet's own ground.
 */
export function UndoLine({ offer, onUndo, ground = 'bg', className }: { offer: { text: string } | null; onUndo: () => void; ground?: 'bg' | 'raised'; className?: string }) {
  if (!offer) return null;
  return (
    <div
      role="status"
      className={clsx(
        'sticky bottom-0 z-3 flex min-h-40 items-center gap-8 border-t border-line px-16 animate-fade',
        ground === 'raised' ? 'bg-raised' : 'bg-bg',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate type-small text-ink-2">{offer.text}</span>
      <Button variant="text" size="sm" onClick={onUndo}>
        Undo
      </Button>
    </div>
  );
}
