/**
 * v0.6 Fleet: accounts as config dirs (accountsMode "dirs"), on a Linux or
 * Windows node without cswap (lane L2). STUB from wave 0: one account,
 * `~/.claude` as 0, exactly as one Claude login (sources/cswap/single.ts),
 * until L2 replaces this file, keeping createDirsUsageSource and
 * dirsAccounts.
 *
 * `~/.claude` is account 0 (alias "claude"); every other `~/.claude-<name>`
 * dir holding a `.claude.json` gets the next free number the first time it
 * is seen, kept in the node's kv (`accounts.dirIds`), never reused or
 * renumbered (alias `<name>`); `~/.claude-swap-backup` never. It only checks
 * that `.claude.json` exists: it never opens it, `.credentials.json` or
 * anything else in the dir. Listed at start and every 10 minutes; a refresh
 * is refused with FLEET_COPY.noUsage; no usage numbers.
 */
import type { DaemonContext, KvStore, Paths, UsageSource } from '../../contracts.js';
import { createSingleUsageSource } from './single.js';

/** One config dir as an account. */
export interface DirAccount {
  id: number;
  /** "claude" for ~/.claude, else the dir's `<name>`. */
  alias: string;
  /** Absolute path of the config dir. */
  dir: string;
}

/** The config dirs that are accounts on this machine, numbered for good. */
export function dirsAccounts(paths: Pick<Paths, 'claudeHome'>, _kv: KvStore): DirAccount[] {
  return [{ id: 0, alias: 'claude', dir: paths.claudeHome }];
}

export function createDirsUsageSource(ctx: DaemonContext): UsageSource {
  return createSingleUsageSource(ctx);
}
