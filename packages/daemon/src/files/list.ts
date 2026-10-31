/**
 * One page of a directory listing (v0.3 spec 4.4.2). The policy has already
 * read the names (at most 10,000), left out protected entries (counted) and
 * dot entries (unless asked for), and sorted them: dirs first, then by name.
 * A page is at most `limit` (500) entries and 512 KiB of JSON; the cursor is
 * the last name of the page. Only the page's entries are lstat'd.
 */
import { FILES_LIST_LIMIT, type FileEntry, type FileListing } from '@jantar/protocol';
import { cursorIndex, type PathPolicy, type ScannedDir } from './policy.js';

/** A listing reply stays under this many bytes of JSON. */
export const LIST_REPLY_MAX = 512 * 1024;
/** Room kept for `next`: a 255-byte name grows at most sixfold in JSON (\u0001). */
const CURSOR_BYTES = 2048;

export async function listPage(
  policy: Pick<PathPolicy, 'describe'>,
  scan: ScannedDir,
  opts: { after?: string | undefined; limit: number; iso(ms: number): string },
): Promise<FileListing> {
  const limit = Math.max(1, Math.min(opts.limit, FILES_LIST_LIMIT));
  const start = cursorIndex(scan.items, opts.after);
  const page = scan.items.slice(start, start + limit);
  const described = await policy.describe(scan, page);
  const entries: FileEntry[] = [];
  const envelope = { root: scan.root.id, path: scan.rel, entries, next: null, hiddenProtected: 0, truncated: scan.truncated };
  let bytes = Buffer.byteLength(JSON.stringify(envelope)) + CURSOR_BYTES;
  let cutAfter: string | null = null;
  for (const d of described.entries) {
    const e: FileEntry = { name: d.name, type: d.type };
    if (d.size !== undefined) e.size = d.size;
    if (d.mtimeMs !== undefined) e.mtime = opts.iso(d.mtimeMs);
    if (d.link) e.link = d.link;
    const n = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (bytes + n > LIST_REPLY_MAX && entries.length > 0) {
      cutAfter = (entries[entries.length - 1] as FileEntry).name;
      break;
    }
    bytes += n;
    entries.push(e);
  }
  const more = start + page.length < scan.items.length;
  const last = page[page.length - 1];
  return {
    root: scan.root.id,
    path: scan.rel,
    entries,
    next: cutAfter ?? (more && last ? last.name : null),
    hiddenProtected: scan.hiddenProtected + described.hiddenProtected,
    truncated: scan.truncated,
  };
}
