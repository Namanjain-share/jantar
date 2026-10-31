/**
 * In-memory Store/Bus: the single owner of daemon state.
 *
 * emit() assigns the next seq, validates the event with the protocol schema,
 * applies the shared reducer, keeps the event in a fixed-size ring for
 * WebSocket resume, and then notifies subscribers. Delivery is queued, so
 * every subscriber sees events in seq order even when a subscriber emits from
 * inside its callback. Persistence is a subscriber (Db.events.append), wired
 * by the integration step.
 */
import {
  EVENT_RING_SIZE,
  emptyState,
  parseEvent,
  reduce,
  type DaemonEvent,
  type EventInput,
  type EventOf,
  type EventType,
  type State,
} from '@jantar/protocol';
import type { Clock, EventListener, Logger, Replay, Store, Unsubscribe } from '../contracts.js';
import { systemClock } from './clock.js';
import { newId } from './ids.js';
import { silentLogger } from './log.js';

export interface MemoryStoreOptions {
  clock?: Clock;
  log?: Logger;
  /** Replay ring size (default EVENT_RING_SIZE = 2000). */
  ringSize?: number;
  /** Continue numbering after this seq (e.g. Db.events.maxSeq() after a restart). */
  startSeq?: number;
  initialState?: State;
  epoch?: string;
}

export class MemoryStore implements Store {
  readonly epoch: string;
  private state: State;
  private lastSeq: number;
  private readonly ring: (DaemonEvent | undefined)[];
  private ringCount = 0;
  private readonly ringSize: number;
  private readonly listeners = new Set<EventListener>();
  private readonly queue: DaemonEvent[] = [];
  private delivering = false;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(opts: MemoryStoreOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? silentLogger;
    this.ringSize = Math.max(1, opts.ringSize ?? EVENT_RING_SIZE);
    this.ring = new Array<DaemonEvent | undefined>(this.ringSize);
    this.lastSeq = Math.max(0, opts.startSeq ?? 0);
    this.state = { ...(opts.initialState ?? emptyState()), seq: this.lastSeq };
    this.epoch = opts.epoch ?? newId();
  }

  get seq(): number {
    return this.lastSeq;
  }

  getState(): Readonly<State> {
    return this.state;
  }

  snapshot(): { seq: number; state: State } {
    return { seq: this.lastSeq, state: this.state };
  }

  emit<K extends EventType>(input: EventInput<K>): EventOf<K> {
    const candidate = { ...input, ts: input.ts ?? this.clock.iso(), seq: this.lastSeq + 1 };
    const ev = parseEvent(candidate) as EventOf<K>;
    this.lastSeq = ev.seq;
    this.state = reduce(this.state, ev as DaemonEvent);
    this.ring[(ev.seq - 1) % this.ringSize] = ev as DaemonEvent;
    this.ringCount = Math.min(this.ringCount + 1, this.ringSize);
    this.queue.push(ev as DaemonEvent);
    this.drain();
    return ev;
  }

  subscribe(fn: EventListener): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  replay(after: number): Replay {
    const oldest = this.lastSeq - this.ringCount + 1; // seq of the oldest event still in the ring
    if (!Number.isInteger(after) || after < 0 || after > this.lastSeq || after < oldest - 1) {
      return { kind: 'snapshot', seq: this.lastSeq, state: this.state };
    }
    const events: DaemonEvent[] = [];
    for (let s = after + 1; s <= this.lastSeq; s++) {
      const ev = this.ring[(s - 1) % this.ringSize];
      if (!ev || ev.seq !== s) return { kind: 'snapshot', seq: this.lastSeq, state: this.state };
      events.push(ev);
    }
    return { kind: 'events', events };
  }

  private drain(): void {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let ev = this.queue.shift(); ev; ev = this.queue.shift()) {
        for (const fn of [...this.listeners]) {
          try {
            fn(ev);
          } catch (e) {
            this.log.error('store subscriber threw', { type: ev.type, seq: ev.seq, error: String(e) });
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(opts);
}
