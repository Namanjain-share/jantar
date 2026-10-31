/**
 * Data for New session: one small request hook the browser, the start form
 * and the receipt share, path helpers for (root id, relative path) pairs,
 * and the sentences for the refusals this screen reads from the daemon.
 *
 * The first prompt of a launch is kept in memory only (never in the URL or
 * storage), so a failed delivery can be put back into the session's
 * composer ("Edit and resend"), or into the start form ("Try again").
 *
 * v0.4 Resume: the words and the line the start sheet shows for a folder's
 * past conversations (GET /v1/launch/history). A resume is a choice per
 * start, never remembered: Off, Last (the newest one not running) or one
 * picked from the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CLI_NAME, LAUNCH_CAP, type PastSession } from '@jantar/protocol';
import { isApiError } from '../../../lib/api.js';
import { accountId } from '../../../lib/format.js';
import { deviceNoun, readLocalDevice, userAgent } from '../devices/local.js';

/** The root segment that lists the folders live sessions run in (a client view, never sent to the daemon). */
export const SESSIONS_VIEW = 'sessions';

// ---------------------------------------------------------------------------
// Paths: the daemon takes a root id plus a clean relative POSIX path.

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * The relative path of `display` under a root shown as `rootDisplay`
 * ("~/Desktop/work" and "~/Desktop/work/api/v2" -> "api/v2"); null when it
 * is not under that root.
 */
export function relUnder(rootDisplay: string, display: string): string | null {
  const root = rootDisplay.replace(/\/+$/, '');
  if (display === root) return '';
  return display.startsWith(`${root}/`) ? display.slice(root.length + 1) : null;
}

// ---------------------------------------------------------------------------
// Requests

export interface Request<T> {
  data: T | undefined;
  /** The data is the answer for the current key (false: an older key's, kept with `keep`). */
  fresh: boolean;
  error: unknown;
  /** A request for the current key is in flight. */
  loading: boolean;
  /** Run it again for the same key (the data stays until the answer arrives). */
  reload: () => void;
  /** Replace the data in hand (an optimistic pin, a page appended). */
  set: (fn: (cur: T | undefined) => T | undefined) => void;
}

interface RequestState<T> {
  /** The key last asked for. */
  key: string | null;
  /** The key `data` answers. */
  dataKey: string | null;
  data?: T;
  error?: unknown;
  loading: boolean;
}

/**
 * Fetch `run()` whenever `key` changes (null: nothing to fetch). Answers for
 * an older key are dropped, so a slow reply never paints over a newer one.
 * Data for a different key is not shown (a new folder starts as loading)
 * unless `keep` is set: the start form keeps the last preview on screen,
 * marked not `fresh`, instead of a spinner over data it has.
 */
export function useRequest<T>(key: string | null, run: () => Promise<T>, opts: { keep?: boolean } = {}): Request<T> {
  const [st, setSt] = useState<RequestState<T>>({ key: null, dataKey: null, loading: key !== null });
  const runRef = useRef(run);
  runRef.current = run;
  const seq = useRef(0);

  const go = useCallback(() => {
    if (key === null) return;
    const n = ++seq.current;
    setSt((cur) => ({ ...cur, key, loading: true, error: cur.key === key ? cur.error : undefined }));
    runRef.current().then(
      (data) => {
        if (n === seq.current) setSt({ key, dataKey: key, data, loading: false });
      },
      (error: unknown) => {
        if (n === seq.current) setSt((cur) => ({ ...cur, key, error, loading: false }));
      },
    );
  }, [key]);

  useEffect(() => {
    go();
    return () => {
      // A newer key (or unmount) wins over anything still in flight.
      seq.current += 1;
    };
  }, [go]);

  const fresh = key !== null && st.dataKey === key;
  return {
    data: fresh || opts.keep ? st.data : undefined,
    fresh,
    error: st.key === key ? st.error : undefined,
    loading: key !== null && (st.key !== key || st.loading),
    reload: go,
    set: (fn) => setSt((cur) => (cur.dataKey === key ? { ...cur, data: fn(cur.data) } : cur)),
  };
}

// ---------------------------------------------------------------------------
// Refusals

/**
 * A 403 for a missing scope ("this device does not have the launch scope").
 * Scopes stored at pairing go stale after `devices grant` on the Mac, so the
 * screen learns it this way, never from what it stored.
 */
export function isNoScope(e: unknown): boolean {
  return isApiError(e, 'forbidden') && /\bscope\b/i.test(e.message);
}

/** A device name as one shell word ("iPhone", 'Sam'\''s iPhone'). */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/** What to run on the Mac to let this device start sessions. There is no grant button: the daemon refuses it over the network. */
export function grantCommand(): string {
  const me = readLocalDevice();
  return `${CLI_NAME} devices grant ${me ? shellWord(me.name) : '<device>'} launch`;
}

/** "This phone can't start sessions." (or tablet, browser) */
export function noScopeLead(): string {
  return `This ${deviceNoun(userAgent())} can't start sessions.`;
}

// ---------------------------------------------------------------------------
// The first prompt, kept for "Edit and resend" (memory only)

const prompts = new Map<string, string>();

export function keepPrompt(launchId: string, text: string): void {
  prompts.delete(launchId);
  prompts.set(launchId, text);
  while (prompts.size > LAUNCH_CAP) {
    const oldest = prompts.keys().next().value;
    if (oldest === undefined) break;
    prompts.delete(oldest);
  }
}

export function hasPrompt(launchId: string): boolean {
  return prompts.has(launchId);
}

/** The text, left in place (a start form for "Try again" reads it; the start drops it). */
export function peekPrompt(launchId: string): string | null {
  return prompts.get(launchId) ?? null;
}

/** The text, once: it is dropped as it is handed over. */
export function takePrompt(launchId: string): string | null {
  const t = prompts.get(launchId) ?? null;
  prompts.delete(launchId);
  return t;
}

// ---------------------------------------------------------------------------
// Resume (v0.4): a folder's past conversations

export type ResumeMode = 'off' | 'last' | 'pick';

export const NO_PAST = 'No past sessions in this folder';
export const PAST_UNREAD = "Couldn't read this folder's past sessions.";

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** When a conversation was last active: "14:02" today, else "Thu 30 Oct 14:02" (local, 24-hour, on every locale). */
export function pastWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const today = new Date(now);
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) return hm;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

/** The line under Resume: when, the account it is kept on (not with one login), and the first line in quotes. */
export function pastLine(p: PastSession, now: number, single: boolean): string {
  const parts = [pastWhen(p.lastAt, now)];
  if (p.account !== null && !single) parts.push(accountId(p.account));
  if (p.first) parts.push(`"${p.first}"`);
  return parts.join(' · ');
}

/**
 * The conversation Last opens: the newest one not running now. A session
 * open in the folder writes the newest transcript, and it is already on the
 * Board, so "the last session in this folder" is the one before it. None:
 * Last is disabled.
 */
export function lastPast(sessions: readonly PastSession[]): PastSession | undefined {
  return sessions.find((s) => !s.live);
}

/** The conversation a resume choice opens: lastPast for Last, the picked one for Pick (gone from the list: none). */
export function chosenPast(sessions: readonly PastSession[], mode: ResumeMode, picked: string | null): PastSession | undefined {
  if (mode === 'last') return lastPast(sessions);
  if (mode === 'pick' && picked !== null) return sessions.find((s) => s.id === picked);
  return undefined;
}
