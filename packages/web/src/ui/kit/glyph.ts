/**
 * The six status states every surface shows (rows, strip, dock, legend), and
 * how a session maps onto them. Status is told by glyph SHAPE plus the rail
 * word, never by colour alone (direction.md 5.0 "Status glyphs", rule 16).
 */
import { needsYou, type Session, type State } from '@jantar/protocol';

export type GlyphState = 'needs' | 'working' | 'compacting' | 'turn' | 'ended' | 'stale';

/** Ledger groups, in board order. Compacting and stale rows sit under Working. */
export type GroupKey = 'needs' | 'turn' | 'working' | 'ended';

export const GROUP_ORDER: readonly GroupKey[] = ['needs', 'turn', 'working', 'ended'];

/** Rail words. Sentence case in the DOM; type-rail uppercases them. */
export const GROUP_LABEL: Record<GroupKey, string> = {
  needs: 'Needs you',
  turn: 'Your turn',
  working: 'Working',
  ended: 'Ended',
};

/** One word per glyph, for tooltips, aria labels and the legend. */
export const GLYPH_WORD: Record<GlyphState, string> = {
  needs: 'Needs you',
  working: 'Working',
  compacting: 'Compacting',
  turn: 'Your turn',
  stale: 'No update',
  ended: 'Ended',
};

/** A working session with no observation for this long is drawn dashed ("no update"). */
export const STALE_MS = 5 * 60_000;

export function groupOf(g: GlyphState): GroupKey {
  if (g === 'needs' || g === 'turn' || g === 'ended') return g;
  return 'working';
}

/**
 * The glyph for a session. "Needs you" wins (an open card, or Claude says it
 * is waiting); a session moving between accounts keeps the working glyph.
 */
export function glyphStateOf(state: State, session: Session, now: number, staleMs = STALE_MS): GlyphState {
  if (needsYou(state, session.sid)) return 'needs';
  switch (session.status) {
    case 'waiting':
      return 'needs';
    case 'idle':
      return 'turn';
    case 'ended':
      return 'ended';
    case 'compacting':
      return 'compacting';
    case 'working': {
      if (session.move) return 'working';
      const last = Date.parse(session.statusAt ?? session.statusSince);
      return Number.isFinite(last) && now - last > staleMs ? 'stale' : 'working';
    }
  }
}
