import { roleOf } from '@jantar/daemon/config';
import { readNodeFile } from '@jantar/daemon/link/keys';
import type { NodeFile } from '@jantar/daemon';
import { parseArgs } from '../args.js';
import { EXIT, binFinder, defineCommand, type CliContext } from '../command.js';
import { formatReport, reportJson, runDoctor, type DoctorInput, type DoctorReport } from '../lib/doctor.js';
import { userNameOf } from '../lib/service.js';
import { readSettings } from '../lib/settings.js';

const FLAGS = {
  json: { type: 'boolean', help: 'print the checks as JSON' },
} as const;

/** v0.6: this machine's node.json, or null (not a server, or a file that does not read). */
export async function nodeFileOf(ctx: Pick<CliContext, 'paths'>, read: (file: string) => Promise<NodeFile | null> = readNodeFile): Promise<NodeFile | null> {
  try {
    return await read(ctx.paths.nodeFile);
  } catch {
    return null;
  }
}

/** `over`: tests replace the v0.6 readers (osrelease, the door probe, node.json). */
export async function doctorReport(ctx: CliContext, over: Partial<DoctorInput> = {}): Promise<DoctorReport> {
  const role = roleOf(ctx.paths);
  return runDoctor({
    paths: ctx.paths,
    env: ctx.io.env,
    exec: ctx.deps.exec,
    findBin: binFinder(ctx),
    nodePath: ctx.deps.nodePath,
    nodeVersion: ctx.deps.nodeVersion,
    platform: ctx.deps.platform,
    settings: await readSettings(ctx),
    ctl: ctx.ctl,
    portFree: ctx.deps.portFree,
    httpJson: ctx.deps.httpJson,
    daemonBin: ctx.deps.locations.daemonBin,
    now: ctx.deps.now,
    role,
    uid: ctx.deps.uid,
    userName: userNameOf(ctx.io.env),
    ...(role === 'node' ? { nodeFile: await nodeFileOf(ctx) } : {}),
    ...over,
  });
}

export default defineCommand(
  {
    name: 'doctor',
    summary: 'Check Node, cswap, claude, Terminal access, the daemon, ccw coexistence, remote access and Fleet.',
    usage: 'jantar doctor [--json]',
    owner: 'G',
    help:
      'Read-only: doctor changes nothing. Exit status 1 when a check fails.\n' +
      'With Fleet on, it also checks the front door servers use and whether this Mac sleeps on power;\n' +
      'on a server, its link to the Mac, tmux, procps, lingering, WSL and the hooks in each config dir.',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const report = await doctorReport(ctx);
    ctx.io.out(flags.json ? reportJson(report) : formatReport(report));
    return report.ok ? EXIT.ok : EXIT.failed;
  },
);
