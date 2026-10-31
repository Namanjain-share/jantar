/**
 * v0.4 primer (docs/primer.md): the Mac-only switch accounts.prime and
 * accounts.primeKept (both off for everyone), the `primer.status` event and
 * the `state.primer` it sets.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT,
  MAC_ONLY_SETTING_GROUPS,
  PrimerStatusSchema,
  StateSchema,
  applySettingsPatch,
  defaultSettings,
  emptyState,
  macOnlyGroupIn,
  parseEvent,
  reduce,
  type PrimerStatus,
} from '../src/index.js';
import { T0, ev, resetSeq } from './helpers.js';

const status = (over: Partial<PrimerStatus> = {}): PrimerStatus => ({ by: 'jantar', running: null, last: null, ...over });

describe('primer settings', () => {
  it('ships off, held and kept accounts left out', () => {
    expect(defaultSettings().accounts).toMatchObject({ prime: false, primeKept: false });
  });

  it('takes booleans only, and is a Mac-only group (accounts)', () => {
    const s = defaultSettings();
    expect(applySettingsPatch(s, { accounts: { prime: true } })).toMatchObject({ ok: true, settings: { accounts: { prime: true, primeKept: false, kept: [] } } });
    expect(applySettingsPatch(s, { accounts: { prime: true, primeKept: true } }).ok).toBe(true);
    expect(applySettingsPatch(s, { accounts: { prime: 'yes' } })).toMatchObject({ ok: false, path: 'accounts.prime' });
    expect(applySettingsPatch(s, { accounts: { prime_kept: true } })).toMatchObject({ ok: false, path: 'accounts.prime_kept' });
    expect(MAC_ONLY_SETTING_GROUPS).toContain('accounts');
    expect(macOnlyGroupIn({ accounts: { prime: true } })).toBe('accounts');
  });
});

describe('primer.status', () => {
  beforeEach(() => resetSeq());

  it('is a state event: state.primer is the last status', () => {
    expect(EVENT.PRIMER_STATUS).toBe('primer.status');
    expect(emptyState().primer).toBeUndefined();
    let s = reduce(emptyState(), ev({ type: 'primer.status', data: { status: status({ running: 4 }) } }));
    expect(s.primer).toEqual(status({ running: 4 }));
    s = reduce(s, ev({ type: 'primer.status', data: { status: status({ last: { account: 4, at: T0, ok: true } }) } }));
    expect(s.primer).toEqual({ by: 'jantar', running: null, last: { account: 4, at: T0, ok: true } });
    expect(StateSchema.safeParse(s).success).toBe(true);
    // A state from a daemon before the primer still parses.
    const { primer: _gone, ...older } = s;
    expect(StateSchema.safeParse(older).success).toBe(true);
  });

  it('carries who primes, the running account and the last prime, nothing else', () => {
    for (const by of ['jantar', 'ccw', 'off'] as const) expect(PrimerStatusSchema.safeParse(status({ by })).success, by).toBe(true);
    expect(PrimerStatusSchema.safeParse(status({ by: 'cswap' as never })).success).toBe(false);
    expect(PrimerStatusSchema.safeParse(status({ running: -1 })).success).toBe(false);
    expect(PrimerStatusSchema.safeParse(status({ last: { account: 4, at: 'later', ok: true } })).success).toBe(false);
    expect(() => parseEvent({ seq: 1, ts: T0, type: 'primer.status', data: {} })).toThrow(/invalid event/);
    expect(parseEvent({ seq: 1, ts: T0, type: 'primer.status', data: { status: status({ by: 'ccw' }) } }).type).toBe('primer.status');
  });
});
