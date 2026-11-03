/**
 * Lists by keyboard (0.12, build plan 3.1 and c30; ipad-design.md 4.5).
 *
 * A list's rows are its `[data-row]` elements: each row's own link or button,
 * its value the item's id. One row is in the tab order (the one last focused,
 * else the open item's, else the first), so Tab enters a list once and leaves
 * it. ↑ / ↓ or j / k move the focus from row to row; ↵ opens the focused one,
 * since it is a link or a button. With `open` (the Board's ledger) a row opens
 * as the focus lands on it. Keys typed into a field, keys with a modifier and
 * keys a deeper list already took are left alone.
 *
 * `focusRow` puts the focus back on an item's row: Esc on an open item
 * returns to the row it was opened from.
 */
import { useEffect, type RefObject } from 'react';
import { isTyping } from '../shell/keys.js';

export const ROW = '[data-row]';

/** A list box (a SplitPane's list, a place's Pane) owns the rows whose nearest list box it is. */
const BOX = '[data-rows]';

function rowsIn(box: HTMLElement): HTMLElement[] {
  return Array.from(box.querySelectorAll<HTMLElement>(ROW)).filter((r) => !r.closest('[hidden]') && r.parentElement?.closest(BOX) === box);
}

const isOpen = (r: HTMLElement) => r.matches('[aria-current="true"], [aria-current="page"]');

/** The row kept in the tab order: the one last focused, else the open item's, else the first. */
function anchorOf(rows: readonly HTMLElement[], last: HTMLElement | null): HTMLElement | undefined {
  if (last && rows.includes(last)) return last;
  return rows.find(isOpen) ?? rows[0];
}

/** ↑ ↓ j k in the list `ref` holds while `on`; `open`: a row opens as it takes the focus. */
export function useRows(ref: RefObject<HTMLElement | null>, on: boolean, opts: { open?: boolean } = {}): void {
  const open = opts.open ?? false;
  useEffect(() => {
    const box = ref.current;
    if (!box || !on) return;
    let last: HTMLElement | null = null;
    let queued = false;
    const sync = () => {
      queued = false;
      const rows = rowsIn(box);
      const keep = anchorOf(rows, last);
      for (const r of rows) {
        const want = r === keep ? '0' : '-1';
        if (r.getAttribute('tabindex') !== want) r.setAttribute('tabindex', want);
      }
    };
    const later = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(sync);
    };
    const onFocus = (e: FocusEvent) => {
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>(ROW) : null;
      if (!row || !box.contains(row)) return;
      last = row;
      sync();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
      if (!step) return;
      const at = e.target instanceof Element ? e.target.closest<HTMLElement>(ROW) : null;
      const rows = rowsIn(box);
      const i = at ? rows.indexOf(at) : -1;
      // Focus in the list but not on a row (a filter chip, a menu): its own keys.
      if (i < 0) return;
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + step))];
      if (!next || next === at) return;
      next.focus();
      if (open) next.click();
    };
    box.setAttribute('data-rows', '');
    sync();
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(later) : null;
    mo?.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current', 'hidden'] });
    box.addEventListener('focusin', onFocus);
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeAttribute('data-rows');
      mo?.disconnect();
      box.removeEventListener('focusin', onFocus);
      box.removeEventListener('keydown', onKey);
    };
  }, [ref, on, open]);
}

/** Focus the row of item `id` in `box` once it renders (a few frames at most), without scrolling the page. */
export function focusRow(box: HTMLElement | null, id: string | undefined): void {
  if (!box || !id || typeof requestAnimationFrame !== 'function') return;
  let tries = 0;
  const look = () => {
    const row = [...box.querySelectorAll<HTMLElement>(ROW)].find((r) => r.getAttribute('data-row') === id && !r.closest('[hidden]'));
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (++tries < 10) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

/**
 * A row's own keys while the focus is in it (Life lists: e edit, x done, ⌫ delete): spread on the row's
 * element. Never while typing, never with a modifier.
 */
export function rowKeys(map: Partial<Record<'e' | 'x' | 'Backspace' | 'Delete', () => void>>) {
  return {
    onKeyDown(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget; defaultPrevented: boolean; preventDefault(): void }) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      // A menu or sheet the row opened sends its keys up through React's tree: they are its own.
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"]')) return;
      const fn = map[e.key as keyof typeof map];
      if (!fn) return;
      e.preventDefault();
      fn();
    },
  };
}
