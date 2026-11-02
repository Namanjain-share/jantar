/**
 * v0.10: the toolbar badge, per tab (spec 10). `ON` while the tab keeps
 * notes, however they started; `ARM` while Start when I join waits there;
 * `!` for a start by itself that failed in the last
 * ARM_TIMING.failedShowMs (the popup says why); and, v0.10, `!` while the
 * tab keeps notes but no caption line came in (the page's captions state
 * `none`: the popup says how to turn captions on). Chrome keeps a tab's badge
 * itself, so it outlives the worker's stops; it clears it when the tab
 * closes or navigates, and the page's next `call` paints it again.
 * chrome.action needs no permission. A badge is a glyph, not a sentence.
 */
import { ARM_TIMING } from '../shared/wire.js';
import type { Arm } from './arms.js';
import type { TabState } from './tabs.js';

export type BadgeKind = 'arm' | 'on' | 'nocc' | 'failed' | 'none';

const INK = '#16203a';
const JUP = '#a67a0c';

const LOOK: Readonly<Record<BadgeKind, { text: string; color: string; title: string }>> = {
  arm: { text: 'ARM', color: JUP, title: 'Jantar: notes start when you are in the call' },
  on: { text: 'ON', color: INK, title: 'Jantar: keeping notes in this tab' },
  nocc: { text: '!', color: JUP, title: 'Jantar: keeping notes, but no captions yet. Open Jantar for how to turn them on.' },
  failed: { text: '!', color: JUP, title: 'Jantar: notes did not start. Open Jantar for why.' },
  none: { text: '', color: INK, title: 'Jantar' },
};

/** What a tab's badge shows: its record, and its arm when live. */
export function badgeOf(state: TabState | null, arm: Arm | null, now: number): BadgeKind {
  if (state?.clientId && state.notes) return state.captions === 'none' ? 'nocc' : 'on';
  if (arm && !arm.off) return 'arm';
  if (state?.auto && !state.auto.ok && now - state.auto.at < ARM_TIMING.failedShowMs) return 'failed';
  return 'none';
}

/** Paint one tab's badge; never throws (a closed tab does). */
export async function paint(tabId: number, kind: BadgeKind): Promise<void> {
  const look = LOOK[kind];
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: look.text }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: look.color }),
      chrome.action.setTitle({ tabId, title: look.title }),
    ]);
  } catch {
    // The tab closed meanwhile, or Chrome has no such tab.
  }
}
