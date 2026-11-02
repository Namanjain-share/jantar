/**
 * v0.12 People's jantar.db repos (migration 8): her devices, her device-link
 * codes, her push list, her invites and the consent ledger.
 *
 * One implementation over a statement factory: db/sqlite.ts passes its
 * cached `stmt`, and the tests' in-memory Db (core/memory-db.ts) passes one
 * over an in-memory node:sqlite connection with the same tables.
 *
 * - Keys, secrets and codes are stored only as hashes (auth/person-*.ts).
 * - The ledger is append-only: there is no update and no delete here, and a
 *   test scans this file for one (M19). Its json holds the agreement and
 *   the `left` data choice, never free text.
 */
import type { StatementSync } from 'node:sqlite';
import type { ConsentRecord, PeopleDbRepos, PersonDeviceRecord, PersonInviteRecord, PersonLinkCodeRecord, PersonPushSubRecord } from '../contracts.js';

type Prepare = (sql: string) => StatementSync;

interface DeviceRow {
  id: string;
  person_id: string;
  name: string;
  key_hash: string;
  secret_hash: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  access_email: string | null;
}

const deviceFrom = (r: DeviceRow): PersonDeviceRecord => ({
  id: r.id,
  personId: r.person_id,
  name: r.name,
  keyHash: r.key_hash,
  secretHash: r.secret_hash ?? null,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at ?? null,
  userAgent: r.user_agent ?? null,
  accessEmail: r.access_email ?? null,
});

interface LinkRow {
  id: string;
  person_id: string;
  code_hash: string;
  by_device: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

const linkFrom = (r: LinkRow): PersonLinkCodeRecord => ({
  id: r.id,
  personId: r.person_id,
  codeHash: r.code_hash,
  byDevice: r.by_device,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at ?? null,
});

interface InviteRow {
  id: string;
  person_id: string;
  code_hash: string;
  offer_version: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

const inviteFrom = (r: InviteRow): PersonInviteRecord => ({
  id: r.id,
  personId: r.person_id,
  codeHash: r.code_hash,
  offerVersion: Number(r.offer_version),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at ?? null,
  revokedAt: r.revoked_at ?? null,
});

interface ConsentRow {
  seq: number;
  person_id: string;
  version: number;
  action: string;
  by: string;
  at: string;
  json: string;
}

const consentFrom = (r: ConsentRow): ConsentRecord => ({
  seq: Number(r.seq),
  personId: r.person_id,
  version: Number(r.version),
  action: r.action,
  by: r.by,
  at: r.at,
  json: JSON.parse(r.json) as ConsentRecord['json'],
});

export function createPeopleRepos(prepare: Prepare, wrote: () => void = () => {}): PeopleDbRepos {
  const devices: PeopleDbRepos['devices'] = {
    insert(d) {
      prepare(
        `INSERT INTO person_devices (id, person_id, name, key_hash, secret_hash, created_at, last_seen_at, revoked_at, user_agent, access_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(d.id, d.personId, d.name, d.keyHash, d.secretHash, d.createdAt, d.lastSeenAt, d.revokedAt, d.userAgent, d.accessEmail);
      wrote();
    },
    get(id) {
      const r = prepare('SELECT * FROM person_devices WHERE id = ?').get(id) as DeviceRow | undefined;
      return r ? deviceFrom(r) : null;
    },
    byKeyHash(hash) {
      const r = prepare('SELECT * FROM person_devices WHERE key_hash = ?').get(hash) as DeviceRow | undefined;
      return r ? deviceFrom(r) : null;
    },
    listFor(personId) {
      return (prepare('SELECT * FROM person_devices WHERE person_id = ? ORDER BY created_at ASC, id ASC').all(personId) as unknown as DeviceRow[]).map(deviceFrom);
    },
    touch(id, at) {
      prepare('UPDATE person_devices SET last_seen_at = ? WHERE id = ?').run(at, id);
    },
    revoke(id, at) {
      prepare('UPDATE person_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(at, id);
      wrote();
      return devices.get(id);
    },
  };

  const linkCodes: PeopleDbRepos['linkCodes'] = {
    insert(r) {
      prepare(
        `INSERT INTO person_link_codes (id, person_id, code_hash, by_device, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.personId, r.codeHash, r.byDevice, r.createdAt, r.expiresAt, r.usedAt);
      wrote();
    },
    byHash(hash) {
      const r = prepare('SELECT * FROM person_link_codes WHERE code_hash = ?').get(hash) as LinkRow | undefined;
      return r ? linkFrom(r) : null;
    },
    use(id, at) {
      const changed = Number(prepare('UPDATE person_link_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, id).changes);
      wrote();
      return changed === 1;
    },
    revokeAllFor(personId, at) {
      const n = Number(prepare('UPDATE person_link_codes SET used_at = ? WHERE person_id = ? AND used_at IS NULL').run(at, personId).changes);
      wrote();
      return n;
    },
  };

  const invites: PeopleDbRepos['invites'] = {
    insert(r) {
      prepare(
        `INSERT INTO person_invites (id, person_id, code_hash, offer_version, created_at, expires_at, used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.personId, r.codeHash, r.offerVersion, r.createdAt, r.expiresAt, r.usedAt, r.revokedAt);
      wrote();
    },
    byHash(hash) {
      const r = prepare('SELECT * FROM person_invites WHERE code_hash = ?').get(hash) as InviteRow | undefined;
      return r ? inviteFrom(r) : null;
    },
    openFor(personId) {
      const r = prepare(
        'SELECT * FROM person_invites WHERE person_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
      ).get(personId) as InviteRow | undefined;
      return r ? inviteFrom(r) : null;
    },
    use(id, at) {
      const changed = Number(prepare('UPDATE person_invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(at, id).changes);
      wrote();
      return changed === 1;
    },
    revokeAllFor(personId, at) {
      const n = Number(prepare('UPDATE person_invites SET revoked_at = ? WHERE person_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(at, personId).changes);
      wrote();
      return n;
    },
  };

  const pushSubs: PeopleDbRepos['pushSubs'] = {
    upsert(r) {
      prepare(
        `INSERT INTO person_push_subs (endpoint, person_id, device_id, json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET person_id = excluded.person_id, device_id = excluded.device_id,
           json = excluded.json, created_at = excluded.created_at`,
      ).run(r.endpoint, r.personId, r.deviceId, JSON.stringify(r), r.createdAt);
      wrote();
    },
    remove(endpoint) {
      return Number(prepare('DELETE FROM person_push_subs WHERE endpoint = ?').run(endpoint).changes) > 0;
    },
    removeForDevice(deviceId) {
      return Number(prepare('DELETE FROM person_push_subs WHERE device_id = ?').run(deviceId).changes);
    },
    removeForPerson(personId) {
      return Number(prepare('DELETE FROM person_push_subs WHERE person_id = ?').run(personId).changes);
    },
    listFor(personId) {
      return (prepare('SELECT json FROM person_push_subs WHERE person_id = ? ORDER BY created_at ASC, endpoint ASC').all(personId) as { json: string }[]).map(
        (r) => JSON.parse(r.json) as PersonPushSubRecord,
      );
    },
    listAll() {
      return (prepare('SELECT json FROM person_push_subs ORDER BY created_at ASC, endpoint ASC').all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as PersonPushSubRecord,
      );
    },
  };

  const consents: PeopleDbRepos['consents'] = {
    append(r) {
      const res = prepare('INSERT INTO person_consents (person_id, version, action, by, at, json) VALUES (?, ?, ?, ?, ?, ?)').run(
        r.personId,
        r.version,
        r.action,
        r.by,
        r.at,
        JSON.stringify(r.json),
      );
      wrote();
      return { ...structuredClone(r), seq: Number(res.lastInsertRowid) };
    },
    listFor(personId) {
      return (prepare('SELECT * FROM person_consents WHERE person_id = ? ORDER BY seq ASC').all(personId) as unknown as ConsentRow[]).map(consentFrom);
    },
    latestFor(personId) {
      const r = prepare('SELECT * FROM person_consents WHERE person_id = ? ORDER BY seq DESC LIMIT 1').get(personId) as ConsentRow | undefined;
      return r ? consentFrom(r) : null;
    },
    persons() {
      return (prepare('SELECT DISTINCT person_id AS id FROM person_consents ORDER BY person_id').all() as { id: string }[]).map((r) => r.id);
    },
  };

  return { devices, linkCodes, invites, pushSubs, consents };
}
