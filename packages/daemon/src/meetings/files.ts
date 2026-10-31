/**
 * Screenshot files (spec 4.7, 4.8): <meetingsDir>/<meeting id>/<shot id>.jpg,
 * every part an id the daemon made, so no client-chosen path exists.
 *
 * - Writing: <meetingsDir> and the meeting's folder are made 0700 when
 *   missing, and each must then be a real directory by lstat (a symlink or
 *   anything else refuses, and nothing is written through it); one found
 *   open to group or others is closed to them. The file goes
 *   through writeFileAtomic at 0600: its temp file is opened 'wx' and renamed
 *   over the target, so a symlink planted at the file's name is replaced,
 *   never followed.
 * - Reading: the same folder checks, then an O_NOFOLLOW | O_NONBLOCK open
 *   and fstat through the handle: a regular file of at most
 *   MEETING_SHOT_MAX_BYTES, else nothing is served.
 * - Removing: a meeting's folder is removed with what is in it; a symlink at
 *   its name is unlinked, never followed; nothing is removed while
 *   <meetingsDir> itself is not a real directory.
 * - The sweep sees only folders named by a ulid; nothing else in
 *   <meetingsDir> is ever touched.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { LifeIdSchema, MEETING_SHOT_MAX_BYTES } from '@jantar/protocol';
import { writeFileAtomic } from '../config.js';
import { readRange } from '../sources/lib/fsx.js';

export const MEETING_DIR_MODE = 0o700;
export const SHOT_FILE_MODE = 0o600;

/** Read only; a symlink fails the open (ELOOP); a FIFO never blocks it. */
const SHOT_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Errors that mean "nothing here to serve" rather than a broken disk. */
const NOT_SERVED: ReadonlySet<string> = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'ENXIO', 'EISDIR']);

function errCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function meetingDir(meetingsDir: string, meetingId: string): string {
  return join(meetingsDir, meetingId);
}

export function shotPath(meetingsDir: string, meetingId: string, shotId: string): string {
  return join(meetingsDir, meetingId, `${shotId}.jpg`);
}

/** lstat says a directory (a symlink to one is not). */
async function realDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Make `path` 0700 when missing; then it must be a real directory. One that
 * was there already loses any group or other access (MF2); its owner bits
 * stay as they are, so this never opens anything up.
 */
async function ensureDir(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: MEETING_DIR_MODE });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  const st = await lstat(path).catch(() => null);
  if (!st?.isDirectory()) return false;
  if ((st.mode & 0o077) !== 0) await chmod(path, st.mode & MEETING_DIR_MODE);
  return true;
}

/**
 * The meeting's screenshot folder, made (with <meetingsDir>) when missing;
 * null when either is anything but a real directory.
 */
export async function shotDir(meetingsDir: string, meetingId: string): Promise<string | null> {
  if (!(await ensureDir(meetingsDir))) return null;
  const dir = meetingDir(meetingsDir, meetingId);
  return (await ensureDir(dir)) ? dir : null;
}

/** Write the JPEG at 0600 in `dir` (from shotDir); answers the file's path. */
export async function writeShot(dir: string, shotId: string, bytes: Uint8Array): Promise<string> {
  const path = join(dir, `${shotId}.jpg`);
  await writeFileAtomic(path, bytes, { mode: SHOT_FILE_MODE });
  return path;
}

/** Remove a file written for a screenshot that was not kept (a missing one is fine). */
export async function dropShot(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * A screenshot's bytes, or null when there is nothing to serve: missing, a
 * symlink, not a regular file, larger than MEETING_SHOT_MAX_BYTES, or a
 * folder on the way that is not a real directory. Other errors throw.
 */
export async function readShot(meetingsDir: string, meetingId: string, shotId: string): Promise<Buffer | null> {
  if (!(await realDir(meetingsDir)) || !(await realDir(meetingDir(meetingsDir, meetingId)))) return null;
  let fh: FileHandle;
  try {
    fh = await open(shotPath(meetingsDir, meetingId, shotId), SHOT_READ_FLAGS);
  } catch (e) {
    if (NOT_SERVED.has(errCode(e) ?? '')) return null;
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MEETING_SHOT_MAX_BYTES) return null;
    return await readRange(fh, 0, st.size);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Remove a meeting's folder with what is in it (a symlink at its name is
 * unlinked, its target untouched). True when nothing is left at that name;
 * false when <meetingsDir> is not a real directory (nothing touched). Other
 * errors throw.
 */
export async function removeMeetingDir(meetingsDir: string, meetingId: string): Promise<boolean> {
  try {
    if (!(await lstat(meetingsDir)).isDirectory()) return false;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return true;
    throw e;
  }
  const dir = meetingDir(meetingsDir, meetingId);
  let isDir: boolean;
  try {
    isDir = (await lstat(dir)).isDirectory();
  } catch (e) {
    if (errCode(e) === 'ENOENT') return true;
    throw e;
  }
  if (isDir) await rm(dir, { recursive: true, force: true });
  else await unlink(dir);
  return true;
}

/** The real directories in <meetingsDir> named by a ulid (each a meeting's folder, or an orphan). */
export async function meetingDirNames(meetingsDir: string): Promise<string[]> {
  if (!(await realDir(meetingsDir))) return [];
  const entries = await readdir(meetingsDir, { withFileTypes: true });
  return entries.filter((d) => d.isDirectory() && LifeIdSchema.safeParse(d.name).success).map((d) => d.name);
}

/** An error's code or class name for a log line: never its message (it can carry a path). */
export function errorKind(e: unknown): string {
  return errCode(e) ?? (e instanceof Error ? e.name : 'unknown');
}
