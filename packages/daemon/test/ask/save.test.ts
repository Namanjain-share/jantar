/**
 * v0.8: Ask's save card, the typed fast path only (spec 9). Synthetic links
 * on example.com and the platforms' shapes; a stand-in Intel records reads
 * and removes.
 *
 * - While reading links is on, "save this: <link>" or a message that is
 *   just one link is answered at once with one save card and "Save this to
 *   Intel?": no Claude run. Anything else, and everything while reading is
 *   off, goes to Claude as in 0.7.
 * - Claude never proposes a save: a `save` in its answer is dropped and
 *   counted like an unknown type.
 * - Add calls Intel's read (via ask) and the card's ref is the item; Undo
 *   calls Intel's remove; an item that was already on the shelf is never
 *   removed by Undo. Edits change the depth only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AskTurnSchema, INTEL_READ_REASONS, type IntelReadBody, type IntelReadReply } from '@jantar/protocol';
import type { IntelService, IntelVia, LifeResult } from '../../src/contracts.js';
import { ASK_SENTENCES, readAction, saveFastPath } from '../../src/ask/answer.js';
import { PHONE, TABLET, TODAY, answerText, cleanTemps, makeAskRig, send, type AskRig } from './helpers.js';

let rig: AskRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  cleanTemps();
});

const READING = { intel: { enabled: true, read: true } };
const REEL = 'https://www.instagram.com/reel/AbC123xyz/';
const ITEM = 'captures:01JFZ8X8Y3T0V5G9WQK2M4N6PR';

function fakeIntel() {
  const reads: { body: IntelReadBody; from: { via: IntelVia; keyId?: string } }[] = [];
  const removes: string[] = [];
  let next: LifeResult<IntelReadReply> = { ok: true, value: { id: ITEM, duplicate: false, queued: true, message: 'Saved. Reading it on your Mac.' } };
  let removed: LifeResult = { ok: true, value: true };
  const intel: Pick<IntelService, 'read' | 'remove'> = {
    read: async (body, from) => {
      reads.push({ body, from });
      return next;
    },
    remove: async (id) => {
      removes.push(id);
      return removed;
    },
  };
  return {
    intel,
    reads,
    removes,
    answer(r: LifeResult<IntelReadReply>) {
      next = r;
    },
    onRemove(r: LifeResult) {
      removed = r;
    },
  };
}

describe('saveFastPath: the shapes it takes, and nothing else', () => {
  it('a bare link, "save this:", keep, add, "to intel", a dash, a depth word, any case', () => {
    expect(saveFastPath(REEL)).toEqual({ type: 'save', url: REEL });
    expect(saveFastPath(`save this: ${REEL}`)).toEqual({ type: 'save', url: REEL });
    expect(saveFastPath(`Save it to Intel - ${REEL} FULL`)).toEqual({ type: 'save', url: REEL, depth: 'full' });
    expect(saveFastPath(`keep ${REEL} light`)).toEqual({ type: 'save', url: REEL, depth: 'light' });
    expect(saveFastPath(`ADD THIS TO INTEL:${REEL}`)).toEqual({ type: 'save', url: REEL });
    expect(saveFastPath(`  https://example.com/a/b?x=1.  `)).toEqual({ type: 'save', url: 'https://example.com/a/b?x=1' });
    expect(saveFastPath('http://example.com/post)')).toEqual({ type: 'save', url: 'http://example.com/post' });
  });

  it('anything more is a message for Claude: other words, two links, a note, another scheme', () => {
    for (const text of [
      `what is this ${REEL}`,
      `save this: ${REEL} and remind me tomorrow`,
      `${REEL} ${REEL}`,
      `save this ${REEL} deep`,
      'save this: ftp://example.com/a',
      'save this: javascript:alert(1)',
      'save this',
      'remind me to call Sam at 5',
      `please save ${REEL}`,
    ]) {
      expect(saveFastPath(text), text).toBeNull();
    }
  });

  it('a link longer than 2,000 characters is not a save card', () => {
    expect(saveFastPath(`https://example.com/${'a'.repeat(2000)}`)).toBeNull();
  });

  it('stays fast on hostile input (no backtracking blow-up)', () => {
    const started = Date.now();
    for (const text of [`save${' '.repeat(900)}x`, `https://${'a'.repeat(990)} ${' '.repeat(5)}x`, `save this${':'.repeat(500)}${' '.repeat(400)}`]) saveFastPath(text);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('Claude never proposes a save', () => {
  it('readAction has no save case: a save in an answer is dropped', async () => {
    const scope = { today: TODAY, now: '14:05', modules: { todos: true, food: true, finance: true, medicines: true, posts: true }, projects: [], remind: false };
    expect(readAction({ type: 'save', url: REEL }, scope)).toBeNull();
    rig = await makeAskRig({ settings: READING, intel: fakeIntel().intel });
    const id = send(rig, 'what should I cook tonight?');
    await rig.heldCount(1);
    rig.held[0]?.answer(answerText([{ type: 'save', url: REEL }, { type: 'food', name: 'Dal', kcal: 180 }]));
    const turn = await rig.settled(id);
    expect(turn.cards.map((c) => c.action.type)).toEqual(['food']);
    expect(turn.dropped).toBe(1);
  });
});

describe('the fast path in send', () => {
  it('reading on: one save card at once, no Claude run, the fixed reply; the turn parses as the phone reads it', async () => {
    const f = fakeIntel();
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, `save this: ${REEL} full`);
    const turn = rig.turn(id);
    expect(turn).toMatchObject({ state: 'done', reply: ASK_SENTENCES.saveAsk, cards: [{ action: { type: 'save', url: REEL, depth: 'full' }, state: 'proposed' }], dropped: 0 });
    expect(AskTurnSchema.safeParse(turn).success).toBe(true);
    expect(rig.held).toHaveLength(0);
    expect(f.reads).toHaveLength(0);
    // Not busy: the next message goes straight on.
    expect(rig.ask.send('another one', PHONE).ok).toBe(true);
  });

  it('reading off, or the shelf off: the same message goes to Claude', async () => {
    for (const settings of [{ intel: { enabled: true, read: false } }, { intel: { enabled: false, read: true } }, {}]) {
      await rig?.close();
      rig = await makeAskRig({ settings, intel: fakeIntel().intel });
      const id = send(rig, REEL);
      expect(rig.turn(id)?.state, JSON.stringify(settings)).toBe('queued');
      await rig.heldCount(1);
    }
  });
});

describe('Add and Undo of a save card', () => {
  it('Add saves through Intel (via ask) and keeps the item as the ref; Undo removes it', async () => {
    const f = fakeIntel();
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, `save this: ${REEL}`);
    const added = await rig.ask.add(id, 0, undefined, PHONE);
    expect(added).toEqual({ ok: true, value: { id: ITEM } });
    expect(f.reads).toEqual([{ body: { text: REEL }, from: { via: 'ask' } }]);
    expect(rig.turn(id)?.cards[0]).toEqual({ action: { type: 'save', url: REEL }, state: 'added', ref: ITEM });
    expect(AskTurnSchema.safeParse(rig.turn(id)).success).toBe(true);
    // A second tap does not save again.
    expect((await rig.ask.add(id, 0, undefined, PHONE)).ok).toBe(false);
    expect(f.reads).toHaveLength(1);
    expect(await rig.ask.undo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    expect(f.removes).toEqual([ITEM]);
    expect(rig.turn(id)?.cards[0]).toEqual({ action: { type: 'save', url: REEL }, state: 'proposed' });
  });

  it('an edit may change the depth, never the link', async () => {
    const f = fakeIntel();
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, REEL);
    const other = await rig.ask.add(id, 0, { type: 'save', url: 'https://example.com/elsewhere' }, PHONE);
    expect(other).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.editLink });
    expect(f.reads).toHaveLength(0);
    expect((await rig.ask.add(id, 0, { type: 'save', url: REEL, depth: 'light' }, PHONE)).ok).toBe(true);
    expect(f.reads[0]?.body).toEqual({ text: REEL, depth: 'light' });
    expect(rig.turn(id)?.cards[0]?.action).toEqual({ type: 'save', url: REEL, depth: 'light' });
  });

  it('a link already on the shelf: Add points at it, Undo deletes nothing', async () => {
    const f = fakeIntel();
    f.answer({ ok: true, value: { id: ITEM, duplicate: true, queued: false, message: 'Already saved.' } });
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, REEL);
    expect(await rig.ask.add(id, 0, undefined, PHONE)).toEqual({ ok: true, value: { id: ITEM } });
    expect(await rig.ask.undo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    expect(f.removes).toEqual([]);
    expect(rig.turn(id)?.cards[0]?.state).toBe('proposed');
  });

  it("Intel's refusal is Add's answer; reading turned off since is refused with its sentence", async () => {
    const f = fakeIntel();
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, REEL);
    f.answer({ ok: false, code: 'invalid_request', reason: INTEL_READ_REASONS.badLink });
    expect(await rig.ask.add(id, 0, undefined, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: INTEL_READ_REASONS.badLink });
    expect(rig.turn(id)?.cards[0]?.state).toBe('proposed');
    await rig.ctx.settings.patch({ intel: { read: false } });
    expect(await rig.ask.add(id, 0, undefined, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: INTEL_READ_REASONS.off });
    await rig.ctx.settings.patch({ intel: { enabled: false } });
    expect(await rig.ask.add(id, 0, undefined, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: ASK_SENTENCES.intelOff });
    expect(f.reads).toHaveLength(1);
  });

  it('Undo: an item already deleted on the shelf counts as removed; the shelf off refuses', async () => {
    const f = fakeIntel();
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, REEL);
    await rig.ask.add(id, 0, undefined, PHONE);
    f.onRemove({ ok: false, code: 'not_found', reason: 'That item is no longer on the shelf.' });
    expect(await rig.ask.undo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    await rig.ask.add(id, 0, undefined, PHONE);
    await rig.ctx.settings.patch({ intel: { enabled: false } });
    expect(await rig.ask.undo(id, 0, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: ASK_SENTENCES.intelOff });
    expect(rig.turn(id)?.cards[0]?.state).toBe('added');
  });

  it("another device can't add or undo it", async () => {
    const f = fakeIntel();
    rig = await makeAskRig({ settings: READING, intel: f.intel });
    const id = send(rig, REEL);
    expect((await rig.ask.add(id, 0, undefined, TABLET)).ok).toBe(false);
    expect(f.reads).toHaveLength(0);
  });
});
