/**
 * The journal and Undo (spec 0.10 B8): every kind of write's inverse, the
 * repeating todo, a dose over an existing dose, a paid bill, a visit that
 * marked its café tried and rated a dish, an edit changed since (409), an
 * add already deleted (undone), past 24 h (refused), a part off (refused).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { shiftDay } from '@jantar/life-core';
import { CHAT_UNDO_WITHIN_MS } from '@jantar/protocol';
import { undoChange } from '../../src/chat/taps.js';
import { chatRig, idIn, PHONE, TABLET, TODAY, type ChatRig } from './helpers.js';

let rig: ChatRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const undo = (r: ChatRig, turnId: string, n: number) => undoChange({ ctx: r.ctx, deps: r.deps, store: r.store }, turnId, n, TABLET, 'device:dev-tablet');

describe('Undo', () => {
  it('an add is deleted as it is now; a second Undo says so; one already gone counts as undone', async () => {
    rig = await chatRig();
    const { tools, turnId } = rig.turn();
    const id = idIn((await tools.call('todo_add', { title: 'Buy oat milk' })).text);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    expect(rig.store.changes(turnId)[0]?.state).toBe('undone');
    const open = rig.life.todos.listTodos({ done: false });
    expect(open.ok && open.value.todos.some((t) => t.id === id)).toBe(false);
    expect(await undo(rig, turnId, 0)).toMatchObject({ ok: false, code: 'conflict', reason: 'Already undone.' });

    const second = idIn((await tools.call('food_add', { day: TODAY, name: 'Dal', kcal: 180 })).text);
    rig.life.food.remove(second, PHONE);
    expect(await undo(rig, turnId, 1)).toEqual({ ok: true, value: true });
  });

  it('an edit is patched back, unless it changed since (409)', async () => {
    rig = await chatRig();
    const made = rig.life.todos.createTodo({ title: 'Call the bank', notes: 'before noon' }, PHONE);
    const id = made.ok ? made.value.id : '';
    const { tools, turnId } = rig.turn();
    await tools.call('todo_edit', { id, title: 'Call the bank about the card', notes: null });
    await tools.call('todo_edit', { id, priority: 'high' });
    rig.life.todos.updateTodo(id, { title: 'Changed by hand' }, PHONE);
    expect(await undo(rig, turnId, 0)).toMatchObject({ ok: false, code: 'conflict', reason: "That changed after Chat's edit; change it back by hand." });
    // The priority edit is still Chat's: it goes back.
    expect(await undo(rig, turnId, 1)).toEqual({ ok: true, value: true });
    const t = rig.life.todos.listTodos({ done: false });
    expect(t.ok && t.value.todos.find((x) => x.id === id)).toMatchObject({ title: 'Changed by hand', priority: 'normal' });
  });

  it('a café edit with a sub-rating puts the old values back per key', async () => {
    rig = await chatRig();
    const made = rig.life.places.create({ name: 'Sample Dosa House', stars: 3, ratings: { food: 4 } }, PHONE);
    const id = made.ok ? made.value.id : '';
    const { tools, turnId } = rig.turn();
    await tools.call('place_edit', { id, stars: 5, ratings: { work: 5 }, price: 2 });
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    const p = rig.life.places.get(id);
    expect(p.ok && p.value.place.stars).toBe(3);
    expect(p.ok && p.value.place.ratings).toEqual({ food: 4 });
    expect(p.ok && p.value.place.price).toBeUndefined();
  });

  it('a visit that marked the café tried and rated a dish: all of it goes back', async () => {
    rig = await chatRig();
    const made = rig.life.places.create({ name: 'Sample Dosa House', dishes: [{ name: 'Idli' }] }, PHONE);
    const id = made.ok ? made.value.id : '';
    const { tools, turnId } = rig.turn();
    const r = await tools.call('visit_log', { placeId: id, stars: 4, had: ['Idli'], dishRatings: [{ name: 'Idli', rating: 4 }] });
    expect(r.isError).toBe(false);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    const p = rig.life.places.get(id);
    expect(p.ok && p.value.place).toMatchObject({ tried: false, dishes: [{ name: 'Idli' }] });
    expect(p.ok && p.value.place.dishes[0]?.rating).toBeUndefined();
    expect(p.ok && p.value.visits).toEqual([]);
  });

  it('a repeating todo done goes back to its day; a one-off is undone', async () => {
    rig = await chatRig();
    const rep = rig.life.todos.createTodo({ title: 'Water the plants', due: { day: TODAY }, repeat: { freq: 'daily' } }, PHONE);
    const one = rig.life.todos.createTodo({ title: 'Post the letter' }, PHONE);
    const { tools, turnId } = rig.turn();
    await tools.call('todo_done', { id: rep.ok ? rep.value.id : '' });
    await tools.call('todo_done', { id: one.ok ? one.value.id : '' });
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    expect(await undo(rig, turnId, 1)).toEqual({ ok: true, value: true });
    const open = rig.life.todos.listTodos({ done: false });
    const todos = open.ok ? open.value.todos : [];
    expect(todos.find((t) => t.title === 'Water the plants')?.due).toEqual({ day: TODAY });
    expect(todos.find((t) => t.title === 'Post the letter')?.doneAt).toBeUndefined();
  });

  it('todo_done that changes nothing is refused with no change; Undo puts back the state before, not its opposite', async () => {
    rig = await chatRig();
    const done = rig.life.todos.createTodo({ title: 'Post the letter' }, PHONE);
    const open = rig.life.todos.createTodo({ title: 'Call the bank' }, PHONE);
    const doneId = done.ok ? done.value.id : '';
    const openId = open.ok ? open.value.id : '';
    rig.life.todos.setDone(doneId, true, PHONE);
    const { tools, turnId } = rig.turn();
    expect(await tools.call('todo_done', { id: doneId })).toEqual({ isError: true, text: 'That todo is already done.' });
    expect(await tools.call('todo_done', { id: openId, done: false })).toEqual({ isError: true, text: 'That todo is already open.' });
    expect(rig.store.changes(turnId)).toEqual([]);
    expect(await undo(rig, turnId, 0)).toMatchObject({ ok: false, code: 'not_found' });
    const isDone = (id: string) => {
      const r = rig!.life.todos.listTodos({ done: true });
      return r.ok && r.value.todos.some((t) => t.id === id);
    };
    expect(isDone(doneId)).toBe(true);
    expect(isDone(openId)).toBe(false);

    // Chat reopens the done one: Undo makes it done again.
    expect((await tools.call('todo_done', { id: doneId, done: false })).isError).toBe(false);
    expect(isDone(doneId)).toBe(false);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    expect(isDone(doneId)).toBe(true);

    // Chat marks the open one done, the user reopens it by hand: Undo is refused (it is no longer Chat's).
    expect((await tools.call('todo_done', { id: openId })).isError).toBe(false);
    rig.life.todos.setDone(openId, false, PHONE);
    expect(await undo(rig, turnId, 1)).toMatchObject({ ok: false, code: 'conflict', reason: "That changed after Chat's edit; change it back by hand." });
    expect(isDone(openId)).toBe(false);
  });

  it("weight_set on a day past the newest 30 puts that day's own weight back; changed since is refused", async () => {
    rig = await chatRig();
    const days = Array.from({ length: 40 }, (_, n) => shiftDay(TODAY, -n));
    for (const day of days) rig.life.food.setWeight(day, { kg: 70 }, PHONE);
    const oldest = days.at(-1) as string;
    const { tools, turnId } = rig.turn();
    expect((await tools.call('weight_set', { day: oldest, kg: 72 })).isError).toBe(false);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    expect(rig.life.food.weightOn(oldest)).toEqual({ ok: true, value: 70 });
    // The same weight again changes nothing.
    expect(await tools.call('weight_set', { day: oldest, kg: 70 })).toEqual({ isError: true, text: 'Nothing to change.' });
    // A delete card for that old day names its weight.
    const card = await tools.call('request_delete', { kind: 'weight', id: oldest });
    expect(card.text).toContain(`Delete the weight of ${oldest} (70 kg)?`);
    // Chat sets it, the user changes it: Undo leaves the user's.
    expect((await tools.call('weight_set', { day: oldest, kg: 73 })).isError).toBe(false);
    rig.life.food.setWeight(oldest, { kg: 74 }, PHONE);
    expect(await undo(rig, turnId, 1)).toMatchObject({ ok: false, code: 'conflict' });
    expect(rig.life.food.weightOn(oldest)).toEqual({ ok: true, value: 74 });
  });

  it('a budget, the targets, the goals and a dose the user changed since are not undone (409)', async () => {
    rig = await chatRig();
    const med = rig.life.medicines.create({ name: 'Placebin', times: ['08:00'], schedule: { freq: 'daily' } }, PHONE);
    const medId = med.ok ? med.value.id : '';
    const { tools, turnId } = rig.turn();
    await tools.call('budget_set', { category: 'Food', amount: 500000 });
    await tools.call('food_targets_set', { kcalTarget: 1800 });
    await tools.call('post_goals_set', { goals: [{ platform: 'reddit', kind: 'comment', perWeek: 7 }] });
    await tools.call('dose_log', { medId, day: TODAY, slot: '08:00', status: 'taken' });
    expect(rig.store.changes(turnId)).toHaveLength(4);
    rig.life.finance.setBudget({ category: 'Food', amount: 600000 }, PHONE);
    rig.life.food.setTargets({ kcalTarget: 2000 }, PHONE);
    rig.life.posts.setGoals({ goals: [{ platform: 'reddit', kind: 'comment', perWeek: 3 }] }, PHONE);
    rig.life.medicines.logDose(medId, { day: TODAY, slot: '08:00', status: 'skipped' }, PHONE);
    for (const n of [0, 1, 2, 3]) expect(await undo(rig, turnId, n), `change ${n}`).toMatchObject({ ok: false, code: 'conflict' });
    const m = rig.life.finance.month();
    expect(m.ok && m.value.byCategory.find((c) => c.category === 'Food')?.budget).toBe(600000);
    const fd = rig.life.food.day(TODAY);
    expect(fd.ok && fd.value.target).toBe(2000);
    // Setting what is already there changes nothing.
    expect(await tools.call('budget_set', { category: 'Food', amount: 600000 })).toEqual({ isError: true, text: 'Nothing to change.' });
    expect(await tools.call('food_targets_set', { kcalTarget: 2000 })).toEqual({ isError: true, text: 'Nothing to change.' });
  });

  it("budget_set's change and audit row carry no category name", async () => {
    rig = await chatRig();
    const { tools, turnId } = rig.turn();
    await tools.call('budget_set', { category: 'Synthetic Hobby', amount: 100000 });
    expect(rig.store.changes(turnId)[0]?.ref).toBe('budget');
    expect(JSON.stringify(rig.ctx.db.audit.list({}))).not.toContain('Synthetic Hobby');
  });

  it("a visit's Undo keeps the café tried when it has another visit by then; a café's add is not undone once it has visits", async () => {
    rig = await chatRig();
    const made = rig.life.places.create({ name: 'Sample Dosa House' }, PHONE);
    const id = made.ok ? made.value.id : '';
    const { tools, turnId } = rig.turn();
    expect((await tools.call('visit_log', { placeId: id, stars: 4 })).isError).toBe(false);
    rig.life.places.visitAdd(id, { day: TODAY, stars: 5 }, PHONE);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    const p = rig.life.places.get(id);
    expect(p.ok && p.value.place.tried).toBe(true);
    expect(p.ok && p.value.visits).toHaveLength(1);

    const added = idIn((await tools.call('place_add', { name: 'Example Café' })).text);
    rig.life.places.visitAdd(added, { day: TODAY }, PHONE);
    expect(await undo(rig, turnId, 1)).toMatchObject({ ok: false, code: 'conflict', reason: 'That café has visits now. Delete it in its own screen instead.' });
    expect(rig.life.places.get(added).ok).toBe(true);
  });

  it("a medicine's add is not undone once a dose is logged (Undo would take the dose history with it); with no dose left it is", async () => {
    rig = await chatRig();
    const { tools, turnId } = rig.turn();
    const medId = idIn((await tools.call('med_add', { name: 'Placebin', times: ['08:00', '21:00'], schedule: { freq: 'daily' } })).text);
    const dose = rig.life.medicines.logDose(medId, { day: TODAY, slot: '08:00', status: 'skipped' }, PHONE);
    const refused = { ok: false, code: 'conflict', reason: 'That medicine has doses logged now. Delete it in its own screen instead.' };
    expect(await undo(rig, turnId, 0)).toMatchObject(refused);
    const meds = () => {
      const r = rig!.life.medicines.get();
      return r.ok ? r.value : null;
    };
    expect(meds()?.medicines.map((m) => m.id)).toEqual([medId]);
    expect(meds()?.day.groups.flatMap((g) => g.items).find((x) => x.slot === '08:00')?.status).toBe('skipped');
    expect(rig.store.changes(turnId)[0]?.state).toBe('done');

    // The next morning (still within the day Undo has): a dose of the day before still counts, and one of today.
    rig.ctx.clock.set('2026-11-03T08:30:00.000Z');
    expect(await undo(rig, turnId, 0)).toMatchObject(refused);
    rig.life.medicines.undoDose(medId, dose.ok ? dose.value.id : '', PHONE);
    const today = rig.life.medicines.logDose(medId, { day: '2026-11-03', slot: '08:00', status: 'taken' }, PHONE);
    expect(await undo(rig, turnId, 0)).toMatchObject(refused);

    // Every dose undone by hand: nothing of the user's would go with it, so Undo deletes it.
    rig.life.medicines.undoDose(medId, today.ok ? today.value.id : '', PHONE);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    expect(meds()?.medicines).toEqual([]);
  });

  it('a dose logged over an existing one puts the first back; a new one is removed', async () => {
    rig = await chatRig();
    const med = rig.life.medicines.create({ name: 'Placebin', times: ['08:00'], schedule: { freq: 'daily' } }, PHONE);
    const medId = med.ok ? med.value.id : '';
    rig.life.medicines.logDose(medId, { day: TODAY, slot: '08:00', status: 'skipped' }, PHONE);
    const { tools, turnId } = rig.turn();
    expect((await tools.call('dose_log', { medId, day: TODAY, slot: '08:00', status: 'taken' })).isError).toBe(false);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    const day = rig.life.medicines.get(TODAY);
    expect(day.ok && day.value.day.groups.flatMap((g) => g.items)[0]?.status).toBe('skipped');
  });

  it('a paid bill: the expense goes and the due day comes back', async () => {
    rig = await chatRig();
    const bill = rig.life.finance.createBill({ name: 'Synthetic Broadband', amount: 99900, category: 'Bills', repeat: 'monthly', nextDue: TODAY }, PHONE);
    const id = bill.ok ? bill.value.id : '';
    const { tools, turnId } = rig.turn();
    expect((await tools.call('bill_paid', { id })).isError).toBe(false);
    const after = rig.life.finance.month();
    expect(after.ok && after.value.entries).toHaveLength(1);
    expect(await undo(rig, turnId, 0)).toEqual({ ok: true, value: true });
    const m = rig.life.finance.month();
    expect(m.ok && m.value.entries).toEqual([]);
    expect(m.ok && m.value.bills[0]?.nextDue).toBe(TODAY);
  });

  it('weight, targets, budget and goals go back to what they were', async () => {
    rig = await chatRig();
    rig.life.food.setWeight(TODAY, { kg: 70 }, PHONE);
    const { tools, turnId } = rig.turn();
    await tools.call('weight_set', { day: TODAY, kg: 71.5 });
    await tools.call('budget_set', { category: 'Food', amount: 500000 });
    await tools.call('food_targets_set', { kcalTarget: 1800 });
    await tools.call('post_goals_set', { goals: [{ platform: 'reddit', kind: 'comment', perWeek: 7 }] });
    for (const n of [3, 2, 1, 0]) expect(await undo(rig, turnId, n)).toEqual({ ok: true, value: true });
    const fd = rig.life.food.day(TODAY);
    expect(fd.ok && fd.value.weight.latest?.kg).toBe(70);
    const m = rig.life.finance.month();
    expect(m.ok ? (m.value.byCategory.find((c) => c.category === 'Food')?.budget ?? null) : 'x').toBeNull();
    const posts = rig.life.posts.list({ done: false });
    expect(posts.ok && posts.value.week.goals).toEqual([]);
  });

  it('after 24 hours, or with the part off, Undo is refused', async () => {
    rig = await chatRig();
    const { tools, turnId } = rig.turn();
    await tools.call('todo_add', { title: 'Buy oat milk' });
    await tools.call('food_add', { day: TODAY, name: 'Dal', kcal: 180 });
    await rig.ctx.settings.patch({ life: { food: false } });
    expect(await undo(rig, turnId, 1)).toMatchObject({ ok: false, code: 'forbidden' });
    rig.ctx.clock.advance(CHAT_UNDO_WITHIN_MS + 1000);
    expect(await undo(rig, turnId, 0)).toMatchObject({ ok: false, code: 'conflict', reason: 'Over a day old. Change it in its own screen instead.' });
  });

  it('an Intel link already on the shelf has no Undo', async () => {
    rig = await chatRig();
    rig.intel.add({ url: 'https://example.com/already' });
    const { tools, turnId } = rig.turn({ message: 'save https://example.com/already and https://example.com/new' });
    await tools.call('intel_save', { url: 'https://example.com/already' });
    await tools.call('intel_save', { url: 'https://example.com/new' });
    const changes = rig.store.changes(turnId);
    expect(changes.map((c) => c.undoable)).toEqual([false, true]);
    expect(await undo(rig, turnId, 0)).toMatchObject({ ok: false, reason: 'This one has no Undo.' });
    expect(await undo(rig, turnId, 1)).toEqual({ ok: true, value: true });
    expect(rig.intel.reads.map((r) => r.via)).toEqual(['chat', 'chat']);
  });
});
