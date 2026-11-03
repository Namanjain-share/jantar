/**
 * 0.13.0 Import clients (design 11, W27): from a file he hands over, never
 * another app's database. Its own chunk, loaded the first time it opens.
 *
 *   1. Choose a file (a CSV or a vCard: on the iPhone, Files, where a
 *      contact shared from Contacts can be saved as .vcf) or Paste CSV.
 *      The newest imports are listed with Undo while it can (7 days).
 *   2. The preview (`POST /v1/work/import/preview`, kept 30 minutes on the
 *      Mac): a CSV's columns, each with where it goes (he can change it,
 *      which reads the file again), and each row that may already be a
 *      client ("Already here: Acme, same e-mail") with Skip, Fill blanks
 *      (it marks that client as imported) or Add anyway. Skip is the
 *      default for the same e-mail or phone; Add for a name-only match.
 *   3. Import (`POST /v1/work/import`, one batch): "Added 84 clients,
 *      filled 3." with Undo import (`DELETE /v1/work/import/:batch`), which
 *      removes the ones nothing changed since and says how many it kept.
 *
 * Every client it makes is marked as imported: its words are data (Chat
 * frames them; the screens say so). At most 2,000 rows or 1 MB a file.
 */
import { FileArrowUpIcon } from '@phosphor-icons/react';
import { useId, useRef, useState } from 'react';
import type { WorkImportAction, WorkImportField, WorkImportPreviewReply, WorkImportReply } from '@jantar/protocol/work';
import { errorText } from '../../../lib/api.js';
import { useDeps, useNow, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { LifeEmpty, NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../life/today/parts.js';
import { dayLabel } from '../life/shared/DayNav.js';
import { workClient } from './client.js';
import { Chips } from './parts.js';

/** The most a file can hold (WORK_LIMITS.importBytes). */
export const IMPORT_MAX_BYTES = 1_000_000;
export const TOO_BIG = 'That file is over 1 MB. Split it and import each part.';

/** Where a column goes, in words, in WORK_IMPORT_FIELDS' order (taken as words: the chunk carries no schema; a test compares them). */
export const FIELD_LABEL: Record<WorkImportField, string> = {
  name: 'Name',
  firstName: 'First name',
  lastName: 'Last name',
  email: 'E-mail',
  phone: 'Phone',
  company: 'Company',
  title: 'Title',
  tags: 'Tags',
  notes: 'Notes',
  source: 'Source',
  city: 'City',
  state: 'State',
  website: 'Website',
  linkedin: 'LinkedIn',
  kind: 'Person or company',
  skip: 'Leave out',
};

const WHY = { email: 'same e-mail', phone: 'same phone', name: 'same name' } as const;

/** A vCard by its name or its first line; anything else is read as CSV. */
export function formatOf(name: string, text: string): 'csv' | 'vcf' {
  return /\.vcf$/i.test(name) || /^\s*BEGIN:VCARD/i.test(text) ? 'vcf' : 'csv';
}

export interface ImportSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  onImported: () => void;
}

export function ImportSheet({ open, onOpenChange, sheetKey, onImported }: ImportSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Import clients">
      {open ? <ImportFlow key={sheetKey} onDone={() => onOpenChange(false)} onImported={onImported} /> : null}
    </Sheet>
  );
}

type Step = { at: 'pick' } | { at: 'preview'; preview: WorkImportPreviewReply; text: string; changed: boolean } | { at: 'done'; result: WorkImportReply };

function ImportFlow({ onDone, onImported }: { onDone: () => void; onImported: () => void }) {
  const { api } = useDeps();
  const w = useWrite();
  const offline = useOffline();
  const toast = useToast();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [paste, setPaste] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [actions, setActions] = useState<ReadonlyMap<number, WorkImportAction>>(new Map());
  const client = workClient(api);

  const preview = async (text: string, format: 'csv' | 'vcf', mapping?: WorkImportField[]) => {
    setProblem(null);
    const body = { format, text, ...(mapping ? { mapping } : {}) };
    // The key's signature holds the words themselves: another file of the same length is another body, and a
    // retry after a failure must not send it under the old key (the daemon refuses that with 409).
    const r = await w.run(`preview:${format}:${mapping?.join() ?? ''}:${text}`, (key) => client.importPreview(body, key));
    if (!r.ok) return;
    setActions(new Map(r.value.rows.map((row) => [row.index, row.action])));
    setStep({ at: 'preview', preview: r.value, text, changed: Boolean(mapping) });
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) {
      setProblem(TOO_BIG);
      return;
    }
    const text = await f.text();
    if (!text.trim()) {
      setProblem("That file is empty.");
      return;
    }
    await preview(text, formatOf(f.name, text));
  };

  const run = async (p: WorkImportPreviewReply, changed: boolean) => {
    const body = { previewId: p.previewId, ...(changed ? { mapping: p.mapping } : {}), rows: p.rows.map((row) => ({ index: row.index, action: actions.get(row.index) ?? row.action })) };
    const r = await w.run(`import:${p.previewId}:${JSON.stringify(body.rows)}`, (key) => client.importRun(body, key));
    if (!r.ok) return;
    onImported();
    setStep({ at: 'done', result: r.value });
  };

  const undo = async (batch: string) => {
    const r = await w.run(`undo:${batch}`, (key) => client.importUndo(batch, key));
    if (!r.ok) return;
    const { removed, kept } = r.value;
    toast(kept ? `Import undone: removed ${removed}, kept ${kept} that changed since.` : `Import undone: removed ${removed}.`);
    onImported();
    onDone();
  };

  if (step.at === 'done') {
    const { added, filled, skipped, batch } = step.result;
    return (
      <div>
        <p role="status" className="type-body text-ink">
          Added {added} {added === 1 ? 'client' : 'clients'}
          {filled ? `, filled ${filled}` : ''}
          {skipped ? `, skipped ${skipped}` : ''}.
        </p>
        <p className="mt-4 type-small text-ink-2">Each is marked as imported. Undo works for 7 days, for the ones nothing changed since.</p>
        {w.error ? <NotSaved error={w.error} /> : null}
        <SheetActions>
          <Button variant="primary" size="lg" className="flex-1" onClick={onDone}>
            Done
          </Button>
          <Button size="lg" disabled={offline || w.busy || added === 0} onClick={() => void undo(batch)}>
            Undo import
          </Button>
        </SheetActions>
      </div>
    );
  }

  if (step.at === 'preview') {
    const p = step.preview;
    const dups = p.rows.filter((r) => r.dup);
    const fresh = p.rows.filter((r) => !r.dup);
    const count = (a: WorkImportAction) => p.rows.filter((r) => (actions.get(r.index) ?? r.action) === a).length;
    const adding = count('add');
    const filling = count('fill');
    const mapping = [...p.mapping];
    return (
      <div>
        <p className="type-small text-ink-2">
          {p.rows.length} {p.rows.length === 1 ? 'row' : 'rows'}
          {p.skipped ? `, ${p.skipped} left out (no name, or past 2,000)` : ''}. Nothing is imported until you tap Import.
        </p>
        {p.format === 'csv' && p.columns.length ? (
          <details className="mt-8 border-y border-line py-4" open={p.rows.length === 0}>
            <summary className="flex min-h-44 cursor-pointer items-center type-small text-ink">Columns ({p.columns.length})</summary>
            <ul aria-label="Columns">
              {p.columns.map((col, i) => (
                <li key={i} className="flex min-h-44 items-center gap-8">
                  <span className="min-w-0 flex-1 truncate type-mono text-ink-2">{col || `Column ${i + 1}`}</span>
                  <select
                    aria-label={`Column ${col || i + 1} goes to`}
                    className={`${INPUT} w-176 flex-none`}
                    value={mapping[i] ?? 'skip'}
                    disabled={w.busy || offline}
                    onChange={(e) => {
                      const next = [...mapping];
                      next[i] = e.target.value as WorkImportField;
                      void preview(step.text, p.format, next);
                    }}
                  >
                    {(Object.keys(FIELD_LABEL) as WorkImportField[]).map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {dups.length ? (
          <section aria-label="Already here" className="mt-12">
            <h3 className="type-rail text-ink-3">Already here · {dups.length}</h3>
            <ul>
              {dups.map((r) => {
                const a = actions.get(r.index) ?? r.action;
                return (
                  <li key={r.index} data-import-row={r.index} className="border-b border-line py-8">
                    <p className="truncate type-row text-ink">{r.fields.name}</p>
                    <p className="truncate type-small text-ink-2">
                      Already here: {r.dup!.name} ({WHY[r.dup!.why]})
                    </p>
                    <Chips<WorkImportAction>
                      label={`What to do with ${r.fields.name}`}
                      className="mt-6"
                      chips={[
                        { key: 'skip', label: 'Skip' },
                        { key: 'fill', label: 'Fill blanks' },
                        { key: 'add', label: 'Add anyway' },
                      ]}
                      value={a}
                      onChange={(k) => k && setActions((m) => new Map(m).set(r.index, k))}
                    />
                    {a === 'fill' ? <p className="mt-4 type-mono text-ink-3">Fill blanks · marks it as imported</p> : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {fresh.length ? (
          <section aria-label="New" className="mt-12">
            <h3 className="type-rail text-ink-3">New · {fresh.length}</h3>
            <ul>
              {fresh.slice(0, 30).map((r) => (
                <li key={r.index} data-import-row={r.index} className="flex min-h-32 items-baseline gap-8 border-b border-line py-4">
                  <span className="min-w-0 flex-1 truncate type-small text-ink">{r.fields.name}</span>
                  <span className="min-w-0 max-w-160 flex-none truncate type-mono text-ink-3">{r.fields.company ?? r.fields.emails[0] ?? r.fields.phones[0] ?? ''}</span>
                </li>
              ))}
            </ul>
            {fresh.length > 30 ? <p className="py-4 type-mono text-ink-3">and {fresh.length - 30} more</p> : null}
          </section>
        ) : null}
        {p.rows.length === 0 ? <LifeEmpty className="px-0">No row has a name. Check where the columns go.</LifeEmpty> : null}
        {w.error ? <NotSaved error={w.error} /> : null}
        <SheetActions>
          <Button variant="primary" size="lg" className="flex-1" disabled={offline || w.busy || adding + filling === 0} onClick={() => void run(p, step.changed)}>
            {w.busy ? <Spinner label="Importing" /> : null}
            {filling ? `Import ${adding}, fill ${filling}` : `Import ${adding}`}
          </Button>
          <Button variant="text" size="lg" onClick={() => setStep({ at: 'pick' })}>
            Back
          </Button>
        </SheetActions>
        {offline ? <OfflineLine className="mt-8" /> : null}
      </div>
    );
  }

  return (
    <div>
      <p className="type-small text-ink-2">A CSV (from a spreadsheet or another app&apos;s export) or a vCard (.vcf). Jantar reads only the file you choose.</p>
      <input
        ref={file}
        type="file"
        accept=".csv,.vcf,text/csv,text/vcard,text/x-vcard"
        className="sr-only"
        aria-label="Choose a file"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          void choose(f);
        }}
      />
      <div className="mt-12 flex flex-wrap gap-8">
        <Button variant="primary" size="lg" disabled={offline || w.busy} onClick={() => file.current?.click()}>
          {w.busy && paste === null ? <Spinner label="Reading" /> : <FileArrowUpIcon size={16} aria-hidden="true" />}
          Choose a file
        </Button>
        <Button size="lg" aria-expanded={paste !== null} disabled={offline} onClick={() => setPaste((v) => (v === null ? '' : null))}>
          Paste CSV
        </Button>
      </div>
      {paste !== null ? (
        <Field label="CSV" htmlFor={`${id}-csv`} className="mt-8">
          <textarea id={`${id}-csv`} className={TEXTAREA} rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'name,email,company\nRiya Kapoor,riya@acme.example,Acme'} />
          <Button className="mt-8 coarse:min-h-44" disabled={offline || w.busy || !paste.trim() || paste.length > IMPORT_MAX_BYTES} onClick={() => void preview(paste, 'csv')}>
            {w.busy ? <Spinner label="Reading" /> : null}
            Preview
          </Button>
        </Field>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-8 type-small text-ink">
          {problem}
        </p>
      ) : null}
      {w.error ? <NotSaved error={w.error} /> : null}
      <Imports onUndo={(b) => void undo(b)} busy={w.busy} offline={offline} />
      {offline ? <OfflineLine className="mt-8" /> : null}
    </div>
  );
}

/** The newest imports he can still undo (7 days). */
function Imports({ onUndo, busy, offline }: { onUndo: (batch: string) => void; busy: boolean; offline: boolean }) {
  const { api } = useDeps();
  const nowMs = useNow(60_000);
  const load = useLifeLoad('work:imports', () => workClient(api).imports());
  const open = (load.data?.imports ?? []).filter((i) => Date.parse(i.undoUntil) > nowMs);
  if (load.error && !load.data) return <p className="mt-12 type-small text-ink-3">{errorText(load.error)}</p>;
  if (!open.length) return null;
  return (
    <section aria-label="Recent imports" className="mt-16">
      <h3 className="type-rail text-ink-3">Recent imports</h3>
      <ul>
        {open.map((i) => (
          <li key={i.batch} className="flex min-h-44 items-center gap-8 border-b border-line">
            <span className="min-w-0 flex-1 truncate type-small text-ink">
              {dayLabel(i.at.slice(0, 10))} · {i.added} added{i.filled ? `, ${i.filled} filled` : ''}
            </span>
            <span className="flex-none type-mono text-ink-3">until {dayLabel(i.undoUntil.slice(0, 10)).replace(/^\w+ /, '')}</span>
            <Button variant="text" size="sm" className="coarse:min-h-44" disabled={busy || offline || i.added === 0} onClick={() => onUndo(i.batch)}>
              Undo
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
