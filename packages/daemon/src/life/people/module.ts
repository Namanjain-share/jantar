/**
 * v0.12 People: the people on this Mac, their invites, devices and consent,
 * pause, leave and remove (spec 1.2, 2, 8.3).
 *
 * Two stores, on purpose (D7, D19):
 * - jantar.db holds her credentials (devices, link codes, invites, push
 *   list) and the consent ledger (`person_consents`). The ledger is
 *   authoritative for her state: `joined`, `paused`, `resumed`, `ending`,
 *   `left`, `removed` and `forgotten` rows move it. So her exits (Leave,
 *   Pause) work on jantar.db alone while life.db is broken (C12), and a
 *   life.db restore can't bring a forgotten person back (C11).
 * - life.db holds the person row (name, colour, modules, prefs, the
 *   pending proposal's note) and her Activity. Its `state` mirrors the
 *   ledger; when they disagree, the more closed one wins (reconcile).
 *
 * The owner is `''` and is never a row. Every refusal of a person or row the
 * caller may not see is the one not_found sentence (a refusal confirms
 * nothing). Logs carry ids and codes only, never her name or email.
 */
import {
  BUILT_PHASE,
  PEOPLE_MAX,
  PERSON_COLORS,
  PERSON_ENDING_DAYS,
  PERSON_FORGET_DAYS,
  PROPOSAL_COOLING_DAYS,
  AGREEMENT_FIELDS,
  AgreementFieldsSchema,
  AgreementSchema,
  agreementProblem,
  agreementWithin,
  applyAgreementPatch,
  clampToBuilt,
  closeDependents,
  fieldsChanged,
  fieldsOn,
  levelOf,
  noAgreement,
  phaseBuilt,
  presetAgreement,
  sharedSpaceId,
  unbuiltFieldsIn,
  type Agreement,
  type AgreementFields,
  type AgreementPatch,
  type Area,
  type DontAsk,
  type JoinBody,
  type JoinPreview,
  type Person,
  type PersonActivity,
  type PersonAddBody,
  type PersonMe,
  type PersonOfferBody,
  type PersonProposeBody,
  type PersonState,
  type PersonView,
} from '@jantar/protocol/people';
import { hasScope } from '../../auth/scopes.js';
import { PersonInvites, PersonLinkCodes } from '../../auth/person-codes.js';
import { PersonDeviceAuth, publicPersonDevice } from '../../auth/person-devices.js';
import type { ConsentRecord, DaemonContext, LifeCore, LifePush, LifeResult, Logger, PersonDeviceRecord } from '../../contracts.js';
import { newId } from '../../core/ids.js';
import { PeopleRepo, type ActivityInput } from './repo.js';
import { PersonTicks } from './ticks.js';

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Fixed daemon sentences; never her text. */
export const PEOPLE_REASONS = {
  noPerson: 'No such person.',
  full: `People holds ${PEOPLE_MAX} person on this Mac for now.`,
  invalidCode: 'This invite link has expired or was already used. Ask for a new one.',
  invalidLink: 'This code has expired or was already used. Make a new one on your other device.',
  widen: 'The agreement asks for more than the invite offered.',
  version: 'This invite changed since you opened it. Open the link again.',
  unbuilt: 'That area is not part of this version of Jantar.',
  notJoined: 'This person has not joined yet.',
  joined: 'This person has already joined.',
  left: 'This person has left. Add them again to send a new invite.',
  pending: 'A request is already waiting for an answer.',
  noPending: 'There is no request waiting for an answer.',
  nothingNew: 'That asks for nothing new.',
  cooling: (day: string) => `That was declined recently. It can be asked again from ${day}.`,
  dontAsk: 'That was declined with "Don\'t ask me about this again".',
  lastDevice: 'To end sharing, use `jantar people remove` on your Mac. It gives them 7 days to download their data.',
  hasRows: 'They have food entries. They can export or delete them first.',
  devicesFull: 'Five devices are linked already. Revoke one first.',
  ending: 'Sharing is ending. Download your data instead.',
  noLink: 'Make a new link on your Mac: jantar people invite',
  emailMismatch: (email: string) => `This invite is for a different email. You're signed in as ${email}.`,
  notNarrower: 'Narrowing can only turn things down.',
  lifeClosed: 'Life is not open right now. Try again in a moment.',
  setupAgain: 'Sharing needs to be set up again.',
} as const;

/** The state the gate and his screens act on (ledger first, D19). */
export type GateState = 'active' | 'paused' | 'ending' | 'gone' | 'setup_again';

interface LedgerView {
  /** null: never joined (invited, or not a person). */
  state: PersonState | 'forgotten' | null;
  until?: string;
  agreement: Agreement | null;
  offer: { version: number; fields: AgreementFields } | null;
  pending: { version: number; fields: AgreementFields } | null;
  maxVersion: number;
  declinedAt: Map<string, string>;
}

/** Where a People push goes: the owner's devices, or hers. */
export type PeoplePush = LifePush & { person?: string };

export interface PeopleDeps {
  ctx: Pick<DaemonContext, 'settings' | 'clock' | 'db' | 'log'>;
  /** The open Life core, or null while life.db is closed or broken. */
  core: () => LifeCore | null;
  /** Sends one People push (Web Push only, through sendLifePush; push.ts). */
  push: (p: PeoplePush) => void;
}

export class PeopleModule {
  readonly ticks = new PersonTicks();
  readonly devices: PersonDeviceAuth;
  readonly invites: PersonInvites;
  readonly linkCodes: PersonLinkCodes;
  private readonly repo: PeopleRepo;
  private readonly log: Logger;
  /** Owner ticks: his devices re-fetch (life.changed {}) when her sharing changes (C24). */
  ownerChanged: () => void = () => {};

  constructor(private readonly deps: PeopleDeps) {
    const { ctx } = deps;
    this.log = ctx.log.child ? ctx.log.child({ part: 'people' }) : ctx.log;
    this.devices = new PersonDeviceAuth({ db: ctx.db, clock: ctx.clock, log: this.log });
    this.invites = new PersonInvites({ db: ctx.db, clock: ctx.clock });
    this.linkCodes = new PersonLinkCodes({ db: ctx.db, clock: ctx.clock });
    this.repo = new PeopleRepo(() => this.lifeCore(), this.log);
  }

  // ---------------------------------------------------------------------------
  // Basics

  enabled(): boolean {
    return this.deps.ctx.settings.get().people.enabled;
  }

  ownerName(): string {
    return this.deps.ctx.settings.get().people.ownerName ?? 'The owner';
  }

  private now(): number {
    return this.deps.ctx.clock.now();
  }

  private iso(ms = this.now()): string {
    return this.deps.ctx.clock.iso(ms);
  }

  private lifeCore(): LifeCore {
    const c = this.deps.core();
    if (!c) throw new LifeClosedError();
    return c;
  }

  /** Whether life.db is open now (her rows, Activity). */
  lifeOpen(): boolean {
    return this.deps.core() !== null;
  }

  /** The open Life core, or null (her export reads her rows through it). */
  openCore(): LifeCore | null {
    return this.deps.core();
  }

  /** The ledger rows of a person, oldest first (her export's sharing history). */
  ledgerRows(pid: string): ConsentRecord[] {
    return this.deps.ctx.db.people.consents.listFor(pid);
  }

  private guard<T>(fn: () => LifeResult<T>): LifeResult<T> {
    try {
      return fn();
    } catch (e) {
      if (e instanceof LifeClosedError) return { ok: false, code: 'unavailable', reason: PEOPLE_REASONS.lifeClosed };
      throw e;
    }
  }

  private notFound<T>(): LifeResult<T> {
    return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.noPerson };
  }

  // ---------------------------------------------------------------------------
  // The ledger (jantar.db): her state and the agreement

  private ledger(pid: string): LedgerView {
    const rows = this.deps.ctx.db.people.consents.listFor(pid);
    const out: LedgerView = { state: null, agreement: null, offer: null, pending: null, maxVersion: 0, declinedAt: new Map() };
    for (const r of rows) {
      out.maxVersion = Math.max(out.maxVersion, r.version);
      const fields = r.json.agreement ? AgreementFieldsSchema.safeParse(r.json.agreement) : null;
      const agreement = fields?.success ? { ...fields.data, version: r.version } : null;
      switch (r.action) {
        case 'offered':
          if (fields?.success) out.offer = { version: r.version, fields: fields.data };
          break;
        case 'joined':
          out.state = 'active';
          out.agreement = agreement;
          break;
        case 'accepted':
          if (agreement) out.agreement = agreement;
          out.pending = null;
          break;
        case 'narrowed':
          if (agreement) out.agreement = agreement;
          break;
        case 'proposed':
          if (fields?.success) out.pending = { version: r.version, fields: fields.data };
          break;
        case 'declined':
          if (out.pending) {
            const base = out.agreement ?? noAgreement();
            for (const k of fieldsChanged(base, out.pending.fields)) out.declinedAt.set(k, r.at);
          }
          out.pending = null;
          break;
        case 'paused':
          if (out.state === 'active') out.state = 'paused';
          break;
        case 'resumed':
          if (out.state === 'paused') out.state = 'active';
          break;
        case 'ending':
          out.state = 'ending';
          if (typeof r.json.until === 'string') out.until = r.json.until;
          break;
        case 'left':
        case 'removed':
          if (out.state !== 'forgotten') out.state = 'left';
          out.pending = null;
          break;
        case 'forgotten':
          out.state = 'forgotten';
          out.pending = null;
          break;
        default:
          break;
      }
    }
    return out;
  }

  private appendLedger(pid: string, action: string, by: string, agreement: AgreementFields | Agreement | null, version: number, extra: Record<string, string> = {}): ConsentRecord {
    const fields = agreement ? AgreementFieldsSchema.parse(stripVersion(agreement)) : null;
    return this.deps.ctx.db.people.consents.append({ personId: pid, version, action, by, at: this.iso(), json: { agreement: fields, ...extra } as ConsentRecord['json'] });
  }

  /** The live agreement (the object every Viewer reads; spec 8.4), or null. Areas a later phase adds read off (D24). */
  agreement(pid: string): Agreement | null {
    const l = this.ledger(pid);
    if (l.state !== 'active' && l.state !== 'paused') return null;
    return l.agreement;
  }

  /**
   * Her state for the gate (D19): the ledger first. `gone`: left, removed,
   * forgotten, never joined, or an ending window that has run out (which
   * this call then finishes). `setup_again`: the ledger says active or
   * paused but life.db (open) has no row for her (a restore of an older
   * backup, T20).
   */
  gateState(pid: string): GateState {
    const l = this.ledger(pid);
    if (l.state === 'ending') {
      if (l.until && Date.parse(l.until) <= this.now()) {
        this.finishEnding(pid);
        return 'gone';
      }
      return 'ending';
    }
    if (l.state !== 'active' && l.state !== 'paused') return 'gone';
    const core = this.deps.core();
    if (core) {
      try {
        if (!this.repo.get(pid)) return 'setup_again';
      } catch {
        // life.db unreadable: her exits must still work.
      }
    }
    return l.state;
  }

  /** The person row, or null (life.db closed counts as none). */
  person(pid: string): Person | null {
    try {
      return this.repo.get(pid);
    } catch (e) {
      if (e instanceof LifeClosedError) return null;
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // His side: add, offer, invite, list

  list(): LifeResult<PersonView[]> {
    return this.guard(() => ({ ok: true, value: this.repo.list().flatMap((p) => this.viewOf(p) ?? []) }));
  }

  /** One person as his screens show them (null once forgotten). No last-seen, ever (C20). */
  view(pid: string): LifeResult<PersonView> {
    return this.guard(() => {
      const p = this.repo.get(pid);
      const v = p ? this.viewOf(p) : null;
      return v ? { ok: true, value: v } : this.notFound();
    });
  }

  private viewOf(p: Person): PersonView | null {
    const l = this.ledger(p.id);
    if (l.state === 'forgotten') return null;
    const open = this.invites.open(p.id);
    const state: PersonState = l.state === null ? 'invited' : l.state;
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      state,
      ...(p.emailLabel ? { emailLabel: p.emailLabel } : {}),
      ...(p.joinedAt ? { joinedAt: p.joinedAt } : {}),
      ...(p.pausedAt && state === 'paused' ? { pausedAt: p.pausedAt } : {}),
      ...(l.until && state === 'ending' ? { endingUntil: l.until } : {}),
      modules: p.modules,
      invite: open && state === 'invited' ? { expiresAt: open.invite.expiresAt, linkAvailable: open.code !== null } : null,
      agreement: state === 'active' || state === 'paused' ? l.agreement : null,
      offer: l.offer ? { ...l.offer.fields, version: l.offer.version } : null,
      pendingProposal: l.pending && (state === 'active' || state === 'paused') ? { version: l.pending.version, fields: l.pending.fields } : null,
    };
  }

  add(body: PersonAddBody): LifeResult<{ id: string }> {
    return this.guard(() => {
      const live = this.repo.list().filter((p) => {
        const s = this.ledger(p.id).state;
        return s !== 'left' && s !== 'forgotten';
      });
      if (live.length >= this.peopleMax()) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.full };
      const at = this.iso();
      const id = newId();
      const sid = sharedSpaceId(newId());
      const used = new Set(live.map((p) => p.color));
      const color = body.color ?? PERSON_COLORS.find((c) => !used.has(c)) ?? PERSON_COLORS[0];
      const person: Person = {
        id,
        name: body.name,
        color,
        ...(body.email ? { emailLabel: body.email.toLowerCase() } : {}),
        state: 'invited',
        sharedSpace: sid,
        modules: { food: body.modules?.food ?? true },
        prefs: { lockScreen: 'hide_alerts', muteUntil: null, dontAsk: [] },
        limits: { chatPerDay: 30 },
        declinedUntil: {},
        createdAt: at,
        updatedAt: at,
      };
      const core = this.lifeCore();
      core.db.tx(() => {
        this.repo.save(person);
        this.repo.saveSharedSpace(sid, ['', id], `${this.ownerName()} & ${body.name}`, at);
      });
      this.log.info('person added', { personId: id });
      return { ok: true, value: { id } };
    });
  }

  /** PEOPLE_MAX, raised only inside tests (the isolation suites seed a second partner). */
  peopleMax(): number {
    return testPeopleMax ?? PEOPLE_MAX;
  }

  /** Record the offer her next invite carries: a preset (default standard) and field changes after it, clamped to the build (O7). */
  offer(pid: string, body: PersonOfferBody, by: string): LifeResult<{ version: number; fields: AgreementFields; on: string[] }> {
    return this.guard(() => {
      const p = this.repo.get(pid);
      const l = this.ledger(pid);
      if (!p || l.state === 'forgotten') return this.notFound();
      if (l.state !== null) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.joined };
      const { preset, ...patch } = body;
      const unbuilt = unbuiltFieldsIn(patch);
      if (unbuilt.length > 0) return { ok: false, code: 'invalid_request', reason: `${PEOPLE_REASONS.unbuilt} (${unbuilt.join(', ')})` };
      let fields = applyAgreementPatch(presetAgreement(preset ?? 'standard'), patch);
      // A field the owner turned off takes what needs it with it; one turned on needs what it hangs on.
      fields = closeDependents(fields);
      if (!p.modules.food) fields = { ...fields, see: { ...fields.see, food: false } };
      const problem = agreementProblem(fields);
      if (problem) return { ok: false, code: 'invalid_request', reason: problem };
      if (fields.assistant) return { ok: false, code: 'invalid_request', reason: 'assistant is never part of an offer (it is its own request).' };
      const version = l.maxVersion + 1;
      this.appendLedger(pid, 'offered', by, fields, version);
      return { ok: true, value: { version, fields, on: fieldsOn(fields) } };
    });
  }

  /** A new 24-hour invite (the offer recorded, else Standard). Mac only. */
  invite(pid: string, baseUrl: string, by: string): LifeResult<{ url: string; expiresAt: string }> {
    return this.guard(() => {
      const p = this.repo.get(pid);
      const l = this.ledger(pid);
      if (!p || l.state === 'forgotten') return this.notFound();
      if (l.state === 'left') return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.left };
      if (l.state !== null) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.joined };
      let version = l.offer?.version;
      if (version === undefined) {
        const r = this.offer(pid, {}, by);
        if (!r.ok) return r;
        version = r.value.version;
      }
      const { code, invite } = this.invites.create(pid, version);
      return { ok: true, value: { url: joinUrl(baseUrl, code), expiresAt: invite.expiresAt } };
    });
  }

  /** "Copy link again": the unspent link while this process holds its code (an admin device, C14). */
  inviteLink(pid: string, baseUrl: string): LifeResult<{ url: string; expiresAt: string }> {
    return this.guard(() => {
      const p = this.repo.get(pid);
      if (!p || this.ledger(pid).state !== null) return this.notFound();
      const open = this.invites.open(pid);
      if (!open) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.noLink };
      if (open.code === null) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.noLink };
      return { ok: true, value: { url: joinUrl(baseUrl, open.code), expiresAt: open.invite.expiresAt } };
    });
  }

  revokeInvite(pid: string): LifeResult {
    return this.guard(() => {
      if (!this.repo.get(pid)) return this.notFound();
      this.invites.revokeAll(pid);
      return { ok: true, value: true };
    });
  }

  setColor(pid: string, color: Person['color']): LifeResult {
    return this.guard(() => {
      const p = this.repo.get(pid);
      if (!p || this.gone(pid)) return this.notFound();
      this.repo.save({ ...p, color, updatedAt: this.iso() });
      this.ownerChanged();
      return { ok: true, value: true };
    });
  }

  /** Her food module (O6): turning it off while she has food rows is refused, so the switch never hides her own data. */
  setModules(pid: string, food: boolean, by: string): LifeResult {
    return this.guard(() => {
      const p = this.repo.get(pid);
      if (!p || this.gone(pid)) return this.notFound();
      if (p.modules.food === food) return { ok: true, value: true };
      const core = this.lifeCore();
      if (!food) {
        const n = (core.db.prepare('SELECT COUNT(*) AS n FROM food WHERE space = ?').get(pid) as { n: number }).n;
        if (Number(n) > 0) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.hasRows };
      }
      this.repo.save({ ...p, modules: { ...p.modules, food }, updatedAt: this.iso() });
      const l = this.ledger(pid);
      if (l.state === 'active' || l.state === 'paused') {
        // Food off takes see.food with it (D23); food on grants nothing (a proposal does, O7).
        let agreement = l.agreement;
        if (!food && agreement?.see.food) {
          const next = { ...agreement, see: { ...agreement.see, food: false } };
          this.appendLedger(pid, 'narrowed', by, next, l.maxVersion + 1);
          agreement = { ...next, version: l.maxVersion + 1 };
        }
        this.appendLedger(pid, 'module_changed', by, agreement, agreement?.version ?? l.maxVersion);
        this.record(pid, { actor: 'owner', action: 'module.changed', fields: [`food=${food ? 'on' : 'off'}`] });
        this.ticks.bump(pid, 'me');
      }
      this.ownerChanged();
      return { ok: true, value: true };
    });
  }

  private gone(pid: string): boolean {
    const s = this.ledger(pid).state;
    return s === 'forgotten';
  }

  // ---------------------------------------------------------------------------
  // Joining (her phone)

  /** What an invite offers, without spending it (one answer for every bad code). */
  preview(code: string): LifeResult<JoinPreview> {
    return this.guard(() => {
      const inv = this.invites.find(code);
      if (!inv) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidCode };
      const p = this.repo.get(inv.personId);
      const l = this.ledger(inv.personId);
      if (!p || l.state !== null || !l.offer || l.offer.version !== inv.offerVersion) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidCode };
      const fields = clampToBuilt(l.offer.fields);
      return {
        ok: true,
        value: {
          owner: this.ownerName(),
          name: p.name,
          version: inv.offerVersion,
          offer: fields,
          fields: AGREEMENT_FIELDS.filter((f) => phaseBuilt(f.phase)).map((f) => f.key),
          built: BUILT_PHASE,
          modules: p.modules,
        },
      };
    });
  }

  /**
   * Accept an invite (spec 2.4): the Access email (Cloudflare mode, C14)
   * must match the label, the agreement is clamped to the offer field by
   * field (a widened body is a 400 and spends nothing), then the code is
   * spent and her first device made, in that order.
   */
  join(body: JoinBody, opts: { accessEmail?: string | undefined; userAgent?: string | undefined; cloudflare: boolean }): LifeResult<{ personId: string; device: PersonDeviceRecord; key: string; secret: string }> {
    return this.guard(() => {
      const inv = this.invites.find(body.code);
      if (!inv) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidCode };
      const pid = inv.personId;
      const p = this.repo.get(pid);
      const l = this.ledger(pid);
      if (!p || l.state !== null || !l.offer || l.offer.version !== inv.offerVersion) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidCode };
      if (body.acceptedVersion !== inv.offerVersion) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.version };
      const email = opts.accessEmail?.trim().toLowerCase();
      if (opts.cloudflare && email && p.emailLabel && email !== p.emailLabel.toLowerCase()) {
        return { ok: false, code: 'forbidden', reason: PEOPLE_REASONS.emailMismatch(email) };
      }
      const offer = clampToBuilt(l.offer.fields);
      const asked = closeDependents(body.agreement);
      if (!agreementWithin(body.agreement, offer) || !agreementWithin(asked, offer)) return { ok: false, code: 'invalid_request', reason: PEOPLE_REASONS.widen };
      const problem = agreementProblem(asked);
      if (problem) return { ok: false, code: 'invalid_request', reason: problem };
      if (!this.invites.spend(inv)) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidCode };
      const issued = this.devices.issue({ personId: pid, name: body.deviceName, userAgent: opts.userAgent, accessEmail: email });
      this.appendLedger(pid, 'joined', `person:${pid}`, asked, inv.offerVersion);
      const at = this.iso();
      this.repo.save({ ...p, name: body.name, state: 'active', joinedAt: at, updatedAt: at });
      this.record(pid, { actor: 'her', action: 'joined', fields: fieldsOn(asked) });
      this.deps.push({ kind: 'life', title: `${body.name} joined`, body: 'Their space is set up.', url: `/people/${pid}`, tag: `people:${pid}` });
      this.ownerChanged();
      this.log.info('person joined', { personId: pid });
      return { ok: true, value: { personId: pid, ...issued } };
    });
  }

  /** Link another device of hers with a code from one she has (C37). */
  linkCode(pid: string, byDevice: string): LifeResult<{ code: string; expiresAt: string }> {
    if (this.gateState(pid) === 'ending') return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.ending };
    if (!this.devices.roomForAnother(pid)) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.devicesFull };
    const { code, record } = this.linkCodes.create(pid, byDevice);
    return { ok: true, value: { code, expiresAt: record.expiresAt } };
  }

  claimLink(code: string, deviceName: string, userAgent: string | undefined): LifeResult<{ personId: string; device: PersonDeviceRecord; key: string; secret: string }> {
    const r = this.linkCodes.find(code);
    if (!r) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidLink };
    const st = this.gateState(r.personId);
    if (st !== 'active' && st !== 'paused') return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidLink };
    if (!this.devices.roomForAnother(r.personId)) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.devicesFull };
    if (!this.linkCodes.spend(r)) return { ok: false, code: 'not_found', reason: PEOPLE_REASONS.invalidLink };
    const by = this.devices.get(r.byDevice);
    const issued = this.devices.issue({ personId: r.personId, name: deviceName, userAgent, accessEmail: by?.accessEmail ?? undefined });
    this.tryRecord(r.personId, { actor: 'her', action: 'device.linked', device: issued.device.name });
    this.deps.push({ person: r.personId, kind: 'life', title: 'A device was linked', body: `${issued.device.name} can now open your space.`, url: '/p/me?tab=devices', tag: 'people:device' });
    this.ticks.bump(r.personId, 'me');
    return { ok: true, value: { personId: r.personId, ...issued } };
  }

  // ---------------------------------------------------------------------------
  // Her account

  me(pid: string, broken: boolean): LifeResult<PersonMe> {
    const l = this.ledger(pid);
    const p = this.person(pid);
    const state: PersonState = l.state === 'forgotten' || l.state === null ? 'left' : l.state;
    const owner = { name: this.ownerName() };
    const ownerDevices = this.deps.ctx.db.devices
      .list()
      .filter((d) => !d.revokedAt && hasScope(d.scopes, 'control'))
      .map((d) => ({ name: d.name, createdAt: d.createdAt, scope: d.scopes.includes('admin') ? ('admin' as const) : d.scopes.includes('launch') ? ('launch' as const) : ('control' as const) }));
    return {
      ok: true,
      value: {
        person: {
          id: pid,
          name: p?.name ?? 'You',
          color: p?.color ?? PERSON_COLORS[0],
          state,
          ...(p?.joinedAt ? { joinedAt: p.joinedAt } : {}),
          ...(p?.pausedAt && state === 'paused' ? { pausedAt: p.pausedAt } : {}),
          ...(l.until && state === 'ending' ? { endingUntil: l.until } : {}),
          modules: p?.modules ?? { food: false },
          prefs: p?.prefs ?? { lockScreen: 'hide_alerts', muteUntil: null, dontAsk: [] },
        },
        owner,
        peopleOn: this.enabled(),
        agreement: state === 'active' || state === 'paused' ? l.agreement : null,
        pending: l.pending && (state === 'active' || state === 'paused') ? { version: l.pending.version, fields: l.pending.fields, ...(p?.pendingProposal?.note ? { note: p.pendingProposal.note } : {}) } : null,
        ownerDevices,
        built: BUILT_PHASE,
        lifeBroken: broken,
      },
    };
  }

  /**
   * Narrow (hers, instant): every named field may only go down. It applies
   * before the next read (the ledger is read on every call), and his devices
   * re-fetch at once (C24).
   */
  narrow(pid: string, patch: AgreementPatch, by: string): LifeResult {
    const l = this.ledger(pid);
    if (!l.agreement) return this.notFound();
    const unbuilt = unbuiltFieldsIn(patch);
    if (unbuilt.length > 0) return { ok: false, code: 'invalid_request', reason: `${PEOPLE_REASONS.unbuilt} (${unbuilt.join(', ')})` };
    const current = stripVersion(l.agreement);
    const raw = applyAgreementPatch(current, patch);
    if (!agreementWithin(raw, current)) return { ok: false, code: 'invalid_request', reason: PEOPLE_REASONS.notNarrower };
    const next = closeDependents(raw);
    const changed = fieldsChanged(current, next);
    if (changed.length === 0) return { ok: true, value: true };
    const version = l.maxVersion + 1;
    this.appendLedger(pid, 'narrowed', by, next, version);
    this.tryRecord(pid, { actor: 'her', action: 'agreement.narrowed', fields: changed });
    this.deps.push({ kind: 'life', title: `${this.nameOf(pid)} changed what they share`, body: 'Open People to see.', url: `/people/${pid}`, tag: `people:${pid}` });
    this.ticks.bump(pid, 'me');
    this.ownerChanged();
    return { ok: true, value: true };
  }

  /** His request for more (admin device): one at a time, with cooling-off and "Don't ask again" (C23). */
  propose(pid: string, body: PersonProposeBody, by: string): LifeResult {
    return this.guard(() => {
      const l = this.ledger(pid);
      const p = this.repo.get(pid);
      if (!p || (l.state !== 'active' && l.state !== 'paused') || !l.agreement) return this.notFound();
      if (l.pending) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.pending };
      const { note, ...patch } = body;
      const unbuilt = unbuiltFieldsIn(patch);
      if (unbuilt.length > 0) return { ok: false, code: 'invalid_request', reason: `${PEOPLE_REASONS.unbuilt} (${unbuilt.join(', ')})` };
      const current = stripVersion(l.agreement);
      let next = applyAgreementPatch(current, patch);
      if (!p.modules.food) next = { ...next, see: { ...next.see, food: false } };
      const problem = agreementProblem(next);
      if (problem) return { ok: false, code: 'invalid_request', reason: problem };
      const widened = AGREEMENT_FIELDS.filter((f) => levelOf(next, f) > levelOf(current, f));
      if (widened.length === 0) return { ok: false, code: 'invalid_request', reason: PEOPLE_REASONS.nothingNew };
      for (const f of widened) {
        if (p.prefs.dontAsk.includes(dontAskKey(f.key))) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.dontAsk };
        const declined = l.declinedAt.get(f.key);
        if (declined) {
          const until = Date.parse(declined) + PROPOSAL_COOLING_DAYS * DAY_MS;
          if (until > this.now()) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.cooling(this.iso(until).slice(0, 10)) };
        }
      }
      const version = l.maxVersion + 1;
      this.appendLedger(pid, 'proposed', by, next, version);
      this.repo.save({ ...p, pendingProposal: { version, ...(note ? { note } : {}) }, updatedAt: this.iso() });
      this.tryRecord(pid, { actor: 'owner', action: 'agreement.proposed', fields: widened.map((f) => f.key) });
      this.deps.push({ person: pid, kind: 'life', title: `${this.ownerName()} asks to see more`, body: 'Open Sharing to answer.', url: '/p/me?tab=sharing', tag: 'people:proposal' });
      this.ticks.bump(pid, 'me');
      return { ok: true, value: true };
    });
  }

  accept(pid: string, version: number, by: string): LifeResult {
    const l = this.ledger(pid);
    if (!l.pending || l.pending.version !== version) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.noPending };
    this.appendLedger(pid, 'accepted', by, l.pending.fields, version);
    this.clearPending(pid);
    this.tryRecord(pid, { actor: 'her', action: 'agreement.accepted', fields: fieldsChanged(stripVersion(l.agreement ?? { ...noAgreement(), version: 1 }), l.pending.fields) });
    this.deps.push({ kind: 'life', title: `${this.nameOf(pid)} said yes`, body: 'Open People to see.', url: `/people/${pid}`, tag: `people:${pid}` });
    this.ticks.bump(pid, 'me');
    this.ownerChanged();
    return { ok: true, value: true };
  }

  decline(pid: string, version: number, dontAsk: boolean, by: string): LifeResult {
    const l = this.ledger(pid);
    if (!l.pending || l.pending.version !== version) return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.noPending };
    const changed = fieldsChanged(stripVersion(l.agreement ?? { ...noAgreement(), version: 1 }), l.pending.fields);
    this.appendLedger(pid, 'declined', by, null, version);
    const p = this.person(pid);
    if (p) {
      const dont = dontAsk ? [...new Set([...p.prefs.dontAsk, ...changed.map(dontAskKey)])] : p.prefs.dontAsk;
      try {
        this.repo.save({ ...p, pendingProposal: undefined, prefs: { ...p.prefs, dontAsk: dont }, updatedAt: this.iso() } as Person);
      } catch (e) {
        if (!(e instanceof LifeClosedError)) throw e;
      }
    }
    this.tryRecord(pid, { actor: 'her', action: 'agreement.declined', fields: changed });
    this.ticks.bump(pid, 'me');
    this.ownerChanged();
    return { ok: true, value: true };
  }

  private clearPending(pid: string): void {
    const p = this.person(pid);
    if (!p?.pendingProposal) return;
    const { pendingProposal: _gone, ...rest } = p;
    try {
      this.repo.save({ ...rest, updatedAt: this.iso() });
    } catch (e) {
      if (!(e instanceof LifeClosedError)) throw e;
    }
  }

  /** Her prefs (P1: lock screen, mute, don't ask). */
  setPrefs(pid: string, patch: Partial<Person['prefs']>): LifeResult {
    return this.guard(() => {
      const p = this.repo.get(pid);
      if (!p) return this.notFound();
      const prefs = { ...p.prefs, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Person['prefs'];
      this.repo.save({ ...p, prefs, updatedAt: this.iso() });
      this.ticks.bump(pid, 'me');
      return { ok: true, value: true };
    });
  }

  /** Pause (hers alone): his writes into her space and his alerts wait. Works on jantar.db alone (C12). */
  pause(pid: string, by: string): LifeResult {
    const l = this.ledger(pid);
    if (l.state === 'paused') return { ok: true, value: true };
    if (l.state !== 'active') return this.notFound();
    this.appendLedger(pid, 'paused', by, l.agreement, l.agreement?.version ?? l.maxVersion);
    this.mirrorState(pid, 'paused', { pausedAt: this.iso() });
    this.tryRecord(pid, { actor: 'her', action: 'paused' });
    this.deps.push({ kind: 'life', title: `${this.nameOf(pid)} paused`, body: 'New items wait until they resume.', url: `/people/${pid}`, tag: `people:${pid}` });
    this.ticks.bump(pid, 'me');
    this.ownerChanged();
    return { ok: true, value: true };
  }

  resume(pid: string, by: string): LifeResult {
    const l = this.ledger(pid);
    if (l.state === 'active') return { ok: true, value: true };
    if (l.state !== 'paused') return this.notFound();
    this.appendLedger(pid, 'resumed', by, l.agreement, l.agreement?.version ?? l.maxVersion);
    this.mirrorState(pid, 'active', {});
    this.tryRecord(pid, { actor: 'her', action: 'resumed' });
    this.deps.push({ kind: 'life', title: `${this.nameOf(pid)} resumed`, body: 'Sharing is back on.', url: `/people/${pid}`, tag: `people:${pid}` });
    this.ticks.bump(pid, 'me');
    this.ownerChanged();
    return { ok: true, value: true };
  }

  /**
   * Leave (hers alone, spec 2.7): her devices, push list and link codes go
   * at once, her sockets close, the ledger says `left`, and her space is
   * forgotten now or after PERSON_FORGET_DAYS. Works while People is off,
   * in --read-only and while life.db is broken (C12): the forget then runs
   * when Life opens again (reconcile).
   */
  leave(pid: string, data: 'keep30' | 'delete', by: string): LifeResult {
    const l = this.ledger(pid);
    if (l.state !== 'active' && l.state !== 'paused' && l.state !== 'ending') return this.notFound();
    const name = this.nameOf(pid);
    this.devices.revokeAllFor(pid, 'left');
    this.invites.revokeAll(pid);
    this.ticks.close(pid);
    this.appendLedger(pid, 'left', by, null, l.maxVersion, { data });
    const forgetAt = this.iso(this.now() + PERSON_FORGET_DAYS * DAY_MS);
    this.mirrorState(pid, 'left', { leftAt: this.iso(), forgetAt });
    if (data === 'delete') this.forget(pid, by);
    this.deps.push({ kind: 'life', title: `${name} left`, body: 'Their space is closed.', url: '/people', tag: `people:${pid}` });
    this.ownerChanged();
    this.log.info('person left', { personId: pid, data });
    return { ok: true, value: true };
  }

  /** Remove her (Mac only, spec 2.8): a PERSON_ENDING_DAYS window, or at once; `forget` deletes at once. */
  remove(pid: string, mode: 'window' | 'now', forget: boolean, by: string): LifeResult {
    const l = this.ledger(pid);
    if (l.state === 'forgotten') return this.notFound();
    if (l.state === null) {
      // Never joined: the invite goes, and so does the row.
      this.invites.revokeAll(pid);
      this.appendLedger(pid, 'removed', by, null, l.maxVersion);
      this.forget(pid, by);
      this.ownerChanged();
      return { ok: true, value: true };
    }
    if (l.state === 'left') {
      if (forget) this.forget(pid, by);
      return { ok: true, value: true };
    }
    if (mode === 'window' && !forget && l.state !== 'ending') {
      const until = this.iso(this.now() + PERSON_ENDING_DAYS * DAY_MS);
      this.appendLedger(pid, 'ending', by, l.agreement, l.maxVersion, { until });
      this.mirrorState(pid, 'ending', { endingUntil: until });
      this.tryRecord(pid, { actor: 'owner', action: 'ending' });
      this.deps.push({ person: pid, kind: 'life', title: `${this.ownerName()} ended sharing`, body: `You can download your data until ${until.slice(0, 10)}.`, url: '/p/left', tag: 'people:ending' });
      this.ticks.bump(pid, 'me');
      this.ownerChanged();
      return { ok: true, value: true };
    }
    this.devices.revokeAllFor(pid, 'removed');
    this.invites.revokeAll(pid);
    this.ticks.close(pid);
    this.appendLedger(pid, 'removed', by, null, l.maxVersion);
    this.mirrorState(pid, 'left', { leftAt: this.iso(), forgetAt: this.iso(this.now() + PERSON_FORGET_DAYS * DAY_MS) });
    if (forget) this.forget(pid, by);
    this.ownerChanged();
    return { ok: true, value: true };
  }

  /** The end of an ending window: she moves to left with the 30-day keep. */
  private finishEnding(pid: string): void {
    this.devices.revokeAllFor(pid, 'ended');
    this.ticks.close(pid);
    const l = this.ledger(pid);
    this.appendLedger(pid, 'removed', 'system', null, l.maxVersion);
    this.mirrorState(pid, 'left', { leftAt: this.iso(), forgetAt: this.iso(this.now() + PERSON_FORGET_DAYS * DAY_MS) });
    this.ownerChanged();
  }

  /**
   * Forget (spec 2.7): every row in her space across every table the data
   * map lists, her Activity, her meta keys and her person row. The ledger
   * keeps one `forgotten` row. Idempotent: a restore's reconcile runs it
   * again. While life.db is closed, the ledger row is written and the rows
   * go when Life opens (reconcile).
   */
  forget(pid: string, by: string): void {
    const l = this.ledger(pid);
    if (l.state !== 'forgotten') this.appendLedger(pid, 'forgotten', by, null, l.maxVersion);
    this.devices.revokeAllFor(pid, 'forgotten');
    this.invites.revokeAll(pid);
    const core = this.deps.core();
    if (!core) return;
    forgetSpace(core, pid);
    this.log.info('person forgotten', { personId: pid });
  }

  /**
   * After every life.db open and restore (C11): the ledger wins. Forgotten
   * people are forgotten again; a `left` ledger sets the row to left; an
   * active ledger with no row is left for the gate's "set up again".
   */
  reconcile(): void {
    const core = this.deps.core();
    if (!core) return;
    for (const pid of this.deps.ctx.db.people.consents.persons()) {
      const l = this.ledger(pid);
      const p = this.repo.get(pid);
      if (l.state === 'forgotten') {
        if (p || hasRowsIn(core, pid)) {
          forgetSpace(core, pid);
          this.log.info('people reconciled', { personId: pid, action: 'forgotten' });
        }
        continue;
      }
      if (l.state === 'left' && p && p.state !== 'left') {
        this.repo.save({ ...p, state: 'left', updatedAt: this.iso() });
        this.log.info('people reconciled', { personId: pid, action: 'left' });
      }
      if ((l.state === 'active' || l.state === 'paused') && p && p.state !== l.state) {
        this.repo.save({ ...p, state: l.state, updatedAt: this.iso() });
      }
    }
  }

  /** After a restore of Life data (C11): each person still sharing gets an Activity row saying data may be missing. */
  afterRestore(): void {
    if (!this.deps.core()) return;
    for (const pid of this.deps.ctx.db.people.consents.persons()) {
      const st = this.gateState(pid);
      if (st === 'active' || st === 'paused') this.tryRecord(pid, { actor: 'owner', action: 'restore' });
    }
  }

  /** His revoke of one of her devices (an admin device; never her last one, C18). */
  revokeByOwner(pid: string, did: string): LifeResult {
    if (this.gateState(pid) === 'gone') return this.notFound();
    const r = this.devices.revokeByOwner(pid, did);
    if (r === 'not_found') return this.notFound();
    if (r === 'last_device') return { ok: false, code: 'conflict', reason: PEOPLE_REASONS.lastDevice };
    this.ticks.close(pid, did);
    const d = this.devices.get(did);
    this.tryRecord(pid, { actor: 'owner', action: 'device.revoked', device: d?.name ?? '' });
    this.deps.push({ person: pid, kind: 'life', title: `${this.ownerName()} revoked a device`, body: `${d?.name ?? 'A device'} can no longer open your space.`, url: '/p/me?tab=devices', tag: 'people:device' });
    this.ticks.bump(pid, 'me');
    return { ok: true, value: true };
  }

  /** Her revoke of one of her own devices (the one calling included). */
  revokeOwn(pid: string, did: string): LifeResult {
    const d = this.devices.get(did);
    if (!d || d.personId !== pid || d.revokedAt) return this.notFound();
    this.devices.revoke(did, 'her');
    this.ticks.close(pid, did);
    this.tryRecord(pid, { actor: 'her', action: 'device.revoked', device: d.name });
    this.ticks.bump(pid, 'me');
    return { ok: true, value: true };
  }

  /** His view of her devices: name, Access email, added. Never last-seen, user agent or an address (C20). */
  ownerDevices(pid: string): LifeResult<ReturnType<typeof publicPersonDevice>[]> {
    if (this.ownerReach(pid) === null) return this.notFound();
    return { ok: true, value: this.devices.list(pid).map(publicPersonDevice) };
  }

  /**
   * What his People routes may reach of a person (M8): `active` and
   * `paused` her data (within the agreement), `invited` only the routes
   * about the person; null (404, the unknown-pid answer) for ending, left,
   * forgotten or no such person.
   */
  ownerReach(pid: string): 'active' | 'paused' | 'invited' | null {
    const l = this.ledger(pid);
    if (l.state === null) return this.person(pid) ? 'invited' : null;
    const g = this.gateState(pid);
    return g === 'active' || g === 'paused' ? g : null;
  }

  // ---------------------------------------------------------------------------
  // Activity: her record (spec 8.3)

  activity(pid: string, before?: number): LifeResult<{ activity: PersonActivity[]; before: number | null }> {
    return this.guard(() => {
      const rows = this.repo.activity(pid, before, 100);
      return { ok: true, value: { activity: rows, before: rows.length === 100 ? (rows[rows.length - 1]?.seq ?? null) : null } };
    });
  }

  /** Append one Activity row (life.db must be open). */
  record(pid: string, row: ActivityInput): PersonActivity {
    const r = this.repo.append(pid, row, this.iso());
    if (r.seq % 100 === 0) this.repo.prune(pid, this.now());
    return r;
  }

  /** Append when life.db is open; an exit that runs while it is broken skips it. */
  private tryRecord(pid: string, row: ActivityInput): void {
    try {
      this.record(pid, row);
    } catch (e) {
      if (!(e instanceof LifeClosedError)) this.log.warn('activity not written', { personId: pid, action: row.action });
    }
  }

  /** One view mark per area per hour when he (or his assistant) reads an area of hers. */
  viewMark(pid: string, area: Area): void {
    const hour = this.now() - (this.now() % HOUR_MS);
    try {
      if (this.repo.viewMarked(pid, area, this.iso(hour))) return;
      this.record(pid, { actor: 'owner', action: 'view', ref: area, area });
      this.ticks.bump(pid, 'me');
    } catch (e) {
      if (!(e instanceof LifeClosedError)) throw e;
    }
  }

  /** Her name for his pushes ("Asha paused"), or a neutral word. */
  private nameOf(pid: string): string {
    return this.person(pid)?.name ?? 'Your partner';
  }

  /** Mirror the ledger's state onto her life.db row (best effort while life.db is broken). */
  private mirrorState(pid: string, state: PersonState, extra: Partial<Person>): void {
    try {
      const p = this.repo.get(pid);
      if (p) this.repo.save({ ...p, ...extra, state, updatedAt: this.iso() });
    } catch (e) {
      if (!(e instanceof LifeClosedError)) this.log.warn('person row not updated', { personId: pid, state });
    }
  }
}

/** Thrown inside the module when life.db is not open (answered `unavailable`). */
export class LifeClosedError extends Error {
  constructor() {
    super('life.db is not open');
  }
}

/** Raised only by tests that seed more than one partner (the isolation suites). */
let testPeopleMax: number | undefined;
export function setPeopleMaxForTests(n: number | undefined): void {
  testPeopleMax = n;
}

function stripVersion(a: AgreementFields | Agreement): AgreementFields {
  const { version: _v, ...rest } = a as Agreement;
  return AgreementFieldsSchema.parse(rest);
}

function dontAskKey(fieldKey: string): DontAsk {
  const [group, name] = fieldKey.split('.') as [string, string | undefined];
  if (group === 'see' && name) return name as DontAsk;
  if (group === 'assign' && name) return name as DontAsk;
  return group as DontAsk;
}

function joinUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/p/join#c=${code}`;
}

/** Tables whose rows a person space holds (forget deletes them; the data map pins this list). */
export const PERSON_SPACE_TABLES = [
  'todos',
  'projects',
  'medicines',
  'doses',
  'weights',
  'food',
  'foods_saved',
  'day_plans',
  'plan_templates',
  'journal_entries',
  'journal_comments',
  'sleep_logs',
] as const;

function hasRowsIn(core: LifeCore, pid: string): boolean {
  for (const t of PERSON_SPACE_TABLES) {
    if (core.db.prepare(`SELECT 1 FROM ${t} WHERE space = ? LIMIT 1`).get(pid) !== undefined) return true;
  }
  return false;
}

/** Delete her space: every person-space table, her alerts, Activity, pings, meta keys and person row (one transaction). */
function forgetSpace(core: LifeCore, pid: string): void {
  core.db.tx(() => {
    for (const t of PERSON_SPACE_TABLES) core.db.prepare(`DELETE FROM ${t} WHERE space = ?`).run(pid);
    core.db.prepare('DELETE FROM person_alerts WHERE from_person = ? OR to_person = ?').run(pid, pid);
    core.db.prepare('DELETE FROM person_activity WHERE person = ?').run(pid);
    core.db.prepare('DELETE FROM pings WHERE person = ?').run(pid);
    core.db.deleteMeta(`kcal_target:${pid}`);
    core.db.deleteMeta(`goal_kg10:${pid}`);
    core.db.prepare('DELETE FROM people WHERE id = ?').run(pid);
  });
}

export { AgreementSchema };
