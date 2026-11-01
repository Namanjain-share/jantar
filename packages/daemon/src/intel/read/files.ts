/**
 * Intel's files on the Mac (spec 5.3, 7), every name the daemon's own:
 *
 *   <intelDir>/media/<rid>/<n>.jpg   an item's thumbnails (n = 0 is the cover when there is one)
 *   <intelDir>/media/<rid>.new/      a job's thumbnails before they replace the item's
 *   <intelDir>/jobs/<rid>/           a job's files while it runs (deleted at its end)
 *   <intelDir>/bin/                  the media helper (media.ts)
 *   <intelDir>/run/                  the Claude run's dir (an empty work/ cwd)
 *
 * As Meetings' shots (meetings/files.ts): 0700 folders proven real by
 * lstat (a symlink refuses), atomic 0600 writes, reads O_NOFOLLOW |
 * O_NONBLOCK with fstat, at most thumbBytes, JPEG magic checked before a
 * thumbnail is served. Only a record id that is a ulid ever names a folder.
 *
 * The sweep removes a thumbnail folder whose id is not live in
 * captures.jsonl (the store's index), only right after the store's pass
 * succeeded, never while Intel is off (the caller checks), and never a
 * folder changed in the last hour.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { INTEL_READ_LIMITS } from '@jantar/protocol';
import { writeFileAtomic } from '../../config.js';
import { readRange } from '../../sources/lib/fsx.js';

const DIR_MODE = 0o700;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A record id that may name a folder (a ulid: every id the daemon makes). */
export function ridOk(rid: string): boolean {
  return ULID.test(rid);
}

export interface IntelDirs {
  media: string;
  jobs: string;
  bin: string;
  run: string;
}

export function intelDirs(intelDir: string): IntelDirs {
  return { media: join(intelDir, 'media'), jobs: join(intelDir, 'jobs'), bin: join(intelDir, 'bin'), run: join(intelDir, 'run') };
}

function code(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

/** Make `path` 0700 when missing; it must then be a real directory (a symlink or a file refuses). */
export async function ensureDir(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true, mode: DIR_MODE });
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e;
  }
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory()) return false;
  if ((st.mode & 0o077) !== 0) await chmod(path, st.mode & DIR_MODE);
  return true;
}

async function realDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A fresh, empty job dir (0700) with its tmp/ (0700); a leftover one is removed first. Null when it can't be made. */
export async function freshJobDir(intelDir: string, rid: string): Promise<string | null> {
  if (!ridOk(rid)) return null;
  const { jobs } = intelDirs(intelDir);
  if (!(await ensureDir(intelDir)) || !(await ensureDir(jobs))) return null;
  const dir = join(jobs, rid);
  await rm(dir, { recursive: true, force: true });
  if (!(await ensureDir(dir)) || !(await ensureDir(join(dir, 'tmp')))) return null;
  return dir;
}

/** Remove a job dir (whatever the outcome). */
export async function dropJobDir(dir: string | null): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Every leftover job dir (the start: no job runs then). */
export async function clearJobs(intelDir: string): Promise<void> {
  const { jobs } = intelDirs(intelDir);
  if (!(await realDir(jobs))) return;
  for (const name of await readdir(jobs)) await rm(join(jobs, name), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Write an item's thumbnails (JPEG bytes, each already checked) as
 * media/<rid>.new/<n>.jpg, then put the folder in place of the item's old
 * one. Answers how many were kept (n is 0..count-1).
 */
export async function putThumbs(intelDir: string, rid: string, thumbs: readonly Buffer[]): Promise<number> {
  if (!ridOk(rid)) return 0;
  const { media } = intelDirs(intelDir);
  if (!(await ensureDir(media))) return 0;
  const fresh = join(media, `${rid}.new`);
  const dir = join(media, rid);
  const old = join(media, `${rid}.old`);
  await rm(fresh, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  if (thumbs.length === 0) {
    await removeThumbs(intelDir, rid);
    return 0;
  }
  if (!(await ensureDir(fresh))) return 0;
  let n = 0;
  for (const t of thumbs.slice(0, INTEL_READ_LIMITS.thumbsMax)) {
    await writeFileAtomic(join(fresh, `${n}.jpg`), t, { mode: 0o600 });
    n += 1;
  }
  const had = await lstat(dir).catch(() => null);
  if (had) await rename(dir, old);
  await rename(fresh, dir);
  await rm(old, { recursive: true, force: true });
  return n;
}

/** Remove an item's thumbnails (a symlink at its name is removed, never followed). */
export async function removeThumbs(intelDir: string, rid: string): Promise<void> {
  if (!ridOk(rid)) return;
  const { media } = intelDirs(intelDir);
  if (!(await realDir(media))) return;
  for (const name of [rid, `${rid}.new`, `${rid}.old`]) await rm(join(media, name), { recursive: true, force: true }).catch(() => undefined);
}

/** Thumbnail `n` of an item: a regular file of at most thumbBytes with the JPEG magic, else null. */
export async function readThumb(intelDir: string, rid: string, n: number): Promise<Buffer | null> {
  if (!ridOk(rid) || !Number.isInteger(n) || n < 0 || n >= INTEL_READ_LIMITS.thumbsMax) return null;
  const { media } = intelDirs(intelDir);
  if (!(await realDir(media)) || !(await realDir(join(media, rid)))) return null;
  let fh: FileHandle;
  try {
    fh = await open(join(media, rid, `${n}.jpg`), READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size < 3 || st.size > INTEL_READ_LIMITS.thumbBytes) return null;
    const b = await readRange(fh, 0, st.size);
    return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? b : null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Bytes of every thumbnail folder together (the 1 GiB cap). */
export async function mediaBytes(intelDir: string): Promise<number> {
  const { media } = intelDirs(intelDir);
  if (!(await realDir(media))) return 0;
  let total = 0;
  for (const d of await readdir(media, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(media, d.name), { withFileTypes: true }).catch(() => [])) {
      if (f.isFile()) total += (await stat(join(media, d.name, f.name)).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/**
 * Remove the thumbnail folders of ids not in `live` that have not changed
 * for `quietMs`. The caller runs it only right after the store's pass
 * succeeded and while Intel is on. Answers how many went.
 */
export async function sweepThumbs(intelDir: string, live: ReadonlySet<string>, nowMs: number, quietMs: number = INTEL_READ_LIMITS.mediaSweepQuietMs): Promise<number> {
  const { media } = intelDirs(intelDir);
  if (!(await realDir(media))) return 0;
  let n = 0;
  for (const d of await readdir(media, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const rid = d.name.replace(/\.(new|old)$/, '');
    if (!ridOk(rid) || live.has(rid)) continue;
    const st = await lstat(join(media, d.name)).catch(() => null);
    if (!st || nowMs - st.mtimeMs < quietMs) continue;
    await rm(join(media, d.name), { recursive: true, force: true }).catch(() => undefined);
    n += 1;
  }
  return n;
}
