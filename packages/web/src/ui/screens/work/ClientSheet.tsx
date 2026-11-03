/**
 * 0.13.0 Add a client in about ten seconds, or change one (design 6.2 "Add a
 * client", W29). A bottom sheet on a phone, a form sheet from 640.
 *
 *   New client
 *   [ Person | Company ]
 *   Name    [Riya Kapoor              ]
 *           Already here: Riya K. · Acme › (same e-mail)     a warning, never a block
 *   Phone   [98xxxxxxxx               ]    tel keyboard
 *   Company [Acme                     ]    one he has, or a new one by its name
 *   [ Lead | Client ]
 *   More fields ▸                           e-mail, title, tags, source, city, notes, check-in
 *
 * While he types a name, an e-mail or a phone, Work says which client this
 * may already be (`POST /v1/work/clients/similar`, 400 ms after typing
 * stops; strongest first: the same e-mail, the same phone by its last 10
 * digits, then the same name as a hint). Save is never held back by it.
 *
 * Editing shows every field: up to five phones, e-mails and links each, the
 * company picked from his companies (or none), the state (Past too), and
 * "check in every N days" (7 to 365; empty is none). Only what changed is
 * sent (PATCH; null clears).
 */
import { CaretDownIcon, CaretRightIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { ContactKind, ContactState, WorkClientCreateBody, WorkClientHub, WorkClientPatch, WorkClientSimilarReply } from '@jantar/protocol/work';
import { useDeps } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { Link } from '../../shell/Link.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Field, INPUT, OfflineLine, SheetActions, TEXTAREA, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import { clientPath, parseTags } from './clientModel.js';
import { Chips, SaveError } from './parts.js';

export interface ClientSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** null: a new client. */
  client: WorkClientHub | null;
  /** Saved: the client's id and name. */
  onSaved: (id: string, name: string) => void;
}

export function ClientSheet({ open, onOpenChange, sheetKey, client, onSaved }: ClientSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={client ? `Edit ${client.contact.name}` : 'New client'}>
      {open ? <ClientForm key={sheetKey} hub={client} onDone={() => onOpenChange(false)} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

const WHY: Record<WorkClientSimilarReply['matches'][number]['why'], string> = { email: 'same e-mail', phone: 'same phone', name: 'same name' };

/** A phone as the Mac takes one: digits, spaces, + - . / ( ), and a digit. */
export const phoneOk = (v: string) => v.trim() === '' || (/^[0-9+\-.()/\s]{1,30}$/.test(v.trim()) && /\d/.test(v));
/** An e-mail with a name, an @ and a domain with a dot (the Mac checks it fully). */
export const emailOk = (v: string) => v.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
/** A link: https only. */
export const linkOk = (v: string) => v.trim() === '' || /^https:\/\/[^\s]+\.[^\s]+$/.test(v.trim());

/** Who this may already be, asked 400 ms after typing stops (never blocks). */
function useSimilar(name: string, email: string, phone: string, except?: string) {
  const { api } = useDeps();
  const [matches, setMatches] = useState<WorkClientSimilarReply['matches']>([]);
  useEffect(() => {
    const body = {
      ...(name.trim().length >= 2 ? { name: name.trim().slice(0, 80) } : {}),
      ...(emailOk(email) && email.trim() ? { email: email.trim() } : {}),
      ...(phoneOk(phone) && phone.replace(/\D/g, '').length >= 7 ? { phone: phone.trim() } : {}),
    };
    if (Object.keys(body).length === 0) {
      setMatches([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      workClient(api)
        .clientSimilar({ ...body, ...(except ? { except } : {}) })
        .then(
          (r) => live && setMatches(r.matches),
          () => live && setMatches([]),
        );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, name, email, phone, except]);
  return matches;
}

/** Up to five values of one kind (phones, e-mails, links), each with a remove, and "+ Add". */
function ListField({ label, values, onChange, type, ok, inputMode }: { label: string; values: string[]; onChange: (v: string[]) => void; type: string; ok: (v: string) => boolean; inputMode?: 'tel' | 'email' | 'url' }) {
  const id = useId();
  return (
    <Field label={label} id={id}>
      <div role="group" aria-labelledby={id} className="flex flex-col gap-8">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-4">
            <input
              aria-label={`${label} ${i + 1}`}
              type={type}
              inputMode={inputMode}
              aria-invalid={!ok(v) || undefined}
              className={INPUT}
              value={v}
              autoComplete="off"
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <IconButton aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
              <XIcon size={16} aria-hidden="true" />
            </IconButton>
          </div>
        ))}
        {values.length < 5 ? (
          <Button variant="text" size="sm" className="self-start coarse:min-h-44" onClick={() => onChange([...values, ''])}>
            <PlusIcon size={14} aria-hidden="true" />
            Add {label.toLowerCase()}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

function ClientForm({ hub, onDone, onSaved }: { hub: WorkClientHub | null; onDone: () => void; onSaved: (id: string, name: string) => void }) {
  const { api } = useDeps();
  const offline = useOffline();
  const w = useWrite();
  const id = useId();
  const c = hub?.contact;
  const [kind, setKind] = useState<ContactKind>(c?.kind ?? 'person');
  const [state, setState] = useState<ContactState>(c?.state ?? 'lead');
  const [name, setName] = useState(c?.name ?? '');
  const [phones, setPhones] = useState<string[]>(c ? c.phones.map((p) => p.value) : ['']);
  const [emails, setEmails] = useState<string[]>(c ? [...c.emails] : ['']);
  const [links, setLinks] = useState<string[]>(c ? [...c.links] : []);
  const [company, setCompany] = useState('');
  const [companyId, setCompanyId] = useState(c?.companyId ?? '');
  const [title, setTitle] = useState(c?.title ?? '');
  const [tags, setTags] = useState((c?.tags ?? []).join(', '));
  const [source, setSource] = useState(c?.source ?? '');
  const [city, setCity] = useState(c?.city ?? '');
  const [notes, setNotes] = useState(c?.notes ?? '');
  const [checkIn, setCheckIn] = useState(c?.checkInDays !== undefined ? String(c.checkInDays) : '');
  const [more, setMore] = useState(Boolean(c));
  const companies = useLifeLoad('work:companies', () => workClient(api).clients({ kind: 'company', sort: 'name' }));
  const companyRows = useMemo(() => (companies.data?.clients ?? []).filter((x) => x.id !== c?.id), [companies.data, c?.id]);
  const similar = useSimilar(name, emails[0] ?? '', phones[0] ?? '', c?.id);

  const checkDays = checkIn.trim() === '' ? undefined : Number(checkIn);
  const checkOk = checkDays === undefined || (Number.isInteger(checkDays) && checkDays >= 7 && checkDays <= 365);
  const listsOk = phones.every(phoneOk) && emails.every(emailOk) && links.every(linkOk);
  const ok = name.trim().length > 0 && checkOk && listsOk;
  const clean = (vs: string[]) => [...new Set(vs.map((v) => v.trim()).filter(Boolean))].slice(0, 5);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || w.busy || offline) return;
    const n = name.trim();
    if (!c) {
      const ph = clean(phones)[0];
      const em = clean(emails)[0];
      const t = parseTags(tags);
      const body: WorkClientCreateBody = {
        name: n,
        kind,
        state,
        ...(kind === 'person' && company.trim() ? { companyName: company.trim().slice(0, 80) } : {}),
        ...(ph ? { phone: ph } : {}),
        ...(em ? { email: em } : {}),
        ...(kind === 'person' && title.trim() ? { title: title.trim() } : {}),
        ...(t.length ? { tags: t } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(checkDays !== undefined ? { checkInDays: checkDays } : {}),
      };
      const r = await w.run(JSON.stringify(body), (key) => workClient(api).clientCreate(body, key));
      if (!r.ok) return;
      onSaved(r.value.id, n);
    } else {
      const patch: WorkClientPatch = {};
      if (n !== c.name) patch.name = n;
      if (kind !== c.kind) patch.kind = kind;
      if (state !== c.state) patch.state = state;
      const cid = kind === 'person' ? companyId : '';
      if (cid !== (c.companyId ?? '')) patch.companyId = cid || null;
      const ph = clean(phones);
      // A phone kept as it was keeps its label.
      if (ph.join('\n') !== c.phones.map((p) => p.value).join('\n')) patch.phones = ph.map((v) => c.phones.find((p) => p.value === v) ?? { value: v });
      const em = clean(emails);
      if (em.join('\n') !== c.emails.join('\n')) patch.emails = em;
      const ln = clean(links);
      if (ln.join('\n') !== c.links.join('\n')) patch.links = ln;
      const tt = kind === 'person' ? title.trim() : '';
      if (tt !== (c.title ?? '')) patch.title = tt || null;
      const t = parseTags(tags);
      if (t.join('\n') !== c.tags.join('\n')) patch.tags = t;
      if (source.trim() !== (c.source ?? '')) patch.source = source.trim() || null;
      if (city.trim() !== (c.city ?? '')) patch.city = city.trim() || null;
      if (notes.trim() !== (c.notes ?? '')) patch.notes = notes.trim() || null;
      if (checkDays !== c.checkInDays) patch.checkInDays = checkDays ?? null;
      if (Object.keys(patch).length) {
        const r = await w.run(JSON.stringify(patch), (key) => workClient(api).clientUpdate(c.id, patch, key));
        if (!r.ok) return;
      }
      onSaved(c.id, n);
    }
    onDone();
  };

  return (
    <form onSubmit={(e) => void save(e)} aria-label={c ? `Edit ${c.name}` : 'New client'}>
      <Chips<ContactKind>
        label="Kind"
        chips={[
          { key: 'person', label: 'Person' },
          { key: 'company', label: 'Company' },
        ]}
        value={kind}
        onChange={(k) => k && setKind(k)}
      />
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      {similar.length ? (
        <div role="status" data-similar className="-mt-4 mb-4 flex flex-col">
          {similar.map((m) => (
            <Link key={m.id} href={clientPath(m.id)} onClick={onDone} className="inline-flex min-h-32 items-center gap-6 type-small text-ink-2 hover:text-ink coarse:min-h-44">
              <span className="min-w-0 truncate">
                Already here: <span className="text-ink">{m.name}</span>
                {m.company ? ` · ${m.company.name}` : ''} ({WHY[m.why]})
              </span>
              <CaretRightIcon size={12} aria-hidden="true" className="flex-none text-ink-3" />
            </Link>
          ))}
        </div>
      ) : null}
      {c ? (
        <ListField label="Phone" values={phones} onChange={setPhones} type="tel" inputMode="tel" ok={phoneOk} />
      ) : (
        <Field label="Phone" htmlFor={`${id}-phone`}>
          <input id={`${id}-phone`} type="tel" inputMode="tel" aria-invalid={!phoneOk(phones[0] ?? '') || undefined} className={INPUT} value={phones[0] ?? ''} maxLength={30} autoComplete="off" onChange={(e) => setPhones([e.target.value])} />
        </Field>
      )}
      {kind === 'person' ? (
        c ? (
          <Field label="Company" htmlFor={`${id}-company`}>
            <select id={`${id}-company`} className={INPUT} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">None</option>
              {hub?.company && !companyRows.some((x) => x.id === hub.company?.id) ? <option value={hub.company.id}>{hub.company.name}</option> : null}
              {companyRows.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Company" htmlFor={`${id}-company`}>
            <input id={`${id}-company`} list={`${id}-companies`} className={INPUT} value={company} maxLength={80} autoComplete="off" onChange={(e) => setCompany(e.target.value)} />
            <datalist id={`${id}-companies`}>
              {companyRows.map((x) => (
                <option key={x.id} value={x.name} />
              ))}
            </datalist>
            {company.trim() && !companyRows.some((x) => x.name.toLowerCase() === company.trim().toLowerCase()) ? (
              <p className="mt-4 type-small text-ink-3">New company: {company.trim()}</p>
            ) : null}
          </Field>
        )
      ) : null}
      <Field label="State">
        <Chips<ContactState>
          label="State"
          chips={[
            { key: 'lead', label: 'Lead' },
            { key: 'client', label: 'Client' },
            ...(c ? [{ key: 'past' as const, label: 'Past' }] : []),
          ]}
          value={state}
          onChange={(k) => k && setState(k)}
        />
      </Field>
      {c ? null : (
        <Button variant="text" size="sm" aria-expanded={more} className="mt-4 coarse:min-h-44" onClick={() => setMore((m) => !m)}>
          {more ? <CaretDownIcon size={14} aria-hidden="true" /> : <CaretRightIcon size={14} aria-hidden="true" />}
          More fields
        </Button>
      )}
      {more ? (
        <>
          {c ? (
            <>
              <ListField label="E-mail" values={emails} onChange={setEmails} type="email" inputMode="email" ok={emailOk} />
              <ListField label="Link" values={links} onChange={setLinks} type="url" inputMode="url" ok={linkOk} />
            </>
          ) : (
            <Field label="E-mail" htmlFor={`${id}-email`}>
              <input id={`${id}-email`} type="email" inputMode="email" aria-invalid={!emailOk(emails[0] ?? '') || undefined} className={INPUT} value={emails[0] ?? ''} maxLength={120} autoComplete="off" onChange={(e) => setEmails([e.target.value])} />
            </Field>
          )}
          {kind === 'person' ? (
            <Field label="Title" htmlFor={`${id}-title`}>
              <input id={`${id}-title`} className={INPUT} value={title} maxLength={60} autoComplete="off" placeholder="Head of Ops" onChange={(e) => setTitle(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Tags" htmlFor={`${id}-tags`}>
            <input id={`${id}-tags`} className={INPUT} value={tags} maxLength={340} autoComplete="off" placeholder="retail, referral" onChange={(e) => setTags(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-12">
            <Field label="Source" htmlFor={`${id}-source`} className="min-w-0 flex-1">
              <input id={`${id}-source`} className={INPUT} value={source} maxLength={60} autoComplete="off" placeholder="Referral" onChange={(e) => setSource(e.target.value)} />
            </Field>
            <Field label="City" htmlFor={`${id}-city`} className="min-w-0 flex-1">
              <input id={`${id}-city`} className={INPUT} value={city} maxLength={60} autoComplete="off" onChange={(e) => setCity(e.target.value)} />
            </Field>
          </div>
          <Field label="Check in every (days)" htmlFor={`${id}-checkin`}>
            <input id={`${id}-checkin`} type="number" inputMode="numeric" min={7} max={365} aria-invalid={!checkOk || undefined} className={INPUT} value={checkIn} placeholder="30" onChange={(e) => setCheckIn(e.target.value)} />
          </Field>
          <Field label="Notes" htmlFor={`${id}-notes`}>
            <textarea id={`${id}-notes`} className={TEXTAREA} value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </>
      ) : null}
      {!checkOk ? <p className="mt-4 type-small text-ink-2">A check-in is every 7 to 365 days.</p> : null}
      {!listsOk ? <p className="mt-4 type-small text-ink-2">A phone is digits; an e-mail needs an @; a link starts with https://.</p> : null}
      {w.error ? <SaveError error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Saving" /> : null}
          {c ? 'Save' : 'Add client'}
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
