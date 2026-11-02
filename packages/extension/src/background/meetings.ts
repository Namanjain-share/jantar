/**
 * One meeting per tab and call (spec 3.9). A meeting is "this tab's call":
 * a client id (a uuid made here) per tab and call, made at the first Start
 * or screenshot; the capture routes are keyed by it, and every write is an
 * idempotent upsert.
 *
 * - Start: open with `captions: true` and the sheet's fields (the same
 *   client id when a screenshot already made the meeting), then
 *   `capture {on: true}`. A 409 on open (that client id's meeting has
 *   ended) gets a new client id and one more open.
 * - End: `capture {on: false}`, wait up to 2 s for the page's lines in
 *   flight, end with reason `user`, clear the client id.
 * - A `call` with `left` (sent only after the page's 60-s grace) or with a
 *   Meet code other than the stored one ends the meeting with `left`; the
 *   new code is kept with no meeting. Any other `call` (a page load, the
 *   waiting room, a title change, the keep-alive) never ends one.
 * - tabs.onRemoved ends it with `closed`.
 * - A 404 on a lines post, the keep-alive or a screenshot: the daemon no
 *   longer has the meeting (the stale sweep ended it, or it was deleted on
 *   the phone). The tab's meeting is cleared and notes stop with the
 *   daemon's sentence; only a screenshot opens a new one then (lines never
 *   do: that would undo a delete).
 *
 * Ends are tried once. When Jantar is down, or the worker never hears of
 * the end (Chrome quit, a crash, a navigation away), the daemon ends the
 * meeting 10 minutes after its last line or keep-alive.
 *
 * v0.9.1, Start when I join (arms.ts): a `call` saying the page has been in
 * the call for two polls (stage `in`) starts notes in an armed tab through
 * the same startNow as Start, with the same open body, then the page says
 * "Jantar started notes". Never before: nothing of an armed call reaches
 * Jantar until then (arming makes no daemon call). When it cannot start the
 * page and the popup say why; "Jantar is not running" is tried again on the
 * page's next keep-alives (ARM_TIMING.retries). With Always on, End leaves
 * an `off` arm so a rejoin of that call in that tab does not start again.
 *
 * v0.9.1, captions on when notes start: with Settings › Turn on captions when
 * notes start on (chrome.storage.local `autoCaptions`, on unless set off),
 * every `capture {on: true}` and every call answer with notes on carries
 * `cc`, and the page switches the call's captions on. The page's captions
 * state (with its client) and how switching went (`cc`) are kept per tab.
 */
import type { CallAnswer, CallStage, CaptionsClient, CaptionsWhy, CcReport, Done, FromPage, FromPopup, ToPage } from '../shared/messages.js';
import type { MeetingSite } from '../shared/sites.js';
import { ARM_TIMING, WIRE_LIMITS } from '../shared/wire.js';
import { WAITING, newArm, type Arm, type Arms } from './arms.js';
import type { Reply } from './client.js';
import { cleanText, type Ctx } from './ctx.js';
import type { Lines } from './lines.js';
import { AUTO, JOIN_FIRST, JOIN_SCREEN_FIRST, MISMATCH, NOT_OPEN, NOT_RUNNING, NO_MEETING_TAB, OTHER_TAB, PAIR_AGAIN, PAIR_FIRST, TRY_AGAIN } from './sentences.js';
import { withoutMeeting, type TabState } from './tabs.js';

/** v0.9.1: Settings › Turn on captions when notes start, in chrome.storage.local (no secret); on unless set off. */
export const CC_KEY = 'autoCaptions';

export async function autoCaptions(): Promise<boolean> {
  try {
    return (await chrome.storage.local.get(CC_KEY))[CC_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setAutoCaptions(on: boolean): Promise<Done> {
  try {
    await chrome.storage.local.set({ [CC_KEY]: on });
    return { ok: true };
  } catch {
    return { ok: false, error: TRY_AGAIN };
  }
}

/** v0.9.1: notes on in the page (`text`: the bubble after a start by itself), switching captions on when the setting says so. */
async function captureOn(text?: string): Promise<ToPage> {
  return { t: 'capture', on: true, ...(text ? { text } : {}), ...((await autoCaptions()) ? { cc: true as const } : {}) };
}

/** How long End waits for the page's lines post in flight. */
export const END_WAIT_MS = 2_000;
/** A Jantar Life id (a ulid); anything else is dropped from the sheet. */
const LIFE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type CallMsg = Extract<FromPage, { t: 'call' }>;
export type StartMsg = Extract<FromPopup, { t: 'start' }>;
export type ArmMsg = Extract<FromPopup, { t: 'arm' }>;
export type EndReason = 'user' | 'left' | 'closed';

export type Opened = { ok: true; clientId: string } | { ok: false; reply: Reply };

/** The sheet's fields as Start keeps them. `name` '' is the page's title when notes start. */
export interface StartFields {
  name: string;
  projectId?: string;
  people?: string;
  autoTodos: boolean;
}

/** The Name the popup prefills: the page's title, else "Meet call" or "Teams call". */
export function defaultName(s: Pick<TabState, 'site' | 'title'>): string {
  return cleanText(s.title, WIRE_LIMITS.name) || (s.site === 'meet' ? 'Meet call' : 'Teams call');
}

/**
 * v0.9.1: what a `call` says the page shows. The page names its stage (with
 * `left` too: a waiting room's one-poll flicker that ran out its grace is
 * still the waiting room); a message without one reads as v0.9's.
 */
export function stageOf(msg: CallMsg): CallStage {
  if (msg.stage !== undefined) return msg.stage;
  if (msg.left === true) return 'left';
  return msg.inCall ? 'in' : 'none';
}

/** The sheet's fields cleaned: a ulid project or none, the name and people cleaned, action items to todos only with a project. */
export function cleanFields(f: { name?: unknown; projectId?: unknown; people?: unknown; autoTodos?: unknown }): StartFields {
  const projectId = typeof f.projectId === 'string' && LIFE_ID.test(f.projectId) ? f.projectId : undefined;
  const people = cleanText(f.people, WIRE_LIMITS.people);
  return {
    name: cleanText(f.name, WIRE_LIMITS.name),
    ...(projectId ? { projectId } : {}),
    ...(people ? { people } : {}),
    // Action items go to todos only with a project to put them in.
    autoTodos: projectId !== undefined && f.autoTodos === true,
  };
}

/** A Done's error for a reply that was not 2xx. */
export function doneError(reply: Reply): string {
  switch (reply.kind) {
    case 'ok':
      return '';
    case 'down':
      return NOT_RUNNING;
    case 'unpaired':
      return PAIR_AGAIN;
    case 'error':
      return reply.status === 400 ? MISMATCH : reply.sentence;
  }
}

export interface Meetings {
  call(tabId: number, msg: CallMsg, site: MeetingSite): Promise<CallAnswer>;
  captions(tabId: number, state: TabState['captions'], client?: CaptionsClient, why?: CaptionsWhy): Promise<void>;
  /** v0.9.1: how switching the captions on went. */
  cc(tabId: number, report: CcReport): Promise<void>;
  start(msg: StartMsg): Promise<Done>;
  /** v0.9.1: Start when I join (starts now when the tab is already in the call). */
  arm(msg: ArmMsg): Promise<Done>;
  /** v0.9.1: Cancel; with Always on, Not this call (an `off` arm). */
  disarm(tabId: number): Promise<Done>;
  end(tabId: number): Promise<Done>;
  removed(tabId: number): Promise<void>;
  /** Open (or update) the tab's meeting; inside tabs.serial. */
  open(tabId: number, state: TabState, fields: { name: string; projectId?: string; people?: string; autoTodos: boolean; captions: boolean }): Promise<Opened>;
  /** The daemon no longer has this meeting (404): clear it, and stop notes with the sentence if they were on. */
  lost(tabId: number, clientId: string, sentence: string): Promise<void>;
}

const freshTab = (site: MeetingSite): TabState => ({ site, inCall: false, callKey: null, title: '', notes: false, shots: 0, captions: 'unknown' });

export function createMeetings(ctx: Ctx, lines: Lines, arms: Arms): Meetings {
  /** End the tab's meeting: stop notes, let the last lines land, tell the daemon, clear the client id. */
  async function finish(tabId: number, prev: TabState, clientId: string, reason: EndReason): Promise<Reply> {
    if (prev.notes) await ctx.toTab(tabId, { t: 'capture', on: false });
    await lines.settle(tabId, END_WAIT_MS);
    const reply = await ctx.client.call('end', { clientId, body: { reason, at: ctx.now() } });
    await ctx.tabs.patch(tabId, (cur) => (cur && cur.clientId === clientId ? withoutMeeting(cur) : cur));
    return reply;
  }

  async function lost(tabId: number, clientId: string, sentence: string): Promise<void> {
    let hadNotes = false;
    await ctx.tabs.patch(tabId, (cur) => {
      if (!cur || cur.clientId !== clientId) return cur;
      hadNotes = cur.notes;
      return withoutMeeting(cur);
    });
    if (hadNotes) await ctx.toTab(tabId, { t: 'capture', on: false, text: sentence });
  }

  async function open(
    tabId: number,
    state: TabState,
    fields: { name: string; projectId?: string; people?: string; autoTodos: boolean; captions: boolean },
  ): Promise<Opened> {
    const body = {
      site: state.site,
      name: fields.name,
      ...(fields.projectId ? { projectId: fields.projectId } : {}),
      ...(fields.people ? { people: fields.people } : {}),
      autoTodos: fields.autoTodos,
      captions: fields.captions,
      at: ctx.now(),
    };
    let clientId = state.clientId ?? ctx.uuid();
    let reply = await ctx.client.call('open', { clientId, body });
    if (reply.kind === 'error' && reply.status === 409 && state.clientId) {
      // That client id's meeting has ended (the stale sweep, or ended elsewhere): this call gets a new one.
      clientId = ctx.uuid();
      reply = await ctx.client.call('open', { clientId, body });
    }
    if (reply.kind !== 'ok') return { ok: false, reply };
    const same = clientId === state.clientId;
    const now = ctx.now();
    const next = await ctx.tabs.patch(tabId, (cur) => {
      if (!cur) return null;
      const base = same && cur.clientId === clientId ? cur : withoutMeeting(cur);
      return {
        ...base,
        clientId,
        name: fields.name,
        notes: base.notes || fields.captions,
        lastKeepAlive: now,
        ...(fields.captions ? { captions: 'unknown' as const } : {}),
      };
    });
    if (!next) {
      // The tab's record went meanwhile (never expected inside tabs.serial): leave nothing open behind it.
      await ctx.client.call('end', { clientId, body: { reason: 'closed', at: now } });
      return { ok: false, reply: { kind: 'error', status: 404, sentence: NOT_OPEN } };
    }
    return { ok: true, clientId };
  }

  /**
   * The one way notes start: the popup's Start and Start when I join both
   * come here, inside tabs.serial(tabId). `bubble`: what the page says once
   * notes are on.
   */
  async function startNow(tabId: number, fields: StartFields, bubble?: string): Promise<Done> {
    const state = await ctx.tabs.read(tabId);
    if (!state) return { ok: false, error: NO_MEETING_TAB };
    if (!state.inCall) return { ok: false, error: JOIN_FIRST };
    const f = cleanFields(fields);
    const opened = await open(tabId, state, {
      name: f.name || defaultName(state),
      ...(f.projectId ? { projectId: f.projectId } : {}),
      ...(f.people ? { people: f.people } : {}),
      autoTodos: f.autoTodos,
      captions: true,
    });
    if (!opened.ok) return { ok: false, error: doneError(opened.reply) };
    await ctx.toTab(tabId, await captureOn(bubble));
    return { ok: true };
  }

  /** Another tab keeps notes for this Meet call. */
  async function notesElsewhere(tabId: number, callKey: string): Promise<boolean> {
    for (const id of await ctx.tabs.ids()) {
      if (id === tabId) continue;
      const s = await ctx.tabs.read(id);
      if (s?.site === 'meet' && s.callKey === callKey && s.clientId && s.notes) return true;
    }
    return false;
  }

  /**
   * v0.9.1: the armed tab is in the call (spec 5.2; inside tabs.serial):
   * notes start exactly as Start starts them, else the page and the popup
   * say why. Answers the tab's record as it is now.
   */
  async function autoStart(tabId: number, state: TabState, arm: Arm, now: number): Promise<TabState | null> {
    const record = (auto: TabState['auto']) => ctx.tabs.patch(tabId, (cur) => (cur ? { ...cur, auto } : cur));
    let why: string;
    if (arm.from === 'always' && state.site === 'meet' && state.callKey !== null && (await notesElsewhere(tabId, state.callKey))) why = OTHER_TAB;
    else if (!(await ctx.keys.get())) why = PAIR_FIRST;
    else {
      const fields = { name: arm.name, ...(arm.projectId ? { projectId: arm.projectId } : {}), ...(arm.people ? { people: arm.people } : {}), autoTodos: arm.autoTodos };
      const done = await startNow(tabId, fields, AUTO.started);
      if (done.ok) {
        await arms.drop(tabId);
        await arms.schedule();
        return record({ at: now, ok: true });
      }
      why = done.error ?? TRY_AGAIN;
      if (why === NOT_RUNNING && arm.tries < ARM_TIMING.retries) {
        // Jantar restarts in seconds: the page's next keep-alive tries again.
        await arms.set(tabId, { ...arm, tries: arm.tries + 1 });
        if (arm.tries === 0) await ctx.toTab(tabId, { t: 'capture', on: false, text: AUTO.retrying });
        return record({ at: now, ok: false, text: why });
      }
    }
    await arms.drop(tabId);
    await arms.schedule();
    await ctx.toTab(tabId, { t: 'capture', on: false, text: AUTO.notStarted(why) });
    return record({ at: now, ok: false, text: why });
  }

  return {
    open,
    lost,

    async call(tabId, msg, site) {
      const stage = stageOf(msg);
      let state = await ctx.tabs.serial(tabId, async () => {
        // Read in this tab's turn: a Start or End before it may have taken a while.
        const now = ctx.now();
        const prev = await ctx.tabs.read(tabId);
        if (prev?.clientId && (msg.left === true || prev.callKey !== msg.callKey)) await finish(tabId, prev, prev.clientId, 'left');
        const title = cleanText(msg.title, 300);
        const next = await ctx.tabs.patch(tabId, (cur) => ({
          ...(cur ?? freshTab(site)),
          site,
          inCall: msg.inCall && msg.left !== true,
          callKey: msg.callKey,
          title,
          stage,
          hook: msg.hook ?? '',
          heardAt: now,
          // v0.9.1: the page is going away (a reload): its captions state goes with it, until the next page says.
          ...(msg.hook === 'page:hide' ? { captions: 'unknown' as const } : {}),
        }));
        if (!next) return next;
        const arm = await arms.onCall(tabId, next, { stage, hook: msg.hook ?? '', callKey: msg.callKey, was: prev?.stage ?? 'none' }, now);
        if (!arm) return next;
        if (next.clientId && next.notes) {
          // Used: notes are on (a Start that won the race; or a start whose `capture` a worker restart lost, sent again).
          if (next.inCall && !arm.off) await ctx.toTab(tabId, await captureOn());
          await arms.drop(tabId);
          await arms.schedule();
          return next;
        }
        // Admitted: the page has been in the call for two polls. Never on inCall alone.
        if (!arm.off && next.inCall && msg.stage === 'in') return autoStart(tabId, next, arm, now);
        return next;
      });
      if (state?.inCall && state.clientId) {
        const gone = await lines.keepAlive(tabId, state);
        if (gone !== null) {
          await lost(tabId, state.clientId, gone);
          state = await ctx.tabs.read(tabId);
        }
      }
      const paired = (await ctx.keys.get()) !== null;
      const notes = Boolean(state?.clientId && state.notes);
      // v0.9.1: a page that resumes notes after a reload switches captions on too.
      return { button: paired, notes, ...(notes && (await autoCaptions()) ? { cc: true as const } : {}) };
    },

    async captions(tabId, captions, client, why) {
      await ctx.tabs.patch(tabId, (cur) => {
        if (!cur) return cur;
        const { why: _was, ...rest } = cur;
        return { ...rest, captions, ...(client ? { client } : {}), ...(why ? { why } : {}) };
      });
    },

    async cc(tabId, report) {
      await ctx.tabs.patch(tabId, (cur) => (cur?.clientId && cur.notes ? { ...cur, cc: report } : cur));
    },

    start(msg) {
      return ctx.tabs.serial(msg.tabId, () => startNow(msg.tabId, msg));
    },

    arm(msg) {
      return ctx.tabs.serial(msg.tabId, async () => {
        const state = await ctx.tabs.read(msg.tabId);
        if (!state) return { ok: false, error: NO_MEETING_TAB };
        if (!(await ctx.keys.get())) return { ok: false, error: PAIR_AGAIN };
        const fields = cleanFields(msg);
        const stage = state.stage ?? (state.inCall ? 'in' : 'none');
        // Let in while the popup was open: start now, as Start.
        if (stage === 'in') return startNow(msg.tabId, fields);
        if (!WAITING.has(stage)) return { ok: false, error: JOIN_SCREEN_FIRST };
        // Notes are on already (a reload into the join screen): they go on once you are back in the call.
        if (state.clientId && state.notes) return { ok: true };
        await arms.set(msg.tabId, newArm(state, ctx.now(), { from: 'popup', ...fields }));
        await arms.schedule();
        return { ok: true };
      });
    },

    disarm(tabId) {
      return ctx.tabs.serial(tabId, async () => {
        const arm = await arms.read(tabId);
        if (!arm) return { ok: true };
        // With Always on an arm left behind would come back at once: it stays, off, for this call.
        if (await arms.always()) await arms.set(tabId, { ...arm, from: 'always', off: true });
        else await arms.drop(tabId);
        await arms.schedule();
        return { ok: true };
      });
    },

    end(tabId) {
      return ctx.tabs.serial(tabId, async () => {
        const state = await ctx.tabs.read(tabId);
        if (!state?.clientId) return { ok: true };
        const reply = await finish(tabId, state, state.clientId, 'user');
        if (await arms.always()) {
          // v0.9.1: a rejoin of this call in this tab does not start notes again.
          await arms.set(tabId, newArm(state, ctx.now(), { from: 'always', off: true, name: '', autoTodos: false }));
          await arms.schedule();
        }
        // A 404: the daemon had already ended it (or it was deleted); either way it is over.
        if (reply.kind === 'ok' || (reply.kind === 'error' && reply.status === 404)) return { ok: true };
        return { ok: false, error: doneError(reply) };
      });
    },

    removed(tabId) {
      return ctx.tabs.serial(tabId, async () => {
        if (await arms.read(tabId)) {
          await arms.drop(tabId);
          await arms.schedule();
        }
        const prev = await ctx.tabs.read(tabId);
        if (!prev) return;
        await ctx.tabs.drop(tabId);
        if (!prev.clientId) return;
        await lines.settle(tabId, END_WAIT_MS);
        await ctx.client.call('end', { clientId: prev.clientId, body: { reason: 'closed', at: ctx.now() } });
      });
    },
  };
}
