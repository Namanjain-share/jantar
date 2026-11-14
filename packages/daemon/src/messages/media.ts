/**
 * A message's file for the phone, the CLI and `jantar mcp` (0.15). The
 * reader copies it into its spool (<messagesDir>/spool, 0600) and names the
 * copy; this turns the copy into the answer and deletes it:
 *
 * - an image (or a sticker) is shrunk to MESSAGES_LIMITS.imageEdge and
 *   re-encoded as a JPEG with no metadata by jantar-media, Intel's sandboxed
 *   helper (intel/read/media.ts), in a job dir of its own under
 *   <messagesDir>/jobs that goes when it ends;
 * - anything else (a document, a video, a voice note) is told by name, size
 *   and kind only: its bytes never leave the Mac.
 *
 * A path the reader names outside its spool is refused and never touched.
 * Each failure carries a MESSAGES_SAYS sentence as its detail (the route
 * shows it); a job a crash left is removed at start (clearJobs).
 */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { MESSAGES_LIMITS } from '@jantar/protocol';
import type { MessageKind } from '@jantar/protocol/messages';
import type { MessagesMediaAnswer } from '../contracts.js';
import { ensureDir } from '../intel/read/files.js';
import { magicOf } from '../intel/read/guard.js';
import type { MediaHelper } from '../intel/read/media.js';
import { ReaderFailure } from './reader-client.js';
import type { ReaderMedia } from './reader-protocol.js';
import { MESSAGES_SAYS } from './says.js';

/** What shrinks an image: Intel's jantar-media (tests stub it). */
export type ImageShrinker = Pick<MediaHelper, 'ensure' | 'image'>;

/** The kinds answered as an image. */
const IMAGE_KINDS: ReadonlySet<MessageKind> = new Set(['image', 'sticker']);
/** The reader's spool names: 32 hex digits and a short lowercase extension. */
const SPOOL_NAME = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;
/** A shrunk image is far smaller; anything bigger is not jantar-media's. */
const JPEG_MAX_BYTES = 8 * 1024 * 1024;

export const spoolDirOf = (messagesDir: string) => join(messagesDir, 'spool');
export const jobsDirOf = (messagesDir: string) => join(messagesDir, 'jobs');

/** Every job left in <messagesDir>/jobs (a crash between the move and the rm keeps a full-size image there). */
export async function clearJobs(messagesDir: string): Promise<void> {
  const jobs = jobsDirOf(messagesDir);
  const st = await lstat(jobs).catch(() => null);
  if (!st?.isDirectory()) return;
  for (const name of await readdir(jobs).catch(() => [])) await rm(join(jobs, name), { recursive: true, force: true }).catch(() => undefined);
}

/** Whether `file` is a regular file directly in the reader's spool, by its real folder. */
async function inSpool(file: string, messagesDir: string): Promise<boolean> {
  if (!SPOOL_NAME.test(basename(file))) return false;
  try {
    const [dir, spool] = await Promise.all([realpath(dirname(file)), realpath(spoolDirOf(messagesDir))]);
    return dir === spool && (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** The JPEG at `file` (no symlink, at most JPEG_MAX_BYTES, JPEG bytes), or null. */
async function readJpeg(file: string): Promise<Buffer | null> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > JPEG_MAX_BYTES) return null;
    const b = await fh.readFile();
    return magicOf(b) === 'jpeg' ? b : null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function shrink(spooled: string, messagesDir: string, shrinker: ImageShrinker): Promise<Buffer> {
  if (!(await shrinker.ensure())) throw new ReaderFailure('busy', MESSAGES_SAYS.noImage);
  const jobs = jobsDirOf(messagesDir);
  if (!(await ensureDir(messagesDir)) || !(await ensureDir(jobs))) throw new ReaderFailure('busy', MESSAGES_SAYS.imageJob);
  const job = await mkdtemp(join(jobs, 'img-'));
  try {
    // Moved, not copied: the spool copy is gone at once (both folders are the reader's state dir).
    const input = join(job, `in${extname(spooled)}`);
    await rename(spooled, input).catch(() => copyFile(spooled, input));
    const output = join(job, 'out.jpg');
    const r = await shrinker.image(job, input, output, MESSAGES_LIMITS.imageEdge);
    const jpeg = r.ok ? await readJpeg(output) : null;
    if (!jpeg) throw new ReaderFailure('busy', MESSAGES_SAYS.noImage);
    return jpeg;
  } finally {
    await rm(job, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The answer for the reader's spool copy `got`; the copy is deleted whatever happens. */
export async function mediaAnswer(got: ReaderMedia, o: { messagesDir: string; shrinker: ImageShrinker }): Promise<MessagesMediaAnswer> {
  if (!(await inSpool(got.file, o.messagesDir))) throw new ReaderFailure('unsupported', MESSAGES_SAYS.notInSpool);
  try {
    if (IMAGE_KINDS.has(got.kind)) return { jpeg: await shrink(got.file, o.messagesDir, o.shrinker) };
    return { document: { ...(got.fileName ? { fileName: got.fileName } : {}), bytes: got.bytes, kind: got.kind } };
  } catch (e) {
    // A file system error carries a path: only the fixed sentence goes on.
    throw e instanceof ReaderFailure ? e : new ReaderFailure('busy', MESSAGES_SAYS.imageJob);
  } finally {
    await unlink(got.file).catch(() => undefined);
  }
}
