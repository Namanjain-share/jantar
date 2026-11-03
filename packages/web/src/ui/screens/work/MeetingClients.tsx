/**
 * 0.13.0 A meeting's clients (W15, F10): the Clients field on a meeting's
 * page while Work is on. Meetings loads it lazily from Work's chunks, so
 * neither the Meetings chunk nor the main load carries Work.
 *
 *   CLIENTS
 *   Acme · through its project               Unlink     a project's client links by itself
 *   Northwind                                 Unlink     one he linked
 *   From the meeting: [Link Sam Sample] [Add Pat Example as a client]
 *   [Link another client…]
 *
 * The names under "From the meeting" are the meeting's people, words
 * someone else chose: nothing is linked or made without his tap, and a
 * client made from one is marked as a meeting's words (Chat frames it).
 * Unlink leaves a client out of the set (`PUT .../clients` replaces it);
 * an automatic link he unlinks stays unlinked. At most 8 clients.
 */
import { CaretRightIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useId, useMemo, useState } from 'react';
import type { WorkMeetingSuggestReply } from '@jantar/protocol/work';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { RailLabel } from '../../kit/RailLabel.js';
import { Link } from '../../shell/Link.js';
import { NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { INPUT, Loaded, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import { clientPath } from './clientModel.js';
import { FromTag } from './parts.js';

/** A meeting's clients at most (WORK_LIMITS.meetingClients). */
export const MEETING_CLIENTS_MAX = 8;

export function MeetingClients({ meetingId }: { meetingId: string }) {
  const { api } = useDeps();
  const w = useMemo(() => workClient(api), [api]);
  const offline = useOffline();
  const write = useWrite();
  const id = useId();
  const load = useLifeLoad<WorkMeetingSuggestReply>(`work:meeting:${meetingId}`, () => w.meetingSuggest(meetingId));
  const [picking, setPicking] = useState(false);
  const pick = useLifeLoad(picking ? 'work:clients:pick' : null, () => w.clients({ sort: 'name' }));

  // The key's signature is the whole set sent: a retry after a failure reuses the key only for the same body
  // (the daemon refuses one key with two bodies, 409, until the sheet reopens).
  const set = async (ids: string[]) => {
    const body = { clientIds: ids.slice(0, MEETING_CLIENTS_MAX) };
    const r = await write.run(`set:${body.clientIds.join()}`, (key) => w.meetingClients(meetingId, body, key));
    if (r.ok) load.reload();
    return r.ok;
  };
  const make = async (person: number) => {
    const r = await write.run(`new:${person}`, (key) => w.meetingClientNew(meetingId, { person }, key));
    if (r.ok) load.reload();
  };

  return (
    <section aria-label="Clients" className="mt-16">
      <RailLabel ground="bg">Clients</RailLabel>
      <Loaded load={load} count={1}>
        {(d) => {
          const linked = d.linked.map((c) => c.id);
          const full = linked.length >= MEETING_CLIENTS_MAX;
          const busy = offline || write.busy;
          const link = (cid: string) => void set([...linked, cid]);
          const people = d.people.filter((p) => !p.match || !linked.includes(p.match.id));
          const auto = d.auto && !linked.includes(d.auto.id) ? d.auto : null;
          const others = (pick.data?.clients ?? []).filter((c) => !linked.includes(c.id));
          return (
            <div className="px-16">
              {d.linked.length === 0 ? <p className="py-8 type-small text-ink-2">No client linked.</p> : null}
              <ul>
                {d.linked.map((c) => (
                  <li key={c.id} data-linked={c.id} className="flex min-h-44 items-center gap-8 border-b border-line">
                    <Link href={clientPath(c.id)} className="flex min-h-44 min-w-0 flex-1 items-center gap-6 hover:underline">
                      <span className="min-w-0 truncate type-row text-ink">{c.name}</span>
                      {c.auto ? <span className="flex-none type-mono text-ink-3">through its project</span> : null}
                      <CaretRightIcon size={12} aria-hidden="true" className="flex-none text-ink-3" />
                    </Link>
                    <IconButton aria-label={`Unlink ${c.name}`} disabled={busy} onClick={() => void set(linked.filter((x) => x !== c.id))}>
                      <XIcon size={16} aria-hidden="true" />
                    </IconButton>
                  </li>
                ))}
              </ul>
              {auto || people.length ? (
                <div className="mt-8">
                  <p className="flex items-center gap-8 type-small text-ink-3">
                    From the meeting <FromTag from="meeting" />
                  </p>
                  <div className="mt-6 flex flex-wrap gap-8">
                    {auto ? (
                      <Button size="sm" className="coarse:min-h-44" disabled={busy || full} onClick={() => link(auto.id)}>
                        Link {auto.name}
                      </Button>
                    ) : null}
                    {people.map((p) =>
                      p.match ? (
                        <Button key={p.index} size="sm" className="coarse:min-h-44" disabled={busy || full} onClick={() => link(p.match!.id)}>
                          Link {p.match.name}
                        </Button>
                      ) : (
                        <Button key={p.index} size="sm" className="coarse:min-h-44" disabled={busy || full} onClick={() => void make(p.index)}>
                          <PlusIcon size={14} aria-hidden="true" />
                          Add {p.text} as a client
                        </Button>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
              <div className="mt-8 pb-4">
                {picking ? (
                  <select
                    aria-label="Link a client"
                    className={INPUT}
                    id={`${id}-pick`}
                    value=""
                    disabled={busy || full}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setPicking(false);
                      link(e.target.value);
                    }}
                  >
                    <option value="">{pick.data ? 'Pick a client' : 'Loading…'}</option>
                    {others.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company ? `${c.name} · ${c.company.name}` : c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Button variant="text" size="sm" className="coarse:min-h-44" disabled={busy || full} onClick={() => setPicking(true)}>
                    Link another client…
                  </Button>
                )}
              </div>
              {write.error ? <NotSaved error={write.error} /> : null}
            </div>
          );
        }}
      </Loaded>
    </section>
  );
}
