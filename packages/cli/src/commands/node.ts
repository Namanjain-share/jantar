/**
 * jantar node: v0.6 Fleet, the servers paired to this Mac.
 *
 * At the Mac (the hub), over the control socket:
 *   node pair [--name N] [--count K] [--json]   one single-use join line per server (POST /v1/machines/pair)
 *   node list [--all] [--json]                  the paired servers (GET /v1/machines)
 *   node revoke <name>                          remove one: its link closes 4401, its sessions leave the board
 *
 * On a server (a node):
 *   node join <line> [--cf-access-client-id ID] [--hooks] [--no-service] [--read-only] [--replace-hub]
 *   node access [--cf-access-client-id ID]      a new Cloudflare Access service token, no re-pairing
 *   node status [--json]                        the link, the terminal, accounts, hooks
 *   node leave [--yes]                          stop the service and delete this server's key
 *
 * `join` checks first that this machine is not a hub with phones of its own
 * (`/ctl/status`; with the daemon down, its jantar.db read read-only), then
 * claims the line's code (link/join.ts pairWithHub, lane L1), and writes
 * node.json only once the hub's signature checks against the key in the
 * line: a line answered by anything but the Mac that made it leaves nothing
 * behind. The Access secret comes from a hidden prompt or
 * JANTAR_CF_ACCESS_CLIENT_SECRET, never a flag (so never shell history), and
 * is never printed: status shows the hub's host and the client id only.
 */
import { existsSync, rmSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ensureStateDirs, type NodeFile } from '@jantar/daemon';
import { roleOf } from '@jantar/daemon/config';
import { pairWithHub } from '@jantar/daemon/link/join';
import { readNodeFile, writeNodeFile } from '@jantar/daemon/link/keys';
import {
  MachinesPairBodySchema,
  NodeNameSchema,
  ROUTES,
  buildPath,
  type MachineResponse,
  type MachinesPairReply,
  type MachinesResponse,
  type NodeRow,
  type StateResponse,
} from '@jantar/protocol';
import { decodeJoinToken } from '@jantar/protocol/node-link';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, binFinder, defineCommand, type CliContext, type Command } from '../command.js';
import { DaemonError, callDaemon } from '../ctl.js';
import { processIo } from '../io.js';
import {
  OSRELEASE,
  claudeConfigDirs,
  closeFix,
  closeWords,
  dirHasHooks,
  hostOf,
  linkWords,
  nodeOsOf,
  parseTmuxVersion,
  readCtlStatus,
  tilde,
  type ConfigDir,
  type CtlStatusView,
} from '../lib/doctor.js';
import { guardRealPath } from '../lib/guard.js';
import { daemonLine, installService, removeService, restartService, serviceKindOf } from '../lib/service.js';
import { readSettings, readSettingsFile, updateSettings } from '../lib/settings.js';
import { ago, clip, duration, plural } from '../lib/text.js';
import { CLI_VERSION } from '../version.js';
import { buildProblem, prepareStateDir } from './install.js';
import { loadHooksCli, type HooksCliLoad } from './hooks.js';

/** Everything `node` reaches beyond the context, injectable for tests. */
export interface NodeCommandDeps {
  /** L1: claim a join line (decode, new key pair, POST, the hub's signature checked). Writes nothing. */
  pairWithHub: typeof pairWithHub;
  readNodeFile: typeof readNodeFile;
  writeNodeFile: typeof writeNodeFile;
  loadHooks(): Promise<HooksCliLoad>;
  /** A prompt that never echoes; absent when there is no terminal. */
  askSecret?: (question: string) => Promise<string>;
  /** /proc/sys/kernel/osrelease and the like; null when missing. */
  readText(path: string): Promise<string | null>;
  /** How long join waits for the first link (15 s). */
  linkWaitMs: number;
}

const SECRET_ENV = 'JANTAR_CF_ACCESS_CLIENT_SECRET';
const LINK_WAIT_MS = 15_000;

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Ask on the terminal with nothing echoed: raw mode, characters kept, Enter
 * ends, Ctrl-C cancels. The secret never reaches the screen or the shell's
 * history.
 */
export function askHiddenOnTerminal(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let text = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(text);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new UsageError('cancelled'));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function defaultNodeDeps(): NodeCommandDeps {
  return {
    pairWithHub,
    readNodeFile,
    writeNodeFile,
    loadHooks: () => loadHooksCli(),
    readText,
    linkWaitMs: LINK_WAIT_MS,
  };
}

/** This machine's node.json, or null (not a server, or a file that does not read). */
async function nodeFile(ctx: CliContext, deps: NodeCommandDeps): Promise<NodeFile | null> {
  try {
    return await deps.readNodeFile(ctx.paths.nodeFile);
  } catch {
    return null;
  }
}

/**
 * The one sentence for a command run on the wrong machine, or null when this
 * is the right one. `want`: the hub (pair, list, revoke, fleet) or a server.
 */
export async function wrongRole(ctx: CliContext, want: 'hub' | 'node', read: NodeCommandDeps['readNodeFile'] = readNodeFile): Promise<string | null> {
  const role = roleOf(ctx.paths);
  if (role === want) return null;
  if (role === 'node') {
    let f: NodeFile | null = null;
    try {
      f = await read(ctx.paths.nodeFile);
    } catch {
      f = null;
    }
    return f ? `This machine is ${f.name}, a node of ${f.url}: pair servers at the hub.` : 'This machine is a node of another Mac: pair servers at the hub.';
  }
  return ctx.deps.platform === 'darwin'
    ? 'This Mac is the hub. Pair servers with jantar node pair.'
    : 'This machine is not a server yet: run jantar node join <line from jantar node pair at the Mac>.';
}

const OS_WORDS: Record<NodeRow['os'], string> = { macos: 'macOS', linux: 'Linux', wsl: 'Linux (WSL)', windows: 'Windows' };
const BACKEND_WORDS: Record<NonNullable<NodeRow['backend']>, string> = { 'terminal-app': 'Terminal', tmux: 'tmux', none: 'watch' };

/** "offline for 12m · last: the connection dropped (1006)", "offline, last seen 3d ago", "never linked". */
export function offlineWords(row: NodeRow, now: number): string {
  if (row.lastClose) return `offline for ${duration(now - Date.parse(row.lastClose.at))} · last: ${closeWords(row.lastClose.code)}`;
  if (row.lastSeenAt) return `offline, last seen ${ago(row.lastSeenAt, now)}`;
  return 'never linked';
}

async function machines(ctx: CliContext): Promise<NodeRow[]> {
  return (await callDaemon<MachinesResponse>(ctx.ctl, 'GET', ROUTES.machinesList.path)).machines;
}

/** A live pairing by name (or id). */
export async function findMachine(ctx: CliContext, query: string): Promise<NodeRow | null> {
  const rows = (await machines(ctx)).filter((r) => r.revokedAt === null);
  return rows.find((r) => r.name === query) ?? rows.find((r) => r.id === query) ?? null;
}

// ---------------------------------------------------------------------------
// At the Mac

const PAIR_FLAGS = {
  name: { type: 'string', help: 'pair: the server\'s name (a-z, 0-9 and -, at most 24; default node-<n>)' },
  count: { type: 'number', help: 'pair: this many lines, named <name>-1 .. <name>-K (at most 20)' },
  json: { type: 'boolean', help: 'pair, list, status: print JSON' },
  all: { type: 'boolean', help: 'list: include removed servers' },
} as const;

async function pair(ctx: CliContext, flags: { name?: string; count?: number; json?: boolean }): Promise<number> {
  const body: { name?: string; count?: number } = {};
  if (flags.name !== undefined) {
    if (!NodeNameSchema.safeParse(flags.name).success) {
      throw new UsageError('--name may use a-z, 0-9 and "-" (at most 24, starting with a letter or digit), and is never "mac"');
    }
    body.name = flags.name;
  }
  if (flags.count !== undefined) body.count = flags.count;
  if (!MachinesPairBodySchema.safeParse(body).success) throw new UsageError('--count must be a whole number from 1 to 20');
  let reply: MachinesPairReply;
  try {
    reply = await callDaemon<MachinesPairReply>(ctx.ctl, 'POST', ROUTES.machinesPair.path, body, { idempotencyKey: ctx.deps.randomId() });
  } catch (e) {
    if (e instanceof DaemonError) {
      ctx.io.err(`jantar node pair: ${e.message}\n`);
      return EXIT.failed;
    }
    throw e;
  }
  if (flags.json) {
    ctx.io.out(`${JSON.stringify(reply, null, 2)}\n`);
    return EXIT.ok;
  }
  const first = reply.tokens[0];
  const minutes = first ? Math.max(1, Math.round((Date.parse(first.expiresAt) - ctx.deps.now()) / 60_000)) : 10;
  const one = reply.tokens.length === 1;
  ctx.io.out(`${one ? 'Run this line on the server' : 'Run one line on each server'} within ${plural(minutes, 'minute')}. ${one ? 'It works' : 'Each works'} once.\n`);
  const w = Math.max(...reply.tokens.map((t) => t.name.length));
  for (const t of reply.tokens) ctx.io.out(`  ${t.name.padEnd(w)}  jantar node join ${t.token}\n`);
  return EXIT.ok;
}

async function list(ctx: CliContext, flags: { all?: boolean; json?: boolean }): Promise<number> {
  const rows = (await machines(ctx)).filter((r) => flags.all || r.revokedAt === null);
  if (flags.json) {
    ctx.io.out(`${JSON.stringify({ machines: rows }, null, 2)}\n`);
    return EXIT.ok;
  }
  if (!rows.length) {
    ctx.io.out('No paired servers. Pair one: jantar node pair --name <name>\n');
    return EXIT.ok;
  }
  const mac = (await readCtlStatus(ctx.ctl))?.daemonVersion ?? null;
  const now = ctx.deps.now();
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const kinds = rows.map((r) => `${OS_WORDS[r.os]} · ${r.backend ? BACKEND_WORDS[r.backend] : '?'}`);
  const kindW = Math.max(...kinds.map((k) => k.length));
  rows.forEach((r, n) => {
    const where = r.revokedAt
      ? `removed ${ago(r.revokedAt, now)}`
      : r.online
        ? `online · ${plural(r.sessions, 'session')}`
        : offlineWords(r, now);
    const version = `Jantar ${clip(r.version, 24)}${mac && r.version !== mac ? ` · Mac has ${mac}` : ''}`;
    const flagsText = [r.readOnly ? 'read-only' : '', r.accessRefused ? `${plural(r.accessRefused, 'Access refusal')} while away` : '']
      .filter(Boolean)
      .join(' · ');
    ctx.io.out(`  ${r.name.padEnd(nameW)}  ${(kinds[n] as string).padEnd(kindW)}  ${where}  ·  ${version}${flagsText ? `  ·  ${flagsText}` : ''}\n`);
    if (r.problem === 'version') ctx.io.out(`  ${''.padEnd(nameW)}  ${r.name} runs an older link version: update Jantar there\n`);
  });
  return EXIT.ok;
}

async function revoke(ctx: CliContext, query: string): Promise<number> {
  const row = await findMachine(ctx, query);
  if (!row) {
    ctx.io.err(`jantar node revoke: no paired server named "${clip(query, 40)}" (see: jantar node list)\n`);
    return EXIT.failed;
  }
  const res = await callDaemon<MachineResponse>(ctx.ctl, 'DELETE', buildPath(ROUTES.machineRevoke, { id: row.id }), undefined, {
    idempotencyKey: ctx.deps.randomId(),
  });
  const name = res.machine.name;
  ctx.io.out(
    `Removed ${name}: its link is closed and its sessions left the board.\n` +
      `To pair it again: jantar node leave on ${name}, then jantar node pair --name ${name} here and join with the new line.\n`,
  );
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// On a server

/** What makes a machine a hub: live phones, push subscriptions, live servers. */
export interface HubRecords {
  devices: number;
  pushes: number;
  servers: number;
}

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | undefined;

/** node:sqlite, without Node 22's one ExperimentalWarning on stderr (as the daemon loads it). */
function quietSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (typeof text === 'string' && text.startsWith('SQLite is an experimental feature')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

/**
 * A stopped daemon's records, read from its database read-only (a server's
 * daemon keeps a jantar.db too, with none of them), or null when it can't be
 * read. SQLite needs a -wal and -shm beside a WAL file to read it: the ones
 * made here are removed again, so the folder is left as it was.
 */
export function hubRecordsIn(file: string): HubRecords | null {
  const made = ['-wal', '-shm'].filter((suffix) => !existsSync(file + suffix));
  let db: InstanceType<SqliteModule['DatabaseSync']> | undefined;
  try {
    db = new (quietSqlite().DatabaseSync)(file, { readOnly: true });
    const open = db;
    const rows = open.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const tables = new Set(rows.map((r) => r.name));
    // An older database has no nodes table: none paired.
    const count = (table: string, where = '') =>
      tables.has(table) ? Number((open.prepare(`SELECT count(*) AS n FROM ${table}${where}`).get() as { n: number }).n) : 0;
    return { devices: count('devices', ' WHERE revoked_at IS NULL'), pushes: count('push_subs'), servers: count('nodes', ' WHERE revoked_at IS NULL') };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
      for (const suffix of made) rmSync(file + suffix, { force: true });
    } catch {
      // Left beside the file: they hold no data.
    }
  }
}

const REPLACE_HUB = ' Joining makes it a server and its phones lose it. Pass --replace-hub to do it anyway.';

/**
 * Why this machine must not become a server, or null. S24: a machine with
 * phones (or servers) of its own is a hub. The running daemon says; with it
 * down, its database (read-only) and config.json do.
 */
export async function hubGuard(ctx: CliContext): Promise<string | null> {
  const st = await readCtlStatus(ctx.ctl);
  if (st?.role === 'node') {
    // node.json is gone (join checked), but a daemon still runs as a server: leave would say "not a server yet".
    return "This machine's daemon still runs as a server, though its key is gone: stop it (jantar uninstall, or end the jantard you started), then join again.";
  }
  let records: HubRecords | null = null;
  let door: string | null;
  if (st) {
    records = {
      devices: st.pairedDevices ?? st.counts?.devices ?? 0,
      pushes: st.pushSubscriptions ?? st.counts?.pushSubscriptions ?? 0,
      servers: st.nodes?.paired ?? 0,
    };
    door = st.publicUrl ?? null;
  } else {
    if (existsSync(ctx.paths.dbFile)) {
      records = hubRecordsIn(ctx.paths.dbFile);
      if (!records) {
        return `This machine has Jantar's database (${ctx.paths.dbFile}), join can't read it, and its daemon is not running, so join can't tell whether phones use this machine.${REPLACE_HUB}`;
      }
    }
    door = (await readSettingsFile(ctx)).settings.remote.publicUrl;
  }
  const found: string[] = [];
  if (records?.devices) found.push(plural(records.devices, 'paired phone'));
  if (records?.pushes) found.push(plural(records.pushes, 'push subscription'));
  if (records?.servers) found.push(plural(records.servers, 'paired server'));
  if (door) found.push(`a front door for phones (${door})`);
  return found.length ? `This machine already has ${andList(found)}: it looks like a hub.${REPLACE_HUB}` : null;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/;
const SECRET = /^[\x21-\x7e]{1,512}$/;

function secretPrompt(ctx: CliContext, deps: NodeCommandDeps): ((q: string) => Promise<string>) | undefined {
  if (deps.askSecret) return deps.askSecret;
  return ctx.io === processIo && process.stdin.isTTY ? askHiddenOnTerminal : undefined;
}

/** The Access secret: the environment, else the hidden prompt. Never a flag, never printed. */
async function accessSecret(ctx: CliContext, deps: NodeCommandDeps): Promise<string> {
  const fromEnv = ctx.io.env[SECRET_ENV];
  let secret = fromEnv;
  if (!secret) {
    const ask = secretPrompt(ctx, deps);
    if (!ask) throw new UsageError(`the Access client secret comes from a hidden prompt (a terminal) or ${SECRET_ENV}, never a flag`);
    secret = await ask('Cloudflare Access client secret: ');
  }
  secret = secret.trim();
  if (!SECRET.test(secret)) throw new UsageError(`that Access client secret is not one (${fromEnv ? SECRET_ENV : 'the prompt'})`);
  return secret;
}

/**
 * The Cloudflare Access token for the pairing POST and every link: none on
 * Tailscale (*.ts.net) or loopback; else --cf-access-client-id or the
 * prompt (empty: no Access), then the secret.
 */
async function accessFor(ctx: CliContext, deps: NodeCommandDeps, url: string, flag: string | undefined): Promise<NodeFile['cfAccess']> {
  let id = flag?.trim();
  if (id === undefined) {
    const host = new URL(url).hostname;
    if (host.endsWith('.ts.net') || host === '127.0.0.1' || host === '[::1]') return null;
    if (!ctx.io.ask) {
      if (ctx.io.env[SECRET_ENV]) throw new UsageError(`${SECRET_ENV} is set: pass the token's id with --cf-access-client-id`);
      return null;
    }
    id = (await ctx.io.ask('Cloudflare Access client id (empty if the door has no Access): ')).trim();
    if (!id) return null;
  }
  if (!CLIENT_ID.test(id)) throw new UsageError('that Access client id is not one (it looks like <32 hex>.access)');
  return { clientId: id, clientSecret: await accessSecret(ctx, deps) };
}

const JOIN_FLAGS = {
  'cf-access-client-id': { type: 'string', help: "join, access: the Cloudflare Access service token's id (the secret is asked, hidden)" },
  hooks: { type: 'boolean', help: "join: install Jantar's hooks into every Claude config dir here" },
  service: { type: 'boolean', help: 'join: install and start the service (default; --no-service: run jantard yourself)' },
  'read-only': { type: 'boolean', help: 'join: watch-only (cards, prompts, keys and starts all refused here)' },
  'replace-hub': { type: 'boolean', help: 'join: make this machine a server even though it has phones of its own' },
  yes: { type: 'boolean', short: 'y', help: 'leave: do not ask first' },
} as const;

interface JoinFlags {
  'cf-access-client-id'?: string;
  hooks?: boolean;
  service?: boolean;
  'read-only'?: boolean;
  'replace-hub'?: boolean;
}

/** Install the hooks into each config dir without them (the hooks installer, once per dir). */
async function installHooksInDirs(
  ctx: CliContext,
  deps: NodeCommandDeps,
  dirs: readonly ConfigDir[],
): Promise<{ installed: string[]; already: string[]; failed: string[] }> {
  const out = { installed: [] as string[], already: [] as string[], failed: [] as string[] };
  const loaded = await deps.loadHooks();
  for (const d of dirs) {
    const file = join(d.dir, 'settings.json');
    const shown = tilde(file, ctx.paths.userHome);
    if (await dirHasHooks(d.dir, ctx.paths.hookBin)) {
      out.already.push(shown);
      continue;
    }
    if (!loaded.ok) {
      out.failed.push(`${shown} (${loaded.reason})`);
      continue;
    }
    // The installer's diff and notes stay quiet here: join prints one line for all dirs.
    let said = '';
    const code = await loaded.run(['install', '--yes', '--settings', file], {
      io: { out: () => {}, err: (t: string) => void (said += t), env: ctx.io.env, isTTY: false },
      paths: ctx.paths,
      now: () => new Date(ctx.deps.now()),
    });
    if (code === 0) out.installed.push(shown);
    else out.failed.push(`${shown} (${clip(said, 160) || `exit ${code}`})`);
  }
  return out;
}

function hooksLine(r: { installed: string[]; already: string[]; failed: string[] }): string {
  const parts: string[] = [];
  if (r.installed.length) parts.push(`installed in ${andList(r.installed)}`);
  if (r.already.length) parts.push(`already in ${andList(r.already)}`);
  if (r.failed.length) parts.push(`NOT installed in ${andList(r.failed)}`);
  return `Hooks: ${parts.join('; ') || 'no Claude config dir here yet'}.\n`;
}

/** "2 accounts: claude (~/.claude), work (~/.claude-work)" */
function accountsText(ctx: CliContext, mode: string | undefined, dirs: readonly ConfigDir[], cswapCount: number): string {
  if (mode === 'cswap') return `${plural(cswapCount, 'cswap account')}`;
  if (mode === 'single' || !dirs.length) return '1 account';
  return `${plural(dirs.length, 'account')}: ${dirs.map((d) => `${d.alias} (${tilde(d.dir, ctx.paths.userHome)})`).join(', ')}`;
}

/** The ttys of tmux's panes here (its default server, as the daemon's), or none. */
async function paneTtys(ctx: CliContext): Promise<Set<string>> {
  const bin = await binFinder(ctx)('tmux');
  if (!bin) return new Set();
  const r = await ctx.deps.exec(bin, ['list-panes', '-a', '-F', '#{pane_tty}'], { timeoutMs: 5000 });
  return new Set(r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []);
}

/** Poll the daemon until its link is up, or `ms` passes. */
async function waitForLink(ctx: CliContext, ms: number): Promise<CtlStatusView | null> {
  const deadline = ctx.deps.now() + ms;
  let last: CtlStatusView | null = null;
  for (;;) {
    last = (await readCtlStatus(ctx.ctl)) ?? last;
    if (last?.role === 'node' && last.node?.link === 'linked') return last;
    if (ctx.deps.now() >= deadline) return last;
    await ctx.deps.sleep(500);
  }
}

async function joinCmd(ctx: CliContext, deps: NodeCommandDeps, line: string, flags: JoinFlags): Promise<number> {
  // 1. Never over another pairing, and never a hub with phones by accident (S24): before anything else.
  if (roleOf(ctx.paths) === 'node') {
    const f = await nodeFile(ctx, deps);
    ctx.io.err(`${f ? `This machine is already ${f.name} of ${f.url}` : 'This machine is already a server'}: jantar node leave first.\n`);
    return EXIT.failed;
  }
  const hub = await hubGuard(ctx);
  if (hub) {
    if (!flags['replace-hub']) {
      ctx.io.err(`${hub}\n`);
      return EXIT.failed;
    }
    ctx.io.err(`Warning: ${hub.replace(/ Pass --replace-hub.*$/, '')} Going on (--replace-hub).\n`);
  }

  // 2. The line, and the Access token for the door.
  const t = decodeJoinToken(line);
  if (!t.ok) {
    ctx.io.err(`Not joined: ${t.reason.replace(/\.$/, '')}. Nothing was saved on this machine. Make a new line at the Mac: jantar node pair\n`);
    return EXIT.failed;
  }
  const url = t.token.url;
  const cfAccess = await accessFor(ctx, deps, url, flags['cf-access-client-id']);

  // 3. Claim it. Nothing on this machine changes unless the hub's signature checks.
  const os = nodeOsOf(ctx.deps.platform, await deps.readText(OSRELEASE));
  const res = await deps.pairWithHub(line, { os, version: CLI_VERSION, cfAccess });
  if (!res.ok) {
    // L1's sentences end in a period, and some already say nothing was saved.
    const saved = /nothing was saved/i.test(res.reason) ? '' : ' Nothing was saved on this machine.';
    const noToken = res.status === 403 && !cfAccess ? ' If the Mac\'s door has Cloudflare Access, pass --cf-access-client-id.' : '';
    ctx.io.err(`Not joined. ${res.reason}${saved}${noToken}\n`);
    return EXIT.failed;
  }
  await ensureStateDirs(ctx.paths, ctx.deps.platform);
  guardRealPath(ctx.paths.nodeFile, "this server's key");
  await deps.writeNodeFile(ctx.paths, res.node);
  const name = res.node.name;
  ctx.io.out(`Paired with ${url} as ${name}.\n`);

  // 4. Settings: the binaries, and on tmux Escape and Clear draft off until they are checked there.
  const tmux = ctx.deps.platform === 'linux';
  const quiet = () => {};
  if (tmux) await updateSettings(ctx, { controls: { escapeVerified: false, clearVerified: false } });

  // 5. Hooks, the service, the first link.
  const dirs = await claudeConfigDirs(ctx.paths);
  const kind = serviceKindOf(ctx.deps.platform);
  const readOnly = flags['read-only'] === true;
  // Explicit: with no service file written, a bare install could not tell which this server is.
  const installLine = `jantar install ${readOnly ? '--read-only' : '--no-read-only'}`;
  let started = false;
  let failed = false;
  if (flags.service === false || !kind) {
    await prepareStateDir(ctx, quiet);
    ctx.io.out(
      `Service: not installed (--no-service). Start the daemon yourself: ${daemonLine(ctx, readOnly)}\n` +
        '(A jantard already running keeps running as before until it restarts.)\n',
    );
  } else {
    const unbuilt = await buildProblem(ctx);
    if (unbuilt) {
      ctx.io.err(`Service: not installed: ${unbuilt} Then: ${installLine}\n`);
      failed = true;
    } else {
      await prepareStateDir(ctx, quiet);
      const svc = await installService(ctx, { readOnly, start: true });
      if (svc.ok) {
        ctx.io.out(svc.text);
        started = svc.started;
      } else {
        ctx.io.err(`Service: not started: ${svc.reason}\n${svc.next ?? `Then: ${installLine}`}\n`);
        failed = true;
      }
    }
  }
  const hooks = flags.hooks ? await installHooksInDirs(ctx, deps, dirs) : null;

  // What the link says about the sessions here, printed after the hooks line.
  const notes: string[] = [];
  if (started) {
    const st = await waitForLink(ctx, deps.linkWaitMs);
    if (st?.node?.link === 'linked') {
      let state: StateResponse['state'] | null = null;
      try {
        state = (await callDaemon<StateResponse>(ctx.ctl, 'GET', ROUTES.getState.path)).state;
      } catch {
        state = null;
      }
      const sessions = state ? Object.values(state.sessions).filter((s) => s.status !== 'ended') : [];
      // paneId comes on the daemon's 10-second tick, so just after the link the panes' own ttys say it too.
      const panes = tmux ? await paneTtys(ctx) : new Set<string>();
      const inTmux = sessions.filter((s) => s.paneId !== undefined || (s.tty !== undefined && panes.has(s.tty))).length;
      const accounts = accountsText(ctx, state?.daemon?.accountsMode, dirs, Object.keys(state?.accounts ?? {}).length);
      ctx.io.out(`Linked. ${plural(sessions.length, 'Claude session')} here${tmux ? ` (${inTmux} in tmux)` : ''} on ${accounts}.\n`);
      if (tmux && sessions.length > inTmux) notes.push("Sessions outside tmux show on the phone with their cards, but Jantar can't type into them.\n");
      if (tmux && sessions.length === 0) notes.push('Run Claude inside tmux here, so the phone can send it prompts.\n');
    } else {
      const node = st?.node;
      const fix = node?.lastClose ? closeFix(node.lastClose.code) : undefined;
      ctx.io.out(`Not linked yet${node ? ` (${linkWords(node, ctx.deps.now())})` : ''}. jantar node status says more${fix ? `; ${fix}` : ''}.\n`);
    }
  }
  if (hooks) ctx.io.out(hooksLine(hooks));
  else if (dirs.length) ctx.io.out('Hooks: not installed here (cards need them): jantar hooks install --apply, with --settings <dir>/settings.json for each other config dir.\n');
  for (const n of notes) ctx.io.out(n);
  if (ctx.deps.platform === 'win32') {
    ctx.io.out("Windows: the phone shows these sessions and answers their cards; prompts and the screen need WSL2 (jantar doctor).\n");
  } else if (readOnly) {
    ctx.io.out("Watch-only (--read-only): the phone can't send anything here.\n");
  } else {
    const { settings } = await readSettings(ctx);
    if (!settings.launch.enabled) ctx.io.out('Starting sessions from the phone is off here: jantar launch on, then jantar folders add-root <dir>.\n');
  }
  return failed ? EXIT.failed : EXIT.ok;
}

async function accessCmd(ctx: CliContext, deps: NodeCommandDeps, flag: string | undefined): Promise<number> {
  const file = await nodeFile(ctx, deps);
  if (!file) {
    ctx.io.err("jantar node access: this server's node.json can't be read: jantar node leave, then join again.\n");
    return EXIT.failed;
  }
  let id = flag?.trim();
  if (id === undefined) {
    const current = file.cfAccess?.clientId;
    if (!ctx.io.ask) {
      if (!current) throw new UsageError("pass the token's id with --cf-access-client-id");
      id = current;
    } else {
      id = (await ctx.io.ask(`Cloudflare Access client id${current ? ` [${current}]` : ''}: `)).trim() || current;
    }
    if (!id) throw new UsageError("pass the token's id with --cf-access-client-id");
  }
  if (!CLIENT_ID.test(id)) throw new UsageError('that Access client id is not one (it looks like <32 hex>.access)');
  const clientSecret = await accessSecret(ctx, deps);
  guardRealPath(ctx.paths.nodeFile, "this server's key");
  await deps.writeNodeFile(ctx.paths, { ...file, cfAccess: { clientId: id, clientSecret } });
  ctx.io.out(`Access token replaced for ${file.name} (client id ${id}).\n`);
  const r = await restartService(ctx);
  if (!r.ok) {
    ctx.io.err(`The service did not restart (${r.reason}): restart jantard so it reads the new token.\n`);
    return EXIT.failed;
  }
  ctx.io.out(`${r.text}The link comes back on its own: jantar node status.\n`);
  return EXIT.ok;
}

async function tmuxVersion(ctx: CliContext): Promise<string | null> {
  const bin = await binFinder(ctx)('tmux');
  if (!bin) return null;
  const r = await ctx.deps.exec(bin, ['-V'], { timeoutMs: 5000 });
  const v = r.code === 0 ? parseTmuxVersion(r.stdout) : null;
  return v ? r.stdout.trim().replace(/^tmux\s*/, '') : null;
}

async function statusCmd(ctx: CliContext, deps: NodeCommandDeps, json: boolean): Promise<number> {
  const file = await nodeFile(ctx, deps);
  if (!file) {
    ctx.io.err("jantar node status: this server's node.json can't be read: jantar node leave, then join again.\n");
    return EXIT.failed;
  }
  const st = await readCtlStatus(ctx.ctl);
  let state: StateResponse['state'] | null = null;
  if (st) {
    try {
      state = (await callDaemon<StateResponse>(ctx.ctl, 'GET', ROUTES.getState.path)).state;
    } catch {
      state = null;
    }
  }
  const { settings } = await readSettings(ctx);
  const dirs = await claudeConfigDirs(ctx.paths);
  const hooks = await Promise.all(dirs.map(async (d) => ({ dir: tilde(d.dir, ctx.paths.userHome), hooks: (await dirHasHooks(d.dir, ctx.paths.hookBin)) === true })));
  const sessions = state ? Object.values(state.sessions).filter((s) => s.status !== 'ended') : [];
  const panes = sessions.filter((s) => s.paneId !== undefined).length;
  const tmux = ctx.deps.platform === 'linux' ? await tmuxVersion(ctx) : null;
  const host = hostOf(file.url);
  const readOnly = st?.mode?.readOnly ?? null;
  if (json) {
    ctx.io.out(
      `${JSON.stringify(
        {
          name: file.name,
          hub: host,
          cfAccessClientId: file.cfAccess?.clientId ?? null,
          daemon: st !== null,
          link: st?.node ?? null,
          readOnly,
          launch: settings.launch.enabled,
          tmux,
          sessions: sessions.length,
          panes,
          accountsMode: state?.daemon?.accountsMode ?? null,
          hooks,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }
  const now = ctx.deps.now();
  const lines = [`${file.name}, a server of ${host}${file.cfAccess ? ` (Cloudflare Access client id ${file.cfAccess.clientId})` : ''}`];
  if (!st) lines.push('Link:      the daemon is not running, so the phone shows this server offline (start it: jantar install)');
  else if (!st.node) lines.push('Link:      the daemon does not say (an older Jantar? update it here)');
  else {
    lines.push(`Link:      ${linkWords(st.node, now)}`);
    const fix = st.node.link !== 'linked' && st.node.lastClose ? closeFix(st.node.lastClose.code) : undefined;
    if (fix) lines.push(`           -> ${fix}`);
  }
  const term =
    ctx.deps.platform === 'win32'
      ? 'none: watch and cards (native Windows)'
      : ctx.deps.platform === 'darwin'
        ? 'Terminal.app'
        : tmux
          ? `tmux ${tmux}${state ? ` · ${plural(panes, 'pane')} with Claude of ${plural(sessions.length, 'session')}` : ''}`
          : "tmux not found: the phone can't type into sessions here";
  lines.push(`Terminal:  ${term}`);
  lines.push(`Accounts:  ${accountsText(ctx, state?.daemon?.accountsMode, dirs, Object.keys(state?.accounts ?? {}).length)}`);
  lines.push(`Hooks:     ${hooks.length ? hooks.map((h) => `${h.dir} ${h.hooks ? 'yes' : 'no'}`).join(', ') : 'no Claude config dir yet'}`);
  lines.push(`Read-only: ${readOnly === null ? 'unknown (daemon down)' : readOnly ? 'yes (watch only)' : 'no'}`);
  lines.push(`Starting:  ${settings.launch.enabled ? 'on' : 'off (jantar launch on, then jantar folders add-root <dir>)'}`);
  ctx.io.out(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

async function leaveCmd(ctx: CliContext, deps: NodeCommandDeps, yes: boolean): Promise<number> {
  const file = await nodeFile(ctx, deps);
  const who = file ? `${file.name} of ${hostOf(file.url)}` : 'a server';
  if (!yes) {
    const answer = ctx.io.ask
      ? (await ctx.io.ask(`Leave? This machine stops being ${who}; its key is deleted, and joining again needs a new line from the Mac. [y/N] `)).trim().toLowerCase()
      : '';
    if (answer !== 'y' && answer !== 'yes') {
      ctx.io.out(`Still ${who}${ctx.io.ask ? '' : ' (not a terminal; add --yes to leave)'}.\n`);
      return ctx.io.ask ? EXIT.ok : EXIT.failed;
    }
  }
  const svc = await removeService(ctx);
  if (!svc.ok) {
    ctx.io.err(`jantar node leave: ${svc.reason}\n`);
    return EXIT.failed;
  }
  ctx.io.out(svc.text);
  guardRealPath(ctx.paths.nodeDir, "this server's key");
  await rm(ctx.paths.nodeDir, { recursive: true, force: true });
  ctx.io.out(`Left: this machine is no longer ${who}, and its key is deleted.\n`);
  if (file) {
    ctx.io.out(`The Mac still lists ${file.name} until you remove it there: jantar node revoke ${file.name} (or Remove under Devices on an admin phone).\n`);
  }
  const dirs = await claudeConfigDirs(ctx.paths);
  const hooked: string[] = [];
  for (const d of dirs) if (await dirHasHooks(d.dir, ctx.paths.hookBin)) hooked.push(tilde(join(d.dir, 'settings.json'), ctx.paths.userHome));
  if (hooked.length) {
    ctx.io.out(
      `Claude's hooks here still call Jantar (they fail open): ${andList(hooked)}. Remove them with jantar hooks uninstall --apply ` +
        '(--settings <file> for each other config dir).\n',
    );
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------------------

export function createNodeCommand(over: Partial<NodeCommandDeps> = {}): Command {
  const deps: NodeCommandDeps = { ...defaultNodeDeps(), ...over };
  return defineCommand(
    {
      name: 'node',
      summary: 'v0.6 Fleet: pair servers at the Mac (pair, list, revoke); join one to it (join, access, status, leave).',
      usage:
        'jantar node <pair [--name N] [--count K] [--json] | list [--all] [--json] | revoke <name> | join <line> [options] | access | status [--json] | leave [--yes]>',
      owner: 'WP-FLEET',
      help:
        'At the Mac (the hub; Fleet on: jantar fleet on):\n' +
        '  pair      single-use join lines, good for 10 minutes: one per server\n' +
        '  list      the paired servers: OS, terminal, online or since when, Jantar version, sessions\n' +
        '  revoke    remove a server: its link closes, its sessions leave the board\n' +
        'On a server (Linux, WSL2, Windows preview, another Mac):\n' +
        '  join <line> [--cf-access-client-id ID] [--hooks] [--no-service] [--read-only] [--replace-hub]\n' +
        '            pair with the Mac, install the service (systemd user unit, LaunchAgent, or the Windows\n' +
        '            task\'s lines) and wait for the link. The Access secret is asked hidden, or read from\n' +
        `            ${SECRET_ENV}; never a flag. --hooks installs the hooks into every Claude config dir.\n` +
        '  access    replace the Cloudflare Access token (id and secret) and restart; no re-pairing\n' +
        '  status    the link and why it last closed, the terminal, accounts, hooks, read-only, starting\n' +
        '  leave     stop and remove the service and delete this server\'s key (hooks stay; the Mac keeps\n' +
        '            its row until jantar node revoke there)\n' +
        'More: docs/fleet.md.',
    },
    async (argv, ctx) => {
      const { flags, positionals } = parseArgs(argv, { ...PAIR_FLAGS, ...JOIN_FLAGS }, { min: 1, max: 2 });
      const [action, arg] = positionals;
      const none = (what: string) => {
        if (arg !== undefined) throw new UsageError(`${what} takes no argument`);
      };
      const hubOnly = async () => wrongRole(ctx, 'hub', deps.readNodeFile);
      const nodeOnly = async () => wrongRole(ctx, 'node', deps.readNodeFile);
      const refuse = (sentence: string) => {
        ctx.io.err(`${sentence}\n`);
        return EXIT.failed;
      };
      switch (action) {
        case 'pair': {
          none('pair');
          const wrong = await hubOnly();
          return wrong ? refuse(wrong) : pair(ctx, flags);
        }
        case 'list': {
          none('list');
          const wrong = await hubOnly();
          return wrong ? refuse(wrong) : list(ctx, flags);
        }
        case 'revoke': {
          if (arg === undefined) throw new UsageError('revoke needs a server name (see: jantar node list)');
          const wrong = await hubOnly();
          return wrong ? refuse(wrong) : revoke(ctx, arg);
        }
        case 'join':
          if (arg === undefined) throw new UsageError('join needs the line from jantar node pair at the Mac');
          return joinCmd(ctx, deps, arg, flags);
        case 'access': {
          none('access');
          const wrong = await nodeOnly();
          return wrong ? refuse(wrong) : accessCmd(ctx, deps, flags['cf-access-client-id']);
        }
        case 'status': {
          none('status');
          const wrong = await nodeOnly();
          return wrong ? refuse(wrong) : statusCmd(ctx, deps, flags.json === true);
        }
        case 'leave': {
          none('leave');
          const wrong = await nodeOnly();
          return wrong ? refuse(wrong) : leaveCmd(ctx, deps, flags.yes === true);
        }
        default:
          throw new UsageError(`unknown action "${action}" (pair, list, revoke, join, access, status or leave)`);
      }
    },
  );
}

export default createNodeCommand();

/** For `jantar fleet status` and `jantar status`: the words for a machine's OS and terminal. */
export function machineKind(row: Pick<NodeRow, 'os' | 'backend'>): string {
  return `${OS_WORDS[row.os]} · ${row.backend ? BACKEND_WORDS[row.backend] : '?'}`;
}
