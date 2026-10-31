/**
 * Files from the phone (v0.4.2, spec 6.4): one folder per session under
 * paths.uploadsDir, `<sid>/<id>.<ext>` (dirs 0700, files 0600, written with
 * `wx`), the type and the extension taken from the bytes (sniff.ts; HEIC
 * refused), one store-wide quota (UPLOADS_TOTAL_MAX_BYTES, counted afresh on
 * each save, the count and the write one save at a time, so two saves in
 * flight can't both pass it), and a sweep of files older than UPLOAD_KEEP_MS
 * that never follows a link (sweep.ts). Built by the API's services
 * (ApiServices.uploads).
 *
 * The client names nothing on disk: the session id must be session-shaped
 * and a live session, the file name is a fresh ULID, and the uploads folder
 * and the session's folder must be real directories, not links. Replies
 * carry the id, the kind and the size; only `resolve` gives a path, to
 * compose the prompt. Never logs a file name, a label, a path or a byte.
 */
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { UPLOADS_TOTAL_MAX_BYTES, UploadIdSchema, type AttachmentRef, type UploadInfo } from '@jantar/protocol';
import type { DaemonContext, UploadErrorCode, UploadResult, UploadStore as Store, ResolvedUpload } from '../contracts.js';
import { newId } from '../core/ids.js';
import { sniffUpload } from './sniff.js';
import { UPLOAD_NAME_RE, UPLOAD_SID_RE, realDir, sweepUploads, uploadsBytes } from './sweep.js';

export const NO_SESSION = 'no such session';
export const UPLOADS_FULL = "The Mac's upload space is full; remove some files or wait a week";
export const UPLOADS_LINKED = "The uploads folder on the Mac is a link; Jantar won't write through it";
export const NOT_STORED = "The Mac couldn't store this file";
export const NO_UPLOAD = 'That file is no longer on the Mac';
export const NOT_REMOVED = "The Mac couldn't remove this file";
export const ATTACHMENT_GONE = 'An attached file is no longer on the Mac; remove it and add it again';

function refusal(code: UploadErrorCode, reason: string): { ok: false; code: UploadErrorCode; reason: string } {
  return { ok: false, code, reason };
}

/** The errno code of a failed fs call, for a log line that names no path. */
function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | null)?.code ?? 'error';
}

/** Write `bytes` to a new file (never an existing one, never through a link), 0600; unlink it if the write fails. */
async function writeNew(path: string, bytes: Buffer): Promise<void> {
  const fh = await open(path, 'wx', 0o600);
  try {
    await fh.writeFile(bytes);
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw e;
  }
}

export class UploadStore implements Store {
  /** The saves, one at a time: each counts the folder and writes before the next counts. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(readonly ctx: DaemonContext) {}

  private get root(): string {
    return this.ctx.paths.uploadsDir;
  }

  /** A session-shaped id of a session the daemon knows and that has not ended. */
  private live(sid: string): boolean {
    if (!UPLOAD_SID_RE.test(sid)) return false;
    const sessions = this.ctx.store.getState().sessions;
    // An own key only: "constructor" must not find Object.prototype's.
    const session = Object.hasOwn(sessions, sid) ? sessions[sid] : undefined;
    return session !== undefined && session.status !== 'ended';
  }

  /**
   * The session's folder, made 0700 (and the uploads folder above it), or
   * null when either is a link or not a directory. mkdir keeps an existing
   * dir's mode, hence the chmod; the lstat comes first, as chmod follows a
   * link.
   */
  private async sessionDir(sid: string): Promise<string | null> {
    const dir = join(this.root, sid);
    for (const d of [this.root, dir]) {
      await mkdir(d, { recursive: true, mode: 0o700 });
      if (!(await realDir(d))) return null;
      await chmod(d, 0o700);
    }
    return dir;
  }

  async save(sid: string, bytes: Buffer, opts: { ext?: string }): Promise<UploadResult<{ upload: UploadInfo }>> {
    if (!this.live(sid)) return refusal('not_found', NO_SESSION);
    const sniffed = sniffUpload(bytes, opts.ext);
    if (!sniffed.ok) return sniffed;
    const run = this.saving.then(() => this.store(sid, bytes, sniffed));
    this.saving = run.catch(() => undefined);
    return run;
  }

  /** The quota and the write, under `saving`. */
  private async store(sid: string, bytes: Buffer, sniffed: { kind: UploadInfo['kind']; ext: string }): Promise<UploadResult<{ upload: UploadInfo }>> {
    try {
      if ((await uploadsBytes(this.root)) + bytes.length > UPLOADS_TOTAL_MAX_BYTES) return refusal('refused', UPLOADS_FULL);
      const id = newId().toLowerCase();
      // Twice at most: the sweep removes an empty session folder, and it may do so between the mkdir and the write.
      for (let attempt = 1; ; attempt += 1) {
        const dir = await this.sessionDir(sid);
        if (!dir) return refusal('refused', UPLOADS_LINKED);
        const path = join(dir, `${id}.${sniffed.ext}`);
        if (!path.startsWith(join(this.root, sid) + sep)) return refusal('refused', NOT_STORED);
        try {
          await writeNew(path, bytes);
          return { ok: true, upload: { id, kind: sniffed.kind, bytes: bytes.length } };
        } catch (e) {
          if (errCode(e) !== 'ENOENT' || attempt >= 2) throw e;
        }
      }
    } catch (e) {
      this.ctx.log.warn('upload not stored', { code: errCode(e) });
      return refusal('refused', NOT_STORED);
    }
  }

  /**
   * The stored file of upload `id` in this session's folder: the one regular
   * file named `<id>.<ext>` (never a link), or null. Both folders must be
   * real directories.
   */
  private async find(sid: string, id: string): Promise<string | null> {
    if (!UPLOAD_SID_RE.test(sid) || !UploadIdSchema.safeParse(id).success) return null;
    const dir = join(this.root, sid);
    if (!(await realDir(this.root)) || !(await realDir(dir))) return null;
    try {
      for (const name of await readdir(dir)) {
        if (!name.startsWith(`${id}.`) || !UPLOAD_NAME_RE.test(name)) continue;
        const path = join(dir, name);
        if ((await lstat(path)).isFile()) return path;
      }
    } catch {
      // Unreadable or gone: not there.
    }
    return null;
  }

  async remove(sid: string, id: string): Promise<UploadResult> {
    const path = await this.find(sid, id);
    if (!path) return refusal('not_found', NO_UPLOAD);
    try {
      await unlink(path);
      return { ok: true };
    } catch (e) {
      if (errCode(e) === 'ENOENT') return refusal('not_found', NO_UPLOAD);
      this.ctx.log.warn('upload not removed', { code: errCode(e) });
      return refusal('refused', NOT_REMOVED);
    }
  }

  async resolve(sid: string, refs: readonly AttachmentRef[]): Promise<UploadResult<{ files: ResolvedUpload[] }>> {
    const files: ResolvedUpload[] = [];
    for (const ref of refs) {
      const path = await this.find(sid, ref.upload);
      if (!path) return refusal('not_found', ATTACHMENT_GONE);
      files.push({ label: ref.label, path });
    }
    return { ok: true, files };
  }

  async sweep(): Promise<number> {
    return sweepUploads(this.root, this.ctx.clock.now());
  }
}
