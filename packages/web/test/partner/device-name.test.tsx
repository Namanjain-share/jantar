/**
 * 0.12.2: the name a device of hers joins or links with, from its browser's
 * user agent. Before, anything that wasn't an iPhone or iPad was "Phone",
 * so the laptop she links through Me › Devices showed as "Phone" on her
 * list and on his. The user agents are the browsers' own published shapes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PersonApi } from '../../src/partner/api.js';
import { deviceNameOf } from '../../src/partner/device-name.js';
import { Join } from '../../src/partner/screens/Join.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for desktop sites: a Mac's user agent, with touch.
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
};

describe('deviceNameOf (0.12.2)', () => {
  it('names the device by its kind', () => {
    expect(deviceNameOf(UA.iphone, 5)).toBe('iPhone');
    expect(deviceNameOf(UA.ipadOld, 5)).toBe('iPad');
    expect(deviceNameOf(UA.mac, 5)).toBe('iPad');
    expect(deviceNameOf(UA.mac, 0)).toBe('Mac');
    expect(deviceNameOf(UA.androidPhone, 5)).toBe('Android phone');
    expect(deviceNameOf(UA.androidTablet, 5)).toBe('Android tablet');
    expect(deviceNameOf(UA.windows, 0)).toBe('Windows PC');
    expect(deviceNameOf(UA.chromebook, 0)).toBe('Chromebook');
    expect(deviceNameOf(UA.linux, 0)).toBe('Linux computer');
  });

  it('anything else is "Phone", as before', () => {
    expect(deviceNameOf('', 0)).toBe('Phone');
    expect(deviceNameOf('SomethingElse/1.0', 0)).toBe('Phone');
  });
});

describe('/p/link names the device it links (0.12.2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('her Mac links as "Mac", not "Phone"', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(UA.mac);
    history.replaceState(null, '', '/p/link#c=synthetic-link_code-01');
    const linkClaim = vi.fn(async () => ({ personId: '01JASHAAAAAAAAAAAAAAAAAAAA', deviceId: '01JDEVICEAAAAAAAAAAAAAAAAA', deviceSecret: 's' }));
    render(<Join api={{ linkClaim, me: vi.fn() } as unknown as PersonApi} mode="link" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link this device' }));
    });
    expect(linkClaim).toHaveBeenCalledWith('synthetic-link_code-01', 'Mac');
  });
});
