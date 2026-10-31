/**
 * Audit and the probe alarm for file reads (v0.3 spec 4.4.9). GETs are not
 * audited by the API pipeline, so Files writes its own rows:
 * - `files.read`, `files.raw`: once per device, path and action per 10 min,
 *   params `{root, rel, bytes, kind}`;
 * - `files.list`: once per device and dir per 10 min, params `{root, rel, count}`;
 * - `files.denied`: every refusal but `missing`, params `{root, rel, reason}`,
 *   capped per device like the API's other low-value rows (30 per 10 min);
 * - `files.alert`: 5 `protected` / `outside` refusals from one device within
 *   10 min push `security` to every device (once per 10 min per device) and
 *   log a warning.
 * Rows carry ids, paths and counts only, never file content.
 */
import type { NotifyKind } from '@jantar/protocol';
import type { Actor, AuditLog, DaemonContext, FileRefusalCode, Notification, Notifier } from '../contracts.js';
import { SlidingWindowLimiter } from '../auth/rate-limit.js';
import { actorId } from '../core/actor.js';
import { GENERIC_TITLE, clip } from '../notify/format.js';

export const AUDIT_DEDUPE_MS = 10 * 60_000;
export const PROBE_WINDOW_MS = 10 * 60_000;
/** Protected or outside refusals from one device within PROBE_WINDOW_MS that raise the alarm. */
export const PROBE_THRESHOLD = 5;
/** `files.denied` rows per device per window (the same budget as the API's AUDIT_NOISE_PER_ACTOR). */
export const DENIED_ROWS_PER_WINDOW = 30;
const DEDUPE_KEYS_MAX = 5_000;
const PATH_MAX_CHARS = 300;

export type FilesReadAction = 'files.read' | 'files.raw' | 'files.list';

/** A path for an audit row: control characters shown as '?', clipped. */
export function auditPath(rel: string): string {
  const clean = rel.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return clean.length > PATH_MAX_CHARS ? `${clean.slice(0, PATH_MAX_CHARS)}…` : clean;
}

export class FilesAudit {
  private readonly seen = new Map<string, number>();
  private readonly deniedRows: SlidingWindowLimiter;
  private readonly deniedWarned: SlidingWindowLimiter;
  private readonly probes = new Map<string, number[]>();
  private readonly alerted = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly ctx: Pick<DaemonContext, 'db' | 'clock' | 'log' | 'settings'>,
    private readonly notifiers: readonly Notifier[],
  ) {
    this.deniedRows = new SlidingWindowLimiter({ limit: DENIED_ROWS_PER_WINDOW, windowMs: AUDIT_DEDUPE_MS, clock: ctx.clock });
    this.deniedWarned = new SlidingWindowLimiter({ limit: 1, windowMs: AUDIT_DEDUPE_MS, clock: ctx.clock });
  }

  /** A successful read, logged once per (actor, action, root, rel) per 10 min. */
  read(actor: Actor, action: FilesReadAction, root: string, rel: string, params: { bytes?: number; kind?: string; count?: number }): void {
    const who = actorId(actor);
    const key = `${who}|${action}|${root}|${rel}`;
    const now = this.ctx.clock.now();
    const last = this.seen.get(key);
    if (last !== undefined && now - last < AUDIT_DEDUPE_MS) return;
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > DEDUPE_KEYS_MAX) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
    this.write({ actor: who, action, target: root, params: { root, rel: auditPath(rel), ...params }, result: 'ok' });
  }

  /** A refusal. `missing` is not a denial and is not logged. */
  denied(actor: Actor, root: string, rel: string, reason: FileRefusalCode): void {
    if (reason === 'missing') return;
    const who = actorId(actor);
    if (this.deniedRows.hit(who).ok) {
      this.write({ actor: who, action: 'files.denied', target: root, params: { root, rel: auditPath(rel), reason }, result: 'refused' });
    } else if (this.deniedWarned.hit(who).ok) {
      this.ctx.log.warn('files: denied rows dropped for a noisy device', { actor: who });
    }
    if ((reason === 'protected' || reason === 'outside') && actor.kind === 'device') this.probe(actor.deviceId, who);
  }

  /** Waits for pushes still being sent (stop, tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  private probe(deviceId: string, who: string): void {
    const now = this.ctx.clock.now();
    const hits = (this.probes.get(deviceId) ?? []).filter((t) => now - t < PROBE_WINDOW_MS);
    hits.push(now);
    this.probes.set(deviceId, hits);
    if (hits.length < PROBE_THRESHOLD) return;
    const last = this.alerted.get(deviceId);
    if (last !== undefined && now - last < PROBE_WINDOW_MS) return;
    this.alerted.set(deviceId, now);
    this.ctx.log.warn('a device tried to open protected files', { actor: who, count: hits.length });
    this.write({ actor: who, action: 'files.alert', target: who, params: { count: hits.length, windowMin: PROBE_WINDOW_MS / 60_000 }, result: 'refused' });
    this.push(deviceId, hits.length);
  }

  private push(deviceId: string, count: number): void {
    const settings = this.ctx.settings.get().notify;
    const name = clip(this.ctx.db.devices.get(deviceId)?.name ?? 'A device', 40);
    const kind: NotifyKind = 'security';
    const body =
      settings.bodies === 'generic'
        ? ''
        : settings.bodies === 'short'
          ? 'Protected files refused'
          : `${name} was refused ${count} protected paths in 10 min. If that wasn't you, revoke it at your Mac: jantar devices revoke <device>`;
    const n: Notification = { kind, title: GENERIC_TITLE[kind], body, url: '/devices', tag: `security:${deviceId}`, ts: this.ctx.clock.iso() };
    // Locked on, like a failed send: no mute and no kind filter, only the channel switches.
    for (const notifier of this.notifiers) {
      if (!settings[notifier.channel]) continue;
      const p = (async () => {
        try {
          const r = await notifier.send(n);
          this.ctx.log.info('notification sent', { channel: notifier.channel, kind, ...r });
        } catch (e) {
          this.ctx.log.error('notifier failed', { channel: notifier.channel, kind, error: String(e) });
        }
      })();
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    }
  }

  private write(entry: { actor: string; action: string; target: string; params: unknown; result: 'ok' | 'refused' }): void {
    const audit: AuditLog = this.ctx.db.audit;
    try {
      audit.append({ ts: this.ctx.clock.iso(), ...entry });
    } catch (e) {
      this.ctx.log.error('audit write failed', { action: entry.action, error: String(e) });
    }
  }
}
