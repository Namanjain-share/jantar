/**
 * v0.6 Fleet: the node's dialler (lane L1). STUB from wave 0: never dials
 * until L1 replaces this file, keeping the name and signature.
 *
 * Reads node.json (`file`) before every attempt (so `jantar node access`
 * needs only a restart), dials `linkUrl(url)` with the Access headers when
 * the file has them (no redirects; TLS against Node's CA list plus
 * NODE_EXTRA_CA_CERTS), answers the challenge, checks the hub's welcome
 * against the pinned key (an impostor is closed and logged every time), and
 * hands each verified link to `onLink`. Then the watchdog
 * (NODE_LIMITS.watchdogMs), heartbeats, and full-jitter backoff
 * (link/backoff.ts) with the cap spec 3.8 gives each close. An HTTP 403 with
 * no Jantar body is Cloudflare Access refusing: counted in `accessRefused`
 * and sent in the next `auth`. Every timer is ctx.clock's.
 */
import type { DaemonContext, Dialer } from '../contracts.js';
import { NODE_LINK_OFF } from '../modes.js';

export function createDialer(_ctx: DaemonContext, _file: string): Dialer {
  return {
    start() {},
    stop: async () => {},
    status: () => ({ ...NODE_LINK_OFF }),
  };
}
