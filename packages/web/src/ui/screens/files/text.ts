/**
 * A text file in 512 KiB windows (GET /v1/files/text): the first window on
 * open, then one more per "Load the next 512 KB", or every window up to a
 * cap for views that need the whole file (a notebook is one JSON value).
 * The daemon cuts each window at a line end, so the windows join as they are.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileText, FileTextWarning } from '@jantar/protocol';
import { useDeps } from '../../context.js';
import { useLoad } from './data.js';

const BOM = String.fromCharCode(0xfeff);
const NO_WINDOWS: FileText[] = [];

export interface FileTextState {
  /** Everything loaded so far, CRLF turned into LF. */
  text: string;
  /** The first window (size, eol, bom, language, mtime). */
  first: FileText | null;
  /** Offset of the next window, null once all of it is here. */
  next: number | null;
  /** Bytes of the file loaded so far. */
  loaded: number;
  warnings: ReadonlySet<FileTextWarning>;
  error: unknown;
  loading: boolean;
  /** The last "load the next window" failure. */
  moreError: unknown;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * The text of `root`/`path`; `all` keeps loading windows up to `maxBytes`.
 * `enabled: false` loads nothing (the viewer calls this before it knows
 * the file's kind).
 */
export function useFileText(root: string, path: string, opts: { all?: boolean; maxBytes?: number; enabled?: boolean } = {}): FileTextState {
  const { api } = useDeps();
  const key = `text:${root}\u0000${path}`;
  const first = useLoad(opts.enabled === false ? null : key, () => api.filesText({ root, path }));
  const [more, setMore] = useState<{ key: string; windows: FileText[] }>({ key, windows: NO_WINDOWS });
  const [moreError, setMoreError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);

  // A different file, or a file that changed on the Mac, starts the extra windows over. A
  // refresh with the same mtime and size (back from offline) keeps them: the offsets still hold.
  const windows = more.key === key ? more.windows : NO_WINDOWS;
  const version = first.data ? `${first.data.mtime}\u0000${first.data.size}` : null;
  useEffect(() => {
    setMore({ key, windows: NO_WINDOWS });
    setMoreError(null);
  }, [key, version]);

  const last = windows.length ? windows[windows.length - 1]! : first.data;
  const next = last ? last.next : null;
  // The next window starts where the loaded bytes end.
  const loaded = next ?? first.data?.size ?? 0;

  const loadMore = useCallback(() => {
    if (next === null || busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    setMoreError(null);
    api
      .filesText({ root, path, offset: next })
      .then(
        (w) => setMore((m) => (m.key === key ? { key, windows: [...m.windows, w] } : m)),
        (e: unknown) => setMoreError(e),
      )
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }, [api, root, path, key, next]);

  const cap = opts.maxBytes ?? Infinity;
  const auto = Boolean(opts.all) && next !== null && loaded < cap && !moreError;
  useEffect(() => {
    if (auto && !busy.current) loadMore();
  }, [auto, loadMore]);

  const firstData = first.data;
  const text = useMemo(() => {
    let raw = firstData ? firstData.text + windows.map((w) => w.text).join('') : '';
    // The byte-order mark is the file's encoding, not its text.
    if (firstData?.bom && raw.startsWith(BOM)) raw = raw.slice(1);
    return raw.includes('\r\n') ? raw.replace(/\r\n/g, '\n') : raw;
  }, [firstData, windows]);
  const warnings = useMemo(() => new Set<FileTextWarning>([...(firstData?.warnings ?? []), ...windows.flatMap((w) => w.warnings)]), [firstData, windows]);
  return {
    text,
    first: first.data,
    next,
    loaded,
    warnings,
    error: first.error,
    loading: first.loading,
    moreError,
    loadingMore,
    loadMore,
    reload: first.reload,
  };
}
