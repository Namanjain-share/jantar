/**
 * The Life service (WP-LS, spec 4.1): life.db, the five modules, the one
 * scheduler and the nightly backup, in one daemon part.
 *
 * - Start: when any module is on, open life.db (db.ts openLifeDb), build
 *   the five modules on one LifeCore (each builder registers its ping
 *   handlers), start the scheduler (a catch-up sweep, then every handler's
 *   resync) and the nightly backup. With every module off nothing opens.
 * - Settings (ctx.settings.subscribe): the first module turned on opens
 *   life.db; a module turned on again resyncs its kinds; a zone change
 *   resyncs every handler and moves the 03:30 backup; the last module
 *   turned off stops the scheduler (the db stays open until the daemon
 *   stops). Any change to `life.*` emits life.changed.
 * - Broken: a refused open records LIFE_BROKEN_REASON (Life answers 503,
 *   the file untouched), a builder that throws records LIFE_START_FAILED;
 *   either logs `{ event: 'life.broken', code }`, pushes one "Life data
 *   needs attention" to control devices (once until a restore mends it) and
 *   keeps the daemon running. `broken()` is a field read. Restore is the
 *   way out.
 * - Status: `open` while life.db is open and a module is on; `backups` is
 *   read again only when the backups folder changed (status is polled).
 * - The zone: `life.timezone` when this runtime knows it, else the Mac's
 *   zone at start (`TZ` from the daemon's env when it names a known zone,
 *   else Intl's).
 * - Restore (a `life-*.db` name inside backupsDir): the backup is copied
 *   beside life.db and opened there first, so openLifeDb's checks (header,
 *   quick_check, schema) judge it before anything is swapped; then the
 *   scheduler stops, the open handle closes, life.db (with its -wal and
 *   -shm) is kept as `life.db.before-restore-<time>`, the copy takes its
 *   place, `core.db` points at the new handle, every handler resyncs, the
 *   scheduler restarts and life.changed goes out. Allowed while broken; a
 *   Life that still cannot start on the restored file answers so.
 *
 * Nothing here logs or emits Life text: logs carry codes, kinds and
 * counts; the only event is `life.changed {}`.
 */
import { chmodSync, copyFileSync, constants as fsConstants, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { dayKeyOf, isValidTimeZone } from '@jantar/life-core';
import { CLI_NAME, LIFE_MODULES, lifeOn, type LifeStatus, type Settings, type Today } from '@jantar/protocol';
import { hasScope } from '../auth/scopes.js';
import type {
  DaemonContext,
  Db,
  Factories,
  FinanceModule,
  FoodModule,
  LifeCore,
  LifeDb,
  LifeModule,
  LifeModuleBuilders,
  LifeModuleDeps,
  LifeModuleName,
  LifeResult,
  LifeService,
  Logger,
  MedicinesModule,
  PingKind,
  PlacesModule,
  TodosModule,
  Unsubscribe,
} from '../contracts.js';
import { newId } from '../core/ids.js';
import { pushEndpointProblem } from '../notify/push-hosts.js';
import { BackupTimer, backupSummary, listBackups, restoreTarget, RESTORE_REFUSED, writeBackup } from './backup.js';
import { LIFE_BROKEN_REASON, openLifeDb } from './db.js';
import { KIND_MODULE, PING_KINDS, errorKind } from './pings.js';
import { createLifeSend, pushNotice, type LifeSend } from './push.js';
import { LifeScheduler } from './scheduler.js';
import { buildToday } from './today.js';

export type LifeServiceDeps = Parameters<Factories['life']>[1];

export interface LifeServiceOptions {
  /** The Mac's zone (default: TZ from ctx.env when this runtime knows it, else Intl's). */
  macZone?: string;
  /** How Life pushes go out (default: Web Push through deps.notifiers, push.ts). */
  send?: LifeSend;
}

/** While a builder threw at start: Life answers 503 with this. */
export const LIFE_START_FAILED = "Life could not start on the Mac. Its data is untouched; the daemon's log says why.";
/**
 * life.db is gone while backups of it exist (deleted, a partial restore of
 * the Mac, a state dir moved without it): Life does not start empty over
 * them, since each night's empty backup would push a good one out.
 */
export const LIFE_MISSING_REASON = `Life data is missing, but there are backups of it. Restore one at your Mac: ${CLI_NAME} life restore <file> (with no file it lists them). To start empty instead, move the backups folder aside and restart the daemon (${CLI_NAME} install).`;
/** A module call while life.db is not open (between a switch and the open, or after a failed restore). */
export const LIFE_CLOSED = 'Life is not open right now. Try again in a moment.';

export const BACKUP_REASONS = {
  closed: 'Life is off, so there is nothing to back up yet.',
  broken: 'life.db could not be opened, so there is nothing to back up. Restore a backup instead.',
  notStarted: "Life could not start on the Mac, so no backup was made. life.db is untouched; the daemon's log says why.",
  failed: "The backup could not be written. The daemon's log says why.",
} as const;

export const RESTORE_REASONS = {
  copy: 'The backup could not be copied next to life.db. Nothing was changed.',
  check: 'That backup failed its check (damaged, or from a newer version). life.db is unchanged.',
  swap: "life.db could not be replaced. The daemon's log says why.",
  reopen: "The backup is back in place, but Life could not start on it. The previous life.db is kept beside it; the daemon's log says why.",
} as const;

/** The control-scope devices that would get a Life push now: not revoked, with a subscription to a known push service. */
export function pushDevices(db: Pick<Db, 'devices' | 'pushSubs'>): number {
  const ids = new Set<string>();
  for (const rec of db.pushSubs.list()) if (!pushEndpointProblem(rec.subscription.endpoint)) ids.add(rec.deviceId);
  let n = 0;
  for (const id of ids) {
    const d = db.devices.get(id);
    if (d && !d.revokedAt && hasScope(d.scopes, 'control')) n += 1;
  }
  return n;
}

type Modules = { todos: TodosModule; medicines: MedicinesModule; food: FoodModule; places: PlacesModule; finance: FinanceModule };

/** A module stand-in while life.db is not open: every call answers `unavailable`. */
function closedModule<M extends LifeModule>(name: LifeModuleName, extra: Record<string, unknown> = {}): M {
  const base: Record<string, unknown> = { name, today: () => ({}), ...extra };
  const refusal: LifeResult = { ok: false, code: 'unavailable', reason: LIFE_CLOSED };
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'start' || prop === 'stop') return undefined;
      if (Object.hasOwn(target, prop)) return target[prop];
      return () => refusal;
    },
  }) as unknown as M;
}

/** The zone this Mac runs in. */
function macZoneOf(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.TZ;
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  const intl = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return intl && isValidTimeZone(intl) ? intl : 'UTC';
}

/** Which ping kinds belong to each module. */
const MODULE_KINDS = new Map<LifeModuleName, PingKind[]>();
for (const k of PING_KINDS) MODULE_KINDS.set(KIND_MODULE[k], [...(MODULE_KINDS.get(KIND_MODULE[k]) ?? []), k]);

class LifeServiceImpl implements LifeService {
  private handle: LifeDb | null = null;
  private brokenReason: string | null = null;
  private built: Modules | null = null;
  private started = false;
  private unsubscribe: Unsubscribe | null = null;
  private zone: string;
  private noticeSent = false;
  private backupFailedOn: string | null = null;
  /** LifeStatus.backups as last read, with the backups folder's mtime then. */
  private backupsSeen: { mtimeMs: number; value: LifeStatus['backups'] } | null = null;
  private readonly macZone: string;
  private readonly log: Logger;
  private readonly send: LifeSend;
  private readonly core: LifeCore;
  private readonly scheduler: LifeScheduler;
  private readonly backups: BackupTimer;
  private readonly closed: Modules = {
    todos: closedModule<TodosModule>('todos'),
    medicines: closedModule<MedicinesModule>('medicines'),
    food: closedModule<FoodModule>('food', { estimateStatus: () => ({ available: false, reason: LIFE_CLOSED }) }),
    places: closedModule<PlacesModule>('places'),
    finance: closedModule<FinanceModule>('finance'),
  };

  constructor(
    private readonly ctx: DaemonContext,
    private readonly deps: LifeServiceDeps,
    private readonly builders: LifeModuleBuilders,
    opts: LifeServiceOptions,
  ) {
    this.log = ctx.log.child({ part: 'life' });
    this.macZone = opts.macZone ?? macZoneOf(ctx.env);
    this.zone = this.zoneFor(ctx.settings.get());
    this.send = opts.send ?? createLifeSend(ctx, deps.notifiers);
    const db = () => {
      if (!this.handle) throw new Error('life.db is not open');
      return this.handle;
    };
    this.scheduler = new LifeScheduler(ctx.clock, this.log, db, { send: this.send, kinds: () => this.ringingKinds() });
    const self = this;
    this.core = {
      get db() {
        return db();
      },
      tz: () => self.zone,
      now: () => new Date(ctx.clock.now()),
      today: () => dayKeyOf(new Date(ctx.clock.now()), self.zone),
      settings: () => ctx.settings.get().life,
      changed: () => self.changed(),
      scheduler: this.scheduler,
      newId,
    };
    this.backups = new BackupTimer(ctx.clock, this.log, { dir: ctx.paths.backupsDir, tz: () => this.zone, run: () => this.nightly() });
  }

  get todos(): TodosModule {
    return this.live()?.todos ?? this.closed.todos;
  }
  get medicines(): MedicinesModule {
    return this.live()?.medicines ?? this.closed.medicines;
  }
  get food(): FoodModule {
    return this.live()?.food ?? this.closed.food;
  }
  get places(): PlacesModule {
    return this.live()?.places ?? this.closed.places;
  }
  get finance(): FinanceModule {
    return this.live()?.finance ?? this.closed.finance;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.ctx.settings.subscribe((next, prev) => this.guarded(() => this.onSettings(next, prev)));
    if (lifeOn(this.ctx.settings.get())) this.guarded(() => this.open());
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scheduler.stop();
    this.scheduler.detach();
    this.backups.stop();
    for (const m of Object.values(this.built ?? {}) as LifeModule[]) {
      try {
        m.stop?.();
      } catch (e) {
        this.log.warn('life module failed to stop', { module: m.name, error: errorKind(e) });
      }
    }
    this.handle?.close();
    this.handle = null;
  }

  broken(): string | null {
    return this.brokenReason;
  }

  status(): LifeStatus {
    const s = this.ctx.settings.get();
    const modules = Object.fromEntries(LIFE_MODULES.map((m) => [m, s.life[m]])) as LifeStatus['modules'];
    let estimate: LifeStatus['estimate'] = { available: false };
    if (s.life.food && this.live()) {
      try {
        estimate = this.food.estimateStatus();
      } catch (e) {
        this.log.warn('life estimate status failed', { error: errorKind(e) });
      }
    }
    let devices = 0;
    try {
      devices = pushDevices(this.ctx.db);
    } catch (e) {
      this.log.warn('life push count failed', { error: errorKind(e) });
    }
    return {
      open: this.handle !== null && lifeOn(s),
      ...(this.brokenReason !== null ? { broken: this.brokenReason } : {}),
      timezone: this.zone,
      today: this.core.today(),
      currency: s.life.currency,
      lockScreenDetails: s.life.lockScreenDetails,
      modules,
      estimate,
      backups: this.backupsStatus(),
      push: { devices, webpush: s.notify.webpush },
    };
  }

  today(day?: string): LifeResult<Today> {
    const mods = this.live();
    if (!mods) return { ok: false, code: 'unavailable', reason: this.brokenReason ?? LIFE_CLOSED };
    const today = this.core.today();
    const d = day ?? today;
    if (d > today) return { ok: false, code: 'invalid_request', reason: 'Today shows today or an earlier day.' };
    return { ok: true, value: buildToday(d, this.ctx.settings.get().life, mods, this.log) };
  }

  async backup(): Promise<LifeResult<{ file: string; at: string }>> {
    if (!this.handle) {
      const reason = this.brokenReason === LIFE_START_FAILED ? BACKUP_REASONS.notStarted : this.brokenReason ? BACKUP_REASONS.broken : BACKUP_REASONS.closed;
      return { ok: false, code: 'unavailable', reason };
    }
    const r = writeBackup(this.handle, this.ctx.paths.backupsDir, this.core.today());
    this.backupsSeen = null;
    if (!r.ok) {
      this.log.error('life backup failed', { event: 'life.backup', code: r.code });
      return { ok: false, code: 'unavailable', reason: BACKUP_REASONS.failed };
    }
    this.log.info('life backed up', { event: 'life.backup' });
    return { ok: true, value: { file: r.file, at: this.ctx.clock.iso() } };
  }

  async restore(file: string): Promise<LifeResult<{ kept: string }>> {
    const target = restoreTarget(this.ctx.paths.backupsDir, file);
    if (!target.ok) return { ok: false, code: target.reason === RESTORE_REFUSED.missing ? 'not_found' : 'invalid_request', reason: target.reason };
    const live = this.ctx.paths.lifeDb;
    const staging = `${live}.restoring`;
    removeDbFiles(staging);
    try {
      copyFileSync(target.path, staging, fsConstants.COPYFILE_EXCL);
      chmodSync(staging, 0o600);
    } catch (e) {
      removeDbFiles(staging);
      this.log.error('life restore failed', { event: 'life.restore', code: 'copy_failed', error: errorKind(e) });
      return { ok: false, code: 'unavailable', reason: RESTORE_REASONS.copy };
    }
    // openLifeDb judges the copy (and brings an older schema up to date) before anything is swapped.
    const check = openLifeDb(staging);
    if (!check.ok) {
      removeDbFiles(staging);
      this.log.warn('life restore refused', { event: 'life.restore', code: check.code });
      return { ok: false, code: 'invalid_request', reason: RESTORE_REASONS.check };
    }
    check.db.close();

    this.scheduler.stop();
    this.scheduler.detach();
    this.backups.stop();
    this.handle?.close();
    this.handle = null;
    let kept = '';
    try {
      if (existsSync(live)) {
        const keptPath = `${live}.before-restore-${this.ctx.clock.iso().replace(/[:.]/g, '-')}`;
        kept = basename(keptPath);
        renameSync(live, keptPath);
        // The WAL and shm go with their file, never onto the restored one.
        for (const suffix of ['-wal', '-shm']) if (existsSync(live + suffix)) renameSync(live + suffix, keptPath + suffix);
      }
      for (const suffix of ['-wal', '-shm']) if (existsSync(staging + suffix)) unlinkSync(staging + suffix);
      renameSync(staging, live);
    } catch (e) {
      this.log.error('life restore failed', { event: 'life.restore', code: 'swap_failed', error: errorKind(e) });
      this.brokenReason = LIFE_BROKEN_REASON;
      this.changed();
      return { ok: false, code: 'unavailable', reason: RESTORE_REASONS.swap };
    }
    this.brokenReason = null;
    this.backupsSeen = null;
    // The restored rows are history: every handler rebuilds them, and what came due since the backup moves on
    // unsent, before the first sweep.
    if (lifeOn(this.ctx.settings.get()) && !this.open({ resyncFirst: true })) {
      this.log.error('life restore failed', { event: 'life.restore', code: 'reopen_failed' });
      return { ok: false, code: 'unavailable', reason: RESTORE_REASONS.reopen };
    }
    // Mended: a later break says so on the phone again.
    this.noticeSent = false;
    this.log.info('life restored', { event: 'life.restore' });
    this.changed();
    return { ok: true, value: { kept } };
  }

  // -------------------------------------------------------------------------

  /** A Life failure stays in Life: whatever `fn` throws makes Life broken, never the caller (daemon start, a settings PATCH). */
  private guarded(fn: () => unknown): void {
    try {
      fn();
    } catch (e) {
      this.log.error('life failed', { error: errorKind(e) });
      if (!this.brokenReason) this.fail('start_failed', LIFE_START_FAILED);
    }
  }

  /** LifeStatus.backups: listed again only when the folder's mtime moved, or after a backup or restore of ours. */
  private backupsStatus(): LifeStatus['backups'] {
    const dir = this.ctx.paths.backupsDir;
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      // No folder yet: no backups.
    }
    if (this.backupsSeen?.mtimeMs !== mtimeMs) this.backupsSeen = { mtimeMs, value: backupSummary(dir) };
    return this.backupsSeen.value;
  }

  /** The modules while life.db is open. */
  private live(): Modules | null {
    return this.handle && this.built ? this.built : null;
  }

  private zoneFor(s: Settings): string {
    const z = s.life.timezone;
    return z && isValidTimeZone(z) ? z : this.macZone;
  }

  /** Kinds whose module is on. */
  private ringingKinds(): PingKind[] {
    const life = this.ctx.settings.get().life;
    return PING_KINDS.filter((k) => life[KIND_MODULE[k]]);
  }

  private changed(): void {
    try {
      this.ctx.store.emit({ type: 'life.changed', data: {} });
    } catch (e) {
      this.log.error('life.changed not emitted', { error: errorKind(e) });
    }
  }

  /** Open life.db, build the modules once, start the timers. False when Life is broken. */
  private open(opts: { resyncFirst?: boolean } = {}): boolean {
    if (this.handle) return true;
    if (this.brokenReason) return false;
    if (!existsSync(this.ctx.paths.lifeDb) && listBackups(this.ctx.paths.backupsDir).length > 0) {
      this.fail('missing', LIFE_MISSING_REASON);
      return false;
    }
    const r = openLifeDb(this.ctx.paths.lifeDb);
    if (!r.ok) {
      this.fail(r.code, LIFE_BROKEN_REASON);
      return false;
    }
    this.handle = r.db;
    if (!this.built) {
      try {
        this.built = this.buildModules();
      } catch (e) {
        this.log.error('life module failed to build', { error: errorKind(e) });
        this.handle.close();
        this.handle = null;
        this.fail('start_failed', LIFE_START_FAILED);
        return false;
      }
    }
    if (lifeOn(this.ctx.settings.get())) {
      if (opts.resyncFirst) {
        this.scheduler.resyncAll();
        this.scheduler.skipDue();
      }
      this.scheduler.start();
    }
    this.backups.start();
    return true;
  }

  private buildModules(): Modules {
    const deps: LifeModuleDeps = { ctx: this.ctx, sessions: this.deps.sessions, usage: this.deps.usage, ccwLegacy: this.deps.ccwLegacy };
    const mods: Modules = {
      todos: this.builders.todos(this.core, deps),
      medicines: this.builders.medicines(this.core, deps),
      food: this.builders.food(this.core, deps),
      places: this.builders.places(this.core, deps),
      finance: this.builders.finance(this.core, deps),
    };
    for (const m of Object.values(mods) as LifeModule[]) m.start?.();
    return mods;
  }

  private fail(code: string, reason: string): void {
    this.brokenReason = reason;
    this.log.error('life is broken', { event: 'life.broken', code });
    this.changed();
    if (this.noticeSent) return;
    this.noticeSent = true;
    void pushNotice(this.ctx, this.send, { kind: 'life', title: 'Life data needs attention', body: 'Open Today on your phone, or check the Mac.', url: '/today', tag: 'life:broken' });
  }

  private onSettings(next: Settings, prev: Settings): void {
    const before = this.zone;
    this.zone = this.zoneFor(next);
    const lifeChanged = JSON.stringify(next.life) !== JSON.stringify(prev.life);
    if (!lifeChanged && next.notify.webpush === prev.notify.webpush) return;
    const on = lifeOn(next);
    if (on && !this.handle) {
      this.open();
    } else if (this.handle) {
      if (!on) {
        this.scheduler.stop();
      } else if (!this.scheduler.isRunning()) {
        this.scheduler.start();
      } else {
        const turnedOn = new Set<PingKind>();
        for (const m of LIFE_MODULES) if (next.life[m] && !prev.life[m]) for (const k of MODULE_KINDS.get(m) ?? []) turnedOn.add(k);
        if (before !== this.zone) this.scheduler.resyncAll();
        else if (turnedOn.size > 0) this.scheduler.resyncAll(turnedOn);
      }
      if (before !== this.zone) this.backups.rearm();
    }
    if (lifeChanged || lifeOn(next)) this.changed();
  }

  /** The nightly run: back up, and say so once a day when it failed. */
  private async nightly(): Promise<void> {
    if (!this.handle) return;
    const r = await this.backup();
    if (r.ok) return;
    const day = this.core.today();
    if (this.backupFailedOn === day) return;
    this.backupFailedOn = day;
    await pushNotice(this.ctx, this.send, { kind: 'life', title: 'Life backup failed', body: 'Tonight’s copy of Life data was not written.', url: '/today', tag: 'life:backup' });
  }
}

/** Delete a database file and its -wal and -shm (a staging copy). */
function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    } catch {
      /* best effort */
    }
  }
}

export function buildLifeService(ctx: DaemonContext, deps: LifeServiceDeps, builders: LifeModuleBuilders, opts: LifeServiceOptions = {}): LifeService {
  return new LifeServiceImpl(ctx, deps, builders, opts);
}
