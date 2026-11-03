/**
 * v0.11 People: her counters (spec 9.3.6) and the signal that ends her
 * sockets.
 *
 * Her event stream (api/person-events.ts) sends `tick {seq, life, plan,
 * alerts, chat, me}`: counters only, never State, an id or a title. They move
 * only on writes into her space (`life`: to-dos and weights; `plan`: her
 * plan, review, status, sleep and journal, P2), on alerts between them
 * (`alerts`, P2), or on her account (`me`: state, agreement, devices). His writes to his own space never touch them, so her stream
 * can't tell her when he is active (M11).
 *
 * `close(pid, deviceId?)` asks every open stream of hers (or of one device)
 * to close with 4401: revoke, leave and remove call it.
 *
 * Nothing here is persisted: a restart starts the counters again, and her
 * app reloads on its next tick as Life screens do on `lifeTick`.
 */
export interface PersonCounters {
  seq: number;
  life: number;
  plan: number;
  alerts: number;
  /** P3: her chat thread. */
  chat: number;
  me: number;
}

export type PersonCounter = 'life' | 'plan' | 'alerts' | 'chat' | 'me';
const ZERO: PersonCounters = { seq: 0, life: 0, plan: 0, alerts: 0, chat: 0, me: 0 };

export type PersonTickListener = (c: PersonCounters) => void;
export type PersonCloseListener = (deviceId: string | null) => void;

export class PersonTicks {
  private readonly counters = new Map<string, PersonCounters>();
  private readonly listeners = new Map<string, Set<PersonTickListener>>();
  private readonly closers = new Map<string, Set<PersonCloseListener>>();
  private seq = 0;

  /** Her counters now. */
  of(pid: string): PersonCounters {
    return { ...(this.counters.get(pid) ?? ZERO) };
  }

  bump(pid: string, which: PersonCounter): void {
    const c = { ...(this.counters.get(pid) ?? ZERO) };
    this.seq += 1;
    c.seq = this.seq;
    c[which] += 1;
    this.counters.set(pid, c);
    for (const fn of [...(this.listeners.get(pid) ?? [])]) {
      try {
        fn({ ...c });
      } catch {
        /* a listener's failure stays its own */
      }
    }
  }

  subscribe(pid: string, fn: PersonTickListener): () => void {
    let set = this.listeners.get(pid);
    if (!set) this.listeners.set(pid, (set = new Set()));
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  onClose(pid: string, fn: PersonCloseListener): () => void {
    let set = this.closers.get(pid);
    if (!set) this.closers.set(pid, (set = new Set()));
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  /** Close her streams: every device's, or one device's. */
  close(pid: string, deviceId: string | null = null): void {
    for (const fn of [...(this.closers.get(pid) ?? [])]) {
      try {
        fn(deviceId);
      } catch {
        /* closing is best effort; the gate refuses the device anyway */
      }
    }
  }
}
