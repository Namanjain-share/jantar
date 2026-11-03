/**
 * v0.11 People: her day plan as {owner} reads it (spec 4.2), one component
 * for his Partner › Today and her "See what {owner} sees" (the same DTO, so
 * the mirror matches what he gets): when it was sent, seen and
 * acknowledged, each step's status, done time, report and check-in, late
 * chips and the check-betweens. `onNudge` (his only) adds Nudge on an
 * open step of today; nothing here writes otherwise.
 */
import type { PlanStep, PlanView } from '@jantar/protocol/people';
import { dayLabel, hmOf } from './time.js';

const STATUS_WORD: Record<string, string> = { doing: 'started', skipped: 'skipped', excused: 'rough day', todo: '' };

export function stepLine(s: PlanStep): string {
  return [
    s.status === 'done' && s.doneAt ? `done ${hmOf(s.doneAt)}` : s.status !== 'done' ? STATUS_WORD[s.status] || null : 'done',
    s.report ? `"${s.report}"` : null,
    s.skip?.reason ? s.skip.reason : null,
    s.checkin ? `mood ${s.checkin.mood}/5 · energy ${s.checkin.energy}/5${s.checkin.line ? ` · "${s.checkin.line}"` : ''}${s.checkin.need ? ` · needs: "${s.checkin.need}"` : ''}` : null,
    s.ackAt ? 'Got it' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function PlanRead({ view, name, owner, onNudge }: { view: PlanView; name: string; owner?: string; onNudge?: (s: PlanStep) => void }) {
  const plan = view.plan;
  if (!plan) return <p className="mt-12 text-ink-2">No plan for {dayLabel(view.day)}.</p>;
  return (
    <section aria-label={`${name}'s plan`} className="mt-12">
      {plan.note ? <p className="text-small text-ink-2">"{plan.note}"</p> : null}
      <p className="text-small text-ink-2">
        {plan.sentAt ? `Sent ${hmOf(plan.sentAt)}` : 'Not sent yet'}
        {plan.seenAt ? ` · Seen ${hmOf(plan.seenAt)}` : ''}
        {plan.ackAt ? ` · Got it ${hmOf(plan.ackAt)}` : ''}
        {plan.rough ? ` · ${name} marked the day a rough day` : ''}
        {view.focus ? ` · In ${view.focus.title} (focus) until about ${hmOf(view.focus.until)}` : ''}
      </p>
      <ul className="mt-8 border-t border-line">
        {plan.steps
          .filter((s) => !s.carriedTo)
          .map((s) => {
            const open = s.status === 'todo' || s.status === 'doing';
            return (
              <li key={s.id} className="flex items-start gap-8 border-b border-line py-8">
                <span aria-hidden="true" className="w-16 text-ink-2">
                  {s.status === 'done' ? '✓' : s.status === 'skipped' || s.status === 'excused' ? '–' : s.status === 'doing' ? '◐' : '○'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words">
                    {s.at ? `${s.at} ` : ''}
                    {s.title}
                    {s.by !== '' ? ` · ${name}'s` : owner ? ` · ${owner}'s` : ''}
                  </p>
                  <p className="break-words text-small text-ink-2">{stepLine(s)}</p>
                </div>
                {view.late.includes(s.id) ? <span className="rounded-chip border border-line-strong px-8 text-small text-ink-2">late</span> : null}
                {open && onNudge ? (
                  <button type="button" className="min-h-44 shrink-0 px-8 text-small text-ink-2 underline" onClick={() => onNudge(s)}>
                    Nudge
                  </button>
                ) : null}
              </li>
            );
          })}
      </ul>
      {plan.between.map((b) => (
        <p key={b.id} className="mt-8 text-small text-ink-2">
          {b.title}: {(view.slots[b.id] ?? []).map((x) => `${x.slot} ${x.state === 'done' ? '✓' : x.state === 'later' ? '·' : '○'}`).join('  ')}
        </p>
      ))}
    </section>
  );
}
