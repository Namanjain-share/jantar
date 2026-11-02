/**
 * v0.12 People: her invites (jantar.db `person_invites`, spec D9) and her
 * device-link codes (`person_link_codes`, C37).
 *
 * - A code is 128 random bits, base64url, carried in a URL fragment so it
 *   never reaches a log. Only its prefixed sha256 is stored, so a restart
 *   keeps an unspent invite valid.
 * - Invites last PERSON_INVITE_TTL_MS (24 h) and are spent once; link codes
 *   last PERSON_LINK_CODE_TTL_MS (5 minutes) and are spent once.
 * - Wrong, spent, revoked and expired codes all answer the one `invalid`, so
 *   an answer never confirms which (spec 2.4).
 * - "Copy link again" (C14): an unspent invite's code is held in this
 *   process's memory, never on disk, until it is used, revoked, or the
 *   daemon restarts; after a restart the link can't be shown again and the
 *   owner makes a new one at the Mac.
 */
import { PERSON_INVITE_TTL_MS, PERSON_LINK_CODE_TTL_MS } from '@jantar/protocol/people';
import type { Clock, Db, PersonInviteRecord, PersonLinkCodeRecord } from '../contracts.js';
import { sha256Hex } from '../core/hash.js';
import { newId, randomToken } from '../core/ids.js';

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;

export function hashInviteCode(code: string): string {
  return sha256Hex(`jantar-person-invite:${code}`);
}

export function hashLinkCode(code: string): string {
  return sha256Hex(`jantar-person-link:${code}`);
}

export class PersonInvites {
  /** inviteId → code, for "Copy link again" while unspent (memory only). */
  private readonly codes = new Map<string, { code: string; personId: string }>();

  constructor(private readonly opts: { db: Pick<Db, 'people'>; clock: Pick<Clock, 'now' | 'iso'> }) {}

  /** A new invite; any earlier unspent one of hers is revoked. */
  create(personId: string, offerVersion: number): { code: string; invite: PersonInviteRecord } {
    this.revokeAll(personId);
    const code = randomToken(16);
    const now = this.opts.clock.now();
    const invite: PersonInviteRecord = {
      id: newId(),
      personId,
      codeHash: hashInviteCode(code),
      offerVersion,
      createdAt: this.opts.clock.iso(now),
      expiresAt: this.opts.clock.iso(now + PERSON_INVITE_TTL_MS),
      usedAt: null,
      revokedAt: null,
    };
    this.opts.db.people.invites.insert(invite);
    this.codes.set(invite.id, { code, personId });
    return { code, invite };
  }

  /** The live invite a code names, or null (one answer for wrong, spent, revoked and expired). */
  find(code: string): PersonInviteRecord | null {
    if (!CODE_RE.test(code)) return null;
    const r = this.opts.db.people.invites.byHash(hashInviteCode(code));
    if (!r || r.usedAt || r.revokedAt) return null;
    if (Date.parse(r.expiresAt) <= this.opts.clock.now()) return null;
    return r;
  }

  /** Spend it: true only for the one call that did. */
  spend(invite: PersonInviteRecord): boolean {
    const ok = this.opts.db.people.invites.use(invite.id, this.opts.clock.iso());
    this.codes.delete(invite.id);
    return ok;
  }

  /** Her newest unspent invite (expiry shown on his screen) and its code when this process still holds it. */
  open(personId: string): { invite: PersonInviteRecord; code: string | null } | null {
    const r = this.opts.db.people.invites.openFor(personId);
    if (!r || Date.parse(r.expiresAt) <= this.opts.clock.now()) return null;
    return { invite: r, code: this.codes.get(r.id)?.code ?? null };
  }

  revokeAll(personId: string): number {
    for (const [id, held] of this.codes) if (held.personId === personId) this.codes.delete(id);
    return this.opts.db.people.invites.revokeAllFor(personId, this.opts.clock.iso());
  }
}

export class PersonLinkCodes {
  constructor(private readonly opts: { db: Pick<Db, 'people'>; clock: Pick<Clock, 'now' | 'iso'> }) {}

  create(personId: string, byDevice: string): { code: string; record: PersonLinkCodeRecord } {
    const code = randomToken(16);
    const now = this.opts.clock.now();
    const record: PersonLinkCodeRecord = {
      id: newId(),
      personId,
      codeHash: hashLinkCode(code),
      byDevice,
      createdAt: this.opts.clock.iso(now),
      expiresAt: this.opts.clock.iso(now + PERSON_LINK_CODE_TTL_MS),
      usedAt: null,
    };
    this.opts.db.people.linkCodes.insert(record);
    return { code, record };
  }

  find(code: string): PersonLinkCodeRecord | null {
    if (!CODE_RE.test(code)) return null;
    const r = this.opts.db.people.linkCodes.byHash(hashLinkCode(code));
    if (!r || r.usedAt) return null;
    if (Date.parse(r.expiresAt) <= this.opts.clock.now()) return null;
    return r;
  }

  spend(r: PersonLinkCodeRecord): boolean {
    return this.opts.db.people.linkCodes.use(r.id, this.opts.clock.iso());
  }
}
