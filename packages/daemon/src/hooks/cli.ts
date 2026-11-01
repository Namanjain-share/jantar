/**
 * `jantar hooks <install|uninstall|status>`: the command body. The CLI's
 * commands/hooks.ts is a thin wrapper around runHooksCommand().
 *
 * install and uninstall always show the diff first and only write after a
 * "y" (or --yes). Without a terminal to ask on and without --yes, nothing is
 * written. They edit one settings file, and end, like status, with the cswap
 * profile line: which slots share that file and which get no hooks.
 */
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { STATE_DIR_NAME } from '@jantar/protocol';
import type { Paths } from '../contracts.js';
import { loadSettings } from '../config.js';
import {
  hooksStatus,
  installHookClient,
  installHooks,
  planInstall,
  planUninstall,
  uninstallHooks,
  windowsClaudeLine,
  type HooksPlan,
  type HooksStatus,
  type ProfileLink,
} from './installer.js';

export const HOOKS_SUMMARY = 'Install, remove or inspect the opt-in Claude Code hooks.';

/** When the hooks take effect (docs/hook-protocol.md section 4). */
export const PICKUP =
  'Sessions pick hooks up on their next start or resume. A session that was\n' +
  'already running keeps going without cards; its dialogs are answered from the\n' +
  'phone through the screen.';
export const HOOKS_USAGE = 'jantar hooks <install|uninstall|status> [--settings <file>] [--yes] [--dry-run] [--json]';

const HELP = `usage: ${HOOKS_USAGE}

  install     add Jantar's hooks to Claude's settings, replacing ccw-v2's
              (shows the diff and asks first)
  uninstall   remove exactly Jantar's hook entries, and ccw-v2's (shows the
              diff and asks first)
  status      show which hooks are installed

options:
  --settings <file>  settings file to edit (default: ~/.claude/settings.json;
                     cswap profiles link their settings.json to it; a slot
                     with a file of its own gets no hooks until it is linked
                     or edited with --settings)
  --yes, -y          write without asking
  --dry-run, -n      show the diff only, write nothing
  --json             machine-readable output (status)

Hooks are fail-open: if jantard is not running they do nothing and Claude
behaves as before. Set JANTAR_SKIP_HOOKS=1 to turn them off for one session.
${PICKUP}
`;

export interface HooksCliIo {
  out(text: string): void;
  err(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
}

export interface HooksCliDeps {
  io: HooksCliIo;
  paths: Paths;
  /** Absolute node path to record. Default: settings.bins.node, then this process's node. */
  node?: string;
  /** Ask a yes/no question. Default: a prompt on the terminal when there is one. */
  ask?: (question: string) => Promise<boolean>;
  now?: () => Date;
}

const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

interface Flags {
  sub?: string;
  settings?: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(args: readonly string[]): Flags | string {
  const f: Flags = { yes: false, dryRun: false, json: false, help: false };
  let optionsDone = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (optionsDone || !a.startsWith('-')) {
      if (!f.sub) f.sub = a;
      else return `unexpected argument ${a}`;
      continue;
    }
    if (a === '--') optionsDone = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--dry-run' || a === '-n') f.dryRun = true;
    else if (a === '--json') f.json = true;
    else if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--settings') {
      const v = args[++i];
      if (!v) return '--settings needs a file';
      f.settings = v;
    } else if (a.startsWith('--settings=')) {
      f.settings = a.slice('--settings='.length);
      if (!f.settings) return '--settings needs a file';
    } else return `unknown option ${a}`;
  }
  return f;
}

async function defaultAsk(io: HooksCliIo, question: string): Promise<boolean | null> {
  if (!io.isTTY || !process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function nodePath(deps: HooksCliDeps): Promise<string> {
  if (deps.node) return deps.node;
  try {
    const loaded = await loadSettings(deps.paths);
    if (loaded.settings.bins.node) return loaded.settings.bins.node;
  } catch {
    // fall through
  }
  return process.execPath;
}

export async function runHooksCommand(args: readonly string[], deps: HooksCliDeps): Promise<number> {
  const { io, paths } = deps;
  const flags = parseArgs(args);
  if (typeof flags === 'string') {
    io.err(`jantar hooks: ${flags}\nusage: ${HOOKS_USAGE}\n`);
    return EXIT.usage;
  }
  if (flags.help || flags.sub === 'help') {
    io.out(HELP);
    return EXIT.ok;
  }
  const settingsPath = flags.settings ?? paths.claudeSettings;
  const ask = async (q: string): Promise<boolean | null> => (deps.ask ? deps.ask(q) : defaultAsk(io, q));

  switch (flags.sub) {
    case 'status':
      return status(deps, settingsPath, flags);
    case 'install':
      return install(deps, settingsPath, flags, ask);
    case 'uninstall':
      return uninstall(deps, settingsPath, flags, ask);
    default:
      io.err(`${flags.sub ? `jantar hooks: unknown subcommand "${flags.sub}"\n` : ''}usage: ${HOOKS_USAGE}\n`);
      return EXIT.usage;
  }
}

async function confirm(
  io: HooksCliIo,
  flags: Flags,
  ask: (q: string) => Promise<boolean | null>,
  file: string,
): Promise<boolean> {
  if (flags.yes) return true;
  const answer = await ask(`Write these changes to ${file}? [y/N] `);
  if (answer === null) {
    io.err('Nothing was written: no terminal to ask on. Re-run with --yes to write these changes.\n');
    return false;
  }
  if (!answer) io.err('Nothing was written.\n');
  return answer;
}

/**
 * A state dir other than ~/.jantar (JANTAR_HOME, e.g. a trial in /tmp) written
 * into the shared ~/.claude/settings.json: every cswap profile then runs the
 * client from that dir, and deleting it breaks every hook.
 */
function warnSharedSettings(deps: HooksCliDeps, settingsPath: string, realPath: string): void {
  const { io, paths } = deps;
  const defaultHome = join(paths.userHome, STATE_DIR_NAME);
  if (resolve(settingsPath) !== resolve(paths.claudeSettings) || resolve(paths.home) === resolve(defaultHome)) return;
  io.err(
    `Warning: the state dir is ${paths.home} (JANTAR_HOME), not ${defaultHome}, so the hooks will run the client in ${paths.binDir} ` +
      `and reach the daemon that uses that dir. They go into ${realPath}, which every cswap profile shares: ` +
      `run \`jantar hooks uninstall\` before you delete ${paths.home}, or every hook in every profile will fail.\n`,
  );
}

async function install(
  deps: HooksCliDeps,
  settingsPath: string,
  flags: Flags,
  ask: (q: string) => Promise<boolean | null>,
): Promise<number> {
  const { io, paths } = deps;
  const spec = { node: await nodePath(deps), hookBin: paths.hookBin };
  const plan = await planInstall({ settingsPath, ...spec });
  if (!plan.ok) {
    io.err(`jantar hooks install: ${plan.message}\n`);
    return EXIT.failed;
  }
  const code = await applyInstall(deps, settingsPath, flags, ask, plan, spec);
  await printProfiles(deps, settingsPath, spec.node, 'install');
  return code;
}

async function applyInstall(
  deps: HooksCliDeps,
  settingsPath: string,
  flags: Flags,
  ask: (q: string) => Promise<boolean | null>,
  plan: HooksPlan,
  spec: { node: string; hookBin: string },
): Promise<number> {
  const { io, paths } = deps;
  io.out(`Settings file: ${plan.realPath}${plan.isSymlink ? ` (linked from ${plan.settingsPath})` : ''}\n`);
  io.out(`Hook client:   ${paths.hookBin}\n`);
  warnSharedSettings(deps, settingsPath, plan.realPath);
  if (!plan.changed) io.out('The hooks are already installed; the settings file needs no change.\n');
  else io.out(`\n${plan.diff}\n`);
  if (flags.dryRun) {
    io.out('Dry run: nothing was written.\n');
    return EXIT.ok;
  }
  if (plan.changed && !(await confirm(io, flags, ask, plan.realPath))) return EXIT.failed;

  // The client goes in place first, so the hooks never point at a missing file.
  let client;
  try {
    client = await installHookClient({ hookBin: paths.hookBin });
  } catch (e) {
    io.err(`jantar hooks install: could not install the hook client: ${(e as Error).message}\n`);
    return EXIT.failed;
  }
  if (client.changed) io.out(`Installed the hook client at ${client.path}\n`);
  if (!plan.changed) return EXIT.ok;

  const res = await installHooks({ settingsPath, ...spec, expectedBefore: plan.before, ...(deps.now ? { now: deps.now } : {}) });
  if (!res.ok) {
    io.err(`jantar hooks install: ${res.message}\n`);
    return EXIT.failed;
  }
  if (res.backupPath) io.out(`Backed up the previous file to ${res.backupPath}\n`);
  io.out(`Installed jantar hooks for ${res.events.length} event${res.events.length === 1 ? '' : 's'}.\n${PICKUP}\n`);
  return EXIT.ok;
}

async function uninstall(
  deps: HooksCliDeps,
  settingsPath: string,
  flags: Flags,
  ask: (q: string) => Promise<boolean | null>,
): Promise<number> {
  const { io } = deps;
  const plan = await planUninstall({ settingsPath });
  if (!plan.ok) {
    io.err(`jantar hooks uninstall: ${plan.message}\n`);
    return EXIT.failed;
  }
  const code = await applyUninstall(deps, settingsPath, flags, ask, plan);
  await printProfiles(deps, settingsPath, await nodePath(deps), 'uninstall');
  return code;
}

async function applyUninstall(
  deps: HooksCliDeps,
  settingsPath: string,
  flags: Flags,
  ask: (q: string) => Promise<boolean | null>,
  plan: HooksPlan,
): Promise<number> {
  const { io } = deps;
  io.out(`Settings file: ${plan.realPath}${plan.isSymlink ? ` (linked from ${plan.settingsPath})` : ''}\n`);
  if (!plan.changed) {
    io.out('No jantar hooks are installed; nothing to remove.\n');
    return EXIT.ok;
  }
  io.out(`\n${plan.diff}\n`);
  if (flags.dryRun) {
    io.out('Dry run: nothing was written.\n');
    return EXIT.ok;
  }
  if (!(await confirm(io, flags, ask, plan.realPath))) return EXIT.failed;
  const res = await uninstallHooks({ settingsPath, expectedBefore: plan.before, ...(deps.now ? { now: deps.now } : {}) });
  if (!res.ok) {
    io.err(`jantar hooks uninstall: ${res.message}\n`);
    return EXIT.failed;
  }
  if (res.backupPath) io.out(`Backed up the previous file to ${res.backupPath}\n`);
  io.out(`Removed Jantar's hook entries from ${res.events.length} event${res.events.length === 1 ? '' : 's'}.\n`);
  return EXIT.ok;
}

const STATE_TEXT: Record<HooksStatus['state'], string> = {
  installed: 'installed',
  'not-installed': 'not installed',
  partial: 'partly installed (run `jantar hooks install` to complete)',
  outdated: 'installed but out of date (run `jantar hooks install` to update)',
  unreadable: 'unknown: the settings file could not be read',
};

async function status(deps: HooksCliDeps, settingsPath: string, flags: Flags): Promise<number> {
  const { io, paths } = deps;
  const st = await hooksStatus({
    settingsPath,
    node: await nodePath(deps),
    hookBin: paths.hookBin,
    profilesDir: paths.cswapProfiles,
  });
  if (flags.json) {
    io.out(`${JSON.stringify(st, null, 2)}\n`);
    return st.ok ? EXIT.ok : EXIT.failed;
  }
  io.out(`Settings file: ${st.realPath ?? st.settingsPath}${st.isSymlink ? ` (linked from ${st.settingsPath})` : ''}${st.exists ? '' : ' (does not exist yet)'}\n`);
  if (st.error) io.out(`  ${st.error.message}\n`);
  io.out(`Hooks: ${STATE_TEXT[st.state]}\n`);
  // v0.6, Windows: the exec-form hooks need a recent Claude Code (doctor names the one installed).
  if (st.minClaude) io.out(`  ${windowsClaudeLine()}\n`);
  if (st.state !== 'installed' && st.state !== 'not-installed' && st.state !== 'unreadable') {
    for (const e of st.events) if (e.state !== 'ok') io.out(`  ${e.event.padEnd(20)} ${e.state}\n`);
    if (st.strayEntries) io.out(`  ${st.strayEntries} entr${st.strayEntries === 1 ? 'y' : 'ies'} under events Jantar no longer uses\n`);
  }
  io.out(`Hook client: ${st.hookBin} (${st.hookBinPresent ? (st.hookBinCurrent ? 'installed' : 'installed, older copy') : 'not installed'})\n`);
  io.out(profileLines(st.profiles, 'install'));
  return st.ok ? EXIT.ok : EXIT.failed;
}

/**
 * The cswap profile line: how many profiles share the settings file, and
 * the slots that don't, which get no hooks from it, with what to do about
 * them. Slot numbers only, never a profile name or path: those carry account
 * details. '' when there are no profiles.
 */
export function profileLines(profiles: readonly ProfileLink[] | undefined, action: 'install' | 'uninstall'): string {
  if (!profiles || profiles.length === 0) return '';
  const slot = (p: ProfileLink) => p.name.match(/^\d+/)?.[0] ?? '?';
  const linked = profiles.filter((p) => p.settings === 'linked').length;
  const own = profiles.filter((p) => p.settings === 'separate').map(slot);
  const none = profiles.filter((p) => p.settings === 'missing').map(slot);
  let line = `cswap profiles: ${linked} of ${profiles.length} share this settings file`;
  if (own.length === 1) line += `; slot ${own[0]} uses its own file and gets no hooks`;
  else if (own.length > 1) line += `; slots ${own.join(', ')} use their own files and get no hooks`;
  if (none.length === 1) line += `; slot ${none[0]} has no settings file and gets no hooks`;
  else if (none.length > 1) line += `; slots ${none.join(', ')} have no settings file and get no hooks`;
  line += '\n';
  const several = own.length + none.length > 1;
  if (action === 'install' && own.length + none.length > 0) {
    line += several
      ? 'Link them to the main file, or run `jantar hooks install --settings <that file>` for each.\n'
      : 'Link it to the main file, or run `jantar hooks install --settings <that file>`.\n';
  } else if (action === 'uninstall' && own.length > 0) {
    line +=
      own.length > 1
        ? 'This leaves their own files as they are; run `jantar hooks uninstall --settings <that file>` for each.\n'
        : 'This leaves its own file as it is; run `jantar hooks uninstall --settings <that file>` for it.\n';
  }
  return line;
}

/** End install and uninstall with the profile line (it only reads: lstat and realpath of each profile's settings.json). */
async function printProfiles(deps: HooksCliDeps, settingsPath: string, node: string, action: 'install' | 'uninstall'): Promise<void> {
  const st = await hooksStatus({ settingsPath, node, hookBin: deps.paths.hookBin, profilesDir: deps.paths.cswapProfiles });
  deps.io.out(profileLines(st.profiles, action));
}
