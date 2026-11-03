/**
 * Work (v0.13): the owner's projects as a hub, his clients and companies,
 * the log of calls, meetings and notes, follow-ups (todos with a client),
 * meetings linked to clients, import and export, and (P3) deals.
 *
 * - Owner-only by construction: its tables are named `work_*` and have no
 *   `space` column, only this folder names them (a source scan pins it),
 *   and nothing under the person routes, her Chat or her bundle imports it.
 * - It never runs SQL on `todos` or `projects`: projects and follow-ups are
 *   the Todos module's, which it is handed at build time and calls inside
 *   its own `db.tx` (a nested call joins it). It registers links with Todos
 *   so a todo's client or a project's client is checked against Work's own
 *   table, and hears of a project's client changing in the same commit.
 * - It never reads meetings.db: Meetings tells it a meeting's project and
 *   start (meetingProject, forgetMeeting, resyncMeetings), and the route
 *   layer names a meeting from meetings.db at read.
 * - Every method that takes an actor answers not_found for anyone but the
 *   owner (his devices, the Mac's CLI, the daemon itself).
 * - Nothing it logs, emits or audits names a client: ids and counts only;
 *   a refusal is a fixed sentence (WORK_REASONS), never a client's words.
 *
 * The rules (design 4.5), each inside one transaction:
 * - Deleting a client deletes its deals and log rows, lets go of it on its
 *   todos (client and deal) and projects, and its people lose their
 *   company. No Undo beyond the Confirm.
 * - Log + next step is one save: a refused todo leaves no log row.
 * - `last_touch_at` is rebuilt from the log on every log change (a touch:
 *   a call, meeting, e-mail, message or note, W14), and for every contact
 *   at start.
 * - A meeting whose project has a client is linked to that client
 *   automatically (W15); his own links and unlinks stay; when the project's
 *   client changes the automatic links move with it; a deleted meeting's
 *   links go.
 * - P3, deals: a deal starts on an open stage and changes stage only by a
 *   move, which writes a `stage` row. Won stamps it, makes its client a
 *   client (never the reverse, W7) and, when asked, makes the project (its
 *   client, business and the deal linked) in the same save; Lost stamps it
 *   with an optional reason; a closed deal moved to an open stage is open
 *   again. Deleting a deal deletes its own rows (moves, "added"); a call or
 *   a note logged with it stays on the client, and its todos let go of it.
 *   A removed stage's deals are re-filed on a kept open stage he names.
 */
import {
  canonicalSource,
  contactMergeConflicts,
  describeClientList,
  duplicatePairKey,
  findDuplicateGroups,
  inClosingWindow,
  matchesClientList,
  milestoneProgress,
  planContactMerge,
  starterClientLists,
  type ListClient,
  type MergeableContact,
  normalizeContactEmail,
  normalizeContactName,
  normalizeContactPhone,
  normalizeTags,
  planStageDeletions,
  resolveAnalyticsPeriod,
  similarContacts,
  stageInvariantError,
  toCsv,
} from '@jantar/life-core';
import { LIFE_LIMITS, projectFor, type ProjectView, type Todo } from '@jantar/protocol';
import {
  WORK_LIMITS,
  type Contact,
  type ContactKind,
  type FolderClientResponse,
  type SearchItem,
  type WorkClientCreateBody,
  type WorkClientCreateReply,
  type WorkClientHub,
  type WorkClientPatch,
  type WorkClientRef,
  type WorkClientRow,
  type WorkClientSimilarBody,
  type WorkClientSimilarReply,
  type WorkClientsQuery,
  type WorkClientsResponse,
  type WorkImportBody,
  type WorkImportFields,
  type WorkImportPreviewBody,
  type WorkImportPreviewReply,
  type WorkImportReply,
  type WorkImportsReply,
  type WorkImportUndoReply,
  type WorkLogAddBody,
  type WorkLogAddReply,
  type WorkLogPage,
  type WorkLogPatch,
  type WorkLogRow,
  type WorkMeetingClientNewBody,
  type WorkMeetingSuggestReply,
  type WorkSettings,
  type WorkSettingsPatch,
  type Deal,
  type WorkDealCard,
  type WorkDealCreateBody,
  type WorkDealCreateReply,
  type WorkDealHub,
  type WorkDealMoveBody,
  type WorkDealMoveReply,
  type WorkDealPatch,
  type WorkDealsQuery,
  type WorkDealsResponse,
  type WorkInsightsQuery,
  type WorkInsightsReply,
  type WorkStage,
  type WorkStagesBody,
  type WorkStagesReply,
  type WorkMilestone,
  type WorkMilestonesBody,
  type WorkMilestonesView,
  type WorkClientListsReply,
  type WorkDuplicatesReply,
  type WorkMergeBody,
  type WorkMergeConflictsReply,
} from '@jantar/protocol/work';
import type { Actor, LifeCore, LifeModuleDeps, LifeResult, Logger, TodosModule, WorkMeetingRef, WorkModule } from '../../contracts.js';
import { foldText, holdsFolded } from '../../core/fold.js';
import { TODO_REASONS, folderKey } from '../todos/module.js';
import { dealCard, dealKind, dealsCsv, insightsOf, nextSteps, stageColumns, stageIndex, type CardContext } from './deals.js';
import { PreviewStore, fitRow, mappingFor, previewRows, readSource, type ImportProblem } from './import.js';
import { WorkRepo, type ContactRecord, type LogRecord } from './repo.js';
import { readBusinesses, readImports, readPrefs, readStages, writeBusinesses, writeImports, writePrefs, writeStages } from './settings.js';

/** What a Work call says to anyone but the owner: there is nothing here. */
export const WORK_NOT_FOUND = 'Not found.';

const count = (n: number) => n.toLocaleString('en-US');

/** What a refused Work call says: fixed daemon sentences, never a client's name, phone or e-mail. */
export const WORK_REASONS = {
  noClient: 'No such client.',
  clientGone: TODO_REASONS.clientGone,
  companyGone: "That company doesn't exist any more.",
  notCompany: 'Pick a company, not a person.',
  companyInCompany: "A company can't belong to another company.",
  companyHasPeople: 'This company has people. Move them to another company first.',
  clientsFull: `Work holds ${count(WORK_LIMITS.contacts)} clients at most. Mark some as past or delete them.`,
  noLog: 'No such entry.',
  logFull: `Work holds ${count(WORK_LIMITS.logRows)} log entries at most. Delete some old ones first.`,
  logJantars: "That entry is Jantar's own. Unlink a meeting on the meeting's page.",
  logFuture: "A log entry can't be in the future.",
  projectGone: TODO_REASONS.projectGone,
  dealGone: TODO_REASONS.dealGone,
  previewGone: 'That preview has expired. Choose the file again.',
  unreadable: "That file couldn't be read. Choose a CSV or a vCard (.vcf) file.",
  tooManyRows: `That file has more than ${count(WORK_LIMITS.importRows)} rows. Split it and import each part.`,
  tooManyColumns: `That file has more than ${WORK_LIMITS.importColumns} columns.`,
  mapping: "The columns don't match the file. Choose the file again.",
  noImport: 'No such import.',
  importOld: `That import is over ${WORK_LIMITS.importUndoDays} days old. Delete its clients one by one instead.`,
  noRow: 'That row is not in the preview.',
  fillNeedsMatch: 'Only a row that matches a client can fill its blanks.',
  noPerson: 'That meeting has no such name.',
  // P3: deals and stages
  noDeal: 'No such deal.',
  dealsFull: `Work holds ${count(WORK_LIMITS.deals)} deals at most. Delete some old ones first.`,
  openDealsFull: `Work holds ${count(WORK_LIMITS.openDeals)} open deals at most. Close some (Won or Lost) first.`,
  noStage: 'No such stage.',
  startOpen: 'A deal starts on an open stage. Move it to Won or Lost after.',
  reasonNeedsLost: 'A reason goes with Lost.',
  projectNeedsWon: 'Only a won deal makes a project.',
  hasProject: 'That deal has a project already.',
  notLost: 'Only a lost deal has a reason.',
  businessGone: TODO_REASONS.businessGone,
  stageTwice: 'A stage is in the list twice.',
  keepEnds: 'Won and Lost can be renamed or moved, never removed.',
  stageHasDeals: 'A stage you removed still has deals. Pick an open stage that stays for them.',
  moveToOpen: "A removed stage's deals go to an open stage that stays.",
  // P3b: merge
  mergeSelf: "A client can't be merged into itself.",
  mergeKinds: 'Merge two people or two companies.',
} as const;

const PROBLEM: Readonly<Record<ImportProblem, string>> = {
  unreadable: WORK_REASONS.unreadable,
  tooManyRows: WORK_REASONS.tooManyRows,
  tooManyColumns: WORK_REASONS.tooManyColumns,
  mapping: WORK_REASONS.mapping,
};

/** The owner: his devices, the Mac's CLI, the daemon itself. A person (her app, her Chat) never is. */
export function isOwner(actor: Actor): boolean {
  return actor.kind === 'device' || actor.kind === 'cli' || actor.kind === 'system';
}

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const notFound: Refusal = refuse('not_found', WORK_NOT_FOUND);
const OK: LifeResult = { ok: true, value: true };

/** Thrown inside a transaction to roll it back with a module's refusal. */
class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super('rollback');
  }
}

/** A folder as the seed compares it: as the Todos module does, any case (APFS ignores case). */
const seedKey = (folder: string) => folderKey(folder).toLowerCase();
const DAY_MS = 86_400_000;
/** A log entry may be at most this far ahead of the Mac's clock (a phone's clock drifts). */
const FUTURE_SLACK_MS = 5 * 60_000;
/** Folders that hold every repo below them (as Todos' folder rule): a company linked to one counts only for exactly it. */
const BROAD_FOLDERS = ['/', '/users'];

const digits = (s: string) => s.replace(/\D+/g, '');

/** A log record as a reply's row. */
function logView(r: LogRecord): WorkLogRow {
  const j = r.json;
  return {
    id: r.id,
    kind: r.kind,
    at: r.at,
    ...(r.contactId ? { contactId: r.contactId } : {}),
    ...(r.dealId ? { dealId: r.dealId } : {}),
    ...(r.projectId ? { projectId: r.projectId } : {}),
    ...(r.meetingId ? { meetingId: r.meetingId } : {}),
    ...(j.body !== undefined ? { body: j.body } : {}),
    ...(j.direction ? { direction: j.direction } : {}),
    ...(j.minutes !== undefined ? { minutes: j.minutes } : {}),
    ...(j.outcome ? { outcome: j.outcome } : {}),
    ...(j.stageFrom ? { stageFrom: j.stageFrom } : {}),
    ...(j.stageTo ? { stageTo: j.stageTo } : {}),
    ...(j.from ? { from: j.from } : {}),
    ...(j.auto ? { auto: true as const } : {}),
  };
}

/** A done follow-up as a log row (W13), by its done time. */
function followUpView(t: Todo): WorkLogRow {
  return {
    id: t.id,
    kind: 'followup',
    at: t.doneAt ?? t.updatedAt,
    title: t.title,
    ...(t.contactId ? { contactId: t.contactId } : {}),
    ...(t.dealId ? { dealId: t.dealId } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    ...(t.from === 'meeting' ? { todoFrom: 'meeting' as const } : {}),
  };
}

const newer = (a: { at: string; id: string }, b: { at: string; id: string }) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1);
const cursorOf = (r: { at: string; id: string }) => `${r.at}~${r.id}`;
function parseCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf('~');
  return i > 0 ? { at: c.slice(0, i), id: c.slice(i + 1) } : null;
}

/** Whole days from `iso` to `now`. */
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));

class Work implements WorkModule {
  readonly name = 'work' as const;
  private readonly repo: WorkRepo;
  private readonly previews = new PreviewStore();

  constructor(
    readonly core: LifeCore,
    readonly todos: TodosModule,
    private readonly log: Logger,
    /** The user's home folder: a broad folder for client_here. */
    private readonly home: string,
    /** Every meeting with a project (Meetings', once it is built); null while meetings.db is closed. */
    private readonly meetings: () => readonly WorkMeetingRef[] | null,
  ) {
    this.repo = new WorkRepo(core, log);
  }

  private stamp(): string {
    return this.core.now().toISOString();
  }

  /** Run `fn` in one transaction; a Rollback's refusal is the answer. */
  private tx<T>(fn: () => T): T | Refusal {
    try {
      return this.core.db.tx(fn);
    } catch (e) {
      if (e instanceof Rollback) return e.refusal;
      throw e;
    }
  }

  private projects(): ProjectView[] {
    const r = this.todos.listProjects();
    return r.ok ? r.value.projects : [];
  }

  private stages(): WorkStage[] {
    return readStages(this.core.db, this.log);
  }

  /** What every deal card is read against: the stages, every contact, each deal's and client's next step, today. */
  private cardContext(): CardContext {
    const { nextByDeal, nextByClient } = nextSteps(this.todos.dealFollowUps(null, false), this.todos.followUps(null, false));
    return {
      stages: stageIndex(this.stages()),
      contacts: new Map(this.repo.allContacts().map((c) => [c.id, c])),
      nextByDeal,
      nextByClient,
      today: this.core.today(),
      now: this.core.now().getTime(),
      quietDays: readPrefs(this.core.db, this.log).quietDays,
    };
  }

  /** Cards with open deals first (by stage, then close day), then closed ones, newest closed first. */
  private sortedCards(deals: readonly Deal[], ctx: CardContext): WorkDealCard[] {
    const order = (d: Deal) => ctx.stages.get(d.stage)?.order ?? 99;
    const open = deals.filter((d) => dealKind(d, ctx.stages) === 'open').sort((a, b) => order(a) - order(b) || (a.expectedClose ?? '~').localeCompare(b.expectedClose ?? '~') || a.createdAt.localeCompare(b.createdAt));
    const closed = deals.filter((d) => dealKind(d, ctx.stages) !== 'open').sort((a, b) => (b.wonAt ?? b.lostAt ?? '').localeCompare(a.wonAt ?? a.lostAt ?? '') || b.id.localeCompare(a.id));
    return [...open, ...closed].map((d) => dealCard(d, ctx));
  }

  start(): void {
    // Repairs drift: every contact's newest touch from the log, and the automatic meeting links.
    try {
      const n = this.repo.retouchAll();
      if (n > 0) this.log.info('work touches rebuilt', { contacts: n });
      const list = this.meetings();
      if (list) this.resyncMeetings(list);
    } catch (e) {
      this.log.warn('work resync failed', { error: e instanceof Error ? e.name : 'unknown' });
    }
  }

  // --- the links Todos asks for (registered at build) ---------------------------------

  hasContact(id: string): boolean {
    return this.repo.hasContact(id);
  }

  hasDeal(id: string): boolean {
    return this.repo.hasDeal(id);
  }

  hasBusiness(id: string): boolean {
    return readBusinesses(this.core.db, this.log).some((b) => b.id === id);
  }

  /** A project's client changed (inside Todos' transaction): its automatic meeting links follow. */
  projectClient(projectId: string, before: string | undefined, after: string | undefined): void {
    const touched = new Set<string>();
    if (before) touched.add(before);
    if (after) touched.add(after);
    const list = this.meetings();
    if (list) {
      for (const m of list) if (m.projectId === projectId) for (const c of this.reconcile(m, after ? { contactId: after, projectId } : null)) touched.add(c);
    }
    // Meetings closed: the rows Work has still move (a start's resync fills in the rest).
    for (const r of this.repo.autoMeetingRows().filter((x) => x.projectId === projectId && x.contactId !== after)) {
      if (r.contactId) touched.add(r.contactId);
      if (!after || this.repo.meetingRows(r.meetingId ?? '').some((x) => x.contactId === after)) this.repo.deleteLog(r.id);
      else this.repo.updateLog({ ...r, contactId: after });
    }
    for (const c of touched) this.repo.retouch(c);
  }

  /** A deleted project's links in Work go with it, in the delete's own transaction (only this folder names work_ tables). */
  projectDeleted(projectId: string): void {
    for (const c of this.repo.deleteAutoOfProject(projectId)) this.repo.retouch(c);
    this.repo.clearProject(projectId, this.stamp());
  }

  // --- Today: the Work card (W24) ------------------------------------------------------

  today(day: string): { work: NonNullable<import('@jantar/protocol').Today['work']> } {
    const now = this.core.now().getTime();
    const due: { c: ContactRecord; over: number; since: number | null }[] = [];
    for (const c of this.repo.allContacts()) {
      const ci = this.checkIn(c, now);
      if (ci?.due) due.push({ c, over: daysSince(c.lastTouchAt ?? c.createdAt, now) - ci.every, since: ci.since });
    }
    due.sort((a, b) => b.over - a.over || a.c.name.localeCompare(b.c.name));
    const shown = due.slice(0, WORK_LIMITS.checkInsShown);
    // P3: open deals with no next step, quiet ones, and ones closing this week (overdue ones included).
    const ctx = this.cardContext();
    const open = this.repo.allDeals().filter((d) => dealKind(d, ctx.stages) === 'open');
    const cards = open.map((d) => dealCard(d, ctx));
    // The client chips of the follow-ups in Today's Due (Todos can't read Work's table).
    const t = this.todos.today(day) as { todos?: { overdue: Todo[]; today: Todo[] } };
    const ids = new Set([...(t.todos?.overdue ?? []), ...(t.todos?.today ?? [])].flatMap((x) => (x.contactId ? [x.contactId] : [])));
    const clients = [...ids].flatMap((id) => {
      const c = this.repo.contact(id);
      return c ? [{ id: c.id, name: c.name }] : [];
    });
    return {
      work: {
        checkIns: shown.map((x) => ({ id: x.c.id, name: x.c.name, every: x.c.checkInDays ?? 0, since: x.since })),
        checkInsMore: due.length - shown.length,
        noNextStep: cards.filter((c) => !c.next).length,
        quiet: cards.filter((c) => c.quiet).length,
        closing: open.filter((d) => inClosingWindow(d.expectedClose, 'week', ctx.today)).length,
        clients,
      },
    };
  }

  private checkIn(c: ContactRecord, now: number): { every: number; since: number | null; due: boolean } | undefined {
    if (c.checkInDays === undefined || c.state === 'past') return undefined;
    const since = c.lastTouchAt ? daysSince(c.lastTouchAt, now) : null;
    return { every: c.checkInDays, since, due: daysSince(c.lastTouchAt ?? c.createdAt, now) >= c.checkInDays };
  }

  // --- P1: projects from client folders ----------------------------------------------------

  seed(items: readonly { folder: string; name: string }[], actor: Actor, opts: { clients?: boolean } = {}): LifeResult<{ projects: string[]; skipped: number; clients?: string[] }> {
    if (!isOwner(actor)) return notFound;
    const listed = this.todos.listProjects();
    if (!listed.ok) return listed;
    const linked = new Set(listed.value.projects.flatMap((p) => (p.folder ? [seedKey(p.folder)] : [])));
    const fresh: { folder: string; name: string }[] = [];
    let skipped = 0;
    for (const item of items) {
      const key = seedKey(item.folder);
      if (linked.has(key)) {
        skipped += 1;
        continue;
      }
      linked.add(key);
      fresh.push(item);
    }
    if (listed.value.projects.length + fresh.length > LIFE_LIMITS.projects) return refuse('conflict', TODO_REASONS.projectsFull);
    if (opts.clients && this.repo.contactCount() + fresh.length > WORK_LIMITS.contacts) return refuse('conflict', WORK_REASONS.clientsFull);
    const at = this.stamp();
    const out = this.tx(() => {
      const projects: string[] = [];
      const clients: string[] = [];
      for (const item of fresh) {
        let clientId: string | undefined;
        if (opts.clients) {
          // One company client per folder, its folder set (P2), the project's client.
          const c: Contact = { id: this.core.newId(), name: item.name.slice(0, 80), kind: 'company', state: 'client', phones: [], emails: [], links: [], tags: [], folder: item.folder, createdAt: at, updatedAt: at };
          this.repo.saveContact(c);
          clients.push(c.id);
          clientId = c.id;
        }
        const r = this.todos.createProject({ name: item.name, folder: item.folder, ...(clientId ? { clientId } : {}) }, actor);
        if (!r.ok) throw new Rollback(r);
        projects.push(r.value.id);
      }
      return { projects, clients };
    });
    if ('ok' in out) return out;
    if (out.clients.length > 0) this.core.changed();
    return { ok: true, value: { projects: out.projects, skipped, ...(opts.clients ? { clients: out.clients } : {}) } };
  }

  // --- search (GET /v1/search's clients and deals groups) ------------------------------------

  search(q: string, limit: number, actor: Actor): LifeResult<{ clients: SearchItem[]; deals: SearchItem[] }> {
    if (!isOwner(actor)) return notFound;
    const all = this.repo.allContacts();
    const names = new Map(all.map((c) => [c.id, c.name]));
    const clients: SearchItem[] = [];
    const folded = foldText(q.trim());
    const qDigits = digits(q);
    for (const c of all) {
      if (clients.length >= limit) break;
      if (!this.matches(c, folded, qDigits, names)) continue;
      const company = c.companyId ? names.get(c.companyId) : undefined;
      clients.push({ kind: 'client', id: c.id, label: c.name, sub: company ? `${company} · ${c.state}` : c.state, href: `/work?tab=clients&id=${c.id}` });
    }
    // Deals: the title or the client's name; open ones first.
    const ctx = this.cardContext();
    const deals: SearchItem[] = [];
    for (const card of this.sortedCards(this.repo.allDeals(), ctx)) {
      if (deals.length >= limit) break;
      if (!holdsFolded(folded, card.title, card.client.name)) continue;
      deals.push({ kind: 'deal', id: card.id, label: card.title, sub: `${card.client.name} · ${card.stageName}`.slice(0, 200), href: `/work?tab=deals&id=${card.id}` });
    }
    return { ok: true, value: { clients, deals } };
  }

  /** A contact holds the query: its name, its company's name, an e-mail, or (3 digits or more) a phone's digits. */
  private matches(c: Contact, folded: string, qDigits: string, names: ReadonlyMap<string, string>): boolean {
    if (holdsFolded(folded, c.name, c.companyId ? names.get(c.companyId) : undefined, ...c.emails)) return true;
    return qDigits.length >= 3 && c.phones.some((p) => digits(p.value).includes(qDigits));
  }

  // --- P2: clients ----------------------------------------------------------------------

  contact(id: string): Contact | null {
    return this.repo.contact(id);
  }

  private ref(c: Contact): WorkClientRef {
    return { id: c.id, name: c.name, state: c.state, ...(c.from ? { from: c.from } : {}) };
  }

  private row(c: ContactRecord, ctx: { names: ReadonlyMap<string, string>; froms: ReadonlyMap<string, NonNullable<Contact['from']>>; next: ReadonlyMap<string, Todo>; deals: ReturnType<WorkRepo['openDeals']>; now: number }): WorkClientRow {
    const t = ctx.next.get(c.id);
    const company = c.companyId ? ctx.names.get(c.companyId) : undefined;
    // The company's own mark: a person he typed can sit at a company an import or a meeting named.
    const companyFrom = c.companyId ? ctx.froms.get(c.companyId) : undefined;
    const ci = this.checkIn(c, ctx.now);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      state: c.state,
      ...(c.companyId && company !== undefined ? { company: { id: c.companyId, name: company, ...(companyFrom ? { from: companyFrom } : {}) } } : {}),
      ...(c.title ? { title: c.title } : {}),
      ...(t ? { next: { todoId: t.id, title: t.title, ...(t.due ? { due: t.due } : {}) } } : {}),
      ...(c.lastTouchAt ? { lastTouchAt: c.lastTouchAt } : {}),
      openDeals: ctx.deals.get(c.id) ?? { count: 0, sums: [] },
      tags: c.tags,
      ...(c.from ? { from: c.from } : {}),
      ...(ci?.due ? { checkInDue: true as const } : {}),
    };
  }

  private rowContext(all: readonly ContactRecord[]) {
    const next = new Map<string, Todo>();
    for (const t of this.todos.followUps(null, false)) if (t.contactId && !next.has(t.contactId)) next.set(t.contactId, t);
    const froms = new Map(all.flatMap((c) => (c.from ? [[c.id, c.from] as const] : [])));
    return { names: new Map(all.map((c) => [c.id, c.name])), froms, next, deals: this.repo.openDeals(), now: this.core.now().getTime() };
  }

  clients(q: WorkClientsQuery, actor: Actor): LifeResult<WorkClientsResponse> {
    if (!isOwner(actor)) return notFound;
    const all = this.repo.allContacts();
    const ctx = this.rowContext(all);
    const folded = q.q ? foldText(q.q) : '';
    const qDigits = q.q ? digits(q.q) : '';
    const tag = q.tag ? normalizeTags([q.tag])[0] : undefined;
    const ofBusiness = q.business ? new Set(this.projects().flatMap((p) => (p.business === q.business && p.clientId ? [p.clientId] : []))) : null;
    // P3b: a starter list, through the one predicate its count uses.
    const list = q.list ? starterClientLists().find((l) => l.id === q.list)?.filters : undefined;
    const listed = list ? this.listClients(all) : null;
    const at = new Date(ctx.now);
    const rows = all
      .filter((c) => {
        if (q.q && !this.matches(c, folded, qDigits, ctx.names)) return false;
        if (q.state && c.state !== q.state) return false;
        if (q.kind && c.kind !== q.kind) return false;
        if (tag !== undefined && !c.tags.includes(tag)) return false;
        if (q.company && c.companyId !== q.company) return false;
        if (ofBusiness && !ofBusiness.has(c.id) && !(c.companyId && ofBusiness.has(c.companyId))) return false;
        if (q.quiet !== undefined && daysSince(c.lastTouchAt ?? c.createdAt, ctx.now) < q.quiet) return false;
        if (q.checkIn && !this.checkIn(c, ctx.now)?.due) return false;
        if (list && listed && !matchesClientList(listed.get(c.id) as ListClient, list, at)) return false;
        return true;
      })
      .map((c) => this.row(c, ctx));
    if (q.sort === 'touch') rows.sort((a, b) => (b.lastTouchAt ?? '').localeCompare(a.lastTouchAt ?? ''));
    else if (q.sort === 'next') {
      const key = (r: WorkClientRow) => (r.next?.due ? `${r.next.due.day} ${r.next.due.time ?? '99:99'}` : r.next ? '9999' : '~');
      rows.sort((a, b) => key(a).localeCompare(key(b)));
    }
    return { ok: true, value: { clients: rows.slice(0, WORK_LIMITS.clientsPage), more: Math.max(0, rows.length - WORK_LIMITS.clientsPage) } };
  }

  /**
   * The contacts a typed name is (a company's, or any): those with its folded key. A name that folds
   * to nothing (symbols only, "★") is never an identity: only a contact with the very same text is
   * it. Without this, every such name, and before any script was kept every non-Latin one, would be
   * the first contact with an empty key.
   */
  private namedAs(name: string, kind?: 'company'): ContactRecord[] {
    const key = normalizeContactName(name);
    const pool = kind === 'company' ? this.repo.companiesNamed(key) : this.repo.named(key);
    if (key !== '') return pool;
    const exact = name.trim();
    return exact === '' ? [] : pool.filter((c) => c.name.trim() === exact);
  }

  /** The company a body names: an id of a company, or a name (reused when one has it, else made). */
  private companyFor(body: { companyId?: string | undefined; companyName?: string | undefined; state?: Contact['state'] | undefined }, at: string, opts: { from?: Contact['from']; importBatch?: string }): { id: string; made: Contact | null } | Refusal | null {
    if (body.companyId !== undefined) {
      const co = this.repo.contact(body.companyId);
      if (!co) return refuse('invalid_request', WORK_REASONS.companyGone);
      if (co.kind !== 'company') return refuse('invalid_request', WORK_REASONS.notCompany);
      return { id: co.id, made: null };
    }
    if (body.companyName === undefined) return null;
    const existing = this.namedAs(body.companyName, 'company')[0];
    if (existing) return { id: existing.id, made: null };
    const made: Contact = {
      id: this.core.newId(),
      name: body.companyName,
      kind: 'company',
      state: body.state ?? 'lead',
      phones: [],
      emails: [],
      links: [],
      tags: [],
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.importBatch ? { importBatch: opts.importBatch } : {}),
      createdAt: at,
      updatedAt: at,
    };
    return { id: made.id, made };
  }

  createClient(body: WorkClientCreateBody, actor: Actor): LifeResult<WorkClientCreateReply> {
    if (!isOwner(actor)) return notFound;
    const r = this.create(body, {});
    if (r.ok) this.core.changed();
    return r;
  }

  /** A new contact (and its company), saved; `opts` are the daemon's marks (an import, a meeting's name). The caller emits. */
  private create(body: WorkClientCreateBody, opts: { from?: Contact['from']; importBatch?: string }): LifeResult<WorkClientCreateReply> {
    const kind: ContactKind = body.kind ?? 'person';
    if (this.repo.contactCount() + (body.companyName ? 2 : 1) > WORK_LIMITS.contacts) return refuse('conflict', WORK_REASONS.clientsFull);
    const at = this.stamp();
    const company = kind === 'person' ? this.companyFor(body, at, opts) : null;
    if (company && 'ok' in company) return company;
    const c: Contact = {
      id: this.core.newId(),
      name: body.name,
      kind,
      state: body.state ?? 'lead',
      phones: body.phone ? [{ value: body.phone }] : [],
      emails: body.email ? [body.email] : [],
      links: [],
      tags: normalizeTags(body.tags ?? []).slice(0, WORK_LIMITS.tags),
      ...(company ? { companyId: company.id } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.folder !== undefined ? { folder: body.folder } : {}),
      ...(body.checkInDays !== undefined ? { checkInDays: body.checkInDays } : {}),
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.importBatch ? { importBatch: opts.importBatch } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.core.db.tx(() => {
      if (company?.made) this.repo.saveContact(company.made);
      this.repo.saveContact(c);
    });
    return { ok: true, value: { id: c.id, ...(company ? { companyId: company.id } : {}) } };
  }

  similar(body: WorkClientSimilarBody, actor: Actor): LifeResult<WorkClientSimilarReply> {
    if (!isOwner(actor)) return notFound;
    const all = this.repo.allContacts();
    const names = new Map(all.map((c) => [c.id, c]));
    const skip = new Set<string>();
    if (body.except) {
      skip.add(body.except);
      for (const id of names.get(body.except)?.notDuplicateOf ?? []) skip.add(id);
    }
    const book = all.map((c) => ({ id: c.id, name: c.name, emails: c.emails, phones: c.phones.map((p) => p.value) }));
    const hits = similarContacts({ name: body.name, emails: body.email ? [body.email] : [], phones: body.phone ? [body.phone] : [] }, book, WORK_LIMITS.similar, skip);
    return {
      ok: true,
      value: {
        matches: hits.map((h) => {
          const c = names.get(h.id);
          const co = c?.companyId ? names.get(c.companyId) : undefined;
          return { id: h.id, name: c?.name ?? '', ...(co ? { company: { id: co.id, name: co.name } } : {}), why: h.why };
        }),
      },
    };
  }

  names(ids: readonly string[], actor: Actor): LifeResult<{ clients: { id: string; name: string }[] }> {
    if (!isOwner(actor)) return notFound;
    const clients: { id: string; name: string }[] = [];
    for (const id of new Set(ids)) {
      const c = this.repo.contact(id);
      if (c) clients.push({ id: c.id, name: c.name });
    }
    return { ok: true, value: { clients } };
  }

  client(id: string, actor: Actor): LifeResult<WorkClientHub> {
    if (!isOwner(actor)) return notFound;
    const c = this.repo.contact(id);
    if (!c) return refuse('not_found', WORK_REASONS.noClient);
    const company = c.companyId ? this.repo.contact(c.companyId) : null;
    const people = c.kind === 'company' ? this.repo.peopleOf(c.id) : null;
    // A person's page lists its company's projects too; a company's, its people's (builder's call, 4.5).
    const linked = new Set([c.id, ...(company ? [company.id] : []), ...(people ?? []).map((p) => p.id)]);
    const all = people ? [c, ...people] : [c];
    const ctx = this.rowContext(all);
    const page = this.logPage(c.id, null);
    const ci = this.checkIn(c, ctx.now);
    return {
      ok: true,
      value: {
        contact: c,
        ...(company ? { company: this.ref(company) } : {}),
        ...(people ? { people: people.slice(0, WORK_LIMITS.hubPeople).map((p) => this.row(p, ctx)) } : {}),
        projects: this.projects().filter((p) => p.clientId !== undefined && linked.has(p.clientId)),
        followUps: this.todos.followUps(c.id, false),
        log: page.log,
        ...(page.next ? { logNext: page.next } : {}),
        ...(ci ? { checkIn: ci } : {}),
        openDeals: ctx.deals.get(c.id) ?? { count: 0, sums: [] },
        // A person's own deals and its company's; a company's and its people's (builder's call, 4.5).
        deals: this.sortedCards(this.repo.dealsOf([...linked]), this.cardContext()).slice(0, WORK_LIMITS.hubDeals),
      },
    };
  }

  /** One page of a client's log: its rows and its done follow-ups (W13), newest first, older than `before`. */
  private logPage(contactId: string, before: { at: string; id: string } | null): WorkLogPage {
    const limit = WORK_LIMITS.clientLog;
    const rows = this.repo.logOf(contactId, before, limit + 1).map(logView);
    const done = this.todos
      .followUps(contactId, true)
      .map(followUpView)
      .filter((r) => !before || newer(r, before) > 0);
    const merged = [...rows, ...done].sort(newer);
    const log = merged.slice(0, limit);
    const last = log.at(-1);
    return { log, ...(merged.length > limit && last ? { next: cursorOf(last) } : {}) };
  }

  clientLog(id: string, before: string | undefined, actor: Actor): LifeResult<WorkLogPage> {
    if (!isOwner(actor)) return notFound;
    if (!this.repo.hasContact(id)) return refuse('not_found', WORK_REASONS.noClient);
    return { ok: true, value: this.logPage(id, parseCursor(before)) };
  }

  updateClient(id: string, patch: WorkClientPatch, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const c = this.repo.contact(id);
    if (!c) return refuse('not_found', WORK_REASONS.noClient);
    const { lastTouchAt: _t, ...stored } = c;
    const next: Contact = { ...stored, updatedAt: this.stamp() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.state !== undefined) next.state = patch.state;
    if (patch.kind !== undefined && patch.kind !== c.kind) {
      if (patch.kind === 'person' && this.repo.peopleOf(c.id).length > 0) return refuse('conflict', WORK_REASONS.companyHasPeople);
      next.kind = patch.kind;
    }
    if (patch.companyId === null) delete next.companyId;
    else if (patch.companyId !== undefined) {
      const co = this.repo.contact(patch.companyId);
      if (!co || co.id === c.id) return refuse('invalid_request', WORK_REASONS.companyGone);
      if (co.kind !== 'company') return refuse('invalid_request', WORK_REASONS.notCompany);
      next.companyId = co.id;
    }
    if (next.kind === 'company' && next.companyId !== undefined) return refuse('invalid_request', WORK_REASONS.companyInCompany);
    for (const key of ['title', 'city', 'notes', 'source', 'folder', 'checkInDays'] as const) {
      const v = patch[key];
      if (v === null) delete next[key];
      else if (v !== undefined) (next as Record<string, unknown>)[key] = v;
    }
    if (patch.phones !== undefined) next.phones = patch.phones;
    if (patch.emails !== undefined) next.emails = patch.emails;
    if (patch.links !== undefined) next.links = [...new Set(patch.links)];
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags).slice(0, WORK_LIMITS.tags);
    this.repo.saveContact(next);
    this.core.changed();
    return OK;
  }

  removeClient(id: string, actor: Actor): LifeResult<{ deals: number; log: number }> {
    if (!isOwner(actor)) return notFound;
    if (!this.repo.hasContact(id)) return refuse('not_found', WORK_REASONS.noClient);
    const at = this.stamp();
    const removed = this.core.db.tx(() => {
      const gone = this.repo.deleteDealsOf(id);
      const deals = gone.deals;
      const log = gone.log + this.repo.deleteLogOf(id);
      this.todos.unlinkClient(id);
      for (const dealId of gone.ids) this.todos.unlinkDeal(dealId);
      for (const p of this.repo.peopleOf(id)) {
        const { companyId: _c, lastTouchAt: _t, ...rest } = p;
        this.repo.saveContact({ ...rest, updatedAt: at });
      }
      this.repo.deleteContact(id);
      return { deals, log };
    });
    this.core.changed();
    return { ok: true, value: removed };
  }

  // --- P2: the log ---------------------------------------------------------------------

  logRow(id: string): WorkLogRow | null {
    const r = this.repo.logRow(id);
    return r ? logView(r) : null;
  }

  /** A deal and a project a row may name: refused when gone. */
  private linksRefused(dealId: string | null | undefined, projectId: string | null | undefined): Refusal | null {
    if (dealId && !this.repo.hasDeal(dealId)) return refuse('invalid_request', WORK_REASONS.dealGone);
    if (projectId && !this.projects().some((p) => p.id === projectId)) return refuse('invalid_request', WORK_REASONS.projectGone);
    return null;
  }

  private future(at: string): boolean {
    return Date.parse(at) > this.core.now().getTime() + FUTURE_SLACK_MS;
  }

  addLog(contactId: string, body: WorkLogAddBody, actor: Actor): LifeResult<WorkLogAddReply> {
    if (!isOwner(actor)) return notFound;
    if (!this.repo.hasContact(contactId)) return refuse('not_found', WORK_REASONS.noClient);
    if (this.repo.logCount() >= WORK_LIMITS.logRows) return refuse('conflict', WORK_REASONS.logFull);
    const at = body.at ?? this.stamp();
    if (this.future(at)) return refuse('invalid_request', WORK_REASONS.logFuture);
    const no = this.linksRefused(body.dealId, body.projectId);
    if (no) return no;
    const id = this.core.newId();
    const r: LogRecord = {
      id,
      contactId,
      dealId: body.dealId ?? null,
      projectId: body.projectId ?? null,
      meetingId: null,
      at: new Date(Date.parse(at)).toISOString(),
      kind: body.kind,
      json: {
        ...(body.body !== undefined && body.body !== '' ? { body: body.body } : {}),
        ...(body.direction ? { direction: body.direction } : {}),
        ...(body.minutes !== undefined ? { minutes: body.minutes } : {}),
        ...(body.outcome ? { outcome: body.outcome } : {}),
      },
    };
    // One save (W13): the row, the touch and the next step; a refused todo leaves no row.
    const out = this.tx(() => {
      this.repo.insertLog(r);
      this.repo.retouch(contactId);
      if (!body.next) return {};
      const n = body.next;
      const dealId = n.dealId ?? body.dealId;
      const projectId = n.projectId ?? body.projectId;
      const t = this.todos.createTodo({ title: n.title, due: n.due, contactId, ...(dealId ? { dealId } : {}), ...(projectId ? { projectId } : {}) }, actor);
      if (!t.ok) throw new Rollback(t);
      return { todoId: t.value.id };
    });
    if ('ok' in out) return out;
    this.core.changed();
    return { ok: true, value: { id, ...out } };
  }

  /** His own row (not a meeting's link, a stage move or a created mark), or a refusal. */
  private ownRow(id: string): LogRecord | Refusal {
    const r = this.repo.logRow(id);
    if (!r || !r.contactId) return refuse('not_found', WORK_REASONS.noLog);
    if (r.meetingId !== null || r.kind === 'stage' || r.kind === 'created') return refuse('conflict', WORK_REASONS.logJantars);
    return r;
  }

  updateLog(id: string, patch: WorkLogPatch, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const r = this.ownRow(id);
    if ('ok' in r) return r;
    if (patch.at !== undefined && this.future(patch.at)) return refuse('invalid_request', WORK_REASONS.logFuture);
    const no = this.linksRefused(patch.dealId, patch.projectId);
    if (no) return no;
    const json = { ...r.json, updatedAt: this.stamp() };
    for (const key of ['direction', 'minutes', 'outcome', 'body'] as const) {
      const v = patch[key];
      if (v === null) delete json[key];
      else if (v !== undefined) (json as Record<string, unknown>)[key] = v;
    }
    const next: LogRecord = {
      ...r,
      json,
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.at !== undefined ? { at: new Date(Date.parse(patch.at)).toISOString() } : {}),
      ...(patch.dealId !== undefined ? { dealId: patch.dealId } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
    };
    this.core.db.tx(() => {
      this.repo.updateLog(next);
      if (r.contactId) this.repo.retouch(r.contactId);
    });
    this.core.changed();
    return OK;
  }

  removeLog(id: string, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const r = this.ownRow(id);
    if ('ok' in r) return r;
    this.core.db.tx(() => {
      this.repo.deleteLog(id);
      if (r.contactId) this.repo.retouch(r.contactId);
    });
    this.core.changed();
    return OK;
  }

  projectPart(projectId: string, clientId: string | undefined, actor: Actor): LifeResult<{ client?: WorkClientRef; log: WorkLogRow[]; deal?: WorkDealCard }> {
    if (!isOwner(actor)) return notFound;
    const c = clientId ? this.repo.contact(clientId) : null;
    // P3: its deal, an open one first, else the newest; its milestones with their progress.
    const mine = this.repo.allDeals().filter((d) => d.projectId === projectId);
    const deal = mine.length > 0 ? this.sortedCards(mine, this.cardContext())[0] : undefined;
    const steps = this.todos.milestones(projectId) ?? [];
    let milestones: WorkMilestonesView | undefined;
    if (steps.length > 0) {
      const p = milestoneProgress(steps, this.core.today());
      milestones = { items: steps, done: p.done, percent: p.percent, missed: p.missed, ...(p.next ? { next: p.next.id } : {}) };
    }
    return {
      ok: true,
      value: { ...(c ? { client: this.ref(c) } : {}), log: this.repo.logOfProject(projectId, WORK_LIMITS.projectLog).map(logView), ...(deal ? { deal } : {}), ...(milestones ? { milestones } : {}) },
    };
  }

  setMilestones(projectId: string, body: WorkMilestonesBody, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const now = this.todos.milestones(projectId);
    if (now === null) return refuse('not_found', TODO_REASONS.noProject);
    // A kept id stays (once each); anything else is a new milestone.
    const known = new Set(now.map((m) => m.id));
    const seen = new Set<string>();
    const list: WorkMilestone[] = body.milestones.map((m) => {
      const id = m.id !== undefined && known.has(m.id) && !seen.has(m.id) ? m.id : this.core.newId();
      seen.add(id);
      return { id, name: m.name, ...(m.target !== undefined ? { target: m.target } : {}), ...(m.done ? { done: true as const } : {}) };
    });
    return this.todos.setMilestones(projectId, list, actor);
  }

  // --- P2: meetings linked to clients (W15) ------------------------------------------------

  /** The automatic link a meeting should have: its project's client, when the project is his and has one. */
  private autoFor(m: WorkMeetingRef, projects?: ReadonlyMap<string, ProjectView>): { contactId: string; projectId: string } | null {
    if (!m.projectId) return null;
    const p = projects ? projects.get(m.projectId) : this.projects().find((x) => x.id === m.projectId);
    return p?.clientId && this.repo.hasContact(p.clientId) ? { contactId: p.clientId, projectId: p.id } : null;
  }

  /** A meeting's automatic row made to match `want` (his own rows and unlinks stay). The contacts touched. */
  private reconcile(m: WorkMeetingRef, want: { contactId: string; projectId: string } | null): string[] {
    const touched: string[] = [];
    const rows = this.repo.meetingRows(m.id);
    for (const r of rows) {
      if (!r.json.auto || r.json.off) continue;
      if (want && r.contactId === want.contactId) {
        if (r.projectId !== want.projectId || r.at !== m.startedAt) this.repo.updateLog({ ...r, projectId: want.projectId, at: m.startedAt });
        continue;
      }
      this.repo.deleteLog(r.id);
      if (r.contactId) touched.push(r.contactId);
    }
    if (want && !rows.some((r) => r.contactId === want.contactId)) {
      this.repo.insertLog({ id: this.core.newId(), contactId: want.contactId, dealId: null, projectId: want.projectId, meetingId: m.id, at: m.startedAt, kind: 'meeting', json: { auto: true } });
      touched.push(want.contactId);
    }
    for (const c of touched) this.repo.retouch(c);
    return touched;
  }

  meetingProject(m: WorkMeetingRef): void {
    const touched = this.core.db.tx(() => this.reconcile(m, this.autoFor(m)));
    if (touched.length > 0) this.core.changed();
  }

  forgetMeeting(meetingId: string): void {
    const touched = this.core.db.tx(() => {
      const contacts = this.repo.deleteMeeting(meetingId);
      for (const c of contacts) this.repo.retouch(c);
      return contacts;
    });
    if (touched.length > 0) this.core.changed();
  }

  resyncMeetings(meetings: readonly WorkMeetingRef[]): void {
    const projects = new Map(this.projects().map((p) => [p.id, p]));
    let changed = false;
    this.core.db.tx(() => {
      const known = new Set<string>();
      for (const m of meetings) {
        known.add(m.id);
        if (this.reconcile(m, this.autoFor(m, projects)).length > 0) changed = true;
      }
      // An automatic link whose meeting has no project any more (or is gone) goes.
      for (const r of this.repo.autoMeetingRows()) {
        if (r.meetingId && !known.has(r.meetingId) && !r.json.off) {
          this.repo.deleteLog(r.id);
          if (r.contactId) this.repo.retouch(r.contactId);
          changed = true;
        }
      }
    });
    if (changed) this.core.changed();
  }

  setMeetingClients(m: WorkMeetingRef, clientIds: readonly string[], actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const want = new Set(clientIds);
    for (const id of want) if (!this.repo.hasContact(id)) return refuse('invalid_request', WORK_REASONS.clientGone);
    const touched = new Set<string>();
    this.core.db.tx(() => {
      const rows = this.repo.meetingRows(m.id);
      for (const r of rows) {
        if (!r.contactId) continue;
        const keep = want.has(r.contactId);
        if (keep && r.json.off) {
          // Linked again by hand: his link now.
          this.repo.updateLog({ ...r, json: {} });
          touched.add(r.contactId);
        } else if (!keep && !r.json.off) {
          // Unlinked: his own row goes; an automatic one is kept as "unlinked" so it doesn't come back.
          if (r.json.auto) this.repo.updateLog({ ...r, json: { auto: true, off: true } });
          else this.repo.deleteLog(r.id);
          touched.add(r.contactId);
        }
      }
      for (const id of want) {
        if (rows.some((r) => r.contactId === id)) continue;
        this.repo.insertLog({ id: this.core.newId(), contactId: id, dealId: null, projectId: m.projectId, meetingId: m.id, at: m.startedAt, kind: 'meeting', json: {} });
        touched.add(id);
      }
      for (const c of touched) this.repo.retouch(c);
    });
    if (touched.size > 0) this.core.changed();
    return OK;
  }

  meetingSuggest(m: WorkMeetingRef & { people: readonly string[] }, actor: Actor): LifeResult<WorkMeetingSuggestReply> {
    if (!isOwner(actor)) return notFound;
    const linked = this.repo
      .meetingRows(m.id)
      .filter((r) => r.contactId && !r.json.off)
      .flatMap((r) => {
        const c = this.repo.contact(r.contactId as string);
        return c ? [{ id: c.id, name: c.name, auto: r.json.auto === true }] : [];
      });
    const auto = this.autoFor(m);
    const autoContact = auto ? this.repo.contact(auto.contactId) : null;
    const people = m.people.map((text, index) => {
      const key = normalizeContactName(text);
      const match = key ? this.repo.named(key)[0] : undefined;
      return { index, text, ...(match ? { match: { id: match.id, name: match.name } } : {}) };
    });
    return { ok: true, value: { linked, ...(autoContact ? { auto: { id: autoContact.id, name: autoContact.name } } : {}), people } };
  }

  meetingClientNew(m: WorkMeetingRef & { people: readonly string[] }, body: WorkMeetingClientNewBody, actor: Actor): LifeResult<{ id: string }> {
    if (!isOwner(actor)) return notFound;
    const text = m.people[body.person]?.trim().slice(0, 80).trim();
    if (!text) return refuse('not_found', WORK_REASONS.noPerson);
    // A speaker's display name is someone else's words (B2): the contact is marked `from: 'meeting'`.
    const out = this.tx(() => {
      const r = this.create({ name: text, ...(body.kind ? { kind: body.kind } : {}), ...(body.state ? { state: body.state } : {}) }, { from: 'meeting' });
      if (!r.ok) throw new Rollback(r);
      this.repo.insertLog({ id: this.core.newId(), contactId: r.value.id, dealId: null, projectId: m.projectId, meetingId: m.id, at: m.startedAt, kind: 'meeting', json: {} });
      this.repo.retouch(r.value.id);
      return { id: r.value.id };
    });
    if ('ok' in out) return out;
    this.core.changed();
    return { ok: true, value: out };
  }

  // --- P2: import and export (W27) -------------------------------------------------------

  /** Every contact as the duplicate check compares it. */
  private book(): { id: string; name: string; emails: readonly string[]; phones: readonly string[] }[] {
    return this.repo.allContacts().map((c) => ({ id: c.id, name: c.name, emails: c.emails, phones: c.phones.map((p) => p.value) }));
  }

  importPreview(body: WorkImportPreviewBody, actor: Actor): LifeResult<WorkImportPreviewReply> {
    if (!isOwner(actor)) return notFound;
    const src = readSource(body.format, body.text);
    if (typeof src === 'string') return refuse('invalid_request', PROBLEM[src]);
    const mapping = mappingFor(src, body.mapping);
    if (typeof mapping === 'string') return refuse('invalid_request', PROBLEM[mapping]);
    const { rows, skipped } = previewRows(src, mapping, this.book());
    const now = this.core.now().getTime();
    const id = this.core.newId();
    this.previews.put({ id, at: now, src, mapping });
    return {
      ok: true,
      value: { previewId: id, format: src.format, columns: src.columns, mapping, rows, skipped, expiresAt: new Date(now + WORK_LIMITS.importPreviewMs).toISOString() },
    };
  }

  importRows(body: WorkImportBody, actor: Actor): LifeResult<WorkImportReply> {
    if (!isOwner(actor)) return notFound;
    const kept = this.previews.get(body.previewId, this.core.now().getTime());
    if (!kept) return refuse('not_found', WORK_REASONS.previewGone);
    const mapping = body.mapping === undefined ? kept.mapping : mappingFor(kept.src, body.mapping);
    if (typeof mapping === 'string') return refuse('invalid_request', PROBLEM[mapping]);
    const { rows } = previewRows(kept.src, mapping, this.book());
    const byIndex = new Map(rows.map((r) => [r.index, r]));
    // One action a row (the last given wins); a row not named is skipped.
    const picks = new Map(body.rows.map((r) => [r.index, r.action]));
    const chosen: { fields: WorkImportFields; action: 'add' | 'fill'; dup?: string }[] = [];
    for (const [index, action] of picks) {
      const row = byIndex.get(index);
      if (!row) return refuse('invalid_request', WORK_REASONS.noRow);
      if (action === 'fill') {
        if (!row.dup) return refuse('invalid_request', WORK_REASONS.fillNeedsMatch);
        chosen.push({ fields: row.fields, action: 'fill', dup: row.dup.id });
      } else if (action === 'add') chosen.push({ fields: row.fields, action: 'add' });
    }
    const skipped = rows.length - chosen.length;
    const adds = chosen.filter((c) => c.action === 'add');
    // Each add may bring its company: the cap counts both.
    if (this.repo.contactCount() + adds.length + adds.filter((a) => a.fields.company).length > WORK_LIMITS.contacts) return refuse('conflict', WORK_REASONS.clientsFull);
    const batch = this.core.newId();
    const at = this.stamp();
    const out = this.tx(() => {
      let added = 0;
      let filled = 0;
      for (const c of chosen) {
        if (c.action === 'fill' && c.dup) {
          if (this.fill(c.dup, c.fields, at)) filled += 1;
          continue;
        }
        const f = c.fields;
        const r = this.create(
          {
            name: f.name,
            kind: f.kind,
            ...(f.state ? { state: f.state } : {}),
            ...(f.company && f.kind === 'person' ? { companyName: f.company } : {}),
            ...(f.title ? { title: f.title } : {}),
            ...(f.notes ? { notes: f.notes } : {}),
            ...(f.source ? { source: f.source } : {}),
            ...(f.city ? { city: f.city } : {}),
            tags: f.tags,
          },
          { from: 'import', importBatch: batch },
        );
        if (!r.ok) throw new Rollback(r);
        const made = this.repo.contact(r.value.id);
        if (made) {
          const { lastTouchAt: _t, ...rest } = made;
          this.repo.saveContact({ ...rest, phones: f.phones.map((value) => ({ value })), emails: f.emails, links: f.links });
        }
        added += 1;
      }
      const list = readImports(this.core.db, this.log);
      writeImports(this.core.db, [{ batch, at, added, filled }, ...list]);
      return { added, filled };
    });
    if ('ok' in out) return out;
    this.previews.remove(body.previewId);
    this.core.changed();
    return { ok: true, value: { batch, added: out.added, filled: out.filled, skipped } };
  }

  /** "Fill blanks" (B3): empty fields and room in the lists take the row's values; the contact is marked as imported. */
  private fill(id: string, f: WorkImportFields, at: string): boolean {
    const c = this.repo.contact(id);
    if (!c) return false;
    const { lastTouchAt: _t, ...next } = c;
    const union = <T>(a: readonly T[], b: readonly T[], key: (x: T) => string, max: number) => {
      const seen = new Set(a.map(key));
      return [...a, ...b.filter((x) => !seen.has(key(x)))].slice(0, max);
    };
    next.emails = union(c.emails, f.emails, normalizeContactEmail, WORK_LIMITS.emails);
    next.phones = union(c.phones, f.phones.map((value) => ({ value })), (p) => normalizeContactPhone(p.value) || p.value, WORK_LIMITS.phones);
    next.links = union(c.links, f.links, (l) => l, WORK_LIMITS.links);
    next.tags = union(c.tags, f.tags, (t) => t, WORK_LIMITS.tags);
    if (next.title === undefined && f.title) next.title = f.title;
    if (next.city === undefined && f.city) next.city = f.city;
    if (next.source === undefined && f.source) next.source = f.source;
    if (next.notes === undefined && f.notes) next.notes = f.notes;
    next.from = 'import';
    next.updatedAt = at;
    this.repo.saveContact(next);
    return true;
  }

  imports(actor: Actor): LifeResult<WorkImportsReply> {
    if (!isOwner(actor)) return notFound;
    const list = readImports(this.core.db, this.log);
    return { ok: true, value: { imports: list.map((e) => ({ ...e, undoUntil: new Date(Date.parse(e.at) + WORK_LIMITS.importUndoDays * DAY_MS).toISOString() })) } };
  }

  undoImport(batch: string, actor: Actor): LifeResult<WorkImportUndoReply> {
    if (!isOwner(actor)) return notFound;
    const list = readImports(this.core.db, this.log);
    const entry = list.find((e) => e.batch === batch);
    if (!entry) return refuse('not_found', WORK_REASONS.noImport);
    if (this.core.now().getTime() - Date.parse(entry.at) > WORK_LIMITS.importUndoDays * DAY_MS) return refuse('conflict', WORK_REASONS.importOld);
    const out = this.core.db.tx(() => {
      const added = this.repo.ofBatch(batch);
      const projects = new Set(this.projects().flatMap((p) => (p.clientId ? [p.clientId] : [])));
      const untouched = (c: ContactRecord) =>
        c.updatedAt === c.createdAt && this.repo.logCountOf(c.id) === 0 && this.repo.dealCountOf(c.id) === 0 && this.todos.followUpCount(c.id) === 0 && !projects.has(c.id);
      const go = new Set(added.filter(untouched).map((c) => c.id));
      // A company stays while someone outside what goes still works there.
      for (const c of added) if (c.kind === 'company' && go.has(c.id) && this.repo.peopleOf(c.id).some((p) => !go.has(p.id))) go.delete(c.id);
      for (const id of go) this.repo.deleteContact(id);
      writeImports(
        this.core.db,
        list.filter((e) => e.batch !== batch),
      );
      return { removed: go.size, kept: added.length - go.size };
    });
    this.core.changed();
    return { ok: true, value: out };
  }

  exportCsv(actor: Actor, what: 'clients' | 'deals' = 'clients'): LifeResult<string> {
    if (!isOwner(actor)) return notFound;
    if (what === 'deals') {
      const ctx = this.cardContext();
      const business = new Map(readBusinesses(this.core.db, this.log).map((b) => [b.id, b.name]));
      const project = new Map(this.projects().map((p) => [p.id, p.name]));
      return { ok: true, value: dealsCsv(this.repo.allDeals(), ctx, { business, project }) };
    }
    const all = this.repo.allContacts();
    const names = new Map(all.map((c) => [c.id, c.name]));
    const head = ['Name', 'Kind', 'State', 'Company', 'Title', 'Emails', 'Phones', 'Tags', 'City', 'Source', 'Check in (days)', 'Last touch', 'Added', 'Notes', 'Links'];
    const rows = all.map((c) => [
      c.name,
      c.kind,
      c.state,
      c.companyId ? (names.get(c.companyId) ?? '') : '',
      c.title ?? '',
      c.emails.join('; '),
      c.phones.map((p) => p.value).join('; '),
      c.tags.join('; '),
      c.city ?? '',
      c.source ?? '',
      c.checkInDays ?? '',
      c.lastTouchAt ?? '',
      c.createdAt,
      c.notes ?? '',
      c.links.join('; '),
    ]);
    return { ok: true, value: `${toCsv(head, rows)}\r\n` };
  }

  // --- P2: settings (W44) ------------------------------------------------------------------

  settingsGet(actor: Actor): LifeResult<WorkSettings> {
    if (!isOwner(actor)) return notFound;
    const prefs = readPrefs(this.core.db, this.log);
    return {
      ok: true,
      value: { businesses: readBusinesses(this.core.db, this.log), ...(prefs.dialCode ? { dialCode: prefs.dialCode } : {}), quietDays: prefs.quietDays, lockScreenNames: this.core.settings().workLockScreenNames },
    };
  }

  settingsUpdate(patch: WorkSettingsPatch, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const db = this.core.db;
    db.tx(() => {
      if (patch.businesses !== undefined) {
        const now = readBusinesses(db, this.log);
        const known = new Set(now.map((b) => b.id));
        writeBusinesses(
          db,
          patch.businesses.map((b) => ({ id: b.id && known.has(b.id) ? b.id : this.core.newId(), name: b.name })),
        );
      }
      if (patch.dialCode !== undefined || patch.quietDays !== undefined) {
        const prefs = readPrefs(db, this.log);
        if (patch.dialCode === null) delete prefs.dialCode;
        else if (patch.dialCode !== undefined) prefs.dialCode = patch.dialCode;
        if (patch.quietDays !== undefined) prefs.quietDays = patch.quietDays;
        writePrefs(db, prefs);
      }
    });
    this.core.changed();
    return OK;
  }

  // --- P2: client_here (jantar mcp, ctl.sock) ------------------------------------------------

  forFolder(folder: string): FolderClientResponse {
    const at = folderKey(folder);
    const here = this.todos.forFolder(folder).project;
    const project = here ? this.projects().find((p) => p.id === here.id) : undefined;
    let c: ContactRecord | null = project?.clientId ? this.repo.contact(project.clientId) : null;
    if (!c) {
      const broad = new Set([...BROAD_FOLDERS, folderKey(this.home).toLowerCase()]);
      const linked: { p: ContactRecord; folder: string }[] = [];
      for (const x of this.repo.allContacts()) {
        if (!x.folder) continue;
        const key = folderKey(x.folder);
        if (!broad.has(key.toLowerCase()) || key === at) linked.push({ p: x, folder: key });
      }
      c = projectFor(at, linked)?.p ?? null;
    }
    if (!c) return { client: null };
    const company = c.companyId ? this.repo.contact(c.companyId) : null;
    const next = this.todos.followUps(c.id, false)[0];
    const deals = this.repo.openDeals().get(c.id)?.count ?? 0;
    // P3: its open deals by title and stage (his words, or an import's, marked).
    const ctx = this.cardContext();
    const open = this.sortedCards(this.repo.dealsOf([c.id]), ctx).filter((d) => d.kind === 'open').slice(0, WORK_LIMITS.hereDeals);
    return {
      client: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        state: c.state,
        ...(c.from ? { source: c.from } : {}),
        ...(company ? { company: { id: company.id, name: company.name, ...(company.from ? { source: company.from } : {}) } } : {}),
        ...(project && project.clientId === c.id ? { project: { id: project.id, name: project.name } } : {}),
        ...(next ? { next: { title: next.title, ...(next.due ? { due: next.due } : {}), ...(next.from === 'meeting' ? { source: 'meeting' as const } : {}) } } : {}),
        ...(c.lastTouchAt ? { lastTouchAt: c.lastTouchAt } : {}),
        openDeals: deals,
        ...(open.length > 0 ? { deals: open.map((d) => ({ title: d.title, stage: d.stageName, ...(d.from ? { source: d.from } : {}) })) } : {}),
      },
    };
  }

  // --- P3b: the starter lists, duplicates and merge ---------------------------------------

  /** Each client as a list reads it, with the stages of its open deals. */
  private listClients(all: readonly ContactRecord[]): Map<string, ListClient> {
    const stages = stageIndex(this.stages());
    const open = new Map<string, string[]>();
    for (const d of this.repo.allDeals()) {
      if (dealKind(d, stages) !== 'open') continue;
      const list = open.get(d.contactId) ?? [];
      list.push(d.stage);
      open.set(d.contactId, list);
    }
    return new Map(
      all.map((c) => [
        c.id,
        { state: c.state, kind: c.kind, tags: c.tags, emails: c.emails, source: c.source, checkInDays: c.checkInDays, lastTouchAt: c.lastTouchAt, createdAt: c.createdAt, openDealStages: open.get(c.id) ?? [] },
      ]),
    );
  }

  clientLists(actor: Actor): LifeResult<WorkClientListsReply> {
    if (!isOwner(actor)) return notFound;
    const listed = [...this.listClients(this.repo.allContacts()).values()];
    const now = this.core.now();
    const names = Object.fromEntries(this.stages().map((x) => [x.id, x.name]));
    return {
      ok: true,
      value: {
        lists: starterClientLists().map((l) => ({
          id: l.id as WorkClientListsReply['lists'][number]['id'],
          name: l.name,
          description: describeClientList(l.filters, names),
          count: listed.filter((c) => matchesClientList(c, l.filters, now)).length,
        })),
      },
    };
  }

  duplicates(actor: Actor): LifeResult<WorkDuplicatesReply> {
    if (!isOwner(actor)) return notFound;
    const all = this.repo.allContacts();
    const byId = new Map(all.map((c) => [c.id, c]));
    // His "not a duplicate" rulings, either way round.
    const dismissed = new Set(all.flatMap((c) => (c.notDuplicateOf ?? []).map((o) => duplicatePairKey(c.id, o))));
    const groups = findDuplicateGroups(
      all.map((c) => ({ id: c.id, name: c.name, emails: c.emails, phones: c.phones.map((p) => p.value) })),
      dismissed,
    );
    return {
      ok: true,
      value: {
        groups: groups.slice(0, WORK_LIMITS.duplicateGroups).map((g) => ({
          key: g.key,
          reasons: g.reasons,
          clients: g.contactIds.flatMap((id) => {
            const c = byId.get(id);
            if (!c) return [];
            const co = c.companyId ? byId.get(c.companyId) : undefined;
            return [{ id: c.id, name: c.name, kind: c.kind, state: c.state, ...(co ? { company: { id: co.id, name: co.name } } : {}), ...(c.from ? { from: c.from } : {}) }];
          }),
        })),
      },
    };
  }

  /** The two clients a merge names: this one and the loser (two people or two companies), or a refusal. */
  private mergePair(id: string, loserId: string): { w: ContactRecord; l: ContactRecord } | Refusal {
    const w = this.repo.contact(id);
    if (!w) return refuse('not_found', WORK_REASONS.noClient);
    if (loserId === id) return refuse('invalid_request', WORK_REASONS.mergeSelf);
    const l = this.repo.contact(loserId);
    if (!l) return refuse('invalid_request', WORK_REASONS.clientGone);
    if (w.kind !== l.kind) return refuse('invalid_request', WORK_REASONS.mergeKinds);
    return { w, l };
  }

  private mergeable(c: ContactRecord): MergeableContact {
    return { ...c, phones: c.phones, emails: c.emails, links: c.links, tags: c.tags };
  }

  mergeConflicts(id: string, loserId: string, actor: Actor): LifeResult<WorkMergeConflictsReply> {
    if (!isOwner(actor)) return notFound;
    const pair = this.mergePair(id, loserId);
    if ('ok' in pair) return pair;
    // A company reads by its name, not its id.
    const company = (cid: string) => this.repo.contact(cid)?.name ?? '';
    const conflicts = contactMergeConflicts(this.mergeable(pair.w), this.mergeable(pair.l)).map((c) =>
      c.field === 'companyId' ? { ...c, survivor: company(c.survivor), loser: company(c.loser) } : c,
    );
    return { ok: true, value: { conflicts } };
  }

  merge(id: string, body: WorkMergeBody, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const pair = this.mergePair(id, body.loserId);
    if ('ok' in pair) return pair;
    const { w, l } = pair;
    const plan = planContactMerge(this.mergeable(w), this.mergeable(l), body.picks ?? []);
    const at = this.stamp();
    const { lastTouchAt: _t, ...stored } = w;
    const next: Contact = {
      ...stored,
      name: plan.name,
      state: plan.state,
      phones: plan.phones.slice(0, WORK_LIMITS.phones),
      emails: plan.emails.slice(0, WORK_LIMITS.emails),
      links: plan.links.slice(0, WORK_LIMITS.links),
      tags: plan.tags.slice(0, WORK_LIMITS.tags),
      updatedAt: at,
    };
    for (const key of ['title', 'city', 'source', 'notes', 'folder', 'checkInDays', 'companyId', 'from'] as const) {
      const v = plan[key];
      if (v === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = v;
    }
    // A company that is still one (never the survivor itself).
    if (next.companyId !== undefined) {
      const co = this.repo.contact(next.companyId);
      if (!co || co.kind !== 'company' || co.id === w.id || next.kind === 'company') delete next.companyId;
    }
    if (plan.notDuplicateOf.length > 0) next.notDuplicateOf = plan.notDuplicateOf.slice(-WORK_LIMITS.notDuplicateOf);
    else delete next.notDuplicateOf;
    this.core.db.tx(() => {
      this.repo.saveContact(next);
      // Everything that named the loser names the survivor: deals, the log, follow-ups, projects, people.
      this.repo.repointContact(l.id, w.id, at);
      this.todos.relinkClient(l.id, w.id);
      for (const p of this.repo.peopleOf(l.id)) {
        const { lastTouchAt: _p, ...rest } = p;
        this.repo.saveContact({ ...rest, companyId: w.id, updatedAt: at });
      }
      this.repo.tombstone(l.id, w.id, at);
      this.repo.retouch(w.id);
    });
    this.core.changed();
    return OK;
  }

  notDuplicate(id: string, otherId: string, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const a = this.repo.contact(id);
    if (!a) return refuse('not_found', WORK_REASONS.noClient);
    const b = otherId === id ? null : this.repo.contact(otherId);
    if (!b) return refuse('invalid_request', WORK_REASONS.clientGone);
    const at = this.stamp();
    const ruled = (c: ContactRecord, other: string): Contact => {
      const { lastTouchAt: _t, ...rest } = c;
      const list = [...(c.notDuplicateOf ?? []).filter((x) => x !== other), other].slice(-WORK_LIMITS.notDuplicateOf);
      return { ...rest, notDuplicateOf: list, updatedAt: at };
    };
    this.core.db.tx(() => {
      this.repo.saveContact(ruled(a, b.id));
      this.repo.saveContact(ruled(b, a.id));
    });
    this.core.changed();
    return OK;
  }

  // --- P3: deals ------------------------------------------------------------------------

  dealRecord(id: string): Deal | null {
    return this.repo.deal(id);
  }

  deals(q: WorkDealsQuery, actor: Actor): LifeResult<WorkDealsResponse> {
    if (!isOwner(actor)) return notFound;
    const ctx = this.cardContext();
    const base = this.repo.allDeals().filter((d) => q.business === undefined || d.business === q.business);
    const folded = q.q ? foldText(q.q) : '';
    const list = base.filter((d) => {
      const open = dealKind(d, ctx.stages) === 'open';
      if (q.open !== open) return false;
      if (q.stage !== undefined && d.stage !== q.stage) return false;
      if (q.client !== undefined && d.contactId !== q.client) return false;
      if (q.closing !== undefined && !(open && inClosingWindow(d.expectedClose, q.closing, ctx.today))) return false;
      if (q.q !== undefined && !holdsFolded(folded, d.title, ctx.contacts.get(d.contactId)?.name)) return false;
      return true;
    });
    const cards = this.sortedCards(list, ctx).filter((c) => q.quiet === undefined || c.quiet === q.quiet);
    return { ok: true, value: { deals: cards.slice(0, WORK_LIMITS.dealsPage), more: Math.max(0, cards.length - WORK_LIMITS.dealsPage), stages: stageColumns(base, ctx) } };
  }

  /** The sources already in use (the spelling a typed one joins). */
  private sources(): string[] {
    return [...new Set(this.repo.allDeals().flatMap((d) => (d.source ? [d.source] : [])))];
  }

  /** A business and a project a deal may name: refused when gone (a business he removed, a project not his). */
  private dealLinksRefused(business: string | null | undefined, projectId: string | null | undefined): Refusal | null {
    if (business && !this.hasBusiness(business)) return refuse('invalid_request', WORK_REASONS.businessGone);
    if (projectId && !this.projects().some((p) => p.id === projectId)) return refuse('invalid_request', WORK_REASONS.projectGone);
    return null;
  }

  createDeal(body: WorkDealCreateBody, actor: Actor): LifeResult<WorkDealCreateReply> {
    if (!isOwner(actor)) return notFound;
    if (this.repo.dealCount() >= WORK_LIMITS.deals) return refuse('conflict', WORK_REASONS.dealsFull);
    if (this.repo.openDealCount() >= WORK_LIMITS.openDeals) return refuse('conflict', WORK_REASONS.openDealsFull);
    if (this.repo.logCount() >= WORK_LIMITS.logRows) return refuse('conflict', WORK_REASONS.logFull);
    const stages = this.stages();
    const stage = body.stage === undefined ? stages.find((x) => x.kind === 'open') : stages.find((x) => x.id === body.stage);
    if (!stage) return refuse('invalid_request', WORK_REASONS.noStage);
    if (stage.kind !== 'open') return refuse('invalid_request', WORK_REASONS.startOpen);
    if (body.clientId !== undefined && !this.repo.hasContact(body.clientId)) return refuse('invalid_request', WORK_REASONS.clientGone);
    const no = this.dealLinksRefused(body.business, body.projectId);
    if (no) return no;
    const at = this.stamp();
    const source = body.source !== undefined ? canonicalSource(body.source, this.sources()) : '';
    const currency = body.currency ?? this.core.settings().currency ?? undefined;
    const out = this.tx(() => {
      // A client by name: one with that name (a company first), else a new company, a lead.
      let contactId = body.clientId;
      if (contactId === undefined) {
        const named = this.namedAs(body.clientName ?? '');
        const found = named.find((c) => c.kind === 'company') ?? named[0];
        if (found) contactId = found.id;
        else {
          const r = this.create({ name: body.clientName ?? '', kind: 'company' }, {});
          if (!r.ok) throw new Rollback(r);
          contactId = r.value.id;
        }
      }
      const d: Deal = {
        id: this.core.newId(),
        title: body.title,
        contactId,
        stage: stage.id,
        ...(body.value !== undefined ? { value: body.value } : {}),
        ...(currency ? { currency } : {}),
        ...(body.expectedClose !== undefined ? { expectedClose: body.expectedClose } : {}),
        ...(source ? { source } : {}),
        ...(body.business !== undefined ? { business: body.business } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        stageMovedAt: at,
        createdAt: at,
        updatedAt: at,
      };
      this.repo.saveDeal(d);
      // Its "added" row: the stage it entered (the funnel's first count).
      this.repo.insertLog({ id: this.core.newId(), contactId, dealId: d.id, projectId: d.projectId ?? null, meetingId: null, at, kind: 'created', json: { stageTo: stage.id } });
      return { id: d.id, clientId: contactId };
    });
    if ('ok' in out) return out;
    this.core.changed();
    return { ok: true, value: out };
  }

  deal(id: string, actor: Actor): LifeResult<WorkDealHub> {
    if (!isOwner(actor)) return notFound;
    const d = this.repo.deal(id);
    if (!d) return refuse('not_found', WORK_REASONS.noDeal);
    const ctx = this.cardContext();
    const c = ctx.contacts.get(d.contactId);
    const project = d.projectId ? this.projects().find((p) => p.id === d.projectId) : undefined;
    const limit = WORK_LIMITS.dealLog;
    const rows = [...this.repo.logOfDeal(id, limit).map(logView), ...this.todos.dealFollowUps(id, true).map(followUpView)].sort(newer).slice(0, limit);
    return {
      ok: true,
      value: {
        deal: d,
        card: dealCard(d, ctx),
        client: c ? this.ref(c) : { id: d.contactId, name: '', state: 'lead' },
        ...(project ? { project } : {}),
        followUps: this.todos.dealFollowUps(id, false),
        log: rows,
      },
    };
  }

  updateDeal(id: string, patch: WorkDealPatch, actor: Actor): LifeResult {
    if (!isOwner(actor)) return notFound;
    const d = this.repo.deal(id);
    if (!d) return refuse('not_found', WORK_REASONS.noDeal);
    if (patch.clientId !== undefined && patch.clientId !== d.contactId && !this.repo.hasContact(patch.clientId)) return refuse('invalid_request', WORK_REASONS.clientGone);
    const no = this.dealLinksRefused(patch.business === d.business ? undefined : patch.business, patch.projectId === d.projectId ? undefined : patch.projectId);
    if (no) return no;
    const lost = dealKind(d, stageIndex(this.stages())) === 'lost';
    if (!lost && ((patch.lostCode ?? null) !== null || (patch.lostNote ?? null) !== null)) return refuse('invalid_request', WORK_REASONS.notLost);
    const next: Deal = { ...d, updatedAt: this.stamp() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.clientId !== undefined) next.contactId = patch.clientId;
    if (patch.currency !== undefined) next.currency = patch.currency;
    if (patch.source === null) delete next.source;
    else if (patch.source !== undefined) next.source = canonicalSource(patch.source, this.sources()) || patch.source;
    for (const key of ['value', 'expectedClose', 'business', 'projectId', 'lostCode', 'lostNote'] as const) {
      const v = patch[key];
      if (v === null) delete next[key];
      else if (v !== undefined) (next as Record<string, unknown>)[key] = v;
    }
    this.core.db.tx(() => {
      this.repo.saveDeal(next);
      // Its own rows (moves, "added") follow it to its new client; calls and notes stay with whom they were logged.
      if (next.contactId !== d.contactId) this.repo.moveDealLog(id, next.contactId);
    });
    this.core.changed();
    return OK;
  }

  removeDeal(id: string, actor: Actor): LifeResult<{ log: number }> {
    if (!isOwner(actor)) return notFound;
    if (!this.repo.hasDeal(id)) return refuse('not_found', WORK_REASONS.noDeal);
    const log = this.core.db.tx(() => {
      const n = this.repo.forgetDealLog(id);
      this.todos.unlinkDeal(id);
      this.repo.deleteDeal(id);
      return n;
    });
    this.core.changed();
    return { ok: true, value: { log } };
  }

  moveDeal(id: string, body: WorkDealMoveBody, actor: Actor): LifeResult<WorkDealMoveReply> {
    if (!isOwner(actor)) return notFound;
    const d = this.repo.deal(id);
    if (!d) return refuse('not_found', WORK_REASONS.noDeal);
    const stages = stageIndex(this.stages());
    const to = stages.get(body.stage)?.stage;
    if (!to) return refuse('invalid_request', WORK_REASONS.noStage);
    const reason = body.lostCode !== undefined || body.lostNote !== undefined;
    if (reason && to.kind !== 'lost') return refuse('invalid_request', WORK_REASONS.reasonNeedsLost);
    if (body.project && to.kind !== 'won') return refuse('invalid_request', WORK_REASONS.projectNeedsWon);
    if (body.project && d.projectId && this.projects().some((p) => p.id === d.projectId)) return refuse('conflict', WORK_REASONS.hasProject);
    const was = dealKind(d, stages);
    const from = d.stage;
    const moved = from !== to.id;
    if (!moved && !body.project && !reason) return { ok: true, value: { id, from } };
    if (to.kind === 'open' && was !== 'open' && this.repo.openDealCount() >= WORK_LIMITS.openDeals) return refuse('conflict', WORK_REASONS.openDealsFull);
    if (moved && this.repo.logCount() >= WORK_LIMITS.logRows) return refuse('conflict', WORK_REASONS.logFull);
    const at = this.stamp();
    const next: Deal = { ...d, stage: to.id, updatedAt: at, ...(moved ? { stageMovedAt: at } : {}) };
    if (to.kind !== 'lost' || was !== 'lost') {
      delete next.lostCode;
      delete next.lostNote;
    }
    if (to.kind === 'open') {
      // Open again: no longer won or lost.
      delete next.wonAt;
      delete next.lostAt;
    } else if (to.kind === 'won') {
      delete next.lostAt;
      if (was !== 'won') next.wonAt = at;
    } else {
      delete next.wonAt;
      if (was !== 'lost') next.lostAt = at;
      if (body.lostCode !== undefined) next.lostCode = body.lostCode;
      if (body.lostNote !== undefined) {
        if (body.lostNote === '') delete next.lostNote;
        else next.lostNote = body.lostNote;
      }
    }
    const out = this.tx(() => {
      if (body.project) {
        const business = d.business && this.hasBusiness(d.business) ? d.business : undefined;
        const r = this.todos.createProject({ name: body.project.name, ...(body.project.folder ? { folder: body.project.folder } : {}), clientId: d.contactId, ...(business ? { business } : {}) }, actor);
        if (!r.ok) throw new Rollback(r);
        next.projectId = r.value.id;
      }
      this.repo.saveDeal(next);
      if (moved) this.repo.insertLog({ id: this.core.newId(), contactId: d.contactId, dealId: id, projectId: next.projectId ?? null, meetingId: null, at, kind: 'stage', json: { stageFrom: from, stageTo: to.id } });
      // Won makes its client a client; losing never demotes one (W7).
      if (to.kind === 'won') {
        const c = this.repo.contact(d.contactId);
        if (c && c.state === 'lead') {
          const { lastTouchAt: _t, ...rest } = c;
          this.repo.saveContact({ ...rest, state: 'client', updatedAt: at });
        }
      }
      return next.projectId !== d.projectId && next.projectId ? { projectId: next.projectId } : {};
    });
    if ('ok' in out) return out;
    this.core.changed();
    return { ok: true, value: { id, from, ...out } };
  }

  // --- P3: stages ------------------------------------------------------------------------

  stagesGet(actor: Actor): LifeResult<WorkStagesReply> {
    if (!isOwner(actor)) return notFound;
    const list = this.stages();
    const info = stageIndex(list);
    const counts = this.repo.dealsByStage();
    return {
      ok: true,
      value: {
        stages: list.map((st, order) => ({ ...st, order, effectiveProbability: info.get(st.id)?.probability ?? 0, deals: counts[st.id] ?? 0 })),
        quietDays: readPrefs(this.core.db, this.log).quietDays,
      },
    };
  }

  stagesPut(body: WorkStagesBody, actor: Actor): LifeResult<{ moved: number }> {
    if (!isOwner(actor)) return notFound;
    const current = this.stages();
    const byId = new Map(current.map((x) => [x.id, x]));
    const seen = new Set<string>();
    const next: WorkStage[] = [];
    for (const b of body.stages) {
      const was = b.id === undefined ? undefined : byId.get(b.id);
      if (b.id !== undefined && !was) return refuse('invalid_request', WORK_REASONS.noStage);
      if (was && seen.has(was.id)) return refuse('invalid_request', WORK_REASONS.stageTwice);
      if (was) seen.add(was.id);
      // A kept stage keeps its kind; a new one is open. Left out, a probability or quiet days stay as they were; null clears.
      const kind = was?.kind ?? 'open';
      const probability = b.probability === undefined ? was?.probability : (b.probability ?? undefined);
      const quietDays = b.quietDays === undefined ? was?.quietDays : (b.quietDays ?? undefined);
      next.push({
        id: was?.id ?? this.core.newId(),
        name: b.name,
        kind,
        ...(kind === 'open' && probability !== undefined ? { probability } : {}),
        ...(kind === 'open' && quietDays !== undefined ? { quietDays } : {}),
      });
    }
    if (current.some((x) => x.kind !== 'open' && !seen.has(x.id)) || stageInvariantError(next) !== null) return refuse('conflict', WORK_REASONS.keepEnds);
    const moves = (body.moves ?? []).map((m) => ({ fromStageId: m.from, toStageId: m.to }));
    for (const m of moves) {
      const target = next.find((x) => x.id === m.toStageId);
      if (target && target.kind !== 'open') return refuse('invalid_request', WORK_REASONS.moveToOpen);
    }
    const plan = planStageDeletions(current, next, this.repo.dealsByStage(), moves);
    if (!plan.ok) return refuse('conflict', WORK_REASONS.stageHasDeals);
    const at = this.stamp();
    const moved = this.core.db.tx(() => {
      // Re-filed, not moved: no stage row, and each deal's stage time stays (the funnel never counts it).
      let n = 0;
      for (const m of plan.moves) n += this.repo.refileStage(m.fromStageId, m.toStageId, at);
      writeStages(this.core.db, next);
      return n;
    });
    this.core.changed();
    return { ok: true, value: { moved } };
  }

  // --- P3: insights ------------------------------------------------------------------------

  insights(q: WorkInsightsQuery, actor: Actor): LifeResult<WorkInsightsReply> {
    if (!isOwner(actor)) return notFound;
    const now = this.core.now();
    const tz = this.core.tz();
    const from = resolveAnalyticsPeriod(q.period, now, tz).from;
    const deals = this.repo.allDeals().filter((d) => q.business === undefined || d.business === q.business);
    return {
      ok: true,
      value: insightsOf({ period: q.period, deals, stages: this.stages(), moves: this.repo.stageRows(from.toISOString()), now, tz, currency: this.core.settings().currency }),
    };
  }
}

/**
 * Builds Work on `core`, after Todos (the service hands it over), and
 * registers its links with Todos: the ids it owns, a project's client
 * changing, and a project's delete.
 */
export function buildWorkModule(core: LifeCore, deps: LifeModuleDeps, todos: TodosModule): WorkModule {
  const work = new Work(core, todos, deps.ctx.log.child({ part: 'life', module: 'work' }), deps.ctx.paths.userHome, () => deps.meetings?.() ?? null);
  todos.onProjectDeleted((id) => work.projectDeleted(id));
  todos.useWork({
    contact: (id) => work.hasContact(id),
    deal: (id) => work.hasDeal(id),
    business: (id) => work.hasBusiness(id),
    projectClient: (projectId, before, after) => work.projectClient(projectId, before, after),
  });
  return work;
}
