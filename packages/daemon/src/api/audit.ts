/**
 * Audit log writer for API writes. Params are redacted by each route (no
 * prompt bodies, codes, keys, tokens or push endpoints); this layer only adds
 * the time, the actor and the result, and never lets an audit failure break
 * the request.
 */
import type { AuditEntry } from '@jantar/protocol';
import type { Clock, Db, Logger } from '../contracts.js';

export interface AuditInput {
  actor: string;
  action: string;
  target?: string | undefined;
  params?: unknown;
  result: AuditEntry['result'];
  detail?: string | undefined;
}

/** Result for an HTTP status: 2xx ok, 4xx refused, 5xx failed. */
export function auditResult(status: number): AuditEntry['result'] {
  if (status < 400) return 'ok';
  if (status < 500) return 'refused';
  return 'failed';
}

export class Auditor {
  constructor(
    private readonly db: Pick<Db, 'audit'>,
    private readonly clock: Pick<Clock, 'iso'>,
    private readonly log: Logger,
  ) {}

  write(input: AuditInput): AuditEntry | null {
    const entry: Omit<AuditEntry, 'seq'> = {
      ts: this.clock.iso(),
      actor: input.actor,
      action: input.action,
      params: input.params ?? {},
      result: input.result,
    };
    if (input.target !== undefined) entry.target = input.target;
    if (input.detail !== undefined) entry.detail = input.detail.slice(0, 500);
    try {
      return this.db.audit.append(entry);
    } catch (e) {
      this.log.error('audit write failed', { action: input.action, error: String(e) });
      return null;
    }
  }
}

/** Host of a push endpoint (the full endpoint URL is a capability and is never logged). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '?';
  }
}
