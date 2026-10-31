/**
 * The primer's one line on the Accounts screen (docs/primer.md), from
 * state.primer: who primes free 5-hour windows (Jantar, or ccw unless its
 * switch.json says "prime": false), the account being primed, the last prime
 * and a failure's retry time; nothing while nobody primes, and nothing with
 * one Claude login. It follows primer.status live. Synthetic accounts.
 */
// Testing Library's act, as the other screen tests use: it marks the environment as one that supports act.
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, PrimerStatus, State } from '@jantar/protocol';
import { PRODUCT_NAME } from '../src/brand.js';
import { primerText } from '../src/ui/screens/accounts/Primer.js';
import { dayClock } from '../src/ui/screens/accounts/time.js';
import { NOW, account, emit, iso, renderApp, stateWith } from './helpers.js';

/** Pretend the window is `width` px wide (jsdom has no matchMedia). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: m ? width >= Number(m[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

const status = (over: Partial<PrimerStatus> = {}): PrimerStatus => ({ by: 'jantar', running: null, last: null, ...over });
const AT = new Date(NOW - 20 * 60_000).toISOString();

function withPrimer(primer?: PrimerStatus, over: Parameters<typeof stateWith>[0] = {}): State {
  const s = stateWith({ accounts: [account(3), account(4)], ...over });
  if (primer) s.primer = primer;
  return s;
}

const line = () => document.querySelector('[data-primer]');

describe('the words', () => {
  it('says who primes, and the last prime', () => {
    expect(primerText(undefined, NOW)).toBeNull();
    expect(primerText(status({ by: 'off', last: { account: 4, at: AT, ok: true } }), NOW)).toBeNull();
    expect(primerText(status({ by: 'ccw' }), NOW)).toBe('ccw primes free 5-hour windows');
    expect(primerText(status(), NOW)).toBe(`${PRODUCT_NAME} primes free 5-hour windows`);
    expect(primerText(status({ running: 3, last: { account: 4, at: AT, ok: true } }), NOW)).toBe(`${PRODUCT_NAME} primes free 5-hour windows · starting 03 now`);
    expect(primerText(status({ last: { account: 4, at: AT, ok: true } }), NOW)).toBe(`${PRODUCT_NAME} primes free 5-hour windows · last 04 at ${dayClock(Date.parse(AT), NOW)}`);
    expect(primerText(status({ last: { account: 4, at: AT, ok: false } }), NOW)).toBe(
      `${PRODUCT_NAME} primes free 5-hour windows · 04 failed at ${dayClock(Date.parse(AT), NOW)}, again after ${dayClock(Date.parse(AT) + 30 * 60_000, NOW)}`,
    );
  });
});

describe('on the Accounts screen', () => {
  it('on a phone: one line under Moves, the account in mono', () => {
    viewport(390);
    renderApp({ path: '/accounts', state: withPrimer(status({ last: { account: 4, at: AT, ok: true } })) });
    const p = line();
    expect(p?.textContent).toBe(primerText(status({ last: { account: 4, at: AT, ok: true } }), NOW));
    expect(p?.querySelector('b')?.textContent).toBe('04');
    // It closes the screen, where Moves would be (no Moves heading without ccw); no button: the switch is the Mac's.
    expect(p?.closest('section')?.getAttribute('aria-labelledby')).toBeNull();
    expect(document.getElementById('moves-title')).toBeNull();
    expect(p?.querySelector('button')).toBeNull();
  });

  it('on a Mac: the same line, and ccw named when it primes', () => {
    viewport(1440);
    renderApp({ path: '/accounts', state: withPrimer(status({ by: 'ccw' })) });
    expect(line()?.textContent).toBe('ccw primes free 5-hour windows');
    expect(screen.getByRole('meter', { name: /03 5-hour usage/ })).toBeTruthy();
  });

  it('nothing while nobody primes, or before the daemon says', () => {
    viewport(390);
    const { unmount } = renderApp({ path: '/accounts', state: withPrimer(status({ by: 'off' })) });
    expect(line()).toBeNull();
    unmount();
    renderApp({ path: '/accounts', state: withPrimer() });
    expect(line()).toBeNull();
  });

  it('nothing with one Claude login', () => {
    viewport(390);
    const single = withPrimer(status(), { features: {}, accountsMode: 'single', accounts: [account(0, { usageStatus: 'unknown', windows: [] })] });
    renderApp({ path: '/accounts', state: single });
    expect(line()).toBeNull();
  });

  it('follows primer.status live', () => {
    viewport(390);
    const { store } = renderApp({ path: '/accounts', state: withPrimer(status()) });
    expect(line()?.textContent).toBe(`${PRODUCT_NAME} primes free 5-hour windows`);
    const seq = store.getState().state.seq;
    const ev = (n: number, s: PrimerStatus): DaemonEvent => ({ seq: seq + n, ts: iso(0), type: 'primer.status', data: { status: s } });
    act(() => emit(store, [ev(1, status({ running: 3 }))]));
    expect(line()?.textContent).toBe(`${PRODUCT_NAME} primes free 5-hour windows · starting 03 now`);
    act(() => emit(store, [ev(2, status({ last: { account: 3, at: AT, ok: false } }))]));
    expect(line()?.textContent).toContain('03 failed at');
    act(() => emit(store, [ev(3, status({ by: 'off' }))]));
    expect(line()).toBeNull();
  });
});
