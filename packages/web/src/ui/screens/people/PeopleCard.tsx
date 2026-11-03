/**
 * v0.12 People (P2): the card on his Today (spec 4.1): "Asha · 3 of 7 done
 * · Now: Interview prep 11:00 · Low" (or "Asleep since 23:40" with
 * see.sleep). Every field obeys the agreement (it is her Today DTO, which
 * writes the same view mark as her Today tab); a tap opens her Today tab.
 * Nothing shows while People is off or nobody is sharing.
 */
import { STATUS_LABELS } from '@jantar/protocol/people-core';
import type { PersonToday } from '@jantar/protocol/people';
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
  if (t.state === 'paused') parts.push('paused');
  return parts.join(' · ');
}

export function PeopleCard({ client = peopleClient() }: { client?: PeopleClient }) {
  const navigate = useNavigate();
  const load = useLifeLoad('people:today-card', async () => {
    const list = await client.list().catch(() => null);
    if (!list?.enabled) return [];
    const sharing = list.people.filter((p) => p.state === 'active' || p.state === 'paused');
    return Promise.all(sharing.map(async (p) => ({ id: p.id, today: await client.today(p.id).catch(() => null) })));
  });
  const rows = (load.data ?? []).filter((r): r is { id: string; today: PersonToday } => r.today !== null);
  if (rows.length === 0) return null;
  return (
    <ul aria-label="People" className="border-b border-line">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" className="flex min-h-48 w-full items-center px-16 text-left type-row text-ink hover:bg-hover" onClick={() => navigate(`/people/${r.id}?tab=today`)}>
            {peopleLine(r.today)}
          </button>
        </li>
      ))}
    </ul>
  );
}
