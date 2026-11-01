/**
 * What the squares mean: one sentence per glyph. Shown by "?" (desktop
 * popover), by tapping the strip (phone sheet), on the Desk, and as the
 * empty board.
 */
import clsx from 'clsx';
import { GLYPH_WORD, type GlyphState } from './glyph.js';
import { StatusGlyph } from './StatusGlyph.js';

export const LEGEND: readonly { state: GlyphState; word: string; text: string }[] = [
  { state: 'needs', word: GLYPH_WORD.needs, text: 'Claude asked a question, wants permission for a tool, has a plan to approve, or is waiting in the terminal.' },
  { state: 'working', word: GLYPH_WORD.working, text: 'Claude is running. The line under it is the tool it is using right now, or the work it runs in the background.' },
  { state: 'compacting', word: GLYPH_WORD.compacting, text: 'Claude is shrinking its context, then goes back to work on its own.' },
  { state: 'turn', word: GLYPH_WORD.turn, text: 'Claude finished and is waiting for your next prompt.' },
  { state: 'stale', word: GLYPH_WORD.stale, text: 'Still marked working, but nothing has come in for a while.' },
  { state: 'ended', word: GLYPH_WORD.ended, text: 'The session is closed.' },
];

export const LEGEND_TITLE = 'What the squares mean';

/**
 * `columns`: glyph | word | sentence on one line (popover, sheet).
 * `stacked`: the sentence under the word (narrow side columns, empty board).
 */
export function Legend({ layout = 'columns', className }: { layout?: 'columns' | 'stacked'; className?: string }) {
  return (
    <dl className={clsx('m-0', className)}>
      {LEGEND.map((l) => (
        <div
          key={l.state}
          className={clsx(
            'grid gap-x-8 border-t border-line py-8 first:border-t-0',
            layout === 'columns' ? 'grid-cols-legend' : 'grid-cols-legend-stacked',
          )}
        >
          <dt className="contents">
            <StatusGlyph state={l.state} className="mt-1" />
            <span className="type-small font-medium text-ink">{l.word}</span>
          </dt>
          <dd className={clsx('m-0 type-small text-ink-2', layout === 'stacked' && 'col-start-2')}>{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}
