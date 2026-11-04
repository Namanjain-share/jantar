/**
 * 0.12.2: her Me › Devices › Link another device, against a fake client
 * with synthetic people (Sam and Asha) and codes.
 *
 * - The whole link, built on her app's own origin (never the daemon's
 *   idea of a host), with Copy link, Share where the browser has it, and a
 *   QR code loaded on demand; the code in large monospace to type at
 *   /p/link; the steps through the One-time PIN sign-in; when it runs out.
 * - When it has run out, the link, the code and their buttons go, and the
 *   page says how to get a new one.
 * - How many of her five devices are linked.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSON_DEVICES_MAX, PERSON_LINK_CODE_TTL_MS, presetAgreement } from '@jantar/protocol/people-core';
import type { PersonMe } from '@jantar/protocol/people';
import type { PersonApi, PersonDevice } from '../../src/partner/api.js';
import { Me } from '../../src/partner/screens/Me.js';

const ASHA = '01JASHAAAAAAAAAAAAAAAAAAAA';
const CODE = 'synthetic-link_code-01';
const T0 = new Date('2026-11-04T10:00:00.000Z');
const STEPS = 'On the other device: open the link, sign in with the code emailed to you, and if it asks, open the link again or paste it.';

function me(): PersonMe {
  return {
    person: { id: ASHA, name: 'Asha', color: 'teal', state: 'active', modules: { food: false }, prefs: {} as PersonMe['person']['prefs'] },
    owner: { name: 'Sam' },
    peopleOn: true,
    agreement: { ...presetAgreement('everything'), version: 1 },
    pending: null,
    ownerDevices: [],
    built: 'P4',
    lifeBroken: false,
  } as PersonMe;
}

const device = (n: number, over: Partial<PersonDevice> = {}): PersonDevice =>
  ({ id: `01JDEV${String(n).padStart(20, 'A')}`, name: n === 1 ? 'iPhone' : `Device ${n}`, createdAt: T0.toISOString(), lastSeenAt: T0.toISOString(), current: n === 1, ...over }) as PersonDevice;

function fakeApi(over: Partial<PersonApi> = {}): PersonApi {
  const base: Partial<PersonApi> = {
    devices: vi.fn(async () => ({ devices: [device(1)] })),
    // The daemon's own idea of the host is not what her app shows.
    linkCode: vi.fn(async () => ({ code: CODE, url: `https://elsewhere.invalid/p/link#c=${CODE}`, expiresAt: new Date(Date.now() + PERSON_LINK_CODE_TTL_MS).toISOString() })),
  };
  return new Proxy(base as PersonApi, {
    get: (_t, k: string) => (k in over ? (over as Record<string, unknown>)[k] : (base as Record<string, unknown>)[k] ?? ((base as Record<string, unknown>)[k] = vi.fn(async () => ({})))),
  });
}

/** Set (or with undefined, take away) a navigator property for one test. */
function setNavigator(key: 'share' | 'clipboard', value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(navigator, key);
  else Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

async function openLink(api = fakeApi()): Promise<HTMLElement> {
  render(<Me me={me()} api={api} reload={() => {}} tab="devices" />);
  await act(async () => undefined);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Link another device' }));
  });
  return screen.getByRole('region', { name: 'Link another device' });
}

describe('Me › Devices › Link another device (0.12.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setNavigator('share', undefined);
    setNavigator('clipboard', undefined);
  });

  it('shows the whole link on her own origin, the code to type, the steps and when it runs out', async () => {
    const box = await openLink();
    const url = `${location.origin}/p/link#c=${CODE}`;
    expect(within(box).getByLabelText('Link for the other device').textContent).toBe(url);
    expect(box.textContent).not.toContain('elsewhere.invalid');
    expect(within(box).getByText(STEPS)).toBeTruthy();
    expect(within(box).getByText(`Or open ${location.host}/p/link there and type this code:`)).toBeTruthy();
    const code = within(box).getByLabelText('Link code');
    expect(code.textContent).toBe(CODE);
    expect(code.className).toMatch(/\bfont-mono\b/);
    expect(code.className).toMatch(/\btext-title\b/);
    const until = hm(new Date(T0.getTime() + 15 * 60_000));
    expect(within(box).getByText(`It works once, until ${until} (15 min left).`)).toBeTruthy();
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(within(box).getByText(`It works once, until ${until} (10 min left).`)).toBeTruthy();
    expect(box.textContent).not.toMatch(/5 minutes/);
  });

  it('Copy link puts the whole link on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    setNavigator('clipboard', { writeText });
    const box = await openLink();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Copy link' }));
    });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/p/link#c=${CODE}`);
    expect(within(box).getByRole('status').textContent).toBe('Copied.');
  });

  it("where the clipboard refuses, it says to select the link (it's on screen)", async () => {
    setNavigator('clipboard', { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) });
    const box = await openLink();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Copy link' }));
    });
    expect(within(box).getByRole('status').textContent).toBe("Couldn't copy here. Select the link above and copy it.");
  });

  it('Share is there only where the browser can share, and hands it the link', async () => {
    let box = await openLink();
    expect(within(box).queryByRole('button', { name: 'Share' })).toBeNull();
    document.body.innerHTML = '';
    const share = vi.fn(async () => undefined);
    setNavigator('share', share);
    box = await openLink();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Share' }));
    });
    expect(share).toHaveBeenCalledWith({ url: `${location.origin}/p/link#c=${CODE}` });
    expect(within(box).queryByRole('status')).toBeNull();
  });

  it('closing the share sheet says nothing; a share that fails says to copy instead', async () => {
    const share = vi.fn<() => Promise<void>>().mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError' })).mockRejectedValueOnce(new Error('no'));
    setNavigator('share', share);
    const box = await openLink();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Share' }));
    });
    expect(within(box).queryByRole('status')).toBeNull();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Share' }));
    });
    expect(within(box).getByRole('status').textContent).toBe("Couldn't share from here. Copy the link instead.");
  });

  it('a QR code of the link, loaded when she asks for it', async () => {
    const box = await openLink();
    expect(within(box).queryByRole('img', { name: 'QR code of the link' })).toBeNull();
    await act(async () => {
      fireEvent.click(within(box).getByRole('button', { name: 'Show QR code' }));
    });
    vi.useRealTimers();
    expect(await within(box).findByRole('img', { name: 'QR code of the link' })).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Hide QR code' }));
    expect(within(box).queryByRole('img', { name: 'QR code of the link' })).toBeNull();
  });

  it('once it runs out, the link, the code and their buttons go, and it says how to get a new one', async () => {
    const box = await openLink();
    act(() => vi.advanceTimersByTime(15 * 60_000 + 1000));
    expect(box.isConnected).toBe(false);
    expect(screen.queryByLabelText('Link code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('That link has run out. Tap Link another device for a new one.');
    // A new one.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link another device' }));
    });
    expect(screen.getByRole('region', { name: 'Link another device' })).toBeTruthy();
    expect(screen.queryByText(/has run out/)).toBeNull();
  });

  it(`says how many of her ${PERSON_DEVICES_MAX} devices are linked`, async () => {
    render(<Me me={me()} api={fakeApi({ devices: vi.fn(async () => ({ devices: [device(1), device(2)] })) })} reload={() => {}} tab="devices" />);
    await act(async () => undefined);
    expect(screen.getByText('2 of 5 devices linked.')).toBeTruthy();
  });

  it('the daemon\'s "five devices" answer shows under the button', async () => {
    const full = 'Five devices are linked already, the most there can be. Revoke one you no longer use, then tap Link another device again.';
    const devices = vi.fn(async () => ({ devices: [1, 2, 3, 4, 5].map((n) => device(n)) }));
    render(<Me me={me()} api={fakeApi({ devices, linkCode: vi.fn(async () => Promise.reject(new Error(full))) })} reload={() => {}} tab="devices" />);
    await act(async () => undefined);
    expect(screen.getByText('5 of 5 devices linked.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link another device' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(full);
    expect(screen.queryByRole('region', { name: 'Link another device' })).toBeNull();
  });
});
