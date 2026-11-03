/**
 * v0.12 People (P4, spec 5): the cafés and lists she shares with {owner}
 * (`/p/lists?tab=cafes|lists`), a lazy screen. Both are both people's:
 *
 * - Cafés: every shared café with its stars, who added it, "Edited by" and
 *   its visits ("You" or {owner}); she adds (always shared), rates, notes
 *   and logs her own visits; she deletes only her own visits; deleting a
 *   café is a Confirm ("Delete Blue Door for both of you?").
 * - Lists: shopping, to watch, to read and plain lists; tick circles with
 *   "Ticked by {owner} · 18:20"; add, rename; deleting a list is a Confirm.
 */
import type { Place, PlaceDetail } from '@jantar/protocol';
import type { PersonMe, SharedItem, SharedItemsResponse, SharedList, SharedListKind } from '@jantar/protocol/people';
import { SHARED_LIST_KINDS } from '@jantar/protocol/people-core';
import { useCallback, useEffect, useState } from 'react';
import { hmOf } from '../../people-shared/time.js';
import { Button } from '../../ui/kit/Button.js';
import type { PersonApi } from '../api.js';
import { navigate } from '../nav.js';
import { Field, Sheet, Tick } from '../ui.js';

type Tab = 'cafes' | 'lists';

export default function Lists({ me, api, tab, id, list, tick }: { me: PersonMe; api: PersonApi; tab: Tab; id: string | null; list: string | null; tick: number }) {
  const owner = me.owner.name;
  return (
    <div className="flex flex-col gap-12">
      <h1 className="text-title font-semibold">Shared with {owner}</h1>
      <div role="tablist" className="flex gap-8 border-b border-line">
        {(['cafes', 'lists'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => navigate(`/p/lists?tab=${t}`)} className={`min-h-44 px-12 text-row ${tab === t ? 'border-b-2 border-ink font-medium text-ink' : 'text-ink-2'}`}>
            {t === 'cafes' ? 'Cafés' : 'Lists'}
          </button>
        ))}
      </div>
      {tab === 'cafes' ? (id ? <Cafe api={api} me={me} id={id} tick={tick} /> : <Cafes api={api} me={me} tick={tick} />) : list ? <ListView api={api} me={me} id={list} tick={tick} /> : <AllLists api={api} tick={tick} />}
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => void fn().then(setData, (e: Error) => setError(e.message)), deps);
  useEffect(() => reload(), [reload]);
  return { data, error, reload };
}

const whoName = (by: string | undefined, me: PersonMe) => (by === me.person.id ? 'you' : by === '' ? me.owner.name : 'someone');

function Cafes({ api, me, tick }: { api: PersonApi; me: PersonMe; tick: number }) {
  const r = useLoad(() => api.places(), [api, tick]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    try {
      await api.placeCreate(name.trim());
      setName('');
      setAdding(false);
      r.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!r.data) return <p className="text-ink-2">{r.error ?? 'Loading…'}</p>;
  return (
    <div className="flex flex-col gap-8">
      <Button onClick={() => setAdding(true)}>Add a café</Button>
      {r.data.places.length === 0 ? <p className="text-row text-ink-2">No shared cafés yet.</p> : null}
      <ul className="flex flex-col">
        {r.data.places.map((p) => (
          <li key={p.id} className="border-b border-line">
            <button type="button" onClick={() => navigate(`/p/lists?tab=cafes&id=${p.id}`)} className="flex min-h-44 w-full flex-col items-start py-8 text-left">
              <span className="text-row font-medium text-ink">
                {p.name}
                {p.stars ? ` · ${'★'.repeat(p.stars)}` : ''}
              </span>
              <span className="text-small text-ink-2">
                Added by {whoName(p.by, me)} · {p.visits.count} visit{p.visits.count === 1 ? '' : 's'}
                {p.editedBy !== undefined && p.editedAt ? ` · Edited by ${whoName(p.editedBy, me)}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Sheet open={adding} onOpenChange={setAdding} title="Add a café">
        <div className="flex flex-col gap-12 pb-24">
          <p className="text-small text-ink-2">It's shared with {me.owner.name}.</p>
          <Field label="Name" value={name} onChange={setName} max={80} />
          {error ? <p role="alert" className="text-small text-ink">{error}</p> : null}
          <Button onClick={() => void add()} disabled={!name.trim()}>
            Add
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function Cafe({ api, me, id, tick }: { api: PersonApi; me: PersonMe; id: string; tick: number }) {
  const r = useLoad<PlaceDetail>(() => api.place(id), [api, id, tick]);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      r.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!r.data) return <p className="text-ink-2">{r.error ?? 'Loading…'}</p>;
  const p: Place = r.data.place;
  return (
    <div className="flex flex-col gap-12">
      <Button variant="text" onClick={() => navigate('/p/lists?tab=cafes')}>
        ‹ Cafés
      </Button>
      <h2 className="text-row font-semibold">{p.name}</h2>
      <p className="text-small text-ink-2">
        Added by {whoName(p.by, me)}
        {p.editedBy !== undefined && p.editedAt ? ` · Edited by ${whoName(p.editedBy, me)} · ${p.editedAt.slice(0, 10)}` : ''}
      </p>
      {p.notes ? <p className="whitespace-pre-wrap break-words text-row text-ink [overflow-wrap:anywhere]">{p.notes}</p> : null}
      <div role="group" aria-label="Stars" className="flex gap-4">
        {[1, 2, 3, 4, 5].map((n) => (
          <Button key={n} variant={p.stars === n ? 'primary' : 'text'} onClick={() => void run(() => api.placeUpdate(id, { stars: n }))}>
            {`${n}★`}
          </Button>
        ))}
      </div>
      <Field label="Log a visit (a note, optional)" value={note} onChange={setNote} max={500} />
      <Button onClick={() => void run(async () => (await api.visitCreate(id, note.trim() ? { notes: note.trim() } : {}), setNote('')))}>Log my visit</Button>
      <ul className="flex flex-col">
        {r.data.visits.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-8 border-b border-line py-8 text-small">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {v.day} · {v.by === me.person.id ? 'You' : me.owner.name}
              {v.notes ? ` · ${v.notes}` : ''}
            </span>
            {v.by === me.person.id ? (
              <Button variant="text" onClick={() => void run(() => api.visitDelete(id, v.id))}>
                Delete
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="text-small text-ink">{error}</p> : null}
      <Button variant="text" onClick={() => setConfirm(true)}>
        Delete café
      </Button>
      <Sheet open={confirm} onOpenChange={setConfirm} title={`Delete ${p.name} for both of you?`}>
        <div className="flex gap-8 pb-24">
          <Button onClick={() => void run(async () => (await api.placeDelete(id), navigate('/p/lists?tab=cafes')))}>Delete</Button>
          <Button variant="text" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function AllLists({ api, tick }: { api: PersonApi; tick: number }) {
  const r = useLoad(() => api.lists(), [api, tick]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SharedListKind>('shopping');
  const add = async () => {
    const made = await api.listCreate(name.trim(), kind);
    setAdding(false);
    setName('');
    navigate(`/p/lists?tab=lists&list=${made.id}`);
  };
  if (!r.data) return <p className="text-ink-2">{r.error ?? 'Loading…'}</p>;
  return (
    <div className="flex flex-col gap-8">
      <Button onClick={() => setAdding(true)}>New list</Button>
      {r.data.lists.length === 0 ? <p className="text-row text-ink-2">No shared lists yet.</p> : null}
      <ul className="flex flex-col">
        {r.data.lists.map((l: SharedList) => (
          <li key={l.id} className="border-b border-line">
            <button type="button" onClick={() => navigate(`/p/lists?tab=lists&list=${l.id}`)} className="flex min-h-44 w-full items-center justify-between py-8 text-left text-row">
              <span className="font-medium text-ink">{l.name}</span>
              <span className="text-small text-ink-2">
                {SHARED_LIST_KINDS[l.kind]} · {l.open} open
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Sheet open={adding} onOpenChange={setAdding} title="New list">
        <div className="flex flex-col gap-12 pb-24">
          <Field label="Name" value={name} onChange={setName} max={60} />
          <div role="group" aria-label="Kind" className="flex flex-wrap gap-4">
            {(Object.keys(SHARED_LIST_KINDS) as SharedListKind[]).map((k) => (
              <Button key={k} variant={kind === k ? 'primary' : 'text'} onClick={() => setKind(k)}>
                {SHARED_LIST_KINDS[k]}
              </Button>
            ))}
          </div>
          <Button onClick={() => void add()} disabled={!name.trim()}>
            Make the list
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function ListView({ api, me, id, tick }: { api: PersonApi; me: PersonMe; id: string; tick: number }) {
  const r = useLoad<SharedItemsResponse>(() => api.listItems(id), [api, id, tick]);
  const [title, setTitle] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      r.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!r.data) return <p className="text-ink-2">{r.error ?? 'Loading…'}</p>;
  const { list, items } = r.data;
  const ticked = (it: SharedItem) => (it.handed ? `Assigned to ${it.handed.to === me.person.id ? 'you' : 'someone'}` : it.doneAt ? `Ticked by ${whoName(it.doneBy, me)} · ${hmOf(it.doneAt)}` : null);
  return (
    <div className="flex flex-col gap-12">
      <Button variant="text" onClick={() => navigate('/p/lists?tab=lists')}>
        ‹ Lists
      </Button>
      <div className="flex items-center justify-between gap-8">
        <h2 className="text-row font-semibold">{list.name}</h2>
        <Button variant="text" onClick={() => setRename(list.name)}>
          Rename
        </Button>
      </div>
      <div className="flex gap-8">
        <div className="flex-1">
          <Field label="Add an item" value={title} onChange={setTitle} max={200} />
        </div>
        <Button onClick={() => void run(async () => (await api.listItemAdd(id, title.trim()), setTitle('')))} disabled={!title.trim()}>
          Add
        </Button>
      </div>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-8 border-b border-line py-8">
            <Tick done={Boolean(it.doneAt)} label={it.title} onClick={() => void run(() => api.listItemTick(id, it.id, !it.doneAt))} />
            <span className="min-w-0 flex-1">
              <span className={`block break-words text-row [overflow-wrap:anywhere] ${it.doneAt ? 'text-ink-2 line-through' : 'text-ink'}`}>{it.title}</span>
              {ticked(it) ? <span className="block text-small text-ink-2">{ticked(it)}</span> : null}
            </span>
            <Button variant="text" aria-label={`Delete ${it.title}`} onClick={() => void run(() => api.listItemDelete(id, it.id))}>
              ×
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="text-small text-ink">{error}</p> : null}
      <Button variant="text" onClick={() => setConfirm(true)}>
        Delete list
      </Button>
      <Sheet open={rename !== null} onOpenChange={(o) => !o && setRename(null)} title="Rename list">
        <div className="flex flex-col gap-12 pb-24">
          <Field label="Name" value={rename ?? ''} onChange={setRename} max={60} />
          <Button onClick={() => void run(async () => (await api.listRename(id, (rename ?? '').trim()), setRename(null)))} disabled={!(rename ?? '').trim()}>
            Save
          </Button>
        </div>
      </Sheet>
      <Sheet open={confirm} onOpenChange={setConfirm} title={`Delete ${list.name} for both of you?`}>
        <div className="flex gap-8 pb-24">
          <Button onClick={() => void run(async () => (await api.listDelete(id), navigate('/p/lists?tab=lists')))}>Delete</Button>
          <Button variant="text" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
