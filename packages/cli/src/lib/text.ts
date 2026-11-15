/**
 * Text helpers for terminal output. Session names, replies, tool input and
 * alert text come from Claude transcripts, i.e. from arbitrary web content,
 * so everything printed is stripped of control characters first: an escape
 * sequence in a transcript must never reach the user's terminal.
 *
 * 0.15: other people's words (WhatsApp) go through cleanData()/clipData(),
 * which also take out the bidi controls the daemon takes out (rewrite/guards
 * CONTROL) and print line and paragraph separators as spaces, so a line
 * can't be reordered on screen or seem to start another.
 */
import { CONTROL as DATA_CONTROL } from '@jantar/daemon/rewrite/guards';

// ESC [ ... final byte, ESC ] ... BEL/ST, and single-character escapes.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// C0 controls, DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** What many readers and models take as a line break: CR, NEL, the line and paragraph separators. */
const BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;

/** One printable line: escapes removed, control characters and newlines become spaces. */
export function clean(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
}

/** clean() and cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return cut(clean(text), max);
}

/** clean() for other people's words: line breaks of any kind as spaces, bidi controls out (escapes first, whole). */
export function cleanData(text: string): string {
  return clean(text.replace(ANSI, '').replace(BREAKS, ' ').replace(DATA_CONTROL, ''));
}

/** cleanData() and cut to `max` characters with an ellipsis. */
export function clipData(text: string, max: number): string {
  return cut(cleanData(text), max);
}

function cut(c: string, max: number): string {
  if (c.length <= max) return c;
  return `${c.slice(0, Math.max(0, max - 1))}…`;
}

/** "45s", "12m", "2h10m", "3d4h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
}

export function ago(iso: string | undefined | null, now: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return t > now ? 'just now' : `${duration(now - t)} ago`;
}

export function until(iso: string | undefined | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return t <= now ? 'now' : `in ${duration(t - now)}`;
}

/** "1 session" / "2 sessions". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
