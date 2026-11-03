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
 *
 * P2 (the CLI writes only imports, design 5):
 * - `work import <file> [--dry-run]`: a CSV or vCard file he names (at most
 *   1 MB), previewed by the daemon with its duplicate warnings, then
 *   imported as one batch with the defaults (a row with the same e-mail or
 *   phone as a client is skipped; a name-only match is added and flagged).
 *   It prints counts and row numbers, never a client's name.
 * - `work import undo <batch>`, `work imports`: the batch's Undo (7 days),
 *   and the newest imports.
 * - `work export --csv <file> [--deals]`: his clients (P3: or his deals) as
 *   a CSV where he names (a new file, 0600; never one that exists).
 * - `work lockscreen names on|off`: a follow-up's push names its words on a
 *   locked phone (life.workLockScreenNames; a Mac switch).
 * - `work settings`: Work's settings as the phone sets them.
 */
import { open, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { workOn, type Settings } from '@jantar/protocol';
import {
  WORK_LIMITS,
  WORK_ROUTES,
  type WorkImportPreviewReply,
  type WorkImportReply,
  type WorkImportsReply,
  type WorkImportUndoReply,
  type WorkSeedItem,
  type WorkSeedReply,
  type WorkSettings,
} from '@jantar/protocol/work';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { DaemonError, callDaemon, isErrorBody } from '../ctl.js';
import { expandPath } from '../lib/roots.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings } from '../lib/switches.js';
import { plural } from '../lib/text.js';

const FLAGS = {
  name: { type: 'string', help: 'seed: the project name, for one folder (default: from the folder name)' },
  'dry-run': { type: 'boolean', help: 'import: show what the file holds and import nothing' },
  csv: { type: 'string', help: 'export: the new file to write the clients (or the deals) to' },
  deals: { type: 'boolean', help: 'export: the deals instead of the clients' },
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

/** A file's text for an import: a regular file of at most WORK_LIMITS.importBytes, BOM and CRLF as they are. */
async function importText(file: string): Promise<string> {
  const path = resolve(file);
  const shown = basename(file).slice(0, 80);
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new UsageError(`${shown} is not a file`);
    size = st.size;
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`cannot read ${shown}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file' : 'it cannot be opened'}`);
  }
  if (size > WORK_LIMITS.importBytes) throw new UsageError(`${shown} is over 1 MB. Split it and import each part.`);
  const fh = await open(path, 'r');
  try {
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/** Row numbers as a person counts them (the file's first data row is 1), at most 20. */
function rowList(rows: readonly { index: number }[]): string {
  const n = rows.slice(0, 20).map((r) => String(r.index + 1));
  return `${n.join(', ')}${rows.length > 20 ? ', …' : ''}`;
}

/** `jantar work import <file> [--dry-run]`: previewed, then imported with the defaults. Names no client. */
async function importFile(ctx: CliContext, file: string, dryRun: boolean): Promise<number> {
  const format = ['.vcf', '.vcard'].includes(extname(file).toLowerCase()) ? 'vcf' : 'csv';
  const text = await importText(file);
  const p = await callDaemon<WorkImportPreviewReply>(ctx.ctl, 'POST', WORK_ROUTES.workImportPreview.path, { format, text });
  const skip = p.rows.filter((r) => r.action === 'skip');
  const named = p.rows.filter((r) => r.action === 'add' && r.dup?.why === 'name');
  const add = p.rows.filter((r) => r.action === 'add');
  const lines = [`${plural(p.rows.length + p.skipped, 'row')} in the file: ${add.length} to add, ${skip.length} already here (the same e-mail or phone), skipped.`];
  if (p.skipped) lines.push(`${plural(p.skipped, 'row')} with no name ${p.skipped === 1 ? 'is' : 'are'} left out.`);
  if (skip.length) lines.push(`Already here: rows ${rowList(skip)}.`);
  if (named.length) lines.push(`Same name as a client (added; check them on the phone): rows ${rowList(named)}.`);
  if (dryRun) {
    lines.push('Nothing imported (--dry-run).');
    ctx.io.out(`${lines.join('\n')}\n`);
    return EXIT.ok;
  }
  const r = await callDaemon<WorkImportReply>(ctx.ctl, 'POST', WORK_ROUTES.workImport.path, { previewId: p.previewId, rows: p.rows.map((x) => ({ index: x.index, action: x.action })) }, { idempotencyKey: ctx.deps.randomId() });
  lines.push(`Added ${plural(r.added, 'client')}. Undo it within ${WORK_LIMITS.importUndoDays} days: jantar work import undo ${r.batch}`);
  ctx.io.out(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

async function undoImport(ctx: CliContext, batch: string): Promise<number> {
  const r = await callDaemon<WorkImportUndoReply>(ctx.ctl, 'DELETE', WORK_ROUTES.workImportUndo.path.replace(':batch', encodeURIComponent(batch)));
  ctx.io.out(`Removed ${plural(r.removed, 'client')}.${r.kept ? ` Kept ${plural(r.kept, 'client')} changed or linked since.` : ''}\n`);
  return EXIT.ok;
}

async function listImports(ctx: CliContext): Promise<number> {
  const r = await callDaemon<WorkImportsReply>(ctx.ctl, 'GET', WORK_ROUTES.workImports.path);
  if (r.imports.length === 0) {
    ctx.io.out('No imports.\n');
    return EXIT.ok;
  }
  for (const i of r.imports) ctx.io.out(`${i.batch}  ${i.at.slice(0, 16).replace('T', ' ')}  added ${i.added}, filled ${i.filled}  undo until ${i.undoUntil.slice(0, 10)}\n`);
  return EXIT.ok;
}

/** `jantar work export --csv <file> [--deals]`: a new file where he names (never one that exists), 0600. */
async function exportCsv(ctx: CliContext, file: string, what: 'clients' | 'deals'): Promise<number> {
  const path = resolve(file);
  const res = await ctx.ctl.bytes(`${WORK_ROUTES.workExport.path}?what=${what}`);
  if (res.status < 200 || res.status >= 300) {
    let body: unknown = null;
    try {
      body = JSON.parse(res.body.toString('utf8'));
    } catch {
      body = null;
    }
    if (isErrorBody(body)) throw new DaemonError(res.status, body.error.code, body.error.message);
    throw new DaemonError(res.status, 'internal', `daemon answered HTTP ${res.status}`);
  }
  try {
    await writeFile(path, res.body, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new UsageError(`${basename(file)} exists already. Name a new file.`);
    throw new UsageError(`cannot write ${basename(file)}: ${(e as NodeJS.ErrnoException).code ?? 'it cannot be opened'}`);
  }
  const rows = Math.max(0, res.body.toString('utf8').trimEnd().split('\r\n').length - 1);
  ctx.io.out(`Wrote ${plural(rows, what === 'deals' ? 'deal' : 'client')} to ${path}\n`);
  return EXIT.ok;
}

async function showSettings(ctx: CliContext): Promise<number> {
  const s = await callDaemon<WorkSettings>(ctx.ctl, 'GET', WORK_ROUTES.workSettings.path);
  ctx.io.out(
    [
      `Businesses: ${s.businesses.length ? s.businesses.map((b) => b.name).join(', ') : 'none (add them on the phone: Work › Settings)'}`,
      `Dial code: ${s.dialCode ?? 'none'}`,
      `Quiet after: ${plural(s.quietDays, 'day')} with no touch`,
      `Lock screen: ${s.lockScreenNames ? 'follow-ups say their words' : 'follow-ups say only "Follow-up" (jantar work lockscreen names on)'}`,
    ].join('\n') + '\n',
  );
  return EXIT.ok;
}

/** The status line: on, off, or on but waiting for Todos (a config.json edited by hand). */
export function workLine(s: Pick<Settings, 'life'>): string {
  if (workOn(s)) return 'Work: on (projects, clients, follow-ups and deals, and one search across Jantar on the phone)\n';
  if (s.life.work) return 'Work: off, because Todos is off (jantar work on turns both on)\n';
  return 'Work: off (turn it on: jantar work on)\n';
}

/** What `work on` says when Todos came on with it. */
export const TODOS_TOO = "Todos is on too: Work's projects and follow-ups are todos.\n";

export default defineCommand(
  {
    name: 'work',
    summary: 'Turn Work (projects, clients, follow-ups, deals) on or off; import, export.',
    usage: 'jantar work <on|off|status|seed <folder...> [--name NAME]|import <file> [--dry-run]|import undo <batch>|imports|export --csv <file> [--deals]|lockscreen names <on|off>|settings>',
    owner: 'WP-WORK',
    help:
      '  work on        the phone shows Work: projects, clients and follow-ups, and search from every screen (turns Todos on too)\n' +
      "  work off       hide Work again (Todos stays as it is; nothing is deleted)\n" +
      '  work status    whether Work is on\n' +
      '  work seed <folder...> [--name NAME]\n' +
      '                 one project per folder, linked to it (folders inside one of your folders; one already linked is skipped)\n' +
      '  work import <file.csv|file.vcf> [--dry-run]\n' +
      '                 import clients from a file you name (a row with the same e-mail or phone as a client is skipped)\n' +
      '  work import undo <batch>\n' +
      '                 take an import back within 7 days (clients changed or linked since stay)\n' +
      '  work imports   the newest imports\n' +
      '  work export --csv <file> [--deals]\n' +
      '                 your clients (or, with --deals, your deals) as a CSV, in a new file you name\n' +
      '  work lockscreen names <on|off>\n' +
      "                 whether a follow-up's push says its words on a locked phone (off: \"Follow-up · 15:00\")\n" +
      "  work settings  Work's businesses, dial code and quiet days (set on the phone)\n" +
      'The switches change only here, at the Mac. Jantar never reads another app\'s contacts: only a file you name.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1 });
    const [action, ...rest] = positionals;
    const takes = (a: string | undefined) => a === 'seed' || a === 'import' || a === 'lockscreen';
    if (!takes(action) && rest.length) throw new UsageError(`${action} takes no argument`);
    if (action !== 'seed' && flags.name !== undefined) throw new UsageError('--name goes with seed');
    if (action !== 'import' && flags['dry-run']) throw new UsageError('--dry-run goes with import');
    if (action !== 'export' && flags.csv !== undefined) throw new UsageError('--csv goes with export');
    if (action !== 'export' && flags.deals) throw new UsageError('--deals goes with export');
    switch (action) {
      case 'seed':
        return seed(ctx, rest, flags.name);
      case 'import': {
        if (rest[0] === 'undo') {
          if (rest.length !== 2 || flags['dry-run']) throw new UsageError('import undo takes one batch id (jantar work imports lists them)');
          return undoImport(ctx, rest[1] as string);
        }
        if (rest.length !== 1) throw new UsageError('import takes one file (a .csv or a .vcf)');
        return importFile(ctx, rest[0] as string, flags['dry-run'] === true);
      }
      case 'imports':
        return listImports(ctx);
      case 'export':
        if (flags.csv === undefined) throw new UsageError('export needs --csv <file>, a new file to write');
        return exportCsv(ctx, flags.csv, flags.deals ? 'deals' : 'clients');
      case 'lockscreen': {
        const [what, value] = rest;
        if (what !== 'names' || (value !== 'on' && value !== 'off') || rest.length !== 2) throw new UsageError('lockscreen takes: names on, or names off');
        await changeSettings(ctx, { life: { workLockScreenNames: value === 'on' } }, (s) =>
          s.life.workLockScreenNames ? "Follow-ups' pushes say their words on a locked phone.\n" : 'Follow-ups\' pushes say only "Follow-up" and the time on a locked phone.\n',
        );
        return EXIT.ok;
      }
      case 'settings':
        return showSettings(ctx);
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
        throw new UsageError(`unknown action "${action}" (on, off, status, seed, import, imports, export, lockscreen or settings)`);
    }
  },
);
