/**
 * v0.6 Fleet: claiming a join line, for `jantar node join` (lane L1). STUB
 * from wave 0: throws NotImplementedError until L1 replaces this file,
 * keeping the name and signature.
 *
 * decodeJoinToken, a new key pair, then `POST <url>/v1/node/pair` (the
 * Access headers when given; `redirect: 'error'`; TLS against Node's CA list
 * plus NODE_EXTRA_CA_CERTS, never anything looser), then the hub's `sig`
 * checked against the key in the line. Nothing is written here: the CLI
 * writes node.json only from an `ok` result, so a line answered by anything
 * but the Mac that made it leaves nothing behind.
 */
import type { NodeOs } from '@jantar/protocol';
import type { NodeFile } from '../contracts.js';
import { NotImplementedError } from '../core/not-implemented.js';

export interface PairWithHubOptions {
  os: NodeOs;
  /** This node's Jantar version. */
  version: string;
  /** Cloudflare Access service token headers, when the door has Access. */
  cfAccess: NodeFile['cfAccess'];
  /** Tests: another fetch. */
  fetch?: typeof fetch;
}

/** The node file to write (key included), or one sentence saying why not (`status`: the hub's HTTP answer, when there was one). */
export type PairWithHubResult = { ok: true; node: NodeFile } | { ok: false; reason: string; status?: number };

export async function pairWithHub(_token: string, _opts: PairWithHubOptions): Promise<PairWithHubResult> {
  throw new NotImplementedError('Joining a hub');
}
