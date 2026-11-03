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

/** This browser's touch points: a Mac has none, an iPad five. */
export function touchPoints(): number {
  return typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0;
}

/**
 * An iPad (0.11 c31, D11): an older one says iPad; iPadOS 13 and later ask for the desktop site and say
 * Macintosh, and only their touch points tell them apart (a Mac has none).
 */
export function isIPad(ua: string, points = touchPoints()): boolean {
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && points > 1);
}

function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/** A default name for this device: "iPhone", "iPad (Safari)", "Android phone", "Mac (Chrome)". */
export function guessDeviceName(ua: string, points = touchPoints()): string {
  const browser = browserOf(ua);
  if (/iPhone/.test(ua)) return 'iPhone';
  if (isIPad(ua, points)) return `iPad (${browser})`;
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return `Mac (${browser})`;
  if (/Windows/.test(ua)) return `Windows (${browser})`;
  if (/Linux/.test(ua)) return `Linux (${browser})`;
  return browser;
}

/** "phone", "iPad", "tablet" or "browser", for "Pair this iPad". */
export function deviceNoun(ua: string, points = touchPoints()): 'phone' | 'iPad' | 'tablet' | 'browser' {
  if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))) return 'phone';
  if (isIPad(ua, points)) return 'iPad';
  if (/Android/.test(ua)) return 'tablet';
  return 'browser';
}

/**
 * The second line of a paired device: "Safari · iOS 26.1", "Chrome · macOS",
 * "Chrome · Android 15". Empty when the daemon kept no user agent. An iPad
 * that says Macintosh is told apart by this browser's touch points (this
 * device), or by the name it paired with ("iPad (Safari)", D11): "Safari ·
 * iPadOS".
 */
export function describeAgent(ua: string | undefined, hint: { touchPoints?: number; name?: string } = {}): string {
  if (!ua) return '';
  const browser = browserOf(ua);
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/.exec(ua);
  if (ios) return `${browser} · ${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${ios[1]}.${ios[2]}`;
  if (/Macintosh/.test(ua) && ((hint.touchPoints ?? 0) > 1 || /^iPad\b/.test(hint.name ?? ''))) return `${browser} · iPadOS`;
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) return `${browser} · Android ${android[1]}`;
  if (/Macintosh|Mac OS X/.test(ua)) return `${browser} · macOS`;
  if (/Windows/.test(ua)) return `${browser} · Windows`;
  if (/CrOS/.test(ua)) return `${browser} · ChromeOS`;
  if (/Linux/.test(ua)) return `${browser} · Linux`;
  return browser;
}
