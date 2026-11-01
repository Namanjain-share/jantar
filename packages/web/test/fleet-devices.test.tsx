/**
 * v0.6 Fleet in Devices (spec 0.7 and 6): once a machine is paired, a
 * Machines section follows the paired devices: each machine by name with
 * its OS and terminal word, online with its sessions or "offline since",
 * its Jantar version (with the Mac's when they differ), the link-version
 * line, and Remove… (two taps, admin devices only) that sends DELETE
 * /v1/machines/:id with this device's secret. Pairing stays at the Mac. With
 * no machine paired Devices is v0.5's.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEVICE_SECRET_HEADER, FLEET_COPY, type DaemonEvent, type State } from '@jantar/protocol';
import { createApi, type Api } from '../src/lib/api.js';
import type { CredentialStore } from '../src/lib/credential.js';
import { PAIR_LINE, presenceText, versionText } from '../src/ui/screens/devices/Machines.js';
import { emit, fakeApi, iso, NOW, renderApp, stateWith } from './helpers.js';
import { fleetNodes, fleetState, IDS } from './fleet-helpers.js';

beforeAll(async () => {
  await import('../src/ui/screens/devices/Machines.js');
});

/** The Mac runs 0.6.0, as the machines' versions are read against it. */
function withMac(s: State): State {
  if (s.daemon) s.daemon.daemonVersion = '0.6.0';
  return s;
}
const fleet = () => withMac(fleetState({ features: {} }));
// Named once, by its heading ("Machines 6"): never the section, its heading and its list all three.
const machines = async () => within(await screen.findByRole('region', { name: /^Machines/ }, { timeout: 10_000 })).getByRole('list');
const rowOf = (list: HTMLElement, name: string) => list.querySelector<HTMLElement>(`li[data-machine="${name}"]`)!;
const admin = () => localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: 'Test phone', scopes: ['read', 'control', 'admin'] }));

describe('Machines', () => {
  it('lists each machine by name with its OS, terminal, presence and version', async () => {
    renderApp({ path: '/devices', state: fleet() });
    const list = await machines();
    // A screen reader hears "Machines" once: the heading names the section, and nothing else repeats it.
    expect(document.querySelectorAll('[aria-label="Machines"]')).toHaveLength(0);
    expect([...list.querySelectorAll<HTMLElement>('li[data-machine]')].map((li) => li.dataset.machine)).toEqual([
      'build-1',
      'build-2',
      'build-3',
      'mini-1',
      'ro-1',
      'win-1',
    ]);
    const b1 = rowOf(list, 'build-1');
    expect(b1.textContent).toContain('Linux · tmux');
    // build-1 runs three sessions (one outside tmux).
    expect(b1.textContent).toContain('online · 3 sessions');
    expect(b1.textContent).toContain('Jantar 0.6.0');
    expect(b1.textContent).not.toContain('Mac has');
    expect(rowOf(list, 'build-2').textContent).toContain('Linux (WSL) · tmux');
    expect(rowOf(list, 'build-2').textContent).toContain('online · 1 session');
    expect(rowOf(list, 'win-1').textContent).toContain('Windows · watch');
    expect(rowOf(list, 'mini-1').textContent).toContain('macOS · Terminal');
    expect(rowOf(list, 'build-3').textContent).toContain('offline since 14:02');
    expect(screen.getByText(PAIR_LINE)).toBeTruthy();
    expect(PAIR_LINE).toBe('jantar node pair');
  });

  it('shows the version skew and the link-version line', async () => {
    renderApp({ path: '/devices', state: fleet() });
    const b2 = rowOf(await machines(), 'build-2');
    expect(b2.textContent).toContain('Jantar 0.5.9 · Mac has 0.6.0');
    expect(within(b2).getByText(FLEET_COPY.versionProblem('build-2'))).toBeTruthy();
    expect(within(rowOf(await machines(), 'build-1')).queryByText(/older link version/)).toBeNull();
  });

  it('removes a machine with two taps, sending DELETE /v1/machines/:id with the device secret', async () => {
    admin();
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ machine: { id: IDS.build3 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const credentials = {
      get: async () => ({ secret: 'S'.repeat(43), deviceId: 'dev-1', savedAt: '2026-01-15T00:00:00.000Z' }),
      set: async () => undefined,
      clear: async () => undefined,
    } as unknown as CredentialStore;
    const real = createApi({ fetch: fetch as unknown as typeof globalThis.fetch, base: 'https://mac.example.test', credentials });
    const machineRevoke = vi.fn(real.machineRevoke);
    renderApp({ path: '/devices', api: fakeApi({ machineRevoke }), state: fleet() });
    const row = rowOf(await machines(), 'build-3');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove…' }));
    // One tap only arms it.
    expect(machineRevoke).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Tap again to remove build-3' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://mac.example.test/v1/machines/${IDS.build3}`);
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>)[DEVICE_SECRET_HEADER]).toBe('S'.repeat(43));
    expect((init?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
    expect(await screen.findByText('build-3 is removed. Pair it again at the Mac to bring it back.')).toBeTruthy();
  });

  it('shows the receipt after removing the last machine too', async () => {
    admin();
    const s = fleet();
    s.nodes = { [IDS.build3]: s.nodes![IDS.build3]! };
    // The Mac's reply, held until the test lets it go (its body is not read).
    let reply = () => {};
    const machineRevoke = vi.fn(
      (_id: string, _key?: string) => new Promise<Awaited<ReturnType<Api['machineRevoke']>>>((r) => (reply = () => r({ machine: {} } as never))),
    );
    const { store } = renderApp({ path: '/devices', api: fakeApi({ machineRevoke }), state: s });
    const row = rowOf(await machines(), 'build-3');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove…' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Tap again to remove build-3' }));
    // The Mac's node.removed can come before its reply: the machine goes, the section stays.
    const removed: DaemonEvent = { seq: store.getState().state.seq + 1, ts: iso(0), type: 'node.removed', data: { id: IDS.build3 } };
    act(() => emit(store, [removed]));
    await act(async () => reply());
    expect(await screen.findByText('build-3 is removed. Pair it again at the Mac to bring it back.')).toBeTruthy();
    expect(within(await machines()).queryByRole('listitem')).toBeNull();
  });

  it("says why a Remove failed, on that machine's row", async () => {
    admin();
    const { ApiError } = await import('../src/lib/api.js');
    const machineRevoke = vi.fn(async () => Promise.reject(new ApiError('forbidden', 'Removing a machine needs the admin scope.', 403)));
    renderApp({ path: '/devices', api: fakeApi({ machineRevoke }), state: fleet() });
    const row = rowOf(await machines(), 'win-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove…' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Tap again to remove win-1' }));
    expect(await within(row).findByText('Removing a machine needs the admin scope.')).toBeTruthy();
    expect(machineRevoke).toHaveBeenCalledWith(IDS.win1, expect.any(String));
  });

  it('offers no Remove to a device paired without admin', async () => {
    localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-2', name: 'Other phone', scopes: ['read', 'control'] }));
    renderApp({ path: '/devices', state: fleet() });
    const list = await machines();
    expect(within(list).queryByRole('button', { name: 'Remove…' })).toBeNull();
    // Still listed: every device sees where its sessions run.
    expect(rowOf(list, 'build-1')).toBeTruthy();
  });

  it('never offers to pair a machine from the phone', async () => {
    admin();
    renderApp({ path: '/devices', state: fleet() });
    const list = await machines();
    expect(within(list.closest('section')!).queryByRole('button', { name: /pair/i })).toBeNull();
  });
});

describe('the words', () => {
  it('say presence and version', () => {
    const n = fleetNodes();
    expect(presenceText(n[IDS.build1]!, 3, NOW)).toBe('online · 3 sessions');
    expect(presenceText(n[IDS.build1]!, 1, NOW)).toBe('online · 1 session');
    expect(presenceText(n[IDS.build3]!, 1, NOW)).toBe('offline since 14:02');
    expect(versionText({ version: '0.6.0' }, '0.6.0')).toBe('Jantar 0.6.0');
    expect(versionText({ version: '0.5.9' }, '0.6.0')).toBe('Jantar 0.5.9 · Mac has 0.6.0');
    expect(versionText({ version: '0.6.0' }, undefined)).toBe('Jantar 0.6.0');
  });
});

describe('with no machine paired', () => {
  it("is v0.5's Devices, with nodes empty or absent", async () => {
    for (const nodes of [{}, undefined]) {
      const s = stateWith({ features: {} });
      if (nodes) s.nodes = nodes;
      else delete s.nodes;
      const { unmount } = renderApp({ path: '/devices', state: s });
      expect(await screen.findByText(/not affiliated with or endorsed by Anthropic/)).toBeTruthy();
      expect(screen.queryByRole('region', { name: /^Machines/ })).toBeNull();
      expect(screen.queryByText(PAIR_LINE)).toBeNull();
      unmount();
    }
  });
});
