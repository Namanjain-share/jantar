/**
 * An account's sessions as strip cells (desktop SESSIONS column) or as
 * tappable rows (the expanded phone row). Each cell is a link to the session;
 * hover or focus shows "web-app · fix login · Question · 4m". A session
 * moving off the account ends the cells with "→08".
 */
import type { Session, State } from '@jantar/protocol';
import { useState } from 'react';
import { ago, accountId } from '../../../lib/format.js';
import { routePath } from '../../../lib/router.js';
import { GLYPH_WORD, glyphStateOf, type GlyphState } from '../../kit/glyph.js';
import { StatusGlyph } from '../../kit/StatusGlyph.js';
import { needsWord } from '../../shell/data.js';
import { Link } from '../../shell/Link.js';

export interface SessionCell {
  s: Session;
  glyph: GlyphState;
  /** "web-app · fix login · Question · 4m" */
  label: string;
}

export function sessionCells(state: State, sessions: Session[], now: number): SessionCell[] {
  return sessions.map((s) => {
    const glyph = glyphStateOf(state, s, now);
    const word = glyph === 'needs' ? needsWord(state, s.sid) : GLYPH_WORD[glyph];
    const name = s.name?.trim();
    return { s, glyph, label: [s.folder, name, word, ago(s.statusSince, now)].filter(Boolean).join(' · ') };
  });
}

export function groupLabel(n: number): string {
  return `${n} session${n === 1 ? '' : 's'} on this account`;
}

export function SessionCells({ cells, moveTo }: { cells: SessionCell[]; moveTo: number | null }) {
  // The tooltip hangs left from the hovered cell: the column sits near the right edge.
  const [tip, setTip] = useState<{ i: number; right: number } | null>(null);
  const place = (i: number, el: HTMLElement) => {
    const groupW = el.parentElement?.offsetWidth ?? 0;
    setTip({ i, right: Math.max(0, groupW - (el.offsetLeft + el.offsetWidth) - 4) });
  };
  if (!cells.length) return <span className="type-mono text-ink-3">–</span>;
  const shown = tip ? cells[tip.i] : undefined;
  return (
    <span role="group" aria-label={groupLabel(cells.length)} className="relative flex items-center gap-3">
      {cells.map((c, i) => (
        <Link
          key={c.s.sid}
          href={routePath({ name: 'session', sid: c.s.sid })}
          aria-label={c.label}
          className="-mx-4 flex size-16 items-center justify-center rounded-chip transition-colors duration-120 ease-hover hover:bg-select"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => place(i, e.currentTarget)}
          onMouseLeave={() => setTip(null)}
          onFocus={(e) => place(i, e.currentTarget)}
          onBlur={() => setTip(null)}
        >
          <StatusGlyph state={c.glyph} size="cell" />
        </Link>
      ))}
      {moveTo !== null ? <span className="ml-4 type-mono text-ink-2">→{accountId(moveTo)}</span> : null}
      {shown ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full z-30 mt-8 whitespace-nowrap rounded-btn bg-raised px-8 py-4 type-mono text-ink shadow-float animate-fade"
          style={{ right: tip?.right ?? 0 }}
        >
          {shown.label}
        </span>
      ) : null}
    </span>
  );
}

/** The expanded phone row: one 44 px link per session. */
export function SessionList({ cells }: { cells: SessionCell[] }) {
  if (!cells.length) return null;
  return (
    <ul role="group" aria-label={groupLabel(cells.length)} className="-mx-16">
      {cells.map((c) => (
        <li key={c.s.sid}>
          <Link
            href={routePath({ name: 'session', sid: c.s.sid })}
            aria-label={c.label}
            className="flex h-44 items-center gap-8 px-16 transition-colors duration-120 ease-hover active:bg-hover"
            onClick={(e) => e.stopPropagation()}
          >
            <StatusGlyph state={c.glyph} />
            <span className="flex-none type-row font-medium text-ink">{c.s.folder}</span>
            <span className="min-w-0 truncate type-row text-ink-2">{c.s.name?.trim()}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
