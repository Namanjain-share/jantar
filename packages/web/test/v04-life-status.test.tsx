/**
 * useLifeStatus (ui/screens/life/shared/useLife.ts): one GET /v1/life/status
 * at a time per Api, again when state.lifeTick moves. A tick that moves while
 * a fetch is still out is fetched as soon as that one ends, so a module just
 * switched on never stays shown as off.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LifeStatus } from '@jantar/protocol';
import { createRouter, memoryHistory } from '../src/lib/router.js';
import { createAppStore } from '../src/store.js';
import { AppProvider, createToastStore } from '../src/ui/context.js';
import { useLifeStatus } from '../src/ui/screens/life/shared/useLife.js';
import { fakeApi, stateWith } from './helpers.js';

const status = (medicines: boolean): LifeStatus => ({
  open: true,
  timezone: 'UTC',
  today: '2026-01-15',
  currency: null,
  lockScreenDetails: false,
  modules: { todos: false, medicines, food: false, places: false, finance: false },
  estimate: { available: false },
  backups: { last: null, count: 0 },
  push: { devices: 1, webpush: true },
});

function Probe() {
  const { status: s } = useLifeStatus();
  return <p>{s === null ? 'no status' : s.modules.medicines ? 'medicines on' : 'medicines off'}</p>;
}

describe('useLifeStatus', () => {
  it('fetches the newest tick once a fetch that started before it ends', async () => {
    const answers: ((s: LifeStatus) => void)[] = [];
    const lifeStatus = vi.fn(() => new Promise<LifeStatus>((resolve) => answers.push(resolve)));
    const api = fakeApi({ lifeStatus });
    const store = createAppStore(stateWith({ features: { life: true }, lifeTick: 1 }));
    render(
      <AppProvider deps={{ store, api, router: createRouter(memoryHistory('/')), toasts: createToastStore() }}>
        <Probe />
      </AppProvider>,
    );
    expect(lifeStatus).toHaveBeenCalledTimes(1);

    // Medicines are switched on while the first fetch is still out.
    act(() => store.setState((s) => ({ state: { ...s.state, lifeTick: 2 } })));
    expect(lifeStatus).toHaveBeenCalledTimes(1);
    await act(async () => answers[0]?.(status(false)));
    expect(screen.getByText('medicines off')).toBeTruthy();
    expect(lifeStatus).toHaveBeenCalledTimes(2);

    await act(async () => answers[1]?.(status(true)));
    expect(screen.getByText('medicines on')).toBeTruthy();
    expect(lifeStatus).toHaveBeenCalledTimes(2);
  });
});
