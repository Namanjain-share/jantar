/**
 * Routes served only on the control socket (paths.ctlSock, 0600), for the
 * `jantar` CLI. Together with the `ctl: true` REST routes they give the CLI
 * its verbs:
 *
 *   status       GET  /ctl/status            (plus GET /v1/state, /v1/accounts, ...)
 *   pair-start   POST /v1/pair/start
 *   send         POST /v1/sessions/:sid/prompt, then GET /ctl/sends/:jobId/wait
 *   hooks-status GET  /ctl/hooks
 *
 * There is deliberately no approve verb: a Claude session runs as the same
 * user and can reach this socket, so approvals come only from paired devices.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ApiError, zodMessage } from './errors.js';
import type { ApiServices } from './services.js';
import type { DaemonMode } from '../modes.js';

export const CTL_ROUTES = {
  status: '/ctl/status',
  hooks: '/ctl/hooks',
  sendWait: '/ctl/sends/:jobId/wait',
} as const;

const WaitQuerySchema = z.object({
  timeoutMs: z.coerce.number().int().min(0).max(120_000).default(30_000),
});
const JobParams = z.object({ jobId: z.string().min(1).max(128) });

export interface CtlStatus {
  daemonVersion: string;
  protocol: number;
  epoch: string;
  seq: number;
  startedAt: string;
  api: { host: string; port: number } | null;
  publicUrl: string | null;
  ctlSocket: string | null;
  hooks: { socketPath: string; sessionsWithHooks: number };
  counts: { sessions: number; pending: number; devices: number; pushSubscriptions: number; eventStreams: number; pairingCodes: number };
  usage: { fetchedAt: string | null; source: string | null; polling: boolean };
  ccwLegacy: { present: boolean };
  web: { available: boolean; webHash: string | null };
  notify: { webpush: boolean; mutedUntil: string | null; kinds: string[] };
  /** --read-only / --no-terminal (daemon.ts). */
  mode: DaemonMode;
}

export function ctlStatus(s: ApiServices, address: () => { host: string; port: number } | null): CtlStatus {
  const { ctx, deps } = s;
  const state = ctx.store.getState();
  const settings = ctx.settings.get();
  const sids = Object.keys(state.sessions);
  return {
    daemonVersion: ctx.version.daemon,
    protocol: ctx.version.protocol,
    epoch: ctx.store.epoch,
    seq: ctx.store.seq,
    startedAt: s.startedAt,
    api: address(),
    publicUrl: settings.remote.publicUrl,
    ctlSocket: s.ctlSocketPath,
    hooks: { socketPath: deps.hooks.socketPath, sessionsWithHooks: sids.filter((sid) => deps.hooks.hasHooks(sid)).length },
    counts: {
      sessions: sids.length,
      pending: Object.keys(state.pending).length,
      devices: s.devices.list().filter((d) => !d.revokedAt).length,
      pushSubscriptions: ctx.db.pushSubs.list().length,
      eventStreams: s.sockets.count(),
      pairingCodes: s.pairing.openCount(),
    },
    usage: { fetchedAt: state.usage.fetchedAt, source: state.usage.source, polling: deps.usage.isPolling() },
    ccwLegacy: { present: deps.ccwLegacy.present() },
    web: { available: s.webAvailable, webHash: s.webHash },
    notify: { webpush: settings.notify.webpush, mutedUntil: settings.notify.muted_until, kinds: [...settings.notify.kinds] },
    mode: { ...s.mode },
  };
}

export function registerCtlRoutes(app: FastifyInstance, s: ApiServices, address: () => { host: string; port: number } | null): void {
  app.get(CTL_ROUTES.status, async () => ctlStatus(s, address));

  app.get(CTL_ROUTES.hooks, async () => {
    const state = s.ctx.store.getState();
    return {
      socketPath: s.deps.hooks.socketPath,
      open: s.deps.hooks.open().length,
      sessions: Object.values(state.sessions).map((x) => ({ sid: x.sid, folder: x.folder, hooks: s.deps.hooks.hasHooks(x.sid) })),
    };
  });

  app.get(CTL_ROUTES.sendWait, async (req) => {
    const p = JobParams.safeParse(req.params);
    if (!p.success) throw new ApiError('invalid_request', zodMessage('params', p.error.issues));
    const q = WaitQuerySchema.safeParse(req.query ?? {});
    if (!q.success) throw new ApiError('invalid_request', zodMessage('query', q.error.issues));
    const job = await s.deps.writer.wait(p.data.jobId, q.data.timeoutMs);
    if (!job) throw new ApiError('not_found', 'no such send job');
    return { job };
  });
}
