/**
 * v0.10: Start when I join (spec 4). An arm is one tab's "start notes once I
 * am in the call", kept in chrome.storage.session under `arm:<tabId>` (in
 * memory, kept across the worker's stops, gone when Chrome quits or the
 * extension reloads; content scripts cannot read it: nothing here calls
 * setAccessLevel). The popup makes one (`arm`), or Always start when I join
 * a call does, while the page shows the call's join screen, its waiting room
 * or that it left the call. It holds the sheet's fields, the site and Meet's
 * code: never a URL. Notes start from it only on a `call` saying the page
 * has been in the call for two polls (meetings.ts), exactly as Start would.
 *
 * It ends when notes are on in the tab; on Cancel (Not this call, and End,
 * leave an `off` arm while Always is on, so Always does not come back for
 * that call in that tab); when the tab closes; on another call (another
 * Meet code or site); a minute after the page last showed a join screen,
 * waiting room or call (`away`: the page tells you when it is still there);
 * five minutes without a word from the page (`silent`); two hours unused
 * (`expired`); on Unpair or a 401; when Always goes off (its own arms); and
 * when a start by itself fails for good.
 *
 * Writes to one tab's arm run one at a time on their own chain (never
 * tabs.serial, so a 401 met inside a meeting step can drop every arm); the
 * decisions run inside tabs.serial (meetings.ts, the sweep, the switch). One
 * alarm (ARM_ALARM) wakes the worker at the earliest deadline to sweep the
 * arms that ended; every read checks the deadlines itself, so a late or lost
 * alarm only delays the badge.
 *
 * Always lives in chrome.storage.local (`startOnJoin`, no secret, like v0.8's
 * `readSaved`), cached here and read again after a worker restart.
 */
import type { ArmView, CallStage, Done } from '../shared/messages.js';
import type { MeetingSite } from '../shared/sites.js';
import { ARM_ALARM, ARM_TIMING } from '../shared/wire.js';
import { badgeOf, paint } from './badge.js';
import type { Ctx } from './ctx.js';
import { ALWAYS_ARMED, AUTO, TRY_AGAIN } from './sentences.js';
import { chains, type TabState } from './tabs.js';

/** chrome.storage.local's key for Always start when I join a call. */
export const ALWAYS_KEY = 'startOnJoin';
const PREFIX = 'arm:';
const keyOf = (tabId: number) => `${PREFIX}${tabId}`;

/** The stages a call can be armed on: its join screen, its waiting room, or left (to start on a rejoin). */
export const WAITING: ReadonlySet<CallStage> = new Set(['prejoin', 'lobby', 'left']);

export interface Arm {
  from: 'popup' | 'always';
  /** Not this call (or End) while Always is on: never starts; the same rules end it. */
  off?: true;
  site: MeetingSite;
  /** The Meet code when armed; null on Teams (the tab is the call). */
  callKey: string | null;
  /** '' = the page's title when notes start (a title that shows only in the call is used). */
  name: string;
  projectId?: string;
  people?: string;
  autoTodos: boolean;
  /** Armed at (ms). */
  at: number;
  /** at + ARM_TIMING.maxMs. */
  until: number;
  /** The page's last `call` (any stage). */
  heardAt: number;
  /** Since when the page has said only `none` (or page:hide). */
  awaySince?: number;
  /** How the last of those came: from a page still on a meeting host with nothing known on screen, or its pagehide. */
  awayHow?: 'screen' | 'hide';
  /** Starts by itself tried after "Jantar is not running" (D8). */
  tries: number;
}

export type Liveness = 'live' | 'expired' | 'away' | 'silent';

/** Whether an arm still holds at `now`, or which rule ended it. */
export function liveness(arm: Arm, now: number): Liveness {
  if (now >= arm.until) return 'expired';
  if (arm.awaySince !== undefined && now - arm.awaySince >= ARM_TIMING.awayMs) return 'away';
  if (now - arm.heardAt >= ARM_TIMING.silentMs) return 'silent';
  return 'live';
}

/** When an arm ends unless the page speaks again: the soonest of its deadlines. */
function deadline(arm: Arm): number {
  return Math.min(arm.until, arm.heardAt + ARM_TIMING.silentMs, arm.awaySince === undefined ? Infinity : arm.awaySince + ARM_TIMING.awayMs);
}

/** A stored arm, its shape checked as isTabState checks a tab's (only the worker writes either); anything else reads as no arm. */
function isArm(v: unknown): v is Arm {
  const a = (v ?? {}) as Record<string, unknown>;
  return (
    (a.from === 'popup' || a.from === 'always') &&
    (a.site === 'meet' || a.site === 'teams') &&
    typeof a.name === 'string' &&
    typeof a.autoTodos === 'boolean' &&
    [a.at, a.until, a.heardAt, a.tries].every((n) => typeof n === 'number')
  );
}

/** An arm as the popup shows it (a field it does not have stays out of the message). */
export function viewOf(arm: Arm): ArmView {
  return { from: arm.from, off: arm.off === true, name: arm.name, projectId: arm.projectId, people: arm.people, autoTodos: arm.autoTodos, until: arm.until };
}

/** A new arm for a tab's record at `now`. */
export function newArm(state: Pick<TabState, 'site' | 'callKey'>, now: number, fields: Pick<Arm, 'from' | 'name' | 'projectId' | 'people' | 'autoTodos' | 'off'>): Arm {
  return {
    from: fields.from,
    ...(fields.off ? { off: true as const } : {}),
    site: state.site,
    callKey: state.callKey,
    name: fields.name,
    ...(fields.projectId ? { projectId: fields.projectId } : {}),
    ...(fields.people ? { people: fields.people } : {}),
    autoTodos: fields.autoTodos,
    at: now,
    until: now + ARM_TIMING.maxMs,
    heardAt: now,
    tries: 0,
  };
}

/** What a page's `call` tells the arm. */
export interface Heard {
  stage: CallStage;
  hook: string;
  callKey: string | null;
}

export interface Arms {
  /** The tab's arm as stored, live or not. */
  read(tabId: number): Promise<Arm | null>;
  /** The tab's arm if it still holds at `now` (nothing is written). */
  live(tabId: number, now: number): Promise<Arm | null>;
  set(tabId: number, arm: Arm): Promise<void>;
  drop(tabId: number): Promise<void>;
  /** Every arm (Unpair, a 401); each tab repainted. */
  dropAll(): Promise<void>;
  /**
   * A page's `call` (inside tabs.serial, after the tab's record was written):
   * an arm that ended goes (rules 4 to 7), the away clock starts or stops,
   * and Always arms a join screen, waiting room or left call. The live arm,
   * or null.
   */
  onCall(tabId: number, state: TabState, heard: Heard, now: number): Promise<Arm | null>;
  /** Re-make the alarm for the earliest deadline (cleared when no arm is left). */
  schedule(): Promise<void>;
  /** Drop every arm that ended, each in its tab's turn; repaint; schedule. */
  sweep(): Promise<void>;
  /** chrome.alarms.onAlarm (ignores other alarms). */
  onAlarm(alarm: { name: string }): void;
  /** The browser started, or the extension was installed, updated or reloaded: session storage is empty, so no alarm. */
  restore(): void;
  /** Always start when I join a call. */
  always(): Promise<boolean>;
  /** The popup's switch: on arms every known tab on a join screen, waiting room or left call; off drops Always's arms. */
  setAlways(on: boolean): Promise<Done>;
  /** Always off, nothing else (Unpair). */
  stopAlways(): Promise<void>;
  /** The tab's badge, from its record and its live arm. */
  paint(tabId: number): Promise<void>;
}

export function createArms(ctx: Pick<Ctx, 'tabs' | 'now' | 'toTab'>): Arms {
  const writes = chains();
  let cached: boolean | undefined;

  const read = async (tabId: number): Promise<Arm | null> => {
    const got = await chrome.storage.session.get(keyOf(tabId));
    const v = got[keyOf(tabId)];
    return isArm(v) ? v : null;
  };

  /** Every stored arm with its tab, from one read. */
  const all = async (): Promise<[number, Arm][]> => {
    const stored = await chrome.storage.session.get(null);
    const out: [number, Arm][] = [];
    for (const [k, v] of Object.entries(stored)) {
      const tabId = Number(k.slice(PREFIX.length));
      if (k.startsWith(PREFIX) && Number.isInteger(tabId) && isArm(v)) out.push([tabId, v]);
    }
    return out;
  };

  const set = (tabId: number, arm: Arm) => writes(tabId, () => chrome.storage.session.set({ [keyOf(tabId)]: arm }));
  const drop = (tabId: number) => writes(tabId, () => chrome.storage.session.remove(keyOf(tabId)));

  async function schedule(): Promise<void> {
    try {
      let when = Infinity;
      for (const [, arm] of await all()) when = Math.min(when, deadline(arm));
      if (when === Infinity) await chrome.alarms.clear(ARM_ALARM);
      else await chrome.alarms.create(ARM_ALARM, { when: Math.max(when, ctx.now() + ARM_TIMING.alarmMinMs) });
    } catch {
      // Every read checks the deadlines itself: a missing alarm only delays the badge.
    }
  }

  /** An arm that ended: gone, and the page told when it still shows something but no join screen, waiting room or call. */
  async function end(tabId: number, arm: Arm, why: Liveness): Promise<void> {
    await drop(tabId);
    if (why === 'away' && arm.awayHow === 'screen' && !arm.off) await ctx.toTab(tabId, { t: 'capture', on: false, text: AUTO.lost });
  }

  async function always(): Promise<boolean> {
    if (cached !== undefined) return cached;
    try {
      cached = (await chrome.storage.local.get(ALWAYS_KEY))[ALWAYS_KEY] === true;
      return cached;
    } catch {
      return false;
    }
  }

  async function storeAlways(on: boolean): Promise<void> {
    await chrome.storage.local.set({ [ALWAYS_KEY]: on });
    cached = on;
  }

  /** Always's arm for a tab, and the page's bubble saying so (once per arm). */
  async function armAlways(tabId: number, state: TabState, now: number): Promise<Arm> {
    const arm = newArm(state, now, { from: 'always', name: '', autoTodos: false });
    await set(tabId, arm);
    await ctx.toTab(tabId, { t: 'capture', on: false, text: ALWAYS_ARMED });
    return arm;
  }

  /** Always arms a tab on a join screen, waiting room or left call, with no arm and no notes on (a reload mid-call resumes those). */
  const armable = (state: TabState): boolean => WAITING.has(state.stage ?? 'none') && !(state.clientId && state.notes);

  async function paintTab(tabId: number): Promise<void> {
    try {
      const now = ctx.now();
      const [state, arm] = await Promise.all([ctx.tabs.read(tabId), read(tabId)]);
      await paint(tabId, badgeOf(state, arm && liveness(arm, now) === 'live' ? arm : null, now));
    } catch {
      // Storage failing: the badge stays as it was.
    }
  }

  async function sweep(): Promise<void> {
    for (const [tabId] of await all()) {
      await ctx.tabs.serial(tabId, async () => {
        const arm = await read(tabId);
        if (!arm) return;
        const life = liveness(arm, ctx.now());
        if (life !== 'live') await end(tabId, arm, life);
      });
      await paintTab(tabId);
    }
    await schedule();
  }

  return {
    read,

    async live(tabId, now) {
      const arm = await read(tabId);
      return arm && liveness(arm, now) === 'live' ? arm : null;
    },

    set,
    drop,

    async dropAll() {
      for (const [tabId] of await all()) {
        await drop(tabId);
        await paintTab(tabId);
      }
      await schedule();
    },

    async onCall(tabId, state, heard, now) {
      let arm = await read(tabId);
      if (arm) {
        const life = liveness(arm, now);
        if (life !== 'live') {
          await end(tabId, arm, life);
          arm = null;
        } else if (arm.site !== state.site || (arm.callKey !== null && heard.callKey !== null && heard.callKey !== arm.callKey)) {
          // Another call in this tab.
          await drop(tabId);
          arm = null;
        } else {
          const next: Arm = { ...arm, heardAt: now };
          if (heard.stage === 'none') {
            next.awaySince ??= now;
            next.awayHow = heard.hook === 'page:hide' ? 'hide' : 'screen';
          } else {
            delete next.awaySince;
            delete next.awayHow;
          }
          await set(tabId, next);
          const moved = next.awaySince !== arm.awaySince;
          arm = next;
          if (moved) await schedule();
          return arm;
        }
        await schedule();
      }
      if (armable(state) && (await always())) {
        arm = await armAlways(tabId, state, now);
        await schedule();
      }
      return arm;
    },

    schedule,
    sweep,

    onAlarm(alarm) {
      if (alarm?.name !== ARM_ALARM) return;
      void sweep().catch(() => undefined);
    },

    restore() {
      void Promise.resolve()
        .then(() => chrome.alarms.clear(ARM_ALARM))
        .catch(() => undefined);
    },

    always,

    async setAlways(on) {
      try {
        await storeAlways(on);
        const now = ctx.now();
        const tabs = new Set([...(await ctx.tabs.ids()), ...(await all()).map(([id]) => id)]);
        for (const tabId of tabs) {
          await ctx.tabs.serial(tabId, async () => {
            const arm = await read(tabId);
            if (!on) {
              if (arm?.from === 'always') await drop(tabId);
              return;
            }
            const state = await ctx.tabs.read(tabId);
            // A record the page has not spoken to lately is a page that went: never armed.
            if (arm || !state || state.heardAt === undefined || now - state.heardAt >= ARM_TIMING.silentMs || !armable(state)) return;
            await armAlways(tabId, state, now);
          });
          await paintTab(tabId);
        }
        await schedule();
        return { ok: true };
      } catch {
        return { ok: false, error: TRY_AGAIN };
      }
    },

    stopAlways: () => storeAlways(false),

    paint: paintTab,
  };
}
