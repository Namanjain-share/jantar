/**
 * Caption lines from a page to the daemon (spec 3.9). Lines wait in the
 * page until the daemon has them, so the worker keeps none: one page
 * message becomes one POST (more when it is too big for one, see
 * LINES_POST_BYTES) and the answer tells the page what to do with what it
 * sent (LinesAnswer).
 *
 * - 2xx: `{ ok: true }`, the page drops what it sent.
 * - No answer, 5xx or 429: `retry: true`, the page tries again in 2 s.
 * - 404: the meeting is not open any more (ended, or deleted on the
 *   phone); the tab's meeting is cleared and notes stop with the sentence.
 *   Never a new meeting for lines: that would undo a delete.
 * - 403, 409 and the rest: notes stop with the daemon's sentence.
 * - 401: the key is forgotten; "Pair again".
 * - 400 or 413: the extension and the daemon disagree on the body.
 *
 * Only for a meeting whose notes are on: a meeting a screenshot made before
 * Start sends no lines (MP6).
 *
 * The keep-alive: while a tab is in a call its page repeats `call` every
 * minute, and a tab with a meeting turns that into one empty lines post at
 * most once per keepAliveMs. The daemon ends a meeting that heard nothing
 * for 10 minutes, which covers Chrome quitting, a crash and a navigation
 * away with one rule. Its 404 is as definite as a lines post's (the stale
 * sweep ended the meeting while the Mac slept, or it was deleted on the
 * phone), so the caller clears the meeting then.
 */
import type { LineUpsert } from '@jantar/protocol';
import type { LinesAnswer } from '../shared/messages.js';
import { TIMING } from '../shared/wire.js';
import type { Ctx } from './ctx.js';
import { MISMATCH, NOT_OPEN, PAIR_AGAIN } from './sentences.js';
import { withoutMeeting, type TabState } from './tabs.js';

/**
 * The most JSON one lines post carries, in UTF-8 bytes: under the daemon's
 * 64 KB body limit for the route (MAX_BODY_BYTES, pinned in
 * test/background/lines.test.ts), with room to spare. 200 lines of 4,000
 * characters are allowed in one message, so a catch-up after an outage can
 * be more than one post; one line is never near it.
 */
export const LINES_POST_BYTES = 48 * 1024;

const utf8 = new TextEncoder();

/** The lines in order, cut into posts of at most LINES_POST_BYTES; an empty list is one empty post. */
export function linePosts(lines: LineUpsert[]): LineUpsert[][] {
  const posts: LineUpsert[][] = [[]];
  // `{"lines":[]}` around them, and a comma between two.
  let bytes = 12;
  for (const line of lines) {
    const size = utf8.encode(JSON.stringify(line)).length + 1;
    const last = posts[posts.length - 1] as LineUpsert[];
    if (last.length > 0 && bytes + size > LINES_POST_BYTES) {
      posts.push([line]);
      bytes = 12 + size;
    } else {
      last.push(line);
      bytes += size;
    }
  }
  return posts;
}

/**
 * The page's upserts, each with only the five fields the daemon's strict
 * body takes. Nothing else is checked here: the daemon is the judge, and a
 * post it refuses (400) means the two disagree.
 */
export function pickLines(raw: readonly unknown[]): LineUpsert[] {
  return raw.map((v) => {
    const l = (v ?? {}) as Record<string, unknown>;
    return { lineId: l.lineId, rev: l.rev, speaker: l.speaker, text: l.text, at: l.at } as LineUpsert;
  });
}

export interface Lines {
  forward(tabId: number, lines: LineUpsert[]): Promise<LinesAnswer>;
  /** Wait for this tab's lines post in flight, at most `maxMs` (End waits for it before ending). */
  settle(tabId: number, maxMs: number): Promise<void>;
  /**
   * One empty lines post for the tab's meeting if the last one is a minute
   * old. Answers the daemon's sentence when it no longer has that meeting
   * (404), else null.
   */
  keepAlive(tabId: number, state: TabState): Promise<string | null>;
}

export function createLines(ctx: Ctx): Lines {
  const inflight = new Map<number, Promise<unknown>>();

  /** Every post for one page message, in order; the first that is not ok is the answer (upserts make a resend harmless). */
  async function postAll(tabId: number, clientId: string, lines: LineUpsert[]): Promise<LinesAnswer> {
    for (const part of linePosts(lines)) {
      const answer = await post(tabId, clientId, part);
      if (!answer.ok) return answer;
    }
    return { ok: true };
  }

  async function post(tabId: number, clientId: string, lines: LineUpsert[]): Promise<LinesAnswer> {
    const reply = await ctx.client.call('lines', { clientId, body: { lines } });
    switch (reply.kind) {
      case 'ok':
        return { ok: true };
      case 'down':
        return { ok: false, retry: true };
      case 'unpaired':
        return { ok: false, retry: false, text: PAIR_AGAIN };
      case 'error':
        if (reply.status >= 500 || reply.status === 429) return { ok: false, retry: true };
        // 413: a post over the body limit, which linePosts keeps under; the two disagree on it.
        if (reply.status === 400 || reply.status === 413) return { ok: false, retry: false, text: MISMATCH };
        if (reply.status === 404) {
          await ctx.tabs.patch(tabId, (cur) => (cur && cur.clientId === clientId ? withoutMeeting(cur) : cur));
          return { ok: false, retry: false, text: reply.sentence || NOT_OPEN };
        }
        // Meetings off, the line cap, notes not on for this meeting: notes stop here, the meeting stays.
        await ctx.tabs.patch(tabId, (cur) => (cur && cur.clientId === clientId ? { ...cur, notes: false } : cur));
        return { ok: false, retry: false, text: reply.sentence };
    }
  }

  return {
    async forward(tabId, lines) {
      const state = await ctx.tabs.read(tabId);
      // No meeting, or one made by a screenshot before Start: nothing is sent (MP6). No text: the page just stops.
      if (!state?.clientId || !state.notes) return { ok: false, retry: false };
      const run = postAll(tabId, state.clientId, lines);
      inflight.set(tabId, run);
      try {
        return await run;
      } finally {
        if (inflight.get(tabId) === run) inflight.delete(tabId);
      }
    },

    async settle(tabId, maxMs) {
      const deadline = ctx.now() + maxMs;
      for (let run = inflight.get(tabId); run; run = inflight.get(tabId)) {
        const left = deadline - ctx.now();
        if (left <= 0) return;
        const how = await Promise.race([run.then(() => 'done', () => 'done'), ctx.sleep(left).then(() => 'late')]);
        if (how === 'late') return;
        if (inflight.get(tabId) === run) inflight.delete(tabId);
      }
    },

    async keepAlive(tabId, state) {
      const clientId = state.clientId;
      if (!clientId) return null;
      const now = ctx.now();
      if (state.lastKeepAlive !== undefined && now - state.lastKeepAlive < TIMING.keepAliveMs) return null;
      await ctx.tabs.patch(tabId, (cur) => (cur && cur.clientId === clientId ? { ...cur, lastKeepAlive: now } : cur));
      const reply = await ctx.client.call('lines', { clientId, body: { lines: [] } });
      if (reply.kind === 'error' && reply.status === 404) return reply.sentence || NOT_OPEN;
      // Other errors are ignored: the next lines post says what happened, and a 401 is handled in the client.
      return null;
    },
  };
}
