/**
 * Object URLs for bytes the viewer shows (img-src blob: in both CSPs): one
 * URL per Blob, revoked when the Blob changes or the view unmounts (spec 6,
 * W5), so no file bytes outlive the screen that asked for them.
 */
import { useEffect, useState } from 'react';

export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl({ blob, url: u });
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url && url.blob === blob ? url.url : null;
}

/** Base64 (a notebook's image output) to a Blob; null when it does not decode or is over `max` bytes. */
export function base64Blob(b64: string, type: string, max: number): Blob | null {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length * 0.75 > max) return null;
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}
