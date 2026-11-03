/**
 * jantar work (v0.13): the Mac-only switch of Work, a Life module (settings
 * life.work; a phone can never change it). Work's projects and follow-ups
 * are todos, so `work on` turns Todos on too and says so; `work off` leaves
 * Todos as it is. `jantar life off todos` turns Work off with it.
 *
 * Switches go through the daemon over ctl.sock (with the daemon down they
 * land in config.json, lib/settings.ts). `work seed <folder...>` makes one
 * project per folder he names (inside one of his configured folders), its
 * folder linked, through the daemon (POST /v1/work/seed); never automatic.
 */
import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import { workOn, type Settings } from '@jantar/protocol';
import { WORK_LIMITS, WORK_ROUTES, type WorkSeedItem, type WorkSeedReply } from '@jantar/protocol/work';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { expandPath } from '../lib/roots.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings } from '../lib/switches.js';
import { plural } from '../lib/text.js';

const FLAGS = {
  name: { type: 'string', help: 'seed: the project name, for one folder (default: from the folder name)' },
} as const;

/** A project name from a folder name: "acme-web_app" is "Acme Web App" (at most 60 characters). */
export function nameFromFolder(folder: string): string {
  const words = basename(folder)
    .split(/[-_.\s]+/u)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return (words.join(' ') || basename(folder)).slice(0, 60).trim();
}

async function realOr(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** The configured root holding `folder` (the deepest), as the browsers address it: `r.<id>` and the path in it. */
async function addressOf(folder: string, s: Settings, userHome: string): Promise<{ root: string; path: string } | null> {
  const real = await realOr(folder);
  let best: { root: string; path: string; depth: number } | null = null;
  for (const r of s.folders.roots) {
    const rootReal = await realOr(expandPath(r.path, userHome));
    const rel = relative(rootReal, real);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(sep)) continue;
    const depth = rootReal.split(sep).length;
    if (!best || depth > best.depth) best = { root: `r.${r.id}`, path: rel.split(sep).join('/'), depth };
  }
  return best ? { root: best.root, path: best.path } : null;
}

/** `jantar work seed <folder...>`: one project per folder, its folder linked (never automatic). */
async function seed(ctx: CliContext, folders: readonly string[], name: string | undefined): Promise<number> {
  if (folders.length === 0) throw new UsageError('seed needs one folder or more, inside one of your folders (jantar folders list)');
  if (folders.length > WORK_LIMITS.seedItems) throw new UsageError(`seed takes at most ${WORK_LIMITS.seedItems} folders at a time`);
  if (name !== undefined && folders.length !== 1) throw new UsageError('--name goes with one folder');
  const { settings } = await readSettings(ctx);
  const items: WorkSeedItem[] = [];
  for (const f of folders) {
    const abs = expandPath(f, ctx.paths.userHome);
    const at = await addressOf(abs, settings, ctx.paths.userHome);
    if (!at) throw new UsageError(`${f} is not inside one of your folders. Add one first: jantar folders add-root <path>`);
    items.push({ ...at, name: (name ?? nameFromFolder(abs)).trim() || 'Project' });
  }
  const r = await callDaemon<WorkSeedReply>(ctx.ctl, 'POST', WORK_ROUTES.foldersSeed.path, { items }, { idempotencyKey: ctx.deps.randomId() });
  const made = r.projects.length;
  ctx.io.out(`Made ${plural(made, 'project')}, each linked to its folder.${r.skipped ? ` ${plural(r.skipped, 'folder')} already had one.` : ''}\n`);
  return EXIT.ok;
}

/** The status line: on, off, or on but waiting for Todos (a config.json edited by hand). */
export function workLine(s: Pick<Settings, 'life'>): string {
  if (workOn(s)) return 'Work: on (projects as a hub, and one search across Jantar on the phone)\n';
  if (s.life.work) return 'Work: off, because Todos is off (jantar work on turns both on)\n';
  return 'Work: off (turn it on: jantar work on)\n';
}

/** What `work on` says when Todos came on with it. */
export const TODOS_TOO = "Todos is on too: Work's projects and follow-ups are todos.\n";

export default defineCommand(
  {
    name: 'work',
    summary: 'Turn Work (projects as a hub, search on the phone) on or off.',
    usage: 'jantar work <on|off|status|seed <folder...> [--name NAME]>',
    owner: 'WP-WORK',
    help:
      '  work on        the phone shows Work: each project as one screen, and search from every screen (turns Todos on too)\n' +
      "  work off       hide Work again (Todos stays as it is; nothing is deleted)\n" +
      '  work status    whether Work is on\n' +
      '  work seed <folder...> [--name NAME]\n' +
      '                 one project per folder, linked to it (folders inside one of your folders; one already linked is skipped)\n' +
      'The switch changes only here, at the Mac.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1 });
    const [action, ...rest] = positionals;
    if (action !== 'seed' && rest.length) throw new UsageError(`${action} takes no argument`);
    if (action !== 'seed' && flags.name !== undefined) throw new UsageError('--name goes with seed');
    switch (action) {
      case 'seed':
        return seed(ctx, rest, flags.name);
      case 'on': {
        const before = (await readSettings(ctx)).settings;
        await changeSettings(ctx, { life: { work: true, todos: true } }, (s) => `${workLine(s)}${before.life.todos ? '' : TODOS_TOO}`);
        return EXIT.ok;
      }
      case 'off':
        await changeSettings(ctx, { life: { work: false } }, (s) => `${workLine(s)}Its projects stay in Todos.\n`);
        return EXIT.ok;
      case 'status': {
        const { settings } = await readSettings(ctx);
        ctx.io.out(workLine(settings));
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}" (on, off, status or seed)`);
    }
  },
);
