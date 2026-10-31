import { parseArgs } from '../args.js';
import { EXIT, binFinder, defineCommand, type CliContext } from '../command.js';
import { formatReport, reportJson, runDoctor, type DoctorReport } from '../lib/doctor.js';
import { readSettings } from '../lib/settings.js';

const FLAGS = {
  json: { type: 'boolean', help: 'print the checks as JSON' },
} as const;

export async function doctorReport(ctx: CliContext): Promise<DoctorReport> {
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
  });
}

export default defineCommand(
  {
    name: 'doctor',
    summary: 'Check Node, cswap, claude, Terminal access, the daemon, ccw coexistence and remote access.',
    usage: 'jantar doctor [--json]',
    owner: 'G',
    help: 'Read-only: doctor changes nothing. Exit status 1 when a check fails.',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const report = await doctorReport(ctx);
    ctx.io.out(flags.json ? reportJson(report) : formatReport(report));
    return report.ok ? EXIT.ok : EXIT.failed;
  },
);
