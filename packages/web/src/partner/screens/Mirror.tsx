/**
 * v0.12 People: "See what {owner} sees" (`/p/me?tab=sharing&see=<area>`,
 * spec 8.4). It reads her mirror (`GET /v1/p/mirror/:area`), which the
 * daemon builds with the same function and her live agreement as his view,
 * and draws it with the components his Partner screen uses (people-shared:
 * the plan, the review list, the sleep week, journal entries, chat turns).
 * Opening it leaves no view mark; it writes nothing.
 */
import type { JournalList, OwnerChatView, OwnerTodosView, PersonMe, PersonToday, PersonWeightsResponse, PlanView, ReviewView, SleepWeek as Week } from '@jantar/protocol/people';
import { STATUS_LABELS } from '@jantar/protocol/people-core';
import { useEffect, useState } from 'react';
import { ChatRead } from '../../people-shared/ChatRead.js';
import { JournalEntryCard } from '../../people-shared/JournalEntryCard.js';
import { PlanRead } from '../../people-shared/PlanRead.js';
import { ReviewList } from '../../people-shared/ReviewList.js';
import { SleepWeek } from '../../people-shared/SleepWeek.js';
import { dayLabel, hmOf } from '../../people-shared/time.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';

const TITLE: Record<string, string> = {
  today: 'Today',
  todos: 'your to-dos and reminders',
  weight: 'your weight',
  plan: 'your day plan',
  review: 'your evening review',
  sleep: 'your sleep',
  journal: 'your journal',
  chat: 'your chats with your assistant',
};

const isLocked = (v: unknown): v is { locked: true } => typeof v === 'object' && v !== null && 'locked' in v;

function Off({ owner }: { owner: string }) {
  return <p className="mt-12 rounded-btn bg-hover px-12 py-12 text-ink-2">{owner} sees nothing of this: it is switched off.</p>;
}

export default function Mirror({ me, api, area }: { me: PersonMe; api: PersonApi; area: string }) {
  const owner = me.owner.name;
  const name = me.person.name;
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api.mirror(area).then(setData, (e: Error) => setError(e.message));
  }, [api, area]);
  return (
    <div>
      <a
        href="/p/me?tab=sharing"
        className="inline-flex min-h-44 items-center text-ink-2 underline"
        onClick={(e) => {
          e.preventDefault();
          navigate('/p/me?tab=sharing');
        }}
      >
        Back to Sharing
      </a>
      <h2 className="mt-8 font-semibold">
        {area === 'today' ? `${owner}'s Today of you` : `What ${owner} sees of ${TITLE[area] ?? area}`}
      </h2>
      <p className="text-small text-ink-2">Exactly what {owner} gets, live. Opening this leaves no mark in your Activity.</p>
      {error ? <p role="alert">{error}</p> : data === null ? <p className="mt-12 text-ink-2">Loading…</p> : isLocked(data) ? <Off owner={owner} /> : <Area area={area} data={data} owner={owner} name={name} />}
    </div>
  );
}

function Area({ area, data, owner, name }: { area: string; data: unknown; owner: string; name: string }) {
  switch (area) {
    case 'plan':
      return <PlanRead view={data as PlanView} name={name} />;
    case 'review':
      return <Review v={data as ReviewView} owner={owner} />;
    case 'sleep':
      return (
        <div className="mt-12">
          <SleepWeek week={data as Week} />
        </div>
      );
    case 'journal': {
      const l = data as JournalList;
      return l.entries.length ? (
        <ul className="mt-12 border-t border-line">
          {l.entries.map((e) => (
            <li key={e.id} className="border-b border-line">
              <p className="pt-8 text-small text-ink-3">{dayLabel(e.day)}</p>
              <JournalEntryCard e={e} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-12 text-ink-2">Nothing written yet.</p>
      );
    }
    case 'chat': {
      const v = data as OwnerChatView;
      return v.turns.length ? (
        <ul className="mt-12">
          {v.turns.map((t) => (
            <ChatRead key={t.id} turn={t} name={name} photoUrl={(id) => `/v1/p/chat/photos/${encodeURIComponent(id)}`} />
          ))}
        </ul>
      ) : (
        <p className="mt-12 text-ink-2">No messages.</p>
      );
    }
    case 'todos': {
      const v = data as OwnerTodosView;
      return v.todos.length ? (
        <ul className="mt-12 border-t border-line">
          {v.todos.map((t) => (
            <li key={t.id} className="border-b border-line py-8">
              <p className="break-words">{t.title}</p>
              <p className="text-small text-ink-2">
                {[t.due ? `${dayLabel(t.due.day)}${t.due.time ? ` ${t.due.time}` : ''}` : null, t.by === '' ? `from ${owner}` : 'yours', t.report ? `"${t.report}"` : null].filter(Boolean).join(' · ')}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-12 text-ink-2">No open to-dos.</p>
      );
    }
    case 'weight': {
      const v = data as PersonWeightsResponse;
      return <p className="mt-12">{v.latest ? `Latest: ${v.latest.kg} kg (${dayLabel(v.latest.day)})` : 'No weight logged.'}</p>;
    }
    case 'today':
      return <TodayOf t={data as PersonToday} owner={owner} name={name} />;
    default:
      return null;
  }
}

function Review({ v, owner }: { v: ReviewView; owner: string }) {
  if (v.level === 'counts') return <p className="mt-12">Evening review: {v.line}</p>;
  return (
    <section className="mt-12" aria-label="Evening review">
      <p className="text-small text-ink-2">
        {dayLabel(v.day)} · {v.line}
        {v.sent ? (v.at ? ` · sent ${hmOf(v.at)}` : '') : ' · not sent yet'}
      </p>
      <ReviewList items={v.items} owner={owner} />
      {v.note ? <p className="mt-8 whitespace-pre-wrap break-words">{v.note}</p> : null}
      {v.mood ? <p className="text-small text-ink-2">Mood {v.mood}/5</p> : null}
    </section>
  );
}

function TodayOf({ t, owner, name }: { t: PersonToday; owner: string; name: string }) {
  const line = [
    !isLocked(t.status) && t.status ? `${STATUS_LABELS[t.status.level]}${t.status.line ? ` "${t.status.line}"` : ''}` : null,
    !isLocked(t.sleep) && t.sleep.open ? `Asleep since ${hmOf(t.sleep.open.since)}` : null,
  ].filter(Boolean);
  return (
    <div className="mt-12 flex flex-col gap-8">
      {line.length ? <p>{line.join(' · ')}</p> : null}
      {t.concerns.length ? <p className="text-small text-ink-2">{t.concerns.join(' · ')}</p> : null}
      {isLocked(t.plan) ? <Off owner={owner} /> : <PlanRead view={t.plan} name={name} />}
      {t.review === null ? null : isLocked(t.review) ? null : <Review v={t.review} owner={owner} />}
      {isLocked(t.todos) ? null : (
        <p>
          To-dos due: {t.todos.due.length}
          {t.todos.overdue ? ` · overdue ${t.todos.overdue}` : ''}
        </p>
      )}
      {!isLocked(t.weight) && t.weight.latest ? <p>Weight {t.weight.latest.kg} kg</p> : null}
    </div>
  );
}
