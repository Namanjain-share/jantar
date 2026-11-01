/**
 * jantar post (v0.7): add a post to make and list them, over ctl.sock, so
 * scripts and Claude sessions on this Mac can load posts (at most 30 adds
 * an hour from here). Jantar never posts anything: the phone rings at the
 * time, copies the text, opens the link, and counts what is marked Posted.
 * Marking posted, skipping, editing, deleting and the weekly goals are the
 * phone's; ctl.sock has no route for them.
 *
 * `add` checks the body with PostBodySchema first (one plain sentence for
 * the first field that fails, on one line), then its encoded size against
 * the daemon's body limit, and sends nothing when either fails.
 * `--text-file` is read once as UTF-8 (a leading BOM dropped, CRLF made LF);
 * it is a file the user names, so no denylist applies (`--text "$(cat f)"`
 * reads the same). `list` never prints a post's text or notes, except with
 * `--json`, which prints the reply as it came, for scripts.
 */
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MAX_BODY_BYTES,
  POST_KINDS,
  POST_PLATFORMS,
  POST_PLATFORM_LABEL,
  POST_TEXT_MAX,
  POST_TITLE_MAX,
  POST_WHERE_MAX,
  PostBodySchema,
  ROUTES,
  postGoalLabel,
  type Post,
  type PostBody,
  type PostKind,
  type PostPlatform,
  type PostsResponse,
} from '@jantar/protocol';
import { UsageError, parseArgs, type ParsedArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { clip } from '../lib/text.js';

/** A text file larger than this on disk is refused before it is read. */
export const TEXT_FILE_MAX_BYTES = 1024 * 1024;
const NOTES_MAX = 2000;
const TITLE_SHOWN = 60;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const n = (v: number) => v.toLocaleString('en-US');

const FLAGS = {
  platform: { type: 'string', help: `add: ${POST_PLATFORMS.join(', ')}` },
  where: { type: 'string', help: 'add: a subreddit, an account or a handle (one line)' },
  kind: { type: 'string', help: `add: ${POST_KINDS.join(', ')} (default post)` },
  at: { type: 'string', help: 'add: "YYYY-MM-DD HH:MM" in the Life zone (it rings), or YYYY-MM-DD (it does not)' },
  title: { type: 'string', help: 'add: the title (one line)' },
  text: { type: 'string', help: 'add: the text or caption' },
  'text-file': { type: 'string', help: 'add: read the text from this UTF-8 file' },
  notes: { type: 'string', help: 'add: flair, media, rules: shown on the phone, never copied' },
  link: { type: 'string', help: 'add: where to post it (https)' },
  status: { type: 'string', help: 'add: idea (default) or ready' },
  done: { type: 'boolean', help: 'list: posted and skipped' },
  json: { type: 'boolean', help: 'list: the reply as JSON (text and notes included)' },
} as const;

type Flags = ParsedArgs<typeof FLAGS>['flags'];
type FlagName = keyof typeof FLAGS;

/** Refuse flags that belong to another action, so a typo never goes unnoticed. */
function only(flags: Flags, action: string, allowed: readonly FlagName[]): void {
  for (const name of Object.keys(FLAGS) as FlagName[]) {
    if (flags[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} is not for "post ${action}"`);
  }
}

/** An enum flag in any case, or a usage error naming the choices. */
function oneOf<T extends string>(value: string, flag: string, choices: readonly T[]): T {
  const v = value.trim().toLowerCase();
  if ((choices as readonly string[]).includes(v)) return v as T;
  throw new UsageError(`unknown ${flag} "${clip(value, 20)}" (${choices.join(', ')})`);
}

/** `--at`: a day and a time, or a day alone. */
function dueOf(at: string): PostBody['due'] {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{2}:\d{2}))?$/.exec(at.trim());
  if (!m) throw new UsageError('--at takes "YYYY-MM-DD HH:MM" or YYYY-MM-DD');
  return m[2] ? { day: m[1] as string, time: m[2] } : { day: m[1] as string };
}

/** Optional text with its ends trimmed, or undefined when nothing is left (an empty shell variable adds nothing). */
function given(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** `--text-file`, read once: refused when missing, unreadable, not a file or over 1 MB; a leading BOM dropped, CRLF made LF. */
async function readText(file: string): Promise<string> {
  const path = resolve(file);
  const shown = clip(file, 80);
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error(`--text-file ${shown} is not a file`);
    size = st.size;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('--text-file')) throw e;
    throw new Error(`cannot read --text-file ${shown}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file' : 'it cannot be opened'}`);
  }
  if (size > TEXT_FILE_MAX_BYTES) throw new Error(`--text-file ${shown} is over 1 MB; a post's text is at most ${n(POST_TEXT_MAX)} characters`);
  let raw: string;
  try {
    const fh = await open(path, 'r');
    try {
      raw = await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    throw new Error(`cannot read --text-file ${shown}: it cannot be opened`);
  }
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/** The sentence for the first field PostBodySchema refuses. */
function problem(field: PropertyKey | undefined): string {
  switch (field) {
    case 'where':
      return `--where must be one line of 1 to ${n(POST_WHERE_MAX)} characters`;
    case 'title':
      return `--title must be one line of 1 to ${n(POST_TITLE_MAX)} characters`;
    case 'text':
      return `the text must be at most ${n(POST_TEXT_MAX)} characters`;
    case 'notes':
      return `--notes must be at most ${n(NOTES_MAX)} characters`;
    case 'link':
      return '--link must be a whole https link';
    case 'due':
      return '--at must be a real day, and a time from 00:00 to 23:59';
    default:
      return 'that post is not valid';
  }
}

/** "2 Nov" from a day key. */
function shortDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;
}

/** "Reddit · r/exampletools" (where clipped, on one line). */
function placeOf(p: { platform: PostPlatform; where?: string | undefined }): string {
  return `${POST_PLATFORM_LABEL[p.platform]}${p.where ? ` · ${clip(p.where, POST_WHERE_MAX)}` : ''}`;
}

function dueText(due: Post['due']): string {
  return due ? `${due.day}${due.time ? ` ${due.time}` : ''}` : '-';
}

/** A local "YYYY-MM-DD HH:MM" for an instant (posted and skipped). */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "This week (2 Nov to 8 Nov): 2 posted · Reels 1/3 · Reddit 2/6". */
export function weekLine(week: PostsResponse['week']): string {
  const posted = week.posted === 0 ? 'nothing posted yet' : `${n(week.posted)} posted`;
  const goals = week.goals.length === 0 ? 'no weekly goal' : week.goals.map((g) => `${postGoalLabel(g)} ${g.done}/${g.perWeek}`).join(' · ');
  return `This week (${shortDay(week.from)} to ${shortDay(week.to)}): ${posted} · ${goals}`;
}

/** One list line: when, status, where and kind, the title clipped, the id. Never the text or the notes. */
export function postLine(p: Post, done: boolean): string {
  const when = done ? localTime(p.postedAt ?? p.updatedAt) : dueText(p.due);
  const title = p.title ? `  ${clip(p.title, TITLE_SHOWN)}` : '';
  return `${when.padEnd(16)}  ${p.status.padEnd(done ? 7 : 5)}  ${placeOf(p)} · ${p.kind}${title}  ${p.id}`;
}

async function add(ctx: CliContext, flags: Flags): Promise<number> {
  if (flags.platform === undefined) throw new UsageError(`add needs --platform (${POST_PLATFORMS.join(', ')})`);
  if (flags.text !== undefined && flags['text-file'] !== undefined) throw new UsageError('give --text or --text-file, not both');
  const body: PostBody = { platform: oneOf<PostPlatform>(flags.platform, '--platform', POST_PLATFORMS) };
  if (flags.kind !== undefined) body.kind = oneOf<PostKind>(flags.kind, '--kind', POST_KINDS);
  if (flags.status !== undefined) body.status = oneOf(flags.status, '--status', ['idea', 'ready'] as const);
  if (flags.at !== undefined) body.due = dueOf(flags.at);
  const text = flags['text-file'] !== undefined ? await readText(flags['text-file']) : flags.text;
  for (const [key, value] of [
    ['where', flags.where],
    ['title', flags.title],
    ['text', text],
    ['notes', flags.notes],
    ['link', flags.link],
  ] as const) {
    const v = given(value);
    if (v !== undefined) body[key] = v;
  }
  const parsed = PostBodySchema.safeParse(body);
  if (!parsed.success) throw new Error(problem(parsed.error.issues[0]?.path[0]));
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new Error(`This post is ${n(Math.ceil(bytes / 1024))} KB once sent; the most is ${n(MAX_BODY_BYTES / 1024)} KB. Shorten the text or the notes.`);
  }
  const r = await callDaemon<{ id: string }>(ctx.ctl, 'POST', ROUTES.postCreate.path, parsed.data, { idempotencyKey: ctx.deps.randomId() });
  const due = parsed.data.due ? ` · ${dueText(parsed.data.due)}` : '';
  ctx.io.out(`Added post ${r.id} (${parsed.data.status ?? 'idea'}) · ${placeOf(parsed.data)}${due}\n`);
  return EXIT.ok;
}

async function list(ctx: CliContext, flags: Flags): Promise<number> {
  const done = flags.done === true;
  const r = await callDaemon<PostsResponse>(ctx.ctl, 'GET', `${ROUTES.postsList.path}?done=${done ? 1 : 0}`);
  if (flags.json) {
    ctx.io.out(`${JSON.stringify(r, null, 2)}\n`);
    return EXIT.ok;
  }
  ctx.io.out(`${weekLine(r.week)}\n`);
  if (r.posts.length === 0) {
    ctx.io.out(done ? 'Nothing posted or skipped yet.\n' : 'Nothing to post yet. Add one: jantar post add --platform <p>\n');
    return EXIT.ok;
  }
  for (const p of r.posts) ctx.io.out(`${postLine(p, done)}\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'post',
    summary: 'Add a social post to make (it rings at its time on the phone), and list them. Jantar never posts.',
    usage: 'jantar post <add --platform <p> [options]|list [--done] [--json]>',
    owner: 'WP-POSTS',
    help:
      '  post add --platform <p> [--where <w>] [--kind <k>] [--at "YYYY-MM-DD HH:MM" | --at YYYY-MM-DD]\n' +
      '           [--title <t>] [--text-file <path> | --text <t>] [--notes <n>] [--link <https url>]\n' +
      '           [--status idea|ready]\n' +
      '                                 add a post to make; a day and a time ring on the phone (a day alone does not)\n' +
      '  post list [--done] [--json]    this week against the goals, then the posts to make (--done: posted and skipped)\n' +
      `Platforms: ${POST_PLATFORMS.join(', ')}. Kinds: ${POST_KINDS.join(', ')}.\n` +
      'Posted, Skip, editing, deleting and the weekly goals are on the phone. Turn Posts on: jantar life on posts',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 1 });
    const [action] = positionals;
    switch (action) {
      case 'add':
        only(flags, 'add', ['platform', 'where', 'kind', 'at', 'title', 'text', 'text-file', 'notes', 'link', 'status']);
        return add(ctx, flags);
      case 'list':
        only(flags, 'list', ['done', 'json']);
        return list(ctx, flags);
      default:
        throw new UsageError(`unknown action "${clip(action ?? '', 20)}" (add or list)`);
    }
  },
);
