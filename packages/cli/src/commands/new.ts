/**
 * jantar new <folder>: start a Claude session in a new Terminal window, the
 * way the phone's start sheet does (POST /v1/launches over ctl.sock, spec
 * 3.10): the same account choice, the same allowlisted flag picks (U7), the
 * same startup dialogs as cards on the phone (U8).
 *
 * - The folder must lie under a root the daemon serves (a configured root or
 *   a live session's folder); the CLI finds which, by realpath.
 * - Picks left out come from launch.defaultFlags, not from an earlier start,
 *   so the same command line always starts the same way. The flags are
 *   printed and sent as picks; the daemon builds the argv.
 * - The CLI cannot answer a startup dialog (launchAnswer is never served on
 *   ctl.sock, so no session can answer its own): it says what waits, and the
 *   phone or the window answers it.
 * - v0.4 `--resume <id|last>`: a past conversation of the folder, as the
 *   start sheet's Resume row picks one. `last` is the newest entry of
 *   GET /v1/launch/history that is not running (a running one is open
 *   already), sent as its id like any other; the daemon checks the id
 *   against that history again, types `--resume <id>` and pins the account
 *   the conversation is kept on.
 * - v0.4 claude mode starts only with one Claude login (the daemon refuses
 *   it with cswap), so in that mode no account is printed: there is one.
 * - v0.6 `--node <name>`: start on a paired server instead (Fleet). The
 *   folder is that server's absolute path, matched against the roots the
 *   server serves (`?node=` on every folders and launch call, which the Mac
 *   forwards); picks left out come from the server's own defaults, and its
 *   own switches (`jantar launch on` there) decide.
 */
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  LAUNCH_FINAL_STAGES,
  LAUNCH_PROMPT_MAX,
  LaunchNameSchema,
  PastSessionSchema,
  ROUTES,
  buildPath,
  launchFlagsDangerous,
  type FilesRootsResponse,
  type LaunchFlags,
  type LaunchGetResponse,
  type LaunchHistoryResponse,
  type LaunchJob,
  type LaunchJobResponse,
  type LaunchPreview,
  type LaunchStartBody,
  type PastSession,
  type SettingsResponse,
} from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { DaemonError, callDaemon } from '../ctl.js';
import { DANGEROUS_SENTENCE, FLAG_PICKS, flagsText, locateIn, picksFrom, realFolder } from '../lib/launch.js';
import { displayPath, expandPath } from '../lib/roots.js';
import { clip } from '../lib/text.js';
import { findMachine } from './node.js';

const FLAGS = {
  ...FLAG_PICKS,
  account: { type: 'string', short: 'a', help: 'an account number, or auto (most 5-hour room; the default)' },
  name: { type: 'string', help: 'the session name (default: the folder name, -2, -3 when taken)' },
  prompt: { type: 'string', help: 'a first prompt, sent with proof once the session is ready ("-" reads stdin)' },
  'confirm-held': { type: 'boolean', help: 'start on an account held for other work anyway' },
  resume: { type: 'string', help: 'resume a past conversation of this folder: its id, or last (the newest not running now)' },
  preview: { type: 'boolean', help: 'show the account, the flags and the command line; start nothing' },
  wait: { type: 'boolean', help: 'wait until the session is ready (default; --no-wait returns once queued)' },
  timeout: { type: 'number', help: 'seconds to wait (default 300)' },
  json: { type: 'boolean', help: 'print the final launch as JSON' },
  node: { type: 'string', help: "v0.6: start on this paired server (jantar node list); the folder is its absolute path there" },
} as const;

const POLL_MS = 1000;
const DEFAULT_TIMEOUT_S = 300;

function parseAccount(raw: string | undefined): number | 'auto' {
  if (raw === undefined || raw === 'auto') return 'auto';
  if (!/^\d{1,6}$/.test(raw)) throw new UsageError(`--account must be a number or auto (got "${clip(raw, 20)}")`);
  return Number(raw);
}

function isFinal(job: LaunchJob): boolean {
  return LAUNCH_FINAL_STAGES.includes(job.stage);
}

/** --resume: "last", or a conversation id (the daemon checks it against the folder's history). */
function parseResume(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === 'last') return raw;
  const id = raw.toLowerCase();
  if (!PastSessionSchema.shape.id.safeParse(id).success) throw new UsageError(`--resume takes a conversation id or last (got "${clip(raw, 40)}")`);
  return id;
}

/** "0b4e7c4e-… · 2026-01-15 09:30 UTC · on account 2 · "fix the push example"" */
function pastText(p: PastSession): string {
  const parts = [p.id, `${p.lastAt.slice(0, 16).replace('T', ' ')} UTC`];
  if (p.account !== null) parts.push(`on account ${p.account}`);
  if (p.first) parts.push(`"${p.first}"`);
  if (p.live) parts.push('running now');
  return parts.join(' · ');
}

function previewText(p: LaunchPreview, resume: PastSession | string | undefined, single: boolean): string {
  const lines = [`Start in ${p.display}`];
  if (!single) lines.push(`  account  ${p.account.pick ?? 'none'} · ${clip(p.account.reason, 120)}`);
  lines.push(`  flags    ${flagsText(p.flags)}`, `  name     ${p.name}`);
  if (resume !== undefined) lines.push(`  resume   ${typeof resume === 'string' ? resume : pastText(resume)}`);
  lines.push(`  command  ${clip(p.command, 400)}`);
  if (launchFlagsDangerous(p.flags)) lines.push(`  ! ${DANGEROUS_SENTENCE}`);
  for (const w of p.warnings) lines.push(`  ! ${clip(w.text, 160)}`);
  return `${lines.join('\n')}\n`;
}

/** Follow a launch until it ends or `timeoutS` passes, printing each new step and the dialog it waits on. */
async function follow(ctx: CliContext, first: LaunchJob, timeoutS: number): Promise<LaunchJob> {
  let job = first;
  let shown = 0;
  let dialog: string | null = null;
  const report = (j: LaunchJob) => {
    for (const s of j.steps.slice(shown)) ctx.io.err(`  ${s.stage}: ${clip(s.detail, 120)}\n`);
    shown = j.steps.length;
    if (j.stage === 'dialog' && j.dialog && j.dialog.title !== dialog) {
      dialog = j.dialog.title;
      ctx.io.err(
        `  Waiting on "${clip(j.dialog.title, 80)}" (${j.dialog.options.map((o) => clip(o, 40)).join(' / ')}).\n` +
          '  Answer it on your phone (a card) or in the new Terminal window.\n',
      );
    }
  };
  report(job);
  const deadline = ctx.deps.now() + timeoutS * 1000;
  while (!isFinal(job) && ctx.deps.now() < deadline) {
    await ctx.deps.sleep(POLL_MS);
    try {
      job = (await callDaemon<LaunchGetResponse>(ctx.ctl, 'GET', buildPath(ROUTES.launchGet, { id: first.id }))).job;
    } catch (e) {
      if (e instanceof DaemonError && e.status === 404) continue;
      throw e;
    }
    report(job);
  }
  return job;
}

export default defineCommand(
  {
    name: 'new',
    summary: 'Start a session in a new Terminal window, as the phone does (account, flag picks, startup dialogs).',
    usage:
      'jantar new <folder> [--account N|auto] [--permission P] [--chrome|--no-chrome] [--effort E] [--model M] [--name NAME] [--prompt TEXT|-] [--resume ID|last] [--preview] [--no-wait] [--node NAME]',
    owner: 'T2',
    help:
      '<folder> must lie under a root (jantar folders list) or a live session\'s folder; starting must be on (jantar launch on).\n' +
      'Picks left out come from the defaults (jantar launch defaults). There is no way to pass other claude flags.\n' +
      '--resume opens a past conversation of the folder instead of a new one (last: the newest not running now); a\n' +
      'conversation kept on one account starts there.\n' +
      '--node NAME starts on a paired server (Fleet): the folder is its absolute path there, under a root that\n' +
      'server serves, and starting must be on at that server.\n' +
      'Exit status: 0 started (and the first prompt proven), 1 not started or the prompt not sent, 3 daemon not running.',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(argv, FLAGS, { min: 1, max: 1 });
    const picks = picksFrom(flags);
    const account = parseAccount(flags.account);
    const wanted = parseResume(flags.resume);
    if (flags.name !== undefined && !LaunchNameSchema.safeParse(flags.name).success) {
      throw new UsageError('--name may use letters, digits, ".", "_" and "-" (at most 48, starting with a letter or digit)');
    }
    let prompt = flags.prompt;
    if (prompt === '-') {
      if (!ctx.io.readStdin) throw new UsageError('cannot read stdin here');
      prompt = (await ctx.io.readStdin()).replace(/\r?\n$/, '');
    }
    if (prompt !== undefined && !prompt.trim()) throw new UsageError('the first prompt is empty');
    if (prompt !== undefined && prompt.length > LAUNCH_PROMPT_MAX) throw new UsageError(`the first prompt is longer than ${LAUNCH_PROMPT_MAX} characters`);
    const timeoutS = flags.timeout ?? DEFAULT_TIMEOUT_S;
    if (timeoutS <= 0) throw new UsageError('--timeout must be positive');

    const input = positionals[0] as string;
    // v0.6: on a server, every folders and launch call carries ?node= (the Mac forwards it).
    let node: { id: string; name: string } | null = null;
    if (flags.node !== undefined) {
      const row = await findMachine(ctx, flags.node);
      if (!row) throw new Error(`no paired server named "${clip(flags.node, 40)}" (see: jantar node list)`);
      node = { id: row.id, name: row.name };
    }
    const onNode = (q: URLSearchParams) => {
      if (node) q.set('node', node.id);
      return q;
    };
    let real: string;
    let shown: string;
    if (node) {
      if (!posix.isAbsolute(input)) throw new UsageError(`with --node, give the folder's absolute path on ${node.name} (e.g. /home/sam/code/api)`);
      real = posix.normalize(input).replace(/(.)\/+$/, '$1');
      shown = real;
    } else {
      const local = await realFolder(input, ctx.paths.userHome);
      if (!local || !(await stat(local)).isDirectory()) throw new Error(`no such folder: ${expandPath(input, ctx.paths.userHome)}`);
      real = local;
      shown = displayPath(real, ctx.paths.userHome);
    }
    const rootsQuery = onNode(new URLSearchParams()).toString();
    const { roots } = await callDaemon<FilesRootsResponse>(ctx.ctl, 'GET', `${ROUTES.foldersRoots.path}${rootsQuery ? `?${rootsQuery}` : ''}`);
    const at = locateIn(roots, real);
    if (!at) {
      throw new Error(
        node
          ? `${shown} is not under a folder ${node.name} lets the phone use. Add one there first: jantar folders add-root <folder>`
          : `${shown} is not under a folder the phone may use. Add one first: jantar folders add-root <folder>`,
      );
    }
    // A server's own defaults fill the picks left out there (its preview says which); the Mac's here.
    const settings = node ? null : (await callDaemon<SettingsResponse>(ctx.ctl, 'GET', ROUTES.getSettings.path)).settings;
    const picked: LaunchFlags | Partial<LaunchFlags> = settings ? { ...settings.launch.defaultFlags, ...picks } : picks;
    // One Claude login (the only way claude mode starts): no account to name.
    const single = settings?.launch.mode === 'claude';

    // The folder's past conversations, as the start sheet lists them: "last" is the newest not running.
    let resume: PastSession | string | undefined;
    if (wanted !== undefined) {
      const where = onNode(new URLSearchParams({ root: at.root.id, path: at.rel }));
      const { sessions } = await callDaemon<LaunchHistoryResponse>(ctx.ctl, 'GET', `${ROUTES.launchHistory.path}?${where.toString()}`);
      resume = wanted === 'last' ? sessions.find((x) => !x.live) : (sessions.find((x) => x.id === wanted) ?? wanted);
      if (resume === undefined) {
        const folder = shown;
        ctx.io.err(
          sessions.length
            ? `Session NOT started: every past conversation in ${folder} is running now.\n`
            : `Session NOT started: there is no past conversation in ${folder} to resume.\n`,
        );
        return EXIT.failed;
      }
    }
    const resumeId = typeof resume === 'string' ? resume : resume?.id;

    const query = new URLSearchParams({ root: at.root.id, path: at.rel, account: String(account) });
    if (picked.permission !== undefined) query.set('permission', picked.permission);
    if (picked.chrome !== undefined) query.set('chrome', picked.chrome ? '1' : '0');
    if (picked.effort !== undefined) query.set('effort', picked.effort);
    if (picked.model !== undefined) query.set('model', picked.model);
    // The name the start will send, so the preview's command and its "name taken" warning are the start's.
    if (flags.name !== undefined) query.set('name', flags.name);
    if (resumeId) query.set('resume', resumeId);
    onNode(query);
    const preview = await callDaemon<LaunchPreview>(ctx.ctl, 'GET', `${ROUTES.launchPreview.path}?${query.toString()}`);
    ctx.io.out(previewText(preview, resume, single));
    if (flags.preview) return EXIT.ok;
    if (preview.account.pick === null) {
      ctx.io.err(`Session NOT started: no account can take it (${clip(preview.account.reason, 160)}). Pick one with --account N.\n`);
      return EXIT.failed;
    }

    const body: LaunchStartBody = { root: at.root.id, path: at.rel, account, flags: node ? { ...preview.flags, ...picks } : (picked as LaunchFlags) };
    if (flags.name !== undefined) body.name = flags.name;
    if (prompt !== undefined) body.prompt = prompt;
    if (flags['confirm-held']) body.confirmHeld = true;
    if (resumeId) body.resume = resumeId;
    let job: LaunchJob;
    try {
      const startQuery = onNode(new URLSearchParams()).toString();
      job = (
        await callDaemon<LaunchJobResponse>(ctx.ctl, 'POST', `${ROUTES.launchStart.path}${startQuery ? `?${startQuery}` : ''}`, body, {
          idempotencyKey: ctx.deps.randomId(),
          timeoutMs: 30_000,
        })
      ).job;
    } catch (e) {
      if (e instanceof DaemonError) {
        const held = e.code === 'conflict' && /\bheld\b/.test(e.message) ? ' (to start there anyway: --confirm-held)' : '';
        ctx.io.err(`Session NOT started: ${e.message}${held}\n`);
        return EXIT.failed;
      }
      throw e;
    }

    const label = `${job.name} in ${job.display}${single ? '' : ` on account ${job.account}`}${node ? ` on ${node.name}` : ''}`;
    ctx.io.err(`${job.resumed ? `Resuming conversation ${job.sid} as` : 'Starting'} ${label} (launch ${job.id})\n`);
    if (flags.wait === false && !isFinal(job)) {
      if (flags.json) ctx.io.out(`${JSON.stringify({ job }, null, 2)}\n`);
      ctx.io.err('Queued. Its progress shows on the phone.\n');
      return EXIT.ok;
    }
    job = await follow(ctx, job, timeoutS);
    if (flags.json) ctx.io.out(`${JSON.stringify({ job }, null, 2)}\n`);
    const why = job.reason ? `: ${clip(job.reason, 200)}` : '';
    switch (job.stage) {
      case 'done':
        ctx.io.out(`Session started · ${label} · session ${job.sid}${job.prompt ? ' · first prompt proven by the transcript' : ''}\n`);
        return EXIT.ok;
      case 'done-no-prompt':
      case 'ready-prompt-failed':
        ctx.io.err(`Session started, but the first prompt was NOT sent · ${label}${why}\n`);
        return EXIT.failed;
      case 'failed':
      case 'refused':
      case 'stalled':
        ctx.io.err(`Session NOT started · ${label} · ${job.stage}${why}\n`);
        return EXIT.failed;
      default:
        ctx.io.err(`Session not ready yet · ${label}: still "${job.stage}" after ${timeoutS}s. The daemon keeps going (launch ${job.id}).\n`);
        return EXIT.failed;
    }
  },
);
