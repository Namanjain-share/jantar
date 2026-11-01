/**
 * Captures (v0.4 spec 4.9): `POST /v1/intel/captures` from the phone's Add
 * sheet or from `jantar intel` appends one line to the daemon's own
 * <intelDir>/captures.jsonl, which the shelf follows like any other source.
 * The file is opened O_APPEND (each line goes at the end, whoever else has
 * it open), mode 0600, in a 0700 dir. A last line left with no newline (a
 * crash mid-write, a hand edit) is ended first, so the new line is never
 * glued to it. The record is shaped like a bot's, so the mapping needs
 * nothing special: the note is its "what it is" and `via` shows as a field
 * (v0.5.3: "via claude" for what `jantar mcp` saved). The `cwd` of a
 * capture from the Mac (the CLI's, or the Claude session's) stays in the
 * file on the Mac: the shelf leaves it out.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntelCaptureBody } from '@jantar/protocol';
import type { IntelVia } from '../contracts.js';
import { readRange } from '../sources/lib/fsx.js';
import { CAPTURES_FILE } from './sources.js';

/** Append only (read only for the last byte), created 0600, never through a symlink. */
export const CAPTURE_OPEN_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

export interface CaptureFrom {
  /** v0.5.3: `claude` when `jantar mcp` saved it for a Claude session. v0.8: `shortcut` (the capture door) and `ask` too. */
  via: IntelVia;
  /** The folder `jantar intel` ran in, or the session's (ctl.sock only). */
  cwd?: string;
}

/** The line written for a capture (one JSON object, no newline). */
export function captureRecord(id: string, at: string, body: IntelCaptureBody, from: CaptureFrom): Record<string, unknown> {
  const rec: Record<string, unknown> = { id, captured_at: at, title: body.title };
  if (body.url) rec.url = body.url;
  const type = body.type?.trim();
  if (type) rec.type = type;
  const tags = (body.tags ?? []).map((t) => t.trim()).filter((t) => t !== '');
  if (tags.length) rec.tags = [...new Set(tags)];
  const note = body.note?.trim();
  if (note) rec.what_it_is = note;
  rec.via = from.via;
  if (from.via !== 'phone' && from.cwd) rec.cwd = from.cwd;
  return rec;
}

/** Append `record` to <dir>/captures.jsonl, making the dir 0700 and the file 0600. */
export async function appendCapture(dir: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const fh = await open(join(dir, CAPTURES_FILE), CAPTURE_OPEN_FLAGS, 0o600);
  try {
    await fh.chmod(0o600);
    const { size } = await fh.stat();
    const torn = size > 0 && (await readRange(fh, size - 1, 1))[0] !== 0x0a;
    await fh.write(`${torn ? '\n' : ''}${JSON.stringify(record)}\n`);
  } finally {
    await fh.close();
  }
}
