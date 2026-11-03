/**
 * v0.12 People: her medicines as the owner sees them (spec 3.4, 4.2), one
 * component for his Partner › Health and her "See what {owner} sees" (the
 * same DTO, so the mirror matches). `full`: the day's doses (taken,
 * skipped or not, never when) and each medicine with who added it, "Edited
 * by", and her notes where he may change it (so the mirror shows her
 * exactly the notes he reads); `adherence`: a percentage and a count,
 * naming nothing. The two-day concern is a plain line, never a warning
 * colour. Text renders as plain text (React escapes it).
 */
import type { MedsDayItem } from '@jantar/protocol';
import type { OwnerDoseItem, OwnerMedicine, OwnerMedsView } from '@jantar/protocol/people';
import { dayLabel, hmOf } from './time.js';

/** "Taken 08:12" (her own list; his view has no log time), "Skipped", "Not logged", "Due"; "Added after this time" for one gone by before it was added (it can still be logged). */
export function doseWords(i: OwnerDoseItem & Partial<Pick<MedsDayItem, 'at' | 'late' | 'beforeAdded'>>): string {
  if (i.status === 'taken') return i.at ? `Taken ${hmOf(i.at)}${i.late ? ' (late)' : ''}` : 'Taken';
  if (i.status === 'skipped') return 'Skipped';
  if (i.status === 'missed') return 'Not logged';
  if (i.beforeAdded) return 'Added after this time';
  return i.overdue ? 'Not logged yet' : 'Due';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every day", "Mon, Thu", "Every 2 days". */
export function scheduleWords(m: Pick<OwnerMedicine, 'schedule'>): string {
  const s = m.schedule;
  if (s.freq === 'weekly' && s.byWeekday?.length) return s.byWeekday.map((d) => WEEKDAYS[d] ?? '').join(', ');
  if (s.interval && s.interval > 1) return `Every ${s.interval} days`;
  return 'Every day';
}

/**
 * Who added a medicine and who changed it, for the side reading it:
 * `owner` is the owner's word on that side ("you" on his, "Sam" on hers),
 * `name` hers ("Asha" on his, "you" on hers).
 */
export function medByLine(m: Pick<OwnerMedicine, 'by' | 'editedBy'>, owner: string, name: string): string {
  return [m.by === '' ? `added by ${owner}` : `${name === 'you' ? 'yours' : `${name}'s own`}`, m.editedBy === '' && m.by !== '' ? `edited by ${owner}` : null].filter(Boolean).join(' · ');
}

export function MedsRead({
  view,
  owner,
  name,
  actions,
}: {
  view: OwnerMedsView;
  owner: string;
  name: string;
  /** His Edit and Stop, where the agreement allows (none on her mirror). */
  actions?: (m: OwnerMedicine) => React.ReactNode;
}) {
  if (view.level === 'adherence') {
    return (
      <section aria-label="Medicines" className="mt-12">
        <p>{view.pct === null ? 'Medicines: nothing due yet in the last 30 days.' : `Medicines: ${view.pct}% of doses logged in the last 30 days.`}</p>
        <p className="text-small text-ink-2">
          {view.notLoggedToday === 0 ? 'Every dose due today is logged.' : `${view.notLoggedToday} dose${view.notLoggedToday === 1 ? '' : 's'} not logged today.`} Medicine names and doses aren't shared.
        </p>
        {view.concern ? <p className="mt-4">{view.concern}</p> : null}
      </section>
    );
  }
  const items = view.day.groups.flatMap((g) => g.items);
  const taking = view.medicines.filter((m) => !m.stoppedOn);
  const stopped = view.medicines.filter((m) => m.stoppedOn);
  return (
    <section aria-label="Medicines" className="mt-12">
      {view.concern ? <p>{view.concern}</p> : null}
      <h3 className="mt-8 font-semibold">{view.day.day === view.day.today ? 'Doses today' : `Doses ${dayLabel(view.day.day)}`}</h3>
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={`${i.medId}@${i.slot}`} className="flex flex-wrap justify-between gap-x-8 py-4">
              <span className="min-w-0 break-words">
                <span className="mr-8 tabular-nums">{i.slot}</span>
                {i.name}
                {i.dose ? <span className="text-ink-2"> · {i.dose}</span> : null}
              </span>
              <span className="text-small text-ink-2">{doseWords(i)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-ink-2">No doses due.</p>
      )}
      <h3 className="mt-12 font-semibold">Medicines</h3>
      {taking.length ? (
        <ul className="divide-y divide-line">
          {taking.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start justify-between gap-8 py-8">
              <div className="min-w-0 flex-1 basis-[12rem]">
                <p className="break-words">
                  {m.name}
                  {m.dose ? <span className="text-ink-2"> · {m.dose}</span> : null}
                </p>
                <p className="text-small text-ink-2">
                  {[m.times.join(', '), scheduleWords(m), m.adherencePct === null ? null : `${m.adherencePct}% in 30 days`, medByLine(m, owner, name)].filter(Boolean).join(' · ')}
                </p>
                {m.notes ? <p className="whitespace-pre-wrap break-words text-small text-ink-2">Notes: {m.notes}</p> : null}
              </div>
              {actions ? <div className="flex flex-wrap gap-4">{actions(m)}</div> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-ink-2">No medicines.</p>
      )}
      {stopped.length ? (
        <p className="mt-8 text-small text-ink-2">
          Stopped: {stopped.map((m) => `${m.name} (${dayLabel(m.stoppedOn as string)})`).join(', ')}
        </p>
      ) : null}
    </section>
  );
}
