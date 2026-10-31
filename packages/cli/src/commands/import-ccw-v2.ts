/**
 * jantar import-ccw-v2: copy a ccw-v2 state dir (Jantar's name up to v0.3,
 * ~/.ccw-v2 by default) into an empty Jantar state dir, so paired phones,
 * push, settings and Life carry over. It copies only (lib/import-ccw-v2.ts):
 * nothing in the old dir is moved or deleted, and no data there changes. It
 * refuses while the target is not empty, a ccw-v2 daemon still answers on
 * the old ctl.sock, or ccw-v2's LaunchAgent is still installed; --dry-run
 * reports what it would copy and why it would refuse, and writes nothing.
 * Both name what else is in the old dir and stays there.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLI_NAME } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { defaultImportSource, planImport, runImport, type ImportedItem, type ImportPlan } from '../lib/import-ccw-v2.js';

const FLAGS = {
  from: { type: 'string', help: "ccw-v2's state dir (default ~/.ccw-v2)" },
  'dry-run': { type: 'boolean', short: 'n', help: 'show what would be copied and write nothing' },
} as const;

/** One line per file: where it lands, what it holds. */
function itemLines(items: readonly ImportedItem[]): string {
  const width = Math.max(...items.map((i) => i.to.length));
  return items
    .map((i) => {
      const renamed = i.to === i.from ? '' : ` (from ${i.from})`;
      const config = i.migrated ? ', moved to version 2 (as it was: config.json.v1)' : i.migrated === false ? ', already version 2' : '';
      return `  ${i.to.padEnd(width)}  ${i.what}${config}${renamed}\n`;
    })
    .join('');
}

/** The source's other entries (a tunnel config, backups of its own files), which stay where they are. */
function leftNote(plan: ImportPlan): string {
  if (!plan.left.length) return '';
  return (
    `\nLeft in ${plan.from}, not copied (not Jantar's; move any that something else still uses\n` +
    `before you delete ${plan.from}):\n${plan.left.map((n) => `  ${n}\n`).join('')}`
  );
}

/** Whether the copied config keeps no account for other work (ccw-v2 kept some in its code). */
async function keepsNone(to: string): Promise<boolean> {
  try {
    const kept = (JSON.parse(await readFile(join(to, 'config.json'), 'utf8')) as { accounts?: { kept?: unknown } }).accounts?.kept;
    return !Array.isArray(kept) || kept.length === 0;
  } catch {
    return false;
  }
}

export default defineCommand(
  {
    name: 'import-ccw-v2',
    summary: "Copy a ccw-v2 state dir (the old name) into Jantar's: devices, push keys, settings, Life.",
    usage: 'jantar import-ccw-v2 [--from DIR] [--dry-run]',
    owner: 'G',
    help:
      'Copies, never moves: ccw-v2.db (as jantar.db), life.db, config.json (then moved to version 2,\n' +
      'the copy as it was kept as config.json.v1), push/vapid.json and intel/captures.jsonl, each when\n' +
      'there. Paired phones stay paired. The target (~/.jantar, or $JANTAR_HOME) must be empty, and\n' +
      "ccw-v2's daemon must be stopped and its LaunchAgent removed first (ccw-v2 uninstall does both and keeps\n" +
      'its state dir).',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const plan = await planImport(ctx.paths, flags.from ?? defaultImportSource(ctx.paths));

    if (flags['dry-run']) {
      ctx.io.out(`Would copy ccw-v2's state from ${plan.from} into ${plan.to}:\n${itemLines(plan.items)}`);
      for (const r of plan.refusals) ctx.io.out(`A real run would refuse: ${r}\n`);
      ctx.io.out(`(dry run: nothing was written)\n${leftNote(plan)}`);
      return EXIT.ok;
    }
    if (plan.refusals.length) {
      for (const r of plan.refusals) ctx.io.err(`${CLI_NAME} import-ccw-v2: ${r}\n`);
      return EXIT.failed;
    }
    const done = await runImport(plan);
    const keep = (await keepsNone(plan.to))
      ? `  ${CLI_NAME} accounts keep <n...>    if ccw-v2 kept accounts for other work: name them again\n`
      : '';
    ctx.io.out(
      `Copied ccw-v2's state from ${plan.from} into ${plan.to}:\n${itemLines(done)}` +
        `Nothing in ${plan.from} was moved or deleted, and no data there was changed.\n` +
        leftNote(plan) +
        '\nNext:\n' +
        `  ${CLI_NAME} install                  start Jantar's daemon\n` +
        `  ${CLI_NAME} hooks install --apply    if ccw-v2's hooks were on: puts Jantar's in their place\n` +
        keep,
    );
    return EXIT.ok;
  },
);
