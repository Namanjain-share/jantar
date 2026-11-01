/**
 * v0.6 Fleet, frames and bulks (S13): one JSON text frame each, at most
 * 1 MiB, checked against its kind's schema; anything larger than a frame
 * crosses as a bulk (size + sha256, then base64 chunks in order) through the
 * same code both ways, and its bytes are handed on only when whole and
 * matching. A sender waits while the socket holds more than 2 MiB.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NODE_LIMITS, type NodeFrame, type NodeFrameOf } from '@jantar/protocol/node-link';
import { BulkAssembler, CHUNK_HIGH_WATER, bulkLane, decodeFrame, encodeFrame, sendWithBulk, type FrameSocket } from '../../src/link/codec.js';

const MIB = 1024 * 1024;
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const ACTOR = { deviceId: 'dev1', deviceName: 'iPhone', scopes: ['read' as const, 'control' as const] };

/** A socket that keeps every frame it is given; `held` bytes stay unsent until `flush()`. */
function recordingSocket(opts: { hold?: boolean } = {}) {
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  let buffered = 0;
  const sock: FrameSocket & { sent: string[]; flush(): void; buffered: number } = {
    sent,
    get bufferedAmount() {
      return buffered;
    },
    get buffered() {
      return buffered;
    },
    send(data, cb) {
      sent.push(data);
      if (!opts.hold) return cb?.();
      buffered += data.length;
      pending.push(() => {
        buffered -= data.length;
        cb?.();
      });
    },
    flush() {
      for (const fn of pending.splice(0)) fn();
    },
  };
  return sock;
}

/** Feed every frame a socket received to an assembler, as the receiving side would. */
function receive(sent: string[], asm: BulkAssembler): { head: NodeFrame; done?: Buffer; steps: string[] } {
  const frames = sent.map((t) => {
    const d = decodeFrame(t);
    if (!d.ok) throw new Error(d.problem);
    return d.frame;
  });
  const head = frames[0]!;
  const id = head.k === 'snapshot' ? 'snapshot' : (head as { id: string }).id;
  const steps: string[] = [];
  let done: Buffer | undefined;
  const first = asm.begin(id, (head as { bulk: { size: number; sha256: string } }).bulk);
  steps.push(first.ok ? 'ok' : first.problem);
  if (first.ok && first.done) done = first.done;
  for (const f of frames.slice(1)) {
    const step = asm.add(f as NodeFrameOf<'chunk'>);
    steps.push(step.ok ? 'ok' : step.problem);
    if (step.ok && step.done) done = step.done;
  }
  return { head, ...(done ? { done } : {}), steps };
}

describe('frames', () => {
  it('round-trips each kind through its schema', () => {
    const frames: NodeFrame[] = [
      { k: 'challenge', v: 1, nonce: 'A'.repeat(43) },
      { k: 'heartbeat', ts: '2026-11-01T10:00:00.000Z' },
      { k: 'call', id: 'c1', route: 'getScreen', params: { sid: 's1' }, query: {}, actor: ACTOR },
      { k: 'result', id: 'c1', status: 200, body: { text: 'hello' } },
      { k: 'event', event: { type: 'session.updated', sid: 's1' } } as NodeFrame,
    ];
    for (const f of frames) expect(decodeFrame(encodeFrame(f))).toEqual({ ok: true, frame: f });
  });

  it('says why a text is not a frame', () => {
    expect(decodeFrame('{')).toEqual({ ok: false, problem: 'json' });
    expect(decodeFrame('[1]')).toEqual({ ok: false, problem: 'shape' });
    expect(decodeFrame('{"x":1}')).toEqual({ ok: false, problem: 'shape' });
    expect(decodeFrame('{"k":"gossip"}')).toEqual({ ok: false, problem: 'unknown-kind' });
    expect(decodeFrame('{"k":"constructor"}')).toEqual({ ok: false, problem: 'unknown-kind' });
    expect(decodeFrame('{"k":"heartbeat","ts":"x"}')).toEqual({ ok: false, problem: 'shape', kind: 'heartbeat' });
    expect(decodeFrame(`{"k":"heartbeat","ts":"${'x'.repeat(MIB)}"}`)).toEqual({ ok: false, problem: 'size' });
  });

  it('refuses to encode a frame over 1 MiB (a bulk is the way)', () => {
    expect(() => encodeFrame({ k: 'result', id: 'c1', status: 200, body: 'x'.repeat(MIB) })).toThrow(RangeError);
  });
});

describe('bulks', () => {
  it('a 3 MB result crosses as a head and 512 KiB chunks, and arrives whole', async () => {
    const body = { text: 'y'.repeat(3_000_000) };
    const bytes = Buffer.from(JSON.stringify(body));
    const sock = recordingSocket();
    await sendWithBulk(sock, { k: 'result', id: 'c1', status: 200, body }, bytes);
    const head = JSON.parse(sock.sent[0]!) as Record<string, unknown>;
    expect(head).toEqual({ k: 'result', id: 'c1', status: 200, bulk: { size: bytes.length, sha256: sha256(bytes) } });
    expect(sock.sent).toHaveLength(1 + Math.ceil(bytes.length / NODE_LIMITS.chunkBytes));
    for (const t of sock.sent) expect(Buffer.byteLength(t)).toBeLessThanOrEqual(NODE_LIMITS.frameBytes);
    const r = receive(sock.sent, new BulkAssembler({ maxBytes: NODE_LIMITS.bulkToHubBytes, maxInFlight: 4 }));
    expect(r.steps.every((s) => s === 'ok')).toBe(true);
    expect(JSON.parse(r.done!.toString('utf8'))).toEqual(body);
  });

  it('a 20 MiB upload crosses to a node with the same sha256; one byte more is refused', async () => {
    const bytes = Buffer.alloc(NODE_LIMITS.bulkToNodeBytes, 7);
    bytes.writeUInt32BE(0xdeadbeef, 1000);
    const sock = recordingSocket();
    await sendWithBulk(sock, { k: 'call', id: 'u1', route: 'uploadCreate', params: { sid: 's1' }, query: {}, actor: ACTOR }, bytes);
    const asm = new BulkAssembler({ maxBytes: NODE_LIMITS.bulkToNodeBytes, maxInFlight: 4 });
    const r = receive(sock.sent, asm);
    expect(sha256(r.done!)).toBe(sha256(bytes));
    expect(asm.inFlight()).toBe(0);
    expect(asm.begin('u2', { size: NODE_LIMITS.bulkToNodeBytes + 1, sha256: sha256(bytes) })).toEqual({ ok: false, problem: 'too-large' });
  });

  it('sizes at the chunk edge, and an empty bulk, arrive with the same sha256', async () => {
    for (const size of [0, 1, NODE_LIMITS.chunkBytes, NODE_LIMITS.chunkBytes + 1]) {
      const bytes = Buffer.alloc(size, 3);
      const sock = recordingSocket();
      await sendWithBulk(sock, { k: 'snapshot' } as NodeFrame, bytes);
      expect(JSON.parse(sock.sent[0]!)).toEqual({ k: 'snapshot', bulk: { size, sha256: sha256(bytes) } });
      const r = receive(sock.sent, new BulkAssembler({ maxBytes: MIB * 2, maxInFlight: 4 }));
      expect(r.done?.equals(bytes), String(size)).toBe(true);
    }
  });

  it('a corrupted chunk, one out of order, one past the size, or one for nobody is refused', async () => {
    const bytes = Buffer.alloc(NODE_LIMITS.chunkBytes * 2 + 10, 9);
    const sock = recordingSocket();
    await sendWithBulk(sock, { k: 'result', id: 'r1', status: 200 }, bytes);
    const asm = () => new BulkAssembler({ maxBytes: NODE_LIMITS.bulkToHubBytes, maxInFlight: 4 });
    // Corrupted: the size is right, the sha256 is not (found when the last chunk lands).
    const corrupt = [...sock.sent];
    const c1 = JSON.parse(corrupt[1]!) as { data: string };
    corrupt[1] = JSON.stringify({ ...c1, data: Buffer.alloc(NODE_LIMITS.chunkBytes, 8).toString('base64') });
    expect(receive(corrupt, asm()).steps).toEqual(['ok', 'ok', 'ok', 'sha256']);
    // Out of order.
    expect(receive([sock.sent[0]!, sock.sent[2]!, sock.sent[1]!], asm()).steps).toEqual(['ok', 'order', 'ok']);
    // Past the size.
    const big = JSON.parse(sock.sent[3]!) as { data: string; i: number };
    const over = [...sock.sent.slice(0, 3), JSON.stringify({ ...big, data: Buffer.alloc(11, 9).toString('base64') })];
    expect(receive(over, asm()).steps).toEqual(['ok', 'ok', 'ok', 'size']);
    // A chunk nobody announced.
    expect(asm().add(JSON.parse(sock.sent[1]!) as NodeFrameOf<'chunk'>)).toEqual({ ok: false, problem: 'unknown-id' });
  });

  it('a refused bulk drops its trailing chunks, so an upload fails alone (the call answers 400)', () => {
    const a = new BulkAssembler({ maxBytes: 10, maxInFlight: 4 });
    expect(a.begin('u1', { size: 20, sha256: 'a'.repeat(64) })).toEqual({ ok: false, problem: 'too-large' });
    expect(a.add({ k: 'chunk', id: 'u1', i: 0, data: 'AAAA' })).toEqual({ ok: true });
    expect(a.add({ k: 'chunk', id: 'u2', i: 0, data: 'AAAA' })).toEqual({ ok: false, problem: 'unknown-id' });
  });

  it('at most four bulks at once per direction; a fifth is refused; a second head for one id too', () => {
    const a = new BulkAssembler({ maxBytes: MIB, maxInFlight: NODE_LIMITS.bulkInFlight });
    for (let i = 0; i < 4; i += 1) expect(a.begin(`b${i}`, { size: 5, sha256: 'a'.repeat(64) })).toEqual({ ok: true });
    expect(a.begin('b4', { size: 5, sha256: 'a'.repeat(64) })).toEqual({ ok: false, problem: 'too-many' });
    expect(a.begin('b0', { size: 5, sha256: 'a'.repeat(64) })).toEqual({ ok: false, problem: 'order' });
    a.clear();
    expect(a.inFlight()).toBe(0);
  });

  it('the sender waits while the socket holds more than 2 MiB, and goes on as it drains', async () => {
    const sock = recordingSocket({ hold: true });
    const bytes = Buffer.alloc(NODE_LIMITS.chunkBytes * 8, 1);
    let finished = false;
    const sending = sendWithBulk(sock, { k: 'snapshot' } as NodeFrame, bytes).then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    // Head + chunks until the buffer passed the high-water mark, then nothing more.
    const before = sock.sent.length;
    expect(before).toBeLessThan(9);
    expect(sock.buffered).toBeGreaterThan(CHUNK_HIGH_WATER);
    expect(finished).toBe(false);
    while (!finished) {
      sock.flush();
      await new Promise((r) => setTimeout(r, 1));
    }
    await sending;
    expect(sock.sent).toHaveLength(9);
  });

  it('rejects when the socket fails while the sender waits', async () => {
    const sock: FrameSocket = { bufferedAmount: CHUNK_HIGH_WATER + 1, send: (_d, cb) => cb?.(new Error('closed')) };
    await expect(sendWithBulk(sock, { k: 'snapshot' } as NodeFrame, Buffer.alloc(NODE_LIMITS.chunkBytes * 3))).rejects.toThrow('closed');
  });

  it('a lane runs at most four sends at once', async () => {
    const lane = bulkLane(NODE_LIMITS.bulkInFlight);
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const jobs = Array.from({ length: 7 }, () =>
      lane(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((r) => releases.push(r));
        running -= 1;
      }),
    );
    while (releases.length < 4) await new Promise((r) => setTimeout(r, 1));
    expect(running).toBe(4);
    while (most <= 4 && (releases.length > 0 || running > 0)) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(jobs);
    expect(most).toBe(4);
  });
});
