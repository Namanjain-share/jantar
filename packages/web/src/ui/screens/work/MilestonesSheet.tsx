/**
 * 0.13.0 A project's milestones (design 4.1, 14.3): a sheet of its own,
 * loaded on first use from the project's page (ProjectHub.tsx).
 *
 *   Milestones
 *   [Design            ] [2026-02-01] ☑ ↑ ↓ ✕    named, a target day if he
 *   [Beta              ] [          ] ☐ ↑ ↓ ✕    likes, done or not
 *   + Add a milestone                            twelve at most
 *
 * Moving one takes ↑ and ↓ (44 on touch), never a drag. Save sends the
 * whole list in its order (`PUT /v1/work/projects/:id/milestones`; a kept
 * one by its id, a new one without); removing them all clears them. A
 * target day is a day in the Life zone, as a todo's is.
 */
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useId, useState, type FormEvent } from 'react';
import type { WorkMilestone, WorkMilestonesBody } from '@jantar/protocol/work';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import { SaveError } from './parts.js';

/** A project's milestones at most (WORK_LIMITS.milestones, as a number: the chunk carries no schema). */
export const MILESTONES_MAX = 12;
/** A milestone's name at most. */
const NAME_MAX = 60;

export interface MilestoneDraft {
  /** A kept milestone's id; none for a new one. */
  id?: string | undefined;
  name: string;
  /** Its target day ('' for none). */
  target: string;
  done: boolean;
}

/** What Save sends for the edited list, or why it can't (one sentence). */
export function milestonesPlan(rows: readonly MilestoneDraft[]): { ok: true; body: WorkMilestonesBody } | { ok: false; problem: string } {
  if (rows.length > MILESTONES_MAX) return { ok: false, problem: 'Twelve milestones at most.' };
  const milestones: WorkMilestonesBody['milestones'] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!name || name.length > NAME_MAX) return { ok: false, problem: 'Every milestone needs a name of up to 60 characters.' };
    if (r.target && !/^\d{4}-\d{2}-\d{2}$/.test(r.target)) return { ok: false, problem: 'A target day is a date, or none.' };
    milestones.push({ ...(r.id ? { id: r.id } : {}), name, ...(r.target ? { target: r.target } : {}), ...(r.done ? { done: true } : {}) });
  }
  return { ok: true, body: { milestones } };
}

export interface MilestonesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  projectId: string;
  items: readonly WorkMilestone[];
  onSaved: () => void;
}

export function MilestonesSheet({ open, onOpenChange, sheetKey, projectId, items, onSaved }: MilestonesSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Milestones">
      {open ? <MilestonesForm key={sheetKey} projectId={projectId} items={items} onDone={() => onOpenChange(false)} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

interface Row extends MilestoneDraft {
  /** Keys the row while it moves (a new one has no id yet). */
  key: string;
}

function MilestonesForm({ projectId, items, onDone, onSaved }: { projectId: string; items: readonly WorkMilestone[]; onDone: () => void; onSaved: () => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const write = useWrite();
  const id = useId();
  const [added, setAdded] = useState(0);
  const blank = (n: number): Row => ({ key: `new-${n}`, name: '', target: '', done: false });
  // None yet: one empty row to type into.
  const [rows, setRows] = useState<Row[]>(() => (items.length ? items.map((m) => ({ key: m.id, id: m.id, name: m.name, target: m.target ?? '', done: m.done === true })) : [blank(0)]));
  const plan = milestonesPlan(rows);

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const shift = (key: string, by: -1 | 1) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const add = () => {
    const n = added + 1;
    setAdded(n);
    setRows((rs) => [...rs, blank(n)]);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!plan.ok || write.busy || offline) return;
    const body = plan.body;
    const r = await write.run(JSON.stringify(body), (key) => workClient(api).milestones(projectId, body, key));
    if (!r.ok) return;
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Milestones">
      {rows.length === 0 ? <p className="py-8 type-small text-ink-2">No milestones. Save to clear them.</p> : null}
      <ol aria-label="The milestones, in order">
        {rows.map((r, i) => {
          const label = r.name.trim() || `milestone ${i + 1}`;
          return (
            <li key={r.key} data-milestone={r.id ?? 'new'} className="flex flex-wrap items-center gap-x-4 gap-y-6 border-b border-line py-8">
              <label className="sr-only" htmlFor={`${id}-${r.key}`}>
                Milestone {i + 1}
              </label>
              <input
                id={`${id}-${r.key}`}
                className={`${INPUT} min-w-160 flex-1`}
                value={r.name}
                maxLength={NAME_MAX}
                autoComplete="off"
                placeholder="Design signed off"
                onChange={(e) => set(r.key, { name: e.target.value })}
              />
              <div className="flex items-center gap-4">
                <label className="sr-only" htmlFor={`${id}-${r.key}-t`}>
                  Target day of {label}
                </label>
                <input id={`${id}-${r.key}-t`} type="date" className={`${INPUT} w-160`} value={r.target} onChange={(e) => set(r.key, { target: e.target.value })} />
                <label className="inline-flex size-28 flex-none cursor-pointer items-center justify-center coarse:size-44" title="Done">
                  <input type="checkbox" aria-label={`${label} done`} className="size-20 accent-ink" checked={r.done} onChange={(e) => set(r.key, { done: e.target.checked })} />
                </label>
                <IconButton aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => shift(r.key, -1)}>
                  <ArrowUpIcon size={16} aria-hidden="true" />
                </IconButton>
                <IconButton aria-label={`Move ${label} down`} disabled={i === rows.length - 1} onClick={() => shift(r.key, 1)}>
                  <ArrowDownIcon size={16} aria-hidden="true" />
                </IconButton>
                <IconButton aria-label={`Remove ${label}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  <XIcon size={16} aria-hidden="true" />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ol>
      {rows.length < MILESTONES_MAX ? (
        <div className="pt-8">
          <Button variant="text" className="coarse:min-h-44" onClick={add}>
            <PlusIcon size={16} aria-hidden="true" />
            Add a milestone
          </Button>
        </div>
      ) : (
        <p className="pt-8 type-small text-ink-3">Twelve is the most a project has.</p>
      )}
      {!plan.ok ? <p className="mt-8 type-small text-ink-2">{plan.problem}</p> : null}
      {write.error ? <SaveError error={write.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!plan.ok || write.busy || offline}>
          {write.busy ? <Spinner label="Saving" /> : null}
          Save milestones
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
