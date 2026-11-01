// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * The line a launch types into its new Terminal window (spec 4.5.2, U7;
 * v0.4 spec 4.10 and 4.11).
 *
 *   cs-shell:   cd -- <folder> && <csCommand> <N> -- <flags> --session-id <uuid> --name <name>
 *   cswap-run:  cd -- <folder> && [<preLaunchArgv> &&] <cswap> run [--share-history] <N> -- <same tail>
 *   claude:     cd -- <folder> && <bins.claude> <flags> --session-id <uuid> --name <name>
 *   dirs:       cd -- <folder> && env CLAUDE_CONFIG_DIR=<dir> <bins.claude> <same tail as claude>
 *   a resume:   any of these with `--resume <uuid>` in place of `--session-id <uuid>`
 *
 * - Built only here, from checked parts: the folder's realpath, an account
 *   number from the roster, the claude flags from `launchFlagArgs` (the one
 *   allowlist), our own UUID (or, for a resume, one the daemon listed in the
 *   folder's history) and a name that matches LaunchNameSchema. The phone
 *   never supplies argv.
 * - Every value is quoted with `q()`. The whole line is refused when it holds
 *   a control character: a line feed inside `do script` would run a second
 *   command.
 * - No `exec`, no `; exit`: ccw's move types its relaunch line into the same
 *   tab after Claude quits, so the shell must outlive Claude. No positional
 *   prompt either (it would land in `ps`, zsh history and ccw's shlex); the
 *   first prompt goes through the writer.
 * - cs-shell mode types `launch.csCommand` (default `cs`): a shell function
 *   that wraps `cswap run` (`cs() { cswap run "$@"; }`), the path ccw's
 *   relaunch types too, so ccw sees the session and can move it.
 * - claude mode (v0.4: one Claude login, no cswap) types the absolute path of
 *   claude, with no account and no `--` (claude reads the flags itself). It
 *   picks no account, so it starts nothing in cswap mode, and cs-shell and
 *   cswap-run start nothing in single mode (accountsModeProblem).
 * - A resume carries no --session-id: Claude Code refuses the two together
 *   unless --fork-session is given.
 * - v0.6, accountsMode "dirs" (a paired server without cswap, spec 5):
 *   claude mode only. An account other than ~/.claude is its config dir,
 *   given to claude as `env CLAUDE_CONFIG_DIR=<dir>` (an absolute path,
 *   quoted like every word; `env` works in every shell, where older fish
 *   refuses a bare `VAR=x` prefix). Still no `--`.
 */
import { LaunchNameSchema, type AccountsMode, type Settings } from '@jantar/protocol';

/** C0 controls, DEL and C1 controls. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
/**
 * Words that need no quotes: no shell syntax, no glob, no `~`, and not
 * starting with `=` (zsh expands `=cmd` to a path) or `%`.
 */
const PLAIN_RE = /^[A-Za-z0-9_./:@+-][A-Za-z0-9_./:@+=,-]*$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** launch.csCommand is typed as is (a function name or a path), so it must be a plain word. */
const COMMAND_WORD_RE = /^[A-Za-z0-9_~./][A-Za-z0-9_./-]*$/u;

/** The preview shows these where the real values are not known yet. */
export const SESSION_ID_PLACEHOLDER = '<session id>';
export const ACCOUNT_PLACEHOLDER = '<account>';

/**
 * A resume keeps `--name`. If spike L8 finds Claude Code refusing --name with
 * --resume, this turns it off for resumes only.
 */
export const RESUME_KEEPS_NAME = true;

/** claude mode needs the absolute path of claude, found at daemon start (bins.claude). */
export const CLAUDE_MISSING = 'claude (Claude Code) was not found on this Mac';
/** Single mode (no cswap) starts sessions in claude mode only. */
export const NO_CSWAP_MODE = 'This Mac has no cswap. Run: jantar launch mode claude';
/** claude mode picks no account, so with cswap a start needs cs-shell or cswap-run. */
export const CSWAP_MODE = 'This Mac has cswap. Pick how to start sessions: jantar launch mode cswap-run';
/** v0.6: a server whose accounts are config dirs starts sessions in claude mode only. */
export const NO_CSWAP_DIRS = 'This machine has no cswap: its accounts are config dirs. Run: jantar launch mode claude';
/** v0.6: CLAUDE_CONFIG_DIR is typed only before claude, in claude mode. */
export const CONFIG_DIR_CLAUDE_ONLY = 'a config dir starts sessions in claude mode only';

/** Why this machine's accounts mode and launch.mode cannot start a session together, or null. */
export function accountsModeProblem(accounts: AccountsMode, mode: Settings['launch']['mode']): string | null {
  if (accounts === 'single') return mode === 'claude' ? null : NO_CSWAP_MODE;
  if (accounts === 'dirs') return mode === 'claude' ? null : NO_CSWAP_DIRS;
  return mode === 'claude' ? CSWAP_MODE : null;
}

/** Single-quote `s` for zsh/sh unless it is a plain word (Shed's shellQuote, shlex.quote's rule). */
export function q(s: string): string {
  if (PLAIN_RE.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function hasControlChars(s: string): boolean {
  return CONTROL_RE.test(s);
}

export interface CommandParts {
  /** Absolute realpath of the folder. */
  folder: string;
  /** null: the preview has no account yet (shown as <account>). */
  account: number | null;
  /** launchFlagArgs(flags). */
  args: readonly string[];
  /** The --session-id, or with `resume` the conversation to resume; null: the preview (shown as <session id>). */
  sid: string | null;
  /** v0.4: type `--resume <sid>` (a past conversation of this folder) instead of `--session-id <sid>`. */
  resume?: boolean;
  name: string;
  launch: Settings['launch'];
  /** ctx.bins.cswap (cswap-run mode). */
  cswap: string | null;
  /** ctx.bins.claude (claude mode). */
  claude: string | null;
  /**
   * v0.6, accountsMode "dirs" (a paired Linux or Windows server without
   * cswap): the picked account's config dir, typed as `env
   * CLAUDE_CONFIG_DIR=<dir>` before claude, with no `--`; null or absent for
   * ~/.claude (and in every other mode).
   */
  configDir?: string | null;
}

/** `setup`: the Mac's launch settings or tools are at fault (cswap missing, a bad launch.csCommand), not the folder. */
export type CommandResult = { ok: true; command: string } | { ok: false; reason: string; setup?: true };

/** The command line for a launch, or why it cannot be built. */
export function launchCommand(p: CommandParts): CommandResult {
  if (!p.folder.startsWith('/')) return { ok: false, reason: 'the folder is not an absolute path' };
  if (p.account !== null && (!Number.isInteger(p.account) || p.account < 0)) return { ok: false, reason: 'not an account number' };
  if (p.sid !== null && !UUID_RE.test(p.sid)) return { ok: false, reason: 'the session id is not a UUID' };
  if (p.resume && p.sid === null) return { ok: false, reason: 'a resume needs the id of the conversation' };
  if (!LaunchNameSchema.safeParse(p.name).success) return { ok: false, reason: 'the session name may use letters, digits, ".", "_" and "-" only' };
  // launchFlagArgs gives flags and one-word values only ("--effort", "ultracode").
  if (p.args.some((a) => !/^(?:--[a-z][a-z-]*|[A-Za-z]+)$/u.test(a))) return { ok: false, reason: 'unexpected claude flag' };
  const configDir = p.configDir ?? null;
  if (configDir !== null && !configDir.startsWith('/')) return { ok: false, reason: 'the config dir is not an absolute path' };
  if (configDir !== null && p.launch.mode !== 'claude') return { ok: false, reason: CONFIG_DIR_CLAUDE_ONLY, setup: true };
  const n = p.account === null ? ACCOUNT_PLACEHOLDER : String(p.account);
  const session = p.resume
    ? ['--resume', p.sid as string, ...(RESUME_KEEPS_NAME ? ['--name', q(p.name)] : [])]
    : ['--session-id', p.sid ?? SESSION_ID_PLACEHOLDER, '--name', q(p.name)];
  const tail = ['--', ...p.args.map(q), ...session].join(' ');
  let run: string;
  if (p.launch.mode === 'claude') {
    if (!p.claude || !p.claude.startsWith('/')) return { ok: false, reason: CLAUDE_MISSING, setup: true };
    run = [...(configDir !== null ? ['env', q(`CLAUDE_CONFIG_DIR=${configDir}`)] : []), q(p.claude), ...p.args.map(q), ...session].join(' ');
  } else if (p.launch.mode === 'cs-shell') {
    if (!COMMAND_WORD_RE.test(p.launch.csCommand)) return { ok: false, reason: 'launch.csCommand must be a plain command name', setup: true };
    run = `${p.launch.csCommand} ${n} ${tail}`;
  } else {
    if (!p.cswap) return { ok: false, reason: 'cswap was not found (install it, or on the Mac run: jantar launch mode cs-shell)', setup: true };
    const share = p.launch.shareHistory ? ' --share-history' : '';
    run = `${q(p.cswap)} run${share} ${n} ${tail}`;
    const pre = p.launch.preLaunchArgv;
    if (pre && pre.length > 0) run = `${pre.map((a) => q(a.replaceAll('{n}', n))).join(' ')} && ${run}`;
  }
  const command = `cd -- ${q(p.folder)} && ${run}`;
  if (hasControlChars(command)) return { ok: false, reason: 'the folder or a setting holds a control character' };
  return { ok: true, command };
}

/** A --name from a folder's basename: the characters LaunchNameSchema allows, at most 48. */
export function nameFromFolder(base: string): string {
  const s = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[^A-Za-z0-9]+/u, '')
    .slice(0, 48)
    .replace(/[-.]+$/u, '');
  return s || 'session';
}

/** `base`, or `base-2`, `base-3`, ... when a live session or another launch already has it. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const name = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!taken.has(name)) return name;
  }
  return base;
}
