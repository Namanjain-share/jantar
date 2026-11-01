/**
 * v0.6 Fleet: accounts as config dirs (accountsMode "dirs", spec 5), on a
 * Linux or Windows node without cswap.
 *
 * - `~/.claude` is account 0 (alias "claude"), always. Every other
 *   `~/.claude-<name>` dir holding a `.claude.json` gets the next free
 *   number the first time it is seen, kept in the node's kv
 *   (`accounts.dirIds`, by dir name) and never reused or renumbered, also
 *   after the dir goes away (alias `<name>`). `~/.claude-swap-backup` is
 *   never an account.
 * - It only checks that `.claude.json` exists (a stat): it never opens it,
 *   `.credentials.json` or anything else in a dir.
 * - The usage source lists the dirs at start and every DIRS_LIST_MS, and
 *   emits usage.updated with the roster only (usageStatus "unknown", no
 *   windows, activeAccount 0: the plain `claude` login); fetchedAt is when
 *   the dirs were listed. It lists them again at once when a session of
 *   this machine's comes up on an account the roster lacks (claude-files
 *   numbers a new dir on its 2 s scan), so the phone never shows a session
 *   on an account it can't pick. A refresh is refused with
 *   FLEET_COPY.noUsage. It never runs a command.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EVENT, FLEET_COPY, type Account } from '@jantar/protocol';
import type { DaemonContext, KvStore, Paths, TimerId, Unsubscribe, UsageSnapshot, UsageSource } from '../../contracts.js';
import { SINGLE_ACCOUNT } from '../../rewrite/account.js';

/** One config dir as an account. */
export interface DirAccount {
  id: number;
  /** "claude" for ~/.claude, else the dir's `<name>`. */
  alias: string;
  /** Absolute path of the config dir. */
  dir: string;
}

/** kv: each `.claude-<name>` dir's account number, by dir name, kept for good. */
export const DIR_IDS_KV_KEY = 'accounts.dirIds';
/** How often the config dirs are listed again. */
export const DIRS_LIST_MS = 10 * 60_000;
/** ~/.claude's alias. */
export const DEFAULT_DIR_ALIAS = 'claude';

const PREFIX = '.claude-';
/** cswap's own folder on macOS (and the legacy one on Linux): never an account. */
const CSWAP_DIR = '.claude-swap-backup';
/** A `<name>` Jantar takes: printable, no control character, at most 64 characters. */
const NAME_RE = /^[^\u0000-\u001f\u007f-\u009f]{1,64}$/u;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The kept numbers; anything malformed is left out. */
function readIds(kv: KvStore): Record<string, number> {
  let raw: unknown;
  try {
    raw = kv.get<unknown>(DIR_IDS_KV_KEY);
  } catch {
    return {};
  }
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, id] of Object.entries(raw)) if (Number.isInteger(id) && (id as number) > 0) out[name] = id as number;
  return out;
}

/** The `.claude-<name>` dirs in `home` that hold a `.claude.json`, by dir name. */
function accountDirs(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(PREFIX) && n !== CSWAP_DIR && NAME_RE.test(n.slice(PREFIX.length)))
    .filter((n) => isDir(join(home, n)) && existsSync(join(home, n, '.claude.json')))
    .sort();
}

/**
 * The config dirs that are accounts on this machine, by number. A dir seen
 * for the first time gets the next number above every number ever given
 * (several new ones in name order), saved before this returns.
 */
export function dirsAccounts(paths: Pick<Paths, 'claudeHome'>, kv: KvStore): DirAccount[] {
  const home = dirname(paths.claudeHome);
  const ids = readIds(kv);
  const found = accountDirs(home);
  let next = Math.max(SINGLE_ACCOUNT, ...Object.values(ids)) + 1;
  let added = false;
  for (const name of found) {
    if (ids[name] !== undefined) continue;
    ids[name] = next++;
    added = true;
  }
  if (added) {
    try {
      kv.set(DIR_IDS_KV_KEY, { ...ids });
    } catch {
      // Not saved: the same numbers come out again as long as no dir is added.
    }
  }
  const out: DirAccount[] = [{ id: SINGLE_ACCOUNT, alias: DEFAULT_DIR_ALIAS, dir: paths.claudeHome }];
  for (const name of found) out.push({ id: ids[name] as number, alias: name.slice(PREFIX.length), dir: join(home, name) });
  return out.sort((a, b) => a.id - b.id);
}

/** The account a config dir stands for in dirs mode, or null when it is none. */
export function dirsAccountFor(configDir: string, accounts: readonly DirAccount[]): number | null {
  if (!configDir) return null;
  const dir = resolve(configDir);
  return accounts.find((a) => resolve(a.dir) === dir)?.id ?? null;
}

/** A config dir as an Account: no usage, never disabled or held by itself (kept accounts are settings). */
export function dirAccount(a: DirAccount): Account {
  return {
    id: a.id,
    alias: a.alias,
    emailMasked: '',
    isDefaultLogin: a.id === SINGLE_ACCOUNT,
    disabled: false,
    held: false,
    usageStatus: 'unknown',
    windows: [],
  };
}

export class DirsUsageSource implements UsageSource {
  private snap: UsageSnapshot | null = null;
  private timer: TimerId | undefined;
  private unsubscribe: Unsubscribe | null = null;
  private started = false;

  constructor(private readonly ctx: DaemonContext) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.publish();
    this.timer = this.ctx.clock.setInterval(() => this.publish(), DIRS_LIST_MS);
    this.unsubscribe = this.ctx.store.subscribe((ev) => {
      if (ev.type !== EVENT.SESSION_ADDED || ev.data.session.node !== undefined) return;
      const id = ev.data.session.account;
      if (id !== null && !this.snap?.accounts.some((a) => a.id === id)) this.publish();
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async read(): Promise<UsageSnapshot> {
    return this.list();
  }

  latest(): UsageSnapshot | null {
    return this.snap;
  }

  requestRefresh(_reason: string): { queued: boolean; reason?: string; nextAllowedAt: string | null } {
    return { queued: false, reason: FLEET_COPY.noUsage(''), nextAllowedAt: null };
  }

  isPolling(): boolean {
    return false;
  }

  private list(): UsageSnapshot {
    return {
      accounts: dirsAccounts(this.ctx.paths, this.ctx.db.kv).map(dirAccount),
      activeAccount: SINGLE_ACCOUNT,
      fetchedAt: this.ctx.clock.iso(),
      source: 'cache',
    };
  }

  private publish(): void {
    if (!this.started) return;
    const snap = this.list();
    this.snap = snap;
    try {
      this.ctx.store.emit({ type: EVENT.USAGE_UPDATED, data: { ...snap } });
    } catch (e) {
      this.ctx.log.error('could not publish the config-dir accounts', { error: String(e) });
    }
  }
}

export function createDirsUsageSource(ctx: DaemonContext): UsageSource {
  return new DirsUsageSource(ctx);
}
