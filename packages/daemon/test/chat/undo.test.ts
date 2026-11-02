/**
 * The journal and Undo (spec 0.10 B8): every kind of write's inverse, the
 * repeating todo, a dose over an existing dose, a paid bill, a visit that
 * marked its café tried and rated a dish, an edit changed since (409), an
 * add already deleted (undone), past 24 h (refused), a part off (refused).
 */
import { afterEach, describe, expect, it } from 'vitest';
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
