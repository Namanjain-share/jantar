/**
 * The Alerts timeline (direction.md 5.4): rows grouped under day rails, each
 * with a subject (folder · session, or the account), a past-tense sentence
 * and one action. Pure helpers, easy to test.
 *
 * v0.6 (Fleet): an alert from a paired machine (`alert.node`) names the
 * machine first ("build-1 · api-server · fix-tests"), from the Mac's name
 * for it, once the screen passes `nodes`.
 */
import { machineName, type Alert, type AlertKind, type NodeView, type Session } from '@jantar/protocol';
import { PRODUCT_NAME } from '../../../brand.js';
import { accountId } from '../../../lib/format.js';
import { routePath, type AlertsKind } from '../../../lib/router.js';
import { dayLabel, dayStart } from '../accounts/time.js';

/**
 * Remember the newest alert this device has seen (for the tab badge and the
 * Desk). Here, not in Alerts.tsx, so the badge does not pull the screen into
 * the main chunk (0.12: Alerts opens from its own chunk).
 */
export const ALERTS_SEEN_KEY = 'alerts-seen-ts';

/** Kind filters, shown only past FILTER_FROM alerts. `?kind=` in the URL. */
export type KindFilter = 'all' | AlertKind;
export const FILTER_FROM = 20;
export const FILTER_LABEL: Record<KindFilter, string> = {
  all: 'All',
  limit: 'Limits',
  error: 'Errors',
  blocked: 'Blocked',
  rejected: 'Rejected',
};
export const FILTER_ORDER: KindFilter[] = ['all', 'limit', 'error', 'blocked', 'rejected'];

export function parseKind(v: string | null | undefined): KindFilter {
  return v && (FILTER_ORDER as string[]).includes(v) ? (v as KindFilter) : 'all';
}

/** One alert's kind, as its detail names it. */
export const KIND_WORD: Record<AlertKind, string> = { limit: 'Limit', error: 'API error', blocked: 'Blocked', rejected: 'Rejected' };

/** 0.12: the list's address (its kind filter), and with `id` one alert open beside it. */
export function alertsPath(kind: KindFilter, id?: string): string {
  return routePath({ name: 'alerts', ...(kind !== 'all' ? { kind: kind as AlertsKind } : {}), ...(id ? { id } : {}) });
}

/**
 * The other alerts of the same session (or, for an account's limit, of the
 * same account), newest first: the detail's "Earlier from this session".
 */
export function relatedAlerts(alerts: readonly Alert[], a: Alert, max = 5): Alert[] {
  const same = (b: Alert) => (a.sid ? b.sid === a.sid : a.account !== undefined && b.account === a.account && !b.sid);
  return alerts
    .filter((b) => b.id !== a.id && same(b))
    .sort((x, y) => y.ts.localeCompare(x.ts))
    .slice(0, max);
}

/**
 * What the Mac wrote down, for the detail's terminal box: the longer text
 * when there is one, else the label it was filed under and what happened.
 */
export function recordOf(a: Alert): string {
  const full = a.full?.trim();
  if (full) return full;
  return [a.label.trim(), a.what.trim(), a.why?.trim()].filter(Boolean).join('\n');
}

/**
 * "api-server · rate limiter". The live session names it when it still
 * exists; otherwise the label ("status · folder · session") without its
 * status word; an account alert reads "acct 03". A paired machine's alert
 * starts with the machine ("build-1 · api-server · rate limiter").
 */
export function subjectOf(a: Alert, sessions: Record<string, Session>, nodes?: Record<string, NodeView>): string {
  const what = subjectText(a, sessions);
  return a.node !== undefined && nodes && Object.keys(nodes).length ? `${machineName({ nodes }, a.node)} · ${what}` : what;
}

function subjectText(a: Alert, sessions: Record<string, Session>): string {
  const s = a.sid ? sessions[a.sid] : undefined;
  if (s) return [s.folder, s.name?.trim()].filter(Boolean).join(' · ');
  const parts = a.label.split(' · ').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts.slice(1).join(' · ');
  if (parts.length) return parts.join(' · ');
  return a.account !== undefined ? `acct ${accountId(a.account)}` : PRODUCT_NAME;
}

/** `what`, with `why` appended as a second sentence (or after a middot). */
export function sentenceOf(a: Alert): string {
  const what = a.what.trim();
  const why = a.why?.trim();
  if (!why) return what;
  return /[.!?:]$/.test(what) ? `${what} ${why}` : `${what} · ${why}`;
}

export interface AlertAction {
  label: 'Open session' | 'Open accounts';
  href: string;
}

/** One left-aligned action: the session while it is live, or Accounts for limits. */
export function actionOf(a: Alert, sessions: Record<string, Session>): AlertAction | null {
  if (a.sid && sessions[a.sid]) return { label: 'Open session', href: routePath({ name: 'session', sid: a.sid }) };
  if (a.kind === 'limit' || a.account !== undefined) return { label: 'Open accounts', href: routePath({ name: 'accounts' }) };
  return null;
}

export interface DayGroup {
  key: number;
  label: string;
  alerts: Alert[];
}

/** Newest first, grouped by local day ("Today", "Yesterday", "Mon 26 Oct"). */
export function byDay(alerts: readonly Alert[], now: number): DayGroup[] {
  const sorted = [...alerts].sort((a, b) => b.ts.localeCompare(a.ts));
  const out: DayGroup[] = [];
  for (const a of sorted) {
    const t = Date.parse(a.ts);
    const key = Number.isFinite(t) ? dayStart(t) : 0;
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: Number.isFinite(t) ? dayLabel(t, now) : 'Earlier', alerts: [] };
      out.push(g);
    }
    g.alerts.push(a);
  }
  return out;
}
