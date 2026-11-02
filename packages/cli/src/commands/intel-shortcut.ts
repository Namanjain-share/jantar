/**
 * jantar intel shortcut (v0.8): the iOS Shortcut's capture keys, at the Mac
 * only (ctl.sock, `localOnly` routes):
 *
 *   intel shortcut add [--name iphone]   a new key, printed once, with the
 *                                        door's URL and the Shortcut's steps
 *                                        (or why the door is closed: loopback
 *                                        and lan modes have none)
 *   intel shortcut list                  the active keys (never a key)
 *   intel shortcut revoke <id|--all>
 *
 * `jantar intel` hands everything after `shortcut` here unparsed, so this
 * file owns its flags. The key goes to stdout once and nowhere else: never
 * a file, a log or the clipboard. docs/shortcut.md has the steps in more
 * detail (where each setting is in the Shortcuts app).
 */
import { CAPTURE_KEY_HEADER, CaptureKeyIdSchema, CaptureKeyNameSchema, ROUTES, type CaptureKeyAddReply, type CaptureKeyList, type CaptureKeyRevokeReply } from '@jantar/protocol';
import { captureDoor } from '@jantar/daemon/auth/capture-keys';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { readSettings } from '../lib/settings.js';
import { ago, clip, plural } from '../lib/text.js';

/** v0.8: built (test/sentences.test.ts checks the sentences that name it). */
export const SHORTCUT_SHELL: boolean = false;

/** The help lines `jantar intel --help` shows for it. */
export const SHORTCUT_HELP =
  '  intel shortcut add [--name <n>] a key for the iOS Shortcut "Save to Jantar", shown once, with its steps\n' +
  '  intel shortcut list | revoke <id|--all>\n' +
  '                                 the Shortcut keys (never a key), or stop one or all of them\n';

const USAGE = 'intel shortcut add [--name <n>] | list | revoke <id|--all>';

const ADD_FLAGS = { name: { type: 'string', help: 'what to call it (default iphone)' } } as const;
const REVOKE_FLAGS = { all: { type: 'boolean', help: 'revoke every Shortcut key' } } as const;

/** The Shortcut's steps for a door, as `add` prints them (docs/shortcut.md says the same with more words). */
export function shortcutSteps(url: string, cloudflare: boolean): string {
  const headers = cloudflare ? `${CAPTURE_KEY_HEADER} (the key), CF-Access-Client-Id and CF-Access-Client-Secret (the Access service token)` : `${CAPTURE_KEY_HEADER} (the key)`;
  return (
    'In Shortcuts on the iPhone (or on this Mac, so you can paste the key; iCloud syncs it to the iPhone):\n' +
    '  1. + (new shortcut), name it "Save to Jantar".\n' +
    '  2. Details (i): Show in Share Sheet on. In the "Receive ... from Share Sheet" block at the top: URLs, Text and Safari web pages; if there is no input: Get Clipboard.\n' +
    `  3. Add "Get Contents of URL": ${url}; tap its > (Show More) for Method POST,\n` +
    `     Headers ${headers},\n` +
    '     Request Body JSON: text = Shortcut Input, depth = standard (a copy named "Save to Jantar (Full)" with full).\n' +
    '  4. Add "Get Dictionary Value" for message, then "Show Notification" with it: the saved sentence, or what went wrong.\n' +
    'It answers "Saved to Jantar." Never share this shortcut: it carries the key.\n' +
    'Steps with more detail: docs/shortcut.md\n'
  );
}

async function add(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, ADD_FLAGS, { max: 0 });
  let name: string | undefined;
  if (flags.name !== undefined) {
    const parsed = CaptureKeyNameSchema.safeParse(flags.name);
    if (!parsed.success) throw new UsageError('--name is one line of at most 40 characters');
    name = parsed.data;
  }
  if (positionals.length) throw new UsageError('add takes no argument (name it with --name)');
  const made = await callDaemon<CaptureKeyAddReply>(ctx.ctl, 'POST', ROUTES.captureKeyAdd.path, name ? { name } : {});
  const { settings } = await readSettings(ctx);
  const io = ctx.io;
  io.out(`Shortcut key "${made.name}" (${made.id}). It is shown once: put it in the Shortcut now.\n\n  ${made.key}\n\n`);
  io.out('To move it without typing it: select it here, copy (Cmd-C) and paste on the iPhone (Universal Clipboard: the same Apple ID, Handoff on).\n\n');
  if (made.saveUrl) {
    io.out(`The door: POST ${made.saveUrl}\n`);
    io.out(shortcutSteps(made.saveUrl, settings.remote.mode === 'cloudflare'));
    if (settings.remote.mode === 'cloudflare') {
      io.out('On Cloudflare, the door needs its own Access application for /v1/capture/* with one Service Auth policy and its own service token (docs/shortcut.md#cloudflare-access).\n');
    }
  } else {
    const door = captureDoor(settings);
    io.out(`The door is closed: ${door.open ? 'the daemon gave no address' : door.why}\nThe key starts working once the door is open.\n`);
  }
  io.out(`Stop this key: jantar intel shortcut revoke ${made.id}\n`);
  return EXIT.ok;
}

async function list(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { positionals } = parseArgs(argv, {}, { max: 0 });
  if (positionals.length) throw new UsageError('list takes no argument');
  const { keys } = await callDaemon<CaptureKeyList>(ctx.ctl, 'GET', ROUTES.captureKeyList.path);
  if (keys.length === 0) {
    ctx.io.out('No Shortcut keys. Make one: jantar intel shortcut add\n');
    return EXIT.ok;
  }
  const now = Date.now();
  ctx.io.out(`${plural(keys.length, 'Shortcut key')}:\n`);
  for (const k of keys) {
    const used = k.lastSeenAt ? `used ${ago(k.lastSeenAt, now)}` : 'never used';
    ctx.io.out(`  ${k.id}  ${clip(k.name, 40)}  made ${ago(k.createdAt, now)}, ${used}\n`);
  }
  return EXIT.ok;
}

async function revoke(argv: readonly string[], ctx: CliContext): Promise<number> {
  const { flags, positionals } = parseArgs(argv, REVOKE_FLAGS, { max: 1 });
  const [id] = positionals;
  if (flags.all && id !== undefined) throw new UsageError('give a key id or --all, not both');
  if (!flags.all && id === undefined) throw new UsageError('revoke needs a key id (see: jantar intel shortcut list) or --all');
  if (id !== undefined && !CaptureKeyIdSchema.safeParse(id).success) throw new UsageError(`"${clip(id, 40)}" is not a key id (see: jantar intel shortcut list)`);
  const body = flags.all ? { all: true as const } : { id: id as string };
  const r = await callDaemon<CaptureKeyRevokeReply>(ctx.ctl, 'POST', ROUTES.captureKeyRevoke.path, body);
  if (!flags.all && r.revoked === 0) {
    ctx.io.err(`No active Shortcut key ${id}. See: jantar intel shortcut list\n`);
    return EXIT.failed;
  }
  ctx.io.out(r.revoked === 0 ? 'No Shortcut keys to revoke.\n' : `Revoked ${plural(r.revoked, 'Shortcut key')}. A Shortcut using it now gets 401 (or 404 once no key is left).\n`);
  return EXIT.ok;
}

export async function runShortcut(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'add':
      return add(rest, ctx);
    case 'list':
      return list(rest, ctx);
    case 'revoke':
      return revoke(rest, ctx);
    default:
      throw new UsageError(action === undefined ? `shortcut needs an action: jantar ${USAGE}` : `unknown shortcut action "${clip(action, 20)}" (add, list or revoke)`);
  }
}
