/**
 * An in-memory Db with the same behaviour as the SQLite one, for unit tests.
 * Not for production use: nothing survives a restart.
 */
import {
  LAUNCH_FINAL_STAGES,
  type AuditEntry,
  type DaemonEvent,
  type Device,
  type LaunchFlags,
  type LaunchJob,
  type PendingRequest,
  type PushSubscriptionRecord,
} from '@jantar/protocol';
import type { CaptureKeyRecord, Db, ExtensionRecord, FolderPin, FolderSeen, NodeRecord, RewriteRun } from '../contracts.js';

const clone = <T>(v: T): T => structuredClone(v);

export function createMemoryDb(): Db & { closed: boolean } {
  let events: DaemonEvent[] = [];
  const audit: AuditEntry[] = [];
  const devices = new Map<string, Device>();
  const subs = new Map<string, PushSubscriptionRecord>();
  const pending = new Map<string, PendingRequest>();
  const kv = new Map<string, unknown>();
  const launches = new Map<string, LaunchJob>();
  const pins = new Map<string, FolderPin>();
  const seen = new Map<string, FolderSeen>();
  const flags = new Map<string, LaunchFlags>();
  const runs = new Map<string, RewriteRun>();
  const exts = new Map<string, ExtensionRecord>();
  const nodeRows = new Map<string, NodeRecord>();
  const captureKeyRows = new Map<string, CaptureKeyRecord>();
  let auditSeq = 0;

  const db: Db & { closed: boolean } = {
    closed: false,
    events: {
      append(ev) {
        events.push(clone(ev));
      },
      since(after, opts = {}) {
        const out = events.filter((e) => e.seq > after && (!opts.types || opts.types.includes(e.type)));
        return clone(opts.limit !== undefined ? out.slice(0, opts.limit) : out);
      },
      latest(opts) {
        const out = events
          .filter((e) => (opts.after === undefined || e.seq > opts.after) && (!opts.types || opts.types.includes(e.type)))
          .sort((a, b) => b.seq - a.seq);
        return clone(out.slice(0, opts.limit));
      },
      maxSeq() {
        return events.reduce((m, e) => Math.max(m, e.seq), 0);
      },
      prune(keep) {
        const sorted = [...events].sort((a, b) => a.seq - b.seq);
        const drop = Math.max(0, sorted.length - keep);
        events = sorted.slice(drop);
        return drop;
      },
    },
    audit: {
      append(entry) {
        const full: AuditEntry = { ...clone(entry), seq: ++auditSeq };
        audit.push(full);
        return clone(full);
      },
      list(opts = {}) {
        const limit = opts.limit ?? 100;
        if (opts.after !== undefined) return clone(audit.filter((a) => a.seq > (opts.after ?? 0)).slice(0, limit));
        return clone(audit.slice(-limit));
      },
    },
    devices: {
      insert(d) {
        if (devices.has(d.id)) throw new Error(`device ${d.id} exists`);
        devices.set(d.id, clone(d));
      },
      get(id) {
        const d = devices.get(id);
        return d ? clone(d) : null;
      },
      byKeyHash(hash) {
        for (const d of devices.values()) if (d.keyHash === hash) return clone(d);
        return null;
      },
      list() {
        return clone([...devices.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      },
      touch(id, at) {
        const d = devices.get(id);
        if (d) d.lastSeenAt = at;
      },
      revoke(id, at) {
        const d = devices.get(id);
        if (!d) return null;
        if (!d.revokedAt) d.revokedAt = at;
        return clone(d);
      },
      setScopes(id, scopes) {
        const d = devices.get(id);
        if (!d) return null;
        d.scopes = [...scopes];
        return clone(d);
      },
    },
    pushSubs: {
      upsert(rec) {
        subs.set(rec.subscription.endpoint, clone(rec));
      },
      remove(endpoint) {
        return subs.delete(endpoint);
      },
      removeForDevice(deviceId) {
        let n = 0;
        for (const [k, v] of subs) {
          if (v.deviceId === deviceId) {
            subs.delete(k);
            n += 1;
          }
        }
        return n;
      },
      list() {
        return clone([...subs.values()]);
      },
    },
    pending: {
      record(p) {
        pending.set(p.id, clone(p));
      },
      get(id) {
        const p = pending.get(id);
        return p ? clone(p) : null;
      },
      list(opts = {}) {
        const out = [...pending.values()]
          .filter((p) => !opts.sid || p.sid === opts.sid)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return clone(opts.limit !== undefined ? out.slice(0, opts.limit) : out);
      },
    },
    kv: {
      get<T = unknown>(key: string): T | undefined {
        return kv.has(key) ? (clone(kv.get(key)) as T) : undefined;
      },
      set(key, value) {
        kv.set(key, clone(value));
      },
      delete(key) {
        kv.delete(key);
      },
    },
    launches: {
      save(job) {
        launches.set(job.id, clone(job));
      },
      get(id) {
        const j = launches.get(id);
        return j ? clone(j) : null;
      },
      list(opts = {}) {
        const out = [...launches.values()]
          .filter((j) => !opts.unfinished || !LAUNCH_FINAL_STAGES.includes(j.stage))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        return clone(opts.limit !== undefined ? out.slice(0, opts.limit) : out);
      },
    },
    folders: {
      pin(p) {
        pins.set(`${p.rootId}\u0000${p.rel}`, clone(p));
      },
      unpin(rootId, rel) {
        return pins.delete(`${rootId}\u0000${rel}`);
      },
      pins() {
        return clone(
          [...pins.values()].sort((a, b) => a.pinnedAt.localeCompare(b.pinnedAt) || a.rootId.localeCompare(b.rootId) || a.rel.localeCompare(b.rel)),
        );
      },
      seen(row) {
        seen.set(row.cwd, clone(row));
      },
      recentSeen(limit) {
        const out = [...seen.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.cwd.localeCompare(b.cwd));
        return clone(out.slice(0, Math.max(0, limit)));
      },
    },
    launchFlags: {
      get(actor) {
        const f = flags.get(actor);
        return f ? clone(f) : null;
      },
      set(actor, f) {
        flags.set(actor, clone(f));
      },
    },
    rewriteRuns: {
      record(run) {
        runs.set(run.id, clone(run));
      },
      list(opts = {}) {
        const out = [...runs.values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
        return clone(opts.limit !== undefined ? out.slice(0, opts.limit) : out);
      },
    },
    extensions: {
      insert(e) {
        if (exts.has(e.id)) throw new Error(`extension ${e.id} exists`);
        for (const x of exts.values()) if (x.keyHash === e.keyHash) throw new Error('extension key exists');
        exts.set(e.id, clone(e));
      },
      get(id) {
        const e = exts.get(id);
        return e ? clone(e) : null;
      },
      byKeyHash(hash) {
        for (const e of exts.values()) if (e.keyHash === hash) return clone(e);
        return null;
      },
      list() {
        return clone([...exts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
      },
      touch(id, at) {
        const e = exts.get(id);
        if (e) e.lastSeenAt = at;
      },
      revoke(id, at) {
        const e = exts.get(id);
        if (!e) return null;
        if (!e.revokedAt) e.revokedAt = at;
        return clone(e);
      },
    },
    nodes: {
      insert(n) {
        if (nodeRows.has(n.id)) throw new Error(`node ${n.id} exists`);
        // The SQLite table's unique index: one live node per name.
        for (const x of nodeRows.values()) if (x.name === n.name && x.revokedAt === null) throw new Error('node name exists');
        nodeRows.set(n.id, clone(n));
      },
      get(id) {
        const n = nodeRows.get(id);
        return n ? clone(n) : null;
      },
      byName(name) {
        for (const n of nodeRows.values()) if (n.name === name && n.revokedAt === null) return clone(n);
        return null;
      },
      list() {
        return clone([...nodeRows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
      },
      touch(id, at) {
        const n = nodeRows.get(id);
        if (n) n.lastSeenAt = at;
      },
      setInfo(id, info) {
        const n = nodeRows.get(id);
        if (n) Object.assign(n, { os: info.os, version: info.version });
      },
      revoke(id, at) {
        const n = nodeRows.get(id);
        if (!n) return null;
        if (!n.revokedAt) n.revokedAt = at;
        return clone(n);
      },
    },
    captureKeys: {
      insert(k) {
        if (captureKeyRows.has(k.id)) throw new Error(`capture key ${k.id} exists`);
        for (const x of captureKeyRows.values()) if (x.keyHash === k.keyHash) throw new Error('capture key exists');
        captureKeyRows.set(k.id, clone(k));
      },
      byHash(hash) {
        for (const k of captureKeyRows.values()) if (k.keyHash === hash) return clone(k);
        return null;
      },
      list() {
        return clone([...captureKeyRows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
      },
      touch(id, at) {
        const k = captureKeyRows.get(id);
        if (k) k.lastSeenAt = at;
      },
      revoke(id, at) {
        const k = captureKeyRows.get(id);
        if (!k) return null;
        if (!k.revokedAt) k.revokedAt = at;
        return clone(k);
      },
      revokeAll(at) {
        let n = 0;
        for (const k of captureKeyRows.values()) {
          if (k.revokedAt) continue;
          k.revokedAt = at;
          n += 1;
        }
        return n;
      },
      activeCount() {
        let n = 0;
        for (const k of captureKeyRows.values()) if (!k.revokedAt) n += 1;
        return n;
      },
    },
    close() {
      db.closed = true;
    },
  };
  return db;
}
