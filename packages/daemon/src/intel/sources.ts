/**
 * The shelf's sources (v0.4 spec 4.9): `captures` (the daemon's own
 * <intelDir>/captures.jsonl) plus each path in `intel.sources`, in settings
 * order. A source is named by an id taken from its file name, so no path
 * ever has to leave the Mac.
 *
 * `openSource` is the one refusal check: the daemon runs it on every poll
 * and `jantar intel` runs it (as `checkSource`) before it adds a path. A
 * source must be an absolute path that resolves to a regular `.jsonl` file
 * of at most 50 MB, and neither the given nor the real path may be
 * protected by the Files denylist. A refusal is one fixed sentence, never
 * the path or the file's contents. The captures file lives in the state
 * dir, which the denylist protects, so it never goes through this check.
 */
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { INTEL_SOURCE_MAX_BYTES } from '@jantar/protocol';
import { fsx } from '../sources/lib/fsx.js';

/** The id of the daemon's own captures file; a configured file with the same name gets `captures-2`. */
export const CAPTURES_SOURCE = 'captures';
export const CAPTURES_FILE = 'captures.jsonl';
/** Longest source id (before a `-2`, `-3` suffix, which still fits in it). */
export const SOURCE_ID_MAX = 32;

/** What `intelSources` says about a refused source (spec 4.9). */
export const SOURCE_REFUSED = {
  notJsonl: 'Not a .jsonl file',
  protected: 'Protected by the secrets list',
  tooLarge: 'Larger than 50 MB',
  unreadable: "Can't be read",
} as const;

export type SourceRefusal = (typeof SOURCE_REFUSED)[keyof typeof SOURCE_REFUSED];

export type SourceCheck = { ok: true; real: string; size: number } | { ok: false; error: SourceRefusal };

const JSONL = /\.jsonl$/i;

/** "Intel.jsonl" gives "intel", "My Bot.jsonl" gives "my-bot": lower case, anything outside a-z, 0-9 and "-" turned into "-", at most 32 characters. */
export function sourceIdOf(path: string): string {
  const name = basename(path).replace(JSONL, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, SOURCE_ID_MAX);
  return name === '' ? 'source' : name;
}

export interface SourceRef {
  id: string;
  /** As configured (absolute, unless config.json was edited by hand). */
  path: string;
}

/**
 * The configured paths with their ids, in settings order. `captures` is
 * taken first, so a clash gets `-2`, `-3`; a path listed twice is followed
 * once.
 */
export function sourceRefs(paths: readonly string[]): SourceRef[] {
  const taken = new Set<string>([CAPTURES_SOURCE]);
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const base = sourceIdOf(path);
    let id = base;
    for (let n = 2; taken.has(id); n++) {
      const suffix = `-${n}`;
      id = `${base.slice(0, SOURCE_ID_MAX - suffix.length)}${suffix}`;
    }
    taken.add(id);
    out.push({ id, path });
  }
  return out;
}

export type OpenedSource = { ok: true; real: string; fh: FileHandle; st: BigIntStats } | { ok: false; error: SourceRefusal };

/**
 * Open `path` for reading if it may be followed: refused by name before
 * touching the disk, then by its realpath, then the real file is opened
 * read-only (O_NOFOLLOW) and checked through the handle, so what was checked
 * is what gets read. The caller closes `fh`.
 */
export async function openSource(path: string, isProtected: (abs: string) => boolean): Promise<OpenedSource> {
  if (!isAbsolute(path)) return { ok: false, error: SOURCE_REFUSED.unreadable };
  if (!JSONL.test(path)) return { ok: false, error: SOURCE_REFUSED.notJsonl };
  if (isProtected(path)) return { ok: false, error: SOURCE_REFUSED.protected };
  let real: string;
  try {
    real = await fsx.realpath(path);
  } catch {
    return { ok: false, error: SOURCE_REFUSED.unreadable };
  }
  if (isProtected(real)) return { ok: false, error: SOURCE_REFUSED.protected };
  if (!JSONL.test(real)) return { ok: false, error: SOURCE_REFUSED.notJsonl };
  let fh: FileHandle;
  try {
    fh = await fsx.openNoFollow(real);
  } catch {
    return { ok: false, error: SOURCE_REFUSED.unreadable };
  }
  let error: SourceRefusal = SOURCE_REFUSED.unreadable;
  try {
    const st = await fh.stat({ bigint: true });
    // A directory named like a source opens read-only; a FIFO never blocks (O_NONBLOCK).
    if (!st.isFile()) error = SOURCE_REFUSED.notJsonl;
    else if (st.size > BigInt(INTEL_SOURCE_MAX_BYTES)) error = SOURCE_REFUSED.tooLarge;
    else return { ok: true, real, fh, st };
  } catch {
    // unreadable
  }
  await fh.close().catch(() => undefined);
  return { ok: false, error };
}

/** The same check without keeping the file open (`jantar intel`, and tests). */
export async function checkSource(path: string, isProtected: (abs: string) => boolean): Promise<SourceCheck> {
  const opened = await openSource(path, isProtected);
  if (!opened.ok) return opened;
  await opened.fh.close().catch(() => undefined);
  return { ok: true, real: opened.real, size: Number(opened.st.size) };
}
