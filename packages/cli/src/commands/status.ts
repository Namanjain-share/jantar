import { ROUTES, type StateResponse } from '@jantar/protocol';
import { parseArgs } from '../args.js';
import { EXIT, defineCommand } from '../command.js';
import { callDaemon } from '../ctl.js';
import { renderStatus } from '../lib/board.js';

const FLAGS = {
  json: { type: 'boolean', help: 'print the raw state as JSON' },
  alerts: { type: 'number', help: 'how many recent alerts to show (default 3)' },
} as const;

export default defineCommand(
  {
    name: 'status',
    summary: 'Show sessions (your turn first), cards and accounts.',
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
    let mode: { readOnly?: boolean; terminal?: string } | undefined;
    try {
      const st = await ctx.ctl.request<{ mode?: { readOnly?: boolean; terminal?: string } }>('GET', '/ctl/status');
      if (st.status === 200 && st.body && typeof st.body === 'object' && 'mode' in st.body) mode = st.body.mode;
    } catch {
      mode = undefined;
    }
    ctx.io.out(
      renderStatus(res.state, {
        now: ctx.deps.now(),
        ...(flags.alerts !== undefined ? { alerts: flags.alerts } : {}),
        ...(mode ? { mode } : {}),
      }),
    );
    return EXIT.ok;
  },
);
