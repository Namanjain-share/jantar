/**
 * v0.10: where each client turns its live captions on, and what the page's
 * bubble and the popup say when no caption line came in. Shared, so both
 * say exactly the same (research captions-research.md 6.5). No em dash, no
 * exclamation mark. Only `off` (the control says so) tells him to turn
 * them on: the controls are toggles, so with captions on and nobody
 * speaking that advice would turn them off.
 */
import type { CaptionsClient, CaptionsWhy } from './messages.js';

/** The path in each client's own words: Meet's control since 2026-10-22 (its key c toggles: never named); Teams signed in (2026, else the classic menu); a light-meetings guest. */
export const CC_PATH: Readonly<Record<CaptionsClient, string>> = {
  meet: 'Captions and translation (CC) › Turn on captions',
  teams: 'More (…) › Captions (in some meetings: More (…) › Language and speech › Show live captions)',
  light: 'More (…) › Captions',
};

const WHY = "No captions yet: Jantar writes notes from the call's live captions.";

export const noCaptions = (client: CaptionsClient, why: CaptionsWhy = 'off'): string =>
  why === 'clicked'
    ? `Jantar turned captions on. If none appear when people speak, check ${CC_PATH[client]}.`
    : why === 'unavailable'
      ? "This meeting offers no captions (the organizer's settings), so there are no notes. Screenshots still work."
      : `${WHY} ${why === 'unsure' ? 'If none appear when people speak, turn' : 'Turn'} them on: ${CC_PATH[client]}.`;

/** v0.10: `waiting`, the popup's quiet line (no bubble, no `!`). */
export const CC_WAITING = 'Captions are on; lines appear once someone speaks.';
