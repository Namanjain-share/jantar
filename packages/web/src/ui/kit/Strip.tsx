/**
 * The strip: one 8 px glyph per session in board order, 3 px apart, 8 px
 * between status groups, so the ember count reads far-left in 50 ms.
 *
 * Desktop (`onOpen` given): ONE tab stop with roving arrow-key focus
 * (aria-activedescendant). Hover or focus shows "web-app · Question · 4m";
 * click or Enter opens that session.
 *
 * Phone (`onLegend` given): decorative cells inside one 44 px button that
 * opens the legend sheet.
 *
 * `dashed`: every cell's outline turns dashed (offline, or still catching up).
 */
import clsx from 'clsx';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { groupOf, type GlyphState } from './glyph.js';
import { StatusGlyph } from './StatusGlyph.js';

export interface StripItem {
  id: string;
  state: GlyphState;
  /** Tooltip and accessible name: "web-app · Question · 4m". */
  label: string;
}

export interface StripProps {
  items: readonly StripItem[];
  dashed?: boolean;
  /** Desktop: open a session. */
  onOpen?: (id: string) => void;
  /** Phone: open the legend. */
  onLegend?: () => void;
  className?: string;
}

function Cells({ items, dashed, active, idBase, onCell, onHover }: {
  items: readonly StripItem[];
  dashed: boolean;
  active?: number;
  idBase?: string;
  onCell?: (i: number) => void;
  onHover?: (i: number | null) => void;
}) {
  return (
    <>
      {items.map((it, i) => {
        const prev = items[i - 1];
        const gap = prev ? (groupOf(prev.state) !== groupOf(it.state) ? 'ml-8' : 'ml-3') : '';
        return (
          <span
            key={it.id}
            id={idBase ? `${idBase}-${i}` : undefined}
            role={onCell ? 'option' : undefined}
            aria-selected={onCell ? i === active : undefined}
            aria-label={onCell ? it.label : undefined}
            data-cell={it.state}
            className={clsx('block size-8 flex-none', gap, onCell && 'cursor-pointer', i === active && 'outline-1 outline-offset-2 outline-ink outline-solid')}
            onClick={onCell ? () => onCell(i) : undefined}
            onMouseEnter={onHover ? () => onHover(i) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
          >
            <StatusGlyph state={it.state} size="cell" dashed={dashed} />
          </span>
        );
      })}
    </>
  );
}

export function Strip({ items, dashed = false, onOpen, onLegend, className }: StripProps) {
  const idBase = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [hover, setHover] = useState<number | null>(null);

  if (!onOpen) {
    return (
      <button
        type="button"
        className={clsx('-mr-4 flex h-44 items-center rounded-chip px-4', className)}
        onClick={onLegend}
        aria-label="All sessions, needs you first. Tap for the legend"
        data-dashed={dashed ? 'true' : 'false'}
      >
        <Cells items={items} dashed={dashed} />
      </button>
    );
  }

  const shown = active >= 0 ? active : hover;
  const tip = shown !== null && shown >= 0 ? items[shown] : undefined;
  const tipLeft = (() => {
    if (shown === null || shown < 0 || !ref.current) return 0;
    // Left-aligned just before the cell, so the first cells never push it off screen.
    const cell = ref.current.children[shown] as HTMLElement | undefined;
    return cell ? Math.max(0, cell.offsetLeft - 8) : 0;
  })();

  const move = (to: number) => {
    if (!items.length) return;
    setActive((to + items.length) % items.length);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      const it = items[active];
      if (it) onOpen(it.id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={items.length ? 0 : -1}
      aria-label="All sessions, needs you first. Arrow keys to move, Enter to open"
      aria-activedescendant={active >= 0 ? `${idBase}-${active}` : undefined}
      data-dashed={dashed ? 'true' : 'false'}
      className={clsx('relative -ml-4 flex h-24 items-center rounded-chip px-4', className)}
      onKeyDown={onKey}
      onFocus={() => setActive((a) => (a >= 0 ? a : 0))}
      onBlur={() => setActive(-1)}
    >
      <Cells
        items={items}
        dashed={dashed}
        active={active}
        idBase={idBase}
        onCell={(i) => {
          const it = items[i];
          if (it) onOpen(it.id);
        }}
        onHover={setHover}
      />
      {tip ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full z-30 mt-8 whitespace-nowrap rounded-btn bg-raised px-8 py-4 type-mono text-ink shadow-float animate-fade"
          style={{ left: tipLeft }}
        >
          {tip.label}
        </span>
      ) : null}
    </div>
  );
}
