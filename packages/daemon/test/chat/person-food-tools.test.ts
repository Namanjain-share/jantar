/**
 * v0.11 People (spec 3.5, 7.2, 7.3): her assistant's food tools, called on
 * her deps with no Claude run. Synthetic people only (Sam's Mac, Asha).
 *
 * - food_day, food_add and food_edit are hers only while her food module
 *   is on; off, her list leaves them out and a call that names one anyway
 *   writes nothing (her food log answers its one 404).
 * - Every one of them works in her space: she never reads or changes his
 *   food log, he never sees hers in his.
 * - Her own entries are hers: reading them doesn't taint the turn. A meal
 *   she asks to delete is a card her tap answers.
 * - Her <reach> and her chat disclosure name her food log only while it is on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_CHAT_SENTENCES, chatDisclosure } from '@jantar/protocol/people';
import type { Actor } from '../../src/contracts.js';
import { personChatDeps } from '../../src/chat/person-deps.js';
import { PERSON_CHAT_TOOLS, PERSON_FOOD_TOOLS, personOnParts } from '../../src/chat/person-tools.js';
import { PERSON_TOOLS, TurnTools, toolsFor } from '../../src/chat/tools.js';
import { chatRig, TODAY, turnId, type ChatRig } from './helpers.js';

let rig: ChatRig;
let pid: string;
beforeEach(async () => {
  rig = await chatRig();
  const r = rig.life.people.add({ name: 'Asha', modules: { food: true } });
  if (!r.ok) throw new Error(r.reason);
  pid = r.value.id;
});
afterEach(async () => {
  await rig.close();
});

const her = (): Actor => ({ kind: 'person', personId: pid, deviceId: 'd' });
const deps = () => personChatDeps(rig.deps, { pid, people: rig.life.people });
function turn(names?: string[]) {
  const id = turnId();
  const store = rig.store.inThread(`p:${pid}`);
  store.insertTurn({ id, at: rig.ctx.clock.iso(), via: 'phone', text: '', photos: [], state: 'running', tainted: false, refused: 0, by: `person:${pid}:d` });
  const d = deps();
  const list = names ? PERSON_TOOLS.filter((t) => names.includes(t.name)) : toolsFor(rig.ctx.settings.get(), d);
  const tools = new TurnTools({ ctx: rig.ctx, deps: d, store, turnId: id, actor: her(), actorName: `person:${pid}:d`, message: '', tools: list, lifeWrites: rig.lifeWrites, live: () => true });
  return { tools, store, id };
}
const herEntries = () => {
  const r = rig.life.people.food?.herDay(pid, TODAY);
  return r?.ok ? r.value.entries.map((e) => [e.name, e.kcal]) : null;
};

describe('her food tools (spec 7.2)', () => {
  it('are listed only while her food module is on', async () => {
    const on = toolsFor(rig.ctx.settings.get(), deps()).map((t) => t.name);
    for (const n of PERSON_FOOD_TOOLS) expect(on, n).toContain(n);
    expect(on.sort()).toEqual([...PERSON_CHAT_TOOLS].sort());
    expect(personOnParts(true)).toContain('her food log');
    expect(rig.life.people.setModules(pid, false, 'cli').ok).toBe(true);
    const off = toolsFor(rig.ctx.settings.get(), deps()).map((t) => t.name);
    for (const n of PERSON_FOOD_TOOLS) expect(off, n).not.toContain(n);
    expect(off).toContain('weight_set');
    expect(personOnParts(false)).not.toContain('her food log');
  });

  it('log, read and edit in her space only; his food log is never in her read, hers never in his', async () => {
    rig.life.food.add({ day: TODAY, name: 'His biryani', kcal: 900 }, { kind: 'cli' });
    const { tools } = turn();
    const add = await tools.call('food_add', { day: TODAY, name: 'Poha', kcal: 320 });
    expect(add.isError, add.text).toBe(false);
    expect(herEntries()).toEqual([['Poha', 320]]);
    const read = await tools.call('food_day', { day: TODAY });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toMatch(/Poha 320 kcal/);
    expect(read.text).not.toMatch(/biryani/);
    expect(tools.counts.tainted).toBe(false);
    const id = /\(id ([0-9A-Z]{26})\)/.exec(read.text)?.[1];
    const edit = await tools.call('food_edit', { id, day: TODAY, kcal: 350 });
    expect(edit.isError, edit.text).toBe(false);
    expect(herEntries()).toEqual([['Poha', 350]]);
    const his = rig.life.food.day(TODAY);
    expect(his.ok && his.value.entries.map((e) => e.name)).toEqual(['His biryani']);
    // A meal of his is no meal of hers.
    const hisId = his.ok ? his.value.entries[0]?.id : undefined;
    expect((await tools.call('food_edit', { id: hisId, day: TODAY, kcal: 1 })).isError).toBe(true);
    expect(rig.life.food.day(TODAY).ok && (rig.life.food.day(TODAY) as { value: { entries: { kcal: number }[] } }).value.entries[0]?.kcal).toBe(900);
  });

  it('a meal she asks to delete is a card; only her tap deletes it', async () => {
    const r = rig.life.people.food?.herAdd(pid, { day: TODAY, name: 'Samosa', kcal: 260 }, her());
    if (!r?.ok) throw new Error('add');
    const { tools } = turn();
    const card = await tools.call('request_delete', { kind: 'meal', id: r.value.id, day: TODAY });
    expect(card.isError, card.text).toBe(false);
    expect(card.text, card.text).toMatch(/Delete Samosa \(260 kcal\)\?/);
    expect(herEntries()).toEqual([['Samosa', 260]]);
  });

  it('with her food module off, a call that names a food tool anyway writes nothing', async () => {
    expect(rig.life.people.setModules(pid, false, 'cli').ok).toBe(true);
    const { tools } = turn(['food_add', 'food_day']);
    const a = await tools.call('food_add', { day: TODAY, name: 'Sneaky', kcal: 1 });
    expect(a.isError).toBe(true);
    expect((await tools.call('food_day', {})).text).toBe('The food log is off in this space.');
    expect(rig.life.people.food?.herDay(pid, TODAY).ok).toBe(false);
    rig.life.people.setModules(pid, true, 'cli');
    expect(herEntries()).toEqual([]);
  });

  it('the chat disclosure names her food log only while it is on', () => {
    expect(chatDisclosure('Sam', 30, true, 'P4', true)).toMatch(/It can see your plan, to-dos, weight, food log, sleep and the lists you share/);
    expect(chatDisclosure('Sam', 30, true, 'P4', false)).toMatch(/It can see your plan, to-dos, weight, sleep and the lists you share/);
    expect(PERSON_CHAT_SENTENCES.off).toBeTruthy();
  });
});
