/**
 * v0.6 Fleet: the in-band handshake right after the upgrade (lane L1). STUB
 * from wave 0. Internal to L1 (fleet/socket.ts and node/dialer.ts use it):
 * L1 may add exports here; keep the ones below.
 *
 *   hub  -> node  challenge {v:1, nonce: nH}
 *   node -> hub   auth {..., sig: Sign_node(linkSigText('node', nodeId, nH, nN))}   within NODE_LIMITS.handshakeMs (4408)
 *   hub  -> node  welcome {name, sig: Sign_hub(linkSigText('hub', nodeId, nH, nN))}
 *
 * Fresh 32-byte nonces from crypto.randomBytes on both sides stop replay;
 * the two labels and the two keys stop reflection; no clocks. The hub
 * accepts nothing but `auth` before it, and the node acts on nothing before
 * a verified `welcome`.
 */
import { NotImplementedError } from '../core/not-implemented.js';

/** A fresh handshake nonce: 32 random bytes, base64url. */
export function newNonce(): string {
  throw new NotImplementedError('The Fleet link (handshake)');
}
