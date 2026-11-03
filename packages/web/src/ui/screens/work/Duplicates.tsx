/**
 * 0.13.0 Duplicates and merging (design 5.3, P3b): its own chunk, loaded
 * the first time either sheet opens. Never in Chat.
 *
 * - Find duplicates (Clients' ···): the clients that may be one, in groups
 *   (`GET /v1/work/duplicates`: the same e-mail, phone or name, minus his
 *   "not a duplicate" rulings). In a group he picks the one to keep, then
 *   for each other one: Merge into it, or Not a duplicate (they stop
 *   showing together).
 * - Merge with… (a client's ···): the one to merge into this client,
 *   found by name among his clients of the same kind.
 *
 * The merge step reads the fields both hold differently
 * (`GET /v1/work/clients/:id/merge?loser=`) and keeps this client's unless
 * he picks the other's; it says what moves (deals, log, follow-ups,
 * projects and people), that phones, e-mails, links and tags are joined,
 * and that the other is hidden for good. An imported client passes its
 * mark on, so its words stay data. Two people or two companies only.
 *
 * Two with the same name are told apart wherever the sheet names them (its
 * Keep chips, the rows, the merge step, the toast): by their company and
 * state, then by their place in the group ("Riya Kapoor · Acme · lead").
 */
import { CaretRightIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import type { ContactKind, ContactState, WorkClientRow, WorkDuplicatesReply, WorkMergeConflictsReply } from '@jantar/protocol/work';
import { useDeps, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { LifeEmpty, NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { INPUT, Loaded, OfflineLine, SheetActions, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import { STATE_LABEL } from './clientModel.js';
import { Chips, FromTag } from './parts.js';

interface Who {
  id: string;
  /** As the sheet names it: its name, with what tells it apart from another of the same name. */
  name: string;
  kind: ContactKind;
  from?: 'import' | 'meeting' | undefined;
}

interface Named {
  id: string;
  name: string;
  state: ContactState;
  company?: { name: string } | undefined;
}

/**
 * Each client's name as the sheet says it: alone when no other in `clients` has it; else with its company and
 * state ("Riya Kapoor · Acme · lead"), and, while that is still the same, its place among them ("(2)").
 */
export function namesApart(clients: readonly Named[]): Map<string, string> {
  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
  const told = clients.map((c) =>
    clients.filter((o) => same(o.name, c.name)).length > 1 ? [c.name, c.company?.name, STATE_LABEL[c.state].toLowerCase()].filter(Boolean).join(' · ') : c.name,
  );
  return new Map(
    clients.map((c, i) => {
      const twins = told.filter((t) => same(t, told[i]!)).length;
      const nth = told.slice(0, i + 1).filter((t) => same(t, told[i]!)).length;
      return [c.id, twins > 1 ? `${told[i]} (${nth})` : told[i]!];
    }),
  );
}

const WHY = { email: 'same e-mail', phone: 'same phone', name: 'same name' } as const;

export interface DuplicatesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  onChanged: () => void;
}

export function DuplicatesSheet({ open, onOpenChange, sheetKey, onChanged }: DuplicatesSheetProps) {
  const [merging, setMerging] = useState<{ keep: Who; loser: Who } | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={merging ? `Merge into ${merging.keep.name}` : 'Possible duplicates'}>
      {!open ? null : merging ? (
        <MergeStep
          key={`${merging.keep.id}:${merging.loser.id}`}
          keep={merging.keep}
          loser={merging.loser}
          onBack={() => setMerging(null)}
          onMerged={() => {
            setMerging(null);
            onChanged();
          }}
        />
      ) : (
        <Groups key={sheetKey} onMerge={(keep, loser) => setMerging({ keep, loser })} onChanged={onChanged} />
      )}
    </Sheet>
  );
}

function Groups({ onMerge, onChanged }: { onMerge: (keep: Who, loser: Who) => void; onChanged: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const load = useLifeLoad<WorkDuplicatesReply>('work:duplicates', () => workClient(api).duplicates());
  // The one kept in each group (its first by default).
  const [kept, setKept] = useState<ReadonlyMap<string, string>>(new Map());
  const apart = async (keep: Who, other: Who) => {
    const r = await w.run(`apart:${keep.id}:${other.id}`, (key) => workClient(api).notDuplicate(keep.id, other.id, key));
    if (!r.ok) return;
    load.reload();
    onChanged();
  };
  return (
    <div>
      <Loaded load={load} count={3}>
        {(d) =>
          d.groups.length === 0 ? (
            <LifeEmpty className="px-0">No possible duplicates.</LifeEmpty>
          ) : (
            <ul aria-label="Possible duplicates">
              {d.groups.map((g) => {
                const keepId = kept.get(g.key) ?? g.clients[0]!.id;
                const keep = g.clients.find((c) => c.id === keepId) ?? g.clients[0]!;
                const names = namesApart(g.clients);
                const who = (c: (typeof g.clients)[number]): Who => ({ id: c.id, name: names.get(c.id) ?? c.name, kind: c.kind, from: c.from });
                return (
                  <li key={g.key} data-group={g.key} className="border-b border-line py-12">
                    <p className="type-mono text-ink-3">{g.reasons.map((r) => WHY[r]).join(' · ')}</p>
                    <Chips<string>
                      label="Keep"
                      className="mt-8"
                      chips={g.clients.map((c) => ({ key: c.id, label: `Keep ${names.get(c.id) ?? c.name}` }))}
                      value={keep.id}
                      onChange={(k) => k && setKept((m) => new Map(m).set(g.key, k))}
                    />
                    <ul className="mt-8">
                      {g.clients
                        .filter((c) => c.id !== keep.id)
                        .map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-8 py-4">
                            {/* The name on a line of its own: beside the buttons a 390 phone cut it to "Riya Ka…". */}
                            <span className="min-w-0 basis-full truncate type-row text-ink">
                              {c.name}
                              <span className="text-ink-2">
                                {c.company ? ` · ${c.company.name}` : ''} · {STATE_LABEL[c.state].toLowerCase()}
                              </span>
                            </span>
                            <FromTag from={c.from} />
                            <Button size="sm" className="coarse:min-h-44" disabled={offline || w.busy || c.kind !== keep.kind} onClick={() => onMerge(who(keep), who(c))}>
                              Merge into {who(keep).name}
                            </Button>
                            <Button variant="text" size="sm" className="coarse:min-h-44" disabled={offline || w.busy} onClick={() => void apart(who(keep), who(c))}>
                              Not a duplicate
                            </Button>
                          </li>
                        ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
      {w.error ? <NotSaved error={w.error} /> : null}
      {offline ? <OfflineLine className="mt-8" /> : null}
    </div>
  );
}

export interface MergeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** The client the other merges into (its page's), with its state and company to tell it from one of the same name. */
  keep: Who & { state: ContactState; company?: { name: string } | undefined };
  onMerged: () => void;
}

/** "Merge with…" from a client's page: find the other by name, then the merge step. */
export function MergeSheet({ open, onOpenChange, sheetKey, keep, onMerged }: MergeSheetProps) {
  const [picked, setPicked] = useState<{ loser: Who; keepName: string } | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`Merge into ${keep.name}`}>
      {!open ? null : picked ? (
        <MergeStep
          key={picked.loser.id}
          keep={{ ...keep, name: picked.keepName }}
          loser={picked.loser}
          onBack={() => setPicked(null)}
          onMerged={() => {
            onMerged();
            onOpenChange(false);
          }}
        />
      ) : (
        <Pick
          key={sheetKey}
          keep={keep}
          onPick={(c) => {
            // The same name: each said with its company and state, in the merge step and its toast.
            const names = namesApart([keep, c]);
            setPicked({ loser: { id: c.id, name: names.get(c.id) ?? c.name, kind: c.kind, from: c.from }, keepName: names.get(keep.id) ?? keep.name });
          }}
        />
      )}
    </Sheet>
  );
}

function Pick({ keep, onPick }: { keep: Who; onPick: (c: WorkClientRow) => void }) {
  const { api } = useDeps();
  const [q, setQ] = useState('');
  const query = q.trim();
  const load = useLifeLoad(query.length >= 1 ? `work:merge-pick:${keep.kind}:${query}` : null, () => workClient(api).clients({ q: query, kind: keep.kind, sort: 'name' }));
  const rows = (load.data?.clients ?? []).filter((c) => c.id !== keep.id).slice(0, 20);
  return (
    <div>
      <p className="type-small text-ink-2">{keep.kind === 'company' ? 'The company to merge into this one.' : 'The person to merge into this one.'}</p>
      <input aria-label="Find a client" type="search" className={`${INPUT} mt-8`} value={q} maxLength={80} autoComplete="off" placeholder="Name, e-mail or phone" onChange={(e) => setQ(e.target.value)} />
      {query ? (
        <Loaded load={load} count={2}>
          {() =>
            rows.length === 0 ? (
              <LifeEmpty className="px-0">No other client matches.</LifeEmpty>
            ) : (
              <ul aria-label="Clients to merge" className="mt-8">
                {rows.map((c) => (
                  <li key={c.id} className="border-b border-line">
                    <button type="button" onClick={() => onPick(c)} className="flex min-h-44 w-full items-center gap-8 text-left hover:bg-hover">
                      <span className="min-w-0 flex-1 truncate type-row text-ink">
                        {c.name}
                        {c.company ? <span className="text-ink-2"> · {c.company.name}</span> : null}
                      </span>
                      <FromTag from={c.from} />
                      <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      ) : null}
    </div>
  );
}

/** The fields both hold differently (this client's kept unless he picks the other's), what moves, and Merge. */
function MergeStep({ keep, loser, onBack, onMerged }: { keep: Who; loser: Who; onBack: () => void; onMerged: () => void }) {
  const { api } = useDeps();
  const toast = useToast();
  const offline = useOffline();
  const w = useWrite();
  const load = useLifeLoad<WorkMergeConflictsReply>(`work:merge:${keep.id}:${loser.id}`, () => workClient(api).mergeConflicts(keep.id, loser.id));
  const [picks, setPicks] = useState<ReadonlySet<string>>(new Set());
  const conflicts = useMemo(() => load.data?.conflicts ?? [], [load.data]);
  const merge = async () => {
    const body = { loserId: loser.id, ...(picks.size ? { picks: conflicts.filter((c) => picks.has(c.field)).map((c) => c.field) } : {}) };
    const r = await w.run(`merge:${JSON.stringify(body)}`, (key) => workClient(api).merge(keep.id, body, key));
    if (!r.ok) return;
    toast(`Merged ${loser.name} into ${keep.name}.`);
    onMerged();
  };
  return (
    <div>
      <p className="type-small text-ink-2">
        {loser.name}&apos;s deals, log, follow-ups, projects and people move to {keep.name}. Phones, e-mails, links and tags are joined. {loser.name} is hidden for good.
      </p>
      {loser.from ? (
        <p className="mt-4 flex items-center gap-8 type-small text-ink-2">
          <FromTag from={loser.from} />
          {keep.name} takes this mark too: its words stay data.
        </p>
      ) : null}
      <Loaded load={load} count={2}>
        {() =>
          conflicts.length === 0 ? (
            <p className="mt-8 type-small text-ink-2">No field differs: {keep.name} keeps its own and takes what it lacks.</p>
          ) : (
            <ul aria-label="Fields that differ" className="mt-8">
              {conflicts.map((c) => (
                <li key={c.field} className="border-b border-line py-8">
                  <p className="type-small text-ink-3">{c.label}</p>
                  <Chips<'keep' | 'other'>
                    label={c.label}
                    className="mt-4"
                    chips={[
                      { key: 'keep', label: c.survivor || 'None' },
                      { key: 'other', label: c.loser || 'None' },
                    ]}
                    value={picks.has(c.field) ? 'other' : 'keep'}
                    onChange={(k) =>
                      setPicks((s) => {
                        const n = new Set(s);
                        if (k === 'other') n.add(c.field);
                        else n.delete(c.field);
                        return n;
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button variant="primary" size="lg" className="flex-1" disabled={offline || w.busy || !load.data} onClick={() => void merge()}>
          {w.busy ? <Spinner label="Merging" /> : null}
          Merge
        </Button>
        <Button variant="text" size="lg" onClick={onBack}>
          Back
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </div>
  );
}
