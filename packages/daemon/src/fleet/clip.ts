/**
 * v0.6 Fleet: clipping what a node supplies, shared by the hub's ingest and
 * the node's own sender (the node clips before it sends, the hub again
 * before it keeps anything).
 *
 * Session text to the Mac's own caps (REPLY_TEXT_MAX, NOW_TEXT_MAX,
 * AWAY_TEXT_MAX, ERROR_TEXT_MAX from sources/transcripts/parse.ts), every
 * other string field to NODE_LIMITS.fieldMax; a card's input over
 * cardInputBytes, as sent or still after its leaves are cut, becomes {} (the
 * phone shows FLEET_COPY.cardTooLarge: nobody approves a command they only
 * see the start of), else its leaves go to cardStringMax, arrays to
 * cardArrayMax, depth to cardDepthMax;
 * suggestions and questions to their caps; alerts', sends' and launches'
 * free text to fieldMax; a node's accounts to ACCOUNTS_MAX, their short
 * strings to ACCOUNT_TEXT_MAX (each `usage.updated` becomes a `node.updated`
 * carrying the whole NodeView). The node keeps its own unclipped card for the
 * decision it builds.
 *
 * Pure: every function returns a new value and never changes its input.
 */
import type { Account, Alert, DaemonEvent, EventType, LaunchJob, PendingRequest, Question, SendJob, Session } from '@jantar/protocol';
import { NODE_LIMITS } from '@jantar/protocol/node-link';
import { AWAY_TEXT_MAX, ERROR_TEXT_MAX, NOW_TEXT_MAX, REPLY_TEXT_MAX } from '../sources/transcripts/parse.js';
import { clip } from '../sources/lib/values.js';

/**
 * The events a node sends and the hub takes (spec 3.5's table). Anything
 * else the hub knows is dropped there, not counted; the node never sends it.
 */
export const NODE_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'session.added',
  'session.updated',
  'session.removed',
  'session.done',
  'session.waiting',
  'pending.opened',
  'pending.resolved',
  'send.progress',
  'launch.progress',
  'alert.blocked',
  'alert.rejected',
  'alert.limit',
  'alert.error',
  'daemon.version',
  'usage.updated',
]);

/** A snapshot's finished sends and launches, and its alerts: the newest this many. */
export const SNAPSHOT_RECENT = 20;

/** NodeView.version's own cap (a node's Jantar version). */
const VERSION_MAX = 64;
/** Usage windows kept per account (a real account has two or three). */
const WINDOWS_MAX = 16;
/** Accounts kept per node (a server has a few). */
export const ACCOUNTS_MAX = 32;
/** An account's own strings (alias, masked email, usage status) and a window's kind. */
const ACCOUNT_TEXT_MAX = 128;

/**
 * What one node's events may add to the hub's store in 10 s, serialized
 * (next to NODE_LIMITS.eventsPer10s, which counts them): the hub closes the
 * link 1013 above it, and the node's sender stays under it by itself. Every
 * accepted event is kept in the replay ring and jantar.db and sent to every
 * phone, so a count alone would let large ones through.
 */
export const EVENT_BYTES_PER_10S = 4 * 1024 * 1024;

const { fieldMax, cardStringMax, cardArrayMax, cardDepthMax, cardInputBytes, suggestionsMax, suggestionsBytes, questionsMax, labelMax } = NODE_LIMITS;

/** The serialized size of a value, in UTF-8 bytes (what the state budget counts). */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}

/** A copy with every top-level string field cut to `max` (callers then set the fields with caps of their own). */
function clipStrings<T extends object>(rec: T, max: number): T {
  const out = { ...rec } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (typeof v === 'string') out[k] = clip(v, max);
  return out as T;
}

/** A session, or a session.updated patch: the same fields where present. */
function clipSessionFields<T extends Partial<Session>>(s: T): T {
  const out = clipStrings(s, fieldMax);
  if (s.away !== undefined) out.away = clip(s.away, AWAY_TEXT_MAX);
  if (s.errorLast !== undefined) out.errorLast = clip(s.errorLast, ERROR_TEXT_MAX);
  if (s.lastReply) out.lastReply = { ...s.lastReply, text: clip(s.lastReply.text, REPLY_TEXT_MAX) };
  if (s.now) {
    const now = { ...s.now, text: clip(s.now.text, NOW_TEXT_MAX) };
    if (s.now.tool !== undefined) now.tool = clip(s.now.tool, fieldMax);
    out.now = now;
  }
  if (s.move) out.move = clipStrings(s.move, fieldMax);
  return out;
}

export function clipSession(s: Session): Session {
  return clipSessionFields(s);
}

/**
 * Any JSON value from a card: string leaves to cardStringMax, arrays to
 * cardArrayMax items, nothing deeper than cardDepthMax (a deeper container
 * becomes empty). Keys are cut to fieldMax; `__proto__` keys are dropped.
 */
function clipValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, cardStringMax);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= cardDepthMax) return Array.isArray(v) ? [] : {};
  if (Array.isArray(v)) return v.slice(0, cardArrayMax).map((x) => clipValue(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => k !== '__proto__')
      .map(([k, x]) => [clip(k, fieldMax), clipValue(x, depth + 1)]),
  );
}

/** A card's input (or decision): {} when it is over cardInputBytes, as sent or after clipping; else clipped. */
function clipInput(v: unknown): unknown {
  if (jsonBytes(v) > cardInputBytes) return {};
  const out = clipValue(v);
  return jsonBytes(out) > cardInputBytes ? {} : out;
}

/** At most suggestionsMax, and dropped from the end until they fit suggestionsBytes (the phone picks by index). */
function clipSuggestions(list: readonly unknown[]): unknown[] {
  const out = list.slice(0, suggestionsMax).map((x) => clipValue(x));
  while (out.length > 0 && jsonBytes(out) > suggestionsBytes) out.pop();
  return out;
}

function clipQuestion(q: Question): Question {
  const out = clipValue(q) as Question;
  out.question = clip(q.question, cardStringMax);
  if (q.header !== undefined) out.header = clip(q.header, labelMax);
  out.options = q.options.slice(0, cardArrayMax).map((o) => {
    const opt = clipValue(o) as Question['options'][number];
    opt.label = clip(o.label, labelMax);
    if (o.description !== undefined) opt.description = clip(o.description, labelMax);
    return opt;
  });
  return out;
}

export function clipCard(p: PendingRequest): PendingRequest {
  const out = clipStrings(p, fieldMax);
  out.input = clipInput(p.input);
  out.suggestions = clipSuggestions(p.suggestions);
  if (p.questions !== undefined) {
    const questions = p.questions.slice(0, questionsMax).map(clipQuestion);
    // Questions too large to show: the card keeps its tool name and the phone's "too large" line.
    if (jsonBytes(p.questions) > cardInputBytes || jsonBytes(questions) > cardInputBytes) {
      delete out.questions;
      out.input = {};
    } else {
      out.questions = questions;
    }
  }
  if (p.decision !== undefined) out.decision = clipInput(p.decision);
  return out;
}

export function clipAlert(a: Alert): Alert {
  return clipStrings(a, fieldMax);
}

export function clipSend(job: SendJob): SendJob {
  const out = clipStrings(job, fieldMax);
  if (job.proof) out.proof = clipStrings(job.proof, fieldMax);
  return out;
}

export function clipLaunch(job: LaunchJob): LaunchJob {
  const out = clipStrings(job, fieldMax);
  if (job.dialog) {
    out.dialog = { ...clipStrings(job.dialog, fieldMax), options: job.dialog.options.slice(0, cardArrayMax).map((o) => clip(o, fieldMax)) };
  }
  if (job.prompt) out.prompt = clipStrings(job.prompt, fieldMax);
  out.steps = job.steps.map((s) => clipStrings(s, fieldMax));
  return out;
}

export function clipAccount(a: Account): Account {
  const out = clipStrings(a, ACCOUNT_TEXT_MAX);
  out.windows = a.windows.slice(0, WINDOWS_MAX).map((w) => clipStrings(w, ACCOUNT_TEXT_MAX));
  return out;
}

/** The first ACCOUNTS_MAX accounts, clipped. */
export function clipAccounts(list: readonly Account[]): Account[] {
  return list.slice(0, ACCOUNTS_MAX).map(clipAccount);
}

/** Any event a node may send, clipped as above; other events as they are. */
export function clipEvent(ev: DaemonEvent): DaemonEvent {
  switch (ev.type) {
    case 'session.added':
      return { ...ev, data: { session: clipSession(ev.data.session) } };
    case 'session.updated':
      return { ...ev, data: { ...ev.data, patch: clipSessionFields(ev.data.patch) } };
    case 'session.done':
      return ev.data.lastReply ? { ...ev, data: { lastReply: { ...ev.data.lastReply, text: clip(ev.data.lastReply.text, REPLY_TEXT_MAX) } } } : ev;
    case 'session.waiting':
      return { ...ev, data: clipStrings(ev.data, fieldMax) };
    case 'pending.opened':
      return { ...ev, data: { pending: clipCard(ev.data.pending) } };
    case 'pending.resolved': {
      const data = clipStrings(ev.data, fieldMax);
      if (ev.data.decision !== undefined) data.decision = clipInput(ev.data.decision);
      return { ...ev, data };
    }
    case 'send.progress':
      return { ...ev, data: { job: clipSend(ev.data.job) } };
    case 'launch.progress':
      return { ...ev, data: { job: clipLaunch(ev.data.job) } };
    case 'alert.blocked':
    case 'alert.rejected':
    case 'alert.limit':
    case 'alert.error':
      return { ...ev, data: { alert: clipAlert(ev.data.alert) } };
    case 'usage.updated':
      return { ...ev, data: { ...ev.data, accounts: clipAccounts(ev.data.accounts) } };
    case 'daemon.version': {
      const data = clipStrings(ev.data, fieldMax);
      data.daemonVersion = clip(ev.data.daemonVersion, VERSION_MAX);
      return { ...ev, data };
    }
    default:
      return ev;
  }
}
