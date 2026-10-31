/**
 * The uploads folder on disk (v0.4.2, spec 6.4): `<uploadsDir>/<sid>/<id>.<ext>`.
 * One walk serves the store-wide quota and the sweep. It looks only at real
 * directories with a session-shaped name and at regular files with an
 * upload-shaped name; a link is never followed, a stranger name is left
 * alone, and a missing or linked uploads folder holds nothing.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { UPLOAD_KEEP_MS } from '@jantar/protocol';

/** A session folder's name: the session id as the store checks it. */
export const UPLOAD_SID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** A stored file's name: a lowercase ULID and the extension the bytes gave. */
export const UPLOAD_NAME_RE = /^[0-9a-hjkmnp-tv-z]{26}\.[a-z0-9]{1,8}$/;

/** True for a directory that is not a link (lstat); false when it is missing or anything else. */
export async function realDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface UploadFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** The session folders under `root` and the upload files in them. */
export async function listUploads(root: string): Promise<{ dirs: string[]; files: UploadFile[] }> {
  const out: { dirs: string[]; files: UploadFile[] } = { dirs: [], files: [] };
  if (!(await realDir(root))) return out;
  let sids: Dirent[];
  try {
    sids = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of sids) {
    // A Dirent describes the entry itself: a link to a directory is not isDirectory().
    if (!d.isDirectory() || !UPLOAD_SID_RE.test(d.name)) continue;
    const dir = join(root, d.name);
    out.dirs.push(dir);
    let names: Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.isFile() || !UPLOAD_NAME_RE.test(f.name)) continue;
      const path = join(dir, f.name);
      try {
        const st = await lstat(path);
        if (st.isFile()) out.files.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Gone since the readdir.
      }
    }
  }
  return out;
}

/** Bytes of every upload under `root`, counted afresh (no running total to drift). */
export async function uploadsBytes(root: string): Promise<number> {
  const { files } = await listUploads(root);
  return files.reduce((sum, f) => sum + f.size, 0);
}

/**
 * Unlink every upload last written more than `keepMs` before `now`, then
 * remove the session folders left empty (rmdir refuses one that is not).
 * Returns how many files went. A file that can't be removed is skipped.
 */
export async function sweepUploads(root: string, now: number, keepMs = UPLOAD_KEEP_MS): Promise<number> {
  const { dirs, files } = await listUploads(root);
  let removed = 0;
  for (const f of files) {
    if (now - f.mtimeMs <= keepMs) continue;
    try {
      // unlink removes a link itself, never its target, should the file have become one since the lstat.
      await unlink(f.path);
      removed += 1;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  for (const dir of dirs) await rmdir(dir).catch(() => undefined);
  return removed;
}
