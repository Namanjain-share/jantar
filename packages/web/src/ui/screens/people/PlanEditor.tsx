/**
 * v0.12 People (P2): his plan editor (spec 4.3, C30). One day of her plan:
 * a line for the day, steps in order (Move up and Move down are the keyboard
 * and screen-reader path), up to four check-betweens, and Send.
 *
 * - Start from ▾: the weekday's template, Copy yesterday, Copy last
 *   {weekday}, every template, and Quick plan (life-core's deterministic
 *   parser: the steps appear live under the box; junk becomes plain steps).
 * - Her own steps are read-only here unless editHers.plan is on; status is
 *   never in his body (the daemon keeps it from the stored step).
 * - A save carries `srev`; a stale one (409) reloads with "{name} changed
 *   the plan, check it". A hint shows when times run out of order.
 */
import { parseQuickPlan, type QuickPlan } from '@jantar/life-core';
import type { PlanPutBody, PlanStep, PlanTemplate, PlanView, StepAsk } from '@jantar/protocol/people';
import { useEffect, useMemo, useState } from 'react';
import { dayLabel, shiftDay, weekdayOf } from '../../../people-shared/time.js';
import { Button } from '../../kit/Button.js';
import type { PeopleClient } from './client.js';

type Draft = { key: string; id?: string; title: string; at: string; minutes: string; ask: StepAsk; focus: boolean; followUp: string; by: string; status?: PlanStep['status'] };
type DraftBetween = { key: string; id?: string; title: string; every: number; from: string; to: string };

let seq = 0;
const k = () => `d${(seq += 1)}`;

const fromStep = (s: PlanStep): Draft => ({ key: k(), id: s.id, title: s.title, at: s.at ?? '', minutes: s.minutes ? String(s.minutes) : '', ask: s.ask, focus: s.focus, followUp: s.followUp ?? '', by: s.by, status: s.status });
const fromQuick = (q: QuickPlan): { steps: Draft[]; between: DraftBetween[] } => ({
  steps: q.steps.map((s) => ({ key: k(), title: s.title, at: s.at ?? '', minutes: s.minutes ? String(s.minutes) : '', ask: s.ask ?? 'none', focus: s.focus === true, followUp: '', by: '' })),
  between: q.between.map((b) => ({ key: k(), ...b })),
});

/** "11:00 comes after 14:00" when timed steps run out of order (a quiet hint, never a block). */
export function orderHint(steps: readonly { at: string }[]): string | null {
  let last = '';
  for (const s of steps) {
    if (!s.at) continue;
    if (last && s.at < last) return `${s.at} comes after ${last}`;
    last = s.at;
  }
  return null;
}

/** Today before 18:00, tomorrow after: planning the night before is the natural path. */
export function defaultPlanDay(today: string, hhmm: string): string {
  return hhmm >= '18:00' ? shiftDay(today, 1) : today;
}

export function PlanEditor({ client, pid, name, day, editHers, onDay }: { client: PeopleClient; pid: string; name: string; day: string; editHers: boolean; onDay: (day: string) => void }) {
  const [view, setView] = useState<PlanView | null>(null);
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [note, setNote] = useState('');
  const [steps, setSteps] = useState<Draft[]>([]);
  const [between, setBetween] = useState<DraftBetween[]>([]);
  const [adding, setAdding] = useState('');
  const [quick, setQuick] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (msg: string | null = null) => {
    client.plan(pid, day).then(
      (v) => {
        setView(v);
        setNote(v.plan?.note ?? '');
        setSteps((v.plan?.steps ?? []).filter((s) => !s.carriedTo).map(fromStep));
        setBetween((v.plan?.between ?? []).map((b) => ({ key: k(), id: b.id, title: b.title, every: b.every, from: b.from, to: b.to })));
        setMessage(msg);
      },
      (e: Error) => setMessage(e.message),
    );
  };
  useEffect(() => {
    load();
    void client.templates(pid).then((t) => setTemplates(t.templates), () => setTemplates([]));
  }, [client, pid, day]);
  const preview = useMemo(() => (quick ? parseQuickPlan(quick) : null), [quick]);
  const hint = orderHint(steps);
  const mine = (d: Draft) => d.by === '' || editHers;
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j] as Draft, next[i] as Draft];
    setSteps(next);
  };
  const patch = (key: string, p: Partial<Draft>) => setSteps((cur) => cur.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const copyFrom = (from: string) =>
    void client.plan(pid, from).then(
      (v) => {
        setSteps((cur) => [...cur.filter((d) => d.by !== '' || d.status === 'done'), ...(v.plan?.steps ?? []).filter((s) => s.by === '' && !s.carriedTo).map((s) => ({ ...fromStep(s), key: k(), id: undefined, status: undefined }))]);
        setBetween((v.plan?.between ?? []).map((b) => ({ key: k(), title: b.title, every: b.every, from: b.from, to: b.to })));
        if (v.plan?.note) setNote(v.plan.note);
        setMenu(false);
      },
      (e: Error) => setMessage(e.message),
    );
  const applyTemplate = (t: PlanTemplate) =>
    void client.applyTemplate(pid, day, { templateId: t.id, mode: 'replace', srev: view?.plan?.srev ?? 0 }).then(
      () => (setMenu(false), load(`${t.name} applied.`)),
      (e: Error) => load(e.message),
    );
  const send = () => {
    const body: PlanPutBody = {
      srev: view?.plan?.srev ?? 0,
      note: note.trim() || null,
      steps: steps.map((d) => ({
        ...(d.id ? { id: d.id } : {}),
        title: d.title.trim().slice(0, 120) || 'Step',
        ...(d.at ? { at: d.at } : {}),
        ...(Number(d.minutes) >= 5 ? { minutes: Math.min(600, Math.round(Number(d.minutes))) } : {}),
        ask: d.ask,
        focus: d.focus,
        ...(d.followUp && d.by === '' ? { followUp: d.followUp } : {}),
      })),
      between: between.map((b) => ({ ...(b.id ? { id: b.id } : {}), title: b.title, every: b.every, from: b.from, to: b.to })),
    };
    setBusy(true);
    client.putPlan(pid, day, body).then(
      () => {
        setBusy(false);
        load('Sent.');
      },
      (e: Error & { status?: number }) => {
        setBusy(false);
        load(e.status === 409 && /changed since/.test(e.message) ? `${name} changed the plan, check it.` : e.message);
      },
    );
  };
  const saveTemplate = () => {
    const tname = window.prompt('Template name')?.trim();
    if (!tname) return;
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    void client
      .createTemplate(pid, {
        name: tname.slice(0, 40),
        weekdays: window.confirm(`Apply it every ${weekdayOf(day)} with no plan?`) ? [wd] : [],
        ...(note.trim() ? { note: note.trim() } : {}),
        steps: steps.filter((d) => d.by === '').map((d) => ({ title: d.title, ...(d.at ? { at: d.at } : {}), ...(Number(d.minutes) >= 5 ? { minutes: Number(d.minutes) } : {}), ask: d.ask, focus: d.focus })),
        between: between.map((b) => ({ title: b.title, every: b.every, from: b.from, to: b.to })),
      })
      .then(() => client.templates(pid).then((t) => (setTemplates(t.templates), setMessage(`Saved "${tname}".`))), (e: Error) => setMessage(e.message));
  };
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const dayTemplate = templates.find((t) => t.weekdays.includes(weekday));
  return (
    <section aria-label="Plan editor" className="mt-12">
      <div className="flex flex-wrap items-center gap-8">
        <Button variant="text" aria-label="Day before" onClick={() => onDay(shiftDay(day, -1))}>
          ◀
        </Button>
        <span className="type-row text-ink">{dayLabel(day)}</span>
        <Button variant="text" aria-label="Day after" onClick={() => onDay(shiftDay(day, 1))}>
          ▶
        </Button>
        <Button variant="outline" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
          Start from ▾
        </Button>
        <Button variant="primary" disabled={busy} onClick={send}>
          Send ▸
        </Button>
      </div>
      {menu ? (
        <ul className="mt-8 rounded-btn border border-line">
          {dayTemplate ? (
            <li>
              <MenuItem onClick={() => applyTemplate(dayTemplate)}>{dayTemplate.name} (this weekday)</MenuItem>
            </li>
          ) : null}
          <li>
            <MenuItem onClick={() => copyFrom(shiftDay(day, -1))}>Copy yesterday</MenuItem>
          </li>
          <li>
            <MenuItem onClick={() => copyFrom(shiftDay(day, -7))}>Copy last {weekdayOf(day)}</MenuItem>
          </li>
          {templates
            .filter((t) => t !== dayTemplate)
            .map((t) => (
              <li key={t.id} className="flex">
                <MenuItem onClick={() => applyTemplate(t)}>{t.name}</MenuItem>
                <Button variant="text" size="sm" aria-label={`Delete template ${t.name}`} onClick={() => void client.deleteTemplate(pid, t.id).then(() => setTemplates((c) => c.filter((x) => x.id !== t.id)))}>
                  ✕
                </Button>
              </li>
            ))}
          <li>
            <MenuItem onClick={() => (setQuick(''), setMenu(false))}>Quick plan</MenuItem>
          </li>
          <li>
            <MenuItem onClick={() => (setMenu(false), saveTemplate())}>Save as template…</MenuItem>
          </li>
        </ul>
      ) : null}
      {quick !== null ? (
        <div className="mt-8 flex flex-col gap-8">
          <label className="flex flex-col gap-4">
            <span className="type-small text-ink-2">Quick plan: a line or "then" per step (8:00 Mock, Analysis 45m, every 2h 10-18 Check, !report)</span>
            <textarea aria-label="Quick plan" className="min-h-88 rounded-btn border border-line bg-bg px-8 py-8" value={quick} onChange={(e) => setQuick(e.target.value)} />
          </label>
          {preview ? (
            <ul aria-label="Quick plan preview" className="type-small text-ink-2">
              {preview.steps.map((s, i) => (
                <li key={`${i}-${s.title}`}>
                  {s.at ? `${s.at} ` : '· '}
                  {s.title}
                  {s.minutes ? ` · ${s.minutes} min` : ''}
                  {s.ask ? ` · ${s.ask}` : ''}
                  {s.focus ? ' · focus' : ''}
                </li>
              ))}
              {preview.between.map((b) => (
                <li key={b.title}>
                  Every {b.every} min {b.from}–{b.to}: {b.title}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-8">
            <Button
              variant="primary"
              disabled={!preview || preview.steps.length + preview.between.length === 0}
              onClick={() => {
                if (!preview) return;
                const q = fromQuick(preview);
                setSteps((cur) => [...cur.filter((d) => d.by !== '' || d.status === 'done'), ...q.steps]);
                if (q.between.length) setBetween(q.between.slice(0, 4));
                setQuick(null);
              }}
            >
              Use these steps
            </Button>
            <Button variant="outline" onClick={() => setQuick(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <label className="mt-12 flex flex-col gap-4">
        <span className="type-small text-ink-2">Line for the day</span>
        <input className="h-40 rounded-btn border border-line bg-bg px-8" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {message ? (
        <p role="status" className="mt-8 type-small text-ink">
          {message}
        </p>
      ) : null}
      {hint ? <p className="mt-8 type-small text-ink-2">{hint}</p> : null}
      <ol className="mt-8 border-t border-line">
        {steps.map((d, i) => (
          <li key={d.key} className="flex flex-wrap items-center gap-8 border-b border-line py-8">
            <span className="flex flex-col">
              <Button variant="text" size="sm" aria-label={`Move up: ${d.title}`} disabled={i === 0} onClick={() => move(i, -1)}>
                ▲
              </Button>
              <Button variant="text" size="sm" aria-label={`Move down: ${d.title}`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                ▼
              </Button>
            </span>
            {mine(d) ? (
              <>
                <input aria-label="Time" type="time" className="h-32 rounded-btn border border-line bg-bg px-4" value={d.at} onChange={(e) => patch(d.key, { at: e.target.value })} />
                <input aria-label="Step" className="h-32 min-w-0 flex-1 rounded-btn border border-line bg-bg px-8" maxLength={120} value={d.title} onChange={(e) => patch(d.key, { title: e.target.value })} />
                <input aria-label="Minutes" inputMode="numeric" placeholder="min" className="h-32 w-56 rounded-btn border border-line bg-bg px-4" value={d.minutes} onChange={(e) => patch(d.key, { minutes: e.target.value.replace(/\D/g, '') })} />
                <select aria-label="Ask" className="h-32 rounded-btn border border-line bg-bg px-4" value={d.ask} onChange={(e) => patch(d.key, { ask: e.target.value as StepAsk })}>
                  <option value="none">ask: none</option>
                  <option value="ack">Got it</option>
                  <option value="report">report</option>
                  <option value="checkin">check-in</option>
                </select>
                <label className="flex items-center gap-4 type-small">
                  <input type="checkbox" checked={d.focus} onChange={(e) => patch(d.key, { focus: e.target.checked })} /> focus
                </label>
                {d.by === '' ? <input aria-label="Tell me if not done by" title="Tell me if not done by" type="time" className="h-32 rounded-btn border border-line bg-bg px-4" value={d.followUp} onChange={(e) => patch(d.key, { followUp: e.target.value })} /> : null}
                <Button variant="text" size="sm" aria-label={`Remove ${d.title}`} onClick={() => setSteps((cur) => cur.filter((x) => x.key !== d.key))}>
                  ✕
                </Button>
              </>
            ) : (
              <span className="flex-1 type-row text-ink-2">
                {d.at ? `${d.at} ` : ''}
                {d.title} · {name}'s own step
              </span>
            )}
            {d.status && d.status !== 'todo' ? <span className="type-small text-ink-2">{d.status}</span> : null}
            {d.by !== '' && editHers ? <span className="type-small text-ink-2">{name}'s step: your change says "Edited by"</span> : null}
          </li>
        ))}
      </ol>
      <form
        className="mt-8 flex gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (!adding.trim()) return;
          setSteps((cur) => [...cur, { key: k(), title: adding.trim(), at: '', minutes: '', ask: 'none', focus: false, followUp: '', by: '' }]);
          setAdding('');
        }}
      >
        <input aria-label="Add step" placeholder="+ Add step" className="h-40 min-w-0 flex-1 rounded-btn border border-line bg-bg px-8" maxLength={120} value={adding} onChange={(e) => setAdding(e.target.value)} />
        <Button type="submit" variant="outline">
          Add
        </Button>
      </form>
      {between.length > 0 ? (
        <ul className="mt-12">
          {between.map((b) => (
            <li key={b.key} className="flex items-center justify-between gap-8 type-row">
              <span>
                Every {b.every >= 60 && b.every % 60 === 0 ? `${b.every / 60} h` : `${b.every} min`} {b.from}–{b.to}: {b.title}
              </span>
              <Button variant="text" size="sm" aria-label={`Remove ${b.title}`} onClick={() => setBetween((c) => c.filter((x) => x.key !== b.key))}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="flex min-h-44 w-full items-center px-12 text-left type-row hover:bg-hover" onClick={onClick}>
      {children}
    </button>
  );
}
