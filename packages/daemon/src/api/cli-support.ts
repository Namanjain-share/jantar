/**
 * The logic behind `jantar pair | open | status | send`, written against a
 * minimal control-socket client so the CLI commands stay thin wrappers (the
 * CLI's `createCtlClient()` fits `CtlRequester`). Each function returns a
 * process exit code: 0 ok, 1 failed, 2 usage.
 *
 * Errors from the transport itself (daemon not running) are not caught here;
 * the CLI maps them to its "daemon down" exit code.
 */
import {
  ROUTES,
  boardOrder,
  buildPath,
  pendingFor,
  sessionLabel,
  type Account,
  type ErrorBody,
  type PairStartResponse,
  type PromptAccepted,
  type SendJob,
  type Session,
  type StateResponse,
} from '@jantar/protocol';
import { CTL_ROUTES, type CtlStatus } from './ctl-routes.js';

export interface CtlRequester {
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { idempotencyKey?: string; timeoutMs?: number },
  ): Promise<{ status: number; body: T | ErrorBody | null }>;
}

export interface CliOutput {
  out(text: string): void;
  err(text: string): void;
}

export const CLI_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

function isError(b: unknown): b is ErrorBody {
  return typeof b === 'object' && b !== null && 'error' in b;
}

async function call<T>(ctl: CtlRequester, io: CliOutput, method: string, path: string, body?: unknown, opts?: { idempotencyKey?: string; timeoutMs?: number }): Promise<T | null> {
  const res = await ctl.request<T>(method, path, body, opts);
  if (res.status >= 400 || isError(res.body)) {
    const msg = isError(res.body) ? `${res.body.error.message} (${res.body.error.code})` : `HTTP ${res.status}`;
    io.err(`jantar: ${msg}\n`);
    return null;
  }
  return res.body as T;
}

// ---------------------------------------------------------------------------
// pair / open

export interface PairOptions {
  name?: string;
  /** Grant admin (settings, devices, audit). Default: read + control. */
  admin?: boolean;
  json?: boolean;
  /** Renders the link as a terminal QR code (the CLI passes `qrcode`'s toString). */
  renderQr?: (text: string) => Promise<string>;
}

export async function cliPair(ctl: CtlRequester, io: CliOutput, opts: PairOptions = {}): Promise<number> {
  const body: { name?: string; scopes?: string[] } = {};
  if (opts.name) body.name = opts.name;
  if (opts.admin) body.scopes = ['read', 'control', 'admin'];
  const r = await call<PairStartResponse>(ctl, io, 'POST', ROUTES.pairStart.path, body);
  if (!r) return CLI_EXIT.failed;
  if (opts.json) {
    io.out(`${JSON.stringify(r)}\n`);
    return CLI_EXIT.ok;
  }
  if (opts.renderQr) io.out(`${await opts.renderQr(r.url)}\n`);
  const until = new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  io.out(`Scan this code with the phone's camera, or open:\n  ${r.url}\n`);
  io.out(`One use only; it expires at ${until}. ${opts.admin ? 'Grants read, control and admin.' : 'Grants read and control.'}\n`);
  if (r.url.startsWith('http://127.0.0.1') || r.url.startsWith('http://localhost')) {
    io.out('This link only works on this Mac. For a phone, set remote.publicUrl (e.g. your Tailscale Serve URL) first.\n');
  }
  return CLI_EXIT.ok;
}

/**
 * For `jantar open`: a one-time admin pairing link on the loopback address
 * (the "local admin channel"). The CLI then opens it with /usr/bin/open.
 */
export async function cliOpenUrl(ctl: CtlRequester, io: CliOutput, name = 'This Mac'): Promise<string | null> {
  const status = await call<CtlStatus>(ctl, io, 'GET', CTL_ROUTES.status);
  if (!status) return null;
  if (!status.api) {
    io.err('jantar: the daemon is not listening on TCP\n');
    return null;
  }
  const r = await call<PairStartResponse>(ctl, io, 'POST', ROUTES.pairStart.path, { name, scopes: ['read', 'control', 'admin'] });
  if (!r) return null;
  const host = status.api.host.includes(':') ? `[${status.api.host}]` : status.api.host;
  return `http://${host}:${status.api.port}/pair#c=${encodeURIComponent(r.code)}`;
}

// ---------------------------------------------------------------------------
// status

function ago(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function windowPct(a: Account, kind: string): string {
  const w = a.windows.find((x) => x.kind === kind);
  return w ? `${Math.round(w.pct)}%`.padStart(4) : '   -';
}

/** The board as plain text, "your turn" first. */
export function formatStatus(snap: StateResponse, status: CtlStatus | null, now: number): string {
  const state = snap.state;
  const lines: string[] = [];
  const sessions = boardOrder(state);
  lines.push(`Sessions (${sessions.length})`);
  for (const s of sessions) {
    const cards = pendingFor(state, s.sid).filter((p) => p.state === 'open');
    const label = sessionLabel(s, cards[0] ?? null);
    const acct = s.account === null ? 'acct ?' : `acct ${s.account}`;
    lines.push(`  ${label}  [${acct}]  ${ago(s.statusSince, now)}  ${s.sid}`);
  }
  if (sessions.length === 0) lines.push('  (none)');
  const accounts = Object.values(state.accounts).sort((a, b) => a.id - b.id);
  if (accounts.length > 0) {
    lines.push('', 'Accounts            5h   7d');
    for (const a of accounts) {
      const name = (a.alias ?? a.emailMasked).slice(0, 14).padEnd(14);
      const flags = [a.isDefaultLogin ? 'default' : '', a.held ? 'held' : '', a.disabled ? 'disabled' : '', a.usageStatus !== 'ok' ? a.usageStatus : '']
        .filter(Boolean)
        .join(', ');
      lines.push(`  ${String(a.id).padStart(2)} ${name} ${windowPct(a, 'five_hour')} ${windowPct(a, 'seven_day')}${flags ? `  (${flags})` : ''}`);
    }
  }
  if (status) {
    lines.push(
      '',
      `jantard ${status.daemonVersion} · ${status.api ? `http://${status.api.host}:${status.api.port}` : 'not listening'} · ` +
        `${status.counts.devices} device(s) · hooks in ${status.hooks.sessionsWithHooks}/${status.counts.sessions} session(s)` +
        (status.notify.mutedUntil ? ` · muted until ${status.notify.mutedUntil}` : '') +
        (status.mode?.readOnly ? ' · read-only' : '') +
        (status.mode?.terminal === 'off' ? ' · terminal off' : ''),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function cliStatus(ctl: CtlRequester, io: CliOutput, opts: { json?: boolean; now?: number } = {}): Promise<number> {
  const snap = await call<StateResponse>(ctl, io, 'GET', ROUTES.getState.path);
  if (!snap) return CLI_EXIT.failed;
  const status = await call<CtlStatus>(ctl, io, 'GET', CTL_ROUTES.status);
  if (opts.json) {
    io.out(`${JSON.stringify({ ...snap, daemon: status })}\n`);
    return CLI_EXIT.ok;
  }
  io.out(formatStatus(snap, status, opts.now ?? Date.now()));
  return CLI_EXIT.ok;
}

// ---------------------------------------------------------------------------
// send

/** Find a session by exact sid, unique sid prefix (4+ chars), or unique name / folder. */
export function resolveSession(sessions: readonly Session[], query: string): { ok: true; session: Session } | { ok: false; message: string } {
  const exact = sessions.find((s) => s.sid === query);
  if (exact) return { ok: true, session: exact };
  const q = query.toLowerCase();
  const byPrefix = q.length >= 4 ? sessions.filter((s) => s.sid.toLowerCase().startsWith(q)) : [];
  const byName = sessions.filter((s) => s.name?.toLowerCase() === q || s.folder.toLowerCase() === q);
  const matches = byPrefix.length > 0 ? byPrefix : byName;
  if (matches.length === 1 && matches[0]) return { ok: true, session: matches[0] };
  if (matches.length === 0) return { ok: false, message: `no session matches "${query}" (see: jantar status)` };
  return { ok: false, message: `"${query}" matches ${matches.length} sessions: ${matches.map((s) => s.sid.slice(0, 8)).join(', ')}` };
}

const FINAL = new Set(['proven', 'proven-merged', 'failed', 'refused']);

export interface SendOptions {
  /** Wait until the transcript proves the prompt (default true). */
  wait?: boolean;
  timeoutMs?: number;
  idempotencyKey?: string;
  onDraft?: 'refuse' | 'replace';
}

export async function cliSend(ctl: CtlRequester, io: CliOutput, target: string, text: string, opts: SendOptions = {}): Promise<number> {
  if (!target || !text.trim()) {
    io.err('usage: jantar send <session> <text>\n');
    return CLI_EXIT.usage;
  }
  const list = await call<{ sessions: Session[] }>(ctl, io, 'GET', ROUTES.listSessions.path);
  if (!list) return CLI_EXIT.failed;
  const found = resolveSession(list.sessions, target);
  if (!found.ok) {
    io.err(`jantar: ${found.message}\n`);
    return CLI_EXIT.failed;
  }
  const reqOpts: { idempotencyKey?: string } = {};
  if (opts.idempotencyKey) reqOpts.idempotencyKey = opts.idempotencyKey;
  const accepted = await call<PromptAccepted>(
    ctl,
    io,
    'POST',
    buildPath(ROUTES.sendPrompt, { sid: found.session.sid }),
    { text, onDraft: opts.onDraft ?? 'refuse' },
    reqOpts,
  );
  if (!accepted) return CLI_EXIT.failed;
  const label = sessionLabel(found.session);
  if (opts.wait === false) {
    io.out(`queued (job ${accepted.jobId}) for ${label}\n`);
    return CLI_EXIT.ok;
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? 60_000, 120_000);
  const waited = await call<{ job: SendJob }>(
    ctl,
    io,
    'GET',
    `${buildPath({ path: CTL_ROUTES.sendWait }, { jobId: accepted.jobId })}?timeoutMs=${timeoutMs}`,
    undefined,
    { timeoutMs: timeoutMs + 5000 },
  );
  if (!waited) return CLI_EXIT.failed;
  const job = waited.job;
  if (job.stage === 'proven' || job.stage === 'proven-merged') {
    io.out(`sent and proven by the transcript: ${label}${job.stage === 'proven-merged' ? ' (merged with text already in the box)' : ''}\n`);
    return CLI_EXIT.ok;
  }
  if (!FINAL.has(job.stage)) {
    io.err(`jantar: not proven yet (stage ${job.stage}); check: jantar status\n`);
    return CLI_EXIT.failed;
  }
  io.err(`jantar: prompt NOT sent to ${label}: ${job.reason ?? job.stage}\n`);
  return CLI_EXIT.failed;
}
