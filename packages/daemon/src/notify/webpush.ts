/**
 * Web Push notifier (RFC 8030 / 8291 via the unmodified `web-push` package).
 *
 * - Payloads are encrypted to each browser, so Apple's and Google's relays
 *   only see ciphertext.
 * - Subscriptions the push service reports as gone (404 / 410) are removed;
 *   so are subscriptions of revoked or unknown devices, endpoints that are
 *   not a known push service (push-hosts.ts, SEC-3; rows stored before that
 *   check existed) and a device's subscriptions past its newest
 *   MAX_PUSH_SUBS_PER_DEVICE.
 * - At most PUSH_CONCURRENCY pushes are in flight at once, so a long list
 *   cannot open hundreds of TLS connections from the daemon per card.
 * - Each subscription can narrow the kinds it receives (`kinds`); a reminder
 *   passes when its base kind (or "reminder") is wanted.
 * - v0.5.3: a push with a `deadline` (Claude's countdown) lives only until
 *   then (TTL): a stale "answer now" is noise. Failures where the push never
 *   left the Mac (no network: DNS or connect, `neverLeft`; the host is
 *   looked up first, so a slow DNS is one too) are counted as
 *   `offline`, so Life can wait for the network instead of giving up. The
 *   first logs a warning and the next ones a debug line, until a delivery
 *   logs that the push service is reachable again.
 *
 * Payload (what sw.js receives, JSON):
 *   { v: 1, title, body, kind, group, url?, tag?, sid?, pendingId?, deadline?, ts }
 * `group` (v0.5.3) is the alert group the phone's tone follows
 * (protocol alertGroupOf); the service worker ignores fields it does not know.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import webpush from 'web-push';
import { alertGroupOf, type AlertGroup, type NotifyKind, type PushSubscriptionRecord } from '@jantar/protocol';
import { hasScope } from '../auth/scopes.js';
import type { DaemonContext, Notification, Notifier } from '../contracts.js';
import { MAX_BODY_SHORT, clip, type RoutedNotification } from './format.js';
import { MAX_PUSH_SUBS_PER_DEVICE, pushEndpointProblem } from './push-hosts.js';
import { VapidError, loadOrCreateVapidKeys, type VapidKeys } from './vapid.js';

/** Push services accept about 4 KB; stay well under it after encryption overhead. */
export const MAX_PAYLOAD_BYTES = 3000;
export const PUSH_TTL_S = 3600;
export const PUSH_TIMEOUT_MS = 10_000;
/** Pushes in flight at once. */
export const PUSH_CONCURRENCY = 4;

/** Subscriptions, newest first (ties broken by endpoint, so the order is stable). */
export function newestFirst(recs: readonly PushSubscriptionRecord[]): PushSubscriptionRecord[] {
  return [...recs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.subscription.endpoint.localeCompare(b.subscription.endpoint));
}

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const URGENT: ReadonlySet<NotifyKind> = new Set(['permission', 'question', 'plan', 'send-failed', 'reminder', 'limit', 'launch', 'security', 'med', 'life']);

/**
 * Kinds every device gets whatever it chose. v0.3: a start from a phone and
 * a device probing for protected files must be seen everywhere (a stolen
 * phone is visible on the others). v0.4: med and life, so no stored kinds
 * list (from before they existed) can drop a medicine; they carry
 * `minScope: 'control'`, which keeps them off read-only devices.
 */
export const ALWAYS_PUSHED: ReadonlySet<NotifyKind> = new Set(['launch', 'security', 'med', 'life']);

export interface PushSendOptions {
  TTL: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  timeout: number;
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}

/** Sends one push. Rejects with an error carrying `statusCode` when the push service refuses it. */
export type PushSender = (
  subscription: PushSubscriptionRecord['subscription'],
  payload: string,
  options: PushSendOptions,
) => Promise<unknown>;

/**
 * v0.5.3: the push host's address first, within the push's own timeout. A
 * lookup that fails or hangs (a Mac waking before its resolver is back) is
 * a `getaddrinfo` error, which `neverLeft` counts as offline. Without it the
 * socket timeout would cover a slow lookup, and Life would count a push that
 * never left as a failure.
 */
export async function lookupFirst(host: string, ms: number, look: (host: string) => Promise<unknown> = lookup): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`getaddrinfo ETIMEOUT ${host}`), { code: 'ETIMEOUT', syscall: 'getaddrinfo', hostname: host })), ms);
    timer.unref?.();
  });
  try {
    await Promise.race([look(host), late]);
  } finally {
    clearTimeout(timer);
  }
}

export const defaultPushSender: PushSender = async (subscription, payload, options) => {
  await lookupFirst(new URL(subscription.endpoint).hostname, options.timeout);
  return webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: subscription.keys },
    payload,
    options as webpush.RequestOptions,
  );
};

export interface WebPushNotifierOptions {
  sender?: PushSender;
  /** Supply keys directly (tests); otherwise read / create paths.vapidFile. */
  vapid?: VapidKeys;
}

export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  kind: NotifyKind;
  /** v0.5.3: the alert group (the phone's tone); `urgent` for a permission with a deadline. */
  group: AlertGroup;
  url?: string;
  tag?: string;
  sid?: string;
  pendingId?: string;
  /** v0.5.3: when Claude's countdown runs out (ISO). */
  deadline?: string;
  ts: string;
}

export function buildPushPayload(n: Notification): PushPayload {
  const p: PushPayload = { v: 1, title: n.title, body: n.body, kind: n.kind, group: alertGroupOf(n.kind, n.deadline), ts: n.ts };
  if (n.url) p.url = n.url;
  if (n.tag) p.tag = n.tag;
  if (n.sid) p.sid = n.sid;
  if (n.pendingId) p.pendingId = n.pendingId;
  if (n.deadline) p.deadline = n.deadline;
  return p;
}

/** Seconds a push may wait at the push service: until its deadline (at least 1 s), else PUSH_TTL_S. */
export function ttlFor(deadline: string | undefined, nowMs: number): number {
  const at = deadline === undefined ? NaN : Date.parse(deadline);
  if (!Number.isFinite(at)) return PUSH_TTL_S;
  return Math.min(PUSH_TTL_S, Math.max(1, Math.ceil((at - nowMs) / 1000)));
}

/** Serialize, shortening the body if the payload would be too large. */
export function encodePayload(n: Notification): string {
  const p = buildPushPayload(n);
  let text = JSON.stringify(p);
  if (Buffer.byteLength(text) <= MAX_PAYLOAD_BYTES) return text;
  p.body = clip(p.body, MAX_BODY_SHORT * 3);
  text = JSON.stringify(p);
  if (Buffer.byteLength(text) <= MAX_PAYLOAD_BYTES) return text;
  p.body = clip(p.body, MAX_BODY_SHORT);
  p.title = clip(p.title, 60);
  return JSON.stringify(p);
}

/** Topic header: collapses undelivered repeats of the same tag at the push service (max 32 url-safe chars). */
export function topicFor(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

export function wantsKind(rec: PushSubscriptionRecord, n: RoutedNotification): boolean {
  if (!rec.kinds || rec.kinds.length === 0 || ALWAYS_PUSHED.has(n.kind)) return true;
  if (rec.kinds.includes(n.kind)) return true;
  return n.kind === 'reminder' && n.baseKind !== undefined && rec.kinds.includes(n.baseKind);
}

/** Only the host of an endpoint is ever logged: the full URL is a capability. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '?';
  }
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' ? s : undefined;
}

/**
 * v0.5.3: the push never left the Mac, so it cannot have reached the push
 * service: no HTTP status, and the DNS lookup (`getaddrinfo`: ENOTFOUND,
 * EAI_AGAIN) or the TCP connect (`connect`) failed. Node 22 tries every
 * address of a host at once, and a connect failing on all of them is an
 * AggregateError of such errors. A socket timeout, a reset connection, any
 * HTTP answer and a missing VAPID key are not this: those may have reached
 * Apple, and Life never sends them twice.
 */
export function neverLeft(e: unknown): boolean {
  if (statusOf(e) !== undefined) return false;
  if (e instanceof AggregateError) return e.errors.length > 0 && e.errors.every(neverLeft);
  const syscall = (e as { syscall?: unknown } | null)?.syscall;
  return syscall === 'getaddrinfo' || syscall === 'connect';
}

export class WebPushNotifier implements Notifier {
  readonly channel = 'webpush' as const;
  private keys: VapidKeys | null = null;
  private keyError: string | null = null;
  private readonly sender: PushSender;
  /** v0.5.3: a push failed for lack of network and none has been delivered since (the log dedupe). */
  private offline = false;

  constructor(
    private readonly ctx: Pick<DaemonContext, 'paths' | 'db' | 'log' | 'env' | 'clock'>,
    opts: WebPushNotifierOptions = {},
  ) {
    this.sender = opts.sender ?? defaultPushSender;
    if (opts.vapid) this.keys = opts.vapid;
  }

  /** The VAPID keys, created on first use. null (with `vapidError()`) when the key file is unusable. */
  vapid(): VapidKeys | null {
    if (this.keys) return this.keys;
    try {
      this.keys = loadOrCreateVapidKeys(this.ctx.paths.vapidFile, { env: this.ctx.env, now: () => this.ctx.clock.now() });
      this.keyError = null;
    } catch (e) {
      const msg = e instanceof VapidError ? e.message : `cannot create VAPID keys: ${String(e)}`;
      if (msg !== this.keyError) this.ctx.log.error('web push disabled', { error: msg });
      this.keyError = msg;
    }
    return this.keys;
  }

  /** For GET /v1/push/vapid-public-key. */
  publicKey(): string | null {
    return this.vapid()?.publicKey ?? null;
  }

  vapidError(): string | null {
    return this.keyError;
  }

  async send(n: Notification): Promise<{ delivered: number; failed: number; offline: number }> {
    const routed = n as RoutedNotification;
    const all = newestFirst(this.ctx.db.pushSubs.list());
    const targets: PushSubscriptionRecord[] = [];
    const perDevice = new Map<string, number>();
    for (const rec of all) {
      const device = this.ctx.db.devices.get(rec.deviceId);
      if (!device || device.revokedAt) {
        this.ctx.db.pushSubs.remove(rec.subscription.endpoint);
        continue;
      }
      const problem = pushEndpointProblem(rec.subscription.endpoint);
      if (problem) {
        this.ctx.db.pushSubs.remove(rec.subscription.endpoint);
        this.ctx.log.warn('push subscription refused; removed', { deviceId: rec.deviceId, pushHost: hostOf(rec.subscription.endpoint), problem });
        continue;
      }
      const count = (perDevice.get(rec.deviceId) ?? 0) + 1;
      perDevice.set(rec.deviceId, count);
      if (count > MAX_PUSH_SUBS_PER_DEVICE) {
        this.ctx.db.pushSubs.remove(rec.subscription.endpoint);
        continue;
      }
      // v0.4: a push for one scope (Life: control) skips devices without it.
      if (n.minScope && !hasScope(device.scopes, n.minScope)) continue;
      if (wantsKind(rec, routed)) targets.push(rec);
    }
    if (targets.length === 0) return { delivered: 0, failed: 0, offline: 0 };
    const keys = this.vapid();
    if (!keys) return { delivered: 0, failed: targets.length, offline: 0 };

    const payload = encodePayload(n);
    const options: PushSendOptions = {
      TTL: ttlFor(n.deadline, this.ctx.clock.now()),
      urgency: URGENT.has(n.kind) ? 'high' : 'normal',
      timeout: PUSH_TIMEOUT_MS,
      vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    };
    const topic = topicFor(n.tag);
    if (topic) options.topic = topic;

    let delivered = 0;
    let failed = 0;
    let offline = 0;
    await eachLimited(targets, PUSH_CONCURRENCY, async (rec) => {
      try {
        await this.sender(rec.subscription, payload, options);
        delivered += 1;
        if (this.offline) {
          this.offline = false;
          this.ctx.log.info('push service reachable again', { pushHost: hostOf(rec.subscription.endpoint) });
        }
      } catch (e) {
        failed += 1;
        const status = statusOf(e);
        const host = hostOf(rec.subscription.endpoint);
        if (status === 404 || status === 410) {
          this.ctx.db.pushSubs.remove(rec.subscription.endpoint);
          this.ctx.log.info('push subscription expired; removed', { deviceId: rec.deviceId, pushHost: host, status });
        } else if (neverLeft(e)) {
          offline += 1;
          // An AggregateError's own message is empty: its code says what failed.
          const fields = { deviceId: rec.deviceId, pushHost: host, status: null, error: (e as Error)?.message || (e as { code?: string })?.code, offline: true };
          if (this.offline) this.ctx.log.debug('push failed', fields);
          else this.ctx.log.warn('push failed', fields);
          this.offline = true;
        } else {
          this.ctx.log.warn('push failed', { deviceId: rec.deviceId, pushHost: host, status: status ?? null, error: (e as Error)?.message });
        }
      }
    });
    return { delivered, failed, offline };
  }
}
