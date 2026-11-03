/**
 * v0.12 People (P2): his Partner screen (`/people/:pid?tab=…&day=`, spec
 * 4.1, 4.2), a lazy chunk: his main load doesn't carry it.
 *
 * - Header: her name, her status and line, "Asleep since" (see.sleep), and
 *   the day's progress with the Now step. Action row: Plan and Alert, one
 *   tap each.
 * - Tabs: Today (her plan as she sees it, each step's status, done time,
 *   report and check-in, late chips, Nudge; check-betweens; the concern
 *   lines; her evening review at his level, with Carry for his open
 *   steps), Plan (the editor), Health (the sleep week), Journal (read, and
 *   comment with comment.journal) and Alerts (both ways).
 * - An area she keeps private is a grey tile, "{name} keeps this private":
 *   never just absent, never a warning colour, never a count of days.
 * - Every read goes through his People routes, so each writes her view
 *   mark; he has no control here that writes in her name.
 */
import { ALERT_KINDS, ALERT_REPLY_LABELS, STATUS_LABELS, type AlertKind } from '@jantar/protocol/people-core';
import type { AlertsResponse, JournalEntryFull, JournalList, PersonAlert, PersonToday, PersonView, PlanStep, PlanView, ReviewView, SleepWeek as Week } from '@jantar/protocol/people';
import { useEffect, useState } from 'react';
import { JournalEntryCard } from '../../../people-shared/JournalEntryCard.js';
import { ReviewList } from '../../../people-shared/ReviewList.js';
import { SleepWeek } from '../../../people-shared/SleepWeek.js';
import { dayLabel, hmOf } from '../../../people-shared/time.js';
import { useNavigate } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { peopleClient, type PeopleClient } from './client.js';
import { PlanEditor, defaultPlanDay } from './PlanEditor.js';

export const PARTNER_TABS = ['today', 'plan', 'health', 'journal', 'alerts'] as const;
export type PartnerTab = (typeof PARTNER_TABS)[number];
const TAB_LABEL: Record<PartnerTab, string> = { today: 'Today', plan: 'Plan', health: 'Health', journal: 'Journal', alerts: 'Alerts' };

export interface PartnerProps {
  pid?: string;
  tab?: string;
  day?: string;
  id?: string;
  client?: PeopleClient;
}

function Locked({ name, what }: { name: string; what: string }) {
  return (
    <p className="mt-12 rounded-btn bg-hover px-12 py-12 type-row text-ink-2">
      {what}: {name} keeps this private
    </p>
  );
}

const isLocked = (v: unknown): v is { locked: true } => typeof v === 'object' && v !== null && 'locked' in v;

export function Partner({ pid, tab: tabIn, day: dayIn, id, client = peopleClient() }: PartnerProps) {
  const navigate = useNavigate();
  const list = useLifeLoad('people', () => client.list());
  const sharing = (list.data?.people ?? []).filter((p) => p.state === 'active' || p.state === 'paused');
  useEffect(() => {
    if (!pid && sharing.length === 1 && sharing[0]) navigate(`/people/${sharing[0].id}`, { replace: true });
  }, [pid, sharing, navigate]);
  if (!pid) {
    return (
      <div className="px-16 pb-48 pt-16 md:px-32">
        <h1 data-display className="type-display text-ink">
          People
        </h1>
        {list.data && !list.data.enabled ? <p className="mt-12 type-small text-ink-2">People is off. Turn it on at the Mac: jantar people on.</p> : null}
        <ul className="mt-12 border-t border-line">
          {sharing.map((p) => (
            <li key={p.id} className="border-b border-line">
              <button type="button" className="flex h-48 w-full items-center type-row" onClick={() => navigate(`/people/${p.id}`)}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const person = list.data?.people.find((p) => p.id === pid) ?? null;
  return <PartnerOf client={client} pid={pid} person={person} tab={(PARTNER_TABS as readonly string[]).includes(tabIn ?? '') ? (tabIn as PartnerTab) : 'today'} dayIn={dayIn} id={id} />;
}

function PartnerOf({ client, pid, person, tab, dayIn, id }: { client: PeopleClient; pid: string; person: PersonView | null; tab: PartnerTab; dayIn?: string; id?: string }) {
  const navigate = useNavigate();
  const today = useLifeLoad(`people:${pid}:today:${dayIn ?? ''}`, () => client.today(pid, dayIn));
  const [alerting, setAlerting] = useState(false);
  const t = today.data;
  const name = t?.name ?? person?.name ?? 'Partner';
  const go = (next: PartnerTab, extra = '') => navigate(`/people/${pid}?tab=${next}${extra}`);
  const plan = t && !isLocked(t.plan) ? t.plan : null;
  const nowStep = plan?.plan?.steps.find((s) => s.id === plan.now);
  const nowHm = new Date();
  const planDay = dayIn ?? (t ? defaultPlanDay(t.day, `${String(nowHm.getHours()).padStart(2, '0')}:${String(nowHm.getMinutes()).padStart(2, '0')}`) : undefined);
  const status = t && !isLocked(t.status) ? t.status : null;
  const asleep = t && !isLocked(t.sleep) ? t.sleep.open : null;
  const a = person?.agreement;
  return (
    <div className="px-16 pb-48 pt-16 md:px-32">
      <header>
        <h1 data-display className="type-display text-ink">
          {name}
        </h1>
        <p className="type-small text-ink-2">
          {[
            t?.state === 'paused' ? 'Paused' : null,
            status ? `${STATUS_LABELS[status.level]}${status.line ? ` "${status.line}"` : ''}` : null,
            asleep ? `Asleep since ${hmOf(asleep.since)}` : null,
            plan?.plan ? `${plan.counts.done} of ${plan.counts.total}` : null,
            nowStep ? `Now: ${nowStep.title}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div className="mt-8 flex gap-8">
          <Button variant="outline" disabled={!a?.assign.plan} onClick={() => go('plan', planDay ? `&day=${planDay}` : '')}>
            Plan
          </Button>
          <Button variant="outline" onClick={() => setAlerting(true)}>
            Alert
          </Button>
        </div>
      </header>
      <div role="tablist" className="mt-12 flex gap-4 overflow-x-auto border-b border-line">
        {PARTNER_TABS.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => go(x)} className={`min-h-44 shrink-0 px-12 type-row ${tab === x ? 'border-b-2 border-ink text-ink' : 'text-ink-2'}`}>
            {TAB_LABEL[x]}
          </button>
        ))}
      </div>
      {tab === 'today' ? <TodayTab client={client} pid={pid} name={name} today={t} reload={today.reload} canCarry={a?.assign.plan === true} /> : null}
      {tab === 'plan' && planDay ? (
        a?.see.plan && a.assign.plan ? <PlanEditor client={client} pid={pid} name={name} day={planDay} editHers={a.editHers.plan} onDay={(d) => go('plan', `&day=${d}`)} /> : <Locked name={name} what="Day plan" />
      ) : null}
      {tab === 'health' ? <HealthTab client={client} pid={pid} name={name} sees={a?.see.sleep === true} /> : null}
      {tab === 'journal' ? <JournalTab client={client} pid={pid} name={name} sees={a?.see.journal === true} canComment={a?.comment.journal === true} id={id} /> : null}
      {tab === 'alerts' ? <AlertsTab client={client} pid={pid} name={name} id={id} /> : null}
      <AlertSheet open={alerting} client={client} pid={pid} name={name} close={() => setAlerting(false)} />
    </div>
  );
}

function TodayTab({ client, pid, name, today, reload, canCarry }: { client: PeopleClient; pid: string; name: string; today: PersonToday | null; reload: () => void; canCarry: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  if (!today) return <p className="mt-12 type-small text-ink-2">Loading…</p>;
  const nudge = (s: PlanStep, day: string) =>
    void client.sendAlert({ to: pid, kind: 'nudge', ref: { type: 'step', id: s.id, day } }).then(
      (r) => setNote(r.delivery === 'sent' ? `Reminder sent: ${s.title}` : r.delivery === 'capped' ? `Saved: ${name}'s limit for reminders is reached.` : 'Held until the quiet time ends.'),
      (e: Error) => setNote(e.message),
    );
  return (
    <div className="mt-12">
      {note ? (
        <p role="status" className="type-small text-ink">
          {note}
        </p>
      ) : null}
      {today.concerns.length > 0 ? (
        <ul className="mt-8 type-small text-ink-2">
          {today.concerns.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
      {isLocked(today.plan) ? <Locked name={name} what="Day plan" /> : <PlanReadView view={today.plan} name={name} onNudge={(s) => nudge(s, today.day)} />}
      {today.review === null ? null : isLocked(today.review) ? (
        <Locked name={name} what="Evening review" />
      ) : (
        <ReviewRead client={client} pid={pid} name={name} v={today.review} canCarry={canCarry} done={reload} />
      )}
      {isLocked(today.todos) ? <Locked name={name} what="To-dos" /> : <p className="mt-12 type-row text-ink">To-do today: {today.todos.due.length}{today.todos.overdue ? ` · overdue ${today.todos.overdue}` : ''}</p>}
      {isLocked(today.weight) ? <Locked name={name} what="Weight" /> : today.weight.latest ? <p className="type-row text-ink">Weight {today.weight.latest.kg} kg ({today.weight.latest.day})</p> : null}
    </div>
  );
}

function PlanReadView({ view, name, onNudge }: { view: PlanView; name: string; onNudge: (s: PlanStep) => void }) {
  const plan = view.plan;
  if (!plan) return <p className="mt-12 type-row text-ink-2">No plan for {dayLabel(view.day)}.</p>;
  return (
    <section aria-label="Her plan" className="mt-12">
      {plan.note ? <p className="type-small text-ink-2">"{plan.note}"</p> : null}
      <p className="type-small text-ink-2">
        {plan.sentAt ? `Sent ${hmOf(plan.sentAt)}` : 'Not sent yet'}
        {plan.seenAt ? ` · Seen ${hmOf(plan.seenAt)}` : ''}
        {plan.ackAt ? ` · Got it ${hmOf(plan.ackAt)}` : ''}
        {plan.rough ? ` · ${name} marked today a rough day` : ''}
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
                  <p className="break-words type-row text-ink">
                    {s.at ? `${s.at} ` : ''}
                    {s.title}
                    {s.by !== '' ? ` · ${name}'s` : ''}
                  </p>
                  <p className="break-words type-small text-ink-2">
                    {[
                      s.status === 'done' && s.doneAt ? `done ${hmOf(s.doneAt)}` : s.status !== 'todo' ? s.status : null,
                      s.report ? `"${s.report}"` : null,
                      s.skip?.reason ? s.skip.reason : null,
                      s.checkin ? `mood ${s.checkin.mood}/5 · energy ${s.checkin.energy}/5${s.checkin.line ? ` · "${s.checkin.line}"` : ''}${s.checkin.need ? ` · needs: "${s.checkin.need}"` : ''}` : null,
                      s.ackAt ? 'Got it' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                {view.late.includes(s.id) ? <span className="rounded-chip border border-line-strong px-8 type-small text-ink-2">late</span> : null}
                {open ? (
                  <Button variant="text" size="sm" onClick={() => onNudge(s)}>
                    Nudge
                  </Button>
                ) : null}
              </li>
            );
          })}
      </ul>
      {plan.between.map((b) => (
        <p key={b.id} className="mt-8 type-small text-ink-2">
          {b.title}: {(view.slots[b.id] ?? []).map((x) => `${x.slot} ${x.state === 'done' ? '✓' : x.state === 'later' ? '·' : '○'}`).join('  ')}
        </p>
      ))}
    </section>
  );
}

function ReviewRead({ client, pid, name, v, canCarry, done }: { client: PeopleClient; pid: string; name: string; v: ReviewView; canCarry: boolean; done: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (v.level === 'counts') {
    return (
      <p className="mt-12 type-row text-ink">
        Evening review: {v.line}
        {v.sent && v.at ? ` · sent ${hmOf(v.at)}` : ''}
      </p>
    );
  }
  const open = v.items.filter((i) => i.kind === 'step' && i.by === '' && (i.outcome === undefined || i.outcome === 'missed'));
  return (
    <section aria-label="Evening review" className="mt-16">
      <h2 className="type-title text-ink">Evening review · {dayLabel(v.day)}</h2>
      <p className="type-small text-ink-2">
        {v.line}
        {v.sent ? (v.auto ? ' · closed at noon' : v.at ? ` · sent ${hmOf(v.at)}` : '') : ' · not sent yet'}
      </p>
      <ReviewList items={v.items} owner="you" />
      {v.note ? <p className="mt-8 whitespace-pre-wrap break-words type-row text-ink">{v.note}</p> : null}
      {v.mood ? <p className="type-small text-ink-2">Mood {v.mood}/5</p> : null}
      {canCarry && v.sent && open.length > 0 ? (
        <Button variant="outline" onClick={() => void client.carry(pid, v.day, open.map((i) => i.ref)).then(done, (e: Error) => setError(e.message))}>
          Carry your open steps to tomorrow
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <p className="type-small text-ink-3">Nothing here is a score. {name} decides what to share.</p>
    </section>
  );
}

function HealthTab({ client, pid, name, sees }: { client: PeopleClient; pid: string; name: string; sees: boolean }) {
  const [week, setWeek] = useState<string | undefined>(undefined);
  const load = useLifeLoad<Week>(sees ? `people:${pid}:sleep:${week ?? ''}` : null, () => client.sleep(pid, week));
  if (!sees) return <Locked name={name} what="Sleep" />;
  return <div className="mt-12">{load.data ? <SleepWeek week={load.data} onWeek={setWeek} /> : <p className="type-small text-ink-2">Loading…</p>}</div>;
}

function JournalTab({ client, pid, name, sees, canComment, id }: { client: PeopleClient; pid: string; name: string; sees: boolean; canComment: boolean; id?: string }) {
  const navigate = useNavigate();
  const list = useLifeLoad<JournalList>(sees && !id ? `people:${pid}:journal` : null, () => client.journal(pid));
  const entry = useLifeLoad<JournalEntryFull>(sees && id ? `people:${pid}:journal:${id}` : null, () => client.journalGet(pid, id as string));
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!sees) return <Locked name={name} what="Journal" />;
  if (id) {
    const e = entry.data;
    if (!e) return <p className="mt-12 type-small text-ink-2">Loading…</p>;
    return (
      <div className="mt-12">
        <Button variant="text" onClick={() => navigate(`/people/${pid}?tab=journal`)}>
          ‹ Journal
        </Button>
        <h2 className="type-title text-ink">{dayLabel(e.entry.day)}</h2>
        <JournalEntryCard e={{ ...e.entry, comments: 0 }} />
        <ul className="border-t border-line">
          {e.comments.map((c) => (
            <li key={c.id} className="flex items-start gap-8 border-b border-line py-8">
              <div className="min-w-0 flex-1">
                <p className="type-small text-ink-2">
                  {c.by === '' ? 'You' : name} · {hmOf(c.at)}
                </p>
                <p className="whitespace-pre-wrap break-words type-row text-ink">{c.text}</p>
              </div>
              {c.by === '' && canComment ? (
                <Button variant="text" size="sm" onClick={() => void client.deleteComment(pid, e.entry.id, c.id).then(entry.reload)}>
                  Delete
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canComment ? (
          <form
            className="mt-8 flex gap-8"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!text.trim()) return;
              void client.comment(pid, e.entry.id, text.trim()).then(
                () => (setText(''), entry.reload()),
                (x: Error) => setError(x.message),
              );
            }}
          >
            <input aria-label="Comment" className="h-40 min-w-0 flex-1 rounded-btn border border-line bg-bg px-8" maxLength={500} value={text} onChange={(ev) => setText(ev.target.value)} />
            <Button type="submit" variant="outline">
              Comment
            </Button>
          </form>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  }
  const l = list.data;
  return (
    <div className="mt-12">
      {l?.streak && l.streak.current > 0 ? <p className="type-small text-ink-2">{l.streak.current} days in a row</p> : null}
      <ul className="border-t border-line">
        {(l?.entries ?? []).map((e) => (
          <li key={e.id} className="border-b border-line">
            <p className="pt-8 type-small text-ink-3">{dayLabel(e.day)}</p>
            <JournalEntryCard e={e} onOpen={() => navigate(`/people/${pid}?tab=journal&id=${e.id}`)} />
          </li>
        ))}
      </ul>
      {l && l.entries.length === 0 ? <p className="mt-8 type-small text-ink-2">Nothing written yet.</p> : null}
    </div>
  );
}

function alertLine(a: PersonAlert): string {
  if (a.kind === 'nudge') return `Reminder${a.ref ? `: ${a.ref.title}` : ''}`;
  if (a.kind === 'change_request') return a.carry ? `Asks to carry ${a.carry.steps.length} step${a.carry.steps.length === 1 ? '' : 's'}` : `Asks to change${a.ref ? `: ${a.ref.title}` : ''}`;
  return ALERT_KINDS[a.kind].label;
}

const HELD: Record<string, string> = {
  sent: 'Sent',
  released: 'Sent',
  capped: 'Saved (over the limit)',
  held_quiet: 'Held (quiet time)',
  held_mute: 'Held (muted)',
  held_space: 'Held (space)',
  held_focus: 'Held (focus)',
  held_sleep: 'Held (asleep)',
  held_pause: 'Held (paused)',
};

function AlertsTab({ client, pid, name, id }: { client: PeopleClient; pid: string; name: string; id?: string }) {
  const load = useLifeLoad<AlertsResponse>(`people:${pid}:alerts`, () => client.alerts(pid));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (id && load.data?.alerts.some((a) => a.id === id && a.to === '' && !a.seenAt)) void client.seen(id).then(load.reload);
  }, [id, load.data, client, load.reload]);
  const now = Date.now();
  return (
    <div className="mt-12">
      {error ? <p role="alert">{error}</p> : null}
      <ul className="border-t border-line">
        {(load.data?.alerts ?? []).map((a) => {
          const mine = a.from === '';
          const open = !mine && !a.reply && Date.parse(a.expiresAt) > now;
          return (
            <li key={a.id} className={`border-b border-line py-8 ${a.id === id ? 'bg-hover' : ''}`}>
              <button type="button" className="block w-full text-left" onClick={() => !mine && !a.seenAt && void client.seen(a.id).then(load.reload)}>
                <p className="type-small text-ink-2">
                  {mine ? `You → ${name}` : `${name} → you`} · {dayLabel(a.at.slice(0, 10))} {hmOf(a.at)}
                </p>
                <p className="break-words type-row text-ink">{alertLine(a)}</p>
                {a.text ? <p className="whitespace-pre-wrap break-words type-row text-ink">{a.text}</p> : null}
                <p className="type-small text-ink-2">
                  {a.reply ? `Replied: ${ALERT_REPLY_LABELS[a.reply.kind]}${a.reply.note ? `. ${a.reply.note}` : ''}` : a.seenAt ? `Seen ${hmOf(a.seenAt)}` : mine ? (HELD[a.delivery] ?? '') : open ? '' : 'Expired'}
                </p>
              </button>
              {open ? (
                <div className="mt-4 flex flex-wrap gap-8">
                  {ALERT_KINDS[a.kind].replies.map((k) => (
                    <Button key={k} variant="outline" size="sm" onClick={() => void client.reply(a.id, { kind: k }).then(load.reload, (e: Error) => setError(e.message))}>
                      {ALERT_REPLY_LABELS[k]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {load.data && load.data.alerts.length === 0 ? <p className="mt-8 type-small text-ink-2">No alerts yet.</p> : null}
    </div>
  );
}

const HIS: AlertKind[] = ['check_in', 'call_me', 'good_morning', 'good_night', 'thinking_of_you'];

function AlertSheet({ open, client, pid, name, close }: { open: boolean; client: PeopleClient; pid: string; name: string; close: () => void }) {
  const sheet = useLifeLoad<AlertsResponse>(open ? `people:${pid}:alerts` : null, () => client.alerts(pid));
  const [kind, setKind] = useState<AlertKind | null>(null);
  const [text, setText] = useState('');
  const [gentle, setGentle] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const s = sheet.data?.sheet;
  const send = () =>
    kind &&
    void client.sendAlert({ to: pid, kind, ...(text.trim() ? { text: text.trim() } : {}), ...(kind === 'custom' ? { urgency: gentle ? 'gentle' : 'normal' } : {}) }).then(
      (r) => {
        setResult(HELD[r.delivery] ?? r.delivery);
        setKind(null);
        setText('');
        sheet.reload();
      },
      (e: Error) => setResult(e.message),
    );
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? null : (close(), setResult(null)))} title={`Alert ${name}`}>
      <div className="flex flex-col gap-12 pb-24">
        <div className="grid grid-cols-2 gap-8">
          {[...HIS, 'urgent' as const, 'custom' as const].map((k) => (
            <Button key={k} variant={kind === k ? 'primary' : 'outline'} size="lg" onClick={() => setKind(k)}>
              {k === 'custom' ? 'Custom…' : k === 'urgent' ? 'Urgent' : ALERT_KINDS[k].label}
            </Button>
          ))}
        </div>
        {kind ? (
          <label className="flex flex-col gap-4">
            <span className="type-small text-ink-2">{kind === 'custom' ? 'Message' : 'A note (optional)'}</span>
            <input className="h-40 rounded-btn border border-line bg-bg px-8" maxLength={140} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        ) : null}
        {kind === 'custom' ? (
          <label className="flex items-center gap-8 type-small">
            <input type="checkbox" checked={gentle} onChange={(e) => setGentle(e.target.checked)} /> Gentle (no sound)
          </label>
        ) : null}
        {s?.hold ? <p className="type-small text-ink-2">{s.hold}</p> : null}
        {s ? (
          <p className="type-small text-ink-3">
            {name} allows {s.caps.hour} an hour, {s.caps.day} a day and {s.caps.urgentDay} urgent a day.
          </p>
        ) : null}
        {result ? <p role="status">{result}</p> : null}
        <Button variant="primary" size="xl" disabled={!kind || (kind === 'custom' && !text.trim())} onClick={send}>
          Send
        </Button>
      </div>
    </Sheet>
  );
}
