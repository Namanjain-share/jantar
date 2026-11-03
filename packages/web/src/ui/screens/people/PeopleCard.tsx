/**
 * v0.11 People (P2): the card on his Today (spec 4.1): "Asha · 3 of 7 done
 * · Now: Interview prep 11:00 · Low" (or "Asleep since 23:40" with
 * see.sleep), and with see.meds "1 dose not logged" (a count, never a name)
 * and the two-day concern. Every field follows the agreement (it is her Today DTO, which
 * writes the same view mark as her Today tab); a tap opens her Today tab.
 * Nothing shows while People is off or nobody is sharing.
 */
import { PEOPLE_LABEL, STATUS_LABELS, spaceLabel } from '@jantar/protocol/people-core';
import type { OwnerMedsView, PersonToday } from '@jantar/protocol/people';
import { hmOf } from '../../../people-shared/time.js';
import { useNavigate } from '../../context.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { peopleClient, type PeopleClient } from './client.js';

export function peopleLine(t: PersonToday): string {
  const parts: string[] = [t.name];
  const plan = 'locked' in t.plan ? null : t.plan;
  if (plan?.plan) parts.push(`${plan.counts.done} of ${plan.counts.total} done`);
  const now = plan?.plan?.steps.find((s) => s.id === plan.now);
  if (now) parts.push(`Now: ${now.title}${now.at ? ` ${now.at}` : ''}`);
  const sleep = 'locked' in t.sleep ? null : t.sleep.open;
  if (sleep) parts.push(`Asleep since ${hmOf(sleep.since)}`);
  else if (t.status && !('locked' in t.status)) parts.push(STATUS_LABELS[t.status.level]);
  const missed = t.meds && !('locked' in t.meds) ? dosesNotLogged(t.meds) : 0;
  if (missed > 0) parts.push(`${missed} dose${missed === 1 ? '' : 's'} not logged`);
  if (t.meds && !('locked' in t.meds) && t.meds.concern) parts.push(t.meds.concern.replace(/\.\s*Worth checking in\.$/, ''));
  if (t.state === 'paused') parts.push('paused');
  return parts.join(' · ');
}

/** Today's doses due and not logged, at either level (a count only). */
export function dosesNotLogged(m: OwnerMedsView): number {
  if (m.level === 'adherence') return m.notLoggedToday;
  if (m.day.day !== m.day.today) return 0;
  return m.day.groups.flatMap((g) => g.items).filter((i) => i.status === 'missed' || i.overdue).length;
}

/** Someone sharing with him: the space's name (his label) and their Today. */
export interface PeopleRow {
  id: string;
  label: string;
  today: PersonToday;
}

/** Everyone sharing with him, with their Today: none while People is off, nobody shares, or it can't load. */
export function usePeopleRows(client: PeopleClient = peopleClient()): PeopleRow[] {
  const load = useLifeLoad('people:today-card', async () => {
    const list = await client.list().catch(() => null);
    if (!list?.enabled) return [];
    const sharing = list.people.filter((p) => p.state === 'active' || p.state === 'paused');
    return Promise.all(sharing.map(async (p) => ({ id: p.id, label: spaceLabel(p.label), today: await client.today(p.id).catch(() => null) })));
  });
  return (load.data ?? []).filter((r): r is PeopleRow => r.today !== null);
}

/**
 * Their rows: a button each, the space's name over the line, a hairline under each; a tap opens their
 * Today tab. On a phone (or a narrow pane) under Today's title; on a wide one (0.12) the rows of Today's
 * Accountability partner card.
 */
export function PeopleRows({ rows }: { rows: readonly PeopleRow[] }) {
  const navigate = useNavigate();
  return (
    <ul aria-label={PEOPLE_LABEL}>
      {rows.map((r) => (
        <li key={r.id} className="border-b border-line">
          <button type="button" className="flex min-h-48 w-full flex-col items-start justify-center px-16 py-4 text-left type-row text-ink hover:bg-hover" onClick={() => navigate(`/people/${r.id}?tab=today`)}>
            {/* The space's name with them (his label), over the line. */}
            <span className="break-words type-small text-ink-2">{r.label}</span>{' '}
            <span className="break-words">{peopleLine(r.today)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PeopleCard({ client = peopleClient() }: { client?: PeopleClient }) {
  const rows = usePeopleRows(client);
  if (rows.length === 0) return null;
  return <PeopleRows rows={rows} />;
}
