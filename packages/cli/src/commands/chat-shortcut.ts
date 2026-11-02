/**
 * jantar chat shortcut (v0.10, spec 0.10 B11.6, B12): the Siri door's chat
 * keys, at the Mac only (ctl.sock, `localOnly` routes):
 *
 *   chat shortcut add [--name iphone]   a new key, printed once, with the
 *                                       door's URL and the Shortcut's steps
 *   chat shortcut list                  the active keys (never a key)
 *   chat shortcut revoke <id|--all>
 *   chat shortcut steps                 the recipe, with no key (anywhere)
 *
 * `add` runs only in the user's own Terminal: it refuses when stdout is not
 * a terminal or when the environment shows a Claude Code process
 * (CLAUDECODE or CLAUDE_CODE_ENTRYPOINT set), so the key never ends up in a
 * log or a transcript. The key goes to stdout once and nowhere else: never a
 * file, a log, the clipboard or an audit row.
 */
import { CAPTURE_KEY_HEADER, ChatKeyIdSchema, ChatKeyNameSchema, ROUTES, type ChatKeyAddReply, type ChatKeyList, type ChatKeyRevokeReply, type Settings } from '@jantar/protocol';
import { chatDoor } from '@jantar/daemon/auth/capture-keys';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { readSettings } from '../lib/settings.js';
import { ago, clip, plural } from '../lib/text.js';

/** v0.10: built (test/sentences.test.ts checks the sentences that name it). */
export const CHAT_SHORTCUT_SHELL: boolean = false;

export const CHAT_SHORTCUT_HELP =
  '  chat shortcut add [--name <n>]  a key for the Siri Shortcut "Jantar", shown once, with its steps (in your own Terminal)\n' +
  '  chat shortcut list | revoke <id|--all> | steps\n' +
  '                     the Siri keys (never a key), stop one or all of them, or the steps alone\n';

const USAGE = 'chat shortcut add [--name <n>] | list | revoke <id|--all> | steps';
export const RUN_IT_YOURSELF = 'Run this yourself in Terminal: the key is shown once and must not end up in a log.';

/** The Siri Shortcut's steps (docs/shortcut.md "Ask Jantar with Siri" says the same with more words). */
export function chatShortcutSteps(url: string, cloudflare: boolean): string {
  const headers = cloudflare ? `${CAPTURE_KEY_HEADER} = the key, CF-Access-Client-Id and CF-Access-Client-Secret = the Access service token` : `${CAPTURE_KEY_HEADER} = the key`;
  return (
    'In Shortcuts on the iPhone:\n' +
    '  1. + (new shortcut), name it "Jantar", so "Hey Siri, Jantar" runs it.\n' +
    '  2. Add "Dictate Text" (Stop Listening: After Pause).\n' +
    `  3. Add "Get Contents of URL": ${url}; tap its > (Show More) for Method POST,\n` +
    `     Headers ${headers},\n` +
    '     Request Body JSON: text = Dictated Text.\n' +
    '  4. Add "Get Dictionary Value" for message.\n' +
    '  5. Add "Speak Text" with the Dictionary Value (or "Show Result", which Siri reads aloud).\n' +
    'Say "Hey Siri, Jantar", then your question; Siri speaks the answer. To type instead, make a copy with "Ask for Input" in place of Dictate Text.\n' +
    'Never share this shortcut: it carries the key (and on Cloudflare the Access token).\n' +
    'Steps with more detail: docs/shortcut.md\n'
  );
}

/** A Claude Code process (or anything run from one) has these set. */
function insideClaude(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.CLAUDECODE) || Boolean(env.CLAUDE_CODE_ENTRYPOINT);
}

async function add(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, { name: { type: 'string', help: 'what to call it (default iphone)' } }, { max: 0 });
  if (!ctx.io.isTTY || insideClaude(ctx.io.env)) {
    ctx.io.err(`${RUN_IT_YOURSELF}\n`);
    return EXIT.failed;
  }
  let name: string | undefined;
  if (flags.name !== undefined) {
    const parsed = ChatKeyNameSchema.safeParse(flags.name);
    if (!parsed.success) throw new UsageError('--name is one line of at most 40 characters');
    name = parsed.data;
  }
  if (positionals.length) throw new UsageError('add takes no argument (name it with --name)');
  const made = await callDaemon<ChatKeyAddReply>(ctx.ctl, 'POST', ROUTES.chatKeyAdd.path, name ? { name } : {});
  const { settings } = await readSettings(ctx);
  const io = ctx.io;
  io.out(`Siri key "${made.name}" (${made.id}). It is shown once: put it in the Shortcut now.\n\n  ${made.key}\n\n`);
  io.out('To move it without typing it: select it here, copy (Cmd-C) and paste on the iPhone (Universal Clipboard: the same Apple ID, Handoff on).\n\n');
  if (made.chatUrl) {
    io.out(`The door: POST ${made.chatUrl}\n`);
    io.out(chatShortcutSteps(made.chatUrl, settings.remote.mode === 'cloudflare'));
    if (settings.remote.mode === 'cloudflare') io.out('On Cloudflare, the Access application for /v1/capture/* and its service token cover this door too (docs/shortcut.md#cloudflare-access).\n');
  } else {
    const door = chatDoor(settings);
    io.out(`The door is closed: ${door.open ? 'the daemon gave no address' : door.why}\nThe key starts working once the door is open.\n`);
  }
  if (!settings.ask.enabled) io.out('Chat is off, so the door is closed. Turn it on: jantar chat on\n');
  io.out(`Stop this key: jantar chat shortcut revoke ${made.id}\n`);
  return EXIT.ok;
}

async function list(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals } = parseArgs(argv, {}, { max: 0 });
  if (positionals.length) throw new UsageError('list takes no argument');
  const r = await callDaemon<ChatKeyList>(ctx.ctl, 'GET', ROUTES.chatKeyList.path);
  if (r.keys.length === 0) {
    ctx.io.out('No Siri keys. Make one in your own Terminal: jantar chat shortcut add\n');
    return EXIT.ok;
  }
  const now = Date.now();
  ctx.io.out(`${plural(r.keys.length, 'Siri key')}:\n`);
  for (const k of r.keys) {
    const used = k.lastSeenAt ? `used ${ago(k.lastSeenAt, now)}` : 'never used';
    ctx.io.out(`  ${k.id}  ${clip(k.name, 40)}  made ${ago(k.createdAt, now)}, ${used}\n`);
  }
  ctx.io.out(r.chatUrl ? `The door: POST ${r.chatUrl}\n` : `The door is closed: ${r.why ?? 'no address'}\n`);
  return EXIT.ok;
}

async function revoke(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, { all: { type: 'boolean', help: 'revoke every Siri key' } }, { max: 1 });
  const [id] = positionals;
  if (flags.all && id !== undefined) throw new UsageError('give a key id or --all, not both');
  if (!flags.all && id === undefined) throw new UsageError('revoke needs a key id (see: jantar chat shortcut list) or --all');
  if (id !== undefined && !ChatKeyIdSchema.safeParse(id).success) throw new UsageError(`"${clip(id, 40)}" is not a key id (see: jantar chat shortcut list)`);
  const body = flags.all ? { all: true as const } : { id: id as string };
  const r = await callDaemon<ChatKeyRevokeReply>(ctx.ctl, 'POST', ROUTES.chatKeyRevoke.path, body);
  if (!flags.all && r.revoked === 0) {
    ctx.io.err(`No active Siri key ${id}. See: jantar chat shortcut list\n`);
    return EXIT.failed;
  }
  ctx.io.out(r.revoked === 0 ? 'No Siri keys to revoke.\n' : `Revoked ${plural(r.revoked, 'Siri key')}. A Shortcut using it now gets 401 (or 404 once no key is left).\n`);
  return EXIT.ok;
}

async function steps(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals } = parseArgs(argv, {}, { max: 0 });
  if (positionals.length) throw new UsageError('steps takes no argument');
  const { settings } = await readSettings(ctx);
  const door = chatDoor(settings);
  const url = door.open ? door.url : 'https://<your address>/v1/capture/chat';
  ctx.io.out(chatShortcutSteps(url, settings.remote.mode === 'cloudflare'));
  ctx.io.out('The key: make one in your own Terminal with jantar chat shortcut add (shown once).\n');
  if (!door.open) ctx.io.out(`The door is closed now: ${door.why}\n`);
  return EXIT.ok;
}

/** The Siri door's line in `jantar chat status`. */
export async function doorLine(ctx: CliContext, s: Settings): Promise<string> {
  const door = chatDoor(s);
  let keys = '';
  try {
    const r = await callDaemon<ChatKeyList>(ctx.ctl, 'GET', ROUTES.chatKeyList.path);
    keys = `, ${plural(r.keys.length, 'Siri key')}`;
  } catch {
    // the daemon down, or one too old to know chat keys: the door's line alone
  }
  if (!door.open) return `Siri door: closed (${door.why})${keys}\n`;
  return `Siri door: ${s.ask.enabled ? '' : 'closed while Chat is off; '}POST ${door.url}${keys}\n`;
}

export async function runChatShortcut(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'add':
      return add(rest, ctx);
    case 'list':
      return list(rest, ctx);
    case 'revoke':
      return revoke(rest, ctx);
    case 'steps':
      return steps(rest, ctx);
    default:
      throw new UsageError(action === undefined ? `shortcut needs an action: jantar ${USAGE}` : `unknown shortcut action "${clip(action, 20)}" (add, list, revoke or steps)`);
  }
}
