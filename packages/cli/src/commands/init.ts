/**
 * jantar init (v0.4, spec 7.1): first-run setup in four steps.
 *
 *   1. This Mac     Node, claude, cswap and its profiles, macOS and
 *                   Terminal.app, an existing config ("Change it? [y/N]")
 *   2. Accounts     cswap's accounts (which to keep for other work) or one
 *                   Claude login
 *   3. Launching    the launch mode this Mac can use (claude, or cswap-run
 *                   with cswap), the starting flags, launching on or off, and
 *                   the folders the phone may browse and start sessions in
 *   4. Next steps   install, remote setup, pair; Life and the Intel shelf
 *
 * It only finds things (file metadata and `which`-style lookups: it runs no
 * program) and writes settings, after asking: over ctl.sock when a daemon of
 * this version runs, else config.json (0600, after migrateSettingsFile),
 * inside the state dir and nowhere else. `--yes` takes every default, and
 * leaves an existing config as it is.
 */
import { CLI_NAME, PRODUCT_NAME, type FolderRoot } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { createAsker, type Asker } from '../lib/init/ask.js';
import { detect, otherDaemonText, type Detected } from '../lib/init/detect.js';
import { MODE_TEXT, PERMISSION_CHOICES, accountListText, initPatch, launchModeFor, nextSteps, parseAccountList, type InitAnswers } from '../lib/init/plan.js';
import { ROOTS_MAX, addRoot, checkRoot, displayPath } from '../lib/roots.js';
import { updateSettings } from '../lib/settings.js';
import { clip } from '../lib/text.js';

const FLAGS = {
  yes: { type: 'boolean', short: 'y', help: 'take every default without asking (an existing config is left as it is)' },
} as const;

function found(ctx: CliContext, d: Detected): void {
  const home = ctx.paths.userHome;
  const out = (label: string, text: string) => ctx.io.out(`  ${label.padEnd(9)} ${text}\n`);
  ctx.io.out('1. This Mac\n');
  out('Node', d.node.ok ? d.node.version : `${d.node.version}: too old, ${PRODUCT_NAME} needs Node 22.13 or newer`);
  out('Claude', d.claude ? displayPath(d.claude, home) : 'not found: install Claude Code (sessions still show from their files)');
  const c = d.cswap;
  const cswap = c.bin
    ? `${displayPath(c.bin, home)}, ${c.profiles} profile${c.profiles === 1 ? '' : 's'}`
    : 'not found (optional: it adds usage bars and more than one account)';
  out('cswap', `${cswap}${c.forcedSingle ? ' (JANTAR_ACCOUNTS=single: one account)' : ''}`);
  out('macOS', !d.mac ? `no: ${PRODUCT_NAME} runs on macOS with Terminal.app` : d.terminal ? 'yes, with Terminal.app' : 'yes, but Terminal.app was not found');
  out('Settings', d.config.exists ? `${displayPath(d.config.path, home)}${d.config.error ? ` (unusable: ${d.config.error})` : ''}` : `none yet (this writes ${displayPath(d.config.path, home)})`);
  if (d.daemon.kind === 'this') out('Daemon', `running (${d.daemon.version}); settings change through it`);
}

async function accounts(ctx: CliContext, ask: Asker, d: Detected): Promise<number[]> {
  ctx.io.out('\n2. Accounts\n');
  if (d.cswap.mode === 'single') {
    ctx.io.out('  One Claude login: single-account mode.\n');
    if (!d.cswap.forcedSingle) ctx.io.out('  cswap is optional; with it (and its profiles) this Mac shows usage and every account.\n');
    return d.settings.accounts.kept;
  }
  const n = d.cswap.profiles;
  ctx.io.out(`  Found cswap with ${n} account${n === 1 ? '' : 's'}: multi-account mode.\n`);
  const current = d.settings.accounts.kept;
  return ask.parsed(
    `  Accounts to keep for other work (Auto, Rewrite, Ask Claude and Ask never pick them), numbers or none [${accountListText(current)}]: `,
    (a) => parseAccountList(a, current),
    current,
  );
}

async function folders(ctx: CliContext, ask: Asker, d: Detected): Promise<FolderRoot[]> {
  let roots = [...d.settings.folders.roots];
  const tryAdd = async (input: string): Promise<boolean> => {
    const folders = { ...d.settings.folders, roots };
    const check = await checkRoot(input, ctx.paths, folders);
    if (!check.ok) {
      ctx.io.err(`  Not added: ${check.reason}\n`);
      return false;
    }
    const added = await addRoot(folders, check.real, { userHome: ctx.paths.userHome });
    if (!added.ok) {
      ctx.io.err(`  Not added: ${added.reason}\n`);
      return false;
    }
    roots = added.roots;
    ctx.io.out(`  Added ${added.root.id} · ${clip(added.root.label, 32)} · ${displayPath(added.root.path, ctx.paths.userHome)}\n`);
    return true;
  };
  if (ask.auto) return roots;
  const taken = new Set(roots.map((r) => r.path));
  for (const p of d.suggestions) {
    if (taken.has(p) || roots.length >= ROOTS_MAX) continue;
    if (await ask.yesNo(`  Let the phone browse and start sessions in ${displayPath(p, ctx.paths.userHome)}?`, false)) await tryAdd(p);
  }
  while (roots.length < ROOTS_MAX) {
    const more = await ask.text('  Another folder for the phone (a path, or Enter when done): ');
    if (!more) break;
    await tryAdd(more);
  }
  return roots;
}

async function launching(ctx: CliContext, ask: Asker, d: Detected): Promise<Omit<InitAnswers, 'kept' | 'roots'>> {
  ctx.io.out('\n3. Launching and folders\n');
  const mode = launchModeFor(d.cswap.mode, d.settings.launch.mode);
  ctx.io.out(`  Sessions start with: ${MODE_TEXT[mode]}\n`);
  const permission = await ask.choose('  How should a new session start?', PERMISSION_CHOICES, d.settings.launch.defaultFlags.permission);
  const launchOn = await ask.yesNo('  Let paired phones start new sessions (you grant each phone later)?', d.settings.launch.enabled);
  return { mode, permission, launchOn };
}

function summary(ctx: CliContext, a: InitAnswers, multi: boolean): void {
  const perm = PERMISSION_CHOICES.find((c) => c.key === a.permission)?.label ?? a.permission;
  ctx.io.out('\n  Settings:\n');
  if (multi) ctx.io.out(`    kept for other work  ${accountListText(a.kept)}\n`);
  ctx.io.out(`    launch mode          ${a.mode}\n`);
  ctx.io.out(`    sessions start       ${perm}\n`);
  ctx.io.out(`    phones may start     ${a.launchOn ? 'yes' : 'no'}\n`);
  ctx.io.out(`    folders              ${a.roots.length ? a.roots.map((r) => displayPath(r.path, ctx.paths.userHome)).join(', ') : 'none'}\n`);
}

export default defineCommand(
  {
    name: 'init',
    summary: 'First-run setup: find Claude Code and cswap, then write the settings this Mac needs.',
    usage: 'jantar init [--yes]',
    owner: 'WP-OSS',
    help:
      'Four steps: what this Mac has, accounts, launching and folders, then what to run next.\n' +
      'It runs no program and writes settings only, after asking (--yes takes every default and\n' +
      'leaves an existing config as it is). Then: jantar install, jantar remote setup, jantar pair.',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const auto = flags.yes === true;
    if (!auto && !ctx.io.ask) throw new UsageError('init asks a few questions: run it in a terminal, or add --yes to take every default');
    const ask = createAsker(ctx.io, auto);

    const d = await detect(ctx);
    if (d.daemon.kind === 'other') {
      ctx.io.err(otherDaemonText('init', d.daemon, ctx.paths.home));
      return EXIT.failed;
    }
    found(ctx, d);
    if (d.config.error && d.daemon.kind !== 'this') {
      ctx.io.err(`\n${CLI_NAME} init: ${d.config.path} cannot be used (${d.config.error}). Fix it or move it aside, then run init again.\n`);
      return EXIT.failed;
    }
    if (d.config.exists) {
      if (auto) {
        ctx.io.out(`\nA config exists; it is left as it is. Run ${CLI_NAME} init without --yes to change it.\n`);
        return EXIT.ok;
      }
      if (!(await ask.yesNo('\nA config exists. Change it?', false))) {
        ctx.io.out('Left as it is.\n');
        return EXIT.ok;
      }
    }

    const kept = await accounts(ctx, ask, d);
    const launch = await launching(ctx, ask, d);
    const roots = await folders(ctx, ask, d);
    const answers: InitAnswers = { kept, ...launch, roots };
    const multi = d.cswap.mode === 'cswap';
    summary(ctx, answers, multi);

    const r = await updateSettings(ctx, initPatch(d.settings, answers));
    ctx.io.out(r.via === 'daemon' ? '  Saved through the running daemon.\n' : `  Saved to ${displayPath(ctx.paths.configFile, ctx.paths.userHome)}.\n`);

    ctx.io.out(`\n4. ${nextSteps(answers, multi)}`);
    return EXIT.ok;
  },
);
