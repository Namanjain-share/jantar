/**
 * One-line notices under the top bar / phone header, on --surface. Offline
 * (current copy kept) and, on phones where there is no status bar, the
 * update line.
 */
export function OfflineNotice() {
  return (
    <p role="alert" className="flex-none border-b border-line bg-surface px-16 py-6 type-small text-ink-2">
      Can't reach the Mac. Showing what was last known; retrying.
    </p>
  );
}

export function UpdateNotice() {
  return (
    <p role="status" className="flex flex-none items-center gap-8 border-b border-line bg-surface px-16 py-6 type-small text-ink-2">
      New version ready
      <button type="button" className="text-ink underline underline-offset-3" onClick={() => window.location.reload()}>
        Reload
      </button>
    </p>
  );
}
