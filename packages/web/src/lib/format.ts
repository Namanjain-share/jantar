/**
 * Display helpers: times, durations, usage levels and labels. Pure functions
 * (the current time is always passed in) so they are easy to test.
 */
import type { Account, UsageWindow } from '@jantar/protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function parse(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "2h 13m", "45m", "3d 4h", "<1m". */
export function durationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < MIN) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Compact age: "now", "45s", "12m", "3h", "2d". */
export function ago(iso: string | undefined | null, now: number): string {
  const t = parse(iso);
  if (t === null) return '';
  const d = Math.max(0, now - t);
  if (d < 10_000) return 'now';
  if (d < MIN) return `${Math.floor(d / 1000)}s`;
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / DAY)}d`;
}

/** "just now", "12m ago", "3h ago" (empty for a missing time). */
export function agoLong(iso: string | undefined | null, now: number): string {
  const a = ago(iso, now);
  if (!a) return '';
  return a === 'now' ? 'just now' : `${a} ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Local clock time, 24-hour and the same on every locale ("14:02"), as the
 * design and the Accounts screen show it; weekday too when it is not today
 * ("Sat 19:00").
 */
export function clock(iso: string | undefined | null, now: number): string {
  const t = parse(iso);
  if (t === null) return '';
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return hm;
  return `${WEEKDAYS[d.getDay()]} ${hm}`;
}

/** "in 2h 13m" / "2m ago" relative to now. */
export function relative(iso: string | undefined | null, now: number): string {
  const t = parse(iso);
  if (t === null) return '';
  const d = t - now;
  return d >= 0 ? `in ${durationShort(d)}` : `${durationShort(-d)} ago`;
}

export type UsageLevel = 'ok' | 'warn' | 'high';

/** Bar colour bands: green below 60%, amber below 80%, red from 80%. */
export function usageLevel(pct: number): UsageLevel {
  if (pct >= 80) return 'high';
  if (pct >= 60) return 'warn';
  return 'ok';
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return `${Math.round(Math.max(0, n))}%`;
}

/** "five_hour" -> "5-hour", "seven_day" -> "Weekly", "scoped:Opus" -> "Weekly · Opus". */
export function windowLabel(kind: string): string {
  if (kind === 'five_hour') return '5-hour';
  if (kind === 'seven_day') return 'Weekly';
  if (kind.startsWith('scoped:')) return `Weekly · ${kind.slice('scoped:'.length) || 'scoped'}`;
  return kind.replace(/_/g, ' ');
}

/** The window shown in compact places (board rows): the 5-hour one if present. */
export function primaryWindow(account: Account | undefined | null): UsageWindow | undefined {
  if (!account) return undefined;
  return account.windows.find((w) => w.kind === 'five_hour') ?? account.windows[0];
}

/**
 * An account's 5-hour %, read the same way on every screen (board rows, the
 * status bar, the session meta and the Accounts matrix): 0 while no 5-hour
 * window is open (none reported, or its reset has passed), null when there is
 * no account or its usage reading is not ok (a stale token is not a number).
 */
export function fiveHourPct(account: Account | undefined | null, now: number = Date.now()): number | null {
  if (!account || account.usageStatus !== 'ok') return null;
  const w = account.windows.find((x) => x.kind === 'five_hour');
  if (!w || !Number.isFinite(w.pct)) return 0;
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (Number.isFinite(reset) && reset <= now) return 0;
  return Math.round(Math.max(0, w.pct));
}

/** Window order on the Accounts screen: 5-hour, weekly, then scoped ones. */
export function sortWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const rank = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  return [...windows].sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind));
}

/** Two-digit account number, the way cswap lists them: 3 -> "03". */
export function accountId(id: number | null | undefined): string {
  if (id === null || id === undefined) return '–';
  return String(id).padStart(2, '0');
}

/** "03" or "03 work". Account identity is the number and alias, never a colour. */
export function accountName(id: number | null | undefined, account?: Pick<Account, 'alias'> | null): string {
  if (id === null || id === undefined) return 'unknown account';
  return account?.alias ? `${accountId(id)} ${account.alias}` : accountId(id);
}

/** Text for a cswap usageStatus that is not "ok". */
export function usageStatusText(status: string): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'token_expired':
      return 'token expired';
    case 'relogin_required':
      return 're-login needed';
    case 'api_key':
      return 'API key account';
    case 'keychain_unavailable':
      return 'keychain locked';
    case 'no_credentials':
      return 'no credentials';
    case 'foreign_credential':
      return 'foreign credential';
    case 'unavailable':
      return 'usage unavailable';
    default:
      return status.replace(/_/g, ' ');
  }
}

/** Single-line preview of possibly-markdown text. */
export function previewText(text: string | undefined, max = 180): string {
  if (!text) return '';
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Remove terminal control characters from screen text (keeps newlines and tabs). */
export function cleanScreen(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n');
}
