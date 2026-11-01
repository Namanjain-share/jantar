/**
 * v0.6: the hook cards are their own chunks. A page left open across a
 * daemon update asks for the old build's chunk, which the new service
 * worker has dropped: the card's place says so, with Reload, instead of
 * the session screen going blank. Its own file: the mock below fails every
 * import of Plan.tsx here.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RELOAD_LINE } from '../src/ui/screens/Session.js';
import { pending, renderApp, session, stateWith } from './helpers.js';

vi.mock('../src/ui/screens/session/Plan.js', () => {
  throw new Error('synthetic: the chunk did not arrive');
});

describe('a card whose chunk is gone', () => {
  it('says what waits and offers Reload, and the rest of the screen stays', async () => {
    // React reports the error the boundary caught; the screen is what matters here.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderApp({
        path: '/s/a',
        state: stateWith({
          sessions: [session('a', { status: 'waiting' })],
          pending: [pending('a', { kind: 'plan', tool: 'ExitPlanMode', input: { plan: '# Ship it' } })],
        }),
      });
      const line = await screen.findByText(RELOAD_LINE, { selector: 'p' }, { timeout: 10_000 });
      const card = line.closest('article') as HTMLElement;
      expect(within(card).getByRole('heading').textContent).toBe('Plan');
      expect(within(card).getByRole('button', { name: 'Reload' })).toBeTruthy();
      // The session itself is still there around it.
      expect(screen.getByRole('tab', { name: 'Transcript' })).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });
});
