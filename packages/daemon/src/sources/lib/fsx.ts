/**
 * Every file-system call the data sources make goes through this object.
 *
 * Two reasons:
 * - Safety: tests spy on it and assert that no source ever opens a
 *   credential, key or config file (cswap `configs/`, `credentials/`,
 *   `<pid>.<hash>.key`, ccw's `telegram.json`).
 * - The sources are read-only towards Claude, cswap and ccw. Only read
 *   operations are exposed here, so a write cannot slip in by accident.
 */
import { constants as fsConstants, existsSync, watch as fsWatch, type FSWatcher, type WatchListener } from 'node:fs';
import { lstat, open, opendir, readFile, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { Dir, Dirent, BigIntStats } from 'node:fs';
import { join } from 'node:path';

export interface FileSig {
  size: number;
  mtimeMs: number;
  /** size, mtime (ns) and inode: changes on every rewrite, even within one millisecond. */
  sig: string;
}

export const fsx = {
  readFile(path: string): Promise<Buffer> {
    return readFile(path);
  },
  readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  },
  readdir(path: string): Promise<Dirent[]> {
    return readdir(path, { withFileTypes: true });
  },
  stat(path: string): Promise<BigIntStats> {
    return stat(path, { bigint: true });
  },
  open(path: string): Promise<FileHandle> {
    return open(path, 'r');
  },
  realpath(path: string): Promise<string> {
    return realpath(path);
  },
  existsSync(path: string): boolean {
    return existsSync(path);
  },
  watch(path: string, listener: WatchListener<string>): FSWatcher {
    return fsWatch(path, { persistent: false }, listener);
  },
  /**
   * v0.3 (Files): open read-only without following a final symlink (ELOOP)
   * and without blocking on a FIFO. Callers read through the handle only.
   */
  openNoFollow(path: string): Promise<FileHandle> {
    return open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  },
  /** v0.3 (Files): a directory handle read entry by entry; the caller closes it. */
  opendir(path: string): Promise<Dir> {
    return opendir(path, { bufferSize: 128 });
  },
  /** v0.3 (Files): stat of the link itself, not of what it points at. */
  lstat(path: string): Promise<BigIntStats> {
    return lstat(path, { bigint: true });
  },
};

/** stat() as a small signature, or null when the path is missing or unreadable. */
export async function fileSig(path: string): Promise<FileSig | null> {
  try {
    const st = await fsx.stat(path);
    if (!st.isFile()) return null;
    return {
      size: Number(st.size),
      mtimeMs: Number(st.mtimeMs),
      sig: `${st.size}:${st.mtimeNs}:${st.ino}`,
    };
  } catch {
    return null;
  }
}

/** Directory entries (empty when the directory is missing or unreadable). */
export async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await fsx.readdir(path);
  } catch {
    return [];
  }
}

/** True for a directory, or a symlink that points at one. */
export async function isDirEntry(parent: string, d: Dirent): Promise<boolean> {
  if (d.isDirectory()) return true;
  if (!d.isSymbolicLink()) return false;
  try {
    return (await fsx.stat(join(parent, d.name))).isDirectory();
  } catch {
    return false;
  }
}

export type JsonRead =
  | { ok: true; value: unknown; sig: FileSig }
  | { ok: false; reason: 'missing' | 'invalid' | 'unreadable' };

/**
 * Read and parse a JSON file. A file caught mid-write (Claude and cswap
 * rewrite theirs in place) comes back as `invalid`; callers keep their last
 * good copy and try again on the next pass.
 */
export async function readJsonFile(path: string, maxBytes = 4 * 1024 * 1024): Promise<JsonRead> {
  const sig = await fileSig(path);
  if (!sig) return { ok: false, reason: 'missing' };
  if (sig.size > maxBytes) return { ok: false, reason: 'unreadable' };
  let text: string;
  try {
    text = await fsx.readText(path);
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, sig };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/** Read `length` bytes at `position` (fewer at end of file). */
export async function readRange(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(Math.max(0, length));
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}
