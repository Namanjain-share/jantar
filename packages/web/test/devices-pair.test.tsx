import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PushEnv } from '../src/lib/push.js';
import { ApiError } from '../src/lib/api.js';
import { pwaStore } from '../src/lib/pwa.js';
import { guessDeviceName } from '../src/ui/screens/Pair.js';
import { describeAgent } from '../src/ui/screens/devices/local.js';
import { countdown } from '../src/ui/screens/devices/PairNew.js';
import { NOW, fakeApi, fakeConnection, fakePushEnv, iso, renderApp, stateWith } from './helpers.js';

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

describe('pairing', () => {
  it('drops the code from the address bar, then claims it with a device name', async () => {
    const api = fakeApi();
    const connection = fakeConnection();
    const { history } = renderApp({ path: `/pair#c=${CODE}`, api, connection, status: 'unauthorized' });
    await waitFor(() => expect(history.entries.at(-1)).toBe('/pair'));
    expect(history.entries.some((e) => e.includes(CODE))).toBe(false);
    expect(api.pairClaim).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Name for this device') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Test phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    await waitFor(() => expect(api.pairClaim).toHaveBeenCalledWith({ code: CODE, name: 'Test phone' }));
    expect(await screen.findByRole('heading', { name: 'Paired' })).toBeTruthy();
    expect(connection.kick).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('jantar:device') ?? 'null')).toEqual({ id: 'dev-1', name: 'Test phone', scopes: ['read', 'control'] });
    fireEvent.click(screen.getByRole('button', { name: 'Open the board' }));
    expect(history.entries.at(-1)).toBe('/');
  });

  it('explains a bad or used code', async () => {
    const api = fakeApi({ pairClaim: vi.fn().mockRejectedValue(new ApiError('not_found', 'unknown code', 404)) });
    renderApp({ path: `/pair#c=${CODE}`, api });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/wrong, already used or expired/);
  });

  it('explains rate limiting', async () => {
    const api = fakeApi({ pairClaim: vi.fn().mockRejectedValue(new ApiError('rate_limited', 'slow down', 429)) });
    renderApp({ path: `/pair#c=${CODE}`, api });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Too many tries/);
  });

  it('handles a link without a code', () => {
    renderApp({ path: '/pair' });
    expect(screen.getByText(/This link has no pairing code/)).toBeTruthy();
  });

  it('guesses a device name from the user agent', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari/604.1')).toBe('iPhone');
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15; Pixel) Chrome/130 Mobile Safari/537.36')).toBe('Android phone');
    expect(guessDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Chrome/130 Safari/537.36')).toBe('Mac (Chrome)');
    expect(guessDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15')).toBe('Mac (Safari)');
  });
});

describe('pair flow (direction.md 5.5, 5.7)', () => {
  it('walks an iPhone through Home Screen install, then explains that notifications need it', async () => {
    const before = pwaStore.getState();
    pwaStore.setState({ ios: true, standalone: false, installEvent: null });
    try {
      const env = fakePushEnv({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X)', standalone: false });
      renderApp({ path: `/pair#c=${CODE}`, pushEnv: env, status: 'unauthorized' });
      expect(document.body.textContent).toContain('step 1 of 3');
      fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
      expect(await screen.findByRole('heading', { name: 'Add Jantar to your Home Screen' })).toBeTruthy();
      expect(document.body.textContent).toContain('step 2 of 3');
      expect(screen.getByRole('heading', { name: 'Paired' })).toBeTruthy();
      expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        '1Tap Share ',
        '2Tap Add to Home Screen',
        '3Open Jantar from your Home Screen',
      ]);
      expect(screen.getByText(/only sends notifications to installed apps/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(await screen.findByRole('heading', { name: 'Know when a session needs you' })).toBeTruthy();
      expect(screen.getByRole('img', { name: /^Example notification/ })).toBeTruthy();
      expect(screen.getByText('Example data')).toBeTruthy();
      expect(await screen.findByText(/only work in the Home Screen app/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
      expect(document.querySelectorAll('[data-display]').length).toBe(1);
    } finally {
      pwaStore.setState(before);
    }
  });

  it('offers notifications with an example banner when push can be asked for', async () => {
    const api = fakeApi();
    const { env } = pushEnvWith();
    renderApp({ path: `/pair#c=${CODE}`, api, pushEnv: env, status: 'unauthorized' });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }));
    expect(await screen.findByText('Notifications are on')).toBeTruthy();
    // The new subscription carries this device's kinds (the Mac's defaults until changed).
    expect(api.pushSubscribe).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ['question', 'permission', 'plan', 'send-failed'] }));
    expect(screen.getByRole('button', { name: 'Open the board' })).toBeTruthy();
  });

  it('describes a paired device from its user agent', () => {
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit Version/26.1 Mobile Safari/604.1')).toBe('Safari · iOS 26.1');
    expect(describeAgent('Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/141.0 Mobile Safari/537.36')).toBe('Chrome · Android 16');
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0 Safari/537.36')).toBe('Chrome · macOS');
    expect(describeAgent(undefined)).toBe('');
  });
});

describe('devices screen', () => {
  it('lists devices, revoked last, and revokes one by holding Revoke for 2 seconds', async () => {
    const devices = [
      { id: 'dev-2', name: 'Old tablet', scopes: ['read'] as const, createdAt: iso(0), lastSeenAt: iso(0), revokedAt: iso(10) },
      { id: 'dev-1', name: 'Test phone', scopes: ['read', 'control', 'admin'] as const, createdAt: iso(0), lastSeenAt: iso(200_000) },
    ];
    const listDevices = vi.fn(async () => ({ devices: devices.map((d) => ({ ...d, scopes: [...d.scopes] })) }));
    const api = fakeApi({ listDevices });
    // Listing devices needs admin: this device was paired as admin.
    localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: 'Test phone', scopes: ['read', 'control', 'admin'] }));
    renderApp({ path: '/devices', api, state: stateWith({}) });
    const list = await screen.findByRole('list', { name: 'Paired devices' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent?.includes('Test phone'))).toEqual([true, false]);
    expect(within(list).getByText('this device')).toBeTruthy();
    // Revoked devices have no actions; the "···" button opens the row holding Revoke.
    expect(within(list).getAllByRole('button', { name: /^Actions for/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Actions for Test phone']);
    fireEvent.click(within(list).getByRole('button', { name: 'Actions for Test phone' }));
    const hold = within(list).getByRole('button', { name: 'Revoke. Hold for 2 seconds' });
    fireEvent.click(hold);
    expect(api.revokeDevice).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(hold, { button: 0 });
      act(() => vi.advanceTimersByTime(1999));
      expect(api.revokeDevice).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith('dev-1'));
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Test phone can no longer connect.')).toBeTruthy();
  });

  it('explains the admin scope when devices are forbidden', async () => {
    const api = fakeApi({ listDevices: vi.fn().mockRejectedValue(new ApiError('forbidden', 'needs admin', 403)) });
    renderApp({ path: '/devices', api, state: stateWith({}) });
    expect(await screen.findByText(/Managing devices needs the admin scope/)).toBeTruthy();
  });

  it('does not ask for the device list when this device knows it has no admin scope', async () => {
    const listDevices = vi.fn(async () => ({ devices: [] }));
    const api = fakeApi({ listDevices });
    localStorage.setItem('jantar:device', JSON.stringify({ id: 'dev-1', name: 'Test phone', scopes: ['read', 'control'] }));
    renderApp({ path: '/devices', api, state: stateWith({}) });
    expect(await screen.findByText(/Managing devices needs the admin scope/)).toBeTruthy();
    expect(listDevices).not.toHaveBeenCalled();
  });

  it('shows a pairing QR code with the code hidden in the visible link', async () => {
    const api = fakeApi();
    renderApp({ path: '/devices', api, state: stateWith({}) });
    fireEvent.click(screen.getByRole('button', { name: /Show pairing code/ }));
    const qr = await screen.findByRole('img', { name: 'Pairing QR code' });
    expect(api.pairStart).toHaveBeenCalledWith({});
    expect(qr.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100);
    expect(screen.getByText('https://mac.example.test/pair#c=…')).toBeTruthy();
    expect(screen.getByText(/expires in/)).toBeTruthy();
  });

  it('a code made here gives read and control; an admin device is paired with the CLI', () => {
    renderApp({ path: '/devices', state: stateWith({}) });
    expect(screen.queryByLabelText(/Also allow admin/)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('jantar pair --admin')).toBeTruthy();
  });

  it('says pairing codes are made on the Mac when forbidden', async () => {
    const api = fakeApi({ pairStart: vi.fn().mockRejectedValue(new ApiError('forbidden', 'local only', 403)) });
    renderApp({ path: '/devices', api, state: stateWith({}) });
    fireEvent.click(screen.getByRole('button', { name: /Show pairing code/ }));
    expect(await screen.findByText(/Run jantar pair in Terminal there/)).toBeTruthy();
  });

  it('counts the pairing code down and offers a new one when it expires', async () => {
    const api = fakeApi({
      pairStart: vi.fn(async () => ({ code: 'C0DEc0deC0DEc0deC0DE', url: 'https://mac.example.test/pair#c=C0DEc0deC0DEc0deC0DE', expiresAt: new Date(NOW - 1000).toISOString() })),
    });
    renderApp({ path: '/devices', api, state: stateWith({}) });
    fireEvent.click(screen.getByRole('button', { name: /Show pairing code/ }));
    expect(await screen.findByText('This code expired.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Expired pairing QR code' })).toBeTruthy();
    expect(screen.getByText(/Anyone with this code can pair until it expires/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make a new code' }));
    await waitFor(() => expect(api.pairStart).toHaveBeenCalledTimes(2));
    expect(countdown(272_000)).toBe('4:32');
    expect(countdown(599_001)).toBe('10:00');
    expect(countdown(-5)).toBe('0:00');
  });

  it('switches the theme', () => {
    renderApp({ path: '/devices', state: stateWith({}) });
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

function pushEnvWith(over: Partial<PushEnv> & { subscribed?: boolean } = {}) {
  const sub = {
    endpoint: 'https://push.example.test/sub/1',
    options: { applicationServerKey: null as ArrayBuffer | null },
    toJSON: () => ({ endpoint: 'https://push.example.test/sub/1', expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } }),
    unsubscribe: vi.fn(async () => true),
  };
  let current = over.subscribed ? sub : null;
  let permission: NotificationPermission = over.subscribed ? 'granted' : 'default';
  const reg = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => {
        current = sub;
        return sub;
      }),
    },
  };
  const env = fakePushEnv({
    hasServiceWorker: true,
    hasPushManager: true,
    notification: {
      get permission() {
        return permission;
      },
      requestPermission: vi.fn(async () => {
        permission = 'granted';
        return permission;
      }),
    },
    ready: async () => reg,
    ...over,
  });
  return { env, reg, sub };
}

describe('notifications', () => {
  it('turns push on: permission, VAPID key, subscribe, register', async () => {
    const api = fakeApi();
    const { env, reg } = pushEnvWith();
    renderApp({ path: '/devices', api, pushEnv: env, state: stateWith({}) });
    fireEvent.click(await screen.findByRole('button', { name: /Turn on notifications/ }));
    await waitFor(() => expect(api.pushSubscribe).toHaveBeenCalled());
    expect(env.notification?.requestPermission).toHaveBeenCalled();
    expect(api.vapidKey).toHaveBeenCalled();
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) });
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      subscription: { endpoint: 'https://push.example.test/sub/1', expirationTime: null, keys: { p256dh: 'pk', auth: 'au' } },
    });
    expect(await screen.findByText('Notifications are on')).toBeTruthy();
  });

  it('mutes and turns push off', async () => {
    const api = fakeApi();
    const { env, sub } = pushEnvWith({ subscribed: true });
    renderApp({ path: '/devices', api, pushEnv: env, state: stateWith({}) });
    fireEvent.click(await screen.findByRole('button', { name: 'Mute 1 hour' }));
    await waitFor(() => expect(api.mute).toHaveBeenCalledWith(60));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.pushUnsubscribe).toHaveBeenCalledWith('https://push.example.test/sub/1'));
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('lists ten kinds with "Not delivered" locked on, and re-registers when one changes', async () => {
    const api = fakeApi();
    const { env } = pushEnvWith({ subscribed: true });
    renderApp({ path: '/devices', api, pushEnv: env, state: stateWith({}) });
    const group = await screen.findByRole('group', { name: 'Notification kinds' });
    const switches = within(group).getAllByRole('switch') as HTMLInputElement[];
    expect(switches.length).toBe(10);
    expect(screen.getByText('· 4 of 10 kinds')).toBeTruthy();
    const locked = within(group).getByRole('switch', { name: /Not delivered/ }) as HTMLInputElement;
    expect(locked.checked).toBe(true);
    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(locked.getAttribute('aria-describedby') ?? '')?.textContent).toBe('A prompt that was not sent must reach you.');
    fireEvent.click(within(group).getByRole('switch', { name: /^Done/ }));
    await waitFor(() =>
      expect(api.pushSubscribe).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ['question', 'permission', 'plan', 'done', 'send-failed'] })),
    );
    expect(screen.getByText('· 5 of 10 kinds')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('jantar:push-kinds') ?? '[]')).toContain('done');
  });

  it('tells iPhone users to add the app to the Home Screen first', async () => {
    const { env } = pushEnvWith({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: false });
    renderApp({ path: '/devices', pushEnv: env, state: stateWith({}) });
    expect(await screen.findByText(/only work in the Home Screen app/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Turn on notifications/ })).toBeNull();
  });

  it('explains blocked notifications', async () => {
    const env = fakePushEnv({
      hasServiceWorker: true,
      hasPushManager: true,
      notification: { permission: 'denied', requestPermission: async () => 'denied' },
    });
    renderApp({ path: '/devices', pushEnv: env, state: stateWith({}) });
    expect(await screen.findByText(/Notifications are blocked for this site/)).toBeTruthy();
  });

  it('re-registers an existing subscription once connected', async () => {
    const api = fakeApi();
    const { env } = pushEnvWith({ subscribed: true });
    renderApp({ api, pushEnv: env, state: stateWith({}) });
    await waitFor(() => expect(api.pushSubscribe).toHaveBeenCalledTimes(1));
  });
});
