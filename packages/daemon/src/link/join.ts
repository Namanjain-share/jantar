/**
 * v0.6 Fleet: claiming a join line, for `jantar node join`.
 *
 * decodeJoinToken, a new key pair, then `POST <url>/v1/node/pair` (the
 * Access headers when given; `redirect: 'error'`; TLS against Node's CA list
 * plus NODE_EXTRA_CA_CERTS, never anything looser), then the hub's `sig`
 * checked against the key in the line. Nothing is written here: the CLI
 * writes node.json only from an `ok` result, so a line answered by anything
 * but the Mac that made it leaves nothing behind.
 *
 * Every refusal is a fixed sentence chosen by the HTTP status or the error's
 * code: nothing the answering server wrote is ever printed (until its
 * signature checks, it may be anyone).
 */
import { NODE_PREFIX, NodePairReplySchema, type NodeOs } from '@jantar/protocol';
import { NODE_PROTO, decodeJoinToken } from '@jantar/protocol/node-link';
import type { NodeFile } from '../contracts.js';
import { generateKeyPair, privateKeyPem, verifyPair } from './keys.js';

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

/** How long the claim may take. */
const PAIR_TIMEOUT_MS = 30_000;
/** At most this much of an answer is read. */
const REPLY_MAX = 64 * 1024;

/** The Cloudflare Access service token headers (sent on the claim and on every upgrade). */
export function accessHeaders(cfAccess: NodeFile['cfAccess']): Record<string, string> {
  return cfAccess ? { 'CF-Access-Client-Id': cfAccess.clientId, 'CF-Access-Client-Secret': cfAccess.clientSecret } : {};
}

/** Whether an error code is TLS refusing the hub's certificate. */
export function isTlsError(code: string): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL/.test(code);
}

/** The text of a 403 is Jantar's own (a JSON error) or not (Cloudflare Access answered before the hub). */
export function isJantarError(text: string): boolean {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } } | null;
    return typeof body?.error?.code === 'string';
  } catch {
    return false;
  }
}

/** The sentence for an upgrade or claim the hub's door answered with `status`. */
export function refusalText(status: number, jantarBody: boolean): string {
  if (status === 403 && !jantarBody) return 'Cloudflare Access refused the connection: the service token may have expired or been revoked (jantar node access renews it).';
  if (status >= 300 && status < 400) return "The hub's address answered with a redirect, and servers never follow one: check the address in the join line.";
  switch (status) {
    case 401:
      return 'This join line is not valid (used, expired or mistyped): make a new one at the Mac with jantar node pair.';
    case 403:
      return 'The hub refused this server (403): check the address in the join line.';
    case 404:
      return 'Fleet is off at the Mac (or this address is not a Jantar hub): run jantar fleet on there.';
    case 426:
      return "This server's Jantar and the Mac's speak different link versions: update Jantar on both.";
    case 429:
      return 'Too many attempts: wait a minute and try again.';
    default:
      return `The hub answered ${status}.`;
  }
}

/** The error code under a fetch failure (undici puts it on `cause`). */
function errorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof (e as { code?: unknown } | null)?.code === 'string') return (e as { code: string }).code;
  if ((e as { name?: unknown } | null)?.name === 'TimeoutError' || (e as { name?: unknown } | null)?.name === 'AbortError') return 'TIMEOUT';
  if (typeof cause?.message === 'string' && /redirect/i.test(cause.message)) return 'REDIRECT';
  return 'NETWORK';
}

/** The sentence for a claim that got no answer. */
export function failureText(code: string, host: string): string {
  if (code === 'REDIRECT') return refusalText(302, false);
  if (isTlsError(code)) return `The hub's certificate is not trusted here (${code}): servers check it against Node's CA list plus NODE_EXTRA_CA_CERTS.`;
  if (code === 'TIMEOUT') return `The hub at ${host} did not answer in time.`;
  return `Could not reach the hub at ${host} (${code}).`;
}

async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > REPLY_MAX) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export async function pairWithHub(token: string, opts: PairWithHubOptions): Promise<PairWithHubResult> {
  const line = decodeJoinToken(token);
  if (!line.ok) return { ok: false, reason: `This is not a join line: ${line.reason}.` };
  const { url, code, hubKey } = line.token;
  const host = new URL(url).hostname;
  const keys = generateKeyPair();
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${url}${NODE_PREFIX}pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...accessHeaders(opts.cfAccess) },
      body: JSON.stringify({ code, publicKey: keys.publicKey, os: opts.os, version: opts.version, proto: NODE_PROTO }),
      redirect: 'error',
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: failureText(errorCode(e), host) };
  }
  let text: string | null;
  try {
    text = await readCapped(res);
  } catch (e) {
    return { ok: false, reason: failureText(errorCode(e), host), status: res.status };
  }
  if (res.status !== 201) return { ok: false, reason: refusalText(res.status, text !== null && isJantarError(text)), status: res.status };
  let json: unknown = null;
  try {
    json = text === null ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  const reply = NodePairReplySchema.safeParse(json);
  if (!reply.success) return { ok: false, reason: "The hub's answer was not understood: nothing was saved.", status: res.status };
  if (!verifyPair(hubKey, reply.data.nodeId, keys.publicKey, reply.data.sig)) {
    return { ok: false, reason: 'The server at that address is not the Mac that made this line: nothing was saved.', status: res.status };
  }
  return {
    ok: true,
    node: {
      v: 1,
      url,
      nodeId: reply.data.nodeId,
      name: reply.data.name,
      hubKey,
      privateKey: privateKeyPem(keys.privateKey),
      cfAccess: opts.cfAccess,
    },
  };
}
