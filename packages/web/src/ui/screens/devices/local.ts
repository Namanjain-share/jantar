/**
 * What this browser knows about itself: the name and scopes it was paired
 * with (written by the pair flow), and a best guess at what it is from the
 * user agent. Per-device conveniences only, read through lib/storage.ts.
 */
import type { Scope } from '@jantar/protocol';
import { readLocal } from '../../../lib/storage.js';

/** What this browser learned about itself when it paired. */
export interface LocalDevice {
  id: string;
  name: string;
  scopes: Scope[];
}
export const LOCAL_DEVICE_KEY = 'device';

export function readLocalDevice(): LocalDevice | null {
  return readLocal<LocalDevice | null>(LOCAL_DEVICE_KEY, null);
}

export function userAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : '';
}

function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/** A default name for this device: "iPhone", "Android phone", "Mac (Chrome)". */
export function guessDeviceName(ua: string): string {
  const browser = browserOf(ua);
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return `Mac (${browser})`;
  if (/Windows/.test(ua)) return `Windows (${browser})`;
  if (/Linux/.test(ua)) return `Linux (${browser})`;
  return browser;
}

/** "phone", "tablet" or "browser", for "Pair this phone". */
export function deviceNoun(ua: string): 'phone' | 'tablet' | 'browser' {
  if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))) return 'phone';
  if (/iPad|Android/.test(ua)) return 'tablet';
  return 'browser';
}

/**
 * The second line of a paired device: "Safari · iOS 26.1", "Chrome · macOS",
 * "Chrome · Android 15". Empty when the daemon kept no user agent.
 */
export function describeAgent(ua: string | undefined): string {
  if (!ua) return '';
  const browser = browserOf(ua);
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/.exec(ua);
  if (ios) return `${browser} · ${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${ios[1]}.${ios[2]}`;
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) return `${browser} · Android ${android[1]}`;
  if (/Macintosh|Mac OS X/.test(ua)) return `${browser} · macOS`;
  if (/Windows/.test(ua)) return `${browser} · Windows`;
  if (/CrOS/.test(ua)) return `${browser} · ChromeOS`;
  if (/Linux/.test(ua)) return `${browser} · Linux`;
  return browser;
}
