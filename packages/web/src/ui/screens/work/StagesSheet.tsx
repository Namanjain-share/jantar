/**
 * 0.13.0 Edit the deal stages (design 5.3, W10), from Deals' ···: a chunk
 * of its own, loaded on first use.
 *
 *   Stages
 *   [New lead      ] ↑ ↓ ✕     an open stage: renamed, moved, removed;
 *     Probability [20] %  Quiet after [14] days    its own, or empty for the ramp and Work's days
 *   [Won           ] ↑ ↓       Won and Lost: renamed and moved, never removed
 *   + Add a stage               a new open stage, before Won
 *   REMOVED
 *   Contacted · 4 deals  Move them to [New lead ▾]
 *
 * Three to twelve stages, exactly one Won and one Lost. A removed stage that
 * holds deals needs an open stage for them; they keep their days in stage
 * (a re-file, not a move). Moving a stage takes ↑ and ↓ (44 on touch), never
 * a drag. Save sends the whole list (`PUT /v1/work/stages`).
 */
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { WorkStagesReply } from '@jantar/protocol/work';
import { useDeps, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { Tag } from '../../kit/Tag.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Field, INPUT, Loaded, OfflineLine, SheetActions, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import { stagesPlan, type StageDraft } from './dealModel.js';
import { SaveError } from './parts.js';

export interface StagesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  onSaved: () => void;
}

export function StagesSheet({ open, onOpenChange, sheetKey, onSaved }: StagesSheetProps) {
  const { api } = useDeps();
  const load = useLifeLoad<WorkStagesReply>(open ? `work:stages:${sheetKey}` : null, () => workClient(api).stages());
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Stages">
      {open ? <Loaded load={load} count={3}>{(d) => <StagesForm key={sheetKey} reply={d} onDone={() => onOpenChange(false)} onSaved={onSaved} />}</Loaded> : null}
    </Sheet>
  );
}

interface Row extends StageDraft {
  /** Keys the row while it moves (a new stage has no id yet). */
  key: string;
  /** Its effective probability, shown as the field's hint. */
  ramp?: number | undefined;
}

function StagesForm({ reply, onDone, onSaved }: { reply: WorkStagesReply; onDone: () => void; onSaved: () => void }) {
  const { api } = useDeps();
  const toast = useToast();
  const offline = useOffline();
  const write = useWrite();
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    reply.stages.map((s) => ({
      key: s.id,
      id: s.id,
      name: s.name,
      kind: s.kind,
      deals: s.deals,
      probability: s.probability !== undefined ? String(s.probability) : '',
      quietDays: s.quietDays !== undefined ? String(s.quietDays) : '',
      ramp: s.effectiveProbability,
    })),
  );
  const [added, setAdded] = useState(0);
  // A removed stage with deals: where they go (an open stage kept from before).
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const removed = useMemo(() => reply.stages.filter((s) => !rows.some((r) => r.id === s.id)), [reply.stages, rows]);
  const targets = rows.filter((r) => r.kind === 'open' && r.id);
  const plan = stagesPlan(
    rows,
    removed.map((s) => ({ id: s.id, deals: s.deals, moveTo: moveTo[s.id] ?? targets[0]?.id ?? '' })),
  );

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
  const addStage = () => {
    const n = added + 1;
    setAdded(n);
    setRows((rs) => {
      // A new open stage goes before Won, so the pipeline still ends in Won and Lost.
      const at = rs.findIndex((r) => r.kind !== 'open');
      const row: Row = { key: `new-${n}`, name: '', kind: 'open', deals: 0, probability: '', quietDays: '' };
      return at < 0 ? [...rs, row] : [...rs.slice(0, at), row, ...rs.slice(at)];
    });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!plan.ok || !plan.body || write.busy || offline) return;
    const body = plan.body;
    const r = await write.run(JSON.stringify(body), (key) => workClient(api).stagesUpdate(body, key));
    if (!r.ok) return;
    toast(r.value.moved ? `Stages saved. ${r.value.moved} ${r.value.moved === 1 ? 'deal' : 'deals'} moved.` : 'Stages saved.');
    onSaved();
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label="Stages">
      <ol aria-label="The stages, in order">
        {rows.map((r, i) => (
          <li key={r.key} data-stage={r.id ?? 'new'} className="border-b border-line py-8">
            <div className="flex items-center gap-4">
              <label className="sr-only" htmlFor={`${id}-${r.key}`}>
                Stage {i + 1}
              </label>
              <input id={`${id}-${r.key}`} className={INPUT} value={r.name} maxLength={30} autoComplete="off" placeholder="Stage name" onChange={(e) => set(r.key, { name: e.target.value })} />
              {r.kind !== 'open' ? <Tag>{r.kind === 'won' ? 'Won' : 'Lost'}</Tag> : null}
              <IconButton aria-label={`Move ${r.name || 'stage'} up`} disabled={i === 0} onClick={() => shift(r.key, -1)}>
                <ArrowUpIcon size={16} aria-hidden="true" />
              </IconButton>
              <IconButton aria-label={`Move ${r.name || 'stage'} down`} disabled={i === rows.length - 1} onClick={() => shift(r.key, 1)}>
                <ArrowDownIcon size={16} aria-hidden="true" />
              </IconButton>
              {r.kind === 'open' ? (
                <IconButton aria-label={`Remove ${r.name || 'stage'}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  <XIcon size={16} aria-hidden="true" />
                </IconButton>
              ) : (
                // Won and Lost stay: the place keeps the rows lined up.
                <span aria-hidden="true" className="size-28 flex-none coarse:size-44" />
              )}
            </div>
            {r.kind === 'open' ? (
              // 112 + 144 and their gaps leave a 390 phone's sheet room for "12 deals" on the same line.
              <div className="mt-6 flex flex-wrap gap-12">
                <Field label="Probability %" htmlFor={`${id}-${r.key}-p`} className="w-112 flex-none py-0">
                  <input
                    id={`${id}-${r.key}-p`}
                    className={INPUT}
                    inputMode="numeric"
                    maxLength={3}
                    placeholder={r.ramp !== undefined ? String(r.ramp) : ''}
                    value={r.probability}
                    onChange={(e) => set(r.key, { probability: e.target.value })}
                  />
                </Field>
                <Field label="Quiet after (days)" htmlFor={`${id}-${r.key}-q`} className="w-144 flex-none py-0">
                  <input
                    id={`${id}-${r.key}-q`}
                    className={INPUT}
                    inputMode="numeric"
                    maxLength={2}
                    placeholder={String(reply.quietDays)}
                    value={r.quietDays}
                    onChange={(e) => set(r.key, { quietDays: e.target.value })}
                  />
                </Field>
                {r.deals ? <p className="self-end pb-10 type-mono text-ink-3">{r.deals} {r.deals === 1 ? 'deal' : 'deals'}</p> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {rows.length < 12 ? (
        <div className="pt-8">
          <Button variant="text" className="coarse:min-h-44" onClick={addStage}>
            <PlusIcon size={16} aria-hidden="true" />
            Add a stage
          </Button>
        </div>
      ) : null}
      {removed.some((s) => s.deals > 0) ? (
        <fieldset className="mt-8 min-w-0 border-t border-line pt-8">
          <legend className="type-rail text-ink-3">Removed</legend>
          {removed
            .filter((s) => s.deals > 0)
            .map((s) => (
              <Field key={s.id} label={`${s.name} · ${s.deals} ${s.deals === 1 ? 'deal' : 'deals'}: move them to`} htmlFor={`${id}-to-${s.id}`}>
                <select id={`${id}-to-${s.id}`} className={INPUT} value={moveTo[s.id] ?? targets[0]?.id ?? ''} onChange={(e) => setMoveTo((m) => ({ ...m, [s.id]: e.target.value }))}>
                  {targets.map((t) => (
                    <option key={t.key} value={t.id}>
                      {t.name || 'Unnamed stage'}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          <p className="type-small text-ink-3">They keep their days in stage.</p>
        </fieldset>
      ) : null}
      {!plan.ok && plan.problem ? <p className="mt-8 type-small text-ink-2">{plan.problem}</p> : null}
      {write.error ? <SaveError error={write.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!plan.ok || write.busy || offline}>
          {write.busy ? <Spinner label="Saving" /> : null}
          Save stages
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
