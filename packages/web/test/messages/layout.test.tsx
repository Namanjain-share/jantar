/**
 * 0.15 Messages at an iPhone's 390 and an iPad's 1024 (a coarse pointer:
 * the phone chrome, then the touch shell with its pane cards), with words
 * made to overflow: a 200-character name with no space, a long draft. jsdom
 * has no layout, so this checks what keeps a pane from scrolling sideways
 * (the measured check is the Chromium layout matrix,
 * test/integration/web-v011-layout.integration.test.ts, whose `messages`
 * states run the same screens at `phone` and `ipad-1024`):
 *
 * - nothing scrolls sideways (overflow-x) unless it says so (data-scroll-x);
 * - no box is set wider than the phone's pane (390 less its 16 px gutters);
 * - every word someone else wrote wraps or is cut where it sits (break-words,
 *   break-all or truncate, in a box that may shrink);
 * - every row of buttons wraps.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutAt } from '../../src/ui/shell/layout.js';
import { measureAs, preloadPlaces, renderApp } from '../helpers.js';
import { IDS, ON, draft, messagesApi, readEntry, run, skipEntry, today } from './helpers.js';

preloadPlaces('messages');
afterEach(() => vi.restoreAllMocks());

/** A word with no break in it, longer than any pane. */
const LONG = `Asha${'x'.repeat(196)}`;
const PANE_MAX = 390 - 2 * 16;

function longApi() {
  return messagesApi({
    'GET /v1/messages/today': today({
      run: run({ summary: `${LONG} ${LONG}`, dropped: [{ chatName: LONG, kept: 6, left: 4994 }] }),
      drafts: [draft(IDS.draftAsha, { chatName: LONG, theyAsked: LONG, draft: `${LONG} ${LONG}` })],
      callbacks: [{ todoId: IDS.callback, who: LONG, at: '2026-01-15T11:00:00.000Z' }],
    }),
    'GET /v1/messages/skip': { skip: [skipEntry(IDS.ravi, LONG)] },
    'GET /v1/messages/reads': { reads: [readEntry({ folder: LONG })] },
  });
}

const WRAPS = /(?:^|\s)(?:break-words|break-all|truncate|line-clamp-\d+)(?:\s|$)/;

/** What would make the pane scroll sideways, in words (empty when nothing would). */
function sideways(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(?:^|\s)overflow(?:-x)?-(?:auto|scroll)(?:\s|$)/.test(cls) && !el.closest('[data-scroll-x]')) out.push(`scrolls: ${cls}`);
    for (const m of cls.matchAll(/(?:^|\s)(?:w|min-w|basis)-(\d+)(?:\s|$)/g)) if (Number(m[1]) > PANE_MAX) out.push(`too wide: ${m[0].trim()}`);
    if (/(?:^|\s)whitespace-nowrap(?:\s|$)/.test(cls) && (el.textContent ?? '').includes(LONG)) out.push(`never wraps: ${el.tagName}`);
  }
  // Each text node holding the long word sits in a box that wraps or cuts it.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent ?? '').includes(LONG)) continue;
    let el: HTMLElement | null = n.parentElement;
    let ok = false;
    while (el && el !== root) {
      if (WRAPS.test(typeof el.className === 'string' ? el.className : '')) {
        ok = true;
        break;
      }
      el = el.parentElement;
    }
    if (!ok) out.push(`unwrapped: <${n.parentElement?.tagName.toLowerCase()}> ${(n.textContent ?? '').slice(0, 12)}…`);
  }
  for (const row of root.querySelectorAll<HTMLElement>('[data-actions]')) if (!row.classList.contains('flex-wrap')) out.push('a row of buttons that never wraps');
  return out;
}

describe('Messages: layouts', () => {
  it('iPhone 390 and iPad 1024 layouts have no horizontal scroll', async () => {
    for (const [name, layout, pane] of [
      ['iPhone 390', layoutAt(390, { coarse: true }), 390],
      ['iPad 1024', layoutAt(1024, { coarse: true }), 1024 - 220],
    ] as const) {
      for (const path of ['/messages', '/messages?view=settings']) {
        measureAs(pane);
        const a = renderApp({ path, api: longApi(), state: ON, layout });
        const main = screen.getByRole('main');
        await within(main).findByRole('heading', { level: 1, name: path.includes('settings') ? 'Messages settings' : 'Messages' });
        // Everything the screen loads is on it before it is measured.
        if (path.includes('settings')) {
          await within(main).findByRole('list', { name: 'Skipped chats' });
          await within(main).findByRole('list', { name: 'Read log' });
        } else {
          await within(main).findByRole('region', { name: 'Waiting on you' });
          await within(main).findByRole('region', { name: 'Call back' });
        }
        expect(main.textContent, `${name} ${path}`).toContain(LONG);
        expect(sideways(main), `${name} ${path}`).toEqual([]);
        a.unmount();
        vi.restoreAllMocks();
      }
    }
  });
});
