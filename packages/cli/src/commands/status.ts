import { localSessions, ROUTES, type NodeView, type StateResponse } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { callDaemon } from '../ctl.js';
import { renderStatus } from '../lib/board.js';
import { linkWords, type CtlStatusView } from '../lib/doctor.js';
import { clip, duration, plural } from '../lib/text.js';
import { machineKind } from './node.js';

const FLAGS = {
  json: { type: 'boolean', help: 'print the raw state as JSON' },
  alerts: { type: 'number', help: 'how many recent alerts to show (default 3)' },
} as const;

/**
 * v0.6: one line per machine once a server is paired (the Mac first, then
 * the servers by name), and on a server the line that says whose it is.
 */
export function machineLines(state: StateResponse['state'], st: CtlStatusView | null, now: number): string {
  if (st?.role === 'node' && st.node) {
    return `\nThis machine is ${clip(st.node.name ?? 'a server', 24)}, a server of ${st.node.hubHost ?? 'a Mac'} · ${linkWords(st.node, now)}\n`;
  }
  const views = Object.values(state.nodes ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!views.length) return '';
  const live = (node?: string) =>
    Object.values(state.sessions).filter((s) => s.node === node && s.status !== 'ended').length;
  const mac = Object.values(localSessions(state)).filter((s) => s.status !== 'ended').length;
  const rows: [string, string][] = [['Mac', `this Mac · ${plural(mac, 'session')}`]];
  for (const v of views as NodeView[]) {
    const where = v.online ? `online · ${plural(live(v.id), 'session')}` : `offline for ${duration(now - Date.parse(v.since))}`;
    rows.push([clip(v.name, 24), `${machineKind(v)} · ${where}${v.readOnly ? ' · read-only' : ''}`]);
  }
  const w = Math.max(...rows.map(([n]) => n.length));
  return `\nMachines: ${views.length + 1}\n${rows.map(([n, d]) => `  ${n.padEnd(w)}  ${d}`).join('\n')}\n`;
}

export default defineCommand(
  {
    name: 'status',
    summary: 'Show sessions (your turn first), cards, accounts and, with Fleet, each machine.',
    usage: 'jantar status [--json] [--alerts N]',
    owner: 'G',
  },
  async (argv, ctx) => {
    const { flags } = parseArgs(argv, FLAGS, { max: 0 });
    const res = await callDaemon<StateResponse>(ctx.ctl, 'GET', ROUTES.getState.path);
    if (flags.json) {
      ctx.io.out(`${JSON.stringify(res, null, 2)}\n`);
      return EXIT.ok;
    }
    // Best effort: older daemons, or a daemon busy shutting down, may not answer.
    let st: CtlStatusView | null = null;
    try {
      const r = await ctx.ctl.request<CtlStatusView>('GET', '/ctl/status');
      if (r.status === 200 && r.body && typeof r.body === 'object' && 'mode' in r.body) st = r.body as CtlStatusView;
    } catch {
      st = null;
    }
    const mode = st?.mode;
    ctx.io.out(
      renderStatus(res.state, {
        now: ctx.deps.now(),
        ...(flags.alerts !== undefined ? { alerts: flags.alerts } : {}),
        ...(mode ? { mode } : {}),
      }),
    );
    ctx.io.out(machineLines(res.state, st, ctx.deps.now()));
    return EXIT.ok;
  },
);
