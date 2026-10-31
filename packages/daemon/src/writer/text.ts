/**
 * Prompt text helpers: validation, normalisation and the shapes a prompt
 * takes in Claude's transcript.
 */
import { squash } from '../terminal/screen.js';

export { squash };

/** Same cap as the API's PromptBodySchema. */
export const MAX_PROMPT_CHARS = 16_000;

// C0 controls except tab and line feed, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

export type TextCheck = { ok: true; text: string } | { ok: false; reason: string };

/** /clear and its aliases: Claude records them in a new transcript, so they can never be proven. */
const NEW_TRANSCRIPT_COMMANDS: ReadonlySet<string> = new Set(['/clear', '/reset', '/new']);

/**
 * Normalise line ends (CRLF / CR -> LF) and refuse text that can't be typed
 * safely: empty, too long, or holding control characters (an escape sequence
 * in a prompt could press keys of its own). Also refuse what can never be
 * proven sent, since a "not sent" report would invite a retry that runs it
 * twice: a leading '!' (Claude's bash mode runs the rest as a shell command
 * and records it as <bash-input>) and /clear (its entry is written to the
 * next session's transcript).
 */
export function validatePromptText(input: string): TextCheck {
  const text = input.replace(/\r\n?/g, '\n');
  if (!squash(text)) return { ok: false, reason: 'the prompt is empty' };
  if (text.length > MAX_PROMPT_CHARS) return { ok: false, reason: `the prompt is longer than ${MAX_PROMPT_CHARS} characters` };
  if (CONTROL.test(text)) return { ok: false, reason: 'the prompt contains control characters' };
  if (text.startsWith('!')) {
    return { ok: false, reason: "a prompt starting with '!' runs as a shell command in Claude's bash mode and can't be proven sent; run it at the Mac" };
  }
  const slash = parseSlashCommand(text);
  if (slash && NEW_TRANSCRIPT_COMMANDS.has(slash.name)) {
    return { ok: false, reason: `${slash.name} starts a new transcript, so it can't be proven sent; run it at the Mac` };
  }
  if (imagePathLines(text).length > 0) return { ok: false, reason: IMAGE_PATH_REFUSED };
  return { ok: true, text };
}

/** v0.4.2: why a prompt with a line imagePathLines finds is refused (for every send, the CLI's included). */
export const IMAGE_PATH_REFUSED =
  "A line that is only an image path becomes an attached image in Claude Code, which Jantar can't prove sent. Add a word before it (on the phone, attach the file instead).";

// Claude Code 2.1.314's paste handler: a line is split before every word that
// starts like a path (an optional quote, then `/` or a drive letter), and a
// segment ending in one of these extensions is tried as an image. A line of
// several segments is tried only when each looks like a path, a UNC one
// (`\\host\share`) included.
const PATH_SPLIT = / (?=["']?(?:\/|[A-Za-z]:\\))/;
const PATH_LIKE = /^["']?(?:\/|~\/|[A-Za-z]:\\|\\\\)/;
const ABSOLUTE = /^(?:\/|~\/|[A-Za-z]:\\|\\\\)/;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
// A URL is tried as a path relative to Claude's folder too, where nothing by that name exists.
const URL_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** True when a pasted segment would be tried as an image: absolute, quoted, or one word, ending in an image extension. */
function imageCandidate(segment: string): boolean {
  const s = segment.trim();
  const quoted = s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0]);
  const bare = quoted ? s.slice(1, -1) : s;
  const plain = bare.replace(/\\(.)/g, '$1');
  if (!IMAGE_EXT.test(plain) || URL_START.test(plain)) return false;
  // A space escaped with a backslash keeps the segment one word; an escaped first `/` (`\/a b.png`) is still absolute.
  return ABSOLUTE.test(bare) || ABSOLUTE.test(plain) || quoted || !/(?<!\\)\s/.test(bare);
}

/**
 * v0.4.2: the lines (1-based) Claude Code would turn into an attached image
 * when the prompt is pasted into its box. The path then leaves the prompt's
 * text (`[Image #N]` takes its place), so the writer's exact proof can never
 * match and the send would fail with a draft left at the Mac. Mirrors Claude
 * Code 2.1.314's paste split: a line of words and paths stays text; a line
 * that is only paths, or one word, is tried, segment by segment. A relative
 * segment with spaces between words ("I saved it as out.png") and a URL are
 * not hits: Claude compares a relative name only with the name of a file on
 * the Mac's clipboard, so one of these can still become an image when it
 * names a file copied there (a send that then fails as "not sent", never a
 * wrong one).
 * Every attachment line Jantar composes starts with words (`- "<label>":`).
 */
export function imagePathLines(text: string): number[] {
  const hits: number[] = [];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      const segments = line.split(PATH_SPLIT).filter((s) => s.trim() !== '');
      if (segments.length > 1 && !segments.every((s) => PATH_LIKE.test(s.trim()))) return;
      if (segments.some(imageCandidate)) hits.push(i + 1);
    });
  return hits;
}

export interface SlashCommand {
  /** "/compact" */
  name: string;
  /** Squashed arguments ("" when none). */
  args: string;
}

const SLASH_RE = /^(\/[A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/u;

/** The slash command a prompt is, or null ("/compact keep notes" -> {name:"/compact", args:"keep notes"}). */
export function parseSlashCommand(text: string): SlashCommand | null {
  const m = SLASH_RE.exec(squash(text));
  if (!m) return null;
  return { name: m[1] as string, args: squash(m[2] ?? '') };
}

/** What proof has to match. */
export interface ExpectedPrompt {
  /** The prompt, whitespace-squashed. */
  norm: string;
  slash: SlashCommand | null;
}

export function expectedPrompt(text: string): ExpectedPrompt {
  return { norm: squash(text), slash: parseSlashCommand(text) };
}
