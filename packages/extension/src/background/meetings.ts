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
 */
import type { CallAnswer, Done, FromPage, FromPopup } from '../shared/messages.js';
import type { MeetingSite } from '../shared/sites.js';
import { WIRE_LIMITS } from '../shared/wire.js';
import type { Reply } from './client.js';
import { cleanText, type Ctx } from './ctx.js';
import type { Lines } from './lines.js';
import { JOIN_FIRST, MISMATCH, NOT_OPEN, NOT_RUNNING, NO_MEETING_TAB, PAIR_AGAIN } from './sentences.js';
import { withoutMeeting, type TabState } from './tabs.js';

/** How long End waits for the page's lines post in flight. */
export const END_WAIT_MS = 2_000;
/** A Jantar Life id (a ulid); anything else is dropped from the sheet. */
const LIFE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type CallMsg = Extract<FromPage, { t: 'call' }>;
export type StartMsg = Extract<FromPopup, { t: 'start' }>;
export type EndReason = 'user' | 'left' | 'closed';

export type Opened = { ok: true; clientId: string } | { ok: false; reply: Reply };

/** The Name the popup prefills: the page's title, else "Meet call" or "Teams call". */
export function defaultName(s: Pick<TabState, 'site' | 'title'>): string {
  return cleanText(s.title, WIRE_LIMITS.name) || (s.site === 'meet' ? 'Meet call' : 'Teams call');
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
  captions(tabId: number, state: TabState['captions']): Promise<void>;
  start(msg: StartMsg): Promise<Done>;
  end(tabId: number): Promise<Done>;
  removed(tabId: number): Promise<void>;
  /** Open (or update) the tab's meeting; inside tabs.serial. */
  open(tabId: number, state: TabState, fields: { name: string; projectId?: string; people?: string; autoTodos: boolean; captions: boolean }): Promise<Opened>;
  /** The daemon no longer has this meeting (404): clear it, and stop notes with the sentence if they were on. */
  lost(tabId: number, clientId: string, sentence: string): Promise<void>;
}

const freshTab = (site: MeetingSite): TabState => ({ site, inCall: false, callKey: null, title: '', notes: false, shots: 0, captions: 'unknown' });

export function createMeetings(ctx: Ctx, lines: Lines): Meetings {
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

  return {
    open,
    lost,

    async call(tabId, msg, site) {
      let state = await ctx.tabs.serial(tabId, async () => {
        const prev = await ctx.tabs.read(tabId);
        if (prev?.clientId && (msg.left === true || prev.callKey !== msg.callKey)) await finish(tabId, prev, prev.clientId, 'left');
        const title = cleanText(msg.title, 300);
        return ctx.tabs.patch(tabId, (cur) => ({ ...(cur ?? freshTab(site)), site, inCall: msg.inCall && msg.left !== true, callKey: msg.callKey, title }));
      });
      if (state?.inCall && state.clientId) {
        const gone = await lines.keepAlive(tabId, state);
        if (gone !== null) {
          await lost(tabId, state.clientId, gone);
          state = await ctx.tabs.read(tabId);
        }
      }
      const paired = (await ctx.keys.get()) !== null;
      return { button: paired, notes: Boolean(state?.clientId && state.notes) };
    },

    async captions(tabId, captions) {
      await ctx.tabs.patch(tabId, (cur) => (cur ? { ...cur, captions } : cur));
    },

    start(msg) {
      return ctx.tabs.serial(msg.tabId, async () => {
        const state = await ctx.tabs.read(msg.tabId);
        if (!state) return { ok: false, error: NO_MEETING_TAB };
        if (!state.inCall) return { ok: false, error: JOIN_FIRST };
        const projectId = typeof msg.projectId === 'string' && LIFE_ID.test(msg.projectId) ? msg.projectId : undefined;
        const people = cleanText(msg.people, WIRE_LIMITS.people);
        const opened = await open(msg.tabId, state, {
          name: cleanText(msg.name, WIRE_LIMITS.name) || defaultName(state),
          ...(projectId ? { projectId } : {}),
          ...(people ? { people } : {}),
          // Action items go to todos only with a project to put them in.
          autoTodos: projectId !== undefined && msg.autoTodos === true,
          captions: true,
        });
        if (!opened.ok) return { ok: false, error: doneError(opened.reply) };
        await ctx.toTab(msg.tabId, { t: 'capture', on: true });
        return { ok: true };
      });
    },

    end(tabId) {
      return ctx.tabs.serial(tabId, async () => {
        const state = await ctx.tabs.read(tabId);
        if (!state?.clientId) return { ok: true };
        const reply = await finish(tabId, state, state.clientId, 'user');
        // A 404: the daemon had already ended it (or it was deleted); either way it is over.
        if (reply.kind === 'ok' || (reply.kind === 'error' && reply.status === 404)) return { ok: true };
        return { ok: false, error: doneError(reply) };
      });
    },

    removed(tabId) {
      return ctx.tabs.serial(tabId, async () => {
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
