/**
 * jantar messages (0.15): Messages at the Mac. Jantar reads the owner's
 * WhatsApp for Mac (and, with Full Disk Access, his iPhone call log) through
 * jantar-messages-reader, the one program that opens those files, read-only.
 * Nothing is ever sent to WhatsApp.
 *
 * - With no action, or `status`: on or off, the reader's state and what
 *   fixes it, WhatsApp found, running and its newest message, Full Disk
 *   Access (only the iPhone call log needs it), the skipped chats and the
 *   morning run.
 * - `on` and `off` change settings messages.enabled (Mac only); `on` says
 *   what the morning run sends (MESSAGES_DATA_NOTE).
 * - `setup` builds the reader from the installed daemon's asset into
 *   <state>/messages/bin (0700) only when it is missing or its `.key`
 *   (readerSourceKey of the source) differs, since macOS ties Full Disk
 *   Access to the exact build; writes and (re)loads its LaunchAgent
 *   (READER_LABEL); waits up to two minutes for the daemon to say the reader
 *   answers; then, while the call log isn't readable, opens System Settings
 *   at Full Disk Access and prints the exact path to add. Never run by the
 *   daemon.
 * - `chats`, `read <name|chat id>`, `search <words>`, `calls`: the owner's
 *   own terminal, so text is printed, with escapes and control characters
 *   removed (other people's words); read and search start with the data
 *   note (a Claude session may run them through Bash, where no ask rule
 *   applies). A bare date in a time flag is local midnight.
 * - `skip list | add | remove <name|chat id>`: a name resolves through the
 *   chats (add) or the skip list (remove), exact names first; one that
 *   matches several chats, or more chats than one list holds, lists them
 *   and exits 2, never one picked.
 * - `morning [--now | --dry-run]`: the morning pass now, and what it made
 *   (counts, the chats left out for size); a dry run also prints what it
 *   would make as a table (todo titles, who to call back and when, each
 *   draft's first 60 characters, what it would leave out) and writes
 *   nothing. Other people's words: the data note first. A run that failed
 *   exits 1 after its report.
 *
 * Everything goes over ctl.sock, where a 1:1's number is never sent; the
 * daemon logs each read as the CLI's.
 */
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureStateDirs, socketPathOk } from '@jantar/daemon';
import { dataNote } from '@jantar/daemon/chat/text';
import { READER_SOURCE, readerSourceKey } from '@jantar/daemon/messages/reader-protocol';
import { MESSAGES_LIMITS, buildPath } from '@jantar/protocol';
import {
  ChatKeySchema,
  MESSAGES_ROUTES,
  type Chat,
  type CallsToReturnResponse,
  type Message,
  type MessagesChatsResponse,
  type MessagesReadByNameResponse,
  type MessagesReadResponse,
  type MessagesSearchResponse,
  type MessagesSkipList,
  type MessagesStatus,
  type MorningPreview,
  type MorningRun,
} from '@jantar/protocol/messages';
import { UsageError, parseArgs, type ParsedArgs } from '../args.js';
import { EXIT, binFinder, defineCommand, type CliContext } from '../command.js';
import { CtlUnavailableError, callDaemon } from '../ctl.js';
import { guardRealPath } from '../lib/guard.js';
import { LAUNCHCTL, READER_LABEL, bootoutAgent, bootstrapAgent, plistFor, plistPath, readPlist, readerLogPaths, writePlist } from '../lib/launchd.js';
import { readSettingsFile } from '../lib/settings.js';
import { changeSettings, onOff, parseOnOff } from '../lib/switches.js';
import { ago, clean, clip, plural } from '../lib/text.js';

/** What `jantar messages on` says (the design's note: said where it matters). */
export const MESSAGES_DATA_NOTE = "The morning run sends other people's messages to Claude under your account.\n";
/** System Settings at Privacy & Security > Full Disk Access. */
export const FDA_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
/** How long setup waits for the daemon to say the reader answers, and how often it asks. */
export const SETUP_WAIT_MS = 120_000;
export const SETUP_POLL_MS = 2_000;

/** WhatsApp for Mac's shared container and the iPhone's call log, under the user's home (only ever named in the plist). */
const WHATSAPP_CONTAINER = ['Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared'] as const;
const PHONE_CALL_DB = ['Library', 'Application Support', 'CallHistoryDB', 'CallHistory.storedata'] as const;

/** The reader's build: Command Line Tools' swiftc, Swift 5 language mode (Swift 6's strict concurrency refuses it), SQLite. */
const SWIFTC = '/usr/bin/swiftc';
const XCODE_SELECT = '/usr/bin/xcode-select';
const SWIFT_FLAGS = ['-O', '-swift-version', '5', '-lsqlite3'] as const;
const SAFE_PATH = '/usr/bin:/bin';
const BUILD_MS = 600_000;
const BUILD_OUTPUT_MAX = 256 * 1024;
/** The reader's reads can take its own 10 s deadline; ctl's default would give up first. */
const READ_TIMEOUT_MS = 20_000;
/** A run may take the morning's whole timeout, plus the reader's reads. */
const MORNING_TIMEOUT_MS = MESSAGES_LIMITS.morningTimeoutMs + 60_000;
/** The most chats a name is matched against. */
const NAME_MATCHES_MAX = 200;
const NAME_MAX = 100;
/** Before other people's words (as `jantar mcp` frames them). */
const WHATSAPP_NOTE = `${dataNote('WhatsApp')}\n`;
/** The reader's states that waiting won't change: setup says them at once. */
const SETTLED: ReadonlySet<MessagesStatus['reader']['state']> = new Set(['no_access', 'unsupported', 'update_needed', 'not_installed']);
/** A date with no time, read as the Mac's midnight. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const FLAGS = {
  q: { type: 'string', help: 'chats: only chats whose name holds these letters' },
  waiting: { type: 'boolean', help: 'chats: only 1:1s waiting on you (their message last, within 3 days)' },
  since: { type: 'string', help: 'chats, read, search: from this time (2026-11-13 or 2026-11-13T08:00)' },
  before: { type: 'string', help: 'read: older than this time (the line read prints to page back)' },
  limit: { type: 'number', help: 'chats, read, search: how many' },
  now: { type: 'boolean', help: 'morning: run the morning pass now' },
  'dry-run': { type: 'boolean', help: 'morning: show what it would make and write nothing' },
} as const;

type Flags = ParsedArgs<typeof FLAGS>['flags'];

/** Refuse flags that belong to another action, so a typo never goes unnoticed. */
function only(flags: Flags, action: string, allowed: readonly (keyof typeof FLAGS)[]): void {
  for (const name of Object.keys(FLAGS) as (keyof typeof FLAGS)[]) {
    if (flags[name] !== undefined && !allowed.includes(name)) throw new UsageError(`--${name} is not for "${['messages', action].filter(Boolean).join(' ')}"`);
  }
}

function getStatus(ctx: CliContext): Promise<MessagesStatus> {
  return callDaemon<MessagesStatus>(ctx.ctl, 'GET', MESSAGES_ROUTES.messagesStatus.path, undefined, { timeoutMs: READ_TIMEOUT_MS });
}

function get<T>(ctx: CliContext, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return callDaemon<T>(ctx.ctl, 'GET', s ? `${path}?${s}` : path, undefined, { timeoutMs: READ_TIMEOUT_MS });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

// ------------------------------------------------------------------ times and lines

function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The Mac's zone: TZ when this Node knows it, else the system's. */
function zoneOf(ctx: CliContext): string {
  const tz = ctx.io.env.TZ;
  return tz && knownZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "2026-11-13 08:00" in `zone`. */
function when(iso: string, zone: string): string {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const part of fmt.formatToParts(new Date(iso))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** A time flag as the ISO time the routes take (a bare date is local midnight, as a time is local); a usage error when it isn't a time. */
function timeFlag(v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  const text = v.trim();
  // Date.parse reads a bare date as UTC but a date with a time as local.
  const t = Date.parse(BARE_DATE.test(text) ? `${text}T00:00` : text);
  if (!Number.isFinite(t)) throw new UsageError(`--${name} needs a time like 2026-11-13 or 2026-11-13T08:00, got "${clip(v, 40)}"`);
  return new Date(t).toISOString();
}

function limitFlag(v: number | undefined): number | undefined {
  if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new UsageError(`--limit needs a whole number of at least 1, got ${v}`);
  return v;
}

/** "0:42", "12:05". */
function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One chat: its id first (what `read` and `skip` take), then when, what kind and its name. */
function chatLine(c: Chat, zone: string): string {
  const notes = [c.unread ? `${c.unread} unread` : '', c.archived ? 'archived' : '', c.members !== undefined ? plural(c.members, 'member') : ''].filter(Boolean);
  return `${c.chatKey}  ${when(c.lastAt, zone)}  ${c.kind.padEnd(9)}  ${clip(c.name, 60)}${notes.length ? ` (${notes.join(', ')})` : ''}\n`;
}

/** A line's words: its text, or what it is ("[image: invoice]", "[voice 0:42]") and any text with it. */
function bodyOf(m: Message): string {
  const text = m.text ? clean(m.text) : '';
  if (m.kind === 'text' || m.kind === 'link' || (m.kind === 'other' && text)) return text || `[${m.kind}]`;
  const length = m.kind === 'voice' && m.media?.durationS !== undefined ? ` ${minutes(m.media.durationS)}` : '';
  const label = m.caption ?? m.media?.fileName;
  const tag = `[${m.kind}${length}${label ? `: ${clean(label)}` : ''}]`;
  return text ? `${tag} ${text}` : tag;
}

function messageLine(m: Message, zone: string): string {
  if (m.skippedSender) return `${when(m.at, zone)}  [skipped]\n`;
  const who = m.fromMe ? 'me' : clip(m.sender, 40);
  const marks = [m.replyTo ? '(reply)' : '', m.mentionsMe ? '(@me)' : ''].filter(Boolean).join(' ');
  return `${when(m.at, zone)}  ${who}: ${marks ? `${marks} ` : ''}${bodyOf(m)}\n`;
}

/** A name several chats share: the candidates (never one picked), and exit 2. */
function ambiguous(ctx: CliContext, name: string, list: readonly Chat[], total: number): number {
  ctx.io.err(`jantar messages: ${total} chats match "${clip(name, NAME_MAX)}". Say which one by its id (the first column):\n`);
  const zone = zoneOf(ctx);
  for (const c of list) ctx.io.out(chatLine(c, zone));
  if (total > list.length) ctx.io.out(`(the newest ${list.length} of ${total})\n`);
  return EXIT.usage;
}

/** Case and accents aside, as the reader matches names. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase();
}

/** The chats a name means: those named exactly that, else those whose name holds it. */
function byName<T extends { name: string }>(name: string, list: readonly T[]): T[] {
  const want = fold(name);
  const exact = list.filter((c) => fold(c.name) === want);
  return exact.length ? exact : list.filter((c) => fold(c.name).includes(want));
}

function nameArg(arg: string | undefined, what: string): string {
  const v = arg?.trim();
  if (!v) throw new UsageError(`${what} needs a chat's name or id`);
  if (v.length > NAME_MAX) throw new UsageError(`a chat's name is at most ${NAME_MAX} characters`);
  return v;
}

const isChatKey = (v: string) => ChatKeySchema.safeParse(v).success;

// ------------------------------------------------------------------ status

function readerText(st: MessagesStatus): string {
  return st.reader.state === 'ok' ? `ok${st.reader.detail ? `. ${st.reader.detail}` : ''}` : `${st.reader.state.replace('_', ' ')}: ${st.reader.detail ?? 'see jantar messages setup'}`;
}

function whatsappText(st: MessagesStatus, now: number): string {
  const w = st.whatsapp;
  if (st.reader.state !== 'ok' && !w.found) return 'unknown until the reader answers';
  if (!w.found) return "not found (WhatsApp for Mac isn't on this Mac, or isn't linked to a phone yet)";
  if (!w.schemaOk) return 'found, but this version stores chats differently (Messages needs an update)';
  return `found, ${w.running ? 'running' : 'closed'}, newest message ${ago(w.newestAt, now)}`;
}

function fdaText(ctx: CliContext, st: MessagesStatus): string {
  if (st.phone.readable) return 'granted (the iPhone call log reads too)';
  if (st.reader.state !== 'ok') return "can't tell until the reader answers";
  // The reader can't tell a refused call log from none.
  return (
    'not granted, or there is no iPhone call log on this Mac. ' +
    `Only the iPhone call log needs it: add ${ctx.paths.messagesReaderBin} in System Settings > Privacy & Security > Full Disk Access`
  );
}

function morningText(st: MessagesStatus, now: number): string {
  const at = st.morning.at ? `at ${st.morning.at}` : 'off (set its time on the phone: Messages > Settings)';
  return `${at}, last ran ${ago(st.morning.lastRunAt, now)}`;
}

async function status(ctx: CliContext): Promise<number> {
  let st: MessagesStatus;
  try {
    st = await getStatus(ctx);
  } catch (e) {
    if (!(e instanceof CtlUnavailableError)) throw e;
    const { settings } = await readSettingsFile(ctx);
    const built = await isFile(ctx.paths.messagesReaderBin);
    ctx.io.out(
      `jantard is not running; from ${ctx.paths.configFile}:\nMessages: ${onOff(settings.messages.enabled)}\n` +
        `Reader: ${built ? `built (${ctx.paths.messagesReaderBin})` : 'not set up: jantar messages setup'}\n`,
    );
    return EXIT.ok;
  }
  const now = ctx.deps.now();
  ctx.io.out(
    `Messages: ${st.enabled ? 'on' : 'off. Turn it on: jantar messages on'}\n` +
      `Reader: ${readerText(st)}\n` +
      `WhatsApp: ${whatsappText(st, now)}\n` +
      `Full Disk Access: ${fdaText(ctx, st)}\n` +
      `Skipped chats: ${st.skipped}\n` +
      `Morning run: ${morningText(st, now)}\n`,
  );
  return EXIT.ok;
}

// ------------------------------------------------------------------ on, off

async function switchMessages(ctx: CliContext, on: boolean): Promise<number> {
  const r = await changeSettings(ctx, { messages: { enabled: on } }, () =>
    on
      ? `Messages is on: Claude sessions, the phone and the morning run can read your WhatsApp on this Mac. Nothing is ever sent.\n${MESSAGES_DATA_NOTE}`
      : 'Messages is off: nothing reads your chats, and the phone and Claude sessions are refused. The skip list and drafts stay on this Mac.\n',
  );
  if (on) {
    // Say at once when the reader isn't ready (with the daemon down, whether it is built).
    const st = r.via === 'daemon' ? await getStatus(ctx).catch(() => null) : null;
    if (st && st.reader.state !== 'ok') ctx.io.out(`Reader: ${readerText(st)}\n`);
    if (st ? st.reader.state === 'not_installed' : !(await isFile(ctx.paths.messagesReaderBin))) ctx.io.out('Set up the reader: jantar messages setup\n');
  }
  return EXIT.ok;
}

// ------------------------------------------------------------------ setup

/** The reader's four flags: WhatsApp's container, the iPhone's call log, its socket and its state dir. */
export function readerArgs(paths: CliContext['paths']): string[] {
  return [
    '--container',
    join(paths.userHome, ...WHATSAPP_CONTAINER),
    '--phone-db',
    join(paths.userHome, ...PHONE_CALL_DB),
    '--socket',
    paths.messagesReaderSock,
    '--state',
    paths.messagesDir,
  ];
}

/** Whether Command Line Tools (or Xcode) are selected and hold swiftc; never starts their install dialog. */
async function toolsFound(ctx: CliContext): Promise<boolean> {
  const r = await ctx.deps.exec(XCODE_SELECT, ['-p'], { env: { PATH: SAFE_PATH }, timeoutMs: 10_000, maxBuffer: 8 * 1024 });
  if (r.code !== 0) return false;
  const dir = r.stdout.trim();
  if (!dir.startsWith('/') || dir.includes('\n')) return false;
  for (const p of [join(dir, 'usr', 'bin', 'swiftc'), join(dir, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin', 'swiftc')]) {
    try {
      await access(p, constants.X_OK);
      return true;
    } catch {
      // try the other
    }
  }
  return false;
}

/**
 * The reader, built from `source` unless one built from it is in place.
 * The copy compiled is the source the key is made from. 'rebuilt' when it
 * replaced an older build (whose Full Disk Access no longer holds).
 */
async function ensureReader(ctx: CliContext, source: string): Promise<'kept' | 'new' | 'rebuilt'> {
  const bin = ctx.paths.messagesReaderBin;
  const key = readerSourceKey(source);
  const have = (await readFile(`${bin}.key`, 'utf8').catch(() => '')).trim();
  const there = await isFile(bin);
  if (there && have === key) return 'kept';
  if (!(await toolsFound(ctx))) throw new Error('building the reader needs Command Line Tools: run xcode-select --install, then jantar messages setup again');
  const binDir = dirname(bin);
  guardRealPath(binDir, "the messages reader's folder");
  for (const dir of [ctx.paths.messagesDir, binDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  const work = await mkdtemp(join(binDir, 'build-'));
  try {
    const src = join(work, 'jantar-messages-reader.swift');
    const out = join(work, 'jantar-messages-reader');
    const cache = join(work, 'module-cache');
    await writeFile(src, source, { mode: 0o600 });
    await mkdir(cache, { mode: 0o700 });
    ctx.io.out('Building the reader (Swift, up to a few minutes)...\n');
    const r = await ctx.deps.exec(SWIFTC, [...SWIFT_FLAGS, '-module-cache-path', cache, '-o', out, src], {
      cwd: work,
      env: { PATH: SAFE_PATH, HOME: work },
      timeoutMs: BUILD_MS,
      maxBuffer: BUILD_OUTPUT_MAX,
    });
    if (r.code !== 0 || r.timedOut) {
      const why = r.timedOut ? 'it took too long' : clip((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`, 400);
      throw new Error(`the reader didn't build: ${why}`);
    }
    await rename(out, bin);
    const fh = await open(bin, constants.O_RDONLY | constants.O_NOFOLLOW);
    await fh.chmod(0o700).finally(() => fh.close());
    await writeFile(`${bin}.key`, key, { mode: 0o600 });
    await chmod(`${bin}.key`, 0o600);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  return there ? 'rebuilt' : 'new';
}

/** The status until the reader answers, says what waiting won't change, or two minutes pass; null when the daemon isn't running. */
async function waitForReader(ctx: CliContext): Promise<MessagesStatus | null> {
  const until = ctx.deps.now() + SETUP_WAIT_MS;
  for (;;) {
    let st: MessagesStatus;
    try {
      st = await getStatus(ctx);
    } catch (e) {
      if (e instanceof CtlUnavailableError) return null;
      throw e;
    }
    if (st.reader.state === 'ok' || SETTLED.has(st.reader.state) || !(ctx.deps.now() < until)) return st;
    await ctx.deps.sleep(SETUP_POLL_MS);
  }
}

/** System Settings at Full Disk Access, and the exact path to add there. */
async function fdaSteps(ctx: CliContext, why: string): Promise<void> {
  const opener = await binFinder(ctx)('open');
  const opened = opener !== null && (await ctx.deps.exec(opener, [FDA_PANE], { timeoutMs: 15_000 })).code === 0;
  ctx.io.out(
    `${why}\n` +
      `${opened ? 'System Settings is open at' : 'Open System Settings >'} Privacy & Security > Full Disk Access: click +, press Cmd-Shift-G, paste this path and click Open:\n` +
      `  ${ctx.paths.messagesReaderBin}\n` +
      'Then run jantar messages setup again (it restarts the reader) and check: jantar messages status\n',
  );
}

async function setup(ctx: CliContext): Promise<number> {
  if (ctx.deps.platform !== 'darwin') throw new Error('Messages reads WhatsApp for Mac: setup runs on a Mac only');
  // The reader would refuse it, and launchd restart it every 10 s.
  const sock = ctx.paths.messagesReaderSock;
  if (!socketPathOk(sock)) {
    throw new Error(`the reader's socket path is longer than macOS allows for a Unix socket (103 bytes): ${sock}. Point JANTAR_HOME at a shorter directory.`);
  }
  const bin = ctx.paths.messagesReaderBin;
  const asset = join(ctx.paths.assetsDir, READER_SOURCE);
  const source = await readFile(asset, 'utf8').catch(() => {
    throw new Error(`the reader's source isn't in this install (${asset}); reinstall Jantar`);
  });

  const built = await ensureReader(ctx, source);
  if (built === 'kept') ctx.io.out(`Reader: already built from this release (${bin}).\n`);
  else ctx.io.out(`Reader: built (${bin}).\n`);
  if (built === 'rebuilt') {
    ctx.io.out('This is a new build, and macOS ties Full Disk Access to the build: if jantar-messages-reader is in Full Disk Access, remove it there and add it again (below).\n');
  }

  // Its socket's folder and its logs' are the daemon's state dirs.
  guardRealPath(ctx.paths.home, 'the Jantar state dir');
  await ensureStateDirs(ctx.paths);
  const plist = plistPath(ctx.paths, READER_LABEL);
  const xml = plistFor({ label: READER_LABEL, program: bin, args: readerArgs(ctx.paths), logs: readerLogPaths(ctx.paths), workingDirectory: ctx.paths.messagesDir });
  const before = await readPlist(plist);
  await writePlist(plist, xml);
  // Loaded afresh each time, so setup again restarts the reader (after a rebuild, or a new grant).
  const out = await bootoutAgent(ctx.deps.exec, ctx.deps.uid, READER_LABEL);
  if (!out.ok) throw new Error(`could not unload the reader's old agent: ${out.reason}`);
  const boot = await bootstrapAgent(ctx.deps.exec, ctx.deps.uid, plist);
  if (!boot.ok) throw new Error(`${LAUNCHCTL} bootstrap failed for the reader: ${boot.reason}`);
  ctx.io.out(`LaunchAgent: ${plist}${before === xml ? ' (unchanged)' : ''}, started.\n`);

  ctx.io.out('Waiting for the reader to answer (up to 2 minutes)...\n');
  const st = await waitForReader(ctx);
  if (!st) {
    ctx.io.err("jantar messages: jantard isn't running, so the reader can't be checked. Start it (jantar install), then: jantar messages status\n");
    return EXIT.daemonDown;
  }
  if (st.reader.state !== 'ok') {
    ctx.io.err(`jantar messages: the reader isn't ready: ${readerText(st)}\nIts errors: ${readerLogPaths(ctx.paths).stderr}\n`);
    // macOS refused it files: the one state Full Disk Access fixes.
    if (st.reader.state === 'no_access') await fdaSteps(ctx, 'The reader needs Full Disk Access on this Mac.');
    return EXIT.failed;
  }
  ctx.io.out(`Reader: ${readerText(st)}\nWhatsApp: ${whatsappText(st, ctx.deps.now())}\n`);

  if (st.phone.readable) ctx.io.out('Full Disk Access: granted; the iPhone call log reads too.\n');
  else {
    await fdaSteps(
      ctx,
      "The iPhone call log isn't readable: Full Disk Access isn't granted, or this Mac has no iPhone call log. " +
        'Full Disk Access is optional, only for the iPhone call log (WhatsApp reads without it).',
    );
  }
  if (!st.enabled) ctx.io.out('Messages is off. Turn it on: jantar messages on\n');
  return EXIT.ok;
}

// ------------------------------------------------------------------ reading

async function chats(ctx: CliContext, flags: Flags): Promise<number> {
  const q = flags.q?.trim();
  if (q !== undefined && q.length > NAME_MAX) throw new UsageError(`--q is at most ${NAME_MAX} characters`);
  const r = await get<MessagesChatsResponse>(ctx, MESSAGES_ROUTES.messagesChats.path, {
    // A blank --q is no filter (the route refuses an empty one).
    q: q || undefined,
    since: timeFlag(flags.since, 'since'),
    waiting: flags.waiting ? 'true' : undefined,
    limit: limitFlag(flags.limit),
  });
  if (r.chats.length === 0) {
    ctx.io.out('No chats.\n');
    return EXIT.ok;
  }
  const zone = zoneOf(ctx);
  for (const c of r.chats) ctx.io.out(chatLine(c, zone));
  if (r.total > r.chats.length) ctx.io.out(`(${r.chats.length} of ${r.total}: more with --limit)\n`);
  return EXIT.ok;
}

async function read(ctx: CliContext, arg: string | undefined, flags: Flags): Promise<number> {
  const which = nameArg(arg, 'read');
  const query = { since: timeFlag(flags.since, 'since'), before: timeFlag(flags.before, 'before'), limit: limitFlag(flags.limit) };
  const r = isChatKey(which)
    ? await get<MessagesReadResponse>(ctx, buildPath(MESSAGES_ROUTES.messagesRead, { chatKey: which }), query)
    : await get<MessagesReadByNameResponse>(ctx, MESSAGES_ROUTES.messagesReadByName.path, { name: which, ...query });
  if ('ambiguous' in r) return ambiguous(ctx, which, r.ambiguous, r.total);
  const zone = zoneOf(ctx);
  const c = r.chat;
  ctx.io.out(WHATSAPP_NOTE);
  ctx.io.out(`${clip(c.name, 60)} (${c.kind}${c.members !== undefined ? `, ${plural(c.members, 'member')}` : ''}), ${plural(r.messages.length, 'message')}  ${c.chatKey}\n`);
  for (const m of r.messages) ctx.io.out(messageLine(m, zone));
  const oldest = r.messages[0];
  if (r.more && oldest) ctx.io.out(`Older messages: jantar messages read ${c.chatKey} --before ${oldest.at}\n`);
  return EXIT.ok;
}

async function search(ctx: CliContext, words: readonly string[], flags: Flags): Promise<number> {
  const q = words.join(' ').trim();
  if (!q) throw new UsageError('search needs words to look for');
  if (q.length > 200) throw new UsageError('search takes at most 200 characters');
  const r = await get<MessagesSearchResponse>(ctx, MESSAGES_ROUTES.messagesSearch.path, { q, since: timeFlag(flags.since, 'since'), limit: limitFlag(flags.limit) });
  if (r.hits.length === 0) {
    ctx.io.out(`No messages with "${clip(q, 60)}"${flags.since ? '' : ' in the last 90 days'}.\n`);
    return EXIT.ok;
  }
  const zone = zoneOf(ctx);
  ctx.io.out(WHATSAPP_NOTE);
  for (const h of r.hits) {
    ctx.io.out(`${h.chatKey}  ${when(h.at, zone)}  ${clip(h.chatName, 40)} · ${h.fromMe ? 'me' : clip(h.sender, 40)}: ${clean(h.snippet)}\n`);
  }
  return EXIT.ok;
}

async function calls(ctx: CliContext): Promise<number> {
  const r = await get<CallsToReturnResponse>(ctx, MESSAGES_ROUTES.messagesCalls.path);
  if (r.calls.length === 0) {
    ctx.io.out('No missed calls to return.\n');
    return EXIT.ok;
  }
  const zone = zoneOf(ctx);
  for (const c of r.calls) {
    ctx.io.out(`${when(c.at, zone)}  missed ${c.via === 'phone' ? 'phone' : 'WhatsApp'}${c.video ? ' video' : ''} call  ${clip(c.who, 60)}\n`);
  }
  return EXIT.ok;
}

// ------------------------------------------------------------------ skip

type Picked = { ok: true; chatKey: string; name: string | null } | { ok: false; code: number };

/** A chat to skip: its id, or the one chat a name means (resolved through the chats). */
async function chatToSkip(ctx: CliContext, which: string): Promise<Picked> {
  if (isChatKey(which)) return { ok: true, chatKey: which, name: null };
  const r = await get<MessagesChatsResponse>(ctx, MESSAGES_ROUTES.messagesChats.path, { q: which, limit: NAME_MATCHES_MAX });
  if (r.total > r.chats.length) {
    // A chat of that name may be past the newest ones listed: never one picked.
    ctx.io.err(
      `jantar messages: ${r.total} chats hold "${clip(which, NAME_MAX)}", more than one list shows. ` +
        `Skip it by its chat id: find it with jantar messages chats --q "<more of its name>"\n`,
    );
    return { ok: false, code: EXIT.usage };
  }
  const hits = byName(which, r.chats);
  const [one] = hits;
  if (!one) throw new Error(`no chat named "${clip(which, NAME_MAX)}" (it may be skipped already: jantar messages skip list)`);
  if (hits.length > 1) return { ok: false, code: ambiguous(ctx, which, hits, hits.length) };
  return { ok: true, chatKey: one.chatKey, name: one.name };
}

/** A skipped chat: its id, or the one entry a name means on the skip list (skipped chats aren't in the chats). */
function skippedChat(ctx: CliContext, which: string, list: MessagesSkipList['skip']): Picked {
  const hits = isChatKey(which) ? list.filter((e) => e.chatKey === which) : byName(which, list);
  const [one] = hits;
  if (!one) throw new Error(`"${clip(which, NAME_MAX)}" isn't on the skip list (jantar messages skip list)`);
  if (hits.length > 1) {
    return { ok: false, code: ambiguous(ctx, which, hits.map((e) => ({ chatKey: e.chatKey, name: e.name, kind: e.kind, lastAt: e.addedAt, unread: 0, lastFromMe: false, archived: false })), hits.length) };
  }
  return { ok: true, chatKey: one.chatKey, name: one.name };
}

async function skip(ctx: CliContext, rest: readonly string[]): Promise<number> {
  const [sub, ...args] = rest;
  const list = () => get<MessagesSkipList>(ctx, MESSAGES_ROUTES.messagesSkipList.path);
  switch (sub) {
    case undefined:
    case 'list': {
      if (args.length) throw new UsageError('skip list takes no argument');
      const { skip: entries } = await list();
      if (entries.length === 0) {
        ctx.io.out('No chats are skipped. Skip one: jantar messages skip add <name|chat id>\n');
        return EXIT.ok;
      }
      const zone = zoneOf(ctx);
      for (const e of entries) ctx.io.out(`${e.chatKey}  added ${when(e.addedAt, zone)}  ${e.kind.padEnd(9)}  ${clip(e.name, 60)}\n`);
      return EXIT.ok;
    }
    case 'add': {
      if (args.length > 1) throw new UsageError('give one chat (quote a name with spaces)');
      const picked = await chatToSkip(ctx, nameArg(args[0], 'skip add'));
      if (!picked.ok) return picked.code;
      await callDaemon(ctx.ctl, 'POST', MESSAGES_ROUTES.messagesSkipAdd.path, { chatKey: picked.chatKey }, { idempotencyKey: ctx.deps.randomId(), timeoutMs: READ_TIMEOUT_MS });
      const name = picked.name ?? (await list().catch(() => null))?.skip.find((e) => e.chatKey === picked.chatKey)?.name ?? picked.chatKey;
      ctx.io.out(
        `Skipped "${clip(name, 60)}": Messages never reads it again. A 1:1 skips that person everywhere (their calls, and their lines in groups show as [skipped]).\n`,
      );
      return EXIT.ok;
    }
    case 'remove': {
      if (args.length > 1) throw new UsageError('give one chat (quote a name with spaces)');
      const which = nameArg(args[0], 'skip remove');
      const picked = skippedChat(ctx, which, (await list()).skip);
      if (!picked.ok) return picked.code;
      await callDaemon(ctx.ctl, 'DELETE', buildPath(MESSAGES_ROUTES.messagesSkipRemove, { chatKey: picked.chatKey }), undefined, {
        idempotencyKey: ctx.deps.randomId(),
      });
      ctx.io.out(`Removed "${clip(picked.name ?? picked.chatKey, 60)}" from the skip list: Messages reads it again.\n`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown skip action "${clip(sub, 20)}" (list, add or remove)`);
  }
}

// ------------------------------------------------------------------ morning

/** Why a dry run would leave an item of Claude's answer out (or its time off). */
const LEFT_OUT: Record<MorningPreview['dropped'][number]['why'], string> = {
  unknown_ref: "it cites a message the run didn't have",
  duplicate: 'an earlier run made it',
  limit: "Life's open-todo limit",
  life_refused: "Life wouldn't take it (is Life on?)",
  time_not_stated: 'its message states no time',
  time_passed: 'its time had passed',
};
/** What a run does with an item whose time had passed (time_passed). */
const LATE: Record<MorningPreview['dropped'][number]['kind'], string> = {
  todo: 'so it keeps its day only',
  reply: '',
  callback: 'so it rings at the next quarter hour',
};
/** Why Life took no more of a run's todos. */
const LIFE_REFUSED: Record<NonNullable<MorningRun['lifeRefused']>, string> = {
  limit: "Life's open-todo limit was reached",
  life_refused: "Life wouldn't take the todos (is Life on?)",
};
/** The table's widest kind ("call-back"). */
const KIND_WIDTH = 9;
const TITLE_MAX = 100;
const WHO_MAX = 60;
const DRAFT_SHOWN = 60;

/** A dry run's table: what it would make and what it would leave out, cleaned. */
function previewTable(p: MorningPreview, zone: string): string {
  const row = (kind: string, text: string) => `  ${kind.padEnd(KIND_WIDTH)}  ${text}\n`;
  const rows = [
    ...p.todos.map((t) => row('todo', clip(t.title, TITLE_MAX))),
    ...p.callbacks.map((c) => row('call-back', `${clip(c.who, WHO_MAX)}, ${c.at ? when(c.at, zone) : 'no time'}`)),
    ...p.replies.map((d) => row('reply', `${clip(d.chatName, WHO_MAX)}: ${clip(d.draft, DRAFT_SHOWN)}`)),
  ];
  const left = p.dropped.map((x) => {
    if (x.why === 'time_passed') return row('late', `${x.kind} ${x.ref}: ${LEFT_OUT[x.why]}${LATE[x.kind] ? `, ${LATE[x.kind]}` : ''}`);
    return row(x.why === 'time_not_stated' ? 'no time' : 'left out', `${x.kind} ${x.ref}: ${LEFT_OUT[x.why]}`);
  });
  return `What it would make:\n${rows.length ? rows.join('') : '  nothing\n'}${left.join('')}`;
}

async function morning(ctx: CliContext, flags: Flags): Promise<number> {
  const dry = flags['dry-run'] === true;
  if (flags.now && dry) throw new UsageError('give --now or --dry-run, not both');
  const now = ctx.deps.now();
  if (!flags.now && !dry) {
    ctx.io.out(`Morning run: ${morningText(await getStatus(ctx), now)}\nRun it now: jantar messages morning --now (or --dry-run to see what it would make)\n`);
    return EXIT.ok;
  }
  const run = await callDaemon<MorningRun>(ctx.ctl, 'POST', MESSAGES_ROUTES.messagesMorningRun.path, dry ? { dryRun: true } : {}, {
    idempotencyKey: ctx.deps.randomId(),
    timeoutMs: MORNING_TIMEOUT_MS,
  });
  const c = run.counts;
  // Chat names and the model's words are other people's.
  if (run.preview || run.dropped.length > 0) ctx.io.out(WHATSAPP_NOTE);
  ctx.io.out(
    `Morning run ${run.state}${run.why ? `: ${clean(run.why)}` : ''}. ${plural(c.todos, 'todo')}, ${c.replies} replies waiting, ${plural(c.callbacks, 'call-back')}` +
      ` (read ${plural(c.chats, 'chat')}, ${plural(c.messages, 'message')}, ${plural(c.calls, 'call')}).\n`,
  );
  if (run.stale) ctx.io.out(`WhatsApp's data was not fresh: its newest message is from ${run.newestAt ? ago(run.newestAt, now) : 'unknown'}.\n`);
  if (run.waCalls === false) ctx.io.out("WhatsApp's calls weren't read, so missed WhatsApp calls aren't in this run.\n");
  if (run.phoneCalls === false) ctx.io.out("The iPhone call log wasn't read, so missed phone calls aren't in this run.\n");
  if (run.lifeRefused) ctx.io.out(`${LIFE_REFUSED[run.lifeRefused]}, so some todos and call-backs weren't made.\n`);
  for (const d of run.dropped) ctx.io.out(`Left out for size: ${clip(d.chatName, 60)}, ${d.left} of ${d.kept + d.left} messages.\n`);
  if (run.preview) ctx.io.out(previewTable(run.preview, zoneOf(ctx)));
  if (dry) ctx.io.out('Dry run: nothing was written.\n');
  // A script (or setup) tells a failed run by the exit code.
  return run.state === 'failed' ? EXIT.failed : EXIT.ok;
}

export default defineCommand(
  {
    name: 'messages',
    summary: 'Messages: your WhatsApp for Claude sessions, the phone and the morning run. On or off, setup, read, skip.',
    usage: 'jantar messages [on | off | status | setup | chats | read <name|chat id> | search <words> | calls | skip [list | add | remove] <name|chat id> | morning]',
    owner: 'WP-MESSAGES',
    help:
      '  messages | messages status     on or off, the reader, WhatsApp, Full Disk Access, skipped chats, the morning run\n' +
      '  messages on | off              turn Messages on or off (the phone, Claude sessions and the morning run read only while on)\n' +
      '  messages setup                 build the reader (only when this release changed it), install its LaunchAgent,\n' +
      '                                 wait for it to answer, and show where to add Full Disk Access (iPhone call log only)\n' +
      '  messages chats [--q <letters>] [--waiting] [--since <time>] [--limit <n>]\n' +
      '  messages read <name|chat id> [--since <time>] [--before <time>] [--limit <n>]\n' +
      '  messages search <words> [--since <time>] [--limit <n>]   (the last 90 days unless --since)\n' +
      '  messages calls                 missed WhatsApp and phone calls you haven\'t returned\n' +
      '  messages skip list | add <name|chat id> | remove <name|chat id>\n' +
      '                                 chats Messages never reads; a 1:1 skips that person everywhere\n' +
      '  messages morning [--now | --dry-run]\n' +
      '                                 the morning pass now (--dry-run shows what it would make and writes nothing)\n' +
      'A name two chats share lists both (exit 2): say which by its id. Nothing is ever sent to WhatsApp.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS);
    const [action, ...rest] = positionals;
    switch (action) {
      case undefined:
      case 'status':
        only(flags, action ?? '', []);
        if (rest.length) throw new UsageError('status takes no argument');
        return status(ctx);
      case 'on':
      case 'off':
        only(flags, action, []);
        if (rest.length) throw new UsageError(`${action} takes no argument`);
        return switchMessages(ctx, parseOnOff(action, 'messages'));
      case 'setup':
        only(flags, action, []);
        if (rest.length) throw new UsageError('setup takes no argument');
        return setup(ctx);
      case 'chats':
        only(flags, action, ['q', 'waiting', 'since', 'limit']);
        if (rest.length) throw new UsageError('chats takes no argument (filter by name with --q)');
        return chats(ctx, flags);
      case 'read':
        only(flags, action, ['since', 'before', 'limit']);
        if (rest.length > 1) throw new UsageError('give one chat (quote a name with spaces)');
        return read(ctx, rest[0], flags);
      case 'search':
        only(flags, action, ['since', 'limit']);
        return search(ctx, rest, flags);
      case 'calls':
        only(flags, action, []);
        if (rest.length) throw new UsageError('calls takes no argument');
        return calls(ctx);
      case 'skip':
        only(flags, action, []);
        return skip(ctx, rest);
      case 'morning':
        only(flags, action, ['now', 'dry-run']);
        if (rest.length) throw new UsageError('morning takes no argument');
        return morning(ctx, flags);
      default:
        throw new UsageError(`unknown action "${clip(action, 20)}" (on, off, status, setup, chats, read, search, calls, skip or morning)`);
    }
  },
);
