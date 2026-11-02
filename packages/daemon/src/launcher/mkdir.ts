/**
 * The write facade for New folder (0.10.1): the only module through which a
 * phone can cause a file-system write in a user folder. `Folders.create`
 * makes every call through this object, so tests can spy on it and stage a
 * swap between two steps (as `sources/lib/fsx.ts` does for reads, which
 * exposes no write at all).
 *
 * What it can write is one empty directory (`mkdirOne`: never recursive,
 * mode 0755 at most, the umask still applies) and remove one empty
 * directory (`rmdir`: never recursive; the caller checks first that the path
 * still names the inode it made). The rest only reads.
 *
 * Node has no mkdirat/unlinkat, so a directory fd cannot anchor the write;
 * the caller checks identities (dev, ino) and realpaths around it instead
 * (folders.ts, steps 6 to 13).
 */
import { constants as fsConstants, type BigIntStats, type Dir } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rmdir, type FileHandle } from 'node:fs/promises';

/** The mode a new folder asks for; the process umask can only narrow it. */
export const NEW_FOLDER_MODE = 0o755;

export const dirx = {
  /** One `mkdir(2)`, never recursive: EEXIST when anything (even a dangling link) has that name. */
  async mkdirOne(path: string): Promise<void> {
    await mkdir(path, { mode: NEW_FOLDER_MODE });
  },
  /** Open a directory without following a final symlink (ELOOP) and only if it is one (ENOTDIR). The caller closes it. */
  openDirNoFollow(path: string): Promise<FileHandle> {
    return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  },
  /** stat of the link itself, with exact (bigint) dev and ino. */
  lstat(path: string): Promise<BigIntStats> {
    return lstat(path, { bigint: true });
  },
  realpath(path: string): Promise<string> {
    return realpath(path);
  },
  /** A directory read entry by entry; the caller closes it. */
  opendir(path: string): Promise<Dir> {
    return opendir(path, { bufferSize: 128 });
  },
  /** Remove one empty directory (ENOTEMPTY otherwise); never recursive. */
  rmdir(path: string): Promise<void> {
    return rmdir(path);
  },
};
