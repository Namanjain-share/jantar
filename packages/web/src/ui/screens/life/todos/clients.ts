/**
 * 0.13.0 Follow-ups (Work, design 7 and W11): a follow-up is an ordinary
 * todo with a client. While Work is on, the todo screens name each one's
 * client on its row (`GET /v1/work/clients/names`, ids only in the URL)
 * and, once the todo sheet opens, list his clients for its Client field
 * (`GET /v1/work/clients`). Nothing here reads Work's tables: the Mac
 * answers both, and Work's own client (screens/work/client.ts) asks.
 * While Work is off nothing is asked and the sheet has no Client field.
 */
import { useMemo } from 'react';
import type { Todo } from '@jantar/protocol';
import { useDeps } from '../../../context.js';
import { workClient } from '../../work/client.js';
import { useLifeLoad, useLifeStatus } from '../shared/useLife.js';

export interface TodoClients {
  /** The client's name on a follow-up's row (none: not a follow-up, or not known yet). */
  name(todo: Todo): string | undefined;
  /** The todo sheet's Client choices while it is open and Work is on; undefined: no Client field. */
  pick: readonly { id: string; name: string }[] | undefined;
}

/** `known`: names the screen has already (Today's answer carries its follow-ups' clients). */
export function useTodoClients(todos: readonly Todo[], sheetOpen: boolean, known: readonly { id: string; name: string }[] = []): TodoClients {
  const { api } = useDeps();
  const { status } = useLifeStatus();
  const on = Boolean(status?.modules.work);
  const have = useMemo(() => new Map(known.map((c) => [c.id, c.name])), [known]);
  const ids = useMemo(() => [...new Set(todos.flatMap((t) => (t.contactId && !have.has(t.contactId) ? [t.contactId] : [])))].sort().slice(0, 100), [todos, have]);
  const names = useLifeLoad(on && ids.length ? `work:names:${ids.join(',')}` : null, () => workClient(api).clientNames(ids));
  const pick = useLifeLoad(on && sheetOpen ? 'work:clients:pick' : null, () => workClient(api).clients({ sort: 'name' }));
  return useMemo(() => {
    const all = new Map(have);
    for (const c of names.data?.clients ?? []) all.set(c.id, c.name);
    return {
      name: (t: Todo) => (t.contactId ? all.get(t.contactId) : undefined),
      pick: on ? (pick.data?.clients ?? []).map((c) => ({ id: c.id, name: c.company ? `${c.name} · ${c.company.name}` : c.name })) : undefined,
    };
  }, [have, names.data, pick.data, on]);
}
