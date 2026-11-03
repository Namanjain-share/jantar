/**
 * A list and its detail (0.12, build plan 1.5): side by side when the pane is
 * 800 wide or more ("split"), one at a time below that ("single").
 *
 *   <SplitPane name="board" list={<Board />} detail={sid ? <SessionScreen key={sid} … /> : null}
 *     selection={sid} empty={<Desk />} listLabel="Ledger" detailLabel="Detail" onClose={…} />
 *
 * - The same two sections, in the same order, at every width: list, then
 *   detail. So a resize never remounts the detail (a session, its draft, a
 *   card's typed answer). In single mode the inactive section stays in place,
 *   empty and hidden: nothing behind an open item renders or polls, as on the
 *   phone. Its scroll comes back from usePaneScroll's Map when it shows again.
 * - Split or single is decided here, in JS, once: measured before the first
 *   paint, then one ResizeObserver that sets state only when the width
 *   crosses 800 or 1180, so dragging a window re-renders nothing in between.
 *   CSS (kit.css .split-*) only lays out the grid. Without a measure (jsdom
 *   has no layout; a hidden box) the pane splits from a 1024 window, as 0.10
 *   did, with the 340 column. The phone chrome is always single.
 * - The list column is 340, or 440 when the pane is 1180 or wider (D6);
 *   `listWidth="history"` makes it 300 (Chat).
 * - `empty`: what the detail shows in split mode with nothing selected (the
 *   Board's Desk), or 'fill': the list takes the whole width (D2).
 * - Esc closes the detail in split mode (`onClose`; the place says where the
 *   list is), unless `escape` is false (a dialog over it has the key).
 * - `alone={false}`: in single mode the open item doesn't take the pane; the
 *   list stays and the place shows the item its own way (Posts: its sheet,
 *   as 0.10 did).
 * - Beside an open item the list keeps that item's row (aria-current) in
 *   view: opening one from a wide list lands on its row.
 * - `overlay` (Board and Chat, D8; build plan c25): in single mode beside
 *   the phone, the open item takes the pane and the list can be called over
 *   its left side (340, Chat's days 300) with a scrim over the rest:
 *   "‹ Sessions", "‹ Days". A tap on the scrim, Esc or opening another item
 *   puts it away. The list renders in its own section, so its scroll comes
 *   back from the Map as it does when single mode shows it.
 *   SplitContext gives what the panes inside need: split, wide, selected,
 *   close (the Close button a detail header shows in split mode) and the
 *   overlay's state while one can be called.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useKey } from '../shell/keys.js';
import { useLayout, type Layout } from '../shell/layout.js';
import { usePaneScroll } from './Pane.js';
import { focusRow, useRows } from './rows.js';

export const SPLIT_AT = 800;
export const WIDE_AT = 1180;

export interface SplitState {
  split: boolean;
  wide: boolean;
  selected: boolean;
  close?: (() => void) | undefined;
  /** Single mode with an item open and an overlay list (Board, Chat): whether it shows, and the way to show or put it away. */
  overlay?: { open: boolean; set: (open: boolean) => void } | undefined;
}

export const SplitContext = createContext<SplitState | null>(null);

/** Which of a SplitPane's two sections this is in (null: none). */
export const PaneSlotContext = createContext<'list' | 'detail' | null>(null);

export function usePaneSlot(): 'list' | 'detail' | null {
  return useContext(PaneSlotContext);
}

/** The SplitPane this pane is in (null: none). */
export function useSplit(): SplitState | null {
  return useContext(SplitContext);
}

interface Mode {
  split: boolean;
  wide: boolean;
}

/** Split or single for a pane `width` wide. */
export function splitFor(width: number): Mode {
  return { split: width >= SPLIT_AT, wide: width >= WIDE_AT };
}

/** Without a measure (jsdom, a hidden box): split from a 1024 window, as 0.10 laid the ledger out; the 340 column. */
export function guessSplit(l: Layout): Mode {
  return { split: l.chrome !== 'phone' && l.size === 'regular', wide: false };
}

/**
 * Beside an open item, the list shows that item's row (its `aria-current`):
 * brought into view when the item opens, and kept there while what is above
 * it still loads (a strip, more rows), until the list is scrolled by hand.
 */
function useCurrentInView(ref: RefObject<HTMLElement | null>, on: boolean, selection: string | undefined): void {
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || !on) return;
    let touched = false;
    const keep = () => {
      if (!touched) list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    };
    const stop = () => {
      touched = true;
    };
    keep();
    const opts = { passive: true } as const;
    list.addEventListener('wheel', stop, opts);
    list.addEventListener('touchstart', stop, opts);
    list.addEventListener('keydown', stop);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(keep) : null;
    const content = list.firstElementChild;
    if (ro && content) ro.observe(content);
    return () => {
      ro?.disconnect();
      list.removeEventListener('wheel', stop);
      list.removeEventListener('touchstart', stop);
      list.removeEventListener('keydown', stop);
    };
  }, [ref, on, selection]);
}

export interface SplitPaneProps {
  /** Keys the scroll memory. */
  name: string;
  list: ReactNode;
  /** The open item, or null when nothing is selected. */
  detail: ReactNode | null;
  /** The open item's id: keys the detail section and its scroll. */
  selection?: string | undefined;
  /** In split mode with nothing selected: 'fill' (the list takes the width) or what the detail shows. */
  empty?: 'fill' | ReactNode;
  listLabel: string;
  detailLabel: string;
  listWidth?: 'list' | 'history';
  onClose?: () => void;
  /** Esc closes the detail in split mode (default true). */
  escape?: boolean;
  /** No list column for now: the detail takes the pane (Chat, until it has a day to list). The list's section stays in place, empty. */
  noList?: boolean;
  /** In single mode the open item takes the pane (default); false keeps the list there instead. */
  alone?: boolean;
  /** Single mode beside the phone: the list can be called over the open item (Board, Chat; D8). */
  overlay?: boolean;
}

export function SplitPane({
  name,
  list,
  detail,
  selection,
  empty = 'fill',
  listLabel,
  detailLabel,
  listWidth = 'list',
  onClose,
  escape = true,
  noList = false,
  alone = true,
  overlay = false,
}: SplitPaneProps) {
  const layout = useLayout();
  const box = useRef<HTMLDivElement>(null);
  const listBox = useRef<HTMLElement>(null);
  const detailBox = useRef<HTMLElement>(null);
  const [measured, setMeasured] = useState<Mode | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = (width: number) => {
      const next = width > 0 ? splitFor(width) : null;
      setMeasured((m) => (m?.split === next?.split && m?.wide === next?.wide ? m : next));
    };
    read(el.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) read(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mode = layout.chrome === 'phone' ? { split: false, wide: false } : (measured ?? guessSplit(layout));
  const selected = detail !== null && detail !== undefined && (mode.split || alone);
  const fill = empty === 'fill';
  // The list over the open item (single mode beside the phone): put away when another item opens.
  const [over, setOver] = useState(false);
  const canOver = overlay && !mode.split && selected && !noList && layout.chrome !== 'phone';
  const shownOver = canOver && over;
  useEffect(() => setOver(false), [selection]);
  useKey('Escape', () => setOver(false), shownOver && escape);
  const showList = (mode.split || !selected || shownOver) && !noList;
  const showDetail = selected || (mode.split && !fill);
  usePaneScroll(listBox, `${name}:list`, showList);
  usePaneScroll(detailBox, `${name}:detail:${selection ?? ''}`, showDetail);
  useCurrentInView(listBox, mode.split && selected, selection);
  // c30: the list's rows by keyboard (the ledger opens a session as the focus lands on it); Esc goes back to the item's row.
  useRows(listBox, layout.keyboard && showList, { open: name === 'board' });
  useKey(
    'Escape',
    () => {
      onClose?.();
      focusRow(listBox.current, selection);
    },
    mode.split && selected && Boolean(onClose) && escape,
  );

  const ctx: SplitState = { split: mode.split, wide: mode.wide, selected, close: onClose, overlay: canOver ? { open: shownOver, set: setOver } : undefined };
  return (
    <SplitContext.Provider value={ctx}>
      <div
        ref={box}
        className="split @container/split"
        data-split={mode.split ? '' : undefined}
        data-wide={mode.wide ? '' : undefined}
        data-fill={mode.split && fill && !selected ? '' : undefined}
        data-nolist={noList ? '' : undefined}
        data-list={listWidth}
        data-over={shownOver ? '' : undefined}
      >
        <section
          ref={listBox}
          key={`list:${name}`}
          aria-label={mode.split || shownOver ? listLabel : undefined}
          hidden={!showList}
          className={shownOver ? 'split-list shadow-float @container/pane' : 'split-list @container/pane'}
        >
          {showList ? <PaneSlotContext.Provider value="list">{list}</PaneSlotContext.Provider> : null}
        </section>
        <section
          ref={detailBox}
          key={`detail:${selection ?? ''}`}
          aria-label={mode.split ? detailLabel : undefined}
          hidden={!showDetail}
          className="split-detail @container/pane"
        >
          {showDetail ? <PaneSlotContext.Provider value="detail">{selected ? detail : empty}</PaneSlotContext.Provider> : null}
        </section>
        {/* The scrim beside the list over the item: a tap puts the list away (its own button is the named control). */}
        {shownOver ? <div aria-hidden="true" className="split-scrim animate-fade" onClick={() => setOver(false)} /> : null}
      </div>
    </SplitContext.Provider>
  );
}
