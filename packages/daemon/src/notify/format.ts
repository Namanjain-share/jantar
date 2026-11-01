/**
 * Notification text (web direction.md 5.8), built from protocol data only.
 * Pure functions: the time of day and "in 1h12" come from the `ts` passed in
 * and an optional time zone (the Mac's own when omitted).
 *
 * Rules:
 * - The title starts with the folder, the thing you scan on a lock screen,
 *   and is at most MAX_TITLE characters (the folder is clipped, never the
 *   words after it): "web-app needs you", "infra has a plan for you".
 * - The body leads with the kind, then the content: "Question: ...",
 *   "Permission · Bash: rm -rf dist".
 * - Tags: one per session (`s:<sid>`), so a newer push replaces an older one
 *   on the lock screen; `acct:<id>` for account pushes (limit, usage).
 * - No emoji, no "Claude Code says".
 *
 * `notify.bodies` picks the detail level:
 * - full:    the content (clipped to MAX_BODY_FULL)
 * - short:   a fixed few words per kind ("Question waiting")
 * - generic: no session details at all: a neutral title and an empty body
 *
 * Tap targets (paths in the web app): `/s/<sid>?card=<id>` for cards,
 * `/s/<sid>` for session moments, `/s/<sid>?send=<jobId>` for failed sends,
 * `/alerts?id=<alertId>` for alerts and `/accounts` for account pushes.
 *
 * v0.5.3: the urgent alert (Claude's 2-minute countdown) carries no prompt,
 * command or dialog text in any mode, and its time is approximate on
 * purpose ("about 2 min"): it is sent once and never ticks on the lock
 * screen. `jantar notify test` sends a fixed test text per alert group.
 */
import type { Alert, AlertGroup, AlertKind, NotifyKind, PendingRequest, SendJob, Session, Settings } from '@jantar/protocol';
import type { Notification } from '../contracts.js';
import { canonicalJson } from '../core/hash.js';

export const MAX_TITLE = 40;
export const MAX_BODY_FULL = 600;
export const MAX_BODY_SHORT = 100;
/** bodies: generic sends no content at all. */
export const GENERIC_BODY = '';

export type BodiesMode = Settings['notify']['bodies'];

/** A notification plus the kind it reminds about (reminders only) and its folder. */
export interface RoutedNotification extends Notification {
  baseKind?: NotifyKind;
  /** The session's folder, for a reminder's title. Never sent. */
  folder?: string;
}

/** The kind as a word, where a body or a short body leads with it. */
export const KIND_WORD: Record<NotifyKind, string> = {
  permission: 'Permission',
  question: 'Question',
  plan: 'Plan',
  done: 'Finished',
  blocked: 'Blocked',
  limit: 'Limit hit',
  error: 'API error',
  usage: 'Usage',
  reminder: 'Still waiting',
  'send-failed': 'Prompt not delivered',
  launch: 'Start',
  security: 'Security',
  med: 'Medicine',
  life: 'Reminder',
};

/** bodies: generic. Nothing that names a folder, a tool or an account. */
export const GENERIC_TITLE: Record<NotifyKind, string> = {
  permission: 'A session needs you',
  question: 'A session needs you',
  plan: 'A session needs you',
  reminder: 'A session still needs you',
  'send-failed': 'A prompt was not delivered',
  done: 'A session finished',
  blocked: 'A session is blocked',
  error: 'A session hit an API error',
  limit: 'An account hit its limit',
  usage: 'An account is filling up',
  launch: 'A session was started from a phone',
  security: 'A device tried to open protected files',
  med: 'Medicine due',
  life: 'Something is due',
};

/** Extra facts the router looks up in state, so the text stays pure. */
export interface TextContext {
  /** IANA zone for "17:31"; the Mac's own when omitted. */
  timeZone?: string;
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
}

/** First line without Markdown heading or list marks ("# Plan", "1. Add tests" stays numbered). */
function leadLine(s: string): string {
  return firstLine(s).replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim();
}

/** "the terminal tab has no running program" -> "The terminal tab has no running program." */
export function sentence(s: string): string {
  const t = oneLine(s);
  if (!t) return '';
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

/** "17:31" on a 24-hour clock. */
export function hhmm(iso: string, timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(t);
}

/** "12m", "1h12", "2h". */
export function dur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
}

/** Account ids read like the web app: "03". */
export function acct(id: number): string {
  return String(id).padStart(2, '0');
}

/** "<folder><rest>" in at most MAX_TITLE characters: the folder gives way, the words after it never do. */
export function titled(folder: string, rest: string): string {
  const room = Math.max(8, MAX_TITLE - [...rest].length);
  return `${clip(oneLine(folder), room)}${rest}`;
}

function folderOf(sid: string, session?: Session | null): string {
  return session?.folder || session?.name?.trim() || sid.slice(0, 8);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** What a tool call wants to do, in one line (the terminal style: "$ cmd" for Bash). */
export function describeToolCall(tool: string, input: unknown): string {
  const i = asRecord(input);
  if (tool === 'Bash') return `$ ${oneLine(str(i.command) ?? '')}`.trim();
  const detail = toolDetail(tool, input);
  return detail ? `${tool} ${detail}` : tool;
}

/** The object of a tool call: the command, the file, the URL. Empty when there is none. */
export function toolDetail(tool: string, input: unknown): string {
  const i = asRecord(input);
  switch (tool) {
    case 'Bash':
      return oneLine(str(i.command) ?? '');
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
      return str(i.file_path) ?? '';
    case 'NotebookEdit':
      return str(i.notebook_path) ?? '';
    case 'WebFetch':
      return str(i.url) ?? '';
    case 'WebSearch':
      return oneLine(str(i.query) ?? '');
    case 'Task':
    case 'Agent':
      return oneLine(str(i.description) ?? str(i.prompt) ?? '');
    default: {
      const j = canonicalJson(input ?? {});
      return j === '{}' ? '' : clip(j, 200);
    }
  }
}

function questionText(p: PendingRequest): string {
  const qs = p.questions ?? [];
  const q = qs[0];
  if (!q) return 'Claude has a question.';
  const more = qs.length > 1 ? ` (+${qs.length - 1} more)` : '';
  return `${oneLine(q.question)}${more}`;
}

function planText(p: PendingRequest): string {
  const plan = str(asRecord(p.input).plan);
  return (plan && leadLine(plan)) || 'Claude has a plan ready for approval.';
}

/** The notification kind for a card. Subagent cards are informational and never pushed. */
export function cardKind(p: PendingRequest): NotifyKind | null {
  switch (p.kind) {
    case 'permission':
      return 'permission';
    case 'question':
      return 'question';
    case 'plan':
      return 'plan';
    default:
      return null;
  }
}

/** Claude's own `waitingFor` word, mapped to a kind. */
export function waitingKind(waitingFor: string | undefined): NotifyKind {
  const w = (waitingFor ?? '').toLowerCase();
  if (w.includes('plan')) return 'plan';
  if (w.includes('permission') || w.includes('approv') || w.includes('tool')) return 'permission';
  return 'question';
}

export function alertKind(kind: AlertKind): NotifyKind {
  switch (kind) {
    case 'blocked':
    case 'rejected':
      return 'blocked';
    case 'limit':
      return 'limit';
    case 'error':
      return 'error';
  }
}

function windowLabel(w: string): string {
  if (w === 'five_hour') return '5h';
  if (w === 'seven_day') return '7d';
  return w.startsWith('scoped:') ? w.slice('scoped:'.length) : w;
}

interface Draft {
  kind: NotifyKind;
  title: string;
  /** Body with bodies: full. */
  full: string;
  /** Body with bodies: short. */
  short: string;
  sid?: string;
  pendingId?: string;
  url?: string;
  tag?: string;
  baseKind?: NotifyKind;
  folder?: string;
}

/** Apply the bodies mode and length caps. */
export function finish(d: Draft, mode: BodiesMode, ts: string): RoutedNotification {
  let title = d.title;
  let body: string;
  if (mode === 'generic') {
    title = GENERIC_TITLE[d.kind];
    body = GENERIC_BODY;
  } else if (mode === 'short') {
    body = clip(oneLine(d.short), MAX_BODY_SHORT);
  } else {
    body = clip(d.full.trim(), MAX_BODY_FULL);
  }
  const n: RoutedNotification = { kind: d.kind, title: clip(oneLine(title), MAX_TITLE), body, ts };
  if (d.sid !== undefined) n.sid = d.sid;
  if (d.pendingId !== undefined) n.pendingId = d.pendingId;
  if (d.url !== undefined) n.url = d.url;
  if (d.tag !== undefined) n.tag = d.tag;
  if (d.baseKind !== undefined) n.baseKind = d.baseKind;
  if (d.folder !== undefined && mode !== 'generic') n.folder = d.folder;
  return n;
}

const sessionUrl = (sid: string) => `/s/${encodeURIComponent(sid)}`;
const sessionTag = (sid: string) => `s:${sid}`;
const accountTag = (id: number) => `acct:${id}`;

/** "web-app needs you" / "infra has a plan for you". */
function needsTitle(kind: NotifyKind, folder: string): string {
  return titled(folder, kind === 'plan' ? ' has a plan for you' : ' needs you');
}

const WAITING_SHORT: Partial<Record<NotifyKind, string>> = {
  question: 'Question waiting',
  permission: 'Permission waiting',
  plan: 'Plan waiting',
};

export function cardNotification(p: PendingRequest, session: Session | null | undefined, mode: BodiesMode, ts: string): RoutedNotification | null {
  const kind = cardKind(p);
  if (!kind) return null;
  const folder = folderOf(p.sid, session);
  let full: string;
  let short: string;
  if (kind === 'question') {
    full = `Question: ${questionText(p)}`;
    short = 'Question waiting';
  } else if (kind === 'plan') {
    full = planText(p);
    short = 'Plan waiting';
  } else {
    const detail = toolDetail(p.tool, p.input);
    full = detail ? `Permission · ${p.tool}: ${detail}` : `Permission · ${p.tool}`;
    short = `Permission waiting · ${p.tool}`;
  }
  return finish(
    {
      kind,
      title: needsTitle(kind, folder),
      full,
      short,
      sid: p.sid,
      pendingId: p.id,
      url: `${sessionUrl(p.sid)}?card=${encodeURIComponent(p.id)}`,
      tag: sessionTag(p.sid),
      folder,
    },
    mode,
    ts,
  );
}

/** A session that Claude says is waiting, with no card (the hook-less path). */
export function waitingNotification(session: Session, mode: BodiesMode, ts: string): RoutedNotification {
  const kind = waitingKind(session.waitingFor);
  const folder = folderOf(session.sid, session);
  const text = session.now?.text?.trim();
  const full = text ? `${KIND_WORD[kind]}: ${text}` : session.waitingFor ? `Waiting for ${session.waitingFor} in the terminal.` : 'Waiting in the terminal.';
  return finish(
    {
      kind,
      title: needsTitle(kind, folder),
      full,
      short: WAITING_SHORT[kind] ?? 'Waiting in the terminal',
      sid: session.sid,
      url: sessionUrl(session.sid),
      tag: sessionTag(session.sid),
      folder,
    },
    mode,
    ts,
  );
}

/** "web-app still needs you · 30m", with the original question or command as the body. */
export function reminderNotification(base: RoutedNotification, afterMin: number, mode: BodiesMode, ts: string): RoutedNotification {
  const waited = dur(afterMin * 60_000);
  const folder = base.folder ?? (base.sid ? base.sid.slice(0, 8) : 'A session');
  const draft: Draft = {
    kind: 'reminder',
    title: titled(folder, ` still needs you · ${waited}`),
    full: base.body,
    short: `Still waiting · ${waited}`,
    baseKind: base.kind,
    folder,
  };
  if (base.sid !== undefined) draft.sid = base.sid;
  if (base.pendingId !== undefined) draft.pendingId = base.pendingId;
  if (base.url !== undefined) draft.url = base.url;
  if (base.tag !== undefined) draft.tag = base.tag;
  return finish(draft, mode, ts);
}

/** "api-server finished · 7m": `ranMs` is how long the turn ran, when known. */
export function doneNotification(
  sid: string,
  session: Session | null | undefined,
  lastReply: { text: string } | undefined,
  mode: BodiesMode,
  ts: string,
  ranMs?: number,
): RoutedNotification {
  const folder = folderOf(sid, session);
  const reply = lastReply?.text?.trim() || session?.lastReply?.text?.trim() || '';
  const ran = ranMs !== undefined && Number.isFinite(ranMs) && ranMs >= 60_000 ? ` · ${dur(ranMs)}` : '';
  return finish(
    {
      kind: 'done',
      title: titled(folder, ` finished${ran}`),
      full: (reply && leadLine(reply)) || 'Claude finished its turn.',
      short: 'Finished',
      sid,
      url: sessionUrl(sid),
      tag: sessionTag(sid),
      folder,
    },
    mode,
    ts,
  );
}

/** For a limit alert: the account's window that ran out and who is on it. */
export interface LimitContext extends TextContext {
  /** "5-hour" or "weekly"; omitted when unknown. */
  window?: string;
  resetsAt?: string;
  /** Folders of the sessions on that account. */
  folders?: string[];
}

function joinFolders(folders: readonly string[]): string {
  const f = [...new Set(folders)];
  if (f.length <= 2) return f.join(' and ');
  return `${f.slice(0, 2).join(', ')} and ${f.length - 2} more`;
}

export function alertNotification(
  alert: Alert,
  session: Session | null | undefined,
  mode: BodiesMode,
  ts: string,
  ctx: LimitContext = {},
): RoutedNotification {
  const kind = alertKind(alert.kind);
  const url = `/alerts?id=${encodeURIComponent(alert.id)}`;
  const folder = alert.sid ? folderOf(alert.sid, session) : alert.label || 'A session';
  const why = alert.why ? sentence(alert.why) : '';

  const account = alert.account ?? session?.account ?? undefined;
  if (kind === 'limit' && account !== undefined && account !== null) {
    const at = ctx.resetsAt ? hhmm(ctx.resetsAt, ctx.timeZone) : '';
    const who = ctx.folders?.length ? `${joinFolders(ctx.folders)} ${ctx.folders.length === 1 ? 'is' : 'are'} paused.` : '';
    const full = [at ? `Resets ${at}.` : '', who].filter(Boolean).join(' ') || why || sentence(alert.what);
    return finish(
      {
        kind,
        title: `acct ${acct(account)} hit its ${ctx.window ? `${ctx.window} ` : ''}limit`,
        full,
        short: at ? `Limit hit · resets ${at}` : 'Limit hit',
        url: '/accounts',
        tag: accountTag(account),
        ...(alert.sid ? { sid: alert.sid } : {}),
      },
      mode,
      ts,
    );
  }

  let title: string;
  let full: string;
  if (kind === 'blocked') {
    title = titled(folder, ' is blocked');
    full = [sentence(alert.what), why].filter(Boolean).join(' ');
  } else if (kind === 'error') {
    title = titled(folder, ' hit an API error');
    full = why || sentence(alert.what);
  } else {
    title = titled(folder, ' hit a limit');
    full = why || sentence(alert.what);
  }
  const d: Draft = { kind, title, full, short: KIND_WORD[kind], url, tag: alert.sid ? sessionTag(alert.sid) : `alert:${kind}` };
  if (alert.sid) {
    d.sid = alert.sid;
    d.folder = folder;
  }
  return finish(d, mode, ts);
}

/** For a usage threshold: when the window resets and when it is full at this pace. */
export interface UsageContext extends TextContext {
  resetsAt?: string;
  /** When the window is full at the current burn, if before the reset. */
  fullAt?: string;
}

export function usageNotification(
  account: number,
  data: { window: string; pct: number; threshold: number },
  mode: BodiesMode,
  ts: string,
  ctx: UsageContext = {},
): RoutedNotification {
  const w = windowLabel(data.window);
  const pct = Math.round(data.pct);
  const now = Date.parse(ts);
  const reset = ctx.resetsAt ? Date.parse(ctx.resetsAt) : NaN;
  const at = Number.isFinite(reset) ? hhmm(ctx.resetsAt as string, ctx.timeZone) : '';
  const fullAt = Number.isFinite(reset) && Number.isFinite(now) && reset > now ? Date.parse(ctx.fullAt ?? '') : NaN;
  const parts = [
    at ? `Resets ${at}${reset > now ? `, in ${dur(reset - now)}` : ''}.` : `Crossed ${data.threshold}%.`,
    Number.isFinite(fullAt) && fullAt > now && fullAt < reset ? `Full at this pace ~${hhmm(ctx.fullAt as string, ctx.timeZone)}.` : '',
  ];
  return finish(
    {
      kind: 'usage',
      title: `acct ${acct(account)} at ${pct}% of ${w}`,
      full: parts.filter(Boolean).join(' '),
      short: at ? `${pct}% · resets ${at}` : `${pct}%`,
      url: '/accounts',
      tag: accountTag(account),
    },
    mode,
    ts,
  );
}

export function sendFailedNotification(job: SendJob, session: Session | null | undefined, mode: BodiesMode, ts: string): RoutedNotification {
  const folder = folderOf(job.sid, session);
  const reason = sentence(job.reason ?? '') || 'The prompt was not proven by the transcript.';
  return finish(
    {
      kind: 'send-failed',
      title: `Not delivered to ${clip(oneLine(folder), MAX_TITLE - 'Not delivered to '.length)}`,
      full: `${reason} Tap to retry.`,
      short: 'Prompt not delivered',
      sid: job.sid,
      url: `${sessionUrl(job.sid)}?send=${encodeURIComponent(job.id)}`,
      tag: sessionTag(job.sid),
      folder,
    },
    mode,
    ts,
  );
}

// ---- v0.5.3: the urgent alert and the test push --------------------------------

/** The urgent push's body in the full and short modes: never the ask's own words. */
export const URGENT_BODY = 'Claude blocks this ask by itself if nobody answers.';

/** "about 2 min" (93 s and 110 s), "about 1 min" (60 s), "under a minute" (under 45 s): never "1 min 59 s". */
export function leftWords(seconds: number): string {
  return seconds >= 45 ? `about ${Math.round(seconds / 60)} min` : 'under a minute';
}

/**
 * Claude's auto-block countdown on an unattended ask (spec 1.3): "web-app ·
 * about 2 min to answer", a `permission` push with the ask's `deadline`
 * (ISO), so its alert group is `urgent` and its TTL runs out with it. No
 * prompt text in any mode; generic: "About 2 min to answer" and no body.
 */
export function urgentNotification(session: Session, left: number, deadline: string, mode: BodiesMode, ts: string): RoutedNotification {
  const words = `${leftWords(left)} to answer`;
  const folder = folderOf(session.sid, session);
  const n = finish(
    {
      kind: 'permission',
      title: titled(folder, ` · ${words}`),
      full: URGENT_BODY,
      short: URGENT_BODY,
      sid: session.sid,
      url: sessionUrl(session.sid),
      tag: sessionTag(session.sid),
      folder,
    },
    mode,
    ts,
  );
  if (mode === 'generic') n.title = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  n.deadline = deadline;
  return n;
}

/** What `jantar notify test <group>` sends: the kind of each group (urgent: a permission with a deadline). */
export const TEST_KIND: Readonly<Record<AlertGroup, NotifyKind>> = {
  urgent: 'permission',
  needs: 'permission',
  done: 'done',
  care: 'life',
  problem: 'send-failed',
};

/** The groups as the phone's Sounds screen names them. */
export const ALERT_GROUP_LABEL: Readonly<Record<AlertGroup, string>> = {
  urgent: 'Answer soon',
  needs: 'Needs you',
  done: 'Done',
  care: 'Medicines and reminders',
  problem: 'Problems',
};

/** How long the urgent test push says it has (Claude's countdown starts near two minutes). */
export const TEST_URGENT_S = 120;

/**
 * One test push of `group` (POST /v1/notify/test): fixed words, the group's
 * kind, and for `urgent` a deadline TEST_URGENT_S ahead. `care` reaches
 * control-scope devices only, as every Life push does.
 */
export function testNotification(group: AlertGroup, ts: string): Notification {
  const n: Notification = {
    kind: TEST_KIND[group],
    title: 'Jantar test',
    body: `This is how "${ALERT_GROUP_LABEL[group]}" alerts arrive.`,
    url: '/',
    tag: `test:${group}`,
    ts,
  };
  if (group === 'urgent') n.deadline = new Date(Date.parse(ts) + TEST_URGENT_S * 1000).toISOString();
  if (group === 'care') n.minScope = 'control';
  return n;
}
