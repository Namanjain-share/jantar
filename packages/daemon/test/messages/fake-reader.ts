/**
 * A stand-in for jantar-messages-reader (0.15) in the daemon's tests, where
 * no Swift is built: the same protocol (one JSON object per line on a 0600
 * Unix socket, `{id, op, args}` in, `{id, ok, data | error, detail?}` out),
 * each op answered by the test's handler. A handler throws readerError(...)
 * to answer an error; an op with no handler answers bad_request. Handlers
 * may be async, so replies can come out of order (the client matches ids).
 */
import { chmodSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { ReaderError, ReaderOp } from '../../src/messages/reader-protocol.js';

/** What a handler throws to answer `{ok: false, error, detail?}`. */
export class FakeReaderError extends Error {
  constructor(
    readonly error: ReaderError,
    readonly detail?: string,
  ) {
    super(error);
  }
}

export const readerError = (error: ReaderError, detail?: string) => new FakeReaderError(error, detail);

export type FakeHandler = (args: Record<string, unknown>) => unknown;
export type FakeHandlers = Partial<Record<ReaderOp, FakeHandler>>;

export interface FakeReader {
  /** Every request, in the order it came. */
  readonly calls: { op: string; args: Record<string, unknown> }[];
  close(): Promise<void>;
}

type Reply = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string; detail?: string };

/** Listens on `sock` (0600) and answers with `handlers` until closed. */
export async function startFakeReader(sock: string, handlers: FakeHandlers): Promise<FakeReader> {
  const calls: FakeReader['calls'] = [];
  const sockets = new Set<Socket>();

  const answer = async (line: string): Promise<Reply> => {
    let req: { id?: unknown; op?: unknown; args?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return { id: 0, ok: false, error: 'bad_request', detail: 'not JSON' };
    }
    const id = typeof req.id === 'number' ? req.id : 0;
    const op = String(req.op);
    const args = (req.args ?? {}) as Record<string, unknown>;
    calls.push({ op, args });
    const handler = handlers[op as ReaderOp];
    if (!handler) return { id, ok: false, error: 'bad_request', detail: 'unknown op' };
    try {
      return { id, ok: true, data: await handler(args) };
    } catch (e) {
      if (e instanceof FakeReaderError) return { id, ok: false, error: e.error, ...(e.detail ? { detail: e.detail } : {}) };
      return { id, ok: false, error: 'busy', detail: 'the fake handler threw' };
    }
  };

  const server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void answer(line).then((reply) => {
          if (!s.destroyed) s.write(`${JSON.stringify(reply)}\n`);
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => resolve());
  });
  chmodSync(sock, 0o600);
  return {
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
