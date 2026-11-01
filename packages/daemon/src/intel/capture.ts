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
 *
 * v0.8: the file has one writer, read/store.ts, with one lock; a capture is
 * appended through it (service.ts), and `appendCapture` is the store's.
 */
import type { IntelCaptureBody } from '@jantar/protocol';
import type { IntelVia } from '../contracts.js';

export { CAPTURE_OPEN_FLAGS, appendCapture } from './read/store.js';

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
