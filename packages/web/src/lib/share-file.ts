/**
 * A file the phone hands over (v0.5's meeting export; 0.13.0 Work's CSV
 * too): the share sheet when it can take a file, else a download from an
 * object URL revoked a moment after the click. Nothing is kept. Only lazy
 * screens import this (Meetings, Work's clients).
 */

/** What the browser offers: the share sheet, and a way to save a file. Tests pass their own. */
export interface ExportEnv {
  canShare?: ((data: ShareData) => boolean) | undefined;
  share?: ((data: ShareData) => Promise<void>) | undefined;
  /** Saves `file` through a link to it. */
  download: (file: File) => void;
}

const REVOKE_AFTER_MS = 1_000;

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    // A moment after the click: Safari can drop a download whose URL went away at once.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

export function browserExportEnv(): ExportEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    canShare: typeof nav?.canShare === 'function' ? (data) => nav.canShare(data) : undefined,
    share: typeof nav?.share === 'function' ? (data) => nav.share(data) : undefined,
    download: downloadFile,
  };
}

/**
 * Hands `file` to the share sheet, or downloads it. 'cancelled' when the
 * person closed the share sheet; a share the browser refuses for any other
 * reason falls back to the download.
 */
export async function shareFile(file: File, env: ExportEnv = browserExportEnv()): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const data: ShareData = { files: [file] };
  if (env.share && env.canShare?.(data)) {
    try {
      await env.share(data);
      return 'shared';
    } catch (e) {
      if ((e as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  env.download(file);
  return 'downloaded';
}
