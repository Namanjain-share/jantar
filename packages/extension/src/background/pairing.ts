/**
 * Pairing (spec 3.10): the popup passes the pasted line
 * `jantar-ext:<port>:<code>`; the worker claims the code on that port and
 * keeps `{ port, key }` in its own IndexedDB (never in chrome.storage:
 * MP9). The daemon accepts the claim only from this extension's ID, so a
 * page or another extension that read the line from the clipboard cannot
 * use it.
 *
 * Unpair forgets the key here (the daemon side is `jantar meetings
 * unpair`), after ending each tab's meeting as End does (reason `user`)
 * while the key still works, so its summary comes now. After a pair, an
 * unpair or a 401 every tab the worker knows hears `button`; on the way
 * out, notes stop and the tabs' meetings are forgotten (after a 401, or an
 * end Jantar did not take, the daemon ends them 10 minutes later; a new
 * pairing is a new extension to it, so they could not be continued anyway).
 */
import type { Done } from '../shared/messages.js';
import { PAIR_LINE } from '../shared/wire.js';
import type { Ctx } from './ctx.js';
import type { Meetings } from './meetings.js';
import { BAD_CODE, NOT_RUNNING } from './sentences.js';
import { KEY_SHAPE } from './store.js';
import { withoutMeeting } from './tabs.js';

/** The pasted line's port and code, or null when it is not a pairing line. */
export function parsePairLine(text: unknown): { port: number; code: string } | null {
  if (typeof text !== 'string') return null;
  const m = PAIR_LINE.exec(text.trim());
  if (!m?.[1] || !m[2]) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { port, code: m[2] };
}

export interface PairingFlow {
  pair(text: unknown): Promise<Done>;
  unpair(): Promise<Done>;
  /** Jantar answered 401: the client already dropped the key. `sentence`: the bubble on tabs whose notes stop. */
  forgotten(sentence: string): Promise<void>;
}

export function createPairing(ctx: Ctx, meetings: Pick<Meetings, 'end'>): PairingFlow {
  /** Tell every known tab whether the button shows; on the way out, stop notes and forget the meetings. */
  async function broadcast(on: boolean, stopText?: string): Promise<void> {
    for (const tabId of await ctx.tabs.ids()) {
      if (!on) {
        let hadNotes = false;
        await ctx.tabs.patch(tabId, (cur) => {
          if (!cur) return cur;
          hadNotes = cur.notes && cur.clientId !== undefined;
          return withoutMeeting(cur);
        });
        if (hadNotes) await ctx.toTab(tabId, stopText ? { t: 'capture', on: false, text: stopText } : { t: 'capture', on: false });
      }
      await ctx.toTab(tabId, { t: 'button', on });
    }
  }

  return {
    async pair(text) {
      const line = parsePairLine(text);
      if (!line) return { ok: false, error: BAD_CODE };
      const reply = await ctx.client.claim(line.port, line.code);
      if (reply.kind === 'down') return { ok: false, error: NOT_RUNNING };
      if (reply.kind !== 'ok') {
        // 403: a wrong, used or expired code (the daemon's words name no more than that); 429: too many tries.
        if (reply.kind === 'error' && reply.status === 429) return { ok: false, error: reply.sentence };
        return { ok: false, error: BAD_CODE };
      }
      const key = reply.body?.key;
      if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return { ok: false, error: BAD_CODE };
      await ctx.keys.set({ port: line.port, key, pairedAt: new Date(ctx.now()).toISOString() });
      await broadcast(true);
      return { ok: true };
    },

    async unpair() {
      // Whatever an end answers, the unpair goes on.
      await Promise.all((await ctx.tabs.ids()).map((tabId) => meetings.end(tabId).catch(() => undefined)));
      await ctx.keys.clear();
      await broadcast(false);
      return { ok: true };
    },

    forgotten(sentence) {
      return broadcast(false, sentence);
    },
  };
}
