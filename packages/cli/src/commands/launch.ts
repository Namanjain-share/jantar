/**
 * jantar launch: starting sessions from the phone (settings launch.*, Mac
 * only): the switch, the start sheet's default flags (decision U7: picks
 * from a fixed list, never free-text flags), how a session is started
 * (claude, cs-shell or cswap-run), and the pre-launch argv.
 *
 * The defaults are where the pickers begin for a device that never started
 * a session; after its first start a device begins from its own last picks.
 *
 * v0.4: `claude` mode types claude itself, for a Mac with one Claude login
 * and no cswap (the daemon's single-account mode). It picks no account, so
 * with cswap the daemon refuses it and names cswap-run instead; without
 * cswap it refuses cs-shell and cswap-run and names claude.
 */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DEFAULT_LAUNCH_FLAGS, ROUTES, launchFlagsDangerous, type DevicesResponse, type LaunchFlags, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { hasScopeNow } from '../lib/devices.js';
import { DANGEROUS_SENTENCE, FLAG_PICKS, flagArgsText, flagsText, picksFrom } from '../lib/launch.js';
import { shellQuote } from '../lib/remote.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, hasControlChars, onOff, parseOnOff } from '../lib/switches.js';

const FLAGS = {
  ...FLAG_PICKS,
  reset: { type: 'boolean', help: 'defaults: back to ask me (manual), Chrome off, default effort, default model' },
  clear: { type: 'boolean', help: 'pre-launch: run nothing before cswap' },
} as const;

const MODES = ['claude', 'cs-shell', 'cswap-run'] as const;
const PRE_LAUNCH_MAX_WORDS = 32;
const PRE_LAUNCH_MAX_CHARS = 1024;

function defaultsLines(f: LaunchFlags): string {
  return `  ${flagsText(f)}\n  claude ${flagArgsText(f)}\n${launchFlagsDangerous(f) ? `  ${DANGEROUS_SENTENCE}\n` : ''}`;
}

function modeLine(s: Settings['launch']): string {
  switch (s.mode) {
    case 'claude':
      return 'claude (types: cd -- <folder> && claude <flags> ..., for one Claude login without cswap)';
    case 'cs-shell':
      return `cs-shell (types: cd -- <folder> && ${s.csCommand} <account> -- <flags> ...)`;
    default:
      return 'cswap-run (types: cd -- <folder> && cswap run <account> -- <flags> ..., for setups without the cs shell function)';
  }
}

async function status(ctx: CliContext): Promise<number> {
  const { settings } = await readSettings(ctx);
  const l = settings.launch;
  ctx.io.out(`Starting sessions from the phone: ${onOff(l.enabled)}\n`);
  ctx.io.out(`Mode: ${modeLine(l)}\n`);
  ctx.io.out(`Pre-launch: ${l.preLaunchArgv ? `${shellQuote(l.preLaunchArgv)}${l.mode !== 'cswap-run' ? ' (cswap-run mode only)' : ''}` : 'none'}\n`);
  ctx.io.out(`Default flags (a device's first start; later it begins from its own last picks):\n${defaultsLines(l.defaultFlags)}`);
  ctx.io.out(`Limits: ${l.rate.perTenMin} starts per 10 min, ${l.rate.perDay} per day, ${l.rate.inFlight} starting at once\n`);
  return EXIT.ok;
}

/** After `launch on`: what else the phone needs (a folder, a device with the launch scope). */
async function onHints(ctx: CliContext, s: Settings, viaDaemon: boolean): Promise<void> {
  if (s.folders.roots.length === 0) {
    ctx.io.out(
      s.folders.sessionRoots
        ? "It can start in live sessions' folders. Add more: jantar folders add-root ~/Desktop\n"
        : 'Add a folder to start in: jantar folders add-root ~/Desktop\n',
    );
  }
  if (!viaDaemon) return;
  try {
    const { devices } = await callDaemon<DevicesResponse>(ctx.ctl, 'GET', ROUTES.listDevices.path);
    if (!devices.some((d) => !d.revokedAt && hasScopeNow(d.scopes, 'launch'))) {
      ctx.io.out('No paired device may start sessions yet: jantar devices grant <device> launch (see: jantar devices list)\n');
    }
  } catch {
    // only a hint
  }
}

async function setDefaults(ctx: CliContext, flags: Parameters<typeof picksFrom>[0] & { reset?: boolean }): Promise<number> {
  const picks = picksFrom(flags);
  const { settings } = await readSettings(ctx);
  if (!flags.reset && Object.keys(picks).length === 0) {
    ctx.io.out(`Default flags (a device's first start; later it begins from its own last picks):\n${defaultsLines(settings.launch.defaultFlags)}`);
    return EXIT.ok;
  }
  const next: LaunchFlags = { ...(flags.reset ? DEFAULT_LAUNCH_FLAGS : settings.launch.defaultFlags), ...picks };
  await changeSettings(ctx, { launch: { defaultFlags: next } }, (s) => `Default flags are now:\n${defaultsLines(s.launch.defaultFlags)}`);
  return EXIT.ok;
}

async function setMode(ctx: CliContext, mode: string | undefined): Promise<number> {
  if (mode === undefined) {
    ctx.io.out(`Mode: ${modeLine((await readSettings(ctx)).settings.launch)}\n`);
    return EXIT.ok;
  }
  if (!(MODES as readonly string[]).includes(mode)) throw new UsageError(`mode must be ${MODES.slice(0, -1).join(', ')} or ${MODES.at(-1)}`);
  await changeSettings(ctx, { launch: { mode } }, (s) => `Mode: ${modeLine(s.launch)}\n`);
  return EXIT.ok;
}

/** Why a pre-launch argv cannot be stored, or null. */
async function preLaunchProblem(argv: readonly string[]): Promise<string | null> {
  if (argv.length > PRE_LAUNCH_MAX_WORDS) return `at most ${PRE_LAUNCH_MAX_WORDS} words`;
  for (const a of argv) {
    if (a.length === 0 || a.length > PRE_LAUNCH_MAX_CHARS) return `every word must be 1 to ${PRE_LAUNCH_MAX_CHARS} characters`;
    if (hasControlChars(a)) return 'a word holds a control character (the line is typed into a Terminal window)';
  }
  const program = argv[0] as string;
  if (!isAbsolute(program)) return `give the program as an absolute path (e.g. /usr/bin/python3), not "${program}"`;
  try {
    await access(program, constants.X_OK);
  } catch {
    return `${program} is not an executable file`;
  }
  return null;
}

async function setPreLaunch(ctx: CliContext, argv: readonly string[], clear: boolean): Promise<number> {
  if (clear) {
    if (argv.length) throw new UsageError('give an argv or --clear, not both');
    await changeSettings(ctx, { launch: { preLaunchArgv: null } }, () => 'Pre-launch: none. cswap starts the session directly.\n');
    return EXIT.ok;
  }
  if (argv.length === 0) {
    const l = (await readSettings(ctx)).settings.launch;
    ctx.io.out(`Pre-launch: ${l.preLaunchArgv ? shellQuote(l.preLaunchArgv) : 'none'}\n`);
    return EXIT.ok;
  }
  const problem = await preLaunchProblem(argv);
  if (problem) throw new UsageError(`pre-launch: ${problem}`);
  await changeSettings(
    ctx,
    { launch: { preLaunchArgv: [...argv] } },
    (s) =>
      `Pre-launch: ${shellQuote(argv)}\nIt runs before cswap in the new window, with {n} replaced by the account.\n` +
      (s.launch.mode === 'cs-shell'
        ? 'It applies in cswap-run mode only: jantar launch mode cswap-run\n'
        : s.launch.mode === 'claude'
          ? 'It applies in cswap-run mode only: claude mode starts claude with nothing before it.\n'
          : ''),
  );
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'launch',
    summary: 'Turn starting sessions from the phone on or off, and set its defaults.',
    usage:
      'jantar launch <on|off|status|defaults [--permission P] [--chrome|--no-chrome] [--effort E] [--model M] [--reset]|mode <claude|cs-shell|cswap-run>|pre-launch -- <argv...> | --clear>',
    owner: 'T2',
    help:
      '  launch on | off            let paired devices with the launch scope start sessions (jantar devices grant)\n' +
      '  launch status              the switch, the mode, the default flags and the limits\n' +
      '  launch defaults [picks]    where the start sheet begins for a device that never started one\n' +
      '  launch mode <m>            claude types claude itself (one login, no cswap); cs-shell types your cs\n' +
      '                             function; cswap-run types cswap run itself\n' +
      '  launch pre-launch -- argv  run argv (absolute program path, {n} = account) before cswap (cswap-run mode)\n' +
      'Picks come from fixed lists only; there is no way to pass other claude flags.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1 });
    const [action, ...rest] = positionals;
    const picked = flags.permission !== undefined || flags.chrome !== undefined || flags.effort !== undefined || flags.model !== undefined;
    if ((picked || flags.reset) && action !== 'defaults') throw new UsageError('--permission, --chrome, --effort, --model and --reset are for "launch defaults"');
    if (flags.clear && action !== 'pre-launch') throw new UsageError('--clear is for "launch pre-launch"');
    if (action !== 'pre-launch' && rest.length > (action === 'mode' ? 1 : 0)) throw new UsageError(`unexpected argument "${rest.at(-1)}"`);
    switch (action) {
      case 'on':
      case 'off': {
        const on = parseOnOff(action, 'launch');
        const r = await changeSettings(ctx, { launch: { enabled: on } }, (s) =>
          on
            ? `Starting sessions from the phone is on. The start sheet begins from:\n${defaultsLines(s.launch.defaultFlags)}`
            : 'Starting sessions from the phone is off. Sessions already started keep running.\n',
        );
        if (on) await onHints(ctx, r.settings, r.via === 'daemon');
        return EXIT.ok;
      }
      case 'status':
        return status(ctx);
      case 'defaults':
        return setDefaults(ctx, flags);
      case 'mode':
        return setMode(ctx, rest[0]);
      case 'pre-launch':
        return setPreLaunch(ctx, rest, flags.clear === true);
      default:
        throw new UsageError(`unknown action "${action}" (on, off, status, defaults, mode or pre-launch)`);
    }
  },
);
