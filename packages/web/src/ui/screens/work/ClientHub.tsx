/**
 * 0.13.0 One client as a hub (design 6.2 "A client", W21): one read,
 * `GET /v1/work/clients/:id`, then, top to bottom:
 *
 *   ‹ Clients                                   Edit ···
 *   Riya Kapoor
 *   Head of Ops · Acme › · Client                (imported: marked so)
 *   [ Call ]  [ WhatsApp ]  [ Email ]            the phone's own apps (W31)
 *   NEXT  Call about scope · Thu 15:00   ✓       its earliest follow-up (W12)
 *   [ Log a call or meeting ]                    LogSheet.tsx, with its next step
 *   FOLLOW-UPS   the Todos rows (done, snooze, edit, delete with Undo); + Next step
 *   DEALS        its own, and a person's company's or a company's people's
 *                (labelled); + New deal with this client (DealSheet.tsx,
 *                loaded on first use)
 *   PROJECTS     its projects (a person's company's too), each to its hub
 *   PEOPLE       a company's people
 *   LOG          newest first, done follow-ups in between; Show older pages
 *   DETAILS      phones, e-mails, links, tags, city, source, folder, check-in, notes
 *
 * ··· holds Mark as past (or back to client), Merge with… (Duplicates.tsx,
 * loaded on first use) and Delete, whose Confirm spells out what goes and
 * what stays (W30, design 4.5) and offers Mark as past first.
 *
 * Words someone else wrote come marked: an imported contact or log entry, a
 * name tapped from a meeting, a meeting's own name, a meeting's action item:
 * shown as data (parts.tsx FromTag, Framed), never acted on.
 *
 * "Log the call?" (W31): after Call, when the page was hidden ten seconds
 * or more and comes back within two hours, a line offers the Log sheet.
 * From a pane of 640 the parts are cards side by side (kit/Columns.tsx).
 * With a keyboard (design 6.4): l logs, n sets a next step, e edits; the
 * list's own keys (j/k, ↵, Esc, c adds, / filters) are the shell's.
 *
 * Every button and link is 44 tall on touch, the phone and e-mail links included.
 */
import { CaretLeftIcon, CaretRightIcon, CheckIcon, EnvelopeSimpleIcon, PhoneIcon, PlusIcon, WhatsappLogoIcon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FilesRootsResponse, Todo } from '@jantar/protocol';
import type { WorkClientHub, WorkDealCard, WorkLogRow } from '@jantar/protocol/work';
import { errorText } from '../../../lib/api.js';
import { formatAmount } from '../../../lib/money.js';
import { routePath } from '../../../lib/router.js';
import { useApp, useDeps, useNow, useToast } from '../../context.js';
import { Button, buttonClass } from '../../kit/Button.js';
import { Columns, useCardWidth } from '../../kit/Columns.js';
import { IconButton } from '../../kit/IconButton.js';
import { Panel } from '../../kit/Panel.js';
import { PaneClose, usePaneClose } from '../../kit/PaneClose.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { useFeatures } from '../../shell/data.js';
import { dialogOpen, useKey } from '../../shell/keys.js';
import { useLayout } from '../../shell/layout.js';
import { Link } from '../../shell/Link.js';
import { LifeEmpty, NotSaved } from '../life/shared/states.js';
import { useLifeLoad, useLifeStatus } from '../life/shared/useLife.js';
import { Loaded, Page, RowMenu, SheetActions, useHeldDeletes, useLifeClock, useOffline, useSheet, useWrite } from '../life/today/parts.js';
import { useTodoActions } from '../life/todos/actions.js';
import { ProjectRow } from '../life/todos/ProjectRow.js';
import { liveIn } from '../life/todos/model.js';
import { TodoRow } from '../life/todos/TodoRow.js';
import { TodoSheet } from '../life/todos/TodoSheet.js';
import { ClientSheet } from './ClientSheet.js';
import type { WorkPrefs } from './Clients.js';
import { workClient } from './client.js';
import { STATE_LABEL, askLogCall, clientPath, deleteLines, mailHref, telHref, touchText, waHref } from './clientModel.js';
import { LogSheet, type LogStart } from './LogSheet.js';
import { dueWord, filesHref, inStageText, logLine } from './model.js';
import { FromTag, Framed, useStageNames } from './parts.js';

const MergeSheet = lazy(() => import('./Duplicates.js').then((m) => ({ default: m.MergeSheet })));
// The deals' sheet comes from their chunk on its first New deal.
const DealSheet = lazy(() => import('./DealSheet.js').then((m) => ({ default: m.DealSheet })));

export interface ClientHubProps {
  id: string;
  /** The list's address ("‹ Clients"). */
  back: string;
  prefs: WorkPrefs;
  /** A write here changed the list's rows. */
  onChanged: () => void;
  onDeleted: () => void;
}

export function ClientHub({ id, back, prefs, onChanged, onDeleted }: ClientHubProps) {
  const { api } = useDeps();
  const w = useMemo(() => workClient(api), [api]);
  const toast = useToast();
  const offline = useOffline();
  const features = useFeatures();
  const { status } = useLifeStatus();
  const now = useLifeClock(status);
  const nowMs = useNow(60_000);
  const sessions = useApp((s) => s.state.sessions);
  const load = useLifeLoad(`work:client:${id}`, () => w.client(id));
  const hub = load.data;
  const reloadHub = load.reload;
  const reload = useCallback(() => {
    reloadHub();
    onChanged();
  }, [reloadHub, onChanged]);
  const actions = useTodoActions(reload);
  const held = useHeldDeletes(actions.undo);
  const write = useWrite();
  const edit = useSheet<null>();
  const log = useSheet<LogStart>();
  const todoSheet = useSheet<Todo>();
  const confirm = useSheet<null>();
  const merge = useSheet<null>();
  const dealSheet = useSheet<null>();
  const close = usePaneClose();
  const box = useRef<HTMLDivElement>(null);
  const cards = useCardWidth(box);
  // Older log pages, after the hub's own; a reload of the hub starts them over.
  const [older, setOlder] = useState<{ rows: WorkLogRow[]; next?: string | undefined } | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  useEffect(() => setOlder(null), [hub]);
  const ask = useCallAsk();
  // A stage move in the log by its stage's name (a stage added in the editor has a made-up id).
  const stageNames = useStageNames(hub ? (older ? [...hub.log, ...older.rows] : hub.log) : undefined);
  const folder = hub?.contact.folder;
  const roots = useLifeLoad<FilesRootsResponse>(folder && features.files ? 'work:roots:files' : null, () => api.filesRoots());

  const contact = hub?.contact;
  // Design 6.4's keys with a keyboard: l logs, n sets a next step, e edits (none while a sheet or menu is open).
  useKey(
    ['l', 'n', 'e'],
    (e) => {
      if (dialogOpen()) return;
      e.preventDefault();
      if (e.key === 'l') log.show({});
      else if (e.key === 'n') todoSheet.show(null);
      else edit.show(null);
    },
    useLayout().keyboard && Boolean(contact) && !offline,
  );
  const setState = (state: 'past' | 'client' | 'lead') => {
    if (!contact || offline) return;
    void write.run(`state:${state}`, (key) => w.clientUpdate(contact.id, { state }, key)).then((r) => {
      if (r.ok) {
        reload();
        confirm.close();
      }
    });
  };
  const remove = async () => {
    if (!contact || offline) return;
    const r = await write.run(`delete:${contact.id}`, (key) => w.clientDelete(contact.id, key));
    if (!r.ok) return;
    const { deals, log: rows } = r.value.removed;
    const gone = [deals ? `${deals} ${deals === 1 ? 'deal' : 'deals'}` : '', rows ? `${rows} log ${rows === 1 ? 'entry' : 'entries'}` : ''].filter(Boolean);
    toast(gone.length ? `Deleted ${contact.name}, with ${gone.join(' and ')}.` : `Deleted ${contact.name}.`);
    confirm.close();
    onChanged();
    onDeleted();
  };
  const loadOlder = async (cursor: string) => {
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await w.clientLog(id, cursor);
      setOlder((o) => ({ rows: [...(o?.rows ?? []), ...page.log], next: page.next }));
    } catch (e) {
      setOlderError(e);
    } finally {
      setOlderBusy(false);
    }
  };

  const backLink = close ? (
    <div className="flex">
      <PaneClose onClick={close} className="ml-auto" />
    </div>
  ) : (
    <Link href={back} className="inline-flex h-32 items-center gap-4 rounded-btn px-8 type-small text-ink-2 hover:bg-hover hover:text-ink coarse:h-44">
      <CaretLeftIcon size={16} aria-hidden="true" />
      Clients
    </Link>
  );
  const aside = contact ? (
    <>
      <Button size="sm" className="coarse:min-w-44" disabled={offline} onClick={() => edit.show(null)}>
        Edit
      </Button>
      <RowMenu
        label={`More for ${contact.name}`}
        disabled={offline}
        groups={[
          {
            items: [
              contact.state === 'past' ? { label: 'Mark as client', onSelect: () => setState('client') } : { label: 'Mark as past', onSelect: () => setState('past') },
              { label: 'Merge with…', onSelect: () => merge.show(null) },
              { label: 'Delete', onSelect: () => confirm.show(null) },
            ],
          },
        ]}
      />
    </>
  ) : null;

  return (
    <Page title={contact?.name ?? 'Client'} wrapTitle back={backLink} aside={aside} undo={actions.undo} wide>
      <div ref={box}>
        <Loaded load={load}>
          {(h) => {
            const c = h.contact;
            const phone = c.phones[0];
            const email = c.emails[0];
            const wa = phone ? waHref(phone.value, prefs.dialCode) : null;
            const followUps = actions.visible(h.followUps);
            const first = followUps[0];
            const logRows = held.visible([...h.log, ...(older?.rows ?? [])], (r) => r.id);
            const cursor = older ? older.next : h.logNext;
            const projects = h.projects;
            const touch = touchText(c.lastTouchAt, nowMs, prefs.quietDays);
            const startLog = (start: LogStart = {}) => log.show(start);
            const parts: ReactNode[] = [
              <Panel key="follow" label="Follow-ups" count={followUps.length} card={cards} aside={<NextStepButton disabled={offline} onClick={() => todoSheet.show(null)} />}>
                {actions.error ? (
                  <div className="px-16">
                    <NotSaved error={actions.error} />
                  </div>
                ) : null}
                {followUps.length === 0 ? (
                  <LifeEmpty>No follow-up. Add a next step so it isn't forgotten.</LifeEmpty>
                ) : (
                  <ul>
                    {followUps.map((t) => (
                      <TodoRow key={t.id} todo={t} now={now} offline={offline} actions={actions} onEdit={(x) => todoSheet.show(x)} />
                    ))}
                  </ul>
                )}
              </Panel>,
              <Panel
                key="deals"
                label="Deals"
                count={h.deals.length}
                card={cards}
                aside={
                  <Button variant="text" size="sm" className="coarse:min-h-44" disabled={offline} onClick={() => dealSheet.show(null)}>
                    <PlusIcon size={14} aria-hidden="true" />
                    New deal
                  </Button>
                }
              >
                {h.deals.length ? (
                  <ul>
                    {h.deals.map((d) => (
                      <DealRow key={d.id} deal={d} own={d.client.id === c.id} today={now.day} />
                    ))}
                  </ul>
                ) : (
                  <LifeEmpty>No deals yet.</LifeEmpty>
                )}
              </Panel>,
              projects.length ? (
                <Panel key="projects" label="Projects" count={projects.length} card={cards}>
                  <ul>
                    {projects.map((p) => (
                      <ProjectRow key={p.id} project={p} today={now.day} live={liveIn(Object.values(sessions), p.folder).length} href={routePath({ name: 'work', id: p.id })} />
                    ))}
                  </ul>
                </Panel>
              ) : null,
              h.people?.length ? (
                <Panel key="people" label="People" count={h.people.length} card={cards}>
                  <ul>
                    {h.people.map((p) => (
                      <li key={p.id} className="border-b border-line">
                        <Link href={clientPath(p.id)} data-client={p.id} className="flex min-h-44 items-center gap-8 px-16 py-8 transition-colors duration-120 ease-hover hover:bg-hover">
                          <span className="min-w-0 flex-1 truncate type-row text-ink">
                            {p.name}
                            {p.title ? <span className="text-ink-2"> · {p.title}</span> : null}
                          </span>
                          <FromTag from={p.from} className="flex-none" />
                          <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null,
              <Panel key="log" label="Log" count={logRows.length} card={cards} aside={c.lastTouchAt ? touch.text : undefined}>
                {logRows.length === 0 ? (
                  <LifeEmpty>Nothing logged yet. Log a call, a meeting or a note.</LifeEmpty>
                ) : (
                  <ul aria-label="Its log">
                    {logRows.map((row) => (
                      <LogItem
                        key={row.id}
                        row={row}
                        tz={status?.timezone}
                        stages={stageNames}
                        offline={offline}
                        onEdit={() => startLog({ row })}
                        onDelete={() =>
                          held.remove(row.id, 'Deleted a log entry', () =>
                            w.logDelete(row.id).then(
                              () => (reload(), true),
                              // The entry comes back; say why, or it looks as if the delete never happened.
                              (e: unknown) => (toast(`Not deleted. ${errorText(e)}`, 'error'), false),
                            ),
                          )
                        }
                      />
                    ))}
                  </ul>
                )}
                {cursor ? (
                  <div className="px-16 py-8">
                    <Button variant="text" className="coarse:min-h-44" disabled={olderBusy} onClick={() => void loadOlder(cursor)}>
                      {olderBusy ? <Spinner label="Loading" /> : null}
                      Show older
                    </Button>
                    {olderError ? <NotSaved error={olderError} /> : null}
                  </div>
                ) : null}
              </Panel>,
              <Panel key="details" label="Details" card={cards}>
                <Details hub={h} roots={roots.data} filesOn={features.files} />
              </Panel>,
            ].filter((x) => x !== null);
            return (
              <>
                <p className="flex flex-wrap items-center gap-x-8 gap-y-2 px-16 pb-8 type-small text-ink-2">
                  {c.title ? <span>{c.title}</span> : null}
                  {h.company ? (
                    <Link href={clientPath(h.company.id)} className="inline-flex h-32 items-center gap-2 text-ink hover:underline coarse:h-44">
                      {h.company.name}
                      <CaretRightIcon size={12} aria-hidden="true" className="text-ink-3" />
                    </Link>
                  ) : null}
                  {h.company?.from ? <FromTag from={h.company.from} /> : null}
                  <span className="type-mono text-ink-3">{c.kind === 'company' ? 'Company' : 'Person'}</span>
                  <span className="type-mono text-ink-2">{STATE_LABEL[c.state]}</span>
                  <FromTag from={c.from} />
                </p>
                {phone || email ? (
                  <div className="flex flex-wrap gap-8 px-16 pb-12">
                    {phone ? (
                      <a href={telHref(phone.value)} onClick={() => ask.tapped()} className={buttonClass('outline', 'md', 'coarse:min-h-44')}>
                        <PhoneIcon size={16} aria-hidden="true" />
                        Call
                      </a>
                    ) : null}
                    {wa ? (
                      <a href={wa} target="_blank" rel="noopener noreferrer" className={buttonClass('outline', 'md', 'coarse:min-h-44')}>
                        <WhatsappLogoIcon size={16} aria-hidden="true" />
                        WhatsApp
                      </a>
                    ) : null}
                    {email ? (
                      <a href={mailHref(email)} className={buttonClass('outline', 'md', 'coarse:min-h-44')}>
                        <EnvelopeSimpleIcon size={16} aria-hidden="true" />
                        Email
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {ask.asking ? (
                  <div role="status" className="mx-16 mb-12 flex flex-wrap items-center gap-8 rounded-btn bg-surface px-12 py-8">
                    <span className="mr-auto type-small text-ink">Log the call with {c.name}?</span>
                    <Button
                      variant="primary"
                      disabled={offline}
                      className="coarse:min-h-44"
                      onClick={() => {
                        ask.dismiss();
                        startLog({ kind: 'call' });
                      }}
                    >
                      Log it
                    </Button>
                    <Button variant="text" className="coarse:min-h-44" onClick={ask.dismiss}>
                      Not now
                    </Button>
                  </div>
                ) : null}
                {first ? (
                  <div data-next className="mx-16 mb-8 flex min-h-44 items-center gap-8 rounded-btn border border-line pl-12 pr-4">
                    <span className="flex-none type-rail text-ink-3">Next</span>
                    <span className="min-w-0 flex-1 truncate type-row text-ink">
                      {first.title}
                      {first.due ? <span className="type-mono text-ink-2"> · {dueWord(first.due, now.day)}</span> : null}
                    </span>
                    <IconButton aria-label={`Mark done: ${first.title}`} disabled={offline || actions.busy.has(first.id)} onClick={() => actions.done(first)}>
                      <CheckIcon size={16} aria-hidden="true" />
                    </IconButton>
                  </div>
                ) : null}
                {h.checkIn?.due ? (
                  <p className="px-16 pb-8 type-mono text-ink-2">
                    Check in: every {h.checkIn.every} days, {h.checkIn.since === null ? 'never touched' : `${h.checkIn.since} since`}
                  </p>
                ) : null}
                <div className="px-16 pb-12">
                  <Button variant="primary" size="lg" className="w-full @md:w-auto" disabled={offline} onClick={() => startLog()}>
                    Log a call or meeting
                  </Button>
                  {write.error ? <NotSaved error={write.error} /> : null}
                </div>
                {cards ? (
                  <Columns min={340} className="px-16">
                    {parts}
                  </Columns>
                ) : (
                  parts
                )}
              </>
            );
          }}
        </Loaded>
      </div>
      {hub ? (
        <>
          <ClientSheet open={edit.open} onOpenChange={edit.onOpenChange} sheetKey={edit.key} client={hub} onSaved={reload} />
          <LogSheet
            open={log.open}
            onOpenChange={log.onOpenChange}
            sheetKey={log.key}
            client={{ id: hub.contact.id, name: hub.contact.name }}
            // Every open deal on the page: a person's own and its company's, a company's and its people's (the
            // design's "Log with Riya Kapoor", Deal [Site rebuild], Acme's), so a next step reaches the deal.
            deals={hub.deals.filter((d) => d.kind === 'open')}
            start={log.item ?? {}}
            now={now}
            onSaved={reload}
          />
          <TodoSheet
            open={todoSheet.open}
            onOpenChange={todoSheet.onOpenChange}
            sheetKey={todoSheet.key}
            todo={todoSheet.item}
            projects={hub.projects}
            clients={[{ id: hub.contact.id, name: hub.contact.name }]}
            now={now}
            start={{ contactId: hub.contact.id }}
            onSaved={reload}
          />
          <Sheet open={confirm.open} onOpenChange={confirm.onOpenChange} title={`Delete ${hub.contact.name}?`}>
            <div className="flex flex-col gap-6" data-delete-lines>
              {deleteLines(hub).map((l) => (
                <p key={l} className="type-small text-ink-2">
                  {l}
                </p>
              ))}
            </div>
            {write.error ? <NotSaved error={write.error} /> : null}
            <SheetActions>
              {hub.contact.state !== 'past' ? (
                <Button variant="primary" size="lg" className="flex-1" disabled={offline || write.busy} onClick={() => setState('past')}>
                  Mark as past instead
                </Button>
              ) : null}
              <Button size="lg" disabled={offline || write.busy} onClick={() => void remove()}>
                {write.busy ? <Spinner label="Deleting" /> : null}
                Delete
              </Button>
              <Button variant="text" size="lg" onClick={confirm.close}>
                Cancel
              </Button>
            </SheetActions>
          </Sheet>
          {dealSheet.key ? (
            <Suspense fallback={null}>
              <DealSheet
                open={dealSheet.open}
                onOpenChange={dealSheet.onOpenChange}
                sheetKey={dealSheet.key}
                deal={null}
                client={{ id: hub.contact.id, name: hub.contact.name }}
                onSaved={() => {
                  reload();
                  toast('Deal added.');
                }}
              />
            </Suspense>
          ) : null}
          {merge.key ? (
            <Suspense fallback={null}>
              <MergeSheet
                open={merge.open}
                onOpenChange={merge.onOpenChange}
                sheetKey={merge.key}
                keep={{ id: hub.contact.id, name: hub.contact.name, kind: hub.contact.kind, state: hub.contact.state, company: hub.company }}
                onMerged={() => {
                  reload();
                }}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}

/** "+ Next step" at the Follow-ups heading. */
function NextStepButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Button variant="text" size="sm" className="coarse:min-h-44" disabled={disabled} onClick={onClick}>
      <PlusIcon size={14} aria-hidden="true" />
      Next step
    </Button>
  );
}

/** W31: after a Call tap, whether to ask "Log the call?" when the page comes back. */
function useCallAsk() {
  const tapped = useRef<number | null>(null);
  const hidden = useRef<number | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const on = () => {
      if (tapped.current === null) return;
      if (document.visibilityState === 'hidden') {
        hidden.current = Date.now();
        return;
      }
      if (askLogCall(tapped.current, hidden.current, Date.now())) setAsking(true);
      tapped.current = null;
      hidden.current = null;
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return {
    asking,
    tapped: () => {
      tapped.current = Date.now();
      hidden.current = null;
    },
    dismiss: () => setAsking(false),
  };
}

/** One deal: its title and stage, then its value, days in stage and next step; a company's or a person's is labelled. */
function DealRow({ deal, own, today }: { deal: WorkDealCard; own: boolean; today: string }) {
  const facts = [
    deal.value !== undefined ? formatAmount(deal.value, deal.currency) : null,
    deal.kind === 'open' ? inStageText(deal.daysInStage) : null,
    deal.kind === 'open' ? (deal.next ? (deal.next.due ? `next ${dueWord(deal.next.due, today)}` : `next: ${deal.next.title}`) : 'no next step') : null,
  ].filter((x): x is string => x !== null);
  return (
    <li className="border-b border-line">
      <Link
        href={routePath({ name: 'work', tab: 'deals', id: deal.id })}
        data-deal={deal.id}
        className="flex min-h-44 items-center gap-8 px-16 py-8 transition-colors duration-120 ease-hover hover:bg-hover"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate type-row text-ink">
            {deal.title}
            <span className="text-ink-2"> · {deal.stageName}</span>
          </span>
          <span className="mt-2 block truncate type-mono text-ink-3">
            {own ? '' : `${deal.client.name} · `}
            {facts.join(' · ')}
          </span>
        </span>
        <FromTag from={deal.from} className="flex-none" />
        <CaretRightIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
      </Link>
    </li>
  );
}

/** One log entry. His own call, e-mail, message or note has ··· (Edit, Delete); a meeting links to its page. */
function LogItem({
  row,
  tz,
  stages,
  offline,
  onEdit,
  onDelete,
}: {
  row: WorkLogRow;
  tz?: string | null | undefined;
  stages: ReadonlyMap<string, string> | undefined;
  offline: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const l = logLine(row, tz, stages);
  const mine = row.kind === 'call' || row.kind === 'email' || row.kind === 'message' || row.kind === 'note' || (row.kind === 'meeting' && !row.meetingId);
  const from = row.from ?? (row.todoFrom === 'meeting' ? 'meeting' : undefined);
  const line = <span className="block truncate type-mono text-ink-2">{l.line}</span>;
  return (
    <li data-log={row.id} data-kind={row.kind} className="flex items-start gap-4 border-b border-line pl-16 pr-8">
      <div className="min-w-0 flex-1 py-10">
        {row.meetingId ? (
          <Link href={routePath({ name: 'meetings', id: row.meetingId })} className="flex min-h-24 items-center gap-6 hover:underline coarse:min-h-44">
            {line}
            <CaretRightIcon size={12} aria-hidden="true" className="flex-none text-ink-3" />
          </Link>
        ) : (
          line
        )}
        {from ? <FromTag from={from} className="mt-2 inline-block" /> : null}
        {l.body ? (
          <div className="mt-2">
            <Framed from={row.from}>
              <span className="line-clamp-4 block whitespace-pre-wrap break-words type-small text-ink-2">{l.body}</span>
            </Framed>
          </div>
        ) : null}
      </div>
      {mine ? (
        <div className="pt-4 coarse:pt-0">
          <RowMenu
            label={`Actions for this ${row.kind}`}
            disabled={offline}
            groups={[
              {
                items: [
                  { label: 'Edit', onSelect: onEdit },
                  { label: 'Delete', onSelect: onDelete },
                ],
              },
            ]}
          />
        </div>
      ) : null}
    </li>
  );
}

const ROW = 'flex min-h-44 items-center gap-12 border-b border-line px-16 py-6';
/** A phone, an e-mail or a link in Details: the text is the target, 44 tall on touch. */
const LINK = 'type-small text-ink hover:underline coarse:inline-flex coarse:min-h-44 coarse:items-center';

/** Its phones, e-mails and links (each a tap to the phone's own app), tags, city, source, folder, check-in and notes. */
function Details({ hub, roots, filesOn }: { hub: WorkClientHub; roots: FilesRootsResponse | null; filesOn: boolean }) {
  const c = hub.contact;
  const inFiles = filesOn && c.folder ? filesHref(c.folder, roots?.roots ?? []) : null;
  const facts: { key: string; label: string; value: ReactNode }[] = [];
  for (const p of c.phones)
    facts.push({
      key: `p:${p.value}`,
      label: p.label ?? 'Phone',
      value: (
        <a href={telHref(p.value)} className={LINK}>
          {p.value}
        </a>
      ),
    });
  for (const e of c.emails)
    facts.push({
      key: `e:${e}`,
      label: 'E-mail',
      value: (
        <a href={mailHref(e)} className={clsx(LINK, 'break-all')}>
          {e}
        </a>
      ),
    });
  for (const u of c.links)
    facts.push({
      key: `l:${u}`,
      label: 'Link',
      value: (
        <a href={u} target="_blank" rel="noopener noreferrer" className={clsx(LINK, 'break-all')}>
          {u.replace(/^https:\/\//, '')}
        </a>
      ),
    });
  if (c.tags.length) facts.push({ key: 'tags', label: 'Tags', value: <span className="type-mono text-ink-2">{c.tags.map((t) => `#${t}`).join(' ')}</span> });
  if (c.city) facts.push({ key: 'city', label: 'City', value: <span className="type-small text-ink">{c.city}</span> });
  if (c.source) facts.push({ key: 'source', label: 'Source', value: <span className="type-small text-ink">{c.source}</span> });
  if (hub.checkIn)
    facts.push({
      key: 'checkin',
      label: 'Check in',
      value: (
        <span className={clsx('type-mono', hub.checkIn.due ? 'text-ink' : 'text-ink-2')}>
          every {hub.checkIn.every} days{hub.checkIn.since !== null ? ` · ${hub.checkIn.since} since` : ''}
        </span>
      ),
    });
  if (c.folder)
    facts.push({
      key: 'folder',
      label: 'Folder',
      value: (
        <span className="flex flex-col items-start gap-6">
          <span className="break-all type-mono text-ink">{c.folder}</span>
          {inFiles ? (
            <Link href={inFiles} className={buttonClass('outline', 'sm', 'coarse:min-h-44')}>
              Open folder in Files
            </Link>
          ) : null}
        </span>
      ),
    });
  return (
    <div data-details>
      {c.from ? (
        <p className="flex items-center gap-8 border-b border-line px-16 py-8 type-small text-ink-2">
          <FromTag from={c.from} />
          {c.from === 'import' ? 'Its details came from a file you imported.' : "Its name came from a meeting's people."}
        </p>
      ) : null}
      {facts.length === 0 && !c.notes ? <LifeEmpty>No phone, e-mail or notes yet. Edit adds them.</LifeEmpty> : null}
      <dl>
        {facts.map((f) => (
          <div key={f.key} className={ROW}>
            <dt className="w-72 flex-none type-small text-ink-3">{f.label}</dt>
            <dd className="min-w-0 flex-1">{f.value}</dd>
          </div>
        ))}
      </dl>
      {c.notes ? (
        <div className="border-b border-line px-16 py-10">
          <Framed from={c.from}>
            <p className="whitespace-pre-wrap break-words type-small text-ink-2">{c.notes}</p>
          </Framed>
        </div>
      ) : null}
    </div>
  );
}
