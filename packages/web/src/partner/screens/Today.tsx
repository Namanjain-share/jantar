/**
 * v0.12 People: her Today (spec 3.1, 3.7, 3.9, 3.10, 3.12).
 *
 * - Top cards: a sharing request, the 14-day sharing check-in, the evening
 *   review card from her review time, and "Asleep since … · Woke up" while
 *   a night is open (or "When did you wake up?" after one closed unlogged).
 * - Her plan as Now, Next, Later and Done, a tick circle on every row (out
 *   of order is one tap), late as a display-only chip, check-betweens with
 *   their slots, then her doses due today (Taken or Skip, with Undo), then
 *   reminders and to-dos due.
 * - One thumb: a sticky bar above the tab bar says Got it while a new or
 *   changed plan is unacknowledged, then Done: {Now step}; `…` opens Start,
 *   Skip and Ask to change. Every tick shows a 5-second Undo.
 * - The report sheet asks for a note with two equal buttons; a check-in
 *   is five large targets per row. Reasons are one-tap chips.
 * - "Going to sleep" from 20:00 to 04:00 (5-second Undo); Rough day with
 *   its Undo; a quiet line into her journal. No nudge, no count of misses.
 */
import { ASK_REASONS, SKIP_REASONS, STATUS_LABELS, fieldsChanged } from '@jantar/protocol/people-core';
import type { PersonMe, PersonOwnToday, PlanStep, PlanView } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { Faces } from '../../people-shared/Faces.js';
import { dayLabel, hmOf } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import { joinCopy } from '../join/copy.js';
import { askForNotifications, needsHomeScreen, turnOnNotifications } from '../notify.js';
import { Card, Field, ReasonChips, ReportSheet, Sheet, Tick, UndoToast, useUndo } from '../ui.js';
import { DoseRow } from './DoseRow.js';
import { TodoRow } from './TodoRow.js';

type OpenSheet = { kind: 'step'; step: PlanStep } | { kind: 'report'; step: PlanStep } | { kind: 'checkin'; step: PlanStep } | { kind: 'status' } | { kind: 'wake' } | { kind: 'rough' } | null;

export function Today({ me, api, reload, tick }: { me: PersonMe; api: PersonApi; reload: () => void; tick: number }) {
  const [today, setToday] = useState<PersonOwnToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const undo = useUndo();
  const load = useCallback(() => api.today().then(setToday, () => setToday(null)), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const owner = me.owner.name;
  const run = (p: Promise<unknown>) =>
    p.then(
      () => {
        setError(null);
        void load();
      },
      (e: Error) => setError(e.message),
    );
  if (!today) {
    return (
      <div>
        <h1 className="text-title font-semibold">Today</h1>
        {me.pending && me.agreement ? <ProposalCard me={me} api={api} reload={reload} /> : null}
      </div>
    );
  }
  const day = today.day;
  const view = today.plan;
  const plan = view.plan;
  const steps = (plan?.steps ?? []).filter((s) => !s.carriedTo);
  const nowStep = steps.find((s) => s.id === view.now) ?? null;
  const setState = (s: PlanStep, to: 'todo' | 'doing' | 'done' | 'skipped', extra: { report?: string; reason?: string } = {}) => {
    const was = s.status;
    void run(api.stepState(day, s.id, { to, ...extra }));
    if (to === 'done' || to === 'skipped') undo.show(`${to === 'done' ? 'Done' : 'Skipped'}: ${s.title}`, () => void run(api.stepState(day, s.id, { to: was === 'doing' ? 'doing' : 'todo' })));
  };
  /** A tap on the circle: done (a report or check-in step opens its sheet), or back to open. */
  const tickStep = (s: PlanStep) => {
    if (s.status === 'done' || s.status === 'skipped') return setState(s, 'todo');
    if (s.ask === 'report') return setSheet({ kind: 'report', step: s });
    if (s.ask === 'checkin' && !s.checkin) return setSheet({ kind: 'checkin', step: s });
    setState(s, 'done');
  };
  const unacked = plan?.sentAt !== undefined && plan.ackAt === undefined && steps.some((s) => s.by === '');
  const sections = groupSteps(view, steps);
  return (
    <div className="pb-96">
      <header className="flex items-center justify-between gap-8">
        <h1 className="text-title font-semibold">{dayLabel(day)}</h1>
        <div className="flex items-center gap-4">
          <button type="button" className="min-h-44 rounded-chip border border-line px-12 text-small" onClick={() => setSheet({ kind: 'status' })}>
            {today.status ? STATUS_LABELS[today.status.level] : 'Okay'} ▾
          </button>
          <a
            href="/p/alerts"
            onClick={(e) => {
              e.preventDefault();
              navigate('/p/alerts');
            }}
            className="flex min-h-44 items-center gap-4 px-8 text-small"
            aria-label={today.alertsUnseen > 0 ? `Alerts: ${today.alertsUnseen} new` : 'Alerts'}
          >
            Alerts{today.alertsUnseen > 0 ? <span aria-hidden="true"> ●</span> : null}
          </a>
        </div>
      </header>
      {plan?.note ? (
        <p className="mt-4 break-words text-ink-2">
          {owner}: "{plan.note}"
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-8">
          {error}
        </p>
      ) : null}
      {me.pending && me.agreement ? <ProposalCard me={me} api={api} reload={reload} /> : null}
      <NotificationsCard api={api} owner={owner} />
      {today.sharingCheckin ? <SharingCheckin owner={owner} api={api} done={() => void load()} /> : null}
      {today.review ? (
        <Card label="Evening review">
          <a
            href={`/p?review=1&day=${today.review.day}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/p?review=1&day=${today.review?.day ?? day}`);
            }}
            className="block min-h-44"
          >
            <p className="font-medium">{today.review.yesterday ? "Yesterday's review" : 'How did today go?'}</p>
            <p className="text-small text-ink-2">{today.review.line}</p>
          </a>
        </Card>
      ) : null}
      {today.sleep.open ? (
        <Card label="Asleep">
          <div className="flex items-center justify-between gap-8">
            <p>Asleep since {hmOf(today.sleep.open.since)}</p>
            <Button variant="primary" size="lg" onClick={() => setSheet({ kind: 'wake' })}>
              Woke up
            </Button>
          </div>
        </Card>
      ) : today.sleep.askWake ? (
        <Card label="Wake time">
          <p>No wake time logged last night. You can add it under Health › Sleep.</p>
          <Button variant="text" size="sm" onClick={() => navigate('/p/health?tab=sleep')}>
            When did you wake up?
          </Button>
        </Card>
      ) : null}
      {view.focus ? <p className="mt-12 text-small text-ink-2">Focus: {view.focus.title} until about {hmOf(view.focus.until)}. Alerts from {owner} wait.</p> : null}
      {plan?.rough ? (
        <Card label="Rough day">
          <p>Rough day. The rest of today is cleared.</p>
          <Button variant="text" size="sm" onClick={() => void run(api.roughUndo(day))}>
            Undo rough day
          </Button>
        </Card>
      ) : null}
      {sections.map(([label, list]) =>
        list.length > 0 ? (
          <section key={label} aria-label={label} className="mt-16">
            <h2 className="text-small font-semibold text-ink-2">{label.toUpperCase()}</h2>
            <ul className="divide-y divide-line">
              {list.map((s) => (
                <StepRow key={s.id} s={s} owner={owner} late={view.late.includes(s.id)} onTick={() => tickStep(s)} onMore={() => setSheet({ kind: 'step', step: s })} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {(plan?.between ?? []).map((b) => (
        <section key={b.id} aria-label={b.title} className="mt-16">
          <p className="font-medium">
            Every {b.every >= 60 && b.every % 60 === 0 ? `${b.every / 60} h` : `${b.every} min`}, {b.from}–{b.to}: {b.title}
          </p>
          <div className="flex flex-wrap">
            {(view.slots[b.id] ?? []).map((sl) => (
              <button
                key={sl.slot}
                type="button"
                disabled={sl.state !== 'open' && sl.state !== 'done'}
                aria-pressed={sl.state === 'done'}
                aria-label={`${b.title} at ${sl.slot}${sl.state === 'later' ? ', not yet due' : ''}`}
                onClick={() => void run(api.betweenTick(day, b.id, sl.slot, sl.state !== 'done'))}
                className="flex min-h-44 min-w-64 items-center gap-4 px-4 text-small disabled:text-ink-3"
              >
                {sl.slot} {sl.state === 'done' ? '✓' : sl.state === 'open' ? '○' : '·'}
              </button>
            ))}
          </div>
        </section>
      ))}
      {today.meds && day === today.today && today.meds.groups.length > 0 ? (
        <section aria-label="Medicines" className="mt-16">
          <h2 className="font-semibold">Medicines</h2>
          <ul className="divide-y divide-line">
            {today.meds.groups
              .flatMap((g) => g.items)
              .map((i) => (
                <DoseRow
                  key={`${i.medId}@${i.slot}`}
                  item={i}
                  onLog={(status) =>
                    void api.doseLog(i.medId, { day, slot: i.slot, status }).then(
                      (r) => {
                        setError(null);
                        void load();
                        undo.show(`${status === 'taken' ? 'Taken' : 'Skipped'}: ${i.name} ${i.slot}`, () => void run(api.doseDelete(i.medId, r.id)));
                      },
                      (e: Error) => setError(e.message),
                    )
                  }
                  onUndo={() => i.doseId && void run(api.doseDelete(i.medId, i.doseId))}
                />
              ))}
          </ul>
        </section>
      ) : null}
      {today.todos.length > 0 ? (
        <section aria-label="Due today" className="mt-16">
          <h2 className="font-semibold">Reminders and to-dos{today.overdue > 0 ? ` · ${today.overdue} overdue` : ''}</h2>
          <ul className="divide-y divide-line">
            {today.todos.map((t) => (
              <TodoRow
                key={t.id}
                t={t}
                owner={owner}
                onDone={(d, report) =>
                  void api.done(t.id, d, report).then(
                    () => {
                      setError(null);
                      void load();
                      if (d) undo.show(`Done: ${t.title}`, () => void run(api.done(t.id, false)));
                    },
                    (e: Error) => setError(e.message),
                  )
                }
                onAck={() => void run(api.ack(t.id))}
              />
            ))}
          </ul>
        </section>
      ) : steps.length === 0 && !today.meds?.groups.length ? (
        <p className="mt-24 text-ink-2">Nothing planned or due right now.</p>
      ) : null}
      <p className="mt-16">
        <a
          href="/p/journal?checkin=1"
          className="inline-flex min-h-44 items-center text-ink-2 underline"
          onClick={(e) => {
            e.preventDefault();
            navigate('/p/journal?checkin=1');
          }}
        >
          Write in your journal · check in
        </a>
      </p>
      {day === today.today && !plan?.rough && steps.some((s) => s.status === 'todo' || s.status === 'doing') ? (
        <p>
          <button type="button" className="min-h-44 text-ink-2 underline" onClick={() => setSheet({ kind: 'rough' })}>
            Rough day? Clear the rest of today
          </button>
        </p>
      ) : null}
      {today.sleep.showStart ? <GoingToSleep api={api} done={() => void load()} show={undo.show} /> : null}
      <StickyBar
        unacked={unacked}
        now={nowStep}
        onAck={() => void run(api.planAck(day))}
        onDone={() => nowStep && tickStep(nowStep)}
        onStart={() => nowStep && setState(nowStep, 'doing')}
        onMore={() => nowStep && setSheet({ kind: 'step', step: nowStep })}
      />
      <UndoToast toast={undo.toast} close={undo.close} />
      <StepSheet sheet={sheet} day={day} owner={owner} api={api} close={() => setSheet(null)} run={run} setState={setState} />
      <StatusSheet open={sheet?.kind === 'status'} api={api} close={() => setSheet(null)} run={run} current={today.status?.level ?? 'ok'} />
      <WakeSheet open={sheet?.kind === 'wake'} api={api} close={() => setSheet(null)} run={run} />
      <RoughSheet open={sheet?.kind === 'rough'} owner={owner} close={() => setSheet(null)} onConfirm={(note) => {
        setSheet(null);
        void run(api.rough(day, note || undefined));
        undo.show('Rough day: the rest of today is cleared', () => void run(api.roughUndo(day)));
      }} />
    </div>
  );
}

/** Now, Next, Later (plan order) and Done (done and skipped, collapsed at the bottom). */
export function groupSteps(view: PlanView, steps: readonly PlanStep[]): [string, PlanStep[]][] {
  const open = steps.filter((s) => s.status === 'todo' || s.status === 'doing');
  const now = open.filter((s) => s.id === view.now);
  const next = open.filter((s) => s.id === view.next);
  const later = open.filter((s) => s.id !== view.now && s.id !== view.next);
  const closed = steps.filter((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'excused');
  return [
    ['Now', now],
    ['Next', next],
    ['Later', later],
    ['Done', closed],
  ];
}

function StepRow({ s, owner, late, onTick, onMore }: { s: PlanStep; owner: string; late: boolean; onTick: () => void; onMore: () => void }) {
  const closed = s.status === 'done' || s.status === 'skipped';
  const sub = [
    s.by === '' ? `From ${owner}` : null,
    s.editedBy === '' && s.by !== '' ? `Edited by ${owner}` : null,
    s.ask === 'report' && !closed ? 'asks for a short report' : null,
    s.ask === 'checkin' ? (s.checkin ? 'checked in' : 'check-in') : null,
    s.ask === 'ack' && !s.ackAt ? 'asks for Got it' : null,
    s.followUp && !closed ? `${owner} asked to know by ${s.followUp}` : null,
    s.status === 'doing' ? 'started' : null,
    s.status === 'skipped' ? `skipped${s.skip?.reason ? `: ${s.skip.reason}` : ''}` : null,
    s.status === 'excused' ? 'rough day' : null,
    s.report ? `"${s.report}"` : null,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-4 py-4">
      <Tick done={closed} disabled={s.status === 'excused'} label={closed ? `Undo ${s.title}` : `Done: ${s.title}`} onClick={onTick} />
      <button type="button" className="min-w-0 flex-1 py-8 text-left" onClick={onMore}>
        <p className={`break-words ${closed ? 'text-ink-3 line-through' : ''}`}>
          {s.at ? <span className="mr-8 tabular-nums">{s.at}</span> : null}
          {s.title}
          {s.minutes ? <span className="text-ink-2"> · {s.minutes} min</span> : null}
          {s.focus || s.focusByHer ? <span className="text-ink-2"> · ◐ focus</span> : null}
          {s.status === 'done' && s.doneAt ? <span className="text-ink-2"> · {hmOf(s.doneAt)}</span> : null}
        </p>
        {sub.length > 0 ? <p className="break-words text-small text-ink-2">{sub.join(' · ')}</p> : null}
      </button>
      {late ? <span className="mt-12 shrink-0 rounded-chip border border-line-strong px-8 text-small text-ink-2">late</span> : null}
    </li>
  );
}

function StickyBar({ unacked, now, onAck, onDone, onStart, onMore }: { unacked: boolean; now: PlanStep | null; onAck: () => void; onDone: () => void; onStart: () => void; onMore: () => void }) {
  // A focus step not started yet: Start is the one tap (focus holds normal alerts from then, C32).
  const start = now !== null && now.status === 'todo' && (now.focus || now.focusByHer === true);
  if (!unacked && !now) return null;
  return (
    <div className="fixed inset-x-0 bottom-[calc(44px+env(safe-area-inset-bottom))] z-10 border-t border-line bg-bg px-16 py-8">
      <div className="mx-auto flex max-w-[42rem] gap-8">
        {unacked ? (
          <Button variant="primary" size="xl" className="flex-1" onClick={onAck}>
            Got it
          </Button>
        ) : now ? (
          <>
            <Button variant="primary" size="xl" className="min-w-0 flex-1" onClick={start ? onStart : onDone}>
              <span className="truncate">
                {start ? 'Start' : 'Done'}: {now.title}
              </span>
            </Button>
            <Button variant="outline" size="xl" aria-label={`More for ${now.title}`} onClick={onMore}>
              …
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function StepSheet({
  sheet,
  day,
  owner,
  api,
  close,
  run,
  setState,
}: {
  sheet: OpenSheet;
  day: string;
  owner: string;
  api: PersonApi;
  close: () => void;
  run: (p: Promise<unknown>) => void;
  setState: (s: PlanStep, to: 'todo' | 'doing' | 'done' | 'skipped', extra?: { report?: string; reason?: string }) => void;
}) {
  const [mode, setMode] = useState<'menu' | 'skip' | 'ask'>('menu');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [mood, setMood] = useState<number | undefined>();
  const [energy, setEnergy] = useState<number | undefined>();
  const [need, setNeed] = useState('');
  const step = sheet && (sheet.kind === 'step' || sheet.kind === 'report' || sheet.kind === 'checkin') ? sheet.step : null;
  useEffect(() => {
    setMode('menu');
    setReason('');
    setNote('');
    setMood(undefined);
    setEnergy(undefined);
    setNeed('');
  }, [step?.id, sheet?.kind]);
  if (!step || !sheet) return null;
  const finish = () => close();
  if (sheet.kind === 'report') {
    return <ReportSheet open title={step.title} owner={owner} close={close} onDone={(report) => (setState(step, 'done', report ? { report } : {}), finish())} />;
  }
  if (sheet.kind === 'checkin') {
    return (
      <Sheet open onOpenChange={(o) => !o && close()} title={step.title}>
        <div className="flex flex-col gap-12 pb-24">
          <p className="text-small text-ink-2">Mood</p>
          <Faces label="Mood" value={mood} onChange={setMood} />
          <p className="text-small text-ink-2">Energy</p>
          <Faces label="Energy" value={energy} onChange={setEnergy} />
          <Field label="One line (optional)" value={note} onChange={setNote} max={200} />
          <Field label="Need anything? (optional)" value={need} onChange={setNeed} max={200} />
          <Button
            variant="primary"
            size="xl"
            disabled={mood === undefined || energy === undefined}
            onClick={() => {
              if (mood === undefined || energy === undefined) return;
              run(
                api.stepCheckin(day, step.id, { mood, energy, ...(note.trim() ? { line: note.trim() } : {}), ...(need.trim() ? { need: need.trim() } : {}) }).then(() => api.stepState(day, step.id, { to: 'done' })),
              );
              finish();
            }}
          >
            Save check-in
          </Button>
        </div>
      </Sheet>
    );
  }
  const his = step.by === '';
  const open = step.status === 'todo' || step.status === 'doing';
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title={step.title}>
      <div className="flex flex-col gap-8 pb-24">
        {step.notes ? <p className="whitespace-pre-wrap break-words text-ink-2">{step.notes}</p> : null}
        {mode === 'menu' ? (
          <>
            {his && step.ask === 'ack' && !step.ackAt ? (
              <Button variant="primary" size="xl" onClick={() => (run(api.stepAck(day, step.id)), finish())}>
                Got it
              </Button>
            ) : null}
            {open && step.status === 'todo' ? (
              <Button variant="outline" size="xl" onClick={() => (setState(step, 'doing'), finish())}>
                Start
              </Button>
            ) : null}
            {open ? (
              <Button variant="outline" size="xl" onClick={() => setMode('skip')}>
                Skip
              </Button>
            ) : (
              <Button variant="outline" size="xl" onClick={() => (setState(step, 'todo'), finish())}>
                Undo: mark it open again
              </Button>
            )}
            {his && open ? (
              <Button variant="outline" size="xl" onClick={() => setMode('ask')}>
                Ask to change
              </Button>
            ) : null}
            {step.at ? (
              <Button variant="text" onClick={() => (run(api.stepUpdate(day, step.id, { ring: step.mutedByHer === true || (!his && !step.ring) })), finish())}>
                {step.mutedByHer || (!his && !step.ring) ? 'Ring me for this step' : "Don't ring me for this step"}
              </Button>
            ) : null}
            <Button variant="text" onClick={() => (run(api.stepUpdate(day, step.id, { focus: !(his ? step.focusByHer : step.focus) })), finish())}>
              {(his ? step.focusByHer : step.focus) ? 'Not a focus step' : 'Mark as focus (alerts wait)'}
            </Button>
            {!his ? (
              <Button variant="text" onClick={() => (run(api.stepDelete(day, step.id)), finish())}>
                Delete this step
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <ReasonChips reasons={mode === 'skip' ? SKIP_REASONS : ASK_REASONS} value={reason} onPick={setReason} />
            <Field label={mode === 'skip' ? 'Reason (optional)' : `A note for ${owner} (optional)`} value={note} onChange={setNote} max={200} />
            <Button
              variant="primary"
              size="xl"
              onClick={() => {
                const text = [reason, note.trim()].filter(Boolean).join('. ');
                if (mode === 'skip') setState(step, 'skipped', text ? { reason: text.slice(0, 200) } : {});
                else run(api.stepAsk(day, step.id, (text || 'Can we change this?').slice(0, 200)));
                finish();
              }}
            >
              {mode === 'skip' ? 'Skip it' : `Send to ${owner}`}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}

function StatusSheet({ open, api, close, run, current }: { open: boolean; api: PersonApi; close: () => void; run: (p: Promise<unknown>) => void; current: 'ok' | 'low' | 'need_space' }) {
  const [level, setLevel] = useState(current);
  const [line, setLine] = useState('');
  useEffect(() => setLevel(current), [current, open]);
  if (!open) return null;
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title="How are you?">
      <div className="flex flex-col gap-12 pb-24">
        <div role="radiogroup" aria-label="Status" className="flex gap-8">
          {(['ok', 'low', 'need_space'] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={level === l} onClick={() => setLevel(l)} className={`min-h-48 flex-1 rounded-btn border ${level === l ? 'border-ink bg-hover' : 'border-line'}`}>
              {STATUS_LABELS[l]}
            </button>
          ))}
        </div>
        <Field label="A short line (optional)" value={line} onChange={setLine} max={60} />
        <p className="text-small text-ink-2">It clears itself after 12 hours. Need space holds alerts except Urgent.</p>
        <Button variant="primary" size="xl" onClick={() => (run(api.status({ level, ...(line.trim() ? { line: line.trim() } : {}) })), close())}>
          Save
        </Button>
      </div>
    </Sheet>
  );
}

function WakeSheet({ open, api, close, run }: { open: boolean; api: PersonApi; close: () => void; run: (p: Promise<unknown>) => void }) {
  const [quality, setQuality] = useState<number | undefined>();
  const [notes, setNotes] = useState('');
  if (!open) return null;
  const save = (withAnswers: boolean) => {
    run(api.sleepWake(withAnswers ? { ...(quality ? { quality } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) } : {}));
    close();
  };
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title="Good morning">
      <div className="flex flex-col gap-12 pb-24">
        <p className="text-small text-ink-2">How did you sleep? (optional)</p>
        <Faces label="Sleep quality" value={quality} onChange={setQuality} />
        <Field label="A note (optional)" value={notes} onChange={setNotes} max={500} />
        <div className="flex gap-8">
          <Button variant="primary" size="xl" className="flex-1" onClick={() => save(true)}>
            Save
          </Button>
          <Button variant="outline" size="xl" className="flex-1" onClick={() => save(false)}>
            Skip
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function RoughSheet({ open, owner, close, onConfirm }: { open: boolean; owner: string; close: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('');
  if (!open) return null;
  return (
    <Sheet open onOpenChange={(o) => !o && close()} title="Rough day?">
      <div className="flex flex-col gap-12 pb-24">
        <p>The rest of today's steps are cleared and stop ringing. {owner} gets one line: "a rough day". You can undo it today.</p>
        <Field label="A note (optional)" value={note} onChange={setNote} max={200} />
        <Button variant="primary" size="xl" onClick={() => onConfirm(note.trim())}>
          Clear the rest of today
        </Button>
      </div>
    </Sheet>
  );
}

function GoingToSleep({ api, done, show }: { api: PersonApi; done: () => void; show: (text: string, undo: () => void) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-16">
      <div>
        <Button
          variant="outline"
          size="xl"
          className="w-full bg-bg"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.sleepStart().then(
              (r) => {
                setBusy(false);
                done();
                show('Going to sleep. Good night.', () => void api.sleepDelete(r.night).then(done));
              },
              () => setBusy(false),
            );
          }}
        >
          Going to sleep
        </Button>
      </div>
    </div>
  );
}

function SharingCheckin({ owner, api, done }: { owner: string; api: PersonApi; done: () => void }) {
  const [tell, setTell] = useState(false);
  const answer = (a: 'keep' | 'ease' | 'pause' | 'talk' | 'snooze', to?: string) =>
    void api.sharingCheckin({ answer: a, ...(tell && a !== 'snooze' ? { tell: true } : {}) }).then(() => {
      done();
      if (to) navigate(to);
    });
  return (
    <Card label="Sharing check-in">
      <p className="font-medium">Is this setup still working for you?</p>
      <div className="mt-8 grid grid-cols-2 gap-8">
        <Button variant="outline" size="lg" onClick={() => answer('keep')}>
          Keep going
        </Button>
        <Button variant="outline" size="lg" onClick={() => answer('ease', '/p/me?tab=sharing')}>
          Ease off a bit
        </Button>
        <Button variant="outline" size="lg" onClick={() => answer('pause', '/p/me?tab=leave')}>
          Pause
        </Button>
        <Button variant="outline" size="lg" onClick={() => answer('talk')}>
          Let's talk
        </Button>
      </div>
      <label className="mt-8 flex min-h-44 items-center gap-8 text-small">
        <input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} /> Tell {owner} my answer
      </label>
      <Button variant="text" size="sm" onClick={() => answer('snooze')}>
        Ask me next week
      </Button>
      <p className="text-small text-ink-2">Your answer stays with you unless you pick Let's talk or tick the box.</p>
    </Card>
  );
}

export function ProposalCard({ me, api, reload }: { me: PersonMe; api: PersonApi; reload: () => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  const pending = me.pending;
  const current = me.agreement;
  if (!pending || !current) return null;
  const changed = new Set(fieldsChanged(current, pending.fields));
  const copy = joinCopy(me.owner.name, pending.fields, { built: me.built, foodModule: me.person.modules.food });
  const lines = [...copy.sees, ...copy.does].filter((l) => l.key !== null && changed.has(l.key));
  return (
    <section aria-label="Sharing request" className="mt-16 rounded-btn border border-line p-12">
      <p className="font-medium">{me.owner.name} asks to also see:</p>
      <ul className="mt-8 list-disc pl-20">{lines.map((l) => <li key={l.text}>{l.text}</li>)}</ul>
      {pending.note ? <p className="mt-8 whitespace-pre-wrap break-words text-ink-2">{pending.note}</p> : null}
      <label className="mt-8 flex min-h-44 items-center gap-8 text-small">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        Don't ask me about this again
      </label>
      <div className="mt-8 flex gap-12">
        <Button variant="primary" onClick={() => void api.accept(pending.version).then(reload)}>
          Allow
        </Button>
        <Button variant="outline" onClick={() => void api.decline(pending.version, dontAsk).then(reload)}>
          No thanks
        </Button>
      </div>
    </section>
  );
}

/** Until notifications are on: one card, so plan pushes, rings and alerts can reach her (spec 2.4). */
function NotificationsCard({ api, owner }: { api: PersonApi; owner: string }) {
  const [show, setShow] = useState(askForNotifications);
  const [note, setNote] = useState<string | null>(null);
  if (!show) return null;
  const home = needsHomeScreen();
  return (
    <Card label="Notifications">
      <p className="font-medium">{home ? 'Add the app to your Home Screen' : 'Turn on notifications'}</p>
      <p className="text-small text-ink-2">
        {home
          ? `On iPhone, your plan, its rings and alerts from ${owner} arrive only in the app on your Home Screen: tap Share, then Add to Home Screen, and open it from there.`
          : `Your plan, its rings and alerts from ${owner} arrive as notifications.`}
      </p>
      {note ? <p role="status" className="mt-4 text-small">{note}</p> : null}
      <div className="mt-8 flex flex-wrap gap-8">
        {home || note?.startsWith('Done') ? null : (
          <Button variant="primary" className="min-h-44" onClick={() => void turnOnNotifications(api).then(setNote)}>
            Turn on
          </Button>
        )}
        <Button variant="text" className="min-h-44" onClick={() => setShow(false)}>
          {note?.startsWith('Done') ? 'Close' : 'Not now'}
        </Button>
      </div>
    </Card>
  );
}
