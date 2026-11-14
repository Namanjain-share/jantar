/**
 * 0.15 Messages in his places: right after Meetings (the Library on an
 * iPad), so on a phone it sits in More; only while Messages is on at the
 * Mac (Features.messages) and only on a device paired with control (every
 * Messages route needs it).
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FEATURES } from '@jantar/protocol';
import { writeLocal } from '../../src/lib/storage.js';
import { LOCAL_DEVICE_KEY } from '../../src/ui/screens/devices/local.js';
import { tabItems } from '../../src/ui/shell/nav.js';
import { renderApp, session, stateWith } from '../helpers.js';

function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return { matches: m ? width >= Number(m[1]) : false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}

const places = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('link')
    .map((l) => l.getAttribute('aria-label') ?? l.textContent?.trim().replace(/\d+$/, ''));

afterEach(() => vi.unstubAllGlobals());

describe('Messages in the nav', () => {
  it('after Meetings, in More on a phone; absent while Messages is off', () => {
    const t = tabItems({ ...NO_FEATURES, life: true, meetings: true, messages: true, people: true });
    expect(t.more.map((i) => i.label)).toEqual(['Devices', 'Meetings', 'Messages', 'Accountability partner']);
    expect(tabItems({ ...NO_FEATURES, life: true, meetings: true }).more.map((i) => i.label)).not.toContain('Messages');
    viewport(390);
    renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: { life: true, messages: true } }) });
    const more = within(screen.getByRole('list')).getAllByRole('link');
    expect(more.map((l) => l.getAttribute('href'))).toEqual(['/devices', '/messages']);
  });

  it('on the rail right after Meetings', () => {
    viewport(1440);
    renderApp({ state: stateWith({ sessions: [session('a')], features: { life: true, intel: true, meetings: true, messages: true } }) });
    expect(places()).toEqual(['Board', 'Today', 'Accounts', 'Alerts', 'Devices', 'Intel', 'Meetings', 'Messages']);
  });

  it('a device paired without control has no Messages row', () => {
    viewport(390);
    writeLocal(LOCAL_DEVICE_KEY, { id: 'dev-2', name: 'iPad', scopes: ['read'] });
    renderApp({ path: '/more', state: stateWith({ sessions: [session('a')], features: { life: true, messages: true, files: true } }) });
    expect(within(screen.getByRole('list')).getAllByRole('link').map((l) => l.getAttribute('href'))).not.toContain('/messages');
  });
});
