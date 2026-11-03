/**
 * v0.11 People (P2): alerts both ways, and every People push that waits on
 * the recipient (spec 6, 3.7, 3.11, 3.12).
 *
 * - One resolver (life-core `resolveDelivery`, D25) decides push, hold or
 *   save for each alert, nudge, change request, comment push, "review sent"
 *   and reply, from the tier and the recipient's state: her pause, mute,
 *   Need space, a focus step, an open night (with "Hold alerts while I
 *   sleep") and her quiet hours; for him, his own prefs.
 * - Caps belong to the recipient (D18, C29): hers on his alerts, nudges and
 *   comments; his on hers. Over a cap the alert is saved, never pushed.
 * - Held alerts and comment pushes are stored; when the hold ends, one
 *   summary push goes out ("2 alerts and a comment from Sam while you were
 *   in quiet hours"). Nothing is re-sent one by one, nothing repeats.
 * - Every push goes through `sendLifePush` (Web Push only, C7). A push to
 *   him about her is checked against the agreement when it is sent. No push,
 *   log or Activity row carries alert text beyond the alert's own push, and
 *   none carries journal, comment, sleep or review text (O15).
 * - Seen only on open or reply; reply buttons close after 24 hours; alerts
 *   are kept 90 days.
 */
import { PEOPLE_LABEL } from '@jantar/protocol/people-core';
import {
  ALERT_KINDS,
  ALERT_REPLY_HOURS,
  ALERT_REPLY_LABELS,
  PERSON_ALERT_KEEP_DAYS,
  PersonAlertSchema,
  URGENT_PER_HOUR_MAX,
  type AlertCapsValue,
  type AlertDelivery,
  type AlertReplyBody,
  type AlertSendBody,
  type AlertsResponse,
  type PersonAlert,
} from '@jantar/protocol/people';
import { SLEEP_HOLD_MAX_H, hhmmOf, instantAt, minutesToQuietEnd, quietWindowOf, resolveDelivery, shiftDay, type DeliveryTier, type HoldReason, type RecipientState } from '@jantar/life-core';
import type { LifeCore, LifePush, LifeResult } from '../../contracts.js';
import { newId } from '../../core/ids.js';
import type { PeopleModule } from '../people/module.js';
import { CLOSED, DAY_MS, HOUR_MS, NO_PERSON, OK, clipLine, localNow, refuse } from '../people/kit.js';

export const ALERT_REASONS = {
  noAlert: 'No such alert.',
  notYours: 'Only the other person sends that.',
  needText: 'A custom alert needs its text.',
  needRef: 'A reminder needs its item.',
  noItem: 'No such item, or it is already done.',
  expired: 'This alert has expired.',
  reply: 'That reply does not fit this alert.',
  focus: (name: string, until: string) => `${name} is in focus until about ${until}.`,
} as const;

const HELD: Record<HoldReason, AlertDelivery> = {
  paused: 'held_pause',
  muted: 'held_mute',
  space: 'held_space',
  focus: 'held_focus',
  sleep: 'held_sleep',
  quiet: 'held_quiet',
};
const HELD_WORDS: Record<string, string> = {
  held_pause: 'while you were paused',
  held_mute: 'while you were muted',
  held_space: 'while you had asked for space',
  held_focus: 'while you were focusing',
  held_sleep: 'while you were asleep',
  held_quiet: 'while you were in quiet hours',
};
const OWNER_HELD_KEY = 'people_owner_held';

interface AlertRow {
  id: string;
  from_person: string;
  to_person: string;
  at: string;
  state: string;
  json: string;
}

export interface AlertsDeps {
  people: PeopleModule;
  core: () => LifeCore | null;
}

export class AlertsModule {
  constructor(private readonly d: AlertsDeps) {}

  private get people(): PeopleModule {
    return this.d.people;
  }

  private core(): LifeCore | null {
    return this.d.core();
  }

  private nowMs(): number {
    const c = this.core();
    return c ? c.now().getTime() : Date.now();
  }

  private iso(ms = this.nowMs()): string {
    return new Date(ms).toISOString();
  }

  // ---------------------------------------------------------------------------
  // The recipient's state (spec 6.3)

  /** Her state now, as the resolver reads it. */
  herState(pid: string): RecipientState {
    const c = this.core();
    const p = this.people.person(pid);
    if (!c || !p) return {};
    const now = localNow(c);
    const until = p.prefs.muteUntil ? Date.parse(p.prefs.muteUntil) : NaN;
    const status = this.people.statusOf(p);
    const night = this.people.sleep?.openNight(pid) ?? null;
    return {
      paused: this.people.gateState(pid) === 'paused',
      muted: Number.isFinite(until) && until > now.ms,
      needSpace: status?.level === 'need_space',
      focus: (this.people.plans?.focusOf(pid) ?? null) !== null,
      asleep: p.prefs.sleepHolds && night !== null && now.ms - Date.parse(night.bedAt) < SLEEP_HOLD_MAX_H * HOUR_MS,
      quiet: quietWindowOf(p.prefs.quiet),
      minute: now.minute,
      weekday: now.weekday,
      urgentBreaksQuiet: p.prefs.urgentBreaksQuiet,
    };
  }

  /** His state for pushes about her: his quiet hours and mute (he has no focus, sleep or pause rows). */
  ownerState(): RecipientState {
    const c = this.core();
    if (!c) return {};
    const prefs = this.people.ownerPrefs();
    const now = localNow(c);
    const until = prefs.muteUntil ? Date.parse(prefs.muteUntil) : NaN;
    return { muted: Number.isFinite(until) && until > now.ms, quiet: quietWindowOf(prefs.quiet), minute: now.minute, weekday: now.weekday, urgentBreaksQuiet: prefs.urgentBreaksQuiet };
  }

  private stateOf(recipient: string): RecipientState {
    return recipient === '' ? this.ownerState() : this.herState(recipient);
  }

  /** When the hold on `recipient` should end, as a best guess (the release re-checks and re-arms). */
  private holdEnds(recipient: string, reason: HoldReason): number {
    const now = this.nowMs();
    const c = this.core();
    if (recipient === '') {
      const prefs = this.people.ownerPrefs();
      if (reason === 'muted' && prefs.muteUntil) return Date.parse(prefs.muteUntil);
      const q = quietWindowOf(prefs.quiet);
      if (reason === 'quiet' && q && c) return now + minutesToQuietEnd(q, localNow(c).minute) * 60_000;
      return now + 15 * 60_000;
    }
    const p = this.people.person(recipient);
    if (!p || !c) return now + 15 * 60_000;
    switch (reason) {
      case 'muted':
        return p.prefs.muteUntil ? Date.parse(p.prefs.muteUntil) : now + 15 * 60_000;
      case 'space':
        return p.status ? Date.parse(p.status.until) : now + 15 * 60_000;
      case 'focus': {
        const f = this.people.plans?.focusOf(recipient);
        return f ? Date.parse(f.until) : now + 15 * 60_000;
      }
      case 'sleep': {
        const n = this.people.sleep?.openNight(recipient);
        return n ? Date.parse(n.bedAt) + SLEEP_HOLD_MAX_H * HOUR_MS : now + 15 * 60_000;
      }
      case 'quiet': {
        const q = quietWindowOf(p.prefs.quiet);
        return q ? now + minutesToQuietEnd(q, localNow(c).minute) * 60_000 : now + 15 * 60_000;
      }
      case 'paused':
        return now + HOUR_MS;
    }
  }

  // ---------------------------------------------------------------------------
  // Rows

  private rows(sql: string, ...args: string[]): PersonAlert[] {
    const c = this.core();
    if (!c) return [];
    const out: PersonAlert[] = [];
    for (const r of c.db.prepare(sql).all(...args) as unknown as AlertRow[]) {
      try {
        const p = PersonAlertSchema.safeParse({ ...(JSON.parse(r.json) as object), id: r.id, from: r.from_person, to: r.to_person, at: r.at, delivery: r.state });
        if (p.success) out.push(p.data);
      } catch {
        /* left out */
      }
    }
    return out;
  }

  /** Alerts between the owner and her, newest first, within 90 days. */
  private between(pid: string): PersonAlert[] {
    const since = this.iso(this.nowMs() - PERSON_ALERT_KEEP_DAYS * DAY_MS);
    return this.rows(
      `SELECT * FROM person_alerts WHERE ((from_person = ? AND to_person = '') OR (from_person = '' AND to_person = ?)) AND at >= ? ORDER BY at DESC, id DESC LIMIT 300`,
      pid,
      pid,
      since,
    );
  }

  private save(a: PersonAlert): void {
    const c = this.core();
    if (!c) return;
    const { id, from, to, at, delivery, ...rest } = PersonAlertSchema.parse(a);
    c.db
      .prepare(
        `INSERT INTO person_alerts (id, from_person, to_person, at, state, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, json = excluded.json`,
      )
      .run(id, from, to, at, delivery, JSON.stringify(rest));
  }

  private get(id: string, party: string): PersonAlert | null {
    return this.rows('SELECT * FROM person_alerts WHERE id = ? AND (from_person = ? OR to_person = ?)', id, party, party)[0] ?? null;
  }

  /** What `sender` sent `recipient` lately, for the recipient's caps (capped ones never count). */
  private sentCounts(sender: string, recipient: string): { hour: number; day: number; urgentDay: number; urgentHour: number; nudgesDay: number } {
    const now = this.nowMs();
    const dayAgo = this.iso(now - DAY_MS);
    const hourAgo = now - HOUR_MS;
    const list = this.rows(`SELECT * FROM person_alerts WHERE from_person = ? AND to_person = ? AND at >= ? AND state != 'capped'`, sender, recipient, dayAgo);
    const out = { hour: 0, day: 0, urgentDay: 0, urgentHour: 0, nudgesDay: 0 };
    for (const a of list) {
      if (a.kind === 'nudge') out.nudgesDay += 1;
      else if (a.urgency === 'urgent') {
        out.urgentDay += 1;
        if (Date.parse(a.at) >= hourAgo) out.urgentHour += 1;
      } else {
        out.day += 1;
        if (Date.parse(a.at) >= hourAgo) out.hour += 1;
      }
    }
    // Comment pushes count against the recipient's gentle-and-normal caps (spec 3.11).
    const space = recipient === '' ? sender : recipient;
    const c = this.core();
    if (c) {
      const comments = c.db.prepare('SELECT at FROM journal_comments WHERE space = ? AND by_person = ? AND at >= ?').all(space, sender, dayAgo) as { at: string }[];
      for (const r of comments) {
        out.day += 1;
        if (Date.parse(r.at) >= hourAgo) out.hour += 1;
      }
    }
    return out;
  }

  private capsOf(recipient: string): AlertCapsValue {
    if (recipient === '') return this.people.ownerPrefs().alertCaps;
    return this.people.person(recipient)?.prefs.alertCaps ?? this.people.ownerPrefs().alertCaps;
  }

  private overCap(sender: string, recipient: string, kind: PersonAlert['kind'], urgency: PersonAlert['urgency'], refId?: string): boolean {
    const caps = this.capsOf(recipient);
    const n = this.sentCounts(sender, recipient);
    if (kind === 'nudge') {
      if (n.nudgesDay >= caps.nudgeDay) return true;
      if (refId) {
        const since = this.iso(this.nowMs() - caps.nudgeGapMin * 60_000);
        const recent = this.rows(`SELECT * FROM person_alerts WHERE from_person = ? AND to_person = ? AND at >= ? AND state != 'capped'`, sender, recipient, since);
        if (recent.some((a) => a.kind === 'nudge' && a.ref?.id === refId)) return true;
      }
      return false;
    }
    if (urgency === 'urgent') return n.urgentDay >= caps.urgentDay || n.urgentHour >= URGENT_PER_HOUR_MAX;
    return n.hour >= caps.hour || n.day >= caps.day;
  }

  // ---------------------------------------------------------------------------
  // Sending

  /**
   * One alert from `from` ('' the owner, or her id) to `to`. The owner's
   * side needs her reachable (active or paused); hers works paused too (her
   * alerts to him are never held by her pause).
   */
  send(from: string, to: string, body: AlertSendBody): LifeResult<{ id: string; delivery: AlertDelivery }> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    const pid = from === '' ? to : from;
    const reach = this.people.ownerReach(pid);
    if (reach !== 'active' && reach !== 'paused') return refuse('not_found', NO_PERSON);
    const kind = ALERT_KINDS[body.kind];
    if ((kind.dir === 'her' && from === '') || (kind.dir === 'him' && from !== '')) return refuse('invalid_request', ALERT_REASONS.notYours);
    if (body.kind === 'custom' && !body.text) return refuse('invalid_request', ALERT_REASONS.needText);
    let ref: PersonAlert['ref'];
    if (body.kind === 'nudge') {
      if (!body.ref) return refuse('invalid_request', ALERT_REASONS.needRef);
      const item = this.itemFor(pid, body.ref);
      if (!item.ok) return item;
      ref = item.value;
      if (body.ref.type === 'step') {
        const f = this.people.plans?.focusOf(pid);
        if (f && f.stepId === body.ref.id) return refuse('conflict', ALERT_REASONS.focus(this.people.nameOf(pid), hhmmOf(new Date(f.until), c.tz())));
      }
    } else if (body.kind === 'change_request' && body.ref) {
      const item = this.itemFor(pid, body.ref);
      if (!item.ok) return item;
      ref = item.value;
    }
    const urgency = body.kind === 'custom' ? (body.urgency ?? 'normal') : kind.urgency;
    const r = this.deliverAlert({ from, to, kind: body.kind, urgency, ...(body.text ? { text: body.text } : {}), ...(ref ? { ref } : {}) });
    // His answer names a held reason only while he sees the area behind it (spec 6.2); otherwise it reads "quiet time".
    if (r.ok && from === '') return { ok: true, value: { ...r.value, delivery: this.ownerDelivery(to, r.value.delivery) } };
    return r;
  }

  /** The item a nudge or change request points at, as he may see it (404 otherwise). */
  private itemFor(pid: string, ref: NonNullable<AlertSendBody['ref']>): LifeResult<NonNullable<PersonAlert['ref']>> {
    const c = this.core();
    const a = this.people.agreement(pid);
    if (!c || !a) return refuse('not_found', ALERT_REASONS.noItem);
    if (ref.type === 'step') {
      if (!a.see.plan) return refuse('not_found', ALERT_REASONS.noItem);
      const day = ref.day ?? c.today();
      const s = this.people.plans?.view(pid, day).plan?.steps.find((x) => x.id === ref.id);
      if (!s || !(s.status === 'todo' || s.status === 'doing') || s.carriedTo) return refuse('not_found', ALERT_REASONS.noItem);
      return { ok: true, value: { type: 'step', id: s.id, day, title: s.title } };
    }
    if (!a.see.todos) return refuse('not_found', ALERT_REASONS.noItem);
    const t = this.people.space?.findTodo(pid, ref.id);
    if (!t || t.doneAt) return refuse('not_found', ALERT_REASONS.noItem);
    return { ok: true, value: { type: 'todo', id: t.id, title: t.title.slice(0, 120) } };
  }

  private deliverAlert(a: Pick<PersonAlert, 'from' | 'to' | 'kind' | 'urgency' | 'text' | 'ref' | 'carry'>): LifeResult<{ id: string; delivery: AlertDelivery }> {
    const tier: DeliveryTier = a.urgency === 'urgent' ? 'urgent' : 'important';
    const capped = this.overCap(a.from, a.to, a.kind, a.urgency, a.ref?.id);
    const d = resolveDelivery(tier, { ...this.stateOf(a.to), overCap: capped });
    const delivery: AlertDelivery = d.action === 'push' ? 'sent' : d.action === 'save' ? 'capped' : HELD[d.reason as HoldReason];
    const at = this.iso();
    const alert: PersonAlert = { id: newId(), ...a, at, delivery, expiresAt: this.iso(this.nowMs() + ALERT_REPLY_HOURS * HOUR_MS) };
    this.save(alert);
    const pid = a.from === '' ? a.to : a.from;
    if (delivery === 'sent') this.pushAlert(alert);
    else if (delivery !== 'capped') this.armRelease(a.to);
    // Her record: "Sam sent Check in, please" (the kind only, never the text).
    if (a.from === '') this.people.record(pid, { actor: 'owner', action: 'alert.sent', fields: [a.kind] });
    this.people.ticks.bump(pid, 'alerts');
    this.people.ownerChanged();
    return { ok: true, value: { id: alert.id, delivery } };
  }

  /** The push for one alert, worded for the recipient's lock screen (C36). */
  private pushAlert(a: PersonAlert): void {
    const urgent = a.urgency === 'urgent';
    const label = a.kind === 'nudge' && a.ref ? `Reminder: ${a.ref.title}` : a.kind === 'change_request' ? `Asks to change${a.ref ? `: ${a.ref.title}` : ''}` : ALERT_KINDS[a.kind].label;
    const full = (name: string) => `${name}: ${clipLine(label, 80)}${a.text ? `. ${clipLine(a.text, 140)}` : ''}`;
    if (a.from === '') {
      const p = this.people.person(a.to);
      const owner = this.people.ownerName();
      const show = p?.prefs.lockScreen === 'all';
      this.people.pushHer(a.to, {
        kind: 'life',
        title: show ? owner : PEOPLE_LABEL,
        body: show ? full(owner).slice(owner.length + 2) : `${urgent ? 'Urgent alert' : 'Alert'} from ${owner}`,
        url: `/p/alerts?id=${a.id}`,
        tag: `people:alert:${a.id}`,
        urgency: a.urgency,
      });
      return;
    }
    const name = this.people.nameOf(a.from);
    const details = this.core()?.settings().lockScreenDetails === true;
    this.people.pushOwner(a.from, {
      kind: 'life',
      title: details ? name : PEOPLE_LABEL,
      body: details ? full(name).slice(name.length + 2) : `${urgent ? 'Urgent alert' : 'Alert'} from ${name}`,
      url: `/people/${a.from}?tab=alerts&id=${a.id}`,
      tag: `people:alert:${a.id}`,
      urgency: a.urgency,
    });
  }

  /** Her "Ask to change" on an item he gave her: a change request to him with her note. */
  changeRequest(pid: string, ref: NonNullable<PersonAlert['ref']>, note: string): LifeResult {
    const r = this.deliverAlert({ from: pid, to: '', kind: 'change_request', urgency: 'normal', text: note.slice(0, 140), ref });
    return r.ok ? OK : r;
  }

  /** Her review's "Ask Sam to carry": his open steps, in one change request. */
  carryRequest(pid: string, day: string, to: string, steps: string[]): void {
    const c = this.core();
    const label = c ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${to}T00:00:00Z`).getUTCDay()]}` : to;
    this.deliverAlert({ from: pid, to: '', kind: 'change_request', urgency: 'normal', text: `Asks to carry ${steps.length} step${steps.length === 1 ? '' : 's'} to ${label}`, carry: { day, to, steps } });
  }

  /** The sharing check-in's "Let's talk": a neutral alert, no score, no detail. */
  talk(pid: string): void {
    this.deliverAlert({ from: pid, to: '', kind: 'custom', urgency: 'normal', text: `${this.people.nameOf(pid)} would like to talk about how things are set up.` });
  }

  // ---------------------------------------------------------------------------
  // Reading, seen, reply

  /** Her Alerts page (`party` her id) or his tab (`party` '', with her id). */
  list(party: string, withPid: string | null): LifeResult<AlertsResponse> {
    const c = this.core();
    if (!c) return refuse('unavailable', CLOSED);
    if (party === '') {
      const people = withPid ? [withPid] : this.people.sharingPeople();
      for (const pid of people) {
        const r = this.people.ownerReach(pid);
        if (r !== 'active' && r !== 'paused') return refuse('not_found', NO_PERSON);
      }
      const alerts = people.flatMap((pid) => this.between(pid).map((a) => this.forOwner(pid, a))).sort((x, y) => y.at.localeCompare(x.at));
      const pid = people[0];
      return { ok: true, value: { alerts, unseen: alerts.filter((a) => a.to === '' && !a.seenAt).length, sheet: pid ? this.sheet('', pid) : this.emptySheet() } };
    }
    const alerts = this.between(party);
    return { ok: true, value: { alerts, unseen: alerts.filter((a) => a.to === party && !a.seenAt).length, sheet: this.sheet(party, '') } };
  }

  /**
   * A held reason as he may see it (spec 6.2): "asleep" needs `see.sleep`;
   * "asked for space" and "focusing" are her status and her plan, so they
   * need `see.plan`. Otherwise it reads "quiet time".
   */
  private ownerDelivery<D extends PersonAlert['delivery']>(pid: string, delivery: D): D | 'held_quiet' {
    const a = this.people.agreement(pid);
    if (delivery === 'held_sleep' && !a?.see.sleep) return 'held_quiet';
    if ((delivery === 'held_space' || delivery === 'held_focus') && !a?.see.plan) return 'held_quiet';
    return delivery;
  }

  /** His view of one alert, its held reason through `ownerDelivery`. */
  private forOwner(pid: string, a: PersonAlert): PersonAlert {
    const delivery = this.ownerDelivery(pid, a.delivery);
    return delivery === a.delivery ? a : { ...a, delivery };
  }

  private emptySheet(): AlertsResponse['sheet'] {
    return { caps: this.people.ownerPrefs().alertCaps, sent: { hour: 0, day: 0, urgentDay: 0 }, hold: null };
  }

  /** The send sheet's line and counts for `sender` sending to `recipient`. */
  private sheet(sender: string, recipient: string): AlertsResponse['sheet'] {
    const c = this.core();
    const caps = this.capsOf(recipient);
    const n = this.sentCounts(sender, recipient);
    const state = this.stateOf(recipient);
    const d = resolveDelivery('important', state);
    let hold: string | null = null;
    const name = recipient === '' ? this.people.ownerName() : this.people.nameOf(recipient);
    if (d.action === 'hold' && c) {
      const until = hhmmOf(new Date(this.holdEnds(recipient, d.reason)), c.tz());
      const urgentLine = state.urgentBreaksQuiet === false ? 'Urgent waits too.' : 'Only Urgent goes through.';
      switch (d.reason) {
        case 'paused':
          hold = `${name} has paused and will see this after resuming. In an emergency, phone ${name}.`;
          break;
        case 'muted':
          hold = `${name} muted notifications until ${until}. Urgent still goes through.`;
          break;
        case 'space':
        case 'focus': {
          // Her status and her focus step are her plan: named only while he sees it (spec 6.2).
          const sees = recipient === '' || this.people.agreement(recipient)?.see.plan === true;
          if (!sees) {
            hold = `${name} has quiet time on. ${urgentLine}`;
            break;
          }
          if (d.reason === 'space') {
            hold = `${name} asked for space until ${until}. ${urgentLine}`;
            break;
          }
          const f = recipient === '' ? null : this.people.plans?.focusOf(recipient);
          hold = f ? `${name} is in ${clipLine(f.title, 40)} (focus) until about ${until}. ${urgentLine}` : `${name} is focusing until about ${until}. ${urgentLine}`;
          break;
        }
        case 'sleep': {
          const sees = this.people.agreement(recipient)?.see.sleep === true;
          const night = this.people.sleep?.openNight(recipient);
          hold = sees && night ? `${name} is asleep (since ${hhmmOf(new Date(night.bedAt), c.tz())}). ${urgentLine}` : `${name} has quiet time on. ${urgentLine}`;
          break;
        }
        case 'quiet':
          hold = `${name} is in quiet hours until ${until}. ${state.urgentBreaksQuiet === false ? 'Urgent waits too.' : 'Urgent still goes through.'}`;
          break;
      }
    }
    if (hold === null && n.hour > 0) hold = `You've sent ${n.hour} of the ${caps.hour} alerts ${name} allows an hour.`;
    return { caps, sent: { hour: n.hour, day: n.day, urgentDay: n.urgentDay }, hold };
  }

  /** Seen: the recipient opened it (never just because a push was delivered). */
  seen(party: string, id: string): LifeResult {
    const a = this.get(id, party);
    if (!a || a.to !== party) return refuse('not_found', ALERT_REASONS.noAlert);
    if (party === '' && !this.reachable(a.from)) return refuse('not_found', ALERT_REASONS.noAlert);
    if (!a.seenAt) {
      this.save({ ...a, seenAt: this.iso() });
      this.touch(a);
    }
    return OK;
  }

  /** One-tap reply (seen too), within 24 hours; the sender hears it. */
  reply(party: string, id: string, body: AlertReplyBody): LifeResult {
    const a = this.get(id, party);
    if (!a || a.to !== party) return refuse('not_found', ALERT_REASONS.noAlert);
    if (party === '' && !this.reachable(a.from)) return refuse('not_found', ALERT_REASONS.noAlert);
    if (Date.parse(a.expiresAt) <= this.nowMs()) return refuse('conflict', ALERT_REASONS.expired);
    if (!ALERT_KINDS[a.kind].replies.includes(body.kind)) return refuse('invalid_request', ALERT_REASONS.reply);
    const at = this.iso();
    this.save({ ...a, seenAt: a.seenAt ?? at, reply: { kind: body.kind, ...(body.note ? { note: body.note } : {}), at } });
    this.touch(a);
    const words = `${ALERT_REPLY_LABELS[body.kind]}${body.note ? `. ${clipLine(body.note, 140)}` : ''}`;
    if (party === '') {
      const owner = this.people.ownerName();
      const show = this.people.person(a.from)?.prefs.lockScreen === 'all';
      this.deliverPush(a.from, { kind: 'life', title: show ? owner : PEOPLE_LABEL, body: show ? `Replied: ${words}` : `Reply from ${owner}`, url: `/p/alerts?id=${a.id}`, tag: `people:alert:${a.id}` }, { kind: 'reply' });
    } else {
      const name = this.people.nameOf(party);
      const details = this.core()?.settings().lockScreenDetails === true;
      this.deliverPush('', { kind: 'life', title: details ? name : PEOPLE_LABEL, body: details ? `Replied: ${words}` : `Reply from ${name}`, url: `/people/${party}?tab=alerts&id=${a.id}`, tag: `people:alert:${a.id}` }, { kind: 'reply', about: party });
    }
    return OK;
  }

  private reachable(pid: string): boolean {
    const r = this.people.ownerReach(pid);
    return r === 'active' || r === 'paused';
  }

  private touch(a: PersonAlert): void {
    const pid = a.from === '' ? a.to : a.from;
    this.people.ticks.bump(pid, 'alerts');
    this.people.ownerChanged();
  }

  // ---------------------------------------------------------------------------
  // Other pushes that wait on the recipient: comments, "review sent", replies

  /**
   * An `important` push to `recipient` ('' him, or her id) through the
   * resolver: pushed now, or held (counted, released as one summary), or
   * saved without a push when over her caps (comments count against them).
   * A push to him about her is dropped unless `about`'s agreement still
   * shows the area (`area`), checked now (C7).
   */
  deliverPush(recipient: string, push: LifePush, opts: { kind: 'comment' | 'review' | 'reply'; about?: string; sender?: string; area?: 'journal' | 'review' }): 'sent' | 'held' | 'capped' | 'dropped' {
    if (recipient === '' && opts.about && opts.area) {
      const a = this.people.agreement(opts.about);
      if (!this.people.sees(a, opts.area)) return 'dropped';
    }
    const capped = opts.kind === 'comment' && opts.sender !== undefined ? this.overCapComment(opts.sender, recipient) : false;
    const d = resolveDelivery('important', { ...this.stateOf(recipient), overCap: capped });
    if (d.action === 'save') return 'capped';
    if (d.action === 'push') {
      if (recipient === '') this.people.pushOwner(opts.about ?? '', push);
      else this.people.pushHer(recipient, push);
      return 'sent';
    }
    if (opts.kind !== 'reply') this.countHeld(recipient, opts.about ?? '', opts.kind, d.reason as HoldReason);
    this.armRelease(recipient);
    return 'held';
  }

  /** A comment is the comment row itself, already written: over the caps once it is one too many. */
  private overCapComment(sender: string, recipient: string): boolean {
    const caps = this.capsOf(recipient);
    const n = this.sentCounts(sender, recipient);
    return n.hour > caps.hour || n.day > caps.day;
  }

  private countHeld(recipient: string, about: string, kind: 'comment' | 'review', reason: HoldReason): void {
    const c = this.core();
    if (!c) return;
    if (recipient !== '') {
      const p = this.people.person(recipient);
      if (!p) return;
      const held = { comments: p.held?.comments ?? 0, reviews: p.held?.reviews ?? 0 };
      if (kind === 'comment') held.comments += 1;
      else held.reviews += 1;
      this.people.saveHeld(recipient, held, HELD[reason]);
      return;
    }
    const map = this.ownerHeld();
    const h = map[about] ?? { comments: 0, reviews: 0, reason: HELD[reason] };
    if (kind === 'comment') h.comments += 1;
    else h.reviews += 1;
    map[about] = h;
    c.db.setMeta(OWNER_HELD_KEY, JSON.stringify(map));
  }

  private ownerHeld(): Record<string, { comments: number; reviews: number; reason: string }> {
    const raw = this.core()?.db.meta(OWNER_HELD_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, { comments: number; reviews: number; reason: string }>;
    } catch {
      return {};
    }
  }

  /** "Asha sent the evening review" (important, his prefs; dropped if review is off by now). No note text, ever. */
  reviewSent(pid: string, day: string): void {
    if (!this.people.ownerPrefs().reviewPush) return;
    const name = this.people.nameOf(pid);
    this.deliverPush(
      '',
      { kind: 'life', title: name, body: `${name} sent the evening review.`, url: `/people/${pid}?tab=today&day=${day}&review=1`, tag: `people:review:${pid}` },
      { kind: 'review', about: pid, area: 'review' },
    );
  }

  // ---------------------------------------------------------------------------
  // Holds and their release

  /** Arm (or move) the release check for `recipient` at the end of what holds them now. */
  armRelease(recipient: string): void {
    const c = this.core();
    if (!c) return;
    const d = resolveDelivery('important', this.stateOf(recipient));
    const at = d.action === 'hold' ? this.holdEnds(recipient, d.reason) : this.nowMs();
    // At least a second ahead: a row due right now would wait for the minute's sweep.
    c.scheduler.set('alert_release', recipient, '', new Date(Math.max(at, this.nowMs() + 1_000)), recipient);
    c.scheduler.poke();
  }

  /**
   * When the hold has ended: held alerts become `released`, held comment and
   * review pushes are cleared, and one summary push goes out. While it still
   * holds, the check moves to the hold's end.
   */
  release(recipient: string): void {
    const c = this.core();
    if (!c) return;
    const heldAlerts = this.rows(`SELECT * FROM person_alerts WHERE to_person = ? AND state LIKE 'held_%'`, recipient);
    const counts = recipient === '' ? this.ownerHeld() : null;
    const herHeld = recipient !== '' ? this.people.person(recipient)?.held : undefined;
    const herReason = recipient !== '' ? this.people.heldReason(recipient) : undefined;
    const others = recipient === '' ? Object.values(counts ?? {}).reduce((n, h) => n + h.comments + h.reviews, 0) : (herHeld?.comments ?? 0) + (herHeld?.reviews ?? 0);
    if (heldAlerts.length === 0 && others === 0) {
      c.scheduler.clear('alert_release', recipient);
      return;
    }
    const d = resolveDelivery('important', this.stateOf(recipient));
    if (d.action === 'hold') {
      this.armRelease(recipient);
      return;
    }
    c.scheduler.clear('alert_release', recipient);
    for (const a of heldAlerts) this.save({ ...a, delivery: 'released' });
    const reason = heldAlerts[heldAlerts.length - 1]?.delivery ?? herReason ?? Object.values(counts ?? {})[0]?.reason ?? 'held_quiet';
    const words = HELD_WORDS[reason] ?? 'while notifications were held';
    if (recipient === '') {
      c.db.deleteMeta(OWNER_HELD_KEY);
      const byPerson = new Map<string, { alerts: number; comments: number; reviews: number }>();
      for (const a of heldAlerts) {
        const x = byPerson.get(a.from) ?? { alerts: 0, comments: 0, reviews: 0 };
        x.alerts += 1;
        byPerson.set(a.from, x);
      }
      for (const [pid, h] of Object.entries(counts ?? {})) {
        // C7: a held comment or "review sent" push is about her journal or review; it is dropped if that is no longer shared.
        const a = this.people.agreement(pid);
        const x = byPerson.get(pid) ?? { alerts: 0, comments: 0, reviews: 0 };
        if (this.people.sees(a, 'journal')) x.comments += h.comments;
        if (this.people.sees(a, 'review')) x.reviews += h.reviews;
        if (x.alerts + x.comments + x.reviews > 0) byPerson.set(pid, x);
      }
      for (const [pid, x] of byPerson) {
        if (!this.reachable(pid)) continue;
        const name = this.people.nameOf(pid);
        this.people.pushOwner(pid, { kind: 'life', title: PEOPLE_LABEL, body: `${summaryWords(x)} from ${name} ${words}.`, url: `/people/${pid}?tab=alerts`, tag: `people:release:${pid}` });
        this.people.ticks.bump(pid, 'alerts');
      }
      this.people.ownerChanged();
      return;
    }
    this.people.saveHeld(recipient, { comments: 0, reviews: 0 }, undefined);
    const x = { alerts: heldAlerts.length, comments: herHeld?.comments ?? 0, reviews: herHeld?.reviews ?? 0 };
    this.people.pushHer(recipient, { kind: 'life', title: PEOPLE_LABEL, body: `${summaryWords(x)} from ${this.people.ownerName()} ${words}.`, url: '/p/alerts', tag: 'people:release' });
    this.people.ticks.bump(recipient, 'alerts');
    this.people.ownerChanged();
  }

  // ---------------------------------------------------------------------------
  // His day summary (Q16, opt-in) and housekeeping

  /** His daily summary row (at `summaryAt`, while it is on). */
  resyncOwner(): void {
    const c = this.core();
    if (!c) return;
    const at = this.people.ownerPrefs().summaryAt;
    if (!at || this.people.sharingPeople().length === 0) {
      c.scheduler.clear('owner_summary', '');
      return;
    }
    const today = c.today();
    let when = instantAt(today, at, c.tz());
    if (when.getTime() <= this.nowMs()) when = instantAt(shiftDay(today, 1), at, c.tz());
    c.scheduler.set('owner_summary', '', '', when);
    c.scheduler.poke();
  }

  /** "Asha's day: 5 of 7 done · review sent · 1 dose not logged", from the agreement as it is now; never journal, chat or sleep text, never a medicine's name. */
  summaryText(): string | null {
    const c = this.core();
    if (!c) return null;
    const lines: string[] = [];
    for (const pid of this.people.sharingPeople()) {
      const a = this.people.agreement(pid);
      if (!a) continue;
      const parts: string[] = [];
      if (a.see.plan) {
        const v = this.people.plans?.view(pid, c.today());
        if (v?.plan) parts.push(`${v.counts.done} of ${v.counts.total} done`);
      }
      if (a.see.review !== 'off') {
        const r = this.people.plans?.reviewView(pid, c.today(), 'counts', { todos: a.see.todos });
        if (r?.sent) parts.push('review sent');
      }
      // Her medicines (see.meds): doses not logged today, and the two-day concern; counts only, never a name.
      parts.push(...(this.people.meds?.summaryParts(pid) ?? []));
      if (parts.length > 0) lines.push(`${this.people.nameOf(pid)}'s day: ${parts.join(' · ')}`);
    }
    return lines.length > 0 ? lines.join('; ') : null;
  }

  /** Alerts past 90 days go (the daily sweep). */
  prune(): void {
    const c = this.core();
    if (!c) return;
    const cutoff = this.iso(this.nowMs() - PERSON_ALERT_KEEP_DAYS * DAY_MS);
    c.db.prepare("DELETE FROM person_alerts WHERE (from_person != '' OR to_person != '') AND at < ?").run(cutoff);
  }

  /** Every alert between him and her (her export). */
  exportRows(pid: string): PersonAlert[] {
    return this.rows(`SELECT * FROM person_alerts WHERE (from_person = ? AND to_person = '') OR (from_person = '' AND to_person = ?) ORDER BY at`, pid, pid);
  }

  /** Alerts from him she hasn't opened (her Today's dot). */
  unseenBy(pid: string): number {
    return this.between(pid).filter((a) => a.to === pid && !a.seenAt).length;
  }
}

function summaryWords(x: { alerts: number; comments: number; reviews: number }): string {
  const parts: string[] = [];
  if (x.alerts) parts.push(`${x.alerts} alert${x.alerts === 1 ? '' : 's'}`);
  if (x.comments) parts.push(x.comments === 1 ? 'a comment' : `${x.comments} comments`);
  if (x.reviews) parts.push(x.reviews === 1 ? 'an evening review' : `${x.reviews} evening reviews`);
  const text = parts.length <= 1 ? (parts[0] ?? 'Something') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
