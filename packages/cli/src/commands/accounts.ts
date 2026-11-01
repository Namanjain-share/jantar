/**
 * jantar accounts (v0.4, spec 3.10): one Claude login or cswap's many, and
 * the accounts kept for other work (settings accounts.kept, Mac only).
 *
 *   accounts              the mode, the kept accounts, autoswitch's hold and
 *                         ccw's live hold list (read from its switch.json)
 *   accounts keep <n...>  Auto, Rewrite, Ask Claude and Ask never pick them
 *   accounts keep --none  keep none
 *   accounts prime        whether free 5-hour windows are primed, and by whom
 *   accounts prime on|off prime them (settings accounts.prime; --kept: kept
 *                         and held accounts too, accounts.primeKept)
 *
 * The mode is the running daemon's (decided once at its start); with the
 * daemon down, what it would decide. Kept accounts change over ctl.sock, or
 * in config.json when no daemon runs (after migrateSettingsFile). The daemon
 * holds kept ∪ autoswitch.hold ∪ ccw's hold ∪ an account's own flag, so the
 * rule stands when ccw is gone. A daemon of another version (v0.3, before
 * the cutover) is refused, as init refuses it. With one Claude login the
 * kept list is kept but waits for cswap.
 *
 * Priming (docs/primer.md) is the same kind of Mac-only switch. `prime`
 * asks no version question: another version's daemon refuses the unknown
 * setting on its own. When ccw primes free windows itself (its default: its
 * switch.json does not say "prime": false), the daemon leaves them to ccw,
 * and this says so.
 */
import { ccwPrimeConfig, type CcwPrime } from '@jantar/daemon/primer/rules';
import { parseSwitchConfig } from '@jantar/daemon/sources/ccw-legacy/files';
import { readJsonFile } from '@jantar/daemon/sources/lib/fsx';
import { ROUTES, type AccountId, type AccountsMode, type AccountsResponse, type Settings, type StateResponse } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { findCswap, findDaemon, otherDaemonText, type CswapFound, type DaemonFound } from '../lib/init/detect.js';
import { accountListText, parseAccountList } from '../lib/init/plan.js';
import { displayPath } from '../lib/roots.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, parseOnOff } from '../lib/switches.js';
import { ago } from '../lib/text.js';

const FLAGS = {
  none: { type: 'boolean', help: 'keep: keep no account' },
  kept: { type: 'boolean', help: 'prime on: kept and held accounts too' },
} as const;

const KEPT_RULE = 'Auto, Rewrite, Ask Claude and Ask never pick them; a manual start still can, after a confirm.';
/** With one Claude login there is no other account to pick, so the kept list waits for cswap. */
const SINGLE_KEPT = 'They apply once cswap is set up.';

const PRIME_RULE = 'When an account has no 5-hour window running, one tiny Haiku run starts its clock (at most once per 5 hours).';

/** Which accounts priming leaves out (settings accounts.primeKept). */
function primeWho(s: Settings): string {
  return s.accounts.primeKept ? 'Kept and held accounts too.' : 'Kept and held accounts are left out.';
}

/** The accounts mode the running daemon decided, or null when it does not say. */
async function daemonMode(ctx: CliContext): Promise<AccountsMode | null> {
  const r = await callDaemon<StateResponse>(ctx.ctl, 'GET', ROUTES.getState.path);
  return r.state.daemon?.accountsMode ?? null;
}

/**
 * The daemon on ctl.sock, or null after saying why not: one of another
 * version (v0.3's settings have no accounts) is refused, as init does.
 */
async function sameVersionDaemon(ctx: CliContext): Promise<DaemonFound | null> {
  const daemon = await findDaemon(ctx);
  if (daemon.kind !== 'other') return daemon;
  ctx.io.err(otherDaemonText('accounts', daemon, ctx.paths.home));
  return null;
}

interface ModeFound {
  mode: AccountsMode;
  /** "the running daemon", or what the daemon would decide at start. */
  decided: string;
  cswap: CswapFound;
}

async function accountsMode(ctx: CliContext, daemon: DaemonFound, settings: Settings): Promise<ModeFound> {
  const cswap = await findCswap(ctx, settings);
  if (daemon.kind === 'this') {
    try {
      return { mode: (await daemonMode(ctx)) ?? 'cswap', decided: 'the running daemon', cswap };
    } catch {
      // the daemon answered /healthz but not /v1/state: what it would decide
    }
  }
  return { mode: cswap.mode, decided: 'decided when the daemon starts', cswap };
}

/** ccw's hold list, read live from its switch.json; null when ccw is not installed or has none. */
async function ccwHold(ctx: CliContext): Promise<AccountId[] | null> {
  const r = await readJsonFile(ctx.paths.ccwSwitchJson);
  if (!r.ok) return null;
  return parseSwitchConfig(r.value)?.hold ?? null;
}

/** What ccw's switch.json says about priming; null when ccw is not installed or its file will not parse. */
async function ccwPrime(ctx: CliContext): Promise<CcwPrime | null> {
  const r = await readJsonFile(ctx.paths.ccwSwitchJson);
  return r.ok ? ccwPrimeConfig(r.value) : null;
}

/** The running daemon's accounts mode, else what it would decide at start. */
async function modeNow(ctx: CliContext, settings: Settings): Promise<AccountsMode> {
  try {
    const mode = await daemonMode(ctx);
    if (mode) return mode;
  } catch {
    // no daemon, or one that does not answer /v1/state
  }
  return (await findCswap(ctx, settings)).mode;
}

/** ccw primes unless its switch.json says not to (rules.ts ccwPrimeConfig). */
const CCW_HANDS_OVER = 'To have Jantar prime instead, put "prime": false in ccw\'s switch.json.';

/** One line: whether free 5-hour windows are primed, and by whom. */
function primeLine(s: Settings, mode: AccountsMode, ccw: CcwPrime | null): string {
  if (ccw?.primes) return `Free 5-hour windows: ccw primes them, so Jantar leaves them to ccw. ${CCW_HANDS_OVER}\n`;
  if (!s.accounts.prime) return 'Free 5-hour windows: not primed (jantar accounts prime on).\n';
  if (mode === 'single') return 'Free 5-hour windows: priming is on, but one Claude login has nothing to prime. It applies once cswap is set up.\n';
  return `Free 5-hour windows: primed. ${PRIME_RULE} ${primeWho(s)}\n`;
}

async function show(ctx: CliContext): Promise<number> {
  const daemon = await sameVersionDaemon(ctx);
  if (!daemon) return EXIT.failed;
  const { settings, source } = await readSettings(ctx);
  const { mode, decided, cswap } = await accountsMode(ctx, daemon, settings);
  const home = ctx.paths.userHome;
  const kept = settings.accounts.kept;
  if (mode === 'single') {
    const why = cswap.forcedSingle ? 'JANTAR_ACCOUNTS=single' : cswap.bin ? `cswap at ${displayPath(cswap.bin, home)} but no profiles` : 'no cswap';
    ctx.io.out(`Accounts: single, one Claude login (${why}; ${decided}).\n`);
    ctx.io.out('Usage and account moves need cswap (optional). With one login, Auto, Rewrite, Ask Claude and Ask use it.\n');
    ctx.io.out(kept.length ? `Kept for other work: ${accountListText(kept)}. ${SINGLE_KEPT}\n` : 'Kept for other work: none (with one login there is nothing to keep).\n');
  } else {
    const where = cswap.bin ? `cswap at ${displayPath(cswap.bin, home)}, ` : '';
    ctx.io.out(`Accounts: cswap, ${cswap.profiles} account${cswap.profiles === 1 ? '' : 's'} (${where}${decided}).\n`);
    ctx.io.out(`Kept for other work: ${accountListText(kept)}${kept.length ? `. ${KEPT_RULE}` : ' (jantar accounts keep <n...>)'}\n`);
  }
  if (settings.autoswitch.hold.length) ctx.io.out(`Held by autoswitch: ${accountListText(settings.autoswitch.hold)}\n`);
  const hold = await ccwHold(ctx);
  ctx.io.out(
    hold === null
      ? 'ccw: no hold list (ccw is optional; its switch.json is read only when it exists).\n'
      : `ccw's hold list (read live): ${accountListText(hold)}\n`,
  );
  ctx.io.out(primeLine(settings, mode, await ccwPrime(ctx)));
  if (source === 'defaults') ctx.io.out('(No config.json yet: these are the defaults. jantar init writes one.)\n');
  return EXIT.ok;
}

/** Account numbers cswap does not know, when the daemon can say which it knows. */
async function unknownAccounts(ctx: CliContext, ids: readonly AccountId[]): Promise<AccountId[]> {
  try {
    const r = await callDaemon<AccountsResponse>(ctx.ctl, 'GET', ROUTES.listAccounts.path);
    if (!r.accounts.length) return [];
    const known = new Set(r.accounts.map((a) => a.id));
    return ids.filter((id) => !known.has(id));
  } catch {
    return [];
  }
}

async function keep(ctx: CliContext, words: readonly string[], none: boolean): Promise<number> {
  if (none && words.length) throw new UsageError('give account numbers or --none, not both');
  if (!none && !words.length) throw new UsageError('say which accounts to keep (jantar accounts keep 3 5), or --none');
  let kept: AccountId[] = [];
  if (!none) {
    const r = parseAccountList(words.join(' '));
    if (!r.ok) throw new UsageError(r.reason);
    kept = r.value;
  }
  const daemon = await sameVersionDaemon(ctx);
  if (!daemon) return EXIT.failed;
  const { mode } = await accountsMode(ctx, daemon, (await readSettings(ctx)).settings);
  // With one login the daemon knows account 0 only: every number would be "unknown".
  const unknown = mode === 'cswap' ? await unknownAccounts(ctx, kept) : [];
  const rule = mode === 'single' ? SINGLE_KEPT : KEPT_RULE;
  await changeSettings(ctx, { accounts: { kept } }, (s: Settings) =>
    s.accounts.kept.length ? `Kept for other work: ${accountListText(s.accounts.kept)}. ${rule}\n` : 'No account is kept for other work.\n',
  );
  if (unknown.length) ctx.io.out(`Note: cswap has no account ${accountListText(unknown)} right now; kept anyway.\n`);
  return EXIT.ok;
}

/** `accounts prime`: the switch, who primes, and Jantar's last prime (from the running daemon). */
async function showPrime(ctx: CliContext): Promise<number> {
  const { settings } = await readSettings(ctx);
  ctx.io.out(primeLine(settings, await modeNow(ctx, settings), await ccwPrime(ctx)));
  try {
    const r = await callDaemon<StateResponse>(ctx.ctl, 'GET', ROUTES.getState.path);
    const last = r.state.primer?.last;
    if (last) ctx.io.out(`Last prime: account ${last.account}, ${ago(last.at, ctx.deps.now())}, ${last.ok ? 'its window started' : 'failed (tried again after 30 min)'}.\n`);
  } catch {
    // no daemon: no last prime to show
  }
  return EXIT.ok;
}

async function prime(ctx: CliContext, words: readonly string[], kept: boolean): Promise<number> {
  const [word, ...extra] = words;
  if (extra.length) throw new UsageError('accounts prime: say on or off');
  if (word === undefined) {
    if (kept) throw new UsageError('--kept is for "accounts prime on"');
    return showPrime(ctx);
  }
  const on = parseOnOff(word, 'accounts prime');
  if (!on && kept) throw new UsageError('--kept is for "accounts prime on"');
  const r = await changeSettings(ctx, { accounts: { prime: on, primeKept: on && kept } }, (s: Settings) =>
    s.accounts.prime
      ? `Priming free 5-hour windows is on. ${PRIME_RULE} ${primeWho(s)}\n`
      : 'Priming free 5-hour windows is off.\n',
  );
  if (!on) return EXIT.ok;
  if ((await ccwPrime(ctx))?.primes) ctx.io.out(`Note: ccw primes them itself; Jantar leaves them to ccw while it does. ${CCW_HANDS_OVER}\n`);
  else if ((await modeNow(ctx, r.settings)) === 'single') ctx.io.out('Note: one Claude login has nothing to prime. It applies once cswap is set up.\n');
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'accounts',
    summary: 'Show the accounts mode and the kept accounts, change which accounts are kept for other work, and prime free 5-hour windows.',
    usage: 'jantar accounts [keep <n...>|keep --none|prime [on|off] [--kept]]',
    owner: 'WP-OSS',
    help:
      '  accounts               one Claude login or cswap, the kept accounts and ccw\'s hold list\n' +
      '  accounts keep <n...>   keep these accounts for other work (replaces the list)\n' +
      '  accounts keep --none   keep none\n' +
      '  accounts prime         whether free 5-hour windows are primed, and by whom\n' +
      '  accounts prime on      prime them: a tiny Haiku run starts a window that has not started\n' +
      '  accounts prime on --kept   kept and held accounts too\n' +
      '  accounts prime off     stop priming\n' +
      'Kept accounts are never picked by Auto, Rewrite, Ask Claude or Ask (a manual start still can, after a confirm).\n' +
      'The hold list of the legacy ccw tool is read live on top, when ccw is installed; when ccw primes\n' +
      'free windows itself (its default), Jantar leaves them to ccw. ' + CCW_HANDS_OVER,
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS);
    const [action, ...rest] = positionals;
    if (flags.kept && action !== 'prime') throw new UsageError('--kept is for "accounts prime on"');
    if (action === undefined) {
      if (flags.none) throw new UsageError('--none is for "accounts keep"');
      return show(ctx);
    }
    if (action === 'prime') {
      if (flags.none) throw new UsageError('--none is for "accounts keep"');
      return prime(ctx, rest, flags.kept === true);
    }
    if (action !== 'keep') throw new UsageError(`unknown action "${action}" (keep, prime)`);
    return keep(ctx, rest, flags.none === true);
  },
);
