/**
 * jantar folders: the roots Files and New session may browse (settings
 * folders.*, Mac only), and the hidden home folders opened as exceptions.
 *
 * add-root checks the folder the way the daemon resolves a root (by name,
 * then by realpath, against the same hard denylist) and refuses /, /Users,
 * ~/Library and anything protected. `roots` asks the running daemon which
 * roots it serves right now, live sessions' folders included.
 */
import { ROUTES, type FilesRootsResponse, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import {
  ALLOW_MAX,
  addRoot,
  bareRootId,
  checkAllow,
  checkRoot,
  denyRulesFor,
  displayPath,
  findAllow,
  rootProblem,
} from '../lib/roots.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings } from '../lib/switches.js';
import { clip } from '../lib/text.js';

const FLAGS = {
  id: { type: 'string', help: 'add-root: the root id (default: from the folder name)' },
  label: { type: 'string', help: 'add-root: the name the phone shows (default: the folder name)' },
} as const;

/** The configured roots (and whether the daemon would serve each), the session-roots switch and the exceptions. */
export async function listRoots(ctx: CliContext, settings: Settings): Promise<void> {
  const f = settings.folders;
  const home = ctx.paths.userHome;
  if (f.roots.length === 0) {
    ctx.io.out('Roots: none yet. Add one: jantar folders add-root ~/Desktop\n');
  } else {
    ctx.io.out('Roots (Files and New session browse these):\n');
    const rules = await denyRulesFor(ctx.paths, f);
    const idW = Math.max(...f.roots.map((r) => r.id.length));
    const labelW = Math.max(...f.roots.map((r) => clip(r.label, 32).length));
    for (const r of f.roots) {
      const problem = await rootProblem(r, ctx.paths, rules);
      ctx.io.out(`  ${r.id.padEnd(idW)}  ${clip(r.label, 32).padEnd(labelW)}  ${clip(displayPath(r.path, home), 120)}${problem ? `  (${problem})` : ''}\n`);
    }
  }
  ctx.io.out(`Live sessions' folders: ${f.sessionRoots ? 'roots too' : 'not roots (folders.sessionRoots is off)'}\n`);
  if (f.allow.length) ctx.io.out(`Hidden home folders opened: ${f.allow.map((a) => clip(a, 80)).join(', ')}\n`);
}

function featuresHint(s: Settings): string {
  if (s.files.enabled || s.launch.enabled) return '';
  return 'Files and New session are both off: jantar files on, jantar launch on\n';
}

export async function addRootCommand(ctx: CliContext, input: string, opts: { id?: string; label?: string }): Promise<number> {
  const { settings } = await readSettings(ctx);
  const check = await checkRoot(input, ctx.paths, settings.folders);
  if (!check.ok) throw new Error(`not added: ${check.reason}`);
  const added = await addRoot(settings.folders, check.real, { ...opts, userHome: ctx.paths.userHome });
  if (!added.ok) throw new Error(`not added: ${added.reason}`);
  const { root } = added;
  await changeSettings(
    ctx,
    { folders: { roots: added.roots } },
    (s) => `Added root ${root.id} · ${clip(root.label, 32)} · ${displayPath(root.path, ctx.paths.userHome)}\n${featuresHint(s)}`,
  );
  return EXIT.ok;
}

export async function removeRootCommand(ctx: CliContext, id: string): Promise<number> {
  const { settings } = await readSettings(ctx);
  const bare = bareRootId(id);
  const root = settings.folders.roots.find((r) => r.id === bare);
  if (!root) throw new Error(`there is no root ${clip(bare, 30)} (see: jantar folders list)`);
  await changeSettings(
    ctx,
    { folders: { roots: settings.folders.roots.filter((r) => r.id !== bare) } },
    () => `Removed root ${root.id} (${displayPath(root.path, ctx.paths.userHome)}). Sessions already running there keep running.\n`,
  );
  return EXIT.ok;
}

async function liveRoots(ctx: CliContext): Promise<number> {
  const { roots } = await callDaemon<FilesRootsResponse>(ctx.ctl, 'GET', ROUTES.foldersRoots.path);
  if (roots.length === 0) {
    ctx.io.out('The daemon serves no roots right now. Add one: jantar folders add-root ~/Desktop\n');
    return EXIT.ok;
  }
  const idW = Math.max(...roots.map((r) => clip(r.id, 48).length));
  for (const r of roots) {
    const kind = r.kind === 'session' ? 'session' : 'root';
    ctx.io.out(`  ${clip(r.id, 48).padEnd(idW)}  ${kind.padEnd(7)}  ${clip(r.label, 32)}  ${clip(r.path ?? r.display, 120)}\n`);
  }
  return EXIT.ok;
}

async function allow(ctx: CliContext, input: string): Promise<number> {
  const { settings } = await readSettings(ctx);
  const check = await checkAllow(input, ctx.paths, settings.folders);
  if (!check.ok) throw new Error(`not allowed: ${check.reason}`);
  if (settings.folders.allow.includes(check.entry)) {
    ctx.io.out(`${check.entry} is already allowed.\n`);
    return EXIT.ok;
  }
  if (settings.folders.allow.length >= ALLOW_MAX) throw new Error(`there are already ${ALLOW_MAX} exceptions; remove one first`);
  await changeSettings(
    ctx,
    { folders: { allow: [...settings.folders.allow, check.entry] } },
    () => `Allowed ${check.entry}: under a root that reaches it, the phone may browse it (protected names inside stay hidden).\n`,
  );
  return EXIT.ok;
}

async function unallow(ctx: CliContext, input: string): Promise<number> {
  const { settings } = await readSettings(ctx);
  const entry = findAllow(settings.folders.allow, input, ctx.paths.userHome);
  if (!entry) throw new Error(`${clip(input, 80)} is not an exception (see: jantar folders list)`);
  await changeSettings(ctx, { folders: { allow: settings.folders.allow.filter((a) => a !== entry) } }, () => `${entry} is hidden again.\n`);
  return EXIT.ok;
}

export default defineCommand(
  {
    name: 'folders',
    summary: 'Add or remove the folders the phone may browse and start sessions in.',
    usage: 'jantar folders <list|roots|add-root <path> [--id ID] [--label L]|rm-root <id>|allow <path>|rm-allow <path>>',
    owner: 'T2',
    help:
      '  folders list               the roots set on this Mac, and the exceptions\n' +
      '  folders roots              what the running daemon serves now, live sessions\' folders included\n' +
      '  folders add-root <path>    add a root (refuses /, /Users, ~/Library and protected folders)\n' +
      '  folders rm-root <id>       remove one\n' +
      '  folders allow <path>       open a hidden home folder such as ~/.config/nvim (never ~/.ssh, ~/.claude*, ...)\n' +
      '  folders rm-allow <path>    hide it again\n' +
      'Files (jantar files on) and New session (jantar launch on) both use these roots.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 2 });
    const [action, arg] = positionals;
    const named = flags.id !== undefined || flags.label !== undefined;
    if (named && action !== 'add-root') throw new UsageError('--id and --label are for add-root');
    const one = (what: string): string => {
      if (arg === undefined) throw new UsageError(`${action} needs ${what}`);
      return arg;
    };
    switch (action) {
      case 'list':
        if (arg !== undefined) throw new UsageError('list takes no argument');
        await listRoots(ctx, (await readSettings(ctx)).settings);
        return EXIT.ok;
      case 'roots':
        if (arg !== undefined) throw new UsageError('roots takes no argument');
        return liveRoots(ctx);
      case 'add-root':
        return addRootCommand(ctx, one('a folder'), flags);
      case 'rm-root':
        return removeRootCommand(ctx, one('a root id'));
      case 'allow':
        return allow(ctx, one('a path'));
      case 'rm-allow':
        return unallow(ctx, one('a path'));
      default:
        throw new UsageError(`unknown action "${action}" (list, roots, add-root, rm-root, allow or rm-allow)`);
    }
  },
);
