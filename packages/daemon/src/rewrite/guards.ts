/**
 * Checks on what the prompt writer wrote (spec 4.3 "Output and guards").
 * They flag; they never block Send. The user reviews the text either way.
 *
 * - Normalise: line ends, control characters (the writer would refuse
 *   them) and bidi controls, one pair of wrapping quotes or one whole-output
 *   code fence, one "Here's the prompt:" preface (and the quotes or fence
 *   around what follows it).
 * - expanded: longer than 2.5 x what the user said + 300 chars (the model
 *   answered or padded instead of rewriting).
 * - newTokens: file names, paths, --flags and backticked tokens that appear
 *   neither in what the user said (spoken forms rebuilt), nor the
 *   vocabulary, nor the recent conversation.
 * - leading: "!" always; "/" unless the user said "slash" or typed "/".
 */
import type { RewriteFlags } from '@jantar/protocol';

/** At most this many new tokens are reported (RewriteDetail.newTokens). */
export const NEW_TOKENS_MAX = 50;
const TOKEN_MAX = 200;

// C0 controls except tab and line feed, DEL, and C1 controls (writer/text.ts refuses them); bidi
// embeddings, overrides, isolates and marks, which can make what the phone shows differ from what is typed.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
// CR LF, CR, and the Unicode line and paragraph separators.
const LINE_END = /\r\n?|[\u2028\u2029]/g;
const PREFACE = /^(here(?:'s|’s| is) (?:the|your) (?:prompt|message)[^:\n]*:)\s*/i;
const FENCE = /^```[\w-]*\n([\s\S]*?)\n?```$/;
const QUOTES: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
];

export interface Normalised {
  text: string;
  preface: boolean;
}

/** One whole-output code fence, then one pair of wrapping quotes. */
function unwrap(text: string): string {
  const body = FENCE.exec(text)?.[1];
  // Only a fence around everything: two code blocks with text between them keep their fences.
  if (body !== undefined && !body.includes('```')) text = body.trim();
  for (const [open, close] of QUOTES) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length);
      // Only a pair around the whole text: "a" and "b" keeps its quotes.
      if (!inner.includes(open) && !inner.includes(close)) text = inner.trim();
      break;
    }
  }
  return text;
}

/** Trim and unwrap the model's output (spec 4.3 step 2). */
export function normaliseOutput(raw: string): Normalised {
  let text = unwrap(raw.replace(LINE_END, '\n').replace(CONTROL, '').trim());
  let preface = false;
  const m = PREFACE.exec(text);
  if (m) {
    // 'Here is your prompt: "Fix it"': the quotes (or a fence) come after the preface.
    text = unwrap(text.slice(m[0].length).trim());
    preface = true;
  }
  return { text, preface };
}

/** Spoken forms rebuilt, lower case: "send dot ts" -> "send.ts", "dash dash force" -> "--force", "slash compact" -> "/compact". */
export function rebuildSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*\bdash\s+dash\s+/g, ' --')
    .replace(/\s+dash\s+/g, '-')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s*\bslash\s*/g, '/')
    .replace(/\s+/g, ' ');
}

const BACKTICKED = /`([^`\n]{1,200})`/g;
const URL_RE = /\bhttps?:\/\/[^\s`<>()]+/g;
const FILE_NAME = /(?<![\w./-])[\w-]+(?:\.[\w-]+)*\.[A-Za-z]\w{0,4}\b/g;
const PATH = /(?<![\w`])(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+\/?/g;
const FLAG = /(?<![\w-])--[A-Za-z][\w-]*/g;
const NOT_A_NAME = /^(?:e\.g|i\.e|etc|vs|a\.m|p\.m|and\/or|either\/or|w\/o|n\/a|i\/o)$/i;

/** Candidate tokens of `text`, in order of first appearance, deduplicated. */
export function candidateTokens(text: string): string[] {
  const out = new Set<string>();
  const add = (t: string) => {
    const s = t.trim().replace(/[.,;:!?)]+$/, '');
    if (s.length < 2 || s.length > TOKEN_MAX || NOT_A_NAME.test(s) || /^[\d.]+$/.test(s)) return;
    out.add(s);
  };
  for (const m of text.matchAll(BACKTICKED)) add(m[1] ?? '');
  let bare = text.replace(BACKTICKED, ' ');
  for (const m of bare.matchAll(URL_RE)) add(m[0]);
  bare = bare.replace(URL_RE, ' ');
  for (const re of [PATH, FILE_NAME, FLAG]) for (const m of bare.matchAll(re)) add(m[0]);
  return [...out];
}

function squashLower(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whether `token` (or each of its words) appears in the haystack. */
function known(token: string, haystack: string): boolean {
  const t = squashLower(token);
  if (haystack.includes(t)) return true;
  const words = t.split(' ').filter((w) => w.length > 1);
  return words.length > 1 && words.every((w) => haystack.includes(w));
}

export interface GuardInput {
  /** What the user said (trimmed). */
  input: string;
  /** The normalised output. */
  output: string;
  /** Vocabulary entries and recent conversation lines the run was given. */
  context: readonly string[];
}

export interface GuardResult {
  flags: Omit<RewriteFlags, 'preface'>;
  newTokens: string[];
}

export function checkPrompt(g: GuardInput): GuardResult {
  const haystack = [squashLower(g.input), rebuildSpoken(g.input), ...g.context.map(squashLower)].join('\n');
  const newTokens = candidateTokens(g.output)
    .filter((t) => !known(t, haystack))
    .slice(0, NEW_TOKENS_MAX);
  const said = g.input.trimStart();
  let leading: RewriteFlags['leading'] = null;
  if (g.output.startsWith('!')) leading = 'bang';
  else if (g.output.startsWith('/') && !/^slash\b/i.test(said) && !said.startsWith('/')) leading = 'slash';
  return {
    flags: { expanded: g.output.length > 2.5 * g.input.length + 300, newTokens: newTokens.length, leading },
    newTokens,
  };
}
