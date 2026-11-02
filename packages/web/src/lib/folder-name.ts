/**
 * New folder's name, shared by the start sheet's browser (new/NewFolder)
 * and Files (files/NewFolderSheet), both lazy chunks: nothing the main entry
 * reaches imports this (code-split.test).
 *
 * The rule is the daemon's own FolderNameSchema (ASCII on purpose, 0.10.1
 * D5). Names are compared folded the way the daemon folds them (normSeg:
 * NFC, lower, NFKC, upper, lower), so "project" meets "Project" and "keys"
 * meets "Keys" with a KELVIN SIGN. The checks here only spare a request:
 * the daemon decides in the end.
 */
import { FolderNameSchema } from '@jantar/protocol';
import { errorText, isApiError } from './api.js';
import { newIdempotencyKey } from './ids.js';

export const folderNameOk = (n: string): boolean => FolderNameSchema.safeParse(n).success;

export const FOLDER_NAME_HINT =
  "Use A–Z letters, digits, spaces, dots, dashes and underscores, up to 60 characters. Start with a letter or digit; it can't end in a space or a dot.";

/** The name a new folder starts with. */
export const NEW_FOLDER_NAME = 'new-project';

/** How many numbered names `freeFolderName` tries ("-2" up to "-99"). */
const NUMBERED_MAX = 99;

/** One name segment folded as the daemon's denylist and sibling check fold it. */
export function foldName(s: string): string {
  return s.normalize('NFC').toLowerCase().normalize('NFKC').toUpperCase().toLowerCase();
}

/** `base` if no entry folds onto it, else `base-2` ... `base-99`; `base` again when all are taken. */
export function freeFolderName(taken: Iterable<string>, base = NEW_FOLDER_NAME): string {
  const used = new Set<string>();
  for (const t of taken) used.add(foldName(t));
  if (!used.has(foldName(base))) return base;
  for (let i = 2; i <= NUMBERED_MAX; i += 1) {
    const next = `${base}-${i}`;
    if (!used.has(foldName(next))) return next;
  }
  return base;
}

export type ClashKind = 'dir' | 'file' | 'link' | 'other';

/** A listed clash in the daemon's 409 words ("A folder named Project already exists here."). */
export function takenText(c: { name: string; type: ClashKind }): string {
  const what = c.type === 'dir' ? 'A folder' : c.type === 'file' ? 'A file' : 'Something';
  return `${what} named ${c.name} already exists here.`;
}

/** The loaded entry whose name folds onto `name`, or null. */
export function clashIn(entries: Iterable<{ name: string; type: string }>, name: string): { name: string; type: ClashKind } | null {
  if (!name) return null;
  const want = foldName(name);
  for (const e of entries) {
    if (foldName(e.name) !== want) continue;
    const type: ClashKind = e.type === 'dir' || e.type === 'file' || e.type === 'link' ? e.type : 'other';
    return { name: e.name, type };
  }
  return null;
}

/** What one create is, for keepKey: the root, the parent and the trimmed name (the request body). */
export function createSig(root: string, parent: string, name: string): string {
  return `${root}\u0000${parent}\u0000${name}`;
}

type KeyRef = { current: { sig: string; key: string } | null };

/**
 * The Idempotency-Key for creating `sig` (createSig): the same folder
 * reuses the key, so a retry after a lost 201 is replayed instead of
 * answering "already exists"; another name or place gets a new one (the
 * daemon refuses one key with two bodies). The caller sets
 * `ref.current = null` after a success, and calls dropAnsweredKey after a
 * failure.
 */
export function keepKey(ref: KeyRef, sig: string): string {
  if (!ref.current || ref.current.sig !== sig) ref.current = { sig, key: newIdempotencyKey() };
  return ref.current.key;
}

/**
 * After a failed create: the key is kept only when the Mac never answered
 * (a network failure, so the 201 may be the thing lost). Any answer, a
 * refusal included, is kept by the daemon for 24 hours under that key, so
 * reusing it would bring back the old 403, 409 or 429 after access was
 * granted, the clash removed or the hour gone (the start sheet's own rule).
 */
export function dropAnsweredKey(ref: KeyRef, e: unknown): void {
  if (!isApiError(e, 'network')) ref.current = null;
}

/**
 * A failed create in words: the daemon's own sentence where it has one (a
 * 429 included, which says how long to wait). Its 409 and 429 sentences
 * get the full stop the sheet's own clash sentence has; others are left as
 * sent, since some end in a command to type ("jantar launch on").
 */
export function folderErrorText(e: unknown): string {
  const text = isApiError(e, 'rate_limited') && e.message ? e.message : errorText(e);
  const own = isApiError(e, 'conflict') || isApiError(e, 'rate_limited');
  return own && !/[.!?]$/u.test(text) ? `${text}.` : text;
}
