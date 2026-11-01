/**
 * Claude's answer to a read (spec 6.3): one JSON object, maybe inside one
 * code fence. Unknown keys are dropped; the shape is strict (a key of the
 * wrong type makes the answer unreadable), lengths are cut, never failed (a
 * re-run costs quota). No title or no summary: unreadable.
 *
 * Every string is stripped of control and bidi characters; links are
 * removed (nothing from Claude is ever a URL), and so is Markdown's
 * emphasis; tags are one lower-case line each, deduped. `creator` counts
 * only when the page gave none and it occurs in the input; `background`
 * only at Full. The phone shows all of it as text nodes.
 */
import { z } from 'zod';
import { CONTROL, LINE_END } from '../../rewrite/guards.js';

export const IntelReadAnswerRawSchema = z.object({
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()).optional(),
  points: z.array(z.string()).optional(),
  why: z.string().optional(),
  creator: z.string().optional(),
  background: z.string().optional(),
});

export interface ReadAnswer {
  title: string;
  summary: string;
  tags: string[];
  points: string[];
  why?: string;
  creator?: string;
  background?: string;
}

// http(s) links, bare www. hosts and anything shaped like scheme:// (no nested quantifiers).
const LINKS = /\b(?:[a-z][a-z0-9+.-]{1,20}:\/\/|www\.)[^\s<>"')\]]*/gi;
const MARKS = /\*\*|__|`+/g;

/** Text from Claude, made safe to keep: no control or bidi characters, no links, no emphasis marks. */
export function cleanText(s: string, max: number, oneLine: boolean): string {
  let t = s.replace(LINE_END, '\n').replace(CONTROL, '').replace(LINKS, '').replace(MARKS, '');
  t = oneLine ? t.replace(/\s+/g, ' ').trim() : t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > max) {
    t = t.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
    t = t.trimEnd();
  }
  return t;
}

/**
 * The answer in claude's result, or null when it is unreadable.
 * `input`: everything Claude was given (lower case), for the creator rule;
 * `pageCreator`: the page named one already.
 */
export function parseAnswer(result: string, opts: { full: boolean; input: string; pageCreator: boolean }): ReadAnswer | null {
  let text = result.trim();
  const fenced = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = IntelReadAnswerRawSchema.safeParse(value);
  if (!parsed.success) return null;
  const a = parsed.data;
  const title = cleanText(a.title, 120, true);
  const summary = cleanText(a.summary, 1200, false);
  if (!title || !summary) return null;
  const tags: string[] = [];
  for (const t of a.tags ?? []) {
    const tag = cleanText(t, 32, true).toLowerCase().replace(/^#+/, '');
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length === 8) break;
  }
  const points = (a.points ?? [])
    .map((p) => cleanText(p, 200, true).replace(/^[-*•]\s*/, ''))
    .filter((p) => p !== '')
    .slice(0, 6);
  const out: ReadAnswer = { title, summary, tags, points };
  const why = a.why !== undefined ? cleanText(a.why, 400, false) : '';
  if (why) out.why = why;
  const creator = a.creator !== undefined ? cleanText(a.creator, 80, true) : '';
  if (creator && !opts.pageCreator && opts.input.includes(creator.toLowerCase())) out.creator = creator;
  const background = opts.full && a.background !== undefined ? cleanText(a.background, 600, false) : '';
  if (background) out.background = background;
  return out;
}
