/**
 * 0.13.0 Work's clients, pure helpers for its screens: the list's groups
 * (Needs a step, Clients, Leads, Past), the words a row says (its next
 * step, its last touch, its open deals per currency), Call, WhatsApp and
 * E-mail links (W31: the phone's own apps, filled in; he presses send
 * there), when to ask "Log the call?", what a delete takes with it (W30,
 * design 4.5), the next step's day chips, and the tags he types.
 *
 * Words someone else wrote (an import, a meeting's names) carry `from`:
 * the screens show them as data, marked where they came from, as Chat
 * frames them (parts.tsx FROM_LABEL).
 */
import type { ContactState, WorkClientHub, WorkClientRow, WorkSum } from '@jantar/protocol/work';
import { formatAmount } from '../../../lib/money.js';
import { routePath, type WorkClientState } from '../../../lib/router.js';
import { shiftDayKey } from '../life/shared/DayNav.js';
import { dueWord } from './model.js';

export const STATE_LABEL: Record<ContactState, string> = { lead: 'Lead', client: 'Client', past: 'Past' };

/** The state chips over the list: All is no filter. */
export const STATE_CHIPS: readonly { key: 'all' | WorkClientState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'lead', label: 'Leads' },
  { key: 'client', label: 'Clients' },
  { key: 'past', label: 'Past' },
];

export type ClientGroup = 'step' | 'client' | 'lead' | 'past';
/** The list's groups, in order (Past folded until opened, unless he asked for past ones). */
export const CLIENT_GROUPS: readonly { key: ClientGroup; label: string }[] = [
  { key: 'step', label: 'Needs a step' },
  { key: 'client', label: 'Clients' },
  { key: 'lead', label: 'Leads' },
  { key: 'past', label: 'Past' },
];

/** W12: a client (not past) with an open deal and no open follow-up has no next step. */
export function needsStep(row: Pick<WorkClientRow, 'state' | 'openDeals' | 'next'>): boolean {
  return row.state !== 'past' && row.openDeals.count > 0 && !row.next;
}

/** The rows under their groups, each in the daemon's order; one that needs a step is listed there only. */
export function groupClients(rows: readonly WorkClientRow[]): Record<ClientGroup, WorkClientRow[]> {
  const out: Record<ClientGroup, WorkClientRow[]> = { step: [], client: [], lead: [], past: [] };
  for (const r of rows) out[needsStep(r) ? 'step' : r.state].push(r);
  return out;
}

/** Whole days from an instant to now (0: today or later). */
export function daysSince(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 86_400_000)) : 0;
}

/** "talked today", "talked 2d ago", or "quiet 21 days" from `quietDays` on (W14); "no touch yet" with none. */
export function touchText(lastTouchAt: string | undefined, nowMs: number, quietDays: number): { text: string; quiet: boolean } {
  if (!lastTouchAt) return { text: 'no touch yet', quiet: false };
  const d = daysSince(lastTouchAt, nowMs);
  if (d >= quietDays) return { text: `quiet ${d} days`, quiet: true };
  return { text: d === 0 ? 'talked today' : d === 1 ? 'talked yesterday' : `talked ${d}d ago`, quiet: false };
}

/** Amounts per currency, never added across (W17): "₹4,50,000 · $2,000". */
export function sumsText(sums: readonly WorkSum[]): string {
  return sums.map((s) => formatAmount(s.amount, s.currency)).join(' · ');
}

/** "2 open deals · ₹6,50,000", or nothing with none. */
export function openDealsText(od: WorkClientRow['openDeals']): string {
  if (!od.count) return '';
  const money = sumsText(od.sums.filter((s) => s.amount > 0));
  return `${od.count} open ${od.count === 1 ? 'deal' : 'deals'}${money ? ` · ${money}` : ''}`;
}

/** "next Thu 15:00", "next: Send the quote" (no day), or null with no follow-up. */
export function nextText(next: WorkClientRow['next'], today: string): string | null {
  if (!next) return null;
  return next.due ? `next ${dueWord(next.due, today)}` : `next: ${next.title}`;
}

/** Overdue: a follow-up due before today (the row's own word, ember). */
export function nextLate(next: WorkClientRow['next'], today: string): boolean {
  return Boolean(next?.due && next.due.day < today);
}

// ---------------------------------------------------------------------------
// Call, WhatsApp, E-mail (W31): the phone's own apps with the number or address filled in

/** A `tel:` link: the number's digits, with a leading + kept. */
export function telHref(phone: string): string {
  const v = phone.trim();
  return `tel:${v.startsWith('+') ? '+' : ''}${v.replace(/\D/g, '')}`;
}

/**
 * The number as WhatsApp needs it (country code first, digits only): "+…" or "00…" as it is; a 10-digit
 * number (or 0 and 10 digits) after Work's dial code; a longer one as it is. null when no country code can
 * be known (a 10-digit number and no dial code set), so the button doesn't show.
 */
export function waNumber(phone: string, dialCode?: string): string | null {
  const v = phone.trim();
  const digits = v.replace(/\D/g, '');
  if (!digits) return null;
  if (v.startsWith('+')) return digits;
  if (v.startsWith('00')) return digits.slice(2) || null;
  const code = dialCode?.replace(/\D/g, '') ?? '';
  if (digits.length === 10) return code ? code + digits : null;
  if (digits.length === 11 && digits.startsWith('0')) return code ? code + digits.slice(1) : null;
  return digits.length > 10 ? digits : null;
}

export function waHref(phone: string, dialCode?: string): string | null {
  const n = waNumber(phone, dialCode);
  return n ? `https://wa.me/${n}` : null;
}

export function mailHref(email: string): string {
  return `mailto:${email.trim()}`;
}

/**
 * W31 (builder's call): coming back to Jantar after a Call asks "Log the call?" only when the page was
 * hidden for at least ASK_AFTER_MS after the tap (a call dialog he cancelled hides it for less) and came
 * back within ASK_WITHIN_MS of the tap.
 */
export const ASK_AFTER_MS = 10_000;
export const ASK_WITHIN_MS = 2 * 60 * 60_000;
export function askLogCall(tappedAt: number, hiddenAt: number | null, shownAt: number): boolean {
  if (hiddenAt === null || hiddenAt < tappedAt) return false;
  return shownAt - hiddenAt >= ASK_AFTER_MS && shownAt - tappedAt <= ASK_WITHIN_MS;
}

// ---------------------------------------------------------------------------
// Delete (W30, design 4.5)

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What deleting this client does, spelled out before the Confirm: its deals and log go; its follow-ups
 * and projects stay, with no client; a company's people lose their company. Counts are the hub's (its own,
 * not its company's or its people's); a log with more pages is "its whole log".
 */
export function deleteLines(hub: Pick<WorkClientHub, 'contact' | 'deals' | 'log' | 'logNext' | 'followUps' | 'projects' | 'people'>): string[] {
  const id = hub.contact.id;
  const deals = hub.deals.filter((d) => d.client.id === id).length;
  const logged = hub.log.filter((r) => r.kind !== 'followup' && r.contactId === id).length;
  const followUps = hub.followUps.filter((t) => t.contactId === id).length;
  const projects = hub.projects.filter((p) => p.clientId === id).length;
  const people = hub.people?.length ?? 0;
  const go: string[] = [];
  if (deals) go.push(`its ${n(deals, 'deal', 'deals')}`);
  if (hub.logNext) go.push('its whole log');
  else if (logged) go.push(`its ${n(logged, 'log entry', 'log entries')}`);
  const lines = [go.length ? `Deletes ${go.join(' and ')}.` : 'Nothing is logged with it yet.'];
  const stay: string[] = [];
  if (followUps) stay.push(n(followUps, 'follow-up', 'follow-ups'));
  if (projects) stay.push(n(projects, 'project', 'projects'));
  const one = stay.length === 1 && followUps + projects === 1;
  if (stay.length) lines.push(`Its ${stay.join(' and ')} ${one ? 'stays' : 'stay'}, with no client.`);
  if (people) lines.push(`Its ${n(people, 'person loses', 'people lose')} their company.`);
  lines.push('There is no Undo. Mark it as past instead to keep its history.');
  return lines;
}

// ---------------------------------------------------------------------------
// The next step (W13, design 10)

/** The day chips: Tomorrow, In 3 days, Next week (the coming Monday). */
export function nextStepDays(today: string): { key: string; label: string; day: string }[] {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const toMonday = ((8 - dow) % 7) || 7;
  return [
    { key: 'tomorrow', label: 'Tomorrow', day: shiftDayKey(today, 1) },
    { key: '3d', label: 'In 3 days', day: shiftDayKey(today, 3) },
    { key: 'week', label: 'Next week', day: shiftDayKey(today, toMonday) },
  ];
}

/** Tags as he types them, comma-separated: trimmed, each once (any case), 30 characters and 10 at most. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim().slice(0, 30);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 10) break;
  }
  return out;
}

/** A client's place in Work (`/work?tab=clients&id=`), or the list with its filters. */
export function clientPath(id?: string, filter: { q?: string; state?: WorkClientState; tag?: string; list?: string } = {}): string {
  return routePath({ name: 'work', tab: 'clients', ...(id ? { id } : {}), ...filter });
}
