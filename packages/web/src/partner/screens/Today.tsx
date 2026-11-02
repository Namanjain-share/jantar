/**
 * v0.12 People: her Today (P1 shell). A request for more sharing waits
 * here as a card with Allow and No thanks (it lists each field that would
 * change, in the join page's words). Her medicines, reminders and to-dos
 * due join this screen with their routes.
 */
import { fieldsChanged } from '@jantar/protocol/people-core';
import type { PersonMe, PersonOwnToday } from '@jantar/protocol/people';
import { useCallback, useEffect, useState } from 'react';
import { TodoRow } from './TodoRow.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { joinCopy } from '../join/copy.js';

export function Today({ me, api, reload, tick }: { me: PersonMe; api: PersonApi; reload: () => void; tick: number }) {
  const day = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const [today, setToday] = useState<PersonOwnToday | null>(null);
  const load = useCallback(() => api.today().then(setToday, () => setToday(null)), [api]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <div>
      <header className="flex items-baseline justify-between">
        <h1 className="text-title font-semibold">{day}</h1>
        <span className="text-small text-ink-2">{me.owner.name}</span>
      </header>
      {me.pending && me.agreement ? <ProposalCard me={me} api={api} reload={reload} /> : null}
      {today && today.todos.length > 0 ? (
        <section aria-label="Due today" className="mt-16">
          <h2 className="font-semibold">
            Reminders and to-dos{today.overdue > 0 ? ` · ${today.overdue} overdue` : ''}
          </h2>
          <ul className="divide-y divide-line">
            {today.todos.map((t) => (
              <TodoRow key={t.id} t={t} owner={me.owner.name} onDone={(d) => void api.done(t.id, d).then(load)} onAck={() => void api.ack(t.id).then(load)} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="mt-24 text-ink-2">Nothing due right now.</p>
      )}
    </div>
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
