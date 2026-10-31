/**
 * WP0's v0.5 slot (MW4, and "nothing new shows while Meetings are off"):
 * /meetings is not found while the Mac keeps Meetings off (the default, and
 * what an older daemon means), and opens once they are on, its `<h1>`
 * "Meetings" showing while every v0.5 call answers 501 (WP0's placeholder,
 * until WP-MW lands; its loading and error states keep the heading). The
 * route reads its query only when it matches.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, routePath, type Route } from '../src/lib/router.js';
import { fakeApi, renderApp, session, stateWith } from './helpers.js';

function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return { matches: m ? width >= Number(m[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}
afterEach(() => vi.unstubAllGlobals());

const ID = '01JFZ8X8Y3T0V5G9WQK2M4N6PR';

describe('the Meetings place', () => {
  it('is not found while Meetings are off, whatever else is on', async () => {
    viewport(1440);
    for (const path of ['/meetings', `/meetings?id=${ID}`]) {
      const { unmount } = renderApp({ path, state: stateWith({ sessions: [session('a')], features: { files: true, life: true, intel: true } }) });
      expect(await screen.findByText('That is off on this Mac.'), path).toBeTruthy();
      expect(screen.getByText('jantar meetings on'), path).toBeTruthy();
      unmount();
    }
  });

  it('opens once they are on, its heading showing with every v0.5 call answering 501', async () => {
    for (const width of [390, 1440]) {
      viewport(width);
      const api = fakeApi();
      for (const path of ['/meetings', `/meetings?id=${ID}`, '/meetings?project=none&q=launch']) {
        const { unmount } = renderApp({ path, api, state: stateWith({ sessions: [session('a')], features: { meetings: true } }) });
        expect(await screen.findByRole('heading', { level: 1, name: 'Meetings' }), `${width} ${path}`).toBeTruthy();
        unmount();
      }
      await expect(api.meetingsList()).rejects.toMatchObject({ code: 'not_implemented', status: 501 });
    }
  });
});

describe('the meetings route', () => {
  it('round-trips, reading a project id or none, the search, and a meeting id', () => {
    const cases: Route[] = [
      { name: 'meetings' },
      { name: 'meetings', project: ID, q: 'launch date', id: ID },
      { name: 'meetings', project: 'none' },
    ];
    for (const r of cases) {
      const u = new URL(routePath(r), 'http://x');
      expect(parseRoute(u.pathname, u.search), routePath(r)).toEqual(r);
    }
    expect(parseRoute('/meetings', '?project=all&id=../x')).toEqual({ name: 'meetings' });
    expect(parseRoute('/meetings', '?id=__proto__&project=constructor')).toEqual({ name: 'meetings' });
    expect(parseRoute('/meetings', `?q=${'x'.repeat(150)}`)).toEqual({ name: 'meetings', q: 'x'.repeat(100) });
  });
});
