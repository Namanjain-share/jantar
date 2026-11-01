/**
 * v0.6 Fleet: a node link in memory, both ends, for the hub's registry and
 * forwarder and the node's feed and executor (lanes L4, and wave 2), with no
 * socket. `hub` has the daemon's HubLink shape and `node` its NodeLink shape
 * (packages/daemon/src/contracts.ts): structurally the same interfaces,
 * typed here so the fixtures need no daemon import.
 *
 * Every frame crosses as JSON text (through `codec` when one is given: L1's
 * link/codec.ts encodeFrame / decodeFrame), and is kept in `frames` in order
 * (S3: a node's frame never reaches another node; S14: no planted secret in
 * a frame that should not carry it). A second snapshot closes the link 4400,
 * as the real socket does. Calls on a closed link, or still waiting when it
 * closes, end with the hub's node_offline reply; nothing is queued.
 */
import { createHash } from 'node:crypto';
import type { DaemonEvent, NodeBackend, NodeOs } from '@jantar/protocol';
import type { NodeCallReply, NodeCallRequest, NodeFrame, NodeSnapshot } from '@jantar/protocol/node-link';

/** HubLinkInfo (contracts.ts). */
export interface MemoryLinkInfo {
  os: NodeOs;
  version: string;
  backend: NodeBackend;
  readOnly: boolean;
  accessRefused: number;
}

/** The hub's end: HubLink (contracts.ts). */
export interface MemoryHubLink {
  readonly nodeId: string;
  readonly info: MemoryLinkInfo;
  onSnapshot(fn: (snap: NodeSnapshot) => void): void;
  onEvent(fn: (event: unknown) => void): void;
  onClose(fn: (code: number) => void): void;
  call(req: NodeCallRequest, bulk?: Buffer): Promise<NodeCallReply>;
  close(code: number, reason: string): void;
}

/** The node's end: NodeLink (contracts.ts). */
export interface MemoryNodeLink {
  sendSnapshot(snap: NodeSnapshot): void;
  sendEvent(event: DaemonEvent): void;
  onCall(fn: (req: NodeCallRequest, bulk?: Buffer) => Promise<NodeCallReply>): void;
  onClose(fn: (code: number) => void): void;
}

/** One frame that crossed: which way, its kind, and its text exactly as sent. */
export interface MemoryFrame {
  dir: 'toHub' | 'toNode';
  k: string;
  text: string;
}

export interface MemoryLinkOptions {
  /** Default MEMORY_NODE_ID. */
  nodeId?: string;
  info?: Partial<MemoryLinkInfo>;
  /** What a call gets when the link is down (default: 503 node_offline). */
  offline?: (req: NodeCallRequest) => NodeCallReply;
  /** Frames as text and back (default JSON); give L1's codec to send every frame through it. */
  codec?: { encode(frame: NodeFrame): string; decode(text: string): unknown };
}

export interface MemoryLinkPair {
  hub: MemoryHubLink;
  node: MemoryNodeLink;
  frames: MemoryFrame[];
  /** Whether the link is still up. */
  readonly open: boolean;
  /** Drop the link (both ends' onClose fire once with `code`). */
  drop(code?: number): void;
}

/** A synthetic node id (a ulid). */
export const MEMORY_NODE_ID = '01JN0DE0000000000000000001';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export function memoryLinkPair(opts: MemoryLinkOptions = {}): MemoryLinkPair {
  const nodeId = opts.nodeId ?? MEMORY_NODE_ID;
  const info: MemoryLinkInfo = { os: 'linux', version: '0.6.0', backend: 'tmux', readOnly: false, accessRefused: 0, ...opts.info };
  const encode = opts.codec?.encode ?? ((f: NodeFrame) => JSON.stringify(f));
  const decode = opts.codec?.decode ?? ((t: string) => JSON.parse(t) as unknown);
  const offline =
    opts.offline ?? (() => ({ status: 503, body: { error: { code: 'node_offline', message: 'The server is offline. Nothing was sent.' } } }));
  const frames: MemoryFrame[] = [];
  const snapshotFns: ((snap: NodeSnapshot) => void)[] = [];
  const eventFns: ((event: unknown) => void)[] = [];
  const hubCloseFns: ((code: number) => void)[] = [];
  const nodeCloseFns: ((code: number) => void)[] = [];
  let callFn: ((req: NodeCallRequest, bulk?: Buffer) => Promise<NodeCallReply>) | null = null;
  const waiting = new Map<string, (reply: NodeCallReply) => void>();
  let open = true;
  let snapshots = 0;

  /** Send one frame: as text, recorded, and read back on the other side. */
  const cross = (dir: MemoryFrame['dir'], frame: NodeFrame): Record<string, unknown> => {
    const text = encode(frame);
    frames.push({ dir, k: frame.k, text });
    return decode(text) as Record<string, unknown>;
  };

  const drop = (code = 1006): void => {
    if (!open) return;
    open = false;
    for (const [id, settle] of waiting) {
      waiting.delete(id);
      settle(offline({ id } as NodeCallRequest));
    }
    for (const fn of hubCloseFns) fn(code);
    for (const fn of nodeCloseFns) fn(code);
  };

  const hub: MemoryHubLink = {
    nodeId,
    info,
    onSnapshot: (fn) => void snapshotFns.push(fn),
    onEvent: (fn) => void eventFns.push(fn),
    onClose: (fn) => void hubCloseFns.push(fn),
    close: (code) => drop(code),
    call(req, bulk) {
      if (!open) return Promise.resolve(offline(req));
      const frame = { k: 'call', ...req, ...(bulk ? { bulk: { size: bulk.length, sha256: sha256(bulk) } } : {}) } as NodeFrame;
      const seen = cross('toNode', frame) as unknown as NodeCallRequest & { bulk?: unknown };
      const { bulk: _head, k: _k, ...arrived } = seen as NodeCallRequest & { bulk?: unknown; k?: unknown };
      return new Promise<NodeCallReply>((resolve) => {
        waiting.set(req.id, resolve);
        const run = callFn
          ? callFn(arrived as NodeCallRequest, bulk ? Buffer.from(bulk) : undefined)
          : Promise.resolve({ status: 501, body: { error: { code: 'not_implemented', message: 'no executor' } } });
        run.then(
          (reply) => {
            if (!waiting.delete(req.id) || !open) return;
            const back = cross('toHub', { k: 'result', id: req.id, status: reply.status, body: reply.body } as NodeFrame);
            resolve({ status: back.status as number, body: back.body });
          },
          () => {
            if (!waiting.delete(req.id) || !open) return;
            resolve({ status: 500, body: { error: { code: 'internal', message: 'internal error' } } });
          },
        );
      });
    },
  };

  const node: MemoryNodeLink = {
    onCall: (fn) => {
      callFn = fn;
    },
    onClose: (fn) => void nodeCloseFns.push(fn),
    sendSnapshot(snap) {
      if (!open) return;
      const back = cross('toHub', { k: 'snapshot', state: snap } as NodeFrame);
      snapshots += 1;
      // Exactly one per link, as the real socket enforces.
      if (snapshots > 1) {
        drop(4400);
        return;
      }
      queueMicrotask(() => {
        if (open) for (const fn of snapshotFns) fn(back.state as NodeSnapshot);
      });
    },
    sendEvent(event) {
      if (!open) return;
      const back = cross('toHub', { k: 'event', event } as unknown as NodeFrame);
      queueMicrotask(() => {
        if (open) for (const fn of eventFns) fn(back.event);
      });
    },
  };

  return {
    hub,
    node,
    frames,
    get open() {
      return open;
    },
    drop,
  };
}
