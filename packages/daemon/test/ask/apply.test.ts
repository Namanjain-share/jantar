/**
 * Add, Skip and Undo (spec 5; 12.2 "due rules" and "apply"), on Life's real
 * todos, food and finance modules with a FakeClock at 14:05 in
 * Asia/Kolkata:
 *
 * - The due rules end to end: a time with no day at 09:00 is tomorrow, at
 *   18:00 today; daily at 09:00 with no day is tomorrow 09:00 with no flag;
 *   weekly moves 7 days; monthly from the 31st lands on the next month's
 *   last day; a one-off today at 09:00 is past_time, and so is today's
 *   18:00 tapped after midnight. Adding the daily one arms its ping at
 *   tomorrow 09:00 in the zone; Undo clears it. no_time stays at Add
 *   until an edit gives the todo a time.
 * - Add calls the module with the tapping device (Life's checks, pings and
 *   tick apply), keeps the new id on the card; Undo deletes it (an item
 *   already deleted counts as removed). Skip is final. A second Add, an Add
 *   of a show card, a turn not done: 409. Over 24 h: 409 on Add and on Undo.
 *   An Add after a repeating card's time passed moves it on. An edit can't
 *   change the type, put food after today or name another project (400).
 *   A part that is off: 403 on Add and Undo. Life broken: 503.
 * - v0.7 post cards: Add makes an idea (never text, notes or a link) with
 *   the tapping device, through a stand-in posts module; Undo removes it;
 *   an edit keeps the rules (one-line where, a day in range); a time that
 *   passed since the answer is past_time; Posts off is 403.
 * - Nothing is applied when a turn finishes: Life is untouched until Add.
 */
import { instantAt } from '@jantar/life-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ASK_APPLY_WITHIN_MS, type AskPostAction, type AskTodoAction } from '@jantar/protocol';
import { ASK_SENTENCES } from '../../src/ask/answer.js';
import { ASK_MODULE_OFF } from '../../src/ask/service.js';
import { FakeClock } from '../../src/core/clock.js';
import { FEATURE_OFF } from '../../src/api/app.js';
import { PHONE, TABLET, TODAY, TOMORROW, ZONE, answerText, cleanTemps, makeAskRig, send, type AskRig } from './helpers.js';

let rig: AskRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  cleanTemps();
});

/** A done turn with these model-form actions; its id. */
async function answered(r: AskRig, actions: unknown[], text = 'todo add it', actor = PHONE): Promise<string> {
  const id = send(r, text, actor);
  await r.heldCount(r.held.length + 1);
  r.held.at(-1)?.answer(answerText(actions));
  const t = await r.settled(id, actor);
  if (t.state !== 'done') throw new Error(`turn ${t.state}: ${t.reason}`);
  return id;
}

const ring = (day: string, time: string) => instantAt(day, time, ZONE).toISOString();
const todoRow = (r: AskRig, id: string) => r.core.scheduler.row('todo', id)?.nextAt ?? null;
const counts = (r: AskRig) => {
  const n = (t: string) => (r.core.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { todos: n('todos'), food: n('food'), money: n('money') };
};

describe('the due rules (FakeClock at 14:05 in the Life zone)', () => {
  it('places each todo, and Add arms the daily one at tomorrow 09:00 in the zone; Undo clears it', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [
      { type: 'todo', title: 'Morning walk', time: '09:00' },
      { type: 'todo', title: 'Evening call', time: '18:00' },
      { type: 'todo', title: 'Stretch', time: '09:00', repeat: 'daily' },
      { type: 'todo', title: 'Review', day: TODAY, time: '09:00', repeat: 'weekly' },
      { type: 'todo', title: 'Pills', day: TODAY, time: '09:00' },
    ]);
    const cards = r.turn(id)?.cards ?? [];
    expect(cards.map((c) => [(c.action as AskTodoAction).due, c.flag])).toEqual([
      [{ day: TOMORROW, time: '09:00' }, undefined],
      [{ day: TODAY, time: '18:00' }, undefined],
      [{ day: TOMORROW, time: '09:00' }, undefined],
      [{ day: '2026-11-08', time: '09:00' }, undefined],
      [{ day: TODAY, time: '09:00' }, 'past_time'],
    ]);
    // Nothing is applied when the answer comes.
    expect(counts(r).todos).toBe(0);

    const added = await r.ask.add(id, 2, undefined, PHONE);
    expect(added.ok).toBe(true);
    const todoId = added.ok ? added.value.id : '';
    const listed = r.todos.listTodos({ done: false });
    // Life keeps the series' own time beside the repeat (v0.5.3), as for a todo made on the Todos screen.
    expect(listed.ok && listed.value.todos).toEqual([expect.objectContaining({ id: todoId, title: 'Stretch', due: { day: TOMORROW, time: '09:00' }, repeat: { freq: 'daily', at: '09:00' } })]);
    expect(todoRow(r, todoId)).toBe(ring(TOMORROW, '09:00'));
    expect(todoRow(r, todoId)).toBe('2026-11-02T03:30:00.000Z');
    expect(r.turn(id)?.cards[2]).toMatchObject({ state: 'added', ref: todoId });

    expect(await r.ask.undo(id, 2, PHONE)).toEqual({ ok: true, value: true });
    expect(todoRow(r, todoId)).toBeNull();
    expect(counts(r).todos).toBe(0);
    expect(r.turn(id)?.cards[2]).toEqual({ action: cards[2]?.action, state: 'proposed' });
  });

  it('monthly from the 31st: the next month\'s last day', async () => {
    rig = await makeAskRig({ clock: new FakeClock('2026-10-31T08:35:00.000Z') });
    const id = await answered(rig, [{ type: 'todo', title: 'Pay rent', day: '2026-10-31', time: '09:00', repeat: 'monthly' }]);
    expect(rig.turn(id)?.cards[0]?.action).toMatchObject({ due: { day: '2026-11-30', time: '09:00' }, repeat: 'monthly' });
    const added = await rig.ask.add(id, 0, undefined, PHONE);
    expect(added.ok && todoRow(rig, added.value.id)).toBe(ring('2026-11-30', '09:00'));
  });

  it('an Add tapped after a repeating card\'s time passed moves it on, armed', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'todo', title: 'Evening walk', time: '18:00', repeat: 'daily' }]);
    expect(rig.turn(id)?.cards[0]?.action).toMatchObject({ due: { day: TODAY, time: '18:00' } });
    rig.ctx.clock.advance(5 * 60 * 60_000); // 19:05
    const added = await rig.ask.add(id, 0, undefined, PHONE);
    expect(added.ok).toBe(true);
    const todoId = added.ok ? added.value.id : '';
    expect(rig.turn(id)?.cards[0]?.action).toMatchObject({ due: { day: TOMORROW, time: '18:00' } });
    expect(todoRow(rig, todoId)).toBe(ring(TOMORROW, '18:00'));
  });

  it('a one-off whose time passed since the answer is added and flagged past_time; it does not ring', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'todo', title: 'Call back', time: '15:00' }]);
    expect(rig.turn(id)?.cards[0]).toMatchObject({ action: { due: { day: TODAY, time: '15:00' } } });
    expect(rig.turn(id)?.cards[0]?.flag).toBeUndefined();
    rig.ctx.clock.advance(60 * 60_000); // 15:05
    const added = await rig.ask.add(id, 0, undefined, PHONE);
    expect(rig.turn(id)?.cards[0]).toMatchObject({ state: 'added', flag: 'past_time' });
    expect(added.ok && todoRow(rig, added.value.id)).toBeNull();
  });

  it("today's 18:00 tapped after midnight is added for yesterday and flagged past_time; it does not ring", async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'todo', title: 'Call back', time: '18:00' }]);
    expect(rig.turn(id)?.cards[0]?.flag).toBeUndefined();
    rig.ctx.clock.advance(10 * 60 * 60_000); // 00:05 the next day
    const added = await rig.ask.add(id, 0, undefined, PHONE);
    expect(added.ok).toBe(true);
    expect(rig.turn(id)?.cards[0]).toMatchObject({ state: 'added', flag: 'past_time', action: { due: { day: TODAY, time: '18:00' } } });
    expect(added.ok && todoRow(rig, added.value.id)).toBeNull();
  });

  it('no_time stays at Add while the todo has no time; an edit that gives it one clears it', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'todo', title: 'Call mum' }, { type: 'todo', title: 'Pay rent' }], 'remind me to call mum and pay rent');
    expect(rig.turn(id)?.cards.map((c) => c.flag)).toEqual(['no_time', 'no_time']);
    expect((await rig.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    expect(rig.turn(id)?.cards[0]).toMatchObject({ state: 'added', flag: 'no_time' });
    const edited = await rig.ask.add(id, 1, { type: 'todo', title: 'Pay rent', due: { day: TOMORROW, time: '09:00' } }, PHONE);
    expect(edited.ok).toBe(true);
    expect(rig.turn(id)?.cards[1]).toEqual({ action: { type: 'todo', title: 'Pay rent', due: { day: TOMORROW, time: '09:00' } }, state: 'added', ref: edited.ok ? edited.value.id : '' });
  });
});

describe('Add, Skip and Undo', () => {
  it('food and money go through their modules with the tapping device; Undo removes the item', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [
      { type: 'food', name: 'Roti', kcal: 240 },
      { type: 'money', kind: 'expense', amount: 250, category: 'food', note: 'lunch' },
    ]);
    const ticks = r.core.changedCount;
    const food = await r.ask.add(id, 0, undefined, PHONE);
    const money = await r.ask.add(id, 1, undefined, PHONE);
    expect(food.ok && money.ok).toBe(true);
    // Life's own writes ticked (life.changed {}).
    expect(r.core.changedCount).toBe(ticks + 2);
    const day = r.food.day(TODAY);
    expect(day.ok && day.value.entries.map((e) => [e.name, e.kcal])).toEqual([['Roti', 240]]);
    const month = r.finance.month('2026-11');
    expect(month.ok && month.value.entries.map((e) => [e.kind, e.amount, e.category, e.note, e.day])).toEqual([['expense', 25000, 'Food', 'lunch', TODAY]]);

    expect((await r.ask.undo(id, 0, PHONE)).ok).toBe(true);
    expect((await r.ask.undo(id, 1, PHONE)).ok).toBe(true);
    expect(counts(r)).toMatchObject({ food: 0, money: 0 });
  });

  it('Undo of an item already deleted in Life is fine (one tick of its own)', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'food', name: 'Dal', kcal: 180 }]);
    const added = await rig.ask.add(id, 0, undefined, PHONE);
    expect(added.ok && rig.food.remove(added.value.id, PHONE).ok).toBe(true);
    const events = rig.ctx.store.replay(0);
    const before = events.kind === 'events' ? events.events.length : 0;
    expect(await rig.ask.undo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    const after = rig.ctx.store.replay(0);
    expect((after.kind === 'events' ? after.events : []).slice(before).map((e) => e.type)).toEqual(['life.changed']);
    expect(rig.turn(id)?.cards[0]?.state).toBe('proposed');
  });

  it('Skip is final; a second Add, a show card, Undo of nothing: 409 with fixed sentences', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [{ type: 'todo', title: 'Call the bank' }, { type: 'food', name: 'Roti', kcal: 120 }, { type: 'show', what: 'calories' }]);
    expect((await r.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    expect(await r.ask.add(id, 0, undefined, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.added });
    expect(r.ask.skip(id, 0, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.added });
    expect(r.ask.skip(id, 1, PHONE)).toEqual({ ok: true, value: true });
    expect(r.turn(id)?.cards[1]?.state).toBe('skipped');
    expect(await r.ask.add(id, 1, undefined, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.skipped });
    expect(r.ask.skip(id, 1, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.skipped });
    expect(await r.ask.undo(id, 1, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.nothingToUndo });
    expect(await r.ask.add(id, 2, undefined, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.notWrite });
    expect(await r.ask.undo(id, 2, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.nothingToUndo });
    expect(await r.ask.add(id, 3, undefined, PHONE)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noCard });
    // Another device's turn is not found at all.
    expect(await r.ask.add(id, 0, undefined, TABLET)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noTurn });
    expect(await r.ask.undo(id, 0, TABLET)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noTurn });
    expect(counts(r)).toMatchObject({ todos: 1, food: 0 });
  });

  it('a turn not done yet: 409 "Wait for the answer."', async () => {
    rig = await makeAskRig();
    const id = send(rig, 'todo add it');
    expect(rig.ask.skip(id, 0, PHONE)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noCard });
    // A done turn's card on a turn that failed: there are none, so not found too.
    await rig.heldCount(1);
    rig.held[0]?.answer('not json');
    expect((await rig.settled(id)).state).toBe('failed');
    expect(await rig.ask.add(id, 0, undefined, PHONE)).toEqual({ ok: false, code: 'not_found', reason: ASK_SENTENCES.noCard });
  });

  it('over 24 hours: Add and Undo are refused (409), at 24 hours exactly they work', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [{ type: 'food', name: 'Roti', kcal: 120, day: TODAY }, { type: 'food', name: 'Dal', kcal: 180, day: TODAY }]);
    expect((await r.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    r.ctx.clock.advance(ASK_APPLY_WITHIN_MS);
    // Exactly a day old: still allowed (the food day is yesterday now, in range).
    expect((await r.ask.undo(id, 0, PHONE)).ok).toBe(true);
    expect((await r.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    r.ctx.clock.advance(1);
    expect(await r.ask.add(id, 1, undefined, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.old });
    expect(await r.ask.undo(id, 0, PHONE)).toEqual({ ok: false, code: 'conflict', reason: ASK_SENTENCES.oldUndo });
    expect(counts(r).food).toBe(1);
  });
});

describe('post cards (v0.7)', () => {
  it('Add makes an idea with the tapping device, and only the plan; Undo removes it', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [
      { type: 'post', platform: 'insta', kind: 'reels', title: 'About the launch', day: TOMORROW, time: '19:00' },
      { type: 'post', platform: 'reddit', where: 'r/exampletools' },
    ], 'reel tomorrow 7pm about the launch');
    expect(r.turn(id)?.cards.map((c) => c.action)).toEqual([
      { type: 'post', platform: 'instagram', kind: 'reel', title: 'About the launch', due: { day: TOMORROW, time: '19:00' } },
      { type: 'post', platform: 'reddit', kind: 'post', where: 'r/exampletools' },
    ]);
    expect(r.posts.posts.size).toBe(0);
    const ticks = r.core.changedCount;
    const added = await r.ask.add(id, 0, undefined, PHONE);
    expect(added.ok).toBe(true);
    const postId = added.ok ? added.value.id : '';
    expect(r.core.changedCount).toBe(ticks + 1);
    const { createdAt: _c, updatedAt: _u, ...made } = r.posts.posts.get(postId) ?? ({} as Record<string, unknown>);
    expect(made).toEqual({ id: postId, platform: 'instagram', kind: 'reel', title: 'About the launch', due: { day: TOMORROW, time: '19:00' }, status: 'idea' });
    expect(r.posts.actors.get(postId)).toEqual(PHONE);
    expect(r.turn(id)?.cards[0]).toMatchObject({ state: 'added', ref: postId });
    // Add all's sibling: the second card alone.
    expect((await r.ask.add(id, 1, undefined, PHONE)).ok).toBe(true);
    expect(r.posts.posts.size).toBe(2);

    expect(await r.ask.undo(id, 0, PHONE)).toEqual({ ok: true, value: true });
    expect(r.posts.posts.has(postId)).toBe(false);
    expect(r.turn(id)?.cards[0]).toEqual({ action: { type: 'post', platform: 'instagram', kind: 'reel', title: 'About the launch', due: { day: TOMORROW, time: '19:00' } }, state: 'proposed' });
    // A post already deleted on the Posts screen counts as removed.
    const second = r.turn(id)?.cards[1]?.ref ?? '';
    expect(r.posts.remove(second, PHONE).ok).toBe(true);
    expect(await r.ask.undo(id, 1, PHONE)).toEqual({ ok: true, value: true });
  });

  it('an edit: platform, kind, where, title and the day and time, with the same rules', async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [{ type: 'post', platform: 'instagram', kind: 'reel', title: 'About the launch', day: TOMORROW, time: '19:00' }]);
    const edit: AskPostAction = { type: 'post', platform: 'reddit', kind: 'post', where: 'r/examplecode', title: 'Launch day', due: { day: TOMORROW, time: '19:30' } };
    expect(await r.ask.add(id, 0, { ...edit, where: 'r/example\ncode' }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.badItem });
    expect(await r.ask.add(id, 0, { ...edit, due: { day: '2028-01-01' } }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.badDay });
    expect(await r.ask.add(id, 0, { ...edit, text: 'The whole post' } as AskPostAction, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.badItem });
    expect(await r.ask.add(id, 0, { type: 'todo', title: 'Launch day' }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.editType });
    expect(r.posts.posts.size).toBe(0);
    const added = await r.ask.add(id, 0, edit, PHONE);
    expect(added.ok).toBe(true);
    expect(r.posts.posts.get(added.ok ? added.value.id : '')).toMatchObject({ platform: 'reddit', kind: 'post', where: 'r/examplecode', title: 'Launch day', status: 'idea' });
    expect(r.turn(id)?.cards[0]?.action).toEqual(edit);
  });

  it('a time that passed since the answer: added and flagged past_time', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'post', platform: 'x', kind: 'thread', time: '15:00' }]);
    expect(rig.turn(id)?.cards[0]).toMatchObject({ action: { due: { day: TODAY, time: '15:00' } } });
    expect(rig.turn(id)?.cards[0]?.flag).toBeUndefined();
    rig.ctx.clock.advance(60 * 60_000); // 15:05
    expect((await rig.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    expect(rig.turn(id)?.cards[0]).toMatchObject({ state: 'added', flag: 'past_time' });
  });

  it("Posts off: the card is dropped from an answer, and Add and Undo are 403 with the switch's sentence", async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [{ type: 'post', platform: 'reddit' }, { type: 'post', platform: 'x' }]);
    expect((await r.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    expect((await r.ctx.settings.patch({ life: { posts: false } })).ok).toBe(true);
    expect(await r.ask.undo(id, 0, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: ASK_MODULE_OFF.posts });
    expect(await r.ask.add(id, 1, undefined, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: ASK_MODULE_OFF.posts });
    expect(ASK_MODULE_OFF.posts).toBe(FEATURE_OFF.posts.message);
    const off = await answered(r, [{ type: 'post', platform: 'reddit' }, { type: 'todo', title: 'Call the bank' }]);
    expect(r.turn(off)).toMatchObject({ cards: [{ action: { type: 'todo' } }], dropped: 1 });
    expect(r.posts.posts.size).toBe(1);
  });
});

describe('edits', () => {
  it('an edit is applied as sent, with the same rules; the card keeps what was added', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'food', name: 'Roti', kcal: 240 }]);
    const r = await rig.ask.add(id, 0, { type: 'food', day: '2026-10-31', name: 'Two rotis', kcal: 250 }, PHONE);
    expect(r.ok).toBe(true);
    const day = rig.food.day('2026-10-31');
    expect(day.ok && day.value.entries.map((e) => [e.name, e.kcal])).toEqual([['Two rotis', 250]]);
    expect(rig.turn(id)?.cards[0]?.action).toEqual({ type: 'food', day: '2026-10-31', name: 'Two rotis', kcal: 250 });
  });

  it('400: another type, food after today, a day out of range, another project', async () => {
    rig = await makeAskRig();
    const r = rig;
    const made = r.todos.createProject({ name: 'Acme site' }, PHONE);
    const other = r.todos.createProject({ name: 'Other' }, PHONE);
    const projectId = made.ok ? made.value.id : '';
    const otherId = other.ok ? other.value.id : '';
    const id = await answered(r, [
      { type: 'food', name: 'Roti', kcal: 240 },
      { type: 'todo', title: 'Send the quote', project: 'acme site' },
      { type: 'money', kind: 'expense', amount: 250, category: 'Food' },
    ]);
    expect(r.turn(id)?.cards[1]?.action).toMatchObject({ projectId });
    expect(await r.ask.add(id, 0, { type: 'todo', title: 'Roti' }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.editType });
    expect(await r.ask.add(id, 0, { type: 'food', day: TOMORROW, name: 'Roti', kcal: 240 }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.futureDay });
    expect(await r.ask.add(id, 2, { type: 'money', kind: 'expense', amount: 25000, category: 'Food', day: '2025-11-01' }, PHONE)).toEqual({
      ok: false,
      code: 'invalid_request',
      reason: ASK_SENTENCES.badDay,
    });
    expect(await r.ask.add(id, 1, { type: 'todo', title: 'Send the quote', projectId: otherId }, PHONE)).toEqual({ ok: false, code: 'invalid_request', reason: ASK_SENTENCES.editProject });
    expect(counts(r)).toEqual({ todos: 0, food: 0, money: 0 });
    // The card's own project, or none, is fine.
    expect((await r.ask.add(id, 1, { type: 'todo', title: 'Send the quote today', projectId }, PHONE)).ok).toBe(true);
  });
});

describe('switches and Life', () => {
  it("a part that is off: 403 with that part's sentence on Add and on Undo", async () => {
    rig = await makeAskRig();
    const r = rig;
    const id = await answered(r, [{ type: 'todo', title: 'Call the bank' }, { type: 'food', name: 'Roti', kcal: 120 }, { type: 'money', kind: 'income', amount: 1000, category: 'Salary' }]);
    for (const [n, part] of [[0, 'todos'], [1, 'food'], [2, 'finance']] as const) {
      expect((await r.ask.add(id, n, undefined, PHONE)).ok).toBe(true);
      expect((await r.ctx.settings.patch({ life: { [part]: false } })).ok).toBe(true);
      expect(await r.ask.undo(id, n, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: ASK_MODULE_OFF[part] });
      expect((await r.ctx.settings.patch({ life: { [part]: true } })).ok).toBe(true);
      expect((await r.ask.undo(id, n, PHONE)).ok).toBe(true);
      expect((await r.ctx.settings.patch({ life: { [part]: false } })).ok).toBe(true);
      expect(await r.ask.add(id, n, undefined, PHONE)).toEqual({ ok: false, code: 'forbidden', reason: ASK_MODULE_OFF[part] });
      expect((await r.ctx.settings.patch({ life: { [part]: true } })).ok).toBe(true);
      // The sentence is the API's own for that switch.
      expect(ASK_MODULE_OFF[part]).toBe(FEATURE_OFF[part].message);
    }
  });

  it('Life broken: 503 with its sentence on Add and Undo', async () => {
    rig = await makeAskRig();
    const id = await answered(rig, [{ type: 'food', name: 'Roti', kcal: 120 }, { type: 'food', name: 'Dal', kcal: 180 }]);
    expect((await rig.ask.add(id, 0, undefined, PHONE)).ok).toBe(true);
    rig.setBroken('Life data needs attention (synthetic).');
    expect(await rig.ask.add(id, 1, undefined, PHONE)).toEqual({ ok: false, code: 'life_unavailable', reason: 'Life data needs attention (synthetic).' });
    expect(await rig.ask.undo(id, 0, PHONE)).toEqual({ ok: false, code: 'life_unavailable', reason: 'Life data needs attention (synthetic).' });
  });

  it("Life's own refusal passes through unchanged (a project deleted since the answer)", async () => {
    rig = await makeAskRig();
    const made = rig.todos.createProject({ name: 'Acme site' }, PHONE);
    const id = await answered(rig, [{ type: 'todo', title: 'Send the quote', project: 'Acme site' }]);
    expect(made.ok && rig.todos.removeProject(made.value.id, PHONE).ok).toBe(true);
    const r = await rig.ask.add(id, 0, undefined, PHONE);
    expect(r).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(rig.turn(id)?.cards[0]?.state).toBe('proposed');
  });
});
