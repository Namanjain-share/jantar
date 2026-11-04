/**
 * 0.12.2: the name a device of hers joins or links with (her list and his
 * show it), from its browser's user agent. Before, anything that wasn't an
 * iPhone or iPad was "Phone", so the laptop she links through Me › Devices
 * showed as "Phone". iPadOS Safari sends a Mac's user agent: a "Mac" with
 * touch is an iPad. Anything else is still "Phone".
 */
export function deviceNameOf(ua: string, touchPoints: number): string {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Phone';
}

/** This browser's name for itself, as deviceNameOf gives it. */
export function thisDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Phone';
  return deviceNameOf(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
}
