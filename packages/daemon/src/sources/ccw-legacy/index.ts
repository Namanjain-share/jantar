/**
 * sources/ccw-legacy: a read-only view of the legacy ccw tool's files while
 * it still runs alongside Jantar.
 *
 * - moves(): ~/.config/ccw/switch/<sid>.json (emitted as move.* events while
 *   started, move.cleared when a file goes away), so the board shows moves
 *   and the writer can refuse to type while ccw is moving a session;
 * - moveLocked(): ccw holds switch/<sid>.lock (checked with `lsof`, never by
 *   taking the lock), or the move file says a typing step;
 * - burn(), plan(): ccw's learned burn rates and the "next ->" / "full in"
 *   projection from them;
 * - botRunning(): ccw's Telegram bot holds telegram.lock (lsof; falls back to
 *   the process list). The bot's config, telegram.json, is never opened.
 *
 * Nothing in ~/.config/ccw is ever created, written, locked or deleted.
 */
import { join } from 'node:path';
import { EVENT, type Move, type PlanResponse } from '@jantar/protocol';
import type { AccountId } from '@jantar/protocol';
import type { CcwBurn, CcwLegacySource, DaemonContext, Factories, TimerId } from '../../contracts.js';
import { cLocale } from '../../core/exec.js';
import { fileSig, fsx, listDir, readJsonFile } from '../lib/fsx.js';
import { Serial } from '../lib/serial.js';
import { stableJson, toIso } from '../lib/values.js';
import {
  ACTIVE_MOVE_STEPS,
  parseActive,
  parseBurn,
  parseMove,
  parseRawMove,
  parseSwitchConfig,
  type CcwSwitchConfig,
  type RawMove,
} from './files.js';
import { computePlan } from './plan.js';

export interface CcwLegacyOptions {
  /** How often move files are checked while started (default 2000 ms). */
  pollMs?: number;
  /** botRunning() result reuse (default 5000 ms, as ccw). */
  botCacheMs?: number;
  lsofTimeoutMs?: number;
}

const MOVE_EVENT = {
  saving: EVENT.MOVE_SAVING,
  restarting: EVENT.MOVE_RESTARTING,
  continuing: EVENT.MOVE_CONTINUING,
  parked: EVENT.MOVE_PARKED,
  stuck: EVENT.MOVE_STUCK,
} as const;

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** ccw drops stuck moves after 30 min (5 min for a retry); we just stop showing them. */
const STUCK_SHOWN_MS = 30 * 60_000;
const STUCK_RETRY_SHOWN_MS = 5 * 60_000;

export class CcwLegacy implements CcwLegacySource {
  private bot: { at: number; running: boolean } | null = null;
  private lastSwitch: CcwSwitchConfig | null = null;
  private readonly emitted = new Map<string, string>();
  private timer: TimerId | undefined;
  private started = false;
  private readonly serial: Serial<void>;
  private readonly opts: Required<CcwLegacyOptions>;

  constructor(
    private readonly ctx: DaemonContext,
    opts: CcwLegacyOptions = {},
  ) {
    this.opts = {
      pollMs: opts.pollMs ?? 2000,
      botCacheMs: opts.botCacheMs ?? 5000,
      lsofTimeoutMs: opts.lsofTimeoutMs ?? 5000,
    };
    this.serial = new Serial(() => this.syncMoves());
  }

  // ---------------------------------------------------------------- Service

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.pollOnce();
    if (!this.started) return;
    this.timer = this.ctx.clock.setInterval(() => {
      this.pollOnce().catch((e) => this.ctx.log.error('ccw move poll failed', { error: String(e) }));
    }, this.opts.pollMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ctx.clock.clearInterval(this.timer);
    this.timer = undefined;
    await this.serial.idle();
  }

  /** One pass over ccw's move files (the timer calls this; tests call it directly). */
  pollOnce(): Promise<void> {
    return this.serial.run();
  }

  // ---------------------------------------------------------------- CcwLegacySource

  present(): boolean {
    return fsx.existsSync(this.ctx.paths.ccwDir);
  }

  async botRunning(): Promise<boolean> {
    const now = this.ctx.clock.now();
    if (this.bot && now - this.bot.at < this.opts.botCacheMs) return this.bot.running;
    const running = await this.checkBot();
    this.bot = { at: now, running };
    return running;
  }

  async moves(): Promise<Move[]> {
    const now = this.ctx.clock.now();
    const out: Move[] = [];
    for (const { raw } of await this.readMoveFiles()) {
      const m = parseMove(raw, (pid) => this.ctx.proc.isAlive(pid));
      if (!m) continue;
      if (m.step === 'stuck' && !m.orphan) {
        const shownFor = m.retry ? STUCK_RETRY_SHOWN_MS : STUCK_SHOWN_MS;
        if (now - Date.parse(m.since) > shownFor) continue;
      }
      out.push(m);
    }
    return out.sort((a, b) => a.since.localeCompare(b.since) || a.sid.localeCompare(b.sid));
  }

  async moveFor(sid: string): Promise<Move | null> {
    if (!SID_RE.test(sid)) return null;
    return (await this.moves()).find((m) => m.sid === sid) ?? null;
  }

  async moveLocked(sid: string): Promise<boolean> {
    if (!SID_RE.test(sid) || !this.present()) return false;
    const lock = join(this.ctx.paths.ccwSwitchDir, `${sid}.lock`);
    if (await fileSig(lock)) {
      const holders = await this.lockHolders(lock);
      if (holders && holders.length > 0) return true;
    }
    // the move file itself says ccw is typing into it (and its owner is alive, or unknown)
    const raw = await this.rawMove(sid);
    if (!raw || !(ACTIVE_MOVE_STEPS as readonly string[]).includes(raw.step)) return false;
    return raw.ownerPid === undefined || this.ctx.proc.isAlive(raw.ownerPid);
  }

  async burn(): Promise<CcwBurn[]> {
    const r = await readJsonFile(this.ctx.paths.ccwBurnJson);
    if (!r.ok) return [];
    return parseBurn(r.value).map((b) => ({ sid: b.sid, pctPerMin: b.pctPerMin, updatedAt: new Date(b.updatedMs).toISOString() }));
  }

  async plan(): Promise<PlanResponse> {
    if (!this.present()) return { source: 'none', next: null, accounts: [], updatedAt: null };
    const cfg = (await this.fullSwitchConfig()) ?? (parseSwitchConfig({}) as CcwSwitchConfig);
    const burnFile = await readJsonFile(this.ctx.paths.ccwBurnJson);
    const activeFile = await readJsonFile(this.ctx.paths.ccwActiveJson);
    const state = this.ctx.store.getState();
    const out = computePlan({
      nowMs: this.ctx.clock.now(),
      accounts: Object.values(state.accounts),
      sessions: Object.values(state.sessions),
      moves: await this.moves(),
      burn: burnFile.ok ? parseBurn(burnFile.value) : [],
      active: activeFile.ok ? parseActive(activeFile.value) : new Map(),
      cfg,
    });
    return {
      source: 'ccw-legacy',
      next: out.next,
      accounts: out.accounts,
      updatedAt: burnFile.ok ? (toIso(burnFile.sig.mtimeMs) ?? null) : null,
      ceiling: cfg.ceiling,
      weeklyCeiling: cfg.weeklyCeiling,
    };
  }

  async switchConfig(): Promise<{ on: boolean; dryRun: boolean; hold: AccountId[]; groups: string[][] } | null> {
    const cfg = await this.fullSwitchConfig();
    return cfg ? { on: cfg.on, dryRun: cfg.dryRun, hold: [...cfg.hold], groups: cfg.groups.map((g) => [...g]) } : null;
  }

  // ---------------------------------------------------------------- internals

  /** switch.json; a file that won't parse keeps the last good copy (as ccw does). */
  private async fullSwitchConfig(): Promise<CcwSwitchConfig | null> {
    const r = await readJsonFile(this.ctx.paths.ccwSwitchJson);
    if (!r.ok) {
      if (r.reason === 'missing') this.lastSwitch = null;
      return this.lastSwitch;
    }
    const cfg = parseSwitchConfig(r.value);
    if (cfg) this.lastSwitch = cfg;
    return this.lastSwitch;
  }

  private async readMoveFiles(): Promise<Array<{ file: string; raw: unknown }>> {
    const dir = this.ctx.paths.ccwSwitchDir;
    const out: Array<{ file: string; raw: unknown }> = [];
    for (const d of await listDir(dir)) {
      if (!d.isFile() || !d.name.endsWith('.json') || d.name === 'burn.json' || d.name.startsWith('.')) continue;
      const file = join(dir, d.name);
      const r = await readJsonFile(file, 256 * 1024);
      if (r.ok) out.push({ file, raw: r.value });
    }
    return out;
  }

  private async rawMove(sid: string): Promise<RawMove | null> {
    const r = await readJsonFile(join(this.ctx.paths.ccwSwitchDir, `${sid}.json`), 256 * 1024);
    if (!r.ok) return null;
    const m = parseRawMove(r.value);
    return m && m.sid === sid ? m : null;
  }

  /** Pids holding `path` open, or null when lsof could not tell. */
  private async lockHolders(path: string): Promise<number[] | null> {
    const lsof = this.ctx.bins.lsof;
    if (!lsof) return null;
    const res = await this.ctx.exec(lsof, ['-t', '--', path], {
      env: cLocale(this.ctx.env),
      timeoutMs: this.opts.lsofTimeoutMs,
      maxBuffer: 256 * 1024,
    });
    if (res.spawnError || res.timedOut) return null;
    if (res.code === 1 && !res.stdout.trim()) return [];
    if (res.code !== 0) return null;
    const pids = new Set<number>();
    for (const line of res.stdout.split('\n')) {
      const m = /^\s*(\d+)\s*$/.exec(line) ?? /^\S+\s+(\d+)\s/.exec(line);
      if (m) pids.add(Number(m[1]));
    }
    pids.delete(process.pid);
    return [...pids];
  }

  private async checkBot(): Promise<boolean> {
    if (!this.present()) return false;
    const lock = join(this.ctx.paths.ccwDir, 'telegram.lock');
    if (await fileSig(lock)) {
      const holders = await this.lockHolders(lock);
      if (holders !== null) return holders.length > 0;
    } else if (this.ctx.bins.lsof) {
      return false; // the bot creates its lock when it starts
    }
    // lsof unavailable: look for `ccw --telegram` in the process list
    const res = await this.ctx.exec(this.ctx.bins.ps, ['-axo', 'pid=,args='], {
      env: cLocale(this.ctx.env),
      timeoutMs: this.opts.lsofTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.spawnError || res.timedOut) return false;
    return res.stdout.split('\n').some((l) => /(?:^|[\s/])ccw(?:\.py)?\s(?:.*\s)?--telegram(?:\s|$)/.test(l));
  }

  private async syncMoves(): Promise<void> {
    if (!this.started) return;
    const moves = this.present() ? await this.moves() : [];
    const seen = new Set<string>();
    for (const m of moves) {
      seen.add(m.sid);
      const key = stableJson(m);
      if (this.emitted.get(m.sid) === key) continue;
      try {
        this.ctx.store.emit({ type: MOVE_EVENT[m.step], sid: m.sid, account: m.from, data: { move: m } });
        this.emitted.set(m.sid, key);
      } catch (e) {
        this.ctx.log.error('could not publish ccw move', { sid: m.sid, error: String(e) });
      }
    }
    for (const sid of [...this.emitted.keys()]) {
      if (seen.has(sid)) continue;
      this.emitted.delete(sid);
      try {
        this.ctx.store.emit({ type: EVENT.MOVE_CLEARED, sid, data: {} });
      } catch (e) {
        this.ctx.log.error('could not publish ccw move end', { sid, error: String(e) });
      }
    }
  }
}

/** Factories['ccwLegacy']. */
export const createCcwLegacySource: Factories['ccwLegacy'] = (ctx) => new CcwLegacy(ctx);

export function createCcwLegacy(ctx: DaemonContext, opts: CcwLegacyOptions = {}): CcwLegacy {
  return new CcwLegacy(ctx, opts);
}

export { computePlan, groupKey, type PlanInput, type PlanOutput } from './plan.js';
export { parseBurn, parseMove, parseSwitchConfig, parseActive, ACTIVE_MOVE_STEPS, type CcwSwitchConfig } from './files.js';
