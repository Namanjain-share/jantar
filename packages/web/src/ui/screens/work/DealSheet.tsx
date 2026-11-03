/**
 * 0.13.0 Add a deal, or change one (design 5.3, W17). A bottom sheet on a
 * phone, a form sheet from 640.
 *
 *   New deal
 *   Title    [Site rebuild              ]
 *   Client   [Acme                      ]    one of his clients, or a new one by its name
 *   Stage    [New lead ▾]                    an open stage (Won and Lost are moves)
 *   Value    [₹ 4,50,000 ]  Currency [INR]  hundredths on the wire; the Life currency by default
 *   Closes   [2026-11-30]
 *   Source   [Referral                  ]
 *   Business [AMG ▾]                         once he has a business
 *
 * A client by name that isn't one of his is made as a company, a lead, in
 * the same save. Editing sends only what changed (PATCH; null clears); the
 * stage changes only by a move (DealMove.tsx). From a client's page (no
 * pipeline loaded there) it reads the stages itself, and the client is set.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { WorkDealCreateBody, WorkDealHub, WorkDealPatch, WorkSettings } from '@jantar/protocol/work';
import { amountInput, currencySymbol, parseAmount } from '../../../lib/money.js';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { Field, INPUT, OfflineLine, SheetActions, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import type { StageRef } from './DealMove.js';
import { SaveError } from './parts.js';

export interface DealSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new deal. */
  deal: WorkDealHub | null;
  /** The pipeline's stages; none (a client's page): the sheet reads them. */
  stages?: readonly StageRef[] | undefined;
  /** A new deal for this client (from a client's page). */
  client?: { id: string; name: string } | undefined;
  /** Saved: the deal's id. */
  onSaved: (id: string) => void;
}

export function DealSheet({ open, onOpenChange, sheetKey, deal, stages = NO_STAGES, client, onSaved }: DealSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={deal ? `Edit ${deal.deal.title}` : client ? `New deal with ${client.name}` : 'New deal'}>
      {open ? <DealForm key={sheetKey} hub={deal} stages={stages} client={client} onDone={() => onOpenChange(false)} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

const NO_STAGES: readonly StageRef[] = [];

/** A currency as ISO 4217 takes it: three capital letters. */
const CURRENCY = /^[A-Z]{3}$/;

function DealForm({ hub, stages, client, onDone, onSaved }: { hub: WorkDealHub | null; stages: readonly StageRef[]; client?: { id: string; name: string } | undefined; onDone: () => void; onSaved: (id: string) => void }) {
  const { api } = useDeps();
  const w = useMemo(() => workClient(api), [api]);
  const offline = useOffline();
  const write = useWrite();
  const id = useId();
  const { status } = useLifeStatus();
  const deal = hub?.deal ?? null;
  const settings = useLifeLoad<WorkSettings>('work:settings:deal', () => w.settings());
  // His clients, for the picker (a fixed client needs none).
  const clients = useLifeLoad(client ? null : 'work:clients:deal', () => w.clients({ sort: 'name' }));
  const rows = clients.data?.clients ?? [];
  // A new deal from a client's page reads the stages (an edit never changes the stage).
  const read = useLifeLoad(stages.length || hub ? null : 'work:stages:deal', () => w.stages());
  const open = (stages.length ? stages : (read.data?.stages ?? [])).filter((s) => s.kind === 'open');
  const [title, setTitle] = useState(deal?.title ?? '');
  const [clientName, setClientName] = useState(hub?.client.name ?? '');
  const [clientId, setClientId] = useState(hub?.client.id ?? '');
  // The first open stage until he picks one (the stages may still be loading).
  const [picked, setStage] = useState('');
  const stage = picked || (open[0]?.id ?? '');
  const [currency, setCurrency] = useState(deal?.currency ?? status?.currency ?? '');
  const [value, setValue] = useState(deal?.value !== undefined ? amountInput(deal.value, deal.currency ?? null) : '');
  const [close, setClose] = useState(deal?.expectedClose ?? '');
  const [source, setSource] = useState(deal?.source ?? '');
  const [business, setBusiness] = useState(deal?.business ?? '');
  const businesses = settings.data?.businesses ?? [];

  const cur = currency.trim().toUpperCase();
  const curOk = cur === '' || CURRENCY.test(cur);
  const hundredths = value.trim() === '' ? null : parseAmount(value, CURRENCY.test(cur) ? cur : null);
  const valueOk = value.trim() === '' || hundredths !== null;
  const typed = clientName.trim();
  const match = rows.find((r) => r.name.toLowerCase() === typed.toLowerCase());
  const titleOk = title.trim().length > 0 && title.trim().length <= 80;
  // A new deal names a client (one of his, or a new one); an edit picks one of his.
  const clientOk = client ? true : deal ? Boolean(clientId) : typed.length > 0;
  const ok = titleOk && clientOk && curOk && valueOk && (deal !== null || Boolean(stage));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || write.busy || offline) return;
    if (!deal) {
      const who = client ? { clientId: client.id } : match ? { clientId: match.id } : { clientName: typed.slice(0, 80) };
      const body: WorkDealCreateBody = {
        ...who,
        title: title.trim(),
        stage,
        ...(hundredths !== null ? { value: hundredths } : {}),
        ...(cur ? { currency: cur } : {}),
        ...(close ? { expectedClose: close } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(business ? { business } : {}),
      };
      const r = await write.run(JSON.stringify(body), (key) => w.dealCreate(body, key));
      if (!r.ok) return;
      onSaved(r.value.id);
      onDone();
      return;
    }
    const patch: WorkDealPatch = {};
    if (title.trim() !== deal.title) patch.title = title.trim();
    if (clientId && clientId !== deal.contactId) patch.clientId = clientId;
    if (cur && cur !== (deal.currency ?? '')) patch.currency = cur;
    if ((hundredths ?? undefined) !== deal.value) patch.value = hundredths;
    if ((close || undefined) !== deal.expectedClose) patch.expectedClose = close || null;
    if ((source.trim() || undefined) !== deal.source) patch.source = source.trim() || null;
    if ((business || undefined) !== deal.business) patch.business = business || null;
    if (Object.keys(patch).length) {
      const r = await write.run(JSON.stringify(patch), (key) => w.dealUpdate(deal.id, patch, key));
      if (!r.ok) return;
    }
    onSaved(deal.id);
    onDone();
  };

  const symbol = currencySymbol(CURRENCY.test(cur) ? cur : null);
  return (
    <form onSubmit={(e) => void save(e)} aria-label={deal ? 'Edit deal' : 'New deal'}>
      <Field label="Title" htmlFor={`${id}-title`}>
        <input id={`${id}-title`} className={INPUT} value={title} maxLength={80} autoComplete="off" placeholder="Site rebuild" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {client ? null : deal ? (
        <Field label="Client" htmlFor={`${id}-client`}>
          <select id={`${id}-client`} className={INPUT} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {hub && !rows.some((r) => r.id === hub.client.id) ? <option value={hub.client.id}>{hub.client.name}</option> : null}
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.company ? `${r.name} · ${r.company.name}` : r.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="Client" htmlFor={`${id}-client`}>
          <input id={`${id}-client`} list={`${id}-clients`} className={INPUT} value={clientName} maxLength={80} autoComplete="off" onChange={(e) => setClientName(e.target.value)} />
          <datalist id={`${id}-clients`}>
            {rows.map((r) => (
              <option key={r.id} value={r.name} />
            ))}
          </datalist>
          {typed && !match && !clients.loading ? <p className="mt-4 type-small text-ink-3">New client: {typed} (a company, a lead)</p> : null}
        </Field>
      )}
      {deal ? null : (
        <Field label="Stage" htmlFor={`${id}-stage`}>
          <select id={`${id}-stage`} className={INPUT} value={stage} onChange={(e) => setStage(e.target.value)}>
            {open.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="flex flex-wrap gap-12">
        <Field label="Value" htmlFor={`${id}-value`} className="min-w-0 flex-1">
          <div className="flex items-center gap-8">
            {symbol ? <span className="flex-none type-row text-ink-2">{symbol}</span> : null}
            <input id={`${id}-value`} className={INPUT} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        </Field>
        <Field label="Currency" htmlFor={`${id}-currency`} className="w-96 flex-none">
          <input id={`${id}-currency`} className={INPUT} value={currency} maxLength={3} autoComplete="off" autoCapitalize="characters" onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>
      </div>
      {!valueOk ? <p className="type-small text-ink-2">Type the value as digits, with a dot for decimals (45000 or 45000.50).</p> : null}
      {!curOk ? <p className="type-small text-ink-2">A currency is three letters, such as INR or USD.</p> : null}
      <div className="flex flex-wrap gap-12">
        <Field label="Closes" htmlFor={`${id}-close`} className="w-160 flex-none">
          <input id={`${id}-close`} type="date" className={INPUT} value={close} onChange={(e) => setClose(e.target.value)} />
        </Field>
        <Field label="Source" htmlFor={`${id}-source`} className="min-w-0 flex-1">
          <input id={`${id}-source`} className={INPUT} value={source} maxLength={60} autoComplete="off" placeholder="Referral" onChange={(e) => setSource(e.target.value)} />
        </Field>
      </div>
      {businesses.length ? (
        <Field label="Business" htmlFor={`${id}-business`}>
          <select id={`${id}-business`} className={INPUT} value={business} onChange={(e) => setBusiness(e.target.value)}>
            <option value="">None</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {write.error ? <SaveError error={write.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || write.busy || offline}>
          {write.busy ? <Spinner label="Saving" /> : null}
          {deal ? 'Save' : 'Add deal'}
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
