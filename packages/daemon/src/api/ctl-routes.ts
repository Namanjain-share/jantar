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
import { localSessions } from '@jantar/protocol';
import type { FastifyInstance } from 'fastify';
import type { DaemonRole, NodeLinkStatus } from '../contracts.js';
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
  /**
   * v0.6: hub or node, and what `jantar node join` checks before it turns a
   * machine into a node (paired phones, push subscriptions; a hub's paired
   * servers). The counts above are the Mac's own sessions only.
   */
  role: DaemonRole;
  pairedDevices: number;
  pushSubscriptions: number;
  /** Live pairings and those linked now (the hub's own view). */
  nodes: { paired: number; online: number };
  /** v0.6, on a node: its link to the hub (never a URL path, a secret or a key). */
  node?: { name: string | null; hubHost: string | null; link: NodeLinkStatus['state']; lastClose: NodeLinkStatus['lastClose']; accessRefused: number };
}

export function ctlStatus(s: ApiServices, address: () => { host: string; port: number } | null): CtlStatus {
  const { ctx, deps } = s;
  const state = ctx.store.getState();
  const settings = ctx.settings.get();
  // v0.6: the Mac's own line; a server's sessions are its own (state.nodes).
  const sids = Object.keys(localSessions(state));
  const role: DaemonRole = s.mode.role ?? 'hub';
  const devices = s.devices.list().filter((d) => !d.revokedAt).length;
  const pushSubscriptions = ctx.db.pushSubs.list().length;
  const views = Object.values(state.nodes ?? {});
  const link = s.nodeLink.status();
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
      devices,
      pushSubscriptions,
      eventStreams: s.sockets.count(),
      pairingCodes: s.pairing.openCount(),
    },
    usage: { fetchedAt: state.usage.fetchedAt, source: state.usage.source, polling: deps.usage.isPolling() },
    ccwLegacy: { present: deps.ccwLegacy.present() },
    web: { available: s.webAvailable, webHash: s.webHash },
    notify: { webpush: settings.notify.webpush, mutedUntil: settings.notify.muted_until, kinds: [...settings.notify.kinds] },
    // As before v0.6: the role has its own field.
    mode: { readOnly: s.mode.readOnly, terminal: s.mode.terminal },
    role,
    pairedDevices: devices,
    pushSubscriptions,
    nodes: { paired: ctx.db.nodes.list().filter((n) => n.revokedAt === null).length, online: views.filter((v) => v.online).length },
    ...(role === 'node'
      ? { node: { name: link.name, hubHost: link.hubHost, link: link.state, lastClose: link.lastClose, accessRefused: link.accessRefused } }
      : {}),
  };
}

export function registerCtlRoutes(app: FastifyInstance, s: ApiServices, address: () => { host: string; port: number } | null): void {
  app.get(CTL_ROUTES.status, async () => ctlStatus(s, address));

  app.get(CTL_ROUTES.hooks, async () => {
    const state = s.ctx.store.getState();
    return {
      socketPath: s.deps.hooks.socketPath,
      open: s.deps.hooks.open().length,
      sessions: Object.values(localSessions(state)).map((x) => ({ sid: x.sid, folder: x.folder, hooks: s.deps.hooks.hasHooks(x.sid) })),
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
