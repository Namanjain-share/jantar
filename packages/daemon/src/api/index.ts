/**
 * HTTP API for jantard (work package E): REST /v1, WS /v1/events, pairing,
 * devices, audit, Web Push subscriptions, the static web app, and the same
 * API on the CLI's control socket.
 */
import type { Factories } from '../contracts.js';
import { ApiServerImpl } from './server.js';
import type { ApiDeps, ApiOptions } from './services.js';
import type { DaemonContext } from '../contracts.js';

export { NO_TERMINAL_REFUSED, READ_ONLY_REFUSED, buildApp, gate } from './app.js';
export { ApiError, toErrorReply } from './errors.js';
export {
  CLI_EXIT,
  cliOpenUrl,
  cliPair,
  cliSend,
  cliStatus,
  formatStatus,
  resolveSession,
  type CliOutput,
  type CtlRequester,
  type PairOptions,
  type SendOptions,
} from './cli-support.js';
export { CTL_ROUTES, ctlStatus, type CtlStatus } from './ctl-routes.js';
export { CLOSE_REVOKED, CLOSE_SHUTDOWN, CLOSE_SLOW, MAX_BUFFERED } from './events-ws.js';
export { IdempotencyCache } from './idempotency.js';
export { ROUTE_IMPLS, patchPaths } from './routes.js';
export { contentSecurityPolicy, securityHeaders } from './security.js';
export { ApiServerImpl, bindHost } from './server.js';
export { ApiServices, PaneLookup, SocketRegistry, type ApiDeps, type ApiOptions, type WsLike } from './services.js';
export { computeWebHash, isApiPath } from './static.js';
export type { RequestAuth, Transport } from './request.js';

export const createApiServer: Factories['api'] = (ctx, deps) => new ApiServerImpl(ctx, deps);

/** createApiServer with options (tests and tools: port 0, no control socket, another web dist). */
export function createApiServerWith(ctx: DaemonContext, deps: ApiDeps, opts: ApiOptions): ApiServerImpl {
  return new ApiServerImpl(ctx, deps, opts);
}
