/**
 * v0.12 People (P2): his Partner screen (`/people/:pid?tab=…&day=`, spec
 * 4.1, 4.2), a lazy chunk: his main load doesn't carry it.
 *
 * - Header: her name, her status and line, "Asleep since" (see.sleep), and
 *   the day's progress with the Now step. Action row: Plan, Assign and
 *   Alert, one tap each; a new alert from her shows here and on the tab.
 * - Tabs (they wrap, none hidden): Today (her plan as she sees it, each
 *   step's status, done time, report and check-in, late chips, Nudge on
 *   today's open steps; check-betweens; the concern lines; her evening
 *   review at his level, with Carry for his open steps), To-do (his items
 *   and hers, Nudge, edit his, and hers with editHers.todos), Health (the
 *   sleep week), Journal (read, and comment with comment.journal), Chat,
 *   Lists and Alerts (both ways). The plan editor opens from Plan.
 * - An area she keeps private is a grey tile, "{name} keeps this private":
 *   never just absent, never a warning colour, never a count of days.
 * - Every read goes through his People routes, so each writes her view
 *   mark; he has no control here that writes in her name.
 */
import { ALERT_KINDS, ALERT_REPLY_LABELS, STATUS_LABELS, type AlertKind } from '@jantar/protocol/people-core';
import type {
  AlertsResponse,
  AssignTodoBody,
  JournalEntryFull,
  JournalList,
  OwnerChatView,
  OwnerTodosView,
  SharedItemsResponse,
  SharedListsResponse,
  PersonAlert,
  PersonToday,
  PersonTodo,
  PersonView,
  PlanStep,
  ReviewView,
  SleepWeek as Week,
  TodoAsk,
} from '@jantar/protocol/people';
import type { ChatTurn, PlacesResponse } from '@jantar/protocol';
import { ChatRead } from '../../../people-shared/ChatRead.js';
import { useEffect, useState } from 'react';
import { JournalEntryCard } from '../../../people-shared/JournalEntryCard.js';
import { PlanRead } from '../../../people-shared/PlanRead.js';
import { ReviewList } from '../../../people-shared/ReviewList.js';
import { SleepWeek } from '../../../people-shared/SleepWeek.js';
import { dayLabel, hmOf } from '../../../people-shared/time.js';
import { useDeps, useNavigate } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { peopleClient, type PeopleClient } from './client.js';
import { PlanEditor, defaultPlanDay } from './PlanEditor.js';

export const PARTNER_TABS = ['today', 'todos', 'plan', 'health', 'journal', 'chat', 'lists', 'alerts'] as const;
export type PartnerTab = (typeof PARTNER_TABS)[number];
/** The tab row (the plan editor opens from the header's Plan, so it isn't a tab too). */
const TAB_ROW: readonly PartnerTab[] = ['today', 'todos', 'health', 'journal', 'chat', 'lists', 'alerts'];
const TAB_LABEL: Record<PartnerTab, string> = { today: 'Today', todos: 'To-do', plan: 'Plan', health: 'Health', journal: 'Journal', chat: 'Chat', lists: 'Lists', alerts: 'Alerts' };

/** This device's date (his Mac's zone, which his app shares): Nudge is for today only. */
function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  const alerts = useLifeLoad<AlertsResponse>(`people:${pid}:alerts`, () => client.alerts(pid));
  const [alerting, setAlerting] = useState(false);
  const [assigning, setAssigning] = useState(false);
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
  const unseen = alerts.data?.unseen ?? 0;
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
            plan?.plan && plan.counts.total > 0 ? `${plan.counts.done} of ${plan.counts.total}` : null,
            nowStep ? `Now: ${nowStep.title}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {unseen > 0 ? (
          <button type="button" className="mt-4 min-h-44 type-row text-ink underline" onClick={() => go('alerts')}>
            {unseen === 1 ? `A new alert from ${name}` : `${unseen} new alerts from ${name}`}
          </button>
        ) : null}
        <div className="mt-8 flex flex-wrap gap-8">
          <Button variant="outline" className="min-h-44" disabled={!a?.assign.plan} onClick={() => go('plan', planDay ? `&day=${planDay}` : '')}>
            Plan
          </Button>
          <Button variant="outline" className="min-h-44" disabled={!a?.assign.todos} onClick={() => setAssigning(true)}>
            Assign
          </Button>
          <Button variant="outline" className="min-h-44" onClick={() => setAlerting(true)}>
            Alert
          </Button>
        </div>
      </header>
      <div role="tablist" className="mt-12 flex flex-wrap gap-x-4 border-b border-line">
        {TAB_ROW.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} onClick={() => go(x)} className={`min-h-44 shrink-0 px-12 type-row ${tab === x ? 'border-b-2 border-ink text-ink' : 'text-ink-2'}`}>
            {TAB_LABEL[x]}
            {x === 'alerts' && unseen > 0 ? <span aria-label={`, ${unseen} new`}> ●</span> : null}
          </button>
        ))}
      </div>
      {tab === 'today' ? <TodayTab client={client} pid={pid} name={name} today={t} reload={today.reload} canCarry={a?.assign.plan === true} isToday={!dayIn || dayIn === localDay()} /> : null}
      {tab === 'todos' ? <TodosTab client={client} pid={pid} name={name} sees={a?.see.todos === true} canAssign={a?.assign.todos === true} editHers={a?.editHers.todos === true} onAssign={() => setAssigning(true)} /> : null}
      {tab === 'plan' && planDay ? (
        a?.see.plan && a.assign.plan ? <PlanEditor client={client} pid={pid} name={name} day={planDay} editHers={a.editHers.plan} onDay={(d) => go('plan', `&day=${d}`)} /> : <Locked name={name} what="Day plan" />
      ) : null}
      {tab === 'health' ? <HealthTab client={client} pid={pid} name={name} sees={a?.see.sleep === true} /> : null}
      {tab === 'journal' ? <JournalTab client={client} pid={pid} name={name} sees={a?.see.journal === true} canComment={a?.comment.journal === true} id={id} /> : null}
      {tab === 'chat' ? <ChatTab client={client} pid={pid} name={name} sees={a?.see.chat === true} perDay={person?.chatPerDay ?? null} /> : null}
      {tab === 'lists' ? <ListsTab client={client} pid={pid} name={name} space={person?.sharedSpace ?? null} canAssign={a?.assign.todos === true} id={id} /> : null}
      {tab === 'alerts' ? <AlertsTab client={client} pid={pid} name={name} id={id} /> : null}
      <AlertSheet open={alerting} client={client} pid={pid} name={name} close={() => setAlerting(false)} />
      <AssignSheet open={assigning} client={client} pid={pid} name={name} close={() => setAssigning(false)} done={() => (today.reload(), tab !== 'todos' ? go('todos') : null)} />
    </div>
  );
}

function TodayTab({ client, pid, name, today, reload, canCarry, isToday }: { client: PeopleClient; pid: string; name: string; today: PersonToday | null; reload: () => void; canCarry: boolean; isToday: boolean }) {
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
      {isLocked(today.plan) ? (
        <Locked name={name} what="Day plan" />
      ) : (
        <PlanRead view={today.plan} name={name} {...(isToday && today.plan.plan?.sentAt ? { onNudge: (s: PlanStep) => nudge(s, today.day) } : {})} />
      )}
      {today.review === null ? null : isLocked(today.review) ? (
        <Locked name={name} what="Evening review" />
      ) : (
        <ReviewRead client={client} pid={pid} name={name} v={today.review} canCarry={canCarry} done={reload} />
      )}
      {isLocked(today.todos) ? (
        <Locked name={name} what="To-dos" />
      ) : (
        <p className="mt-12 type-row text-ink">
          {isToday ? 'To-do today' : `To-do by ${dayLabel(today.day)}`}: {today.todos.due.length}
          {today.todos.overdue ? ` · overdue ${today.todos.overdue}` : ''}
        </p>
      )}
      {isLocked(today.weight) ? <Locked name={name} what="Weight" /> : today.weight.latest ? <p className="type-row text-ink">Weight {today.weight.latest.kg} kg ({today.weight.latest.day})</p> : null}
    </div>
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

/**
 * P3 (spec 7.8): her chat, read only, while she shares it: no composer, no Undo, no card button, no delete.
 * Her messages and the answers render through markdown.tsx's default mode (people-shared/ChatRead.tsx).
 */
function ChatTab({ client, pid, name, sees, perDay }: { client: PeopleClient; pid: string; name: string; sees: boolean; perDay: number | null }) {
  const load = useLifeLoad<OwnerChatView>(sees ? `people:${pid}:chat` : null, () => client.chat(pid));
  const [earlier, setEarlier] = useState<{ turns: ChatTurn[]; older: string | null } | null>(null);
  const [cap, setCap] = useState(perDay === null ? '' : String(perDay));
  const [note, setNote] = useState<string | null>(null);
  const older = earlier ? earlier.older : (load.data?.older ?? null);
  const more = async () => {
    if (!older) return;
    const r = await client.chat(pid, older);
    setEarlier({ turns: [...r.turns, ...(earlier?.turns ?? [])], older: r.older });
  };
  const saveCap = async () => {
    const n = Number(cap);
    if (!Number.isInteger(n) || n < 0 || n > 200) return setNote('A whole number from 0 to 200.');
    try {
      await client.setChatPerDay(pid, n);
      setNote(`Saved. ${name} sees it in Activity.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const capRow = (
    <div className="mt-16 flex flex-wrap items-center gap-8 type-small text-ink-2">
      <label htmlFor="chat-cap">{name}'s messages a day</label>
      <input id="chat-cap" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} className="w-[4.5rem] rounded-btn border border-line bg-bg px-8 py-4 type-row text-ink" />
      <Button variant="text" onClick={() => void saveCap()}>
        Save
      </Button>
      {note ? <span role="status">{note}</span> : null}
    </div>
  );
  if (!sees) return (
    <>
      <Locked name={name} what="Chat" />
      {capRow}
    </>
  );
  const turns = [...(earlier?.turns ?? []), ...(load.data?.turns ?? [])];
  return (
    <div className="mt-12">
      <p className="type-small text-ink-2">Read only. {name}'s assistant runs on your Claude account. Messages older than {load.data?.keepDays ?? 30} days are gone for both of you.</p>
      {older ? (
        <Button variant="text" onClick={() => void more()}>
          Earlier
        </Button>
      ) : null}
      {load.data ? (
        turns.length ? (
          <ul className="mt-8">
            {turns.map((t) => (
              <ChatRead key={t.id} turn={t} name={name} photoUrl={(id) => client.chatPhotoUrl(pid, id)} />
            ))}
          </ul>
        ) : (
          <p className="mt-12 type-row text-ink-2">No messages.</p>
        )
      ) : (
        <p className="mt-12 type-small text-ink-2">Loading…</p>
      )}
      {capRow}
    </div>
  );
}

/**
 * P4 (spec 5): what he shares with her. Cafés: the shared ones (open them on Cafés), and his own with Share
 * (one, or Share all); one he added can go back to just him. Lists: both people's, with ticks ("Ticked by
 * Asha · 18:20"), and Assign to her (assign.todos): an unlinked to-do of hers from him.
 */
function ListsTab({ client, pid, name, space, canAssign, id }: { client: PeopleClient; pid: string; name: string; space: string | null; canAssign: boolean; id?: string }) {
  const navigate = useNavigate();
  const { api } = useDeps();
  const shared = useLifeLoad<PlacesResponse>(space ? `people:${pid}:cafes:shared` : null, () => api.placesList({ space: 'shared' }));
  const mine = useLifeLoad<PlacesResponse>(space ? `people:${pid}:cafes:mine` : null, () => api.placesList({ space: 'mine' }));
  const lists = useLifeLoad<SharedListsResponse>(`people:${pid}:lists`, () => client.lists(pid));
  const items = useLifeLoad<SharedItemsResponse>(id ? `people:${pid}:list:${id}` : null, () => client.listItems(pid, id as string));
  const [listName, setListName] = useState('');
  const [item, setItem] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setNote(null);
    try {
      await fn();
      shared.reload();
      mine.reload();
      lists.reload();
      items.reload();
      if (done) setNote(done);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const who = (by: string | undefined) => (by === '' ? 'you' : by === pid ? name : 'someone');
  if (id) {
    const d = items.data;
    if (!d) return <p className="mt-12 type-small text-ink-2">Loading…</p>;
    return (
      <div className="mt-12 flex flex-col gap-8">
        <Button variant="text" onClick={() => navigate(`/people/${pid}?tab=lists`)}>
          ‹ Lists
        </Button>
        <h2 className="type-row font-semibold text-ink">{d.list.name}</h2>
        <div className="flex gap-8">
          <input aria-label="Add an item" value={item} maxLength={200} onChange={(e) => setItem(e.target.value)} className="min-h-44 flex-1 rounded-btn border border-line bg-bg px-12 type-row text-ink" />
          <Button disabled={!item.trim()} onClick={() => void run(async () => (await client.listItemAdd(pid, id, item.trim()), setItem('')))}>
            Add
          </Button>
        </div>
        <ul>
          {d.items.map((it) => (
            <li key={it.id} className="flex items-center gap-8 border-b border-line py-8">
              <input type="checkbox" aria-label={it.title} checked={Boolean(it.doneAt)} onChange={() => void run(() => client.listItemTick(pid, id, it.id, !it.doneAt))} />
              <span className="min-w-0 flex-1">
                <span className={`block break-words type-row [overflow-wrap:anywhere] ${it.doneAt ? 'text-ink-2 line-through' : 'text-ink'}`}>{it.title}</span>
                <span className="block type-small text-ink-2">
                  {it.handed ? `Assigned to ${name}` : it.doneAt ? `Ticked by ${who(it.doneBy)} · ${hmOf(it.doneAt)}` : `Added by ${who(it.by)}`}
                </span>
              </span>
              {canAssign && !it.doneAt ? (
                <Button variant="text" onClick={() => void run(() => client.listItemAssign(pid, id, it.id), `Added for ${name}.`)}>
                  Assign to {name}
                </Button>
              ) : null}
              <Button variant="text" aria-label={`Delete ${it.title}`} onClick={() => void run(() => client.listItemDelete(pid, id, it.id))}>
                ×
              </Button>
            </li>
          ))}
        </ul>
        {note ? <p role="status" className="type-small text-ink-2">{note}</p> : null}
        <Button variant="text" onClick={() => setConfirm(true)}>
          Delete list
        </Button>
        <Sheet open={confirm} onOpenChange={setConfirm} title={`Delete ${d.list.name} for both of you?`}>
          <div className="flex gap-8 pb-24">
            <Button onClick={() => void run(async () => (await client.listDelete(pid, id), navigate(`/people/${pid}?tab=lists`)))}>Delete</Button>
            <Button variant="text" onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </div>
        </Sheet>
      </div>
    );
  }
  const own = (mine.data?.places ?? []).filter((p) => !p.space);
  return (
    <div className="mt-12 flex flex-col gap-12">
      <h2 className="type-row font-semibold text-ink">Cafés you share with {name}</h2>
      <ul>
        {(shared.data?.places ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-8 border-b border-line py-8">
            <a href={`/places?id=${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/places?id=${p.id}`))} className="min-w-0 flex-1 truncate type-row text-ink">
              {p.name}
            </a>
            <span className="type-small text-ink-2">{p.by === '' ? 'Added by you' : `Added by ${name}`}</span>
            {p.by === '' ? (
              <Button variant="text" onClick={() => void run(() => api.placeUpdate(p.id, { space: '' }))}>
                Just me
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {own.length && space ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="type-small text-ink-2">Your cafés</span>
            <Button variant="text" onClick={() => void run(async () => { for (const p of own) await api.placeUpdate(p.id, { space }); }, `Shared ${own.length} with ${name}.`)}>
              Share all
            </Button>
          </div>
          <ul>
            {own.map((p) => (
              <li key={p.id} className="flex items-center gap-8 border-b border-line py-8">
                <span className="min-w-0 flex-1 truncate type-row text-ink">{p.name}</span>
                <Button variant="text" onClick={() => void run(() => api.placeUpdate(p.id, { space }))}>
                  Share
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h2 className="type-row font-semibold text-ink">Lists</h2>
      <ul>
        {(lists.data?.lists ?? []).map((l) => (
          <li key={l.id} className="border-b border-line">
            <button type="button" onClick={() => navigate(`/people/${pid}?tab=lists&id=${l.id}`)} className="flex min-h-44 w-full items-center justify-between py-8 text-left type-row text-ink">
              <span>{l.name}</span>
              <span className="type-small text-ink-2">{l.open} open</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-8">
        <input aria-label="New list" value={listName} maxLength={60} onChange={(e) => setListName(e.target.value)} className="min-h-44 flex-1 rounded-btn border border-line bg-bg px-12 type-row text-ink" />
        <Button disabled={!listName.trim()} onClick={() => void run(async () => (await client.listCreate(pid, listName.trim(), 'plain'), setListName('')))}>
          New list
        </Button>
      </div>
      {note ? <p role="status" className="type-small text-ink-2">{note}</p> : null}
    </div>
  );
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

/** One to-do's line under its title: due, who added it, and where it stands. */
function todoLine(t: PersonTodo, name: string): string {
  return [
    t.due ? `${t.due.day === localDay() ? 'Today' : dayLabel(t.due.day)}${t.due.time ? ` ${t.due.time}` : ''}` : null,
    t.by === '' ? 'from you' : `${name}'s own`,
    t.editedBy === '' && t.by !== '' ? 'edited by you' : null,
    t.snoozable === false ? 'no snooze' : null,
    t.followUp ? `tell you if not done by ${t.followUp}` : null,
    t.ask === 'ack' ? (t.ackAt ? 'Got it' : 'asks for Got it') : null,
    t.ask === 'report' && !t.doneAt ? 'asks for a report' : null,
    t.doneAt ? `done ${dayLabel(t.doneAt.slice(0, 10))} ${hmOf(t.doneAt)}` : null,
    t.report ? `"${t.report}"` : null,
    t.skipped ? `skipped${t.skipped.reason ? `: ${t.skipped.reason}` : ''}` : null,
    t.askedChange ? `asks to change: "${t.askedChange.note}"` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Her to-dos as he may see them (see.todos): his items and hers, open first. Nudge an open one (her caps
 * apply); edit or delete his own (assign.todos), and hers only with editHers.todos ("Edited by" on her side,
 * the old values in her Activity).
 */
function TodosTab({ client, pid, name, sees, canAssign, editHers, onAssign }: { client: PeopleClient; pid: string; name: string; sees: boolean; canAssign: boolean; editHers: boolean; onAssign: () => void }) {
  const open = useLifeLoad<OwnerTodosView>(sees ? `people:${pid}:todos` : null, () => client.todos(pid));
  const done = useLifeLoad<OwnerTodosView>(sees ? `people:${pid}:todos:done` : null, () => client.todos(pid, true));
  const [editing, setEditing] = useState<PersonTodo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!sees) return <Locked name={name} what="To-dos" />;
  const reload = () => (open.reload(), done.reload());
  const nudge = (t: PersonTodo) =>
    void client.sendAlert({ to: pid, kind: 'nudge', ref: { type: 'todo', id: t.id } }).then(
      (r) => setNote(r.delivery === 'sent' ? `Reminder sent: ${t.title}` : r.delivery === 'capped' ? `Saved: ${name}'s limit for reminders is reached.` : 'Held until the quiet time ends.'),
      (e: Error) => setNote(e.message),
    );
  const remove = (t: PersonTodo) => void client.deleteTodo(pid, t.id).then(() => (setNote(`Deleted: ${t.title}`), reload()), (e: Error) => setNote(e.message));
  const canEdit = (t: PersonTodo) => (t.by === '' ? canAssign : editHers);
  const row = (t: PersonTodo, isOpen: boolean) => (
    <li key={t.id} className="flex flex-wrap items-start gap-8 border-b border-line py-8">
      <div className="min-w-0 flex-1 basis-[12rem]">
        <p className={`break-words type-row [overflow-wrap:anywhere] ${isOpen ? 'text-ink' : 'text-ink-2'}`}>{t.title}</p>
        <p className="break-words type-small text-ink-2">{todoLine(t, name)}</p>
      </div>
      <div className="flex flex-wrap gap-4">
        {isOpen ? (
          <Button variant="outline" className="min-h-44" onClick={() => nudge(t)}>
            Nudge
          </Button>
        ) : null}
        {canEdit(t) ? (
          <Button variant="outline" className="min-h-44" onClick={() => setEditing(t)}>
            Edit
          </Button>
        ) : null}
        {canEdit(t) ? (
          <Button variant="text" className="min-h-44" onClick={() => remove(t)}>
            Delete
          </Button>
        ) : null}
      </div>
    </li>
  );
  const openList = open.data?.todos ?? [];
  const doneList = (done.data?.todos ?? []).slice(0, 20);
  return (
    <div className="mt-12">
      {canAssign ? (
        <Button variant="primary" className="min-h-44" onClick={onAssign}>
          Assign a to-do
        </Button>
      ) : null}
      {note ? (
        <p role="status" className="mt-8 type-small text-ink">
          {note}
        </p>
      ) : null}
      <h2 className="mt-12 type-row font-semibold text-ink">Open</h2>
      {openList.length ? <ul className="border-t border-line">{openList.map((t) => row(t, true))}</ul> : <p className="type-small text-ink-2">{open.data ? 'Nothing open.' : 'Loading…'}</p>}
      {doneList.length ? (
        <>
          <h2 className="mt-16 type-row font-semibold text-ink">Done lately</h2>
          <ul className="border-t border-line">{doneList.map((t) => row(t, false))}</ul>
        </>
      ) : null}
      <AssignSheet open={editing !== null} client={client} pid={pid} name={name} edit={editing} close={() => setEditing(null)} done={reload} />
    </div>
  );
}

/**
 * Assign a to-do to her (assign.todos), or edit one (his, or hers with editHers.todos): a title, a due day
 * and time, what it asks of her (nothing, Got it, a short report), no snooze, and "Tell me if not done by".
 */
function AssignSheet({ open, client, pid, name, close, done, edit = null }: { open: boolean; client: PeopleClient; pid: string; name: string; close: () => void; done: () => void; edit?: PersonTodo | null }) {
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [ask, setAsk] = useState<TodoAsk>('none');
  const [noSnooze, setNoSnooze] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(edit?.title ?? '');
    setDay(edit?.due?.day ?? '');
    setTime(edit?.due?.time ?? '');
    setAsk(edit?.ask ?? 'none');
    setNoSnooze(edit?.snoozable === false);
    setFollowUp(edit?.followUp ?? '');
    setError(null);
  }, [open, edit]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const due = day ? { day, ...(time ? { time } : {}) } : undefined;
      if (edit) {
        await client.updateTodo(pid, edit.id, { title: title.trim(), due: due ?? null, ask, snoozable: !noSnooze, followUp: day && followUp ? followUp : null });
      } else {
        const body: AssignTodoBody = { title: title.trim(), ...(due ? { due } : {}), ask, ...(noSnooze ? { snoozable: false } : {}), ...(day && followUp ? { followUp } : {}) };
        await client.assignTodo(pid, body);
      }
      done();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const field = 'min-h-44 rounded-btn border border-line bg-bg px-8 type-row text-ink';
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? null : close())} title={edit ? `Edit: ${edit.title}` : `Assign to ${name}`}>
      <div className="flex flex-col gap-12 pb-24">
        <label className="flex flex-col gap-4">
          <span className="type-small text-ink-2">To-do</span>
          <input className={field} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-8">
          <label className="flex flex-col gap-4">
            <span className="type-small text-ink-2">Due day</span>
            <input type="date" className={field} value={day} onChange={(e) => setDay(e.target.value)} />
          </label>
          <label className="flex flex-col gap-4">
            <span className="type-small text-ink-2">Time</span>
            <input type="time" className={field} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <fieldset className="flex flex-col gap-4">
          <legend className="type-small text-ink-2">Ask {name} for</legend>
          {(
            [
              ['none', 'Nothing'],
              ['ack', 'Got it'],
              ['report', 'A short report when done'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex min-h-44 items-center gap-8 type-row">
              <input type="radio" className="size-20" name="assign-ask" checked={ask === v} onChange={() => setAsk(v)} /> {label}
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-44 items-center gap-8 type-row">
          <input type="checkbox" className="size-20" checked={noSnooze} onChange={(e) => setNoSnooze(e.target.checked)} /> No snooze
        </label>
        <label className="flex flex-col gap-4">
          <span className="type-small text-ink-2">Tell me if not done by (needs a due day)</span>
          <input type="time" className={field} value={followUp} disabled={!day} onChange={(e) => setFollowUp(e.target.value)} />
        </label>
        <p className="type-small text-ink-3">
          {name} sees it at once, marked "From you"{noSnooze ? ' and "no snooze"' : ''}
          {day && followUp ? `, and that you asked to know by ${followUp}` : ''}. {name}'s Activity lists it.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <Button variant="primary" size="xl" disabled={!title.trim() || busy} onClick={() => void save()}>
          {edit ? 'Save' : `Assign to ${name}`}
        </Button>
      </div>
    </Sheet>
  );
}
