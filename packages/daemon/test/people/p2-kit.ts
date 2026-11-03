/**
 * v0.11 People (P2): small helpers the plan, review, alert, status, sleep
 * and journal suites share, over the isolation fixture (synthetic people
 * only: Sam, Asha, Bea; hosts jantar.test and us.test).
 */
import { vi } from 'vitest';
import { OWNER_HOST, OWNER_ORIGIN, credHeaders, onHer, type Cred, type Fixture } from './isolation-fixture.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

export const EP = {
  asha: 'https://fcm.googleapis.com/fcm/send/asha-p2',
  bea: 'https://fcm.googleapis.com/fcm/send/bea-p2',
  sam: 'https://fcm.googleapis.com/fcm/send/sam-p2',
} as const;

export interface Kit {
  him(method: Method, url: string, payload?: object, cred?: Cred): ReturnType<typeof onHer>;
  her(method: Method, url: string, payload?: object, who?: Cred): ReturnType<typeof onHer>;
  /** Her push list, his and Bea's, each with one device. */
  subscribeAll(): Promise<void>;
  /** Pushes sent so far, decoded. */
  sent(): { endpoint: string; title: string; body: string; url?: string; tag?: string; urgent?: true }[];
  to(endpoint: string): ReturnType<Kit['sent']>;
  clearPushes(): void;
  /** Move the clock and let the scheduler's sends settle. */
  advance(ms: number): Promise<void>;
  /** Set the clock (forward only) to an ISO time, running every timer due on the way. */
  at(iso: string): Promise<void>;
}

export function kit(f: () => Fixture): Kit {
  const k: Kit = {
    him: async (method, url, payload, cred) =>
      f().api.tcp.inject({ method, url, headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(cred ?? f().owner.control) }, ...(payload ? { payload } : {}) }),
    her: (method, url, payload, who) => onHer(f().api, method, url, who ?? f().asha.full, payload),
    async subscribeAll() {
      for (const [who, ep] of [
        [f().asha.full, EP.asha],
        [f().bea.full, EP.bea],
      ] as const) {
        const r = await onHer(f().api, 'POST', '/v1/p/push/subscribe', who, { subscription: { endpoint: ep, keys: { p256dh: 'p', auth: 'a' } } });
        if (r.statusCode !== 200) throw new Error(`subscribe her: ${r.body}`);
      }
      const r = await f().api.tcp.inject({
        method: 'POST',
        url: '/v1/push/subscribe',
        headers: { host: OWNER_HOST, origin: OWNER_ORIGIN, ...credHeaders(f().owner.control) },
        payload: { subscription: { endpoint: EP.sam, keys: { p256dh: 'p', auth: 'a' } } },
      });
      if (r.statusCode !== 200) throw new Error(`subscribe him: ${r.body}`);
      await settle();
      k.clearPushes();
    },
    sent: () => f().api.fakes.pushed.map((p) => ({ endpoint: p.endpoint, ...(JSON.parse(p.payload) as { title: string; body: string; url?: string; tag?: string; urgent?: true }) })),
    to: (endpoint) => k.sent().filter((p) => p.endpoint === endpoint),
    clearPushes: () => {
      f().api.fakes.pushed.length = 0;
    },
    async advance(ms) {
      f().api.ctx.clock.advance(ms);
      await settle();
    },
    async at(iso) {
      const ms = Date.parse(iso) - f().api.ctx.clock.now();
      if (ms < 0) throw new Error(`the clock only moves forward (${iso})`);
      await k.advance(ms);
    },
  };
  return k;
}

/** Let promise chains (pushes in flight) finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

/** Wait until `fn` passes (a scheduler send is async). */
export async function eventually(fn: () => void, timeout = 3000): Promise<void> {
  await vi.waitFor(fn, { timeout, interval: 10 });
}
