/**
 * useLifeLoad (ui/screens/life/shared/useLife.ts): a reload always loads the
 * key shown now. A sheet closes 260 ms after its write and calls the reload it
 * was given then; if the day changed meanwhile, that old reload must not load
 * the old day over the new one (the screen stayed on "Loading" for good).
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, memoryHistory } from '../src/lib/router.js';
import { createAppStore } from '../src/store.js';
import { AppProvider, createToastStore } from '../src/ui/context.js';
import { useLifeLoad } from '../src/ui/screens/life/shared/useLife.js';
import { fakeApi, stateWith } from './helpers.js';

function Probe({ day, load, keep }: { day: string; load: (day: string) => Promise<string>; keep: (reload: () => void) => void }) {
  const l = useLifeLoad(`day:${day}`, () => load(day));
  keep(l.reload);
  return <p>{l.data ?? 'loading'}</p>;
}

describe('useLifeLoad', () => {
  it('an old reload, called after the key changed, loads the key shown now', async () => {
    const load = vi.fn(async (day: string) => `shown ${day}`);
    const reloads: Array<() => void> = [];
    const store = createAppStore(stateWith({ features: { life: true } }));
    const deps = { store, api: fakeApi(), router: createRouter(memoryHistory('/')), toasts: createToastStore() };
    const ui = (day: string) => (
      <AppProvider deps={deps}>
        <Probe day={day} load={load} keep={(r) => reloads.push(r)} />
      </AppProvider>
    );
    const { rerender } = render(ui('2026-01-14'));
    expect(await screen.findByText('shown 2026-01-14')).toBeTruthy();
    const oldReload = reloads.at(-1) as () => void;

    rerender(ui('2026-01-15'));
    expect(await screen.findByText('shown 2026-01-15')).toBeTruthy();
    await act(async () => oldReload());
    expect(load).toHaveBeenLastCalledWith('2026-01-15');
    expect(screen.getByText('shown 2026-01-15')).toBeTruthy();
    expect(screen.queryByText('loading')).toBeNull();
  });
});
